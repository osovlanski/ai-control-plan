import {
  AA_NORMALIZATION_VERSION,
  freshnessOf,
  normalizeBenchmark,
  type BenchmarkPrior,
  type Provenance,
} from '@agent-plane/core';
import type { CatalogObservation, CatalogSource } from './model-catalog.js';

/**
 * K8 — the ONE external benchmark source: Artificial Analysis.
 *
 * Verified against the official reference (artificialanalysis.ai/api-reference,
 * fetched 2026-09-09):
 *   - base `https://artificialanalysis.ai/api/v2`, endpoint `GET /data/llms/models`
 *   - auth: a single `x-api-key` header (no OAuth, no signing)
 *   - free tier 1 000 req/day; "Internal use only; with attribution"
 *   - attribution required: link to https://artificialanalysis.ai/
 *   - the response supplies a methodology version (`intelligence_index_version`)
 *     but NO per-row publication date — so `benchmark.publishedAt` stays absent,
 *     never faked (§6, §7). Full notes: docs/agentic-os-k8-artificial-analysis.md
 *
 * This source receives ONLY `{ fetch }` (I-M3): it structurally cannot see a
 * task, prompt, repository, transcript, usage or routing decision, so none can
 * leak. It supplies PRIOR evidence about model intelligence only — it never
 * chooses a model, never writes price evidence, never grants availability.
 */

export const AA_ENDPOINT = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const AA_ATTRIBUTION = 'Artificial Analysis — https://artificialanalysis.ai/';

/**
 * Fixed absolute scales for `aa-normalization-v1`. Provider-neutral: they are
 * properties of the metric, not of any model. Changing either is a
 * `AA_NORMALIZATION_VERSION` bump.
 */
export const AA_CODING_SCALE_MAX = 100; // the AA coding index is reported 0..100
export const AA_SPEED_SCALE_MAX = 200; // output tokens/s that maps to a 1.0 speed prior

/**
 * Explicit, reviewable identity mapping (§12). AA slugs are an external identity;
 * catalog identity is `(provider, modelId)`. There is NO fuzzy matching — a row
 * whose slug is not listed here is left unmatched (§13), never attached to a
 * near-named model. `default` (Codex/Cursor) can never appear here, so aliases
 * cannot participate. Each row needs a comment justifying the equivalence.
 */
export interface AaModelMapEntry {
  aaSlug: string;
  provider: string;
  modelId: string;
  /** Why this AA slug is the same model as this catalog identity. */
  evidence: string;
}
export const AA_MODEL_MAP: AaModelMapEntry[] = [
  {
    aaSlug: 'claude-4-1-opus',
    provider: 'anthropic',
    modelId: 'claude-opus-4-1',
    evidence: 'AA lists Anthropic Claude Opus 4.1 under this slug; catalog id matches the provider price-seed id.',
  },
  {
    aaSlug: 'claude-4-5-sonnet',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    evidence: 'AA lists Anthropic Claude Sonnet 4.5 under this slug; catalog id matches the provider price-seed id.',
  },
];

/**
 * A classified source failure. `detail` is a fixed label — never a transport
 * error, response body or the API key, any of which could echo a request or a
 * secret into `model_catalog_refresh` (§3, §16, §23).
 */
export class CatalogSourceError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'CatalogSourceError';
  }
}

