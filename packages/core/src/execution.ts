/**
 * Control Plane ↔ Execution Harness contract (execution-harness §2).
 *
 * Provider-neutral. Every top-level contract type carries its own `schemaVersion`
 * (starting at 1), independent of `CONTROL_PLANE_API_VERSION`. Reuse over
 * invention: `RunSpec`, `PermissionPolicy`, `UsagePayload`, `NormalizedEvent` and
 * the adapter contract are kept; these types wrap rather than replace them.
 *
 * These are types + one pure canonicalization helper only (`fingerprint.ts`).
 * Nothing here imports a provider or a runtime.
 */

import type { RunSpec, PermissionPolicy } from "./adapter.js";
import type { ModelRef } from "./capabilities.js";
import type {
  AssistantId,
  ExecutionSessionId,
  ProviderSessionRef,
  RepositoryId,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "./ids.js";
import { verificationPassed } from "./events.js";
import type { UsagePayload, VerificationCheckResult, VerificationKind } from "./events.js";
import type { ExecutionSessionState, TerminalSessionState } from "./session-state.js";

// ---------------------------------------------------------------------------
// ExecutionRequest — what the Control Plane hands the Harness
// ---------------------------------------------------------------------------

/**
 * Immutable once accepted. Persisted identity is `requestFingerprint` (a digest
 * over a canonical projection of every execution-affecting and
 * authorization-relevant field — see `fingerprint.ts`). Resubmitting an
 * `executionRequestId` with the SAME fingerprint returns the same session;
 * resubmitting with a DIFFERENT fingerprint is a conflict, never an idempotent
 * retry. Exact byte replay is a non-goal — replay is semantic (re-render from
 * provenance) and the prompt digest is the integrity witness.
 */
export interface ExecutionRequest {
  schemaVersion: 1;
  /** Idempotency key. Resubmission with the same fingerprint returns the same session. */
  executionRequestId: string;
  taskId: TaskId;
  /** Opaque to the Harness — carried for observability joins, never read by logic. */
  correlation?: { parentTaskId?: TaskId; groupId?: string };
  /** 1..n; a retry is a NEW request with `attempt + 1`, issued by the Control Plane. */
  attempt: number;
  /** Decided by the Control Plane. The Harness never changes it (H-I1). */
  assistantId: AssistantId;
  model?: ModelRef;
  /** AgentSpec link (Agentic OS era); absent pre-Composer. */
  compositionRevisionId?: string;
  /** Explainability back-pointer to the routing decision. */
  routingDecisionRef: string;
  runSpec: RunSpec;
  policy: ExecutionPolicy;
  context: ExecutionContext;
  /** May be empty. */
  verification: VerificationSpec[];
  /** Optional explainable planner output; `verification` remains its executable checks. */
  verificationPlan?: VerificationPlan;
  origin: ExecutionOrigin;
}

export type ExecutionOrigin =
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: ExecutionSessionId; checkpointId: string }
  | { kind: "handoff"; envelopeId: string };

export interface ExecutionPolicy {
  budget: BudgetPolicy;
  /** The only authoritative runtime deadline. `hardMs` is truly hard (local clock). */
  timeout: { idleMs?: number; hardMs: number };
  /** Existing type. The Harness enforces; the Control Plane defines. */
  approval: PermissionPolicy;
  tools: ToolPolicy;
  checkpoint: { onSoftLimit: boolean; periodicMs?: number };
  /**
   * Minimum acceptable provider-process isolation fidelity (§3 tiers). An
   * explicit contract field, never implicit policy interpretation. Prepare
   * rejects (`policy_unenforceable`) when the verifiable tier is below
   * `required`; a per-session verification below `required` fails the session
   * before RUNNING. The achieved tier is always reported on the result.
   */
  isolation: { required: IsolationTier };
}

export type IsolationTier = "full" | "partial" | "ambient";

export interface BudgetPolicy {
  /**
   * Token/cost accounting ONLY. Runtime has exactly one authoritative field:
   * `ExecutionPolicy.timeout.hardMs`. `RunSpec.env.maxRuntimeMs` is derived from
   * it at Prepare and validated equal — never a second deadline.
   */
  maxTokens?: number;
  /** Requires `pricingVersion` when `enforcement` is "bounded". */
  maxCostUsd?: number;
  /** Versioned pricing table used to derive cost from tokens. */
  pricingVersion?: string;
  /**
   * "bounded": requires the adapter manifest to declare a quantitative
   * usage-reporting contract (`usageReporting`), proven by the conformance suite.
   * The guard evaluates the cap at every usage event and cancels on observed
   * excess; residual risk is bounded by `maxUnreportedTokens` and recorded as
   * `overrun`. A reporting gap cancels with `budget_exceeded`. Prepare rejects
   * bounded when the contract is undeclared/unproven, accounting mode is "none",
   * or (for cost caps) `pricingVersion` is absent.
   * "advisory": records overruns without cancelling.
   * There is no "hard" token/cost mode.
   */
  enforcement: "bounded" | "advisory";
}

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
  /**
   * "preventive": requires a callable enforcement path (adapter consumes
   * `RunSpec.toolPolicy` before any tool executes). Prepare rejects preventive
   * mode when the manifest's `toolGating` is not "preventive"
   * (`policy_unenforceable`).
   * "audit": explicitly accepted detect-and-record mode — a matched deny still
   * ends the session (FAILED, tool_denied) but the side effect may already have
   * happened. Silent downgrade never occurs (H-I10).
   */
  mode: "preventive" | "audit";
}

