# @agent-plane/mcp

Owner-only MCP connector for Claude (incl. mobile) and Codex CLI. Design and threat model:
[docs/adr/mcp-connector.md](../../docs/adr/mcp-connector.md). Tool contract:
[contracts/mcp-tools/v1](../../contracts/mcp-tools/v1/README.md).

It binds `127.0.0.1` only and calls the plane over loopback with the narrow named credential
(`pnpm --filter @agent-plane/api rotate --name mcp`). Public exposure (C3) is a separate,
owner-approved step; nothing here opens a tunnel.

```
pnpm --filter @agent-plane/mcp start --config <mcp.yaml>     # or AGENT_PLANE_MCP_CONFIG=<path>
pnpm --filter @agent-plane/mcp revoke --all --config <mcp.yaml>
```

Config (every owner decision is a required field with no default):

```yaml
listen: { host: 127.0.0.1, port: <port> }
publicUrl: https://<mcp host>            # canonical origin; resource = <publicUrl>/mcp; Host must match
plane: { url: http://127.0.0.1:<plane port>, credentialFile: <workspace dir>/api-credential.mcp.json }
repos: { <alias>: <absolute path> }      # each alias must also be in the plane's mcp.repos, same path
owner: { issuer: https://accounts.google.com, subject: <owner's Google sub> }
oidc: { issuer: https://accounts.google.com, clientId: <this service's OAuth client>, clientSecretFile: <0600 file> }
stateDb: <path>/mcp-oauth.db             # OAuth state; never the plane database
# optional
devBearer: { port: <port>, tokenEnv: AOS_MCP_DEV_BEARER }   # loopback-only static bearer, local dev and tests
trustCloudflareClientIp: false
rateLimits: { readsPerMinute: 60, createsPerHour: 10, startsPerHour: 10, instanceFactor: 3, oauthPerMinutePerAddress: 10, oauthPerMinutePerInstance: 30 }
```

The OIDC client's redirect URI is `<publicUrl>/oauth/callback`. Secret files must be regular files
owned by the service user with mode 0600. Logs (stderr, JSON lines) carry method, path, status and
duration only: no query strings, headers, tokens or bodies.
