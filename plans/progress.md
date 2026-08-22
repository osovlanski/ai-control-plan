# Project Progress

## Current phase

**Phase 3 — complete.** Daily change-driven capability discovery, the catalog change feed, compressed event retention, and boundary redaction are implemented. Next: Phase 4.

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
- [x] **Phase 2:** `CheckpointService` — envelope snapshot + checkpoint commit on the task branch + diffstat + digested activity summary; git-derived file list reconciles what the agent never announced
- [x] **Phase 2:** handoff package (`renderHandoffPrompt` / `handoff.md`) — constraints marked inviolable, agent decisions marked revisitable, git state and activity digest inline, full history by reference
- [x] **Phase 2:** limit monitor — soft-threshold (85%) eager checkpoint, `limit.hit` → LIMIT_PAUSED → checkpoint → reroute → HANDING_OFF → RUNNING on the next assistant; all-limited parks in WAITING_INPUT naming what to wait for
- [x] **Phase 2:** `CooldownStore` — `resets_at`-aware routing penalties, surfaced as hard-filter reasons in the routing explanation and in the assistant catalog
- [x] **Phase 2:** failure-triggered failover, gated on an actual provider error (a user-denied approval is an intentional stop, not a provider fault)
- [x] **Phase 2:** manual handoff endpoint + UI; same-provider `resume()` wired; one worktree reused across handoffs so work carries over
- [x] **Phase 2:** UI — live failover banners, Handoff tab (handoffs + checkpoints + package link), cooldown warnings in the catalog
- [x] **Phase 2:** verified live — 51 tests green; a limit on one assistant automatically checkpointed, rerouted, and completed on the other, with both routing decisions recorded

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

- [x] **Phase 3:** daily change-driven capability probes and idle quota snapshots
- [x] **Phase 3:** Assistant Catalog "what changed today" feed
- [x] **Phase 3:** gzip archives for terminal-task events older than 30 days
- [x] **Phase 3:** pre-insert event and render/handoff redaction

### Architecture changes made during Phase 2 (with reasons)

- **`WAITING_INPUT → HANDING_OFF` added to the state machine.** A task parked because everything was rate-limited is exactly the case where the user manually reroutes it; the original transition table forbade it.
- **Failure-failover now requires an observed `error` event,** not merely a non-ok run. A user denying an approval ends the run !ok, and rerouting there is wrong — the next assistant would ask the same question.
- **A handoff claims the task's next transition before cancelling the current run,** so the draining run cannot race it into a terminal state.
- **Terminal tasks refuse handoff.** Continuing finished work is a follow-up task, not a handoff; terminal stays terminal.
- **`completed` de-duplicates against the whole list,** not just the last entry: after a handoff the next assistant re-narrates the same steps, and the package degraded with every hop.

### Known limitations (deliberate, revisited in later phases)

- Codex quota percentages are not exposed at the SDK layer (verified against the installed type declarations); the manifest reports `reportsLimits: false` and limit *hits* are caught by error classification. Failover works for Codex on the hit, just without an early warning.
- Codex runs sandboxed with `approvalPolicy: "never"` — interactive approvals are Claude-only for now.
- `fastest` profile has no latency telemetry yet and says so in its explanation; real scoring lands in Phase 5.
- Cross-provider `resume()` is never used — cross-provider continuation always goes through a fresh `start()` with the handoff package, by design.

### Architecture changes made during Phase 3 (with reasons)

- **Probes remain outside the six-method adapter contract.** Cheap CLI version, auth-state, configured-model, and MCP/skills hashes gate the existing `describe()` call.
- **Retention archives transactionally in SQLite.** Gzip blobs replace old live rows and the existing event endpoint reads both forms.
- **Redaction runs at event ingestion.** Only the redacted event reaches SQLite, envelope derivation, or SSE; renderers make a second pass for user-authored data.
- **Checkpoint commits tolerate same-tree races.** A concurrent checkpoint that already committed the staged tree resolves to clean HEAD.

### Phase 3 limitations

- Idle quota refresh is best-effort from cached manifest limits. Providers exposing quota only in run streams cannot be polled without violating the settled adapter contract.
- Model discovery uses models named in supported local config when no typed SDK/CLI model-list surface exists.
- Baseline redaction covers common keys, bearer tokens, JWTs, and secret-style `.env` assignments; it is not a general DLP engine.

## Log

- 2026-08-21 — Architecture review completed and pushed to `claude/multi-assistant-routing-plan-vw0bwc`.
- 2026-08-21 — Architecture accepted; Phase 0 scaffolding built and verified (`pnpm dev` boots API + UI against migrated SQLite; typecheck/lint/20 tests green).
- 2026-08-22 — Phase 1 delivered: real Claude + Codex adapters written against the installed SDKs' type declarations, rule router, orchestrator with SSE and approvals, three UI screens. 45 tests green; core loop verified live end to end.
- 2026-08-22 — Phase 2 delivered: checkpoints, portable handoff packages, `resets_at`-aware cooldowns, and automatic quota failover. 51 tests green; verified live — a limit on one assistant checkpointed and completed on the other, and an all-limited task parked with the reasons and reset times named.

- 2026-08-22 — Phase 3 delivered: change-driven daily capability probes and catalog feed, compressed 30-day event retention, and pre-persistence/render/handoff redaction.
