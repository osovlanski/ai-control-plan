# Plan: vNext Increment 2 — Authenticated transport and command authorization
_Locked via claudex-loop — by Claude + Itay. Decisions locked at recommendation via the escape hatch ("resume … as recm"). Revised after Codex review rounds 1–4._

`PLAN_FILE=docs/increment-2-auth-plan.md`, `LOG_FILE=docs/increment-2-auth-review-log.md` (the repo-root `PLAN.md` / `PLAN-REVIEW-LOG.md` belong to the prior orchestrator-cutover loop and are left untouched).

## Goal

Close `docs/agentic-os-vnext-plan.md` §3.8 for **every** client of the control-plane API, before any write capability or new execution path exists. After this increment: an unauthenticated request to **any** `/api/*` endpoint is rejected — the sole exception is `POST /api/auth/bootstrap`, which is not unauthenticated (it authenticates by a one-time HMAC token). The built-in `apps/web` client works end to end with its **only** credential being an `HttpOnly` cookie that no JavaScript path can read; a `commands.write` authorization gates every state-changing route, and a read capability gates every read route, each independently grantable; credentials live in an OS-permissioned file that rotates with a grace window and no restart; and no credential ever lands in a log, event, artifact, error body or telemetry payload. The loopback bind stays, demoted to defence in depth (CR-12).

Scope is `ai-control-plan` (`apps/api` + `apps/web`). The Cockpit `ControlPlaneClient` change is a documented follow-up in the `cockpit` repo (`docs/increment-2-cockpit-followup.md`); it is blocked on increment 1a (the compat policy) and is not required to meet any acceptance criterion of *this* increment.

## Trust boundary (principal model)

The security principal is the **OS user account**. Everything under `<config.dir>` (`~/.agent-plane/<workspace>/`) — the workspace DB, the credential file, and the launcher's bootstrap handoff file — is protected at mode `0600`/`0700` and is readable only by that user. A hostile process running **as the same user** is explicitly out of scope: it can already read the credential file directly, so no in-process channel can defend against it. "Readable by another local process" in the roadmap's prohibited-channels list is read in that light — it forbids *broadcasting* a credential to processes that should not see it (child-process env vars, `argv`, `ps` output, world-readable files, URLs that reach shell history / server logs / referrers), not defending a `0600` file against its own owner. The bootstrap token is held to exactly the credential file's protection class, no weaker.

## Approach

### 1. Credential file (`apps/api/src/auth/credential-file.ts`)

- Path: `<config.dir>/api-credential.json` — same owner-only directory as the workspace DB.
- Shape:
  ```json
  {
    "version": 1,
    "secrets": [
      {
        "kid": "k_1a2b3c4d",
        "secret": "<base64url, 32 random bytes>",
        "capabilities": ["tasks.read","events.read","events.stream","routing.read","sessions.read","verification.read","approvals.read","commands.write"],
        "createdAt": "2026-09-03T19:00:00.000Z",
        "notAfter": null
      }
    ]
  }
  ```
- **Directory + file validation** (before any read or create; refuse to start on failure, with the exact `chmod`/`chown` to run):
  - Directory: create with `{ recursive: true, mode: 0o700 }`; if it already exists, `chmodSync(dir, 0o700)` and assert `statSync(dir)` is a directory, `st.uid === process.getuid()`, `(st.mode & 0o077) === 0`.
  - File: `lstatSync` — must be a regular file (not a symlink / FIFO / socket), `st.uid === process.getuid()`, `(st.mode & 0o077) === 0`.
- **First-boot creation:** write with `flag: "wx"` (`O_EXCL`) + `mode: 0o600`; on `EEXIST`, another process won the race — re-read instead. One secret, every read capability **plus** `commands.write`. Log the **path only**, never the secret. Auth is ON from the first request; there is no "auth disabled" mode.
- **Load + snapshot:** read the file into an immutable in-memory snapshot `{ secrets, ino, size, mtimeNs }`. `isActive(secret, now)` = `secret.notAfter === null || Date.parse(secret.notAfter) > now`. **`isActive` is evaluated on every authentication against the injected clock** — never only at load — so a secret expires on schedule with no filesystem event.
- **Reload:** a bearer/bootstrap `kid` that resolves to nothing **awaits** a reload before it is allowed to `401` — never rejects first. Concurrent misses share one in-flight reload promise (coalesced); reloads are debounced so a burst triggers one re-read, but **every individual miss awaits the current-or-next reload and then re-checks** — the debounce coalesces, it never skips the reload a given miss is entitled to. So the sequence "bogus miss reloads, then a real rotated key arrives 10 ms later" still gives the real key its own awaited reload; it cannot be starved. mtime/ino/size are only a "skip the re-parse if nothing changed" optimisation — correctness never depends on them (rapid atomic replaces can share an mtime). A reload parses + validates the whole file, builds a complete new snapshot, swaps it atomically only on success; a parse error keeps the old snapshot and logs.
- **Rotation is the only writer at runtime besides first-boot;** both take a lockfile `<path>.lock` (created `flag: "wx"`, JSON body `{ pid, startedAt }`). A lock is **stale** — and reclaimed — when its `pid` is dead (`process.kill(pid, 0)` throws `ESRCH`) or its `startedAt` is older than 30 s. Writers re-read under the lock, write a unique temp file in the same directory, `fsync` the file **and** the directory, `rename`, then remove the lock in `finally`.

### 2. Rotation (`apps/api/src/bin/rotate-credential.ts`, `pnpm --filter @agent-plane/api rotate`)

