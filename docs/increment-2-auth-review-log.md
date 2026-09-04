# Plan Review Log: vNext Increment 2 — Authenticated transport and command authorization

Phases 0–1 (recon + interrogation) complete. Recon covered `apps/api/src/server.ts` (no auth hooks, ~30 inline routes), `apps/api/src/config.ts` (loopback-only `validate()`, owner-only config dir), `apps/web` (dev-only Vite SPA, single `req()` fetch choke point, `EventSource` at `TaskDetail.tsx:71`), `packages/core/src/contracts.ts` (`CONTROL_PLANE_API_VERSION = "1.1"`), and the `cockpit` repo (`ControlPlaneClient` at API 1.0, sends no credential). Increment 1a is unmerged. No `CONTEXT.md` / `docs/adr/` — docs-aware mode off. No skill-inventory matches — no `## Toolchain` section.

Interrogation: the user invoked the escape hatch ("resume progress from summary as recm") — all 12 Assumptions Ledger items and decisions D1–D10 are locked at their recommended answers, recorded in `PLAN_FILE` § Key decisions and § Assumptions.

MAX_ROUNDS=5. PLAN_FILE=docs/increment-2-auth-plan.md. LOG_FILE=docs/increment-2-auth-review-log.md. Reviewer model: CLI default (config unpinned) — codex-cli 0.152.1. inspect=on (post-build cross-inspection by a fresh read-only Codex session).

---

## Round 1 — Codex

Thread `01a068ad-1b7d-70b1-a2a3-778c8a6ea906`. `VERDICT: REVISE`. 20 findings.

1. **Critical** — bootstrap token is embedded in an inline `<script>` on the launcher page → reachable from JavaScript, violating "no token reachable from JavaScript" and the roadmap's JS-readable prohibition.
2. **Critical** — the exchange accepts any loopback origin on any port, so `http://127.0.0.1:<evil-port>` is cross-origin yet authorized → fails "a cross-origin request cannot obtain a session".
3. **Critical** — in-memory consumed-`jti` set allows replay in the seconds-window after a crash/restart; "cannot be replayed" has no restart exception.
4. **Critical** — read/write not independently enforced: authentication grants every GET regardless of capability; a `commands.write`-only or empty-capability credential can read everything. Capability strings in a file are not authorization.
5. **High** — CSRF check fails open: a missing `Origin` is accepted and any loopback `Origin` is accepted.
6. **High** — the ephemeral HTTP launcher server is itself "a channel readable by another local process"; mode `0600` does not stop a same-user process; the port is raceable.
7. **High** — the credential's parent directory is not validated owner-only (`loadConfig` `mkdirSync` sets no mode); ownership / symlink / file-type unchecked.
8. **High** — first-boot creation and rotation have multi-process races (temp-then-rename does not serialize concurrent writers).
9. **High** — reload-on-miss rate-limited to 1/s can be starved by a bogus `kid`, `401`ing a legitimate rotated key; no atomic snapshot swap / coalescing defined.
10. **High** — rotation expiry depends on a reload happening; a loaded secret with a future `notAfter` never leaves `activeSecrets` on time if no filesystem event occurs.
11. **High** — "no secret in storage" is false: a user can submit a credential as a task goal/constraint; pattern-based redaction does not catch a bare base64url secret or session id.
12. **High** — logging verification incomplete; Fastify request serializers including headers can leak auth data; use allowlisting safe serializers + stream-capture tests.
13. **High** — `Secure`-over-loopback is overstated; Safari does not implement the `localhost` HTTP exception; plan uses `127.0.0.1` and claims current Safari support.
14. **Medium** — `__Host-` rationale wrong; an unprefixed `acp_session` is *more* exposed to shadowing/fixation by another localhost port.
15. **High** — SPA expiry not designed end to end: `App.tsx` can only catch its own initial request; child promises are uncaught; `EventSource.onerror` hides status and reconnects forever.
16. **High** — no genuine browser E2E: only mocked web tests exist; `app.inject` cannot prove cookie acceptance, JS non-readability, SameSite/CORS, EventSource cookie-send, or the launcher flow.
17. **Medium** — `server.test.ts` has 8 `inject` calls, not "~30" (14 across all API tests); a blanket authed helper erases unauthenticated regression coverage.
18. **Medium** — method-based authorization is fragile (future state-changing GET bypasses); the `/api/auth/bootstrap` all-method exemption is too broad.
19. **Medium** — unauthenticated static SPA access contradicts the plan's own literal "any endpoint" claim.
20. **Medium** — a mandatory `401` is behaviourally breaking; deferring the version decision to 1a defeats the roadmap dependency.

