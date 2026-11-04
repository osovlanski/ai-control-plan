/**
 * M7 view model for the composition views. Everything here formats what the plane published;
 * nothing recomputes a decision, a digest or a budget (apps/web AGENTS.md). Where a figure is
 * derived, the helper names how it was obtained, and a figure the plane did not supply stays
 * `unknown` rather than becoming a zero.
 */
import type { AgentSpec, AgentSpecDraft, ComposerStage, DecisionStage } from "@agent-plane/core";
import type { BudgetRunSettlement, CompositionBudget, CompositionHistory } from "./api.js";

/** How a number was obtained. `unknown` is a first-class answer, never rendered as 0. */
export type Method = "guessed" | "estimated" | "measured" | "unknown";

export const STAGE_LABELS: Record<ComposerStage, string> = {
  intent: "Intent",
  harness_model: "Harness & model",
  assets: "Assets",
  context: "Context",
  policy: "Policy & budget",
  confirm: "Confirm",
};

const SHA = /^sha256:([0-9a-f]{64})$/;

/** `sha256:` plus the first `n` hex digits. The full digest belongs in a `title`. */
export function shortDigest(digest: string | null | undefined, n = 12): string {
  if (!digest) return "unknown";
  const m = SHA.exec(digest);
  return m ? `sha256:${m[1]!.slice(0, n)}…` : digest;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtUsd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
export const fmtMs = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s` : `${ms} ms`);

export type StageState = "chosen" | "empty" | "not_run" | "awaiting";

/** `not run` is how the pipeline marks a stage it never reached (core `notRun`). */
export function stageState(stage: DecisionStage): StageState {
  if (/^not run/.test(stage.why)) return "not_run";
  if (stage.stage === "confirm" && stage.chosen.length === 0) return "awaiting";
  return stage.chosen.length ? "chosen" : "empty";
}

export interface ChosenRef { ref: string; digest?: string; evidence: string[] }

/** The chosen refs of a stage with the digest and evidence the stage recorded for each. */
export function chosenRefs(stage: DecisionStage): ChosenRef[] {
  const byRef = new Map(stage.candidates.map((c) => [c.ref, c]));
  return stage.chosen.map((ref) => {
    const c = byRef.get(ref);
    return { ref, ...(c?.digest ? { digest: c.digest } : {}), evidence: c?.evidence ?? [] };
  });
}

/** The candidates a stage considered but did not choose, with the filter (if any) that removed each. */
export function rejectedRefs(stage: DecisionStage): Array<{ ref: string; digest?: string; filter?: string; reason?: string }> {
  const chosen = new Set(stage.chosen);
  const removedBy = new Map<string, { filter: string; reason: string }>();
  for (const f of stage.filters) for (const ref of f.removed) if (!removedBy.has(ref)) removedBy.set(ref, { filter: f.filter, reason: f.reason });
  return stage.candidates.filter((c) => !chosen.has(c.ref)).map((c) => ({
    ref: c.ref,
    ...(c.digest ? { digest: c.digest } : {}),
    ...(removedBy.get(c.ref) ?? {}),
  }));
}

/** Ref prefix before the first `:`, for `kind:coding`, `max_tokens:2000`; the whole ref when there is none. */
export const refName = (ref: string) => (ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : ref);

// ---- the spec draft: what the composition would attach and enforce ----------------------------

export interface SpecRow { label: string; value: string; method?: Method; title?: string }

type Spec = AgentSpec | AgentSpecDraft;

/**
 * The rows of the "what this attaches" summary. Complexity and risk are rule outputs, not
 * measurements, so they carry `guessed`; the token figure is the compiler's own estimate.
 */
export function specRows(spec: Spec): SpecRow[] {
  const rows: SpecRow[] = [];
  rows.push({ label: "Harness", value: spec.harness });
  rows.push({
    label: "Model",
    value: spec.model.primary.id + (spec.model.fallbacks.length ? ` (fallbacks: ${spec.model.fallbacks.map((f) => f.id).join(", ")})` : ""),
  });
  rows.push({ label: "Intent", value: `${spec.intent.kind}${spec.intent.domains.length ? ` · ${spec.intent.domains.join(", ")}` : ""}` });
  rows.push({ label: "Complexity", value: spec.intent.complexity, method: "guessed", title: "a rule's label; the plane records no measured complexity" });
  rows.push({ label: "Risk", value: spec.intent.risk, method: "guessed", title: "keyword rules over the goal, not an assessment of the repository" });
  const c = spec.context.compiler;
  rows.push({
    label: "Context",
    value: `≈ ${fmtInt(c.tokens)} tokens at ${c.chars_per_token} chars/token`,
    method: c.token_method === "estimated" ? "estimated" : "unknown",
    title: "chars ÷ chars-per-token, not a tokenizer count",
  });
  rows.push({ label: "Permission", value: spec.policy.permission });
  rows.push({
    label: "Tool allowlist",
    value: spec.policy.tool_allowlist.length ? spec.policy.tool_allowlist.join(", ") : "none listed; the approval mode governs",
  });
  const b = spec.policy.budget;
  rows.push({ label: "Token cap", value: b.max_tokens !== undefined ? fmtInt(b.max_tokens) : "no cap set", title: "what remained of the task cap when this was composed" });
  rows.push({ label: "Cost cap", value: b.max_cost_usd !== undefined ? fmtUsd(b.max_cost_usd) : "no cap set", title: "what remained of the task cap when this was composed" });
  rows.push({ label: "Runtime cap", value: b.max_runtime_ms !== undefined ? `${fmtMs(b.max_runtime_ms)} per run` : "no cap set" });
  rows.push({
    label: "Provisioning",
    value: spec.provisioning.achieved
      ? `${spec.provisioning.achieved} (requested ${spec.provisioning.requested})`
      : `requested ${spec.provisioning.requested}; not achieved or not yet known`,
    ...(spec.provisioning.achieved ? {} : { method: "unknown" as const }),
  });
  return rows;
}

export interface AssetRow { kind: "skill" | "mcp server" | "subagent"; id: string; digest: string; allowlisted: boolean; optIn: boolean }

export function assetRows(spec: Spec): AssetRow[] {
  const row = (kind: AssetRow["kind"]) => (a: { id: string; digest: string; allowlisted: boolean; opt_in?: unknown }): AssetRow =>
    ({ kind, id: a.id, digest: a.digest, allowlisted: a.allowlisted, optIn: a.opt_in !== undefined });
  return [
    ...spec.assets.skills.map(row("skill")),
    ...spec.assets.mcp_servers.map(row("mcp server")),
    ...spec.assets.subagents.map(row("subagent")),
  ];
}

// ---- budget ----------------------------------------------------------------------------------

/** A displayed figure. No `method` means it is not a derived number (a cap that is not set, no runs yet). */
export interface Figure { text: string; method?: Method; note?: string }

/** A run whose tokens are 0 because its accounting mode reports none, not because it spent none. */
export const tokensUnreported = (r: BudgetRunSettlement) => r.accounting === "none" && r.tokens === 0 && r.recordCount === 0;

export function runTokens(r: BudgetRunSettlement): Figure {
  if (tokensUnreported(r)) return { text: "unknown", method: "unknown", note: "this assistant reports no usage accounting" };
  return { text: fmtInt(r.tokens), method: "measured", note: r.source === "records" ? `from ${r.recordCount} usage record(s)` : "from in-run usage" };
}

export function runCost(r: BudgetRunSettlement): Figure {
  if (r.cost.method === "unknown" || r.cost.usd === undefined) return { text: "unknown", method: "unknown", note: "no price evidence and no provider-reported cost" };
  return { text: fmtUsd(r.cost.usd), method: r.cost.method, ...(r.cost.basis ? { note: r.cost.basis } : {}) };
}

export interface BudgetLine { label: string; cap: string; consumed: Figure; remaining: Figure }

/**
 * Cap, consumed and remaining for tokens and cost. The remainder is the plane's, and where a run's
 * usage or cost is unknown the consumed figure is a lower bound and the remainder an upper bound, which
 * the figure says instead of printing a clean number.
 */
export function budgetLines(b: CompositionBudget): BudgetLine[] {
  const lines: BudgetLine[] = [];
  const noRuns = b.consumed.sessions === 0;
  const unreported = b.runs.filter(tokensUnreported).length;
  const allUnreported = !noRuns && unreported === b.runs.length;

  const tokenConsumed: Figure = noRuns
    ? { text: "no runs yet" }
    : allUnreported
      ? { text: "unknown", method: "unknown", note: "no run reported usage" }
      : unreported
        ? { text: `at least ${fmtInt(b.consumed.tokens)}`, method: "measured", note: `${unreported} run(s) report no usage` }
        : { text: fmtInt(b.consumed.tokens), method: "measured" };
  const tokenCap = b.caps.max_tokens;
  lines.push({
    label: "Tokens",
    cap: tokenCap !== undefined ? fmtInt(tokenCap) : "no cap set",
    consumed: tokenConsumed,
    remaining: tokenCap === undefined ? { text: "n/a", note: "no cap set" }
      : b.remaining.max_tokens === undefined ? { text: "unknown", method: "unknown" }
        : unreported ? { text: `at most ${fmtInt(b.remaining.max_tokens)}`, method: "measured", note: "runs that report no usage are not subtracted" }
          : { text: fmtInt(b.remaining.max_tokens), method: "measured" },
  });

  const unknownCost = b.consumed.unknownCostSessions;
  const costKnown = b.consumed.sessions - unknownCost;
  const method: Method = b.consumed.costMethod === "none" ? "unknown" : b.consumed.costMethod;
  const costConsumed: Figure = noRuns
    ? { text: "no runs yet" }
    : costKnown === 0
      ? { text: "unknown", method: "unknown", note: "no price evidence and no provider-reported cost" }
      : unknownCost
        ? { text: `at least ${fmtUsd(b.consumed.costUsd)}`, method: "estimated", note: `${unknownCost} session(s) of unknown cost` }
        : { text: fmtUsd(b.consumed.costUsd), method };
  const costCap = b.caps.max_cost_usd;
  lines.push({
    label: "Cost",
    cap: costCap !== undefined ? fmtUsd(costCap) : "no cap set",
    consumed: costConsumed,
    remaining: costCap === undefined ? { text: "n/a", note: "no cap set" }
      : b.remaining.max_cost_usd === undefined ? { text: "unknown", method: "unknown" }
        : unknownCost ? { text: `at most ${fmtUsd(b.remaining.max_cost_usd)}`, method: "estimated", note: "sessions of unknown cost are not subtracted" }
          : { text: fmtUsd(b.remaining.max_cost_usd), method },
  });
  return lines;
}

export function overrunText(o: CompositionBudget["overruns"][number]): string {
  const money = o.cap === "max_cost_usd";
  const f = (n: number) => (money ? fmtUsd(n) : fmtInt(n));
  return `${o.cap === "max_tokens" ? "Token" : "Cost"} cap ${f(o.capValue)} exceeded by ${f(o.amount)} (settled ${f(o.settled)}, ${o.source === "late" ? "found when a usage record arrived late" : "found when the run settled"}, ${money ? o.method : "tokens"})`;
}

// ---- which revision is bound -----------------------------------------------------------------

export interface BoundRevision {
  revision: CompositionHistory["revisions"][number];
  /** The runs that executed under it, oldest first. */
  runIds: string[];
}

/** Revisions in the order the runs bound them; the last one is the one the task executes under now. */
export function boundRevisions(history: CompositionHistory, runs: ReadonlyArray<{ id: string; compositionRevisionId?: string | null }>): BoundRevision[] {
  const byId = new Map(history.revisions.map((r) => [r.compositionRevisionId, r]));
  const order: string[] = [];
  const runsOf = new Map<string, string[]>();
  for (const run of runs) {
    const id = run.compositionRevisionId;
    if (!id) continue;
    if (!runsOf.has(id)) { runsOf.set(id, []); order.push(id); }
    runsOf.get(id)!.push(run.id);
  }
  return order.flatMap((id) => {
    const revision = byId.get(id);
    return revision ? [{ revision, runIds: runsOf.get(id)! }] : [];
  });
}

/** Revisions persisted for the task that no run has bound (a start that failed after persisting, say). */
export function unboundRevisions(history: CompositionHistory, bound: readonly BoundRevision[]): CompositionHistory["revisions"] {
  const taken = new Set(bound.map((b) => b.revision.compositionRevisionId));
  return history.revisions.filter((r) => !taken.has(r.compositionRevisionId));
}