- Under the lockfile: append a new secret (capabilities copied from the newest active secret unless `--capabilities` given), stamp `notAfter = now + api.auth.rotationGraceSeconds` on every previously-active secret, atomic-write at mode `0600`.
- No restart. The running server adopts the new secret via the mtime-gated reload the first time a client presents it; old secrets keep authenticating until their `notAfter`.
- **Grace (bearer):** an in-flight bearer client on the old secret keeps getting `200` until `notAfter`, then `401`; it re-reads the file and presents the new secret. Tested with clock advance only.
- **Grace (browser):** the session record stores the minting `kid`. Once that secret fails `isActive`, the session no longer authenticates → `401` → SPA shows the expired state → operator re-runs the launcher → fresh cookie. Tested.

### 3. Bootstrap token (`apps/api/src/auth/bootstrap-token.ts` — `mint` + `verify`, shared by launcher and server)

A constrained JWT-shaped string, HMAC-SHA256 via `node:crypto`, no new dependency:

```
token = b64url(header) "." b64url(payload) "." b64url(sig)
header  = { "alg": "HS256", "typ": "acp-bootstrap" }
payload = { "aud": "<api origin, scheme://host:port>", "kid": "<secret kid>",
            "jti": "<16 random bytes b64url>", "exp": <unix seconds>,
            "lo":  "<exact launcher origin, http://127.0.0.1:<ephemeralPort>>",
            "cap": ["…subset of the minting secret's capabilities…"] }
sig     = HMAC-SHA256(secret[kid], b64url(header) "." b64url(payload))
```

`lo` is the exact origin of the launcher's ephemeral listener (§7), known before minting because the listener binds its port first. The exchange accepts the token **only** when the request's `Origin` equals `lo` exactly — no other value, no exception — so the single origin that can ever redeem a given token is the one throwaway listener that minted it. Immediately after minting, the launcher also registers the token string in **its own** append-only redaction-literal set (§11), before opening the browser or logging anything.

- `exp = now + api.auth.bootstrapTtlSeconds` (default **10 s**).
- Minting requires reading `api-credential.json`; a process without filesystem access to the `0600` file cannot forge a token.
- The token appears in exactly one place: the HTTP response body the launcher's **in-memory, single-shot** ephemeral listener returns to the browser (§7), as a hidden form field, for the milliseconds between page load and auto-submit. That is the roadmap's "launcher-mediated form POST" channel. It is **never** written to disk, **never** in a URL, query string, fragment, env var, or argv, **never** in any durable store, and **never logged** — it is consumed on first exchange and discarded (roadmap: "the token is never stored"). This is distinct from `apps/web`: the running application never holds a token in any form — its sole credential is the `HttpOnly` cookie.

### 4. Exchange endpoint (`POST /api/auth/bootstrap`)

A top-level **form POST navigation** (`application/x-www-form-urlencoded`, body field `token`) that responds with a redirect — no `fetch`, so there is no CORS surface and no preflight. A urlencoded body parser is added with `app.addContentTypeParser` (~5 lines; no `@fastify/formbody` dependency).

Checks, in order; every failure returns `400` with a generic body (`{ "error": "bootstrap rejected" }`), logs a fixed redacted reason (`"bootstrap: signature mismatch"`), and **never echoes the token**:

1. Token parses; `header.typ === "acp-bootstrap"`.
2. **`Origin` header must equal `payload.lo` exactly** (the launcher's ephemeral origin baked into this token) — **no other value, no exception, not even the API origin**; absent or anything else → `403`, before the HMAC is checked. (`--origin` dev mode only changes the token's `aud` / the form's `action` target; the page is still served from, and submits from, the launcher's ephemeral `lo`.) `Sec-Fetch-Site: cross-site` with a named http/https `Origin` → `403`. A copied token is unusable outside the one listener that minted it.
3. `payload.aud` equals `${scheme}://${config.api.host}:${config.api.port}` — else `401`.
4. `payload.exp > now()` — else `401`.
5. `payload.kid` resolves to an **active** secret; `timingSafeEqual(sig, HMAC(secret, signingInput))` — else `401`.
6. **Atomic consume:** `INSERT INTO bootstrap_jti (jti, expires_at) VALUES (?, ?)` with `expires_at = payload.exp` (migration `013`). A `SQLITE_CONSTRAINT` unique violation → `401` (**replay**, including two concurrent exchanges of the same token and replay after a server restart). There is **no** prior `SELECT` — the insert *is* the consume. A periodic sweep deletes expired rows.
7. **Only after** the insert succeeds, mint a session: `sid = 32 random bytes b64url`; `sessions.set(sid, { kid, capabilities: payload.cap ∩ secret.capabilities, expiresAt: now + api.auth.sessionTtlSeconds })` — in-memory `Map`, default TTL **12 h**. A restart drops sessions (→ browser re-auth); acceptable and desirable.
8. Response `303 See Other`:
   - `Location: ${apiOrigin}/`
   - `Set-Cookie: __Host-acp_session=<sid>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<sessionTtlSeconds>` — `__Host-` prefix (no `Domain`, `Path=/`, `Secure`) so a co-resident `127.0.0.1:<other-port>` service cannot shadow or fixate the cookie.
   - `Referrer-Policy: no-referrer`, `Cache-Control: no-store`

### 5. The auth hook (`apps/api/src/auth/index.ts` → `registerAuth(app, { config, credentials, sessions, now })`)

**Every `/api/*` route MUST carry an explicit `config.auth` metadata block** naming the capability it requires (or `null` for the one unauthenticated route):

```ts
app.get("/api/tasks",  { config: { auth: { require: "tasks.read" } } }, handler);
app.post("/api/tasks", { config: { auth: { require: "commands.write" } } }, handler);
app.post("/api/auth/bootstrap", { config: { auth: null } }, handler);   // the only null
```

