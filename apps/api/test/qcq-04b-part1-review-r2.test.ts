/**
 * #272 review (Codex, 2026-11-26, round 2): one regression test per failure Codex reproduced on
 * the first fix of the qcq-04b part 1 review.
 *
 *   4.   A pre-060 attempt (no recorded unit manager) is not proven gone by an empty or absent read
 *        under today's manager; a populated read there records it.
 *   5.   Legacy: a failure while recording an event keeps the stream open until the cancelled
 *        stream drains; an abandoned start whose drain ends after the bounded wait settles then.
 *   5.   Harness: a `return()` that yields a cleanup event is not a close; a `return()` that
 *        unblocks a pending `next()` is asked at once; a synchronous `adapter.start` throw is a
 *        rejected call; a held-open stream reaches `ambiguous` with no scheduler, so the operator
 *        can confirm it.
 *   4,7. Stops: the recorded wrapper without `execution.agentUser`; one recovery stop per attempt
 *        (the boot reaper and the proof test share it, and an unissued one is retried); a refused
 *        operator stop is not reported done; the plane lane never stops another uid's unit.
 *   2.   (Overlapping boot: superseded in round 5 by the workspace lock, `qcq-04b-part1-review-r5.test.ts`.)
 *   3.   ENOTDIR and a zombie process are not proof of exit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AssistantId, CapabilityManifest, ExecutionRequest, NormalizedEvent, RunHandle, RunId, TaskId } from "@agent-plane/core";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore, configureExitProofs, recoveryStopFor, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, SystemExitEvidence, agentStopLauncher, attemptUnit, setExitEvidence } from "../src/modules/exit-evidence.js";
import { ApprovalService } from "../src/modules/harness/approval-service.js";
import { EventRecorder } from "../src/modules/harness/event-recorder.js";
import { SessionRunner, type RunnerDeps } from "../src/modules/harness/session-runner.js";
import { SessionStore } from "../src/modules/harness/session-store.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let dir: string; let db: Db; let store: SessionStore; let ev: FakeExitEvidence;
const dbs: Db[] = [];
function open(): Db {
  const d = openDb(join(dir, "t.db")); dbs.push(d);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04b-r272-"));
  db = open();
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  ev = new FakeExitEvidence();
  setExitEvidence(db, ev);
  configureExitProofs(db, { watchMs: 5, stopEvidenceMs: 150 });
  store = new SessionStore(db);
});
afterEach(() => {
  for (const d of dbs.splice(0)) { if (d.open) { stopExitWatches(d); d.close(); } }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const MANIFEST: CapabilityManifest = {
  assistantId: "a1" as AssistantId, provider: "fake",
  core: { models: [{ id: "fake-1" }], canResume: true, canMcp: false, supportsMidRunInput: true, reportsUsage: true, reportsLimits: true,
    execution: { shell: true, filesystem: true, web: "no" }, auth: { state: "ok" } },
  harness: { usageAccounting: "delta", toolGating: "none", approvalRelay: true, processIsolation: "none" },
  providerDetail: {}, evidence: { source: "runtime-probe", observedAt: "t" },
};
const deps = (adapter: AgentAdapter, over: Partial<RunnerDeps> = {}, d: Db = db, s: SessionStore = store): RunnerDeps => ({
  store: s, recorder: new EventRecorder(d), approvals: new ApprovalService(d),
  checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
  registry: { adapter: () => adapter, manifest: () => MANIFEST }, softThresholdPct: 80, approvalPollMs: 5, ...over,
});
const request = (): ExecutionRequest => ({
  schemaVersion: 1, executionRequestId: "erq_1", taskId: "AG-1" as TaskId, attempt: 1, assistantId: "a1" as AssistantId, routingDecisionRef: "rd_1",
  runSpec: { taskId: "AG-1" as TaskId, prompt: "do the thing", workdir: dir, permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 60_000 } },
  policy: { budget: { enforcement: "advisory" }, timeout: { hardMs: 60_000 }, approval: { mode: "auto-approve" }, tools: { mode: "audit" },
    checkpoint: { onSoftLimit: true }, isolation: { required: "ambient" } },
  context: {}, verification: [], origin: { kind: "fresh" },
});

type Attempt = { attempt_id: string; state: string; exit_proof: string | null; provider_unit: string | null; provider_unit_seen_at: string | null;
  provider_unit_owner: string | null; entered_incarnation: string | null; session_id: string | null; reason: string | null; kind: string };
const attempt = (d: Db = db): Attempt => d.prepare("SELECT * FROM execution_attempts WHERE task_id = 'AG-1' ORDER BY created_at DESC LIMIT 1").get() as Attempt;
const row = (d: Db, id: string) => d.prepare("SELECT * FROM execution_attempts WHERE attempt_id = ?").get(id) as Attempt;
const liveClaims = (d: Db, id: string) => (d.prepare("SELECT COUNT(*) n FROM resource_claims WHERE attempt_id = ? AND released_at IS NULL").get(id) as { n: number }).n;
async function until(what: () => boolean, label: string, ms = 3000) {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sweep = (d: Db, mode: "runtime" | "boot") => d.transaction(() => new AttemptStore(d).settleIdle("AG-1", mode, mode))();
const ts = () => new Date().toISOString();
const ev1 = (type: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ runId: "r1" as RunId, ts: ts(), type, summary: type, ...extra } as NormalizedEvent);
const handle: RunHandle = { runId: "r1" as RunId, assistantId: "a1" as AssistantId };

/** A unitless adapter (no scoped spawn) whose stream the test scripts. */
function scripted(over: Partial<AgentAdapter> & { iterator?: () => AsyncIterator<NormalizedEvent> }): AgentAdapter {
  return {
    id: "a1" as AssistantId,
    describe: async () => MANIFEST,
    start: async () => handle,
    resume: async () => handle,
    events: () => ({ [Symbol.asyncIterator]: over.iterator! }) as AsyncIterable<NormalizedEvent>,
    cancel: async () => {},
    ...over,
  } as AgentAdapter;
}

