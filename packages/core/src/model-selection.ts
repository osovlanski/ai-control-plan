import type { AssistantId } from "./ids.js";
import type { Freshness, Provenance } from "./model-catalog.js";
import type { TaskIntent } from "./scheduler.js";

/**
 * K13 — conservative model selection (agentic-os-kernel-services §4.4.3).
 *
 * Pure kernel: classification, hard-filter arithmetic, blending and the
 * activation gate. Every number that reaches a score arrives with its own
 * provenance (I-M1) and nothing here fetches, queries or decides eligibility —
 * eligibility is decided by the filters the caller already ran and hands in.
 *
 * SHADOW IS THE DEFAULT AND THE ONLY MODE THAT SHIPS ENABLED. Nothing in this
 * file writes `ExecutionRequest.model` or `RunSpec.model`; CR-33 keeps
 * `ExecutionRequest.model` the single requested-selector authority, and a
 * recommendation only ever becomes one through an accepted routing decision.
 */

/** The three dimensions revision 1 can honestly score (§4.4.3). */
export type TaskDimension = "coding" | "speed" | "cost";
export const TASK_DIMENSIONS: readonly TaskDimension[] = ["coding", "speed", "cost"] as const;

/**
 * `k_d` — the telemetry half-life: at `n = k` own telemetry and the prior weigh
 * the same. Coding needs more evidence than speed or cost because its metric is
 * a rate over noisier outcomes (§4.4.3).
 */
export const DIMENSION_K: Record<TaskDimension, number> = { coding: 10, speed: 5, cost: 5 };

/**
 * Execution-harness major version. Telemetry from two majors is not comparable
 * (the execution model itself changed), so a cohort never spans them. Bumped
 * deliberately, and NEVER backfilled onto rows recorded before it existed —
 * those rows simply never join a cohort, exactly like `model_resolved = unknown`.
 */
export const HARNESS_MAJOR = "1";

/** How the candidate's runtime selector was bound to a catalog model identity. */
export type CandidateIdentityBasis =
  /** The selector IS a catalog model id for this provider — no resolution needed. */
  | "catalog-exact"
  /** This workspace's own runs prove the selector resolved to exactly one model. */
  | "observed-resolution"
  /** Nothing proves what this selector resolves to. Priors may not attach. */
  | "unresolved";

/**
 * The K13 candidate identity contract (§1 of the K13 brief).
 *
 * A candidate is `assistant + runtime model selector`. A benchmark prior may
 * attach ONLY when that pair is bound to a catalog identity by proof — an exact
 * provider-scoped model id, or this workspace's own provider-reported
 * resolutions. An alias table is NOT proof: `opus` is a moving CLI alias, and
 * resolving it against today's catalog is exactly what I-M5 forbids. Unbound is
 * a valid, common state; it yields `priorMissing`, never a guess.
 */
export interface CandidateIdentity {
  basis: CandidateIdentityBasis;
  /** `provider:modelId`, present only when `basis !== "unresolved"`. */
  resolvedModelKey?: string;
  /** Human-readable proof, persisted in the explanation. */
  evidence: string;
  /**
   * Execution configuration in force for this candidate (reasoning effort,
   * sandbox mode…). A prior benchmarked at a different configuration is not
   * evidence about this candidate, so any non-empty settings block prior
   * attachment unless the prior declares the same configuration.
   */
  executionSettings?: Record<string, string | number | boolean>;
}

/** One prior offered to a dimension, with everything needed to audit it (I-M1). */
export interface DimensionPrior {
  value: number;
  normalizationVersion: string;
  provenance: Provenance;
  freshness: Freshness;
  /** The untouched source measurement behind `value`. */
  raw?: { metric: string; value: number; unit: string };
}

/** One own-telemetry measurement for a dimension, with its cohort size. */
export interface DimensionTelemetry {
  value: number;
  /** Cohort size — runs with the same resolved model, task kind and harness major, in-window. */
  n: number;
  /** The exact metric this number is, so it is never mistaken for the prior's. */
  metric: string;
  cohort: TelemetryCohortKey;
}

export interface TelemetryCohortKey {
  resolvedModelKey: string;
  taskKind: string;
  harnessMajor: string;
  windowDays: number;
}

/** What the caller offers per candidate per dimension, before any blending. */
export interface DimensionEvidence {
  /** Every prior row the caller found, including expired and mismatched ones. */
  priors: DimensionPrior[];
  telemetry?: DimensionTelemetry;
}

