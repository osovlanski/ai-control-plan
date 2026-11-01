/**
 * M6 asset telemetry (docs/agentic-os-m6-composition-telemetry.md §1–§2): for one settled,
 * revision-bound session, one row per asset its revision selected, recording five separate facts —
 * selected, attached, validated, invoked, outcome — and never that an asset caused the outcome
 * (risk 11). Pure: no clock, environment, locale or I/O; hashing is injected. Every input is final
 * once the session is terminal, so a re-derivation is byte-equal and its keys are stable.
 *
 * S1 observes no invocations: every row is `not_observable` with NULL counts. S2 adds tool events.
 */

import { jcs } from "./canonical-json.js";
import type { AgentSpec, BundleManifest, InputKind } from "./composition-types.js";
import { reliabilityClass, type ExecutionResult, type ReliabilityClass } from "./execution.js";
import {
  mcpServerName,
  type ProfileRuntimeEvidence,
  type ProvisioningAmbientPayload,
  type ProvisioningFidelity,
  type ProvisioningVerifiedPayload,
} from "./provisioning.js";

export const ASSET_USAGE_DERIVER_VERSION = 1;
export const ASSET_USAGE_ATTRIBUTION = "co-occurrence/v1";

export type AssetUsageKind = "skill" | "mcp_server" | "memory_bundle" | "fragment";
/** Provider-side evidence the asset loaded, strongest first. `none` = not attached. */
export type AssetValidation = "runtime_confirmed" | "runtime_pending" | "rendered" | "files_verified" | "failed" | "none";
export type AssetInvocationMethod = "tool_event" | "not_applicable" | "not_observable";
export type AssetSessionOutcome = ReliabilityClass | "not_run";

/** A fragment the bundle left out has no rendered digest; its row carries this one instead. */
export const EXCLUDED_FRAGMENT_DIGEST = "excluded";

/** The slice of a stored event the deriver reads: provisioning and the provider's `run.started`. */
export interface AssetUsageEvent {
  type: string;
  payload?: unknown;
  raw?: unknown;
}

export interface AssetUsageInput {
  spec: AgentSpec;
  bundleManifest: BundleManifest;
  sessionId: string;
  taskId: string;
  /** The session's events in seq order. Only `provisioning.*` and the first `run.started` are read. */
  events: readonly AssetUsageEvent[];
  result: Pick<ExecutionResult, "outcome" | "yield" | "verification">;
  /** `execution_results.at`: every row's `at`, never the clock. */
  resultAt: string;
  /** `runs.provider_start_acked`: false means the provider never ran (`not_run`). */
  startAcked: boolean;
}

export interface AssetUsageDeps {
  /** 64 lowercase hex characters of sha256 over the UTF-8 text. */
  sha256(text: string): string;
}

export interface AssetUsageRow {
  eventId: string;
  compositionRevisionId: string;
  sessionId: string;
  taskId: string;
  assetKind: AssetUsageKind;
  assetId: string;
  assetDigest: string;
  harness: string;
  fidelity: ProvisioningFidelity;
  attached: boolean;
  validation: AssetValidation;
  invocationMethod: AssetInvocationMethod;
  /** NULL = not observable, which is not 0. */
  invocationCount: number | null;
  invocationFailed: number | null;
  sessionOutcome: AssetSessionOutcome;
  /** The session's verification: NULL when no check ran. */
  verificationPassed: boolean | null;
  attributionMethod: string;
  deriverVersion: number;
  /** `sha256:` over JCS of every field but `eventId` (and the store's `ingest_seq`). */
  bodyDigest: string;
  at: string;
}

/** The projection ledger row: a session with zero assets is projected too. */
export interface AssetUsageSession {
  sessionId: string;
  compositionRevisionId: string;
  rows: number;
  deriverVersion: number;
  bodyDigest: string;
  at: string;
}

export interface AssetUsageDerivation {
  rows: AssetUsageRow[];
  session: AssetUsageSession;
}

