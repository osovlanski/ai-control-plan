/**
 * `execution.providerProfile`: a curated Claude launch. The user's files are
 * read to find which plugins to turn off; nothing is written to them.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantId, RunSpec } from "@agent-plane/core";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, profileSettings, type ClaudeLaunchProfile } from "../src/index.js";

const SPEC: RunSpec = {
  taskId: "AG-1" as never, prompt: "p", workdir: "/tmp",
  permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
};
const PROFILE: ClaudeLaunchProfile = {
  plugins: ["claude-mem@thedotmack"],
  mcpServers: { "plugin:claude-mem:mcp-search": { type: "stdio", command: "node", args: ["server.cjs"] } },
};

function userSettings(enabledPlugins: Record<string, boolean>): string {
  const path = join(mkdtempSync(join(tmpdir(), "claude-profile-")), "settings.json");
  writeFileSync(path, JSON.stringify({ enabledPlugins, theme: "dark" }));
  return path;
}

describe("Claude launch profile", () => {
  it("turns off every user-enabled plugin outside the allowlist and the claude.ai connectors", () => {
    const path = userSettings({ "claude-mem@thedotmack": true, "superpowers@superpowers-marketplace": true, "off@x": false });
    const before = readFileSync(path, "utf8");
    expect(profileSettings(PROFILE, path)).toEqual({
      enabledPlugins: { "superpowers@superpowers-marketplace": false, "claude-mem@thedotmack": true },
      disableClaudeAiConnectors: true,
    });
    expect(readFileSync(path, "utf8")).toBe(before); // read, never written
  });

  it("unreadable user settings: only the allowlist is stated", () => {
    expect((profileSettings(PROFILE, "/nonexistent/settings.json") as { enabledPlugins?: unknown }).enabledPlugins).toEqual({ "claude-mem@thedotmack": true });
  });

  it("launches with strict MCP config and exactly the profile's servers; no profile launches as before", async () => {
    const seen: Array<Options | undefined> = [];
    const fake = ((args: { options?: Options }) => {
      seen.push(args.options);
      return (async function* () {})();
    }) as unknown as typeof query;
    await new ClaudeAdapter("c" as AssistantId, fake, { profile: PROFILE }).start(SPEC);
    await new ClaudeAdapter("c" as AssistantId, fake).start(SPEC);
    expect(seen[0]).toMatchObject({ strictMcpConfig: true, mcpServers: PROFILE.mcpServers });
    expect(seen[0]!.settings).toMatchObject({ disableClaudeAiConnectors: true });
    expect(seen[1]).not.toHaveProperty("strictMcpConfig");
    expect(seen[1]).not.toHaveProperty("settings");
    expect(seen[1]).not.toHaveProperty("mcpServers");
  });
});
