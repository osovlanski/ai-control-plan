/**
 * qcq-06 S2: the parent estimate and its overhead parts, on fake history. Plan section 8 items 1 to 8.
 * Every part with no evidence must be null with its reason, never zero.
 */
import { describe, expect, it } from "vitest";
import {
  PARENT_ESTIMATOR_VERSION, RUN_ESTIMATOR_VERSION, classifyExtraRuns, criticalPath, estimateParent, estimateRun, selectTaskCohort, sumRanges, verificationPart,
  type EstimateContext, type EstimateSubject, type HistoricalRun, type HistoricalTask, type HistoricalTaskRun, type ParentChildInput,
} from "../src/index.js";

const MIN = 60_000;
const ASOF = "2026-11-26T12:00:00.000Z";
const r = (typical: number) => ({ low: typical, typical, high: typical });

let seq = 0;
const iso = (offsetMin: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + offsetMin * MIN).toISOString();

function taskRun(over: Partial<HistoricalTaskRun> & { start: number; minutes: number }): HistoricalTaskRun {
  seq += 1;
  const { start, minutes, ...rest } = over;
  return {
    runId: `r${seq}`, state: "ENDED_OK", startedAt: iso(start), endedAt: iso(start + minutes),
    tokens: { input: 1000, output: 100 }, costUsd: 1, originKind: "fresh", handoffTrigger: null, ...rest,
  };
}
function task(runs: HistoricalTaskRun[], over: Partial<HistoricalTask> = {}): HistoricalTask {
  seq += 1;
  return { taskId: `t${seq}`, assistantId: "claude", taskKind: "implementation", mode: "single", runs, verificationRuns: [], ...over };
}
/** A task with one base run and no extras. */
const plain = (over: Partial<HistoricalTask> = {}) => task([taskRun({ start: seq * 100, minutes: 10 })], over);
const many = (n: number, make: () => HistoricalTask) => Array.from({ length: n }, make);

const subject: EstimateSubject = {
  assistantId: "claude", provider: "anthropic", model: "opus", modelSource: "test", effort: null, effortSource: "n/a", taskKind: "implementation",
};
const ectx: EstimateContext = {
  now: ASOF, quota: { blockers: [], current: null }, capacity: { account: null, activeRuns: 0, limit: null },
  waitCondition: null, pendingApprovals: 0, approvalRequired: false,
};
function runHistory(n: number, minutes: number): HistoricalRun[] {
  return Array.from({ length: n }, (_, i) => ({
    runId: `h${i}`, taskId: `ht${i}`, assistantId: "claude", provider: "anthropic", model: "opus", modelRequested: "opus", taskKind: "implementation",
    state: "ENDED_OK", startedAt: iso(-1000 - i * 100 - minutes), endedAt: iso(-1000 - i * 100), tokens: { input: 100, output: 10 }, costUsd: 2, costMethod: "estimated" as const,
    approvalWaitsMs: [],
  }));
}
const estimateFor = (minutes = 30) => estimateRun(subject, runHistory(8, minutes), ectx);
const child = (id: string, over: Partial<ParentChildInput> = {}): ParentChildInput => ({
  taskId: id, state: "CREATED", assistantId: "claude", taskKind: "implementation", harness: true, dependsOn: [], estimate: estimateFor(), actual: null, ...over,
});
/** A cohort rich enough for every part: 4 tasks with one handoff, one retry and one completed verification each. */
function richHistory(): HistoricalTask[] {
  return many(4, () => {
    const base = seq * 100;
    return task([
      taskRun({ start: base, minutes: 10, state: "ENDED_ERROR" }),
      taskRun({ start: base + 15, minutes: 20, handoffTrigger: "failure", originKind: "handoff" }),
      taskRun({ start: base + 50, minutes: 5, handoffTrigger: "quota", originKind: "handoff" }),
    ], { verificationRuns: [{ id: `v${seq}`, state: "completed", claimedAt: iso(base + 56), updatedAt: iso(base + 58) }] });
  });
}

