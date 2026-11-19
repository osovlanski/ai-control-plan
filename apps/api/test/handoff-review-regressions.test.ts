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
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup?.();
  cleanup = undefined;
});

async function boot({ harness = false, pool = false, goal = "Wait for approval [FAKE:APPROVAL]" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "handoff-review-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
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
  const setTarget = async (enabled: boolean) => {
    const response = await post(`/api/assistants/${B}/${enabled ? "enable" : "disable"}`);
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
  return { config, db, server, taskId, action, handoff, setTarget, start, state, active, parkThenEnable };
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
