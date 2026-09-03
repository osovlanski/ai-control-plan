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
import type {
  AssistantId,
  CapabilityManifest,
  ExecutionRequest,
  RepositoryId,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "@agent-plane/core";
import { FakeAdapter } from "@agent-plane/adapters";
import { loadConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import { ApprovalService } from "../../src/modules/harness/approval-service.js";
import { EventRecorder } from "../../src/modules/harness/event-recorder.js";
import { SessionRunner } from "../../src/modules/harness/session-runner.js";
import { SessionStore } from "../../src/modules/harness/session-store.js";
import { VerificationStore } from "../../src/modules/harness/verification-store.js";

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
        verification, origin, canonical_projection, parent_task_id, group_id, created_at)
     VALUES (?, ?, 2, 'a1', '{"id":"m1"}', 'rd_9', 'fp_9', 'alg', 'fresh', NULL, 'd',
             '{"budget":{"enforcement":"advisory"}}', '[{"name":"unit","kind":"tests","required":true}]',
             '{"kind":"fresh"}', '{}', 'AG-parent', 'grp-7', 't')`,
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
        correlation: { parentTaskId: "AG-parent", groupId: "grp-7" },
        target: null,
        startedAt: "t0",
        endedAt: "t9",
      },
    ]);
  });

  it("navigates sessions by correlation group and by parent task", async () => {
    const byGroup = await built.app.inject({ method: "GET", url: "/api/sessions?groupId=grp-7" });
    expect(byGroup.statusCode).toBe(200);
    expect(byGroup.json().map((s: { sessionId: string }) => s.sessionId)).toEqual([SESSION]);

    const byParent = await built.app.inject({ method: "GET", url: "/api/sessions?parentTaskId=AG-parent" });
    expect(byParent.json().map((s: { sessionId: string }) => s.sessionId)).toEqual([SESSION]);

    expect((await built.app.inject({ method: "GET", url: "/api/sessions" })).statusCode).toBe(400);
    expect((await built.app.inject({ method: "GET", url: "/api/sessions?groupId=nope" })).json()).toEqual([]);
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

    expect(body.correlation).toEqual({ parentTaskId: "AG-parent", groupId: "grp-7" });

    expect(body.request).toMatchObject({
      routingDecisionRef: "rd_9",
      requestFingerprint: "fp_9",
      promptSource: "fresh",
      superseded: false,
      model: { id: "m1" },
      policy: { budget: { enforcement: "advisory" } },
      origin: { kind: "fresh" },
    });

    expect(body.result.outcome).toBe("completed");
    // verification + enforcement live inside `result`, not duplicated top-level.
    expect(body).not.toHaveProperty("verification");
    expect(body.result.verification).toMatchObject({ passed: false });
    expect(body.result.enforcement).toEqual({ tools: "audit", budget: "advisory", isolation: "partial" });

    expect(body.checkpoints).toEqual([
      { id: "ck_1", reason: "completion", gitRef: "deadbeef", diffStat: null, at: "t8" },
    ]);
    expect(body.handoffEnvelopes[0]).toMatchObject({ id: "env_1", state: "ready", checkpointId: "ck_1" });
    expect(body.approvals[0]).toMatchObject({ providerRequestId: "prq_1", state: "delivered", decision: "approved" });

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

  it("does not corrupt the whole drill-down when one durable JSON column is malformed", async () => {
    db.prepare("UPDATE execution_requests SET policy = '{bad json' WHERE id = ?").run(REQ);
    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request.policy).toBeNull(); // the bad column degrades to null...
    expect(body.result.outcome).toBe("completed"); // ...the rest of the read survives
  });

  it("degrades a syntactically-valid-but-wrong-shape result row to null (no client crash)", async () => {
    db.prepare("UPDATE execution_results SET result = '[]' WHERE session_id = ?").run(SESSION);
    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBeNull(); // not `[]` — a client won't read result.enforcement.tools off it
  });
});

describe("GET /api/sessions/:id/verification", () => {
  it("returns ordered durable lifecycle bindings and evidence without claim tokens", async () => {
    const verification = new VerificationStore(db);
    const first = {
      schemaVersion: 1 as const, planRevisionId: "vpr_obs_1", revision: 1,
      checks: [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }],
      decisions: [{ checkId: "unit", selected: true, required: true, signals: ["requested"], reason: "requested" }],
    };
    verification.insertRevision({ sessionId: SESSION, executionRequestId: REQ, plan: first, reason: "initial" });
    const second = { ...first, planRevisionId: "vpr_obs_2", revision: 2, supersedesRevisionId: first.planRevisionId,
      checks: [{ checkId: "lint", name: "lint", kind: "lint" as const, required: true }],
      decisions: [{ checkId: "lint", selected: true, required: true, signals: ["changed"], reason: "changed" }],
      debug: { claimToken: "nested-claim-canary", transcript: "nested-transcript-canary" } };
    verification.insertRevision({ sessionId: SESSION, executionRequestId: REQ, plan: second, reason: "post_change" });
    const binding = { runId: "vr_obs", sessionId: SESSION, executionRequestId: REQ, planRevisionId: second.planRevisionId };
    verification.prepareRun(binding);
    verification.claim({ ...binding, claimToken: "claim-canary-never-serve" });
    verification.complete({ ...binding, claimToken: "claim-canary-never-serve",
      evaluation: { passed: true, checks: [{ checkId: "lint", name: "lint", kind: "lint", required: true, status: "passed", passed: true, summary: "ok" }] },
      artifacts: [{ kind: "test_report", ref: "artifact://lint", summary: "lint output" }] });

    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}/verification` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(SESSION);
    expect(body.revisions.map((r: { id: string }) => r.id)).toEqual(["vpr_obs_1", "vpr_obs_2"]);
    expect(body.runs[0]).toMatchObject({ executionRequestId: REQ, planRevisionId: "vpr_obs_2", state: "completed", evaluation: { passed: true } });
    expect(body.runs[0].artifacts).toEqual([{ kind: "test_report", ref: "artifact://lint", summary: "lint output" }]);
    expect(res.payload).not.toContain("claim-canary-never-serve");
    expect(res.payload).not.toContain("nested-claim-canary");
    expect(res.payload).not.toContain("nested-transcript-canary");
    expect(res.payload).not.toContain("claimToken");
  });

  it("returns an empty lifecycle for a Harness session and 404 for unknown or legacy sessions", async () => {
    expect((await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}/verification` })).json()).toEqual({
      sessionId: SESSION, revisions: [], runs: [],
    });
    expect((await built.app.inject({ method: "GET", url: "/api/sessions/missing/verification" })).statusCode).toBe(404);
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('legacy_verify', ?, 'a1', 'RUNNING', 't')`,
    ).run(TASK);
    expect((await built.app.inject({ method: "GET", url: "/api/sessions/legacy_verify/verification" })).statusCode).toBe(404);
  });

  it("degrades a malformed lifecycle JSON field without failing the whole read", async () => {
    const verification = new VerificationStore(db);
    const plan = { schemaVersion: 1 as const, planRevisionId: "vpr_bad", revision: 1,
      checks: [{ checkId: "unit", name: "unit", kind: "tests" as const, required: true }],
      decisions: [{ checkId: "unit", selected: true, required: true, signals: [], reason: "requested" }] };
    verification.insertRevision({ sessionId: SESSION, executionRequestId: REQ, plan, reason: "initial" });
    const binding = { runId: "vr_bad", sessionId: SESSION, executionRequestId: REQ, planRevisionId: plan.planRevisionId };
    verification.prepareRun(binding); verification.claim({ ...binding, claimToken: "owner" });
    verification.complete({ ...binding, claimToken: "owner", evaluation: { passed: true, checks: [] }, artifacts: [] });
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE verification_runs SET evaluation = '{bad' WHERE id = 'vr_bad'").run();
    db.pragma("ignore_check_constraints = OFF");

    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${SESSION}/verification` });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs[0]).toMatchObject({ id: "vr_bad", evaluation: null, artifacts: [] });
  });
});

describe("drill-down over a REAL SessionRunner execution (shape + leak check)", () => {
  const MANIFEST: CapabilityManifest = {
    assistantId: "a1" as AssistantId,
    provider: "fake",
    core: {
      models: [{ id: "fake-1" }],
      canResume: true,
      canMcp: false,
      supportsMidRunInput: true,
      reportsUsage: true,
      reportsLimits: true,
      execution: { shell: true, filesystem: true, web: "no" },
      auth: { state: "ok" },
    },
    harness: { usageAccounting: "delta", toolGating: "none", approvalRelay: true, processIsolation: "none" },
    providerDetail: {},
    evidence: { source: "runtime-probe", observedAt: "t" },
  };
  const CANARY = "canary-must-not-appear-xyz";
  // Built at runtime so it is not a literal in the source (pre-write secret scan).
  const PLANTED = ["sk", "LIVEKEYshouldberedacted01"].join("-");

  it("serializes real rows and leaks neither the secret value nor credential tokens", async () => {
    db.prepare("INSERT INTO workspace_identities (singleton, id, created_at) VALUES (1, 'ws_obs', 't')").run();
    db.prepare("INSERT INTO repository_identities (id, workspace_id, canonical_git_dir, created_at) VALUES ('repo_obs', 'ws_obs', '/git/obs', 't')").run();
    db.prepare("INSERT INTO worktree_identities (id, repository_id, canonical_toplevel, created_at) VALUES ('wt_obs', 'repo_obs', '/wt/obs', 't')").run();
    const store = new SessionStore(db);
    const fake = new FakeAdapter("a1" as AssistantId, {
      ok: true,
      events: [
        { type: "message", summary: `planning ${PLANTED}`, payload: { text: "x" } },
        { type: "usage.updated", summary: "usage", payload: { inputTokens: 950, outputTokens: 10 } },
        { type: "message", summary: "done", payload: { text: "done" } },
      ],
    });
    const runner = new SessionRunner({
      store,
      recorder: new EventRecorder(db),
      approvals: new ApprovalService(db),
      checkpoints: { create: async () => ({ id: `ckpt_${Math.random().toString(36).slice(2)}`, gitRef: null }) },
      registry: { adapter: () => fake, manifest: () => MANIFEST },
      approvalPollMs: 5,
      secretResolver: () => CANARY,
    });

    const request: ExecutionRequest = {
      schemaVersion: 1,
      executionRequestId: "erq_real_1",
      taskId: TASK as TaskId,
      attempt: 1,
      assistantId: "a1" as AssistantId,
      routingDecisionRef: "rd_real",
      correlation: { parentTaskId: "AG-parent" as TaskId, groupId: "grp-real" },
      runSpec: {
        taskId: TASK as TaskId,
        prompt: "do it",
        workdir: home,
        permissionPolicy: { mode: "auto-approve" },
        env: { redactionRules: [], maxRuntimeMs: 60_000 },
      },
      policy: {
        budget: { enforcement: "advisory", maxTokens: 1000 },
        timeout: { hardMs: 60_000 },
        approval: { mode: "auto-approve" },
        tools: { mode: "audit" },
        checkpoint: { onSoftLimit: true },
        isolation: { required: "ambient" },
      },
      context: {
        target: {
          kind: "worktree",
          workspaceId: "ws_obs" as WorkspaceId,
          repositoryId: "repo_obs" as RepositoryId,
          worktreeId: "wt_obs" as WorktreeId,
        },
        secretRefs: ["PRIMARY_REF"],
      },
      verification: [],
      origin: { kind: "fresh" },
    };
    const result = await runner.run(request);
    expect(result.outcome).toBe("completed");

    const sid = store.forRequest("erq_real_1")!.sessionId as string;
    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${sid}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Real shape holds against real rows.
    expect(body.sessionState).toBe("COMPLETED");
    expect(body.correlation).toEqual({ parentTaskId: "AG-parent", groupId: "grp-real" });
    expect(body.request.target).toEqual({
      kind: "worktree",
      workspaceId: "ws_obs",
      repositoryId: "repo_obs",
      worktreeId: "wt_obs",
    });
    expect(body.request.requestFingerprint).toEqual(expect.any(String));
    expect(body.audit.map((e: { type: string }) => e.type)).toContain("guard.decision");
    const list = await built.app.inject({ method: "GET", url: `/api/tasks/${TASK}/sessions` });
    expect(list.json().find((session: { sessionId: string }) => session.sessionId === sid).target).toEqual(
      body.request.target,
    );

    // No secret value and no credential-shaped token anywhere in the drill-down.
    const raw = res.payload;
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
  });

  it("redacts a provider token that reached failure.message before it is served", async () => {
    const store = new SessionStore(db);
    const fake = new FakeAdapter("a1" as AssistantId, {
      ok: false,
      events: [{ type: "error", summary: `auth failed with ${PLANTED}`, payload: { kind: "auth_failed" } }],
    });
    const runner = new SessionRunner({
      store,
      recorder: new EventRecorder(db),
      approvals: new ApprovalService(db),
      checkpoints: { create: async () => ({ id: "ckR", gitRef: null }) },
      registry: { adapter: () => fake, manifest: () => MANIFEST },
      approvalPollMs: 5,
    });
    const result = await runner.run({
      schemaVersion: 1,
      executionRequestId: "erq_fail_1",
      taskId: TASK as TaskId,
      attempt: 1,
      assistantId: "a1" as AssistantId,
      routingDecisionRef: "rd",
      runSpec: {
        taskId: TASK as TaskId,
        prompt: "p",
        workdir: home,
        permissionPolicy: { mode: "auto-approve" },
        env: { redactionRules: [], maxRuntimeMs: 60_000 },
      },
      policy: {
        budget: { enforcement: "advisory" },
        timeout: { hardMs: 60_000 },
        approval: { mode: "auto-approve" },
        tools: { mode: "audit" },
        checkpoint: { onSoftLimit: true },
        isolation: { required: "ambient" },
      },
      context: {},
      verification: [],
      origin: { kind: "fresh" },
    });
    expect(result.outcome).toBe("failed");
    expect(result.failure?.message).not.toContain(PLANTED); // redacted in finalize()

    const sid = store.forRequest("erq_fail_1")!.sessionId as string;
    const res = await built.app.inject({ method: "GET", url: `/api/sessions/${sid}` });
    expect(res.payload).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(res.json().result.failure.message).toContain("[REDACTED]");
  });
});
