import { randomUUID } from 'node:crypto';
import { redactValue, type Dispatch, type SchedulerEvent, type TimeWaitInput, type WaitCondition } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { ResolvedConfig } from '../config.js';
import type { TaskStore } from './tasks.js';
import type { Orchestrator } from './orchestrator.js';
import type { TaskEventBus } from './sse.js';

const RECHECK_MS = 60_000;
const RECOVERY_WINDOW_MS = 60_000;
const MAX_AUTO_WAKES = 3;

type Actor = 'timer' | 'event' | 'operator';
type WakeResult = { outcome: 'stale'; reason: string } | { outcome: 'dispatched'; dispatchId: string };
export interface SchedulerDeps {
  db: Db; tasks: TaskStore; orchestrator: Orchestrator; bus: TaskEventBus; config: ResolvedConfig;
  now?: () => Date;
  /** Deterministic fault injection at committed crash boundaries. */
  boundary?: (phase: 'reserved' | 'start_attempted' | 'session_created', dispatch: Dispatch) => Promise<void>;
  onError?: (error: unknown) => void;
}

/** One process, one SQLite owner, one re-armed timer. No provider execution exactly-once claim. */
export class Scheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastTick: string | null = null;
  private readonly now: () => Date;
  private inFlight = new Map<string, Promise<void>>();
  constructor(private d: SchedulerDeps) { this.now = d.now ?? (() => new Date()); }
  get enabled(): boolean { return this.d.config.scheduler?.enabled !== false; }
  private iso(): string { return this.now().toISOString(); }
  status() {
    const due = this.d.db.prepare("SELECT COUNT(*) AS count FROM wait_conditions WHERE state = 'active' AND not_before <= ?").get(this.iso()) as { count: number };
    const open = this.d.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE phase IN ('reserved','start_attempted')").get() as { count: number };
    return { enabled: this.enabled, armed: !this.stopped && this.enabled && this.timer !== undefined, dueConditions: due.count, openDispatches: open.count, lastTick: this.lastTick };
  }

  validate(input: TimeWaitInput): TimeWaitInput {
    if (!input || input.kind !== 'time' || typeof input.notBefore !== 'string' ||
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.notBefore) || !Number.isFinite(Date.parse(input.notBefore))) {
      throw new Error('K1 requires a time wait with an ISO timestamp including timezone');
    }
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new Error('reason must be a string');
    return { kind: 'time', notBefore: new Date(input.notBefore).toISOString(), reason: input.reason ?? 'Scheduled time wait' };
  }

  condition(taskId: string): WaitCondition | undefined {
    const r = this.d.db.prepare('SELECT * FROM wait_conditions WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
    return r ? { schemaVersion: 1, taskId, generation: r.generation as number, state: r.state as WaitCondition['state'], kind: 'time',
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
    return !!this.d.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND ended_at IS NULL").get(taskId) ||
      !!this.d.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId);
  }
  private insert(taskId: string, input: TimeWaitInput, actor: string, autoWakes = 0, history: WaitCondition['history'] = []): void {
    const generation = (this.condition(taskId)?.generation ?? 0) + 1;
    this.d.db.prepare(`INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,reason)
      VALUES(?,?,'active','time',?,?,?,?,?,?)`).run(taskId, generation, input.notBefore, actor, this.iso(), autoWakes, JSON.stringify(history.slice(-10)), redactValue(input.reason ?? 'Scheduled time wait'));
  }
  attach(taskId: string, input: TimeWaitInput): WaitCondition {
    input = this.validate(input);
    this.d.db.transaction(() => {
      const row = this.d.tasks.get(taskId);
      if (!row || row.mode !== 'single' || !['CREATED','WAITING_RESOURCE'].includes(row.state)) throw new Error('K1 supports new single-task time waits and active condition replacement only');
      if (this.hasOwner(taskId) || this.d.db.prepare('SELECT 1 FROM runs WHERE task_id = ?').get(taskId)) throw new Error('Existing execution prevents a new time wait');
      const old = this.condition(taskId);
      if (row.state === 'WAITING_RESOURCE' && old?.state !== 'active') throw new Error('No active condition to replace');
      this.d.db.prepare("UPDATE wait_conditions SET state = 'replaced' WHERE task_id = ? AND state = 'active'").run(taskId);
      this.insert(taskId, input, old ? 'operator' : 'user', old?.autoWakes, old?.history);
      if (row.state === 'CREATED') this.d.tasks.transition(taskId, 'WAITING_RESOURCE');
      this.record(taskId, old ? 'wait.replaced' : 'wait.attached', this.condition(taskId)!.generation);
    })();
    this.publish(taskId); this.arm();
    return this.condition(taskId)!;
  }

  async wake(taskId: string, expectedGeneration: number, actor: Actor): Promise<WakeResult> {
    const result = this.d.db.transaction((): WakeResult => {
      const c = this.condition(taskId);
      if (!c || c.state !== 'active' || c.generation !== expectedGeneration || this.d.tasks.get(taskId)?.state !== 'WAITING_RESOURCE' || this.hasOwner(taskId)) {
        return { outcome: 'stale', reason: 'Condition generation or task ownership changed' };
      }
      if (actor !== 'operator' && Date.parse(c.notBefore) > this.now().getTime()) return { outcome: 'stale', reason: 'Condition is not due' };
      const id = `dispatch_${randomUUID()}`;
      this.d.db.prepare("UPDATE wait_conditions SET state = 'consumed', consumed_at = ?, consumed_by = ? WHERE task_id = ? AND generation = ?").run(this.iso(), actor, taskId, expectedGeneration);
      this.d.db.prepare(`INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,execution_path,phase,created_at,updated_at)
        VALUES(?,?,?,?,?,'reserved',?,?)`).run(id, taskId, expectedGeneration, actor === 'operator' ? 'run-now' : 'wake', this.d.config.execution.harnessModes.single ? 'harness' : 'legacy', this.iso(), this.iso());
      this.d.tasks.transition(taskId, 'ROUTING');
      this.record(taskId, 'dispatch.reserved', c.generation, id, { actor });
      return { outcome: 'dispatched', dispatchId: id };
    })();
    if (result.outcome === 'dispatched') {
      this.publish(taskId);
      if (this.d.boundary) await this.d.boundary('reserved', this.dispatch(result.dispatchId));
      await this.continueDispatch(result.dispatchId);
    }
    this.arm();
    return result;
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
    let dispatch = this.dispatch(id);
    if (dispatch.phase !== 'reserved') return;
    const taskId = dispatch.task_id;
    if (this.d.tasks.get(taskId)?.state === 'CANCELLED') { this.phase(id, 'cancelled'); return; }
    const routed = this.d.orchestrator.routeTask(taskId, dispatch.origin);
    this.d.db.prepare('UPDATE dispatches SET routing_decision_id = ?, updated_at = ? WHERE dispatch_id = ?').run(routed.routingDecisionId, this.iso(), id);
    if (!routed.explanation.chosen) {
      // K1 rechecks a TIME condition, not a fabricated quota-reset projection (K2).
      this.repark(dispatch, 'no_candidate'); return;
    }
    this.d.db.transaction(() => {
      this.d.db.prepare('UPDATE dispatches SET execution_path = ? WHERE dispatch_id = ?').run(this.d.config.execution.harnessModes.single ? 'harness' : 'legacy', id);
      this.phase(id, 'start_attempted');
      this.record(taskId, 'dispatch.start_attempted', dispatch.condition_generation, id);
    })();
    dispatch = this.dispatch(id);
    if (this.d.boundary) await this.d.boundary('start_attempted', dispatch);
    try {
      const { runId } = await this.d.orchestrator.startTask(taskId, routed.explanation.chosen, {
        continuation: { kind: 'fresh' }, dispatchId: id, routingDecisionRef: String(routed.routingDecisionId),
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
      if (this.dispatch(id).phase !== 'cancelled') {
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
      this.phase(dispatch.dispatch_id, reason === 'start_ambiguous' ? 'aborted' : 'reparked', reason);
      const old = this.condition(dispatch.task_id)!;
      const count = old.autoWakes + 1;
      const history = [...old.history, { at: this.iso(), actor: 'scheduler', outcome: 'reparked', reason }].slice(-10);
      if (count >= MAX_AUTO_WAKES) {
        this.d.tasks.transition(dispatch.task_id, 'WAITING_INPUT', 'no_candidate');
      } else {
        this.insert(dispatch.task_id, { kind: 'time', notBefore: new Date(this.now().getTime() + RECHECK_MS).toISOString(), reason }, 'scheduler', count, history);
        this.d.tasks.transition(dispatch.task_id, 'WAITING_RESOURCE');
      }
      this.record(dispatch.task_id, 'dispatch.reparked', dispatch.condition_generation, dispatch.dispatch_id, { reason, autoWakes: count, history });
    })();
    this.publish(dispatch.task_id);
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
    if (this.enabled) await this.tick();
  }
  startTimer(): void { this.stopped = false; this.arm(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.enabled) return;
    // A capped next deadline also revisits failed ticks and ambiguous Harness windows.
    const next = this.d.db.prepare("SELECT MIN(not_before) AS at FROM wait_conditions WHERE state = 'active'").get() as { at: string | null };
    const delay = next.at ? Math.max(1, Math.min(60_000, Date.parse(next.at) - this.now().getTime())) : 60_000;
    this.timer = setTimeout(() => { void this.tick().catch(e => this.d.onError?.(e)).finally(() => this.arm()); }, delay);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (!this.enabled) return;
    this.lastTick = this.iso();
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
  }
}