interface AaRow {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  evaluations?: Record<string, unknown> | null;
  intelligence_index_version?: unknown;
  median_output_tokens_per_second?: unknown;
  // AA also returns price_1m_* fields here. K8 deliberately does not read them:
  // external benchmark price is never price authority (§21).
}

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** First finite number among a row's candidate paths for one metric. */
function readMetric(row: AaRow, keys: string[]): number | undefined {
  for (const key of keys) {
    const direct = finite((row as Record<string, unknown>)[key]);
    if (direct !== undefined) return direct;
    const nested = row.evaluations ? finite(row.evaluations[key]) : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function readIndexVersion(row: AaRow, body: Record<string, unknown>): string | undefined {
  const raw =
    row.intelligence_index_version ??
    (row.evaluations ? row.evaluations['intelligence_index_version'] : undefined) ??
    body['intelligence_index_version'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return undefined;
}

export interface AaSourceOptions {
  /** From `AA_API_KEY` env only — never a config file, never persisted (§3). */
  apiKey: string | undefined;
  now: () => Date;
  /** Test seam: skip the network and parse this body instead. */
  fixtureBody?: unknown;
}

/**
 * Build the K8 `CatalogSource`. Always safe to register: with no key it records
 * a classified `not configured` refresh attempt and the local catalog is
 * untouched (§3).
 */
export function createArtificialAnalysisSource(opts: AaSourceOptions): CatalogSource {
  return {
    name: 'artificial-analysis',
    async collect(ctx) {
      if (opts.fixtureBody === undefined && !opts.apiKey) {
        throw new CatalogSourceError('not configured');
      }
      const observedAt = opts.now().toISOString();

      let body: unknown;
      if (opts.fixtureBody !== undefined) {
        body = opts.fixtureBody;
      } else {
        let res: Response;
        try {
          res = await ctx.fetch(AA_ENDPOINT, {
            method: 'GET',
            headers: { 'x-api-key': opts.apiKey as string, accept: 'application/json' },
          });
        } catch {
          throw new CatalogSourceError('unavailable');
        }
        if (res.status === 401 || res.status === 403) throw new CatalogSourceError('unauthorized');
        if (!res.ok) throw new CatalogSourceError('unavailable');
        try {
          body = await res.json();
        } catch {
          throw new CatalogSourceError('malformed response');
        }
      }

      return parseAaBody(body, observedAt, opts.now().getTime());
    },
  };
}

/**
 * Deterministic parse + normalize. Returns the mapped observations and a
 * diagnostic count (§13) — unmapped AA models are skipped, never guessed onto a
 * catalog entry.
 */
export function parseAaBody(
  body: unknown,
  observedAt: string,
  nowMs: number,
): { observations: CatalogObservation[]; detail: string } {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new CatalogSourceError('malformed response');
  }
  const bodyObj = body as Record<string, unknown>;
  const rows = bodyObj.data as unknown[];
  const mapBySlug = new Map(AA_MODEL_MAP.map((m) => [m.aaSlug, m]));

  const observations: CatalogObservation[] = [];
  let mapped = 0;
  let unmatched = 0;
  let noRelease = 0;

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as AaRow;
    const slug = typeof row.slug === 'string' ? row.slug : undefined;
    if (!slug) continue;
    const target = mapBySlug.get(slug);
    if (!target) {
      unmatched += 1;
      continue;
    }

    const priors: BenchmarkPrior[] = [];

    // --- coding: versioned by the intelligence-index release (§7) ----------
    const codingRaw = readMetric(row, ['artificial_analysis_coding_index', 'coding_index']);
    if (codingRaw !== undefined) {
      const release = readIndexVersion(row, bodyObj);
      if (!release) {
        noRelease += 1;
      } else {
        const normalized = normalizeBenchmark({ value: codingRaw, direction: 'higher', scaleMax: AA_CODING_SCALE_MAX });
        if (normalized !== undefined) {
          priors.push(codingPrior(slug, codingRaw, normalized, release, observedAt, nowMs));
        }
      }
    }

    // --- speed: identified by its measurement configuration, not the index --
    const speedRaw = finite(row.median_output_tokens_per_second);
    if (speedRaw !== undefined) {
      const normalized = normalizeBenchmark({ value: speedRaw, direction: 'higher', scaleMax: AA_SPEED_SCALE_MAX });
      if (normalized !== undefined) {
        priors.push(speedPrior(slug, speedRaw, normalized, bodyObj, observedAt, nowMs));
      }
    }

    if (priors.length === 0) {
      unmatched += 1;
      continue;
    }
    mapped += 1;
    observations.push({
      modelId: target.modelId,
      provider: target.provider,
      // Entry-level provenance mirrors the priors' — but this observation never
      // establishes an entry (the catalog service guards external-benchmark
      // rows), so this is only carried for the unmerged evidence row.
      provenance: priors[0]!.provenance,
      benchmarks: priors,
    });
  }

  const detail =
    `${rows.length} rows: ${mapped} mapped, ${unmatched} unmatched` +
    (noRelease ? `, ${noRelease} coding priors skipped (no benchmark release)` : '');
  return { observations, detail };
}

function codingPrior(
  sourceModelId: string,
  value: number,
  normalized: number,
  release: string,
  observedAt: string,
  nowMs: number,
): BenchmarkPrior {
  const provenance: Provenance = {
    source: 'external:artificial-analysis',
    tier: 'external-benchmark',
    observedAt,
    benchmark: { release: `intelligence-index-${release}`, category: 'coding' },
    normalizationVersion: AA_NORMALIZATION_VERSION,
    attribution: AA_ATTRIBUTION,
  };
  return {
    dimension: 'coding',
    normalized,
    raw: { metric: 'artificial_analysis_coding_index', value, unit: 'index-0-100' },
    sourceModelId,
    normalizationVersion: AA_NORMALIZATION_VERSION,
    provenance,
    freshness: freshnessOf(observedAt, 'external-benchmark', nowMs),
  };
}

function speedPrior(
  sourceModelId: string,
  value: number,
  normalized: number,
  body: Record<string, unknown>,
  observedAt: string,
  nowMs: number,
): BenchmarkPrior {
  const opt = (body.prompt_options as Record<string, unknown> | undefined) ?? {};
  const promptLength = typeof opt.prompt_length === 'string' ? opt.prompt_length : 'unspecified';
  const parallel = finite(opt.parallel_queries) ?? 1;
  const provenance: Provenance = {
    source: 'external:artificial-analysis',
    tier: 'external-benchmark',
    observedAt,
    benchmark: {
      release: 'aa-speed-measurement',
      configuration: `prompt_length=${promptLength};parallel_queries=${parallel}`,
      category: 'speed',
    },
    normalizationVersion: AA_NORMALIZATION_VERSION,
    attribution: AA_ATTRIBUTION,
  };
  return {
    dimension: 'speed',
    normalized,
    raw: { metric: 'median_output_tokens_per_second', value, unit: 'tokens/second' },
    sourceModelId,
    normalizationVersion: AA_NORMALIZATION_VERSION,
    provenance,
    freshness: freshnessOf(observedAt, 'external-benchmark', nowMs),
  };
}

