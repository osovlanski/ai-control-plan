import { describe, expect, it } from "vitest";
import { EFFORT_LADDERS, EFFORT_UNKNOWN, chooseEffort, effortLevelFor, normalizeReportedEffort } from "../src/index.js";

// P1-5: effort is identity per harness ladder, never a scale shared across vendors.
describe("effort (P1-5)", () => {
  it("keeps each harness's own ladder; the names are not one shared scale", () => {
    expect(EFFORT_LADDERS["claude-code"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(EFFORT_LADDERS.codex).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    // `high` sits at a different position on each ladder: positions are never compared.
    expect(EFFORT_LADDERS["claude-code"].indexOf("high")).not.toBe(EFFORT_LADDERS.codex.indexOf("high"));
  });

  it("normalizes a provider report and drops anything that is not an effort token", () => {
    expect(normalizeReportedEffort(" XHigh ")).toBe("xhigh");
    for (const bad of [undefined, null, 3, "", "   ", "high; x", "a".repeat(40), EFFORT_UNKNOWN, "Unknown"]) {
      expect(normalizeReportedEffort(bad)).toBeUndefined();
    }
  });

  it("maps each profile to a level that is on both ladders", () => {
    const w = { weights: { coding: 0.5, speed: 0.25, cost: 0.25 } };
    expect(effortLevelFor("best-quality", w).level).toBe("high");
    for (const p of ["fastest", "lowest-tokens", "preserve-quota"] as const) expect(effortLevelFor(p, w).level).toBe("low");
    expect(effortLevelFor("auto", w).level).toBe("medium");
    expect(effortLevelFor("auto", { weights: { coding: 0.6, speed: 0.2, cost: 0.2 } }).level).toBe("high");
    expect(effortLevelFor("auto", { weights: { coding: 0.3, speed: 0.5, cost: 0.2 } }).level).toBe("low");
    for (const level of ["low", "medium", "high"]) {
      expect(EFFORT_LADDERS["claude-code"]).toContain(level);
      expect(EFFORT_LADDERS.codex).toContain(level);
    }
  });

  it("chooses on the assistant's ladder, reports a pin as a pin, and chooses nothing without a ladder", () => {
    expect(chooseEffort({ assistantId: "claude", ladder: "claude-code", level: "high" })).toMatchObject({ effort: "high", basis: "profile-rule" });
    expect(chooseEffort({ assistantId: "or", ladder: "codex", level: "low", pinned: "high" })).toMatchObject({ effort: "high", basis: "workspace-config" });
    const none = chooseEffort({ assistantId: "cursor", level: "high" });
    expect(none.basis).toBe("no-ladder");
    expect(none.effort).toBeUndefined();
  });
});
