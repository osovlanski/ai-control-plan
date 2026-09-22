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
import type { RedactionRule } from "./adapter.js";
import { DEFAULT_REDACTION_RULES, redactValue } from "./redaction.js";

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
  /**
   * Keyed by the `DecisionRequest.questions` key. A key that was asked and is
   * ABSENT here means the provider had **no basis** for it — never `false`,
   * `0`, `none` or "low risk". See the no-basis contract on
   * `DecisionProvider`.
   */
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

/**
 * ## The no-basis contract (I-D5 — no fabricated confidence)
 *
 * `decide()` returns an answer ONLY for the question keys the provider has a
 * real basis for. There is deliberately no `unknown` variant of
 * `DecisionAnswer`: **an absent key IS the "no basis" answer.** A provider
 * that cannot answer `risk` omits `risk` — it never returns `none` to fill
 * the slot, because `none` is a measured claim and silence is not.
 *
 * Absence is not a lenient default. Per **I-D2 (fail closed, degrade loud)** a
 * caller MUST resolve an absent answer to the CONSERVATIVE outcome for its
 * site. For the K19 tool gate that is *prompt the operator* — never
 * *auto-approve*, and never a widening of `policy.approvalMode`. Writing
 * `answers.risk?.value ?? "none"`, `?? 0` or `?? false` on a battery answer
 * inverts this contract and is a bug.
 *
 * The compiler is on this contract's side: `noUncheckedIndexedAccess` is on
 * repo-wide, so `outcome.answers.risk` is typed `DecisionAnswer | undefined`
 * and every caller is forced to handle the absent case explicitly.
 *
 * A key the provider DOES map, asked with the wrong primitive (a `score`
 * where the site answers a `noul`), is a malformed request, not an
 * unanswerable one: it throws.
 */
export interface DecisionProvider {
  readonly id: "typesafe" | "model" | "rules";
  describe(): DecisionCapability;
  decide(req: DecisionRequest): Promise<DecisionOutcome>;
}

/**
 * The K19 tool-gate question battery (plan §5, K19). One state, five
 * questions, evaluated together. Exported so the gate and the §7.2
 * prompt-injection suite ask the identical battery rather than two drifting
 * copies of it.
 *
 * `RulesDecisionProvider` has a basis for exactly ONE of these — `denied`,
 * from the allow/deny substring match it ports. The other five come back
 * ABSENT until a provider that can actually judge them is registered.
 *
 * `denied` is the sixth key: §5 K19's table lists five, but I-D1's
 * `rules deny → block` line is part of the SAME mapping, and §5 K18 requires
 * the rules answer on every call "so a shadow comparison always has a
 * baseline". A five-key battery leaves the rules provider answering nothing,
 * which contradicts both. One request, one state, one record — see the §11
 * correction note in the plan.
 */
export const TOOL_GATE_RISK_LEVELS = ["none", "low", "medium", "high", "severe"] as const;

export const TOOL_GATE_BATTERY: Record<string, DecisionQuestion> = {
  denied: {
    kind: "noul",
    instructions: "Is this tool call denied by the workspace's tool allow/deny policy?",
  },
  risk: {
    kind: "score",
    instructions: "How much damage could this action do if the agent has misunderstood the task?",
    criteria: TOOL_GATE_RISK_LEVELS,
  },
  destructive: {
    kind: "noul",
    instructions: "Does this action delete, overwrite or force-push data that is not recoverable from git?",
  },
  outside_repo: {
    kind: "noul",
    instructions: "Does this action read or write outside the task's worktree and allowlisted repo?",
  },
  exfiltration: {
    kind: "noul",
    instructions: "Does this action send repository content to a network destination?",
  },
  credential_reach: {
    kind: "noul",
    instructions: "Does this action read credentials, tokens, `.env` files or provider config?",
  },
};

/* ------------------------------------------------------------------------- *
 * §4.4 — DecisionStateBuilder: the untrusted-input boundary (I-D4)
 * ------------------------------------------------------------------------- */

