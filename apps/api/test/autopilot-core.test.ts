/**
 * P0-2 (docs/agentic-os-auto-copilot-plan.md §C.2): the autopilot core, with the fake provider.
 *
 * G2 (no provider start without both checks; parallel refused), G4 (stopped / closed window
 * refused before any adapter call), G5 and G7 (a window cut suspends; the next window charges
 * once), G6 (one budget across an attempt's sessions), G9 (a denied approval blocks), G19 (the
 * final check, after provisioning), G22 (each refusal reason: no claim leak, `autoWakes`
 * untouched, the right wait), G24 (one attempt, one task; a final attempt's task never launches)
 * and G27 (composition is a prerequisite; the start names the missing setting).
 *
 * Picking and reserving work (P0-6), acceptance (P0-4), publications (P0-5) and the host probes
 * (P0-3) are later slices: attempts here are made with `reserve` + `admit` directly, and the
 * host gate is an injected function.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantId, ExecutionPolicy } from "@agent-plane/core";
import { AGENT_USER_DEFAULTS } from "../src/config.js";
import { AutopilotLaunchRefused, AutopilotStartRefused } from "../src/modules/autopilot.js";
import { bootRig, reaches, type Rig, type RigOptions } from "./helpers/composer-cockpit.js";

const T0 = Date.parse("2030-01-01T23:00:00.000Z");
const MIN = 60_000;
const FAKE = "fake-claude" as AssistantId;
let rig: Rig | undefined;
let instant = T0;
const now = () => new Date(instant);
const at = (ms: number) => new Date(ms).toISOString();

afterEach(async () => {
  await rig?.close();
  rig = undefined;
  instant = T0;
});

interface Setup extends Pick<RigOptions, "requireRevision"> { hostGate?: () => { ok: true } | { ok: false; detail: string }; approvalMode?: "prompt-on-escalation"; autopilot?: Partial<Rig["config"]["autopilot"]> }

async function boot(setup: Setup = {}): Promise<Rig> {
  rig = await bootRig({
    now,
    requireRevision: setup.requireRevision ?? true,
    assistants: { "fake-claude": { provider: "fake", options: { agentUser: true } } },
    configure: (config) => {
      const tree = join(config.dir, "..", "aos");
      mkdirSync(join(tree, "worktrees"), { recursive: true });
      mkdirSync(join(tree, "profiles"), { recursive: true });
      chmodSync(join(tree, "profiles"), 0o2750); // what `setup/aos-setup` leaves: setgid, group-readable, closed to others
      config.execution.agentUser = { ...AGENT_USER_DEFAULTS, profilesRoot: join(tree, "profiles"), worktreesRoot: join(tree, "worktrees") };
      config.scheduler = { ...config.scheduler!, resources: { "oci-heavy": 1 } };
      if (setup.approvalMode) config.policy.approvalMode = setup.approvalMode;
      Object.assign(config.autopilot, setup.autopilot ?? {});
    },
    ...(setup.hostGate ? { autopilotHostGate: setup.hostGate } : {}),
  });
  return rig;
}

const ap = () => rig!.built.autopilot;
/** A window open now for `minutes`, a current attestation and a running autopilot. */
function open(minutes = 8 * 60, maxItems = 3) {
  const window = ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + minutes * MIN), maxItems }, "op_test");
  ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
  ap().start("op_test");
  return window;
}
let item = 0;
function admit(goal = "Ship the feature") {
  const reserved = ap().reserve({ itemId: `item-${++item}`, reservationId: `res-${item}`, reservationSha: "0".repeat(40) });
  const attempt = ap().admit(reserved.id, { goal, repoPath: rig!.repo });
  return { attemptId: attempt.id, taskId: attempt.taskId! };
}
const task = (id: string) => rig!.built.tasks.get(id)!;
const attempt = (id: string) => ap().attempt(id)!;
const runs = (taskId: string) => rig!.db.prepare("SELECT id, session_state, execution_request_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(taskId) as Array<{ id: string; session_state: string; execution_request_id: string }>;
const pool = () => rig!.built.scheduler.pools().find((p) => p.resource === "oci-heavy")!;
const wait = (taskId: string) => rig!.built.scheduler.condition(taskId)!;
const parked = (taskId: string) => rig!.built.scheduler.events(taskId).filter((e) => e.type === "autopilot.parked").map((e) => e.payload);
const charges = () => rig!.db.prepare("SELECT window_id, attempt_id FROM autopilot_window_charges ORDER BY charged_at").all() as Array<{ window_id: string; attempt_id: string }>;
const runtimeRows = (attemptId: string) => rig!.db.prepare("SELECT session_id, ms FROM autopilot_runtime WHERE attempt_id = ?").all(attemptId) as Array<{ session_id: string; ms: number }>;
const policyOf = (requestId: string) => JSON.parse((rig!.db.prepare("SELECT policy FROM execution_requests WHERE id = ?").get(requestId) as { policy: string }).policy) as ExecutionPolicy;
const sessionNotes = (sessionId: string) => (rig!.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'phase' ORDER BY seq").all(sessionId) as Array<{ payload: string }>)
  .map((r) => JSON.parse(r.payload) as { note?: string; reason?: string; remainingMs?: number; admittedMs?: number }).filter((p) => p.note?.startsWith("launch_"));
const profiles = () => readdirSync(rig!.config.execution.agentUser!.profilesRoot);
/**
 * One scheduler sweep, then the first of `states` the task is PUT in after it. A task that is
 * already in one of them must be moved there again (a refused launch parks it afresh), so the
 * state it sits in beforehand never satisfies this.
 */
async function sweep(taskId: string, states: readonly string[]) {
  const moved = new Promise<string>((resolve) => {
    const off = rig!.built.bus.subscribe(taskId, (p) => {
      if (p.kind === "state" && states.includes(p.state!.state)) { off(); resolve(p.state!.state); }
    });
  });
  await rig!.built.scheduler.tick();
  return moved;
}
const sessionState = (taskId: string) => runs(taskId).at(-1)?.session_state;
const SETTLED = ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"] as const;

describe("autopilot start (G27)", () => {
  it("refuses, naming the setting, when a prerequisite is off, and changes nothing", async () => {
    await boot({ requireRevision: false });
    expect(() => ap().start("op_test")).toThrow(AutopilotStartRefused);
    try { ap().start("op_test"); } catch (err) { expect((err as AutopilotStartRefused).setting).toBe("composer.requireRevision"); }
    expect(ap().status()).toMatchObject({ status: "stopped", stopReason: "never-started" });

    rig!.config.composer.requireRevision = true;
    rig!.config.execution.harnessModes.single = false;
    try { ap().start("op_test"); } catch (err) { expect((err as AutopilotStartRefused).setting).toBe("execution.harnessModes.single"); }
    rig!.config.execution.harnessModes.single = true;
    rig!.config.scheduler!.resources = {};
    try { ap().start("op_test"); } catch (err) { expect((err as AutopilotStartRefused).setting).toBe("scheduler.resources.oci-heavy"); }
    expect(ap().status().status).toBe("stopped");
  });

  it("starts when every prerequisite holds, and a stop is always possible", async () => {
    await boot();
    expect(ap().start("op_test")).toMatchObject({ status: "running", startedBy: "op_test", settings: [] });
    expect(ap().stop("drain").status).toMatchObject({ status: "draining", stopReason: "drain" });
    expect(ap().stop("now").status).toMatchObject({ status: "stopped", stopReason: "operator" });
  });
});

describe("one attempt end to end", () => {
  it("launches as the agent user under a recomputed deadline, charges the window once and settles", async () => {
    await boot();
    const window = open();
    const { attemptId, taskId } = admit();
    expect(task(taskId)).toMatchObject({ state: "WAITING_RESOURCE", run_as: "agent" });
    expect(attempt(attemptId)).toMatchObject({ state: "admitted", attemptNo: 1, runtimeUsedMs: 0 });

    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    const [run] = runs(taskId);
    expect(runs(taskId)).toHaveLength(1);
    // The attempt had its whole 90 min budget left; the workspace's own 30 min session bound is
    // tighter, and the final check only ever tightens.
    const policy = policyOf(run!.execution_request_id);
    expect(policy.runAs).toBe("agent");
    expect(policy.timeout.hardMs).toBe(30 * MIN);
    expect(sessionNotes(run!.id)).toEqual([expect.objectContaining({ note: "launch_admitted", admittedMs: 90 * MIN })]);
    expect(sessionNotes(run!.id)[0]!.remainingMs).toBeLessThanOrEqual(30 * MIN);
    expect(attempt(attemptId)).toMatchObject({ state: "settled", deadlineBound: "budget", deadlineAt: at(instant + 90 * MIN) });
    expect(charges()).toEqual([{ window_id: window.id, attempt_id: attemptId }]);
    expect(runtimeRows(attemptId)).toHaveLength(1);
    expect(pool().claimedUnits).toBe(0);
    // `settled` is non-final: the loop is held until acceptance and publication exist (invariant 1).
    expect(() => ap().reserve({ itemId: "item-next", reservationId: "res-next" })).toThrow(/one attempt at a time/);
  });

  it("bounds the session by the window when the window closes first", async () => {
    await boot();
    open(30);
    const { attemptId, taskId } = admit();
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    // 30 min window, 2 min grace: 28 min, not the 90 min budget.
    expect(policyOf(runs(taskId)[0]!.execution_request_id).timeout.hardMs).toBe(28 * MIN);
    expect(attempt(attemptId)).toMatchObject({ deadlineBound: "window", deadlineAt: at(instant + 28 * MIN) });
  });
});

describe("typed refusals at the early check (G4, G22)", () => {
  /** Three sweeps of a refused launch: nothing leaks and nothing counts as an automatic wake. */
  async function refusedSweeps(taskId: string, state: string) {
    expect(await sweep(taskId, [state])).toBe(state);
    // Later sweeps: a hold has no wait to fire; a time wait is not due. Neither may leak or count.
    for (let i = 0; i < 2; i++) {
      instant += 61_000;
      await rig!.built.scheduler.tick();
      await new Promise((r) => setTimeout(r, 50));
      expect(task(taskId).state).toBe(state);
    }
    expect(runs(taskId)).toHaveLength(0);
    expect(pool().claimedUnits).toBe(0);
    expect(wait(taskId).autoWakes).toBe(0);
    expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)).toEqual({ n: 0 });
  }

  it("stopped: holds in WAITING_INPUT with the reason, and release puts it back in the queue", async () => {
    await boot();
    open();
    ap().stop("now");
    const { attemptId, taskId } = admit();
    await refusedSweeps(taskId, "WAITING_INPUT");
    expect(task(taskId).pause_kind).toBe("intervention_required");
    expect(parked(taskId)).toEqual([expect.objectContaining({ reason: "stopped", park: "hold" })]);
    expect(attempt(attemptId)).toMatchObject({ state: "admitted", reason: "stopped" });
    expect(ap().heldReason(taskId)).toBe("stopped");

    // Releasing while it is still stopped parks it again: release never launches.
    expect(ap().release()).toEqual({ taskId, reason: "stopped" });
    expect(task(taskId).state).toBe("WAITING_RESOURCE");
    expect(await sweep(taskId, ["WAITING_INPUT"])).toBe("WAITING_INPUT");
    expect(runs(taskId)).toHaveLength(0);

    ap().start("op_test");
    ap().release();
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    expect(attempt(attemptId).state).toBe("settled");
  });

  it("window_closed: waits for the next opening, and holds when no window is on record", async () => {
    await boot();
    ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap().start("op_test");
    const { attemptId, taskId } = admit();
    // No window at all: there is no time to wait until.
    expect(await sweep(taskId, ["WAITING_INPUT"])).toBe("WAITING_INPUT");
    expect(parked(taskId).at(-1)).toMatchObject({ reason: "window_closed", park: "hold" });

    const next = ap().addWindow({ opensAt: at(instant + 60 * MIN), closesAt: at(instant + 9 * 60 * MIN) }, "op_test");
    ap().release();
    await refusedSweeps(taskId, "WAITING_RESOURCE");
    expect(parked(taskId).at(-1)).toMatchObject({ reason: "window_closed", park: "time", notBefore: next.opensAt });
    expect(wait(taskId)).toMatchObject({ state: "active", kind: "resource", resource: "oci-heavy", notBefore: next.opensAt });
    expect(attempt(attemptId).state).toBe("admitted");

    instant = Date.parse(next.opensAt) + 1000;
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    expect(charges()).toEqual([{ window_id: next.id, attempt_id: attemptId }]);
  });

  it("window_closed: less than minSliceMs left, and a window whose count is used", async () => {
    await boot();
    open(9); // 9 minutes left, below the 10 minute slice
    const first = admit();
    expect(await sweep(first.taskId, ["WAITING_INPUT"])).toBe("WAITING_INPUT");
    expect(parked(first.taskId)[0]).toMatchObject({ reason: "window_closed", detail: expect.stringContaining("minSliceMs") });
    expect(runs(first.taskId)).toHaveLength(0);
  });

  it("billing_expired: holds until a current attestation exists", async () => {
    await boot();
    ap().addWindow({ opensAt: at(instant - MIN), closesAt: at(instant + 8 * 60 * MIN) }, "op_test");
    ap().start("op_test");
    const { taskId } = admit();
    await refusedSweeps(taskId, "WAITING_INPUT");
    expect(parked(taskId)[0]).toMatchObject({ reason: "billing_expired", park: "hold" });
    // An attestation that says extra usage is ON admits nothing either.
    ap().attest({ extraUsageOff: false, autoReloadOff: true }, "op_test");
    ap().release();
    expect(await sweep(taskId, ["WAITING_INPUT"])).toBe("WAITING_INPUT");
    ap().attest({ extraUsageOff: true, autoReloadOff: true }, "op_test");
    ap().release();
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
  });

  it("host_busy: a two-minute time wait, also when the gate is unreadable", async () => {
    let gate: () => { ok: true } | { ok: false; detail: string } = () => ({ ok: false, detail: "load 3.2" });
    await boot({ hostGate: () => gate() });
    open();
    const { taskId } = admit();
    const before = instant;
    expect(await sweep(taskId, ["WAITING_RESOURCE"])).toBe("WAITING_RESOURCE");
    expect(parked(taskId)[0]).toMatchObject({ reason: "host_busy", park: "time", notBefore: at(before + 2 * MIN), detail: "load 3.2" });
    gate = () => { throw new Error("cgroup.events: EACCES"); };
    instant += 2 * MIN + 1000;
    expect(await sweep(taskId, ["WAITING_RESOURCE"])).toBe("WAITING_RESOURCE");
    expect(parked(taskId).at(-1)).toMatchObject({ reason: "host_busy", detail: expect.stringContaining("unreadable") });
    expect(runs(taskId)).toHaveLength(0);
    expect(pool().claimedUnits).toBe(0);
    expect(wait(taskId).autoWakes).toBe(0);
    gate = () => ({ ok: true });
    instant += 2 * MIN + 1000;
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
  });

  it("composition_unavailable: Cockpit's bundle service down starts zero providers (G27)", async () => {
    await boot();
    open();
    await rig!.cockpit.close();
    const { attemptId, taskId } = admit();
    await refusedSweeps(taskId, "WAITING_INPUT");
    expect(parked(taskId)[0]).toMatchObject({ reason: "composition_unavailable", park: "hold" });
    expect(attempt(attemptId)).toMatchObject({ state: "admitted", reason: "composition_unavailable" });
  });

  it("budget_exhausted: the attempt fails and its task ends with it", async () => {
    await boot();
    open();
    const { attemptId, taskId } = admit();
    rig!.db.prepare("INSERT INTO autopilot_runtime(session_id, attempt_id, ms, recorded_at) VALUES('s-earlier', ?, ?, ?)").run(attemptId, 90 * MIN, at(instant));
    expect(await sweep(taskId, SETTLED)).toBe("FAILED");
    expect(parked(taskId)[0]).toMatchObject({ reason: "budget_exhausted", park: "fail" });
    expect(attempt(attemptId)).toMatchObject({ state: "failed", reason: "budget_exhausted" });
    expect(runs(taskId)).toHaveLength(0);
    expect(pool().claimedUnits).toBe(0);
  });

  it("not_owner: a final attempt's task that still has a wait is cancelled, never launched (G24)", async () => {
    await boot();
    open();
    const { attemptId, taskId } = admit();
    // The state a crash could leave: the attempt made final, its task's wait still active.
    rig!.db.prepare("UPDATE autopilot_attempts SET state = 'blocked', final_at = ? WHERE id = ?").run(at(instant), attemptId);
    expect(await sweep(taskId, SETTLED)).toBe("CANCELLED");
    expect(parked(taskId)[0]).toMatchObject({ reason: "not_owner", park: "cancel" });
    expect(runs(taskId)).toHaveLength(0);
    expect(pool().claimedUnits).toBe(0);
    expect(attempt(attemptId).state).toBe("blocked");
  });
});

