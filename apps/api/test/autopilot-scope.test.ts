import { describe, expect, it } from "vitest";
import type { BacklogItem } from "../src/modules/autopilot-dispatcher.js";
import { renderScope, summariseScope, type ScopeState } from "../src/modules/autopilot-scope.js";

const item = (id: string, size: string, phase = "p0"): BacklogItem => ({ id, title: id, phase, repo: "r", size, depends_on: [], files: [], lane: "oci-loop", profile: "auto", night: true, raw: {} });

describe("summariseScope", () => {
  it("weighs S=1, M=3, L=8, lists unread and unsized items, and reports points added since the day's baseline", () => {
    const items = [item("a", "L"), item("b", "M"), item("c", "S", "p1"), item("d", "XL", "p1"), item("e", "S", "p1")];
    const states = new Map<string, ScopeState>([["a", "done"], ["b", "in review"], ["c", "remaining"], ["d", "remaining"]]);
    const { summary } = summariseScope(items, states, new Set(["a", "b", "c"]));
    expect(summary).toMatchObject({ totalPoints: 13, donePoints: 8, inReviewPoints: 3, remainingPoints: 2, percentDone: 62, unknown: ["e"], unsized: ["d"], remaining: 3 });
    expect(summary.byPhase).toEqual([{ phase: "p0", totalPoints: 11, donePoints: 8, percentDone: 73 }, { phase: "p1", totalPoints: 2, donePoints: 0, percentDone: 0 }]);
    expect(summary.addedToday).toEqual({ ids: ["d", "e"], points: 1 });
    expect(renderScope(summary, "2030-01-01")).toContain("62% done — 8 of 13 points");
  });
  it("is 0% for an empty backlog rather than dividing by zero", () => {
    expect(summariseScope([], new Map()).summary).toMatchObject({ totalPoints: 0, percentDone: 0 });
  });
});
