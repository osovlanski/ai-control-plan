/**
 * SessionStore — durable substrate for the Execution Harness (Phase 1).
 *
 * Owns the `execution_requests` and session (`runs`) rows: fingerprint dedupe,
 * one-session-per-request (H-I8), CAS-under-a-fencing-lease writes (H-I12),
 * the start-intent/start-ack markers (§9), and atomic terminalize + result (§2,
 * H-I3). It does NOT drive execution — the SessionRunner (Phase 3) does — and it
 * keeps the legacy `runs.state` column in sync via the §5 map so the existing
 * orchestrator and API keep working through the dual-field migration window.
 */
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionSession,
  ExecutionSessionState,
  ProviderSessionRef,
  TerminalSessionState,
} from "@agent-plane/core";
import {
  SESSION_STATE_TO_RUN_STATE,
  SESSION_TERMINAL_STATES,
  assertSessionTransition,
  canonicalRequestProjection,
  isSessionTerminal,
  newExecutionSessionId,
  outcomeOf,
  requestFingerprint,
} from "@agent-plane/core";
import type { Db } from "../../db/index.js";

export class RequestFingerprintConflictError extends Error {
  constructor(
    readonly executionRequestId: string,
    readonly storedFingerprint: string,
    readonly incomingFingerprint: string,
  ) {
    super(
      `executionRequestId ${executionRequestId} was resubmitted with a different fingerprint ` +
        `(${storedFingerprint} != ${incomingFingerprint}) — this is a conflict, not an idempotent retry`,
    );
    this.name = "RequestFingerprintConflictError";
  }
}

export class SessionCasConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly detail: string,
  ) {
    super(`CAS conflict on session ${sessionId}: ${detail}`);
    this.name = "SessionCasConflictError";
  }
}

interface RunRow {
  id: string;
  task_id: string;
  execution_request_id: string | null;
  session_state: string;
  version: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_seq: number;
  provider_session_ref: string | null;
  provider_start_acked: number;
  cancel_requested: number;
  settlement_owner: string | null;
  attempt: number;
  started_at: string | null;
  ended_at: string | null;
}

const LEASE_TTL_MS = 60_000;

export interface RecordRequestResult {
  executionRequestId: string;
  fingerprint: string;
  /** true when an identical request was already stored (idempotent resubmission). */
  deduped: boolean;
}

export interface TransitionInput {
  expectedVersion: number;
  from: ExecutionSessionState;
  to: ExecutionSessionState;
  /** Fencing token of the owning SessionRunner — every session write is CAS'd on it (H-I12). */
  leaseToken: string;
  /**
   * Claim terminal-settlement ownership in the same CAS: the write also requires
   * `settlement_owner IS NULL` and sets it, so two racing settlers collapse to
   * one winner (§9).
   */
  claimSettlement?: string;
  /** Extra columns to set in the same CAS. */
  patch?: Partial<{
    providerSessionRef: ProviderSessionRef;
    providerStartAcked: boolean;
  }>;
}

export class SessionStore {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  // --- execution_requests ---------------------------------------------------

