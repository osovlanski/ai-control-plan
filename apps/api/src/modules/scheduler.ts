import { HandoffService } from './harness/handoff.js';
import { randomUUID } from 'node:crypto';
import { canTransition, isTerminal, redactValue, type Dispatch, type DispatchOrigin, type TaskState, type OnDependencyFailure, type ResourcePool, type RoutingExplanation, type SchedulerEvent, type WaitInput, type WaitCondition } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { ResolvedConfig } from '../config.js';
import type { TaskStore } from './tasks.js';
import type { Orchestrator } from './orchestrator.js';
import type { QuotaProbeService } from './quota-probe.js';
import { ScheduleService } from './schedules.js';
import type { TaskEventBus } from './sse.js';

const RECHECK_MS = 60_000;
const RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTO_WAKES = 3;
/** A failed dependency is not the scheduler's decision to make on its own. */
const DEFAULT_ON_DEPENDENCY_FAILURE: OnDependencyFailure = 'wait-input';

type Actor = 'timer' | 'event' | 'operator';
type WakeResult = { outcome: 'stale'; reason: string } | { outcome: 'dispatched'; dispatchId: string };
export interface SchedulerDeps {
  db: Db; tasks: TaskStore; orchestrator: Orchestrator; bus: TaskEventBus; config: ResolvedConfig;
  /** Optional idle quota probes (K3). Absent or disabled: quota waits use run-stream evidence alone. */
  probes?: QuotaProbeService;
  now?: () => Date;
  /** Deterministic fault injection at committed crash boundaries. */
  boundary?: (phase: 'reserved' | 'routed' | 'materialized' | 'start_attempted' | 'session_created', dispatch: Dispatch) => Promise<void>;
  onError?: (error: unknown) => void;
}

