/**
 * K5 `overlap: queue` — the capability deferred out of kernel-services §4.2.6.
 *
 * Everything here runs on the injected clock and explicit `tick()` calls. There
 * is no wall-clock sleep, no real cron timer and no real provider.
 *
 * See docs/agentic-os-k5-overlap-queue.md for the model these assertions encode.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantId, ModelRecommendation, ScheduleInput, TaskIntent } from '@agent-plane/core';
import { loadConfig, type ResolvedConfig } from '../src/config.js';
import Database from 'better-sqlite3';
import { migrate, openDb, type Db } from '../src/db/index.js';
import { buildServer, type BuiltServer } from '../src/server.js';
import { Scheduler } from '../src/modules/scheduler.js';
import { credentialPath, readCredential } from '../src/auth/credential-file.js';

let home: string; let db: Db; let config: ResolvedConfig; let built: BuiltServer;
let instant = Date.parse('2030-01-01T00:00:00Z');
const now = () => new Date(instant);
const A = 'fake-a' as AssistantId;

async function boot() {
  home = mkdtempSync(join(tmpdir(), 'k5q-'));
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: 'fake' } };
  db = openDb(config.dbPath); built = buildServer({ config, db, now });
  built.registry.init(); await built.registry.syncAll();
}
/** A fresh Scheduler over the SAME durable state — the restart/boot simulation. */
function scheduler() {
  return new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now });
}
function at(iso: string) { instant = Date.parse(iso); }
function headers() { return { authorization: `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}` }; }
/** Lets the terminal-event microtask (and its promotion) run. */
const flush = () => new Promise(resolve => setImmediate(resolve));

const daily: ScheduleInput = { goal: 'nightly retro', cron: '30 2 * * *', timezone: 'America/New_York', overlap: 'queue' };

