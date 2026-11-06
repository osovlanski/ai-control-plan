/**
 * M6 S4 (docs/agentic-os-m6-composition-telemetry.md §4, §5 row S4): the shadow scorer logs one
 * row per composition attempt that reached stage 3, outside the attempt's transaction, and never
 * changes the composition. Ledger rows are seeded the way S1/S2 would have projected them.
 * Every secret here is FAKE-*-not-real.
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { COMMAND_CAPABILITIES, INGEST_CAPABILITIES, OBSERVABILITY_CAPABILITIES, type AssetScores } from "@agent-plane/core";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import { fileDigest } from "../src/bundle-contract.js";
import { migrate } from "../src/db/index.js";
import type { RegistryAsset } from "../src/registry-contract.js";
import { buildAssetShadowReport, openReportDb, renderAssetShadowReport } from "../src/bin/asset-shadow-report.js";
import { shadowRowsForTask, type ShadowLogSummary } from "../src/modules/asset-shadow.js";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { bootRig, reaches, TS_REVIEW, type Rig, type RigOptions } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const GOAL = "Add a typed helper to the TypeScript parser module";
// Ids after ts-review: the stand-in Cockpit serves ts-review first, and a snapshot must be in id order.
const TS_TIDY = "claude-skills:ts-tidy";
const TS_TIDY_DIGEST = fileDigest(`body of ${TS_TIDY}`);
const UNLISTED = "claude-skills:zz-unlisted";

const skillAsset = (id: string, tags: string[]): RegistryAsset => ({
  id, digest: fileDigest(`body of ${id}`), kind: "skill", nativeKind: "claude-skills", name: id.split(":")[1]!, description: "a skill",
  tags, targets: ["claude"], compatibility: { assistants: ["claude", "codex"] },
  requirements: { secretRefs: [] }, conflicts: [], lineage: { origin: "library" }, enabled: true, installedAt: "2026-10-01T09:00:00.000Z",
});

/** ts-review plus `extra`, at most one skill, both ts-* allowlisted (the unlisted one never is). */
async function boot(extra: RegistryAsset[], options: RigOptions = {}): Promise<Rig> {
  return bootRig({
    ...options,
    extraAssets: extra,
    configure: (config) => {
      config.composer.assets.maxSkills = 1;
      config.composer.assets.allowlist.push(...extra.filter((a) => a.id !== UNLISTED).map((a) => ({ id: a.id, digest: a.digest })));
    },
  });
}

async function compose(taskId: string) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: rig!.auth(), payload: {} });
  return { status: res.statusCode, body: res.json() as PreviewResponse };
}

let seedSeq = 0;
/**
 * Seeds `n` ledger rows for one asset in the cohort of GOAL's task kind on claude-code, each its own
 * session of a separate seed task, as S1/S2 project a settled composed session.
 */
function seedLedger(asset: { id: string; digest: string }, n: number, row: { attached: boolean; invoked?: number; outcome: "success" | "error" | "neutral" }) {
  const db = rig!.db;
  const seedTask = rig!.built.tasks.create({ goal: GOAL, repoPath: rig!.repo }).taskId;
  const revision = `CR-${seedTask}-seed`;
  db.prepare(`INSERT INTO agent_specs (composition_revision_id, task_id, schema_version, explanation_ref, bundle_digest, spec_json, bundle_request_json, bundle_response_json, created_at)
    VALUES (?, ?, '1.1', ?, 'sha256:seed', '{}', '{}', '{}', ?)`).run(revision, seedTask, `CD-${seedTask}-seed`, new Date().toISOString());
  for (let i = 0; i < n; i += 1) {
    seedSeq += 1;
    const session = `run-seed-${seedSeq}`;
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, ?, 'fake-claude', 'COMPLETED', ?)").run(session, seedTask, new Date().toISOString());
    const invoked = row.attached ? (row.invoked ?? 1) : null;
    db.prepare(
      `INSERT INTO asset_usage VALUES (?, (SELECT COALESCE(MAX(ingest_seq), 0) + 1 FROM asset_usage), ?, ?, ?, 'skill', ?, ?, 'claude-code', 'full', ?,
        ?, ?, ?, ?, ?, NULL, 'co-occurrence/v1', 2, 'sha256:seed', ?)`,
    ).run(
      `au1_${createHash("sha256").update(`${session}:${asset.id}`).digest("hex")}`, revision, session, seedTask, asset.id, asset.digest, row.attached ? 1 : 0,
      row.attached ? "runtime_confirmed" : "none", row.attached ? "tool_event" : "not_observable", invoked, row.attached ? 0 : null, row.outcome,
      new Date(Date.now() - 3_600_000).toISOString(),
    );
  }
}

