import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AssistantId, type QuotaBlocker } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler, type SchedulerDeps } from '../src/modules/scheduler.js';
import { QuotaProjection, controllingRetry } from '../src/modules/quota.js';

const A = 'fake-a' as AssistantId, B = 'fake-b' as AssistantId;
let built: BuiltServer;
let home: string;
let db: Db;
let config: ResolvedConfig;
async function boot(harness: boolean) {
  home = mkdtempSync(join(tmpdir(), 'k2-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } };
  config.execution.harnessModes.single = harness;
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init(); await built.registry.syncAll();
  return { db, config };
}
afterEach(async () => {
  if (built && db?.open) { await built.orchestrator.shutdown(); await built.app.close(); if (db.open) db.close(); }
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function scheduler(boundary?: SchedulerDeps['boundary']) {
  return new Scheduler({ db: db, config: config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, boundary });
}
const until = (ms: number) => new Date(Date.now() + ms).toISOString();
async function state(id: string, expected: string) { await vi.waitFor(() => expect(built.tasks.get(id)?.state).toBe(expected), { timeout: 5000 }); }

describe.each([false,true])('K2 Harness=%s', harness => {
  it.each(['routed','materialized'] as const)('recovers %s without contradictory decisions or duplicate requests', async phase => {
    await boot(harness);
    const s = scheduler(async p => { if (p === phase) throw new Error('crash'); });
    const id = built.tasks.create({ goal: 'finish this' }).taskId;
    s.attach(id, { kind: 'time', notBefore: until(-1) });
    await expect(s.runNow(id)).rejects.toThrow('crash');
    const before = db.prepare('SELECT * FROM execution_requests').all();
    built.cooldowns.penalize(A, 'limit', 'changed after committed route');
    const startA = vi.spyOn(built.registry.adapter(A), 'start');
    const startB = vi.spyOn(built.registry.adapter(B), 'start');
    await built.orchestrator.reconcileOnBoot(); await scheduler().reconcileOnBoot();
    await state(id, 'COMPLETED');
    expect(startA).toHaveBeenCalledTimes(1); expect(startB).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM routing_decisions WHERE task_id = ?').all(id)).toHaveLength(1);
    const after = db.prepare('SELECT * FROM execution_requests').all();
    expect(after).toHaveLength(1);
    if (phase === 'materialized') expect(after).toEqual(before);
  });
  it.each(['routed','materialized'] as const)('cancel at %s never permits a later start', async phase => {
    await boot(harness);
    const s = scheduler(async p => { if (p === phase) await s.cancel(id); });
    const id = built.tasks.create({ goal: 'cancel' }).taskId;
    s.attach(id, { kind: 'time', notBefore: until(-1) });
    const start = vi.spyOn(built.registry.adapter(A), 'start');
    await s.runNow(id).catch(() => {}); await scheduler().reconcileOnBoot();
    expect(start).not.toHaveBeenCalled(); expect(built.tasks.get(id)?.state).toBe('CANCELLED');
  });
  it('all blocked limit settles, checkpoints, parks with provenance, then resumes from its anchor', async () => {
    await boot(harness); const s = scheduler();
    built.cooldowns.penalize(B, 'limit', 'backup blocked', until(60_000));
    const id = built.tasks.create({ goal: 'continue [FAKE:LIMIT]' }).taskId;
    built.tasks.transition(id, 'ROUTING'); await built.orchestrator.startTask(id, A);
    await state(id, 'WAITING_RESOURCE');
    const wait = s.condition(id)!;
    expect(wait).toMatchObject({ kind: 'quota', checkpointId: expect.any(String), blockers: expect.arrayContaining([
      expect.objectContaining({ assistantId: A, source: 'runtime-probe', observedAt: expect.any(String), resetProvenance: 'provider-reported' }),
    ]) });
    const start = vi.spyOn(built.registry.adapter(B), 'start');
    // Explicit fresh observation, not mere passage of the cooldown deadline.
    built.cooldowns.clear(B);
    await s.runNow(id); await state(id, 'COMPLETED');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].prompt).toContain('continuing work');
    const dispatch = s.dispatches(id)[0]!;
    expect(dispatch.checkpoint_id).toBe(wait.checkpointId);
    const request = db.prepare('SELECT * FROM execution_requests WHERE id = ?').get(dispatch.dispatch_id) as { assistant_id: string; routing_decision_ref: string; origin_envelope_id: string | null };
    expect(request.assistant_id).toBe(B); expect(request.routing_decision_ref).toBe(String(dispatch.routing_decision_id));
    if (harness) expect(db.prepare('SELECT state FROM handoff_envelopes WHERE id = ?').get(request.origin_envelope_id)).toEqual({ state: 'consumed' });
  });
  it('revalidates an exhausted quota wait without starting and expires the bounded wake budget', async () => {
    await boot(harness); const s = scheduler();
    built.cooldowns.penalize(A, 'limit', 'blocked', until(60_000));
    built.cooldowns.penalize(B, 'limit', 'blocked', until(60_000));
    const id = built.tasks.create({ goal: 'wait' }).taskId;
    s.attach(id, { kind: 'quota', notBefore: until(-1) });
    const start = vi.spyOn(built.registry.adapter(A), 'start');
    for (let i = 0; i < 3; i++) await s.runNow(id);
    expect(start).not.toHaveBeenCalled(); expect(built.tasks.get(id)?.state).toBe('WAITING_INPUT');
    expect(s.condition(id)).toMatchObject({ state: 'expired', autoWakes: 3, history: expect.any(Array) });
  });
});

it('controlling reset is latest bucket per candidate then earliest candidate, ignoring filtered candidates', () => {
  const at = Date.now();
  const blocker = (id: AssistantId, minutes: number): QuotaBlocker => ({ assistantId: id, kind: 'provider-reset', scope: { bucket: String(minutes) }, source: 'runtime-probe', observedAt: new Date(at).toISOString(), retryAt: new Date(at + minutes * 60_000).toISOString(), resetProvenance: 'provider-reported', reason: 'limit' });
  const blockers = [blocker(A, 10), blocker(A, 40), blocker(B, 25), blocker('disabled' as AssistantId, 1)];
  expect(controllingRetry(blockers, [A, B])).toBe(new Date(at + 25 * 60_000).toISOString());
});
it('projection chooses newest account/bucket evidence before source priority', async () => {
  await boot(false); const now = Date.now();
  const insert = db.prepare('INSERT INTO quota_snapshots(assistant_id,window,used_percent,source,observed_at,account) VALUES(?,?,?,?,?,?)');
  insert.run(A,'five_hour',100,'runtime-probe',new Date(now-60_000).toISOString(),'account-a');
  insert.run(A,'five_hour',20,'provider-api',new Date(now).toISOString(),'account-a');
  const projection = new QuotaProjection(db, () => new Date(now));
  expect(projection.for(A,null).quota?.usedPercent).toBe(20);
  insert.run(A,'five_hour',90,'runtime-probe',new Date(now+1000).toISOString(),'account-a');
  expect(projection.for(A,null).quota?.usedPercent).toBe(90);
});

it.each([false,true])('unknown quota permits one bounded start; a repeated limit re-parks with inferred evidence (Harness=%s)', async harness => {
  await boot(harness); const s = scheduler();
  const adapter = built.registry.adapter(A); const events = adapter.events.bind(adapter);
  vi.spyOn(adapter, 'events').mockImplementation(async function* (handle) {
    for await (const event of events(handle)) {
      if (event.type === 'run.ended') {
        yield { ...event, type: 'limit.hit', summary: 'limit without a reset', payload: {} };
        yield { ...event, payload: { ok: false } };
      } else yield event;
    }
  });
  const start = vi.spyOn(adapter, 'start');
  const id = built.tasks.create({ goal: 'bounded attempt', overrides: { assistantId: A } }).taskId;
  s.attach(id, { kind: 'quota', notBefore: until(-1) });
  await s.runNow(id); await state(id, 'WAITING_RESOURCE');
  expect(start).toHaveBeenCalledTimes(1);
  expect(s.condition(id)).toMatchObject({ autoWakes: 1, blockers: expect.arrayContaining([
    expect.objectContaining({ kind: 'inferred-backoff', resetProvenance: 'inferred' }),
  ]) });
  expect(Date.parse(s.condition(id)!.notBefore) - Date.now()).toBeGreaterThan(29 * 60_000);
  await s.runNow(id); await s.runNow(id);
  expect(start).toHaveBeenCalledTimes(1); expect(built.tasks.get(id)?.state).toBe('WAITING_INPUT');
});

it('a missing settled Harness result prevents converting parked work', async () => {
  await boot(true);
  const { SessionStore } = await import('../src/modules/harness/session-store.js');
  const { buildExecutionRequest } = await import('../src/modules/harness/control-plane-bridge.js');
  const id = built.tasks.create({ goal: 'unsettled' }).taskId;
  const store = new SessionStore(db);
  const request = buildExecutionRequest({ taskId: id, assistantId: A, attempt: 1, prompt: 'work', workdir: config.dir, approvalMode: 'auto-approve', maxRuntimeMs: 1000, routingDecisionRef: 'test' });
  store.recordRequest(request); const session = store.createSession(request.executionRequestId);
  db.prepare("UPDATE runs SET session_state = 'YIELDED', ended_at = ? WHERE id = ?").run(new Date().toISOString(), session.sessionId);
  built.tasks.transition(id, 'ROUTING'); built.tasks.transition(id, 'RUNNING'); built.tasks.transition(id, 'LIMIT_PAUSED');
  await built.checkpoints.create(id, session.sessionId, 'limit');
  expect(() => scheduler().attach(id, { kind: 'quota', notBefore: until(1000) })).toThrow(/execution/i);
  expect(built.tasks.get(id)?.state).toBe('LIMIT_PAUSED');
  expect(db.prepare('SELECT * FROM wait_conditions WHERE task_id = ?').all(id)).toHaveLength(0);
});

it('authentication intervention expires a pinned quota wait immediately', async () => {
  await boot(false); const s = scheduler();
  db.prepare("UPDATE assistants SET manifest = json_set(manifest, '$.core.auth.state', 'expired') WHERE id = ?").run(A);
  const id = built.tasks.create({ goal: 'wait', overrides: { assistantId: A } }).taskId;
  s.attach(id, { kind: 'quota', notBefore: until(-1) });
  const start = vi.spyOn(built.registry.adapter(A), 'start'); await s.runNow(id);
  expect(start).not.toHaveBeenCalled(); expect(built.tasks.get(id)).toMatchObject({ state: 'WAITING_INPUT', pause_kind: 'intervention_required' });
  expect(s.condition(id)?.state).toBe('expired');
});

it('router and scheduler use the same projection and ignore another hard-filter failure for controlling retry', async () => {
  await boot(false);
  const now = Date.now(); const at = new Date(now).toISOString();
  const insert = db.prepare('INSERT INTO quota_snapshots(assistant_id,window,used_percent,resets_at,source,observed_at,account) VALUES(?,?,?,?,?,?,?)');
  insert.run(A,'short',100,new Date(now+10*60_000).toISOString(),'runtime-probe',at,'fake');
  insert.run(A,'long',100,new Date(now+40*60_000).toISOString(),'runtime-probe',at,'fake');
  insert.run(B,'primary',100,new Date(now+25*60_000).toISOString(),'runtime-probe',at,'fake');
  const id = built.tasks.create({ goal: 'route with quota' }).taskId;
  expect(built.orchestrator.quotaPlan(id).notBefore).toBe(new Date(now+25*60_000).toISOString());
  expect(built.orchestrator.routeTask(id, 'intake').explanation.chosen).toBeUndefined();
  db.prepare('UPDATE assistants SET enabled = 0 WHERE id = ?').run(B);
  expect(built.orchestrator.quotaPlan(id).notBefore).toBe(new Date(now+40*60_000).toISOString());
  insert.run(A,'short',10,null,'provider-api',new Date(now+1).toISOString(),'fake');
  insert.run(A,'long',10,null,'provider-api',new Date(now+1).toISOString(),'fake');
  expect(built.orchestrator.routeTask(id, 'intake').explanation.chosen).toBe(A);
});

it('migration preserves existing K1 generations, dispatches, and foreign keys', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { readdirSync, readFileSync } = await import('node:fs');
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  try {
    const dir = new URL('../src/db/migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(n => n.endsWith('.sql') && n < '015_').sort()) old.exec(readFileSync(new URL(name, dir), 'utf8'));
    old.prepare("INSERT INTO tasks(id,goal,state,profile,envelope,created_at,updated_at,intent_json) VALUES('old','keep','ROUTING','auto','{}','t','t','{}')").run();
    old.prepare("INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,reason) VALUES('old',1,'consumed','time','t','user','t','keep')").run();
    old.prepare("INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,execution_path,phase,created_at,updated_at) VALUES('old-dispatch','old',1,'wake','legacy','reserved','t','t')").run();
    old.transaction(() => old.exec(readFileSync(new URL('015_quota_dispatch.sql', dir), 'utf8')))();
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(old.prepare('SELECT state,kind,reason,blockers FROM wait_conditions').get()).toEqual({ state: 'consumed', kind: 'time', reason: 'keep', blockers: '[]' });
    expect(old.prepare('SELECT dispatch_id,phase FROM dispatches').get()).toEqual({ dispatch_id: 'old-dispatch', phase: 'reserved' });
  } finally { old.close(); }
});

it.each(['materialized','start_attempted'] as const)('checkpoint successor crash at %s preserves the claim boundary', async phase => {
  await boot(true);
  const initial = scheduler();
  built.cooldowns.penalize(B, 'limit', 'blocked', until(60_000));
  const id = built.tasks.create({ goal: 'claim boundary [FAKE:LIMIT]' }).taskId;
  built.tasks.transition(id, 'ROUTING'); await built.orchestrator.startTask(id, A); await state(id, 'WAITING_RESOURCE');
  built.cooldowns.clear(B);
  const crashing = scheduler(async p => { if (p === phase) throw new Error('crash'); });
  await expect(crashing.runNow(id)).rejects.toThrow('crash');
  const dispatch = crashing.dispatches(id)[0]!;
  const request = db.prepare('SELECT origin_envelope_id,request_json FROM execution_requests WHERE id = ?').get(dispatch.dispatch_id) as { origin_envelope_id: string; request_json: string };
  expect(JSON.parse(request.request_json).runSpec.prompt).toBeUndefined();
  expect(db.prepare('SELECT state FROM handoff_envelopes WHERE id = ?').get(request.origin_envelope_id)).toEqual({ state: 'claimed' });
  const start = vi.spyOn(built.registry.adapter(B), 'start');
  if (phase === 'materialized') {
    await built.orchestrator.reconcileOnBoot(); await scheduler().reconcileOnBoot(); await state(id, 'COMPLETED');
    expect(start).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT state FROM handoff_envelopes WHERE id = ?').get(request.origin_envelope_id)).toEqual({ state: 'consumed' });
    expect(db.prepare('SELECT * FROM execution_requests WHERE origin_envelope_id = ?').all(request.origin_envelope_id)).toHaveLength(1);
  } else {
    const recovery = new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus,
      now: () => new Date(Date.now()+61_000) });
    await recovery.reconcileOnBoot();
    expect(start).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM handoff_envelopes WHERE id = ?').get(request.origin_envelope_id)).toEqual({ state: 'released' });
    expect(db.prepare('SELECT superseded FROM execution_requests WHERE id = ?').get(dispatch.dispatch_id)).toEqual({ superseded: 1 });
    expect(recovery.dispatch(dispatch.dispatch_id).phase).toBe('aborted');
    expect(initial.condition(id)?.autoWakes).toBe(1);
  }
});

