/**
 * P0-2 (docs/agentic-os-auto-copilot-plan.md §C.2) — autopilot core.
 *
 * What lives here: the durable autopilot state (running or not), windows, window charges, the
 * billing attestation, attempts with the §C.2.1 states, per-session runtime, and the ONE launch
 * check (`launchCheck`) that the orchestrator calls early and the session runner calls last,
 * immediately before a provider process exists (§C.2.3).
 *
 * What does not: picking work and reserving it (`selectNext`, P0-6), acceptance (P0-4),
 * publication (P0-5) and the host gate's own probes (P0-3, injected here as `hostGate`). Until
 * P0-6 lands, an attempt is created only through `reserve` + `admit`, which have no HTTP route.
 *
 * Every write is a SQLite transaction on the plane's own database. Nothing here calls a provider,
 * GitHub or the network.
 */
import { randomUUID } from "node:crypto";
import { isTerminal, type ExecutionRequest, type ExecutionResult, type TaskState, type WaitCondition, type WaitInput } from "@agent-plane/core";
import type { ResolvedConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CreateTaskInput, TaskStore } from "./tasks.js";

export const AUTOPILOT_REFUSAL_REASONS = [
  "stopped", "window_closed", "budget_exhausted", "billing_expired", "host_busy", "composition_unavailable", "not_owner",
] as const;
export type AutopilotRefusalReason = (typeof AUTOPILOT_REFUSAL_REASONS)[number];

/** §C.2.3: the typed refusal. The scheduler catches exactly this type before `start_attempted`. */
export class AutopilotLaunchRefused extends Error {
  constructor(readonly taskId: string, readonly reason: AutopilotRefusalReason, readonly detail: string) {
    super(`Autopilot launch refused for task ${taskId}: ${reason} (${detail})`);
    this.name = "AutopilotLaunchRefused";
  }
}

/** §C.2.10: a start that the instance's settings cannot honour. `setting` is the key to change. */
export class AutopilotStartRefused extends Error {
  constructor(readonly setting: string, detail: string) {
    super(`Autopilot start refused: ${setting} ${detail}`);
    this.name = "AutopilotStartRefused";
  }
}

export const NON_FINAL_ATTEMPT_STATES = ["reserving", "admitted", "running", "suspended", "settled", "accepting", "accepted", "publishing", "publish_uncertain"] as const;
export const FINAL_ATTEMPT_STATES = ["published", "closed", "failed", "blocked", "cancelled", "conflict", "external"] as const;
export type AttemptState = (typeof NON_FINAL_ATTEMPT_STATES)[number] | (typeof FINAL_ATTEMPT_STATES)[number];
const isFinal = (state: string): boolean => (FINAL_ATTEMPT_STATES as readonly string[]).includes(state);

export interface AutopilotAttempt {
  id: string; itemId: string; attemptNo: number; reservationId: string; reservationSha?: string; taskId?: string;
  state: AttemptState; reason?: string; runtimeBudgetMs: number; runtimeUsedMs: number;
  deadlineAt?: string; deadlineBound?: "budget" | "window"; createdAt: string; updatedAt: string; finalAt?: string;
}
export interface AutopilotWindow { id: string; opensAt: string; closesAt: string; maxItems: number; charged: number }

/** What the scheduler does with a refused launch (§C.2.3 table). Decided here, applied there, in one transaction. */
export type AutopilotPark =
  | { kind: "time"; notBefore: string }
  /** `WAITING_INPUT` with the reason as the blocker; only `release` moves it on. */
  | { kind: "hold" }
  | { kind: "cancel" }
  /** The attempt went final (`failed`); its task ends with it. */
  | { kind: "fail" };

export interface AutopilotLaunch { attemptId: string; windowId: string; deadlineAtMs: number; remainingMs: number; bound: "budget" | "window" }

/** The slice of the scheduler `admit` and `release` need. Set by the composition root. */
export interface AutopilotSchedulerPort {
  attach(taskId: string, input: WaitInput): WaitCondition;
  autopilotRelease(taskId: string): WaitCondition;
  publish(taskId: string): void;
}

export interface AutopilotDeps {
  db: Db;
  config: ResolvedConfig;
  tasks: TaskStore;
  now?: () => Date;
  /** §C.2.6 host gate. P0-3 supplies the real probes; absent = admitted. Unreadable must answer `ok: false`. */
  hostGate?: () => { ok: true } | { ok: false; detail: string };
}

interface AttemptRow {
  id: string; item_id: string; attempt_no: number; reservation_id: string; reservation_sha: string | null; task_id: string | null;
  state: AttemptState; reason: string | null; runtime_budget_ms: number; deadline_at: string | null; deadline_bound: "budget" | "window" | null;
  created_at: string; updated_at: string; final_at: string | null;
}
interface WindowRow { id: string; opens_at: string; closes_at: string; max_items: number }

