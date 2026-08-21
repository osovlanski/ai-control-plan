import type {
  AgentAdapter,
  AssistantId,
  CapabilityManifest,
  NormalizedEvent,
  ProviderSessionRef,
  RunHandle,
  RunSpec,
} from "@agent-plane/core";
import { NotImplementedYetError } from "./not-implemented.js";

/**
 * OpenAI Codex adapter — Phase 1.
 * Will wrap @openai/codex-sdk: runStreamed() JSONL events, thread resume;
 * token_count.rate_limits mapped to usage.updated / limit.approaching
 * (used_percent, resets_at) — the input for Phase 2 quota failover.
 */
export class CodexAdapter implements AgentAdapter {
  constructor(readonly id: AssistantId) {}

  describe(): Promise<CapabilityManifest> {
    throw new NotImplementedYetError("CodexAdapter", "describe", "Phase 1");
  }
  start(_run: RunSpec): Promise<RunHandle> {
    throw new NotImplementedYetError("CodexAdapter", "start", "Phase 1");
  }
  resume(_ref: ProviderSessionRef, _run: RunSpec): Promise<RunHandle> {
    throw new NotImplementedYetError("CodexAdapter", "resume", "Phase 1");
  }
  events(_handle: RunHandle): AsyncIterable<NormalizedEvent> {
    throw new NotImplementedYetError("CodexAdapter", "events", "Phase 1");
  }
  cancel(_handle: RunHandle): Promise<void> {
    throw new NotImplementedYetError("CodexAdapter", "cancel", "Phase 1");
  }
}
