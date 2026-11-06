/**
 * M6 S4 shadow score, formula `asset-shadow/v1` (docs/agentic-os-m6-composition-telemetry.md §4).
 *
 * Pure, under the Composer purity lint rule: no clock, no env, no I/O. The api reads the ledger
 * rows and passes the window in. Nothing here enters a decision, a spec, `compositionDigest` or
 * `inputs_digest`: the api calls it only after the attempt row exists, and only logs what it says.
 *
 * Per asset `(id, digest)` and cohort `(task_kind, harness)`:
 *   - sample: sessions whose outcome is success or error (neutral and not_run say nothing, I-M4);
 *   - baseline `p = (s + 1) / (n + 2)` over sample sessions where the asset was not attached;
 *   - group `I` (attached, invoked ≥ 1): `r = (s_I + k·p) / (n_I + k)`, i.e. `w·(s_I/n_I) + (1 − w)·p`
 *     with K13's `w(n) = n / (n + k)`, `k = 10`; lift `= r − p`, exactly 0 with no evidence;
 *   - control: the same lift for "attached, invoked 0";
 *   - where invocation is not observable only the attached lift exists: `attached_only`, never ranks;
 *   - the same again on `verification_passed`, among sample sessions that ran a verification.
 *
 * The shadow rank is stage 3's order with one change: within equal matched-tag counts, ties break
 * by lift (`tool_event` lifts only; any other counts as 0) before id. It reorders only candidates
 * that passed every filter, so it cannot choose a filtered asset; the result audits that anyway.
 */
import type { AssetInvocationMethod, AssetSessionOutcome, AssetUsageKind } from "./asset-telemetry.js";
import type { CompositionDecisionDraft, ComposerInputs } from "./composer/types.js";
import { byCodeUnit, sortedUnique } from "./composer/explain.js";
import { DEFAULT_MAX_MCP_SERVERS } from "./composer/assets.js";
import { telemetryWeight } from "./model-selection.js";

export const ASSET_SHADOW_FORMULA = "asset-shadow/v1";
/** K13's coding `k` (Q4). */
export const ASSET_SHADOW_K = 10;
/** The routing telemetry window (Q4). */
export const ASSET_SHADOW_WINDOW_DAYS = 30;

/** One `asset_usage` row with its task's kind, as the api reads it. */
export interface AssetShadowObservation {
  sessionId: string;
  taskKind: string;
  harness: string;
  assetKind: AssetUsageKind;
  assetId: string;
  assetDigest: string;
  attached: boolean;
  invocationMethod: AssetInvocationMethod;
  /** NULL = not observable, which is not 0. */
  invocationCount: number | null;
  sessionOutcome: AssetSessionOutcome;
  verificationPassed: boolean | null;
  /** The session's `execution_results.at`. */
  at: string;
}

/** ISO-8601 UTC bounds, both inclusive. Compared as strings, which orders ISO `Z` timestamps. */
export interface AssetShadowWindow { start: string; end: string }

export type AssetShadowMethod = "tool_event" | "attached_only";

export interface ShadowBaseline {
  n: number;
  s: number;
  /** `(s + 1) / (n + 2)`. */
  p: number;
}

export interface ShadowGroup {
  n: number;
  s: number;
  /** `s / n`, or null when `n = 0`. */
  rate: number | null;
  w: number;
  /** `(s + k·p) / (n + k)`. */
  smoothed: number;
  lift: number;
}

export interface ShadowLift {
  baseline: ShadowBaseline;
  /** `tool_event`: attached and invoked ≥ 1. `attached_only`: attached. */
  group: ShadowGroup;
  /** Attached and invoked 0; null for `attached_only`. */
  control: ShadowGroup | null;
  /** The control has evidence and does at least as well as the group: the group's lift is noise. */
  noise: boolean;
}

export interface AssetCohortScore {
  assetKind: AssetUsageKind;
  assetId: string;
  assetDigest: string;
  taskKind: string;
  harness: string;
  method: AssetShadowMethod;
  outcome: ShadowLift;
  verification: ShadowLift;
  /** What the shadow rank reads: the outcome lift for `tool_event`, 0 otherwise. */
  rankingLift: number;
}

/** Pooled across cohorts, weighted by the group's `n`. Shown, never ranked. */
export interface AssetPooledScore {
  assetKind: AssetUsageKind;
  assetId: string;
  /** Absent for the per-id pool across digests (Q3). */
  assetDigest?: string;
  n: number;
  lift: number;
  cohorts: number;
}

