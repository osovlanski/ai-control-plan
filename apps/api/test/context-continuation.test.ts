/**
 * M14 K11 — bounded checkpoint-backed clean-session continuation, end to end
 * (kernel-services §4.3.3, §5.2 items 5–10).
 *
 * Everything here runs over the FakeAdapter with `[FAKE:CONTEXT:…]` scripting and
 * a real git worktree — the checkpoint's committed ref is part of the contract,
 * so a fake checkpoint service would test nothing. No wall-clock sleeps: the
 * scheduler clock is injected and every wait is event-driven.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantId, ContextYieldRequest, ExecutionResult } from "@agent-plane/core";
import { DEFAULT_CONTEXT_POLICY, isReliabilityFailure } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { buildServer, type BuiltServer } from "../src/server.js";
import { Scheduler, type SchedulerDeps } from "../src/modules/scheduler.js";
import { continuationProvenance, decideContextContinuation } from "../src/modules/context-continuation.js";
import { readTaskContext } from "../src/modules/context.js";

let home: string;
let repo: string;
let db: Db;
let config: ResolvedConfig;
let built: BuiltServer;
let instant = Date.parse("2030-01-01T00:00:00Z");
const now = () => new Date(instant);
const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "k11-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "k11@agent-plane.test");
  git("config", "user.name", "K11 Test");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-qm", "initial");
  return dir;
}

async function boot() {
  home = mkdtempSync(join(tmpdir(), "k11-"));
  repo = makeRepo();
  config = loadConfig({ AGENT_PLANE_HOME: home });
  config.assistants = { [A]: { provider: "fake" }, [B]: { provider: "fake" } };
  config.execution.harnessModes.single = true;
  config.repoAllowlist = [...config.repoAllowlist, repo];
  db = openDb(config.dbPath);
  built = buildServer({ config, db, now });
  built.registry.init();
  await built.registry.syncAll();
}

function scheduler(boundary?: SchedulerDeps["boundary"]) {
  return new Scheduler({
    db,
    config,
    tasks: built.tasks,
    orchestrator: built.orchestrator,
    bus: built.bus,
    now,
    boundary,
  });
}

/**
 * A repo-backed task whose goal scripts the fake provider's context pressure.
 * `fresh` applies to a first session, `continued` to any session started from a
 * continuation prompt.
 */
function contextTask(s: Scheduler, fresh: number | string, continued?: number | string, pin: AssistantId = A) {
  const marker = continued === undefined ? `${fresh}` : `${fresh}>${continued}`;
  const t = built.tasks.create({
    goal: `implement the change [FAKE:CONTEXT:${marker}]`,
    repoPath: repo,
    overrides: { assistantId: pin },
  });
  s.attach(t.taskId, { kind: "time", notBefore: new Date(instant + 1000).toISOString() });
  return t.taskId;
}

/** Resolves when the task reaches one of the given states. */
function reaches(id: string, states: string[]): Promise<string> {
  return new Promise((resolve) => {
    const current = built.tasks.get(id)?.state;
    if (current && states.includes(current)) return resolve(current);
    const off = built.bus.subscribe(id, (p) => {
      if (p.kind === "state" && states.includes(p.state!.state)) {
        off();
        resolve(p.state!.state);
      }
    });
  });
}

