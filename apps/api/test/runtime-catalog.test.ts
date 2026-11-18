/**
 * PR 1 of the Agent Runtime Registry: the runtime catalogue replaces the `createAdapter` switch.
 *
 * Equivalence is judged three ways, not by class identity alone:
 * 1. Constructor calls. Every adapter class is wrapped (same class, `instanceof` holds) to record
 *    the arguments it was built with. `legacyCreateAdapter` below is the switch exactly as it was
 *    at 5fa5013; for every provider and context combination, the catalogue and `Registry.init()`
 *    must make the same constructor call it did.
 * 2. Observable behaviour of the built adapter: `describe()` fields, Codex `sessionInput`, and the
 *    approval modes the adapter refuses before any process starts.
 * 3. Drift: the catalogue's harness, registry vocabulary and approval modes equal the three maps
 *    that still hold the same facts (`harnessForProvider`, `REGISTRY_ASSISTANT`,
 *    `HARNESS_APPROVAL_MODES`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  harnessForProvider, NotSupportedError, REGISTRY_ASSISTANT,
  type AgentAdapter, type ApprovalMode, type AssistantId, type CapabilityManifest, type RunSpec,
} from "@agent-plane/core";
import * as Adapters from "@agent-plane/adapters";
import type { AgentLauncher, ClaudeLaunchProfile } from "@agent-plane/adapters";
import { agentLauncher, type AgentUserConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { HARNESS_APPROVAL_MODES } from "../src/modules/composer/ports.js";
import { Registry } from "../src/modules/registry.js";
import { createAdapter, RUNTIME_CATALOG, runtimeFor, supportedProviders, type AdapterContext } from "../src/modules/runtime-catalog.js";
import { loadHarnessTestConfig } from "./helpers/boot-orchestrator.js";

const calls = vi.hoisted(() => [] as Array<{ cls: string; args: unknown[] }>);

vi.mock("@agent-plane/adapters", async (importOriginal) => {
  const real = await importOriginal<typeof Adapters>();
  // A subclass per adapter that records its constructor arguments and otherwise IS the adapter.
  const record = <T extends abstract new (...args: never[]) => object>(cls: T, name: string): T => {
    const Base = cls as unknown as new (...args: unknown[]) => object;
    const Recorded = class extends Base {
      constructor(...args: unknown[]) {
        calls.push({ cls: name, args: structuredClone(args) });
        super(...args);
      }
    };
    Object.defineProperty(Recorded, "name", { value: name });
    return Recorded as unknown as T;
  };
  return {
    ...real,
    ClaudeAdapter: record(real.ClaudeAdapter, "ClaudeAdapter"),
    CodexAdapter: record(real.CodexAdapter, "CodexAdapter"),
    OpenRouterCodexAdapter: record(real.OpenRouterCodexAdapter, "OpenRouterCodexAdapter"),
    CursorAdapter: record(real.CursorAdapter, "CursorAdapter"),
    BedrockAdapter: record(real.BedrockAdapter, "BedrockAdapter"),
    FakeAdapter: record(real.FakeAdapter, "FakeAdapter"),
  };
});

/** The former `registry.ts` switch, verbatim from 5fa5013, over the same (recorded) classes. */
function legacyCreateAdapter(
  id: AssistantId,
  provider: string,
  options: Record<string, unknown> = {},
  sessionInputEnabled = false,
  profile?: ClaudeLaunchProfile,
  launcher?: AgentLauncher,
): AgentAdapter {
  const { ClaudeAdapter, CodexAdapter, OpenRouterCodexAdapter, CursorAdapter, BedrockAdapter, FakeAdapter } = Adapters;
  switch (provider) {
    case "anthropic":
      return new ClaudeAdapter(id, undefined, { liveInput: sessionInputEnabled, ...(profile ? { profile } : {}), ...(launcher ? { agentLauncher: launcher } : {}) });
    case "openai":
      return new CodexAdapter(id, { appServerInput: sessionInputEnabled && options.appServerInput === true });
    case "openrouter":
      return new OpenRouterCodexAdapter(id, options as Adapters.OpenRouterOptions);
    case "cursor":
      return new CursorAdapter(id, options as Adapters.CursorOptions);
    case "bedrock":
      return new BedrockAdapter(id, options as Adapters.BedrockOptions);
    case "fake":
      return new FakeAdapter(id, undefined, options as Adapters.FakeOptions);
    default:
      throw new Error(
        `Unsupported provider "${provider}" for assistant ${id} (supported: anthropic, openai, openrouter, cursor, bedrock, fake)`,
      );
  }
}

