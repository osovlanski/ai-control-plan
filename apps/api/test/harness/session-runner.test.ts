/**
 * Phase 3 — SessionRunner over the fake adapter (§12 layer 3). Covers the
 * required lifecycle matrix: success, approval pause/resume, denied approval,
 * cancellation, timeout, reroute yield, provider-failure normalization,
 * duplicate-execution prevention, workspace rejection, successful-execution +
 * failed-verification (H-I6), and restart recovery of a finished session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentAdapter,
  AssistantId,
  CapabilityManifest,
  ExecutionRequest,
  NormalizedEvent,
  RunHandle,
  RunId,
  TaskId,
} from "@agent-plane/core";
import { FakeAdapter, type FakeScript } from "@agent-plane/adapters";
import { openDb, type Db } from "../../src/db/index.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { EventRecorder } from "../../src/modules/harness/event-recorder.js";
import { SessionRunner, type RunnerDeps } from "../../src/modules/harness/session-runner.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";
import { WorkspaceAuthority } from "../../src/modules/harness/workspace-authority.js";

let dir: string;
let db: Db;
let store: SessionStore;
let startCount: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-runner-"));
  db = openDb(join(dir, "t.db"));
  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-1','g','{}','t','t')").run();
  store = new SessionStore(db);
  startCount = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const MANIFEST: CapabilityManifest = {
  assistantId: "a1" as AssistantId,
  provider: "fake",
  core: {
    models: [{ id: "fake-1" }],
    canResume: true,
    canMcp: false,
    supportsMidRunInput: true,
    reportsUsage: true,
    reportsLimits: true,
    execution: { shell: true, filesystem: true, web: "no" },
    auth: { state: "ok" },
  },
  harness: {
    usageAccounting: "delta",
    toolGating: "none",
    approvalRelay: true,
    processIsolation: "none",
  },
  providerDetail: {},
  evidence: { source: "runtime-probe", observedAt: "t" },
};

/** Counts adapter.start calls so duplicate-execution prevention is observable. */
function countingFake(script?: FakeScript): AgentAdapter {
  const fake = new FakeAdapter("a1" as AssistantId, script);
  const realStart = fake.start.bind(fake);
  fake.start = async (spec) => {
    startCount += 1;
    return realStart(spec);
  };
  return fake;
}

function deps(adapter: AgentAdapter, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    recorder: new EventRecorder(db),
    approvals: new ApprovalService(db),
    checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
    registry: { adapter: () => adapter, manifest: () => MANIFEST },
    softThresholdPct: 80,
    approvalPollMs: 5,
    ...over,
  };
}

function request(over: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: "erq_1",
    taskId: "AG-1" as TaskId,
    attempt: 1,
    assistantId: "a1" as AssistantId,
    routingDecisionRef: "rd_1",
    runSpec: {
      taskId: "AG-1" as TaskId,
      prompt: "do the thing",
      workdir: dir,
      permissionPolicy: { mode: "auto-approve" },
      env: { redactionRules: [], maxRuntimeMs: 60_000 },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: 60_000 },
      approval: { mode: "auto-approve" },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "partial" },
    },
    context: {},
    verification: [],
    origin: { kind: "fresh" },
    ...over,
  };
}

const sessionOf = () => store.forRequest("erq_1")!.sessionId as string;
const events = (sid: string) =>
  db.prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq").all(sid) as Array<{
    type: string;
    payload: string | null;
  }>;
const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("happy path", () => {
  it("runs to COMPLETED, persists one result, and accumulates telemetry", async () => {
    const runner = new SessionRunner(deps(countingFake()));
    const result = await runner.run(request());

    expect(result.outcome).toBe("completed");
    expect(result.terminalState).toBe("COMPLETED");
    expect(result.verification).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 450, accounting: "delta" });

    const sid = sessionOf();
    expect(store.get(sid)!.state).toBe("COMPLETED");
    expect(store.result(sid)).toEqual(result);
    const types = events(sid).map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("run.ended");
  });
});

