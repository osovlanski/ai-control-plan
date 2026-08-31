/**
 * SessionRunner — the named pipeline coordinator (execution-harness §4).
 *
 * One instance per session, the ONLY writer of that session's row (lease + CAS,
 * §9). It owns sequencing, cancellation, rollback and terminal arbitration; the
 * stage collaborators (store, recorder, guards, approvals, authority) receive
 * explicit inputs and never write session state themselves.
 *
 *   Prepare → Context → [Guarded Execute + Observe] → Checkpoint → Verify → Finalize
 *
 * H-I1: the runner never selects or substitutes an assistant/model. When
 * execution evidence says the route is unsuitable it ends the session YIELDED
 * with a structured RerouteRequest — only the Control Plane's router acts on it.
 *
 * Phase 3 scope: additive. The orchestrator is not yet delegated to this runner;
 * that cutover (and the legacy runs.state vocabulary rewrite) is deferred. The
 * verification stage here is the minimal command runner; Phase 5 hardens it.
 */
import type {
  AgentAdapter,
  CapabilityManifest,
  EvaluationResult,
  ExecutionFailure,
  ExecutionRequest,
  ExecutionResult,
  ExecutionSessionState,
  HandoffRequest,
  NormalizedEvent,
  ProviderSessionRef,
  RerouteRequest,
  RunHandle,
  TerminalSessionState,
  UsagePayload,
  VerificationSpec,
} from "@agent-plane/core";
import { newExecutionSessionId, outcomeOf } from "@agent-plane/core";
import type { SessionStore } from "./session-store.js";
import type { EventRecorder } from "./event-recorder.js";
import type { ApprovalService } from "./approval-service.js";
import type { HandoffService } from "./handoff.js";
import type { Db } from "../../db/index.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";
import { WorkspaceError } from "./workspace-authority.js";
import { SecretBroker, type SecretResolver } from "./secret-broker.js";
import {
  accumulateTokens,
  evaluateGuards,
  type GuardDirective,
  type GuardSnapshot,
} from "./guards.js";

export interface RunnerRegistry {
  adapter(id: string): AgentAdapter;
  manifest(id: string): CapabilityManifest | null;
}

export interface RunnerCheckpoints {
  create(
    taskId: string,
    sessionId: string,
    reason: "limit" | "handoff" | "cancel" | "completion" | "periodic" | "manual",
  ): Promise<{ id: string; gitRef: string | null }>;
}

export interface RunnerDeps {
  store: SessionStore;
  recorder: EventRecorder;
  approvals: ApprovalService;
  checkpoints: RunnerCheckpoints;
  registry: RunnerRegistry;
  authority?: WorkspaceAuthority;
  /** When present, a YIELD assembles + commits a handoff envelope in the terminal tx (§7). */
  handoff?: HandoffService;
  softThresholdPct?: number;
  now?: () => Date;
  runnerId?: string;
  /** Poll interval while a session is AWAITING_APPROVAL. */
  approvalPollMs?: number;
  /** Resolves the request's secret REFERENCES at the launch boundary (§3). */
  secretResolver?: SecretResolver;
  /**
   * Per-session provider-process containment probe (§3). Returns true when the
   * declared OS/provider sandbox is verified active for THIS launch config.
   * Absent ⇒ the session reports at most `partial` isolation.
   */
  verifyIsolation?: (sessionId: string) => Promise<boolean> | boolean;
}

const POLICY_UNENFORCEABLE = "policy_unenforceable" as const;

export class SessionRunner {
  private readonly now: () => Date;
  private readonly softThresholdPct: number;
  private readonly runnerId: string;
  private readonly approvalPollMs: number;

  constructor(private deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.softThresholdPct = deps.softThresholdPct ?? 80;
    this.runnerId = deps.runnerId ?? `runner_${newExecutionSessionId()}`;
    this.approvalPollMs = deps.approvalPollMs ?? 20;
  }

  /** Execute one request end to end. Always returns a persisted ExecutionResult (H-I3). */
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const { store } = this.deps;
    store.recordRequest(request);
    const session = store.createSession(request.executionRequestId);
    const sessionId = session.sessionId as string;

    // Idempotent resubmission of a finished request → its stored result (H-I8).
    if (session.state !== "PREPARED") {
      const existing = store.result(sessionId);
      if (existing) return existing;
      // A live session from a crashed process. Resuming its provider / unsettled
      // approvals is boot-reconcile work (Phase 7) — fail loudly rather than
      // re-run PREPARED→STARTING and corrupt it.
      throw new Error(
        `session ${sessionId} is ${session.state} with no result — restart recovery (Phase 7) is required`,
      );
    }

