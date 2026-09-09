import type { ExecutionResult } from "@agent-plane/core";
import { modelKey, reliabilityClass } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { effectiveStateSql, effectiveUsageJoin, effectiveUsageSql } from "./harness/state-vocab.js";

export interface AssistantScore {
  assistantId: string;
  /**
   * Reliability SAMPLE count — sessions that said something about the provider.
   * Neutral lifecycle outcomes (a healthy K11 context yield, a cancellation) are
   * excluded, so they can neither inflate nor depress `successRate` (I-M4).
   */
  runs: number;
  successRate: number;
  /** Median wall-clock of completed runs, ms. Undefined until a run finishes. */
  medianDurationMs?: number;
  medianTokens?: number;
  testPassRate?: number;
  failovers: number;
  errors: number;
}

/**
 * Passive telemetry over runs the user actually asked for (review §3.3).
 *
 * Deliberately derived from the existing runs/events tables rather than a
 * denormalized score table: the event log is already the source of truth, and a
 * second copy would drift. No synthetic benchmark suite exists, and none should
 * — benchmarking these providers would burn the very subscription quota the
 * router is trying to preserve.
 */
export class TelemetryService {
  constructor(
    private db: Db,
    private windowDays = 30,
  ) {}

  /** Rolling scores per assistant, optionally narrowed to one kind of task. */
  scores(taskKind?: string): Map<string, AssistantScore> {
    const since = new Date(Date.now() - this.windowDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        // Effective state + usage derived at read time (execution-harness.md §5,
        // PLAN.md 8e) — see state-vocab.ts. No dual-write.
        `SELECT r.id, r.assistant_id,
           ${effectiveStateSql("r")} AS state,
           ${effectiveUsageSql("r")} AS usage,
           er.result AS result,
           r.started_at, r.ended_at, t.goal
         FROM runs r
         JOIN tasks t ON t.id = r.task_id
         ${effectiveUsageJoin("r")}
         WHERE r.started_at >= ? AND r.ended_at IS NOT NULL`,
      )
      .all(since) as Array<{
      id: string;
      assistant_id: string;
      state: string;
      usage: string | null;
      result: string | null;
      started_at: string;
      ended_at: string;
      goal: string;
    }>;

    const byAssistant = new Map<string, AssistantScore & { durations: number[]; tokens: number[] }>();
    for (const row of rows) {
      if (taskKind && classifyGoal(row.goal) !== taskKind) continue;
      let score = byAssistant.get(row.assistant_id);
      if (!score) {
        score = {
          assistantId: row.assistant_id,
          runs: 0,
          successRate: 0,
          failovers: 0,
          errors: 0,
          durations: [],
          tokens: [],
        };
        byAssistant.set(row.assistant_id, score);
      }
      // I-M4: one shared classifier decides what a session says about a
      // provider. A healthy K11 context yield (and a cancellation) is a
      // lifecycle event, not a fault AND not a completion — the work continues
      // in a clean session, so the predecessor is neither credited nor
      // penalized and stays out of the reliability denominator entirely.
      const reliability = reliabilityClass(reliabilityView(row.result, row.state));
      if (reliability !== "neutral") {
        score.runs += 1;
        if (reliability === "success") score.successRate += 1;
        else score.errors += 1;
      }
      const duration = Date.parse(row.ended_at) - Date.parse(row.started_at);
      if (Number.isFinite(duration) && duration >= 0) score.durations.push(duration);
      if (row.usage) {
        const usage = JSON.parse(row.usage) as { inputTokens?: number; outputTokens?: number };
        const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (total > 0) score.tokens.push(total);
      }
    }

    // Handoffs away from an assistant are a reliability signal the run state
    // alone does not carry.
    for (const row of this.db
      .prepare(
        // `trigger = 'context'` is a K11 continuation of the SAME work, not a
        // rescue by someone else — it is not a failover signal (I-M4).
        `SELECT r.assistant_id, COUNT(*) AS n FROM handoffs h
         JOIN runs r ON r.id = h.from_run_id
         WHERE h.at >= ? AND h.trigger != 'context' GROUP BY r.assistant_id`,
      )
      .all(since) as Array<{ assistant_id: string; n: number }>) {
      const score = byAssistant.get(row.assistant_id);
      if (score) score.failovers = row.n;
    }

    const tests = this.db
      .prepare(
        `SELECT r.assistant_id, e.payload FROM events e JOIN runs r ON r.id = e.run_id
         WHERE e.type = 'test.result' AND e.ts >= ?`,
      )
      .all(since) as Array<{ assistant_id: string; payload: string | null }>;
    const testTotals = new Map<string, { passed: number; failed: number }>();
    for (const row of tests) {
      if (!row.payload) continue;
      const parsed = JSON.parse(row.payload) as { passed?: number; failed?: number };
      const acc = testTotals.get(row.assistant_id) ?? { passed: 0, failed: 0 };
      acc.passed += parsed.passed ?? 0;
      acc.failed += parsed.failed ?? 0;
      testTotals.set(row.assistant_id, acc);
    }

    const result = new Map<string, AssistantScore>();
    for (const [id, score] of byAssistant) {
      const totals = testTotals.get(id);
      result.set(id, {
        assistantId: id,
        runs: score.runs,
        successRate: score.runs > 0 ? score.successRate / score.runs : 0,
        medianDurationMs: median(score.durations),
        medianTokens: median(score.tokens),
        testPassRate:
          totals && totals.passed + totals.failed > 0
            ? totals.passed / (totals.passed + totals.failed)
            : undefined,
        failovers: score.failovers,
        errors: score.errors,
      });
    }
    return result;
  }
}

