import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { isTerminal, redactValue, type Schedule, type ScheduleInput, type ScheduleOccurrence, type ScheduleOutcome, type TaskIntent, type TaskState } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { TaskStore } from './tasks.js';

/**
 * A catch-up sweep never enumerates more than this many missed occurrences.
 * At most one of them fires either way; the cap bounds the audit rows a
 * per-minute schedule can write after a long outage.
 */
const MAX_CATCH_UP_ROWS = 200;

type Row = {
  schedule_id: string; kind: 'user' | 'system'; intent_json: string; cron: string; timezone: string;
  enabled: number; overlap: 'skip'; catch_up_window_minutes: number;
  last_fired_at: string | null; next_fire_at: string | null; last_task_id: string | null;
  created_at: string; updated_at: string;
};

export interface ScheduleDeps {
  db: Db;
  tasks: TaskStore;
  now: () => Date;
  /**
   * Parks a freshly created task on a due `time` wait so the occurrence is
   * dispatched by the existing K1 wake protocol. K5 adds no execution path.
   */
  park: (taskId: string, occurrenceAt: string, reason: string) => void;
  onError?: (error: unknown) => void;
}

/**
 * K5 recurring schedules over the existing scheduler timer. Next-fire is
 * computed in the schedule's IANA zone; firing is one transaction whose
 * `(scheduleId, occurrenceAt)` primary key is the deduplication mechanism.
 */
export class ScheduleService {
  constructor(private d: ScheduleDeps) {}
  private iso(): string { return this.d.now().toISOString(); }

