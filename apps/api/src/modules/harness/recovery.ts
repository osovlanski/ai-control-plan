/**
 * HarnessRecovery — boot reconcile v2, the lease sweeper, guard-directive
 * replay, and `delivery_unknown` approval settlement (execution-harness §9, §4).
 *
 * All of this is single-process crash recovery: on boot no SessionRunner is
 * alive, so every live session's lease is conservatively void and each live
 * session is decided one of:
 *   - COMPLETED  — it crashed mid-VERIFYING (execution had finished; verification
 *                  was not durably recorded), so it completes with no verification;
 *   - resume_offered — the provider session is probe-resumable (manifest
 *                  `canResume` + a `providerSessionRef`); the Control Plane, not
 *                  the Harness, turns that into an `origin: resume` request (H-I1);
 *   - FAILED(orphaned) — not resumable; a checkpoint is ATTEMPTED first and its
 *                  outcome recorded on the result (H-I4), the result row is
 *                  written in the terminal CAS (H-I3).
 *
 * Every decision is an append-only `recovery.decision` event on the session
 * timeline so Cockpit can tell the states apart (§11).
 */
import type {
  AgentAdapter,
  CapabilityManifest,
  ExecutionResult,
  ExecutionSession,
} from "@agent-plane/core";
import { redactValue } from "@agent-plane/core";
import type { SessionStore } from "./session-store.js";
import type { ApprovalService } from "./approval-service.js";
import type { RunnerCheckpoints } from "./session-runner.js";

export interface RecoveryRegistry {
  adapter(id: string): AgentAdapter;
  manifest(id: string): CapabilityManifest | null;
}

export interface RecoveryDeps {
  store: SessionStore;
  approvals: ApprovalService;
  checkpoints: RunnerCheckpoints;
  registry: RecoveryRegistry;
  now?: () => Date;
  ownerId?: string;
  /** Cap on guard-directive replay attempts before the session is orphan-failed (§9). */
  maxDirectiveAttempts?: number;
  /**
   * Probe a relayed approval's provider-side acknowledgement, when the manifest
   * declares `approvalAckLookup` (§4). Returns true iff the provider recorded the
   * answer.
   */
  approvalAckLookup?: (sessionId: string, providerRequestId: string) => Promise<boolean> | boolean;
}

export type RecoveryAction =
  | "resume_offered"
  | "orphaned"
  | "cancelled"
  | "completed_from_verifying"
  | "already_terminal"
  | "skipped";

export interface SessionRecoveryOutcome {
  sessionId: string;
  action: RecoveryAction;
  detail?: string;
}

export class HarnessRecovery {
  private readonly now: () => Date;
  private readonly ownerId: string;
  private readonly maxAttempts: number;

  constructor(private deps: RecoveryDeps) {
    this.now = deps.now ?? (() => new Date());
    this.ownerId = deps.ownerId ?? "recovery";
    this.maxAttempts = deps.maxDirectiveAttempts ?? 3;
  }

  /** Boot: void all leases, then decide every live session's fate (§9). */
  async reconcileOnBoot(): Promise<SessionRecoveryOutcome[]> {
    this.deps.store.voidAllLeases();
    const out: SessionRecoveryOutcome[] = [];
    for (const s of this.deps.store.liveSessions()) {
      out.push(await this.recoverSession(s.sessionId));
    }
    return out;
  }

  /**
   * Lease sweeper: a live session whose lease is expired (or absent) is handed to
   * recovery. Takeover is by CAS-acquiring a fresh token — a still-alive runner
   * that holds a valid lease is skipped.
   */
  async sweepExpiredLeases(): Promise<SessionRecoveryOutcome[]> {
    const nowIso = this.now().toISOString();
    const out: SessionRecoveryOutcome[] = [];
    for (const s of this.deps.store.liveSessions()) {
      if (s.leaseToken && s.leaseExpiresAt && s.leaseExpiresAt > nowIso) continue; // held by a live runner
      out.push(await this.recoverSession(s.sessionId));
    }
    return out;
  }

