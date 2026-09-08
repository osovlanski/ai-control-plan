/**
 * M14 K11 — the pure context guard (kernel-services §4.3.2), table-driven.
 *
 * Covers the "may NOT yield" half of the acceptance matrix, which is the half
 * that actually protects the user: below critical, stale, unavailable occupancy,
 * an advertised maximum without an effective window, and provider
 * auto-compaction whose relief has not been observed yet (CR-34).
 */
import { describe, expect, it } from "vitest";
import type { ContextCapability, ContextObservation } from "@agent-plane/core";
import { CONTEXT_STALE_MS, DEFAULT_CONTEXT_POLICY, buildContextObservation } from "@agent-plane/core";
import { evaluateContextGuard } from "../../src/modules/harness/context-guard.js";

const NOW = 1_700_000_000_000;

const CAPABILITY: ContextCapability = {
  occupancy: "provider-reported",
  effectiveWindow: "provider-reported",
  compact: "none",
  autoManagement: "none",
  observesAutoCompaction: true,
};

function observation(sample: Parameters<typeof buildContextObservation>[0]): ContextObservation {
  return buildContextObservation(sample, {
    sessionId: "sess_1",
    sequence: 1,
    now: new Date(NOW).toISOString(),
  });
}

/** Occupancy + a real effective window ⇒ a real pressure. */
function atPressure(pressure: number): ContextObservation {
  return observation({
    occupancyTokens: Math.round(pressure * 200_000),
    occupancySource: "provider-reported",
    effectiveWindowTokens: 200_000,
    effectiveWindowSource: "provider-reported",
  });
}

const evaluate = (overrides: Partial<Parameters<typeof evaluateContextGuard>[0]> = {}) =>
  evaluateContextGuard({
    policy: DEFAULT_CONTEXT_POLICY,
    capability: CAPABILITY,
    nowMs: NOW,
    observedAtMs: NOW,
    ...overrides,
  });

describe("ContextGuard — thresholds", () => {
  it("continues below the warn threshold", () => {
    const d = evaluate({ observation: atPressure(0.4) });
    expect(d.action).toBe("continue");
    expect(d.pressure).toBeCloseTo(0.4, 4);
  });

  it("warns between warn and critical without yielding", () => {
    for (const p of [0.7, 0.85, 0.91]) {
      const d = evaluate({ observation: atPressure(p) });
      expect(d.action, `pressure ${p}`).toBe("warn");
    }
  });

  it("yields on a fresh observation at or above criticalRatio", () => {
    for (const p of [0.92, 0.97, 1.05]) {
      const d = evaluate({ observation: atPressure(p) });
      expect(d.action, `pressure ${p}`).toBe("yield");
      expect(d.reason).toMatch(/critical/);
    }
  });

  it("does not act at actRatio — that is K10 and it is not implemented", () => {
    expect(evaluate({ observation: atPressure(DEFAULT_CONTEXT_POLICY.actRatio) }).action).toBe("warn");
  });
});

describe("ContextGuard — only fresh, known evidence may trigger", () => {
  it("never yields on a stale critical observation", () => {
    const d = evaluate({ observation: atPressure(0.99), observedAtMs: NOW - CONTEXT_STALE_MS - 1 });
    expect(d.action).toBe("continue");
    expect(d.reason).toMatch(/stale/);
  });

  it("never yields when the observation itself is marked stale", () => {
    const d = evaluate({ observation: { ...atPressure(0.99), freshness: "stale" } });
    expect(d.action).toBe("continue");
  });

  it("never yields when the provider cannot report occupancy (Codex)", () => {
    const d = evaluate({
      capability: { ...CAPABILITY, occupancy: "unavailable", effectiveWindow: "unavailable" },
      observation: atPressure(0.99),
    });
    expect(d.action).toBe("continue");
    expect(d.reason).toMatch(/unavailable/);
  });

  it("never yields when there is no observation at all", () => {
    expect(evaluate({ observation: undefined }).action).toBe("continue");
  });

  it("never yields from an advertised maximum without an effective window", () => {
    // 190k occupancy against a 200k ADVERTISED max would read as 95% — the guard
    // must see no pressure at all, because the managed window is unknown.
    const partial = observation({
      occupancyTokens: 190_000,
      occupancySource: "provider-reported",
      advertisedMaxTokens: 200_000,
    });
    expect(partial.pressure).toBeUndefined();
    const d = evaluate({ observation: partial });
    expect(d.action).toBe("continue");
    expect(d.reason).toMatch(/effective window unknown/);
    expect(d.pressure).toBeUndefined();
  });

  it("never yields on occupancy the adapter could not measure", () => {
    const d = evaluate({
      observation: observation({ occupancySource: "unavailable", effectiveWindowTokens: 200_000 }),
    });
    expect(d.action).toBe("continue");
  });
});

describe("ContextGuard — CR-34 provider auto-management is primary", () => {
  it("waits for the post-compaction observation instead of yielding", () => {
    const d = evaluate({
      observation: atPressure(0.99),
      observedAtMs: NOW - 1_000,
      lastCompactionAtMs: NOW - 500,
    });
    expect(d.action).toBe("continue");
    expect(d.reason).toMatch(/auto-compaction/);
  });

  it("yields when a LATER fresh observation is still critical", () => {
    const d = evaluate({
      observation: atPressure(0.99),
      observedAtMs: NOW,
      lastCompactionAtMs: NOW - 5_000,
    });
    expect(d.action).toBe("yield");
  });

  it("does not yield when relief brought pressure back down", () => {
    const d = evaluate({ observation: atPressure(0.45), observedAtMs: NOW, lastCompactionAtMs: NOW - 5_000 });
    expect(d.action).toBe("continue");
  });
});

describe("ContextGuard — K10 is not implemented here", () => {
  it("leaves an adapter with a compaction control alone", () => {
    const d = evaluate({
      capability: { ...CAPABILITY, compact: "provider-command" },
      observation: atPressure(0.99),
    });
    expect(d.action).toBe("continue");
    expect(d.reason).toMatch(/K10 unimplemented/);
  });
});
