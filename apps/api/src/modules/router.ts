import type { AssistantId, CapabilityManifest, RoutingExplanation, RoutingProfile } from "@agent-plane/core";
import type { Db } from "../db/index.js";

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
    case "fastest":
      // No latency telemetry yet (Phase 5): deterministic stable order, stated honestly.
      return {
        candidates: evaluated,
        ruleFired: "fastest: no latency telemetry yet, first eligible by stable order",
        chosen: eligible[0]!.assistantId,
      };
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

export function persistRoutingDecision(db: Db, taskId: string, explanation: RoutingExplanation): void {
  db.prepare(
    "INSERT INTO routing_decisions (task_id, chosen_assistant_id, explanation, at) VALUES (?, ?, ?, ?)",
  ).run(taskId, explanation.chosen ?? null, JSON.stringify(explanation), new Date().toISOString());
}

export function routingHistory(db: Db, taskId: string): unknown[] {
  return (
    db
      .prepare("SELECT chosen_assistant_id, explanation, at FROM routing_decisions WHERE task_id = ? ORDER BY id")
      .all(taskId) as Array<{ chosen_assistant_id: string | null; explanation: string; at: string }>
  ).map((r) => ({ chosen: r.chosen_assistant_id, at: r.at, explanation: JSON.parse(r.explanation) as unknown }));
}
