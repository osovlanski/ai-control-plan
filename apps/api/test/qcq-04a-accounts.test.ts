/**
 * qcq-04a: account identity and config (review packet 2.2, 2.12). Section 5 test 2: identity,
 * unset, enforcement refused. 04a ships `enforce: false` only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ACCOUNT_ENFORCEMENT_READY, DEFAULT_ACCOUNTS, accountKey, resolveAccounts } from "../src/modules/accounts.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "qcq-04a-accounts-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const load = (yaml: string) => {
  mkdirSync(join(home, "personal"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "personal", "config.yaml"), yaml);
  return loadConfig({ AGENT_PLANE_HOME: home });
};

const ASSISTANTS = `assistants:
  claude-code: { provider: anthropic }
  claude-code-opus: { provider: anthropic }
  codex: { provider: openai }
  codex-alias: { provider: openai }
`;
const GROUPS = `${ASSISTANTS}scheduling:
  accounts:
    groups:
      anthropic-personal:
        provider: anthropic
        limit: 2
        members:
          - { assistant: claude-code, runAs: plane }
          - { assistant: claude-code-opus, runAs: plane }
      anthropic-agent:
        provider: anthropic
        limit: 1
        members:
          - { assistant: claude-code, runAs: agent }
`;

describe("accountKey (packet 2.2)", () => {
  it("maps two assistant ids of one group to one key, and the agent-user lane to its own", () => {
    const cfg = load(GROUPS).accounts!;
    expect(cfg.enforce).toBe(false);
    expect(accountKey(cfg, "claude-code", "plane")).toEqual({ key: "account:anthropic-personal", source: "declared", limit: 2 });
    expect(accountKey(cfg, "claude-code-opus", "plane")).toEqual({ key: "account:anthropic-personal", source: "declared", limit: 2 });
    // The same assistant run as the agent user is another member, in another group.
    expect(accountKey(cfg, "claude-code", "agent")).toEqual({ key: "account:anthropic-agent", source: "declared", limit: 1 });
    // claude-code-opus as the agent user is not declared, and defaultLimit is null: no requirement.
    expect(accountKey(cfg, "claude-code-opus", "agent")).toEqual({ key: null, source: "none", limit: null });
  });

  it("gives each undeclared assistant its own fallback when defaultLimit is set, which cannot collide with a group or a pool", () => {
    const cfg = load(`${GROUPS}    defaultLimit: 1\nscheduler:\n  resources: { oci-heavy: 1 }\n`).accounts!;
    // Two aliases of one credential (codex and codex-alias, both env:<VAR>) are not discoverable:
    // undeclared, each is its own fallback account.
    const a = accountKey(cfg, "codex", "plane");
    const b = accountKey(cfg, "codex-alias", "plane");
    expect(a).toEqual({ key: "account:fallback:plane:codex", source: "fallback", limit: 1 });
    expect(b.key).toBe("account:fallback:plane:codex-alias");
    expect(accountKey(cfg, "codex", "agent").key).toBe("account:fallback:agent:codex");
    // `fallback` is not a group label and `account:` is not a pool name, so no key space overlaps.
    expect(() => load(`${ASSISTANTS}scheduling:\n  accounts:\n    groups:\n      fallback: { provider: openai, limit: 1, members: [{ assistant: codex, runAs: plane }] }\n`))
      .toThrow(/groups\.fallback: a group label is \[a-z0-9-\]\{1,40\} and not "fallback"/);
    expect(() => load(`${ASSISTANTS}scheduler:\n  resources: { "account:anthropic-personal": 1 }\n`))
      .toThrow(/scheduler\.resources\.account:anthropic-personal: the account: prefix is reserved/);
  });

  it("is unset by default: no account requirement for anyone", () => {
    const cfg = load(ASSISTANTS).accounts!;
    expect(cfg).toEqual(DEFAULT_ACCOUNTS);
    expect(accountKey(cfg, "claude-code", "plane")).toEqual({ key: null, source: "none", limit: null });
    // The advisory scheduling policy is unaffected by the accounts block.
    expect(load(GROUPS).scheduling).toEqual(load(ASSISTANTS).scheduling);
  });
});

describe("scheduling.accounts validation", () => {
  it("refuses enforce: true while ACCOUNT_ENFORCEMENT_READY is false", () => {
    expect(ACCOUNT_ENFORCEMENT_READY).toBe(false);
    expect(() => load(`${GROUPS}    enforce: true\n`)).toThrow(/account enforcement is not available in this build/);
    // The test seam: once ready, enforcement still needs a scheduler.
    expect(() => resolveAccounts({ enforce: true }, { assistants: {}, pools: [], schedulerEnabled: false, ready: true }, "c"))
      .toThrow(/enforce: true requires scheduler\.enabled: true/);
    expect(resolveAccounts({ enforce: true }, { assistants: {}, pools: [], schedulerEnabled: true, ready: true }, "c").enforce).toBe(true);
  });

  it("rejects a pair in two groups, a provider mismatch, an unknown assistant, a bad label and unknown keys", () => {
    const bad = (groups: string) => () => load(`${ASSISTANTS}scheduling:\n  accounts:\n    groups:\n${groups}`);
    expect(bad("      a: { provider: anthropic, limit: 1, members: [{ assistant: claude-code, runAs: plane }] }\n      b: { provider: anthropic, limit: 1, members: [{ assistant: claude-code, runAs: plane }] }\n"))
      .toThrow(/claude-code\/plane is already a member of group a/);
    expect(bad("      a: { provider: openai, limit: 1, members: [{ assistant: claude-code, runAs: plane }] }\n"))
      .toThrow(/assistant claude-code is provider anthropic, not the group's openai/);
    expect(bad("      a: { provider: anthropic, limit: 1, members: [{ assistant: ghost, runAs: plane }] }\n"))
      .toThrow(/assistant ghost is not configured/);
    expect(bad("      Bad_Label: { provider: anthropic, limit: 1, members: [{ assistant: claude-code, runAs: plane }] }\n"))
      .toThrow(/a group label is/);
    expect(bad("      a: { provider: anthropic, limit: 0, members: [{ assistant: claude-code, runAs: root }] }\n"))
      .toThrow(/limit must be a positive integer[\s\S]*runAs must be plane or agent/);
    expect(() => load(`${ASSISTANTS}scheduling:\n  accounts:\n    limits: 1\n    defaultLimit: -1\n`))
      .toThrow(/unknown key\(s\): limits[\s\S]*defaultLimit must be a positive integer or null/);
  });
});