describe("classifyExtraRuns", () => {
  it("classifies each extra run once, by the first matching rule", () => {
    const t = task([
      taskRun({ start: 0, minutes: 10, state: "ENDED_ERROR" }),
      taskRun({ start: 20, minutes: 5, handoffTrigger: "failure", originKind: "handoff" }),   // failure row beats origin: retry
      taskRun({ start: 40, minutes: 5, handoffTrigger: "context", originKind: "handoff" }),   // handoff
      taskRun({ start: 60, minutes: 5, state: "ENDED_ERROR" }),
      taskRun({ start: 70, minutes: 5, originKind: "resume" }),                               // after ENDED_ERROR: retry
      taskRun({ start: 90, minutes: 5 }),                                                      // after ENDED_OK, fresh: other
    ]);
    const out = classifyExtraRuns(t);
    expect(out.map((e) => e.class)).toEqual(["retry", "handoff", "other", "retry", "other"]);
  });

  it("a run that matches both a non-failure handoff row and an error predecessor is a handoff only", () => {
    const t = task([taskRun({ start: 0, minutes: 5, state: "ENDED_ERROR" }), taskRun({ start: 10, minutes: 5, handoffTrigger: "manual", originKind: "resume" })]);
    expect(classifyExtraRuns(t).map((e) => e.class)).toEqual(["handoff"]);
  });

  it("a legacy run has no origin: only an explicit failure row makes it a retry", () => {
    const t = task([taskRun({ start: 0, minutes: 5, state: "ENDED_ERROR", originKind: null }), taskRun({ start: 10, minutes: 5, originKind: null })]);
    expect(classifyExtraRuns(t).map((e) => e.class)).toEqual(["other"]);
  });

  it("adds the wait between runs and excludes compare and race tasks", () => {
    const t = task([taskRun({ start: 0, minutes: 10 }), taskRun({ start: 40, minutes: 5, handoffTrigger: "wake" })]);
    expect(classifyExtraRuns(t)[0]).toMatchObject({ durationMs: 5 * MIN, gapMs: 30 * MIN });
    expect(classifyExtraRuns({ ...t, mode: "race" })).toEqual([]);
    expect(classifyExtraRuns({ ...t, mode: "compare" })).toEqual([]);
  });
});

describe("selectTaskCohort", () => {
  it("never looks ahead of asOf and drops cancelled, live and parallel tasks", () => {
    const future = task([taskRun({ start: 400000, minutes: 10 })]);
    const cancelled = task([taskRun({ start: 0, minutes: 10, state: "CANCELLED" })]);
    const live = task([{ ...taskRun({ start: 0, minutes: 10 }), endedAt: null }]);
    const race = plain({ mode: "race" });
    const ok = many(3, () => plain());
    const { level, tasks } = selectTaskCohort({ assistantId: "claude", taskKind: "implementation" }, [future, cancelled, live, race, ...ok], ASOF);
    expect(level).toBe("assistant+kind");
    expect(tasks.map((t) => t.taskId).sort()).toEqual(ok.map((t) => t.taskId).sort());
  });

  it("falls back to the assistant, then to the narrowest non-empty level, then to none", () => {
    const other = many(3, () => plain({ taskKind: "review" }));
    expect(selectTaskCohort({ assistantId: "claude", taskKind: "implementation" }, other, ASOF).level).toBe("assistant");
    expect(selectTaskCohort({ assistantId: "claude", taskKind: "implementation" }, [plain()], ASOF).level).toBe("assistant+kind");
    expect(selectTaskCohort({ assistantId: "claude", taskKind: "implementation" }, [], ASOF)).toEqual({ level: "none", tasks: [] });
    expect(selectTaskCohort({ assistantId: null, taskKind: null }, other, ASOF).level).toBe("none");
  });
});

