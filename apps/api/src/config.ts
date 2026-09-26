import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ensureCredential } from "./auth/credential-file.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { McpToolAccess, McpToolPolicy } from "@agent-plane/core";

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
   * Which kind of account this assistant runs under (`api`, `subscription`, …),
   * matched against a K7 price row's `appliesTo.accountKind`. Operator-declared
   * `local-config` evidence and the ONLY proof of account identity we have: with
   * it absent, an account-specific tariff is NOT applicable and the cost
   * dimension has no evidence rather than a guessed one (§4.4.5).
   */
  accountKind?: string;
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
  scheduler?: {
    enabled: boolean;
    maxAutoWakes?: number;
    /**
     * Optional idle quota probes (K3). Off by default: a probe reads the
     * provider's own credential file and calls an account-specific endpoint,
     * so the operator opts in per workspace.
     */
    quotaProbe?: boolean;
    /**
     * K4b named resource pools: pool name -> capacity in units. Empty by default;
     * an undeclared pool cannot be waited on, because a slot count we invented
     * would not be honest. Capacity is re-read at every wake, so an operator edit
     * plus restart is the whole change protocol — no pool CRUD surface.
     *
     * ponytail: only tasks that DECLARE a resource wait claim units; a plain start
     * consumes nothing. Per-launch accounting needs every caller to declare intent,
     * which is a larger slice than K4b.
     */
    resources?: Record<string, number>;
  };
  sync: {
    /** Local hour (0-23) for the daily capability sync. */
    dailyHour: number;
  };
  /**
   * M12 model intelligence (K13). The catalog, its benchmark evidence and the
   * shadow recommendations are always readable; this block only controls
   * whether a recommendation may ever become an execution decision.
   */
  models?: {
    selection?: {
      /**
       * Automatic model selection. Default FALSE and fail-closed: shadow is the
       * shipped mode. Setting it true is necessary but NOT sufficient — every
       * gate in §4.4.3 must also hold (`evaluateActivationGate`).
       */
      enabled?: boolean;
      /**
       * Operator attestation, ISO 8601: "I reviewed the shadow log". The gate
       * additionally requires that the log already spanned a week when it was
       * signed, and that the attestation is under 30 days old.
       */
      shadowReviewedAt?: string;
      /**
       * Operator/CI attestation, ISO 8601: the K8 egress + security test was
       * green on this build. An attestation, not a proof — which is exactly why
       * it expires after 30 days.
       */
      egressVerifiedAt?: string;
    };
  };
  /**
   * M16 Decision Service (K17). Provider seam only — no site is wired to it
   * yet. Fail-closed default `rules` reproduces today's behaviour exactly and
   * makes no network call.
   */
  decisions?: {
    /** typesafe | model | rules (default: rules). `typesafe` is not registered in this build: choosing it fails at startup (K19i). Since K19i the tool gate reads no judge whatever this says; floors decide. */
    provider?: "typesafe" | "model" | "rules";
    /**
     * Reference NAME only, e.g. "TYPESAFE_API_KEY" — resolved through
     * `SecretBroker` at the call boundary when a caller actually needs it
     * (harness/secret-broker.ts). Never the key value, never read from
     * `process.env` here.
     */
    typesafeApiKeyRef?: string;
    /**
     * Per-site mode (§7.4). `shadow` records what the site would do and changes
     * nothing; it is the default and the fail-closed value (I-D3). `applied`
     * is refused at load time — and the site kept in shadow, loudly — unless a
     * judging provider is registered in the chain (I-D8). K19c wires only
     * `tool-gate`; the §7.4 attestations are the activation slice's.
     */
    sites?: { "tool-gate"?: { mode?: "shadow" | "applied" } };
    /**
     * K19j: what each MCP tool does, `server → tool → read-only | mutating`.
     * Only this file declares it; an undeclared tool stays `opaque` and
     * prompts. `read-only` removes that one prompt and nothing else.
     */
    mcpTools?: Record<string, Record<string, McpToolAccess>>;
  };
  /**
   * Durable session-addressed conversational input (docs/contracts/session-input.md).
   * Default FALSE. While it is off the routes are not registered at all, so the
   * capability is indistinguishable from absent and the Shell composer stays
   * truthfully disabled.
   */
  sessionInput?: { enabled?: boolean };
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
    /**
     * Cap on kernel-started providers between spawn and their first event
     * (Harness path). Starts over the cap wait FIFO; the wait is a `phase`
     * trace event. Unset = unlimited, as before.
     */
    maxConcurrentProviderStarts?: number;
    /**
     * Opt-in curated launch for Claude providers: only these plugins stay on and
     * only these MCP servers (full stdio/http configs, keyed by server name)
     * connect; claude.ai connectors are off. Unset = the provider's full user
     * config, as before.
     */
    providerProfile?: { plugins?: string[]; mcpServers?: Record<string, Record<string, unknown>> };
  };
}

