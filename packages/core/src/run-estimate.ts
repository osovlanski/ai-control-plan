/**
 * Run estimates and scheduling recommendations (Quality, Cost & Quota milestone, slice qcq-01).
 *
 * ADVISORY ONLY. Nothing here dispatches, reserves, enforces a budget or changes a schedule. The api
 * reads durable records (runs, usage, approvals, quota observations) and calls these pure functions;
 * the answer is shown before dispatch and never consulted by the dispatch path.
 *
 * - An estimate rests on comparable historical runs: the narrowest cohort (same assistant, model and
 *   task kind; then assistant and kind; then assistant) that has enough runs. It names the cohort,
 *   the run ids it used and what was missing. With no comparable run every figure is `null` and the
 *   confidence is `unknown`: a guess is never presented as evidence.
 * - API spend (metered dollars), the subscription API-equivalent (what the same tokens would cost
 *   on the API; not spend) and subscription quota (the provider's own usage percentage) are kept
 *   apart. Token ranges are separate again.
 * - Approval waits are reported apart from the wait until start.
 * - A recommendation is one of run now, a later allowed window, or wait for an approval or a quota
 *   reset, with the reasons and the expected completion. Speed weighs less outside working hours
 *   when the deadline permits.
 * - Accuracy is measured by replaying this versioned estimator over the recorded actuals
 *   (`backtestEstimates`): each ended run is estimated from the runs that ended before it started.
 */

export const RUN_ESTIMATOR_VERSION = "run-estimate/1";

/** Nearest-rank quartiles of the cohort: `low` p25, `typical` p50, `high` p75. */
export interface EstimateRange { low: number; typical: number; high: number }
export type EstimateConfidence = "unknown" | "low" | "medium" | "high";
/** Who pays for tokens: metered API dollars, a subscription quota, nothing (fakes), or not known. */
export type BillingKind = "api" | "subscription" | "none" | "unknown";
export type CohortLevel = "assistant+model+kind" | "assistant+kind" | "assistant" | "none";

/** Provider defaults; an assistant's actual plan is not observable from its manifest. */
export const BILLING_BY_PROVIDER: Readonly<Record<string, BillingKind>> = Object.freeze({
  anthropic: "subscription", openai: "subscription", cursor: "subscription",
  openrouter: "api", bedrock: "api", fake: "none",
});
export const billingFor = (provider: string | null | undefined): BillingKind =>
  (provider && Object.prototype.hasOwnProperty.call(BILLING_BY_PROVIDER, provider) ? BILLING_BY_PROVIDER[provider]! : "unknown");

/** One ended run, as the api reads it back from durable records. */
export interface HistoricalRun {
  runId: string;
  taskId: string;
  assistantId: string;
  provider: string | null;
  /** Resolved model, else the requested selector, else null. */
  model: string | null;
  /** The requested selector, when one was recorded; a subject's pinned selector matches either. */
  modelRequested?: string | null;
  taskKind: string | null;
  startedAt: string;
  endedAt: string;
  /** Run state: ENDED_OK, ENDED_ERROR, CANCELLED, ... */
  state: string;
  /** Settled input/output tokens, or null when the run has no usage evidence at all. */
  tokens: { input: number; output: number } | null;
  /** Settled cost in USD and how it was obtained, or null when unknown. */
  costUsd: number | null;
  costMethod: "measured" | "estimated" | "unknown";
  /** Answered approvals: answered_at - created_at, in ms. */
  approvalWaitsMs: number[];
}

/** What would run, as the router and the task's intent propose it. */
export interface EstimateSubject {
  assistantId: string | null;
  provider: string | null;
  model: string | null;
  modelSource: string;
  /** Effort is not recorded in the execution identity yet (backlog p1-5-effort-cohorts). */
  effort: string | null;
  effortSource: string;
  taskKind: string | null;
}

