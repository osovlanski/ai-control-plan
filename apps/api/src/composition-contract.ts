/**
 * Reference implementation of the composition v1 contract (docs/contracts/composition-v1.md):
 * the plane-internal, persisted AgentSpec revision and its CompositionDecision. The JSON
 * Schemas under contracts/composition/v1 are the authority; this module adds the rules a schema
 * cannot express — sort order, opt-in digest pinning, no silent ambient fallback, decision
 * consistency, and agreement between a spec, its decision and the bundle it was composed with.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { BUNDLE_CONTRACT_DIR, formatSchemaErrors, type BundleRequest, type BundleResponse } from "./bundle-contract.js";
import { isCompatibleVersion, REGISTRY_CONTRACT_DIR, type ContractResult, type SecretRef } from "./registry-contract.js";

const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv2020) => void;

export const COMPOSITION_SCHEMA_VERSION = "1.0";
export const COMPOSITION_CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/composition/v1");
export const COMPOSER_STAGES = ["intent", "harness_model", "assets", "context", "policy", "confirm"] as const;

export interface OptIn { digest: string; actor: string; at: string }
export interface AssetRef { id: string; digest: string; allowlisted: boolean; opt_in?: OptIn }
export interface McpAssetRef extends AssetRef { tools_allowed: string[]; secret_refs: SecretRef[] }
export interface AgentSpec {
  schema_version: string;
  composition_revision_id: string;
  task_id: string;
  intent: { kind: string; domains: string[]; complexity: "S" | "M" | "L"; risk: "low" | "normal" | "high" };
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
  policy: { permission: "auto" | "prompt-on-escalation"; tool_allowlist: string[]; budget: { max_tokens?: number; max_cost_usd?: number; max_runtime_ms?: number } };
  workspace: { repository_id: string; branch: string; worktree_id: string };
  provisioning: { requested: "isolated" | "ambient"; achieved?: "full" | "high" | "partial" | "ambient" | "select-only"; profile_digest?: string };
  explanation_ref: string;
}
export interface DecisionStage {
  stage: (typeof COMPOSER_STAGES)[number];
  candidates: Array<{ ref: string; digest?: string; evidence?: string[] }>;
  filters: Array<{ filter: string; removed: string[]; reason: string }>;
  chosen: string[];
  why: string;
  override: null | { actor: string; from: string[]; to: string[]; reason: string };
}
export interface CompositionDecision { schema_version: string; id: string; composition_revision_id: string; stages: DecisionStage[] }

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
for (const [dir, file] of [
  [REGISTRY_CONTRACT_DIR, "registry-snapshot.schema.json"],
  [BUNDLE_CONTRACT_DIR, "bundle-request.schema.json"],
  [COMPOSITION_CONTRACT_DIR, "agent-spec.schema.json"],
  [COMPOSITION_CONTRACT_DIR, "composition-decision.schema.json"],
] as const) {
  // Registered under the schema's own $id, so the cross-contract $refs resolve.
  ajv.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")) as object);
}
const specSchema = ajv.getSchema("https://agent-plane.local/contracts/composition/v1/agent-spec.schema.json")!;
const decisionSchema = ajv.getSchema("https://agent-plane.local/contracts/composition/v1/composition-decision.schema.json")!;

const isStrictlySorted = (values: readonly string[]) => values.every((v, i) => i === 0 || values[i - 1]! < v);

/** Persisted rows: a reader accepts any stored minor up to its own. */
function versionError(body: unknown, supported: string): string | undefined {
  const version = (body as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version === "string" && isCompatibleVersion(supported, version)) return undefined;
  return `unsupported schema_version ${JSON.stringify(version)}; reader supports ${supported}`;
}

