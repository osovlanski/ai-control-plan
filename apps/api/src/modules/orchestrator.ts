import { join } from "node:path";
import type {
  AgentAdapter,
  AssistantId,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  TaskEnvelope,
} from "@agent-plane/core";
import { DEFAULT_REDACTION_RULES, isTaskState, isTerminal as isTerminalState, newHandoffId, redactEvent, redactText } from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import {
  createAssistantWorktree,
  createTaskBranch,
  createTaskWorktree,
  mergeWinner,
  runDiffSummary,
} from "../repo/git.js";
import { renderHandoffPrompt } from "../render/handoff.js";
import { renderTaskPrompt } from "../render/prompt.js";
import type { CheckpointReason, CheckpointService } from "./checkpoint.js";
import type { CooldownStore } from "./cooldown.js";
import type { Registry } from "./registry.js";
import { persistRoutingDecision, route, type RouteRequest } from "./router.js";
import type { TaskEventBus } from "./sse.js";
import type { TaskStore } from "./tasks.js";

interface ActiveRun {
  runId: string;
  taskId: string;
  assistantId: string;
  adapter: AgentAdapter;
  handle: RunHandle;
  timeout: ReturnType<typeof setTimeout>;
  /** Set when the provider reported a hard limit — drives failover on drain. */
  limit?: { reason: string; resetsAt?: string };
  /** Set once a soft-threshold checkpoint has been taken, so it happens once. */
  softCheckpointed?: boolean;
  /**
   * An actual provider error was observed. A run can end !ok without one — a
   * user denying an approval, for instance — and that is not a provider fault
   * to fail over from: the next assistant would just ask the same thing.
   */
  sawError?: boolean;
  /** A handoff is driving this run's end; settleRun must not finalize the task. */
  handingOff?: boolean;
}

export type StartTrigger = "initial" | "handoff";

export interface StartOptions {
  trigger?: StartTrigger;
  /** Handoff reason, rendered into the receiving agent's prompt. */
  reason?: string;
  fromAssistantId?: string;
  /**
   * This run is one competitor in a parallel group. Kept separate from the
   * worktree because a non-repo comparison (planning, research) has no
   * worktree at all — conflating them made the second competitor trip the
   * single-run guard.
   */
  parallel?: boolean;
  /** The competitor's own worktree, when the task touches a repository. */
  worktree?: { worktreePath: string; branch: string; baseRef: string };
}

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

/**
 * Run lifecycle owner. Phase 2 adds the limit monitor and the failover loop:
 * a provider limit checkpoints the task and reroutes it to the next eligible
 * assistant, which resumes from the portable handoff package (arch §8).
 */
export class Orchestrator {
  /**
   * Keyed by runId, not taskId: since Phase 5 a task may have several runs in
   * flight at once (one worktree per competing assistant).
   */
  private active = new Map<string, ActiveRun>();

  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private registry: Registry,
    private tasks: TaskStore,
    private bus: TaskEventBus,
    private checkpoints: CheckpointService,
    private cooldowns: CooldownStore,
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

  private runsOfTask(taskId: string): ActiveRun[] {
    return [...this.active.values()].filter((r) => r.taskId === taskId);
  }

  /** The sole active run, when a task has exactly one (single-mode paths). */
  private soleRun(taskId: string): ActiveRun | undefined {
    const runs = this.runsOfTask(taskId);
    return runs.length === 1 ? runs[0] : undefined;
  }

  isActive(taskId: string): boolean {
    return this.runsOfTask(taskId).length > 0;
  }

