import {
  CATALOG_NORMALIZATION_VERSION,
  EVIDENCE_PRIORITY,
  freshnessOf,
} from '@agent-plane/core';
import type {
  AssistantId,
  CapabilityManifest,
  EvidenceSource,
  ModelCatalogEntry,
  ModelPriceEvidence,
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
 * NOT implemented here, deliberately: benchmark ingestion (K8) and any scoring
 * or model selection (K13). This module answers "what do we know about this
 * model, and how do we know it" — nothing chooses a model from it.
 */

/** Bumped when the merge/normalization of catalog facts changes. */
export const CATALOG_REVISION = '2026-09-08.1';

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
}

/**
 * A catalog evidence source. `collect` receives ONLY a transport — no task,
 * prompt, repository or usage content is available to it, so none can be sent
 * (I-M3). Sources must not throw for network failure; they may, and refresh
 * classifies it.
 */
export interface CatalogSource {
  name: string;
  collect(ctx: { fetch: typeof globalThis.fetch }): Promise<CatalogObservation[]>;
}

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

/** Manifest evidence describes how the adapter learned its model list. */
function tierFor(source: EvidenceSource): Provenance['tier'] {
  if (source === 'provider-api') return 'provider-official';
  if (source === 'runtime-probe') return 'measured-own';
  return 'manual';
}