/** The live state the estimate reads at `now`. */
export interface EstimateContext {
  now: string;
  /** Quota blockers of the proposed assistant (QuotaProjection), and its fullest fresh bucket. */
  quota: {
    blockers: Array<{ retryAt: string; kind: string; reason: string }>;
    current: { bucket: string | null; usedPercent: number; resetsAt: string | null; observedAt: string } | null;
  };
  /** Live runs on the same account. `limit` null: no shared per-account limit is configured. */
  capacity: { account: string | null; activeRuns: number; limit: number | null };
  /** The task's active scheduler wait, if any. */
  waitCondition: { kind: string; notBefore: string } | null;
  /** Approvals already pending on the task's runs. */
  pendingApprovals: number;
  /** The caller says a human approval gate (for example a budget approval) precedes the start. */
  approvalRequired: boolean;
}

export interface RunEstimate {
  estimatorVersion: string;
  advisory: true;
  asOf: string;
  subject: EstimateSubject;
  confidence: EstimateConfidence;
  tokens: { input: EstimateRange | null; output: EstimateRange | null; confidence: EstimateConfidence; runsWithUsage: number; runsMissingUsage: number };
  durationMs: { range: EstimateRange | null; confidence: EstimateConfidence };
  waitUntilStartMs: { range: EstimateRange | null; reasons: string[] };
  approvalWait: {
    pending: number;
    required: boolean;
    /** Share of cohort runs that waited on at least one approval, and the per-run total wait when they did. */
    historicalShare: number | null;
    historicalMs: EstimateRange | null;
  };
  spend: {
    billing: BillingKind;
    billingBasis: "provider default";
    /** Metered dollars. Only for `api` billing. */
    apiUsd: EstimateRange | null;
    /** What the tokens would cost on the API. For `subscription` billing; never spend. */
    apiEquivalentUsd: EstimateRange | null;
    /** The provider's own usage of the proposed assistant's fullest bucket. A run's share of it is not observable. */
    subscriptionQuota: { bucket: string | null; usedPercent: number; resetsAt: string | null; observedAt: string; perRunShare: "unknown" } | null;
  };
  evidence: { cohort: CohortLevel; sampleSize: number; runIds: string[]; missing: string[] };
}

const MIN_COHORT = 3;
const HIGH_COHORT = 8;
const MAX_COHORT = 20;
const RANK: Record<EstimateConfidence, number> = { unknown: 0, low: 1, medium: 2, high: 3 };
const minConfidence = (...c: EstimateConfidence[]): EstimateConfidence =>
  c.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "high" as EstimateConfidence);

/** Nearest-rank quartiles; null for no values. */
export function quartiles(values: readonly number[]): EstimateRange | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
  return { low: at(0.25), typical: at(0.5), high: at(0.75) };
}

function confidenceFor(level: CohortLevel, n: number): EstimateConfidence {
  if (n === 0 || level === "none") return "unknown";
  if (n < MIN_COHORT || level === "assistant") return "low";
  if (level === "assistant+model+kind" && n >= HIGH_COHORT) return "high";
  return "medium";
}

/**
 * The comparable runs for a subject: ended, not cancelled, ended before `asOf`, narrowest level
 * first. A level needs MIN_COHORT runs; failing every level, the narrowest non-empty one is used
 * (low confidence). The most recent MAX_COHORT runs of the chosen level are kept.
 */
export function selectCohort(subject: EstimateSubject, history: readonly HistoricalRun[], asOf: string): { level: CohortLevel; runs: HistoricalRun[] } {
  const asOfMs = Date.parse(asOf);
  if (!subject.assistantId) return { level: "none", runs: [] };
  const ended = history.filter((r) => r.assistantId === subject.assistantId && r.state !== "CANCELLED"
    && Number.isFinite(Date.parse(r.startedAt)) && Number.isFinite(Date.parse(r.endedAt)) && Date.parse(r.endedAt) <= asOfMs);
  const levels: Array<{ level: CohortLevel; match: (r: HistoricalRun) => boolean; usable: boolean }> = [
    { level: "assistant+model+kind", match: (r) => (r.model === subject.model || r.modelRequested === subject.model) && r.taskKind === subject.taskKind, usable: subject.model !== null && subject.taskKind !== null },
    { level: "assistant+kind", match: (r) => r.taskKind === subject.taskKind, usable: subject.taskKind !== null },
    { level: "assistant", match: () => true, usable: true },
  ];
  const recent = (runs: HistoricalRun[]) => [...runs].sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || (a.runId < b.runId ? -1 : 1)).slice(0, MAX_COHORT);
  let fallback: { level: CohortLevel; runs: HistoricalRun[] } | undefined;
  for (const l of levels) {
    if (!l.usable) continue;
    const runs = ended.filter(l.match);
    if (runs.length >= MIN_COHORT) return { level: l.level, runs: recent(runs) };
    if (runs.length && !fallback) fallback = { level: l.level, runs: recent(runs) };
  }
  return fallback ?? { level: "none", runs: [] };
}

