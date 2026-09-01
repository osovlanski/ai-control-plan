import type { Db } from "../db/index.js";

export interface AssistantScore {
  assistantId: string;
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
        // Effective state derived at read time (execution-harness.md §5,
        // PLAN.md 8e): session_state is authoritative for harness rows,
        // runs.state (legacy-vocab-mapped) for legacy rows. No dual-write.
        // Harness rows never populate runs.usage, so fall back to the terminal
        // execution_results usage for them.
        `SELECT r.id, r.assistant_id,
           CASE WHEN r.execution_request_id IS NULL
             THEN CASE r.state WHEN 'ACTIVE' THEN 'RUNNING' WHEN 'ENDED_OK' THEN 'COMPLETED'
                               WHEN 'ENDED_ERROR' THEN 'FAILED' ELSE r.state END
             ELSE r.session_state END AS state,
           COALESCE(r.usage, json_extract(er.result, '$.usage')) AS usage,
           r.started_at, r.ended_at, t.goal
         FROM runs r
         JOIN tasks t ON t.id = r.task_id
         LEFT JOIN execution_results er ON er.session_id = r.id
         WHERE r.started_at >= ? AND r.ended_at IS NOT NULL`,
      )
      .all(since) as Array<{
      id: string;
      assistant_id: string;
      state: string;
      usage: string | null;
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
      score.runs += 1;
      if (row.state === "COMPLETED") score.successRate += 1;
      else score.errors += 1;
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
        `SELECT r.assistant_id, COUNT(*) AS n FROM handoffs h
         JOIN runs r ON r.id = h.from_run_id WHERE h.at >= ? GROUP BY r.assistant_id`,
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