const MODES: readonly ApprovalMode[] = ["auto-approve", "prompt-on-escalation", "read-only"];
const ID = "a" as AssistantId;
const PROFILE: ClaudeLaunchProfile = { plugins: ["p@m"], mcpServers: { srv: { command: "srv", args: [] } } } as unknown as ClaudeLaunchProfile;
const AGENT_USER: AgentUserConfig = {
  user: "aos-agent", group: "aos-agent", sudo: "/usr/bin/sudo", wrapper: "/opt/aos/run-as-agent", executable: "/opt/aos/claude",
  profilesRoot: "/var/lib/aos/profiles", worktreesRoot: "/var/lib/aos/worktrees", closeSchedule: "/var/lib/aos/close",
};

/** Per-provider option and context matrices (design §C PR 1, tests 1). */
interface Case { provider: string; options: Record<string, unknown>; sessionInput: boolean; profile: boolean; agentUser: boolean }
const CASES: Case[] = [
  ...[false, true].flatMap((sessionInput) => [false, true].flatMap((profile) => [false, true].map((agentUser) =>
    ({ provider: "anthropic", options: {}, sessionInput, profile, agentUser })))),
  ...[{ appServerInput: true }, { appServerInput: false }, {}].flatMap((options) => [false, true].map((sessionInput) =>
    ({ provider: "openai", options, sessionInput, profile: false, agentUser: false }))),
  // Providers that ignore the context: still crossed with it, so a leak would show.
  ...[
    { provider: "openrouter", options: { model: "m/x", apiKeyEnv: "FAKE_OPENROUTER_KEY_not_real" } },
    { provider: "cursor", options: { command: "agent-x", model: "auto" } },
    { provider: "bedrock", options: { agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/FAKE-not-real", region: "us-east-1" } },
    { provider: "fake", options: {} },
    { provider: "fake", options: { harness: "codex", agentUser: true } },
  ].flatMap((c) => [false, true].map((on) => ({ ...c, sessionInput: on, profile: on, agentUser: on }))),
];
const label = (c: Case) => `${c.provider} ${JSON.stringify(c.options)} sessionInput=${c.sessionInput} profile=${c.profile} agentUser=${c.agentUser}`;
const ctxOf = (c: Case): AdapterContext => ({
  sessionInputEnabled: c.sessionInput,
  providerProfile: c.profile ? PROFILE : undefined,
  agentLauncher: c.agentUser ? agentLauncher(AGENT_USER) : undefined,
});

/** The constructor calls (outermost first) one build makes; OpenRouter's own CodexAdapter is included. */
function constructed(build: () => AgentAdapter): { adapter: AgentAdapter; calls: Array<{ cls: string; args: unknown[] }> } {
  calls.length = 0;
  const adapter = build();
  return { adapter, calls: [...calls] };
}

const homes: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function registryFor(c: Case): Registry {
  const home = mkdtempSync(join(tmpdir(), "agent-plane-runtime-catalog-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(join(home, "personal", "config.yaml"), "assistants:\n  a:\n    provider: fake\n");
  const config: ResolvedConfig = loadHarnessTestConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { a: { provider: c.provider, options: c.options } } as ResolvedConfig["assistants"];
  config.sessionInput = { ...config.sessionInput, enabled: c.sessionInput };
  config.execution = {
    ...config.execution,
    ...(c.profile ? { providerProfile: PROFILE as unknown as ResolvedConfig["execution"]["providerProfile"] } : { providerProfile: undefined }),
    ...(c.agentUser ? { agentUser: AGENT_USER } : { agentUser: undefined }),
  };
  homes.push(home);
  const db = openDb(config.dbPath);
  dbs.push(db);
  return new Registry(db, config);
}

describe("catalogue equivalence with the former adapter switch", () => {
  beforeEach(() => { calls.length = 0; });

  it.each(CASES.map((c) => [label(c), c] as const))("%s: same class and constructor call", (_name, c) => {
    const ctx = ctxOf(c);
    const before = constructed(() => legacyCreateAdapter(ID, c.provider, c.options, ctx.sessionInputEnabled, ctx.providerProfile, ctx.agentLauncher));
    const after = constructed(() => createAdapter(ID, c.provider, c.options, ctx));
    expect(after.adapter.constructor).toBe(before.adapter.constructor);
    expect(after.calls).toEqual(before.calls);
    expect(after.calls.length).toBeGreaterThan(0);

    const registry = registryFor(c);
    const viaRegistry = constructed(() => { registry.init(); return registry.adapter("a"); });
    expect(viaRegistry.adapter.constructor).toBe(before.adapter.constructor);
    expect(viaRegistry.calls).toEqual(before.calls);
  });

  it("passes Claude its live-input flag always, and the profile and launcher only when set", () => {
    const bare = constructed(() => createAdapter(ID, "anthropic", {}, { sessionInputEnabled: false })).calls[0]!.args;
    expect(bare).toEqual([ID, undefined, { liveInput: false }]);
    expect(Object.keys(bare[2] as object)).toEqual(["liveInput"]);
    const full = constructed(() => createAdapter(ID, "anthropic", {}, { sessionInputEnabled: true, providerProfile: PROFILE, agentLauncher: agentLauncher(AGENT_USER) })).calls[0]!.args;
    expect(full).toEqual([ID, undefined, { liveInput: true, profile: PROFILE, agentLauncher: agentLauncher(AGENT_USER) }]);
  });
});

describe("observable behaviour of catalogue-built adapters (through Registry.init)", () => {
  const built = (c: Partial<Case> & { provider: string }): AgentAdapter => {
    const registry = registryFor({ options: {}, sessionInput: false, profile: false, agentUser: false, ...c });
    registry.init();
    return registry.adapter("a");
  };
  /**
   * The modes an adapter refuses before spawning. Only modes the catalogue says are NOT accepted
   * are probed, so a healthy adapter never launches; one that wrongly accepts is cancelled at once.
   */
  const refusedModes = async (adapter: AgentAdapter, accepted: readonly ApprovalMode[]): Promise<ApprovalMode[]> => {
    const refused: ApprovalMode[] = [];
    for (const mode of MODES.filter((m) => !accepted.includes(m))) {
      const run = { prompt: "x", workdir: tmpdir(), permissionPolicy: { mode } } as unknown as RunSpec;
      const outcome = await adapter.start(run).then(
        async (handle) => { await adapter.cancel(handle).catch(() => undefined); return "accepted" as const; },
        (e: unknown) => { if (e instanceof NotSupportedError) return "refused" as const; throw e; },
      );
      if (outcome === "refused") refused.push(mode);
    }
    return refused;
  };

  it("Claude declares the agent user exactly when execution.agentUser is set", async () => {
    expect((await built({ provider: "anthropic" }).describe()).harness?.agentUser).toBeUndefined();
    expect((await built({ provider: "anthropic", agentUser: true }).describe()).harness?.agentUser).toBe(true);
  });

  it("Codex exposes session input only with sessionInput.enabled AND options.appServerInput === true", async () => {
    for (const sessionInput of [false, true]) {
      for (const options of [{ appServerInput: true }, { appServerInput: false }, { appServerInput: "true" }, {}]) {
        const adapter = built({ provider: "openai", options, sessionInput }) as InstanceType<typeof Adapters.CodexAdapter>;
        const on = sessionInput && options.appServerInput === true;
        expect(adapter.sessionInput !== undefined, `${sessionInput} ${JSON.stringify(options)}`).toBe(on);
        const manifest = await adapter.describe();
        expect(manifest.providerDetail?.runtime).toBe(on ? "codex-app-server" : "@openai/codex-sdk");
      }
    }
  });

  it("Codex and OpenRouter refuse prompt-on-escalation before a process starts; Cursor refuses all but auto-approve", async () => {
    const refusedFor = async (provider: string, options: Record<string, unknown> = {}) =>
      refusedModes(built({ provider, options }), runtimeFor(provider)!.approvalModes);
    expect(await refusedFor("openai")).toEqual(["prompt-on-escalation"]);
    expect(await refusedFor("openrouter", { apiKeyEnv: "FAKE_OPENROUTER_KEY_not_real" })).toEqual(["prompt-on-escalation"]);
    expect(await refusedFor("cursor")).toEqual(["prompt-on-escalation", "read-only"]);
  });

  it("Bedrock (empty approval-mode set) still refuses on missing configuration, not by mode — unchanged", async () => {
    const adapter = built({ provider: "bedrock" });
    for (const mode of MODES) {
      await expect(adapter.start({ prompt: "x", workdir: tmpdir(), permissionPolicy: { mode } } as unknown as RunSpec))
        .rejects.toThrow(/agentRuntimeArn is not configured/);
    }
    expect(runtimeFor("bedrock")!.approvalModes).toEqual([]);
  });

  it("the fake keeps its test-only harness option and its construction-time refusal of an unknown harness", async () => {
    expect((await built({ provider: "fake" }).describe()).providerDetail?.harness).toBe("claude-code");
    expect((await built({ provider: "fake", options: { harness: "cursor" } }).describe()).providerDetail?.harness).toBe("cursor");
    expect(() => built({ provider: "fake", options: { harness: "gemini" } })).toThrow(
      'Unknown fake harness "gemini" for assistant a (expected one of: claude-code, codex, cursor, bedrock)',
    );
  });

  it("fake-provider manifest sync stores what the adapter describes, as before", async () => {
    const registry = registryFor({ provider: "fake", options: { harness: "codex" }, sessionInput: false, profile: false, agentUser: false });
    registry.init();
    const synced = await registry.sync("a");
    const direct = await new Adapters.FakeAdapter(ID, undefined, { harness: "codex" }).describe();
    const strip = (m: CapabilityManifest) => ({ ...m, evidence: { ...m.evidence, observedAt: "-" } });
    expect(strip(synced)).toEqual(strip(direct));
    expect(registry.manifest("a")).toEqual(synced);
    expect(registry.list().map((r) => [r.id, r.provider, r.enabled])).toEqual([["a", "fake", 1]]);
  });

  it("maturity 'scaffold' is exactly the adapters that say their event mapping is unverified", async () => {
    for (const d of RUNTIME_CATALOG) {
      const options = d.provider === "openrouter" ? { apiKeyEnv: "FAKE_OPENROUTER_KEY_not_real" } : {};
      const manifest = await built({ provider: d.provider, options }).describe();
        const unverified = (manifest.providerDetail as { mappingVerified?: unknown } | undefined)?.mappingVerified === false;
      expect(d.maturity === "scaffold", d.provider).toBe(unverified);
      expect(manifest.provider, d.provider).toBe(d.provider);
    }
  });
});

describe("unknown provider", () => {
  it("throws the same text as before, from createAdapter and from Registry.init", () => {
    const text = 'Unsupported provider "x" for assistant a (supported: anthropic, openai, openrouter, cursor, bedrock, fake)';
    expect(() => legacyCreateAdapter(ID, "x")).toThrow(text);
    expect(() => createAdapter(ID, "x", {}, { sessionInputEnabled: false })).toThrow(text);
    const registry = registryFor({ provider: "x", options: {}, sessionInput: false, profile: false, agentUser: false });
    expect(() => registry.init()).toThrow(text);
    // Prototype keys are not providers.
    for (const p of ["constructor", "toString", "__proto__"]) expect(runtimeFor(p)).toBeUndefined();
  });
});

describe("catalogue shape", () => {
  it("lists the six providers in the order the error always gave", () => {
    expect(supportedProviders()).toEqual(["anthropic", "openai", "openrouter", "cursor", "bedrock", "fake"]);
  });

  it("has unique well-formed providers, descriptor version 1 and frozen entries", () => {
    const providers = RUNTIME_CATALOG.map((d) => d.provider);
    expect(new Set(providers).size).toBe(providers.length);
    for (const d of RUNTIME_CATALOG) {
      expect(d.provider).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      expect(d.descriptorVersion).toBe(1);
      expect(Object.isFrozen(d)).toBe(true);
      expect(Object.isFrozen(d.approvalModes)).toBe(true);
      for (const m of d.approvalModes) expect(MODES).toContain(m);
    }
    expect(Object.isFrozen(RUNTIME_CATALOG)).toBe(true);
  });
});

describe("drift against the maps that still duplicate the catalogue", () => {
  it("harness equals harnessForProvider for every provider (the fake has none)", () => {
    for (const d of RUNTIME_CATALOG) expect(d.harness, d.provider).toBe(harnessForProvider(d.provider));
    expect(runtimeFor("fake")!.harness).toBeUndefined();
  });

  it("registry vocabulary equals REGISTRY_ASSISTANT for each harness", () => {
    for (const d of RUNTIME_CATALOG.filter((x) => x.harness)) expect(d.registryAssistant, d.provider).toBe(REGISTRY_ASSISTANT[d.harness!]);
    expect(runtimeFor("fake")!.registryAssistant).toBeUndefined();
  });

  it("approval modes equal HARNESS_APPROVAL_MODES for each harness, and every harness is catalogued", () => {
    for (const d of RUNTIME_CATALOG.filter((x) => x.harness)) expect([...d.approvalModes], d.provider).toEqual([...HARNESS_APPROVAL_MODES[d.harness!]]);
    const catalogued = new Set(RUNTIME_CATALOG.map((d) => d.harness).filter(Boolean));
    expect([...catalogued].sort()).toEqual(Object.keys(HARNESS_APPROVAL_MODES).sort());
    expect(Object.keys(REGISTRY_ASSISTANT).sort()).toEqual(Object.keys(HARNESS_APPROVAL_MODES).sort());
  });
});
