/**
 * M6 S4: the asset-shadow/v1 formula table and the shadow rank (plan §4.1, §4.2).
 */
import { describe, expect, it } from "vitest";
import {
  ASSET_SHADOW_K, assetShadow, runComposer, scoreAssets, shadowBaseline, shadowChoice, shadowGroup, shadowView, telemetryWeight,
  type AssetCohortScore, type AssetShadowObservation, type ComposerAsset, type ComposerInputs, type ShadowCandidate,
} from "../src/index.js";
import { baseInputs, deps, digestOf, fakeBundle, fakeHarnessModel, projection, skill } from "./composer/helpers.js";

const WINDOW = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" };
const SKILL = { assetKind: "skill" as const, assetId: "claude-skills:a", assetDigest: digestOf("a") };
const OTHER = { assetKind: "skill" as const, assetId: "claude-skills:b", assetDigest: digestOf("b") };

let seq = 0;
/** One ledger row; a session with `asset: undefined` stands in for a session that had only another asset. */
function obs(over: Partial<AssetShadowObservation> & { sessionId?: string } = {}): AssetShadowObservation {
  seq += 1;
  return {
    sessionId: `S-${seq}`, taskKind: "coding", harness: "claude-code", ...SKILL,
    attached: true, invocationMethod: "tool_event", invocationCount: 1, sessionOutcome: "success", verificationPassed: null,
    at: "2026-10-15T00:00:00.000Z", ...over,
  };
}
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const only = (scores: ReturnType<typeof scoreAssets>, id = SKILL.assetId) => scores.cohorts.find((c) => c.assetId === id)!;