/** ts-tidy invoked in 12 successful sessions; 6 sessions without it failed. */
function seedTidyLift() {
  seedLedger({ id: TS_TIDY, digest: TS_TIDY_DIGEST }, 12, { attached: true, outcome: "success" });
  seedLedger({ id: "claude-skills:other", digest: fileDigest("other") }, 6, { attached: true, outcome: "error" });
}

const shadowRows = (taskId: string) => shadowRowsForTask(rig!.db, taskId);
const count = (table: string) => (rig!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function credentialWith(capabilities: readonly string[]): { authorization: string } {
  const path = credentialPath(rig!.config.dir);
  const file = readCredential(path);
  const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...capabilities], createdAt: new Date().toISOString(), notAfter: null };
  file.secrets.push(next);
  atomicWriteCredential(path, file);
  return { authorization: `Bearer ${next.secret}` };
}

describe("M6 S4 shadow log", () => {
  it("previewing twice with telemetry changed in between gives the same compositionDigest and two shadow rows", async () => {
    rig = await boot([skillAsset(TS_TIDY, ["coding", "typescript"])]);
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;

    const first = await compose(id);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toEqual({ status: "composed" });
    // A tie on matched tags: stage 3 takes ts-review by id.
    expect(first.body.decision.stages.find((s) => s.stage === "assets")!.chosen).toEqual([TS_REVIEW]);

    seedTidyLift();
    const second = await compose(id);
    expect(second.body.compositionDigest).toBe(first.body.compositionDigest);
    expect(second.body.decision).toEqual(first.body.decision);
    const attempts = rig.db.prepare("SELECT id, inputs_digest, composition_digest FROM composition_attempts WHERE task_id = ? ORDER BY rowid").all(id) as Array<{ id: string; inputs_digest: string; composition_digest: string }>;
    expect(attempts.map((a) => a.id)).toEqual([first.body.attemptId, second.body.attemptId]);
    expect(attempts[1]!.inputs_digest).toBe(attempts[0]!.inputs_digest);

    const rows = shadowRows(id);
    expect(rows.map((r) => [r.attemptId, r.status, r.wouldDiffer, r.actual, r.shadow])).toEqual([
      [first.body.attemptId, "scored", false, [TS_REVIEW], [TS_REVIEW]],
      [second.body.attemptId, "scored", true, [TS_REVIEW], [TS_TIDY]],
    ]);
    expect(rows[1]).toMatchObject({ formula: "asset-shadow/v1", taskKind: "coding", harness: "claude-code", filterViolations: 0, overridden: false });
    const deciding = rows[1]!.scores as Array<{ id: string; lift: number; method: string; n: number; matched: number }>;
    expect(deciding.find((c) => c.id === TS_TIDY)).toMatchObject({ method: "tool_event", n: 12, matched: 2 });
    expect(deciding.find((c) => c.id === TS_TIDY)!.lift).toBeGreaterThan(0);
    expect(deciding.find((c) => c.id === TS_REVIEW)).toMatchObject({ method: "no_evidence", lift: 0, n: 0 });
  });

  it("sets would_differ only on a tie that a lift breaks", async () => {
    // ts-tidy matches one tag, ts-review two: no tie, and ts-tidy's lift cannot move it.
    rig = await boot([skillAsset(TS_TIDY, ["coding"])]);
    seedLedger({ id: TS_TIDY, digest: TS_TIDY_DIGEST }, 20, { attached: true, outcome: "success" });
    seedLedger({ id: "claude-skills:other", digest: fileDigest("other") }, 6, { attached: true, outcome: "error" });
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    expect((await compose(id)).status).toBe(200);
    expect(shadowRows(id)).toEqual([expect.objectContaining({ status: "scored", wouldDiffer: false, actual: [TS_REVIEW], shadow: [TS_REVIEW] })]);
    const tidy = (shadowRows(id)[0]!.scores as Array<{ id: string; lift: number; matched: number }>).find((c) => c.id === TS_TIDY)!;
    expect(tidy.lift).toBeGreaterThan(0);
    expect(tidy.matched).toBe(1);
  });

  it("never puts a filtered asset in a shadow choice, whatever its lift", async () => {
    rig = await boot([skillAsset(UNLISTED, ["coding", "typescript"])]);
    seedLedger({ id: UNLISTED, digest: fileDigest(`body of ${UNLISTED}`) }, 30, { attached: true, outcome: "success" });
    seedLedger({ id: "claude-skills:other", digest: fileDigest("other") }, 6, { attached: true, outcome: "error" });
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const res = await compose(id);
    const assets = res.body.decision.stages.find((s) => s.stage === "assets")!;
    expect(assets.filters.find((f) => f.filter === "not_allowlisted")!.removed).toContain(UNLISTED);
    const [row] = shadowRows(id);
    expect(row).toMatchObject({ status: "scored", shadow: [TS_REVIEW], wouldDiffer: false, filterViolations: 0 });
    expect((row!.scores as Array<{ id: string }>).map((c) => c.id)).not.toContain(UNLISTED);
  });

  it("a throwing scorer still composes the same decision and logs an error row", async () => {
    rig = await boot([skillAsset(TS_TIDY, ["coding", "typescript"])]);
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const healthy = await compose(id);
    await rig.close();
    rig = await boot([skillAsset(TS_TIDY, ["coding", "typescript"])], { assetShadowScorer: () => { throw new TypeError("FAKE-scorer-failure-not-real"); } });
    const id2 = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const res = await compose(id2);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ status: "composed" });
    expect(res.body.decision.stages.find((s) => s.stage === "assets")).toEqual(healthy.body.decision.stages.find((s) => s.stage === "assets"));
    expect(count("composition_attempts")).toBe(1);
    const [row] = shadowRows(id2);
    expect(row).toMatchObject({ attemptId: res.body.attemptId, status: "error", error: "scorer_threw:TypeError", shadow: null, wouldDiffer: null, actual: [TS_REVIEW] });
    // The error code is a class name, never the message.
    expect(JSON.stringify(rig.db.prepare("SELECT * FROM asset_shadow_log").all())).not.toContain("FAKE-scorer-failure");
  });

  it("logs a started composition after its persisted attempt, and nothing for an attempt that never reached stage 3", async () => {
    rig = await boot([]);
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const done = reaches(rig.built, id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    const res = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(await done).toBe("COMPLETED");
    const persisted = rig.db.prepare("SELECT id FROM composition_attempts WHERE task_id = ? AND outcome = 'persisted'").get(id) as { id: string };
    expect(shadowRows(id)).toEqual([expect.objectContaining({ attemptId: persisted.id, status: "scored", actual: [TS_REVIEW], wouldDiffer: false })]);

    // No eligible assistant: stage 2 chose nobody, the pipeline stopped there, no shadow row.
    rig.db.prepare("UPDATE assistants SET enabled = 0").run();
    const none = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const stopped = await compose(none);
    expect(stopped.body.decision.stages.find((s) => s.stage === "harness_model")!.chosen).toEqual([]);
    expect(shadowRows(none)).toEqual([]);
  });
});

