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
 * Claude Code adapter — Phase 1.
 * Will wrap the Claude Agent SDK (TypeScript): query() streaming, session
 * resume, permission modes; usage/limit events mapped from SDK messages.
 */
export class ClaudeAdapter implements AgentAdapter {
  constructor(readonly id: AssistantId) {}

  describe(): Promise<CapabilityManifest> {
    throw new NotImplementedYetError("ClaudeAdapter", "describe", "Phase 1");
  }
  start(_run: RunSpec): Promise<RunHandle> {
    throw new NotImplementedYetError("ClaudeAdapter", "start", "Phase 1");
  }
  resume(_ref: ProviderSessionRef, _run: RunSpec): Promise<RunHandle> {
    throw new NotImplementedYetError("ClaudeAdapter", "resume", "Phase 1");
  }
  events(_handle: RunHandle): AsyncIterable<NormalizedEvent> {
    throw new NotImplementedYetError("ClaudeAdapter", "events", "Phase 1");
  }
  cancel(_handle: RunHandle): Promise<void> {
    throw new NotImplementedYetError("ClaudeAdapter", "cancel", "Phase 1");
  }
}
