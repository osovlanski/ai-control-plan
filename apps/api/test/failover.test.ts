import { execFileSync } from "node:child_process";
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

const PRIMARY = "fake-primary" as AssistantId;
const BACKUP = "fake-backup" as AssistantId;

/** Two interchangeable fake assistants: the personal-workspace failover shape. */
async function boot(extraConfig = ""): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "agent-plane-fo-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    `assistants:\n  fake-primary:\n    provider: fake\n  fake-backup:\n    provider: fake\n${extraConfig}`,
  );
  config = loadHarnessTestConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  registry = new Registry(db, config);
  registry.init();
  await registry.syncAll();
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

/**
 * Under single-mode Harness routing, `startTask` returns as soon as the
 * session is created — the runner then works the FakeAdapter asynchronously.
 * A manual handoff / cancel racing that startup (before the run has even
 * reached the state its goal describes) is not the scenario these tests mean
 * to exercise, so wait for the observable milestone first (matches the
 * working idiom in apps/api/test/harness/cutover.test.ts).
 */
async function pollFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("pollFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function runsOf(taskId: string) {
  return db
    .prepare("SELECT id, assistant_id, state FROM runs WHERE task_id = ? ORDER BY started_at")
    .all(taskId) as Array<{ id: string; assistant_id: string; state: string }>;
}

