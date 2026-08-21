# Project Progress

## Current phase

**Architecture review — complete.** Awaiting owner acceptance before Phase 0 implementation begins.

## Done

- [x] Reviewed the original proposal (`docs/original-plan.md`)
- [x] Verified 2026 provider integration surfaces (Claude Agent SDK, `@openai/codex-sdk`, Cursor `agent` CLI headless, Bedrock AgentCore)
- [x] Architecture review with KEEP / CHANGE / REMOVE / DEFER (`docs/architecture-review.md`)
- [x] Revised architecture (`docs/revised-architecture.md`)
- [x] Phased implementation plan (`plans/implementation-plan.md`)

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

- [ ] Owner reviews and accepts/amends the revised architecture
- [ ] Phase 0: monorepo skeleton, SQLite schema, workspace config
- [ ] Phase 1: Claude + Codex adapters, rule router, normalized events, dashboard slice

## Log

- 2026-08-21 — Architecture review completed and pushed to `claude/multi-assistant-routing-plan-vw0bwc`.
