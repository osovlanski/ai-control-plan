/**
 * M3 S5b: render what Codex would send the model for a provisioned profile, and check the
 * profile is in it. `codex debug prompt-input` prints the model-visible input as JSON without a
 * model request or credentials, so this proves delivery offline. Optional: `CodexAdapter.verify`
 * runs it only with `probePromptInput`. It does not make Codex `full`: `~/.codex` is still
 * visible to the real run.
 *
 * Probe facts (codex 0.154.0):
 * - With `-c developer_instructions="X"` the first developer message's first `input_text` is X.
 * - It reads CODEX_HOME and the cwd's AGENTS.md, so it runs with a scratch CODEX_HOME, HOME and
 *   cwd and an environment holding only PATH, HOME and CODEX_HOME. No secret value reaches it.
 * - It starts every configured MCP server. The probe therefore omits `mcp_servers`: verify must
 *   not run a server's command, and without its secrets the server could not start honestly.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";
import type { ProfileLaunch, ProvisionedProfile, ProvisioningCheck } from "@agent-plane/core";

type CodexConfig = NonNullable<CodexOptions["config"]>;
type CodexLaunch = Extract<ProfileLaunch, { harness: "codex" }>;

/**
 * The SDK `config` a profile launches with: operator config, then the profile's overrides, then
 * its MCP servers with secrets named in `env_vars`. `CodexAdapter` launches with exactly this.
 */
export function codexProfileConfig(base: CodexConfig | undefined, launch: CodexLaunch): CodexConfig {
  const servers = launch.mcpServers ?? {};
  const mcp_servers = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    command: server.command,
    args: [...server.args],
    ...(Object.keys(server.envRefs).length > 0 ? { env_vars: Object.keys(server.envRefs) } : {}),
  }]));
  return { ...base, ...launch.config, ...(Object.keys(servers).length > 0 ? { mcp_servers } : {}) };
}

/**
 * `--config key=value` arguments for a config object, rendered the way @openai/codex-sdk 0.154
 * renders its `config` option (dotted paths, TOML values via JSON strings). The SDK does not
 * export its serializer; a test pins this against the argv the SDK actually spawns.
 */
export function codexConfigArgs(config: CodexConfig): string[] {
  const args: string[] = [];
  const flatten = (value: unknown, prefix: string) => {
    if (!isPlainObject(value)) {
      args.push("--config", `${prefix}=${tomlValue(value, prefix)}`);
      return;
    }
    const entries = Object.entries(value);
    if (prefix && entries.length === 0) args.push("--config", `${prefix}={}`);
    for (const [key, child] of entries) {
      if (!key) throw new Error("Codex config override keys must be non-empty strings");
      if (child !== undefined) flatten(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  flatten(config, "");
  return args;
}

function tomlValue(value: unknown, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be a finite number`);
    return `${value}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v, i) => tomlValue(v, `${path}[${i}]`)).join(", ")}]`;
  if (isPlainObject(value)) {
    const parts = Object.entries(value).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlValue(v, `${path}.${k}`)}`);
    return `{${parts.join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${path}: ${value === null ? "null" : typeof value}`);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface CodexProbeResult { code: number | null; stdout: string; stderr: string }
/** Runs one command. Resolves on any exit; rejects only when the process could not start. */
export type CodexProbeRun = (command: string, args: string[], options: { env: Record<string, string>; cwd: string }) => Promise<CodexProbeResult>;

export interface CodexProbeOptions {
  codexPath: string;
  /** Operator `codex.config` the adapter launches with, so the probe renders the same overrides. */
  baseConfig?: CodexConfig;
  run?: CodexProbeRun;
  timeoutMs?: number;
}

/** The prompt the probe renders; it never reaches a model. */
export const PROBE_PROMPT = "agent-plane profile probe";

