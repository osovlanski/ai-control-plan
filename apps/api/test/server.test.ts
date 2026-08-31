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
  it("publishes a versioned read-only integration contract", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      apiVersion: "1.1",
      eventVersion: "1.0",
      workspace: "personal",
      capabilities: [
        "tasks.read",
        "events.read",
        "events.stream",
        "routing.read",
        "sessions.read",
        "verification.read",
        "approvals.read",
      ],
    });
  });

  it("reports health with workspace and migration count", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.workspace).toBe("personal");
    expect(body.migrations).toBeGreaterThanOrEqual(1); // grows each phase; not a fact worth pinning
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

  it("reconciles a live Harness session on boot instead of blanket-failing it", async () => {
    makeApp();
    // A RUNNING task with two runs: one legacy, one a Harness execution session.
    db.prepare(
      "INSERT INTO tasks (id, goal, envelope, state, created_at, updated_at) VALUES ('AG-boot', 'g', ?, 'RUNNING', 't', 't')",
    ).run(JSON.stringify({ status: { state: "RUNNING" } }));
    db.prepare(
      "UPDATE assistants SET manifest = ? WHERE id = 'personal-claude'",
    ).run(
      JSON.stringify({
        assistantId: "personal-claude",
        provider: "anthropic",
        core: { models: [{ id: "m" }], canResume: true, canMcp: false, supportsMidRunInput: true, reportsUsage: true, reportsLimits: true, execution: { shell: true, filesystem: true, web: "no" }, auth: { state: "ok" } },
        providerDetail: {},
        evidence: { source: "runtime-probe", observedAt: "t" },
      }),
    );
    db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('legacy-run', 'AG-boot', 'personal-claude', 'ACTIVE', 't')",
    ).run();
    db.prepare(
      `INSERT INTO execution_requests
         (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint, fingerprint_algorithm,
          prompt_source, rendered_prompt_digest, policy, verification, origin, canonical_projection, created_at)
       VALUES ('erq-boot', 'AG-boot', 1, 'personal-claude', 'rd', 'fp', 'alg', 'fresh', 'd',
               '{"budget":{"enforcement":"advisory"}}', '[]', '{"kind":"fresh"}', '{}', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO runs
         (id, task_id, assistant_id, state, session_state, version, execution_request_id, provider_session_ref,
          provider_start_acked, cancel_requested, attempt, started_at)
       VALUES ('harness-sess', 'AG-boot', 'personal-claude', 'ACTIVE', 'RUNNING', 3, 'erq-boot', 'psr_x', 1, 0, 1, 't')`,
    ).run();

    const reconciled = await built.orchestrator.reconcileOnBoot();

    expect(reconciled).toBe(1); // the task itself
    // Legacy run: blanket-failed as before.
    expect((db.prepare("SELECT state FROM runs WHERE id = 'legacy-run'").get() as { state: string }).state).toBe(
      "ENDED_ERROR",
    );
    // Harness session: resume-offered by HarnessRecovery, NOT stomped, no premature result row.
    const sess = db.prepare("SELECT state, session_state FROM runs WHERE id = 'harness-sess'").get() as {
      state: string;
      session_state: string;
    };
    expect(sess.session_state).toBe("RUNNING");
    expect(sess.state).toBe("ACTIVE");
    expect(db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE session_id = 'harness-sess'").get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = 'harness-sess' AND type = 'recovery.decision'").get(),
    ).toEqual({ n: 2 }); // lease_taken_over + resume_offered
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
