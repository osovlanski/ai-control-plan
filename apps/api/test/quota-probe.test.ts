import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantId } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler } from '../src/modules/scheduler.js';
import { QuotaProjection } from '../src/modules/quota.js';
import { PROBE_INTERVAL_MS, QuotaProbeService, probeQuota, type ProbeOutcome, type QuotaProbeFn } from '../src/modules/quota-probe.js';

const A = 'fake-a' as AssistantId, B = 'fake-b' as AssistantId;
let built: BuiltServer;
let home: string;
let db: Db;
let config: ResolvedConfig;
let clock = new Date('2026-09-06T12:00:00.000Z');
const now = () => clock;
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

async function boot(quotaProbe: boolean) {
  clock = new Date('2026-09-06T12:00:00.000Z');
  home = mkdtempSync(join(tmpdir(), 'k3-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } };
  config.scheduler = { ...config.scheduler!, quotaProbe };
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
afterEach(async () => {
  if (built && db?.open) { await built.orchestrator.shutdown(); await built.app.close(); if (db.open) db.close(); }
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const ok = (usedPercent: number, resetsAt?: string): ProbeOutcome =>
  ({ status: 'ok', buckets: [{ bucket: 'five_hour', usedPercent, resetsAt }] });
function service(probe: QuotaProbeFn): QuotaProbeService {
  return new QuotaProbeService(db, config, built.registry, probe, now);
}
/** Every row of every table, for leak assertions. */
function dbText(): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name);
  return tables.map(t => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

describe('K3 quota probes', () => {
  it('records a successful probe as a provider-api observation scoped to account and bucket', async () => {
    await boot(true);
    const attempts = await service(async () => ok(42, '2026-09-06T17:00:00.000Z')).refresh([A]);
    expect(attempts).toEqual([{ assistantId: A, status: 'ok', attemptedAt: clock.toISOString(), detail: undefined }]);
    expect(db.prepare('SELECT * FROM quota_snapshots').all()).toEqual([expect.objectContaining({
      assistant_id: A, window: 'five_hour', used_percent: 42, resets_at: '2026-09-06T17:00:00.000Z',
      source: 'provider-api', observed_at: clock.toISOString(), account: 'fake',
    })]);
    // Only the named subject is probed.
    expect(db.prepare('SELECT * FROM quota_snapshots WHERE assistant_id = ?').all(B)).toHaveLength(0);
  });

  it('is off unless the operator enables it', async () => {
    await boot(false);
    const probe = vi.fn<QuotaProbeFn>(async () => ok(10));
    expect(await service(probe).refresh()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) c FROM quota_probes').get()).toMatchObject({ c: 0 });
  });

  it('rate-limits to one attempt per assistant per 15 minutes', async () => {
    await boot(true);
    const probe = vi.fn<QuotaProbeFn>(async () => ok(10));
    const s = service(probe);
    await s.refresh([A]);
    advance(PROBE_INTERVAL_MS - 1);
    expect(await s.refresh([A])).toEqual([{ assistantId: A, status: 'skipped-fresh', attemptedAt: clock.toISOString() }]);
    expect(probe).toHaveBeenCalledTimes(1);
    advance(1);
    expect((await s.refresh([A]))[0]!.status).toBe('ok');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('changes nothing when the endpoint is unavailable', async () => {
    await boot(true);
    await service(async () => ok(30)).refresh([A]);
    advance(PROBE_INTERVAL_MS);
    const before = new QuotaProjection(db, now).for(A, built.registry.manifest(A));
    const cooldownsBefore = built.cooldowns.list();
    const attempts = await service(async () => ({ status: 'unavailable', buckets: [], detail: 'usage endpoint unreachable' })).refresh([A]);
    expect(attempts[0]).toMatchObject({ status: 'unavailable' });
    expect(new QuotaProjection(db, now).for(A, built.registry.manifest(A))).toEqual(before);
    expect(built.cooldowns.list()).toEqual(cooldownsBefore);
    expect(db.prepare('SELECT COUNT(*) c FROM quota_snapshots').get()).toMatchObject({ c: 1 });
    // The attempt itself is still visible, so freshness stays honest.
    expect(service(async () => ok(0)).status()).toEqual([expect.objectContaining({ assistantId: A, outcome: 'unavailable', ageMs: 0 })]);
  });

  it('a probe that throws is contained and recorded as unavailable', async () => {
    await boot(true);
    const attempts = await service(async () => { throw new Error('boom'); }).refresh([A]);
    expect(attempts[0]).toMatchObject({ status: 'unavailable', detail: 'probe threw' });
    expect(db.prepare('SELECT COUNT(*) c FROM quota_snapshots').get()).toMatchObject({ c: 0 });
  });

  it('a fresh probe supersedes a stale run-stream snapshot and a stale probe never supersedes a fresh one', async () => {
    await boot(true);
    const manifest = built.registry.manifest(A);
    db.prepare("INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at, account) VALUES (?, 'five_hour', 95, NULL, 'runtime-probe', ?, 'fake')")
      .run(A, new Date(clock.getTime() - 60_000).toISOString());
    await service(async () => ok(12)).refresh([A]);
    expect(new QuotaProjection(db, now).for(A, manifest).quota).toEqual({ usedPercent: 12, resetsAt: undefined });

    advance(60_000);
    db.prepare("INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at, account) VALUES (?, 'five_hour', 88, NULL, 'runtime-probe', ?, 'fake')")
      .run(A, clock.toISOString());
    expect(new QuotaProjection(db, now).for(A, manifest).quota).toEqual({ usedPercent: 88, resetsAt: undefined });
  });

  it('an exhausted probe observation blocks routing with provider-api provenance', async () => {
    await boot(true);
    await service(async () => ok(100, new Date(clock.getTime() + 3_600_000).toISOString())).refresh([A]);
    const { blockers } = new QuotaProjection(db, now).for(A, built.registry.manifest(A));
    expect(blockers).toEqual([expect.objectContaining({
      assistantId: A, source: 'provider-api', kind: 'provider-reset', resetProvenance: 'provider-reported',
      scope: { account: 'fake', bucket: 'five_hour' },
    })]);
  });

  it('leaves reportsLimits false for an assistant whose run stream does not report limits', async () => {
    await boot(true);
    const before = built.registry.manifest(A)!;
    db.prepare("UPDATE assistants SET manifest = json_set(manifest, '$.core.reportsLimits', json('false')) WHERE id = ?").run(A);
    await service(async () => ok(20)).refresh([A]);
    const after = built.registry.manifest(A)!;
    expect(after.core.reportsLimits).toBe(false);
    // The probe is an observation, never a manifest capability.
    expect({ ...after, core: { ...after.core, reportsLimits: true } }).toEqual(before);
    expect(new QuotaProjection(db, now).for(A, after).quota).toEqual({ usedPercent: 20, resetsAt: undefined });
  });

  it('records probe attempts in wait history without spending the wake budget', async () => {
    await boot(true);
    const scheduler = new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now,
      probes: service(async () => ok(0)) });
    const id = built.tasks.create({ goal: 'wait for headroom' }).taskId;
    scheduler.attach(id, { kind: 'quota', notBefore: new Date(clock.getTime() - 1).toISOString(), assistants: [A] });
    const before = scheduler.condition(id)!;
    expect(before.autoWakes).toBe(0);

    await scheduler.runNow(id);
    const consumed = db.prepare('SELECT * FROM wait_conditions WHERE task_id = ? AND generation = ?').get(id, before.generation) as { history: string; auto_wakes: number };
    expect(JSON.parse(consumed.history)).toEqual([expect.objectContaining({ outcome: 'probe', reason: `${A}: ok` })]);
    expect(consumed.auto_wakes).toBe(0);
  });

  it('re-parks at wake without a provider start when the probe reports an exhausted window', async () => {
    await boot(true);
    const resetsAt = new Date(clock.getTime() + 3_600_000).toISOString();
    const scheduler = new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now,
      probes: service(async () => ok(100, resetsAt)) });
    const id = built.tasks.create({ goal: 'wait for headroom' }).taskId;
    scheduler.attach(id, { kind: 'quota', notBefore: new Date(clock.getTime() - 1).toISOString(), assistants: [A, B] });
    const parked = scheduler.condition(id)!;
    const starts = [A, B].map(assistant => vi.spyOn(built.registry.adapter(assistant), 'start'));

    await scheduler.runNow(id);

    for (const start of starts) expect(start).not.toHaveBeenCalled();
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
    const reparked = scheduler.condition(id)!;
    expect(reparked.generation).toBe(parked.generation + 1);
    expect(reparked.notBefore).toBe(resetsAt);
    expect(reparked.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ assistantId: A, source: 'provider-api', resetProvenance: 'provider-reported' })]));
    // The probe informed the decision; only the wake itself spent budget.
    const consumed = db.prepare('SELECT * FROM wait_conditions WHERE task_id = ? AND generation = ?').get(id, parked.generation) as { history: string; auto_wakes: number };
    expect(JSON.parse(consumed.history)).toEqual([expect.objectContaining({ outcome: 'probe', reason: `${A}: ok; ${B}: ok` })]);
    expect(consumed.auto_wakes).toBe(0);
    expect(reparked.autoWakes).toBe(1);
  });

  it('surfaces probe freshness on scheduler status', async () => {
    await boot(true);
    await built.quotaProbes.refresh([A]);
    const status = built.scheduler.status();
    expect(status.probesEnabled).toBe(true);
    expect(status.probes).toEqual([expect.objectContaining({ assistantId: A, ageMs: 0 })]);
  });
});

