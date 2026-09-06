import type { PauseKind, TaskIntent, RoutingProfile, TaskEnvelope, TaskId, TaskMode, TaskState } from "@agent-plane/core";
import { assertTransition, isTaskState, newTaskId, redactValue } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export interface CreateTaskInput {
  goal: string;
  constraints?: string[];
  repoPath?: string;
  profile?: RoutingProfile;
  overrides?: TaskIntent["overrides"];
}

export interface TaskRow {
  id: string;
  intent_json: string;
  pause_kind: PauseKind | null;
  goal: string;
  state: TaskState;
  activity_phase: string | null;
  profile: RoutingProfile;
  mode: TaskMode;
  repo_path: string | null;
  branch: string | null;
  /** Isolated worktree the task's runs execute in; shared across handoffs. */
  worktree_path: string | null;
  base_ref: string | null;
  envelope: string;
  created_at: string;
  updated_at: string;
}

export class TaskStore {
  constructor(private db: Db) {}

  create(input: CreateTaskInput): TaskEnvelope {
    input = redactValue(input);
    const taskId = newTaskId();
    const now = new Date().toISOString();
    const envelope: TaskEnvelope = {
      taskId,
      goal: input.goal,
      constraints: input.constraints ?? [],
      repository: input.repoPath ? { path: input.repoPath, branch: `task/${taskId}` } : undefined,
      status: { state: "CREATED" },
      completed: [],
      remaining: [],
      decisions: (input.constraints ?? []).map((c) => ({ text: c, madeBy: "user" as const, at: now })),
      artifacts: { changedFiles: [], testResults: [] },
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, goal, state, profile, repo_path, branch, envelope, intent_json, created_at, updated_at)
         VALUES (?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        input.goal,
        input.profile ?? "auto",
        input.repoPath ?? null,
        envelope.repository?.branch ?? null,
        JSON.stringify(envelope),
        JSON.stringify({ goal: input.goal, constraints: input.constraints ?? [], repository: envelope.repository, profile: input.profile ?? "auto", overrides: input.overrides } satisfies TaskIntent),
        now,
        now,
      );
    return envelope;
  }

  get(taskId: string): TaskRow | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  }

  list(): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[];
  }

  envelope(taskId: string): TaskEnvelope {
    const row = this.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    return JSON.parse(row.envelope) as TaskEnvelope;
  }

  saveEnvelope(envelope: TaskEnvelope): void {
    envelope = redactValue(envelope);
    this.db
      .prepare("UPDATE tasks SET envelope = ?, activity_phase = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(envelope), envelope.status.phase ?? null, new Date().toISOString(), envelope.taskId);
  }

  /** Guarded state transition; keeps row and envelope in sync. Returns the updated envelope. */
  transition(taskId: string, to: TaskState, pauseKind?: PauseKind): TaskEnvelope {
    const row = this.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    if (!isTaskState(row.state)) throw new Error(`Corrupt state for ${taskId}: ${row.state}`);
    assertTransition(row.state, to, row.pause_kind ?? undefined);
    if (row.state === "WAITING_RESOURCE" && to === "ROUTING") {
      if (!this.db.prepare("SELECT 1 FROM dispatches d JOIN wait_conditions w ON w.task_id = d.task_id AND w.generation = d.condition_generation WHERE d.task_id = ? AND d.phase = 'reserved' AND w.state = 'consumed'").get(taskId)) throw new Error("Only wake(generation) can release scheduler ownership");
    }
    if (to === "WAITING_RESOURCE") {
      if (row.state !== "CREATED" && row.state !== "ROUTING") throw new Error("Converting parked work is deferred to K2");
      if (this.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND ended_at IS NULL").get(taskId) ||
          this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)) throw new Error("Execution owner prevents scheduler ownership");
      if (!this.db.prepare("SELECT 1 FROM wait_conditions WHERE task_id = ? AND state = 'active'").get(taskId)) throw new Error("Active wait required");
    }
    const envelope = JSON.parse(row.envelope) as TaskEnvelope;
    envelope.status.state = to;
    this.db
      .prepare("UPDATE tasks SET state = ?, envelope = ?, pause_kind = ?, updated_at = ? WHERE id = ?")
      .run(to, JSON.stringify(envelope), to === "WAITING_INPUT" ? (pauseKind ?? "unknown") : null, new Date().toISOString(), taskId);
    return envelope;
  }

  /** Compare/race mode is set when a parallel group starts. */
  setMode(taskId: string, mode: TaskMode): void {
    this.db
      .prepare("UPDATE tasks SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, new Date().toISOString(), taskId);
  }

  /** Records the task's isolated worktree; every later run (handoffs included) reuses it. */
  setWorktree(taskId: string, worktreePath: string, branch: string, baseRef: string): void {
    const envelope = this.envelope(taskId);
    if (envelope.repository) envelope.repository.branch = branch;
    this.db
      .prepare(
        "UPDATE tasks SET branch = ?, worktree_path = ?, base_ref = ?, envelope = ?, updated_at = ? WHERE id = ?",
      )
      .run(branch, worktreePath, baseRef, JSON.stringify(envelope), new Date().toISOString(), taskId);
  }

  /** Tasks left RUNNING by a previous process (crash) — reconciled at boot. */
  runningTasks(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE state IN ('RUNNING', 'ROUTING', 'HANDING_OFF')")
      .all() as TaskRow[];
  }
}

export type { TaskId };
