import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  assetUsageEventId,
  deriveAssetUsage,
  type AgentSpec,
  type AssetUsageInput,
  type BundleManifest,
} from "../src/index.js";

const deps = { sha256: (t: string) => createHash("sha256").update(t, "utf8").digest("hex") };
const D = (c: string) => `sha256:${c.repeat(64)}`;
const PROFILE = D("p");

function spec(overrides: Partial<AgentSpec["assets"]> = {}, fragments = ["typescript-style"]): AgentSpec {
  return {
    schema_version: "1.1", composition_revision_id: "CR-t-1", task_id: "t",
    intent: { kind: "coding", domains: [], complexity: "S", risk: "normal" },
    harness: "claude-code",
    model: { primary: { id: "opus" }, fallbacks: [] },
    registry: { snapshot_digest: D("s"), observed_at: "2030-01-01T00:00:00.000Z", stale: false },
    assets: { skills: [{ id: "skill:ts-review", digest: D("a"), allowlisted: true }], mcp_servers: [{ id: "mcp:db.server", digest: D("m"), allowlisted: true, tools_allowed: [], secret_refs: [] }], subagents: [], ...overrides },
    context: { fragments, memory_bundles: [{ id: "mem:notes", digest: D("n"), reason: "r" }], bundle_digest: D("b"), compiler: { name: "c", version: "1", tokens: 1, token_method: "estimated", chars_per_token: 4 } },
    policy: { revision: { id: "p", digest: D("q") }, permission: "auto", tool_allowlist: [], budget: {} },
    workspace: { repository_id: "r", branch: "b", worktree_id: "w" },
    provisioning: { requested: "isolated", achieved: "full", profile_digest: PROFILE },
    explanation_ref: "CD-t-1",
  };
}

const manifest: BundleManifest = {
  harness: "claude-code", bundleDigest: D("b"), compiler: { name: "c", version: "1" },
  included: [
    { kind: "skill", ref: "skill:ts-review", digest: D("a"), reason: "r", relPath: ".claude/skills/ts-review/SKILL.md" },
    { kind: "fragment", ref: "typescript-style", digest: D("f"), reason: "r", relPath: "CLAUDE.md" },
    { kind: "memory_bundle", ref: "mem:notes", digest: D("n"), reason: "r", relPath: "CLAUDE.md" },
  ],
  excluded: [],
  tokens: { estimated: 1, tokenMethod: "estimated", charsPerToken: 4, budget: 10 },
};

const verified = (fidelity: "full" | "partial", checks: Array<{ name: string; ok: boolean; detail: string }> = []) => ({
  type: "provisioning.verified",
  payload: { compositionRevisionId: "CR-t-1", harness: fidelity === "full" ? "claude-code" : "codex", fidelity, profileDigest: PROFILE, files: [], visible: [], excluded: [], checks },
});
const started = (ok: boolean, mcp = "connected") => ({
  type: "run.started",
  payload: { providerSessionRef: "s", profileEvidence: { ok, profileDigest: PROFILE, checks: [{ name: "runtime_skills", ok, detail: "d" }] } },
  raw: { mcp_servers: [{ name: "db_server", status: mcp }] },
});

function input(over: Partial<AssetUsageInput> = {}): AssetUsageInput {
  return {
    spec: spec(), bundleManifest: manifest, sessionId: "run-1", taskId: "t",
    events: [verified("full"), started(true)],
    result: { outcome: "completed", verification: { passed: true, checks: [{ name: "test", kind: "tests", required: true, summary: "ok", status: "passed", passed: true }] } },
    resultAt: "2030-01-01T00:10:00.000Z", startAcked: true, ...over,
  };
}

const byKind = (rows: ReturnType<typeof deriveAssetUsage>["rows"]) => Object.fromEntries(rows.map((r) => [r.assetKind, r]));

