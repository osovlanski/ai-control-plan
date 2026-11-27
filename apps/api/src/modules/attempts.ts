/**
 * qcq-04a: execution attempts (docs/agentic-os-qcq-review-packet.md 2.1, 2.3, 2.4.1, 2.12).
 *
 * One provider execution is one attempt row, created before any provider call, and the attempt owns
 * its resource claims. qcq-04a shipped the compat attempts (written beside today's K4b claim on
 * every start path), the ownership-only provider-entry commit and the session-terminal rule.
 * qcq-04b part 1 (packet 2.6) adds the release at proven provider exit: an attempt with a cgroup
 * unit is released only by a strong proof (`cgroup_empty`, `unscoped_exit`, `host_rebooted`,
 * `operator_confirmed`), one without a unit at the end of its event stream
 * (`stream_closed_unverified`, or `boot_unverified` when its plane incarnation is dead), and a
 * cancel moves an entered attempt to `stopping` with its claims held. A task's terminal transition
 * no longer releases anything that entered (packet 2.13 item 4).
 *
 * The entry invariant: at runtime the only transition into `starting` is `enterProvider`, and the
 * adapter call is the statement after it. So a `queued` or `held` attempt has never entered a provider.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isTerminal, redactText, redactValue, type TaskState } from "@agent-plane/core";
import type { Db } from "../db/index.js";
import { attemptUnit, exitEvidence, type UnitLane, type UnitOwner, type UnitState } from "./exit-evidence.js";

export type AttemptState = "queued" | "held" | "starting" | "live" | "stopping" | "ambiguous" | "settled" | "dropped";
export type AttemptKind = "dispatch" | "direct" | "candidate";
export type ExecutionPath = "harness" | "legacy";
export type ExitProof =
  | "cgroup_empty" | "unscoped_exit" | "host_rebooted" | "operator_confirmed" | "never_entered"
  | "stream_closed_unverified" | "boot_unverified" | "task_terminal_unverified" | "migrated_historical";

/** The states in which an attempt holds claims (packet 2.1). */
export const OWNER_STATES: readonly AttemptState[] = ["held", "starting", "live", "stopping", "ambiguous"];
const OWNER_SQL = "('held','starting','live','stopping','ambiguous')";
/** The owner states after the entry commit: a provider may be live. */
const ENTERED_STATES: readonly AttemptState[] = ["starting", "live", "stopping", "ambiguous"];
/**
 * `stopEvidenceMs` (packet 2.6.1): the run's hard-kill grace (the tracker's SIGTERM → SIGKILL,
 * 5 s) plus 60 s. An attempt with no proof that long after its stop or its execution's end becomes
 * `ambiguous` and keeps its claims.
 */
export const DEFAULT_STOP_EVIDENCE_MS = 65_000;
/** How often an entered attempt with a unit is re-read while it waits for its proof. */
export const DEFAULT_EXIT_WATCH_MS = 1_000;
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
  provider_unit_seen_at: string | null;
  /** #268 review: the plane incarnation that ran the entry commit (`plane_incarnations`). */
  entered_incarnation: string | null;
  /** #268 review: the manager the unit was assigned under (JSON `UnitOwner`). */
  provider_unit_owner: string | null;
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
  /**
   * qcq-04b: the cgroup unit the provider will run in (`AttemptStore.unitFor`), written by the
   * commit as `provider_unit`. Absent: the attempt has no strong exit evidence.
   */
  providerUnit?: string;
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

/**
 * What this plane incarnation knows about its own attempts, per database handle. Each handle is
 * one incarnation with a durable id (`plane_incarnations`, written at its first entry commit), so
 * another connection or a restarted plane can tell a live incarnation from a dead one (#268 review
 * finding 2) instead of reading every attempt it did not enter itself as dead.
 */
interface Incarnation {
  id: string;
  /**
   * Attempts entered here whose provider event stream has not closed yet: the adapter call is
   * unsettled, or its stream is still open (#268 review finding 5). Until it closes, nothing reads
   * the attempt's provider as gone without a unit proof.
   */
  streams: Set<string>;
  /** The adapter's `spawnClosed` for each attempt this incarnation started a provider for, until the attempt is final. */
  spawns: Map<string, () => boolean>;
  /** Attempts of a dead incarnation whose populated unit this one already asked to stop. */
  stopsIssued: Set<string>;
  watchers: Map<string, ReturnType<typeof setInterval>>;
  stopEvidenceMs: number;
  watchMs: number;
}
const incarnations = new WeakMap<Db, Incarnation>();
/** This process's incarnations by id, so a second handle in the same process sees the first as live while it is open. */
const processIncarnations = new Map<string, WeakRef<Db>>();
function incarnation(db: Db): Incarnation {
  let inc = incarnations.get(db);
  if (!inc) {
    inc = { id: `inc_${randomUUID()}`, streams: new Set(), spawns: new Map(), stopsIssued: new Set(), watchers: new Map(),
      stopEvidenceMs: DEFAULT_STOP_EVIDENCE_MS, watchMs: DEFAULT_EXIT_WATCH_MS };
    incarnations.set(db, inc);
    processIncarnations.set(inc.id, new WeakRef(db));
  }
  return inc;
}
/**
 * Writes this handle's incarnation row (idempotent): its pid, process start time and boot. Written at
 * the first lease or entry commit, whichever comes first, so a second plane that boots meanwhile
 * can tell this one is alive (#272 review). Runs inside the caller's transaction when there is one.
 */