let slot = 0;
/** An entered attempt a dead incarnation (a pre-migration row unless given one) left behind. */
function entered(d: Db, over: { runAs?: "plane" | "agent"; seen?: boolean; state?: string; owner?: object | null; incarnation?: { id: string; pid: number; procStart: string | null } } = {}): string {
  const id = `att_${Math.random().toString(36).slice(2, 10)}`;
  const lane = over.runAs ?? "plane";
  const owner = over.owner === undefined ? ev.owners[lane] : over.owner;
  if (over.incarnation) {
    d.prepare("INSERT OR IGNORE INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES (?, ?, ?, 'boot-fake-1', 't')")
      .run(over.incarnation.id, over.incarnation.pid, over.incarnation.procStart);
  }
  d.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, candidate_slot, run_as, account_source, queue_key, state,
      entered_at, entered_boot_id, entered_incarnation, provider_unit, provider_unit_owner, provider_unit_seen_at, created_at, updated_at, reason)
    VALUES (?, 'AG-1', 'direct', 'harness', ?, ?, 'none', 'k', ?, 't', 'boot-fake-1', ?, ?, ?, ?, 't', 't', 'test')`)
    .run(id, slot++, lane, over.state ?? "live", over.incarnation?.id ?? null, attemptUnit(id, lane), owner ? JSON.stringify(owner) : null, over.seen ? "t" : null);
  d.prepare("INSERT INTO resource_claims (attempt_id, task_id, resource, units, claimed_at) VALUES (?, 'AG-1', 'gpu', 1, 't')").run(id);
  return id;
}

describe("finding 4: a pre-060 attempt records no unit manager", () => {
  it("an absent read under today's manager proves nothing, registered or not", () => {
    const seen = entered(db, { owner: null, seen: true });
    const never = entered(db, { owner: null });
    // The launch-time manager (an agent user since renamed) still has it; today's reads absent.
    ev.ownedUnits.set(`2002:${row(db, seen).provider_unit!}`, "populated");
    sweep(db, "boot");
    for (const id of [seen, never]) {
      expect(row(db, id)).toMatchObject({ state: "live", exit_proof: null });
      expect(liveClaims(db, id)).toBe(1);
    }
    ev.units.set(row(db, seen).provider_unit!, "empty");
    sweep(db, "boot");
    expect(row(db, seen)).toMatchObject({ state: "live", exit_proof: null, provider_unit_owner: null });
  });

  it("a populated read under today's manager records that manager, and recovery stops it there", async () => {
    const id = entered(db, { owner: null });
    const unit = row(db, id).provider_unit!;
    ev.units.set(unit, "populated");
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "stopping", provider_unit_seen_at: expect.any(String) });
    expect(JSON.parse(row(db, id).provider_unit_owner!)).toEqual({ uid: 1000 });
    await until(() => ev.stopped.includes(unit), "the recovery stop");
    expect(ev.stopOwners).toEqual([{ uid: 1000 }]);
    ev.units.set(unit, "absent");
    sweep(db, "runtime");
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "cgroup_empty" });
  });
});

describe("finding 5 (Harness): the stream is closed only when it is", () => {
  it("a return() that yields a cleanup event is not a close: the stream is read to its end (cancel after start)", async () => {
    let openStart!: () => void; let endStream!: () => void;
    const startGate = new Promise<void>((r) => { openStart = r; });
    const endGate = new Promise<void>((r) => { endStream = r; });
    const adapter = scripted({
      start: async () => { await startGate; return handle; },
      iterator: () => ({
        next: () => endGate.then(() => ({ done: true, value: undefined }) as IteratorResult<NormalizedEvent>),
        return: async () => ({ done: false, value: ev1("message", { summary: "cleanup" }) }),
      }),
    });
    const run = new SessionRunner(deps(adapter)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    expect(store.requestCancel(attempt().session_id!)).toBe(true);
    openStart();
    await run;
    await sleep(20);
    // Before the fix: settled stream_closed_unverified here, with the stream still open.
    expect(attempt().exit_proof).toBeNull();
    endStream();
    await until(() => attempt().state === "settled", "the stream end");
    expect(attempt().exit_proof).toBe("stream_closed_unverified");
  });

  it("a return() that unblocks a pending next() is asked at once (the run.ended grace)", async () => {
    let unblock: (() => void) | undefined;
    const script = [ev1("run.started"), ev1("run.ended", { payload: { ok: true } })];
    const adapter = scripted({
      iterator: () => {
        let i = 0;
        return {
          next: () => i < script.length
            ? Promise.resolve({ done: false, value: script[i++]! })
            : new Promise<IteratorResult<NormalizedEvent>>((r) => { unblock = () => r({ done: true, value: undefined }); }),
          return: async () => { unblock?.(); return { done: true, value: undefined }; },
        };
      },
    });
    const result = await new SessionRunner(deps(adapter, { endedGraceMs: 30 })).run(request());
    expect(result.outcome).toBe("completed");
    // Before the fix: the close waited on the pending next() first, which only return() ends.
    await until(() => attempt().state === "settled", "the close by return()", 1000);
    expect(attempt().exit_proof).toBe("stream_closed_unverified");
  });

  it("a synchronous adapter.start throw is a rejected call: the unitless attempt settles", async () => {
    const adapter = scripted({ start: (() => { throw new Error("spawn failed synchronously"); }) as never, iterator: () => ({ next: async () => ({ done: true, value: undefined }) }) });
    const result = await new SessionRunner(deps(adapter)).run(request());
    expect(result.outcome).toBe("failed");
    // Before the fix: the stream stayed open forever and the attempt kept its claims.
    expect(attempt()).toMatchObject({ state: "settled", exit_proof: "stream_closed_unverified" });
  });

  it("a held-open stream with no scheduler goes ambiguous past the deadline, and the operator can confirm it", async () => {
    const script = [ev1("run.started"), ev1("run.ended", { payload: { ok: true } })];
    const adapter = scripted({
      iterator: () => {
        let i = 0;
        return { next: () => (i < script.length ? Promise.resolve({ done: false, value: script[i++]! }) : new Promise<IteratorResult<NormalizedEvent>>(() => {})) };
      },
    });
    const result = await new SessionRunner(deps(adapter, { endedGraceMs: 30 })).run(request());
    expect(result.outcome).toBe("completed");
    const id = attempt().attempt_id;
    expect(attempt().exit_proof).toBeNull();
    // No sweep runs: before the fix the attempt stayed live and confirm-stopped answered attempt_live.
    await until(() => attempt().state === "ambiguous", "ambiguous past stopEvidenceMs", 2000);
    const confirmed = db.transaction(() => new AttemptStore(db).confirmStopped(id, "operator"))();
    expect(confirmed).toMatchObject({ ok: true, attempt: { state: "settled", exit_proof: "operator_confirmed" } });
  });
});

describe("findings 4 and 7: stops", () => {
  it("the agent wrapper is the recorded one, also with execution.agentUser removed", () => {
    const owner = { uid: 2002, user: "aos-agent-old", group: "aos-old", wrapper: "/opt/aos/aos-launch" };
    expect(agentStopLauncher(owner, undefined)).toEqual({ sudo: "/usr/bin/sudo", user: "aos-agent-old", group: "aos-old", wrapper: "/opt/aos/aos-launch" });
    expect(agentStopLauncher(owner, { user: "aos-agent", sudo: "/bin/sudo", group: "aos", wrapper: "/usr/local/lib/aos/run-as-agent" }))
      .toEqual({ sudo: "/bin/sudo", user: "aos-agent-old", group: "aos-old", wrapper: "/opt/aos/aos-launch" });
    expect(agentStopLauncher(undefined, undefined)).toBeUndefined();
  });

  it("the host reader reports a stop it could not issue: no agent identity, or another uid's plane-lane unit", async () => {
    const reader = new SystemExitEvidence({});
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    await expect(reader.stopUnit(attemptUnit("att_0a1b2c3d", "agent"), "agent")).resolves.toBe(false);
    await expect(reader.stopUnit(attemptUnit("att_0a1b2c3d", "plane"), "plane", { uid: uid + 4242 })).resolves.toBe(false);
  });

  it("one recovery stop per attempt: the boot reaper's claim covers the proof test's, and a live incarnation's is never claimed", async () => {
    const owner = { uid: 2002, user: "aos-agent-old", wrapper: "/opt/aos/aos-launch" };
    const id = entered(db, { runAs: "agent", owner });
    const unit = row(db, id).provider_unit!;
    ev.ownedUnits.set(`2002:${unit}`, "populated");
    // The boot reaper reaches the unit first (by its recorded agent unit id, the attempt id).
    expect(recoveryStopFor(db, id)).toEqual({ attempt: true, stop: true, attemptId: id, unit, owner });
    expect(recoveryStopFor(db, id)).toEqual({ attempt: true, stop: false, attemptId: id, unit, owner });
    sweep(db, "boot");
    await sleep(20);
    expect(row(db, id).state).toBe("stopping");
    expect(ev.stopped).toEqual([]); // before the fix: a second stop here
    // A unit id with no attempt (a pre-04b session) is the reaper's to stop as before.
    expect(recoveryStopFor(db, "ses_unknown")).toEqual({ attempt: false, stop: true });
    const live = entered(db, { runAs: "agent", owner, incarnation: { id: "inc_live", pid: 999_997, procStart: "5" } });
    ev.processes.set(999_997, "5");
    expect(recoveryStopFor(db, live)).toEqual({ attempt: true, stop: false });
  });

  it("a recovery stop no manager could take is tried again on the next proof test", async () => {
    const id = entered(db, { seen: true, state: "stopping" });
    const unit = row(db, id).provider_unit!;
    ev.units.set(unit, "populated");
    ev.stoppable = false;
    sweep(db, "boot");
    await sleep(20);
    expect(ev.stopped).toEqual([]);
    ev.stoppable = true;
    sweep(db, "runtime");
    await until(() => ev.stopped.includes(unit), "the retried stop");
    sweep(db, "runtime");
    await sleep(20);
    expect(ev.stopped).toEqual([unit]);
  });

  it("the operator's stop-unit answers 409 stop_unavailable, and moves nothing, when no stop could be issued", async () => {
    const home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-route-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const d = openDb(config.dbPath); dbs.push(d);
    const built = buildServer({ config, db: d });
    try {
      setExitEvidence(d, ev);
      d.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
      ev.stoppable = false;
      const id = entered(d, { state: "live", incarnation: { id: "inc_live2", pid: 999_996, procStart: "6" } });
      ev.processes.set(999_996, "6");
      const auth = { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` };
      const stop = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/stop-unit`, headers: auth });
      // Before the fix: 200 stopRequested with no command issued, and the attempt moved to stopping.
      expect(stop.statusCode).toBe(409);
      expect(stop.json()).toEqual({ error: "stop_unavailable" });
      expect(row(d, id)).toMatchObject({ state: "live", exit_proof: null });
      ev.stoppable = true;
      const ok = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/stop-unit`, headers: auth });
      expect(ok.json()).toEqual({ attemptId: id, unit: row(d, id).provider_unit, stopRequested: true });
      expect(row(d, id).state).toBe("stopping");
    } finally {
      await built.orchestrator.shutdown(); await built.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("finding 3: ENOTDIR and a zombie are not proof of exit (host reader over a fake /proc)", () => {
  let root: string, proc: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exit-evidence-r272-"));
    proc = join(root, "proc");
    mkdirSync(proc, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const reader = () => new SystemExitEvidence({ procRoot: proc });

  it.runIf(process.platform === "linux")("a /proc entry that is not a directory leaves the scan and the start time unknown", () => {
    writeFileSync(join(proc, "400"), "not a directory\n");
    // Before the fix: ENOTDIR read as gone, so the launcher scan was complete and the pid dead.
    expect(reader().launcherAlive("att_0a1b2c3d")).toBe(true);
    expect(reader().processStart(400)).toBe("unreadable");
  });

  it.runIf(process.platform === "linux")("a zombie or dead process runs nothing", () => {
    const fields = (state: string) => [state, ...Array.from({ length: 49 }, (_, i) => String(i + 4))].join(" ");
    for (const [pid, state] of [[500, "S"], [501, "Z"], [502, "X"]] as const) {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (node) ${fields(state)}\n`);
    }
    expect(reader().processStart(500)).toBe("22");
    expect(reader().processStart(501)).toBeNull();
    expect(reader().processStart(502)).toBeNull();
  });
});

describe("finding 5 (legacy): the stream decides, not the consumer", () => {
  let home: string; let config: ResolvedConfig; let built: BuiltServer | undefined; let ldb: Db;
  const A = "fake-a" as AssistantId;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    if (ldb?.open) { stopExitWatches(ldb); ldb.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  async function boot() {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-legacy-"));
    config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { [A]: { provider: "fake" } };
    config.execution.harnessModes.single = false;
    ldb = openDb(config.dbPath); built = buildServer({ config, db: ldb });
    built.registry.init(); await built.registry.syncAll();
    const id = built.tasks.create({ goal: "do the work" }).taskId;
    built.tasks.transition(id, "ROUTING");
    return { id, adapter: built.registry.adapter(A) };
  }
  const attempts = (taskId: string) => ldb.prepare("SELECT * FROM execution_attempts WHERE task_id = ?").all(taskId) as Attempt[];

  it("a failure recording an event keeps the stream open until the cancelled stream drains", async () => {
    const { id, adapter } = await boot();
    let endStream!: () => void;
    const endGate = new Promise<void>((r) => { endStream = r; });
    const cancel = vi.spyOn(adapter, "cancel").mockResolvedValue(undefined);
    vi.spyOn(adapter, "events").mockImplementation(() => (async function* () {
      yield ev1("run.started");
      await endGate; // the provider is still running
    })());
    ldb.exec("CREATE TEMP TRIGGER qcq_fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event store unavailable'); END");
    const { runId } = await built!.orchestrator.startTask(id, A);
    await until(() => !!(ldb.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as { ended_at: string | null }).ended_at, "the run's end");
    ldb.exec("DROP TRIGGER qcq_fail_event");
    await until(() => cancel.mock.calls.length === 1, "the cancel");
    await sleep(20);
    // Before the fix: settled stream_closed_unverified as soon as the consumer failed.
    expect(attempts(id)).toEqual([expect.objectContaining({ exit_proof: null })]);
    expect(attempts(id)[0]!.state).not.toBe("settled");
    endStream();
    await until(() => attempts(id)[0]!.state === "settled", "the drained stream");
    expect(attempts(id)[0]!.exit_proof).toBe("stream_closed_unverified");
  });

  it("an abandoned start whose drain ends after the bounded wait settles then", async () => {
    const { id, adapter } = await boot();
    let endStream!: () => void;
    const endGate = new Promise<void>((r) => { endStream = r; });
    vi.spyOn(adapter, "cancel").mockResolvedValue(undefined);
    vi.spyOn(adapter, "events").mockImplementation(() => ({ [Symbol.asyncIterator]: () => ({ next: () => endGate.then(() => ({ done: true, value: undefined })) }) }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      ldb.exec("CREATE TEMP TRIGGER qcq_fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run store unavailable'); END");
      const started = built!.orchestrator.startTask(id, A).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(String(await started)).toMatch(/run store unavailable/);
      ldb.exec("DROP TRIGGER qcq_fail_run");
    } finally { vi.useRealTimers(); }
    expect(attempts(id)).toEqual([expect.objectContaining({ kind: "direct", state: "ambiguous", exit_proof: null })]);
    endStream();
    // Before the fix: an unbound direct start read as owned by its (long gone) start, so it stayed ambiguous.
    await until(() => attempts(id)[0]!.state === "settled", "the late drain");
    expect(attempts(id)[0]!.exit_proof).toBe("stream_closed_unverified");
  });
});
