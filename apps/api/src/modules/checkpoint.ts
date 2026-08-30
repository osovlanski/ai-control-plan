import type { TaskEnvelope } from "@agent-plane/core";
import { newCheckpointId } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { commitCheckpoint, worktreeChangedFiles, worktreeDiffStat } from "../repo/git.js";
import type { TaskStore } from "./tasks.js";

export type CheckpointReason = "limit" | "handoff" | "cancel" | "completion" | "periodic" | "manual";

export interface Checkpoint {
  id: string;
  taskId: string;
  runId: string | null;
  envelope: TaskEnvelope;
  gitRef: string | null;
  diffStat: string | null;
  activitySummary: string | null;
  at: string;
}

/**
 * Checkpoint assembly is a control-plane function (review §3.2): no provider
 * exports portable state, so the plane builds it from what it already owns —
 * the envelope, the task branch, and its own normalized event log.
 */
export class CheckpointService {
  constructor(
    private db: Db,
    private tasks: TaskStore,
  ) {}

  async create(taskId: string, runId: string | null, reason: CheckpointReason): Promise<Checkpoint> {
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    const envelope = this.tasks.envelope(taskId);

    let gitRef: string | null = null;
    let diffStat: string | null = null;

    if (row.worktree_path && row.base_ref) {
      try {
        gitRef = await commitCheckpoint(row.worktree_path, `checkpoint(${taskId}): ${reason}`);
      } catch {
        // A commit failure must not lose the checkpoint — the envelope snapshot
        // is the part handoff cannot do without.
      }

      // Diff inspection is best-effort and must not erase a durable commit ref.
      // This also handles runners where the worktree's base ref is temporarily
      // unavailable even though the checkpoint commit itself succeeded.
      if (gitRef) {
        try {
          diffStat = await worktreeDiffStat(row.worktree_path, row.base_ref);
          // Reconcile the envelope's file list with what git actually shows —
          // the agent may have touched files it never announced in an event.
          const changed = await worktreeChangedFiles(row.worktree_path, row.base_ref);
          if (changed.length > 0) {
            envelope.artifacts.changedFiles = Array.from(
              new Set([...envelope.artifacts.changedFiles, ...changed]),
            );
            envelope.artifacts.diffRef = gitRef;
            this.tasks.saveEnvelope(envelope);
          }
        } catch {
          // A diff failure does not invalidate the checkpoint commit.
        }
      }
    }

    const activitySummary = runId ? this.summarizeActivity(runId) : null;
    const id = newCheckpointId();
    const at = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO checkpoints (id, task_id, run_id, envelope_snapshot, git_ref, diff_stat, activity_summary, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, runId, JSON.stringify(envelope), gitRef, diffStat, activitySummary, reason, at);

    return { id, taskId, runId, envelope, gitRef, diffStat, activitySummary, at };
  }

  latest(taskId: string): Checkpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(taskId) as
      | {
          id: string;
          task_id: string;
          run_id: string | null;
          envelope_snapshot: string;
          git_ref: string | null;
          diff_stat: string | null;
          activity_summary: string | null;
          at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      envelope: JSON.parse(row.envelope_snapshot) as TaskEnvelope,
      gitRef: row.git_ref,
      diffStat: row.diff_stat,
      activitySummary: row.activity_summary,
      at: row.at,
    };
  }

  list(taskId: string): Array<{ id: string; reason: string; at: string; gitRef: string | null }> {
    return this.db
      .prepare("SELECT id, reason, at, git_ref as gitRef FROM checkpoints WHERE task_id = ? ORDER BY at")
      .all(taskId) as Array<{ id: string; reason: string; at: string; gitRef: string | null }>;
  }

  /**
   * A ~1-page digest of the run's normalized events — what the receiving agent
   * needs, instead of a raw transcript it would pay tokens to re-read.
   */
  private summarizeActivity(runId: string): string {
    const events = this.db
      .prepare("SELECT type, summary, payload FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ type: string; summary: string; payload: string | null }>;
    if (events.length === 0) return "";

    const lines: string[] = [];
    const tools = events.filter((e) => e.type === "tool.completed" || e.type === "tool.failed");
    const files = events.filter((e) => e.type === "file.changed");
    const tests = events.filter((e) => e.type === "test.result");
    const errors = events.filter((e) => e.type === "error" || e.type === "tool.failed");
    const messages = events.filter((e) => e.type === "message");

    if (messages.length > 0) {
      lines.push("Recent notes from the assistant:");
      for (const m of messages.slice(-3)) lines.push(`- ${m.summary}`);
    }
    if (files.length > 0) {
      lines.push("", `Touched ${files.length} file change(s):`);
      for (const f of files.slice(-8)) lines.push(`- ${f.summary}`);
    }
    if (tools.length > 0) {
      lines.push("", `Ran ${tools.length} tool call(s), most recently:`);
      for (const t of tools.slice(-5)) lines.push(`- ${t.summary}`);
    }
    if (tests.length > 0) {
      lines.push("", `Test runs: ${tests.map((t) => t.summary).join("; ")}`);
    }
    if (errors.length > 0) {
      lines.push("", "Errors encountered:");
      for (const e of errors.slice(-5)) lines.push(`- ${e.summary}`);
    }
    return lines.join("\n");
  }
}
