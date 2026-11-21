/**
 * qcq-01: advisory run estimates and scheduling recommendations (`GET /api/tasks/:id/estimate`) and
 * their measured accuracy (`GET /api/estimates/accuracy`).
 *
 * Read-only. The proposed runtime comes from the same pure route inputs the router uses
 * (`routeInputs` + `route`, nothing persisted); history comes from the durable run, usage and
 * approval records; the quota view is the same `QuotaProjection` routing reads. Core's pure
 * `estimateRun` / `recommendSchedule` / `backtestEstimates` do the arithmetic. Nothing here writes,
 * reserves, enforces or schedules, and no dispatch path reads it.
 */
import {
  backtestEstimates, estimateRun, recommendSchedule,
  type AccuracyReport, type EstimateContext, type EstimateSubject, type HistoricalRun, type RunEstimate, type ScheduleRecommendation,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import { defaultSchedulingPolicy } from "../config.js";
import type { Db } from "../db/index.js";
import type { CooldownStore } from "./cooldown.js";
import { TaskAccounting } from "./composer/accounting.js";
import type { ModelCatalogService } from "./model-catalog.js";
import { controllingRetry } from "./quota.js";
import type { Registry } from "./registry.js";
import { explainRoute, route, routeInputs } from "./router.js";
import type { TaskStore } from "./tasks.js";
import { taskKindOf } from "./telemetry.js";

export interface RunEstimateDeps {
  db: Db; config: ResolvedConfig; tasks: TaskStore; registry: Registry; cooldowns: CooldownStore;
  now: () => Date; catalog?: ModelCatalogService;
}

export interface EstimateOptions {
  /** ISO instant the result is needed by. */
  deadline?: string;
  /** A human approval (for example a budget approval) must precede the start. */
  approvalRequired?: boolean;
  /** What-if: estimate as if this assistant were pinned. */
  assistantId?: string;
}

export interface TaskEstimate {
  taskId: string;
  advisory: true;
  routing: { chosen: string | null; ruleFired: string; whatIf: boolean };
  estimate: RunEstimate;
  recommendation: ScheduleRecommendation;
  policy: { timezone: string; eveningsAllowed: boolean; weekendsAllowed: boolean };
}

/** How many ended runs the estimator reads. Newest first. */
const HISTORY_LIMIT = 500;
const LIVE_STATES = ["STARTING", "ACTIVE"];

export class RunEstimates {
  constructor(private readonly d: RunEstimateDeps) {}

  private policy() { return this.d.config.scheduling ?? defaultSchedulingPolicy(this.d.config.workspace); }

  /** Ended runs, newest first, with settled usage and answered approval waits. */
  history(limit = HISTORY_LIMIT): HistoricalRun[] {
    const rows = this.d.db.prepare(
      `SELECT r.id, r.task_id, r.assistant_id, r.state, r.started_at, r.ended_at, r.model_requested, r.model_resolved,
              t.goal, t.task_kind, t.classifier_version, a.provider
         FROM runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN assistants a ON a.id = r.assistant_id
        WHERE r.ended_at IS NOT NULL ORDER BY r.ended_at DESC, r.rowid DESC LIMIT ?`,
    ).all(limit) as Array<{
      id: string; task_id: string; assistant_id: string; state: string; started_at: string; ended_at: string;
      model_requested: string | null; model_resolved: string | null; goal: string; task_kind: string | null; classifier_version: number | null; provider: string | null;
    }>;
    const settled = new Map(new TaskAccounting({ db: this.d.db, config: this.d.config, registry: this.d.registry, ...(this.d.catalog ? { catalog: this.d.catalog } : {}), now: this.d.now })
      .settleRunIds(rows.map((r) => r.id)).map((s) => [s.runId, s]));
    const approvals = this.d.db.prepare("SELECT created_at, answered_at FROM approvals WHERE session_id = ? AND answered_at IS NOT NULL");
    return rows.map((r) => {
      const s = settled.get(r.id);
      const hasUsage = s !== undefined && (s.tokens > 0 || s.recordCount > 0);
      const waits = (approvals.all(r.id) as Array<{ created_at: string; answered_at: string }>)
        .map((a) => Date.parse(a.answered_at) - Date.parse(a.created_at)).filter((ms) => Number.isFinite(ms) && ms >= 0);
      return {
        runId: r.id, taskId: r.task_id, assistantId: r.assistant_id, provider: r.provider,
        model: r.model_resolved ?? r.model_requested, modelRequested: r.model_requested,
        taskKind: taskKindOf({ goal: r.goal, task_kind: r.task_kind, classifier_version: r.classifier_version }),
        startedAt: r.started_at, endedAt: r.ended_at, state: r.state,
        tokens: hasUsage ? s!.split : null,
        costUsd: s?.cost.usd ?? null, costMethod: s?.cost.method ?? "unknown",
        approvalWaitsMs: waits,
      };
    });
  }

  forTask(taskId: string, options: EstimateOptions = {}): TaskEstimate | undefined {
    const row = this.d.tasks.get(taskId);
    if (!row) return undefined;
    const now = this.d.now();
    const routeDeps = { db: this.d.db, config: this.d.config, tasks: this.d.tasks, registry: this.d.registry, cooldowns: this.d.cooldowns, now: this.d.now,
      ...(this.d.catalog ? { catalog: this.d.catalog } : {}) };
    const whatIf = options.assistantId !== undefined;
    const inputs = routeInputs(routeDeps, taskId, "intake", whatIf ? { override: options.assistantId as never } : {});
    // The pure router over the same inputs routing reads; the explanation is not persisted.
    const explained = explainRoute(routeDeps, inputs, route(inputs.request, inputs.candidates), "intake");
    const chosen = explained.chosen ?? null;
    const assistant = chosen ? this.d.registry.get(chosen) : undefined;
    const rec = explained.modelRecommendation;
    const override = inputs.intent.overrides?.model;
    const model = override ?? (rec?.mode === "applied" && rec.applied ? rec.applied.selector : null);
    const modelSource = override ? "task override (requested selector)"
      : rec?.mode === "applied" && rec.applied ? "routing (K13 applied)"
      : rec?.recommended ? `assistant default (K13 shadow suggests ${rec.recommended}; not applied)` : "assistant default";
    const subject: EstimateSubject = {
      assistantId: chosen, provider: assistant?.provider ?? null, model, modelSource,
      effort: null, effortSource: "not recorded in the execution identity (backlog p1-5-effort-cohorts)",
      taskKind: taskKindOf(row),
    };

    // Quota: the proposed assistant's projection; with no proposal, the earliest controlling retry.
    const projections: NonNullable<typeof inputs.request.projections> = inputs.request.projections ?? new Map();
    let blockers: EstimateContext["quota"]["blockers"] = [];
    let current: EstimateContext["quota"]["current"] = null;
    if (chosen) {
      const p = projections.get(chosen);
      blockers = (p?.blockers ?? []).map((b) => ({ retryAt: b.retryAt, kind: b.kind, reason: b.reason }));
      const fullest = p?.observations
        .filter((o) => o.usedPercent !== undefined)
        .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
      if (fullest) current = { bucket: fullest.scope.bucket ?? null, usedPercent: fullest.usedPercent ?? 0, resetsAt: fullest.resetsAt ?? null, observedAt: fullest.observedAt };
    } else {
      const all = [...projections.values()].flatMap((p) => p.blockers);
      const enabled = inputs.candidates.filter((c) => c.enabled).map((c) => c.id);
      const retry = controllingRetry(all, enabled);
      if (retry) blockers = [{ retryAt: retry, kind: "controlling-retry", reason: "every candidate is quota blocked" }];
    }

    // Live runs on the proposed account. The limit is advisory config; nothing enforces it.
    const account = assistant?.manifestParsed?.core.auth.account ?? null;
    const sameAccount = this.d.registry.list()
      .filter((a) => a.id === chosen || (account !== null && a.manifestParsed?.core.auth.account === account)).map((a) => a.id);
    const activeRuns = sameAccount.length
      ? (this.d.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE state IN (${LIVE_STATES.map(() => "?").join(",")}) AND assistant_id IN (${sameAccount.map(() => "?").join(",")})`)
        .get(...LIVE_STATES, ...sameAccount) as { n: number }).n
      : 0;
    const wait = this.d.db.prepare("SELECT kind, not_before FROM wait_conditions WHERE task_id = ? AND state = 'active'").get(taskId) as { kind: string; not_before: string } | undefined;
    const pending = (this.d.db.prepare(
      "SELECT COUNT(*) AS n FROM approvals ap JOIN runs r ON r.id = ap.session_id WHERE r.task_id = ? AND ap.state = 'pending'",
    ).get(taskId) as { n: number }).n;

    const policy = this.policy();
    const ctx: EstimateContext = {
      now: now.toISOString(),
      quota: { blockers, current },
      capacity: { account, activeRuns, limit: policy.accountConcurrency },
      waitCondition: wait ? { kind: wait.kind, notBefore: wait.not_before } : null,
      pendingApprovals: pending,
      approvalRequired: options.approvalRequired === true,
    };
    const estimate = estimateRun(subject, this.history(), ctx);
    return {
      taskId, advisory: true,
      routing: { chosen, ruleFired: explained.ruleFired, whatIf },
      estimate,
      recommendation: recommendSchedule(estimate, ctx, policy, { deadline: options.deadline ?? null }),
      policy: { timezone: policy.timezone, eveningsAllowed: policy.evening.allowed, weekendsAllowed: policy.weekend.allowed },
    };
  }

  accuracy(limit: number): AccuracyReport {
    return backtestEstimates(this.history(), limit);
  }
}
