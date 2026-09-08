/**
 * M14 Context Lifecycle — observation model (kernel-services §4.3.1).
 *
 * K9 scope: OBSERVATION ONLY. Nothing here compacts, prunes, yields or starts a
 * clean-session continuation. "Unknown" / "unavailable" is a first-class value —
 * a percentage is never manufactured from unrelated token-accounting data.
 *
 * Token/cost ACCOUNTING (`UsagePayload`, `ExecutionResult.usage`, Codex per-turn
 * usage, quota `usage.updated`) is a separate stream and never feeds
 * `occupancyTokens`. A `usage.updated` that carries only quota produces no
 * observation.
 */
import type { ExecutionSessionId } from "./ids.js";

export type ContextOccupancySource = "provider-reported" | "estimated" | "unavailable";
export type ContextEffectiveWindowSource = "provider-reported" | "catalog" | "unavailable";
export type ContextFreshness = "live" | "stale" | "unavailable";

/**
 * Adapter manifest, `CapabilityManifest.context`. Honest tiers, like isolation.
 * A tier here represents ONLY proven provider behaviour — a `compact` control is
 * not claimed at K9 just because K10 intends to add one.
 */
export interface ContextCapability {
  occupancy: ContextOccupancySource;
  effectiveWindow: ContextEffectiveWindowSource;
  /** `provider-command` only once the adapter actually exposes a compaction call (K10). */
  compact: "provider-command" | "none";
  autoManagement: "provider" | "none";
  /** Free text for provider-specific mechanisms (e.g. Codex experimental context management, opt-in). */
  autoManagementDetail?: string;
  /** The adapter forwards provider auto-compaction boundaries as `context.compaction.observed`. */
  observesAutoCompaction: boolean;
}

/**
 * What an adapter's optional `observeContext` returns — a raw provider sample.
 * The Harness stamps `sessionId`, `sequence` and `observedAt` and derives
 * `pressure`/`freshness` via {@link buildContextObservation}.
 */
export interface AdapterContextSample {
  occupancyTokens?: number;
  occupancySource: ContextOccupancySource;
  /** Present only when `occupancySource === "estimated"`. */
  estimator?: { name: string; version: string };
  /** The window the provider actually manages against (e.g. Claude's resolved autocompaction window). */
  effectiveWindowTokens?: number;
  effectiveWindowSource?: ContextEffectiveWindowSource;
  /** The model's advertised maximum (`ModelUsage.contextWindow` / catalog). NOT the effective window. */
  advertisedMaxTokens?: number;
  breakdown?: Array<{ category: string; tokens: number }>;
}

/** Canonical observation (kernel-services §4.3.1). */
export interface ContextObservation {
  sessionId: ExecutionSessionId;
  observedAt: string;
  /** Monotonic per session. Recovery never fabricates one that did not occur. */
  sequence: number;
  occupancyTokens?: number;
  occupancySource: ContextOccupancySource;
  estimator?: { name: string; version: string };
  effectiveWindowTokens?: number;
  effectiveWindowSource: ContextEffectiveWindowSource;
  advertisedMaxTokens?: number;
  /** occupancy / effectiveWindow — undefined unless BOTH are known and fresh. May exceed 1. */
  pressure?: number;
  freshness: ContextFreshness;
  breakdown?: Array<{ category: string; tokens: number }>;
}

function finitePositive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Derive a canonical observation from a fresh provider sample.
 *
 * `pressure` is computed ONLY when occupancy is known AND a real effective
 * window is known. An unknown effective window yields occupancy tokens with no
 * percentage — never a ratio against the advertised maximum or an accounting
 * total.
 */
export function buildContextObservation(
  sample: AdapterContextSample,
  ctx: { sessionId: ExecutionSessionId | string; sequence: number; now: string },
): ContextObservation {
  const occ = finitePositive(sample.occupancyTokens);
  const win = finitePositive(sample.effectiveWindowTokens);
  const effectiveWindowSource: ContextEffectiveWindowSource =
    sample.effectiveWindowSource ?? (win !== undefined ? "provider-reported" : "unavailable");
  const occupancyKnown = sample.occupancySource !== "unavailable" && occ !== undefined;
  const windowKnown = win !== undefined && win > 0 && effectiveWindowSource !== "unavailable";
  const pressure = occupancyKnown && windowKnown ? Math.round((occ! / win!) * 10000) / 10000 : undefined;
  return {
    sessionId: ctx.sessionId as ExecutionSessionId,
    observedAt: ctx.now,
    sequence: ctx.sequence,
    occupancyTokens: occ,
    occupancySource: sample.occupancySource,
    estimator: sample.occupancySource === "estimated" ? sample.estimator : undefined,
    effectiveWindowTokens: win,
    effectiveWindowSource,
    advertisedMaxTokens: finitePositive(sample.advertisedMaxTokens),
    pressure,
    freshness: "live",
    breakdown: sample.breakdown && sample.breakdown.length > 0 ? sample.breakdown : undefined,
  };
}

// ---------------------------------------------------------------------------
// K11 — context policy and the context yield (kernel-services §4.3.2, §4.3.3)
// ---------------------------------------------------------------------------

/**
 * Thresholds and task-level bounds for the context guard.
 *
 * K11 implements the `criticalRatio` yield and the task-level bounds only.
 * `actRatio` belongs to K10 (provider-command compaction) and is carried here
 * as a declared threshold with no behaviour attached to it yet.
 */
export interface ContextPolicy {
  /** Gauge turns amber; eager checkpoint. Advisory at K11. */
  warnRatio: number;
  /** K10 compaction threshold. Declared, deliberately unimplemented at K11. */
  actRatio: number;
  /** Fresh pressure at or above this, with no usable compaction control, yields. */
  criticalRatio: number;
  /** Task-level (not session-level) continuation bound. */
  maxContinuationsPerTask: number;
  /** Consecutive continuations with no envelope progress before parking. */
  noProgressContinuationLimit: number;
  /** Unknown/stale observations never authorize an automatic continuation. */
  onUnknown: "warn-only";
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  warnRatio: 0.7,
  actRatio: 0.85,
  criticalRatio: 0.92,
  maxContinuationsPerTask: 3,
  noProgressContinuationLimit: 2,
  onUnknown: "warn-only",
};

/** An observation older than this is stale and can never authorize a yield. */
export const CONTEXT_STALE_MS = 45_000;

/**
 * Why a session yielded `context`. `critical_context_pressure` is the ordinary
 * K11 outcome; `successor_immediately_critical` is the safety stop when a clean
 * successor's FIRST fresh observation is already critical (§4.3.3).
 */
export type ContextYieldReason = "critical_context_pressure" | "successor_immediately_critical";

/**
 * `ExecutionResult.yield.detail` for `yield.kind === "context"`.
 *
 * A healthy lifecycle outcome, NOT a provider fault, a limit, a handoff or a
 * reroute — {@link isReliabilityFailure} keeps it out of reliability aggregates.
 * The Harness proposes no successor target (H-I1); the Control Plane decides.
 */
export interface ContextYieldRequest {
  sessionId: ExecutionSessionId;
  taskId: string;
  reason: ContextYieldReason;
  /** The checkpoint taken at the yield. Absent only when checkpointing failed. */
  checkpointId?: string;
  /** The continuation envelope committed in the terminal transaction. */
  envelopeId?: string;
  /** The fresh critical observation that authorized the yield. */
  observation: ContextObservation;
}
