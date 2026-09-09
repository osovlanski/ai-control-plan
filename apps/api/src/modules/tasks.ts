import type { PauseKind, TaskIntent, RoutingProfile, TaskEnvelope, TaskId, TaskMode, TaskState } from "@agent-plane/core";
import { assertTransition, isTaskState, isTerminal, newTaskId, redactValue } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export interface CreateTaskInput {
  goal: string;
  constraints?: string[];
  repoPath?: string;
  profile?: RoutingProfile;
  overrides?: TaskIntent["overrides"];
  /** Declared hard requirements — a minimum context window excludes candidates (K13). */
  requirements?: TaskIntent["requirements"];
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

  /**
   * Set by the Scheduler. Fires after a task reaches a terminal state so K4
   * dependency waits wake on the event rather than on the timer. The handler
   * defers its own work to a microtask, which runs after the enclosing
   * (synchronous) transaction has committed.
   */
  onTerminal?: (taskId: string) => void;

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
        JSON.stringify({ goal: input.goal, constraints: input.constraints ?? [], repository: envelope.repository, profile: input.profile ?? "auto", overrides: input.overrides, requirements: input.requirements } satisfies TaskIntent),
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
      if (this.db.prepare(`SELECT 1 FROM runs r WHERE task_id = ? AND execution_request_id IS NOT NULL AND
        (session_state NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED') OR NOT EXISTS (SELECT 1 FROM execution_results e WHERE e.session_id = r.id))`).get(taskId)) throw new Error('Predecessor session must be settled');
      if (this.db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND ended_at IS NULL").get(taskId) ||
          this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)) throw new Error("Execution owner prevents scheduler ownership");
      const wait = this.db.prepare("SELECT checkpoint_id FROM wait_conditions WHERE task_id = ? AND state = 'active'").get(taskId) as { checkpoint_id: string | null } | undefined;
      if (!wait) throw new Error('Active wait required');
      const predecessor = this.db.prepare('SELECT id FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(taskId) as { id: string } | undefined;
      if (predecessor && !this.db.prepare('SELECT 1 FROM checkpoints WHERE id = ? AND task_id = ? AND run_id = ?').get(wait.checkpoint_id, taskId, predecessor.id)) throw new Error('Wait requires a checkpoint from the settled predecessor');
    }
    const envelope = JSON.parse(row.envelope) as TaskEnvelope;
    envelope.status.state = to;
    this.db
      .prepare("UPDATE tasks SET state = ?, envelope = ?, pause_kind = ?, updated_at = ? WHERE id = ?")
      .run(to, JSON.stringify(envelope), to === "WAITING_INPUT" ? (pauseKind ?? "unknown") : null, new Date().toISOString(), taskId);
    if (isTerminal(to)) this.onTerminal?.(taskId);
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