export interface ExecutionContext {
  /**
   * Stable execution target assigned by the Control Plane. Optional during the
   * schemaVersion 1 compatibility window; paths below remain authoritative for
   * placement until target registries are wired. Never derive these ids from a
   * cwd, provider session reference, PLAN file, or observer record.
   */
  target?: ExecutionTarget;
  worktree?: { repoPath: string; branch: string; worktreePath: string; baseRef: string };
  /** Composed context bundle digests (Agentic OS era). */
  bundleRefs?: string[];
  /** When `origin.kind === "handoff"`. */
  envelopeId?: string;
  priorCheckpointId?: string;
  /**
   * Names (not values) of secrets the provider launch may use. The Harness's
   * SecretBroker (§3) resolves ONLY these, at the launch boundary; values never
   * enter the persisted request, the fingerprint, or any diagnostic.
   */
  secretRefs?: string[];
}

export interface RepositoryRef {
  kind: "repository";
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
}

export interface WorktreeRef {
  kind: "worktree";
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  worktreeId: WorktreeId;
}

/** A request may target a repository before a concrete worktree has been allocated. */
export type ExecutionTarget = RepositoryRef | WorktreeRef;

// ---------------------------------------------------------------------------
// ExecutionSession — durable record of one attempt to execute one request
// ---------------------------------------------------------------------------

/** One session IS one `runs` row (§10). */
export interface ExecutionSession {
  sessionId: ExecutionSessionId;
  executionRequestId: string;
  state: ExecutionSessionState;
  /** Optimistic-concurrency counter; every write is a CAS (H-I12). */
  version: number;
  /** Fencing token of the owning SessionRunner (§9). */
  leaseToken?: string;
  leaseExpiresAt?: string;
  providerSessionRef?: ProviderSessionRef;
  /** §9 start-intent / start-ack protocol. */
  providerStartAcked: boolean;
  /** Durable cancellation intent. */
  cancelRequested: boolean;
  /** CAS winner of terminalization (replaces the in-memory `handingOff` flag). */
  settlementOwner?: string;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
}

// ---------------------------------------------------------------------------
// ExecutionResult — one per terminal session (H-I3), persisted in the terminal CAS
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  schemaVersion: 1;
  sessionId: ExecutionSessionId;
  /** The session's terminal state verbatim (§5) — never a live state. */
  terminalState: TerminalSessionState;
  /**
   * DERIVED from `terminalState` by the fixed mapping in `session-state.ts`
   * (`outcomeOf`). Execution and verification are reported SEPARATELY and never
   * folded into each other: `outcome` describes what the provider execution did;
   * `verification` describes what the checks found. `outcome: "completed"` with
   * `verification.passed === false` is legal and expected — the Control Plane
   * decides the task verdict (H-I6).
   */
  outcome: "completed" | "failed" | "cancelled" | "timed_out" | "yielded";
  yield?: { kind: "reroute" | "handoff" | "limit"; detail: RerouteRequest | HandoffRequest };
  /** Present iff outcome is failed/timed_out. */
  failure?: ExecutionFailure;
  /** Present iff cancelled. */
  cancellation?: { requestedBy: "user" | "plane"; at: string };
  /** Absent when no `VerificationSpec` was given. */
  verification?: EvaluationResult;
  artifacts: ExecutionArtifact[];
  usage: UsagePayload & { accounting: "delta" | "cumulative" | "none"; overrun?: UsagePayload };
  checkpoint: { attempted: boolean; committed: boolean; checkpointId?: string; gitRef?: string };
  /** Honesty record (H-I10). What was ACTUALLY enforced, not what was requested. */
  enforcement: {
    tools: "preventive" | "audit" | "none";
    budget: "bounded" | "advisory" | "none";
    isolation: IsolationTier;
  };
}

/**
 * Normalized failure taxonomy — replaces provider error strings at the boundary.
 * NOTE: cancellation is an outcome, not a failure. `verification_failed` is NOT a
 * Harness failure kind — failed checks ride on `verification`.
 */
export type FailureKind =
  | "provider_fault"
  | "auth"
  | "quota"
  | "timeout"
  | "budget_exceeded"
  | "tool_denied"
  | "workspace"
  | "policy_unenforceable"
  | "orphaned"
  | "internal";

export interface ExecutionFailure {
  kind: FailureKind;
  retryable: boolean;
  /** Redacted before persistence; size-capped. */
  providerDetail?: unknown;
  message: string;
}

