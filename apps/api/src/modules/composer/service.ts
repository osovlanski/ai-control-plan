/**
 * M2 Composer service (plans/m2-composer.md §1, §2 stage 6 preview, §3).
 *
 * `preview` gathers the inputs, runs the pure pipeline (stages 1 to 5) over the two ports, and
 * records what happened: ONE `routing_decisions` row for the outcome stage 2 used and ONE
 * `composition_attempts` row. It never writes `agent_specs` or `composition_decisions`; a
 * revision is persisted only at start (S5), through `BundledComposition.persistRendered`.
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
  NO_CONSUMPTION, OVERRIDE_ACTOR, runComposer, TASK_KINDS, type BudgetCaps, type ComposeResult, type ComposerAsset,
  type ComposerConfig, type ComposerInputs, type ComposerOptIn, type ComposerOutcome, type ComposerOverrides, type RegistryView,
  type TaskIntent, type TaskKind,
} from "@agent-plane/core";
import type { ResolvedConfig } from "../../config.js";
import type { Db } from "../../db/index.js";
import type { BundledComposition } from "../bundle-request.js";
import type { RegistryFederation } from "../registry-federation.js";
import type { RouteDeps } from "../router.js";
import { CockpitBundlePort, RouteHarnessModelPort } from "./ports.js";
import { repoSignalsForTask } from "./repo-signals.js";

/** `policy.revision.id`: the workspace policy comes from config.yaml; its digest tells revisions apart. */
export const WORKSPACE_POLICY_ID = "workspace-policy:config";
/** The attempt row's origin for a preview. */
export const PREVIEW_ORIGIN = "preview";
/** A composed preview persists no revision; 034 requires a non-persisted attempt to say why. */
export const PREVIEW_REASON = "preview: not persisted; awaiting confirmation";

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
  outcome: "persisted" | "failed" | "skipped";
  reason: string | null;
  compositionRevisionId: string | null;
  createdAt: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export class ComposerService {
  constructor(private readonly deps: ComposerServiceDeps) {}

  private get config(): ResolvedConfig { return this.deps.config; }
  private get db(): Db { return this.deps.db; }
  private now(): Date { return this.deps.now ? this.deps.now() : new Date(); }

  /** Stages 1 to 5, the preview form of confirm. */
  async preview(taskId: string, overrides?: ComposerOverrides): Promise<PreviewResult> {
    if (!this.deps.tasks.get(taskId)) return { ok: false, status: 404, error: "not found" };
    const harnessModel = new RouteHarnessModelPort(this.deps, taskId, "intake");
    const bundle = new CockpitBundlePort(this.deps.bundled);
    const ports = { harnessModel, bundle };

    let result = await runComposer(await this.inputs(taskId, overrides, harnessModel), ports, { sha256 });
    let resynced = false;
    // A stale pin (Cockpit 404): one registry sync, then recompose once (§2 stage 4).
    if (result.outcome.status === "failed" && result.outcome.reason === "not_found" && this.config.registry.cockpit.enabled) {
      await this.deps.federation.sync();
      resynced = true;
      result = await runComposer(await this.inputs(taskId, overrides, harnessModel), ports, { sha256 });
    }
    if (result.outcome.status === "failed" && result.outcome.reason === "override_refused") {
      // Refused overrides are never recorded (§3): no routing row, no attempt.
      return { ok: false, status: 400, error: "override refused", reason: result.outcome.detail ?? "override refused" };
    }

    const outcome = result.outcome;
    const attempt = this.db.transaction(() => {
      const routingDecisionId = harnessModel.persistUsed() ?? null;
      const id = this.nextAttemptId(taskId);
      const reason = outcome.status === "composed" ? PREVIEW_REASON : outcome.reason;
      this.db.prepare(
        `INSERT INTO composition_attempts (id, task_id, origin, routing_decision_id, composition_digest, outcome, reason, composition_revision_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(id, taskId, PREVIEW_ORIGIN, routingDecisionId, result.compositionDigest ?? null, outcome.status === "failed" ? "failed" : "skipped", reason, this.now().toISOString());
      return { id, routingDecisionId };
    })();
    return {
      ok: true,
      preview: {
        decision: result.decision,
        specDraft: result.specDraft ?? null,
        compositionDigest: result.compositionDigest ?? null,
        outcome,
        attemptId: attempt.id,
        routingDecisionId: attempt.routingDecisionId,
        resynced,
      },
    };
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
      `SELECT id, origin, routing_decision_id, composition_digest, outcome, reason, composition_revision_id, created_at
         FROM composition_attempts WHERE task_id = ? ORDER BY rowid`,
    ).all(taskId) as Array<{ id: string; origin: string; routing_decision_id: number | null; composition_digest: string | null; outcome: AttemptRow["outcome"]; reason: string | null; composition_revision_id: string | null; created_at: string }>)
      .map((r) => ({
        id: r.id, origin: r.origin, routingDecisionId: r.routing_decision_id, compositionDigest: r.composition_digest,
        outcome: r.outcome, reason: r.reason, compositionRevisionId: r.composition_revision_id, createdAt: r.created_at,
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

  private async inputs(taskId: string, overrides: ComposerOverrides | undefined, harnessModel: RouteHarnessModelPort): Promise<ComposerInputs> {
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
    const config: ComposerConfig = {
      maxSkills: composer.assets.maxSkills,
      allowlist: composer.assets.allowlist.map(({ id, digest }) => ({ id, digest })),
      fragments: [...new Set(fragments)],
      memoryBundles: composer.context.memoryBundles.map(({ id, digest, reason }) => ({ id, digest, reason })),
      charsPerToken,
      tokenBudget: composer.context.tokenBudget,
      policy: { riskPermission: { ...composer.policy.riskPermission }, permitAmbient: composer.policy.permitAmbient },
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
      // Settlement of what the task already consumed is S6 (composer/accounting.ts).
      consumed: NO_CONSUMPTION,
      ...(overrides ? { overrides } : {}),
      confirm: { mode: "preview" },
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
      requirements: a.requirements, conflicts: a.conflicts, lineage: a.lineage,
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
