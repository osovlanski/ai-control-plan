/**
 * Phase 7 — HarnessRecovery: boot reconcile v2, the lease sweeper, guard-directive
 * replay, and `delivery_unknown` approval settlement (execution-harness §9, §4).
 *
 * Driven through a real SessionStore + ApprovalService on an in-repo SQLite DB
 * with a FakeAdapter registry — no live providers.
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
import type { RunnerCheckpoints } from "../../src/modules/harness/session-runner.js";
import { HarnessRecovery, type RecoveryDeps } from "../../src/modules/harness/recovery.js";
import { VerificationStore } from "../../src/modules/harness/verification-store.js";

let dir: string;
let db: Db;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-recovery-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1', 'fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1', 'g', '{}', 't', 't')",
  ).run();
  store = new SessionStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function request(reqId: string, verification: ExecutionRequest["verification"] = []): ExecutionRequest {
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
    verification,
    origin: { kind: "fresh" },
  };
}

/** Create a session and walk it into a live state, then drop the lease (crash). */
function seedSession(opts: {
  reqId: string;
  to: "PREPARED" | "STARTING" | "RUNNING" | "VERIFYING" | "AWAITING_APPROVAL";
  providerSessionRef?: string;
  verification?: ExecutionRequest["verification"];
}): string {
  store.recordRequest(request(opts.reqId, opts.verification));
  const id = store.createSession(opts.reqId).sessionId as string;
  // Crash right after Prepare committed the row, before a lease was ever taken.
  if (opts.to === "PREPARED") return id;
  const t = store.acquireLease(id)!;
  store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: t });
  if (opts.to !== "STARTING") {
    store.transition(id, {
      expectedVersion: 1,
      from: "STARTING",
      to: "RUNNING",
      leaseToken: t,
      ...(opts.providerSessionRef
        ? { patch: { providerSessionRef: opts.providerSessionRef as ProviderSessionRef } }
        : {}),
    });
    if (opts.to === "VERIFYING") {
      store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "VERIFYING", leaseToken: t });
    } else if (opts.to === "AWAITING_APPROVAL") {
      store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "AWAITING_APPROVAL", leaseToken: t });
    }
  } else if (opts.providerSessionRef) {
    store.ackHandle(id, opts.providerSessionRef as ProviderSessionRef, { expectedVersion: 1, leaseToken: t });
  }
  store.releaseLease(id, t);
  return id;
}

function seedVerification(
  sessionId: string,
  reqId: string,
  state: "ready" | "claimed" | "completed" | "interrupted",
): VerificationStore {
  const verification = new VerificationStore(db, () => new Date("2026-01-02T00:00:00.000Z"));
  const plan = {
    schemaVersion: 1 as const,
    planRevisionId: `vpr_${reqId}`,
    revision: 1,
    checks: [{ checkId: "unit", name: "unit", kind: "tests" as const, command: "pnpm test", required: true }],
    decisions: [{ checkId: "unit", selected: true, required: true, signals: ["requested"], reason: "requested" }],
  };
  verification.insertRevision({ sessionId, executionRequestId: reqId, plan, reason: "initial" });
  const binding = { runId: `vr_${reqId}`, sessionId, executionRequestId: reqId, planRevisionId: plan.planRevisionId };
  verification.prepareRun(binding);
  if (state !== "ready") verification.claim({ ...binding, claimToken: "runner-secret-token" });
  if (state === "completed") verification.complete({
    ...binding,
    claimToken: "runner-secret-token",
    evaluation: { passed: true, checks: [{ checkId: "unit", name: "unit", kind: "tests", required: true, status: "passed", passed: true, summary: "ok" }] },
    artifacts: [{ kind: "test_report", ref: "artifact://unit", summary: "unit report" }],
  });
  if (state === "interrupted") verification.interrupt({ ...binding, claimToken: "runner-secret-token", reason: "runner stopped" });
  return verification;
}

