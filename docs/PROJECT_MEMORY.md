# Project Memory

AI Agent Control Plane routes work across complete assistant environments (Claude Code, Codex, Cursor, Bedrock and an opt-in OpenRouter model), normalizes execution events, checkpoints work, handles approvals/failover, and compares parallel runs.

- Architecture: pnpm monorepo. `apps/api` is a Fastify/SQLite orchestration service; `apps/web` is a React 19/Vite UI; `packages/core` owns contracts/state/redaction; `packages/adapters` owns provider runtimes.
- Entry points: `apps/api/src/index.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`.
- Persistence: better-sqlite3 plus ordered SQL migrations in `apps/api/src/db/migrations`.
- Core flow: task creation → deterministic/explainable route → adapter execution → normalized event stream/SSE → checkpoint/handoff/failover. Parallel compare/race and telemetry-fed routing are implemented.
- Security constraints: workspace-per-process isolation, repo allowlist, provider credentials remain in provider tooling/environment, redaction before persistence, explicit approval events.
- Build/test: `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- State: implemented prototype through Phase 5. The environment-sensitive probe test was replaced with a deterministic missing-binary test; the full 84-test API suite is green as of 2026-08-29.
- Integration: `GET /api/meta` publishes version `1.0` and the read-only observability capabilities intended for Cockpit.
- Weaknesses: large orchestration module, no authenticated remote mode, no frontend tests, limited production packaging/observability.
- Portfolio: the source of truth for control/execution-plane contracts. `ai-control-plan-agentic-os` was a documentation worktree; its design docs are now tracked here under `docs/`. It is not a separate product. Cockpit is a plausible UX/observability consumer, not currently integrated.
- Open questions: intended trust boundary for the API; whether remote execution is actually required; ownership/versioning of contracts shared with Cockpit.
This is not an independent product: it is the `docs/agentic-os-contract-lifecycle` documentation worktree of `ai-control-plan`. The branch proposes later Agentic OS lifecycle phases; proposals must not be reported as shipped features. Build/run/test and architecture match the parent repository; do not evolve duplicate application code here.

## K1 durable dispatch implementation

- `feat/agentic-os-k1-durable-dispatch` starts at kernel-services `56cf244`; Orbital UI is a sibling and excluded.
- Newly created single-task time waits now have generation-aware durable dispatch, cancellation, boot reconciliation, immutable intent, pause kinds, routing at wake, and minimal waiting UI. API 2.1 adds scheduler-status reads under `schedules.read`.
- Migration 014 separates waits/dispatches/task-scoped scheduler events from provider run events. A missing fresh Harness session can safely re-park after its recovery window; missing legacy run evidence remains an explicit operator-reconciled ambiguity, never an automatic retry.
- K1 evidence: `docs/agentic-os-k1-implementation.md` maps all 12 acceptance criteria and records architecture corrections. Typecheck/lint/build passed; default tests core 70 / adapters 8 / API 475 / web 6, plus forced-Harness API 475.
- K2+ quota conversion/projection/probes, model/context services, runtime backends, and Composer remain deferred. This feature branch implements K1 in the canonical application; it does not create a duplicate product.

## K3 optional quota probes implementation

- `feat/agentic-os-k3-quota-probes` adds an opt-in idle quota probe (`scheduler.quotaProbe`, default off) whose results are `provider-api` observations in the K2 `QuotaProjection`, scoped to account and bucket.
- The Claude OAuth usage endpoint is implemented; every other provider returns `unsupported`. The Codex app-server rate-limits RPC stays unimplemented until it is verified against a running app-server — no placeholder data stands in for it.
- Credentials are read in memory from the provider's own file and used only as the request credential; probe outcomes carry a classified reason, never a response body, and a redaction test asserts the credential reaches no table, log or API read.
- Migration 016 adds `quota_probes` (attempts only) so the one-per-assistant-per-15-minutes window survives a restart and `GET /api/scheduler/status` can report probe freshness. A failed probe writes no observation and changes nothing.
- Probe attempts are recorded in the wait condition's `history` and never increment `auto_wakes`; wake revalidates the projection with a probe before deciding, so an exhausted window re-parks without a provider start.
- K3 evidence: `docs/agentic-os-k3-implementation.md`.

## Demo A: K1-K3 through the Orbital operator UI

- `feat/agentic-os-demo-a` reconciles the Orbital UI (`feat/agentic-os-orbital-ui@04cbfb5`) onto current `main` instead of replacing the shipped board: one primary experience, with K1/K2/K3 backend truth winning wherever the two disagreed.
- The Orbital inspector now reads persisted kernel state — wait kind/generation/next eligible time, quota blocker scope and provenance, checkpoint and continuation, dispatch phases, post-wake assistant identity, scheduler enablement and K3 probe freshness. `Planned` labels survive only for K4, K5 and K9.
- `pnpm demo:a` runs `apps/web/e2e/demo-a.spec.ts` against an in-process API with an injected clock and probe transport: deterministic, no provider credentials, no real quota consumption, with trace/video/screenshots kept under `apps/web/test-results/`.
- Operator runbook: `docs/demo/demo-a.md` (prerequisites, Oracle start, SSH tunnel, deterministic run, optional real-Claude smoke, artefact locations, deliberately unimplemented functionality).
- Defect found and fixed here: routing-side quota reads (`routeTask`, `Orchestrator.quotaPlan`) and `CooldownStore` used wall time while the scheduler ran on the injected kernel clock, so under a divergent clock fresh evidence read as stale and expired cooldowns read as live — a blocked assistant could be started at a wake. All of them now share the kernel clock, with a regression test in `apps/api/test/quota-probe.test.ts`.
- An API credential minted before K1 lacks `schedules.read`, so `GET /api/scheduler/status` answers 403 until `pnpm --filter @agent-plane/api rotate`.

## Orbital operator UI v2 (2026-09-07)

Visual/product redesign of the operator console on top of the merged K1-K3
semantics; no backend change. OS shell (rail: Orbital / Intake / Agents, system
health pill from `/api/scheduler/status`), command bar that routes a goal through
Intake, and an execution field whose rings are state groups and whose arcs are
kernel truth (wake horizon for waits, blocker arc for quota, beacon for human
input, drift for execution). Bodies ride the SVG orbit path via `offset-path`
with arc-length phases; `layoutBodies` keeps labels from overlapping and is
unit-tested. Inspector gained a decided / because / next strip derived by
`nextStep()`; tabs and Demo A selectors unchanged. Fonts: IBM Plex via
`@fontsource` (OFL). Reference captures: `pnpm --filter @agent-plane/web visual`.
Docs: `docs/ui/orbital-operator.md`.

