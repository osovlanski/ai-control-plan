# MCP connector for Claude mobile and Codex CLI

2026-11-21 · **ACCEPTED design, not implemented.** No MCP code exists on `main` at `8a10689`.
Slices C1 (plane API), C2 (`apps/mcp`) and C3 (rollout) implement it. Public exposure in C3 needs
itay's explicit approval; nothing in this document authorizes a tunnel, DNS record or deployment.

Contract: [`contracts/mcp-tools/v1/`](../../contracts/mcp-tools/v1/README.md) (tool definitions,
input/output/error JSON Schemas, fixtures). Related: [agentic-os-deployment.md](agentic-os-deployment.md)
(governing deployment decision), [remote-auth-design.md](remote-auth-design.md) (stage 2 browser auth).

## Decision

From Claude on a phone, the owner creates a task in an allowed personal repository, sees the
proposed route, starts it, and gets back the task id and a private Web link at once while the run
continues on the OCI host. Approvals, input, cancel and Autopilot administration stay in the Web UI.

| Id | Decision | Status |
|---|---|---|
| D-A | Owner identity is Google OIDC with an exact `(iss, sub)` pin. The same pin authorizes the remote Web login (B2) and the MCP OAuth login (C2). Tailscale Serve is the network boundary and trusted proxy for the Web origin, not an identity on its own. | **Decided** by itay, decision card in "Plan Mobile, MCP and OCI milestone", 2026-11-21 |
| D-B | One plane process, two loopback listeners. The existing listener keeps local bootstrap, the bearer CLI and local cookies unchanged; a second loopback listener (the Tailscale Serve target) accepts only remote sessions and can never mint one from bootstrap. B2 records the amendment in `remote-auth-design.md`. | **Accepted** on recommendation, no objection from itay (same thread) |
| D-C | A separate `apps/mcp` process on its own loopback port, reachable from the internet only through Cloudflare Tunnel. It is the OAuth authorization server and resource server for MCP clients, and it calls the plane over loopback with a dedicated credential that holds only `tasks.read`, `tasks.create` and `tasks.start`. The Web UI and plane API are never on the tunnel. | **Accepted** on recommendation, no objection from itay (same thread) |

Why a separate process: the deployment ADR rejects "a public proxy to today's loopback API". The
MCP process is a narrow facade with four tools, its own token store and its own rate limits, so a
compromise of an MCP token or of the MCP process reaches create/start in allowlisted repos and
nothing else. It cannot approve, answer input, cancel, change routing policy, touch schedules or
operate Autopilot, because the credential it holds cannot.

## Source baseline (verified at `8a10689`)

| Evidence | Consequence |
|---|---|
| `POST /api/tasks` (`apps/api/src/server.ts`) creates a `CREATED` task, checks `repoAllowed` (exact path or path prefix of `config.repoAllowlist`) and has no idempotency key. | C1 adds `idempotencyKey`. A path-prefix allowlist is wider than "these repos": the MCP layer maps aliases to exact paths (below). |
| `POST /api/tasks/:id/route` runs `orchestrator.routeTask(…, 'intake')` and returns a `RoutingExplanation`; it persists a routing decision, so it is a write. `POST /api/tasks/:id/compose` returns a composer preview with `compositionDigest` when `composer.enabled`. | create_task's proposal comes from these two services, called by the plane inside the create command (C1), not recomputed by the MCP process. |
| `POST /api/tasks/:id/start` refuses any state but `CREATED` (409). With the composer on, a sent `compositionDigest` that no longer reproduces is drift: 409 with the new preview, no run. | A second start can never create a second run of the same task. start_task's `confirm` reuses the drift check. |
| Writes are gated by one `commands.write` capability (`packages/core/src/contracts.ts`). | C1 adds `tasks.create` and `tasks.start`; `commands.write` implies both so existing credentials keep working. |
| `rotateCredential` (`apps/api/src/auth/credential-file.ts`) expires every active secret when it mints a new one. | **Finding:** there is no way to hold a second, narrower credential beside the CLI's. C1 must add a separately named credential (its own file or `kid`) that rotation of the main one does not expire. |
| The Web UI routes a task at `#/missions/<taskId>` (`apps/web/src/shell/routes.ts`); there is no `/tasks/:id` page. | **Finding:** the preflight's "origin + /tasks/:id" is wrong. The Web link is `<private Web origin>/#/missions/<taskId>`. |
| Task ids are `AG-` plus base36 (`newTaskId`, `packages/core/src/ids.ts`). | The contract pins `^AG-[0-9a-z]{1,32}$`. |
| `GET /api/tasks` serves `stage` (task-stage v1); `GET /api/tasks/:id` serves runs with effective state. Verification runs have states `ready/claimed/completed/interrupted` and check statuses `passed/failed/skipped/blocked`. | get_task and list_tasks project these reads; the MCP process derives nothing. |
| No `@modelcontextprotocol/*` dependency, no `apps/mcp`. | Greenfield. |