export function ensureIncarnationRow(db: Db, nowIso: string): string {
  const inc = incarnation(db);
  const ev = exitEvidence(db);
  const boot = ev.bootId();
  const start = ev.processStart(process.pid);
  db.prepare("INSERT OR IGNORE INTO plane_incarnations (incarnation_id, pid, proc_start, boot_id, started_at) VALUES (?, ?, ?, ?, ?)")
    .run(inc.id, process.pid, start === null || start === "unreadable" ? null : start, boot === "unavailable" ? currentBootId() : boot, nowIso);
  return inc.id;
}

/**
 * Who a recorded incarnation is, from this handle's point of view: this one, another that is still
 * running (another open handle in this process, or a process whose pid still has the start time it
 * recorded on this boot), or a dead one. A process whose start time cannot be read is taken as
 * alive: nothing proves it gone. An unknown id is dead.
 */
export function incarnationState(db: Db, id: string | null | undefined): "here" | "alive" | "dead" {
  if (!id) return "dead";
  const inc = incarnation(db);
  if (id === inc.id) return "here";
  const local = processIncarnations.get(id)?.deref();
  if (local?.open) return "alive";
  const row = db.prepare("SELECT pid, proc_start, boot_id FROM plane_incarnations WHERE incarnation_id = ?")
    .get(id) as { pid: number; proc_start: string | null; boot_id: string } | undefined;
  if (!row) return "dead";
  const ev = exitEvidence(db);
  const boot = ev.bootId();
  if (row.boot_id !== "unavailable" && boot !== "unavailable" && row.boot_id !== boot) return "dead";
  // This process's own pid: a handle it opened is in the map above, so any other is gone.
  if (row.pid === process.pid) return "dead";
  const start = ev.processStart(row.pid);
  if (start === null) return "dead";
  if (start === "unreadable" || row.proc_start === null) return "alive";
  return start === row.proc_start ? "alive" : "dead";
}

/** Test and host tuning of the exit-proof timings for this database's plane. */
export function configureExitProofs(db: Db, opts: { stopEvidenceMs?: number; watchMs?: number }): void {
  const inc = incarnation(db);
  if (opts.stopEvidenceMs !== undefined) inc.stopEvidenceMs = opts.stopEvidenceMs;
  if (opts.watchMs !== undefined) inc.watchMs = opts.watchMs;
}
/**
 * The runner registers its adapter's spawn-closed report as soon as the provider call settled, so
 * an absent, never-registered unit can be read as `unscoped_exit` once the spawn path is closed.
 */
export function registerSpawn(db: Db, attemptId: string, closed: () => boolean): void {
  incarnation(db).spawns.set(attemptId, closed);
}

/**
 * Recovery stops a dead incarnation's provider once per attempt per incarnation (#272 review): the
 * boot reaper and the proof test both ask here, and only the first gets true.
 */
export function claimRecoveryStop(db: Db, attemptId: string): boolean {
  const inc = incarnation(db);
  if (inc.stopsIssued.has(attemptId)) return false;
  inc.stopsIssued.add(attemptId);
  return true;
}
/** A recovery stop that could not be issued: the next proof test, or the next boot's reaper, may try again. */
export function releaseRecoveryStop(db: Db, attemptId: string): void {
  incarnation(db).stopsIssued.delete(attemptId);
}

/**
 * The boot reaper's view of one recorded agent unit id (the attempt id, or a pre-attempt session
 * id): the attempt's recorded unit owner, and whether this incarnation may stop it now. An attempt
 * a live incarnation holds is never stopped by recovery. The claim is the caller's to give back
 * (`releaseRecoveryStop`) when its stop command could not be issued.
 */
export function recoveryStopFor(db: Db, unitId: string): { attempt: boolean; stop: boolean; attemptId?: string; unit?: string; owner?: UnitOwner } {
  const store = new AttemptStore(db);
  const a = store.get(unitId);
  if (!a || !a.provider_unit) return { attempt: false, stop: true };
  if (store.incarnationOf(a) === "alive") return { attempt: true, stop: false };
  const owner = store.unitOwner(a.attempt_id);
  return { attempt: true, stop: claimRecoveryStop(db, a.attempt_id), attemptId: a.attempt_id, unit: a.provider_unit, ...(owner ? { owner } : {}) };
}

/**
 * #272 review: a Harness session another live plane incarnation still holds, so boot recovery
 * leaves its lease and its state alone. The holder is the incarnation that took the session's lease
 * (`runs.lease_incarnation`, written with the lease, before any provider entry), so a session still
 * waiting for a provider start slot is held too. An entered attempt of a live incarnation counts as
 * well. A lease no incarnation recorded (a row from before migration 060) is a dead one's.
 */
export function heldByLiveIncarnation(db: Db, sessionId: string): boolean {
  const lease = db.prepare("SELECT lease_token, lease_incarnation FROM runs WHERE id = ?").get(sessionId) as { lease_token: string | null; lease_incarnation: string | null } | undefined;
  if (lease?.lease_token && incarnationState(db, lease.lease_incarnation) === "alive") return true;
  const store = new AttemptStore(db);
  const a = store.forSession(sessionId);
  return !!a && ENTERED_STATES.includes(a.state) && store.incarnationOf(a) === "alive";
}

/** A task whose open attempt or latest Harness session a live plane incarnation holds: boot reconciliation of the task is that plane's. */
export function taskHeldByLiveIncarnation(db: Db, taskId: string): boolean {
  const store = new AttemptStore(db);
  if (store.ofTask(taskId, true).some((a) => ENTERED_STATES.includes(a.state) && store.incarnationOf(a) === "alive")) return true;
  const sessions = db.prepare("SELECT id FROM runs WHERE task_id = ? AND execution_request_id IS NOT NULL AND ended_at IS NULL").all(taskId) as { id: string }[];
  return sessions.some((r) => heldByLiveIncarnation(db, r.id));
}

