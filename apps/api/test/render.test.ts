import { describe, expect, it } from "vitest";
import type { TaskEnvelope, TaskId } from "@agent-plane/core";
import { renderProgressMd } from "../src/render/progress.js";
import { renderTaskPrompt } from "../src/render/prompt.js";

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope => ({
  taskId: "AG-1042" as TaskId,
  goal: "Fix the authentication refresh-token race",
  constraints: ["preserve the public auth API"],
  repository: { path: "/repo/project", branch: "task/AG-1042" },
  status: { state: "RUNNING", phase: "testing" },
  completed: ["Identified the race condition"],
  remaining: ["Run the regression suite"],
  decisions: [
    { text: "preserve the public auth API", madeBy: "user", at: "2026-08-21T19:30:00.000Z" },
    { text: "reuse the existing token cache", madeBy: "agent:personal-claude", at: "2026-08-21T19:31:00.000Z" },
  ],
  artifacts: {
    changedFiles: ["src/auth/token.ts"],
    testResults: [{ at: "2026-08-21T19:34:00.000Z", passed: 47, failed: 2 }],
  },
  nextAction: "Resolve the two failing refresh-token tests",
  ...over,
});

describe("progress.md projection", () => {
  it("renders goal, phase, agent, decisions with provenance, and artifacts", () => {
    const md = renderProgressMd(envelope(), "personal-claude");
    expect(md).toContain("# AG-1042");
    expect(md).toContain("RUNNING (testing)");
    expect(md).toContain("personal-claude");
    expect(md).toContain("- preserve the public auth API _(user,");
    expect(md).toContain("_(agent:personal-claude,");
    expect(md).toContain("- src/auth/token.ts");
    expect(md).toContain("47 passed / 2 failed");
    expect(md).toContain("Resolve the two failing refresh-token tests");
  });

  it("degrades gracefully on a brand-new task", () => {
    const md = renderProgressMd(
      envelope({
        status: { state: "CREATED" },
        completed: [],
        remaining: [],
        decisions: [],
        artifacts: { changedFiles: [], testResults: [] },
        nextAction: undefined,
      }),
    );
    expect(md).toContain("- (nothing yet)");
    expect(md).toContain("- (not yet planned)");
    expect(md).not.toContain("## Last Test Run");
  });
});

describe("task prompt rendering", () => {
  it("carries the goal, constraints, and branch context", () => {
    const prompt = renderTaskPrompt(envelope());
    expect(prompt).toContain("Fix the authentication refresh-token race");
    expect(prompt).toContain("Constraints (must hold):");
    expect(prompt).toContain("- preserve the public auth API");
    expect(prompt).toContain("branch task/AG-1042");
  });

  it("omits repository guidance for non-code tasks", () => {
    const prompt = renderTaskPrompt(envelope({ repository: undefined, constraints: [] }));
    expect(prompt).not.toContain("branch");
    expect(prompt).not.toContain("Constraints");
  });
});
