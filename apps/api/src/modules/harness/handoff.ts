/**
 * HandoffService — provider-neutral cross-assistant continuation (§7) and the
 * reroute yield (§8).
 *
 * Envelope assembly is a single-writer, single-transaction operation: the source
 * session's SessionRunner, at terminalization, commits the envelope row + a
 * `handoffs` row inside the SAME transaction as the terminal CAS + result
 * (via `SessionStore.terminalize({ extra })`). The envelope is derived from an
 * IMMUTABLE checkpoint snapshot, never the live task envelope (H-I5).
 *
 * Consumption is a persisted protocol, not an assertion (§7):
 *   ready → claimed → consumed
 *   claimed → released → ready              (pre-start failure)
 *   claimed → start_ambiguous              (adapter.start attempted; recovery-only exit)
 * The `uq_live_successor` partial index makes two LIVE successors for one
 * envelope impossible; a released claim marks its request `superseded` so a
 * corrected successor is still accepted.
 */
import type {
  AssistantId,
  EvaluationResult,
  HandoffEnvelope,
  TaskEnvelope,
  TaskId,
} from "@agent-plane/core";
import { newHandoffId, redactValue } from "@agent-plane/core";
import type { Db } from "../../db/index.js";

interface CheckpointRow {
  id: string;
  task_id: string;
  session_id: string | null;
  envelope_snapshot: string;
  git_ref: string | null;
  diff_stat: string | null;
}

export interface HandoffEnvelopeRow {
  id: string;
  taskId: string;
  checkpointId: string;
  envelope: HandoffEnvelope;
  state: "ready" | "claimed" | "start_ambiguous" | "consumed" | "released";
  claimedByRequestId: string | null;
  fromAssistantId: string;
  reason: string;
  sourceSessionId: string | null;
}

export class HandoffClaimError extends Error {
  constructor(envelopeId: string, detail: string) {
    super(`handoff envelope ${envelopeId}: ${detail}`);
    this.name = "HandoffClaimError";
  }
}

export class HandoffService {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * Derive a HandoffEnvelope from a checkpoint's immutable snapshot (H-I5). Pure
   * — no writes. Redacted before it can be persisted (H-I9).
   */
  deriveEnvelope(
    checkpointId: string,
    opts: { reason: string; fromAssistantId: string; verificationStatus?: EvaluationResult; contextRefs?: string[] },
  ): { envelope: HandoffEnvelope; sourceSessionId: string | null } {
    const cp = this.db
      .prepare(
        "SELECT id, task_id, session_id, envelope_snapshot, git_ref, diff_stat FROM checkpoints WHERE id = ?",
      )
      .get(checkpointId) as CheckpointRow | undefined;
    if (!cp) throw new Error(`no checkpoint ${checkpointId} to derive an envelope from`);
    const snap = JSON.parse(cp.envelope_snapshot) as TaskEnvelope;

    const raw: HandoffEnvelope = {
      schemaVersion: 1,
      envelopeId: newHandoffId(),
      taskId: cp.task_id as TaskId,
      checkpointId: cp.id,
      objective: snap.goal,
      currentSubtask: snap.nextAction,
      completedActions: snap.completed ?? [],
      outstanding: snap.remaining ?? [],
      decisions: (snap.decisions ?? []).map((d) => ({ text: d.text, madeBy: d.madeBy, at: d.at })),
      artifacts: {
        gitRef: cp.git_ref ?? undefined,
        diffStat: cp.diff_stat ?? undefined,
        changedFiles: snap.artifacts?.changedFiles ?? [],
        lastTests: snap.artifacts?.testResults?.at(-1),
      },
      verificationStatus: opts.verificationStatus,
      contextRefs: opts.contextRefs ?? [],
      workspace: snap.repository
        ? { repoPath: snap.repository.path, branch: snap.repository.branch }
        : { repoPath: "", branch: "" },
      fromAssistantId: opts.fromAssistantId as AssistantId,
      reason: opts.reason,
    };
    // Reconstructable state only — no transcripts, credentials or CoT (H-I5).
    return { envelope: redactValue(raw), sourceSessionId: cp.session_id };
  }

