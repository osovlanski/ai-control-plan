/**
 * M2 Composer: the inputs, ports and result of the pure pipeline (plans/m2-composer.md §1, §2).
 *
 * Everything the pipeline reads is in `ComposerInputs` or comes back from a port; nothing is read
 * from the clock, the environment or the filesystem (§4.1, enforced by a lint rule scoped to this
 * directory). Ids are not minted here: the api fills `composition_revision_id`, `explanation_ref`,
 * `workspace` and the decision `id` when it persists a revision.
 */
import type { PermissionPolicy } from "../adapter.js";
import type {
  AgentSpec, BundleHarness, BundleRequest, BundleResponse, CompositionDecision, CompositionPermission, IntentKind, RegistryAsset,
} from "../composition-types.js";
import type { TaskKind } from "../task-classifier.js";
import type { TaskConsumption } from "./accounting.js";

/** The workspace approval mode, in config vocabulary. Config `auto-approve` is spec `auto`. */
export type ApprovalMode = PermissionPolicy["mode"];
export type IntentRisk = AgentSpec["intent"]["risk"];
export type Harness = AgentSpec["harness"];
export type ComposedIntent = AgentSpec["intent"];

// ---- stage 1 inputs ---------------------------------------------------------

/** The marker files stage 1 reads from the base commit, sorted by relPath (UTF-16 code units). */
export const REPO_MARKER_FILES = ["Cargo.toml", "go.mod", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "tsconfig.json"] as const;
export type RepoMarkerFile = (typeof REPO_MARKER_FILES)[number];

/**
 * Marker files read from the task's base commit (never the working tree). `files` is sorted by
 * relPath and omits absent markers; `truncated` marks a file cut at the api's read cap.
 */
export type RepoSignals =
  | { status: "ok"; baseCommit: string; files: Array<{ relPath: string; content: string; truncated: boolean }> }
  | { status: "unavailable"; reason: "no_repository" | "git_unavailable" | "base_unreadable" };

export interface ComposerTask {
  id: string;
  goal: string;
  constraints: readonly string[];
  /** The stored `tasks.task_kind` (classifier v1). Absent on a pre-031 task: v1 labels it at read time. */
  storedKind?: TaskKind;
}

// ---- stage 3 inputs ---------------------------------------------------------

/**
 * A registry asset as stage 3 sees it: the volatile fields (`installedAt`, `lastUsedAt`, `stats`)
 * are dropped, and `name`/`description` are never read, so third-party prose cannot enter a decision.
 */
export type ComposerAsset = Pick<RegistryAsset, "id" | "digest" | "kind" | "enabled" | "tags" | "compatibility" | "requirements" | "conflicts" | "lineage">;

export type RegistryView =
  /** Registry federation is off (`registry.cockpit.enabled: false`); bundles are off with it. */
  | { status: "off" }
  /** Federation is on but no snapshot exists, after the api's one sync attempt failed for `reason`. */
  | { status: "no_snapshot"; reason: BundleFailureReason }
  | { status: "ok"; snapshotDigest: string; observedAt: string; stale: boolean; assets: readonly ComposerAsset[] };

/** A row of `composition_opt_ins`. `at` was stamped once, when the opt-in was written. */
export interface ComposerOptIn { assetId: string; digest: string; actor: string; at: string }

export interface PinnedAsset { id: string; digest: string }
export interface MemoryBundlePin { id: string; digest: string; reason: string }
export interface BudgetCaps { max_tokens?: number; max_cost_usd?: number; max_runtime_ms?: number }

/** `composer.*` config, resolved by the api for this task's repository and primary model. */
export interface ComposerConfig {
  /** `composer.assets.maxSkills`. */
  maxSkills: number;
  /** The workspace digest allowlist. */
  allowlist: readonly PinnedAsset[];
  /** `composer.context.fragments`, already resolved for the task's repository. */
  fragments: readonly string[];
  memoryBundles: readonly MemoryBundlePin[];
  /** `composer.context.charsPerToken`, resolved for the primary model. */
  charsPerToken: number;
  /** `composer.context.tokenBudget` as configured; the effective budget is computed in stage 4. */
  tokenBudget: number;
  policy: {
    /** `composer.policy` risk map, in config vocabulary. */
    riskPermission: Partial<Record<IntentRisk, ApprovalMode>>;
    permitAmbient: boolean;
    /**
     * M3 S2: whether a revision may bind a `partial` profile (machine-global config stays visible).
     * A workspace that permits ambient accepts partial too, since partial is strictly more isolated.
     */
    permitPartial: boolean;
  };
  /** Per-task caps. */
  budget: BudgetCaps;
}

