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
const now = () => new Date('2030-01-01T00:00:00Z');

async function boot(sources: CatalogSource[] = [], fetchImpl?: typeof globalThis.fetch) {
  home = mkdtempSync(join(tmpdir(), 'k7-catalog-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' } };
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