const settled = (id: string) => reaches(id, ["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);

function sessions(taskId: string) {
  return db
    .prepare("SELECT id, assistant_id, session_state FROM runs WHERE task_id = ? ORDER BY started_at, rowid")
    .all(taskId) as Array<{ id: string; assistant_id: string; session_state: string }>;
}

function resultOf(sessionId: string): ExecutionResult {
  const row = db.prepare("SELECT result FROM execution_results WHERE session_id = ?").get(sessionId) as {
    result: string;
  };
  return JSON.parse(row.result) as ExecutionResult;
}

function contextDispatches(taskId: string) {
  return db
    .prepare("SELECT * FROM dispatches WHERE task_id = ? AND origin = 'context-yield' ORDER BY created_at, rowid")
    .all(taskId) as Array<{ dispatch_id: string; checkpoint_id: string | null; session_id: string | null; phase: string }>;
}

/**
 * A synthetic `reason = 'context'` checkpoint cloned from an existing anchor,
 * with its committed continuation envelope. `mutate` edits the durable evidence
 * a successor reads (`completed` / `remaining`); leave it out for a checkpoint
 * that restates the anchor verbatim — the definition of no progress.
 */
function synthCheckpoint(
  taskId: string,
  anchorCheckpointId: string,
  id: string,
  mutate?: (envelope: { completed?: string[]; remaining?: string[] }) => void,
): string {
  const anchor = db
    .prepare("SELECT run_id, session_id, envelope_snapshot FROM checkpoints WHERE id = ?")
    .get(anchorCheckpointId) as { run_id: string; session_id: string | null; envelope_snapshot: string };
  const snap = JSON.parse(anchor.envelope_snapshot) as { completed?: string[]; remaining?: string[] };
  mutate?.(snap);
  instant += 1000;
  db.prepare(
    `INSERT INTO checkpoints(id,task_id,run_id,session_id,envelope_snapshot,git_ref,reason,at)
     VALUES(?,?,?,?,?,'deadbeef','context',?)`,
  ).run(id, taskId, anchor.run_id, anchor.session_id, JSON.stringify(snap), now().toISOString());

  const template = db
    .prepare("SELECT * FROM handoff_envelopes WHERE checkpoint_id = ? ORDER BY created_at LIMIT 1")
    .get(anchorCheckpointId) as {
    envelope: string;
    from_assistant_id: string;
    reason: string;
    source_session_id: string | null;
  };
  const envelope = { ...(JSON.parse(template.envelope) as Record<string, unknown>), checkpointId: id };
  db.prepare(
    `INSERT INTO handoff_envelopes(id,task_id,checkpoint_id,envelope,state,from_assistant_id,reason,source_session_id,created_at,updated_at)
     VALUES(?,?,?,?,'ready',?,?,?,?,?)`,
  ).run(
    `ho_${id}`, taskId, id, JSON.stringify(envelope), template.from_assistant_id, template.reason,
    template.source_session_id, now().toISOString(), now().toISOString(),
  );
  return id;
}

/**
 * A durable `origin = 'context-yield'` dispatch anchored to `checkpointId` — the
 * only proof that a continuation ACTUALLY happened. Any phase counts: a
 * reparked or aborted continuation still consumed an attempt.
 */
function synthContinuationDispatch(taskId: string, checkpointId: string, phase = "started"): string {
  const generation =
    ((db.prepare("SELECT MAX(generation) AS g FROM wait_conditions WHERE task_id = ?").get(taskId) as {
      g: number | null;
    }).g ?? 0) + 1;
  db.prepare(
    `INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,reason,checkpoint_id,origin)
     VALUES(?,?,'consumed','time',?,'context-yield',?,'synthetic prior continuation',?,'context-yield')`,
  ).run(taskId, generation, now().toISOString(), now().toISOString(), checkpointId);
  const dispatchId = `d_${checkpointId}_${generation}`;
  db.prepare(
    `INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,checkpoint_id,execution_path,phase,created_at,updated_at)
     VALUES(?,?,?,'context-yield',?,'harness',?,?,?)`,
  ).run(dispatchId, taskId, generation, checkpointId, phase, now().toISOString(), now().toISOString());
  return dispatchId;
}

/** The gate's view of one candidate checkpoint, reusing a settled yield's detail. */
function candidate(detail: ContextYieldRequest, result: ExecutionResult, checkpointId: string) {
  return {
    detail: { ...detail, checkpointId },
    result: {
      ...result,
      checkpoint: { ...result.checkpoint, checkpointId, committed: true, gitRef: "deadbeef" },
    } as ExecutionResult,
  };
}

function eventTypes(sessionId: string): string[] {
  return (
    db.prepare("SELECT type FROM events WHERE run_id = ? ORDER BY seq").all(sessionId) as Array<{ type: string }>
  ).map((r) => r.type);
}

afterEach(async () => {
  vi.useRealTimers();
  if (built) {
    await built.orchestrator.shutdown();
    await built.app.close();
  }
  if (db?.open) db.close();
  for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("K11 — the yield decision", () => {
  it("below critical: the session completes and never yields on context", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.5);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(built.tasks.get(id)?.state).toBe("COMPLETED");
    const [only] = sessions(id);
    expect(sessions(id)).toHaveLength(1);
    expect(resultOf(only!.id).outcome).toBe("completed");
    expect(eventTypes(only!.id)).toContain("context.observed");
    expect(eventTypes(only!.id)).not.toContain("context.yield");
    expect(contextDispatches(id)).toHaveLength(0);
  });

  it("unavailable occupancy never yields, whatever the accounting says", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, "unavailable");
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(built.tasks.get(id)?.state).toBe("COMPLETED");
    expect(eventTypes(sessions(id)[0]!.id)).not.toContain("context.observed");
    expect(contextDispatches(id)).toHaveLength(0);
  });

  it("occupancy without an effective window never yields", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, "nowindow");
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(built.tasks.get(id)?.state).toBe("COMPLETED");
    expect(eventTypes(sessions(id)[0]!.id)).not.toContain("context.yield");
  });
});

