import { join } from "node:path";
import type {
  AgentAdapter,
  AssistantId,
  NormalizedEvent,
  RunHandle,
  TaskEnvelope,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { createTaskWorktree } from "../repo/git.js";
import { renderTaskPrompt } from "../render/prompt.js";
import type { Registry } from "./registry.js";
import type { TaskEventBus } from "./sse.js";
import type { TaskStore } from "./tasks.js";

interface ActiveRun {
  runId: string;
  taskId: string;
  assistantId: string;
  adapter: AgentAdapter;
  handle: RunHandle;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

/**
 * Run lifecycle owner: starts adapter runs, ingests + persists normalized
 * events, derives envelope progress from the stream, relays approvals, and
 * enforces the runtime cap. Limit events are recorded and snapshotted in
 * Phase 1; automatic failover consumes them in Phase 2.
 */
export class Orchestrator {
  private active = new Map<string, ActiveRun>(); // keyed by taskId

  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private registry: Registry,
    private tasks: TaskStore,
    private bus: TaskEventBus,
    private maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  ) {}

  /** Crash recovery (arch §5): tasks left in-flight by a dead process are failed with a record. */
  reconcileOnBoot(): number {
    let reconciled = 0;
    for (const row of this.tasks.runningTasks()) {
      try {
        this.tasks.transition(row.id, "FAILED");
      } catch {
        continue;
      }
      this.db
        .prepare("UPDATE runs SET state = 'ENDED_ERROR', ended_at = ? WHERE task_id = ? AND ended_at IS NULL")
        .run(new Date().toISOString(), row.id);
      reconciled += 1;
    }
    return reconciled;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async startTask(taskId: string, assistantId: AssistantId): Promise<{ runId: string }> {
    if (this.active.has(taskId)) throw new Error(`Task ${taskId} already has an active run`);
    const adapter = this.registry.adapter(assistantId);
    let envelope = this.tasks.envelope(taskId);

    // Repo tasks get an isolated worktree on branch task/<id>; the prompt runs there.
    let workdir = this.config.dir;
    if (envelope.repository) {
      const worktree = await createTaskWorktree(
        envelope.repository.path,
        envelope.taskId,
        join(this.config.dir, "worktrees"),
      );
      workdir = worktree.path;
      this.tasks.setBranch(taskId, worktree.branch);
      envelope = this.tasks.envelope(taskId);
    }

    envelope = this.tasks.transition(taskId, "RUNNING");
    this.publishState(taskId, envelope, assistantId);

    const handle = await adapter.start({
      taskId: envelope.taskId,
      prompt: renderTaskPrompt(envelope),
      workdir,
      permissionPolicy: { mode: "prompt-on-escalation" },
      env: { redactionRules: [], maxRuntimeMs: this.maxRuntimeMs },
    });

    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO runs (id, task_id, assistant_id, provider_session_ref, state, started_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)",
      )
      .run(handle.runId, taskId, assistantId, handle.providerSessionRef ?? null, startedAt);

    const run: ActiveRun = {
      runId: handle.runId,
      taskId,
      assistantId,
      adapter,
      handle,
      timeout: setTimeout(() => {
        void adapter.cancel(handle);
      }, this.maxRuntimeMs),
    };
    this.active.set(taskId, run);
    void this.consume(run);
    return { runId: handle.runId };
  }

  private async consume(run: ActiveRun): Promise<void> {
    const insertEvent = this.db.prepare(
      "INSERT INTO events (run_id, seq, ts, type, phase, summary, payload, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let seq = 0;
    let endedOk: boolean | undefined;
    try {
      for await (const event of run.adapter.events(run.handle)) {
        seq += 1;
        insertEvent.run(
          run.runId,
          seq,
          event.ts,
          event.type,
          event.phase ?? null,
          event.summary,
          event.payload ? JSON.stringify(event.payload) : null,
          event.raw !== undefined ? JSON.stringify(event.raw) : null,
        );
        this.applyEvent(run, event);
        this.bus.publish(run.taskId, { kind: "event", event: { ...event, seq } });
        if (event.type === "run.ended") {
          endedOk = (event.payload as { ok?: boolean } | undefined)?.ok !== false;
        }
      }
    } catch (err) {
      endedOk = false;
      seq += 1;
      insertEvent.run(
        run.runId,
        seq,
        new Date().toISOString(),
        "error",
        null,
        err instanceof Error ? err.message : String(err),
        null,
        null,
      );
    } finally {
      clearTimeout(run.timeout);
      this.active.delete(run.taskId);
      this.finishRun(run, endedOk ?? false);
    }
  }

  /** Envelope derivation from the event stream (review §3.6: agent reports enrich, events carry). */
  private applyEvent(run: ActiveRun, event: NormalizedEvent): void {
    const envelope = this.tasks.envelope(run.taskId);
    let changed = false;

    if (event.phase && envelope.status.phase !== event.phase) {
      envelope.status.phase = event.phase;
      changed = true;
    }
    switch (event.type) {
      case "run.started": {
        const ref = (event.payload as { providerSessionRef?: string } | undefined)?.providerSessionRef;
        if (ref) {
          this.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(ref, run.runId);
        }
        break;
      }
      case "file.changed": {
        const path = (event.payload as { path?: string } | undefined)?.path;
        if (path && !envelope.artifacts.changedFiles.includes(path)) {
          envelope.artifacts.changedFiles.push(path);
          changed = true;
        }
        break;
      }
      case "test.result": {
        const p = event.payload as { passed?: number; failed?: number } | undefined;
        envelope.artifacts.testResults.push({
          at: event.ts,
          passed: p?.passed ?? 0,
          failed: p?.failed ?? 0,
        });
        changed = true;
        break;
      }
      case "usage.updated": {
        this.db.prepare("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(event.payload ?? {}), run.runId);
        this.snapshotQuota(run.assistantId, event);
        break;
      }
      case "limit.approaching":
      case "limit.hit": {
        this.snapshotQuota(run.assistantId, event);
        break;
      }
      case "message": {
        const text = (event.payload as { text?: string } | undefined)?.text;
        if (text) {
          envelope.nextAction = undefined;
          envelope.completed = mergeTail(envelope.completed, event.summary);
          changed = true;
        }
        break;
      }
      default:
        break;
    }
    if (changed) this.tasks.saveEnvelope(envelope);
  }

  private snapshotQuota(assistantId: string, event: NormalizedEvent): void {
    const quota = (event.payload as { quota?: Array<{ window: string; usedPercent: number; resetsAt?: string }> } | undefined)
      ?.quota;
    if (!quota) return;
    const insert = this.db.prepare(
      "INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at) VALUES (?, ?, ?, ?, 'runtime-probe', ?)",
    );
    for (const q of quota) {
      insert.run(assistantId, q.window, q.usedPercent, q.resetsAt ?? null, event.ts);
    }
  }

  private finishRun(run: ActiveRun, ok: boolean): void {
    this.db
      .prepare("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?")
      .run(ok ? "ENDED_OK" : "ENDED_ERROR", new Date().toISOString(), run.runId);

    const row = this.tasks.get(run.taskId);
    if (!row) return;
    // Cancellation transitions the task itself before the stream drains.
    if (row.state === "RUNNING") {
      const envelope = this.tasks.transition(run.taskId, ok ? "COMPLETED" : "FAILED");
      this.publishState(run.taskId, envelope, run.assistantId);
    }
  }

  async respondApproval(taskId: string, requestId: string, approved: boolean): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) throw new Error(`No active run for task ${taskId}`);
    if (!run.adapter.send) throw new Error(`Assistant ${run.assistantId} does not accept input`);
    await run.adapter.send(run.handle, { kind: "approval", requestId, approved });
  }

  async cancelTask(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    const envelope = this.tasks.transition(taskId, "CANCELLED");
    this.publishState(taskId, envelope, run?.assistantId);
    if (run) await run.adapter.cancel(run.handle);
  }

  private publishState(taskId: string, envelope: TaskEnvelope, assistantId?: string): void {
    this.bus.publish(taskId, {
      kind: "state",
      state: { state: envelope.status.state, phase: envelope.status.phase, assistantId },
    });
  }

  /** Await the active run's stream drain — used by tests and graceful shutdown. */
  async waitForIdle(taskId: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (this.active.has(taskId)) {
      if (Date.now() - start > timeoutMs) throw new Error(`Task ${taskId} still active after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Keep a rolling, de-duplicated tail of activity summaries (envelope "completed" hints). */
function mergeTail(list: string[], entry: string, max = 20): string[] {
  if (list.at(-1) === entry) return list;
  const next = [...list, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}
