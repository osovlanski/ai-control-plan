import { SessionStore } from './harness/session-store.js';
import { HandoffService } from './harness/handoff.js';
import { buildExecutionRequest } from './harness/control-plane-bridge.js';
import type { ExecutionRequest } from '@agent-plane/core';
import { QuotaProjection, controllingRetry } from './quota.js';
import type { Scheduler } from './scheduler.js';
import { join } from "node:path";
import type {
  Continuation,
  QuotaBlocker,
  TaskIntent,
  PauseKind,
  AgentAdapter,
  AssistantId,
  ExecutionResult,
  ExecutionSessionState,
  ExecutionTarget,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  TaskEnvelope,
  TaskState,
} from "@agent-plane/core";
import {
  DEFAULT_REDACTION_RULES,
  isSessionTerminal,
  isTaskState,
  isTerminal as isTerminalState,
  newHandoffId,
  redactEvent,
  redactText,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { RepositoryIdentityRegistry } from "../repo/identity-registry.js";
import {
  createAssistantWorktree,
  createTaskBranch,
  createTaskWorktree,
  mergeWinner,
  runDiffSummary,
} from "../repo/git.js";
import { renderCommittedHandoff, renderHandoffPrompt } from "../render/handoff.js";
import { renderTaskPrompt } from "../render/prompt.js";
import type { CheckpointReason, CheckpointService } from "./checkpoint.js";
import type { HarnessBridge } from "./harness/control-plane-bridge.js";
import { deriveEnvelopeUpdate } from "./harness/envelope-derivation.js";
import { quotaOf, snapshotQuota } from "./harness/quota-snapshot.js";
import { effectiveStateSql, effectiveUsageJoin, effectiveUsageSql } from "./harness/state-vocab.js";
import type { CooldownStore } from "./cooldown.js";
import type { Registry } from "./registry.js";
import { persistRoutingDecision, routeTask } from "./router.js";
import type { TaskEventBus } from "./sse.js";
import type { TaskStore } from "./tasks.js";
import type { ProjectVerificationDiscovery } from "./project-verification.js";

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
  continuation?: Continuation;
  dispatchId?: string;
  beforeStart?: () => Promise<void>;
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
  /**
   * routing_decisions row id for THIS start (from `computeRoute` / failover /
   * manual handoff). Flag-ON `startTask` threads it into the ExecutionRequest;
   * absent ⇒ a fresh minimal decision is persisted (PLAN.md 8c.5).
   */
  routingDecisionRef?: string;
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
  scheduler?: Scheduler;
  quotaPlan(taskId: string, attempt = 0) {
    const intent = JSON.parse(this.tasks.get(taskId)!.intent_json) as TaskIntent;
    const candidates = this.registry.list().filter(a => a.enabled && a.manifestParsed &&
      (!intent.overrides?.assistantId || intent.overrides.assistantId === a.id) &&
      (!intent.repository || (a.manifestParsed.core.execution.filesystem && a.manifestParsed.core.execution.shell &&
        this.config.repoAllowlist.some(p => intent.repository!.path === p || intent.repository!.path.startsWith(`${p}/`)))));
    const eligible = candidates.filter(a => a.manifestParsed!.core.auth.state === 'ok');
    const projections = eligible.map(a => ({ id: a.id, ...new QuotaProjection(this.db, this.now).for(a.id, a.manifestParsed, attempt) }));
    const blockers = projections.flatMap(p => p.blockers);
    const interventions: QuotaBlocker[] = candidates.filter(a => a.manifestParsed!.core.auth.state !== 'ok').map(a => ({
      assistantId: a.id as AssistantId, kind: 'intervention-required', scope: { account: a.manifestParsed!.core.auth.account },
      source: 'local-config', observedAt: a.manifest_updated_at ?? this.now().toISOString(), retryAt: this.now().toISOString(),
      resetProvenance: 'fallback', reason: `auth ${a.manifestParsed!.core.auth.state}`,
    }));
    return { blockers: [...blockers, ...interventions], notBefore: controllingRetry(blockers, projections.map(p => p.id)),
      interventionRequired: eligible.length === 0 && interventions.length > 0 };
  }

  constructor(
    private db: Db,
    private config: ResolvedConfig,
    private registry: Registry,
    private tasks: TaskStore,
    private bus: TaskEventBus,
    private checkpoints: CheckpointService,
    private cooldowns: CooldownStore,
    private maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
    /**
     * Execution-Harness boot reconcile (execution-harness §9). When present it
     * decides every live Harness session's fate (resume-offer / orphan+checkpoint
     * / complete-from-verifying) BEFORE the legacy blanket fail-all below, which
     * is then scoped to legacy `runs` rows only. `quarantineSession` forcibly
     * terminalises a session regardless of mode (increment 3, mixed ownership).
     */
    private harnessRecovery?: { reconcileOnBoot(): Promise<unknown>; quarantineSession(sessionId: string): Promise<unknown> },
    /**
     * Single-mode seam to `SessionRunner` (PLAN.md 8c). Injected by `buildServer`
     * for every internal composition root (increment 3, D6) — its presence does
     * NOT mean routing is on. `harnessRouting()` gates new starts on
     * `config.execution.harnessModes.single`; `harnessOwns()` keeps an
     * already-started session on the Harness branch regardless of the flag.
     */
    private harnessBridge?: HarnessBridge,
    /** Authority-backed project snapshot + pure planner adapter, injected by the composition root. */
    private projectVerification?: (worktreePath: string) => ProjectVerificationDiscovery,
    /** Control Plane-owned stable identity resolver; only used for repository-backed Harness requests. */
    private repositoryIdentities?: Pick<RepositoryIdentityRegistry, "resolve">,
    /** Kernel clock; every quota/freshness read goes through it (K1-K3 share one clock). */
    private now: () => Date = () => new Date(),
  ) {}

  /** `harnessModes.single` routing applies to this start (non-parallel, non-compare/race). */
  private harnessRouting(taskId: string, options: StartOptions): boolean {
    if (options.dispatchId) {
      const dispatch = this.db.prepare('SELECT execution_path FROM dispatches WHERE dispatch_id = ?').get(options.dispatchId) as { execution_path: string } | undefined;
      if (dispatch?.execution_path === 'harness' && !this.harnessBridge) throw new Error('Harness dispatch requires the Harness bridge');
      return dispatch?.execution_path === 'harness';
    }
    if (!this.config.execution?.harnessModes?.single || !this.harnessBridge) return false;
    if (options.parallel) return false;
    const mode = this.tasks.get(taskId)?.mode;
    return mode !== "compare" && mode !== "race";
  }

  /**
   * The newest `runs` row for the task is a Harness session — so every control
   * op stays on the Harness branch through the post-terminal / pre-settle
   * window (PLAN.md R1 #12).
   */
  private harnessOwns(taskId: string): boolean {
    if (!this.harnessBridge) return false;
    const row = this.db
      .prepare("SELECT execution_request_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as { execution_request_id: string | null } | undefined;
    return !!row && row.execution_request_id !== null;
  }

  private hasLiveLegacyRun(taskId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM runs WHERE task_id = ? AND execution_request_id IS NULL AND ended_at IS NULL LIMIT 1")
      .get(taskId);
  }

  private hasLiveHarnessSession(taskId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL
           AND session_state NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED') LIMIT 1`,
      )
      .get(taskId);
  }

  /**
   * A task with both a live legacy run and a live Harness session is an
   * ambiguity `harnessOwns()`'s newest-row heuristic cannot resolve safely
   * (increment 3, §2 step 16). Interactive control ops refuse it; the boot
   * sweep quarantines it instead (never aborts — see `reconcileOnBoot`).
   */
  private assertNoMixedOwnership(taskId: string): void {
    const conflicting = this.db.prepare(`SELECT 1 FROM dispatches d JOIN runs r ON r.task_id = d.task_id
      WHERE d.task_id = ? AND d.phase IN ('reserved','start_attempted') AND r.ended_at IS NULL
      AND (r.dispatch_id IS NULL OR r.dispatch_id != d.dispatch_id)`).get(taskId);
    if (conflicting || (this.hasLiveLegacyRun(taskId) && this.hasLiveHarnessSession(taskId))) {
      throw new Error(`Task ${taskId} has mixed live ownership (legacy/Harness or unrelated dispatch/session)`);
    }
  }

  /** Crash recovery (arch §5): tasks left in-flight by a dead process are failed with a record. */
  async reconcileOnBoot(): Promise<number> {
    // Step 1 — per-session Harness recovery (§9): decides every live Harness
    // session (resume-offer / orphan+checkpoint / complete-from-verifying),
    // writing a terminal execution_results row for the settled cases.
    await this.harnessRecovery?.reconcileOnBoot();

    // Step 1.5 — mixed-live-ownership quarantine (increment 3, §2 step 16),
    // BEFORE the Harness sweep. A task with both a live legacy run and a live
    // Harness session is an ambiguity `harnessOwns()`'s newest-row heuristic
    // cannot resolve safely. Quarantine it — terminalise the Harness session,
    // fail the task — and CONTINUE reconciling every other task: a boot-wide
    // throw here would strand unrelated sessions, the exact failure the
    // rollback guarantee must not have.
    if (this.harnessBridge && this.harnessRecovery) {
      for (const row of this.tasks.runningTasks()) {
        if (!this.hasLiveLegacyRun(row.id) || !this.hasLiveHarnessSession(row.id)) continue;
        const sid = this.harnessBridge.latestSessionId(row.id);
        try {
          if (sid) await this.harnessRecovery.quarantineSession(sid);
          this.tasks.transition(row.id, "FAILED");
          this.db
            .prepare(
              "UPDATE runs SET state = 'ENDED_ERROR', ended_at = ? WHERE task_id = ? AND ended_at IS NULL AND execution_request_id IS NULL",
            )
            .run(new Date().toISOString(), row.id);
        } catch (err) {
          this.notice(row.id, "warn", `mixed-ownership quarantine failed to settle cleanly: ${message(err)}`);
        }
      }
    }

    // Step 2 — Harness in-flight sweep, BEFORE the legacy blanket-fail
    // (PLAN.md 8c.3, Codex R4/R5). Over every in-flight task state
    // runningTasks() returns (RUNNING / ROUTING / HANDING_OFF):
    if (this.harnessBridge) {
      for (const row of this.tasks.runningTasks()) {
        if (!this.harnessOwns(row.id)) continue;
        if (this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted') AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.dispatch_id = dispatches.dispatch_id)").get(row.id)) continue;
        const sid = this.harnessBridge.latestSessionId(row.id);
        const assistantId = this.lastAssistant(row.id) ?? "";
        const result = sid ? this.harnessBridge.result(sid) : undefined;
        if (result) {
          await this.settleFromResult(row.id, assistantId, sid!, result);
        } else {
          // Crashed mid-ROUTING/HANDING_OFF, or a resume_offered session this
          // pass cannot act on — park, never leave in an in-flight state, never
          // blanket-fail (same shape as settleFromResult(..., null)).
          try {
            const envelope = this.tasks.transition(row.id, "WAITING_INPUT", "harness_error");
            this.publishState(row.id, envelope);
            this.notice(
              row.id,
              "warn",
              `execution harness task recovered at boot in ${row.state} with no terminal session result — manual restart required`,
            );
          } catch {
            // already moved on by step 1 / a concurrent settle
          }
        }
      }
    }

    // Step 3 — legacy blanket-fail, scoped to legacy-owned tasks at BOTH the
    // task-transition level and the runs UPDATE (a Harness-owned task is handled
    // by step 2 and is never stomped here).
    let reconciled = 0;
    for (const row of this.tasks.runningTasks()) {
      if (this.harnessOwns(row.id)) continue;
      if (this.db.prepare(`SELECT 1 FROM dispatches d WHERE d.task_id = ? AND d.phase IN ('reserved','start_attempted')
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.dispatch_id = d.dispatch_id)`).get(row.id)) continue;
      try {
        this.tasks.transition(row.id, "FAILED");
      } catch {
        continue;
      }
      this.db
        .prepare(
          "UPDATE runs SET state = 'ENDED_ERROR', ended_at = ? WHERE task_id = ? AND ended_at IS NULL AND execution_request_id IS NULL",
        )
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
    return this.runsOfTask(taskId).length > 0 || this.harnessBridge?.liveSessionId(taskId) !== undefined;
  }

  async startTask(
    taskId: string,
    assistantId: AssistantId,
    options: StartOptions = {},
  ): Promise<{ runId: string }> {
    if (!options.parallel && this.isActive(taskId)) {
      throw new Error(`Task ${taskId} already has an active run`);
    }
    if (options.dispatchId) {
      const saved = this.db.prepare('SELECT request_json FROM execution_requests WHERE id = ? AND superseded = 0').get(options.dispatchId) as { request_json: string | null } | undefined;
      if (saved?.request_json) {
        const request = JSON.parse(saved.request_json) as ExecutionRequest;
        request.runSpec.prompt = this.dispatchPrompt(request, options);
        new SessionStore(this.db).recordRequest(request); // fingerprint witnesses semantic replay
        return this.executeDispatch(request, options);
      }
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
      options.continuation?.kind === "checkpoint"
        ? this.renderHandoffFor(taskId, options)
        : renderTaskPrompt(envelope);

    let executionTarget: ExecutionTarget | undefined;
    if (this.harnessRouting(taskId, options) && envelope.repository && this.repositoryIdentities) {
      const identity = await this.repositoryIdentities.resolve(workdir);
      executionTarget = {
        kind: "worktree",
        workspaceId: identity.workspaceId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      };
      if (identity.remoteConflict) {
        this.notice(taskId, "warn", "repository identity remote conflict observed; retained existing stable identity");
      }
    }

    if (options.dispatchId) {
      const dispatch = this.db.prepare("SELECT phase FROM dispatches WHERE dispatch_id = ? AND task_id = ?").get(options.dispatchId, taskId) as { phase: string } | undefined;
      if (this.tasks.get(taskId)?.state !== "ROUTING" || dispatch?.phase !== "reserved" && dispatch?.phase !== "start_attempted") throw new Error("Dispatch cancelled or no longer owns task");
    } else if (this.tasks.get(taskId)?.state === "WAITING_RESOURCE" || this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)) {
      throw new Error("Scheduler owns this task; use generation-aware run-now");
    }

    if (!options.dispatchId && this.tasks.get(taskId)!.state !== "RUNNING") {
      envelope = this.tasks.transition(taskId, "RUNNING");
    }
    this.publishState(taskId, envelope, assistantId);

    if (options.dispatchId) {
      const taskRow = this.tasks.get(taskId)!;
      const attempt = ((this.db.prepare('SELECT MAX(attempt) m FROM execution_requests WHERE task_id = ?').get(taskId) as { m: number | null }).m ?? 0) + 1;
      const project = envelope.repository && this.projectVerification ? this.projectVerification(workdir) : undefined;
      const request = buildExecutionRequest({ taskId, dispatchId: options.dispatchId, assistantId, attempt, prompt, workdir,
        worktree: envelope.repository ? { repoPath: envelope.repository.path, branch: taskRow.branch ?? envelope.repository.branch, worktreePath: workdir, baseRef: taskRow.base_ref ?? 'HEAD' } : undefined,
        target: executionTarget, approvalMode: this.config.policy.approvalMode, maxRuntimeMs: this.maxRuntimeMs,
        routingDecisionRef: options.routingDecisionRef!, verificationPlan: project?.plan });
      this.db.transaction(() => {
        const d = this.db.prepare('SELECT phase FROM dispatches WHERE dispatch_id = ?').get(options.dispatchId) as { phase: string };
        if (d.phase !== 'reserved' || this.tasks.get(taskId)?.state !== 'ROUTING') throw new Error('Dispatch no longer owns materialization');
        const store = new SessionStore(this.db);
        const insert = () => {
          store.recordRequest(request);
          this.db.prepare('UPDATE execution_requests SET request_json = ? WHERE id = ?').run(JSON.stringify({ ...request, runSpec: { ...request.runSpec, prompt: undefined, secretEnv: undefined } }), request.executionRequestId);
        };
        if (options.continuation?.kind === 'checkpoint' && this.harnessRouting(taskId, options)) {
          // The checkpoint snapshot is the same immutable source the envelope is derived from.
          new HandoffService(this.db).bindSuccessor(options.continuation.checkpointId, request,
            { reason: 'quota wake', fromAssistantId: this.lastAssistant(taskId) ?? assistantId, insertRequest: insert });
        } else { request.runSpec.prompt = this.dispatchPrompt(request, options); insert(); }
      })();
      return this.executeDispatch(request, options);
    }

    // Flag-ON single mode: route execution through SessionRunner via the bridge.
    // Skips the legacy runs INSERT / ActiveRun map / adapter.start / consume() —
    // SessionStore owns the runs row for this session (PLAN.md 8c.3).
    if (this.harnessRouting(taskId, options)) {
      const attempt =
        ((
          this.db
            .prepare("SELECT MAX(attempt) AS m FROM execution_requests WHERE task_id = ?")
            .get(taskId) as { m: number | null }
        ).m ?? 0) + 1;
      const routingDecisionRef = String(
        options.routingDecisionRef ??
          persistRoutingDecision(this.db, taskId, {
            candidates: [],
            ruleFired: "harness-single-mode start (routing decision supplied by caller)",
            chosen: assistantId,
          }),
      );
      const taskRow = this.tasks.get(taskId)!;
      const projectVerification = envelope.repository && this.projectVerification
        ? this.projectVerification(workdir)
        : { warnings: [] };
      for (const warning of projectVerification.warnings) this.notice(taskId, "warn", warning);
      const { runId } = this.harnessBridge!.start(
        {
          taskId,
          assistantId,
          dispatchId: options.dispatchId,
          checkpointId: options.continuation?.kind === "checkpoint" ? options.continuation.checkpointId : undefined,
          attempt,
          prompt,
          workdir,
          worktree: envelope.repository
            ? {
                repoPath: envelope.repository.path,
                branch: taskRow.branch ?? envelope.repository.branch,
                worktreePath: workdir,
                baseRef: taskRow.base_ref ?? "HEAD",
              }
            : undefined,
          target: executionTarget,
          approvalMode: this.config.policy.approvalMode,
          maxRuntimeMs: this.maxRuntimeMs,
          routingDecisionRef,
          verification: projectVerification.plan?.checks ?? [],
          verificationPlan: projectVerification.plan,
        },
        (result, sid) => this.settleFromResult(taskId, assistantId, sid, result),
      );
      if (options.dispatchId && this.tasks.get(taskId)?.state === "ROUTING") this.tasks.transition(taskId, "RUNNING");
      return { runId };
    }

    // Same-provider continuation resumes the provider session; cross-provider
    // handoff always starts fresh from the rendered package (arch §7).
    const priorRef = options.continuation?.kind === "checkpoint" ? this.resumableRef(taskId, assistantId) : undefined;
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

    // A legacy provider start may resolve after cancellation committed.
    if (options.dispatchId && this.tasks.get(taskId)?.state === "CANCELLED") {
      await adapter.cancel(handle);
    }
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, assistant_id, provider_session_ref, state, started_at, worktree_path, branch, dispatch_id)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
      )
      .run(
        handle.runId,
        taskId,
        assistantId,
        handle.providerSessionRef ?? null,
        startedAt,
        options.worktree?.worktreePath ?? null,
        options.worktree?.branch ?? null,
        options.dispatchId ?? null,
      );

    if (options.dispatchId && this.tasks.get(taskId)?.state === "ROUTING") this.tasks.transition(taskId, "RUNNING");
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
    this.db.prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND trigger = 'wake' AND to_run_id IS NULL").run(handle.runId, taskId);
    this.active.set(handle.runId, run);
    void this.consume(run);
    return { runId: handle.runId };
  }

  private dispatchPrompt(request: ExecutionRequest, options: StartOptions): string {
    if (request.origin.kind === 'handoff') {
      const env = new HandoffService(this.db).get(request.origin.envelopeId);
      if (!env || env.taskId !== request.taskId) throw new Error('Missing immutable continuation envelope');
      return renderCommittedHandoff(env.envelope);
    }
    if (options.continuation?.kind === 'checkpoint') return this.renderHandoffFor(request.taskId, { continuation: options.continuation });
    const intent = JSON.parse(this.tasks.get(request.taskId)!.intent_json) as TaskIntent;
    const envelope = this.tasks.envelope(request.taskId);
    return renderTaskPrompt({ ...envelope, goal: intent.goal, constraints: intent.constraints,
      repository: intent.repository ? { path: intent.repository.path, branch: request.context.worktree?.branch ?? intent.repository.branch ?? '' } : undefined });
  }

  private async executeDispatch(request: ExecutionRequest, options: StartOptions): Promise<{ runId: string }> {
    await options.beforeStart?.();
    const taskId = request.taskId;
    const d = this.db.prepare('SELECT phase, execution_path FROM dispatches WHERE dispatch_id = ?').get(request.executionRequestId) as { phase: string; execution_path: string };
    if (d.phase !== 'start_attempted' || this.tasks.get(taskId)?.state !== 'ROUTING') throw new Error('Dispatch cancelled before provider start');
    if (options.continuation?.kind === 'checkpoint') {
      this.db.prepare("UPDATE handoffs SET trigger = 'wake' WHERE task_id = ? AND checkpoint_id = ? AND trigger = 'harness' AND to_run_id IS NULL").run(taskId, options.continuation.checkpointId);
      this.db.prepare(`INSERT INTO handoffs(id,task_id,from_run_id,checkpoint_id,trigger,at)
        SELECT ?,?,?,?,'wake',? WHERE NOT EXISTS (SELECT 1 FROM handoffs WHERE task_id = ? AND checkpoint_id = ? AND trigger = 'wake')`)
        .run(newHandoffId(), taskId, this.checkpoints.latest(taskId, options.continuation.checkpointId)?.runId ?? null, options.continuation.checkpointId, new Date().toISOString(), taskId, options.continuation.checkpointId);
    }
    if (d.execution_path === 'harness') {
      const result = this.harnessBridge!.startRequest(request, (result, sid) => this.settleFromResult(taskId, request.assistantId, sid, result));
      if (this.tasks.get(taskId)?.state === 'ROUTING') this.tasks.transition(taskId, 'RUNNING');
      this.db.prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND trigger = 'wake' AND to_run_id IS NULL").run(result.runId, taskId);
      return result;
    }
    const adapter = this.registry.adapter(request.assistantId);
    const handle = await adapter.start(request.runSpec);
    if (this.tasks.get(taskId)?.state === 'CANCELLED') await adapter.cancel(handle);
    this.db.prepare(`INSERT INTO runs(id,task_id,assistant_id,provider_session_ref,state,started_at,dispatch_id)
      VALUES(?,?,?,?,'ACTIVE',?,?)`).run(handle.runId, taskId, request.assistantId, handle.providerSessionRef ?? null, new Date().toISOString(), request.executionRequestId);
    if (this.tasks.get(taskId)?.state === 'ROUTING') this.tasks.transition(taskId, 'RUNNING');
    const run: ActiveRun = { runId: handle.runId, taskId, assistantId: request.assistantId, adapter, handle,
      timeout: setTimeout(() => { void adapter.cancel(handle); }, request.runSpec.env?.maxRuntimeMs ?? this.maxRuntimeMs) };
    this.db.prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND trigger = 'wake' AND to_run_id IS NULL").run(handle.runId, taskId);
    this.active.set(handle.runId, run);
    void this.consume(run);
    return { runId: handle.runId };
  }

  private renderHandoffFor(taskId: string, options: StartOptions): string {
    const checkpoint = options.continuation?.kind === "checkpoint"
      ? this.checkpoints.latest(taskId, options.continuation.checkpointId) : undefined;
    if (!checkpoint) throw new Error("Continuation checkpoint does not belong to this task");
    return renderHandoffPrompt(checkpoint.envelope, {
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
        if (quotaOf(safeEvent)) this.scheduler?.quotaObserved();
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
    // Envelope-shaping cases (phase / file.changed / test.result / message) —
    // shared with the flag-ON single-mode path (PLAN.md 8b).
    const changed = deriveEnvelopeUpdate(envelope, event);

    // Run / adapter / DB side effects stay here for the legacy path.
    switch (event.type) {
      case "run.started": {
        const ref = (event.payload as { providerSessionRef?: string } | undefined)?.providerSessionRef;
        if (ref) {
          this.db.prepare("UPDATE runs SET provider_session_ref = ? WHERE id = ?").run(ref, run.runId);
        }
        break;
      }
      case "usage.updated": {
        this.db.prepare("UPDATE runs SET usage = ? WHERE id = ?").run(JSON.stringify(event.payload ?? {}), run.runId);
        snapshotQuota(this.db, run.assistantId, event);
        await this.checkSoftThreshold(run, event);
        break;
      }
      case "limit.approaching": {
        snapshotQuota(this.db, run.assistantId, event);
        await this.checkSoftThreshold(run, event, true);
        break;
      }
      case "limit.hit": {
        snapshotQuota(this.db, run.assistantId, event);
        run.limit = { reason: event.summary, resetsAt: firstResetsAt(event) };
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


  /** Decides what happens after a run's stream drains: finish, or fail over. */
  private async settleRun(run: ActiveRun, ok: boolean): Promise<void> {
    this.db
      .prepare("UPDATE runs SET state = ?, ended_at = ? WHERE id = ?")
      .run(ok ? "ENDED_OK" : "ENDED_ERROR", new Date().toISOString(), run.runId);

    if (run.handingOff) return; // a handoff owns this task's next transition
    const row = this.tasks.get(run.taskId);
    if (!this.canSettle(run.taskId)) return;
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
      const trigger = limited ? "quota" : "failure";
      const reasonText = limited
        ? (run.limit?.reason ?? `${run.assistantId} hit a usage limit`)
        : `${run.assistantId} ended with an error`;
      await this.failoverTask(run.taskId, run.assistantId, trigger, reasonText, run.runId, run.limit?.resetsAt);
      return;
    }

    if (limited) {
      // Failover disabled by policy: park the task rather than calling it failed.
      this.cooldowns.penalize(run.assistantId, "limit", run.limit!.reason, run.limit!.resetsAt);
      await this.checkpoints.create(run.taskId, run.runId, "limit");
      const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT", "limit");
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
  private async failoverTask(
    taskId: string,
    assistantId: string,
    trigger: "quota" | "failure",
    reasonText: string,
    fromRunOrSessionId: string,
    resetsAt?: string,
  ): Promise<void> {
    const claimed = this.db.transaction(() => {
      if (!this.canSettle(taskId) || this.tasks.get(taskId)?.state !== "RUNNING") return false;
      // The session row can commit before Scheduler records its final phase.
      // Settlement proves that predecessor dispatch started; close that reservation
      // in this transaction before a quota wait can take ownership.
      this.db.prepare(`UPDATE dispatches SET phase = 'started', session_id = ?, updated_at = ?
        WHERE dispatch_id = (SELECT dispatch_id FROM runs WHERE id = ?) AND task_id = ? AND phase = 'start_attempted'`)
        .run(fromRunOrSessionId, new Date().toISOString(), fromRunOrSessionId, taskId);
      this.tasks.transition(taskId, "LIMIT_PAUSED");
      return true;
    })();
    if (!claimed) return;
    this.publishState(taskId, this.tasks.envelope(taskId), assistantId);

    const settled = this.harnessBridge?.result(fromRunOrSessionId);
    const anchor = settled?.checkpoint.checkpointId
      ? this.checkpoints.latest(taskId, settled.checkpoint.checkpointId) : undefined;
    const checkpoint = anchor ?? await this.checkpoints.create(taskId, fromRunOrSessionId, 'handoff');
    if (!this.canSettle(taskId) || this.tasks.get(taskId)?.state !== "LIMIT_PAUSED") return;
    const wait = this.scheduler?.condition(taskId);
    const attempt = wait?.state === 'consumed' ? wait.autoWakes + 1 : 0;
    this.cooldowns.penalize(assistantId, trigger === "quota" ? "limit" : "failure", reasonText, resetsAt, attempt);

    const { explanation, routingDecisionId } = this.routeTask(taskId, "failover", { exclude: assistantId });

    if (!explanation.chosen) {
      if (this.scheduler?.parkQuota(taskId, checkpoint.id)) return;
      const envelope = this.tasks.transition(taskId, "WAITING_INPUT", this.quotaPlan(taskId).interventionRequired ? "intervention_required" : "no_candidate");
      this.publishState(taskId, envelope);
      this.notice(
        taskId,
        "warn",
        `${reasonText}. No other assistant is eligible right now — work is checkpointed and waiting. ${describeWaits(explanation)}`,
      );
      return;
    }

    const target = explanation.chosen;
    this.tasks.transition(taskId, "HANDING_OFF");
    this.publishState(taskId, this.tasks.envelope(taskId), target);
    this.notice(
      taskId,
      "warn",
      `${reasonText} — handing off to ${target}, continuing from the checkpoint.`,
    );

    const at = new Date().toISOString();
    const pending = this.db.prepare("UPDATE handoffs SET trigger = ?, at = ? WHERE task_id = ? AND checkpoint_id = ? AND trigger = 'harness' AND to_run_id IS NULL")
      .run(trigger, at, taskId, checkpoint.id);
    if (!pending.changes) this.db.prepare('INSERT INTO handoffs(id,task_id,from_run_id,checkpoint_id,trigger,at) VALUES(?,?,?,?,?,?)')
      .run(newHandoffId(), taskId, fromRunOrSessionId, checkpoint.id, trigger, at);

    try {
      const { runId } = await this.startTask(taskId, target, {
        trigger: "handoff",
        continuation: { kind: "checkpoint", checkpointId: checkpoint.id },
        reason: reasonText,
        fromAssistantId: assistantId,
        routingDecisionRef: String(routingDecisionId),
      });
      this.db
        .prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND to_run_id IS NULL")
        .run(runId, taskId);
    } catch (err) {
      const envelope = this.tasks.transition(taskId, "WAITING_INPUT", "harness_error");
      this.publishState(taskId, envelope);
      this.notice(taskId, "warn", `Handoff to ${target} failed to start: ${message(err)}`);
    }
  }

  /**
   * Settle a task from a terminal Harness `ExecutionResult` (or `null` when the
   * runner promise rejected with no persisted result). Mirrors `settleRun` +
   * the runner's `observe()` normalizations (PLAN.md 8c.4).
   */
  private async settleFromResult(
    taskId: string,
    assistantId: string,
    sessionId: string,
    result: ExecutionResult | null,
  ): Promise<void> {
    if (this.harnessBridge!.consumePlaneOwnsTerminal(sessionId)) return; // cancel / manual handoff owns it
    const row = this.tasks.get(taskId);
    if (!this.canSettle(taskId)) return;
    if (!row || isTerminal(row.state)) return; // cancelled, or already settled
    if (sessionId !== this.harnessBridge!.latestSessionId(taskId)) return; // stale / superseded

    const tx = (to: TaskState, note?: string, pauseKind?: PauseKind): void => {
      try {
        const envelope = this.tasks.transition(taskId, to, pauseKind);
        this.publishState(taskId, envelope, assistantId);
      } catch {
        // legacy pattern: settling is best-effort, never raises here
      }
      if (note) this.notice(taskId, "warn", note);
    };

    if (result === null) {
      tx("WAITING_INPUT", `execution harness error on session ${sessionId} — recovery required`, "harness_error");
      return;
    }

    const detailReason = (result.yield?.detail as { reason?: string } | undefined)?.reason;

    switch (result.outcome) {
      case "completed": {
        if (result.verification && !result.verification.passed) {
          tx("WAITING_INPUT", "verification failed — awaiting your call", "verification_failed");
        } else {
          tx("COMPLETED");
        }
        return;
      }
      case "yielded": {
        const kind = result.yield?.kind;
        if (kind === "limit") {
          const reasonText = detailReason ?? `${assistantId} hit a usage limit`;
          const resetsAt = (result.yield?.detail as { quota?: { resetsAt?: string }[] })?.quota?.find(q => q.resetsAt)?.resetsAt;
          if (this.triggerEnabled("quota") && this.config.failover.auto) {
            await this.failoverTask(taskId, assistantId, "quota", reasonText, sessionId, resetsAt);
          } else {
            this.cooldowns.penalize(assistantId, "limit", reasonText, resetsAt);
            tx("WAITING_INPUT", `${assistantId} hit a limit; automatic failover is off.`, "limit");
          }
        } else if (kind === "reroute") {
          const reasonText = detailReason ?? `${assistantId} reported the route is unsuitable`;
          if (this.triggerEnabled("provider_unavailable") && this.config.failover.auto) {
            await this.failoverTask(taskId, assistantId, "failure", reasonText, sessionId);
          } else {
            tx("WAITING_INPUT", `${reasonText}; automatic failover is off.`, "provider_unavailable");
          }
        } else {
          // handoff yield — no automatic Harness-side target (§8)
          tx("WAITING_INPUT", `${assistantId} requested a handoff — waiting for your call.`, "handoff_requested");
        }
        return;
      }
      case "failed":
      case "timed_out": {
        const f = result.failure;
        if (
          f?.kind === "provider_fault" &&
          f.retryable &&
          this.triggerEnabled("provider_unavailable") &&
          this.config.failover.auto
        ) {
          await this.failoverTask(
            taskId,
            assistantId,
            "failure",
            f.message || `${assistantId} ended with an error`,
            sessionId,
          );
        } else {
          tx("FAILED");
        }
        return;
      }
      case "cancelled": {
        if (!isTerminal(this.tasks.get(taskId)?.state ?? "")) tx("CANCELLED");
        return;
      }
    }
  }

  private canSettle(taskId: string): boolean {
    const state = this.tasks.get(taskId)?.state;
    const open = this.db.prepare(`SELECT 1 FROM dispatches d WHERE d.task_id = ? AND d.phase IN ('reserved','start_attempted')
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.dispatch_id = d.dispatch_id)`).get(taskId);
    if (state === "WAITING_RESOURCE" || open) {
      this.notice(taskId, "warn", "stale settlement ignored: scheduler owns task");
      return false;
    }
    return state === "RUNNING" || state === "LIMIT_PAUSED" || state === "ROUTING" || state === "HANDING_OFF" || state === "WAITING_INPUT";
  }

  /** Poll until the session is terminal (or gone). Returns false on timeout. */
  private async waitUntilSessionTerminal(sessionId: string, timeoutMs = 10_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = this.harnessBridge?.sessionState(sessionId) as ExecutionSessionState | undefined;
      if (!state || isSessionTerminal(state)) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  /** Manual handoff: checkpoint, then move the task to another assistant. */
  async handoff(taskId: string, to?: AssistantId): Promise<{ runId: string; assistantId: string }> {
    const row = this.tasks.get(taskId);
    if (!row) throw new Error(`Unknown task ${taskId}`);
    this.assertNoMixedOwnership(taskId);
    if (row.state === "WAITING_RESOURCE" || this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)) throw new Error("Scheduler owns task; use run-now");
    if (isTerminal(row.state)) {
      throw new Error(
        `Task ${taskId} is ${row.state}. A finished task cannot be handed off — create a follow-up task instead.`,
      );
    }

    if (this.harnessOwns(taskId)) return this.harnessHandoff(taskId, to);

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
    const { explanation, routingDecisionId } = this.routeTask(taskId, "failover", { exclude: fromAssistantId, override: to });
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
      continuation: { kind: "checkpoint", checkpointId: checkpoint.id },
      reason: "A manual handoff was requested by the user.",
      fromAssistantId,
      routingDecisionRef: String(routingDecisionId),
    });
    this.db
      .prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND to_run_id IS NULL")
      .run(runId, taskId);
    return { runId, assistantId: explanation.chosen };
  }

  /**
   * Manual handoff for a Harness-owned task (PLAN.md 8c.3): durable-cancel the
   * source session under `planeOwnsTerminal` so its detached `settleFromResult`
   * does NOT transition the task, then start a fresh Harness session on the
   * target with a handoff-rendered prompt.
   */
  private async harnessHandoff(taskId: string, to?: AssistantId): Promise<{ runId: string; assistantId: string }> {
    const sid = this.harnessBridge!.liveSessionId(taskId);
    const fromAssistantId = this.lastAssistant(taskId);

    if (sid) {
      this.harnessBridge!.markPlaneOwnsTerminal(sid);
      this.harnessBridge!.requestCancel(sid);
      const settled = await this.waitUntilSessionTerminal(sid);
      if (!settled) {
        // Drain stalled. Park the task and bail — planeOwnsTerminal stays SET so
        // the source session's eventual settlement no-ops the task (never
        // stranded in HANDING_OFF, Codex 8c review).
        try {
          const envelope = this.tasks.transition(taskId, "WAITING_INPUT", "harness_error");
          this.publishState(taskId, envelope);
        } catch {
          /* already moved on */
        }
        this.notice(taskId, "warn", `Handoff aborted — session ${sid} did not settle in time; task parked.`);
        throw new Error(`harness session ${sid} did not settle for handoff`);
      }
    }

    // Session-scoped checkpoint on the captured harness sid — the target's
    // handoff-prompt render reads checkpoints.latest(taskId). (The runner's own
    // cancel checkpoint would also serve; this labels one 'handoff' for parity.)
    const checkpoint = await this.checkpoints.create(taskId, sid ?? null, "handoff");

    const { explanation, routingDecisionId } = this.routeTask(taskId, "failover", { exclude: fromAssistantId, override: to });
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
      .run(newHandoffId(), taskId, sid ?? null, checkpoint.id, new Date().toISOString());

    this.notice(taskId, "info", `Manual handoff to ${explanation.chosen}.`);
    const { runId } = await this.startTask(taskId, explanation.chosen, {
      trigger: "handoff",
      continuation: { kind: "checkpoint", checkpointId: checkpoint.id },
      reason: "A manual handoff was requested by the user.",
      fromAssistantId,
      routingDecisionRef: String(routingDecisionId),
    });
    this.db
      .prepare("UPDATE handoffs SET to_run_id = ? WHERE task_id = ? AND to_run_id IS NULL")
      .run(runId, taskId);
    return { runId, assistantId: explanation.chosen };
  }

  routeTask(taskId: string, origin: 'intake' | 'wake' | 'run-now' | 'failover' | 'context-yield', options: { exclude?: string; override?: AssistantId; dispatchId?: string } = {}) {
    return routeTask({ db: this.db, config: this.config, tasks: this.tasks, registry: this.registry, cooldowns: this.cooldowns, now: this.now }, taskId, origin, options);
  }

  private lastAssistant(taskId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT assistant_id FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(taskId) as { assistant_id: string } | undefined
    )?.assistant_id;
  }

  async createCheckpoint(taskId: string, reason: CheckpointReason = "manual") {
    this.assertNoMixedOwnership(taskId);
    const sessionId = this.harnessOwns(taskId)
      ? (this.harnessBridge!.latestSessionId(taskId) ?? null)
      : (this.soleRun(taskId)?.runId ?? null);
    return this.checkpoints.create(taskId, sessionId, reason);
  }

  /**
   * Approvals carry a request id that is unique across a task's runs, so a
   * parallel comparison can have several assistants waiting at once.
   */
  async respondApproval(taskId: string, requestId: string, approved: boolean): Promise<void> {
    this.assertNoMixedOwnership(taskId);
    if (this.harnessOwns(taskId)) {
      const sid = this.harnessBridge!.liveSessionId(taskId);
      if (!sid) throw new Error(`No live harness session for task ${taskId}`);
      // ApprovalService.answer validates the (session, provider_request_id) row
      // exists and is answerable — loud on a mismatch. The runner's
      // AWAITING_APPROVAL poll delivers it via adapter.send.
      this.harnessBridge!.answerApproval(sid, requestId, approved);
      return;
    }
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
    this.assertNoMixedOwnership(taskId);
    this.db.transaction(() => {
      if (this.tasks.get(taskId)?.state === "CANCELLED") return;
      this.db.prepare("UPDATE wait_conditions SET state = 'cancelled' WHERE task_id = ? AND state = 'active'").run(taskId);
      this.db.prepare("UPDATE dispatches SET phase = 'cancelled', updated_at = ? WHERE task_id = ? AND phase IN ('reserved','start_attempted')").run(new Date().toISOString(), taskId);
      const claims = this.db.prepare(`SELECT h.id, h.claimed_by_request_id FROM handoff_envelopes h JOIN dispatches d ON d.dispatch_id = h.claimed_by_request_id
        WHERE d.task_id = ? AND d.phase = 'cancelled' AND h.state = 'claimed'
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.execution_request_id = d.dispatch_id)` ).all(taskId) as { id: string; claimed_by_request_id: string }[];
      for (const claim of claims) new HandoffService(this.db).release(claim.id, claim.claimed_by_request_id);
      this.db.prepare(`UPDATE execution_requests SET superseded = 1 WHERE id IN (SELECT dispatch_id FROM dispatches WHERE task_id = ? AND phase = 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM runs WHERE execution_request_id = execution_requests.id)`).run(taskId);
      const sid = this.harnessBridge?.latestSessionId(taskId);
      if (sid) this.harnessBridge!.requestCancel(sid);
      this.tasks.transition(taskId, "CANCELLED");
      const condition = this.db.prepare('SELECT generation FROM wait_conditions WHERE task_id = ? ORDER BY generation DESC LIMIT 1').get(taskId) as { generation: number } | undefined;
      if (condition) this.db.prepare("INSERT INTO scheduler_events(task_id,generation,type,at,payload) VALUES(?,?,'wait.cancelled',?,'{}')").run(taskId, condition.generation, new Date().toISOString());
    })();
    if (this.harnessOwns(taskId)) {
      // Durable cancel intent FIRST, then the task transition. The runner
      // observes the intent, settles the session terminal CANCELLED (+ a
      // checkpoint attempt), and its settleFromResult callback finds the task
      // already terminal and no-ops it (PLAN.md 8c.3, R1 #3).
      const sid = this.harnessBridge!.latestSessionId(taskId);
      if (sid) this.harnessBridge!.requestCancel(sid);
      const envelope = this.tasks.envelope(taskId);
      this.publishState(taskId, envelope);
      return;
    }
    const runs = this.runsOfTask(taskId);
    const envelope = this.tasks.envelope(taskId);
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
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Flag-ON: durable-cancel every live Harness session of this process and
    // wait for them to drain — SAME deadline as the legacy drain above
    // (PLAN.md 8c.3, R1 #10).
    if (this.harnessBridge) {
      const liveHarness = () =>
        this.db
          .prepare(
            "SELECT id FROM runs WHERE execution_request_id IS NOT NULL AND ended_at IS NULL",
          )
          .all() as Array<{ id: string }>;
      for (const { id } of liveHarness()) this.harnessBridge.requestCancel(id);
      while (liveHarness().length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
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

    if (this.db.prepare("SELECT 1 FROM dispatches WHERE task_id = ? AND phase IN ('reserved','start_attempted')").get(taskId)) throw new Error("Scheduler owns task; parallel starts are not allowed");
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
    const envelope = this.tasks.transition(run.taskId, "WAITING_INPUT", "comparison_pending");
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
        // Effective state + usage derived at read time (PLAN.md 8e) — unified
        // vocab regardless of legacy vs harness row; see state-vocab.ts.
        `SELECT r.id, r.assistant_id,
           ${effectiveStateSql("r")} AS state,
           ${effectiveUsageSql("r")} AS usage,
           r.started_at, r.ended_at, r.worktree_path, r.branch, r.outcome
         FROM runs r ${effectiveUsageJoin("r")}
         WHERE r.task_id = ? ORDER BY r.started_at`,
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

function firstResetsAt(event: NormalizedEvent): string | undefined {
  return quotaOf(event)?.find((q) => q.resetsAt)?.resetsAt;
}

function describeWaits(explanation: { candidates: Array<{ assistantId: string; filterFailures: string[] }> }): string {
  const blocked = explanation.candidates
    .filter((c) => c.filterFailures.length > 0)
    .map((c) => `${c.assistantId}: ${c.filterFailures.join(", ")}`);
  return blocked.length > 0 ? `Blocked — ${blocked.join("; ")}.` : "";
}

function isTerminal(state: string): boolean {
  return isTaskState(state) && isTerminalState(state);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