    const lease = store.acquireLease(sessionId);
    if (!lease) throw new Error(`session ${sessionId} is already leased by another runner`);
    const ctx = new RunContext(sessionId, request, lease, this);

    try {
      return await ctx.execute();
    } finally {
      store.releaseLease(sessionId, lease);
    }
  }

  // exposed to RunContext
  get d(): RunnerDeps {
    return this.deps;
  }
  clock(): number {
    return this.now().getTime();
  }
  get soft(): number {
    return this.softThresholdPct;
  }
  get owner(): string {
    return this.runnerId;
  }
  get pollMs(): number {
    return this.approvalPollMs;
  }
  static readonly UNENFORCEABLE = POLICY_UNENFORCEABLE;
}

/** Per-run mutable state, so the SessionRunner instance itself stays stateless. */
class RunContext {
  private version = 0;
  private tokens = { input: 0, output: 0 };
  private sawError = false;
  private endedOk: boolean | undefined;
  private rerouteReason: RerouteRequest["reason"] | undefined;
  private snapshot: GuardSnapshot;
  private lastEvidenceSeq = 0;
  private evidence: RerouteRequest["evidence"] = [];
  private cancelBy: "user" | "plane" = "plane";
  private tickPlan: TerminalPlan | undefined;
  private ticking = false;
  private embeddedFailure: ExecutionFailure | undefined;
  /** Resolved by a tick that wants the event loop to stop racing a hung iterator. */
  private readonly abort = deferred();
  private isolationVerified = false;

  constructor(
    private sessionId: string,
    private request: ExecutionRequest,
    private lease: string,
    private runner: SessionRunner,
  ) {
    const startedAtMs = runner.clock();
    this.snapshot = {
      policy: request.policy,
      startedAtMs,
      lastEventAtMs: startedAtMs,
      tokensSoFar: 0,
      softCheckpointed: false,
      accountingMode: this.accountingMode(),
      softThresholdPct: runner.soft,
    };
  }

  private get d(): RunnerDeps {
    return this.runner.d;
  }

