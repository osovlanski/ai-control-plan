import { describe, expect, it } from "vitest";
import {
  ATTESTATION_TTL_MS,
  DIMENSION_K,
  SHADOW_REVIEW_WINDOW_MS,
  classifyTask,
  evaluateActivationGate,
  scoreDimension,
  selectModel,
  selectPrior,
  telemetryWeight,
  type ActivationGateInput,
  type DimensionEvidence,
  type DimensionPrior,
  type ModelCandidateInput,
  type TaskClassification,
} from "../src/model-selection.js";
import type { Freshness } from "../src/model-catalog.js";
import type { AssistantId } from "../src/ids.js";

const AA = "external:artificial-analysis" as const;

function prior(over: Partial<DimensionPrior> & { value: number }): DimensionPrior {
  return {
    normalizationVersion: "aa-normalization-v1",
    freshness: "fresh" as Freshness,
    ...over,
    provenance: {
      source: AA,
      tier: "external-benchmark",
      observedAt: "2026-09-01T00:00:00.000Z",
      normalizationVersion: "aa-normalization-v1",
      ...over.provenance,
    },
  };
}

function candidate(over: Partial<ModelCandidateInput> & { selector: string }): ModelCandidateInput {
  return {
    assistantId: "claude" as AssistantId,
    provider: "anthropic",
    identity: { basis: "catalog-exact", resolvedModelKey: `anthropic:${over.selector}`, evidence: "test" },
    filterFailures: [],
    advisories: [],
    evidence: {},
    ...over,
  };
}

const CLASSIFICATION: TaskClassification = {
  weights: { coding: 1, speed: 0, cost: 0 },
  signals: ["test"],
  taskKind: "coding",
};

const OPEN_GATE = { active: false, gates: [] };

/** A candidate with just enough evidence to be scored and win. */
const scorable = (selector: string) =>
  candidate({ selector, evidence: { coding: { priors: [prior({ value: 0.5 })] } } });

describe("classifyTask — deterministic, cheap, explainable", () => {
  it("is a pure function of the intent: the same intent always yields the same weights", () => {
    const intent = { goal: "Fix the failing auth test quickly", profile: "auto" as const, constraints: [] };
    const a = classifyTask(intent);
    const b = classifyTask(intent);
    expect(a).toEqual(b);
    expect(a.weights.coding + a.weights.speed + a.weights.cost).toBeCloseTo(1, 12);
  });

  it("starts from the profile and records every signal that moved it", () => {
    const quality = classifyTask({ goal: "Write the module", profile: "best-quality", constraints: [] });
    expect(quality.weights.coding).toBeGreaterThan(quality.weights.speed);
    expect(quality.signals).toContain("profile:best-quality");

    const cheap = classifyTask({ goal: "Do it on the cheapest model", profile: "lowest-tokens", constraints: [] });
    expect(cheap.weights.cost).toBeGreaterThan(cheap.weights.coding);
    expect(cheap.signals).toContain("cost sensitivity");
  });

  it("reads the constraints as well as the goal, and never emits a fourth dimension", () => {
    const urgent = classifyTask({ goal: "Ship the parser", profile: "auto", constraints: ["needed urgently"] });
    expect(urgent.signals).toContain("urgency");
    expect(Object.keys(urgent.weights).sort()).toEqual(["coding", "cost", "speed"]);
  });

  it("classifies the cohort's task kind with the vocabulary telemetry already uses", () => {
    expect(classifyTask({ goal: "Fix the bug", profile: "auto", constraints: [] }).taskKind).toBe("coding");
    expect(classifyTask({ goal: "Review this PR", profile: "auto", constraints: [] }).taskKind).toBe("review");
  });
});