export function estimateRun(subject: EstimateSubject, history: readonly HistoricalRun[], ctx: EstimateContext): RunEstimate {
  const nowMs = Date.parse(ctx.now);
  const { level, runs } = selectCohort(subject, history, ctx.now);
  const missing: string[] = [];
  if (!subject.assistantId) missing.push("no proposed assistant: the router found no eligible candidate");
  if (subject.model === null) missing.push("model: not pinned; cohort ignores model");
  if (subject.effort === null) missing.push("effort: not recorded in the execution identity");
  if (subject.assistantId && !runs.length) missing.push("no comparable ended runs");

  const base = confidenceFor(level, runs.length);
  const duration = quartiles(runs.map((r) => Date.parse(r.endedAt) - Date.parse(r.startedAt)));
  const withUsage = runs.filter((r) => r.tokens !== null);
  if (runs.length && withUsage.length < runs.length) missing.push(`usage: ${runs.length - withUsage.length} of ${runs.length} cohort runs have no usage evidence`);
  const tokenConfidence = withUsage.length === 0 ? "unknown" : minConfidence(base, confidenceFor(level, withUsage.length));
  const tokens = {
    input: quartiles(withUsage.map((r) => r.tokens!.input)),
    output: quartiles(withUsage.map((r) => r.tokens!.output)),
    confidence: tokenConfidence,
    runsWithUsage: withUsage.length,
    runsMissingUsage: runs.length - withUsage.length,
  };

  // Wait until start: the latest of an active scheduler wait, a quota retry and a full account.
  const reasons: string[] = [];
  let waitMs = 0;
  if (ctx.waitCondition && Date.parse(ctx.waitCondition.notBefore) > nowMs) {
    waitMs = Math.max(waitMs, Date.parse(ctx.waitCondition.notBefore) - nowMs);
    reasons.push(`scheduler ${ctx.waitCondition.kind} wait until ${ctx.waitCondition.notBefore}`);
  }
  const retry = latestRetry(ctx, nowMs);
  if (retry !== undefined) {
    waitMs = Math.max(waitMs, retry - nowMs);
    reasons.push(`quota blocked until ${new Date(retry).toISOString()}`);
  }
  let waitRange: EstimateRange | null = { low: waitMs, typical: waitMs, high: waitMs };
  if (ctx.capacity.limit !== null && ctx.capacity.activeRuns >= ctx.capacity.limit) {
    const ahead = ctx.capacity.activeRuns - ctx.capacity.limit + 1;
    reasons.push(`account at its advisory limit: ${ctx.capacity.activeRuns} of ${ctx.capacity.limit} runs live`);
    waitRange = duration
      ? { low: waitMs, typical: Math.max(waitMs, Math.round(duration.typical * ahead / 2)), high: Math.max(waitMs, duration.high * ahead) }
      : null;
    if (!duration) reasons.push("no duration evidence: the wait behind live runs is unknown");
  }
  if (!reasons.length) reasons.push("no wait observed: quota, scheduler and account are clear");

  const approvalRuns = runs.filter((r) => r.approvalWaitsMs.length > 0);
  const billing = billingFor(subject.provider);
  const costs = runs.filter((r) => r.costUsd !== null).map((r) => r.costUsd!);
  const durationConfidence = duration ? base : "unknown";
  return {
    estimatorVersion: RUN_ESTIMATOR_VERSION,
    advisory: true,
    asOf: ctx.now,
    subject,
    confidence: minConfidence(durationConfidence, tokenConfidence),
    tokens,
    durationMs: { range: duration, confidence: durationConfidence },
    waitUntilStartMs: { range: waitRange, reasons },
    approvalWait: {
      pending: ctx.pendingApprovals,
      required: ctx.approvalRequired,
      historicalShare: runs.length ? approvalRuns.length / runs.length : null,
      historicalMs: quartiles(approvalRuns.map((r) => r.approvalWaitsMs.reduce((a, b) => a + b, 0))),
    },
    spend: {
      billing,
      billingBasis: "provider default",
      apiUsd: billing === "api" ? quartiles(costs) : null,
      apiEquivalentUsd: billing === "subscription" ? quartiles(costs) : null,
      subscriptionQuota: billing === "subscription" && ctx.quota.current ? { ...ctx.quota.current, perRunShare: "unknown" } : null,
    },
    evidence: { cohort: level, sampleSize: runs.length, runIds: runs.map((r) => r.runId), missing },
  };
}

