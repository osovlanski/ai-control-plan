/**
 * TypeScript shapes of the contracts the Composer reads and writes: composition v1
 * (docs/contracts/composition-v1.md), bundle v1 and the registry v1 asset. The JSON Schemas under
 * contracts/ are the authority and the validators stay in apps/api; these are types only, here so
 * the pure Composer pipeline in core can use them without depending on apps/api.
 */

// ---- registry v1 (camelCase wire) ------------------------------------------

export type AssetKind = "skill" | "plugin" | "agent" | "hook" | "mcp_server" | "rule";
export interface SecretRef { type: "env" | "keychain"; name: string }
export interface RegistryAsset {
  id: string;
  digest: string;
  kind: AssetKind;
  nativeKind: string;
  name: string;
  description: string;
  tags: string[];
  targets: string[];
  compatibility: { assistants: string[] };
  requirements: { secretRefs: SecretRef[]; commands?: string[] };
  conflicts: string[];
  lineage: { origin: string; sourceUrl?: string };
  enabled: boolean;
  mcp?: { transport: "stdio" | "remote"; command?: string; args?: string[]; url?: string; env: Record<string, SecretRef> };
  installedAt: string;
  lastUsedAt?: string;
  stats?: Record<string, unknown>;
  [extra: string]: unknown;
}
export interface RegistrySnapshot { schemaVersion: string; snapshotDigest: string; assets: RegistryAsset[] }

// ---- bundle v1 (camelCase wire) --------------------------------------------

export type BundleHarness = "claude-code" | "codex";
export interface PinnedInput { id: string; digest: string }
export interface BundleRequest {
  schemaVersion: string;
  harness: BundleHarness;
  fragments: string[];
  memoryBundles: PinnedInput[];
  skills: PinnedInput[];
  model: { id: string; charsPerToken: number };
  tokenBudget: number;
}
export interface BundleFile { relPath: string; content: string; digest: string }
export type InputKind = "fragment" | "memory_bundle" | "skill";
export interface ManifestIncluded { kind: InputKind; ref: string; digest: string; reason: string; relPath?: string }
export interface ManifestExcluded { kind: InputKind; ref: string; reason: string }
export interface BundleManifest {
  harness: BundleHarness;
  bundleDigest: string;
  compiler: { name: string; version: string };
  included: ManifestIncluded[];
  excluded: ManifestExcluded[];
  tokens: { estimated: number; tokenMethod: "estimated"; charsPerToken: number; budget: number };
}
export interface BundleResponse { schemaVersion: string; files: BundleFile[]; manifest: BundleManifest }

// ---- composition v1 (plane-internal, snake_case) ---------------------------

/** What writers write. Readers accept every stored 1.x up to this one. */
export const COMPOSITION_SCHEMA_VERSION = "1.1";
export const COMPOSER_STAGES = ["intent", "harness_model", "assets", "context", "policy", "confirm"] as const;
export type ComposerStage = (typeof COMPOSER_STAGES)[number];

/** `general` is new in 1.1: the frozen task classifier's fallback kind. */
export type IntentKind = "coding" | "planning" | "review" | "research" | "ops" | "content" | "general";
/** `read-only` is new in 1.1: the workspace approval mode of the same name. */
export type CompositionPermission = "auto" | "prompt-on-escalation" | "read-only";

export interface OptIn { digest: string; actor: string; at: string }
export interface AssetRef { id: string; digest: string; allowlisted: boolean; opt_in?: OptIn }
export interface McpAssetRef extends AssetRef { tools_allowed: string[]; secret_refs: SecretRef[] }
export interface AgentSpec {
  schema_version: string;
  composition_revision_id: string;
  task_id: string;
  intent: { kind: IntentKind; domains: string[]; complexity: "S" | "M" | "L"; risk: "low" | "normal" | "high" };
  harness: "claude-code" | "codex" | "cursor" | "bedrock";
  model: { primary: { id: string }; fallbacks: Array<{ id: string }>; reasoning_effort?: "low" | "medium" | "high" };
  registry: { snapshot_digest: string; observed_at: string; stale: boolean };
  assets: { skills: AssetRef[]; mcp_servers: McpAssetRef[]; subagents: AssetRef[] };
  context: {
    fragments: string[];
    memory_bundles: Array<{ id: string; digest: string; reason: string }>;
    bundle_digest: string;
    compiler: { name: string; version: string; tokens: number; token_method: "estimated"; chars_per_token: number };
  };
  policy: { revision: { id: string; digest: string }; permission: CompositionPermission; tool_allowlist: string[]; budget: { max_tokens?: number; max_cost_usd?: number; max_runtime_ms?: number } };
  workspace: { repository_id: string; branch: string; worktree_id: string };
  provisioning: { requested: "isolated" | "ambient"; achieved?: "full" | "high" | "partial" | "ambient" | "select-only"; profile_digest?: string };
  explanation_ref: string;
}
export interface DecisionStage {
  stage: ComposerStage;
  candidates: Array<{ ref: string; digest?: string; evidence?: string[] }>;
  filters: Array<{ filter: string; removed: string[]; reason: string }>;
  chosen: string[];
  why: string;
  override: null | { actor: string; from: string[]; to: string[]; reason: string };
}
export interface CompositionDecision { schema_version: string; id: string; composition_revision_id: string; stages: DecisionStage[] }
