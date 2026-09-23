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
    expect(config.decisions).toEqual({ provider: "rules", sites: { "tool-gate": { mode: "shadow" } } });
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
    expect(config.decisions).toEqual({ provider: "typesafe", typesafeApiKeyRef: "TYPESAFE_API_KEY", sites: { "tool-gate": { mode: "shadow" } } });
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

  it("rejects a non-mapping decisions block", () => {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "decisions: nope\n");
    expect(() => loadConfig(env())).toThrow(/decisions must be a mapping/);
  });
});
