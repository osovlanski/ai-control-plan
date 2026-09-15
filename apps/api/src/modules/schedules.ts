import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { redactValue, TERMINAL_STATES, type Schedule, type ScheduleInput, type ScheduleOccurrence, type ScheduleOutcome, type ScheduleOverlap, type TaskIntent } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { TaskStore } from './tasks.js';

/**
 * How many OLDER missed occurrences one reconciliation records as
 * `skipped-catch-up`. This bounds PERSISTED AUDIT HISTORY and nothing else.
 *
 * Which occurrence may still run is decided by `selectCatchUp`, whose traversal
 * is bounded by the catch-up interval rather than by this number, so changing
 * it cannot change what executes, what queues, which occurrence a skip or a
 * disabled reconciliation records, or where `nextFireAt` lands — only how much
 * history a long outage writes. Audit history is therefore deliberately
 * bounded: after a very long outage the oldest misses have no individual row.
 */
const MAX_CATCH_UP_ROWS = 200;

/**
 * Fail-closed traversal slack, in civil candidates, for crossing a timezone
 * discontinuity: enough for a whole skipped civil date at the densest
 * granularity a 5-field cron expresses (Pacific/Apia, 2011-12-30), whose
 * candidates are enumerated and rejected rather than skipped over.
 * Exhausting it is a defect, not an answer — see `canonicalOccurrences`.
 */
const DISCONTINUITY_SLACK = 1536;

/**
 * Bound on any UTC offset IANA defines (±14:00 today, historical local mean
 * times within ±16:00). It brackets where a civil time can possibly map to and
 * how far back the civil walk has to start. It is not DST arithmetic: no
 * transition size, direction or date is assumed anywhere.
 */
const MAX_ZONE_OFFSET_MS = 16 * 60 * 60_000;

/** Grid the zone's offsets are sampled on. Finer than any IANA offset regime. */
const OFFSET_SAMPLE_MS = 30 * 60_000;

/**
 * THE canonical occurrence truth: the UTC instants at which this IANA schedule
 * actually fires, in recurrence order, strictly after `after`.
 *
 * One definition, every consumer. The catch-up winner, the audit tail and
 * `nextFireAt` all read occurrence identity from here and from nowhere else, so
 * a gap or a fold cannot mean one thing to selection and another to
 * advancement.
 *
 * A cron expression names CIVIL times — wall-clock readings — and the zone
 * decides which UTC instants those readings correspond to. So that is the order
 * the traversal works in, and the order is load-bearing:
 *
 *  1. enumerate the civil candidates, by evaluating the pattern in UTC, where
 *     no discontinuity exists and the sequence is therefore complete and
 *     strictly increasing whatever the target zone does;
 *  2. resolve each civil candidate through the zone's own offsets into every
 *     UTC instant whose wall clock reads it — none across a gap, two inside a
 *     fold, one otherwise;
 *  3. take the EARLIEST such instant as the occurrence's one identity;
 *  4. only then filter against `after`.
 *
 * Two properties follow from doing it in that order, and neither holds if a
 * UTC timestamp from the cron library is treated as occurrence truth:
 *
 *  - START-POINT INDEPENDENCE. A civil candidate is resolved before it is
 *    filtered, so beginning the walk before a fold, between its two mappings,
 *    or after the first of them yields the same identity for it. (Asked
 *    directly, the library answers a fold's first mapping in one zone and its
 *    second in another, and can answer with an instant at or before its own
 *    reference; none of that is reachable from here any more.)
 *  - GAP SAFETY. A civil time a gap skipped has no mapping, so it is not an
 *    occurrence. Rejecting it advances the CIVIL cursor only — the next civil
 *    candidate, whose mapping may well be UTC-EARLIER than the shifted instant
 *    the library would have answered with, is still reachable. (Asked directly,
 *    the library answers a nonexistent civil time with a shifted instant, and
 *    dropping that instant after the UTC cursor has moved to it loses the next
 *    legitimate occurrence.)
 *
 * A fold therefore yields exactly ONE identity — the repeated wall-clock
 * reading belongs to its first representation, so the schedule fires promptly
 * and never twice — and identities are strictly increasing: across a fall-back
 * the civil step and the shrinking offset both push the identity forward, and
 * across a spring-forward the civil step always exceeds the offset it gains.
 *
 * `maxSteps` is a fail-closed ceiling on pathological traversal, never a
 * semantic bound: exhausting it throws, and can never mean "no occurrence
 * exists". Callers that need only the first occurrence break out of the loop
 * and never reach it.
 */
