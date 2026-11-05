import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveAssetUsage, type AgentSpec, type AssetUsageEvent, type AssetUsageInput, type BundleManifest } from "../src/index.js";

// M6 S2 (plan §0 adapter table, §5 S2, Q5, Q6): invocation counts from tool events.

const deps = { sha256: (t: string) => createHash("sha256").update(t, "utf8").digest("hex") };
const D = (c: string) => `sha256:${c.repeat(64)}`;
const PROFILE = D("p");
const SKILL_MD = "/scratch/profiles/CR-t-1/plugin/skills/ts-review/SKILL.md";

type Mcp = AgentSpec["assets"]["mcp_servers"][number];
const mcp = (id: string, c: string): Mcp => ({ id, digest: D(c), allowlisted: true, tools_allowed: [], secret_refs: [] });

function spec(harness: string, mcpServers: Mcp[] = [mcp("mcp:db.server", "m")]): AgentSpec {
  return {
    schema_version: "1.1", composition_revision_id: "CR-t-1", task_id: "t",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness,
    model: { primary: { id: "opus" }, fallbacks: [] },
    registry: { snapshot_digest: D("s"), observed_at: "2030-01-01T00:00:00.000Z", stale: false },
    assets: { skills: [{ id: "claude-skills:ts-review", digest: D("a"), allowlisted: true }], mcp_servers: mcpServers, subagents: [] },
    context: { fragments: ["typescript-style"], memory_bundles: [{ id: "mem:notes", digest: D("n"), reason: "r" }], bundle_digest: D("b"), compiler: { name: "c", version: "1", tokens: 1, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: D("q") }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "b", worktree_id: "w" },
    provisioning: { requested: "isolated", achieved: "full", profile_digest: PROFILE },
    explanation_ref: "CD-t-1",
  } as AgentSpec;
}

const manifest: BundleManifest = {
  harness: "claude-code", bundleDigest: D("b"), compiler: { name: "c", version: "1" },
  included: [
    { kind: "skill", ref: "claude-skills:ts-review", digest: D("a"), reason: "r", relPath: ".claude/skills/ts-review/SKILL.md" },
    { kind: "fragment", ref: "typescript-style", digest: D("f"), reason: "r", relPath: "CLAUDE.md" },
    { kind: "memory_bundle", ref: "mem:notes", digest: D("n"), reason: "r", relPath: "CLAUDE.md" },
  ],
  excluded: [],
  tokens: { estimated: 1, tokenMethod: "estimated", charsPerToken: 4, budget: 10 },
};

const verified = (fidelity: "full" | "partial"): AssetUsageEvent => ({
  type: "provisioning.verified",
  payload: { compositionRevisionId: "CR-t-1", harness: fidelity === "full" ? "claude-code" : "codex", fidelity, profileDigest: PROFILE, files: [], visible: [], excluded: [], checks: [] },
});
const started: AssetUsageEvent = {
  type: "run.started",
  payload: { providerSessionRef: "s", profileEvidence: { ok: true, profileDigest: PROFILE, checks: [] } },
  raw: { mcp_servers: [{ name: "db_server", status: "connected" }] },
};
const call = (id: string, tool: string, input?: unknown): AssetUsageEvent => ({ type: "tool.started", payload: { toolUseId: id, tool, ...(input ? { input } : {}) } });
const done = (id: string, tool?: string): AssetUsageEvent => ({ type: "tool.completed", payload: { toolUseId: id, ...(tool ? { tool } : {}) } });
const fail = (id: string, tool?: string): AssetUsageEvent => ({ type: "tool.failed", payload: { toolUseId: id, ...(tool ? { tool } : {}) } });

function derive(tools: AssetUsageEvent[], over: { harness?: string; mcp?: Mcp[]; head?: AssetUsageEvent[] } = {}) {
  const input: AssetUsageInput = {
    spec: spec(over.harness ?? "claude-code", over.mcp), bundleManifest: manifest, sessionId: "run-1", taskId: "t",
    events: [...(over.head ?? [verified("full"), started]), ...tools],
    result: { outcome: "completed" }, resultAt: "2030-01-01T00:10:00.000Z", startAcked: true,
  };
  return deriveAssetUsage(input, deps).rows;
}
const inv = (rows: ReturnType<typeof derive>, kind: string, id?: string) => {
  const r = rows.find((x) => x.assetKind === kind && (id === undefined || x.assetId === id))!;
  return [r.invocationMethod, r.invocationCount, r.invocationFailed];
};

