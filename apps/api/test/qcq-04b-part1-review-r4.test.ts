/**
 * #272 review (Codex, 2026-11-27, round 4): one regression test per failure Codex reproduced on
 * the round-3 fix. The lease is the arbiter: whether another plane is alive only decides whether an
 * unexpired lease may be cleared, never whether an expired one is recovered.
 *
 *   1. The legacy boot step checks ownership and fails the task in one write transaction.
 *   2. A lease taken before migration 060 (no recorded holder) is left until it expires.
 *   3. A missing /proc mount is not proof that a process is gone.
 *   4. A holder whose start time cannot be read does not strand an expired lease: boot recovers it,
 *      and the lease sweeper settles the task of a session it recovers.
 *   5. The boot reaper keeps a unit's tracking record until the unit reads absent or empty, however
 *      the installed wrapper answered the stop.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantId, CapabilityManifest, ExecutionRequest, TaskId } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { configureExitProofs, ensureIncarnationRow, heldByLiveIncarnation, incarnationState, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, SystemExitEvidence, setExitEvidence } from "../src/modules/exit-evidence.js";
import { AGENT_UNITS_DIR } from "../src/modules/harness/provider-processes.js";
import { ApprovalService } from "../src/modules/harness/approval-service.js";
import { EventRecorder } from "../src/modules/harness/event-recorder.js";
import { HarnessRecovery } from "../src/modules/harness/recovery.js";
import { SessionRunner } from "../src/modules/harness/session-runner.js";
import { SessionStore } from "../src/modules/harness/session-store.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let dir: string; let db: Db; let ev: FakeExitEvidence;
const dbs: Db[] = [];
function open(path = join(dir, "t.db")): Db {
  const d = openDb(path); dbs.push(d);
  setExitEvidence(d, ev);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-"));
  ev = new FakeExitEvidence();
  db = open();
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  configureExitProofs(db, { watchMs: 5, stopEvidenceMs: 150 });
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
const request = (): ExecutionRequest => ({
  schemaVersion: 1, executionRequestId: "erq_1", taskId: "AG-1" as TaskId, attempt: 1, assistantId: "a1" as AssistantId, routingDecisionRef: "rd_1",
  runSpec: { taskId: "AG-1" as TaskId, prompt: "do the thing", workdir: dir, permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 60_000 } },
  policy: { budget: { enforcement: "advisory" }, timeout: { hardMs: 60_000 }, approval: { mode: "auto-approve" }, tools: { mode: "audit" },
    checkpoint: { onSoftLimit: true }, isolation: { required: "ambient" } },
  context: {}, verification: [], origin: { kind: "fresh" },
});
async function until(what: () => boolean, label: string, ms = 3000) {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const PAST = "2000-01-01T00:00:00.000Z";

type Lease = { id: string; session_state: string; lease_token: string | null; lease_expires_at: string | null; lease_incarnation: string | null };

describe("finding 1: the legacy boot step re-checks inside its write", () => {
  let home: string; let built: BuiltServer | undefined; let d: Db; let other: Db;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    for (const x of [d, other]) if (x?.open) { stopExitWatches(x); x.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("a plane that takes a session's lease after the ownership check is not failed from under", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-race-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.execution.harnessModes.single = true;
    d = openDb(config.dbPath); built = buildServer({ config, db: d });
    setExitEvidence(d, ev);
    other = openDb(config.dbPath); setExitEvidence(other, ev);
    const holder = ensureIncarnationRow(other, new Date().toISOString()); // a second live plane on the database
    d.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
    const id = built.tasks.create({ goal: "g" }).taskId;
    built.tasks.transition(id, "ROUTING");
    built.tasks.transition(id, "RUNNING");

    // The pause: after the boot step's ownership and dispatch checks, the other plane takes a lease.
    const realPrepare = d.prepare.bind(d);
    let raced = false;
    vi.spyOn(d, "prepare").mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes("FROM dispatches d WHERE d.task_id")) return stmt;
      const get = stmt.get.bind(stmt);
      (stmt as unknown as { get: unknown }).get = (...args: unknown[]) => {
        const r = (get as (...a: unknown[]) => unknown)(...args);
        if (!raced) {
          raced = true;
          realPrepare("INSERT INTO runs (id, task_id, assistant_id, state, started_at, execution_request_id, session_state, lease_token, lease_expires_at, lease_incarnation) VALUES ('run_raced', ?, 'a1', 'ACTIVE', ?, 'erq_raced', 'STARTING', 'lease_raced', '2999-01-01T00:00:00.000Z', ?)")
            .run(id, new Date().toISOString(), holder);
        }
        return r;
      };
      return stmt;
    }) as typeof d.prepare);

    await built.orchestrator.reconcileOnBoot();
    expect(raced).toBe(true);
    // Before the fix: FAILED, and the session's scheduler then fenced the live runner.
    expect(built.tasks.get(id)!.state).toBe("RUNNING");
    expect(d.prepare("SELECT ended_at FROM runs WHERE id = 'run_raced'").get()).toEqual({ ended_at: null });
    d.prepare("DELETE FROM runs WHERE id = 'run_raced'").run(); // no runner behind it: nothing for shutdown to wait on
  });
});

/** A session whose runner waits for a provider start slot, so it holds a lease and no attempt entry. */
async function leasedSession(): Promise<{ sid: string; fake: FakeAdapter; run: Promise<unknown>; openStart: () => void }> {
  let openStart!: () => void;
  const gate = new Promise<void>((r) => { openStart = r; });
  const fake = new FakeAdapter("a1" as AssistantId);
  const real = fake.start.bind(fake);
  fake.start = async (spec) => { await gate; return real(spec); };
  const runner = new SessionRunner({
    store: new SessionStore(db), recorder: new EventRecorder(db), approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
    registry: { adapter: () => fake, manifest: () => MANIFEST }, softThresholdPct: 80, approvalPollMs: 5,
  });
  const run = runner.run(request());
  const lease = () => db.prepare("SELECT id, session_state, lease_token, lease_expires_at, lease_incarnation FROM runs WHERE task_id = 'AG-1'").get() as Lease | undefined;
  await until(() => !!lease()?.lease_token, "the session's lease");
  return { sid: lease()!.id, fake, run, openStart };
}