/**
 * #268 review finding 5: the provider's event stream of an attempt entered here has closed (its
 * iterator finished or failed, or the provider call rejected). Until then a unitless attempt is
 * not settled by `stream_closed_unverified`, however its session or run ended. Settles the attempt
 * if nothing else holds it, and announces what that released.
 */
export function providerStreamClosed(db: Db, attemptId: string, now: () => Date = () => new Date()): void {
  const inc = incarnation(db);
  if (!inc.streams.delete(attemptId) || !db.open) return;
  const released = db.transaction(() => {
    const store = new AttemptStore(db, now);
    const a = store.get(attemptId);
    return a ? store.settleEntered(a, "provider event stream closed") : [];
  })();
  announceReleased(db, released);
}

/**
 * Re-reads an entered attempt until it is final (or `ambiguous`, which the sweep keeps checking):
 * with a unit, registration while the provider runs, then the proof once it has gone; without one,
 * the stop deadline. Unref'd; stops itself when the database closes.
 */
export function watchExit(db: Db, attemptId: string, now: () => Date = () => new Date()): void {
  const inc = incarnation(db);
  if (inc.watchers.has(attemptId)) return;
  const timer = setInterval(() => {
    if (!db.open) { clearInterval(timer); inc.watchers.delete(attemptId); return; }
    try {
      const released: Released[] = [];
      const done = db.transaction(() => {
        const store = new AttemptStore(db, now);
        const a = store.get(attemptId);
        // Unitless attempts too (#272 review): an attempt whose stream outlived its execution must
        // reach `ambiguous` with no scheduler running the sweep.
        if (!a || !ENTERED_STATES.includes(a.state) || a.state === "ambiguous") return true;
        released.push(...store.settleEntered(a, "exit watch"));
        const after = store.get(attemptId)!;
        return !ENTERED_STATES.includes(after.state) || after.state === "ambiguous";
      })();
      announceReleased(db, released);
      // The watch stops at `ambiguous` (the sweep keeps reading it), but the spawn-closed report
      // stays until the attempt is final: `finalize` drops it (#268 review finding 8).
      if (done) { clearInterval(timer); inc.watchers.delete(attemptId); }
    } catch {
      // A transient read or lock failure: the next tick, or the scheduler's sweep, tries again.
    }
  }, inc.watchMs);
  timer.unref();
  inc.watchers.set(attemptId, timer);
}
/** Stops every exit watch of this database (shutdown, tests). */
export function stopExitWatches(db: Db): void {
  const inc = incarnations.get(db);
  if (!inc) return;
  for (const t of inc.watchers.values()) clearInterval(t);
  inc.watchers.clear();
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
  /** Whether the attempt ever held an account claim (the `trg_attempt_weak_proof` predicate). */
  private heldAccount(attemptId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM resource_claims WHERE attempt_id = ? AND resource LIKE 'account:%'").get(attemptId);
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
        input.routingDecisionId ?? null, input.runAs, input.queueKey ?? at, input.sessionId ?? null, at, at, redactText(input.reason ?? "compat"));
    for (const r of input.requirements ?? []) {
      this.db.prepare("INSERT INTO attempt_requirements (attempt_id, resource, units, queued_at) VALUES (?, ?, ?, ?)").run(id, r.resource, r.units, r.queuedAt);
    }
    return this.get(id)!;
  }

  /**
   * W (packet 2.5.2): a dispatch attempt created `queued` by the wake, bound to the `reserved`
   * dispatch, its route in flight (`account_source = 'pending'`). It holds nothing; its known
   * requirements (the wait's pool) count as in use until the reservation grants or re-parks it.
   */
  createQueued(input: { taskId: string; dispatchId: string; path: ExecutionPath; runAs: "plane" | "agent"; queueKey: string; requirements: Requirement[]; reason?: string }): AttemptRow {
    const id = `att_${randomUUID()}`;
    const at = this.iso();
    this.db.prepare(`INSERT INTO execution_attempts (attempt_id, task_id, kind, execution_path, dispatch_id, candidate_slot, run_as,
        account_source, queue_key, state, created_at, updated_at, reason)
      VALUES (?, ?, 'dispatch', ?, ?, 0, ?, 'pending', ?, 'queued', ?, ?, ?)`)
      .run(id, input.taskId, input.path, input.dispatchId, input.runAs, input.queueKey, at, at, redactText(input.reason ?? "wake"));
    for (const r of input.requirements) {
      this.db.prepare("INSERT INTO attempt_requirements (attempt_id, resource, units, queued_at) VALUES (?, ?, ?, ?)").run(id, r.resource, r.units, r.queuedAt);
    }
    return this.get(id)!;
  }

  /**
   * R (packet 2.4 step 3): fixes the attempt's route and its account. The account requirement joins
   * the known ones at the attempt's own `queue_key`, which never changes.
   */
  setRoute(attemptId: string, route: { routingDecisionId: number; assistantId: string; account: { key: string | null; source: string; hash: string | null; units?: number } }): AttemptRow {
    const a = this.get(attemptId)!;
    this.db.prepare(`UPDATE execution_attempts SET routing_decision_id = ?, assistant_id = ?, account_key = ?, account_source = ?, account_config_hash = ?, updated_at = ?
      WHERE attempt_id = ? AND state = 'queued'`).run(route.routingDecisionId, route.assistantId, route.account.key, route.account.source, route.account.hash, this.iso(), attemptId);
    this.db.prepare("DELETE FROM attempt_requirements WHERE attempt_id = ? AND resource LIKE 'account:%'").run(attemptId);
    if (route.account.key) {
      this.db.prepare("INSERT INTO attempt_requirements (attempt_id, resource, units, queued_at) VALUES (?, ?, ?, ?)").run(attemptId, route.account.key, route.account.units ?? 1, a.queue_key);
    }
    return this.get(attemptId)!;
  }

  /**
   * Units of `resource` that `pending` attempts (a route in flight, W to R) are known to need. They
   * count as in use, so a second wake cannot take a slot an in-flight reservation is about to claim
   * (packet 2.5.1 rule 4, 2.5.3 "the gap").
   */
  pendingUnits(resource: string, exceptAttempt?: string): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(r.units), 0) AS n FROM attempt_requirements r
      JOIN execution_attempts a ON a.attempt_id = r.attempt_id
      JOIN dispatches d ON d.dispatch_id = a.dispatch_id
      WHERE r.resource = ? AND a.state = 'queued' AND a.account_source = 'pending' AND d.phase = 'reserved' AND a.attempt_id != ?`)
      .get(resource, exceptAttempt ?? "") as { n: number }).n;
  }

  /**
   * R or G (packet 2.5.2): grants every requirement of a `queued` attempt bound to `dispatchId`. The
   * attempt moves to `held` first, so `trg_claim_account_harness` sees its owner, then each claim is
   * inserted with that dispatch. Inside the caller's transaction.
   */
  grant(attemptId: string, dispatchId: string, generation: number | null): LiveClaim[] {
    const at = this.iso();
    const moved = this.db.prepare("UPDATE execution_attempts SET state = 'held', dispatch_id = ?, updated_at = ? WHERE attempt_id = ? AND state = 'queued'")
      .run(dispatchId, at, attemptId).changes;
    if (!moved) throw new Error(`attempt ${attemptId} is not queued`);
    const a = this.get(attemptId)!;
    for (const r of this.requirements(attemptId)) {
      this.db.prepare("INSERT INTO resource_claims (attempt_id, task_id, dispatch_id, generation, resource, units, account_source, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(attemptId, a.task_id, dispatchId, generation, r.resource, r.units, r.resource.startsWith("account:") ? a.account_source : null, at);
    }
    return this.claimsOf(attemptId);
  }

  /** R's no-grant branch (packet 2.5.3): the attempt keeps its route and `queue_key`, unbound from the re-parked dispatch. */
  unbindQueued(attemptId: string): void {
    this.db.prepare("UPDATE execution_attempts SET dispatch_id = NULL, updated_at = ? WHERE attempt_id = ? AND state = 'queued'").run(this.iso(), attemptId);
  }

  /** A `queued` attempt that will never be granted (a cancel, a refusal, a re-park that replaced it). It held nothing. */
  dropQueued(attemptId: string, reason: string): void {
    const a = this.get(attemptId);
    if (a?.state !== "queued") return;
    const at = this.iso();
    const changed = this.db.prepare(`UPDATE execution_attempts SET state = 'dropped', exit_proof = 'never_entered', exit_proof_at = ?, final_at = ?, updated_at = ?, reason = ?
      WHERE attempt_id = ? AND state = 'queued'`).run(at, at, at, redactText(reason), attemptId).changes;
    if (changed) this.event(a.task_id, "attempt.dropped", a.dispatch_id, { attemptId, proof: "never_entered", reason, slot: a.candidate_slot });
  }

  /**
   * G's worklist (packet 2.5.1): every `queued` dispatch attempt, in the global order. Routed ones
   * wait on a condition naming them; pending ones are in the W to R gap.
   */
  queuedInOrder(): AttemptRow[] {
    return this.db.prepare(`SELECT * FROM execution_attempts WHERE state = 'queued' AND kind = 'dispatch'
      ORDER BY queue_key, task_id, candidate_slot`).all() as AttemptRow[];
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
      this.db.prepare("UPDATE resource_claims SET released_at = ?, release_reason = ? WHERE claim_id = ? AND released_at IS NULL").run(this.iso(), redactText(reason), c.claim_id);
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
      WHERE attempt_id = ? AND state = ?`).run(state, finalProof, at, at, at, redactText(reason), a.attempt_id, a.state).changes;
    if (!changed) return [];
    const inc = incarnation(this.db);
    inc.streams.delete(a.attempt_id); inc.spawns.delete(a.attempt_id); inc.stopsIssued.delete(a.attempt_id);
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
    incarnation(this.db).streams.delete(attemptId); // the call rejected: it holds no stream
    if ((a?.state === "starting" || a?.state === "stopping") && !a.session_id) return this.finalize(a, "stream_closed_unverified", reason);
    return [];
  }

  /**
   * #264 review finding 5: a direct or candidate legacy start whose adapter returned a handle and
   * then failed before its run was registered. The caller has cancelled the provider. `drained`: its
   * stream ended, so the K4b release (`stream_closed_unverified`). Otherwise nothing proves it
   * stopped: the attempt is `ambiguous` and keeps its slot until the boot proof.
   */
  abandonedStart(attemptId: string, reason: string, drained: boolean): Released[] {
    const a = this.get(attemptId);
    if (!a || (a.state !== "starting" && a.state !== "live")) return [];
    if (drained) {
      incarnation(this.db).streams.delete(attemptId);
      return this.finalize(a, "stream_closed_unverified", reason);
    }
    const at = this.iso();
    const changed = this.db.prepare("UPDATE execution_attempts SET state = 'ambiguous', reason = ?, updated_at = ? WHERE attempt_id = ? AND state = ?")
      .run(redactText(reason), at, a.attempt_id, a.state).changes;
    if (changed) this.event(a.task_id, "attempt.ambiguous", a.dispatch_id, { attemptId: a.attempt_id, reason, slot: a.candidate_slot });
    return [];
  }

  /**
   * The session-terminal rule (packet 2.1): inside `SessionStore.terminalize`'s transaction, after
   * the result row, a session that ends without the commit drops its `held` attempt. An entered
   * attempt meets its proof test here: with no unit, the end of the session is the end of its event
   * stream (`stream_closed_unverified`); with a unit, only the cgroup decides, and an attempt still
   * waiting for it is watched after this transaction commits.
   */
  sessionEnded(sessionId: string): Released[] {
    const a = this.forSession(sessionId);
    if (!a) return [];
    if (a.state === "held") return this.finalize(a, "never_entered", "session ended before provider entry");
    const released = this.settleEntered(a, "session ended");
    if (a.provider_unit && OWNER_STATES.includes(this.get(a.attempt_id)!.state)) queueMicrotask(() => watchExit(this.db, a.attempt_id, this.now));
    return released;
  }

  /**
   * The legacy stream-end point (packet 2.13 item 4): `settleRun` wrote the run's `ended_at` after
   * the adapter's event stream drained. A legacy run never has a unit, so this is its release.
   */
  streamClosed(runId: string, closed = true): Released[] {
    const a = this.forSession(runId);
    if (!a) return [];
    // A run whose consumer failed with its stream still open (#272 review) keeps the stream until
    // the cancel-and-drain reports it (`providerStreamClosed`).
    if (closed) incarnation(this.db).streams.delete(a.attempt_id);
    return this.settleEntered(a, closed ? "event stream closed" : "run ended with its event stream open");
  }

  /** Whether this plane incarnation ran the attempt's entry commit. */
  enteredHere(attemptId: string): boolean {
    return this.get(attemptId)?.entered_incarnation === incarnation(this.db).id;
  }

  /**
   * Who holds an entered attempt's provider (#268 review finding 2): this incarnation, another one
   * that is still running (another connection in this process, or a plane process whose pid still
   * has the start time it recorded on this boot), or a dead one. Pre-migration rows record none and
   * read as dead, as before. A process whose start time cannot be read is taken as alive: nothing
   * proves it gone.
   */
  incarnationOf(a: AttemptRow): "here" | "alive" | "dead" {
    return incarnationState(this.db, a.entered_incarnation);
  }

  /** The manager the attempt's unit was assigned under, as recorded at entry. */
  private unitOwnerOf(a: AttemptRow): UnitOwner | undefined {
    if (!a.provider_unit_owner) return undefined;
    try { return JSON.parse(a.provider_unit_owner) as UnitOwner; } catch { return undefined; }
  }

  /** The recorded manager of an attempt's unit, for the operator's stop. */
  unitOwner(attemptId: string): UnitOwner | undefined {
    const a = this.get(attemptId);
    return a ? this.unitOwnerOf(a) : undefined;
  }

  /** This incarnation's provider stream for the attempt is still open. */
  private streamOpen(a: AttemptRow): boolean {
    return incarnation(this.db).streams.has(a.attempt_id);
  }

  /**
   * The unit an attempt's provider will run in, or undefined when it has no strong evidence: the
   * adapter does not spawn into a scope, or the host cannot read one on the attempt's lane. Only
   * the Harness assigns a unit; every legacy run is pool-only (packet 2.6.1).
   */
  unitFor(attemptId: string, scopedSpawn: boolean): string | undefined {
    const a = this.get(attemptId);
    if (!a || !scopedSpawn || a.execution_path !== "harness") return undefined;
    const lane: UnitLane = a.run_as === "agent" ? "agent" : "plane";
    return exitEvidence(this.db).unavailable(lane) === undefined ? attemptUnit(a.attempt_id, lane) : undefined;
  }

  /**
   * A stop asked of an entered attempt (a task cancel, a session-only cancel, the deadline): it
   * goes `stopping` and keeps every claim until its proof. A `held` attempt is left to the commit,
   * which refuses on the stop (`stop_requested`), or to the session-terminal rule.
   */
  requestStop(a: AttemptRow, reason: string): void {
    const at = this.iso();
    if (a.state === "held") {
      this.db.prepare("UPDATE execution_attempts SET stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE attempt_id = ? AND state = 'held'").run(at, at, a.attempt_id);
      return;
    }
    if (a.state !== "starting" && a.state !== "live") return;
    const changed = this.db.prepare(`UPDATE execution_attempts SET state = 'stopping', stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ?
      WHERE attempt_id = ? AND state = ?`).run(at, at, a.attempt_id, a.state).changes;
    if (changed) this.event(a.task_id, "attempt.stopping", a.dispatch_id, { attemptId: a.attempt_id, reason, slot: a.candidate_slot, from: a.state });
  }

  /** Every open attempt of the task is asked to stop (a task cancel). Inside the cancel transaction. */
  stopTask(taskId: string, reason: string): void {
    for (const a of this.ofTask(taskId, true)) this.requestStop(a, reason);
  }

  /**
   * The operator's proof (packet 2.6.1 `operator_confirmed`): refused with `unit_populated` while
   * the attempt's unit reads populated (the operator stops it first), and for a `live` attempt whose
   * execution still owns it (cancel it first). A `held` attempt never entered and is dropped.
   */
  confirmStopped(attemptId: string, reason: string): { ok: true; released: Released[]; attempt: AttemptRow } | { ok: false; code: "unknown" | "not_open" | "unit_populated" | "attempt_live"; unit?: string } {
    const a = this.get(attemptId);
    if (!a) return { ok: false, code: "unknown" };
    if (!OWNER_STATES.includes(a.state)) return { ok: false, code: "not_open" };
    if (a.provider_unit && exitEvidence(this.db).readUnit(a.provider_unit, a.run_as === "agent" ? "agent" : "plane", this.unitOwnerOf(a)) === "populated") {
      return { ok: false, code: "unit_populated", unit: a.provider_unit };
    }
    if (a.state !== "held") {
      const who = this.incarnationOf(a);
      // Another live plane holds it, or this one is still in its provider call or stream (#268
      // review finding 6: a `starting` attempt whose runner awaits its handle). `ambiguous` is the
      // operator's to settle: its stream outlived every proof.
      if (who === "alive") return { ok: false, code: "attempt_live" };
      if (who === "here" && a.state !== "ambiguous" && this.streamOpen(a)) return { ok: false, code: "attempt_live" };
      if (a.state === "live" && this.owned(a, who === "here" ? "runtime" : "boot")) return { ok: false, code: "attempt_live" };
    }
    const released = this.finalize(a, a.state === "held" ? "never_entered" : "operator_confirmed", reason);
    return { ok: true, released, attempt: this.get(attemptId)! };
  }

  /** When the attempt's execution ended: its session's or run's `ended_at`. */
  private executionEndedAt(a: AttemptRow): string | undefined {
    if (!a.session_id) return undefined;
    return (this.db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(a.session_id) as { ended_at: string | null } | undefined)?.ended_at ?? undefined;
  }

  /**
   * No proof yet. An attempt asked to stop, or whose execution has ended, that has had no proof for
   * `stopEvidenceMs` becomes `ambiguous`: its claims stay held and the operator is told
   * (`attempt.stop_unconfirmed`). Only a strong proof or the operator settles it from there.
   */
  private awaitProof(a: AttemptRow): Released[] {
    if (a.state === "ambiguous") return [];
    const since = a.stop_requested_at ?? this.executionEndedAt(a);
    if (!since) return [];
    const waited = this.now().getTime() - Date.parse(since);
    if (waited < incarnation(this.db).stopEvidenceMs) {
      // Re-read until the deadline whatever runs the sweep (#272 review: scheduling disabled).
      const id = a.attempt_id;
      queueMicrotask(() => watchExit(this.db, id, this.now));
      return [];
    }
    const at = this.iso();
    const changed = this.db.prepare("UPDATE execution_attempts SET state = 'ambiguous', updated_at = ? WHERE attempt_id = ? AND state = ?").run(at, a.attempt_id, a.state).changes;
    if (changed) {
      this.event(a.task_id, "attempt.stop_unconfirmed", a.dispatch_id, { attemptId: a.attempt_id, slot: a.candidate_slot, unit: a.provider_unit,
        waitedMs: waited, since, claims: this.claimsOf(a.attempt_id).map((c) => ({ resource: c.resource, units: c.units })) });
    }
    return [];
  }

  /**
   * The proof test for one entered attempt (packet 2.6.1, 2.8.2 rows 10 to 16, with the #268
   * review fixes). Inside the caller's transaction. Returns the claims it released.
   *
   * - An attempt another live incarnation entered is that incarnation's to settle: nothing here.
   * - `host_rebooted`: an attempt entered by another incarnation on another boot.
   * - With a unit, read under the manager recorded at entry: populated registers it
   *   (`provider_unit_seen_at`) and holds (a dead incarnation's is asked to stop, once per
   *   attempt, whatever state it is in); unreadable holds; empty or absent is `cgroup_empty` only
   *   once registered. Never registered, empty or absent is `unscoped_exit` only when the spawn
   *   path is closed (this incarnation's adapter reports it, or the spawning incarnation is dead)
   *   and the launcher scan, then a second read, find nothing.
   * - Without a unit: the end of the execution's stream. This incarnation's own attempt waits for
   *   its provider stream to really close; then K4b's ownership test (`stream_closed_unverified`),
   *   or `boot_unverified` when the owning incarnation is dead.
   */
  settleEntered(a: AttemptRow, reason: string): Released[] {
    if (!ENTERED_STATES.includes(a.state)) return [];
    const ev = exitEvidence(this.db);
    const who = this.incarnationOf(a);
    if (who === "alive") return [];
    const here = who === "here";
    const boot = ev.bootId();
    if (!here && a.entered_boot_id && a.entered_boot_id !== "unavailable" && boot !== "unavailable" && a.entered_boot_id !== boot) {
      return this.finalize(a, "host_rebooted", reason);
    }
    if (a.provider_unit) {
      const lane: UnitLane = a.run_as === "agent" ? "agent" : "plane";
      let owner = this.unitOwnerOf(a);
      let state: UnitState;
      if (owner) {
        state = ev.readUnit(a.provider_unit, lane, owner);
      } else {
        // A pre-060 row records no manager (#272 review). Only a populated read under today's
        // manager tells anything (and records it); empty or absent there may be the wrong
        // manager's view of a unit that still runs under the one it was assigned under.
        const current = ev.unitOwner(lane);
        const read = current ? ev.readUnit(a.provider_unit, lane, current) : "unreadable";
        if (read !== "populated" || !current) return this.awaitProof(a);
        this.recordOwner(a, current);
        owner = current;
        state = read;
      }
      if (state === "populated") {
        this.markSeen(a);
        // A dead incarnation's provider still running: recovery terminates its tree (2.8.2 row 13),
        // also when that incarnation had already moved it to `stopping` or `ambiguous` (finding 7).
        if (!here) {
          if (a.state === "starting" || a.state === "live") this.requestStop(a, "boot: provider of a dead incarnation still running");
          const db = this.db, now = this.now, id = a.attempt_id, unit = a.provider_unit, stopOwner = owner;
          if (claimRecoveryStop(db, id)) {
            queueMicrotask(() => {
              void ev.stopUnit(unit, lane, stopOwner).then((issued) => { if (!issued) releaseRecoveryStop(db, id); }, () => releaseRecoveryStop(db, id));
            });
          }
          queueMicrotask(() => watchExit(db, id, now));
        }
        return this.awaitProof(this.get(a.attempt_id)!);
      }
      // A search or read the plane could not complete proves nothing (finding 3).
      if (state === "unreadable") return this.awaitProof(a);
      // Registered, then empty or gone: every process in it has exited.
      if (a.provider_unit_seen_at) return this.finalize(a, "cgroup_empty", reason);
      // Never seen populated (finding 1): a scope can exist empty before systemd moves the launcher
      // into it, so empty is no more an exit than absent is.
      const spawnClosed = here ? incarnation(this.db).spawns.get(a.attempt_id)?.() === true : true;
      if (spawnClosed && !ev.launcherAlive(a.attempt_id, owner)) {
        const again = ev.readUnit(a.provider_unit, lane, owner);
        if (again === "absent" || again === "empty") return this.finalize(a, "unscoped_exit", reason);
        if (again === "populated") this.markSeen(a);
      }
      return this.awaitProof(a);
    }
    if (here && this.streamOpen(a)) return this.awaitProof(a);
    if (this.owned(a, here ? "runtime" : "boot")) return this.awaitProof(a);
    // An attempt that ever held an account claim is never settled by a weak proof (2.6.1,
    // `trg_attempt_weak_proof`). Unreachable once `enforce: true` requires strong exit evidence of
    // every member (2.2, with the gate); behind the test seam it waits for the operator instead of
    // failing the session's terminal transaction.
    if (a.account_key || this.heldAccount(a.attempt_id)) return this.awaitProof(a);
    return this.finalize(a, here ? "stream_closed_unverified" : "boot_unverified", reason);
  }

  /** A pre-060 attempt's unit read populated under today's manager: that is its manager from now on. */
  private recordOwner(a: AttemptRow, owner: UnitOwner): void {
    this.db.prepare("UPDATE execution_attempts SET provider_unit_owner = ?, updated_at = ? WHERE attempt_id = ? AND provider_unit_owner IS NULL")
      .run(JSON.stringify(owner), this.iso(), a.attempt_id);
  }

  /** The unit read populated: registered by systemd, so its later absence proves exit. */
  private markSeen(a: AttemptRow): void {
    if (a.provider_unit_seen_at) return;
    const at = this.iso();
    this.db.prepare("UPDATE execution_attempts SET provider_unit_seen_at = ?, updated_at = ? WHERE attempt_id = ? AND provider_unit_seen_at IS NULL").run(at, at, a.attempt_id);
  }

  /**
   * Whether a run or session row still owns execution: the K4b `hasOwner` predicate, for one row.
   * At boot a legacy run row (no `execution_request_id`) owns nothing whatever its `ended_at` says:
   * its stream was consumed in memory by the process that died (#264 review finding 2: boot's
   * blanket-fail ends only the runs of running tasks, and a run left open on a parked or created
   * task would otherwise hold its slot forever). A Harness session is recovered, so it still owns.
   */
  private runOwns(runId: string, mode: "runtime" | "boot"): boolean {
    return !!this.db.prepare(`SELECT 1 FROM runs r WHERE r.id = ? AND (
      (r.ended_at IS NULL AND (? = 'runtime' OR r.execution_request_id IS NOT NULL)) OR
      (r.execution_request_id IS NOT NULL AND (r.session_state NOT IN ${SESSION_TERMINAL_SQL} OR
       NOT EXISTS (SELECT 1 FROM execution_results er WHERE er.session_id = r.id))))`).get(runId, mode);
  }

  /**
   * Does anything still own this attempt's execution? A session or run row, or an open dispatch.
   * A direct or candidate attempt that has no row yet is owned by the start in this process; at
   * boot that process is gone, so it is not.
   */
  owned(a: AttemptRow, mode: "runtime" | "boot"): boolean {
    if (a.session_id) return this.runOwns(a.session_id, mode);
    if (a.dispatch_id) {
      const d = this.db.prepare("SELECT phase, session_id FROM dispatches WHERE dispatch_id = ?").get(a.dispatch_id) as { phase: string; session_id: string | null } | undefined;
      if (!d) return false;
      if (d.phase === "reserved" || d.phase === "start_attempted") return true;
      return d.session_id ? this.runOwns(d.session_id, mode) : false;
    }
    if (a.state === "held") return mode === "runtime";
    // An entered direct or candidate start with no run row yet is owned only while this
    // incarnation still holds its provider stream (#272 review: an abandoned start whose drain
    // ended after the bounded wait must settle, not stay owned by a start that is long gone).
    return mode === "runtime" && this.incarnationOf(a) === "here" && this.streamOpen(a);
  }

  /**
   * The sweep for one task (the K4b release points, the timer and boot). A `held` attempt that
   * nothing owns any more, or whose task is terminal, never entered and is dropped. An entered one
   * meets its proof test: a terminal task no longer releases it (packet 2.13 item 4).
   * Inside the caller's transaction.
   */
  settleIdle(taskId: string, mode: "runtime" | "boot", reason: string): Released[] {
    const task = this.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string } | undefined;
    const terminal = !task || isTerminal(task.state as TaskState);
    const released: Released[] = [];
    // A `queued` attempt holds nothing. It is dropped once nothing will ever grant it: its task is
    // terminal, or neither a `reserved` dispatch nor an active wait names it (packet 2.13 item 2).
    for (const q of this.db.prepare("SELECT * FROM execution_attempts WHERE task_id = ? AND state = 'queued'").all(taskId) as AttemptRow[]) {
      const waiting = this.db.prepare(`SELECT 1 FROM dispatches WHERE dispatch_id = ? AND phase = 'reserved'
        UNION ALL SELECT 1 FROM wait_conditions WHERE attempt_id = ? AND state = 'active'`).get(q.dispatch_id ?? "", q.attempt_id);
      if (terminal || !waiting) this.dropQueued(q.attempt_id, reason);
    }
    for (const a of this.ofTask(taskId, true)) {
      if (a.state === "held") {
        if (terminal || !this.owned(a, mode)) released.push(...this.finalize(a, "never_entered", reason));
        continue;
      }
      released.push(...this.settleEntered(a, reason));
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

    // A unit is assigned only on the Harness, for the attempt's own name (packet 2.6.1).
    const unit = ctx.providerUnit;
    if (unit !== undefined && (a.execution_path !== "harness" || unit !== attemptUnit(a.attempt_id, a.run_as === "agent" ? "agent" : "plane"))) {
      return notOwner(`unit ${unit} is not attempt ${a.attempt_id}'s`);
    }
    const ev = exitEvidence(this.db);
    const boot = ev.bootId();
    const enteredBoot = boot === "unavailable" ? currentBootId() : boot;
    const inc = incarnation(this.db);
    // In this transaction, every entry: a rolled-back first entry must not leave the row unwritten.
    ensureIncarnationRow(this.db, nowIso);
    // The manager the unit is assigned under, so recovery reads and stops it there (finding 4).
    const owner = unit ? ev.unitOwner(a.run_as === "agent" ? "agent" : "plane") : undefined;
    this.db.prepare(`UPDATE execution_attempts SET state = 'starting', entered_at = ?, entered_boot_id = ?, entered_incarnation = ?, provider_unit = ?,
        provider_unit_owner = ?, updated_at = ?, session_id = COALESCE(session_id, ?)
      WHERE attempt_id = ? AND state = 'held'`).run(nowIso, enteredBoot, inc.id, unit ?? null, owner ? JSON.stringify(owner) : null, nowIso, ctx.sessionId ?? null, a.attempt_id);
    // Open until the runner reports the provider call settled and its event stream closed.
    inc.streams.add(a.attempt_id);
    this.event(a.task_id, "attempt.entered", a.dispatch_id, { attemptId: a.attempt_id, path: a.execution_path, slot: a.candidate_slot, ...(unit ? { unit } : {}) });
    return { ok: true, attempt: this.get(a.attempt_id)! };
  }

  private event(taskId: string, type: string, dispatchId: string | null, payload: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO scheduler_events (task_id, generation, dispatch_id, type, at, payload) VALUES (?, NULL, ?, ?, ?, ?)")
      .run(taskId, dispatchId, type, this.iso(), JSON.stringify(redactValue(payload)));
  }
}

