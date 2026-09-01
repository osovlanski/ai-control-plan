import type { RunId } from "./ids.js";
import type { ActivityPhase } from "./task.js";

/**
 * Closed set of normalized event types (revised architecture §4).
 *
 * The final three are execution-harness additions (§2): they are additive to the
 * closed set — no existing type changed — and each has a typed payload below.
 * `guard.decision` is an audit record of a guard directive; `checkpoint.created`
 * and `verification.result` mark Harness pipeline stages for durable drill-down.
 */
export const EVENT_TYPES = [
  "run.started",
  "run.ended",
  "message",
  "phase",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.changed",
  "test.result",
  "approval.requested",
  "usage.updated",
  "limit.approaching",
  "limit.hit",
  "error",
  "checkpoint.created",
  "verification.result",
  "guard.decision",
  "recovery.decision",
] as const;

export type NormalizedEventType = (typeof EVENT_TYPES)[number];

export interface NormalizedEvent {
  runId: RunId;
  /** Monotonic per run; assigned by the orchestrator at ingestion. */
  seq?: number;
  ts: string; // ISO timestamp
  type: NormalizedEventType;
  /** Best-effort activity annotation. Display only — never an orchestration trigger. */
  phase?: ActivityPhase;
  /** One-line human-readable description for the timeline. */
  summary: string;
  /**
   * Normalized, type-specific detail. The wire shape stays a loose bag so
   * adapters and persisted rows need no migration; `EventPayloads[T]` below is
   * the per-type contract the adapter conformance suite (§12) pins, and
   * `payloadOf` is the checked accessor.
   */
  payload?: Record<string, unknown>;
  /** Original provider payload. Normalization is lossy; deletion is not. */
  raw?: unknown;
}

/** A `NormalizedEvent` narrowed to one type, with its payload contract applied. */
export type TypedNormalizedEvent<T extends NormalizedEventType = NormalizedEventType> =
  Omit<NormalizedEvent, "type" | "payload"> & { type: T; payload?: EventPayloads[T] };

/** Read an event's payload under its per-type contract. */
export function payloadOf<T extends NormalizedEventType>(
  event: NormalizedEvent & { type: T },
): EventPayloads[T] | undefined {
  return event.payload as EventPayloads[T] | undefined;
}

/** Payload shape for usage.updated / limit.approaching / limit.hit events. */
export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  /** Quota window state when the provider reports it (e.g. Codex rate_limits). */
  quota?: {
    window: string; // e.g. "5h", "weekly"
    usedPercent: number;
    resetsAt?: string;
  }[];
}

/** Payload for `checkpoint.created` — the durable anchor a handoff derives from. */
export interface CheckpointCreatedPayload {
  checkpointId: string;
  gitRef?: string;
  reason: "limit" | "handoff" | "cancel" | "completion" | "periodic" | "soft-limit";
  committed: boolean;
}

/** Verification check kinds — mirrors `VerificationSpec.kind` (kept local to avoid a core import cycle). */
export type VerificationKind =
  | "tests"
  | "typecheck"
  | "lint"
  | "command"
  | "artifact_exists"
  | "evaluator"
  | "api"
  | "browser"
  | "review";

export type VerificationCheckStatus = "passed" | "failed" | "skipped" | "blocked";

/** Shared result shape for durable events and the terminal execution result. */
interface VerificationCheckResultBase {
  /** Stable planner id; absent on legacy results. */
  checkId?: string;
  name: string;
  kind: VerificationKind;
  required: boolean;
  summary: string;
  ref?: string;
}

/** TypeScript construction prevents contradictions; runtime wire validation follows in H5. */
export type VerificationCheckResult = VerificationCheckResultBase &
  (
    | { status?: undefined; passed: boolean }
    | { status: "passed"; passed: true }
    | { status: Exclude<VerificationCheckStatus, "passed">; passed: false }
  );

/** Derive the aggregate; required skipped/blocked/failed checks never pass. */
export function verificationPassed(checks: readonly VerificationCheckResult[]): boolean {
  return checks.every((check) =>
    !check.required ? true : check.status === undefined ? check.passed : check.status === "passed",
  );
}

