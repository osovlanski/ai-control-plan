import type { SessionSummary, TaskDetail, TaskSummary } from "../api.js";

/** Presentation evidence from the existing effective run-state read. Task state
 * remains untouched: a RUNNING task can contain an AWAITING_APPROVAL session. */
export interface ExecutionRead {
  awaitingApproval: boolean;
  assistants: string[];
  verified?: boolean;
}
export type Mission = TaskSummary & { execution?: ExecutionRead };
export function executionRead(detail: TaskDetail, sessions: SessionSummary[]): ExecutionRead {
  const live = detail.runs.filter(r => !r.ended_at);
  const verified = live.length > 0 && live.every(r => sessions.some(s => s.sessionId === r.id));
  return {
    verified,
    awaitingApproval: detail.state === "RUNNING" && live.some(r => r.state === "AWAITING_APPROVAL"),
    assistants: detail.state === "RUNNING" && verified ? [...new Set(live.filter(r => r.state === "RUNNING").map(r => r.assistant_id))] : [],
  };
}
export function missionState(task: { state: string; execution?: ExecutionRead }): string {
  if (task.state !== "RUNNING") return task.state;
  if (task.execution?.awaitingApproval) return "AWAITING_APPROVAL";
  return task.execution?.verified === false ? "RUNTIME_UNKNOWN" : task.state;
}
