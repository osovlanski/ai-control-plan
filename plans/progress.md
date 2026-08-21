# Project Progress

## Current phase

**Phase 0 — complete.** Next: Phase 1 (Claude + Codex adapters, rule router, normalized events, dashboard slice).

## Done

- [x] Reviewed the original proposal (`docs/original-plan.md`)
- [x] Verified 2026 provider integration surfaces (Claude Agent SDK, `@openai/codex-sdk`, Cursor `agent` CLI headless, Bedrock AgentCore)
- [x] Architecture review with KEEP / CHANGE / REMOVE / DEFER (`docs/architecture-review.md`)
- [x] Revised architecture (`docs/revised-architecture.md`)
- [x] Phased implementation plan (`plans/implementation-plan.md`)
- [x] Architecture accepted by owner (2026-08-21); decision: stay on current model tier for Phases 0–1
- [x] **Phase 0:** pnpm monorepo (`apps/api`, `apps/web`, `packages/core`, `packages/adapters`)
- [x] **Phase 0:** `packages/core` domain types — branded ids, 9-state machine (+ tests), TaskEnvelope, NormalizedEvent set, CapabilityManifest, 6-method AgentAdapter contract
- [x] **Phase 0:** SQLite schema `001_init.sql` (11 tables) + forward-only migration runner (+ tests)
- [x] **Phase 0:** workspace-instance config loader (`~/.agent-plane/<workspace>/config.yaml`, auto-created, validated, isolated DB per workspace) (+ tests)
- [x] **Phase 0:** Fastify API — /api/health, /api/workspace, /api/assistants, /api/tasks (+ tests); React/Vite empty UI with /api proxy
- [x] **Phase 0:** CI workflow (typecheck, lint, test, build); all green locally — 20 tests passing

## Key decisions so far

| Decision | Where |
|---|---|
| Workspace = one control-plane instance per machine (no Runner protocol) | review §3.1 |
| AgentAdapter slimmed to 6 methods; capabilities via single `describe()` manifest | review §3.2 |
| Checkpoint/handoff are control-plane functions, not adapter methods | review §3.2, §3.7 |
| Rule-based explainable router first; telemetry-fed scoring in Phase 5; no synthetic benchmarks | review §3.3 |
| 9 orchestration states + informational activity-phase annotations | review §3.5 |
| Quota failover driven by in-stream events (Codex `rate_limits`, Claude limit errors) | arch §8 |
| TypeScript + Fastify + SQLite + SSE; modular monolith (5 modules); no Redis/Postgres/queues | review §3.8 |

## Next

- [ ] Phase 1: `ClaudeAdapter` (Claude Agent SDK) + `CodexAdapter` (@openai/codex-sdk) — `describe()`, `start()`, normalized `events()` incl. `usage.updated`
- [ ] Phase 1: registry manifest cache + on-demand sync; rule router with explanation objects
- [ ] Phase 1: orchestrator run lifecycle, event persistence, SSE, approval flow-through
- [ ] Phase 1: UI — New Task + recommendation panel, Task Board, Task Detail (Activity/Usage/Routing)

## Log

- 2026-08-21 — Architecture review completed and pushed to `claude/multi-assistant-routing-plan-vw0bwc`.
- 2026-08-21 — Architecture accepted; Phase 0 scaffolding built and verified (`pnpm dev` boots API + UI against migrated SQLite; typecheck/lint/20 tests green).