## Topology

```
Claude cloud (all Claude clients, incl. mobile) ─┐
Codex CLI (owner's laptop or the box) ───────────┤ HTTPS
Owner's phone browser (OAuth login only) ────────┘
        │
   Cloudflare edge ── Cloudflare Tunnel (outbound-only cloudflared on the host)
        │
   127.0.0.1:<mcp port>  apps/mcp   (Streamable HTTP /mcp, OAuth AS, own SQLite file)
        │  loopback HTTP, bearer = narrow plane credential
   127.0.0.1:<plane port> apps/api  (unchanged local listener; never on the tunnel)

   Tailscale Serve ── 127.0.0.1:<remote web port>  (B2/B3; the private Web link points here)
```

- Claude connects to remote MCP servers "from Anthropic's cloud infrastructure, rather than from
  your local device … including … the mobile apps" (Claude Help Center), so the MCP endpoint must
  be publicly reachable; Tailscale-only is not an option for the connector. Anthropic's outbound
  range is published as `160.79.104.0/21`.
- The Web link is private: it opens only on a device in the owner's tailnet. That is intended.
- The tunnel ingress maps one hostname to the MCP port only. A Cloudflare rule allows only
  `/mcp`, `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server`,
  `/.well-known/openid-configuration` and `/oauth/*`; everything else is dropped at the edge.
- The MCP process binds `127.0.0.1` only and refuses any other bind, like the plane does today.
- The MCP process keeps OAuth state in its own SQLite file. It never opens the plane database
  (one writer per DB stays true). Idempotency records live in the plane (C1), because only the
  plane can make "record the key" and "create the task" one transaction.

## Tools (contract `mcp-tools/v1`)

All four tools return `structuredContent` that matches the tool's `outputSchema`, plus a short
text block for clients that ignore structured output. Domain failures return `isError: true` with
`structuredContent` matching `tool-error.schema.json`. Authentication failures are HTTP 401/403 at
the transport, never tool results.

| Tool | Scope | Plane calls (C1 shapes) | Notes |
|---|---|---|---|
| `list_tasks` | `aos.tasks.read` | `GET /api/tasks` | Only tasks whose repo is an exposed alias. Goal cut to 200 chars. `limit` 1–50. |
| `get_task` | `aos.tasks.read` | `GET /api/tasks/:id` (+ stage, verification read) | A task outside the exposed repos is `not_found`, same as an unknown id. `pendingApprovals` is a count only. |
| `create_task` | `aos.tasks.create` | `POST /api/tasks` with `idempotencyKey` and `propose: true` | Creates `CREATED` and returns the proposal. Never starts. |
| `start_task` | `aos.tasks.start` | `POST /api/tasks/:id/start` with `idempotencyKey` and `confirm` | Starts once. Returns as soon as the plane accepts the start. |

Annotations (`tools.json`): the reads are `readOnlyHint: true`; create and start are
`readOnlyHint: false, destructiveHint: false, idempotentHint: true`. The owner sets create and
start to "needs approval" in Claude's connector settings and in Codex (`tools.<tool>.approval_mode`),
so a model cannot start work without a human tap (see threat T3).

### Repositories

The MCP config holds an exposed-repo map `alias → absolute path`, for example
`dogfood-cockpit → <path>`. At boot the MCP process reads `GET /api/workspace` and refuses to
start if any mapped path is not exactly (not by prefix) in the plane's `repoAllowlist`. Tools take
and return aliases only, so a client never sees or sends a filesystem path, and a path-prefix
trick (`<allowed>/../other`, `<allowed>-evil`) has nothing to bind to. Tasks without a repository
cannot be created through MCP.

### Create, then start

- `create_task` → plane create command. C1 makes the plane create the task, run the routing
  service (and the composer preview when it is on) and store the result in one request, and
  return `{ task, proposal, webLink }`. The proposal is advisory: start re-routes.
- `start_task` with `confirm: { assistantId, compositionDigest }` copied from the proposal. The
  plane re-routes; if the chosen assistant differs from `confirm.assistantId`, or the composer's
  digest differs from `confirm.compositionDigest`, it starts nothing and the tool returns
  `route_changed` with the new proposal. Without `confirm` the plane starts on whatever it routes
  now (allowed, but the tool description tells the model to pass it).
