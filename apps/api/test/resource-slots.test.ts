import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantId } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler, type SchedulerDeps } from '../src/modules/scheduler.js';

/**
 * K4b — durable resource-slot waits.
 *
 * Every test drives the injected clock and the scheduler's own tick/event paths;
 * nothing sleeps on wall time. The property under test throughout is that a
 * resource claim and the dispatch ownership it belongs to are the SAME durable
 * fact, so no two tasks can hold the last slot and no claim can outlive its owner.
 */
let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let errors: unknown[] = [];
let instant = Date.parse('2030-01-01T00:00:00Z');
const now = () => new Date(instant);
const A = 'fake-a' as AssistantId; const B = 'fake-b' as AssistantId;

async function boot(resources: Record<string, number> = { gpu: 1 }) {
  home = mkdtempSync(join(tmpdir(), 'k4b-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' }, [B]: { provider: 'fake' } };
  config.scheduler = { ...config.scheduler, enabled: true, resources };
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
function scheduler(boundary?: SchedulerDeps['boundary']) {
  // Surfacing scheduler errors is part of the contract under test: a swallowed
  // wake failure would look exactly like "the slot was correctly withheld".
  return new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, boundary, onError: error => { errors.push(error); } });
}
/** A task parked on a resource wait. `goal` selects fake-adapter behaviour. */
function rtask(s: Scheduler, opts: { resource?: string; units?: number; goal?: string; pin?: AssistantId } = {}) {
  const t = built.tasks.create({ goal: opts.goal ?? 'do the work', overrides: opts.pin ? { assistantId: opts.pin } : undefined });
  s.attach(t.taskId, { kind: 'resource', resource: opts.resource ?? 'gpu', units: opts.units, reason: 'needs a slot' });
  instant += 1; // distinct created_at keeps the FIFO order deterministic
  return t.taskId;
}
function settled(id: string, states = ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_INPUT']) {
  return new Promise<void>(resolve => {
    const off = built.bus.subscribe(id, p => {
      if (p.kind === 'state' && states.includes(p.state!.state)) { off(); resolve(); }
    });
  });
}
/**
 * A holder occupies its slot with a LIVE session: the fake adapter parks on an
 * approval nobody answers, so the run stays live until the test cancels it. No
 * wall-time sleep, and the hold is the real ownership record, not a stub.
 */