describe("guard telemetry", () => {
  it("co-commits the triggering event, the guard.decision audit event and the pending directive", async () => {
    const script: FakeScript = {
      ok: true,
      events: [
        { type: "usage.updated", summary: "usage", payload: { inputTokens: 900, outputTokens: 0 } },
        { type: "message", summary: "done", payload: { text: "done" } },
      ],
    };
    const runner = new SessionRunner(deps(countingFake(script)));
    await runner.run(request({ policy: { ...request().policy, budget: { enforcement: "advisory", maxTokens: 1000 } } }));

    const rows = events(sessionOf());
    const guardEv = rows.find((e) => e.type === "guard.decision");
    expect(JSON.parse(guardEv!.payload!)).toMatchObject({ guard: "budget", directive: "checkpoint" });

    const directive = db
      .prepare("SELECT guard, status, event_seq FROM guard_directives WHERE session_id = ?")
      .get(sessionOf()) as { guard: string; status: string; event_seq: number };
    expect(directive.guard).toBe("budget");
    expect(directive.status).toBe("applied"); // flipped from pending after the action
    // event_seq points at the usage.updated that triggered it
    const usageSeq = db
      .prepare("SELECT seq FROM events WHERE run_id = ? AND type = 'usage.updated'")
      .get(sessionOf()) as { seq: number };
    expect(directive.event_seq).toBe(usageSeq.seq);
  });
});

describe("time-based guards while the stream is stalled", () => {
  it("a heartbeat tick fires the hard timeout even with no further provider events", async () => {
    // An adapter that yields one event then hangs forever.
    const hanging: AgentAdapter = {
      id: "a1" as AssistantId,
      describe: async () => MANIFEST,
      start: async () => ({ runId: "h1", assistantId: "a1" as AssistantId }),
      resume: async () => ({ runId: "h1", assistantId: "a1" as AssistantId }),
      events: async function* () {
        yield { runId: "h1" as RunId, ts: new Date().toISOString(), type: "run.started", summary: "started" };
        await new Promise(() => {}); // hang
      },
      cancel: async () => {},
    };
    const runner = new SessionRunner(deps(hanging, { approvalPollMs: 5 }));
    const result = await runner.run(request({ policy: { ...request().policy, timeout: { hardMs: 30 } } }));
    expect(result.outcome).toBe("timed_out");
    expect(result.terminalState).toBe("TIMED_OUT");
  });
});

const promptOnEscalation = (): Partial<ExecutionRequest> => ({
  policy: { ...request().policy, approval: { mode: "prompt-on-escalation" } },
});

describe("approval pause / resume", () => {
  it("does NOT pause under auto-approve — it answers yes and runs to COMPLETED", async () => {
    const runner = new SessionRunner(deps(countingFake({ ok: true, events: defaultBody(), approvalAfter: 1 })));
    const result = await runner.run(request()); // default policy is auto-approve
    expect(result.outcome).toBe("completed");
    // No durable approvals row was created — the answer went straight to the adapter.
    const count = db.prepare("SELECT COUNT(*) c FROM approvals WHERE session_id = ?").get(sessionOf()) as { c: number };
    expect(count.c).toBe(0);
  });

  it("pauses on approval.requested and resumes to COMPLETED when approved (prompt-on-escalation)", async () => {
    const runner = new SessionRunner(deps(countingFake({ ok: true, events: defaultBody(), approvalAfter: 1 })));
    const done = runner.run(request(promptOnEscalation()));

    await waitFor(() => store.forRequest("erq_1")?.state === "AWAITING_APPROVAL");
    const sid = sessionOf();
    const approvals = new ApprovalService(db);
    const prq = approvals.pending(sid)[0]!.providerRequestId;
    approvals.answer(sid, prq, "approved", "user:alice");

    const result = await done;
    expect(result.outcome).toBe("completed");
    expect(approvals.get(sid, prq)!.state).toBe("delivered");
  });

  it("a denied approval ends FAILED and non-retryable (no failover)", async () => {
    const runner = new SessionRunner(deps(countingFake({ ok: true, events: defaultBody(), approvalAfter: 1 })));
    const done = runner.run(request(promptOnEscalation()));
    await waitFor(() => store.forRequest("erq_1")?.state === "AWAITING_APPROVAL");
    const sid = sessionOf();
    const approvals = new ApprovalService(db);
    approvals.answer(sid, approvals.pending(sid)[0]!.providerRequestId, "denied", "user");

    const result = await done;
    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ kind: "provider_fault", retryable: false });
  });
});

