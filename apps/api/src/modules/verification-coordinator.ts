import {
  evaluationResult,
  planVerification,
  redactText,
  reviseVerificationPlan,
  type EvaluationResult,
  type ExecutionArtifact,
  type ExecutionRequest,
  type VerificationCheckResult,
  type VerificationPlan,
  type VerificationSpec,
} from "@agent-plane/core";
import {
  discoverProjectVerificationCapabilities,
  snapshotProjectVerification,
} from "./project-verification.js";
import type { WorkspaceAuthority } from "./harness/workspace-authority.js";
import {
  VerificationStoreConflictError,
  type StoredVerificationRun,
  type VerificationStore,
} from "./harness/verification-store.js";

export interface PreparedVerification {
  sessionId: string;
  executionRequestId: string;
  planRevisionId: string;
  verificationRunId: string;
  checks: Array<VerificationSpec & { checkId: string }>;
  preflightFailure?: VerificationCheckResult;
}

export interface VerificationCoordinatorCheckpoints {
  create(
    taskId: string,
    sessionId: string,
    reason: "pre_verification",
    sessionTarget?: { worktreePath: string; baseRef: string },
  ): Promise<{
    changedFiles: string[];
  }>;
}

export interface VerificationCoordinatorPort {
  prepare(sessionId: string, request: ExecutionRequest, signal?: AbortSignal): Promise<PreparedVerification>;
  claim(prepared: PreparedVerification, claimToken: string): void;
  complete(
    prepared: PreparedVerification,
    claimToken: string,
    evaluation: EvaluationResult,
    artifacts: ExecutionArtifact[],
  ): StoredVerificationRun;
  interrupt(prepared: PreparedVerification, claimToken: string, reason: string): StoredVerificationRun;
}

/**
 * Control-Plane authority for post-change verification planning. It owns
 * discovery and durable plan/run lifecycle; the Harness only executes the
 * returned, session-bound checks.
 */
export class VerificationCoordinator implements VerificationCoordinatorPort {
  constructor(
    private readonly store: VerificationStore,
    private readonly checkpoints: VerificationCoordinatorCheckpoints,
    private readonly authority: WorkspaceAuthority,
  ) {}