export function* canonicalOccurrences(pattern: string, timezone: string, after: Date, maxSteps: number): Generator<Date> {
  // The pattern read as wall-clock fields: UTC evaluation of a civil pattern is
  // the civil sequence, and it is the same sequence from any starting point.
  const civil = new Cron(pattern, { timezone: 'UTC' });
  // Built once per traversal: expensive to construct, and a long catch-up
  // interval asks the same question thousands of times.
  const wallClock = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  /** The zone's offset at a real instant, as (civil reading − instant) in ms. */
  const offsetAt = (instant: number): number => {
    const parts = Object.fromEntries(wallClock.formatToParts(new Date(instant))
      .filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    // Intl renders midnight as hour 24 in some locales/zones.
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!) - instant;
  };
  /**
   * The zone's offsets, sampled on a half-hour grid and memoised. A traversal
   * asks about heavily overlapping instant ranges, so this is what keeps the
   * whole walk at roughly one rendering per occurrence however dense the
   * pattern is. Sampling only proposes offsets to try — every one of them is
   * then confirmed exactly — and the grid is half the shortest offset regime
   * IANA has ever defined, so no regime can fall between two samples.
   */
  const sampled = new Map<number, number>();
  const offsetNear = (bucket: number): number => {
    let offset = sampled.get(bucket);
    if (offset === undefined) { offset = offsetAt(bucket * OFFSET_SAMPLE_MS); sampled.set(bucket, offset); }
    return offset;
  };
  /**
   * The earliest UTC instant whose wall clock in `timezone` reads `wallMs`, or
   * undefined when a gap skipped that civil time.
   *
   * A mapping is an instant `wallMs - offset` whose own offset is that same
   * `offset` — a fixed point, which is what makes this exact for a
   * discontinuity of any size or direction. Every mapping lies within one
   * offset of the civil reading, so every offset the zone uses over that span
   * is tried, and the fixed-point test rejects the rest.
   */
  const earliestMapping = (wallMs: number): number | undefined => {
    let earliest: number | undefined;
    const tried = new Set<number>();
    const last = Math.ceil((wallMs + MAX_ZONE_OFFSET_MS) / OFFSET_SAMPLE_MS);
    for (let bucket = Math.floor((wallMs - MAX_ZONE_OFFSET_MS) / OFFSET_SAMPLE_MS); bucket <= last; bucket++) {
      const offset = offsetNear(bucket);
      if (tried.has(offset)) continue;
      tried.add(offset);
      const instant = wallMs - offset;
      if (offsetAt(instant) === offset && (earliest === undefined || instant < earliest)) earliest = instant;
    }
    return earliest;
  };
  // A civil candidate BEFORE `after`'s own reading can still map to an instant
  // after it, so the walk starts one offset back — the smallest offset the zone
  // actually uses around `after`, not a worst-case one, which is what keeps the
  // walk free of wasted candidates in a zone at or near UTC. A reading earlier
  // than that cannot map into scope under any offset: beyond the sampled span
  // it would take an offset below -32 hours. What IS in scope is decided by the
  // filter below, never by where the walk began.
  let backOff = Infinity;
  const around = Math.ceil(MAX_ZONE_OFFSET_MS / OFFSET_SAMPLE_MS);
  for (let bucket = Math.floor(after.getTime() / OFFSET_SAMPLE_MS) - around; bucket <= Math.ceil(after.getTime() / OFFSET_SAMPLE_MS) + around; bucket++) {
    backOff = Math.min(backOff, offsetNear(bucket));
  }
  let wallCursor = after.getTime() + backOff - 1;
  let emitted = after.getTime();
  for (let step = 0; step < maxSteps; step++) {
    const candidate = civil.nextRun(new Date(wallCursor));
    if (!candidate) return;
    if (candidate.getTime() <= wallCursor) {
      throw new Error(`Cron '${pattern}' made no forward progress past civil ${new Date(wallCursor).toISOString()}`);
    }
    wallCursor = candidate.getTime();
    // Cheap arithmetic before any zone work: a reading this far back cannot map
    // to an instant in scope under ANY offset, which is what makes the walk's
    // offset back-off free for the common case of a zone at or near UTC.
    if (wallCursor + MAX_ZONE_OFFSET_MS <= emitted) continue;
    const occurrence = earliestMapping(wallCursor);
    if (occurrence === undefined) continue;              // a gap skipped this civil time
    if (occurrence <= emitted) continue;                 // before `after`, or already emitted
    emitted = occurrence;
    yield new Date(occurrence);
  }
  throw new Error(`Cron '${pattern}' in ${timezone} exceeded ${maxSteps} candidates after ${after.toISOString()}`);
}