describe("K11 — settled predecessor, then one successor", () => {
  it("checkpoints, settles YIELDED(context), and continues from that exact checkpoint", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(built.tasks.get(id)?.state).toBe("COMPLETED");
    const all = sessions(id);
    expect(all).toHaveLength(2);

    // 1. the predecessor is terminal YIELDED(context) with its result persisted
    const predecessor = resultOf(all[0]!.id);
    expect(all[0]!.session_state).toBe("YIELDED");
    expect(predecessor.outcome).toBe("yielded");
    expect(predecessor.yield?.kind).toBe("context");
    const detail = predecessor.yield!.detail as ContextYieldRequest;
    expect(detail.reason).toBe("critical_context_pressure");
    expect(detail.observation.pressure).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_POLICY.criticalRatio);
    expect(detail.observation.freshness).toBe("live");
    expect(predecessor.checkpoint.committed).toBe(true);
    expect(predecessor.checkpoint.gitRef).toBeTruthy();
    expect(eventTypes(all[0]!.id)).toContain("context.yield");

    // 2. exactly one context-yield dispatch, anchored to that checkpoint
    const dispatched = contextDispatches(id);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.checkpoint_id).toBe(detail.checkpointId);
    expect(dispatched[0]!.session_id).toBe(all[1]!.id);

    // 3. the successor consumed the committed continuation envelope for it
    const request = db
      .prepare("SELECT origin, prompt_source, prompt_source_ref FROM execution_requests WHERE id = ?")
      .get(dispatched[0]!.dispatch_id) as { origin: string; prompt_source: string; prompt_source_ref: string };
    expect(JSON.parse(request.origin)).toMatchObject({ kind: "handoff", envelopeId: detail.envelopeId });
    expect(request.prompt_source).toBe("handoff");
    expect(request.prompt_source_ref).toBe(detail.envelopeId);

    // 4. the successor completed and the task with it
    expect(resultOf(all[1]!.id).outcome).toBe("completed");
  });

  it("prefers the same assistant and records the routing provenance", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const all = sessions(id);
    expect(all[1]!.assistant_id).toBe(all[0]!.assistant_id);

    const dispatch = contextDispatches(id)[0]!;
    const decision = db
      .prepare("SELECT explanation FROM routing_decisions WHERE id = (SELECT routing_decision_id FROM dispatches WHERE dispatch_id = ?)")
      .get(dispatch.dispatch_id) as { explanation: string };
    const explanation = JSON.parse(decision.explanation) as Record<string, unknown> & {
      contextContinuation?: Record<string, unknown>;
    };
    expect(explanation.origin).toBe("context-yield");
    expect(explanation.continuation).toMatchObject({ kind: "checkpoint", checkpointId: dispatch.checkpoint_id });
    expect(explanation.contextContinuation).toMatchObject({
      continuationNumber: 1,
      maxContinuationsPerTask: DEFAULT_CONTEXT_POLICY.maxContinuationsPerTask,
      checkpointId: dispatch.checkpoint_id,
      predecessorSessionId: all[0]!.id,
      previousAssistantId: all[0]!.assistant_id,
      preferSameSatisfied: true,
    });
    expect(explanation.contextContinuation!.criticalPressure).toBeGreaterThanOrEqual(
      DEFAULT_CONTEXT_POLICY.criticalRatio,
    );
  });

  it("a healthy context yield is not a reliability failure and costs no cooldown", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const predecessor = resultOf(sessions(id)[0]!.id);
    expect(isReliabilityFailure(predecessor)).toBe(false);
    // …unlike every other yield kind, which still says something about the route.
    expect(isReliabilityFailure({ outcome: "yielded", yield: { kind: "limit", detail: {} as never } })).toBe(true);

    expect(built.cooldowns.active().has(A)).toBe(false);
    const score = built.telemetry.scores().get(A);
    expect(score?.errors).toBe(0);
    expect(score?.failovers).toBe(0);
    expect(score?.successRate).toBe(1);
  });

  it("routes to another eligible assistant when the predecessor's is unavailable", async () => {
    await boot();
    // Take the predecessor's assistant out of the running in the window between
    // the continuation being reserved and it being routed.
    const s = scheduler(async (phase, dispatch) => {
      if (phase === "reserved" && dispatch.origin === "context-yield") {
        built.cooldowns.penalize(sessions(dispatch.task_id)[0]!.assistant_id, "failure", "unrelated outage");
      }
    });
    // No pin: the router is free to choose among both configured assistants.
    const t = built.tasks.create({ goal: "implement the change [FAKE:CONTEXT:0.96>0.3]", repoPath: repo });
    const id = t.taskId;
    s.attach(id, { kind: "time", notBefore: new Date(instant + 1000).toISOString() });

    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const all = sessions(id);
    expect(all).toHaveLength(2);
    expect(all[1]!.assistant_id).not.toBe(all[0]!.assistant_id);
    const dispatch = contextDispatches(id)[0]!;
    const explanation = JSON.parse(
      (db
        .prepare("SELECT explanation FROM routing_decisions WHERE id = ?")
        .get(
          (db.prepare("SELECT routing_decision_id AS r FROM dispatches WHERE dispatch_id = ?").get(dispatch.dispatch_id) as { r: number })
            .r,
        ) as { explanation: string }).explanation,
    ) as { contextContinuation?: { preferSameSatisfied?: boolean; changedBecause?: string } };
    expect(explanation.contextContinuation?.preferSameSatisfied).toBe(false);
    expect(explanation.contextContinuation?.changedBecause).toMatch(/cooldown|transient-unavailable/);
  });
});

