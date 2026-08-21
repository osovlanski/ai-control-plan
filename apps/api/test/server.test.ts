import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer } from "../src/server.js";

let home: string;
let db: Db;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-srv-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

function makeApp() {
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  return buildServer({ config, db });
}

describe("api server", () => {
  it("reports health with workspace and migration count", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.workspace).toBe("personal");
    expect(body.migrations).toBe(1);
    await app.close();
  });

  it("exposes workspace policy without any secrets", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/workspace" });
    const body = res.json();
    expect(body.failover.softThresholdPct).toBe(85);
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret/i);
    await app.close();
  });

  it("serves empty assistant and task lists on a fresh instance", async () => {
    const app = makeApp();
    expect((await app.inject({ method: "GET", url: "/api/assistants" })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json()).toEqual([]);
    await app.close();
  });
});