describe("GET /api/composition/asset-scores and /api/composition/shadow", () => {
  it("serve the table and the would-differ attempts under telemetry.read; 403 without it, 400 on a bad query", async () => {
    rig = await boot([skillAsset(TS_TIDY, ["coding", "typescript"])]);
    seedTidyLift();
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    await compose(id);

    const get = async (url: string, headers = rig!.auth()) => {
      const res = await rig!.built.app.inject({ method: "GET", url, headers });
      return { status: res.statusCode, body: res.json() as unknown };
    };
    const scores = await get("/api/composition/asset-scores?taskKind=coding&harness=claude-code");
    expect(scores.status).toBe(200);
    const table = scores.body as AssetScores;
    expect(table).toMatchObject({ formula: "asset-shadow/v1", k: 10, sessions: { sample: 18 } });
    const tidy = table.cohorts.find((c) => c.assetId === TS_TIDY)!;
    expect(tidy).toMatchObject({ taskKind: "coding", harness: "claude-code", method: "tool_event", outcome: { group: { n: 12, s: 12 }, baseline: { n: 6, s: 0 } } });
    expect(tidy.rankingLift).toBeCloseTo(tidy.outcome.group.lift, 12);
    expect((await get("/api/composition/asset-scores?harness=codex")).body).toMatchObject({ cohorts: [] });

    const shadow = await get("/api/composition/shadow");
    expect(shadow.status).toBe(200);
    expect(shadow.body).toMatchObject({ logged: 1, scored: 1, errors: 0, wouldDiffer: 1, wouldDifferRate: 1, filterViolations: 0 });
    expect((shadow.body as ShadowLogSummary).attempts.map((a) => [a.actual, a.shadow])).toEqual([[[TS_REVIEW], [TS_TIDY]]]);
    expect((await get(`/api/composition/shadow?since=${new Date(Date.now() + 60_000).toISOString()}`)).body).toMatchObject({ logged: 0, attempts: [] });

    const noTelemetry = credentialWith([...OBSERVABILITY_CAPABILITIES.filter((c) => c !== "telemetry.read"), ...COMMAND_CAPABILITIES, ...INGEST_CAPABILITIES]);
    expect((await get("/api/composition/asset-scores", noTelemetry)).status).toBe(403);
    expect((await get("/api/composition/shadow", noTelemetry)).status).toBe(403);
    expect((await get("/api/composition/asset-scores", credentialWith(["telemetry.read"]))).status).toBe(200);
    expect((await get("/api/composition/shadow", {} as { authorization: string })).status).toBe(401);

    for (const q of ["/api/composition/asset-scores?taskKind=nope", "/api/composition/asset-scores?harness=vim", "/api/composition/shadow?since=yesterday",
      "/api/composition/shadow?limit=0", "/api/composition/shadow?limit=501", "/api/composition/shadow?since=2026-11-06"]) {
      expect([q, (await get(q)).status]).toEqual([q, 400]);
    }
  });
});

