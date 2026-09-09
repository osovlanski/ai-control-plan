import {
  CATALOG_NORMALIZATION_VERSION,
  EVIDENCE_PRIORITY,
  freshnessOf,
  modelKey,
} from '@agent-plane/core';
import type {
  AssistantId,
  Attributed,
  BenchmarkPrior,
  CapabilityManifest,
  EvidenceSource,
  ExternalEvidenceSource,
  Freshness,
  ModelCatalogEntry,
  ModelPriceEvidence,
  ModelPriceView,
  Provenance,
} from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { Registry } from './registry.js';

/**
 * M12 model catalog (K7). Local-first: every source below reads evidence that
 * already exists on this machine — provider discovery manifests, this
 * workspace's own runs, and a versioned manual price snapshot. Network sources
 * are a seam (`CatalogSource`) so K8 can add them without reopening this file;
 * a source failure is recorded and never blocks routing (I-M3).
 *
 * Identity here is (provider, model id), never the model id alone: `default` is
 * a real model id for both Codex (openai) and Cursor, and one provider's
 * evidence must never land on the other's model.
 *
 * NOT implemented here, deliberately: benchmark ingestion (K8) and any scoring
 * or model selection (K13). This module answers "what do we know about this
 * model, and how do we know it" — nothing chooses a model from it.
 */

/** Bumped when the merge/normalization of catalog facts changes. */
export const CATALOG_REVISION = '2026-09-08.2';

export interface CatalogObservation {
  modelId: string;
  provider: string;
  displayName?: string;
  aliases?: string[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  capabilities?: Record<string, boolean | number | string>;
  status?: ModelCatalogEntry['status'];
  provenance: Provenance;
  pricing?: ModelPriceEvidence[];
  /**
   * External benchmark priors (K8). An observation carrying these has
   * `provenance.tier === 'external-benchmark'`; the merge NEVER lets it
   * establish an entry or fill an identity/price gap — it only attaches priors
   * to an entry a stronger source already established (§13, §14).
   */
  benchmarks?: BenchmarkPrior[];
}

/** One stored evidence row, as `GET /api/models/:id` returns it unmerged. */
export interface CatalogEvidenceRow {
  provider: string;
  modelId: string;
  source: EvidenceSource | ExternalEvidenceSource;
  tier: Provenance['tier'];
  observedAt: string;
  freshness: Freshness;
  catalogRevision: string;
  observation: CatalogObservation;
}

/**
 * A catalog evidence source. `collect` receives ONLY a transport — no task,
 * prompt, repository or usage content is available to it, so none can be sent
 * (I-M3). Sources must not throw for network failure; they may, and refresh
 * classifies it.
 */
export interface CatalogSource {
  name: string;
  /**
   * Returns observations, optionally with a fixed `detail` string for the
   * refresh log (e.g. a mapped/unmatched count — §13). `detail` must never
   * contain a transport error, response body or credential.
   */
  collect(ctx: { fetch: typeof globalThis.fetch }): Promise<CatalogObservation[] | { observations: CatalogObservation[]; detail?: string }>;
}

/** Deterministic conflict rank. External benchmark priors always rank last: they
 * fill nothing on the entry and never override a provider fact (§14). */
const CATALOG_SOURCE_PRIORITY: Record<EvidenceSource | ExternalEvidenceSource, number> = {
  ...EVIDENCE_PRIORITY,
  'external:artificial-analysis': 0,
};

export interface RefreshAttempt {
  source: string;
  status: 'ok' | 'failed';
  entries: number;
  detail?: string;
}

/**
 * Manually transcribed list prices. `tier: "manual"` is the honest label: these
 * were copied from published pricing pages by a human, not fetched from a
 * provider API. They are EVIDENCE, not an enforcement tariff — see
 * `session-runner`'s bounded-cost rejection and standing deferral #3.
 */
export const PRICE_SEED_VERSION = '2026-09-08';
/**
 * When this snapshot was transcribed — a fixed historical fact, NOT the time of
 * the refresh that loaded it. Re-running refresh in 2027 must not make a 2026
 * price look freshly observed; only a newer price revision with its own
 * evidence row can do that.
 */
export const PRICE_SEED_OBSERVED_AT = '2026-09-08T00:00:00.000Z';
const PRICE_SEED: Array<{ modelId: string; provider: string; aliases?: string[]; price: Omit<ModelPriceEvidence, 'provenance'> }> = [
  {
    modelId: 'claude-opus-4-1', provider: 'anthropic', aliases: ['opus'],
    price: { inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75, currency: 'USD', pricingVersion: PRICE_SEED_VERSION, appliesTo: { servingProvider: 'anthropic', accountKind: 'api' } },
  },
  {
    modelId: 'claude-sonnet-4-5', provider: 'anthropic', aliases: ['sonnet'],
    price: { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, currency: 'USD', pricingVersion: PRICE_SEED_VERSION, appliesTo: { servingProvider: 'anthropic', accountKind: 'api' } },
  },
];

const nowIso = (now: () => Date): string => now().toISOString();

/**
 * A safe, fixed failure label. A source may attach its own via a `detail`
 * string property (see `CatalogSourceError`); anything else collapses to a
 * generic label so a raw transport error — which can echo the request URL,
 * headers or a credential — is never written to `model_catalog_refresh`.
 */
const SAFE_DETAIL_LABELS = new Set(['not configured', 'unauthorized', 'unavailable', 'rate limited', 'malformed response']);
function classifiedDetail(err: unknown): string {
  if (err && typeof err === 'object' && 'detail' in err) {
    const d = (err as { detail: unknown }).detail;
    if (typeof d === 'string' && SAFE_DETAIL_LABELS.has(d)) return d;
  }
  return 'source unavailable';
}

/** Manifest evidence describes how the adapter learned its model list. */
function tierFor(source: EvidenceSource): Provenance['tier'] {
  if (source === 'provider-api') return 'provider-official';
  if (source === 'runtime-probe') return 'measured-own';
  return 'manual';
}

/** A merged field keeps the provenance of the source that actually supplied it. */
function attribute<T>(value: T | undefined, provenance: Provenance): Attributed<T> | undefined {
  return value === undefined ? undefined : { value, provenance };
}

export class ModelCatalogService {
  /** Cold-start hydration runs at most once per process (see `list`). */
  private hydrated = false;