describe("automatic quota failover", () => {
  it("checkpoints on a limit and continues the task on the other assistant", async () => {
    const notices: string[] = [];
    const envelope = tasks.create({ goal: "Ship the feature [FAKE:LIMIT]" });
    bus.subscribe(envelope.taskId, (p: TaskStreamPayload) => {
      if (p.kind === "notice" && p.notice) notices.push(p.notice.text);
    });

    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    const settled = await orchestrator.waitForSettled(envelope.taskId);

    // The task itself completed — on the backup, from the checkpoint.
    expect(settled).toBe("COMPLETED");

    const runs = runsOf(envelope.taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ assistant_id: PRIMARY, state: "ENDED_ERROR" });
    expect(runs[1]).toMatchObject({ assistant_id: BACKUP, state: "ENDED_OK" });

    // A handoff record links the two runs through the checkpoint.
    const handoff = db
      .prepare("SELECT from_run_id, to_run_id, checkpoint_id, trigger FROM handoffs WHERE task_id = ?")
      .get(envelope.taskId) as {
      from_run_id: string;
      to_run_id: string;
      checkpoint_id: string;
      trigger: string;
    };
    expect(handoff.trigger).toBe("quota");
    expect(handoff.from_run_id).toBe(runs[0]!.id);
    expect(handoff.to_run_id).toBe(runs[1]!.id);
    expect(checkpoints.list(envelope.taskId).some((c) => c.id === handoff.checkpoint_id)).toBe(true);

    // Failover is never silent (review §3.9.6).
    expect(notices.some((n) => n.includes(BACKUP) && /handing off/i.test(n))).toBe(true);

    // Both routing decisions are on the record for the Routing tab.
    const decisions = db
      .prepare("SELECT chosen_assistant_id FROM routing_decisions WHERE task_id = ? ORDER BY id")
      .all(envelope.taskId) as Array<{ chosen_assistant_id: string }>;
    expect(decisions.at(-1)!.chosen_assistant_id).toBe(BACKUP);
  });

  it("gives the receiving assistant the portable handoff package, not a raw transcript", async () => {
    const envelope = tasks.create({
      goal: "Ship the feature [FAKE:LIMIT]",
      constraints: ["no breaking changes"],
    });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await orchestrator.waitForSettled(envelope.taskId);

    const checkpoint = checkpoints.latest(envelope.taskId)!;
    expect(checkpoint.activitySummary).toBeTruthy();
    // The summary digests the prior run's events rather than replaying them.
    expect(checkpoint.activitySummary).toMatch(/file change|tool call|Recent notes/i);
    expect(checkpoint.envelope.constraints).toEqual(["no breaking changes"]);
  });

  it("does not accumulate duplicate history across a handoff", async () => {
    const envelope = tasks.create({ goal: "Ship it [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await orchestrator.waitForSettled(envelope.taskId);

    // Both assistants narrate the same steps; the package must not double them,
    // or it degrades with every hop.
    const completed = tasks.envelope(envelope.taskId).completed;
    expect(completed.length).toBe(new Set(completed).size);
  });

  it("puts the exhausted assistant in a resets_at-aware cooldown", async () => {
    const envelope = tasks.create({ goal: "Burn quota [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await orchestrator.waitForSettled(envelope.taskId);

    const active = cooldowns.active();
    expect(active.has(PRIMARY)).toBe(true);
    expect(active.get(PRIMARY)).toMatch(/quota exhausted/i);
    // The fake reports resets_at one hour out; the cooldown honours it.
    const until = Date.parse(cooldowns.list().find((c) => c.assistantId === PRIMARY)!.until);
    expect(until).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    expect(until).toBeLessThan(Date.now() + 70 * 60 * 1000);
  });

  it("parks the task when every assistant is limited, naming what to wait for", async () => {
    const notices: string[] = [];
    // Backup is already cooling down, so the limit leaves nowhere to go.
    cooldowns.penalize(BACKUP, "limit", "quota exhausted", new Date(Date.now() + 3_600_000).toISOString());

    const envelope = tasks.create({ goal: "Nowhere to go [FAKE:LIMIT]" });
    bus.subscribe(envelope.taskId, (p) => {
      if (p.kind === "notice" && p.notice) notices.push(p.notice.text);
    });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);

    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("WAITING_INPUT");
    expect(notices.some((n) => /no other assistant is eligible/i.test(n))).toBe(true);
    expect(notices.some((n) => n.includes(BACKUP))).toBe(true); // says what is blocking
    // Work is not lost: a checkpoint exists to resume from.
    expect(checkpoints.list(envelope.taskId).length).toBeGreaterThan(0);
  });

  it("fails over on a provider crash too, and does not ping-pong back", async () => {
    const envelope = tasks.create({ goal: "Crashy task [FAKE:FAIL]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);

    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("COMPLETED");
    const runs = runsOf(envelope.taskId);
    expect(runs.map((r) => r.assistant_id)).toEqual([PRIMARY, BACKUP]);
    // The crashed assistant is cooled down, so it cannot be re-picked.
    expect(cooldowns.active().has(PRIMARY)).toBe(true);
  });

  it("respects failover.auto=false by parking instead of rerouting", async () => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("failover:\n  auto: false\n");

    const envelope = tasks.create({ goal: "No auto failover [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);

    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("WAITING_INPUT");
    expect(runsOf(envelope.taskId)).toHaveLength(1); // never rerouted
  });
});

describe("manual handoff", () => {
  // auto-approve (the workspace default) never raises approval.requested —
  // the mid-run interrupt tests below need it to actually reach that state.
  beforeEach(async () => {
    await orchestrator.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
    await boot("policy:\n  approvalMode: prompt-on-escalation\n");
  });

  it("moves a parked task to the other assistant, recording the handoff", async () => {
    // The realistic case: a limit parked the task, the user reroutes it by hand.
    cooldowns.penalize(BACKUP, "limit", "quota exhausted");
    const envelope = tasks.create({ goal: "Parked work [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("WAITING_INPUT");

    cooldowns.clear(BACKUP); // the backup's window reset
    const result = await orchestrator.handoff(envelope.taskId);
    expect(result.assistantId).toBe(BACKUP);
    await orchestrator.waitForSettled(envelope.taskId);

    const manual = db
      .prepare("SELECT trigger, to_run_id FROM handoffs WHERE task_id = ? AND trigger = 'manual'")
      .get(envelope.taskId) as { trigger: string; to_run_id: string };
    expect(manual.to_run_id).toBe(result.runId);
  });

  it("refuses to hand off a finished task — that is a new task, not a handoff", async () => {
    const envelope = tasks.create({ goal: "Do the thing" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("COMPLETED");

    await expect(orchestrator.handoff(envelope.taskId)).rejects.toThrow(/finished task cannot be handed off/);
  });

  it("interrupts an in-flight run before handing over, without racing it to a terminal state", async () => {
    const envelope = tasks.create({ goal: "Long task [FAKE:APPROVAL]" });
    let requested = false;
    bus.subscribe(envelope.taskId, (p: TaskStreamPayload) => {
      if (p.event?.type === "approval.requested") requested = true;
    });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await pollFor(() => (requested ? true : undefined));

    const result = await orchestrator.handoff(envelope.taskId, BACKUP);
    expect(result.assistantId).toBe(BACKUP);
    const runs = runsOf(envelope.taskId);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ assistant_id: PRIMARY });
    // The interrupted run did not drag the task into FAILED behind the handoff.
    expect(tasks.get(envelope.taskId)!.state).toBe("RUNNING");
  }, 15_000); // harnessHandoff synchronously drains the interrupted session (<=10s ceiling)

  it("refuses when the requested target fails a hard filter", async () => {
    cooldowns.penalize(BACKUP, "limit", "quota exhausted");
    const envelope = tasks.create({ goal: "Long task [FAKE:APPROVAL]" });
    let requested = false;
    bus.subscribe(envelope.taskId, (p: TaskStreamPayload) => {
      if (p.event?.type === "approval.requested") requested = true;
    });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await pollFor(() => (requested ? true : undefined));

    await expect(orchestrator.handoff(envelope.taskId, BACKUP)).rejects.toThrow(/No eligible assistant/);
  }, 15_000); // harnessHandoff drains the source session before checking target eligibility
});

describe("checkpoints over a real git worktree", () => {
  let repoRoot: string;
  let repo: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agent-plane-cp-repo-"));
    repo = join(repoRoot, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    config.repoAllowlist.push(repo);
  });

  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  it("commits the agent's work and records a diffstat the handoff can carry", async () => {
    const envelope = tasks.create({ goal: "Edit the repo", repoPath: repo });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await orchestrator.waitForSettled(envelope.taskId);

    const row = tasks.get(envelope.taskId)!;
    expect(row.worktree_path).toBeTruthy();
    // Simulate work the agent left in the tree, then checkpoint it.
    writeFileSync(join(row.worktree_path!, "feature.ts"), "export const feature = true;\n");
    const cp = await orchestrator.createCheckpoint(envelope.taskId, "manual");

    expect(cp.gitRef).toBeTruthy();
    expect(cp.diffStat).toContain("feature.ts");
    // The envelope's file list is reconciled with what git actually shows.
    expect(tasks.envelope(envelope.taskId).artifacts.changedFiles).toContain("feature.ts");
  });

  it("reuses the same worktree across a handoff so work carries over", async () => {
    const envelope = tasks.create({ goal: "Edit the repo [FAKE:LIMIT]", repoPath: repo });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, PRIMARY);
    await orchestrator.waitForSettled(envelope.taskId);

    const runs = runsOf(envelope.taskId);
    expect(runs).toHaveLength(2);
    // One worktree, one branch — the backup inherited the primary's tree.
    const row = tasks.get(envelope.taskId)!;
    expect(row.branch).toBe(`task/${envelope.taskId}`);
    expect(row.worktree_path).toContain(envelope.taskId);
  });
});
