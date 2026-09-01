/**
 * Phase 7 — fault-injection matrix (execution-harness §12 layer 4). Each of the
 * design's reliability invariants maps to at least one passing fault test here:
 *
 *   H-I3  every session ends in exactly one terminal state + one ExecutionResult
 *   H-I4  before orphan/cancel/yield the Harness *attempts* a checkpoint and the
 *         result records whether it committed
 *   H-I8  executionRequestId maps to at most one session row; provider-side
 *         execution is at-least-once, recovery probes/orphans the STARTING gap
 *   H-I12 every session write is a CAS under a fencing lease; a stale writer that
 *         lost its lease is rejected
 *   H-I14 every durable directive / approval decision replays idempotently
 *
 * Envelope-claim faults (pre-start claim expiry, start_ambiguous probe settle,
 * synchronous adapter.start() failure) are covered in `handoff.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AssistantId,
  type CapabilityManifest,
  type ExecutionRequest,
  type ExecutionResult,
  type ProviderSessionRef,
  type TaskId,
} from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { openDb, type Db } from "../../src/db/index.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { SessionCasConflictError, SessionStore } from "../../src/modules/harness/session-store.js";
import type { RunnerCheckpoints } from "../../src/modules/harness/session-runner.js";
import { HarnessRecovery } from "../../src/modules/harness/recovery.js";

let dir: string;
let db: Db;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-fault-"));
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

function seedSession(opts: {
  reqId: string;
  to: "STARTING" | "RUNNING" | "AWAITING_APPROVAL";
  providerSessionRef?: string;
}): { id: string; token: string } {
  store.recordRequest(request(opts.reqId));
  const id = store.createSession(opts.reqId).sessionId as string;
  const token = store.acquireLease(id)!;
  store.transition(id, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: token });
  if (opts.to === "STARTING") {
    if (opts.providerSessionRef) {
      store.ackHandle(id, opts.providerSessionRef as ProviderSessionRef, { expectedVersion: 1, leaseToken: token });
    }
    return { id, token };
  }
  store.transition(id, {
    expectedVersion: 1,
    from: "STARTING",
    to: "RUNNING",
    leaseToken: token,
    ...(opts.providerSessionRef
      ? { patch: { providerSessionRef: opts.providerSessionRef as ProviderSessionRef } }
      : {}),
  });
  if (opts.to === "AWAITING_APPROVAL") {
    store.transition(id, { expectedVersion: 2, from: "RUNNING", to: "AWAITING_APPROVAL", leaseToken: token });
  }
  return { id, token };
}

function manifest(opts: { canResume?: boolean; approvalAckLookup?: boolean }): CapabilityManifest {
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
      usageAccounting: "none",
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
  checkpoints?: RunnerCheckpoints;
} = {}): HarnessRecovery {
  const m = manifest(opts);
  return new HarnessRecovery({
    store,
    approvals: new ApprovalService(db),
    checkpoints: opts.checkpoints ?? { create: async () => ({ id: "ck_ok", gitRef: "ref1" }) },
    registry: {
      adapter: () => new FakeAdapter("a1" as AssistantId, { ok: true, events: [] }),
      manifest: () => m,
    },
    ...(opts.approvalAckLookup ? { approvalAckLookup: () => opts.ackResult ?? false } : {}),
  });
}

function resultRows(sessionId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = ?").get(sessionId) as { n: number }
  ).n;
}

describe("H-I8 — crash between STARTING and ack", () => {
  it("orphans a STARTING session with no handle and never spawns a second session row", async () => {
    const { id } = seedSession({ reqId: "erq_starting", to: "STARTING" });
    store.releaseLease(id, store.get(id)!.leaseToken!); // crash: lease abandoned mid-start

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "orphaned" }]);
    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
    // executionRequestId still maps to exactly one session row.
    expect(store.createSession("erq_starting").sessionId).toBe(id);
  });

  it("probe-resumes a STARTING session that did acquire a provider handle before the crash", async () => {
    const { id } = seedSession({ reqId: "erq_starting2", to: "STARTING", providerSessionRef: "psr_h" });
    store.releaseLease(id, store.get(id)!.leaseToken!);

    const out = await recovery({ canResume: true }).reconcileOnBoot();

    expect(out).toEqual([{ sessionId: id, action: "resume_offered", detail: "psr_h" }]);
    expect(store.get(id)!.state).toBe("STARTING"); // handed to the plane, not terminalised
    expect(resultRows(id)).toBe(0);
  });
});

describe("H-I3 — exactly one terminal state and one ExecutionResult", () => {
  it("a second boot reconcile does not write a second result row", async () => {
    const { id } = seedSession({ reqId: "erq_once", to: "RUNNING" });
    store.releaseLease(id, store.get(id)!.leaseToken!);

    await recovery({ canResume: false }).reconcileOnBoot();
    await recovery({ canResume: false }).reconcileOnBoot();

    expect(store.get(id)!.state).toBe("FAILED");
    expect(resultRows(id)).toBe(1);
  });

  it("terminalize co-commit is atomic — a throwing extra hook rolls back the terminal CAS and the result insert", () => {
    const { id, token } = seedSession({ reqId: "erq_atomic", to: "RUNNING" });
    const s = store.get(id)!;
    const result: ExecutionResult = {
      schemaVersion: 1,
      sessionId: id as ExecutionResult["sessionId"],
      terminalState: "FAILED",
      outcome: "failed",
      artifacts: [],
      usage: { accounting: "none" },
      checkpoint: { attempted: false, committed: false },
      enforcement: { tools: "none", budget: "none", isolation: "ambient" },
    };

    expect(() =>
      store.terminalize(id, {
        expectedVersion: s.version,
        from: "RUNNING",
        to: "FAILED",
        leaseToken: token,
        settlementOwner: "test",
        result,
        extra: () => {
          throw new Error("co-commit failed");
        },
      }),
    ).toThrow("co-commit failed");

    expect(store.get(id)!.state).toBe("RUNNING"); // no partial visibility
    expect(resultRows(id)).toBe(0);
  });
});

describe("H-I4 — checkpoint attempt before orphan is reported, never assumed", () => {
  it.each([
    ["a committed checkpoint", async () => ({ id: "ck", gitRef: "abc" }), { attempted: true, committed: true }],
    ["an uncommitted checkpoint", async () => ({ id: "ck", gitRef: null }), { attempted: true, committed: false }],
    [
      "a checkpoint backend that throws",
      async () => {
        throw new Error("backend down");
      },
      { attempted: true, committed: false },
    ],
  ])("orphan records %s", async (_label, create, expected) => {
    const { id } = seedSession({ reqId: `erq_ck_${_label.length}`, to: "RUNNING" });
    store.releaseLease(id, store.get(id)!.leaseToken!);

    await recovery({ canResume: false, checkpoints: { create } as RunnerCheckpoints }).reconcileOnBoot();

    expect(store.result(id)!.checkpoint).toMatchObject(expected);
  });
});

describe("H-I12 — a stale writer that lost its lease is fenced out", () => {
  it("rejects the stale runner's next CAS after the sweeper takes the lease over", () => {
    const { id, token: stale } = seedSession({ reqId: "erq_fence", to: "RUNNING" });
    const s = store.get(id)!;

    // Lease expiry + sweeper takeover: the row's lease is voided and re-acquired.
    store.voidAllLeases();
    const fresh = store.acquireLease(id)!;
    expect(fresh).not.toBe(stale);

    // The stale runner wakes from a delayed callback and tries to advance the session.
    expect(() =>
      store.transition(id, { expectedVersion: s.version, from: "RUNNING", to: "VERIFYING", leaseToken: stale }),
    ).toThrow(SessionCasConflictError);

    // The fresh holder can still write.
    expect(store.transition(id, { expectedVersion: s.version, from: "RUNNING", to: "VERIFYING", leaseToken: fresh }).state).toBe(
      "VERIFYING",
    );
  });
});

describe("H-I14 — durable directives and approval decisions replay idempotently", () => {
  it("a pending guard directive is applied exactly once across repeated boots", async () => {
    const { id } = seedSession({ reqId: "erq_replay", to: "RUNNING", providerSessionRef: "psr_r" });
    store.releaseLease(id, store.get(id)!.leaseToken!);
    store.recordPendingDirective(id, 1, "budget", "checkpoint", {});
    let calls = 0;
    const checkpoints: RunnerCheckpoints = {
      create: async () => {
        calls += 1;
        return { id: "ck", gitRef: "r" };
      },
    };

    await recovery({ canResume: true, checkpoints }).reconcileOnBoot();
    await recovery({ canResume: true, checkpoints }).reconcileOnBoot();
    await recovery({ canResume: true, checkpoints }).reconcileOnBoot();

    expect(calls).toBe(1);
    expect(
      (db.prepare("SELECT status FROM guard_directives WHERE session_id = ?").get(id) as { status: string }).status,
    ).toBe("applied");
  });

  it("an answered-but-undelivered approval settles once and a re-run is a no-op", async () => {
    const { id } = seedSession({ reqId: "erq_appr", to: "AWAITING_APPROVAL", providerSessionRef: "psr_ap" });
    store.releaseLease(id, store.get(id)!.leaseToken!);
    const ap = new ApprovalService(db);
    ap.request(id, "prq_1", "apr_1");
    ap.answer(id, "prq_1", "approved", "user");
    ap.markDelivering(id, "prq_1");
    ap.markDeliveryUnknown(id, "prq_1");

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: true }).reconcileOnBoot();
    const afterFirst = store.get(id)!.version;
    expect(ap.get(id, "prq_1")!.state).toBe("delivered");
    expect(store.get(id)!.state).toBe("RUNNING");

    await recovery({ canResume: true, approvalAckLookup: true, ackResult: true }).reconcileOnBoot();

    expect(ap.get(id, "prq_1")!.state).toBe("delivered");
    expect(store.get(id)!.state).toBe("RUNNING");
    expect(store.get(id)!.version).toBe(afterFirst); // no second transition
  });
});
