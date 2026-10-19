/**
 * Stage 2, harness and model selection (plans/m2-composer.md §2 stage 2). route() lives in
 * apps/api and decides the assistant, unchanged; the port projects its explanation. This module
 * turns that projection into the decision entry: candidates `<assistantId>/<modelId>`, filters
 * under fixed names with reasons written here from blocker kinds only, and the model source.
 */
import { overrideWhy, type RawCandidate, type RawFilter, type RawStage } from "./explain.js";
import {
  HARNESS_FILTERS, type ComposedIntent, type ComposerInputs, type Harness, type HarnessFilterName, type HarnessModelChoice,
  type HarnessModelPort, type HarnessModelProjection,
} from "./types.js";

/** Provider → harness (§2 stage 2). A fake assistant's harness is the port's test-only option. */
const PROVIDER_HARNESS: Readonly<Record<string, Harness>> = {
  anthropic: "claude-code", openai: "codex", openrouter: "codex", cursor: "cursor", bedrock: "bedrock",
};

/** The harness a provider's assistants run under, for the port; `undefined` for an unknown provider. */
export function harnessForProvider(provider: string): Harness | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_HARNESS, provider) ? PROVIDER_HARNESS[provider] : undefined;
}

const KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const kindsOf = (kinds: readonly string[] | undefined) => [...new Set((kinds ?? []).filter((k) => KIND.test(k)))].sort();

const FILTER_REASONS: Readonly<Record<HarnessFilterName, (kinds: string[]) => string>> = {
  disabled: () => "disabled in workspace config",
  no_manifest: () => "no capability manifest (sync has not run)",
  auth: (k) => (k.length ? `auth ${k.join(", ")}` : "auth not ok"),
  no_filesystem: () => "no filesystem capability",
  no_shell: () => "no shell capability",
  repo_not_allowlisted: () => "repository path not in workspace allowlist",
  cooldown: (k) => (k.length ? `cooldown: ${k.join(", ")}` : "cooldown"),
  quota_blocked: (k) => (k.length ? `quota blocked: ${k.join(", ")}` : "quota blocked"),
  quota_exhausted: () => "quota exhausted",
};

const MODEL_SOURCE_WHY: Readonly<Record<HarnessModelChoice["modelSource"], string>> = {
  "k13-applied": "a selector K13 committed in applied mode",
  "intent-override": "the task's model override",
  "manifest-first": "the manifest's first model",
};

export const candidateRef = (assistantId: string, modelId?: string) => (modelId ? `${assistantId}/${modelId}` : assistantId);

function candidatesOf(projection: HarnessModelProjection): RawCandidate[] {
  return projection.candidates.map((c) => {
    const evidence: string[] = [];
    if (c.quotaUsedPercent !== undefined && Number.isFinite(c.quotaUsedPercent)) evidence.push(`quota ${c.quotaUsedPercent}% used`);
    if (c.telemetryRuns !== undefined && Number.isSafeInteger(c.telemetryRuns)) evidence.push(`telemetry: ${c.telemetryRuns} runs`);
    if (c.k13Shadow) evidence.push(`K13 shadow: ${c.k13Shadow.model} (${c.k13Shadow.rule})`);
    return { ref: candidateRef(c.assistantId, c.modelId), evidence };
  });
}

function filtersOf(projection: HarnessModelProjection, candidates: readonly RawCandidate[]): RawFilter[] {
  const assistantOf = (ref: string) => ref.split("/")[0]!;
  return HARNESS_FILTERS.flatMap((name) => {
    const entries = projection.filters.filter((f) => f.filter === name);
    if (!entries.length) return [];
    const assistants = new Set(entries.flatMap((f) => f.assistantIds));
    const kinds = kindsOf(entries.flatMap((f) => f.kinds ?? []));
    return [{ filter: name, removed: candidates.filter((c) => assistants.has(assistantOf(c.ref))).map((c) => c.ref), reason: FILTER_REASONS[name](kinds) }];
  });
}

function whyOf(projection: HarnessModelProjection): string {
  const { chosen, ruleFired } = projection;
  if (!chosen) return ruleFired === "no-eligible-candidate" ? "no-eligible-candidate" : `${ruleFired}: no eligible candidate`;
  return `${ruleFired}; harness ${chosen.harness}; model ${chosen.modelId} from ${MODEL_SOURCE_WHY[chosen.modelSource]}`;
}

export interface HarnessModelStageResult {
  stage: RawStage;
  chosen?: HarnessModelChoice;
}

export async function harnessModelStage(inputs: ComposerInputs, intent: ComposedIntent, port: HarnessModelPort): Promise<HarnessModelStageResult> {
  const base = await port.select({ taskId: inputs.task.id, intent });
  const given = inputs.overrides?.harness_model;
  const override = given && (given.assistantId !== undefined || given.model !== undefined) ? given : undefined;
  const used = override ? await port.select({ taskId: inputs.task.id, intent, override: { ...override } }) : base;

  // Candidates: the used call's, plus any only the un-overridden call saw (so `from` is a candidate).
  const candidates = candidatesOf(used);
  const seen = new Set(candidates.map((c) => c.ref));
  for (const c of candidatesOf(base)) if (!seen.has(c.ref)) candidates.push(c);
  const chosenRef = (p: HarnessModelProjection) => (p.chosen ? [candidateRef(p.chosen.assistantId, p.chosen.modelId)] : []);
  const chosen = chosenRef(used);
  // A chosen ref route() did not list (a model override outside the manifest list) is still a candidate.
  for (const ref of [...chosen, ...chosenRef(base)]) if (!seen.has(ref) && !candidates.some((c) => c.ref === ref)) candidates.push({ ref });

  const stage: RawStage = {
    stage: "harness_model",
    candidates,
    filters: filtersOf(used, candidates),
    chosen,
    why: override ? overrideWhy(chosenRef(base), whyOf(used)) : whyOf(used),
    ...(override ? { override: { from: chosenRef(base), to: chosen } } : {}),
  };
  return { stage, ...(used.chosen ? { chosen: used.chosen } : {}) };
}