  constructor(
    private db: Db,
    private registry: Registry,
    private now: () => Date = () => new Date(),
    /** Network / external sources. Empty at K7 — the seam K8 plugs into. */
    private sources: CatalogSource[] = [],
    private fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /**
   * Re-derive the evidence that already exists on this machine. Synchronous, no
   * network, no external source: safe to run on a cold read so the catalog is
   * populated as soon as provider discovery is, without the operator having to
   * know they must press Refresh first. Split from `refresh` deliberately —
   * startup must never wait on a K8 source.
   */
  refreshLocalEvidence(): RefreshAttempt[] {
    const attempts: RefreshAttempt[] = [];
    const run = (name: string, collect: () => CatalogObservation[]): void => {
      const startedAt = nowIso(this.now);
      try {
        const observations = collect();
        this.store(observations);
        attempts.push({ source: name, status: 'ok', entries: observations.length });
        this.recordAttempt(name, 'ok', observations.length, undefined, startedAt);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        attempts.push({ source: name, status: 'failed', entries: 0, detail });
        this.recordAttempt(name, 'failed', 0, detail, startedAt);
      }
    };

    run('provider-discovery', () => this.discoveryObservations());
    run('observed-runs', () => this.observedRunObservations());
    run('price-seed', () => this.priceSeedObservations());
    this.hydrated = true;
    return attempts;
  }

  /**
   * Local evidence plus any registered external source. Never throws: a failing
   * source is recorded in `model_catalog_refresh` and the previously stored rows
   * stay readable under the freshness policy.
   */
  async refresh(): Promise<RefreshAttempt[]> {
    const attempts = this.refreshLocalEvidence();

    for (const source of this.sources) {
      const startedAt = nowIso(this.now);
      try {
        const result = await source.collect({ fetch: this.fetchImpl });
        const observations = Array.isArray(result) ? result : result.observations;
        const okDetail = Array.isArray(result) ? undefined : result.detail;
        this.store(observations);
        attempts.push({ source: source.name, status: 'ok', entries: observations.length, detail: okDetail });
        this.recordAttempt(source.name, 'ok', observations.length, okDetail, startedAt);
      } catch (err) {
        // A source may hand us a fixed classification label (`CatalogSourceError`);
        // otherwise a generic one. NEVER the raw transport error — it can echo the
        // request or a credential (§3, §16).
        const label = classifiedDetail(err);
        const detail = `${source.name}: ${label}`;
        attempts.push({ source: source.name, status: 'failed', entries: 0, detail });
        this.recordAttempt(source.name, 'failed', 0, detail, startedAt);
      }
    }
    return attempts;
  }

  /**
   * Merged catalog, one entry per (provider, model id). Higher-priority evidence
   * establishes the entry; weaker evidence fills only the gaps it left, and each
   * filled field keeps the provenance of the source that supplied it.
   */
  list(): ModelCatalogEntry[] {
    this.hydrateOnce();
    const rows = this.db
      .prepare('SELECT provider, model_id, source, tier, observed_at, catalog_revision, entry_json FROM model_catalog')
      .all() as Array<{ provider: string; model_id: string; source: EvidenceSource | ExternalEvidenceSource; tier: Provenance['tier']; observed_at: string; catalog_revision: string; entry_json: string }>;
    const prices = this.pricesByModel();
    const availability = this.availabilityFromDiscovery();
    const nowMs = this.now().getTime();

    const byModel = new Map<string, ModelCatalogEntry>();
    const ranked = [...rows].sort((a, b) =>
      CATALOG_SOURCE_PRIORITY[b.source] - CATALOG_SOURCE_PRIORITY[a.source] || b.observed_at.localeCompare(a.observed_at));
    for (const row of ranked) {
      const observed = JSON.parse(row.entry_json) as CatalogObservation;
      const key = modelKey(row.provider, row.model_id);

      // External benchmark priors (K8): they never establish an entry, never
      // fill an identity/price gap. Attach to an entry a stronger source already
      // built; drop silently if none — a prior is not catalog availability (§13,
      // §14). Ranked last, so `existing` is fully built by now.
      if (row.tier === 'external-benchmark') {
        const entry = byModel.get(key);
        if (!entry || !observed.benchmarks?.length) continue;
        entry.benchmarkPriors = [
          ...(entry.benchmarkPriors ?? []),
          ...observed.benchmarks.map((p) => ({
            ...p,
            freshness: freshnessOf(p.provenance.observedAt, 'external-benchmark', nowMs),
          })),
        ];
        continue;
      }

      const provenance: Provenance = {
        source: row.source, tier: row.tier, observedAt: row.observed_at,
        normalizationVersion: CATALOG_NORMALIZATION_VERSION, attribution: observed.provenance.attribution,
      };
      const existing = byModel.get(key);
      if (!existing) {
        byModel.set(key, {
          schemaVersion: 2,
          modelKey: key,
          modelId: row.model_id,
          provider: row.provider,
          displayName: attribute(observed.displayName, provenance),
          aliases: (observed.aliases ?? []).map((value) => ({ value, provenance })),
          contextWindowTokens: attribute(observed.contextWindowTokens, provenance),
          maxOutputTokens: attribute(observed.maxOutputTokens, provenance),
          capabilities: attribute(observed.capabilities, provenance),
          pricing: prices.get(key) ?? [],
          availableVia: availability.get(key) ?? [],
          status: observed.status ?? 'unknown',
          provenance,
          freshness: freshnessOf(row.observed_at, row.tier, nowMs),
          catalogRevision: row.catalog_revision,
        });
        continue;
      }
      // Weaker evidence only fills gaps the stronger source left empty — and the
      // filled field carries THIS row's provenance, not the entry's.
      existing.displayName ??= attribute(observed.displayName, provenance);
      existing.contextWindowTokens ??= attribute(observed.contextWindowTokens, provenance);
      existing.maxOutputTokens ??= attribute(observed.maxOutputTokens, provenance);
      existing.capabilities ??= attribute(observed.capabilities, provenance);
      for (const value of observed.aliases ?? []) {
        if (!existing.aliases.some((a) => a.value === value)) existing.aliases.push({ value, provenance });
      }
    }
    return [...byModel.values()].sort((a, b) => a.modelKey.localeCompare(b.modelKey));
  }

  /**
   * Resolve a public identifier to exactly ONE entry. Accepted forms, in order:
   * `provider:modelId`, a bare model id, a known alias. A bare id or alias that
   * several providers claim is ambiguous — the caller gets the candidates and no
   * entry, because picking one of them would attribute a provider's evidence to
   * a model it never described.
   */
  resolve(ref: string): { entry?: ModelCatalogEntry; candidates: ModelCatalogEntry[] } {
    const entries = this.list();
    const byKey = entries.filter((e) => e.modelKey === ref);
    const byId = byKey.length ? byKey : entries.filter((e) => e.modelId === ref);
    const matched = byId.length ? byId : entries.filter((e) => e.aliases.some((a) => a.value === ref));
    return { entry: matched.length === 1 ? matched[0] : undefined, candidates: matched };
  }

  /** The stored rows behind a merged entry, unflattened (canonical API contract). */
  evidenceFor(entry: ModelCatalogEntry): CatalogEvidenceRow[] {
    const nowMs = this.now().getTime();
    const rows = this.db
      .prepare('SELECT provider, model_id, source, tier, observed_at, catalog_revision, entry_json FROM model_catalog WHERE provider = ? AND model_id = ?')
      .all(entry.provider, entry.modelId) as Array<{ provider: string; model_id: string; source: EvidenceSource | ExternalEvidenceSource; tier: Provenance['tier']; observed_at: string; catalog_revision: string; entry_json: string }>;
    return rows
      .map((row) => ({
        provider: row.provider,
        modelId: row.model_id,
        source: row.source,
        tier: row.tier,
        observedAt: row.observed_at,
        freshness: freshnessOf(row.observed_at, row.tier, nowMs),
        catalogRevision: row.catalog_revision,
        observation: JSON.parse(row.entry_json) as CatalogObservation,
      }))
      .sort((a, b) => CATALOG_SOURCE_PRIORITY[b.source] - CATALOG_SOURCE_PRIORITY[a.source] || b.observedAt.localeCompare(a.observedAt));
  }

  refreshes(limit = 20): Array<{ source: string; status: string; entries: number; detail: string | null; startedAt: string; finishedAt: string }> {
    return (this.db
      .prepare('SELECT source, status, entries, detail, started_at, finished_at FROM model_catalog_refresh ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ source: string; status: string; entries: number; detail: string | null; started_at: string; finished_at: string }>)
      .map((r) => ({ source: r.source, status: r.status, entries: r.entries, detail: r.detail, startedAt: r.started_at, finishedAt: r.finished_at }));
  }

  // --- sources ------------------------------------------------------------

  /**
   * Cold start: a workspace that has synced provider discovery but never pressed
   * Refresh still has a catalog. Local only, once per process — routing never
   * depends on this, and no external source is contacted.
   */
  private hydrateOnce(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    const { n } = this.db.prepare('SELECT COUNT(*) n FROM model_catalog').get() as { n: number };
    if (n === 0) this.refreshLocalEvidence();
  }

  /** Provider discovery is the authority for which assistant can serve what. */
  private discoveryObservations(): CatalogObservation[] {
    const observedAt = nowIso(this.now);
    const out: CatalogObservation[] = [];
    for (const assistant of this.registry.list()) {
      const manifest = assistant.manifestParsed;
      if (!manifest) continue;
      const source = manifest.evidence.source;
      for (const model of manifest.core.models) {
        out.push({
          modelId: model.id,
          provider: assistant.provider,
          displayName: model.displayName,
          status: assistant.enabled === 1 ? 'available' : 'unknown',
          provenance: {
            source, tier: tierFor(source),
            observedAt: manifest.evidence.observedAt || observedAt,
            normalizationVersion: CATALOG_NORMALIZATION_VERSION,
            attribution: `capability discovery for ${assistant.id}`,
          },
        });
      }
    }
    return out;
  }

  /**
   * Models this workspace has actually been served, from persisted run
   * evidence. `runtime-probe` because it is our own measurement — and it only
   * ever contains ids a provider reported. Grouped by serving provider so an
   * observation merges onto the provider that actually served it.
   */
  private observedRunObservations(): CatalogObservation[] {
    const rows = this.db
      .prepare(`SELECT r.model_resolved model_id, a.provider provider, MAX(r.started_at) observed_at
                  FROM runs r JOIN assistants a ON a.id = r.assistant_id
                 WHERE r.model_resolved IS NOT NULL
                 GROUP BY r.model_resolved, a.provider`)
      .all() as Array<{ model_id: string; provider: string; observed_at: string }>;
    return rows.map((row) => ({
      modelId: row.model_id,
      provider: row.provider,
      status: 'available' as const,
      provenance: {
        source: 'runtime-probe' as const, tier: 'measured-own' as const,
        observedAt: row.observed_at, normalizationVersion: CATALOG_NORMALIZATION_VERSION,
        attribution: 'provider-reported model identity on this workspace’s own runs',
      },
    }));
  }

  private priceSeedObservations(): CatalogObservation[] {
    return PRICE_SEED.map((seed) => {
      const provenance: Provenance = {
        // Pinned, never `now`: refreshing a snapshot does not re-observe it.
        source: 'manual', tier: 'manual', observedAt: PRICE_SEED_OBSERVED_AT,
        normalizationVersion: CATALOG_NORMALIZATION_VERSION,
        attribution: `manually transcribed from the published provider pricing page on ${PRICE_SEED_VERSION}`,
      };
      return {
        modelId: seed.modelId, provider: seed.provider, aliases: seed.aliases,
        provenance, pricing: [{ ...seed.price, provenance }],
      };
    });
  }

  // --- persistence ---------------------------------------------------------

  private store(observations: CatalogObservation[]): void {
    this.db.transaction(() => {
      for (const observation of observations) {
        this.db
          .prepare(`INSERT INTO model_catalog (provider, model_id, source, tier, observed_at, catalog_revision, entry_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(provider, model_id, source) DO UPDATE SET
                      tier = excluded.tier, observed_at = excluded.observed_at,
                      catalog_revision = excluded.catalog_revision, entry_json = excluded.entry_json`)
          .run(observation.provider, observation.modelId, observation.provenance.source, observation.provenance.tier,
            observation.provenance.observedAt, CATALOG_REVISION, JSON.stringify(observation));
        for (const price of observation.pricing ?? []) {
          this.db
            .prepare(`INSERT INTO model_prices (provider, model_id, pricing_version, serving_provider, account_kind, source, tier, observed_at, price_json)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(provider, model_id, pricing_version, serving_provider, account_kind) DO UPDATE SET
                        source = excluded.source, tier = excluded.tier, observed_at = excluded.observed_at, price_json = excluded.price_json`)
            .run(observation.provider, observation.modelId, price.pricingVersion, price.appliesTo?.servingProvider ?? '*',
              price.appliesTo?.accountKind ?? '*', price.provenance.source, price.provenance.tier,
              price.provenance.observedAt, JSON.stringify(price));
        }
      }
    })();
  }

  private recordAttempt(source: string, status: string, entries: number, detail: string | undefined, startedAt: string): void {
    this.db
      .prepare('INSERT INTO model_catalog_refresh (source, status, detail, entries, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(source, status, detail ?? null, entries, startedAt, nowIso(this.now));
  }

  /** Keyed by `provider:modelId`: a price binds to the provider's model, not to a bare id. */
  private pricesByModel(): Map<string, ModelPriceView[]> {
    const nowMs = this.now().getTime();
    const rows = this.db
      .prepare('SELECT provider, model_id, tier, observed_at, price_json FROM model_prices ORDER BY pricing_version DESC')
      .all() as Array<{ provider: string; model_id: string; tier: Provenance['tier']; observed_at: string; price_json: string }>;
    const out = new Map<string, ModelPriceView[]>();
    for (const row of rows) {
      const key = modelKey(row.provider, row.model_id);
      const list = out.get(key) ?? [];
      const evidence = JSON.parse(row.price_json) as ModelPriceEvidence;
      // Freshness is read-time, from the evidence's own observation time.
      list.push({ ...evidence, freshness: freshnessOf(evidence.provenance.observedAt, evidence.provenance.tier, nowMs) });
      out.set(key, list);
    }
    return out;
  }

  /** JOIN, not a second availability system: discovery decides, M12 renders. */
  private availabilityFromDiscovery(): Map<string, AssistantId[]> {
    const out = new Map<string, AssistantId[]>();
    for (const assistant of this.registry.list()) {
      const manifest: CapabilityManifest | null = assistant.manifestParsed;
      if (!manifest || assistant.enabled !== 1) continue;
      for (const model of manifest.core.models) {
        // Keyed by the serving provider's identity: Codex's `default` is not
        // Cursor's, so availability never crosses providers.
        const key = modelKey(assistant.provider, model.id);
        const list = out.get(key) ?? [];
        list.push(assistant.id as AssistantId);
        out.set(key, list);
      }
    }
    return out;
  }
}