  async execute(): Promise<ExecutionResult> {
    // --- Prepare ---------------------------------------------------------
    const manifest = this.d.registry.manifest(this.request.assistantId);
    const unenforceable = this.checkEnforceability(manifest);
    if (unenforceable) return this.finalizeFailure("FAILED", { kind: SessionRunner.UNENFORCEABLE, retryable: false, message: unenforceable }, "PREPARED");

    if (this.request.context.worktree && this.d.authority) {
      try {
        this.d.authority.validateRoots({
          repoPath: this.request.context.worktree.repoPath,
          worktreePath: this.request.context.worktree.worktreePath,
        });
      } catch (err) {
        const message = err instanceof WorkspaceError ? err.message : String(err);
        return this.finalizeFailure("FAILED", { kind: "workspace", retryable: false, message }, "PREPARED");
      }
    }

    // Per-session provider-process containment verification (§3): a `full`
    // requirement that passed Prepare's manifest check must still be PROVEN for
    // this exact launch config before RUNNING — a declaration is never a proof.
    if (this.request.policy.isolation.required === "full") {
      const verified = this.d.verifyIsolation ? await this.d.verifyIsolation(this.sessionId) : false;
      if (!verified) {
        return this.finalizeFailure(
          "FAILED",
          {
            kind: SessionRunner.UNENFORCEABLE,
            retryable: false,
            message: "per-session provider-process containment verification did not confirm a full sandbox",
          },
          "PREPARED",
        );
      }
      this.isolationVerified = true;
    }

    // --- Execute + Observe ---------------------------------------------
    this.transition("PREPARED", "STARTING"); // durable start intent (§9)
    const adapter = this.d.registry.adapter(this.request.assistantId);

    let handle: RunHandle;
    try {
      handle = await this.startProvider(adapter);
    } catch (err) {
      return this.finalizeFailure(
        "FAILED",
        normalizeStartError(err),
        "STARTING",
      );
    }
    if (handle.providerSessionRef) {
      this.version = this.d.store.ackHandle(this.sessionId, handle.providerSessionRef, {
        expectedVersion: this.version,
        leaseToken: this.lease,
      }).version;
    }

    let firstEvent = true;
    let terminalPlan: TerminalPlan | undefined;
    // Heartbeat: hard/idle timeouts and the durable cancel intent must be
    // observed even while `adapter.events()` is stalled, and the fencing lease
    // must keep being renewed (§9). A trip aborts the provider stream, which
    // ends the loop below with `this.tickPlan` set.
    const heartbeat = setInterval(() => {
      void this.onTick(adapter, handle);
    }, this.runner.pollMs * 5);
    const iter = adapter.events(handle)[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Race the next event against the abort signal so a truly hung iterator
        // (a stalled provider) still yields to a tick-driven timeout/cancel.
        const step = await Promise.race([
          iter.next(),
          this.abort.promise.then(() => ({ done: true, value: undefined }) as IteratorResult<NormalizedEvent>),
        ]);
        if (step.done || this.tickPlan) break;
        const event = step.value;
        if (firstEvent) {
          this.transition("STARTING", "RUNNING", { providerStartAcked: true });
          firstEvent = false;
        }
        this.observe(event);
        const directive = evaluateGuards(this.snapshot, { kind: "event", event, atMs: this.runner.clock() });
        const nontrivial = directive.action !== "continue";

        // Co-commit the triggering event, the guard.decision audit event and the
        // pending directive in ONE transaction (§4). The directive flips to
        // `applied` only after its action succeeds; a crash between leaves a
        // `pending` row for the Phase 7 replay worker.
        let directiveId: number | undefined;
        this.recordEvents(
          nontrivial ? [event, this.guardDecisionEvent(directive)] : [event],
          nontrivial
            ? (durable) => {
                directiveId = this.d.store.recordPendingDirective(
                  this.sessionId,
                  durable[0]!.seq,
                  directive.guard,
                  directive.action,
                  directive,
                );
              }
            : undefined,
        );
        this.d.store.renewLease(this.sessionId, this.lease);

        if (nontrivial) {
          const planned = await this.applyDirective(directive, adapter, handle);
          if (directiveId !== undefined) this.d.store.markDirectiveApplied(directiveId);
          if (planned) {
            terminalPlan = planned;
            break;
          }
        }
        if (this.d.store.get(this.sessionId)?.cancelRequested) {
          this.cancelBy = "plane";
          terminalPlan = { kind: "cancel", by: this.cancelBy };
          break;
        }
      }
    } catch (err) {
      this.sawError = true;
      this.endedOk = false;
      this.recordEvents([
        { runId: this.sessionId as never, ts: this.iso(), type: "error", summary: redactMessage(err) },
      ]);
    } finally {
      clearInterval(heartbeat);
      void iter.return?.(undefined); // release a still-open iterator
    }
    terminalPlan ??= this.tickPlan;
    if (firstEvent && !terminalPlan) {
      // Stream never produced an event — treat provider start as unknown/failed.
      return this.finalizeFailure(
        "FAILED",
        { kind: "provider_fault", retryable: true, message: "provider stream never began" },
        "STARTING",
      );
    }
    if (firstEvent && terminalPlan) {
      // A tick tripped before the stream began — the session is still STARTING.
      await safeCancel(adapter, handle);
      const to: TerminalSessionState =
        terminalPlan.kind === "cancel"
          ? "CANCELLED"
          : terminalPlan.kind === "fail" && terminalPlan.failure.kind === "timeout"
            ? "TIMED_OUT"
            : "FAILED";
      const cp = await this.attemptCheckpoint("cancel");
      return this.finalize("STARTING", to, {
        failure: terminalPlan.kind === "fail" ? terminalPlan.failure : undefined,
        cancellation: terminalPlan.kind === "cancel" ? { requestedBy: terminalPlan.by, at: this.iso() } : undefined,
        checkpoint: cp,
      });
    }

    // --- decide the terminal state ---------------------------------
    if (!terminalPlan) {
      if (this.endedOk === true) {
        terminalPlan = { kind: "verify" };
      } else if (this.rerouteReason) {
        // Execution evidence says the selected assistant/model is unsuitable —
        // yield a structured RerouteRequest; only the plane's router acts (H-I1).
        terminalPlan = { kind: "yield", yieldKind: "reroute" };
      } else if (this.sawError) {
        terminalPlan = {
          kind: "fail",
          failure:
            this.embeddedFailure ?? {
              kind: "provider_fault",
              retryable: true,
              message: "provider session ended with an error",
            },
        };
      } else {
        terminalPlan = {
          kind: "fail",
          failure: { kind: "provider_fault", retryable: false, message: "provider session ended without completing" },
        };
      }
    }

