/**
 * M3 S5b: the optional `codex debug prompt-input` probe. Injected runs pin the checks; the real
 * binary from node_modules pins the probe facts. No credentials, no model request.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec, AssistantId, BundleResponse, McpLaunch, ProvisionedProfile, ProvisioningInput, ProvisioningMcpServer, RunSpec } from "@agent-plane/core";
import { jcs } from "@agent-plane/core";
import { CodexAdapter, codexConfigArgs, codexProfileConfig, probeCodexProfile, verifiedProfile, type CodexProbeRun } from "../src/index.js";
import { sha256 } from "../src/provisioning.js";

const SECRET = "FAKE-probe-token-not-real";
const INSTRUCTIONS = "# Composed for Codex\n\nUse \"pnpm\", never npm.\n";
const DIGEST = `sha256:${"2".repeat(64)}`;

function input(content: string | undefined, servers: ProvisioningMcpServer[] = []): ProvisioningInput {
  const files = content === undefined ? [] : [{ relPath: "AGENTS.md", content, digest: sha256(content) }];
  const bundle: BundleResponse = {
    schemaVersion: "1.0",
    files,
    manifest: {
      harness: "codex", bundleDigest: sha256(jcs(files, "integer")), compiler: { name: "cockpit", version: "1" }, included: [], excluded: [],
      tokens: { estimated: 10, tokenMethod: "estimated", charsPerToken: 4, budget: 1000 },
    },
  };
  const spec: AgentSpec = {
    schema_version: "1.1", composition_revision_id: "CR-AG-1-1", task_id: "AG-1",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness: "codex", model: { primary: { id: "fake-1" }, fallbacks: [] },
    registry: { snapshot_digest: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-19T00:00:00.000Z", stale: false },
    assets: { skills: [], mcp_servers: servers.map((s) => s.ref), subagents: [] },
    context: { fragments: [], memory_bundles: [], bundle_digest: bundle.manifest.bundleDigest, compiler: { name: "cockpit", version: "1", tokens: 10, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: `sha256:${"1".repeat(64)}` }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "task/AG-1", worktree_id: "w" },
    provisioning: { requested: "isolated" },
    explanation_ref: "CD-AG-1-1",
  };
  return { spec, bundle, root: join(mkdtempSync(join(tmpdir(), "m3s5b-")), "run_1"), sessionId: "run_1", mcpServers: servers };
}

const mcpLaunch: McpLaunch = { transport: "stdio", command: "example-mcp", args: ["--stdio"], env: { EXAMPLE_TOKEN: { type: "env", name: "EXAMPLE_TOKEN_REF" } } };
const mcpServer: ProvisioningMcpServer = {
  ref: { id: "mcp:example-mcp", digest: DIGEST, allowlisted: true, tools_allowed: [], secret_refs: [{ type: "env", name: "EXAMPLE_TOKEN_REF" }] },
  launch: mcpLaunch,
};

/** What prompt-input prints: developer messages, then user messages, Responses API items. */
const rendered = (developerFirst: string | undefined, userTexts: string[] = []) => JSON.stringify([
  { type: "message", role: "developer", content: [...(developerFirst === undefined ? [] : [{ type: "input_text", text: developerFirst }]), { type: "input_text", text: "<permissions instructions>…" }] },
  { type: "message", role: "user", content: [...userTexts.map((text) => ({ type: "input_text", text })), { type: "input_text", text: "agent-plane profile probe" }] },
]);

interface Call { command: string; args: string[]; env: Record<string, string>; cwd: string }
function recorder(result: { code: number | null; stdout: string; stderr?: string }): { run: CodexProbeRun; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, run: async (command, args, { env, cwd }) => { calls.push({ command, args, env, cwd }); return { stderr: "", ...result }; } };
}

async function provisioned(adapter: CodexAdapter, i: ProvisioningInput): Promise<ProvisionedProfile> {
  return adapter.provision(await adapter.prepare(i));
}

const byName = (checks: { name: string; ok: boolean }[]) => Object.fromEntries(checks.map((c) => [c.name, c.ok]));

const savedToken = process.env.EXAMPLE_TOKEN;
afterEach(() => {
  if (savedToken === undefined) delete process.env.EXAMPLE_TOKEN;
  else process.env.EXAMPLE_TOKEN = savedToken;
});

