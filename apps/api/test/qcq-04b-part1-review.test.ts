/**
 * #268 review (Codex, 2026-11-26): one regression test per finding of the qcq-04b part 1 review.
 *
 *   1. An empty or absent unit never seen populated is not `cgroup_empty`.
 *   2. An attempt entered by another live incarnation (another connection in this process, or a
 *      plane process whose pid still has its recorded start time) is not read as a dead one's.
 *   3. A cgroup search or launcher scan the plane could not complete proves nothing absent.
 *   4. Recovery reads and stops a unit under the manager recorded at entry, and the launcher scan
 *      knows a configured wrapper by its own name.
 *   5. A unitless attempt is not settled while its provider call or event stream is still open:
 *      a legacy dispatch cancelled while `adapter.start` is pending, and a Harness session that
 *      ended on the `run.ended` grace with its iterator open.
 *   6. confirm-stopped refuses a `starting` attempt whose runner awaits its handle.
 *   7. A dead incarnation's populated unit is stopped also when the attempt is already `stopping`
 *      or `ambiguous`, once.
 *   8. `ambiguous` keeps the spawn-closed report, so a later `unscoped_exit` is still provable.
 *
 * Runner cases drive the real SessionRunner with the fake adapter and `FakeExitEvidence`; the
 * legacy case drives the scheduler and orchestrator; the host reads run against fake trees.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AssistantId, CapabilityManifest, ExecutionRequest, NormalizedEvent, RunId, RunSpec, TaskId } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore, configureExitProofs, enterProvider, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, SystemExitEvidence, attemptUnit, launcherArgv, setExitEvidence } from "../src/modules/exit-evidence.js";
import { ApprovalService } from "../src/modules/harness/approval-service.js";
import { EventRecorder } from "../src/modules/harness/event-recorder.js";
import { SessionRunner, type RunnerDeps } from "../src/modules/harness/session-runner.js";
import { SessionStore } from "../src/modules/harness/session-store.js";
import { Scheduler } from "../src/modules/scheduler.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let dir: string; let db: Db; let store: SessionStore; let ev: FakeExitEvidence;
const dbs: Db[] = [];
const path = () => join(dir, "t.db");
function open(): Db {
  const d = openDb(path()); dbs.push(d);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04b-r268-"));
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
});

const MANIFEST: CapabilityManifest = {
  assistantId: "a1" as AssistantId, provider: "fake",
  core: { models: [{ id: "fake-1" }], canResume: true, canMcp: false, supportsMidRunInput: true, reportsUsage: true, reportsLimits: true,
    execution: { shell: true, filesystem: true, web: "no" }, auth: { state: "ok" } },
  harness: { usageAccounting: "delta", toolGating: "none", approvalRelay: true, processIsolation: "none" },
  providerDetail: {}, evidence: { source: "runtime-probe", observedAt: "t" },
};
const deps = (adapter: AgentAdapter, over: Partial<RunnerDeps> = {}): RunnerDeps => ({
  store, recorder: new EventRecorder(db), approvals: new ApprovalService(db),
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
  provider_unit_owner: string | null; entered_incarnation: string | null };
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

/** A fake whose `start` waits on a gate (an unsettled provider call); scoped when asked. */
function gated(opts: { scoped?: boolean; onStart?: (spec: RunSpec) => void } = {}) {
  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  const fake = new FakeAdapter("a1" as AssistantId, undefined, { scopedSpawn: opts.scoped !== false });
  const real = fake.start.bind(fake);
  fake.start = async (spec) => { opts.onStart?.(spec); await gate; return real(spec); };
  return { fake, openGate };
}

/**
 * An entered attempt as some other incarnation left it. `incarnation`: an id with a
 * `plane_incarnations` row (`pid`, `procStart`), or none (a pre-migration row: dead).
 */
