import {
  evaluationResult,
  redactText,
  verificationPlanFingerprint,
  type EvaluationResult,
  type ExecutionArtifact,
  type VerificationCheckResult,
  type VerificationPlan,
} from "@agent-plane/core";
import type { Db } from "../../db/index.js";

export type VerificationRunState = "ready" | "claimed" | "completed" | "interrupted";

export interface StoredVerificationRevision {
  id: string;
  sessionId: string;
  executionRequestId: string;
  revision: number;
  supersedesRevisionId?: string;
  planFingerprint: string;
  plan: VerificationPlan;
  reason: "initial" | "post_change" | "recovery";
  createdAt: string;
}

export interface StoredVerificationRun {
  id: string;
  sessionId: string;
  executionRequestId: string;
  planRevisionId: string;
  state: VerificationRunState;
  claimToken?: string;
  claimedAt?: string;
  evaluation?: EvaluationResult;
  artifacts: ExecutionArtifact[];
  interruptionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export class VerificationStoreConflictError extends Error {
  constructor(message: string) { super(message); this.name = "VerificationStoreConflictError"; }
}

const MAX_TEXT = 2_000;
const MAX_CHECKS = 100;
const MAX_ARTIFACTS = 100;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const VERIFICATION_KINDS = new Set(["tests", "typecheck", "lint", "command", "artifact_exists", "evaluator", "api", "browser", "review"]);
const CHECK_STATUSES = new Set(["passed", "failed", "skipped", "blocked"]);
const ARTIFACT_KINDS = new Set(["diff", "file_list", "test_report", "checkpoint", "rendered_output", "api_report", "browser_report", "screenshot", "console_log", "evaluation_report", "review_report", "trace_ref"]);
const RETENTIONS = new Set(["ephemeral", "session", "task", "pinned"]);
function clean(value: string, max = MAX_TEXT): string { return redactText(value).slice(0, max); }

function sanitizeEvaluation(value: EvaluationResult): EvaluationResult {
  if (!value || typeof value !== "object" || !Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) {
    throw new VerificationStoreConflictError(`verification evaluation must contain at most ${MAX_CHECKS} checks`);
  }
  const checks = value.checks.map((raw): VerificationCheckResult => {
    if (raw === null || typeof raw !== "object") {
      throw new VerificationStoreConflictError("invalid verification check result");
    }
    const check = raw as unknown as Record<string, unknown>;
    if (typeof check.name !== "string" || typeof check.summary !== "string" ||
        typeof check.required !== "boolean" || typeof check.passed !== "boolean" ||
        typeof check.kind !== "string" || !VERIFICATION_KINDS.has(check.kind) ||
        (check.checkId !== undefined && typeof check.checkId !== "string") ||
        (check.ref !== undefined && typeof check.ref !== "string") ||
        (check.status !== undefined && (typeof check.status !== "string" || !CHECK_STATUSES.has(check.status))) ||
        (check.status === "passed" && check.passed !== true) ||
        (check.status !== undefined && check.status !== "passed" && check.passed !== false)) {
      throw new VerificationStoreConflictError("invalid verification check result");
    }
    const base = {
      ...(typeof check.checkId === "string" ? { checkId: clean(check.checkId) } : {}),
      name: clean(check.name),
      kind: check.kind as VerificationCheckResult["kind"],
      required: check.required,
      summary: clean(check.summary),
      ...(typeof check.ref === "string" ? { ref: clean(check.ref) } : {}),
    };
    if (check.status === undefined) return { ...base, passed: check.passed };
    if (check.status === "passed") return { ...base, status: "passed", passed: true };
    return { ...base, status: check.status as "failed" | "skipped" | "blocked", passed: false };
  });
  return evaluationResult(checks);
}

function sanitizeArtifacts(values: readonly ExecutionArtifact[]): ExecutionArtifact[] {
  if (!Array.isArray(values) || values.length > MAX_ARTIFACTS) {
    throw new VerificationStoreConflictError(`verification run must contain at most ${MAX_ARTIFACTS} artifacts`);
  }
  return values.map((raw): ExecutionArtifact => {
    if (raw === null || typeof raw !== "object") {
      throw new VerificationStoreConflictError("invalid verification artifact");
    }
    const artifact = raw as unknown as Record<string, unknown>;
    if (typeof artifact.kind !== "string" || !ARTIFACT_KINDS.has(artifact.kind) ||
        typeof artifact.ref !== "string" || typeof artifact.summary !== "string" ||
        (artifact.digest !== undefined && typeof artifact.digest !== "string") ||
        (artifact.mediaType !== undefined && typeof artifact.mediaType !== "string") ||
        (artifact.sizeBytes !== undefined && (typeof artifact.sizeBytes !== "number" || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0)) ||
        (artifact.retention !== undefined && (typeof artifact.retention !== "string" || !RETENTIONS.has(artifact.retention)))) {
      throw new VerificationStoreConflictError("invalid verification artifact");
    }
    return {
      kind: artifact.kind as ExecutionArtifact["kind"],
      ref: clean(artifact.ref),
      summary: clean(artifact.summary),
      ...(typeof artifact.digest === "string" ? { digest: clean(artifact.digest) } : {}),
      ...(typeof artifact.mediaType === "string" ? { mediaType: clean(artifact.mediaType, 200) } : {}),
      ...(typeof artifact.sizeBytes === "number" ? { sizeBytes: artifact.sizeBytes } : {}),
      ...(typeof artifact.retention === "string" ? { retention: artifact.retention as NonNullable<ExecutionArtifact["retention"]> } : {}),
    };
  });
}

export class VerificationStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}
  private iso(): string { return this.now().toISOString(); }

  insertRevision(input: {
    sessionId: string;
    executionRequestId: string;
    plan: VerificationPlan & { planRevisionId: string; revision: number };
    reason: StoredVerificationRevision["reason"];
  }): { revision: StoredVerificationRevision; deduped: boolean } {
    const computed = verificationPlanFingerprint(input.plan);
    if (input.plan.planFingerprint && input.plan.planFingerprint !== computed.fingerprint) {
      throw new VerificationStoreConflictError("verification plan fingerprint does not match its canonical revision");
    }
    if (input.plan.fingerprintAlgorithm && input.plan.fingerprintAlgorithm !== computed.algorithm) {
      throw new VerificationStoreConflictError("verification plan fingerprint algorithm is unsupported");
    }
    const plan: VerificationPlan = {
      ...input.plan,
      planFingerprint: computed.fingerprint,
      fingerprintAlgorithm: computed.algorithm,
    };
    const existing = this.getRevision(input.plan.planRevisionId);
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.executionRequestId !== input.executionRequestId ||
          existing.planFingerprint !== computed.fingerprint || existing.reason !== input.reason) {
        throw new VerificationStoreConflictError(`verification revision ${input.plan.planRevisionId} was reused with different content or binding`);
      }
      return { revision: existing, deduped: true };
    }
    try {
      this.db.prepare(
        `INSERT INTO verification_plan_revisions
           (id, session_id, execution_request_id, revision, supersedes_revision_id,
            plan_fingerprint, fingerprint_algorithm, plan, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.plan.planRevisionId, input.sessionId, input.executionRequestId, input.plan.revision,
        input.plan.supersedesRevisionId ?? null, computed.fingerprint, computed.algorithm,
        JSON.stringify(plan), input.reason, this.iso());
    } catch (error) {
      if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) {
        const raced = this.getRevision(input.plan.planRevisionId);
        if (raced && raced.sessionId === input.sessionId && raced.executionRequestId === input.executionRequestId &&
            raced.planFingerprint === computed.fingerprint && raced.reason === input.reason) {
          return { revision: raced, deduped: true };
        }
      }
      throw error;
    }
    return { revision: this.getRevision(input.plan.planRevisionId)!, deduped: false };
  }

  getRevision(id: string): StoredVerificationRevision | undefined {
    const row = this.db.prepare("SELECT * FROM verification_plan_revisions WHERE id = ?").get(id) as RevisionRow | undefined;
    return row ? toRevision(row) : undefined;
  }

  /** Deterministic read projection used by recovery and the read-only API. */
  revisionsForSession(sessionId: string): StoredVerificationRevision[] {
    return (this.db.prepare(
      `SELECT id, session_id, execution_request_id, revision, supersedes_revision_id,
              plan_fingerprint, plan, reason, created_at
         FROM verification_plan_revisions
        WHERE session_id = ? ORDER BY revision, id`,
    ).all(sessionId) as RevisionRow[]).map(toRevision);
  }

  prepareRun(input: { runId: string; sessionId: string; executionRequestId: string; planRevisionId: string }): { run: StoredVerificationRun; deduped: boolean } {
    const existing = this.getRun(input.runId);
    if (existing) {
      this.assertBinding(existing, input);
      return { run: existing, deduped: true };
    }
    const at = this.iso();
    try {
      this.db.prepare(
        `INSERT INTO verification_runs
           (id, session_id, execution_request_id, plan_revision_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
      ).run(input.runId, input.sessionId, input.executionRequestId, input.planRevisionId, at, at);
    } catch (error) {
      const raced = this.getRun(input.runId);
      if (raced) { this.assertBinding(raced, input); return { run: raced, deduped: true }; }
      throw error;
    }
    return { run: this.getRun(input.runId)!, deduped: false };
  }

  claim(input: { runId: string; sessionId: string; executionRequestId: string; planRevisionId: string; claimToken: string }): { run: StoredVerificationRun; deduped: boolean } {
    assertNonBlank(input.claimToken, "claim token");
    const current = this.requireRun(input.runId); this.assertBinding(current, input);
    if (current.state === "claimed" && current.claimToken === input.claimToken) return { run: current, deduped: true };
    if (current.state !== "ready") throw new VerificationStoreConflictError(`verification run ${input.runId} is ${current.state}, not ready`);
    const at = this.iso();
    const result = this.db.prepare(
      `UPDATE verification_runs SET state='claimed', claim_token=?, claimed_at=?, updated_at=?
       WHERE id=? AND session_id=? AND execution_request_id=? AND plan_revision_id=? AND state='ready'`,
    ).run(input.claimToken, at, at, input.runId, input.sessionId, input.executionRequestId, input.planRevisionId);
    if (result.changes !== 1) throw new VerificationStoreConflictError(`stale claim for verification run ${input.runId}`);
    return { run: this.requireRun(input.runId), deduped: false };
  }

  complete(input: { runId: string; sessionId: string; executionRequestId: string; planRevisionId: string; claimToken: string; evaluation: EvaluationResult; artifacts: ExecutionArtifact[] }): StoredVerificationRun {
    return this.settle(input, "completed");
  }

  interrupt(input: { runId: string; sessionId: string; executionRequestId: string; planRevisionId: string; claimToken: string; reason: string }): StoredVerificationRun {
    return this.settle(input, "interrupted");
  }

  getRun(id: string): StoredVerificationRun | undefined {
    const row = this.db.prepare("SELECT * FROM verification_runs WHERE id = ?").get(id) as VerificationRunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** Runs follow plan revision order, then stable creation/id tie-breakers. */
  runsForSession(sessionId: string): StoredVerificationRun[] {
    return (this.db.prepare(
      `SELECT vr.id, vr.session_id, vr.execution_request_id, vr.plan_revision_id,
              vr.state, vr.claim_token, vr.claimed_at, vr.evaluation, vr.artifacts,
              vr.interruption_reason, vr.created_at, vr.updated_at
         FROM verification_runs vr
         JOIN verification_plan_revisions p ON p.id = vr.plan_revision_id
        WHERE vr.session_id = ?
        ORDER BY p.revision, vr.created_at, vr.id`,
    ).all(sessionId) as VerificationRunRow[]).map(toRun);
  }

  latestRunForSession(sessionId: string): StoredVerificationRun | undefined {
    return this.runsForSession(sessionId).at(-1);
  }

  private settle(input: { runId: string; sessionId: string; executionRequestId: string; planRevisionId: string; claimToken: string; evaluation?: EvaluationResult; artifacts?: ExecutionArtifact[]; reason?: string }, state: "completed" | "interrupted"): StoredVerificationRun {
    assertNonBlank(input.claimToken, "claim token");
    if (state === "interrupted") assertNonBlank(input.reason, "interruption reason");
    const current = this.requireRun(input.runId); this.assertBinding(current, input);
    const evaluation = state === "completed" ? sanitizeEvaluation(input.evaluation!) : undefined;
    const artifacts = state === "completed" ? sanitizeArtifacts(input.artifacts ?? []) : undefined;
    const reason = state === "interrupted" ? clean(input.reason ?? "interrupted") : undefined;
    const evidenceJson = state === "completed" ? JSON.stringify({ evaluation, artifacts }) : undefined;
    if (evidenceJson !== undefined && new TextEncoder().encode(evidenceJson).byteLength > MAX_EVIDENCE_BYTES) {
      throw new VerificationStoreConflictError(`verification evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
    }
    if (current.state === state && current.claimToken === input.claimToken) {
      const same = state === "completed"
        ? canonicalEqual(current.evaluation, evaluation) && canonicalEqual(current.artifacts, artifacts)
        : current.interruptionReason === reason;
      if (same) return current;
    }
    if (current.state !== "claimed" || current.claimToken !== input.claimToken) {
      throw new VerificationStoreConflictError(`stale settlement for verification run ${input.runId}`);
    }
    const at = this.iso();
    const result = this.db.prepare(
      `UPDATE verification_runs SET state=?, evaluation=?, artifacts=?, interruption_reason=?, updated_at=?
       WHERE id=? AND session_id=? AND execution_request_id=? AND plan_revision_id=? AND state='claimed' AND claim_token=?`,
    ).run(state, evaluation ? JSON.stringify(evaluation) : null, artifacts ? JSON.stringify(artifacts) : null,
      reason ?? null, at, input.runId, input.sessionId, input.executionRequestId, input.planRevisionId, input.claimToken);
    if (result.changes !== 1) throw new VerificationStoreConflictError(`stale settlement for verification run ${input.runId}`);
    return this.requireRun(input.runId);
  }

  private requireRun(id: string): StoredVerificationRun {
    const run = this.getRun(id);
    if (!run) throw new VerificationStoreConflictError(`unknown verification run ${id}`);
    return run;
  }
  private assertBinding(run: StoredVerificationRun, input: { sessionId: string; executionRequestId: string; planRevisionId: string }): void {
    if (run.sessionId !== input.sessionId || run.executionRequestId !== input.executionRequestId || run.planRevisionId !== input.planRevisionId) {
      throw new VerificationStoreConflictError(`verification run ${run.id} binding mismatch`);
    }
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNonBlank(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new VerificationStoreConflictError(`${label} must not be blank`);
  }
}

interface RevisionRow { id:string; session_id:string; execution_request_id:string; revision:number; supersedes_revision_id:string|null; plan_fingerprint:string; plan:string; reason:StoredVerificationRevision["reason"]; created_at:string }
function toRevision(row: RevisionRow): StoredVerificationRevision { return { id:row.id, sessionId:row.session_id, executionRequestId:row.execution_request_id, revision:row.revision, ...(row.supersedes_revision_id !== null ? { supersedesRevisionId:row.supersedes_revision_id } : {}), planFingerprint:row.plan_fingerprint, plan:JSON.parse(row.plan) as VerificationPlan, reason:row.reason, createdAt:row.created_at }; }
interface VerificationRunRow { id:string; session_id:string; execution_request_id:string; plan_revision_id:string; state:VerificationRunState; claim_token:string|null; claimed_at:string|null; evaluation:string|null; artifacts:string|null; interruption_reason:string|null; created_at:string; updated_at:string }
function toRun(row: VerificationRunRow): StoredVerificationRun { return { id:row.id, sessionId:row.session_id, executionRequestId:row.execution_request_id, planRevisionId:row.plan_revision_id, state:row.state, ...(row.claim_token !== null ? { claimToken:row.claim_token } : {}), ...(row.claimed_at !== null ? { claimedAt:row.claimed_at } : {}), ...(row.evaluation !== null ? { evaluation:JSON.parse(row.evaluation) as EvaluationResult } : {}), artifacts:row.artifacts !== null ? JSON.parse(row.artifacts) as ExecutionArtifact[] : [], ...(row.interruption_reason !== null ? { interruptionReason:row.interruption_reason } : {}), createdAt:row.created_at, updatedAt:row.updated_at }; }