it('routing failure rolls back its decision and dispatch link together', async () => {
  await boot(false); const s = scheduler();
  const id = built.tasks.create({ goal: 'route transaction' }).taskId;
  s.attach(id, { kind: 'time', notBefore: until(-1) });
  const original = built.orchestrator.routeTask.bind(built.orchestrator);
  const route = vi.spyOn(built.orchestrator, 'routeTask').mockImplementationOnce((...args) => {
    original(...args); throw new Error('route transaction crashed');
  });
  await expect(s.runNow(id)).rejects.toThrow('route transaction crashed');
  expect(db.prepare('SELECT * FROM routing_decisions WHERE task_id = ?').all(id)).toHaveLength(0);
  expect(s.dispatches(id)[0]!.routing_decision_id).toBeNull();
  route.mockRestore();
  await scheduler().reconcileOnBoot(); await state(id, 'COMPLETED');
  expect(db.prepare('SELECT * FROM routing_decisions WHERE task_id = ?').all(id)).toHaveLength(1);
});

it('first-event acknowledgement and envelope consumption roll back together', async () => {
  await boot(true); scheduler();
  built.cooldowns.penalize(B, 'limit', 'blocked', until(60_000));
  const id = built.tasks.create({ goal: 'atomic claim [FAKE:LIMIT]' }).taskId;
  built.tasks.transition(id, 'ROUTING'); await built.orchestrator.startTask(id, A); await state(id, 'WAITING_RESOURCE');
  built.cooldowns.clear(B);
  const s = scheduler(async phase => { if (phase === 'materialized') throw new Error('crash'); });
  await s.runNow(id).catch(() => {});
  const dispatch = s.dispatches(id)[0]!;
  const { SessionStore } = await import('../src/modules/harness/session-store.js');
  const { HandoffService } = await import('../src/modules/harness/handoff.js');
  const handoff = new HandoffService(db); const store = new SessionStore(db);
  const row = db.prepare('SELECT origin_envelope_id FROM execution_requests WHERE id = ?').get(dispatch.dispatch_id) as { origin_envelope_id: string };
  db.prepare("UPDATE dispatches SET phase = 'start_attempted' WHERE dispatch_id = ?").run(dispatch.dispatch_id);
  const session = store.createSession(dispatch.dispatch_id); const lease = store.acquireLease(session.sessionId)!;
  store.transition(session.sessionId, { from: 'PREPARED', to: 'STARTING', expectedVersion: 0, leaseToken: lease });
  expect(handoff.get(row.origin_envelope_id)?.state).toBe('start_ambiguous');
  const consume = vi.spyOn(HandoffService.prototype, 'markConsumed').mockImplementationOnce(() => { throw new Error('ack failed'); });
  expect(() => store.transition(session.sessionId, { from: 'STARTING', to: 'RUNNING', expectedVersion: 1, leaseToken: lease, patch: { providerStartAcked: true } })).toThrow('ack failed');
  expect(store.get(session.sessionId)).toMatchObject({ state: 'STARTING', version: 1, providerStartAcked: false });
  expect(handoff.get(row.origin_envelope_id)?.state).toBe('start_ambiguous');
  consume.mockRestore();
  store.transition(session.sessionId, { from: 'STARTING', to: 'RUNNING', expectedVersion: 1, leaseToken: lease, patch: { providerStartAcked: true } });
  expect(handoff.get(row.origin_envelope_id)?.state).toBe('consumed');
  store.releaseLease(session.sessionId, lease);
  await built.orchestrator.reconcileOnBoot();
});

