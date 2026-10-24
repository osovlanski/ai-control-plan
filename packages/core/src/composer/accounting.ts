/**
 * Token and cost accounting for stage 5 (plans/m2-composer.md §5). Pure functions over run usage
 * and usage records; the api reads the rows and calls these.
 *
 * - In-run usage follows the manifest's accounting: delta sums, cumulative takes the max, none
 *   contributes nothing (the api's `accumulateTokens`, per field).
 * - Usage records arrive already deduplicated on (provider, sessionRef, eventId). Cumulative takes
 *   the max and delta sums; when both kinds exist cumulative wins, because it subsumes the deltas.
 *   A cumulative value lower than one already seen is kept, ignored for the total and flagged
 *   `regressed`.
 * - Settled tokens for a session are max(in-run, records), never the sum (plan risk 5).
 * - A task's consumption is the sum over its sessions. Every figure is provisional while records
 *   may still arrive; each one reports the record count it used.
 * Tokens are input + output; cached tokens are not added, as in-run accounting does not add them.
 */
import type { BudgetCaps, ModelPrice } from "./types.js";

export type UsageAccountingMode = "delta" | "cumulative" | "none";
export interface TokenPair { input: number; output: number }
export interface UsageObservation { inputTokens?: number; outputTokens?: number }

/** One usage v1 record of a session, in arrival order. */
export interface SessionUsageRecord {
  eventId: string;
  accounting: "delta" | "cumulative";
  tokensIn: number;
  tokensOut: number;
  costUsd?: number | null;
  apiEquivalentUsd?: number;
}

export interface RecordTotals {
  method: "cumulative" | "delta" | "none";
  tokens: TokenPair;
  total: number;
  recordCount: number;
  /** Cumulative records lower than one already seen, in arrival order. */
  regressed: string[];
  /** Provider-measured cost: present only when every record the total rests on carries `costUsd`. */
  measuredCostUsd?: number;
  /** Subscription API-equivalent cost, on the same rule. */
  apiEquivalentUsd?: number;
}

export type CostMethod = "measured" | "estimated" | "unknown";

export interface SessionSettlement {
  /** Settled tokens: max(in-run, records). */
  tokens: number;
  source: "in_run" | "records";
  inRunTokens: number;
  recordTokens: number;
  recordCount: number;
  regressed: string[];
  cost: { method: CostMethod; usd?: number };
}

export interface TaskConsumption {
  tokens: number;
  /** Sum of the sessions whose cost is known. */
  costUsd: number;
  /** `none` when there are no sessions; `unknown` when any session's cost is unknown. */
  costMethod: CostMethod | "none";
  unknownCostSessions: number;
  sessions: number;
  recordCount: number;
}

export const NO_CONSUMPTION: TaskConsumption = { tokens: 0, costUsd: 0, costMethod: "none", unknownCostSessions: 0, sessions: 0, recordCount: 0 };

const count = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);
const total = (t: TokenPair) => t.input + t.output;
/** USD to a millionth, so float noise never reaches a digest or a ref. */
export const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** In-run token totals under the manifest's accounting mode, per field. */
export function accumulateInRun(mode: UsageAccountingMode, observations: readonly UsageObservation[]): TokenPair {
  if (mode === "none") return { input: 0, output: 0 };
  return observations.reduce<TokenPair>((acc, o) => {
    const input = count(o.inputTokens);
    const output = count(o.outputTokens);
    return mode === "cumulative"
      ? { input: Math.max(acc.input, input), output: Math.max(acc.output, output) }
      : { input: acc.input + input, output: acc.output + output };
  }, { input: 0, output: 0 });
}

const sumIfAll = (values: ReadonlyArray<number | null | undefined>): number | undefined =>
  values.length > 0 && values.every((v) => typeof v === "number" && Number.isFinite(v)) ? roundUsd((values as number[]).reduce((a, b) => a + b, 0)) : undefined;

/** Combines one session's usage records (§5 table). */
export function combineUsageRecords(records: readonly SessionUsageRecord[]): RecordTotals {
  const regressed: string[] = [];
  let best: SessionUsageRecord | undefined;
  for (const r of records) {
    if (r.accounting !== "cumulative") continue;
    const value = count(r.tokensIn) + count(r.tokensOut);
    if (!best) best = r;
    else if (value < count(best.tokensIn) + count(best.tokensOut)) regressed.push(r.eventId);
    else if (value > count(best.tokensIn) + count(best.tokensOut)) best = r;
  }
  if (best) {
    const tokens = { input: count(best.tokensIn), output: count(best.tokensOut) };
    return {
      method: "cumulative", tokens, total: total(tokens), recordCount: records.length, regressed,
      ...(typeof best.costUsd === "number" ? { measuredCostUsd: roundUsd(best.costUsd) } : {}),
      ...(typeof best.apiEquivalentUsd === "number" ? { apiEquivalentUsd: roundUsd(best.apiEquivalentUsd) } : {}),
    };
  }
  const deltas = records.filter((r) => r.accounting === "delta");
  if (!deltas.length) return { method: "none", tokens: { input: 0, output: 0 }, total: 0, recordCount: records.length, regressed };
  const tokens = deltas.reduce<TokenPair>((acc, r) => ({ input: acc.input + count(r.tokensIn), output: acc.output + count(r.tokensOut) }), { input: 0, output: 0 });
  const measured = sumIfAll(deltas.map((r) => r.costUsd));
  const apiEquivalent = sumIfAll(deltas.map((r) => r.apiEquivalentUsd));
  return {
    method: "delta", tokens, total: total(tokens), recordCount: records.length, regressed,
    ...(measured !== undefined ? { measuredCostUsd: measured } : {}),
    ...(apiEquivalent !== undefined ? { apiEquivalentUsd: apiEquivalent } : {}),
  };
}

