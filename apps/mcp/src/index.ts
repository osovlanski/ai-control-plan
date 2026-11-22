import { loadConfig } from "./config.js";
import { startService, stderrLog } from "./service.js";

/** `pnpm --filter @agent-plane/mcp start [--config <path>]` (default: $AGENT_PLANE_MCP_CONFIG). */
const argIndex = process.argv.indexOf("--config");
const path = argIndex > 0 ? process.argv[argIndex + 1] : process.env.AGENT_PLANE_MCP_CONFIG;
if (!path) {
  process.stderr.write("usage: mcp --config <path to mcp config>  (or set AGENT_PLANE_MCP_CONFIG)\n");
  process.exit(2);
}

try {
  const service = await startService(loadConfig(path));
  const stop = () => { void service.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (err) {
  stderrLog({ event: "boot_failed", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