describe("finding 2: a lease from before migration 060 is left until it expires", () => {
  it("an unexpired lease with no recorded holder survives another plane's boot, then is recovered once expired", async () => {
    const { sid, fake, run, openStart } = await leasedSession();
    // As rows from before migration 060: neither the lease nor the entry names an incarnation.
    db.prepare("UPDATE runs SET lease_incarnation = NULL WHERE id = ?").run(sid);
    db.prepare("UPDATE execution_attempts SET entered_incarnation = NULL WHERE session_id = ?").run(sid);
    const other = open();
    const otherStore = new SessionStore(other);
    expect(heldByLiveIncarnation(other, sid)).toBe(true);
    const recovery = () => new HarnessRecovery({
      store: otherStore, approvals: new ApprovalService(other),
      checkpoints: { create: async () => ({ id: "ckpt_r", gitRef: null }) },
      registry: { adapter: () => fake, manifest: () => MANIFEST },
      liveElsewhere: (id) => heldByLiveIncarnation(other, id),
    });
    const before = db.prepare("SELECT lease_token, lease_expires_at FROM runs WHERE id = ?").get(sid);
    await recovery().reconcileOnBoot();
    // Before the fix: the lease was cleared and the live runner's session FAILED.
    expect(db.prepare("SELECT lease_token, lease_expires_at FROM runs WHERE id = ?").get(sid)).toEqual(before);
    expect(otherStore.get(sid)!.state).not.toBe("FAILED");

    db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(PAST, sid);
    expect(heldByLiveIncarnation(other, sid)).toBe(false);
    openStart();
    await run.catch(() => undefined);
  });
});

describe("finding 3: a missing /proc mount does not make a live holder look dead", () => {
  it("reads every pid as unreadable when procfs is not there, and gone only when this process is listed", () => {
    const absent = new SystemExitEvidence({ procRoot: join(dir, "no-proc") });
    expect(absent.processStart(4242)).toBe("unreadable"); // before the fix: null (gone)
    const proc = join(dir, "proc"); mkdirSync(join(proc, String(process.pid)), { recursive: true });
    expect(new SystemExitEvidence({ procRoot: proc }).processStart(4242)).toBeNull();
  });

  it("another plane's incarnation stays alive on a host with no procfs", () => {
    db.prepare("INSERT INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES ('inc_other', 424242, '99', 'unavailable', 't')").run();
    setExitEvidence(db, new SystemExitEvidence({ procRoot: join(dir, "no-proc") }));
    expect(incarnationState(db, "inc_other")).toBe("alive");
  });
});

