import type { TaskEnvelope } from "@agent-plane/core";

/** Renders progress.md — a portable human/agent-readable projection of the envelope (DB stays the truth). */
export function renderProgressMd(envelope: TaskEnvelope, assistantId?: string): string {
  const lines: string[] = [
    `# ${envelope.taskId}`,
    "",
    "## Goal",
    "",
    envelope.goal,
    "",
    "## Current Phase",
    "",
    `${envelope.status.state}${envelope.status.phase ? ` (${envelope.status.phase})` : ""}`,
    "",
  ];
  if (assistantId) {
    lines.push("## Current Agent", "", assistantId, "");
  }
  if (envelope.constraints.length > 0) {
    lines.push("## Constraints (user-imposed, inviolable)", "", ...envelope.constraints.map((c) => `- ${c}`), "");
  }
  lines.push("## Completed", "", ...listOr(envelope.completed, "- (nothing yet)"), "");
  lines.push("## Remaining", "", ...listOr(envelope.remaining, "- (not yet planned)"), "");
  if (envelope.decisions.length > 0) {
    lines.push(
      "## Decisions",
      "",
      ...envelope.decisions.map((d) => `- ${d.text} _(${d.madeBy}, ${d.at.slice(0, 16)})_`),
      "",
    );
  }
  if (envelope.artifacts.changedFiles.length > 0) {
    lines.push("## Changed Files", "", ...envelope.artifacts.changedFiles.map((f) => `- ${f}`), "");
  }
  const lastTest = envelope.artifacts.testResults.at(-1);
  if (lastTest) {
    lines.push("## Last Test Run", "", `${lastTest.passed} passed / ${lastTest.failed} failed`, "");
  }
  if (envelope.nextAction) {
    lines.push("## Next Action", "", envelope.nextAction, "");
  }
  return lines.join("\n");
}

function listOr(items: string[], fallback: string): string[] {
  return items.length > 0 ? items.map((i) => `- ${i}`) : [fallback];
}