function latestRetry(ctx: EstimateContext, nowMs: number): number | undefined {
  const times = ctx.quota.blockers.map((b) => Date.parse(b.retryAt)).filter((t) => Number.isFinite(t) && t > nowMs);
  return times.length ? Math.max(...times) : undefined;
}

/* ------------------------------------------------------------- scheduling -- */

/** "HH:MM", 00:00 to 24:00. */
export type WallClock = string;
export interface DailyWindow { start: WallClock; end: WallClock }

/** The operator's hours. Days are 0 = Sunday .. 6 = Saturday, in `timezone`. */
export interface SchedulingPolicy {
  timezone: string;
  workDays: number[];
  workHours: DailyWindow;
  /** Evenings of work days. Recommended only when `allowed`. */
  evening: DailyWindow & { allowed: boolean };
  /** Whole weekend days. Recommended only when `allowed`. */
  weekend: DailyWindow & { allowed: boolean; days: number[] };
  /** A deadline whose latest start is this close is "due soon": run now. */
  dueSoonMs: number;
  /** A run expected to be shorter than this is never deferred to a later window. */
  offHoursMinDurationMs: number;
  /** Advisory shared per-account concurrency, used only for the wait estimate. Null: not configured. */
  accountConcurrency: number | null;
}

export const PERSONAL_SCHEDULING_POLICY: SchedulingPolicy = Object.freeze({
  timezone: "Asia/Jerusalem",
  workDays: [0, 1, 2, 3, 4],
  workHours: { start: "09:00", end: "18:00" },
  evening: { start: "19:00", end: "23:00", allowed: false },
  weekend: { start: "10:00", end: "22:00", allowed: false, days: [5, 6] },
  dueSoonMs: 4 * 3_600_000,
  offHoursMinDurationMs: 30 * 60_000,
  accountConcurrency: null,
}) as SchedulingPolicy;

export const WORK_SCHEDULING_POLICY: SchedulingPolicy = Object.freeze({
  ...PERSONAL_SCHEDULING_POLICY,
  timezone: "UTC",
  workDays: [1, 2, 3, 4, 5],
  weekend: { start: "10:00", end: "22:00", allowed: false, days: [0, 6] },
}) as SchedulingPolicy;

const WALL = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
export function wallMinutes(value: WallClock): number | undefined {
  const m = WALL.exec(value);
  if (!m) return undefined;
  return m[1] === undefined ? 24 * 60 : Number(m[1]) * 60 + Number(m[2]);
}

/** Every problem with a policy, empty when it is usable. */
export function schedulingPolicyProblems(p: SchedulingPolicy): string[] {
  const out: string[] = [];
  try { new Intl.DateTimeFormat("en-US", { timeZone: p.timezone }); } catch { out.push(`timezone ${JSON.stringify(p.timezone)} is not an IANA zone`); }
  const days = (name: string, d: unknown) => {
    if (!Array.isArray(d) || d.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) out.push(`${name} must list days 0 (Sunday) to 6`);
  };
  days("workDays", p.workDays);
  days("weekend.days", p.weekend?.days);
  for (const [name, w] of [["workHours", p.workHours], ["evening", p.evening], ["weekend", p.weekend]] as const) {
    const s = wallMinutes(w?.start ?? ""), e = wallMinutes(w?.end ?? "");
    if (s === undefined || e === undefined || s >= e) out.push(`${name} must be HH:MM start before end, within one day`);
  }
  if (typeof p.evening?.allowed !== "boolean") out.push("evening.allowed must be a boolean");
  if (typeof p.weekend?.allowed !== "boolean") out.push("weekend.allowed must be a boolean");
  if (Array.isArray(p.workDays) && Array.isArray(p.weekend?.days) && p.workDays.some((d) => p.weekend.days.includes(d))) out.push("a day cannot be both a work day and a weekend day");
  for (const k of ["dueSoonMs", "offHoursMinDurationMs"] as const) if (!Number.isInteger(p[k]) || p[k] < 0) out.push(`${k} must be a non-negative integer`);
  if (p.accountConcurrency !== null && (!Number.isInteger(p.accountConcurrency) || p.accountConcurrency < 1)) out.push("accountConcurrency must be a positive integer or null");
  return out;
}

