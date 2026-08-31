/**
 * EventRecorder — the transactional event-commit protocol (§9) and the two-view
 * redaction boundary (§4).
 *
 * Per batch, ONE better-sqlite3 transaction commits together:
 *   monotonic-seq event insert(s) → optional envelope mutation → session-record
 *   CAS (version + lease-token check).
 * If the CAS fails the whole transaction rolls back — there is never partial
 * visibility of an event whose session write did not land (H-I14).
 *
 * Redaction — two views (§4, H-I13):
 *   - the POLICY view is the raw event, held in memory by the SessionRunner and
 *     handed to guards / failure normalization / approval correlation; it is
 *     never persisted, logged or emitted.
 *   - the DURABLE view is the redacted projection — the ONLY form this recorder
 *     writes, and the only form SSE/telemetry ever see.
 * Redaction must not alter routing-critical identifiers (seq, runId, session
 * refs, request ids) — pinned by a regression test.
 */
import type { NormalizedEvent } from "@agent-plane/core";
import { DEFAULT_REDACTION_RULES, redactEvent } from "@agent-plane/core";
import type { RedactionRule } from "@agent-plane/core";
import type { Db } from "../../db/index.js";
import { SessionCasConflictError } from "./session-store.js";

export interface RecordBatchInput {
  sessionId: string;
  /** CAS guard: the session row's current version. */
  expectedVersion: number;
  /** CAS guard: the owning SessionRunner's fencing token (§9). */
  leaseToken: string;
  events: NormalizedEvent[];
  /**
   * Runs inside the same transaction, after the events are inserted and before
   * the session CAS. Throwing here rolls the whole batch back.
   */
  inTransaction?: (committed: DurableEvent[]) => void;
}

export interface DurableEvent {
  seq: number;
  event: NormalizedEvent;
}

export interface RecordBatchResult {
  committed: DurableEvent[];
  newVersion: number;
}

export class EventRecorder {
  constructor(
    private db: Db,
    private redactionRules: RedactionRule[] = DEFAULT_REDACTION_RULES,
    /** Called once, AFTER commit, with the durable events — the non-durable SSE hop. */
    private publish?: (sessionId: string, events: DurableEvent[]) => void,
    private now: () => Date = () => new Date(),
    /** Post-commit delivery is best-effort; a throwing `publish` is routed here, not re-thrown. */
    private onPublishError?: (err: unknown) => void,
  ) {}

  /** Redact one event into its durable view. Exposed for the identifier-preservation test. */
  toDurableView(event: NormalizedEvent): NormalizedEvent {
    return redactEvent(event, this.redactionRules);
  }

  recordBatch(input: RecordBatchInput): RecordBatchResult {
    if (input.events.length === 0) {
      return { committed: [], newVersion: input.expectedVersion };
    }
    const insert = this.db.prepare(
      "INSERT INTO events (run_id, seq, ts, type, phase, summary, payload, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );

    let committed: DurableEvent[] = [];
    const tx = this.db.transaction(() => {
      // Seq is allocated INSIDE the transaction so it cannot go stale (§9).
      let seq = (
        this.db
          .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE run_id = ?")
          .get(input.sessionId) as { maxSeq: number }
      ).maxSeq;
      const durable: DurableEvent[] = [];
      for (const raw of input.events) {
        seq += 1;
        const safe = this.toDurableView(raw);
        insert.run(
          input.sessionId,
          seq,
          safe.ts,
          safe.type,
          safe.phase ?? null,
          safe.summary,
          safe.payload ? JSON.stringify(safe.payload) : null,
          safe.raw !== undefined ? JSON.stringify(safe.raw) : null,
        );
        // Frozen: the in-transaction hook mutates the ENVELOPE, never the events
        // — it must not be able to alter the redacted view that SSE/telemetry see.
        durable.push(Object.freeze({ seq, event: Object.freeze({ ...safe, seq }) }));
      }

      input.inTransaction?.(durable);

      const info = this.db
        .prepare(
          `UPDATE runs SET version = version + 1
           WHERE id = ? AND version = ? AND lease_token = ? AND lease_expires_at > ?`,
        )
        .run(input.sessionId, input.expectedVersion, input.leaseToken, this.now().toISOString());
      if (info.changes !== 1) {
        throw new SessionCasConflictError(
          input.sessionId,
          `event batch CAS: expected version=${input.expectedVersion} under a live lease`,
        );
      }
      committed = durable;
    });

    tx(); // throws (rolls back) on CAS failure — nothing above is visible

    // Post-commit: the rows are durable. A publish failure must NOT look like a
    // failed commit — swallow it (SSE is resync-notification only, §9).
    if (this.publish) {
      try {
        this.publish(input.sessionId, committed);
      } catch (err) {
        this.onPublishError?.(err);
      }
    }
    return { committed, newVersion: input.expectedVersion + 1 };
  }
}