/** The task's open attempts, as `GET /api/tasks/:id` serves them (packet 2.3.2, API 2.19; unit and stop fields 2.20). */
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
  /** 2.20: the cgroup unit the provider runs in, or null (no strong exit evidence: pool-only release). */
  providerUnit: string | null;
  /** 2.20: the unit was seen populated, so its later absence proves exit. */
  unitRegistered: boolean;
  stopRequestedAt: string | null;
  /** 2.20: entered and asked to stop, or ambiguous: claims held until a proof (`confirm-stopped` settles it). */
  exitPending: boolean;
  requirements: { resource: string; units: number }[];
  claims: { resource: string; units: number; dispatchId: string | null; claimedAt: string }[];
}

export function attemptStatuses(db: Db, taskId: string): AttemptStatus[] {
  const store = new AttemptStore(db);
  return store.ofTask(taskId, true).map((a) => ({
    attemptId: a.attempt_id, kind: a.kind, executionPath: a.execution_path, slot: a.candidate_slot, state: a.state,
    assistantId: a.assistant_id, dispatchId: a.dispatch_id, sessionId: a.session_id,
    account: { key: a.account_key, source: a.account_source }, enteredAt: a.entered_at,
    providerUnit: a.provider_unit, unitRegistered: !!a.provider_unit_seen_at, stopRequestedAt: a.stop_requested_at,
    exitPending: a.state === "stopping" || a.state === "ambiguous",
    requirements: store.requirements(a.attempt_id).map((r) => ({ resource: r.resource, units: r.units })),
    claims: store.claimsOf(a.attempt_id).map((c) => ({ resource: c.resource, units: c.units, dispatchId: c.dispatch_id, claimedAt: c.claimed_at })),
  }));
}