export type WindowKind = "work" | "evening" | "weekend" | "closed";
const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, timezone: string): { day: number; minutes: number; label: string } {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return { day: DAY[parts.weekday!]!, minutes, label: `${parts.weekday} ${parts.hour}:${parts.minute}` };
}
const inside = (minutes: number, w: DailyWindow) => minutes >= wallMinutes(w.start)! && minutes < wallMinutes(w.end)!;

/** Which of the operator's windows an instant falls in. Disallowed evening and weekend hours are `closed`. */
export function windowKindAt(ms: number, p: SchedulingPolicy): WindowKind {
  const { day, minutes } = localParts(ms, p.timezone);
  if (p.workDays.includes(day)) {
    if (inside(minutes, p.workHours)) return "work";
    if (p.evening.allowed && inside(minutes, p.evening)) return "evening";
    return "closed";
  }
  if (p.weekend.allowed && p.weekend.days.includes(day) && inside(minutes, p.weekend)) return "weekend";
  return "closed";
}

const STEP_MS = 5 * 60_000;
const HORIZON_MS = 14 * 24 * 3_600_000;
const alignUp = (ms: number) => Math.ceil(ms / STEP_MS) * STEP_MS;

/** The contiguous span of `kind` containing `fromMs`, scanning forward at 5-minute resolution. */
function spanEnd(fromMs: number, kind: WindowKind, p: SchedulingPolicy): number {
  let t = alignUp(fromMs + 1);
  while (t - fromMs < HORIZON_MS && windowKindAt(t, p) === kind) t += STEP_MS;
  return t;
}

export interface WindowSpan { kind: WindowKind; start: string; end: string; localStart: string; localEnd: string }
const span = (kind: WindowKind, start: number, end: number, p: SchedulingPolicy): WindowSpan => ({
  kind, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
  localStart: `${localParts(start, p.timezone).label} ${p.timezone}`, localEnd: `${localParts(end, p.timezone).label} ${p.timezone}`,
});

/**
 * The first span at or after `fromMs` whose kind is in `kinds` and which is at least `needMs` long
 * (from its start, or from `fromMs` when already inside it) and ends no later than `notAfterMs`.
 */
export function nextWindow(fromMs: number, kinds: readonly WindowKind[], needMs: number, p: SchedulingPolicy, notAfterMs = Infinity): WindowSpan | undefined {
  let t = fromMs;
  while (t - fromMs < HORIZON_MS) {
    const kind = windowKindAt(t, p);
    if (kinds.includes(kind)) {
      const end = spanEnd(t, kind, p);
      if (end - t >= needMs && t + needMs <= notAfterMs) return span(kind, t, end, p);
      t = end;
      continue;
    }
    t = alignUp(t + 1);
  }
  return undefined;
}

export type RecommendationAction = "run-now" | "run-in-window" | "wait-for-approval" | "wait-for-quota-reset";

export interface ScheduleRecommendation {
  advisory: true;
  action: RecommendationAction;
  /** Earliest recommended start; null when it depends on a human answer at an unknown time. */
  startAt: string | null;
  window: WindowSpan | null;
  /** startAt + the duration range; null when either is unknown. */
  expectedCompletion: { low: string; typical: string; high: string } | null;
  /** 1 inside working hours; lowered outside them when the deadline permits. */
  speedWeight: number;
  deadline: string | null;
  meetsDeadline: boolean | null;
  reasons: string[];
  /** Always stated: this answer changes no gate. */
  unchanged: string[];
}