it('cancel releases a materialized pre-start checkpoint claim and supersedes its request', async () => {
  await boot(true); scheduler();
  built.cooldowns.penalize(B, 'limit', 'blocked', until(60_000));
  const id = built.tasks.create({ goal: 'cancel claim [FAKE:LIMIT]' }).taskId;
  built.tasks.transition(id, 'ROUTING'); await built.orchestrator.startTask(id, A); await state(id, 'WAITING_RESOURCE');
  built.cooldowns.clear(B);
  const start = vi.spyOn(built.registry.adapter(B), 'start');
  const s = scheduler(async phase => { if (phase === 'materialized') await s.cancel(id); });
  await s.runNow(id).catch(() => {}); await scheduler().reconcileOnBoot();
  const d = s.dispatches(id)[0]!;
  const request = db.prepare('SELECT origin_envelope_id, superseded FROM execution_requests WHERE id = ?').get(d.dispatch_id) as { origin_envelope_id: string; superseded: number };
  expect(request.superseded).toBe(1);
  expect(db.prepare('SELECT state FROM handoff_envelopes WHERE id = ?').get(request.origin_envelope_id)).toEqual({ state: 'released' });
  expect(start).not.toHaveBeenCalled(); expect(built.tasks.get(id)?.state).toBe('CANCELLED');
});