  /** Decide one live session. Acquires the (void) lease so its writes are fenced. */
  async recoverSession(sessionId: string): Promise<SessionRecoveryOutcome> {
    const s0 = this.deps.store.get(sessionId);
    if (!s0) return { sessionId, action: "skipped", detail: "no such session" };
    if (isTerminal(s0.state)) return { sessionId, action: "already_terminal" };

    const lease = this.deps.store.acquireLease(sessionId);
    if (!lease) return { sessionId, action: "skipped", detail: "leased by a live runner" };
    this.deps.store.appendRecoveryEvent(sessionId, "lease_taken_over");

    try {
      // 1. Replay any unapplied guard directives (may orphan the session).
      const replay = await this.replayDirectives(sessionId, lease);
      if (replay.orphaned) return { sessionId, action: "orphaned", detail: replay.detail };
      let s = this.deps.store.get(sessionId)!;
      if (isTerminal(s.state)) return { sessionId, action: "already_terminal" };

      // 1b. A durable cancel intent (a replayed `cancel` directive, or a
      //     plane/user cancel set before the crash) is honored ahead of any
      //     resume/orphan decision: §9's cancel order lands at a terminal CAS,
      //     with a checkpoint ATTEMPT first (H-I4).
      if (s.cancelRequested && s.state !== "VERIFYING") {
        const checkpoint = await this.attemptCheckpoint(sessionId, s.executionRequestId);
        this.finalize(sessionId, s, lease, "CANCELLED", {
          cancellation: { requestedBy: "plane", at: this.now().toISOString() },
          checkpoint,
        });
        this.deps.store.appendRecoveryEvent(
          sessionId,
          "cancelled",
          checkpoint.committed ? "checkpoint committed" : "checkpoint not committed",
        );
        return { sessionId, action: "cancelled" };
      }

      // 2. Settle any answered-but-undelivered approvals before deciding the session.
      await this.settleDeliveryUnknown(sessionId, lease);
      s = this.deps.store.get(sessionId)!;
      if (isTerminal(s.state)) return { sessionId, action: "already_terminal" };
      // The awaited steps above may have burned into the lease TTL — re-fence
      // before the remaining writes so a concurrent sweep cannot take over.
      this.deps.store.renewLease(sessionId, lease);

      // 3. Crashed mid-VERIFYING: execution had finished, so complete it — with
      //    no verification (it was never durably recorded); §5. Usage is
      //    recomputed from persisted `usage.updated` events (§9 recovery table);
      //    enforcement fidelity a dead process's tier probe cannot be re-derived,
      //    so it is reported at the conservative floor, never assumed higher.
      if (s.state === "VERIFYING") {
        this.finalize(sessionId, s, lease, "COMPLETED", { usage: this.recomputeUsage(sessionId) });
        this.deps.store.appendRecoveryEvent(sessionId, "completed_from_verifying");
        return { sessionId, action: "completed_from_verifying" };
      }

      // 4. Probe-resumable → offer resume; the Control Plane issues origin:resume.
      //    The offer is emitted ONCE — until the (deferred) orchestrator cutover
      //    consumes it, later sweeps of the still-live session must not re-emit.
      const manifest = this.deps.registry.manifest(s0.executionRequestId ? assistantOf(this.deps.store, sessionId) : "");
      const resumable = !!manifest?.core.canResume && !!s.providerSessionRef;
      if (resumable) {
        if (this.deps.store.hasRecoveryDecision(sessionId, "resume_offered")) {
          return { sessionId, action: "skipped", detail: "resume already offered" };
        }
        this.deps.store.appendRecoveryEvent(sessionId, "resume_offered", s.providerSessionRef);
        return { sessionId, action: "resume_offered", detail: s.providerSessionRef };
      }

      // 5. Not resumable → orphan, with a checkpoint attempt (H-I4).
      const failure = { kind: "orphaned" as const, retryable: true, message: "session orphaned by a crashed runner; not resumable" };
      const checkpoint = await this.attemptCheckpoint(sessionId, s.executionRequestId);
      this.finalize(sessionId, s, lease, "FAILED", { failure, checkpoint });
      this.deps.store.appendRecoveryEvent(sessionId, "orphaned", checkpoint.committed ? "checkpoint committed" : "checkpoint not committed");
      return { sessionId, action: "orphaned" };
    } finally {
      this.deps.store.releaseLease(sessionId, lease);
    }
  }