const ISO_TZ = /T.*(?:Z|[+-]\d\d:\d\d)$/;
function isoInstant(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_TZ.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp including timezone`);
  return new Date(value).toISOString();
}

export class AutopilotService {
  private readonly db: Db;
  private readonly now: () => Date;
  scheduler?: AutopilotSchedulerPort;
  /** A final-check refusal, held until the refused session settles and the orchestrator parks its task. */
  private readonly finalRefusals = new Map<string, AutopilotRefusalReason>();

  constructor(private readonly d: AutopilotDeps) {
    this.db = d.db;
    this.now = d.now ?? (() => new Date());
  }

  private iso(): string { return this.now().toISOString(); }
  private get cfg() { return this.d.config.autopilot; }

  /* ------------------------------------------------------------- state -- */

  status() {
    const state = this.db.prepare("SELECT status, stop_reason, started_by, updated_at FROM autopilot_state WHERE id = 1").get() as
      { status: "stopped" | "draining" | "running"; stop_reason: string | null; started_by: string | null; updated_at: string };
    const attempt = this.currentAttempt();
    const attestation = this.attestation();
    return {
      status: state.status,
      ...(state.stop_reason ? { stopReason: state.stop_reason } : {}),
      ...(state.started_by ? { startedBy: state.started_by } : {}),
      updatedAt: state.updated_at,
      window: this.openWindow() ?? null,
      nextWindowOpensAt: this.nextOpening() ?? null,
      attempt: attempt ?? null,
      billingAttestation: attestation ? { attestedAt: attestation.attested_at, expiresAt: attestation.expires_at, current: this.attestationCurrent(attestation) } : null,
      settings: this.settingProblems(),
    };
  }

  /** The settings an autopilot start depends on (§C.2.10, §C.0), each named by its config key. */
  private settingProblems(): Array<{ setting: string; detail: string }> {
    const c = this.d.config;
    const problems: Array<{ setting: string; detail: string }> = [];
    if (!c.execution.harnessModes.single) problems.push({ setting: "execution.harnessModes.single", detail: "must be true: the autopilot launches on the Harness path only" });
    if (!c.composer.requireRevision) problems.push({ setting: "composer.requireRevision", detail: "must be true: an autopilot run never downgrades to route-only" });
    if (!c.composer.enabled) problems.push({ setting: "composer.enabled", detail: "must be true: an autopilot run is a composed run" });
    if (!c.execution.agentUser) problems.push({ setting: "execution.agentUser", detail: "must be set: autopilot providers run as the agent user" });
    if (!Object.prototype.hasOwnProperty.call(c.scheduler?.resources ?? {}, this.cfg.pool)) {
      problems.push({ setting: `scheduler.resources.${this.cfg.pool}`, detail: "must be declared: every autopilot task waits on this pool" });
    }
    return problems;
  }

  /** `autopilot.operate` only (the route enforces it). Refuses, naming the setting, when the instance cannot honour a start. */
  start(startedBy: string): ReturnType<AutopilotService["status"]> {
    const problem = this.settingProblems()[0];
    if (problem) throw new AutopilotStartRefused(problem.setting, problem.detail);
    this.db.prepare("UPDATE autopilot_state SET status = 'running', stop_reason = NULL, started_by = ?, updated_at = ? WHERE id = 1").run(startedBy, this.iso());
    return this.status();
  }

  /**
   * §C.2.9. `drain` and `now` both stop every later launch (a launch is something new; the phase
   * that is already running finishes under `drain`). `now` also ends a running attempt: the
   * returned task id is the one the caller must cancel, which stops its scope. An `admitted` or
   * `suspended` attempt is left for the typed park `stopped` at its next launch.
   */
  stop(mode: "drain" | "now", reason = "operator"): { status: ReturnType<AutopilotService["status"]>; cancelTaskId?: string } {
    const cancelTaskId = this.db.transaction((): string | undefined => {
      this.db.prepare("UPDATE autopilot_state SET status = ?, stop_reason = ?, updated_at = ? WHERE id = 1")
        .run(mode === "drain" ? "draining" : "stopped", mode === "drain" ? "drain" : reason, this.iso());
      if (mode !== "now") return undefined;
      const attempt = this.currentRow();
      if (attempt?.state !== "running" || !attempt.task_id) return undefined;
      this.finalize(attempt, "cancelled", `stop: ${reason}`);
      return attempt.task_id;
    })();
    return { status: this.status(), ...(cancelTaskId ? { cancelTaskId } : {}) };
  }

  /** A failure that must stop the loop without an operator (for example `github-auth`, P0-5). */
  halt(reason: string): void {
    this.db.prepare("UPDATE autopilot_state SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE id = 1 AND status <> 'stopped'").run(reason, this.iso());
  }

  /* ----------------------------------------------- windows + attestation -- */

  addWindow(input: { opensAt?: unknown; closesAt?: unknown; maxItems?: unknown }, createdBy: string): AutopilotWindow {
    const opensAt = isoInstant(input.opensAt, "opensAt");
    const closesAt = isoInstant(input.closesAt, "closesAt");
    if (closesAt <= opensAt) throw new Error("closesAt must be after opensAt");
    if (Date.parse(closesAt) <= this.now().getTime()) throw new Error("the window is already over");
    const maxItems = input.maxItems ?? this.cfg.itemsPerWindow;
    if (!Number.isInteger(maxItems) || (maxItems as number) < 1) throw new Error("maxItems must be a positive integer");
    const overlap = this.db.prepare("SELECT id FROM autopilot_windows WHERE opens_at < ? AND closes_at > ?").get(closesAt, opensAt) as { id: string } | undefined;
    if (overlap) throw new Error(`the window overlaps ${overlap.id}`);
    const id = `apw_${randomUUID()}`;
    this.db.prepare("INSERT INTO autopilot_windows(id, opens_at, closes_at, max_items, created_by, created_at) VALUES(?,?,?,?,?,?)")
      .run(id, opensAt, closesAt, maxItems, createdBy, this.iso());
    return this.window(id)!;
  }

  windows(): AutopilotWindow[] {
    return (this.db.prepare("SELECT * FROM autopilot_windows WHERE closes_at > ? ORDER BY opens_at").all(this.iso()) as WindowRow[]).map((w) => this.toWindow(w));
  }
  private window(id: string): AutopilotWindow | undefined {
    const row = this.db.prepare("SELECT * FROM autopilot_windows WHERE id = ?").get(id) as WindowRow | undefined;
    return row ? this.toWindow(row) : undefined;
  }
  private toWindow(w: WindowRow): AutopilotWindow {
    const charged = (this.db.prepare("SELECT COUNT(*) AS n FROM autopilot_window_charges WHERE window_id = ?").get(w.id) as { n: number }).n;
    return { id: w.id, opensAt: w.opens_at, closesAt: w.closes_at, maxItems: w.max_items, charged };
  }
  private openWindowRow(): WindowRow | undefined {
    const at = this.iso();
    return this.db.prepare("SELECT * FROM autopilot_windows WHERE opens_at <= ? AND closes_at > ? ORDER BY opens_at DESC LIMIT 1").get(at, at) as WindowRow | undefined;
  }
  openWindow(): AutopilotWindow | undefined {
    const row = this.openWindowRow();
    return row ? this.toWindow(row) : undefined;
  }
  nextOpening(): string | undefined {
    return (this.db.prepare("SELECT MIN(opens_at) AS at FROM autopilot_windows WHERE opens_at > ?").get(this.iso()) as { at: string | null }).at ?? undefined;
  }

  /** D-13: the operator states both are off. Anything else is recorded and admits nothing. */
  attest(input: { extraUsageOff: unknown; autoReloadOff: unknown }, attestedBy: string) {
    if (typeof input.extraUsageOff !== "boolean" || typeof input.autoReloadOff !== "boolean") throw new Error("extraUsageOff and autoReloadOff must be booleans");
    const at = this.now();
    const expiresAt = new Date(at.getTime() + this.cfg.attestationMaxAgeDays * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO autopilot_billing_attestations(attested_at, expires_at, extra_usage_off, auto_reload_off, attested_by) VALUES(?,?,?,?,?)")
      .run(at.toISOString(), expiresAt, input.extraUsageOff ? 1 : 0, input.autoReloadOff ? 1 : 0, attestedBy);
    return { attestedAt: at.toISOString(), expiresAt, current: input.extraUsageOff && input.autoReloadOff };
  }
  private attestation() {
    return this.db.prepare("SELECT attested_at, expires_at, extra_usage_off, auto_reload_off FROM autopilot_billing_attestations ORDER BY id DESC LIMIT 1").get() as
      { attested_at: string; expires_at: string; extra_usage_off: number; auto_reload_off: number } | undefined;
  }
  private attestationCurrent(a: { expires_at: string; extra_usage_off: number; auto_reload_off: number } | undefined): boolean {
    return !!a && a.extra_usage_off === 1 && a.auto_reload_off === 1 && Date.parse(a.expires_at) > this.now().getTime();
  }

  /* ----------------------------------------------------------- attempts -- */

  private toAttempt(r: AttemptRow): AutopilotAttempt {
    return {
      id: r.id, itemId: r.item_id, attemptNo: r.attempt_no, reservationId: r.reservation_id,
      ...(r.reservation_sha ? { reservationSha: r.reservation_sha } : {}), ...(r.task_id ? { taskId: r.task_id } : {}),
      state: r.state, ...(r.reason ? { reason: r.reason } : {}), runtimeBudgetMs: r.runtime_budget_ms, runtimeUsedMs: this.usedMs(r.id),
      ...(r.deadline_at ? { deadlineAt: r.deadline_at } : {}), ...(r.deadline_bound ? { deadlineBound: r.deadline_bound } : {}),
      createdAt: r.created_at, updatedAt: r.updated_at, ...(r.final_at ? { finalAt: r.final_at } : {}),
    };
  }
  private row(id: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM autopilot_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  }
  private rowOfTask(taskId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM autopilot_attempts WHERE task_id = ?").get(taskId) as AttemptRow | undefined;
  }
  private currentRow(): AttemptRow | undefined {
    return this.db.prepare(`SELECT * FROM autopilot_attempts WHERE state IN (${NON_FINAL_ATTEMPT_STATES.map(() => "?").join(",")})`).get(...NON_FINAL_ATTEMPT_STATES) as AttemptRow | undefined;
  }
  attempt(id: string): AutopilotAttempt | undefined { const r = this.row(id); return r ? this.toAttempt(r) : undefined; }
  attemptOfTask(taskId: string): AutopilotAttempt | undefined { const r = this.rowOfTask(taskId); return r ? this.toAttempt(r) : undefined; }
  /** The one non-final attempt, if any (invariant 1). */
  currentAttempt(): AutopilotAttempt | undefined { const r = this.currentRow(); return r ? this.toAttempt(r) : undefined; }
  attempts(limit = 50): AutopilotAttempt[] {
    return (this.db.prepare("SELECT * FROM autopilot_attempts ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as AttemptRow[]).map((r) => this.toAttempt(r));
  }
  /** Whether this task belongs to an autopilot attempt, in any state. */
  owns(taskId: string): boolean { return !!this.rowOfTask(taskId); }

  private setState(id: string, state: AttemptState, reason?: string | null): void {
    const at = this.iso();
    this.db.prepare("UPDATE autopilot_attempts SET state = ?, reason = ?, updated_at = ?, final_at = ? WHERE id = ?")
      .run(state, reason ?? null, at, isFinal(state) ? at : null, id);
  }

  /**
   * Invariant 3: when an attempt goes final, the same transaction cancels its task's open waits
   * and dispatches, so nothing can launch that task afterwards. The task's own state is moved by
   * the caller that knows where it is in the state machine.
   */
  private finalize(attempt: AttemptRow, state: (typeof FINAL_ATTEMPT_STATES)[number], reason: string): void {
    this.setState(attempt.id, state, reason);
    if (!attempt.task_id) return;
    this.db.prepare("UPDATE wait_conditions SET state = 'cancelled' WHERE task_id = ? AND state = 'active'").run(attempt.task_id);
    this.db.prepare("UPDATE dispatches SET phase = 'cancelled', reason = ?, updated_at = ? WHERE task_id = ? AND phase = 'reserved'")
      .run(`autopilot attempt ${state}`, this.iso(), attempt.task_id);
  }

  /**
   * First row of the §C.2.1 table: an intent. P0-6's `selectNext` is the caller; it then creates
   * the ref and calls `admit` or `external`. Refuses while any attempt is non-final (invariant 1,
   * also a unique index) and past the per-item attempt limit.
   */
  reserve(input: { itemId: string; reservationId: string; reservationSha?: string }): AutopilotAttempt {
    if (!input.itemId || !input.reservationId) throw new Error("an attempt needs an item id and a reservation id");
    return this.db.transaction(() => {
      const open = this.currentRow();
      if (open) throw new Error(`attempt ${open.id} is ${open.state}; the autopilot runs one attempt at a time`);
      const last = (this.db.prepare("SELECT MAX(attempt_no) AS n FROM autopilot_attempts WHERE item_id = ?").get(input.itemId) as { n: number | null }).n ?? 0;
      if (last >= this.cfg.attemptsPerItem) throw new Error(`item ${input.itemId} has used its ${this.cfg.attemptsPerItem} attempt(s)`);
      const id = `apa_${randomUUID()}`;
      const at = this.iso();
      this.db.prepare(`INSERT INTO autopilot_attempts(id, item_id, attempt_no, reservation_id, reservation_sha, state, runtime_budget_ms, created_at, updated_at)
        VALUES(?,?,?,?,?,'reserving',?,?,?)`).run(id, input.itemId, last + 1, input.reservationId, input.reservationSha ?? null, this.cfg.runtimeBudgetMs, at, at);
      return this.toAttempt(this.row(id)!);
    })();
  }

  /** `reserving` → `external`: the ref belongs to another lane. Never re-run. */
  external(attemptId: string): AutopilotAttempt {
    return this.db.transaction(() => {
      const row = this.row(attemptId);
      if (row?.state !== "reserving") throw new Error(`attempt ${attemptId} is ${row?.state ?? "unknown"}, not reserving`);
      this.finalize(row, "external", "foreign reservation");
      return this.toAttempt(this.row(attemptId)!);
    })();
  }

  /**
   * `reserving` → `admitted`, once the reservation is owned. The task, its pool wait and the
   * attempt's `task_id` commit in ONE transaction (invariant 2): a crash leaves either all three
   * or an attempt that is still `reserving`. The task runs as the agent user, always.
   */
  admit(attemptId: string, task: Pick<CreateTaskInput, "goal" | "repoPath" | "constraints" | "profile">): AutopilotAttempt {
    const scheduler = this.scheduler;
    if (!scheduler) throw new Error("the autopilot has no scheduler");
    if (!task.repoPath) throw new Error("an autopilot task needs a repository");
    const taskId = this.db.transaction((): string => {
      const row = this.row(attemptId);
      if (row?.state !== "reserving") throw new Error(`attempt ${attemptId} is ${row?.state ?? "unknown"}, not reserving`);
      const created = this.d.tasks.create({ ...task, runAs: "agent" });
      scheduler.attach(created.taskId, { kind: "resource", resource: this.cfg.pool, units: 1, reason: `autopilot item ${row.item_id} attempt ${row.attempt_no}` });
      this.db.prepare("UPDATE autopilot_attempts SET state = 'admitted', task_id = ?, updated_at = ? WHERE id = ?").run(created.taskId, this.iso(), attemptId);
      return created.taskId;
    })();
    scheduler.publish(taskId);
    return this.attempt(attemptId)!;
  }

  /**
   * P0-5 (§C.2.1 publication rows, §C.2.4): the publisher moves the attempt through the states it
   * owns. Called inside the publisher's own transaction, so the attempt and the publication move
   * together. Anything outside these edges is a bug and throws.
   */
  publicationMoved(attemptId: string, to: "publishing" | "publish_uncertain" | "published" | "closed" | "conflict" | "failed" | "cancelled", reason?: string): void {
    const row = this.row(attemptId);
    if (!row) throw new Error(`attempt ${attemptId} does not exist`);
    if (row.state === to) return;
    const allowed: Record<string, readonly string[]> = {
      accepted: ["publishing"],
      publishing: ["publish_uncertain", "published", "closed", "conflict", "failed", "cancelled"],
      // `publishing` is the operator's `retry`; `cancelled` is `abandon`.
      publish_uncertain: ["publishing", "published", "closed", "conflict", "failed", "cancelled"],
    };
    if (!allowed[row.state]?.includes(to)) throw new Error(`attempt ${attemptId} is ${row.state}; a publication cannot move it to ${to}`);
    if (isFinal(to)) this.finalize(row, to as (typeof FINAL_ATTEMPT_STATES)[number], reason ?? to);
    else this.setState(attemptId, to, reason ?? null);
  }

  /** Autopilot run state, for the publisher's re-check before each mutation (§C.2.4). */
  runState(): "stopped" | "draining" | "running" {
    return (this.db.prepare("SELECT status FROM autopilot_state WHERE id = 1").get() as { status: "stopped" | "draining" | "running" }).status;
  }

  /* ------------------------------------------------------------ runtime -- */

  private usedMs(attemptId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(ms),0) AS ms FROM autopilot_runtime WHERE attempt_id = ?").get(attemptId) as { ms: number }).ms;
  }
  private liveSession(attemptId: string): string | undefined {
    return (this.db.prepare(`SELECT s.session_id AS id FROM autopilot_sessions s JOIN runs r ON r.id = s.session_id
      WHERE s.attempt_id = ? AND r.ended_at IS NULL LIMIT 1`).get(attemptId) as { id: string } | undefined)?.id;
  }

  /**
   * Invariant 4: one runtime row per ended session, keyed by the session, so it is written once
   * however many times settlement, a launch check and a boot each ask. The time is the session's
   * own `runs` start to end (one clock, the runner's). A session still live is not counted yet;
   * one with no `runs` row never ran a provider and counts nothing.
   */
  private syncRuntime(attemptId?: string): void {
    const rows = this.db.prepare(`SELECT s.session_id, s.attempt_id, r.started_at, r.ended_at, r.id AS run_id FROM autopilot_sessions s
      LEFT JOIN runs r ON r.id = s.session_id
      WHERE NOT EXISTS (SELECT 1 FROM autopilot_runtime t WHERE t.session_id = s.session_id) AND (? IS NULL OR s.attempt_id = ?)`)
      .all(attemptId ?? null, attemptId ?? null) as Array<{ session_id: string; attempt_id: string; started_at: string | null; ended_at: string | null; run_id: string | null }>;
    for (const r of rows) {
      if (r.run_id && !r.ended_at) continue; // still live
      const ms = r.run_id && r.started_at && r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : 0;
      this.db.prepare("INSERT OR IGNORE INTO autopilot_runtime(session_id, attempt_id, ms, recorded_at) VALUES(?,?,?,?)")
        .run(r.session_id, r.attempt_id, Number.isFinite(ms) ? Math.max(0, ms) : 0, this.iso());
    }
  }

  /* ------------------------------------------------------- launch check -- */

  /**
   * §C.2.3: the one check, run early (`startTask`, beside `assertLaunchClaim`) and final (the
   * runner, after the start queue, immediately before `adapter.start`). Undefined for a task that
   * is not the autopilot's. Throws `AutopilotLaunchRefused` otherwise, or returns the absolute
   * deadline this launch runs under: `min(now + budget − used, closes_at − graceMs)`, recomputed
   * every time, so a replayed request never reuses a stored timeout.
   *
   * The final pass also commits what "a provider started" means for the attempt, in the same
   * transaction as the checks: `running`, the window charge if this is the attempt's first launch
   * in the window, and the session's row.
   */
  launchCheck(taskId: string, dispatchId: string | undefined, phase: "early" | "final", ctx: { composed: boolean; sessionId?: string }): AutopilotLaunch | undefined {
    return this.db.transaction((): AutopilotLaunch | undefined => {
      const attempt = this.rowOfTask(taskId);
      if (!attempt) return undefined;
      const refuse = (reason: AutopilotRefusalReason, detail: string): never => { throw new AutopilotLaunchRefused(taskId, reason, detail); };
      const nowMs = this.now().getTime();

      // 1. The attempt is non-final and owns this task (invariant 3).
      if (isFinal(attempt.state)) refuse("not_owner", `attempt ${attempt.id} is ${attempt.state}`);
      this.syncRuntime(attempt.id);
      const live = this.liveSession(attempt.id);
      if (live && live !== ctx.sessionId) refuse("host_busy", `session ${live} of this attempt is still live`);
      if (!["admitted", "suspended", "running"].includes(attempt.state)) refuse("not_owner", `attempt ${attempt.id} is ${attempt.state}; nothing launches from there`);

      // 2. The dispatch still holds its K4b claim.
      const claim = this.db.prepare("SELECT dispatch_id, resource FROM resource_claims WHERE task_id = ? AND released_at IS NULL").get(taskId) as { dispatch_id: string; resource: string } | undefined;
      if (!dispatchId || !claim || claim.dispatch_id !== dispatchId || claim.resource !== this.cfg.pool) {
        refuse("not_owner", `dispatch ${dispatchId ?? "(none)"} holds no live ${this.cfg.pool} claim for the task`);
      }

      // 3. The autopilot is running.
      const status = (this.db.prepare("SELECT status FROM autopilot_state WHERE id = 1").get() as { status: string }).status;
      if (status !== "running") refuse("stopped", `autopilot is ${status}`);

      // 4. Inside an open window with at least minSliceMs left.
      const window = this.openWindowRow();
      if (!window) refuse("window_closed", "no window is open");
      const closesMs = Date.parse(window!.closes_at);
      if (closesMs - nowMs < this.cfg.minSliceMs) refuse("window_closed", `the window closes in ${closesMs - nowMs} ms, below minSliceMs ${this.cfg.minSliceMs}`);

      // 5. Attempt budget left.
      const remainingBudget = attempt.runtime_budget_ms - this.usedMs(attempt.id);
      if (remainingBudget <= 0) refuse("budget_exhausted", `attempt used ${attempt.runtime_budget_ms - remainingBudget} of ${attempt.runtime_budget_ms} ms`);

      // 6. The window charge is present or chargeable.
      const charged = !!this.db.prepare("SELECT 1 FROM autopilot_window_charges WHERE window_id = ? AND attempt_id = ?").get(window!.id, attempt.id);
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM autopilot_window_charges WHERE window_id = ?").get(window!.id) as { n: number }).n;
      if (!charged && count >= window!.max_items) refuse("window_closed", `window count: ${count} of ${window!.max_items} items already charged`);

      // 7. The billing attestation is current.
      if (!this.attestationCurrent(this.attestation())) refuse("billing_expired", "no current billing attestation");

      // 8. The host gate passes. A probe that throws is unreadable, and unreadable is not admitted.
      let host: { ok: true } | { ok: false; detail: string };
      try { host = this.d.hostGate?.() ?? { ok: true }; } catch (err) { host = { ok: false, detail: `host gate unreadable: ${err instanceof Error ? err.message : String(err)}` }; }
      if (!host.ok) refuse("host_busy", host.detail);

      // 9. Composition is a verified revision, never route-only.
      if (!ctx.composed) refuse("composition_unavailable", "the dispatch carries no composition revision");

      const byBudget = nowMs + remainingBudget;
      const byWindow = closesMs - this.cfg.graceMs;
      const deadlineAtMs = Math.min(byBudget, byWindow);
      if (deadlineAtMs - nowMs < 1000) refuse("window_closed", "no runtime left before the window's grace period");
      const bound = byBudget <= byWindow ? "budget" as const : "window" as const;

      if (phase === "final") {
        if (!ctx.sessionId) throw new Error("the final launch check needs the session id");
        const at = this.iso();
        const deadlineAt = new Date(deadlineAtMs).toISOString();
        this.db.prepare("UPDATE autopilot_attempts SET state = 'running', reason = NULL, deadline_at = ?, deadline_bound = ?, updated_at = ? WHERE id = ?")
          .run(deadlineAt, bound, at, attempt.id);
        this.db.prepare("INSERT OR IGNORE INTO autopilot_window_charges(window_id, attempt_id, charged_at) VALUES(?,?,?)").run(window!.id, attempt.id, at);
        this.db.prepare("INSERT OR REPLACE INTO autopilot_sessions(session_id, attempt_id, window_id, admitted_at, deadline_at) VALUES(?,?,?,?,?)")
          .run(ctx.sessionId, attempt.id, window!.id, at, deadlineAt);
      }
      return { attemptId: attempt.id, windowId: window!.id, deadlineAtMs, remainingMs: deadlineAtMs - nowMs, bound };
    })();
  }

  /**
   * The runner's `beforeProviderStart` hook (§C.2.3 final check). `refuse` means no provider
   * process may be created for this session; the reason is kept until the session settles.
   */
  beforeProviderStart(request: ExecutionRequest, sessionId: string): { remainingMs: number } | { refuse: AutopilotRefusalReason; detail: string } | undefined {
    try {
      const launch = this.launchCheck(request.taskId, request.executionRequestId, "final", { composed: !!request.compositionRevisionId, sessionId });
      return launch ? { remainingMs: launch.remainingMs } : undefined;
    } catch (err) {
      if (!(err instanceof AutopilotLaunchRefused)) throw err;
      this.finalRefusals.set(sessionId, err.reason);
      return { refuse: err.reason, detail: err.detail };
    }
  }
  /** Test-and-clear: the reason this session was refused at the final check, if it was. */
  takeFinalRefusal(sessionId: string): AutopilotRefusalReason | undefined {
    const reason = this.finalRefusals.get(sessionId);
    this.finalRefusals.delete(sessionId);
    return reason;
  }

  /**
   * The attempt's side of a refused launch, and the wait the scheduler must write (§C.2.3 table).
   * Called INSIDE the scheduler's park transaction, so the attempt, the dispatch and the wait
   * move together.
   *
   * Two readings the table leaves open, decided here:
   * - `budget_exhausted` ends the attempt (`failed`) and its task. An attempt's budget never
   *   refills, and invariant 3 forbids a final attempt's task from launching, so a time wait
   *   would be a wait that can never be granted.
   * - `window_closed` with no later window on record holds in `WAITING_INPUT`: there is no time
   *   to wait until. Adding a window and releasing continues it.
   */
  refused(taskId: string, reason: AutopilotRefusalReason): AutopilotPark {
    const attempt = this.rowOfTask(taskId);
    if (!attempt || isFinal(attempt.state)) return { kind: "cancel" };
    const hold = (): AutopilotPark => {
      // An attempt that has launched before and cannot now is `suspended`; one that never has stays `admitted`.
      this.setState(attempt.id, this.hasLaunched(attempt.id) ? "suspended" : "admitted", reason);
      return { kind: "hold" };
    };
    switch (reason) {
      case "not_owner":
        this.finalize(attempt, "cancelled", reason);
        return { kind: "cancel" };
      case "budget_exhausted":
        this.finalize(attempt, "failed", reason);
        return { kind: "fail" };
      case "host_busy":
        this.setState(attempt.id, this.hasLaunched(attempt.id) ? "suspended" : "admitted", reason);
        return { kind: "time", notBefore: new Date(this.now().getTime() + this.cfg.hostRetryMs).toISOString() };
      case "window_closed": {
        const next = this.nextOpening();
        if (!next) return hold();
        this.setState(attempt.id, this.hasLaunched(attempt.id) ? "suspended" : "admitted", reason);
        return { kind: "time", notBefore: next };
      }
      case "stopped":
      case "billing_expired":
      case "composition_unavailable":
        return hold();
    }
  }
  private hasLaunched(attemptId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM autopilot_sessions WHERE attempt_id = ?").get(attemptId);
  }

  /** The reason a task is held in `WAITING_INPUT` by a typed park, if it is. Only `release` continues it. */
  heldReason(taskId: string): string | undefined {
    const attempt = this.rowOfTask(taskId);
    const task = this.d.tasks.get(taskId);
    if (!attempt || isFinal(attempt.state) || task?.state !== "WAITING_INPUT" || !attempt.reason) return undefined;
    return (AUTOPILOT_REFUSAL_REASONS as readonly string[]).includes(attempt.reason) ? attempt.reason : undefined;
  }

  /**
   * `autopilot.operate`: put the held attempt's task back in the pool queue. It does not launch
   * anything: the task waits its turn and passes both checks like any other launch, so releasing
   * while the cause still holds parks it again.
   */
  release(): { taskId: string; reason: string } {
    const scheduler = this.scheduler;
    if (!scheduler) throw new Error("the autopilot has no scheduler");
    const attempt = this.currentRow();
    const reason = attempt?.task_id ? this.heldReason(attempt.task_id) : undefined;
    if (!attempt?.task_id || !reason) throw new Error("no autopilot task is held");
    scheduler.autopilotRelease(attempt.task_id);
    return { taskId: attempt.task_id, reason };
  }

  /* --------------------------------------------------------- settlement -- */

  /**
   * Whether this session was cut by the window (§C.2.5): it ended at or after the deadline it
   * was admitted under, that deadline was the window's, and it did not complete. The attempt is
   * then `suspended`, not failed. A session the plane never saw end (systemd killed the scope
   * while the plane was down) reads the same way from the recovered result.
   */
  cutByWindow(taskId: string, sessionId: string, result: ExecutionResult): boolean {
    if (result.outcome !== "timed_out" && result.outcome !== "failed") return false;
    const attempt = this.rowOfTask(taskId);
    if (attempt?.state !== "running" || attempt.deadline_bound !== "window") return false;
    const session = this.db.prepare("SELECT deadline_at FROM autopilot_sessions WHERE session_id = ? AND attempt_id = ?").get(sessionId, attempt.id) as { deadline_at: string } | undefined;
    return !!session && this.now().getTime() >= Date.parse(session.deadline_at) - 5000;
  }

  /**
   * After the orchestrator settled a session of an autopilot task, whatever it decided: write the
   * session's runtime row, then move a `running` attempt by where its task now is (§C.2.1).
   * An attempt a park, a stop or an approval refusal already moved is left alone.
   */
  afterSettle(taskId: string): void {
    this.db.transaction(() => {
      const attempt = this.rowOfTask(taskId);
      if (!attempt) return;
      this.syncRuntime(attempt.id);
      if (attempt.state !== "running" || this.liveSession(attempt.id)) return;
      const state = this.d.tasks.get(taskId)?.state as TaskState | undefined;
      if (state === "COMPLETED") this.setState(attempt.id, "settled");
      else if (state === "FAILED") this.finalize(attempt, "failed", "task failed");
      else if (state === "CANCELLED") this.finalize(attempt, "cancelled", "task cancelled");
      // More work is needed (a quota re-park, a context continuation, a failover) or a person is.
      else if (state && !isTerminal(state)) this.setState(attempt.id, "admitted", attempt.reason);
    })();
  }

  /**
   * §C.2.8: a denied or expired approval in an unattended run. One transaction: the attempt is
   * `blocked` (not retried) and the task's waits and dispatches are cancelled. Returns true when
   * the session must be cancelled, which the runner then does through its own cancel path.
   */
  approvalRefused(taskId: string, kind: "denied" | "expired"): boolean {
    return this.db.transaction((): boolean => {
      const attempt = this.rowOfTask(taskId);
      if (!attempt) return false;
      if (!isFinal(attempt.state)) this.finalize(attempt, "blocked", `approval ${kind}`);
      return true;
    })();
  }

  /**
   * Boot: runtime rows for sessions that ended while the plane was down, and attempts left
   * `running` by a crash moved by where their task is. Called after Harness recovery has settled
   * every session, and before the scheduler dispatches anything.
   */
  reconcileOnBoot(): void {
    this.syncRuntime();
    for (const r of this.db.prepare("SELECT task_id FROM autopilot_attempts WHERE state = 'running' AND task_id IS NOT NULL").all() as { task_id: string }[]) {
      this.afterSettle(r.task_id);
    }
  }
}
