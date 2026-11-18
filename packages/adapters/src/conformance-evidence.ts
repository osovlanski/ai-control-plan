/**
 * What the in-tree adapter conformance suite (`test/conformance/`) proves, per provider
 * (Agent Runtime Registry design §D, PR 4). Data only.
 *
 * A manifest's `harness` block is a set of claims. A claim is honest only when a check backs it:
 *
 * - `unit` claims are proven by the conformance suite against a scripted provider (a fake, a stub
 *   binary or a scripted SDK stream). The suite fails if an adapter declares a unit claim that is
 *   not listed for its provider here, and it runs a check for every claim that is listed.
 * - `host` claims (process isolation, the agent Unix user) depend on the machine. A mocked test can
 *   show the launch path, never the boundary, so the suite never lists them as proven. They need
 *   host evidence (a bounded escape probe or a `run-as-agent` launch on the reference host), which
 *   the runtime conformance probe does not run.
 */
import type { CapabilityManifest } from "@agent-plane/core";

export type HarnessClaim =
  | "toolGating:preventive"
  | "approvalRelay"
  | "usageAccounting:cumulative"
  | "usageAccounting:delta"
  | "processIsolation:os-sandbox"
  | "processIsolation:provider-sandbox"
  | "agentUser";

/** Claims whose guarantee is a property of the host, not of the adapter's code. */
export const HOST_LEVEL_CLAIMS: readonly HarnessClaim[] = Object.freeze([
  "processIsolation:os-sandbox",
  "processIsolation:provider-sandbox",
  "agentUser",
]);

/**
 * Unit claims the conformance suite proves, per workspace `provider`. A provider absent here has
 * none proven. Every entry has a check in `test/conformance/`.
 */
export const UNIT_PROVEN_CLAIMS: Readonly<Record<string, readonly HarnessClaim[]>> = Object.freeze({
  // A relayed deny reaches the SDK's permission callback as `deny`; the run's `result` totals
  // reconcile with the counted usage.
  anthropic: Object.freeze(["approvalRelay", "usageAccounting:cumulative"] as HarnessClaim[]),
  // SDK path: one `turn.completed` total per run (the app-server transport declares `none`).
  openai: Object.freeze(["usageAccounting:cumulative"] as HarnessClaim[]),
  openrouter: Object.freeze(["usageAccounting:cumulative"] as HarnessClaim[]),
  cursor: Object.freeze([] as HarnessClaim[]),
  bedrock: Object.freeze([] as HarnessClaim[]),
  fake: Object.freeze(["approvalRelay", "usageAccounting:cumulative"] as HarnessClaim[]),
});

/** The claims a manifest's `harness` block makes. An absent block claims nothing (least-capable defaults). */
export function harnessClaims(manifest: Pick<CapabilityManifest, "harness">): HarnessClaim[] {
  const h = manifest.harness;
  if (!h) return [];
  const claims: HarnessClaim[] = [];
  if (h.toolGating === "preventive") claims.push("toolGating:preventive");
  if (h.approvalRelay === true) claims.push("approvalRelay");
  if (h.usageAccounting === "cumulative" || h.usageAccounting === "delta") claims.push(`usageAccounting:${h.usageAccounting}`);
  if (h.processIsolation === "os-sandbox" || h.processIsolation === "provider-sandbox") claims.push(`processIsolation:${h.processIsolation}`);
  if (h.agentUser === true) claims.push("agentUser");
  return claims;
}

/** Splits a manifest's claims into proven unit claims, unproven unit claims and host claims. */
export function classifyClaims(provider: string, manifest: Pick<CapabilityManifest, "harness">): {
  provenUnit: HarnessClaim[];
  unprovenUnit: HarnessClaim[];
  host: HarnessClaim[];
} {
  const proven = new Set(UNIT_PROVEN_CLAIMS[provider] ?? []);
  const out = { provenUnit: [] as HarnessClaim[], unprovenUnit: [] as HarnessClaim[], host: [] as HarnessClaim[] };
  for (const claim of harnessClaims(manifest)) {
    if (HOST_LEVEL_CLAIMS.includes(claim)) out.host.push(claim);
    else if (proven.has(claim)) out.provenUnit.push(claim);
    else out.unprovenUnit.push(claim);
  }
  return out;
}
