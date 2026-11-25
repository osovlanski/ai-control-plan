import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { HarnessBridge } from "../src/modules/harness/control-plane-bridge.js";
import { buildServer } from "../src/server.js";

const A = "fake-a";
const B = "fake-b";
const C = "fake-c";
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
});

async function boot({ harness = false, pool = false, third = false, goal = "Wait for approval [FAKE:APPROVAL]" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "handoff-review-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" }, ...(third ? { [C]: { provider: "fake" } } : {}) };
  config.execution.harnessModes.single = harness;
  config.policy.approvalMode = "prompt-on-escalation";
  config.scheduler = { ...config.scheduler, enabled: true, resources: pool ? { gpu: 1 } : {} };
  const db = openDb(config.dbPath);
  const server = buildServer({ config, db });
  cleanup = async () => {
    try {
      await server.orchestrator.shutdown();
      await server.app.close();
    } finally {
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  };

  server.registry.init();
  await server.registry.syncAll();
  const credential = readCredential(credentialPath(config.dir));
  const headers = { authorization: `Bearer ${credential.secrets[0]!.secret}` };
  const post = (url: string, payload: object = {}) => server.app.inject({ method: "POST", url, headers, payload });
  const created = await post("/api/tasks", { goal });
  expect(created.statusCode).toBe(201);
  const { taskId } = created.json<{ taskId: string }>();
  const action = (name: string, body?: object) => post(`/api/tasks/${taskId}/${name}`, body);
  const handoff = () => action("handoff", { to: B });
  const setTarget = async (enabled: boolean, id: string = B) => {
    const response = await post(`/api/assistants/${id}/${enabled ? "enable" : "disable"}`);
    expect(response.statusCode).toBe(200);
  };
  const start = async () => {
    const response = await action("start", { assistantId: A });
    expect(response.statusCode).toBe(200);
    return response.json<{ runId: string }>().runId;
  };
  const state = () => server.tasks.get(taskId)!;
  const active = () => server.orchestrator.isActive(taskId);
  const parkThenEnable = async () => {
    await setTarget(false);
    const refused = await handoff();
    expect(refused.statusCode).toBe(409);
    expect(state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "no_candidate" });
    await setTarget(true);
  };
  /** The handoff park a refused handoff leaves (`Scheduler.parkHandoff`), with its anchor's run. */
  const park = () => db.prepare(`SELECT w.generation, w.checkpoint_id, w.continuation, c.run_id FROM wait_conditions w
    LEFT JOIN checkpoints c ON c.id = w.checkpoint_id
    WHERE w.task_id = ? AND w.created_by = 'handoff' AND w.state = 'expired'`).get(taskId) as
    { generation: number; checkpoint_id: string | null; continuation: string | null; run_id: string | null } | undefined;
  const handoffRows = () => db.prepare("SELECT from_run_id, to_run_id, checkpoint_id, trigger FROM handoffs WHERE task_id = ? ORDER BY rowid")
    .all(taskId) as Array<{ from_run_id: string | null; to_run_id: string | null; checkpoint_id: string | null; trigger: string }>;
  const states = () => {
    const seen: string[] = [];
    const off = server.bus.subscribe(taskId, (frame) => {
      if (frame.kind === "state" && frame.state) seen.push(frame.state.state);
    });
    return { seen, off };
  };
  return { config, db, server, taskId, action, handoff, setTarget, start, state, active, parkThenEnable, park, handoffRows, states };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("a refused overlapping handoff parks a successor whose legacy start is pending", async () => {
  const t = await boot();
  await t.start();
  const adapter = t.server.registry.adapter(B);
  const start = adapter.start.bind(adapter);
  const entered = signal();
  const release = signal();
  vi.spyOn(adapter, "start").mockImplementationOnce(async (spec) => {
    entered.resolve();
    await release.promise;
    return start(spec);
  });
  const first = t.handoff();
  try {
    await entered.promise;
    await t.setTarget(false);
    expect((await t.handoff()).statusCode).toBe(409);
  } finally {
    release.resolve();
    await first;
  }
  expect((await first).statusCode).toBe(200);
  expect(t.active()).toBe(true);
  expect(t.state().state, "A live successor must remain RUNNING").toBe("RUNNING");
});