function manifest(opts: {
  canResume?: boolean;
  approvalAckLookup?: boolean;
  accounting?: "delta" | "cumulative" | "none";
}): CapabilityManifest {
  return {
    assistantId: "a1" as AssistantId,
    provider: "fake",
    core: {
      models: [{ id: "m1" }],
      canResume: opts.canResume ?? false,
      canMcp: false,
      supportsMidRunInput: true,
      reportsUsage: true,
      reportsLimits: true,
      execution: { shell: true, filesystem: true, web: "no" },
      auth: { state: "ok" },
    },
    harness: {
      usageAccounting: opts.accounting ?? "none",
      toolGating: "none",
      approvalRelay: true,
      processIsolation: "none",
      ...(opts.approvalAckLookup ? { approvalAckLookup: true } : {}),
    },
    providerDetail: {},
    evidence: { source: "runtime-probe", observedAt: "t" },
  };
}

function recovery(opts: {
  canResume?: boolean;
  approvalAckLookup?: boolean;
  ackResult?: boolean;
  accounting?: "delta" | "cumulative" | "none";
  checkpoints?: RunnerCheckpoints;
  maxDirectiveAttempts?: number;
} = {}): HarnessRecovery {
  return new HarnessRecovery({ ...recoveryDeps(opts), verification: new VerificationStore(db) });
}

function recoveryDeps(opts: {
  canResume?: boolean;
  approvalAckLookup?: boolean;
  ackResult?: boolean;
  accounting?: "delta" | "cumulative" | "none";
  checkpoints?: RunnerCheckpoints;
  maxDirectiveAttempts?: number;
} = {}): Omit<RecoveryDeps, "verification"> {
  const m = manifest(opts);
  return {
    store,
    approvals: new ApprovalService(db),
    checkpoints: opts.checkpoints ?? { create: async () => ({ id: "ck_ok", gitRef: "ref1" }) },
    registry: {
      adapter: () => new FakeAdapter("a1" as AssistantId, { ok: true, events: [] }),
      manifest: () => m,
    },
    ...(opts.approvalAckLookup ? { approvalAckLookup: () => opts.ackResult ?? false } : {}),
    ...(opts.maxDirectiveAttempts ? { maxDirectiveAttempts: opts.maxDirectiveAttempts } : {}),
  };
}

function recoveryEvents(sessionId: string): Array<{ action: string; detail?: string }> {
  return (
    db
      .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'recovery.decision' ORDER BY seq")
      .all(sessionId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as { action: string; detail?: string });
}

function resultRows(sessionId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = ?").get(sessionId) as { n: number }
  ).n;
}

