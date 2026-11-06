/**
 * O6 S3 (docs/agentic-os-o6-memory-writeback.md §2.2, Q3): the pure memory shadow rule and the
 * read-back of what stage 4 did with each pin.
 */
import { describe, expect, it } from "vitest";
import {
  MEMORY_SHADOW_RULE, memoryProduction, memoryShadow, memoryShadowVerdict, wouldDemote,
  type CompositionDecisionDraft, type MemoryShadowHealth, type MemoryShadowSnapshot,
} from "../src/index.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const health = (members: number, staleMembers: number, extra: Partial<MemoryShadowHealth> = {}): MemoryShadowHealth => ({
  members, staleMembers, oldestAgeDays: members ? 214 : null, duplicatePairs: 0, ghosts: 0, oversized: 0, findingsDigest: D("f"), ...extra,
});
const snapshot = (bundles: MemoryShadowSnapshot["bundles"]): MemoryShadowSnapshot => ({ snapshotDigest: D("9"), observedAt: "2026-11-06T09:00:00.000Z", bundles });
const one = (h: MemoryShadowHealth) => memoryShadowVerdict({ id: "b", digest: D("a") }, snapshot([{ id: "b", digest: D("a"), health: h }]));

describe("memory-shadow/v1 rule table", () => {
  it.each([
    // [members, stale, action]: the 0.5 boundary from both sides, odd and even member counts.
    [8, 4, "demote"], [8, 3, "keep"], [8, 5, "demote"],
    [7, 4, "demote"], [7, 3, "keep"],
    [2, 1, "demote"], [1, 0, "keep"], [1, 1, "demote"],
    [7, 7, "demote"], [7, 0, "keep"], [0, 0, "keep"],
  ] as const)("%i members, %i stale: %s", (members, stale, action) => {
    expect(one(health(members, stale)).action).toBe(action);
    expect(wouldDemote({ members, staleMembers: stale })).toBe(action === "demote");
  });

  it("names the counts and the oldest age", () => {
    expect(one(health(7, 4))).toEqual({
      bundleId: "b", pinnedDigest: D("a"), snapshotBundleDigest: D("a"), action: "demote",
      reason: "stale: 4 of 7 members, oldest 214d", health: health(7, 4),
    });
    expect(one(health(7, 3)).reason).toBe("keep: 3 of 7 members stale, oldest 214d");
    expect(one(health(0, 0)).reason).toBe("keep: no members");
  });

  it("shows duplicates, ghosts and oversized members without demoting on them", () => {
    const v = one(health(4, 1, { duplicatePairs: 3, ghosts: 2, oversized: 1 }));
    expect(v.action).toBe("keep");
    expect(v.reason).toBe("keep: 1 of 4 members stale, oldest 214d; shown, not demoting: 3 duplicate pairs, 2 ghosts, 1 oversized");
    expect(one(health(4, 2, { duplicatePairs: 1 })).reason).toBe("stale: 2 of 4 members, oldest 214d; shown, not demoting: 1 duplicate pair");
  });

  it("is unknown with no snapshot or a bundle the snapshot does not have", () => {
    expect(memoryShadowVerdict({ id: "b", digest: D("a") }, null)).toEqual({
      bundleId: "b", pinnedDigest: D("a"), snapshotBundleDigest: null, action: "unknown", reason: "unknown: no memory snapshot from Cockpit yet", health: null,
    });
    expect(memoryShadowVerdict({ id: "gone", digest: D("a") }, snapshot([{ id: "b", digest: D("a"), health: health(7, 7) }]))).toMatchObject({
      action: "unknown", reason: "unknown: not in the memory snapshot", snapshotBundleDigest: null, health: null,
    });
  });

  it("is drifted when the snapshot digest differs from the pin, whatever the health", () => {
    const v = memoryShadowVerdict({ id: "b", digest: D("a") }, snapshot([{ id: "b", digest: D("c"), health: health(7, 6) }]));
    expect(v.action).toBe("drifted");
    expect(v.snapshotBundleDigest).toBe(D("c"));
    expect(v.reason).toBe(`drifted: pinned sha256:aaaaaaaaaaaa…, snapshot sha256:cccccccccccc…; 6 of 7 members stale, oldest 214d`);
    expect(v.health).toEqual(health(7, 6));
  });

  it("answers per pin in id order, and reads no clock (same input, same output)", () => {
    const snap = snapshot([{ id: "a", digest: D("1"), health: health(3, 0) }, { id: "z", digest: D("2"), health: health(7, 4) }]);
    const pins = [{ id: "z", digest: D("2") }, { id: "a", digest: D("1") }, { id: "m", digest: D("3") }];
    const first = memoryShadow(pins, snap);
    expect(first.map((v) => [v.bundleId, v.action])).toEqual([["a", "keep"], ["m", "unknown"], ["z", "demote"]]);
    expect(memoryShadow([...pins].reverse(), snap)).toEqual(first);
    expect(MEMORY_SHADOW_RULE).toBe("memory-shadow/v1");
  });
});

const stage = (name: string, s: Partial<CompositionDecisionDraft["stages"][number]> = {}) =>
  ({ stage: name, candidates: [], filters: [], chosen: [], why: "x", override: null, ...s }) as CompositionDecisionDraft["stages"][number];
const decision = (context: CompositionDecisionDraft["stages"][number]): CompositionDecisionDraft =>
  ({ schema_version: "1.1", stages: [stage("intent"), stage("harness_model"), stage("assets"), context, stage("policy"), stage("confirm")] }) as CompositionDecisionDraft;
const pinned = [
  { ref: "fragment:typescript-style", evidence: ["configured"] },
  { ref: "memory:fresh", digest: D("1"), evidence: ["pinned in config"] },
  { ref: "memory:old", digest: D("2"), evidence: ["pinned in config"] },
  { ref: `bundle:${D("b")}`, digest: D("b"), evidence: [] },
];

describe("memoryProduction reads stage 4 back from the decision", () => {
  it("reports included and excluded_by_renderer from a rendered context stage", () => {
    const d = decision(stage("context", {
      candidates: pinned, chosen: ["fragment:typescript-style", "memory:fresh"],
      filters: [{ filter: "excluded_by_renderer", removed: ["memory:old"], reason: "excluded by renderer: over budget" }],
    }));
    expect(memoryProduction(d, { status: "composed" })).toEqual([
      { id: "fresh", digest: D("1"), action: "included", reason: null },
      { id: "old", digest: D("2"), action: "excluded_by_renderer", reason: null },
    ]);
  });

  it("reports not_found when Cockpit refused the bundle request, not_rendered for any other stop", () => {
    const failed = decision(stage("context", { candidates: pinned.slice(0, 3), why: "no bundle: not_found" }));
    expect(memoryProduction(failed, { status: "failed", reason: "not_found" }).map((p) => p.action)).toEqual(["not_found", "not_found"]);
    expect(memoryProduction(failed, { status: "failed", reason: "unreachable" })).toEqual([
      { id: "fresh", digest: D("1"), action: "not_rendered", reason: "unreachable" },
      { id: "old", digest: D("2"), action: "not_rendered", reason: "unreachable" },
    ]);
  });

  it("is empty when nothing is pinned or the pipeline stopped before stage 4", () => {
    expect(memoryProduction(decision(stage("context", { candidates: [pinned[0]!], chosen: ["fragment:typescript-style"] })), { status: "composed" })).toEqual([]);
    expect(memoryProduction(decision(stage("context", { why: "not run: pipeline stopped at harness_model (no_candidate)" })), { status: "failed", reason: "no_candidate" })).toEqual([]);
  });
});
