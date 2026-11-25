/**
 * qcq-04a: execution attempts (docs/agentic-os-qcq-review-packet.md 2.1, 2.3, 2.4.1, 2.12).
 *
 * One provider execution is one attempt row, created before any provider call, and the attempt owns
 * its resource claims. This slice ships the compat attempts (written beside today's K4b claim on
 * every start path), the ownership-only provider-entry commit, the session-terminal rule and the
 * weak settlement proofs. Account claims, cgroups, strong proofs and the W/R/G grant transactions
 * arrive in qcq-04b; nothing here changes who runs or when a K4b pool slot is released.
 *
 * The entry invariant: at runtime the only transition into `starting` is `enterProvider`, and the
 * adapter call is the statement after it. So a `queued` or `held` attempt has never entered a provider.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isTerminal, redactValue, type TaskState } from "@agent-plane/core";
import type { Db } from "../db/index.js";

export type AttemptState = "queued" | "held" | "starting" | "live" | "stopping" | "ambiguous" | "settled" | "dropped";
export type AttemptKind = "dispatch" | "direct" | "candidate";
export type ExecutionPath = "harness" | "legacy";
export type ExitProof =
  | "cgroup_empty" | "unscoped_exit" | "host_rebooted" | "operator_confirmed" | "never_entered"
  | "stream_closed_unverified" | "boot_unverified" | "task_terminal_unverified" | "migrated_historical";

/** The states in which an attempt holds claims (packet 2.1). */
export const OWNER_STATES: readonly AttemptState[] = ["held", "starting", "live", "stopping", "ambiguous"];
const OWNER_SQL = "('held','starting','live','stopping','ambiguous')";
const SESSION_TERMINAL_SQL = "('COMPLETED','FAILED','CANCELLED','TIMED_OUT','YIELDED')";

export interface AttemptRow {
  attempt_id: string;
  task_id: string;
  kind: AttemptKind;
  execution_path: ExecutionPath;
  dispatch_id: string | null;
  candidate_slot: number;
  assistant_id: string | null;
  routing_decision_id: number | null;
  run_as: "plane" | "agent";
  account_key: string | null;
  account_source: string;
  queue_key: string;
  state: AttemptState;
  session_id: string | null;
  entered_at: string | null;
  entered_boot_id: string | null;
  stop_requested_at: string | null;
  provider_unit: string | null;
  exit_proof: ExitProof | null;
  exit_proof_at: string | null;
  occupies_account: string | null;
  predecessor_id: string | null;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
  final_at: string | null;
  reason: string | null;
}

export interface LiveClaim {
  claim_id: number;
  attempt_id: string;
  task_id: string;
  dispatch_id: string | null;
  generation: number | null;
  resource: string;
  units: number;
  claimed_at: string;
}

export interface Requirement { resource: string; units: number; queuedAt: string }

/** A claim this module released, so the caller can wake that pool's next waiter once committed. */
export interface Released { taskId: string; dispatchId: string | null; resource: string; units: number; reason: string }

export type EntryResult =
  | { ok: true; attempt: AttemptRow }
  /** The caller is not the attempt's owner. Nothing changed; no provider call. */
  | { ok: false; kind: "not_owner"; reason: string }
  /** The owner was refused. The attempt is now `dropped` `never_entered` and its claims are released. */
  | { ok: false; kind: "refused"; reason: string };

export interface EntryContext {
  /** Exactly one locator: the attempt itself, the Harness session bound to it, or its dispatch. */
  attemptId?: string;
  sessionId?: string;
  dispatchId?: string;
  path: ExecutionPath;
  /** Harness: the caller's fencing lease. A replaced or expired lease is `not_owner` (packet 2.4.1 step 1). */
  leaseToken?: string;
}

let cachedBootId: string | undefined;
/** `/proc/sys/kernel/random/boot_id`: changes exactly at boot (packet 2.6.1). */
export function currentBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unavailable";
  } catch {
    cachedBootId = "unavailable";
  }
  return cachedBootId;
}

