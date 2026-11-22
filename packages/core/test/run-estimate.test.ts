/**
 * qcq-01: advisory run estimates and scheduling recommendations, on fake history. The four cases
 * the milestone names are here: a task due soon, one that fits an evening or weekend window, one
 * blocked by a human approval, and one with missing usage data. Times are Asia/Jerusalem (UTC+2 in
 * November): 2026-11-22 is a Sunday (a work day), 2026-11-27 a Friday (weekend).
 */
import { describe, expect, it } from "vitest";
import {
  PERSONAL_SCHEDULING_POLICY, backtestEstimates, estimateRun, quartiles, recommendSchedule, schedulingPolicyProblems, selectCohort, windowKindAt,
  type EstimateContext, type EstimateSubject, type HistoricalRun, type SchedulingPolicy,
} from "../src/index.js";

const MIN = 60_000;
const H = 60 * MIN;
const SUN_1000 = "2026-11-22T08:00:00.000Z"; // Sun 10:00 Jerusalem: working hours
const THU_1700 = "2026-11-26T15:00:00.000Z"; // Thu 17:00
const THU_2000 = "2026-11-26T18:00:00.000Z"; // Thu 20:00
const SUN_0200 = "2026-11-22T00:00:00.000Z"; // Sun 02:00: night, no window

const open: SchedulingPolicy = {
  ...PERSONAL_SCHEDULING_POLICY,
  evening: { ...PERSONAL_SCHEDULING_POLICY.evening, allowed: true },
  weekend: { ...PERSONAL_SCHEDULING_POLICY.weekend, allowed: true },
};

let seq = 0;
function run(over: Partial<HistoricalRun> & { minutes: number; endedAt?: string }): HistoricalRun {
  seq += 1;
  const endedAt = over.endedAt ?? new Date(Date.parse("2026-11-20T10:00:00Z") - seq * H).toISOString();
  return {
    runId: `run-${seq}`, taskId: `task-${seq}`, assistantId: "claude", provider: "anthropic", model: "opus", modelRequested: "opus",
    taskKind: "implementation", state: "ENDED_OK", startedAt: new Date(Date.parse(endedAt) - over.minutes * MIN).toISOString(), endedAt,
    tokens: { input: 100_000, output: 10_000 }, costUsd: 2, costMethod: "estimated", approvalWaitsMs: [], ...over,
  };
}
const history = (n: number, minutes: number, over: Partial<HistoricalRun> = {}) => Array.from({ length: n }, () => run({ minutes, ...over }));

const subject: EstimateSubject = {
  assistantId: "claude", provider: "anthropic", model: "opus", modelSource: "task override (requested selector)",
  effort: null, effortSource: "not recorded", taskKind: "implementation",
};
const ctx = (now: string, over: Partial<EstimateContext> = {}): EstimateContext => ({
  now, quota: { blockers: [], current: null }, capacity: { account: null, activeRuns: 0, limit: null },
  waitCondition: null, pendingApprovals: 0, approvalRequired: false, ...over,
});

describe("estimateRun", () => {
  it("quartiles are nearest-rank p25/p50/p75", () => {
    expect(quartiles([])).toBeNull();
    expect(quartiles([40, 10, 30, 20])).toEqual({ low: 10, typical: 20, high: 30 });
  });

  it("uses the narrowest cohort with enough runs and names its evidence", () => {
    const h = [...history(8, 60), ...history(5, 10, { taskKind: "review" })];
    const e = estimateRun(subject, h, ctx(SUN_1000));
    expect(e.advisory).toBe(true);
    expect(e.evidence.cohort).toBe("assistant+model+kind");
    expect(e.evidence.sampleSize).toBe(8);
    expect(e.confidence).toBe("high");
    expect(e.durationMs.range).toEqual({ low: 60 * MIN, typical: 60 * MIN, high: 60 * MIN });
    expect(e.tokens.input).toEqual({ low: 100_000, typical: 100_000, high: 100_000 });
    // Subscription: dollars are the API-equivalent, never spend; quota is its own field.
    expect(e.spend).toMatchObject({ billing: "subscription", apiUsd: null, apiEquivalentUsd: { typical: 2 }, subscriptionQuota: null });
    expect(e.evidence.missing).toContain("effort: not recorded in the execution identity");
  });

  it("a metered API provider reports spend, not API-equivalent", () => {
    const h = history(4, 20, { assistantId: "router", provider: "openrouter", model: "m", modelRequested: "m" });
    const e = estimateRun({ ...subject, assistantId: "router", provider: "openrouter", model: "m" }, h, ctx(SUN_1000));
    expect(e.spend).toMatchObject({ billing: "api", apiUsd: { typical: 2 }, apiEquivalentUsd: null });
    expect(e.confidence).toBe("medium");
  });

  it("missing usage data: token ranges are null and confidence is unknown, never a guess", () => {
    const h = history(5, 30, { tokens: null, costUsd: null, costMethod: "unknown" });
    const e = estimateRun(subject, h, ctx(SUN_1000));
    expect(e.tokens).toMatchObject({ input: null, output: null, confidence: "unknown", runsWithUsage: 0, runsMissingUsage: 5 });
    expect(e.durationMs.confidence).toBe("medium");
    expect(e.confidence).toBe("unknown");
    expect(e.spend.apiEquivalentUsd).toBeNull();
    expect(e.evidence.missing).toContain("usage: 5 of 5 cohort runs have no usage evidence");
  });

  it("no comparable runs: every figure is unknown", () => {
    const e = estimateRun(subject, [], ctx(SUN_1000));
    expect(e).toMatchObject({ confidence: "unknown", durationMs: { range: null }, tokens: { input: null }, evidence: { cohort: "none", sampleSize: 0 } });
    expect(e.evidence.missing).toContain("no comparable ended runs");
  });

  it("falls back to a wider cohort, and ignores runs that ended after `now` and cancelled runs", () => {
    const h = [...history(3, 15, { taskKind: "review" }), run({ minutes: 5, endedAt: "2026-11-23T00:00:00Z" }), run({ minutes: 5, state: "CANCELLED" })];
    const c = selectCohort(subject, h, SUN_1000);
    expect(c.level).toBe("assistant");
    expect(c.runs).toHaveLength(3);
    expect(estimateRun(subject, h, ctx(SUN_1000)).confidence).toBe("low");
  });

  it("reports approval waits apart from the wait until start", () => {
    const h = [...history(2, 30, { approvalWaitsMs: [20 * MIN] }), ...history(2, 30)];
    const e = estimateRun(subject, h, ctx(SUN_1000, { quota: { blockers: [{ retryAt: "2026-11-22T09:00:00.000Z", kind: "provider-reset", reason: "quota exhausted" }], current: null } }));
    expect(e.approvalWait).toMatchObject({ historicalShare: 0.5, historicalMs: { typical: 20 * MIN } });
    expect(e.waitUntilStartMs.range).toEqual({ low: H, typical: H, high: H });
    expect(e.waitUntilStartMs.reasons[0]).toMatch(/quota blocked until 2026-11-22T09:00/);
  });
});