describe("blending — w(n) = n / (n + k)", () => {
  it("satisfies the table: w(0) = 0, w(k) = 0.5, w(4k) = 0.8", () => {
    for (const k of Object.values(DIMENSION_K)) {
      expect(telemetryWeight(0, k)).toBe(0);
      expect(telemetryWeight(k, k)).toBeCloseTo(0.5, 12);
      expect(telemetryWeight(4 * k, k)).toBeCloseTo(0.8, 12);
    }
  });

  it("is monotone in n — but n itself can fall, so it is not monotone in time", () => {
    const k = DIMENSION_K.coding;
    expect(telemetryWeight(20, k)).toBeGreaterThan(telemetryWeight(10, k));
    // A rolling window that drops old runs takes the weight back down with it.
    const before = telemetryWeight(20, k);
    const afterWindowRolls = telemetryWeight(6, k);
    expect(afterWindowRolls).toBeLessThan(before);
    expect(afterWindowRolls).toBeCloseTo(6 / 16, 12);
  });

  it("applies score_d = w·telemetry + (1 − w)·prior", () => {
    const evidence: DimensionEvidence = {
      priors: [prior({ value: 0.66 })],
      telemetry: {
        value: 0.9,
        n: 10,
        metric: "success",
        cohort: { resolvedModelKey: "anthropic:m", taskKind: "coding", harnessMajor: "1", windowDays: 30 },
      },
    };
    const score = scoreDimension("coding", evidence);
    expect(score.weight).toBeCloseTo(0.5, 12);
    expect(score.score).toBeCloseTo(0.5 * 0.9 + 0.5 * 0.66, 12);
  });

  it("lets the prior carry a dimension alone when n = 0 — never a neutral 0.5", () => {
    const score = scoreDimension("coding", { priors: [prior({ value: 0.66 })] });
    expect(score.n).toBe(0);
    expect(score.weight).toBe(0);
    expect(score.score).toBeCloseTo(0.66, 12);
  });

  it("with a missing prior contributes telemetry·w and flags priorMissing", () => {
    const score = scoreDimension("speed", {
      priors: [],
      telemetry: {
        value: 0.8,
        n: 5,
        metric: "tok/s",
        cohort: { resolvedModelKey: "anthropic:m", taskKind: "coding", harnessMajor: "1", windowDays: 30 },
      },
    });
    expect(score.weight).toBeCloseTo(0.5, 12);
    expect(score.score).toBeCloseTo(0.4, 12);
    expect(score.missing).toBe("priorMissing:speed");
  });

  it("with no prior and n = 0 contributes nothing at all", () => {
    const score = scoreDimension("cost", { priors: [] });
    expect(score.score).toBeUndefined();
    expect(score.missing).toContain("contributes nothing");
  });
});

describe("prior selection — freshness, source ties, normalization versions", () => {
  it("keeps expired evidence visible but never selects it", () => {
    const expired = prior({ value: 0.99, freshness: "expired" });
    const fresh = prior({ value: 0.5 });
    const chosen = selectPrior("coding", [expired, fresh]);
    expect(chosen.chosen?.value).toBe(0.5);
    expect(chosen.excluded[0]?.reason).toContain("expired");
  });

  it("refuses to select anything when every row is expired", () => {
    const result = selectPrior("coding", [prior({ value: 0.9, freshness: "expired" })]);
    expect(result.chosen).toBeUndefined();
    expect(result.excluded).toHaveLength(1);
  });

  it("breaks a within-source tie on benchmark publishedAt, then observedAt", () => {
    const older = prior({
      value: 0.4,
      provenance: {
        source: AA, tier: "external-benchmark", normalizationVersion: "aa-normalization-v1",
        observedAt: "2026-09-01T00:00:00.000Z",
        benchmark: { release: "index-4.0", category: "coding", publishedAt: "2026-01-01" },
      },
    });
    const newer = prior({
      value: 0.7,
      provenance: {
        source: AA, tier: "external-benchmark", normalizationVersion: "aa-normalization-v1",
        observedAt: "2026-09-01T00:00:00.000Z",
        benchmark: { release: "index-4.3", category: "coding", publishedAt: "2026-06-01" },
      },
    });
    expect(selectPrior("coding", [older, newer]).chosen?.value).toBe(0.7);
    expect(selectPrior("coding", [newer, older]).chosen?.value).toBe(0.7);
  });

  it("lets the pinned primary source win over another source", () => {
    const other = prior({
      value: 0.99,
      provenance: {
        source: "manual", tier: "manual", observedAt: "2026-09-08T00:00:00.000Z",
        normalizationVersion: "aa-normalization-v1",
      },
    });
    const result = selectPrior("coding", [other, prior({ value: 0.3 })]);
    expect(result.chosen?.provenance.source).toBe(AA);
    expect(result.excluded.some((e) => e.reason.includes("pinned primary source"))).toBe(true);
  });

  it("never mixes normalization versions — the mismatched row is excluded, not rescaled", () => {
    const v2 = prior({
      value: 0.95,
      normalizationVersion: "aa-normalization-v2",
      provenance: {
        source: AA, tier: "external-benchmark", normalizationVersion: "aa-normalization-v2",
        observedAt: "2026-08-01T00:00:00.000Z",
        benchmark: { release: "index-4.0", category: "coding", publishedAt: "2026-01-01" },
      },
    });
    const v1 = prior({
      value: 0.5,
      provenance: {
        source: AA, tier: "external-benchmark", normalizationVersion: "aa-normalization-v1",
        observedAt: "2026-09-01T00:00:00.000Z",
        benchmark: { release: "index-4.3", category: "coding", publishedAt: "2026-06-01" },
      },
    });
    const result = selectPrior("coding", [v2, v1]);
    expect(result.chosen?.normalizationVersion).toBe("aa-normalization-v1");
    expect(result.excluded.some((e) => e.reason.includes("cannot be mixed"))).toBe(true);
  });
});

