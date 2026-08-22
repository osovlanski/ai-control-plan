import { describe, expect, it } from "vitest";
import {
  TASK_STATES,
  assertTransition,
  canTransition,
  isTerminal,
  isTaskState,
  InvalidTransitionError,
} from "../src/state-machine.js";

describe("task state machine", () => {
  it("follows the happy path", () => {
    expect(canTransition("CREATED", "ROUTING")).toBe(true);
    expect(canTransition("ROUTING", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(true);
  });

  it("supports the quota-failover path", () => {
    expect(canTransition("RUNNING", "LIMIT_PAUSED")).toBe(true);
    expect(canTransition("LIMIT_PAUSED", "HANDING_OFF")).toBe(true);
    expect(canTransition("HANDING_OFF", "RUNNING")).toBe(true);
  });

  it("parks in WAITING_INPUT when no failover target exists", () => {
    expect(canTransition("LIMIT_PAUSED", "WAITING_INPUT")).toBe(true);
    expect(canTransition("WAITING_INPUT", "ROUTING")).toBe(true);
  });

  it("lets the user manually move parked work onward", () => {
    // The recovery path when automatic failover found nowhere to go.
    expect(canTransition("WAITING_INPUT", "HANDING_OFF")).toBe(true);
    expect(canTransition("HANDING_OFF", "RUNNING")).toBe(true);
  });

  it("allows cancel from every non-terminal state", () => {
    for (const state of TASK_STATES.filter((s) => !isTerminal(s))) {
      expect(canTransition(state, "CANCELLED"), `${state} -> CANCELLED`).toBe(true);
    }
  });

  it("terminal states allow no transitions", () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      for (const to of TASK_STATES) {
        expect(canTransition(state, to), `${state} -> ${to}`).toBe(false);
      }
    }
  });

  it("rejects illegal transitions loudly", () => {
    expect(() => assertTransition("CREATED", "RUNNING")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("COMPLETED", "ROUTING")).toThrow(InvalidTransitionError);
  });

  it("guards raw DB strings", () => {
    expect(isTaskState("RUNNING")).toBe(true);
    expect(isTaskState("EXECUTING")).toBe(false); // old 21-state name must not sneak back in
  });
});