it("a rejected cancel acknowledgment suppresses late legacy settlement", async () => {
  const t = await boot();
  await t.start();
  const adapter = t.server.registry.adapter(A);
  const cancel = adapter.cancel.bind(adapter);
  vi.spyOn(adapter, "cancel").mockImplementationOnce(async (handle) => {
    await cancel(handle);
    throw new Error("cancel acknowledgment failed");
  });
  const response = await t.handoff();
  expect(response.json().error).toContain("cancel acknowledgment failed");
  await vi.waitFor(() => expect(t.active()).toBe(false));
  expect(t.state().state, "A drained source must leave RUNNING after cancellation throws").not.toBe("RUNNING");
});

it("a failed Harness handoff checkpoint strands the drained task", async () => {
  const t = await boot({ harness: true });
  await t.start();
  t.db.exec(`CREATE TRIGGER reject_handoff_checkpoint BEFORE INSERT ON checkpoints
    WHEN NEW.reason = 'handoff' BEGIN SELECT RAISE(ABORT, 'checkpoint store unavailable'); END`);
  const response = await t.handoff();
  expect(response.json().error).toContain("checkpoint store unavailable");
  expect(t.active()).toBe(false);
  expect(t.state().state, "A failed handoff checkpoint must leave the drained task out of RUNNING").not.toBe("RUNNING");
});

it("a refused handoff and a terminal Harness callback both publish settlement", async () => {
  const t = await boot({ harness: true, goal: "Finish the fake run" });
  await t.setTarget(false);
  const terminal = signal();
  const release = signal();
  const settled = signal();
  const start = HarnessBridge.prototype.start;
  vi.spyOn(HarnessBridge.prototype, "start").mockImplementationOnce(function (this: HarnessBridge, input, onSettled) {
    return start.call(this, input, async (result, sessionId) => {
      terminal.resolve();
      await release.promise;
      try { await onSettled(result, sessionId); } finally { settled.resolve(); }
    });
  });
  await t.start();
  await terminal.promise;
  const events: string[] = [];
  const off = t.server.bus.subscribe(t.taskId, (frame) => {
    if (frame.kind === "state" && frame.state) events.push(frame.state.state);
  });
  try {
    expect(t.active()).toBe(false);
    expect((await t.handoff()).statusCode).toBe(409);
  } finally {
    release.resolve();
    await settled.promise;
    off();
  }
  const settlements = events.filter((state) => state === "WAITING_INPUT" || state === "COMPLETED");
  expect(settlements, "Exactly one owner must publish settlement of the Harness source").toHaveLength(1);
});

it("run-now cannot resume a no_candidate task after its target becomes eligible", async () => {
  const t = await boot();
  await t.start();
  await t.parkThenEnable();
  const response = await t.action("run-now");
  expect(response.json().outcome, "Run-now must dispatch the parked task").toBe("dispatched");
  expect(t.active()).toBe(true);
});

it("blocked recomposition on retry retains the obsolete no_candidate pause", async () => {
  const t = await boot();
  await t.start();
  await t.parkThenEnable();
  vi.spyOn(t.server.orchestrator, "recompose").mockResolvedValueOnce({
    kind: "blocked", reason: "composer_error", pauseKind: "intervention_required",
  });
  const response = await t.handoff();
  expect(response.json().error).toContain("composer_error");
  expect(t.state().pause_kind, "The pause must reflect the retry's composition block").toBe("intervention_required");
});