export function validateAgentSpec(body: unknown, supported = COMPOSITION_SCHEMA_VERSION): ContractResult<AgentSpec> {
  const versionProblem = versionError(body, supported);
  if (versionProblem) return { ok: false, errors: [versionProblem] };
  if (!specSchema(body)) return { ok: false, errors: formatSchemaErrors(specSchema.errors) };
  const spec = body as AgentSpec;
  const errors: string[] = [];
  const sorted = (path: string, values: readonly string[]) => {
    if (!isStrictlySorted(values)) errors.push(`${path} is not sorted`);
  };
  sorted("/intent/domains", spec.intent.domains);
  sorted("/policy/tool_allowlist", spec.policy.tool_allowlist);
  sorted("/context/fragments", spec.context.fragments);
  sorted("/context/memory_bundles", spec.context.memory_bundles.map((m) => m.id));
  for (const list of ["skills", "mcp_servers", "subagents"] as const) {
    const refs: AssetRef[] = spec.assets[list];
    sorted(`/assets/${list}`, refs.map((a) => a.id));
    refs.forEach((asset, i) => {
      if (asset.opt_in && asset.opt_in.digest !== asset.digest) {
        errors.push(`/assets/${list}/${i}/opt_in pins ${asset.opt_in.digest}, not the attached digest ${asset.digest}`);
      }
    });
  }
  spec.assets.mcp_servers.forEach((server, i) => sorted(`/assets/mcp_servers/${i}/tools_allowed`, server.tools_allowed));
  // Invariant 3: ambient is never the silent result of an isolated request.
  if (spec.provisioning.requested === "isolated" && spec.provisioning.achieved === "ambient") {
    errors.push("/provisioning achieved ambient for an isolated request; that is a silent fallback, compose a new revision instead");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: spec };
}

export function validateCompositionDecision(body: unknown, supported = COMPOSITION_SCHEMA_VERSION): ContractResult<CompositionDecision> {
  const versionProblem = versionError(body, supported);
  if (versionProblem) return { ok: false, errors: [versionProblem] };
  if (!decisionSchema(body)) return { ok: false, errors: formatSchemaErrors(decisionSchema.errors) };
  const decision = body as CompositionDecision;
  const errors: string[] = [];
  const order = decision.stages.map((s) => s.stage).join(",");
  if (order !== COMPOSER_STAGES.join(",")) errors.push(`/stages must be ${COMPOSER_STAGES.join(",")} in order, got ${order}`);
  decision.stages.forEach((stage, i) => {
    const candidates = new Set(stage.candidates.map((c) => c.ref));
    if (candidates.size !== stage.candidates.length) errors.push(`/stages/${i}/candidates lists a ref more than once`);
    const removed = new Set(stage.filters.flatMap((f) => f.removed));
    for (const ref of removed) if (!candidates.has(ref)) errors.push(`/stages/${i} filter removed ${ref}, which is not a candidate`);
    for (const ref of stage.chosen) {
      if (!candidates.has(ref)) errors.push(`/stages/${i} chose ${ref}, which is not a candidate`);
      if (removed.has(ref)) errors.push(`/stages/${i} chose ${ref}, which a filter removed`);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, value: decision };
}

/**
 * A revision and its explanation agree, and — when given — so does the bundle it was composed
 * with. Both documents must already be individually valid.
 */
export function checkComposition(
  spec: AgentSpec,
  decision: CompositionDecision,
  bundle?: { request: BundleRequest; response: BundleResponse },
): string[] {
  const errors: string[] = [];
  if (spec.explanation_ref !== decision.id) errors.push(`explanation_ref ${spec.explanation_ref} is not decision ${decision.id}`);
  if (decision.composition_revision_id !== spec.composition_revision_id) errors.push("decision explains a different composition revision");
  const attached = [...spec.assets.skills, ...spec.assets.mcp_servers, ...spec.assets.subagents].map((a) => a.id).sort();
  const chosen = [...(decision.stages.find((s) => s.stage === "assets")?.chosen ?? [])].sort();
  if (attached.join("\n") !== chosen.join("\n")) errors.push(`assets stage chose [${chosen.join(", ")}] but the spec attaches [${attached.join(", ")}]`);
  if (bundle) {
    const { request, response } = bundle;
    const { compiler } = spec.context;
    if (response.manifest.bundleDigest !== spec.context.bundle_digest) errors.push("context.bundle_digest does not match the bundle");
    if (request.harness !== spec.harness) errors.push("bundle harness does not match the spec");
    if (request.fragments.join("\n") !== spec.context.fragments.join("\n")) errors.push("bundle fragments do not match context.fragments");
    if (request.memoryBundles.join("\n") !== spec.context.memory_bundles.map((m) => m.id).join("\n")) errors.push("bundle memory bundles do not match context.memory_bundles");
    if (response.manifest.compiler.name !== compiler.name || response.manifest.compiler.version !== compiler.version) errors.push("bundle compiler does not match context.compiler");
    if (response.manifest.tokens.estimated !== compiler.tokens || response.manifest.tokens.charsPerToken !== compiler.chars_per_token) errors.push("bundle token estimate does not match context.compiler");
  }
  return errors;
}