/** Payload for `verification.result` — the aggregate of one `VerificationSpec[]` run. */
export interface VerificationResultPayload {
  passed: boolean;
  checks: VerificationCheckResult[];
}

/**
 * Payload for `guard.decision` — audit trail of a guard directive. The directive
 * itself is persisted durably in `guard_directives` (§4); this event is its
 * append-only witness in the timeline.
 */
export interface GuardDecisionPayload {
  guard: "budget" | "timeout" | "tool" | "approval" | "quota";
  directive: "continue" | "checkpoint" | "cancel" | "pause" | "yield";
  reason: string;
  /** Populated for cancel/yield directives. */
  failureKind?: string;
  yieldKind?: "reroute" | "handoff" | "limit";
}

export interface RunStartedPayload {
  providerSessionRef?: string;
  model?: string;
}

export interface RunEndedPayload {
  ok: boolean;
  reason?: string;
}

export interface MessagePayload {
  text?: string;
}

export interface PhasePayload {
  note?: string;
}

export interface ToolStartedPayload {
  toolUseId?: string;
  tool?: string;
  command?: string;
  input?: unknown;
}

export interface ToolCompletedPayload {
  toolUseId?: string;
  exitCode?: number;
}

export interface ToolFailedPayload {
  toolUseId?: string;
  exitCode?: number;
  error?: string;
}

export interface FileChangedPayload {
  path?: string;
  kind?: "create" | "update" | "delete";
  /** Adapters (Codex) report attempted-but-failed edits with `ok: false`. */
  ok?: boolean;
}

export interface TestResultPayload {
  passed?: number;
  failed?: number;
  command?: string;
  failures?: string[];
}

export interface ApprovalRequestedPayload {
  requestId: string;
  tool?: string;
  input?: unknown;
}

export interface ErrorEventPayload {
  message?: string;
  kind?: string;
}

/**
 * Payload for `recovery.decision` — an append-only witness of what boot
 * reconcile / the lease sweeper / directive replay / approval settlement did to
 * a session after a crash (§9). Durable so Cockpit can tell "orphaned" from
 * "resume offered" from "held".
 */
export interface RecoveryDecisionPayload {
  action:
    | "resume_offered"
    | "orphaned"
    | "completed_from_verifying"
    | "directive_replayed"
    | "directive_failed"
    | "approval_ack_confirmed"
    | "approval_delivery_held"
    | "lease_taken_over";
  detail?: string;
}

/**
 * Per-type payload contract for the whole closed event set (§2 — "every event
 * type gets a typed payload interface in `packages/core`"). The wire shape on
 * `NormalizedEvent.payload` stays a loose bag for migration-free persistence;
 * the adapter conformance suite (§12) pins each adapter's output against this
 * map, and `payloadOf` / `TypedNormalizedEvent` are the checked read paths.
 */
export interface EventPayloads {
  "run.started": RunStartedPayload;
  "run.ended": RunEndedPayload;
  message: MessagePayload;
  phase: PhasePayload;
  "tool.started": ToolStartedPayload;
  "tool.completed": ToolCompletedPayload;
  "tool.failed": ToolFailedPayload;
  "file.changed": FileChangedPayload;
  "test.result": TestResultPayload;
  "approval.requested": ApprovalRequestedPayload;
  "usage.updated": UsagePayload;
  "limit.approaching": UsagePayload;
  "limit.hit": UsagePayload;
  error: ErrorEventPayload;
  "checkpoint.created": CheckpointCreatedPayload;
  "verification.result": VerificationResultPayload;
  "guard.decision": GuardDecisionPayload;
  "recovery.decision": RecoveryDecisionPayload;
}

/** Compile-time proof `EventPayloads` has an entry for every event type. */
export type EventPayloadKeysComplete = Exclude<NormalizedEventType, keyof EventPayloads> extends never
  ? true
  : never;
const _eventPayloadsComplete: EventPayloadKeysComplete = true;
void _eventPayloadsComplete;
