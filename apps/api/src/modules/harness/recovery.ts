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

      // 2. Settle any delivery_unknown approvals before deciding the session.
      await this.settleDeliveryUnknown(sessionId, lease);
      s = this.deps.store.get(sessionId)!;
      if (isTerminal(s.state)) return { sessionId, action: "already_terminal" };

      // 3. Crashed mid-VERIFYING: execution had finished, so complete it — with
      //    no verification (it was never durably recorded); §5.
      if (s.state === "VERIFYING") {
        this.finalize(sessionId, s, lease, "COMPLETED", undefined);
        this.deps.store.appendRecoveryEvent(sessionId, "completed_from_verifying");
        return { sessionId, action: "completed_from_verifying" };
      }

      // 4. Probe-resumable → offer resume; the Control Plane issues origin:resume.
      const manifest = this.deps.registry.manifest(s0.executionRequestId ? assistantOf(this.deps.store, sessionId) : "");
      const resumable = !!manifest?.core.canResume && !!s.providerSessionRef;
      if (resumable) {
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
   * Recovery of a `delivery_unknown` approval (§4). With a proven ack lookup:
   * probe and settle. Otherwise HOLD — re-delivery needs a live provider handle
   * that a crash did not preserve, so the session stays AWAITING_APPROVAL with
   * the ambiguity surfaced (never silently "delivered").
   */
  async settleDeliveryUnknown(sessionId: string, lease: string): Promise<void> {
    const rows = this.deps.approvals.unsettled(sessionId).filter((r) => r.state === "delivery_unknown");
    if (rows.length === 0) return;
    const manifest = this.deps.registry.manifest(assistantOf(this.deps.store, sessionId));
    for (const r of rows) {
      if (manifest?.harness?.approvalAckLookup && this.deps.approvalAckLookup) {
        const acked = await this.deps.approvalAckLookup(sessionId, r.providerRequestId);
        if (acked) {
          this.deps.approvals.markDelivered(sessionId, r.providerRequestId);
          const s = this.deps.store.get(sessionId)!;
          if (s.state === "AWAITING_APPROVAL") {
            const next = this.deps.store.transition(sessionId, {
              expectedVersion: s.version,
              from: "AWAITING_APPROVAL",
              to: "RUNNING",
              leaseToken: lease,
            });
            void next;
          }
          this.deps.store.appendRecoveryEvent(sessionId, "approval_ack_confirmed", r.providerRequestId);
          continue;
        }
      }
      this.deps.store.appendRecoveryEvent(
        sessionId,
        "approval_delivery_held",
        `${r.providerRequestId}: no ack lookup — held for operator/plane resolution`,
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

  private finalize(
    sessionId: string,
    session: ExecutionSession,
    lease: string,
    to: "FAILED" | "COMPLETED",
    parts: { failure?: ExecutionResult["failure"]; checkpoint?: ExecutionResult["checkpoint"] } | undefined,
  ): void {
    const checkpoint = parts?.checkpoint ?? { attempted: false, committed: false };
    const result: ExecutionResult = {
      schemaVersion: 1,
      sessionId: sessionId as ExecutionResult["sessionId"],
      terminalState: to,
      outcome: to === "FAILED" ? "failed" : "completed",
      failure: parts?.failure,
      artifacts: checkpoint.checkpointId
        ? [{ kind: "checkpoint", ref: checkpoint.checkpointId, summary: checkpoint.committed ? "recovery checkpoint" : "recovery checkpoint (uncommitted)" }]
        : [],
      usage: { inputTokens: 0, outputTokens: 0, accounting: "none" },
      checkpoint,
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

function redact(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, 500);
}