  /**
   * Idempotently record a request. Same id + same fingerprint → `deduped: true`.
   * Same id + different fingerprint → {@link RequestFingerprintConflictError}.
   */
  recordRequest(
    request: ExecutionRequest,
    provenance: { templateVersion?: string } = {},
  ): RecordRequestResult {
    const { fingerprint, algorithm, promptDigest } = requestFingerprint(request);

    const compareExisting = (): RecordRequestResult => {
      const row = this.db
        .prepare("SELECT request_fingerprint FROM execution_requests WHERE id = ?")
        .get(request.executionRequestId) as { request_fingerprint: string } | undefined;
      if (!row) throw new Error(`execution_request ${request.executionRequestId} vanished mid-dedupe`);
      if (row.request_fingerprint !== fingerprint) {
        throw new RequestFingerprintConflictError(
          request.executionRequestId,
          row.request_fingerprint,
          fingerprint,
        );
      }
      return { executionRequestId: request.executionRequestId, fingerprint, deduped: true };
    };

    if (
      this.db
        .prepare("SELECT 1 FROM execution_requests WHERE id = ?")
        .get(request.executionRequestId)
    ) {
      return compareExisting();
    }

    const promptSource = request.origin.kind;
    const promptSourceRef =
      request.origin.kind === "resume"
        ? request.origin.checkpointId
        : request.origin.kind === "handoff"
          ? request.origin.envelopeId
          : null;
    const originEnvelopeId = request.origin.kind === "handoff" ? request.origin.envelopeId : null;
    const { projection } = canonicalRequestProjection(request);

    try {
      this.db
        .prepare(
          `INSERT INTO execution_requests
             (id, task_id, attempt, assistant_id, model, composition_revision_id, routing_decision_ref,
              request_fingerprint, fingerprint_algorithm, prompt_source, prompt_source_ref, template_version,
              rendered_prompt_digest, policy, verification, verification_plan, origin, origin_envelope_id, superseded,
              canonical_projection, parent_task_id, group_id, target_kind, workspace_id,
              repository_id, worktree_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.executionRequestId,
          request.taskId,
          request.attempt,
          request.assistantId,
          request.model ? JSON.stringify(request.model) : null,
          request.compositionRevisionId ?? null,
          request.routingDecisionRef,
          fingerprint,
          algorithm,
          promptSource,
          promptSourceRef,
          provenance.templateVersion ?? null,
          promptDigest,
          JSON.stringify(request.policy),
          JSON.stringify(request.verification),
          request.verificationPlan ? JSON.stringify(request.verificationPlan) : null,
          JSON.stringify(request.origin),
          originEnvelopeId,
          JSON.stringify(projection),
          // Opaque observability join keys (§2) — not in the fingerprint.
          request.correlation?.parentTaskId ?? null,
          request.correlation?.groupId ?? null,
          request.context.target?.kind ?? null,
          request.context.target?.workspaceId ?? null,
          request.context.target?.repositoryId ?? null,
          request.context.target?.kind === "worktree" ? request.context.target.worktreeId : null,
          this.iso(),
        );
    } catch (err) {
      // Lost an insert race on the primary key — fall back to the dedupe compare.
      if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) return compareExisting();
      throw err;
    }

    return { executionRequestId: request.executionRequestId, fingerprint, deduped: false };
  }

  markRequestSuperseded(executionRequestId: string): void {
    this.db
      .prepare("UPDATE execution_requests SET superseded = 1 WHERE id = ?")
      .run(executionRequestId);
  }

  // --- sessions (runs) ----------------------------------------------------

  /**
   * Create the session row for an accepted request, in `PREPARED`. Idempotent:
   * a second call for the same `executionRequestId` returns the existing session
   * (this is how "duplicate executionRequestId → same session, one start" holds).
   */
  createSession(executionRequestId: string): ExecutionSession {
    const existing = this.forRequest(executionRequestId);
    if (existing) return existing;

    const req = this.db
      .prepare("SELECT id, task_id, attempt, assistant_id FROM execution_requests WHERE id = ?")
      .get(executionRequestId) as
      | { id: string; task_id: string; attempt: number; assistant_id: string }
      | undefined;
    if (!req) throw new Error(`No execution_request ${executionRequestId} to create a session for`);

    const sessionId = newExecutionSessionId();
    try {
      this.db
        .prepare(
          `INSERT INTO runs
             (id, task_id, assistant_id, state, session_state, version, provider_start_acked,
              cancel_requested, attempt, execution_request_id, started_at)
           VALUES (?, ?, ?, ?, 'PREPARED', 0, 0, 0, ?, ?, ?)`,
        )
        .run(
          sessionId,
          req.task_id,
          req.assistant_id,
          SESSION_STATE_TO_RUN_STATE.PREPARED,
          req.attempt,
          executionRequestId,
          this.iso(),
        );
    } catch (err) {
      // Lost a race on uq_runs_execution_request — return the winner.
      const raced = this.forRequest(executionRequestId);
      if (raced) return raced;
      throw err;
    }
    return this.get(sessionId as string)!;
  }

  get(sessionId: string): ExecutionSession | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(sessionId) as RunRow | undefined;
    return row ? toSession(row) : undefined;
  }

  forRequest(executionRequestId: string): ExecutionSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE execution_request_id = ?")
      .get(executionRequestId) as RunRow | undefined;
    return row ? toSession(row) : undefined;
  }

  /** All sessions whose `session_state` is non-terminal — the boot-reconcile worklist (§9). */
  liveSessions(): ExecutionSession[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE execution_request_id IS NOT NULL AND session_state IS NOT NULL")
      .all() as RunRow[];
    return rows.map(toSession).filter((s) => !isSessionTerminal(s.state));
  }

  /** Legacy `runs.state` vocabulary for the dual-field read window (§5). */
  legacyState(session: ExecutionSession): string {
    return SESSION_STATE_TO_RUN_STATE[session.state];
  }

  // --- CAS transitions (every session write is fenced on the lease, H-I12) ---

  transition(sessionId: string, input: TransitionInput): ExecutionSession {
    assertSessionTransition(input.from, input.to);
    const sets: string[] = ["session_state = ?", "state = ?", "version = version + 1"];
    const params: unknown[] = [input.to, SESSION_STATE_TO_RUN_STATE[input.to]];

    if (input.patch?.providerSessionRef !== undefined) {
      sets.push("provider_session_ref = ?");
      params.push(input.patch.providerSessionRef);
    }
    if (input.patch?.providerStartAcked !== undefined) {
      sets.push("provider_start_acked = ?");
      params.push(input.patch.providerStartAcked ? 1 : 0);
    }
    if (input.claimSettlement !== undefined) {
      sets.push("settlement_owner = ?");
      params.push(input.claimSettlement);
    }
    if (isSessionTerminal(input.to)) {
      sets.push("ended_at = ?");
      params.push(this.iso());
    }

    // CAS guards: version + source state + a live lease held by this runner
    // (token match AND not expired — a stalled runner past its TTL loses, §9).
    let where =
      "WHERE id = ? AND version = ? AND session_state = ? AND lease_token = ? AND lease_expires_at > ?";
    params.push(sessionId, input.expectedVersion, input.from, input.leaseToken, this.iso());
    if (input.claimSettlement !== undefined) where += " AND settlement_owner IS NULL";

    const info = this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} ${where}`)
      .run(...(params as Parameters<ReturnType<Db["prepare"]>["run"]>));
    if (info.changes !== 1) {
      throw new SessionCasConflictError(
        sessionId,
        `expected version=${input.expectedVersion} state=${input.from} under a live lease` +
          (input.claimSettlement !== undefined ? " with settlement unclaimed" : ""),
      );
    }
    return this.get(sessionId)!;
  }

  /**
   * Atomically CAS to a terminal state AND persist the one `ExecutionResult`
   * row (H-I3). Either both land or neither does. Requires the fencing lease and
   * claims `settlement_owner` in the same CAS — two racing settlers collapse to
   * one winner (§9).
   */
  terminalize(
    sessionId: string,
    input: TransitionInput & {
      to: TerminalSessionState;
      settlementOwner: string;
      result: ExecutionResult;
      /**
       * Runs inside the SAME transaction as the terminal CAS + result insert.
       * The handoff/reroute path uses it to commit the envelope + `handoffs` row
       * atomically with the source session's terminalization (§7). Throwing
       * rolls the whole terminalization back.
       */
      extra?: (db: Db) => void;
    },
  ): ExecutionResult {
    if (input.result.sessionId !== sessionId) {
      throw new Error(`result.sessionId ${input.result.sessionId} != ${sessionId}`);
    }
    if (input.result.terminalState !== input.to) {
      throw new Error(`result.terminalState ${input.result.terminalState} != transition target ${input.to}`);
    }
    if (input.result.outcome !== outcomeOf(input.to)) {
      throw new Error(`result.outcome ${input.result.outcome} != derived ${outcomeOf(input.to)}`);
    }
    const tx = this.db.transaction(() => {
      this.transition(sessionId, { ...input, claimSettlement: input.settlementOwner });
      this.db
        .prepare(
          `INSERT INTO execution_results (session_id, terminal_state, outcome, result, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, input.to, input.result.outcome, JSON.stringify(input.result), this.iso());
      input.extra?.(this.db);
    });
    tx();
    return input.result;
  }

  result(sessionId: string): ExecutionResult | undefined {
    const row = this.db
      .prepare("SELECT result FROM execution_results WHERE session_id = ?")
      .get(sessionId) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as ExecutionResult) : undefined;
  }

  // --- start-intent / start-ack markers (§9) ---------------------------

  /**
   * Handle acquired (still no stream). A version-bumping CAS under the live lease
   * while STARTING — recovery can then tell "start returned but stream never
   * began" from "stream was live". The stream-began ack is folded into the
   * STARTING→RUNNING transition (`patch.providerStartAcked`), which is what the
   * first streamed event triggers.
   */
  ackHandle(
    sessionId: string,
    ref: ProviderSessionRef,
    input: { expectedVersion: number; leaseToken: string },
  ): ExecutionSession {
    const info = this.db
      .prepare(
        `UPDATE runs SET provider_session_ref = ?, version = version + 1
         WHERE id = ? AND version = ? AND session_state = 'STARTING'
           AND lease_token = ? AND lease_expires_at > ?`,
      )
      .run(ref, sessionId, input.expectedVersion, input.leaseToken, this.iso());
    if (info.changes !== 1) throw new SessionCasConflictError(sessionId, "ackHandle: stale version/state or dead lease");
    return this.get(sessionId)!;
  }

  /**
   * Durable cancellation intent (§4, §9). The plane/user may set it at ANY time
   * without holding the lease — it is a monotonic 0→1 flag. The version bump is
   * the wakeup: the owning runner's next fenced CAS fails, it re-reads, sees the
   * intent and runs the cancel path. Idempotent; no-ops on a terminal session.
   */
  requestCancel(sessionId: string): boolean {
    const placeholders = SESSION_TERMINAL_STATES.map(() => "?").join(", ");
    const info = this.db
      .prepare(
        `UPDATE runs SET cancel_requested = 1, version = version + 1
         WHERE id = ? AND cancel_requested = 0 AND session_state NOT IN (${placeholders})`,
      )
      .run(sessionId, ...SESSION_TERMINAL_STATES);
    return info.changes === 1;
  }

  // --- leases with fencing (§9) --------------------------------------

  /** Acquire the lease iff it is free or expired. Returns the fencing token, or undefined. */
  acquireLease(sessionId: string, ttlMs = LEASE_TTL_MS): string | undefined {
    const token = `lease_${cryptoRandom()}`;
    const nowIso = this.iso();
    const expiresIso = new Date(this.now().getTime() + ttlMs).toISOString();
    const info = this.db
      .prepare(
        `UPDATE runs SET lease_token = ?, lease_expires_at = ?, heartbeat_seq = heartbeat_seq + 1
         WHERE id = ? AND (lease_token IS NULL OR lease_expires_at < ?)`,
      )
      .run(token, expiresIso, sessionId, nowIso);
    return info.changes === 1 ? token : undefined;
  }

  /** Extend a lease this runner still holds. A lease already past its TTL cannot be renewed. */
  renewLease(sessionId: string, token: string, ttlMs = LEASE_TTL_MS): boolean {
    const expiresIso = new Date(this.now().getTime() + ttlMs).toISOString();
    const info = this.db
      .prepare(
        `UPDATE runs SET lease_expires_at = ?, heartbeat_seq = heartbeat_seq + 1
         WHERE id = ? AND lease_token = ? AND lease_expires_at > ?`,
      )
      .run(expiresIso, sessionId, token, this.iso());
    return info.changes === 1;
  }

  /** Drop a lease this runner holds (clean handback when a run finishes). */
  releaseLease(sessionId: string, token: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE runs SET lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?",
      )
      .run(sessionId, token);
    return info.changes === 1;
  }

  /**
   * Record a guard directive as `pending`, keyed to its triggering event seq
   * (§4). Meant to be called from inside the recorder batch's `inTransaction`
   * hook so it commits atomically with that event. Returns the row id; the
   * runner CASes it to `applied` once the action succeeds. A crash between the
   * two leaves a `pending` row for the Phase 7 replay worker.
   */
  recordPendingDirective(
    sessionId: string,
    eventSeq: number,
    guard: string,
    directive: string,
    payload: unknown,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO guard_directives (session_id, event_seq, guard, directive, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(sessionId, eventSeq, guard, directive, JSON.stringify(payload), this.iso());
    return Number(info.lastInsertRowid);
  }

  markDirectiveApplied(id: number): void {
    this.db
      .prepare("UPDATE guard_directives SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'")
      .run(this.iso(), id);
  }

  /** Recovery replay bookkeeping (§4): bump the attempt counter, return the new count. */
  incrementDirectiveAttempt(id: number): number {
    this.db.prepare("UPDATE guard_directives SET attempts = attempts + 1 WHERE id = ?").run(id);
    return (
      this.db.prepare("SELECT attempts FROM guard_directives WHERE id = ?").get(id) as {
        attempts: number;
      }
    ).attempts;
  }

  /** A directive that permanently fails replay — its session is orphan-failed (§9). */
  markDirectiveFailed(id: number): void {
    this.db
      .prepare("UPDATE guard_directives SET status = 'failed', applied_at = ? WHERE id = ?")
      .run(this.iso(), id);
  }

  /**
   * Atomic §4-recovery settlement of a relayed approval whose delivery a crash
   * left unconfirmed: mark the approval `delivered` AND CAS the paused session
   * `AWAITING_APPROVAL → RUNNING` in ONE transaction, so a crash can never leave
   * a `delivered` approval on a still-`AWAITING_APPROVAL` session (a state the
   * recovery worklist would then never revisit).
   */
  resumeFromApproval(
    sessionId: string,
    providerRequestId: string,
    input: { expectedVersion: number; leaseToken: string },
  ): ExecutionSession {
    const at = this.iso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE approvals SET state = 'delivered', delivered_at = ?, delivery_note = NULL, updated_at = ?
           WHERE session_id = ? AND provider_request_id = ?
             AND state IN ('answered','delivering','delivery_unknown')`,
        )
        .run(at, at, sessionId, providerRequestId);
      this.transition(sessionId, {
        expectedVersion: input.expectedVersion,
        from: "AWAITING_APPROVAL",
        to: "RUNNING",
        leaseToken: input.leaseToken,
      });
    });
    tx();
    return this.get(sessionId)!;
  }

  /** True iff a `recovery.decision` event with this `action` is already on the timeline. */
  hasRecoveryDecision(sessionId: string, action: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM events WHERE run_id = ? AND type = 'recovery.decision' AND json_extract(payload, '$.action') = ? LIMIT 1",
      )
      .get(sessionId, action);
  }

