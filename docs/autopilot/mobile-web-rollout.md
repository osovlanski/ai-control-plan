# Mobile Web rollout (B3): the private Web link on the OCI box

Owner steps to put the Web UI behind Tailscale Serve so it opens from the owner's phone, signed in
with Google. Design: `docs/adr/remote-auth-design.md` (section A9 is the source of the step order;
A3 and A4 are the header and config contracts). This page changes nothing by itself and **needs
itay's go-ahead before step 6**; nothing in the repo authorizes a live change.

Conventions. Every command runs on the box as the plane user unless it says "tailnet device".
Placeholders, never real values: `<plane dir>` is the workspace directory (it holds
`config.yaml`), `<remote port>` is `api.remote.port` (any free loopback port, not `api.port`),
`<box>.<tailnet>.ts.net` is the box's tailnet name, `<canonicalOrigin>` is
`https://<box>.<tailnet>.ts.net`. Secrets (client secret, owner sub) are typed or pasted on the
box, never written into this repo, a ticket or a chat. The plane runs as
`systemctl --user ... agent-plane-operator` (restore runbook); if you run `pnpm dev` instead,
stop and start that.

What you end up with: one HTTPS origin, reachable only from the owner's tailnet, whose remote
listener (loopback, `<remote port>`) accepts only a Google login that matches the pinned `(iss, sub)`.
The local listener, the CLI bearer and local cookies stay exactly as they are.

Step order matters: the listener starts only after Google discovery answers, so config and secret
must exist before the restart, and Serve points at a port that is already listening.

## 1. Google Web OAuth client

Google Cloud console, APIs & Services, Credentials: create an OAuth client of type **Web
application**.

- Authorized redirect URI, exactly: `<canonicalOrigin>/api/auth/callback`. No trailing slash, no
  extra URIs.
- Authorized JavaScript origins: leave empty.
- Consent screen: External, Testing, with only your own Google account as a test user, scope
  `openid` only.
- Note the client id; download or copy the client secret once.

Verify: the console lists exactly one redirect URI and it matches the string above character for
character. A mismatch shows later as `redirect_uri_mismatch` at Google.

Rollback: delete the OAuth client in the console. Nothing on the box has used it yet.

## 2. Get the owner `sub`, out of band

The pin is the Google account's `sub` (a stable numeric string), never the email. Get it without
involving the plane: sign in to your own account at Google's OAuth 2.0 Playground with scope
`openid`, exchange the code, and read `sub` from the decoded `id_token` payload (any JWT decoder
run locally; do not paste the token into a web tool). `sub` is the same for the same Google
account across clients, so this value is valid for the client from step 1.

Verify: the value is a string of digits, about 21 characters, and you got it from your own
account's token. Record it only in the config of step 4.

Rollback: nothing to undo. Discard the token.

## 3. Client secret file (mode 600)

```sh
umask 077
install -m 600 /dev/null <plane dir>/remote-oidc-client-secret
read -rs S && printf '%s' "$S" > <plane dir>/remote-oidc-client-secret; unset S
```

Verify (the plane refuses to boot otherwise: regular file, owned by the plane user, no group or
other bits):

```sh
stat -c '%a %U %F' <plane dir>/remote-oidc-client-secret      # 600 <plane user> regular file
```

Rollback: `shred -u <plane dir>/remote-oidc-client-secret` (and delete the client in step 1 if you
are abandoning the rollout).

## 4. `api.remote` and `mcp.webOrigin` in `<plane dir>/config.yaml`

Back up first: `cp <plane dir>/config.yaml <plane dir>/config.yaml.pre-b3`.

```yaml
api:
  remote:
    port: <remote port>
    canonicalOrigin: <canonicalOrigin>
    transport: { kind: trusted-proxy, peers: ["127.0.0.1"], tailscaleUserLogin: <owner's tailnet login> }
    identity:
      issuer: https://accounts.google.com
      clientId: <Web OAuth client id from step 1>
      clientSecretFile: <plane dir>/remote-oidc-client-secret
      owner: { issuer: https://accounts.google.com, subject: <owner sub from step 2> }
    grants: [tasks.read, commands.write]     # explicit; see the note below
mcp:
  webOrigin: <canonicalOrigin>               # same origin, so MCP Web links open the private link
```

Notes.

