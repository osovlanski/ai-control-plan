import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureCredential } from "./auth/credential-file.js";
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
    auth: { bootstrapTtlSeconds: number; sessionTtlSeconds: number; rotationGraceSeconds: number };
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
  /** Execution-Harness cutover switches (execution-harness.md §5/§10). */
  execution?: {
    /**
     * Per-mode Execution-Harness routing. `single` is the only key with Harness
     * parity today; `compare` / `race` / `parallel` land in vNext increment 6
     * together with a durable routing key. Every mode defaults OFF.
     */
    harnessModes?: { single?: boolean };
    /**
     * @deprecated Use `harnessModes.single`. Accepted for one release; mapped
     * onto `harnessModes.single` at load with a startup warning. Setting both
     * this and `harnessModes` is a config error.
     */
    harnessSingleMode?: boolean;
  };
}

/** The resolved execution block — always canonical `harnessModes`, never the deprecated key. */
export interface ResolvedExecutionConfig {
  harnessModes: { single: boolean };
}

export interface ResolvedConfig extends Omit<WorkspaceConfig, "execution"> {
  execution: ResolvedExecutionConfig;
  /** Directory holding config.yaml and the workspace DB. */
  dir: string;
  dbPath: string;
  /** Non-fatal load-time diagnostics (e.g. deprecated keys). Never written to stdout by the loader. */
  warnings: string[];
}

const PERSONAL_DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  api: { host: "127.0.0.1", port: 4176, auth: { bootstrapTtlSeconds: 10, sessionTtlSeconds: 43200, rotationGraceSeconds: 300 } },
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
  execution: { harnessModes: { single: false } },
};

/**
 * A non-personal workspace starts stricter and opts in, rather than starting
 * permissive and hoping the user tightens it: automatic failover is
 * approval-gated (rerouting work code to another provider is a decision, not a
 * default) and no assistants are assumed present.
 */
const WORK_DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  ...PERSONAL_DEFAULTS,
  api: { host: "127.0.0.1", port: 4186, auth: { ...PERSONAL_DEFAULTS.api.auth } },
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, renderDefaultConfig(workspace), "utf8");
  }

  const defaults = defaultsFor(workspace);
  const raw: unknown = parse(readFileSync(configPath, "utf8"));
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`${configPath} must be a YAML mapping`);
  }
  const file = (raw ?? {}) as Partial<WorkspaceConfig>;
  if (file.execution !== undefined && (typeof file.execution !== "object" || Array.isArray(file.execution))) {
    throw new Error(`${configPath} execution must be a mapping`);
  }

  const warnings: string[] = [];
  const execution = resolveExecution(file.execution, env, configPath, warnings);

  const config: WorkspaceConfig = {
    workspace: file.workspace ?? workspace,
    api: { ...defaults.api, ...file.api, auth: { ...defaults.api.auth, ...file.api?.auth } },
    assistants: file.assistants ?? defaults.assistants,
    repoAllowlist: file.repoAllowlist ?? defaults.repoAllowlist,
    policy: { ...defaults.policy, ...file.policy },
    failover: { ...defaults.failover, ...file.failover },
    sync: { ...defaults.sync, ...file.sync },
    execution,
  };

  validate(config, configPath);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const ds = statSync(dir);
  if (!ds.isDirectory() || ds.uid !== process.getuid?.() || (ds.mode & 0o077) !== 0) {
    throw new Error(`Unsafe config directory ${dir}; run: chmod 700 ${dir} && chown $(id -u) ${dir}`);
  }
  ensureCredential(dir);

  return { ...config, execution, dir, dbPath: join(dir, "agent-plane.db"), warnings };
}

/**
 * Resolve `execution` to the canonical `{ harnessModes: { single } }` shape.
 * Precedence (low → high): default `false` < exactly one file representation
 * (`harnessModes` XOR the deprecated `harnessSingleMode`) < the
 * `AGENT_PLANE_HARNESS_SINGLE_MODE` env var. Setting both file keys, an unknown
 * `harnessModes` key, or a non-`1|true|0|false` env value is a hard error.
 */
function resolveExecution(
  fileExecution: WorkspaceConfig["execution"] | undefined,
  env: NodeJS.ProcessEnv,
  configPath: string,
  warnings: string[],
): ResolvedExecutionConfig {
  let single = false;

  const hasModes = fileExecution?.harnessModes !== undefined;
  const hasLegacy = fileExecution?.harnessSingleMode !== undefined;
  if (hasModes && hasLegacy) {
    throw new Error(
      `${configPath}: set either execution.harnessModes or the deprecated execution.harnessSingleMode, not both`,
    );
  }

  if (hasModes) {
    const modes = fileExecution!.harnessModes as Record<string, unknown>;
    if (typeof modes !== "object" || modes === null || Array.isArray(modes)) {
      throw new Error(`${configPath}: execution.harnessModes must be a mapping`);
    }
    for (const key of Object.keys(modes)) {
      if (key !== "single") {
        throw new Error(
          `${configPath}: execution.harnessModes.${key} — "${key}" mode has no Execution Harness parity yet (vNext increment 6); only "single" is accepted`,
        );
      }
    }
    if (modes.single !== undefined) {
      if (typeof modes.single !== "boolean") {
        throw new Error(
          `${configPath}: execution.harnessModes.single must be a boolean, got ${JSON.stringify(modes.single)}`,
        );
      }
      single = modes.single;
    }
  } else if (hasLegacy) {
    if (typeof fileExecution!.harnessSingleMode !== "boolean") {
      throw new Error(
        `${configPath}: execution.harnessSingleMode must be a boolean, got ${JSON.stringify(fileExecution!.harnessSingleMode)}`,
      );
    }
    single = fileExecution!.harnessSingleMode;
    warnings.push(
      "config: execution.harnessSingleMode is deprecated — use execution.harnessModes.single. The old key is accepted for one release.",
    );
  }

  const raw = env.AGENT_PLANE_HARNESS_SINGLE_MODE;
  if (raw !== undefined && raw !== "") {
    const v = raw.toLowerCase();
    if (v === "1" || v === "true") single = true;
    else if (v === "0" || v === "false") single = false;
    else {
      throw new Error(
        `AGENT_PLANE_HARNESS_SINGLE_MODE must be one of 1|true|0|false, got ${JSON.stringify(raw)}`,
      );
    }
  }

  return { harnessModes: { single } };
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
  for (const [key, value] of Object.entries(config.api.auth)) {
    if (!Number.isInteger(value) || value <= 0) problems.push(`api.auth.${key} must be a positive integer, got ${value}`);
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
  if (typeof config.execution?.harnessModes?.single !== "boolean") {
    problems.push(
      `execution.harnessModes.single must be a boolean, got ${JSON.stringify(config.execution?.harnessModes?.single)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n  - ${problems.join("\n  - ")}`);
  }
}

function renderDefaultConfig(workspace: string): string {
  const doc = { workspace, ...defaultsFor(workspace) };
  const yaml = stringify(doc).replace(
    /^execution:/m,
    [
      "# execution.harnessModes: per-mode Execution Harness routing. Only `single` has parity today; default off.",
      "# The deprecated `execution.harnessSingleMode: <bool>` is still accepted for one release and maps to harnessModes.single.",
      "execution:",
    ].join("\n"),
  );
  return [
    `# Agent Control Plane — workspace "${workspace}"`,
    "# This instance IS the workspace: its DB, policy, and repo allowlist live here.",
    "# Provider credentials are never stored here — each provider's own CLI/SDK auth is used in place.",
    "",
    yaml,
  ].join("\n");
}
