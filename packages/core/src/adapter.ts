import type { CapabilityManifest } from "./capabilities.js";
import type { NormalizedEvent } from "./events.js";
import type { AssistantId, ProviderSessionRef, TaskId } from "./ids.js";
import type { ModelRef } from "./capabilities.js";

/**
 * The 6-method adapter contract (revised architecture §4).
 * Checkpoint/handoff are deliberately NOT here — they are control-plane
 * functions over data the plane already owns.
 */
export interface AgentAdapter {
  readonly id: AssistantId;

  /** Full capability manifest. Called by registry sync; cached. */
  describe(): Promise<CapabilityManifest>;

  /** Start a fresh provider session for this run. */
  start(run: RunSpec): Promise<RunHandle>;

  /** Same-provider continuation. Throws NotSupportedError if !manifest.core.canResume. */
  resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle>;

  /** Normalized events, mapped in-stream by the adapter. Ends when the run ends. */
  events(handle: RunHandle): AsyncIterable<NormalizedEvent>;

  /** Mid-run user input / approval responses. Optional capability. */
  send?(handle: RunHandle, input: RunInput): Promise<void>;

  cancel(handle: RunHandle): Promise<void>;
}

export interface RunSpec {
  taskId: TaskId;
  /** Rendered from the TaskEnvelope (fresh-start or handoff template). */
  prompt: string;
  /** Task branch / worktree path the assistant works in. */
  workdir: string;
  model?: ModelRef;
  permissionPolicy: PermissionPolicy;
  env: {
    redactionRules: RedactionRule[];
    maxRuntimeMs: number;
  };
  /**
   * Execution-harness §6: the adapter installs this BEFORE any tool executes
   * (Claude: permission rules / allowed tools; Codex: sandbox + approval config;
   * fake: scripted gate). A manifest may declare `toolGating: "preventive"` only
   * if the adapter consumes this field, proven by the conformance suite.
   */
  toolPolicy?: { allow?: string[]; deny?: string[]; mode: "preventive" | "audit" };
  /** Passed to provider SDKs as an idempotency key where supported (§6, §9). */
  runControl?: { executionRequestId: string };
  /**
   * Transient launch-env secrets resolved by the Harness SecretBroker (§3)
   * immediately before start/resume. NEVER persisted, NEVER part of the request
   * fingerprint — the adapter injects these into the provider launch environment
   * and the Harness drops them right after.
   */
  secretEnv?: Record<string, string>;
}

export type PermissionPolicy =
  | { mode: "auto-approve" }
  | { mode: "prompt-on-escalation" }
  | { mode: "read-only" };

export interface RedactionRule {
  name: string;
  pattern: string; // RegExp source, applied to event summaries/payloads and rendered files
}

export interface RunHandle {
  runId: string;
  assistantId: AssistantId;
  providerSessionRef?: ProviderSessionRef;
}

export type RunInput =
  | { kind: "message"; text: string }
  | { kind: "approval"; requestId: string; approved: boolean };

export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by this adapter: ${what}`);
    this.name = "NotSupportedError";
  }
}
