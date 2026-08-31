/**
 * ApprovalService — the durable, atomic, delivery-tracked approval protocol (§4).
 *
 * The pending row, its `approval.requested` audit event and the session CAS to
 * AWAITING_APPROVAL are committed together by the SessionRunner (this service
 * only owns the `approvals` row). Answer lifecycle:
 *   pending → answered → delivering → delivered
 *   pending → expired
 *   delivering → delivery_unknown   (crash after send() before the delivered CAS)
 *
 * Idempotency vs conflict: resubmitting the IDENTICAL answer is a no-op that
 * returns the original; a conflicting answer (approve after deny or vice versa)
 * is a deterministic {@link ApprovalConflictError} — a flip is stale UI or an
 * authorization problem, never a retry.
 */
import type { Db } from "../../db/index.js";

export type ApprovalState =
  | "pending"
  | "answered"
  | "delivering"
  | "delivered"
  | "delivery_unknown"
  | "expired";

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalRow {
  id: string;
  sessionId: string;
  providerRequestId: string;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  answeredBy: string | null;
  answeredAt: string | null;
  deliveredAt: string | null;
  deliveryNote: string | null;
}

export class ApprovalConflictError extends Error {
  constructor(
    readonly providerRequestId: string,
    readonly stored: ApprovalDecision,
    readonly incoming: ApprovalDecision,
  ) {
    super(
      `approval ${providerRequestId} already ${stored}; a ${incoming} answer conflicts — ` +
        `resolve the stale UI or authorization issue, do not retry`,
    );
    this.name = "ApprovalConflictError";
  }
}

export class AnswerResult {
  constructor(
    readonly status: "answered" | "idempotent",
    readonly row: ApprovalRow,
  ) {}
}

interface RawRow {
  id: string;
  session_id: string;
  provider_request_id: string;
  state: string;
  decision: string | null;
  answered_by: string | null;
  answered_at: string | null;
  delivered_at: string | null;
  delivery_note: string | null;
}

export class ApprovalService {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** Insert (or return) the pending row. Idempotent on `(session_id, provider_request_id)`. */
  request(sessionId: string, providerRequestId: string, id: string): ApprovalRow {
    const existing = this.get(sessionId, providerRequestId);
    if (existing) return existing;
    const at = this.now().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO approvals (id, session_id, provider_request_id, state, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, sessionId, providerRequestId, at, at);
    } catch (err) {
      if (!(err instanceof Error) || !/UNIQUE/i.test(err.message)) throw err;
      // lost the insert race — the winning row is what matters
    }
    return this.get(sessionId, providerRequestId)!;
  }

  /**
   * Record a decision. The decision is durable BEFORE any relay attempt.
   * Same decision again → no-op; opposite decision → {@link ApprovalConflictError}.
   */
  answer(
    sessionId: string,
    providerRequestId: string,
    decision: ApprovalDecision,
    answeredBy: string,
  ): AnswerResult {
    const row = this.require(sessionId, providerRequestId);
    if (row.state === "expired") {
      throw new Error(`approval ${providerRequestId} has expired and cannot be answered`);
    }
    if (row.decision !== null) {
      if (row.decision !== decision) {
        throw new ApprovalConflictError(providerRequestId, row.decision, decision);
      }
      return new AnswerResult("idempotent", row);
    }
    const at = this.now().toISOString();
    const info = this.db
      .prepare(
        `UPDATE approvals SET state = 'answered', decision = ?, answered_by = ?, answered_at = ?, updated_at = ?
         WHERE session_id = ? AND provider_request_id = ? AND state = 'pending' AND decision IS NULL`,
      )
      .run(decision, answeredBy, at, at, sessionId, providerRequestId);
    if (info.changes !== 1) {
      // Lost a race to another answer — re-read and re-apply the idempotency/conflict rule.
      const now = this.require(sessionId, providerRequestId);
      if (now.decision === decision) return new AnswerResult("idempotent", now);
      throw new ApprovalConflictError(providerRequestId, now.decision!, decision);
    }
    return new AnswerResult("answered", this.get(sessionId, providerRequestId)!);
  }

  markDelivering(sessionId: string, providerRequestId: string): void {
    this.transition(sessionId, providerRequestId, ["answered", "delivery_unknown"], "delivering");
  }

  markDelivered(sessionId: string, providerRequestId: string): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE approvals SET state = 'delivered', delivered_at = ?, delivery_note = NULL, updated_at = ?
         WHERE session_id = ? AND provider_request_id = ? AND state IN ('delivering','answered','delivery_unknown')`,
      )
      .run(at, at, sessionId, providerRequestId);
  }

  /** A crash after `send()` was issued but before the delivered CAS committed (§4). */
  markDeliveryUnknown(sessionId: string, providerRequestId: string, note = "unknown"): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE approvals SET state = 'delivery_unknown', delivery_note = ?, updated_at = ?
         WHERE session_id = ? AND provider_request_id = ? AND state IN ('delivering','answered')`,
      )
      .run(note, at, sessionId, providerRequestId);
  }

  expire(sessionId: string, providerRequestId: string): void {
    this.transition(sessionId, providerRequestId, ["pending"], "expired");
  }

  pending(sessionId: string): ApprovalRow[] {
    return (
      this.db
        .prepare("SELECT * FROM approvals WHERE session_id = ? AND state = 'pending'")
        .all(sessionId) as RawRow[]
    ).map(toRow);
  }

  /** Rows the recovery protocol must resume: pending, or answered-but-undelivered (§4). */
  unsettled(sessionId: string): ApprovalRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM approvals WHERE session_id = ? AND state IN ('pending','answered','delivering','delivery_unknown')",
        )
        .all(sessionId) as RawRow[]
    ).map(toRow);
  }

  get(sessionId: string, providerRequestId: string): ApprovalRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE session_id = ? AND provider_request_id = ?")
      .get(sessionId, providerRequestId) as RawRow | undefined;
    return row ? toRow(row) : undefined;
  }

  private require(sessionId: string, providerRequestId: string): ApprovalRow {
    const row = this.get(sessionId, providerRequestId);
    if (!row) throw new Error(`no approval ${providerRequestId} for session ${sessionId}`);
    return row;
  }

  private transition(
    sessionId: string,
    providerRequestId: string,
    from: ApprovalState[],
    to: ApprovalState,
  ): void {
    const at = this.now().toISOString();
    const placeholders = from.map(() => "?").join(", ");
    const info = this.db
      .prepare(
        `UPDATE approvals SET state = ?, updated_at = ?
         WHERE session_id = ? AND provider_request_id = ? AND state IN (${placeholders})`,
      )
      .run(to, at, sessionId, providerRequestId, ...from);
    if (info.changes !== 1) {
      throw new Error(`approval ${providerRequestId}: cannot move to ${to} from its current state`);
    }
  }
}

function toRow(r: RawRow): ApprovalRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    providerRequestId: r.provider_request_id,
    state: r.state as ApprovalState,
    decision: (r.decision as ApprovalDecision | null) ?? null,
    answeredBy: r.answered_by,
    answeredAt: r.answered_at,
    deliveredAt: r.delivered_at,
    deliveryNote: r.delivery_note,
  };
}