describe("K11 — evidence adequacy", () => {
  it("an envelope-only checkpoint (git failure) starts no successor", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    // The checkpoint's envelope snapshot still commits; only the git commit fails.
    const git = await import("../src/repo/git.js");
    vi.spyOn(git, "commitCheckpoint").mockRejectedValue(new Error("git index.lock held"));

    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const row = built.tasks.get(id)!;
    expect(row.state).toBe("WAITING_INPUT");
    expect(row.pause_kind).toBe("continuation_evidence_missing");
    expect(sessions(id)).toHaveLength(1);
    expect(contextDispatches(id)).toHaveLength(0);
    expect(resultOf(sessions(id)[0]!.id).checkpoint.committed).toBe(false);
  });

  it("CR-32: a continuation stop is not wait-eligible — it needs an operator", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    const git = await import("../src/repo/git.js");
    vi.spyOn(git, "commitCheckpoint").mockRejectedValue(new Error("git index.lock held"));
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(() => s.attach(id, { kind: "time", notBefore: new Date(instant + 60_000).toISOString() })).toThrow(
      /operator decision/,
    );
  });
});

describe("K11 — task-level bounds", () => {
  it("an always-critical task stops at the first successor, not at the budget", async () => {
    await boot();
    const s = scheduler();
    // Always critical: the first successor is already-critical on its first
    // observation, which is its own stop and overrides the remaining budget.
    const id = contextTask(s, 0.96, 0.96);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;
    const row = built.tasks.get(id)!;
    expect(row.state).toBe("WAITING_INPUT");
    expect(row.pause_kind).toBe("successor_immediately_critical");
  });

  it("continuation #4 is blocked from the durable dispatch log alone", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const detail = resultOf(sessions(id)[0]!.id).yield!.detail as ContextYieldRequest;
    const result = resultOf(sessions(id)[0]!.id);

    // Three continuations already attempted, whatever their phase: a reparked and
    // an aborted attempt each consumed one, which is the point of the bound.
    const existing = contextDispatches(id)[0]!;
    const nextGeneration = (db.prepare("SELECT MAX(generation) AS g FROM wait_conditions WHERE task_id = ?").get(id) as { g: number }).g;
    for (const [i, phase] of ["reparked", "aborted"].entries()) {
      const generation = nextGeneration + i + 1;
      db.prepare(
        `INSERT INTO wait_conditions(task_id,generation,state,kind,not_before,created_by,created_at,reason,checkpoint_id,origin)
         VALUES(?,?,'consumed','time',?,'context-yield',?,'synthetic prior continuation',?,'context-yield')`,
      ).run(id, generation, now().toISOString(), now().toISOString(), existing.checkpoint_id);
      db.prepare(
        `INSERT INTO dispatches(dispatch_id,task_id,condition_generation,origin,checkpoint_id,execution_path,phase,created_at,updated_at)
         VALUES(?,?,?,'context-yield',?,'harness',?,?,?)`,
      ).run(`d_${phase}`, id, generation, existing.checkpoint_id, phase, now().toISOString(), now().toISOString());
    }
    expect(decideContextContinuation(db, detail, result)).toMatchObject({
      allowed: false,
      block: "continuation_limit_reached",
      attemptsSoFar: 3,
      continuationNumber: 4,
    });
  });

  it("bounds are recomputed from committed rows, so they survive a restart", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;
    const detail = resultOf(sessions(id)[0]!.id).yield!.detail as ContextYieldRequest;
    const result = resultOf(sessions(id)[0]!.id);
    const before = decideContextContinuation(db, detail, result);

    // A fresh connection to the same file: no in-memory counter is consulted,
    // so a restarted process reaches exactly the same decision.
    const restarted = openDb(config.dbPath);
    try {
      expect(decideContextContinuation(restarted, detail, result)).toMatchObject({
        attemptsSoFar: before.attemptsSoFar,
        continuationNumber: before.continuationNumber,
        noProgressStreak: before.noProgressStreak,
      });
      expect(before.attemptsSoFar).toBe(1);
    } finally {
      restarted.close();
    }
  });

  it("two consecutive continuations with no envelope progress park the task", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;
    const detail = resultOf(sessions(id)[0]!.id).yield!.detail as ContextYieldRequest;
    const result = resultOf(sessions(id)[0]!.id);
    const anchorId = detail.checkpointId!;

    // A second continuation that really happened — its dispatch was reparked,
    // which still consumed the attempt and still anchors the chain — whose
    // envelope repeats the first anchor's completed/remaining verbatim. New
    // events, new timestamps, no progress.
    synthCheckpoint(id, anchorId, "ckpt_np_a");
    synthContinuationDispatch(id, "ckpt_np_a", "reparked");
    // ...and the candidate now being judged, which restates it once more.
    synthCheckpoint(id, anchorId, "ckpt_np_b");
    const stalled = candidate(detail, result, "ckpt_np_b");
    expect(decideContextContinuation(db, stalled.detail, stalled.result)).toMatchObject({
      allowed: false,
      block: "continuation_no_progress",
      attemptsSoFar: 2,
      noProgressStreak: 2,
    });

    // A candidate that DID move the work on clears the streak.
    synthCheckpoint(id, anchorId, "ckpt_progress", (e) => {
      e.completed = [...(e.completed ?? []), "wired the new module"];
    });
    const moved = candidate(detail, result, "ckpt_progress");
    expect(decideContextContinuation(db, moved.detail, moved.result)).toMatchObject({
      allowed: true,
      noProgressStreak: 0,
    });
  });
});

