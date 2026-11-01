# Running the Agentic OS on Vercel or another cloud

2026-11-01 · **PROPOSED, design only.** Nothing here is implemented, deployed or authorized.
The binding decisions stay [agentic-os-deployment.md](adr/agentic-os-deployment.md) (the
deployment ADR, options A to D and migration stages 1 to 5) and
[remote-auth-design.md](adr/remote-auth-design.md) (stage 2). This note answers one question
from the owner, "can the Agentic OS run on Vercel or another cloud?", against those two
documents and the code on `main` at `e1b06ce` (ai-control-plan) and `760db1c` (cockpit).

**Short answer.** The web UI can be hosted anywhere once the API has real remote auth. The
plane, its SQLite database, the provider CLIs with their logins, the git worktrees and Cockpit
must stay on a machine the owner controls. OCI already is that machine. The useful next step is
stage 2 remote auth on the OCI plane, not a Vercel deployment.

## 1. What must stay on a machine, and what could move

### Must stay with the provider logins

| Component | Evidence | Why it cannot move to a stateless or ephemeral host |
| --- | --- | --- |
| API bind | `apps/api/src/config.ts:877-880` refuses any `api.host` outside `127.0.0.1`, `::1`, `localhost` "until authenticated remote mode exists"; `apps/api/src/index.ts:32` listens on that host. | Exposing it needs stage 2. A proxy in front of the loopback API bypasses the boundary (deployment ADR lines 16-20). |
| Browser auth origin | `apps/api/src/auth/index.ts:15` builds the canonical origin as `http://${host}:${port}`. | The cookie, bootstrap audience and origin checks are bound to the loopback origin, not to an HTTPS public origin. |
| Database | `apps/api/src/config.ts:453` puts `agent-plane.db` in the workspace dir; `apps/api/src/db/index.ts:12` opens it with `better-sqlite3`. | One local writer, native module, ordered migrations. The ADR rejects shared or ephemeral SQLite (lines 38, 81). |
| Provider adapters | `packages/adapters/src/claude.ts:565` spawns the Claude CLI as a detached process group with the plane's env; `packages/adapters/src/cursor.ts:157` spawns `cursor-agent` in the run workdir; `packages/adapters/src/claude.ts:704` and `claude-session-input.ts:293` read `$CLAUDE_CONFIG_DIR` or `~/.claude`. | They use the machine's interactive OAuth/device logins. Provider credentials stay on the execution host (ADR lines 94-98). |
| Codex auth | `packages/adapters/src/provisioning.ts:233` keeps `~/.codex` visible because "moving CODEX_HOME would move `auth.json` with it". | The login file is the credential; it cannot be copied into a build or a sandbox image. |
| Worktrees | `apps/api/src/repo/git.ts:98` runs `git worktree add` on local repos; `apps/api/src/modules/orchestrator.ts:614` targets a worktree per run. | Runs edit real repositories on local disk, under repo allowlists. |
| Scheduler and recovery | `apps/api/src/modules/scheduler.ts:40` (`Scheduler`), boot reconcile and timer in `apps/api/src/index.ts:16-17`. | Long-lived owner of leases, wakes and orphan reaping. Functions end at a duration limit (ADR lines 48-53). |
| Cockpit | `cockpit/server.ts:180-184` binds `127.0.0.1` by default and calls `validateNetworkBinding`; `cockpit/config.ts:264` and `:292` default to `~/.claude`, `~/.cursor`, `~/.agents`, `~/.codex`; `cockpit/contextCompile.ts:349` writes `~/.codex/AGENTS.md`. | Its job is editing the machine's assistant config and shelling out to local CLIs. Hosted elsewhere, it would edit the wrong machine. |
| Plane to Cockpit link | `apps/api/src/config.ts:701` requires `registry.cockpit.baseUrl` to be an http loopback origin. | Plane and Cockpit are assumed co-located. |

### Could move

| Component | Evidence | Condition |
| --- | --- | --- |
| Web UI build (static) | `apps/api/src/server.ts:1388-1390` serves `apps/web/dist` with `@fastify/static`; it is a plain Vite build. | Live data needs an explicit API base, credentialed CORS and remote login. Today `apps/web/src/api.ts:308` uses relative URLs with `credentials: "include"` and `apps/web/src/TaskDetail.tsx:49` opens a relative `EventSource`. Before stage 2 it can only be a protected fixture preview (ADR line 71). |
| Read-only dashboards | The plane already publishes read contracts (usage, models, scheduler status; asset-usage feed is S3, in flight). | A read-only remote session profile (remote-auth Q4) or a pull of exported, redacted snapshots. Never the credential homes. |
| A relay or gateway | Remote-auth design, "Browser identity", option 2 (identity-aware gateway). | The API must validate the gateway's signed assertion itself; header trust alone is not enough. Still requires stage 2 code. |
| Execution of non-provider work | Stage 3 registered workers (ADR lines 91-96, stage 3). | A worker protocol with leases and fencing that does not exist yet. |

