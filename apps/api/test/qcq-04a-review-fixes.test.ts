/**
 * #264 review (Codex, 2026-11-25): one regression test per runtime finding of the qcq-04a review.
 * The migration and trigger findings (3, and the 059 guards) are in qcq-04a-migration.test.ts, the
 * call-site allowlist gaps in qcq-04a-allowlist.test.ts.
 *
 *   1. A saved-route legacy dispatch with no attempt (reserved before the upgrade) is replayed at boot.
 *   2. Extra open legacy runs on a parked or created single task settle at boot.
 *   4. An entered legacy continuation whose start rejected is freed by the operator's confirmation.
 *   5. A start that fails after the adapter returned a handle cancels and drains the provider, and
 *      no attempt reason stores a secret.
 *   6. The live stream still carries `resource.released`; `attempt.*` rows are history only.
 *   +  The early launch check reads every requirement the attempt carries.
 *
 * Every test drives the injected clock and the scheduler's own event paths with the fake adapter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSecret, type AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore } from "../src/modules/attempts.js";
import { Scheduler, type SchedulerDeps } from "../src/modules/scheduler.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let errors: unknown[] = [];
let instant = Date.parse("2030-01-01T00:00:00Z");
const now = () => new Date(instant);
const A = "fake-a" as AssistantId; const B = "fake-b" as AssistantId;

async function boot(resources: Record<string, number> = { gpu: 1 }) {
  home = mkdtempSync(join(tmpdir(), "qcq-04a-fix-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  config.scheduler = { ...config.scheduler, enabled: true, resources };
  config.execution.harnessModes.single = false;
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
const scheduler = (boundary?: SchedulerDeps["boundary"]) => new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, boundary, onError: (e) => { errors.push(e); } });
const HOLD = "[FAKE:APPROVAL] hold the slot";
const task = (goal = "do the work") => { instant += 1; return built.tasks.create({ goal }).taskId; };
type Row = { attempt_id: string; kind: string; state: string; exit_proof: string | null; candidate_slot: number; session_id: string | null; dispatch_id: string | null; reason: string | null };
const attempts = (taskId: string) => db.prepare("SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY candidate_slot, created_at").all(taskId) as Row[];
const liveClaims = (taskId: string) => db.prepare("SELECT * FROM resource_claims WHERE task_id = ? AND released_at IS NULL").all(taskId);
async function drain() { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); }
async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (what()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${label}`);
}
const both = () => [built.registry.adapter(A), built.registry.adapter(B)];

afterEach(async () => {
  const unexpected = errors; errors = [];
  expect(unexpected.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("finding 1: a saved-route legacy dispatch with no attempt", () => {
  it("is replayed at boot with an attempt and reaches the provider", async () => {
    await boot();
    // The first incarnation routes the dispatch, saves the decision and dies before materializing.
    const first = scheduler(async (phase) => { if (phase === "routed") throw new Error("crash after routing"); });
    const id = task();
    first.attach(id, { kind: "time", notBefore: now().toISOString() });
    await first.tick(); await drain();
    errors = errors.filter((e) => !/crash after routing/.test(String(e)));
    const [d] = first.dispatches(id);
    expect(d).toMatchObject({ phase: "reserved", routing_decision_id: expect.any(Number) });
    // The upgrade gave this claimless dispatch no attempt (packet 2.3.1): remove the compat one.
    db.prepare("DELETE FROM execution_attempts WHERE dispatch_id = ?").run(d!.dispatch_id);
    const starts = both().map((a) => vi.spyOn(a, "start"));
    await scheduler().reconcileOnBoot(); await drain();
    expect(starts.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(1);
    expect(scheduler().dispatches(id)[0]).toMatchObject({ dispatch_id: d!.dispatch_id, phase: "started" });
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "dispatch", dispatch_id: d!.dispatch_id, session_id: expect.any(String) })]);
    expect(attempts(id)[0]!.state).not.toBe("held");
  });
});

describe("finding 2: extra open legacy runs left by a crash", () => {
  it("settle at boot on a parked and on a created task, so the next start takes slot 0", async () => {
    await boot();
    const at = now().toISOString();
    const store = new AttemptStore(db, now);
    const seed = (state: string) => {
      const id = task();
      db.prepare("UPDATE tasks SET state = ? WHERE id = ?").run(state, id);
      for (const slot of [0, 1]) {
        const runId = `run_${id}_${slot}`;
        db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, ?, ?, 'ACTIVE', ?)").run(runId, id, A, at);
        const a = store.createHeld({ taskId: id, kind: "direct", path: "legacy", slot, runAs: "plane", sessionId: runId, reason: "migrated: open run" });
        db.prepare("UPDATE execution_attempts SET state = 'live', entered_at = ?, entered_boot_id = 'old-boot' WHERE attempt_id = ?").run(at, a.attempt_id);
      }
      return id;
    };
    const parked = seed("WAITING_INPUT");
    const created = seed("CREATED");
    await scheduler().reconcileOnBoot(); await drain();
    for (const id of [parked, created]) {
      expect(attempts(id).map((a) => [a.candidate_slot, a.state, a.exit_proof])).toEqual([[0, "settled", "boot_unverified"], [1, "settled", "boot_unverified"]]);
    }
    // The created task starts: slot 0 is free (it failed on uq_attempt_owner before the fix).
    built.tasks.transition(created, "ROUTING");
    await expect(built.orchestrator.startTask(created, A)).resolves.toMatchObject({ runId: expect.any(String) });
    await until(() => attempts(created).length === 3, "the new attempt");
  });
});

describe("finding 4: an entered legacy continuation whose start rejected", () => {
  it("is freed by run-now with confirmNoLiveOwner despite an ended predecessor run on the task", async () => {
    await boot();
    const s = scheduler();
    const id = task();
    // An ended predecessor (a handoff's source run) on the same task, bound to no dispatch.
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, ended_at) VALUES ('pred', ?, ?, 'ENDED_OK', ?, ?)").run(id, A, now().toISOString(), now().toISOString());
    db.prepare("INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, reason, at) VALUES ('ckpt_pred', ?, 'pred', ?, 'handoff', ?)").run(id, JSON.stringify(built.tasks.envelope(id)), now().toISOString());
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    for (const a of both()) vi.spyOn(a, "start").mockRejectedValueOnce(new Error("provider refused the start"));
    await s.tick(); await drain();
    errors = errors.filter((e) => !/provider refused the start/.test(String(e)));
    const [d] = s.dispatches(id);
    expect(d).toMatchObject({ phase: "start_attempted" });
    expect(attempts(id)).toEqual([expect.objectContaining({ dispatch_id: d!.dispatch_id, state: "starting" })]);
    expect(liveClaims(id)).toHaveLength(1);
    // The sweep keeps it (the dispatch is ambiguous); the operator's confirmation frees it.
    await s.tick(); await drain();
    expect(attempts(id)[0]).toMatchObject({ state: "starting" });
    const generation = s.condition(id)!.generation;
    vi.restoreAllMocks();
    await s.runNow(id, generation, true); await drain();
    expect(attempts(id)[0]).toMatchObject({ dispatch_id: d!.dispatch_id, state: "settled", exit_proof: "operator_confirmed" });
    expect(db.prepare("SELECT released_at FROM resource_claims WHERE dispatch_id = ?").get(d!.dispatch_id)).toEqual({ released_at: expect.any(String) });
    expect(s.events(id).some((e) => e.type === "dispatch.aborted" && e.dispatchId === d!.dispatch_id)).toBe(true);
    await built.orchestrator.cancelTask(id).catch(() => undefined); await drain();
  });
});

describe("finding 5: a legacy start that fails after its handle", () => {
  it("cancels the returned provider, ends its run row and settles only once the stream ended; reasons are redacted", async () => {
    await boot();
    const secret = "FAKE-review-secret-not-real";
    registerSecret(secret);
    const id = task();
    const adapter = built.registry.adapter(A);
    const cancel = vi.spyOn(adapter, "cancel");
    db.exec(`CREATE TEMP TRIGGER qcq_fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run store unavailable ${secret}'); END`);
    built.tasks.transition(id, "ROUTING");
    await expect(built.orchestrator.startTask(id, A)).rejects.toThrow(/run store unavailable/);
    db.exec("DROP TRIGGER qcq_fail_run");
    expect(cancel).toHaveBeenCalledTimes(1);
    const [a] = attempts(id);
    expect(a).toMatchObject({ kind: "direct", state: "settled", exit_proof: "stream_closed_unverified" });
    expect(a!.reason).toMatch(/provider cancelled and its stream ended/);
    expect(a!.reason).not.toContain(secret);
    expect(JSON.stringify(db.prepare("SELECT * FROM execution_attempts").all())).not.toContain(secret);
    expect(JSON.stringify(db.prepare("SELECT payload FROM scheduler_events").all())).not.toContain(secret);
  });

  it("leaves the attempt ambiguous, holding its slot, when the cancelled stream does not end", async () => {
    await boot();
    const id = task();
    const adapter = built.registry.adapter(A);
    vi.spyOn(adapter, "cancel").mockResolvedValue(undefined);
    vi.spyOn(adapter, "events").mockImplementation(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      db.exec("CREATE TEMP TRIGGER qcq_fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run store unavailable'); END");
      built.tasks.transition(id, "ROUTING");
      const started = built.orchestrator.startTask(id, A).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(String(await started)).toMatch(/run store unavailable/);
      db.exec("DROP TRIGGER qcq_fail_run");
    } finally { vi.useRealTimers(); }
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "direct", state: "ambiguous", exit_proof: null })]);
    expect(attempts(id)[0]!.reason).toMatch(/its stream did not end/);
  });

  it("a rejected start (no handle) still settles stream_closed_unverified with a redacted reason", async () => {
    await boot();
    const secret = "FAKE-rejected-secret-not-real";
    registerSecret(secret);
    const id = task();
    vi.spyOn(built.registry.adapter(A), "start").mockRejectedValueOnce(new Error(`spawn failed ${secret}`));
    built.tasks.transition(id, "ROUTING");
    await expect(built.orchestrator.startTask(id, A)).rejects.toThrow(/spawn failed/);
    expect(attempts(id)).toEqual([expect.objectContaining({ state: "settled", exit_proof: "stream_closed_unverified" })]);
    expect(attempts(id)[0]!.reason).not.toContain(secret);
  });
});

describe("finding 6: the live stream after a pool-backed cancel", () => {
  it("delivers resource.released and never an attempt.* row", async () => {
    await boot();
    const s = scheduler();
    const id = task(HOLD);
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    await s.tick(); await drain();
    await until(() => attempts(id)[0]?.state === "live", "a live dispatch attempt");
    const seen: string[] = [];
    const off = built.bus.subscribe(id, (p) => { if (p.kind === "scheduler") seen.push(p.scheduler!.type); });
    await s.cancel(id); await drain();
    await until(() => seen.includes("resource.released"), "resource.released on the stream");
    off();
    expect(seen.filter((t) => t.startsWith("attempt."))).toEqual([]);
    expect(s.events(id).map((e) => e.type)).toEqual(expect.arrayContaining(["wait.cancelled", "resource.released", "attempt.settled"]));
  });
});

describe("the early launch check (packet 2.3.2)", () => {
  it("refuses a held dispatch attempt with enough of the wait's pool but a second unsatisfied requirement", async () => {
    await boot({ gpu: 2, disk: 1 });
    const s = scheduler();
    const id = task();
    const at = now().toISOString();
    db.prepare("INSERT INTO wait_conditions (task_id, generation, state, kind, not_before, created_by, created_at, reason, resource, resource_units, resource_queued_at) VALUES (?, 1, 'consumed', 'resource', ?, 'user', ?, 'r', 'gpu', 1, ?)").run(id, at, at, at);
    db.prepare("INSERT INTO dispatches (dispatch_id, task_id, condition_generation, origin, execution_path, phase, created_at, updated_at) VALUES ('d_two', ?, 1, 'wake', 'legacy', 'reserved', ?, ?)").run(id, at, at);
    const a = new AttemptStore(db, now).createHeld({ taskId: id, kind: "dispatch", path: "legacy", dispatchId: "d_two", slot: 0, runAs: "plane",
      requirements: [{ resource: "gpu", units: 1, queuedAt: at }, { resource: "disk", units: 1, queuedAt: at }] });
    db.prepare("INSERT INTO resource_claims (attempt_id, task_id, dispatch_id, generation, resource, units, claimed_at) VALUES (?, ?, 'd_two', 1, 'gpu', 1, ?)").run(a.attempt_id, id, at);
    expect(() => s.assertLaunchClaim(id, "d_two")).toThrow(/needs 1 unit\(s\) of disk/);
  });
});