describe("HarnessRecovery.reconcileOnBoot", () => {
  it("offers resume for a RUNNING session with a providerSessionRef + canResume manifest", async () => {
    const id = seedSession({ reqId: "erq_resume", to: "RUNNING", providerSessionRef: "psr_1" });

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "resume_offered", detail: "psr_1" }]);
    expect(store.get(id)!.state).toBe("RUNNING"); // not terminalised — the plane issues origin:resume
    expect(resultRows(id)).toBe(0);
    expect(store.get(id)!.leaseToken).toBeUndefined(); // lease handed back
    expect(recoveryEvents(id).map((e) => e.action)).toEqual(["lease_taken_over", "resume_offered"]);
  });

  it("orphan-fails a RUNNING session with no providerSessionRef, with exactly one result row and a checkpoint attempt", async () => {
    const id = seedSession({ reqId: "erq_orphan", to: "RUNNING" });

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "orphaned" }]);
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
    const result = store.result(id)!;
    expect(result.failure).toMatchObject({ kind: "orphaned" });
    expect(result.checkpoint.attempted).toBe(true);
    expect(result.checkpoint.committed).toBe(true); // stub returns a gitRef
    expect(recoveryEvents(id).map((e) => e.action)).toContain("orphaned");
  });

  it("orphan-fails when canResume:false even with a providerSessionRef", async () => {
    const id = seedSession({ reqId: "erq_nocr", to: "RUNNING", providerSessionRef: "psr_2" });

    const out = await recovery({ canResume: false }).reconcileOnBoot();

    expect(out[0]!.action).toBe("orphaned");
    expect(store.get(id)!.state).toBe("FAILED");
  });

  it("records checkpoint.committed=false when the recovery checkpoint does not commit (H-I4)", async () => {
    const id = seedSession({ reqId: "erq_ckfail", to: "RUNNING" });

    await recovery({ checkpoints: { create: async () => ({ id: "ck_x", gitRef: null }) } }).reconcileOnBoot();

    const result = store.result(id)!;
    expect(result.checkpoint).toMatchObject({ attempted: true, committed: false });
  });

  it("completes a crashed VERIFYING session with no verification (§5)", async () => {
    const id = seedSession({ reqId: "erq_verify", to: "VERIFYING", providerSessionRef: "psr_3" });

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "completed_from_verifying" }]);
    expect(store.get(id)!.state).toBe("COMPLETED");
    expect(resultRows(id)).toBe(1);
    expect(store.result(id)!.verification).toBeUndefined();
    expect(recoveryEvents(id).map((e) => e.action)).toContain("completed_from_verifying");
  });

  it("reuses completed durable evidence and artifacts exactly after restart", async () => {
    const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, command: "pnpm test", required: true }];
    const id = seedSession({ reqId: "erq_evidence", to: "VERIFYING", verification: specs });
    const verification = seedVerification(id, "erq_evidence", "completed");

    await new HarnessRecovery({ ...(recoveryDeps({ canResume: true })), verification }).reconcileOnBoot();

    expect(store.result(id)).toMatchObject({
      verification: { passed: true, checks: [{ checkId: "unit", status: "passed" }] },
      artifacts: [{ kind: "test_report", ref: "artifact://unit", summary: "unit report" }],
    });
  });

  for (const lifecycle of ["ready", "claimed", "interrupted"] as const) {
    it(`settles ${lifecycle} verification as explicit blocked evidence without rerunning`, async () => {
      const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, command: "pnpm test", required: true }];
      const reqId = `erq_${lifecycle}`;
      const id = seedSession({ reqId, to: "VERIFYING", verification: specs });
      const verification = seedVerification(id, reqId, lifecycle);

      await new HarnessRecovery({ ...recoveryDeps({ canResume: true }), verification }).reconcileOnBoot();

      expect(store.result(id)!.verification).toMatchObject({ passed: false, checks: [{ checkId: "unit", status: "blocked", required: true }] });
      expect(verification.latestRunForSession(id)!.state).toBe("interrupted");
    });
  }

  it("moves RUNNING with a prepared verification run into VERIFYING recovery instead of provider resume", async () => {
    const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }];
    const id = seedSession({ reqId: "erq_prepared", to: "RUNNING", providerSessionRef: "psr_resume", verification: specs });
    const verification = seedVerification(id, "erq_prepared", "ready");

    const out = await new HarnessRecovery({ ...recoveryDeps({ canResume: true }), verification }).reconcileOnBoot();

    expect(out[0]!.action).toBe("completed_from_verifying");
    expect(store.get(id)!.state).toBe("COMPLETED");
    expect(recoveryEvents(id).map((e) => e.action)).toContain("verification_recovered");
  });

  it("honors cancellation while VERIFYING and does not fabricate a pass", async () => {
    const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }];
    const id = seedSession({ reqId: "erq_verify_cancel", to: "VERIFYING", verification: specs });
    const verification = seedVerification(id, "erq_verify_cancel", "claimed");
    store.requestCancel(id);

    await new HarnessRecovery({ ...recoveryDeps(), verification }).reconcileOnBoot();

    expect(store.result(id)).toMatchObject({ terminalState: "CANCELLED", verification: { passed: false } });
    expect(verification.latestRunForSession(id)!.state).toBe("interrupted");
  });

  it("terminalizes an unfinished verification as TIMED_OUT when the durable hard deadline elapsed", async () => {
    const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }];
    const id = seedSession({ reqId: "erq_verify_timeout", to: "VERIFYING", verification: specs });
    const verification = seedVerification(id, "erq_verify_timeout", "ready");

    const out = await new HarnessRecovery({
      ...recoveryDeps(), verification, now: () => new Date("2099-01-01T00:00:00.000Z"),
    }).reconcileOnBoot();

    expect(out[0]!.action).toBe("timed_out");
    expect(store.result(id)).toMatchObject({ terminalState: "TIMED_OUT", outcome: "timed_out", verification: { passed: false } });
  });

  it("uses the verification-store CAS winner when a stale runner completes during recovery", async () => {
    const specs = [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }];
    const id = seedSession({ reqId: "erq_verify_race", to: "VERIFYING", verification: specs });
    const verification = seedVerification(id, "erq_verify_race", "claimed");
    const originalInterrupt = verification.interrupt.bind(verification);
    let raced = false;
    verification.interrupt = ((input: Parameters<VerificationStore["interrupt"]>[0]) => {
      if (!raced) {
        raced = true;
        verification.complete({ ...input, evaluation: { passed: true, checks: [{ checkId: "unit", name: "unit", kind: "tests", required: true, status: "passed", passed: true, summary: "runner won" }] }, artifacts: [] });
      }
      return originalInterrupt(input);
    }) as VerificationStore["interrupt"];

    await new HarnessRecovery({ ...recoveryDeps(), verification }).reconcileOnBoot();

    expect(store.result(id)!.verification).toMatchObject({ passed: true, checks: [{ summary: "runner won" }] });
    expect(verification.latestRunForSession(id)!.state).toBe("completed");
  });

  it("leaves already-terminal sessions untouched", async () => {
    const id = seedSession({ reqId: "erq_done", to: "RUNNING", providerSessionRef: "psr_4" });
    await recovery({ canResume: false }).reconcileOnBoot(); // -> FAILED(orphaned)
    expect(store.get(id)!.state).toBe("FAILED");

    const out = await recovery({ canResume: false }).reconcileOnBoot();

    expect(out).toEqual([]); // liveSessions() no longer lists it
    expect(resultRows(id)).toBe(1); // still exactly one result row (H-I3)
  });

  it("offers resume only once — a later sweep of the still-live session is skipped, not re-announced", async () => {
    const id = seedSession({ reqId: "erq_once2", to: "RUNNING", providerSessionRef: "psr_1x" });

    expect((await recovery({ canResume: true }).reconcileOnBoot())[0]!.action).toBe("resume_offered");
    const second = await recovery({ canResume: true }).reconcileOnBoot();

    expect(second).toEqual([{ sessionId: id, action: "skipped", detail: "resume already offered" }]);
    expect(recoveryEvents(id).filter((e) => e.action === "resume_offered")).toHaveLength(1);
    expect(store.get(id)!.state).toBe("RUNNING");
  });

  it("honors a durable cancel intent ahead of resume/orphan — terminal CANCELLED with a checkpoint attempt", async () => {
    const id = seedSession({ reqId: "erq_cancel", to: "RUNNING", providerSessionRef: "psr_1c" });
    store.requestCancel(id); // plane/user cancel set before the crash

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "cancelled" }]);
    expect(store.get(id)!.state).toBe("CANCELLED");
    expect(recoveryEvents(id).find((e) => e.action === "cancelled")?.detail).toBe("checkpoint committed");
    const result = store.result(id)!;
    expect(result.outcome).toBe("cancelled");
    expect(result.cancellation).toMatchObject({ requestedBy: "plane" });
    expect(result.checkpoint.attempted).toBe(true);
    expect(recoveryEvents(id).map((e) => e.action)).toContain("cancelled");
  });

  it("recomputes usage for a crashed VERIFYING session from persisted usage.updated events (§9)", async () => {
    const id = seedSession({ reqId: "erq_usage", to: "VERIFYING", providerSessionRef: "psr_1u" });
    const ev = db.prepare("INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES (?, ?, ?, 'usage.updated', 'u', ?)");
    ev.run(id, 10, "t", JSON.stringify({ inputTokens: 100, outputTokens: 20 }));
    ev.run(id, 11, "t", JSON.stringify({ inputTokens: 50, outputTokens: 5 }));

    await recovery({ canResume: true, accounting: "delta" }).reconcileOnBoot();

    expect(store.result(id)!.usage).toMatchObject({ inputTokens: 150, outputTokens: 25, accounting: "delta" });
  });
});