export interface AssetScores {
  formula: typeof ASSET_SHADOW_FORMULA;
  k: number;
  window: AssetShadowWindow;
  /** Distinct sessions inside the window, and why some are not in the sample. */
  sessions: { inWindow: number; sample: number; neutral: number; notRun: number };
  cohorts: AssetCohortScore[];
  pooled: AssetPooledScore[];
  pooledById: AssetPooledScore[];
}

interface Session {
  id: string;
  taskKind: string;
  harness: string;
  outcome: AssetSessionOutcome;
  verificationPassed: boolean | null;
  assets: Map<string, AssetShadowObservation>;
}

const assetKey = (o: Pick<AssetShadowObservation, "assetKind" | "assetId" | "assetDigest">) => `${o.assetKind}\u0000${o.assetId}\u0000${o.assetDigest}`;
const cohortKey = (taskKind: string, harness: string) => `${taskKind}\u0000${harness}`;

/** The order every list here is in, so equal inputs give equal outputs whatever the row order. */
const byObservation = (a: AssetShadowObservation, b: AssetShadowObservation) =>
  byCodeUnit(a.sessionId, b.sessionId) || byCodeUnit(a.assetKind, b.assetKind) || byCodeUnit(a.assetId, b.assetId) || byCodeUnit(a.assetDigest, b.assetDigest);

export function shadowBaseline(n: number, s: number): ShadowBaseline {
  return { n, s, p: (s + 1) / (n + 2) };
}

export function shadowGroup(n: number, s: number, p: number, k = ASSET_SHADOW_K): ShadowGroup {
  const smoothed = (s + k * p) / (n + k);
  return { n, s, rate: n > 0 ? s / n : null, w: telemetryWeight(n, k), smoothed, lift: n > 0 ? smoothed - p : 0 };
}

function liftOf(
  sessions: readonly Session[],
  key: string,
  method: AssetShadowMethod,
  succeeded: (s: Session) => boolean,
  k: number,
): ShadowLift {
  const attachedRow = (s: Session) => {
    const row = s.assets.get(key);
    return row?.attached ? row : undefined;
  };
  const tally = (list: readonly Session[]) => ({ n: list.length, s: list.filter(succeeded).length });
  const base = tally(sessions.filter((s) => !attachedRow(s)));
  const baseline = shadowBaseline(base.n, base.s);
  const attached = sessions.filter((s) => attachedRow(s) !== undefined);
  if (method === "attached_only") {
    const g = tally(attached);
    return { baseline, group: shadowGroup(g.n, g.s, baseline.p, k), control: null, noise: false };
  }
  const invoked = tally(attached.filter((s) => (attachedRow(s)!.invocationCount ?? 0) >= 1));
  const idle = tally(attached.filter((s) => attachedRow(s)!.invocationCount === 0));
  const group = shadowGroup(invoked.n, invoked.s, baseline.p, k);
  const control = shadowGroup(idle.n, idle.s, baseline.p, k);
  return { baseline, group, control, noise: group.n > 0 && control.n > 0 && control.lift >= group.lift };
}

/** The §4.1 table: one score per asset per cohort, plus the pools. */
export function scoreAssets(observations: readonly AssetShadowObservation[], window: AssetShadowWindow, k = ASSET_SHADOW_K): AssetScores {
  const inWindow = [...observations].filter((o) => o.at >= window.start && o.at <= window.end).sort(byObservation);
  const sessions = new Map<string, Session>();
  for (const o of inWindow) {
    let s = sessions.get(o.sessionId);
    if (!s) {
      s = { id: o.sessionId, taskKind: o.taskKind, harness: o.harness, outcome: o.sessionOutcome, verificationPassed: o.verificationPassed, assets: new Map() };
      sessions.set(o.sessionId, s);
    }
    const key = assetKey(o);
    if (!s.assets.has(key)) s.assets.set(key, o);
  }
  const all = [...sessions.values()];
  const sample = all.filter((s) => s.outcome === "success" || s.outcome === "error");

  const cohorts = new Map<string, Session[]>();
  for (const s of sample) {
    const key = cohortKey(s.taskKind, s.harness);
    cohorts.set(key, [...(cohorts.get(key) ?? []), s]);
  }

  const scores: AssetCohortScore[] = [];
  for (const key of [...cohorts.keys()].sort(byCodeUnit)) {
    const members = cohorts.get(key)!;
    const { taskKind, harness } = members[0]!;
    const assets = new Map<string, AssetShadowObservation>();
    for (const s of members) for (const [k2, row] of s.assets) if (!assets.has(k2)) assets.set(k2, row);
    for (const aKey of [...assets.keys()].sort(byCodeUnit)) {
      const a = assets.get(aKey)!;
      const attachedRows = members.map((s) => s.assets.get(aKey)).filter((r): r is AssetShadowObservation => r?.attached === true);
      // Invocation is observable only if every attached row observed it.
      const method: AssetShadowMethod = attachedRows.every((r) => r.invocationMethod === "tool_event") ? "tool_event" : "attached_only";
      const outcome = liftOf(members, aKey, method, (s) => s.outcome === "success", k);
      const verification = liftOf(members.filter((s) => s.verificationPassed !== null), aKey, method, (s) => s.verificationPassed === true, k);
      scores.push({
        assetKind: a.assetKind, assetId: a.assetId, assetDigest: a.assetDigest, taskKind, harness, method, outcome, verification,
        rankingLift: method === "tool_event" ? outcome.group.lift : 0,
      });
    }
  }

  return {
    formula: ASSET_SHADOW_FORMULA,
    k,
    window: { ...window },
    sessions: {
      inWindow: all.length,
      sample: sample.length,
      neutral: all.filter((s) => s.outcome === "neutral").length,
      notRun: all.filter((s) => s.outcome === "not_run").length,
    },
    cohorts: scores,
    pooled: pool(scores, true),
    pooledById: pool(scores, false),
  };
}