There is **no default**. `registerAuth` walks the route table with an `onRoute` hook and **throws at startup** if any `/api/*` route lacks `config.auth` — so a future sessions / approvals / verification / artifacts route cannot silently ship with the wrong (or no) read authority. `auth: null` is honoured only for an explicit `{ method, path }` allowlist of exactly one entry: `POST /api/auth/bootstrap`.

**The full route → capability map** (every read route gets its *natural* capability from the existing seven, not a blanket `tasks.read`):

| Routes | `config.auth.require` |
|---|---|
| `GET /api/meta`, `/api/health`, `/api/workspace`, `/api/assistants`, `/api/assistants/changes`, `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/files/*`, `/api/scores`, `/api/cooldowns`, `/api/tasks/:id/comparison`, `/api/tasks/:id/handoffs`, `/api/tasks/:id/checkpoints` | `tasks.read` |
| `GET /api/tasks/:id/events` | `events.read` |
| `GET /api/tasks/:id/events/stream` | `events.stream` |
| `GET /api/tasks/:id/routing` | `routing.read` |
| `GET /api/tasks/:id/sessions`, `/api/sessions`, `/api/sessions/:id` | `sessions.read` |
| `GET /api/sessions/:id/verification` | `verification.read` |
| every `POST` / mutating route (tasks, sync, route, start, input, cancel, checkpoint, handoff, parallel, comparison/resolve) | `commands.write` |
| `POST /api/auth/bootstrap` | `null` |

Each `config.auth.require` is exactly one capability string — no `anyOf`. Six of the seven `OBSERVABILITY_CAPABILITIES` map to a live endpoint here (`tasks.read`, `events.read`, `events.stream`, `routing.read`, `sessions.read`, `verification.read`); `approvals.read` has no endpoint until increment 4 but is still carried by the default credential for forward-compat. The default generated credential holds all seven reads + `commands.write`; a narrower credential (e.g. `["sessions.read"]`) is `403` on every route outside its row — tested (case 9c). Increment 4 adds the `approvals.read` / `artifacts.read` endpoints.

One global `onRequest` hook:

```ts
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (!path.startsWith("/api/")) return;                 // static SPA shell — the pre-auth login surface
  const rule = req.routeOptions.config?.auth;            // asserted present at startup for every registered /api/* route
  if (rule === null) return;                             // POST /api/auth/bootstrap only
  const cred = authenticate(req);                        // bearer OR cookie; null if neither valid
  if (rule === undefined) {                              // unknown /api/* path — no matched route
    if (!cred) { reply.header("X-Control-Plane-Api-Version", CONTROL_PLANE_API_VERSION);
                 reply.header("WWW-Authenticate", "Bearer");
                 return reply.code(401).send({ error: "unauthenticated" }); }
    return;                                              // authed caller falls through to Fastify's 404
  }
  const need = rule.require;
  if (!cred) {
    reply.header("X-Control-Plane-Api-Version", CONTROL_PLANE_API_VERSION);
    reply.header("WWW-Authenticate", "Bearer");          // an unauthenticated probe still learns the major version
    return reply.code(401).send({ error: "unauthenticated" });
  }
  if (!cred.capabilities.includes(need)) {
    return reply.code(403).send({ error: `${need} required` });
  }
  if (cred.kind === "cookie") {                          // CSRF: fail closed for browser credentials
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    const sameOrigin = site === "same-origin" || site === "none"
      || (origin != null && origin === apiOrigin);
    if (!sameOrigin) return reply.code(403).send({ error: "cross-origin" });
  }
  (req as { cred?: Cred }).cred = cred;
});
```

- `authenticate(req)`:
  - **Bearer** (`Authorization: Bearer <secret>`): `timingSafeEqual` against each **active** secret; match → `{ kind: "bearer", capabilities: secret.capabilities }`. Bearer clients are non-browser and legitimately have no `Origin` — they skip the CSRF check.
  - **Cookie** (`__Host-acp_session`, parsed by a hand-rolled single-cookie read; rejects a duplicate cookie name): `sessions.get(sid)`; reject if absent, `expiresAt` passed, or its `kid` no longer `isActive`; else `{ kind: "cookie", capabilities: session.capabilities }`.
- **Independent grantability:** a `["tasks.read", …reads]` credential reads but cannot mutate (`403` on `commands.write`); a `["commands.write"]`-only credential mutates but **cannot read** any GET route (`403` — it holds no `*.read`); a credential needs both sets to do both. Enforced per route via metadata, not by HTTP method.
- **Allowlist** is exactly `POST /api/auth/bootstrap` + every non-`/api/` path. **`GET /api/meta` now requires authentication** like every other `/api/*` route — an unauthenticated request to it is rejected, satisfying the literal "any endpoint" criterion. A client with no credential still learns the major API version from the `X-Control-Plane-Api-Version` header on the `401`, or from a static build constant; Cockpit and any other bearer client present their credential to `/api/meta` normally. `/api/meta` keeps returning `apiVersion`, `eventVersion`, `authRequired`, `capabilities` (the `workspace` field, duplicated from `/api/workspace`, is dropped). `GET /api/health` requires auth. Static (`index.html`, JS bundle) is a stock Vite build carrying no workspace data; all data arrives through authed `/api/*` calls.

### 6. Serve `apps/web` from the API — true same-origin (`@fastify/static`, new dependency)

