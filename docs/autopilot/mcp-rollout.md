# MCP connector rollout (C3): Claude mobile and Codex over a Cloudflare tunnel

Owner steps to expose `apps/mcp` to Claude (including the phone app) and Codex CLI. Design and
threat model: `docs/adr/mcp-connector.md`; service config: `apps/mcp/README.md`. **Public exposure
needs itay's explicit approval; do not run step 6 or later without it.** Steps 1 to 5 stay on the
box and expose nothing.

Do the Mobile Web rollout (`mobile-web-rollout.md`) first: the MCP process refuses to start unless
the plane publishes a private Web origin (`mcp.webOrigin`), because every tool result carries a Web
link.

Conventions. Commands run on the box as the plane user. Placeholders only: `<plane dir>`,
`<plane port>` (the local `api.port`), `<mcp port>` (any free loopback port), `<mcp host>` (the
public hostname you pick in Cloudflare, no path), `<publicUrl>` is `https://<mcp host>`,
`<canonicalOrigin>` is the private Web origin from the Web rollout, `<alias>` and `<repo path>`
are the exposed repo (recommended: only the dogfood repo already in the plane's `repoAllowlist`).
No secret, hostname, tunnel id or sub goes into the repo, a ticket or a chat.

Owner decisions this page needs (ADR questions 1 to 3): run MCP-created tasks as the agent user
(`runAs: agent`, recommended yes), the first exposed repo, and the Cloudflare hostname and whether
to add the optional `/mcp` IP rule.

What you end up with: Claude's cloud and Codex reach only `<publicUrl>/mcp` and the OAuth pages.
The plane, the Web UI and everything else are not on the tunnel. A client token can only create
and start tasks in the exposed repo; approvals stay in the Web UI.

## 1. Narrow plane credential

```sh
pnpm --filter @agent-plane/api rotate --name mcp
```

This writes `<plane dir>/api-credential.mcp.json` with exactly `tasks.read, tasks.create,
tasks.start`. Rotating the main CLI credential does not expire it.

Verify:

```sh
stat -c '%a %U' <plane dir>/api-credential.mcp.json       # 600 <mcp service user>
```

The file must be readable by the user that runs `apps/mcp` and not by the agent user. The
printed `kid` lists the three capabilities and nothing else.

Rollback: delete `<plane dir>/api-credential.mcp.json` (the plane then rejects the MCP process).

## 2. Plane config: exposed repos and `runAs`

Back up: `cp <plane dir>/config.yaml <plane dir>/config.yaml.pre-c3`. In `<plane dir>/config.yaml`:

```yaml
mcp:
  webOrigin: <canonicalOrigin>          # already set by the Web rollout
  repos: { <alias>: <repo path> }       # exact entry of repoAllowlist, not a prefix
  runAs: agent                          # needs execution.agentUser; omit if the owner says no
```

Restart between windows: `systemctl --user restart agent-plane-operator`.

Verify:

```sh
journalctl --user -u agent-plane-operator -n 30 --no-pager      # no mcp config error
curl -s localhost:<plane port>/api/health
```

The plane refuses to boot if `repos` has a path that is not exactly in `repoAllowlist`, if the
alias is malformed, or if `runAs: agent` has no `execution.agentUser`.

Rollback: restore `config.yaml.pre-c3`, restart.

## 3. Second Google OAuth client for MCP

Same console as the Web rollout, a **separate** Web application client (separate id and secret,
same owner pin):

- Authorized redirect URI, exactly: `<publicUrl>/oauth/callback`.
- Scope `openid` only; your own account stays the only test user.

Secret file, mode 600, owned by the MCP service user:

```sh
umask 077
install -m 600 /dev/null <mcp dir>/oidc-client-secret
read -rs S && printf '%s' "$S" > <mcp dir>/oidc-client-secret; unset S
stat -c '%a %U %F' <mcp dir>/oidc-client-secret       # 600 <mcp service user> regular file
```

Owner `sub`: the same value used in the Web rollout (same Google account). Nothing new to fetch.

Rollback: `shred -u <mcp dir>/oidc-client-secret`; delete the OAuth client in the console.

## 4. MCP config

`<mcp dir>/mcp.yaml` (keep it outside the repo; every key is required unless marked optional, and
an unknown key is an error):

```yaml
listen: { host: 127.0.0.1, port: <mcp port> }
publicUrl: <publicUrl>
plane: { url: http://127.0.0.1:<plane port>, credentialFile: <plane dir>/api-credential.mcp.json }
repos: { <alias>: <repo path> }                  # same alias and exact path as the plane's mcp.repos
owner: { issuer: https://accounts.google.com, subject: <owner sub> }
oidc: { issuer: https://accounts.google.com, clientId: <MCP OAuth client id>, clientSecretFile: <mcp dir>/oidc-client-secret }
stateDb: <mcp dir>/mcp-oauth.db                  # never the plane database
# optional: trustCloudflareClientIp: true        # only once the tunnel is the sole ingress (step 6)
```

Verify: step 5 is the check. The process refuses to boot on a non-loopback bind, a missing plane
Web origin, a mapped path that is not exactly in the plane's `repoAllowlist`, or a plane older
than API 2.14, and the message names the cause.

Rollback: delete `<mcp dir>/mcp.yaml`.

## 5. Start `apps/mcp` on loopback and check it locally

```sh
pnpm --filter @agent-plane/mcp start --config <mcp dir>/mcp.yaml
# run it under a user service or tmux so it survives the shell; no unit file is shipped yet
```

Verify (still no tunnel; run on the box):

```sh
ss -ltn | grep -E '127.0.0.1:<mcp port>\b'                              # loopback only
curl -si http://127.0.0.1:<mcp port>/mcp | head -5
```

The second command: a 401 with `WWW-Authenticate: Bearer resource_metadata=...`. The Host check
means a request addressed to `127.0.0.1` may be refused instead; if so, send
`-H 'Host: <mcp host>'`. A 401 with the metadata pointer is the pass; a 200 is a failure, stop.
Logs (stderr, JSON lines) contain method, path, status and duration only; grep them for a token
or cookie and expect nothing.

Rollback: stop the process; delete `<mcp dir>/mcp-oauth.db` if you want a clean state.

## 6. Cloudflare Tunnel to the MCP port only — needs itay's approval

Install `cloudflared`, sign in (`cloudflared tunnel login`), then:

```sh
cloudflared tunnel create aos-mcp
cloudflared tunnel route dns aos-mcp <mcp host>
```

`<cloudflared dir>/config.yml`:

```yaml
tunnel: <tunnel id>
credentials-file: <cloudflared dir>/<tunnel id>.json
ingress:
  - hostname: <mcp host>
    service: http://127.0.0.1:<mcp port>
  - service: http_status:404
```

Only the MCP port is mapped. Never add the plane port or the remote Web port. Add a Cloudflare
WAF custom rule that blocks the hostname unless the path is one of: `/mcp`,
`/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server`,
`/.well-known/openid-configuration`, `/oauth/*`. Do not put Cloudflare Access in front of `/mcp`
(Claude's cloud cannot complete a login). Optional: limit `/mcp` to Anthropic's published range
(`160.79.104.0/21`) plus your Codex hosts, keeping `/oauth/*` open to the phone's mobile network;
this blocks Codex from unlisted networks.

```sh
cloudflared tunnel --config <cloudflared dir>/config.yml run aos-mcp      # or a service, your choice
```

Verify (from any machine, not only the box):

```sh
curl -si <publicUrl>/mcp | head -5            # 401 + resource_metadata
curl -s -o /dev/null -w '%{http_code}\n' <publicUrl>/api/health      # 404
curl -s -o /dev/null -w '%{http_code}\n' <publicUrl>/                # 404
curl -s <publicUrl>/.well-known/oauth-protected-resource/mcp | head -c 300
```

The two 404s are the check that the plane and the Web UI are not exposed. If either answers 200,
stop the tunnel (rollback) and report. Once this passes you may set `trustCloudflareClientIp: true`
in `mcp.yaml` and restart the MCP process.

Rollback:

```sh
# stop cloudflared (Ctrl-C, or: systemctl --user stop cloudflared)
# remove the <mcp host> DNS record in the Cloudflare dashboard
cloudflared tunnel delete aos-mcp            # after the process is stopped
```

Confirm `curl -si <publicUrl>/mcp` no longer reaches the service.

## 7. Add the connector in Claude, then use it on the phone

Claude on the web: Settings, Connectors, add a custom connector with the URL `<publicUrl>/mcp`.
Sign in with the owner Google account on the consent page that opens, review the client name,
redirect host and scopes, approve. Then set `create_task` and `start_task` to **needs approval**
in the connector's tool permissions (this is the prompt-injection guard, ADR threat T3). Open the
Claude mobile app on mobile data (Wi-Fi off, Tailscale off) and ask it to list tasks, create a task
in `<alias>`, then start it after you read the proposal.

Verify:

- `list_tasks` returns tasks only from `<alias>`.
- `create_task` returns a task id, a proposal and a Web link `<canonicalOrigin>/#/missions/<taskId>`;
  nothing runs. `start_task` (confirmed in the app) returns within a couple of seconds with the
  same link; the run proceeds on the box.
- Repeating a start returns the first result, not a second run.
- Approvals do not exist as tools; the approval is answered on the Web link from a tailnet device.
- A non-owner Google account is refused on the consent page.

Rollback (access only): in Claude, remove the connector; on the box, revoke every grant:

```sh
pnpm --filter @agent-plane/mcp revoke --all --config <mcp dir>/mcp.yaml
```

After `revoke --all` the app's next call must fail authorization and need a new consent.

## 8. Codex CLI

In Codex's config (`~/.codex/config.toml`):

```toml
[mcp_servers.aos]
url = "<publicUrl>/mcp"
```

```sh
codex mcp login aos            # on the box add --no-browser and paste the redirect URL back
```

Set the create and start tools to need approval (`tools.<tool>.approval_mode`). Never configure a
static bearer for this server; the static dev bearer exists only on a separate loopback listener
for tests.

Verify: `codex mcp list` shows `aos` with tools `list_tasks`, `get_task`, `create_task`,
`start_task`; a `list_tasks` call returns the same tasks as in step 7.

Rollback: remove the `[mcp_servers.aos]` block; run `revoke --all` as above.

## 9. Recheck the client docs before the first real use

Client behavior changes. Before step 7, re-read the Claude connector and Codex MCP pages listed in
the ADR's Sources and confirm the callback URL (`https://claude.ai/api/mcp/auth_callback`) and the
supported auth spec versions still match what the ADR assumes.

## Rollback in one pass (public access off)

1. Stop `cloudflared`; remove the DNS record; `cloudflared tunnel delete aos-mcp`.
2. `pnpm --filter @agent-plane/mcp revoke --all --config <mcp dir>/mcp.yaml`.
3. Stop `apps/mcp`.
4. Optional: restore `config.yaml.pre-c3`, delete `api-credential.mcp.json`, delete the MCP OAuth
   client and `oidc-client-secret`.

The plane, the Web link and the Web login are untouched by any of this.
