import { HandoffService } from './handoff.js';
/**
 * The Execution-Harness composition root (PLAN.md 8c.6) — the exact wiring
 * `buildServer` uses for its internal `Orchestrator`, extracted so a test
 * factory can build a production-equivalent Harness-wired `Orchestrator`
 * without duplicating (and risking drift from) this wiring (increment 3, D5).
 *
 * One `SessionStore` / `ApprovalService` shared by recovery, the runner and the
 * bridge. `harnessBridge` is the flag-independent seam to `SessionRunner`
 * (increment 3, D6) — `Orchestrator.harnessRouting()` is what gates *new*
 * starts on `config.execution.harnessModes`; a session that started while its
 * mode was on stays Harness-owned regardless of the flag's current value.
 */
import { join } from "node:path";
import type { ResolvedConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import type { CheckpointService } from "../checkpoint.js";
import type { Registry } from "../registry.js";
import type { TaskEventBus } from "../sse.js";
import type { TaskStore } from "../tasks.js";
import { ApprovalService } from "./approval-service.js";
import { HarnessBridge } from "./control-plane-bridge.js";
import { deriveEnvelopeUpdate } from "./envelope-derivation.js";
import { EventRecorder } from "./event-recorder.js";
import { snapshotQuota } from "./quota-snapshot.js";
import { HarnessRecovery } from "./recovery.js";
import { SessionRunner, type RunnerDeps } from "./session-runner.js";
import { SessionStore } from "./session-store.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import { VerificationStore } from "./verification-store.js";
import { VerificationCoordinator } from "../verification-coordinator.js";
import { planProjectVerification, snapshotProjectVerification } from "../project-verification.js";
import { DEFAULT_REDACTION_RULES, TOOL_GATE_BATTERY, buildToolGateState } from "@agent-plane/core";
import { DecisionService, decisionProviders } from "../decision.js";

/** Legacy `applyEvent` snapshots quota on exactly these event types. */
const QUOTA_EVENT_TYPES = new Set(["usage.updated", "limit.approaching", "limit.hit"]);

export interface HarnessCompositionDeps {
  db: Db;
  config: ResolvedConfig;
  tasks: TaskStore;
  bus: TaskEventBus;
  checkpoints: CheckpointService;
  registry: Registry;
  onError: (err: unknown) => void;
  onQuotaObserved?: () => void;
}

export interface HarnessComposition {
  harnessBridge: HarnessBridge;
  harnessRecovery: HarnessRecovery;
  projectVerification: (worktreePath: string) => ReturnType<typeof planProjectVerification>;
}

/** Fail-closed mode resolution (increment 3, D6): a Harness session only ever
 * exists for a `single`-mode task (compare/race are rejected at start), so this
 * reduces to "is harnessModes.single currently disabled". A missing or corrupt
 * session -> execution_request -> task binding terminalises too. */
function shouldTerminalizeOnRecovery(db: Db, config: ResolvedConfig, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT t.mode AS mode
         FROM runs r
         JOIN execution_requests er ON er.id = r.execution_request_id
         JOIN tasks t ON t.id = er.task_id
        WHERE r.id = ?`,
    )
    .get(sessionId) as { mode: string } | undefined;
  if (!row || row.mode !== "single") return true;
  return !config.execution.harnessModes.single;
}

export function buildHarnessComposition(deps: HarnessCompositionDeps): HarnessComposition {
  const { db, config, tasks, bus, checkpoints, registry, onError } = deps;

  const sessionStore = new SessionStore(db);
  const approvals = new ApprovalService(db);
  const verificationStore = new VerificationStore(db);
  const harnessRecovery = new HarnessRecovery({
    store: sessionStore,
    approvals,
    checkpoints, // CheckpointService is structurally a RunnerCheckpoints
    registry, // Registry is structurally a { adapter, manifest } facade
    verification: verificationStore,
    shouldTerminalizeOnRecovery: (sessionId) => shouldTerminalizeOnRecovery(db, config, sessionId),
  });

  const sessionTaskCache = new Map<string, string>();
  const taskOfSession = (sid: string): string | undefined => {
    let t = sessionTaskCache.get(sid);
    if (!t) {
      t = (db.prepare("SELECT task_id FROM runs WHERE id = ?").get(sid) as { task_id?: string } | undefined)?.task_id;
      if (t) sessionTaskCache.set(sid, t); // a session's task is immutable — no invalidation
    }
    return t;
  };
  const assistantOfSession = (sid: string): string | undefined =>
    (db.prepare("SELECT assistant_id FROM runs WHERE id = ?").get(sid) as { assistant_id?: string } | undefined)
      ?.assistant_id;
  const lastPublishedPhase = new Map<string, string | undefined>();

  const recorder = new EventRecorder(
    db,
    DEFAULT_REDACTION_RULES,
    // publish (post-commit, best-effort): reproduce the legacy per-event SSE
    // frame verbatim, plus a deduped {kind:"state"} on a derived phase change.
    (sessionId, durableEvents) => {
      const taskId = taskOfSession(sessionId);
      if (!taskId) return;
      for (const { seq, event } of durableEvents) {
        bus.publish(taskId, { kind: "event", event: { ...event, seq } });
        if (QUOTA_EVENT_TYPES.has(event.type)) deps.onQuotaObserved?.();
      }
      const status = tasks.envelope(taskId).status;
      if (status.phase !== lastPublishedPhase.get(taskId)) {
        lastPublishedPhase.set(taskId, status.phase);
        bus.publish(taskId, {
          kind: "state",
          state: { state: status.state, phase: status.phase, assistantId: assistantOfSession(sessionId) },
        });
      }
    },
    undefined, // now
    undefined, // onPublishError
    // afterInsertInTx (transactional): task-envelope derivation + quota
    // snapshots, atomic with the event insert. Never writes `runs`.
    (sessionId, committed, txDb) => {
      const taskId = taskOfSession(sessionId);
      if (!taskId) return;
      const assistantId = assistantOfSession(sessionId) ?? "";
      const envelope = tasks.envelope(taskId);
      let changed = false;
      for (const { event } of committed) {
        if (deriveEnvelopeUpdate(envelope, event)) changed = true;
        // Same event-type gate as the legacy applyEvent switch — a quota
        // snapshot only on usage.updated / limit.approaching / limit.hit.
        if (QUOTA_EVENT_TYPES.has(event.type)) snapshotQuota(txDb, assistantId, event);
      }
      if (changed) tasks.saveEnvelope(envelope);
    },
  );
  const authority = new WorkspaceAuthority({
    repoAllowlist: config.repoAllowlist,
    worktreeRoot: join(config.dir, "worktrees"),
  });
  const projectVerification = (worktreePath: string): ReturnType<typeof planProjectVerification> => {
    try {
      return planProjectVerification(snapshotProjectVerification(authority, worktreePath));
    } catch {
      return { warnings: ["project verification skipped: project metadata rejected by workspace authority"] };
    }
  };
  // M16 K18/K19b — shadow plumbing only. `RulesDecisionProvider` is the sole
  // registered provider (no vendor call exists until K19c), and `mode` is
  // hardcoded to "shadow": no activation gate exists yet for this site.
  const decisions = new DecisionService(config.decisions, decisionProviders(config.decisions), undefined, db);
  const observeToolGate: NonNullable<RunnerDeps["observeToolGate"]> = (input) => {
    // K19b: the state is built by the §4.4 builder, never assembled inline, and
    // the full `TOOL_GATE_BATTERY` is asked so the shadow record carries the
    // rules baseline beside the five keys a judging provider will answer.
    //
    // `repoPath`/`worktreePath`/`paths`/`networkDestinations` are NOT available
    // on this observation seam — it fires on `tool.started` and carries only
    // the policy inputs. The builder therefore resolves the repo as UNTRUSTED
    // and the path counts as zero, which is the fail-closed reading and is
    // honest about what this seam can see. Widening the seam is K19c's, which
    // is where the gate moves ahead of execution and actually has the action's
    // paths to hand.
    const built = buildToolGateState({
      toolName: input.toolName,
      toolsAllow: input.toolsAllow,
      toolsDeny: input.toolsDeny,
      repoAllowlist: config.repoAllowlist,
    });
    void decisions
      .decide(
        { site: "tool-gate", state: built.state, questions: TOOL_GATE_BATTERY, budgetMs: 50 },
        {
          taskId: taskOfSession(input.sessionId),
          sessionId: input.sessionId,
          mode: "shadow",
          stateTruncated: built.truncated,
        },
      )
      .catch(onError);
  };
  const runner = new SessionRunner({
    store: sessionStore,
    recorder,
    approvals,
    checkpoints,
    registry,
    authority,
    verificationCoordinator: new VerificationCoordinator(verificationStore, checkpoints, authority),
    softThresholdPct: config.failover.softThresholdPct,
    handoff: new HandoffService(db),
    observeToolGate,
  });
  const harnessBridge = new HarnessBridge({ runner, store: sessionStore, approvals, db, onError });

  return { harnessBridge, harnessRecovery, projectVerification };
}
