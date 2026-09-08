/**
 * M14 K9 — `buildContextObservation` truth rules (kernel-services §4.3.1).
 *
 * Pressure is computed ONLY from occupancy / a real effective window, both
 * known and fresh. It is never synthesised from the advertised maximum or from
 * token accounting; an unknown effective window yields tokens with no percentage.
 */
import { describe, expect, it } from "vitest";
import { buildContextObservation, type AdapterContextSample } from "../src/context.js";

const ctx = { sessionId: "es_1", sequence: 1, now: "2026-09-08T10:00:00.000Z" };

describe("buildContextObservation", () => {
  it("computes pressure only when occupancy AND a real effective window are known", () => {
    const o = buildContextObservation(
      { occupancyTokens: 82_000, occupancySource: "provider-reported", effectiveWindowTokens: 180_000 },
      ctx,
    );
    expect(o.pressure).toBeCloseTo(82_000 / 180_000, 4);
    expect(o.effectiveWindowSource).toBe("provider-reported");
    expect(o.freshness).toBe("live");
    expect(o.sequence).toBe(1);
  });

  it("returns occupancy tokens but NO pressure when the effective window is unknown", () => {
    const o = buildContextObservation(
      { occupancyTokens: 72_000, occupancySource: "provider-reported" },
      ctx,
    );
    expect(o.occupancyTokens).toBe(72_000);
    expect(o.pressure).toBeUndefined();
    expect(o.effectiveWindowSource).toBe("unavailable");
  });

  it("never derives pressure from the advertised maximum", () => {
    const o = buildContextObservation(
      { occupancyTokens: 90_000, occupancySource: "provider-reported", advertisedMaxTokens: 200_000 },
      ctx,
    );
    expect(o.advertisedMaxTokens).toBe(200_000);
    expect(o.pressure).toBeUndefined();
  });

  it("effective window and advertised maximum are stored as separate facts and may differ", () => {
    const sample: AdapterContextSample = {
      occupancyTokens: 100_000,
      occupancySource: "provider-reported",
      effectiveWindowTokens: 200_000, // resolved autocompaction window
      advertisedMaxTokens: 1_000_000, // model's advertised maximum
    };
    const o = buildContextObservation(sample, ctx);
    expect(o.effectiveWindowTokens).toBe(200_000);
    expect(o.advertisedMaxTokens).toBe(1_000_000);
    expect(o.pressure).toBeCloseTo(0.5, 4);
  });

  it("pressure may exceed 1 when occupancy is over the window", () => {
    const o = buildContextObservation(
      { occupancyTokens: 220_000, occupancySource: "provider-reported", effectiveWindowTokens: 200_000 },
      ctx,
    );
    expect(o.pressure).toBeCloseTo(1.1, 4);
  });

  it("keeps estimator metadata only when genuinely estimated", () => {
    const estimated = buildContextObservation(
      {
        occupancyTokens: 10,
        occupancySource: "estimated",
        estimator: { name: "tiktoken", version: "1" },
        effectiveWindowTokens: 100,
      },
      ctx,
    );
    expect(estimated.estimator).toEqual({ name: "tiktoken", version: "1" });
    const reported = buildContextObservation(
      {
        occupancyTokens: 10,
        occupancySource: "provider-reported",
        estimator: { name: "tiktoken", version: "1" },
        effectiveWindowTokens: 100,
      },
      ctx,
    );
    expect(reported.estimator).toBeUndefined();
  });
});