### Claude's response — Rev 2

Arbiter dispositions (Claude is final arbiter; roadmap text is the tie-breaker):

- **Accepted 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19** — all folded into Rev 2:
  - #3/#5 → migration `013_bootstrap_jti.sql` (durable replay defence, restart-safe); cookie-auth CSRF now fails **closed** on `Sec-Fetch-Site`/`Origin`, bearer exempt (D10).
  - #2 → exchange rejects any concrete `Origin` that is not `null` or the exact API origin.
  - #4/#18 → per-route **capability metadata** enforced in the hook; a `commands.write`-only credential is `403` on every read; method-sniffing dropped (D4).
  - #7/#8 → directory + file validation (owner uid, `mode & 0o077 === 0`, regular-file, no symlink, dir `0700`); `O_EXCL` first-boot; lockfile + `fsync` file & dir for rotation.
  - #9/#10 → mtime-gated + coalesced reload with atomic snapshot swap; `isActive` re-evaluated against the injected clock on **every** authentication.
  - #11/#12/#13 → exact-value redaction of live secrets / session ids / tokens at every log·durable-write·SSE·error boundary + canary tests (D13); allowlisting Fastify serializers + `redact` backstop + stream-capture tests; `Secure` kept but Safari documented as unsupported (needs local HTTPS).
  - #14 → `__Host-acp_session` + duplicate-cookie rejection (D12).
  - #15 → shared `onAuthExpired` emitter in `apps/web`; server emits one `event: unauthorized` SSE frame then closes; `App` renders a full-screen expired view that unmounts `TaskDetail`.
  - #16 → Playwright E2E added (`@playwright/test` devDep, `apps/web/e2e/`): launcher→cookie→fetch→SSE, `document.cookie` non-exposure, foreign-origin bootstrap + CSRF rejected, replay rejected, post-grace re-auth. CI headless-browser wiring flagged as a follow-up note.
  - #17 → corrected to "8 call sites (14 across `apps/api/test/**`)"; distinct helpers (`bearer`/`cookie`/`expired`/`rotated`); negative coverage kept in `auth.test.ts`, no server bypass.
  - #19 → acceptance scope stated explicitly as "any endpoint that serves data or effects"; `GET /api/meta` is the sole unauthenticated read (static manifest, `workspace` field removed); `GET /api/health` now authed.