describe("selectModel — external evidence never grants eligibility", () => {
  it("excludes a hard-filtered candidate no matter how good its benchmark score is", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [
        candidate({
          selector: "brilliant",
          filterFailures: ["auth expired"],
          evidence: { coding: { priors: [prior({ value: 1 })] } },
        }),
        candidate({ selector: "ordinary", evidence: { coding: { priors: [prior({ value: 0.2 })] } } }),
      ],
    });
    expect(recommendation.recommended).toBe("claude/ordinary");
    const blocked = recommendation.candidates.find((c) => c.selector === "brilliant")!;
    expect(blocked.eligible).toBe(false);
    expect(blocked.total).toBeUndefined();
    expect(blocked.filterFailures).toEqual(["auth expired"]);
  });

  it("recommends nothing when no candidate has usable evidence", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [candidate({ selector: "a" }), candidate({ selector: "b" })],
    });
    expect(recommendation.recommended).toBeUndefined();
    expect(recommendation.missingEvidence).toHaveLength(3);
    expect(recommendation.reason).toContain("no candidate has any usable evidence");
  });

  it("is SHADOW while the gate is closed, and commits nothing", () => {
    const shadow = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [scorable("a")],
      chosenAssistantId: "claude" as AssistantId,
    });
    expect(shadow.mode).toBe("shadow");
    expect(shadow.applied).toBeUndefined();
    expect(shadow.execution.decidedBy).toBe("unchanged");
  });

  it("commits the winner onto the chosen assistant once every gate passes", () => {
    const applied = selectModel({
      classification: CLASSIFICATION,
      activation: { active: true, gates: [] },
      candidates: [scorable("a")],
      chosenAssistantId: "claude" as AssistantId,
    });
    expect(applied.mode).toBe("applied");
    expect(applied.applied).toEqual({ assistantId: "claude", selector: "a", label: "claude/a" });
    // The commitment IS the selector execution will request (CR-33's input).
    expect(applied.execution).toEqual({
      authority: "ExecutionRequest.model",
      requestedModelSelector: "a",
      decidedBy: "k13-recommendation",
      detail: expect.stringContaining("commits claude/a"),
    });
  });

  it("stays advisory when the winner is not on the assistant this decision chose", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: { active: true, gates: [] },
      candidates: [scorable("a")],
      chosenAssistantId: "codex" as AssistantId,
    });
    expect(recommendation.recommended).toBe("claude/a");
    expect(recommendation.mode).toBe("shadow");
    expect(recommendation.applied).toBeUndefined();
    expect(recommendation.execution.detail).toContain("not on the assistant this decision chose");
  });

  it("never commits over the operator's own model, however open the gate is", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: { active: true, gates: [] },
      candidates: [scorable("a")],
      chosenAssistantId: "claude" as AssistantId,
      userOverride: { selector: "b" },
      requestedModelSelector: "b",
    });
    expect(recommendation.mode).toBe("shadow");
    expect(recommendation.applied).toBeUndefined();
    expect(recommendation.execution).toMatchObject({
      requestedModelSelector: "b",
      decidedBy: "operator-override",
    });
  });

  it("records the requested selector so an audit sees execution was untouched", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [candidate({ selector: "a", evidence: { coding: { priors: [prior({ value: 0.5 })] } } })],
      requestedModelSelector: "b",
    });
    expect(recommendation.execution).toMatchObject({
      requestedModelSelector: "b",
      authority: "ExecutionRequest.model",
      decidedBy: "unchanged",
    });
    expect(recommendation.applied).toBeUndefined();
  });

  it("carries a withheld-telemetry reason instead of a partial metric", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [
        candidate({
          selector: "a",
          evidence: {
            coding: { priors: [prior({ value: 0.5 })], telemetryWithheld: "no verification-pass evidence" },
          },
        }),
      ],
    });
    const coding = recommendation.candidates[0]!.dimensions.find((d) => d.dimension === "coding")!;
    expect(coding.telemetry).toBeUndefined();
    expect(coding.telemetryWithheld).toBe("no verification-pass evidence");
    // The prior carries the dimension alone — no manufactured neutral value.
    expect(coding.score).toBe(0.5);
  });
});