describe("cancellation", () => {
  it("honors a durable cancel intent raised while AWAITING_APPROVAL", async () => {
    const runner = new SessionRunner(deps(countingFake({ ok: true, events: defaultBody(), approvalAfter: 1 })));
    const done = runner.run(request(promptOnEscalation()));
    await waitFor(() => store.forRequest("erq_1")?.state === "AWAITING_APPROVAL");
    store.requestCancel(sessionOf());

    const result = await done;
    expect(result.outcome).toBe("cancelled");
    expect(result.terminalState).toBe("CANCELLED");
    expect(result.cancellation).toMatchObject({ requestedBy: "plane" });
  });
});

describe("timeout", () => {
  it("cancels on the hard deadline and reports TIMED_OUT", async () => {
    const script: FakeScript = { ok: true, delayMs: 25, events: defaultBody() };
    const runner = new SessionRunner(deps(countingFake(script)));
    const result = await runner.run(request({ policy: { ...request().policy, timeout: { hardMs: 1 } } }));
    expect(result.outcome).toBe("timed_out");
    expect(result.terminalState).toBe("TIMED_OUT");
    expect(result.failure).toMatchObject({ kind: "timeout" });
  });
});

describe("reroute yield (H-I1)", () => {
  it("yields a structured RerouteRequest when evidence says the route is unsuitable", async () => {
    const script: FakeScript = {
      ok: false,
      events: [{ type: "error", summary: "no vision capability", payload: { kind: "capability_missing" } }],
    };
    const runner = new SessionRunner(deps(countingFake(script)));
    const result = await runner.run(request());

    expect(result.outcome).toBe("yielded");
    expect(result.terminalState).toBe("YIELDED");
    expect(result.yield?.kind).toBe("reroute");
    const detail = result.yield!.detail as { reason: string; evidence: unknown[]; suggestion?: unknown };
    expect(detail.reason).toBe("capability_missing");
    expect(detail.evidence.length).toBeGreaterThan(0);
    expect(detail.suggestion).toBeUndefined();
  });
});

describe("provider failure normalization", () => {
  it("maps an auth error on start() to failure.kind auth", async () => {
    const throwing: AgentAdapter = {
      id: "a1" as AssistantId,
      describe: async () => MANIFEST,
      start: async () => {
        throw new Error("auth token expired");
      },
      resume: async () => {
        throw new Error("nope");
      },
      events: () => (async function* () {})(),
      cancel: async () => {},
    };
    const result = await new SessionRunner(deps(throwing)).run(request());
    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ kind: "auth", retryable: false });
  });

  it("maps a mid-stream error event to a retryable provider_fault", async () => {
    const script: FakeScript = { ok: false, events: [{ type: "error", summary: "provider crashed" }] };
    const result = await new SessionRunner(deps(countingFake(script))).run(request());
    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ kind: "provider_fault", retryable: true });
  });

  it("normalizes auth_failed to FAILED(auth), NOT a reroute yield", async () => {
    const script: FakeScript = { ok: false, events: [{ type: "error", summary: "token expired", payload: { kind: "auth_failed" } }] };
    const result = await new SessionRunner(deps(countingFake(script))).run(request());
    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ kind: "auth", retryable: false });
  });

  it("prefers an adapter's embedded ExecutionFailure when present", async () => {
    const script: FakeScript = {
      ok: false,
      events: [{ type: "error", summary: "quota", payload: { failure: { kind: "quota", retryable: true, message: "5h window" } } }],
    };
    const result = await new SessionRunner(deps(countingFake(script))).run(request());
    expect(result.failure).toMatchObject({ kind: "quota", retryable: true, message: "5h window" });
  });
});

describe("RunSpec gate + idempotency key (§6)", () => {
  it("passes toolPolicy and runControl.executionRequestId to the adapter", async () => {
    let seen: unknown;
    const fake = new FakeAdapter("a1" as AssistantId);
    const realStart = fake.start.bind(fake);
    fake.start = async (spec) => {
      seen = spec;
      return realStart(spec);
    };
    await new SessionRunner(deps(fake)).run(
      request({ policy: { ...request().policy, tools: { mode: "audit", deny: ["rm"] } } }),
    );
    expect(seen).toMatchObject({
      toolPolicy: { mode: "audit", deny: ["rm"] },
      runControl: { executionRequestId: "erq_1" },
    });
  });
});