describe("asset-shadow/v1 formula", () => {
  it("weights by K13's w(n) = n/(n+k), k = 10: w(0) = 0, w(k) = 0.5", () => {
    expect(ASSET_SHADOW_K).toBe(10);
    expect(telemetryWeight(0, ASSET_SHADOW_K)).toBe(0);
    expect(telemetryWeight(ASSET_SHADOW_K, ASSET_SHADOW_K)).toBe(0.5);
    expect(shadowGroup(0, 0, 0.5).w).toBe(0);
    expect(shadowGroup(10, 7, 0.5).w).toBe(0.5);
  });

  it("baseline is (s+1)/(n+2), the smoothed rate is w·raw + (1−w)·p, and the lift is r − p", () => {
    expect(shadowBaseline(0, 0).p).toBe(0.5);
    expect(shadowBaseline(4, 1).p).toBeCloseTo(1 / 3, 12);
    const p = 1 / 3;
    const g = shadowGroup(10, 10, p);
    expect(g.rate).toBe(1);
    expect(g.smoothed).toBeCloseTo(0.5 * 1 + 0.5 * p, 12);
    expect(g.lift).toBeCloseTo(g.smoothed - p, 12);
    expect(g.lift).toBeCloseTo(1 / 3, 12);
  });

  it("is exactly 0 with no evidence", () => {
    expect(shadowGroup(0, 0, 0.8)).toEqual({ n: 0, s: 0, rate: null, w: 0, smoothed: 0.8, lift: 0 });
    // An asset only ever seen unattached has a baseline and no group: lift 0.
    const scores = scoreAssets([obs({ attached: false, invocationMethod: "not_observable", invocationCount: null })], WINDOW);
    expect(only(scores).outcome.group).toMatchObject({ n: 0, lift: 0 });
    expect(only(scores).rankingLift).toBe(0);
    expect(scoreAssets([], WINDOW)).toMatchObject({ sessions: { inWindow: 0, sample: 0 }, cohorts: [], pooled: [] });
  });

  it("computes the table over sessions: invoked against not-attached, idle attachment as the control", () => {
    const rows = [
      // 10 invoked sessions, 9 succeeded.
      ...times(10, (i) => obs({ sessionOutcome: i < 9 ? "success" : "error" })),
      // 4 attached but idle, 1 succeeded.
      ...times(4, (i) => obs({ invocationCount: 0, sessionOutcome: i < 1 ? "success" : "error" })),
      // 6 sessions without it (they had another asset), 2 succeeded.
      ...times(6, (i) => obs({ ...OTHER, sessionOutcome: i < 2 ? "success" : "error" })),
    ];
    const a = only(scoreAssets(rows, WINDOW));
    expect(a.method).toBe("tool_event");
    expect(a.outcome.baseline).toEqual({ n: 6, s: 2, p: 3 / 8 });
    expect(a.outcome.group).toMatchObject({ n: 10, s: 9, rate: 0.9, w: 0.5 });
    expect(a.outcome.group.smoothed).toBeCloseTo((9 + 10 * (3 / 8)) / 20, 12);
    expect(a.outcome.group.lift).toBeCloseTo((9 + 3.75) / 20 - 3 / 8, 12);
    expect(a.outcome.control).toMatchObject({ n: 4, s: 1 });
    expect(a.outcome.noise).toBe(false);
    expect(a.rankingLift).toBe(a.outcome.group.lift);
  });

  it("flags noise when idle attachment does as well as invocation", () => {
    const rows = [
      ...times(5, () => obs({ sessionOutcome: "success" })),
      ...times(5, () => obs({ invocationCount: 0, sessionOutcome: "success" })),
      ...times(5, () => obs({ ...OTHER, sessionOutcome: "error" })),
    ];
    expect(only(scoreAssets(rows, WINDOW)).outcome.noise).toBe(true);
  });

  it("excludes neutral and not_run sessions, and rows outside the window", () => {
    const counted = [...times(3, () => obs()), obs({ ...OTHER, sessionOutcome: "error" })];
    const ignored = [
      ...times(4, () => obs({ sessionOutcome: "neutral" })),
      ...times(2, () => obs({ sessionOutcome: "not_run", invocationCount: 0 })),
      obs({ at: "2026-09-30T23:59:59.999Z" }),
      obs({ at: "2026-11-01T00:00:00.000Z" }),
    ];
    const with_ = scoreAssets([...counted, ...ignored], WINDOW);
    const without = scoreAssets(counted, WINDOW);
    expect(with_.sessions).toEqual({ inWindow: 10, sample: 4, neutral: 4, notRun: 2 });
    expect(only(with_)).toEqual(only(without));
  });

  it("labels an unobservable asset attached_only, scores its attached lift, and never lets it rank", () => {
    const rows = [
      ...times(10, () => obs({ assetKind: "fragment", invocationMethod: "not_applicable", invocationCount: null })),
      ...times(4, () => obs({ ...OTHER, sessionOutcome: "error" })),
    ];
    const f = only(scoreAssets(rows, WINDOW));
    expect(f.method).toBe("attached_only");
    expect(f.outcome.group).toMatchObject({ n: 10, s: 10 });
    expect(f.outcome.group.lift).toBeGreaterThan(0);
    expect(f.outcome.control).toBeNull();
    expect(f.rankingLift).toBe(0);
  });

  it("runs the same formula on verification_passed among sessions that ran one", () => {
    const rows = [
      ...times(3, () => obs({ verificationPassed: true })),
      obs({ verificationPassed: false }),
      obs({ verificationPassed: null }),
      ...times(2, () => obs({ ...OTHER, verificationPassed: false })),
    ];
    const v = only(scoreAssets(rows, WINDOW)).verification;
    expect(v.baseline).toEqual({ n: 2, s: 0, p: 0.25 });
    expect(v.group).toMatchObject({ n: 4, s: 3 });
  });

  it("scores each (id, digest) per (task_kind, harness) cohort and pools by n_I", () => {
    const newer = { ...SKILL, assetDigest: digestOf("a2") };
    const rows = [
      ...times(4, () => obs()),
      ...times(2, () => obs({ harness: "codex", sessionOutcome: "error" })),
      ...times(2, () => obs({ ...newer })),
      ...times(2, () => obs({ ...OTHER, sessionOutcome: "error" })),
    ];
    const s = scoreAssets(rows, WINDOW);
    const mine = s.cohorts.filter((c) => c.assetId === SKILL.assetId);
    // Cohorts in (task_kind, harness) order, assets by kind, id, then digest.
    const byDigest = [SKILL.assetDigest, newer.assetDigest].sort();
    expect(mine.map((c) => [c.harness, c.assetDigest, c.outcome.group.n])).toEqual([
      ...byDigest.map((d) => ["claude-code", d, d === SKILL.assetDigest ? 4 : 2]), ["codex", SKILL.assetDigest, 2],
    ]);
    const pooled = s.pooled.find((p) => p.assetId === SKILL.assetId && p.assetDigest === SKILL.assetDigest)!;
    const cc = mine.find((c) => c.harness === "claude-code" && c.assetDigest === SKILL.assetDigest)!;
    const cx = mine.find((c) => c.harness === "codex")!;
    expect(pooled.n).toBe(6);
    expect(pooled.lift).toBeCloseTo((4 * cc.outcome.group.lift + 2 * cx.outcome.group.lift) / 6, 12);
    expect(s.pooledById.find((p) => p.assetId === SKILL.assetId)).toMatchObject({ n: 8, cohorts: 3 });
    expect(s.pooledById.find((p) => p.assetId === SKILL.assetId)!.assetDigest).toBeUndefined();
  });

  it("is independent of row order", () => {
    const rows = [...times(6, (i) => obs({ sessionOutcome: i % 2 ? "success" : "error", invocationCount: i % 3 })), ...times(3, () => obs({ ...OTHER }))];
    expect(scoreAssets([...rows].reverse(), WINDOW)).toEqual(scoreAssets(rows, WINDOW));
  });
});