export interface ModelCandidateInput {
  assistantId: AssistantId;
  provider: string;
  /** The runtime model selector, exactly as the assistant advertises it. */
  selector: string;
  identity: CandidateIdentity;
  /**
   * Named hard-filter failures. Non-empty = ineligible, full stop: no score is
   * computed and no benchmark number can resurrect it (I-M2).
   */
  filterFailures: string[];
  /**
   * Named observations that are NOT exclusions — an unknown context window when
   * the task declared no minimum, for instance. Advisory by §4.4.3: recorded and
   * shown, never used to exclude.
   */
  advisories: string[];
  evidence: Partial<Record<TaskDimension, DimensionEvidence>>;
}

export interface TaskClassification {
  /** Weights over the three dimensions, summing to 1. */
  weights: Record<TaskDimension, number>;
  /** The deterministic signals that produced them, in match order. */
  signals: string[];
  taskKind: string;
}

/** Per-dimension arithmetic, fully reconstructible from what is persisted. */
export interface DimensionScore {
  dimension: TaskDimension;
  k: number;
  n: number;
  weight: number;
  telemetry?: { value: number; metric: string; cohort: TelemetryCohortKey };
  prior?: {
    value: number;
    normalizationVersion: string;
    source: string;
    tier: string;
    observedAt: string;
    benchmarkRelease?: string;
    benchmarkPublishedAt?: string;
    freshness: Freshness;
    raw?: { metric: string; value: number; unit: string };
    /** Why this row won among several. */
    selectedBecause: string;
  };
  /** Prior rows the caller offered that selection refused, and why. */
  excludedPriors: Array<{ source: string; reason: string }>;
  /** `w·telemetry + (1−w)·prior`, or `w·telemetry` with no prior. */
  score?: number;
  /** Set when the dimension could not produce a number at all. */
  missing?: string;
}

export interface CandidateScore {
  assistantId: AssistantId;
  selector: string;
  /** `assistant/selector` — how the recommendation is named to a human. */
  label: string;
  identity: CandidateIdentity;
  eligible: boolean;
  filterFailures: string[];
  advisories: string[];
  dimensions: DimensionScore[];
  /** Weighted mean over the dimensions that actually contributed. Absent = no evidence. */
  total?: number;
  /** Sum of the classification weights of the contributing dimensions. */
  evidenceCoverage: number;
}

export interface ModelRecommendation {
  schemaVersion: 1;
  /** SHADOW is the only value this revision ever writes (§4.4.3, K13 gate). */
  mode: "shadow" | "applied";
  classification: TaskClassification;
  candidates: CandidateScore[];
  /** `assistant/selector` of the winner. Absent when nothing could be scored. */
  recommended?: string;
  /** Why the winner won, or why there is none. */
  reason: string;
  tieBreaker?: string;
  /** Dimensions with no usable evidence for any candidate. */
  missingEvidence: string[];
  /** Present when the operator named a model: intent, applied as a filter. */
  userOverride?: { selector: string; assistantId?: string; satisfied: boolean; detail: string };
  /** Why this is shadow — every gate, so "why not active" is readable. */
  activation: ActivationGateResult;
  /**
   * The requested selector the execution path will actually use, copied here so
   * an audit can see that the recommendation changed nothing (CR-33).
   */
  executionUnchanged: { requestedModelSelector?: string; authority: "ExecutionRequest.model" };
}

// --- classification ---------------------------------------------------------

/**
 * Base weights per routing profile. The profile is the operator's own standing
 * statement about what matters, so it is the starting point; goal text only
 * nudges it.
 */
const PROFILE_WEIGHTS: Record<string, Record<TaskDimension, number>> = {
  auto: { coding: 0.5, speed: 0.25, cost: 0.25 },
  "best-quality": { coding: 0.8, speed: 0.1, cost: 0.1 },
  fastest: { coding: 0.25, speed: 0.6, cost: 0.15 },
  "lowest-tokens": { coding: 0.25, speed: 0.15, cost: 0.6 },
  "preserve-quota": { coding: 0.3, speed: 0.15, cost: 0.55 },
};

/**
 * Deterministic goal/constraint signals. Fixed patterns, fixed increments,
 * evaluated in this order — no LLM call, no scoring model, no I/O, and the same
 * text always produces the same weights (§2 of the K13 brief).
 */