/**
 * One K13 telemetry cohort: runs with the SAME resolved model, task kind and
 * harness major version, inside the rolling window (§4.4.3). Runs whose model
 * the provider never reported (`model_resolved` NULL) and runs recorded before
 * the harness major was stamped never join one — an unknown model is not a
 * model, and a cohort that silently absorbed them would be measuring something
 * else (I-M5).
 */
export interface ModelCohort {
  /** `provider:modelId` — the identity every evidence row joins on. */
  resolvedModelKey: string;
  taskKind: string;
  harnessMajor: string;
  windowDays: number;
  /** Reliability sample count. Neutral outcomes are excluded from it (I-M4). */
  reliabilityRuns: number;
  successRate: number;
  testPassRate?: number;
  verificationPassRate?: number;
  /** Runs that reported output tokens AND a duration — the speed sample. */
  outputRateRuns: number;
  medianOutputTokensPerSecond?: number;
  /** Completed runs whose usage is known — the cost sample. */
  usageRuns: number;
  medianInputTokens?: number;
  medianOutputTokens?: number;
}

/**
 * Rolling per-resolved-model cohorts for K13. Deliberately a second read over
 * the same tables the assistant-level scores use, sharing `reliabilityClass`
 * (I-M4) so a model cohort and an assistant score can never disagree about what
 * a session said.
 */
export function modelCohorts(
  db: Db,
  opts: { taskKind: string; harnessMajor: string; windowDays?: number; now?: () => Date },
): Map<string, ModelCohort> {
  const windowDays = opts.windowDays ?? 30;
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const since = new Date(nowMs - windowDays * 86_400_000).toISOString();

  const rows = db
    .prepare(
      `SELECT r.id, r.model_resolved AS model_resolved, a.provider AS provider,
         ${effectiveStateSql("r")} AS state,
         ${effectiveUsageSql("r")} AS usage,
         er.result AS result,
         r.started_at, r.ended_at, t.goal
       FROM runs r
       JOIN tasks t ON t.id = r.task_id
       JOIN assistants a ON a.id = r.assistant_id
       ${effectiveUsageJoin("r")}
       WHERE r.started_at >= ? AND r.ended_at IS NOT NULL
         AND r.model_resolved IS NOT NULL AND r.harness_major = ?`,
    )
    .all(since, opts.harnessMajor) as Array<{
    id: string;
    model_resolved: string;
    provider: string;
    state: string;
    usage: string | null;
    result: string | null;
    started_at: string;
    ended_at: string;
    goal: string;
  }>;

  interface Acc extends ModelCohort {
    successes: number;
    rates: number[];
    inputs: number[];
    outputs: number[];
    runIds: string[];
  }
  const byModel = new Map<string, Acc>();
  for (const row of rows) {
    if (classifyGoal(row.goal) !== opts.taskKind) continue;
    const key = modelKey(row.provider, row.model_resolved);
    let acc = byModel.get(key);
    if (!acc) {
      acc = {
        resolvedModelKey: key, taskKind: opts.taskKind, harnessMajor: opts.harnessMajor, windowDays,
        reliabilityRuns: 0, successRate: 0, outputRateRuns: 0, usageRuns: 0,
        successes: 0, rates: [], inputs: [], outputs: [], runIds: [],
      };
      byModel.set(key, acc);
    }
    acc.runIds.push(row.id);
    // The SAME classifier the assistant aggregates use: a healthy context yield
    // and a cancellation are neutral — out of numerator and denominator both.
    const reliability = reliabilityClass(reliabilityView(row.result, row.state));
    if (reliability !== "neutral") {
      acc.reliabilityRuns += 1;
      if (reliability === "success") acc.successes += 1;
    }
    const durationMs = Date.parse(row.ended_at) - Date.parse(row.started_at);
    const usage = row.usage ? (JSON.parse(row.usage) as { inputTokens?: number; outputTokens?: number }) : undefined;
    if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      acc.usageRuns += 1;
      acc.inputs.push(usage.inputTokens ?? 0);
      acc.outputs.push(usage.outputTokens ?? 0);
      // Own output RATE, measured over run wall-clock. Named precisely because
      // it is NOT the provider-side generation rate an external benchmark
      // reports — the explanation carries both metric names so the difference
      // is visible rather than blended away silently.
      if ((usage.outputTokens ?? 0) > 0 && Number.isFinite(durationMs) && durationMs > 0) {
        acc.outputRateRuns += 1;
        acc.rates.push((usage.outputTokens ?? 0) / (durationMs / 1000));
      }
    }
  }

  const out = new Map<string, ModelCohort>();
  for (const [key, acc] of byModel) {
    const tests = testAndVerificationRates(db, acc.runIds);
    out.set(key, {
      resolvedModelKey: acc.resolvedModelKey, taskKind: acc.taskKind, harnessMajor: acc.harnessMajor,
      windowDays: acc.windowDays,
      reliabilityRuns: acc.reliabilityRuns,
      successRate: acc.reliabilityRuns > 0 ? acc.successes / acc.reliabilityRuns : 0,
      ...(tests.testPassRate !== undefined ? { testPassRate: tests.testPassRate } : {}),
      ...(tests.verificationPassRate !== undefined ? { verificationPassRate: tests.verificationPassRate } : {}),
      outputRateRuns: acc.outputRateRuns,
      ...(median(acc.rates) !== undefined ? { medianOutputTokensPerSecond: median(acc.rates)! } : {}),
      usageRuns: acc.usageRuns,
      ...(median(acc.inputs) !== undefined ? { medianInputTokens: median(acc.inputs)! } : {}),
      ...(median(acc.outputs) !== undefined ? { medianOutputTokens: median(acc.outputs)! } : {}),
    });
  }
  return out;
}

