import type { RunId } from "./ids.js";
import type { ActivityPhase } from "./task.js";

/** Closed set of normalized event types, v1 (revised architecture §4). */
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
  /** Normalized, type-specific detail (typed per event type as adapters land in Phase 1). */
  payload?: Record<string, unknown>;
  /** Original provider payload. Normalization is lossy; deletion is not. */
  raw?: unknown;
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