  /** Throws on an unusable cron expression or unknown IANA zone. */
  private cron(pattern: string, timezone: string): Cron {
    if (pattern.trim().split(/\s+/).length !== 5) throw new Error('A schedule requires a 5-field cron expression');
    // An unknown IANA zone only surfaces when the pattern is evaluated.
    try {
      const job = new Cron(pattern, { timezone });
      if (!job.nextRun(this.d.now())) throw new Error('Cron expression never fires again');
      return job;
    } catch (error) { throw new Error(`Invalid cron or timezone: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * True when `instant`'s local wall clock in `timezone` actually satisfies the
   * pattern. On a spring-forward day the cron library shifts a nonexistent local
   * time forward instead of skipping it, and this is what catches that: the
   * pattern is re-evaluated against the wall-clock fields with UTC semantics.
   */
  private localTimeExists(pattern: string, timezone: string, instant: Date): boolean {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    // Intl renders midnight as hour 24 in some locales/zones.
    const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
    const match = new Cron(pattern, { timezone: 'UTC' }).nextRun(new Date(wall - 1));
    return !!match && match.getTime() === wall;
  }

  /** Next firing instant strictly after `after`, skipping nonexistent local times. */
  private nextFireAt(pattern: string, timezone: string, after: Date): string | null {
    const job = new Cron(pattern, { timezone });
    let candidate = job.nextRun(after);
    // A DST gap skips at most a couple of occurrences; the bound only guards
    // against a pathological pattern that never lands on a real local time.
    for (let i = 0; candidate && i < 32; i++) {
      if (this.localTimeExists(pattern, timezone, candidate)) return candidate.toISOString();
      candidate = job.nextRun(candidate);
    }
    return candidate ? candidate.toISOString() : null;
  }

  private hydrate(r: Row): Schedule {
    return { schemaVersion: 1, scheduleId: r.schedule_id, kind: r.kind, intent: JSON.parse(r.intent_json) as TaskIntent,
      cron: r.cron, timezone: r.timezone, enabled: !!r.enabled, overlap: r.overlap,
      catchUpWindowMinutes: r.catch_up_window_minutes, lastFiredAt: r.last_fired_at ?? undefined,
      nextFireAt: r.next_fire_at ?? undefined, lastTaskId: r.last_task_id ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list(): Schedule[] {
    return (this.d.db.prepare('SELECT * FROM schedules ORDER BY created_at, schedule_id').all() as Row[]).map(r => this.hydrate(r));
  }
  get(scheduleId: string): Schedule | undefined {
    const r = this.d.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(scheduleId) as Row | undefined;
    return r ? this.hydrate(r) : undefined;
  }
  occurrences(scheduleId: string, limit = 50): ScheduleOccurrence[] {
    return (this.d.db.prepare('SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY occurrence_at DESC LIMIT ?')
      .all(scheduleId, limit) as Array<{ schedule_id: string; occurrence_at: string; fired_at: string; outcome: ScheduleOutcome; task_id: string | null }>)
      .map(r => ({ scheduleId: r.schedule_id, occurrenceAt: r.occurrence_at, firedAt: r.fired_at, outcome: r.outcome, taskId: r.task_id ?? undefined }));
  }

  create(input: ScheduleInput): Schedule {
    input = redactValue(input);
    if (typeof input?.goal !== 'string' || !input.goal.trim()) throw new Error('A schedule requires a goal');
    if (typeof input.cron !== 'string' || typeof input.timezone !== 'string') throw new Error('A schedule requires cron and timezone');
    if (input.catchUpWindowMinutes !== undefined && (!Number.isInteger(input.catchUpWindowMinutes) || input.catchUpWindowMinutes < 0)) throw new Error('catchUpWindowMinutes must be a non-negative integer');
    this.cron(input.cron, input.timezone);
    const scheduleId = `sched_${randomUUID()}`;
    const now = this.iso();
    const intent: TaskIntent = { goal: input.goal, constraints: input.constraints ?? [],
      repository: input.repoPath ? { path: input.repoPath } : undefined,
      profile: input.profile ?? 'auto', overrides: input.overrides };
    this.d.db.prepare(`INSERT INTO schedules(schedule_id,kind,intent_json,cron,timezone,enabled,overlap,catch_up_window_minutes,next_fire_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'skip',?,?,?,?)`).run(scheduleId, input.kind ?? 'user', JSON.stringify(intent), input.cron, input.timezone,
      input.enabled === false ? 0 : 1, input.catchUpWindowMinutes ?? 1440, this.nextFireAt(input.cron, input.timezone, this.d.now()), now, now);
    return this.get(scheduleId)!;
  }

  /** Any edit recomputes `nextFireAt` from now; occurrences already fired are untouched. */
  update(scheduleId: string, patch: Partial<ScheduleInput>): Schedule {
    patch = redactValue(patch);
    const current = this.get(scheduleId);
    if (!current) throw new Error('Unknown schedule');
    const cron = patch.cron ?? current.cron;
    const timezone = patch.timezone ?? current.timezone;
    if (patch.catchUpWindowMinutes !== undefined && (!Number.isInteger(patch.catchUpWindowMinutes) || patch.catchUpWindowMinutes < 0)) throw new Error('catchUpWindowMinutes must be a non-negative integer');
    this.cron(cron, timezone);
    const intent: TaskIntent = {
      goal: patch.goal ?? current.intent.goal,
      constraints: patch.constraints ?? current.intent.constraints,
      repository: patch.repoPath !== undefined ? { path: patch.repoPath } : current.intent.repository,
      profile: patch.profile ?? current.intent.profile,
      overrides: patch.overrides !== undefined ? patch.overrides : current.intent.overrides,
    };
    this.d.db.prepare(`UPDATE schedules SET intent_json = ?, cron = ?, timezone = ?, enabled = ?, catch_up_window_minutes = ?, next_fire_at = ?, updated_at = ? WHERE schedule_id = ?`)
      .run(JSON.stringify(intent), cron, timezone, (patch.enabled ?? current.enabled) ? 1 : 0,
        patch.catchUpWindowMinutes ?? current.catchUpWindowMinutes,
        this.nextFireAt(cron, timezone, this.d.now()), this.iso(), scheduleId);
    return this.get(scheduleId)!;
  }

  /** Deleting a schedule takes its occurrence history with it (ON DELETE CASCADE). */
  remove(scheduleId: string): boolean {
    return this.d.db.prepare('DELETE FROM schedules WHERE schedule_id = ?').run(scheduleId).changes > 0;
  }

  /** The next armed deadline contributed by schedules, if any. */
  nextDeadline(): string | null {
    return (this.d.db.prepare("SELECT MIN(next_fire_at) AS at FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL").get() as { at: string | null }).at;
  }

  private due(): Row[] {
    return this.d.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?').all(this.iso()) as Row[];
  }

  private occurrence(scheduleId: string, occurrenceAt: string, outcome: ScheduleOutcome, taskId?: string): void {
    // INSERT OR IGNORE: a duplicate tick for the same instant creates nothing.
    this.d.db.prepare('INSERT OR IGNORE INTO schedule_occurrences(schedule_id,occurrence_at,fired_at,outcome,task_id) VALUES(?,?,?,?,?)')
      .run(scheduleId, occurrenceAt, this.iso(), outcome, taskId ?? null);
  }

  /**
   * Missed occurrences from the stored `nextFireAt` up to now, newest last. The
   * walk never reaches further back than the catch-up window, so an older gap
   * costs a resync rather than a row per instant.
   */
  private missed(row: Row, nowMs: number): Date[] {
    const windowStart = nowMs - row.catch_up_window_minutes * 60_000;
    const from = Math.max(Date.parse(row.next_fire_at!), windowStart);
    const job = new Cron(row.cron, { timezone: row.timezone });
    const out: Date[] = [];
    let t = job.nextRun(new Date(from - 1));
    while (t && t.getTime() <= nowMs && out.length < MAX_CATCH_UP_ROWS) {
      if (this.localTimeExists(row.cron, row.timezone, t)) out.push(t);
      t = job.nextRun(t);
    }
    return out;
  }

  /**
   * Fires every schedule that has come due. `mode` decides what a missed
   * occurrence means: an ordinary tick or restart catches up (at most one fire
   * inside the window), while the first tick after the scheduler is re-enabled
   * records exactly one `skipped-disabled` instead.
   */
  fireDue(mode: 'catch-up' | 'disabled' = 'catch-up'): void {
    for (const row of this.due()) {
      try { this.advance(row, mode); } catch (error) { this.d.onError?.(error); }
    }
  }

  private advance(row: Row, mode: 'catch-up' | 'disabled'): void {
    const nowMs = this.d.now().getTime();
    const missed = this.missed(row, nowMs);
    if (!missed.length) { this.resync(row, new Date(nowMs)); return; }
    const last = missed.pop()!;
    this.d.db.transaction(() => {
      // Re-read inside the transaction: a concurrent edit or fire wins.
      const current = this.d.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(row.schedule_id) as Row | undefined;
      if (!current || !current.enabled || current.next_fire_at !== row.next_fire_at) return;
      if (mode === 'disabled') {
        this.occurrence(row.schedule_id, last.toISOString(), 'skipped-disabled');
      } else {
        for (const skipped of missed) this.occurrence(row.schedule_id, skipped.toISOString(), 'skipped-catch-up');
        this.fire(current, last);
      }
      this.resync(current, last);
    })();
  }

  /** One occurrence: overlap check, task creation, occurrence row, next fire. */
  private fire(row: Row, occurrence: Date): void {
    const occurrenceAt = occurrence.toISOString();
    if (this.d.db.prepare('SELECT 1 FROM schedule_occurrences WHERE schedule_id = ? AND occurrence_at = ?').get(row.schedule_id, occurrenceAt)) return;
    const previous = row.last_task_id ? this.d.tasks.get(row.last_task_id) : undefined;
    if (previous && !isTerminal(previous.state as TaskState)) {
      this.occurrence(row.schedule_id, occurrenceAt, 'skipped-overlap');
      return;
    }
    const intent = JSON.parse(row.intent_json) as TaskIntent;
    const task = this.d.tasks.create({ goal: intent.goal, constraints: intent.constraints,
      repoPath: intent.repository?.path, profile: intent.profile, overrides: intent.overrides });
    this.d.park(task.taskId, occurrenceAt, `Scheduled occurrence ${occurrenceAt}`);
    this.occurrence(row.schedule_id, occurrenceAt, 'created', task.taskId);
    this.d.db.prepare('UPDATE schedules SET last_fired_at = ?, last_task_id = ?, updated_at = ? WHERE schedule_id = ?')
      .run(occurrenceAt, task.taskId, this.iso(), row.schedule_id);
  }

  private resync(row: Row, after: Date): void {
    this.d.db.prepare('UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE schedule_id = ?')
      .run(this.nextFireAt(row.cron, row.timezone, after), this.iso(), row.schedule_id);
  }

  /**
   * Records whether the scheduler is enabled and reports whether it was off the
   * last time it looked. A restart alone cannot tell "we were down" from "we
   * were switched off", so the answer has to be durable.
   */
  observeEnabled(enabled: boolean): boolean {
    const previous = this.d.db.prepare('SELECT enabled FROM scheduler_state WHERE id = 1').get() as { enabled: number } | undefined;
    this.d.db.prepare('INSERT INTO scheduler_state(id,enabled,observed_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, observed_at = excluded.observed_at')
      .run(enabled ? 1 : 0, this.iso());
    return previous !== undefined && !previous.enabled;
  }
}
