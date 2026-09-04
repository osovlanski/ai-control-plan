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
import { TelemetryService, classifyGoal } from "../src/modules/telemetry.js";

let home: string;
let repoRoot: string;
let repo: string;
let db: Db;
let config: ResolvedConfig;
let registry: Registry;
let tasks: TaskStore;
let bus: TaskEventBus;
let orchestrator: Orchestrator;
let telemetry: TelemetryService;

const A = "fake-a" as AssistantId;
const B = "fake-b" as AssistantId;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-plane-par-"));
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(
    join(home, "personal", "config.yaml"),
    "assistants:\n  fake-a: { provider: fake }\n  fake-b: { provider: fake }\n",
  );
  config = loadHarnessTestConfig({ AGENT_PLANE_HOME: home });
  db = openDb(config.dbPath);
  registry = new Registry(db, config);
  registry.init();
  await registry.syncAll();
  tasks = new TaskStore(db);
  bus = new TaskEventBus();
  telemetry = new TelemetryService(db);
  orchestrator = bootHarnessOrchestrator({
    db,
    config,
    registry,
    tasks,
    bus,
    checkpoints: new CheckpointService(db, tasks),
    cooldowns: new CooldownStore(db),
  });

  repoRoot = mkdtempSync(join(tmpdir(), "agent-plane-par-repo-"));
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

