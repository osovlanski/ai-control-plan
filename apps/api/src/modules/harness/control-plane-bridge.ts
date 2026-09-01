/**
 * HarnessBridge — the flag-ON seam between the legacy `Orchestrator` control
 * plane and the `SessionRunner` execution harness (PLAN.md 8c.2).
 *
 * The Orchestrator keeps every decision (routing, failover, retry, verdict,
 * parallel); the runner owns execution and is the ONLY writer of the session
 * `runs` row. This bridge is a thin translator: it builds the `ExecutionRequest`,
 * hands it to `SessionRunner.start()`, and relays the detached result back to
 * `Orchestrator.settleFromResult`. It never writes `runs`.
 */
import type { ExecutionRequest, ExecutionResult } from "@agent-plane/core";
import { DEFAULT_REDACTION_RULES } from "@agent-plane/core";
import type { ApprovalMode } from "../../config.js";
import type { Db } from "../../db/index.js";
import type { ApprovalService } from "./approval-service.js";
import type { SessionRunner } from "./session-runner.js";
import type { SessionStore } from "./session-store.js";

export interface BridgeStartInput {
  taskId: string;
  assistantId: string;
  /** Harness attempt number — `MAX(execution_requests.attempt)+1` for this task. */
  attempt: number;
  prompt: string;
  workdir: string;
  worktree?: { repoPath: string; branch: string; worktreePath: string; baseRef: string };
  approvalMode: ApprovalMode;
  maxRuntimeMs: number;
  routingDecisionRef: string;
}

/**
 * Pure — the flag-ON equivalent of the legacy `startTask` runSpec build. No
 * assistant in the id (it lives in the request fingerprint); `origin` is always
 * `fresh` this pass (cross-provider handoff is a fresh-prompt start — legacy
 * parity; the `handoff_envelopes` claim protocol is a named post-cutover
 * deferral, PLAN.md 8e step 4).
 */
export function buildExecutionRequest(input: BridgeStartInput): ExecutionRequest {
  return {
    schemaVersion: 1,
    executionRequestId: `erq_${input.taskId}_${input.attempt}`,
    taskId: input.taskId as ExecutionRequest["taskId"],
    attempt: input.attempt,
    assistantId: input.assistantId as ExecutionRequest["assistantId"],
    routingDecisionRef: input.routingDecisionRef,
    runSpec: {
      taskId: input.taskId as ExecutionRequest["taskId"],
      prompt: input.prompt,
      workdir: input.workdir,
      permissionPolicy: { mode: input.approvalMode },
      env: { redactionRules: DEFAULT_REDACTION_RULES, maxRuntimeMs: input.maxRuntimeMs },
    },
    policy: {
      budget: { enforcement: "advisory" },
      timeout: { hardMs: input.maxRuntimeMs },
      approval: { mode: input.approvalMode },
      tools: { mode: "audit" },
      checkpoint: { onSoftLimit: true },
      isolation: { required: "ambient" },
    },
    context: input.worktree ? { worktree: input.worktree } : {},
    verification: [],
    origin: { kind: "fresh" },
  };
}

export interface HarnessBridgeDeps {
  runner: SessionRunner;
  store: SessionStore;
  approvals: ApprovalService;
  db: Db;
  /** Detached-execution failures are logged, never thrown into the caller. */
  onError?: (err: unknown) => void;
}

export class HarnessBridge {
  private readonly runner: SessionRunner;
  private readonly store: SessionStore;
  private readonly approvals: ApprovalService;
  private readonly db: Db;
  private readonly onError: (err: unknown) => void;

  /**
   * In-memory durable-parity of legacy's `run.handingOff` flag (single-process,
   * §9): a session whose task transition is owned by a cancel / manual-handoff
   * in flight, so the detached `settleFromResult` must not touch the task.
   */
  private readonly planeOwnsTerminal = new Set<string>();

  constructor(deps: HarnessBridgeDeps) {
    this.runner = deps.runner;
    this.store = deps.store;
    this.approvals = deps.approvals;
    this.db = deps.db;
    this.onError = deps.onError ?? (() => {});
  }

  /**
   * Build the request, start the runner (synchronous setup, detached execution),
   * and wire the settle callback. On a rejected `done` promise with no persisted
   * result, `onSettled` is called with `null` — the Orchestrator parks the task
   * for boot recovery. Nothing is ever fabricated outside `SessionStore`.
   */
  start(
    input: BridgeStartInput,
    onSettled: (result: ExecutionResult | null, sessionId: string) => void,
  ): { runId: string } {
    const request = buildExecutionRequest(input);
    const { sessionId, done } = this.runner.start(request);
    done
      .then((result) => onSettled(result, sessionId))
      .catch((err) => {
        this.onError(err);
        onSettled(this.store.result(sessionId) ?? null, sessionId);
      });
    return { runId: sessionId };
  }

  markPlaneOwnsTerminal(sessionId: string): void {
    this.planeOwnsTerminal.add(sessionId);
  }

  /** Test-and-clear. */
  consumePlaneOwnsTerminal(sessionId: string): boolean {
    return this.planeOwnsTerminal.delete(sessionId);
  }

  /** Durable cancel intent — the runner's loop + heartbeat observe it (§9). */
  requestCancel(sessionId: string): boolean {
    return this.store.requestCancel(sessionId);
  }

  /** The persisted terminal result for a session, if one has been written. */
  result(sessionId: string): ExecutionResult | undefined {
    return this.store.result(sessionId);
  }

  /** Current session state, for `waitUntilSessionTerminal` polling. */
  sessionState(sessionId: string): string | undefined {
    return this.store.get(sessionId)?.state;
  }

  answerApproval(sessionId: string, providerRequestId: string, approved: boolean): void {
    this.approvals.answer(sessionId, providerRequestId, approved ? "approved" : "denied", "user");
  }

  /** Newest harness session for the task that is still live (no `ended_at`). */
  liveSessionId(taskId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
        )
        .get(taskId) as { id: string } | undefined
    )?.id;
  }

  /**
   * Newest harness session for the task regardless of `ended_at` — for control
   * ops that must win the race against `settleFromResult` (PLAN.md R1 #12).
   */
  latestSessionId(taskId: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
        )
        .get(taskId) as { id: string } | undefined
    )?.id;
  }
}