export interface ComposerWorkspacePolicy {
  /** Id of the workspace policy revision (`policy.revision.id`). Supplied by the api, never minted here. */
  policyId: string;
  approvalMode: ApprovalMode;
  /** `[]` today: the approval mode governs. */
  toolAllowlist: readonly string[];
}

// ---- overrides (§3) ---------------------------------------------------------

export interface ComposerOverrides {
  intent?: { kind?: IntentKind; domains?: readonly string[]; risk?: IntentRisk };
  harness_model?: { assistantId?: string; model?: string };
  assets?: { add?: readonly string[]; remove?: readonly string[] };
  context?: { fragments?: readonly string[] };
  /** Tighten only: a looser permission or a larger cap is refused. */
  policy?: { permission?: CompositionPermission; budget?: BudgetCaps };
}

/** Stage 6. A preview leaves `confirm.chosen` empty; a start records `["start"]`. */
export type ConfirmInput =
  | { mode: "preview" }
  | { mode: "start"; origin: "operator" | "wake" | "run-now" | "failover" | "context-yield" };

export interface ComposerInputs {
  task: ComposerTask;
  repoSignals: RepoSignals;
  registry: RegistryView;
  optIns: readonly ComposerOptIn[];
  /** Env var NAMES that are set (never values), and the required commands found on PATH. */
  environment: { envNames: readonly string[]; commands: readonly string[] };
  config: ComposerConfig;
  workspacePolicy: ComposerWorkspacePolicy;
  /** What the task has consumed so far (core accounting, `taskConsumption`). */
  consumed: TaskConsumption;
  overrides?: ComposerOverrides;
  confirm: ConfirmInput;
  /** Hostnames that must never appear in a decision: the machine's own and the Cockpit base URL host. */
  forbiddenHostnames: readonly string[];
}

// ---- stage 2 port -----------------------------------------------------------

/** route()'s filterFailures, projected to fixed names (§2 stage 2), in this order. */
export const HARNESS_FILTERS = [
  "disabled", "no_manifest", "auth", "no_filesystem", "no_shell", "repo_not_allowlisted", "cooldown", "quota_blocked", "quota_exhausted",
] as const;
export type HarnessFilterName = (typeof HARNESS_FILTERS)[number];

export type ModelSource = "k13-applied" | "intent-override" | "manifest-first";

export interface HarnessModelCandidate {
  assistantId: string;
  /** Absent for an assistant whose manifest lists no model (or has no manifest): the ref is then the assistant id alone. */
  modelId?: string;
  quotaUsedPercent?: number;
  telemetryRuns?: number;
  /** K13 shadow recommendation: evidence only, never a selection. */
  k13Shadow?: { model: string; rule: string };
}

/**
 * One hard filter route() applied. It names assistants, and every candidate of a named assistant
 * is removed. `kinds` carries blocker kinds only (an auth state, a quota blocker kind, a cooldown
 * class): never a `retryAt`, a timestamp or free text. Core writes the reason from a template.
 */
export interface HarnessModelFilter { filter: HarnessFilterName; assistantIds: readonly string[]; kinds?: readonly string[] }

export interface HarnessModelChoice {
  assistantId: string;
  modelId: string;
  harness: Harness;
  modelSource: ModelSource;
  /** The approval modes this adapter enforces (it refuses the rest). */
  acceptedApprovalModes: readonly ApprovalMode[];
  /** The manifest declares a proven `harness.usageReporting`: only then can a token cap be bounded. */
  usageReporting: boolean;
  /** K7 price evidence for the chosen model, if any. */
  price?: ModelPrice;
}

export interface ModelPrice { pricingVersion: string; inputPerMtok: number; outputPerMtok: number }

export interface HarnessModelProjection {
  candidates: readonly HarnessModelCandidate[];
  filters: readonly HarnessModelFilter[];
  /** Absent when no candidate is eligible (or an override target failed its filters). */
  chosen?: HarnessModelChoice;
  /** route()'s `ruleFired`, sanitized by the port. Core guards it again. */
  ruleFired: string;
}

export interface HarnessModelRequest {
  taskId: string;
  intent: ComposedIntent;
  /** The stage-2 override. The port is called once without it and, when there is one, once with it. */
  override?: { assistantId?: string; model?: string };
}