const SIGNALS: Array<{ name: string; test: RegExp; add: Partial<Record<TaskDimension, number>> }> = [
  { name: "coding verbs", test: /\b(fix|implement|refactor|bug|patch|migrate|build|compile|test)\b/, add: { coding: 0.2 } },
  { name: "review verbs", test: /\b(review|audit|critique)\b/, add: { coding: 0.1 } },
  { name: "urgency", test: /\b(urgent|urgently|asap|quick|quickly|fast|immediate|immediately)\b/, add: { speed: 0.2 } },
  { name: "cost sensitivity", test: /\b(cheap|cheapest|budget|cost|inexpensive|token[- ]efficient)\b/, add: { cost: 0.2 } },
  { name: "quota sensitivity", test: /\b(quota|headroom|preserve)\b/, add: { cost: 0.1 } },
];

/**
 * Deterministic, cheap and explainable task classification over the three K13
 * dimensions. Pure function of the durable intent — same intent, same weights,
 * forever, with the matched signals persisted alongside them.
 */
export function classifyTask(intent: Pick<TaskIntent, "goal" | "profile" | "constraints">): TaskClassification {
  const base = PROFILE_WEIGHTS[intent.profile] ?? PROFILE_WEIGHTS.auto!;
  const weights: Record<TaskDimension, number> = { ...base };
  const signals = [`profile:${intent.profile}`];
  const text = [intent.goal, ...(intent.constraints ?? [])].join(" ").toLowerCase();

  for (const signal of SIGNALS) {
    if (!signal.test.test(text)) continue;
    signals.push(signal.name);
    for (const [dimension, add] of Object.entries(signal.add)) {
      weights[dimension as TaskDimension] += add;
    }
  }

  const total = TASK_DIMENSIONS.reduce((sum, d) => sum + weights[d], 0);
  for (const d of TASK_DIMENSIONS) weights[d] = weights[d] / total;
  return { weights, signals, taskKind: classifyTaskKind(intent.goal) };
}

/**
 * The cohort key's task kind. Deliberately the SAME vocabulary the assistant-level
 * telemetry already uses, so a K13 cohort and an assistant score never disagree
 * about what kind of work a task was (I-M4's rule, applied to task filtering).
 */
export function classifyTaskKind(goal: string): "coding" | "review" | "research" | "general" {
  const text = goal.toLowerCase();
  if (/\breview|audit|critique\b/.test(text)) return "review";
  if (/\bfix|implement|refactor|add|bug|test|build|migrate\b/.test(text)) return "coding";
  if (/\bresearch|investigate|compare|explain|why\b/.test(text)) return "research";
  return "general";
}

// --- blending ---------------------------------------------------------------

/**
 * `w(n) = n / (n + k)` — monotone in `n`, NOT in time: the window rolls, so `n`
 * and therefore `w` can fall (§4.4.3, "what the rule does not guarantee").
 */
export function telemetryWeight(n: number, k: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / (n + k);
}

/** Prior sources in pinned precedence order. K8 ships exactly one benchmark source. */
export const PRIMARY_PRIOR_SOURCE: Record<TaskDimension, string> = {
  coding: "external:artificial-analysis",
  speed: "external:artificial-analysis",
  // Cost's prior is K7 price evidence, never an external benchmark's pricing (§4, K13 brief).
  cost: "k7:price-evidence",
};

/**
 * Choose the one prior row a dimension may use.
 *
 * Order: expired rows are dropped (visible, never selected); rows whose
 * `normalizationVersion` disagrees with the pinned primary source's are dropped
 * (never mixed); the pinned primary source wins over any other; within a source
 * the tie breaks on `benchmark.publishedAt` then `observedAt`, descending and
 * deterministically.
 */
