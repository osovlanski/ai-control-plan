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
import { ProviderProcessTracker, markIncarnation, reapStrayProviders } from "./provider-processes.js";
import { HarnessRecovery } from "./recovery.js";
import { SessionRunner, type RunnerDeps } from "./session-runner.js";
import { SessionStore } from "./session-store.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import { VerificationStore } from "./verification-store.js";
import { VerificationCoordinator } from "../verification-coordinator.js";
import { planProjectVerification, snapshotProjectVerification } from "../project-verification.js";
import type { DecisionProvider } from "@agent-plane/core";
import {
  DEFAULT_REDACTION_RULES,
  RulesDecisionProvider,
  TOOL_GATE_BATTERY,
  TOOL_GATE_BUDGET_MS,
  buildToolGateState,
  resolveFloorGate,
  toolDeniedRules,
  toolGateFloorHits,
} from "@agent-plane/core";
import { DecisionService, decisionProviders, insertDecisionRecord } from "../decision.js";

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
  /** Replaces `decisionProviders(config.decisions)`. Test/scratch only — production registers `decisionProviders()` (K19d: the model judge). */
  decisionProviders?: DecisionProvider[];
  /** Where an I-D8 activation refusal is said out loud. */
  onWarning?: (message: string) => void;
  /** Structured info log: provider spawn/first-event timing, fences, reaps (F1/F2). */
  onInfo?: (message: string, fields: Record<string, unknown>) => void;
}

export interface HarnessComposition {
  harnessBridge: HarnessBridge;
  harnessRecovery: HarnessRecovery;
  projectVerification: (worktreePath: string) => ReturnType<typeof planProjectVerification>;
  /** The tool gate's EFFECTIVE mode after the I-D8 check — `shadow` whenever `applied` was refused. */
  toolGateMode: "shadow" | "applied";
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
  // F2: stamp this incarnation before any provider can be spawned, so a later
  // boot can tell this process's strays from a live sibling's.
  markIncarnation(config.dir);
  const processes = new ProviderProcessTracker(undefined, deps.onInfo, config.dir);
  const harnessRecovery = new HarnessRecovery({
    store: sessionStore,
    approvals,
    checkpoints, // CheckpointService is structurally a RunnerCheckpoints
    registry, // Registry is structurally a { adapter, manifest } facade
    verification: verificationStore,
    shouldTerminalizeOnRecovery: (sessionId) => shouldTerminalizeOnRecovery(db, config, sessionId),
    processes,
    reapStrays: () => reapStrayProviders(config.dir, { log: deps.onInfo }),
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
  // M16 tool gate (K18 records, K19b state boundary, K19c wiring). The
  // effective mode is resolved ONCE here against the provider chain: `applied`
  // with no judging provider is refused and the site kept in shadow (I-D8),
  // loudly, never silently. Constructing the service also refuses, at
  // startup, a configured provider this build does not register (K19i).
  const decisions = new DecisionService(
    config.decisions,
    deps.decisionProviders ?? decisionProviders(config.decisions),
    undefined,
    db,
  );
  let activation = decisions.activation("tool-gate", config.decisions.sites["tool-gate"].mode);
  // K19d registers the first real judge, so I-D8 alone would now let a
  // workspace with a key reach `applied`. The §7.4 attestations that must also
  // hold do not exist yet (the activation slice's), so `applied` stays closed
  // for the build's own providers. Only an injected test/scratch chain opens it.
  if (activation.mode === "applied" && !deps.decisionProviders) {
    activation = {
      mode: "shadow",
      refusal:
        "decisions.sites.tool-gate.mode: applied REFUSED — the §7.4 activation attestations are not implemented " +
        "in this build (K19d ships the judge in shadow only). The site stays in shadow.",
    };
  }
  if (activation.refusal) deps.onWarning?.(activation.refusal);
  const rules = new RulesDecisionProvider();
  const toolGate: NonNullable<RunnerDeps["toolGate"]> = {
    mode: activation.mode,
    async evaluate(input) {
      // K19b: the state is built by the §4.4 builder, never assembled inline.
      const built = buildToolGateState({
        toolName: input.toolName,
        commandText: input.commandText,
        paths: input.paths,
        toolsAllow: input.toolsAllow,
        toolsDeny: input.toolsDeny,
        worktreePath: input.worktreePath,
        repoPath: input.repoPath,
        repoAllowlist: config.repoAllowlist,
      });
      // K19i: the judge is off the hot path. Floors decide; the rules
      // provider still answers `denied`, so every row keeps its baseline (K18).
      // The judge runs only in the offline floor discovery job.
      const req = { site: "tool-gate" as const, state: built.state, questions: TOOL_GATE_BATTERY, budgetMs: TOOL_GATE_BUDGET_MS.applied };
      const outcome = await rules.decide(req);
      // The deny comes from the deterministic match on the RAW inputs — the
      // same one toolPolicyGuard runs — never from any provider's answer (I-D1).
      const verdict = resolveFloorGate({
        rulesDenied: toolDeniedRules(input.toolName, { allow: input.toolsAllow, deny: input.toolsDeny }),
        approvalMode: input.approvalMode,
        hits: toolGateFloorHits({
          toolName: input.toolName,
          commandText: input.commandText,
          paths: input.paths,
          worktreePath: input.worktreePath,
          shell: input.shell,
          mcpTools: config.decisions.mcpTools,
        }),
      });
      // Written here rather than via `decide(req, ctx)` because the record
      // carries the verdict, which only exists after the answers do. Still one
      // row per evaluation, through the one writer.
      insertDecisionRecord(
        db,
        req,
        outcome,
        {
          taskId: taskOfSession(input.sessionId),
          sessionId: input.sessionId,
          mode: activation.mode,
          stateTruncated: built.truncated,
          gate: { ...verdict, hook: input.hook, tier: input.hook === "pre-exec" ? "preventive" : "audit" },
        },
        new Date().toISOString(),
      );
      return verdict;
    },
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
    toolGate,
    processes,
    log: deps.onInfo,
  });
  const harnessBridge = new HarnessBridge({ runner, store: sessionStore, approvals, db, onError });

  return { harnessBridge, harnessRecovery, projectVerification, toolGateMode: activation.mode };
}
