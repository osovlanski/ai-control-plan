/**
 * K11 — the Control Plane's continuation decision (kernel-services §4.3.3).
 *
 * The Harness observes, checkpoints and settles `YIELDED(context)`. Everything
 * here is the plane's half: is the evidence adequate, is the task still within
 * its bounds, and what provenance does the successor's routing decision carry.
 *
 * Everything is DERIVED from rows that already exist — `dispatches` (one row per
 * continuation attempt, `origin = 'context-yield'`), `checkpoints` (the anchor
 * and its immutable envelope snapshot), `runs` and `handoff_envelopes`. There is
 * no continuation-history table, so the bounds survive a process restart for
 * free and cannot drift from the dispatch log they are computed from.
 */
import type {
  ContextPolicy,
  ContextYieldRequest,
  ExecutionResult,
  HandoffEnvelope,
  PauseKind,
  TaskEnvelope,
} from "@agent-plane/core";
import { DEFAULT_CONTEXT_POLICY } from "@agent-plane/core";
import type { Db } from "../db/index.js";

/** Why the plane refused to start a successor. Each maps 1:1 to a `pause_kind`. */
export type ContinuationBlock = Extract<
  PauseKind,
  | "continuation_evidence_missing"
  | "continuation_limit_reached"
  | "continuation_no_progress"
  | "successor_immediately_critical"
>;

export interface ContinuationDecision {
  /** True only when a successor may be dispatched from `checkpointId`. */
  allowed: boolean;
  block?: ContinuationBlock;
  /** Operator-facing explanation; always truthful, never a generic message. */
  reason: string;
  /** The anchor the successor must start from. Present iff `allowed`. */
  checkpointId?: string;
  /** 1-based number this successor would be, for the task. */
  continuationNumber: number;
  /** Continuations already attempted for this task, whatever their outcome. */
  attemptsSoFar: number;
  /** Consecutive prior continuations that produced no envelope progress. */
  noProgressStreak: number;
}

/** Provenance of one context continuation — extends the dispatch/routing record. */
export interface ContinuationProvenance {
  continuationNumber: number;
  maxContinuationsPerTask: number;
  checkpointId: string;
  predecessorSessionId?: string;
  previousAssistantId?: string;
  previousModelRequested?: string;
  previousModelResolved?: string;
  reason: string;
  criticalPressure?: number;
  observedAt?: string;
}

interface CheckpointEnvelopeRow {
  id: string;
  envelope_snapshot: string;
  session_id: string | null;
  git_ref: string | null;
}

/**
 * Continuations ALREADY ATTEMPTED for this task, counted from the durable
 * dispatch log. Every phase counts — a reparked or aborted continuation still
 * consumed an attempt, which is the whole point of a loop bound (§4.3.3 item 6).
 */
export function continuationAttempts(db: Db, taskId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM dispatches WHERE task_id = ? AND origin = 'context-yield'")
    .get(taskId) as { n: number };
  return row.n;
}

/** The context-yield anchor checkpoints for a task, oldest first. */
function contextCheckpoints(db: Db, taskId: string): CheckpointEnvelopeRow[] {
  return db
    .prepare(
      `SELECT id, envelope_snapshot, session_id, git_ref FROM checkpoints
       WHERE task_id = ? AND reason = 'context' ORDER BY at, rowid`,
    )
    .all(taskId) as CheckpointEnvelopeRow[];
}

function snapshot(row: CheckpointEnvelopeRow): TaskEnvelope | undefined {
  try {
    return JSON.parse(row.envelope_snapshot) as TaskEnvelope;
  } catch {
    return undefined;
  }
}

/**
 * Progress between two successive continuation checkpoints, defined ONLY as a
 * durable change in the continuation evidence a successor actually reads:
 * `completed` or `remaining`. More tokens, more events, more elapsed time and a
 * reworded summary are explicitly NOT progress (§11) — an agent that burns a
 * whole context window restating itself must not buy another one.
 */
