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
import type { Registry } from '../src/modules/registry.js';
import {
  createArtificialAnalysisSource,
  parseAaBody,
  CatalogSourceError,
  AA_ENDPOINT,
  AA_SPEED_SCALE_MAX,
  AA_SPEED_CONFIGURATION,
  AA_MODEL_MAP,
} from '../src/modules/artificial-analysis.js';
import { ModelCatalogService } from '../src/modules/model-catalog.js';
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
      intelligence_index_version: 4.1,
      data: [
        {
          id: 'claude-4-1-opus', slug: 'claude-4-1-opus', model_creator: { id: 'anthropic' },
          evaluations: { artificial_analysis_coding_index: 71 },
          performance: { median_output_tokens_per_second: 88 },
        },
        { name: 'no id here', evaluations: { artificial_analysis_coding_index: 99 } },
        'garbage',
        null,
      ],
    };
    const { observations, detail } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations).toHaveLength(1);
    expect(observations[0]!.modelId).toBe('claude-opus-4-1');
    expect(detail).toContain('1 mapped');
    expect(detail).toContain('1 no-id');
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
    expect(req.url).toBe(`${AA_ENDPOINT}?page=1`);
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

describe('model identity mapping (§12, §13, P1-B)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'x', slug: 'x', model_creator: { id: 'anthropic' },
    evaluations: { artificial_analysis_coding_index: 60 },
    performance: { median_output_tokens_per_second: 100 },
    ...over,
  });
  const parseRows = (data: unknown[]) =>
    parseAaBody({ intelligence_index_version: 4.1, data }, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));

  it('attaches a prior only on an exact AA stable-id + creator match', async () => {
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

  it('maps on the stable AA id -> reviewed (provider, modelId), never to a bare id', () => {
    const { observations } = parseRows([row({ id: 'claude-4-5-sonnet' })]);
    expect(observations[0]!.provider).toBe('anthropic');
    expect(observations[0]!.modelId).toBe('claude-sonnet-4-5');
  });

  it('the stable id is the authority: a changed slug on a mapped id still maps (test #5)', () => {
    const { observations } = parseRows([row({ id: 'claude-4-1-opus', slug: 'anthropic-opus-renamed-2027' })]);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.modelId).toBe('claude-opus-4-1');
    expect(observations[0]!.benchmarks![0]!.sourceModelId).toBe('claude-4-1-opus');
  });

  it('a slug collision alone never misattributes: unknown id, mapped slug -> unmatched (test #6)', () => {
    const mappedSlug = AA_MODEL_MAP[0]!.aaSlugHint!;
    const { observations, detail } = parseRows([row({ id: 'totally-unknown-id', slug: mappedSlug })]);
    expect(observations).toHaveLength(0);
    expect(detail).toContain('1 unmatched');
  });

  it('a creator mismatch on a mapped id never maps (test #7)', () => {
    const { observations, detail } = parseRows([row({ id: 'claude-4-1-opus', model_creator: { id: 'not-anthropic' } })]);
    expect(observations).toHaveLength(0);
    expect(detail).toContain('1 creator-mismatch');
  });

  it('a reasoning/effort variant id is left unmatched; the base id keeps its own score (test #8)', async () => {
    // fixture carries `claude-4-5-sonnet-max` (anthropic) alongside the base `claude-4-5-sonnet`.
    await boot([aaFixtureSource()]);
    const attempts = await built.modelCatalog.refresh();
    expect(attempts.find((a) => a.source === 'artificial-analysis')!.detail).toContain('2 unmatched');
    const sonnet = built.modelCatalog.list().find((m) => m.modelKey === sonnetKey)!;
    // base row coding index is 66; the "max" variant's 78 must not leak in.
    expect(codingOf(sonnet)!.raw.value).toBe(66);
    expect(built.modelCatalog.list().map((m) => m.modelKey)).not.toContain('anthropic:claude-4-5-sonnet-max');
  });
});

// --- 11-14. provenance, raw+normalized, versioning, determinism ---------------