- `app.register(fastifyStatic, { root: <repo>/apps/web/dist, wildcard: false })` when `dist/` exists; a `setNotFoundHandler` returns `index.html` for any non-`/api/` path. Absent `dist/` → the API 404s `/` and development uses the Vite dev server as today.
- The launcher's redirect lands the browser on `http://127.0.0.1:4176/`; the SPA's `/api/*` calls are then genuinely same-origin — `SameSite=Strict` sends the cookie, `EventSource` sends the cookie, no proxy/CORS caveats.
- `apps/web/vite.config.ts` dev proxy is unchanged and stays the development path. `@fastify/static` is depended on rather than hand-rolled (content types, range handling, path-traversal defence). `@fastify/cookie` and `@fastify/formbody` are **not** added.

### 7. The launcher (`apps/api/src/bin/open-web.ts`, `pnpm --filter @agent-plane/api open`)

Native Node process — the privileged issuer. The token never touches disk:

1. `loadConfig()`; read + **validate** `api-credential.json` (owner / mode / regular-file). Absent → exit "start the server first".
2. Pick the newest active secret whose capabilities cover the requested browser grant (default: all reads + `commands.write`; `--read-only` drops `commands.write`).
3. Start `http.createServer` bound to `127.0.0.1:0` (ephemeral, **in memory**); read back the assigned port → the launcher origin `lo = http://127.0.0.1:<ephemeralPort>`.
4. `mint()` a bootstrap token with `aud` = configured API origin (or `--origin` for the `:5176` dev server) and `lo` = the origin from step 3. **Immediately register the token string** (and the secret it was minted from) in the launcher process's own append-only redaction-literal set — before step 6 or any log line. Generate a per-launch CSP `nonce` (16 random bytes).
5. The listener serves exactly one route, `GET /`, guarded by an atomic in-memory `served` flag: the **first** handler invocation flips `served` and returns the auto-submit page; **every** later invocation (including one already accepted before `server.close()`) returns `410 Gone`.
   - Headers `Content-Security-Policy: default-src 'none'; form-action <apiOrigin>; script-src 'nonce-<nonce>'`, `Cache-Control: no-store`.
   - `<form method="POST" action="<apiOrigin>/api/auth/bootstrap"><input type="hidden" name="token" value="<token>"></form><script nonce="<nonce>">document.forms[0].submit()</script>`.
   - `server.close()` is called as soon as the winning response is flushed.
6. Open the OS browser at `lo` (`xdg-open` / `open` / `start`); print the URL as a fallback (headless / SSH). That URL carries **no token** — just the loopback page address.
7. Exit as soon as the one page has been served (step 5 winner), or after a 30 s timeout covering "never received the initial GET". The listener is closed on every exit path and on `SIGINT`. The launcher does **not** attempt to observe the browser's exchange or redirect — it cannot see that response.

The token lives only in that single in-memory HTTP response body, in the throwaway page's DOM for the auto-submit. CSP `default-src 'none'` (with only a nonce'd `.submit()` and a single `form-action` target) blocks every other script/network vector; the listener serves exactly one page then 410s; the token is bound to `lo`, single-use, 10 s, durably anti-replayed. A same-user process racing the ephemeral port is out of scope (Trust boundary section — it can read the credential file directly anyway). `apps/web` never sees the token.

### 8. `apps/web` client changes

- **Shared auth-expiry channel** (`apps/web/src/auth.ts`): a module-level `onAuthExpired` emitter. `api.ts`'s single `fetch` gets `credentials: "include"`; on `401` it fires `onAuthExpired()` and throws `AuthExpiredError`.
- `App.tsx` subscribes and, on expiry, renders a full-screen "Session expired — re-open with `pnpm --filter @agent-plane/api open`" view that **unmounts `TaskDetail`** (closing its `EventSource`). Every `api.*` call site's rejection is otherwise unchanged; they no longer need individual auth handling because the emitter is global.
- **One SSE protocol, no special frames.** `GET /api/tasks/:id/events/stream` is an ordinary authed route (`config.auth.require: "events.stream"`); an unauthenticated request gets a plain `401` from the global hook (the handler never runs — no `event: unauthorized` frame, which a browser `EventSource` could not surface anyway). `TaskDetail.tsx:71` uses `new EventSource(url, { withCredentials: true })`; its `onerror`, when `readyState === EventSource.CLOSED`, fires a single credentialed probe (`api.workspace()`), whose `401` triggers the global `onAuthExpired` emitter. A transient transport drop (`readyState === CONNECTING`) still auto-reconnects as before. The `auth.test.ts`, `apps/web` unit tests, and the Playwright specs all assert this same one protocol.

### 9. `packages/core`

- `CONTROL_PLANE_API_VERSION` `"1.1"` → **`"2.0"`**. Mandatory authentication is a behavioural break for any client that does not present a credential (successful-response JSON shapes are unchanged, but an unauthenticated request that used to succeed now `401`s) — a major bump, not additive.
- New export `COMMAND_CAPABILITIES = ["commands.write"] as const`.
- `GET /api/meta` (now authed) reports `authRequired: true` and `capabilities: [...OBSERVABILITY_CAPABILITIES, ...COMMAND_CAPABILITIES]`; the `workspace` field is removed from it (it duplicates `GET /api/workspace`). Because `/api/meta` requires auth, the major version is *also* discoverable without a credential from the `X-Control-Plane-Api-Version` header the hook attaches to every `401`, and from a static build constant — no unauthenticated endpoint returns a success body.
- **Ordering risk — needs the user's call.** The roadmap lists increment 2 as *"Depends on: 1a"*, and 1a defines the client compatibility-negotiation policy a `2.0` bump needs; the roadmap objective is "for **every** client". 1a is unmerged and the Cockpit client is a separate repo not in this session's scope. Codex round 2 argues 1a + Cockpit should land in the same delivery. This plan proceeds with the `ai-control-plan` server + `apps/web` and makes `docs/increment-2-cockpit-followup.md` a **required written deliverable** of this increment (the exact client diff, verified against a running `2.0` server), but the increment is not "done for every client" until 1a + that follow-up land or the user explicitly accepts the interim gap.

