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
  /** Provider-specific detail: skills/plugins (Claude), sandbox (Codex), rules (Cursor), deployed agents (Bedrock). */
  providerDetail: Record<string, unknown>;
  evidence: {
    source: EvidenceSource;
    observedAt: string;
  };
}
