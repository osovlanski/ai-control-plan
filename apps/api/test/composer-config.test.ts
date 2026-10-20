/**
 * M2 Composer S3: the `composer` config section. Everything is off or empty by default;
 * a malformed section is a boot error that lists every problem, as `registry` does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "@agent-plane/adapters";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { Registry } from "../src/modules/registry.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "composer-config-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const load = (yaml?: string) => {
  if (yaml !== undefined) {
    const dir = join(home, "personal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), yaml);
  }
  return loadConfig({ AGENT_PLANE_HOME: home });
};
const d = (c: string) => `sha256:${c.repeat(64)}`;
const problems = (yaml: string): string[] => {
  try { load(yaml); } catch (error) { return (error as Error).message.split("\n").slice(1).map((l) => l.replace(/^\s*- /, "")); }
  throw new Error("expected the config to be rejected");
};

describe("composer config defaults", () => {
  it("is off, empty and fully resolved when the file says nothing", () => {
    expect(load().composer).toEqual({
      enabled: false,
      requireRevision: false,
      assets: { maxSkills: 3, allowlist: [] },
      context: {
        fragments: { default: [], byRepository: {} },
        memoryBundles: [],
        charsPerToken: { default: 3.5, byModel: {} },
        tokenBudget: 12000,
      },
      policy: { riskPermission: { high: "prompt-on-escalation" }, permitAmbient: false, permitPartial: false, budget: {} },
    });
  });

  it("is identical for an empty composer mapping and for one that only sets its own subsections empty", () => {
    const defaults = load().composer;
    rmSync(join(home, "personal"), { recursive: true });
    expect(load("composer: {}\n").composer).toEqual(defaults);
    expect(load("composer:\n  assets: {}\n  context: {}\n  policy: {}\n").composer).toEqual(defaults);
  });
});

describe("composer config values", () => {
  it("resolves a fully populated section", () => {
    const c = load(`composer:
  enabled: true
  requireRevision: true
  assets:
    maxSkills: 5
    allowlist:
      - { id: "claude-skills:ts-review", digest: "${d("a")}" }
      - { id: "claude-skills:ts-review", digest: "${d("b")}" }
  context:
    fragments:
      default: [house-style, "safety.base"]
      byRepository:
        repo-1: [monorepo-notes]
    memoryBundles:
      - { id: "mem:team", digest: "${d("c")}", reason: "pinned team notes" }
    charsPerToken:
      default: 4
      byModel: { "fake-1": 2.5 }
    tokenBudget: 8000
  policy:
    riskPermission: { low: auto-approve, high: read-only }
    permitAmbient: true
    budget: { maxTokens: 100000, maxCostUsd: 1.5, maxRuntimeMs: 600000 }
`).composer;
    expect(c).toMatchObject({
      enabled: true,
      requireRevision: true,
      assets: { maxSkills: 5, allowlist: [{ id: "claude-skills:ts-review", digest: d("a") }, { id: "claude-skills:ts-review", digest: d("b") }] },
      context: {
        fragments: { default: ["house-style", "safety.base"], byRepository: { "repo-1": ["monorepo-notes"] } },
        memoryBundles: [{ id: "mem:team", digest: d("c"), reason: "pinned team notes" }],
        charsPerToken: { default: 4, byModel: { "fake-1": 2.5 } },
        tokenBudget: 8000,
      },
      policy: { riskPermission: { low: "auto-approve", high: "read-only" }, permitAmbient: true, budget: { maxTokens: 100000, maxCostUsd: 1.5, maxRuntimeMs: 600000 } },
    });
  });

  it("overlays riskPermission on the default, so setting low keeps the high default", () => {
    expect(load("composer:\n  policy:\n    riskPermission: { low: read-only }\n").composer.policy.riskPermission).toEqual({ low: "read-only", high: "prompt-on-escalation" });
  });

  it("keeps per-repository and per-model maps to their own keys", () => {
    const c = load("composer:\n  context:\n    fragments:\n      byRepository:\n        toString: [a]\n    charsPerToken:\n      byModel:\n        constructor: 3\n").composer;
    expect(Object.keys(c.context.fragments.byRepository)).toEqual(["toString"]);
    expect(Object.keys(c.context.charsPerToken.byModel)).toEqual(["constructor"]);
    expect(Object.getPrototypeOf(c.context.charsPerToken.byModel)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("composer config validation", () => {
  it("rejects a non-mapping section and non-mapping subsections", () => {
    expect(problems("composer: yes\n")).toEqual(["composer must be a mapping"]);
    expect(problems("composer:\n  assets: [1]\n  context: 3\n  policy: nope\n")).toEqual([
      "composer.assets must be a mapping", "composer.context must be a mapping", "composer.policy must be a mapping",
    ]);
  });

  it("rejects unknown keys so a typo cannot silently fall back to a default", () => {
    expect(problems("composer:\n  enable: true\n  policy:\n    permitAmbiant: true\n    riskPermission: { critical: read-only }\n")).toEqual([
      "composer.enable is not a known key",
      "composer.policy.permitAmbiant is not a known key",
      "composer.policy.riskPermission.critical is not a known key",
    ]);
  });

  it("requires booleans for the switches", () => {
    expect(problems("composer:\n  enabled: 'yes'\n  requireRevision: 1\n  policy:\n    permitAmbient: 'true'\n")).toEqual([
      "composer.enabled must be a boolean", "composer.requireRevision must be a boolean", "composer.policy.permitAmbient must be a boolean",
    ]);
  });

  it("requires positive integers for counts and budgets", () => {
    for (const bad of ["0", "-1", "2.5", "'3'", "null"]) {
      expect(problems(`composer:\n  assets:\n    maxSkills: ${bad}\n  context:\n    tokenBudget: ${bad}\n  policy:\n    budget: { maxTokens: ${bad}, maxRuntimeMs: ${bad} }\n`)).toEqual([
        "composer.assets.maxSkills must be a positive integer",
        "composer.context.tokenBudget must be a positive integer",
        "composer.policy.budget.maxTokens must be a positive integer",
        "composer.policy.budget.maxRuntimeMs must be a positive integer",
      ]);
    }
  });

  it("requires a positive finite number for maxCostUsd", () => {
    for (const bad of ["0", "-0.5", "'1'", ".nan", ".inf"]) {
      expect(problems(`composer:\n  policy:\n    budget: { maxCostUsd: ${bad} }\n`)).toEqual(["composer.policy.budget.maxCostUsd must be a positive number"]);
    }
  });

  it("bounds charsPerToken to (0, 16]", () => {
    expect(load("composer:\n  context:\n    charsPerToken: { default: 16, byModel: { m: 0.1 } }\n").composer.context.charsPerToken).toEqual({ default: 16, byModel: { m: 0.1 } });
    for (const bad of ["0", "-3", "16.01", "'3.5'", ".nan", ".inf"]) {
      expect(problems(`composer:\n  context:\n    charsPerToken: { default: ${bad}, byModel: { m: ${bad} } }\n`)).toEqual([
        "composer.context.charsPerToken.default must be a number greater than 0 and at most 16",
        "composer.context.charsPerToken.byModel.m must be a number greater than 0 and at most 16",
      ]);
    }
  });

  it("requires sha256 digests and valid ids in the allowlist, and rejects duplicates", () => {
    expect(problems(`composer:
  assets:
    allowlist:
      - { id: "ok:one", digest: "sha256:ABC" }
      - { id: "", digest: "${d("a")}" }
      - { id: "ok:two" }
      - { id: "ok:three", digest: "${d("a")}", extra: 1 }
      - "ok:four"
      - { id: "dup", digest: "${d("e")}" }
      - { id: "dup", digest: "${d("e")}" }
`)).toEqual([
      'composer.assets.allowlist[0].digest must be sha256:<64 lowercase hex>, got "sha256:ABC"',
      'composer.assets.allowlist[1].id is not a valid id: ""',
      "composer.assets.allowlist[2].digest must be sha256:<64 lowercase hex>, got undefined",
      "composer.assets.allowlist[3].extra is not a known key",
      "composer.assets.allowlist[4] must be a mapping",
      `composer.assets.allowlist[6] duplicates dup at ${d("e")}`,
    ]);
  });

  it("requires fragment names and memory bundles to match the bundle contract", () => {
    expect(problems(`composer:
  context:
    fragments:
      default: [Bad-Name, ok, ok, 7]
      byRepository: { repo-1: nope }
    memoryBundles:
      - { id: "mem:x", digest: "${d("c")}", reason: "" }
      - { id: "-bad", digest: "nope", reason: "r" }
`)).toEqual([
      'composer.context.fragments.default[0] is not a valid name: "Bad-Name"',
      'composer.context.fragments.default[2] duplicates "ok"',
      "composer.context.fragments.default[3] is not a valid name: 7",
      "composer.context.fragments.byRepository.repo-1 must be a list of names",
      "composer.context.memoryBundles[0].reason must be a string of 1 to 512 characters",
      'composer.context.memoryBundles[1].id is not a valid id: "-bad"',
      'composer.context.memoryBundles[1].digest must be sha256:<64 lowercase hex>, got "nope"',
    ]);
  });

  it("limits lists to the contract's 64 entries", () => {
    const many = Array.from({ length: 65 }, (_, i) => `f${i}`).join(", ");
    expect(problems(`composer:\n  context:\n    fragments:\n      default: [${many}]\n`)).toEqual(["composer.context.fragments.default may list at most 64 entries"]);
  });

  it("rejects an approval mode the workspace does not know", () => {
    expect(problems("composer:\n  policy:\n    riskPermission: { high: auto, low: 3 }\n")).toEqual([
      "composer.policy.riskPermission.low must be one of auto-approve, prompt-on-escalation, read-only",
      "composer.policy.riskPermission.high must be one of auto-approve, prompt-on-escalation, read-only",
    ]);
  });

  it("reports every problem at once, with the config path", () => {
    try { load("composer:\n  enabled: 1\n  assets: { maxSkills: 0 }\n"); expect.unreachable(); } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(join(home, "personal", "config.yaml"));
      expect(message).toContain("composer.enabled must be a boolean");
      expect(message).toContain("composer.assets.maxSkills must be a positive integer");
    }
  });
});

describe("the test-only fake harness knob is not reachable from a real provider", () => {
  it("is honoured by a fake assistant and ignored by every real provider's adapter", () => {
    const config = load(`assistants:
  fake-codex: { provider: fake, options: { harness: codex } }
  fake-default: { provider: fake }
  real-claude: { provider: anthropic, options: { harness: codex } }
  real-codex: { provider: openai, options: { harness: cursor } }
  real-router: { provider: openrouter, options: { harness: cursor } }
  real-cursor: { provider: cursor, options: { harness: bedrock } }
  real-bedrock: { provider: bedrock, options: { harness: codex } }
`);
    const db = openDb(join(home, "t.db"));
    try {
      const registry = new Registry(db, config);
      registry.init();
      expect((registry.adapter("fake-codex") as FakeAdapter).harness).toBe("codex");
      expect((registry.adapter("fake-default") as FakeAdapter).harness).toBe("claude-code");
      for (const id of ["real-claude", "real-codex", "real-router", "real-cursor", "real-bedrock"]) {
        const adapter = registry.adapter(id);
        expect(adapter).not.toBeInstanceOf(FakeAdapter);
        expect("harness" in adapter).toBe(false);
      }
    } finally { db.close(); }
  });

  it("an unknown fake harness is a boot error, not a silent default", () => {
    const config = load("assistants:\n  fake-x: { provider: fake, options: { harness: gemini } }\n");
    const db = openDb(join(home, "t2.db"));
    try {
      expect(() => new Registry(db, config).init()).toThrow(/Unknown fake harness "gemini"/);
    } finally { db.close(); }
  });
});