/** Stage 2 over the api's route(). Neither call persists anything. A port reports a missing dependency in its answer; a throw is a bug and rejects runComposer. */
export interface HarnessModelPort { select(request: HarnessModelRequest): Promise<HarnessModelProjection> }

// ---- stage 4 port -----------------------------------------------------------

/** #85's render failures (`BundleRenderFailure`), by reason. On every one nothing was written. */
export type BundleFailureReason =
  | "disabled" | "token_file_missing" | "token_file_unsafe" | "unreachable" | "timeout" | "unauthenticated" | "http_error"
  | "payload_too_large" | "unsupported_version" | "invalid_response" | "not_found" | "bad_request"
  | "unsupported_harness" | "invalid_request" | "composition_rejected";

/** The spec draft as far as stage 4 knows it: what a bundle request is built from. */
export type BundleRenderDraft = Pick<AgentSpecDraft, "schema_version" | "task_id" | "intent" | "model" | "registry" | "assets"> & {
  harness: BundleHarness;
  context: Pick<AgentSpec["context"], "fragments" | "memory_bundles">;
};

export type BundlePortResult =
  | { status: "ok"; request: BundleRequest; response: BundleResponse }
  /** Cockpit excluded a selected skill (bundle v1 §Finalization). */
  | { status: "not_final"; response: BundleResponse; excludedSkills: ReadonlyArray<{ ref: string; reason: string }> }
  | { status: "failure"; reason: BundleFailureReason };

/** Stage 4 over #85's `BundledComposition.render`. Writes nothing. Failures are answers (`status: "failure"`); a throw rejects runComposer. */
export interface BundlePort { render(draft: BundleRenderDraft, options: { charsPerToken: number; tokenBudget: number }): Promise<BundlePortResult> }

/** What stage 5 hands the provisioning port: the spec as far as stage 4 knows it, and the rendered bundle. */
export interface ProvisioningPredictRequest {
  assistantId: string;
  spec: Omit<AgentSpecDraft, "policy" | "provisioning">;
  bundle: BundleResponse;
}

/**
 * M3 S2: what the chosen adapter's `prepare` says it would provision for this composition. Writes
 * nothing. `planned` carries the profile digest the run must verify; `unavailable` is an answer
 * (no lifecycle, an unsupported asset or transport), never a throw.
 */
export type ProvisioningPrediction =
  | { status: "planned"; harness: BundleHarness; fidelity: "full" | "partial"; profileDigest: string; visible: string[] }
  | { status: "unavailable"; reason: string };

export interface ProvisioningPort { predict(request: ProvisioningPredictRequest): Promise<ProvisioningPrediction> }

/** `provisioning` is optional: without it every composition is ambient, as in M2. */
export interface ComposerPorts { harnessModel: HarnessModelPort; bundle: BundlePort; provisioning?: ProvisioningPort }
/** `sha256` returns 64 lowercase hex characters of the UTF-8 encoding of `text`. */
export interface ComposerDeps { sha256(text: string): string }

// ---- result -----------------------------------------------------------------

/** An AgentSpec without the parts the api fills at persist. */
export type AgentSpecDraft = Omit<AgentSpec, "composition_revision_id" | "explanation_ref" | "workspace">;
/** A CompositionDecision without the ids the api fills at persist. */
export type CompositionDecisionDraft = Omit<CompositionDecision, "id" | "composition_revision_id">;

export type ComposerFailureReason =
  | "no_candidate" | "policy_unenforceable" | "isolation_unavailable" | "budget_exhausted"
  /** An override would loosen permission or budget, attach an unallowlisted asset, or names something invalid. Never recorded: the api answers 400. */
  | "override_refused"
  /** The second render still excluded a selected skill; a third render is not attempted. */
  | "not_final"
  | Exclude<BundleFailureReason, "unsupported_harness">;

export type ComposerOutcome =
  | { status: "composed" }
  | { status: "failed"; reason: ComposerFailureReason; detail?: string }
  /** Bundle v1 has no renderer for the harness (cursor, bedrock): route-only. */
  | { status: "skipped"; reason: "unsupported_harness" };

export interface ComposeResult {
  outcome: ComposerOutcome;
  decision: CompositionDecisionDraft;
  specDraft?: AgentSpecDraft;
  bundle?: { request: BundleRequest; response: BundleResponse };
  /** `sha256:` + sha256 of jcs(finite) of `{ stages: stages[0..4], specDraft }`. Present when composed. */
  compositionDigest?: string;
}
