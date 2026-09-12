import type { AssistantId } from './ids.js';
import type { EvidenceSource } from './capabilities.js';
import type { RoutingProfile } from './task.js';

/** User intent, never the resolved execution choice. K1 accepts assistant pins only. */
export interface TaskIntent {
  goal: string;
  constraints: string[];
  repository?: { path: string; branch?: string };
  profile: RoutingProfile;
  /** `model` is the requested SELECTOR only — never the resolved provider model id (I-M5). */
  overrides?: { assistantId?: AssistantId; model?: string };
  /**
   * Declared hard requirements of the task (K13 §4.4.3). A declared minimum
   * context window turns unknown capacity from advisory into an exclusion:
   * "we do not know" is not "big enough".
   */
  requirements?: { minContextTokens?: number };
}
export type Continuation = { kind: 'fresh' } | { kind: 'checkpoint'; checkpointId: string };
export type PauseKind = 'limit' | 'provider_unavailable' | 'no_candidate' | 'harness_error'
  | 'approval_pending' | 'verification_failed' | 'comparison_pending' | 'handoff_requested'
  | 'intervention_required' | 'dependency_failed' | 'unknown'
  /** K11 context-continuation stops. None is wait-eligible (CR-32): each needs an operator. */
  | 'continuation_evidence_missing' | 'continuation_limit_reached' | 'continuation_no_progress'
  | 'successor_immediately_critical';

/** CR-30: audit label on a dispatch and its routing decision; never changes what is routed. */
export type DispatchOrigin = 'intake' | 'wake' | 'run-now' | 'failover' | 'context-yield';
export interface QuotaBlocker {
  kind: 'provider-reset' | 'inferred-backoff' | 'transient-unavailable' | 'unknown-recovery' | 'intervention-required';
  assistantId: AssistantId;
  scope: { account?: string; bucket?: string };
  source: EvidenceSource;
  observedAt: string;
  retryAt: string;
  resetProvenance: 'provider-reported' | 'inferred' | 'fallback';
  reason: string;
}
export interface QuotaObservation {
  assistantId: AssistantId; scope: QuotaBlocker['scope'];
  usedPercent?: number; resetsAt?: string; source: EvidenceSource; observedAt: string;
}
export type OnDependencyFailure = 'cancel' | 'wake-anyway' | 'wait-input';
export type WaitInput = TimeWaitInput
  | { kind: 'quota'; notBefore: string; reason?: string; assistants?: AssistantId[] }
  /** K4. `notBefore` is the earliest re-check, not the wake instant: dependency wakes are
   *  event-driven and every wake re-reads the dependency states. Defaults to now. */
  | { kind: 'dependency'; notBefore?: string; reason?: string; dependsOn: string[]; onDependencyFailure?: OnDependencyFailure }
  /** K4b. `notBefore` is the earliest re-check, not the wake instant: a release event wakes the
   *  FIFO front waiter, and the timer sweep is the bounded fallback. Defaults to now. */
  | { kind: 'resource'; notBefore?: string; reason?: string; resource: string; units?: number };
export interface TimeWaitInput { kind: 'time'; notBefore: string; reason?: string }
/**
 * K4b derived pool truth. Capacity is config; usage is the live claim sum. Nothing
 * here is stored: a stale occupancy number would be worse than none (K9 lesson).
 */
