/**
 * Per-scenario scorer (increment 3, plan §4 step 20).
 *
 * Reads durable state the same way the rest of the system does — the
 * execution-path discriminator (`executionRequestId`), the effective usage
 * derivation, and the verification lifecycle tables — never from adapter
 * self-reporting.
 */
import type { Db } from "../apps/api/src/db/index.js";
import { effectiveUsageJoin, effectiveUsageSql } from "../apps/api/src/modules/harness/state-vocab.js";

export interface ScenarioScore {
  scenario: string;
  kind: "real" | "fake";
  provider?: string;
  taskId: string;
  sessionId: string | null;
  executionRequestId: string | null;
  reachedTerminal: boolean;
  terminalState: string | null;
  verificationRan: boolean;
  verificationPassed: boolean | null;
  verificationRunId: string | null;
  verificationPlanRevisions: number;
  durableSessionCount: number;
  checkpointCount: number;
  failoverCount: number;
  wallClockMs: number | null;
  totalTokens: number | null;
  usageAccountingPresent: boolean;
  executionResultsOutcome: string | null;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "WAITING_INPUT"]);

export function scoreTask(
  db: Db,
  opts: { scenario: string; kind: "real" | "fake"; provider?: string; taskId: string },
): ScenarioScore {
  const task = db
    .prepare("SELECT state, created_at, updated_at FROM tasks WHERE id = ?")
    .get(opts.taskId) as { state: string; created_at: string; updated_at: string } | undefined;

  const run = db
    .prepare(
      `SELECT r.id AS session_id, r.execution_request_id, r.started_at, r.ended_at,
              ${effectiveUsageSql("r")} AS usage
         FROM runs r ${effectiveUsageJoin("r")}
        WHERE r.task_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`,
    )
    .get(opts.taskId) as
    | { session_id: string; execution_request_id: string | null; started_at: string; ended_at: string | null; usage: string | null }
    | undefined;

  const verificationRun = run?.session_id
    ? (db
        .prepare("SELECT id, plan_revision_id, evaluation FROM verification_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(run.session_id) as { id: string; plan_revision_id: string; evaluation: string | null } | undefined)
    : undefined;

  const revisionCount = run?.execution_request_id
    ? (db
        .prepare("SELECT COUNT(*) AS n FROM verification_plan_revisions WHERE execution_request_id = ?")
        .get(run.execution_request_id) as { n: number }).n
    : 0;

  const sessionCount = (
    db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL").get(opts.taskId) as {
      n: number;
    }
  ).n;

  const checkpointCount = (
    db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE task_id = ?").get(opts.taskId) as { n: number }
  ).n;

  const failoverCount = (
    db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE task_id = ?").get(opts.taskId) as { n: number }
  ).n;

  const result = run?.session_id
    ? (db.prepare("SELECT outcome FROM execution_results WHERE session_id = ?").get(run.session_id) as
        | { outcome: string }
        | undefined)
    : undefined;

  let verificationPassed: boolean | null = null;
  if (verificationRun?.evaluation) {
    try {
      verificationPassed = (JSON.parse(verificationRun.evaluation) as { passed?: boolean }).passed ?? null;
    } catch {
      verificationPassed = null;
    }
  }

  let totalTokens: number | null = null;
  let usageAccountingPresent = false;
  if (run?.usage) {
    try {
      const usage = JSON.parse(run.usage) as { inputTokens?: number; outputTokens?: number; accounting?: string };
      totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      usageAccountingPresent = !!usage.accounting && usage.accounting !== "none";
    } catch {
      /* leave null */
    }
  }

  const wallClockMs =
    run?.started_at && run.ended_at ? Date.parse(run.ended_at) - Date.parse(run.started_at) : null;

  return {
    scenario: opts.scenario,
    kind: opts.kind,
    provider: opts.provider,
    taskId: opts.taskId,
    sessionId: run?.session_id ?? null,
    executionRequestId: run?.execution_request_id ?? null,
    reachedTerminal: !!task && TERMINAL.has(task.state),
    terminalState: task?.state ?? null,
    verificationRan: !!verificationRun,
    verificationPassed,
    verificationRunId: verificationRun?.id ?? null,
    verificationPlanRevisions: revisionCount,
    durableSessionCount: sessionCount,
    checkpointCount,
    failoverCount,
    wallClockMs,
    totalTokens,
    usageAccountingPresent,
    executionResultsOutcome: result?.outcome ?? null,
  };
}
