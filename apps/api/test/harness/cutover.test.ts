/**
 * Phase 8d — flag-ON single-mode cutover end to end (PLAN.md 8c/8d).
 *
 * A real `SessionRunner` wired through `buildServer` with
 * `execution.harnessModes.single: true`, driven by the in-process `FakeAdapter` +
 * in-repo SQLite. Asserts the Harness path reproduces the legacy task-level
 * outcomes, the SSE frame shape, the transactional envelope/quota derivation,
 * and the boot-recovery sweeps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../../src/config.js";
import { openDb, type Db } from "../../src/db/index.js";
import { buildServer, type BuiltServer } from "../../src/server.js";
import type { TaskStreamPayload } from "../../src/modules/sse.js";
import { credentialPath, readCredential } from "../../src/auth/credential-file.js";

let home: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

async function boot(extraConfig = ""): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-cutover-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  fake-a:\n    provider: fake\n  fake-b:\n    provider: fake\nexecution:\n  harnessModes:\n    single: true\n${extraConfig}`,
  );
  config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  built = buildServer({ config, db });
  const inject = built.app.inject.bind(built.app); const authorization = `Bearer ${readCredential(credentialPath(config.dir)).secrets[0]!.secret}`;
  built.app.inject = ((options: Record<string, unknown> = {}) => inject({ ...options, headers: { ...(options.headers as Record<string, string> | undefined), authorization } } as never)) as typeof built.app.inject;
  built.registry.init();
  await built.registry.syncAll();
}

beforeEach(() => boot());
afterEach(async () => {
  await built.orchestrator.shutdown();
  await built.app.close();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const startTask = async (goal: string, assistant: AssistantId = A) => {
  const env = built.tasks.create({ goal });
  built.tasks.transition(env.taskId, "ROUTING");
  const frames: TaskStreamPayload[] = [];
  built.bus.subscribe(env.taskId, (p) => frames.push(p));
  const { runId } = await built.orchestrator.startTask(env.taskId, assistant);
  return { taskId: env.taskId, runId, frames };
};

const harnessRuns = (taskId: string) =>
  db
    .prepare(
      "SELECT id, assistant_id, state, session_state, execution_request_id FROM runs WHERE task_id = ? ORDER BY started_at, rowid",
    )
    .all(taskId) as Array<{
    id: string;
    assistant_id: string;
    state: string;
    session_state: string | null;
    execution_request_id: string | null;
  }>;

describe("flag-ON cutover — happy path", () => {
  it("routes a task through SessionRunner to COMPLETED with one harness runs row", async () => {
    const { taskId, runId, frames } = await startTask("do the thing");
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");

    const runs = harnessRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ assistant_id: A, session_state: "COMPLETED", execution_request_id: `erq_${taskId}_1` });
    expect(runs[0]!.id).toBe(runId);

    // exactly one execution_results row, with a usage shape
    const results = db
      .prepare("SELECT result FROM execution_results WHERE session_id = ?")
      .all(runId) as Array<{ result: string }>;
    expect(results).toHaveLength(1);
    const parsed = JSON.parse(results[0]!.result) as { usage?: { accounting?: string } };
    expect(parsed.usage?.accounting).toBeTruthy();

    // provider_session_ref persisted (runner ackHandle, §9)
    const ref = db.prepare("SELECT provider_session_ref FROM runs WHERE id = ?").get(runId) as {
      provider_session_ref: string | null;
    };
    expect(ref.provider_session_ref).toBeTruthy();

    // SSE {kind:"event"} frames: contiguous strictly-increasing seq starting at
    // 1, and each frame matches the persisted durable event verbatim.
    const eventFrames = frames.filter((f) => f.kind === "event");
    const seqs = eventFrames.map((f) => f.event!.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const durable = db
      .prepare("SELECT seq, type, summary FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ seq: number; type: string; summary: string }>;
    expect(eventFrames.map((f) => ({ seq: f.event!.seq, type: f.event!.type, summary: f.event!.summary }))).toEqual(
      durable,
    );
    expect(eventFrames.every((f) => f.event!.runId === runId)).toBe(true);
    // no {kind:"event"} frame carries a key outside the NormalizedEvent shape
    const allowed = new Set(["runId", "ts", "type", "phase", "summary", "payload", "raw", "seq"]);
    expect(eventFrames.every((f) => Object.keys(f.event!).every((k) => allowed.has(k)))).toBe(true);

    // {kind:"state"} frames — emitted, every one carries a string `state`, and
    // the running assistant is carried on at least one. (Exact frame count /
    // ordering is not contracted: the recorder's deduped phase frames interleave
    // with the orchestrator's own publishState frames.)
    const stateFrames = frames.filter((f) => f.kind === "state");
    expect(stateFrames.length).toBeGreaterThan(0);
    expect(stateFrames.every((f) => typeof f.state!.state === "string")).toBe(true);
    expect(stateFrames.some((f) => f.state!.assistantId === A)).toBe(true);

    // flag-ON never writes runs.usage (Codex R2 #5) — usage rides on the result
    expect((db.prepare("SELECT usage FROM runs WHERE id = ?").get(runId) as { usage: string | null }).usage).toBeNull();

    // envelope enrichment landed transactionally
    const env = built.tasks.envelope(taskId);
    expect(env.artifacts.changedFiles).toContain("src/example.ts");
    expect(env.artifacts.testResults.length).toBeGreaterThan(0);

    // GET /api/tasks/:id serves the derived effective state + result usage for
    // the harness row, not the legacy shadow `state` / NULL `runs.usage`.
    const detail = await built.app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    const detailRun = (detail.json() as { runs: Array<{ id: string; state: string; usage: unknown }> }).runs.find(
      (r) => r.id === runId,
    )!;
    expect(detailRun.state).toBe("COMPLETED");
    expect(detailRun.usage).toMatchObject({ accounting: expect.any(String) });
  });
});

describe("flag-ON cutover — approvals", () => {
  // auto-approve (the workspace default) never raises approval.requested —
  // these tests are specifically about the relay path, so they need it.
  beforeEach(async () => {
    await built.orchestrator.shutdown();
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
  });

  it("relays an approval and completes when approved", async () => {
    const { taskId, frames } = await startTask("needs sign-off [FAKE:APPROVAL]");
    // wait for the approval.requested SSE frame
    const reqId = await pollFor(() => {
      const f = frames.find((x) => x.kind === "event" && x.event!.type === "approval.requested");
      return (f?.event!.payload as { requestId?: string } | undefined)?.requestId;
    });
    await built.orchestrator.respondApproval(taskId, reqId, true);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
  });

  it("a denied approval fails the task with no failover", async () => {
    const { taskId, frames } = await startTask("needs sign-off [FAKE:APPROVAL]");
    const reqId = await pollFor(() => {
      const f = frames.find((x) => x.kind === "event" && x.event!.type === "approval.requested");
      return (f?.event!.payload as { requestId?: string } | undefined)?.requestId;
    });
    await built.orchestrator.respondApproval(taskId, reqId, false);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("FAILED");
    expect(harnessRuns(taskId)).toHaveLength(1); // no second session
  });
});

describe("flag-ON cutover — cancel", () => {
  // auto-approve (the workspace default) never raises approval.requested —
  // this test is specifically about cancel-while-pending, so it needs it.
  beforeEach(async () => {
    await built.orchestrator.shutdown();
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
  });

  it("cancelTask mid-approval ends the task CANCELLED and settle no-ops", async () => {
    const { taskId, runId, frames } = await startTask("hold here [FAKE:APPROVAL]");
    await pollFor(() => {
      const f = frames.find((x) => x.kind === "event" && x.event!.type === "approval.requested");
      return (f?.event!.payload as { requestId?: string } | undefined)?.requestId;
    });
    await built.orchestrator.cancelTask(taskId);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("CANCELLED");
    const r = db.prepare("SELECT session_state FROM runs WHERE id = ?").get(runId) as { session_state: string };
    expect(r.session_state).toBe("CANCELLED");
    // the runner attempted a cancel checkpoint on the session
    expect(
      db.prepare("SELECT COUNT(*) c FROM checkpoints WHERE session_id = ? AND reason = 'cancel'").get(runId),
    ).toMatchObject({ c: 1 });
  });
});

describe("flag-ON cutover — failover", () => {
  it("[FAKE:LIMIT] fails over to a second session on assistant B and completes", async () => {
    const { taskId } = await startTask("big job [FAKE:LIMIT]", A);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("COMPLETED");
    const runs = harnessRuns(taskId);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.map((r) => r.assistant_id)).toContain(B);
    const handoff = db.prepare("SELECT trigger FROM handoffs WHERE task_id = ?").get(taskId) as { trigger: string };
    expect(handoff.trigger).toBe("quota");
    // fresh-prompt start this pass — no handoff_envelopes row
    expect(db.prepare("SELECT COUNT(*) c FROM handoff_envelopes WHERE task_id = ?").get(taskId)).toMatchObject({ c: 0 });
    // the limit.hit event carried a quota payload → a quota_snapshot landed
    // transactionally (afterInsertInTx), gated to the quota event types
    expect(
      (db.prepare("SELECT COUNT(*) c FROM quota_snapshots WHERE assistant_id = ?").get(A) as { c: number }).c,
    ).toBeGreaterThan(0);
  });

  it("[FAKE:FAIL] with failover.auto:false ends the task FAILED with one session", async () => {
    await built.orchestrator.shutdown();
    await built.app.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("failover:\n  auto: false\n");
    const { taskId } = await startTask("doomed [FAKE:FAIL]", A);
    expect(await built.orchestrator.waitForSettled(taskId)).toBe("FAILED");
    expect(harnessRuns(taskId)).toHaveLength(1);
  });
});

describe("flag-ON cutover — boot recovery", () => {
  it("settles a boot-stranded harness task from its durable result, not blanket-FAILED", async () => {
    // Seed a terminal harness session + result under a RUNNING task, plus a
    // legacy in-flight run on a different task — reconcileOnBoot settles the
    // first from the result and blanket-fails the second.
    seedTask("AG-strand");
    seedHarnessSession("AG-strand", "es_strand", "COMPLETED", true);
    built.tasks.transition("AG-strand", "ROUTING");
    built.tasks.transition("AG-strand", "RUNNING");

    seedTask("AG-legacy");
    db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('lr_1','AG-legacy','fake-a','ACTIVE','t0')",
    ).run();
    built.tasks.transition("AG-legacy", "ROUTING");
    built.tasks.transition("AG-legacy", "RUNNING");

    await built.orchestrator.reconcileOnBoot();
    expect(built.tasks.get("AG-strand")!.state).toBe("COMPLETED"); // from the durable result
    expect(built.tasks.get("AG-legacy")!.state).toBe("FAILED");
    // the legacy sweep closed its live runs row; the harness session row is untouched
    const legacyRun = db.prepare("SELECT state, ended_at FROM runs WHERE id = 'lr_1'").get() as {
      state: string;
      ended_at: string | null;
    };
    expect(legacyRun.state).toBe("ENDED_ERROR");
    expect(legacyRun.ended_at).not.toBeNull();
  });

  it("parks a harness-owned HANDING_OFF / ROUTING task with no result in WAITING_INPUT", async () => {
    // Session already terminal (so HarnessRecovery leaves it), but no
    // execution_results row → step 2 parks the task rather than blanket-fail.
    for (const [taskId, state] of [
      ["AG-ho", "HANDING_OFF"],
      ["AG-ro", "ROUTING"],
    ] as const) {
      seedTask(taskId);
      seedHarnessSession(taskId, `es_${taskId}`, "CANCELLED", false);
      built.tasks.transition(taskId, "ROUTING");
      if (state === "HANDING_OFF") {
        built.tasks.transition(taskId, "RUNNING");
        built.tasks.transition(taskId, "LIMIT_PAUSED");
        built.tasks.transition(taskId, "HANDING_OFF");
      }
    }
    const notices: Record<string, string[]> = { "AG-ho": [], "AG-ro": [] };
    for (const id of ["AG-ho", "AG-ro"]) {
      built.bus.subscribe(id, (p) => {
        if (p.kind === "notice") notices[id]!.push(p.notice!.text);
      });
    }
    await built.orchestrator.reconcileOnBoot();
    expect(built.tasks.get("AG-ho")!.state).toBe("WAITING_INPUT");
    expect(built.tasks.get("AG-ro")!.state).toBe("WAITING_INPUT");
    expect(notices["AG-ho"]!.some((t) => /manual restart required/.test(t))).toBe(true);
    expect(notices["AG-ro"]!.some((t) => /manual restart required/.test(t))).toBe(true);
  });

  it("parks the task WAITING_INPUT when SessionRunner.start rejects with no result", async () => {
    // A non-PREPARED session already exists for the erqId startTask will compute
    // (erq_<taskId>_1 — no execution_requests rows yet), with no
    // execution_results row → runner.start rejects → settleFromResult(null).
    const env = built.tasks.create({ goal: "will reject" });
    built.tasks.transition(env.taskId, "ROUTING");
    const erq = `erq_${env.taskId}_1`;
    // ended_at set so the isActive() live-session guard does not block startTask.
    db.prepare(
      `INSERT INTO runs (id, task_id, assistant_id, state, session_state, version, execution_request_id, provider_start_acked, cancel_requested, attempt, started_at, ended_at)
       VALUES (?, ?, 'fake-a', 'ACTIVE', 'RUNNING', 1, ?, 0, 0, 1, 't0', 't1')`,
    ).run("es_reject", env.taskId, erq);

    const notices: string[] = [];
    built.bus.subscribe(env.taskId, (p) => {
      if (p.kind === "notice") notices.push(p.notice!.text);
    });
    await built.orchestrator.startTask(env.taskId, A);
    await pollFor(() => (built.tasks.get(env.taskId)!.state === "WAITING_INPUT" ? true : undefined));
    // session row untouched (left for HarnessRecovery), no result fabricated, a
    // recovery-required notice went out.
    expect(
      (db.prepare("SELECT session_state, ended_at FROM runs WHERE id = 'es_reject'").get() as {
        session_state: string;
        ended_at: string;
      }),
    ).toEqual({ session_state: "RUNNING", ended_at: "t1" });
    expect(db.prepare("SELECT COUNT(*) c FROM execution_results WHERE session_id = 'es_reject'").get()).toMatchObject({
      c: 0,
    });
    expect(notices.some((t) => /recovery required/.test(t))).toBe(true);
  });
});

// --- helpers ---------------------------------------------------------------

function seedTask(id: string): void {
  db.prepare("INSERT INTO tasks (id, goal, envelope, created_at, updated_at) VALUES (?, 'g', ?, 't', 't')").run(
    id,
    JSON.stringify({
      taskId: id,
      goal: "g",
      constraints: [],
      status: { state: "CREATED" },
      completed: [],
      remaining: [],
      decisions: [],
      artifacts: { changedFiles: [], testResults: [] },
    }),
  );
}

function seedHarnessSession(
  taskId: string,
  sessionId: string,
  sessionState: string,
  withResult: boolean,
): void {
  const erq = `erq_${sessionId}`;
  db.prepare(
    `INSERT INTO execution_requests
       (id, task_id, attempt, assistant_id, routing_decision_ref, request_fingerprint, fingerprint_algorithm,
        prompt_source, rendered_prompt_digest, policy, verification, origin, canonical_projection, created_at)
     VALUES (?, ?, 1, 'fake-a', 'rd', 'fp', 'alg', 'fresh', 'd',
             '{"budget":{"enforcement":"advisory"}}', '[]', '{"kind":"fresh"}', '{}', 't')`,
  ).run(erq, taskId);
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "YIELDED"].includes(sessionState);
  const runState = sessionState === "COMPLETED" ? "ENDED_OK" : terminal ? "ENDED_ERROR" : "ACTIVE";
  const endedAt = terminal ? "t9" : null;
  db.prepare(
    `INSERT INTO runs (id, task_id, assistant_id, state, session_state, version, execution_request_id, provider_start_acked, cancel_requested, attempt, started_at, ended_at)
     VALUES (?, ?, 'fake-a', ?, ?, 1, ?, 1, 0, 1, 't0', ?)`,
  ).run(sessionId, taskId, runState, sessionState, erq, endedAt);
  if (withResult) {
    db.prepare(
      "INSERT INTO execution_results (session_id, terminal_state, outcome, result, at) VALUES (?, ?, ?, ?, 't9')",
    ).run(
      sessionId,
      sessionState,
      "completed",
      JSON.stringify({
        schemaVersion: 1,
        sessionId,
        terminalState: sessionState,
        outcome: "completed",
        artifacts: [],
        usage: { inputTokens: 5, outputTokens: 2, accounting: "delta" },
        checkpoint: { attempted: false, committed: false },
        enforcement: { tools: "audit", budget: "advisory", isolation: "ambient" },
      }),
    );
  }
}

async function pollFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("pollFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