export interface ResourcePool {
  resource: string;
  /** Configured capacity, or undefined when the pool is no longer declared. */
  capacity?: number;
  claimedUnits: number;
  availableUnits: number;
  /** Ready resource waits for this pool, oldest requirement first — the FIFO order wakes use. */
  waitingTaskIds: string[];
  /**
   * Tasks that carry a requirement on this pool but whose OTHER preconditions are
   * not satisfied yet. They are deliberately outside the FIFO — they could not be
   * granted, so they must not hold its head of line — but they are still waiting
   * on the pool, and a status that hid them would not be true.
   */
  notReadyTaskIds: string[];
}
/** Operator/failover continuation intent carried across a K4b pool deferral. */
export interface ContinuationIntent {
  /** The `handoffs.trigger` audit label this continuation belongs to. */
  trigger: 'manual' | 'quota' | 'failure';
  /** Operator-named target assistant, applied as the routing override at the grant. */
  to?: AssistantId;
  /** The assistant handed off FROM: excluded at the grant and named in the prompt. */
  from?: AssistantId;
  /** Reason rendered into the receiving agent's handoff prompt. */
  reason?: string;
}
export interface WaitCondition {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  state: 'active' | 'consumed' | 'replaced' | 'cancelled' | 'expired';
  kind: 'time' | 'quota' | 'dependency' | 'resource';
  checkpointId?: string;
  /** kind=dependency: every listed task must be terminal before a wake dispatches. */
  dependsOn?: string[];
  onDependencyFailure?: OnDependencyFailure;
  /** kind=resource: the named pool and unit count this wait needs (K4b). */
  resource?: string;
  units?: number;
  /**
   * When this REQUIREMENT started waiting for the pool — the K4b FIFO key. A
   * requirement carried across a quota re-park, a context continuation or a
   * recovery re-park keeps its original age, so re-parking never costs it a
   * place. `createdAt` still means when this condition row was written.
   */
  resourceQueuedAt?: string;
  /**
   * K4b: the continuation this wait must produce when it is finally granted.
   * A manual handoff (or an automatic failover) for a task that still owes the
   * pool a claim cannot start execution itself — it re-enters the ordinary wake
   * funnel — so the operator's target, the assistant being handed off FROM and
   * the reason the receiving agent is shown are recorded here rather than lost
   * in the deferral. Routing still happens fresh at the grant, so a target that
   * has since become ineligible is re-decided, not replayed.
   */
  continuation?: ContinuationIntent;
  blockers?: QuotaBlocker[];
  assistants?: AssistantId[];
  notBefore: string;
  /**
   * K11: the dispatch origin this wait must produce when it wakes. Durable so a
   * crash between the context yield and the successor dispatch cannot silently
   * relabel a context continuation as an ordinary wake.
   */
  origin?: DispatchOrigin;
  createdBy: string;
  createdAt: string;
  autoWakes: number;
  history: { at: string; actor: string; outcome: string; reason: string }[];
  consumedAt?: string;
  consumedBy?: string;
  reason: string;
}
export interface Dispatch {
  dispatch_id: string;
  task_id: string;
  condition_generation: number;
  origin: DispatchOrigin;
  checkpoint_id: string | null;
  execution_path: 'legacy' | 'harness';
  phase: 'reserved' | 'start_attempted' | 'started' | 'reparked' | 'aborted' | 'cancelled';
  routing_decision_id: number | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  reason: string | null;
}
/** K5 recurring template. Stores intent only (I-S1); never a resolved choice. */
export interface Schedule {
  schemaVersion: 1;
  scheduleId: string;
  kind: 'user' | 'system';
  intent: TaskIntent;
  /** 5-field cron expression, evaluated in `timezone`. */
  cron: string;
  /** IANA zone name. */
  timezone: string;
  enabled: boolean;
  /**
   * 'skip': an occurrence due while the previous one is non-terminal is
   * recorded `skipped-overlap` and creates nothing.
   * 'queue': it is persisted as durable queued work and promoted, oldest
   * first, once the schedule has no non-terminal task. Either way a schedule
   * never has two non-terminal tasks at once.
   */
  overlap: ScheduleOverlap;
  catchUpWindowMinutes: number;
  lastFiredAt?: string;
  nextFireAt?: string;
  /** Display only - `schedule_occurrences` is the deduplication mechanism. */
  lastTaskId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Queued occurrences not yet promoted. Derived at read from
   * `schedule_occurrences`, never stored: a stale backlog number would be
   * worse than none (the K9 lesson).
   */
  queuedCount: number;
  /** The schedule's current non-terminal occurrence task, if any. Derived. */
  activeTaskId?: string;
}
export type ScheduleOverlap = 'skip' | 'queue';
export type ScheduleOutcome = 'created' | 'queued' | 'skipped-overlap' | 'skipped-catch-up' | 'skipped-disabled';
/** One row per scheduled occurrence; unique on (scheduleId, occurrenceAt). */
export interface ScheduleOccurrence {
  scheduleId: string;
  /** The cron instant in UTC - the dedup key, and the queue's FIFO key. */
  occurrenceAt: string;
  firedAt: string;
  outcome: ScheduleOutcome;
  taskId?: string;
  /**
   * When this occurrence was enqueued behind a non-terminal task. Survives
   * promotion: `created` WITH a `queuedAt` means "promoted from the queue",
   * which is not the same fact as "created at the cron instant".
   */
  queuedAt?: string;
  /** When the queued occurrence became a task. */
  promotedAt?: string;
  /** 1-based FIFO rank, on queued occurrences only. Ordered by the plane. */
  queuePosition?: number;
}
export interface ScheduleInput {
  goal: string;
  cron: string;
  timezone: string;
  constraints?: string[];
  repoPath?: string;
  profile?: RoutingProfile;
  overrides?: TaskIntent['overrides'];
  /** Declared hard requirements — a minimum context window excludes candidates (K13). */
  requirements?: TaskIntent['requirements'];
  kind?: 'user' | 'system';
  enabled?: boolean;
  overlap?: ScheduleOverlap;
  catchUpWindowMinutes?: number;
}
export interface SchedulerEvent {
  id: number;
  taskId: string;
  generation?: number;
  dispatchId?: string;
  type: 'wait.attached' | 'wait.replaced' | 'dispatch.reserved' | 'dispatch.start_attempted'
    | 'dispatch.started' | 'dispatch.ambiguous' | 'dispatch.reparked' | 'dispatch.aborted' | 'wait.cancelled'
    | 'dependency.failed'
    /** K4b: the durable audit trail of who holds a slot and why another task waited. */
    | 'resource.claimed' | 'resource.released' | 'resource.unsatisfiable';
  at: string;
  payload: Record<string, unknown>;
}
