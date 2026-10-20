/**
 * Provisioning lifecycle (M3, docs/agentic-os-plan.md §3.4): an adapter materializes a composed
 * revision's bundle as a per-run profile the plane owns, proves it, launches against it, and
 * removes it. Types only; the implementations live in `@agent-plane/adapters`.
 *
 * Fidelity is how much of the provider's view the profile controls (risk 1):
 * - `full`: the machine-global config is excluded and only the profile plus the worktree's own
 *   project files are visible.
 * - `partial`: the profile is delivered, but machine-global config stays visible.
 * - `none`: nothing is delivered; the run sees ambient config. Never a silent fallback: the run
 *   records it.
 *
 * This is NOT `ExecutionPolicy.isolation`, which is about process sandboxing.
 */

import type { AgentSpec, BundleResponse, McpAssetRef, McpLaunch } from "./composition-types.js";

export type ProvisioningFidelity = "full" | "partial" | "none";
export type ProvisionedHarness = "claude-code" | "codex";

/**
 * An MCP server the revision attaches, with the launch shape the registry recorded at its digest
 * (M3 S4). The plane resolves it; bundle bytes do not carry it.
 */
export interface ProvisioningMcpServer {
  ref: McpAssetRef;
  launch: McpLaunch;
}

/**
 * An MCP server as a profile launches it. `envRefs` maps the env var the server reads to the
 * secret reference NAME that fills it; the value is resolved in memory at launch and travels only
 * in the provider process environment, never in a file, argv, a digest or an event (risk 10).
 */
export interface ProfileMcpServer {
  /** The registry asset this server came from. */
  asset: { id: string; digest: string };
  command: string;
  args: string[];
  envRefs: Record<string, string>;
}

/** What the plane hands `prepare`. The plane picks `root`; an adapter never chooses where it writes. */
export interface ProvisioningInput {
  spec: AgentSpec;
  /** The persisted BundleResponse the revision was composed with (bundle bytes are not in AgentSpec). */
  bundle: BundleResponse;
  /** Absolute directory the profile is materialized into. Must not exist, or be this profile. */
  root: string;
  /** The session the profile belongs to; written to the ownership marker. */
  sessionId: string;
  /** One entry per `spec.assets.mcp_servers` ref. Absent means none were resolved. */
  mcpServers?: ProvisioningMcpServer[];
}

/** A file the profile owns, relative to the profile root. */
export interface ProfileFile {
  relPath: string;
  content: string;
  /** `sha256:<hex>` of the UTF-8 content. */
  digest: string;
}

/** Harness-specific launch options a verified profile carries into `start()`. Absolute paths only under `root`. */
export type ProfileLaunch =
  | {
      harness: "claude-code";
      /** Never `user` or `local`: those are the machine-global and per-user scopes. */
      settingSources: Array<"project">;
      /** Local plugin directory holding the selected skills; absent when no skill was selected. */
      pluginDir?: string;
      /** The bundle's CLAUDE.md, appended to the preset system prompt. */
      systemPromptAppend?: string;
      strictMcpConfig: true;
      /** The only MCP servers the run loads, by server name. */
      mcpServers: Record<string, ProfileMcpServer>;
      disableClaudeAiConnectors: true;
    }
  | {
      harness: "codex";
      /** `--config` overrides; values are bundle content, never a secret. */
      config: { developer_instructions?: string };
      /** Delivered as `mcp_servers.<name>` overrides, secrets by `env_vars` name only. Absent when none. */
      mcpServers?: Record<string, ProfileMcpServer>;
    };

/** `prepare`'s output: inspectable, deterministic, and nothing written yet. */
export interface ProvisioningPlan {
  schemaVersion: 1;
  harness: ProvisionedHarness;
  compositionRevisionId: string;
  sessionId: string;
  root: string;
  files: ProfileFile[];
  launch: ProfileLaunch;
  /** What this mechanism can achieve on this adapter. */
  fidelity: ProvisioningFidelity;
  /** Machine-global or workspace config the run still sees. Stated, never implied. */
  visible: string[];
  /** Scopes the profile keeps out of the run. */
  excluded: string[];
  /** Secret reference NAMES the launch resolves in memory. Never values. */
  secretRefs: string[];
  /** sha256 over JCS of harness, files (relPath + digest) and the launch shape with content digests. No path, no time. */
  profileDigest: string;
}

/** A plan materialized on disk under `root`, with an ownership marker. */
export interface ProvisionedProfile {
  plan: ProvisioningPlan;
  /** Marker file name under `root`; dispose refuses a directory whose marker does not match. */
  marker: string;
}