describe('external provenance and normalization audit trail', () => {
  it('carries source, external tier, benchmark release/category, attribution and dates (test #2)', async () => {
    await boot([aaFixtureSource()]);
    await built.modelCatalog.refresh();
    const coding = codingOf(built.modelCatalog.list().find((m) => m.modelKey === opusKey))!;
    expect(coding.provenance.source).toBe('external:artificial-analysis');
    expect(coding.provenance.tier).toBe('external-benchmark');
    // release derives from the documented ROOT `intelligence_index_version` (4.1).
    expect(coding.provenance.benchmark).toMatchObject({ release: 'intelligence-index-4.1', category: 'coding' });
    // AA supplies no benchmark publication date — never faked.
    expect(coding.provenance.benchmark!.publishedAt).toBeUndefined();
    // …but the MODEL's own release_date rides along, kept distinct from publishedAt.
    expect(coding.provenance.benchmark!.modelReleaseDate).toBe('2025-08-05');
    expect(coding.provenance.benchmark!.modelReleaseDate).not.toBe(coding.provenance.observedAt);
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
      data: [{
        id: 'claude-4-1-opus', slug: 'claude-4-1-opus', model_creator: { id: 'anthropic' },
        evaluations: { artificial_analysis_coding_index: 71 },
        performance: { median_output_tokens_per_second: 88 },
      }],
    };
    const { observations, detail } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    expect(observations[0]!.benchmarks!.map((b) => b.dimension)).toEqual(['speed']);
    expect(detail).toContain('no benchmark release');
  });

  it('parses speed from the documented performance.* location (test #4)', () => {
    const body = {
      intelligence_index_version: 4.1,
      data: [{
        id: 'claude-4-1-opus', slug: 'claude-4-1-opus', model_creator: { id: 'anthropic' },
        evaluations: { artificial_analysis_coding_index: 71 },
        performance: { median_output_tokens_per_second: 123, median_time_to_first_token_seconds: 0.5 },
      }],
    };
    const { observations } = parseAaBody(body, '2030-01-01T00:00:00Z', Date.parse('2030-01-01T00:00:00Z'));
    const speed = observations[0]!.benchmarks!.find((b) => b.dimension === 'speed')!;
    expect(speed.raw).toEqual({ metric: 'median_output_tokens_per_second', value: 123, unit: 'tokens/second' });
    expect(speed.provenance.benchmark!.configuration).toBe(AA_SPEED_CONFIGURATION);
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
      intelligence_index_version: 4.1,
      data: [{
        id: 'claude-4-1-opus', slug: 'claude-4-1-opus', model_creator: { id: 'anthropic' },
        evaluations: { artificial_analysis_coding_index: null },
        performance: { median_output_tokens_per_second: 88 },
      }],
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
    expect(after.ruleFired).toBe(before.ruleFired);
    // K13 now records a SHADOW model recommendation on the same decision. AA
    // evidence reaching that record is exactly what K8 fed it — what must stay
    // true is that it changes nothing the router or the runner acts on.
    expect(after.modelRecommendation?.mode).toBe('shadow');
    expect(after.modelRecommendation?.activation.active).toBe(false);
    const { modelRecommendation: _after, ...afterRouting } = after;
    const { modelRecommendation: _before, ...beforeRouting } = before;
    expect(afterRouting).toEqual(beforeRouting);
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

// --- pagination (test #3) --------------------------------------------------

describe('pagination', () => {
  it('follows pagination.has_more across pages and stamps ONE observedAt for the refresh', async () => {
    const urls: string[] = [];
    const page1 = {
      intelligence_index_version: 4.1,
      pagination: { page: 1, page_size: 1, total_pages: 2, has_more: true },
      data: [{
        id: 'claude-4-1-opus', slug: 'claude-4-1-opus', model_creator: { id: 'anthropic' },
        release_date: '2025-08-05',
        evaluations: { artificial_analysis_coding_index: 71 },
        performance: { median_output_tokens_per_second: 88 },
      }],
    };
    const page2 = {
      intelligence_index_version: 4.1,
      pagination: { page: 2, page_size: 1, total_pages: 2, has_more: false },
      data: [{
        id: 'claude-4-5-sonnet', slug: 'claude-4-5-sonnet', model_creator: { id: 'anthropic' },
        release_date: '2025-09-29',
        evaluations: { artificial_analysis_coding_index: 66 },
        performance: { median_output_tokens_per_second: 130 },
      }],
    };
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('page=2') ? page2 : page1;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], fetchImpl);
    const attempts = await built.modelCatalog.refresh();

    expect(urls).toEqual([`${AA_ENDPOINT}?page=1`, `${AA_ENDPOINT}?page=2`]);
    const aa = attempts.find((a) => a.source === 'artificial-analysis')!;
    expect(aa.status).toBe('ok');
    expect(aa.detail).toContain('2 page(s)');
    expect(aa.detail).toContain('2 mapped');

    const list = built.modelCatalog.list();
    const opus = codingOf(list.find((m) => m.modelKey === opusKey))!;
    const sonnet = codingOf(list.find((m) => m.modelKey === sonnetKey))!;
    expect(opus.raw.value).toBe(71); // from page 1
    expect(sonnet.raw.value).toBe(66); // from page 2
    expect(opus.provenance.observedAt).toBe(sonnet.provenance.observedAt); // one logical refresh
  });

  it('does not loop forever when has_more never clears — stops at AA_MAX_PAGES', async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ intelligence_index_version: 4.1, pagination: { has_more: true }, data: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await boot([createArtificialAnalysisSource({ apiKey: FAKE_KEY, now })], fetchImpl);
    await built.modelCatalog.refresh();
    expect(calls).toBe(20); // AA_MAX_PAGES
  });
});

// --- K13 readiness: availability is a real discovery join, never AA-granted (tests #9, #10) ---

describe('K13 readiness — candidate availability is derived, not granted', () => {
  const manifestModels = (ids: string[]) => ({
    core: { models: ids.map((id) => ({ id, displayName: id })) },
    evidence: { source: 'provider-api' as const, observedAt: '2030-01-01T00:00:00.000Z' },
  });
  const stubRegistry = (advertise: string[]) => ({
    list: () => [{
      id: 'anthropic-cli' as AssistantId,
      provider: 'anthropic',
      enabled: 1,
      manifestParsed: manifestModels(advertise),
    }],
  }) as unknown as Registry;

  it('a prior rides an entry whether or not discovery makes it runnable', async () => {
    await boot(); // sets up db + schema; its own catalog is unused here
    // discovery advertises the dated opus id -> that (provider, modelId) is runnable
    const withOpus = new ModelCatalogService(db, stubRegistry(['claude-opus-4-1']), now, [aaFixtureSource()]);
    await withOpus.refresh();
    const opus = withOpus.list().find((m) => m.modelKey === opusKey)!;
    expect(opus.availableVia).toEqual(['anthropic-cli']); // real join from discovery
    expect(codingOf(opus)).toBeTruthy(); // AA prior still attached

    // discovery advertises nothing -> same AA prior, but no availability is invented
    const noDiscovery = new ModelCatalogService(db, stubRegistry([]), now, [aaFixtureSource()]);
    await noDiscovery.refresh();
    const sonnet = noDiscovery.list().find((m) => m.modelKey === sonnetKey)!;
    expect(sonnet.availableVia).toEqual([]);
    expect(codingOf(sonnet)).toBeTruthy();
    expect(sonnet.provenance.source).not.toBe('external:artificial-analysis');
  });
});
