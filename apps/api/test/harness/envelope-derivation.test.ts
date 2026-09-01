/**
 * Phase 8b — `deriveEnvelopeUpdate`: the envelope-shaping subset lifted out of
 * `Orchestrator.applyEvent`, now shared with the flag-ON single-mode path.
 * Each event kind maps to the expected envelope mutation; unrelated events
 * (run/adapter/DB side-effect kinds) leave the envelope untouched and return
 * `false`.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, TaskEnvelope } from "@agent-plane/core";
import { deriveEnvelopeUpdate, mergeTail } from "../../src/modules/harness/envelope-derivation.js";

const baseEnvelope = (): TaskEnvelope => ({
  taskId: "AG-1" as never,
  goal: "g",
  constraints: [],
  status: { state: "RUNNING" as never },
  completed: [],
  remaining: [],
  decisions: [],
  artifacts: { changedFiles: [], testResults: [] },
});

const ev = (partial: Partial<NormalizedEvent> & Pick<NormalizedEvent, "type">): NormalizedEvent => ({
  runId: "run_1" as never,
  ts: "2026-01-01T00:00:00.000Z",
  summary: "s",
  ...partial,
});

describe("deriveEnvelopeUpdate — phase", () => {
  it("adopts a new phase and reports the change", () => {
    const e = baseEnvelope();
    expect(deriveEnvelopeUpdate(e, ev({ type: "message", phase: "editing", payload: {} }))).toBe(true);
    expect(e.status.phase).toBe("editing");
  });

  it("is a no-op when the phase is unchanged", () => {
    const e = baseEnvelope();
    e.status.phase = "editing";
    expect(deriveEnvelopeUpdate(e, ev({ type: "run.ended", phase: "editing" }))).toBe(false);
  });
});

describe("deriveEnvelopeUpdate — file.changed", () => {
  it("appends a landed file once", () => {
    const e = baseEnvelope();
    expect(deriveEnvelopeUpdate(e, ev({ type: "file.changed", payload: { path: "a.ts" } }))).toBe(true);
    expect(e.artifacts.changedFiles).toEqual(["a.ts"]);
    expect(deriveEnvelopeUpdate(e, ev({ type: "file.changed", payload: { path: "a.ts" } }))).toBe(false);
    expect(e.artifacts.changedFiles).toEqual(["a.ts"]);
  });

  it("ignores an attempted-but-failed change (ok:false)", () => {
    const e = baseEnvelope();
    expect(deriveEnvelopeUpdate(e, ev({ type: "file.changed", payload: { path: "a.ts", ok: false } }))).toBe(false);
    expect(e.artifacts.changedFiles).toEqual([]);
  });
});

describe("deriveEnvelopeUpdate — test.result", () => {
  it("appends a result summary with a defaulted count", () => {
    const e = baseEnvelope();
    expect(deriveEnvelopeUpdate(e, ev({ type: "test.result", payload: { passed: 3 } }))).toBe(true);
    expect(e.artifacts.testResults).toEqual([{ at: "2026-01-01T00:00:00.000Z", passed: 3, failed: 0 }]);
  });
});

describe("deriveEnvelopeUpdate — message", () => {
  it("pushes the summary onto completed and clears nextAction", () => {
    const e = baseEnvelope();
    e.nextAction = "keep going";
    expect(deriveEnvelopeUpdate(e, ev({ type: "message", summary: "did a thing", payload: { text: "x" } }))).toBe(true);
    expect(e.completed).toEqual(["did a thing"]);
    expect(e.nextAction).toBeUndefined();
  });

  it("ignores a message with no text payload", () => {
    const e = baseEnvelope();
    expect(deriveEnvelopeUpdate(e, ev({ type: "message", payload: {} }))).toBe(false);
    expect(e.completed).toEqual([]);
  });
});

describe("deriveEnvelopeUpdate — unrelated (side-effect kinds stay in applyEvent)", () => {
  it.each(["run.started", "usage.updated", "limit.approaching", "limit.hit", "error"] as const)(
    "%s does not touch the envelope",
    (type) => {
      const e = baseEnvelope();
      const before = JSON.stringify(e);
      expect(deriveEnvelopeUpdate(e, ev({ type, payload: { providerSessionRef: "x" } }))).toBe(false);
      expect(JSON.stringify(e)).toBe(before);
    },
  );
});

describe("mergeTail", () => {
  it("dedupes against the whole list and bounds the length", () => {
    expect(mergeTail(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(mergeTail(["a"], "b")).toEqual(["a", "b"]);
    const long = Array.from({ length: 20 }, (_, i) => `e${i}`);
    expect(mergeTail(long, "new")).toHaveLength(20);
    expect(mergeTail(long, "new").at(-1)).toBe("new");
    expect(mergeTail(long, "new").at(0)).toBe("e1");
  });
});