const KIND_ORDER: Record<AssetUsageKind, number> = { skill: 0, mcp_server: 1, memory_bundle: 2, fragment: 3 };
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const HEX64 = /^[0-9a-f]{64}$/;

function hex(deps: AssetUsageDeps, text: string): string {
  const h = deps.sha256(text);
  if (!HEX64.test(h)) throw new Error("asset telemetry: deps.sha256 must return 64 lowercase hex characters");
  return h;
}

/** The ledger key: the same session and asset give the same id on every derivation. */
export function assetUsageEventId(
  key: { revision: string; session: string; kind: AssetUsageKind; id: string; digest: string },
  deps: AssetUsageDeps,
): string {
  return `au1_${hex(deps, jcs({ v: 1, ...key }, "integer"))}`;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** What the session's events say about its profile and the provider's startup report. */
function readEvents(events: readonly AssetUsageEvent[]): {
  verified?: ProvisioningVerifiedPayload;
  ambient?: ProvisioningAmbientPayload;
  started?: { evidence?: ProfileRuntimeEvidence; mcpStatus: Map<string, string> };
} {
  let verified: ProvisioningVerifiedPayload | undefined;
  let ambient: ProvisioningAmbientPayload | undefined;
  let started: { evidence?: ProfileRuntimeEvidence; mcpStatus: Map<string, string> } | undefined;
  for (const e of events) {
    if (e.type === "provisioning.verified" && !verified) verified = e.payload as ProvisioningVerifiedPayload;
    else if (e.type === "provisioning.ambient" && !ambient) ambient = e.payload as ProvisioningAmbientPayload;
    else if (e.type === "run.started" && !started) {
      const evidence = record(e.payload)?.profileEvidence as ProfileRuntimeEvidence | undefined;
      // Claude's system/init lists each MCP server with its status; names only are read.
      const servers = record(e.raw)?.mcp_servers;
      const mcpStatus = new Map<string, string>();
      if (Array.isArray(servers)) {
        for (const s of servers) {
          const r = record(s);
          if (typeof r?.name === "string" && typeof r.status === "string") mcpStatus.set(r.name, r.status);
        }
      }
      started = { ...(evidence ? { evidence } : {}), mcpStatus };
    }
  }
  return { ...(verified ? { verified } : {}), ...(ambient ? { ambient } : {}), ...(started ? { started } : {}) };
}

function verificationPassed(v: AssetUsageInput["result"]["verification"]): boolean | null {
  if (!v) return null;
  const ran = v.checks.some((c) => c.status !== "skipped");
  return ran ? v.passed : null;
}

/**
 * Derive one session's rows. Selected = the revision lists it. Attached = it is in the session's
 * verified profile (never for an ambient session). Validation reads the S5a judge for `full`, the
 * opt-in S5b probe checks for `partial`, and the verified files otherwise.
 */
export function deriveAssetUsage(input: AssetUsageInput, deps: AssetUsageDeps): AssetUsageDerivation {
  const { spec, bundleManifest: manifest } = input;
  const revision = spec.composition_revision_id;
  const { verified, started } = readEvents(input.events);
  const fidelity: ProvisioningFidelity = verified?.fidelity ?? "none";
  const profiled = fidelity !== "none";

  const included = (kind: InputKind, ref: string, digest?: string) =>
    manifest.included.some((i) => i.kind === kind && i.ref === ref && (digest === undefined || i.digest === digest));

  // S5a: a `full` profile's first `run.started` carries the judged inventory. Absent or not ok for
  // this digest is a failed validation; the session then never reached the provider.
  const judged = fidelity === "full" && started !== undefined;
  const evidence = started?.evidence;
  const judgeFailed = judged && (!evidence || !evidence.ok || evidence.profileDigest !== verified?.profileDigest);
  const probeChecks = verified?.checks.filter((c) => c.name.startsWith("prompt_input_")) ?? [];
  const rendered = fidelity === "partial" && probeChecks.length > 0 && probeChecks.every((c) => c.ok);

  const validationOf = (kind: AssetUsageKind, attached: boolean, assetId: string): AssetValidation => {
    if (!attached) return "none";
    if (judgeFailed) return "failed";
    if (fidelity === "full" && judged) {
      if (kind === "skill") return "runtime_confirmed";
      if (kind === "mcp_server") {
        // `pending` passes the judge; only a server Claude reported `connected` is confirmed.
        return started!.mcpStatus.get(mcpServerName(assetId)) === "connected" ? "runtime_confirmed" : "runtime_pending";
      }
      return "files_verified"; // CLAUDE.md is appended to the prompt; init does not report it
    }
    if (rendered && (kind === "fragment" || kind === "memory_bundle")) return "rendered";
    return "files_verified";
  };

  const sessionOutcome: AssetSessionOutcome = input.startAcked ? reliabilityClass(input.result) : "not_run";
  const passed = verificationPassed(input.result.verification);

  const selected: Array<{ kind: AssetUsageKind; id: string; digest: string; attached: boolean }> = [
    ...spec.assets.skills.map((a) => ({ kind: "skill" as const, id: a.id, digest: a.digest, attached: profiled && included("skill", a.id, a.digest) })),
    // prepare refuses a server it cannot launch rather than drop it, so a verified profile carries every one.
    ...spec.assets.mcp_servers.map((a) => ({ kind: "mcp_server" as const, id: a.id, digest: a.digest, attached: profiled })),
    ...spec.context.memory_bundles.map((m) => ({ kind: "memory_bundle" as const, id: m.id, digest: m.digest, attached: profiled && included("memory_bundle", m.id, m.digest) })),
    ...spec.context.fragments.map((name) => {
      const hit = manifest.included.find((i) => i.kind === "fragment" && i.ref === name);
      return { kind: "fragment" as const, id: name, digest: hit?.digest ?? EXCLUDED_FRAGMENT_DIGEST, attached: profiled && hit !== undefined };
    }),
  ];

  const seen = new Set<string>();
  const rows: AssetUsageRow[] = [];
  for (const a of selected) {
    const eventId = assetUsageEventId({ revision, session: input.sessionId, kind: a.kind, id: a.id, digest: a.digest }, deps);
    if (seen.has(eventId)) continue; // a revision lists an asset once; the key enforces it
    seen.add(eventId);
    const body = {
      compositionRevisionId: revision,
      sessionId: input.sessionId,
      taskId: input.taskId,
      assetKind: a.kind,
      assetId: a.id,
      assetDigest: a.digest,
      harness: spec.harness,
      fidelity,
      attached: a.attached,
      validation: validationOf(a.kind, a.attached, a.id),
      invocationMethod: "not_observable" as const,
      invocationCount: null,
      invocationFailed: null,
      sessionOutcome,
      verificationPassed: passed,
      attributionMethod: ASSET_USAGE_ATTRIBUTION,
      deriverVersion: ASSET_USAGE_DERIVER_VERSION,
      at: input.resultAt,
    };
    rows.push({ eventId, ...body, bodyDigest: `sha256:${hex(deps, jcs(body, "integer"))}` });
  }
  rows.sort((x, y) => KIND_ORDER[x.assetKind] - KIND_ORDER[y.assetKind] || byCodeUnit(x.assetId, y.assetId) || byCodeUnit(x.assetDigest, y.assetDigest));

  const sessionBody = {
    sessionId: input.sessionId,
    compositionRevisionId: revision,
    rows: rows.length,
    deriverVersion: ASSET_USAGE_DERIVER_VERSION,
    events: rows.map((r) => [r.eventId, r.bodyDigest]),
    at: input.resultAt,
  };
  return {
    rows,
    session: {
      sessionId: input.sessionId,
      compositionRevisionId: revision,
      rows: rows.length,
      deriverVersion: ASSET_USAGE_DERIVER_VERSION,
      bodyDigest: `sha256:${hex(deps, jcs(sessionBody, "integer"))}`,
      at: input.resultAt,
    },
  };
}
