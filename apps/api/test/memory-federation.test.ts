/**
 * O6 S3 (docs/agentic-os-o6-memory-writeback.md §2.2, §5 row S3): the plane pulls Cockpit's memory
 * bundle snapshot (memory v1) with the registry token, keeps the last good one, and logs a shadow
 * verdict per pinned bundle per composition attempt that reached stage 4. The shadow never changes
 * the decision, the spec, `compositionDigest` or `inputs_digest`. Every secret is FAKE-*-not-real.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteCredential, credentialPath, readCredential } from "../src/auth/credential-file.js";
import type { ResolvedRegistryConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { computeMemoryBundleDigest, computeMemorySnapshotDigest, type MemoryBundle, type MemoryBundleSnapshot } from "../src/memory-contract.js";
import { CockpitMemoryClient, MemoryFederation, memoryShadowRowsForTask, parseMemoryShadowQuery, type MemoryShadowRow } from "../src/modules/memory-federation.js";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { bootRig, COCKPIT_TOKEN, reaches, type Rig, type RigOptions } from "./helpers/composer-cockpit.js";

let rig: Rig | undefined;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  for (const c of cleanups.splice(0)) await c();
});

const GOAL = "Add a typed helper to the TypeScript parser module";
const hex = (c: string) => `sha256:${c.repeat(64)}`;

/** A memory v1 bundle with `members` files of which `stale` are stale. Digests recompute as the contract requires. */
function bundle(id: string, members: number, stale: number, extra: Partial<MemoryBundle["health"]> = {}, salt = ""): MemoryBundle {
  const files = Array.from({ length: members }, (_, i) => ({ path: `m${i}.md`, digest: `sha256:${Buffer.from(`${id}${salt}${i}`).toString("hex").padEnd(64, "0").slice(0, 64)}` }));
  return {
    id, digest: computeMemoryBundleDigest(files), tags: [], repoScopes: [], visibility: "any_repo", members: files, estimatedTokens: 10 * members,
    health: { members, staleMembers: stale, oldestAgeDays: members ? (stale ? 214 : 30) : null, duplicatePairs: 0, ghosts: 0, oversized: 0, findingsDigest: hex(stale ? "5" : "6"), ...extra },
  };
}
const snapshotOf = (bundles: MemoryBundle[], observedAt = "2026-11-06T09:00:00.000Z"): MemoryBundleSnapshot =>
  ({ schemaVersion: "1.0", snapshotDigest: computeMemorySnapshotDigest(bundles), observedAt, bundles });

// "fresh" has 1 of 3 stale; "stale-gotchas" has 4 of 7 stale, aged 214 days (the plan's example).
const FRESH = bundle("fresh", 3, 1);
const STALE = bundle("stale-gotchas", 7, 4, { duplicatePairs: 1 });

async function boot(options: RigOptions = {}, pins: MemoryBundle[] = [FRESH, STALE]): Promise<Rig> {
  const r = await bootRig({
    ...options,
    configure: (config) => {
      config.composer.context.memoryBundles = pins.map((b) => ({ id: b.id, digest: b.digest, reason: "pinned for the O6 S3 test" }));
      options.configure?.(config);
    },
  });
  r.cockpit.memory.snapshot = snapshotOf([FRESH, STALE]);
  return r;
}

async function compose(taskId: string) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: rig!.auth(), payload: {} });
  return { status: res.statusCode, body: res.json() as PreviewResponse };
}

const rows = (taskId: string): MemoryShadowRow[] => memoryShadowRowsForTask(rig!.db, taskId);
const brief = (r: MemoryShadowRow) => [r.attemptId, r.bundleId, r.production?.action ?? null, r.shadow?.action ?? null];

function credentialWith(capabilities: readonly string[]): { authorization: string } {
  const path = credentialPath(rig!.config.dir);
  const file = readCredential(path);
  const next = { kid: `k_${randomBytes(4).toString("hex")}`, secret: randomBytes(32).toString("base64url"), capabilities: [...capabilities], createdAt: new Date().toISOString(), notAfter: null };
  file.secrets.push(next);
  atomicWriteCredential(path, file);
  return { authorization: `Bearer ${next.secret}` };
}

