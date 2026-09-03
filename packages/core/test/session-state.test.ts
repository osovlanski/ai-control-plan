import { describe, expect, it } from "vitest";
import {
  EXECUTION_SESSION_STATES,
  SESSION_TERMINAL_STATES,
  SESSION_TRANSITION_TRIGGERS,
  RUN_STATE_TO_SESSION_STATE,
  SESSION_STATE_TO_RUN_STATE,
  assertSessionTransition,
  canSessionTransition,
  isExecutionSessionState,
  isSessionTerminal,
  outcomeOf,
  InvalidSessionTransitionError,
  type ExecutionSessionState,
} from "../src/session-state.js";

describe("execution-session state machine", () => {
  it("drives a request through the one canonical happy path", () => {
    expect(canSessionTransition("PREPARED", "STARTING")).toBe(true);
    expect(canSessionTransition("STARTING", "RUNNING")).toBe(true);
    expect(canSessionTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(canSessionTransition("VERIFYING", "COMPLETED")).toBe(true);
  });

  it("only ever reaches COMPLETED from VERIFYING (single completion path, H-I6)", () => {
    for (const from of EXECUTION_SESSION_STATES) {
      if (from === "VERIFYING") continue;
      expect(canSessionTransition(from, "COMPLETED"), `${from} -> COMPLETED`).toBe(false);
    }
  });

  it("supports approval pause/resume as a RUNNING round-trip", () => {
    expect(canSessionTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(canSessionTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
  });

  it("supports explicit pause → resume", () => {
    expect(canSessionTransition("RUNNING", "PAUSED")).toBe(true);
    expect(canSessionTransition("PAUSED", "RESUMING")).toBe(true);
    expect(canSessionTransition("RESUMING", "RUNNING")).toBe(true);
  });

  it("yields instead of routing (H-I1) — RUNNING and AWAITING_APPROVAL can yield", () => {
    expect(canSessionTransition("RUNNING", "YIELDED")).toBe(true);
    expect(canSessionTransition("AWAITING_APPROVAL", "YIELDED")).toBe(true);
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const state of EXECUTION_SESSION_STATES.filter((s) => !isSessionTerminal(s))) {
      expect(canSessionTransition(state, "CANCELLED"), `${state} -> CANCELLED`).toBe(true);
    }
  });

  it("lets VERIFYING complete or preserve cancellation/deadline truth", () => {
    const exits = EXECUTION_SESSION_STATES.filter((to) => canSessionTransition("VERIFYING", to));
    expect(exits).toEqual(["COMPLETED", "CANCELLED", "TIMED_OUT"]);
  });

  it("treats every terminal state as a dead end", () => {
    for (const from of SESSION_TERMINAL_STATES) {
      for (const to of EXECUTION_SESSION_STATES) {
        expect(canSessionTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("sweeps every state pair: assertSessionTransition throws exactly on the illegal ones", () => {
    for (const from of EXECUTION_SESSION_STATES) {
      for (const to of EXECUTION_SESSION_STATES) {
        const legal = canSessionTransition(from, to);
        if (legal) {
          expect(assertSessionTransition(from, to)).toBe(to);
        } else {
          expect(() => assertSessionTransition(from, to)).toThrow(InvalidSessionTransitionError);
        }
      }
    }
  });

  it("documents a trigger for every legal transition and no phantom triggers", () => {
    const legalEdges = new Set<string>();
    for (const from of EXECUTION_SESSION_STATES) {
      for (const to of EXECUTION_SESSION_STATES) {
        if (canSessionTransition(from, to)) legalEdges.add(`${from}->${to}`);
      }
    }
    for (const edge of legalEdges) {
      expect(SESSION_TRANSITION_TRIGGERS[edge], `trigger for ${edge}`).toBeTruthy();
    }
    for (const edge of Object.keys(SESSION_TRANSITION_TRIGGERS)) {
      expect(legalEdges.has(edge), `${edge} is a real edge`).toBe(true);
    }
  });

  it("guards raw DB strings, including junk and edge inputs", () => {
    expect(isExecutionSessionState("RUNNING")).toBe(true);
    expect(isExecutionSessionState("AWAITING_APPROVAL")).toBe(true);
    expect(isExecutionSessionState("ACTIVE")).toBe(false); // legacy RUN_STATES vocabulary
    expect(isExecutionSessionState("EXECUTING")).toBe(false);
    for (const junk of ["", "running", "COMPLETED ", "PREPARED\n", "12", "[object Object]"]) {
      expect(isExecutionSessionState(junk), junk).toBe(false);
    }
  });
});

describe("outcome derivation", () => {
  it("maps each terminal state to its fixed outcome", () => {
    expect(outcomeOf("COMPLETED")).toBe("completed");
    expect(outcomeOf("FAILED")).toBe("failed");
    expect(outcomeOf("CANCELLED")).toBe("cancelled");
    expect(outcomeOf("TIMED_OUT")).toBe("timed_out");
    expect(outcomeOf("YIELDED")).toBe("yielded");
  });

  it("refuses to derive an outcome for a non-terminal state", () => {
    expect(() => outcomeOf("RUNNING")).toThrow();
  });
});

describe("legacy RUN_STATES migration mapping (§5)", () => {
  it("maps the five old vocabulary values forward to valid session states", () => {
    expect(RUN_STATE_TO_SESSION_STATE).toEqual({
      STARTING: "STARTING",
      ACTIVE: "RUNNING",
      ENDED_OK: "COMPLETED",
      ENDED_ERROR: "FAILED",
      CANCELLED: "CANCELLED",
    });
    for (const target of Object.values(RUN_STATE_TO_SESSION_STATE)) {
      expect(isExecutionSessionState(target)).toBe(true);
    }
  });

  it("maps every session state back to a legacy value for the dual-field read window", () => {
    for (const state of EXECUTION_SESSION_STATES) {
      const legacy = SESSION_STATE_TO_RUN_STATE[state as ExecutionSessionState];
      expect(["STARTING", "ACTIVE", "ENDED_OK", "ENDED_ERROR", "CANCELLED"]).toContain(legacy);
    }
    // Live intermediate states all collapse to ACTIVE.
    expect(SESSION_STATE_TO_RUN_STATE.AWAITING_APPROVAL).toBe("ACTIVE");
    expect(SESSION_STATE_TO_RUN_STATE.VERIFYING).toBe("ACTIVE");
    // A yield did not complete, so it reads as an error in the old vocabulary.
    expect(SESSION_STATE_TO_RUN_STATE.YIELDED).toBe("ENDED_ERROR");
  });

  it("round-trips the shared old values through both maps", () => {
    for (const [oldValue, sessionState] of Object.entries(RUN_STATE_TO_SESSION_STATE)) {
      if (oldValue === "ACTIVE") continue; // ACTIVE has several session-state preimages
      expect(SESSION_STATE_TO_RUN_STATE[sessionState]).toBe(oldValue);
    }
  });
});
