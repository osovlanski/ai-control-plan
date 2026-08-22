import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export class DirtyWorktreeError extends Error {
  constructor(repoPath: string) {
    super(
      `Repository ${repoPath} has uncommitted changes. Commit or stash them first (or override with allowDirty).`,
    );
    this.name = "DirtyWorktreeError";
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function isDirty(repoPath: string): Promise<boolean> {
  return (await git(repoPath, ["status", "--porcelain"])) !== "";
}

export interface TaskWorktree {
  /** The agent's isolated working directory. */
  path: string;
  branch: string;
  baseRef: string;
}

/**
 * Creates the task branch `task/<id>` and a dedicated worktree for it under
 * the workspace dir — the user's own checkout is never touched (arch §11).
 * Refuses a dirty source tree unless allowDirty (uncommitted work would be
 * invisible to the agent and confuses diffing).
 */
export async function createTaskWorktree(
  repoPath: string,
  taskId: string,
  worktreesDir: string,
  opts: { allowDirty?: boolean } = {},
): Promise<TaskWorktree> {
  if (!(await isGitRepo(repoPath))) {
    throw new Error(`${repoPath} is not a git repository`);
  }
  if (!opts.allowDirty && (await isDirty(repoPath))) {
    throw new DirtyWorktreeError(repoPath);
  }
  const branch = `task/${taskId}`;
  const baseRef = await git(repoPath, ["rev-parse", "HEAD"]);
  mkdirSync(worktreesDir, { recursive: true });
  const path = join(worktreesDir, taskId);
  await git(repoPath, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { path, branch, baseRef };
}

/** Diffstat of the task branch against its base (for checkpoints/handoff). */
export async function worktreeDiffStat(worktreePath: string, baseRef: string): Promise<string> {
  return git(worktreePath, ["diff", "--stat", baseRef]);
}

export async function removeTaskWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
}