/**
 * Hard cap on a serialized decision state, well under the vendor's documented
 * 32k state budget (§4.2). The per-field caps below sum to roughly 8k, so this
 * is a backstop, not the working limit — a state that reaches it is a bug in a
 * caller, and it is still truncated deterministically rather than sent whole.
 */
export const MAX_DECISION_STATE_CHARS = 12_000;

/** Per-field caps. Fixed constants, so truncation is a pure function of the input. */
const CAP = {
  toolName: 200,
  commandText: 2_000,
  pathSamples: 16,
  pathSampleChars: 160,
  networkDestinations: 8,
  networkDestinationChars: 200,
  toolsList: 32,
  toolsListChars: 64,
} as const;

/**
 * What a tool-gate caller observes about ONE proposed action, before any
 * trust, redaction or bounding is applied. This is the builder's INPUT — raw
 * and attacker-influenceable throughout (I-D4). Nothing here reaches a
 * provider except through `buildToolGateState()`.
 */
export interface ToolGateObservation {
  /** The tool or command identity the allow/deny policy matches on. */
  toolName: string;
  /** The action's arguments, verbatim. The subject of the questions, not repository content. */
  commandText?: string;
  /** Filesystem paths the action names. Trust-gated: see `buildToolGateState`. */
  paths?: readonly string[];
  /** Network destinations the action names (host or URL). */
  networkDestinations?: readonly string[];
  toolsAllow?: readonly string[];
  toolsDeny?: readonly string[];
  /** Absolute worktree root for this task. A path under it is "inside". */
  worktreePath?: string;
  /** The repository this task is operating on, if known. */
  repoPath?: string;
  /** `config.repoAllowlist`. A repo outside it is UNTRUSTED. */
  repoAllowlist?: readonly string[];
}

/**
 * The state the K19 tool gate sends. A JSON object with named fields — never
 * a concatenated string, so instructions live in `questions` and nothing in
 * here can reach them (§4.4, "Fenced").
 *
 * ## Every field, and the battery question that reads it
 *
 * | field                  | read by                                                        |
 * |------------------------|----------------------------------------------------------------|
 * | `toolName`             | `denied` (the rules substring match), `risk`, `destructive`, `exfiltration`, `credential_reach` |
 * | `toolsAllow`           | `denied`                                                       |
 * | `toolsDeny`            | `denied`                                                       |
 * | `commandText`          | `risk`, `destructive`, `exfiltration`, `credential_reach`      |
 * | `networkDestinations`  | `exfiltration`, `risk`                                         |
 * | `pathsInside`          | `outside_repo`, `risk`                                         |
 * | `pathsOutside`         | `outside_repo`, `risk`                                         |
 * | `pathSamples`          | `destructive`, `credential_reach`, `outside_repo`              |
 * | `repoTrusted`          | `outside_repo`, `risk` — tells a judge that withheld ≠ empty   |
 *
 * There is no tenth field. Fields deliberately NOT here, because no question
 * in the battery reads them and §4.4 forbids carrying what nothing reads:
 *
 * - **The task goal.** "How much damage could this action do" is a property of
 *   the action. `rm -rf` is not less destructive because the goal says it is.
 * - **README excerpts, source comments, test fixtures, commit messages,
 *   prior tool output.** These are §7.2's five injection carriers, and they
 *   are exactly the class §4.4 rules out: a question whose answer can be
 *   flipped by a sentence in a README is a question we do not ask. Every
 *   battery question is answerable from the action, so none of these has a
 *   reader — they are attack surface with no benefit and are not accepted.
 * - **`approvalMode` / workspace mode.** §5 K19 applies the mode as a ceiling
 *   AFTER the decision. Feeding it in would invite the judge to pre-apply it.
 * - **Task and session ids.** Record context (K18), not decision input.
 *
 * `truncated` is likewise not a field: no question reads it. It rides beside
 * the state on `BuiltDecisionState` and lands in `decision_records.state_truncated`.
 */