Finding: Cockpit's gate is weaker than the plane's. `cockpit/networkSecurity.ts:3-8` accepts a
non-loopback `HOST` when `AUTHENTICATED_PROXY=true`, an operator assertion that nothing checks.
The plane has no equivalent switch. Any cloud plan must not lean on that flag; Cockpit stays on
loopback next to the plane.

## 2. Three options against the ADR stages

The prompt's options map onto the ADR as follows: (a) is the ADR's live **B**, (b) is **A** plus
stage 2, and (c) is a variant of **C** where the worker is a cloud sandbox, which is stage 3.

### (a) Web UI on Vercel, talking to the OCI plane through a tunnel or relay

- **Stage.** Needs stage 2 complete, including its "What live B costs over one-origin C" rows.
  A tunnel alone (Cloudflare Tunnel, Tailscale Funnel, ngrok) to today's loopback API is the
  rejected "public proxy" (ADR line 80): the tunnel exits on loopback, so every request looks local.
- **Needs that do not exist.** `api.auth.mode: remote`, OIDC owner login, remote session table,
  CSRF tokens, exact credentialed CORS for one frontend origin, an authenticated SSE stream with
  a resume journal, an explicit API base in `apps/web`, and a same-site custom domain pair (the
  cross-site cookie path fails when third-party cookies are blocked). Plus a trusted-proxy
  contract for whatever terminates TLS in front of OCI.
- **Credentials.** OIDC client secret: a protected file reference on OCI (`api.auth.remote.identity`).
  Provider logins: unchanged on OCI. Vercel holds only the public API base URL at build time;
  no plane bearer, no provider token, no session cookie value in Vercel env vars or the repo.
- **Approval boundary.** Unchanged in the kernel: approvals, repo allowlists and command grants
  are enforced by the API. New: per-command remote grants; `commands.write` alone is not enough.
- **Threat-model delta.** Largest of the three for the browser side: two origins, CORS, a
  compromised or hijacked Vercel deployment can drive the API with the owner's session, preview
  deployments must be denied, and the browser cookie policy becomes a dependency.

### (b) The whole plane on a cloud VM (OCI already is one) with stage 2 remote auth

- **Stage.** ADR option A today; stage 2 adds authenticated remote mode, then a separately
  approved private TLS gateway. The web UI stays same-origin, served by `server.ts:1388`.
- **Needs that do not exist.** The same stage 2 server work as (a), minus CORS, the two-origin
  cookie matrix and the web API base. Plus the TLS endpoint, HSTS and trusted-peer config.
- **Credentials.** Everything stays on OCI: provider homes (`~/.claude`, `~/.codex`), the plane's
  credential file, the OIDC client secret reference. Nothing new leaves the machine.
- **Approval boundary.** Same as today, plus the explicit remote grants; remote mode disables
  local bootstrap and the local bearer entirely (remote-auth, "local coexistence").
- **Threat-model delta.** One new internet-facing HTTPS origin guarded by OIDC owner identity.
  No new place where credentials live. Existing access over SSH forwarding
  ([headless-open.md](headless-open.md)) keeps working in local mode.

### (c) Vercel Sandbox or similar as an execution worker

- **Stage.** Stage 3 (registered-worker protocol), after stage 2. Stage 4 (per-arch images,
  verifying each CLI and login flow on the target) also applies.
- **What the platform gives.** Vercel Sandbox runs commands in an isolated VM with a session
  timeout that defaults to five minutes and is extended up to a plan limit, egress network
  policies (default allow-all), per-sandbox env vars, optional persistent snapshots and mounted
  drives ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference)). Equivalents exist
  elsewhere (e2b, Modal, Fly Machines).
- **Needs that do not exist.** The whole stage 3 protocol: worker registration with short-lived
  scoped credentials, durable dispatch with idempotency, lease epochs and fencing, receipts,
  cancel and approval round trips, and checkpoint references that survive a sandbox stopping
  mid-run. Repos would be cloned into the sandbox from a registered repo ID, not mounted. Kernel
  pid ownership (`claude.ts:565` process group) does not reach into a remote VM.
- **Credentials.** The hard part. A provider CLI in the sandbox needs a provider credential in
  the sandbox. Subscription OAuth logins are interactive and tied to the host (ADR lines 97-98),
  so only API-key billing (Anthropic or OpenAI keys, or Bedrock via OIDC) would work, injected
  per run from a gateway on OCI and never stored in the plane DB, Vercel project env or images.
  That changes the cost model from subscription to metered tokens.
