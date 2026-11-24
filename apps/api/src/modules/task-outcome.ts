/**
 * The two task-detail facts the MCP `get_task` tool needs and the narrow `tasks.read` credential
 * could not reach before API 2.17: how many approvals wait on the owner, and how the latest
 * verification of the latest Harness session stands. Read-only; derived from the plane's own rows
 * at read time, nothing stored. Approvals stay Web-only: this is a count, never the approval.
 */
import type { Db } from "../db/index.js";
import { LEGACY_AWAITING_APPROVAL_SQL } from "./task-stage.js";

export type VerificationCheckCounts = { passed: number; failed: number; skipped: number; blocked: number };

export interface TaskVerificationSummary {
  /** The Harness session whose verification this is (the task's latest Harness session). */
  sessionId: string;
  verificationRunId: string;
  runState: "ready" | "claimed" | "completed" | "interrupted";
  /** The plane's stored verdict; null until the run completes. Never recomputed from the counts. */
  passed: boolean | null;
  /** Per-check labels as the Web reads them (`status`, else `passed`); all zero until completed. */
  checks: VerificationCheckCounts;
}

/**
 * Pending approvals across the task's runs: Harness `approvals` rows still `pending` (settling a
 * session expires them), plus one for each live legacy run whose newest event is
 * `approval.requested` (a legacy run keeps no approval row; same rule as the task stage).
 */
export function pendingApprovalCount(db: Db, taskId: string): number {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM approvals a JOIN runs r ON r.id = a.session_id
           WHERE r.task_id = ? AND a.state = 'pending')
       + (SELECT COUNT(*) FROM runs WHERE runs.task_id = ? AND ${LEGACY_AWAITING_APPROVAL_SQL}) AS n`,
    )
    .get(taskId, taskId) as { n: number };
  return row.n;
}

/** The latest verification run of the task's latest Harness session, or null when there is none. */
export function latestVerification(db: Db, taskId: string): TaskVerificationSummary | null {
  const row = db
    .prepare(
      `SELECT vr.id, vr.session_id, vr.state, vr.evaluation
         FROM verification_runs vr
         JOIN verification_plan_revisions p ON p.id = vr.plan_revision_id
        WHERE vr.session_id = (
          SELECT r.id FROM runs r
           WHERE r.task_id = ? AND r.execution_request_id IS NOT NULL
           ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1)
        ORDER BY p.revision DESC, vr.created_at DESC, vr.id DESC
        LIMIT 1`,
    )
    .get(taskId) as { id: string; session_id: string; state: TaskVerificationSummary["runState"]; evaluation: string | null } | undefined;
  if (!row) return null;
  const checks: VerificationCheckCounts = { passed: 0, failed: 0, skipped: 0, blocked: 0 };
  let passed: boolean | null = null;
  if (row.state === "completed" && row.evaluation !== null) {
    const evaluation = safeEvaluation(row.evaluation);
    if (evaluation) {
      passed = evaluation.passed;
      for (const c of evaluation.checks) checks[c.status ?? (c.passed ? "passed" : "failed")] += 1;
    }
  }
  return { sessionId: row.session_id, verificationRunId: row.id, runState: row.state, passed, checks };
}

type StoredCheck = { status?: keyof VerificationCheckCounts; passed?: boolean };

/** A stored evaluation this read can count, or null; a malformed row never fails the task read. */
function safeEvaluation(raw: string): { passed: boolean; checks: StoredCheck[] } | null {
  try {
    const v = JSON.parse(raw) as { passed?: unknown; checks?: unknown };
    if (typeof v.passed !== "boolean" || !Array.isArray(v.checks)) return null;
    const statuses = new Set(["passed", "failed", "skipped", "blocked"]);
    const checks = (v.checks as Array<Record<string, unknown>>).filter(
      (c) => c && typeof c === "object" && (statuses.has(c.status as string) || (c.status === undefined && typeof c.passed === "boolean")),
    ) as StoredCheck[];
    if (checks.length !== v.checks.length) return null;
    return { passed: v.passed, checks };
  } catch {
    return null;
  }
}
