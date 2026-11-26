/**
 * qcq-04a: the ownership-only provider-entry commit on the legacy boundaries, the compat attempt
 * order at the wake, and the claim readers (review packet 2.1, 2.3.2, 2.4.1, 2.12). Section 5
 * tests 1 (cancel during preparation, duplicate caller), 2 (readers, direct-owner projection) and
 * 7 (compat attempt order). The Harness boundary is covered in harness/session-runner.test.ts.
 *
 * Every test drives the injected clock and the scheduler's own event paths with the fake adapter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore, enterProvider } from "../src/modules/attempts.js";
import { Scheduler } from "../src/modules/scheduler.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let errors: unknown[] = [];
let instant = Date.parse("2030-01-01T00:00:00Z");
const now = () => new Date(instant);
const A = "fake-a" as AssistantId; const B = "fake-b" as AssistantId;

async function boot(resources: Record<string, number> = { gpu: 1 }) {
  home = mkdtempSync(join(tmpdir(), "qcq-04a-entry-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  config.scheduler = { ...config.scheduler, enabled: true, resources };
  config.execution.harnessModes.single = false;
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
const scheduler = () => new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, onError: (e) => { errors.push(e); } });
const HOLD = "[FAKE:APPROVAL] hold the slot";
const task = (goal = "do the work") => { instant += 1; return built.tasks.create({ goal }).taskId; };
type Row = { attempt_id: string; kind: string; state: string; exit_proof: string | null; candidate_slot: number; session_id: string | null; dispatch_id: string | null; entered_at: string | null };
const attempts = (taskId: string) => db.prepare("SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY candidate_slot, created_at").all(taskId) as Row[];
const liveClaims = (taskId: string) => db.prepare("SELECT * FROM resource_claims WHERE task_id = ? AND released_at IS NULL").all(taskId);
async function drain() { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); }
async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (what()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${label}`);
}
const get = (taskId: string) => built.app.inject({ method: "GET", url: `/api/tasks/${taskId}`,
  headers: { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` } });

afterEach(async () => {
  const unexpected = errors; errors = [];
  expect(unexpected.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cancel during preparation (packet 2.4.1 step 1)", () => {
  it("a legacy direct start cancelled after its attempt exists and before the commit makes zero provider calls", async () => {
    await boot();
    const id = task();
    const start = vi.spyOn(built.registry.adapter(A), "start");
    // `requestedModel` runs after the attempt is written and the worktree step, before the commit:
    // the cancel lands inside preparation, synchronously, exactly where an awaited step would let it.
    const orch = built.orchestrator as unknown as { requestedModel: (...a: unknown[]) => unknown };
    const real = orch.requestedModel.bind(orch);
    vi.spyOn(orch, "requestedModel").mockImplementationOnce((...a: unknown[]) => { void built.orchestrator.cancelTask(id); return real(...a); });
    built.tasks.transition(id, "ROUTING"); // as the start route does before startTask
    // qcq-04b: the cancel asks the held attempt to stop, which the commit refuses first.
    await expect(built.orchestrator.startTask(id, A)).rejects.toThrow(/Provider entry refused: stop_requested/);
    expect(start).not.toHaveBeenCalled();
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "direct", state: "dropped", exit_proof: "never_entered", entered_at: null })]);
  });

  it("a legacy compare candidate cancelled during preparation makes zero provider calls", async () => {
    await boot();
    const id = task();
    const startA = vi.spyOn(built.registry.adapter(A), "start");
    const startB = vi.spyOn(built.registry.adapter(B), "start");
    const orch = built.orchestrator as unknown as { requestedModel: (...a: unknown[]) => unknown };
    const real = orch.requestedModel.bind(orch);
    vi.spyOn(orch, "requestedModel").mockImplementation((...a: unknown[]) => { void built.orchestrator.cancelTask(id); return real(...a); });
    await built.orchestrator.startParallel(id, [A, B], "compare").catch(() => undefined);
    // (startParallel moves the task itself.)
    await drain();
    expect(startA).not.toHaveBeenCalled();
    expect(startB).not.toHaveBeenCalled();
    const rows = attempts(id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "candidate" && r.state === "dropped" && r.exit_proof === "never_entered")).toBe(true);
  });

  it("executeDispatch cancelled between beforeStart and the commit makes zero provider calls and frees the slot", async () => {
    await boot();
    const s = scheduler();
    const id = task();
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    const start = vi.spyOn(built.registry.adapter(A), "start");
    const startB = vi.spyOn(built.registry.adapter(B), "start");
    // `registry.adapter` is the call between the `start_attempted` mark and the commit.
    const registry = built.registry as unknown as { adapter: (id: string) => unknown };
    const real = registry.adapter.bind(registry);
    let armed = false;
    vi.spyOn(registry, "adapter").mockImplementation((aid: string) => {
      if (armed) { armed = false; void built.orchestrator.cancelTask(id); }
      return real(aid);
    });
    const beforeStart = (built.orchestrator as unknown as { executeDispatch: (...a: unknown[]) => Promise<unknown> });
    const realExec = beforeStart.executeDispatch.bind(beforeStart);
    vi.spyOn(beforeStart, "executeDispatch").mockImplementation(async (request: unknown, options: unknown) => {
      const o = options as { beforeStart?: () => Promise<void> };
      const inner = o.beforeStart;
      return realExec(request, { ...o, beforeStart: async () => { await inner?.(); armed = true; } });
    });
    await s.tick(); await drain();
    // The refused start surfaces as the dispatch's error, as K4b's own phase check does.
    errors = errors.filter((e) => !/Provider entry refused: (task_cancelled|stop_requested)/.test(String(e)));
    expect(start).not.toHaveBeenCalled();
    expect(startB).not.toHaveBeenCalled();
    expect(built.tasks.get(id)?.state).toBe("CANCELLED");
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "dispatch", state: "dropped", exit_proof: "never_entered" })]);
    expect(liveClaims(id)).toEqual([]);
    expect(s.dispatches(id)[0]).toMatchObject({ phase: "cancelled" });
  });
});

describe("the commit at the store (packet 2.4.1)", () => {
  it("answers a duplicate caller not_owner and leaves the attempt and its claims untouched", async () => {
    await boot();
    const s = scheduler();
    const id = task(HOLD);
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    await s.tick(); await drain();
    await until(() => attempts(id)[0]?.state === "live", "a live dispatch attempt");
    const before = { attempt: attempts(id)[0], claims: liveClaims(id) };
    const again = enterProvider(db, { dispatchId: before.attempt!.dispatch_id!, path: "legacy" });
    expect(again).toMatchObject({ ok: false, kind: "not_owner" });
    expect(attempts(id)[0]).toEqual(before.attempt);
    expect(liveClaims(id)).toEqual(before.claims);
    // The wrong path is not the owner either.
    expect(enterProvider(db, { dispatchId: before.attempt!.dispatch_id!, path: "harness" })).toMatchObject({ ok: false, kind: "not_owner" });
    await built.orchestrator.cancelTask(id); await drain();
  });

  it("refuses a reserved dispatch and a missing claim, and accepts a started one", async () => {
    await boot();
    const id = task();
    const at = new Date(instant).toISOString();
    for (const g of [1, 2, 3]) db.prepare("INSERT INTO wait_conditions (task_id, generation, state, kind, not_before, created_by, created_at, reason, resource, resource_units, resource_queued_at) VALUES (?, ?, 'consumed', 'resource', ?, 'user', ?, 'r', 'gpu', 1, ?)").run(id, g, at, at, at);
    let generation = 0;
    const dispatch = (dispatchId: string, phase: string, path = "legacy") => db.prepare("INSERT INTO dispatches (dispatch_id, task_id, condition_generation, origin, execution_path, phase, created_at, updated_at) VALUES (?, ?, ?, 'wake', ?, ?, ?, ?)").run(dispatchId, id, ++generation, path, phase, at, at);
    const store = new AttemptStore(db, now);
    dispatch("d_reserved", "reserved");
    const a = store.createHeld({ taskId: id, kind: "dispatch", path: "legacy", dispatchId: "d_reserved", slot: 0, runAs: "plane", requirements: [{ resource: "gpu", units: 1, queuedAt: at }] });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, dispatch_id, generation, resource, units, claimed_at) VALUES (?, ?, 'd_reserved', 1, 'gpu', 1, ?)").run(a.attempt_id, id, at);
    // `beforeStart` has not marked it: no provider may enter from `reserved`.
    expect(enterProvider(db, { dispatchId: "d_reserved", path: "legacy" })).toMatchObject({ ok: false, kind: "refused", reason: "dispatch_reserved" });
    expect(store.get(a.attempt_id)).toMatchObject({ state: "dropped", exit_proof: "never_entered" });
    expect(liveClaims(id)).toEqual([]);

    db.prepare("UPDATE dispatches SET phase = 'cancelled' WHERE dispatch_id = 'd_reserved'").run();
    dispatch("d_noclaim", "start_attempted");
    const b = store.createHeld({ taskId: id, kind: "dispatch", path: "legacy", dispatchId: "d_noclaim", slot: 0, runAs: "plane", requirements: [{ resource: "gpu", units: 1, queuedAt: at }] });
    expect(enterProvider(db, { dispatchId: "d_noclaim", path: "legacy" })).toMatchObject({ ok: false, kind: "refused", reason: "claim_missing:gpu" });
    expect(store.get(b.attempt_id)).toMatchObject({ state: "dropped" });

    // A Harness dispatch already `started` while its runner waited for a start slot is accepted.
    db.prepare("UPDATE dispatches SET phase = 'cancelled' WHERE dispatch_id = 'd_noclaim'").run();
    dispatch("d_started", "started", "harness");
    const c = store.createHeld({ taskId: id, kind: "dispatch", path: "harness", dispatchId: "d_started", slot: 0, runAs: "plane" });
    db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, session_state, started_at, dispatch_id, lease_token, lease_expires_at)
      VALUES ('es_started', ?, ?, 'STARTING', 'STARTING', ?, 'd_started', 'FAKE-lease-not-real', '2999-01-01T00:00:00.000Z')`).run(id, A, at);
    // A stale lease is not the owner; the current one enters.
    expect(enterProvider(db, { attemptId: c.attempt_id, sessionId: "es_started", leaseToken: "stale", path: "harness" })).toMatchObject({ ok: false, kind: "not_owner" });
    expect(store.get(c.attempt_id)).toMatchObject({ state: "held" });
    expect(enterProvider(db, { attemptId: c.attempt_id, sessionId: "es_started", leaseToken: "FAKE-lease-not-real", path: "harness" })).toMatchObject({ ok: true });
    expect(store.get(c.attempt_id)).toMatchObject({ state: "starting", entered_at: expect.any(String), session_id: "es_started" });
  });
});

describe("the wake and the reservation (qcq-04b, packet 2.5.2; was the 04a compat attempt)", () => {
  it("W writes the dispatch and a queued attempt with no claim; R claims in the route transaction, and a failed claim write commits no route", async () => {
    await boot();
    const s = scheduler();
    const id = task(HOLD);
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    db.exec("CREATE TEMP TRIGGER qcq_fail_claim BEFORE INSERT ON resource_claims BEGIN SELECT RAISE(ABORT, 'claim store unavailable'); END");
    await s.wake(id, 1, "timer").catch(() => undefined);
    await drain();
    errors = errors.filter((e) => !/claim store unavailable/.test(String(e)));
    // W committed: the dispatch and its queued attempt, route in flight, holding nothing.
    const dispatchId = s.dispatches(id)[0]!.dispatch_id;
    expect(s.dispatches(id)).toEqual([expect.objectContaining({ phase: "reserved", routing_decision_id: null })]);
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "dispatch", state: "queued", dispatch_id: dispatchId })]);
    expect(db.prepare("SELECT COUNT(*) n FROM resource_claims WHERE task_id = ?").get(id)).toEqual({ n: 0 });

    db.exec("DROP TRIGGER qcq_fail_claim");
    // Immediate foreign keys: the claim's attempt and dispatch rows must already exist when it is written.
    db.pragma("defer_foreign_keys = OFF");
    await s.tick(); await drain();
    const [row] = attempts(id);
    expect(row).toMatchObject({ kind: "dispatch", candidate_slot: 0, state: "live", dispatch_id: dispatchId });
    expect(db.prepare("SELECT attempt_id, dispatch_id, generation, resource, units FROM resource_claims WHERE task_id = ?").all(id))
      .toEqual([{ attempt_id: row!.attempt_id, dispatch_id: dispatchId, generation: 1, resource: "gpu", units: 1 }]);
    expect(db.prepare("SELECT resource, units FROM attempt_requirements WHERE attempt_id = ?").all(row!.attempt_id)).toEqual([{ resource: "gpu", units: 1 }]);
    await built.orchestrator.cancelTask(id); await drain();
  });
});

describe("claim readers and the attempts projection (packet 2.3.2)", () => {
  it("shows the dispatch claim under resourceClaim and the attempt, and a direct-owner claim only under attempts", async () => {
    await boot();
    const s = scheduler();
    const id = task(HOLD);
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    await s.tick(); await drain();
    await until(() => attempts(id)[0]?.state === "live", "a live dispatch attempt");
    const body = (await get(id)).json<{ resourceClaim: { resource: string; dispatch_id: string } | null; attempts: { state: string; dispatchId: string | null; claims: unknown[]; slot: number }[] }>();
    expect(body.resourceClaim).toMatchObject({ resource: "gpu", units: 1, dispatch_id: s.dispatches(id)[0]!.dispatch_id });
    expect(body.attempts).toEqual([expect.objectContaining({ kind: "dispatch", state: "live", slot: 0, executionPath: "legacy",
      account: { key: null, source: "none" }, claims: [expect.objectContaining({ resource: "gpu", units: 1 })] })]);
    await built.orchestrator.cancelTask(id); await drain();
    expect(liveClaims(id)).toEqual([]);
    // qcq-04b (packet 2.13 item 4): released at the end of the cancelled run's stream, not at the task's terminal transition.
    await until(() => attempts(id)[0]?.state === "settled", "the attempt to settle");
    expect(attempts(id)[0]).toMatchObject({ state: "settled", exit_proof: "stream_closed_unverified" });

    // A direct-owner pool claim (no dispatch): resourceClaim is null, the claim is listed under attempts.
    const d = task();
    const store = new AttemptStore(db, now);
    const at = new Date(instant).toISOString();
    const a = store.createHeld({ taskId: d, kind: "direct", path: "legacy", slot: 0, runAs: "plane", requirements: [{ resource: "gpu", units: 2, queuedAt: at }] });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, resource, units, claimed_at) VALUES (?, ?, 'gpu', 1, ?)").run(a.attempt_id, d, at);
    const direct = (await get(d)).json<{ resourceClaim: unknown; attempts: { dispatchId: string | null; claims: { dispatchId: string | null }[] }[] }>();
    expect(direct.resourceClaim).toBeNull();
    expect(direct.attempts).toEqual([expect.objectContaining({ dispatchId: null, claims: [expect.objectContaining({ dispatchId: null, units: 1 })] })]);
    // A start that owns no dispatch cannot pass the launch funnel on a direct-owner claim.
    db.prepare("INSERT INTO wait_conditions (task_id, generation, state, kind, not_before, created_by, created_at, reason, resource, resource_units, resource_queued_at) VALUES (?, 1, 'consumed', 'resource', ?, 'user', ?, 'r', 'gpu', 2, ?)").run(d, at, at, at);
    expect(() => s.assertLaunchClaim(d, undefined)).toThrow(/needs 2 unit\(s\) of gpu/);
    // A dispatch attempt whose claim has fewer units than its requirement is refused too.
    db.prepare("INSERT INTO dispatches (dispatch_id, task_id, condition_generation, origin, execution_path, phase, created_at, updated_at) VALUES ('d_short', ?, 1, 'wake', 'legacy', 'reserved', ?, ?)").run(d, at, at);
    const short = store.createHeld({ taskId: d, kind: "dispatch", path: "legacy", dispatchId: "d_short", slot: 1, runAs: "plane", requirements: [{ resource: "gpu", units: 2, queuedAt: at }] });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, dispatch_id, generation, resource, units, claimed_at) VALUES (?, ?, 'd_short', 1, 'gpu', 1, ?)").run(short.attempt_id, d, at);
    expect(() => s.assertLaunchClaim(d, "d_short")).toThrow(/needs 2 unit\(s\) of gpu/);
  });

  it("settles a legacy direct attempt at its stream's end and lets the next start take slot 0", async () => {
    await boot();
    const id = task();
    built.tasks.transition(id, "ROUTING");
    await built.orchestrator.startTask(id, A);
    await until(() => ["COMPLETED", "FAILED", "WAITING_INPUT"].includes(built.tasks.get(id)!.state), "the run to settle");
    await drain();
    const [first] = attempts(id);
    expect(first).toMatchObject({ kind: "direct", candidate_slot: 0, session_id: expect.any(String), entered_at: expect.any(String) });
    expect(["settled"]).toContain(first!.state);
    expect(first!.exit_proof).toBe("stream_closed_unverified");
  });
});
