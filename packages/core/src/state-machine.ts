/**
 * Authoritative orchestration state machine (revised architecture §5).
 *
 * Orchestration states drive failover/handoff decisions and every transition
 * must have an unambiguous trigger. Activity phases (planning/testing/...)
 * are informational annotations on events and NEVER appear here.
 */

export const TASK_STATES = [
  "CREATED",
  "ROUTING",
  "RUNNING",
  "WAITING_INPUT",
  "LIMIT_PAUSED",
  "HANDING_OFF",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  CREATED: ["ROUTING", "CANCELLED"],
  // ROUTING → WAITING_INPUT: no eligible assistant (all filtered/limited).
  ROUTING: ["RUNNING", "WAITING_INPUT", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAITING_INPUT",
    "LIMIT_PAUSED",
    "HANDING_OFF", // manual handoff requested mid-run
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ],
  // WAITING_INPUT → ROUTING: user asks to re-route (e.g. after quota reset).
  // WAITING_INPUT → HANDING_OFF: user manually moves parked work to another
  // assistant — the recovery path when failover found nowhere to go.
  // WAITING_INPUT → COMPLETED: the user resolves a finished comparison by
  // picking a winner, which completes the task without another run.
  WAITING_INPUT: ["RUNNING", "ROUTING", "HANDING_OFF", "COMPLETED", "FAILED", "CANCELLED"],
  LIMIT_PAUSED: ["HANDING_OFF", "WAITING_INPUT", "CANCELLED"],
  HANDING_OFF: ["RUNNING", "WAITING_INPUT", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Invalid task state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** Returns `to` if the transition is legal, otherwise throws. */
export function assertTransition(from: TaskState, to: TaskState): TaskState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

export const RUN_STATES = ["STARTING", "ACTIVE", "ENDED_OK", "ENDED_ERROR", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];