  /**
   * Re-apply the session's `pending` guard directives idempotently, capped at
   * `maxDirectiveAttempts`. A directive that permanently fails orphan-fails the
   * session with a typed audit event (§9).
   */
  async replayDirectives(
    sessionId: string,
    lease: string,
  ): Promise<{ applied: number; orphaned: boolean; detail?: string }> {
    let applied = 0;
    for (const d of this.deps.store.pendingDirectives(sessionId)) {
      const attempts = this.deps.store.incrementDirectiveAttempt(d.id);
      try {
        await this.applyDirective(sessionId, d);
        this.deps.store.markDirectiveApplied(d.id);
        this.deps.store.appendRecoveryEvent(sessionId, "directive_replayed", `${d.guard}/${d.directive}`);
        applied += 1;
      } catch (err) {
        if (attempts >= this.maxAttempts) {
          this.deps.store.markDirectiveFailed(d.id);
          const s = this.deps.store.get(sessionId)!;
          if (!isTerminal(s.state)) {
            const checkpoint = await this.attemptCheckpoint(sessionId, s.executionRequestId);
            this.finalize(
              sessionId,
              s,
              lease,
              "FAILED",
              {
                failure: {
                  kind: "orphaned",
                  retryable: false,
                  message: `guard directive ${d.guard}/${d.directive} permanently failed replay`,
                },
                checkpoint,
              },
            );
          }
          this.deps.store.appendRecoveryEvent(sessionId, "directive_failed", `${d.guard}/${d.directive}: ${redact(err)}`);
          return { applied, orphaned: true, detail: `${d.guard}/${d.directive} failed replay` };
        }
      }
    }
    return { applied, orphaned: false };
  }

  /**
   * Recovery of an answered-but-undelivered approval (§4). A crash anywhere in
   * `answered → delivering → delivered` leaves the decision durable but the
   * delivery unconfirmed — every such row (`answered` / `delivering` /
   * `delivery_unknown`) resumes the protocol here. With a proven ack lookup:
   * probe and settle atomically (approval `delivered` + session `RUNNING` in one
   * transaction). Otherwise HOLD — re-delivery needs a live provider handle a
   * crash did not preserve, so the session stays AWAITING_APPROVAL with the
   * ambiguity surfaced (never silently "delivered").
   */
  async settleDeliveryUnknown(sessionId: string, lease: string): Promise<void> {
    const undelivered = new Set(["answered", "delivering", "delivery_unknown"]);
    const rows = this.deps.approvals.unsettled(sessionId).filter((r) => undelivered.has(r.state));
    if (rows.length === 0) return;
    const manifest = this.deps.registry.manifest(assistantOf(this.deps.store, sessionId));
    for (const r of rows) {
      if (manifest?.harness?.approvalAckLookup && this.deps.approvalAckLookup) {
        const acked = await this.deps.approvalAckLookup(sessionId, r.providerRequestId);
        if (acked) {
          const s = this.deps.store.get(sessionId)!;
          if (s.state === "AWAITING_APPROVAL") {
            // One transaction: approval -> delivered AND session -> RUNNING.
            this.deps.store.resumeFromApproval(sessionId, r.providerRequestId, {
              expectedVersion: s.version,
              leaseToken: lease,
            });
          } else {
            this.deps.approvals.markDelivered(sessionId, r.providerRequestId);
          }
          this.deps.store.appendRecoveryEvent(sessionId, "approval_ack_confirmed", r.providerRequestId);
          continue;
        }
      }
      this.deps.store.appendRecoveryEvent(
        sessionId,
        "approval_delivery_held",
        `${r.providerRequestId}: delivery unconfirmed, no ack lookup — held for operator/plane resolution`,
      );
    }
  }

  // --- helpers -------------------------------------------------------------

  private async applyDirective(sessionId: string, d: { guard: string; directive: string }): Promise<void> {
    const s = this.deps.store.get(sessionId)!;
    switch (d.directive) {
      case "checkpoint":
        await this.deps.checkpoints.create(taskOf(this.deps.store, sessionId), sessionId, "limit");
        return;
      case "cancel":
        // Idempotent 0->1 durable intent — the session's next settler honors it.
        this.deps.store.requestCancel(sessionId);
        return;
      case "pause":
      case "yield":
      case "continue":
        // No side effect to replay: the session state already reflects where it
        // got to; recoverSession's resume-vs-orphan decision covers it.
        void s;
        return;
      default:
        throw new Error(`unknown directive ${d.directive}`);
    }
  }