const UNCHANGED = ["acceptance tests", "permissions and approval mode", "spend limits", "dispatch and scheduling"];
const OFF_HOURS_SPEED_WEIGHT = 0.5;

export function recommendSchedule(estimate: RunEstimate, ctx: EstimateContext, policy: SchedulingPolicy, options: { deadline?: string | null } = {}): ScheduleRecommendation {
  const nowMs = Date.parse(ctx.now);
  const deadline = options.deadline ?? null;
  const deadlineMs = deadline ? Date.parse(deadline) : Infinity;
  const duration = estimate.durationMs.range;
  const needMs = duration ? duration.high : 0;
  const reasons: string[] = [];
  const nowKind = windowKindAt(nowMs, policy);
  const local = `${localParts(nowMs, policy.timezone).label} ${policy.timezone}`;
  const completion = (startMs: number | null) => (startMs === null || !duration ? null : {
    low: new Date(startMs + duration.low).toISOString(), typical: new Date(startMs + duration.typical).toISOString(), high: new Date(startMs + duration.high).toISOString(),
  });
  const meets = (startMs: number | null) => (deadline === null ? null : startMs === null || !duration ? null : startMs + duration.high <= deadlineMs);
  const out = (action: RecommendationAction, startMs: number | null, window: WindowSpan | null, speedWeight: number): ScheduleRecommendation => {
    const met = meets(startMs);
    if (met === false) reasons.push(`expected completion (high ${completion(startMs)!.high}) is after the deadline ${deadline}`);
    if (!duration) reasons.push("no duration evidence: expected completion is unknown");
    return { advisory: true, action, startAt: startMs === null ? null : new Date(startMs).toISOString(), window, expectedCompletion: completion(startMs),
      speedWeight, deadline, meetsDeadline: met, reasons, unchanged: UNCHANGED };
  };

  // 1. A human answer gates the start: approvals are only expected in working hours.
  if (ctx.pendingApprovals > 0 || ctx.approvalRequired) {
    reasons.push(ctx.pendingApprovals > 0 ? `${ctx.pendingApprovals} approval(s) pending on this task` : "a human approval must precede the start");
    const approver = nextWindow(nowMs, ["work"], 0, policy);
    if (approver && Date.parse(approver.start) > nowMs) reasons.push(`outside working hours (${local}); approver expected from ${approver.localStart}`);
    const typical = estimate.approvalWait.historicalMs?.typical;
    if (typical !== undefined) reasons.push(`comparable runs waited a typical ${Math.round(typical / 60_000)} min for approvals`);
    return out("wait-for-approval", null, approver ?? null, 1);
  }

  // 2. Quota exhausted: wait for the reset (a recheck time, not a promise of headroom).
  const retry = latestRetry(ctx, nowMs);
  if (retry !== undefined) {
    reasons.push(`quota exhausted until ${new Date(retry).toISOString()} (${ctx.quota.blockers.map((b) => b.kind).join(", ")}); the reset is a recheck, not observed headroom`);
    return out("wait-for-quota-reset", retry, null, nowKind === "work" ? 1 : OFF_HOURS_SPEED_WEIGHT);
  }

  // 3. Due soon: speed wins.
  if (deadline !== null) {
    const latestStart = deadlineMs - needMs;
    if (latestStart - nowMs <= policy.dueSoonMs) {
      reasons.push(`due soon: latest start ${new Date(latestStart).toISOString()} is within ${Math.round(policy.dueSoonMs / 60_000)} min`);
      return out("run-now", nowMs, null, 1);
    }
  }

  if (!duration) {
    reasons.push("no comparable runs: no window fit can be checked, so no deferral is recommended");
    return out("run-now", nowMs, null, nowKind === "work" ? 1 : OFF_HOURS_SPEED_WEIGHT);
  }

  const offKinds: WindowKind[] = [...(policy.evening.allowed ? ["evening" as const] : []), ...(policy.weekend.allowed ? ["weekend" as const] : [])];
  const later = (w: WindowSpan, why: string) => {
    reasons.push(why, `the deadline permits the ${w.kind} window ${w.localStart} to ${w.localEnd}`);
    return out("run-in-window", Date.parse(w.start), w, w.kind === "work" ? 1 : OFF_HOURS_SPEED_WEIGHT);
  };

  // 4. Inside an allowed off-hours window that fits: run now, speed weighs less.
  if (nowKind === "evening" || nowKind === "weekend") {
    const end = spanEnd(nowMs, nowKind, policy);
    if (end - nowMs >= needMs) {
      reasons.push(`inside the allowed ${nowKind} window (${local}); the run fits before it closes`);
      return out("run-now", nowMs, span(nowKind, nowMs, end, policy), OFF_HOURS_SPEED_WEIGHT);
    }
  }

  // 5. Working hours: a long or pressured run that is not urgent moves to the next allowed
  //    off-hours window that fits before the deadline. Otherwise it runs now.
  if (nowKind === "work") {
    const pressure: string[] = [];
    if (duration.typical >= policy.offHoursMinDurationMs) pressure.push(`typical duration ${Math.round(duration.typical / 60_000)} min is a long run`);
    const used = ctx.quota.current?.usedPercent;
    if (used !== undefined && used >= 80) pressure.push(`quota bucket at ${used}%`);
    if (ctx.capacity.limit !== null && ctx.capacity.activeRuns >= ctx.capacity.limit) pressure.push("account at its advisory concurrency limit");
    if (pressure.length && offKinds.length) {
      const w = nextWindow(nowMs, offKinds, needMs, policy, deadlineMs);
      if (w) return later(w, `${pressure.join("; ")}: off working hours speed weighs less`);
      reasons.push(`no allowed ${offKinds.join(" or ")} window fits before the deadline`);
    } else if (pressure.length) reasons.push(`${pressure.join("; ")}, but evenings and weekends are not allowed in the scheduling policy`);
    reasons.push(`working hours (${local})`);
    return out("run-now", nowMs, null, 1);
  }

  // 6. Outside every allowed window (or the current one is too short): the next allowed one that fits.
  const w = nextWindow(nowMs, ["work", ...offKinds], needMs, policy, deadlineMs);
  if (w) return later(w, `outside the allowed hours (${local})`);
  reasons.push(`outside the allowed hours (${local}) and no allowed window fits before the deadline`);
  return out("run-now", nowMs, null, OFF_HOURS_SPEED_WEIGHT);
}