describe("HarnessRecovery — guard-directive replay (§9)", () => {
  it("replays a pending checkpoint directive exactly once and marks it applied", async () => {
    const id = seedSession({ reqId: "erq_dir1", to: "RUNNING", providerSessionRef: "psr_5" });
    store.recordPendingDirective(id, 1, "budget", "checkpoint", {});
    let calls = 0;
    const checkpoints: RunnerCheckpoints = {
      create: async () => {
        calls += 1;
        return { id: "ck_d", gitRef: "r" };
      },
    };

    await recovery({ canResume: true, checkpoints }).reconcileOnBoot();
    await recovery({ canResume: true, checkpoints }).reconcileOnBoot(); // second boot must not re-apply

    expect(calls).toBe(1);
    const row = db.prepare("SELECT status FROM guard_directives WHERE session_id = ?").get(id) as { status: string };
    expect(row.status).toBe("applied");
    expect(recoveryEvents(id).map((e) => e.action)).toContain("directive_replayed");
  });

  it("orphan-fails the session after maxDirectiveAttempts on a permanently failing directive", async () => {
    const id = seedSession({ reqId: "erq_dir2", to: "RUNNING", providerSessionRef: "psr_6" });
    store.recordPendingDirective(id, 1, "budget", "checkpoint", {});
    // Token built at runtime so it is not a literal in the source (pre-write secret scan).
    const planted = ["sk", "DISKFULLTOKEN1234567"].join("-");
    const checkpoints: RunnerCheckpoints = {
      create: async () => {
        throw new Error(`checkpoint backend down ${planted}`);
      },
    };
    const rec = () => recovery({ canResume: true, checkpoints, maxDirectiveAttempts: 3 });

    expect((await rec().reconcileOnBoot())[0]!.action).toBe("resume_offered"); // attempt 1, swallowed
    expect((await rec().reconcileOnBoot())[0]!.action).toBe("skipped"); // attempt 2, swallowed; resume already offered
    const out = await rec().reconcileOnBoot(); // attempt 3 -> permanent

    expect(out[0]!.action).toBe("orphaned");
    expect(store.get(id)!.state).toBe("FAILED");
    const row = db.prepare("SELECT status FROM guard_directives WHERE session_id = ?").get(id) as { status: string };
    expect(row.status).toBe("failed");
    const failedEvent = recoveryEvents(id).find((e) => e.action === "directive_failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.detail).not.toContain(planted); // redacted
    expect(failedEvent!.detail).toContain("[REDACTED]");
  });
});

describe("HarnessRecovery — delivery_unknown approval settlement (§4)", () => {
  function seedDeliveryUnknown(sessionId: string, prid = "prq_1"): void {
    const ap = new ApprovalService(db);
    ap.request(sessionId, prid, `apr_${prid}`);
    ap.answer(sessionId, prid, "approved", "user");
    ap.markDelivering(sessionId, prid);
    ap.markDeliveryUnknown(sessionId, prid);
  }

  it("probes the provider ack when the manifest declares approvalAckLookup and settles delivered + RUNNING", async () => {
    const id = seedSession({ reqId: "erq_ack1", to: "AWAITING_APPROVAL", providerSessionRef: "psr_7" });
    seedDeliveryUnknown(id);

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: true }).reconcileOnBoot();

    expect(new ApprovalService(db).get(id, "prq_1")!.state).toBe("delivered");
    expect(store.get(id)!.state).toBe("RUNNING");
    expect(recoveryEvents(id).map((e) => e.action)).toContain("approval_ack_confirmed");
  });

  it("also settles a crash that left the row in `answered` (never reached delivering)", async () => {
    const id = seedSession({ reqId: "erq_answered", to: "AWAITING_APPROVAL", providerSessionRef: "psr_7b" });
    const ap = new ApprovalService(db);
    ap.request(id, "prq_1", "apr_1");
    ap.answer(id, "prq_1", "approved", "user"); // durable decision, crash before any send()

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: true }).reconcileOnBoot();

    expect(new ApprovalService(db).get(id, "prq_1")!.state).toBe("delivered");
    expect(store.get(id)!.state).toBe("RUNNING");
  });

  it("holds an `answered` row (never delivered) when the ack lookup is negative — no live handle to re-deliver on", async () => {
    // §4 redelivery-on-recovery needs a resumed provider session (deferred); recovery only
    // does ack-lookup-or-hold-and-surface.
    const id = seedSession({ reqId: "erq_answered2", to: "AWAITING_APPROVAL", providerSessionRef: "psr_7c" });
    const ap = new ApprovalService(db);
    ap.request(id, "prq_1", "apr_1");
    ap.answer(id, "prq_1", "approved", "user");

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: false }).reconcileOnBoot();

    expect(new ApprovalService(db).get(id, "prq_1")!.state).toBe("answered"); // still undelivered
    expect(store.get(id)!.state).toBe("AWAITING_APPROVAL");
    const held = recoveryEvents(id).find((e) => e.action === "approval_delivery_held");
    expect(held?.detail).toContain("provider reports no acknowledgement");
  });

  it("holds the approval when the ack lookup returns false — session stays AWAITING_APPROVAL", async () => {
    const id = seedSession({ reqId: "erq_ack2", to: "AWAITING_APPROVAL", providerSessionRef: "psr_8" });
    seedDeliveryUnknown(id);

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: false }).reconcileOnBoot();

    expect(new ApprovalService(db).get(id, "prq_1")!.state).toBe("delivery_unknown");
    expect(store.get(id)!.state).toBe("AWAITING_APPROVAL");
    expect(recoveryEvents(id).map((e) => e.action)).toContain("approval_delivery_held");
  });

  it("holds the approval when no ack lookup exists at all", async () => {
    const id = seedSession({ reqId: "erq_ack3", to: "AWAITING_APPROVAL", providerSessionRef: "psr_9" });
    seedDeliveryUnknown(id);

    await recovery({ canResume: true }).reconcileOnBoot(); // manifest does not declare approvalAckLookup

    expect(new ApprovalService(db).get(id, "prq_1")!.state).toBe("delivery_unknown");
    expect(store.get(id)!.state).toBe("AWAITING_APPROVAL");
    expect(recoveryEvents(id).map((e) => e.action)).toContain("approval_delivery_held");
  });
});

