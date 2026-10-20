import type { CapabilityManifest } from "./capabilities.js";
import type { AdapterContextSample } from "./context.js";
import type { NormalizedEvent } from "./events.js";
import type { AssistantId, ProviderSessionRef, TaskId } from "./ids.js";
import type { ModelRef } from "./capabilities.js";
import type { ProvisionedProfile, ProvisioningInput, ProvisioningPlan, ProvisioningVerification, VerifiedProfile } from "./provisioning.js";

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

  /**
   * Capability-gated context observation (M14 K9). Implemented ONLY by an
   * adapter with a real provider mechanism (Claude via the Agent SDK's
   * `getContextUsage`). Returns `null` when momentarily unavailable — the
   * Harness then records no observation rather than a fabricated one. K9 adds no
   * `compact` counterpart; that arrives capability-gated in K10.
   */
  observeContext?(handle: RunHandle): Promise<AdapterContextSample | null>;

  /**
   * The local OS process behind a run, once spawned. The kernel reads its
   * liveness to renew a session's lease before the first provider event, and
   * signals its tree when the session is fenced or orphaned. Undefined =
   * not spawned yet, already reaped, or an adapter with no local process.
   */
  providerProcess?(handle: RunHandle): ProviderProcess | undefined;

  cancel(handle: RunHandle): Promise<void>;

  /**
   * M3 provisioning lifecycle (plan §3.4). All four or none. The plane calls them in order for a
   * revision-bound run, before `start`, and `dispose` once the session has ended.
   *
   * `prepare` computes an inspectable plan and writes nothing; it throws `ProvisioningError` when
   * the revision cannot be provisioned here (another harness, an asset it cannot deliver).
   */
  prepare?(input: ProvisioningInput): Promise<ProvisioningPlan>;
  /** Atomically materialize the plan under its root, with an ownership marker. Idempotent for the same plan. */
  provision?(plan: ProvisioningPlan): Promise<ProvisionedProfile>;
  /** Prove the profile on disk is exactly the plan, before `start`. Never throws for a failed check. */
  verify?(profile: ProvisionedProfile): Promise<ProvisioningVerification>;
  /** Remove the profile. Idempotent; refuses a directory it does not own. */
  dispose?(profile: ProvisionedProfile): Promise<{ removed: boolean }>;
}

export interface ProviderProcess {
  pid: number;
  /** ISO time the adapter spawned it. */
  spawnedAt: string;
  alive(): boolean;
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
  /**
   * M3: the verified per-run profile this launch must use, deep-frozen. Set by the plane after
   * `verify`, never part of the request fingerprint. An adapter given a profile for another
   * harness refuses to start rather than launch against it (risk 9).
   */
  profile?: VerifiedProfile;
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