/* --------------------------------------------------------------- accuracy -- */

export interface MetricAccuracy {
  /** Runs with both an estimate and an actual for this metric. */
  evaluated: number;
  /** Runs whose actual fell within [low, high]. */
  withinRange: number;
  withinRangeRate: number | null;
  /** Median of |actual - typical| / actual. */
  medianAbsPctError: number | null;
}
export interface AccuracyRow {
  runId: string;
  /** Recorded reports only (qcq-02): the version of the estimator that produced the stored estimate. */
  estimatorVersion?: string;
  cohort: CohortLevel;
  sampleSize: number;
  confidence: EstimateConfidence;
  durationMs: { actual: number; estimate: EstimateRange | null };
  tokensIn: { actual: number | null; estimate: EstimateRange | null };
  tokensOut: { actual: number | null; estimate: EstimateRange | null };
}
export interface AccuracyReport {
  estimatorVersion: string;
  method: "replay: each ended run is estimated from runs that ended before it started"
    | "recorded: the estimate stored when each run started, against what the run recorded";
  runs: number;
  noEstimate: number;
  duration: MetricAccuracy;
  tokensIn: MetricAccuracy;
  tokensOut: MetricAccuracy;
  byConfidence: Record<EstimateConfidence, number>;
  rows: AccuracyRow[];
}

function metric(pairs: Array<{ actual: number; estimate: EstimateRange }>): MetricAccuracy {
  const within = pairs.filter((p) => p.actual >= p.estimate.low && p.actual <= p.estimate.high).length;
  const errors = pairs.filter((p) => p.actual > 0).map((p) => Math.abs(p.actual - p.estimate.typical) / p.actual).sort((a, b) => a - b);
  return {
    evaluated: pairs.length,
    withinRange: within,
    withinRangeRate: pairs.length ? within / pairs.length : null,
    medianAbsPctError: errors.length ? Math.round(errors[Math.floor((errors.length - 1) / 2)]! * 1000) / 1000 : null,
  };
}

