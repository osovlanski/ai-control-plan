import type { TaskEnvelope } from "@agent-plane/core";

/**
 * Renders the initial prompt for a fresh run from the TaskEnvelope.
 * (The handoff variant, which adds prior progress/decisions/diff context,
 * lands in Phase 2.)
 */
export function renderTaskPrompt(envelope: TaskEnvelope): string {
  const parts: string[] = [envelope.goal.trim()];
  if (envelope.constraints.length > 0) {
    parts.push("", "Constraints (must hold):", ...envelope.constraints.map((c) => `- ${c}`));
  }
  if (envelope.repository) {
    parts.push(
      "",
      `You are working in a dedicated git worktree on branch ${envelope.repository.branch}.`,
      "Commit your work with clear messages as you complete logical steps.",
    );
  }
  parts.push(
    "",
    "When you finish, summarize: what was completed, what (if anything) remains, and any decisions you made along the way.",
  );
  return parts.join("\n");
}