describe("the final check, after provisioning (G19)", () => {
  it("refuses at beforeProviderStart, starts no provider, disposes the profile and parks by the reason", async () => {
    let calls = 0;
    await boot({ hostGate: () => (++calls === 2 ? { ok: false, detail: "busy at the last moment" } : { ok: true }) });
    open();
    const { attemptId, taskId } = admit();
    const before = instant;
    expect(await sweep(taskId, ["WAITING_RESOURCE", ...SETTLED])).toBe("WAITING_RESOURCE");
    expect(calls).toBe(2); // early passed, final refused
    const [run] = runs(taskId);
    expect(run!.session_state).toBe("CANCELLED");
    expect(sessionNotes(run!.id)).toEqual([expect.objectContaining({ note: "launch_refused", reason: "host_busy" })]);
    // No provider event was ever recorded for the session: the adapter was not called.
    expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'run.started'").get(run!.id)).toEqual({ n: 0 });
    expect(profiles()).toEqual([]);
    expect(parked(taskId)[0]).toMatchObject({ reason: "host_busy", park: "time", notBefore: at(before + 2 * MIN) });
    expect(attempt(attemptId)).toMatchObject({ state: "admitted", reason: "host_busy" });
    expect(charges()).toEqual([]);
    expect(pool().claimedUnits).toBe(0);
    expect(wait(taskId).autoWakes).toBe(0);

    instant += 2 * MIN + 1000;
    expect(await sweep(taskId, SETTLED)).toBe("COMPLETED");
    expect(runs(taskId)).toHaveLength(2);
    expect(attempt(attemptId).state).toBe("settled");
    expect(charges()).toHaveLength(1);
  });

  it("a stop that lands during provisioning is seen by the final check", async () => {
    let calls = 0;
    await boot({ hostGate: () => { if (++calls === 1) ap().stop("drain"); return { ok: true }; } });
    open();
    const { attemptId, taskId } = admit();
    expect(await sweep(taskId, SETTLED)).toBe("WAITING_INPUT");
    expect(sessionNotes(runs(taskId)[0]!.id)).toEqual([expect.objectContaining({ note: "launch_refused", reason: "stopped" })]);
    expect(parked(taskId)[0]).toMatchObject({ reason: "stopped", park: "hold" });
    expect(attempt(attemptId)).toMatchObject({ state: "admitted", reason: "stopped" });
    expect(charges()).toEqual([]);
    expect(profiles()).toEqual([]);
    expect(pool().claimedUnits).toBe(0);
  });

  it("recomputes the deadline on every check, so a later launch never reuses an earlier one", async () => {
    await boot();
    open();
    const { attemptId, taskId } = admit();
    // No claim yet: the check refuses with the typed error rather than a deadline.
    expect(() => ap().launchCheck(taskId, "dispatch_x", "early", { composed: true })).toThrow(AutopilotLaunchRefused);
    rig!.db.prepare("INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,execution_path,phase,created_at,updated_at) VALUES('dispatch_x',?,1,'wake','harness','started',?,?)").run(taskId, at(instant), at(instant));
    rig!.db.prepare("INSERT INTO resource_claims(task_id,dispatch_id,generation,resource,units,claimed_at) VALUES(?,?,?,?,?,?)").run(taskId, "dispatch_x", 1, "oci-heavy", 1, at(instant));
    expect(ap().launchCheck(taskId, "dispatch_x", "early", { composed: true })).toMatchObject({ remainingMs: 90 * MIN, bound: "budget" });
    rig!.db.prepare("INSERT INTO autopilot_runtime(session_id, attempt_id, ms, recorded_at) VALUES('s-earlier', ?, ?, ?)").run(attemptId, 60 * MIN, at(instant));
    instant += 7 * 60 * MIN + 40 * MIN; // 20 minutes of window left
    expect(ap().launchCheck(taskId, "dispatch_x", "early", { composed: true })).toMatchObject({ remainingMs: 18 * MIN, bound: "window", deadlineAtMs: instant + 18 * MIN });
    expect(() => ap().launchCheck(taskId, "dispatch_x", "early", { composed: false })).toThrow(/composition_unavailable/);
    expect(() => ap().launchCheck(taskId, "dispatch_other", "early", { composed: true })).toThrow(/not_owner/);
  });
});

