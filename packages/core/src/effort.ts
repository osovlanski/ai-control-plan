/**
 * P1-5: reasoning effort as part of an execution's identity, and the effort a
 * routing profile would choose for a task.
 *
 * Effort is identity, not a knob shared across vendors (auto-copilot plan
 * §D.4). Each harness has its own ladder, and a level is only ever compared
 * with the same level on the same ladder: Claude `high` and Codex `high` are
 * never treated as equal. A run's effort is what the PROVIDER reported on its
 * own `run.started` event; a run that reported none has effort
 * {@link EFFORT_UNKNOWN}, which is its own cohort value and never matches an
 * effort-specific cohort or an effort-tagged benchmark row.
 *
 * Pure: no I/O, no clock.
 */
import type { RoutingProfile } from "./task.js";
import type { TaskClassification } from "./model-selection.js";

/** The cohort value of a run whose provider reported no effort. Never a wildcard. */
export const EFFORT_UNKNOWN = "unknown";

/** Version of the profile → effort rule below. Bump on any change to it or to a ladder. */
export const EFFORT_CHOICE_VERSION = "effort-choice-v1";

/** Ladder ids, one per harness that has an effort setting. */
export type EffortLadderId = "claude-code" | "codex";

/**
 * Each harness's own effort vocabulary, lowest first. Names are the harness's,
 * not a shared scale: positions on two ladders are not comparable.
 */
export const EFFORT_LADDERS: Readonly<Record<EffortLadderId, readonly string[]>> = Object.freeze({
  "claude-code": Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  codex: Object.freeze(["minimal", "low", "medium", "high", "xhigh"]),
});

/**
 * A provider-reported effort, normalized for storage: trimmed, lower-case, a
 * short token. Anything else is not evidence and is dropped (the run keeps
 * effort unknown rather than holding a guess).
 */
export function normalizeReportedEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(v) || v === EFFORT_UNKNOWN) return undefined;
  return v;
}

/** What one assistant would run this task at, and why. Shadow: nothing passes it to a provider. */
export interface EffortChoice {
  assistantId: string;
  /** The ladder the level belongs to. Absent when the assistant's harness has none. */
  ladder?: EffortLadderId;
  /** The chosen level on `ladder`. Absent when nothing can be chosen. */
  effort?: string;
  /** How the level was reached: the profile's rule, a workspace pin, or none. */
  basis: "profile-rule" | "workspace-config" | "no-ladder";
  reason: string;
}

export interface EffortPlan {
  version: typeof EFFORT_CHOICE_VERSION;
  /**
   * Always `shadow`: no adapter is handed an effort by the plane from this plan.
   * It is recorded so an audit can compare what the profile would choose with
   * what each run reported.
   */
  mode: "shadow";
  profile: RoutingProfile;
  /** The level name the profile rule picked before it was placed on each ladder. */
  level: "low" | "medium" | "high";
  rule: string;
  choices: EffortChoice[];
}

/**
 * The profile → level rule, `effort-choice-v1`. Every level it can name is on
 * both ladders, so placing it never needs a cross-ladder equivalence.
 *
 *  - `best-quality` → high
 *  - `fastest`, `lowest-tokens`, `preserve-quota` → low
 *  - `auto` → from the task's own weights: coding ≥ 0.55 → high; speed or cost
 *    the largest weight → low; otherwise medium.
 */
export function effortLevelFor(
  profile: RoutingProfile,
  classification: Pick<TaskClassification, "weights">,
): { level: EffortPlan["level"]; rule: string } {
  switch (profile) {
    case "best-quality":
      return { level: "high", rule: "profile best-quality → high" };
    case "fastest":
    case "lowest-tokens":
    case "preserve-quota":
      return { level: "low", rule: `profile ${profile} → low` };
    default: {
      const w = classification.weights;
      if (w.coding >= 0.55) return { level: "high", rule: `profile auto, coding weight ${w.coding.toFixed(2)} ≥ 0.55 → high` };
      if (w.speed > w.coding || w.cost > w.coding) {
        return { level: "low", rule: `profile auto, ${w.speed >= w.cost ? "speed" : "cost"} outweighs coding → low` };
      }
      return { level: "medium", rule: `profile auto, coding weight ${w.coding.toFixed(2)} < 0.55 and largest → medium` };
    }
  }
}

/**
 * The effort one assistant would get. `pinned` is a level the workspace config
 * already hands that assistant's adapter (OpenRouter's `reasoningEffort`): the
 * plan reports the pin and does not pretend a profile could move it.
 */
export function chooseEffort(input: {
  assistantId: string;
  ladder?: EffortLadderId;
  level: EffortPlan["level"];
  pinned?: string;
}): EffortChoice {
  if (input.pinned !== undefined) {
    return {
      assistantId: input.assistantId,
      ...(input.ladder ? { ladder: input.ladder } : {}),
      effort: input.pinned,
      basis: "workspace-config",
      reason: `the workspace config pins this assistant's effort to ${input.pinned}; a profile does not move it`,
    };
  }
  if (!input.ladder) {
    return {
      assistantId: input.assistantId,
      basis: "no-ladder",
      reason: "this assistant's harness has no effort ladder the plane knows, so no effort is chosen",
    };
  }
  const ladder = EFFORT_LADDERS[input.ladder];
  if (!ladder.includes(input.level)) {
    return {
      assistantId: input.assistantId,
      ladder: input.ladder,
      basis: "no-ladder",
      reason: `level ${input.level} is not on the ${input.ladder} ladder`,
    };
  }
  return {
    assistantId: input.assistantId,
    ladder: input.ladder,
    effort: input.level,
    basis: "profile-rule",
    reason: `${input.level} on the ${input.ladder} ladder (${ladder.join(" < ")})`,
  };
}
