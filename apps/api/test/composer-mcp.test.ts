/**
 * M3 S4 (plans/m3-provisioning.md §3): MCP servers and secrets, composed to launched. Stage 3 picks
 * an allowlisted stdio server whose secret env var is set; the revision attaches it with its secret
 * references by name; the run's profile launches it with the value resolved in memory at launch.
 * The FAKE value reaches no profile file, table, event or log (risk 10).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSpec, ExecutionResult } from "@agent-plane/core";
import { fileDigest } from "../src/bundle-contract.js";
import type { RegistryAsset } from "../src/registry-contract.js";
import type { PreviewResponse } from "../src/modules/composer/service.js";
import { bootRig, reaches, TS_REVIEW, type Rig } from "./helpers/composer-cockpit.js";

const REF = "AGENT_PLANE_S4_FAKE_TOKEN";
const SECRET = "FAKE-s4-mcp-token-not-real";
const GOAL = "Add a typed helper to the TypeScript parser module";
const MCP_ID = "mcp:example-mcp";
const LAUNCH: NonNullable<RegistryAsset["mcp"]> = { transport: "stdio", command: "example-mcp", args: ["--stdio"], env: { EXAMPLE_TOKEN: { type: "env", name: REF } } };
const MCP_DIGEST = fileDigest(JSON.stringify(LAUNCH));
const MCP: RegistryAsset = {
  id: MCP_ID, digest: MCP_DIGEST, kind: "mcp_server", nativeKind: "mcp", name: "example-mcp", description: "",
  tags: ["coding"], targets: ["claude"], compatibility: { assistants: ["claude", "codex"] },
  requirements: { secretRefs: [{ type: "env", name: REF }] }, conflicts: [], lineage: { origin: "unknown" }, enabled: true,
  installedAt: "2026-10-01T09:00:00.000Z", mcp: LAUNCH,
};

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
  delete process.env[REF];
});

const boot = (over: Parameters<typeof bootRig>[0] = {}) => bootRig({
  extraAssets: [MCP],
  ...over,
  configure: (c) => {
    c.composer.assets.allowlist = [...c.composer.assets.allowlist, { id: MCP_ID, digest: MCP_DIGEST }];
    over.configure?.(c);
  },
});

async function preview(taskId: string) {
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/compose`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json() as PreviewResponse;
}

async function start(taskId: string) {
  const done = reaches(rig!.built, taskId, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
  const res = await rig!.built.app.inject({ method: "POST", url: `/api/tasks/${taskId}/start`, headers: rig!.auth(), payload: {} });
  expect(res.statusCode).toBe(200);
  return done;
}

function session(taskId: string) {
  const run = rig!.db.prepare("SELECT id, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid LIMIT 1").get(taskId) as { id: string; composition_revision_id: string };
  const spec = JSON.parse((rig!.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ?").get(run.composition_revision_id) as { spec_json: string }).spec_json) as AgentSpec;
  const events = rig!.db.prepare("SELECT type, summary, payload FROM events WHERE run_id = ? ORDER BY seq").all(run.id) as Array<{ type: string; summary: string; payload: string | null }>;
  const result = JSON.parse((rig!.db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(run.id) as { result: string }).result) as ExecutionResult;
  return { spec, events, result };
}

/** Every row of every table, as text: the FAKE value must be in none of them. */
function databaseText(): string {
  const tables = rig!.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(rig!.db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
}

describe("an MCP server composed, provisioned and launched", () => {
  it("Claude Code (fake): attached by reference, the secret delivered at launch, and the value nowhere at rest", async () => {
    process.env[REF] = SECRET;
    rig = await boot();
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    const body = await preview(taskId);
    expect(body.outcome).toEqual({ status: "composed" });
    expect(body.specDraft!.assets.mcp_servers).toEqual([{ id: MCP_ID, digest: MCP_DIGEST, allowlisted: true, tools_allowed: [], secret_refs: [{ type: "env", name: REF }] }]);
    expect(body.specDraft!.assets.skills.map((s) => s.id)).toEqual([TS_REVIEW]);
    expect(body.decision.stages.find((s) => s.stage === "assets")!.chosen).toEqual([TS_REVIEW, MCP_ID]);

    expect(await start(taskId)).toBe("COMPLETED");
    const { spec, events, result } = session(taskId);
    expect(result.enforcement.provisioning).toEqual({ fidelity: "full", profileDigest: body.specDraft!.provisioning.profile_digest });
    expect(spec.provisioning.profile_digest).toBe(body.specDraft!.provisioning.profile_digest);
    const launched = events.find((e) => e.summary.startsWith("Fake launched with profile"))!;
    expect(JSON.parse(launched.payload!).mcp).toEqual({ servers: ["example-mcp"], secretsDelivered: ["EXAMPLE_TOKEN"] });
    const verified = JSON.parse(events.find((e) => e.type === "provisioning.verified")!.payload!) as { checks: Array<{ name: string; ok: boolean }>; visible: string[] };
    expect(verified.checks.find((c) => c.name === "mcp_secrets")).toMatchObject({ ok: true });
    expect(verified.visible).toContain("MCP secret values in the provider process environment, which every MCP server and tool the run starts inherits");

    expect(readdirSync(join(rig.config.dir, "profiles"))).toEqual([]);
    expect(databaseText()).not.toContain(SECRET);
    expect(databaseText()).toContain(REF); // the reference is recorded by name
  });

  it("Codex (fake) partial: the same server, its secret by env_vars name", async () => {
    process.env[REF] = SECRET;
    rig = await boot({ assistants: { "fake-codex": { provider: "fake", options: { harness: "codex" } } }, configure: (c) => { c.composer.policy.permitPartial = true; } });
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    expect(await start(taskId)).toBe("COMPLETED");
    const { spec, events } = session(taskId);
    expect(spec.assets.mcp_servers.map((m) => m.id)).toEqual([MCP_ID]);
    expect(JSON.parse(events.find((e) => e.summary.startsWith("Fake launched with profile"))!.payload!).mcp).toEqual({ servers: ["example-mcp"], secretsDelivered: ["EXAMPLE_TOKEN"] });
    expect(databaseText()).not.toContain(SECRET);
  });

  it("an unset secret env var keeps the server out of the revision, and says which name", async () => {
    rig = await boot();
    const body = await preview(rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId);
    expect(body.specDraft!.assets.mcp_servers).toEqual([]);
    const stage = body.decision.stages.find((s) => s.stage === "assets")!;
    expect(stage.filters.find((f) => f.filter === "missing_requirement")!.removed).toEqual([MCP_ID]);
    expect(stage.candidates.find((c) => c.ref === MCP_ID)!.evidence).toContain(`missing requirement: env ${REF} is unset`);
  });

  it("a secret gone between compose and launch fails the session before the provider starts, naming the reference", async () => {
    process.env[REF] = SECRET;
    rig = await boot();
    const taskId = rig.built.tasks.create({ goal: GOAL, repoPath: rig.repo }).taskId;
    expect((await preview(taskId)).specDraft!.assets.mcp_servers).toHaveLength(1);
    // The start recomposes: unset the value just after that, before the launch resolves it.
    const adapter = rig.built.registry.adapter("fake-claude");
    const realPrepare = adapter.prepare!.bind(adapter);
    adapter.prepare = async (input) => {
      if (input.sessionId !== "composer-predict") delete process.env[REF];
      return realPrepare(input);
    };
    expect(await start(taskId)).toBe("FAILED");
    const { events, result } = session(taskId);
    expect(result.failure).toMatchObject({ kind: "policy_unenforceable", retryable: false });
    expect(result.failure!.message).toContain(REF);
    expect(result.failure!.message).not.toContain(SECRET);
    expect(events.some((e) => e.type === "run.started")).toBe(false);
    expect(events.at(-1)!.type).toBe("provisioning.disposed");
    expect(databaseText()).not.toContain(SECRET);
  });
});