/** The resolved execution block — always canonical `harnessModes`, never the deprecated key. */
export interface ResolvedExecutionConfig {
  harnessModes: { single: boolean };
  maxConcurrentProviderStarts?: number;
  providerProfile?: { plugins: string[]; mcpServers: Record<string, Record<string, unknown>> };
}

/** The resolved model block — always present, always fail-closed by default. */
export interface ResolvedModelsConfig {
  selection: { enabled: boolean; shadowReviewedAt?: string; egressVerifiedAt?: string };
}

/** The resolved decisions block — always present, always fail-closed to "rules". */
export interface ResolvedDecisionsConfig {
  provider: "typesafe" | "model" | "rules";
  typesafeApiKeyRef?: string;
  /** The REQUESTED mode. The effective one is resolved against the provider chain (I-D8) at composition. */
  sites: { "tool-gate": { mode: "shadow" | "applied" } };
  /** Null-prototype maps of own keys only; empty when nothing is declared. */
  mcpTools: McpToolPolicy;
}

export interface ResolvedConfig extends Omit<WorkspaceConfig, "execution" | "models" | "decisions" | "sessionInput"> {
  execution: ResolvedExecutionConfig;
  models: ResolvedModelsConfig;
  decisions: ResolvedDecisionsConfig;
  /** Always present, always fail-closed by default. */
  sessionInput: { enabled: boolean };
  /** Directory holding config.yaml and the workspace DB. */
  dir: string;
  dbPath: string;
  /** Non-fatal load-time diagnostics (e.g. deprecated keys). Never written to stdout by the loader. */
  warnings: string[];
}

/**
 * Pool declarations as a null-prototype map of OWN keys only.
 *
 * A pool name is durable TASK data — it arrives from a wait row, not from the
 * config file — so the map it is looked up in must not be able to answer for a
 * name nobody declared. A plain object spread cannot give that guarantee twice
 * over: `{...x}` invokes the `__proto__` SETTER, so one crafted key silently
 * re-parents the whole map, and every inherited member (`constructor`,
 * `toString`, `valueOf`) then reads back as a declaration. A null-prototype
 * target has no setter and nothing to inherit, so an own key is the only key.
 *
 * Values are copied unvalidated on purpose: `validate` below reports a bad
 * capacity by name rather than silently dropping it, and `Scheduler.capacity`
 * fails closed on anything that is not a finite integer.
 */
function pools(declared?: Record<string, number>): Record<string, number> {
  const resources = Object.create(null) as Record<string, number>;
  if (declared && typeof declared === 'object') {
    for (const name of Object.getOwnPropertyNames(declared)) resources[name] = (declared as Record<string, number>)[name]!;
  }
  return resources;
}