// ---- shadow rank ------------------------------------------------------------

const cand = (id: string, over: Partial<ShadowCandidate> = {}): ShadowCandidate => ({ id, digest: digestOf(id), kind: "skill", matched: 1, conflicts: [], ...over });
const cohort = (id: string, rankingLift: number, method: AssetCohortScore["method"] = "tool_event"): AssetCohortScore => {
  const g = shadowGroup(10, 10, 0.5);
  const lift = { baseline: shadowBaseline(2, 0), group: g, control: null, noise: false };
  return { assetKind: "skill", assetId: id, assetDigest: digestOf(id), taskKind: "coding", harness: "claude-code", method, outcome: lift, verification: lift, rankingLift };
};
const view = (candidates: ShadowCandidate[], actual: string[], caps = { maxSkills: 1, maxMcpServers: 2 }, filtered: string[] = []) =>
  ({ candidates, actual, caps, filtered, overridden: false });

describe("shadow rank", () => {
  it("with every lift 0 is stage 3's order: matched desc, then id, conflicts and caps after", () => {
    const cs = [cand("b", { matched: 2 }), cand("a", { matched: 2 }), cand("c", { matched: 3, conflicts: ["a"] }), cand("z", { matched: 0 })];
    expect(shadowChoice(cs, { maxSkills: 2, maxMcpServers: 0 }, () => 0)).toEqual(["b", "c"]);
  });

  it("would_differ only when lift breaks a tie on matched tags", () => {
    // Tie: a and b both match 1, cap 1. Stage 3 picks a by id; b's lift picks b.
    const tie = assetShadow(view([cand("a"), cand("b")], ["a"]), [cohort("b", 0.2)]);
    expect(tie).toMatchObject({ status: "scored", actual: ["a"], shadow: ["b"], wouldDiffer: true, filterViolations: 0 });
    // No tie: a matches 2. Any lift on b leaves a chosen.
    const noTie = assetShadow(view([cand("a", { matched: 2 }), cand("b")], ["a"]), [cohort("b", 0.9)]);
    expect(noTie).toMatchObject({ shadow: ["a"], wouldDiffer: false });
    // A negative lift on the id-order winner also breaks the tie.
    expect(assetShadow(view([cand("a"), cand("b")], ["a"]), [cohort("a", -0.1)])).toMatchObject({ shadow: ["b"], wouldDiffer: true });
    // No telemetry: identical.
    expect(assetShadow(view([cand("a"), cand("b")], ["a"]), [])).toMatchObject({ shadow: ["a"], wouldDiffer: false });
  });

  it("never ranks an attached_only lift", () => {
    const r = assetShadow(view([cand("a"), cand("b")], ["a"]), [cohort("b", 0, "attached_only")]);
    expect(r).toMatchObject({ shadow: ["a"], wouldDiffer: false });
    expect(r.status === "scored" && r.candidates.find((c) => c.id === "b")).toMatchObject({ method: "attached_only", lift: 0 });
  });

  it("records rank_mismatch instead of a comparison when its rebuild does not reproduce stage 3", () => {
    expect(assetShadow(view([cand("a"), cand("b")], ["b"]), [])).toEqual({ status: "error", formula: "asset-shadow/v1", error: "rank_mismatch", actual: ["b"] });
  });
});