/**
 * The catch-up decision for ONE reconciliation, read off canonical occurrence
 * order: `latest` is the newest real occurrence in `[fromMs, nowMs]`, and
 * `older` is the bounded audit tail behind it, oldest first.
 *
 * These are two separate questions and `auditLimit` answers only the second.
 * Selection walks the whole interval and stops when the INTERVAL is exhausted,
 * never when a row budget is, so the winner is the same for an audit limit of
 * 1, 200 or 1000. Memory stays bounded regardless of interval length: one
 * `latest`, at most `auditLimit` tail entries, and a cursor.
 *
 * Traversal is bounded by the interval itself at one-minute granularity — the
 * densest a 5-field cron expresses — plus the civil walk's offset back-off and
 * discontinuity slack. That bound fails closed: it throws, and never reports
 * "no occurrence exists".
 */
export function selectCatchUp(pattern: string, timezone: string, fromMs: number, nowMs: number, auditLimit: number): { latest: Date | null; older: Date[] } {
  const older: Date[] = [];
  let latest: Date | null = null;
  const ceiling = Math.ceil((Math.max(0, nowMs - fromMs) + MAX_ZONE_OFFSET_MS) / 60_000) + DISCONTINUITY_SLACK;
  // `fromMs - 1`, so an occurrence landing exactly ON the lower bound is in
  // scope and one landing before it can never be.
  for (const occurrence of canonicalOccurrences(pattern, timezone, new Date(fromMs - 1), ceiling)) {
    if (occurrence.getTime() > nowMs) break;
    if (latest) {
      older.push(latest);
      if (older.length > auditLimit) older.shift();
    }
    latest = occurrence;
  }
  return { latest, older };
}

type Row = {
  schedule_id: string; kind: 'user' | 'system'; intent_json: string; cron: string; timezone: string;
  enabled: number; overlap: ScheduleOverlap; catch_up_window_minutes: number;
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
  /**
   * The global `scheduler.enabled` switch. A disabled scheduler performs no
   * automatic promotion, exactly as it performs no automatic firing.
   */
  schedulerEnabled: () => boolean;
  onError?: (error: unknown) => void;
}

/** Placeholders for the terminal task states, for the "is this schedule busy" read. */
const TERMINAL_PLACEHOLDERS = TERMINAL_STATES.map(() => '?').join(',');

/**
 * K5 recurring schedules over the existing scheduler timer. Next-fire is
 * computed in the schedule's IANA zone; firing is one transaction whose
 * `(scheduleId, occurrenceAt)` primary key is the deduplication mechanism.
 */
export class ScheduleService {
  constructor(private d: ScheduleDeps) {}
  private iso(): string { return this.d.now().toISOString(); }

  /** Default stays `skip`, so an existing or unaware caller is unchanged. */
  private overlap(value: ScheduleOverlap | undefined): ScheduleOverlap {
    if (value === undefined) return 'skip';
    if (value !== 'skip' && value !== 'queue') throw new Error("overlap must be 'skip' or 'queue'");
    return value;
  }

  /** Same shape check ordinary task creation trusts: undefined, or a positive integer minimum. */
  private requirements(value: TaskIntent['requirements']): TaskIntent['requirements'] {
    if (value === undefined) return undefined;
    const { minContextTokens } = value;
    if (minContextTokens !== undefined && (!Number.isInteger(minContextTokens) || minContextTokens <= 0)) {
      throw new Error('requirements.minContextTokens must be a positive integer');
    }
    return value;
  }

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

  /** The first canonical occurrence strictly after `after`, or null if none. */
  private nextFireAt(pattern: string, timezone: string, after: Date): string | null {
    const ceiling = MAX_ZONE_OFFSET_MS / 60_000 + DISCONTINUITY_SLACK;
    for (const occurrence of canonicalOccurrences(pattern, timezone, after, ceiling)) return occurrence.toISOString();
    return null;
  }