describe("telemetry weight versus prior gap", () => {
  const k = DIMENSION_K.coding;
  const cohort = { resolvedModelKey: "anthropic:x", taskKind: "coding", harnessMajor: "1", windowDays: 30 };

  /** Prior-best candidate A vs. prior-worse B, with B holding better telemetry. */
  const pair = (n: number, priorA: number, priorB: number, telemetryA: number, telemetryB: number) =>
    selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      candidates: [
        candidate({
          selector: "a",
          evidence: {
            coding: { priors: [prior({ value: priorA })], telemetry: { value: telemetryA, n, metric: "success", cohort } },
          },
        }),
        candidate({
          selector: "b",
          evidence: {
            coding: { priors: [prior({ value: priorB })], telemetry: { value: telemetryB, n, metric: "success", cohort } },
          },
        }),
      ],
    });

  it("a sufficient telemetry gap at n > k reverses a prior-best ranking", () => {
    // With no telemetry the prior alone would pick A (0.9 > 0.6).
    expect(pair(0, 0.9, 0.6, 0.1, 1.0).recommended).toBe("claude/a");
    // At n = 4k the weight is 0.8 and the telemetry gap (0.9) outweighs the
    // prior gap (0.3), so B wins.
    expect(pair(4 * k, 0.9, 0.6, 0.1, 1.0).recommended).toBe("claude/b");
  });

  it("weight alone does not guarantee reversal: an insufficient gap leaves the prior-best winner", () => {
    // Same weight (n = 4k), but now the telemetry gap (0.05) is far smaller
    // than the prior gap (0.5). Greater telemetry weight does NOT flip it.
    const result = pair(4 * k, 0.95, 0.45, 0.80, 0.85);
    expect(result.recommended).toBe("claude/a");
  });

  it("a falling rolling window takes the telemetry weight back down with it", () => {
    const wide = pair(4 * k, 0.9, 0.6, 0.1, 1.0);
    const narrowed = pair(1, 0.9, 0.6, 0.1, 1.0);
    const w = (r: typeof wide) => r.candidates[0]!.dimensions.find((d) => d.dimension === "coding")!.weight;
    expect(w(narrowed)).toBeLessThan(w(wide));
    // …and with the window narrowed, the prior-best candidate is back on top.
    expect(narrowed.recommended).toBe("claude/a");
  });
});

describe("user override is intent, applied as a filter", () => {
  it("reports an unavailable override truthfully and substitutes nothing for it", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      userOverride: { selector: "banned" },
      candidates: [
        candidate({
          selector: "banned",
          filterFailures: ["quota exhausted"],
          evidence: { coding: { priors: [prior({ value: 0.9 })] } },
        }),
      ],
    });
    expect(recommendation.userOverride?.satisfied).toBe(false);
    expect(recommendation.userOverride?.detail).toContain("no substitute");
    expect(recommendation.recommended).toBeUndefined();
  });

  it("reports a satisfied override", () => {
    const recommendation = selectModel({
      classification: CLASSIFICATION,
      activation: OPEN_GATE,
      userOverride: { selector: "chosen" },
      candidates: [candidate({ selector: "chosen", evidence: { coding: { priors: [prior({ value: 0.5 })] } } })],
    });
    expect(recommendation.userOverride?.satisfied).toBe(true);
    expect(recommendation.recommended).toBe("claude/chosen");
  });
});