describe("memory shadow at compose", () => {
  it("previewing twice with health changed in between gives the same compositionDigest and two sets of shadow rows", async () => {
    rig = await boot();
    expect(await rig.built.memoryFederation.sync()).toEqual({ ok: true, snapshotDigest: snapshotOf([FRESH, STALE]).snapshotDigest, bundles: 2 });
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;

    const first = await compose(id);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toEqual({ status: "composed" });
    const context = first.body.decision.stages.find((s) => s.stage === "context")!;
    expect(context.chosen).toEqual(expect.arrayContaining(["memory:fresh", "memory:stale-gotchas"]));

    // Cockpit's Garden now finds 2 of 3 stale in "fresh" and the gotchas refreshed; member digests are unchanged, so the pins hold.
    const freshNow = { ...FRESH, health: { ...FRESH.health, staleMembers: 2, oldestAgeDays: 250, findingsDigest: hex("7") } };
    const staleNow = { ...STALE, health: { ...STALE.health, staleMembers: 0, oldestAgeDays: 20, findingsDigest: hex("8") } };
    rig.cockpit.memory.snapshot = snapshotOf([freshNow, staleNow], "2026-11-07T09:00:00.000Z");
    expect((await rig.built.memoryFederation.sync()).ok).toBe(true);

    const second = await compose(id);
    expect(second.body.compositionDigest).toBe(first.body.compositionDigest);
    expect(second.body.decision).toEqual(first.body.decision);
    expect(second.body.specDraft).toEqual(first.body.specDraft);
    const attempts = rig.db.prepare("SELECT id, inputs_digest FROM composition_attempts WHERE task_id = ? ORDER BY rowid").all(id) as Array<{ id: string; inputs_digest: string }>;
    expect(attempts.map((a) => a.id)).toEqual([first.body.attemptId, second.body.attemptId]);
    expect(attempts[1]!.inputs_digest).toBe(attempts[0]!.inputs_digest);

    const logged = rows(id);
    expect(logged.map(brief)).toEqual([
      [first.body.attemptId, "fresh", "included", "keep"],
      [first.body.attemptId, "stale-gotchas", "included", "demote"],
      [second.body.attemptId, "fresh", "included", "demote"],
      [second.body.attemptId, "stale-gotchas", "included", "keep"],
    ]);
    expect(logged[1]).toMatchObject({
      status: "scored", rule: "memory-shadow/v1", pinnedDigest: STALE.digest, snapshotBundleDigest: STALE.digest, snapshotStale: false,
      snapshotDigest: snapshotOf([FRESH, STALE]).snapshotDigest, snapshotObservedAt: "2026-11-06T09:00:00.000Z",
      shadow: { action: "demote", reason: "stale: 4 of 7 members, oldest 214d; shown, not demoting: 1 duplicate pair" },
      health: STALE.health, error: null,
    });
    expect(logged[2]!.snapshotObservedAt).toBe("2026-11-07T09:00:00.000Z");
    // The rows are append-only.
    expect(() => rig!.db.prepare("UPDATE memory_shadow_log SET reason = 'x'").run()).toThrow(/immutable/);
    expect(() => rig!.db.prepare("DELETE FROM memory_shadow_log").run()).toThrow(/immutable/);
  });

  it("logs unknown with no snapshot, and drifted when the snapshot moved past the pin; selection is unchanged", async () => {
    const pinnedOld = bundle("stale-gotchas", 7, 4, {}, "-old");
    rig = await boot({}, [FRESH, pinnedOld, bundle("not-declared", 2, 0)]);
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;

    const before = await compose(id); // no sync yet: the plane holds no memory snapshot
    expect(rows(id).map((r) => [r.bundleId, r.shadow?.action, r.snapshotDigest])).toEqual([
      ["fresh", "unknown", null], ["not-declared", "unknown", null], ["stale-gotchas", "unknown", null],
    ]);
    await rig.built.memoryFederation.sync();
    const after = await compose(id);
    expect(after.body.compositionDigest).toBe(before.body.compositionDigest);
    expect(rows(id).slice(3).map((r) => [r.bundleId, r.shadow?.action])).toEqual([
      ["fresh", "keep"], ["not-declared", "unknown"], ["stale-gotchas", "drifted"],
    ]);
    expect(rows(id)[5]!.shadow!.reason).toMatch(/^drifted: pinned sha256:[0-9a-f]{12}…, snapshot sha256:[0-9a-f]{12}…; 4 of 7 members stale, oldest 214d; shown, not demoting: 1 duplicate pair$/);
  });

  it("a throwing scorer still composes, starts and runs; the attempt gets one error row", async () => {
    rig = await boot({ memoryShadowScorer: () => { throw new RangeError("FAKE-scorer-boom-not-real"); } });
    await rig.built.memoryFederation.sync();
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const preview = await compose(id);
    expect(preview.status).toBe(200);
    expect(preview.body.outcome).toEqual({ status: "composed" });

    const done = reaches(rig.built, id, ["COMPLETED", "FAILED"]);
    const start = await rig.built.app.inject({ method: "POST", url: `/api/tasks/${id}/start`, headers: rig.auth(), payload: { compositionDigest: preview.body.compositionDigest } });
    expect(start.statusCode).toBe(200);
    expect(await done).toBe("COMPLETED");

    const logged = rows(id);
    expect(logged).toHaveLength(2); // preview and the persisted start
    for (const r of logged) expect(r).toMatchObject({ status: "error", bundleId: null, error: "scorer_threw:RangeError", shadow: null, production: null });
    expect(JSON.stringify(rig.db.prepare("SELECT * FROM memory_shadow_log").all())).not.toContain("FAKE-scorer-boom");
    // The asset shadow beside it still scored.
    expect((rig.db.prepare("SELECT COUNT(*) AS n FROM asset_shadow_log WHERE task_id = ? AND status = 'scored'").get(id) as { n: number }).n).toBe(2);
  });

  it("writes no row when nothing is pinned", async () => {
    rig = await boot({}, []);
    await rig.built.memoryFederation.sync();
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    expect((await compose(id)).status).toBe(200);
    expect(rows(id)).toEqual([]);
  });
});