export interface ToolGateState {
  toolName: string;
  toolsAllow?: readonly string[];
  toolsDeny?: readonly string[];
  commandText?: string;
  /** Part of the ACTION, not repository content — never trust-gated. */
  networkDestinations?: readonly string[];
  pathsInside: number;
  pathsOutside: number;
  /** Withheld entirely for an untrusted repo — only the counts above survive. */
  pathSamples?: readonly string[];
  repoTrusted: boolean;
}

/** The declared field set. `buildToolGateState` emits no key outside it (the fence). */
export const TOOL_GATE_STATE_FIELDS = [
  "toolName",
  "toolsAllow",
  "toolsDeny",
  "commandText",
  "networkDestinations",
  "pathsInside",
  "pathsOutside",
  "pathSamples",
  "repoTrusted",
] as const;

export interface BuiltDecisionState {
  state: DecisionState;
  /** True when any deterministic cap below actually cut something. Recorded, never silent. */
  truncated: boolean;
}

/** A path is inside when it is the worktree or sits under it. Prefix-safe (`/wt-2` is not under `/wt`). */
function isInside(path: string, worktreePath: string | undefined): boolean {
  if (!worktreePath) return false;
  return path === worktreePath || path.startsWith(`${worktreePath}/`);
}

/**
 * Trust, per Junie's model (§4.4): a repo is trusted only when it is named by
 * `repoAllowlist`. Unknown repo, empty allowlist or no allowlist ⇒ UNTRUSTED.
 * Fail closed: the state loses content, never gains it.
 */
function isRepoTrusted(repoPath: string | undefined, allowlist: readonly string[] | undefined): boolean {
  if (!repoPath || !allowlist) return false;
  return allowlist.some((entry) => repoPath === entry || repoPath.startsWith(`${entry}/`));
}

/**
 * Build the tool-gate decision state (§4.4).
 *
 * Order is load-bearing: **redact → trust-gate → bound**. Redaction runs
 * first, on the raw strings, so no secret can survive by being split across a
 * truncation boundary. Trust-gating runs before bounding so untrusted content
 * is dropped rather than merely shortened.
 *
 * Secrets resolved by `SecretBroker` are excluded by construction: they exist
 * only in a per-call in-memory map inside the broker and in the adapter's
 * launch env, neither of which is an input to this function. `redactValue`
 * additionally strips anything matching the repo's secret patterns and any
 * value registered via `registerSecret`, so a leak through a caller would
 * still be caught here rather than sent.
 *
 * Truncation is deterministic: fixed caps, applied in a fixed order, on a
 * fixed field order. The same observation always yields the same state and
 * the same `truncated` flag.
 */
