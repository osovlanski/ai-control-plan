/**
 * M3 provisioning lifecycle (docs/agentic-os-plan.md §3.4): plan, materialize, verify, dispose,
 * and the launch options a verified profile turns into. Every write lands in a temp directory.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSpec, AssistantId, BundleResponse, ProvisioningInput, RunSpec, VerifiedProfile } from "@agent-plane/core";
import { jcs, ProvisioningError } from "@agent-plane/core";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, CodexAdapter, FakeAdapter, PROFILE_MARKER, verifiedProfile } from "../src/index.js";
import { sha256 } from "../src/provisioning.js";

const CLAUDE_MD = "# Composed\n\nPrefer small, typed functions.\n";
const SKILL_MD = "---\nname: review\ndescription: review a diff\n---\nRead the diff first.\n";
const AGENTS_MD = "# Composed for Codex\n\nRun the tests before you finish.\n";

function bundle(harness: "claude-code" | "codex", files: Array<[string, string]>): BundleResponse {
  const bundleFiles = files.map(([relPath, content]) => ({ relPath, content, digest: sha256(content) }));
  const bundleDigest = sha256(jcs([...bundleFiles].sort((a, b) => (a.relPath < b.relPath ? -1 : 1)), "integer"));
  return {
    schemaVersion: "1.0",
    files: bundleFiles,
    manifest: {
      harness, bundleDigest, compiler: { name: "cockpit", version: "1" }, included: [], excluded: [],
      tokens: { estimated: 10, tokenMethod: "estimated", charsPerToken: 4, budget: 1000 },
    },
  };
}

function spec(harness: AgentSpec["harness"], b: BundleResponse, extra: Partial<AgentSpec["assets"]> = {}): AgentSpec {
  return {
    schema_version: "1.1", composition_revision_id: "CR-AG-1-1", task_id: "AG-1",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness, model: { primary: { id: "fake-1" }, fallbacks: [] },
    registry: { snapshot_digest: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-19T00:00:00.000Z", stale: false },
    assets: { skills: [], mcp_servers: [], subagents: [], ...extra },
    context: { fragments: [], memory_bundles: [], bundle_digest: b.manifest.bundleDigest, compiler: { name: "cockpit", version: "1", tokens: 10, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: `sha256:${"1".repeat(64)}` }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "task/AG-1", worktree_id: "w" },
    provisioning: { requested: "ambient" },
    explanation_ref: "CD-AG-1-1",
  };
}

const claudeBundle = () => bundle("claude-code", [["CLAUDE.md", CLAUDE_MD], [".claude/skills/review/SKILL.md", SKILL_MD]]);
const codexBundle = () => bundle("codex", [["AGENTS.md", AGENTS_MD]]);
const profilesDir = () => mkdtempSync(join(tmpdir(), "m3-profiles-"));
const input = (harness: "claude-code" | "codex", root = join(profilesDir(), "run_1")): ProvisioningInput => {
  const b = harness === "claude-code" ? claudeBundle() : codexBundle();
  return { spec: spec(harness, b), bundle: b, root, sessionId: "run_1" };
};
const claude = () => new ClaudeAdapter("claude" as AssistantId, (() => (async function* () {})()) as unknown as typeof query);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof ProvisioningError ? err.reason : `not a ProvisioningError: ${String(err)}`;
  }
  return "resolved";
};

describe("prepare", () => {
  it("Claude: full fidelity, skills as a per-run plugin, CLAUDE.md appended, user scope excluded", async () => {
    const plan = await claude().prepare(input("claude-code"));
    expect(plan.fidelity).toBe("full");
    expect(plan.files.map((f) => f.relPath)).toEqual(["CLAUDE.md", "plugin/.claude-plugin/plugin.json", "plugin/skills/review/SKILL.md"]);
    expect(plan.launch).toEqual({
      harness: "claude-code", settingSources: ["project"], pluginDir: join(plan.root, "plugin"), systemPromptAppend: CLAUDE_MD,
      strictMcpConfig: true, mcpServers: {}, disableClaudeAiConnectors: true,
    });
    expect(plan.excluded).toContain("user settings and CLAUDE.md (~/.claude)");
    expect(plan.visible.length).toBeGreaterThan(0);
    expect(plan.secretRefs).toEqual([]);
  });

  it("Codex: partial fidelity, AGENTS.md as developer_instructions, ~/.codex stated as visible", async () => {
    const plan = await new CodexAdapter("codex" as AssistantId).prepare(input("codex"));
    expect(plan.fidelity).toBe("partial");
    expect(plan.launch).toEqual({ harness: "codex", config: { developer_instructions: AGENTS_MD } });
    expect(plan.visible).toContain("~/.codex/config.toml (model, MCP servers, profiles, features)");
  });

  it("the profile digest has no path in it: the same revision under two roots gives one digest", async () => {
    const a = await claude().prepare(input("claude-code", join(profilesDir(), "run_1")));
    const b = await claude().prepare(input("claude-code", join(profilesDir(), "run_1")));
    expect(a.root).not.toBe(b.root);
    expect(a.profileDigest).toBe(b.profileDigest);
    expect(a.profileDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses what it cannot provision rather than dropping it", async () => {
    const i = input("claude-code");
    expect(await refusal(new CodexAdapter("codex" as AssistantId).prepare(i))).toBe("harness_mismatch");
    expect(await refusal(claude().prepare(input("codex")))).toBe("harness_mismatch");
    const tampered = structuredClone(i);
    tampered.bundle.files[0]!.content += "x";
    expect(await refusal(claude().prepare(tampered))).toBe("invalid_bundle");
    const withMcp = { ...i, spec: spec("claude-code", i.bundle, { mcp_servers: [{ id: "m", digest: `sha256:${"2".repeat(64)}`, allowlisted: true, tools_allowed: [], secret_refs: [{ type: "env", name: "FAKE_TOKEN" }] }] }) };
    expect(await refusal(claude().prepare(withMcp))).toBe("unsupported_asset");
    const stray = bundle("claude-code", [["notes.md", "x"]]);
    expect(await refusal(claude().prepare({ ...i, bundle: stray, spec: spec("claude-code", stray) }))).toBe("invalid_bundle");
    expect(await refusal(new CodexAdapter("codex" as AssistantId, { appServerInput: true }).prepare(input("codex")))).toBe("unsupported_transport");
  });

  it("refuses a root it must never write: relative, global assistant config, an ancestor of home", async () => {
    for (const root of ["relative/run_1", join(homedir(), ".claude", "run_1"), join(homedir(), ".codex", "p", "run_1"), join(homedir(), ".cursor"), "/"]) {
      expect(await refusal(claude().prepare({ ...input("claude-code"), root }))).toBe("invalid_root");
    }
    expect(await refusal(claude().prepare({ ...input("claude-code"), sessionId: "../escape" }))).toBe("invalid_root");
  });
});

describe("provision, verify, dispose", () => {
  it("materializes atomically with an ownership marker, verifies, and is idempotent for the same plan", async () => {
    const adapter = claude();
    const plan = await adapter.prepare(input("claude-code"));
    const profile = await adapter.provision(plan);
    expect(readFileSync(join(plan.root, "plugin/skills/review/SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(JSON.parse(readFileSync(join(plan.root, PROFILE_MARKER), "utf8"))).toMatchObject({ owner: "agent-plane", profileDigest: plan.profileDigest, sessionId: "run_1" });
    expect(lstatSync(join(plan.root, "CLAUDE.md")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(plan.root, "..")).filter((n) => n.includes("staging"))).toEqual([]);
    const v = await adapter.verify(profile);
    expect(v.ok).toBe(true);
    expect(v.fidelity).toBe("full");
    expect(v.checks.find((c) => c.name === "sdk")?.detail).toMatch(/^@anthropic-ai\/claude-agent-sdk \d+\.\d+\.\d+$/);
    await adapter.provision(plan); // same plan: no-op
    expect((await adapter.verify(profile)).ok).toBe(true);
  });

  it("refuses a root that exists without this profile's marker, and leaves it alone", async () => {
    const plan = await claude().prepare(input("claude-code"));
    mkdirSync(plan.root, { recursive: true });
    writeFileSync(join(plan.root, "keep.txt"), "user data");
    expect(await refusal(claude().provision(plan))).toBe("unowned_path");
    expect(await refusal(claude().dispose({ plan, marker: PROFILE_MARKER }))).toBe("unowned_path");
    expect(readFileSync(join(plan.root, "keep.txt"), "utf8")).toBe("user data");
  });

  it.each([
    ["a tampered file", (root: string) => writeFileSync(join(root, "CLAUDE.md"), "changed"), "files"],
    ["an extra file", (root: string) => writeFileSync(join(root, "plugin/skills/review/extra.md"), "x"), "no_extra_entries"],
    ["a planted symlink", (root: string) => symlinkSync(join(homedir(), ".claude"), join(root, "plugin/skills/home")), "no_extra_entries"],
    ["a rewritten marker", (root: string) => { chmodSync(join(root, PROFILE_MARKER), 0o600); writeFileSync(join(root, PROFILE_MARKER), "{}"); }, "marker"],
  ])("verify fails on %s and reports fidelity none", async (_label, mutate, failing) => {
    const adapter = claude();
    const profile = await adapter.provision(await adapter.prepare(input("claude-code")));
    mutate(profile.plan.root);
    const v = await adapter.verify(profile);
    expect(v.ok).toBe(false);
    expect(v.fidelity).toBe("none");
    expect(v.checks.find((c) => c.name === failing)?.ok).toBe(false);
    expect(() => verifiedProfile(profile, v)).toThrow(ProvisioningError);
  });

  it("verify fails when the plan object was changed after prepare", async () => {
    const adapter = claude();
    const profile = await adapter.provision(await adapter.prepare(input("claude-code")));
    const forged = { ...profile, plan: { ...profile.plan, launch: { ...profile.plan.launch, settingSources: ["project", "user"] } } };
    const v = await adapter.verify(forged as never);
    expect(v.checks.find((c) => c.name === "plan_digest")?.ok).toBe(false);
    expect(v.checks.find((c) => c.name === "launch_scope")?.ok).toBe(false);
  });

  it("dispose removes the profile once and is a no-op after", async () => {
    const adapter = new CodexAdapter("codex" as AssistantId);
    const profile = await adapter.provision(await adapter.prepare(input("codex")));
    expect(await adapter.dispose(profile)).toEqual({ removed: true });
    expect(existsSync(profile.plan.root)).toBe(false);
    expect(await adapter.dispose(profile)).toEqual({ removed: false });
  });

  it("an adapter refuses another harness's plan at provision", async () => {
    const plan = await claude().prepare(input("claude-code"));
    expect(await refusal(new CodexAdapter("codex" as AssistantId).provision(plan))).toBe("harness_mismatch");
  });

  it("the verified profile is deep-frozen", async () => {
    const adapter = claude();
    const profile = await adapter.provision(await adapter.prepare(input("claude-code")));
    const vp = verifiedProfile(profile, await adapter.verify(profile));
    expect(Object.isFrozen(vp) && Object.isFrozen(vp.launch) && Object.isFrozen(vp.files[0])).toBe(true);
  });
});

const RUN: RunSpec = {
  taskId: "AG-1" as never, prompt: "p", workdir: "/tmp",
  permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

async function verified(adapter: { prepare: ClaudeAdapter["prepare"]; provision: ClaudeAdapter["provision"]; verify: ClaudeAdapter["verify"] }, harness: "claude-code" | "codex"): Promise<VerifiedProfile> {
  const profile = await adapter.provision(await adapter.prepare(input(harness)));
  return verifiedProfile(profile, await adapter.verify(profile));
}

describe("launch with a verified profile", () => {
  it("Claude launches with project-only settings, the profile plugin, strict empty MCP and the appended CLAUDE.md", async () => {
    const seen: Array<Options | undefined> = [];
    const q = ((args: { options?: Options }) => {
      seen.push(args.options);
      return (async function* () {})();
    }) as unknown as typeof query;
    const adapter = new ClaudeAdapter("claude" as AssistantId, q, { profile: { plugins: ["x@y"], mcpServers: { s: { type: "stdio", command: "node" } } } });
    const profile = await verified(adapter, "claude-code");
    await adapter.start({ ...RUN, profile });
    expect(seen[0]).toMatchObject({
      settingSources: ["project"],
      plugins: [{ type: "local", path: join(profile.root, "plugin"), skipMcpDiscovery: true }],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      systemPrompt: { type: "preset", preset: "claude_code", append: CLAUDE_MD },
    });
  });

  it("an adapter given another harness's profile refuses before launching anything", async () => {
    let launched = 0;
    const q = (() => {
      launched += 1;
      return (async function* () {})();
    }) as unknown as typeof query;
    const codexProfile = await verified(new CodexAdapter("codex" as AssistantId), "codex");
    expect(await refusal(new ClaudeAdapter("claude" as AssistantId, q).start({ ...RUN, profile: codexProfile }))).toBe("harness_mismatch");
    expect(launched).toBe(0);
    const claudeProfile = await verified(claude(), "claude-code");
    expect(await refusal(new CodexAdapter("codex" as AssistantId).start({ ...RUN, profile: claudeProfile }))).toBe("harness_mismatch");
    expect(await refusal(new FakeAdapter("fake" as AssistantId, undefined, { harness: "codex" }).start({ ...RUN, profile: claudeProfile }))).toBe("harness_mismatch");
  });

  it("Codex passes the profile's instructions to the pinned CLI as a --config override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-codex-"));
    const argvFile = join(dir, "argv.json");
    const bin = join(dir, "codex");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");`,
    ].join("\n"), { mode: 0o755 });
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const profile = await verified(adapter, "codex");
    const handle = await adapter.start({ ...RUN, workdir: dir, profile });
    for await (const _e of adapter.events(handle)) { /* drain */ }
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const i = argv.indexOf(`developer_instructions=${JSON.stringify(AGENTS_MD)}`);
    expect(i).toBeGreaterThan(0);
    expect(argv[i - 1]).toBe("--config");
  });

  it("the fake reports the profile files it found at launch", async () => {
    const fake = new FakeAdapter("fake" as AssistantId, { events: [], ok: true });
    const profile = await verified(fake, "claude-code");
    const handle = await fake.start({ ...RUN, profile });
    const events = [];
    for await (const e of fake.events(handle)) events.push(e);
    expect(events.find((e) => e.summary.startsWith("Fake launched with profile"))?.summary).toBe(`Fake launched with profile ${profile.profileDigest} (full): 3/3 files present`);
  });
});
