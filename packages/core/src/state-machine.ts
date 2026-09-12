import type { PauseKind } from "./scheduler.js";
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
  "WAITING_RESOURCE",
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
  CREATED: ["WAITING_RESOURCE", "ROUTING", "CANCELLED"],
  // ROUTING → WAITING_INPUT: no eligible assistant (all filtered/limited).
  ROUTING: ["WAITING_RESOURCE", "RUNNING", "WAITING_INPUT", "FAILED", "CANCELLED"],
  RUNNING: [
    "WAITING_INPUT",
    // K11: a settled YIELDED(context) parks the task on a scheduler wait so the
    // normal K1 dispatch path owns the successor. No live session remains and no
    // human decision is pending, which is exactly what WAITING_RESOURCE means.
    "WAITING_RESOURCE",
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
  WAITING_RESOURCE: ["ROUTING", "WAITING_INPUT", "CANCELLED"],
  WAITING_INPUT: ["WAITING_RESOURCE", "RUNNING", "ROUTING", "HANDING_OFF", "COMPLETED", "FAILED", "CANCELLED"],
  LIMIT_PAUSED: ["WAITING_RESOURCE", "HANDING_OFF", "WAITING_INPUT", "CANCELLED"],
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

/**
 * The two narrowly authorized exceptions to "a pause needs a human" (CR-35).
 * Both are K4b: a pool claim is the one prerequisite an operator cannot grant
 * by deciding, so the decision has to be able to wait for it.
 *
 * `resource-repair` — an operator repairing a resource request the pool can no
 *   longer satisfy. That is a configuration fault, not a judgement, and it is
 *   the only `intervention_required` pause whose repair is itself a wait.
 * `resource-continuation` — an operator continuation (manual handoff) of a task
 *   that still owes the pool a claim. `WAITING_INPUT → HANDING_OFF → RUNNING` is
 *   already open to an operator from ANY pause kind, so parking that same
 *   decision until a slot frees adds no authority; it removes the one path that
 *   could have started execution without capacity.
 *
 * Neither is available to an automatic actor, and neither makes a pause
 * generically wait-eligible: approval, verification and comparison pauses stay
 * exactly as non-deferrable as they were.
 */
export type TransitionGrant = "resource-repair" | "resource-continuation";

export function canTransition(from: TaskState, to: TaskState, pauseKind?: PauseKind, grant?: TransitionGrant): boolean {
  if (from === "WAITING_INPUT" && to === "WAITING_RESOURCE" &&
      !["limit", "provider_unavailable", "no_candidate", "harness_error"].includes(pauseKind ?? "") &&
      !(grant === "resource-repair" && pauseKind === "intervention_required") &&
      grant !== "resource-continuation") return false;
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
export function assertTransition(from: TaskState, to: TaskState, pauseKind?: PauseKind, grant?: TransitionGrant): TaskState {
  if (!canTransition(from, to, pauseKind, grant)) throw new InvalidTransitionError(from, to);
  return to;
}

export const RUN_STATES = ["STARTING", "ACTIVE", "ENDED_OK", "ENDED_ERROR", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];
