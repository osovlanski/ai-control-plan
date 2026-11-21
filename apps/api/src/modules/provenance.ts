/**
 * tlm-02a: cross-record task provenance, read-only.
 *
 * A task's history is spread over records that each name only their neighbours: `runs`,
 * `execution_requests` (Harness only), `dispatches` (scheduler only), `routing_decisions`,
 * `checkpoints`, `handoffs` (every path) and `handoff_envelopes` (Harness only). The existing
 * reads serve each record alone. This read makes the joins between them once, on the plane, so
 * no client recomputes them, and says for every join where it came from:
 *
 * - `execution_request`, `dispatch`, `handoff_record`, `handoff_envelope`, `checkpoint`: the join
 *   is a stored foreign key.
 * - `inferred`: no stored key exists (the legacy path never stamps one), so the join follows a
 *   fixed, stated rule. A client may show it, but must label it as inferred.
 * - `unrecorded`: neither a key nor the rule finds one. An honest unknown, never back-filled.
 *
 * Nothing here writes, and every earlier response keeps its shape.
 */
import type { Db } from "../db/index.js";

export type JoinSource =
  | "execution_request"
  | "dispatch"
  | "handoff_record"
  | "handoff_envelope"
  | "checkpoint"
  | "inferred"
  | "unrecorded";

/** The stated rules an `inferred` join follows. */
export const INFERENCE_RULES = {
  routingDecision:
    "latest routing decision for the task that chose the run's assistant, made at or before the run started, and not already bound to another run",
  predecessor: "the run of the task that started most recently before this one",
} as const;

export interface RoutingDecisionRef {
  id: number | null;
  source: JoinSource;
  chosenAssistantId: string | null;
  at: string | null;
}

export interface RunLaunch {
  /** `scheduler`: a dispatch started it. `handoff`: it closes a handoff record. `parallel`: one compare/race candidate. `operator`: a direct start. */
  kind: "scheduler" | "handoff" | "parallel" | "operator";
  dispatch: { id: string; origin: string; phase: string; generation: number } | null;
  handoffTrigger: string | null;
}

export interface Continuation {
  runId: string | null;
  assistantId: string | null;
  source: JoinSource;
  checkpointId: string | null;
  handoffId: string | null;
  envelopeId: string | null;
}

export interface RunProvenance {
  runId: string;
  assistantId: string;
  executionPath: "harness" | "legacy";
  executionRequestId: string | null;
  attempt: number | null;
  startedAt: string;
  endedAt: string | null;
  settlementOwner: string | null;
  compositionRevisionId: string | null;
  promptSource: "fresh" | "handoff" | "resume" | null;
  launch: RunLaunch;
  routingDecision: RoutingDecisionRef;
  /** The run this one continues, or null for a fresh start. */
  continuedFrom: Continuation | null;
}

export interface HandoffProvenance {
  /** `handoffs.id`, or the envelope id for a Harness envelope no handoff record names. */
  id: string;
  record: "handoff" | "envelope_only";
  trigger: string | null;
  at: string;
  checkpointId: string | null;
  from: { runId: string | null; assistantId: string | null; source: JoinSource };
  to: { runId: string | null; assistantId: string | null };
  /** False while the successor has not started (a parked or refused continuation). */
  closed: boolean;
  envelope: { id: string; state: string; claimedByRequestId: string | null } | null;
  successorRoutingDecisionId: number | null;
}

export interface TaskProvenance {
  taskId: string;
  owner:
    | { kind: "operator"; runAs: string | null }
    | { kind: "autopilot"; runAs: string | null; attemptId: string; itemId: string; attemptNo: number; state: string };
  mode: string;
  runs: RunProvenance[];
  handoffs: HandoffProvenance[];
  inferenceRules: typeof INFERENCE_RULES;
}

