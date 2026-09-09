import { QuotaProjection } from './quota.js';
import type { ResolvedConfig } from '../config.js';
import type { TaskStore } from './tasks.js';
import type { Registry } from './registry.js';
import type { CooldownStore } from './cooldown.js';
import type { AssistantId, CapabilityManifest, ModelRecommendation, RoutingExplanation, RoutingProfile, TaskIntent } from "@agent-plane/core";
import type { ModelCatalogService } from "./model-catalog.js";
import { recommendModel } from "./model-selection.js";
import type { Db } from "../db/index.js";
import { TelemetryService, classifyGoal, type AssistantScore } from "./telemetry.js";
import { continuationProvenance } from "./context-continuation.js";

export interface RouteCandidate {
  id: AssistantId;
  enabled: boolean;
  manifest: CapabilityManifest | null;
}

export interface RouteRequest {
  taskId: string;
  profile: RoutingProfile;
  needsRepo: boolean;
  repoPathAllowed: boolean;
  /** Assistants excluded by cooldown (failed/limited recently), with reason. */
  cooldowns: Map<string, string>;
  userOverride?: AssistantId;
  /**
   * K11 continuation preference: keep the work on the assistant that built the
   * checkpoint when it is still eligible. A PREFERENCE, never a bypass — it is
   * applied only among candidates that already passed every hard filter (auth,
   * capabilities, workspace allowlist, cooldown, quota), and a user override
   * still wins. A healthy context yield adds no cooldown penalty of its own, so
   * the previous assistant is normally still eligible.
   */
  preferSame?: AssistantId;
  projections?: Map<string, ReturnType<QuotaProjection['for']>>;
  /**
   * Rolling telemetry from the user's own runs. Absent until enough runs
   * exist — profiles must degrade to their rule behaviour and say so, never
   * pretend to a measurement they do not have.
   */
  scores?: Map<string, AssistantScore>;
}

/**
 * Phase 1 router: hard filters + deterministic profile rules, with a
 * persisted first-class explanation object (review §3.3). Telemetry-fed
 * scoring replaces the rule step in Phase 5 behind this same interface.
 */
