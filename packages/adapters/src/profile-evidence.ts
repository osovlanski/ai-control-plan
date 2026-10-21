import { resolve } from "node:path";
import { NotSupportedError, type ProfileRuntimeEvidence, type ProvisioningCheck, type VerifiedProfile } from "@agent-plane/core";
import { PLUGIN_NAME } from "./provisioning.js";

/** The slice of Claude Code's `system/init` message the profile is judged against. */
export interface ClaudeInitInventory {
  skills: readonly string[];
  plugins: ReadonlyArray<{ name: string; path: string }>;
  mcpServers: ReadonlyArray<{ name: string; status: string }>;
}

const PROFILE_SKILL = /^plugin\/skills\/([^/]+)\/SKILL\.md$/;
/** Statuses that mean the server is not serving the run. `pending` is still connecting at init. */
const MCP_DOWN = new Set(["failed", "needs-auth", "disabled"]);

/** The skill names Claude Code reports for a profile's plugin: `agent-plane-profile:<skill>`. */
export function profileSkillNames(profile: VerifiedProfile): string[] {
  return profile.files
    .map((f) => PROFILE_SKILL.exec(f.relPath)?.[1])
    .filter((s): s is string => s !== undefined)
    .map((s) => `${PLUGIN_NAME}:${s}`)
    .sort();
}

/**
 * M3 S5: does what Claude Code loaded match the profile? Plugins and MCP servers must match
 * exactly, and every profile skill must be present with no skill from another plugin. Skills
 * with no plugin namespace are bundled with the CLI or come from the worktree's own project
 * settings (stated in the profile's `visible`), so they are counted, not judged.
 */
export function claudeInitEvidence(profile: VerifiedProfile, init: ClaudeInitInventory): ProfileRuntimeEvidence {
  const launch = profile.launch;
  if (launch.harness !== "claude-code") throw new NotSupportedError(`a ${launch.harness} profile judged against Claude Code init`);
  const checks: ProvisioningCheck[] = [];

  const ours = (p: { name: string; path: string }) =>
    launch.pluginDir !== undefined && p.name === PLUGIN_NAME && resolve(p.path) === resolve(launch.pluginDir);
  const foreignPlugins = init.plugins.filter((p) => !ours(p)).map((p) => p.name).sort();
  const pluginMissing = launch.pluginDir !== undefined && !init.plugins.some(ours);
  checks.push({
    name: "runtime_plugins",
    ok: foreignPlugins.length === 0 && !pluginMissing,
    detail: [
      pluginMissing ? `profile plugin not loaded from ${launch.pluginDir}` : undefined,
      foreignPlugins.length ? `plugins outside the profile loaded: ${foreignPlugins.join(", ")}` : undefined,
    ].filter(Boolean).join("; ") || (launch.pluginDir ? `only ${PLUGIN_NAME} loaded` : "no plugin loaded"),
  });

  const expected = profileSkillNames(profile);
  const observed = new Set(init.skills);
  const missingSkills = expected.filter((s) => !observed.has(s));
  const foreignSkills = init.skills.filter((s) => s.includes(":") && !expected.includes(s)).sort();
  const unnamespaced = init.skills.filter((s) => !s.includes(":")).length;
  checks.push({
    name: "runtime_skills",
    ok: missingSkills.length === 0 && foreignSkills.length === 0,
    detail: [
      missingSkills.length ? `profile skills not loaded: ${missingSkills.join(", ")}` : undefined,
      foreignSkills.length ? `plugin skills outside the profile: ${foreignSkills.join(", ")}` : undefined,
    ].filter(Boolean).join("; ") ||
      `${expected.length} profile skill(s) loaded; ${unnamespaced} bundled or project skill(s) not judged`,
  });

  const wanted = Object.keys(launch.mcpServers).sort();
  const seen = new Map(init.mcpServers.map((s) => [s.name, s.status]));
  const missingMcp = wanted.filter((n) => !seen.has(n));
  const extraMcp = [...seen.keys()].filter((n) => !wanted.includes(n)).sort();
  const downMcp = wanted.filter((n) => MCP_DOWN.has(seen.get(n) ?? "")).map((n) => `${n} (${seen.get(n)})`);
  checks.push({
    name: "runtime_mcp",
    ok: missingMcp.length === 0 && extraMcp.length === 0 && downMcp.length === 0,
    detail: [
      missingMcp.length ? `profile servers not loaded: ${missingMcp.join(", ")}` : undefined,
      extraMcp.length ? `servers outside the profile: ${extraMcp.join(", ")}` : undefined,
      downMcp.length ? `servers not serving: ${downMcp.join(", ")}` : undefined,
    ].filter(Boolean).join("; ") || `${wanted.length} profile server(s) loaded, no others`,
  });

  return { ok: checks.every((c) => c.ok), profileDigest: profile.profileDigest, checks };
}
