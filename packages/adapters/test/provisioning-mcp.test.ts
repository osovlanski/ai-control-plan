/**
 * M3 S4 (plans/m3-provisioning.md §3): MCP servers in a per-run profile, with secrets by reference.
 * A secret VALUE exists only in the launch's process environment: never in a plan, a profile file,
 * a digest, a verification, Claude's `--mcp-config` (argv) or a Codex `--config` override (risk 10).
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSpec, AssistantId, BundleResponse, McpAssetRef, McpLaunch, ProvisioningInput, ProvisioningMcpServer, RunSpec, VerifiedProfile } from "@agent-plane/core";
import { jcs, ProvisioningError } from "@agent-plane/core";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, CodexAdapter, FakeAdapter, mcpSecretEnv, mcpServerName, verifiedProfile } from "../src/index.js";
import { sha256 } from "../src/provisioning.js";

const SECRET = "FAKE-mcp-token-not-real";
const DIGEST = `sha256:${"2".repeat(64)}`;

function bundle(harness: "claude-code" | "codex"): BundleResponse {
  const [relPath, content] = harness === "claude-code" ? ["CLAUDE.md", "# Composed\n"] : ["AGENTS.md", "# Composed for Codex\n"];
  const files = [{ relPath, content, digest: sha256(content) }];
  return {
    schemaVersion: "1.0",
    files,
    manifest: {
      harness, bundleDigest: sha256(jcs(files, "integer")), compiler: { name: "cockpit", version: "1" }, included: [], excluded: [],
      tokens: { estimated: 10, tokenMethod: "estimated", charsPerToken: 4, budget: 1000 },
    },
  };
}

const launch = (over: Partial<McpLaunch> = {}): McpLaunch => ({
  transport: "stdio", command: "example-mcp", args: ["--stdio"], env: { EXAMPLE_TOKEN: { type: "env", name: "EXAMPLE_TOKEN_REF" } }, ...over,
});
const ref = (id = "mcp:example-mcp", l: McpLaunch = launch()): McpAssetRef => ({
  id, digest: DIGEST, allowlisted: true, tools_allowed: [], secret_refs: Object.values(l.env).map((r) => ({ ...r })),
});

function input(harness: "claude-code" | "codex", servers: ProvisioningMcpServer[] = [{ ref: ref(), launch: launch() }], root = join(mkdtempSync(join(tmpdir(), "m3s4-")), "run_1")): ProvisioningInput {
  const b = bundle(harness);
  const spec: AgentSpec = {
    schema_version: "1.1", composition_revision_id: "CR-AG-1-1", task_id: "AG-1",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness, model: { primary: { id: "fake-1" }, fallbacks: [] },
    registry: { snapshot_digest: `sha256:${"0".repeat(64)}`, observed_at: "2026-10-19T00:00:00.000Z", stale: false },
    assets: { skills: [], mcp_servers: servers.map((s) => s.ref), subagents: [] },
    context: { fragments: [], memory_bundles: [], bundle_digest: b.manifest.bundleDigest, compiler: { name: "cockpit", version: "1", tokens: 10, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: `sha256:${"1".repeat(64)}` }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "task/AG-1", worktree_id: "w" },
    provisioning: { requested: "isolated" },
    explanation_ref: "CD-AG-1-1",
  };
  return { spec, bundle: b, root, sessionId: "run_1", mcpServers: servers };
}

const claude = (q?: typeof query) => new ClaudeAdapter("claude" as AssistantId, q ?? ((() => (async function* () {})()) as unknown as typeof query));
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof ProvisioningError ? `${err.reason}: ${err.message}` : `not a ProvisioningError: ${String(err)}`;
  }
  return "resolved";
};
const RUN: RunSpec = {
  taskId: "AG-1" as never, prompt: "p", workdir: "/tmp",
  permissionPolicy: { mode: "auto-approve" }, env: { redactionRules: [], maxRuntimeMs: 10_000 },
};

async function verified(adapter: { prepare: ClaudeAdapter["prepare"]; provision: ClaudeAdapter["provision"]; verify: ClaudeAdapter["verify"] }, i: ProvisioningInput): Promise<VerifiedProfile> {
  const profile = await adapter.provision(await adapter.prepare(i));
  const verification = await adapter.verify(profile);
  expect(verification.ok).toBe(true);
  return verifiedProfile(profile, verification);
}

/** Every file under `dir`, read back as text. */
const contents = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("\n");

