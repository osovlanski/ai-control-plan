import type { AssistantId } from "./ids.js";
import type { EvidenceSource } from "./capabilities.js";

/**
 * M12 model catalog + execution identity (agentic-os-kernel-services §4.4).
 *
 * Every number here carries its own provenance (I-M1): who observed it, how,
 * when, and under which normalization. Nothing in K7 flattens evidence into an
 * untraceable score — benchmark ingestion (K8) and scoring (K13) are not
 * implemented and must not be inferred from these types.
 */

/** How the fact was obtained. `manual` = transcribed by a human from a published page. */
export type EvidenceTier = "measured-own" | "provider-official" | "external-benchmark" | "manual";

export type Freshness = "live" | "fresh" | "stale" | "expired";

/**
 * External benchmark sources, namespaced so they never collide with the
 * capability-negotiation `EvidenceSource` enum. K8 adds exactly one
 * (`external:artificial-analysis`); the architecture requires one source to
 * prove value before a second is fetched (§5.3 K8).
 */
export type ExternalEvidenceSource = "external:artificial-analysis";

/**
 * K13's own source label for the cost prior: K7 price evidence re-normalized
 * into a 0..1 prior for selection. Deliberately NOT an `ExternalEvidenceSource`
 * — a benchmark's published pricing is never price authority (§4.4.5) — and
 * deliberately distinguishable from the underlying `manual`/`provider-api` row
 * it was derived from, whose own provenance rides along unchanged.
 */
export type SelectionEvidenceSource = "k7:price-evidence";

/** Normalization version for catalog facts. Bump when the shape of a fact changes. */
export const CATALOG_NORMALIZATION_VERSION = "1.0";

/**
 * Benchmark-prior normalization version (K8). Bump on ANY change to how a raw
 * Artificial Analysis metric becomes a 0..1 prior — K13 must never blend values
 * produced by two versions (§4.4.3 "versioned normalization").
 */
export const AA_NORMALIZATION_VERSION = "aa-normalization-v1";

/**
 * The benchmark's OWN identity — release and configuration, and its publication
 * date WHERE the source supplies one. `observedAt` on the enclosing `Provenance`
 * is a different fact: when WE fetched it. The two are never collapsed (§4.4.3
 * "evidence age").
 */
export interface BenchmarkIdentity {
  /** The benchmark release / methodology version, e.g. `intelligence-index-v4.3`. */
  release: string;
  /** The scored configuration where the source distinguishes several, e.g. `prompt_length=medium`. */
  configuration?: string;
  /** The benchmark's publication date. Absent when the source does not supply one — never faked. */
  publishedAt?: string;
  /**
   * The MODEL's own release date per the source (K8: AA `release_date`). This is
   * NOT the benchmark's publication date (`publishedAt`) — a model can be
   * re-benchmarked long after it ships. Kept only as diagnostic context.
   */
  modelReleaseDate?: string;
  /** The source's own slug for the model, kept for display. Never a join key (slugs drift). */
  sourceSlug?: string;
  /** Which dimension this identity scopes, e.g. `coding` or `speed`. */
  category: string;
}

export interface Provenance {
  source: EvidenceSource | ExternalEvidenceSource | SelectionEvidenceSource;
  tier: EvidenceTier;
  observedAt: string;
  /** External benchmark evidence only: the source's own release/config identity. */
  benchmark?: BenchmarkIdentity;
  normalizationVersion: string;
  /** Free-text pointer to the publisher / page / run the fact came from. */
  attribution?: string;
  sampleSize?: number;
}

/**
 * One normalized external benchmark PRIOR for a catalog entry (K8). It is
 * evidence about model intelligence — never an identity, status, availability or
 * price fact, and never a selection (K13 does not exist). Enough of the raw
 * source survives to audit the normalization (I-M1 / §9): the raw metric, its
 * unit, the source's own model id, and the deterministic method that produced
 * `normalized`.
 */
export interface BenchmarkPrior {
  /** Only dimensions the source can truthfully support (§8). */
  dimension: "coding" | "speed";
  /** Deterministic 0..1, higher = better. Reconstructible from `raw` + `normalizationVersion`. */
  normalized: number;
  /** The untouched source measurement behind `normalized`. */
  raw: { metric: string; value: number; unit: string };
  /** The source's OWN identifier for the model this score describes. */
  sourceModelId: string;
  normalizationVersion: string;
  provenance: Provenance;
  freshness: Freshness;
}

/**
 * `aa-normalization-v1` (K8). Deliberately a fixed ABSOLUTE rescale, not a
 * dataset-relative rank: it needs no cross-model dataset, so ties, zero-range
 * datasets and outliers have no degenerate case — an out-of-range input simply
 * clamps. Provider-neutral by construction; changing `scaleMax` or `direction`
 * for a dimension is a `normalizationVersion` bump (§10, §11).
 */
