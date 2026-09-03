/**
 * Phase 2 — checkpoints are session-scoped (§4): a checkpoint resolves its
 * worktree/branch from the RUN row, not the task row, so a parallel competitor
 * commits its own tree and never a sibling's (review R1).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db/index.js";
import { CheckpointService } from "../../src/modules/checkpoint.js";
import { TaskStore } from "../../src/modules/tasks.js";
import { createAssistantWorktree, createTaskBranch } from "../../src/repo/git.js";

let root: string;
let repo: string;
let db: Db;
let tasks: TaskStore;
let checkpoints: CheckpointService;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-ckpt-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  git(repo, "config", "user.email", "t@e.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");

  db = openDb(join(root, "t.db"));
  tasks = new TaskStore(db);
  checkpoints = new CheckpointService(db, tasks);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("session-scoped checkpoint", () => {
  it("commits the competitor's own worktree and records session_id", async () => {
    const env = tasks.create({ goal: "compare", repoPath: repo });
    const taskId = env.taskId as string;

    const { branch: base, baseRef } = await createTaskBranch(repo, taskId);
    const wtRoot = join(root, "worktrees");
    const a = await createAssistantWorktree(repo, taskId, "asst-a", wtRoot, base);
    const b = await createAssistantWorktree(repo, taskId, "asst-b", wtRoot, base);

    // Task row points at the shared base; each run row at its own tree.
    tasks.setWorktree(taskId, "", base, baseRef);
    db.prepare(
      "INSERT INTO assistants (id, provider) VALUES ('asst-a','fake'), ('asst-b','fake')",
    ).run();
    const insertRun = db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at, worktree_path, branch) VALUES (?, ?, ?, 'ACTIVE', 't', ?, ?)",
    );
    insertRun.run("run-a", taskId, "asst-a", a.path, a.branch);
    insertRun.run("run-b", taskId, "asst-b", b.path, b.branch);

    // Parallel competitors change disjoint files.
    writeFileSync(join(a.path, "a-change.ts"), "export const a = 1;\n");
    writeFileSync(join(b.path, "b-change.ts"), "export const b = 1;\n");

    const ckpt = await checkpoints.create(taskId, "run-b", "handoff", {
      worktreePath: b.path,
      baseRef,
    });
    expect(ckpt.gitRef).toBeTruthy();
    expect(ckpt.changedFiles).toEqual(["b-change.ts"]);

    // The checkpoint commit landed in B's worktree, carrying b-change.ts...
    const bLog = git(b.path, "log", "-1", "--name-only", "--pretty=format:%s").toString();
    expect(bLog).toContain("b-change.ts");
    // ...and A's independent change remains absent from B's change set.
    const aCkpt = await checkpoints.create(taskId, "run-a", "pre_verification", {
      worktreePath: a.path,
      baseRef,
    });
    expect(aCkpt.changedFiles).toEqual(["a-change.ts"]);

    const row = db.prepare("SELECT session_id, git_ref FROM checkpoints WHERE id = ?").get(ckpt.id) as {
      session_id: string;
      git_ref: string;
    };
    expect(row.session_id).toBe("run-b");
    expect(row.git_ref).toBe(ckpt.gitRef);
  });

  it("rejects a runId that belongs to another task", async () => {
    const env1 = tasks.create({ goal: "t1" });
    const env2 = tasks.create({ goal: "t2" });
    db.prepare("INSERT INTO assistants (id, provider) VALUES ('x','fake')").run();
    db.prepare(
      "INSERT INTO runs (id, task_id, assistant_id, state, started_at) VALUES ('run-x', ?, 'x', 'ACTIVE', 't')",
    ).run(env2.taskId);
    await expect(checkpoints.create(env1.taskId as string, "run-x", "manual")).rejects.toThrow(
      /belongs to task/,
    );
  });

  it("rejects an unknown runId", async () => {
    const env = tasks.create({ goal: "t" });
    await expect(checkpoints.create(env.taskId as string, "nope", "manual")).rejects.toThrow(/Unknown run/);
  });
});
