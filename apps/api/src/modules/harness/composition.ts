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
import { SessionRunner } from "./session-runner.js";
import { SessionStore } from "./session-store.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import { VerificationStore } from "./verification-store.js";
import { VerificationCoordinator } from "../verification-coordinator.js";
import { planProjectVerification, snapshotProjectVerification } from "../project-verification.js";
import { DEFAULT_REDACTION_RULES } from "@agent-plane/core";

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
  const runner = new SessionRunner({
    store: sessionStore,
    recorder,
    approvals,
    checkpoints,
    registry,
    authority,
    verificationCoordinator: new VerificationCoordinator(verificationStore, checkpoints, authority),
    softThresholdPct: config.failover.softThresholdPct,
    // No `handoff` dep — the envelope-yield path is out of scope this pass, so
    // the runner never commits an envelope.
  });
  const harnessBridge = new HarnessBridge({ runner, store: sessionStore, approvals, db, onError });

  return { harnessBridge, harnessRecovery, projectVerification };
}