it("a successful Harness handoff retry loses the source checkpoint provenance", async () => {
  const t = await boot({ harness: true });
  const source = await t.start();
  await t.parkThenEnable();
  const response = await t.handoff();
  expect(response.statusCode).toBe(200);
  const envelope = t.db.prepare("SELECT from_assistant_id, source_session_id FROM handoff_envelopes WHERE task_id = ?").get(t.taskId);
  expect(envelope, "The retry envelope must identify the original assistant and session")
    .toEqual({ from_assistant_id: A, source_session_id: source });
});

it("an expired pool continuation is reported as a deferred handoff", async () => {
  const t = await boot({ pool: true });
  const wait = await t.action("wait", { kind: "resource", resource: "gpu", units: 1, reason: "needs a slot" });
  expect(wait.statusCode).toBe(200);
  expect((await t.action("run-now")).json().outcome).toBe("dispatched");
  expect(t.active()).toBe(true);
  t.config.scheduler!.resources = {};
  const response = await t.action("handoff");
  expect(t.server.scheduler.condition(t.taskId)?.state).toBe("expired");
  expect(t.state().pause_kind).toBe("intervention_required");
  expect(response.json().deferred, "An expired resource wait must not be reported as deferred").not.toBe("resource");
});

// HO-20261119-6 H1: run-now consumes the park while a handoff retry is inside recompose.
it("a handoff retry that lost its park to run-now leaves the run-now successor RUNNING", async () => {
  const t = await boot();
  await t.start();
  await t.parkThenEnable();
  const recompose = t.server.orchestrator.recompose.bind(t.server.orchestrator);
  const entered = signal();
  const release = signal();
  vi.spyOn(t.server.orchestrator, "recompose").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return recompose(...args);
  });
  const retry = t.handoff();
  try {
    await entered.promise;
    expect((await t.action("run-now")).json().outcome).toBe("dispatched");
  } finally {
    release.resolve();
  }
  expect((await retry).statusCode).toBe(409);
  expect(t.active()).toBe(true);
  expect(t.state().state, "A retry that no longer owns the park must not touch the run-now successor").toBe("RUNNING");
}, 30_000);

// HO-20261119-6 H2: the durable cancel write throws after the settlement was marked plane-owned.
it("a Harness handoff whose cancel write throws leaves settlement to the source", async () => {
  const t = await boot({ harness: true });
  const source = await t.start();
  const cancel = vi.spyOn(HarnessBridge.prototype, "requestCancel").mockImplementationOnce(() => {
    throw new Error("cancel store unavailable");
  });
  const response = await t.handoff();
  expect(response.json().error).toContain("cancel store unavailable");
  (cancel.mock.contexts[0] as HarnessBridge).requestCancel(source);
  await vi.waitFor(() => expect(t.active()).toBe(false), { timeout: 10_000 });
  expect(t.state().state, "The source's own settlement must still move the task out of RUNNING").not.toBe("RUNNING");
}, 30_000);

// HO-20261119-6 H3: a pool wake reserved a dispatch and claim, then failed before provider start.
it("a refused pool handoff leaves no dispatch for a later tick to start", async () => {
  const t = await boot({ pool: true });
  expect((await t.action("wait", { kind: "resource", resource: "gpu", units: 1, reason: "needs a slot" })).statusCode).toBe(200);
  expect((await t.action("run-now")).json().outcome).toBe("dispatched");
  expect(t.active()).toBe(true);
  t.db.exec(`CREATE TRIGGER reject_routing BEFORE INSERT ON routing_decisions
    BEGIN SELECT RAISE(ABORT, 'routing store unavailable'); END`);
  const response = await t.action("handoff");
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("routing store unavailable");
  t.db.exec("DROP TRIGGER reject_routing");
  const open = () => t.db.prepare("SELECT phase FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").all(t.taskId);
  expect(open(), "The refused handoff's dispatch must be rolled back").toEqual([]);
  expect(t.server.scheduler.claim(t.taskId), "The refused handoff's claim must be released").toBeUndefined();
  expect(t.state()).toMatchObject({ state: "WAITING_INPUT" });
  await t.server.scheduler.tick();
  await new Promise((done) => setTimeout(done, 100));
  expect(t.active(), "No later tick may start the refused handoff's successor").toBe(false);
});