describe("finding 4: a holder whose start time cannot be read does not strand its task", () => {
  let home: string; let built1: BuiltServer | undefined; let built2: BuiltServer | undefined; let d1: Db; let d2: Db; let config: ResolvedConfig;
  const A = "fake-a" as AssistantId;
  afterEach(async () => {
    for (const b of [built1, built2]) if (b) { await b.orchestrator.shutdown(); await b.app.close(); }
    built1 = built2 = undefined;
    for (const x of [d1, d2]) if (x?.open) { stopExitWatches(x); x.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  /** The first plane has a RUNNING task whose session holds a lease for a holder that has since died unreadably. */
  async function strandedSetup(): Promise<{ id: string; sid: string; second: BuiltServer }> {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-dead-"));
    config = loadConfig({ AGENT_PLANE_HOME: home });
    config.assistants = { [A]: { provider: "fake" } };
    config.execution.harnessModes.single = true;
    d1 = openDb(config.dbPath); built1 = buildServer({ config, db: d1 });
    built1.registry.init(); await built1.registry.syncAll();
    setExitEvidence(d1, ev);
    const adapter = built1.registry.adapter(A);
    const real = adapter.start.bind(adapter);
    const gate = new Promise<void>(() => undefined); // never opens: the first plane is "killed"
    vi.spyOn(adapter, "start").mockImplementation(async (spec) => { await gate; return real(spec); });
    const id = built1.tasks.create({ goal: "do the work" }).taskId;
    built1.tasks.transition(id, "ROUTING");
    await built1.orchestrator.startTask(id, A);
    const session = () => d1.prepare("SELECT id, lease_token FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL").get(id) as { id: string; lease_token: string | null };
    await until(() => !!session()?.lease_token, "the first plane's session lease");
    const sid = session().id;
    d1.prepare("INSERT INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES ('inc_dead', 424242, NULL, 'boot-fake-1', 't')").run();
    ev.processes.set(424242, "unreadable");
    d1.prepare("UPDATE runs SET lease_incarnation = 'inc_dead' WHERE id = ?").run(sid);
    d2 = openDb(config.dbPath); built2 = buildServer({ config, db: d2 });
    built2.registry.init(); await built2.registry.syncAll();
    setExitEvidence(d2, ev);
    return { id, sid, second: built2 };
  }

  it("boot recovers an expired lease whatever its holder reads as, and settles the task", async () => {
    const { id, sid, second } = await strandedSetup();
    d1.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(PAST, sid);
    expect(heldByLiveIncarnation(d2, sid)).toBe(false); // before the fix: the unreadable holder kept it
    await second.orchestrator.reconcileOnBoot();
    expect(second.tasks.get(id)!.state).not.toBe("RUNNING");
    expect(d2.prepare("SELECT lease_token FROM runs WHERE id = ?").get(sid)).toEqual({ lease_token: null });
  });

  it("the lease sweep that later recovers an unexpired one's session leaves its task settled", async () => {
    const { id, sid, second } = await strandedSetup();
    await second.orchestrator.reconcileOnBoot();
    expect(second.tasks.get(id)!.state).toBe("RUNNING"); // the lease is still good: preserved
    d1.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run(PAST, sid);
    const recovery = new HarnessRecovery({
      store: new SessionStore(d2), approvals: new ApprovalService(d2), checkpoints: second.checkpoints, registry: second.registry,
      liveElsewhere: (s) => heldByLiveIncarnation(d2, s),
    });
    const outcomes = await recovery.sweepExpiredLeases();
    await second.orchestrator.settleSweptSessions(outcomes); // before the fix: no such step; the task read RUNNING with no owner
    expect(second.tasks.get(id)!.state).not.toBe("RUNNING");
  });
});

describe("finding 5: the reaper keeps a unit's record until the unit is gone", () => {
  let home: string; let built: BuiltServer | undefined; let d: Db;
  afterEach(async () => {
    if (built) { await built.orchestrator.shutdown(); await built.app.close(); built = undefined; }
    if (d?.open) { stopExitWatches(d); d.close(); }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("a stop the wrapper answered with success, over a scope that is still populated, is retried next boot", async () => {
    home = mkdtempSync(join(tmpdir(), "qcq-04b-r272-r4-reap-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    config.execution.harnessModes.single = true;
    d = openDb(config.dbPath); built = buildServer({ config, db: d });
    setExitEvidence(d, ev);
    const unit = "aos-run-ses_pre.scope";
    ev.units.set(unit, "populated"); // the wrapper swallowed a failed `systemctl stop`
    const dirOf = join(config.dir, AGENT_UNITS_DIR); mkdirSync(dirOf, { recursive: true });
    const file = join(dirOf, "3999999");
    writeFileSync(file, "ses_pre\n");

    await built.orchestrator.reconcileOnBoot();
    expect(ev.stopped).toEqual([unit]);
    expect(existsSync(file)).toBe(true); // before the fix: removed, and nothing ever retried
    ev.units.set(unit, "empty");
    ev.stopped.length = 0;
    await built.orchestrator.reconcileOnBoot();
    expect(ev.stopped).toEqual([unit]);
    expect(existsSync(file)).toBe(false);
  });
});