export function selectPrior(
  dimension: TaskDimension,
  priors: DimensionPrior[],
): { chosen?: DimensionPrior; reason: string; excluded: Array<{ source: string; reason: string }> } {
  const excluded: Array<{ source: string; reason: string }> = [];
  const live = priors.filter((p) => {
    if (p.freshness === "expired") {
      excluded.push({ source: String(p.provenance.source), reason: "expired external evidence is shown but never selected" });
      return false;
    }
    return true;
  });
  if (live.length === 0) return { reason: "no usable prior", excluded };

  const primary = PRIMARY_PRIOR_SOURCE[dimension];
  const preferred = live.filter((p) => p.provenance.source === primary);
  const pool = preferred.length > 0 ? preferred : live;
  for (const p of live) {
    if (!pool.includes(p)) {
      excluded.push({ source: String(p.provenance.source), reason: `not the pinned primary source for ${dimension} (${primary})` });
    }
  }

  // Never mix normalization versions: the pool's newest row pins the version,
  // and anything normalized differently is excluded rather than rescaled.
  const ordered = [...pool].sort(comparePriors);
  const pinnedVersion = ordered[0]!.normalizationVersion;
  const compatible: DimensionPrior[] = [];
  for (const p of ordered) {
    if (p.normalizationVersion === pinnedVersion) compatible.push(p);
    else {
      excluded.push({
        source: String(p.provenance.source),
        reason: `normalizationVersion ${p.normalizationVersion} cannot be mixed with ${pinnedVersion}`,
      });
    }
  }

  const chosen = compatible[0]!;
  const sameSource = compatible.filter((p) => p.provenance.source === chosen.provenance.source).length;
  const reason =
    preferred.length > 0 && pool === preferred
      ? sameSource > 1
        ? `pinned primary source ${primary}; newest by benchmark publishedAt then observedAt`
        : `pinned primary source ${primary}`
      : `only source available; newest by benchmark publishedAt then observedAt`;
  return { chosen, reason, excluded };
}

/** Deterministic total order: publishedAt desc, then observedAt desc, then source. */
function comparePriors(a: DimensionPrior, b: DimensionPrior): number {
  const ap = a.provenance.benchmark?.publishedAt ?? "";
  const bp = b.provenance.benchmark?.publishedAt ?? "";
  if (ap !== bp) return bp.localeCompare(ap);
  if (a.provenance.observedAt !== b.provenance.observedAt) {
    return b.provenance.observedAt.localeCompare(a.provenance.observedAt);
  }
  return String(a.provenance.source).localeCompare(String(b.provenance.source));
}

/**
 * `score_d = w(n_d)·telemetry_d + (1 − w(n_d))·prior_d`.
 *
 * With no prior the dimension contributes `telemetry_d · w(n_d)` and is flagged
 * `priorMissing:<d>`; at `n = 0` that is 0 — the dimension contributes nothing
 * and cannot decide. Missing data is NEVER normalized into a neutral 0.5.
 */
export function scoreDimension(dimension: TaskDimension, evidence: DimensionEvidence | undefined): DimensionScore {
  const k = DIMENSION_K[dimension];
  const telemetry = evidence?.telemetry;
  const n = telemetry?.n ?? 0;
  const weight = telemetryWeight(n, k);
  const { chosen, reason, excluded } = selectPrior(dimension, evidence?.priors ?? []);

  const score: DimensionScore = {
    dimension,
    k,
    n,
    weight,
    excludedPriors: excluded,
    ...(telemetry ? { telemetry: { value: telemetry.value, metric: telemetry.metric, cohort: telemetry.cohort } } : {}),
    ...(chosen
      ? {
          prior: {
            value: chosen.value,
            normalizationVersion: chosen.normalizationVersion,
            source: String(chosen.provenance.source),
            tier: chosen.provenance.tier,
            observedAt: chosen.provenance.observedAt,
            ...(chosen.provenance.benchmark?.release ? { benchmarkRelease: chosen.provenance.benchmark.release } : {}),
            ...(chosen.provenance.benchmark?.publishedAt ? { benchmarkPublishedAt: chosen.provenance.benchmark.publishedAt } : {}),
            freshness: chosen.freshness,
            ...(chosen.raw ? { raw: chosen.raw } : {}),
            selectedBecause: reason,
          },
        }
      : {}),
  };

  if (chosen && telemetry) {
    score.score = weight * telemetry.value + (1 - weight) * chosen.value;
    return score;
  }
  if (chosen) {
    // n = 0, so w = 0 and the prior carries the dimension alone.
    score.score = chosen.value;
    return score;
  }
  if (telemetry) {
    score.score = weight * telemetry.value;
    score.missing = `priorMissing:${dimension}`;
    if (weight === 0) score.missing = `priorMissing:${dimension} and no telemetry — contributes nothing`;
    return score;
  }
  score.missing = `priorMissing:${dimension} and no telemetry — contributes nothing`;
  return score;
}

// --- selection --------------------------------------------------------------

