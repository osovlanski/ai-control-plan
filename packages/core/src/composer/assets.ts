/**
 * Stage 3, asset retrieval (plans/m2-composer.md §2 stage 3): hard filters in a fixed order, then
 * a deterministic ranking. Lineage is evidence only, never a score (invariant 6). Skills attach
 * since M2 (Q6) and MCP servers since M3 S4; `chosen: []` with a why is the normal outcome when
 * nothing fits (invariant 7).
 */
import type { AssetRef, McpAssetRef } from "../composition-types.js";
import { mcpLaunchProblem, mcpSecretRefs } from "../provisioning.js";
import { byCodeUnit, overrideWhy, sortedUnique, type RawCandidate, type RawFilter, type RawStage } from "./explain.js";
import type { ComposedIntent, ComposerAsset, ComposerInputs, ComposerOptIn, Harness } from "./types.js";

/** The registry's assistant vocabulary (registry v1 `compatibility.assistants`) for each harness. */
const REGISTRY_ASSISTANT: Readonly<Record<Harness, string | undefined>> = {
  "claude-code": "claude", codex: "codex", cursor: "cursor", bedrock: undefined,
};
/** Harnesses bundle v1 renders a skill file for (`.claude/skills/<name>/SKILL.md`). */
const SKILL_PATH_HARNESSES: ReadonlySet<Harness> = new Set(["claude-code"]);
/** Harnesses whose provisioning lifecycle launches MCP servers (M3 S4). */
const MCP_HARNESSES: ReadonlySet<Harness> = new Set(["claude-code", "codex"]);
export const DEFAULT_MAX_MCP_SERVERS = 2;

/** Fixed filter order (§2 stage 3), then the ranking filters, then the renderer's exclusions. */
export const ASSET_FILTERS = [
  "kind_not_attachable", "disabled_in_producer", "incompatible_harness", "no_skill_path", "no_mcp_path", "mcp_not_provisionable",
  "missing_requirement", "not_allowlisted", "opt_in_stale", "no_tag_match", "conflict", "over_max_skills", "over_max_mcp_servers",
  "excluded_by_renderer",
] as const;
export type AssetFilterName = (typeof ASSET_FILTERS)[number];
/** Filters an operator `add` cannot get past: they are facts about the asset or its trust, not ranking. */
const HARD_FILTERS: ReadonlySet<AssetFilterName> = new Set([
  "kind_not_attachable", "disabled_in_producer", "incompatible_harness", "no_skill_path", "no_mcp_path", "mcp_not_provisionable",
  "missing_requirement", "not_allowlisted", "opt_in_stale", "excluded_by_renderer",
]);

export interface RendererExclusion { ref: string; reason: string }

export interface AssetsStageResult {
  stage: RawStage;
  skills: AssetRef[];
  /** MCP servers, sorted by id. Their launch shapes stay in the registry, pinned by digest. */
  mcpServers: McpAssetRef[];
  refused?: string;
}

interface Evaluated {
  asset: ComposerAsset;
  filter?: AssetFilterName;
  evidence: string[];
  matched: string[];
  allowlisted: boolean;
  optIn?: ComposerOptIn;
}

