import type { TaskEvent, TaskWait } from "./api.js";

/** Presentation vocabulary only; this does not extend the kernel state machine. */
export function describeState(state: string, pauseKind?: string | null) {
  const states: Record<
    string,
    { label: string; reason: string; tone: string }
  > = {
    CREATED: {
      label: "Ready to route",
      reason: "Created; no execution has started.",
      tone: "neutral",
    },
    ROUTING: {
      label: "Choosing environment",
      reason: "The control plane evaluates eligible assistants.",
      tone: "active",
    },
    RUNNING: {
      label: "Running",
      reason: "Execution is in progress.",
      tone: "active",
    },
    WAITING_RESOURCE: {
      label: "Scheduler wait",
      reason:
        "The scheduler owns this task (K1/K2). It holds a durable wait condition and wakes at the next eligible time; a quota wait revalidates provider evidence before it re-routes.",
      tone: "resource",
    },
    WAITING_INPUT: {
      label: "Needs you",
      reason: "A human decision is required. This is not a scheduler wait.",
      tone: "human",
    },
    LIMIT_PAUSED: {
      label: "Limit paused",
      reason:
        "Execution hit a provider limit. K2 checkpoints the run and parks it as a scheduler quota wait; if the wake budget is exhausted it lands here for an operator decision.",
      tone: "limit",
    },
    HANDING_OFF: {
      label: "Handing off",
      reason: "Control is transferring between execution environments.",
      tone: "handoff",
    },
    COMPLETED: {
      label: "Completed",
      reason: "The task is complete.",
      tone: "complete",
    },
    FAILED: {
      label: "Failed",
      reason: "Execution ended in failure. Inspect events and verification.",
      tone: "failed",
    },
    CANCELLED: {
      label: "Cancelled",
      reason: "The task was cancelled.",
      tone: "neutral",
    },
  };
  const pauses: Record<string, string> = {
    approval_pending: "Approval required",
    verification_failed: "Verification decision",
    comparison_pending: "Comparison decision",
    handoff_requested: "Handoff decision",
    limit: "Limit — operator decision",
    intervention_required: "Intervention required",
    no_candidate: "No eligible assistant",
  };
  const value = states[state] ?? {
    label: state,
    reason: "Unrecognized state reported by the API.",
    tone: "neutral",
  };
  return state === "WAITING_INPUT" && pauseKind && pauses[pauseKind]
    ? { ...value, label: pauses[pauseKind]! }
    : value;
}

/** Human label for a durable wait condition's kind (K1 time vs K2 quota). */
export function waitKindLabel(wait: Pick<TaskWait, "kind">): string {
  return wait.kind === "quota"
    ? "Quota wait · K2"
    : wait.kind === "time"
      ? "Time wait · K1"
      : `Wait · ${wait.kind}`;
}

/** Coarse freshness bucket for an idle quota probe attempt age (K3). */
export function probeFreshness(ageMs: number): "live" | "recent" | "stale" {
  if (ageMs < 5 * 60_000) return "live";
  if (ageMs < 20 * 60_000) return "recent";
  return "stale";
}

/** Resolve only from this run's persisted provider start evidence, never discovery/catalog aliases. */
export function observedModel(
  events: TaskEvent[],
  runId: string | undefined,
): string {
  if (!runId) return "Unknown";
  const start = events.find(
    (e) =>
      e.run_id === runId &&
      e.type === "run.started" &&
      typeof e.payload?.model === "string",
  );
  return typeof start?.payload?.model === "string"
    ? start.payload.model
    : "Unknown";
}

export interface ContextView {
  occupancyTokens?: number;
  effectiveWindowTokens?: number;
  advertisedMaxTokens?: number;
  occupancySource: "provider-reported" | "estimated" | "unavailable";
  freshness: "live" | "stale" | "unavailable";
  observedAt?: string;
  estimator?: { name: string; version: string };
}
export function contextPercent(observation: ContextView): number | undefined {
  const { occupancyTokens: used, effectiveWindowTokens: capacity } =
    observation;
  return observation.freshness === "live" &&
    observation.occupancySource !== "unavailable" &&
    used !== undefined &&
    Number.isFinite(used) &&
    used >= 0 &&
    capacity !== undefined &&
    Number.isFinite(capacity) &&
    capacity > 0
    ? Math.round((used / capacity) * 100)
    : undefined;
}