type ReleaseListener = (released: Released[]) => void;
const listeners = new WeakMap<Db, Set<ReleaseListener>>();
/** The scheduler registers here, so a release made outside it (the session-terminal rule) still wakes the pool. */
export function onClaimsReleased(db: Db, fn: ReleaseListener): () => void {
  let set = listeners.get(db);
  if (!set) listeners.set(db, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
/** After the enclosing (synchronous) transaction commits. */
export function announceReleased(db: Db, released: Released[]): void {
  if (!released.length) return;
  const set = listeners.get(db);
  if (!set?.size) return;
  queueMicrotask(() => {
    for (const fn of set) {
      try { fn(released); } catch { /* a listener never fails the release that already committed */ }
    }
  });
}

/**
 * The provider-entry commit, ownership-only form (qcq-04a: packet 2.4.1 steps 1 and 6; the account,
 * autopilot, qcq-05 and deadline steps arrive in 04b). One synchronous transaction. The caller's
 * next statement is the adapter call, guarded by `.ok`.
 */
export function enterProvider(db: Db, ctx: EntryContext, now: () => Date = () => new Date()): EntryResult {
  const result = db.transaction(() => new AttemptStore(db, now).enterInTransaction(ctx))();
  if (!result.ok && result.kind === "refused") announceReleased(db, result.released);
  if (result.ok) return { ok: true, attempt: result.attempt };
  return { ok: false, kind: result.kind, reason: result.reason };
}

export class AttemptStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  private iso(): string { return this.now().toISOString(); }

  get(attemptId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM execution_attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
  }
  forDispatch(dispatchId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM execution_attempts WHERE dispatch_id = ?").get(dispatchId) as AttemptRow | undefined;
  }
  forSession(sessionId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM execution_attempts WHERE session_id = ?").get(sessionId) as AttemptRow | undefined;
  }
  /** The task's attempts, oldest first; `open` = owner states only. */
  ofTask(taskId: string, open = false): AttemptRow[] {
    return this.db.prepare(`SELECT * FROM execution_attempts WHERE task_id = ?${open ? ` AND state IN ${OWNER_SQL}` : ""}
      ORDER BY created_at, rowid`).all(taskId) as AttemptRow[];
  }
  /** Every attempt in an owner state, for the sweep. */
  open(): AttemptRow[] {
    return this.db.prepare(`SELECT * FROM execution_attempts WHERE state IN ${OWNER_SQL} ORDER BY created_at, rowid`).all() as AttemptRow[];
  }
  requirements(attemptId: string): Requirement[] {
    return (this.db.prepare("SELECT resource, units, queued_at FROM attempt_requirements WHERE attempt_id = ? ORDER BY resource")
      .all(attemptId) as { resource: string; units: number; queued_at: string }[]).map((r) => ({ resource: r.resource, units: r.units, queuedAt: r.queued_at }));
  }
  /** Every live claim of one attempt (packet 2.3.2 `claimsOf`). */
  claimsOf(attemptId: string): LiveClaim[] {
    return this.db.prepare(`SELECT claim_id, attempt_id, task_id, dispatch_id, generation, resource, units, claimed_at
      FROM resource_claims WHERE attempt_id = ? AND released_at IS NULL ORDER BY resource`).all(attemptId) as LiveClaim[];
  }

  /** The next free candidate ordinal of a compare or race task: 1..n, never reused. */
  nextCandidateSlot(taskId: string): number {
    const row = this.db.prepare("SELECT MAX(candidate_slot) AS m FROM execution_attempts WHERE task_id = ?").get(taskId) as { m: number | null };
    return Math.max(0, row.m ?? 0) + 1;
  }

  /**
   * A compat attempt (packet 2.12), `held` from creation: every requirement it has is already granted
   * by the caller in the same transaction (the K4b wake claim), or it has none. Callers run inside
   * their own start transaction and insert any claim after this row.
   */
  createHeld(input: {
    taskId: string;
    kind: AttemptKind;
    path: ExecutionPath;
    slot: number;
    runAs: "plane" | "agent";
    dispatchId?: string;
    sessionId?: string;
    assistantId?: string;
    routingDecisionId?: number | null;
    queueKey?: string;
    requirements?: Requirement[];
    reason?: string;
  }): AttemptRow {
    const id = `att_${randomUUID()}`;
    const at = this.iso();
    this.db.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, dispatch_id, candidate_slot, assistant_id,
        routing_decision_id, run_as, account_source, queue_key, state, session_id, created_at, updated_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, 'held', ?, ?, ?, ?)`)
      .run(id, input.taskId, input.kind, input.path, input.dispatchId ?? null, input.slot, input.assistantId ?? null,
        input.routingDecisionId ?? null, input.runAs, input.queueKey ?? at, input.sessionId ?? null, at, at, input.reason ?? "compat");
    for (const r of input.requirements ?? []) {
      this.db.prepare("INSERT INTO attempt_requirements (attempt_id, resource, units, queued_at) VALUES (?, ?, ?, ?)").run(id, r.resource, r.units, r.queuedAt);
    }
    return this.get(id)!;
  }

  /** Binds the session or run row that carries this attempt. A legacy run row is the provider's handle: `starting` becomes `live`. */
  bindSession(attemptId: string, sessionId: string, live: boolean): void {
    this.db.prepare(`UPDATE execution_attempts SET session_id = ?, updated_at = ?,
        state = CASE WHEN ? AND state = 'starting' THEN 'live' ELSE state END
      WHERE attempt_id = ? AND (session_id IS NULL OR session_id = ?)`).run(sessionId, this.iso(), live ? 1 : 0, attemptId, sessionId);
  }

  /** Releases every live claim of an attempt. Inside the caller's transaction. */
  private releaseClaims(a: AttemptRow, reason: string): Released[] {
    const released: Released[] = [];
    for (const c of this.claimsOf(a.attempt_id)) {
      this.db.prepare("UPDATE resource_claims SET released_at = ?, release_reason = ? WHERE claim_id = ? AND released_at IS NULL").run(this.iso(), reason, c.claim_id);
      this.event(c.task_id, "resource.released", c.dispatch_id, { resource: c.resource, units: c.units, reason, attemptId: a.attempt_id });
      released.push({ taskId: c.task_id, dispatchId: c.dispatch_id, resource: c.resource, units: c.units, reason });
    }
    return released;
  }

  /**
   * Makes an owner attempt final, releasing its claims in the same transaction. A `held` attempt
   * never entered, so it is `dropped` `never_entered` whatever the caller asked for.
   */
  finalize(a: AttemptRow, proof: ExitProof, reason: string): Released[] {
    if (!OWNER_STATES.includes(a.state)) return [];
    const held = a.state === "held";
    // The entry invariant read backwards: only `held` can be "never entered", and it can be nothing else.
    if (!held && proof === "never_entered") throw new Error(`attempt ${a.attempt_id} is ${a.state}; an entered attempt cannot be dropped as never entered`);
    const state: AttemptState = held ? "dropped" : "settled";
    const finalProof: ExitProof = held ? "never_entered" : proof;
    const at = this.iso();
    const changed = this.db.prepare(`UPDATE execution_attempts SET state = ?, exit_proof = ?, exit_proof_at = ?, final_at = ?, updated_at = ?, reason = ?
      WHERE attempt_id = ? AND state = ?`).run(state, finalProof, at, at, at, reason, a.attempt_id, a.state).changes;
    if (!changed) return [];
    const released = this.releaseClaims(a, reason);
    this.event(a.task_id, state === "dropped" ? "attempt.dropped" : "attempt.settled", a.dispatch_id,
      { attemptId: a.attempt_id, proof: finalProof, reason, slot: a.candidate_slot });
    return released;
  }

  /** Drops a `held` attempt (a refused or abandoned start). Never touches one that entered. */
  dropIfHeld(attemptId: string, reason: string): Released[] {
    const a = this.get(attemptId);
    return a?.state === "held" ? this.finalize(a, "never_entered", reason) : [];
  }

  /**
   * An in-process start whose call threw. Before the entry commit the attempt is `held` and drops
   * `never_entered`. After it, with no run row written, nothing in this process owns the call any
   * more, which is exactly K4b's view (no run row, no owner): the attempt settles
   * `stream_closed_unverified`. A bound attempt (a run row exists) is left to its run.
   */
  startFailed(attemptId: string, reason: string): Released[] {
    const a = this.get(attemptId);
    if (a?.state === "held") return this.finalize(a, "never_entered", reason);
    if (a?.state === "starting" && !a.session_id) return this.finalize(a, "stream_closed_unverified", reason);
    return [];
  }

  /**
   * The session-terminal rule (packet 2.1): inside `SessionStore.terminalize`'s transaction, a
   * session that ends without the commit drops its `held` attempt. `starting` or later is left alone.
   */
  sessionEnded(sessionId: string): Released[] {
    const a = this.forSession(sessionId);
    return a?.state === "held" ? this.finalize(a, "never_entered", "session ended before provider entry") : [];
  }

  /** Whether a run or session row still owns execution: the K4b `hasOwner` predicate, for one row. */
  private runOwns(runId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM runs r WHERE r.id = ? AND (r.ended_at IS NULL OR
      (r.execution_request_id IS NOT NULL AND (r.session_state NOT IN ${SESSION_TERMINAL_SQL} OR
       NOT EXISTS (SELECT 1 FROM execution_results er WHERE er.session_id = r.id))))`).get(runId);
  }

  /**
   * Does anything still own this attempt's execution? A session or run row, or an open dispatch.
   * A direct or candidate attempt that has no row yet is owned by the start in this process; at
   * boot that process is gone, so it is not.
   */
  owned(a: AttemptRow, mode: "runtime" | "boot"): boolean {
    if (a.session_id) return this.runOwns(a.session_id);
    if (a.dispatch_id) {
      const d = this.db.prepare("SELECT phase, session_id FROM dispatches WHERE dispatch_id = ?").get(a.dispatch_id) as { phase: string; session_id: string | null } | undefined;
      if (!d) return false;
      if (d.phase === "reserved" || d.phase === "start_attempted") return true;
      return d.session_id ? this.runOwns(d.session_id) : false;
    }
    return mode === "runtime";
  }

  /**
   * qcq-04a settlement at exactly today's K4b release points (packet 2.12). A terminal task releases
   * everything (`task_terminal_unverified`, possibly while a stream is still open: the K4b ceiling);
   * otherwise an attempt nothing owns any more settles at the end of its stream
   * (`stream_closed_unverified`). At boot the owning incarnation is dead: `boot_unverified`.
   * Inside the caller's transaction.
   */
  settleIdle(taskId: string, mode: "runtime" | "boot", reason: string): Released[] {
    const task = this.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string } | undefined;
    const terminal = !task || isTerminal(task.state as TaskState);
    const released: Released[] = [];
    for (const a of this.ofTask(taskId, true)) {
      if (!terminal && this.owned(a, mode)) continue;
      const proof: ExitProof = a.state === "held" ? "never_entered"
        : mode === "boot" ? "boot_unverified"
        : terminal ? "task_terminal_unverified" : "stream_closed_unverified";
      released.push(...this.finalize(a, proof, reason));
    }
    return released;
  }

  /** Inside a transaction. See `enterProvider`. */
  enterInTransaction(ctx: EntryContext): { ok: true; attempt: AttemptRow } | { ok: false; kind: "not_owner"; reason: string } | { ok: false; kind: "refused"; reason: string; released: Released[] } {
    const a = ctx.attemptId ? this.get(ctx.attemptId) : ctx.sessionId ? this.forSession(ctx.sessionId) : ctx.dispatchId ? this.forDispatch(ctx.dispatchId) : undefined;
    const notOwner = (reason: string) => ({ ok: false as const, kind: "not_owner" as const, reason });
    if (!a) return notOwner("no attempt owns this start");
    if (a.state !== "held") return notOwner(`attempt ${a.attempt_id} is ${a.state}`);
    if (a.execution_path !== ctx.path) return notOwner(`attempt ${a.attempt_id} runs on the ${a.execution_path} path`);
    if (ctx.sessionId && a.session_id && a.session_id !== ctx.sessionId) return notOwner(`attempt ${a.attempt_id} is bound to session ${a.session_id}`);
    if (ctx.dispatchId && a.dispatch_id !== ctx.dispatchId) return notOwner(`attempt ${a.attempt_id} is not bound to dispatch ${ctx.dispatchId}`);
    const nowIso = this.iso();
    let run: { cancel_requested: number } | undefined;
    if (ctx.path === "harness") {
      if (!ctx.sessionId || !ctx.leaseToken) return notOwner("a Harness entry needs its session and lease");
      run = this.db.prepare("SELECT cancel_requested FROM runs WHERE id = ? AND lease_token = ? AND lease_expires_at > ?")
        .get(ctx.sessionId, ctx.leaseToken, nowIso) as { cancel_requested: number } | undefined;
      if (!run) return notOwner(`the lease of session ${ctx.sessionId} is not current`);
    }
    let dispatch: { phase: string; session_id: string | null } | undefined;
    if (a.kind === "dispatch") {
      dispatch = this.db.prepare("SELECT phase, session_id FROM dispatches WHERE dispatch_id = ?").get(a.dispatch_id) as typeof dispatch;
      if (dispatch?.session_id && ctx.sessionId && dispatch.session_id !== ctx.sessionId) return notOwner(`dispatch ${a.dispatch_id} is bound to session ${dispatch.session_id}`);
    }

    const refuse = (reason: string) => ({ ok: false as const, kind: "refused" as const, reason, released: this.finalize(a, "never_entered", `provider entry refused: ${reason}`) });
    if (a.stop_requested_at) return refuse("stop_requested");
    const task = this.db.prepare("SELECT state FROM tasks WHERE id = ?").get(a.task_id) as { state: string } | undefined;
    if (!task || task.state === "CANCELLED") return refuse("task_cancelled");
    if (run?.cancel_requested) return refuse("cancel_requested");
    if (a.kind === "dispatch" && (!dispatch || !["start_attempted", "started"].includes(dispatch.phase))) {
      return refuse(`dispatch_${dispatch?.phase ?? "missing"}`);
    }
    const held = new Map(this.claimsOf(a.attempt_id).map((c) => [c.resource, c.units]));
    for (const r of this.requirements(a.attempt_id)) {
      if ((held.get(r.resource) ?? 0) < r.units) return refuse(`claim_missing:${r.resource}`);
    }

    this.db.prepare(`UPDATE execution_attempts SET state = 'starting', entered_at = ?, entered_boot_id = ?, updated_at = ?,
        session_id = COALESCE(session_id, ?)
      WHERE attempt_id = ? AND state = 'held'`).run(nowIso, currentBootId(), nowIso, ctx.sessionId ?? null, a.attempt_id);
    this.event(a.task_id, "attempt.entered", a.dispatch_id, { attemptId: a.attempt_id, path: a.execution_path, slot: a.candidate_slot });
    return { ok: true, attempt: this.get(a.attempt_id)! };
  }

  private event(taskId: string, type: string, dispatchId: string | null, payload: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO scheduler_events (task_id, generation, dispatch_id, type, at, payload) VALUES (?, NULL, ?, ?, ?, ?)")
      .run(taskId, dispatchId, type, this.iso(), JSON.stringify(redactValue(payload)));
  }
}

