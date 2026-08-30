import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * Workspace instance configuration (revised architecture §1).
 * A workspace IS an instance: one config dir + one DB file per workspace,
 * selected at boot. Nothing here ever holds provider credentials —
 * provider CLIs/SDKs authenticate in place.
 */
export interface AssistantConfig {
  /** anthropic | openai | openrouter | cursor | bedrock | fake (dev). */
  provider: string;
  enabled?: boolean;
  /**
   * Provider-specific settings. Bedrock needs the deployed AgentCore agent to
   * invoke (it is a hosting platform, not a discoverable assistant), so that
   * comes from configuration rather than capability discovery.
   */
  options?: Record<string, unknown>;
}

/** How far an assistant may act before it must ask (arch §12.7). */
export type ApprovalMode = "auto-approve" | "prompt-on-escalation" | "read-only";

export interface WorkspaceConfig {
  workspace: string;
  api: {
    /** Bind host. Keep 127.0.0.1 unless auth is added first (arch §12.6). */
    host: string;
    port: number;
  };
  /** Assistant environments this workspace instance may route to. */
  assistants: Record<string, AssistantConfig>;
  /** Absolute repo paths tasks may touch. Empty = refuse all coding tasks. */
  repoAllowlist: string[];
  policy: {
    /** Applied to every run this instance starts. */
    approvalMode: ApprovalMode;
  };
  failover: {
    auto: boolean;
    softThresholdPct: number;
    triggers: string[];
  };
  sync: {
    /** Local hour (0-23) for the daily capability sync. */
    dailyHour: number;
  };
}

export interface ResolvedConfig extends WorkspaceConfig {
  /** Directory holding config.yaml and the workspace DB. */
  dir: string;
  dbPath: string;
}

const PERSONAL_DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  api: { host: "127.0.0.1", port: 4176 },
  assistants: {
    "personal-claude": { provider: "anthropic" },
    "personal-codex": { provider: "openai" },
  },
  repoAllowlist: [],
  policy: { approvalMode: "prompt-on-escalation" },
  failover: {
    auto: true,
    softThresholdPct: 85,
    triggers: ["quota", "rate_limit", "provider_unavailable"],
  },
  sync: { dailyHour: 7 },
};

/**
 * A non-personal workspace starts stricter and opts in, rather than starting
 * permissive and hoping the user tightens it: automatic failover is
 * approval-gated (rerouting work code to another provider is a decision, not a
 * default) and no assistants are assumed present.
 */
const WORK_DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  ...PERSONAL_DEFAULTS,
  api: { host: "127.0.0.1", port: 4186 },
  assistants: {},
  policy: { approvalMode: "prompt-on-escalation" },
  failover: { ...PERSONAL_DEFAULTS.failover, auto: false },
};

function defaultsFor(workspace: string): Omit<WorkspaceConfig, "workspace"> {
  return workspace === "personal" ? PERSONAL_DEFAULTS : WORK_DEFAULTS;
}

export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_PLANE_HOME ?? join(homedir(), ".agent-plane");
}

export function workspaceName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.AGENT_PLANE_WORKSPACE ?? "personal";
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    throw new Error(`Invalid workspace name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Loads the active workspace config, creating a commented default on first boot.
 * Unknown keys are preserved-ignored; missing keys fall back to defaults so a
 * hand-edited partial file still boots.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const workspace = workspaceName(env);
  const dir = join(configHome(env), workspace);
  const configPath = join(dir, "config.yaml");

  if (!existsSync(configPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, renderDefaultConfig(workspace), "utf8");
  }

  const defaults = defaultsFor(workspace);
  const raw: unknown = parse(readFileSync(configPath, "utf8"));
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`${configPath} must be a YAML mapping`);
  }
  const file = (raw ?? {}) as Partial<WorkspaceConfig>;

  const config: WorkspaceConfig = {
    workspace: file.workspace ?? workspace,
    api: { ...defaults.api, ...file.api },
    assistants: file.assistants ?? defaults.assistants,
    repoAllowlist: file.repoAllowlist ?? defaults.repoAllowlist,
    policy: { ...defaults.policy, ...file.policy },
    failover: { ...defaults.failover, ...file.failover },
    sync: { ...defaults.sync, ...file.sync },
  };

  validate(config, configPath);

  return { ...config, dir, dbPath: join(dir, "agent-plane.db") };
}

function validate(config: WorkspaceConfig, path: string): void {
  const problems: string[] = [];
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(config.api.host)) {
    problems.push(`api.host must be a loopback address until authenticated remote mode exists, got ${config.api.host}`);
  }
  if (!Number.isInteger(config.api.port) || config.api.port < 1 || config.api.port > 65535) {
    problems.push(`api.port must be 1-65535, got ${config.api.port}`);
  }
  if (config.failover.softThresholdPct < 1 || config.failover.softThresholdPct > 100) {
    problems.push(`failover.softThresholdPct must be 1-100, got ${config.failover.softThresholdPct}`);
  }
  if (!Number.isInteger(config.sync.dailyHour) || config.sync.dailyHour < 0 || config.sync.dailyHour > 23) {
    problems.push(`sync.dailyHour must be 0-23, got ${config.sync.dailyHour}`);
  }
  if (!config.repoAllowlist.every((p) => typeof p === "string")) {
    problems.push("repoAllowlist must be a list of paths");
  }
  const modes: ApprovalMode[] = ["auto-approve", "prompt-on-escalation", "read-only"];
  if (!modes.includes(config.policy.approvalMode)) {
    problems.push(`policy.approvalMode must be one of ${modes.join(" | ")}, got ${config.policy.approvalMode}`);
  }
  for (const [id, assistant] of Object.entries(config.assistants)) {
    if (!assistant || typeof assistant.provider !== "string") {
      problems.push(`assistants.${id} must have a provider`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n  - ${problems.join("\n  - ")}`);
  }
}

function renderDefaultConfig(workspace: string): string {
  const doc = { workspace, ...defaultsFor(workspace) };
  return [
    `# Agent Control Plane — workspace "${workspace}"`,
    "# This instance IS the workspace: its DB, policy, and repo allowlist live here.",
    "# Provider credentials are never stored here — each provider's own CLI/SDK auth is used in place.",
    "",
    stringify(doc),
  ].join("\n");
}