export function route(req: RouteRequest, candidates: RouteCandidate[]): RoutingExplanation {
  const evaluated = candidates.map((c) => {
    const failures: string[] = [];
    if (!c.enabled) failures.push("disabled in workspace config");
    if (!c.manifest) failures.push("no capability manifest (sync has not run)");
    if (c.manifest) {
      if (c.manifest.core.auth.state !== "ok") failures.push(`auth ${c.manifest.core.auth.state}`);
      if (req.needsRepo && !c.manifest.core.execution.filesystem) failures.push("no filesystem capability");
      if (req.needsRepo && !c.manifest.core.execution.shell) failures.push("no shell capability");
    }
    if (req.needsRepo && !req.repoPathAllowed) failures.push("repository path not in workspace allowlist");
    const cooldown = req.cooldowns.get(c.id);
    if (cooldown) failures.push(`cooldown: ${cooldown}`);
    const projection = req.projections?.get(c.id);
    if (projection?.blockers.length) failures.push(`quota blocked: ${[...new Set(projection.blockers.map(b => `${b.kind} until ${b.retryAt} (${b.reason})`))].join('; ')}`);
    const quota = projection ? projection.quota : latestQuota(c.manifest);
    if (quota && quota.usedPercent >= 100) failures.push("quota exhausted");
    return { assistantId: c.id, passedFilters: failures.length === 0, filterFailures: failures, quota };
  });

  const eligible = evaluated.filter((e) => e.passedFilters);

  if (req.userOverride) {
    const target = evaluated.find((e) => e.assistantId === req.userOverride);
    return {
      candidates: evaluated,
      ruleFired: "user-override",
      chosen: target?.passedFilters ? req.userOverride : undefined,
      userOverride: req.userOverride,
      tieBreaker: target?.passedFilters ? undefined : "override target failed hard filters",
    };
  }

  if (eligible.length === 0) {
    return { candidates: evaluated, ruleFired: "no-eligible-candidate" };
  }

  if (req.preferSame && eligible.some((e) => e.assistantId === req.preferSame)) {
    return {
      candidates: evaluated,
      ruleFired: `prefer-same: continuing on ${req.preferSame}, which still passes every filter`,
      chosen: req.preferSame,
    };
  }

  switch (req.profile) {
    case "preserve-quota": {
      // Most headroom first; unknown quota (reportsLimits: false) sorts as 50%.
      const sorted = [...eligible].sort((a, b) => (a.quota?.usedPercent ?? 50) - (b.quota?.usedPercent ?? 50));
      return {
        candidates: evaluated,
        ruleFired: "preserve-quota: most headroom",
        chosen: sorted[0]!.assistantId,
        tieBreaker: sorted.length > 1 ? `over ${sorted[1]!.assistantId}` : undefined,
      };
    }
    case "fastest": {
      // Real measurement now that Phase 5 records it — but only where it exists.
      const timed = eligible
        .map((e) => ({ e, ms: req.scores?.get(e.assistantId)?.medianDurationMs }))
        .filter((x): x is { e: typeof eligible[number]; ms: number } => x.ms !== undefined);
      if (timed.length === 0) {
        return {
          candidates: evaluated,
          ruleFired: "fastest: no latency telemetry yet, first eligible by stable order",
          chosen: eligible[0]!.assistantId,
        };
      }
      timed.sort((a, b) => a.ms - b.ms);
      return {
        candidates: evaluated,
        ruleFired: `fastest: lowest median run time (${formatMs(timed[0]!.ms)} over ${req.scores?.get(timed[0]!.e.assistantId)?.runs ?? 0} runs)`,
        chosen: timed[0]!.e.assistantId,
        tieBreaker: timed.length > 1 ? `over ${timed[1]!.e.assistantId}` : undefined,
      };
    }
    case "best-quality": {
      // Quality proxy from the user's real workload: did runs finish, did the
      // tests they ran pass, and did work have to be handed off elsewhere.
      const ranked = eligible
        .map((e) => ({ e, score: qualityScore(req.scores?.get(e.assistantId)) }))
        .filter((x): x is { e: typeof eligible[number]; score: number } => x.score !== undefined);
      if (ranked.length === 0) {
        return {
          candidates: evaluated,
          ruleFired: "best-quality: no telemetry yet, first eligible by stable order",
          chosen: eligible[0]!.assistantId,
        };
      }
      ranked.sort((a, b) => b.score - a.score);
      return {
        candidates: evaluated,
        ruleFired: `best-quality: highest measured success/test/reliability score (${ranked[0]!.score.toFixed(2)})`,
        chosen: ranked[0]!.e.assistantId,
        tieBreaker: ranked.length > 1 ? `over ${ranked[1]!.e.assistantId}` : undefined,
      };
    }
    case "lowest-tokens": {
      const measured = eligible
        .map((e) => ({ e, tokens: req.scores?.get(e.assistantId)?.medianTokens }))
        .filter((x): x is { e: typeof eligible[number]; tokens: number } => x.tokens !== undefined);
      if (measured.length === 0) {
        return {
          candidates: evaluated,
          ruleFired: "lowest-tokens: no usage telemetry yet, first eligible by stable order",
          chosen: eligible[0]!.assistantId,
        };
      }
      measured.sort((a, b) => a.tokens - b.tokens);
      return {
        candidates: evaluated,
        ruleFired: `lowest-tokens: lowest median tokens per run (${measured[0]!.tokens})`,
        chosen: measured[0]!.e.assistantId,
      };
    }
    case "auto":
    default: {
      // Config order is the preference order; quota headroom breaks ties when known.
      const sorted = [...eligible].sort((a, b) => (a.quota?.usedPercent ?? 0) - (b.quota?.usedPercent ?? 0));
      const chosen = sorted[0]!.assistantId;
      return {
        candidates: evaluated,
        ruleFired: "auto: config preference order, quota headroom tie-break",
        chosen,
      };
    }
  }
}

function latestQuota(
  manifest: CapabilityManifest | null,
): { usedPercent: number; resetsAt?: string } | undefined {
  const limits = manifest?.core.limits;
  if (!limits || limits.length === 0) return undefined;
  const worst = [...limits].sort((a, b) => b.usedPercent - a.usedPercent)[0]!;
  return { usedPercent: worst.usedPercent, resetsAt: worst.resetsAt };
}

/**
 * Never let model intelligence break routing. A catalog read, a cohort query or
 * a normalization bug must degrade to "no recommendation", not to a failed
 * dispatch — routing is local-first and does not depend on this (I-M3).
 */
function shadowRecommendation(
  deps: { db: Db; config: ResolvedConfig; registry: Registry; now?: () => Date },
  catalog: ModelCatalogService,
  intent: TaskIntent,
  candidates: RoutingExplanation['candidates'],
): ModelRecommendation | undefined {
  try {
    return recommendModel({ db: deps.db, config: deps.config, registry: deps.registry, catalog, ...(deps.now ? { now: deps.now } : {}) }, intent, candidates);
  } catch {
    return undefined;
  }
}

