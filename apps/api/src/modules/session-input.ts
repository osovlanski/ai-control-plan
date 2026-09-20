/**
 * SessionInputService — durable session-addressed conversational input.
 *
 * Contract: `docs/contracts/session-input.md`. Vocabulary, state machine and
 * per-condition policy live in `@agent-plane/core`'s `session-input.ts`; this
 * module owns persistence, authorization and the dispatch/reconcile protocol.
 *
 * Three invariants carry the whole slice:
 *   1. The message row is committed with its `input.queued` trace BEFORE any
 *      delivery is attempted. A lost HTTP response therefore costs nothing.
 *   2. `(workspace, session_id, client_message_id)` is unique, so a retry is the
 *      SAME logical message — never a second row and never a second dispatch of
 *      a message that already settled.
 *   3. An attempt row is written `in_flight` before `deliver()` is called. A
 *      crash between the two leaves durable evidence that an attempt was taken,
 *      which recovery turns into `delivery_unknown` — never into "sent" and
 *      never into a blind re-send.
 */
import { randomUUID } from "node:crypto";
import {
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_SESSION_INPUT_TEXT_BYTES,
  RUN_STATE_TO_SESSION_STATE,
  SessionInputRejectedError,
  assertInputTransition,
  canCancelInput,
  canClaimDelivered,
  canRetryInput,
  canonicalJson,
  digestString,
  inputEventFor,
  inputPolicy,
  isInputTerminal,
  type ExecutionSessionState,
  type SessionInputAdapter,
  type SessionInputCapabilities,
  type SessionInputCondition,
  type SessionInputEventType,
  type SessionInputReceipt,
  type SessionInputState,
  type SessionInputTarget,
} from "@agent-plane/core";
import type { Db } from "../db/index.js";

export interface SessionInputRow {
  id: string;
  workspace: string;
  sessionId: string;
  taskId: string;
  clientMessageId: string;
  kind: string;
  text: string;
  actor: string;
  state: SessionInputState;
  reason: string | null;
  deliveryUnknown: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  providerReceipt: SessionInputReceipt | null;
  /** Which incarnation of `clientMessageId` this row is; 1 is the first submit. */
  generation: number;
  /** The settled row this one retries, when it is not the first incarnation. */
  retryOf: string | null;
}

export interface SessionInputAttemptRow {
  attemptId: string;
  ordinal: number;
  leaseEpoch: string;
  adapter: string;
  capabilityVersion: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  providerReceipt: SessionInputReceipt | null;
  diagnostic: string | null;
}

export interface SessionInputEventRow {
  id: number;
  type: SessionInputEventType;
  messageId: string;
  attemptId: string | null;
  sessionId: string;
  taskId: string;
  workspace: string;
  actor: string;
  at: string;
  reason: string | null;
}

/** The same client key resubmitted with different text. A bug, never a retry. */
export class SessionInputConflictError extends Error {
  constructor(readonly clientMessageId: string) {
    super(`client message ${clientMessageId} already exists with a different payload`);
    this.name = "SessionInputConflictError";
  }
}

/** Bad request at the trust boundary — size, emptiness, unsupported kind. */
export class SessionInputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInputInvalidError";
  }
}

/**
 * The session does not exist, or belongs to another workspace. One error for
 * both so a caller cannot probe another workspace's IDs for existence.
 */
export class SessionInputUnknownSessionError extends Error {
  constructor(readonly sessionId: string) {
    super(`no addressable session ${sessionId}`);
    this.name = "SessionInputUnknownSessionError";
  }
}

/**
 * An explicit retry/cancel command that the record's own state forbids, or that
 * named a version the record no longer has. Always carries a machine-readable
 * reason — a command is never silently dropped.
 */
export class SessionInputCommandRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`session input command refused: ${reason}`);
    this.name = "SessionInputCommandRejectedError";
  }
}

export interface SessionInputSubmission {
  sessionId: string;
  clientMessageId: string;
  text: string;
  actor: string;
  kind?: string;
  expiresAt?: string;
}

