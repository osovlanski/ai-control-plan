/**
 * M3 S5 (plans/m3-provisioning.md row S5): Claude Code's own `system/init` inventory is judged
 * against the verified profile. Plugins and MCP servers must match exactly; every profile skill
 * must load and no other plugin's skill may; unnamespaced (bundled or project) skills are counted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSpec, AssistantId, BundleResponse, McpLaunch, NormalizedEvent, ProfileRuntimeEvidence, ProvisioningInput, RunSpec, VerifiedProfile } from "@agent-plane/core";
import { jcs, NotSupportedError } from "@agent-plane/core";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, CodexAdapter, claudeInitEvidence, profileSkillNames, verifiedProfile } from "../src/index.js";
import { sha256 } from "../src/provisioning.js";

const DIGEST = `sha256:${"2".repeat(64)}`;
const LAUNCH: McpLaunch = { transport: "stdio", command: "example-mcp", args: [], env: {} };

function input(harness: "claude-code" | "codex", mcp: boolean): ProvisioningInput {
  const raw: Array<[string, string]> = harness === "claude-code"
    ? [["CLAUDE.md", "# Composed\n"], [".claude/skills/ts-review/SKILL.md", "---\nname: ts-review\n---\nReview.\n"]]
    : [["AGENTS.md", "# Composed\n"]];
  const files = raw.map(([relPath, content]) => ({ relPath, content, digest: sha256(content) }));
  const bundle: BundleResponse = {
    schemaVersion: "1.0",
    files,
    manifest: {
      harness, bundleDigest: sha256(jcs(files, "integer")), compiler: { name: "cockpit", version: "1" }, included: [], excluded: [],
      tokens: { estimated: 10, tokenMethod: "estimated", charsPerToken: 4, budget: 1000 },
    },
  };
  const servers = mcp ? [{ ref: { id: "mcp:example-mcp", digest: DIGEST, allowlisted: true, tools_allowed: [], secret_refs: [] }, launch: LAUNCH }] : [];
  const spec: AgentSpec = {
    schema_version: "1.1", composition_revision_id: "CR-AG-1-1", task_id: "AG-1",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness, model: { primary: { id: "fake-1" }, fallbacks: [] },
    registry: { snapshot_digest: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-19T00:00:00.000Z", stale: false },
    assets: { skills: [], mcp_servers: servers.map((s) => s.ref), subagents: [] },
    context: { fragments: [], memory_bundles: [], bundle_digest: bundle.manifest.bundleDigest, compiler: { name: "cockpit", version: "1", tokens: 10, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: `sha256:${"1".repeat(64)}` }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "task/AG-1", worktree_id: "w" },
    provisioning: { requested: "isolated" },
    explanation_ref: "CD-AG-1-1",
  };
  return { spec, bundle, root: join(mkdtempSync(join(tmpdir(), "m3s5-")), "run_1"), sessionId: "run_1", mcpServers: servers };
}

const noQuery = (() => (async function* () {})()) as unknown as typeof query;

async function profileFor(harness: "claude-code" | "codex", mcp = true): Promise<VerifiedProfile> {
  const adapter = harness === "claude-code" ? new ClaudeAdapter("claude" as AssistantId, noQuery) : new CodexAdapter("codex" as AssistantId);
  const profile = await adapter.provision(await adapter.prepare(input(harness, mcp)));
  return verifiedProfile(profile, await adapter.verify(profile));
}

/** What a faithful Claude Code reports for `profile`, plus the CLI's bundled skills. */
function faithful(profile: VerifiedProfile) {
  const launch = profile.launch as Extract<VerifiedProfile["launch"], { harness: "claude-code" }>;
  return {
    skills: ["deep-research", "debug", ...profileSkillNames(profile)],
    plugins: [{ name: "agent-plane-profile", path: launch.pluginDir! }],
    mcpServers: Object.keys(launch.mcpServers).map((name) => ({ name, status: "connected" })),
  };
}

const failing = (e: ProfileRuntimeEvidence) => e.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