describe("prepare: MCP servers by reference", () => {
  it.each(["claude-code", "codex"] as const)("%s: the launch names the server and maps env var to secret reference, no value", async (harness) => {
    const adapter = harness === "claude-code" ? claude() : new CodexAdapter("codex" as AssistantId);
    const plan = await adapter.prepare(input(harness));
    expect(plan.launch.mcpServers).toEqual({
      "example-mcp": { asset: { id: "mcp:example-mcp", digest: DIGEST }, command: "example-mcp", args: ["--stdio"], envRefs: { EXAMPLE_TOKEN: "EXAMPLE_TOKEN_REF" } },
    });
    expect(plan.secretRefs).toEqual(["EXAMPLE_TOKEN_REF"]);
    expect(plan.visible.some((v) => v.startsWith("MCP secret values in the"))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it("the digest is content-addressed: same servers, same digest across roots; another command, another digest", async () => {
    const a = await claude().prepare(input("claude-code"));
    const b = await claude().prepare(input("claude-code"));
    expect(b.profileDigest).toBe(a.profileDigest);
    const other = launch({ command: "other-mcp" });
    const c = await claude().prepare(input("claude-code", [{ ref: ref(undefined, other), launch: other }]));
    expect(c.profileDigest).not.toBe(a.profileDigest);
    const none = await claude().prepare(input("claude-code", []));
    expect(none.profileDigest).not.toBe(a.profileDigest);
  });

  it("no servers: Codex config carries no mcp_servers, and nothing is visible about secrets", async () => {
    const plan = await new CodexAdapter("codex" as AssistantId).prepare(input("codex", []));
    expect(plan.launch).toEqual({ harness: "codex", config: { developer_instructions: "# Composed for Codex\n" } });
    expect(plan.secretRefs).toEqual([]);
  });

  it("refuses what it cannot launch safely, naming references and never a value", async () => {
    const i = input("claude-code");
    const remote = launch({ transport: "remote", command: undefined, url: "https://mcp.example.invalid/" });
    const argv = launch({ args: ["--token=${EXAMPLE_TOKEN}"] });
    const keychain = launch({ env: { EXAMPLE_TOKEN: { type: "keychain", name: "fake-item" } } });
    const cases: Array<[string, ProvisioningInput, RegExp]> = [
      ["no launch shape", { ...i, mcpServers: [] }, /^digest_mismatch: no launch shape for MCP server mcp:example-mcp/],
      ["a launch shape the revision does not attach", { ...i, mcpServers: [...i.mcpServers!, { ref: ref("mcp:extra"), launch: launch() }] }, /^digest_mismatch: MCP launch shape for mcp:extra is not attached/],
      ["a shape at another digest", { ...i, mcpServers: [{ ref: { ...ref(), digest: `sha256:${"3".repeat(64)}` }, launch: launch() }] }, /^digest_mismatch/],
      ["remote", input("claude-code", [{ ref: ref(undefined, remote), launch: remote }]), /^unsupported_transport: .*transport remote/],
      ["a secret in argv", input("claude-code", [{ ref: ref(undefined, argv), launch: argv }]), /^unsupported_asset: .*never in argv/],
      ["a keychain ref", input("claude-code", [{ ref: ref(undefined, keychain), launch: keychain }]), /^unsupported_asset: .*keychain/],
      ["secret_refs that are not the launch's", input("claude-code", [{ ref: { ...ref(), secret_refs: [] }, launch: launch() }]), /^digest_mismatch: .*secret_refs/],
      ["one env var from two references", input("claude-code", [
        { ref: ref("mcp:a"), launch: launch() },
        { ref: ref("mcp:b", launch({ env: { EXAMPLE_TOKEN: { type: "env", name: "OTHER_REF" } } })), launch: launch({ env: { EXAMPLE_TOKEN: { type: "env", name: "OTHER_REF" } } }) },
      ]), /^unsupported_asset: MCP servers read EXAMPLE_TOKEN from different secret references/],
      ["two servers under one name", input("claude-code", [{ ref: ref("mcp:a.b"), launch: launch() }, { ref: ref("mcp:a_b"), launch: launch() }]), /^invalid_bundle: .*same name a_b/],
    ];
    for (const [name, given, expected] of cases) expect(await refusal(claude().prepare(given)), name).toMatch(expected);
  });

  it("server names are valid Claude names and bare Codex TOML keys", () => {
    expect(mcpServerName("mcp:example-mcp")).toBe("example-mcp");
    expect(mcpServerName("claude-skills:db.server@2")).toBe("claude-skills_db_server_2");
  });
});

describe("launch: the secret value reaches the process environment and nothing else", () => {
  it("Claude: --mcp-config carries ${VAR}, the SDK env carries the value, the profile on disk does not", async () => {
    const seen: Array<Options | undefined> = [];
    const q = ((args: { options?: Options }) => {
      seen.push(args.options);
      return (async function* () {})();
    }) as unknown as typeof query;
    const adapter = claude(q);
    const i = input("claude-code");
    const profile = await verified(adapter, i);
    await adapter.start({ ...RUN, profile, secretEnv: { EXAMPLE_TOKEN_REF: SECRET } });
    const options = seen[0]!;
    expect(options.mcpServers).toEqual({ "example-mcp": { type: "stdio", command: "example-mcp", args: ["--stdio"], env: { EXAMPLE_TOKEN: "${EXAMPLE_TOKEN}" } } });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.env?.EXAMPLE_TOKEN).toBe(SECRET);
    const { env: _env, abortController: _a, spawnClaudeCodeProcess: _s, ...rest } = options;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
    expect(JSON.stringify(profile)).not.toContain(SECRET);
    expect(contents(i.root)).not.toContain(SECRET);
  });

  it("Claude: a launch that did not resolve the reference refuses before the SDK is called", async () => {
    let calls = 0;
    const q = (() => { calls += 1; return (async function* () {})(); }) as unknown as typeof query;
    const adapter = claude(q);
    const profile = await verified(adapter, input("claude-code"));
    const message = await refusal(adapter.start({ ...RUN, profile }));
    expect(message).toBe("unsupported_asset: MCP server mcp:example-mcp needs secret reference EXAMPLE_TOKEN_REF, which the launch did not resolve");
    expect(calls).toBe(0);
  });

  it("Codex: env_vars names in --config, the value only in the CLI's environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3s4-codex-"));
    const out = join(dir, "launch.json");
    const bin = join(dir, "codex");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.EXAMPLE_TOKEN ?? null }));`,
      `process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");`,
    ].join("\n"), { mode: 0o755 });
    const adapter = new CodexAdapter("codex" as AssistantId, { codex: { codexPathOverride: bin } });
    const i = input("codex");
    const profile = await verified(adapter, i);
    const handle = await adapter.start({ ...RUN, workdir: dir, profile, secretEnv: { EXAMPLE_TOKEN_REF: SECRET } });
    for await (const _e of adapter.events(handle)) { /* drain */ }
    const seen = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; token: string | null };
    expect(seen.argv).toEqual(expect.arrayContaining([
      'mcp_servers.example-mcp.command="example-mcp"',
      'mcp_servers.example-mcp.args=["--stdio"]',
      'mcp_servers.example-mcp.env_vars=["EXAMPLE_TOKEN"]',
    ]));
    expect(seen.argv.join(" ")).not.toContain(SECRET);
    expect(seen.token).toBe(SECRET);
    expect(contents(i.root)).not.toContain(SECRET);
  });

  it("the fake refuses an unresolved reference and reports delivered env var names only", async () => {
    const fake = new FakeAdapter("fake" as AssistantId, { events: [], ok: true });
    const profile = await verified(fake, input("claude-code"));
    expect(await refusal(fake.start({ ...RUN, profile }))).toMatch(/^unsupported_asset: .*EXAMPLE_TOKEN_REF/);
    const handle = await fake.start({ ...RUN, profile, secretEnv: { EXAMPLE_TOKEN_REF: SECRET } });
    const events = [];
    for await (const e of fake.events(handle)) events.push(e);
    const launched = events.find((e) => e.summary.startsWith("Fake launched with profile"))!;
    expect((launched.payload as { mcp: unknown }).mcp).toEqual({ servers: ["example-mcp"], secretsDelivered: ["EXAMPLE_TOKEN"] });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("mcpSecretEnv maps env var to the resolved value and is empty without a profile", async () => {
    const profile = await verified(claude(), input("claude-code"));
    expect(mcpSecretEnv(profile, { EXAMPLE_TOKEN_REF: SECRET })).toEqual({ EXAMPLE_TOKEN: SECRET });
    expect(mcpSecretEnv(undefined, { EXAMPLE_TOKEN_REF: SECRET })).toEqual({});
  });
});
