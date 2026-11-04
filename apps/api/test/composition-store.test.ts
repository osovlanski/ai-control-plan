/**
 * M1: immutable composition revisions (validated, bundle persisted for replay), write-once run
 * binding, and the idempotent, provider-qualified UsageRecord ingestion boundary.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTROL_PLANE_API_VERSION, COMMAND_CAPABILITIES, INGEST_CAPABILITIES } from "@agent-plane/core";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { BUNDLE_CONTRACT_DIR, type BundleRequest, type BundleResponse } from "../src/bundle-contract.js";
import { COMPOSITION_CONTRACT_DIR, type AgentSpec, type CompositionDecision } from "../src/composition-contract.js";
import { CompositionError, CompositionStore } from "../src/modules/composition.js";
import { USAGE_CONTRACT_DIR, validateUsageRecord } from "../src/modules/usage.js";
import { buildServer, type BuiltServer } from "../src/server.js";

const json = <T>(dir: string, file: string) => JSON.parse(readFileSync(join(dir, "fixtures", file), "utf8")) as T;
const revision = (name: "zero-asset" | "two-skill") => ({
  spec: json<AgentSpec>(COMPOSITION_CONTRACT_DIR, `valid/${name}.agent-spec.json`),
  decision: json<CompositionDecision>(COMPOSITION_CONTRACT_DIR, `valid/${name}.decision.json`),
  bundle: {
    request: json<BundleRequest>(BUNDLE_CONTRACT_DIR, `valid/${name}.request.json`),
    response: json<BundleResponse>(BUNDLE_CONTRACT_DIR, `valid/${name}.response.json`),
  },
});
const count = (db: Db, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "composition-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-0001','g','{}','t','t')").run();
  db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-1','AG-0001','a1','ACTIVE','t')").run();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("CompositionStore", () => {
  it("persists a valid revision with its decision and bundle, replayable byte for byte", () => {
    const store = new CompositionStore(db);
    const input = revision("two-skill");
    store.persist(input);
    const stored = store.get(input.spec.composition_revision_id)!;
    expect(stored).toEqual({ spec: input.spec, decision: input.decision, bundle: input.bundle });
    expect(stored.bundle.response.manifest.bundleDigest).toBe(input.spec.context.bundle_digest);
  });

  it("has no UPDATE or DELETE path: the triggers refuse both", () => {
    const store = new CompositionStore(db);
    const input = revision("zero-asset");
    store.persist(input);
    const id = input.spec.composition_revision_id;
    expect(() => db.prepare("UPDATE agent_specs SET spec_json = '{}' WHERE composition_revision_id = ?").run(id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM agent_specs WHERE composition_revision_id = ?").run(id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE composition_decisions SET decision_json = '{}'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM composition_decisions").run()).toThrow(/immutable/);
    db.prepare("INSERT INTO asset_usage_m1 VALUES ('au-1','skill:x','sha256:x','run-1',1,0,NULL,'attached','t')").run();
    expect(() => db.prepare("UPDATE asset_usage_m1 SET invocation_count = 9").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM asset_usage_m1").run()).toThrow(/immutable/);
    expect(Object.getOwnPropertyNames(CompositionStore.prototype).sort()).toEqual(["attachRun", "constructor", "get", "persist"]);
    // A decision explains exactly one revision.
    const reused = revision("two-skill");
    reused.decision.id = input.decision.id;
    reused.spec.explanation_ref = input.decision.id;
    expect(() => store.persist(reused)).toThrow(/already explains another revision/);
    // Re-persisting the same id is refused, not upserted.
    expect(() => store.persist(input)).toThrow(/already exists/);
    expect(store.get(id)!.spec).toEqual(input.spec);
  });

  it("validates every write, including checkComposition's digest agreement, and writes nothing on failure", () => {
    const store = new CompositionStore(db);
    const bad = revision("two-skill");
    (bad.spec.policy as unknown as Record<string, unknown>).secret = "x";
    expect(() => store.persist(bad)).toThrow(CompositionError);

    const drifted = revision("two-skill");
    drifted.spec.context.bundle_digest = `sha256:${"0".repeat(64)}`;
    expect(() => store.persist(drifted)).toThrow(/context.bundle_digest does not match the bundle/);

    const skill = revision("two-skill");
    // A self-consistent bundle rendered at another skill revision than the spec attaches.
    const other = `sha256:${"7".repeat(64)}`;
    skill.bundle.request.skills[0]!.digest = other;
    skill.bundle.response.manifest.included.find((e) => e.ref === skill.bundle.request.skills[0]!.id)!.digest = other;
    expect(() => store.persist(skill)).toThrow(/bundle skills \(id and digest\) do not match/);

    const tampered = revision("zero-asset");
    tampered.bundle.response.files[0]!.content += " ";
    expect(() => store.persist(tampered)).toThrow(/bundle response .*digest does not match its content/);

    const orphan = revision("zero-asset");
    orphan.spec.task_id = "AG-nope";
    expect(() => store.persist(orphan)).toThrow(/task AG-nope does not exist/);

    const unbundled = revision("zero-asset");
    expect(() => store.persist({ spec: unbundled.spec, decision: unbundled.decision } as never)).toThrow(/bundle is required/);

    expect(count(db, "agent_specs")).toBe(0);
    expect(count(db, "composition_decisions")).toBe(0);
  });

  it("binds a run to a revision of its own task, once", () => {
    const store = new CompositionStore(db);
    const first = revision("zero-asset");
    store.persist(first);
    const second = revision("two-skill");
    store.persist(second);
    store.attachRun("run-1", first.spec.composition_revision_id);
    store.attachRun("run-1", first.spec.composition_revision_id); // idempotent
    expect(() => store.attachRun("run-1", second.spec.composition_revision_id)).toThrow(/already bound/);
    expect(() => db.prepare("UPDATE runs SET composition_revision_id = NULL WHERE id = 'run-1'").run()).toThrow(/write-once/);
    expect(() => db.prepare("UPDATE runs SET composition_revision_id = ? WHERE id = 'run-1'").run(second.spec.composition_revision_id)).toThrow(/write-once/);
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-2','g','{}','t','t')").run();
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-2','AG-2','a1','ACTIVE','t')").run();
    expect(() => store.attachRun("run-2", second.spec.composition_revision_id)).toThrow(/not the run's task/);
    expect(db.prepare("SELECT composition_revision_id AS c FROM runs ORDER BY id").all()).toEqual([{ c: first.spec.composition_revision_id }, { c: null }]);
  });
});

describe("POST /api/usage/records", () => {
  let home: string;
  let hdb: Db;
  let built: BuiltServer;
  const record = (over: Record<string, unknown> = {}) => ({
    schemaVersion: "1.0", eventId: "evt-1", provider: "anthropic", sessionRef: "sess-1", source: "cockpit-import", assistantId: "claude",
    model: "claude-opus", accounting: "delta", tokensIn: 100, tokensOut: 20, cachedTokens: 5, costUsd: 0.25,
    apiEquivalentUsd: 0.31, pricingVersion: "p-2026-10", observedAt: "2026-10-17T10:00:00.000Z", ...over,
  });
  const secretWith = (capabilities: string[]) => {
    const path = credentialPath(loadConfig({ AGENT_PLANE_HOME: home }).dir);
    const file = readCredential(path);
    const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities, createdAt: new Date().toISOString(), notAfter: null };
    file.secrets.push(next);
    atomicWriteCredential(path, file);
    return { authorization: `Bearer ${next.secret}` };
  };
  const post = (body: unknown, headers = secretWith(["usage.write"])) => built.app.inject({ method: "POST", url: "/api/usage/records", payload: body as object, headers });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "usage-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    hdb = openDb(config.dbPath);
    built = buildServer({ config, db: hdb });
  });
  afterEach(async () => {
    await built.app.close();
    hdb.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("needs its own capability", async () => {
    expect(CONTROL_PLANE_API_VERSION).toBe("2.7");
    expect(INGEST_CAPABILITIES).toEqual(["usage.write"]);
    // A browser session requests observability + command capabilities only.
    expect(COMMAND_CAPABILITIES).not.toContain("usage.write");
    expect((await built.app.inject({ method: "POST", url: "/api/usage/records", payload: record() })).statusCode).toBe(401);
    expect((await post(record(), secretWith(["commands.write", "tasks.read"]))).statusCode).toBe(403);
  });

  it("stores one row for a replay and refuses a conflicting body under the same key", async () => {
    const first = await post(record());
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ replayed: false, record: { eventId: "evt-1", runId: null, tokensIn: 100 } });
    const again = await post(record());
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ replayed: true, record: first.json().record, link: "unmatched" });
    const conflict = await post(record({ tokensIn: 101 }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().record.tokensIn).toBe(100);
    // The key is (provider, sessionRef, eventId): the same eventId from another provider or session is another record.
    expect((await post(record({ provider: "openai" }))).statusCode).toBe(201);
    expect((await post(record({ sessionRef: "sess-2" }))).statusCode).toBe(201);
    expect(count(hdb, "usage_records")).toBe(3);
    expect(() => hdb.prepare("UPDATE usage_records SET tokens_in = 0").run()).toThrow(/immutable/);
    expect(() => hdb.prepare("DELETE FROM usage_records").run()).toThrow(/immutable/);
  });

  it("treats an absent optional and an explicit null as the same body", async () => {
    const { costUsd: _c, sessionRef: _s, ...bare } = record({ eventId: "evt-2" });
    expect((await post(bare)).statusCode).toBe(201);
    expect((await post({ ...bare, costUsd: null, sessionRef: null, runId: null })).statusCode).toBe(200);
    // No session is its own key space: NULL does not make a second copy distinct, and a session is another key.
    expect((await post({ ...bare, tokensIn: 101 })).statusCode).toBe(409);
    expect((await post({ ...bare, sessionRef: "sess-1" })).statusCode).toBe(201);
    expect(count(hdb, "usage_records")).toBe(2);
  });

  it("is the usage v1 contract: its fixtures pass and fail the validator", () => {
    for (const kind of ["valid", "invalid"] as const) {
      const dir = join(USAGE_CONTRACT_DIR, "fixtures", kind);
      const names = readdirSync(dir);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const result = validateUsageRecord(JSON.parse(readFileSync(join(dir, name), "utf8")));
        expect([name, result.ok]).toEqual([name, kind === "valid"]);
      }
    }
    // The envelope version is not part of the stored record.
    const parsed = validateUsageRecord(record());
    expect(parsed.ok && "schemaVersion" in parsed.value).toBe(false);
  });

  it("replays a retry that re-serialized the record: other key order, other spelling of the same instant", async () => {
    expect((await post(record({ eventId: "evt-3", observedAt: "2026-10-17T12:00:00+02:00" }))).statusCode).toBe(201);
    const reordered = Object.fromEntries(Object.entries(record({ eventId: "evt-3", observedAt: "2026-10-17T10:00:00Z" })).reverse());
    const replay = await post(reordered);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().record.observedAt).toBe("2026-10-17T10:00:00.000Z");
  });

  it("rejects malformed records, unknown fields and unknown runs without writing", async () => {
    expect((await post(record({ tokensIn: "100" }))).statusCode).toBe(400);
    expect((await post(record({ accounting: "absolute" }))).statusCode).toBe(400);
    expect((await post(record({ extra: true }))).statusCode).toBe(400);
    expect((await post(record({ tokensIn: -1 }))).statusCode).toBe(400);
    expect((await post(record({ observedAt: "yesterday" }))).statusCode).toBe(400);
    expect((await post(record({ eventId: "   " }))).statusCode).toBe(400);
    for (const observedAt of ["2016-12-31T23:59:60Z", "2020-01-01T00:00:00+01", "9999-12-31T23:59:59-23:59"]) {
      expect((await post(record({ observedAt }))).statusCode).toBe(400);
    }
    expect((await post(record({ tokensIn: 1e300 }))).statusCode).toBe(400);
    expect((await post(record({ runId: "run-missing" }))).statusCode).toBe(422);
    expect(count(hdb, "usage_records")).toBe(0);
  });
});

describe("GET /api/tasks/:id runs[].compositionRevisionId", () => {
  it("is null for an uncomposed run and the revision id once bound", async () => {
    const home = mkdtempSync(join(tmpdir(), "comp-run-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const hdb = openDb(config.dbPath);
    const built = buildServer({ config, db: hdb });
    try {
      built.registry.init();
      const taskId = built.tasks.create({ goal: "compose me" }).taskId;
      const assistant = Object.keys(config.assistants)[0]!;
      hdb.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-a', ?, ?, 'ENDED_OK', '2026-10-17T00:00:00Z')").run(taskId, assistant);
      const headers = { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` };
      const runs = async () => (await built.app.inject({ method: "GET", url: `/api/tasks/${taskId}`, headers })).json().runs as Array<{ compositionRevisionId: string | null }>;
      expect((await runs())[0]!.compositionRevisionId).toBeNull();
      const input = revision("zero-asset");
      input.spec.task_id = taskId;
      const store = new CompositionStore(hdb);
      store.persist(input);
      store.attachRun("run-a", input.spec.composition_revision_id);
      expect((await runs())[0]!.compositionRevisionId).toBe(input.spec.composition_revision_id);
    } finally {
      await built.app.close();
      hdb.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
