# Project Memory

This file holds durable facts only, and every session reads it. Keep it under 16 KB: `packages/core/test/project-memory-size.test.ts` fails above that. The outcome log is `docs/project-memory-log.md`, newest last. Don't read the log whole: `grep -n "^## " docs/project-memory-log.md` lists its sections, then read the ones your change touches.

Append a section to the log only when a contract changed, a gate opened or closed, a defect was found that the code alone does not explain, or a decision was made that the next session would otherwise re-litigate. Give each new section a date and tag it `SHIPPED`, `PROPOSED` or `BLOCKED`; sections written before this rule carry neither and need not be back-filled. Do not record what the code, the tests or git history already say. Delete a section once it becomes wrong — stale memory costs more than none.

Never write credentials, provider transcripts, hostnames, tunnel ports or internal URLs in either file.

Plans and review logs are not kept in either file; the log records outcomes. Change a durable fact here only when it stops being true.

AI Agent Control Plane routes work across complete assistant environments (Claude Code, Codex, Cursor, Bedrock and an opt-in OpenRouter model), normalizes execution events, checkpoints work, handles approvals/failover, and compares parallel runs.

- Architecture: pnpm monorepo. `apps/api` is a Fastify/SQLite orchestration service; `apps/web` is a React 19/Vite UI; `packages/core` owns contracts/state/redaction; `packages/adapters` owns provider runtimes.
- Entry points: `apps/api/src/index.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`.
- Persistence: better-sqlite3 plus ordered SQL migrations in `apps/api/src/db/migrations`.
- Core flow: task creation → deterministic/explainable route → adapter execution → normalized event stream/SSE → checkpoint/handoff/failover. Parallel compare/race and telemetry-fed routing are implemented.
- Security constraints: workspace-per-process isolation, repo allowlist, provider credentials remain in provider tooling/environment, redaction before persistence, explicit approval events.
- Build/test: `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- State: Phases 0–5 plus the kernel-service slices in the log. Suite sizes change every slice; read them from the latest PR body, not from here.
- Integration: `GET /api/meta` publishes `CONTROL_PLANE_API_VERSION` (`packages/core/src/contracts.ts`) and the capabilities a credential holds. API routes need a bearer credential or a bootstrapped browser session, even on loopback; a route opts out only by declaring `config.auth: null`. Cockpit is a live consumer: its `ControlPlaneClient` speaks API 2.x with a bearer credential read from `controlPlaneCredentialPath` and checks versions per policy (Cockpit #34). It also renders the context gauge (#37) and model catalog (#38).
- Weaknesses: large orchestration module; limited production packaging/observability. The API still refuses a non-loopback bind: remote access is a second loopback listener behind Tailscale Serve with Google OIDC owner login (B2; `docs/adr/remote-auth-design.md`, "B2 amendments").
- Portfolio: the source of truth for control/execution-plane contracts. `ai-control-plan-agentic-os` was a documentation worktree; its design docs are now tracked here under `docs/`. It is not a separate product.
- Contract distribution (plan §7.7a, owner decision 2026-10-06 on #76): JSON Schemas under `contracts/` live in this repo, and Cockpit vendors a copy pinned by commit SHA with a sha256 manifest test. Never use a moving-branch dependency. Revisit publishing a package at M10.
- Open questions: whether remote execution is actually required.

