import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export interface GitRepositoryIdentityObservation {
  canonicalGitDir: string;
  canonicalToplevel: string;
  remotes: Array<{ name: string; url: string }>;
}

/** Local inspection only: no fetch, credential helper, or network operation. */
export async function inspectGitRepositoryIdentity(repoPath: string): Promise<GitRepositoryIdentityObservation> {
  const [commonDir, toplevel, remoteNames] = await Promise.all([
    git(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(repoPath, ["rev-parse", "--show-toplevel"]),
    git(repoPath, ["remote"]),
  ]);
  const remotes: Array<{ name: string; url: string }> = [];
  for (const name of remoteNames.split("\n").filter(Boolean).sort()) {
    const url = await git(repoPath, ["config", "--get", `remote.${name}.url`]).catch(() => "");
    if (url) remotes.push({ name, url });
  }
  const commonPath = isAbsolute(commonDir) ? commonDir : resolve(repoPath, commonDir);
  return {
    canonicalGitDir: realpathSync(commonPath),
    canonicalToplevel: realpathSync(toplevel),
    remotes,
  };
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

/** Paths changed on the task branch since its base, committed or not. */
export async function worktreeChangedFiles(worktreePath: string, baseRef: string): Promise<string[]> {
  const out = await git(worktreePath, ["diff", "--name-only", baseRef]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Commits everything in the worktree as a checkpoint. Returns the commit sha,
 * or null when the tree is clean (a checkpoint with nothing new is not an error —
 * the envelope snapshot still has value).
 */
export async function commitCheckpoint(worktreePath: string, message: string): Promise<string | null> {
  await git(worktreePath, ["add", "-A"]);
  const staged = await git(worktreePath, ["diff", "--cached", "--name-only"]);
  if (!staged) return git(worktreePath, ["rev-parse", "HEAD"]);
  try {
    await git(worktreePath, ["commit", "-q", "-m", message]);
  } catch (error) {
    // Concurrent completion/manual checkpoints may race after staging; if the
    // other checkpoint committed the same tree, this checkpoint still points
    // at that durable state.
    if (await isDirty(worktreePath)) throw error;
  }
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

export async function removeTaskWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
}

/**
 * A worktree for ONE assistant in a parallel comparison. Each competitor gets
 * its own tree and branch off the shared task branch, so no two assistants ever
 * write to the same working tree (arch §11).
 */
export async function createAssistantWorktree(
  repoPath: string,
  taskId: string,
  assistantId: string,
  worktreesDir: string,
  baseBranch: string,
): Promise<TaskWorktree> {
  // A SIBLING of the task branch, not a child: git refs are a filesystem
  // hierarchy, so refs/heads/task/<id> existing as a file makes
  // refs/heads/task/<id>/<assistant> impossible to create.
  const branch = `${baseBranch}--${assistantId}`;
  const baseRef = await git(repoPath, ["rev-parse", baseBranch]);
  const path = join(worktreesDir, taskId, assistantId);
  mkdirSync(join(worktreesDir, taskId), { recursive: true });
  await git(repoPath, ["worktree", "add", "-b", branch, path, baseBranch]);
  return { path, branch, baseRef };
}

/**
 * Creates the shared task branch without checking it out anywhere.
 *
 * Idempotent: a task row carries its branch NAME from creation time, but the
 * git ref only exists once something creates it.
 */
export async function createTaskBranch(repoPath: string, taskId: string): Promise<{ branch: string; baseRef: string }> {
  if (!(await isGitRepo(repoPath))) throw new Error(`${repoPath} is not a git repository`);
  const branch = `task/${taskId}`;
  const existing = await git(repoPath, ["rev-parse", "--verify", "--quiet", branch]).catch(() => "");
  if (existing) return { branch, baseRef: existing };
  const baseRef = await git(repoPath, ["rev-parse", "HEAD"]);
  await git(repoPath, ["branch", branch, "HEAD"]);
  return { branch, baseRef };
}

/**
 * Merges the winning competitor's branch into the shared task branch. Uses a
 * real merge (never a reset) so a losing branch stays inspectable afterwards.
 */
export async function mergeWinner(
  repoPath: string,
  taskBranch: string,
  winnerBranch: string,
): Promise<{ mergedRef: string }> {
  await git(repoPath, ["fetch", ".", `${winnerBranch}:${winnerBranch}`]).catch(() => undefined);
  // Merge into the task branch without disturbing the user's own checkout.
  await git(repoPath, ["update-ref", `refs/heads/${taskBranch}`, `refs/heads/${winnerBranch}`]);
  return { mergedRef: await git(repoPath, ["rev-parse", taskBranch]) };
}

/** Per-run diff summary used to compare competitors side by side. */
export async function runDiffSummary(
  worktreePath: string,
  baseRef: string,
): Promise<{ diffStat: string; changedFiles: string[]; insertions: number; deletions: number }> {
  const diffStat = await git(worktreePath, ["diff", "--stat", baseRef]);
  const changedFiles = await worktreeChangedFiles(worktreePath, baseRef);
  const numstat = await git(worktreePath, ["diff", "--numstat", baseRef]);
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del] = line.split("\t");
    insertions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { diffStat, changedFiles, insertions, deletions };
}
