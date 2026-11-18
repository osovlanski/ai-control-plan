import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeFor, type ProbeSpec } from "./runtime-catalog.js";

const execFileAsync = promisify(execFile);

export interface ProbeResult { fingerprint: string; version: string; authState: string; models: string[]; configHash: string }
export type CapabilityProbe = (provider: string, options?: Record<string, unknown>) => Promise<ProbeResult>;

/**
 * The provider branches this used to hold are now `RuntimeDescriptor.probe` in the runtime
 * catalogue. An uncatalogued provider gets the empty spec, which is what the old branches gave it.
 */
export async function probeCapability(provider: string, options: Record<string, unknown> = {}): Promise<ProbeResult> {
  const spec: ProbeSpec = runtimeFor(provider)?.probe ?? {};
  // Kept as the empty string when there is no config root: the directory signatures below then
  // read `skills`/`plugins` relative to the working directory, exactly as before (a pre-existing
  // quirk this refactor preserves so fingerprints do not move; see the PR notes).
  const root = spec.configRoot ? join(homedir(), spec.configRoot) : "";
  const version = spec.command ? await probeVersion(spec.command) : "in-process";
  const credentialEnv = spec.credentialEnv?.(options);
  const authState = credentialEnv !== undefined
    ? (process.env[credentialEnv] ? "ok" : "missing")
    : root && (spec.authFiles ?? []).some((name) => existsSync(join(root, name))) ? "ok" : spec.fixed ? spec.fixed.authState : "missing";
  const files = root ? ["config.json", "settings.json", "settings.local.json", "config.toml", ...(spec.extraConfigFiles ?? [])] : [];
  const content = [...files.map((name) => fileSignature(join(root, name))), directorySignature(join(root, "skills")), directorySignature(join(root, "plugins"))].join("|");
  const configText = files.map((name) => safeText(join(root, name))).join("\n");
  // Feeds the fingerprint only: a changed model config should trigger a
  // re-describe(). The adapter's describe() remains the authority on models.
  const models = spec.fixed ? [...spec.fixed.models] : Array.from(configText.matchAll(/model\s*[:=]\s*["' ]?([A-Za-z0-9._-]+)/gi), (m) => m[1]!).sort();
  const configHash = createHash("sha256").update(content).digest("hex");
  const details = JSON.stringify({ version, authState, models, configHash, credentialEnv });
  return { version, authState, models, configHash, fingerprint: createHash("sha256").update(details).digest("hex") };
}
/**
 * Async on purpose: this runs on the boot path and in the daily job, and the
 * API is single-threaded. A synchronous spawn here freezes every request, SSE
 * stream, and in-flight agent run for up to the timeout, per provider.
 */
export async function probeVersion(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      timeout: 1_500,
      killSignal: "SIGKILL",
    });
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}
function safeText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
function directorySignature(path: string): string {
  if (!existsSync(path)) return "";
  try { return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.isDirectory() ? directorySignature(join(path, entry.name)) : fileSignature(join(path, entry.name))).join("|"); } catch { return ""; }
}
function fileSignature(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch { return ""; }
}
