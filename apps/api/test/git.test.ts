import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitCheckpoint, createTaskWorktree, DirtyWorktreeError, isDirty, isGitRepo, trustedWorktreeGitDir, worktreeChangedFiles } from "../src/repo/git.js";

let root: string;
let repo: string;
let worktrees: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-plane-git-"));
  repo = join(root, "repo");
  worktrees = join(root, "worktrees");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git("add", ".");
  git("commit", "-qm", "initial");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("task worktrees", () => {
  it("detects git repos and non-repos", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(root)).toBe(false);
  });

  it("creates an isolated worktree on branch task/<id> without touching the source checkout", async () => {
    const wt = await createTaskWorktree(repo, "AG-1", worktrees);
    expect(wt.branch).toBe("task/AG-1");
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(wt.path.startsWith(worktrees)).toBe(true);

    // The agent writes only inside its worktree.
    writeFileSync(join(wt.path, "new.ts"), "export const x = 1;\n");
    expect(existsSync(join(repo, "new.ts"))).toBe(false);
    expect(await isDirty(repo)).toBe(false);
  });

  it("refuses a dirty source tree unless explicitly overridden", async () => {
    writeFileSync(join(repo, "scratch.txt"), "uncommitted\n");
    await expect(createTaskWorktree(repo, "AG-2", worktrees)).rejects.toThrow(DirtyWorktreeError);
    const wt = await createTaskWorktree(repo, "AG-2", worktrees, { allowDirty: true });
    expect(wt.branch).toBe("task/AG-2");
  });

  it("rejects a path that is not a git repository", async () => {
    await expect(createTaskWorktree(root, "AG-3", worktrees)).rejects.toThrow(/not a git repository/);
  });

  it("isolates concurrent tasks in separate worktrees (Phase-5 parallelism precondition)", async () => {
    const a = await createTaskWorktree(repo, "AG-A", worktrees);
    const b = await createTaskWorktree(repo, "AG-B", worktrees);
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });
});

describe("confined git on an agent-writable worktree", () => {
  it("does not run hooks, fsmonitor or config reached through a tampered .git pointer", async () => {
    const wt = await createTaskWorktree(repo, "AG-9", worktrees);
    const evil = join(root, "evil-gitdir");
    const marker = join(root, "PWNED");
    // The agent replaces the pointer with its own git dir carrying a hook, fsmonitor and a pre-commit.
    execFileSync("git", ["clone", "-q", "--bare", repo, evil], { stdio: "pipe" });
    mkdirSync(join(evil, "hooks"), { recursive: true });
    for (const hook of ["pre-commit", "post-commit", "commit-msg", "reference-transaction"]) {
      writeFileSync(join(evil, "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    writeFileSync(join(evil, "fsmon.sh"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    execFileSync("git", ["-C", evil, "config", "core.fsmonitor", join(evil, "fsmon.sh")], { stdio: "pipe" });
    writeFileSync(join(evil, "config"), readFileSync(join(evil, "config"), "utf8") + `[core]\n\tworktree = ${wt.path}\n`);
    writeFileSync(join(wt.path, ".git"), `gitdir: ${evil}\n`);
    writeFileSync(join(wt.path, "change.txt"), "agent work\n");

    const sha = await commitCheckpoint(wt.path, "checkpoint", { confined: repo });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await worktreeChangedFiles(wt.path, wt.baseRef, { confined: repo })).toContain("change.txt");
    // The commit landed on the plane's task branch, not the planted git dir.
    expect(execFileSync("git", ["-C", repo, "rev-parse", "task/AG-9"], { encoding: "utf8" }).trim()).toBe(sha);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a worktree the plane never registered", () => {
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    mkdirSync(join(common, "worktrees"), { recursive: true });
    const stray = join(root, "stray");
    mkdirSync(stray);
    expect(() => trustedWorktreeGitDir(common, stray)).toThrow(/no plane-owned git dir/);
  });
});
