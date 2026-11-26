/**
 * qcq-04b part 1 (review packet 2.6.1, section 5 test 5): the strong exit proofs, driven through the
 * real SessionRunner and the fake adapter declaring `scopedSpawn`, with the host's evidence replaced
 * by `FakeExitEvidence` (the same seam `SystemExitEvidence` fills on a host). Store-level cases
 * (boot identity, the agent-lane stop, duplicates) insert their entered attempt directly.
 *
 * The real cgroup and `/proc` reads are covered against fake trees in exit-evidence.test.ts; the
 * Claude adapter's own scope and spawn-closed report in packages/adapters/test/claude-scope-spawn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AssistantId, CapabilityManifest, ExecutionRequest, RunSpec, TaskId } from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { AttemptStore, configureExitProofs, stopExitWatches } from "../src/modules/attempts.js";
import { FakeExitEvidence, setExitEvidence } from "../src/modules/exit-evidence.js";
import { ApprovalService } from "../src/modules/harness/approval-service.js";
import { EventRecorder } from "../src/modules/harness/event-recorder.js";
import { SessionRunner, type RunnerDeps } from "../src/modules/harness/session-runner.js";
import { SessionStore } from "../src/modules/harness/session-store.js";
import { buildServer } from "../src/server.js";

let dir: string; let db: Db; let store: SessionStore; let ev: FakeExitEvidence;
const dbs: Db[] = [];

function open(path = join(dir, "t.db")): Db {
  const d = openDb(path); dbs.push(d);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcq-04b-exit-"));
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
const deps = (adapter: AgentAdapter): RunnerDeps => ({
  store, recorder: new EventRecorder(db), approvals: new ApprovalService(db),
  checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
  registry: { adapter: () => adapter, manifest: () => MANIFEST }, softThresholdPct: 80, approvalPollMs: 5,
});
const request = (): ExecutionRequest => ({
  schemaVersion: 1, executionRequestId: "erq_1", taskId: "AG-1" as TaskId, attempt: 1, assistantId: "a1" as AssistantId, routingDecisionRef: "rd_1",
  runSpec: { taskId: "AG-1" as TaskId, prompt: "do the thing", workdir: dir, permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 60_000 } },
  policy: { budget: { enforcement: "advisory" }, timeout: { hardMs: 60_000 }, approval: { mode: "auto-approve" }, tools: { mode: "audit" },
    checkpoint: { onSoftLimit: true }, isolation: { required: "ambient" } },
  context: {}, verification: [], origin: { kind: "fresh" },
});

type Attempt = { attempt_id: string; state: string; exit_proof: string | null; provider_unit: string | null; provider_unit_seen_at: string | null; stop_requested_at: string | null };
const attempt = (): Attempt => db.prepare("SELECT * FROM execution_attempts WHERE task_id = 'AG-1' ORDER BY created_at DESC LIMIT 1").get() as Attempt;
const eventsOf = (type: string) => db.prepare("SELECT payload FROM scheduler_events WHERE task_id = 'AG-1' AND type = ?").all(type) as { payload: string }[];
async function until(what: () => boolean, label: string, ms = 3000) {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A scoped fake whose `start` sees the plane's scope, and optionally waits (an unsettled provider call). */
function scoped(opts: { onStart?: (spec: RunSpec) => void; gate?: Promise<void> } = {}) {
  const fake = new FakeAdapter("a1" as AssistantId, undefined, { scopedSpawn: true });
  const real = fake.start.bind(fake);
  const specs: RunSpec[] = [];
  fake.start = async (spec) => { specs.push(spec); opts.onStart?.(spec); if (opts.gate) await opts.gate; return real(spec); };
  return { fake, specs };
}