- **Accepted with a narrower framing — 1, 6:** the roadmap itself prescribes a "launcher-mediated form POST", and a form POST inherently carries the token in the submitting page's DOM. Rev 2 replaces the raceable ephemeral HTTP server with a mode-`0600` `file://` handoff page (no port to race), `CSP default-src 'none'` (only the one form POST can leave the page), single-use + 10 s + durable anti-replay. New **Trust boundary** section states the principal is the OS user account and a hostile same-user process is out of scope for the token *and* the credential file alike (a same-user process can read the `0600` file directly — no in-process channel beats that). The "no token reachable from JavaScript" criterion is met **for `apps/web`**: its only credential is the `HttpOnly` `__Host-` cookie and no code path exposes a token. This is a genuine residual point if the reviewer rejects the roadmap's own mechanism — escalated to the user if it recurs.
- **Accepted as an open question — 20:** version bumped to **`2.0`** (major) + `authRequired: true` on `/api/meta`. The 1a-ordering tension is now a top Risk item flagged for the user's decision (merge 1a first, or proceed and reconcile in the follow-up).
- **Accepted — 13** (see #11/#12/#13 above).

---

## Round 2 — Codex

`VERDICT: REVISE`. Prior findings: 3, 4, 10, 14, 17, 18 fully addressed; 1, 5, 6, 13 addressed under the stated interpretation; 2, 8, 9, 11, 12, 16 partially addressed; **15 not addressed** (SSE protocol self-contradictory); **19 not addressed** ("any endpoint" was weakened by exempting `/api/meta`). Six new material findings:

- **New #1 (Critical)** — Rev 2's `file://` handoff page *does* persist the token to disk for 15 s, contradicting the roadmap's "the token is never stored". Fix: serve from an in-memory ephemeral loopback listener (the same-user port-race is out of scope under the accepted OS-user model).
- **New #2 (Critical)** — `CSP default-src 'none'` blocks the launcher page's own inline `.submit()` script. Fix: `script-src 'nonce-…'` for that one script, keep `default-src 'none'` + `form-action`.
- **New #3 (High)** — durable `jti` consume must be atomic; check-then-insert races two concurrent exchanges. Fix: `INSERT` *is* the consume; unique-violation → replay; mint the session only after it commits.
- **New #4 (High)** — expired/rotated secrets must stay redaction literals for the process lifetime; "live only" would let a retired secret print unredacted.
- **New #5 (High)** — unauthenticated SSE cannot both `401` (tests) and emit an `unauthorized` event (web design). Pick one; make hook, client, and both test layers agree.
- **New #6 (Medium)** — defaulting every untagged GET to `tasks.read` hides authorization omissions. Fix: require explicit `config.auth` on every `/api/*` route; fail startup if absent; `null` only on an explicit allowlist.

### Claude's response — Rev 3

- **Accepted, all six new findings:**
  - new #1 / prior #1·#19 → launcher is now an **in-memory single-shot ephemeral HTTP listener** (`127.0.0.1:0`, closes on first response); token never touches disk ("never stored" now literally true). D2/D3/D15 rewritten; §7 rewritten.
  - new #2 → CSP `default-src 'none'; form-action <apiOrigin>; script-src 'nonce-<perLaunch>'`; the `.submit()` script carries the nonce.
  - new #3 → §4 step 6: atomic `INSERT INTO bootstrap_jti` is the consume, no prior `SELECT`; unique-violation → `401`; session minted only after commit. `auth.test.ts` adds a concurrent-replay case. D5 updated.
  - new #4 → §11 + D13: `redactionLiterals` is **append-only for the process lifetime** — retired secrets, every verified bootstrap token, every minted `sid`, never removed.
  - new #5 / prior #15 → §8 rewritten to **one protocol**: unauthenticated SSE → plain `401` from the hook (no special frame — a browser `EventSource` cannot read a `401` body anyway); client `onerror`-at-`CLOSED` → one credentialed probe → `onAuthExpired`. `auth.test.ts`, `apps/web` unit tests, and Playwright all assert this.
  - new #6 / prior #18 → §5 + D4/D14: **every `/api/*` route must declare `config.auth`**; `buildServer` throws at startup on any omission; `null` honoured only for `POST /api/auth/bootstrap`. No `tasks.read` default. `auth.test.ts` case 14 covers the throw.
- **Accepted, prior "partial" items:**
  - #2 → `Origin: null` documented as indistinguishable from a sandboxed hostile doc; security rests on the unforgeable/single-use/10 s token; tests for `null`-origin with no token and bad token.
  - #8 → lockfile carries `{pid, startedAt}`; stale (dead pid or age > 30 s) is reclaimed. D7 + config.test.
  - #9 → reload is coalesced + throttled ≤ once/250 ms on any miss; mtime/ino/size are an optimisation only, not a correctness gate.
  - #11 → redaction ingress sites **enumerated** (task create/input, envelope, routing persist, checkpoint, verification, `EventRecorder`, both Markdown renderers, error bodies, SSE); canary tests hit every durable table + response + renderer.
  - #12 → canary log capture broadened to startup / rotation / malformed-body / uncaught-error / launcher logs; `redactSecrets` also runs over the final serialized log line.
  - #16 → Playwright E2E is now a **completion gate** (`npx playwright install --with-deps chromium`; must run green in the verification env); inability to run it is a blocker raised to the user, not follow-up.
- **`/api/meta` — reversed to require auth (prior #19 accepted in full).** The user said "do not weaken any acceptance criterion"; "any endpoint" is literal. Allowlist is now `POST /api/auth/bootstrap` + static only. Unauthenticated version discovery is served by an `X-Control-Plane-Api-Version` header on the `401` and a static build constant — no success-body exemption. D9 rewritten.
- **Partial accept / documented disagreement — #20 (1a ordering / Cockpit).** Codex wants 1a + the Cockpit code in one delivery. The Cockpit repo is out of this session's scope and 1a is unmerged. Rev 3 makes `docs/increment-2-cockpit-followup.md` a **required, paper-verified deliverable**, states plainly that the roadmap's "for every client" objective is **not** met until 1a + that follow-up land, and puts the choice to the user (block on 1a, or accept the interim gap). Not silently resolved.

---

## Round 3 — Codex

`VERDICT: REVISE`. All 26 round-2 items now Addressed or "Mostly/Partially": prior #4 (wants the full route→cap table now, not blanket `tasks.read`), #11 (telemetry ingress/canary not enumerated), #20 (wants the user's decision recorded as a prerequisite). Four new findings:

- **New #1 (Critical)** — the launcher page's own form POST carries the *ephemeral* origin, which §4 step 1 (accepts only API origin or `null`) rejects → the happy path would `403`. Fix: bind the exact ephemeral launcher origin into the signed token and require an exact match.
- **New #2 (Medium)** — the launcher claims to exit when "the exchange redirect is observed", which it cannot see. Fix: exit after serving the one page.
- **New #3 (Medium)** — `server.close()` does not guarantee `410` for an already-accepted request. Fix: an atomic in-memory `served` flag gates delivery.
- **New #4 (Medium)** — an unknown `/api/*` path has no route metadata; the hook would dereference `rule.require` and `500`. Fix: treat missing metadata as unauthenticated → `401`.

### Claude's response — Rev 4

- **Accepted, all four new findings:**
  - new #1 → token payload gains **`lo`** (exact launcher origin); the launcher **binds the ephemeral port first**, then mints with `lo`, then serves. §4 step 2 requires `Origin === payload.lo` (or the API origin for `--origin` dev mode), checked *before* the HMAC. Makes prior #2 hold literally — exactly one origin can redeem a given token. D2/D3 rewritten; `auth.test.ts` case 8 updated.
  - new #2 → §7 step 7: exit on serve; 30 s timeout covers only "never received the initial GET"; the launcher explicitly does not observe the browser exchange.
  - new #3 → §7 step 5: atomic `served` flag — first invocation wins the page, every later one returns `410`; `server.close()` after the flush.
  - new #4 → §5 hook: `rule === undefined` → `401` if unauthenticated, else fall through to Fastify's `404`. `auth.test.ts` case 9b.
- **Accepted, prior "partial":**
  - #4 → §5 now carries the **full route → capability table** using all seven existing caps. A single-read-capability credential is `403` outside its column — `auth.test.ts` case 9c. D4 rewritten.
  - #11 → `TelemetryService` ingress paths + the `/api/scores` response added to the redaction boundary list and canary assertions.
  - #20 → reframed as a **blocking PREREQUISITE DECISION** the user must make before BUILD: (a) block on 1a + Cockpit verification, or (b) approve staged delivery where stage 1 cannot claim the roadmap increment complete. Plan assumes (b) pending the user.
- No findings rejected this round.

---

## Round 4 — Codex

`VERDICT: REVISE`. All round-3 findings resolved except three small material points:

- **Prior #4 (partial)** — `/api/tasks/:id/events` mapped to `tasks.read` while the prose said "either `events.read` or `tasks.read`"; single-string `require` can't do both, and `events.read` had no home. Fix: give event history `events.read`.
- **Prior #20 (almost)** — "user must pick before BUILD" contradicted "this plan assumes (b)". Fix: no default; record an explicit choice.
- **New #1** — reload throttle can still suppress the reload that would adopt a just-rotated key if a bogus miss consumed the 250 ms window. Fix: a miss **awaits** its own coalesced reload before it may `401`; the debounce coalesces, never skips.
- **New #2** — the launcher (separate process) must register its minted token in its own redaction-literal set immediately, or its log canary can't pass.
- **New #3 (tidy)** — drop the API-origin alternative in the exchange `Origin` check; require `Origin === payload.lo` with no exception.

### Claude's response — Rev 5

- **Accepted, all:**
  - prior #4 → `/api/tasks/:id/events` → `events.read`; `/api/tasks/:id/events/stream` → `events.stream`; the "either/or" prose removed. Six of seven read caps now map to a live endpoint; `approvals.read` documented as increment-4 (endpoint) but carried by the default credential. `auth.test.ts` 9c adds an `events.read` case.
  - prior #20 → removed the "(b) unless the user says otherwise" default; the plan now states **BUILD does not start until the user records (a) or (b)**.
  - new #1 → §1 reload rewritten: every individual miss awaits the current-or-next coalesced reload and re-checks before it can `401`; the debounce only coalesces concurrent misses. `auth.test.ts` 13 adds the exact bogus-miss-then-rotate sequence.
  - new #2 → §7 step 4 + §11: the launcher registers the token + source secret in its own append-only literal set the instant it mints, before browser-open or any log line.
  - new #3 → §4 step 2 + token spec + D2: `Origin === payload.lo` **exactly, no exception** (not even the API origin; `--origin` dev mode only changes `aud`/the form action, the page is still served from and submits from `lo`). `auth.test.ts` 8 asserts the API-origin case is also `403`.
- No findings rejected.

---

## Round 5 — Codex — VERDICT: APPROVED

All five round-4 findings confirmed addressed: `events.read` mapping, no-default pre-build gate on the 1a/Cockpit decision, await-own-reload on every auth miss (+ tested rotation race), launcher self-registers its token for redaction, `Origin === payload.lo` exact with no exception. Codex found no new material security or feasibility problem. The unresolved 1a/Cockpit choice is "no longer a design defect because the plan correctly blocks BUILD until the user explicitly selects staged delivery or unified completion."

Converged in 5 rounds. What the loop changed, in three lines:
1. **Bootstrap channel** went from a JS-readable inline token → `file://` file → an in-memory single-shot listener with the token HMAC-bound to that listener's exact origin (`lo`), atomic single-serve, durable-atomic replay consume.
2. **Authorization** went from "method-sniff, any read cap = all reads" → every `/api/*` route declares its exact capability or the server won't boot; a single-read-cap credential is `403` outside its row; `/api/meta` and `/api/health` are authed (no unauthenticated success body anywhere).
3. **Redaction / rotation / tests** hardened: append-only literal set (retired secrets included) across every enumerated ingress incl. telemetry; per-auth `isActive`; await-own-reload so a bogus miss can't starve a rotated key; Playwright E2E promoted to a hard completion gate.

**Open for the user (blocks BUILD): the PREREQUISITE DECISION** in `PLAN_FILE` § Risks — (a) block this increment on 1a + the Cockpit client update, or (b) staged delivery where stage 1 (server + `apps/web` + the follow-up doc) ships now but cannot claim the roadmap increment complete.

---

## Act 3 — Build (codex-build; user decision (b) staged delivery)

Builder: Codex (`codex exec`, session `01a068cf-39e7-75b0-b7fc-8bc47462af4c`), cli 0.152.1, model CLI default.
Spec handed over: `docs/increment-2-auth-plan.md` + this log, STAGE 1 scope. Clean tree at `c28e5d7`.

### Round 1 — Codex build

Files: 31 changed/added (full list in the build report). Core: `apps/api/src/auth/{bootstrap-token,credential-file,index}.ts`, `apps/api/src/bin/{open-web,rotate-credential}.ts`, `apps/api/src/db/migrations/013_bootstrap_jti.sql`, route-capability table + auth hook + startup assertion + static SPA + redacted logger in `server.ts`, `api.auth` block + first-boot credential + dir validation in `config.ts`, append-only `registerSecret`/`redactSecrets` in `packages/core/src/redaction.ts`, `2.0` + `COMMAND_CAPABILITIES` in `contracts.ts`, `apps/web/src/{auth.ts,api.ts,App.tsx,TaskDetail.tsx}`, `apps/api/test/auth.test.ts` (cases 1–14 + 9b/9c), `apps/web/e2e/auth.spec.ts` (specs a–f), `docs/increment-2-cockpit-followup.md`.

### Claude's verdict — Round 1

Read the full diff. Ran the proof independently:
- `pnpm install && pnpm typecheck && pnpm test` → **EXIT 0** — web 4, core 70, adapters 8, api 396 (478 total), all green.
- `pnpm --filter @agent-plane/web test:e2e` (Chromium) → **6/6 passed**, run by Claude.

Spec conformance: the ordered bootstrap checks (§4 1–8), the per-route capability table (§5, all ~30 routes; startup throw verified by case 14), atomic-INSERT jti consume with no prior SELECT, hardened `__Host-` cookie + `Referrer-Policy: no-referrer` + `Cache-Control: no-store`, O_EXCL 0600 credential under a 0700-validated dir, lockfile `{pid,startedAt}` + stale reclaim, atomic rotate with `notAfter` grace + fsync file+dir, coalesced await-own-reload, injected clock throughout, launcher binds `127.0.0.1:0` first then mints `lo`-bound token + self-registers redaction literals + single-serve→410 + per-launch CSP nonce — all present and faithful. All 14 numbered §13 cases + specs a–f exist and pass.

Accepted deviations (noted, not fixed): (5) no `{ino,size,mtimeNs}` snapshot — full-file reload is correctness-equivalent, plan called it an optimization; (7) wrong-uid refuse is code-only (cannot `chown` without root in CI) — the `mode & 0o077` sibling branch is tested; (8) an existing config dir is `chmod`-healed to `0700` rather than refused — §1 explicitly instructs `chmodSync`, self-heal is strictly safer; (1) root `npx playwright` is not hoisted, the workspace-scoped command is the proof.

Dispatched **fix round 1** for the material §13 coverage gaps Codex self-flagged:
- broaden the redaction canary (case 12) to also assert an SSE frame and an error body carry no literal;
- add the web-unit test that drives `EventSource.onerror` at `CLOSED` and asserts exactly one credentialed probe → `onAuthExpired` (plan §13 `apps/web/test/api.test.ts`);
- add a stale-lockfile-reclaim test for `withCredentialLock`;
- add a test that exercises the real `apps/api/src/bin/open-web.ts` (bind → serve once → 410), not an in-process reimplementation;
- nits: drop the unused `statSync` import in `credential-file.ts`; fix the pino `redact` path `res.headers["set-cookie"]`.

### Round 2 — Codex fix

Resumed the same session. 8 files touched, no runtime behavior change beyond the two nits + the redaction boundary the canaries needed:
- `apps/api/src/auth/credential-file.ts` — dropped the unused `statSync` import.
- `apps/api/src/server.ts` — pino `redact` path corrected to `res.headers["set-cookie"]`; added `app.setErrorHandler` returning a `redactValue`-scrubbed body so uncaught handler errors cannot leak a literal.
- `apps/api/src/bin/open-web.ts` — extracted `startOpenWeb()` (injectable `openBrowser`, `config`, `apiOrigin`) with the CLI path guarded by an `import.meta.url` check; bind-first / lo-bound-mint / self-register / serve-once / 410 / 30s-timeout behavior unchanged.
- `apps/web/src/TaskDetail.tsx` — extracted `openTaskEventStream(taskId, onMessage)` (the `withCredentials` EventSource + `onerror`→CLOSED→one-probe logic), same behavior, now unit-testable.
- `apps/api/test/auth.test.ts` — new case 12b: real listening server, live-secret canary pushed through the bus into an SSE frame and thrown from an extra route, asserts both the `data:` frame and the uncaught-error body carry `[REDACTED]` and not the literal.
- `apps/api/test/open-web.test.ts` — new: drives the real `startOpenWeb()` — ephemeral `127.0.0.1` bind, one 200 + one 410, CSP header shape, hidden `token` input, and `parseBootstrapToken(token).payload.lo === listener.origin`.
- `apps/api/test/config.test.ts` — new: dead-pid `<path>.lock` is reclaimed and rotation succeeds; a live-pid lock within 30s is never stolen (`rotateCredential` throws `/lock held/`, lock file remains).
- `apps/web/test/api.test.ts` — new: `FakeEventSource` at `readyState=CLOSED`, `onerror()` fired twice, asserts exactly one credentialed `/api/workspace` probe and one `onAuthExpired`.

### Claude's verdict — Round 2 (final)

Read the full diff. Ran the proof independently:
- `pnpm typecheck` → PASS.
- `pnpm test` → **EXIT 0** — web 5, core 70, adapters 8, api 399 (482 total).
- `pnpm --filter @agent-plane/web test:e2e` (Chromium) → **6/6 passed**, run by Claude.

All five §13 coverage gaps closed. No acceptance criterion is weakened. The three accepted deviations stand (snapshot-metadata optimization, wrong-uid refuse is code-only, config-dir self-heal per §1's explicit `chmodSync`).

**Build complete — STAGE 1.** Ready for the human commit gate on branch `increment-2-auth`. Stage 2 (1a merge + Cockpit `ControlPlaneClient` per `docs/increment-2-cockpit-followup.md`) remains, and until it lands the `2.0` server breaks Cockpit's `/api/control-plane/status` — the known, recorded interim gap.