describe("estimateParent", () => {
  it("1. no history: every overhead part is null with its reason, totals are null and name what is missing", () => {
    const p = estimateParent([child("a")], [], { asOf: ASOF, parentTaskId: "P" });
    expect(p).toMatchObject({ estimatorVersion: PARENT_ESTIMATOR_VERSION, advisory: true, parentTaskId: "P" });
    for (const k of ["handoff", "retry", "verification"] as const) {
      expect(p.overhead[k]).toMatchObject({ status: "no-evidence", durationMs: null, expectedCount: null, confidence: "unknown" });
      expect(p.overhead[k].missing.length).toBeGreaterThan(0);
    }
    expect(p.overhead.planning).toMatchObject({ status: "not-applicable", durationMs: null });
    expect(p.totals.tokens).toEqual({ input: null, output: null });
    expect(p.totals.durationMs.serial).toBeNull();
    expect(p.totals.missing.join(" ")).toContain("child a: handoff: no comparable ended tasks");
    expect(p.totals.confidence).toBe("unknown");
  });

  it("no children: nothing is invented", () => {
    const p = estimateParent([], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    expect(p.totals.tokens).toEqual({ input: null, output: null });
    expect(p.totals.durationMs).toEqual({ serial: null, criticalPath: null, order: "none" });
    expect(p.totals.missing).toContain("no children");
  });

  it("2-4. measures handoff and retry from extra runs, and the wait between runs counts", () => {
    const p = estimateParent([child("a")], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    // retry: one failure-trigger run per task: 20 min run + 5 min gap (10 min base ended at 10, retry starts at 15).
    expect(p.overhead.retry).toMatchObject({ status: "observed", sampleSize: 4, expectedCount: { mean: 1, share: null }, durationMs: r(25 * MIN) });
    // handoff: one quota run per task: 5 min run + 15 min gap (retry ended at 35, handoff starts at 50).
    expect(p.overhead.handoff).toMatchObject({ status: "observed", expectedCount: { mean: 1, share: null }, durationMs: r(20 * MIN) });
    expect(p.overhead.retry.tokens.input).toEqual(r(1000));
    expect(p.overhead.retry.evidence.runIds).toHaveLength(4);
    expect(p.overhead.retry.confidence).toBe("medium");
  });

  it("an observed zero is evidence: a cohort with no extra runs measures zero overhead, not null", () => {
    const p = estimateParent([child("a")], many(3, () => plain()), { asOf: ASOF, parentTaskId: "P" });
    expect(p.overhead.handoff).toMatchObject({ status: "observed", expectedCount: { mean: 0, share: null }, durationMs: r(0) });
    expect(p.overhead.verification.status).toBe("no-evidence");
  });

  it("an extra run that is neither handoff nor retry is reported, not folded in", () => {
    const hist = many(3, () => task([taskRun({ start: seq * 100, minutes: 5 }), taskRun({ start: seq * 100 + 10, minutes: 5 })]));
    const p = estimateParent([child("a")], hist, { asOf: ASOF, parentTaskId: "P" });
    expect(p.overhead.handoff.durationMs).toEqual(r(0));
    expect(p.overhead.retry.durationMs).toEqual(r(0));
    expect(p.warnings.join(" ")).toContain("3 extra run(s)");
  });

  it("missing usage on an extra run leaves its token range null and says so", () => {
    const hist = many(3, () => task([taskRun({ start: seq * 100, minutes: 5 }), taskRun({ start: seq * 100 + 10, minutes: 5, handoffTrigger: "manual", tokens: null })]));
    const p = estimateParent([child("a")], hist, { asOf: ASOF, parentTaskId: "P" });
    expect(p.overhead.handoff.tokens).toEqual({ input: null, output: null });
    expect(p.overhead.handoff.missing.join(" ")).toContain("no usage evidence");
    expect(p.totals.tokens).toEqual({ input: null, output: null });
  });

  it("7. verification: completed Harness runs give a duration with zero tokens; interrupted are excluded; legacy is null", () => {
    const mk = (state: "completed" | "interrupted") => plain({ verificationRuns: [{ id: `v${seq}`, state, claimedAt: iso(0), updatedAt: iso(3) }] });
    const part = verificationPart({ level: "assistant+kind", tasks: [mk("completed"), mk("completed"), mk("completed"), mk("interrupted")] });
    expect(part).toMatchObject({ status: "observed", sampleSize: 3, durationMs: r(3 * MIN), tokens: { input: r(0), output: r(0) } });
    expect(part.method).toContain("no model tokens");
    const legacy = estimateParent([child("a", { harness: false })], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    expect(legacy.overhead.verification).toMatchObject({ status: "no-evidence", durationMs: null });
    expect(legacy.overhead.verification.missing.join(" ")).toContain("legacy run");
  });

  it("5. sums: totals equal the parts exactly, and a child without an estimate nulls them", () => {
    const hist = richHistory();
    const two = estimateParent([child("a"), child("b")], hist, { asOf: ASOF, parentTaskId: "P" });
    // Per child: run estimate 30 min, 100 in / 10 out; retry 25 min, handoff 20 min, verification 2 min; 1000 in / 100 out per extra run.
    expect(two.totals.durationMs.serial).toEqual(r(2 * (30 + 25 + 20 + 2) * MIN));
    expect(two.totals.tokens).toEqual({ input: r(2 * (100 + 1000 + 1000)), output: r(2 * (10 + 100 + 100)) });
    expect(two.overhead.retry.durationMs).toEqual(r(2 * 25 * MIN));
    expect(two.overhead.handoff.sampleSize).toBe(8);
    expect(two.totals.durationMs.order).toBe("none");
    expect(two.totals.durationMs.criticalPath).toBeNull();
    expect(two.totals.confidence).toBe("medium");
    const broken = estimateParent([child("a"), child("b", { estimate: null })], hist, { asOf: ASOF, parentTaskId: "P" });
    expect(broken.totals.tokens).toEqual({ input: null, output: null });
    expect(broken.totals.durationMs.serial).toBeNull();
    expect(broken.totals.missing).toContain("child b: no run estimate");
  });

  it("spend: a child's own and overhead cost go to the bucket its provider's billing names", () => {
    const api = estimateRun({ ...subject, assistantId: "router", provider: "openrouter", model: "m" }, runHistory(8, 30).map((h) => ({ ...h, assistantId: "router", provider: "openrouter", model: "m", modelRequested: "m" })), ectx);
    const hist = richHistory().map((t) => ({ ...t, assistantId: "router" }));
    const p = estimateParent([child("a", { assistantId: "router", estimate: api }), child("b")], [...hist, ...richHistory()], { asOf: ASOF, parentTaskId: "P" });
    expect(p.totals.spend.apiUsd).toEqual(r(2 + 1 + 1)); // run 2 + retry 1 + handoff 1
    expect(p.totals.spend.apiEquivalentUsd).toEqual(r(2 + 1 + 1));
  });

  it("6. critical path: a chain, a diamond and independent children", () => {
    const n = (id: string, minutes: number, dependsOn: string[] = []) => ({ id, weight: r(minutes * MIN), dependsOn });
    expect(criticalPath([n("a", 10), n("b", 20, ["a"]), n("c", 5, ["b"])]).range).toEqual(r(35 * MIN));
    expect(criticalPath([n("a", 10), n("b", 20, ["a"]), n("c", 5, ["a"]), n("d", 1, ["b", "c"])]).range).toEqual(r(31 * MIN));
    expect(criticalPath([n("a", 10), n("b", 20), n("c", 5)]).range).toEqual(r(20 * MIN));
    expect(criticalPath([n("a", 10, ["b"]), n("b", 20, ["a"])])).toEqual({ range: null, cycle: true });
    expect(criticalPath([n("a", 10), { id: "b", weight: null, dependsOn: [] }])).toEqual({ range: null, cycle: false });
    // Low, typical and high are independent scenarios.
    const wide = [{ id: "a", weight: { low: 1, typical: 5, high: 9 }, dependsOn: [] }, { id: "b", weight: { low: 4, typical: 2, high: 3 }, dependsOn: [] }];
    expect(criticalPath(wide).range).toEqual({ low: 4, typical: 5, high: 9 });
  });

  it("6. the parent's critical path is shorter than its serial sum when children declare an order", () => {
    const p = estimateParent([child("a"), child("b"), child("c", { dependsOn: ["a", "ghost"] })], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    const each = (30 + 25 + 20 + 2) * MIN;
    expect(p.totals.durationMs).toMatchObject({ serial: r(3 * each), criticalPath: r(2 * each), order: "dependency-waits" });
    expect(p.warnings.join(" ")).toContain("child c depends on ghost");
    const cyc = estimateParent([child("a", { dependsOn: ["b"] }), child("b", { dependsOn: ["a"] })], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    expect(cyc.totals.durationMs.criticalPath).toBeNull();
    expect(cyc.warnings.join(" ")).toContain("cycle");
  });

  it("sumRanges never presents a partial sum", () => {
    expect(sumRanges([r(1), r(2)])).toEqual(r(3));
    expect(sumRanges([r(1), null])).toBeNull();
    expect(sumRanges([])).toBeNull();
  });

  it("8. run-estimate/1 is untouched: the child's estimate is passed through unchanged", () => {
    const c = child("a");
    const before = JSON.stringify(c.estimate);
    const p = estimateParent([c], richHistory(), { asOf: ASOF, parentTaskId: "P" });
    expect(RUN_ESTIMATOR_VERSION).toBe("run-estimate/1");
    expect(p.children[0]!.estimate).toBe(c.estimate);
    expect(JSON.stringify(c.estimate)).toBe(before);
  });
});
