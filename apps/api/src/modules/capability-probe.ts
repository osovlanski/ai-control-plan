import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface ProbeResult { fingerprint: string; version: string; authState: string; models: string[]; configHash: string }
export type CapabilityProbe = (provider: string) => Promise<ProbeResult>;

export async function probeCapability(provider: string): Promise<ProbeResult> {
  const root = provider === "anthropic" ? join(homedir(), ".claude") : provider === "openai" ? join(homedir(), ".codex") : "";
  const command = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : undefined;
  const version = command ? safeVersion(command) : "in-process";
  const authState = root && (existsSync(join(root, ".credentials.json")) || existsSync(join(root, "auth.json"))) ? "ok" : provider === "fake" ? "ok" : "missing";
  const files = root ? ["config.json", "settings.json", "settings.local.json", "config.toml"] : [];
  if (provider === "anthropic") files.push("../.claude.json", "plugins/installed_plugins.json");
  const content = [...files.map((name) => fileSignature(join(root, name))), directorySignature(join(root, "skills")), directorySignature(join(root, "plugins"))].join("|");
  const configText = files.map((name) => safeText(join(root, name))).join("\n");
  const models = provider === "fake" ? ["fake-1"] : Array.from(configText.matchAll(/model\s*[:=]\s*["' ]?([A-Za-z0-9._-]+)/gi), (m) => m[1]!).sort();
  const configHash = createHash("sha256").update(content).digest("hex");
  const details = JSON.stringify({ version, authState, models, configHash });
  return { version, authState, models, configHash, fingerprint: createHash("sha256").update(details).digest("hex") };
}
function safeVersion(command: string): string {
  try { return execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim(); } catch { return "unavailable"; }
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