export function envelopeProgressed(before: TaskEnvelope, after: TaskEnvelope): boolean {
  return (
    !sameList(before.completed, after.completed) || !sameList(before.remaining, after.remaining)
  );
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Trailing run of consecutive continuations that changed nothing durable. */
export function noProgressStreak(db: Db, taskId: string): number {
  const snaps = contextCheckpoints(db, taskId)
    .map(snapshot)
    .filter((e): e is TaskEnvelope => e !== undefined);
  let streak = 0;
  for (let i = snaps.length - 1; i > 0; i -= 1) {
    if (envelopeProgressed(snaps[i - 1]!, snaps[i]!)) break;
    streak += 1;
  }
  return streak;
}

/**
 * Was the session that just yielded ITSELF a context continuation whose FIRST
 * fresh observation was already critical? That is the §4.3.3 safety stop: the
 * clean window did not help, so another automatic continuation would just burn
 * a third session. It overrides any remaining continuation budget.
 */
function successorImmediatelyCritical(db: Db, detail: ContextYieldRequest): boolean {
  if (detail.observation.sequence !== 1) return false;
  const row = db
    .prepare("SELECT origin FROM dispatches WHERE session_id = ?")
    .get(detail.sessionId) as { origin: string } | undefined;
  return row?.origin === "context-yield";
}

/**
 * Continuation evidence adequacy (§4.3.3 item 2): a committed Git ref AND a
 * committed envelope AND a meaningful next action. An envelope-only checkpoint
 * left behind by a Git failure is explicitly INADEQUATE — continuing from a
 * summary with no committed tree would hand the successor a description of work
 * it cannot see.
 */
function evidence(
  db: Db,
  detail: ContextYieldRequest,
  result: ExecutionResult,
): { ok: true; envelope: HandoffEnvelope } | { ok: false; reason: string } {
  const checkpointId = detail.checkpointId ?? result.checkpoint.checkpointId;
  if (!checkpointId) return { ok: false, reason: "no checkpoint was taken at the context yield" };
  if (!result.checkpoint.committed || !result.checkpoint.gitRef) {
    return { ok: false, reason: "the checkpoint has no committed Git ref (envelope-only checkpoint)" };
  }
  const row = db
    .prepare("SELECT envelope FROM handoff_envelopes WHERE checkpoint_id = ? ORDER BY created_at LIMIT 1")
    .get(checkpointId) as { envelope: string } | undefined;
  if (!row) return { ok: false, reason: "no continuation envelope was committed for the checkpoint" };
  let envelope: HandoffEnvelope;
  try {
    envelope = JSON.parse(row.envelope) as HandoffEnvelope;
  } catch {
    return { ok: false, reason: "the continuation envelope is unreadable" };
  }
  if (!envelope.currentSubtask?.trim()) {
    return { ok: false, reason: "the continuation envelope carries no meaningful next action" };
  }
  return { ok: true, envelope };
}

/**
 * The whole K11 gate, in the order the invariants demand: evidence first (an
 * inadequate checkpoint can never start a successor whatever the budget says),
 * then the immediately-critical safety stop, then the task-level bounds.
 */
export function decideContextContinuation(
  db: Db,
  detail: ContextYieldRequest,
  result: ExecutionResult,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): ContinuationDecision {
  const attemptsSoFar = continuationAttempts(db, detail.taskId);
  const streak = noProgressStreak(db, detail.taskId);
  const base = {
    continuationNumber: attemptsSoFar + 1,
    attemptsSoFar,
    noProgressStreak: streak,
  };

  const found = evidence(db, detail, result);
  if (!found.ok) {
    return { ...base, allowed: false, block: "continuation_evidence_missing", reason: found.reason };
  }

  if (successorImmediatelyCritical(db, detail)) {
    return {
      ...base,
      allowed: false,
      block: "successor_immediately_critical",
      reason:
        "the clean successor's first fresh observation was already critical — a further continuation would not help",
    };
  }

  if (attemptsSoFar >= policy.maxContinuationsPerTask) {
    return {
      ...base,
      allowed: false,
      block: "continuation_limit_reached",
      reason: `continuation ${base.continuationNumber} exceeds maxContinuationsPerTask (${policy.maxContinuationsPerTask})`,
    };
  }

  if (streak >= policy.noProgressContinuationLimit) {
    return {
      ...base,
      allowed: false,
      block: "continuation_no_progress",
      reason: `${streak} consecutive continuations changed no completed/remaining work`,
    };
  }

  return {
    ...base,
    allowed: true,
    checkpointId: found.envelope.checkpointId,
    reason: `context continuation ${base.continuationNumber} of ${policy.maxContinuationsPerTask}`,
  };
}

/**
 * Provenance for a context-yield dispatch, read back from the checkpoint anchor.
 * Used by `routeTask` (to prefer the same assistant and to record why) and by
 * `GET /api/tasks/:id/context` (to render the continuation truthfully).
 */
export function continuationProvenance(
  db: Db,
  taskId: string,
  checkpointId: string,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
): ContinuationProvenance | undefined {
  const cp = db
    .prepare("SELECT id, session_id FROM checkpoints WHERE id = ? AND task_id = ?")
    .get(checkpointId, taskId) as { id: string; session_id: string | null } | undefined;
  if (!cp) return undefined;

  const predecessor = cp.session_id
    ? (db
        .prepare("SELECT assistant_id, model_requested, model_resolved FROM runs WHERE id = ?")
        .get(cp.session_id) as
        | { assistant_id: string; model_requested: string | null; model_resolved: string | null }
        | undefined)
    : undefined;

  const yieldEvent = cp.session_id
    ? (db
        .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'context.yield' ORDER BY seq DESC LIMIT 1")
        .get(cp.session_id) as { payload: string | null } | undefined)
    : undefined;
  let pressure: number | undefined;
  let observedAt: string | undefined;
  if (yieldEvent?.payload) {
    try {
      const parsed = JSON.parse(yieldEvent.payload) as {
        observation?: { pressure?: number; observedAt?: string };
      };
      pressure = parsed.observation?.pressure;
      observedAt = parsed.observation?.observedAt;
    } catch {
      // An unreadable payload loses the pressure detail, never the provenance.
    }
  }

  // This checkpoint's own continuation is the one being routed, so it is the
  // count of attempts up to and including it.
  const ordinal =
    contextCheckpoints(db, taskId).findIndex((row) => row.id === checkpointId) + 1 || 1;

  return {
    continuationNumber: ordinal,
    maxContinuationsPerTask: policy.maxContinuationsPerTask,
    checkpointId,
    predecessorSessionId: cp.session_id ?? undefined,
    previousAssistantId: predecessor?.assistant_id,
    previousModelRequested: predecessor?.model_requested ?? undefined,
    previousModelResolved: predecessor?.model_resolved ?? undefined,
    reason: "critical context pressure",
    criticalPressure: pressure,
    observedAt,
  };
}
