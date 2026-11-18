/**
 * PR 2 of the Agent Runtime Registry: core `RUNTIME_KINDS` and the API catalogue become the only
 * provider table.
 *
 * Every former provider branch is kept here verbatim as a `legacy*` reference (from main at
 * 3736d82), and the new table-driven code must give the same result for it:
 * - capability probe: same fingerprint, version, auth state, models and config hash, per provider,
 *   over several fixture homes and environments;
 * - session input: same adapter kind, same identity/caching and same registry look-ups, per provider;
 * - quota probe: same dispatch per provider (the K3 endpoint pin stays where it was);
 * - harness, registry vocabulary and approval modes: the composer's maps equal their former literals;
 * - config load: an unknown provider or a mistyped known option fails with its config path.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  harnessForProvider, REGISTRY_ASSISTANT, RUNTIME_KINDS, runtimeConfigProblems, runtimeKindFor,
  type AgentAdapter, type AssistantId, type SessionInputAdapter,
} from "@agent-plane/core";
import { ClaudeAdapter, ClaudeCodeSessionInputAdapter, CodexAdapter, CursorAdapter, FakeAdapter, FakeSessionInputAdapter } from "@agent-plane/adapters";
import { loadConfig } from "../src/config.js";
import { probeCapability, type ProbeResult } from "../src/modules/capability-probe.js";
import { HARNESS_APPROVAL_MODES } from "../src/modules/composer/ports.js";
import { ANTHROPIC_USAGE_ENDPOINT, probeQuota } from "../src/modules/quota-probe.js";
import { RUNTIME_CATALOG, runtimeFor, sessionInputResolver } from "../src/modules/runtime-catalog.js";

// ---------------------------------------------------------------------------------------------
// Legacy references, verbatim from main at 3736d82.
// ---------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
async function legacyProbeVersion(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { encoding: "utf8", timeout: 1_500, killSignal: "SIGKILL" });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}
function safeText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
function directorySignature(path: string): string {
  if (!existsSync(path)) return "";
  try { return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.isDirectory() ? directorySignature(join(path, entry.name)) : fileSignature(join(path, entry.name))).join("|"); } catch { return ""; }
}
function fileSignature(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch { return ""; }
}
async function legacyProbeCapability(provider: string, options: Record<string, unknown> = {}): Promise<ProbeResult> {
  const root = provider === "anthropic" ? join(homedir(), ".claude") : provider === "openai" ? join(homedir(), ".codex") : "";
  const command = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : undefined;
  const version = command ? await legacyProbeVersion(command) : "in-process";
  const openRouterKeyEnv = typeof options.apiKeyEnv === "string" ? options.apiKeyEnv : "OPENROUTER_API_KEY";
  const authState = provider === "openrouter"
    ? (process.env[openRouterKeyEnv] ? "ok" : "missing")
    : root && (existsSync(join(root, ".credentials.json")) || existsSync(join(root, "auth.json"))) ? "ok" : provider === "fake" ? "ok" : "missing";
  const files = root ? ["config.json", "settings.json", "settings.local.json", "config.toml"] : [];
  if (provider === "anthropic") files.push("../.claude.json", "plugins/installed_plugins.json");
  const content = [...files.map((name) => fileSignature(join(root, name))), directorySignature(join(root, "skills")), directorySignature(join(root, "plugins"))].join("|");
  const configText = files.map((name) => safeText(join(root, name))).join("\n");
  const models = provider === "fake" ? ["fake-1"] : Array.from(configText.matchAll(/model\s*[:=]\s*["' ]?([A-Za-z0-9._-]+)/gi), (m) => m[1]!).sort();
  const configHash = createHash("sha256").update(content).digest("hex");
  const details = JSON.stringify({ version, authState, models, configHash, credentialEnv: provider === "openrouter" ? openRouterKeyEnv : undefined });
  return { version, authState, models, configHash, fingerprint: createHash("sha256").update(details).digest("hex") };
}

/** The server.ts session-input resolver, verbatim, with the db row and registry passed in. */
function legacySessionInputResolver(providerOf: (id: string) => string | undefined, adapterOf: (id: string) => AgentAdapter) {
  const fakes = new Map<string, FakeSessionInputAdapter>();
  const lives = new Map<string, ClaudeCodeSessionInputAdapter>();
  return (assistantId: string): SessionInputAdapter | undefined => {
    const provider = providerOf(assistantId);
    const row = provider === undefined ? undefined : { provider };
    if (row?.provider === "openai") {
      const owner = adapterOf(assistantId);
      return owner instanceof CodexAdapter ? owner.sessionInput : undefined;
    }
    if (row?.provider === "anthropic") {
      let adapter = lives.get(assistantId);
      if (!adapter) {
        const agent = adapterOf(assistantId);
        if (!(agent instanceof ClaudeAdapter)) return undefined;
        adapter = new ClaudeCodeSessionInputAdapter((sessionId) => agent.liveSession(sessionId));
        lives.set(assistantId, adapter);
      }
      return adapter;
    }
    if (row?.provider !== "fake") return undefined;
    let adapter = fakes.get(assistantId);
    if (!adapter) {
      adapter = new FakeSessionInputAdapter();
      fakes.set(assistantId, adapter);
    }
    return adapter;
  };
}