describe("asset invocation (S2)", () => {
  it("counts distinct toolUseIds across started/completed/failed; failed calls are inside the count and also separate (Q5)", () => {
    const rows = derive([
      call("u1", "mcp__db_server__query"), done("u1"),
      call("u2", "mcp__db_server__query"), fail("u2"),
      call("u3", "mcp__db_server__list"), // still running at settle: one call
      done("u1"), // a repeated completion is not a second call
      call("x1", "Bash"), done("x1"),
    ]);
    expect(inv(rows, "mcp_server")).toEqual(["tool_event", 3, 1]);
  });

  it("Codex reports MCP only at item.completed: completed-only and failed-only calls count", () => {
    const rows = derive([done("c1", "mcp:db_server.query"), fail("c2", "mcp:db_server.query"), done("c3", "mcp:other.query")], {
      harness: "codex", head: [verified("partial")],
    });
    expect(inv(rows, "mcp_server")).toEqual(["tool_event", 2, 1]);
    // bundle v1 gives Codex no skill files: the skill is not observable there
    expect(inv(rows, "skill")).toEqual(["not_observable", null, null]);
  });

  it("matches the profile's own server names, so an id containing `__` attributes correctly; the longer name wins a shared prefix", () => {
    const servers = [mcp("mcp:a", "1"), mcp("mcp:a__b", "2")];
    const rows = derive([
      call("u1", "mcp__a__b__search"), // server a__b, tool search (a first-separator split would say server a)
      call("u2", "mcp__a__search"),
      done("c1", "mcp:a__b.search"),
    ], { mcp: servers });
    expect(inv(rows, "mcp_server", "mcp:a__b")).toEqual(["tool_event", 2, 0]);
    expect(inv(rows, "mcp_server", "mcp:a")).toEqual(["tool_event", 1, 0]);
  });

  it("a call to a server the profile does not name is not counted", () => {
    const rows = derive([call("u1", "mcp__unknown__query"), call("u2", "mcp__db_server_x__query"), call("u3", "mcp__db__server__q")]);
    expect(inv(rows, "mcp_server")).toEqual(["tool_event", 0, 0]);
  });

  it("a Skill call naming the profile skill under the probed input key `skill` counts once per toolUseId (Q6)", () => {
    const rows = derive([
      call("s1", "Skill", { skill: "agent-plane-profile:ts-review" }), done("s1"),
      call("s2", "Skill", { skill: "ts-review" }), fail("s2"),
      call("s3", "Skill", { skill: "other-plugin:ts-review" }),
      call("s4", "Skill", { skill: "agent-plane-profile:other" }),
      call("s5", "Skill", { name: "agent-plane-profile:ts-review" }), // the probe saw no `name` key
    ]);
    expect(inv(rows, "skill")).toEqual(["tool_event", 2, 1]);
  });

  it("a Read of the profile's plugin/skills/<skill>/SKILL.md counts the skill; other Reads do not", () => {
    const rows = derive([
      call("r1", "Read", { file_path: SKILL_MD }), done("r1"),
      call("r2", "Read", { file_path: "/w/.claude/skills/ts-review/SKILL.md" }),
      call("r3", "Read", { file_path: "/scratch/profiles/CR-t-1/plugin/skills/ts-review-2/SKILL.md" }),
      call("r4", "Read", { file_path: "plugin/skills/ts-review/SKILL.md" }), // relative: no profile
      call("r5", "Write", { file_path: SKILL_MD }),
    ]);
    expect(inv(rows, "skill")).toEqual(["tool_event", 1, 0]);
  });

  it("a Skill call and a Read are two toolUseIds; no tool events is 0, not NULL", () => {
    expect(inv(derive([call("s1", "Skill", { skill: "agent-plane-profile:ts-review" }), call("r1", "Read", { file_path: SKILL_MD })]), "skill")).toEqual(["tool_event", 2, 0]);
    const idle = derive([]);
    expect(inv(idle, "skill")).toEqual(["tool_event", 0, 0]);
    expect(inv(idle, "mcp_server")).toEqual(["tool_event", 0, 0]);
  });

  it("instructions stay not_applicable", () => {
    const rows = derive([call("r1", "Read", { file_path: "/w/CLAUDE.md" })]);
    expect(inv(rows, "fragment")).toEqual(["not_applicable", null, null]);
    expect(inv(rows, "memory_bundle")).toEqual(["not_applicable", null, null]);
  });

  it.each([
    ["codex app-server (no profile)", "codex"],
    ["cursor (no profile)", "cursor"],
    ["ambient Claude (no profile)", "claude-code"],
  ])("%s: nothing attached, so skills and MCP stay not_observable even with matching tool events", (_label, harness) => {
    const rows = derive([
      done("c1", "mcp:db_server.query"),
      call("u1", "mcp__db_server__query"),
      call("s1", "Skill", { skill: "agent-plane-profile:ts-review" }),
    ], { harness, head: [{ type: "provisioning.ambient", payload: { compositionRevisionId: "CR-t-1", fidelity: "none", reason: "no lifecycle" } }] });
    expect(inv(rows, "skill")).toEqual(["not_observable", null, null]);
    expect(inv(rows, "mcp_server")).toEqual(["not_observable", null, null]);
    expect(inv(rows, "fragment")).toEqual(["not_applicable", null, null]);
  });

  it("a tool event with no toolUseId is not counted, and the derivation is byte-equal across event replays", () => {
    const tools = [{ type: "tool.started", payload: { tool: "mcp__db_server__query" } }, call("u1", "mcp__db_server__query")];
    const a = derive(tools);
    expect(inv(a, "mcp_server")).toEqual(["tool_event", 1, 0]);
    expect(JSON.stringify(derive(tools))).toBe(JSON.stringify(a));
    expect(a.every((r) => r.deriverVersion === 2)).toBe(true);
  });
});