- **Approval boundary.** Codex today runs with `approvalPolicy "never"` inside its own sandbox
  (`packages/adapters/src/codex.ts:70-71`); mid-run approvals for Claude need a round trip from
  the sandbox to the plane, which stage 3 must carry with fencing so a lost worker cannot act.
- **Threat-model delta.** Largest overall: credentials leave OCI per run, repo contents leave OCI,
  a second control channel exists, and egress policy becomes a security control. Gain: isolation
  of untrusted third-party skills (plan §7 risk 3) better than local worktrees give.

### Summary

| | (a) Vercel UI + OCI plane | (b) OCI plane + stage 2 | (c) Sandbox worker |
| --- | --- | --- | --- |
| ADR stage | 2 + live B costs | 2 | 2, 3 and 4 |
| New code | Stage 2 + CORS + web API base | Stage 2 | Stage 2 + worker protocol + adapter |
| Credentials leave OCI | No (only a public URL) | No | Yes, per run (API keys) |
| Provider billing | Subscription | Subscription | Metered API keys |
| New internet origins | 2 | 1 | 1 + worker channel |
| What the owner gets | UI on a Vercel URL | Same UI from anywhere | Burst capacity, stronger isolation |

## 3. Recommendation and first slice

**Recommend (b): keep everything on OCI and build stage 2 remote auth, tested entirely on
loopback, before any deployment.** It gives "use it from anywhere" with no credential leaving the
machine, and stage 2 is a prerequisite of (a) and (c) anyway, so nothing is wasted if the owner
later wants the UI on Vercel. Until stage 2 is approved, keep SSH forwarding as the remote path.
Revisit (c) only if the 1-CPU OCI box becomes the bottleneck for parallel runs and the owner is
willing to pay metered API prices for those runs.

A Vercel-hosted **fixture preview** of the UI (ADR stage 1, protected, no plane credentials,
fixture data only) is allowed today and is a cheap way to see the UI on Vercel. It is optional and
not on the critical path.

**First slice: stage 2 S1, the remote-mode configuration contract.** Smallest piece with no
runtime exposure: the plane learns to validate `api.auth.mode` and the `api.auth.remote.*`
block, and refuses to start for every incomplete or unsafe combination. No new listener, no OIDC,
no route changes; non-loopback still refuses unless a complete remote block validates, and remote
mode itself still refuses to start with "not implemented" until later slices land.

- **Owned files:** `apps/api/src/config.ts` (types and `validate` only),
  `apps/api/src/auth/remote-config.ts` (new, pure parser/normalizer for origins, transport,
  identity, session and limits), `apps/api/test/remote-config.test.ts` (new), one
  `docs/PROJECT_MEMORY.md` section, and the remote-auth design's config table marked as
  implemented where it is.
- **Tests:** every "Local / remote configuration" acceptance row in remote-auth that applies
  to config: absent mode is local; unknown keys, HTTP origins, `trustProxy: true`-style permissive
  peers, empty owners, idle > absolute TTL and workspace label mismatch all fail; the existing
  non-loopback refusal still fires for local mode.
- **Drive:** `pnpm dev` with a scratch `AGENT_PLANE_HOME`, once with an incomplete remote block
  (refuses before listen, message names the field) and once with the default config (boots as today).
- **Model and effort:** Claude Code cloud, Opus 5.5 / high. Security-sensitive parsing with many
  refusal paths; small diff.
- **Disjoint from in-flight work:** S2 owns `packages/core/src/asset-telemetry.ts` and adapters;
  S3 owns `contracts.ts`, `server.ts` and `contracts/`. This slice touches none of those.

Later stage 2 slices, in order: remote session store and OIDC login against a fake issuer;
command grants and route metadata; SSE journal and resume; canonical proxy checks; then the
acceptance matrix, and only then a deployment approval.

## 4. Questions for itay

1. **Which path?** (a) Vercel UI, (b) OCI plane with stage 2, or (c) sandbox workers.
   *Recommended: (b), with (a) possible later on top of it.*
2. **Do you want a protected Vercel fixture preview of the UI now, while stage 2 is built?**
   *Recommended: no, unless you want to see the UI on a phone soon; it shows fixture data only.*
3. **Which identity provider and account for the owner allowlist (remote-auth Q1)?**
   *Recommended: Google OIDC with your existing account, exact `(issuer, subject)` pair, MFA on.*
4. **Would you accept metered API-key billing for some runs to get cloud execution capacity?**
   *Recommended: not now; the subscription logins on OCI are cheaper, and (c) only pays off if the
   1-CPU box becomes the limit.*

Verdict for this docs-only change: **SKIP** (no runtime surface).