describe("memory federation: Cockpit down keeps the last good snapshot", () => {
  it("a failed or invalid sync keeps the snapshot, records the reason, and the shadow keeps reading it", async () => {
    let clock = new Date("2026-11-06T10:00:00.000Z");
    rig = await boot({ now: () => clock });
    const good = snapshotOf([FRESH, STALE]);
    expect((await rig.built.memoryFederation.sync()).ok).toBe(true);

    rig.cockpit.memory.status = 503;
    clock = new Date("2026-11-06T11:00:00.000Z");
    expect(await rig.built.memoryFederation.sync()).toEqual({ ok: false, reason: "http_error" });
    // A body that fails memory v1 (unsorted bundles) changes nothing either.
    rig.cockpit.memory.status = 200;
    rig.cockpit.memory.snapshot = { ...good, bundles: [STALE, FRESH] };
    expect(await rig.built.memoryFederation.sync()).toEqual({ ok: false, reason: "invalid_response" });
    rig.cockpit.memory.snapshot = { ...good, schemaVersion: "2.0" };
    expect(await rig.built.memoryFederation.sync()).toEqual({ ok: false, reason: "unsupported_version" });
    await rig.cockpit.close();
    expect(await rig.built.memoryFederation.sync()).toEqual({ ok: false, reason: "unreachable" });

    const view = rig.built.memoryFederation.read();
    expect(view).toMatchObject({ snapshotDigest: good.snapshotDigest, lastSeenAt: "2026-11-06T10:00:00.000Z", lastFailure: "unreachable", stale: false });
    expect(view.snapshot).toEqual(good);
    expect((rig.db.prepare("SELECT COUNT(*) AS n FROM memory_bundle_snapshots").get() as { n: number }).n).toBe(1);

    // Past maxCacheAgeHours (48) the cache is stale, and still the one the shadow reads.
    clock = new Date("2026-11-08T10:00:00.001Z");
    expect(rig.built.memoryFederation.read().stale).toBe(true);
  });

  it("the route serves the federation state and the rows under telemetry.read", async () => {
    rig = await boot();
    await rig.built.memoryFederation.sync();
    const id = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    await compose(id);
    rig.cockpit.memory.status = 503;
    await rig.built.memoryFederation.sync();

    const get = (url: string, headers: Record<string, string> = rig!.auth()) => rig!.built.app.inject({ method: "GET", url, headers });
    const res = await get(`/api/composition/memory-shadow?taskId=${id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rule: string; taskId: string; federation: Record<string, unknown>; rows: MemoryShadowRow[] };
    expect(body.rule).toBe("memory-shadow/v1");
    expect(body.taskId).toBe(id);
    expect(body.federation).toMatchObject({ enabled: true, snapshotDigest: snapshotOf([FRESH, STALE]).snapshotDigest, lastFailure: "http_error", stale: false, bundles: 2 });
    expect(body.federation).not.toHaveProperty("snapshot");
    expect(body.rows.map((r) => [r.bundleId, r.shadow?.action])).toEqual([["fresh", "keep"], ["stale-gotchas", "demote"]]);
    const recent = (await get("/api/composition/memory-shadow?limit=1")).json() as { taskId: null; rows: MemoryShadowRow[] };
    expect(recent.taskId).toBeNull();
    expect(recent.rows.map((r) => r.bundleId)).toEqual(["stale-gotchas"]);

    expect((await get("/api/composition/memory-shadow", credentialWith(["telemetry.read"]))).statusCode).toBe(200);
    expect((await get("/api/composition/memory-shadow", credentialWith(["tasks.read", "memory.read"]))).statusCode).toBe(403);
    expect((await get("/api/composition/memory-shadow", {})).statusCode).toBe(401);
    expect((await get("/api/composition/memory-shadow?limit=0")).statusCode).toBe(400);
    expect((await get("/api/composition/memory-shadow?taskId=..%2Fx")).statusCode).toBe(400);
    expect((await get("/api/composition/memory-shadow?taskId=no-such-task")).statusCode).toBe(404);
  });
});

describe("CockpitMemoryClient", () => {
  async function serve(answer: (auth: string | undefined) => { status: number; body: string }): Promise<{ url: string; tokenPath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "memory-client-"));
    const tokenPath = join(dir, "registry-token");
    writeFileSync(tokenPath, `${COCKPIT_TOKEN}\n`, { mode: 0o600 });
    const server: Server = createServer((req, res) => {
      const { status, body } = req.url === "/api/v1/registry/memory/bundles" ? answer(req.headers.authorization) : { status: 404, body: "{}" };
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }), () => rmSync(dir, { recursive: true, force: true }));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenPath };
  }
  const reason = async (client: CockpitMemoryClient) => client.snapshot().then(() => "ok", (err: { reason?: string }) => err.reason);

  it("sends the registry bearer token and returns a valid snapshot", async () => {
    const good = snapshotOf([FRESH]);
    let seen: string | undefined;
    const { url, tokenPath } = await serve((auth) => { seen = auth; return { status: 200, body: JSON.stringify(good) }; });
    expect(await new CockpitMemoryClient(url, tokenPath).snapshot()).toEqual(good);
    expect(seen).toBe(`Bearer ${COCKPIT_TOKEN}`);
  });

  it("classifies a 401, a non-JSON body, a body echoing the token and a bad snapshot digest", async () => {
    const answers = [
      { status: 401, body: "{}" },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ ...snapshotOf([FRESH]), observedAt: COCKPIT_TOKEN }) },
      { status: 200, body: JSON.stringify({ ...snapshotOf([FRESH]), snapshotDigest: hex("0") }) },
    ];
    let i = 0;
    const { url, tokenPath } = await serve(() => answers[i++]!);
    const client = new CockpitMemoryClient(url, tokenPath);
    expect([await reason(client), await reason(client), await reason(client), await reason(client)])
      .toEqual(["unauthenticated", "invalid_response", "invalid_response", "invalid_response"]);
  });
});

describe("MemoryFederation off and the route query", () => {
  it("does nothing when registry federation is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-fed-off-"));
    const db: Db = openDb(join(dir, "plane.db"));
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    const config: ResolvedRegistryConfig["cockpit"] = { enabled: false, baseUrl: "http://127.0.0.1:1", tokenPath: join(dir, "none"), maxCacheAgeHours: 48 };
    const federation = new MemoryFederation(db, config, { snapshot: () => { throw new Error("never called"); } });
    expect(await federation.sync()).toEqual({ ok: false, reason: "disabled" });
    expect(federation.read()).toMatchObject({ enabled: false, snapshot: null, snapshotDigest: null, lastAttemptAt: null });
  });

  it("parses taskId and limit", () => {
    expect(parseMemoryShadowQuery({})).toEqual({ ok: true, limit: 100 });
    expect(parseMemoryShadowQuery({ taskId: "T-1", limit: "500" })).toEqual({ ok: true, taskId: "T-1", limit: 500 });
    expect(parseMemoryShadowQuery({ limit: "501" }).ok).toBe(false);
    expect(parseMemoryShadowQuery({ taskId: "" }).ok).toBe(false);
  });
});
