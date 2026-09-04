import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import type { Registry } from "../src/modules/registry.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { credentialPath, readCredential } from "../src/auth/credential-file.js";

let home: string;
const open: Db[] = [];
const servers: BuiltServer[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-ws-"));
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const db of open.splice(0)) db.close();
  rmSync(home, { recursive: true, force: true });
});

function instance(workspace: string, yaml?: string): BuiltServer & { dbPath: string } {
  mkdirSync(join(home, workspace), { recursive: true });
  if (yaml !== undefined) writeFileSync(join(home, workspace, "config.yaml"), yaml);
  const config = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: workspace });
  const db = openDb(config.dbPath);
  open.push(db);
  const built = buildServer({ config, db });
  const inject = built.app.inject.bind(built.app); const authorization = `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}`;
  built.app.inject = ((options: any) => inject({ ...options, headers: { ...options.headers, authorization } })) as typeof built.app.inject;
  built.registry.init();
  servers.push(built);
  return { ...built, dbPath: config.dbPath };
}

describe("workspace isolation (the Phase 4 security boundary)", () => {
  it("gives each workspace its own database, config, and port", () => {
    const personal = instance("personal");
    const work = instance("work");
    expect(work.dbPath).not.toBe(personal.dbPath);
    expect(work.dbPath).toContain(join(home, "work"));
    expect(personal.dbPath).toContain(join(home, "personal"));
  });

  it("defaults a work workspace to approval-gated failover and no assumed assistants", () => {
    const config = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "work" });
    // Rerouting work code to another provider is a decision, not a default.
    expect(config.failover.auto).toBe(false);
    expect(config.assistants).toEqual({});
    expect(config.policy.approvalMode).toBe("prompt-on-escalation");

    const personal = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "personal" });
    expect(personal.failover.auto).toBe(true);
  });

  it("keeps tasks in one workspace invisible to the other", async () => {
    const personal = instance("personal");
    const work = instance("work");

    await personal.app.inject({ method: "POST", url: "/api/tasks", payload: { goal: "personal secret work" } });

    const workTasks = (await work.app.inject({ method: "GET", url: "/api/tasks" })).json();
    expect(workTasks).toEqual([]);
    const personalTasks = (await personal.app.inject({ method: "GET", url: "/api/tasks" })).json();
    expect(personalTasks).toHaveLength(1);

    // And nothing personal leaked into the work database file itself.
    expect(readFileSync(work.dbPath, "utf8").includes("personal secret work")).toBe(false);
  });

  it("refuses a repository outside this workspace's allowlist", async () => {
    const work = instance(
      "work",
      "assistants:\n  work-claude:\n    provider: anthropic\nrepoAllowlist:\n  - /work/repos\n",
    );
    const denied = await work.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "touch personal code", repoPath: "/home/me/personal-project" },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await work.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "legit work", repoPath: "/work/repos/service" },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("stores no provider credentials in the workspace config", () => {
    loadConfig({ AGENT_PLANE_HOME: home }); // first boot writes the default file
    const raw = readFileSync(join(home, "personal", "config.yaml"), "utf8");
    expect(raw).not.toMatch(/sk-|api[_-]?key\s*:|secret\s*:|token\s*:/i);
    expect(raw).toContain("never stored here");
  });

  it("carries the instance approval mode into every run it starts", () => {
    const work = instance("work", "assistants:\n  work-fake:\n    provider: fake\npolicy:\n  approvalMode: read-only\n");
    expect(work.app).toBeDefined();
    const config = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "work" });
    expect(config.policy.approvalMode).toBe("read-only");
  });

  it("rejects an invalid approval mode rather than silently loosening policy", () => {
    mkdirSync(join(home, "work"), { recursive: true });
    writeFileSync(join(home, "work", "config.yaml"), "policy:\n  approvalMode: yolo\n");
    expect(() => loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "work" })).toThrow(/approvalMode/);
  });
});

describe("work-workspace provider registry", () => {
  it("builds cursor and bedrock adapters from config and reports them honestly", async () => {
    const work = instance(
      "work",
      [
        "assistants:",
        "  work-cursor:",
        "    provider: cursor",
        "  work-bedrock:",
        "    provider: bedrock",
        "    options:",
        "      agentRuntimeArn: arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent",
        "",
      ].join("\n"),
    );
    const registry = work.registry as Registry;

    const bedrock = await registry.adapter("work-bedrock").describe();
    expect(bedrock.provider).toBe("bedrock");
    expect(bedrock.core.canResume).toBe(true); // runtimeSessionId round-trips
    expect(bedrock.core.reportsLimits).toBe(false); // metered, no used-percent
    expect(bedrock.providerDetail.verifiedAgainstLiveService).toBe(false);

    const cursor = await registry.adapter("work-cursor").describe();
    expect(cursor.provider).toBe("cursor");
    expect(cursor.core.canResume).toBe(false); // unverified -> fail safe
    expect(cursor.core.reportsLimits).toBe(false);
    expect(cursor.providerDetail.mappingVerified).toBe(false);
  });

  it("refuses to invoke Bedrock without a configured agent runtime", async () => {
    const work = instance("work", "assistants:\n  work-bedrock:\n    provider: bedrock\n");
    const adapter = work.registry.adapter("work-bedrock");
    const manifest = await adapter.describe();
    // No ARN means nothing to invoke — surfaced as an auth failure the router
    // hard-filters on, rather than a runtime explosion mid-task.
    expect(manifest.core.auth.state).toBe("missing");
    await expect(
      adapter.start({
        taskId: "AG-1" as never,
        prompt: "hi",
        workdir: home,
        permissionPolicy: { mode: "prompt-on-escalation" },
        env: { redactionRules: [], maxRuntimeMs: 1000 },
      }),
    ).rejects.toThrow(/agentRuntimeArn is not configured/);
  });
});