function pool(scores: readonly AssetCohortScore[], byDigest: boolean): AssetPooledScore[] {
  const groups = new Map<string, AssetCohortScore[]>();
  for (const s of scores) {
    const key = byDigest ? assetKey(s) : `${s.assetKind}\u0000${s.assetId}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.keys()].sort(byCodeUnit).map((key) => {
    const list = groups.get(key)!;
    const n = list.reduce((t, s) => t + s.outcome.group.n, 0);
    const weighted = list.reduce((t, s) => t + s.outcome.group.n * s.outcome.group.lift, 0);
    const first = list[0]!;
    return {
      assetKind: first.assetKind, assetId: first.assetId, ...(byDigest ? { assetDigest: first.assetDigest } : {}),
      n, lift: n > 0 ? weighted / n : 0, cohorts: list.length,
    };
  });
}

// ---- shadow rank -------------------------------------------------------------

/** A candidate that passed every hard filter of stage 3. */
export interface ShadowCandidate {
  id: string;
  digest: string;
  kind: "skill" | "mcp_server";
  /** Tags matched with the intent's kind and domains: stage 3's score. */
  matched: number;
  conflicts: readonly string[];
}

export interface ShadowCaps { maxSkills: number; maxMcpServers: number }

/** Stage 3's ranking filters: what a lift may reorder. Every other filter removed a candidate for good. */
export const SHADOW_RANKING_FILTERS: ReadonlySet<string> = new Set(["no_tag_match", "conflict", "over_max_skills", "over_max_mcp_servers"]);

/**
 * Stage 3's loop (score = matched tags, conflicts and the per-kind caps after), with ties on the
 * score broken by `lift` before id. With every lift 0 it is stage 3's order exactly.
 */
export function shadowChoice(candidates: readonly ShadowCandidate[], caps: ShadowCaps, lift: (c: ShadowCandidate) => number): string[] {
  const ranked = [...candidates].sort((a, b) => b.matched - a.matched || lift(b) - lift(a) || byCodeUnit(a.id, b.id));
  const chosen: ShadowCandidate[] = [];
  const conflicts = (a: ShadowCandidate, b: ShadowCandidate) => a.conflicts.includes(b.id) || b.conflicts.includes(a.id);
  for (const c of ranked) {
    if (c.matched === 0) continue;
    if (chosen.some((x) => conflicts(x, c))) continue;
    const ofKind = chosen.filter((x) => x.kind === c.kind).length;
    if (ofKind >= (c.kind === "skill" ? caps.maxSkills : caps.maxMcpServers)) continue;
    chosen.push(c);
  }
  return sortedUnique(chosen.map((c) => c.id));
}

/** What stage 3 saw, rebuilt from its own decision and the inputs it ran on. */
export interface ShadowView {
  candidates: ShadowCandidate[];
  /** Ids a hard filter (or the renderer) removed: never eligible for the shadow. */
  filtered: string[];
  /** Stage 3's computed choice, before an operator `add`/`remove`. */
  actual: string[];
  caps: ShadowCaps;
  /** The operator overrode stage 3; both choices are compared before it applies. */
  overridden: boolean;
}

const positive = (v: number | undefined, fallback: number) => {
  const x = v ?? fallback;
  return Number.isSafeInteger(x) && x > 0 ? x : 0;
};

/**
 * Rebuilds stage 3's eligible set from the decision: candidates not removed by a hard filter, with
 * their matched-tag count from the intent stage's chosen `kind:`/`domain:` refs and the registry
 * snapshot the pipeline read. Returns undefined when the pipeline never reached stage 3.
 */
export function shadowView(decision: CompositionDecisionDraft, inputs: Pick<ComposerInputs, "registry" | "config">): ShadowView | undefined {
  const stage = (name: string) => decision.stages.find((s) => s.stage === name);
  const harnessModel = stage("harness_model");
  const assets = stage("assets");
  const intent = stage("intent");
  if (!harnessModel?.chosen.length || !assets || !intent) return undefined;
  const wanted = new Set(intent.chosen.flatMap((ref) => {
    const m = /^(kind|domain):(.+)$/.exec(ref);
    return m ? [m[2]!] : [];
  }));
  const filtered = new Set(assets.filters.filter((f) => !SHADOW_RANKING_FILTERS.has(f.filter)).flatMap((f) => f.removed));
  const registry = inputs.registry.status === "ok" ? inputs.registry.assets : [];
  const candidates: ShadowCandidate[] = [];
  for (const c of assets.candidates) {
    if (filtered.has(c.ref)) continue;
    const asset = registry.find((a) => a.id === c.ref && a.digest === c.digest);
    if (!asset || (asset.kind !== "skill" && asset.kind !== "mcp_server")) { filtered.add(c.ref); continue; }
    candidates.push({
      id: asset.id, digest: asset.digest, kind: asset.kind,
      matched: new Set(asset.tags.filter((t) => wanted.has(t))).size,
      conflicts: [...asset.conflicts],
    });
  }
  candidates.sort((a, b) => byCodeUnit(a.id, b.id));
  return {
    candidates,
    filtered: sortedUnique(filtered),
    actual: sortedUnique(assets.override ? assets.override.from : assets.chosen),
    caps: { maxSkills: positive(inputs.config.maxSkills, 0), maxMcpServers: positive(inputs.config.maxMcpServers, DEFAULT_MAX_MCP_SERVERS) },
    overridden: assets.override !== null && assets.override !== undefined,
  };
}

export interface ShadowCandidateScore {
  id: string;
  digest: string;
  kind: "skill" | "mcp_server";
  matched: number;
  /** The lift the rank read: 0 unless the method is `tool_event`. */
  lift: number;
  method: AssetShadowMethod | "no_evidence";
  n: number;
  w: number;
}

export type AssetShadowResult =
  | {
    status: "scored";
    formula: typeof ASSET_SHADOW_FORMULA;
    actual: string[];
    shadow: string[];
    wouldDiffer: boolean;
    /** Shadow choices a hard filter removed. 0 by construction; audited like K13's no-filter-violations. */
    filterViolations: number;
    overridden: boolean;
    candidates: ShadowCandidateScore[];
  }
  /** The shadow's rebuild of stage 3 does not reproduce stage 3: no comparison would be honest. */
  | { status: "error"; formula: typeof ASSET_SHADOW_FORMULA; error: "rank_mismatch"; actual: string[] };

/** The shadow choice for one attempt, in its cohort. */
export function assetShadow(view: ShadowView, cohort: readonly AssetCohortScore[]): AssetShadowResult {
  const scoreOf = (c: ShadowCandidate) => cohort.find((s) => s.assetKind === c.kind && s.assetId === c.id && s.assetDigest === c.digest);
  const baseline = shadowChoice(view.candidates, view.caps, () => 0);
  if (!sameList(baseline, view.actual)) return { status: "error", formula: ASSET_SHADOW_FORMULA, error: "rank_mismatch", actual: view.actual };
  const lift = (c: ShadowCandidate) => scoreOf(c)?.rankingLift ?? 0;
  const shadow = shadowChoice(view.candidates, view.caps, lift);
  const filtered = new Set(view.filtered);
  return {
    status: "scored",
    formula: ASSET_SHADOW_FORMULA,
    actual: view.actual,
    shadow,
    wouldDiffer: !sameList(shadow, view.actual),
    filterViolations: shadow.filter((id) => filtered.has(id) || !view.candidates.some((c) => c.id === id)).length,
    overridden: view.overridden,
    candidates: view.candidates.map((c) => {
      const s = scoreOf(c);
      return {
        id: c.id, digest: c.digest, kind: c.kind, matched: c.matched, lift: lift(c),
        method: s ? s.method : "no_evidence", n: s ? s.outcome.group.n : 0, w: s ? s.outcome.group.w : 0,
      };
    }),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
