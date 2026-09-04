/**
 * Increment 3 — rollback-terminalisation policy (§2 step 11) and the
 * mixed-live-ownership quarantine (§2 step 16).
 *
 * Part 1 drives `HarnessRecovery` directly (the `recovery.test.ts` idiom) over
 * every reachable non-terminal session state, proving the "single mode disabled
 * -> terminalise, don't resume-offer or park" policy is exhaustive and that
 * normal (mode-enabled) recovery is byte-unchanged.
 *
 * Part 2 drives the real `buildServer` composition root, proving the full
 * rollback property end to end: a new start takes the legacy path, and an
 * in-flight session that crashed while its mode was on settles to a terminal
 * state on the next boot and stays settled on a second boot (idempotent).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AssistantId,
  type CapabilityManifest,
  type ExecutionRequest,
  type ProviderSessionRef,
  type TaskId,
} from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { openDb, type Db } from "../../src/db/index.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";
import { HarnessRecovery } from "../../src/modules/harness/recovery.js";
import { VerificationStore } from "../../src/modules/harness/verification-store.js";
import { loadConfig } from "../../src/config.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import { credentialPath, readCredential } from "../../src/auth/credential-file.js";

// --- Part 1: HarnessRecovery unit level ------------------------------------

let dir: string;
let db: Db;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mode-rollback-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, mode, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 'single', 't', 't')",
  ).run();
  store = new SessionStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function request(reqId: string): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: reqId,
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt: "do it",
      workdir: "/tmp/wt",
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 1000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 1000 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "ambient" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
  };
}

type SeedTo = "PREPARED" | "STARTING" | "RUNNING" | "AWAITING_APPROVAL" | "VERIFYING" | "PAUSED" | "RESUMING";

/** Create a session and walk it to `to`, then drop the lease (simulated crash). */
function seedSession(opts: { reqId: string; to: SeedTo; providerSessionRef?: string }): string {
  store.recordRequest(request(opts.reqId));
  const id = store.createSession(opts.reqId).sessionId as string;
  if (opts.to === "PREPARED") return id;

  const t = store.acquireLease(id)!;
  store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: t });
  if (opts.to === "STARTING") {
    store.releaseLease(id, t);
    return id;
  }
  store.transition(id, {
    expectedVersion: 1,
    from: "STARTING",
    to: "RUNNING",
    leaseToken: t,
    ...(opts.providerSessionRef ? { patch: { providerSessionRef: opts.providerSessionRef as ProviderSessionRef } } : {}),
  });
  if (opts.to === "RUNNING") {
    store.releaseLease(id, t);
    return id;
  }
  if (opts.to === "AWAITING_APPROVAL") {
    store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "AWAITING_APPROVAL", leaseToken: t });
  } else if (opts.to === "VERIFYING") {
    store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "VERIFYING", leaseToken: t });
  } else if (opts.to === "PAUSED" || opts.to === "RESUMING") {
    store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "PAUSED", leaseToken: t });
    if (opts.to === "RESUMING") {
      store.transition(id, { expectedVersion: 3, from: "PAUSED", to: "RESUMING", leaseToken: t });
    }
  }
  store.releaseLease(id, t);
  return id;
}

function manifest(canResume: boolean): CapabilityManifest {
  return {
    assistantId: "a1" as AssistantId,
    provider: "fake",
    core: {
      models: [{ id: "m1" }],
      canResume,
      canMcp: false,
      supportsMidRunInput: true,
      reportsUsage: true,
      reportsLimits: true,
      execution: { shell: true, filesystem: true, web: "no" },
      auth: { state: "ok" },
    },
    harness: { usageAccounting: "none", toolGating: "none", approvalRelay: true, processIsolation: "none" },
    providerDetail: {},
    evidence: { source: "runtime-probe", observedAt: "t" },
  };
}

function recovery(opts: { canResume?: boolean; shouldTerminalizeOnRecovery?: (sessionId: string) => boolean }): HarnessRecovery {
  const m = manifest(opts.canResume ?? false);
  return new HarnessRecovery({
    store,
    approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: "ck_ok", gitRef: "ref1" }) },
    registry: { adapter: () => new FakeAdapter("a1" as AssistantId, { ok: true, events: [] }), manifest: () => m },
    verification: new VerificationStore(db),
    ...(opts.shouldTerminalizeOnRecovery ? { shouldTerminalizeOnRecovery: opts.shouldTerminalizeOnRecovery } : {}),
  });
}

