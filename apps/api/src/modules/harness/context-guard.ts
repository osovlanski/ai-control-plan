/**
 * ContextGuard — the K11 half of the context policy (kernel-services §4.3.2).
 *
 * Pure: `(latest observation + capability + policy + clock) → decision`. It holds
 * no state, issues no directive of its own and never touches the provider. The
 * SessionRunner evaluates it immediately after it has recorded a fresh
 * `context.observed`, and only ever turns a `yield` decision into a terminal
 * plan.
 *
 * What this guard will NOT do, by construction:
 *
 * - act on token/cost ACCOUNTING, quota usage or an advertised model maximum —
 *   only on `ContextObservation.pressure`, which exists solely when occupancy
 *   AND a real effective window are both known;
 * - act on a stale observation, an unavailable occupancy or an unknown window
 *   (`onUnknown: "warn-only"`);
 * - infer that provider auto-compaction failed because time passed (CR-34) —
 *   only a LATER fresh observation that is still critical escalates;
 * - request a compaction, issue `/compact` or `/clear`. That is K10 and it is
 *   deliberately unimplemented: an adapter that declares
 *   `compact: "provider-command"` is left alone here rather than being yielded.
 */
import type { ContextCapability, ContextObservation, ContextPolicy } from "@agent-plane/core";
import { CONTEXT_STALE_MS } from "@agent-plane/core";

export type ContextGuardAction = "continue" | "warn" | "yield";

export interface ContextGuardDecision {
  action: ContextGuardAction;
  /** Truthful, loggable explanation — always present, including for `continue`. */
  reason: string;
  /** The pressure the decision was taken on, when one was known and fresh. */
  pressure?: number;
}

export interface ContextGuardInput {
  policy: ContextPolicy;
  capability?: ContextCapability;
  /** The most recent recorded observation for this session, if any. */
  observation?: ContextObservation;
  /** Wall-clock ms of that observation. */
  observedAtMs?: number;
  /** Wall-clock ms of the most recent `context.compaction.observed`, if any. */
  lastCompactionAtMs?: number;
  nowMs: number;
  staleAfterMs?: number;
}

const CONTINUE = (reason: string, pressure?: number): ContextGuardDecision => ({
  action: "continue",
  reason,
  pressure,
});

export function evaluateContextGuard(input: ContextGuardInput): ContextGuardDecision {
  const { policy, capability, observation, nowMs } = input;
  const staleAfterMs = input.staleAfterMs ?? CONTEXT_STALE_MS;

  if (!capability || capability.occupancy === "unavailable") {
    return CONTINUE("context occupancy unavailable for this provider");
  }
  if (!observation) return CONTINUE("no context observation recorded yet");

  // Occupancy without a real effective window is a token count, not a pressure.
  // An advertised model maximum is explicitly NOT a substitute (§4.3.1).
  if (observation.pressure === undefined) {
    return CONTINUE(
      observation.occupancyTokens === undefined
        ? "occupancy unknown"
        : "effective window unknown — occupancy tokens carry no pressure",
    );
  }

  const observedAtMs = input.observedAtMs ?? Date.parse(observation.observedAt);
  const ageMs = Number.isFinite(observedAtMs) ? nowMs - observedAtMs : Number.POSITIVE_INFINITY;
  if (observation.freshness !== "live" || ageMs > staleAfterMs) {
    return CONTINUE("observation is stale — a stale reading never authorizes a continuation");
  }

  // CR-34: the provider manages its own context first. A compaction observed
  // AFTER this observation means the relief has not been measured yet; wait for
  // the next fresh sample rather than assuming the mechanism failed.
  if (input.lastCompactionAtMs !== undefined && input.lastCompactionAtMs > observedAtMs) {
    return CONTINUE("provider auto-compaction observed — awaiting the post-compaction observation");
  }

  const pressure = observation.pressure;

  if (pressure >= policy.criticalRatio) {
    // K10 seam, inert on purpose: with a real compaction control the ladder is
    // compact-then-observe, and only an unrelieved result reaches K11.
    if (capability.compact === "provider-command") {
      return CONTINUE(
        `pressure ${fmt(pressure)} is critical but a provider compaction control is declared (K10 unimplemented)`,
        pressure,
      );
    }
    return {
      action: "yield",
      reason: `fresh context pressure ${fmt(pressure)} >= critical ${fmt(policy.criticalRatio)} with no compaction control`,
      pressure,
    };
  }

  if (pressure >= policy.warnRatio) {
    return { action: "warn", reason: `context pressure ${fmt(pressure)} above warn threshold`, pressure };
  }
  return CONTINUE(`context pressure ${fmt(pressure)} below warn threshold`, pressure);
}

function fmt(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
