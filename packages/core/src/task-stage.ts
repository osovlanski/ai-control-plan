import type { ExecutionSessionState } from "./session-state.js";
import type { TaskState } from "./state-machine.js";

/**
 * Task stage v1 (docs/contracts/task-stage-v1.md, API 2.9): the operator's coarse answer to
 * "where is this task", computed once in the plane from facts it already owns so no client
 * infers it. Pure: no clock, I/O or environment (held to the Composer's purity lint rule).
 *
 * `TaskState` stays the authoritative orchestration machine; a stage never drives a
 * transition. It exists because part of the answer is not in `TaskState`: a RUNNING task can
 * hold a session that is AWAITING_APPROVAL or VERIFYING.
 */
export const TASK_STAGES = ["queued", "working", "verifying", "needs-you", "done"] as const;
export type TaskStageValue = (typeof TASK_STAGES)[number];

/** Every rule, in evaluation order. Each belongs to exactly one stage (`TASK_STAGE_OF_RULE`). */
export const TASK_STAGE_RULES = [
  "terminal",
  "waiting-input",
  "limit-paused",
  "awaiting-approval",
  "verification-running",
  "live-run",
  "run-starting",
  "wait-condition",
  "run-ended-unsettled",
  "no-run",
] as const;
export type TaskStageRule = (typeof TASK_STAGE_RULES)[number];

export const TASK_STAGE_OF_RULE: Readonly<Record<TaskStageRule, TaskStageValue>> = {
  terminal: "done",
  "waiting-input": "needs-you",
  "limit-paused": "needs-you",
  "awaiting-approval": "needs-you",
  "verification-running": "verifying",
  "live-run": "working",
  "run-starting": "working",
  "wait-condition": "queued",
  "run-ended-unsettled": "verifying",
  "no-run": "queued",
};

export interface TaskStage {
  value: TaskStageValue;
  /** The one rule that produced `value`, so the stage can always be explained. */
  rule: TaskStageRule;
}

/** The only facts a stage is derived from. Phase, usage, cost and verdicts never move it. */
export interface TaskStageFacts {
  taskState: TaskState;
  /**
   * Effective states of the task's runs (`session_state` for Harness rows, the legacy state
   * mapped through `effectiveStateSql` otherwise). Terminal ones are ignored, so callers may
   * pass every run.
   */
  sessionStates: readonly ExecutionSessionState[];
  /** The task's latest wait condition is `active`. */
  waitActive: boolean;
}

type SessionClass = "ended" | "live" | "approval" | "verifying";

function classifySession(state: ExecutionSessionState): SessionClass {
  switch (state) {
    case "PREPARED":
    case "STARTING":
    case "RUNNING":
    case "PAUSED":
    case "RESUMING":
      return "live";
    case "AWAITING_APPROVAL":
      return "approval";
    case "VERIFYING":
      return "verifying";
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
    case "YIELDED":
      return "ended";
    default:
      return unhandled(state, "session state");
  }
}

function stage(rule: TaskStageRule): TaskStage {
  return { value: TASK_STAGE_OF_RULE[rule], rule };
}

/** Rules are tried in `TASK_STAGE_RULES` order; the first that matches wins. */
export function deriveStage(facts: TaskStageFacts): TaskStage {
  const sessions = facts.sessionStates.map(classifySession);
  const { taskState } = facts;
  switch (taskState) {
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
      return stage("terminal");
    case "WAITING_INPUT":
      return stage("waiting-input");
    case "LIMIT_PAUSED":
      return stage("limit-paused");
    case "CREATED":
    case "ROUTING":
    case "RUNNING":
    case "WAITING_RESOURCE":
    case "HANDING_OFF":
      break;
    default:
      return unhandled(taskState, "task state");
  }
  if (sessions.includes("approval")) return stage("awaiting-approval");
  if (sessions.includes("verifying")) return stage("verification-running");
  if (sessions.includes("live")) return stage("live-run");
  // RUNNING is entered just before the first session row is written; that is a run starting.
  if (taskState === "RUNNING" && sessions.length === 0) return stage("run-starting");
  switch (taskState) {
    case "WAITING_RESOURCE":
      return stage("wait-condition");
    case "RUNNING":
      return stage("run-ended-unsettled");
    case "CREATED":
    case "ROUTING":
    case "HANDING_OFF":
      return stage(facts.waitActive ? "wait-condition" : "no-run");
  }
}

/** Compile-time exhaustiveness; at runtime an unknown value (e.g. a bad DB row) is loud. */
function unhandled(value: never, what: string): never {
  throw new Error(`deriveStage: unhandled ${what} ${String(value)}`);
}
