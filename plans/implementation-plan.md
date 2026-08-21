# Implementation Plan — AI Agent Control Plane

Phases are vertical slices: each ends with something runnable and demonstrable. No phase starts until the previous phase's success condition is demonstrated. Architecture reference: `docs/revised-architecture.md`.

---

## Phase 0 — Skeleton (small)

- Monorepo: `apps/api` (Fastify), `apps/web` (React/Vite), `packages/core` (domain types, envelope, events), `packages/adapters` (claude, codex).
- SQLite schema + migrations for the §3 domain model (Assistant, Task, Run, Event, Checkpoint, Handoff, RoutingDecision, TaskDecision, QuotaSnapshot, CapabilityChange).
- Workspace instance config: `~/.agent-plane/<workspace>/config.yaml` (workspace name, repo allowlist, failover policy, sync hour) + DB file per workspace.
- CI: typecheck, lint, unit tests.

**Done when:** `pnpm dev` boots API + empty UI against a migrated SQLite file.

## Phase 1 — Vertical slice: prompt → route → execute → observe

- `ClaudeAdapter` (Claude Agent SDK) and `CodexAdapter` (`@openai/codex-sdk`): `describe()`, `start()`, `events()`, `cancel()`; normalized event mapping incl. `usage.updated` (Codex `token_count.rate_limits` from day one — it's free and Phase 2 needs it).
- `registry`: manifest cache + on-demand sync endpoint (daily cron lands in Phase 3).
- `tasks`: TaskEnvelope, 9-state machine, `progress.md` rendering, branch-per-task + dirty-tree refusal.
- `router`: hard filters + `Auto`/`Preserve Quota` rules + persisted explanation object.
- `orchestrator`: run lifecycle, event persistence, SSE fan-out, **approval flow-through** (`approval.requested` → UI → `send()`), max-runtime cap, boot reconciliation of orphaned RUNNING tasks.
- UI: New Task (with recommendation panel), Task Board, Task Detail (Activity + Usage + Routing tabs).

**Success condition:** submit one prompt → system explains and selects Claude or Codex → executes on a task branch → live normalized timeline with approvals working → `progress.md` renders → task completes.

## Phase 2 — Checkpoint, handoff, quota failover

- Checkpoint assembly (envelope snapshot + checkpoint commit + diffstat + activity summary); periodic + event-triggered.
- `handoff.md` rendering + handoff prompt template (constraints inviolable, decisions revisitable, by-reference pointers).
- Manual handoff endpoint/UI (`POST /tasks/:id/handoff`).
- Limit monitor: soft-threshold eager checkpoint, `limit.hit` → LIMIT_PAUSED → auto-failover to next eligible → loud UI banner; `resets_at`-aware cooldowns; all-limited → WAITING_INPUT with reset times.
- Same-provider `resume()` (both SDKs) for pause/continue.
- Failure-triggered failover (provider error/crash) behind the same path.

**Success condition:** Claude (or Codex) hits a recognized limit mid-task → automatic checkpoint → the other provider continues from the handoff package on the same branch → user saw a banner, `Routing` tab shows both decisions.

## Phase 3 — Capability sync & catalog

- Daily cron sync: version/auth/model/config-hash probe → re-`describe()` on change → `CapabilityChange` rows.
- Assistant Catalog screen + "what changed today" feed; quota snapshots while idle.
- Event-log retention job (compress tasks completed >30 days).
- Redaction rules applied to events/renders (basic patterns: keys, tokens, .env contents).

**Success condition:** a CLI upgrade or new model appears in the feed within a day without manual action.

## Phase 4 — Work workspace

- Second instance on the work machine from the same codebase (config + DB isolation, repo allowlist, approval-gated failover default).
- `CursorAdapter`: `agent -p --output-format json`, version-pinned, resume by chat id; manifest marks its thinner tier honestly (`reportsLimits: false` → router treats quota as unknown).
- `BedrockAdapter`: registry-configured deployed AgentCore agents; `InvokeAgentRuntime` streaming → normalized events; IAM/auth check in `describe()`; metered-cost tracking on `usage.updated`.
- Per-instance policy hardening (tool/approval policy, allowlists).

**Success condition:** on the work machine, a task routes across Claude/Cursor/Codex/Bedrock candidates with honest capability filtering, without any personal-workspace data or credentials present.

## Phase 5 — Parallelism & learned routing

- Worktree-per-assistant parallel modes: **Compare** first (both finish; diff/tests/lint side-by-side; user picks; merge winner), then **Race**; specialist pipelines (plan→implement→review) after.
- Passive telemetry scoring: rolling per-assistant, per-task-kind metrics (duration, tokens, retries, tests, corrections, failovers) → scoring router behind the existing `route()` interface; extended profiles (`Best Quality`, `Lowest Cost` once Bedrock's metered cost exists, `Custom` weights).
- Independent-reviewer mode (one assistant reviews another's diff).
- Optional: tiny opt-in eval set — only if telemetry demonstrably misses routing mistakes.

**Success condition:** one task runs on Claude and Codex in parallel worktrees; comparison view shows diffs/tests; chosen result merges; routing telemetry visibly updates.

---

## Deferred indefinitely (revisit only on demonstrated need)

Remote/EC2 runners (`RemoteAdapter` seam exists), LLM task classifier, federated cross-workspace dashboard, model-level auto-selection, Postgres/Redis/BullMQ, generic MCP/CLI adapters, synthetic benchmark suite, workflow DSL, multi-user/RBAC/billing, vector DB.

## Standing rules

- Native SDKs over CLI scraping; version-pin tier-2 CLIs and fail loud on schema drift.
- Every phase keeps: DB = source of truth, Markdown = projection; append-only events; explanations persisted for every routing decision and failover.
- No new infrastructure (queue, cache, second DB) without a failing requirement that names it.