- `grants` is an explicit list. `autopilot.operate` and `usage.write` are never grantable
  remotely. `commands.write` is what lets the phone approve a tool use; it is the deviation
  recorded in the ADR (A5). Drop it for a read-only phone.
- `mcp.webOrigin` must be the same string as `canonicalOrigin`. If `mcp.repos` is already in the
  file (the MCP runbook adds it), keep it; the two keys live in one `mcp:` block.
- Unknown keys anywhere under `api.remote` are an error, and so is a `workspace` label that
  disagrees with the selected workspace.

Verify: there is no separate dry-run command. The plane parses `api.remote` strictly at boot and
lists every problem at once, then refuses to start, for example `api.remote.identity.clientSecretFile
must not be readable by group or others`. Step 5's log check is the verification; re-read the file
once for typos against the block above before restarting.

Rollback: `cp <plane dir>/config.yaml.pre-b3 <plane dir>/config.yaml`, restart (step 5).

## 5. Restart the plane

```sh
systemctl --user restart agent-plane-operator
journalctl --user -u agent-plane-operator -n 50 --no-pager
```

A restart revokes every remote session (none exist yet) and interrupts any running window: do it
between windows, with `GET /api/autopilot` showing `stopped` or no attempt in flight.

Verify, on the box:

```sh
journalctl --user -u agent-plane-operator --no-pager | grep '"event":"remote_auth".*"action":"listen"'
ss -ltn | grep -E '127.0.0.1:<remote port>\b'                  # listening on loopback only
curl -s localhost:<plane port>/api/health                         # local listener unchanged
```

Until Google discovery answers, nothing listens on `<remote port>` and the log retries every
minute; the local listener serves as usual meanwhile. A bind other than `127.0.0.1` is a bug:
stop and report it.

Rollback: restore `config.yaml.pre-b3` (step 4) and restart. The remote listener disappears and the
local one is unchanged.

## 6. Tailscale Serve (tailnet only, never Funnel) — needs itay's approval

The box must be a user-owned tailnet node (not a tagged node), because the plane checks the
`Tailscale-User-Login` header against `transport.tailscaleUserLogin`. HTTPS certificates must be
enabled for the tailnet.

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:<remote port>
```

Verify:

```sh
tailscale serve status        # one https=443 entry proxying to http://127.0.0.1:<remote port>
tailscale funnel status       # must report nothing exposed; Funnel stays off
```

From a tailnet device (the phone on Wi-Fi with Tailscale on):
`curl -sI <canonicalOrigin>/` answers 200 with the sign-in page, not 403. A 403 before any login
means the header contract (ADR A3) failed; read the `remote_auth` reason codes in the journal.
Confirm these headers hold on this box before relying on it: exactly one `Host` and
`X-Forwarded-Host` equal to the canonical authority, `X-Forwarded-Proto: https`, one
`X-Forwarded-For`, `Tailscale-User-Login` equal to the configured login, no `Forwarded`, no
`Tailscale-Funnel-Request`.

From a device **not** on the tailnet (phone on mobile data with Tailscale off): the name does not
resolve or the connection fails. That is the proof it is private.

Rollback:

```sh
sudo tailscale serve --https=443 off       # or: sudo tailscale serve reset
```

Then `tailscale serve status` shows nothing and the tailnet device above can no longer connect.

## 7. Sign in from the phone

On the phone (Tailscale on): open `<canonicalOrigin>`, sign in with the owner Google account, land
on the Missions view.

Verify:

- Signing in with a different Google account is refused, even with the same email domain.
- Journal lines for the login carry `event: "remote_auth"` with a pseudonym and a reason code, and
  no cookie, code, state, token or URL.
- Idle for the idle TTL (default 30 minutes) or sign out: the next request needs a new login.

Rollback: sign out in the app, or `systemctl --user restart agent-plane-operator` (every restart
revokes all remote sessions). To remove access entirely, undo steps 6, 5/4, 3 and 1 in that order.

## Rollback in one pass

1. `sudo tailscale serve --https=443 off`
2. Restore `config.yaml.pre-b3`, `systemctl --user restart agent-plane-operator`
3. `shred -u <plane dir>/remote-oidc-client-secret`
4. Delete the Google OAuth client.

The plane, its database and the local listener are untouched throughout.