function hardFilter(asset: ComposerAsset, inputs: ComposerInputs, harness: Harness): { filter?: AssetFilterName; detail: string[]; allowlisted: boolean; optIn?: ComposerOptIn } {
  const allowlisted = inputs.config.allowlist.some((a) => a.id === asset.id && a.digest === asset.digest);
  const optIns = inputs.optIns.filter((o) => o.assetId === asset.id);
  const optIn = optIns.find((o) => o.digest === asset.digest);
  const base = { allowlisted, ...(optIn ? { optIn } : {}) };
  if (asset.kind !== "skill" && asset.kind !== "mcp_server") return { ...base, filter: "kind_not_attachable", detail: [] };
  if (!asset.enabled) return { ...base, filter: "disabled_in_producer", detail: [] };
  const registryAssistant = REGISTRY_ASSISTANT[harness];
  const compatible = asset.compatibility.assistants.includes(harness) || (registryAssistant !== undefined && asset.compatibility.assistants.includes(registryAssistant));
  if (!compatible) return { ...base, filter: "incompatible_harness", detail: [] };
  if (asset.kind === "skill" && !SKILL_PATH_HARNESSES.has(harness)) return { ...base, filter: "no_skill_path", detail: [] };
  if (asset.kind === "mcp_server") {
    if (!MCP_HARNESSES.has(harness)) return { ...base, filter: "no_mcp_path", detail: [] };
    const problem = mcpLaunchProblem(asset.mcp);
    if (problem) return { ...base, filter: "mcp_not_provisionable", detail: [`not provisionable: ${problem}`] };
  }
  const envNames = new Set(inputs.environment.envNames);
  const commands = new Set(inputs.environment.commands);
  // An MCP server's launch env names secrets too; each must be set where the plane launches it.
  const secretRefs = asset.kind === "mcp_server" && asset.mcp ? uniqueRefs([...asset.requirements.secretRefs, ...mcpSecretRefs(asset.mcp)]) : asset.requirements.secretRefs;
  const missing = [
    ...secretRefs.flatMap((ref) =>
      ref.type === "keychain" ? [`missing requirement: keychain ref ${ref.name} cannot be verified in M2`]
        : envNames.has(ref.name) ? [] : [`missing requirement: env ${ref.name} is unset`]),
    ...(asset.requirements.commands ?? []).filter((c) => !commands.has(c)).map((c) => `missing requirement: command ${c} not on PATH`),
  ];
  if (missing.length) return { ...base, filter: "missing_requirement", detail: missing };
  if (!allowlisted && !optIn) return { ...base, filter: optIns.length ? "opt_in_stale" : "not_allowlisted", detail: [] };
  return { ...base, detail: [] };
}

const uniqueRefs = <T extends { type: string; name: string }>(refs: readonly T[]): T[] =>
  refs.filter((r, i) => refs.findIndex((x) => x.type === r.type && x.name === r.name) === i);

const trustEvidence = (e: Pick<Evaluated, "allowlisted" | "optIn">, hasStaleOptIn: boolean) =>
  e.allowlisted ? "allowlisted at digest" : e.optIn ? "opted in at digest" : hasStaleOptIn ? "opt-in pins another digest" : "not allowlisted";

const conflicts = (a: ComposerAsset, b: ComposerAsset) => a.conflicts.includes(b.id) || b.conflicts.includes(a.id);

const REASONS: Readonly<Record<AssetFilterName, (harness: Harness, maxSkills: number, maxMcpServers: number) => string>> = {
  kind_not_attachable: () => "only skills and MCP servers attach: nothing provisions subagents yet, and bundle v1 renders no plugin, hook or rule",
  disabled_in_producer: () => "disabled in the producer",
  incompatible_harness: (h) => `compatibility.assistants does not include harness ${h}`,
  no_skill_path: (h) => `bundle v1 has no skill relPath for harness ${h}`,
  no_mcp_path: (h) => `no provisioning lifecycle launches MCP servers for harness ${h}`,
  mcp_not_provisionable: () => "the launch shape cannot be provisioned: only stdio servers whose secrets are env-var references outside the command line",
  missing_requirement: () => "a required env var name is unset, a keychain ref cannot be verified in M2, or a required command is not on PATH",
  not_allowlisted: () => "not in the workspace digest allowlist and no opt-in",
  opt_in_stale: () => "the opt-in pins a different digest",
  no_tag_match: () => "no tag matches the intent kind or domains",
  conflict: () => "conflicts with a higher-ranked chosen asset",
  over_max_skills: (_h, n) => `ranked below the top ${n} (composer.assets.maxSkills)`,
  over_max_mcp_servers: (_h, _n, m) => `ranked below the top ${m} (composer.assets.maxMcpServers)`,
  excluded_by_renderer: () => "excluded by renderer",
};

