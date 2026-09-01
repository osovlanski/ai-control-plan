/**
 * Guards — pure policy functions `(snapshot, event | tick) → directive[]`
 * (execution-harness §4).
 *
 * Guards hold NO mutable state: the counters they read (token totals, last-event
 * time) live on the caller's snapshot, recomputed from persisted events on
 * recovery. The SessionRunner evaluates them in one fixed, declared order and
 * arbitrates the directives. A non-trivial directive is persisted with its
 * triggering event and replayed idempotently after a crash — that is the
 * runner's job, not the guard's.
 */
import type {
  ExecutionPolicy,
  FailureKind,
  NormalizedEvent,
  UsagePayload,
} from "@agent-plane/core";

export interface GuardSnapshot {
  policy: ExecutionPolicy;
  /** Wall-clock ms the session entered STARTING. */
  startedAtMs: number;
  /** Wall-clock ms of the most recent streamed event. */
  lastEventAtMs: number;
  /** Cumulative tokens observed so far (input + output), recomputed from events. */
  tokensSoFar: number;
  /** Cumulative cost so far, when a pricing table is configured. */
  costUsdSoFar?: number;
  /** Whether the eager soft-limit checkpoint has already been taken. */
  softCheckpointed: boolean;
  /** The adapter's declared accounting mode (`none` forbids bounded caps at Prepare). */
  accountingMode: "delta" | "cumulative" | "none";
  /** Soft-threshold percentage for the eager checkpoint (instance config). */
  softThresholdPct: number;
}

export type GuardTrigger =
  | { kind: "event"; event: NormalizedEvent; atMs: number }
  | { kind: "tick"; atMs: number };

export type GuardName = "budget" | "timeout" | "tool" | "approval" | "quota";
export type DirectiveAction = "continue" | "checkpoint" | "cancel" | "pause" | "yield";

export interface GuardDirective {
  guard: GuardName;
  action: DirectiveAction;
  reason: string;
  /** Present for `cancel`. */
  failure?: { kind: FailureKind; retryable: boolean };
  /** Present for `yield`. */
  yieldKind?: "reroute" | "handoff" | "limit";
}

const CONTINUE = (guard: GuardName): GuardDirective => ({ guard, action: "continue", reason: "ok" });

/** Fixed evaluation order (§4). */
export const GUARD_ORDER: GuardName[] = ["budget", "timeout", "tool", "approval", "quota"];

/** Priority for arbitration when several guards fire: higher wins. */
const ACTION_PRIORITY: Record<DirectiveAction, number> = {
  cancel: 4,
  yield: 3,
  pause: 2,
  checkpoint: 1,
  continue: 0,
};

/** Evaluate every guard in order and return the single winning directive. */
export function evaluateGuards(snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  const directives = [
    budgetGuard(snap, trigger),
    timeoutGuard(snap, trigger),
    toolPolicyGuard(snap, trigger),
    approvalGuard(snap, trigger),
    quotaGuard(snap, trigger),
  ];
  return directives.reduce((best, d) =>
    ACTION_PRIORITY[d.action] > ACTION_PRIORITY[best.action] ? d : best,
  );
}

export function budgetGuard(snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  const { budget } = snap.policy;
  const maxTokens = budget.maxTokens;
  if (maxTokens === undefined) return CONTINUE("budget");

  if (budget.enforcement === "bounded") {
    if (snap.tokensSoFar > maxTokens) {
      return {
        guard: "budget",
        action: "cancel",
        reason: `token budget exceeded: ${snap.tokensSoFar} > ${maxTokens}`,
        failure: { kind: "budget_exceeded", retryable: false },
      };
    }
  }
  // Soft threshold → eager checkpoint (both modes), once.
  if (
    !snap.softCheckpointed &&
    trigger.kind === "event" &&
    snap.tokensSoFar >= maxTokens * (snap.softThresholdPct / 100)
  ) {
    return {
      guard: "budget",
      action: "checkpoint",
      reason: `token usage crossed ${snap.softThresholdPct}% of the budget — checkpointing early`,
    };
  }
  return CONTINUE("budget");
}

export function timeoutGuard(snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  const { timeout } = snap.policy;
  const now = trigger.atMs;
  if (now - snap.startedAtMs >= timeout.hardMs) {
    return {
      guard: "timeout",
      action: "cancel",
      reason: `hard timeout: ${now - snap.startedAtMs}ms >= ${timeout.hardMs}ms`,
      failure: { kind: "timeout", retryable: true },
    };
  }
  if (timeout.idleMs !== undefined && now - snap.lastEventAtMs >= timeout.idleMs) {
    return {
      guard: "timeout",
      action: "cancel",
      reason: `idle timeout: ${now - snap.lastEventAtMs}ms >= ${timeout.idleMs}ms`,
      failure: { kind: "timeout", retryable: true },
    };
  }
  return CONTINUE("timeout");
}

export function toolPolicyGuard(snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  if (trigger.kind !== "event" || trigger.event.type !== "tool.started") return CONTINUE("tool");
  const tools = snap.policy.tools;
  const name =
    (trigger.event.payload as { tool?: string; command?: string } | undefined)?.tool ??
    (trigger.event.payload as { command?: string } | undefined)?.command ??
    trigger.event.summary;
  const denied =
    (tools.deny?.some((d) => name.includes(d)) ?? false) ||
    (tools.allow !== undefined && !tools.allow.some((a) => name.includes(a)));
  if (!denied) return CONTINUE("tool");
  // In preventive mode the adapter should already have blocked this pre-exec;
  // reaching the guard means either audit mode or a gate that failed — either
  // way the session ends, and the result records the actual enforcement tier.
  return {
    guard: "tool",
    action: "cancel",
    reason: `tool "${name}" is denied by policy (mode: ${tools.mode})`,
    failure: { kind: "tool_denied", retryable: false },
  };
}

export function approvalGuard(_snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  if (trigger.kind === "event" && trigger.event.type === "approval.requested") {
    return { guard: "approval", action: "pause", reason: "provider requested an approval" };
  }
  return CONTINUE("approval");
}

export function quotaGuard(_snap: GuardSnapshot, trigger: GuardTrigger): GuardDirective {
  if (trigger.kind !== "event") return CONTINUE("quota");
  if (trigger.event.type === "limit.approaching") {
    return { guard: "quota", action: "checkpoint", reason: "provider limit approaching — checkpointing early" };
  }
  if (trigger.event.type === "limit.hit") {
    return {
      guard: "quota",
      action: "yield",
      reason: trigger.event.summary || "provider hard limit hit",
      yieldKind: "limit",
    };
  }
  return CONTINUE("quota");
}

/** Cumulative token total from a usage payload, respecting the accounting mode. */
export function accumulateTokens(
  prior: number,
  payload: UsagePayload | undefined,
  mode: "delta" | "cumulative" | "none",
): number {
  if (!payload || mode === "none") return prior;
  const observed = (payload.inputTokens ?? 0) + (payload.outputTokens ?? 0);
  return mode === "cumulative" ? Math.max(prior, observed) : prior + observed;
}