  private async attemptCheckpoint(
    sessionId: string,
    _requestId: string,
  ): Promise<ExecutionResult["checkpoint"]> {
    try {
      const c = await this.deps.checkpoints.create(taskOf(this.deps.store, sessionId), sessionId, "cancel");
      return { attempted: true, committed: c.gitRef !== null, checkpointId: c.id, gitRef: c.gitRef ?? undefined };
    } catch {
      return { attempted: true, committed: false };
    }
  }

  /**
   * Best-effort budget reconstruction from persisted `usage.updated` events
   * (§9 recovery table: "Budget counters — recomputed from persisted
   * usage.updated events"). `delta` sums; `cumulative` takes the last/max;
   * `none` (or no manifest / no events) yields zeros.
   */
  private recomputeUsage(
    sessionId: string,
  ): { inputTokens: number; outputTokens: number; accounting: "delta" | "cumulative" | "none" } {
    const accounting =
      this.deps.registry.manifest(assistantOf(this.deps.store, sessionId))?.harness?.usageAccounting ?? "none";
    if (accounting === "none") return { inputTokens: 0, outputTokens: 0, accounting };
    let input = 0;
    let output = 0;
    for (const e of this.deps.store.usageEvents(sessionId)) {
      const i = e.inputTokens ?? 0;
      const o = e.outputTokens ?? 0;
      if (accounting === "cumulative") {
        input = Math.max(input, i);
        output = Math.max(output, o);
      } else {
        input += i;
        output += o;
      }
    }
    return { inputTokens: input, outputTokens: output, accounting };
  }

  private finalize(
    sessionId: string,
    session: ExecutionSession,
    lease: string,
    to: "FAILED" | "COMPLETED" | "CANCELLED",
    parts:
      | {
          failure?: ExecutionResult["failure"];
          cancellation?: ExecutionResult["cancellation"];
          checkpoint?: ExecutionResult["checkpoint"];
          usage?: ExecutionResult["usage"];
        }
      | undefined,
  ): void {
    const checkpoint = parts?.checkpoint ?? { attempted: false, committed: false };
    const outcome = to === "FAILED" ? "failed" : to === "CANCELLED" ? "cancelled" : "completed";
    const result: ExecutionResult = {
      schemaVersion: 1,
      sessionId: sessionId as ExecutionResult["sessionId"],
      terminalState: to,
      outcome,
      failure: parts?.failure,
      cancellation: parts?.cancellation,
      artifacts: checkpoint.checkpointId
        ? [{ kind: "checkpoint", ref: checkpoint.checkpointId, summary: checkpoint.committed ? "recovery checkpoint" : "recovery checkpoint (uncommitted)" }]
        : [],
      usage: parts?.usage ?? { inputTokens: 0, outputTokens: 0, accounting: "none" },
      checkpoint,
      // A dead process's provider-isolation tier probe cannot be re-derived;
      // report the conservative floor (H-I10: never assume a higher fidelity).
      enforcement: { tools: "none", budget: "none", isolation: "ambient" },
    };
    // Re-read version — appendRecoveryEvent does not bump it, but replay steps
    // above may have (requestCancel).
    const live = this.deps.store.get(sessionId)!;
    this.deps.store.terminalize(sessionId, {
      expectedVersion: live.version,
      from: live.state,
      to,
      leaseToken: lease,
      settlementOwner: this.ownerId,
      result,
    });
    void session;
  }
}

function isTerminal(state: ExecutionSession["state"]): boolean {
  return ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "YIELDED"].includes(state);
}

function assistantOf(store: SessionStore, sessionId: string): string {
  return (store as unknown as { db: { prepare(sql: string): { get(id: string): { assistant_id: string } | undefined } } }).db
    .prepare("SELECT assistant_id FROM runs WHERE id = ?")
    .get(sessionId)?.assistant_id ?? "";
}

function taskOf(store: SessionStore, sessionId: string): string {
  return (store as unknown as { db: { prepare(sql: string): { get(id: string): { task_id: string } | undefined } } }).db
    .prepare("SELECT task_id FROM runs WHERE id = ?")
    .get(sessionId)?.task_id ?? "";
}

/** Redact an exception message through the repo's full redaction pipeline before it is persisted. */
function redact(err: unknown): string {
  return redactValue(err instanceof Error ? err.message : String(err)).slice(0, 500);
}