export interface ExecutionArtifact {
  kind:
    | "diff"
    | "file_list"
    | "test_report"
    | "checkpoint"
    | "rendered_output"
    | "api_report"
    | "browser_report"
    | "screenshot"
    | "console_log"
    | "evaluation_report"
    | "review_report"
    | "trace_ref";
  /** checkpoint id, git ref, event range — never inline blobs. */
  ref: string;
  /** Size-capped like event summaries. */
  summary: string;
  digest?: string;
  mediaType?: string;
  sizeBytes?: number;
  retention?: "ephemeral" | "session" | "task" | "pinned";
}

// ---------------------------------------------------------------------------
// Verification  (`VerificationKind` is exported from ./events.js)
// ---------------------------------------------------------------------------

export interface VerificationSpec {
  /** Stable planner id; optional while schemaVersion 1 legacy requests remain readable. */
  checkId?: string;
  name: string;
  kind: VerificationKind;
  /** Validated + executed by the WorkspaceAuthority (§3), NOT via adapter tools. */
  command?: string;
  /** Provider selection is policy input and therefore fingerprinted. */
  provider?: string;
  /** `required: false` checks report but never affect outcome. */
  required: boolean;
}

export interface EvaluationResult {
  /** All `required` checks passed. */
  passed: boolean;
  checks: VerificationCheckResult[];
}

/** Preferred constructor for new results; legacy rows remain readable as-is. */
export function evaluationResult(checks: VerificationCheckResult[]): EvaluationResult {
  return { passed: verificationPassed(checks), checks };
}

export interface VerificationDecision {
  checkId: string;
  /** Canonical trusted-registry identity; optional only for legacy plan readers. */
  capabilityIdentity?: string;
  selected: boolean;
  required: boolean;
  signals: string[];
  reason: string;
}

/** Persistable output of the future deterministic VerificationPlanner. */
export interface VerificationPlan {
  schemaVersion: 1;
  /** Durable identity; absent only on legacy/in-memory plans. */
  planRevisionId?: string;
  /** Monotonic within one execution session; absent on legacy plans. */
  revision?: number;
  /** Previous immutable revision, when this plan was revised post-change. */
  supersedesRevisionId?: string;
  /** SHA-256 over the canonical plan revision with fingerprint fields omitted. */
  planFingerprint?: string;
  fingerprintAlgorithm?: "sha256-canonical-verification-plan-v1";
  /** Selected checks only. Every entry has a stable id used by decisions/results. */
  checks: Array<VerificationSpec & { checkId: string }>;
  decisions: VerificationDecision[];
  /** Required kinds for which the trusted capability registry had no provider. */
  unmetRequirements?: VerificationKind[];
}

/** Read projection only; canonical state remains EvaluationResult + ExecutionArtifact. */
export interface EvidenceBundle {
  sessionId: ExecutionSessionId;
  verification?: EvaluationResult;
  artifacts: ExecutionArtifact[];
}

// ---------------------------------------------------------------------------
// Handoff (§7) & Reroute (§8)
// ---------------------------------------------------------------------------

export interface HandoffEnvelope {
  schemaVersion: 1;
  envelopeId: string;
  taskId: TaskId;
  /**
   * The durable anchor. Envelope fields are derived FROM this checkpoint's
   * immutable snapshot, never from the live mutable task envelope.
   */
  checkpointId: string;
  objective: string;
  currentSubtask?: string;
  completedActions: string[];
  outstanding: string[];
  /** Provenance-tagged. */
  decisions: Array<{ text: string; madeBy: string; at: string }>;
  artifacts: {
    gitRef?: string;
    diffStat?: string;
    changedFiles: string[];
    lastTests?: unknown;
  };
  verificationStatus?: EvaluationResult;
  /** Digests / names — reconstructable state only. */
  contextRefs: string[];
  /** Paths, never contents. */
  workspace: { repoPath: string; branch: string };
  fromAssistantId: AssistantId;
  reason: string;
}

/** A request to hand off — the Harness yields; the Control Plane picks a target. */
export interface HandoffRequest {
  sessionId: ExecutionSessionId;
  taskId: TaskId;
  /**
   * Absent when no checkpoint committed and thus no envelope was assembled: the
   * plane parks the task rather than route a successor against a fabricated id.
   */
  envelopeId?: string;
  reason: string;
}

export interface RerouteRequest {
  sessionId: ExecutionSessionId;
  taskId: TaskId;
  reason:
    | "capability_missing"
    | "auth_failed"
    | "quota_exhausted"
    | "repeated_provider_fault"
    | "model_unsuitable";
  /** Points at persisted events. */
  evidence: Array<{ eventSeq: number; summary: string }>;
  /** Checkpoint attempt recorded per H-I4 semantics. */
  checkpointId?: string;
  /** The Harness proposes no target — typed boundary (H-I1). */
  suggestion?: never;
}
