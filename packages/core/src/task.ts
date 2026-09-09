import type { AssistantId, TaskId } from "./ids.js";
import type { ModelRecommendation } from "./model-selection.js";
import type { Continuation } from './scheduler.js';
import type { TaskState } from "./state-machine.js";

/** Informational only — annotates events/UI, never drives orchestration. */
export type ActivityPhase = "planning" | "editing" | "testing" | "reviewing";

/**
 * Routing profiles. The first three are rule-based and always available; the
 * telemetry-fed ones degrade to stable order (and say so in the explanation)
 * until enough of the user's own runs exist to measure.
 */
export type RoutingProfile =
  | "auto"
  | "preserve-quota"
  | "fastest"
  | "best-quality"
  | "lowest-tokens";

/** How a task executes across assistants (Phase 5). */
export type TaskMode = "single" | "compare" | "race";

export interface TaskDecision {
  text: string;
  /** Provenance: user-imposed decisions are inviolable on handoff; agent decisions are revisitable. */
  madeBy: "user" | `agent:${string}`;
  at: string; // ISO timestamp
}

export interface TaskArtifacts {
  diffRef?: string;
  changedFiles: string[];
  testResults: TestResultSummary[];
}

export interface TestResultSummary {
  at: string;
  passed: number;
  failed: number;
  command?: string;
  failures?: string[];
}

/**
 * Provider-independent portable task state — the unit of handoff.
 * Stored structured in the DB; progress.md / handoff.md are rendered projections.
 */
export interface TaskEnvelope {
  taskId: TaskId;
  goal: string;
  /** User-imposed constraints. Inviolable across handoffs. */
  constraints: string[];
  repository?: {
    path: string;
    branch: string;
  };
  status: {
    state: TaskState;
    phase?: ActivityPhase;
  };
  /** Derived from the event stream ∪ agent-reported progress. */
  completed: string[];
  remaining: string[];
  decisions: TaskDecision[];
  artifacts: TaskArtifacts;
  nextAction?: string;
}

/**
 * The next action a K11 clean-session continuation can honestly hand its
 * successor, derived from the checkpoint's immutable envelope snapshot.
 *
 * `undefined` means the checkpoint holds nothing to continue FROM — no planned
 * next action, no outstanding list, no recorded progress and no touched files.
 * Restarting from that is a fresh run, not a continuation, so the Control Plane
 * parks the task instead of spending another session on it (§4.3.3 item 2).
 * Nothing here invents work: every branch quotes state the envelope already has.
 */
export function continuationNextAction(envelope: TaskEnvelope): string | undefined {
  const explicit = envelope.nextAction?.trim();
  if (explicit) return explicit;
  const outstanding = envelope.remaining.map((r) => r.trim()).filter(Boolean);
  if (outstanding.length > 0) return `Continue the outstanding work, starting with: ${outstanding[0]}`;
  const progressed =
    envelope.completed.some((c) => c.trim()) || envelope.artifacts.changedFiles.length > 0;
  return progressed
    ? "Continue from the checkpoint commit — review the completed work above, then finish the goal."
    : undefined;
}

export interface RoutingExplanation {
  /** Durable wake provenance; absent for non-scheduler routing. */
  dispatchId?: string;
  continuation?: Continuation;
  candidates: Array<{
    assistantId: AssistantId;
    passedFilters: boolean;
    filterFailures: string[];
    quota?: { usedPercent: number; resetsAt?: string };
  }>;
  ruleFired: string;
  chosen?: AssistantId;
  tieBreaker?: string;
  userOverride?: AssistantId;
  /**
   * K11 continuation provenance (§4.3.3 item 5). Present only when
   * `origin === 'context-yield'`; it extends this existing routing record rather
   * than opening a second continuation-history subsystem.
   */
  contextContinuation?: ContextContinuationProvenance;
  /**
   * K13 model recommendation. SHADOW by default: it is computed, sourced and
   * persisted here, and it changes nothing about `ExecutionRequest.model`,
   * `RunSpec.model`, `chosen` or the provider call (§4.4.3, CR-33).
   */
  modelRecommendation?: ModelRecommendation;
}

/** Everything needed to explain one context continuation after the fact. */
export interface ContextContinuationProvenance {
  continuationNumber: number;
  maxContinuationsPerTask: number;
  checkpointId: string;
  predecessorSessionId?: string;
  previousAssistantId?: string;
  previousModelRequested?: string;
  previousModelResolved?: string;
  /** The selector the task intent still asks for — unchanged by a continuation. */
  requestedModel?: string;
  reason: string;
  criticalPressure?: number;
  observedAt?: string;
  /** Did the successor land on the predecessor's assistant? */
  preferSameSatisfied?: boolean;
  /** When it did not: the hard filters the previous assistant failed. */
  changedBecause?: string;
}
