/** Task stage v1 (docs/contracts/task-stage-v1.md): every state lands in exactly one stage. */
import { describe, expect, it } from "vitest";
import {
  deriveStage,
  EXECUTION_SESSION_STATES,
  SESSION_TERMINAL_STATES,
  TASK_STAGE_OF_RULE,
  TASK_STAGE_RULES,
  TASK_STAGES,
  TASK_STATES,
  type ExecutionSessionState,
  type TaskStageFacts,
  type TaskState,
} from "../src/index.js";

const facts = (taskState: TaskState, sessionStates: ExecutionSessionState[] = [], waitActive = false): TaskStageFacts =>
  ({ taskState, sessionStates, waitActive });
const of = (f: TaskStageFacts) => { const s = deriveStage(f); return `${s.value}/${s.rule}`; };

describe("deriveStage", () => {
  it("maps every TaskState with no session and no wait to exactly one stage", () => {
    const table: Record<TaskState, string> = {
      CREATED: "queued/no-run",
      ROUTING: "queued/no-run",
      RUNNING: "working/run-starting",
      WAITING_RESOURCE: "queued/wait-condition",
      WAITING_INPUT: "needs-you/waiting-input",
      LIMIT_PAUSED: "needs-you/limit-paused",
      HANDING_OFF: "queued/no-run",
      COMPLETED: "done/terminal",
      FAILED: "done/terminal",
      CANCELLED: "done/terminal",
    };
    expect(Object.keys(table).sort()).toEqual([...TASK_STATES].sort());
    for (const state of TASK_STATES) expect([state, of(facts(state))]).toEqual([state, table[state]]);
  });

  it("maps a RUNNING task by its live session state", () => {
    const table: Record<ExecutionSessionState, string> = {
      PREPARED: "working/live-run",
      STARTING: "working/live-run",
      RUNNING: "working/live-run",
      PAUSED: "working/live-run",
      RESUMING: "working/live-run",
      AWAITING_APPROVAL: "needs-you/awaiting-approval",
      VERIFYING: "verifying/verification-running",
      // A terminal session is not live: the run ended and the verdict is not settled yet.
      COMPLETED: "verifying/run-ended-unsettled",
      FAILED: "verifying/run-ended-unsettled",
      CANCELLED: "verifying/run-ended-unsettled",
      TIMED_OUT: "verifying/run-ended-unsettled",
      YIELDED: "verifying/run-ended-unsettled",
    };
    expect(Object.keys(table).sort()).toEqual([...EXECUTION_SESSION_STATES].sort());
    for (const s of EXECUTION_SESSION_STATES) expect([s, of(facts("RUNNING", [s]))]).toEqual([s, table[s]]);
  });

  it("covers the wait and verification cases", () => {
    // A wait condition queues a task that has not started a run.
    expect(of(facts("CREATED", [], true))).toBe("queued/wait-condition");
    expect(of(facts("ROUTING", [], true))).toBe("queued/wait-condition");
    expect(of(facts("HANDING_OFF", [], true))).toBe("queued/wait-condition");
    expect(of(facts("WAITING_RESOURCE", [], true))).toBe("queued/wait-condition");
    // K11 context yield: the predecessor yielded and the task is parked on a wait.
    expect(of(facts("WAITING_RESOURCE", ["YIELDED"], true))).toBe("queued/wait-condition");
    // A failed verification pauses the task for the operator; the stage is needs-you.
    expect(of(facts("WAITING_INPUT", ["COMPLETED"]))).toBe("needs-you/waiting-input");
    // Approval beats verification beats a plain live run (compare/race have several runs).
    expect(of(facts("RUNNING", ["RUNNING", "VERIFYING", "AWAITING_APPROVAL"]))).toBe("needs-you/awaiting-approval");
    expect(of(facts("RUNNING", ["RUNNING", "VERIFYING"]))).toBe("verifying/verification-running");
    expect(of(facts("RUNNING", ["FAILED", "RUNNING"]))).toBe("working/live-run");
    // A handoff whose successor already started is working, not queued.
    expect(of(facts("HANDING_OFF", ["CANCELLED", "STARTING"]))).toBe("working/live-run");
    // Terminal and operator pauses win over any stale live row.
    expect(of(facts("COMPLETED", ["RUNNING"]))).toBe("done/terminal");
    expect(of(facts("LIMIT_PAUSED", ["AWAITING_APPROVAL"]))).toBe("needs-you/limit-paused");
  });

  it("gives each rule exactly one stage and uses every stage", () => {
    expect(Object.keys(TASK_STAGE_OF_RULE)).toEqual([...TASK_STAGE_RULES]);
    expect(new Set(Object.values(TASK_STAGE_OF_RULE))).toEqual(new Set(TASK_STAGES));
    expect(SESSION_TERMINAL_STATES.length).toBeGreaterThan(0);
  });

  it("is a type error, and a loud runtime error, for an unknown state", () => {
    // @ts-expect-error an unknown TaskState does not compile
    expect(() => deriveStage(facts("REVIEWING"))).toThrow(/unhandled task state REVIEWING/);
    // @ts-expect-error an unknown session state does not compile
    expect(() => deriveStage(facts("RUNNING", ["SPECCING"]))).toThrow(/unhandled session state SPECCING/);
  });
});