describe('K3 Claude usage probe', () => {
  const CREDENTIAL = 'k3-probe-oauth-credential-value';
  function credentials(): string {
    const path = join(home, 'claude-credentials.json');
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: CREDENTIAL, subscriptionType: 'max' } }), { mode: 0o600 });
    return path;
  }

  it('maps provider windows to buckets and never echoes the credential', async () => {
    await boot(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: 61, resets_at: '2026-09-06T17:00:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-09-12T00:00:00Z' },
      seven_day_opus: { utilization: 0 },
      account_uuid: 'not-a-window',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await probeQuota('anthropic', { credentialsPath: credentials(), usageEndpoint: 'https://usage.test/usage' });
    expect(outcome).toEqual({ status: 'ok', buckets: [
      { bucket: 'five_hour', usedPercent: 61, resetsAt: '2026-09-06T17:00:00.000Z' },
      { bucket: 'seven_day', usedPercent: 12, resetsAt: '2026-09-12T00:00:00.000Z' },
      { bucket: 'seven_day_opus', usedPercent: 0, resetsAt: undefined },
    ] });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers.authorization).toContain(CREDENTIAL);
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });

  it('never persists, logs or echoes the credential through the service', async () => {
    await boot(true);
    config.assistants[A] = { provider: 'anthropic', options: { credentialsPath: credentials(), usageEndpoint: 'https://usage.test/usage' } };
    db.prepare('UPDATE assistants SET provider = ? WHERE id = ?').run('anthropic', A);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 55, resets_at: '2026-09-06T17:00:00Z' } }), { status: 200 })));
    const logged: string[] = [];
    for (const stream of ['log', 'error', 'warn'] as const) vi.spyOn(console, stream).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });

    const attempts = await new QuotaProbeService(db, config, built.registry, probeQuota, now).refresh([A]);

    expect(attempts[0]).toMatchObject({ status: 'ok' });
    expect(db.prepare('SELECT used_percent FROM quota_snapshots').all()).toEqual([{ used_percent: 55 }]);
    expect(dbText()).not.toContain(CREDENTIAL);
    expect(logged.join('\n')).not.toContain(CREDENTIAL);
    expect(JSON.stringify(attempts)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(built.scheduler.status())).not.toContain(CREDENTIAL);
  });

  it.each([
    ['a rejected credential', 401, 'unauthorized'],
    ['an endpoint fault', 503, 'unavailable'],
  ] as const)('classifies %s without leaking the response', async (_label, status, expected) => {
    await boot(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`server echoed ${CREDENTIAL}`, { status })));
    const outcome = await probeQuota('anthropic', { credentialsPath: credentials(), usageEndpoint: 'https://usage.test/usage' });
    expect(outcome).toMatchObject({ status: expected, buckets: [] });
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });

  it('reports unauthorized without credentials and unavailable when the endpoint cannot be reached', async () => {
    await boot(true);
    expect(await probeQuota('anthropic', { credentialsPath: join(home, 'absent.json') })).toMatchObject({ status: 'unauthorized' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`connect ECONNREFUSED carrying ${CREDENTIAL}`); }));
    const outcome = await probeQuota('anthropic', { credentialsPath: credentials(), usageEndpoint: 'https://usage.test/usage' });
    expect(outcome).toMatchObject({ status: 'unavailable', detail: 'usage endpoint unreachable' });
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });

  it('reports unsupported for a provider with no verified idle endpoint, without inventing data', async () => {
    await boot(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const provider of ['openai', 'openrouter', 'cursor']) {
      expect(await probeQuota(provider, {})).toEqual({ status: 'unsupported', buckets: [], detail: `no verified idle quota endpoint for ${provider}` });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