export interface ProvisioningCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProvisioningVerification {
  ok: boolean;
  /** Achieved fidelity: the plan's when every check passed, otherwise `none`. */
  fidelity: ProvisioningFidelity;
  profileDigest: string;
  checks: ProvisioningCheck[];
}

/** The deep-frozen profile a RunSpec launches with: the plan plus the verification that proved it. */
export interface VerifiedProfile {
  readonly harness: ProvisionedHarness;
  readonly compositionRevisionId: string;
  readonly root: string;
  readonly profileDigest: string;
  readonly fidelity: ProvisioningFidelity;
  readonly files: ReadonlyArray<{ readonly relPath: string; readonly digest: string }>;
  readonly launch: Readonly<ProfileLaunch>;
  readonly visible: readonly string[];
  readonly excluded: readonly string[];
  /** Secret reference names the launch resolves in memory for the profile's MCP servers. */
  readonly secretRefs: readonly string[];
  readonly checks: readonly ProvisioningCheck[];
}

/**
 * M3 S5: what the provider itself reported at startup, judged against the verified profile.
 * An adapter that can observe this carries it on `run.started` as `payload.profileEvidence`;
 * a `full` profile without it, or with `ok: false`, fails the session before RUNNING. Names only.
 */
export interface ProfileRuntimeEvidence {
  ok: boolean;
  profileDigest: string;
  checks: ProvisioningCheck[];
}

/** Refusal reasons `prepare` and `provision` throw with (as `ProvisioningError.reason`). */
export type ProvisioningRefusal =
  | "harness_mismatch"
  | "unsupported_asset"
  | "unsupported_transport"
  | "invalid_bundle"
  | "invalid_root"
  | "unowned_path"
  | "digest_mismatch";

export class ProvisioningError extends Error {
  constructor(readonly reason: ProvisioningRefusal, message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/** Payload of `provisioning.verified`: the profile a session launched with. */
export interface ProvisioningVerifiedPayload {
  compositionRevisionId: string;
  harness: ProvisionedHarness;
  fidelity: ProvisioningFidelity;
  profileDigest: string;
  files: Array<{ relPath: string; digest: string }>;
  visible: string[];
  excluded: string[];
  checks: ProvisioningCheck[];
}

/** Payload of `provisioning.ambient`: a revision-bound session that launched with no profile, and why. */
export interface ProvisioningAmbientPayload {
  compositionRevisionId: string;
  fidelity: "none";
  reason: string;
}

/** Payload of `provisioning.disposed`. `removed: false` means there was nothing left to remove. */
export interface ProvisioningDisposedPayload {
  compositionRevisionId: string;
  profileDigest: string;
  removed: boolean;
}

/**
 * Payload of `provisioning.swept`: the boot sweep removed a profile whose session had ended
 * without disposing it (a crash). `staging` marks a half-written profile.
 */
export interface ProvisioningSweptPayload {
  compositionRevisionId: string;
  profileDigest: string;
  staging: boolean;
}

/**
 * Why an MCP launch shape cannot be provisioned, or undefined when it can (M3 S4). The Composer
 * filters on it and `prepare` refuses on it, so the two never disagree. Only stdio servers with a
 * plain command line and env-var secrets: a secret interpolated into argv would be visible in the
 * process table (risk 10), and a keychain reference has no resolver.
 */
export function mcpLaunchProblem(launch: McpLaunch | undefined): string | undefined {
  if (!launch) return "the registry recorded no launch shape";
  if (launch.transport !== "stdio") return `transport ${launch.transport} is not provisioned; only stdio`;
  if (!launch.command) return "a stdio server with no command";
  if ([launch.command, ...(launch.args ?? [])].some((a) => a.includes("${"))) {
    return "its command line interpolates an environment variable, and a secret travels only in the environment, never in argv";
  }
  if (Object.values(launch.env).some((r) => r.type !== "env")) return "a keychain secret reference has no resolver at launch";
  return undefined;
}

/** The secret references an MCP launch names, sorted by name, without duplicates. */
export function mcpSecretRefs(launch: McpLaunch): Array<{ type: "env" | "keychain"; name: string }> {
  const byKey = new Map(Object.values(launch.env).map((r) => [`${r.type}:${r.name}`, { type: r.type, name: r.name }]));
  return [...byKey.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}

/** Map a verified fidelity onto AgentSpec `provisioning.achieved`. */
export function achievedTier(fidelity: ProvisioningFidelity): NonNullable<AgentSpec["provisioning"]["achieved"]> {
  return fidelity === "none" ? "ambient" : fidelity;
}