/** Holds an occurrence task open so the NEXT occurrence sees an active task. */
function hold(taskId: string) { db.prepare("UPDATE tasks SET state = 'RUNNING' WHERE id = ?").run(taskId); }
/** Settles a held task through the real store, so `onTerminal` actually fires. */
async function settle(taskId: string) { built.tasks.transition(taskId, 'COMPLETED'); await flush(); }
function occurrences(s: Scheduler, id: string, limit?: number) { return s.schedules.occurrences(id, limit); }
function queued(s: Scheduler, id: string) {
  return occurrences(s, id).filter(o => o.outcome === 'queued').sort((a, b) => a.occurrenceAt.localeCompare(b.occurrenceAt));
}
function taskCount() { return (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n; }

/** Fires the first occurrence and holds its task open. Returns [scheduleId, taskId]. */
async function firstOccurrenceRunning(s: Scheduler, input: ScheduleInput = daily): Promise<[string, string]> {
  const schedule = s.schedules.create(input);
  at('2030-01-01T07:30:00Z'); await s.tick();
  const first = occurrences(s, schedule.scheduleId)[0]!;
  expect(first.outcome).toBe('created');
  hold(first.taskId!);
  return [schedule.scheduleId, first.taskId!];
}

afterEach(async () => {
  vi.useRealTimers();
  if (built) { await built.orchestrator.shutdown(); await built.app.close(); }
  if (db?.open) db.close();
  if (home) rmSync(home, { recursive: true, force: true });
  instant = Date.parse('2030-01-01T00:00:00Z');
  vi.restoreAllMocks();
});

describe('K5 overlap: queue — migration 024', () => {
  /**
   * Every other test starts from an empty database, so the one thing they
   * cannot prove is that the rebuild in 024 carries EXISTING rows across. It
   * has to, and it has to do it without inventing queue history for them.
   */
  it('carries existing schedules and occurrences across the rebuild, as skip, with no invented queue state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5m-'));
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    const source = join(import.meta.dirname, '../src/db/migrations');
    const files = readdirSync(source).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
    const upgrade = files.filter(f => f.startsWith('024_'));
    expect(upgrade).toHaveLength(1);
    for (const f of files.filter(f => !f.startsWith('024_'))) copyFileSync(join(source, f), join(migrations, f));

    const old = new Database(join(dir, 'db.sqlite'));
    old.pragma('foreign_keys = ON');
    migrate(old, migrations);
    // A schedule with history, in every pre-existing outcome, plus a real task.
    old.prepare(`INSERT INTO tasks (id, goal, state, profile, envelope, intent_json, created_at, updated_at)
      VALUES ('task_legacy','legacy goal','COMPLETED','auto','{}','{}','2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')`).run();
    old.prepare(`INSERT INTO schedules(schedule_id,kind,intent_json,cron,timezone,enabled,overlap,catch_up_window_minutes,last_fired_at,next_fire_at,last_task_id,created_at,updated_at)
      VALUES('sched_legacy','user','{"goal":"legacy goal","constraints":[],"profile":"auto"}','30 2 * * *','America/New_York',1,'skip',1440,'2029-01-01T07:30:00.000Z','2029-01-02T07:30:00.000Z','task_legacy','2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')`).run();
    for (const [at, outcome, taskId] of [
      ['2029-01-01T07:30:00.000Z', 'created', 'task_legacy'],
      ['2029-01-02T07:30:00.000Z', 'skipped-overlap', null],
      ['2029-01-03T07:30:00.000Z', 'skipped-catch-up', null],
      ['2029-01-04T07:30:00.000Z', 'skipped-disabled', null],
    ] as Array<[string, string, string | null]>) {
      old.prepare('INSERT INTO schedule_occurrences(schedule_id,occurrence_at,fired_at,outcome,task_id) VALUES(?,?,?,?,?)')
        .run('sched_legacy', at, at, outcome, taskId);
    }

    copyFileSync(join(source, upgrade[0]!), join(migrations, upgrade[0]!));
    expect(migrate(old, migrations)).toEqual(upgrade);
    // The rebuild proves relationship integrity, not just row survival.
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // Every row survived, unchanged, and `overlap` is still skip.
    expect(old.prepare('SELECT * FROM schedules').all()).toMatchObject([{ schedule_id: 'sched_legacy', overlap: 'skip', last_task_id: 'task_legacy' }]);
    const rows = old.prepare('SELECT * FROM schedule_occurrences ORDER BY occurrence_at').all() as Array<Record<string, unknown>>;
    expect(rows.map(r => r.outcome)).toEqual(['created', 'skipped-overlap', 'skipped-catch-up', 'skipped-disabled']);
    // No historical queue state is invented for rows that predate the queue.
    expect(rows.every(r => r.queued_at === null && r.promoted_at === null && r.intent_json === null)).toBe(true);
    expect(rows[0]!.task_id).toBe('task_legacy');

    // The widened CHECKs accept the new values, and the FK still cascades.
    old.prepare("UPDATE schedules SET overlap = 'queue' WHERE schedule_id = 'sched_legacy'").run();
    old.prepare("INSERT INTO schedule_occurrences(schedule_id,occurrence_at,fired_at,outcome,queued_at,intent_json) VALUES('sched_legacy','2029-01-05T07:30:00.000Z','x','queued','x','{}')").run();
    old.prepare("DELETE FROM schedules WHERE schedule_id = 'sched_legacy'").run();
    expect(old.prepare('SELECT COUNT(*) AS n FROM schedule_occurrences').get()).toEqual({ n: 0 });
    // The task the schedule created is an ordinary task and is NOT cascaded away.
    expect(old.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
    // Row survival alone would miss a rebuild that drops or misdirects an FK.
    expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    old.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('K5 overlap: queue', () => {
  // A. skip mode is untouched.
  it('A — overlap=skip still records skipped-overlap and creates nothing', async () => {
    await boot(); const s = scheduler();
    const [id] = await firstOccurrenceRunning(s, { ...daily, overlap: 'skip' });
    at('2030-01-02T07:30:00Z'); await s.tick();
    const second = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    expect(second).toMatchObject({ outcome: 'skipped-overlap', taskId: undefined, queuedAt: undefined, promotedAt: undefined });
    expect(taskCount()).toBe(1);
    expect(s.schedules.get(id)).toMatchObject({ overlap: 'skip', queuedCount: 0 });
    // The default is still skip for a caller that says nothing.
    expect(s.schedules.create({ goal: 'g', cron: '0 1 * * *', timezone: 'UTC' }).overlap).toBe('skip');
  });

  // B. Nothing running, nothing queued: the ordinary immediate path.
  it('B — queue mode with no active task creates the occurrence immediately', async () => {
    await boot(); const s = scheduler();
    const schedule = s.schedules.create(daily);
    at('2030-01-01T07:30:00Z'); await s.tick();
    const [only] = occurrences(s, schedule.scheduleId);
    // Created immediately is NOT "promoted from the queue", and says so.
    expect(only).toMatchObject({ outcome: 'created', queuedAt: undefined, promotedAt: undefined, queuePosition: undefined });
    expect(only!.taskId).toBeTruthy();
    expect(s.schedules.get(schedule.scheduleId)).toMatchObject({ queuedCount: 0, activeTaskId: only!.taskId });
  });

  // C. The core semantic: persist, do not drop, do not overlap.
  it('C — an occurrence due while a task runs is persisted queued, with no second task', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    const second = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    expect(second).toMatchObject({ outcome: 'queued', taskId: undefined, queuePosition: 1 });
    expect(second.queuedAt).toBeTruthy();
    expect(second.promotedAt).toBeUndefined();
    expect(taskCount()).toBe(1);
    expect(s.schedules.get(id)).toMatchObject({ queuedCount: 1, activeTaskId: running });
    // The schedule still advances rather than parking on the queued instant.
    expect(s.schedules.get(id)?.nextFireAt).toBe('2030-01-03T07:30:00.000Z');
    // A duplicate tick at the same instant adds no second queue entry.
    await s.tick();
    expect(queued(s, id)).toHaveLength(1);
  });

  // D + E. Strict FIFO, one at a time, driven by the terminal event.
  it('D/E — multiple queued occurrences drain oldest-first, one per terminal event', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    for (const day of ['02', '03', '04']) { at(`2030-01-${day}T07:30:00Z`); await s.tick(); }
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual([
      '2030-01-02T07:30:00.000Z', '2030-01-03T07:30:00.000Z', '2030-01-04T07:30:00.000Z']);
    expect(queued(s, id).map(o => o.queuePosition)).toEqual([1, 2, 3]);
    expect(taskCount()).toBe(1);

    await settle(running);
    const promoted = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    expect(promoted).toMatchObject({ outcome: 'created' });
    // Queue provenance survives promotion: created, but NOT at the cron instant.
    expect(promoted.queuedAt).toBeTruthy();
    expect(promoted.promotedAt).toBeTruthy();
    expect(promoted.taskId).toBeTruthy();
    expect(taskCount()).toBe(2);
    expect(queued(s, id).map(o => o.queuePosition)).toEqual([1, 2]);

    hold(promoted.taskId!); await settle(promoted.taskId!);
    expect(occurrences(s, id).find(o => o.occurrenceAt === '2030-01-03T07:30:00.000Z')?.outcome).toBe('created');
    expect(taskCount()).toBe(3);
    expect(s.schedules.get(id)?.queuedCount).toBe(1);
  });

  // F. A repeated terminal notification must not promote twice.
  it('F — a duplicate terminal event promotes nothing a second time', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();
    await settle(running);
    expect(taskCount()).toBe(2);
    // The same notification again — and again — while the promoted task lives.
    s.schedules.promote(id); s.schedules.promote(id);
    expect(taskCount()).toBe(2);
    expect(s.schedules.get(id)?.queuedCount).toBe(1);
  });

  // G + U. A terminal event, the fallback sweep and a direct promotion racing.
  it('G/U — sweep, terminal event and a concurrent promotion yield exactly one task', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();
    expect(queued(s, id)).toHaveLength(2);

    // Settle WITHOUT flushing, so the terminal-event promotion is still pending,
    // then race the fallback sweep and a third would-be promoter against it.
    built.tasks.transition(running, 'COMPLETED');
    s.schedules.drain();       // the bounded fallback sweep
    s.schedules.promote(id);   // a concurrent promoter
    await flush();             // the queued terminal-event microtask
    expect(taskCount()).toBe(2);
    const front = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    expect(front.outcome).toBe('created');
    // Exactly one occurrence carries the new task, and exactly one task exists.
    expect(occurrences(s, id).filter(o => o.taskId === front.taskId)).toHaveLength(1);
    expect(s.schedules.get(id)?.queuedCount).toBe(1);
  });

  // H + V. Restart with a backlog and nothing running.
  it('H/V — a restart with a backlog and no active task promotes the oldest exactly once', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();
    // The process dies before the terminal event is ever delivered.
    db.prepare("UPDATE tasks SET state = 'COMPLETED' WHERE id = ?").run(running);

    at('2030-01-03T08:00:00Z');
    const rebooted = scheduler();
    await rebooted.reconcileOnBoot();
    expect(taskCount()).toBe(2);
    const promoted = occurrences(rebooted, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    expect(promoted).toMatchObject({ outcome: 'created' });
    expect(promoted.promotedAt).toBeTruthy();
    // FIFO survives the restart: 01-03 is still behind, still position 1 now.
    expect(queued(rebooted, id).map(o => o.occurrenceAt)).toEqual(['2030-01-03T07:30:00.000Z']);
    // A second boot promotes nothing more while the promoted task is alive.
    hold(promoted.taskId!);
    await scheduler().reconcileOnBoot();
    expect(taskCount()).toBe(2);
  });

  // I. Restart must not promote past a live task.
  it('I — a restart with a backlog AND an active task promotes nothing', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-02T08:00:00Z');
    await scheduler().reconcileOnBoot();
    expect(taskCount()).toBe(1);
    expect(queued(s, id)).toHaveLength(1);
    expect(s.schedules.get(id)?.activeTaskId).toBe(running);
  });

  // J. The durability boundary itself.
  it('J — a crash inside the promotion transaction leaves neither a task nor a promoted row', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    db.prepare("UPDATE tasks SET state = 'COMPLETED' WHERE id = ?").run(running);

    // Fail AFTER the task is created and BEFORE the transaction commits.
    const park = vi.spyOn(s, 'attach').mockImplementationOnce(() => { throw new Error('crash at the promotion boundary'); });
    expect(() => s.schedules.promote(id)).toThrow(/crash at the promotion boundary/);
    park.mockRestore();
    // Neither half survived: no orphan task, and the occurrence is still promotable.
    expect(taskCount()).toBe(1);
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual(['2030-01-02T07:30:00.000Z']);

    // Recovery yields exactly one linked task.
    const recovered = s.schedules.promote(id);
    expect(taskCount()).toBe(2);
    expect(occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z'))
      .toMatchObject({ outcome: 'created', taskId: recovered });
  });

  // K. The intent snapshot — the reason a queued occurrence is not just a date.
  it('K — a queued occurrence runs its OWN intent, not the edited schedule intent', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s, { ...daily, goal: 'goal A', constraints: ['c-A'] });
    at('2030-01-02T07:30:00Z'); await s.tick();          // queued with goal A
    at('2030-01-02T09:00:00Z');
    s.schedules.update(id, { goal: 'goal B', constraints: ['c-B'] });
    await settle(running);

    const promoted = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    const task = built.tasks.get(promoted.taskId!)!;
    expect(task.goal).toBe('goal A');
    expect(JSON.parse(task.envelope).constraints).toEqual(['c-A']);

    // The NEXT occurrence uses the new intent.
    hold(promoted.taskId!); await settle(promoted.taskId!);
    at('2030-01-03T07:30:00Z'); await s.tick();
    const next = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-03T07:30:00.000Z')!;
    expect(built.tasks.get(next.taskId!)?.goal).toBe('goal B');
  });

  // L. A cron/timezone edit cannot move queued work.
  it('L — a cron/timezone edit leaves queued occurrenceAt and order untouched', async () => {
    await boot(); const s = scheduler();
    const [id] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();
    const before = queued(s, id).map(o => o.occurrenceAt);

    at('2030-01-03T09:00:00Z');
    const edited = s.schedules.update(id, { cron: '0 9 * * *', timezone: 'Europe/Berlin' });
    expect(edited.nextFireAt).toBe('2030-01-04T08:00:00.000Z');   // future only
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual(before);
    expect(queued(s, id).map(o => o.queuePosition)).toEqual([1, 2]);
  });

  // M. Disable keeps the backlog durable and stops promotion; enable drains it.
  it('M — a disabled schedule keeps its backlog and does not run it; enabling drains oldest-first', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();
    s.schedules.update(id, { enabled: false });
    await settle(running);                       // the terminal event fires anyway
    at('2030-01-10T00:00:00Z'); await s.tick();  // and so does the fallback sweep
    expect(taskCount()).toBe(1);
    expect(queued(s, id)).toHaveLength(2);

    s.schedules.update(id, { enabled: true });
    await s.tick();
    expect(taskCount()).toBe(2);
    expect(occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')?.outcome).toBe('created');
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual(['2030-01-03T07:30:00.000Z']);
  });

  it('M — a globally disabled scheduler promotes nothing, and the backlog survives', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    config.scheduler = { ...config.scheduler!, enabled: false };
    await settle(running);
    await s.tick();
    expect(taskCount()).toBe(1);
    expect(queued(s, id)).toHaveLength(1);

    config.scheduler = { ...config.scheduler!, enabled: true };
    await s.tick();
    expect(taskCount()).toBe(2);
  });

  // N. The documented delete decision, with no orphan work.
  it('N — deleting a schedule drops its unpromoted queued occurrences and orphans nothing', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    expect(s.schedules.remove(id)).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schedule_occurrences').get() as { n: number }).n).toBe(0);
    // The task the schedule already created is an ordinary task, not cancelled.
    expect(built.tasks.get(running)?.state).toBe('RUNNING');
    // Nothing is left to promote, and a sweep finds no orphan work.
    await s.tick();
    expect(taskCount()).toBe(1);
  });

  // O. The catch-up bound stays authoritative — queue mode is not a replay.
  it('O — catch-up queues at most one legitimate occurrence behind the backlog', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s, { ...daily, catchUpWindowMinutes: 24 * 60 });
    at('2030-01-02T07:30:00Z'); await s.tick();   // queued behind `running`
    // Now go down for three days and come back.
    at('2030-01-06T12:00:00Z');
    await scheduler().reconcileOnBoot();
    const rows = occurrences(s, id);
    // Exactly one NEW queued occurrence — the most recent miss inside the window.
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual([
      '2030-01-02T07:30:00.000Z', '2030-01-06T07:30:00.000Z']);
    // Older misses outside the enumeration window are not queued and not invented.
    expect(rows.filter(o => o.outcome === 'queued')).toHaveLength(2);
    expect(rows.some(o => o.occurrenceAt === '2030-01-04T07:30:00.000Z')).toBe(false);
    expect(taskCount()).toBe(1);
    expect(built.tasks.get(running)?.state).toBe('RUNNING');
  });

  it('O — older misses inside the window are still skipped-catch-up, not queued', async () => {
    await boot(); const s = scheduler();
    const [id] = await firstOccurrenceRunning(s, { ...daily, cron: '0 * * * *', catchUpWindowMinutes: 24 * 60 });
    at('2030-01-01T12:00:00Z');
    await scheduler().reconcileOnBoot();
    const rows = occurrences(s, id, 200);
    expect(rows.filter(o => o.outcome === 'queued')).toHaveLength(1);
    expect(rows.filter(o => o.outcome === 'skipped-catch-up').length).toBeGreaterThan(1);
    // The one queued occurrence is the most recent miss, not the oldest.
    expect(rows.find(o => o.outcome === 'queued')!.occurrenceAt).toBe('2030-01-01T12:00:00.000Z');
  });

  // P + Q. DST: queue mode changes nothing about occurrence calculation.
  it('P — a fall-back ambiguous local time queues exactly one occurrence', async () => {
    await boot(); const s = scheduler();
    at('2030-11-02T00:00:00Z');
    const schedule = s.schedules.create({ ...daily, cron: '30 1 * * *' });
    at('2030-11-02T05:30:00Z'); await s.tick();
    hold(occurrences(s, schedule.scheduleId)[0]!.taskId!);
    // 2030-11-03, America/New_York repeats 01:00–02:00 local; 01:30 is ambiguous.
    for (const tick of ['2030-11-03T05:30:00Z', '2030-11-03T06:30:00Z', '2030-11-04T06:30:00Z']) { at(tick); await s.tick(); }
    const onTheDay = occurrences(s, schedule.scheduleId).filter(o => o.occurrenceAt.startsWith('2030-11-03'));
    expect(onTheDay).toHaveLength(1);
    expect(onTheDay[0]).toMatchObject({ occurrenceAt: '2030-11-03T05:30:00.000Z', outcome: 'queued' });
  });

  it('Q — a nonexistent spring-forward local time is never queued', async () => {
    await boot(); const s = scheduler();
    at('2030-03-09T00:00:00Z');
    const schedule = s.schedules.create(daily);   // 02:30 America/New_York
    at('2030-03-09T07:30:00Z'); await s.tick();
    hold(occurrences(s, schedule.scheduleId)[0]!.taskId!);
    at('2030-03-12T00:00:00Z'); await s.tick();
    const all = occurrences(s, schedule.scheduleId).map(o => o.occurrenceAt);
    expect(all).not.toContain('2030-03-10T07:30:00.000Z');   // 02:30 EST never happened
    expect(all).toContain('2030-03-11T06:30:00.000Z');
  });

  // R + S + T. Queueing routes nothing, recommends nothing, claims nothing.
  it('R/S/T — queueing produces no routing decision, no K13 recommendation and no resource claim', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    const decisionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n;
    // A K13 SHADOW recommendation is recorded on the routing decision itself.
    const recommendations = () => (db.prepare("SELECT COUNT(*) AS n FROM routing_decisions WHERE json_extract(explanation, '$.modelRecommendation') IS NOT NULL").get() as { n: number }).n;
    const recommendationsBefore = recommendations();
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();

    // Queued work is not a task: nothing was routed, recommended or claimed.
    expect((db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n).toBe(decisionsBefore);
    expect(recommendations()).toBe(recommendationsBefore);
    expect((db.prepare('SELECT COUNT(*) AS n FROM resource_claims').get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM wait_conditions WHERE resource IS NOT NULL").get() as { n: number }).n).toBe(0);

    // Promotion goes through the ordinary path: one K1 time wait, then routing.
    await settle(running);
    const promoted = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    // Routing happens at the WAKE, not at promotion — the ordinary K1 protocol.
    expect((db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n).toBe(decisionsBefore);
    await s.tick(); await flush();
    const condition = db.prepare("SELECT kind, reason FROM wait_conditions WHERE task_id = ?").get(promoted.taskId!) as { kind: string; reason: string };
    expect(condition.kind).toBe('time');
    expect(condition.reason).toContain('2030-01-02T07:30:00.000Z');
    expect(s.dispatches(promoted.taskId!).length).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n).toBeGreaterThan(decisionsBefore);
    // K13 stays SHADOW: nothing was applied, only observed.
    const applied = db.prepare("SELECT COUNT(*) AS n FROM routing_decisions WHERE json_extract(explanation, '$.modelRecommendation.applied') = 1").get() as { n: number };
    expect(applied.n).toBe(0);
  });

  // P1 — the queued snapshot is the COMPLETE TaskIntent, not just the goal.
  it('P1 — a promoted occurrence carries its complete queued-time intent, including requirements; the next occurrence carries the new one', async () => {
    await boot(); const s = scheduler();
    const intentA: ScheduleInput = { ...daily, goal: 'goal A', constraints: ['c-A'], repoPath: '/tmp/repo-a',
      profile: 'fastest', overrides: { model: 'selector-A' }, requirements: { minContextTokens: 111_000 } };
    const [id, running] = await firstOccurrenceRunning(s, intentA);

    // The FIRST occurrence (immediate creation) already went through the SAME
    // helper: it must carry the complete intent too, requirements included.
    const first = occurrences(s, id).find(o => o.outcome === 'created')!;
    const firstIntent = JSON.parse(built.tasks.get(first.taskId!)!.intent_json) as TaskIntent;
    // `repository.branch` is the task's OWN fresh identity, stamped at creation
    // by the ordinary task-creation path — not something K5 invents or freezes.
    expect(firstIntent).toEqual({ goal: 'goal A', constraints: ['c-A'], repository: { path: '/tmp/repo-a', branch: `task/${first.taskId}` },
      profile: 'fastest', overrides: { model: 'selector-A' }, requirements: { minContextTokens: 111_000 } });

    at('2030-01-02T07:30:00Z'); await s.tick();   // occurrence #2 queued with intent A

    at('2030-01-02T09:00:00Z');
    const intentB: Partial<ScheduleInput> = { goal: 'goal B', constraints: ['c-B'], repoPath: '/tmp/repo-b',
      profile: 'best-quality', overrides: { model: 'selector-B' }, requirements: { minContextTokens: 222_000 } };
    s.schedules.update(id, intentB);
    await settle(running);   // promotes occurrence #2 from ITS OWN snapshot, not the edit

    const promoted = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    const promotedIntent = JSON.parse(built.tasks.get(promoted.taskId!)!.intent_json) as TaskIntent;
    expect(promotedIntent).toEqual({ goal: 'goal A', constraints: ['c-A'], repository: { path: '/tmp/repo-a', branch: `task/${promoted.taskId}` },
      profile: 'fastest', overrides: { model: 'selector-A' }, requirements: { minContextTokens: 111_000 } });
    // The task's OWN branch identity is fresh at creation — never frozen from the schedule.
    const promotedTask = built.tasks.get(promoted.taskId!)!;
    expect(JSON.parse(promotedTask.envelope).repository).toMatchObject({ path: '/tmp/repo-a', branch: `task/${promoted.taskId}` });

    // The NEXT occurrence — fired after the edit — carries the NEW complete intent.
    hold(promoted.taskId!); await settle(promoted.taskId!);
    at('2030-01-03T07:30:00Z'); await s.tick();
    const next = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-03T07:30:00.000Z')!;
    const nextIntent = JSON.parse(built.tasks.get(next.taskId!)!.intent_json) as TaskIntent;
    expect(nextIntent).toEqual({ goal: 'goal B', constraints: ['c-B'], repository: { path: '/tmp/repo-b', branch: `task/${next.taskId}` },
      profile: 'best-quality', overrides: { model: 'selector-B' }, requirements: { minContextTokens: 222_000 } });
  });

  // K13 — requirements are a hard filter; queueing must not weaken or delay that.
  it('K13 — a promoted occurrence\'s declared requirement hard-filters candidates exactly like an ordinary task\'s, and stays SHADOW', async () => {
    await boot(); const s = scheduler();
    const requirements = { minContextTokens: 5_000_000 }; // far past anything the fake catalog reports
    const [id, running] = await firstOccurrenceRunning(s, { ...daily, requirements });
    const decisionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n;
    at('2030-01-02T07:30:00Z'); await s.tick();   // queued: no recommendation exists yet
    expect((db.prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number }).n).toBe(decisionsBefore);

    await settle(running);   // promotes; routing happens at the WAKE, the ordinary K1 protocol
    const promoted = occurrences(s, id).find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')!;
    await s.tick(); await flush();
    const persisted = db.prepare('SELECT explanation FROM routing_decisions WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(promoted.taskId!) as { explanation: string };
    const promotedRecommendation = JSON.parse(persisted.explanation).modelRecommendation as ModelRecommendation;
    const promotedCandidate = promotedRecommendation.candidates.find(c => c.assistantId === A)!;

    // An ordinary task carrying the identical requirement, for parity.
    const ordinary = built.tasks.create({ goal: 'ordinary requirements parity', requirements });
    const { explanation: ordinaryExplanation } = built.orchestrator.routeTask(ordinary.taskId, 'intake');
    const ordinaryCandidate = ordinaryExplanation.modelRecommendation!.candidates.find(c => c.assistantId === A)!;

    expect(promotedCandidate.eligible).toBe(false);
    expect(promotedCandidate.eligible).toBe(ordinaryCandidate.eligible);
    expect(promotedCandidate.filterFailures).toEqual(ordinaryCandidate.filterFailures);
    expect(promotedCandidate.filterFailures.join(' ')).toContain('declares a minimum of 5000000 tokens');
    // SHADOW: a hard requirement excludes a candidate; nothing here APPLIES a choice.
    expect((promotedRecommendation as unknown as { applied?: boolean }).applied).toBeFalsy();
  });

  // FAIL CLOSED — a queued snapshot that cannot be trusted must never fall back
  // to the current schedule intent, and must never disappear from the backlog.
  it('FAIL CLOSED — a corrupted queued intent snapshot promotes nothing, stays queued, and is reported', async () => {
    await boot();
    const onError = vi.fn();
    const s = new Scheduler({ db, config, tasks: built.tasks, orchestrator: built.orchestrator, bus: built.bus, now, onError });
    const [id, running] = await firstOccurrenceRunning(s);
    at('2030-01-02T07:30:00Z'); await s.tick();
    // The schema's NOT NULL keeps a legitimate writer from ever producing this;
    // this simulates byte corruption in the stored snapshot itself.
    db.prepare("UPDATE schedule_occurrences SET intent_json = '{not-json' WHERE schedule_id = ? AND outcome = 'queued'").run(id);
    // The process died before delivering the terminal event (as in test H/V),
    // so a direct promote() call is the one that must hit the corrupt row.
    db.prepare("UPDATE tasks SET state = 'COMPLETED' WHERE id = ?").run(running);

    expect(() => s.schedules.promote(id)).toThrow(/corrupt intent snapshot/);
    // Never silently promoted from the current schedule intent, and never dropped.
    expect(queued(s, id).map(o => o.occurrenceAt)).toEqual(['2030-01-02T07:30:00.000Z']);
    expect(taskCount()).toBe(1);

    // The bounded fallback sweep hits the same defect and reports it, rather
    // than crashing the sweep or quietly promoting from the wrong intent.
    s.schedules.drain();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('corrupt intent snapshot') }));
    expect(taskCount()).toBe(1);
    expect(queued(s, id)).toHaveLength(1);
  });

  // Schema — the strengthened CHECK keeps queued/promoted/immediate rows distinguishable.
  it('schema — schedule_occurrences CHECK rejects a queued row missing its provenance halves', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    const insert = (queuedAt: string | null, intentJson: string | null, taskId: string | null, promotedAt: string | null) =>
      db.prepare(`INSERT INTO schedule_occurrences(schedule_id,occurrence_at,fired_at,outcome,queued_at,intent_json,task_id,promoted_at)
        VALUES(?,?,?,'queued',?,?,?,?)`).run(id, '2099-01-01T00:00:00.000Z', 't', queuedAt, intentJson, taskId, promotedAt);
    expect(() => insert(null, '{}', null, null)).toThrow();          // queued without queued_at
    expect(() => insert('t', null, null, null)).toThrow();           // queued without a snapshot
    expect(() => insert('t', '{}', running, null)).toThrow();        // queued rows carry no task yet
    expect(() => insert('t', '{}', null, 't')).toThrow();            // queued rows are never promoted
    expect(() => insert('t', '{}', null, null)).not.toThrow();       // well-formed queued row
  });

  // P2 — the operator must be able to see the queue HEAD, not just recent history.
  it('P2 — queuedOccurrences is the FIFO head, independent of the recent-history page', async () => {
    await boot(); const s = scheduler();
    const [id] = await firstOccurrenceRunning(s);
    for (const day of ['02', '03', '04']) { at(`2030-01-${day}T07:30:00Z`); await s.tick(); }
    // A single-row recency page surfaces the NEWEST queued occurrence
    // (position 3) — exactly the one an operator must NOT mistake for "next
    // to run". The actual queue head (position 1) is nowhere in this page.
    const page = occurrences(s, id, 1);
    expect(page[0]).toMatchObject({ occurrenceAt: '2030-01-04T07:30:00.000Z', queuePosition: 3 });

    const backlog = s.schedules.queuedOccurrences(id);
    expect(backlog.map(o => o.occurrenceAt)).toEqual([
      '2030-01-02T07:30:00.000Z', '2030-01-03T07:30:00.000Z', '2030-01-04T07:30:00.000Z']);
    expect(backlog.map(o => o.queuePosition)).toEqual([1, 2, 3]);
    expect(backlog.every(o => o.outcome === 'queued')).toBe(true);

    // The API detail read exposes it independently of `occurrences`.
    const detail = await built.app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers: headers() });
    expect((detail.json().queuedOccurrences as typeof backlog).map(o => o.occurrenceAt)).toEqual(backlog.map(o => o.occurrenceAt));
  });

  // §18. Fairness under everything that could plausibly reorder a queue.
  it('fairness — nothing reorders the queue: not a restart, an edit or a re-tick', async () => {
    await boot(); const s = scheduler();
    const [id, running] = await firstOccurrenceRunning(s);
    for (const day of ['02', '03', '04']) { at(`2030-01-${day}T07:30:00Z`); await s.tick(); }
    const order = queued(s, id).map(o => o.occurrenceAt);

    s.schedules.update(id, { goal: 'edited', cron: '15 4 * * *', timezone: 'Asia/Tokyo', overlap: 'queue' });
    at('2030-01-05T00:00:00Z'); await s.tick();
    const rebooted = scheduler(); await rebooted.reconcileOnBoot();
    expect(queued(rebooted, id).slice(0, 3).map(o => o.occurrenceAt)).toEqual(order);

    // Draining preserves the order, one task at a time, to the end.
    let active = running;
    for (const expected of order) {
      await settle(active);
      const promoted = occurrences(rebooted, id).find(o => o.occurrenceAt === expected)!;
      expect(promoted.outcome).toBe('created');
      active = promoted.taskId!;
      hold(active);
    }
  });

  // §6. The invariant itself, asserted after every step of a hostile sequence.
  it('no-overlap — a schedule never has two non-terminal tasks, through ticks, events and boots', async () => {
    await boot(); const s = scheduler();
    const nonTerminal = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM schedule_occurrences o JOIN tasks t ON t.id = o.task_id
      WHERE o.schedule_id = ? AND t.state NOT IN ('COMPLETED','FAILED','CANCELLED')`).get(id) as { n: number }).n;
    const [id, first] = await firstOccurrenceRunning(s);
    expect(nonTerminal(id)).toBe(1);

    let active = first;
    // Interleave everything that could plausibly produce a second task: a cron
    // tick, a terminal event, a redundant direct promotion, the fallback sweep
    // and a fresh process booting over the same durable state.
    for (const day of ['02', '03', '04', '05']) {
      at(`2030-01-${day}T07:30:00Z`);
      await s.tick();                     expect(nonTerminal(id)).toBeLessThanOrEqual(1);
      s.schedules.drain();                expect(nonTerminal(id)).toBeLessThanOrEqual(1);
      s.schedules.promote(id);            expect(nonTerminal(id)).toBeLessThanOrEqual(1);
      await scheduler().reconcileOnBoot(); expect(nonTerminal(id)).toBeLessThanOrEqual(1);
      await settle(active);               expect(nonTerminal(id)).toBeLessThanOrEqual(1);
      const next = occurrences(s, id).filter(o => o.outcome === 'created' && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(built.tasks.get(o.taskId!)?.state ?? ''));
      if (next.length) { active = next[0]!.taskId!; hold(active); }
    }
    // Every occurrence that ever produced a task produced exactly one, and no
    // task id is shared between two occurrences.
    const withTasks = occurrences(s, id, 200).filter(o => o.taskId);
    expect(new Set(withTasks.map(o => o.taskId)).size).toBe(withTasks.length);
    // Every promoted row carries both halves of its provenance.
    for (const o of occurrences(s, id, 200).filter(o => o.queuedAt && o.outcome === 'created')) {
      expect(o.promotedAt).toBeTruthy();
      expect(o.taskId).toBeTruthy();
    }
  });

  // §16. The API is the operator's view of all of the above.
  it('API — create/update accept overlap and the reads expose queue truth', async () => {
    await boot(); const s = scheduler();
    const created = await built.app.inject({ method: 'POST', url: '/api/schedules', headers: headers(), payload: daily });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ overlap: 'queue', queuedCount: 0 });
    const id = created.json().scheduleId as string;

    at('2030-01-01T07:30:00Z'); await s.tick();
    const first = occurrences(s, id)[0]!;
    hold(first.taskId!);
    at('2030-01-02T07:30:00Z'); await s.tick();
    at('2030-01-03T07:30:00Z'); await s.tick();

    const detail = (await built.app.inject({ method: 'GET', url: `/api/schedules/${id}`, headers: headers() })).json();
    expect(detail).toMatchObject({ overlap: 'queue', queuedCount: 2, activeTaskId: first.taskId });
    const rows = detail.occurrences as Array<Record<string, unknown>>;
    expect(rows.find(o => o.occurrenceAt === '2030-01-02T07:30:00.000Z')).toMatchObject({ outcome: 'queued', queuePosition: 1 });
    expect(rows.find(o => o.occurrenceAt === '2030-01-03T07:30:00.000Z')).toMatchObject({ outcome: 'queued', queuePosition: 2 });
    expect((await built.app.inject({ method: 'GET', url: '/api/schedules', headers: headers() })).json()[0]).toMatchObject({ queuedCount: 2 });

    // Switching back to skip leaves the existing backlog durable and drainable.
    const patched = await built.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, headers: headers(), payload: { overlap: 'skip' } });
    expect(patched.json()).toMatchObject({ overlap: 'skip', queuedCount: 2 });
    expect((await built.app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, headers: headers(), payload: { overlap: 'sometimes' } })).statusCode).toBe(400);
    await settle(first.taskId!);
    expect(s.schedules.get(id)?.queuedCount).toBe(1);
  });
});
