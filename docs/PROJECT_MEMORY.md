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
