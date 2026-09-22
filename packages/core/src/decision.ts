/**
 * M16 Decision Service — domain types and the always-present rules provider
 * (plan `plans/jev-decision-service-plan.md` §4.1, K17).
 *
 * Pure, no I/O. The kernel never imports a vendor SDK here — a hosted
 * decision vendor (Jev/TypeSafe) or a structured-output model call is a
 * separate `DecisionProvider` implementation behind this interface, added in
 * a later slice. This file is never allowed to depend on `@agent-plane/api`:
 * `RulesDecisionProvider` reproduces today's guard/classifier/context-guard
 * behaviour by porting their pure logic verbatim (I-D6 — one vendor is never
 * the only implementation, and rules is always compiled in and reachable).
 */
import type { ContextCapability, ContextObservation, ContextPolicy } from "./context.js";
import { CONTEXT_STALE_MS } from "./context.js";

/** The three System One primitives, transcribed. */
export type DecisionQuestion =
  | { kind: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { kind: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { kind: "score"; instructions: string; criteria: readonly string[] };

export type DecisionAnswer =
  | { kind: "noul"; value: number } // P(true), 0..1
  | { kind: "choice"; value: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "score"; value: string; probabilities: Record<string, number>; confidence: number };

/**
 * Named call site. K17 gives `RulesDecisionProvider` an exact mapping for
 * these three; a site with no mapping is a hard error (I-D2 — fail closed),
 * never a silent invented answer.
 */
export type DecisionSite = "tool-gate" | "task-classifier" | "context-breakpoint";

/**
 * Redacted, bounded, fenced state (§4.4 `DecisionStateBuilder`, not built in
 * K17). A JSON object with named fields, per site's own field contract —
 * documented next to `RulesDecisionProvider`'s per-site handlers below.
 */
export type DecisionState = Record<string, unknown>;

export interface DecisionRequest {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  site: DecisionSite;
  budgetMs: number;
}

export interface DecisionOutcome {
  answers: Record<string, DecisionAnswer>;
  provider: "typesafe" | "model" | "rules";
  /** Model identity as the provider reported it, never as we assumed it (K7 discipline). */
  modelReported?: string;
  latencyMs: number;
  /** Set whenever the primary provider did not answer. Names the reason, never the secret. */
  degraded?: { from: "typesafe" | "model"; reason: string };
}

/** Reachability, limits, egress class — what `describe()` reports about a provider. */
export interface DecisionCapability {
  reachable: boolean;
  /** `local` = no bytes leave the process. `byo-account` = an already-authorized
   *  provider account. `third-party` = a new vendor relationship (I-D7). */
  egress: "local" | "byo-account" | "third-party";
  limits?: { maxStateChars?: number; requestsPerMinute?: number };
}

export interface DecisionProvider {
  readonly id: "typesafe" | "model" | "rules";
  describe(): DecisionCapability;
  decide(req: DecisionRequest): Promise<DecisionOutcome>;
}

const CHOICE_ANSWER = (value: string, criteria: readonly string[]): DecisionAnswer => {
  const probabilities: Record<string, number> = {};
  for (const c of criteria) probabilities[c] = c === value ? 1 : 0;
  return { kind: "choice", value, probabilities, confidence: 1 };
};

const SCORE_ANSWER = (value: string, criteria: readonly string[]): DecisionAnswer => {
  const probabilities: Record<string, number> = {};
  for (const c of criteria) probabilities[c] = c === value ? 1 : 0;
  return { kind: "score", value, probabilities, confidence: 1 };
};

const TASK_CLASSIFIER_LABELS = ["coding", "review", "research", "general"] as const;
const CONTEXT_BREAKPOINT_ACTIONS = ["continue", "warn", "yield"] as const;

/**
 * Verbatim port of `classifyGoal()` — apps/api/src/modules/telemetry.ts:360-366.
 * Same regexes, same precedence, same fallback. Any drift here IS a behaviour
 * change and must not happen silently.
 */
function classifyGoalRules(goal: string): (typeof TASK_CLASSIFIER_LABELS)[number] {
  const text = goal.toLowerCase();
  if (/\breview|audit|critique\b/.test(text)) return "review";
  if (/\bfix|implement|refactor|add|bug|test|build|migrate\b/.test(text)) return "coding";
  if (/\bresearch|investigate|compare|explain|why\b/.test(text)) return "research";
  return "general";
}

/**
 * Verbatim port of the `denied` computation in `toolPolicyGuard()` —
 * apps/api/src/modules/harness/guards.ts:143-145.
 */
function toolDeniedRules(name: string, tools: { allow?: readonly string[]; deny?: readonly string[] }): boolean {
  return (
    (tools.deny?.some((d) => name.includes(d)) ?? false) ||
    (tools.allow !== undefined && !tools.allow.some((a) => name.includes(a)))
  );
}

export interface ContextBreakpointState {
  policy: ContextPolicy;
  capability?: ContextCapability;
  observation?: ContextObservation;
  observedAtMs?: number;
  lastCompactionAtMs?: number;
  nowMs: number;
  staleAfterMs?: number;
}

/**
 * Verbatim port of `evaluateContextGuard()`'s action classification —
 * apps/api/src/modules/harness/context-guard.ts:55-109. Same branches, same
 * order, same thresholds; only the loggable `reason` string is dropped, since
 * `DecisionAnswer` (Score) carries no field for it.
 */
function contextBreakpointAction(input: ContextBreakpointState): (typeof CONTEXT_BREAKPOINT_ACTIONS)[number] {
  const { policy, capability, observation, nowMs } = input;
  const staleAfterMs = input.staleAfterMs ?? CONTEXT_STALE_MS;

  if (!capability || capability.occupancy === "unavailable") return "continue";
  if (!observation) return "continue";
  if (observation.pressure === undefined) return "continue";

  const observedAtMs = input.observedAtMs ?? Date.parse(observation.observedAt);
  const ageMs = Number.isFinite(observedAtMs) ? nowMs - observedAtMs : Number.POSITIVE_INFINITY;
  if (observation.freshness !== "live" || ageMs > staleAfterMs) return "continue";

  if (input.lastCompactionAtMs !== undefined && input.lastCompactionAtMs > observedAtMs) return "continue";

  const pressure = observation.pressure;
  if (pressure >= policy.criticalRatio) {
    if (capability.compact === "provider-command") return "continue";
    return "yield";
  }
  if (pressure >= policy.warnRatio) return "warn";
  return "continue";
}

/**
 * The default and fallback provider (I-D6) — never makes a network call,
 * never imports a vendor SDK. Reproduces today's regex/threshold behaviour
 * exactly, so installing the `DecisionService` with this provider selected
 * changes nothing observable (K17 done-when).
 */
export class RulesDecisionProvider implements DecisionProvider {
  readonly id = "rules" as const;

  describe(): DecisionCapability {
    return { reachable: true, egress: "local" };
  }

  async decide(req: DecisionRequest): Promise<DecisionOutcome> {
    const startedMs = Date.now();
    const answers: Record<string, DecisionAnswer> = {};
    for (const [key, question] of Object.entries(req.questions)) {
      answers[key] = this.answer(req.site, req.state, question);
    }
    return { answers, provider: "rules", latencyMs: Date.now() - startedMs };
  }

  private answer(site: DecisionSite, state: DecisionState, question: DecisionQuestion): DecisionAnswer {
    switch (site) {
      case "task-classifier": {
        assertKind(question, "choice", site);
        const goal = typeof state.goal === "string" ? state.goal : "";
        return CHOICE_ANSWER(classifyGoalRules(goal), TASK_CLASSIFIER_LABELS);
      }
      case "tool-gate": {
        assertKind(question, "noul", site);
        const name = typeof state.toolName === "string" ? state.toolName : "";
        const allow = Array.isArray(state.toolsAllow) ? (state.toolsAllow as string[]) : undefined;
        const deny = Array.isArray(state.toolsDeny) ? (state.toolsDeny as string[]) : undefined;
        return { kind: "noul", value: toolDeniedRules(name, { allow, deny }) ? 1 : 0 };
      }
      case "context-breakpoint": {
        assertKind(question, "score", site);
        const action = contextBreakpointAction(state as unknown as ContextBreakpointState);
        return SCORE_ANSWER(action, CONTEXT_BREAKPOINT_ACTIONS);
      }
      default: {
        // Exhaustiveness guard — a new site with no rules mapping yet fails
        // loud rather than inventing an answer (I-D2).
        const exhaustive: never = site;
        throw new Error(`RulesDecisionProvider has no mapping for site ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function assertKind(question: DecisionQuestion, kind: DecisionQuestion["kind"], site: DecisionSite): void {
  if (question.kind !== kind) {
    throw new Error(`RulesDecisionProvider: site "${site}" answers with a "${kind}" question, got "${question.kind}"`);
  }
}