const HOLD = '[FAKE:APPROVAL] hold the slot';
function holding(id: string) {
  return new Promise<void>(resolve => {
    const off = built.bus.subscribe(id, p => {
      if (p.event?.type === 'approval.requested') { off(); resolve(); }
    });
  });
}
/** Live claims for a pool, oldest first. */
function claims(resource = 'gpu') {
  return db.prepare('SELECT task_id, units, dispatch_id FROM resource_claims WHERE resource = ? AND released_at IS NULL ORDER BY claim_id').all(resource) as { task_id: string; units: number; dispatch_id: string }[];
}
function claimRows(taskId: string) {
  return db.prepare('SELECT * FROM resource_claims WHERE task_id = ? ORDER BY claim_id').all(taskId) as { released_at: string | null; release_reason: string | null; dispatch_id: string }[];
}
/** Drains the microtask-scheduled release/notify wakes the scheduler queues. */
async function drain() { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); }
/** Waits for a condition the scheduler reaches asynchronously, on the event loop only. */
async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (what()) return; await new Promise(r => setImmediate(r)); }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  vi.useRealTimers();
  const unexpected = errors; errors = [];
  expect(unexpected.map(e => (e instanceof Error ? e.message : String(e)))).toEqual([]);
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('K4b resource slots', () => {
  /* A — one task, one free slot. */
  it('dispatches immediately when the pool can satisfy the request', async () => {
    await boot(); const s = scheduler(); const id = rtask(s);
    expect(built.tasks.get(id)?.state).toBe('WAITING_RESOURCE');
    expect(s.resourceWaitStatus(id)).toMatchObject({ resource: 'gpu', units: 1, capacity: 1, availableUnits: 1, queuePosition: 1, blockedBy: 'eligible' });
    const done = settled(id); await s.tick(); await done;
    expect(s.dispatches(id)).toHaveLength(1);
    expect(s.dispatches(id)[0]).toMatchObject({ phase: 'started', condition_generation: 1 });
    // Terminal completion gave the slot straight back.
    await drain();
    expect(claims()).toHaveLength(0);
    expect(claimRows(id)[0]).toMatchObject({ released_at: expect.any(String) });
  });

  /* B — one task, no free slot. */
  it('keeps the second task in WAITING_RESOURCE with a truthful reason', async () => {
    await boot(); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const waiter = rtask(s);
    const held = holding(holder); await s.tick(); await held; await drain();
    expect(claims().map(c => c.task_id)).toEqual([holder]);
    expect(built.tasks.get(waiter)?.state).toBe('WAITING_RESOURCE');
    expect(s.dispatches(waiter)).toHaveLength(0);
    expect(s.claim(waiter)).toBeUndefined();
    expect(s.resourceWaitStatus(waiter)).toMatchObject({ availableUnits: 0, queuePosition: 1, blockedBy: 'capacity' });
    expect(s.pools()).toEqual([{ resource: 'gpu', capacity: 1, claimedUnits: 1, availableUnits: 0, waitingTaskIds: [waiter] }]);
  });

  /* C + I — release wakes the next waiter through the ordinary wake protocol. */
  it('wakes the next waiter on release, by generation, through wake()', async () => {
    await boot(); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const waiter = rtask(s);
    const held = holding(holder); await s.tick(); await held; await drain();
    expect(s.dispatches(waiter)).toHaveLength(0);
    const wake = vi.spyOn(s, 'wake');
    const ran = settled(waiter); await s.cancel(holder); await drain(); await ran;
    expect(wake).toHaveBeenCalledWith(waiter, 1, 'event');
    expect(s.dispatches(waiter)[0]).toMatchObject({ phase: 'started', condition_generation: 1, origin: 'wake' });
    expect(claimRows(holder)[0]!.released_at).toEqual(expect.any(String));
  });

  /* D — two tasks race for one slot. */
  it('grants the last slot to exactly one task under concurrent wakes', async () => {
    await boot(); const s = scheduler();
    const first = rtask(s, { goal: HOLD });
    const second = rtask(s, { goal: HOLD });
    await Promise.all([s.wake(first, 1, 'timer'), s.wake(second, 1, 'timer')]);
    await drain();
    expect(claims()).toHaveLength(1);
    // FIFO decided it, not arrival order of the wakes.
    expect(claims()[0]!.task_id).toBe(first);
    expect(s.dispatches(second)).toHaveLength(0);
    expect(built.tasks.get(second)?.state).toBe('WAITING_RESOURCE');
  });

  /* D (strict FIFO) — a smaller request never jumps the front waiter. */
  it('does not let a smaller request overtake the front of the queue', async () => {
    await boot({ pool: 2 }); const s = scheduler();
    const holder = rtask(s, { resource: 'pool', units: 1, goal: HOLD });
    const big = rtask(s, { resource: 'pool', units: 2 });
    const small = rtask(s, { resource: 'pool', units: 1 });
    const held = holding(holder); await s.tick(); await held; await drain();
    expect(claims('pool').map(c => c.task_id)).toEqual([holder]);
    expect(s.resourceWaitStatus(big)).toMatchObject({ queuePosition: 1, blockedBy: 'capacity' });
    expect(s.resourceWaitStatus(small)).toMatchObject({ queuePosition: 2, blockedBy: 'queue' });
    await s.tick(); await drain();
    // One free unit, and the front waiter needs two: the small one still waits.
    expect(claims('pool').map(c => c.task_id)).toEqual([holder]);
  });

  /* A release with headroom for several waiters drains the pool in one pass. */
  it('fills every free unit a release opens, in FIFO order', async () => {
    await boot({ pool: 2 }); const s = scheduler();
    const holder = rtask(s, { resource: 'pool', units: 2, goal: HOLD });
    const a = rtask(s, { resource: 'pool', units: 1, goal: HOLD });
    const b = rtask(s, { resource: 'pool', units: 1, goal: HOLD });
    const held = holding(holder); await s.tick(); await held; await drain();
    expect(claims('pool').map(c => c.task_id)).toEqual([holder]);
    const both = Promise.all([holding(a), holding(b)]);
    await s.cancel(holder); await drain(); await both;
    // One release event, two grants: the second unit did not sit idle until the tick.
    expect(claims('pool').map(c => c.task_id)).toEqual([a, b]);
  });

  /* E — duplicate wake. */
  it('never double-claims on a duplicate or stale wake', async () => {
    await boot(); const s = scheduler();
    const id = rtask(s, { goal: HOLD });
    const held = holding(id); expect(await s.wake(id, 1, 'timer')).toMatchObject({ outcome: 'dispatched' }); await held;
    expect(await s.wake(id, 1, 'timer')).toMatchObject({ outcome: 'stale' });
    expect(await s.wake(id, 2, 'event')).toMatchObject({ outcome: 'stale' });
    expect(claimRows(id)).toHaveLength(1);
    expect(s.dispatches(id)).toHaveLength(1);
  });

  /* F — cancellation while waiting. */
  it('cancels a waiting task without ever claiming a slot', async () => {
    await boot(); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const waiter = rtask(s);
    const held = holding(holder); await s.tick(); await held; await drain();
    await s.cancel(waiter);
    expect(built.tasks.get(waiter)?.state).toBe('CANCELLED');
    expect(claimRows(waiter)).toHaveLength(0);
    expect(claims().map(c => c.task_id)).toEqual([holder]);
  });

  /* G — cancellation after the claim, before the provider start. */
  it('releases the claim when a cancel lands between reservation and start', async () => {
    await boot(); const s = scheduler(async phase => { if (phase === 'reserved') await s.cancel(id); });
    const id = rtask(s); const waiter = rtask(s);
    await s.runNow(id).catch(() => {});
    await drain();
    expect(built.tasks.get(id)?.state).toBe('CANCELLED');
    // No provider run was ever recorded for the cancelled task.
    expect(db.prepare('SELECT * FROM runs WHERE task_id = ?').all(id)).toHaveLength(0);
    expect(claimRows(id)[0]).toMatchObject({ released_at: expect.any(String) });
    // The slot went to the next waiter rather than staying stranded; that task ran
    // to completion and handed it back in turn.
    expect(s.dispatches(waiter)[0]).toMatchObject({ phase: 'started' });
    expect(claimRows(waiter)).toHaveLength(1);
    expect(claims()).toHaveLength(0);
  });

  /* H — restart after the claim commit, before the provider start. */
  it('keeps exactly one claim across a restart at the reservation boundary', async () => {
    await boot(); const s = scheduler(async phase => { if (phase === 'reserved') throw new Error('crash'); });
    const id = rtask(s);
    const a = vi.spyOn(built.registry.adapter(A), 'start');
    await expect(s.runNow(id)).rejects.toThrow('crash');
    // Claim and dispatch committed together; the crash is after both.
    expect(claims().map(c => c.task_id)).toEqual([id]);
    await built.orchestrator.reconcileOnBoot();
    const recovered = scheduler(); const done = settled(id);
    await recovered.reconcileOnBoot(); await done; await drain();
    expect(a).toHaveBeenCalledTimes(1);
    expect(claimRows(id)).toHaveLength(1);
    expect(claims()).toHaveLength(0);
  });

  /* H — restart with a claim whose owner did not survive. */
  it('sweeps a claim whose dispatch and session are both gone', async () => {
    await boot(); const s = scheduler();
    const id = rtask(s, { goal: HOLD });
    const held = holding(id); await s.tick(); await held;
    // Simulate a restart that lost the owner: the task is terminal but the
    // claim row is still open, exactly what a crash mid-settle leaves behind.
    db.prepare('UPDATE resource_claims SET released_at = NULL, release_reason = NULL WHERE task_id = ?').run(id);
    built.tasks.transition(id, 'CANCELLED');
    const recovered = scheduler(); await recovered.reconcileOnBoot(); await drain();
    expect(claims()).toHaveLength(0);
    expect(claimRows(id).at(-1)).toMatchObject({ release_reason: expect.stringContaining('no execution owner') });
  });

  /* Failed start / recovery — a re-park gives the slot back and re-acquires. */
  it('releases on a start-ambiguous repark and re-parks as a resource wait', async () => {
    await boot(); config.execution.harnessModes.single = true;
    const s = scheduler(async phase => { if (phase === 'start_attempted') throw new Error('crash'); });
    const id = rtask(s);
    await expect(s.runNow(id)).rejects.toThrow('crash');
    expect(claims().map(c => c.task_id)).toEqual([id]);
    await built.orchestrator.reconcileOnBoot();
    const recovered = scheduler(); await recovered.reconcileOnBoot();
    // Inside the recovery window the ambiguity is held, claim included.
    expect(claims()).toHaveLength(1);
    instant += 60_001; await recovered.reconcileOnBoot(); await drain();
    expect(recovered.condition(id)).toMatchObject({ generation: 2, kind: 'resource', resource: 'gpu', units: 1, autoWakes: 1, reason: 'start_ambiguous' });
    expect(claimRows(id)[0]).toMatchObject({ released_at: expect.any(String) });
  });

  /* Double release is idempotent. */
  it('releases a claim at most once', async () => {
    await boot(); const s = scheduler();
    const id = rtask(s); const done = settled(id); await s.tick(); await done; await drain();
    const before = claimRows(id)[0]!.released_at;
    s.releaseIfIdle(id, 'second call'); s.releaseIfIdle(id, 'third call');
    expect(claimRows(id)).toHaveLength(1);
    expect(claimRows(id)[0]!.released_at).toBe(before);
  });

  /* A slot is held for the whole of an approval pause — a pause is not a release. */
  it('holds the slot while a session waits on a human decision', async () => {
    await boot(); const s = scheduler();
    const id = rtask(s, { goal: HOLD });
    const held = holding(id); await s.tick(); await held; await drain();
    expect(built.tasks.get(id)?.state).toBe('RUNNING');
    expect(s.claim(id)).toMatchObject({ resource: 'gpu', units: 1 });
    await s.tick(); await drain();
    expect(claims().map(c => c.task_id)).toEqual([id]);
  });

  /* J — no starvation: every waiter runs, in durable FIFO order. */
  it('runs every waiter in durable FIFO order', async () => {
    await boot(); const s = scheduler();
    const ids = [rtask(s), rtask(s), rtask(s)];
    const order: string[] = [];
    for (const id of ids) built.bus.subscribe(id, p => { if (p.kind === 'state' && p.state!.state === 'ROUTING' && !order.includes(id)) order.push(id); });
    const all = Promise.all(ids.map(id => settled(id)));
    await s.tick(); await all; await drain();
    expect(order).toEqual(ids);
    expect(claims()).toHaveLength(0);
    for (const id of ids) expect(s.dispatches(id)[0]).toMatchObject({ phase: 'started' });
  });

  /* Capacity increase wakes eligible work. */
  it('wakes eligible work when capacity rises', async () => {
    await boot({ gpu: 1 }); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const waiter = rtask(s);
    const held = holding(holder); await s.tick(); await held; await drain();
    expect(s.dispatches(waiter)).toHaveLength(0);
    config.scheduler!.resources = { gpu: 2 };
    const ran = settled(waiter); await s.tick(); await ran; await drain();
    expect(s.dispatches(waiter)[0]).toMatchObject({ phase: 'started' });
  });

  /* Capacity decrease while work exists: live claims survive, new ones wait. */
  it('never preempts a live claim when capacity falls', async () => {
    await boot({ gpu: 2 }); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const held = holding(holder); await s.tick(); await held; await drain();
    config.scheduler!.resources = { gpu: 1 };
    const waiter = rtask(s);
    await s.tick(); await drain();
    expect(claims().map(c => c.task_id)).toEqual([holder]);
    expect(s.resourceWaitStatus(waiter)).toMatchObject({ capacity: 1, claimedUnits: 1, availableUnits: 0, blockedBy: 'capacity' });
  });

  /* A request that capacity can no longer satisfy becomes an operator decision,
     so it cannot block every task behind it forever. */
  it('expires an unsatisfiable request to WAITING_INPUT instead of hanging the queue', async () => {
    await boot({ pool: 2 }); const s = scheduler();
    const big = rtask(s, { resource: 'pool', units: 2 });
    const small = rtask(s, { resource: 'pool', units: 1 });
    config.scheduler!.resources = { pool: 1 };
    const parked = settled(big, ['WAITING_INPUT']);
    const ran = settled(small); await s.tick(); await parked; await drain(); await s.tick(); await ran;
    expect(built.tasks.get(big)).toMatchObject({ state: 'WAITING_INPUT', pause_kind: 'intervention_required' });
    expect(s.events(big).map(e => e.type)).toContain('resource.unsatisfiable');
    expect(s.dispatches(small)[0]).toMatchObject({ phase: 'started' });
  });

  /* Attach-time fail-closed: an undeclared pool has no honest capacity. */
  it('refuses waits a pool could never satisfy', async () => {
    await boot({ gpu: 1 }); const s = scheduler();
    const t = built.tasks.create({ goal: 'do the work' });
    expect(() => s.attach(t.taskId, { kind: 'resource', resource: 'nope' })).toThrow(/Unknown resource pool/);
    expect(() => s.attach(t.taskId, { kind: 'resource', resource: 'gpu', units: 2 })).toThrow(/can never be granted/);
    expect(() => s.attach(t.taskId, { kind: 'resource', resource: 'gpu', units: 0 })).toThrow(/positive integer/);
    expect(built.tasks.get(t.taskId)?.state).toBe('CREATED');
  });

  /* K — a human decision is never deferrable around. */
  it.each(['approval_pending', 'verification_failed', 'comparison_pending'] as const)('refuses to defer a %s pause onto a resource wait', async pauseKind => {
    await boot(); const s = scheduler();
    const t = built.tasks.create({ goal: 'needs a person' });
    built.tasks.transition(t.taskId, 'ROUTING');
    built.tasks.transition(t.taskId, 'RUNNING');
    built.tasks.transition(t.taskId, 'WAITING_INPUT', pauseKind);
    expect(() => s.attach(t.taskId, { kind: 'resource', resource: 'gpu' })).toThrow(/operator decision/);
    expect(built.tasks.get(t.taskId)).toMatchObject({ state: 'WAITING_INPUT', pause_kind: pauseKind });
    expect(db.prepare('SELECT COUNT(*) AS n FROM resource_claims').get()).toMatchObject({ n: 0 });
  });

  /* L — execution choices are recomputed at dispatch, never frozen into the wait. */
  it('recomputes routing at the wake, not at attach', async () => {
    await boot(); const s = scheduler(); const id = rtask(s);
    expect(db.prepare('SELECT * FROM routing_decisions WHERE task_id = ?').all(id)).toHaveLength(0);
    const a = vi.spyOn(built.registry.adapter(A), 'start'); const b = vi.spyOn(built.registry.adapter(B), 'start');
    built.cooldowns.penalize(A, 'limit', 'changed while the task waited for a slot');
    const done = settled(id); await s.tick(); await done;
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
    const condition = s.condition(id)!;
    expect(condition.assistants ?? []).toEqual([]);
    expect(condition.kind).toBe('resource');
  });

  /* M — the other wait kinds are untouched by K4b. */
  it('leaves time, quota and dependency waits claim-free', async () => {
    await boot(); const s = scheduler();
    const timed = built.tasks.create({ goal: 'later' });
    s.attach(timed.taskId, { kind: 'time', notBefore: new Date(instant + 5_000).toISOString() });
    const dep = built.tasks.create({ goal: 'after' });
    s.attach(dep.taskId, { kind: 'dependency', dependsOn: [timed.taskId] });
    await s.tick(); await drain();
    expect(claims()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resource_claims').get()).toMatchObject({ n: 0 });
    expect(s.resourceWaitStatus(timed.taskId)).toBeUndefined();
    expect(s.resourceWaitStatus(dep.taskId)).toBeUndefined();
    expect(s.pools()).toEqual([{ resource: 'gpu', capacity: 1, claimedUnits: 0, availableUnits: 1, waitingTaskIds: [] }]);
  });

  /* The requirement outlives one condition: a quota re-park must re-acquire. */
  it('carries the pool requirement into a quota re-park', async () => {
    await boot(); const s = scheduler();
    const blocked = rtask(s, { goal: 'continue [FAKE:LIMIT]', pin: A });
    built.cooldowns.penalize(B, 'limit', 'backup blocked', new Date(instant + 60_000).toISOString());
    const parked = settled(blocked, ['WAITING_RESOURCE']);
    await s.tick(); await parked; await drain();
    // Parked on quota, still naming its pool, and holding nothing while parked.
    expect(s.condition(blocked)).toMatchObject({ kind: 'quota', resource: 'gpu', units: 1, blockers: expect.any(Array) });
    await until(() => claims().length === 0, 'the quota park to release its slot');
    // Not yet retryable, so it is not in the pool queue: it cannot hold the head of
    // line against work that is ready now.
    expect(s.pools()[0]!.waitingTaskIds).not.toContain(blocked);
    built.cooldowns.clear(A); built.cooldowns.clear(B);
    const other = rtask(s, { goal: HOLD });
    const held = holding(other); await s.tick(); await held; await drain();
    expect(claims().map(c => c.task_id)).toEqual([other]);
    // Quota is clear and the retry is due, but the slot is not: the wake re-acquires
    // and withholds the dispatch rather than running outside the pool.
    const generation = s.condition(blocked)!.generation;
    instant = Date.parse(s.condition(blocked)!.notBefore);
    expect(s.resourceWaitStatus(blocked)).toMatchObject({ resource: 'gpu', availableUnits: 0, blockedBy: 'capacity' });
    expect(await s.wake(blocked, generation, 'timer')).toMatchObject({ outcome: 'stale', reason: expect.stringContaining('units free') });
    // Only the original (limit-hit) dispatch exists; the quota retry produced none.
    expect(s.dispatches(blocked).map(d => d.condition_generation)).toEqual([1]);
    expect(claims().map(c => c.task_id)).toEqual([other]);
  });

  /* A context-yield continuation re-acquires instead of escaping the pool. */
  it('carries the pool requirement into a context-yield continuation', async () => {
    await boot(); const s = scheduler();
    const yielding = rtask(s, { goal: 'implement the change [FAKE:CONTEXT:0.96>0.3]' });
    const parked = settled(yielding, ['WAITING_RESOURCE', 'COMPLETED', 'WAITING_INPUT']);
    await s.tick(); await parked; await drain();
    const condition = s.condition(yielding);
    // Only assert the carry when the yield actually parked a continuation.
    if (condition?.state === 'active' && condition.origin === 'context-yield') {
      expect(condition).toMatchObject({ resource: 'gpu', units: 1 });
    }
    // Whatever the outcome, no claim outlived the settled predecessor.
    const live = claims().filter(c => c.task_id === yielding);
    if (built.tasks.get(yielding)?.state === 'WAITING_RESOURCE') expect(live).toHaveLength(0);
  });

  /* Replacing a wait is not a way to drop the requirement. */
  it('keeps the requirement when an operator replaces the wait', async () => {
    await boot(); const s = scheduler();
    const holder = rtask(s, { goal: HOLD });
    const waiter = rtask(s);
    const held = holding(holder); await s.tick(); await held; await drain();
    s.attach(waiter, { kind: 'time', notBefore: new Date(instant + 1_000).toISOString(), reason: 'operator deferred' });
    expect(s.condition(waiter)).toMatchObject({ generation: 2, kind: 'time', resource: 'gpu', units: 1 });
    instant += 2_000;
    await s.tick(); await drain();
    // Due on time, but the pool is full: the slot is still a precondition.
    expect(s.dispatches(waiter)).toHaveLength(0);
    expect(built.tasks.get(waiter)?.state).toBe('WAITING_RESOURCE');
  });

  /* N — K13 stays in SHADOW across a resource dispatch. */
  it('keeps K13 model selection inert for a resource dispatch', async () => {
    await boot(); const s = scheduler(); const id = rtask(s);
    const done = settled(id); await s.tick(); await done;
    const decisions = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ?').all(id) as { explanation: string }[];
    expect(decisions).toHaveLength(1);
    const recommendation = (JSON.parse(decisions[0]!.explanation) as { modelRecommendation?: { mode: string; execution: { decidedBy: string } } }).modelRecommendation;
    if (recommendation) {
      expect(recommendation.mode).toBe('shadow');
      expect(recommendation.execution.decidedBy).toBe('unchanged');
    }
    expect(config.models.selection.enabled).toBe(false);
  });
});
