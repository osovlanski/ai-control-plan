# Stage 2: authenticated remote mode

2026-10-04 · **PROPOSED — design only; no remote auth is implemented here.**

The governing decision is [agentic-os-deployment.md](agentic-os-deployment.md),
especially “Remote security model required before deployment” and migration stage 2.
A remains current; B remains an isolated protected fixture preview until remote
auth exists; C remains the preferred long-term topology. This design does not
choose live B, authorize a public proxy, deploy anything, move provider credentials,
introduce shared SQLite writers, or specify the stage 3 registered-worker protocol.
Browser identity is independent of provider OAuth. C still requires stage 3 before
moving execution behind an OCI worker.

## Source baseline and gaps

Reviewed against `origin/main` at `bd67c09207432550072f7f58651f436e6141b8fe`.
The local graph was queried directly (the graphify CLI is unavailable); its older
commit `8fdde619f3b69022d3de5c9fe711aa6c3dbfc85c` lacks current auth nodes, so source
is authoritative. Agentic OS plans are proposals unless supported by source.

| Current evidence | Consequence for stage 2 |
| --- | --- |
| [config.ts](../../apps/api/src/config.ts), `validate`, rejects hosts other than `127.0.0.1`, `::1`, `localhost`; defaults are loopback. `loadConfig` selects a workspace directory but permits a different YAML `workspace` label. | Preserve the refusal unless a complete remote configuration validates. Bind identity to the boot-selected workspace directory, never an unvalidated display label. |
| [auth/index.ts](../../apps/api/src/auth/index.ts), `registerAuth`, requires auth metadata for API routes; only bootstrap may declare `auth:null`. Canonical origin is constructed as HTTP from bind host/port. | Keep registration-time completeness, extend it to command/resource metadata and a small explicit login exception list. Remote external origin must be independent of bind address. |
| `authenticate` accepts the workspace bearer secret or one `__Host-acp_session` cookie; `SessionMap` is in memory with `kid`, capabilities, expiry. Cookie checks accept same-origin/none Fetch Metadata **or** matching Origin. | Remote identity/session lifecycle is absent. A hostile Origin must never be overridden by Fetch Metadata. Remote requests must not accept the existing local bearer credential. |
| [bootstrap-token.ts](../../apps/api/src/auth/bootstrap-token.ts) signs audience, launcher origin, expiry, capabilities and one-time ID; `bootstrap_jti` persists consumption. | Retain the local protocol. Do not reinterpret its loopback audience as a remote audience. |
| [credential-file.ts](../../apps/api/src/auth/credential-file.ts) protects local files, rotates signing/bearer keys with grace, and narrows bootstrap capabilities to the active credential. | Local key rotation remains local; remote session revocation must not depend on its grace window. |
| [headless-open.md](../headless-open.md) describes a bounded one-page loopback launcher and SSH forwards; token is in the POST body. | This is local access, not a remote login or emergency remote bypass. |
| [server.ts](../../apps/api/src/server.ts) uses per-read capabilities and a common `commands.write` for writes, including schedule and input commands. | An authenticated owner needs explicit command grants, resource ownership and kernel preconditions, not an all-purpose write grant alone. |
| `GET /api/tasks/:id/events/stream` checks `events.stream` and task existence, sends state and subscribes to [TaskEventBus](../../apps/api/src/modules/sse.ts). `send` emits only `data:`, `sseHeaders` writes raw headers. Durable `/events` reads combine archived and live provider events. | No replay IDs, heartbeat, ongoing expiry/revocation or gap-free replay boundary exists. Provider `(run_id, seq)` is not a task-wide cursor for scheduler/state/notice frames. Raw SSE headers must preserve auth/CORS/cache headers. |
| [api.ts](../../apps/web/src/api.ts) fetches with credentials; [TaskDetail.tsx](../../apps/web/src/TaskDetail.tsx) opens a relative EventSource with `withCredentials:true`. | Same-origin works locally. Live B needs an explicit API base, credentialed CORS, login coordination and resume/client auth-failure handling. |

## Browser identity

Three suitable approaches for one owner:

| Option | Advantages | Costs and failure boundaries |
| --- | --- | --- |
| API-owned OIDC Authorization Code login with PKCE; use an owner-selected established IdP (for example Google or a managed OIDC tenant) | Standard identity proof; exact `(issuer, subject)` allowlist; existing IdP account recovery/MFA; same auth adapter on OCI or Railway. | IdP outage blocks new logins; client registration and server secret management; callback validation must be correct. |
| Identity-aware gateway with a signed identity assertion | Can centralize login and edge access policy. | API must validate assertion signature, issuer, audience, expiry and owner itself; origin must be inaccessible except through that gateway. Header trust alone is insufficient. Adds gateway coupling and a second policy boundary. |
| API-owned WebAuthn/passkeys for an out-of-band enrolled owner | No external IdP dependency; origin/RP-bound credentials. | Enrollment, multiple recovery authenticators, lost-device recovery and challenge storage become this project's responsibility. More auth product to maintain for one user. |

**Recommend API-owned OIDC code flow with PKCE**, implemented through a maintained
OIDC client rather than custom token cryptography. It fits the persistent Fastify
service and provider-adapter portability without a deployment-specific gateway.
The provider/account is an owner question, not selected by this recommendation.
The allowlist is an exact preconfigured `(iss, sub)` pair, not email, domain, name,
first-login enrollment or “any account at this provider.” The owner obtains the
subject through an out-of-band verified process before enabling remote mode.

Proposed flow: top-level navigation to `GET /api/auth/login` creates a five-minute,
single-use server transaction bound to a random browser transaction cookie,
workspace and fixed post-login destination. Generate random `state`, `nonce` and
PKCE S256 verifier/challenge. Use an exact registered callback at the canonical API
origin. `GET /api/auth/callback` consumes the transaction atomically, exchanges the
short-lived code server-side, verifies signature/algorithm, issuer, audience,
authorized party where applicable, expiry and nonce, then checks the owner pair.
Invalid transactions never mint a session; consumed callbacks cannot replay.
No caller-selected issuer, discovery URL or redirect target is accepted. B returns
to its single configured frontend origin; C returns to the canonical API origin.
[OIDC code flow and validation](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth)
define the identity checks; PKCE is an additional proposed requirement.

Use a separate `__Host-acp_login` HttpOnly/Secure/Path=/, SameSite=Lax cookie for the
cross-site top-level GET callback. The normal session can remain Strict in the
one-origin case: an existing session is not required for the callback. Clear the
transaction cookie on completion, redirect immediately to a clean URL and set
no-store/no-referrer on login/callback responses. Codes and state may transit the
OIDC redirect query but are short-lived and single-use; strip query strings from
all access logs and do not log Location headers or login URLs. Do not request
provider access or offline scopes; discard IdP tokens after identity validation.
IdP logout and application logout are separate; application logout must work
without contacting the IdP. Whether fresh MFA is required for sensitive commands
remains an owner policy question.

## Sessions, expiry and revocation