describe("probeCodexProfile with an injected run", () => {
  it("passes when developer_instructions are the first developer input and nowhere else", async () => {
    const { run, calls } = recorder({ code: 0, stdout: rendered(INSTRUCTIONS) });
    const adapter = new CodexAdapter("codex" as AssistantId, { probePromptInput: true, probeRun: run, codex: { codexPathOverride: "/opt/codex" } });
    const verification = await adapter.verify(await provisioned(adapter, input(INSTRUCTIONS)));
    expect(verification.ok).toBe(true);
    expect(verification.fidelity).toBe("partial");
    expect(byName(verification.checks)).toMatchObject({ prompt_input_exit: true, prompt_input_output: true, prompt_input_instructions: true, prompt_input_bundle_text: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("/opt/codex");
    expect(call!.args).toEqual(["debug", "prompt-input", "--config", `developer_instructions=${JSON.stringify(INSTRUCTIONS)}`, "agent-plane profile probe"]);
    expect(Object.keys(call!.env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
    expect(call!.env.CODEX_HOME).toBe(call!.env.HOME);
    expect(call!.cwd).toBe(call!.env.CODEX_HOME);
    expect(existsSync(call!.cwd)).toBe(false); // the scratch home is removed
  });

  it("fails when the first developer input is not the instructions", async () => {
    const { run } = recorder({ code: 0, stdout: rendered("something else") });
    const adapter = new CodexAdapter("codex" as AssistantId, { probePromptInput: true, probeRun: run, codex: { codexPathOverride: "codex" } });
    const verification = await adapter.verify(await provisioned(adapter, input(INSTRUCTIONS)));
    expect(verification.ok).toBe(false);
    expect(verification.fidelity).toBe("none");
    expect(byName(verification.checks)).toMatchObject({ prompt_input_instructions: false, prompt_input_bundle_text: false });
  });

  it("fails when the bundle text also arrives a second way", async () => {
    const checks = await probeCodexProfile(await provisioned(new CodexAdapter("codex" as AssistantId), input(INSTRUCTIONS)), {
      codexPath: "codex", run: recorder({ code: 0, stdout: rendered(INSTRUCTIONS, [`# AGENTS.md instructions\n\n${INSTRUCTIONS}`]) }).run,
    });
    expect(byName(checks)).toMatchObject({ prompt_input_instructions: true, prompt_input_bundle_text: false });
  });

  it("with no instructions renders no override and passes only without bundle text", async () => {
    const { run, calls } = recorder({ code: 0, stdout: rendered(undefined) });
    const checks = await probeCodexProfile(await provisioned(new CodexAdapter("codex" as AssistantId), input(undefined)), { codexPath: "codex", run });
    expect(calls[0]!.args).toEqual(["debug", "prompt-input", "agent-plane profile probe"]);
    expect(checks.map((c) => c.name)).not.toContain("prompt_input_instructions");
    expect(byName(checks)).toMatchObject({ prompt_input_exit: true, prompt_input_output: true, prompt_input_bundle_text: true });
  });

  it.each([
    ["a non-zero exit", { code: 1, stdout: "" }, "prompt_input_exit"],
    ["a signal", { code: null, stdout: "" }, "prompt_input_exit"],
    ["unparsable output", { code: 0, stdout: "not json" }, "prompt_input_output"],
    ["output that is not a message list", { code: 0, stdout: JSON.stringify({ items: [] }) }, "prompt_input_output"],
  ])("%s is a failed check, not a throw", async (_label, result, failed) => {
    const checks = await probeCodexProfile(await provisioned(new CodexAdapter("codex" as AssistantId), input(INSTRUCTIONS)), { codexPath: "codex", run: recorder(result).run });
    expect(checks.find((c) => c.name === failed)).toMatchObject({ ok: false });
    expect(checks.every((c) => c.name === failed || c.ok)).toBe(true);
  });

  it("a missing binary is a failed check, not a throw", async () => {
    const adapter = new CodexAdapter("codex" as AssistantId, { probePromptInput: true, codex: { codexPathOverride: join(tmpdir(), "no-such-codex-binary") } });
    const verification = await adapter.verify(await provisioned(adapter, input(INSTRUCTIONS)));
    expect(verification.ok).toBe(false);
    expect(verification.checks.find((c) => c.name === "prompt_input_exit")).toMatchObject({ ok: false, detail: expect.stringMatching(/^codex did not start: .*ENOENT/) });
  });

  it("is off by default: verify runs nothing and keeps its checks", async () => {
    const { run, calls } = recorder({ code: 1, stdout: "" });
    const adapter = new CodexAdapter("codex" as AssistantId, { probeRun: run });
    const verification = await adapter.verify(await provisioned(adapter, input(INSTRUCTIONS)));
    expect(calls).toHaveLength(0);
    expect(verification.ok).toBe(true);
    expect(verification.checks.some((c) => c.name.startsWith("prompt_input_"))).toBe(false);
  });

  it("MCP secrets: a FAKE value in the parent env reaches neither the probe's env nor argv, and no server is started", async () => {
    process.env.EXAMPLE_TOKEN = SECRET;
    const { run, calls } = recorder({ code: 0, stdout: rendered(INSTRUCTIONS) });
    const checks = await probeCodexProfile(await provisioned(new CodexAdapter("codex" as AssistantId), input(INSTRUCTIONS, [mcpServer])), { codexPath: "codex", run });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.name === "prompt_input_mcp")?.detail).toMatch(/^1 MCP server/);
    const seen = JSON.stringify(calls);
    expect(seen).not.toContain(SECRET);
    expect(calls[0]!.args.join(" ")).not.toContain("mcp_servers");
  });
});

describe("the probe renders the launch's own --config", () => {
  it("codexConfigArgs equals the argv the SDK spawns for a profile run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3s5b-argv-"));
    const out = join(dir, "argv.json");
    const bin = join(dir, "codex");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");`,
    ].join("\n"), { mode: 0o755 });
    const base = { model_reasoning_summary: "auto", show_raw_agent_reasoning: false, tools: { view_image: true }, "key.with dots": 2 };
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin, config: base } });
    const i = input(INSTRUCTIONS, [mcpServer]);
    const profile = await adapter.provision(await adapter.prepare(i));
    const verified = verifiedProfile(profile, await adapter.verify(profile));
    const run: RunSpec = {
      taskId: "AG-1" as never, prompt: "p", workdir: dir, profile: verified, secretEnv: { EXAMPLE_TOKEN_REF: SECRET },
      permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
    };
    const handle = await adapter.start(run);
    for await (const _e of adapter.events(handle)) { /* drain */ }
    const argv = JSON.parse(readFileSync(out, "utf8")) as string[];
    const launch = profile.plan.launch;
    if (launch.harness !== "codex") throw new Error("codex profile expected");
    const expected = codexConfigArgs(codexProfileConfig(base, launch));
    expect(argv.slice(2, 2 + expected.length)).toEqual(expected);
    expect(expected).toContain(`developer_instructions=${JSON.stringify(INSTRUCTIONS)}`);
    expect(expected).toContain('mcp_servers.example-mcp.env_vars=["EXAMPLE_TOKEN"]');
  });
});