### 10. Clock injection

`ServerDeps` gains `now?: () => Date` (default `() => new Date()`), threaded into `registerAuth`, the credential loader (`isActive`), and every bootstrap / session / rotation-grace / jti-sweep expiry check.

### 11. No credential in any log, event, artifact, error body or telemetry

- **Exact-value redaction, append-only for the process lifetime.** Both the server and the launcher keep a process-wide `redactionLiterals` set. The server collects: every secret ever loaded from the credential file (including retired / past-`notAfter` ones — an expired secret is still sensitive), every bootstrap token seen at the exchange, and every minted `sid`. The launcher registers its minted token + source secret the instant it mints them (§7 step 4), so its own logs are covered before the token exists anywhere else. Literals are **never removed** — losing authentication authority does not make the string safe to print. `redactSecrets(text)` in `packages/core/src/redaction.ts` replaces any occurrence of a registered literal with `[REDACTED]`.
- **Applied at every ingress that can carry user or provider free text**, enumerated:
  - `POST /api/tasks` (goal, constraints) and `POST /api/tasks/:id/input` — user text, before `TaskStore` persists it.
  - `TaskStore.saveEnvelope` / envelope derivation — belt, for text that arrives via other paths.
  - the router's `persistRoutingDecision` (explanation text).
  - `CheckpointService` (diffstat / reason) and the verification / lifecycle stores (evaluation, interruption reason).
  - `EventRecorder` (already redacts; `redactSecrets` is added to its pass).
  - **`TelemetryService`** — every ingestion path (`classifyGoal` input, per-run usage/outcome rows, score aggregation inputs) and the `/api/scores` response, since the goal text and failure messages it stores can carry a pasted credential ("telemetry payload" is named in the criterion).
  - the two Markdown renderers (`render/progress.ts`, `render/handoff.ts`) at render time — the "artifact" in the criterion.
  - every API error body and the SSE frame writer.
- **Fastify logging:** `logger: { serializers: { req: r => ({ method: r.method, url: r.url.split("?")[0] }), res: r => ({ statusCode: r.statusCode }) }, redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"] }` — serializers allowlist fields and never emit headers; `redact` is defence in depth if a serializer regresses. The final log transport also runs `redactSecrets` over the serialized line.
- Auth failures log a fixed reason string; error bodies are generic and never echo input.
- **Canary tests:** register a canary secret, then for each of — a task whose goal **and** whose constraint contains it, a task input, a routing decision, a checkpoint, a verification evaluation, a telemetry row (goal + a failure message), a rendered `progress.md` / `handoff.md` — assert `[REDACTED]` (not the secret) in: the durable row (`tasks`, `routing_decisions`, `checkpoints`, verification tables, `events`, the telemetry tables), the corresponding API response (`/api/tasks/:id`, `/api/tasks`, `/api/tasks/:id/events`, `/api/tasks/:id/routing`, `/api/scores`, the rendered-file endpoints), the SSE payload, and **every captured log line** — including logs from startup, a rotation, a malformed bootstrap body, an uncaught handler error, and the launcher. Repeat the row/response/log assertions for a session id and a bootstrap token.

### 12. Migrations

One: `apps/api/src/db/migrations/013_bootstrap_jti.sql` — `CREATE TABLE bootstrap_jti (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`. Sessions stay in memory.

### 13. Tests

- **`apps/api/test/auth.test.ts`** (new):
  1. Unauthenticated `GET /api/meta`, `GET /api/workspace`, `GET /api/health`, `POST /api/tasks`, `GET /api/tasks/:id/events/stream` → **all `401`**. The `/api/meta` `401` carries `X-Control-Plane-Api-Version: 2.0` and `WWW-Authenticate: Bearer`.
  2. Bearer with a read-only credential → `GET /api/tasks` `200`; `POST /api/tasks` → `403`.
  3. Bearer with a `commands.write`-only credential → `POST /api/tasks` passes auth; `GET /api/tasks` → `403`.
  4. Bearer with a full credential → both pass; `GET /api/meta` `200`, body has no `workspace` key.
  5. Bootstrap happy path: `mint` a token with `lo = "http://127.0.0.1:9999"` (shared helper), `POST /api/auth/bootstrap` (urlencoded, `Origin: http://127.0.0.1:9999`) → `303`, `Location` = API origin, `Set-Cookie __Host-acp_session` with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`; `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
  6. Replay: same token again → `401`. **Restart replay:** rebuild the server on the same DB, replay → still `401` (durable `bootstrap_jti`). **Concurrent replay:** two parallel exchanges of one fresh token → exactly one `303`, one `401`, exactly one session minted (atomic `INSERT` consume).
  7. Expired token (`exp` in the past, via injected clock) → `401`.
  8. Wrong `aud` → `401`. Bad signature → `401`, response body contains no substring of the token. Bootstrap POST whose `Origin` ≠ `payload.lo` (a different `127.0.0.1:<port>`, **or the API origin itself**, or absent) → `403` before the HMAC check. POST with no token → `400`.
  9. CSRF: with a valid cookie, a `POST /api/tasks` carrying `Sec-Fetch-Site: cross-site` and `Origin: https://evil.example` → `403`. Bootstrap with `Origin: https://evil.example` → `403`.
  9b. Unknown `/api/does-not-exist` unauthenticated → `401` (not `500`, not `404`); authenticated → `404`.
  9c. Cross-capability denial: `["sessions.read"]` → `GET /api/sessions` `200`, `GET /api/tasks` `403`, `GET /api/tasks/:id/routing` `403`; `["events.read"]` → `GET /api/tasks/:id/events` `200`, `GET /api/tasks/:id/events/stream` `403`.
  10. Rotation grace (bearer): mint secret A; rotate (A `notAfter = now + 300`); bearer A → `200`; advance clock past `notAfter` (**no reload event**) → bearer A `401`, bearer B `200`.
  11. Rotation forces browser re-auth: bootstrap under A → cookie authenticates; advance past A's grace → the cookie request `401`s.
  12. Redaction: canary tests from §11, including the startup / rotation / malformed-body / uncaught-error / launcher log captures.
  13. Concurrency: fire N parallel authenticated requests while rotating; assert no spurious `401` (reload coalescing + throttle). **Exact race:** an unknown-`kid` miss triggers a reload, then within the 250 ms debounce window a `rotate` completes and a request arrives on the new secret → it **awaits** its own reload and gets `200`, never `401`.
  14. **Startup assertion:** a test route registered under `/api/` without `config.auth` makes `buildServer` throw.