/** Resolves the input adapter for an assistant. Returns undefined = unsupported. */
export type SessionInputAdapterResolver = (assistantId: string) => SessionInputAdapter | undefined;

export interface SessionRecord {
  sessionId: string;
  taskId: string;
  assistantId: string;
  providerSessionRef: string | null;
  sessionState: ExecutionSessionState;
  taskState: string;
  approvalPending: boolean;
}

export class SessionInputService {
  /**
   * This dispatcher incarnation. Any `in_flight` attempt tagged with a
   * DIFFERENT epoch was owned by a process that is gone, which is exactly the
   * evidence `reconcileOpenAttempts` needs to fence it.
   */
  readonly leaseEpoch: string;

  constructor(
    private db: Db,
    private opts: {
      workspace: string;
      adapters: SessionInputAdapterResolver;
      now?: () => Date;
      leaseEpoch?: string;
    },
  ) {
    this.leaseEpoch = opts.leaseEpoch ?? `epoch_${randomUUID()}`;
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }

  // -- reads ---------------------------------------------------------------

  /** Workspace-scoped by construction: a row from another workspace is invisible. */
  get(messageId: string): SessionInputRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_inputs WHERE id = ? AND workspace = ?")
      .get(messageId, this.opts.workspace) as RawInput | undefined;
    return row ? toRow(row) : undefined;
  }

  list(sessionId: string, opts: { after?: string; limit?: number } = {}): SessionInputRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM session_inputs
          WHERE session_id = ? AND workspace = ? AND (? IS NULL OR id > ?)
          ORDER BY created_at, id LIMIT ?`,
      )
      .all(sessionId, this.opts.workspace, opts.after ?? null, opts.after ?? null, limit) as RawInput[];
    return rows.map(toRow);
  }

  attempts(messageId: string): SessionInputAttemptRow[] {
    return (
      this.db
        .prepare("SELECT * FROM session_input_attempts WHERE message_id = ? ORDER BY ordinal")
        .all(messageId) as RawAttempt[]
    ).map(toAttempt);
  }

  events(messageId: string): SessionInputEventRow[] {
    return (
      this.db
        .prepare("SELECT * FROM session_input_events WHERE message_id = ? ORDER BY id")
        .all(messageId) as RawEvent[]
    ).map(toEvent);
  }

  /** Resolves a session inside this workspace. Undefined = absent OR foreign. */
  session(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT r.id, r.task_id, r.assistant_id, r.provider_session_ref, r.session_state, r.state,
                t.state AS task_state
           FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.id = ?`,
      )
      .get(sessionId) as
      | {
          id: string;
          task_id: string;
          assistant_id: string;
          provider_session_ref: string | null;
          session_state: string | null;
          state: string;
          task_state: string;
        }
      | undefined;
    if (!row) return undefined;
    // A message already recorded against this session fixes its workspace; a
    // session with no input history belongs to the running workspace, because
    // one workspace is one database (arch §12) — there is no second tenant to
    // confuse it with. Both checks exist so a row copied in from elsewhere
    // cannot be addressed.
    const foreign = this.db
      .prepare("SELECT 1 FROM session_inputs WHERE session_id = ? AND workspace <> ? LIMIT 1")
      .get(sessionId, this.opts.workspace);
    const own = this.db
      .prepare("SELECT 1 FROM session_inputs WHERE session_id = ? AND workspace = ? LIMIT 1")
      .get(sessionId, this.opts.workspace);
    if (foreign && !own) return undefined;
    const approvalPending = !!this.db
      .prepare("SELECT 1 FROM approvals WHERE session_id = ? AND state = 'pending' LIMIT 1")
      .get(sessionId);
    return {
      sessionId: row.id,
      taskId: row.task_id,
      assistantId: row.assistant_id,
      providerSessionRef: row.provider_session_ref,
      sessionState: (row.session_state as ExecutionSessionState | null) ??
        (RUN_STATE_TO_SESSION_STATE[row.state] ?? "RUNNING"),
      taskState: row.task_state,
      approvalPending,
    };
  }

  // -- command -------------------------------------------------------------

  /**
   * Persist the message. Durable before any delivery attempt; the same client
   * key with the same payload returns the original record untouched.
   */
  submit(input: SessionInputSubmission): { row: SessionInputRow; created: boolean } {
    const kind = input.kind ?? "text";
    if (kind !== "text") throw new SessionInputInvalidError(`unsupported input kind ${kind}`);
    const clientMessageId = input.clientMessageId?.trim() ?? "";
    if (!clientMessageId || clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
      throw new SessionInputInvalidError("clientMessageId must be 1..128 characters");
    }
    const text = input.text ?? "";
    if (!text.trim()) throw new SessionInputInvalidError("text must not be empty");
    if (Buffer.byteLength(text, "utf8") > MAX_SESSION_INPUT_TEXT_BYTES) {
      throw new SessionInputInvalidError(`text exceeds ${MAX_SESSION_INPUT_TEXT_BYTES} bytes`);
    }
    if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) {
      throw new SessionInputInvalidError("expiresAt must be an ISO timestamp");
    }
    const session = this.session(input.sessionId);
    if (!session) throw new SessionInputUnknownSessionError(input.sessionId);

    const fingerprint = digestString(canonicalJson({ kind, text }));
    const existing = this.byClientKey(input.sessionId, clientMessageId);
    if (existing) {
      if (existing.payload_fingerprint !== fingerprint) throw new SessionInputConflictError(clientMessageId);
      return { row: toRow(existing), created: false };
    }

    const at = this.now();
    const id = `msg_${randomUUID()}`;
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO session_inputs
               (id, workspace, session_id, task_id, client_message_id, payload_fingerprint, kind, text,
                actor, state, reason, delivery_unknown, version, created_at, updated_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, 1, ?, ?, ?)`,
          )
          .run(
            id, this.opts.workspace, session.sessionId, session.taskId, clientMessageId, fingerprint,
            kind, text, input.actor, at, at, input.expiresAt ?? null,
          );
        // Same transaction as the row: the trace is the durable dispatch intent.
        this.trace("input.queued", id, session, input.actor, at, null, null);
      })();
    } catch (err) {
      // Lost the unique-key race: the winning row is the logical message.
      if (!(err instanceof Error) || !/UNIQUE/i.test(err.message)) throw err;
      const winner = this.byClientKey(input.sessionId, clientMessageId);
      if (!winner) throw err;
      if (winner.payload_fingerprint !== fingerprint) throw new SessionInputConflictError(clientMessageId);
      return { row: toRow(winner), created: false };
    }
    return { row: this.get(id)!, created: true };
  }

  /**
   * Evaluate policy and, when eligible, attempt exactly one delivery.
   * Safe to call repeatedly: a settled message is returned unchanged, and an
   * unknown-outcome message is reconciled rather than re-sent.
   */
  async dispatch(messageId: string): Promise<SessionInputRow | undefined> {
    const row = this.get(messageId);
    if (!row || isInputTerminal(row.state)) return row;
    const session = this.session(row.sessionId);
    if (!session) return this.settle(row, "rejected", "session_missing");

    const adapter = this.opts.adapters(session.assistantId);
    const capabilities = adapter?.capabilities();

    if (row.state === "accepted") {
      return row.deliveryUnknown ? this.reconcile(row, session, adapter, capabilities) : row;
    }

    // Expiry is only ever decided for a message that is DEFINITELY undispatched.
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(this.now())) {
      return this.settle(row, "expired", "deadline_passed_undispatched");
    }

    const condition = conditionOf(session);
    const policy = inputPolicy(condition, capabilities, row.kind);
    if (policy.decision === "reject") {
      const detail = condition === "completed" || condition === "failed" || condition === "cancelled"
        ? `${policy.reason}:${session.sessionState}`
        : policy.reason;
      return this.settle(row, "rejected", detail);
    }
    if (policy.decision === "queue") {
      // Still queued — the reason is display/audit only and claims no delivery.
      this.db
        .prepare("UPDATE session_inputs SET reason = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(policy.reason, this.now(), row.id);
      return this.get(row.id);
    }
    return this.attempt(row, session, adapter!, capabilities!);
  }

  /** Dispatch every non-terminal message of a session, oldest first. */
  async dispatchPending(sessionId: string): Promise<void> {
    const open = this.db
      .prepare(
        `SELECT id FROM session_inputs
          WHERE session_id = ? AND workspace = ? AND state IN ('queued','accepted')
          ORDER BY created_at, id`,
      )
      .all(sessionId, this.opts.workspace) as Array<{ id: string }>;
    for (const { id } of open) await this.dispatch(id);
  }

  /**
   * Explicit retry over a message id.
   *
   * Two shapes, and the difference is the whole safety argument:
   *
   *   `accepted` + unknown delivery — the provider MAY already hold the text.
   *   The retry is a reconciliation (receipt lookup, or a declared-idempotent
   *   replay of the SAME message id), never a second send. `dispatch` already
   *   owns that rule, so this path delegates to it unchanged.
   *
   *   `rejected` — the refusal was definitive, so nothing was delivered and a
   *   fresh attempt cannot duplicate anything. The settled row stays settled
   *   (terminal is terminal); a successor row inherits the client key, the
   *   payload fingerprint and the text, and carries the next generation.
   *
   * A message with a live, unresolved attempt is refused with
   * `delivery_in_flight`: that is exactly the ambiguous-delivery case the
   * restart tests prove, and retrying through it would break the guarantee.
   */
  async retry(
    messageId: string,
    actor: string,
    expectedVersion?: number,
  ): Promise<SessionInputRow | undefined> {
    const row = this.get(messageId);
    if (!row) return undefined;
    // Re-authorized on every command, exactly like the original send path.
    const session = this.session(row.sessionId);
    if (!session) return undefined;
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw new SessionInputCommandRejectedError("version_conflict");
    }
    const check = canRetryInput(row.state, row.deliveryUnknown);
    if (!check.allowed) throw new SessionInputCommandRejectedError(check.reason);
    // The command itself is traced, distinctly from anything the retry causes.
    this.trace("input.retry_requested", row.id, session, actor, this.now(), `from_${row.state}`, null);
    if (row.state === "accepted") return this.dispatch(row.id);
    return this.dispatch(this.successor(row, session, actor).id);
  }

  /**
   * Explicit cancel over a message id. Only a message that was never dispatched
   * can be cancelled. Anything already `accepted` is refused with
   * `already_dispatched` rather than silently ignored: the provider may hold
   * the text, and the plane cannot recall it.
   */
  cancel(messageId: string, actor: string, expectedVersion?: number): SessionInputRow | undefined {
    const row = this.get(messageId);
    if (!row) return undefined;
    const session = this.session(row.sessionId);
    if (!session) return undefined;
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw new SessionInputCommandRejectedError("version_conflict");
    }
    const check = canCancelInput(row.state);
    if (!check.allowed) throw new SessionInputCommandRejectedError(check.reason);
    try {
      this.db.transaction(() => {
        this.trace("input.cancelled", row.id, session, actor, this.now(), "cancelled_by_actor", null);
        // `queued -> rejected` is an edge the contract already has; a cancel is
        // a definitive refusal to deliver, recorded with its own reason.
        this.transition(row, "rejected", "cancelled_by_actor", session, null);
      })();
    } catch (err) {
      if (!(err instanceof Error) || !/concurrent state change/.test(err.message)) throw err;
      // A dispatch won the row between the check and the write. Report what is
      // now true rather than the race.
      const now = this.get(messageId);
      const recheck = now ? canCancelInput(now.state) : ({ allowed: false, reason: "already_settled" } as const);
      throw new SessionInputCommandRejectedError(recheck.allowed ? "concurrent_change" : recheck.reason);
    }
    return this.get(row.id);
  }

  /**
   * Scheduler-owned redelivery for one task.
   *
   * Driven by the kernel's existing task-state announcement (the `{kind:
   * "state"}` frame on `TaskEventBus`, published by the orchestrator, the
   * scheduler and the harness recorder) — this module owns no timer and does
   * no polling, exactly as the contract requires for quota recovery.
   *
   * Only messages queued BECAUSE of a session condition that can clear are
   * reconsidered. `context_barrier` is deliberately absent: compaction is
   * policy-only until the kernel has a compaction record (K10).
   *
   * A redelivery is an ordinary dispatch, so it is subject to the same
   * idempotency, lease-epoch fencing and ambiguous-delivery rules as a
   * client-initiated send. Losing a race to a concurrent client command is the
   * fence working; it is not a pump failure.
   */
  async redeliverForTask(taskId: string): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id FROM session_inputs
          WHERE task_id = ? AND workspace = ? AND state = 'queued'
            AND reason IN ('quota_paused','approval_pending')
          ORDER BY created_at, id`,
      )
      .all(taskId, this.opts.workspace) as Array<{ id: string }>;
    let moved = 0;
    for (const { id } of rows) {
      try {
        const after = await this.dispatch(id);
        if (after && after.state !== "queued") moved += 1;
      } catch (err) {
        if (!(err instanceof Error) || !/concurrent state change/.test(err.message)) throw err;
      }
    }
    return moved;
  }

  /**
   * The next incarnation of a settled message: same client key, same payload
   * fingerprint, same text, next generation. Copied in SQL so the inherited
   * identity cannot drift.
   *
   * The unique key `(workspace, session, client key, generation)` is also the
   * fence — two concurrent retries of the same row compute the same next
   * generation, so exactly one creates it and the other adopts the winner.
   */
  private successor(row: SessionInputRow, session: SessionRecord, actor: string): SessionInputRow {
    const id = `msg_${randomUUID()}`;
    const at = this.now();
    const generation = row.generation + 1;
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO session_inputs
               (id, workspace, session_id, task_id, client_message_id, payload_fingerprint, kind, text,
                actor, state, reason, delivery_unknown, version, created_at, updated_at, expires_at,
                generation, retry_of)
             SELECT ?, workspace, session_id, task_id, client_message_id, payload_fingerprint, kind, text,
                    ?, 'queued', NULL, 0, 1, ?, ?, expires_at, generation + 1, id
               FROM session_inputs WHERE id = ?`,
          )
          .run(id, actor, at, at, row.id);
        this.trace("input.queued", id, session, actor, at, "retry_of_rejected", null);
      })();
    } catch (err) {
      if (!(err instanceof Error) || !/UNIQUE/i.test(err.message)) throw err;
      const winner = this.db
        .prepare(
          `SELECT * FROM session_inputs
            WHERE workspace = ? AND session_id = ? AND client_message_id = ? AND generation = ?`,
        )
        .get(this.opts.workspace, row.sessionId, row.clientMessageId, generation) as RawInput | undefined;
      if (!winner) throw err;
      return toRow(winner);
    }
    return this.get(id)!;
  }

  /**
   * Boot-time fencing. Every `in_flight` attempt from a previous incarnation is
   * an unknown outcome: the process died between `deliver()` and the durable
   * record of its result, so the provider may or may not hold the message.
   */
  reconcileOpenAttempts(): number {
    const stale = this.db
      .prepare(
        `SELECT a.attempt_id, a.message_id FROM session_input_attempts a
           JOIN session_inputs m ON m.id = a.message_id
          WHERE a.outcome = 'in_flight' AND a.lease_epoch <> ? AND m.workspace = ?`,
      )
      .all(this.leaseEpoch, this.opts.workspace) as Array<{ attempt_id: string; message_id: string }>;
    for (const { attempt_id, message_id } of stale) {
      const row = this.get(message_id);
      if (!row) continue;
      const session = this.session(row.sessionId);
      this.db.transaction(() => {
        this.endAttempt(attempt_id, "unknown", null, "owner_lease_expired");
        this.markUnknown(row, attempt_id, "restart_before_acknowledgement", session);
      })();
    }
    return stale.length;
  }

  // -- internals -----------------------------------------------------------

  private byClientKey(sessionId: string, clientMessageId: string): RawInput | undefined {
    return this.db
      .prepare(
        `SELECT * FROM session_inputs
          WHERE workspace = ? AND session_id = ? AND client_message_id = ?
          ORDER BY generation DESC LIMIT 1`,
      )
      .get(this.opts.workspace, sessionId, clientMessageId) as RawInput | undefined;
  }

  private target(session: SessionRecord): SessionInputTarget {
    return {
      sessionId: session.sessionId,
      assistantId: session.assistantId,
      providerSessionRef: session.providerSessionRef ?? undefined,
    };
  }

  private async attempt(
    row: SessionInputRow,
    session: SessionRecord,
    adapter: SessionInputAdapter,
    capabilities: SessionInputCapabilities,
  ): Promise<SessionInputRow | undefined> {
    const attemptId = this.openAttempt(row, session, capabilities);
    try {
      const receipt = await adapter.deliver(this.target(session), {
        messageId: row.id,
        kind: row.kind,
        text: row.text,
      });
      return this.recordReceipt(row.id, attemptId, receipt, capabilities, session);
    } catch (err) {
      if (err instanceof SessionInputRejectedError) {
        this.db.transaction(() => {
          this.endAttempt(attemptId, "rejected", null, err.reason);
          this.settleWithin(this.get(row.id)!, "rejected", err.reason, session, attemptId);
        })();
        return this.get(row.id);
      }
      // Anything else is ambiguous by construction: the adapter may have
      // delivered before the failure. Recording "rejected" here would be a lie.
      this.db.transaction(() => {
        this.endAttempt(attemptId, "unknown", null, diagnostic(err));
        this.markUnknown(this.get(row.id)!, attemptId, diagnostic(err), session);
      })();
      return this.get(row.id);
    }
  }

  /**
   * Turn an unknown outcome into truth without re-delivering blindly.
   * Receipt lookup is preferred; a declared-idempotent adapter may be re-sent
   * with the SAME message id; with neither, the message stays unknown and needs
   * an operator, because a blind retry is how a double-delivery happens.
   */
  private async reconcile(
    row: SessionInputRow,
    session: SessionRecord,
    adapter: SessionInputAdapter | undefined,
    capabilities: SessionInputCapabilities | undefined,
  ): Promise<SessionInputRow | undefined> {
    if (!adapter || !capabilities) return row;
    if (capabilities.receiptLookup && adapter.lookupReceipt) {
      const receipt = await adapter.lookupReceipt(this.target(session), row.id);
      if (receipt) {
        const prior = this.attempts(row.id).at(-1)?.attemptId ?? null;
        return this.recordReceipt(row.id, prior, receipt, capabilities, session);
      }
      // The provider is authoritative that it never arrived — a fresh attempt
      // cannot duplicate anything.
      return this.attempt(row, session, adapter, capabilities);
    }
    if (capabilities.idempotentSend) return this.attempt(row, session, adapter, capabilities);
    this.db
      .prepare("UPDATE session_inputs SET reason = ?, updated_at = ? WHERE id = ?")
      .run("manual_recovery_required", this.now(), row.id);
    return this.get(row.id);
  }

  private openAttempt(
    row: SessionInputRow,
    session: SessionRecord,
    capabilities: SessionInputCapabilities,
  ): string {
    const attemptId = `att_${randomUUID()}`;
    const at = this.now();
    this.db.transaction(() => {
      const ordinal =
        ((this.db
          .prepare("SELECT MAX(ordinal) AS n FROM session_input_attempts WHERE message_id = ?")
          .get(row.id) as { n: number | null }).n ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO session_input_attempts
             (attempt_id, message_id, ordinal, lease_epoch, adapter, capability_version, started_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'in_flight')`,
        )
        .run(attemptId, row.id, ordinal, this.leaseEpoch, session.assistantId, capabilities.capabilityVersion, at);
      if (row.state === "queued") {
        this.transition(row, "accepted", null, session, attemptId);
      }
    })();
    return attemptId;
  }

  private endAttempt(
    attemptId: string,
    outcome: "delivered" | "rejected" | "unknown",
    receipt: SessionInputReceipt | null,
    diagnosticCode: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE session_input_attempts
            SET outcome = ?, ended_at = ?, provider_receipt = ?, diagnostic = ?
          WHERE attempt_id = ? AND outcome = 'in_flight'`,
      )
      .run(outcome, this.now(), receipt ? JSON.stringify(receipt) : null, diagnosticCode, attemptId);
  }

  /**
   * A provider receipt in hand. `delivered` is claimed only when the adapter's
   * declared acknowledgement level actually proves provider-side receipt;
   * a transport-only ack leaves the message accepted and explicitly unknown.
   */
  private recordReceipt(
    messageId: string,
    attemptId: string | null,
    receipt: SessionInputReceipt,
    capabilities: SessionInputCapabilities,
    session: SessionRecord,
  ): SessionInputRow | undefined {
    this.db.transaction(() => {
      const current = this.get(messageId)!;
      if (attemptId) {
        this.endAttempt(
          attemptId,
          canClaimDelivered(capabilities) ? "delivered" : "unknown",
          receipt,
          canClaimDelivered(capabilities) ? null : "transport_ack_only",
        );
      }
      if (!canClaimDelivered(capabilities)) {
        this.markUnknown(current, attemptId, "transport_ack_only", session, receipt);
        return;
      }
      if (current.state === "delivered") return;
      this.db
        .prepare("UPDATE session_inputs SET provider_receipt = ? WHERE id = ?")
        .run(JSON.stringify(receipt), messageId);
      this.transition({ ...current, providerReceipt: receipt }, "delivered", null, session, attemptId);
    })();
    return this.get(messageId);
  }

  /** Accepted, dispatched, outcome unknown. Never "sent", never rejected. */
  private markUnknown(
    row: SessionInputRow,
    attemptId: string | null,
    reason: string,
    session: Pick<SessionRecord, "sessionId" | "taskId"> | undefined,
    receipt?: SessionInputReceipt,
  ): void {
    this.db
      .prepare(
        `UPDATE session_inputs
            SET delivery_unknown = 1, reason = ?, provider_receipt = COALESCE(?, provider_receipt),
                version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'accepted'`,
      )
      .run(reason, receipt ? JSON.stringify(receipt) : null, this.now(), row.id);
    this.trace(
      "input.delivery_unknown", row.id, session ?? row, row.actor, this.now(), reason, attemptId,
    );
  }

  private settle(row: SessionInputRow, to: SessionInputState, reason: string): SessionInputRow | undefined {
    const session = this.session(row.sessionId);
    this.db.transaction(() => this.settleWithin(row, to, reason, session, null))();
    return this.get(row.id);
  }

  private settleWithin(
    row: SessionInputRow,
    to: SessionInputState,
    reason: string,
    session: Pick<SessionRecord, "sessionId" | "taskId"> | undefined,
    attemptId: string | null,
  ): void {
    this.transition(row, to, reason, session, attemptId);
  }

  /** The ONLY writer of `state`. Illegal edges throw before anything is persisted. */
  private transition(
    row: SessionInputRow,
    to: SessionInputState,
    reason: string | null,
    session: Pick<SessionRecord, "sessionId" | "taskId"> | undefined,
    attemptId: string | null,
  ): void {
    assertInputTransition(row.state, to);
    const at = this.now();
    const info = this.db
      .prepare(
        `UPDATE session_inputs
            SET state = ?, reason = ?, version = version + 1, updated_at = ?,
                delivery_unknown = CASE WHEN ? = 'delivered' THEN 0 ELSE delivery_unknown END
          WHERE id = ? AND state = ? AND version = ?`,
      )
      .run(to, reason, at, to, row.id, row.state, row.version);
    if (info.changes !== 1) throw new Error(`session input ${row.id}: concurrent state change, retry`);
    this.trace(inputEventFor(to), row.id, session ?? row, row.actor, at, reason, attemptId);
  }

  private trace(
    type: SessionInputEventType,
    messageId: string,
    session: Pick<SessionRecord, "sessionId" | "taskId">,
    actor: string,
    at: string,
    reason: string | null,
    attemptId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_input_events
           (type, message_id, attempt_id, session_id, task_id, workspace, actor, at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(type, messageId, attemptId, session.sessionId, session.taskId, this.opts.workspace, actor, at, reason);
  }
}

/**
 * Kernel records → contract condition.
 *
 * Order is load-bearing. A terminal session is answered first: text cannot
 * restart finished work, whatever the task is doing. `compacting` is absent on
 * purpose — the kernel has no compaction record yet (K10 is unimplemented), and
 * inventing one would be a false audit. `inputPolicy` still defines that arm, so
 * the policy is ready the day the record exists.
 */
export function conditionOf(session: SessionRecord): SessionInputCondition {
  switch (session.taskState) {
    case "COMPLETED": return "completed";
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
  }
  switch (session.sessionState) {
    case "COMPLETED": return "completed";
    case "CANCELLED": return "cancelled";
    case "FAILED":
    case "TIMED_OUT":
    case "YIELDED":
      return "failed";
  }
  if (session.sessionState === "AWAITING_APPROVAL" || session.approvalPending) return "approval-blocked";
  if (session.taskState === "LIMIT_PAUSED") return "quota-paused";
  if (session.taskState === "WAITING_INPUT") return "waiting-input";
  return "running";
}

function diagnostic(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Bounded: a diagnostic code, never a provider error body.
  return text.slice(0, 120);
}

interface RawInput {
  id: string; workspace: string; session_id: string; task_id: string; client_message_id: string;
  payload_fingerprint: string; kind: string; text: string; actor: string; state: string;
  reason: string | null; delivery_unknown: number; version: number; created_at: string;
  updated_at: string; expires_at: string | null; provider_receipt: string | null;
  generation: number; retry_of: string | null;
}

interface RawAttempt {
  attempt_id: string; message_id: string; ordinal: number; lease_epoch: string; adapter: string;
  capability_version: string; started_at: string; ended_at: string | null; outcome: string;
  provider_receipt: string | null; diagnostic: string | null;
}

interface RawEvent {
  id: number; type: string; message_id: string; attempt_id: string | null; session_id: string;
  task_id: string; workspace: string; actor: string; at: string; reason: string | null;
}

function parseReceipt(value: string | null): SessionInputReceipt | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SessionInputReceipt;
  } catch {
    return null;
  }
}

function toRow(r: RawInput): SessionInputRow {
  return {
    id: r.id, workspace: r.workspace, sessionId: r.session_id, taskId: r.task_id,
    clientMessageId: r.client_message_id, kind: r.kind, text: r.text, actor: r.actor,
    state: r.state as SessionInputState, reason: r.reason, deliveryUnknown: r.delivery_unknown === 1,
    version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
    providerReceipt: parseReceipt(r.provider_receipt),
    generation: r.generation, retryOf: r.retry_of,
  };
}

function toAttempt(r: RawAttempt): SessionInputAttemptRow {
  return {
    attemptId: r.attempt_id, ordinal: r.ordinal, leaseEpoch: r.lease_epoch, adapter: r.adapter,
    capabilityVersion: r.capability_version, startedAt: r.started_at, endedAt: r.ended_at,
    outcome: r.outcome, providerReceipt: parseReceipt(r.provider_receipt), diagnostic: r.diagnostic,
  };
}

function toEvent(r: RawEvent): SessionInputEventRow {
  return {
    id: r.id, type: r.type as SessionInputEventType, messageId: r.message_id, attemptId: r.attempt_id,
    sessionId: r.session_id, taskId: r.task_id, workspace: r.workspace, actor: r.actor,
    at: r.at, reason: r.reason,
  };
}
