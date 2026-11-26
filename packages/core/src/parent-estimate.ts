/**
 * Parent-task estimate: the sum of its subtasks plus measured overhead (qcq-06, slice S2).
 *
 * ADVISORY ONLY and PURE. Nothing here reads a database, dispatches, reserves, defers or enforces
 * anything; the api (slice S3) reads durable records, calls these functions and serves the answer.
 * `run-estimate/1` is untouched: each child's figure is the existing `RunEstimate`, passed in.
 * Design and owner decisions: docs/agentic-os-qcq-06-plan.md (sections 4, 5.1, 8).
 *
 * - Overhead is measured from the runs a task needed beyond its first one, classified once each
 *   (`classifyExtraRuns`): a handoff, a retry, or neither. Planning is not observable for an
 *   operator-authored decomposition and is reported as not applicable, never as zero.
 * - A part with no evidence is `null` with a reason. A total that depends on such a part is `null`
 *   and names it (plan Q7); a partial total is never presented as the total.
 * - Sums are sums of quartiles (p25, p50, p75 each), not quartiles of a sum.
 */
import { quartiles, type BillingKind, type EstimateConfidence, type EstimateRange, type RunEstimate } from "./run-estimate.js";

export const PARENT_ESTIMATOR_VERSION = "parent-estimate/1";

const MIN_TASKS = 3;
const HIGH_TASKS = 8;
const MAX_TASKS = 50;
const RANK: Record<EstimateConfidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const lowest = (...c: EstimateConfidence[]): EstimateConfidence =>
  c.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "high" as EstimateConfidence);

/* ----------------------------------------------------------------- history -- */

/** One run of a historical task, as the api reads it back from durable records. */
export interface HistoricalTaskRun {
  runId: string;
  state: string;
  startedAt: string;
  /** Null while the run is live. */
  endedAt: string | null;
  /** Settled tokens, or null when the run has no usage evidence at all. */
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  /** Harness `origin.kind` of the run's request; null for a legacy run, which has none. */
  originKind: "fresh" | "resume" | "handoff" | null;
  /** `handoffs.trigger` of the row whose `to_run_id` is this run, if any. */
  handoffTrigger: string | null;
}

/** One completed or interrupted Harness verification run of a task's session. */
export interface HistoricalVerificationRun {
  id: string;
  state: "ready" | "claimed" | "completed" | "interrupted";
  claimedAt: string | null;
  updatedAt: string;
}

export interface HistoricalTask {
  taskId: string;
  /** Assistant of the task's first run. */
  assistantId: string;
  taskKind: string | null;
  mode: "single" | "compare" | "race";
  runs: HistoricalTaskRun[];
  /** Empty for a legacy task. */
  verificationRuns: HistoricalVerificationRun[];
}

export type ExtraRunClass = "handoff" | "retry" | "other";

export interface ExtraRun {
  runId: string;
  class: ExtraRunClass;
  durationMs: number;
  /** Wall time between the predecessor's end and this run's start (the task waited). */
  gapMs: number;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
}

/** Triggers that mark a deliberate continuation of the task. `failure` is a retry and is not here. */
const HANDOFF_TRIGGERS: ReadonlySet<string> = new Set(["manual", "quota", "harness", "context", "wake"]);