export function assetsStage(
  inputs: ComposerInputs,
  intent: ComposedIntent,
  harness: Harness,
  excluded: readonly RendererExclusion[],
): AssetsStageResult {
  const { registry } = inputs;
  if (registry.status !== "ok") {
    const why = registry.status === "off" ? "registry federation is off" : `no registry snapshot yet (${registry.reason})`;
    if (inputs.overrides?.assets?.add?.length) return refusedEmpty(why, "an asset override needs a registry snapshot");
    return { stage: { stage: "assets", candidates: [], filters: [], chosen: [], why }, skills: [], mcpServers: [] };
  }

  const wanted = new Set([intent.kind, ...intent.domains]);
  const maxSkills = Number.isSafeInteger(inputs.config.maxSkills) && inputs.config.maxSkills > 0 ? inputs.config.maxSkills : 0;
  const maxMcp = inputs.config.maxMcpServers ?? DEFAULT_MAX_MCP_SERVERS;
  const maxMcpServers = Number.isSafeInteger(maxMcp) && maxMcp > 0 ? maxMcp : 0;
  const excludedRefs = new Map(excluded.map((e) => [e.ref, e.reason]));
  const assets = [...registry.assets].sort((a, b) => byCodeUnit(a.id, b.id));

  const evaluated: Evaluated[] = assets.map((asset) => {
    const hard = hardFilter(asset, inputs, harness);
    const matched = sortedUnique(asset.tags.filter((t) => wanted.has(t)));
    const hasStaleOptIn = !hard.optIn && inputs.optIns.some((o) => o.assetId === asset.id);
    const evidence = [
      ...hard.detail,
      `tags matched: ${matched.length ? matched.join(", ") : "none"}`,
      `lineage: ${asset.lineage.origin}`,
      trustEvidence(hard, hasStaleOptIn),
    ];
    const filter = hard.filter ?? (excludedRefs.has(asset.id) ? "excluded_by_renderer" : undefined);
    return { asset, evidence, matched, allowlisted: hard.allowlisted, ...(hard.optIn ? { optIn: hard.optIn } : {}), ...(filter ? { filter } : {}) };
  });

  // Ranking: score = matched tag count, ties by id. Score 0 is filtered; conflicts and the cap
  // (per kind) after.
  const ranked = evaluated
    .filter((e) => !e.filter)
    .sort((a, b) => b.matched.length - a.matched.length || byCodeUnit(a.asset.id, b.asset.id));
  const chosen: Evaluated[] = [];
  const ofKind = (kind: string) => chosen.filter((c) => c.asset.kind === kind).length;
  for (const e of ranked) {
    const mcp = e.asset.kind === "mcp_server";
    if (e.matched.length === 0) e.filter = "no_tag_match";
    else if (chosen.some((c) => conflicts(c.asset, e.asset))) e.filter = "conflict";
    else if (!mcp && ofKind("skill") >= maxSkills) e.filter = "over_max_skills";
    else if (mcp && ofKind("mcp_server") >= maxMcpServers) e.filter = "over_max_mcp_servers";
    else chosen.push(e);
  }
  // Chosen in id order: the spec's asset lists and the bundle request are sorted by id.
  const computedIds = sortedUnique(chosen.map((e) => e.asset.id));

  // §3 override: `remove` drops, `add` attaches. An add cannot pass a hard filter or a conflict.
  const given = inputs.overrides?.assets;
  const override = given && (given.add?.length || given.remove?.length) ? given : undefined;
  let finalIds = computedIds;
  if (override) {
    const byId = new Map(evaluated.map((e) => [e.asset.id, e]));
    const removeIds = new Set(override.remove ?? []);
    const kept = computedIds.filter((id) => !removeIds.has(id));
    for (const id of sortedUnique(override.add ?? [])) {
      const e = byId.get(id);
      if (!e) return refused(evaluated, `asset ${id} is not in the registry snapshot`);
      // The renderer's exclusion is recorded as a filter, not a refusal: the add was valid when it was made.
      if (e.filter === "excluded_by_renderer") continue;
      if (e.filter && HARD_FILTERS.has(e.filter)) return refused(evaluated, `asset ${id} was removed by ${e.filter}; an override cannot attach it`);
      if (kept.some((k) => conflicts(byId.get(k)!.asset, e.asset))) return refused(evaluated, `asset ${id} conflicts with a chosen asset`);
      if (!kept.includes(id)) kept.push(id);
    }
    finalIds = sortedUnique(kept);
    // An added asset is chosen, so a ranking filter no longer removes it.
    for (const id of finalIds) {
      const e = byId.get(id)!;
      if (e.filter && !HARD_FILTERS.has(e.filter)) delete e.filter;
    }
  }

  const finalSet = new Set(finalIds);
  const candidates: RawCandidate[] = evaluated.map((e) => ({ ref: e.asset.id, digest: e.asset.digest, evidence: e.evidence }));
  const filters: RawFilter[] = ASSET_FILTERS.flatMap((name): RawFilter[] => {
    if (name === "excluded_by_renderer") {
      // One entry per exclusion: Cockpit's reason is per skill, untrusted, and guarded by finalizeStage.
      return evaluated
        .filter((e) => e.filter === name)
        .map((e) => ({ filter: name, removed: [e.asset.id], reason: `excluded by renderer: ${excludedRefs.get(e.asset.id) ?? "no reason given"}` }));
    }
    const removed = evaluated.filter((e) => e.filter === name && !finalSet.has(e.asset.id)).map((e) => e.asset.id);
    return removed.length ? [{ filter: name, removed, reason: REASONS[name](harness, maxSkills, maxMcpServers) }] : [];
  });

  const refOf = (e: Evaluated): AssetRef => ({
    id: e.asset.id, digest: e.asset.digest, allowlisted: e.allowlisted,
    ...(!e.allowlisted && e.optIn ? { opt_in: { digest: e.optIn.digest, actor: e.optIn.actor, at: e.optIn.at } } : {}),
  });
  const finalEvaluated = finalIds.map((id) => evaluated.find((x) => x.asset.id === id)!);
  const skills: AssetRef[] = finalEvaluated.filter((e) => e.asset.kind === "skill").map(refOf);
  // `tools_allowed: []` narrows nothing: the run's own tool policy governs the server's tools.
  const mcpServers: McpAssetRef[] = finalEvaluated
    .filter((e) => e.asset.kind === "mcp_server")
    .map((e) => ({ ...refOf(e), tools_allowed: [], secret_refs: mcpSecretRefs(e.asset.mcp!) }));

  const notes = [
    ...(registry.stale ? ["registry snapshot is stale"] : []),
    ...(excluded.length ? [`renderer excluded ${sortedUnique(excluded.map((x) => x.ref)).join(", ")}; re-ranked without ${excluded.length === 1 ? "it" : "them"}`] : []),
  ];
  const computedWhy = computedIds.length
    ? `chose ${computedIds.length} of ${evaluated.length} candidates by tag matches with the intent (kind ${intent.kind}, domains ${intent.domains.length ? intent.domains.join(", ") : "none"}), at most ${maxSkills} skill(s) and ${maxMcpServers} MCP server(s)`
    : `no optional asset fits: none of ${evaluated.length} candidates passed the filters and matched the intent (kind ${intent.kind}, domains ${intent.domains.length ? intent.domains.join(", ") : "none"})`;
  const why = [computedWhy, ...notes].join("; ");
  return {
    stage: {
      stage: "assets", candidates, filters, chosen: finalIds,
      why: override ? overrideWhy(computedIds, why) : why,
      ...(override ? { override: { from: computedIds, to: finalIds } } : {}),
    },
    skills,
    mcpServers,
  };
}

function refused(evaluated: readonly Evaluated[], detail: string): AssetsStageResult {
  return {
    stage: {
      stage: "assets",
      candidates: evaluated.map((e) => ({ ref: e.asset.id, digest: e.asset.digest, evidence: e.evidence })),
      filters: [], chosen: [], why: `override refused: ${detail}`,
    },
    skills: [], mcpServers: [], refused: detail,
  };
}

function refusedEmpty(why: string, detail: string): AssetsStageResult {
  return { stage: { stage: "assets", candidates: [], filters: [], chosen: [], why: `override refused: ${detail}; ${why}` }, skills: [], mcpServers: [], refused: detail };
}
