import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantId } from "@agent-plane/core";
import type { ResolvedConfig } from "../src/config.js";
import { bootHarnessOrchestrator, loadHarnessTestConfig } from "./helpers/boot-orchestrator.js";
import { openDb, type Db } from "../src/db/index.js";
import { CheckpointService } from "../src/modules/checkpoint.js";
import { CooldownStore } from "../src/modules/cooldown.js";
import { effectiveUsageJoin, effectiveUsageSql } from "../src/modules/harness/state-vocab.js";
import type { Orchestrator } from "../src/modules/orchestrator.js";
import { Registry } from "../src/modules/registry.js";
import { TaskEventBus, type TaskStreamPayload } from "../src/modules/sse.js";
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

const FAKE_ID = "personal-fake" as AssistantId;

async function boot(extraConfig = ""): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-orch-"));
  // A workspace whose only assistant is the deterministic fake adapter.
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  personal-fake:\n    provider: fake\n${extraConfig}`,
  );
  config = loadHarnessTestConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  registry = new Registry(db, config);
  registry.init();
  await registry.sync(FAKE_ID);
  tasks = new TaskStore(db);
  bus = new TaskEventBus();
  checkpoints = new CheckpointService(db, tasks);
  cooldowns = new CooldownStore(db);
  orchestrator = bootHarnessOrchestrator({ db, config, registry, tasks, bus, checkpoints, cooldowns });
}

beforeEach(() => boot());

afterEach(async () => {
  await orchestrator.shutdown();
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("orchestrator end-to-end (fake adapter)", () => {
  it("runs a task to completion, persisting normalized events and deriving the envelope", async () => {
    const envelope = tasks.create({ goal: "Do the thing" });
    const seen: TaskStreamPayload[] = [];
    bus.subscribe(envelope.taskId, (p) => seen.push(p));

    tasks.transition(envelope.taskId, "ROUTING");
    const { runId } = await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await orchestrator.waitForSettled(envelope.taskId);

    const finalRow = tasks.get(envelope.taskId)!;
    expect(finalRow.state).toBe("COMPLETED");

    const events = db
      .prepare("SELECT seq, type, summary FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ seq: number; type: string; summary: string }>;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("run.ended");
    // Under single-mode Harness routing, real project verification now runs
    // after the provider ends and appends its own durable event (§3.3 — this
    // is the increment's whole point: verification was previously dark code).
    // The legacy path has no such event, so `run.ended` is its last one.
    const last = types.at(-1);
    expect(last === "run.ended" || last === "verification.result").toBe(true);
    expect(types).toContain("file.changed");
    expect(types).toContain("test.result");
    // seq is monotonic starting at 1 — the append-only contract the UI paginates on
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // Envelope derived from the stream, not from agent self-reporting
    const finalEnvelope = tasks.envelope(envelope.taskId);
    expect(finalEnvelope.artifacts.changedFiles).toEqual(["src/example.ts"]);
    expect(finalEnvelope.artifacts.testResults.at(-1)).toMatchObject({ passed: 3, failed: 0 });
    expect(finalEnvelope.status.phase).toBe("testing");

    // Run row closed out with usage recorded. Under single-mode Harness
    // routing `runs.usage` itself is never written — usage rides on the
    // terminal `execution_results` row instead (§5/8e's dual-field window,
    // no dual-write) — so read it the same way telemetry.ts does.
    const run = db
      .prepare(
        `SELECT state, ${effectiveUsageSql("r")} AS usage, ended_at
           FROM runs r ${effectiveUsageJoin("r")} WHERE r.id = ?`,
      )
      .get(runId) as { state: string; usage: string | null; ended_at: string | null };
    expect(run.state).toBe("ENDED_OK");
    expect(run.ended_at).not.toBeNull();
    expect(JSON.parse(run.usage!)).toMatchObject({ inputTokens: 1200, outputTokens: 450 });

    // SSE saw both live events and the terminal state change
    expect(seen.some((p) => p.kind === "event")).toBe(true);
    expect(seen.filter((p) => p.kind === "state").at(-1)?.state?.state).toBe("COMPLETED");
  });

  it("relays an approval round-trip and continues the run", async () => {
    // auto-approve (the workspace default) never raises approval.requested —
    // this test is specifically about the relay path, so it needs it.
    await orchestrator.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
    const envelope = tasks.create({ goal: "Delete something [FAKE:APPROVAL]" });
    let requestId: string | undefined;
    bus.subscribe(envelope.taskId, (p) => {
      if (p.event?.type === "approval.requested") {
        requestId = (p.event.payload as { requestId: string }).requestId;
      }
    });

    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, FAKE_ID);

    await waitFor(() => requestId !== undefined);
    await orchestrator.respondApproval(envelope.taskId, requestId!, true);
    await orchestrator.waitForSettled(envelope.taskId);

    expect(tasks.get(envelope.taskId)!.state).toBe("COMPLETED");
  });

  it("ends the run when an approval is denied", async () => {
    // auto-approve (the workspace default) never raises approval.requested —
    // this test is specifically about the relay path, so it needs it.
    await orchestrator.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
    const envelope = tasks.create({ goal: "Delete something [FAKE:APPROVAL]" });
    let requestId: string | undefined;
    bus.subscribe(envelope.taskId, (p) => {
      if (p.event?.type === "approval.requested") {
        requestId = (p.event.payload as { requestId: string }).requestId;
      }
    });

    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await waitFor(() => requestId !== undefined);
    await orchestrator.respondApproval(envelope.taskId, requestId!, false);
    await orchestrator.waitForSettled(envelope.taskId);

    expect(tasks.get(envelope.taskId)!.state).toBe("FAILED");
  });

  it("records limit events as quota snapshots for Phase-2 failover", async () => {
    const envelope = tasks.create({ goal: "Burn the quota [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    const { runId } = await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await orchestrator.waitForSettled(envelope.taskId);

    const limitEvents = db
      .prepare("SELECT type FROM events WHERE run_id = ? AND type LIKE 'limit.%'")
      .all(runId);
    expect(limitEvents).toHaveLength(1);

    const snapshot = db
      .prepare("SELECT assistant_id, window, used_percent FROM quota_snapshots WHERE assistant_id = ?")
      .get(FAKE_ID) as { window: string; used_percent: number } | undefined;
    expect(snapshot).toMatchObject({ window: "5h", used_percent: 100 });
  });

  it("refuses a second concurrent run on the same task", async () => {
    const envelope = tasks.create({ goal: "Slow task [FAKE:APPROVAL]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await expect(orchestrator.startTask(envelope.taskId, FAKE_ID)).rejects.toThrow(/already has an active run/);
    await orchestrator.cancelTask(envelope.taskId);
  });

  it("cancels a running task", async () => {
    const envelope = tasks.create({ goal: "Cancel me [FAKE:APPROVAL]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await orchestrator.cancelTask(envelope.taskId);
    expect(tasks.get(envelope.taskId)!.state).toBe("CANCELLED");
  });

  it("reconciles orphaned RUNNING tasks left by a crashed process", async () => {
    const envelope = tasks.create({ goal: "Orphan" });
    tasks.transition(envelope.taskId, "ROUTING");
    tasks.transition(envelope.taskId, "RUNNING");
    db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('orphan-run', ?, ?, 'ACTIVE', 't')",
    ).run(envelope.taskId, FAKE_ID);

    const fresh = bootHarnessOrchestrator({ db, config, registry, tasks, bus, checkpoints, cooldowns });
    expect(await fresh.reconcileOnBoot()).toBe(1);
    expect(tasks.get(envelope.taskId)!.state).toBe("FAILED");
    expect(
      (db.prepare("SELECT state FROM runs WHERE id = 'orphan-run'").get() as { state: string }).state,
    ).toBe("ENDED_ERROR");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
  it("persists secrets in neither normalized payload nor raw provider data", async () => {
    const secret = "sk-proj_abcdefghijklmnopqrstuvwxyz012345";
    const adapter = registry.adapter(FAKE_ID) as unknown as {
      script: { events: Array<Record<string, unknown>>; ok: boolean };
    };
    adapter.script = {
      ok: true,
      events: [{
        type: "message",
        summary: `Bearer abcdefghijklmnop ${secret}`,
        payload: { text: `API_TOKEN=${secret}`, access_token: "opaque-token" },
        raw: { authorization: "Bearer abcdefghijklmnop", env: `PASSWORD=hunter2\nOPENAI_API_KEY=${secret}` },
      }],
    };
    const envelope = tasks.create({ goal: "redaction test" });
    tasks.transition(envelope.taskId, "ROUTING");
    const { runId } = await orchestrator.startTask(envelope.taskId, FAKE_ID);
    await orchestrator.waitForSettled(envelope.taskId);
    const rows = db.prepare("SELECT payload,raw FROM events WHERE run_id=?").all(runId);
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("opaque-token");
    expect(persisted).not.toContain("hunter2");
    expect(persisted).not.toContain("abcdefghijklmnop");
  });
