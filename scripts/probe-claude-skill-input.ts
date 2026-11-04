// M6 S2 probe (docs/agentic-os-m6-composition-telemetry.md §0, Q6): which key does Claude Code's
// Skill tool input use for the skill name? SDK 0.3.238 does not type it. Runs ONE short Claude turn
// in a throwaway directory with a one-skill local plugin, asks it to use the skill, and prints the
// Skill tool input KEYS only: never values, messages or the transcript. Spends a little quota.
// Needs a Claude login. From the repo root:
//   pnpm --filter @agent-plane/api exec tsx ../../scripts/probe-claude-skill-input.ts
// The matcher (packages/core/src/asset-telemetry.ts, SKILL_INPUT_KEYS) accepts "skill" and "name".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";

// The SDK is a dependency of the adapters package, not of the repo root.
const sdkPath = createRequire(new URL("../packages/adapters/package.json", import.meta.url)).resolve("@anthropic-ai/claude-agent-sdk");
const { query } = (await import(pathToFileURL(sdkPath).href)) as typeof ClaudeSdk;

const PLUGIN = "agent-plane-profile"; // what the plane names a profile plugin
const SKILL = "probe-greeting";
const root = mkdtempSync(join(tmpdir(), "acp-skill-probe-"));
const pluginDir = join(root, "plugin");
const cwd = join(root, "work");
mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
mkdirSync(join(pluginDir, "skills", SKILL), { recursive: true });
mkdirSync(cwd);
writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: PLUGIN, version: "1.0.0", description: "S2 probe" })}\n`);
writeFileSync(join(pluginDir, "skills", SKILL, "SKILL.md"), `---\nname: ${SKILL}\ndescription: Use when asked for the probe greeting.\n---\n\nReply with the single word: hello.\n`);

const seen: string[][] = [];
let initSkill = false;
try {
  for await (const msg of query({
    prompt: `Use the ${PLUGIN}:${SKILL} skill now, then stop.`,
    options: {
      cwd,
      settingSources: [],
      plugins: [{ type: "local", path: pluginDir }],
      strictMcpConfig: true,
      mcpServers: {},
      maxTurns: 3,
      allowedTools: ["Skill"],
      // Every other tool is refused, so the turn stays inside the throwaway directory.
      canUseTool: async (tool, input) => (tool === "Skill" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "probe: Skill only" }),
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") initSkill = (msg.skills ?? []).includes(`${PLUGIN}:${SKILL}`);
    if (msg.type !== "assistant") continue;
    for (const block of msg.message.content) {
      if (typeof block === "object" && block.type === "tool_use" && block.name === "Skill") {
        seen.push(Object.keys((block.input ?? {}) as Record<string, unknown>).sort());
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ initListedProfileSkill: initSkill, skillCalls: seen.length, inputKeys: seen }));
if (seen.length === 0) process.exitCode = 1;
