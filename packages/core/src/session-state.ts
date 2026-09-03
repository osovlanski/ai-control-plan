/**
 * Execution-session state machine (execution-harness §5).
 *
 * This is RUN-LEVEL only. The 9-state task machine (`state-machine.ts`) stays
 * authoritative and Control-Plane-only (H-I2). The session machine REPLACES the
 * old thin `RUN_STATES` enum on the `runs` table; the legacy vocabulary is kept
 * only as a read/write mapping during the migration window.
 *
 * Same `assertTransition` / `InvalidTransitionError` style as the task machine.
 * Every transition names its trigger so recovery and audit can explain it.
 */

export const EXECUTION_SESSION_STATES = [
  "PREPARED",
  "STARTING",
  "RUNNING",
  "AWAITING_APPROVAL",
  "PAUSED",
  "RESUMING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "YIELDED",
] as const;

export type ExecutionSessionState = (typeof EXECUTION_SESSION_STATES)[number];

/** Terminal states — every session ends in exactly one of these (H-I3). */
export const SESSION_TERMINAL_STATES = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "YIELDED",
] as const satisfies readonly ExecutionSessionState[];

/** The subset of states a session can actually end in — for `ExecutionResult.terminalState`. */
export type TerminalSessionState = (typeof SESSION_TERMINAL_STATES)[number];

/**
 * Legal transitions keyed by source state. The only edge into COMPLETED is from
 * VERIFYING, and VERIFYING has exactly ONE exit: COMPLETED (§5 — "VERIFYING
 * always exits to COMPLETED"). A zero-spec verification is an instantaneous
 * pass-through. Verification never rewrites the execution outcome: failed checks
 * ride on `ExecutionResult.verification` and the task verdict is the Control
 * Plane's (H-I6). A cancel or hard timeout that arrives during the (short,
 * budget-bounded) verify stage is honored by the finalizer via the durable
 * `cancelRequested` flag and the absolute deadline, using explicit terminal
 * edges so the durable session outcome remains truthful.
 */
const SESSION_TRANSITIONS: Record<ExecutionSessionState, readonly ExecutionSessionState[]> = {
  // Prepare persisted the row; Context/authority failures fail it before any adapter call.
  PREPARED: ["STARTING", "FAILED", "CANCELLED"],
  // Start intent is durable; the adapter start may fail or be cancelled before the stream begins.
  STARTING: ["RUNNING", "FAILED", "CANCELLED", "TIMED_OUT"],
  RUNNING: ["AWAITING_APPROVAL", "PAUSED", "VERIFYING", "FAILED", "CANCELLED", "TIMED_OUT", "YIELDED"],
  // Budget/idle clocks paused; provider session held on a durable pending row (§4).
  AWAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "TIMED_OUT", "YIELDED"],
  // Explicit user/plane hold.
  PAUSED: ["RESUMING", "FAILED", "CANCELLED"],
  RESUMING: ["RUNNING", "FAILED", "CANCELLED", "TIMED_OUT"],
  VERIFYING: ["COMPLETED", "CANCELLED", "TIMED_OUT"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  YIELDED: [],
};

/**
 * Human-readable trigger for each legal transition. Keyed `FROM->TO`. Used by the
 * SessionRunner when it writes the transition audit event; also lets tests assert
 * that no legal edge is missing a documented reason.
 */