/** One process, one SQLite owner, one re-armed timer. No provider execution exactly-once claim. */
export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastTick: string | null = null;
  private readonly now: () => Date;
  private inFlight = new Map<string, Promise<void>>();
  /** K5 recurring schedules. Shares this scheduler's timer; no second loop. */
  readonly schedules: ScheduleService;
  constructor(private d: SchedulerDeps) {
    this.now = d.now ?? (() => new Date());
    d.orchestrator.scheduler = this;
    d.tasks.onTerminal = taskId => this.taskTerminal(taskId);
    this.schedules = new ScheduleService({
      db: d.db, tasks: d.tasks, now: this.now, onError: d.onError,
      // An occurrence is parked on a due time wait, so the existing K1 wake
      // protocol dispatches it. K5 adds no execution path of its own.
      park: (taskId, occurrenceAt, reason) => this.attach(taskId, { kind: 'time', notBefore: occurrenceAt, reason }),
    });
  }
  get enabled(): boolean { return this.d.config.scheduler?.enabled !== false; }
  private iso(): string { return this.now().toISOString(); }
  status() {
    const due = this.d.db.prepare("SELECT COUNT(*) AS count FROM wait_conditions WHERE state = 'active' AND not_before <= ?").get(this.iso()) as { count: number };
    const open = this.d.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE phase IN ('reserved','start_attempted')").get() as { count: number };
    const schedules = this.d.db.prepare('SELECT COUNT(*) AS count FROM schedules WHERE enabled = 1').get() as { count: number };
    return { enabled: this.enabled, armed: !this.stopped && this.enabled && this.timer !== undefined, dueConditions: due.count, openDispatches: open.count, lastTick: this.lastTick,
      enabledSchedules: schedules.count, nextScheduleFireAt: this.schedules.nextDeadline(),
      probesEnabled: this.d.probes?.enabled ?? false, probes: this.d.probes?.status() ?? [],
      resources: this.pools() };
  }

  /* ------------------------------------------------------------------ K4b --
   * Resource slots. Capacity is config; occupancy is the live claim sum. Both
   * are read fresh inside the wake transaction, so nothing about a pool is ever
   * cached or projected forward — an "available" number is only ever as of now.
   * ---------------------------------------------------------------------- */

  private capacity(resource: string): number | undefined { return this.d.config.scheduler?.resources?.[resource]; }

  /** Live claimed units for a pool. Inside a wake transaction this is the authority. */
  private claimed(resource: string): number {
    return ((this.d.db.prepare('SELECT COALESCE(SUM(units),0) AS units FROM resource_claims WHERE resource = ? AND released_at IS NULL')
      .get(resource) as { units: number }).units);
  }

  /**
   * FIFO order a release wakes in: oldest active wait first, stable id tie-break.
   *
   * Only conditions whose OTHER preconditions are already satisfied compete — a
   * quota wait that also needs a slot but is not yet retryable is not in the queue,
   * so it cannot hold the pool's head of line against tasks that are ready. It
   * re-enters at its original creation time, so waiting longer never loses a place.
   */
  private queue(resource: string): { task_id: string; generation: number; resource_units: number }[] {
    return this.d.db.prepare(`SELECT task_id, generation, resource_units FROM wait_conditions
      WHERE state = 'active' AND resource = ? AND not_before <= ? ORDER BY created_at, task_id`)
      .all(resource, this.iso()) as { task_id: string; generation: number; resource_units: number }[];
  }

  /** Every pool an operator can see: declared pools plus any pool with live claims or waiters. */
  pools(): ResourcePool[] {
    const names = new Set<string>(Object.keys(this.d.config.scheduler?.resources ?? {}));
    for (const r of this.d.db.prepare("SELECT DISTINCT resource FROM resource_claims WHERE released_at IS NULL").all() as { resource: string }[]) names.add(r.resource);
    for (const r of this.d.db.prepare("SELECT DISTINCT resource FROM wait_conditions WHERE state = 'active' AND resource IS NOT NULL").all() as { resource: string }[]) names.add(r.resource);
    return [...names].sort().map(resource => {
      const capacity = this.capacity(resource);
      const claimedUnits = this.claimed(resource);
      return { resource, capacity, claimedUnits,
        availableUnits: Math.max(0, (capacity ?? 0) - claimedUnits),
        waitingTaskIds: this.queue(resource).map(r => r.task_id) };
    });
  }

  /**
   * Why this task is not running, as of now. Derived, never stored: a persisted
   * occupancy number goes stale the moment another task claims, and a stale slot
   * count is worse than no slot count.
   */
  resourceWaitStatus(taskId: string): { resource: string; units: number; capacity?: number; claimedUnits: number; availableUnits: number; queuePosition: number; queueLength: number; blockedBy: 'capacity' | 'queue' | 'undeclared' | 'unsatisfiable' | 'eligible' } | undefined {
    const c = this.condition(taskId);
    if (!c || c.state !== 'active' || !c.resource) return undefined;
    const units = c.units ?? 1;
    const capacity = this.capacity(c.resource);
    const claimedUnits = this.claimed(c.resource);
    const availableUnits = Math.max(0, (capacity ?? 0) - claimedUnits);
    const q = this.queue(c.resource);
    const queuePosition = q.findIndex(r => r.task_id === taskId) + 1;
    const blockedBy = capacity === undefined ? 'undeclared'
      : units > capacity ? 'unsatisfiable'
      : queuePosition > 1 ? 'queue'
      : availableUnits < units ? 'capacity' : 'eligible';
    return { resource: c.resource, units, capacity, claimedUnits, availableUnits, queuePosition, queueLength: q.length, blockedBy };
  }

  /** Live claim for a task, if it holds one. */
  claim(taskId: string): { claim_id: number; resource: string; units: number; dispatch_id: string; claimed_at: string } | undefined {
    return this.d.db.prepare('SELECT claim_id, resource, units, dispatch_id, claimed_at FROM resource_claims WHERE task_id = ? AND released_at IS NULL')
      .get(taskId) as { claim_id: number; resource: string; units: number; dispatch_id: string; claimed_at: string } | undefined;
  }

  /**
   * Releases the live claim once the task no longer needs the slot, and wakes the
   * next FIFO waiter. A terminal task never runs again, so its claim goes
   * regardless of how its run row settled; otherwise the existing `hasOwner`
   * ownership test is the single authority — the same one `WAITING_RESOURCE`
   * itself is defined by. That makes leaks impossible to express rather than
   * merely unlikely: every park, abort, cancel, settle and boot path already ends
   * with no owner, and the timer sweep re-checks anything that missed its event.
   */
  releaseIfIdle(taskId: string, reason: string): void {
    const released = this.d.db.transaction((): { resource: string } | undefined => {
      const held = this.claim(taskId);
      if (!held) return undefined;
      const row = this.d.tasks.get(taskId);
      if (row && !isTerminal(row.state) && this.hasOwner(taskId)) return undefined;
      this.d.db.prepare('UPDATE resource_claims SET released_at = ?, release_reason = ? WHERE claim_id = ? AND released_at IS NULL')
        .run(this.iso(), reason, held.claim_id);
      this.record(taskId, 'resource.released', undefined, held.dispatch_id, { resource: held.resource, units: held.units, reason });
      return { resource: held.resource };
    })();
    if (released) { this.publish(taskId); this.notifyResource(released.resource); }
  }

  /**
   * Release on a microtask. Several callers (settle paths, `runNow`'s ambiguity
   * re-arm) run inside a transaction, and a release must neither nest inside that
   * transaction nor be able to fail the caller it is a consequence of.
   */
  private releaseSoon(taskId: string, reason: string): void {
    queueMicrotask(() => { try { this.releaseIfIdle(taskId, reason); } catch (error) { this.d.onError?.(error); } });
  }

  /** Sweeps every live claim. The bounded fallback for a release event we never got. */
  private releaseIdleClaims(): void {
    for (const r of this.d.db.prepare('SELECT task_id FROM resource_claims WHERE released_at IS NULL').all() as { task_id: string }[]) {
      try { this.releaseIfIdle(r.task_id, 'sweep: no execution owner'); } catch (error) { this.d.onError?.(error); }
    }
  }

  /**
   * Whether this wait may take its units right now. Read inside the wake
   * transaction so the answer and the claim commit together.
   *
   * An operator run-now may skip the QUEUE (picking which task runs is an operator
   * decision) but never the CAPACITY: over-allocating is not a thing an operator
   * can ask for, because the slot count would stop being true.
   */
  private resourceGate(c: WaitCondition, actor: Actor): { outcome: 'grant' } | { outcome: 'wait' | 'unsatisfiable'; reason: string } {
    const resource = c.resource!;
    const units = c.units ?? 1;
    const capacity = this.capacity(resource);
    if (capacity === undefined) return { outcome: 'unsatisfiable', reason: `Resource pool ${resource} is no longer declared` };
    if (units > capacity) return { outcome: 'unsatisfiable', reason: `Resource pool ${resource} capacity ${capacity} is below the ${units} units requested` };
    const front = this.queue(resource)[0];
    if (actor !== 'operator' && front && front.task_id !== c.taskId) {
      return { outcome: 'wait', reason: `Resource ${resource}: task ${front.task_id} is ahead in the wait queue` };
    }
    const claimedUnits = this.claimed(resource);
    if (capacity - claimedUnits < units) {
      return { outcome: 'wait', reason: `Resource ${resource}: ${capacity - claimedUnits} of ${capacity} units free, ${units} needed` };
    }
    return { outcome: 'grant' };
  }

  /**
   * A pool changed: wake the FIFO front waiter if the pool can now satisfy it.
   * Strict FIFO — a smaller request behind the front waiter does not jump it, so
   * a large request cannot starve. The timer sweep covers a missed notify.
   */
  private notifyResource(resource: string): void {
    if (!this.enabled) return;
    const front = this.queue(resource)[0];
    if (!front) return;
    queueMicrotask(() => { void this.wake(front.task_id, front.generation, 'event').catch(error => this.d.onError?.(error)); });
  }

  validate(input: WaitInput): WaitInput {
    if (!input || !['time','quota','dependency','resource'].includes(input.kind)) throw new Error('A wait requires kind time, quota, dependency or resource');
    // Dependency and resource wakes are event-driven, so notBefore is an optional earliest re-check.
    const notBefore = input.kind === 'dependency' || input.kind === 'resource' ? (input.notBefore ?? this.iso()) : input.notBefore;
    if (typeof notBefore !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(notBefore) || !Number.isFinite(Date.parse(notBefore))) {
      throw new Error('A wait requires an ISO timestamp including timezone');
    }
    if (input.kind === 'quota' && input.assistants !== undefined && (!Array.isArray(input.assistants) || input.assistants.some(id => typeof id !== 'string' || !this.d.config.assistants[id]))) throw new Error('Quota subjects must name configured assistants');
    if (input.kind === 'dependency') {
      if (!Array.isArray(input.dependsOn) || !input.dependsOn.length || input.dependsOn.some(id => typeof id !== 'string' || !id)) throw new Error('A dependency wait requires at least one dependency task id');
      if (input.onDependencyFailure !== undefined && !['cancel','wake-anyway','wait-input'].includes(input.onDependencyFailure)) throw new Error('onDependencyFailure must be cancel, wake-anyway or wait-input');
    }
    if (input.kind === 'resource') {
      // Fail closed on both halves: an undeclared pool has no honest capacity, and
      // a request larger than capacity could never be granted, so it is a config
      // error at attach rather than a task that waits forever.
      if (typeof input.resource !== 'string' || !input.resource) throw new Error('A resource wait requires a resource pool name');
      const capacity = this.capacity(input.resource);
      if (capacity === undefined) throw new Error(`Unknown resource pool ${input.resource}; declare it in scheduler.resources`);
      if (input.units !== undefined && (!Number.isInteger(input.units) || input.units < 1)) throw new Error('resource units must be a positive integer');
      const units = input.units ?? 1;
      if (units > capacity) throw new Error(`Resource pool ${input.resource} has capacity ${capacity}; ${units} units can never be granted`);
    }
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new Error('reason must be a string');
    const fallback = input.kind === 'dependency' ? 'Waiting on dependencies'
      : input.kind === 'resource' ? `Waiting for ${input.units ?? 1} unit(s) of ${input.resource}`
      : 'Scheduled time wait';
    return { ...input, notBefore: new Date(notBefore).toISOString(), reason: input.reason ?? fallback };
  }

  condition(taskId: string): WaitCondition | undefined {
    const r = this.d.db.prepare('SELECT * FROM wait_conditions WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
    return r ? { schemaVersion: 1, taskId, generation: r.generation as number, state: r.state as WaitCondition['state'], kind: r.kind as WaitCondition['kind'], checkpointId: (r.checkpoint_id ?? undefined) as string | undefined, origin: (r.origin ?? undefined) as WaitCondition['origin'], blockers: JSON.parse(r.blockers as string), assistants: JSON.parse(r.assistants as string),
      dependsOn: JSON.parse(r.depends_on as string) as string[], onDependencyFailure: (r.on_dependency_failure ?? undefined) as OnDependencyFailure | undefined,
      resource: (r.resource ?? undefined) as string | undefined, units: (r.resource_units ?? undefined) as number | undefined,
      notBefore: r.not_before as string, createdBy: r.created_by as string, createdAt: r.created_at as string,
      autoWakes: r.auto_wakes as number, history: JSON.parse(r.history as string) as WaitCondition['history'],
      consumedAt: (r.consumed_at ?? undefined) as string | undefined, consumedBy: (r.consumed_by ?? undefined) as string | undefined, reason: r.reason as string } : undefined;
  }
  dispatch(id: string): Dispatch { return this.d.db.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(id) as Dispatch; }
  dispatches(taskId: string): Dispatch[] { return this.d.db.prepare('SELECT * FROM dispatches WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Dispatch[]; }
  events(taskId: string): SchedulerEvent[] {
    return (this.d.db.prepare('SELECT * FROM scheduler_events WHERE task_id = ? ORDER BY id').all(taskId) as Array<Record<string, unknown>>).map(r => ({
      id: r.id as number, taskId, generation: r.generation as number, dispatchId: r.dispatch_id as string,
      type: r.type as SchedulerEvent['type'], at: r.at as string, payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    }));
  }
  private record(taskId: string, type: SchedulerEvent['type'], generation?: number, dispatchId?: string, payload: Record<string, unknown> = {}): void {
    this.d.db.prepare('INSERT INTO scheduler_events(task_id,generation,dispatch_id,type,at,payload) VALUES(?,?,?,?,?,?)')
      .run(taskId, generation ?? null, dispatchId ?? null, type, this.iso(), JSON.stringify(redactValue(payload)));
  }
  publish(taskId: string): void {
    if (this.d.db.inTransaction) return;
    this.d.bus.publish(taskId, { kind: 'state', state: { state: this.d.tasks.get(taskId)!.state, wait: this.condition(taskId), schedulerEnabled: this.enabled } });
    const event = this.events(taskId).at(-1);
    if (event) this.d.bus.publish(taskId, { kind: 'scheduler', scheduler: event });
  }
  private hasOwner(taskId: string): boolean {
    return !!this.d.db.prepare(`SELECT 1 FROM runs r WHERE task_id = ? AND (ended_at IS NULL OR
      (execution_request_id IS NOT NULL AND (session_state NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED') OR
       NOT EXISTS (SELECT 1 FROM execution_results er WHERE er.session_id = r.id))))`).get(taskId) ||
      !!this.d.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId);
  }
  private insert(taskId: string, input: WaitInput, actor: string, autoWakes = 0, history: WaitCondition['history'] = [], checkpointId?: string, blockers: WaitCondition['blockers'] = [], origin?: DispatchOrigin,
    /** A resource requirement carried forward from the condition being replaced. */
    carry?: { resource?: string; units?: number }): void {
    const generation = (this.condition(taskId)?.generation ?? 0) + 1;
    this.d.db.prepare(`INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,reason,checkpoint_id,blockers,assistants,depends_on,on_dependency_failure,origin,resource,resource_units)
      VALUES(?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, generation, input.kind, input.notBefore!, actor, this.iso(), autoWakes, JSON.stringify(history.slice(-10)), redactValue(input.reason ?? 'Scheduled wait'), checkpointId ?? null, JSON.stringify(redactValue(blockers)), JSON.stringify(redactValue(input.kind === 'quota' ? input.assistants ?? [] : [])),
      JSON.stringify(input.kind === 'dependency' ? input.dependsOn : []), input.kind === 'dependency' ? (input.onDependencyFailure ?? DEFAULT_ON_DEPENDENCY_FAILURE) : null, origin ?? null,
      input.kind === 'resource' ? input.resource : carry?.resource ?? null,
      input.kind === 'resource' ? (input.units ?? 1) : carry?.resource ? carry.units ?? 1 : null);
  }
  attach(taskId: string, input: WaitInput): WaitCondition {
    input = this.validate(input);
    this.d.db.transaction(() => {
      const row = this.d.tasks.get(taskId);
      if (!row || row.mode !== 'single' || !['CREATED','WAITING_RESOURCE','WAITING_INPUT','LIMIT_PAUSED'].includes(row.state)) throw new Error('Only single tasks in a wait-eligible state may be deferred');
      if (this.hasOwner(taskId)) throw new Error('Existing execution prevents a new time wait');
      if (input.kind === 'dependency') this.assertAcyclic(taskId, input.dependsOn);
      const old = this.condition(taskId);
      if (row.state === 'WAITING_RESOURCE' && old?.state !== 'active') throw new Error('No active condition to replace');
      this.d.db.prepare("UPDATE wait_conditions SET state = 'replaced' WHERE task_id = ? AND state = 'active'").run(taskId);
      if (row.state === 'WAITING_INPUT' && !['limit','provider_unavailable','no_candidate','harness_error'].includes(row.pause_kind ?? '')) throw new Error('Pause requires an operator decision');
      const cp = this.d.db.prepare('SELECT id FROM checkpoints WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(taskId) as { id: string } | undefined;
      if (this.d.db.prepare('SELECT 1 FROM runs WHERE task_id = ?').get(taskId) && !cp) throw new Error('Continuation requires a checkpoint');
      this.insert(taskId, input, old ? 'operator' : 'user', old?.autoWakes, old?.history, old?.checkpointId ?? cp?.id,
        input.kind === 'quota' ? this.d.orchestrator.quotaPlan(taskId).blockers : [], undefined,
        // Replacing a wait is not a way to drop a pool requirement the task still has.
        { resource: old?.resource, units: old?.units });
      if (row.state !== 'WAITING_RESOURCE') this.d.tasks.transition(taskId, 'WAITING_RESOURCE');
      this.record(taskId, old ? 'wait.replaced' : 'wait.attached', this.condition(taskId)!.generation);
    })();
    this.publish(taskId); this.arm();
    return this.condition(taskId)!;
  }

  parkQuota(taskId: string, checkpointId: string): boolean {
    const plan = this.d.orchestrator.quotaPlan(taskId);
    if (!plan.notBefore) return false;
    const parked = this.d.db.transaction(() => {
      if (this.hasOwner(taskId) || !['LIMIT_PAUSED','WAITING_INPUT'].includes(this.d.tasks.get(taskId)?.state ?? '')) return false;
      const old = this.condition(taskId);
      const count = (old?.autoWakes ?? 0) + (old?.state === 'consumed' ? 1 : 0);
      const history = [...(old?.history ?? []), { at: this.iso(), actor: 'failover', outcome: 'reparked', reason: 'quota blocked' }].slice(-10);
      if (count >= (this.d.config.scheduler?.maxAutoWakes ?? DEFAULT_MAX_AUTO_WAKES)) {
        this.d.tasks.transition(taskId, 'WAITING_INPUT', 'limit');
        if (old) this.d.db.prepare("UPDATE wait_conditions SET state = 'expired', auto_wakes = ?, history = ? WHERE task_id = ? AND generation = ?").run(count, JSON.stringify(history), taskId, old.generation);
        return true;
      }
      this.insert(taskId, { kind: 'quota', notBefore: plan.notBefore!, reason: 'Quota retry; revalidation required' }, 'failover', count, history, checkpointId, plan.blockers, undefined,
        { resource: old?.resource, units: old?.units });
      this.d.tasks.transition(taskId, 'WAITING_RESOURCE');
      this.record(taskId, 'wait.attached', this.condition(taskId)!.generation, undefined, { blockers: plan.blockers });
      return true;
    })();
    if (parked) { this.publish(taskId); this.arm(); this.releaseSoon(taskId, 'parked on quota'); }
    return parked;
  }

  /**
   * K11: a settled `YIELDED(context)` parks the task on an immediately-due wait
   * anchored to the yield checkpoint, so the ORDINARY K1 dispatch path owns the
   * successor — same reservation, same routing entry point, same crash
   * boundaries, same `uq_dispatch_open` / `uq_live_successor` guarantees. No
   * second continuation queue exists.
   *
   * The predecessor is already terminal with its result persisted by the time
   * the orchestrator calls this, and `hasOwner` re-checks it inside the
   * transaction: there is never a live predecessor and a live successor.
   */
  parkContextContinuation(taskId: string, checkpointId: string, reason: string): boolean {
    const parked = this.d.db.transaction(() => {
      if (!this.enabled || this.hasOwner(taskId)) return false;
      const row = this.d.tasks.get(taskId);
      // A cancellation or another settler may have moved the task since the
      // yield; parking is never worth forcing an illegal transition for.
      if (!row || row.mode !== 'single' || !canTransition(row.state as TaskState, 'WAITING_RESOURCE', row.pause_kind ?? undefined)) return false;
      this.d.db.prepare("UPDATE wait_conditions SET state = 'replaced' WHERE task_id = ? AND state = 'active'").run(taskId);
      const old = this.condition(taskId);
      this.insert(taskId, { kind: 'time', notBefore: this.iso(), reason }, 'context-yield', 0, [], checkpointId, [], 'context-yield',
        { resource: old?.resource, units: old?.units });
      this.d.tasks.transition(taskId, 'WAITING_RESOURCE');
      this.record(taskId, 'wait.attached', this.condition(taskId)!.generation, undefined, { origin: 'context-yield', checkpointId, reason });
      return true;
    })();
    if (parked) { this.publish(taskId); this.arm(); this.releaseSoon(taskId, 'parked on context yield'); }
    return parked;
  }

  /**
   * Terminal status of a dependency wait's subjects. A dependency task that no
   * longer exists is FAILED (CR-23): a deleted subject can never complete.
   */
  private dependencyStatus(dependsOn: string[]): { pending: string[]; failed: string[] } {
    const pending: string[] = []; const failed: string[] = [];
    for (const id of dependsOn) {
      const row = this.d.tasks.get(id);
      if (!row) failed.push(id);
      else if (!isTerminal(row.state)) pending.push(id);
      else if (row.state !== 'COMPLETED') failed.push(id);
    }
    return { pending, failed };
  }

  /**
   * Self-dependency and cycle rejection at attach time. The graph is the active
   * dependency conditions of non-terminal tasks; a terminal task can never close
   * a cycle because its wait can no longer be woken.
   */
  private assertAcyclic(taskId: string, dependsOn: string[]): void {
    if (dependsOn.includes(taskId)) throw new Error('A task cannot depend on itself');
    const seen = new Set<string>([taskId]);
    const stack = [...dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === taskId) throw new Error(`Dependency cycle: ${taskId} is reachable from its own dependencies`);
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.d.tasks.get(id);
      if (!row || isTerminal(row.state)) continue;
      const c = this.condition(id);
      if (c?.state === 'active' && c.kind === 'dependency') stack.push(...(c.dependsOn ?? []));
    }
  }

  /**
   * Event-driven half of K4: a task reaching a terminal state wakes every active
   * dependency wait naming it. Called from `TaskStore.transition`, possibly
   * inside a transaction, so the wakes are deferred to a microtask — which runs
   * only after the (synchronous) enclosing transaction has committed.
   */
  private taskTerminal(taskId: string): void {
    // A terminal task can never run again, so its slot goes back even with the
    // scheduler disabled; only the wake that follows is gated on `enabled`. The
    // transition may be inside a transaction, so both halves run on a microtask,
    // which fires only after the (synchronous) enclosing transaction committed.
    this.releaseSoon(taskId, 'task terminal');
    if (!this.enabled) return;
    const waiters = (this.d.db.prepare("SELECT task_id, generation, depends_on FROM wait_conditions WHERE kind = 'dependency' AND state = 'active'")
      .all() as { task_id: string; generation: number; depends_on: string }[])
      .filter(r => (JSON.parse(r.depends_on) as string[]).includes(taskId));
    if (!waiters.length) return;
    queueMicrotask(() => {
      for (const w of waiters) void this.wake(w.task_id, w.generation, 'event').catch(error => this.d.onError?.(error));
    });
  }

  async wake(taskId: string, expectedGeneration: number, actor: Actor): Promise<WakeResult> {
    await this.revalidateQuota(taskId, expectedGeneration);
    // A stale wake that nevertheless MOVED the task (a failed dependency, an
    // unsatisfiable resource request) still owes the board an update.
    let stateChanged = false;
    /** Set when this wake granted a claim, so the pool is re-evaluated after commit. */
    let claimedResource: string | undefined;
    const result = this.d.db.transaction((): WakeResult => {
      const c = this.condition(taskId);
      if (!c || c.state !== 'active' || c.generation !== expectedGeneration || this.d.tasks.get(taskId)?.state !== 'WAITING_RESOURCE' || this.hasOwner(taskId)) {
        return { outcome: 'stale', reason: 'Condition generation or task ownership changed' };
      }
      if (actor !== 'operator' && Date.parse(c.notBefore) > this.now().getTime()) return { outcome: 'stale', reason: 'Condition is not due' };
      if (c.kind === 'dependency' && actor !== 'operator') {
        const { pending, failed } = this.dependencyStatus(c.dependsOn ?? []);
        // Every required dependency must be terminal before any of them decides anything.
        if (pending.length) return { outcome: 'stale', reason: `Waiting on ${pending.length} unfinished ${pending.length === 1 ? 'dependency' : 'dependencies'}` };
        if (failed.length) {
          const policy = c.onDependencyFailure ?? DEFAULT_ON_DEPENDENCY_FAILURE;
          this.record(taskId, 'dependency.failed', c.generation, undefined, { failed, policy });
          if (policy !== 'wake-anyway') {
            this.d.db.prepare(`UPDATE wait_conditions SET state = ?, history = ? WHERE task_id = ? AND generation = ?`)
              .run(policy === 'cancel' ? 'cancelled' : 'expired',
                JSON.stringify([...c.history, { at: this.iso(), actor: 'scheduler', outcome: policy, reason: `dependency failed: ${failed.join(', ')}` }].slice(-10)), taskId, c.generation);
            // No session and no open dispatch here (hasOwner is false), so the
            // whole cancellation is this transition; nothing to release.
            this.d.tasks.transition(taskId, policy === 'cancel' ? 'CANCELLED' : 'WAITING_INPUT', 'dependency_failed');
            return { outcome: 'stale', reason: `Dependency failed; applied ${policy}` };
          }
        }
      }
      if (c.resource) {
        const gate = this.resourceGate(c, actor);
        if (gate.outcome !== 'grant') {
          if (gate.outcome === 'unsatisfiable') {
            // Capacity fell below this request (or the pool was undeclared) while the
            // task waited. Parking forever would also block every waiter behind it,
            // so this becomes an operator decision and the queue moves on.
            this.d.db.prepare("UPDATE wait_conditions SET state = 'expired', history = ? WHERE task_id = ? AND generation = ?")
              .run(JSON.stringify([...c.history, { at: this.iso(), actor: 'scheduler', outcome: 'expired', reason: gate.reason }].slice(-10)), taskId, c.generation);
            this.record(taskId, 'resource.unsatisfiable', c.generation, undefined, { resource: c.resource, units: c.units, reason: gate.reason });
            this.d.tasks.transition(taskId, 'WAITING_INPUT', 'intervention_required');
            stateChanged = true;
          }
          return { outcome: 'stale', reason: gate.reason };
        }
      }
      const id = `dispatch_${randomUUID()}`;
      this.d.db.prepare("UPDATE wait_conditions SET state = 'consumed', consumed_at = ?, consumed_by = ? WHERE task_id = ? AND generation = ?").run(this.iso(), actor, taskId, expectedGeneration);
      this.d.db.prepare(`INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,execution_path,phase,created_at,updated_at,checkpoint_id)
        VALUES(?,?,?,?,?,'reserved',?,?,?)`).run(id, taskId, expectedGeneration, c.origin ?? (actor === 'operator' ? 'run-now' : 'wake'), this.d.config.execution.harnessModes.single ? 'harness' : 'legacy', this.iso(), this.iso(), c.checkpointId ?? null);
      if (c.resource) {
        // The claim commits in THIS transaction, with the condition consume and the
        // dispatch reservation. That single boundary — plus `uq_claim_live` and the
        // capacity sum read above — is the whole over-allocation defence: two
        // concurrent wakes cannot both see the last slot free, and a crash leaves
        // either both the claim and its dispatch or neither.
        this.d.db.prepare('INSERT INTO resource_claims(task_id,dispatch_id,generation,resource,units,claimed_at) VALUES(?,?,?,?,?,?)')
          .run(taskId, id, expectedGeneration, c.resource!, c.units ?? 1, this.iso());
        this.record(taskId, 'resource.claimed', c.generation, id, { resource: c.resource, units: c.units ?? 1,
          capacity: this.capacity(c.resource!), claimedUnitsAfter: this.claimed(c.resource!) });
        claimedResource = c.resource;
      }
      this.d.tasks.transition(taskId, 'ROUTING');
      this.record(taskId, 'dispatch.reserved', c.generation, id, { actor });
      return { outcome: 'dispatched', dispatchId: id };
    })();
    if (result.outcome === 'stale' && (stateChanged || result.reason.startsWith('Dependency failed'))) this.publish(taskId);
    if (result.outcome === 'dispatched') {
      // A release can free more units than the front waiter takes, and only the front
      // waiter is woken per event. Re-evaluating after a grant drains the remaining
      // headroom now instead of leaving it idle until the next tick. The queue shrinks
      // with every grant, so the chain terminates.
      if (claimedResource) this.notifyResource(claimedResource);
      this.publish(taskId);
      if (this.d.boundary) await this.d.boundary('reserved', this.dispatch(result.dispatchId));
      await this.continueDispatch(result.dispatchId);
    }
    this.arm();
    return result;
  }
  /**
   * Revalidates quota evidence before the wake decides anything. A probe is an
   * observation, not a wake: attempts are recorded in `history` with
   * `outcome: 'probe'` and never increment `autoWakes`. A probe that fails
   * writes no observation, so the projection is unchanged.
   */
  private async revalidateQuota(taskId: string, generation: number): Promise<void> {
    if (!this.d.probes?.enabled) return;
    const c = this.condition(taskId);
    if (!c || c.state !== 'active' || c.generation !== generation || c.kind !== 'quota') return;
    const attempts = await this.d.probes.refresh(c.assistants).catch(error => { this.d.onError?.(error); return []; });
    if (!attempts.length) return;
    const history = [...c.history, { at: this.iso(), actor: 'scheduler', outcome: 'probe',
      reason: attempts.map(a => `${a.assistantId}: ${a.status}`).join('; ') }].slice(-10);
    this.d.db.prepare("UPDATE wait_conditions SET history = ? WHERE task_id = ? AND generation = ? AND state = 'active'")
      .run(JSON.stringify(redactValue(history)), taskId, generation);
    this.publish(taskId);
  }

  runNow(taskId: string, generation = this.condition(taskId)?.generation ?? 0, confirmNoLiveOwner = false): Promise<WakeResult> {
    const ambiguous = this.dispatches(taskId).find(d => d.phase === 'start_attempted' && d.execution_path === 'legacy');
    if (ambiguous && this.d.tasks.get(taskId)?.state === 'ROUTING') {
      if (!confirmNoLiveOwner || this.inFlight.has(ambiguous.dispatch_id)) return Promise.resolve({ outcome: 'stale', reason: 'Ambiguous legacy start: reconcile the provider, then confirmNoLiveOwner to re-arm' });
      const rearmed = this.d.db.transaction(() => {
        if (this.condition(taskId)?.generation !== generation || this.d.db.prepare('SELECT 1 FROM runs WHERE task_id = ?').get(taskId)) return false;
        this.repark(ambiguous, 'start_ambiguous');
        return true;
      })();
      if (!rearmed) return Promise.resolve({ outcome: 'stale', reason: 'Generation changed or execution evidence exists' });
      generation = this.condition(taskId)!.generation;
      this.record(taskId, 'dispatch.aborted', ambiguous.condition_generation, ambiguous.dispatch_id, { reason: 'Operator confirmed no live execution owner' });
    }
    return this.wake(taskId, generation, 'operator');
  }
  async cancel(taskId: string): Promise<void> {
    // Orchestrator co-commits task/condition/dispatch and durable Harness cancel intent.
    await this.d.orchestrator.cancelTask(taskId);
    this.publish(taskId); this.arm();
  }
  private continueDispatch(id: string): Promise<void> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const work = this.start(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work);
    return work;
  }
  private async start(id: string): Promise<void> {
    const dispatch = this.dispatch(id);
    if (dispatch.phase !== 'reserved') return;
    const taskId = dispatch.task_id;
    if (this.d.tasks.get(taskId)?.state === 'CANCELLED') { this.phase(id, 'cancelled'); return; }
    const routed = this.d.db.transaction(() => {
      const current = this.dispatch(id);
      if (current.routing_decision_id !== null) {
        const row = this.d.db.prepare('SELECT explanation FROM routing_decisions WHERE id = ? AND task_id = ?').get(current.routing_decision_id, taskId) as { explanation: string };
        return { explanation: JSON.parse(row.explanation) as RoutingExplanation, routingDecisionId: current.routing_decision_id };
      }
      const result = this.d.orchestrator.routeTask(taskId, dispatch.origin, { dispatchId: id });
      this.d.db.prepare('UPDATE dispatches SET routing_decision_id = ?, updated_at = ? WHERE dispatch_id = ?').run(result.routingDecisionId, this.iso(), id);
      return result;
    })();
    if (this.d.boundary) await this.d.boundary('routed', this.dispatch(id));
    if (!routed.explanation.chosen) {
      // Retry from current quota evidence; time waits retain their bounded fallback.
      this.repark(dispatch, 'no_candidate'); return;
    }
    try {
      const { runId } = await this.d.orchestrator.startTask(taskId, routed.explanation.chosen, {
        continuation: dispatch.checkpoint_id ? { kind: 'checkpoint', checkpointId: dispatch.checkpoint_id } : { kind: 'fresh' }, dispatchId: id, routingDecisionRef: String(routed.routingDecisionId),
        beforeStart: async () => {
          if (this.d.boundary) await this.d.boundary('materialized', this.dispatch(id));
          this.d.db.transaction(() => {
            if (this.dispatch(id).phase !== 'reserved' || this.d.tasks.get(taskId)?.state !== 'ROUTING') throw new Error('Dispatch no longer owns task');
            this.phase(id, 'start_attempted');
            this.record(taskId, 'dispatch.start_attempted', dispatch.condition_generation, id);
          })();
          if (this.d.boundary) await this.d.boundary('start_attempted', this.dispatch(id));
        },
      });
      // Session/run identity is durable independently of the final phase update.
      if (this.d.boundary) await this.d.boundary('session_created', this.dispatch(id));
      this.d.db.transaction(() => {
        this.d.db.prepare('UPDATE dispatches SET session_id = ? WHERE dispatch_id = ?').run(runId, id);
        if (this.dispatch(id).phase !== 'cancelled') this.phase(id, 'started');
        this.record(taskId, 'dispatch.started', dispatch.condition_generation, id, { sessionId: runId });
      })();
      this.publish(taskId);
    } catch (error) {
      if (this.dispatch(id).phase === 'start_attempted') {
        this.record(taskId, 'dispatch.ambiguous', dispatch.condition_generation, id, { reason: 'Start outcome unknown; recovery required' });
        this.publish(taskId);
      }
      throw error;
    }
  }
  private phase(id: string, phase: Dispatch['phase'], reason?: string): void {
    this.d.db.prepare('UPDATE dispatches SET phase = ?, reason = ?, updated_at = ? WHERE dispatch_id = ?').run(phase, reason ?? null, this.iso(), id);
  }
  private repark(dispatch: Dispatch, reason: string): void {
    this.d.db.transaction(() => {
      if (this.d.tasks.get(dispatch.task_id)?.state !== 'ROUTING') return;
      const claim = this.d.db.prepare("SELECT id, state FROM handoff_envelopes WHERE claimed_by_request_id = ?").get(dispatch.dispatch_id) as { id: string; state: string } | undefined;
      if (claim?.state === 'start_ambiguous') return; // recovery must establish the claim's outcome
      if (claim?.state === 'claimed') new HandoffService(this.d.db).release(claim.id, dispatch.dispatch_id);
      this.d.db.prepare('UPDATE execution_requests SET superseded = 1 WHERE id = ?').run(dispatch.dispatch_id);
      this.phase(dispatch.dispatch_id, reason === 'start_ambiguous' ? 'aborted' : 'reparked', reason);
      const old = this.condition(dispatch.task_id)!;
      const count = old.autoWakes + 1;
      const plan = this.d.orchestrator.quotaPlan(dispatch.task_id, count);
      const history = [...old.history, { at: this.iso(), actor: 'scheduler', outcome: 'reparked', reason }].slice(-10);
      if (count >= (this.d.config.scheduler?.maxAutoWakes ?? DEFAULT_MAX_AUTO_WAKES) || plan.interventionRequired || (old.kind === 'quota' && !plan.notBefore && reason !== 'start_ambiguous')) {
        this.d.db.prepare("UPDATE wait_conditions SET state = 'expired', auto_wakes = ?, history = ? WHERE task_id = ? AND generation = ?").run(count, JSON.stringify(history), old.taskId, old.generation);
        this.d.tasks.transition(dispatch.task_id, 'WAITING_INPUT', plan.interventionRequired ? 'intervention_required' : 'no_candidate');
      } else {
        // A consumed dependency condition had all its subjects terminal; what failed
        // is the dispatch, so the re-park is a bounded time retry, not a second
        // dependency wait (which would re-decide an already settled dependency set).
        const retry = plan.notBefore ?? new Date(this.now().getTime() + RECHECK_MS).toISOString();
        // A resource re-park stays a resource wait and must RE-acquire: the claim this
        // dispatch held is released below, so the successor re-enters the pool queue
        // rather than inheriting a slot its dispatch no longer owns.
        const next: WaitInput = old.kind === 'resource'
          ? { kind: 'resource', notBefore: retry, reason, resource: old.resource!, units: old.units ?? 1 }
          : old.kind === 'quota' ? { kind: 'quota', notBefore: retry, reason }
          : { kind: 'time', notBefore: retry, reason };
        this.insert(dispatch.task_id, next, 'scheduler', count, history, old.checkpointId, plan.blockers, old.origin,
          { resource: old.resource, units: old.units });
        this.d.tasks.transition(dispatch.task_id, 'WAITING_RESOURCE');
      }
      this.record(dispatch.task_id, 'dispatch.reparked', dispatch.condition_generation, dispatch.dispatch_id, { reason, autoWakes: count, history });
    })();
    this.publish(dispatch.task_id);
    // The dispatch no longer owns the task, so it no longer owns the slot. This
    // follows exactly the evidence the re-park itself acted on (no session row, or
    // an operator-confirmed non-start) — it never guesses that a provider is idle.
    this.releaseSoon(dispatch.task_id, `dispatch ${reason}`);
  }

  /** Called after Harness and legacy execution recovery, before arming the timer. */
  async reconcileOnBoot(): Promise<void> {
    for (const dispatch of this.d.db.prepare("SELECT * FROM dispatches WHERE phase IN ('reserved','start_attempted')").all() as Dispatch[]) {
      try {
        if (this.d.tasks.get(dispatch.task_id)?.state === 'CANCELLED') { this.phase(dispatch.dispatch_id, 'cancelled'); continue; }
        const session = this.d.db.prepare('SELECT id FROM runs WHERE dispatch_id = ? OR execution_request_id = ?').get(dispatch.dispatch_id, dispatch.dispatch_id) as { id: string } | undefined;
        if (session) {
          this.d.db.prepare("UPDATE dispatches SET phase = 'started', session_id = ?, updated_at = ? WHERE dispatch_id = ?").run(session.id, this.iso(), dispatch.dispatch_id);
          this.record(dispatch.task_id, 'dispatch.started', dispatch.condition_generation, dispatch.dispatch_id, { sessionId: session.id, recovered: true });
        } else if (dispatch.phase === 'reserved') {
          await this.continueDispatch(dispatch.dispatch_id);
        } else {
          // Fresh Harness starts always persist a session BEFORE calling the provider.
          // No session proves no call on that path. Legacy has no such evidence.
          if (dispatch.execution_path === 'harness' && this.now().getTime() - Date.parse(dispatch.updated_at) >= RECOVERY_WINDOW_MS) {
            this.repark(dispatch, 'start_ambiguous');
          } else {
            this.record(dispatch.task_id, 'dispatch.ambiguous', dispatch.condition_generation, dispatch.dispatch_id,
              { reason: 'start_ambiguous', recovery: dispatch.execution_path === 'legacy' ? 'operator reconciliation required; no automatic retry' : 'awaiting recovery window' });
          }
        }
        this.publish(dispatch.task_id);
      } catch (error) { this.d.onError?.(error); }
    }
    // A claim only ever means "this task's dispatch or session owns execution". A
    // restart that ended either one leaves the claim with nothing behind it, and the
    // sweep is the same ownership test every other release path uses.
    this.releaseIdleClaims();
    if (this.enabled) await this.tick();
    // A disabled boot still has to leave the durable mark the next enable reads.
    else this.schedules.observeEnabled(false);
  }
  startTimer(): void { this.stopped = false; this.arm(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.enabled) return;
    // A capped next deadline also revisits failed ticks and ambiguous Harness windows.
    // Dependency and resource waits are event-driven and their notBefore is only an
    // earliest re-check, so they never set the deadline; the 60 s cap still sweeps
    // them. Letting an already-past resource re-check set it would spin the timer.
    const next = this.d.db.prepare("SELECT MIN(not_before) AS at FROM wait_conditions WHERE state = 'active' AND kind NOT IN ('dependency','resource')").get() as { at: string | null };
    // One timer for both waits and schedules (I-S3): the earlier of the two wins.
    const fire = this.schedules.nextDeadline();
    const at = [next.at, fire].filter((v): v is string => !!v).sort()[0];
    const delay = at ? Math.max(1, Math.min(60_000, Date.parse(at) - this.now().getTime())) : 60_000;
    this.timer = setTimeout(() => { void this.tick().catch(e => this.d.onError?.(e)).finally(() => this.arm()); }, delay);
    this.timer.unref();
  }
  /** Runtime observations trigger the same generation-aware wake once its retry is due. */
  quotaObserved(): void {
    if (!this.enabled) return;
    for (const row of this.d.db.prepare("SELECT task_id, generation FROM wait_conditions WHERE kind = 'quota' AND state = 'active' AND not_before <= ?").all(this.iso()) as { task_id: string; generation: number }[]) {
      void this.wake(row.task_id, row.generation, 'event').catch(error => this.d.onError?.(error));
    }
  }

  async tick(): Promise<void> {
    // Recorded even while disabled: the next enable needs to know it was off.
    const wasDisabled = this.schedules.observeEnabled(this.enabled);
    if (!this.enabled) return;
    this.lastTick = this.iso();
    // Schedules fire before the wake sweep, so an occurrence created now is
    // dispatched by this same tick rather than waiting for the next one.
    this.schedules.fireDue(wasDisabled ? 'disabled' : 'catch-up');
    // Bounded re-evaluation: a missed release event costs one tick, never a hang.
    this.releaseIdleClaims();
    for (const d of this.d.db.prepare("SELECT * FROM dispatches WHERE phase = 'reserved'").all() as Dispatch[]) {
      void this.continueDispatch(d.dispatch_id).catch(error => this.d.onError?.(error));
    }
    for (const r of this.d.db.prepare("SELECT task_id, generation FROM wait_conditions WHERE state = 'active' AND not_before <= ?").all(this.iso()) as { task_id: string; generation: number }[]) {
      void this.wake(r.task_id, r.generation, 'timer').catch(error => this.d.onError?.(error));
    }
    for (const d of this.d.db.prepare("SELECT * FROM dispatches WHERE phase = 'start_attempted' AND execution_path = 'harness'").all() as Dispatch[]) {
      if (!this.inFlight.has(d.dispatch_id) && this.now().getTime() - Date.parse(d.updated_at) >= RECOVERY_WINDOW_MS &&
          !this.d.db.prepare('SELECT 1 FROM runs WHERE execution_request_id = ?').get(d.dispatch_id)) this.repark(d, 'start_ambiguous');
    }
    // Idle headroom: due probes for every enabled assistant, not only the ones
    // some task is parked on. Rate-limited per assistant inside the service.
    if (this.d.probes?.enabled) await this.d.probes.refresh().catch(error => this.d.onError?.(error));
  }
}