/**
 * K11 review correction (P1-B): the continuation CHAIN is the durable
 * `dispatches.origin = 'context-yield'` log, not every `reason = 'context'`
 * checkpoint. A checkpoint the evidence gate refused produced no successor, so
 * it must consume no budget, move no ordinal and anchor no streak.
 */
describe("K11 — continuation history follows real continuations", () => {
  it("a Git-failed checkpoint dispatches nothing, and the next valid one is continuation 1", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    const git = await import("../src/repo/git.js");
    vi.spyOn(git, "commitCheckpoint").mockRejectedValue(new Error("git index.lock held"));
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    // 1. The inadequate checkpoint exists but started no successor.
    expect(built.tasks.get(id)!.pause_kind).toBe("continuation_evidence_missing");
    expect(contextDispatches(id)).toHaveLength(0);
    const failed = resultOf(sessions(id)[0]!.id);
    const detail = failed.yield!.detail as ContextYieldRequest;
    const failedCheckpointId = detail.checkpointId!;

    // A second stalled attempt leaves a second inadequate checkpoint, again
    // with no dispatch. Both restate the same completed/remaining.
    synthCheckpoint(id, failedCheckpointId, "ckpt_failed_b");

    // 2. The task later reaches a valid critical checkpoint — an operator
    // resumed it, or the work moved on and hit the ceiling again.
    synthCheckpoint(id, failedCheckpointId, "ckpt_valid");
    const resumed = candidate(detail, failed, "ckpt_valid");
    const decision = decideContextContinuation(db, resumed.detail, resumed.result);

    // This is the FIRST actual automatic continuation.
    expect(decision).toMatchObject({
      allowed: true,
      attemptsSoFar: 0,
      continuationNumber: 1,
      // 3. Two identical inadequate checkpoints consumed no no-progress budget:
      // counting them would have blocked this at the default limit of 2.
      noProgressStreak: 0,
    });
    expect(decision.checkpointId).toBe("ckpt_valid");
  });

  it("a reparked real continuation still consumes an attempt", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;
    const result = resultOf(sessions(id)[0]!.id);
    const detail = result.yield!.detail as ContextYieldRequest;
    const anchorId = detail.checkpointId!;

    synthCheckpoint(id, anchorId, "ckpt_reparked", (e) => {
      e.completed = [...(e.completed ?? []), "reparked but real"];
    });
    synthContinuationDispatch(id, "ckpt_reparked", "reparked");
    synthCheckpoint(id, anchorId, "ckpt_next", (e) => {
      e.completed = [...(e.completed ?? []), "reparked but real", "and moved on"];
    });

    const next = candidate(detail, result, "ckpt_next");
    expect(decideContextContinuation(db, next.detail, next.result)).toMatchObject({
      allowed: true,
      attemptsSoFar: 2,
      continuationNumber: 3,
    });
  });

  it("the routing explanation's continuationNumber is the dispatch-based decision number", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const dispatch = contextDispatches(id)[0]!;
    const explanation = JSON.parse(
      (
        db
          .prepare(
            "SELECT explanation FROM routing_decisions WHERE id = (SELECT routing_decision_id FROM dispatches WHERE dispatch_id = ?)",
          )
          .get(dispatch.dispatch_id) as { explanation: string }
      ).explanation,
    ) as { contextContinuation?: { continuationNumber?: number } };
    expect(explanation.contextContinuation?.continuationNumber).toBe(1);

    // An inadequate context checkpoint recorded BEFORE the real anchor used to
    // shift the provenance ordinal to 2, contradicting the gate's decision
    // number. The dispatch chain is the authority, so it stays 1.
    const earlier = db
      .prepare("SELECT run_id, session_id, envelope_snapshot FROM checkpoints WHERE id = ?")
      .get(dispatch.checkpoint_id!) as { run_id: string; session_id: string | null; envelope_snapshot: string };
    db.prepare(
      `INSERT INTO checkpoints(id,task_id,run_id,session_id,envelope_snapshot,git_ref,reason,at)
       VALUES('ckpt_earlier_failed',?,?,?,?,NULL,'context','2029-12-31T00:00:00.000Z')`,
    ).run(id, earlier.run_id, earlier.session_id, earlier.envelope_snapshot);

    expect(continuationProvenance(db, id, dispatch.checkpoint_id!)?.continuationNumber).toBe(1);
  });
});