export interface SelectModelInput {
  classification: TaskClassification;
  candidates: ModelCandidateInput[];
  /** The operator's explicit model intent, already applied as a filter upstream. */
  userOverride?: { selector: string; assistantId?: string };
  activation: ActivationGateResult;
  /** What the execution path will actually request — recorded, never written. */
  requestedModelSelector?: string;
}

/**
 * Compute a model recommendation. ADVISORY: the returned object is persisted
 * inside the routing explanation and changes nothing about execution while
 * `activation.active` is false — which is the shipped default (§11 of the K13
 * brief). Hard filters have already run; this function never revisits them and
 * cannot make an ineligible candidate eligible.
 */
export function selectModel(input: SelectModelInput): ModelRecommendation {
  const { classification } = input;
  const candidates: CandidateScore[] = input.candidates.map((c) => {
    const eligible = c.filterFailures.length === 0;
    const dimensions = TASK_DIMENSIONS.map((d) => scoreDimension(d, c.evidence[d]));
    let weighted = 0;
    let coverage = 0;
    for (const dimension of dimensions) {
      if (dimension.score === undefined) continue;
      const w = classification.weights[dimension.dimension];
      weighted += w * dimension.score;
      coverage += w;
    }
    return {
      assistantId: c.assistantId,
      selector: c.selector,
      label: `${c.assistantId}/${c.selector}`,
      identity: c.identity,
      eligible,
      filterFailures: c.filterFailures,
      advisories: c.advisories,
      dimensions,
      // Only the dimensions that actually produced a number are averaged. A
      // dimension with no evidence is absent from BOTH sides of the ratio
      // rather than being folded in as a neutral value.
      ...(eligible && coverage > 0 ? { total: weighted / coverage } : {}),
      evidenceCoverage: coverage,
    };
  });

  const scored = candidates
    .filter((c) => c.eligible && c.total !== undefined)
    // Deterministic total order: score desc, then evidence coverage desc, then label.
    .sort((a, b) => b.total! - a.total! || b.evidenceCoverage - a.evidenceCoverage || a.label.localeCompare(b.label));

  const missingEvidence = TASK_DIMENSIONS.filter((d) =>
    candidates.every((c) => c.dimensions.find((x) => x.dimension === d)?.score === undefined),
  ).map((d) => `no usable ${d} evidence for any candidate`);

  const winner = scored[0];
  const runnerUp = scored[1];
  const reason = winner
    ? `highest blended score ${winner.total!.toFixed(3)} over ${winner.dimensions.filter((d) => d.score !== undefined).map((d) => d.dimension).join(", ")}`
    : candidates.some((c) => c.eligible)
      ? "no candidate has any usable evidence — nothing is recommended"
      : "no eligible candidate";

  return {
    schemaVersion: 1,
    mode: input.activation.active ? "applied" : "shadow",
    classification,
    candidates,
    ...(winner ? { recommended: winner.label } : {}),
    reason,
    ...(winner && runnerUp
      ? {
          tieBreaker:
            winner.total! === runnerUp.total!
              ? winner.evidenceCoverage === runnerUp.evidenceCoverage
                ? `tied with ${runnerUp.label} on score and coverage; won on stable label order`
                : `tied with ${runnerUp.label} on score; won on wider evidence coverage`
              : `over ${runnerUp.label} (${runnerUp.total!.toFixed(3)})`,
        }
      : {}),
    missingEvidence,
    ...(input.userOverride
      ? {
          userOverride: {
            selector: input.userOverride.selector,
            ...(input.userOverride.assistantId ? { assistantId: input.userOverride.assistantId } : {}),
            satisfied: candidates.some((c) => c.selector === input.userOverride!.selector && c.eligible),
            detail: candidates.some((c) => c.selector === input.userOverride!.selector && c.eligible)
              ? "the named model passed every hard filter"
              : "the named model is unavailable or incompatible — no substitute is chosen for it",
          },
        }
      : {}),
    activation: input.activation,
    executionUnchanged: {
      ...(input.requestedModelSelector ? { requestedModelSelector: input.requestedModelSelector } : {}),
      authority: "ExecutionRequest.model",
    },
  };
}

// --- activation gate --------------------------------------------------------

export interface ActivationGate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ActivationGateResult {
  /** TRUE only when EVERY gate passed. Fail-closed by construction. */
  active: boolean;
  gates: ActivationGate[];
}