describe("asset:shadow-report", () => {
  it("reads a live DB read-only and unmigrated, and shows the lift and the would-differ preview", async () => {
    rig = await boot([skillAsset(TS_TIDY, ["coding", "typescript"])]);
    seedTidyLift();
    await compose(rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId);
    rig.db.pragma("wal_checkpoint(TRUNCATE)");
    const path = rig.config.dbPath;
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    const db = openReportDb(path);
    try {
      expect(() => db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('x', 'y')").run()).toThrow(/readonly/);
      const report = buildAssetShadowReport(db, new Date());
      expect(report.shadow).toMatchObject({ scored: 1, wouldDiffer: 1 });
      const text = renderAssetShadowReport(report);
      expect(text).toContain("SHADOW ONLY");
      expect(text).toMatch(/skill claude-skills:ts-tidy .*\[coding\/claude-code\] tool_event/);
      expect(text).toMatch(/invoked n=12 s=12 raw 1\.000 · baseline n=6 p=0\.125 · w=0\.545 · lift \+/);
      expect(text).toContain("would differ 1 (100.0% of scored)");
      expect(text).toContain(`stage 3: ${TS_REVIEW}`);
      expect(text).toContain(`shadow:  ${TS_TIDY}`);
    } finally {
      db.close();
    }
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
  });

  it("refuses a database without 038, naming it, and does not migrate it", () => {
    const dir = mkdtempSync(join(tmpdir(), "asset-shadow-report-"));
    try {
      const migrations = new URL("../src/db/migrations/", import.meta.url);
      const partial = join(dir, "migrations");
      mkdirSync(partial);
      for (const name of readdirSync(migrations).filter((n) => n.endsWith(".sql") && n !== "038_asset_shadow_log.sql")) copyFileSync(new URL(name, migrations), join(partial, name));
      const file = join(dir, "pre-038.db");
      const db = new Database(file);
      migrate(db, partial);
      db.close();
      expect(() => openReportDb(file)).toThrow(/lacks 038_asset_shadow_log\.sql/);
      const check = new Database(file, { readonly: true });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'asset_shadow_log'").get()).toBeUndefined();
      check.close();
      expect(() => openReportDb(join(dir, "missing.db"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