// ---------------------------------------------------------------------------------------------

const PROVIDERS = ["anthropic", "openai", "openrouter", "cursor", "bedrock", "fake", "nope"] as const;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, FAKE_OR_KEY: process.env.FAKE_OR_KEY };
const dirs: string[] = [];
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Fixture homes: empty; populated Claude and Codex config; auth only through the other file name. */
function fixtureHomes(): Record<string, string> {
  const empty = scratch("rk-home-empty-");
  const full = scratch("rk-home-full-");
  mkdirSync(join(full, ".claude", "skills", "s1"), { recursive: true });
  mkdirSync(join(full, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(full, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"FAKE-token-not-real"}}');
  // The probe's model regex reads `model: x` / `model = x` text (it does not match a JSON key `"model":`).
  writeFileSync(join(full, ".claude", "settings.json"), "model: claude-opus-x\n");
  writeFileSync(join(full, ".claude", "skills", "s1", "SKILL.md"), "# s1\n");
  writeFileSync(join(full, ".claude", "plugins", "installed_plugins.json"), "model=plug-model\n");
  writeFileSync(join(full, ".claude.json"), "model: top-level\n");
  mkdirSync(join(full, ".codex"), { recursive: true });
  writeFileSync(join(full, ".codex", "auth.json"), "{}");
  writeFileSync(join(full, ".codex", "config.toml"), 'model = "gpt-x"\n');
  const swapped = scratch("rk-home-swapped-");
  mkdirSync(join(swapped, ".claude"), { recursive: true });
  writeFileSync(join(swapped, ".claude", "auth.json"), "{}");
  mkdirSync(join(swapped, ".codex"), { recursive: true });
  writeFileSync(join(swapped, ".codex", ".credentials.json"), "{}");
  return { empty, full, swapped };
}

/** A PATH holding `claude` and `codex` stubs that print a version, so the version is fingerprinted. */
function stubBin(): string {
  const bin = scratch("rk-bin-");
  for (const [cmd, out] of [["claude", "2.9.9 (Claude Code)"], ["codex", "codex-cli 0.99.0"]] as const) {
    writeFileSync(join(bin, cmd), `#!/bin/sh\necho "${out}"\n`);
    chmodSync(join(bin, cmd), 0o755);
  }
  return bin;
}

describe("capability probe: fingerprints equal the former provider branches", () => {
  let homes: Record<string, string>;
  let bin: string;
  beforeAll(() => { homes = fixtureHomes(); bin = stubBin(); });

  const envs = {
    "no CLI, no key": () => { process.env.PATH = "/nonexistent-rk"; delete process.env.OPENROUTER_API_KEY; },
    "CLI stubs + OpenRouter key": () => { process.env.PATH = `${bin}:/usr/bin:/bin`; process.env.OPENROUTER_API_KEY = "FAKE-openrouter-not-real"; },
  } as const;
  const optionSets: Array<Record<string, unknown>> = [{}, { apiKeyEnv: "FAKE_OR_KEY" }, { apiKeyEnv: 42 }];

  it("for every provider, fixture home, environment and option set", async () => {
    let compared = 0;
    for (const [homeName, home] of Object.entries(homes)) {
      for (const [envName, apply] of Object.entries(envs)) {
        for (const options of optionSets) {
          for (const provider of PROVIDERS) {
            process.env.HOME = home;
            apply();
            if (options.apiKeyEnv === "FAKE_OR_KEY") process.env.FAKE_OR_KEY = "FAKE-or-not-real"; else delete process.env.FAKE_OR_KEY;
            const before = await legacyProbeCapability(provider, options);
            const after = await probeCapability(provider, options);
            expect(after, `${provider} home=${homeName} env=${envName} options=${JSON.stringify(options)}`).toEqual(before);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(3 * 2 * 3 * PROVIDERS.length);
  });

  it("the fixtures exercise the branches (not all fingerprints collapse to one value)", async () => {
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    process.env.HOME = homes.full!;
    const claude = await probeCapability("anthropic");
    expect(claude.version).toBe("2.9.9 (Claude Code)");
    expect(claude.authState).toBe("ok");
    expect(claude.models).toEqual(["claude-opus-x", "plug-model", "top-level"]);
    expect((await probeCapability("openai")).models).toEqual(["gpt-x"]);
    process.env.HOME = homes.empty!;
    expect((await probeCapability("anthropic")).authState).toBe("missing");
    expect(await probeCapability("fake")).toMatchObject({ version: "in-process", authState: "ok", models: ["fake-1"] });
    expect(await probeCapability("cursor")).toMatchObject({ version: "in-process", authState: "missing", models: [] });
  });
});

describe("session input: the resolver gives the same adapter kind and caching per provider", () => {
  const ids = ["claude", "claude-not-live", "codex-in", "codex-plain", "codex-wrong", "fake", "cursor", "bedrock", "missing"] as const;
  const providers: Record<string, string | undefined> = {
    claude: "anthropic", "claude-not-live": "anthropic", "codex-in": "openai", "codex-plain": "openai", "codex-wrong": "openai",
    fake: "fake", cursor: "cursor", bedrock: "bedrock", missing: undefined,
  };
  const agents = (): Record<string, AgentAdapter> => ({
    claude: new ClaudeAdapter("claude" as AssistantId, undefined, { liveInput: true }),
    // An anthropic row whose registry adapter is not a ClaudeAdapter: no capability, not cached.
    "claude-not-live": new FakeAdapter("claude-not-live" as AssistantId),
    "codex-in": new CodexAdapter("codex-in" as AssistantId, { appServerInput: true }),
    "codex-plain": new CodexAdapter("codex-plain" as AssistantId, { appServerInput: false }),
    "codex-wrong": new FakeAdapter("codex-wrong" as AssistantId),
    fake: new FakeAdapter("fake" as AssistantId),
    cursor: new CursorAdapter("cursor" as AssistantId, {}),
  });
  const kindOf = (a: SessionInputAdapter | undefined) => (a === undefined ? "none" : a.constructor.name);

  it("matches the former server.ts resolver call for call, including registry look-ups", () => {
    const run = (make: typeof legacySessionInputResolver) => {
      const table = agents();
      const lookups: string[] = [];
      const resolve = make((id) => providers[id], (id) => { lookups.push(id); const a = table[id]; if (!a) throw new Error(`Unknown assistant: ${id}`); return a; });
      const first = ids.map((id) => resolve(id));
      const second = ids.map((id) => resolve(id));
      return {
        kinds: first.map(kindOf),
        // Same instance on a second call exactly where the old resolver cached it.
        stable: ids.map((_, i) => first[i] !== undefined && first[i] === second[i]),
        codexIsOwn: first[ids.indexOf("codex-in")] === (table["codex-in"] as CodexAdapter).sessionInput,
        lookups,
      };
    };
    const before = run(legacySessionInputResolver);
    const after = run(sessionInputResolver);
    expect(after).toEqual(before);
    expect(after.kinds).toEqual([
      "ClaudeCodeSessionInputAdapter", "none", before.kinds[2], "none", "none", "FakeSessionInputAdapter", "none", "none", "none",
    ]);
    expect(after.kinds[2]).not.toBe("none");
    expect(after.codexIsOwn).toBe(true);
    // The fake binding never touches the registry; Claude looks up once, then hits the cache.
    expect(after.lookups.filter((id) => id === "fake")).toEqual([]);
    expect(after.lookups.filter((id) => id === "claude")).toEqual(["claude"]);
  });

  it("only anthropic, openai and fake carry a binding", () => {
    expect(RUNTIME_CATALOG.filter((d) => d.sessionInput).map((d) => d.provider)).toEqual(["anthropic", "openai", "fake"]);
  });
});

describe("quota probe dispatch", () => {
  it("only anthropic has an idle probe; every other provider keeps the same unsupported outcome", async () => {
    expect(RUNTIME_CATALOG.filter((d) => d.quotaProbe).map((d) => [d.provider, d.quotaProbe])).toEqual([["anthropic", "claude-oauth-usage"]]);
    for (const provider of ["openai", "openrouter", "cursor", "bedrock", "fake", "nope"]) {
      expect(await probeQuota(provider, {})).toEqual({ status: "unsupported", buckets: [], detail: `no verified idle quota endpoint for ${provider}` });
    }
  });

  it("anthropic still reaches the Claude usage probe and its guards (no network)", async () => {
    expect(await probeQuota("anthropic", { usageEndpoint: "https://collector.example/usage" }))
      .toEqual({ status: "unsupported", buckets: [], detail: "usage endpoint override refused" });
    expect(await probeQuota("anthropic", { usageEndpoint: ANTHROPIC_USAGE_ENDPOINT, credentialsPath: join(tmpdir(), "rk-no-such-credentials.json") }))
      .toEqual({ status: "unauthorized", buckets: [], detail: "no readable OAuth credentials" });
  });
});

describe("one provider table", () => {
  it("the composer's maps equal their former literals, in the same key order", () => {
    expect(HARNESS_APPROVAL_MODES).toEqual({
      "claude-code": ["auto-approve", "prompt-on-escalation", "read-only"], codex: ["auto-approve", "read-only"], cursor: ["auto-approve"], bedrock: [],
    });
    expect(Object.keys(HARNESS_APPROVAL_MODES)).toEqual(["claude-code", "codex", "cursor", "bedrock"]);
    expect(REGISTRY_ASSISTANT).toEqual({ "claude-code": "claude", codex: "codex", cursor: "cursor", bedrock: undefined });
    expect(Object.keys(REGISTRY_ASSISTANT)).toEqual(["claude-code", "codex", "cursor", "bedrock"]);
    const former: Record<string, string> = { anthropic: "claude-code", openai: "codex", openrouter: "codex", cursor: "cursor", bedrock: "bedrock" };
    for (const p of [...Object.keys(former), "fake", "nope", "constructor", "__proto__"]) expect(harnessForProvider(p), p).toBe(Object.hasOwn(former, p) ? former[p] : undefined);
  });

  it("every catalogue descriptor IS its core row (same facts, nothing restated), and vice versa", () => {
    expect(RUNTIME_CATALOG.map((d) => d.provider)).toEqual(RUNTIME_KINDS.map((k) => k.provider));
    for (const d of RUNTIME_CATALOG) {
      const k = runtimeKindFor(d.provider)!;
      expect(d.harness).toBe(k.harness);
      expect(d.registryAssistant).toBe(k.registryAssistant);
      expect(d.approvalModes).toBe(k.approvalModes);
      expect(d.options).toBe(k.options);
      expect(runtimeFor(d.provider)).toBe(d);
    }
    expect(Object.isFrozen(RUNTIME_KINDS)).toBe(true);
    for (const k of RUNTIME_KINDS) { expect(Object.isFrozen(k)).toBe(true); expect(Object.isFrozen(k.options)).toBe(true); }
  });
});

describe("configuration load validates provider and options", () => {
  const load = (assistantsYaml: string) => {
    const home = scratch("rk-cfg-");
    mkdirSync(join(home, "personal"), { recursive: true });
    writeFileSync(join(home, "personal", "config.yaml"), `assistants:\n${assistantsYaml}`);
    return () => loadConfig({ AGENT_PLANE_HOME: home } as NodeJS.ProcessEnv);
  };

  it("an unknown provider fails at load with its config path and the supported list", () => {
    expect(load("  bad:\n    provider: nope\n")).toThrow(
      'assistants.bad.provider "nope" is not supported (supported: anthropic, openai, openrouter, cursor, bedrock, fake)',
    );
  });

  it("a missing provider keeps its former message", () => {
    expect(load("  bad:\n    enabled: true\n")).toThrow("assistants.bad must have a provider");
  });

  it("a mistyped known option fails at load; every problem is listed", () => {
    const run = load([
      "  codex:\n    provider: openai\n    options:\n      appServerInput: \"true\"",
      "  or:\n    provider: openrouter\n    options:\n      reasoningEffort: extreme\n      apiKeyEnv: 7",
      "  fk:\n    provider: fake\n    options:\n      models: [fake-1]",
      "  cl:\n    provider: anthropic\n    options: [1]",
      "",
    ].join("\n"));
    let message = "";
    try { run(); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('assistants.codex.options.appServerInput must be a boolean for provider openai, got "true"');
    expect(message).toContain('assistants.or.options.reasoningEffort must be one of minimal | low | medium | high | xhigh | max | ultra for provider openrouter, got "extreme"');
    expect(message).toContain("assistants.or.options.apiKeyEnv must be a string for provider openrouter, got 7");
    expect(message).toContain('assistants.fk.options.models must be a list of { id, displayName? } strings for provider fake, got ["fake-1"]');
    expect(message).toContain("assistants.cl.options must be a mapping");
  });

  it("valid configs, unknown option keys and the fake's unknown harness still load (the adapter refuses that one)", () => {
    const config = load([
      "  c:\n    provider: anthropic\n    options:\n      usageEndpoint: https://api.anthropic.com/api/oauth/usage\n      somethingElse: 1",
      "  x:\n    provider: openai\n    options:\n      appServerInput: true",
      "  b:\n    provider: bedrock\n    options:\n      agentRuntimeArn: arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/FAKE-not-real",
      "  f:\n    provider: fake\n    options:\n      harness: gemini\n      models:\n        - id: fake-big\n          displayName: Big",
      "",
    ].join("\n"))();
    expect(Object.keys(config.assistants).sort()).toEqual(["b", "c", "f", "x"]);
  });

  it("runtimeConfigProblems is empty for every row with no options", () => {
    for (const k of RUNTIME_KINDS) expect(runtimeConfigProblems("a", k.provider, undefined)).toEqual([]);
  });
});