// ---- the rebuild against the real stage 3 -----------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function variant(seed: number): ComposerInputs {
  const rnd = mulberry32(seed);
  const some = <T>(xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.5);
  const TAGS = ["coding", "review", "typescript", "node", "vitest"];
  const pool: ComposerAsset[] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((name) =>
    skill(name, {
      tags: some(TAGS).sort(),
      enabled: rnd() > 0.1,
      conflicts: rnd() < 0.2 ? ["claude-skills:alpha"] : [],
      compatibility: { assistants: rnd() < 0.9 ? ["claude"] : ["cursor"] },
    }));
  const base = baseInputs();
  const allowlist = some(pool).map(({ id, digest }) => ({ id, digest }));
  return {
    ...base,
    registry: { ...(base.registry as Extract<ComposerInputs["registry"], { status: "ok" }>), assets: pool },
    config: { ...base.config, maxSkills: 1 + Math.floor(rnd() * 3), allowlist },
    ...(rnd() < 0.2 ? { overrides: { assets: { remove: allowlist.slice(0, 1).map((a) => a.id) } } } : {}),
  };
}

describe("shadow view over the real pipeline", () => {
  it("reproduces stage 3 with zero lifts, and never chooses a filtered asset whatever the lifts", async () => {
    let differed = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const inputs = variant(seed);
      const result = await runComposer(inputs, { harnessModel: fakeHarnessModel(projection()), bundle: fakeBundle({}) }, deps);
      const v = shadowView(result.decision, inputs);
      expect(v, `seed ${seed}`).toBeDefined();
      const rnd = mulberry32(seed * 7919);
      // A random lift for every registry asset, at the registry's own digest.
      const aligned = (inputs.registry.status === "ok" ? inputs.registry.assets : []).map((a) => ({ ...cohort(a.id, rnd() - 0.5), assetDigest: a.digest }));
      const r = assetShadow(v!, aligned);
      expect(r.status, `seed ${seed}`).toBe("scored");
      if (r.status !== "scored") continue;
      expect(r.filterViolations).toBe(0);
      for (const id of r.shadow) expect(v!.filtered, `seed ${seed}`).not.toContain(id);
      for (const id of r.shadow) expect(v!.candidates.map((c) => c.id)).toContain(id);
      if (r.wouldDiffer) differed += 1;
    }
    expect(differed).toBeGreaterThan(0);
  });

  it("is undefined when the pipeline stopped before stage 3", async () => {
    const inputs = baseInputs();
    const result = await runComposer(inputs, { harnessModel: fakeHarnessModel(projection({ chosen: undefined, ruleFired: "no-eligible-candidate" })), bundle: fakeBundle({}) }, deps);
    expect(shadowView(result.decision, inputs)).toBeUndefined();
  });
});
