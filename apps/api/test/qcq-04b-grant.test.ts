/**
 * qcq-04b part 2a (review packet 2.2, 2.4, 2.5): the wake (W), the launch reservation (R) and the
 * grant pass (G) on the scheduler dispatch path, with account enforcement on through the test seam
 * of packet 2.12 (`config.accounts` set directly; config load still refuses `enforce: true`).
 * Packet section 5 tests 1 (account contention, Harness-only), 4 (G through provider entry) and the
 * wake budget of 2.5.3. Enforcement off is K4b: resource-slots.test.ts runs unchanged in order and
 * outcome, with the claim moved after routing (2.13 items 1 to 3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { configureExitProofs, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, setExitEvidence } from "../src/modules/exit-evidence.js";
import { Scheduler } from "../src/modules/scheduler.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let errors: unknown[] = [];
let instant = Date.parse("2030-01-01T00:00:00Z");
const now = () => new Date(instant);
const A = "fake-a" as AssistantId; const B = "fake-b" as AssistantId;
const WORK = "do the work";

async function boot(opts: { harness: boolean; limit?: number; resources?: Record<string, number>; unscoped?: boolean }) {
  home = mkdtempSync(join(tmpdir(), "qcq-04b-grant-"));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  config.scheduler = { ...config.scheduler, enabled: true, resources: opts.resources ?? {} };
  config.execution.harnessModes.single = opts.harness;
  // The packet 2.12 seam: enforcement through the policy object, never through config load.
  config.accounts = { enforce: true, defaultLimit: null, maxInheritedKeys: 3,
    groups: { acct: { provider: "fake", limit: opts.limit ?? 1, members: [{ assistant: A, runAs: "plane" }, { assistant: B, runAs: "plane" }] } } };
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
  // An account claim is released only by a strong proof (packet 2.6.1), so both members spawn into
  // a unit the fake exit evidence reads: never registered and absent once the stream has closed,
  // which is `unscoped_exit`.
  if (!opts.unscoped) for (const id of [A, B]) Object.defineProperty(built.registry.adapter(id), "scopedSpawn", { value: true });
  setExitEvidence(db, new FakeExitEvidence());
  configureExitProofs(db, { watchMs: 5 });
}
/** A gate on the `routed` boundary (just after R): a gated task holds its claims without a provider, until opened. */
function gate() {
  const held = new Set<string>(); const waiters = new Map<string, () => void>();
  return {
    hold: (taskId: string) => held.add(taskId),
    open: (taskId: string) => { held.delete(taskId); waiters.get(taskId)?.(); },
    boundary: async (phase: string, d: { task_id: string }) => {
      if (phase === "routed" && held.has(d.task_id)) await new Promise<void>((r) => waiters.set(d.task_id, r));
    },
  };
}
/** The test's scheduler, with the server's own one stopped so that only this one hears a release. */
const scheduler = (boundary?: ReturnType<typeof gate>["boundary"]) => (built.scheduler.stop(), new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, boundary: boundary as never, onError: (e) => { errors.push(e); } }));
function waiting(s: Scheduler, resource?: string, goal = WORK) {
  const t = built.tasks.create({ goal }).taskId;
  s.attach(t, resource ? { kind: "resource", resource, reason: "needs a slot" } : { kind: "time", notBefore: now().toISOString(), reason: "go" });
  instant += 1;
  return t;
}
const live = (resource: string) => db.prepare("SELECT task_id, attempt_id, dispatch_id FROM resource_claims WHERE resource = ? AND released_at IS NULL ORDER BY claim_id").all(resource) as { task_id: string; attempt_id: string; dispatch_id: string }[];
type Attempt = { attempt_id: string; state: string; routing_decision_id: number | null; dispatch_id: string | null; account_key: string | null; account_source: string; queue_key: string; exit_proof: string | null };
const attemptsOf = (taskId: string) => db.prepare("SELECT * FROM execution_attempts WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Attempt[];
async function drain() { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }
async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) { if (what()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  const unexpected = errors; errors = [];
  expect(unexpected.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual([]);
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) { stopExitWatches(db); db.close(); }
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("account contention on the Harness path (test 1)", () => {
  it("R claims the account, a second start waits queued with its route, and G grants it on release through provider entry", async () => {
    await boot({ harness: true });
    const g = gate(); const s = scheduler(g.boundary);
    const first = waiting(s); const second = waiting(s);
    g.hold(first); g.hold(second);
    await s.tick(); await drain();
    await until(() => live("account:acct").length === 1, "the first claim");
    expect(live("account:acct").map((c) => c.task_id)).toEqual([first]);
    expect(attemptsOf(first)[0]).toMatchObject({ state: "held", account_key: "account:acct", account_source: "declared" });

    // The second start routed, found the account full and re-parked without spending a wake.
    await until(() => built.tasks.get(second)?.state === "WAITING_RESOURCE", "the second to wait");
    const [queued] = attemptsOf(second);
    expect(queued).toMatchObject({ state: "queued", dispatch_id: null, account_key: "account:acct", routing_decision_id: expect.any(Number) });
    const wait = s.condition(second)!;
    expect(wait).toMatchObject({ state: "active", kind: "resource", resource: "account:acct", autoWakes: 0 });
    expect(db.prepare("SELECT attempt_id FROM wait_conditions WHERE task_id = ? AND generation = ?").get(second, wait.generation)).toEqual({ attempt_id: queued!.attempt_id });
    expect(s.dispatches(second)).toEqual([expect.objectContaining({ phase: "reparked", reason: "resource_wait" })]);
    // A timer wake of that wait does not consume it: only the pass grants it, and nothing is free.
    await s.tick(); await drain();
    expect(s.condition(second)).toMatchObject({ generation: wait.generation, state: "active" });
    expect(attemptsOf(second)).toHaveLength(1);
    expect(await s.grantPass()).toEqual([]);

    // The first runs and finishes: its claim is released at the end of its stream and the pass grants the second.
    g.open(first);
    await until(() => live("account:acct").some((c) => c.task_id === second), "G grants the second");
    expect(attemptsOf(first)[0]).toMatchObject({ state: "settled", exit_proof: "unscoped_exit" });
    const [granted] = attemptsOf(second);
    const dispatches = s.dispatches(second);
    expect(dispatches).toHaveLength(2);
    // G's dispatch carries the route the attempt waited for; the attempt is the one that queued.
    expect(dispatches[1]).toMatchObject({ phase: "reserved", routing_decision_id: queued!.routing_decision_id });
    expect(granted).toMatchObject({ state: "held", attempt_id: queued!.attempt_id, queue_key: queued!.queue_key, dispatch_id: dispatches[1]!.dispatch_id });
    expect(live("account:acct")).toEqual([{ task_id: second, attempt_id: queued!.attempt_id, dispatch_id: dispatches[1]!.dispatch_id }]);
    expect(s.condition(second)).toMatchObject({ generation: wait.generation, state: "consumed", consumedBy: "grant" });

    // Through provider entry on the waited-for route, then released at the end of its stream.
    g.open(second);
    await until(() => s.dispatches(second)[1]?.phase === "started" && live("account:acct").length === 0, "the second to run and release");
    expect(attemptsOf(second)).toEqual([expect.objectContaining({ attempt_id: queued!.attempt_id, state: "settled" })]);
  });

  it("a limit of 2 admits two and queues the third in arrival order", async () => {
    await boot({ harness: true, limit: 2 });
    const g = gate(); const s = scheduler(g.boundary);
    const ids = [waiting(s), waiting(s), waiting(s)];
    for (const id of ids) g.hold(id);
    await s.tick(); await drain();
    await until(() => live("account:acct").length === 2 && built.tasks.get(ids[2]!)?.state === "WAITING_RESOURCE", "two admitted, one waiting");
    expect(live("account:acct").map((c) => c.task_id).sort()).toEqual([ids[0], ids[1]].sort());
    g.open(ids[0]!);
    await until(() => live("account:acct").some((c) => c.task_id === ids[2]), "the third granted");
    expect(live("account:acct").map((c) => c.task_id).sort()).toEqual([ids[1], ids[2]].sort());
    for (const id of ids.slice(1)) g.open(id);
    await until(() => live("account:acct").length === 0, "all released");
  });

  it("a cancel of a waiting task drops its queued attempt and the account frees nothing it never held", async () => {
    await boot({ harness: true });
    const g = gate(); const s = scheduler(g.boundary);
    const first = waiting(s); const second = waiting(s);
    g.hold(first);
    await s.tick(); await drain();
    await until(() => built.tasks.get(second)?.state === "WAITING_RESOURCE", "the second to wait");
    await s.cancel(second); await s.tick(); await drain();
    expect(attemptsOf(second)).toEqual([expect.objectContaining({ state: "dropped", exit_proof: "never_entered" })]);
    expect(live("account:acct").map((c) => c.task_id)).toEqual([first]);
    g.open(first);
    await until(() => live("account:acct").length === 0, "the first released");
    expect(attemptsOf(second)).toHaveLength(1);
  });
});

describe("Harness only (packet 2.2, itay 2026-11-24)", () => {
  it("refuses an account requirement on the legacy path: no claim, no provider call, the task needs the operator", async () => {
    await boot({ harness: false });
    const s = scheduler();
    const start = vi.spyOn(built.registry.adapter(A), "start");
    const startB = vi.spyOn(built.registry.adapter(B), "start");
    const id = waiting(s);
    await s.tick(); await drain();
    await until(() => built.tasks.get(id)?.state === "WAITING_INPUT", "the refusal");
    expect(built.tasks.get(id)).toMatchObject({ state: "WAITING_INPUT", pause_kind: "intervention_required" });
    expect(start).not.toHaveBeenCalled(); expect(startB).not.toHaveBeenCalled();
    expect(live("account:acct")).toEqual([]);
    expect(attemptsOf(id)).toEqual([expect.objectContaining({ state: "dropped", exit_proof: "never_entered" })]);
    expect(s.dispatches(id)).toEqual([expect.objectContaining({ phase: "reparked", reason: "account_requires_harness" })]);
    // The schema refuses a legacy account claim whatever code tries to write one.
    expect(() => db.prepare("INSERT INTO resource_claims (attempt_id, task_id, resource, units, claimed_at) VALUES (?, ?, 'account:acct', 1, 't')")
      .run(attemptsOf(id)[0]!.attempt_id, id)).toThrow(/account claim requires a Harness owner attempt/);
  });
});

describe("a pool and an account together (packet 2.5.1)", () => {
  it("grants both or neither: a free pool is not taken by an attempt the account blocks", async () => {
    await boot({ harness: true, resources: { gpu: 2 } });
    const g = gate(); const s = scheduler(g.boundary);
    const first = waiting(s, "gpu"); const second = waiting(s, "gpu");
    g.hold(first); g.hold(second);
    await s.tick(); await drain();
    await until(() => built.tasks.get(second)?.state === "WAITING_RESOURCE" && attemptsOf(second)[0]?.routing_decision_id !== null, "the second to wait on the account");
    // The pool has a free unit, but the second holds neither the pool nor the account.
    expect(live("gpu").map((c) => c.task_id)).toEqual([first]);
    expect(live("account:acct").map((c) => c.task_id)).toEqual([first]);
    expect(s.condition(second)).toMatchObject({ resource: "gpu" });
    g.open(first);
    await until(() => live("gpu").some((c) => c.task_id === second) && live("account:acct").some((c) => c.task_id === second), "both granted together");
    expect(live("gpu").map((c) => c.task_id)).toEqual([second]);
    g.open(second);
    await until(() => live("gpu").length === 0 && live("account:acct").length === 0, "both released");
  });
});

describe("an account attempt without a unit (packet 2.6.1)", () => {
  it("is never settled by a weak proof: at stream end it waits for a strong proof or the operator, its claim held", async () => {
    await boot({ harness: true, unscoped: true });
    configureExitProofs(db, { watchMs: 5, stopEvidenceMs: 0 });
    const s = scheduler();
    const id = waiting(s);
    await s.tick(); await drain();
    await until(() => attemptsOf(id)[0]?.state === "ambiguous", "the attempt to wait for a proof");
    expect(attemptsOf(id)[0]).toMatchObject({ exit_proof: null, account_key: "account:acct" });
    expect(live("account:acct").map((c) => c.task_id)).toEqual([id]);
    // The session settled normally: the terminal transaction did not trip trg_attempt_weak_proof.
    await until(() => built.tasks.get(id)?.state === "COMPLETED", "the task to complete");
    expect(db.prepare("SELECT type FROM scheduler_events WHERE task_id = ? AND type = 'attempt.stop_unconfirmed'").all(id)).toHaveLength(1);
  });
});
