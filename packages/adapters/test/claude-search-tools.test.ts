/**
 * Phase 7 slice 8: native Claude Code builds leave Grep and Glob out of the default tool set,
 * so every search went through Bash and escalated. The adapter opts them in with rules scoped
 * to the worktree, and the S5a startup evidence fails a profile whose init does not offer them.
 */
import { describe, expect, it } from "vitest";
import type { AssistantId, ProfileRuntimeEvidence, RunSpec } from "@agent-plane/core";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/index.js";
import { SEARCH_TOOL_RULES, withSearchToolsCheck } from "../src/claude.js";

const RUN: RunSpec = {
  taskId: "AG-1" as never, prompt: "p", workdir: "/tmp/wt",
  permissionPolicy: { mode: "prompt-on-escalation" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

async function optionsOf(run: RunSpec): Promise<Options> {
  let seen: Options | undefined;
  const fake = ((args: { options?: Options }) => {
    seen = args.options;
    return (async function* () {})();
  }) as unknown as typeof query;
  await new ClaudeAdapter("c" as AssistantId, fake).start(run);
  return seen!;
}

describe("Claude read-only search tools", () => {
  it("opts Grep and Glob in with worktree-scoped rules, never bare names, in both permission modes", async () => {
    expect(SEARCH_TOOL_RULES).toEqual(["Grep(./**)", "Glob(./**)"]);
    for (const mode of ["prompt-on-escalation", "auto-approve"] as const) {
      const options = await optionsOf({ ...RUN, permissionPolicy: { mode } });
      expect(options.allowedTools).toEqual(["Grep(./**)", "Glob(./**)"]);
      expect(options.cwd).toBe("/tmp/wt");
      expect(options).not.toHaveProperty("tools");
      expect(options).not.toHaveProperty("disallowedTools");
    }
    // A bare entry would auto-allow every path and shadow canUseTool.
    expect((await optionsOf(RUN)).allowedTools!.every((rule) => /^\w+\(\.\/\*\*\)$/.test(rule))).toBe(true);
  });

  it("adds runtime_search_tools to the S5a evidence: offered passes, missing fails and names the tools", () => {
    const base: ProfileRuntimeEvidence = { ok: true, profileDigest: `sha256:${"2".repeat(64)}`, checks: [{ name: "runtime_mcp", ok: true, detail: "0 profile server(s) loaded, no others" }] };
    const ok = withSearchToolsCheck(base, ["Bash", "Read", "Grep", "Glob"]);
    expect(ok.ok).toBe(true);
    expect(ok.checks.at(-1)).toEqual({ name: "runtime_search_tools", ok: true, detail: "Grep, Glob offered" });
    const missing = withSearchToolsCheck(base, ["Bash", "Read", "Glob"]);
    expect(missing.ok).toBe(false);
    expect(missing.checks.at(-1)).toEqual({ name: "runtime_search_tools", ok: false, detail: "read-only search tools not offered: Grep" });
    expect(withSearchToolsCheck({ ...base, ok: false }, ["Grep", "Glob"]).ok).toBe(false);
    expect(base.checks).toHaveLength(1);
  });
});