export function normalizeBenchmark(input: {
  value: number;
  /** `higher` — bigger raw is better (indices, tokens/s). `lower` — smaller is better (latency). */
  direction: "higher" | "lower";
  /** The raw value that maps to 1.0 (`higher`) or to 0.0 (`lower`). Must be > 0. */
  scaleMax: number;
}): number | undefined {
  const { value, direction, scaleMax } = input;
  if (!Number.isFinite(value) || !Number.isFinite(scaleMax) || scaleMax <= 0) return undefined;
  const ratio = value / scaleMax;
  const normalized = direction === "higher" ? ratio : 1 - ratio;
  return Math.min(1, Math.max(0, normalized));
}

/**
 * Price EVIDENCE, not an enforcement tariff (§4.4.5). Its presence never
 * authorizes a bounded `maxCostUsd` cap on its own — see standing deferral #3.
 */
export interface ModelPriceEvidence {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
  currency: "USD";
  /** Identifies the price revision this evidence belongs to. */
  pricingVersion: string;
  /** Where this price applies. Absent = applicability not established. */
  appliesTo?: { servingProvider: string; accountKind?: string };
  provenance: Provenance;
}

/**
 * A merged catalog fact together with the evidence that actually supplied it
 * (I-M1). Merging fills gaps across sources, so an entry established by a
 * provider-official manifest can still carry a context window that only a
 * weaker source reported — that field keeps the weaker source's provenance
 * rather than inheriting the entry's.
 */
export interface Attributed<T> {
  value: T;
  provenance: Provenance;
}

/** Read-time view of stored price evidence: the row plus its freshness label. */
export interface ModelPriceView extends ModelPriceEvidence {
  freshness: Freshness;
}

/**
 * Provider-safe catalog identity. Model ids are NOT globally unique: `default`
 * is a real, distinct model id for both Codex (openai) and Cursor today, so a
 * catalog keyed on the id alone collapses them into one entry and lets each
 * provider overwrite the other's evidence.
 */
export function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export interface ModelCatalogEntry {
  /** 2: identity is provider-safe and merged facts carry their own provenance. */
  schemaVersion: 2;
  /** `provider:modelId` — the identity every evidence row joins on. */
  modelKey: string;
  modelId: string;
  provider: string;
  displayName?: Attributed<string>;
  aliases: Array<Attributed<string>>;
  contextWindowTokens?: Attributed<number>;
  maxOutputTokens?: Attributed<number>;
  capabilities?: Attributed<Record<string, boolean | number | string>>;
  pricing: ModelPriceView[];
  /**
   * Normalized external benchmark priors (K8), attached only to an entry a
   * higher-authority source already established — a prior never creates a
   * catalog entry or grants availability (§13, §14). Absent when none.
   */
  benchmarkPriors?: BenchmarkPrior[];
  /** JOINed from provider discovery — M12 never decides availability itself. */
  availableVia: AssistantId[];
  status: "available" | "unknown" | "retired";
  /**
   * The evidence that ESTABLISHED this entry, and therefore the provenance of
   * `provider` and `status`. It is not the provenance of the fields above —
   * those carry their own.
   */
  provenance: Provenance;
  freshness: Freshness;
  catalogRevision: string;
}

/**
 * What model was asked for, and what the provider actually served — two
 * separate facts (I-M5). `resolvedModelId` absent means the provider reported
 * no model identity; it is never guessed from aliases or from today's catalog.
 */
export interface ExecutionIdentity {
  requestedModelSelector?: string;
  resolvedModelId?: string;
  resolvedSource: "run.started" | "result" | "unknown";
  servingProvider?: string;
  harness: { id: AssistantId; version?: string };
  catalogRevision?: string;
  pricingRevision?: string;
}

/** Per-tier staleness budget (§4.4.2): official facts 7 d, external benchmarks 30 d. */
export const CATALOG_TTL_MS: Record<EvidenceTier, number> = {
  "measured-own": 7 * 24 * 3600_000,
  "provider-official": 7 * 24 * 3600_000,
  "external-benchmark": 30 * 24 * 3600_000,
  manual: 30 * 24 * 3600_000,
};

/** Read-time freshness. Expired rows stay readable — they are just labelled. */
export function freshnessOf(observedAt: string, tier: EvidenceTier, nowMs: number): Freshness {
  const ageMs = nowMs - Date.parse(observedAt);
  if (Number.isNaN(ageMs)) return "expired";
  const ttl = CATALOG_TTL_MS[tier];
  if (ageMs < 3600_000) return "live";
  if (ageMs < ttl) return "fresh";
  if (ageMs < ttl * 2) return "stale";
  return "expired";
}
