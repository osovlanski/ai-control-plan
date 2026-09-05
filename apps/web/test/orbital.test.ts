import { describe, it, expect } from "vitest";
import {
  contextPercent,
  describeState,
  observedModel,
} from "../src/orbital.js";
import type { TaskEvent } from "../src/api.js";
describe("operator presentation boundaries", () => {
  it("keeps scheduler, human, and limit waits distinct", () => {
    expect(
      new Set(
        ["WAITING_RESOURCE", "WAITING_INPUT", "LIMIT_PAUSED"].map(
          (s) => describeState(s).label,
        ),
      ).size,
    ).toBe(3);
    expect(describeState("WAITING_INPUT", "approval_pending").label).toBe(
      "Approval required",
    );
    expect(describeState("WAITING_INPUT", "verification_failed").label).toBe(
      "Verification decision",
    );
    expect(describeState("FUTURE_STATE").label).toBe("FUTURE_STATE");
  });
  it("does not resolve model identity across runs or from usage", () => {
    const events = [
      {
        run_id: "a",
        type: "run.started",
        payload: { model: "reported-model" },
      },
      {
        run_id: "b",
        type: "usage.updated",
        payload: { model: "accounting-model" },
      },
    ].map((e) => ({
      ...e,
      seq: 1,
      ts: "2026-09-05T00:00:00Z",
      phase: null,
      summary: "",
      assistant_id: "test",
    })) satisfies TaskEvent[];
    expect(observedModel(events, "a")).toBe("reported-model");
    expect(observedModel(events, "b")).toBe("Unknown");
    expect(observedModel(events, undefined)).toBe("Unknown");
  });
  it("requires fresh occupancy and effective capacity for a percentage", () => {
    const base = {
      occupancyTokens: 800,
      effectiveWindowTokens: 1000,
      occupancySource: "provider-reported" as const,
      freshness: "live" as const,
    };
    expect(contextPercent(base)).toBe(80);
    expect(contextPercent({ ...base, freshness: "stale" })).toBeUndefined();
    expect(
      contextPercent({
        ...base,
        effectiveWindowTokens: undefined,
        advertisedMaxTokens: 1000,
      }),
    ).toBeUndefined();
    expect(
      contextPercent({ ...base, occupancySource: "unavailable" }),
    ).toBeUndefined();
    expect(contextPercent({ ...base, occupancyTokens: NaN })).toBeUndefined();
  });
});
