/**
 * M16 K17 — `decisions:` config resolution (plan
 * `plans/jev-decision-service-plan.md` §5, §9.2). Fail-closed default
 * `rules`, mirroring the existing `models` block's discipline.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = (overrides: Record<string, string> = {}) => ({ AGENT_PLANE_HOME: home, ...overrides });

describe("decisions config", () => {
  it("defaults to the rules provider, which makes no network call", () => {
    const config = loadConfig(env());
    expect(config.decisions).toEqual({ provider: "rules", sites: { "tool-gate": { mode: "shadow" } }, mcpTools: {} });
  });

  it("renders the decisions block in the first-boot default config", () => {
    loadConfig(env());
    const written = readFileSync(join(home, "personal", "config.yaml"), "utf8");
    expect(written).toContain("decisions:");
    expect(written).toContain("provider: rules");
  });

  it("carries typesafeApiKeyRef through as a bare reference name, never resolving it", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions:\n  provider: typesafe\n  typesafeApiKeyRef: TYPESAFE_API_KEY\n");
    const config = loadConfig(env({ TYPESAFE_API_KEY: "should-never-be-read" }));
    expect(config.decisions).toEqual({ provider: "typesafe", typesafeApiKeyRef: "TYPESAFE_API_KEY", sites: { "tool-gate": { mode: "shadow" } }, mcpTools: {} });
  });

  it("rejects an unknown provider", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions:\n  provider: vendor-x\n");
    expect(() => loadConfig(env())).toThrow(/decisions\.provider/);
  });

  it("rejects a blank typesafeApiKeyRef", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions:\n  typesafeApiKeyRef: ''\n");
    expect(() => loadConfig(env())).toThrow(/typesafeApiKeyRef/);
  });

  it("K19j: carries a declared MCP tool policy as own keys only, and nothing by default", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.yaml"),
      "decisions:\n  mcpTools:\n    plugin_claude-mem_mcp-search:\n      search: read-only\n      get_observations: read-only\n    notion:\n      create-pages: mutating\n",
    );
    const { mcpTools } = loadConfig(env()).decisions;
    expect(mcpTools).toEqual({
      "plugin_claude-mem_mcp-search": { search: "read-only", get_observations: "read-only" },
      notion: { "create-pages": "mutating" },
    });
    expect(Object.getPrototypeOf(mcpTools)).toBeNull();
    expect(Object.getPrototypeOf(mcpTools["notion"])).toBeNull();
  });

  it("K19j: a __proto__ key is an own declaration, not a re-parent", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions:\n  mcpTools:\n    __proto__:\n      x: read-only\n");
    const { mcpTools } = loadConfig(env()).decisions;
    expect(Object.getOwnPropertyNames(mcpTools)).toEqual(["__proto__"]);
    expect(Object.hasOwn(mcpTools, "constructor")).toBe(false);
  });

  it.each([
    ["an unknown access value", "decisions:\n  mcpTools:\n    s:\n      t: safe\n", /decisions\.mcpTools\.s\.t must be read-only \| mutating/],
    ["a list of tools", "decisions:\n  mcpTools:\n    s: [t]\n", /decisions\.mcpTools\.s must be a mapping/],
    ["a non-mapping block", "decisions:\n  mcpTools: all\n", /decisions\.mcpTools must be a mapping/],
  ])("K19j: rejects %s at load rather than guessing", (_what, yaml, error) => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), yaml);
    expect(() => loadConfig(env())).toThrow(error);
  });

  it("rejects a non-mapping decisions block", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions: nope\n");
    expect(() => loadConfig(env())).toThrow(/decisions must be a mapping/);
  });
});