  /**
   * Insert the envelope row. Call this from inside `terminalize({ extra })` so it
   * commits atomically with the source session's terminal CAS (§7).
   */
  insertEnvelope(
    db: Db,
    envelope: HandoffEnvelope,
    meta: { sourceSessionId: string | null },
  ): void {
    const at = this.now().toISOString();
    db.prepare(
      `INSERT INTO handoff_envelopes
         (id, task_id, checkpoint_id, envelope, state, from_assistant_id, reason, source_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
    ).run(
      envelope.envelopeId,
      envelope.taskId,
      envelope.checkpointId,
      JSON.stringify(envelope),
      envelope.fromAssistantId,
      envelope.reason,
      meta.sourceSessionId,
      at,
      at,
    );
    db.prepare(
      `INSERT INTO handoffs (id, task_id, from_run_id, to_run_id, checkpoint_id, trigger, at)
       VALUES (?, ?, ?, NULL, ?, 'harness', ?)`,
    ).run(newHandoffId(), envelope.taskId, meta.sourceSessionId, envelope.checkpointId, at);
  }

  get(envelopeId: string): HandoffEnvelopeRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM handoff_envelopes WHERE id = ?")
      .get(envelopeId) as RawRow | undefined;
    return row ? toRow(row) : undefined;
  }

  /**
   * The plane claims the envelope (CAS `ready → claimed`) in the SAME
   * transaction that inserts the successor request. The partial unique index on
   * `execution_requests(origin_envelope_id) WHERE superseded = 0` makes a second
   * live successor impossible.
   */
  claim(
    envelopeId: string,
    successor: {
      requestId: string;
      insertRequest: (db: Db) => void;
    },
  ): void {
    const at = this.now().toISOString();
    const tx = this.db.transaction(() => {
      const env = this.db
        .prepare("SELECT task_id FROM handoff_envelopes WHERE id = ?")
        .get(envelopeId) as { task_id: string } | undefined;
      if (!env) throw new HandoffClaimError(envelopeId, "no such envelope");

      successor.insertRequest(this.db);

      // Do not trust the callback — verify EVERY handoff-identity field on the
      // row it claims to have written (§7): the denormalized origin_envelope_id,
      // the origin JSON's envelopeId/kind, prompt_source(_ref), and the task.
      const req = this.db
        .prepare(
          `SELECT id, task_id, origin_envelope_id, prompt_source, prompt_source_ref,
                  json_extract(origin, '$.kind')       AS origin_kind,
                  json_extract(origin, '$.envelopeId') AS origin_env
             FROM execution_requests WHERE id = ?`,
        )
        .get(successor.requestId) as
        | {
            id: string;
            task_id: string;
            origin_envelope_id: string | null;
            prompt_source: string;
            prompt_source_ref: string | null;
            origin_kind: string | null;
            origin_env: string | null;
          }
        | undefined;
      if (
        !req ||
        req.id !== successor.requestId ||
        req.task_id !== env.task_id ||
        req.origin_envelope_id !== envelopeId ||
        req.origin_kind !== "handoff" ||
        req.origin_env !== envelopeId ||
        req.prompt_source !== "handoff" ||
        req.prompt_source_ref !== envelopeId
      ) {
        throw new HandoffClaimError(
          envelopeId,
          "successor request row does not match the envelope (id/task/origin/prompt-source mismatch)",
        );
      }

      // `released` is claimable too — it just records that a prior attempt failed.
      const info = this.db
        .prepare(
          `UPDATE handoff_envelopes
             SET state = 'claimed', claimed_by_request_id = ?, claimed_at = ?,
                 start_attempted_at = NULL, updated_at = ?
           WHERE id = ? AND state IN ('ready', 'released')`,
        )
        .run(successor.requestId, at, at, envelopeId);
      if (info.changes !== 1) {
        throw new HandoffClaimError(envelopeId, "not claimable — not in state 'ready' or 'released'");
      }
    });
    try {
      tx();
    } catch (err) {
      // The partial unique index (uq_live_successor) is the real guarantee — a
      // second live successor insert fails here; normalize it to a claim error.
      if (err instanceof Error && /uq_live_successor|origin_envelope_id/i.test(err.message)) {
        throw new HandoffClaimError(envelopeId, "a live successor request already exists for this envelope");
      }
      throw err;
    }
  }

  /**
   * adapter.start has been attempted — pin the claim; automatic expiry is now
   * prohibited (§7). CASes on `claimed_by_request_id` so a delayed start from a
   * superseded request cannot move a re-claimed envelope.
   *
   * NOTE (Phase 7): §7 requires this flip to commit in the SAME transaction as
   * the destination session's durable start intent (§9 step 2). The runner does
   * not yet drive the claim protocol, so that co-commit is wired with the
   * orchestrator cutover / recovery work — see docs/harness-implementation-progress.md.
   */
  enterStartAmbiguous(envelopeId: string, requestId: string): void {
    const at = this.now().toISOString();
    const info = this.db
      .prepare(
        `UPDATE handoff_envelopes SET state = 'start_ambiguous', start_attempted_at = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND claimed_by_request_id = ?`,
      )
      .run(at, at, envelopeId, requestId);
    if (info.changes !== 1) {
      throw new HandoffClaimError(envelopeId, "cannot enter start_ambiguous (not 'claimed' by this request)");
    }
  }

  /** Durable start acknowledged — execution provably began consuming the envelope (§7). */
  markConsumed(envelopeId: string, requestId: string): void {
    const at = this.now().toISOString();
    const info = this.db
      .prepare(
        `UPDATE handoff_envelopes SET state = 'consumed', updated_at = ?
         WHERE id = ? AND state IN ('claimed', 'start_ambiguous') AND claimed_by_request_id = ?`,
      )
      .run(at, envelopeId, requestId);
    if (info.changes !== 1) {
      throw new HandoffClaimError(envelopeId, "cannot mark consumed (not claimed by this request)");
    }
  }

  /**
   * Pre-start failure: mark the failed request `superseded` and move the envelope
   * to `released`, in one transaction. Legal ONLY from `claimed` — once
   * `start_ambiguous`, only {@link settleAmbiguous} may act (§7). `released` (not
   * straight back to `ready`) keeps the "this envelope had a failed attempt"
   * signal; {@link claim} accepts it as a source state.
   */
  release(envelopeId: string, failedRequestId: string): void {
    const at = this.now().toISOString();
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `UPDATE handoff_envelopes
             SET state = 'released', claimed_by_request_id = NULL, claimed_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claimed_by_request_id = ?`,
        )
        .run(at, envelopeId, failedRequestId);
      if (info.changes !== 1) {
        throw new HandoffClaimError(envelopeId, "release is legal only from 'claimed' by the owning request");
      }
      this.db.prepare("UPDATE execution_requests SET superseded = 1 WHERE id = ?").run(failedRequestId);
    });
    tx();
  }

  /**
   * Recovery-only settlement of a `start_ambiguous` claim by probing the §9
   * markers: non-execution ESTABLISHED → release; execution possible/confirmed →
   * consumed (continuing via the session's own checkpoints).
   */
  settleAmbiguous(envelopeId: string, outcome: { executionEstablished: boolean }, requestId: string): void {
    const at = this.now().toISOString();
    const tx = this.db.transaction(() => {
      // Both CAS branches require the caller to own the claim
      // (`claimed_by_request_id = ?`) — a stale recovery pass for a superseded
      // request cannot settle a claim that has since moved on.
      if (outcome.executionEstablished) {
        const info = this.db
          .prepare(
            `UPDATE handoff_envelopes SET state = 'consumed', updated_at = ?
             WHERE id = ? AND state = 'start_ambiguous' AND claimed_by_request_id = ?`,
          )
          .run(at, envelopeId, requestId);
        if (info.changes !== 1) {
          throw new HandoffClaimError(envelopeId, "not in 'start_ambiguous' for this request");
        }
      } else {
        const info = this.db
          .prepare(
            `UPDATE handoff_envelopes
               SET state = 'released', claimed_by_request_id = NULL, updated_at = ?
             WHERE id = ? AND state = 'start_ambiguous' AND claimed_by_request_id = ?`,
          )
          .run(at, envelopeId, requestId);
        if (info.changes !== 1) {
          throw new HandoffClaimError(envelopeId, "not in 'start_ambiguous' for this request");
        }
        this.db.prepare("UPDATE execution_requests SET superseded = 1 WHERE id = ?").run(requestId);
      }
    });
    tx();
  }

  /**
   * A claim past its TTL while still pre-start: atomically supersede the owning
   * request AND release the envelope in one transaction — never a released
   * envelope with a live successor row (§7). Prohibited once `start_ambiguous`.
   */
  expireClaim(envelopeId: string, ttlMs: number): boolean {
    const cutoff = new Date(this.now().getTime() - ttlMs).toISOString();
    let released = false;
    const tx = this.db.transaction(() => {
      // Staleness check + release fold into one transaction — no read-then-CAS gap.
      const row = this.db
        .prepare("SELECT state, claimed_by_request_id, claimed_at FROM handoff_envelopes WHERE id = ?")
        .get(envelopeId) as
        | { state: string; claimed_by_request_id: string | null; claimed_at: string | null }
        | undefined;
      if (!row || row.state !== "claimed" || !row.claimed_at || row.claimed_at > cutoff) return;
      const at = this.now().toISOString();
      const info = this.db
        .prepare(
          `UPDATE handoff_envelopes
             SET state = 'released', claimed_by_request_id = NULL, claimed_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'claimed' AND claimed_by_request_id = ?`,
        )
        .run(at, envelopeId, row.claimed_by_request_id);
      if (info.changes !== 1) return;
      this.db
        .prepare("UPDATE execution_requests SET superseded = 1 WHERE id = ?")
        .run(row.claimed_by_request_id);
      released = true;
    });
    tx();
    return released;
  }

  /** Envelopes assembled by a given source session (§8 reroute lookup for the plane). */
  bySourceSession(sessionId: string): HandoffEnvelopeRow[] {
    return (
      this.db
        .prepare("SELECT * FROM handoff_envelopes WHERE source_session_id = ? ORDER BY created_at")
        .all(sessionId) as RawRow[]
    ).map(toRow);
  }

  /** Envelopes anchored to a given checkpoint (§8 reroute lookup for the plane). */
  byCheckpoint(checkpointId: string): HandoffEnvelopeRow[] {
    return (
      this.db
        .prepare("SELECT * FROM handoff_envelopes WHERE checkpoint_id = ? ORDER BY created_at")
        .all(checkpointId) as RawRow[]
    ).map(toRow);
  }
}

interface RawRow {
  id: string;
  task_id: string;
  checkpoint_id: string;
  envelope: string;
  state: string;
  claimed_by_request_id: string | null;
  from_assistant_id: string;
  reason: string;
  source_session_id: string | null;
}

function toRow(r: RawRow): HandoffEnvelopeRow {
  return {
    id: r.id,
    taskId: r.task_id,
    checkpointId: r.checkpoint_id,
    envelope: JSON.parse(r.envelope) as HandoffEnvelope,
    state: r.state as HandoffEnvelopeRow["state"],
    claimedByRequestId: r.claimed_by_request_id,
    fromAssistantId: r.from_assistant_id,
    reason: r.reason,
    sourceSessionId: r.source_session_id,
  };
}