describe("registration and the strong proofs (packet 2.6.1, test 5 r3/r5)", () => {
  it("names the scope after the attempt and passes it to the adapter on the plane lane", async () => {
    const { fake, specs } = scoped({ onStart: (s) => ev.units.set(`${s.scope!.unit}.scope`, "populated") });
    await new SessionRunner(deps(fake)).run(request());
    const a = attempt();
    expect(a.provider_unit).toBe(`aos-att-${a.attempt_id}.scope`);
    expect(specs[0]!.scope).toEqual({ unit: `aos-att-${a.attempt_id}` });
  });

  it("result before exit: the result commits with the unit populated; the attempt holds until the unit reads empty (cgroup_empty)", async () => {
    const { fake } = scoped({ onStart: (s) => ev.units.set(`${s.scope!.unit}.scope`, "populated") });
    const result = await new SessionRunner(deps(fake)).run(request());
    expect(result.terminalState).toBe("COMPLETED");
    // The result row is in; the provider's cgroup still has a process: registered, no proof.
    await sleep(30);
    let a = attempt();
    expect(a).toMatchObject({ exit_proof: null, provider_unit_seen_at: expect.any(String) });
    expect(["live", "starting", "stopping"]).toContain(a.state);
    // A sweep between the result and the runner's end is inert too.
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "runtime", "sweep"))();
    expect(attempt().exit_proof).toBeNull();
    // The last process exits: the exit watch writes the strong proof.
    ev.units.set(a.provider_unit!, "empty");
    await until(() => attempt().state === "settled", "cgroup_empty");
    a = attempt();
    expect(a.exit_proof).toBe("cgroup_empty");
  });

  it("tracker gone, worker alive: a populated unit after the stream ended keeps the attempt, then ambiguous with attempt.stop_unconfirmed", async () => {
    const { fake } = scoped({ onStart: (s) => ev.units.set(`${s.scope!.unit}.scope`, "populated") });
    await new SessionRunner(deps(fake)).run(request());
    await sleep(40);
    expect(attempt().exit_proof).toBeNull();
    await until(() => attempt().state === "ambiguous", "ambiguous after stopEvidenceMs");
    const [unconfirmed] = eventsOf("attempt.stop_unconfirmed");
    expect(JSON.parse(unconfirmed!.payload)).toMatchObject({ attemptId: attempt().attempt_id, unit: attempt().provider_unit });
    // Only a strong proof settles it from there: the sweep reads the unit empty.
    ev.units.set(attempt().provider_unit!, "empty");
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "runtime", "sweep"))();
    expect(attempt()).toMatchObject({ state: "settled", exit_proof: "cgroup_empty" });
  });

  it("(c) never registered, the adapter call settled, no launcher and the unit absent: unscoped_exit", async () => {
    const { fake } = scoped();
    await new SessionRunner(deps(fake)).run(request());
    await until(() => attempt().state === "settled", "unscoped_exit");
    expect(attempt()).toMatchObject({ exit_proof: "unscoped_exit", provider_unit_seen_at: null });
  });

  it("(a) a live launcher with the unit not yet created: no proof", async () => {
    const { fake } = scoped({ onStart: () => ev.launchers.add(attempt().attempt_id) });
    await new SessionRunner(deps(fake)).run(request());
    await sleep(40);
    expect(attempt()).toMatchObject({ exit_proof: null, provider_unit_seen_at: null });
    // The launcher exits without ever creating the scope.
    ev.launchers.clear();
    await until(() => attempt().state === "settled", "unscoped_exit once the launcher is gone");
    expect(attempt().exit_proof).toBe("unscoped_exit");
  });

  it("(d) the sweep does not read an absent unit as unscoped_exit while the adapter call is unsettled", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    const { fake } = scoped({ gate });
    const run = new SessionRunner(deps(fake)).run(request());
    await until(() => attempt()?.state === "starting", "the entry commit");
    await sleep(30);
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "runtime", "sweep"))();
    expect(attempt()).toMatchObject({ state: "starting", exit_proof: null });
    openGate();
    await run;
    await until(() => attempt().state === "settled", "unscoped_exit after the call settled");
    expect(attempt().exit_proof).toBe("unscoped_exit");
  });

  it("no cgroup on the lane: no unit is assigned and the attempt settles on stream_closed_unverified", async () => {
    ev.lanes.plane = "no systemd user manager for uid 1000";
    const { fake, specs } = scoped();
    await new SessionRunner(deps(fake)).run(request());
    expect(specs[0]!.scope).toBeUndefined();
    expect(attempt()).toMatchObject({ provider_unit: null, state: "settled", exit_proof: "stream_closed_unverified" });
  });

  it("an adapter that does not declare scopedSpawn gets no unit, whatever the host reads", async () => {
    const fake = new FakeAdapter("a1" as AssistantId);
    await new SessionRunner(deps(fake)).run(request());
    expect(attempt()).toMatchObject({ provider_unit: null, exit_proof: "stream_closed_unverified" });
  });
});