describe("live-session recovery guard", () => {
  it("refuses to re-run a non-PREPARED session that has no result", async () => {
    store.recordRequest(request());
    const sid = store.createSession("erq_1").sessionId as string;
    const t = store.acquireLease(sid)!;
    store.transition(sid, { expectedVersion: 0, from: "PREPARED", to: "STARTING", leaseToken: t });
    store.transition(sid, { expectedVersion: 1, from: "STARTING", to: "RUNNING", leaseToken: t });
    store.releaseLease(sid, t);

    await expect(new SessionRunner(deps(countingFake())).run(request())).rejects.toThrow(/restart recovery/);
  });
});

describe("duplicate execution prevention (H-I8)", () => {
  it("a resubmission returns the same stored result and starts the adapter once", async () => {
    const runner = new SessionRunner(deps(countingFake()));
    const first = await runner.run(request());
    const second = await new SessionRunner(deps(countingFake())).run(request());
    expect(second).toEqual(first);
    expect(startCount).toBe(1);
    const rows = db.prepare("SELECT COUNT(*) c FROM runs WHERE execution_request_id = 'erq_1'").get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe("workspace rejection", () => {
  it("fails before any adapter call when the worktree is not allowlisted", async () => {
    const authority = new WorkspaceAuthority({ repoAllowlist: [], worktreeRoot: dir });
    const runner = new SessionRunner(deps(countingFake(), { authority }));
    const result = await runner.run(
      request({
        context: { worktree: { repoPath: "/definitely/not/allowed", branch: "b", worktreePath: dir, baseRef: "r" } },
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.failure?.kind).toBe("workspace");
    expect(startCount).toBe(0);
  });

  it("rejects a policy the adapter cannot enforce (policy_unenforceable)", async () => {
    const runner = new SessionRunner(deps(countingFake()));
    const result = await runner.run(
      request({ policy: { ...request().policy, isolation: { required: "full" } } }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.failure?.kind).toBe("policy_unenforceable");
    expect(startCount).toBe(0);
  });
});

describe("successful execution + failed verification (H-I6)", () => {
  it("ends COMPLETED even though a required check failed — the plane decides", async () => {
    const authority = new WorkspaceAuthority({ repoAllowlist: [dir], worktreeRoot: dir });
    const runner = new SessionRunner(deps(countingFake(), { authority }));
    const result = await runner.run(
      request({
        context: { worktree: { repoPath: dir, branch: "b", worktreePath: dir, baseRef: "r" } },
        verification: [{ name: "unit", kind: "command", command: "exit 3", required: true }],
      }),
    );
    expect(result.outcome).toBe("completed");
    expect(result.terminalState).toBe("COMPLETED");
    expect(result.verification?.passed).toBe(false);
    expect(result.verification?.checks[0]).toMatchObject({ name: "unit", passed: false, required: true });

    const vr = events(sessionOf()).find((e) => e.type === "verification.result");
    expect(JSON.parse(vr!.payload!)).toMatchObject({ passed: false });
  });
});

describe("restart recovery", () => {
  it("a fresh runner returns the persisted result for a finished request", async () => {
    await new SessionRunner(deps(countingFake())).run(request());
    const startsBefore = startCount;
    const again = await new SessionRunner(deps(countingFake())).run(request());
    expect(again.outcome).toBe("completed");
    expect(startCount).toBe(startsBefore); // the finished session is not re-run
  });
});

/** The DEFAULT_SCRIPT body minus its trailing message, for approval scripts. */
function defaultBody(): FakeScript["events"] {
  return [
    { type: "message", summary: "planning", payload: { text: "planning" } },
    { type: "file.changed", summary: "edit", payload: { path: "src/x.ts", kind: "update" } },
    { type: "usage.updated", summary: "usage", payload: { inputTokens: 1200, outputTokens: 450 } },
    { type: "message", summary: "done", payload: { text: "done" } },
  ];
}

// Silence "unused" for the NormalizedEvent/RunId/RunHandle imports kept for clarity.
export type _Keep = NormalizedEvent | RunId | RunHandle;
