import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * M16 K19k: the kernel-owned scratch directory a task with no repository runs
 * in, instead of the workspace directory (which holds the DB and credentials).
 * Created at start, removed once the task is terminal. A plain directory, not
 * a git worktree: there is no repository to branch from.
 */
export const scratchRoot = (workspaceDir: string): string => join(workspaceDir, "scratch");

export function ensureScratch(workspaceDir: string, taskId: string): string {
  const path = join(scratchRoot(workspaceDir), taskId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function removeScratch(workspaceDir: string, taskId: string): void {
  rmSync(join(scratchRoot(workspaceDir), taskId), { recursive: true, force: true });
}

/** Boot sweep: a scratch directory whose task is terminal or gone is removed. */
export function sweepScratch(workspaceDir: string, keep: (taskId: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(scratchRoot(workspaceDir));
  } catch {
    return []; // no scratch root yet
  }
  const removed = entries.filter((taskId) => !keep(taskId));
  for (const taskId of removed) removeScratch(workspaceDir, taskId);
  return removed;
}