    return this.carryOut(terminalPlan, adapter, handle);
  }

  // --- terminal execution ------------------------------------------------

  private async carryOut(plan: TerminalPlan, adapter: AgentAdapter, handle: RunHandle): Promise<ExecutionResult> {
    if (plan.kind === "verify") return this.verifyThenComplete();

    // cancel / fail / yield: stop the provider, attempt a checkpoint, terminalize.
    await safeCancel(adapter, handle);
    const checkpoint = await this.attemptCheckpoint(
      plan.kind === "cancel" ? "cancel" : plan.kind === "yield" ? "handoff" : "handoff",
    );

    if (plan.kind === "cancel") {
      const from = this.d.store.get(this.sessionId)!.state;
      return this.finalize(from, "CANCELLED", {
        cancellation: { requestedBy: plan.by, at: this.iso() },
        checkpoint,
      });
    }
    if (plan.kind === "fail") {
      const to: TerminalSessionState = plan.failure.kind === "timeout" ? "TIMED_OUT" : "FAILED";
      const from = this.d.store.get(this.sessionId)!.state;
      return this.finalize(from, to, { failure: plan.failure, checkpoint });
    }
    // yield: assemble the handoff/reroute envelope from the immutable checkpoint
    // snapshot and commit it INSIDE the terminal transaction (§7, §8).
    const from = this.d.store.get(this.sessionId)!.state;
    let extra: ((db: Db) => void) | undefined;
    let envelopeId: string | undefined;
    if (checkpoint.checkpointId && this.d.handoff) {
      const { envelope, sourceSessionId } = this.d.handoff.deriveEnvelope(checkpoint.checkpointId, {
        reason: this.rerouteReason ?? "session yielded",
        fromAssistantId: this.request.assistantId,
      });
      envelopeId = envelope.envelopeId;
      extra = (db) => this.d.handoff!.insertEnvelope(db, envelope, { sourceSessionId });
    }
    const detail =
      plan.yieldKind === "reroute"
        ? this.buildReroute(checkpoint.checkpointId)
        : this.buildHandoff(envelopeId);
    return this.finalize(from, "YIELDED", {
      yield: { kind: plan.yieldKind, detail },
      checkpoint,
      extra,
    });
  }

  /**
   * Heartbeat tick (only meaningful while RUNNING, not during AWAITING_APPROVAL
   * where the clocks are paused, §5). Renews the lease and evaluates the
   * time-based guards; a trip records `tickPlan` and aborts the provider stream.
   */
  private async onTick(adapter: AgentAdapter, handle: RunHandle): Promise<void> {
    if (this.ticking || this.tickPlan) return;
    this.ticking = true;
    try {
      const session = this.d.store.get(this.sessionId);
      if (!session || session.state !== "RUNNING") return;
      this.d.store.renewLease(this.sessionId, this.lease);

      if (session.cancelRequested) {
        this.cancelBy = "plane";
        this.tickPlan = { kind: "cancel", by: "plane" };
      } else {
        const d = evaluateGuards(this.snapshot, { kind: "tick", atMs: this.runner.clock() });
        if (d.action === "cancel" && d.failure) {
          this.tickPlan = {
            kind: "fail",
            failure: { kind: d.failure.kind, retryable: d.failure.retryable, message: d.reason },
          };
        }
      }
      if (this.tickPlan) {
        this.abort.resolve();
        await safeCancel(adapter, handle);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async verifyThenComplete(): Promise<ExecutionResult> {
    this.transition("RUNNING", "VERIFYING");
    const verification = await this.runVerification(this.request.verification);
    if (verification) {
      this.recordEvents([
        {
          runId: this.sessionId as never,
          ts: this.iso(),
          type: "verification.result",
          summary: verification.passed ? "verification passed" : "verification failed",
          payload: { passed: verification.passed, checks: verification.checks },
        },
      ]);
    }
    const checkpoint = await this.attemptCheckpoint("completion");
    // outcome is "completed" even when verification.passed === false (H-I6):
    // the Control Plane, not the Harness, decides the task verdict.
    return this.finalize("VERIFYING", "COMPLETED", { verification, checkpoint });
  }

  // --- pipeline helpers -----------------------------------------------

  private checkEnforceability(manifest: CapabilityManifest | null): string | undefined {
    const p = this.request.policy;
    const h = manifest?.harness;
    const adapter = this.d.registry.adapter(this.request.assistantId);
    const canRelay = h?.approvalRelay ?? typeof adapter.send === "function";

    if (p.approval.mode === "prompt-on-escalation" && !canRelay) {
      return "approval mode prompt-on-escalation requires an adapter that can relay answers";
    }
    if (p.tools.mode === "preventive" && h?.toolGating !== "preventive") {
      return "tools.mode preventive requires a manifest toolGating: preventive";
    }
    if (p.budget.enforcement === "bounded") {
      if (!h || h.usageAccounting === "none" || !h.usageReporting) {
        return "budget.enforcement bounded requires a proven quantitative usage-reporting contract";
      }
      if (p.budget.maxCostUsd !== undefined) {
        // H-I10: a bounded COST cap needs a pricing table to derive cost from
        // tokens. That table is not implemented yet — reject rather than
        // silently enforce only the token cap.
        return "bounded cost caps are not enforceable yet (no pricing table) — use a token cap or advisory mode";
      }
    }
    if (p.isolation.required === "full" && h?.processIsolation !== "os-sandbox" && h?.processIsolation !== "provider-sandbox") {
      return "isolation.required full requires an OS/provider process sandbox that this adapter does not declare";
    }
    return undefined;
  }

  /** The runSpec the adapter actually receives — policy-derived gate + idempotency key (§6). */
  private effectiveRunSpec() {
    const p = this.request.policy;
    return {
      ...this.request.runSpec,
      toolPolicy:
        p.tools.allow || p.tools.deny || p.tools.mode === "preventive"
          ? { allow: p.tools.allow, deny: p.tools.deny, mode: p.tools.mode }
          : undefined,
      runControl: { executionRequestId: this.request.executionRequestId },
    };
  }

  private async startProvider(adapter: AgentAdapter): Promise<RunHandle> {
    const spec = this.effectiveRunSpec();

    // Resolve secret REFERENCES at the launch boundary; values are transient,
    // injected by the adapter, dropped straight after (§3).
    const refs = this.request.context.secretRefs ?? [];
    let broker: SecretBroker | undefined;
    if (refs.length > 0 && this.d.secretResolver) {
      broker = new SecretBroker(this.d.secretResolver, refs);
      spec.secretEnv = broker.resolve(refs);
    }
    try {
      if (this.request.origin.kind === "resume") {
        const prior = this.d.store.get(this.request.origin.sessionId as string);
        const ref = prior?.providerSessionRef;
        if (ref && typeof adapter.resume === "function") {
          return await adapter.resume(ref as ProviderSessionRef, spec);
        }
      }
      return await adapter.start(spec);
    } finally {
      broker?.dispose();
      delete spec.secretEnv;
    }
  }

  private observe(event: NormalizedEvent): void {
    this.snapshot.lastEventAtMs = this.runner.clock();
    if (typeof event.seq === "number") this.lastEvidenceSeq = event.seq;

    switch (event.type) {
      case "usage.updated": {
        const payload = event.payload as UsagePayload | undefined;
        this.tokens.input = accumulateTokens(this.tokens.input, { inputTokens: payload?.inputTokens }, this.snapshot.accountingMode);
        this.tokens.output = accumulateTokens(this.tokens.output, { outputTokens: payload?.outputTokens }, this.snapshot.accountingMode);
        this.snapshot.tokensSoFar = this.tokens.input + this.tokens.output;
        break;
      }
      case "error": {
        this.sawError = true;
        // Prefer the adapter's own normalized failure when it embeds one (§6).
        const embedded = (event.payload as { failure?: ExecutionFailure } | undefined)?.failure;
        if (embedded && typeof embedded.kind === "string") this.embeddedFailure = embedded;
        // Only "this route genuinely cannot do the task" is an immediate reroute
        // signal. Auth/quota normalize to FAILED(auth|quota) and the plane
        // decides retry vs re-route — the Harness never yields on them itself.
        const kind = (event.payload as { kind?: string } | undefined)?.kind;
        if (kind === "capability_missing" || kind === "model_unsuitable") {
          this.rerouteReason = kind;
          this.evidence.push({ eventSeq: this.lastEvidenceSeq, summary: event.summary });
        } else if (kind === "auth_failed" && !this.embeddedFailure) {
          this.embeddedFailure = { kind: "auth", retryable: false, message: event.summary };
        } else if (kind === "quota_exhausted" && !this.embeddedFailure) {
          this.embeddedFailure = { kind: "quota", retryable: true, message: event.summary };
        }
        break;
      }
      case "run.ended":
        this.endedOk = (event.payload as { ok?: boolean } | undefined)?.ok !== false;
        break;
      default:
        break;
    }
  }

  private async applyDirective(
    directive: GuardDirective,
    adapter: AgentAdapter,
    handle: RunHandle,
  ): Promise<TerminalPlan | undefined> {
    switch (directive.action) {
      case "checkpoint":
        await this.attemptCheckpoint("limit");
        this.snapshot.softCheckpointed = true;
        return undefined;
      case "pause": {
        const outcome = await this.approvalFlow(adapter, handle);
        if (outcome === "cancelled") return { kind: "cancel", by: this.cancelBy };
        if (outcome === "delivery_unknown") {
          return {
            kind: "fail",
            failure: { kind: "provider_fault", retryable: true, message: "approval delivery unknown — held for recovery" },
          };
        }
        return undefined;
      }
      case "cancel":
        return {
          kind: "fail",
          failure: {
            kind: directive.failure!.kind,
            retryable: directive.failure!.retryable,
            message: directive.reason,
          },
        };
      case "yield":
        return {
          kind: "yield",
          yieldKind: this.rerouteReason ? "reroute" : (directive.yieldKind ?? "limit"),
        };
      default:
        return undefined;
    }
  }

  private async approvalFlow(
    adapter: AgentAdapter,
    handle: RunHandle,
  ): Promise<"delivered" | "cancelled" | "delivery_unknown"> {
    // The provider_request_id rode on the approval.requested payload that the
    // triggering recorder batch just persisted.
    const providerRequestId = this.lastApprovalRequestId;
    if (!providerRequestId) return "delivered";

    // Only prompt-on-escalation pauses for a human. auto-approve answers yes and
    // read-only answers no, immediately — no AWAITING_APPROVAL hop (§4).
    const mode = this.request.policy.approval.mode;
    if (mode !== "prompt-on-escalation") {
      if (typeof adapter.send === "function") {
        await adapter.send(handle, {
          kind: "approval",
          requestId: providerRequestId,
          approved: mode === "auto-approve",
        });
      }
      return "delivered";
    }

    this.d.store.pauseForApproval(this.sessionId, {
      expectedVersion: this.version,
      leaseToken: this.lease,
      approvalId: `apr_${newExecutionSessionId()}`,
      providerRequestId,
    });
    this.version += 1; // pauseForApproval's CAS bumped the row

    // Budget/idle clocks are paused while awaiting (§5); poll for the answer,
    // renewing the lease so a long human wait does not cost us the session.
    // carryOut owns the actual CANCELLED transition — this loop only decides.
    const deadline = this.snapshot.startedAtMs + this.request.policy.timeout.hardMs;
    for (;;) {
      if (this.d.store.get(this.sessionId)?.cancelRequested) {
        this.cancelBy = "plane";
        return "cancelled";
      }
      const row = this.d.approvals.get(this.sessionId, providerRequestId);
      if (row && (row.state === "answered" || row.state === "delivering" || row.state === "delivery_unknown")) break;
      if ((row && row.state === "expired") || this.runner.clock() > deadline) {
        if (!row || row.state === "pending") this.d.approvals.expire(this.sessionId, providerRequestId);
        this.cancelBy = "plane"; // policy-set expiry cancels the session cleanly (§4)
        return "cancelled";
      }
      this.d.store.renewLease(this.sessionId, this.lease);
      await sleep(this.runner.pollMs);
    }

    const answered = this.d.approvals.get(this.sessionId, providerRequestId)!;
    this.d.approvals.markDelivering(this.sessionId, providerRequestId);
    if (typeof adapter.send === "function") {
      try {
        await adapter.send(handle, {
          kind: "approval",
          requestId: providerRequestId,
          approved: answered.decision === "approved",
        });
      } catch (err) {
        // At-least-once with the ambiguity NAMED (§4): the send was issued but we
        // cannot confirm it landed. Hold the state, surface delivery_unknown; the
        // ack-probe / gated-redelivery recovery is Phase 7.
        this.d.approvals.markDeliveryUnknown(
          this.sessionId,
          providerRequestId,
          `send failed: ${redactMessage(err)}`,
        );
        return "delivery_unknown";
      }
    }
    this.d.approvals.markDelivered(this.sessionId, providerRequestId);
    this.transition("AWAITING_APPROVAL", "RUNNING");
    // The provider now resumes; if the answer was "denied" it will end the
    // stream itself and the normal end-of-stream path takes over.
    return "delivered";
  }

  private lastApprovalRequestId: string | undefined;

  private recordEvents(
    events: NormalizedEvent[],
    inTransaction?: (durable: Array<{ seq: number; event: NormalizedEvent }>) => void,
  ): void {
    const stamped = events.map((e) => ({ ...e, runId: this.sessionId as never }));
    for (const e of stamped) {
      if (e.type === "approval.requested") {
        this.lastApprovalRequestId =
          (e.payload as { requestId?: string } | undefined)?.requestId ?? this.lastApprovalRequestId;
      }
    }
    const res = this.d.recorder.recordBatch({
      sessionId: this.sessionId,
      expectedVersion: this.version,
      leaseToken: this.lease,
      events: stamped,
      inTransaction,
    });
    this.version = res.newVersion;
  }

  private guardDecisionEvent(directive: GuardDirective): NormalizedEvent {
    return {
      runId: this.sessionId as never,
      ts: this.iso(),
      type: "guard.decision",
      summary: `${directive.guard}: ${directive.action} — ${directive.reason}`,
      payload: {
        guard: directive.guard,
        directive: directive.action,
        reason: directive.reason,
        failureKind: directive.failure?.kind,
        yieldKind: directive.yieldKind,
      },
    };
  }

  private transition(
    from: ExecutionSessionState,
    to: ExecutionSessionState,
    patch?: { providerSessionRef?: ProviderSessionRef; providerStartAcked?: boolean },
  ): void {
    const next = this.d.store.transition(this.sessionId, {
      expectedVersion: this.version,
      from,
      to,
      leaseToken: this.lease,
      patch,
    });
    this.version = next.version;
  }

  private async attemptCheckpoint(
    reason: "limit" | "handoff" | "cancel" | "completion",
  ): Promise<ExecutionResult["checkpoint"]> {
    try {
      const c = await this.d.checkpoints.create(this.request.taskId, this.sessionId, reason);
      return { attempted: true, committed: c.gitRef !== null, checkpointId: c.id, gitRef: c.gitRef ?? undefined };
    } catch {
      return { attempted: true, committed: false };
    }
  }

  private async runVerification(specs: VerificationSpec[]): Promise<EvaluationResult | undefined> {
    if (specs.length === 0) return undefined;
    const authority = this.d.authority;
    const worktree = this.request.context.worktree?.worktreePath;
    const checks: EvaluationResult["checks"] = [];
    for (const spec of specs) {
      let passed = false;
      let summary = "skipped (no workspace authority)";
      if (authority && worktree && spec.command) {
        const remaining = Math.max(
          1000,
          this.snapshot.startedAtMs + this.request.policy.timeout.hardMs - this.runner.clock(),
        );
        try {
          const r = await authority.runCommand({
            command: spec.command,
            worktreePath: worktree,
            timeoutMs: remaining,
          });
          passed = r.exitCode === 0 && !r.timedOut;
          summary = `${spec.command} → exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`;
        } catch (err) {
          summary = `command rejected: ${redactMessage(err)}`;
        }
      }
      checks.push({ name: spec.name, kind: spec.kind, passed, required: spec.required, summary });
    }
    const passed = checks.filter((c) => c.required).every((c) => c.passed);
    return { passed, checks };
  }

  // --- finalizers -----------------------------------------------------

  private finalizeFailure(
    to: "FAILED",
    failure: ExecutionFailure,
    from: ExecutionSessionState,
  ): ExecutionResult {
    return this.finalize(from, to, { failure, checkpoint: { attempted: false, committed: false } });
  }

  private finalize(
    _from: ExecutionSessionState,
    to: TerminalSessionState,
    parts: {
      failure?: ExecutionFailure;
      cancellation?: { requestedBy: "user" | "plane"; at: string };
      verification?: EvaluationResult;
      yield?: ExecutionResult["yield"];
      checkpoint: ExecutionResult["checkpoint"];
      /** Runs inside the terminal transaction (handoff envelope insert, §7). */
      extra?: (db: Db) => void;
    },
  ): ExecutionResult {
    const result: ExecutionResult = {
      schemaVersion: 1,
      sessionId: this.sessionId as ExecutionResult["sessionId"],
      terminalState: to,
      outcome: outcomeOf(to),
      failure: parts.failure,
      cancellation: parts.cancellation,
      verification: parts.verification,
      yield: parts.yield,
      artifacts: this.artifacts(parts),
      usage: {
        inputTokens: this.tokens.input,
        outputTokens: this.tokens.output,
        accounting: this.snapshot.accountingMode,
      },
      checkpoint: parts.checkpoint,
      enforcement: this.enforcement(),
    };
    // Re-read state + version at terminalization: a durable cancel intent (or a
    // lease-expiry sweep) may have bumped the row out from under our local
    // counter — that is the wakeup mechanism, not a conflict (§4, §9).
    const live = this.d.store.get(this.sessionId)!;
    this.d.store.terminalize(this.sessionId, {
      expectedVersion: live.version,
      from: live.state,
      to,
      leaseToken: this.lease,
      settlementOwner: this.runner.owner,
      result,
      extra: parts.extra,
    });
    return result;
  }

  private artifacts(parts: { checkpoint: ExecutionResult["checkpoint"] }): ExecutionResult["artifacts"] {
    const out: ExecutionResult["artifacts"] = [];
    if (parts.checkpoint.checkpointId) {
      out.push({
        kind: "checkpoint",
        ref: parts.checkpoint.checkpointId,
        summary: parts.checkpoint.committed ? `checkpoint ${parts.checkpoint.gitRef ?? ""}`.trim() : "checkpoint (envelope only)",
      });
    }
    return out;
  }

  private enforcement(): ExecutionResult["enforcement"] {
    const p = this.request.policy;
    const h = this.d.registry.manifest(this.request.assistantId)?.harness;
    const tools =
      p.tools.mode === "preventive"
        ? "preventive"
        : p.tools.allow || p.tools.deny
          ? "audit"
          : "none";
    const budget =
      p.budget.enforcement === "bounded"
        ? "bounded"
        : p.budget.maxTokens !== undefined || p.budget.maxCostUsd !== undefined
          ? "advisory"
          : "none";
    // `full` is reported ONLY when a per-session containment probe confirmed it
    // for this exact launch (§3) — a manifest declaration alone caps at
    // `partial`. `ambient` only when nothing better was required or declared.
    const declaresSandbox =
      h?.processIsolation === "os-sandbox" || h?.processIsolation === "provider-sandbox";
    const isolation = this.isolationVerified
      ? "full"
      : declaresSandbox || p.isolation.required === "partial"
        ? "partial"
        : "ambient";
    return { tools, budget, isolation };
  }

  /**
   * §8 RerouteRequest carries a `checkpointId`, never an envelope id — the plane
   * locates the reroute envelope with `HandoffService.byCheckpoint` /
   * `bySourceSession`. `suggestion` is a typed `never` (H-I1).
   */
  private buildReroute(checkpointId?: string): RerouteRequest {
    return {
      sessionId: this.sessionId as RerouteRequest["sessionId"],
      taskId: this.request.taskId,
      reason: this.rerouteReason ?? "repeated_provider_fault",
      evidence: this.evidence.length > 0 ? this.evidence : [{ eventSeq: this.lastEvidenceSeq, summary: "provider evidence" }],
      checkpointId,
    };
  }

  /**
   * `envelopeId` is omitted when no checkpoint committed and thus no envelope was
   * assembled — the plane parks the task instead of chasing a fabricated id
   * (Phase 4 Codex finding). It is optional in the core contract.
   */
  private buildHandoff(envelopeId?: string): HandoffRequest {
    return {
      sessionId: this.sessionId as HandoffRequest["sessionId"],
      taskId: this.request.taskId,
      ...(envelopeId ? { envelopeId } : {}),
      reason: this.rerouteReason ?? "session yielded",
    };
  }

  private accountingMode(): "delta" | "cumulative" | "none" {
    return this.d.registry.manifest(this.request.assistantId)?.harness?.usageAccounting ?? "none";
  }

  private iso(): string {
    return new Date(this.runner.clock()).toISOString();
  }
}

type TerminalPlan =
  | { kind: "verify" }
  | { kind: "fail"; failure: ExecutionFailure }
  | { kind: "cancel"; by: "user" | "plane" }
  | { kind: "yield"; yieldKind: "reroute" | "handoff" | "limit" };

function normalizeStartError(err: unknown): ExecutionFailure {
  const message = redactMessage(err);
  if (/auth|unauthor|credential|token expired/i.test(message)) {
    return { kind: "auth", retryable: false, message };
  }
  if (/quota|rate limit|429/i.test(message)) return { kind: "quota", retryable: true, message };
  return { kind: "provider_fault", retryable: true, message };
}

function redactMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]").slice(0, 2000);
}

async function safeCancel(adapter: AgentAdapter, handle: RunHandle): Promise<void> {
  try {
    await adapter.cancel(handle);
  } catch {
    // best effort — the session is terminalizing regardless
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
