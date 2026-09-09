/**
 * K8 — one verified external benchmark source (Artificial Analysis).
 *
 * AA supplies PRIOR evidence about model intelligence only: attributed,
 * versioned, freshness-aware, egress-bounded. It never chooses a model, never
 * writes price authority, never grants availability. Acceptance map:
 * docs/agentic-os-k8-artificial-analysis.md §"Acceptance criteria → tests".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantId } from '@agent-plane/core';
import { normalizeBenchmark, AA_NORMALIZATION_VERSION, type BenchmarkPrior } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import type { CatalogSource } from '../src/modules/model-catalog.js';
import {
  createArtificialAnalysisSource,
  parseAaBody,
  CatalogSourceError,
  AA_ENDPOINT,
  AA_SPEED_SCALE_MAX,
} from '../src/modules/artificial-analysis.js';
import { randomBytes } from 'node:crypto';
import { atomicWriteCredential, credentialPath, readCredential } from '../src/auth/credential-file.js';
import fixture from './fixtures/artificial-analysis-models.json' with { type: 'json' };

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
const A = 'fake-a' as AssistantId;
let clock = new Date('2030-01-01T00:00:00Z');
const now = () => clock;
/** A placeholder credential value — not a real key, not token-shaped. */
const FAKE_KEY = 'aa-test-placeholder';

