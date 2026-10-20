/**
 * M2 Composer service (plans/m2-composer.md §1, §2 stage 6 preview, §3).
 *
 * `preview` gathers the inputs, runs the pure pipeline (stages 1 to 5) over the two ports, and
 * records what happened: ONE `routing_decisions` row for the outcome stage 2 used and ONE
 * `composition_attempts` row. It never writes `agent_specs` or `composition_decisions`.
 *
 * `start` (S5, stage 6 confirm) re-runs the pipeline with the same overrides. A sent digest that
 * no longer matches is drift (409, the new preview recorded as a preview). A composed start hands
 * the orchestrator a binding that persists the revision through `BundledComposition.persistRendered`
 * only once the worktree identity exists; anything else starts route-only with an attempt row
 * saying why (Q3), unless `composer.requireRevision` is on.
 *
 * `composeForDispatch` (S6) recomposes at a scheduler wake, run-now, failover or manual handoff
 * over the route the dispatch already made, so a changed assistant gets a new revision with the
 * task's remaining budget. A K11 continuation on the same assistant reuses the revision instead.
 * A recomposition that finds no budget left blocks the start; any other failure runs route-only.
 *
 * Inputs are read here and nowhere in core: the registry view (volatile fields dropped, one sync
 * when no snapshot exists), the workspace policy document from config, the task's opt-ins (034),
 * repo signals at the base commit, env var NAMES and commands on PATH that the snapshot's assets
 * require, and the hostnames the text guard refuses.
 */
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import {
  composerInputsDigest, OVERRIDE_ACTOR, runComposer, TASK_KINDS, type AgentSpec, type BudgetCaps, type ComposeResult, type ComposerAsset,
  type ComposerConfig, type ComposerInputs, type ComposerOptIn, type ComposerOutcome, type ComposerOverrides, type ConfirmInput, type RegistryView,
  type RoutingExplanation, type TaskIntent, type TaskKind,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import type { CompositionDecision } from "../../composition-contract.js";
import type { BundledComposition } from "../bundle-request.js";
import { CompositionStore } from "../composition.js";
import type { CompositionWorkspace, DispatchComposer, DispatchComposition, RecomposeOrigin, StartComposition } from "../orchestrator.js";
import type { RegistryFederation } from "../registry-federation.js";
import type { RouteDeps } from "../router.js";
import { TaskAccounting } from "./accounting.js";
import { AdapterProvisioningPort, CockpitBundlePort, RouteHarnessModelPort, type PinnedRoute } from "./ports.js";
import { repoSignalsForTask } from "./repo-signals.js";

/** `policy.revision.id`: the workspace policy comes from config.yaml; its digest tells revisions apart. */
export const WORKSPACE_POLICY_ID = "workspace-policy:config";
/** The attempt row's origin for a preview. */
export const PREVIEW_ORIGIN = "preview";
/** The attempt row's origin for an operator start (stage 6 confirm), including its drift preview. */
export const START_ORIGIN = "start";

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export interface ComposerServiceDeps extends RouteDeps {
  federation: RegistryFederation;
  bundled: BundledComposition;
  /** The machine's hostname, refused by the text guard. Defaults to `os.hostname()`. */
  hostname?: string;
  /** The environment whose variable NAMES and PATH are read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface PreviewResponse {
  decision: ComposeResult["decision"];
  specDraft: ComposeResult["specDraft"] | null;
  compositionDigest: string | null;
  outcome: ComposerOutcome;
  attemptId: string;
  routingDecisionId: number | null;
  /** True when Cockpit answered `not_found`, the registry was synced once and the task recomposed. */
  resynced: boolean;
}

export type PreviewResult =
  | { ok: true; preview: PreviewResponse }
  | { ok: false; status: 400 | 404; error: string; reason?: string };

export interface AttemptRow {
  id: string;
  origin: string;
  routingDecisionId: number | null;
  compositionDigest: string | null;
  inputsDigest: string | null;
  outcome: "persisted" | "previewed" | "failed" | "skipped";
  reason: string | null;
  compositionRevisionId: string | null;
  createdAt: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Explanation = RoutingExplanation & { origin: string };

/** What a start's response says about its composition. */
export interface StartAttempt {
  attemptId: string;
  outcome: AttemptRow["outcome"];
  reason: string | null;
  compositionDigest: string | null;
  compositionRevisionId: string | null;
}

export type StartComposeResult =
  /** A refused override: 400, nothing recorded (§3). */
  | { kind: "refused"; error: string; reason: string }
  /** The sent digest no longer matches: 409 with the new preview, recorded as a preview. No revision, no run. */
  | { kind: "drift"; preview: PreviewResponse }
  /** route() found no eligible assistant: 422, as /start always answered. */
  | { kind: "no_candidate"; explanation: Explanation; attempt: StartAttempt }
  /** No revision is possible; the start runs route-only (Q3) unless `composer.requireRevision` is on. */
  | { kind: "route_only"; assistantId: string; routingDecisionId: number; explanation: Explanation; attempt: StartAttempt }
  /** Composed and confirmed: `binding` persists the revision once the worktree identity exists. */
  | { kind: "composed"; assistantId: string; routingDecisionId: number; explanation: Explanation; binding: StartBinding };

/**
 * The preview form of a start decision: only the confirm stage differs (§4.6), and a preview
 * leaves it `chosen: []`, "awaiting confirmation".
 */
function asPreviewDecision(decision: ComposeResult["decision"]): ComposeResult["decision"] {
  return {
    ...decision,
    stages: decision.stages.map((s) => (s.stage === "confirm" && s.chosen.length
      ? { stage: "confirm", candidates: [{ ref: "start" }], filters: [], chosen: [], why: "awaiting confirmation", override: null }
      : s)),
  };
}

interface Composed {
  inputs: ComposerInputs;
  result: ComposeResult;
  harnessModel: RouteHarnessModelPort;
  bundle: CockpitBundlePort;
  resynced: boolean;
}

/** The attempt reason of a K11 continuation that reuses its predecessor's revision. */
export const REVISION_REUSED = "revision_reused";

export class ComposerService implements DispatchComposer {
  /** Budget settlement over the task's runs (§5); stage 5's `consumed` input. */
  readonly accounting: TaskAccounting;

  constructor(private readonly deps: ComposerServiceDeps) {
    this.accounting = new TaskAccounting(deps);
  }

  private get config(): ResolvedConfig { return this.deps.config; }
  private get db(): Db { return this.deps.db; }
  private now(): Date { return this.deps.now ? this.deps.now() : new Date(); }

  /** Stages 1 to 5, the preview form of confirm. */
  async preview(taskId: string, overrides?: ComposerOverrides): Promise<PreviewResult> {
    if (!this.deps.tasks.get(taskId)) return { ok: false, status: 404, error: "not found" };
    const composed = await this.compose(taskId, overrides, { mode: "preview" });
    if (composed.result.outcome.status === "failed" && composed.result.outcome.reason === "override_refused") {
      // Refused overrides are never recorded (§3): no routing row, no attempt.
      return { ok: false, status: 400, error: "override refused", reason: composed.result.outcome.detail ?? "override refused" };
    }
    return { ok: true, preview: this.recordPreview(taskId, PREVIEW_ORIGIN, composed) };
  }

  /**
   * Stage 6 confirm for an operator start. The pipeline re-runs with the same overrides; the
   * caller decides between 400, 409, 422 and the start from the answer. Every answer but
   * `refused` has written its routing row and, except `composed` (whose binding writes it with
   * the revision), its attempt row.
   */
  async start(taskId: string, overrides: ComposerOverrides | undefined, compositionDigest: string | undefined): Promise<StartComposeResult> {
    const composed = await this.compose(taskId, overrides, { mode: "start", origin: "operator" });
    const { result, harnessModel } = composed;
    const outcome = result.outcome;
    if (outcome.status === "failed" && outcome.reason === "override_refused") {
      return { kind: "refused", error: "override refused", reason: outcome.detail ?? "override refused" };
    }
    // Q7: the operator confirmed one composition; anything else, including none at all, is drift.
    if (compositionDigest !== undefined && result.compositionDigest !== compositionDigest) {
      return { kind: "drift", preview: this.recordPreview(taskId, START_ORIGIN, { ...composed, result: { ...result, decision: asPreviewDecision(result.decision) } }) };
    }
    const explanation = harnessModel.usedExplanation()!;
    const inputsDigest = composerInputsDigest(composed.inputs, { sha256 });
    if (outcome.status !== "composed" || !result.specDraft || !result.compositionDigest) {
      const [status, reason] = outcome.status === "composed" ? ["failed" as const, "invalid_response"] : [outcome.status, outcome.reason];
      const recorded = this.db.transaction(() => {
        const routingDecisionId = harnessModel.persistUsed()!;
        return { routingDecisionId, attempt: this.insertAttempt({ taskId, origin: START_ORIGIN, routingDecisionId, compositionDigest: null, inputsDigest, outcome: status, reason }) };
      })();
      // route() chose nobody: /start's 422, as before. A composition that stopped for any other
      // reason still has route()'s choice, and the start runs it route-only (Q3).
      if (!explanation.chosen) return { kind: "no_candidate", explanation, attempt: recorded.attempt };
      return { kind: "route_only", assistantId: String(explanation.chosen), routingDecisionId: recorded.routingDecisionId, explanation, attempt: recorded.attempt };
    }
    // persistRendered accepts only the bundle this instance rendered, exactly as Cockpit returned it.
    const rendered = composed.bundle.lastRendered();
    if (!rendered || rendered.response !== result.bundle?.response || rendered.request !== result.bundle?.request) {
      throw new Error("composer: the composed bundle is not the one Cockpit rendered");
    }
    const routingDecisionId = harnessModel.persistUsed()!;
    const baseCommit = composed.inputs.repoSignals.status === "ok" ? composed.inputs.repoSignals.baseCommit : undefined;
    return {
      kind: "composed",
      assistantId: String(explanation.chosen),
      routingDecisionId,
      explanation,
      binding: new StartBinding(this, {
        taskId, origin: START_ORIGIN, routingDecisionId, inputsDigest, compositionDigest: result.compositionDigest, required: this.config.composer.requireRevision,
        specDraft: result.specDraft, decision: result.decision, bundle: rendered, ...(baseCommit !== undefined ? { baseCommit } : {}),
      }),
    };
  }

  /**
   * A start that cannot carry a revision whatever the pipeline says (the legacy execution path,
   * a task with no repository): the pipeline is not run, and the attempt row says why.
   */
  recordSkippedStart(taskId: string, reason: string, routingDecisionId: number | null): StartAttempt {
    return this.insertAttempt({ taskId, origin: START_ORIGIN, routingDecisionId, compositionDigest: null, inputsDigest: null, outcome: "skipped", reason });
  }

  /** Persists a confirmed revision with its workspace, and its `persisted` attempt, in one transaction. */
  persistStart(b: StartBindingData, workspace: CompositionWorkspace | undefined):
    | { ok: true; attempt: StartAttempt; compositionRevisionId: string; policy: AgentSpec["policy"] }
    | { ok: false; attempt: StartAttempt; reason: string } {
    if (!workspace) {
      const attempt = this.insertAttempt({ ...b, compositionDigest: null, outcome: "skipped", reason: "no_worktree_identity" });
      return { ok: false, attempt, reason: "no_worktree_identity" };
    }
    return this.db.transaction(() => {
      // n = 1 + the revisions the task already has (§3).
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM agent_specs WHERE task_id = ?").get(b.taskId) as { n: number };
      const compositionRevisionId = `CR-${b.taskId}-${n + 1}`;
      const decisionId = `CD-${b.taskId}-${n + 1}`;
      const spec: AgentSpec = {
        ...b.specDraft,
        composition_revision_id: compositionRevisionId,
        explanation_ref: decisionId,
        workspace: { repository_id: workspace.repositoryId, branch: workspace.branch, worktree_id: workspace.worktreeId },
      };
      const decision: CompositionDecision = { ...b.decision, id: decisionId, composition_revision_id: compositionRevisionId };
      const persisted = this.deps.bundled.persistRendered({ spec, decision, bundle: b.bundle });
      if (!persisted.ok) {
        const attempt = this.insertAttempt({ ...b, compositionDigest: null, outcome: "failed", reason: persisted.reason });
        return { ok: false as const, attempt, reason: persisted.reason };
      }
      const attempt = this.insertAttempt({ ...b, outcome: "persisted", reason: null, compositionRevisionId });
      return { ok: true as const, attempt, compositionRevisionId, policy: persisted.revision.spec.policy };
    })();
  }

  /** Binds a run to the revision its start persisted (write-once, M1). */
  attachRun(runId: string, compositionRevisionId: string): void {
    new CompositionStore(this.db).attachRun(runId, compositionRevisionId);
  }

  /** A run settled: append the `budget.overrun` events its revision now owes. Never throws. */
  settled(runId: string): void {
    try { this.accounting.recordOverruns(runId, "in_run"); } catch { /* accounting never fails a settle */ }
  }

  /** A late usage record arrived for a run: append the overrun it adds, if any (§5 "Late and post-run"). */
  lateRecord(runId: string) {
    return this.accounting.recordOverruns(runId, "late");
  }

  /**
   * Stage 6, non-interactive dispatch (S6). The route is the one the dispatch already made and
   * persisted; stage 2 projects it rather than routing again. Every answer has written its attempt
   * row, except `compose` with a new revision, whose binding writes it with the revision.
   */
  async composeForDispatch(input: {
    taskId: string; assistantId: string; origin: RecomposeOrigin; routingDecisionId: number; unbindable?: string;
  }): Promise<DispatchComposition> {
    const { taskId, assistantId, origin, routingDecisionId } = input;
    const required = this.config.composer.requireRevision;
    if (input.unbindable) {
      this.insertAttempt({ taskId, origin, routingDecisionId, compositionDigest: null, inputsDigest: null, outcome: "skipped", reason: input.unbindable });
      return required ? { kind: "blocked", reason: input.unbindable, pauseKind: "intervention_required" } : { kind: "route_only" };
    }

    // A K11 continuation on the same assistant continues the same composition (§2 stage 6).
    if (origin === "context-yield") {
      const last = this.db.prepare(
        "SELECT assistant_id, composition_revision_id FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      ).get(taskId) as { assistant_id: string; composition_revision_id: string | null } | undefined;
      if (last?.composition_revision_id && last.assistant_id === assistantId) {
        const revision = last.composition_revision_id;
        if (this.accounting.revisionRemaining(revision).exhausted.length) {
          this.insertAttempt({ taskId, origin, routingDecisionId, compositionDigest: null, inputsDigest: null, outcome: "failed", reason: "budget_exhausted" });
          return { kind: "blocked", reason: "budget_exhausted", pauseKind: "budget_exhausted" };
        }
        return { kind: "compose", composition: new ReusedBinding(this, { taskId, origin, routingDecisionId, compositionRevisionId: revision, required }) };
      }
    }

    const row = this.db.prepare("SELECT explanation FROM routing_decisions WHERE id = ? AND task_id = ?").get(routingDecisionId, taskId) as { explanation: string } | undefined;
    if (!row) throw new Error(`composer: routing decision ${routingDecisionId} is not task ${taskId}'s`);
    const explanation = JSON.parse(row.explanation) as PinnedRoute["explanation"];
    if (String(explanation.chosen) !== assistantId) throw new Error(`composer: routing decision ${routingDecisionId} chose ${String(explanation.chosen)}, not ${assistantId}`);

    const composed = await this.compose(taskId, undefined, { mode: "start", origin }, { routingDecisionId, explanation });
    const { result } = composed;
    const outcome = result.outcome;
    const inputsDigest = composerInputsDigest(composed.inputs, { sha256 });
    if (outcome.status !== "composed" || !result.specDraft || !result.compositionDigest) {
      const [status, reason] = outcome.status === "composed" ? ["failed" as const, "invalid_response"] : [outcome.status, outcome.reason];
      this.insertAttempt({ taskId, origin, routingDecisionId, compositionDigest: null, inputsDigest, outcome: status, reason });
      // No budget left is a policy answer, not a missing dependency: running route-only would spend past the cap.
      if (reason === "budget_exhausted") return { kind: "blocked", reason, pauseKind: "budget_exhausted" };
      return required ? { kind: "blocked", reason, pauseKind: "intervention_required" } : { kind: "route_only" };
    }
    const rendered = composed.bundle.lastRendered();
    if (!rendered || rendered.response !== result.bundle?.response || rendered.request !== result.bundle?.request) {
      throw new Error("composer: the composed bundle is not the one Cockpit rendered");
    }
    const baseCommit = composed.inputs.repoSignals.status === "ok" ? composed.inputs.repoSignals.baseCommit : undefined;
    return {
      kind: "compose",
      composition: new StartBinding(this, {
        taskId, origin, routingDecisionId, inputsDigest, compositionDigest: result.compositionDigest, required,
        specDraft: result.specDraft, decision: result.decision, bundle: rendered, ...(baseCommit !== undefined ? { baseCommit } : {}),
      }),
    };
  }

  /** A reused revision's attempt row and the policy its next run executes under: the revision's caps less what its runs settled. */
  bindReused(b: ReusedBindingData): { ok: true; attempt: StartAttempt; compositionRevisionId: string; policy: AgentSpec["policy"] } {
    const spec = this.db.prepare("SELECT spec_json FROM agent_specs WHERE composition_revision_id = ? AND task_id = ?").get(b.compositionRevisionId, b.taskId) as { spec_json: string } | undefined;
    if (!spec) throw new Error(`composer: revision ${b.compositionRevisionId} is not task ${b.taskId}'s`);
    const policy = (JSON.parse(spec.spec_json) as AgentSpec).policy;
    const { remaining } = this.accounting.revisionRemaining(b.compositionRevisionId);
    const attempt = this.insertAttempt({ taskId: b.taskId, origin: b.origin, routingDecisionId: b.routingDecisionId, compositionDigest: null, inputsDigest: null, outcome: "skipped", reason: REVISION_REUSED });
    return { ok: true, attempt, compositionRevisionId: b.compositionRevisionId, policy: { ...policy, budget: remaining } };
  }

  /** Runs the pipeline over fresh ports; on a stale pin, one registry sync and one recompose (§2 stage 4). */
  private async compose(taskId: string, overrides: ComposerOverrides | undefined, confirm: ConfirmInput, pinned?: PinnedRoute): Promise<Composed> {
    const harnessModel = pinned
      ? new RouteHarnessModelPort(this.deps, taskId, confirm.mode === "start" && confirm.origin !== "operator" ? confirm.origin : "intake", {}, pinned)
      : new RouteHarnessModelPort(this.deps, taskId, "intake");
    const bundle = new CockpitBundlePort(this.deps.bundled);
    const ports = { harnessModel, bundle, provisioning: new AdapterProvisioningPort(this.deps) };
    let inputs = await this.inputs(taskId, overrides, harnessModel, confirm);
    let result = await runComposer(inputs, ports, { sha256 });
    let resynced = false;
    if (result.outcome.status === "failed" && result.outcome.reason === "not_found" && this.config.registry.cockpit.enabled) {
      await this.deps.federation.sync();
      resynced = true;
      inputs = await this.inputs(taskId, overrides, harnessModel, confirm);
      result = await runComposer(inputs, ports, { sha256 });
    }
    return { inputs, result, harnessModel, bundle, resynced };
  }

  /** Records a preview: one routing row for the outcome stage 2 used and one attempt, in one transaction. */
  private recordPreview(taskId: string, origin: string, { inputs, result, harnessModel, resynced }: Composed): PreviewResponse {
    const outcome = result.outcome;
    const attempt = this.db.transaction(() => {
      const routingDecisionId = harnessModel.persistUsed() ?? null;
      // A composed preview is `previewed` and needs no reason; a stopped pipeline says why.
      const [status, reason] = outcome.status === "composed" ? ["previewed" as const, null] : [outcome.status, outcome.reason];
      const row = this.insertAttempt({ taskId, origin, routingDecisionId, compositionDigest: result.compositionDigest ?? null, inputsDigest: composerInputsDigest(inputs, { sha256 }), outcome: status, reason });
      return { id: row.attemptId, routingDecisionId };
    })();
    return {
      decision: result.decision,
      specDraft: result.specDraft ?? null,
      compositionDigest: result.compositionDigest ?? null,
      outcome,
      attemptId: attempt.id,
      routingDecisionId: attempt.routingDecisionId,
      resynced,
    };
  }

  private insertAttempt(a: {
    taskId: string; origin: string; routingDecisionId: number | null; compositionDigest: string | null; inputsDigest: string | null;
    outcome: AttemptRow["outcome"]; reason: string | null; compositionRevisionId?: string;
  }): StartAttempt {
    const id = this.nextAttemptId(a.taskId);
    this.db.prepare(
      `INSERT INTO composition_attempts (id, task_id, origin, routing_decision_id, composition_digest, inputs_digest, outcome, reason, composition_revision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, a.taskId, a.origin, a.routingDecisionId, a.compositionDigest, a.inputsDigest, a.outcome, a.reason, a.compositionRevisionId ?? null, this.now().toISOString());
    return { attemptId: id, outcome: a.outcome, reason: a.reason, compositionDigest: a.compositionDigest, compositionRevisionId: a.compositionRevisionId ?? null };
  }

  /** `CA-<taskId>-<n>`, n = 1 + the attempts the task already has. Called inside the insert's transaction. */
  private nextAttemptId(taskId: string): string {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM composition_attempts WHERE task_id = ?").get(taskId) as { n: number };
    return `CA-${taskId}-${n + 1}`;
  }

  /** Revisions (with their decisions), attempts and opt-ins of a task, oldest first. */
  history(taskId: string) {
    const revisions = (this.db.prepare(
      `SELECT s.composition_revision_id, s.bundle_digest, s.spec_json, d.decision_json, s.created_at
         FROM agent_specs s JOIN composition_decisions d ON d.composition_revision_id = s.composition_revision_id
        WHERE s.task_id = ? ORDER BY s.created_at, s.rowid`,
    ).all(taskId) as Array<{ composition_revision_id: string; bundle_digest: string; spec_json: string; decision_json: string; created_at: string }>)
      .map((r) => ({
        compositionRevisionId: r.composition_revision_id,
        bundleDigest: r.bundle_digest,
        spec: JSON.parse(r.spec_json) as unknown,
        decision: JSON.parse(r.decision_json) as unknown,
        createdAt: r.created_at,
      }));
    const attempts: AttemptRow[] = (this.db.prepare(
      `SELECT id, origin, routing_decision_id, composition_digest, inputs_digest, outcome, reason, composition_revision_id, created_at
         FROM composition_attempts WHERE task_id = ? ORDER BY rowid`,
    ).all(taskId) as Array<{ id: string; origin: string; routing_decision_id: number | null; composition_digest: string | null; inputs_digest: string | null; outcome: AttemptRow["outcome"]; reason: string | null; composition_revision_id: string | null; created_at: string }>)
      .map((r) => ({
        id: r.id, origin: r.origin, routingDecisionId: r.routing_decision_id, compositionDigest: r.composition_digest,
        inputsDigest: r.inputs_digest, outcome: r.outcome, reason: r.reason, compositionRevisionId: r.composition_revision_id, createdAt: r.created_at,
      }));
    return { taskId, revisions, attempts, optIns: this.optIns(taskId) };
  }

  optIns(taskId: string): ComposerOptIn[] {
    return (this.db.prepare("SELECT asset_id, digest, actor, at FROM composition_opt_ins WHERE task_id = ? ORDER BY asset_id, digest")
      .all(taskId) as Array<{ asset_id: string; digest: string; actor: string; at: string }>)
      .map((r) => ({ assetId: r.asset_id, digest: r.digest, actor: r.actor, at: r.at }));
  }

  /**
   * Appends an opt-in. `at` is stamped once, here; a repeat of the same (task, asset, digest)
   * returns the stored row unchanged, so recomposing reads it rather than restamping it.
   */
  addOptIn(taskId: string, body: unknown):
    | { ok: true; created: boolean; optIn: ComposerOptIn }
    | { ok: false; status: 400 | 404; error: string } {
    if (!this.deps.tasks.get(taskId)) return { ok: false, status: 404, error: "not found" };
    if (!isRecord(body) || Object.keys(body).some((k) => k !== "assetId" && k !== "digest")) {
      return { ok: false, status: 400, error: "body must be { assetId, digest }" };
    }
    const { assetId, digest } = body;
    if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) return { ok: false, status: 400, error: "assetId is not a registry asset id" };
    if (typeof digest !== "string" || !DIGEST.test(digest)) return { ok: false, status: 400, error: "digest must be sha256:<64 lowercase hex>" };
    const existing = this.optIns(taskId).find((o) => o.assetId === assetId && o.digest === digest);
    if (existing) return { ok: true, created: false, optIn: existing };
    const at = this.now().toISOString();
    // Plain INSERT: the unique key refuses a duplicate, and the 034 triggers stay in force.
    this.db.prepare("INSERT INTO composition_opt_ins (task_id, asset_id, digest, actor, at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, assetId, digest, OVERRIDE_ACTOR, at);
    return { ok: true, created: true, optIn: { assetId, digest, actor: OVERRIDE_ACTOR, at } };
  }

  // ---- inputs ---------------------------------------------------------------

  private async inputs(taskId: string, overrides: ComposerOverrides | undefined, harnessModel: RouteHarnessModelPort, confirm: ConfirmInput): Promise<ComposerInputs> {
    const row = this.deps.tasks.get(taskId)!;
    const intent = JSON.parse(row.intent_json) as TaskIntent;
    const registry = await this.registryView();
    const composer = this.config.composer;
    // charsPerToken is per primary model, which stage 2 picks: ask the port (it routes once and
    // the pipeline's own stage-2 call reuses that answer).
    const modelId = harnessModel.peek({ taskId, ...(overrides?.harness_model ? { override: { ...overrides.harness_model } } : {}) }).chosen?.modelId;
    const byModel = composer.context.charsPerToken.byModel;
    const charsPerToken = modelId !== undefined && Object.prototype.hasOwnProperty.call(byModel, modelId) ? byModel[modelId]! : composer.context.charsPerToken.default;
    const repositoryId = intent.repository ? this.repositoryId(intent.repository.path) : undefined;
    const byRepository = composer.context.fragments.byRepository;
    const fragments = repositoryId !== undefined && Object.prototype.hasOwnProperty.call(byRepository, repositoryId)
      ? [...composer.context.fragments.default, ...byRepository[repositoryId]!]
      : composer.context.fragments.default;
    const b = composer.policy.budget;
    const budget: BudgetCaps = {
      ...(b.maxTokens !== undefined ? { max_tokens: b.maxTokens } : {}),
      ...(b.maxCostUsd !== undefined ? { max_cost_usd: b.maxCostUsd } : {}),
      ...(b.maxRuntimeMs !== undefined ? { max_runtime_ms: b.maxRuntimeMs } : {}),
    };
    if (confirm.mode === "start" && confirm.origin !== "operator") {
      const previous = this.db.prepare(
        "SELECT spec_json FROM agent_specs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(taskId) as { spec_json: string } | undefined;
      if (previous) {
        // Only config and a persisted revision may supply caps. Preserve every prior tightening,
        // even if config raises or removes a cap; stage 5 then subtracts task consumption.
        const priorCaps = (JSON.parse(previous.spec_json) as AgentSpec).policy.budget;
        for (const key of ["max_tokens", "max_cost_usd", "max_runtime_ms"] as const) {
          const priorCap = priorCaps[key];
          if (priorCap !== undefined) budget[key] = Math.min(budget[key] ?? priorCap, priorCap);
        }
      }
    }
    const config: ComposerConfig = {
      maxSkills: composer.assets.maxSkills,
      maxMcpServers: composer.assets.maxMcpServers,
      allowlist: composer.assets.allowlist.map(({ id, digest }) => ({ id, digest })),
      fragments: [...new Set(fragments)],
      memoryBundles: composer.context.memoryBundles.map(({ id, digest, reason }) => ({ id, digest, reason })),
      charsPerToken,
      tokenBudget: composer.context.tokenBudget,
      policy: { riskPermission: { ...composer.policy.riskPermission }, permitAmbient: composer.policy.permitAmbient, permitPartial: composer.policy.permitPartial },
      budget,
    };
    const storedKind = row.task_kind !== null && (TASK_KINDS as readonly string[]).includes(row.task_kind) ? (row.task_kind as TaskKind) : undefined;
    return {
      task: { id: taskId, goal: intent.goal, constraints: intent.constraints ?? [], ...(storedKind ? { storedKind } : {}) },
      repoSignals: await repoSignalsForTask({ tasks: this.deps.tasks, config: this.config }, taskId),
      registry,
      optIns: this.optIns(taskId),
      environment: this.environment(registry),
      config,
      workspacePolicy: { policyId: WORKSPACE_POLICY_ID, approvalMode: this.config.policy.approvalMode, toolAllowlist: [] },
      // What the task's runs have settled so far (S6): a failover revision gets only the remainder.
      consumed: this.accounting.consumption(taskId),
      ...(overrides ? { overrides } : {}),
      confirm,
      forbiddenHostnames: this.forbiddenHostnames(),
    };
  }

  /** The machine's hostname and the Cockpit base URL host. */
  private forbiddenHostnames(): string[] {
    const hosts = [this.deps.hostname ?? hostname()];
    try { hosts.push(new URL(this.config.registry.cockpit.baseUrl).hostname.replace(/^\[|\]$/g, "")); } catch { /* config validated it */ }
    return [...new Set(hosts.filter((h) => h.length > 0))].sort();
  }

  /**
   * The cached snapshot without its volatile fields. With federation on and no snapshot yet, one
   * sync is attempted first. Cockpit unreachable with a snapshot cached: the cached one is used.
   */
  private async registryView(): Promise<RegistryView> {
    if (!this.config.registry.cockpit.enabled) return { status: "off" };
    let view = this.deps.federation.read();
    if (view.snapshotDigest === null) {
      const synced = await this.deps.federation.sync();
      view = this.deps.federation.read();
      if (view.snapshotDigest === null) {
        const reason = synced.ok ? "invalid_response" : synced.reason;
        return { status: "no_snapshot", reason };
      }
    }
    const assets: ComposerAsset[] = view.assets.map((a) => ({
      id: a.id, digest: a.digest, kind: a.kind, enabled: a.enabled, tags: a.tags, compatibility: a.compatibility,
      requirements: a.requirements, conflicts: a.conflicts, lineage: a.lineage, ...(a.mcp ? { mcp: a.mcp } : {}),
    }));
    return { status: "ok", snapshotDigest: view.snapshotDigest, observedAt: view.observedAt!, stale: view.stale, assets };
  }

  /** Only the names the snapshot's assets require: never every env var name, never a value. */
  private environment(registry: RegistryView): ComposerInputs["environment"] {
    if (registry.status !== "ok") return { envNames: [], commands: [] };
    const env = this.deps.env ?? process.env;
    const wantedEnv = new Set(registry.assets.flatMap((a) => a.requirements.secretRefs.filter((r) => r.type === "env").map((r) => r.name)));
    const wantedCommands = new Set(registry.assets.flatMap((a) => a.requirements.commands ?? []));
    const envNames = [...wantedEnv].filter((name) => env[name] !== undefined && env[name] !== "").sort();
    const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
    const commands = [...wantedCommands].filter((c) => COMMAND.test(c) && dirs.some((d) => isExecutable(join(d, c)))).sort();
    return { envNames, commands };
  }

  /** A repository id the plane already resolved for this path (read-only: a preview creates no identity). */
  private repositoryId(path: string): string | undefined {
    const row = this.db.prepare(
      "SELECT repository_id FROM repository_identity_observations WHERE observed_path = ? ORDER BY id DESC LIMIT 1",
    ).get(path) as { repository_id: string } | undefined;
    return row?.repository_id;
  }
}

/** What a confirmed start carries until the worktree identity exists. */
interface StartBindingData {
  taskId: string;
  /** The attempt row's origin: `start` for an operator start, the dispatch origin otherwise. */
  origin: string;
  routingDecisionId: number;
  inputsDigest: string;
  compositionDigest: string;
  required: boolean;
  baseCommit?: string;
  specDraft: NonNullable<ComposeResult["specDraft"]>;
  decision: ComposeResult["decision"];
  bundle: NonNullable<ReturnType<CockpitBundlePort["lastRendered"]>>;
}

/** The orchestrator's handle on a confirmed composition (`StartOptions.composition`). Binds once. */
export class StartBinding implements StartComposition {
  private recorded: StartAttempt | undefined;

  constructor(private readonly service: ComposerService, private readonly data: StartBindingData) {}

  get baseCommit(): string | undefined { return this.data.baseCommit; }
  get required(): boolean { return this.data.required; }
  get compositionDigest(): string { return this.data.compositionDigest; }
  /** The attempt this start recorded, once `bind` ran. */
  get attempt(): StartAttempt | undefined { return this.recorded; }

  bind(workspace: CompositionWorkspace | undefined): { ok: true; compositionRevisionId: string; policy: AgentSpec["policy"] } | { ok: false; reason: string } {
    if (this.recorded) throw new Error("composer: a start composition binds once");
    const result = this.service.persistStart(this.data, workspace);
    this.recorded = result.attempt;
    return result.ok ? { ok: true, compositionRevisionId: result.compositionRevisionId, policy: result.policy } : { ok: false, reason: result.reason };
  }

  attachRun(runId: string, compositionRevisionId: string): void {
    this.service.attachRun(runId, compositionRevisionId);
  }
}

interface ReusedBindingData { taskId: string; origin: string; routingDecisionId: number; compositionRevisionId: string; required: boolean }

/**
 * A K11 continuation on the same assistant (S6): the run binds to its predecessor's revision, and
 * executes under that revision's caps less what the revision's runs already settled.
 */
export class ReusedBinding implements StartComposition {
  private recorded: StartAttempt | undefined;

  constructor(private readonly service: ComposerService, private readonly data: ReusedBindingData) {}

  get required(): boolean { return this.data.required; }
  get attempt(): StartAttempt | undefined { return this.recorded; }

  bind(): { ok: true; compositionRevisionId: string; policy: AgentSpec["policy"] } {
    if (this.recorded) throw new Error("composer: a start composition binds once");
    const result = this.service.bindReused(this.data);
    this.recorded = result.attempt;
    return result;
  }

  attachRun(runId: string, compositionRevisionId: string): void {
    this.service.attachRun(runId, compositionRevisionId);
  }
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- override bodies (§3) ---------------------------------------------------

const MAX_LIST = 128;
const MAX_STRING = 256;

/**
 * Parses the compose body's `overrides`. Shape only: unknown keys and wrong types are a 400 here;
 * whether an override loosens policy or attaches an unallowlisted asset is the pipeline's call
 * (also a 400, never recorded).
 */
export function parseOverrides(value: unknown, assistantIds: readonly string[]): { ok: true; overrides?: ComposerOverrides } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: "overrides must be an object" };
  const problems: string[] = [];
  const section = (key: string, known: readonly string[]): Record<string, unknown> | undefined => {
    const v = value[key];
    if (v === undefined) return undefined;
    if (!isRecord(v)) { problems.push(`overrides.${key} must be an object`); return undefined; }
    for (const k of Object.keys(v)) if (!known.includes(k)) problems.push(`overrides.${key}.${k} is not a known key`);
    return v;
  };
  const str = (v: unknown, path: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_STRING) { problems.push(`${path} must be a non-empty string of at most ${MAX_STRING} characters`); return undefined; }
    return v;
  };
  const list = (v: unknown, path: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > MAX_LIST || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_STRING)) {
      problems.push(`${path} must be a list of at most ${MAX_LIST} non-empty strings`);
      return undefined;
    }
    return v as string[];
  };
  for (const key of Object.keys(value)) {
    if (!["intent", "harness_model", "assets", "context", "policy"].includes(key)) problems.push(`overrides.${key} is not a stage that takes an override`);
  }
  const overrides: ComposerOverrides = {};
  const intent = section("intent", ["kind", "domains", "risk"]);
  if (intent) {
    const kind = str(intent.kind, "overrides.intent.kind");
    const domains = list(intent.domains, "overrides.intent.domains");
    const risk = str(intent.risk, "overrides.intent.risk");
    overrides.intent = {
      ...(kind !== undefined ? { kind: kind as never } : {}),
      ...(domains !== undefined ? { domains } : {}),
      ...(risk !== undefined ? { risk: risk as never } : {}),
    };
  }
  const harnessModel = section("harness_model", ["assistantId", "model"]);
  if (harnessModel) {
    const assistantId = str(harnessModel.assistantId, "overrides.harness_model.assistantId");
    const model = str(harnessModel.model, "overrides.harness_model.model");
    if (assistantId !== undefined && !assistantIds.includes(assistantId)) problems.push(`overrides.harness_model.assistantId ${assistantId} is not a configured assistant`);
    overrides.harness_model = { ...(assistantId !== undefined ? { assistantId } : {}), ...(model !== undefined ? { model } : {}) };
  }
  const assets = section("assets", ["add", "remove"]);
  if (assets) {
    const add = list(assets.add, "overrides.assets.add");
    const remove = list(assets.remove, "overrides.assets.remove");
    overrides.assets = { ...(add !== undefined ? { add } : {}), ...(remove !== undefined ? { remove } : {}) };
  }
  const context = section("context", ["fragments"]);
  if (context) {
    const fragments = list(context.fragments, "overrides.context.fragments");
    overrides.context = fragments !== undefined ? { fragments } : {};
  }
  const policy = section("policy", ["permission", "budget"]);
  if (policy) {
    const permission = str(policy.permission, "overrides.policy.permission");
    let budget: BudgetCaps | undefined;
    if (policy.budget !== undefined) {
      if (!isRecord(policy.budget)) problems.push("overrides.policy.budget must be an object");
      else {
        budget = {};
        for (const [k, v] of Object.entries(policy.budget)) {
          if (k !== "max_tokens" && k !== "max_cost_usd" && k !== "max_runtime_ms") { problems.push(`overrides.policy.budget.${k} is not a known key`); continue; }
          if (typeof v !== "number" || !Number.isFinite(v)) { problems.push(`overrides.policy.budget.${k} must be a number`); continue; }
          budget[k] = v;
        }
      }
    }
    overrides.policy = { ...(permission !== undefined ? { permission: permission as never } : {}), ...(budget !== undefined ? { budget } : {}) };
  }
  if (problems.length) return { ok: false, error: problems.join("; ") };
  return { ok: true, overrides };
}
