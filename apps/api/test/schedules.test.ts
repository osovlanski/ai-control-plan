import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantId, ScheduleInput } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler } from '../src/modules/scheduler.js';
import { credentialPath, readCredential, rotateCredential } from '../src/auth/credential-file.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
/** Fake clock. Every K5 assertion moves it explicitly; nothing sleeps. */
let instant = Date.parse('2030-01-01T00:00:00Z');
const now = () => new Date(instant);
const A = 'fake-a' as AssistantId;

async function boot() {
  home = mkdtempSync(join(tmpdir(), 'k5-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' } };
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
function scheduler() {
  return new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now });
}
function at(iso: string) { instant = Date.parse(iso); }
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` }; }
const daily: ScheduleInput = { goal: 'nightly retro', cron: '30 2 * * *', timezone: 'America/New_York' };

afterEach(async () => {
  vi.useRealTimers();
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  instant = Date.parse('2030-01-01T00:00:00Z');
  vi.restoreAllMocks();
});

describe('K5 recurring schedules', () => {
  it('computes the next fire in the schedule timezone and stores intent only', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create({ ...daily, constraints: ['keep it short'] });
    // 02:30 America/New_York on 2030-01-01 is 07:30Z (EST).
    expect(schedule.nextFireAt).toBe('2030-01-01T07:30:00.000Z');
    expect(schedule.intent).toMatchObject({ goal: 'nightly retro', constraints: ['keep it short'], profile: 'auto' });
    const columns = db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[];
    expect(columns.some(c => /^(assistant_id|model|composition)$/.test(c.name))).toBe(false);
  });

  it('fires exactly one task per occurrence and dedups a duplicate tick', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z');
    await s.tick();
    const occurrences = s.schedules.occurrences(schedule.scheduleId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ occurrenceAt: '2030-01-01T07:30:00.000Z', outcome: 'created' });
    const taskId = occurrences[0]!.taskId!;
    expect(built.tasks.get(taskId)?.goal).toBe('nightly retro');
    // The occurrence is dispatched through the existing K1 wake protocol.
    expect(s.dispatches(taskId)).toHaveLength(1);
    expect(s.schedules.get(schedule.scheduleId)).toMatchObject({
      lastFiredAt: '2030-01-01T07:30:00.000Z', nextFireAt: '2030-01-02T07:30:00.000Z', lastTaskId: taskId,
    });

    // A second tick at the same instant must create nothing.
    await s.tick();
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  it('rewinding nextFireAt onto a fired occurrence still creates nothing', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z'); await s.tick();
    db.prepare('UPDATE schedules SET next_fire_at = ? WHERE schedule_id = ?').run('2030-01-01T07:30:00.000Z', schedule.scheduleId);
    await s.tick();
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
  });

  it('records skipped-overlap while the previous occurrence is still running', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z'); await s.tick();
    const first = s.schedules.occurrences(schedule.scheduleId)[0]!.taskId!;
    expect(['WAITING_RESOURCE', 'ROUTING', 'RUNNING', 'COMPLETED']).toContain(built.tasks.get(first)?.state);
    // Hold the first occurrence open across the next fire.
    db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE id = ?").run(first);

    at('2030-01-02T07:30:00Z'); await s.tick();
    const occurrences = s.schedules.occurrences(schedule.scheduleId);
    expect(occurrences.find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')).toMatchObject({ outcome: 'skipped-overlap', taskId: undefined });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    // The schedule still advances rather than parking on the skipped instant.
    expect(s.schedules.get(schedule.scheduleId)?.nextFireAt).toBe('2030-01-03T07:30:00.000Z');
  });

  it('skips a spring-forward local time that does not exist', async () => {
    await boot(); const s = scheduler();
    // 2030-03-10, America/New_York jumps 02:00 EST → 03:00 EDT, so 02:30 never happens.
    at('2030-03-09T00:00:00Z');
    const schedule = s.schedules.create(daily);
    expect(schedule.nextFireAt).toBe('2030-03-09T07:30:00.000Z');
    at('2030-03-09T07:30:00Z'); await s.tick();
    expect(s.schedules.get(schedule.scheduleId)?.nextFireAt).toBe('2030-03-11T06:30:00.000Z');

    at('2030-03-12T00:00:00Z'); await s.tick();
    const fired = s.schedules.occurrences(schedule.scheduleId).map(o => o.occurrenceAt);
    expect(fired).not.toContain('2030-03-10T07:30:00.000Z');
    expect(fired).toContain('2030-03-11T06:30:00.000Z');
  });

  it('fires once, not twice, across a fall-back ambiguous local time', async () => {
    await boot(); const s = scheduler();
    // 2030-11-03, America/New_York repeats 01:00–02:00 local; 01:30 is ambiguous.
    at('2030-11-02T00:00:00Z');
    const schedule = s.schedules.create({ ...daily, cron: '30 1 * * *' });
    for (const tick of ['2030-11-02T05:30:00Z', '2030-11-03T05:30:00Z', '2030-11-03T06:30:00Z', '2030-11-04T06:30:00Z']) {
      at(tick); await s.tick();
      // Settle each occurrence so the next one is judged on its own, not on overlap.
      db.prepare("UPDATE tasks SET state = 'COMPLETED' WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')").run();
    }
    const onTheDay = s.schedules.occurrences(schedule.scheduleId).filter(o => o.occurrenceAt.startsWith('2030-11-03'));
    expect(onTheDay).toHaveLength(1);
    expect(onTheDay[0]).toMatchObject({ occurrenceAt: '2030-11-03T05:30:00.000Z', outcome: 'created' });
  });

  it('an edit recomputes nextFireAt from now and leaves fired occurrences alone', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z'); await s.tick();
    at('2030-01-01T12:00:00Z');
    const edited = s.schedules.update(schedule.scheduleId, { cron: '0 9 * * *', timezone: 'Europe/Berlin' });
    expect(edited.nextFireAt).toBe('2030-01-02T08:00:00.000Z'); // 09:00 CET
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(1);

    // Disabling leaves the already created task alone and stops firing.
    s.schedules.update(schedule.scheduleId, { enabled: false });
    at('2030-01-05T00:00:00Z'); await s.tick();
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(1);
    expect(built.tasks.list()).toHaveLength(1);
  });

  it('after a restart fires at most one missed occurrence inside the catch-up window', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create({ ...daily, catchUpWindowMinutes: 24 * 60 });
    // Down for three days; only the most recent occurrence may still run.
    at('2030-01-04T12:00:00Z');
    await s.reconcileOnBoot();
    const occurrences = s.schedules.occurrences(schedule.scheduleId);
    expect(occurrences.filter(o => o.outcome === 'created')).toHaveLength(1);
    expect(occurrences.find(o => o.outcome === 'created')!.occurrenceAt).toBe('2030-01-04T07:30:00.000Z');
    // A 24 h window starts at 2030-01-03T12:00Z, so 01-02 and 01-03 are never
    // enumerated at all: an old gap costs a resync, not a row per missed instant.
    expect(occurrences.filter(o => o.outcome === 'skipped-catch-up')).toEqual([]);
    expect(s.schedules.get(schedule.scheduleId)?.nextFireAt).toBe('2030-01-05T07:30:00.000Z');
  });

  it('fires nothing when the whole gap is older than the catch-up window', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create({ ...daily, catchUpWindowMinutes: 60 });
    at('2030-01-04T12:00:00Z');
    await s.reconcileOnBoot();
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(0);
    expect(built.tasks.list()).toHaveLength(0);
    expect(s.schedules.get(schedule.scheduleId)?.nextFireAt).toBe('2030-01-05T07:30:00.000Z');
  });

  it('a disabled scheduler fires nothing and records one skipped-disabled on re-enable', async () => {
    await boot(); config.scheduler = { enabled: false };
    const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z'); await s.tick();
    at('2030-01-02T07:30:00Z'); await s.tick();
    expect(s.schedules.occurrences(schedule.scheduleId)).toHaveLength(0);
    expect(s.status()).toMatchObject({ enabled: false, armed: false, enabledSchedules: 1 });

    config.scheduler = { enabled: true };
    at('2030-01-03T12:00:00Z'); await s.tick();
    const occurrences = s.schedules.occurrences(schedule.scheduleId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ outcome: 'skipped-disabled', occurrenceAt: '2030-01-03T07:30:00.000Z' });
    expect(built.tasks.list()).toHaveLength(0);

    // Back to ordinary firing on the next occurrence.
    at('2030-01-04T07:30:00Z'); await s.tick();
    expect(s.schedules.occurrences(schedule.scheduleId).find(o => o.outcome === 'created')).toMatchObject({ occurrenceAt: '2030-01-04T07:30:00.000Z' });
  });

  it('shares the existing scheduler timer instead of arming a second one', async () => {
    await boot(); const s = scheduler();
    s.schedules.create(daily);
    at('2030-01-01T07:29:30Z');
    const timers = vi.spyOn(global, 'setTimeout');
    s.startTimer();
    // One timer for waits and schedules alike; the nearer schedule sets the delay.
    expect(timers).toHaveBeenCalledTimes(1);
    expect(timers.mock.calls[0]![1]).toBe(30_000);
    expect(s.status()).toMatchObject({ armed: true, enabledSchedules: 1, nextScheduleFireAt: '2030-01-01T07:30:00.000Z' });
    s.stop();
  });

  it('rejects an unusable cron, a 6-field expression and an unknown timezone', async () => {
    await boot(); const s = scheduler();
    expect(() => s.schedules.create({ ...daily, cron: 'not a cron' })).toThrow(/5-field|Invalid cron/);
    expect(() => s.schedules.create({ ...daily, cron: '0 30 2 * * *' })).toThrow(/5-field/);
    expect(() => s.schedules.create({ ...daily, timezone: 'Mars/Olympus' })).toThrow(/Invalid cron or timezone/);
    expect(() => s.schedules.create({ ...daily, goal: '   ' })).toThrow(/goal/);
    expect(() => s.schedules.create({ ...daily, catchUpWindowMinutes: -1 })).toThrow(/catchUpWindowMinutes/);
    expect(s.schedules.list()).toHaveLength(0);
  });

  it('serves the schedule API under schedules.read and commands.write', async () => {
    await boot();
    const created = await built.app.inject({ method: 'POST', url: '/api/schedules', headers: headers(), payload: daily });
    expect(created.statusCode).toBe(201);
    const id = created.json().scheduleId as string;

    expect((await built.app.inject({ method: 'GET', url: '/api/schedules', headers: headers() })).json()).toHaveLength(1);
    const detail = await built.app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers: headers() });
    expect(detail.json()).toMatchObject({ scheduleId: id, cron: '30 2 * * *', occurrences: [] });

    const patched = await built.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, headers: headers(), payload: { cron: '0 9 * * *' } });
    expect(patched.json()).toMatchObject({ cron: '0 9 * * *', nextFireAt: '2030-01-01T14:00:00.000Z' });
    expect((await built.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, headers: headers(), payload: { cron: 'nope' } })).statusCode).toBe(400);
    expect((await built.app.inject({ method: 'GET', url: '/api/schedules/missing', headers: headers() })).statusCode).toBe(404);

    expect((await built.app.inject({ method: 'DELETE', url: `/api/schedules/${id}`, headers: headers() })).statusCode).toBe(204);
    expect((await built.app.inject({ method: 'DELETE', url: `/api/schedules/${id}`, headers: headers() })).statusCode).toBe(404);
  });

  it('fails closed without the capability the route requires', async () => {
    await boot();
    const readOnly = rotateCredential(credentialPath(config.dir), 0, ['schedules.read'], now());
    const auth = { authorization: `Bearer ${readOnly.secret}` };
    expect((await built.app.inject({ method: 'GET', url: '/api/schedules', headers: auth })).statusCode).toBe(200);
    expect((await built.app.inject({ method: 'POST', url: '/api/schedules', headers: auth, payload: daily })).statusCode).toBe(403);
    expect((await built.app.inject({ method: 'GET', url: '/api/schedules' })).statusCode).toBe(401);
  });
});