async function boot(sources: CatalogSource[] = [], fetchImpl?: typeof globalThis.fetch) {
  home = mkdtempSync(join(tmpdir(), 'k8-aa-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' } };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now, modelCatalogSources: sources, ...(fetchImpl ? { modelCatalogFetch: fetchImpl } : {}) });
  built.registry.init(); await built.registry.syncAll();
}
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret}` }; }
function setCaps(capabilities: string[]) {
  const file = readCredential(credentialPath(config.dir));
  file.secrets.push({ kid: `k_${randomBytes(4).toString('hex')}`, secret: randomBytes(32).toString('base64url'), capabilities, createdAt: now().toISOString(), notAfter: null });
  atomicWriteCredential(credentialPath(config.dir), file);
}
/** The real AA source, fed a fixture body instead of the network. */
const aaFixtureSource = (body: unknown = fixture) => createArtificialAnalysisSource({ apiKey: FAKE_KEY, now, fixtureBody: body });

afterEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

const opusKey = 'anthropic:claude-opus-4-1';
const sonnetKey = 'anthropic:claude-sonnet-4-5';
const codingOf = (entry: { benchmarkPriors?: BenchmarkPrior[] } | undefined): BenchmarkPrior | undefined =>
  entry?.benchmarkPriors?.find((p) => p.dimension === 'coding');
const speedOf = (entry: { benchmarkPriors?: BenchmarkPrior[] } | undefined): BenchmarkPrior | undefined =>
  entry?.benchmarkPriors?.find((p) => p.dimension === 'speed');

// --- 1. missing key ------------------------------------------------------------

describe('missing AA_API_KEY', () => {
  it('leaves the local catalog fully usable and records the source as not configured', async () => {
    await boot([createArtificialAnalysisSource({ apiKey: undefined, now })]);
    const attempts = await built.modelCatalog.refresh();
    const aa = attempts.find((a) => a.source === 'artificial-analysis')!;
    expect(aa.status).toBe('failed');
    expect(aa.detail).toContain('not configured');
    const models = built.modelCatalog.list();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.benchmarkPriors === undefined)).toBe(true);
    const id = built.tasks.create({ goal: 'ship it' }).taskId;
    expect(built.orchestrator.routeTask(id, 'intake').explanation.chosen).toBe(A);
  });
});

// --- 2. valid response -> evidence stored ------------------------------------

describe('valid source response', () => {
  it('stores a normalized coding + speed prior on the mapped catalog entry', async () => {
    await boot([aaFixtureSource()]);
    const attempts = await built.modelCatalog.refresh();
    const aa = attempts.find((a) => a.source === 'artificial-analysis')!;
    expect(aa.status).toBe('ok');
    expect(aa.detail).toContain('2 mapped');

    const opus = built.modelCatalog.list().find((m) => m.modelKey === opusKey)!;
    const coding = codingOf(opus)!;
    expect(coding.normalized).toBeCloseTo(0.71, 5);
    expect(coding.dimension).toBe('coding');
    expect(speedOf(opus)!.normalized).toBeCloseTo(88 / AA_SPEED_SCALE_MAX, 5);
  });

  it('exposes the priors through GET /api/models and the unmerged row through /:id', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const list = await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() });
    const opus = (list.json() as { models: Array<{ modelKey: string; benchmarkPriors?: unknown[] }> })
      .models.find((m) => m.modelKey === opusKey)!;
    expect(opus.benchmarkPriors).toHaveLength(2);

    const detail = await built.app.inject({ method: 'GET', url: `/api/models/${opusKey}`, headers: headers() });
    const evidence = (detail.json() as { evidence: Array<{ source: string; observation: { benchmarks?: unknown[] } }> }).evidence;
    const aaRow = evidence.find((e) => e.source === 'external:artificial-analysis')!;
    expect(aaRow.observation.benchmarks).toHaveLength(2);
  });
});

// --- 3. 401/403 -------------------------------------------------------------

describe('source 401/403', () => {
  it('classifies as unauthorized and never leaks the key or body', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => new Response('{"error":"forbidden"}', { status: 403 });
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], fetchImpl);
    const attempts = await built.modelCatalog.refresh();
    const aa = attempts.find((a) => a.source === 'artificial-analysis')!;
    expect(aa.status).toBe('failed');
    expect(aa.detail).toContain('unauthorized');
    expect(aa.detail).not.toContain(FAKE_KEY);
    const stored = built.modelCatalog.refreshes().find((r) => r.source === 'artificial-analysis')!;
    expect(stored.detail).not.toContain(FAKE_KEY);
  });
});

// --- 4. network failure -> local-first ------------------------------------

describe('timeout / network failure', () => {
  it('records the failure, keeps the local catalog readable and routing running', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => { throw new Error('ETIMEDOUT connect 1.2.3.4:443'); };
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], fetchImpl);
    const attempts = await built.modelCatalog.refresh();
    const aa = attempts.find((a) => a.source === 'artificial-analysis')!;
    expect(aa.status).toBe('failed');
    expect(aa.detail).not.toContain('ETIMEDOUT');
    expect(aa.detail).not.toContain('1.2.3.4');
    expect(built.modelCatalog.list().length).toBeGreaterThan(0);
    const id = built.tasks.create({ goal: 'route anyway' }).taskId;
    expect(built.orchestrator.routeTask(id, 'intake').explanation.chosen).toBe(A);
  });
});

// --- 5-6. malformed / partial -------------------------------------------------

describe('malformed and partial responses', () => {
  it('rejects a body with no data array', () => {
    expect(() => parseAaBody({ status: 200 }, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z')))
      .toThrow(CatalogSourceError);
  });

  it('rejects non-JSON from the transport as malformed, storing nothing', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 200 });
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], fetchImpl);
    const attempts = await built.modelCatalog.refresh();
    expect(attempts.find((a) => a.source === 'artificial-analysis')!.detail).toContain('malformed response');
    expect(built.modelCatalog.list().every((m) => m.benchmarkPriors === undefined)).toBe(true);
  });

  it('stores only the valid rows from a partial payload', () => {
    const body = {
      prompt_options: { prompt_length: 'medium', parallel_queries: 1 },
      intelligence_index_version: '4.3',
      data: [
        { slug: 'claude-4-1-opus', evaluations: { artificial_analysis_coding_index: 71 }, median_output_tokens_per_second: 88 },
        { name: 'no slug here', evaluations: { artificial_analysis_coding_index: 99 } },
        'garbage',
        null,
      ],
    };
    const { observations, detail } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations).toHaveLength(1);
    expect(observations[0]!.modelId).toBe('claude-opus-4-1');
    expect(detail).toContain('1 mapped');
  });
});

// --- 7. egress recorder ---------------------------------------------------------

describe('egress boundary (I-M3)', () => {
  it('sends only the benchmark request — no task, prompt, repo, branch, usage or cost data', async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const recording: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], recording);

    const created = await built.app.inject({
      method: 'POST', url: '/api/tasks', headers: headers(),
      payload: { goal: 'migrate the payments ledger on branch release/pci', constraints: ['never touch prod db'] },
    });
    expect(created.statusCode).toBe(201);

    await built.modelCatalog.refresh();
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe(AA_ENDPOINT);
    expect(req.method).toBe('GET');
    expect(req.body).toBe('');
    expect(Object.keys(req.headers).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'x-api-key']);

    const wire = `${req.url} ${JSON.stringify(req.headers)} ${req.body}`;
    for (const term of [
      'migrate the payments', 'never touch prod', 'release/pci', home, 'AG-',
      'inputTokens', 'outputTokens', 'costUsd', 'checkpoint', 'transcript', 'repoPath',
    ]) {
      expect(wire).not.toContain(term);
    }
  });
});

// --- 8-10. model identity mapping -------------------------------------------

describe('model identity mapping (§12, §13)', () => {
  it('attaches a prior only on an exact AA-slug -> (provider, modelId) match', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    expect(codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))).toBeTruthy();
    expect(codingOf(built.modelCatalog.list().find((m) => m.modelKey === sonnetKey))).toBeTruthy();
  });

  it('never fuzzy-matches: an unmapped AA model is counted, not attached anywhere', async () => {
    await boot([aaFixtureSource()]);
    const attempts = await built.modelCatalog.refresh();
    expect(attempts.find((a) => a.source === 'artificial-analysis')!.detail).toContain('2 unmatched');
    const keys = built.modelCatalog.list().map((m) => m.modelKey);
    expect(keys).not.toContain('acme:some-frontier-model');
    expect(built.modelCatalog.list().filter((m) => m.modelId === 'default').every((m) => m.benchmarkPriors === undefined)).toBe(true);
  });

  it('maps an AA slug to the reviewed (provider, modelId), never to a bare id', () => {
    const body = {
      prompt_options: { prompt_length: 'medium', parallel_queries: 1 },
      intelligence_index_version: '4.3',
      data: [{ slug: 'claude-4-5-sonnet', evaluations: { artificial_analysis_coding_index: 66 }, median_output_tokens_per_second: 130 }],
    };
    const { observations } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations[0]!.provider).toBe('anthropic');
    expect(observations[0]!.modelId).toBe('claude-sonnet-4-5');
  });
});

// --- 11-14. provenance, raw+normalized, versioning, determinism ---------------

describe('external provenance and normalization audit trail', () => {
  it('carries source, external tier, benchmark release/category, attribution and both dates', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const coding = codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))!;
    expect(coding.provenance.source).toBe('external:artificial-analysis');
    expect(coding.provenance.tier).toBe('external-benchmark');
    expect(coding.provenance.benchmark).toMatchObject({ release: 'intelligence-index-4.3', category: 'coding' });
    expect(coding.provenance.benchmark!.publishedAt).toBeUndefined();
    expect(coding.provenance.observedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(coding.provenance.attribution).toContain('Artificial Analysis');
    expect(coding.provenance.attribution).toContain('artificialanalysis.ai');
  });

  it('retains the raw metric, unit and source model id behind every normalized value (§9)', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const opus = built.modelCatalog.list().find((m) => m.modelKey === opusKey)!;
    expect(codingOf(opus)!.raw).toEqual({ metric: 'artificial_analysis_coding_index', value: 71, unit: 'index-0-100' });
    expect(speedOf(opus)!.raw).toEqual({ metric: 'median_output_tokens_per_second', value: 88, unit: 'tokens/second' });
    expect(codingOf(opus)!.sourceModelId).toBe('claude-4-1-opus');
  });

  it('stamps the normalization version on every prior (§10)', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const opus = built.modelCatalog.list().find((m) => m.modelKey === opusKey)!;
    for (const p of opus.benchmarkPriors!) expect(p.normalizationVersion).toBe(AA_NORMALIZATION_VERSION);
    expect(AA_NORMALIZATION_VERSION).toBe('aa-normalization-v1');
  });

  it('coding priors are skipped, with a diagnostic, when the response carries no benchmark release (§7)', () => {
    const body = {
      prompt_options: { prompt_length: 'medium', parallel_queries: 1 },
      data: [{ slug: 'claude-4-1-opus', evaluations: { artificial_analysis_coding_index: 71 }, median_output_tokens_per_second: 88 }],
    };
    const { observations, detail } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations[0]!.benchmarks!.map((b) => b.dimension)).toEqual(['speed']);
    expect(detail).toContain('no benchmark release');
  });
});

describe('deterministic normalization (§11)', () => {
  it('is a fixed absolute rescale: higher-is-better, clamped, order-preserving', () => {
    expect(normalizeBenchmark({ value: 71, direction: 'higher', scaleMax: 100 })).toBeCloseTo(0.71, 10);
    expect(normalizeBenchmark({ value: 250, direction: 'higher', scaleMax: 200 })).toBe(1);
    expect(normalizeBenchmark({ value: -5, direction: 'higher', scaleMax: 100 })).toBe(0);
  });

  it('handles lower-is-better metrics (e.g. latency)', () => {
    expect(normalizeBenchmark({ value: 0, direction: 'lower', scaleMax: 10 })).toBe(1);
    expect(normalizeBenchmark({ value: 10, direction: 'lower', scaleMax: 10 })).toBe(0);
    expect(normalizeBenchmark({ value: 2.5, direction: 'lower', scaleMax: 10 })).toBeCloseTo(0.75, 10);
  });

  it('ties map to equal outputs; a zero/negative scale is rejected, never divides', () => {
    const a = normalizeBenchmark({ value: 42, direction: 'higher', scaleMax: 100 });
    const b = normalizeBenchmark({ value: 42, direction: 'higher', scaleMax: 100 });
    expect(a).toBe(b);
    expect(normalizeBenchmark({ value: 1, direction: 'higher', scaleMax: 0 })).toBeUndefined();
    expect(normalizeBenchmark({ value: Number.NaN, direction: 'higher', scaleMax: 100 })).toBeUndefined();
  });

  it('is byte-identical across two runs of the same input', () => {
    const once = parseAaBody(fixture, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    const twice = parseAaBody(fixture, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

// --- 15. missing coding value ------------------------------------------------

describe('missing values', () => {
  it('emits only the dimensions the row actually supports', () => {
    const body = {
      prompt_options: { prompt_length: 'medium', parallel_queries: 1 },
      intelligence_index_version: '4.3',
      data: [{ slug: 'claude-4-1-opus', evaluations: { artificial_analysis_coding_index: null }, median_output_tokens_per_second: 88 }],
    };
    const { observations } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations[0]!.benchmarks!.map((b) => b.dimension)).toEqual(['speed']);
  });
});

// --- 16-19. freshness / TTL --------------------------------------------------

describe('freshness and TTL (external 30 d)', () => {
  it('ages from live through fresh, stale and expired on the clock alone', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const freshnessNow = () => codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))!.freshness;
    expect(freshnessNow()).toBe('live');
    clock = new Date('2030-01-15T00:00:00Z'); expect(freshnessNow()).toBe('fresh');
    clock = new Date('2030-02-15T00:00:00Z'); expect(freshnessNow()).toBe('stale');
    clock = new Date('2030-04-15T00:00:00Z'); expect(freshnessNow()).toBe('expired');
  });

  it('an expired prior stays inspectable in the entry and in the evidence rows', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    clock = new Date('2030-06-01T00:00:00Z');
    const opus = built.modelCatalog.list().find((m) => m.modelKey === opusKey)!;
    expect(codingOf(opus)!.freshness).toBe('expired');
    expect(codingOf(opus)!.raw.value).toBe(71);
    const evidence = built.modelCatalog.evidenceFor(opus);
    expect(evidence.some((e) => e.source === 'external:artificial-analysis')).toBe(true);
  });

  it('a later failed refresh does not restamp observedAt or refresh freshness', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const real = aaFixtureSource();
    const flappy: CatalogSource = {
      name: 'artificial-analysis',
      collect: (ctx) => (mode === 'ok' ? real.collect(ctx) : Promise.reject(new CatalogSourceError('unavailable'))),
    };
    await boot([flappy]);
    await built.modelCatalog.refresh();
    const observedAt = codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))!.provenance.observedAt;

    clock = new Date('2030-03-01T00:00:00Z');
    mode = 'fail';
    const attempts = await built.modelCatalog.refresh();
    expect(attempts.find((a) => a.source === 'artificial-analysis')!.status).toBe('failed');
    const after = codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))!;
    expect(after.provenance.observedAt).toBe(observedAt);
    expect(after.freshness).toBe('stale');
  });
});

// --- 20. availability stays registry-owned ---------------------------------

describe('provider availability remains registry-owned (§14)', () => {
  it('a benchmark prior never adds availability or changes status/identity', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    for (const key of [opusKey, sonnetKey]) {
      const entry = built.modelCatalog.list().find((m) => m.modelKey === key)!;
      expect(entry.availableVia).toEqual([]);
      expect(entry.provenance.source).not.toBe('external:artificial-analysis');
      expect(entry.status).not.toBe('available');
    }
  });
});

// --- 21. routing is unchanged ---------------------------------------------

describe('K8 evidence cannot alter routing (§22)', () => {
  it('routes a task to the same assistant before and after AA evidence is loaded', async () => {
    await boot([aaFixtureSource()]);
    const id = built.tasks.create({ goal: 'unchanged routing' }).taskId;
    const before = built.orchestrator.routeTask(id, 'intake').explanation;
    await built.modelCatalog.refresh();
    const after = built.orchestrator.routeTask(id, 'intake').explanation;
    expect(after.chosen).toBe(before.chosen);
    expect(JSON.stringify(after)).not.toContain('modelRecommendation');
    expect(JSON.stringify(after)).not.toContain('artificial-analysis');
  });
});

// --- 22. no pricing authority expansion -------

describe('no pricing authority expansion (§21)', () => {
  it('ingests no AA price data — the priced entries keep only the manual seed', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const opus = built.modelCatalog.list().find((m) => m.modelKey === opusKey)!;
    expect(opus.pricing.every((p) => p.provenance.source !== 'external:artificial-analysis')).toBe(true);
    expect(opus.pricing.every((p) => p.provenance.tier === 'manual')).toBe(true);
    const priceRows = db.prepare('SELECT source FROM model_prices').all() as Array<{ source: string }>;
    expect(priceRows.every((r) => r.source !== 'external:artificial-analysis')).toBe(true);
    expect(built.modelCatalog.list().some((m) => m.benchmarkPriors?.length)).toBe(true);
  });
});

// --- capability gate reused from K7 -----------------------------------------

describe('API capability gate (unchanged from K7)', () => {
  it('serves priors under models.read and refuses without it', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    setCaps(['tasks.read']);
    expect((await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() })).statusCode).toBe(403);
    setCaps(['models.read']);
    expect((await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() })).statusCode).toBe(200);
  });
});
