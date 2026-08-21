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
export interface WorkspaceConfig {
  workspace: string;
  api: {
    /** Bind host. Keep 127.0.0.1 unless auth is added first (arch §12.6). */
    host: string;
    port: number;
  };
  /** Absolute repo paths tasks may touch. Empty = refuse all coding tasks. */
  repoAllowlist: string[];
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

const DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  api: { host: "127.0.0.1", port: 4176 },
  repoAllowlist: [],
  failover: {
    auto: true,
    softThresholdPct: 85,
    triggers: ["quota", "rate_limit", "provider_unavailable"],
  },
  sync: { dailyHour: 7 },
};

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

  const raw: unknown = parse(readFileSync(configPath, "utf8"));
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`${configPath} must be a YAML mapping`);
  }
  const file = (raw ?? {}) as Partial<WorkspaceConfig>;

  const config: WorkspaceConfig = {
    workspace: file.workspace ?? workspace,
    api: { ...DEFAULTS.api, ...file.api },
    repoAllowlist: file.repoAllowlist ?? DEFAULTS.repoAllowlist,
    failover: { ...DEFAULTS.failover, ...file.failover },
    sync: { ...DEFAULTS.sync, ...file.sync },
  };

  validate(config, configPath);

  return { ...config, dir, dbPath: join(dir, "agent-plane.db") };
}

function validate(config: WorkspaceConfig, path: string): void {
  const problems: string[] = [];
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
  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n  - ${problems.join("\n  - ")}`);
  }
}

function renderDefaultConfig(workspace: string): string {
  const doc = { workspace, ...DEFAULTS };
  return [
    `# Agent Control Plane — workspace "${workspace}"`,
    "# This instance IS the workspace: its DB, policy, and repo allowlist live here.",
    "# Provider credentials are never stored here — each provider's own CLI/SDK auth is used in place.",
    "",
    stringify(doc),
  ].join("\n");
}