describe("activation gate — fail-closed", () => {
  const NOW = new Date("2026-09-09T00:00:00.000Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  const allPassing = (): ActivationGateInput => ({
    configEnabled: true,
    candidatesAtOrAboveK: 2,
    shadowLogSince: ago(30 * 86_400_000),
    shadowReviewedAt: ago(2 * 86_400_000),
    egressVerifiedAt: ago(86_400_000),
    hardFilterViolations: 0,
    now: NOW,
  });

  it("activates only when every gate passes", () => {
    const result = evaluateActivationGate(allPassing());
    expect(result.active).toBe(true);
    expect(result.gates.every((g) => g.passed)).toBe(true);
  });

  it("is closed by default: an empty workspace activates nothing", () => {
    const result = evaluateActivationGate({
      configEnabled: false,
      candidatesAtOrAboveK: 0,
      hardFilterViolations: 0,
      now: NOW,
    });
    expect(result.active).toBe(false);
    // Only the "nothing bad has happened yet" gate can pass on an empty
    // workspace; every gate that requires positive evidence fails.
    expect(result.gates.filter((g) => g.passed).map((g) => g.name)).toEqual(["no-filter-violations"]);
  });

  it.each([
    ["config", { configEnabled: false }],
    ["telemetry", { candidatesAtOrAboveK: 1 }],
    ["shadow-reviewed", { shadowReviewedAt: undefined }],
    ["no-filter-violations", { hardFilterViolations: 1 }],
    ["egress-verified", { egressVerifiedAt: undefined }],
  ])("fails closed when the %s gate alone is missing", (name, override) => {
    const result = evaluateActivationGate({ ...allPassing(), ...override });
    expect(result.active).toBe(false);
    expect(result.gates.find((g) => g.name === name)?.passed).toBe(false);
    // Every OTHER gate still passes — the failure is attributable to one gate.
    expect(result.gates.filter((g) => !g.passed).map((g) => g.name)).toEqual([name]);
  });

  it("fails closed when the shadow log is younger than a week", () => {
    const result = evaluateActivationGate({ ...allPassing(), shadowLogSince: ago(3 * 86_400_000) });
    expect(result.active).toBe(false);
    // A short log necessarily invalidates the review attestation too: nobody can
    // have reviewed a week of a three-day log. Both failures are named.
    expect(result.gates.filter((g) => !g.passed).map((g) => g.name)).toEqual(["shadow-week", "shadow-reviewed"]);
  });

  it("counts the shadow week on a fake clock, not on wall time", () => {
    const sixDays = evaluateActivationGate({
      ...allPassing(),
      shadowLogSince: ago(SHADOW_REVIEW_WINDOW_MS - 1),
      shadowReviewedAt: NOW.toISOString(),
    });
    expect(sixDays.gates.find((g) => g.name === "shadow-week")?.passed).toBe(false);

    const sevenDays = evaluateActivationGate({
      ...allPassing(),
      shadowLogSince: ago(SHADOW_REVIEW_WINDOW_MS),
      shadowReviewedAt: NOW.toISOString(),
    });
    expect(sevenDays.gates.find((g) => g.name === "shadow-week")?.passed).toBe(true);
    expect(sevenDays.active).toBe(true);
  });

  it("rejects a review signed before the log had a full week in it", () => {
    const result = evaluateActivationGate({
      ...allPassing(),
      shadowLogSince: ago(8 * 86_400_000),
      // Signed one day into an eight-day log: it cannot have reviewed a week.
      shadowReviewedAt: ago(7 * 86_400_000),
    });
    expect(result.gates.find((g) => g.name === "shadow-reviewed")?.passed).toBe(false);
  });

  it("expires stale attestations rather than trusting them forever", () => {
    const result = evaluateActivationGate({
      ...allPassing(),
      egressVerifiedAt: ago(ATTESTATION_TTL_MS + 1),
    });
    expect(result.gates.find((g) => g.name === "egress-verified")?.passed).toBe(false);
    expect(result.active).toBe(false);
  });

  it("treats an unparseable or future attestation as a failure, never a pass", () => {
    expect(evaluateActivationGate({ ...allPassing(), egressVerifiedAt: "not a date" }).active).toBe(false);
    expect(
      evaluateActivationGate({ ...allPassing(), egressVerifiedAt: new Date(NOW.getTime() + 86_400_000).toISOString() })
        .active,
    ).toBe(false);
  });
});