- **`apps/api/test/config.test.ts`:** credential file generated at first boot with mode `0600` and dir mode `0700`; start refused when the file (or dir) is group/world-readable, is a symlink, or is owned by another uid; `api.auth` defaults (`bootstrapTtlSeconds` 10, `sessionTtlSeconds` 43200, `rotationGraceSeconds` 300) and overrides; a stale lockfile (dead pid / age > 30 s) is reclaimed.
- **`apps/api/test/server.test.ts`:** currently **8** `app.inject` call sites (14 across `apps/api/test/**`). Add shared helpers — `bearer(caps)`, `cookie(caps)`, `expired()`, `rotated()` — that stamp the right header; convert the existing calls to `bearer("full")`. **Keep** the explicit unauthenticated assertions in `auth.test.ts` (no test-only bypass is added to the server).
- **`apps/web/test/api.test.ts`:** assert `fetch` is called with `expect.objectContaining({ credentials: "include" })`; a `401` response makes `api.workspace()` reject with `AuthExpiredError` and fires `onAuthExpired`; an `EventSource` `onerror` at `readyState === CLOSED` triggers exactly one credentialed probe.
- **`apps/web` Playwright E2E** (`@playwright/test`, new devDependency; specs in `apps/web/e2e/`) — **a completion gate, not follow-up:** the suite must run green in the increment's verification environment (`pnpm --filter @agent-plane/web test:e2e`, with `npx playwright install --with-deps chromium` in the build). If the environment genuinely cannot run a headless browser, that is a **blocker** raised to the user, not deferred work. Specs: (a) launcher ephemeral page → `303` → SPA loads authenticated → `/api/workspace` succeeds → `EventSource` receives a frame; (b) `document.cookie` does **not** contain `__Host-acp_session`; (c) a page on a foreign origin `POST`ing to `/api/auth/bootstrap` and to `/api/tasks` is rejected; (d) replay of a consumed token is rejected; (e) after `rotate` past the grace window, the open SPA transitions to the expired view via the `onerror` → probe → `onAuthExpired` path; (f) bearer grace-window continuity asserted at the API level in the same run.

