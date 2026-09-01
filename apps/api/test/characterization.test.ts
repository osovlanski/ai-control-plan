/**
 * Characterization tests — the strangler safety net for the Execution Harness
 * migration (execution-harness §10, plan Phase 0).
 *
 * These pin the CURRENT observable behavior of `Orchestrator` at its public
 * surface (start, failover, denied-approval, cancel, manual handoff, parallel
 * compare). Every cutover phase must keep this file green.
 *
 * Each test is tagged:
 *   [intentional] — a contract the Harness split must preserve verbatim.
 *   [accidental]  — current behavior we are merely recording; a phase may change
 *                   it deliberately, and if so this test changes with it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import { loadConfig, type ResolvedConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db/index.js";
import { CheckpointService } from "../src/modules/checkpoint.js";
import { CooldownStore } from "../src/modules/cooldown.js";
import { Orchestrator } from "../src/modules/orchestrator.js";
import { Registry } from "../src/modules/registry.js";
import { TaskEventBus } from "../src/modules/sse.js";
import { TaskStore } from "../src/modules/tasks.js";

let home: string;
let db: Db;
let config: ResolvedConfig;
let registry: Registry;
let tasks: TaskStore;
let bus: TaskEventBus;
let checkpoints: CheckpointService;
let cooldowns: CooldownStore;
let orchestrator: Orchestrator;

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

async function boot(extraConfig = ""): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-char-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  fake-a:\n    provider: fake\n  fake-b:\n    provider: fake\n${extraConfig}`,
  );
  config = loadConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  registry = new Registry(db, config);
  registry.init();
  await registry.syncAll();
  tasks = new TaskStore(db);
  bus = new TaskEventBus();
  checkpoints = new CheckpointService(db, tasks);
  cooldowns = new CooldownStore(db);
  orchestrator = new Orchestrator(db, config, registry, tasks, bus, checkpoints, cooldowns);
}

beforeEach(() => boot());
afterEach(async () => {
  await orchestrator.shutdown();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const runsOf = (taskId: string) =>
  db
    .prepare("SELECT id, assistant_id, state, outcome FROM runs WHERE task_id = ? ORDER BY started_at, id")
    .all(taskId) as Array<{ id: string; assistant_id: string; state: string; outcome: string | null }>;

describe("Orchestrator characterization", () => {
  it("[intentional] start → COMPLETED with a single ENDED_OK run and monotonic events", async () => {
    const env = tasks.create({ goal: "do it" });
    tasks.transition(env.taskId, "ROUTING");
    const { runId } = await orchestrator.startTask(env.taskId, A);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("COMPLETED");

    const runs = runsOf(env.taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ assistant_id: A, state: "ENDED_OK" });

    const seqs = (
      db.prepare("SELECT seq FROM events WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ seq: number }>
    ).map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("[intentional] a provider error with auto-failover off ends the task FAILED", async () => {
    await orchestrator.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("failover:\n  auto: false\n");

    const env = tasks.create({ goal: "boom [FAKE:FAIL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("FAILED");
    expect(runsOf(env.taskId)).toHaveLength(1);
  });

  it("[intentional] a hard limit auto-fails-over to the other assistant and completes via handoff", async () => {
    const env = tasks.create({ goal: "ship [FAKE:LIMIT]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("COMPLETED");

    const runs = runsOf(env.taskId);
    expect(runs.map((r) => r.assistant_id)).toEqual([A, B]);
    expect(runs[0]!.state).toBe("ENDED_ERROR");
    expect(runs[1]!.state).toBe("ENDED_OK");

    const handoff = db
      .prepare("SELECT trigger, checkpoint_id FROM handoffs WHERE task_id = ?")
      .get(env.taskId) as { trigger: string; checkpoint_id: string } | undefined;
    expect(handoff?.trigger).toBe("quota");
    expect(handoff?.checkpoint_id).toBeTruthy();
  });

  it("[intentional] a denied approval ends the task FAILED and does NOT fail over", async () => {
    const env = tasks.create({ goal: "needs sign-off [FAKE:APPROVAL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);

    // Wait for the approval to surface, then deny it.
    const pending = await waitForApproval(env.taskId);
    await orchestrator.respondApproval(env.taskId, pending, false);

    expect(await orchestrator.waitForSettled(env.taskId)).toBe("FAILED");
    expect(runsOf(env.taskId)).toHaveLength(1); // no failover on an intentional denial
  });

  it("[intentional] an approved approval lets the run finish COMPLETED", async () => {
    const env = tasks.create({ goal: "needs sign-off [FAKE:APPROVAL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    const pending = await waitForApproval(env.taskId);
    await orchestrator.respondApproval(env.taskId, pending, true);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("COMPLETED");
  });

  it("[intentional] cancelTask moves the task to CANCELLED and records a cancel checkpoint", async () => {
    const env = tasks.create({ goal: "long one [FAKE:APPROVAL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    await waitForApproval(env.taskId);

    await orchestrator.cancelTask(env.taskId);
    expect(tasks.get(env.taskId)!.state).toBe("CANCELLED");
    const ckpt = db
      .prepare("SELECT reason FROM checkpoints WHERE task_id = ? ORDER BY at DESC LIMIT 1")
      .get(env.taskId) as { reason: string } | undefined;
    expect(ckpt?.reason).toBe("cancel");
  });

  it("[intentional] manual handoff mid-run starts a fresh run on the requested assistant", async () => {
    // Keep A busy on an approval so the task is still RUNNING when we hand off.
    const env = tasks.create({ goal: "hand this over [FAKE:APPROVAL]" });
    tasks.transition(env.taskId, "ROUTING");
    await orchestrator.startTask(env.taskId, A);
    await waitForApproval(env.taskId);

    const { assistantId } = await orchestrator.handoff(env.taskId, B);
    expect(assistantId).toBe(B);
    // handoff() awaits startTask(B), so the second run row exists on return.
    const assistants = runsOf(env.taskId).map((r) => r.assistant_id).sort();
    expect(assistants).toEqual([A, B].sort());
    expect(tasks.get(env.taskId)!.state).toBe("RUNNING");
  });

  it("[intentional] parallel compare runs both, parks in WAITING_INPUT, resolves to COMPLETED", async () => {
    const env = tasks.create({ goal: "compare approaches" });
    const { runs } = await orchestrator.startParallel(env.taskId, [A, B], "compare");
    expect(runs).toHaveLength(2);
    expect(await orchestrator.waitForSettled(env.taskId)).toBe("WAITING_INPUT");

    const winner = runsOf(env.taskId)[0]!.id;
    await orchestrator.resolveComparison(env.taskId, winner, "cleaner diff");
    expect(tasks.get(env.taskId)!.state).toBe("COMPLETED");
    const outcomes = runsOf(env.taskId).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["rejected", "winner"]);
  });
});

/** Poll the event stream for the pending approval request id. */
async function waitForApproval(taskId: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const row = db
      .prepare(
        `SELECT e.payload FROM events e JOIN runs r ON r.id = e.run_id
         WHERE r.task_id = ? AND e.type = 'approval.requested' ORDER BY e.seq DESC LIMIT 1`,
      )
      .get(taskId) as { payload: string | null } | undefined;
    const requestId = row?.payload ? (JSON.parse(row.payload) as { requestId?: string }).requestId : undefined;
    if (requestId) return requestId;
    if (Date.now() - start > timeoutMs) throw new Error(`no approval surfaced for ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