export interface ActivationGateInput {
  /** `models.selection.enabled`. Default false; nothing else can imply it. */
  configEnabled: boolean;
  /** Candidates whose resolved per-model cohort reached `k` on some dimension. */
  candidatesAtOrAboveK: number;
  /** Earliest persisted shadow recommendation, ISO. Absent = no shadow log yet. */
  shadowLogSince?: string;
  /** Operator attestation that the shadow log was reviewed, ISO. */
  shadowReviewedAt?: string;
  /** Operator/CI attestation that the K8 egress + security test was green, ISO. */
  egressVerifiedAt?: string;
  /** Recommendations that named a candidate which had failed a hard filter. */
  hardFilterViolations: number;
  now: Date;
}

export const SHADOW_REVIEW_WINDOW_MS = 7 * 24 * 3600_000;
/** An attestation older than this is not evidence about today's build. */
export const ATTESTATION_TTL_MS = 30 * 24 * 3600_000;

/**
 * The §4.4.3 activation gate, fail-closed: every gate must pass, and an
 * unknown, unparseable or absent input is a failure, never a pass. The result
 * is persisted inside every shadow recommendation so "why is this still
 * shadow?" is answered by the record itself.
 */
export function evaluateActivationGate(input: ActivationGateInput): ActivationGateResult {
  const nowMs = input.now.getTime();
  const age = (iso: string | undefined): number | undefined => {
    if (!iso) return undefined;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? nowMs - parsed : undefined;
  };

  const shadowAge = age(input.shadowLogSince);
  const reviewAge = age(input.shadowReviewedAt);
  const egressAge = age(input.egressVerifiedAt);

  const gates: ActivationGate[] = [
    {
      name: "config",
      passed: input.configEnabled === true,
      detail: input.configEnabled
        ? "models.selection.enabled is explicitly true"
        : "models.selection.enabled is false (the shipped default)",
    },
    {
      name: "telemetry",
      passed: input.candidatesAtOrAboveK >= 2,
      detail: `${input.candidatesAtOrAboveK} candidate(s) have resolved per-model telemetry at or above k; a pair (2) is required`,
    },
    {
      name: "shadow-week",
      passed: shadowAge !== undefined && shadowAge >= SHADOW_REVIEW_WINDOW_MS,
      detail:
        shadowAge === undefined
          ? "no shadow recommendation has been recorded yet"
          : `the shadow log spans ${Math.floor(shadowAge / 86_400_000)} day(s); 7 are required`,
    },
    {
      name: "shadow-reviewed",
      passed:
        reviewAge !== undefined &&
        reviewAge >= 0 &&
        reviewAge <= ATTESTATION_TTL_MS &&
        shadowAge !== undefined &&
        // The review must have looked at a full week of log, not at a log that
        // only reached a week AFTER someone signed it off.
        shadowAge - reviewAge >= SHADOW_REVIEW_WINDOW_MS,
      detail:
        reviewAge === undefined
          ? "models.selection.shadowReviewedAt is not set — no operator has attested to reviewing the shadow log"
          : reviewAge < 0
            ? "models.selection.shadowReviewedAt is in the future"
            : reviewAge > ATTESTATION_TTL_MS
              ? "the shadow-log review attestation is older than 30 days"
              : shadowAge === undefined || shadowAge - reviewAge < SHADOW_REVIEW_WINDOW_MS
                ? "the attested review predates a full week of shadow log"
                : "an operator attested to reviewing at least one week of shadow log",
    },
    {
      name: "no-filter-violations",
      passed: input.hardFilterViolations === 0,
      detail:
        input.hardFilterViolations === 0
          ? "no recorded shadow recommendation named a hard-filtered candidate"
          : `${input.hardFilterViolations} recorded recommendation(s) named a hard-filtered candidate`,
    },
    {
      name: "egress-verified",
      passed: egressAge !== undefined && egressAge >= 0 && egressAge <= ATTESTATION_TTL_MS,
      detail:
        egressAge === undefined
          ? "models.selection.egressVerifiedAt is not set — the K8 egress/security test is not attested"
          : egressAge < 0
            ? "models.selection.egressVerifiedAt is in the future"
            : egressAge > ATTESTATION_TTL_MS
              ? "the egress/security attestation is older than 30 days"
              : "the K8 egress/security test is attested green",
    },
  ];

  return { active: gates.every((g) => g.passed), gates };
}