afterEach(async () => {
  await orchestrator.shutdown();
  db.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

function runsOf(taskId: string) {
  return db
    .prepare("SELECT id, assistant_id, state, branch, worktree_path, outcome FROM runs WHERE task_id = ? ORDER BY started_at")
    .all(taskId) as Array<{
    id: string;
    assistant_id: string;
    state: string;
    branch: string | null;
    worktree_path: string | null;
    outcome: string | null;
  }>;
}

describe("compare mode", () => {
  it("runs both assistants in separate worktrees and waits for the user to pick", async () => {
    const notices: string[] = [];
    const envelope = tasks.create({ goal: "Implement the feature", repoPath: repo });
    bus.subscribe(envelope.taskId, (p: TaskStreamPayload) => {
      if (p.kind === "notice" && p.notice) notices.push(p.notice.text);
    });

    const { runs } = await orchestrator.startParallel(envelope.taskId, [A, B], "compare");
    expect(runs).toHaveLength(2);
    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("WAITING_INPUT");

    const rows = runsOf(envelope.taskId);
    expect(rows).toHaveLength(2);
    // Never two assistants in one working tree (arch §11).
    expect(new Set(rows.map((r) => r.worktree_path)).size).toBe(2);
    expect(new Set(rows.map((r) => r.branch)).size).toBe(2);
    expect(rows.map((r) => r.branch).sort()).toEqual([
      `task/${envelope.taskId}--fake-a`,
      `task/${envelope.taskId}--fake-b`,
    ]);
    expect(notices.some((n) => /Comparing fake-a vs fake-b/.test(n))).toBe(true);
    expect(notices.some((n) => /pick a winner/i.test(n))).toBe(true);
  });

  it("presents a side-by-side comparison of the competitors", async () => {
    const envelope = tasks.create({ goal: "Implement the feature", repoPath: repo });
    await orchestrator.startParallel(envelope.taskId, [A, B], "compare");
    await orchestrator.waitForSettled(envelope.taskId);

    const comparison = await orchestrator.comparison(envelope.taskId);
    expect(comparison.mode).toBe("compare");
    expect(comparison.decided).toBeNull();
    expect(comparison.competitors).toHaveLength(2);
    for (const c of comparison.competitors) {
      expect(c.assistantId).toBeTruthy();
      expect(c.durationMs).toBeTypeOf("number");
      expect(c.tests).toMatchObject({ passed: 3, failed: 0 });
      expect(c.diff).not.toBeNull();
    }
  });

  it("merges the winner into the task branch and leaves the loser inspectable", async () => {
    const envelope = tasks.create({ goal: "Implement the feature", repoPath: repo });
    await orchestrator.startParallel(envelope.taskId, [A, B], "compare");
    await orchestrator.waitForSettled(envelope.taskId);

    const rows = runsOf(envelope.taskId);
    const winner = rows[1]!; // deliberately not the first, to prove it is a real choice
    // Give the winning worktree a distinguishing commit.
    writeFileSync(join(winner.worktree_path!, "winner.ts"), "export const won = true;\n");
    execFileSync("git", ["-C", winner.worktree_path!, "add", "-A"], { stdio: "pipe" });
    execFileSync("git", ["-C", winner.worktree_path!, "commit", "-qm", "winning work"], { stdio: "pipe" });

    const result = await orchestrator.resolveComparison(envelope.taskId, winner.id, "better diff");
    expect(result.mergedRef).toBeTruthy();
    expect(tasks.get(envelope.taskId)!.state).toBe("COMPLETED");

    const after = runsOf(envelope.taskId);
    expect(after.find((r) => r.id === winner.id)!.outcome).toBe("winner");
    expect(after.filter((r) => r.outcome === "rejected")).toHaveLength(1);

    // The task branch now carries the winner's commit...
    const log = execFileSync("git", ["-C", repo, "log", "--oneline", `task/${envelope.taskId}`], { encoding: "utf8" });
    expect(log).toContain("winning work");
    // ...and the rejected branch still exists for inspection.
    const branches = execFileSync("git", ["-C", repo, "branch", "--list"], { encoding: "utf8" });
    expect(branches).toContain(`task/${envelope.taskId}--${rows[0]!.assistant_id}`);

    const comparison = await orchestrator.comparison(envelope.taskId);
    expect(comparison.decided).toMatchObject({ winnerRunId: winner.id, decidedBy: "user" });
  });

  it("refuses a winner that is not part of the task", async () => {
    const envelope = tasks.create({ goal: "Implement the feature", repoPath: repo });
    await orchestrator.startParallel(envelope.taskId, [A, B], "compare");
    await orchestrator.waitForSettled(envelope.taskId);
    await expect(orchestrator.resolveComparison(envelope.taskId, "run_not_mine")).rejects.toThrow(/not part of task/);
  });

  it("requires at least two assistants, and refuses to start over a live run", async () => {
    const envelope = tasks.create({ goal: "Implement the feature" });
    await expect(orchestrator.startParallel(envelope.taskId, [A], "compare")).rejects.toThrow(/at least two/);

    await orchestrator.startParallel(envelope.taskId, [A, B], "compare");
    await expect(orchestrator.startParallel(envelope.taskId, [A, B], "compare")).rejects.toThrow(/already has an active run/);
  });
});

describe("race mode", () => {
  it("takes the first success, cancels the rest, and completes without asking", async () => {
    const envelope = tasks.create({ goal: "Implement the feature", repoPath: repo });
    await orchestrator.startParallel(envelope.taskId, [A, B], "race");

    expect(await orchestrator.waitForSettled(envelope.taskId)).toBe("COMPLETED");
    const rows = runsOf(envelope.taskId);
    expect(rows.filter((r) => r.outcome === "winner")).toHaveLength(1);
    // Parallel execution multiplies spend, so the losers must actually stop.
    expect(rows.filter((r) => r.outcome === "rejected").length).toBeGreaterThanOrEqual(1);

    const comparison = await orchestrator.comparison(envelope.taskId);
    expect(comparison.decided?.decidedBy).toBe("race");
  });
});

describe("telemetry-fed routing", () => {
  it("measures real runs and exposes them per assistant", async () => {
    const first = tasks.create({ goal: "Fix the bug" });
    tasks.transition(first.taskId, "ROUTING");
    await orchestrator.startTask(first.taskId, A);
    await orchestrator.waitForSettled(first.taskId);

    const scores = telemetry.scores();
    const score = scores.get(A)!;
    expect(score.runs).toBe(1);
    expect(score.successRate).toBe(1);
    expect(score.medianDurationMs).toBeTypeOf("number");
    expect(score.medianTokens).toBe(1650); // 1200 in + 450 out from the fake
    expect(score.testPassRate).toBe(1);
  });

  it("segments scores by task kind, since coding skill does not imply review skill", async () => {
    const coding = tasks.create({ goal: "Fix the auth bug" });
    tasks.transition(coding.taskId, "ROUTING");
    await orchestrator.startTask(coding.taskId, A);
    await orchestrator.waitForSettled(coding.taskId);

    expect(classifyGoal("Fix the auth bug")).toBe("coding");
    expect(telemetry.scores("coding").has(A)).toBe(true);
    expect(telemetry.scores("review").has(A)).toBe(false);
  });

  it("counts failovers away from an assistant as a reliability signal", async () => {
    const envelope = tasks.create({ goal: "Ship it [FAKE:LIMIT]" });
    tasks.transition(envelope.taskId, "ROUTING");
    await orchestrator.startTask(envelope.taskId, A);
    await orchestrator.waitForSettled(envelope.taskId);

    expect(telemetry.scores().get(A)!.failovers).toBe(1);
  });
});