const PERSONAL_DEFAULTS: Omit<WorkspaceConfig, "workspace"> = {
  api: { host: "127.0.0.1", port: 4176, auth: { bootstrapTtlSeconds: 10, sessionTtlSeconds: 43200, rotationGraceSeconds: 300 } },
  assistants: {
    "personal-claude": { provider: "anthropic" },
    "personal-codex": { provider: "openai" },
  },
  repoAllowlist: [],
  // `approvalMode` is workspace-global, not per-assistant (arch §12.7) — every
  // configured assistant must be able to honor it. CodexAdapter has no
  // approval-relay path by design (it self-sandboxes, approvalPolicy "never"),
  // so "prompt-on-escalation" here made any personal-codex invocation fail
  // instantly with policy_unenforceable. auto-approve is the mode every
  // shipped adapter can honor; a workspace that wants escalation prompts for
  // Claude specifically needs a per-assistant override this schema doesn't
  // have yet, not this shared default.
  policy: { approvalMode: "auto-approve" },
  failover: {
    auto: true,
    softThresholdPct: 85,
    triggers: ["quota", "rate_limit", "provider_unavailable"],
  },
  scheduler: { enabled: true, maxAutoWakes: 3, quotaProbe: false, resources: pools() },
  sync: { dailyHour: 7 },
  execution: { harnessModes: { single: false } },
  // K13 ships in shadow. Turning this on is an explicit operator act that still
  // has to satisfy every activation gate.
  models: { selection: { enabled: false } },
  // The session-input contract ships disabled: no route, no ledger write.
  sessionInput: { enabled: false },
  // M16 seam only (K17): no vendor provider exists yet, so `rules` is the only
  // real choice. Reproduces today's regex/threshold behaviour exactly.
  decisions: { provider: "rules", sites: { "tool-gate": { mode: "shadow" } } },
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
  const models = resolveModels(file.models, configPath);
  const decisions = resolveDecisions(file.decisions, configPath);
  const sessionInput = resolveSessionInput(file.sessionInput, configPath);

  const config: WorkspaceConfig = {
    workspace: file.workspace ?? workspace,
    api: { ...defaults.api, ...file.api, auth: { ...defaults.api.auth, ...file.api?.auth } },
    assistants: file.assistants ?? defaults.assistants,
    repoAllowlist: file.repoAllowlist ?? defaults.repoAllowlist,
    policy: { ...defaults.policy, ...file.policy },
    failover: { ...defaults.failover, ...file.failover },
    sync: { ...defaults.sync, ...file.sync },
    scheduler: { enabled: file.scheduler?.enabled ?? true, maxAutoWakes: file.scheduler?.maxAutoWakes ?? 3, quotaProbe: file.scheduler?.quotaProbe ?? false, resources: pools(file.scheduler?.resources) },
    execution,
  };

  validate(config, configPath);
  validateModels(models, configPath);
  validateDecisions(decisions, configPath);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const ds = statSync(dir);
  if (!ds.isDirectory() || ds.uid !== process.getuid?.() || (ds.mode & 0o077) !== 0) {
    throw new Error(`Unsafe config directory ${dir}; run: chmod 700 ${dir} && chown $(id -u) ${dir}`);
  }
  ensureCredential(dir);

  return { ...config, execution, models, decisions, sessionInput, dir, dbPath: join(dir, "agent-plane.db"), warnings };
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

  const cap = fileExecution?.maxConcurrentProviderStarts;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    throw new Error(`${configPath}: execution.maxConcurrentProviderStarts must be a positive integer, got ${JSON.stringify(cap)}`);
  }
  const profile = fileExecution?.providerProfile;
  let providerProfile: ResolvedExecutionConfig["providerProfile"];
  if (profile !== undefined) {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
      throw new Error(`${configPath}: execution.providerProfile must be a mapping`);
    }
    const plugins = profile.plugins ?? [];
    if (!Array.isArray(plugins) || !plugins.every((x) => typeof x === "string" && x.length > 0)) {
      throw new Error(`${configPath}: execution.providerProfile.plugins must be a list of plugin ids`);
    }
    const servers = profile.mcpServers ?? {};
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)
      || !Object.values(servers).every((v) => typeof v === "object" && v !== null && !Array.isArray(v))) {
      throw new Error(`${configPath}: execution.providerProfile.mcpServers must map server names to server configs`);
    }
    providerProfile = { plugins, mcpServers: servers };
  }

  return {
    harnessModes: { single },
    ...(cap !== undefined ? { maxConcurrentProviderStarts: cap } : {}),
    ...(providerProfile ? { providerProfile } : {}),
  };
}

/**
 * Resolve `models.selection` to its canonical shape. Fail-closed: an absent
 * block, an absent key, or anything but an explicit `true` leaves selection
 * disabled. There is deliberately NO environment-variable override — activation
 * is an operator decision recorded in the workspace file, not an ambient one.
 */