interface RunRow {
  id: string; assistant_id: string; started_at: string; ended_at: string | null;
  execution_request_id: string | null; attempt: number | null; settlement_owner: string | null;
  composition_revision_id: string | null; dispatch_id: string | null; worktree_path: string | null;
  req_routing: string | null; req_prompt_source: string | null; req_prompt_source_ref: string | null;
  req_origin_envelope: string | null; req_attempt: number | null;
  d_origin: string | null; d_phase: string | null; d_generation: number | null;
  d_routing: number | null; d_checkpoint: string | null;
}
interface HandoffRow { id: string; from_run_id: string | null; to_run_id: string | null; checkpoint_id: string | null; trigger: string; at: string }
interface EnvelopeRow { id: string; checkpoint_id: string; state: string; claimed_by_request_id: string | null; source_session_id: string | null; created_at: string; from_assistant_id: string }
interface DecisionRow { id: number; chosen_assistant_id: string | null; at: string }
interface CheckpointRow { id: string; run_id: string | null; session_id: string | null }

const tableExists = (db: Db, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Undefined when the task does not exist. */
export function taskProvenance(db: Db, taskId: string): TaskProvenance | undefined {
  const task = db.prepare("SELECT id, mode, run_as FROM tasks WHERE id = ?").get(taskId) as
    | { id: string; mode: string | null; run_as: string | null }
    | undefined;
  if (!task) return undefined;

  const runs = db.prepare(
    `SELECT r.id, r.assistant_id, r.started_at, r.ended_at, r.execution_request_id, r.attempt,
            r.settlement_owner, r.composition_revision_id, r.dispatch_id, r.worktree_path,
            er.routing_decision_ref AS req_routing, er.prompt_source AS req_prompt_source,
            er.prompt_source_ref AS req_prompt_source_ref, er.origin_envelope_id AS req_origin_envelope,
            er.attempt AS req_attempt,
            d.origin AS d_origin, d.phase AS d_phase, d.condition_generation AS d_generation,
            d.routing_decision_id AS d_routing, d.checkpoint_id AS d_checkpoint
       FROM runs r
       LEFT JOIN execution_requests er ON er.id = r.execution_request_id
       LEFT JOIN dispatches d ON d.dispatch_id = r.dispatch_id
      WHERE r.task_id = ?
      ORDER BY r.started_at, r.rowid`,
  ).all(taskId) as RunRow[];
  const handoffs = db.prepare(
    "SELECT id, from_run_id, to_run_id, checkpoint_id, trigger, at FROM handoffs WHERE task_id = ? ORDER BY at, rowid",
  ).all(taskId) as HandoffRow[];
  const envelopes = db.prepare(
    `SELECT id, checkpoint_id, state, claimed_by_request_id, source_session_id, created_at, from_assistant_id
       FROM handoff_envelopes WHERE task_id = ? ORDER BY created_at, rowid`,
  ).all(taskId) as EnvelopeRow[];
  const decisions = db.prepare(
    "SELECT id, chosen_assistant_id, at FROM routing_decisions WHERE task_id = ? ORDER BY id",
  ).all(taskId) as DecisionRow[];
  const checkpoints = new Map(
    (db.prepare("SELECT id, run_id, session_id FROM checkpoints WHERE task_id = ?").all(taskId) as CheckpointRow[])
      .map((c) => [c.id, c]),
  );

  const runById = new Map(runs.map((r) => [r.id, r]));
  const runByRequest = new Map(runs.filter((r) => r.execution_request_id).map((r) => [r.execution_request_id!, r]));
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const assistantOf = (runId: string | null) => (runId ? runById.get(runId)?.assistant_id ?? null : null);
  const checkpointRun = (checkpointId: string | null) => {
    const c = checkpointId ? checkpoints.get(checkpointId) : undefined;
    return c?.run_id ?? c?.session_id ?? null;
  };
  const previousRun = (index: number) => (index > 0 ? runs[index - 1]!.id : null);

  // ---- Routing: exact keys first, so the inference never takes a decision a key already binds.
  const exactDecision = (r: RunRow): { id: number; source: JoinSource } | undefined => {
    const fromRequest = r.req_routing != null && /^\d+$/.test(r.req_routing) ? Number(r.req_routing) : undefined;
    if (fromRequest !== undefined && decisionById.has(fromRequest)) return { id: fromRequest, source: "execution_request" };
    if (r.d_routing != null && decisionById.has(r.d_routing)) return { id: r.d_routing, source: "dispatch" };
    return undefined;
  };
  const bound = new Set<number>();
  for (const r of runs) { const exact = exactDecision(r); if (exact) bound.add(exact.id); }
  const routingOf = new Map<string, RoutingDecisionRef>();
  for (const r of runs) {
    let pick = exactDecision(r);
    if (!pick) {
      const candidate = [...decisions].reverse().find((d) =>
        !bound.has(d.id) && d.chosen_assistant_id === r.assistant_id && d.at <= r.started_at);
      if (candidate) { bound.add(candidate.id); pick = { id: candidate.id, source: "inferred" }; }
    }
    const d = pick ? decisionById.get(pick.id) : undefined;
    routingOf.set(r.id, d && pick
      ? { id: d.id, source: pick.source, chosenAssistantId: d.chosen_assistant_id, at: d.at }
      : { id: null, source: "unrecorded", chosenAssistantId: null, at: null });
  }

  // ---- Handoffs: every `handoffs` row, joined to the envelope of its checkpoint when one exists,
  // then any Harness envelope no record names (a context continuation records none).
  const envelopeByCheckpoint = new Map<string, EnvelopeRow>();
  for (const e of envelopes) {
    // The claimed envelope is the one that matters for a successor; otherwise the latest.
    const prior = envelopeByCheckpoint.get(e.checkpoint_id);
    if (!prior || e.claimed_by_request_id || !prior.claimed_by_request_id) envelopeByCheckpoint.set(e.checkpoint_id, e);
  }
  const handoffByToRun = new Map<string, HandoffRow>();
  for (const h of handoffs) if (h.to_run_id) handoffByToRun.set(h.to_run_id, h);

  const fromOf = (stored: string | null, checkpointId: string | null, envelope: EnvelopeRow | undefined, toRunId: string | null, at: string) => {
    if (stored) return { runId: stored, source: "handoff_record" as JoinSource };
    if (envelope?.source_session_id) return { runId: envelope.source_session_id, source: "handoff_envelope" as JoinSource };
    const viaCheckpoint = checkpointRun(checkpointId);
    if (viaCheckpoint) return { runId: viaCheckpoint, source: "checkpoint" as JoinSource };
    // A manual handoff checkpoints without a run id. The predecessor is then the last run that
    // started before the successor (or, with no successor yet, before the record).
    const before = toRunId ? runById.get(toRunId)?.started_at ?? at : at;
    const prior = [...runs].reverse().find((r) => r.id !== toRunId && r.started_at <= before);
    return prior ? { runId: prior.id, source: "inferred" as JoinSource } : { runId: null, source: "unrecorded" as JoinSource };
  };

  const handoffProvenance: HandoffProvenance[] = handoffs.map((h) => {
    const envelope = h.checkpoint_id ? envelopeByCheckpoint.get(h.checkpoint_id) : undefined;
    const from = fromOf(h.from_run_id, h.checkpoint_id, envelope, h.to_run_id, h.at);
    const successor = h.to_run_id ? routingOf.get(h.to_run_id) : undefined;
    return {
      id: h.id,
      record: "handoff",
      trigger: h.trigger,
      at: h.at,
      checkpointId: h.checkpoint_id,
      from: { ...from, assistantId: assistantOf(from.runId) ?? (from.source === "handoff_envelope" ? envelope?.from_assistant_id ?? null : null) },
      to: { runId: h.to_run_id, assistantId: assistantOf(h.to_run_id) },
      closed: h.to_run_id != null,
      envelope: envelope ? { id: envelope.id, state: envelope.state, claimedByRequestId: envelope.claimed_by_request_id } : null,
      successorRoutingDecisionId: successor?.id ?? null,
    };
  });
  const recordedCheckpoints = new Set(handoffs.map((h) => h.checkpoint_id).filter(Boolean));
  for (const e of envelopes) {
    if (recordedCheckpoints.has(e.checkpoint_id)) continue;
    const toRun = e.claimed_by_request_id ? runByRequest.get(e.claimed_by_request_id) ?? null : null;
    const from = fromOf(null, e.checkpoint_id, e, toRun?.id ?? null, e.created_at);
    handoffProvenance.push({
      id: e.id,
      record: "envelope_only",
      trigger: null,
      at: e.created_at,
      checkpointId: e.checkpoint_id,
      from: { ...from, assistantId: assistantOf(from.runId) ?? e.from_assistant_id },
      to: { runId: toRun?.id ?? null, assistantId: toRun?.assistant_id ?? null },
      closed: toRun != null,
      envelope: { id: e.id, state: e.state, claimedByRequestId: e.claimed_by_request_id },
      successorRoutingDecisionId: toRun ? routingOf.get(toRun.id)?.id ?? null : null,
    });
  }
  handoffProvenance.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const handoffById = new Map(handoffProvenance.map((h) => [h.id, h]));

  // ---- Runs.
  const parallel = task.mode === "compare" || task.mode === "race";
  const runProvenance: RunProvenance[] = runs.map((r, index) => {
    const record = handoffByToRun.get(r.id);
    const envelope = r.req_origin_envelope ? envelopes.find((e) => e.id === r.req_origin_envelope) : undefined;
    let continuedFrom: Continuation | null = null;
    if (record) {
      const h = handoffById.get(record.id)!;
      continuedFrom = { runId: h.from.runId, assistantId: h.from.assistantId, source: h.from.source, checkpointId: record.checkpoint_id, handoffId: record.id, envelopeId: h.envelope?.id ?? null };
    } else if (envelope) {
      const from = fromOf(null, envelope.checkpoint_id, envelope, r.id, r.started_at);
      continuedFrom = { runId: from.runId, assistantId: assistantOf(from.runId) ?? envelope.from_assistant_id, source: from.source, checkpointId: envelope.checkpoint_id, handoffId: null, envelopeId: envelope.id };
    } else if (r.d_checkpoint || r.req_prompt_source === "resume") {
      // A scheduler wake that resumes from a checkpoint without a handoff record.
      const checkpointId = r.d_checkpoint ?? r.req_prompt_source_ref ?? null;
      const viaCheckpoint = checkpointRun(checkpointId);
      const runId = viaCheckpoint ?? previousRun(index);
      continuedFrom = { runId, assistantId: assistantOf(runId), source: viaCheckpoint ? "checkpoint" : runId ? "inferred" : "unrecorded", checkpointId, handoffId: null, envelopeId: null };
    }
    const launch: RunLaunch = {
      kind: r.dispatch_id && r.d_origin ? "scheduler" : record ? "handoff" : parallel && r.worktree_path ? "parallel" : "operator",
      dispatch: r.dispatch_id && r.d_origin
        ? { id: r.dispatch_id, origin: r.d_origin, phase: r.d_phase!, generation: r.d_generation! }
        : null,
      handoffTrigger: record?.trigger ?? null,
    };
    const promptSource = r.req_prompt_source === "fresh" || r.req_prompt_source === "handoff" || r.req_prompt_source === "resume"
      ? r.req_prompt_source : null;
    return {
      runId: r.id,
      assistantId: r.assistant_id,
      executionPath: r.execution_request_id ? "harness" : "legacy",
      executionRequestId: r.execution_request_id,
      attempt: r.req_attempt ?? (r.execution_request_id ? r.attempt : null),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      settlementOwner: r.settlement_owner,
      compositionRevisionId: r.composition_revision_id,
      promptSource,
      launch,
      routingDecision: routingOf.get(r.id)!,
      continuedFrom,
    };
  });

  const attempt = tableExists(db, "autopilot_attempts")
    ? db.prepare("SELECT id, item_id, attempt_no, state FROM autopilot_attempts WHERE task_id = ?").get(taskId) as
      | { id: string; item_id: string; attempt_no: number; state: string }
      | undefined
    : undefined;

  return {
    taskId,
    owner: attempt
      ? { kind: "autopilot", runAs: task.run_as, attemptId: attempt.id, itemId: attempt.item_id, attemptNo: attempt.attempt_no, state: attempt.state }
      : { kind: "operator", runAs: task.run_as },
    mode: task.mode ?? "single",
    runs: runProvenance,
    handoffs: handoffProvenance,
    inferenceRules: INFERENCE_RULES,
  };
}