describe("recommendSchedule (Asia/Jerusalem)", () => {
  it("classifies windows in the operator's zone and work week", () => {
    expect(windowKindAt(Date.parse(SUN_1000), open)).toBe("work");
    expect(windowKindAt(Date.parse(THU_2000), open)).toBe("evening");
    expect(windowKindAt(Date.parse("2026-11-27T08:00:00Z"), open)).toBe("weekend"); // Fri 10:00
    expect(windowKindAt(Date.parse(THU_2000), PERSONAL_SCHEDULING_POLICY)).toBe("closed"); // evenings not allowed by default
    expect(schedulingPolicyProblems(PERSONAL_SCHEDULING_POLICY)).toEqual([]);
    expect(schedulingPolicyProblems({ ...open, timezone: "Mars/Olympus", workHours: { start: "18:00", end: "09:00" } })).toHaveLength(2);
  });

  it("due soon: runs now at full speed weight even when a long run could wait", () => {
    const e = estimateRun(subject, history(8, 90), ctx(SUN_1000));
    const r = recommendSchedule(e, ctx(SUN_1000), open, { deadline: "2026-11-22T12:00:00.000Z" });
    expect(r).toMatchObject({ advisory: true, action: "run-now", startAt: SUN_1000, speedWeight: 1, meetsDeadline: true });
    expect(r.reasons[0]).toMatch(/^due soon/);
    expect(r.expectedCompletion).toEqual({ low: "2026-11-22T09:30:00.000Z", typical: "2026-11-22T09:30:00.000Z", high: "2026-11-22T09:30:00.000Z" });
    expect(r.unchanged).toEqual(["acceptance tests", "permissions and approval mode", "spend limits", "dispatch and scheduling"]);
  });

  it("a long run with a distant deadline moves to the evening window, where speed weighs less", () => {
    const e = estimateRun(subject, history(8, 120), ctx(SUN_1000));
    const r = recommendSchedule(e, ctx(SUN_1000), open, { deadline: "2026-11-24T08:00:00.000Z" });
    expect(r.action).toBe("run-in-window");
    expect(r.window).toMatchObject({ kind: "evening", start: "2026-11-22T17:00:00.000Z", localStart: "Sun 19:00 Asia/Jerusalem", localEnd: "Sun 23:00 Asia/Jerusalem" });
    expect(r.speedWeight).toBe(0.5);
    expect(r.expectedCompletion?.high).toBe("2026-11-22T19:00:00.000Z");
    expect(r.meetsDeadline).toBe(true);
  });

  it("a run too long for an evening fits the weekend window instead", () => {
    const e = estimateRun(subject, history(8, 6 * 60), ctx(THU_1700));
    const r = recommendSchedule(e, ctx(THU_1700), open, { deadline: "2026-11-29T08:00:00.000Z" });
    expect(r.action).toBe("run-in-window");
    expect(r.window).toMatchObject({ kind: "weekend", localStart: "Fri 10:00 Asia/Jerusalem", localEnd: "Fri 22:00 Asia/Jerusalem" });
  });

  it("already inside an allowed evening that fits: run now with the lower speed weight", () => {
    const e = estimateRun(subject, history(8, 60), ctx(THU_2000));
    const r = recommendSchedule(e, ctx(THU_2000), open);
    expect(r).toMatchObject({ action: "run-now", speedWeight: 0.5, window: { kind: "evening" } });
  });

  it("evenings and weekends not allowed (the default): a long run still runs now, and says why", () => {
    const e = estimateRun(subject, history(8, 120), ctx(SUN_1000));
    const r = recommendSchedule(e, ctx(SUN_1000), PERSONAL_SCHEDULING_POLICY, { deadline: "2026-11-24T08:00:00.000Z" });
    expect(r.action).toBe("run-now");
    expect(r.reasons.join(" ")).toMatch(/evenings and weekends are not allowed/);
  });

  it("outside every allowed window: the next working-hours window", () => {
    const e = estimateRun(subject, history(8, 20), ctx(SUN_0200));
    const r = recommendSchedule(e, ctx(SUN_0200), PERSONAL_SCHEDULING_POLICY);
    expect(r).toMatchObject({ action: "run-in-window", startAt: "2026-11-22T07:00:00.000Z", window: { kind: "work" }, speedWeight: 1 });
  });

  it("blocked by a human approval: wait for it, start unknown, approver expected in working hours", () => {
    const h = history(8, 30, { approvalWaitsMs: [45 * MIN] });
    const c = ctx(THU_2000, { pendingApprovals: 1 });
    const r = recommendSchedule(estimateRun(subject, h, c), c, open);
    expect(r).toMatchObject({ action: "wait-for-approval", startAt: null, expectedCompletion: null, window: { kind: "work", localStart: "Sun 09:00 Asia/Jerusalem" } });
    // Friday is a weekend day: the next working morning is Sunday 09:00.
    expect(r.window?.start).toBe("2026-11-29T07:00:00.000Z");
    expect(r.reasons.join(" ")).toMatch(/1 approval\(s\) pending.*approver expected from.*typical 45 min/);
  });

  it("an approval the caller declares counts the same, during working hours too", () => {
    const c = ctx(SUN_1000, { approvalRequired: true });
    const r = recommendSchedule(estimateRun(subject, history(3, 30), c), c, open);
    expect(r.action).toBe("wait-for-approval");
    expect(r.window?.start).toBe(SUN_1000);
  });

  it("quota exhausted: wait for the reset, and flag a deadline it misses", () => {
    const c = ctx(SUN_1000, { quota: { blockers: [{ retryAt: "2026-11-22T13:00:00.000Z", kind: "provider-reset", reason: "quota exhausted" }], current: null } });
    const r = recommendSchedule(estimateRun(subject, history(8, 60), c), c, open, { deadline: "2026-11-22T13:30:00.000Z" });
    expect(r).toMatchObject({ action: "wait-for-quota-reset", startAt: "2026-11-22T13:00:00.000Z", meetsDeadline: false });
    expect(r.reasons.join(" ")).toMatch(/after the deadline/);
  });

  it("missing usage data does not block a recommendation: duration still drives it", () => {
    const e = estimateRun(subject, history(5, 120, { tokens: null, costUsd: null }), ctx(SUN_1000));
    const r = recommendSchedule(e, ctx(SUN_1000), open, { deadline: "2026-11-24T08:00:00.000Z" });
    expect(e.tokens.confidence).toBe("unknown");
    expect(r.action).toBe("run-in-window");
  });

  it("no history: run now and say no window fit could be checked", () => {
    const e = estimateRun(subject, [], ctx(SUN_1000));
    const r = recommendSchedule(e, ctx(SUN_1000), open, { deadline: "2026-11-24T08:00:00.000Z" });
    expect(r).toMatchObject({ action: "run-now", expectedCompletion: null, meetsDeadline: null });
    expect(r.reasons.join(" ")).toMatch(/no window fit can be checked/);
  });
});

describe("backtestEstimates", () => {
  it("compares each run's estimate from earlier runs with what it actually did", () => {
    const h = [
      run({ minutes: 30, endedAt: "2026-11-10T10:00:00Z" }),
      run({ minutes: 30, endedAt: "2026-11-11T10:00:00Z" }),
      run({ minutes: 30, endedAt: "2026-11-12T10:00:00Z" }),
      run({ minutes: 60, endedAt: "2026-11-13T10:00:00Z", tokens: null }),
    ];
    const report = backtestEstimates(h, 10);
    expect(report.runs).toBe(4);
    // The oldest run has no earlier evidence.
    expect(report.noEstimate).toBe(1);
    expect(report.duration.evaluated).toBe(3);
    // The newest (60 min) ran twice as long as its 30 min estimate.
    const newest = report.rows[0]!;
    expect(newest).toMatchObject({ durationMs: { actual: 60 * MIN, estimate: { typical: 30 * MIN } }, tokensIn: { actual: null } });
    expect(report.duration.withinRange).toBe(2);
    expect(report.duration.medianAbsPctError).toBe(0);
    // Tokens: the newest run reported none, so only two pairs exist.
    expect(report.tokensIn.evaluated).toBe(2);
  });
});
