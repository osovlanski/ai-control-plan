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
 * Verified against the current official Data API reference
 * (artificialanalysis.ai/data-api/docs, re-checked 2026-09-09):
 *
 *   - base `https://artificialanalysis.ai/api/v2`
 *   - endpoint `GET /language/models/free` — the versioned, free-tier
 *     language-model list. (The older `/data/llms/models` path is superseded;
 *     the versioned endpoint is what the docs now document and is the one that
 *     promises the fields below.)
 *   - auth: a single `x-api-key` request header (no OAuth, no signing, no body)
 *   - response root: `{ tier, intelligence_index_version, pagination, data[] }`
 *       - `intelligence_index_version` — a NUMBER, major.minor (e.g. 4.1); the
 *         methodology release every `evaluations.*` index belongs to
 *       - `pagination` — `{ page, page_size, total_pages, has_more }`; the client
 *         follows `has_more` up to `AA_MAX_PAGES` (below)
 *   - per row: stable `id` (join authority — AA states slugs may change),
 *     `slug` (display/diagnostic only), `model_creator { id, name }`,
 *     `release_date` (the MODEL's release date, or null — NOT a benchmark
 *     publication date), `evaluations.artificial_analysis_coding_index`,
 *     `performance.median_output_tokens_per_second`
 *   - the free tier is rate-limited; the effective limit is returned in the
 *     `X-RateLimit-*` response headers and its published value has changed
 *     between AA announcements, so no fixed number is asserted here. This client
 *     issues at most `AA_MAX_PAGES` GET requests per daily refresh and treats a
 *     429 as a classified, non-fatal `rate limited` outcome.
 *   - attribution is required across all tiers: credit Artificial Analysis and
 *     link https://artificialanalysis.ai/ (stored on every row as
 *     `provenance.attribution`).
 *   - the response supplies NO benchmark publication date, so
 *     `benchmark.publishedAt` stays absent, never faked. `release_date` is the
 *     model's own release and rides on `benchmark.modelReleaseDate`, kept
 *     distinct from `publishedAt`. Full notes:
 *     docs/agentic-os-k8-artificial-analysis.md
 *
 * This source receives ONLY `{ fetch }` (I-M3): it structurally cannot see a
 * task, prompt, repository, transcript, usage or routing decision, so none can
 * leak. It supplies PRIOR evidence about model intelligence only — it never
 * chooses a model, never writes price evidence, never grants availability.
 */

export const AA_BASE = 'https://artificialanalysis.ai/api/v2';
export const AA_ENDPOINT = `${AA_BASE}/language/models/free`;
export const AA_ATTRIBUTION = 'Artificial Analysis — https://artificialanalysis.ai/';
/** Hard cap on paginated requests per refresh — bounds a broken `has_more`. */
export const AA_MAX_PAGES = 20;
/**
 * `/language/models/free` reports speed at AA's default measurement (medium
 * prompt length, ~1k tokens) — the endpoint takes no `prompt_type`, so the
 * configuration is fixed and recorded verbatim, not guessed per row.
 */
export const AA_SPEED_CONFIGURATION = 'prompt_length=medium (AA free-tier default)';

/**
 * Fixed absolute scales for `aa-normalization-v1`. Provider-neutral: they are
 * properties of the metric, not of any model. Changing either is a
 * `AA_NORMALIZATION_VERSION` bump.
 */
export const AA_CODING_SCALE_MAX = 100; // the AA coding index is reported 0..100
export const AA_SPEED_SCALE_MAX = 200; // output tokens/s that maps to a 1.0 speed prior

