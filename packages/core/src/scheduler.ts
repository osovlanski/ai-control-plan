import type { AssistantId } from './ids.js';
import type { EvidenceSource } from './capabilities.js';
import type { RoutingProfile } from './task.js';

/** User intent, never the resolved execution choice. K1 accepts assistant pins only. */
export interface TaskIntent {
  goal: string;
  constraints: string[];
  repository?: { path: string; branch?: string };
  profile: RoutingProfile;
  overrides?: { assistantId?: AssistantId };
}
export type Continuation = { kind: 'fresh' } | { kind: 'checkpoint'; checkpointId: string };
export type PauseKind = 'limit' | 'provider_unavailable' | 'no_candidate' | 'harness_error'
  | 'approval_pending' | 'verification_failed' | 'comparison_pending' | 'handoff_requested'
  | 'intervention_required' | 'dependency_failed' | 'unknown';
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
  | { kind: 'dependency'; notBefore?: string; reason?: string; dependsOn: string[]; onDependencyFailure?: OnDependencyFailure };
export interface TimeWaitInput { kind: 'time'; notBefore: string; reason?: string }
export interface WaitCondition {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  state: 'active' | 'consumed' | 'replaced' | 'cancelled' | 'expired';
  kind: 'time' | 'quota' | 'dependency';
  checkpointId?: string;
  /** kind=dependency: every listed task must be terminal before a wake dispatches. */
  dependsOn?: string[];
  onDependencyFailure?: OnDependencyFailure;
  blockers?: QuotaBlocker[];
  assistants?: AssistantId[];
  notBefore: string;
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
  origin: 'wake' | 'run-now';
  checkpoint_id: string | null;
  execution_path: 'legacy' | 'harness';
  phase: 'reserved' | 'start_attempted' | 'started' | 'reparked' | 'aborted' | 'cancelled';
  routing_decision_id: number | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  reason: string | null;
}
export interface SchedulerEvent {
  id: number;
  taskId: string;
  generation?: number;
  dispatchId?: string;
  type: 'wait.attached' | 'wait.replaced' | 'dispatch.reserved' | 'dispatch.start_attempted'
    | 'dispatch.started' | 'dispatch.ambiguous' | 'dispatch.reparked' | 'dispatch.aborted' | 'wait.cancelled'
    | 'dependency.failed';
  at: string;
  payload: Record<string, unknown>;
}