/** Test and verification pass rates for exactly the runs in one cohort. */
function testAndVerificationRates(
  db: Db,
  runIds: string[],
): { testPassRate?: number; verificationPassRate?: number } {
  if (runIds.length === 0) return {};
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT type, payload FROM events
        WHERE run_id IN (${placeholders}) AND type IN ('test.result', 'verification.result')`,
    )
    .all(...runIds) as Array<{ type: string; payload: string | null }>;
  let passed = 0;
  let failed = 0;
  let verificationPassed = 0;
  let verificationTotal = 0;
  for (const row of rows) {
    if (!row.payload) continue;
    const parsed = JSON.parse(row.payload) as { passed?: number | boolean; failed?: number };
    if (row.type === "test.result") {
      passed += typeof parsed.passed === "number" ? parsed.passed : 0;
      failed += parsed.failed ?? 0;
    } else {
      verificationTotal += 1;
      if (parsed.passed === true) verificationPassed += 1;
    }
  }
  return {
    ...(passed + failed > 0 ? { testPassRate: passed / (passed + failed) } : {}),
    ...(verificationTotal > 0 ? { verificationPassRate: verificationPassed / verificationTotal } : {}),
  };
}

/**
 * Project a run row onto the shape {@link reliabilityClass} reads. Legacy
 * rows without a persisted `ExecutionResult` fall back to the run state, which
 * is exactly what this file used before K11.
 */
function reliabilityView(resultJson: string | null, state: string): Pick<ExecutionResult, "outcome" | "yield"> {
  if (resultJson) {
    try {
      const parsed = JSON.parse(resultJson) as ExecutionResult;
      if (parsed?.outcome) return { outcome: parsed.outcome, yield: parsed.yield };
    } catch {
      // fall through to the state-only view
    }
  }
  if (state === "COMPLETED") return { outcome: "completed" };
  // A cancelled run is a human/plane decision. Reading it as `failed` charged
  // the provider for a decision it never made.
  if (state === "CANCELLED") return { outcome: "cancelled" };
  return { outcome: "failed" };
}

/** Cheap task-kind heuristic — no LLM call on the routing path (review §3.3). */
export function classifyGoal(goal: string): "coding" | "review" | "research" | "general" {
  const text = goal.toLowerCase();
  if (/\breview|audit|critique\b/.test(text)) return "review";
  if (/\bfix|implement|refactor|add|bug|test|build|migrate\b/.test(text)) return "coding";
  if (/\bresearch|investigate|compare|explain|why\b/.test(text)) return "research";
  return "general";
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}