/**
 * Explicit, reviewable identity mapping (§12, P1-B). AA's STABLE `id` plus its
 * `model_creator.id` is the join authority — AA itself recommends the stable id
 * because slugs drift. A `slug` is kept only for display (`aaSlugHint`) and is
 * NEVER read to join. There is NO fuzzy matching: a row whose `id` is not listed
 * here, or whose creator does not match the listed one, is left unmatched (§13),
 * never attached to a near-named model.
 *
 * Reasoning / effort variants: AA benchmarks those as SEPARATE model `id`s
 * (e.g. a distinct id for a "…max" configuration), so the exact-id join here
 * cannot pull a variant's score onto the base model — a variant id is simply
 * absent from this table and its row is unmatched. That is the intended
 * behaviour: a wrong benchmark attribution is worse than a missing prior.
 *
 * NOTE (no live key in this environment): the `aaId` values below are AA's
 * documented identifiers for these two models and must be confirmed against one
 * bounded live `/language/models/free` refresh. A wrong `aaId` yields an
 * unmatched row — never a misattribution (the id-exact join + creator gate make
 * a false positive impossible).
 */
export interface AaModelMapEntry {
  /** AA's stable model `id`. The join authority. */
  aaId: string;
  /** AA's `model_creator.id`. Must also match, or the row is not mapped. */
  aaCreatorId: string;
  /** Reviewed catalog identity — `(provider, modelId)`, never a bare id. */
  provider: string;
  modelId: string;
  /** Display/diagnostic only. Never used to join. */
  aaSlugHint?: string;
  /** Why this AA `(id, creator)` is the same model as this catalog identity,
   *  including the benchmark configuration assumed. */
  evidence: string;
}
export const AA_MODEL_MAP: AaModelMapEntry[] = [
  {
    aaId: 'claude-4-1-opus',
    aaCreatorId: 'anthropic',
    provider: 'anthropic',
    modelId: 'claude-opus-4-1',
    aaSlugHint: 'claude-4-1-opus',
    evidence:
      'AA lists Anthropic Claude Opus 4.1 under this id; catalog id is the K7 price-seed identity for the same model. ' +
      'Base (non-effort) configuration — AA scores an effort variant, if any, under a different id that is not in this table.',
  },
  {
    aaId: 'claude-4-5-sonnet',
    aaCreatorId: 'anthropic',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    aaSlugHint: 'claude-4-5-sonnet',
    evidence:
      'AA lists Anthropic Claude Sonnet 4.5 under this id; catalog id is the K7 price-seed identity for the same model. ' +
      'Base (non-effort) configuration — an AA "…max"/effort variant has its own id and is left unmatched.',
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

interface AaCreator {
  id?: unknown;
  name?: unknown;
}
interface AaEvaluations {
  artificial_analysis_coding_index?: unknown;
  coding_index?: unknown;
  [k: string]: unknown;
}
interface AaPerformance {
  median_output_tokens_per_second?: unknown;
  [k: string]: unknown;
}
interface AaRow {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  release_date?: unknown;
  model_creator?: AaCreator | null;
  evaluations?: AaEvaluations | null;
  performance?: AaPerformance | null;
  // AA also returns `pricing.*` here. K8 deliberately does not read it:
  // external benchmark price is never price authority (§21).
}
interface AaPagination {
  page?: unknown;
  page_size?: unknown;
  total_pages?: unknown;
  has_more?: unknown;
}
interface AaBody {
  intelligence_index_version?: unknown;
  pagination?: AaPagination | null;
  data?: unknown;
}

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** The coding index, from the documented `evaluations` location (flat fallback for resilience). */
function readCodingIndex(row: AaRow): number | undefined {
  const evals = row.evaluations ?? undefined;
  return (
    finite(evals?.artificial_analysis_coding_index) ??
    finite(evals?.coding_index) ??
    finite((row as Record<string, unknown>).artificial_analysis_coding_index)
  );
}

/** Output speed, from the documented `performance.median_output_tokens_per_second`. */
function readSpeed(row: AaRow): number | undefined {
  return (
    finite(row.performance?.median_output_tokens_per_second) ??
    finite((row as Record<string, unknown>).median_output_tokens_per_second)
  );
}

/** The intelligence-index methodology version — a documented ROOT field, number major.minor. */
function readIndexVersion(body: AaBody): string | undefined {
  const raw = body.intelligence_index_version;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return str(raw);
}

export interface AaSourceOptions {
  /** From `AA_API_KEY` env only — never a config file, never persisted (§3). */
  apiKey: string | undefined;
  now: () => Date;
  /** Test seam: skip the network and parse this single body instead. */
  fixtureBody?: unknown;
}

/**
 * Build the K8 `CatalogSource`. Always safe to register: with no key it records
 * a classified `not configured` refresh attempt and the local catalog is
 * untouched (§3). Pagination and network never run at startup — only inside
 * `modelCatalog.refresh()` (the daily job / explicit refresh route).
 */
export function createArtificialAnalysisSource(opts: AaSourceOptions): CatalogSource {
  return {
    name: 'artificial-analysis',
    async collect(ctx) {
      if (opts.fixtureBody === undefined && !opts.apiKey) {
        throw new CatalogSourceError('not configured');
      }
      // ONE observation time for the whole logical refresh, however many pages.
      const at = opts.now();
      const observedAt = at.toISOString();
      const nowMs = at.getTime();

      if (opts.fixtureBody !== undefined) {
        return parseAaBody(opts.fixtureBody, observedAt, nowMs);
      }

      const merged: unknown[] = [];
      let indexVersion: unknown;
      let pages = 0;

      for (let page = 1; page <= AA_MAX_PAGES; page += 1) {
        let res: Response;
        try {
          res = await ctx.fetch(`${AA_ENDPOINT}?page=${page}`, {
            method: 'GET',
            headers: { 'x-api-key': opts.apiKey as string, accept: 'application/json' },
          });
        } catch {
          throw new CatalogSourceError('unavailable');
        }
        if (res.status === 401 || res.status === 403) throw new CatalogSourceError('unauthorized');
        if (res.status === 429) throw new CatalogSourceError('rate limited');
        if (!res.ok) throw new CatalogSourceError('unavailable');

        let bodyPage: AaBody;
        try {
          bodyPage = (await res.json()) as AaBody;
        } catch {
          throw new CatalogSourceError('malformed response');
        }
        if (typeof bodyPage !== 'object' || bodyPage === null || !Array.isArray(bodyPage.data)) {
          throw new CatalogSourceError('malformed response');
        }

        merged.push(...bodyPage.data);
        if (page === 1) indexVersion = bodyPage.intelligence_index_version;
        pages += 1;

        const pag = bodyPage.pagination ?? undefined;
        if (!pag || pag.has_more !== true) break;
      }

      const parsed = parseAaBody({ intelligence_index_version: indexVersion, data: merged }, observedAt, nowMs);
      return { ...parsed, detail: `${pages} page(s); ${parsed.detail}` };
    },
  };
}

/**
 * Deterministic parse + normalize of one (already-paginated) response body.
 * Returns the mapped observations and a diagnostic count (§13) — unmapped AA
 * models are skipped, never guessed onto a catalog entry.
 */
export function parseAaBody(
  body: unknown,
  observedAt: string,
  nowMs: number,
): { observations: CatalogObservation[]; detail: string } {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as AaBody).data)) {
    throw new CatalogSourceError('malformed response');
  }
  const bodyObj = body as AaBody;
  const rows = bodyObj.data as unknown[];
  const release = readIndexVersion(bodyObj);
  const byId = new Map(AA_MODEL_MAP.map((m) => [m.aaId, m]));

  const observations: CatalogObservation[] = [];
  let mapped = 0;
  let unmatched = 0;
  let creatorMismatch = 0;
  let noId = 0;
  let noRelease = 0;

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as AaRow;

    // Join on the STABLE id only. No id → cannot join (never fall back to slug).
    const id = str(row.id);
    if (!id) {
      noId += 1;
      continue;
    }
    const target = byId.get(id);
    if (!target) {
      unmatched += 1;
      continue;
    }
    // Creator must also match: an id collision alone must never map (P1-B).
    const creatorId = str(row.model_creator?.id);
    if (creatorId !== target.aaCreatorId) {
      creatorMismatch += 1;
      continue;
    }

    const slug = str(row.slug);
    const modelReleaseDate = str(row.release_date); // the MODEL's release, not the benchmark's
    const priors: BenchmarkPrior[] = [];

    // --- coding: versioned by the intelligence-index release (§7) ----------
    const codingRaw = readCodingIndex(row);
    if (codingRaw !== undefined) {
      if (!release) {
        noRelease += 1;
      } else {
        const normalized = normalizeBenchmark({ value: codingRaw, direction: 'higher', scaleMax: AA_CODING_SCALE_MAX });
        if (normalized !== undefined) {
          priors.push(codingPrior(id, slug, codingRaw, normalized, release, modelReleaseDate, observedAt, nowMs));
        }
      }
    }

    // --- speed: identified by its measurement configuration, not the index --
    const speedRaw = readSpeed(row);
    if (speedRaw !== undefined) {
      const normalized = normalizeBenchmark({ value: speedRaw, direction: 'higher', scaleMax: AA_SPEED_SCALE_MAX });
      if (normalized !== undefined) {
        priors.push(speedPrior(id, slug, speedRaw, normalized, modelReleaseDate, observedAt, nowMs));
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

  const parts = [`${mapped} mapped`, `${unmatched} unmatched`];
  if (creatorMismatch) parts.push(`${creatorMismatch} creator-mismatch`);
  if (noId) parts.push(`${noId} no-id`);
  if (noRelease) parts.push(`${noRelease} coding priors skipped (no benchmark release)`);
  return { observations, detail: `${rows.length} rows: ${parts.join(', ')}` };
}

function codingPrior(
  aaId: string,
  aaSlug: string | undefined,
  value: number,
  normalized: number,
  release: string,
  modelReleaseDate: string | undefined,
  observedAt: string,
  nowMs: number,
): BenchmarkPrior {
  const provenance: Provenance = {
    source: 'external:artificial-analysis',
    tier: 'external-benchmark',
    observedAt,
    benchmark: {
      release: `intelligence-index-${release}`,
      category: 'coding',
      ...(aaSlug ? { sourceSlug: aaSlug } : {}),
      ...(modelReleaseDate ? { modelReleaseDate } : {}),
    },
    normalizationVersion: AA_NORMALIZATION_VERSION,
    attribution: AA_ATTRIBUTION,
  };
  return {
    dimension: 'coding',
    normalized,
    raw: { metric: 'artificial_analysis_coding_index', value, unit: 'index-0-100' },
    sourceModelId: aaId,
    normalizationVersion: AA_NORMALIZATION_VERSION,
    provenance,
    freshness: freshnessOf(observedAt, 'external-benchmark', nowMs),
  };
}

function speedPrior(
  aaId: string,
  aaSlug: string | undefined,
  value: number,
  normalized: number,
  modelReleaseDate: string | undefined,
  observedAt: string,
  nowMs: number,
): BenchmarkPrior {
  const provenance: Provenance = {
    source: 'external:artificial-analysis',
    tier: 'external-benchmark',
    observedAt,
    benchmark: {
      release: 'aa-speed-measurement',
      configuration: AA_SPEED_CONFIGURATION,
      category: 'speed',
      ...(aaSlug ? { sourceSlug: aaSlug } : {}),
      ...(modelReleaseDate ? { modelReleaseDate } : {}),
    },
    normalizationVersion: AA_NORMALIZATION_VERSION,
    attribution: AA_ATTRIBUTION,
  };
  return {
    dimension: 'speed',
    normalized,
    raw: { metric: 'median_output_tokens_per_second', value, unit: 'tokens/second' },
    sourceModelId: aaId,
    normalizationVersion: AA_NORMALIZATION_VERSION,
    provenance,
    freshness: freshnessOf(observedAt, 'external-benchmark', nowMs),
  };
}
