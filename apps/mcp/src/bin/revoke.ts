import { loadConfig } from "../config.js";
import { OAuthStore } from "../oauth/store.js";

/**
 * `pnpm --filter @agent-plane/mcp revoke --all [--config <path>]`: revokes every grant and token and
 * deletes every client registration and consent. Clients must log in again. The plane is untouched.
 */
const args = process.argv.slice(2);
const i = args.indexOf("--config");
const path = i >= 0 ? args[i + 1] : process.env.AGENT_PLANE_MCP_CONFIG;
if (!args.includes("--all") || !path) {
  process.stderr.write("usage: revoke --all --config <path>  (or set AGENT_PLANE_MCP_CONFIG)\n");
  process.exit(2);
}
const store = new OAuthStore(loadConfig(path).stateDb);
const { grants, clients } = store.revokeAll();
store.close();
process.stdout.write(`revoked ${grants} grant(s), removed ${clients} client(s)\n`);