export const SESSION_TRANSITION_TRIGGERS: Record<string, string> = {
  "PREPARED->STARTING": "start_intent",
  "PREPARED->FAILED": "prepare_or_context_failure",
  "PREPARED->CANCELLED": "cancel_before_start",
  "STARTING->RUNNING": "provider_stream_began",
  "STARTING->FAILED": "adapter_start_failed",
  "STARTING->CANCELLED": "cancel_during_start",
  "STARTING->TIMED_OUT": "hard_timeout_during_start",
  "RUNNING->AWAITING_APPROVAL": "approval_requested",
  "RUNNING->PAUSED": "user_or_plane_pause",
  "RUNNING->VERIFYING": "provider_stream_ended",
  "RUNNING->FAILED": "provider_fault_or_guard_cancel",
  "RUNNING->CANCELLED": "cancel_requested",
  "RUNNING->TIMED_OUT": "hard_or_idle_timeout",
  "RUNNING->YIELDED": "reroute_handoff_or_limit_yield",
  "AWAITING_APPROVAL->RUNNING": "approval_delivered",
  "AWAITING_APPROVAL->FAILED": "guard_cancel_while_awaiting",
  "AWAITING_APPROVAL->CANCELLED": "approval_expired_or_cancel",
  "AWAITING_APPROVAL->TIMED_OUT": "hard_timeout_while_awaiting",
  "AWAITING_APPROVAL->YIELDED": "limit_yield_while_awaiting",
  "PAUSED->RESUMING": "resume_requested",
  "PAUSED->FAILED": "resume_impossible",
  "PAUSED->CANCELLED": "cancel_while_paused",
  "RESUMING->RUNNING": "resume_succeeded",
  "RESUMING->FAILED": "resume_failed",
  "RESUMING->CANCELLED": "cancel_during_resume",
  "RESUMING->TIMED_OUT": "hard_timeout_during_resume",
  "VERIFYING->COMPLETED": "verification_stage_done",
  "VERIFYING->CANCELLED": "cancel_during_verification",
  "VERIFYING->TIMED_OUT": "hard_timeout_during_verification",
};

export function isExecutionSessionState(value: string): value is ExecutionSessionState {
  return (EXECUTION_SESSION_STATES as readonly string[]).includes(value);
}

export function isSessionTerminal(state: ExecutionSessionState): state is TerminalSessionState {
  return (SESSION_TERMINAL_STATES as readonly ExecutionSessionState[]).includes(state);
}

export function canSessionTransition(from: ExecutionSessionState, to: ExecutionSessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export class InvalidSessionTransitionError extends Error {
  constructor(
    readonly from: ExecutionSessionState,
    readonly to: ExecutionSessionState,
  ) {
    super(`Invalid execution-session state transition: ${from} -> ${to}`);
    this.name = "InvalidSessionTransitionError";
  }
}

/** Returns `to` if the transition is legal, otherwise throws. */
export function assertSessionTransition(
  from: ExecutionSessionState,
  to: ExecutionSessionState,
): ExecutionSessionState {
  if (!canSessionTransition(from, to)) throw new InvalidSessionTransitionError(from, to);
  return to;
}

/**
 * Fixed derivation of `ExecutionResult.outcome` from the terminal session state
 * (execution-harness §2). Non-terminal states have no outcome.
 */
export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "timed_out" | "yielded";

const OUTCOME_BY_TERMINAL: Record<string, ExecutionOutcome> = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
  YIELDED: "yielded",
};

export function outcomeOf(state: ExecutionSessionState): ExecutionOutcome {
  const outcome = OUTCOME_BY_TERMINAL[state];
  if (!outcome) throw new Error(`No outcome for non-terminal session state ${state}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Legacy RUN_STATES migration mapping (execution-harness §5)
// ---------------------------------------------------------------------------

/** Old `runs.state` vocabulary → new session state (forward migration). */
export const RUN_STATE_TO_SESSION_STATE: Record<string, ExecutionSessionState> = {
  STARTING: "STARTING",
  ACTIVE: "RUNNING",
  ENDED_OK: "COMPLETED",
  ENDED_ERROR: "FAILED",
  CANCELLED: "CANCELLED",
};

/**
 * New session state → legacy `runs.state` (the read mapping served on the
 * dual-field window so existing API/UI keep working until the frontend flips to
 * `sessionState`). Live intermediate states collapse to ACTIVE; a session that
 * yielded did not complete, so it reads as ENDED_ERROR in the old vocabulary.
 */
export const SESSION_STATE_TO_RUN_STATE: Record<ExecutionSessionState, string> = {
  PREPARED: "STARTING",
  STARTING: "STARTING",
  RUNNING: "ACTIVE",
  AWAITING_APPROVAL: "ACTIVE",
  PAUSED: "ACTIVE",
  RESUMING: "ACTIVE",
  VERIFYING: "ACTIVE",
  COMPLETED: "ENDED_OK",
  FAILED: "ENDED_ERROR",
  CANCELLED: "CANCELLED",
  TIMED_OUT: "ENDED_ERROR",
  YIELDED: "ENDED_ERROR",
};