  async startTask(
    taskId: string,
    assistantId: AssistantId,
    options: StartOptions = {},
  ): Promise<{ runId: string }> {
    if (!options.parallel && this.isActive(taskId)) {
      throw new Error(`Task ${taskId} already has an active run`);
    }
    const adapter = this.registry.adapter(assistantId);
    let row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    let envelope = this.tasks.envelope(taskId);

    // Repo tasks run in an isolated worktree on branch task/<id>. A handoff
    // reuses the existing tree so the next assistant inherits the work; a
    // parallel competitor brings its own so two assistants never share one.
    let workdir = options.worktree?.worktreePath ?? row.worktree_path ?? this.config.dir;
    if (envelope.repository && !options.worktree && !row.worktree_path) {
      const worktree = await createTaskWorktree(
        envelope.repository.path,
        envelope.taskId,
        join(this.config.dir, "worktrees"),
      );
      workdir = worktree.path;
      this.tasks.setWorktree(taskId, worktree.path, worktree.branch, worktree.baseRef);
      row = this.tasks.get(taskId)!;
      envelope = this.tasks.envelope(taskId);
    }

    const prompt =
      options.trigger === "handoff"
        ? this.renderHandoffFor(taskId, envelope, options)
        : renderTaskPrompt(envelope);

    if (this.tasks.get(taskId)!.state !== "RUNNING") {
      envelope = this.tasks.transition(taskId, "RUNNING");
    }
    this.publishState(taskId, envelope, assistantId);

    // Same-provider continuation resumes the provider session; cross-provider
    // handoff always starts fresh from the rendered package (arch §7).
    const priorRef = this.resumableRef(taskId, assistantId);
    const runSpec = {
      taskId: envelope.taskId,
      prompt,
      workdir,
      // Instance policy, not a hardcoded default: a work workspace can demand
      // approval on escalation while a personal one runs broadly auto-approved.
      permissionPolicy: { mode: this.config.policy.approvalMode },
      env: { redactionRules: DEFAULT_REDACTION_RULES, maxRuntimeMs: this.maxRuntimeMs },
    };
    const handle = priorRef
      ? await adapter.resume(priorRef, runSpec)
      : await adapter.start(runSpec);

    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, assistant_id, provider_session_ref, state, started_at, worktree_path, branch)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      )
      .run(
        handle.runId,
        taskId,
        assistantId,
        handle.providerSessionRef ?? null,
        startedAt,
        options.worktree?.worktreePath ?? null,
        options.worktree?.branch ?? null,
      );

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
    this.active.set(handle.runId, run);
    void this.consume(run);
    return { runId: handle.runId };
  }

  private renderHandoffFor(taskId: string, envelope: TaskEnvelope, options: StartOptions): string {
    const checkpoint = this.checkpoints.latest(taskId);
    return renderHandoffPrompt(envelope, {
      reason: options.reason ?? "The previous assistant could not continue.",
      fromAssistantId: options.fromAssistantId,
      gitRef: checkpoint?.gitRef,
      diffStat: checkpoint?.diffStat,
      activitySummary: checkpoint?.activitySummary,
    }, DEFAULT_REDACTION_RULES);
  }

  /** A prior session on the SAME assistant that this adapter can resume. */
  private resumableRef(taskId: string, assistantId: string): ProviderSessionRef | undefined {
    if (this.registry.manifest(assistantId)?.core.canResume !== true) return undefined;
    const row = this.db
      .prepare(
        "SELECT provider_session_ref FROM runs WHERE task_id = ? AND assistant_id = ? AND provider_session_ref IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId, assistantId) as { provider_session_ref: string } | undefined;
    return row?.provider_session_ref as ProviderSessionRef | undefined;
  }

  private async consume(run: ActiveRun): Promise<void> {
    const insertEvent = this.db.prepare(
      "INSERT INTO events (run_id, seq, ts, type, phase, summary, payload, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let seq = 0;
    let endedOk: boolean | undefined;
    try {
      for await (const event of run.adapter.events(run.handle)) {
        const safeEvent = redactEvent(event, DEFAULT_REDACTION_RULES);
        seq += 1;
        insertEvent.run(
          run.runId,
          seq,
          event.ts,
          event.type,
          event.phase ?? null,
          safeEvent.summary,
          safeEvent.payload ? JSON.stringify(safeEvent.payload) : null,
          safeEvent.raw !== undefined ? JSON.stringify(safeEvent.raw) : null,
        );
        await this.applyEvent(run, safeEvent);
        this.bus.publish(run.taskId, { kind: "event", event: { ...safeEvent, seq } });
        if (event.type === "error") run.sawError = true;
        if (event.type === "run.ended") {
          endedOk = (event.payload as { ok?: boolean } | undefined)?.ok !== false;
        }
      }
    } catch (err) {
      endedOk = false;
      run.sawError = true;
      seq += 1;
      insertEvent.run(
        run.runId,
        seq,
        new Date().toISOString(),
        "error",
        null,
        redactText(err instanceof Error ? err.message : String(err), DEFAULT_REDACTION_RULES),
        null,
        null,
      );
    } finally {
      clearTimeout(run.timeout);
      this.active.delete(run.runId);
      const ok = endedOk ?? false;
      void this.settleRun(run, ok).catch(() => {
        // Settling is best-effort: a shutting-down process must not raise here.
      });
    }
  }

  /** Envelope derivation from the event stream (review §3.6: agent reports enrich, events carry). */
  private async applyEvent(run: ActiveRun, event: NormalizedEvent): Promise<void> {
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
        const payload = event.payload as { path?: string; ok?: boolean } | undefined;
        const path = payload?.path;
        // Adapters (Codex) report attempted-but-failed changes with ok:false;
        // only a change that actually landed belongs in the envelope.
        if (path && payload?.ok !== false && !envelope.artifacts.changedFiles.includes(path)) {
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
        await this.checkSoftThreshold(run, event);
        break;
      }
      case "limit.approaching": {
        this.snapshotQuota(run.assistantId, event);
        await this.checkSoftThreshold(run, event, true);
        break;
      }
      case "limit.hit": {
        this.snapshotQuota(run.assistantId, event);
        run.limit = { reason: event.summary, resetsAt: firstResetsAt(event) };
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

  /**
   * Eager checkpoint once quota crosses the soft threshold, so a hard limit
   * never catches the task with nothing saved (arch §8).
   */
  private async checkSoftThreshold(
    run: ActiveRun,
    event: NormalizedEvent,
    force = false,
  ): Promise<void> {
    if (run.softCheckpointed) return;
    const quota = quotaOf(event);
    const worst = quota?.reduce((a, b) => (a.usedPercent >= b.usedPercent ? a : b));
    if (!force && (!worst || worst.usedPercent < this.config.failover.softThresholdPct)) return;
    run.softCheckpointed = true;
    await this.checkpoints.create(run.taskId, run.runId, "limit");
    this.notice(
      run.taskId,
      "warn",
      worst
        ? `${run.assistantId} is at ${worst.usedPercent}% of its ${worst.window} quota — checkpointed early.`
        : `${run.assistantId} reported an approaching limit — checkpointed early.`,
    );
  }

  private snapshotQuota(assistantId: string, event: NormalizedEvent): void {
    const quota = quotaOf(event);
    if (!quota) return;
    const insert = this.db.prepare(
      "INSERT INTO quota_snapshots (assistant_id, window, used_percent, resets_at, source, observed_at) VALUES (?, ?, ?, ?, 'runtime-probe', ?)",
    );
    for (const q of quota) {
      insert.run(assistantId, q.window, q.usedPercent, q.resetsAt ?? null, event.ts);
    }
  }

  /** Decides what happens after a run's stream drains: finish, or fail over. */
  private async settleRun(run: ActiveRun, ok: boolean): Promise<void> {
    this.db
      .prepare("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?")
      .run(ok ? "ENDED_OK" : "ENDED_ERROR", new Date().toISOString(), run.runId);

    if (run.handingOff) return; // a handoff owns this task's next transition
    const row = this.tasks.get(run.taskId);
    if (!row || row.state !== "RUNNING") return; // cancelled, or already settled

    if (row.mode !== "single") {
      await this.settleParallelRun(row.mode, run, ok);
      return;
    }

    const limited = run.limit !== undefined;
    const shouldFailover =
      (limited && this.triggerEnabled("quota")) ||
      // Only a real provider error justifies rerouting; a user-denied approval
      // or a clean early stop is an intentional end, not a provider fault.
      (!ok && !limited && run.sawError === true && this.triggerEnabled("provider_unavailable"));

    if (shouldFailover && this.config.failover.auto) {
      await this.failover(run, limited ? "quota" : "failure");
      return;
    }

    if (limited) {
      // Failover disabled by policy: park the task rather than calling it failed.
      this.cooldowns.penalize(run.assistantId, "limit", run.limit!.reason, run.limit!.resetsAt);
      await this.checkpoints.create(run.taskId, run.runId, "limit");
      const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT");
      this.publishState(run.taskId, envelope, run.assistantId);
      this.notice(run.taskId, "warn", `${run.assistantId} hit a limit; automatic failover is off.`);
      return;
    }

    const envelope = this.tasks.transition(run.taskId, ok ? "COMPLETED" : "FAILED");
    if (ok) await this.checkpoints.create(run.taskId, run.runId, "completion");
    this.publishState(run.taskId, envelope, run.assistantId);
  }

  private triggerEnabled(trigger: string): boolean {
    const triggers = this.config.failover.triggers;
    if (trigger === "quota") return triggers.includes("quota") || triggers.includes("rate_limit");
    return triggers.includes(trigger);
  }

  /**
   * checkpoint → cooldown the source → re-route among what's left →
   * resume the task on the next best assistant, or park it (arch §8).
   */
  private async failover(run: ActiveRun, trigger: "quota" | "failure"): Promise<void> {
    const reasonText =
      trigger === "quota"
        ? (run.limit?.reason ?? `${run.assistantId} hit a usage limit`)
        : `${run.assistantId} ended with an error`;

    this.tasks.transition(run.taskId, "LIMIT_PAUSED");
    this.publishState(run.taskId, this.tasks.envelope(run.taskId), run.assistantId);

    const checkpoint = await this.checkpoints.create(run.taskId, run.runId, "handoff");
    this.cooldowns.penalize(run.assistantId, trigger === "quota" ? "limit" : "failure", reasonText, run.limit?.resetsAt);

    const explanation = this.routeFor(run.taskId, run.assistantId);
    persistRoutingDecision(this.db, run.taskId, explanation);

    if (!explanation.chosen) {
      const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT");
      this.publishState(run.taskId, envelope);
      this.notice(
        run.taskId,
        "warn",
        `${reasonText}. No other assistant is eligible right now — work is checkpointed and waiting. ${describeWaits(explanation)}`,
      );
      return;
    }

    const target = explanation.chosen;
    this.tasks.transition(run.taskId, "HANDING_OFF");
    this.publishState(run.taskId, this.tasks.envelope(run.taskId), target);
    this.notice(
      run.taskId,
      "warn",
      `${reasonText} — handing off to ${target}, continuing from the checkpoint.`,
    );

    this.db
      .prepare(
        "INSERT INTO handoffs (id, task_id, from_run_id, to_run_id, checkpoint_id, trigger, at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(newHandoffId(), run.taskId, run.runId, checkpoint.id, trigger, new Date().toISOString());

    try {
      const { runId } = await this.startTask(run.taskId, target, {
        trigger: "handoff",
        reason: reasonText,
        fromAssistantId: run.assistantId,
      });
      this.db
        .prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND to_run_id IS NULL")
        .run(runId, run.taskId);
    } catch (err) {
      const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT");
      this.publishState(run.taskId, envelope);
      this.notice(run.taskId, "warn", `Handoff to ${target} failed to start: ${message(err)}`);
    }
  }

  /** Manual handoff: checkpoint, then move the task to another assistant. */
  async handoff(taskId: string, to?: AssistantId): Promise<{ runId: string; assistantId: string }> {
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    if (isTerminal(row.state)) {
      throw new Error(
        `Task ${taskId} is ${row.state}. A finished task cannot be handed off — create a follow-up task instead.`,
      );
    }

    const current = this.soleRun(taskId);
    const fromAssistantId = current?.assistantId ?? this.lastAssistant(taskId);

    if (current) {
      // Claim the task's next transition before cancelling, so the draining
      // run does not race us into a terminal state.
      current.handingOff = true;
      await current.adapter.cancel(current.handle);
      await this.waitUntilInactive(taskId);
    }

    const checkpoint = await this.checkpoints.create(taskId, current?.runId ?? null, "handoff");

    // A manual handoff away from an assistant shouldn't immediately re-pick it.
    const explanation = this.routeFor(taskId, fromAssistantId, to);
    persistRoutingDecision(this.db, taskId, explanation);
    if (!explanation.chosen) {
      throw new Error(`No eligible assistant for handoff. ${describeWaits(explanation)}`);
    }

    const state = this.tasks.get(taskId)!.state;
    if (state === "RUNNING" || state === "WAITING_INPUT" || state === "LIMIT_PAUSED") {
      if (state === "RUNNING") this.tasks.transition(taskId, "LIMIT_PAUSED");
      this.tasks.transition(taskId, "HANDING_OFF");
    } else if (state === "CREATED") {
      this.tasks.transition(taskId, "ROUTING");
    }

    this.db
      .prepare(
        "INSERT INTO handoffs (id, task_id, from_run_id, to_run_id, checkpoint_id, trigger, at) VALUES (?, ?, ?, NULL, ?, 'manual', ?)",
      )
      .run(newHandoffId(), taskId, current?.runId ?? null, checkpoint.id, new Date().toISOString());

    this.notice(taskId, "info", `Manual handoff to ${explanation.chosen}.`);
    const { runId } = await this.startTask(taskId, explanation.chosen, {
      trigger: "handoff",
      reason: "A manual handoff was requested by the user.",
      fromAssistantId,
    });
    this.db
      .prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND to_run_id IS NULL")
      .run(runId, taskId);
    return { runId, assistantId: explanation.chosen };
  }

  /** Routing for a handoff: current cooldowns apply, plus the assistant we're leaving. */
  private routeFor(taskId: string, exclude?: string, override?: AssistantId) {
    const row = this.tasks.get(taskId)!;
    const cooldowns = this.cooldowns.active();
    if (exclude && !cooldowns.has(exclude)) cooldowns.set(exclude, "handing off from this assistant");
    const req: RouteRequest = {
      taskId,
      profile: row.profile,
      needsRepo: row.repo_path !== null,
      repoPathAllowed: this.repoAllowed(row.repo_path),
      cooldowns,
      userOverride: override,
    };
    return route(
      req,
      this.registry.list().map((a) => ({
        id: a.id as AssistantId,
        enabled: a.enabled === 1,
        manifest: a.manifestParsed,
      })),
    );
  }

  private repoAllowed(repoPath: string | null): boolean {
    return (
      !repoPath ||
      this.config.repoAllowlist.some((allowed) => repoPath === allowed || repoPath.startsWith(`${allowed}/`))
    );
  }

  private lastAssistant(taskId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(taskId) as { assistant_id: string } | undefined
    )?.assistant_id;
  }

  async createCheckpoint(taskId: string, reason: CheckpointReason = "manual") {
    return this.checkpoints.create(taskId, this.soleRun(taskId)?.runId ?? null, reason);
  }

  /**
   * Approvals carry a request id that is unique across a task's runs, so a
   * parallel comparison can have several assistants waiting at once.
   */
  async respondApproval(taskId: string, requestId: string, approved: boolean): Promise<void> {
    const runs = this.runsOfTask(taskId);
    if (runs.length === 0) throw new Error(`No active run for task ${taskId}`);
    for (const run of runs) {
      if (!run.adapter.send) continue;
      try {
        await run.adapter.send(run.handle, { kind: "approval", requestId, approved });
        return;
      } catch {
        // Not this run's pending approval; try the next competitor.
      }
    }
    throw new Error(`No run of task ${taskId} is waiting on approval ${requestId}`);
  }

  async cancelTask(taskId: string): Promise<void> {
    const runs = this.runsOfTask(taskId);
    const envelope = this.tasks.transition(taskId, "CANCELLED");
    this.publishState(taskId, envelope, runs[0]?.assistantId);
    for (const run of runs) {
      run.handingOff = true; // the task is already terminal; do not re-settle it
      await run.adapter.cancel(run.handle);
    }
    if (runs.length > 0) await this.checkpoints.create(taskId, runs[0]!.runId, "cancel");
  }

  private notice(taskId: string, level: "info" | "warn", text: string): void {
    this.bus.publish(taskId, { kind: "notice", notice: { level, text } });
  }

  private publishState(taskId: string, envelope: TaskEnvelope, assistantId?: string): void {
    this.bus.publish(taskId, {
      kind: "state",
      state: { state: envelope.status.state, phase: envelope.status.phase, assistantId },
    });
  }

  /** Cancels every active run and waits for the streams to drain (shutdown, teardown). */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.handingOff = true; // suppress settling; we are tearing down, not finishing
      try {
        await run.adapter.cancel(run.handle);
      } catch {
        // Best effort — a stuck adapter must not block shutdown.
      }
    }
    const start = Date.now();
    while (this.active.size > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async waitUntilInactive(taskId: string, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (this.isActive(taskId)) {
      if (Date.now() - start > timeoutMs) throw new Error(`Task ${taskId} still active after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Starts one run per assistant, each in its own worktree (arch §11 — never
   * two assistants in one working tree).
   *
   * compare: every competitor finishes, then the user picks a winner.
   * race:    the first competitor to succeed wins and the rest are cancelled.
   *
   * Parallel execution multiplies quota and token spend, so it is never a
   * default — the caller asks for it explicitly.
   */
  async startParallel(
    taskId: string,
    assistantIds: AssistantId[],
    mode: "compare" | "race",
  ): Promise<{ runs: Array<{ runId: string; assistantId: string }> }> {
    if (assistantIds.length < 2) throw new Error("Parallel execution needs at least two assistants");
    if (this.isActive(taskId)) throw new Error(`Task ${taskId} already has an active run`);
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    if (row.state !== "CREATED" && row.state !== "ROUTING") {
      throw new Error(`Task ${taskId} is ${row.state}; only a fresh task can start a parallel comparison`);
    }

    this.tasks.setMode(taskId, mode);
    if (row.state === "CREATED") this.tasks.transition(taskId, "ROUTING");
    const envelope = this.tasks.envelope(taskId);

    // A shared base branch, then one branch + worktree per competitor off it,
    // so the diffs are directly comparable and the winner merges cleanly.
    const worktrees = new Map<string, { worktreePath: string; branch: string; baseRef: string }>();
    if (envelope.repository) {
      const { branch: base, baseRef } = await createTaskBranch(envelope.repository.path, taskId);
      this.tasks.setWorktree(taskId, row.worktree_path ?? "", base, baseRef);
      for (const assistantId of assistantIds) {
        const wt = await createAssistantWorktree(
          envelope.repository.path,
          taskId,
          assistantId,
          join(this.config.dir, "worktrees"),
          base,
        );
        worktrees.set(assistantId, { worktreePath: wt.path, branch: wt.branch, baseRef: wt.baseRef });
      }
    }

    const started: Array<{ runId: string; assistantId: string }> = [];
    for (const assistantId of assistantIds) {
      const { runId } = await this.startTask(taskId, assistantId, {
        parallel: true,
        worktree: worktrees.get(assistantId),
      });
      started.push({ runId, assistantId });
    }
    this.notice(
      taskId,
      "info",
      `${mode === "race" ? "Racing" : "Comparing"} ${assistantIds.join(" vs ")} in separate worktrees.`,
    );
    return { runs: started };
  }

  /** A competitor finished. Decide whether the task itself is done. */
  private async settleParallelRun(mode: string, run: ActiveRun, ok: boolean): Promise<void> {
    const siblingsRunning = this.runsOfTask(run.taskId).length > 0;

    if (mode === "race" && ok) {
      // First success takes it; the rest are cancelled to stop burning quota.
      this.db.prepare("UPDATE runs SET outcome = 'winner' WHERE id = ?").run(run.runId);
      for (const other of this.runsOfTask(run.taskId)) {
        other.handingOff = true;
        this.db.prepare("UPDATE runs SET outcome = 'rejected' WHERE id = ?").run(other.runId);
        await other.adapter.cancel(other.handle);
      }
      await this.finishComparison(run.taskId, run.runId, "race", `${run.assistantId} finished first`);
      return;
    }

    if (siblingsRunning) return; // others still working; nothing to decide yet

    if (mode === "race") {
      // Everyone failed: treat it as a normal failed task rather than a stall.
      const envelope = this.tasks.transition(run.taskId, "FAILED");
      this.publishState(run.taskId, envelope, run.assistantId);
      this.notice(run.taskId, "warn", "Every racing assistant failed.");
      return;
    }

    // compare: all competitors are done — the user decides.
    await this.checkpoints.create(run.taskId, run.runId, "completion");
    const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT");
    this.publishState(run.taskId, envelope);
    this.notice(run.taskId, "info", "All competitors finished — review the comparison and pick a winner.");
  }

  /** Side-by-side view of a comparison: diff size, tests, duration, tokens. */
  async comparison(taskId: string): Promise<{
    mode: string;
    decided: { winnerRunId: string | null; decidedBy: string; mergedRef: string | null; at: string } | null;
    competitors: Array<Record<string, unknown>>;
  }> {
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    const runs = this.db
      .prepare(
        `SELECT id, assistant_id, state, usage, started_at, ended_at, worktree_path, branch, outcome
         FROM runs WHERE task_id = ? ORDER BY started_at`,
      )
      .all(taskId) as Array<{
      id: string;
      assistant_id: string;
      state: string;
      usage: string | null;
      started_at: string;
      ended_at: string | null;
      worktree_path: string | null;
      branch: string | null;
      outcome: string | null;
    }>;

    const competitors = await Promise.all(
      runs.map(async (r) => {
        const tests = this.db
          .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'test.result' ORDER BY seq DESC LIMIT 1")
          .get(r.id) as { payload: string | null } | undefined;
        let diff: { diffStat: string; changedFiles: string[]; insertions: number; deletions: number } | null = null;
        if (r.worktree_path && row.base_ref) {
          diff = await runDiffSummary(r.worktree_path, row.base_ref).catch(() => null);
        }
        return {
          runId: r.id,
          assistantId: r.assistant_id,
          state: r.state,
          outcome: r.outcome,
          branch: r.branch,
          durationMs: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null,
          usage: r.usage ? (JSON.parse(r.usage) as unknown) : null,
          tests: tests?.payload ? (JSON.parse(tests.payload) as unknown) : null,
          diff,
        };
      }),
    );

    const decision = this.db
      .prepare("SELECT winner_run_id, decided_by, merged_ref, at FROM comparisons WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(taskId) as
      | { winner_run_id: string | null; decided_by: string; merged_ref: string | null; at: string }
      | undefined;

    return {
      mode: row.mode,
      decided: decision
        ? {
            winnerRunId: decision.winner_run_id,
            decidedBy: decision.decided_by,
            mergedRef: decision.merged_ref,
            at: decision.at,
          }
        : null,
      competitors,
    };
  }

  /** The user picks a winner; its branch merges into the shared task branch. */
  async resolveComparison(taskId: string, winnerRunId: string, reason?: string): Promise<{ mergedRef: string | null }> {
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    if (row.state !== "WAITING_INPUT") {
      throw new Error(`Task ${taskId} is ${row.state}; only a finished comparison can be resolved`);
    }
    const winner = this.db.prepare("SELECT id, branch FROM runs WHERE id = ? AND task_id = ?").get(winnerRunId, taskId) as
      | { id: string; branch: string | null }
      | undefined;
    if (!winner) throw new Error(`Run ${winnerRunId} is not part of task ${taskId}`);
    return this.finishComparison(taskId, winnerRunId, "user", reason);
  }

  private async finishComparison(
    taskId: string,
    winnerRunId: string,
    decidedBy: "user" | "race",
    reason?: string,
  ): Promise<{ mergedRef: string | null }> {
    this.db.prepare("UPDATE runs SET outcome = 'winner' WHERE id = ?").run(winnerRunId);
    this.db
      .prepare("UPDATE runs SET outcome = 'rejected' WHERE task_id = ? AND id != ? AND outcome IS NULL")
      .run(taskId, winnerRunId);

    const envelope = this.tasks.envelope(taskId);
    const winner = this.db.prepare("SELECT branch, assistant_id FROM runs WHERE id = ?").get(winnerRunId) as
      | { branch: string | null; assistant_id: string }
      | undefined;

    let mergedRef: string | null = null;
    if (envelope.repository && winner?.branch) {
      // Losing branches are left intact so a rejected attempt stays inspectable.
      mergedRef = (await mergeWinner(envelope.repository.path, envelope.repository.branch, winner.branch).catch(
        () => null,
      ))?.mergedRef ?? null;
    }

    this.db
      .prepare("INSERT INTO comparisons (task_id, winner_run_id, decided_by, reason, merged_ref, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(taskId, winnerRunId, decidedBy, reason ?? null, mergedRef, new Date().toISOString());

    const updated = this.tasks.transition(taskId, "COMPLETED");
    this.publishState(taskId, updated, winner?.assistant_id);
    this.notice(
      taskId,
      "info",
      `${winner?.assistant_id ?? "winner"} selected${mergedRef ? ` and merged into ${envelope.repository?.branch}` : ""}.`,
    );
    return { mergedRef };
  }

  /**
   * Waits until the task reaches a resting state — terminal, or parked waiting
   * for the user. Spans failover, where one run ends and another begins.
   */
  async waitForSettled(taskId: string, timeoutMs = 15_000): Promise<string> {
    const resting = new Set(["COMPLETED", "FAILED", "CANCELLED", "WAITING_INPUT"]);
    const start = Date.now();
    for (;;) {
      const row = this.tasks.get(taskId);
      if (row && resting.has(row.state) && !this.isActive(taskId)) return row.state;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Task ${taskId} did not settle in ${timeoutMs}ms (state ${row?.state})`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

function quotaOf(
  event: NormalizedEvent,
): Array<{ window: string; usedPercent: number; resetsAt?: string }> | undefined {
  const quota = (
    event.payload as { quota?: Array<{ window: string; usedPercent: number; resetsAt?: string }> } | undefined
  )?.quota;
  return quota && quota.length > 0 ? quota : undefined;
}

function firstResetsAt(event: NormalizedEvent): string | undefined {
  return quotaOf(event)?.find((q) => q.resetsAt)?.resetsAt;
}

function describeWaits(explanation: { candidates: Array<{ assistantId: string; filterFailures: string[] }> }): string {
  const blocked = explanation.candidates
    .filter((c) => c.filterFailures.length > 0)
    .map((c) => `${c.assistantId}: ${c.filterFailures.join(", ")}`);
  return blocked.length > 0 ? `Blocked — ${blocked.join("; ")}.` : "";
}

/**
 * Rolling tail of activity summaries (envelope "completed" hints), de-duplicated
 * against the whole list rather than just the last entry: after a handoff the
 * next assistant narrates the same steps again, and a package that accumulates
 * those repeats gets worse with every hop.
 */
function mergeTail(list: string[], entry: string, max = 20): string[] {
  if (list.includes(entry)) return list;
  const next = [...list, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

function isTerminal(state: string): boolean {
  return isTaskState(state) && isTerminalState(state);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