/**
 * Settles one provider session: tokens are max(in-run, records). Cost is the provider's
 * `costUsd` (measured), else tokens × K7 price evidence (estimated), else the subscription
 * API-equivalent (estimated), else unknown, with no number.
 */
export function settleSession(input: { inRun: TokenPair; records: readonly SessionUsageRecord[]; price?: ModelPrice }): SessionSettlement {
  const records = combineUsageRecords(input.records);
  const inRun = { input: count(input.inRun.input), output: count(input.inRun.output) };
  const fromRecords = records.total > total(inRun);
  const settled = fromRecords ? records.tokens : inRun;
  let cost: SessionSettlement["cost"];
  if (records.measuredCostUsd !== undefined) cost = { method: "measured", usd: records.measuredCostUsd };
  else if (input.price) cost = { method: "estimated", usd: roundUsd((settled.input * input.price.inputPerMtok + settled.output * input.price.outputPerMtok) / 1e6) };
  else if (records.apiEquivalentUsd !== undefined) cost = { method: "estimated", usd: records.apiEquivalentUsd };
  else cost = { method: "unknown" };
  return {
    tokens: total(settled), source: fromRecords ? "records" : "in_run", inRunTokens: total(inRun), recordTokens: records.total,
    recordCount: records.recordCount, regressed: records.regressed, cost,
  };
}

/** A task's consumption: the sum over its runs' sessions. */
export function taskConsumption(sessions: readonly SessionSettlement[]): TaskConsumption {
  if (!sessions.length) return NO_CONSUMPTION;
  const unknown = sessions.filter((s) => s.cost.method === "unknown").length;
  const methods = new Set(sessions.map((s) => s.cost.method));
  return {
    tokens: sessions.reduce((n, s) => n + s.tokens, 0),
    costUsd: roundUsd(sessions.reduce((n, s) => n + (s.cost.usd ?? 0), 0)),
    costMethod: unknown ? "unknown" : methods.has("estimated") ? "estimated" : "measured",
    unknownCostSessions: unknown,
    sessions: sessions.length,
    recordCount: sessions.reduce((n, s) => n + s.recordCount, 0),
  };
}

export interface RemainingBudget {
  /** The remainder per cap; a cap at or below zero is listed in `exhausted`. */
  remaining: BudgetCaps;
  exhausted: Array<"max_tokens" | "max_cost_usd">;
}

/**
 * The task cap minus what the task consumed (Q9: caps are per task), so a failover revision gets
 * what remains. Runtime is a per-run hard timeout and is not consumed. A session with unknown
 * cost subtracts nothing; stage 5 says so.
 */
export function remainingBudget(caps: BudgetCaps, consumed: TaskConsumption): RemainingBudget {
  const remaining: BudgetCaps = {};
  const exhausted: RemainingBudget["exhausted"] = [];
  if (caps.max_tokens !== undefined) {
    remaining.max_tokens = caps.max_tokens - consumed.tokens;
    if (remaining.max_tokens <= 0) exhausted.push("max_tokens");
  }
  if (caps.max_cost_usd !== undefined) {
    remaining.max_cost_usd = roundUsd(caps.max_cost_usd - consumed.costUsd);
    if (remaining.max_cost_usd <= 0) exhausted.push("max_cost_usd");
  }
  if (caps.max_runtime_ms !== undefined) remaining.max_runtime_ms = caps.max_runtime_ms;
  return { remaining, exhausted };
}

/**
 * One of N candidates' share of a remainder (compare, race): tokens floor(R / N) and cost floored
 * to the micro-dollar, so N shares never sum past R. Runtime is a per-run timeout and is not
 * split. A share at or below zero is exhausted.
 */
export function shareBudget(budget: RemainingBudget, candidates: number): RemainingBudget {
  if (!Number.isSafeInteger(candidates) || candidates < 1) throw new Error(`budget share needs a positive candidate count, got ${candidates}`);
  const remaining: BudgetCaps = { ...budget.remaining };
  const exhausted: RemainingBudget["exhausted"] = [];
  if (remaining.max_tokens !== undefined) {
    remaining.max_tokens = Math.floor(remaining.max_tokens / candidates);
    if (remaining.max_tokens <= 0) exhausted.push("max_tokens");
  }
  if (remaining.max_cost_usd !== undefined) {
    remaining.max_cost_usd = Math.floor(Math.round(remaining.max_cost_usd * 1e6) / candidates) / 1e6;
    if (remaining.max_cost_usd <= 0) exhausted.push("max_cost_usd");
  }
  return { remaining, exhausted };
}

/**
 * The overrun a late record adds (§5 "Late and post-run behaviour"): how far `after` exceeds the
 * cap beyond what `before` already exceeded. `undefined` when it adds none. It never changes a
 * run's state; it only reduces the task's remainder.
 */
export function lateOverrun(cap: number, before: number, after: number): number | undefined {
  const added = after - Math.max(before, cap);
  return added > 0 ? added : undefined;
}
