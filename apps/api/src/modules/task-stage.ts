/**
 * Task stage v1 reads (docs/contracts/task-stage-v1.md, API 2.9). Gathers the three facts
 * `deriveStage` takes from the plane's own rows and nothing else: the task state, the
 * effective state of each run, and whether the latest wait condition is active. The rules
 * live in `@agent-plane/core`; this module only reads.
 */
import { deriveStage, type ExecutionSessionState, type TaskStage, type TaskState } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { effectiveStateSql } from "./harness/state-vocab.js";

export class TaskStageReader {
  constructor(private db: Db) {}

  /** One task's stage, or undefined when the task does not exist. */
  of(taskId: string): TaskStage | undefined {
    const task = this.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string } | undefined;
    if (!task) return undefined;
    const runs = this.db
      .prepare(`SELECT ${effectiveStateSql()} AS state FROM runs WHERE task_id = ?`)
      .all(taskId) as Array<{ state: string }>;
    const wait = this.db
      .prepare("SELECT state FROM wait_conditions WHERE task_id = ? ORDER BY generation DESC LIMIT 1")
      .get(taskId) as { state: string } | undefined;
    return deriveStage({
      taskState: task.state as TaskState,
      sessionStates: runs.map((r) => r.state as ExecutionSessionState),
      waitActive: wait?.state === "active",
    });
  }

  /** Every task's stage in three queries, for the task list. */
  all(): Map<string, TaskStage> {
    const sessions = new Map<string, ExecutionSessionState[]>();
    for (const r of this.db.prepare(`SELECT task_id, ${effectiveStateSql()} AS state FROM runs`).all() as Array<{ task_id: string; state: string }>) {
      const list = sessions.get(r.task_id) ?? [];
      list.push(r.state as ExecutionSessionState);
      sessions.set(r.task_id, list);
    }
    const waiting = new Set(
      (this.db
        .prepare(
          `SELECT w.task_id FROM wait_conditions w
           WHERE w.state = 'active' AND w.generation = (SELECT MAX(generation) FROM wait_conditions x WHERE x.task_id = w.task_id)`,
        )
        .all() as Array<{ task_id: string }>).map((r) => r.task_id),
    );
    const out = new Map<string, TaskStage>();
    for (const t of this.db.prepare("SELECT id, state FROM tasks").all() as Array<{ id: string; state: string }>) {
      out.set(t.id, deriveStage({ taskState: t.state as TaskState, sessionStates: sessions.get(t.id) ?? [], waitActive: waiting.has(t.id) }));
    }
    return out;
  }
}