describe("claudeInitEvidence", () => {
  it("a faithful init passes, with bundled skills counted and not judged", async () => {
    const profile = await profileFor("claude-code");
    expect(profileSkillNames(profile)).toEqual(["agent-plane-profile:ts-review"]);
    const e = claudeInitEvidence(profile, faithful(profile));
    expect(e).toEqual({
      ok: true,
      profileDigest: profile.profileDigest,
      checks: [
        { name: "runtime_plugins", ok: true, detail: "only agent-plane-profile loaded" },
        { name: "runtime_skills", ok: true, detail: "1 profile skill(s) loaded; 2 bundled or project skill(s) not judged" },
        { name: "runtime_mcp", ok: true, detail: "1 profile server(s) loaded, no others" },
      ],
    });
  });

  it("a pending MCP server is still connecting and passes; failed or needs-auth does not", async () => {
    const profile = await profileFor("claude-code");
    const at = (status: string) => claudeInitEvidence(profile, { ...faithful(profile), mcpServers: [{ name: "example-mcp", status }] });
    expect(at("pending").ok).toBe(true);
    expect(failing(at("failed"))).toEqual(["runtime_mcp: servers not serving: example-mcp (failed)"]);
    expect(failing(at("needs-auth"))).toEqual(["runtime_mcp: servers not serving: example-mcp (needs-auth)"]);
  });

  it("names every drift: a user plugin, its skill, a missing profile skill, a missing and an extra server", async () => {
    const profile = await profileFor("claude-code");
    const e = claudeInitEvidence(profile, {
      skills: ["debug", "claude-mem:remember"],
      plugins: [...faithful(profile).plugins, { name: "claude-mem", path: "/home/u/.claude/plugins/claude-mem" }],
      mcpServers: [{ name: "claude-mem-search", status: "connected" }],
    });
    expect(e.ok).toBe(false);
    expect(failing(e)).toEqual([
      "runtime_plugins: plugins outside the profile loaded: claude-mem",
      "runtime_skills: profile skills not loaded: agent-plane-profile:ts-review; plugin skills outside the profile: claude-mem:remember",
      "runtime_mcp: profile servers not loaded: example-mcp; servers outside the profile: claude-mem-search",
    ]);
  });

  it("the profile plugin loaded from another directory is not the profile's", async () => {
    const profile = await profileFor("claude-code");
    const e = claudeInitEvidence(profile, { ...faithful(profile), plugins: [{ name: "agent-plane-profile", path: "/elsewhere/plugin" }] });
    expect(failing(e)[0]).toMatch(/^runtime_plugins: profile plugin not loaded from .*\/run_1\/plugin; plugins outside the profile loaded: agent-plane-profile$/);
  });

  it("a profile with no skills and no servers expects no plugin and no server", async () => {
    const adapter = new ClaudeAdapter("claude" as AssistantId, noQuery);
    const i = input("claude-code", false);
    i.bundle.files = i.bundle.files.filter((f) => f.relPath === "CLAUDE.md");
    i.bundle.manifest.bundleDigest = sha256(jcs(i.bundle.files, "integer"));
    i.spec.context.bundle_digest = i.bundle.manifest.bundleDigest;
    const p = await adapter.provision(await adapter.prepare(i));
    const profile = verifiedProfile(p, await adapter.verify(p));
    expect(claudeInitEvidence(profile, { skills: ["debug"], plugins: [], mcpServers: [] }).ok).toBe(true);
    expect(failing(claudeInitEvidence(profile, { skills: [], plugins: [{ name: "x", path: "/x" }], mcpServers: [] }))).toEqual(["runtime_plugins: plugins outside the profile loaded: x"]);
  });

  it("a Codex profile is not judged against Claude init", async () => {
    const profile = await profileFor("codex");
    expect(() => claudeInitEvidence(profile, { skills: [], plugins: [], mcpServers: [] })).toThrow(NotSupportedError);
  });
});

describe("Claude adapter: run.started carries the evidence for a profile launch", () => {
  const RUN: RunSpec = {
    taskId: "AG-1" as never, prompt: "p", workdir: "/tmp",
    permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
  };
  const initOf = (inventory: ReturnType<typeof faithful>) => ({
    type: "system", subtype: "init", session_id: "s1", model: "claude-x", claude_code_version: "9.9", tools: [],
    skills: inventory.skills, plugins: inventory.plugins, mcp_servers: inventory.mcpServers,
  });
  async function started(run: RunSpec, init: unknown): Promise<NormalizedEvent> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Held open until the event is read: a settled run is forgotten by the adapter.
    const q = (() => (async function* () { yield init; await gate; })()) as unknown as typeof query;
    const adapter = new ClaudeAdapter("claude" as AssistantId, q);
    const handle = await adapter.start(run);
    try {
      for await (const e of adapter.events(handle)) if (e.type === "run.started") return e;
      throw new Error("no run.started");
    } finally {
      release();
    }
  }

  it("faithful init: profileEvidence ok; a user plugin: not ok", async () => {
    const profile = await profileFor("claude-code", false);
    const ok = await started({ ...RUN, profile }, initOf(faithful(profile)));
    expect((ok.payload as { profileEvidence: ProfileRuntimeEvidence }).profileEvidence.ok).toBe(true);
    const drift = faithful(profile);
    drift.plugins.push({ name: "claude-mem", path: "/u/claude-mem" });
    const bad = await started({ ...RUN, profile }, initOf(drift));
    expect(failing((bad.payload as { profileEvidence: ProfileRuntimeEvidence }).profileEvidence)).toEqual(["runtime_plugins: plugins outside the profile loaded: claude-mem"]);
  });

  it("no profile: no evidence, payload unchanged", async () => {
    const e = await started(RUN, initOf({ skills: [], plugins: [], mcpServers: [] }));
    expect(e.payload).toEqual({ providerSessionRef: "s1", model: "claude-x", tools: [], version: "9.9" });
  });
});
