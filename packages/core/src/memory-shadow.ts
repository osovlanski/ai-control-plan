/**
 * O6 S3 memory shadow rule, `memory-shadow/v1` (docs/agentic-os-o6-memory-writeback.md §2.2, Q3).
 *
 * Pure, under the Composer purity lint rule: no clock, no env, no I/O. Cockpit computes health at
 * the snapshot's `observedAt` (a member is stale past the Garden's `staleDays`, 180 by default,
 * aged from frontmatter `metadata.modified` before file mtime); this module only reads the counts.
 *
 * Per pinned memory bundle, in id order:
 *   - no snapshot, or the bundle is not in it: `unknown`;
 *   - the snapshot's digest differs from the pin: `drifted` (health is still shown);
 *   - at least half the members stale (`2 · staleMembers ≥ members`, members > 0): `demote`;
 *   - otherwise `keep`.
 * Duplicates, ghosts and oversized members are named in the reason and never demote.
 *
 * Nothing here enters a decision, a spec, `compositionDigest` or `inputs_digest`: the api calls it
 * only after the attempt row exists, and only logs what it says. Production selection is unchanged.
 */
import type { CompositionDecisionDraft, ComposerOutcome } from "./composer/types.js";
import { byCodeUnit } from "./composer/explain.js";

export const MEMORY_SHADOW_RULE = "memory-shadow/v1";
/** Q3: demote when at least this share of a bundle's members is stale. Compared in integers. */
export const MEMORY_SHADOW_DEMOTE_RATIO = 0.5;

export type MemoryShadowAction = "keep" | "demote" | "unknown" | "drifted";
/** What stage 4 did with the pin in production: read from the decision, never changed here. */
export type MemoryProductionAction = "included" | "excluded_by_renderer" | "not_found" | "not_rendered";

export interface MemoryShadowHealth {
  members: number;
  staleMembers: number;
  oldestAgeDays: number | null;
  duplicatePairs: number;
  ghosts: number;
  oversized: number;
  findingsDigest: string;
}
export interface MemoryShadowBundle { id: string; digest: string; health: MemoryShadowHealth }
/** The part of a validated memory v1 snapshot the rule reads. */
export interface MemoryShadowSnapshot { snapshotDigest: string; observedAt: string; bundles: readonly MemoryShadowBundle[] }
export interface MemoryShadowPin { id: string; digest: string }

export interface MemoryShadowVerdict {
  bundleId: string;
  pinnedDigest: string;
  /** The bundle's digest in the snapshot; null when it is not there. */
  snapshotBundleDigest: string | null;
  action: MemoryShadowAction;
  reason: string;
  health: MemoryShadowHealth | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (digest: string) => `${digest.slice(0, "sha256:".length + 12)}…`;

function healthText(h: MemoryShadowHealth): string {
  const oldest = h.oldestAgeDays === null ? "" : `, oldest ${h.oldestAgeDays}d`;
  return `${h.staleMembers} of ${plural(h.members, "member")} stale${oldest}`;
}

/** Findings the Garden reports on members that Q3 shows but never demotes on. */
function shownText(h: MemoryShadowHealth): string {
  const shown = [
    ...(h.duplicatePairs ? [plural(h.duplicatePairs, "duplicate pair")] : []),
    ...(h.ghosts ? [plural(h.ghosts, "ghost")] : []),
    ...(h.oversized ? [`${h.oversized} oversized`] : []),
  ];
  return shown.length ? `; shown, not demoting: ${shown.join(", ")}` : "";
}

/** True when at least half the members are stale. An empty bundle is never demoted. */
export const wouldDemote = (h: Pick<MemoryShadowHealth, "members" | "staleMembers">): boolean => h.members > 0 && 2 * h.staleMembers >= h.members;

/** The rule for one pin. `snapshot` null means the plane has never held a valid snapshot. */
export function memoryShadowVerdict(pin: MemoryShadowPin, snapshot: MemoryShadowSnapshot | null): MemoryShadowVerdict {
  const base = { bundleId: pin.id, pinnedDigest: pin.digest };
  if (!snapshot) return { ...base, snapshotBundleDigest: null, action: "unknown", reason: "unknown: no memory snapshot from Cockpit yet", health: null };
  const bundle = snapshot.bundles.find((b) => b.id === pin.id);
  if (!bundle) return { ...base, snapshotBundleDigest: null, action: "unknown", reason: "unknown: not in the memory snapshot", health: null };
  const h = bundle.health;
  const out = { ...base, snapshotBundleDigest: bundle.digest, health: { ...h } };
  if (bundle.digest !== pin.digest) {
    return { ...out, action: "drifted", reason: `drifted: pinned ${short(pin.digest)}, snapshot ${short(bundle.digest)}; ${healthText(h)}${shownText(h)}` };
  }
  if (h.members === 0) return { ...out, action: "keep", reason: "keep: no members" };
  if (wouldDemote(h)) return { ...out, action: "demote", reason: `stale: ${h.staleMembers} of ${plural(h.members, "member")}${h.oldestAgeDays === null ? "" : `, oldest ${h.oldestAgeDays}d`}${shownText(h)}` };
  return { ...out, action: "keep", reason: `keep: ${healthText(h)}${shownText(h)}` };
}

/** The rule for every pin, in id order (code units). */
export function memoryShadow(pins: readonly MemoryShadowPin[], snapshot: MemoryShadowSnapshot | null): MemoryShadowVerdict[] {
  return [...pins].sort((a, b) => byCodeUnit(a.id, b.id)).map((p) => memoryShadowVerdict(p, snapshot));
}

export interface MemoryProduction {
  id: string;
  digest: string;
  action: MemoryProductionAction;
  /** Why it was not rendered: the composer outcome's reason, or null. */
  reason: string | null;
}

const MEMORY_REF = "memory:";

/**
 * The memory bundles stage 4 handled, read back from its decision entry, with what production did
 * to each. Empty when nothing was pinned or the pipeline stopped before stage 4 (a `not run`
 * context stage has no candidates).
 */
export function memoryProduction(decision: CompositionDecisionDraft, outcome: ComposerOutcome): MemoryProduction[] {
  const context = decision.stages.find((s) => s.stage === "context");
  if (!context) return [];
  const pins = context.candidates.filter((c) => c.ref.startsWith(MEMORY_REF) && typeof c.digest === "string");
  return pins
    .map((c): MemoryProduction => {
      const id = c.ref.slice(MEMORY_REF.length);
      if (context.chosen.includes(c.ref)) return { id, digest: c.digest!, action: "included", reason: null };
      if (context.filters.some((f) => f.filter === "excluded_by_renderer" && f.removed.includes(c.ref))) {
        return { id, digest: c.digest!, action: "excluded_by_renderer", reason: null };
      }
      if (outcome.status !== "composed" && outcome.reason === "not_found") return { id, digest: c.digest!, action: "not_found", reason: "not_found" };
      return { id, digest: c.digest!, action: "not_rendered", reason: outcome.status === "composed" ? "not in the rendered manifest" : outcome.reason };
    })
    .sort((a, b) => byCodeUnit(a.id, b.id));
}