describe("K11 — successor safety and human decisions", () => {
  it("an immediately critical successor stops the loop and overrides the budget", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.96);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const row = built.tasks.get(id)!;
    expect(row.state).toBe("WAITING_INPUT");
    expect(row.pause_kind).toBe("successor_immediately_critical");
    // Two sessions, one continuation — and no third session despite budget left.
    expect(sessions(id)).toHaveLength(2);
    expect(contextDispatches(id)).toHaveLength(1);
    const successor = resultOf(sessions(id)[1]!.id);
    expect((successor.yield!.detail as ContextYieldRequest).observation.sequence).toBe(1);
  });

  it("a cancellation committed before the successor starts makes no provider call", async () => {
    await boot();
    const start = vi.spyOn(built.registry.adapter(A), "start");
    const s = scheduler(async (phase) => {
      if (phase === "routed" && contextDispatches(id).length > 0) await s.cancel(id);
    });
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = reaches(id, ["CANCELLED"]);
    await s.tick();
    await done;

    expect(built.tasks.get(id)?.state).toBe("CANCELLED");
    // Exactly one provider start: the predecessor. The successor never launched.
    expect(start).toHaveBeenCalledTimes(1);
    expect(sessions(id)).toHaveLength(1);
  });
});

describe("K11 — crash boundaries create no duplicate successor", () => {
  it.each(["reserved", "routed", "materialized", "start_attempted", "session_created"] as const)(
    "crash at %s reuses committed work and leaves one owner",
    async (phase) => {
      await boot();
      const crash = new Error(`injected crash at ${phase}`);
      let armed = true;
      const first = scheduler(async (at, dispatch) => {
        if (at === phase && dispatch.origin === "context-yield" && armed) {
          armed = false;
          throw crash;
        }
      });
      const id = contextTask(first, 0.96, 0.3);
      instant += 1000;
      const parked = reaches(id, ["WAITING_RESOURCE", "ROUTING", "WAITING_INPUT"]);
      await first.tick().catch(() => undefined);
      await parked;
      first.stop();

      const committedBefore = contextDispatches(id);
      const routedBefore = committedBefore[0]
        ? (db.prepare("SELECT routing_decision_id AS r FROM dispatches WHERE dispatch_id = ?").get(committedBefore[0].dispatch_id) as { r: number | null }).r
        : null;

      // A new process: boot reconcile, then the ordinary timer.
      const second = scheduler();
      const done = settled(id);
      await second.reconcileOnBoot();
      if (built.tasks.get(id)?.state === "WAITING_RESOURCE") await second.runNow(id).catch(() => undefined);
      await done;

      // Exactly one continuation, one successor session, no duplicate anything.
      const after = contextDispatches(id);
      expect(after.length).toBeLessThanOrEqual(1);
      if (routedBefore !== null && after[0]) {
        // A committed routing decision is reused, never re-decided.
        const reused = (db.prepare("SELECT routing_decision_id AS r FROM dispatches WHERE dispatch_id = ?").get(after[0].dispatch_id) as { r: number | null }).r;
        expect(reused).toBe(routedBefore);
      }
      if (committedBefore[0]?.checkpoint_id && after[0]) {
        expect(after[0].checkpoint_id).toBe(committedBefore[0].checkpoint_id);
      }
      expect(sessions(id).length).toBeLessThanOrEqual(2);
      const live = db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r WHERE task_id = ? AND session_state NOT IN
             ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED')`,
        )
        .get(id) as { n: number };
      expect(live.n).toBe(0);
      second.stop();
    },
  );
});