function entered(d: Db, over: { runAs?: "plane" | "agent"; seen?: boolean; state?: string; owner?: object | null; incarnation?: { id: string; pid: number; procStart: string | null } } = {}): string {
  const id = `att_${Math.random().toString(36).slice(2, 10)}`;
  const lane = over.runAs ?? "plane";
  // The manager the fake reports for the lane, as an entry records it; `owner: null` is a pre-060 row.
  if (over.owner === undefined) over = { ...over, owner: ev.owners[lane] };
  const unit = attemptUnit(id, lane);
  if (over.incarnation) {
    d.prepare("INSERT OR IGNORE INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES (?, ?, ?, 'boot-fake-1', 't')")
      .run(over.incarnation.id, over.incarnation.pid, over.incarnation.procStart);
  }
  d.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, candidate_slot, run_as, account_source, queue_key, state,
      entered_at, entered_boot_id, entered_incarnation, provider_unit, provider_unit_owner, provider_unit_seen_at, created_at, updated_at, reason)
    VALUES (?, 'AG-1', 'direct', 'harness', 0, ?, 'none', 'k', ?, 't', 'boot-fake-1', ?, ?, ?, ?, 't', 't', 'test')`)
    .run(id, lane, over.state ?? "live", over.incarnation?.id ?? null, unit, over.owner ? JSON.stringify(over.owner) : null, over.seen ? "t" : null);
  d.prepare("INSERT INTO resource_claims (attempt_id, task_id, resource, units, claimed_at) VALUES (?, 'AG-1', 'gpu', 1, 't')").run(id);
  return id;
}

describe("finding 1: an empty unit never seen populated is not an exit", () => {
  it("holds while the call is unsettled, and is unscoped_exit (never cgroup_empty) once the spawn path closed", async () => {
    const { fake, openGate } = gated({ onStart: (s) => ev.units.set(`${s.scope!.unit}.scope`, "empty") });
    const run = new SessionRunner(deps(fake)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    await sleep(30);
    sweep(db, "runtime");
    expect(attempt()).toMatchObject({ state: "starting", exit_proof: null, provider_unit_seen_at: null });
    openGate();
    await run;
    await until(() => attempt().state === "settled", "the proof once the spawn path closed");
    expect(attempt().exit_proof).toBe("unscoped_exit");
  });

  it("a dead incarnation's empty, never-registered unit with its launcher alive holds; gone, it is unscoped_exit", () => {
    const id = entered(db);
    ev.units.set(row(db, id).provider_unit!, "empty");
    ev.launchers.add(id);
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "live", exit_proof: null });
    expect(liveClaims(db, id)).toBe(1);
    ev.launchers.clear();
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "unscoped_exit" });
  });
});

describe("finding 2: a live incarnation is not a dead one", () => {
  it("a second connection in this process leaves a live attempt alone; a closed one's is settled", async () => {
    const { fake, openGate } = gated();
    const run = new SessionRunner(deps(fake)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    expect(attempt().entered_incarnation).toMatch(/^inc_/);
    const other = open();
    setExitEvidence(other, ev);
    // Unit absent, no launcher: the dead-incarnation reading would write unscoped_exit here.
    sweep(other, "boot");
    expect(attempt(other)).toMatchObject({ state: "starting", exit_proof: null });
    openGate();
    await run;
    await until(() => attempt().state === "settled", "the plane's own proof");

    // An attempt entered through `other`, which then closes (its process kept running).
    const held = new AttemptStore(other).createHeld({ taskId: "AG-1", kind: "direct", path: "legacy", slot: 1, runAs: "plane" });
    expect(enterProvider(other, { attemptId: held.attempt_id, path: "legacy" }).ok).toBe(true);
    sweep(db, "boot");
    expect(row(db, held.attempt_id).state).toBe("starting");
    stopExitWatches(other); other.close();
    sweep(db, "boot");
    expect(row(db, held.attempt_id)).toMatchObject({ state: "settled", exit_proof: "boot_unverified" });
  });

  it("another plane process is alive while its pid has the recorded start time; a reused or gone pid is dead", () => {
    const inc = { id: "inc_other", pid: 999_999, procStart: "4242" };
    const id = entered(db, { incarnation: inc });
    ev.processes.set(inc.pid, "4242");
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "live", exit_proof: null });
    // A start time the plane cannot read proves nothing gone.
    ev.processes.set(inc.pid, "unreadable");
    sweep(db, "boot");
    expect(row(db, id).state).toBe("live");
    // The pid was reused by another process: that incarnation is dead (unit absent, no launcher).
    ev.processes.set(inc.pid, "9999");
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "unscoped_exit" });

    const gone = entered(db, { incarnation: inc });
    ev.processes.delete(inc.pid);
    sweep(db, "boot");
    expect(row(db, gone).exit_proof).toBe("unscoped_exit");
  });

  it("confirm-stopped refuses an attempt another live plane holds", () => {
    const inc = { id: "inc_live", pid: 999_998, procStart: "77" };
    const id = entered(db, { incarnation: inc, state: "ambiguous" });
    ev.processes.set(inc.pid, "77");
    expect(db.transaction(() => new AttemptStore(db).confirmStopped(id, "operator"))()).toEqual({ ok: false, code: "attempt_live" });
  });
});

describe("finding 3 and 4: incomplete reads, the recorded manager and wrapper (host reader over fake trees)", () => {
  let root: string, cgroup: string, proc: string, runtime: string, bin: string;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ID = "att_0a1b2c3d";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exit-evidence-r268-"));
    cgroup = join(root, "cgroup"); proc = join(root, "proc"); runtime = join(root, "run"); bin = join(root, "bin");
    mkdirSync(join(cgroup, "user.slice", `user-${uid}.slice`, `user@${uid}.service`), { recursive: true });
    writeFileSync(join(cgroup, "cgroup.controllers"), "cpu memory pids\n");
    mkdirSync(join(proc, "sys", "kernel", "random"), { recursive: true });
    writeFileSync(join(proc, "sys", "kernel", "random", "boot_id"), "3f1c-boot\n");
    mkdirSync(join(runtime, "systemd", "private"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\n"); chmodSync(join(bin, "systemd-run"), 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const reader = () => new SystemExitEvidence({ cgroupRoot: cgroup, procRoot: proc, env: { XDG_RUNTIME_DIR: runtime, PATH: bin } });
  const manager = (u: number) => join(cgroup, "user.slice", `user-${u}.slice`, `user@${u}.service`);

  it.runIf(process.platform === "linux")("a slice the plane cannot inspect makes the unit unreadable, never absent", () => {
    const unit = attemptUnit(ID, "plane");
    expect(reader().readUnit(unit, "plane")).toBe("absent");
    // A slice entry whose stat fails with anything but ENOENT (here ELOOP; EACCES on a host).
    symlinkSync("loop.slice", join(manager(uid), "loop.slice"));
    expect(reader().readUnit(unit, "plane")).toBe("unreadable");
  });

  it.runIf(process.platform === "linux")("a process whose argv the plane cannot read keeps the launcher scan open", () => {
    mkdirSync(join(proc, "100"), { recursive: true });
    writeFileSync(join(proc, "100", "cmdline"), "node\0server.js\0");
    expect(reader().launcherAlive(ID)).toBe(false);
    // Readable as a directory, not a file: EISDIR (EACCES on a host with another user's process).
    mkdirSync(join(proc, "101", "cmdline"), { recursive: true });
    expect(reader().launcherAlive(ID)).toBe(true);
  });

  it.runIf(process.platform === "linux")("reads a unit under the recorded owner's manager, and knows a configured wrapper by its name", () => {
    const unit = attemptUnit(ID, "agent");
    const other = uid + 4242;
    mkdirSync(join(manager(other), "app.slice", unit), { recursive: true });
    writeFileSync(join(manager(other), "app.slice", unit, "cgroup.events"), "populated 1\n");
    expect(reader().readUnit(unit, "agent", { uid: other })).toBe("populated");
    // Without the record there is no agent user configured: nothing can be read.
    expect(reader().readUnit(unit, "agent")).toBe("unreadable");
    expect(launcherArgv(["sudo", "-n", "/opt/aos/aos-launch", "run", ID], ID)).toBe(false);
    expect(launcherArgv(["sudo", "-n", "/opt/aos/aos-launch", "run", ID], ID, ["/opt/aos/aos-launch"])).toBe(true);
    expect(launcherArgv(["/bin/sh", "/opt/aos/aos-launch", "run", ID], ID, ["/opt/aos/aos-launch"])).toBe(true);
    mkdirSync(join(proc, "200"), { recursive: true });
    writeFileSync(join(proc, "200", "cmdline"), ["sudo", "/opt/aos/aos-launch", "run", ID].join("\0") + "\0");
    expect(reader().launcherAlive(ID)).toBe(false);
    expect(reader().launcherAlive(ID, { uid: other, wrapper: "/opt/aos/aos-launch" })).toBe(true);
  });

  it.runIf(process.platform === "linux")("reads a process start time after a command name with spaces and parentheses", () => {
    mkdirSync(join(proc, "300"), { recursive: true });
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3)); // fields 3.. (field 22 is "22")
    writeFileSync(join(proc, "300", "stat"), `300 (node (a b)) ${fields.join(" ")}\n`);
    expect(reader().processStart(300)).toBe("22");
    mkdirSync(join(proc, String(process.pid)), { recursive: true }); // a mounted /proc holds this process
    expect(reader().processStart(301)).toBeNull();
  });

  it("the entry records the plane incarnation and the unit's manager", async () => {
    const { fake, openGate } = gated();
    openGate();
    await new SessionRunner(deps(fake)).run(request());
    const a = attempt();
    expect(JSON.parse(a.provider_unit_owner!)).toEqual({ uid: 1000 });
    expect(db.prepare("SELECT pid, proc_start, boot_id FROM plane_incarnations WHERE incarnation_id = ?").get(a.entered_incarnation))
      .toEqual({ pid: process.pid, proc_start: "self", boot_id: "boot-fake-1" });
  });

  it("recovery reads and stops a dead incarnation's agent unit under the recorded owner, not today's agent user", async () => {
    const owner = { uid: 2002, user: "aos-agent-old", wrapper: "/opt/aos/aos-launch" };
    const id = entered(db, { runAs: "agent", owner });
    const unit = row(db, id).provider_unit!;
    // Today's agent user (uid 1001) has no such unit; the launch-time manager does.
    ev.ownedUnits.set(`2002:${unit}`, "populated");
    sweep(db, "boot");
    expect(row(db, id)).toMatchObject({ state: "stopping", exit_proof: null, provider_unit_seen_at: expect.any(String) });
    await until(() => ev.stopped.includes(unit), "the recovery stop");
    expect(ev.stopOwners).toEqual([owner]);
  });
});

describe("finding 5: the provider stream decides, not the end of the session or the run", () => {
  it("a unitless Harness session that ended on the run.ended grace holds its attempt until the iterator closes", async () => {
    let close!: () => void;
    const closed = new Promise<void>((r) => { close = r; });
    const lingering: AgentAdapter = {
      id: "a1" as AssistantId,
      describe: async () => MANIFEST,
      start: async () => ({ runId: "l1", assistantId: "a1" as AssistantId }),
      resume: async () => ({ runId: "l1", assistantId: "a1" as AssistantId }),
      events: async function* (): AsyncGenerator<NormalizedEvent> {
        const ts = () => new Date().toISOString();
        yield { runId: "l1" as RunId, ts: ts(), type: "run.started", summary: "started" };
        yield { runId: "l1" as RunId, ts: ts(), type: "run.ended", summary: "Run completed", payload: { ok: true } };
        await closed; // a background child holds the stream open
      },
      cancel: async () => {},
    };
    const result = await new SessionRunner(deps(lingering, { endedGraceMs: 30 })).run(request());
    expect(result.outcome).toBe("completed");
    await sleep(30);
    expect(attempt()).toMatchObject({ provider_unit: null, exit_proof: null });
    expect(["starting", "live", "stopping"]).toContain(attempt().state);
    close();
    await until(() => attempt().state === "settled", "the stream close");
    expect(attempt().exit_proof).toBe("stream_closed_unverified");
  });
});

describe("finding 6: confirm-stopped while the runner awaits its handle", () => {
  it("is refused attempt_live for a starting attempt; accepted path is the runner's own once the call settles", async () => {
    ev.lanes.plane = "no unit for this case";
    const { fake, openGate } = gated({ scoped: false });
    const run = new SessionRunner(deps(fake)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    const id = attempt().attempt_id;
    expect(db.transaction(() => new AttemptStore(db).confirmStopped(id, "operator"))()).toEqual({ ok: false, code: "attempt_live" });
    expect(attempt().state).toBe("starting");
    openGate();
    await run;
    expect(attempt()).toMatchObject({ state: "settled", exit_proof: "stream_closed_unverified" });
  });
});

describe("finding 7: a dead incarnation's populated unit is stopped whatever state it reached", () => {
  for (const state of ["stopping", "ambiguous"]) {
    it(`stops it when the attempt is already ${state}, once`, async () => {
      const id = entered(db, { state, seen: true });
      const unit = row(db, id).provider_unit!;
      ev.units.set(unit, "populated");
      sweep(db, "boot");
      await until(() => ev.stopped.includes(unit), "the recovery stop");
      sweep(db, "runtime");
      await sleep(10);
      expect(ev.stopped).toEqual([unit]);
      expect(row(db, id).exit_proof).toBeNull();
      ev.units.set(unit, "absent");
      sweep(db, "runtime");
      expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "cgroup_empty" });
    });
  }
});

describe("finding 8: ambiguous keeps the spawn-closed report", () => {
  it("a never-registered unit that went ambiguous behind a live launcher is unscoped_exit once the launcher is gone", async () => {
    const { fake, openGate } = gated({ onStart: () => ev.launchers.add(attempt().attempt_id) });
    openGate();
    await new SessionRunner(deps(fake)).run(request());
    await until(() => attempt().state === "ambiguous", "ambiguous after stopEvidenceMs");
    await sleep(20); // the exit watch has stopped
    ev.launchers.clear();
    sweep(db, "runtime");
    expect(attempt()).toMatchObject({ state: "settled", exit_proof: "unscoped_exit" });
  });
});

describe("finding 5 (legacy): a dispatch cancelled while adapter.start is pending", () => {
  let home: string; let config: ResolvedConfig; let built: BuiltServer; let ldb: Db;
  const errors: unknown[] = [];
  let instant = Date.parse("2030-01-01T00:00:00Z");
  const now = () => new Date(instant);
  const A = "fake-a" as AssistantId;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
    if (ldb?.open) { stopExitWatches(ldb); ldb.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

  it("keeps the attempt stopping with its claim until the stream closes, then stream_closed_unverified", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r268-legacy-"));
    config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { [A]: { provider: "fake" } };
    config.scheduler = { ...config.scheduler, enabled: true, resources: { gpu: 1 } };
    config.execution.harnessModes.single = false;
    ldb = openDb(config.dbPath); built = buildServer({ config, db: ldb, now });
    built.registry.init(); await built.registry.syncAll();
    const s = new Scheduler({ db: ldb, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, onError: (e) => { errors.push(e); } });
    instant += 1;
    const id = built.tasks.create({ goal: "do the work" }).taskId;
    const adapter = built.registry.adapter(A);
    const real = adapter.start.bind(adapter);
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    vi.spyOn(adapter, "start").mockImplementation(async (spec) => { await gate; return real(spec); });
    s.attach(id, { kind: "resource", resource: "gpu", reason: "needs a slot" });
    await s.tick(); await drain();
    const one = () => ldb.prepare("SELECT * FROM execution_attempts WHERE task_id = ?").get(id) as Attempt;
    const claims = () => (ldb.prepare("SELECT COUNT(*) n FROM resource_claims WHERE task_id = ? AND released_at IS NULL").get(id) as { n: number }).n;
    expect(one()).toMatchObject({ state: "starting" });
    expect(claims()).toBe(1);

    await built.orchestrator.cancelTask(id); await drain();
    await s.tick(); await drain();
    // No run row, the dispatch cancelled: before the fix the sweep wrote stream_closed_unverified here.
    // (`ambiguous` when the cancel's wall-clock stop time is far behind the scheduler's injected clock.)
    expect(one().exit_proof).toBeNull();
    expect(["stopping", "ambiguous"]).toContain(one().state);
    expect(claims()).toBe(1);

    openGate();
    await until(() => one().state === "settled", "the stream close");
    expect(one().exit_proof).toBe("stream_closed_unverified");
    expect(claims()).toBe(0);
    expect(errors).toEqual([]);
  });
});