Remote cookie: `__Host-acp_remote_session=<opaque random value>; Secure; HttpOnly;
Path=/; SameSite=Strict` for one origin. No Domain attribute. B variants are below.
The value is a random 256-bit handle, not an IdP token, local `kid` or capability
claim. Cookie Max-Age must not exceed remaining server expiry. Reject duplicate
session cookies and conflicting credential types. Never store credentials in
localStorage, frontend configuration, URLs or SSE query parameters. Host cookie
prefix constraints are documented in [Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Propose a remote session table in the existing workspace DB, with only a hash of
the handle plus owner principal, immutable workspace ID, issued/last-interactive
use/absolute expiry timestamps, revoked timestamp, authorization generation and
CSRF-secret verifier. Use ordered migrations later; retain one SQLite writer.
Remote auth is separate from `SessionMap` and local credential rotation. On boot,
revoke previous remote sessions (initial conservative restart policy), prune
expired transactions, and require re-login. Availability can be revisited explicitly.

Suggested policy for owner review: 12-hour absolute expiry, 30-minute idle expiry;
SSE connections/heartbeats do not extend idle time, and automatic polling must not
keep a session alive indefinitely. An explicit CSRF-protected activity request
from actual operator interaction updates idle time. Re-login rotates the handle
and invalidates the old session; session expiry never silently extends past its
absolute deadline. Every read/write validates live session, current owner grant
and authorization generation. Removing an owner/grant or invoking an operator-local
revoke-all action invalidates sessions synchronously in the single writer.

`POST /api/auth/logout` requires Origin and CSRF, commits session revocation,
closes its streams, then expires the exact host cookie with the same Path and
SameSite attributes. Clearing a browser cookie alone is insufficient. In-flight
commands recheck authorization at the mutation acceptance boundary; work already
accepted remains governed by kernel cancellation/approval semantics. Logout does
not fabricate a cancellation of an existing run. No self-contained session JWT
with an unrevocable lifetime is proposed.

## Origin, CSRF and canonical proxy boundary

Remote canonical origin is a configured normalized HTTPS origin (scheme, host,
effective port), with no path, query, fragment or userinfo. It is never derived
from Host/forwarding input. Construct callback/redirect URLs from configuration.
Reject noncanonical authority or non-HTTPS effective requests before cookies,
login, resource reads or streams; reject rather than redirect mutating traffic.
HSTS is a requirement of the eventual approved TLS endpoint, not configured here.

For cookie-authenticated unsafe methods require both an exact allowed Origin and
a session-bound random synchronizer token in `X-CSRF-Token`; authenticate before
comparing the token in constant time. `GET /api/auth/session` returns a token only
to an authenticated allowed browser, with no-store; JavaScript holds it in memory.
Generate/store its verifier at login and retain the token in protected server
memory for delivery; after restart sessions are revoked, so token recovery is
unnecessary. Do not rotate it on each GET and break concurrent browser tabs.
Missing Origin, `Origin: null`, mismatched scheme/port, sibling origins, and token
from another session fail 403. No Referer fallback. Limit bodies and require the
route's supported content type; JSON/content type and SameSite are extra defenses,
not CSRF proof. All GET/HEAD resource routes are read-only.

For reads and SSE: if Origin is present it must match exactly. Without Origin,
only same-origin browser Fetch Metadata is accepted for resource requests; absent
or contradictory metadata fails closed. B resource requests must carry its exact
frontend Origin. `Sec-Fetch-Site: none` alone is not authorization. API navigation
is allowed only on the explicitly public login/callback routes, never as a read
bypass. The IdP callback is the narrow Origin/CSRF exception: its consumed
browser-bound OIDC transaction is required instead. Bootstrap retains its existing
local exception in local mode only. C has no cross-origin API CORS allowance.
B's configured frontend is the only extra origin; no suffix, regex, wildcard or
preview-origin matching. Exact matches use parsed normalized origins.

`server.ts` currently does not enable `trustProxy`. Proposed remote mode requires
an explicit TLS topology: direct API TLS, or a restricted ingress peer allowlist
with a defined forwarding-header contract. For terminated TLS, accept requests
only from trusted socket peers; configure Fastify trust by explicit addresses/CIDRs,
never `true` or hop count alone. The proxy must remove client Forwarded and
X-Forwarded-* fields and set one authority/protocol/client-IP representation.
Reject ambiguous/multiple/conflicting forwarding fields, wrong authority or
protocol, unknown peers and direct-origin bypass. Use the verified client address
for limits; never let a spoofed X-Forwarded-For create unlimited buckets.
[Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)
explains why forwarding headers require trust. Deployment-specific peer ranges
and header behavior must be established before any gateway approval.

## Command and workspace authorization

Carry `{principal, sessionId, workspaceId, grants, authorizationGeneration}` in
request context. The workspace ID is the boot-selected directory identity; remote
startup refuses a contradictory YAML workspace label. Stage 2 keeps one workspace
per process and DB. The owner allowlist maps to an explicit workspace and grants;
it does not grant access to another instance merely because the same IdP is used.

Keep all existing read capabilities (`tasks.read`, `events.read`, `events.stream`,
`routing.read`, `sessions.read`, `verification.read`, `schedules.read`, `models.read`,
`decisions.read`, `context.read`). Before querying, validate the principal workspace
against the instance; then resolve resources through that instance's scoped store.
Apply this to lists, meta/health/workspace, files, models, decisions/audit, scores,
schedules, inputs and streams as well as individual tasks. Joins must prove child
membership (run/session/input/checkpoint/approval belongs to the addressed task
and workspace); knowing a globally shaped ID never grants access. Unknown and
out-of-workspace resource IDs both answer 404 after instance authorization.

Extend registration-time route checks with an explicit remote command identifier
and resource resolver. The following proposed grant families cover current writes;
the implementation must inventory every method/path, including feature-flagged
input routes, and refuse startup if any route is missing metadata:

| Existing writes | Proposed command grants (names are design, not shipped capabilities) |
| --- | --- |
| Task intake; persisted route selection; start; cancel | `tasks.create`, `tasks.route`, `tasks.start`, `tasks.cancel` |
| Checkpoint, handoff, failover, parallel start, comparison resolution | `tasks.checkpoint`, `tasks.handoff`, `tasks.failover`, `tasks.parallel`, `tasks.comparison.resolve` |
| Approval responses | `approvals.respond` with approval/task membership and current pending/version checks |
| Wait and run-now | `tasks.wait`, `tasks.runNow` with generation/live-owner reconciliation guards |
| Schedule create/update/delete | `schedules.create`, `schedules.update`, `schedules.delete` |
| Assistant sync and model refresh | `assistants.sync`, `models.refresh` (external-call limits still apply) |
| Session input send, enablement and unresolved receipt reconciliation | `inputs.send`, `inputs.enable`, `inputs.reconcile` with exact session and message membership/version checks |

Remote grants are explicit, no implicit `*`; `commands.write` alone is insufficient
for remote callers. Local semantics stay unchanged. UI visibility never authorizes
commands. Recheck current grants before accepting the mutation and record a
redacted decision. Grants cannot bypass repo allowlists, approval ceilings, task
state, scheduler generation/ownership, provider-input enablement or receipt
ambiguity. Browser identity never becomes a provider identity. Stage 2 changes
neither routing explanation nor adapter/worker execution policy.

## Authenticated SSE and event resume

Keep the task stream route but validate live cookie session, exact browser origin,
`events.stream`, workspace and task membership **before** opening headers or
loading replay. Native EventSource authenticates with cookies and supports
Last-Event-ID; it does not provide an arbitrary auth-header interface.
[HTML EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html)
specifies credential mode and resume headers. Never issue a stream bearer URL.

Propose a durable, bounded per-task stream journal with an immutable workspace/
task/stream epoch and increasing sequence covering provider events, state,
scheduler and notices. Journal append must be atomic with the durable mutation
whose announcement it represents, and publication must follow commit. Do not
silently assign provider sequence numbers to nondurable state/bus announcements.
Initial connection returns an authorized current snapshot with a high-water cursor;
that snapshot is authoritative for state, not a replay of all history.

Frames carry an `id` encoding version, workspace/task/epoch and sequence. Treat it
as untrusted bounded input, not an authorization token. Resume uses Last-Event-ID;
a newly constructed EventSource may use an `after` query containing **only this
nonsecret cursor**, necessary because native EventSource cannot set that header.
Reject disagreeing header/query cursors. Validate scope before journal access,
then replay exclusively after that sequence in order. A cursor for another
workspace/task fails with a generic 404; malformed/future cursor fails 400. A
retained-out or old-epoch cursor returns 409 `resync_required` before streaming;
client fetches authorized durable reads and starts a fresh snapshot stream.
No silent history truncation or claim that a cursor authenticates its holder.

Subscribe/buffer live notifications before reading a committed high-water mark,
replay through that mark, then drain newer frames with sequence deduplication.
Bound buffer and replay size; overflow forces explicit resync/close. This avoids
the current snapshot-to-subscribe race. Client deduplicates IDs and retains the
cursor per workspace/task, never across login/workspace changes. Delivery is
at-least-once across disconnects, not exactly-once. Historic provider data predating
the journal remains available through `/events`; state is reconciled from durable
reads rather than invented historical frames.

Send comment heartbeats every 15 seconds (no ID, no idle extension); cap connection
lifetime at 10 minutes and reconnect before platform timeouts. Before each replay
batch/live frame and heartbeat validate session/grant; an expiry timer closes at
the earlier idle/absolute deadline. Revocation closes registered streams immediately
on commit; no later payload is emitted. Failed reauth closes without task payload;
reconnect returns 401/403. On an error the client closes EventSource and probes the
session endpoint. Native EventSource does not expose rejection statuses: propose
a read-only `GET /api/tasks/:id/events/stream/status?after=<cursor>` using the same
`events.stream`, origin, workspace and cursor checks, with no journal payload. A
credentialed fetch distinguishes 401/403 from 409 resync and transient connection
failure before a bounded retry; it never substitutes for checks on the real stream.
The client prompts re-login or reconciles durable reads as appropriate. An existing
stream cannot change its HTTP status after opening. Ensure raw SSE
writes merge no-store, CORS and buffering headers correctly, unsubscribe on close,
and bound blocked-client buffering and concurrent streams.

## Rate limits, audit and local coexistence

Proposed starting limits (owner may tune downward/upward after measurement):

| Surface | Buckets and enforcement |
| --- | --- |
| Local bootstrap | 5 attempts/minute per socket peer and 20/minute per instance, burst 5; count failures, retain short TTL and persistent one-use ID. |
| Remote login start/callback | 10/minute per verified client address, 30/minute instance, burst 5; cap pending transactions at 100 and TTL at five minutes. Invalid callbacks consume attempt budget. |
| Commands | 30/minute per principal+workspace, 60/minute instance, burst 10; expensive start/parallel/refresh/sync family additionally 5/minute, burst 2. Count rejected attempts too. |
| Reads/streams | 120 reads/minute per session, 10 stream opens/minute, at most 3 active streams/session and 10/instance; bound replay bytes and cursor length. |

Use injected clock and shared limiter state within the one writer process. Return
429 with bounded Retry-After before effects; avoid resource enumeration in errors.
Restart must not grant a free bypass: persist command windows/penalties and login
abuse counters, or start exhausted for one window on restart. Failed limiter/store
access fails closed for commands/login. Client IP is an abuse signal, never identity;
NAT may share limits. No credentials or entire request bodies in limiter keys/logs.

Default mode remains local: current localhost bootstrap, local bearer CLI and local
cookie protocol continue. Remote mode registers OIDC/session routes and disables
`/api/auth/bootstrap` and local bearer/local cookies entirely, even if the remote
listener happens to bind loopback. There is no local fallback when the IdP fails.
Operator recovery uses local configuration/revocation tools; returning to local
mode requires stopping remote ingress, restarting with loopback-only config and
invalidating remote sessions. A separate private local instance, if needed, gets
its own DB/workspace; never launch two kernels against the same SQLite file.
Stage 2 does not add a second listener that can mint remote sessions via bootstrap.

Protect auth/audit reads with workspace capabilities. Record principal pseudonym,
workspace/task/session/attempt IDs, command, result/reason code and time; redact
cookies, IdP tokens/codes, CSRF values and login URLs, including proxy access logs.
Do not collect provider transcripts for auth evidence. Proposed operational metrics
are aggregate auth rejections/rate-limit counts, active sessions, SSE reconnects/
resyncs, SQLite errors and approval age. Retention/access policy needs owner approval
before collecting remote personal data. Queue/worker lease monitoring remains
in the governing ADR's stage 3 scope.

## Explicit configuration contract

All names below are proposed, not accepted configuration today. A later slice
must replace the numeric-only `api.auth` validation deliberately; a partial nested
merge must not accidentally enable remote mode.

| Proposed field | Validation/default |
| --- | --- |
| `api.auth.mode: local | remote` | Absent means local; unknown/malformed value is an error. No ambient environment override, CLI bypass or generic `allowNonLoopback`. |
| `api.host`, `api.port` | Existing defaults/refusal retained in local mode. Non-loopback allowed only with explicit remote mode and every remote dependency validated before listen. Remote mode may bind loopback for testing/approved ingress. |
| `api.auth.remote.canonicalOrigin` | Required normalized HTTPS API origin, independent of bind host. |
| `api.auth.remote.browserOrigin` | Required exact HTTPS frontend origin; equal to canonical origin for one-origin topology. One extra exact origin for B; no previews. |
| `api.auth.remote.transport` | Explicit `direct-tls` with readable protected certificate/key references, or `trusted-proxy` with nonempty explicit peer addresses/CIDRs and fixed header contract. No permissive default trust. |
| `api.auth.remote.identity` | Required pinned issuer, client ID, protected client-secret reference if needed, fixed callback path and nonempty exact owner `(issuer, subject, workspaceId, grants)` mapping. Validate issuer match and supported flow/algorithms; no dynamic issuer input. |
| `api.auth.remote.session` | Explicit positive bounded absolute/idle TTL, idle <= absolute, restart revocation policy; no infinite lifetime. |
| `api.auth.remote.cookieSiteMode` | `same-origin`, `same-site-two-origin` or explicitly opted-in `cross-site-two-origin`; must agree with origin topology. Cross-site mode is gated on browser acceptance evidence below. |
| `api.auth.remote.limits` | Complete validated bounded budgets including instance caps; zero/unbounded/disabled values rejected. |

Reject unknown keys within the new security block (current broad unknown-key ignore
behavior is unsuitable here), incomplete mappings, unsupported grants, workspace
label mismatch, unsafe secret references and invalid proxy settings. Discovery,
JWKS validation readiness, DB migrations/session store and limiter setup must
succeed before listen; runtime IdP failure denies new login rather than falling
back. Client/browser config includes only the public API base, never a secret.
No actual origin, subject or secret is added by this document. The non-loopback
refusal remains in source today; deploying old code with these proposed keys must
still refuse. Auth tests passing is necessary, then explicit deployment approval
is required by the ADR; a flag alone never authorizes a gateway.

## What live B costs over one-origin C

This compares browser auth only; C's worker/migration costs remain stage 3+.

| Concern | One-origin C (also future one-origin A) | Live B: frontend Vercel, API OCI |
| --- | --- | --- |
| Cookie | Strict host cookie on the app/API host. | Cookie belongs solely to API host; frontend cannot read it. HTTPS custom subdomains under the same registrable domain can be cross-origin but same-site. Strict may then work; exact origin/CSRF still required. Unrelated sites require `SameSite=None; Secure`, and browser third-party cookie blocking can still prevent operation. |
| Login | Top-level API login/callback returns to same origin. | Navigate to API login, callback sets API cookie, then fixed frontend return. Frontend probes credentialed session and obtains CSRF in response body; no token handoff in return URL. |
| Fetch/CSRF | Relative API requests; CSRF token in header. | Explicit API base plus `credentials:include`; exact credentialed CORS. Token is fetched from API, never from a frontend-domain cookie. JSON/custom headers require preflight. |
| CORS | No cross-origin resource allowance. | Allow one configured frontend Origin; `Access-Control-Allow-Credentials:true`, `Vary: Origin`, explicit methods/headers (`Content-Type`, `X-CSRF-Token`, `Last-Event-ID` where applicable). Narrow unauthenticated OPTIONS validates origin/method/headers but accesses no data. Include CORS on allowed-origin errors and raw SSE responses; never wildcard with credentials. |
| SSE | Relative EventSource, cookie, same-origin checks and cursor. | Absolute API EventSource with credentials, exact Origin/CORS and cookie eligibility. Native SSE normally opens without a custom CSRF header; read-only GET and origin enforcement remain mandatory. Test reconnect/Last-Event-ID CORS behavior and new-instance `after` resumption. |
| Trust/operations | One external authority and one browser entrypoint. | Two exact origins, two TLS entrypoints, coordinated login destinations/API client config, CORS error behavior and compatible rollback. A compromised frontend can command the API with its granted browser session; Vercel protection alone does not authenticate the API. |
| Acceptance burden | Canonical proxy/auth tests plus one browser origin. | Add allowed/hostile sibling and preview origins, credentialed preflight, same-site and third-party-cookie-blocked browser cases, cross-origin SSE/error paths. Fixture previews remain denied production API access. |

Cross-site cookie operation is **not guaranteed by setting None**. If the owner's
supported browsers block third-party cookies, live B with unrelated sites cannot
meet this cookie design. Choose same-site custom origins or revisit topology;
do not weaken cookies, put tokens in URLs, or proxy today's local API to make it
appear to work. A future authenticated same-origin backend facade would be a
separate design with session propagation and streaming costs, not this proposal.
The choice of live B versus C is left to the owner, with these incremental costs
visible. Choosing C's auth topology does not waive its worker prerequisites.

## Stage 2 acceptance cases — run later entirely on loopback

These are executable specifications for a later implementation, **not tests run
by this docs-only change**. Use temporary isolated W1/W2 directories/DBs, fake
adapters, an injected clock and local fake OIDC issuer/JWKS. Run the API and a
minimal sanitizing TLS proxy bound to loopback, with test-only certificates and
HTTPS logical origins resolved to loopback. Production config still requires
HTTPS; test machinery supplies local endpoints without opening a public listener.
Use real browser contexts for cookies/CORS/SSE and real HTTP sockets for raw proxy
and streaming behavior; Fastify injection alone cannot prove those surfaces.
No provider login, credentials, quotas or deployment account required. Collect
redacted statuses, journal IDs, DB diffs, fake-dispatch counts and stream captures.

| Case | Setup | Action | Expected result |
| --- | --- | --- | --- |
| Hostile origin / CSRF | Owner W1 session and valid token; allowed frontend and attacker origins. | From attacker, null, absent, sibling, wrong scheme/port and preview origins, attempt read, command, session-token fetch and SSE; spoof same-origin Fetch Metadata with hostile Origin via raw client. | 403 before data/effects/stream headers; no ACAO for attacker; DB and fake dispatch unchanged. Valid origin + missing/wrong/other-session CSRF also 403. Valid origin+token executes exactly once; permitted same-origin GET without Origin works only with correct metadata. |
| OIDC owner / transaction | Fake issuer signs owner and nonowner subjects. | Login owner; try nonowner with same email, wrong issuer/audience/signature/nonce, missing transaction cookie/state, expired code and reused callback; supply external return target. | Only exact configured owner yields fresh remote cookie; failures mint no session, callback replay fails, external return cannot redirect outside fixed origin. Transaction consumed once; clean redirect/logs contain no tokens/codes/login URL. |
| Expiry / revocation / logout | Session with short absolute/idle TTL, authorized stream open; another session and old handle retained. | Advance clock to each deadline while heartbeats/polling continue; logout with correct CSRF, revoke-all, remove grant/owner, restart. Reuse old handles for read/write/resume. | 401 after expiry/revocation, 403 for removed command grant; no new effect. Streams close at deadline or revocation commit and emit no subsequent task data. Logout expires cookie and persists revoke; invalid-CSRF logout fails 403. Polling/SSE cannot extend idle or absolute TTL; restart invalidates prior remote sessions. |
| Workspace escape / child membership | W1 owner session; W2 has task/run/session/approval/input/schedule/event data; colliding-shaped IDs in fixtures. | Send W1 cookie to W2 API; address W2 IDs through W1, use W2 run as W1 winner, W2 approval/input/cursor, mismatched workspace body/query/header or repo traversal. | Unknown cookie on W2 is 401; an authenticated principal with mismatched instance scope is 403; out-of-workspace resource 404, no enumeration or payload and no mutations in either DB. Nested resources must belong to task. Invalid workspace selectors are rejected; disallowed repo remains refused. Every list/read/write, including feature-enabled input routes, has scope metadata. |
| Command-level denial | W1 identity grants reads and create only. | Try every other registered command, especially approval, run-now, schedule, refresh and input enable/reconcile, with valid origin+CSRF and `commands.write` alone. | 403 and zero effects; creating succeeds under its grant. Missing route metadata prevents startup. Fully granted but stale approval/wait/input versions or bad kernel state still fails existing preconditions. |
| SSE resume, races and retention | W1 journal seeded with provider/state/scheduler/notice frames; owner stream receives cursor N. | Disconnect, append N+1/N+2, reconnect with Last-Event-ID N; append during replay/subscription boundary; construct new EventSource with `after=N`; overflow buffer, trim history, restart stream epoch. | Ordered authorized frames after N, no missing boundary event; IDs allow dedup across reconnect. New instance resumes identically. Old/trimmed cursor gets explicit 409 resync before headers, followed by authorized reads/fresh snapshot; overflow explicitly closes/resyncs. No fabricated provider history. |
| SSE cursor/auth abuse | Owner W1 session and journal; read-only session without stream grant. | Resume with W2/task-other cursor, malformed/oversized/future cursor, conflicting header/query, no cookie, expired cookie, query credential only or missing stream grant; revoke during replay. Repeat on stream/status and drive the browser error handler. | Scope mismatch 404, malformed/future/conflicting 400, oversized input bounded/rejected, missing/expired credential 401, missing grant 403; no replay fetch across scope. Revocation stops subsequent batches; URL credential never authenticates. Status probe exposes no journal payload; browser distinguishes re-login, resync and bounded transient retry. |
| Canonical proxy | Loopback TLS proxy with pinned peer/header contract and canonical API authority; alternate peer fixture. | Send legitimate request; forged Host/forwarded host/proto/IP, HTTP effective proto, multiple/conflicting chains, untrusted peer or direct-origin connection; change chain length to try bypass. | Legitimate HTTPS request succeeds and sets secure host cookie/fixed callback. Others rejected before auth/data/cookie; forwarded fields cannot alter redirects or limiter address. Direct-TLS variant accepts no forwarding-derived identity. |
| Limits / secrecy | Inject small budgets, clock and limiter failure/restart fixture; capture app/proxy logs. | Flood failed login/bootstrap, valid/invalid commands, stream opens; spoof client IP; restart within window; fail limiter storage. | 429 with Retry-After at budget, no excess dispatch or sessions; restart preserves penalty or exhausted window. Login/commands fail closed on store failure. Logs/captures exclude credential values, codes, login URLs and provider transcripts. |
| Local / remote configuration | Existing default config and local launcher fixtures; complete remote config on loopback. | Run current local bootstrap/rotate/read-only/replay tests; try non-loopback without mode, incomplete/unknown remote keys, HTTP origin, permissive proxy, empty owners, label mismatch; use local bearer/bootstrap/local cookie on remote mode. | Local behavior/short TTL/one-use survives; all invalid configurations fail before listen. Only complete explicit remote config enables remote routes; local credentials/bootstrap cannot mint or access remote sessions, IdP failure cannot fall back. Old source continues refusing non-loopback. |
| Two-origin B browser matrix | Two local HTTPS origins with real browser; API-only host cookie, exact frontend CORS. Test same-site pair and unrelated-site pair with third-party cookies blocked. | Login/return/session fetch, CSRF command, preflight, SSE initial/resume/error; repeat from preview/hostile origin and with blocked cookie policy. | Supported same-site pair succeeds with cookie absent from JS/URL and correct CORS on SSE/errors. Hostile/preview origin gets no API access. Blocked cross-site cookie path shows authentication unavailable and sends no command; it blocks selecting that topology, not the security controls. One-origin case remains independently runnable. |

The implementation slice must report PASS only after all cases for the selected
topology execute and match. Ambiguous output is FAIL with raw redacted capture;
unreachable observable state is BLOCKED with the exact stopping point. This
session's runtime verdict is **SKIP: documentation only**.

## Open questions for the owner

These remain undecided; the numbers and mechanisms above are proposals.

1. Which identity provider/account and exact subject should be allowlisted? What
   MFA/fresh-auth guarantee is required, and how will the owner recover an account
   or update its subject safely without first-login enrollment?
2. After remote auth exists, choose live B or continue toward C's one-origin
   topology? If B, use same-site custom origins or accept a cross-site deployment
   subject to the supported-browser cookie gate? Which browsers must work?
3. Approve or adjust session absolute/idle limits, restart logout and revoke-all
   recovery procedure. Which commands, if any, need fresh IdP authentication?
4. What explicit owner command grants should remote mode expose, and should any
   administrative/approval/input commands remain local-only? Is a separate
   read-only remote session profile wanted?
5. What canonical API/frontend origins, TLS termination contract and trusted proxy
   peer addresses will the later approved gateway actually provide? No deployment
   values are chosen here.
6. Approve rate budgets, stream lifetime/connection caps, replay retention/byte
   limits and resync UX. How much resume history is needed after a long disconnect?
7. Who may read remote audit data, and what retention/deletion period applies to
   session identity records, journal entries and auth audit records? What minimum
   metrics may be collected before the remote personal-data policy is approved?
8. Who performs the out-of-band enrollment and emergency revoke/config recovery,
   and what stage 2 evidence will they review before the ADR's separate deployment
   approval? Stage 3 worker identity/dispatch questions remain out of scope.
