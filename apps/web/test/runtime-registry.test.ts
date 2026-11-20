import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../api/src/config.js";
import { runtimeCatalogProjection } from "../../api/src/modules/runtime-lifecycle.js";
import { api, type AssistantLifecycle, type RuntimeCatalog } from "../src/api.js";
import {
  agentStanding, agentTally, lifecycleDigest, authText, configSnippet, conformanceText, enablementText, installedText, statusTone, suggestedAssistantId, unconfiguredRuntimes,
} from "../src/shell/runtime-registry.js";

afterEach(() => vi.unstubAllGlobals());

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/agent-runtime/v1/fixtures/valid");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

describe("runtime registry client routes", () => {
  it.each([
    ["runtimeCatalog", () => api.runtimeCatalog(), "/api/runtimes/catalog", undefined],
    ["testAssistant", () => api.testAssistant("personal claude"), "/api/assistants/personal%20claude/test", "POST"],
    ["disableAssistant", () => api.disableAssistant("a"), "/api/assistants/a/disable", "POST"],
    ["enableAssistant", () => api.enableAssistant("a"), "/api/assistants/a/enable", "POST"],
  ] as const)("%s calls exactly its agent-runtime v1 route", async (_name, call, url, method) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method).toBe(method);
    // No body: these routes take none, and the UI never sends configuration.
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.body).toBeUndefined();
  });

  it("surfaces the plane's 409 text for a test already running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "a test of a is already running" }), { status: 409 })));
    await expect(api.testAssistant("a")).rejects.toThrow("a test of a is already running");
  });
});

describe("Add a runtime", () => {
  const catalog = fixture<RuntimeCatalog>("catalog-minimal.json");

  it("lists only catalogue providers that no assistant is configured for, in catalogue order", () => {
    expect(unconfiguredRuntimes(catalog.runtimes, ["openai"]).map((r) => r.provider)).toEqual(["agy"]);
    expect(unconfiguredRuntimes(catalog.runtimes, []).map((r) => r.provider)).toEqual(["openai", "agy"]);
    expect(unconfiguredRuntimes(catalog.runtimes, ["openai", "agy"])).toEqual([]);
  });

  it("suggests an id no configured assistant uses", () => {
    expect(suggestedAssistantId("cursor", ["personal-claude"])).toBe("cursor");
    expect(suggestedAssistantId("cursor", ["cursor", "cursor-2"])).toBe("cursor-3");
  });

  it("the snippet is a config entry with provider and enabled only", () => {
    expect(configSnippet("cursor", ["cursor"])).toBe("assistants:\n  cursor-2:\n    provider: cursor\n    enabled: true");
  });

  it.each(runtimeCatalogProjection().runtimes.map((r) => r.provider))("the plane's own config loader accepts the %s snippet as written", (provider) => {
    const home = mkdtempSync(join(tmpdir(), "acp-snippet-"));
    try {
      mkdirSync(join(home, "personal"), { mode: 0o700 });
      writeFileSync(join(home, "personal", "config.yaml"), `${configSnippet(provider, [])}\n`);
      const config = loadConfig({ AGENT_PLANE_HOME: home });
      expect(config.assistants).toEqual({ [provider]: { provider, enabled: true } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("lifecycle text", () => {
  const lifecycles = readdirSync(FIXTURES).filter((f) => f.startsWith("lifecycle-")).map((f) => [f, fixture<AssistantLifecycle>(f)] as const);

  it.each(lifecycles)("%s renders every state without inventing one", (_f, l) => {
    for (const text of [installedText(l.installed), authText(l.auth), conformanceText(l.conformance), enablementText(l.enablement)]) {
      expect(text).not.toMatch(/undefined|null|NaN/);
    }
  });

  it("names the version a conformance result is for and whether it gates routing", () => {
    expect(conformanceText({ required: false, state: "pass", descriptorVersion: 1, cliVersion: "2.1.0" })).toBe("passed · for CLI 2.1.0 · descriptor v1 · not required for routing");
    expect(conformanceText({ required: true, state: "stale", descriptorVersion: 1 })).toContain("required before routing");
  });

  it("keeps an unprobed install apart from a missing one, and auth apart from install", () => {
    expect(installedText({ state: "unknown" })).toBe("not probed yet");
    expect(installedText({ state: "missing" })).toBe("CLI did not run");
    expect(installedText({ state: "present", version: "1.2.3" })).toBe("installed · 1.2.3");
    expect(authText({ state: "unknown" })).toBe("unknown · no manifest yet");
    expect(authText({ state: "ok", source: "provider-api" })).toBe("ok · evidence: provider-api");
  });

  it("shows config and operator enablement separately", () => {
    expect(enablementText({ config: false, operator: "none", effective: false })).toBe("config disabled · no operator override");
    expect(enablementText({ config: true, operator: "disabled", effective: false })).toBe("config enabled · disabled by operator");
  });

  it("tones never read a not-run or unsupported check as a pass", () => {
    expect(statusTone("pass")).toBe("ok");
    expect(statusTone("not-run")).toBe("warn");
    expect(statusTone("unsupported")).toBe("muted");
    expect(statusTone("unavailable")).toBe("danger");
  });
});

describe("compact Agents row", () => {
  const lifecycles = readdirSync(FIXTURES).filter((f) => f.startsWith("lifecycle-")).map((f) => [f, fixture<AssistantLifecycle>(f)] as const);

  it.each(lifecycles)("%s: standing and digest follow the served lifecycle", (_f, l) => {
    const standing = agentStanding(l, l.enablement.config);
    if (!l.enablement.effective) expect(standing.label).toBe("Disabled");
    else expect(standing.label).toBe(l.readiness.ready ? "Ready" : "Not ready");
    expect(lifecycleDigest(l)).not.toMatch(/undefined|null|NaN/);
  });

  it("never calls an effectively disabled or not-ready runtime ready", () => {
    const base = fixture<AssistantLifecycle>("lifecycle-ready.json");
    expect(agentStanding({ ...base, enablement: { config: true, operator: "disabled", effective: false } }, true)).toEqual({ label: "Disabled", tone: "warn" });
    expect(agentStanding({ ...base, readiness: { ...base.readiness, ready: false, reasons: ["sign-in missing"] } }, true)).toEqual({ label: "Not ready", tone: "danger" });
  });

  it("falls back to the config flag when the plane serves no lifecycle", () => {
    expect(agentStanding(undefined, true).label).toBe("Enabled");
    expect(agentStanding(undefined, false).label).toBe("Disabled");
  });

  it("digest keeps a stale or failed test apart from a pass", () => {
    const base = fixture<AssistantLifecycle>("lifecycle-ready.json");
    expect(lifecycleDigest({ ...base, conformance: { ...base.conformance, state: "stale" } })).toContain("test stale");
    expect(lifecycleDigest({ ...base, conformance: { ...base.conformance, state: "fail" } })).toContain("test failed");
    expect(lifecycleDigest({ ...base, conformance: { ...base.conformance, state: "not-run" } })).toContain("not tested");
  });

  it("tally counts the standings shown", () => {
    expect(agentTally(["Ready", "Ready", "Not ready", "Disabled"])).toBe("4 agents · 2 ready · 1 not ready · 1 disabled");
    expect(agentTally(["Ready"])).toBe("1 agent · 1 ready");
  });
});