  /** Parsed `usage.updated` payloads for a session, in seq order — for recovery budget recompute (§9). */
  usageEvents(sessionId: string): Array<{ inputTokens?: number; outputTokens?: number }> {
    return (
      this.db
        .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'usage.updated' ORDER BY seq")
        .all(sessionId) as Array<{ payload: string | null }>
    )
      .map((r) => {
        try {
          return r.payload ? (JSON.parse(r.payload) as { inputTokens?: number; outputTokens?: number }) : {};
        } catch {
          return {};
        }
      });
  }

  /**
   * Append a `recovery.decision` audit event to a session's timeline (§9, §11).
   * Append-only, next-seq — the caller holds the lease, so no CAS is needed for
   * a witness that never mutates session state; the `UNIQUE(run_id, seq)` index
   * still rejects a racing double-insert.
   */
  appendRecoveryEvent(sessionId: string, action: string, detail?: string): number {
    const seq =
      (
        this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE run_id = ?").get(sessionId) as {
          n: number;
        }
      ).n;
    this.db
      .prepare(
        "INSERT INTO events (run_id, seq, ts, type, summary, payload) VALUES (?, ?, ?, 'recovery.decision', ?, ?)",
      )
      .run(sessionId, seq, this.iso(), `recovery: ${action}${detail ? ` — ${detail}` : ""}`, JSON.stringify({ action, detail }));
    return seq;
  }

  pendingDirectives(sessionId: string): Array<{ id: number; guard: string; directive: string; payload: unknown }> {
    return (
      this.db
        .prepare("SELECT id, guard, directive, payload FROM guard_directives WHERE session_id = ? AND status = 'pending' ORDER BY id")
        .all(sessionId) as Array<{ id: number; guard: string; directive: string; payload: string }>
    ).map((r) => ({ id: r.id, guard: r.guard, directive: r.directive, payload: JSON.parse(r.payload) }));
  }

  /**
   * Atomic approval pause (§4, H-I14): insert the durable approvals row AND CAS
   * the session RUNNING → AWAITING_APPROVAL in one transaction, so a pending
   * approval and a paused session can never disagree. The `approval.requested`
   * audit event is already durable from the preceding recorder batch.
   */
  pauseForApproval(
    sessionId: string,
    input: { expectedVersion: number; leaseToken: string; approvalId: string; providerRequestId: string },
  ): ExecutionSession {
    const at = this.iso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO approvals (id, session_id, provider_request_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(session_id, provider_request_id) DO NOTHING`,
        )
        .run(input.approvalId, sessionId, input.providerRequestId, at, at);
      this.transition(sessionId, {
        expectedVersion: input.expectedVersion,
        from: "RUNNING",
        to: "AWAITING_APPROVAL",
        leaseToken: input.leaseToken,
      });
    });
    tx();
    return this.get(sessionId)!;
  }

  /**
   * Boot: no SessionRunner is alive in this single-process architecture, so every
   * live session's lease is conservatively void (§9). Terminal rows are left
   * untouched — nothing will ever write them again.
   */
  voidAllLeases(): number {
    const placeholders = SESSION_TERMINAL_STATES.map(() => "?").join(", ");
    const info = this.db
      .prepare(
        `UPDATE runs SET lease_token = NULL, lease_expires_at = NULL
         WHERE lease_token IS NOT NULL AND session_state NOT IN (${placeholders})`,
      )
      .run(...SESSION_TERMINAL_STATES);
    return info.changes;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

function toSession(row: RunRow): ExecutionSession {
  return {
    sessionId: row.id as ExecutionSession["sessionId"],
    executionRequestId: row.execution_request_id ?? "",
    state: row.session_state as ExecutionSessionState,
    version: row.version,
    leaseToken: row.lease_token ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    providerSessionRef: (row.provider_session_ref as ProviderSessionRef | null) ?? undefined,
    providerStartAcked: row.provider_start_acked === 1,
    cancelRequested: row.cancel_requested === 1,
    settlementOwner: row.settlement_owner ?? undefined,
    attempt: row.attempt,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  };
}

function cryptoRandom(): string {
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}