function recoveryEvents(sessionId: string): string[] {
  return (
    db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'recovery.decision' ORDER BY seq").all(sessionId) as Array<{
      payload: string;
    }>
  ).map((r) => (JSON.parse(r.payload) as { action: string }).action);
}

function resultRows(sessionId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = ?").get(sessionId) as { n: number }).n;
}

describe("HarnessRecovery rollback-terminalisation — mode disabled", () => {
  const disabled = () => true;

  it("PREPARED (crashed before any lease) terminalises", async () => {
    const id = seedSession({ reqId: "erq_prep", to: "PREPARED" });
    await recovery({ shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
    expect(store.result(id)!.failure).toMatchObject({ kind: "orphaned" });
    expect(recoveryEvents(id)).toContain("mode_disabled_terminalized");
  });

  it("STARTING (provider-start-unacked) terminalises", async () => {
    const id = seedSession({ reqId: "erq_start", to: "STARTING" });
    await recovery({ shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
  });

  it("RUNNING, resume-capable (canResume + providerSessionRef) terminalises instead of resume-offering", async () => {
    const id = seedSession({ reqId: "erq_resumable", to: "RUNNING", providerSessionRef: "psr_1" });
    const out = await recovery({ canResume: true, shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
    expect(out[0]!.action).toBe("orphaned");
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
    expect(recoveryEvents(id)).toEqual(["lease_taken_over", "mode_disabled_terminalized"]);
  });

  it("RUNNING, orphan (no resumable ref) terminalises (same outcome as normal orphan recovery)", async () => {
    const id = seedSession({ reqId: "erq_orphan", to: "RUNNING" });
    await recovery({ shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
    expect(store.get(id)!.state).toBe("FAILED");
    expect(store.result(id)!.checkpoint.attempted).toBe(true);
  });

  it("AWAITING_APPROVAL (ambiguous, no ack lookup) terminalises instead of parking", async () => {
    const id = seedSession({ reqId: "erq_appr", to: "AWAITING_APPROVAL" });
    await recovery({ shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
    expect(store.get(id)!.state).toBe("FAILED");
    expect(recoveryEvents(id)).not.toContain("approval_delivery_held");
  });

  it("VERIFYING with durable evidence still completes from evidence (terminal already, unaffected)", async () => {
    const id = seedSession({ reqId: "erq_verify", to: "VERIFYING" });
    const verification = new VerificationStore(db);
    const plan = {
      schemaVersion: 1 as const,
      planRevisionId: "vpr_erq_verify",
      revision: 1,
      checks: [{ checkId: "unit", name: "unit", kind: "tests" as const, command: "pnpm test", required: true }],
      decisions: [{ checkId: "unit", selected: true, required: true, signals: ["requested"], reason: "requested" }],
    };
    verification.insertRevision({ sessionId: id, executionRequestId: "erq_verify", plan, reason: "initial" });
    const binding = { runId: "vr_erq_verify", sessionId: id, executionRequestId: "erq_verify", planRevisionId: plan.planRevisionId };
    verification.prepareRun(binding);
    verification.claim({ ...binding, claimToken: "tok" });
    verification.complete({
      ...binding,
      claimToken: "tok",
      evaluation: { passed: true, checks: [{ checkId: "unit", name: "unit", kind: "tests", required: true, status: "passed", passed: true, summary: "ok" }] },
      artifacts: [],
    });
    const rec = new HarnessRecovery({
      store,
      approvals: new ApprovalService(db),
      checkpoints: { create: async () => ({ id: "ck_ok", gitRef: "ref1" }) },
      registry: { adapter: () => new FakeAdapter("a1" as AssistantId, { ok: true, events: [] }), manifest: () => manifest(false) },
      verification,
      shouldTerminalizeOnRecovery: disabled,
    });
    await rec.reconcileOnBoot();
    expect(store.get(id)!.state).toBe("COMPLETED");
    expect(resultRows(id)).toBe(1);
  });

  it("PAUSED and RESUMING (unreachable under single mode today) terminalise fail-closed anyway", async () => {
    for (const to of ["PAUSED", "RESUMING"] as const) {
      const id = seedSession({ reqId: `erq_${to.toLowerCase()}`, to });
      await recovery({ shouldTerminalizeOnRecovery: disabled }).reconcileOnBoot();
      expect(store.get(id)!.state).toBe("FAILED");
      expect(resultRows(id)).toBe(1);
    }
  });

  it("a missing session -> request -> task binding is fail-closed (undefined resolver never used here; the composition root's resolver returns true on a broken join)", async () => {
    // shouldTerminalizeOnRecovery is the composition root's concern (tested in
    // Part 2 via the real join); this asserts the recovery policy itself simply
    // trusts whatever the resolver returns — a resolver that returns true always
    // terminalises regardless of session shape.
    const id = seedSession({ reqId: "erq_any", to: "RUNNING", providerSessionRef: "psr_x" });
    await recovery({ canResume: true, shouldTerminalizeOnRecovery: () => true }).reconcileOnBoot();
    expect(store.get(id)!.state).toBe("FAILED");
  });
});

describe("HarnessRecovery — mode enabled, normal operation unchanged", () => {
  it("still resume-offers a resume-capable RUNNING session when shouldTerminalizeOnRecovery is absent", async () => {
    const id = seedSession({ reqId: "erq_normal", to: "RUNNING", providerSessionRef: "psr_2" });
    const out = await recovery({ canResume: true }).reconcileOnBoot();
    expect(out).toEqual([{ sessionId: id, action: "resume_offered", detail: "psr_2" }]);
    expect(store.get(id)!.state).toBe("RUNNING");
    expect(resultRows(id)).toBe(0);
  });

  it("still resume-offers when the resolver explicitly returns false", async () => {
    const id = seedSession({ reqId: "erq_enabled", to: "RUNNING", providerSessionRef: "psr_3" });
    const out = await recovery({ canResume: true, shouldTerminalizeOnRecovery: () => false }).reconcileOnBoot();
    expect(out).toEqual([{ sessionId: id, action: "resume_offered", detail: "psr_3" }]);
  });
});

// --- Part 2: full-stack rollback via buildServer ---------------------------

describe("rollback end to end (buildServer)", () => {
  let home: string;
  let bdb: Db;
  let built: BuiltServer;

  afterEach(async () => {
    await built.app.close();
    bdb.close();
    rmSync(home, { recursive: true, force: true });
  });

  const bearer = (config: ReturnType<typeof loadConfig>) => ({
    authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}`,
  });

  it("a new start takes the legacy path once single mode is disabled", async () => {
    home = mkdtempSync(join(tmpdir(), "mode-rollback-e2e-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    bdb = openDb(config.dbPath);
    built = buildServer({ config, db: bdb });
    built.registry.init();

    const created = await built.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: bearer(config),
      payload: { goal: "after rollback" },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().taskId as string;

    // config.execution.harnessModes.single defaults false — this IS the rollback state.
    await built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: bearer(config), payload: {} });
    const row = bdb.prepare("SELECT execution_request_id FROM runs WHERE task_id = ?").get(taskId) as
      | { execution_request_id: string | null }
      | undefined;
    expect(row?.execution_request_id ?? null).toBeNull(); // legacy run, not a Harness session
  });

  it("an in-flight session that crashed while its mode was on settles to terminal on boot, and a second boot is idempotent", async () => {
    home = mkdtempSync(join(tmpdir(), "mode-rollback-idem-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    bdb = openDb(config.dbPath);
    built = buildServer({ config, db: bdb });
    built.registry.init();

    bdb.prepare(
      "INSERT INTO tasks (id, goal, envelope, state, mode, created_at, updated_at) VALUES ('AG-idem', 'g', ?, 'RUNNING', 'single', 't', 't')",
    ).run(JSON.stringify({ status: { state: "RUNNING" } }));
    const manifestRow = JSON.stringify({
      assistantId: "personal-claude",
      provider: "anthropic",
      core: { models: [{ id: "m" }], canResume: true, canMcp: false, supportsMidRunInput: true, reportsUsage: true, reportsLimits: true, execution: { shell: true, filesystem: true, web: "no" }, auth: { state: "ok" } },
      providerDetail: {},
      evidence: { source: "runtime-probe", observedAt: "t" },
    });
    bdb.prepare("UPDATE assistants SET manifest = ? WHERE id = 'personal-claude'").run(manifestRow);
    bdb.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint, fingerprint_algorithm,
          prompt_source, rendered_prompt_digest, policy, verification, origin, canonical_projection, created_at)
       VALUES ('erq-idem', 'AG-idem', 1, 'personal-claude', 'rd', 'fp', 'alg', 'fresh', 'd',
               '{"budget":{"enforcement":"advisory"}}', '[]', '{"kind":"fresh"}', '{}', 't')`,
    ).run();
    bdb.prepare(
      `INSERT INTO runs
         (id, task_id, assistant_id, state, session_state, version, execution_request_id, provider_session_ref,
          provider_start_acked, cancel_requested, attempt, started_at)
       VALUES ('sess-idem', 'AG-idem', 'personal-claude', 'ACTIVE', 'RUNNING', 3, 'erq-idem', 'psr_idem', 1, 0, 1, 't')`,
    ).run();

    await built.orchestrator.reconcileOnBoot();
    const first = bdb.prepare("SELECT session_state FROM runs WHERE id = 'sess-idem'").get() as { session_state: string };
    expect(first.session_state).toBe("FAILED");
    const firstCount = (bdb.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = 'sess-idem'").get() as { n: number }).n;
    expect(firstCount).toBe(1);
    const task = bdb.prepare("SELECT state FROM tasks WHERE id = 'AG-idem'").get() as { state: string };
    expect(task.state).toBe("FAILED");

    // Second boot: already terminal, no new writes.
    await built.orchestrator.reconcileOnBoot();
    const secondCount = (bdb.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = 'sess-idem'").get() as { n: number }).n;
    expect(secondCount).toBe(1);
  });
});

describe("flag-OFF regression (D6 unconditional bridge does not change legacy behaviour)", () => {
  let home: string;
  let bdb: Db;
  let built: BuiltServer;

  afterEach(async () => {
    await built.app.close();
    bdb.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("a clean all-modes-OFF DB with a plain legacy task is blanket-failed exactly as before", async () => {
    home = mkdtempSync(join(tmpdir(), "mode-rollback-clean-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    bdb = openDb(config.dbPath);
    built = buildServer({ config, db: bdb });
    built.registry.init();

    bdb.prepare(
      "INSERT INTO tasks (id, goal, envelope, state, mode, created_at, updated_at) VALUES ('AG-legacy', 'g', ?, 'RUNNING', 'single', 't', 't')",
    ).run(JSON.stringify({ status: { state: "RUNNING" } }));
    bdb.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('legacy-only', 'AG-legacy', 'personal-claude', 'ACTIVE', 't')",
    ).run();

    const reconciled = await built.orchestrator.reconcileOnBoot();

    expect(reconciled).toBe(1);
    expect((bdb.prepare("SELECT state FROM tasks WHERE id = 'AG-legacy'").get() as { state: string }).state).toBe("FAILED");
    expect((bdb.prepare("SELECT state FROM runs WHERE id = 'legacy-only'").get() as { state: string }).state).toBe(
      "ENDED_ERROR",
    );
    expect((bdb.prepare("SELECT COUNT(*) AS n FROM execution_requests").get() as { n: number }).n).toBe(0);
  });

  it("a historical (already-terminal) Harness row is left alone; only a live one is reclaimed", async () => {
    home = mkdtempSync(join(tmpdir(), "mode-rollback-hist-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    bdb = openDb(config.dbPath);
    built = buildServer({ config, db: bdb });
    built.registry.init();

    // A finished task from a prior single-mode run — should never be touched.
    bdb.prepare(
      "INSERT INTO tasks (id, goal, envelope, state, mode, created_at, updated_at) VALUES ('AG-done', 'g', ?, 'COMPLETED', 'single', 't', 't')",
    ).run(JSON.stringify({ status: { state: "COMPLETED" } }));
    bdb.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint, fingerprint_algorithm,
          prompt_source, rendered_prompt_digest, policy, verification, origin, canonical_projection, created_at)
       VALUES ('erq-done', 'AG-done', 1, 'personal-claude', 'rd', 'fp', 'alg', 'fresh', 'd',
               '{"budget":{"enforcement":"advisory"}}', '[]', '{"kind":"fresh"}', '{}', 't')`,
    ).run();
    bdb.prepare(
      `INSERT INTO runs
         (id, task_id, assistant_id, state, session_state, version, execution_request_id, attempt, started_at, ended_at)
       VALUES ('sess-done', 'AG-done', 'personal-claude', 'ENDED_OK', 'COMPLETED', 4, 'erq-done', 1, 't', 't')`,
    ).run();

    await built.orchestrator.reconcileOnBoot();

    expect((bdb.prepare("SELECT session_state FROM runs WHERE id = 'sess-done'").get() as { session_state: string }).session_state).toBe(
      "COMPLETED",
    );
    expect((bdb.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = 'sess-done'").get() as { n: number }).n).toBe(0);
  });
});

describe("mixed-live-ownership guard", () => {
  let home: string;
  let bdb: Db;
  let built: BuiltServer;

  afterEach(async () => {
    await built.app.close();
    bdb.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seedMixedTask(taskId: string, bdb: Db): void {
    bdb.prepare(
      "INSERT INTO tasks (id, goal, envelope, state, mode, created_at, updated_at) VALUES (?, 'g', ?, 'RUNNING', 'single', 't', 't')",
    ).run(taskId, JSON.stringify({ status: { state: "RUNNING" } }));
    bdb.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES (?, ?, 'personal-claude', 'ACTIVE', 't')",
    ).run(`${taskId}-legacy`, taskId);
    bdb.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint, fingerprint_algorithm,
          prompt_source, rendered_prompt_digest, policy, verification, origin, canonical_projection, created_at)
       VALUES (?, ?, 1, 'personal-claude', 'rd', 'fp', 'alg', 'fresh', 'd',
               '{"budget":{"enforcement":"advisory"}}', '[]', '{"kind":"fresh"}', '{}', 't')`,
    ).run(`${taskId}-erq`, taskId);
    bdb.prepare(
      `INSERT INTO runs
         (id, task_id, assistant_id, state, session_state, version, execution_request_id, attempt, started_at)
       VALUES (?, ?, 'personal-claude', 'ACTIVE', 'RUNNING', 3, ?, 1, 't')`,
    ).run(`${taskId}-sess`, taskId, `${taskId}-erq`);
  }

  it("interactive control ops refuse a task with mixed live ownership", async () => {
    home = mkdtempSync(join(tmpdir(), "mode-rollback-mixed-interactive-"));
    const config = loadConfig({ AGENT_PLANE_HOME: home });
    bdb = openDb(config.dbPath);
    built = buildServer({ config, db: bdb });
    built.registry.init();
    seedMixedTask("AG-mixed", bdb);

    await expect(built.orchestrator.cancelTask("AG-mixed")).rejects.toThrow(/mixed live ownership/);
    await expect(built.orchestrator.createCheckpoint("AG-mixed")).rejects.toThrow(/mixed live ownership/);
    await expect(built.orchestrator.handoff("AG-mixed")).rejects.toThrow(/mixed live ownership/);
    await expect(built.orchestrator.respondApproval("AG-mixed", "req_1", true)).rejects.toThrow(/mixed live ownership/);
  });

  for (const single of [true, false]) {
    it(`boot quarantines a mixed task and continues reconciling others (mode ${single ? "ON" : "OFF"})`, async () => {
      home = mkdtempSync(join(tmpdir(), `mode-rollback-mixed-boot-${single}-`));
      const config = loadConfig({ AGENT_PLANE_HOME: home });
      config.execution.harnessModes.single = single;
      bdb = openDb(config.dbPath);
      built = buildServer({ config, db: bdb });
      built.registry.init();

      seedMixedTask("AG-mixed", bdb);
      // A second, unrelated legacy task — must still be reconciled after the
      // quarantine, proving the sweep never aborts on the ambiguous one.
      bdb.prepare(
        "INSERT INTO tasks (id, goal, envelope, state, mode, created_at, updated_at) VALUES ('AG-other', 'g', ?, 'RUNNING', 'single', 't', 't')",
      ).run(JSON.stringify({ status: { state: "RUNNING" } }));
      bdb.prepare(
        "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('other-legacy', 'AG-other', 'personal-claude', 'ACTIVE', 't')",
      ).run();

      await built.orchestrator.reconcileOnBoot();

      expect((bdb.prepare("SELECT session_state FROM runs WHERE id = 'AG-mixed-sess'").get() as { session_state: string }).session_state).toBe(
        "FAILED",
      );
      expect((bdb.prepare("SELECT state FROM tasks WHERE id = 'AG-mixed'").get() as { state: string }).state).toBe("FAILED");
      // The other task was still reconciled — the sweep did not abort.
      expect((bdb.prepare("SELECT state FROM tasks WHERE id = 'AG-other'").get() as { state: string }).state).toBe("FAILED");
      expect((bdb.prepare("SELECT state FROM runs WHERE id = 'other-legacy'").get() as { state: string }).state).toBe("ENDED_ERROR");
    });
  }
});