  async prepare(sessionId: string, request: ExecutionRequest, signal?: AbortSignal): Promise<PreparedVerification> {
    throwIfAborted(signal);
    const initialId = revisionId(sessionId, 1);
    const postChangeId = revisionId(sessionId, 2);
    const runId = verificationRunId(sessionId);

    const alreadyPrepared = this.store.getRun(runId);
    if (alreadyPrepared) return this.boundResult(alreadyPrepared);

    const initial = withRevision(initialPlan(request), initialId, 1);
    this.store.insertRevision({
      sessionId,
      executionRequestId: request.executionRequestId,
      plan: initial,
      reason: "initial",
    });

    let effective = initial;
    let preflightFailure: VerificationCheckResult | undefined;
    try {
      const checkpoint = await this.checkpoints.create(
        request.taskId,
        sessionId,
        "pre_verification",
        request.context.worktree
          ? { worktreePath: request.context.worktree.worktreePath, baseRef: request.context.worktree.baseRef }
          : undefined,
      );
      throwIfAborted(signal);
      const changedFiles = checkpoint.changedFiles;
      const worktreePath = request.context.worktree?.worktreePath;
      const discovery = worktreePath
        ? discoverProjectVerificationCapabilities(snapshotProjectVerification(this.authority, worktreePath))
        : { capabilities: [], warnings: [] };
      throwIfAborted(signal);
      if (discovery.warnings.length > 0) throw new Error(discovery.warnings.join("; "));
      const capabilities = discovery.capabilities;
      const discovered = planVerification({ changedFiles, capabilities });
      const revised = reviseVerificationPlan(initial, discovered);
      if (!samePlanContent(initial, revised)) {
        effective = withRevision(revised, postChangeId, 2, initialId);
        this.store.insertRevision({
          sessionId,
          executionRequestId: request.executionRequestId,
          plan: effective,
          reason: "post_change",
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const check = blockedPreflight(error);
      preflightFailure = check;
      const fallback = reviseVerificationPlan(initial, planVerification({
        changedFiles: [],
        explicitRequiredKinds: ["review"],
        capabilities: [{
          checkId: check.checkId!,
          name: check.name,
          kind: check.kind,
          provider: "preflight",
          required: true,
        }],
      }));
      if (!samePlanContent(initial, fallback)) {
        effective = withRevision(fallback, postChangeId, 2, initialId);
        this.store.insertRevision({
          sessionId,
          executionRequestId: request.executionRequestId,
          plan: effective,
          reason: "post_change",
        });
      }
    }

    this.store.prepareRun({
      runId,
      sessionId,
      executionRequestId: request.executionRequestId,
      planRevisionId: effective.planRevisionId,
    });
    return {
      sessionId,
      executionRequestId: request.executionRequestId,
      planRevisionId: effective.planRevisionId,
      verificationRunId: runId,
      checks: effective.checks,
      ...(preflightFailure ? { preflightFailure } : {}),
    };
  }

  claim(prepared: PreparedVerification, claimToken: string): void {
    this.assertPrepared(prepared);
    this.store.claim({
      runId: prepared.verificationRunId,
      sessionId: prepared.sessionId,
      executionRequestId: prepared.executionRequestId,
      planRevisionId: prepared.planRevisionId,
      claimToken,
    });
  }

  complete(
    prepared: PreparedVerification,
    claimToken: string,
    evaluation: EvaluationResult,
    artifacts: ExecutionArtifact[],
  ): StoredVerificationRun {
    this.assertPrepared(prepared);
    return this.store.complete({
      runId: prepared.verificationRunId,
      sessionId: prepared.sessionId,
      executionRequestId: prepared.executionRequestId,
      planRevisionId: prepared.planRevisionId,
      claimToken,
      evaluation,
      artifacts,
    });
  }

  interrupt(prepared: PreparedVerification, claimToken: string, reason: string): StoredVerificationRun {
    this.assertPrepared(prepared);
    return this.store.interrupt({
      runId: prepared.verificationRunId,
      sessionId: prepared.sessionId,
      executionRequestId: prepared.executionRequestId,
      planRevisionId: prepared.planRevisionId,
      claimToken,
      reason,
    });
  }

  private assertPrepared(prepared: PreparedVerification): void {
    const revision = this.store.getRevision(prepared.planRevisionId);
    if (!revision || revision.sessionId !== prepared.sessionId ||
        revision.executionRequestId !== prepared.executionRequestId) {
      throw new VerificationStoreConflictError("prepared verification revision binding mismatch");
    }
    const run = this.store.getRun(prepared.verificationRunId);
    if (!run || run.sessionId !== prepared.sessionId ||
        run.executionRequestId !== prepared.executionRequestId ||
        run.planRevisionId !== prepared.planRevisionId) {
      throw new VerificationStoreConflictError("prepared verification run binding mismatch");
    }
  }

  private boundResult(run: StoredVerificationRun): PreparedVerification {
    const revision = this.store.getRevision(run.planRevisionId);
    if (!revision) throw new VerificationStoreConflictError("verification run references an unknown revision");
    return {
      sessionId: run.sessionId,
      executionRequestId: run.executionRequestId,
      planRevisionId: run.planRevisionId,
      verificationRunId: run.id,
      checks: revision.plan.checks,
      ...(run.evaluation?.checks.find((check) => check.checkId === "preflight:planning")
        ? { preflightFailure: run.evaluation.checks.find((check) => check.checkId === "preflight:planning")! }
        : {}),
    };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(`verification preparation interrupted: ${String(signal.reason ?? "aborted")}`);
}

function initialPlan(request: ExecutionRequest): VerificationPlan {
  if (request.verificationPlan) {
    return {
      ...request.verificationPlan,
      checks: request.verificationPlan.checks.map((check) => ({ ...check })),
      decisions: request.verificationPlan.decisions.map((decision) => ({ ...decision })),
    };
  }
  const checks = request.verification.map((check, index) => ({
    ...check,
    checkId: check.checkId ?? `request:${index + 1}`,
  }));
  return {
    schemaVersion: 1,
    checks,
    decisions: checks.map((check) => ({
      checkId: check.checkId,
      selected: true,
      required: check.required,
      signals: ["request:accepted"],
      reason: "accepted execution request",
    })),
  };
}

function withRevision(
  plan: VerificationPlan,
  planRevisionId: string,
  revision: number,
  supersedesRevisionId?: string,
): VerificationPlan & { planRevisionId: string; revision: number } {
  const { planFingerprint: _fingerprint, fingerprintAlgorithm: _algorithm,
    planRevisionId: _oldId, revision: _oldRevision, supersedesRevisionId: _oldParent, ...content } = plan;
  return {
    ...content,
    planRevisionId,
    revision,
    ...(supersedesRevisionId ? { supersedesRevisionId } : {}),
  };
}

function samePlanContent(left: VerificationPlan, right: VerificationPlan): boolean {
  return JSON.stringify({ checks: left.checks, decisions: left.decisions, unmetRequirements: left.unmetRequirements ?? [] }) ===
    JSON.stringify({ checks: right.checks, decisions: right.decisions, unmetRequirements: right.unmetRequirements ?? [] });
}

function blockedPreflight(error: unknown): VerificationCheckResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    checkId: "preflight:planning",
    name: "verification planning",
    kind: "review",
    required: true,
    status: "blocked",
    passed: false,
    summary: `verification planning blocked: ${redactText(message).slice(0, 1800)}`,
  };
}

function revisionId(sessionId: string, revision: number): string {
  return `vpr_${sessionId}_${revision}`;
}
function verificationRunId(sessionId: string): string { return `vr_${sessionId}_post_change`; }

export function preflightEvaluation(check: VerificationCheckResult): EvaluationResult {
  return evaluationResult([check]);
}
