/**
 * Phase 6 — Cockpit observability (execution-harness §11). The durable
 * drill-down (task -> sessions -> checkpoints -> handoffs -> verification ->
 * result -> guard/verification audit) must be renderable from persisted rows
 * alone; `sessionState` is primary, the legacy `state` vocabulary is still
 * served during the dual-field window (§5).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";

let home: string;
let db: Db;
let built: BuiltServer;
const TASK = "AG-obs-1";
const REQ = "erq_obs_1";
const SESSION = "es_obs_1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harness-obs-"));
  const config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  built.registry.init();

  db.prepare("INSERT INTO assistants (id, provider) VALUES ('a1','fake')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES (?, 'g', '{}', 't', 't')",
  ).run(TASK);
  db.prepare(
    `INSERT INTO execution_requests
       (id, task_id, attempt, assistant_id, model, routing_decision_ref, request_fingerprint,
        fingerprint_algorithm, prompt_source, prompt_source_ref, rendered_prompt_digest, policy,
        verification, origin, canonical_projection, created_at)
     VALUES (?, ?, 2, 'a1', '{"id":"m1"}', 'rd_9', 'fp_9', 'alg', 'fresh', NULL, 'd',
             '{"budget":{"enforcement":"advisory"}}', '[{"name":"unit","kind":"tests","required":true}]',
             '{"kind":"fresh"}', '{}', 't')`,
  ).run(REQ, TASK);
  db.prepare(
    `INSERT INTO runs
       (id, task_id, assistant_id, state, session_state, version, execution_request_id,
        provider_session_ref, provider_start_acked, cancel_requested, attempt, started_at, ended_at)
     VALUES (?, ?, 'a1', 'ENDED_OK', 'COMPLETED', 7, ?, 'psr_1', 1, 0, 2, 't0', 't9')`,
  ).run(SESSION, TASK, REQ);

  const result = {
    schemaVersion: 1,
    sessionId: SESSION,
    terminalState: "COMPLETED",
    outcome: "completed",
    artifacts: [],
    usage: { inputTokens: 10, outputTokens: 3, accounting: "delta" },
    checkpoint: { attempted: true, committed: true, checkpointId: "ck_1", gitRef: "deadbeef" },
    verification: {
      passed: false,
      checks: [{ name: "unit", kind: "tests", passed: false, required: true, summary: "exit 1" }],
    },
    enforcement: { tools: "audit", budget: "advisory", isolation: "partial" },
  };
  db.prepare(
    "INSERT INTO execution_results (session_id, terminal_state, outcome, result, at) VALUES (?, 'COMPLETED', 'completed', ?, 't9')",
  ).run(SESSION, JSON.stringify(result));

  db.prepare(
    `INSERT INTO checkpoints (id, task_id, run_id, session_id, envelope_snapshot, git_ref, reason, at)
     VALUES ('ck_1', ?, ?, ?, '{}', 'deadbeef', 'completion', 't8')`,
  ).run(TASK, SESSION, SESSION);
  db.prepare(
    `INSERT INTO handoff_envelopes
       (id, task_id, checkpoint_id, envelope, state, from_assistant_id, reason, source_session_id, created_at, updated_at)
     VALUES ('env_1', ?, 'ck_1', '{"schemaVersion":1}', 'ready', 'a1', 'yielded', ?, 't8', 't8')`,
  ).run(TASK, SESSION);
  db.prepare(
    `INSERT INTO approvals (id, session_id, provider_request_id, state, decision, answered_by, created_at, updated_at)
     VALUES ('apr_1', ?, 'prq_1', 'delivered', 'approved', 'user', 't5', 't6')`,
  ).run(SESSION);

  const ins = db.prepare(
    "INSERT INTO events (run_id, seq, ts, type, phase, summary, payload) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  );
  ins.run(SESSION, 1, "t2", "message", "hi", null); // not audit — must be filtered out
  ins.run(SESSION, 2, "t3", "guard.decision", "budget: checkpoint", JSON.stringify({ guard: "budget", directive: "checkpoint" }));
  ins.run(SESSION, 3, "t7", "checkpoint.created", "ck_1", JSON.stringify({ checkpointId: "ck_1" }));
  ins.run(SESSION, 4, "t8", "verification.result", "failed", JSON.stringify({ passed: false }));
});

afterEach(async () => {
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/tasks/:id/sessions", () => {
  it("lists session summaries with sessionState primary and the legacy state alongside", async () => {
    const res = await built.app.inject({ method: "GET", url: `/api/tasks/${TASK}/sessions` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        sessionId: SESSION,
        executionRequestId: REQ,
        assistantId: "a1",
        sessionState: "COMPLETED",
        state: "ENDED_OK",
        attempt: 2,
        providerStartAcked: true,
        cancelRequested: false,
        settlementOwner: null,
        startedAt: "t0",
        endedAt: "t9",
      },
    ]);
  });

  it("404s for an unknown task", async () => {
    expect((await built.app.inject({ method: "GET", url: "/api/tasks/nope/sessions" })).statusCode).toBe(404);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the full durable drill-down from persisted rows alone", async () => {
    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      sessionId: SESSION,
      taskId: TASK,
      executionRequestId: REQ,
      sessionState: "COMPLETED", // primary (§5)
      state: "ENDED_OK", // legacy vocabulary still served
      version: 7,
      providerSessionRef: "psr_1",
      providerStartAcked: true,
      cancelRequested: false,
    });

    expect(body.request).toMatchObject({
      routing_decision_ref: "rd_9",
      request_fingerprint: "fp_9",
      prompt_source: "fresh",
      superseded: false,
      model: { id: "m1" },
      policy: { budget: { enforcement: "advisory" } },
      origin: { kind: "fresh" },
    });

    expect(body.result.outcome).toBe("completed");
    expect(body.verification).toMatchObject({ passed: false });
    expect(body.enforcement).toEqual({ tools: "audit", budget: "advisory", isolation: "partial" });

    expect(body.checkpoints).toEqual([
      { id: "ck_1", reason: "completion", git_ref: "deadbeef", diff_stat: null, at: "t8" },
    ]);
    expect(body.handoffEnvelopes[0]).toMatchObject({ id: "env_1", state: "ready", checkpoint_id: "ck_1" });
    expect(body.approvals[0]).toMatchObject({ provider_request_id: "prq_1", state: "delivered", decision: "approved" });

    // Only the typed audit event types, parsed, in seq order.
    expect(body.audit.map((e: { type: string }) => e.type)).toEqual([
      "guard.decision",
      "checkpoint.created",
      "verification.result",
    ]);
    expect(body.audit[0].payload).toEqual({ guard: "budget", directive: "checkpoint" });
  });

  it("404s for an unknown session and for a legacy run that is not a Harness session", async () => {
    expect((await built.app.inject({ method: "GET", url: "/api/sessions/nope" })).statusCode).toBe(404);
    db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('legacy_1', ?, 'a1', 'ACTIVE', 't')",
    ).run(TASK);
    expect((await built.app.inject({ method: "GET", url: "/api/sessions/legacy_1" })).statusCode).toBe(404);
  });
});
