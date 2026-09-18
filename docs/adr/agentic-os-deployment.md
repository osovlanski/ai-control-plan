# ADR: keep execution on OCI; earn the remote control-plane boundary

2026-09-18 · Proposed deployment decision, source/documentation reviewed.
No deployment authorized by this ADR. Authenticated remote-mode design and explicit
user approval remain prerequisites to deploying. Current loopback API stays private.

## Evidence and constraints

This is a React/Vite frontend served by a persistent Fastify application, with
SQLite (`better-sqlite3`), ordered migrations, local Git worktrees, spawned provider
CLIs, long-running session handles, Harness recovery and scheduled background work.
It is not a collection of stateless request handlers. Relevant source: API
`server.ts`, `config.ts`, `auth/index.ts`, SessionRunner, scheduler and database
migrations; web `api.ts` and `TaskDetail.tsx` stream handling.

Configuration rejects a non-loopback API host. Browser auth uses a short-lived,
single-use local bootstrap and host cookie, with local canonical HTTP origin and
same-origin checks. There is no production remote login/session/worker protocol.
Opening a firewall port or putting the loopback server behind a public proxy would
bypass the intended boundary. Vercel rewrites alone do not establish authorization.

Current host is aarch64; Node 22, pnpm, Docker, Claude and Codex executables are on
PATH. Cursor's executable was not found on PATH; configured custom paths and actual
provider authentication were not tested. Native SQLite builds passed locally.
An executable's presence does not prove OAuth/device-session portability.

The SSE stream has live bus updates and initial state, but no replay cursor or
heartbeat contract. Durable event reads exist. Reconnect must reconcile reads;
remote mode needs authenticated resume, heartbeat and expiry behavior before
long-lived connections become reliable across proxies.

## Options

| Requirement | A: OCI all-in-one | B: Vercel frontend + OCI | C: Railway control plane + OCI worker | D: Railway full stack |
| --- | --- | --- | --- | --- |
| Long-running processes/spawning | Existing fit; supervise service/children | Runtime remains OCI | Persistent API suitable; worker protocol absent today | Service processes possible; CLI/container privileges unproven |
| Repositories/CLI auth | Already local; keep scoped | Unchanged on OCI | Explicit registered repo IDs; secrets/auth stay worker | Requires migration/sync and provider login lifecycle |
| SQLite/storage | Local persistent disk, single writer | Same OCI DB | Railway volume single-writer initially or separately scoped DB migration | Volume mandatory; no ephemeral DB or shared multi-writer SQLite |
| Background/scheduled work | Existing scheduler/leases | Same | One control-plane scheduler, fenced worker dispatch | Persistent scheduler service required |
| Checkpoints/recovery | Existing local artifacts; test restore | Same | Versioned checkpoint references and durable worker receipts needed | Artifact persistence and adoption across deployments needed |
| Networking/TLS | SSH/private access now; authenticated TLS gateway later | Two origins complicate cookies, CSRF, streaming and login | TLS API + outbound authenticated worker channel | TLS API plus strict isolation around local execution |
| Workspace isolation | Existing allowlists plus OS/runtime boundaries | Preview must never receive real repo/secret access | Per-worker capabilities and scoped mounts, not raw remote paths | Hardened per-workspace workers required |
| Preview/rollback | Isolated fixtures or local builds | Best fit: protected static fixture preview | Isolated preview service/DB; never production workers | Expensive preview runtime/auth duplication |
| Operational complexity | Low topology; medium backup/security burden | Medium: two origins plus auth coordination | High initially: leases, queue, two hosts, recovery protocol | High migration/security burden; fewer hosts is not simpler execution |

Cloud facts checked against official documentation on the decision date:

- Vercel now supports **WebSockets in beta**, but connections end at function
  duration limits and reconnection can reach another instance. This does not
  supply durable kernel/process ownership. [WebSockets](https://vercel.com/docs/functions/websockets)
- Function duration limits are finite and plan-dependent; execution persistence,
  not simply WebSocket support, rules out lifting this kernel into Functions.
  [Function limits](https://vercel.com/docs/functions/limitations)
- A protected frontend preview is useful after verifying access protection for
  the selected plan/environment. Use fixtures with no production API credentials.
  [Deployment protection](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication)
- Railway provides persistent volumes and backup facilities. Keep one SQLite
  writer, use SQLite-consistent backup, and test restore; a volume alone is not HA.
  [Volumes](https://docs.railway.com/volumes/reference), [backups](https://docs.railway.com/volumes/backups)
- Railway supports TLS and WebSockets. HTTP requests (including SSE) have a
  15-minute duration and five-minute inactivity limit; WebSockets have documented
  exemptions. Add heartbeat/reconnect rather than assuming an endless SSE request.
  [Network limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
- Railway private networking is project/environment-scoped; OCI is not
  automatically a member. An outbound worker connection still needs mutual
  authentication and authorization. [Private networking](https://docs.railway.com/networking/private-networking)

## Recommendation and rejected alternatives

Choose **A now**, with single-user SSH/private access and the API bound to loopback.
Keep OCI as the personal execution host. Use **B only as an isolated protected
frontend/fixture preview** until remote auth exists; live B is a separate security
project, not a DNS change. Long-term prefer **C** if hosted availability justifies
its operational cost, after the registered-worker protocol is proven locally.
Railway better matches a persistent API than Vercel Functions for this application.

Reject automatic **D** migration now: repository mounts, OAuth/device authentication,
CLI binaries/native architecture, container permissions, checkpoints and isolation
have not been demonstrated there. API-only future workloads may change that result.
Reject a public proxy to today's loopback API, provider credentials in Vercel/CI,
shared SQLite writers, and two active schedulers controlling the same execution.

## Remote security model required before deployment

Owner-allowlisted browser identity (OIDC or equivalent), secure HttpOnly host
cookies, expiry/revocation/logout, CSRF and exact origin checks, canonical HTTPS
origin, trusted-proxy configuration and authenticated SSE. Require command-level
authorization and workspace binding on every read/write, including event resume.
Rate-limit bootstrap/login/commands; never put long-lived credentials in URLs.

Workers register using short-lived scoped credentials over an outbound mTLS or
equivalently authenticated channel. Durable dispatch uses idempotency, lease epochs
and fencing; disconnected workers cannot acquire new work. Per-workspace repository
IDs resolve to worker-local allowlisted paths. Provider credentials/device sessions
stay on OCI or its selective credential gateway. Never upload credential homes,
provider session material or memory snapshots to preview services or build contexts.
Browser auth is separate from provider OAuth; interactive provider login remains
on the execution host, not a deployment build step. Private networking is defense
in depth, not an authorization substitute.

Logs use workspace/task/session/attempt IDs and redaction; raw provider transcripts,
tokens and login URLs are excluded. Observe queue age, worker heartbeat, lease loss,
SSE reconnect rate, SQLite errors, approval age and backup/restore outcomes. Protect
audit access and define retention before collecting remote personal data.

## Migration stages and rollback

1. Current stage: preserve local build/test evidence, private SSH preview, isolated
   fixtures. Inventory storage and backup without copying provider credentials.
2. Authenticated remote-mode implementation on loopback tests: hostile origin,
   expiry/revocation, workspace escape, SSE resume and canonical proxy tests.
   Explicit deployment approval then permits a private TLS gateway.
3. Implement registered-worker protocol locally with deterministic workers: durable
   outbox, receipts, fenced ownership, cancel/approval acknowledgements and recovery.
4. Build target architecture images independently (ARM versus x86); do not copy
   ARM native node_modules to an x86 runtime. Verify each required CLI, login flow,
   process/container permission and checkpoint on the target before migration.
5. If choosing C, stop dispatch, drain/checkpoint sessions, take a consistent SQLite
   backup, restore/test a single control-plane writer and re-register OCI. Migrate
   schema with the existing ordered mechanism; verify old/new compatibility. Never
   run both kernels as owners. Database engine replacement is its own slice.

Rollback: stop new dispatch and fence new owners; retain receipts/checkpoints;
restore compatible image/config plus tested DB backup if a migration is not backward
compatible; re-adopt surviving OCI work under a new epoch before resuming. A frontend
rollback can be independent when API contracts are compatible. Preview deployments
use separate fixture databases and cannot dispatch to personal workers.

## Cost and operational estimate

OCI's existing bill/entitlement was not accessed; incremental hosting cost may be
small, but disk backup, domain/TLS operations and monitoring remain real work.
Current Always Free documentation lists 1,500 A1 OCPU-hours and 9,000 GB-hours/month
(equivalent to 2 OCPU/12 GB), up to 200 GB block storage, and possible idle-instance
reclamation. Do not assume this instance is eligible or that capacity is guaranteed.
[OCI resource terms](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Railway Hobby has a $5 monthly floor including usage; Pro $20. Documented rates
include RAM $10/GB-month, CPU $20/vCPU-month, volume $0.15/GB-month and egress
$0.05/GB. An illustrative 0.5 GB RAM + average 0.1 vCPU + 2 GB volume + 5 GB egress
is $7.55 usage/month, excluding provider tokens, backups, OCI, domains and taxes;
measure actual idle/load behavior before setting a budget. This is not a quote.
[Railway pricing](https://docs.railway.com/pricing/plans)

Vercel fixture preview cost depends on plan/protection and traffic; no account
entitlements or budget were inspected. A costs least integration work, B adds
origin/auth coordination, C adds a distributed recovery protocol, and D adds
execution migration validation. Provider usage can dominate all hosting costs.
