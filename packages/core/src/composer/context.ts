/**
 * Stage 4, context assembly (plans/m2-composer.md §2 stage 4). Fragments and memory bundles come
 * from config (Q5); the bundle comes from Cockpit through the BundlePort. This module plans the
 * request and writes the decision entry from the manifest Cockpit returned. Cockpit's free-text
 * reasons are untrusted: they reach the decision only through the text guard (finalizeStage).
 */
import type { BundleHarness, BundleResponse } from "../composition-types.js";
import { overrideWhy, sortedUnique, byCodeUnit, type RawCandidate, type RawFilter, type RawStage } from "./explain.js";
import type { ComposerConfig, ComposerInputs, Harness, MemoryBundlePin } from "./types.js";

export const BUNDLE_HARNESSES: readonly BundleHarness[] = ["claude-code", "codex"];
export const isBundleHarness = (harness: Harness): harness is BundleHarness => (BUNDLE_HARNESSES as readonly string[]).includes(harness);

const FRAGMENT_NAME = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const fragmentRef = (name: string) => `fragment:${name}`;
const memoryRef = (id: string) => `memory:${id}`;

/**
 * `min(composer.context.tokenBudget, floor(0.25 × max_tokens))` when a per-task token cap exists
 * (the configured cap: stage 5 and its override come later and cannot move this stage), else the
 * configured budget. Never below 1.
 */
export function effectiveTokenBudget(config: Pick<ComposerConfig, "tokenBudget" | "budget">): number {
  const cap = config.budget.max_tokens;
  return cap === undefined ? config.tokenBudget : Math.max(1, Math.min(config.tokenBudget, Math.floor(0.25 * cap)));
}

export interface ContextPlan {
  fragments: string[];
  memoryBundles: MemoryBundlePin[];
  /** The configured fragments: what the stage computes without an override. */
  computedFragments: string[];
  overridden: boolean;
  tokenBudget: number;
  charsPerToken: number;
  refused?: string;
}

export function contextPlan(inputs: ComposerInputs): ContextPlan {
  const computedFragments = sortedUnique(inputs.config.fragments);
  const memoryBundles = [...inputs.config.memoryBundles].sort((a, b) => byCodeUnit(a.id, b.id));
  const override = inputs.overrides?.context?.fragments;
  // `fragments: []` is an override (render none); an absent list is none.
  const base = { memoryBundles, computedFragments, tokenBudget: effectiveTokenBudget(inputs.config), charsPerToken: inputs.config.charsPerToken };
  if (!override) return { ...base, fragments: computedFragments, overridden: false };
  const bad = override.find((f) => !FRAGMENT_NAME.test(f));
  if (bad !== undefined) return { ...base, fragments: computedFragments, overridden: true, refused: "a context fragment override is not a fragment name" };
  return { ...base, fragments: sortedUnique(override), overridden: true };
}

function requestedCandidates(plan: ContextPlan): RawCandidate[] {
  return [
    ...sortedUnique([...plan.computedFragments, ...plan.fragments]).map((name) => ({
      ref: fragmentRef(name),
      evidence: [
        !plan.fragments.includes(name) ? "configured; removed by override" : plan.computedFragments.includes(name) ? "configured" : "requested by override",
      ],
    })),
    ...plan.memoryBundles.map((m) => ({ ref: memoryRef(m.id), digest: m.digest, evidence: ["pinned in config"] })),
  ];
}

const computedRefs = (plan: ContextPlan) => [...plan.computedFragments.map(fragmentRef), ...plan.memoryBundles.map((m) => memoryRef(m.id))];

/** The decision entry for a rendered bundle (the final one). */
export function contextStage(plan: ContextPlan, response: BundleResponse, renders: number, harness: BundleHarness, modelId: string): RawStage {
  const { manifest } = response;
  const bundleRef = `bundle:${manifest.bundleDigest}`;
  const candidates: RawCandidate[] = [
    ...requestedCandidates(plan),
    {
      ref: bundleRef, digest: manifest.bundleDigest,
      evidence: [
        `estimated ${manifest.tokens.estimated} of ${manifest.tokens.budget} tokens (${manifest.tokens.tokenMethod}, ${manifest.tokens.charsPerToken} chars/token)`,
        `compiler ${manifest.compiler.name} ${manifest.compiler.version}`,
      ],
    },
  ];
  const refOf = (kind: string, ref: string) => (kind === "fragment" ? fragmentRef(ref) : kind === "memory_bundle" ? memoryRef(ref) : undefined);
  const chosen = manifest.included.flatMap((e) => {
    const ref = refOf(e.kind, e.ref);
    return ref ? [ref] : [];
  });
  const filters: RawFilter[] = manifest.excluded
    .flatMap((e) => {
      const ref = refOf(e.kind, e.ref);
      return ref ? [{ filter: "excluded_by_renderer", removed: [ref], reason: `excluded by renderer: ${e.reason}` }] : [];
    })
    .sort((a, b) => byCodeUnit(a.removed[0]!, b.removed[0]!));
  const includedFragments = chosen.filter((r) => r.startsWith("fragment:")).length;
  const includedMemory = chosen.length - includedFragments;
  const skills = manifest.included.filter((e) => e.kind === "skill").length;
  const why = [
    `rendered bundle for ${harness} ${modelId}: ${includedFragments} of ${plan.fragments.length} fragments, ${includedMemory} of ${plan.memoryBundles.length} memory bundles and ${skills} skills included`,
    ...(renders > 1 ? ["second render, after the renderer excluded a selected skill"] : []),
  ].join("; ");
  return {
    stage: "context", candidates, filters, chosen,
    why: plan.overridden ? overrideWhy(computedRefs(plan), why) : why,
    ...(plan.overridden ? { override: { from: computedRefs(plan), to: chosen } } : {}),
  };
}

/** The decision entry when no bundle exists: `chosen: []` with the reason. */
export function contextFailureStage(plan: ContextPlan, why: string): RawStage {
  return { stage: "context", candidates: requestedCandidates(plan), filters: [], chosen: [], why };
}