const REPLAY_METHOD = "replay: each ended run is estimated from runs that ended before it started";
const RECORDED_METHOD = "recorded: the estimate stored when each run started, against what the run recorded";

function accuracyReport(method: AccuracyReport["method"], rows: AccuracyRow[], noEstimate: number): AccuracyReport {
  const byConfidence: Record<EstimateConfidence, number> = { unknown: 0, low: 0, medium: 0, high: 0 };
  for (const row of rows) byConfidence[row.confidence] += 1;
  const pairs = (pick: (row: AccuracyRow) => { actual: number | null; estimate: EstimateRange | null }) =>
    rows.map(pick).filter((p): p is { actual: number; estimate: EstimateRange } => p.actual !== null && p.estimate !== null);
  return {
    estimatorVersion: RUN_ESTIMATOR_VERSION,
    method,
    runs: rows.length, noEstimate,
    duration: metric(pairs((x) => x.durationMs)),
    tokensIn: metric(pairs((x) => x.tokensIn)),
    tokensOut: metric(pairs((x) => x.tokensOut)),
    byConfidence, rows,
  };
}

const endedTargets = (history: readonly HistoricalRun[], limit: number) =>
  history.filter((r) => r.state !== "CANCELLED" && Number.isFinite(Date.parse(r.endedAt)))
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt)).slice(0, limit);

/** Replays the estimator over recorded actuals: each run's subject is what it recorded (assistant, model, kind). */
export function backtestEstimates(history: readonly HistoricalRun[], limit: number): AccuracyReport {
  const rows: AccuracyRow[] = [];
  let noEstimate = 0;
  for (const r of endedTargets(history, limit)) {
    const subject: EstimateSubject = { assistantId: r.assistantId, provider: r.provider, model: r.model, modelSource: "recorded", effort: null, effortSource: "not recorded", taskKind: r.taskKind };
    // Strictly earlier evidence: runs that ended before this one started, never itself.
    const prior = history.filter((h) => h.runId !== r.runId && Date.parse(h.endedAt) < Date.parse(r.startedAt));
    const e = estimateRun(subject, prior, { now: r.startedAt, quota: { blockers: [], current: null }, capacity: { account: null, activeRuns: 0, limit: null }, waitCondition: null, pendingApprovals: 0, approvalRequired: false });
    if (!e.durationMs.range) noEstimate += 1;
    rows.push(accuracyRow(r, e));
  }
  return accuracyReport(REPLAY_METHOD, rows, noEstimate);
}

function accuracyRow(r: HistoricalRun, e: RunEstimate, estimatorVersion?: string): AccuracyRow {
  return {
    runId: r.runId, cohort: e.evidence.cohort, sampleSize: e.evidence.sampleSize, confidence: e.confidence,
    ...(estimatorVersion !== undefined ? { estimatorVersion } : {}),
    durationMs: { actual: Date.parse(r.endedAt) - Date.parse(r.startedAt), estimate: e.durationMs.range },
    tokensIn: { actual: r.tokens?.input ?? null, estimate: e.tokens.input },
    tokensOut: { actual: r.tokens?.output ?? null, estimate: e.tokens.output },
  };
}

/**
 * qcq-02: the estimate that was stored when a run started (`run_estimates`), scored against what
 * that run recorded once it ended. Unlike the replay, nothing is re-estimated: the stored ranges
 * are compared as they were. A recorded estimate of another estimator version is scored as stored
 * and its row names that version.
 */
export interface RecordedRunEstimate { runId: string; estimatorVersion: string; recordedAt: string; estimate: RunEstimate }

export function scoreRecordedEstimates(recorded: readonly RecordedRunEstimate[], history: readonly HistoricalRun[], limit: number): AccuracyReport {
  const byRun = new Map(recorded.map((r) => [r.runId, r]));
  const rows: AccuracyRow[] = [];
  let noEstimate = 0;
  for (const r of endedTargets(history.filter((h) => byRun.has(h.runId)), limit)) {
    const stored = byRun.get(r.runId)!;
    if (!stored.estimate.durationMs.range) noEstimate += 1;
    rows.push(accuracyRow(r, stored.estimate, stored.estimatorVersion));
  }
  return accuracyReport(RECORDED_METHOD, rows, noEstimate);
}