function resolveModels(file: WorkspaceConfig["models"], configPath: string): ResolvedModelsConfig {
  if (file !== undefined && (typeof file !== "object" || Array.isArray(file))) {
    throw new Error(`${configPath}: models must be a mapping`);
  }
  const selection = file?.selection;
  if (selection !== undefined && (typeof selection !== "object" || Array.isArray(selection))) {
    throw new Error(`${configPath}: models.selection must be a mapping`);
  }
  return {
    selection: {
      enabled: selection?.enabled === true,
      ...(selection?.shadowReviewedAt !== undefined ? { shadowReviewedAt: selection.shadowReviewedAt } : {}),
      ...(selection?.egressVerifiedAt !== undefined ? { egressVerifiedAt: selection.egressVerifiedAt } : {}),
    },
  };
}

const DECISION_PROVIDERS = ["typesafe", "model", "rules"] as const;

/**
 * Resolve `decisions` to its canonical shape. Fail-closed: an absent block or
 * an absent `provider` key resolves to `rules`, which makes no network call
 * and reproduces today's behaviour exactly (K17). `typesafeApiKeyRef` is
 * carried through as a reference NAME only — never resolved here.
 */
function resolveDecisions(file: WorkspaceConfig["decisions"], configPath: string): ResolvedDecisionsConfig {
  if (file !== undefined && (typeof file !== "object" || Array.isArray(file))) {
    throw new Error(`${configPath}: decisions must be a mapping`);
  }
  const provider = file?.provider ?? "rules";
  if (!DECISION_PROVIDERS.includes(provider as (typeof DECISION_PROVIDERS)[number])) {
    throw new Error(`${configPath}: decisions.provider must be one of ${DECISION_PROVIDERS.join(" | ")}, got ${JSON.stringify(provider)}`);
  }
  const toolGateMode = file?.sites?.["tool-gate"]?.mode ?? "shadow";
  if (toolGateMode !== "shadow" && toolGateMode !== "applied") {
    throw new Error(`${configPath}: decisions.sites.tool-gate.mode must be shadow | applied, got ${JSON.stringify(toolGateMode)}`);
  }
  return {
    provider: provider as ResolvedDecisionsConfig["provider"],
    sites: { "tool-gate": { mode: toolGateMode } },
    mcpTools: resolveMcpTools(file?.mcpTools, configPath),
    ...(file?.typesafeApiKeyRef !== undefined ? { typesafeApiKeyRef: file.typesafeApiKeyRef } : {}),
  };
}

/**
 * Fail closed at load: a value other than `read-only` or `mutating` is an
 * error, never a silent opaque. Server and tool names are agent-visible data at
 * lookup time, so they are copied into null-prototype maps of own keys (see
 * `pools`).
 */
function resolveMcpTools(declared: unknown, configPath: string): McpToolPolicy {
  const policy = Object.create(null) as Record<string, Record<string, McpToolAccess>>;
  if (declared === undefined || declared === null) return policy;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMap(declared)) throw new Error(`${configPath}: decisions.mcpTools must be a mapping of server → tool → read-only | mutating`);
  for (const server of Object.getOwnPropertyNames(declared)) {
    const tools = declared[server];
    if (!isMap(tools)) throw new Error(`${configPath}: decisions.mcpTools.${server} must be a mapping of tool → read-only | mutating`);
    const out = Object.create(null) as Record<string, McpToolAccess>;
    for (const tool of Object.getOwnPropertyNames(tools)) {
      const access = tools[tool];
      if (access !== "read-only" && access !== "mutating") {
        throw new Error(`${configPath}: decisions.mcpTools.${server}.${tool} must be read-only | mutating, got ${JSON.stringify(access)}`);
      }
      out[tool] = access;
    }
    policy[server] = out;
  }
  return policy;
}

function validateDecisions(decisions: ResolvedDecisionsConfig, path: string): void {
  if (
    decisions.typesafeApiKeyRef !== undefined &&
    (typeof decisions.typesafeApiKeyRef !== "string" || decisions.typesafeApiKeyRef.trim() === "")
  ) {
    throw new Error(`Invalid config at ${path}:\n  - decisions.typesafeApiKeyRef must be a non-empty string`);
  }
}