  private hydrate(r: Row): Schedule {
    return { schemaVersion: 1, scheduleId: r.schedule_id, kind: r.kind, intent: JSON.parse(r.intent_json) as TaskIntent,
      cron: r.cron, timezone: r.timezone, enabled: !!r.enabled, overlap: r.overlap,
      catchUpWindowMinutes: r.catch_up_window_minutes, lastFiredAt: r.last_fired_at ?? undefined,
      nextFireAt: r.next_fire_at ?? undefined, lastTaskId: r.last_task_id ?? undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
      queuedCount: this.queuedCount(r.schedule_id), activeTaskId: this.activeTaskId(r.schedule_id) };
  }

  /* ------------------------------------------------ overlap: queue (K5) --
   * The occurrence row IS the queue. `outcome = 'queued'` is durable queued
   * work; `(schedule_id, occurrence_at)` is still its only identity, so a
   * duplicate tick cannot produce a second entry, a second task or a second
   * promotion. FIFO is `ORDER BY occurrence_at` — unique by primary key, so
   * the order is total and needs no tie-break.
   * ---------------------------------------------------------------------- */

  /**
   * The authority on "does this schedule already have a non-terminal task",
   * for BOTH overlap modes. Durable occurrence/task state, not `last_task_id`:
   * the display field is allowed to be a cache, and a correctness check is not.
   */
  private activeTaskId(scheduleId: string): string | undefined {
    return (this.d.db.prepare(`SELECT o.task_id AS id FROM schedule_occurrences o JOIN tasks t ON t.id = o.task_id
      WHERE o.schedule_id = ? AND t.state NOT IN (${TERMINAL_PLACEHOLDERS}) ORDER BY o.occurrence_at LIMIT 1`)
      .get(scheduleId, ...TERMINAL_STATES) as { id: string } | undefined)?.id;
  }

  private queuedCount(scheduleId: string): number {
    return (this.d.db.prepare("SELECT COUNT(*) AS n FROM schedule_occurrences WHERE schedule_id = ? AND outcome = 'queued'")
      .get(scheduleId) as { n: number }).n;
  }

  /**
   * Persists an occurrence as queued work, with the schedule's intent AS OF NOW
   * snapshotted onto it. A queued occurrence may run long after the schedule is
   * edited, and it must still produce the task its own instant described.
   *
   * Intent only (I-S1): no assistant, provider, model or routing decision is
   * resolved here, so nothing about execution is frozen by the delay.
   */
  private enqueue(row: Row, occurrenceAt: string): void {
    this.d.db.prepare(`INSERT OR IGNORE INTO schedule_occurrences(schedule_id,occurrence_at,fired_at,outcome,queued_at,intent_json)
      VALUES(?,?,?, 'queued', ?, ?)`).run(row.schedule_id, occurrenceAt, this.iso(), this.iso(), row.intent_json);
  }

  /** Schedules with queued work. The bounded fallback sweep's whole work list. */
  private backlogged(): string[] {
    return (this.d.db.prepare("SELECT DISTINCT schedule_id FROM schedule_occurrences WHERE outcome = 'queued'")
      .all() as { schedule_id: string }[]).map(r => r.schedule_id);
  }

