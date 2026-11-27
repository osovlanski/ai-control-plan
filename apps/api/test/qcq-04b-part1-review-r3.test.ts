/**
 * #272 review (Codex, 2026-11-27, round 3): one regression test per failure Codex reproduced on
 * the round-2 fix.
 *
 *   1. A second plane's boot leaves a session whose lease another live incarnation holds, also one
 *      still waiting for a provider start slot (the lease records its holder before any entry).
 *   2. Its task is not parked or failed either.
 *   3. A `return()` result without `done` (a yielded cleanup value) is not a close.
 *   4. A legacy `events()` that throws before handing out an iterator still settles the run.
 *   5. A stop command that exits nonzero (no bus, sudo refused) is not an issued stop.
 *   6. The boot reaper gives its stop claim back, and keeps the unit's tracking record, when no
 *      stop was issued.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AssistantId, CapabilityManifest, ExecutionRequest, NormalizedEvent, RunHandle, RunId, TaskId } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore, configureExitProofs, heldByLiveIncarnation, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, SystemExitEvidence, attemptUnit, setExitEvidence } from "../src/modules/exit-evidence.js";
import { AGENT_UNITS_DIR } from "../src/modules/harness/provider-processes.js";
import { ApprovalService } from "../src/modules/harness/approval-service.js";
import { EventRecorder } from "../src/modules/harness/event-recorder.js";
import { HarnessRecovery } from "../src/modules/harness/recovery.js";
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


const request2 = (n: number): ExecutionRequest => ({ ...request(), executionRequestId: `erq_${n}`, taskId: `AG-${n}` as TaskId,
  runSpec: { ...request().runSpec, taskId: `AG-${n}` as TaskId } });

describe("findings 1 and 2: a second plane's boot and a session another live plane holds", () => {
  it("leaves a session still waiting for a provider start slot: lease, state and outcome", async () => {
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-2','g','{}','t','t')").run();
    let openStart!: () => void;
    const gate = new Promise<void>((r) => { openStart = r; });
    const fake = new FakeAdapter("a1" as AssistantId);
    const real = fake.start.bind(fake);
    fake.start = async (spec) => { await gate; return real(spec); };
    const runner = new SessionRunner(deps(fake, { maxConcurrentProviderStarts: 1 }));
    const x = runner.run(request());
    await until(() => attempt()?.state === "starting", "the first session's entry");
    const y = runner.run(request2(2));
    const waiting = () => db.prepare("SELECT id, session_state, lease_token, lease_incarnation FROM runs WHERE task_id = 'AG-2'").get() as { id: string; session_state: string; lease_token: string | null; lease_incarnation: string | null } | undefined;
    await until(() => !!waiting()?.lease_token, "the second session's lease");
    const before = waiting()!;
    expect(before.lease_incarnation).toMatch(/^inc_/);
    expect(db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE task_id = 'AG-2' AND state != 'held'").get()).toEqual({ n: 0 });

    const other = open();
    setExitEvidence(other, ev);
    const otherStore = new SessionStore(other);
    await new HarnessRecovery({
      store: otherStore, approvals: new ApprovalService(other),
      checkpoints: { create: async () => ({ id: "ckpt_r", gitRef: null }) },
      registry: { adapter: () => fake, manifest: () => MANIFEST },
      liveElsewhere: (id) => heldByLiveIncarnation(other, id),
    }).reconcileOnBoot();
    // Before the fix: the lease was cleared and the waiting session FAILED before it entered.
    expect(waiting()).toEqual(before);
    expect(otherStore.get(before.id)!.state).not.toBe("FAILED");

    openStart();
    expect((await x).outcome).toBe("completed");
    expect((await y).outcome).toBe("completed"); // its ackHandle CAS still holds
  });

  it("a lease recorded by a dead incarnation is voided and recovered as before", () => {
    const sid = "run_dead_lease";
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, execution_request_id, session_state, lease_token, lease_expires_at, lease_incarnation) VALUES (?, 'AG-1', 'a1', 'ACTIVE', 't', 'erq_dead', 'RUNNING', 'lease_x', '2999-01-01T00:00:00Z', 'inc_gone')").run(sid);
    expect(heldByLiveIncarnation(db, sid)).toBe(false);
    expect(store.voidAllLeases(() => false)).toBe(1);
    expect(db.prepare("SELECT lease_token, lease_incarnation FROM runs WHERE id = ?").get(sid)).toEqual({ lease_token: null, lease_incarnation: null });
  });

  it("voidAllLeases clears only the lease it read: one taken since is left", () => {
    const sid = "run_race";
    db.prepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, execution_request_id, session_state, lease_token, lease_expires_at) VALUES (?, 'AG-1', 'a1', 'ACTIVE', 't', 'erq_race', 'STARTING', 'lease_old', '2999-01-01T00:00:00Z')").run(sid);
    // The keep predicate runs after the read: a runner takes the lease there.
    const cleared = store.voidAllLeases(() => { db.prepare("UPDATE runs SET lease_token = 'lease_new' WHERE id = ?").run(sid); return false; });
    expect(cleared).toBe(0);
    expect(db.prepare("SELECT lease_token FROM runs WHERE id = ?").get(sid)).toEqual({ lease_token: "lease_new" });
  });
});

describe("finding 2: a full boot parks nothing a live plane still runs", () => {
  let home: string; let config: ResolvedConfig; let built1: BuiltServer | undefined; let built2: BuiltServer | undefined; let d1: Db; let d2: Db;
  const A = "fake-a" as AssistantId;
  afterEach(async () => {
    for (const b of [built1, built2]) if (b) { await b.orchestrator.shutdown(); await b.app.close(); }
    built1 = built2 = undefined;
    for (const d of [d1, d2]) if (d?.open) { stopExitWatches(d); d.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  const reaches = (b: BuiltServer, id: string, states: string[]) => new Promise<string>((resolve) => {
    const now = b.tasks.get(id)?.state;
    if (now && states.includes(now)) return resolve(now);
    const off = b.bus.subscribe(id, (p) => { if (p.kind === "state" && states.includes(p.state!.state)) { off(); resolve(p.state!.state); } });
  });

  it("the second plane leaves the RUNNING task and its session; the first runner then completes", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-boot-"));
    config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { [A]: { provider: "fake" } };
    config.execution.harnessModes.single = true;
    d1 = openDb(config.dbPath); built1 = buildServer({ config, db: d1 });
    built1.registry.init(); await built1.registry.syncAll();
    setExitEvidence(d1, ev);
    const adapter = built1.registry.adapter(A);
    const real = adapter.start.bind(adapter);
    let openStart!: () => void;
    const gate = new Promise<void>((r) => { openStart = r; });
    vi.spyOn(adapter, "start").mockImplementation(async (spec) => { await gate; return real(spec); });
    const id = built1.tasks.create({ goal: "do the work" }).taskId;
    built1.tasks.transition(id, "ROUTING");
    await built1.orchestrator.startTask(id, A);
    const session = () => d1.prepare("SELECT id, session_state, lease_token FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL").get(id) as { id: string; session_state: string; lease_token: string | null };
    await until(() => !!session()?.lease_token, "the first plane's session lease");
    const before = session();

    d2 = openDb(config.dbPath); built2 = buildServer({ config, db: d2 });
    setExitEvidence(d2, ev);
    await built2.orchestrator.reconcileOnBoot();
    // Before the fix: the task went WAITING_INPUT (harness_error) while the first plane still ran it.
    expect(built1.tasks.get(id)!.state).toBe("RUNNING");
    expect(session()).toEqual(before);

    openStart();
    expect(await reaches(built1, id, ["COMPLETED", "FAILED", "WAITING_INPUT"])).toBe("COMPLETED");
  });
});

describe("finding 3: a return() result that omits done is not a close", () => {
  it("a cleanup value yielded by return() without `done` keeps the stream open until it ends", async () => {
    let openStart!: () => void; let endStream!: () => void;
    const startGate = new Promise<void>((r) => { openStart = r; });
    const endGate = new Promise<void>((r) => { endStream = r; });
    let reads = 0;
    const adapter = scripted({
      start: async () => { await startGate; return handle; },
      iterator: () => ({
        next: () => { reads += 1; return endGate.then(() => ({ done: true, value: undefined }) as IteratorResult<NormalizedEvent>); },
        return: (async () => ({ value: ev1("message", { summary: "cleanup" }) })) as never,
      }),
    });
    const run = new SessionRunner(deps(adapter)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    expect(store.requestCancel(attempt().session_id!)).toBe(true);
    openStart();
    await run;
    await sleep(30);
    // Before the fix: stream_closed_unverified with the tail never read.
    expect(attempt().exit_proof).toBeNull();
    expect(attempt().state).not.toBe("settled");
    expect(reads).toBeGreaterThan(0); // the tail is read to its end
    endStream();
    await until(() => attempt().state === "settled", "the stream end");
    expect(attempt().exit_proof).toBe("stream_closed_unverified");
  });
});

describe("finding 4: a legacy events() that throws before it hands out an iterator", () => {
  let home: string; let built: BuiltServer | undefined; let ldb: Db;
  const A = "fake-a" as AssistantId;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    if (ldb?.open) { stopExitWatches(ldb); ldb.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("ends the run and settles its attempt", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-events-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { [A]: { provider: "fake" } };
    config.execution.harnessModes.single = false;
    ldb = openDb(config.dbPath); built = buildServer({ config, db: ldb });
    built.registry.init(); await built.registry.syncAll();
    const id = built.tasks.create({ goal: "do the work" }).taskId;
    built.tasks.transition(id, "ROUTING");
    vi.spyOn(built.registry.adapter(A), "events").mockImplementation(() => { throw new Error("run already finished"); });
    const { runId } = await built.orchestrator.startTask(id, A);
    // Before the fix: consume rejected, the run stayed active (ended_at NULL) and the attempt live.
    await until(() => !!(ldb.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as { ended_at: string | null }).ended_at, "the run's end");
    const a = ldb.prepare("SELECT state, exit_proof FROM execution_attempts WHERE task_id = ?").get(id);
    expect(a).toEqual({ state: "settled", exit_proof: "stream_closed_unverified" });
  });
});

describe("finding 5: a stop that no manager answered is not an issued stop", () => {
  let root: string; let savedPath: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stop-evidence-r272-"));
    savedPath = process.env.PATH;
  });
  afterEach(() => { process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); });
  const script = (name: string, rc: number) => { const f = join(root, name); writeFileSync(f, `#!/bin/sh\nexit ${rc}\n`, { mode: 0o755 }); return f; };
  const planeUnit = attemptUnit("att_0a1b2c3d", "plane");
  const agentUnit = attemptUnit("att_0a1b2c3d", "agent");

  it.runIf(process.platform === "linux")("plane lane: systemctl exit 0 and 5 (unit not loaded) are stops; no bus (1), a signal or a missing binary are not", async () => {
    for (const [rc, issued] of [[0, true], [5, true], [1, false], [4, false]] as const) {
      const bin = join(root, `bin${rc}`); mkdirSync(bin);
      writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nexit ${rc}\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${savedPath}`;
      await expect(new SystemExitEvidence({}).stopUnit(planeUnit, "plane")).resolves.toBe(issued);
    }
    process.env.PATH = join(root, "empty");
    await expect(new SystemExitEvidence({}).stopUnit(planeUnit, "plane")).resolves.toBe(false);
  });

  it.runIf(process.platform === "linux")("agent lane: only a sudo/wrapper exit 0 is a stop", async () => {
    const agent = (sudo: string) => ({ user: "aos-agent", group: "aos", sudo, wrapper: "/usr/local/lib/aos/run-as-agent" });
    await expect(new SystemExitEvidence({ agentUser: agent(script("sudo-ok", 0)) }).stopUnit(agentUnit, "agent")).resolves.toBe(true);
    await expect(new SystemExitEvidence({ agentUser: agent(script("sudo-refused", 1)) }).stopUnit(agentUnit, "agent")).resolves.toBe(false);
    await expect(new SystemExitEvidence({ agentUser: agent(script("sudo-bad-id", 64)) }).stopUnit(agentUnit, "agent")).resolves.toBe(false);
  });

  it.runIf(process.platform === "linux")("POST /stop-unit against an unreachable manager answers 409 and moves nothing", async () => {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\necho 'Failed to connect to bus' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    const home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-stop-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const d = openDb(config.dbPath); dbs.push(d);
    const built = buildServer({ config, db: d });
    try {
      setExitEvidence(d, new SystemExitEvidence({}));
      d.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
      // The plane's own uid, so the stop reaches the (fake) systemctl: another uid is refused before any command.
      const id = entered(d, { state: "live", seen: true, owner: { uid: process.getuid!() }, incarnation: { id: "inc_up", pid: 999_995, procStart: "9" } });
      ev.processes.set(999_995, "9");
      const auth = { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` };
      const stop = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/stop-unit`, headers: auth });
      expect(stop.statusCode).toBe(409);
      expect(stop.json()).toEqual({ error: "stop_unavailable" });
      expect(row(d, id)).toMatchObject({ state: "live", exit_proof: null });
    } finally {
      await built.orchestrator.shutdown(); await built.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("finding 6: the boot reaper keeps its retry when it issued no stop", () => {
  let home: string; let built: BuiltServer | undefined; let d: Db;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    if (d?.open) { stopExitWatches(d); d.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("an attempt's claim and a pre-attempt unit's tracking file survive a boot with no reachable stop", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-reap-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.execution.harnessModes.single = true;
    d = openDb(config.dbPath); built = buildServer({ config, db: d });
    d.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
    d.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
    setExitEvidence(d, ev);
    const owner = { uid: 2002, user: "aos-agent-old", wrapper: "/opt/aos/aos-launch" };
    const id = entered(d, { runAs: "agent", owner, seen: true });
    const unit = row(d, id).provider_unit!;
    ev.units.set(unit, "populated");
    const dirOf = join(config.dir, AGENT_UNITS_DIR); mkdirSync(dirOf, { recursive: true });
    const file = join(dirOf, "3999999");
    writeFileSync(file, `${id}\nses_pre\n`);

    ev.stoppable = false; // the manager is unreachable for this boot
    await built.orchestrator.reconcileOnBoot();
    expect(ev.stopped).toEqual([]);
    expect(existsSync(file)).toBe(true); // before the fix: removed, so a restored config never stopped ses_pre
    sweep(d, "boot"); // the proof test's recovery stop: still not issued
    await sleep(20);
    expect(ev.stopped).toEqual([]);

    ev.stoppable = true; // the manager is back
    sweep(d, "runtime");
    await until(() => ev.stopped.includes(unit), "the retried recovery stop"); // before the fix: the claim was spent
    ev.stopped.length = 0;
    await built.orchestrator.reconcileOnBoot();
    // The attempt is stopped once (its claim holds); the pre-attempt unit is stopped now, and its record goes.
    expect(ev.stopped).toEqual(["aos-run-ses_pre.scope"]);
    expect(existsSync(file)).toBe(false);
  });
});