## Key decisions & tradeoffs

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| D1 | Cockpit client update is a **required written follow-up** (`docs/increment-2-cockpit-followup.md`: exact diff, verified against a running `2.0` server), blocked on 1a for the *code* merge. The increment is not "done for every client" until 1a + that follow-up land or the user accepts the interim gap. | Do the Cockpit code here (another repo, out of this session's scope) / call it plain follow-up. | 1a (compat policy) is unmerged and Cockpit is a separate repo; every acceptance criterion of *this* increment is met without Cockpit code, but the roadmap objective "for every client" is not — hence a hard flag, not a soft one. |
| D2 | Launcher serves the token from an **in-memory, single-shot ephemeral loopback HTTP listener** (`127.0.0.1:0`, atomic `served` flag → one page then `410`); the token is **bound to that listener's exact origin** (`lo`); exchange accepts `Origin === lo` only and replies **`303`** to the SPA. | Writing the page to a `0600` `file://` file; an any-loopback-port `Origin` allowlist. | Roadmap requires the token be **never stored** — a file stores it. `lo`-binding means only the one listener that minted a token can redeem it, so "a cross-origin request cannot obtain a session" holds literally. No CORS surface (form-POST navigation, not `fetch`). |
| D3 | Launcher = a new `apps/api` bin (`pnpm … open`): validate the `0600` file, **bind the ephemeral port first**, mint an HMAC token carrying `lo`, serve one page, open the browser at `lo` (no token in the URL), exit on serve. | Long-lived launcher daemon; env-var / argv / file handoff; mint-then-listen. | Smallest issuer that proves filesystem possession and never puts the token in a URL, env var, argv, or any store — memory only. Port-first ordering is what makes `lo`-binding possible. |
| D4 | **Every `/api/*` route declares `config.auth`** — its *natural* capability from the existing seven (full route→cap table in §5), `commands.write`, or `null`; `onRoute` **throws at startup** on any omission; `null` only for `POST /api/auth/bootstrap`. A single-read-capability credential is `403` outside its column. | Method-based; a blanket `tasks.read` for every GET; deferring the real per-cap mapping to increment 4. | A blanket tag defeats the existing `sessions.read` / `verification.read` / `routing.read` vocabulary and over-grants read authority. The tags are mandatory anyway, so the correct cap costs nothing now. Increment 4 only adds `approvals.read` / `artifacts.read` for new endpoints. |
| D5 | Bootstrap `jti` replay defence is a **durable table** (`013_bootstrap_jti.sql`); the `INSERT` **is** the consume (no prior `SELECT`); a unique-violation → replay `401`; the session is minted only after the insert commits. | In-memory set; check-then-insert. | "Cannot be replayed" has no restart exception, and check-then-insert races two concurrent exchanges of one token. The atomic insert closes both. |
| D6 | Auth is **ON at first boot**; the file is auto-generated `0600` under a `0700` dir; there is **no** "auth disabled" mode. | A transition window where a missing file = auth off + a warning. | A security increment that ships an off switch has not closed §3.8. |
| D7 | Rotation = `pnpm … rotate` CLI under a lockfile carrying `{pid, startedAt}` (stale = dead pid or age > 30 s); surface = the same `api-credential.json`; grace = `api.auth.rotationGraceSeconds`, **default 300 s**; adopted via a **coalesced, ≤ once/250 ms** reload on any auth miss; `isActive` re-checked **per authentication** against the injected clock. | `fs.watch`-only reload; SIGHUP; a rotation endpoint; mtime as a correctness gate; filter active only at load. | Coalescing + throttle removes reload-starvation and thundering-herd without depending on mtime (which can collide on rapid atomic replace); per-auth `isActive` makes expiry time-driven, not event-driven; pid/age metadata recovers a crashed rotator's lock. |
| D8 | Version bump to **`2.0`** (major) + `authRequired: true` on `GET /api/meta`; `401`s carry `X-Control-Plane-Api-Version`. | `1.2` minor + a flag. | Mandatory auth breaks any non-authenticating client. The negotiation policy is 1a's; flagged as an ordering risk needing the user's call. |
| D9 | **`GET /api/meta` requires authentication** like every other `/api/*` route — no unauthenticated endpoint returns a success body. The major version is still discoverable unauthenticated from the `X-Control-Plane-Api-Version` header on the `401` and from a static build constant. | Exempt `/api/meta` as a "version-negotiation manifest". | The user said "do not weaken any acceptance criterion"; "any endpoint" is literal. Header-only version discovery satisfies real clients (Cockpit presents a bearer anyway) without a success-body exemption. |
| D10 | Cross-origin **cookie-authenticated** requests fail **closed** (`Sec-Fetch-Site` / `Origin` must indicate same-origin; missing both on a cookie request ⇒ reject). Bearer requests are exempt (non-browser, legitimately origin-less). | Accept missing `Origin`; accept any loopback origin. | Fail-open CSRF checks do not satisfy the criterion; `SameSite=Strict` alone is only defence in depth. |
| D11 | Security principal = the **OS user account**; a hostile same-user process is out of scope for both the credential file and the bootstrap token. | Claim in-process defence against same-user processes. | A same-user process can read the `0600` credential file directly; no in-process channel can beat that. Stated explicitly rather than implied. |
| D12 | `__Host-acp_session` cookie; hand-rolled parser that **rejects a duplicated cookie name**. | Unprefixed `acp_session`. | Prevents a co-resident `127.0.0.1:<other-port>` service from shadowing / fixating the session cookie (cookies are host-scoped, not port-scoped). |
| D13 | Exact-value redaction: an **append-only, process-lifetime** literal set — every secret ever loaded (retired ones included), every verified bootstrap token, every minted `sid` — consulted at every enumerated ingress (task create/input, envelope, routing persist, checkpoint, verification, `EventRecorder`, both Markdown renderers), every log line, every SSE frame, every error body. | Rely on pattern-based `DEFAULT_REDACTION_RULES`; register only *live* secrets. | A bare base64url secret pasted into a task goal matches no existing pattern; an expired secret is still sensitive in a log; the criterion is absolute ("no credential … in a log, event, artifact, error body or telemetry"). |
| D14 | **`buildServer` throws at startup** if any `/api/*` route lacks explicit `config.auth`. | Trust that every route was tagged. | Makes a missing authorization declaration a boot failure, not a silent hole a future PR ships. |
| D15 | Launcher listener is **in-memory and single-shot**; the token is never written to disk in any form. | The `file://` handoff file (even at `0600`, even deleted after 15 s). | The roadmap's "the token is never stored" is literal; deletion does not un-store it. |

## Assumptions
_Confirmed ledger (locked at recommendation via the escape hatch); sources in brackets._

1. Scope = `ai-control-plan` (`apps/api` + `apps/web`); Cockpit is a follow-up blocked on 1a. [roadmap increment 2 "Depends on: 1a"; 1a unmerged — `git log`, Cockpit `SUPPORTED_API_VERSION = "1.0"`]
2. Auth defaults ON; first boot generates the credential file (`O_EXCL`, mode `0600`, dir `0700`). [acceptance: "an unauthenticated local request to any endpoint is rejected"]
3. Two credential presentations, same secret material: `Authorization: Bearer <secret>` for non-browser clients, an `HttpOnly` `__Host-` cookie for the browser. [roadmap increment 2 body]
4. Bootstrap token = stateless `HMAC(secret, {aud,kid,jti,exp,cap})`; **durable** consumed-`jti` table. [roadmap: "one-time … short expiry (seconds) … single use"; Codex round 1 #3]
5. Cookie: `__Host-acp_session`, `HttpOnly` + `Secure` + `SameSite=Strict` + `Path=/`, no `Domain`; `Referrer-Policy: no-referrer` + `Cache-Control: no-store` on the exchange `303`. [roadmap increment 2 body / acceptance; Codex #14]
6. `commands.write` and each `*.read` are per-route capabilities in the credential entry's `capabilities` list, enforced by route metadata, mutually independent. [roadmap: "independent of every read capability"; Amendment A4; Codex #4]
7. One global `onRequest` hook; allowlist = `POST /api/auth/bootstrap` + every non-`/api/` path **only**. `GET /api/meta` and `GET /api/health` require auth; `buildServer` throws if any `/api/*` route lacks `config.auth`. [acceptance "any endpoint"; Codex rounds 1 #19, 2 #6 / new #6]
8. SSE authenticates by cookie (`EventSource … { withCredentials: true }`) or bearer; an unauthenticated request gets a plain `401` from the hook (no special frame); the client's `onerror`-at-`CLOSED` fires one credentialed probe whose `401` drives `onAuthExpired`. [`apps/web/src/TaskDetail.tsx:71`; `EventSource` cannot set headers or read a `401` body; Codex round 2 new #5]
9. 1a is a soft dependency for the *build*; the version-negotiation policy it defines is reconciled in the required Cockpit follow-up doc. The "for every client" objective remains open until 1a + that follow-up land. [roadmap dependency graph; Codex round 2 #20]
10. Plan artifacts are `docs/increment-2-auth-plan.md` + `docs/increment-2-auth-review-log.md`; the repo-root `PLAN.md` / `PLAN-REVIEW-LOG.md` are the prior loop's and stay untouched. [`ls` — dated Sep 1, orchestrator cutover]
11. `<config.dir>` (`~/.agent-plane/<workspace>/`) is validated owner-only (`uid`, mode `& 0o077 === 0`, directory) before any credential read/create; it is created by `loadConfig` today. [`apps/api/src/config.ts:121-127`; Codex #7]
12. `config.api.auth` is a new optional block: `bootstrapTtlSeconds` (10), `sessionTtlSeconds` (43200), `rotationGraceSeconds` (300). [ladder — only the values that vary]

## Risks / open questions

- **PREREQUISITE DECISION (blocking — the user must pick before BUILD).** The roadmap objective is authenticated transport *"for **every** client"*, and lists increment 2 as *"Depends on: 1a"* (the client compat-negotiation policy). 1a is unmerged; the Cockpit client is a separate repo, not in this session's scope, still `1.0` + unauthenticated. Either:
  **(a)** block this increment's completion on 1a merging **and** the Cockpit client being updated + verified against a running `2.0` server; or
  **(b)** approve a **staged delivery** — this plan ships the `ai-control-plan` server + `apps/web` + `docs/increment-2-cockpit-followup.md` (exact diff, paper-verified) as stage 1, which explicitly **cannot claim the roadmap increment complete**; stage 2 (1a + Cockpit) closes it.
  Codex round 2–4 position: documentation alone does not meet the objective, and there must be no silent default. **BUILD does not start until the user records (a) or (b) here.** No default is assumed.

  **USER DECISION (2026-09-03): (b) staged delivery.** Stage 1 = `ai-control-plan` server + `apps/web` + `docs/increment-2-cockpit-followup.md`, built now; it does **not** claim the roadmap increment complete. Stage 2 = 1a merge + the Cockpit client update, verified against a running `2.0` server, closes it. Known interim gap: a `2.0` server breaks Cockpit's `/api/control-plane/status` until stage 2 — do stage 2 promptly.
- **`Secure` cookie over `http://127.0.0.1`.** Honoured by Chrome / Firefox / Edge (loopback = potentially-trustworthy). **Safari does not implement the loopback HTTP exception** and drops the cookie — Safari needs local HTTPS, out of scope. This localhost dev tool's supported-browser contract is Chrome/Firefox/Edge; the acceptance test asserts the cookie *attributes*, not a given browser's storage.
- **`file://`-less launcher.** The launcher now serves from an in-memory ephemeral HTTP listener, so there is no `file://`→`http` submission and no disk artifact. A same-user process racing the ephemeral port is explicitly out of scope (D11). The insecure-submission browser notice does not arise (`http://127.0.0.1`→`http://127.0.0.1`).
- **Playwright is a completion gate.** The E2E suite must run green in the increment's verification environment (`npx playwright install --with-deps chromium`). If that environment cannot run a headless browser, it is a **blocker raised to the user**, not deferred work — the browser-only criteria ("no token reachable from JavaScript", "rotation … forces browser re-authentication … tested", "CSRF cases tested") cannot be met otherwise.
- **`server.test.ts` blast radius.** 8 call sites get a shared authed-inject helper; mechanical, and no criterion is weakened (negative coverage lives in `auth.test.ts`).
- **Launcher browser-open on headless hosts.** `xdg-open` fails silently over SSH; the launcher prints the `http://127.0.0.1:<ephemeral>/` URL as a fallback.

## Out of scope

- Cockpit `ControlPlaneClient` **code** changes (separate repo). `docs/increment-2-cockpit-followup.md` — the exact diff, spec'd and paper-verified against a running `2.0` server — **is** in scope as a written deliverable.
- The 1a compatibility policy / negotiation machinery itself.
- New read-capability *endpoints* (`approvals.read`, `artifacts.read`) — increment 4. The seven existing capabilities are all mapped and enforced now.
- Any new execution path or write *feature* — this increment only builds the authorization that must precede them.
- Production hardening beyond a single-user localhost tool: TLS/HTTPS, multi-user sessions, a restart-durable session store, defence against hostile same-user processes.
- Unix-domain-socket transport (the roadmap offers it as an *alternative* to the `0600` file; the file is sufficient and simpler).
- Safari support for the HTTP-loopback cookie flow (needs local HTTPS).
- `approvals.read` and `artifacts.read` *endpoints* (increment 4); the six other read capabilities are mapped and enforced now.
