# Project Progress

## Current phase

**Phase 1 — complete.** The core loop `prompt → route → execute → observe` runs end to end. Next: Phase 2 (checkpoints, handoff, quota failover).

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
- [x] **Phase 1:** `ClaudeAdapter` on the Claude Agent SDK — streaming messages → normalized events, `canUseTool` → `approval.requested` round-trip, `rate_limit_event` (utilization/resetsAt/window) → `usage.updated`/`limit.approaching`/`limit.hit`, session id captured for resume
- [x] **Phase 1:** `CodexAdapter` on `@openai/codex-sdk` — `runStreamed()` thread events → normalized events, per-turn usage from `turn.completed`, thread id captured for resume; manifest honestly reports `reportsLimits: false` (no quota payload at this SDK layer)
- [x] **Phase 1:** `FakeAdapter` — deterministic scripted adapter for tests and dev walkthroughs (`[FAKE:APPROVAL]`, `[FAKE:LIMIT]` prompt switches)
- [x] **Phase 1:** registry with manifest cache, on-demand + boot sync, and capability-diff recording
- [x] **Phase 1:** rule router — hard filters (auth, capabilities, repo allowlist, quota, cooldown) + `auto`/`preserve-quota`/`fastest` profiles, persisted explanation object, user override
- [x] **Phase 1:** orchestrator — run lifecycle, append-only event ingestion, envelope derivation from the stream, quota snapshots, approval relay, runtime cap, boot reconciliation of orphaned runs
- [x] **Phase 1:** git safety — branch `task/<id>` in a dedicated worktree, dirty-tree refusal
- [x] **Phase 1:** REST + SSE API; `progress.md` rendered projection
- [x] **Phase 1:** UI — New Task with routing recommendation panel, Task Board, Task Detail (Activity / Usage / Routing / Progress) with inline approvals
- [x] **Phase 1:** verified live — 45 tests green; full loop exercised against a running server (route explanation → run → 9 normalized events → `progress.md`), approval round-trip, and SSE live tail

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

- [ ] Phase 2: checkpoint assembly (envelope snapshot + checkpoint commit + diffstat + activity summary)
- [ ] Phase 2: `handoff.md` + handoff prompt template; manual handoff endpoint/UI
- [ ] Phase 2: limit monitor — soft-threshold eager checkpoint, `limit.hit` → LIMIT_PAUSED → auto-failover with loud UI banner, `resets_at`-aware cooldowns
- [ ] Phase 2: same-provider `resume()` wired for pause/continue

### Known Phase-1 limitations (deliberate, revisited in later phases)

- Codex quota percentages are not exposed at the SDK layer; the manifest says so and limit *hits* are caught by error classification. Revisit in Phase 2 if the SDK surfaces `rate_limits`.
- Codex runs sandboxed with `approvalPolicy: "never"` — interactive approvals are Claude-only for now.
- `fastest` profile has no latency telemetry yet and says so in its explanation; real scoring lands in Phase 5.
- Router cooldowns are plumbed through but always empty until Phase 2 populates them.

## Log

- 2026-08-21 — Architecture review completed and pushed to `claude/multi-assistant-routing-plan-vw0bwc`.
- 2026-08-21 — Architecture accepted; Phase 0 scaffolding built and verified (`pnpm dev` boots API + UI against migrated SQLite; typecheck/lint/20 tests green).
- 2026-08-22 — Phase 1 delivered: real Claude + Codex adapters written against the installed SDKs' type declarations, rule router, orchestrator with SSE and approvals, three UI screens. 45 tests green; core loop verified live end to end.