// Issue #209 (HO-20261119-6 follow-ups M1–M5, D2). Each test reproduces one interleaving.
type Drain = { handoffDrainMs: number };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// M1: the drain deadline started only once adapter.cancel() resolved.
it("a legacy cancel acknowledgment that never settles is bounded and releases the handoff lock", async () => {
  const t = await boot();
  await t.start();
  (t.server.orchestrator as unknown as Drain).handoffDrainMs = 300;
  const adapter = t.server.registry.adapter(A);
  const never = signal();
  vi.spyOn(adapter, "cancel").mockImplementationOnce(() => never.promise);
  try {
    const first = await Promise.race([t.handoff(), sleep(5_000).then(() => "hung" as const)]);
    expect(first, "A handoff whose cancel never acknowledges must return").not.toBe("hung");
    if (first === "hung") return;
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toContain("did not acknowledge");
    // Nothing drained, so the source keeps its run and its own settlement.
    expect(t.active()).toBe(true);
    expect(t.state().state).toBe("RUNNING");
    const second = await t.handoff();
    expect(second.statusCode, "The per-task handoff lock must be released").toBe(200);
    expect(second.json().assistantId).toBe(B);
  } finally {
    never.resolve();
  }
}, 30_000);

// M2: a Harness drain timeout bypassed parkHandoff, so a retry lost source_session_id.
it("a Harness drain timeout parks with the source's provenance, and the retry keeps it", async () => {
  const t = await boot({ harness: true });
  const source = await t.start();
  (t.server.orchestrator as unknown as Drain).handoffDrainMs = 300;
  const cancel = vi.spyOn(HarnessBridge.prototype, "requestCancel").mockImplementationOnce(() => true);
  const sse = t.states();
  const timedOut = await t.handoff();
  sse.off();
  expect(timedOut.statusCode).toBe(409);
  expect(timedOut.json().error).toContain("did not settle");
  expect(t.state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "harness_error" });
  expect(sse.seen.filter((s) => s === "WAITING_INPUT"), "The park is published exactly once").toHaveLength(1);
  expect(t.park(), "A drain timeout leaves a handoff park anchored to the source session").toMatchObject({ run_id: source });
  // The source now drains on its own; its settlement is the handoff's, so it publishes nothing.
  (cancel.mock.contexts[0] as HarnessBridge).requestCancel(source);
  await vi.waitFor(() => expect(t.active()).toBe(false), { timeout: 10_000 });
  expect(t.state().state).toBe("WAITING_INPUT");
  const retry = await t.handoff();
  expect(retry.statusCode).toBe(200);
  const envelope = t.db.prepare("SELECT from_assistant_id, source_session_id FROM handoff_envelopes WHERE task_id = ?").get(t.taskId);
  expect(envelope).toEqual({ from_assistant_id: A, source_session_id: source });
}, 30_000);

it("a Harness retry after both handoff checkpoint writes failed still names the source session", async () => {
  const t = await boot({ harness: true });
  const source = await t.start();
  t.db.exec(`CREATE TRIGGER reject_handoff_checkpoint BEFORE INSERT ON checkpoints
    WHEN NEW.reason = 'handoff' BEGIN SELECT RAISE(ABORT, 'checkpoint store unavailable'); END`);
  expect((await t.handoff()).statusCode).toBe(409);
  expect(t.park()).toMatchObject({ checkpoint_id: null });
  t.db.exec("DROP TRIGGER reject_handoff_checkpoint");
  const retry = await t.handoff();
  expect(retry.statusCode).toBe(200);
  const envelope = t.db.prepare("SELECT from_assistant_id, source_session_id FROM handoff_envelopes WHERE task_id = ?").get(t.taskId);
  expect(envelope, "The retry must anchor to the drained source, not a run-less checkpoint")
    .toEqual({ from_assistant_id: A, source_session_id: source });
}, 30_000);