/** Checks named `prompt_input_*`. A missing binary, non-zero exit or unparsable output is a failed check, never a throw. */
export async function probeCodexProfile(profile: ProvisionedProfile, options: CodexProbeOptions): Promise<ProvisioningCheck[]> {
  const launch = profile.plan.launch;
  if (launch.harness !== "codex") return [{ name: "prompt_input_harness", ok: false, detail: `profile is for ${launch.harness}, not codex` }];
  const { mcp_servers: _started, ...config } = codexProfileConfig(options.baseConfig, launch);
  const checks: ProvisioningCheck[] = [];
  const serverCount = Object.keys(launch.mcpServers ?? {}).length;
  if (serverCount > 0) checks.push({ name: "prompt_input_mcp", ok: true, detail: `${serverCount} MCP server(s) left out of the probe: prompt-input would start them` });

  let args: string[];
  try {
    args = ["debug", "prompt-input", ...codexConfigArgs(config), PROBE_PROMPT];
  } catch (err) {
    return [...checks, { name: "prompt_input_exit", ok: false, detail: `config did not render: ${message(err)}` }];
  }
  const scratch = mkdtempSync(join(tmpdir(), "agent-plane-codex-probe-"));
  let result: CodexProbeResult;
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: scratch, CODEX_HOME: scratch };
    result = await (options.run ?? execRun(options.timeoutMs ?? 30_000))(options.codexPath, args, { env, cwd: scratch });
  } catch (err) {
    return [...checks, { name: "prompt_input_exit", ok: false, detail: `codex did not start: ${message(err)}` }];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  checks.push({ name: "prompt_input_exit", ok: result.code === 0, detail: result.code === 0 ? "codex debug prompt-input exited 0" : `codex debug prompt-input exited ${result.code ?? "on a signal"}` });
  if (result.code !== 0) return checks;

  const messages = parseMessages(result.stdout);
  checks.push({ name: "prompt_input_output", ok: messages !== undefined, detail: messages ? `${messages.length} model-visible message(s)` : "output is not a JSON list of messages" });
  if (!messages) return checks;

  const instructions = launch.config.developer_instructions;
  const firstDeveloper = messages.find((m) => m.role === "developer")?.texts[0];
  if (instructions !== undefined) {
    checks.push({ name: "prompt_input_instructions", ok: firstDeveloper === instructions,
      detail: firstDeveloper === instructions ? "developer_instructions are the first developer input, verbatim" : "the first developer input is not the profile's developer_instructions" });
  }
  // Bundle text appears once, where the profile put it, and nowhere else.
  const texts = messages.flatMap((m) => m.texts);
  const expected = instructions !== undefined ? 1 : 0;
  const stray = profile.plan.files.filter((f) => f.content.trim() !== "")
    .map((f) => ({ relPath: f.relPath, seen: texts.filter((t) => t.includes(f.content)).length }))
    .filter((f) => f.seen !== expected);
  checks.push({ name: "prompt_input_bundle_text", ok: stray.length === 0,
    detail: stray.length === 0
      ? (expected ? "bundle text appears only as developer_instructions" : "no bundle text in the model input")
      : `expected each bundle file ${expected} time(s): ${stray.map((f) => `${f.relPath} ${f.seen}`).join(", ")}` });
  return checks;
}

interface ProbeMessage { role: string; texts: string[] }

function parseMessages(stdout: string): ProbeMessage[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const out: ProbeMessage[] = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) return undefined;
    if (item.type !== "message") continue;
    if (typeof item.role !== "string" || !Array.isArray(item.content)) return undefined;
    out.push({ role: item.role, texts: item.content.filter(isPlainObject).flatMap((c) => (typeof c.text === "string" ? [c.text] : [])) });
  }
  return out;
}

function execRun(timeoutMs: number): CodexProbeRun {
  return (command, args, { env, cwd }) => new Promise((resolve, reject) => {
    execFile(command, args, { env, cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code === "string") return reject(err); // ENOENT, EACCES: never started
      resolve({ code: err ? (typeof err.code === "number" ? err.code : null) : 0, stdout, stderr });
    });
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