describe("deriveAssetUsage", () => {
  it("Claude full + judge passed: skill runtime_confirmed, connected MCP confirmed, prompt instructions files_verified; invocation not observable", () => {
    const { rows, session } = deriveAssetUsage(input(), deps);
    expect(rows.map((r) => r.assetKind)).toEqual(["skill", "mcp_server", "memory_bundle", "fragment"]);
    const k = byKind(rows);
    expect(k.skill).toMatchObject({ attached: true, validation: "runtime_confirmed", fidelity: "full", sessionOutcome: "success", verificationPassed: true });
    expect(k.mcp_server!.validation).toBe("runtime_confirmed");
    expect(k.memory_bundle!.validation).toBe("files_verified");
    expect(k.fragment).toMatchObject({ assetDigest: D("f"), validation: "files_verified" });
    for (const r of rows) {
      expect(r).toMatchObject({ invocationMethod: "not_observable", invocationCount: null, invocationFailed: null, attributionMethod: "co-occurrence/v1", at: "2030-01-01T00:10:00.000Z" });
      expect(r.eventId).toBe(assetUsageEventId({ revision: "CR-t-1", session: "run-1", kind: r.assetKind, id: r.assetId, digest: r.assetDigest }, deps));
      expect(r.eventId).toMatch(/^au1_[0-9a-f]{64}$/);
    }
    expect(session).toMatchObject({ sessionId: "run-1", rows: 4, deriverVersion: 1 });
  });

  it("an MCP server Claude reported pending passes the judge but is only runtime_pending", () => {
    const k = byKind(deriveAssetUsage(input({ events: [verified("full"), started(true, "pending")] }), deps).rows);
    expect(k.mcp_server!.validation).toBe("runtime_pending");
  });

  it("judge failed: every attached asset is failed and the session is not_run", () => {
    const rows = deriveAssetUsage(input({
      events: [verified("full"), started(false)], startAcked: false,
      result: { outcome: "failed" },
    }), deps).rows;
    for (const r of rows) expect(r).toMatchObject({ attached: true, validation: "failed", sessionOutcome: "not_run", verificationPassed: null });
  });

  it("ambient: selected but attached 0 and validation none, fidelity none", () => {
    const rows = deriveAssetUsage(input({ events: [{ type: "provisioning.ambient", payload: { compositionRevisionId: "CR-t-1", fidelity: "none", reason: "r" } }, { type: "run.started", payload: {} }] }), deps).rows;
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ attached: false, validation: "none", fidelity: "none", sessionOutcome: "success" });
  });

  it("Codex partial: files_verified, or rendered for prompt instructions when the opt-in probe passed; a skill the bundle excluded is not attached", () => {
    const codexManifest = { ...manifest, included: manifest.included.filter((i) => i.kind !== "skill") };
    const plain = byKind(deriveAssetUsage(input({ bundleManifest: codexManifest, events: [verified("partial"), { type: "run.started", payload: {} }] }), deps).rows);
    expect(plain.skill).toMatchObject({ attached: false, validation: "none" });
    expect(plain.fragment!.validation).toBe("files_verified");
    expect(plain.mcp_server!.validation).toBe("files_verified");
    const probed = byKind(deriveAssetUsage(input({ bundleManifest: codexManifest, events: [verified("partial", [{ name: "prompt_input_exit", ok: true, detail: "" }, { name: "prompt_input_bundle", ok: true, detail: "" }])] }), deps).rows);
    expect(probed.fragment!.validation).toBe("rendered");
    expect(probed.memory_bundle!.validation).toBe("rendered");
    expect(probed.mcp_server!.validation).toBe("files_verified");
  });

  it("a cancelled session (e.g. released by POST /restart) and a context yield are neutral, not error", () => {
    expect(deriveAssetUsage(input({ result: { outcome: "cancelled" } }), deps).rows[0]!.sessionOutcome).toBe("neutral");
    expect(deriveAssetUsage(input({ result: { outcome: "yielded", yield: { kind: "context" } as never } }), deps).rows[0]!.sessionOutcome).toBe("neutral");
    expect(deriveAssetUsage(input({ result: { outcome: "failed" } }), deps).rows[0]!.sessionOutcome).toBe("error");
  });

  it("verification: NULL when none ran or every check was skipped", () => {
    expect(deriveAssetUsage(input({ result: { outcome: "completed" } }), deps).rows[0]!.verificationPassed).toBeNull();
    const skipped = { passed: true, checks: [{ name: "project:test", kind: "tests" as const, required: false, summary: "unchanged", status: "skipped" as const, passed: false as const }] };
    expect(deriveAssetUsage(input({ result: { outcome: "completed", verification: skipped } }), deps).rows[0]!.verificationPassed).toBeNull();
  });

  it("a zero-asset session still yields its ledger row", () => {
    const out = deriveAssetUsage(input({ spec: spec({ skills: [], mcp_servers: [] }, []), bundleManifest: { ...manifest, included: [] } }), deps);
    const noMem = deriveAssetUsage({ ...input(), spec: { ...spec({ skills: [], mcp_servers: [] }, []), context: { ...spec().context, fragments: [], memory_bundles: [] } } }, deps);
    expect(out.rows.map((r) => r.assetKind)).toEqual(["memory_bundle"]);
    expect(noMem.rows).toEqual([]);
    expect(noMem.session).toMatchObject({ rows: 0, sessionId: "run-1" });
  });

  it("a fragment the bundle excluded carries the excluded digest and is not attached", () => {
    const k = byKind(deriveAssetUsage(input({ bundleManifest: { ...manifest, included: manifest.included.filter((i) => i.kind !== "fragment") } }), deps).rows);
    expect(k.fragment).toMatchObject({ assetDigest: "excluded", attached: false, validation: "none" });
  });

  it("is byte-equal under different clocks, TZ and cwd", () => {
    const original = { tz: process.env.TZ, cwd: process.cwd() };
    const outs: string[] = [];
    try {
      for (const env of [{ now: 0, tz: "UTC", cwd: "/" }, { now: 4_102_444_800_000, tz: "Pacific/Kiritimati", cwd: tmpdir() }]) {
        vi.useFakeTimers({ now: env.now, toFake: ["Date"] });
        process.env.TZ = env.tz;
        process.chdir(env.cwd);
        outs.push(JSON.stringify(deriveAssetUsage(input(), deps)));
      }
    } finally {
      vi.useRealTimers();
      if (original.tz === undefined) delete process.env.TZ; else process.env.TZ = original.tz;
      process.chdir(original.cwd);
    }
    expect(outs[0]).toBe(outs[1]);
  });
});