async function poolRunning(options: { harness?: boolean } = {}) {
  const t = await boot({ pool: true, ...options });
  expect((await t.action("wait", { kind: "resource", resource: "gpu", units: 1, reason: "needs a slot" })).statusCode).toBe(200);
  expect((await t.action("run-now")).json().outcome).toBe("dispatched");
  expect(t.active()).toBe(true);
  return t;
}

// M3: a grant followed by blocked recomposition answered 200 `deferred: resource` with nothing to wake it.
it("a pool handoff whose grant is blocked at recomposition is refused and parked", async () => {
  const t = await poolRunning();
  vi.spyOn(t.server.orchestrator, "recompose").mockResolvedValueOnce({
    kind: "blocked", reason: "composer_error", pauseKind: "intervention_required",
  });
  const response = await t.action("handoff");
  expect(response.json().deferred, "A blocked grant is not a pending deferral").toBeUndefined();
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain("composer_error");
  expect(t.state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "intervention_required" });
  expect(t.park(), "The refusal leaves a handoff park for the operator's retry").toBeDefined();
  expect(t.server.scheduler.claim(t.taskId)).toBeUndefined();
  // D1/CR-35: run-now never resumes an intervention_required pause.
  expect((await t.action("run-now")).json().outcome).toBe("stale");
  expect(t.handoffRows().filter((r) => r.to_run_id === null), "A refused handoff leaves no open record").toEqual([]);
});

// M3: exhausted routing retries at the grant answered a 409 that blamed pool capacity.
it("a pool handoff that exhausts its routing retries reports no candidate, not pool capacity", async () => {
  const t = await poolRunning();
  t.config.scheduler!.maxAutoWakes = 1;
  await t.setTarget(false);
  const response = await t.action("handoff");
  expect(response.statusCode).toBe(409);
  expect(response.json().error).not.toContain("pool can no longer grant");
  expect(response.json().error).toContain("No eligible assistant");
  expect(t.state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "no_candidate" });
  expect(t.park(), "The refusal leaves a handoff park").toBeDefined();
  await t.setTarget(true);
  const runNow = await t.action("run-now");
  expect(runNow.json().outcome).toBe("dispatched");
  await vi.waitFor(() => expect(t.active()).toBe(true));
});

/** A no_candidate pause with no tagged handoff park, as a park written before #207 looks. */
function untagPark(t: Awaited<ReturnType<typeof boot>>) {
  t.db.prepare("UPDATE wait_conditions SET state = 'replaced' WHERE task_id = ? AND created_by = 'handoff'").run(t.taskId);
  expect(t.park()).toBeUndefined();
  expect(t.state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "no_candidate" });
}

// M4: a retry of an older no_candidate park kept the stale pause when recomposition blocked.
it("a retry of an older no_candidate park takes the blocked recomposition's pause", async () => {
  const t = await boot();
  await t.start();
  await t.parkThenEnable();
  untagPark(t);
  vi.spyOn(t.server.orchestrator, "recompose").mockResolvedValueOnce({
    kind: "blocked", reason: "composer_error", pauseKind: "intervention_required",
  });
  const response = await t.handoff();
  expect(response.json().error).toContain("composer_error");
  expect(t.state().pause_kind, "The pause must reflect the retry's composition block").toBe("intervention_required");
  expect(t.park(), "The repaired pause carries a handoff park").toBeDefined();
});

it("a successful retry of an older no_candidate park keeps the source run's provenance", async () => {
  const t = await boot();
  const source = await t.start();
  await t.parkThenEnable();
  untagPark(t);
  const response = await t.handoff();
  expect(response.statusCode).toBe(200);
  const closed = t.handoffRows().filter((r) => r.to_run_id === response.json().runId);
  expect(closed).toEqual([expect.objectContaining({ from_run_id: source, trigger: "manual" })]);
});

