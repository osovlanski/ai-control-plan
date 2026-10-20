import { describe, expect, it } from "vitest";
import {
  accumulateInRun, combineUsageRecords, lateOverrun, NO_CONSUMPTION, remainingBudget, settleSession, taskConsumption,
  type SessionUsageRecord,
} from "../../src/index.js";

const delta = (eventId: string, tokensIn: number, tokensOut: number, costUsd?: number): SessionUsageRecord => ({ eventId, accounting: "delta", tokensIn, tokensOut, ...(costUsd !== undefined ? { costUsd } : {}) });
const cumulative = (eventId: string, tokensIn: number, tokensOut: number, costUsd?: number): SessionUsageRecord => ({ eventId, accounting: "cumulative", tokensIn, tokensOut, ...(costUsd !== undefined ? { costUsd } : {}) });

describe("in-run accounting", () => {
  it.each([
    ["delta sums", "delta", [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3 }], { input: 13, output: 5 }],
    ["cumulative takes the max per field", "cumulative", [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 8, outputTokens: 9 }], { input: 10, output: 9 }],
    ["none contributes nothing", "none", [{ inputTokens: 10, outputTokens: 5 }], { input: 0, output: 0 }],
  ] as const)("%s", (_name, mode, observations, expected) => {
    expect(accumulateInRun(mode, observations)).toEqual(expected);
  });
});

describe("usage-record combination (§5 table)", () => {
  it.each<[string, SessionUsageRecord[], { method: string; total: number; regressed: string[] }]>([
    ["delta sums", [delta("e1", 100, 10), delta("e2", 50, 5)], { method: "delta", total: 165, regressed: [] }],
    ["cumulative takes the max", [cumulative("e1", 100, 10), cumulative("e2", 300, 30)], { method: "cumulative", total: 330, regressed: [] }],
    ["a lower cumulative is regressed and ignored", [cumulative("e1", 300, 30), cumulative("e2", 100, 10), cumulative("e3", 400, 0)], { method: "cumulative", total: 400, regressed: ["e2"] }],
    ["an equal cumulative is not regressed", [cumulative("e1", 100, 0), cumulative("e2", 50, 50)], { method: "cumulative", total: 100, regressed: [] }],
    ["mixed: cumulative wins over deltas", [delta("d1", 1000, 0), cumulative("c1", 200, 20), delta("d2", 5, 0)], { method: "cumulative", total: 220, regressed: [] }],
    ["no records", [], { method: "none", total: 0, regressed: [] }],
  ])("%s", (_name, records, expected) => {
    const r = combineUsageRecords(records);
    expect({ method: r.method, total: r.total, regressed: r.regressed }).toEqual(expected);
    expect(r.recordCount).toBe(records.length);
  });

  it("measured cost: deltas only when every delta carries costUsd; cumulative from the winning record", () => {
    expect(combineUsageRecords([delta("e1", 1, 1, 0.1), delta("e2", 1, 1, 0.2)]).measuredCostUsd).toBe(0.3);
    expect(combineUsageRecords([delta("e1", 1, 1, 0.1), delta("e2", 1, 1)]).measuredCostUsd).toBeUndefined();
    expect(combineUsageRecords([cumulative("e1", 1, 1, 0.1), cumulative("e2", 5, 5, 0.4)]).measuredCostUsd).toBe(0.4);
  });
});

describe("session settlement: max(in-run, records), never the sum", () => {
  it.each<[string, { input: number; output: number }, SessionUsageRecord[], number, string]>([
    ["in-run only", { input: 900, output: 100 }, [], 1000, "in_run"],
    ["late delta records below the in-run total do not add", { input: 900, output: 100 }, [delta("late1", 300, 0)], 1000, "in_run"],
    ["a late cumulative above the in-run total wins", { input: 900, output: 100 }, [cumulative("late1", 1400, 100)], 1500, "records"],
    ["records equal to in-run: no double count", { input: 500, output: 0 }, [delta("e1", 250, 0), delta("e2", 250, 0)], 500, "in_run"],
    ["no in-run accounting: records only", { input: 0, output: 0 }, [delta("e1", 40, 2)], 42, "records"],
  ])("%s", (_name, inRun, records, tokens, source) => {
    const s = settleSession({ inRun, records });
    expect(s.tokens).toBe(tokens);
    expect(s.source).toBe(source);
    expect(s.recordCount).toBe(records.length);
  });

  it.each<[string, Parameters<typeof settleSession>[0], { method: string; usd?: number }]>([
    ["measured wins", { inRun: { input: 0, output: 0 }, records: [delta("e1", 1000, 0, 0.05)], price: { pricingVersion: "p1", inputPerMtok: 3, outputPerMtok: 15 } }, { method: "measured", usd: 0.05 }],
    ["estimated from price", { inRun: { input: 1_000_000, output: 100_000 }, records: [], price: { pricingVersion: "p1", inputPerMtok: 3, outputPerMtok: 15 } }, { method: "estimated", usd: 4.5 }],
    ["estimated from apiEquivalentUsd", { inRun: { input: 0, output: 0 }, records: [{ ...delta("e1", 10, 0), apiEquivalentUsd: 0.25 }] }, { method: "estimated", usd: 0.25 }],
    ["unknown, no number", { inRun: { input: 10, output: 0 }, records: [] }, { method: "unknown" }],
  ])("cost: %s", (_name, input, cost) => {
    expect(settleSession(input).cost).toEqual(cost);
  });
});

describe("task consumption and remainder", () => {
  it("sums sessions; any unknown cost makes the method unknown and is counted", () => {
    const a = settleSession({ inRun: { input: 100, output: 0 }, records: [delta("e1", 10, 0, 0.5)] });
    const b = settleSession({ inRun: { input: 50, output: 0 }, records: [] });
    expect(taskConsumption([a, b])).toEqual({ tokens: 150, costUsd: 0.5, costMethod: "unknown", unknownCostSessions: 1, sessions: 2, recordCount: 1 });
    expect(taskConsumption([])).toEqual(NO_CONSUMPTION);
  });

  it("remainder is cap minus consumed; at or below zero is exhausted; runtime is not consumed", () => {
    const consumed = { ...NO_CONSUMPTION, tokens: 1200, costUsd: 0.75 };
    expect(remainingBudget({ max_tokens: 1000, max_cost_usd: 1, max_runtime_ms: 60000 }, consumed)).toEqual({
      remaining: { max_tokens: -200, max_cost_usd: 0.25, max_runtime_ms: 60000 }, exhausted: ["max_tokens"],
    });
    expect(remainingBudget({}, consumed)).toEqual({ remaining: {}, exhausted: [] });
  });

  it.each([
    ["under the cap", 1000, 500, 900, undefined],
    ["crosses the cap", 1000, 900, 1100, 100],
    ["already over: only the increment", 1000, 1100, 1300, 200],
    ["no growth", 1000, 1100, 1100, undefined],
  ])("late overrun: %s", (_name, cap, before, after, overrun) => {
    expect(lateOverrun(cap, before, after)).toBe(overrun);
  });
});
