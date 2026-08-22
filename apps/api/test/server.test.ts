import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";

let home: string;
let db: Db;
let built: BuiltServer;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-srv-"));
});

afterEach(async () => {
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function makeApp(): BuiltServer {
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();
  return built;
}

describe("api server", () => {
  it("reports health with workspace and migration count", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.workspace).toBe("personal");
    expect(body.migrations).toBe(1);
  });

  it("exposes workspace policy without any secrets", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/workspace" });
    const body = res.json();
    expect(body.failover.softThresholdPct).toBe(85);
    expect(body.assistants).toEqual(["personal-claude", "personal-codex"]);
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret/i);
  });

  it("seeds default assistants from config", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/assistants" });
    const body = res.json() as Array<{ id: string; provider: string; enabled: boolean }>;
    expect(body.map((a) => [a.id, a.provider, a.enabled])).toEqual([
      ["personal-claude", "anthropic", true],
      ["personal-codex", "openai", true],
    ]);
  });

  it("rejects task creation without a goal and outside the repo allowlist", async () => {
    const { app } = makeApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/tasks", payload: {} })).statusCode,
    ).toBe(400);
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "x", repoPath: "/not/allowed" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a task and serves it with envelope and empty runs", async () => {
    const { app } = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { goal: "Fix the auth bug", constraints: ["no breaking changes"] },
    });
    expect(created.statusCode).toBe(201);
    const envelope = created.json();
    expect(envelope.status.state).toBe("CREATED");
    expect(envelope.decisions[0]).toMatchObject({ text: "no breaking changes", madeBy: "user" });

    const res = await app.inject({ method: "GET", url: `/api/tasks/${envelope.taskId}` });
    const body = res.json();
    expect(body.state).toBe("CREATED");
    expect(body.runs).toEqual([]);
    expect(body.active).toBe(false);
  });
});
