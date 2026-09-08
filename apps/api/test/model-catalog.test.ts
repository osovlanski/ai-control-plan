/**
 * K7 model catalog + price evidence (M12, I-M1, I-M3).
 *
 * The catalog stores evidence with provenance. It does not rank models, it does
 * not decide availability, and a price in it does not authorize cost
 * enforcement — those are K8/K13 and standing deferral #3 respectively.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantId } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import type { CatalogSource } from '../src/modules/model-catalog.js';
import { randomBytes } from 'node:crypto';
import { atomicWriteCredential, credentialPath, readCredential } from '../src/auth/credential-file.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
const A = 'fake-a' as AssistantId;
/** Mutable so a test can move past a TTL without waiting for one. */
let clock = new Date('2030-01-01T00:00:00Z');
const now = () => clock;

async function boot(
  sources: CatalogSource[] = [],
  fetchImpl?: typeof globalThis.fetch,
  assistants: ResolvedConfig['assistants'] = { [A]: { provider: 'fake' } },
) {
  home = mkdtempSync(join(tmpdir(), 'k7-catalog-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = assistants;
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now, modelCatalogSources: sources, ...(fetchImpl ? { modelCatalogFetch: fetchImpl } : {}) });
  built.registry.init(); await built.registry.syncAll();
}
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets.at(-1)!.secret}` }; }

/** Appends a credential carrying exactly these capabilities; `headers()` uses it. */
function setCaps(capabilities: string[]) {
  const file = readCredential(credentialPath(config.dir));
  file.secrets.push({
    kid: `k_${randomBytes(4).toString('hex')}`,
    secret: randomBytes(32).toString('base64url'),
    capabilities, createdAt: now().toISOString(), notAfter: null,
  });
  atomicWriteCredential(credentialPath(config.dir), file);
}

afterEach(async () => {
  clock = new Date('2030-01-01T00:00:00Z');
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  built = undefined as unknown as BuiltServer;
});

describe('catalog evidence', () => {
  it('gives every fact a source, tier and observation time', async () => {
    await boot();
    await built.modelCatalog.refresh();
    const models = built.modelCatalog.list();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.provenance.source).toBeTruthy();
      expect(model.provenance.tier).toBeTruthy();
      expect(Number.isNaN(Date.parse(model.provenance.observedAt))).toBe(false);
      expect(model.provenance.normalizationVersion).toBe('1.0');
      expect(model.freshness).toBeTruthy();
      expect(model.catalogRevision).toBeTruthy();
    }
  });

  it('takes assistant availability from provider discovery, never from the catalog itself', async () => {
    await boot();
    await built.modelCatalog.refresh();
    const discovered = built.registry.list()[0]!.manifestParsed!.core.models.map((m) => m.id);
    for (const model of built.modelCatalog.list()) {
      // A model no assistant advertises stays listed, but with no availability.
      const expected = discovered.includes(model.modelId) ? [A] : [];
      expect(model.availableVia).toEqual(expected);
    }
  });

  it('keeps price evidence versioned, attributed and scoped — never a bare number', async () => {
    await boot();
    await built.modelCatalog.refresh();
    const priced = built.modelCatalog.list().filter((m) => m.pricing.length > 0);
    expect(priced.length).toBeGreaterThan(0);
    for (const price of priced.flatMap((m) => m.pricing)) {
      expect(price.pricingVersion).toBeTruthy();
      expect(price.currency).toBe('USD');
      expect(price.provenance.tier).toBe('manual');
      expect(price.provenance.attribution).toContain('transcribed');
      expect(price.appliesTo?.servingProvider).toBeTruthy();
    }
  });
});

describe('catalog refresh', () => {
  it('sends no task, prompt, repository or usage content to an external source', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const recording: typeof globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const source: CatalogSource = {
      name: 'stub-remote',
      collect: async (ctx) => {
        await ctx.fetch('https://models.example/catalog', { method: 'POST', body: JSON.stringify({ want: 'models' }) });
        return [];
      },
    };
    await boot([source], recording);
    // Give the workspace real task/prompt/repository content to leak.
    const created = await built.app.inject({
      method: 'POST', url: '/api/tasks', headers: headers(),
      payload: { goal: 'refactor the billing secret rotation', constraints: ['do not touch prod'] },
    });
    expect(created.statusCode).toBe(201);

    await built.modelCatalog.refresh();
    expect(requests).toHaveLength(1);
    const egress = `${requests[0]!.url} ${requests[0]!.body}`;
    for (const term of ['refactor the billing', 'do not touch prod', home, 'AG-', 'inputTokens']) {
      expect(egress).not.toContain(term);
    }
  });

  it('records a failing source and leaves the stored catalog readable', async () => {
    const flaky: CatalogSource = {
      name: 'offline-source',
      collect: async () => { throw new Error('getaddrinfo ENOTFOUND models.example'); },
    };
    await boot([flaky]);
    const attempts = await built.modelCatalog.refresh();
    expect(attempts.find((a) => a.source === 'offline-source')).toMatchObject({ status: 'failed' });
    // The classified detail never echoes the transport error.
    expect(attempts.find((a) => a.source === 'offline-source')!.detail).not.toContain('ENOTFOUND');
    // Local evidence still landed, and routing (registry-driven) is untouched.
    expect(built.modelCatalog.list().length).toBeGreaterThan(0);
    expect(built.registry.list()[0]!.manifestParsed).toBeTruthy();
    const failure = built.modelCatalog.refreshes().find((r) => r.source === 'offline-source');
    expect(failure?.status).toBe('failed');
  });
});

describe('models API', () => {
  it('requires models.read and serves catalog entries', async () => {
    await boot();
    await built.modelCatalog.refresh();
    const unauthenticated = await built.app.inject({ method: 'GET', url: '/api/models' });
    expect(unauthenticated.statusCode).toBe(401);

    const ok = await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { models: Array<{ modelId: string }> };
    expect(body.models.length).toBeGreaterThan(0);

    const one = await built.app.inject({ method: 'GET', url: `/api/models/${body.models[0]!.modelId}`, headers: headers() });
    expect(one.statusCode).toBe(200);
    const missing = await built.app.inject({ method: 'GET', url: '/api/models/nope', headers: headers() });
    expect(missing.statusCode).toBe(404);
  });

  it('fails closed for a credential without models.read', async () => {
    await boot();
    setCaps(['tasks.read']);
    const res = await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() });
    expect(res.statusCode).toBe(403);
  });

  it('gates refresh behind commands.write', async () => {
    await boot();
    setCaps(['models.read']);
    const denied = await built.app.inject({ method: 'POST', url: '/api/models/refresh', headers: headers() });
    expect(denied.statusCode).toBe(403);

    setCaps(['commands.write', 'models.read']);
    const allowed = await built.app.inject({ method: 'POST', url: '/api/models/refresh', headers: headers() });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { attempts: unknown[] }).attempts.length).toBeGreaterThan(0);
  });
});

/**
 * Model ids are not globally unique. Codex (openai) and Cursor both advertise a
 * model whose id is literally `default`; a catalog keyed on the id alone merged
 * them into one entry and let the higher-priority source overwrite the other
 * provider's evidence.
 */
describe('provider-safe identity', () => {
  const CODEX = 'codex-a' as AssistantId;
  const CURSOR = 'cursor-a' as AssistantId;
  const bootBoth = () => boot([], undefined, {
    [CODEX]: { provider: 'openai' },
    [CURSOR]: { provider: 'cursor' },
  });

  it('keeps Codex `default` and Cursor `default` as two model identities', async () => {
    await bootBoth();
    await built.modelCatalog.refresh();
    const defaults = built.modelCatalog.list().filter((m) => m.modelId === 'default');
    expect(defaults.map((m) => m.modelKey).sort()).toEqual(['cursor:default', 'openai:default']);

    const codex = defaults.find((m) => m.provider === 'openai')!;
    const cursor = defaults.find((m) => m.provider === 'cursor')!;
    // Each keeps the evidence its own provider supplied — neither overwrote the other.
    expect(codex.provenance.source).toBe('local-config');
    expect(cursor.provenance.source).toBe('runtime-probe');
    expect(codex.displayName?.value).toBe('Codex default (CLI-configured)');
    expect(cursor.displayName?.value).toBe('Cursor default');
    // Availability joins to the provider/model identity, not to the bare id.
    expect(codex.availableVia).toEqual([CODEX]);
    expect(cursor.availableVia).toEqual([CURSOR]);
  });

  it('merges observed-run evidence onto the provider that actually served it', async () => {
    await bootBoth();
    db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES ('AG-9','g','{}','t','t')").run();
    db.prepare(`INSERT INTO runs (id, task_id, assistant_id, state, started_at, model_resolved, model_resolved_source)
                VALUES ('run-9','AG-9',?, 'ENDED_OK','2029-12-01T00:00:00Z','default','run.started')`).run(CODEX);
    await built.modelCatalog.refresh();

    const evidence = (provider: string) => {
      const entry = built.modelCatalog.list().find((m) => m.modelKey === `${provider}:default`)!;
      return built.modelCatalog.evidenceFor(entry).map((row) => row.source);
    };
    expect(evidence('openai')).toContain('runtime-probe');   // the run happened here
    expect(evidence('cursor')).toEqual(['runtime-probe']);   // …and only its own discovery row
    expect(built.modelCatalog.list().find((m) => m.modelKey === 'cursor:default')!
      .provenance.attribution).toContain('capability discovery');
  });

  it('refuses to guess a provider for an ambiguous id, and resolves the qualified one', async () => {
    await bootBoth();
    await built.modelCatalog.refresh();
    const ambiguous = await built.app.inject({ method: 'GET', url: '/api/models/default', headers: headers() });
    expect(ambiguous.statusCode).toBe(409);
    expect((ambiguous.json() as { candidates: string[] }).candidates.sort())
      .toEqual(['cursor:default', 'openai:default']);

    const qualified = await built.app.inject({ method: 'GET', url: '/api/models/openai:default', headers: headers() });
    expect(qualified.statusCode).toBe(200);
    expect((qualified.json() as { provider: string }).provider).toBe('openai');
  });

  it('binds price evidence to the priced provider only', async () => {
    await bootBoth();
    await built.modelCatalog.refresh();
    // The seeded prices are Anthropic's; no `default` model inherits them.
    for (const entry of built.modelCatalog.list().filter((m) => m.modelId === 'default')) {
      expect(entry.pricing).toEqual([]);
    }
    const priced = built.modelCatalog.list().filter((m) => m.pricing.length > 0);
    expect(priced.length).toBeGreaterThan(0);
    for (const entry of priced) expect(entry.provider).toBe('anthropic');
  });
});

/**
 * A merged entry can hold facts from several sources. Each fact must keep the
 * provenance of the source that supplied it — a gap filled by a weaker source
 * must not appear to have been reported by the stronger one.
 */
describe('field-level provenance', () => {
  const official: CatalogSource = {
    name: 'stub-official',
    collect: async () => [{
      modelId: 'merge-probe', provider: 'fake', displayName: 'Official name',
      provenance: {
        source: 'provider-api', tier: 'provider-official',
        observedAt: '2029-12-31T00:00:00Z', normalizationVersion: '1.0',
        attribution: 'provider model listing',
      },
    }],
  };
  const weak: CatalogSource = {
    name: 'stub-manual',
    collect: async () => [{
      modelId: 'merge-probe', provider: 'fake', displayName: 'Hand-typed name',
      contextWindowTokens: 200_000, capabilities: { vision: true },
      provenance: {
        source: 'manual', tier: 'manual',
        observedAt: '2029-12-30T00:00:00Z', normalizationVersion: '1.0',
        attribution: 'hand-transcribed from a docs page',
      },
    }],
  };

  it('keeps each merged field attributable to the evidence that supplied it', async () => {
    await boot([official, weak]);
    await built.modelCatalog.refresh();
    const entry = built.modelCatalog.list().find((m) => m.modelKey === 'fake:merge-probe')!;

    // The stronger source establishes the entry and owns the field it reported.
    expect(entry.provenance.source).toBe('provider-api');
    expect(entry.displayName).toEqual({ value: 'Official name', provenance: expect.objectContaining({ source: 'provider-api' }) });
    // The gap it left is filled by the weaker source — with the weaker source's provenance.
    expect(entry.contextWindowTokens?.value).toBe(200_000);
    expect(entry.contextWindowTokens?.provenance.source).toBe('manual');
    expect(entry.contextWindowTokens?.provenance.observedAt).toBe('2029-12-30T00:00:00Z');
    expect(entry.capabilities?.provenance.tier).toBe('manual');
  });

  it('returns the unmerged evidence rows from GET /api/models/:id', async () => {
    await boot([official, weak]);
    await built.modelCatalog.refresh();
    const res = await built.app.inject({ method: 'GET', url: '/api/models/fake:merge-probe', headers: headers() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { evidence: Array<{ source: string; observedAt: string; observation: { displayName?: string } }> };
    expect(body.evidence.map((e) => e.source)).toEqual(['provider-api', 'manual']);
    // Both sources' own claims survive, including the one merging discarded.
    expect(body.evidence.map((e) => e.observation.displayName)).toEqual(['Official name', 'Hand-typed name']);

    // The list stays the merged projection — evidence rows are detail only.
    const list = await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() });
    expect((list.json() as { models: Array<Record<string, unknown>> }).models[0]).not.toHaveProperty('evidence');
  });
});

describe('cold start', () => {
  it('lists the models configured assistants expose without a manual refresh', async () => {
    let contacted = 0;
    const external: CatalogSource = { name: 'stub-remote', collect: async () => { contacted += 1; return []; } };
    await boot([external]);
    // Deliberately no POST /api/models/refresh: a fresh workspace has synced
    // provider discovery and nothing else.
    const res = await built.app.inject({ method: 'GET', url: '/api/models', headers: headers() });
    expect(res.statusCode).toBe(200);
    const models = (res.json() as { models: Array<{ modelKey: string }> }).models;
    const discovered = built.registry.list()[0]!.manifestParsed!.core.models.map((m) => `fake:${m.id}`);
    expect(discovered.length).toBeGreaterThan(0);
    for (const key of discovered) expect(models.map((m) => m.modelKey)).toContain(key);
    // Hydration is local-first: no external source is contacted on a read.
    expect(contacted).toBe(0);
  });
});

/**
 * A pinned price snapshot is a historical observation. Re-running refresh must
 * not restamp it as observed today, or a 2026 price reads as fresh in 2027.
 */
describe('price snapshot freshness', () => {
  it('does not become live again just because the catalog was refreshed', async () => {
    clock = new Date('2026-09-08T00:30:00Z');
    await boot();
    await built.modelCatalog.refresh();
    const first = built.modelCatalog.list().find((m) => m.modelKey === 'anthropic:claude-opus-4-1')!;
    expect(first.pricing[0]!.freshness).toBe('live');
    const snapshotObservedAt = first.pricing[0]!.provenance.observedAt;

    // Well past the 30-day manual TTL, then refresh again.
    clock = new Date('2027-03-01T00:00:00Z');
    await built.modelCatalog.refresh();
    const after = built.modelCatalog.list().find((m) => m.modelKey === 'anthropic:claude-opus-4-1')!;
    expect(after.pricing[0]!.provenance.observedAt).toBe(snapshotObservedAt);
    expect(after.pricing[0]!.freshness).toBe('expired');
    expect(after.pricing[0]!.pricingVersion).toBe(first.pricing[0]!.pricingVersion);
    // The refresh attempt itself is recorded as having happened now.
    expect(built.modelCatalog.refreshes().find((r) => r.source === 'price-seed')!.startedAt)
      .toBe('2027-03-01T00:00:00.000Z');
  });
});
