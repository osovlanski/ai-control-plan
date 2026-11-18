/**
 * The runtime catalogue: one static, typed, in-tree entry per provider the plane can construct an
 * adapter for (Agent Runtime Registry design, PR 1).
 *
 * This is NOT a plugin system. The catalogue is a frozen array literal; a runtime is added by a
 * reviewed PR that adds an adapter class and one descriptor here. Nothing is registered at runtime,
 * nothing is imported from a path or package name taken from configuration, and no executable path
 * is read from here. Adapters still author their own capability manifests through `describe()`;
 * a descriptor only says which class to build and restates three facts the composer already holds
 * (`harnessForProvider`, `REGISTRY_ASSISTANT`, `HARNESS_APPROVAL_MODES`). Drift tests in
 * `test/runtime-catalog.test.ts` pin those copies to each other until a later PR removes them.
 */
import type { AgentAdapter, ApprovalMode, AssistantId, Harness } from "@agent-plane/core";
import {
  BedrockAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  FakeAdapter,
  OpenRouterCodexAdapter,
  type AgentLauncher,
  type BedrockOptions,
  type ClaudeLaunchProfile,
  type CursorOptions,
  type FakeOptions,
  type OpenRouterOptions,
} from "@agent-plane/adapters";

/** Exactly what the adapter switch received besides the assistant id and its options. */
export interface AdapterContext {
  readonly sessionInputEnabled: boolean;
  readonly providerProfile?: ClaudeLaunchProfile;
  readonly agentLauncher?: AgentLauncher;
}

export interface RuntimeDescriptor {
  /** Version of this interface (not a wire contract). A breaking change bumps every entry. */
  readonly descriptorVersion: 1;
  /** Workspace config `assistants.<id>.provider`. */
  readonly provider: string;
  readonly label: string;
  /** Composition vocabulary. Absent: routable, never composed (the fake's harness is a per-instance test option). */
  readonly harness?: Harness;
  /** Registry v1 `compatibility.assistants` id for the harness, where one exists. */
  readonly registryAssistant?: string;
  /** Approval modes the adapter accepts; it refuses the rest before a process starts. */
  readonly approvalModes: readonly ApprovalMode[];
  /** `scaffold`: the event mapping is not proven against a pinned CLI (the adapter says `providerDetail.mappingVerified: false`). */
  readonly maturity: "verified" | "scaffold";
  create(ctx: AdapterContext, id: AssistantId, options: Record<string, unknown>): AgentAdapter;
}

const ALL_MODES: readonly ApprovalMode[] = Object.freeze(["auto-approve", "prompt-on-escalation", "read-only"]);

const descriptor = (d: RuntimeDescriptor): RuntimeDescriptor =>
  Object.freeze({ ...d, approvalModes: Object.freeze([...d.approvalModes]) });

/**
 * In the order the unknown-provider error has always listed them. Each `create` body is the
 * corresponding case of the former `createAdapter` switch in `registry.ts`, unchanged.
 */
export const RUNTIME_CATALOG: readonly RuntimeDescriptor[] = Object.freeze([
  descriptor({
    descriptorVersion: 1, provider: "anthropic", label: "Claude Code", harness: "claude-code", registryAssistant: "claude",
    approvalModes: ALL_MODES, maturity: "verified",
    create: (ctx, id) => new ClaudeAdapter(id, undefined, {
      liveInput: ctx.sessionInputEnabled,
      ...(ctx.providerProfile ? { profile: ctx.providerProfile } : {}),
      ...(ctx.agentLauncher ? { agentLauncher: ctx.agentLauncher } : {}),
    }),
  }),
  descriptor({
    descriptorVersion: 1, provider: "openai", label: "Codex", harness: "codex", registryAssistant: "codex",
    approvalModes: ["auto-approve", "read-only"], maturity: "verified",
    create: (ctx, id, options) => new CodexAdapter(id, { appServerInput: ctx.sessionInputEnabled && options.appServerInput === true }),
  }),
  descriptor({
    descriptorVersion: 1, provider: "openrouter", label: "Codex via OpenRouter", harness: "codex", registryAssistant: "codex",
    approvalModes: ["auto-approve", "read-only"], maturity: "verified",
    create: (_ctx, id, options) => new OpenRouterCodexAdapter(id, options as OpenRouterOptions),
  }),
  descriptor({
    descriptorVersion: 1, provider: "cursor", label: "Cursor CLI", harness: "cursor", registryAssistant: "cursor",
    approvalModes: ["auto-approve"], maturity: "scaffold",
    create: (_ctx, id, options) => new CursorAdapter(id, options as CursorOptions),
  }),
  descriptor({
    descriptorVersion: 1, provider: "bedrock", label: "Bedrock AgentCore", harness: "bedrock",
    // Tools run remotely and the adapter enforces no mode; claiming one would be false.
    approvalModes: [], maturity: "verified",
    // Bedrock hosts YOUR agent: the runtime ARN is configuration, not
    // something the plane can discover (review §2.4).
    create: (_ctx, id, options) => new BedrockAdapter(id, options as BedrockOptions),
  }),
  descriptor({
    descriptorVersion: 1, provider: "fake", label: "Fake (tests)",
    // Test-only: accepts every mode and enforces none; its harness is `options.harness`.
    approvalModes: ALL_MODES, maturity: "verified",
    create: (_ctx, id, options) => new FakeAdapter(id, undefined, options as FakeOptions),
  }),
]);

/** The descriptor for a workspace `provider`, or `undefined` when this build has none. */
export function runtimeFor(provider: string): RuntimeDescriptor | undefined {
  return RUNTIME_CATALOG.find((d) => d.provider === provider);
}

/** Catalogued providers, in catalogue order. */
export function supportedProviders(): string[] {
  return RUNTIME_CATALOG.map((d) => d.provider);
}

/** Builds the adapter for one configured assistant; an unknown provider throws the text it always has. */
export function createAdapter(
  id: AssistantId,
  provider: string,
  options: Record<string, unknown>,
  ctx: AdapterContext,
): AgentAdapter {
  const runtime = runtimeFor(provider);
  if (!runtime) {
    throw new Error(`Unsupported provider "${provider}" for assistant ${id} (supported: ${supportedProviders().join(", ")})`);
  }
  return runtime.create(ctx, id, options);
}