describe("K11 — invariants and surfaces", () => {
  it("issues no compaction command and never a clear", async () => {
    await boot();
    const s = scheduler();
    // No adapter exposes a compaction control at K11 (that is K10) …
    const adapter = built.registry.adapter(A) as unknown as Record<string, unknown>;
    expect(adapter.compact).toBeUndefined();
    expect(built.registry.manifest(A)?.context?.compact).toBe("none");
    // … and nothing is ever sent into a live session, so no directive can be.
    const send = vi.spyOn(built.registry.adapter(A), "send");
    const started = vi.spyOn(built.registry.adapter(A), "start");

    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(send).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledTimes(2);
    for (const call of started.mock.calls) {
      expect(call[0]!.prompt).not.toMatch(/\/clear|\/compact/);
    }
    // The successor's prompt is the bounded envelope, not a transcript.
    const successorPrompt = started.mock.calls[1]![0]!.prompt;
    expect(successorPrompt).toContain("You are continuing work that another assistant started.");
    expect(successorPrompt).toContain("Continue from the checkpoint commit");
    expect(successorPrompt.length).toBeLessThan(4_000);
    for (const session of sessions(id)) {
      expect(eventTypes(session.id)).not.toContain("context.compaction.requested");
    }
  });

  it("I-C1: a context yield mutates no prior event, checkpoint, envelope or result", async () => {
    await boot();
    // Snapshot at the exact moment the continuation is reserved: the predecessor
    // is settled with its result persisted, and the successor has not started.
    let before: Map<string, string> | undefined;
    const s = scheduler(async (phase, dispatch) => {
      if (phase === "reserved" && dispatch.origin === "context-yield") before = rows();
    });
    const id = contextTask(s, 0.96, 0.3);

    /** Every append-only row, keyed so "changed" and "added" can be told apart. */
    const rows = () => {
      const map = new Map<string, string>();
      for (const r of db.prepare("SELECT run_id, seq, type, summary, payload FROM events").all() as Array<Record<string, unknown>>)
        map.set(`event:${r.run_id as string}:${r.seq as number}`, JSON.stringify(r));
      for (const r of db.prepare("SELECT id, envelope_snapshot, git_ref, reason FROM checkpoints").all() as Array<Record<string, unknown>>)
        map.set(`checkpoint:${r.id as string}`, JSON.stringify(r));
      for (const r of db.prepare("SELECT id, envelope, checkpoint_id FROM handoff_envelopes").all() as Array<Record<string, unknown>>)
        map.set(`envelope:${r.id as string}`, JSON.stringify(r));
      for (const r of db.prepare("SELECT session_id, result FROM execution_results").all() as Array<Record<string, unknown>>)
        map.set(`result:${r.session_id as string}`, JSON.stringify(r));
      return map;
    };

    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    expect(before, "the continuation never reserved").toBeDefined();
    expect(before!.size).toBeGreaterThan(0);
    expect([...before!.keys()].some((k) => k.startsWith("result:"))).toBe(true);

    const after = rows();
    // Nothing that existed is gone, and nothing that existed changed a byte.
    for (const [key, value] of before!) {
      expect(after.has(key), `${key} was deleted`).toBe(true);
      expect(after.get(key), `${key} was mutated`).toBe(value);
    }
    // The continuation only ever appended.
    expect(after.size).toBeGreaterThan(before!.size);
  });

  it("the context surface renders the continuation truthfully", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.3);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const view = readTaskContext(db, id, {
      now,
      capabilityFor: (assistantId) => built.registry.manifest(assistantId)?.context,
    });
    expect(view.continuation).toMatchObject({
      number: 1,
      limit: DEFAULT_CONTEXT_POLICY.maxContinuationsPerTask,
      reason: "Critical context pressure",
      predecessorSessionId: sessions(id)[0]!.id,
      successorSessionId: sessions(id)[1]!.id,
    });
    expect(view.continuation?.waitingReason).toBeUndefined();
  });

  it("the context surface names the stop when the plane refused to continue", async () => {
    await boot();
    const s = scheduler();
    const id = contextTask(s, 0.96, 0.96);
    instant += 1000;
    const done = settled(id);
    await s.tick();
    await done;

    const view = readTaskContext(db, id, {
      now,
      capabilityFor: (assistantId) => built.registry.manifest(assistantId)?.context,
    });
    expect(view.continuation?.waitingReason).toBe("successor_immediately_critical");
  });
});