/** An entered attempt inserted as another (dead) incarnation left it: boot reads it fresh. */
function entered(d: Db, over: { runAs?: "plane" | "agent"; unit?: string | null; seen?: boolean; boot?: string; state?: string } = {}): string {
  const id = `att_${Math.random().toString(36).slice(2, 10)}`;
  const lane = over.runAs ?? "plane";
  const unit = over.unit === undefined ? `${lane === "plane" ? "aos-att" : "aos-run"}-${id}.scope` : over.unit;
  d.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, candidate_slot, run_as, account_source, queue_key, state,
      entered_at, entered_boot_id, provider_unit, provider_unit_seen_at, created_at, updated_at, reason)
    VALUES (?, 'AG-1', 'direct', 'harness', 0, ?, 'none', 'k', ?, 't', ?, ?, ?, 't', 't', 'test')`)
    .run(id, lane, over.state ?? "live", over.boot ?? "boot-fake-1", unit, over.seen ? "t" : null);
  d.prepare("INSERT INTO resource_claims (attempt_id, task_id, resource, units, claimed_at) VALUES (?, 'AG-1', 'gpu', 1, 't')").run(id);
  return id;
}
const row = (d: Db, id: string) => d.prepare("SELECT * FROM execution_attempts WHERE attempt_id = ?").get(id) as Attempt;
const liveClaims = (d: Db, id: string) => (d.prepare("SELECT COUNT(*) n FROM resource_claims WHERE attempt_id = ? AND released_at IS NULL").get(id) as { n: number }).n;

describe("boot identity (test 5 r5)", () => {
  it("a changed boot_id settles an attempt another incarnation entered as host_rebooted", () => {
    const id = entered(db, { boot: "boot-old", seen: true });
    ev.units.set(row(db, id).provider_unit!, "populated"); // a stale read cannot outvote the reboot
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "boot", "boot"))();
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "host_rebooted" });
    expect(liveClaims(db, id)).toBe(0);
  });

  it("the same boot_id with the wall clock moved back or forward gives nothing: a populated unit is stopped and held", async () => {
    const id = entered(db, { seen: true });
    const unit = row(db, id).provider_unit!;
    ev.units.set(unit, "populated");
    for (const at of ["2001-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      db.transaction(() => new AttemptStore(db, () => new Date(at)).settleIdle("AG-1", "boot", "boot"))();
      expect(row(db, id).exit_proof).toBeNull();
      expect(liveClaims(db, id)).toBe(1);
    }
    // Row 13: a dead incarnation's provider still running is stopped. The forward jump outruns
    // stopEvidenceMs, which can only make it `ambiguous`: claims held, never a proof.
    expect(row(db, id).state).toBe("ambiguous");
    await until(() => ev.stopped.includes(unit), "the unit stop");
    ev.units.set(unit, "absent"); // registered, now gone
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "runtime", "sweep"))();
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "cgroup_empty" });
  });

  it("an unavailable boot_id on either side never proves a reboot", () => {
    const id = entered(db, { boot: "unavailable" });
    ev.units.set(row(db, id).provider_unit!, "populated");
    db.transaction(() => new AttemptStore(db).settleIdle("AG-1", "boot", "boot"))();
    expect(row(db, id).exit_proof).toBeNull();
  });
});

describe("the agent lane, a failing stop and ambiguity (test 5 r4/r5 e)", () => {
  it("a stop that does not empty the scope keeps the claim; past stopEvidenceMs the attempt is ambiguous, not settled", async () => {
    let instant = Date.parse("2030-01-01T00:00:00Z");
    const now = () => new Date(instant);
    const id = entered(db, { runAs: "agent", seen: true });
    expect(row(db, id).provider_unit).toBe(`aos-run-${id}.scope`);
    ev.units.set(row(db, id).provider_unit!, "populated");
    const attempts = new AttemptStore(db, now);
    db.transaction(() => attempts.requestStop(row(db, id) as never, "cancel"))();
    // The wrapper's stop "succeeded" (FakeExitEvidence records it) but the scope still has a process.
    db.transaction(() => attempts.settleEntered(attempts.get(id)!, "sweep"))();
    expect(row(db, id)).toMatchObject({ state: "stopping", exit_proof: null });
    instant += 64_000;
    configureExitProofs(db, { stopEvidenceMs: 65_000 });
    db.transaction(() => attempts.settleEntered(attempts.get(id)!, "sweep"))();
    expect(row(db, id).state).toBe("stopping");
    instant += 2_000;
    db.transaction(() => attempts.settleEntered(attempts.get(id)!, "sweep"))();
    expect(row(db, id)).toMatchObject({ state: "ambiguous", exit_proof: null });
    expect(liveClaims(db, id)).toBe(1);
    expect(eventsOf("attempt.stop_unconfirmed")).toHaveLength(1);
  });
});

describe("duplicates are inert (test 5)", () => {
  it("a second stop request, and a settle of a final attempt, write nothing", () => {
    const id = entered(db, { unit: null });
    const attempts = new AttemptStore(db);
    db.transaction(() => { attempts.requestStop(attempts.get(id)!, "cancel"); attempts.requestStop(attempts.get(id)!, "cancel again"); })();
    expect(eventsOf("attempt.stopping")).toHaveLength(1);
    const first = row(db, id).stop_requested_at;
    // No unit: a dead incarnation's entered attempt with no owner settles boot_unverified.
    db.transaction(() => attempts.settleIdle("AG-1", "boot", "boot"))();
    expect(row(db, id)).toMatchObject({ state: "settled", exit_proof: "boot_unverified", stop_requested_at: first });
    const before = (db.prepare("SELECT COUNT(*) n FROM scheduler_events").get() as { n: number }).n;
    expect(db.transaction(() => attempts.settleEntered(attempts.get(id)!, "again"))()).toEqual([]);
    expect(db.transaction(() => attempts.settleIdle("AG-1", "boot", "again"))()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) n FROM scheduler_events").get() as { n: number }).n).toBe(before);
  });
});

describe("operator confirmation (test 5 r5, API 2.20)", () => {
  it("refuses with unit_populated and a stop link while the unit reads populated; stop-unit stops it; accepted once absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "qcq-04b-route-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    const d = open(config.dbPath);
    const built = buildServer({ config, db: d });
    try {
      setExitEvidence(d, ev);
      d.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
      const id = entered(d, { seen: true, state: "ambiguous" });
      const unit = row(d, id).provider_unit!;
      ev.units.set(unit, "populated");
      const auth = { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` };
      const refused = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/confirm-stopped`, headers: auth });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: "unit_populated", unit, stop: { method: "POST", path: `/api/attempts/${id}/stop-unit` } });
      expect(liveClaims(d, id)).toBe(1);

      const stop = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/stop-unit`, headers: auth });
      expect(stop.json()).toEqual({ attemptId: id, unit, stopRequested: true });
      // The sweep's recovery stop of the dead incarnation's populated unit (#268 review finding 7), then the operator's.
      expect(ev.stopped).toEqual([unit, unit]);

      ev.units.set(unit, "absent");
      const ok = await built.app.inject({ method: "POST", url: `/api/attempts/${id}/confirm-stopped`, headers: auth });
      // The stop's own sweep ran while the unit still read populated, so the operator's proof is the one written.
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ attemptId: id, state: "settled", proof: "operator_confirmed", released: 1 });
      expect(liveClaims(d, id)).toBe(0);

      const unknown = await built.app.inject({ method: "POST", url: "/api/attempts/att_missing/confirm-stopped", headers: auth });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await built.orchestrator.shutdown(); await built.app.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts an operator confirmation on an absent, never-registered unit", () => {
    const id = entered(db, { state: "ambiguous" });
    const r = db.transaction(() => new AttemptStore(db).confirmStopped(id, "operator"))();
    expect(r).toMatchObject({ ok: true, attempt: { state: "settled", exit_proof: "operator_confirmed" } });
  });
});
