/**
 * M2 S6 budget settlement (plans/m2-composer.md §5): reads the rows and hands them to core's pure
 * accounting (`settleSession`, `taskConsumption`, `remainingBudget`, `lateOverrun`).
 *
 * - A session is a run. Its in-run tokens are the terminal result's usage when there is one,
 *   otherwise its `usage.updated` events under the manifest's accounting mode. Its late tokens are
 *   the `usage_records` bound to it (already deduplicated by the ledger). Settled tokens are
 *   max(in-run, records), never the sum.
 * - Cost is measured (`costUsd`), else estimated from K7 price evidence for the run's model, else
 *   the subscription API-equivalent, else unknown with no number.
 * - Every figure is provisional: records may still arrive. Each read reports the record count.
 * - A revision's caps are the task's remainder when it was composed, so "over its cap" is what the
 *   runs bound to that revision settled, against those caps. An overrun is appended to the run's
 *   timeline as `budget.overrun`; it never changes a run's state, verdict or settlement.
 *
 * Nothing here writes except `recordOverruns`, which only appends events.
 */
import {
  accumulateInRun, lateOverrun, remainingBudget, roundUsd, settleSession, taskConsumption,
  type AgentSpec, type BudgetCaps, type BudgetOverrunPayload, type SessionSettlement, type SessionUsageRecord, type TaskConsumption, type UsageAccountingMode,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import type { ModelCatalogService } from "../model-catalog.js";
import type { Registry } from "../registry.js";
import { modelPrice } from "./ports.js";

export interface TaskAccountingDeps {
  db: Db;
  config: ResolvedConfig;
  registry: Registry;
  catalog?: ModelCatalogService;
  now?: () => Date;
}

/** One run's settlement, with what it rests on. */
export interface RunSettlement extends SessionSettlement {
  runId: string;
  assistantId: string;
  compositionRevisionId: string | null;
  model: string | null;
  accounting: UsageAccountingMode;
}

type CapKey = BudgetOverrunPayload["cap"];

/** A `budget.overrun` event, located on its run's timeline. */
export type OverrunEvent = BudgetOverrunPayload & { runId: string; seq: number };

interface RunRow {
  id: string; assistant_id: string; composition_revision_id: string | null; model_requested: string | null; model_resolved: string | null;
  result_usage: string | null;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class TaskAccounting {
  constructor(private readonly d: TaskAccountingDeps) {}

  private iso(): string { return (this.d.now ? this.d.now() : new Date()).toISOString(); }

  /** Every run of a task, settled, oldest first. */
  runs(taskId: string): RunSettlement[] {
    return this.settle(this.d.db.prepare(
      `SELECT r.id, r.assistant_id, r.composition_revision_id, r.model_requested, r.model_resolved,
              json_extract(er.result, '$.usage') AS result_usage
         FROM runs r LEFT JOIN execution_results er ON er.session_id = r.id
        WHERE r.task_id = ? ORDER BY r.started_at, r.rowid`,
    ).all(taskId) as RunRow[]);
  }

  /** The runs bound to one revision, settled. */
  revisionRuns(compositionRevisionId: string): RunSettlement[] {
    return this.settle(this.d.db.prepare(
      `SELECT r.id, r.assistant_id, r.composition_revision_id, r.model_requested, r.model_resolved,
              json_extract(er.result, '$.usage') AS result_usage
         FROM runs r LEFT JOIN execution_results er ON er.session_id = r.id
        WHERE r.composition_revision_id = ? ORDER BY r.started_at, r.rowid`,
    ).all(compositionRevisionId) as RunRow[]);
  }

  /** What the task has consumed so far, over all its runs: stage 5's `consumed` input. */
  consumption(taskId: string): TaskConsumption {
    return taskConsumption(this.runs(taskId));
  }

  /** A revision's policy budget, as persisted. */
  revisionBudget(compositionRevisionId: string): BudgetCaps | undefined {
    const row = this.d.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?").get(compositionRevisionId) as { spec_json: string } | undefined;
    return row ? (JSON.parse(row.spec_json) as AgentSpec).policy.budget : undefined;
  }

  /**
   * The task caps the task's latest revision was composed against, before stage 5 subtracted
   * consumption, or undefined when the task has no revision. Its persisted `policy.budget` is the
   * remainder, so carrying that and subtracting consumption again would count it twice. Stage 5
   * records each cap as "task cap C, consumed U, remaining R" on the chosen `max_*:R` candidate;
   * C is read back only when C - U is R. A compare or race candidate's chosen cap is its share S,
   * stated as "parallel share 1 of N: S" beside the task's line, and C is read back when S is no
   * more than R. Runtime is never consumed, so its remainder is its cap. A cap whose line is missing
   * or inconsistent carries the remainder: tighter, never looser.
   */
  latestTaskCaps(taskId: string): BudgetCaps | undefined {
    const row = this.d.db.prepare(
      `SELECT s.spec_json, d.decision_json FROM agent_specs s
         JOIN composition_decisions d ON d.composition_revision_id = s.composition_revision_id
        WHERE s.task_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
    ).get(taskId) as { spec_json: string; decision_json: string } | undefined;
    if (!row) return undefined;
    const remaining = (JSON.parse(row.spec_json) as AgentSpec).policy.budget;
    const policy = (JSON.parse(row.decision_json) as { stages?: Array<{ stage: string; candidates?: Array<{ ref: string; evidence?: string[] }> }> })
      .stages?.find((s) => s.stage === "policy");
    const taskCap = (key: "max_tokens" | "max_cost_usd", left: number): number => {
      const evidence = policy?.candidates?.find((c) => c.ref === `${key}:${left}`)?.evidence ?? [];
      const shared = evidence.some((line) => {
        const m = /^parallel share 1 of ([1-9]\d*): (\S+)$/.exec(line);
        return m !== null && Number(m[2]) === left;
      });
      const caps = evidence.flatMap((line) => {
        const m = /^task cap (\S+), consumed (\S+), remaining (\S+)$/.exec(line);
        if (!m) return [];
        const [cap, used, rest] = [Number(m[1]), Number(m[2]), Number(m[3])];
        const exact = key === "max_cost_usd" ? roundUsd(cap - used) === rest : cap - used === rest;
        const chosen = shared ? left <= rest : rest === left;
        return Number.isFinite(cap) && Number.isFinite(used) && chosen && exact && cap >= rest ? [cap] : [];
      });
      return caps.length ? Math.min(...caps) : left;
    };
    return {
      ...(remaining.max_tokens !== undefined ? { max_tokens: taskCap("max_tokens", remaining.max_tokens) } : {}),
      ...(remaining.max_cost_usd !== undefined ? { max_cost_usd: taskCap("max_cost_usd", remaining.max_cost_usd) } : {}),
      ...(remaining.max_runtime_ms !== undefined ? { max_runtime_ms: remaining.max_runtime_ms } : {}),
    };
  }

  /**
   * What remains under one revision's caps after the runs bound to it. A same-assistant K11
   * continuation that reuses the revision runs on this, so a reuse cannot reset spending.
   */
  revisionRemaining(compositionRevisionId: string) {
    const caps = this.revisionBudget(compositionRevisionId) ?? {};
    return remainingBudget(caps, taskConsumption(this.revisionRuns(compositionRevisionId)));
  }

  /**
   * `GET /api/tasks/:id/composition/budget`. The task caps are the workspace's (Q9: per task); the
   * latest revision's caps are what its runs execute under.
   */
  budget(taskId: string) {
    const b = this.d.config.composer.policy.budget;
    const caps: BudgetCaps = {
      ...(b.maxTokens !== undefined ? { max_tokens: b.maxTokens } : {}),
      ...(b.maxCostUsd !== undefined ? { max_cost_usd: b.maxCostUsd } : {}),
      ...(b.maxRuntimeMs !== undefined ? { max_runtime_ms: b.maxRuntimeMs } : {}),
    };
    const runs = this.runs(taskId);
    const consumed = taskConsumption(runs);
    const { remaining, exhausted } = remainingBudget(caps, consumed);
    const latest = this.d.db.prepare(
      "SELECT composition_revision_id FROM agent_specs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(taskId) as { composition_revision_id: string } | undefined;
    return {
      taskId,
      // Records may still arrive for any run; there is no close date.
      provisional: true,
      caps,
      consumed,
      remaining,
      exhausted,
      latestRevision: latest
        ? { compositionRevisionId: latest.composition_revision_id, caps: this.revisionBudget(latest.composition_revision_id) ?? {}, ...this.revisionRemaining(latest.composition_revision_id) }
        : null,
      runs: runs.map((r) => ({
        runId: r.runId, assistantId: r.assistantId, compositionRevisionId: r.compositionRevisionId, model: r.model, accounting: r.accounting,
        tokens: r.tokens, source: r.source, inRunTokens: r.inRunTokens, recordTokens: r.recordTokens, recordCount: r.recordCount,
        regressed: r.regressed, cost: r.cost,
      })),
      overruns: this.overruns(taskId),
    };
  }

  /** The `budget.overrun` events of a task's runs, oldest first. */
  overruns(taskId: string): OverrunEvent[] {
    return (this.d.db.prepare(
      `SELECT e.run_id, e.seq, e.payload FROM events e JOIN runs r ON r.id = e.run_id
        WHERE r.task_id = ? AND e.type = 'budget.overrun' ORDER BY e.id`,
    ).all(taskId) as Array<{ run_id: string; seq: number; payload: string }>)
      .map((r) => ({ runId: r.run_id, seq: r.seq, ...(JSON.parse(r.payload) as BudgetOverrunPayload) }));
  }

  /**
   * Appends a `budget.overrun` event to `runId` for each cap of its revision that the revision's
   * runs now settle past, by the amount not already recorded. Idempotent: a replayed record or a
   * second settle adds nothing. A run with no revision has no caps, so nothing to overrun.
   */
  recordOverruns(runId: string, source: OverrunEvent["source"]): OverrunEvent[] {
    return this.d.db.transaction(() => {
      const run = this.d.db.prepare("SELECT composition_revision_id FROM runs WHERE id = ?").get(runId) as { composition_revision_id: string | null } | undefined;
      const revision = run?.composition_revision_id;
      if (!revision) return [];
      const caps = this.revisionBudget(revision);
      if (!caps) return [];
      const consumed = taskConsumption(this.revisionRuns(revision));
      const prior = (this.d.db.prepare(
        `SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id
          WHERE r.composition_revision_id = ? AND e.type = 'budget.overrun'`,
      ).all(revision) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as { cap: CapKey; amount: number });
      const recorded = (cap: CapKey) => prior.filter((p) => p.cap === cap).reduce((n, p) => n + p.amount, 0);
      const appended: OverrunEvent[] = [];
      const check = (cap: CapKey, capValue: number | undefined, settled: number, method: string) => {
        if (capValue === undefined) return;
        // What `settled` exceeds the cap by, beyond what earlier events already recorded.
        const already = recorded(cap);
        const added = lateOverrun(capValue, capValue + already, settled);
        if (added === undefined) return;
        const amount = cap === "max_cost_usd" ? roundUsd(added) : added;
        if (amount <= 0) return;
        const payload: BudgetOverrunPayload = { compositionRevisionId: revision, cap, capValue, settled, amount, source, method };
        appended.push({ runId, seq: this.appendEvent(runId, payload), ...payload });
      };
      check("max_tokens", caps.max_tokens, consumed.tokens, "tokens");
      // Cost is advisory until deferral #3 closes; only sessions with a known cost count toward it.
      if (consumed.costMethod !== "none") check("max_cost_usd", caps.max_cost_usd, consumed.costUsd, consumed.costMethod);
      return appended;
    })();
  }

  private appendEvent(runId: string, payload: BudgetOverrunPayload): number {
    const { n } = this.d.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE run_id = ?").get(runId) as { n: number };
    const unit = payload.cap === "max_tokens" ? "tokens" : "USD";
    this.d.db.prepare("INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES (?, ?, ?, 'budget.overrun', ?, ?)").run(
      runId, n, this.iso(),
      `budget overrun (${payload.source}): ${payload.cap} ${payload.capValue} exceeded by ${payload.amount} ${unit} under ${payload.compositionRevisionId}`,
      JSON.stringify(payload),
    );
    return n;
  }

  private settle(rows: RunRow[]): RunSettlement[] {
    const assistants = new Map(this.d.registry.list().map((a) => [a.id, a]));
    const records = this.d.db.prepare(
      `SELECT event_id, accounting, tokens_in, tokens_out, cost_usd, api_equivalent_usd
         FROM usage_records WHERE run_id = ? ORDER BY received_at, rowid`,
    );
    const usageEvents = this.d.db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'usage.updated' ORDER BY seq");
    return rows.map((r) => {
      const assistant = assistants.get(r.assistant_id);
      const manifestMode: UsageAccountingMode = assistant?.manifestParsed?.harness?.usageAccounting ?? "none";
      const resultUsage = r.result_usage ? (JSON.parse(r.result_usage) as { inputTokens?: number; outputTokens?: number; accounting?: UsageAccountingMode }) : undefined;
      let accounting: UsageAccountingMode;
      let inRun: { input: number; output: number };
      if (resultUsage) {
        // The terminal result already accumulated the run under its own accounting mode.
        accounting = resultUsage.accounting ?? manifestMode;
        inRun = { input: isFiniteNumber(resultUsage.inputTokens) ? resultUsage.inputTokens : 0, output: isFiniteNumber(resultUsage.outputTokens) ? resultUsage.outputTokens : 0 };
      } else {
        accounting = manifestMode;
        const observations = (usageEvents.all(r.id) as Array<{ payload: string | null }>).map((e) => {
          try { return e.payload ? (JSON.parse(e.payload) as { inputTokens?: number; outputTokens?: number }) : {}; } catch { return {}; }
        });
        inRun = accumulateInRun(accounting, observations);
      }
      const sessionRecords: SessionUsageRecord[] = (records.all(r.id) as Array<{
        event_id: string; accounting: "delta" | "cumulative"; tokens_in: number; tokens_out: number; cost_usd: number | null; api_equivalent_usd: number;
      }>).map((x) => ({ eventId: x.event_id, accounting: x.accounting, tokensIn: x.tokens_in, tokensOut: x.tokens_out, costUsd: x.cost_usd, apiEquivalentUsd: x.api_equivalent_usd }));
      const model = r.model_resolved ?? r.model_requested ?? assistant?.manifestParsed?.core.models[0]?.id ?? null;
      const price = model && assistant ? modelPrice(this.d, r.assistant_id, assistant.provider, model) : undefined;
      const settled = settleSession({ inRun, records: sessionRecords, ...(price ? { price } : {}) });
      return { runId: r.id, assistantId: r.assistant_id, compositionRevisionId: r.composition_revision_id, model, accounting, ...settled };
    });
  }
}