/** The task's open attempts, as `GET /api/tasks/:id` serves them (packet 2.3.2, API 2.19). */
export interface AttemptStatus {
  attemptId: string;
  kind: AttemptKind;
  executionPath: ExecutionPath;
  slot: number;
  state: AttemptState;
  assistantId: string | null;
  dispatchId: string | null;
  sessionId: string | null;
  account: { key: string | null; source: string };
  enteredAt: string | null;
  requirements: { resource: string; units: number }[];
  claims: { resource: string; units: number; dispatchId: string | null; claimedAt: string }[];
}

export function attemptStatuses(db: Db, taskId: string): AttemptStatus[] {
  const store = new AttemptStore(db);
  return store.ofTask(taskId, true).map((a) => ({
    attemptId: a.attempt_id, kind: a.kind, executionPath: a.execution_path, slot: a.candidate_slot, state: a.state,
    assistantId: a.assistant_id, dispatchId: a.dispatch_id, sessionId: a.session_id,
    account: { key: a.account_key, source: a.account_source }, enteredAt: a.entered_at,
    requirements: store.requirements(a.attempt_id).map((r) => ({ resource: r.resource, units: r.units })),
    claims: store.claimsOf(a.attempt_id).map((c) => ({ resource: c.resource, units: c.units, dispatchId: c.dispatch_id, claimedAt: c.claimed_at })),
  }));
}