/** Returns the inserted `routing_decisions.id`, for a real routing→session audit join. */
export function persistRoutingDecision(db: Db, taskId: string, explanation: RoutingExplanation): number {
  const info = db
    .prepare("INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)")
    .run(taskId, explanation.chosen ?? null, JSON.stringify(explanation), new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function routingHistory(db: Db, taskId: string): unknown[] {
  return (
    db
      .prepare("SELECT chosen_assistant_id, explanation, at FROM routing_decisions WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{ chosen_assistant_id: string | null; explanation: string; at: string }>
  ).map((r) => ({ chosen: r.chosen_assistant_id, at: r.at, explanation: JSON.parse(r.explanation) as unknown }));
}

/** Sub-second runs must not render as a misleading "0s" in the explanation. */
function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Blends the three signals telemetry can honestly supply. Weighted, not
 * averaged: finishing at all matters most, then whether the tests the assistant
 * ran actually passed, then whether its work had to be rescued by someone else.
 */
function qualityScore(score: AssistantScore | undefined): number | undefined {
  if (!score || score.runs === 0) return undefined;
  const reliability = score.runs > 0 ? 1 - Math.min(1, score.failovers / score.runs) : 1;
  return 0.5 * score.successRate + 0.3 * (score.testPassRate ?? score.successRate) + 0.2 * reliability;
}

/** CR-30: all Control Plane routing uses current evidence and durable intent. */
export function routeTask(
  deps: { db: Db; config: ResolvedConfig; tasks: TaskStore;
    registry: Registry; cooldowns: CooldownStore; now?: () => Date;
    /**
     * K13 model catalog. Optional: without it the routing decision simply
     * carries no `modelRecommendation`. Routing NEVER waits on, or fails
     * because of, model intelligence (I-M3).
     */
    catalog?: ModelCatalogService },
  taskId: string, origin: 'intake' | 'wake' | 'run-now' | 'failover' | 'context-yield',
  options: { exclude?: string; override?: AssistantId; dispatchId?: string } = {},
) {
  const row = deps.tasks.get(taskId);
  if (!row) throw new Error(`Unknown task ${taskId}`);
  const intent = JSON.parse(row.intent_json) as TaskIntent;
  const telemetry = new TelemetryService(deps.db);
  const scores = telemetry.scores();
  for (const [id, score] of telemetry.scores(classifyGoal(intent.goal))) scores.set(id, score);
  const candidates = deps.registry.list().map(a => ({ id: a.id as AssistantId, enabled: a.enabled === 1 && a.id !== options.exclude, manifest: a.manifestParsed }));
  const dispatch = options.dispatchId ? deps.db.prepare('SELECT checkpoint_id FROM dispatches WHERE dispatch_id = ? AND task_id = ?').get(options.dispatchId, taskId) as { checkpoint_id: string | null } | undefined : undefined;
  // K11 provenance: read back from the checkpoint anchor, never from a second
  // continuation-history store. Absent for every other origin.
  const continuation = origin === 'context-yield' && dispatch?.checkpoint_id
    ? continuationProvenance(deps.db, taskId, dispatch.checkpoint_id)
    : undefined;
  const base = route({
    taskId, profile: intent.profile, needsRepo: !!intent.repository,
    repoPathAllowed: !intent.repository || deps.config.repoAllowlist.some(p => intent.repository!.path === p || intent.repository!.path.startsWith(`${p}/`)),
    cooldowns: new Map(), scores, projections: new Map(deps.registry.list().map(a => [a.id, new QuotaProjection(deps.db, deps.now).for(a.id, a.manifestParsed)])), userOverride: options.override ?? intent.overrides?.assistantId,
    preferSame: continuation?.previousAssistantId as AssistantId | undefined,
  }, candidates);
  // K13 SHADOW. Computed AFTER the assistant decision and folded into the same
  // explanation object — it reads `base.candidates` (the router's own hard-filter
  // verdict) and writes nothing back. `base.chosen`, `ExecutionRequest.model`
  // and `RunSpec.model` are untouched by construction: this value is only ever
  // read out of the persisted explanation (CR-33).
  const modelRecommendation = deps.catalog
    ? shadowRecommendation(deps, deps.catalog, intent, base.candidates)
    : undefined;
  const explanation: RoutingExplanation & { origin: string } = { ...base, origin,
    ...(modelRecommendation ? { modelRecommendation } : {}),
    ...(dispatch ? { dispatchId: options.dispatchId, continuation: dispatch.checkpoint_id ? { kind: 'checkpoint', checkpointId: dispatch.checkpoint_id } : { kind: 'fresh' } } : {}),
    ...(continuation ? { contextContinuation: {
      ...continuation,
      // The requested model selector rides on the task's durable intent, so a
      // continuation asks for exactly what the predecessor asked for.
      requestedModel: intent.overrides?.model,
      preferSameSatisfied: base.chosen !== undefined && base.chosen === continuation.previousAssistantId,
      changedBecause: base.chosen === continuation.previousAssistantId ? undefined
        : base.candidates.find(c => c.assistantId === continuation.previousAssistantId)?.filterFailures.join('; ')
          ?? 'the previous assistant is no longer a configured candidate',
    } } : {}) };
  return { explanation, routingDecisionId: persistRoutingDecision(deps.db, taskId, explanation) };
}