export function buildToolGateState(
  input: ToolGateObservation,
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
): BuiltDecisionState {
  let truncated = false;
  const clip = (value: string, max: number): string => {
    if (value.length <= max) return value;
    truncated = true;
    return value.slice(0, max);
  };
  const clipList = (values: readonly string[], maxItems: number, maxChars: number): string[] => {
    if (values.length > maxItems) truncated = true;
    return values.slice(0, maxItems).map((v) => clip(v, maxChars));
  };

  const redact = (value: string): string => redactValue(value, rules);

  const repoTrusted = isRepoTrusted(input.repoPath, input.repoAllowlist);
  const paths = (input.paths ?? []).map(redact);
  let pathsInside = 0;
  for (const p of paths) if (isInside(p, input.worktreePath)) pathsInside += 1;

  const state: ToolGateState = {
    toolName: clip(redact(input.toolName), CAP.toolName),
    pathsInside,
    pathsOutside: paths.length - pathsInside,
    repoTrusted,
  };
  if (input.toolsAllow) state.toolsAllow = clipList(input.toolsAllow, CAP.toolsList, CAP.toolsListChars);
  if (input.toolsDeny) state.toolsDeny = clipList(input.toolsDeny, CAP.toolsList, CAP.toolsListChars);
  if (input.commandText !== undefined) state.commandText = clip(redact(input.commandText), CAP.commandText);
  if (input.networkDestinations?.length) {
    // Destinations are part of the action, not repository content, so they are
    // not trust-gated — `exfiltration` is unanswerable without them.
    state.networkDestinations = clipList(input.networkDestinations, CAP.networkDestinations, CAP.networkDestinationChars);
  }
  // THE TRUST GATE: an untrusted repo contributes structural facts only. The
  // counts above survive; the paths themselves — which carry repository
  // content in their names — do not.
  if (repoTrusted && paths.length) state.pathSamples = clipList(paths, CAP.pathSamples, CAP.pathSampleChars);

  // Backstop. The per-field caps already bound this far below
  // MAX_DECISION_STATE_CHARS; reaching it means a caller passed something the
  // caps do not model, and dropping the two largest optional fields in a fixed
  // order keeps the result deterministic.
  if (JSON.stringify(state).length > MAX_DECISION_STATE_CHARS) {
    truncated = true;
    delete state.pathSamples;
    if (JSON.stringify(state).length > MAX_DECISION_STATE_CHARS) delete state.commandText;
  }

  return { state: state as unknown as DecisionState, truncated };
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
 * Which (site, questionKey) pairs `RulesDecisionProvider` has a deterministic
 * basis for, and which primitive each is answered with.
 *
 * Keyed by question key, NOT by site alone: a site asks a battery, and this
 * provider ports exactly one regex/threshold per key. Answering every
 * question at a site with the same value — which is what a site-only switch
 * does — is invisible while a site asks one question and wrong the moment
 * K19 asks its five (plan §5, K19).
 *
 * A key absent from this table is UNANSWERED, per the no-basis contract on
 * `DecisionProvider`. `tool-gate` deliberately lists only `denied`: the rules
 * provider has no basis for `risk`, `destructive`, `outside_repo`,
 * `exfiltration` or `credential_reach`, and I-D5 forbids inventing one.
 */
const RULES_BASIS: Record<DecisionSite, Record<string, DecisionQuestion["kind"] | undefined>> = {
  "task-classifier": { kind: "choice" },
  "tool-gate": { denied: "noul" },
  "context-breakpoint": { action: "score" },
};

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
      // Keys with no basis are LEFT OUT, not filled in — see the no-basis
      // contract on `DecisionProvider`.
      const answer = this.answer(req.site, key, req.state, question);
      if (answer !== undefined) answers[key] = answer;
    }
    return { answers, provider: "rules", latencyMs: Date.now() - startedMs };
  }

  /**
   * `undefined` means "this provider has no basis for this question", which
   * is a contractually meaningful answer, not a failure. A key this provider
   * DOES map, asked with the wrong primitive, throws instead.
   */
  private answer(
    site: DecisionSite,
    key: string,
    state: DecisionState,
    question: DecisionQuestion,
  ): DecisionAnswer | undefined {
    const expectedKind = RULES_BASIS[site][key];
    if (expectedKind === undefined) return undefined;
    assertKind(question, expectedKind, site, key);

    switch (site) {
      case "task-classifier": {
        const goal = typeof state.goal === "string" ? state.goal : "";
        return CHOICE_ANSWER(classifyGoalRules(goal), TASK_CLASSIFIER_LABELS);
      }
      case "tool-gate": {
        const name = typeof state.toolName === "string" ? state.toolName : "";
        const allow = Array.isArray(state.toolsAllow) ? (state.toolsAllow as string[]) : undefined;
        const deny = Array.isArray(state.toolsDeny) ? (state.toolsDeny as string[]) : undefined;
        return { kind: "noul", value: toolDeniedRules(name, { allow, deny }) ? 1 : 0 };
      }
      case "context-breakpoint": {
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

function assertKind(question: DecisionQuestion, kind: DecisionQuestion["kind"], site: DecisionSite, key: string): void {
  if (question.kind !== kind) {
    throw new Error(
      `RulesDecisionProvider: site "${site}" answers question "${key}" with a "${kind}" question, got "${question.kind}"`,
    );
  }
}