- `no_eligible_assistant` when nothing passes the filters; `invalid_state` (with `currentState`)
  when the task is not `CREATED` and the key is not a replay.

### Idempotency

- Both write tools require `idempotencyKey` (`^[A-Za-z0-9._:-]{16,128}$`). The plane stores
  `(credential kid, operation, key) → (request fingerprint, response, created_at)`, where the
  fingerprint is SHA-256 of the canonical JSON of the normalized arguments without the key
  (for start, the task id is part of them).
- Same key, same fingerprint → the first response, with `replayed: true`, and no new effect.
  A replayed create returns the first result verbatim (state `CREATED`); the caller reads current
  state with `get_task`.
- Same key, different fingerprint → `idempotency_conflict` (plane 409), no effect.
- Same key while the first request is still in flight → `idempotency_in_progress`, retryable.
- The key record and the task row (or the start's state transition) commit in one SQLite
  transaction. Records are kept at least 7 days.
- A model can mint a fresh key on a retry. That can make an extra `CREATED` task (visible, inert,
  never started) but never an extra run, because start only moves a `CREATED` task and the second
  start of a started task is `invalid_state`. Keeping create and start separate is what makes
  retries safe even when the key discipline fails.

### Web link and promptness

The plane publishes `webLink` on task reads and on create/start responses when a private Web
origin is configured (C1; the value is the remote canonical origin from B2's configuration plus
`/#/missions/<taskId>`). The MCP process passes it through and never builds a URL from request
headers. Without a configured origin the MCP process refuses to start (configuration error), since
every result must carry the link.

`start_task` returns once the plane has accepted the start, with `runId` when the run row exists
(nullable in the contract so C1 can return before worktree setup if that is slow). C2's acceptance
bound is 2 seconds from request to tool result with the FakeAdapter.

## Access model (MCP authorization)

Normative source: the MCP authorization specification. `latest` resolves to **2026-07-28**;
Claude's connector docs say Claude follows the **2025-03-26, 2025-06-18 and 2025-11-25**
authorization specifications. C2 implements the intersection, which the 2025-11-25 text describes:

- **Resource server.** `/mcp` implements OAuth 2.0 Protected Resource Metadata (RFC 9728) and
  answers an unauthenticated request with 401 and `WWW-Authenticate: Bearer resource_metadata=…,
  scope="aos.tasks.read aos.tasks.create aos.tasks.start"`. Insufficient scope is 403 with
  `error="insufficient_scope"`. Tokens are validated per OAuth 2.1 §5.2 and must have been issued
  for this resource (RFC 8707 audience = the canonical MCP URL). "MCP servers MUST NOT accept or
  transit any other tokens": the plane credential is never shown to clients, and client tokens are
  never sent to the plane.
- **Authorization server, co-hosted in `apps/mcp`.** OAuth 2.1 authorization code with PKCE `S256`
  only (no `plain`, no implicit, no password grant), RFC 8414 metadata, `iss` in authorization
  responses (RFC 9207), `resource` required on authorize and token requests and bound to the
  grant.
- **Client registration.** Support both mechanisms the clients use: Client ID Metadata Documents
  (the spec's SHOULD; Claude lists `oauth_cimd`, Codex prefers CIMD when the server advertises
  `client_id_metadata_document_supported: true` and `none` auth) and Dynamic Client Registration
  (deprecated in the latest spec but listed by both Claude, `oauth_dcr`, and Codex). Registration
  does not grant access: every grant still needs the owner's login and consent. Redirect URIs are
  checked against a fixed allowlist: exactly `https://claude.ai/api/mcp/auth_callback` (Claude's
  documented callback for hosted apps, which covers mobile), and RFC 8252 loopback redirects on
  `http://127.0.0.1:<any>/…` and `http://localhost:<any>/…` (Claude Code and Codex CLI use
  ephemeral loopback ports). Any other redirect is refused at registration and at authorize.
  DCR is rate-limited and registrations not used within 24 hours are deleted.
- **Owner login (D-A).** The authorize endpoint is a top-level browser page. It sends the owner
  to Google with its own OIDC client registration (separate client id and callback from the Web
  login's, same pin), verifies the ID token as `remote-auth-design.md` specifies (signature,
  issuer, audience, expiry, nonce, PKCE), and continues only if `(iss, sub)` equals the configured
  owner pair exactly. Email, domain or name never authorize. Google tokens are discarded after
  verification; no Google scopes beyond `openid` are requested.
- **Consent.** After login the page shows the client name, the redirect host and the requested
  scopes, and the owner approves once per client. Consent POST requires a CSRF token and an exact
  `Origin`. A client's later grant asking for more scopes needs a new consent.
- **Tokens.** Opaque 256-bit random values, stored as SHA-256 hashes. Access tokens live 15
  minutes (Claude refreshes on 401 and up to five minutes before expiry). Refresh tokens rotate
  on every use with reuse detection: presenting a spent refresh token revokes the whole grant.
  Absolute grant lifetime 30 days, then a new login. No `offline_access` in advertised scopes. A
  local `pnpm --filter @agent-plane/mcp revoke --all` (C2) revokes every grant and client.
- **Transport.** Streamable HTTP per the 2025-11-25 transport spec: validate `Origin` on every
  request and answer 403 to a present, unlisted Origin (the allowlist is empty for `/mcp`, since
  no browser calls it); check `Host` equals the canonical host (DNS rebinding); require a
  supported `MCP-Protocol-Version`; issue random `MCP-Session-Id` values bound to the token's
  grant, so a session id alone authorizes nothing. No server-to-client sampling or elicitation.
- **Plane credential (D-C).** A separately named credential (C1 finding above) with exactly
  `tasks.read`, `tasks.create`, `tasks.start`. The MCP process reads it from a 0600 file owned by
  the user that runs the MCP process; the agent user (P0-A2) cannot read it. It is never logged.
- **Codex CLI.** Configure `[mcp_servers.aos] url = "https://<mcp host>/mcp"` and run
  `codex mcp login aos` (or `--no-browser` on the box and paste the redirect). Static bearer
  (`bearer_token_env_var`) is accepted only on a separate loopback-only dev listener in C2 tests,
  with `FAKE-*-not-real` values, never on the tunnel.
- **Rate limits (MCP side, owner may tune).** Per grant: 60 reads/minute, 10 creates/hour,
  10 starts/hour; per instance: 3× those. Authorize and token endpoints: 10/minute per client
  address, 30/minute per instance. 429 → `rate_limited` with `retryAfterSeconds`.
- **Optional edge hardening.** A Cloudflare rule may limit `/mcp` to Anthropic's range plus the
  owner's Codex hosts; the `/oauth/*` pages must stay open to the phone's mobile network. Do not
  put Cloudflare Access in front of `/mcp`: Claude's cloud cannot complete an Access login.

**ChatGPT (note only, no work scheduled).** OpenAI's help center ("Connecting custom MCP servers
in ChatGPT") says full MCP with write actions is for Business and Enterprise/Edu workspaces,
Pro gets read/fetch only, and custom MCP servers are web-only ("Can I connect custom MCP servers
on mobile? No"). The goal flow is phone-first, so ChatGPT does not meet it on a personal plan
today. The server above is standard MCP OAuth, so nothing here blocks adding it later.

## Threats

| # | Threat | Mitigation | Tested in |
|---|---|---|---|
| T1 | Token theft (client token store, logs, proxy) | Short access tokens, rotating refresh with reuse revocation, hashed at rest, audience-bound to this MCP URL, never logged (query strings and `Authorization` stripped from logs), local revoke-all. A stolen token reaches only create/start in exposed repos. | C2 |
| T2 | Replay of a create/start request or OAuth artifacts | Idempotency keys make request replay return the first result; codes single-use with 60 s life, PKCE, `state`, `iss`; consumed refresh tokens revoke the grant. | C1, C2 |
| T3 | Prompt-injected create/start (a web page or repo file tells the model to run work) | Create and start are separate tools; owner sets both to "needs approval" in the client; repo must be an exposed alias; start returns the route for review; the run still meets the plane's approval ceilings and every tool-use approval is answered on the Web, never via MCP. Owner question Q1: run MCP-created tasks as the agent user. | C2, C3 |
| T4 | Repo escape (`..`, prefix siblings, symlinks, other allowlisted paths) | Aliases only; exact-path check against `repoAllowlist` at boot; plane re-checks `repoAllowed` on create. | C1, C2 |
| T5 | Enumeration of tasks, repos or ids | Reads filter to exposed repos; out-of-scope and unknown ids are the same `not_found`; aliases never reveal paths; read rate limit. | C2 |
| T6 | Non-owner login, or a rogue client registered by anyone | Exact `(iss, sub)` pin; DCR/CIMD grant nothing without owner login + consent; redirect URI allowlist; consent shows client and redirect host. | C2 |
| T7 | Confused deputy / token passthrough | The MCP process holds its own plane credential and never forwards client tokens; the plane credential cannot approve or operate Autopilot (403). | C1, C2 |
| T8 | DNS rebinding or local processes reaching the loopback port | `Host` and `Origin` checks; every request still needs a bearer token, so loopback reachability alone grants nothing (unlike a trusted identity header). | C2 |
| T9 | Edge exposes more than MCP | Tunnel ingress maps only the MCP port; edge path allowlist; plane and Web are not on the tunnel; C3 checks that `/api/*` and `/` 404 at the edge. | C3 |

## Acceptance cases

C1 (plane, `pnpm dev`, FakeAdapter, credential holding only `tasks.read`, `tasks.create`, `tasks.start`):
1. Two identical creates with one key → one task; the second response is the first with `replayed: true`.
2. Same key, different goal → 409 conflict; no task.
3. Two starts with one key → one run; a start with a new key on the started task → 409 `invalid_state` with the current state.
4. Start with `confirm.assistantId` that no longer routes → refused, no run, new proposal returned.
5. The narrow credential gets 403 on approve, input, cancel, routing/schedule writes and every Autopilot route; `commands.write` still passes create/start.
6. Rotating the main credential does not expire the MCP credential.
7. `webLink` is `<configured origin>/#/missions/<id>` and is absent when no origin is configured.
8. Fixtures in `contracts/mcp-tools/v1/fixtures` pass/fail under strict Ajv2020 (conformance test).

C2 (`apps/mcp` on loopback, a fake OIDC issuer, an MCP SDK client or MCP Inspector, plane on `pnpm dev` with FakeAdapter; no tunnel):
1. Unauthenticated `/mcp` → 401 with `resource_metadata`; metadata documents parse.
2. Full code+PKCE flow with the fake issuer: owner `(iss, sub)` → token; another `sub`, same email → refused; wrong `iss` → refused.
3. Redirect URI outside the allowlist → refused at registration and authorize; CIMD and DCR both work.
4. Token with a different `resource`/audience → 401; expired → 401; spent refresh token → grant revoked.
5. `list_tasks`, `get_task`, `create_task`, `start_task` round-trip; outputs validate against the contract; start returns in under 2 s while the fake run continues; `get_task` later shows the run.
6. Retry of create/start with the same key → replayed, no duplicate task or run; different input → `idempotency_conflict`.
7. Unknown alias and a task in a non-exposed repo → `repo_not_allowed` / `not_found`, and the plane saw no call.
8. Present unlisted `Origin` → 403; wrong `Host` → refused; MCP process refuses a non-loopback bind.
9. Logs contain no token, code, cookie or plane credential (grep of the captured log).

C3 (owner-approved rollout on OCI): connector added in Claude (web), used from Claude mobile over
mobile data; then Codex CLI via `codex mcp login`; non-owner Google account refused; `/api/*` and
`/` return 404 at the edge; revoke-all ends both clients' access. Rollback: stop and disable
`cloudflared`, delete the tunnel's DNS record, run revoke-all, stop `apps/mcp`; the plane is
untouched throughout.

## Owner questions (not blocking C1/C2)

1. Should MCP-created tasks run as the agent user (`runAs: "agent"`, P0-A2) whenever the host
   configures one? Recommended yes: a prompt-injected task then cannot reach the plane's files.
2. Which repos go in the first exposed-repo map? Recommended: only the dogfood repo already in
   the live allowlist.
3. Which Cloudflare hostname, and is the optional `/mcp` IP rule wanted (it blocks Codex from
   networks not listed)?

## Sources

- MCP authorization, latest (2026-07-28): https://modelcontextprotocol.io/specification/latest/basic/authorization
- MCP authorization 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP transports 2025-11-25 (Streamable HTTP, Origin, sessions, protocol header): https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Claude connector authentication (auth types, callback URL, refresh, egress range): https://claude.com/docs/connectors/building/authentication
- Claude connector building (transports, followed auth spec versions): https://claude.com/docs/connectors/building
- Claude custom connectors (plans, tool permissions): https://claude.com/docs/connectors/custom
- Claude Help Center, custom connectors using remote MCP (cloud origin, mobile, plans): https://support.claude.com/en/articles/11175166
- Codex MCP configuration and `codex mcp login` (CIMD/DCR choice, loopback callback): https://developers.openai.com/codex/mcp
- OpenAI Help Center, connecting custom MCP servers in ChatGPT: https://help.openai.com/en/articles/12584461
- RFC 9728, RFC 8414, RFC 8707, RFC 9207, RFC 8252, RFC 7591; OAuth 2.1 draft 13; OpenID Connect Core 1.0.

Sources read 2026-11-21. Client behavior changes; C3 re-checks the Claude and Codex docs before rollout.