/** The SDK's pinned CLI, resolved the way `codexSdkBinary` does (vitest has no `import.meta.resolve`). */
function pinnedCodex(): string | undefined {
  const triple = ({ "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" } as Record<string, string>)[`${process.platform}-${process.arch}`];
  if (!triple) return undefined;
  try {
    const sdk = createRequire(join(realpathSync(fileURLToPath(new URL("../node_modules/@openai/codex-sdk", import.meta.url))), "dist/index.js"));
    const cli = createRequire(sdk.resolve("@openai/codex/package.json"));
    const bin = join(dirname(cli.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), `vendor/${triple}/bin/codex`);
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}
const realCodex = pinnedCodex();

describe.skipIf(!realCodex)("probeCodexProfile against the pinned Codex binary", () => {
  it("passes for the profile's instructions and fails when the launch drifts from the bundle", async () => {
    const adapter = new CodexAdapter("codex" as AssistantId, { probePromptInput: true, codex: { codexPathOverride: realCodex! } });
    const profile = await provisioned(adapter, input(INSTRUCTIONS));
    const verification = await adapter.verify(profile);
    expect(verification.checks.filter((c) => !c.ok)).toEqual([]);
    expect(byName(verification.checks)).toMatchObject({ prompt_input_exit: true, prompt_input_output: true, prompt_input_instructions: true, prompt_input_bundle_text: true });

    const drifted: ProvisionedProfile = { ...profile, plan: { ...profile.plan, launch: { harness: "codex", config: { developer_instructions: "# Not the bundle\n" } } } };
    const checks = await probeCodexProfile(drifted, { codexPath: realCodex! });
    expect(byName(checks)).toMatchObject({ prompt_input_exit: true, prompt_input_instructions: true, prompt_input_bundle_text: false });
  }, 30_000);
});
