import { HandoffService } from './harness/handoff.js';
import { randomUUID } from 'node:crypto';
import { redactValue, type Dispatch, type RoutingExplanation, type SchedulerEvent, type WaitInput, type WaitCondition } from '@agent-plane/core';
import type { Db } from '../db/index.js';
import type { ResolvedConfig } from '../config.js';
import type { TaskStore } from './tasks.js';
import type { Orchestrator } from './orchestrator.js';
import type { QuotaProbeService } from './quota-probe.js';
import type { TaskEventBus } from './sse.js';

const RECHECK_MS = 60_000;
const RECOVERY_WINDOW_MS = 60_000;
const DEFAULT_MAX_AUTO_WAKES = 3;

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
  constructor(private d: SchedulerDeps) { this.now = d.now ?? (() => new Date()); d.orchestrator.scheduler = this; }
  get enabled(): boolean { return this.d.config.scheduler?.enabled !== false; }
  private iso(): string { return this.now().toISOString(); }
  status() {
    const due = this.d.db.prepare("SELECT COUNT(*) AS count FROM wait_conditions WHERE state = 'active' AND not_before <= ?").get(this.iso()) as { count: number };
    const open = this.d.db.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE phase IN ('reserved','start_attempted')").get() as { count: number };
    return { enabled: this.enabled, armed: !this.stopped && this.enabled && this.timer !== undefined, dueConditions: due.count, openDispatches: open.count, lastTick: this.lastTick,
      probesEnabled: this.d.probes?.enabled ?? false, probes: this.d.probes?.status() ?? [] };
  }

  validate(input: WaitInput): WaitInput {
    if (!input || !['time','quota'].includes(input.kind) || typeof input.notBefore !== 'string' ||
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.notBefore) || !Number.isFinite(Date.parse(input.notBefore))) {
      throw new Error('A wait requires time or quota and with an ISO timestamp including timezone');
    }
    if (input.kind === 'quota' && input.assistants !== undefined && (!Array.isArray(input.assistants) || input.assistants.some(id => typeof id !== 'string' || !this.d.config.assistants[id]))) throw new Error('Quota subjects must name configured assistants');
    if (input.reason !== undefined && typeof input.reason !== 'string') throw new Error('reason must be a string');
    return { ...input, notBefore: new Date(input.notBefore).toISOString(), reason: input.reason ?? 'Scheduled time wait' };
  }

  condition(taskId: string): WaitCondition | undefined {
    const r = this.d.db.prepare('SELECT * FROM wait_conditions WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
    return r ? { schemaVersion: 1, taskId, generation: r.generation as number, state: r.state as WaitCondition['state'], kind: r.kind as WaitCondition['kind'], checkpointId: (r.checkpoint_id ?? undefined) as string | undefined, blockers: JSON.parse(r.blockers as string), assistants: JSON.parse(r.assistants as string),
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
  private insert(taskId: string, input: WaitInput, actor: string, autoWakes = 0, history: WaitCondition['history'] = [], checkpointId?: string, blockers: WaitCondition['blockers'] = []): void {
    const generation = (this.condition(taskId)?.generation ?? 0) + 1;
    this.d.db.prepare(`INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,auto_wakes,history,reason,checkpoint_id,blockers,assistants)
      VALUES(?,?,'active',?,?,?,?,?,?,?,?,?,?)`).run(taskId, generation, input.kind, input.notBefore, actor, this.iso(), autoWakes, JSON.stringify(history.slice(-10)), redactValue(input.reason ?? 'Scheduled wait'), checkpointId ?? null, JSON.stringify(redactValue(blockers)), JSON.stringify(redactValue(input.kind === 'quota' ? input.assistants ?? [] : [])));
  }
  attach(taskId: string, input: WaitInput): WaitCondition {
    input = this.validate(input);
    this.d.db.transaction(() => {
      const row = this.d.tasks.get(taskId);
      if (!row || row.mode !== 'single' || !['CREATED','WAITING_RESOURCE','WAITING_INPUT','LIMIT_PAUSED'].includes(row.state)) throw new Error('Only single tasks in a wait-eligible state may be deferred');
      if (this.hasOwner(taskId)) throw new Error('Existing execution prevents a new time wait');
      const old = this.condition(taskId);
      if (row.state === 'WAITING_RESOURCE' && old?.state !== 'active') throw new Error('No active condition to replace');
      this.d.db.prepare("UPDATE wait_conditions SET state = 'replaced' WHERE task_id = ? AND state = 'active'").run(taskId);
      if (row.state === 'WAITING_INPUT' && !['limit','provider_unavailable','no_candidate','harness_error'].includes(row.pause_kind ?? '')) throw new Error('Pause requires an operator decision');
      const cp = this.d.db.prepare('SELECT id FROM checkpoints WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(taskId) as { id: string } | undefined;
      if (this.d.db.prepare('SELECT 1 FROM runs WHERE task_id = ?').get(taskId) && !cp) throw new Error('Continuation requires a checkpoint');
      this.insert(taskId, input, old ? 'operator' : 'user', old?.autoWakes, old?.history, old?.checkpointId ?? cp?.id,
        input.kind === 'quota' ? this.d.orchestrator.quotaPlan(taskId).blockers : []);
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
      this.insert(taskId, { kind: 'quota', notBefore: plan.notBefore!, reason: 'Quota retry; revalidation required' }, 'failover', count, history, checkpointId, plan.blockers);
      this.d.tasks.transition(taskId, 'WAITING_RESOURCE');
      this.record(taskId, 'wait.attached', this.condition(taskId)!.generation, undefined, { blockers: plan.blockers });
      return true;
    })();
    if (parked) { this.publish(taskId); this.arm(); }
    return parked;
  }

  async wake(taskId: string, expectedGeneration: number, actor: Actor): Promise<WakeResult> {
    await this.revalidateQuota(taskId, expectedGeneration);
    const result = this.d.db.transaction((): WakeResult => {
      const c = this.condition(taskId);
      if (!c || c.state !== 'active' || c.generation !== expectedGeneration || this.d.tasks.get(taskId)?.state !== 'WAITING_RESOURCE' || this.hasOwner(taskId)) {
        return { outcome: 'stale', reason: 'Condition generation or task ownership changed' };
      }
      if (actor !== 'operator' && Date.parse(c.notBefore) > this.now().getTime()) return { outcome: 'stale', reason: 'Condition is not due' };
      const id = `dispatch_${randomUUID()}`;
      this.d.db.prepare("UPDATE wait_conditions SET state = 'consumed', consumed_at = ?, consumed_by = ? WHERE task_id = ? AND generation = ?").run(this.iso(), actor, taskId, expectedGeneration);
      this.d.db.prepare(`INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,execution_path,phase,created_at,updated_at,checkpoint_id)
        VALUES(?,?,?,?,?,'reserved',?,?,?)`).run(id, taskId, expectedGeneration, actor === 'operator' ? 'run-now' : 'wake', this.d.config.execution.harnessModes.single ? 'harness' : 'legacy', this.iso(), this.iso(), c.checkpointId ?? null);
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
        this.insert(dispatch.task_id, { kind: old.kind, notBefore: plan.notBefore ?? new Date(this.now().getTime() + RECHECK_MS).toISOString(), reason }, 'scheduler', count, history, old.checkpointId, plan.blockers);
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
  /** Runtime observations trigger the same generation-aware wake once its retry is due. */
  quotaObserved(): void {
    if (!this.enabled) return;
    for (const row of this.d.db.prepare("SELECT task_id, generation FROM wait_conditions WHERE kind = 'quota' AND state = 'active' AND not_before <= ?").all(this.iso()) as { task_id: string; generation: number }[]) {
      void this.wake(row.task_id, row.generation, 'event').catch(error => this.d.onError?.(error));
    }
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
    // Idle headroom: due probes for every enabled assistant, not only the ones
    // some task is parked on. Rate-limited per assistant inside the service.
    if (this.d.probes?.enabled) await this.d.probes.refresh().catch(error => this.d.onError?.(error));
  }
}
