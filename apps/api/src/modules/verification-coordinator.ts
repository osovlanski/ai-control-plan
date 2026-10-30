import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  projectDependenciesMissing,
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
  /** Results the coordinator settled without running: skipped or blocked project checks. */
  outcomes?: VerificationCheckResult[];
}

/**
 * True only when the session's worktree provably changed nothing relative to
 * its base: HEAD is the base commit and the tree is clean. Any doubt is false.
 */
export type WorktreeUnchangedProbe = (worktreePath: string, baseRef: string) => Promise<boolean>;

const run = promisify(execFile);
export const gitWorktreeUnchanged: WorktreeUnchangedProbe = async (worktreePath, baseRef) => {
  try {
    const git = async (...args: string[]) =>
      (await run("git", ["-C", worktreePath, ...args], { maxBuffer: 10 * 1024 * 1024 })).stdout.trim();
    const [head, base, status] = await Promise.all([
      git("rev-parse", "--verify", "HEAD^{commit}"),
      git("rev-parse", "--verify", `${baseRef}^{commit}`),
      git("status", "--porcelain", "--untracked-files=all"),
    ]);
    return head.length > 0 && head === base && status === "";
  } catch {
    return false;
  }
};

const PROJECT_CHECK = "project:";
const SKIPPED_UNCHANGED = "skipped:unchanged";
const BLOCKED_DEPENDENCIES = "blocked:dependencies";
const UNCHANGED_REASON = "project verification skipped: the run changed nothing relative to its base (no diff, no new commits)";

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
    private readonly unchanged: WorktreeUnchangedProbe = gitWorktreeUnchanged,
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
      let revised = reviseVerificationPlan(initial, discovered);
      const target = request.context.worktree;
      if (target && revised.checks.some(isProjectCheck)) {
        if (changedFiles.length === 0 && await this.unchanged(target.worktreePath, target.baseRef)) {
          revised = settleProjectChecks(revised, SKIPPED_UNCHANGED, UNCHANGED_REASON);
        } else {
          const missing = projectDependenciesMissing(this.authority, target.worktreePath);
          if (missing) revised = settleProjectChecks(revised, BLOCKED_DEPENDENCIES, `blocked: ${missing}`);
        }
        throwIfAborted(signal);
      }
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

    const outcomes = settledOutcomes(effective);
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
      ...(outcomes.length > 0 ? { outcomes } : {}),
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
    const settled = (prepared.outcomes ?? []).filter((outcome) =>
      !evaluation.checks.some((check) => check.checkId === outcome.checkId));
    return this.store.complete({
      runId: prepared.verificationRunId,
      sessionId: prepared.sessionId,
      executionRequestId: prepared.executionRequestId,
      planRevisionId: prepared.planRevisionId,
      claimToken,
      evaluation: settled.length > 0 ? evaluationResult([...evaluation.checks, ...settled]) : evaluation,
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
    const outcomes = settledOutcomes(revision.plan);
    return {
      sessionId: run.sessionId,
      executionRequestId: run.executionRequestId,
      planRevisionId: run.planRevisionId,
      verificationRunId: run.id,
      checks: revision.plan.checks,
      ...(run.evaluation?.checks.find((check) => check.checkId === "preflight:planning")
        ? { preflightFailure: run.evaluation.checks.find((check) => check.checkId === "preflight:planning")! }
        : {}),
      ...(outcomes.length > 0 ? { outcomes } : {}),
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

function isProjectCheck(check: { checkId: string }): boolean {
  return check.checkId.startsWith(PROJECT_CHECK);
}

/**
 * Takes the project checks out of the executable plan and records why on their
 * decisions. The decision, not process memory, carries the outcome, so a
 * prepare replayed after a crash settles them the same way.
 */
function settleProjectChecks(plan: VerificationPlan, signal: string, reason: string): VerificationPlan {
  const settled = new Set(plan.checks.filter(isProjectCheck).map((check) => check.checkId));
  return {
    ...plan,
    checks: plan.checks.filter((check) => !settled.has(check.checkId)),
    decisions: plan.decisions.map((decision) => settled.has(decision.checkId)
      ? { ...decision, selected: false, signals: [...new Set([...decision.signals, signal])].sort(), reason }
      : decision),
  };
}

/** Skipped checks are not required (nothing to verify); blocked ones keep their requirement. */
function settledOutcomes(plan: VerificationPlan): VerificationCheckResult[] {
  return plan.decisions.flatMap((decision): VerificationCheckResult[] => {
    const skipped = decision.signals.includes(SKIPPED_UNCHANGED);
    if (!skipped && !decision.signals.includes(BLOCKED_DEPENDENCIES)) return [];
    const identity = parseIdentity(decision.capabilityIdentity);
    return [{
      checkId: decision.checkId,
      name: identity.name ?? decision.checkId,
      kind: identity.kind ?? "review",
      required: skipped ? false : decision.required,
      status: skipped ? "skipped" : "blocked",
      passed: false,
      summary: redactText(decision.reason).slice(0, 2000),
    }];
  });
}

function parseIdentity(identity: string | undefined): { name?: string; kind?: VerificationCheckResult["kind"] } {
  try {
    const parsed = JSON.parse(identity ?? "{}") as { name?: unknown; kind?: unknown };
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.kind === "string" ? { kind: parsed.kind as VerificationCheckResult["kind"] } : {}),
    };
  } catch {
    return {};
  }
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
