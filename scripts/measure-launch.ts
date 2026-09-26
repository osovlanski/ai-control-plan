// Cold-start measurement on throwaway scratch workspaces (never the operator).
// Each run spends real provider quota. One batch (3 tasks) per invocation, from the repo root:
//   pnpm --filter @agent-plane/api exec tsx ../../scripts/measure-launch.ts <setup> <solo|concurrent>
// The curated setups read the claude-mem MCP entry from the installed plugin's own .mcp.json.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../packages/adapters/src/index.js";
import { loadConfig } from "../apps/api/src/config.js";
import { openDb } from "../apps/api/src/db/index.js";
import { buildServer } from "../apps/api/src/server.js";

const spawns = new Map<string, number>(); // cwd → spawn ms
const proto = ClaudeAdapter.prototype as unknown as { spawnProvider: (options: { cwd?: string }, state: unknown) => unknown };
const realSpawn = proto.spawnProvider;
proto.spawnProvider = function (options: { cwd?: string }, state: unknown) {
  if (options.cwd) spawns.set(options.cwd, Date.now());
  return realSpawn.call(this, options, state);
};

const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const installs = JSON.parse(readFileSync(join(claudeDir, "plugins/installed_plugins.json"), "utf8")) as { plugins?: Record<string, { installPath: string }[]> };
const pluginRoot = installs.plugins?.["claude-mem@thedotmack"]?.at(-1)?.installPath;
if (!pluginRoot) throw new Error("claude-mem@thedotmack is not installed");
const cm = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["mcp-search"];
const profileYaml = `  providerProfile: ${JSON.stringify({ plugins: ["claude-mem@thedotmack"], mcpServers: { "plugin:claude-mem:mcp-search": cm } })}\n`;
const SETUPS: Record<string, string> = {
  current: "",
  cap2: "  maxConcurrentProviderStarts: 2\n",
  curated: profileYaml,
  "cap2+curated": "  maxConcurrentProviderStarts: 2\n" + profileYaml,
};

async function measure(setup: string, mode: "solo" | "concurrent") {
  const home = mkdtempSync(join(tmpdir(), `agent-plane-measure-${setup}-`));
  mkdirSync(join(home, "scratch"), { recursive: true });
  writeFileSync(join(home, "scratch", "config.yaml"),
    `assistants:\n  scratch-claude:\n    provider: anthropic\nexecution:\n  harnessModes:\n    single: true\n${SETUPS[setup]}`);
  const config = loadConfig({ AGENT_PLANE_HOME: home, AGENT_PLANE_WORKSPACE: "scratch" });
  const db = openDb(config.dbPath);
  const built = buildServer({ config, db });
  built.registry.init(); await built.registry.syncAll();
  const one = async () => {
    const t0 = Date.now();
    const env = built.tasks.create({ goal: "Reply with the single word OK. Do not use any tools." });
    built.tasks.transition(env.taskId, "ROUTING");
    const { runId } = await built.orchestrator.startTask(env.taskId, "scratch-claude" as never);
    const state = await built.orchestrator.waitForSettled(env.taskId, 180_000);
    const total = Date.now() - t0;
    const init = db.prepare("SELECT ts FROM events WHERE run_id = ? AND type = 'run.started'").get(runId) as { ts: string } | undefined;
    const queue = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'phase' AND payload LIKE '%provider_start_queue%'").get(runId) as { payload: string } | undefined;
    const spawn = [...spawns.entries()].find(([cwd]) => cwd.endsWith(env.taskId))?.[1];
    const initMs = init ? Date.parse(init.ts) : NaN;
    const pause = (db.prepare("SELECT pause_kind FROM tasks WHERE id = ?").get(env.taskId) as { pause_kind: string | null }).pause_kind;
    const limits = (db.prepare("SELECT summary FROM events WHERE run_id = ? AND type LIKE 'limit.%'").all(runId) as { summary: string }[]).map((r) => r.summary);
    const quota = (db.prepare("SELECT raw FROM events WHERE run_id = ? AND raw LIKE '%rate_limit_event%'").all(runId) as { raw: string }[]).map((r) => JSON.parse(r.raw).rate_limit_info).map((i) => `${i.status}:${i.rateLimitType ?? ""}:${i.utilization ?? ""}`);
    return { state, pause, limits, quota, spawnToInit: spawn ? initMs - spawn : NaN, startToInit: initMs - t0, total, queueMs: queue ? JSON.parse(queue.payload).waitMs : null };
  };
  // 1 vCPU: wait for the box to be quiet before each batch (max 10 min).
  for (let i = 0; i < 60 && loadavg()[0] > 0.6; i++) await new Promise((r) => setTimeout(r, 10_000));
  const load = loadavg().map((x) => x.toFixed(2)).join("/");
  const rows = mode === "solo" ? [await one(), await one(), await one()] : await Promise.all([one(), one(), one()]);
  await built.orchestrator.shutdown(); await built.app.close(); db.close();
  for (const r of rows) console.log(JSON.stringify({ setup, mode, load1: load, ...r }));
}

const [setup, mode] = process.argv.slice(2);
if (!(setup in SETUPS) || (mode !== "solo" && mode !== "concurrent")) throw new Error(`usage: <${Object.keys(SETUPS).join("|")}> <solo|concurrent>`);
await measure(setup, mode);
process.exit(0);