  /**
   * Promotes the OLDEST queued occurrence of one schedule, if the schedule has
   * no non-terminal task. One transaction, so a crash cannot leave a task
   * without its occurrence or an occurrence marked promoted without its task.
   *
   * The `AND outcome = 'queued'` on the UPDATE is the compare-and-swap that
   * makes concurrent promoters safe: a cron tick, a terminal event, the sweep
   * and boot recovery all call this, and of any two exactly one changes a row.
   * The loser matches zero rows and promotes nothing.
   *
   * Returns the promoted task id, if any.
   */
  promote(scheduleId: string): string | undefined {
    if (!this.d.schedulerEnabled()) return undefined;
    return this.d.db.transaction((): string | undefined => {
      const row = this.d.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(scheduleId) as Row | undefined;
      // A disabled schedule keeps its backlog durable but promotes none of it.
      if (!row || !row.enabled) return undefined;
      if (this.activeTaskId(scheduleId)) return undefined;
      const front = this.d.db.prepare("SELECT occurrence_at, intent_json FROM schedule_occurrences WHERE schedule_id = ? AND outcome = 'queued' ORDER BY occurrence_at LIMIT 1")
        .get(scheduleId) as { occurrence_at: string; intent_json: string | null } | undefined;
      if (!front) return undefined;
      // FAIL CLOSED: the snapshot, and ONLY the snapshot. A row predating this
      // slice is never 'queued' (the schema CHECK enforces it), so a queued row
      // missing or corrupting its own intent is not legitimate history — it is
      // a defect, and falling back to the CURRENT schedule intent would
      // silently rewrite what already-queued work is claimed to have run.
      // Throwing here rolls back the whole transaction before the row is ever
      // touched, so the occurrence stays 'queued', auditable and un-promoted.
      if (!front.intent_json) throw new Error(`Queued occurrence ${scheduleId}/${front.occurrence_at} has no intent snapshot; refusing to promote it from the current schedule intent`);
      let intent: TaskIntent;
      try { intent = JSON.parse(front.intent_json) as TaskIntent; }
      catch (error) { throw new Error(`Queued occurrence ${scheduleId}/${front.occurrence_at} has a corrupt intent snapshot: ${error instanceof Error ? error.message : String(error)}`); }
      const at = this.iso();
      const taskId = this.createOccurrenceTask(intent, front.occurrence_at);
      // outcome, promoted_at and task_id move together in one statement: the
      // schema CHECK never sees a 'created' row without a task, or a 'queued'
      // row with one. The CAS is still `outcome = 'queued'` in the WHERE.
      const won = this.d.db.prepare("UPDATE schedule_occurrences SET outcome = 'created', promoted_at = ?, task_id = ? WHERE schedule_id = ? AND occurrence_at = ? AND outcome = 'queued'")
        .run(at, taskId, scheduleId, front.occurrence_at).changes;
      // The task is already created inside this same transaction: a lost CAS
      // must throw (rollback), never `return` (commit), or the loser's task
      // would survive orphaned with no occurrence pointing at it.
      if (!won) throw new Error(`Lost the promotion race for ${scheduleId}/${front.occurrence_at}`);
      this.d.db.prepare('UPDATE schedules SET last_fired_at = ?, last_task_id = ?, updated_at = ? WHERE schedule_id = ?')
        .run(front.occurrence_at, taskId, at, scheduleId);
      return taskId;
    })();
  }

  /** Drains every schedule with a backlog. The bounded fallback for a lost event. */
  drain(): void {
    for (const scheduleId of this.backlogged()) {
      try { this.promote(scheduleId); } catch (error) { this.d.onError?.(error); }
    }
  }

  /** The schedule an occurrence task belongs to, for the terminal-event wake. */
  scheduleOf(taskId: string): string | undefined {
    return (this.d.db.prepare('SELECT schedule_id FROM schedule_occurrences WHERE task_id = ?').get(taskId) as { schedule_id: string } | undefined)?.schedule_id;
  }

  /**
   * The one task-creation path an occurrence has, in both modes — immediate and
   * promoted-from-queue alike, so the two can never disagree about what a
   * TaskIntent produces. `repository` is path intent only: the task still gets
   * its own ordinary branch/worktree identity at creation, never a frozen one.
   */
  private createOccurrenceTask(intent: TaskIntent, occurrenceAt: string): string {
    const task = this.d.tasks.create({ goal: intent.goal, constraints: intent.constraints,
      repoPath: intent.repository?.path, profile: intent.profile, overrides: intent.overrides,
      requirements: intent.requirements });
    this.d.park(task.taskId, occurrenceAt, `Scheduled occurrence ${occurrenceAt}`);
    return task.taskId;
  }

