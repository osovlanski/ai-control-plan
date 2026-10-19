/**
 * Builds the CompositionDecision in canonical form (plans/m2-composer.md §4.3, §4.4) and the
 * composition digest (§4.6). Stage modules return raw stages; `finalizeStage` is the one place
 * that sorts, deduplicates, bounds and guards them, so no stage can emit a decision the M1
 * validator would refuse or a string the text guard has not seen.
 */
import { jcs } from "../canonical-json.js";
import { COMPOSER_STAGES, COMPOSITION_SCHEMA_VERSION, type ComposerStage, type DecisionStage } from "../composition-types.js";
import { WITHHELD, guarded, type TextGuard } from "./text-guard.js";
import type { AgentSpecDraft, ComposerDeps, CompositionDecisionDraft } from "./types.js";

/** UTF-16 code-unit order: the contract's sort rule, independent of locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byCodeUnit);

/** Schema bounds of composition-decision.schema.json. */
const LIMITS = { candidates: 512, evidence: 16, evidenceLength: 512, filters: 64, reasonLength: 512, whyLength: 2048, chosen: 128 } as const;

export interface RawCandidate { ref: string; digest?: string; evidence?: readonly string[] }
export interface RawFilter { filter: string; removed: readonly string[]; reason: string }
export interface RawOverride { from: readonly string[]; to: readonly string[] }
export interface RawStage {
  stage: ComposerStage;
  candidates: readonly RawCandidate[];
  /** In the stage's fixed filter order. */
  filters: readonly RawFilter[];
  chosen: readonly string[];
  why: string;
  override?: RawOverride;
}

export const OVERRIDE_ACTOR = "operator";
export const OVERRIDE_REASON = "operator override";

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
export function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const nonEmpty = (text: string, fallback: string) => (text.length > 0 ? text : fallback);

export function finalizeStage(raw: RawStage, guard: TextGuard): DecisionStage {
  const byRef = new Map<string, RawCandidate>();
  for (const candidate of raw.candidates) {
    const seen = byRef.get(candidate.ref);
    // The first entry for a ref wins its digest; evidence is merged in order.
    byRef.set(candidate.ref, seen ? { ...seen, evidence: [...(seen.evidence ?? []), ...(candidate.evidence ?? [])] } : candidate);
  }
  const candidates = [...byRef.values()]
    .sort((a, b) => byCodeUnit(a.ref, b.ref))
    .slice(0, LIMITS.candidates)
    .map((c) => {
      const evidence = [...new Set((c.evidence ?? []).map((e) => bounded(guarded(guard, nonEmpty(e, WITHHELD.evidence), WITHHELD.evidence), LIMITS.evidenceLength)))]
        .slice(0, LIMITS.evidence);
      return { ref: c.ref, ...(c.digest !== undefined ? { digest: c.digest } : {}), ...(evidence.length ? { evidence } : {}) };
    });
  const known = new Set(candidates.map((c) => c.ref));
  const filters = raw.filters
    .map((f) => {
      const fallback = f.filter === "excluded_by_renderer" ? WITHHELD.rendererReason : WITHHELD.reason;
      return {
        filter: f.filter,
        removed: sortedUnique(f.removed.filter((r) => known.has(r))),
        reason: bounded(guarded(guard, nonEmpty(f.reason, fallback), fallback), LIMITS.reasonLength),
      };
    })
    .filter((f) => f.removed.length > 0)
    .slice(0, LIMITS.filters);
  const removed = new Set(filters.flatMap((f) => f.removed));
  const chosen = sortedUnique(raw.chosen).filter((r) => known.has(r) && !removed.has(r)).slice(0, LIMITS.chosen);
  return {
    stage: raw.stage,
    candidates,
    filters,
    chosen,
    why: bounded(guarded(guard, nonEmpty(raw.why, WITHHELD.why), WITHHELD.why), LIMITS.whyLength),
    override: raw.override
      ? { actor: OVERRIDE_ACTOR, from: sortedUnique(raw.override.from).filter((r) => known.has(r)), to: chosen, reason: OVERRIDE_REASON }
      : null,
  };
}

/** A stage the pipeline did not reach. */
export function notRun(stage: ComposerStage, why: string): RawStage {
  return { stage, candidates: [], filters: [], chosen: [], why };
}

/** `why` for an overridden stage (§3): what the pipeline would have chosen. */
export function overrideWhy(from: readonly string[], detail?: string): string {
  const chose = from.length ? sortedUnique(from).join(", ") : "nothing";
  return `${OVERRIDE_REASON}; pipeline chose ${chose}${detail ? `; ${detail}` : ""}`;
}

export function buildDecision(stages: readonly RawStage[], guard: TextGuard): CompositionDecisionDraft {
  const byStage = new Map(stages.map((s) => [s.stage, s]));
  return {
    schema_version: COMPOSITION_SCHEMA_VERSION,
    stages: COMPOSER_STAGES.map((stage) => finalizeStage(byStage.get(stage) ?? notRun(stage, "not run"), guard)),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** `sha256:<hex>` of `text`, through the injected hash. */
export function sha256Digest(deps: ComposerDeps, text: string): string {
  const hex = deps.sha256(text);
  if (!HEX64.test(hex)) throw new Error("composer: deps.sha256 must return 64 lowercase hex characters");
  return `sha256:${hex}`;
}

/**
 * §4.6: the digest of stages intent..policy and the spec draft. `confirm` and `workspace` are
 * excluded because they are the only parts that legitimately differ between preview and start.
 */
export function compositionDigest(decision: CompositionDecisionDraft, specDraft: AgentSpecDraft, deps: ComposerDeps): string {
  return sha256Digest(deps, jcs({ stages: decision.stages.slice(0, 5), specDraft }, "finite"));
}