describe("lifecycle invariants (G2, G24)", () => {
  it("allows one non-final attempt, one task per attempt, and bounds attempts per item", async () => {
    await boot();
    open();
    const first = ap().reserve({ itemId: "item-a", reservationId: "res-a1" });
    expect(() => ap().reserve({ itemId: "item-b", reservationId: "res-b1" })).toThrow(/one attempt at a time/);
    // The database refuses it too, whatever the caller.
    expect(() => rig!.db.prepare("INSERT INTO autopilot_attempts(id,item_id,attempt_no,reservation_id,state,runtime_budget_ms,created_at,updated_at) VALUES('x','item-b',1,'res-b1','reserving',1,'t','t')").run()).toThrow(/UNIQUE/);
    ap().external(first.id);
    expect(attempt(first.id).state).toBe("external");
    expect(() => rig!.db.prepare("UPDATE autopilot_attempts SET state = 'admitted' WHERE id = ?").run(first.id)).toThrow(/final autopilot attempt/);

    const second = ap().reserve({ itemId: "item-a", reservationId: "res-a2" });
    expect(second.attemptNo).toBe(2);
    expect(() => ap().reserve({ itemId: "item-a", reservationId: "res-a2" })).toThrow();
    const admitted = ap().admit(second.id, { goal: "Ship it", repoPath: rig!.repo });
    expect(() => ap().admit(second.id, { goal: "Ship it again", repoPath: rig!.repo })).toThrow(/not reserving/);
    expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    ap().stop("now");
    await sweep(admitted.taskId!, ["WAITING_INPUT"]);
    rig!.db.prepare("UPDATE autopilot_attempts SET state = 'failed', final_at = 't' WHERE id = ?").run(second.id);
    expect(() => ap().reserve({ itemId: "item-a", reservationId: "res-a3" })).toThrow(/used its 2 attempt/);
  });

  it("an admission that fails leaves the attempt reserving and no task behind", async () => {
    await boot();
    const reserved = ap().reserve({ itemId: "item-a", reservationId: "res-a1" });
    rig!.config.scheduler!.resources = {};
    expect(() => ap().admit(reserved.id, { goal: "Ship it", repoPath: rig!.repo })).toThrow(/Unknown resource pool/);
    expect(attempt(reserved.id)).toMatchObject({ state: "reserving" });
    expect(rig!.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
  });

  it("refuses an operator start, compare and race for an autopilot task", async () => {
    await boot();
    open();
    ap().stop("now"); // keep it parked so the routes are tried against a waiting task
    const { taskId } = admit();
    const started = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
    expect(started.statusCode).toBeGreaterThanOrEqual(400);
    await expect(rig!.built.orchestrator.startParallel(taskId, [FAKE, FAKE], "compare")).rejects.toThrow(/never runs in parallel/);
    await expect(rig!.built.orchestrator.startParallel(taskId, [FAKE, FAKE], "race")).rejects.toThrow(/never runs in parallel/);
    await expect(rig!.built.orchestrator.startTask(taskId, FAKE)).rejects.toThrow(/live resource claim/);
    expect(runs(taskId)).toHaveLength(0);
  });
});

describe("windows and the attempt budget (G5, G6, G7)", () => {
  it("a session cut by the window suspends the attempt, and the next window charges it once more", async () => {
    // The clock reaches the deadline (28 min in) right after the final check admitted the launch;
    // the session then ends unfinished.
    let calls = 0;
    await boot({ hostGate: () => { if (++calls === 2) queueMicrotask(() => { instant = T0 + 28 * MIN; }); return { ok: true }; } });
    const first = open(30);
    const second = ap().addWindow({ opensAt: at(T0 + 24 * 60 * MIN), closesAt: at(T0 + 32 * 60 * MIN) }, "op_test");
    const { attemptId, taskId } = admit("Ship the feature [FAKE:FAIL]");
    expect(await sweep(taskId, ["WAITING_RESOURCE", ...SETTLED])).toBe("WAITING_RESOURCE");
    expect(attempt(attemptId)).toMatchObject({ state: "suspended", reason: "window_closed" });
    expect(parked(taskId)[0]).toMatchObject({ reason: "window_closed", park: "time", notBefore: second.opensAt });
    // The runner keeps its own (real) clock in this rig, so the row's value is not 28 min here;
    // what matters is one row for the one session, written once.
    expect(runtimeRows(attemptId).map((r) => r.session_id)).toEqual([runs(taskId)[0]!.id]);
    expect(charges()).toEqual([{ window_id: first.id, attempt_id: attemptId }]);
    expect(pool().claimedUnits).toBe(0);

    // Nothing runs in the day.
    instant = T0 + 12 * 60 * MIN;
    await rig!.built.scheduler.tick();
    expect(runs(taskId)).toHaveLength(1);

    // The next night: resumed, charged in that window, with the budget that is left (90 − 28).
    instant = Date.parse(second.opensAt) + 1000;
    await sweep(taskId, SETTLED);
    expect(runs(taskId)).toHaveLength(2);
    expect(charges()).toEqual([{ window_id: first.id, attempt_id: attemptId }, { window_id: second.id, attempt_id: attemptId }]);
    const used = runtimeRows(attemptId).find((r) => r.session_id === runs(taskId)[0]!.id)!.ms;
    expect(sessionNotes(runs(taskId)[1]!.id)[0]).toMatchObject({ note: "launch_admitted", admittedMs: 90 * MIN - used });
  });

  it("a stop now cancels a running attempt's session and the attempt", async () => {
    await boot({ approvalMode: "prompt-on-escalation" });
    open();
    const { attemptId, taskId } = admit("Ship the feature [FAKE:APPROVAL]");
    await rig!.built.scheduler.tick();
    await expect.poll(() => sessionState(taskId)).toBe("AWAITING_APPROVAL"); // paused: the session is live
    expect(attempt(attemptId).state).toBe("running");
    const res = await rig!.built.app.inject({ method: "POST", url: "/api/autopilot/stop", headers: rig!.auth(), payload: { mode: "now" } });
    expect(res.statusCode).toBe(200);
    expect(await reaches(rig!.built, taskId, ["CANCELLED"])).toBe("CANCELLED");
    expect(attempt(attemptId)).toMatchObject({ state: "cancelled", reason: "stop: operator" });
    expect(ap().status()).toMatchObject({ status: "stopped", attempt: null });
  });
});

describe("approvals in an unattended run (G9)", () => {
  it("a denial blocks the attempt and cancels the session instead of letting the provider continue", async () => {
    await boot({ approvalMode: "prompt-on-escalation" });
    open();
    const { attemptId, taskId } = admit("Ship the feature [FAKE:APPROVAL]");
    await rig!.built.scheduler.tick();
    await expect.poll(() => sessionState(taskId)).toBe("AWAITING_APPROVAL");
    expect(pool().claimedUnits).toBe(1); // the slot is held while paused
    const pending = rig!.db.prepare("SELECT provider_request_id FROM approvals WHERE session_id = ?").get(runs(taskId)[0]!.id) as { provider_request_id: string };
    await rig!.built.orchestrator.respondApproval(taskId, pending.provider_request_id, false);
    expect(await reaches(rig!.built, taskId, ["CANCELLED", "COMPLETED", "FAILED"])).toBe("CANCELLED");
    expect(attempt(attemptId)).toMatchObject({ state: "blocked", reason: "approval denied" });
    expect(runs(taskId)[0]!.session_state).toBe("CANCELLED");
    // No later launch: nothing waits, nothing is reserved, and the slot is back.
    instant += 5 * MIN;
    await rig!.built.scheduler.tick();
    expect(runs(taskId)).toHaveLength(1);
    expect(existsSync(rig!.repo)).toBe(true);
    await expect.poll(() => pool().claimedUnits).toBe(0);
  });
});