  list(): Schedule[] {
    return (this.d.db.prepare('SELECT * FROM schedules ORDER BY created_at, schedule_id').all() as Row[]).map(r => this.hydrate(r));
  }
  get(scheduleId: string): Schedule | undefined {
    const r = this.d.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(scheduleId) as Row | undefined;
    return r ? this.hydrate(r) : undefined;
  }
  occurrences(scheduleId: string, limit = 50): ScheduleOccurrence[] {
    // Queue order is the plane's to decide, so the rank ships with the row
    // rather than being re-derived from a truncated page in a browser.
    const queued = (this.d.db.prepare("SELECT occurrence_at FROM schedule_occurrences WHERE schedule_id = ? AND outcome = 'queued' ORDER BY occurrence_at")
      .all(scheduleId) as { occurrence_at: string }[]).map(r => r.occurrence_at);
    return (this.d.db.prepare('SELECT * FROM schedule_occurrences WHERE schedule_id = ? ORDER BY occurrence_at DESC LIMIT ?')
      .all(scheduleId, limit) as Array<{ schedule_id: string; occurrence_at: string; fired_at: string; outcome: ScheduleOutcome; task_id: string | null; queued_at: string | null; promoted_at: string | null }>)
      .map(r => ({ scheduleId: r.schedule_id, occurrenceAt: r.occurrence_at, firedAt: r.fired_at, outcome: r.outcome,
        taskId: r.task_id ?? undefined, queuedAt: r.queued_at ?? undefined, promotedAt: r.promoted_at ?? undefined,
        queuePosition: r.outcome === 'queued' ? queued.indexOf(r.occurrence_at) + 1 : undefined }));
  }
  /**
   * The FIFO backlog itself, oldest first, capped but never truncated from the
   * front. `occurrences()` pages the RECENT history newest-first, so once a
   * backlog outgrows that page the queue head (next to promote) is exactly the
   * row a recency page pushes out first. This is the operator's independent
   * view of "what actually runs next", not a re-derivation of a truncated page.
   */
  queuedOccurrences(scheduleId: string, limit = 50): ScheduleOccurrence[] {
    return (this.d.db.prepare("SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND outcome = 'queued' ORDER BY occurrence_at LIMIT ?")
      .all(scheduleId, limit) as Array<{ schedule_id: string; occurrence_at: string; fired_at: string; queued_at: string | null }>)
      .map((r, i) => ({ scheduleId: r.schedule_id, occurrenceAt: r.occurrence_at, firedAt: r.fired_at, outcome: 'queued' as const,
        queuedAt: r.queued_at ?? undefined, queuePosition: i + 1 }));
  }

