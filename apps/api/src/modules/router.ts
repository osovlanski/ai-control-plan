import type { AssistantId, CapabilityManifest, RoutingExplanation, RoutingProfile } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import type { AssistantScore } from "./telemetry.js";

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
    const quota = latestQuota(c.manifest);
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