/**
 * Resolve `sessionInput`. Fail-closed: only an explicit `true` enables it, and
 * there is deliberately NO environment override — the capability writes durable
 * provider-facing records, so enabling it is a recorded workspace decision.
 */
function resolveSessionInput(
  file: WorkspaceConfig["sessionInput"],
  configPath: string,
): { enabled: boolean } {
  if (file !== undefined && (typeof file !== "object" || Array.isArray(file))) {
    throw new Error(`${configPath}: sessionInput must be a mapping`);
  }
  if (file?.enabled !== undefined && typeof file.enabled !== "boolean") {
    throw new Error(`${configPath}: sessionInput.enabled must be a boolean, got ${JSON.stringify(file.enabled)}`);
  }
  return { enabled: file?.enabled === true };
}

function validateModels(models: ResolvedModelsConfig, path: string): void {
  const problems: string[] = [];
  for (const key of ["shadowReviewedAt", "egressVerifiedAt"] as const) {
    const value = models.selection[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      problems.push(`models.selection.${key} must be an ISO 8601 timestamp, got ${JSON.stringify(value)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid config at ${path}:\n  - ${problems.join("\n  - ")}`);
  }
}

function validate(config: WorkspaceConfig, path: string): void {
  const problems: string[] = [];
  if (typeof config.scheduler?.enabled !== "boolean") problems.push("scheduler.enabled must be a boolean");
  if (config.scheduler?.maxAutoWakes !== undefined && (!Number.isInteger(config.scheduler.maxAutoWakes) || config.scheduler.maxAutoWakes < 1 || config.scheduler.maxAutoWakes > 100)) problems.push("scheduler.maxAutoWakes must be an integer from 1 to 100");
  if (config.scheduler?.quotaProbe !== undefined && typeof config.scheduler.quotaProbe !== "boolean") problems.push("scheduler.quotaProbe must be a boolean");
  for (const [name, capacity] of Object.entries(config.scheduler?.resources ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) problems.push(`scheduler.resources key ${JSON.stringify(name)} must be 1-64 chars of letters, digits, dot, dash or underscore`);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 10_000) problems.push(`scheduler.resources.${name} must be an integer from 0 to 10000`);
  }
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
  const yaml = stringify(doc)
    .replace(
      /^models:/m,
      [
        "# models.selection.enabled: automatic model selection (K13). Default false — K13 ships in SHADOW:",
        "# recommendations are computed and recorded, and execution keeps today's assistant-only semantics.",
        "# Setting it true is necessary but not sufficient; every activation gate in §4.4.3 must also hold.",
        "models:",
      ].join("\n"),
    )
    .replace(
      /^sessionInput:/m,
      [
        "# sessionInput.enabled: durable session-addressed conversational input (docs/contracts/session-input.md).",
        "# Default false. While it is false the input routes are not registered and no input ledger row is written.",
        "# Only the deterministic fake adapter can deliver today; every real provider declares the capability unsupported.",
        "sessionInput:",
      ].join("\n"),
    )
    .replace(
    /^execution:/m,
    [
      "# execution.harnessModes: per-mode Execution Harness routing. Only `single` has parity today; default off.",
      "# The deprecated `execution.harnessSingleMode: <bool>` is still accepted for one release and maps to harnessModes.single.",
      "# execution.maxConcurrentProviderStarts: <n> caps providers between spawn and first event (Harness path); others queue",
      "#   FIFO and the wait is a `phase` trace event. Unset = unlimited.",
      "# execution.providerProfile: { plugins: [<id@marketplace>], mcpServers: { <name>: <server config> } } launches Claude",
      "#   with only those plugins and exactly those MCP servers (strict), claude.ai connectors off. Unset = full user config.",
      "execution:",
    ].join("\n"),
  )
    .replace(
    /^decisions:/m,
    [
      "# decisions.provider: M16 Decision Service seam (K17). No vendor provider exists yet — `rules`",
      "# reproduces today's regex/threshold behaviour exactly and makes no network call.",
      "decisions:",
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