const ms = (iso: string | null): number => (iso === null ? NaN : Date.parse(iso));
const orderedRuns = (t: HistoricalTask): HistoricalTaskRun[] =>
  [...t.runs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

/**
 * Every run after the first, classified once by the first rule that matches:
 * 1. handoff: a handoff row with a non-failure trigger, or Harness `origin.kind` `handoff`
 *    without a `failure` trigger (an explicit failure row is stronger evidence than the origin);
 * 2. retry: a `failure` handoff row, or the previous run ended `ENDED_ERROR` and this run is
 *    `fresh` or `resume`;
 * 3. other: anything else (for example an operator restart after `ENDED_OK`).
 * Compare and race tasks have extra runs by design: they return nothing.
 */
export function classifyExtraRuns(task: HistoricalTask): ExtraRun[] {
  if (task.mode !== "single") return [];
  const runs = orderedRuns(task);
  const out: ExtraRun[] = [];
  for (let i = 1; i < runs.length; i++) {
    const run = runs[i]!, prev = runs[i - 1]!;
    const trigger = run.handoffTrigger;
    let cls: ExtraRunClass = "other";
    if ((trigger !== null && HANDOFF_TRIGGERS.has(trigger)) || (run.originKind === "handoff" && trigger !== "failure")) cls = "handoff";
    else if (trigger === "failure" || (prev.state === "ENDED_ERROR" && (run.originKind === "fresh" || run.originKind === "resume"))) cls = "retry";
    const duration = ms(run.endedAt) - ms(run.startedAt);
    const gap = ms(run.startedAt) - ms(prev.endedAt);
    out.push({
      runId: run.runId, class: cls,
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
      gapMs: Number.isFinite(gap) && gap > 0 ? gap : 0,
      tokens: run.tokens, costUsd: run.costUsd,
    });
  }
  return out;
}

/** Ended, not cancelled, single-mode, with every run finished by `asOf`. */
function endedBefore(t: HistoricalTask, asOfMs: number): number | undefined {
  if (t.mode !== "single" || !t.runs.length) return undefined;
  const runs = orderedRuns(t);
  if (runs.some((r) => !Number.isFinite(ms(r.endedAt)) || !Number.isFinite(ms(r.startedAt)))) return undefined;
  if (runs[runs.length - 1]!.state === "CANCELLED") return undefined;
  const end = Math.max(...runs.map((r) => ms(r.endedAt)));
  return end <= asOfMs ? end : undefined;
}

export type TaskCohortLevel = "assistant+kind" | "assistant" | "none";

/**
 * The comparable tasks for a child: ended before `asOf` (no look-ahead), narrowest level first
 * (same assistant and kind, then assistant). A level needs MIN_TASKS tasks; failing both, the
 * narrowest non-empty one is used. The MAX_TASKS most recently ended are kept.
 */
export function selectTaskCohort(
  subject: { assistantId: string | null; taskKind: string | null },
  history: readonly HistoricalTask[],
  asOf: string,
): { level: TaskCohortLevel; tasks: HistoricalTask[] } {
  if (!subject.assistantId) return { level: "none", tasks: [] };
  const asOfMs = Date.parse(asOf);
  const ended = history
    .map((t) => ({ t, end: endedBefore(t, asOfMs) }))
    .filter((x): x is { t: HistoricalTask; end: number } => x.end !== undefined && x.t.assistantId === subject.assistantId);
  const recent = (xs: typeof ended) =>
    [...xs].sort((a, b) => b.end - a.end || (a.t.taskId < b.t.taskId ? -1 : 1)).slice(0, MAX_TASKS).map((x) => x.t);
  const levels: Array<{ level: TaskCohortLevel; pick: typeof ended }> = [];
  if (subject.taskKind !== null) levels.push({ level: "assistant+kind", pick: ended.filter((x) => x.t.taskKind === subject.taskKind) });
  levels.push({ level: "assistant", pick: ended });
  let fallback: { level: TaskCohortLevel; tasks: HistoricalTask[] } | undefined;
  for (const l of levels) {
    if (l.pick.length >= MIN_TASKS) return { level: l.level, tasks: recent(l.pick) };
    if (l.pick.length && !fallback) fallback = { level: l.level, tasks: recent(l.pick) };
  }
  return fallback ?? { level: "none", tasks: [] };
}

/* ---------------------------------------------------------------- overhead -- */

export type PartStatus = "observed" | "no-evidence" | "not-applicable";
export type OverheadKind = "planning" | "handoff" | "retry" | "verification";

export interface OverheadPart {
  status: PartStatus;
  method: string;
  confidence: EstimateConfidence;
  /** Extra runs of this class per task; `share` is the fraction of tasks that had one (null once summed). */
  expectedCount: { mean: number; share: number | null } | null;
  durationMs: EstimateRange | null;
  tokens: { input: EstimateRange | null; output: EstimateRange | null };
  costUsd: EstimateRange | null;
  sampleSize: number;
  evidence: { taskIds: string[]; runIds: string[] };
  missing: string[];
}

const EXTRA_RUNS_METHOD = "extra-runs-per-task/1";
const VERIFICATION_METHOD = "verification-runs/1: command checks spend no model tokens";

function partConfidence(level: TaskCohortLevel, n: number): EstimateConfidence {
  if (n === 0 || level === "none") return "unknown";
  if (n < MIN_TASKS || level === "assistant") return "low";
  return level === "assistant+kind" && n >= HIGH_TASKS ? "high" : "medium";
}

const emptyPart = (method: string, status: PartStatus, missing: string[]): OverheadPart => ({
  status, method, confidence: "unknown", expectedCount: null, durationMs: null,
  tokens: { input: null, output: null }, costUsd: null, sampleSize: 0, evidence: { taskIds: [], runIds: [] }, missing,
});

/** Planning is not observable for an operator-authored decomposition (plan section 4.4). */
export const planningPart = (): OverheadPart =>
  emptyPart("operator-authored-decomposition/1", "not-applicable", ["operator-authored decomposition: planning time and tokens are not observed"]);

/** Handoff or retry overhead of a child: extra runs of that class, per task of its cohort. */
export function extraRunPart(kind: "handoff" | "retry", cohort: { level: TaskCohortLevel; tasks: readonly HistoricalTask[] }): OverheadPart {
  const n = cohort.tasks.length;
  if (!n) return emptyPart(EXTRA_RUNS_METHOD, "no-evidence", [`${kind}: no comparable ended tasks`]);
  const duration: number[] = [], tokensIn: number[] = [], tokensOut: number[] = [], cost: number[] = [];
  const runIds: string[] = [];
  let runs = 0, withAny = 0, missingUsage = 0, missingCost = 0;
  for (const t of cohort.tasks) {
    const mine = classifyExtraRuns(t).filter((e) => e.class === kind);
    runs += mine.length;
    if (mine.length) withAny += 1;
    runIds.push(...mine.map((e) => e.runId));
    duration.push(mine.reduce((a, e) => a + e.durationMs + e.gapMs, 0));
    if (mine.every((e) => e.tokens !== null)) {
      tokensIn.push(mine.reduce((a, e) => a + e.tokens!.input, 0));
      tokensOut.push(mine.reduce((a, e) => a + e.tokens!.output, 0));
    } else missingUsage += 1;
    if (mine.every((e) => e.costUsd !== null)) cost.push(mine.reduce((a, e) => a + e.costUsd!, 0));
    else missingCost += 1;
  }
  const missing: string[] = [];
  if (missingUsage) missing.push(`usage: ${missingUsage} of ${n} cohort tasks have a ${kind} run with no usage evidence`);
  if (missingCost) missing.push(`cost: ${missingCost} of ${n} cohort tasks have a ${kind} run with no settled cost`);
  const confidence = partConfidence(cohort.level, n);
  return {
    status: "observed", method: EXTRA_RUNS_METHOD, confidence,
    expectedCount: { mean: runs / n, share: withAny / n },
    durationMs: quartiles(duration),
    tokens: { input: quartiles(tokensIn), output: quartiles(tokensOut) },
    costUsd: quartiles(cost),
    sampleSize: n, evidence: { taskIds: cohort.tasks.map((t) => t.taskId), runIds }, missing,
  };
}

/** Verification overhead: time inside completed Harness verification runs, per task. */
export function verificationPart(cohort: { level: TaskCohortLevel; tasks: readonly HistoricalTask[] }): OverheadPart {
  const totals: number[] = [];
  const taskIds: string[] = [], runIds: string[] = [];
  for (const t of cohort.tasks) {
    let total = 0, any = false;
    for (const v of t.verificationRuns) {
      if (v.state !== "completed" || v.claimedAt === null) continue;
      const d = ms(v.updatedAt) - ms(v.claimedAt);
      if (!Number.isFinite(d) || d < 0) continue;
      total += d; any = true; runIds.push(v.id);
    }
    if (any) { totals.push(total); taskIds.push(t.taskId); }
  }
  if (!totals.length) return emptyPart(VERIFICATION_METHOD, "no-evidence", ["verification: no completed Harness verification runs in the cohort"]);
  const zero: EstimateRange = { low: 0, typical: 0, high: 0 };
  return {
    status: "observed", method: VERIFICATION_METHOD, confidence: partConfidence(cohort.level, totals.length),
    expectedCount: null, durationMs: quartiles(totals), tokens: { input: zero, output: zero }, costUsd: zero,
    sampleSize: totals.length, evidence: { taskIds, runIds }, missing: [],
  };
}

/* ------------------------------------------------------------------- sums --- */

const add = (a: EstimateRange, b: EstimateRange): EstimateRange => ({ low: a.low + b.low, typical: a.typical + b.typical, high: a.high + b.high });
const max = (a: EstimateRange, b: EstimateRange): EstimateRange => ({ low: Math.max(a.low, b.low), typical: Math.max(a.typical, b.typical), high: Math.max(a.high, b.high) });

/** Componentwise sum; null when there is nothing to add or any term is null (a partial sum is not the sum). */
export function sumRanges(ranges: ReadonlyArray<EstimateRange | null>): EstimateRange | null {
  if (!ranges.length || ranges.some((r) => r === null)) return null;
  return (ranges as EstimateRange[]).reduce(add);
}

/** Sum a part across children. Any child without evidence makes the sum `no-evidence` and names it. */
function sumParts(kind: OverheadKind, perChild: ReadonlyArray<{ taskId: string; part: OverheadPart }>): OverheadPart {
  if (!perChild.length) return emptyPart(`${kind}/sum`, "no-evidence", [`${kind}: no children`]);
  const method = perChild[0]!.part.method;
  if (perChild.every((c) => c.part.status === "not-applicable")) return { ...perChild[0]!.part, evidence: { taskIds: [], runIds: [] } };
  const bad = perChild.filter((c) => c.part.status !== "observed");
  if (bad.length) {
    return emptyPart(method, "no-evidence", bad.flatMap((c) => c.part.missing.map((m) => `child ${c.taskId}: ${m}`)));
  }
  const parts = perChild.map((c) => c.part);
  return {
    status: "observed", method, confidence: lowest(...parts.map((p) => p.confidence)),
    expectedCount: parts.every((p) => p.expectedCount) ? { mean: parts.reduce((a, p) => a + p.expectedCount!.mean, 0), share: null } : null,
    durationMs: sumRanges(parts.map((p) => p.durationMs)),
    tokens: { input: sumRanges(parts.map((p) => p.tokens.input)), output: sumRanges(parts.map((p) => p.tokens.output)) },
    costUsd: sumRanges(parts.map((p) => p.costUsd)),
    sampleSize: parts.reduce((a, p) => a + p.sampleSize, 0),
    evidence: { taskIds: [...new Set(parts.flatMap((p) => p.evidence.taskIds))], runIds: parts.flatMap((p) => p.evidence.runIds) },
    missing: parts.flatMap((p) => p.missing),
  };
}

/* ----------------------------------------------------------- critical path -- */

/**
 * Longest path through a dependency graph. Each node's weight is a range; low, typical and high are
 * independent scenarios, so the maximum is taken per component. Ids in `dependsOn` that are not
 * nodes are ignored (the caller warns). A cycle returns `cycle`; a null weight returns null.
 */
export function criticalPath(
  nodes: ReadonlyArray<{ id: string; weight: EstimateRange | null; dependsOn: readonly string[] }>,
): { range: EstimateRange | null; cycle: boolean } {
  if (nodes.some((n) => n.weight === null)) return { range: null, cycle: false };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, EstimateRange>();
  const visiting = new Set<string>();
  let cycle = false;
  const finish = (id: string): EstimateRange => {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = byId.get(id)!;
    if (visiting.has(id)) { cycle = true; return node.weight!; }
    visiting.add(id);
    let before: EstimateRange = { low: 0, typical: 0, high: 0 };
    for (const d of node.dependsOn) if (byId.has(d) && d !== id) before = max(before, finish(d));
    visiting.delete(id);
    const out = add(before, node.weight!);
    memo.set(id, out);
    return out;
  };
  let best: EstimateRange | null = null;
  for (const n of nodes) { const f = finish(n.id); best = best ? max(best, f) : f; }
  return cycle ? { range: null, cycle: true } : { range: best, cycle: false };
}

/* ------------------------------------------------------------ parent estimate */

export interface ChildActual {
  durationMs: number | null;
  tokens: { input: number; output: number } | null;
  costUsd: number | null;
  costMethod: "measured" | "estimated" | "unknown";
}

/** One child as the api reads it: its task, its qcq-01 estimate and its declared order. */
export interface ParentChildInput {
  taskId: string;
  state: string;
  assistantId: string | null;
  taskKind: string | null;
  /** True when the child runs through the Harness; false for a legacy run (no verification timing). Null: not decided yet. */
  harness: boolean | null;
  /** Sibling task ids this child waits for (K4 dependency wait). */
  dependsOn: readonly string[];
  /** `estimateRun` for this child as `GET /api/tasks/:id/estimate` answers it; null when the api could not produce one. */
  estimate: RunEstimate | null;
  actual: ChildActual | null;
}

export interface ParentEstimate {
  estimatorVersion: typeof PARENT_ESTIMATOR_VERSION;
  advisory: true;
  asOf: string;
  parentTaskId: string;
  children: Array<{ taskId: string; state: string; estimate: RunEstimate | null; actual: ChildActual | null }>;
  overhead: Record<OverheadKind, OverheadPart>;
  totals: {
    tokens: { input: EstimateRange | null; output: EstimateRange | null };
    spend: { apiUsd: EstimateRange | null; apiEquivalentUsd: EstimateRange | null };
    durationMs: { serial: EstimateRange | null; criticalPath: EstimateRange | null; order: "dependency-waits" | "none" };
    confidence: EstimateConfidence;
    /** What a null total is waiting for, in words. */
    missing: string[];
  };
  warnings: string[];
}

const billingOf = (e: RunEstimate | null): BillingKind | null => (e ? e.spend.billing : null);

export function estimateParent(
  children: readonly ParentChildInput[],
  history: readonly HistoricalTask[],
  ctx: { asOf: string; parentTaskId: string },
): ParentEstimate {
  const warnings: string[] = [
    "serial and critical-path durations do not model the account concurrency limit or K4b resource pools",
    "sums add quartiles (p25, p50, p75 each); they are not quartiles of the sum",
  ];
  const ids = new Set(children.map((c) => c.taskId));
  const otherRuns = new Set<string>();

  // Per child: its cohort, then the overhead parts that depend on it.
  const perChild = children.map((c) => {
    const cohort = selectTaskCohort({ assistantId: c.assistantId, taskKind: c.taskKind }, history, ctx.asOf);
    for (const t of cohort.tasks) for (const e of classifyExtraRuns(t)) if (e.class === "other") otherRuns.add(e.runId);
    const verification = c.harness === false
      ? emptyPart(VERIFICATION_METHOD, "no-evidence", ["legacy run: verification time not recorded"])
      : verificationPart(cohort);
    return {
      child: c,
      parts: {
        planning: planningPart(),
        handoff: extraRunPart("handoff", cohort),
        retry: extraRunPart("retry", cohort),
        verification,
      } as Record<OverheadKind, OverheadPart>,
    };
  });
  if (otherRuns.size) warnings.push(`${otherRuns.size} extra run(s) in the comparable tasks matched neither handoff nor retry and are not counted`);

  const overhead = Object.fromEntries((["planning", "handoff", "retry", "verification"] as const).map((k) =>
    [k, sumParts(k, perChild.map((p) => ({ taskId: p.child.taskId, part: p.parts[k] })))])) as Record<OverheadKind, OverheadPart>;

  const missing: string[] = [];
  if (!children.length) missing.push("no children");
  for (const p of perChild) if (!p.child.estimate) missing.push(`child ${p.child.taskId}: no run estimate`);
  for (const k of ["handoff", "retry", "verification"] as const) if (overhead[k].status !== "observed") missing.push(...overhead[k].missing);
  if (overhead.planning.status === "not-applicable") warnings.push("planning overhead is not observed for operator-authored decomposition and is not included");

  // Per-child weight: its estimated duration plus its own overhead durations (null when anything is missing).
  const weights = perChild.map((p) => {
    const parts = [p.parts.handoff, p.parts.retry, p.parts.verification];
    const own = p.child.estimate?.durationMs.range ?? null;
    return { id: p.child.taskId, weight: parts.some((x) => x.status !== "observed") ? null : sumRanges([own, ...parts.map((x) => x.durationMs)]), dependsOn: p.child.dependsOn };
  });
  for (const c of children) for (const d of c.dependsOn) if (!ids.has(d)) warnings.push(`child ${c.taskId} depends on ${d}, which is not a child of this parent: ignored in the critical path`);
  const edges = children.some((c) => c.dependsOn.some((d) => ids.has(d) && d !== c.taskId));
  const serial = children.length ? sumRanges(weights.map((w) => w.weight)) : null;
  const path = edges ? criticalPath(weights) : { range: null, cycle: false };
  if (path.cycle) warnings.push("the children's dependencies contain a cycle: no critical path");

  const tokensIn = sumRanges([...perChild.map((p) => p.child.estimate?.tokens.input ?? null), overhead.handoff.tokens.input, overhead.retry.tokens.input, overhead.verification.tokens.input]);
  const tokensOut = sumRanges([...perChild.map((p) => p.child.estimate?.tokens.output ?? null), overhead.handoff.tokens.output, overhead.retry.tokens.output, overhead.verification.tokens.output]);

  // Spend: a child's own and overhead cost go to the bucket its provider's billing names.
  const bucket = (kind: BillingKind): EstimateRange | null => {
    const rows = perChild.filter((p) => billingOf(p.child.estimate) === kind);
    if (!rows.length) return null;
    return sumRanges(rows.flatMap((p) => [
      kind === "api" ? p.child.estimate!.spend.apiUsd : p.child.estimate!.spend.apiEquivalentUsd,
      p.parts.handoff.costUsd, p.parts.retry.costUsd, p.parts.verification.costUsd,
    ]));
  };

  const confidences = [
    ...perChild.map((p) => p.child.estimate?.confidence ?? "unknown" as EstimateConfidence),
    ...(["handoff", "retry", "verification"] as const).map((k) => overhead[k].confidence),
  ];
  return {
    estimatorVersion: PARENT_ESTIMATOR_VERSION,
    advisory: true,
    asOf: ctx.asOf,
    parentTaskId: ctx.parentTaskId,
    children: perChild.map((p) => ({ taskId: p.child.taskId, state: p.child.state, estimate: p.child.estimate, actual: p.child.actual })),
    overhead,
    totals: {
      tokens: { input: children.length ? tokensIn : null, output: children.length ? tokensOut : null },
      spend: { apiUsd: bucket("api"), apiEquivalentUsd: bucket("subscription") },
      durationMs: { serial, criticalPath: path.range, order: edges ? "dependency-waits" : "none" },
      confidence: children.length ? lowest(...confidences) : "unknown",
      missing,
    },
    warnings,
  };
}
