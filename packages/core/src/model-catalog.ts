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

/** Normalization version for catalog facts. Bump when the shape of a fact changes. */
export const CATALOG_NORMALIZATION_VERSION = "1.0";

export interface Provenance {
  source: EvidenceSource;
  tier: EvidenceTier;
  observedAt: string;
  normalizationVersion: string;
  /** Free-text pointer to the publisher / page / run the fact came from. */
  attribution?: string;
  sampleSize?: number;
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
