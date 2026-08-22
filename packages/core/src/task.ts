import type { AssistantId, TaskId } from "./ids.js";
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

export interface RoutingExplanation {
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
}
