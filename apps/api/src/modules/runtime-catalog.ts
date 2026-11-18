/**
 * The runtime catalogue: one static, typed, in-tree entry per provider the plane can construct an
 * adapter for (Agent Runtime Registry design, PRs 1 and 2).
 *
 * This is NOT a plugin system. The catalogue is a frozen array literal; a runtime is added by a
 * reviewed PR that adds an adapter class, one row in core `RUNTIME_KINDS` and one descriptor here.
 * Nothing is registered at runtime, nothing is imported from a path or package name taken from
 * configuration, and no executable path is read from here. Adapters still author their own
 * capability manifests through `describe()`.
 *
 * Each descriptor extends its core `RuntimeKind` row (provider, harness, registry vocabulary,
 * approval modes, option types), which the composer's maps are derived from, with what only the
 * API can hold: the adapter constructor, the cheap capability-probe inputs, the idle quota probe
 * and the session-input binding.
 */
import { runtimeKindFor, type AgentAdapter, type AssistantId, type RuntimeKind, type SessionInputAdapter } from "@agent-plane/core";
import {
  BedrockAdapter,
  ClaudeAdapter,
  ClaudeCodeSessionInputAdapter,
  CodexAdapter,
  CursorAdapter,
  FakeAdapter,
  FakeSessionInputAdapter,
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

/**
 * What `capability-probe.ts` reads for a provider. The probe only decides WHETHER to re-describe
 * (version + config fingerprint); it never authors manifest values.
 */
export interface ProbeSpec {
  /** CLI whose `--version` is part of the fingerprint. Absent: version `in-process`. */
  readonly command?: string;
  /** Option key whose string value, when set, replaces `command` (Cursor's CLI name is configurable). */
  readonly commandOption?: string;
  /** Config directory under the home directory, such as `.claude`. */
  readonly configRoot?: string;
  /** Files under `configRoot` whose presence means auth `ok`. */
  readonly authFiles?: readonly string[];
  /** Fingerprinted besides `config.json`, `settings.json`, `settings.local.json`, `config.toml`. */
  readonly extraConfigFiles?: readonly string[];
  /** Auth is `ok` exactly when this environment variable is set (its name, never its value, is fingerprinted). */
  credentialEnv?(options: Record<string, unknown>): string;
  /** In-process test runtime: fixed auth state and models. */
  readonly fixed?: { readonly authState: string; readonly models: readonly string[] };
}

/**
 * How the session-input service reaches a provider's delivery adapter (docs/contracts/session-input.md).
 * `perAssistant: true` builds one on first use and reuses it; `false` reads it from the adapter each
 * time. `owner` looks the assistant's agent adapter up lazily, so a binding that does not need it
 * never touches the registry.
 */
export interface SessionInputBinding {
  readonly perAssistant: boolean;
  resolve(owner: () => AgentAdapter): SessionInputAdapter | undefined;
}

/**
 * What the runtime conformance probe (`runtime-conformance.ts`, `POST /api/assistants/:id/test`)
 * may do for a runtime. Every check it enables is credential-free and quota-free by construction.
 */
export interface ConformanceSpec {
  /**
   * The runtime's real adapter class with its provider entry point pointed at `missingBinary`, a
   * path that cannot exist, or otherwise unable to reach a provider. Used ONLY to check that each
   * approval mode outside `approvalModes` is refused before any launch; a missed refusal can then
   * only fail to start, never reach a model. Absent: those checks are `unsupported`.
   */
  refusalAdapter?(id: AssistantId, options: Record<string, unknown>, missingBinary: string): AgentAdapter;
  /**
   * A CLI self-description (a session's init record, a rendered prompt input) that would carry more
   * evidence than `--version`, but that this build has not proven to make no model call. Reported
   * `not-run` with the reason, never executed (PR 4 boundary).
   */
  selfDescription?: { readonly command: string; readonly reason: "quota_free_unverified" };
  /** In-process runtimes only (the fake): a scripted run is quota-free by construction, so it runs. */
  readonly inProcessRun?: boolean;
  /** A per-instance requirement on top of `conformanceRequired` (the fake's test option only). */
  requiredFor?(options: Record<string, unknown>): boolean;
}

/** Named idle quota probes (`quota-probe.ts` holds the implementations). */
export type QuotaProbeKind = "claude-oauth-usage";

export interface RuntimeDescriptor extends RuntimeKind {
  /** Version of this interface (not a wire contract). A breaking change bumps every entry. */
  readonly descriptorVersion: 1;
  readonly label: string;
  /** `scaffold`: the event mapping is not proven against a pinned CLI (the adapter says `providerDetail.mappingVerified: false`). */
  readonly maturity: "verified" | "scaffold";
  /** How the plane speaks to the runtime. Every runtime today has a native adapter; `acp` is reserved for the ACP bridge (design PR 9). */
  readonly transport: "native";
  /**
   * Whether a passing `runtime_conformance` row for the observed CLI version and this
   * `descriptorVersion` is required before routing (design §B.3). False for every existing
   * runtime, which keeps their established eligibility (owner decision G.3).
   */
  readonly conformanceRequired: boolean;
  readonly probe?: ProbeSpec;
  readonly quotaProbe?: QuotaProbeKind;
  readonly sessionInput?: SessionInputBinding;
  readonly conformance: ConformanceSpec;
  create(ctx: AdapterContext, id: AssistantId, options: Record<string, unknown>): AgentAdapter;
}

/** Whether a passing version-bound conformance row is required before this instance is routed. */
export function conformanceRequiredFor(descriptor: RuntimeDescriptor, options: Record<string, unknown> = {}): boolean {
  return descriptor.conformanceRequired || descriptor.conformance.requiredFor?.(options) === true;
}

type Own = Omit<RuntimeDescriptor, keyof RuntimeKind>;
/** A descriptor is its core row plus the API-side wiring; the row's facts are never restated here. */
const descriptor = (provider: string, own: Own): RuntimeDescriptor => {
  const kind = runtimeKindFor(provider);
  if (!kind) throw new Error(`runtime catalogue: no RUNTIME_KINDS row for ${provider}`);
  return Object.freeze({ ...kind, ...own, ...(own.probe ? { probe: Object.freeze({ ...own.probe }) } : {}) });
};

const CLI_AUTH_FILES = Object.freeze([".credentials.json", "auth.json"]);

/**
 * In the order the unknown-provider error has always listed them (the order of `RUNTIME_KINDS`).
 * Each `create` body is the corresponding case of the former `createAdapter` switch, unchanged;
 * each `probe`, `quotaProbe` and `sessionInput` is the former provider branch in
 * `capability-probe.ts`, `quota-probe.ts` and `server.ts`, unchanged.
 */
export const RUNTIME_CATALOG: readonly RuntimeDescriptor[] = Object.freeze([
  descriptor("anthropic", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Claude Code", maturity: "verified",
    probe: { command: "claude", configRoot: ".claude", authFiles: CLI_AUTH_FILES, extraConfigFiles: ["../.claude.json", "plugins/installed_plugins.json"] },
    quotaProbe: "claude-oauth-usage",
    // Claude enforces every approval mode, so there is nothing to refuse. `system/init` then cancel
    // (S5a) is not proven to stop before the first model request, so it is not run.
    conformance: { selfDescription: { command: "claude -p --output-format stream-json (system/init, then cancel)", reason: "quota_free_unverified" } },
    sessionInput: {
      perAssistant: true,
      // Only a live-input ClaudeAdapter can be delivered to. Anything else has no capability
      // rather than a silently faked one. Delivery is proven from the CLI's own transcript.
      resolve: (owner) => {
        const agent = owner();
        return agent instanceof ClaudeAdapter ? new ClaudeCodeSessionInputAdapter((sessionId) => agent.liveSession(sessionId)) : undefined;
      },
    },
    create: (ctx, id) => new ClaudeAdapter(id, undefined, {
      liveInput: ctx.sessionInputEnabled,
      ...(ctx.providerProfile ? { profile: ctx.providerProfile } : {}),
      ...(ctx.agentLauncher ? { agentLauncher: ctx.agentLauncher } : {}),
    }),
  }),
  descriptor("openai", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Codex", maturity: "verified",
    probe: { command: "codex", configRoot: ".codex", authFiles: CLI_AUTH_FILES },
    conformance: {
      // The refusal is checked on the SDK path (shared with the app-server path: codexPermissions).
      refusalAdapter: (id, _options, missingBinary) => new CodexAdapter(id, { codex: { codexPathOverride: missingBinary } }),
      selfDescription: { command: "codex debug prompt-input", reason: "quota_free_unverified" },
    },
    sessionInput: {
      perAssistant: false,
      resolve: (owner) => { const agent = owner(); return agent instanceof CodexAdapter ? agent.sessionInput : undefined; },
    },
    create: (ctx, id, options) => new CodexAdapter(id, { appServerInput: ctx.sessionInputEnabled && options.appServerInput === true }),
  }),
  descriptor("openrouter", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Codex via OpenRouter", maturity: "verified",
    probe: { credentialEnv: (options) => (typeof options.apiKeyEnv === "string" ? options.apiKeyEnv : "OPENROUTER_API_KEY") },
    conformance: { refusalAdapter: (id, options, missingBinary) => new OpenRouterCodexAdapter(id, options as OpenRouterOptions, { codexPathOverride: missingBinary }) },
    create: (_ctx, id, options) => new OpenRouterCodexAdapter(id, options as OpenRouterOptions),
  }),
  descriptor("cursor", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Cursor CLI", maturity: "scaffold",
    // The installed CLI's version, so `installed` and version-bound conformance see the real CLI.
    probe: { command: "agent", commandOption: "command" },
    conformance: { refusalAdapter: (id, options, missingBinary) => new CursorAdapter(id, { ...(options as CursorOptions), command: missingBinary }) },
    create: (_ctx, id, options) => new CursorAdapter(id, options as CursorOptions),
  }),
  descriptor("bedrock", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Bedrock AgentCore", maturity: "verified",
    // Bedrock hosts YOUR agent: the runtime ARN is configuration, not
    // something the plane can discover (review §2.4).
    // No runtime ARN, a fixed region: start() can only fail before any AgentCore request. Bedrock
    // enforces no approval mode and refuses none (a known gap), so these checks report it.
    conformance: { refusalAdapter: (id) => new BedrockAdapter(id, { region: "us-east-1" }) },
    create: (_ctx, id, options) => new BedrockAdapter(id, options as BedrockOptions),
  }),
  descriptor("fake", {
    descriptorVersion: 1, transport: "native", conformanceRequired: false, label: "Fake (tests)", maturity: "verified",
    probe: { fixed: { authState: "ok", models: ["fake-1"] } },
    sessionInput: { perAssistant: true, resolve: () => new FakeSessionInputAdapter() },
    conformance: { inProcessRun: true, requiredFor: (options) => options.conformanceRequired === true },
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

/**
 * The session-input service's resolver (server.ts), driven by each descriptor's `sessionInput`
 * binding. `providerOf` reads the assistant's provider (the `assistants` row); `adapterOf` is
 * `Registry.adapter`, called only by a binding that needs the agent adapter and only on a cache miss.
 * A `perAssistant` binding's result is cached per assistant once it is defined; `undefined` is not
 * cached, so a later call tries again, as before.
 */
export function sessionInputResolver(
  providerOf: (assistantId: string) => string | undefined,
  adapterOf: (assistantId: string) => AgentAdapter,
): (assistantId: string) => SessionInputAdapter | undefined {
  const perAssistant = new Map<string, SessionInputAdapter>();
  return (assistantId) => {
    const provider = providerOf(assistantId);
    const binding = provider === undefined ? undefined : runtimeFor(provider)?.sessionInput;
    if (!binding) return undefined;
    if (!binding.perAssistant) return binding.resolve(() => adapterOf(assistantId));
    const cached = perAssistant.get(assistantId);
    if (cached) return cached;
    const adapter = binding.resolve(() => adapterOf(assistantId));
    if (adapter) perAssistant.set(assistantId, adapter);
    return adapter;
  };
}