export class ModelCatalogService {
  constructor(
    private db: Db,
    private registry: Registry,
    private now: () => Date = () => new Date(),
    /** Network / external sources. Empty at K7 — the seam K8 plugs into. */
    private sources: CatalogSource[] = [],
    private fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /**
   * Re-derive local evidence and poll any registered sources. Never throws: a
   * failing source is recorded in `model_catalog_refresh` and the previously
   * stored rows stay readable under the freshness policy.
   */
  async refresh(): Promise<RefreshAttempt[]> {
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

    for (const source of this.sources) {
      const startedAt = nowIso(this.now);
      try {
        const observations = await source.collect({ fetch: this.fetchImpl });
        this.store(observations);
        attempts.push({ source: source.name, status: 'ok', entries: observations.length });
        this.recordAttempt(source.name, 'ok', observations.length, undefined, startedAt);
      } catch (err) {
        // Classified, never the raw error: a fetch failure can echo the request.
        const detail = err instanceof Error ? `${source.name} source unavailable` : 'source unavailable';
        attempts.push({ source: source.name, status: 'failed', entries: 0, detail });
        this.recordAttempt(source.name, 'failed', 0, detail, startedAt);
      }
    }
    return attempts;
  }

  /** Merged catalog. Higher-priority evidence wins per field; ties break newest. */
  list(): ModelCatalogEntry[] {
    const rows = this.db
      .prepare('SELECT model_id, source, provider, tier, observed_at, catalog_revision, entry_json FROM model_catalog')
      .all() as Array<{ model_id: string; source: EvidenceSource; provider: string; tier: Provenance['tier']; observed_at: string; catalog_revision: string; entry_json: string }>;
    const prices = this.pricesByModel();
    const availability = this.availabilityFromDiscovery();
    const nowMs = this.now().getTime();

    const byModel = new Map<string, ModelCatalogEntry>();
    const ranked = [...rows].sort((a, b) =>
      EVIDENCE_PRIORITY[b.source] - EVIDENCE_PRIORITY[a.source] || b.observed_at.localeCompare(a.observed_at));
    for (const row of ranked) {
      const observed = JSON.parse(row.entry_json) as CatalogObservation;
      const existing = byModel.get(row.model_id);
      if (!existing) {
        byModel.set(row.model_id, {
          schemaVersion: 1,
          modelId: row.model_id,
          provider: row.provider,
          displayName: observed.displayName,
          aliases: observed.aliases ?? [],
          contextWindowTokens: observed.contextWindowTokens,
          maxOutputTokens: observed.maxOutputTokens,
          capabilities: observed.capabilities,
          pricing: prices.get(row.model_id) ?? [],
          availableVia: availability.get(row.model_id) ?? [],
          status: observed.status ?? 'unknown',
          provenance: { source: row.source, tier: row.tier, observedAt: row.observed_at, normalizationVersion: CATALOG_NORMALIZATION_VERSION, attribution: observed.provenance.attribution },
          freshness: freshnessOf(row.observed_at, row.tier, nowMs),
          catalogRevision: row.catalog_revision,
        });
        continue;
      }
      // Weaker evidence only fills gaps the stronger source left empty.
      existing.displayName ??= observed.displayName;
      existing.contextWindowTokens ??= observed.contextWindowTokens;
      existing.maxOutputTokens ??= observed.maxOutputTokens;
      existing.capabilities ??= observed.capabilities;
      for (const alias of observed.aliases ?? []) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    }
    return [...byModel.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  /** By model id or by a known alias — aliases resolve for READS only. */
  get(idOrAlias: string): ModelCatalogEntry | undefined {
    const entries = this.list();
    return entries.find((e) => e.modelId === idOrAlias) ?? entries.find((e) => e.aliases.includes(idOrAlias));
  }

  refreshes(limit = 20): Array<{ source: string; status: string; entries: number; detail: string | null; startedAt: string; finishedAt: string }> {
    return (this.db
      .prepare('SELECT source, status, entries, detail, started_at, finished_at FROM model_catalog_refresh ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ source: string; status: string; entries: number; detail: string | null; started_at: string; finished_at: string }>)
      .map((r) => ({ source: r.source, status: r.status, entries: r.entries, detail: r.detail, startedAt: r.started_at, finishedAt: r.finished_at }));
  }

  // --- sources ------------------------------------------------------------

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
   * ever contains ids a provider reported.
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
    const observedAt = nowIso(this.now);
    return PRICE_SEED.map((seed) => {
      const provenance: Provenance = {
        source: 'manual', tier: 'manual', observedAt,
        normalizationVersion: CATALOG_NORMALIZATION_VERSION,
        attribution: 'manually transcribed from the published provider pricing page',
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
          .prepare(`INSERT INTO model_catalog (model_id, source, provider, tier, observed_at, catalog_revision, entry_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(model_id, source) DO UPDATE SET
                      provider = excluded.provider, tier = excluded.tier, observed_at = excluded.observed_at,
                      catalog_revision = excluded.catalog_revision, entry_json = excluded.entry_json`)
          .run(observation.modelId, observation.provenance.source, observation.provider, observation.provenance.tier,
            observation.provenance.observedAt, CATALOG_REVISION, JSON.stringify(observation));
        for (const price of observation.pricing ?? []) {
          this.db
            .prepare(`INSERT INTO model_prices (model_id, pricing_version, serving_provider, account_kind, source, tier, observed_at, price_json)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT(model_id, pricing_version, serving_provider, account_kind) DO UPDATE SET
                        source = excluded.source, tier = excluded.tier, observed_at = excluded.observed_at, price_json = excluded.price_json`)
            .run(observation.modelId, price.pricingVersion, price.appliesTo?.servingProvider ?? '*',
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

  private pricesByModel(): Map<string, ModelPriceEvidence[]> {
    const rows = this.db
      .prepare('SELECT model_id, price_json FROM model_prices ORDER BY pricing_version DESC')
      .all() as Array<{ model_id: string; price_json: string }>;
    const out = new Map<string, ModelPriceEvidence[]>();
    for (const row of rows) {
      const list = out.get(row.model_id) ?? [];
      list.push(JSON.parse(row.price_json) as ModelPriceEvidence);
      out.set(row.model_id, list);
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
        const list = out.get(model.id) ?? [];
        list.push(assistant.id as AssistantId);
        out.set(model.id, list);
      }
    }
    return out;
  }
}
