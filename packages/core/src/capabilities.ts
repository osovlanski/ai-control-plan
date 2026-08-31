import type { AssistantId } from "./ids.js";

export type TriState = "yes" | "no" | "unknown";

export type EvidenceSource = "runtime-probe" | "provider-api" | "local-config" | "manual";

/** Deterministic conflict resolution: higher wins (review §3.4 — no confidence numbers). */
export const EVIDENCE_PRIORITY: Record<EvidenceSource, number> = {
  "runtime-probe": 4,
  "provider-api": 3,
  "local-config": 2,
  manual: 1,
};

export interface ModelRef {
  id: string;
  displayName?: string;
}

export interface QuotaWindowState {
  window: string; // e.g. "5h", "weekly", "monthly-credit"
  usedPercent: number;
  resetsAt?: string;
  source: EvidenceSource;
  observedAt: string;
}

/**
 * Capability manifest returned by AgentAdapter.describe().
 * `core` is what the router reads — uniform across providers.
 * `provider` is a provider-shaped bag rendered only by the catalog UI.
 */
export interface CapabilityManifest {
  assistantId: AssistantId;
  provider: string; // "anthropic" | "openai" | "cursor" | "bedrock" | ...
  core: {
    models: ModelRef[];
    canResume: boolean;
    canMcp: boolean;
    supportsMidRunInput: boolean;
    reportsUsage: boolean;
    reportsLimits: boolean;
    execution: {
      shell: boolean;
      filesystem: boolean;
      web: TriState;
    };
    auth: {
      state: "ok" | "expired" | "missing";
      account?: string;
    };
    /** Best-effort pre-routing quota view; refreshed continuously from run events. */
    limits?: QuotaWindowState[];
  };
  /**
   * Execution-harness capability declarations (execution-harness §6). Optional:
   * when absent the Harness assumes the least-capable defaults (accounting
   * "none", `toolGating` "none", `processIsolation` "none", `approvalRelay`
   * derived from `adapter.send`). A claim here is only honest once the adapter
   * conformance suite (§12) proves the callable behavior behind it — until then
   * Prepare rejects policies that would rely on it.
   */
  harness?: {
    usageAccounting: "delta" | "cumulative" | "none";
    /** Quantitative usage-reporting contract — required for bounded budget enforcement (§2). */
    usageReporting?: {
      cadence: "per-message" | { periodicMs: number };
      maxUnreportedTokens: number;
    };
    toolGating: "preventive" | "none";
    approvalRelay: boolean;
    /**
     * The provider exposes a queryable acknowledgement for a relayed approval, so
     * a `delivery_unknown` recovery can probe and settle it deterministically (§4).
     */
    approvalAckLookup?: boolean;
    /**
     * The conformance suite has proven that re-sending the SAME
     * `provider_request_id` answer is accepted-or-no-op for this adapter, so a
     * `delivery_unknown` recovery may safely re-deliver (§4).
     */
    approvalIdempotentRedelivery?: boolean;
    processIsolation: "os-sandbox" | "provider-sandbox" | "none";
    provisioningContractVersion?: string;
  };
  /** Provider-specific detail: skills/plugins (Claude), sandbox (Codex), rules (Cursor), deployed agents (Bedrock). */
  providerDetail: Record<string, unknown>;
  evidence: {
    source: EvidenceSource;
    observedAt: string;
  };
}