// M5: a refused pool handoff left an open handoffs row, and the next retry filled both.
it("a retry after a refused pool handoff closes only its own handoff record", async () => {
  const t = await poolRunning();
  t.db.exec(`CREATE TRIGGER reject_routing BEFORE INSERT ON routing_decisions
    BEGIN SELECT RAISE(ABORT, 'routing store unavailable'); END`);
  expect((await t.action("handoff")).statusCode).toBe(409);
  t.db.exec("DROP TRIGGER reject_routing");
  expect(t.handoffRows().filter((r) => r.to_run_id === null), "The refusal leaves no open record").toEqual([]);
  const retry = await t.action("handoff");
  expect(retry.statusCode).toBe(200);
  const runId = retry.json().runId as string;
  expect(runId).toBeDefined();
  expect(t.handoffRows().filter((r) => r.to_run_id === runId), "Exactly one record names the successor").toHaveLength(1);
});

it("a retry after a refused successor start closes only its own handoff record", async () => {
  const t = await boot();
  await t.start();
  const adapter = t.server.registry.adapter(B);
  vi.spyOn(adapter, "start").mockRejectedValueOnce(new Error("provider start failed"));
  const refused = await t.handoff();
  expect(refused.statusCode).toBe(409);
  expect(t.handoffRows().filter((r) => r.to_run_id === null), "The refusal leaves no open record").toEqual([]);
  const retry = await t.handoff();
  expect(retry.statusCode).toBe(200);
  const runId = retry.json().runId as string;
  expect(t.handoffRows().filter((r) => r.to_run_id === runId), "Exactly one record names the successor").toHaveLength(1);
});

// D2: /run-now on a handoff park routes with the handoff's source exclusion and explicit target.
for (const harness of [false, true]) {
  const path = harness ? "Harness" : "legacy";

  it(`run-now on a ${path} handoff park keeps the explicit target`, async () => {
    const t = await boot({ harness, third: true });
    await t.start();
    await t.setTarget(false, C);
    const refused = await t.action("handoff", { to: C });
    expect(refused.statusCode).toBe(409);
    expect(t.state()).toMatchObject({ state: "WAITING_INPUT", pause_kind: "no_candidate" });
    await t.setTarget(true, C);
    const runNow = await t.action("run-now");
    expect(runNow.json().outcome).toBe("dispatched");
    await vi.waitFor(() => expect(t.state().state).toBe("RUNNING"));
    const run = t.db.prepare("SELECT id, assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(t.taskId) as { id: string; assistant_id: string };
    expect(run.assistant_id, "run-now must honour the handoff's explicit target").toBe(C);
    expect(t.handoffRows().filter((r) => r.to_run_id === run.id)).toEqual([expect.objectContaining({ trigger: "manual" })]);
  }, 30_000);

  it(`run-now on a ${path} handoff park keeps the source excluded`, async () => {
    const t = await boot({ harness });
    await t.start();
    await t.parkThenEnable();
    const runNow = await t.action("run-now");
    expect(runNow.json().outcome).toBe("dispatched");
    await vi.waitFor(() => expect(t.state().state).toBe("RUNNING"));
    const decision = t.db.prepare(`SELECT r.explanation FROM dispatches d JOIN routing_decisions r ON r.id = d.routing_decision_id
      WHERE d.task_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).get(t.taskId) as { explanation: string };
    const source = (JSON.parse(decision.explanation) as { candidates: Array<{ assistantId: string; filterFailures: string[] }> })
      .candidates.find((c) => c.assistantId === A);
    expect(source?.filterFailures, "run-now must keep the handoff's source excluded").toContain("disabled in workspace config");
    const run = t.db.prepare("SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(t.taskId) as { assistant_id: string };
    expect(run.assistant_id).toBe(B);
  }, 30_000);
}