describe("HarnessRecovery.reconcileOnBoot — crash before RUNNING (§9)", () => {
  it("orphan-fails a session that crashed at PREPARED, with exactly one result row", async () => {
    const id = seedSession({ reqId: "erq_prep", to: "PREPARED" });
    expect(store.get(id)!.state).toBe("PREPARED");

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "orphaned" }]);
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
    expect(store.result(id)!.failure).toMatchObject({ kind: "orphaned" });
    expect(store.result(id)!.checkpoint.attempted).toBe(true);
    expect(recoveryEvents(id).map((e) => e.action)).toContain("orphaned");
  });

  it("orphan-fails a STARTING session that never acked a provider handle", async () => {
    const id = seedSession({ reqId: "erq_start_nohandle", to: "STARTING" });

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out[0]!.action).toBe("orphaned");
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
  });

  it("offers resume for a STARTING session that acked a handle before crashing (start-ambiguous → resume)", async () => {
    const id = seedSession({ reqId: "erq_start_handle", to: "STARTING", providerSessionRef: "psr_sa" });

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "resume_offered", detail: "psr_sa" }]);
    expect(store.get(id)!.state).toBe("STARTING"); // not terminalised — the plane issues origin:resume
    expect(resultRows(id)).toBe(0);
  });

  it("orphan-fails a STARTING session with an acked handle when the manifest cannot resume", async () => {
    const id = seedSession({ reqId: "erq_start_nocr", to: "STARTING", providerSessionRef: "psr_sb" });

    const out = await recovery({ canResume: false }).reconcileOnBoot();

    expect(out[0]!.action).toBe("orphaned");
    expect(store.get(id)!.state).toBe("FAILED");
  });
});

describe("HarnessRecovery.sweepExpiredLeases", () => {
  it("recovers a session whose lease has expired and skips one holding a valid lease", async () => {
    const expired = seedSession({ reqId: "erq_sw1", to: "RUNNING", providerSessionRef: "psr_a" });
    const held = seedSession({ reqId: "erq_sw2", to: "RUNNING", providerSessionRef: "psr_b" });
    db.prepare("UPDATE runs SET lease_token = 'stale', lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      expired,
    );
    db.prepare("UPDATE runs SET lease_token = 'live', lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(
      held,
    );

    const out = await recovery({ canResume: true }).sweepExpiredLeases();

    expect(out).toEqual([{ sessionId: expired, action: "resume_offered", detail: "psr_a" }]);
    expect(store.get(held)!.state).toBe("RUNNING");
    expect(store.get(held)!.leaseToken).toBe("live"); // untouched
  });
});