  create(input: ScheduleInput): Schedule {
    input = redactValue(input);
    if (typeof input?.goal !== 'string' || !input.goal.trim()) throw new Error('A schedule requires a goal');
    if (typeof input.cron !== 'string' || typeof input.timezone !== 'string') throw new Error('A schedule requires cron and timezone');
    if (input.catchUpWindowMinutes !== undefined && (!Number.isInteger(input.catchUpWindowMinutes) || input.catchUpWindowMinutes < 0)) throw new Error('catchUpWindowMinutes must be a non-negative integer');
    const overlap = this.overlap(input.overlap);
    this.cron(input.cron, input.timezone);
    const scheduleId = `sched_${randomUUID()}`;
    const now = this.iso();
    const intent: TaskIntent = { goal: input.goal, constraints: input.constraints ?? [],
      repository: input.repoPath ? { path: input.repoPath } : undefined,
      profile: input.profile ?? 'auto', overrides: input.overrides, requirements: this.requirements(input.requirements) };
    this.d.db.prepare(`INSERT INTO schedules(schedule_id,kind,intent_json,cron,timezone,enabled,overlap,catch_up_window_minutes,next_fire_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(scheduleId, input.kind ?? 'user', JSON.stringify(intent), input.cron, input.timezone,
      input.enabled === false ? 0 : 1, overlap, input.catchUpWindowMinutes ?? 1440, this.nextFireAt(input.cron, input.timezone, this.d.now()), now, now);
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
      requirements: patch.requirements !== undefined ? this.requirements(patch.requirements) : current.intent.requirements,
    };
    // Edits reach FUTURE occurrences only. An already-queued occurrence keeps
    // its own intent snapshot and its own occurrenceAt, so neither the work it
    // will do nor its FIFO position can be rewritten from here.
    this.d.db.prepare(`UPDATE schedules SET intent_json = ?, cron = ?, timezone = ?, enabled = ?, overlap = ?, catch_up_window_minutes = ?, next_fire_at = ?, updated_at = ? WHERE schedule_id = ?`)
      .run(JSON.stringify(intent), cron, timezone, (patch.enabled ?? current.enabled) ? 1 : 0,
        patch.overlap === undefined ? current.overlap : this.overlap(patch.overlap),
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
   * This schedule's catch-up decision, over the reconciliation interval
   * `[max(storedNextFireAt, now - catchUpWindow), now]`.
   *
   * The lower bound is inclusive and the upper bound is `now`: an occurrence
   * before the bound can never execute, and one landing exactly on it can.
   * Everything else — which occurrence wins, how a gap or a fold resolves — is
   * `selectCatchUp`'s, so it is the same answer whatever `MAX_CATCH_UP_ROWS` is.
   */
  private missed(row: Row, nowMs: number): { latest: Date | null; older: Date[] } {
    const windowStart = nowMs - row.catch_up_window_minutes * 60_000;
    const from = Math.max(Date.parse(row.next_fire_at!), windowStart);
    return selectCatchUp(row.cron, row.timezone, from, nowMs, MAX_CATCH_UP_ROWS);
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
    const { latest, older } = this.missed(row, nowMs);
    if (!latest) { this.resync(row, new Date(nowMs), nowMs); return; }
    this.d.db.transaction(() => {
      // Re-read inside the transaction: a concurrent edit or fire wins.
      const current = this.d.db.prepare('SELECT * FROM schedules WHERE schedule_id = ?').get(row.schedule_id) as Row | undefined;
      if (!current || !current.enabled || current.next_fire_at !== row.next_fire_at) return;
      if (mode === 'disabled') {
        this.occurrence(row.schedule_id, latest.toISOString(), 'skipped-disabled');
      } else {
        for (const skipped of older) this.occurrence(row.schedule_id, skipped.toISOString(), 'skipped-catch-up');
        this.fire(current, latest);
      }
      // Strictly past the whole downtime interval: `latest` is the newest real
      // occurrence at or before now, so the next one after it is after now too.
      this.resync(current, latest, nowMs);
    })();
  }

  /** One occurrence: overlap check, task creation, occurrence row, next fire. */
  private fire(row: Row, occurrence: Date): void {
    const occurrenceAt = occurrence.toISOString();
    if (this.d.db.prepare('SELECT 1 FROM schedule_occurrences WHERE schedule_id = ? AND occurrence_at = ?').get(row.schedule_id, occurrenceAt)) return;
    // One question, one answer, both modes: is a task of this schedule still
    // running? Answered from durable occurrence/task state (`last_task_id` is
    // a display field), so the two modes can never disagree about overlap.
    const busy = !!this.activeTaskId(row.schedule_id);
    // Durable queued work outranks every later occurrence, in BOTH modes. An
    // existing backlog is already-accepted work, and `overlap` is future policy
    // about the NEW occurrence: it decides whether that occurrence queues up
    // behind the backlog or is skipped, never whether it may run ahead of it.
    // Editing `queue` -> `skip` therefore cannot let a newer occurrence overtake
    // an older queued one, and it rewrites no queued row to achieve that.
    const blocked = busy || this.queuedCount(row.schedule_id) > 0;
    if (blocked) {
      if (row.overlap === 'queue') this.enqueue(row, occurrenceAt);
      else this.occurrence(row.schedule_id, occurrenceAt, 'skipped-overlap');
      return;
    }
    const taskId = this.createOccurrenceTask(JSON.parse(row.intent_json) as TaskIntent, occurrenceAt);
    this.occurrence(row.schedule_id, occurrenceAt, 'created', taskId);
    this.d.db.prepare('UPDATE schedules SET last_fired_at = ?, last_task_id = ?, updated_at = ? WHERE schedule_id = ?')
      .run(occurrenceAt, taskId, this.iso(), row.schedule_id);
  }

  /**
   * Moves `nextFireAt` past `after` and ENFORCES that it lands in the future.
   *
   * A postcondition, not an assumption. A reconciliation that stored a
   * `nextFireAt` at or before now would rediscover the same downtime interval
   * on the very next tick and turn one miss into an occurrence per tick; the
   * fold reproduction proves the recurrence library alone does not rule that
   * out. Failing loudly here keeps an overdue schedule from being stored
   * silently — the caller's error path surfaces it.
   */
  private resync(row: Row, after: Date, nowMs: number): void {
    const next = this.nextFireAt(row.cron, row.timezone, after);
    if (next !== null && Date.parse(next) <= nowMs) {
      throw new Error(`Reconciling ${row.schedule_id} produced a nextFireAt of ${next}, which is not after ${new Date(nowMs).toISOString()}`);
    }
    this.d.db.prepare('UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE schedule_id = ?')
      .run(next, this.iso(), row.schedule_id);
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
