import type { TaskEnvelope } from "@agent-plane/core";

/**
 * Opening line of every handoff prompt. Receiving adapters (and the fake
 * adapter's test scenarios) can detect a continuation by this marker.
 */
export const HANDOFF_MARKER = "You are continuing work that another assistant started.";

export interface HandoffContext {
  reason: string;
  fromAssistantId?: string;
  gitRef?: string | null;
  diffStat?: string | null;
  activitySummary?: string | null;
}

/**
 * The handoff package the receiving agent actually reads (revised architecture §7).
 * Inline: envelope, decisions with provenance, git state, a short activity summary.
 * By reference: full event log and diffs, fetchable from the control plane.
 */
export function renderHandoffPrompt(envelope: TaskEnvelope, ctx: HandoffContext): string {
  const parts: string[] = [HANDOFF_MARKER, "", "## Goal", "", envelope.goal.trim()];

  if (envelope.constraints.length > 0) {
    parts.push(
      "",
      "## Constraints (user-imposed — inviolable)",
      "",
      ...envelope.constraints.map((c) => `- ${c}`),
    );
  }

  const agentDecisions = envelope.decisions.filter((d) => d.madeBy !== "user");
  if (agentDecisions.length > 0) {
    parts.push(
      "",
      "## Decisions the previous assistant made",
      "",
      ...agentDecisions.map((d) => `- ${d.text} _(${d.madeBy})_`),
      "",
      "You may revisit these if you have good reason. The user constraints above you may not.",
    );
  }

  parts.push(
    "",
    "## Completed so far",
    "",
    ...(envelope.completed.length > 0 ? envelope.completed.map((c) => `- ${c}`) : ["- (nothing recorded)"]),
  );

  if (envelope.remaining.length > 0) {
    parts.push("", "## Remaining", "", ...envelope.remaining.map((r) => `- ${r}`));
  }

  if (envelope.repository) {
    parts.push(
      "",
      "## Repository state",
      "",
      `You are on branch ${envelope.repository.branch} in a dedicated worktree — the previous assistant's work is already there.`,
    );
    if (ctx.gitRef) parts.push(`A checkpoint commit was made at ${ctx.gitRef.slice(0, 12)}.`);
    if (ctx.diffStat?.trim()) {
      parts.push("", "Changes so far:", "", "```", ctx.diffStat.trim(), "```");
    }
  }

  if (envelope.artifacts.testResults.length > 0) {
    const last = envelope.artifacts.testResults.at(-1)!;
    parts.push("", "## Last test run", "", `${last.passed} passed / ${last.failed} failed`);
  }

  if (ctx.activitySummary?.trim()) {
    parts.push("", "## What the previous assistant did", "", ctx.activitySummary.trim());
  }

  parts.push("", "## Why you are picking this up", "", ctx.reason);

  parts.push(
    "",
    "The full event history and diffs are available from the control plane if you need deeper context — prefer working from the state above rather than asking for it.",
    "",
    "## Your next action",
    "",
    envelope.nextAction?.trim() || "Continue the remaining work described above.",
  );

  return parts.join("\n");
}

/** handoff.md — the human-readable projection of the same package. */
export function renderHandoffMd(envelope: TaskEnvelope, ctx: HandoffContext): string {
  return [
    `# Handoff — ${envelope.taskId}`,
    "",
    `**Reason:** ${ctx.reason}`,
    ctx.fromAssistantId ? `**From:** ${ctx.fromAssistantId}` : "",
    "",
    "---",
    "",
    renderHandoffPrompt(envelope, ctx),
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}
