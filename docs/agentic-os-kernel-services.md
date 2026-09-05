# Agentic OS — Kernel Services (M12–M15)

**Status:** Proposed — revision 2 (planning only; no production implementation in this pass).
Revision 2 reconciles the adversarial review of revision 1 (2026-09-05): it makes the design
smaller, replaces every promise the running code cannot keep with a truthful one, and marks
deferred or split slices instead of renumbering them.
**Date:** 2026-09-05
**Reconciled against:** `ai-control-plan` `main@77a0b79`, `cockpit` `main@337f9fa`; installed SDKs
verified at review: Claude Agent SDK **0.3.238**, Codex SDK **0.149.0**.
**Companion documents:** `docs/agentic-os-plan.md` (master plan, M0–M15 / O1–O12, Phases 6–10),
`docs/agentic-os-vnext-plan.md` (increments 1–17), `docs/execution-harness.md` (Harness),
`docs/harness-implementation-progress.md` (standing deferrals #3, #4, #6, #7),
`cockpit/docs/specs/E-agentic-os-role.md` (Cockpit side).

## 0. Why this document exists

The Agentic OS design so far composes a per-run agent (Composer, M2 — **planned, not built**),
runs it through the Execution Harness, verifies, and learns which **assistant environment**
works best. Four things a kernel needs are missing or only implied:

| Service | One-line gap |
|---|---|
| **M12 Model Intelligence** | Routing picks an *assistant*; nothing records which *model* actually served a run, and there is no catalog of capacity, pricing or capability with provenance. |
| **M13 Deferred Execution / Scheduler** | A task either starts now or parks in `WAITING_INPUT` for a human. Nothing can wait for a time, a quota reset, or another task, and nothing owns a parked task durably. |
| **M14 Context Lifecycle** | Context-window occupancy is neither observed nor shown; the only remedy is a provider-side auto-compaction nobody sees. |
| **M15 Runtime Backend** | Adapters execute in-process by construction; the seam a second backend would use is unnamed. **Deferred** in revision 2 (§4.5). |

This document is the architecture for those four, in the style of `execution-harness.md`: the
gap matrix against running code, the external-reference adoption matrix, the conflict decisions,
the domain types, state transitions, API boundaries, acceptance criteria and tests, and the
vertical slices. Roadmap placement lives in the two plan documents; this document does not
restate their increments.

**Separation this document enforces:** `runtime → harness → model → assets → context`.

```text
runtime   WHERE the provider process lives          (M15 — deferred; SessionRunner.startProvider is the seam)
harness   WHICH assistant environment executes      (existing router + adapters)
model     WHICH model inside that environment       (M12: identity first, selection later, shadow first)
assets    WHAT skills/MCP/fragments are attached     (increment 5 / Spec E — planned, not built)
context   HOW MUCH of the window is in use, and what to do about it (M14: observe first, act later)
```

Each layer has one owner and one decision record; none decides for the layer above it. The
Harness still never selects an assistant or model (H-I1); the Control Plane still writes no
files; Cockpit still renders and returns bytes.

**Revision 2 in one paragraph.** K1 becomes a durable dispatch/ownership contract for newly
created single-task time waits plus boot recovery; converting already-parked work waits for
ownership safety (K2). Quota handling stops treating a retry timestamp as proof of recovery and
gets an explicit evidence model. M14 ships observations and gauges before any automatic
intervention, and clean-session continuation is bounded and checkpoint-anchored, never called
lossless. M12 records execution identity before it builds a catalog, and selection starts in
shadow mode with hard filters that no benchmark can bypass. K7 supplies price *evidence*; it does
not by itself close bounded cost caps. M15's runtime enum and K16's timer consolidation are
deferred. Blanket dependencies that forced all benchmark/context/runtime work to finish before
unrelated increments are removed.

---

## 1. Gap matrix — CURRENT / PARTIAL / MISSING / CONFLICT

Every row cites the running code. "CONFLICT" means an accepted prior decision or an existing
component contradicts the mandate and §3 records the resolution.

### 1.1 M12 — Model Intelligence Service

| Capability | Status | Evidence |
|---|---|---|
| Assistant selection with persisted explanation | CURRENT | `apps/api/src/modules/router.ts`, `routing_decisions`; profiles `auto`/`preserve-quota`/`fastest`/`best-quality`/`lowest-tokens` |
| Model passed through to providers | CURRENT (plumbing only, **two fields**) | `ExecutionRequest.model` (`packages/core/src/execution.ts:52`) and `RunSpec.model` (`packages/core/src/adapter.ts:38`) are both `ModelRef` with no stated authority; `claude.ts:99` `model: run.model?.id`; `codex.ts:88` |
| Observed model identity per run | PARTIAL, **Claude only** | Claude `run.started` payload carries `msg.model` (`claude.ts:156`); Codex `run.started` is emitted on `thread.started` with only `providerSessionRef` (`codex.ts:146-150`) — **no model identity**. `runs` has no `model` column |
| Model-level auto-selection | **CONFLICT** | `plans/implementation-plan.md` "Deferred indefinitely: … model-level auto-selection" (withdrawn 2026-09-05); `agentic-os-plan.md` §3.3 stage 2 says candidates widen to "assistant × model" — designed, unbuilt |
| Model catalog (capacity, pricing, capabilities) | MISSING | `CapabilityManifest.core.models` is two CLI aliases (`claude.ts:55`) or `"default"` (`codex.ts:56`); no table, no pricing; standing deferral #3 (bounded cost caps) is blocked on more than this (§4.4 pricing) |
| Pricing table | PARTIAL, wrong repo | `cockpit/modelPricing.ts` hand-maintained list rates with a family-match fallback; nothing in the plane; `BudgetPolicy.pricingVersion` is contracted with no producer |
| Provider-official catalog data | PARTIAL | Claude SDK `ModelUsage.contextWindow`/`maxOutputTokens`/`costUSD` arrive in `result` messages and are forwarded raw (`claude.ts:247 modelUsage`); `supportedModels()` exists in the SDK and is not called; Codex SDK 0.149.0 exposes no catalog; Codex App Server documents `model/list` (beyond the installed SDK) |
| Provider discovery of assistant availability | CURRENT | `capability-probe.ts` + `registry.ts` own which assistants exist and are enabled; M12 joins this, never re-decides it |
| External benchmark evidence (Artificial Analysis, LiveBench, BenchLM) | MISSING | none referenced anywhere; `telemetry.ts` comment: "No synthetic benchmark suite exists, and none should" — consistent (we consume published scores, we never run benchmarks) |
| Internal telemetry per assistant | CURRENT | `TelemetryService.scores()`: success, median duration, median tokens, test pass rate, failovers, 30-day window |
| Internal telemetry per **model** | MISSING | `runs` has no `model` column (`001_init.sql:67-76` + later `ALTER`s); model exists only in the Claude `run.started` payload |
| Task-dimension classification | PARTIAL | `classifyGoal()` → `coding \| review \| research \| general`; `verification-planner.ts` derives `impact:frontend` from changed files |
| Evidence provenance vocabulary | CURRENT (reuse) | `EvidenceSource` + `EVIDENCE_PRIORITY` (`capabilities.ts`), `evidence.observedAt`; review §3.4 decision: ordinal priority, **no fabricated confidence numbers**. Revision 2: ordinal priority alone does not order observations of different ages (§4.2 quota projection) |
| Routing telemetry on every routing entry | **PARTIAL, inconsistent** | intake routing (`server.ts:145-147`) passes `scores`; `Orchestrator.routeFor()` (`orchestrator.ts:915-934`) builds a `RouteRequest` **without** telemetry, so failover/handoff routing is blind to it |

### 1.2 M13 — Deferred execution / Scheduler

| Capability | Status | Evidence |
|---|---|---|
| Immediate execution | CURRENT | `POST /api/tasks` → `CREATED → ROUTING → RUNNING` |
| Retry timestamp after a limit | CURRENT, **misnamed as quota knowledge** | `CooldownStore.penalize(resetsAt)` with 1 h / 10 min fallback windows (`cooldown.ts:21-43`); `until` is *when to retry*, not proof the window has reset; `quota_snapshots` written from run events (`harness/quota-snapshot.ts`, `registry.ts:149`); router hard-filters on cooldown |
| Reset evidence propagation, Harness path | **PARTIAL, drops evidence** | legacy path: `run.limit.resetsAt` from `limit.hit` → `failoverTask(..., resetsAt)` (`orchestrator.ts:534,595`); Harness path: the `yielded/limit` settlement calls `failoverTask(taskId, assistantId, "quota", reasonText, sessionId)` **without** `resetsAt` (`orchestrator.ts:726-731`), so the cooldown always falls back to the default window |
| Two quota readers | **CONFLICT** | router reads `manifest.core.limits` (`router.ts:150-158 latestQuota`); run events write `quota_snapshots`; nothing reconciles them by observation time |
| All-candidates-limited handling | PARTIAL | `failoverTask()` parks in `WAITING_INPUT` and *names* the reset times (`describeWaits`); nothing wakes the task |
| Wake after quota reset | MISSING | `WAITING_INPUT → ROUTING` exists in the machine ("user asks to re-route, e.g. after quota reset") but is human-driven only |
| Durable dispatch identity for a scheduled start | MISSING (machinery exists elsewhere) | `handoff_envelopes` claim protocol (`harness/handoff.ts`: `claim`, `enterStartAmbiguous`, `markConsumed`, `release`) is landed, test-only, unwired (standing deferral #7); `SessionStore` `PREPARED→STARTING`; `HarnessRecovery.reconcileOnBoot` ack-lookup-or-hold |
| run-at / cron / dependency-complete for plane tasks | MISSING | no schedule entity, no wait condition, no timer other than `jobs.ts` |
| Timer loop with failure containment | CURRENT (pattern) | `jobs.ts scheduleDailyJobs`: `setTimeout` + always-reschedule + contained failures |
| Idle quota probe | PARTIAL / superseded note | Phase 3 note: "providers exposing quota only in run streams cannot be polled without violating the adapter contract". Probes already live *outside* the six-method contract (`capability-probe.ts`). Omarchy's scripts show both providers have an idle endpoint (§2.5); these are **optional, account-specific evidence**, not a manifest capability |
| `WAITING_RESOURCE` state | **CONFLICT** | 9-state machine is "a stable kernel … not extended" (vNext CR-14) — resolved by CR-16 |
| Dependency between tasks | PARTIAL | `parent_task_id` / `group_id` columns exist with no producer (vNext §3.5); increment 11 plans a subtask DAG |
| Schedule UI | CURRENT, different scope | Cockpit Schedule tab manages *Cockpit's own* jobs: Claude desktop `scheduled-tasks.json`, launchd/systemd units, cloud crontab (`cloudSchedule.ts`, `scheduleMeta.ts`, `server.ts:5257+`). None of it schedules plane tasks |
| Re-composition at wake | PARTIAL (reuse with fixes) | `failoverTask()` checkpoints → `routeFor()` → `startTask(..., {trigger:"handoff"})`. The handoff prompt is rendered **only when `trigger === "handoff"`** (`orchestrator.ts:311-314`); adding a `wake` trigger without making fresh-vs-resume explicit would silently render a fresh prompt |

### 1.3 M14 — Context Lifecycle Manager

| Capability | Status | Evidence |
|---|---|---|
| Context-window capacity per session | PARTIAL | Claude: `ModelUsage.contextWindow` forwarded raw in `usage.updated` (the model's advertised maximum); Codex SDK: none |
| Effective session window | MISSING | Claude `SDKContextUsage` is an **estimate against the resolved autocompaction window**, which may differ from `ModelUsage.contextWindow`; the adapter neither requests it nor forwards it |
| Occupancy in context | MISSING (adapter drops it) | Claude: `get_context_usage` control request → `SDKContextUsage` (`total_tokens`, `raw_max_tokens`, `percentage`, per-category breakdown, `over_limit`) — not consumed; Codex: `turn.completed` `input_tokens + cached_input_tokens` is **per-turn accounting, not established as live prompt occupancy** (revision 1 asserted it as an estimator; withdrawn) |
| `usage.updated` semantics | CURRENT, **mixed** | Claude emits `usage.updated` for rate-limit events (`claude.ts:238`, payload `quota` only) **and** for token usage (`claude.ts:249`). Some `usage.updated` events therefore carry no token information; nothing may manufacture occupancy from them |
| Context pressure policy | MISSING | no guard, no events; `BudgetGuard`/`QuotaGuard` in `session-runner.ts` are the seam |
| Prune | MISSING, and partly *impossible* for CLI providers | the provider owns its transcript; the plane can only (a) bound what it injects, (b) ask for compaction where a control exists, (c) start a clean session from a checkpoint |
| Compact — Claude | PARTIAL, **control exists, adapter does not expose it** | Claude Agent SDK documents programmatic `/compact` sent as a prompt on an existing conversation (`continue: true` or streaming input) and reports a `compact_boundary` system message with `compact_metadata.pre_tokens` / `trigger` (verified 2026-09-05, `code.claude.com/docs/en/agent-sdk/slash-commands`). The adapter drops `compact_boundary` and offers no session control beyond `send` |
| Compact — Codex | PARTIAL, **beyond the installed SDK** | Codex App Server documents `thread/compact/start` and `thread/tokenUsage/updated` (verified 2026-09-05, `learn.chatgpt.com/docs/app-server`); the installed `@openai/codex-sdk` 0.149.0 exposes neither. Revision 1's "TUI-only" claim is withdrawn |
| Verify reduction | MISSING | nothing re-measures |
| Checkpoint + clean session from a handoff package | CURRENT, **not lossless** | `CheckpointService`, `renderHandoffPrompt`, `origin:{kind:"fresh"}` start. A checkpoint can be **envelope-only after a Git failure**; the bounded summary is not a provider-memory export. `deferral #6` (provider `resume()` under flag-ON) is unwired and is **not** what M14 needs — resume carries the full context back |
| Immutable checkpoint/audit history under compaction | CURRENT (invariant) | append-only `events`, immutable `checkpoints`; compaction is provider-side and never touches them |
| Live context gauge (O10) | MISSING | `apps/web` Usage tab shows tokens in/out only; Cockpit has no context concept |
| Provider-managed context (Codex "Astra") | PARTIAL, provider-specific | Codex's experimental context management keeps notes and searches earlier task messages/tool results across windows; **opt-in** (`features.context_management.experimental_mode = true`), ChatGPT Plus/Pro on supported Codex clients, not available with Business/Enterprise/API-key sign-in at launch (verified 2026-09-05, `learn.chatgpt.com/docs/models`). An effective session/harness capability, not a model property |
| Legacy path parity | not applicable | M14 is built on the Harness path only (CR-4); the legacy `orchestrator.ts` path gets nothing, which is one more reason to finish increment 6 |

### 1.4 M15 — Runtime Backend abstraction

| Capability | Status | Evidence |
|---|---|---|
| In-process native SDK execution | CURRENT | `ClaudeAdapter` (Agent SDK), `CodexAdapter` (SDK spawns the CLI), `BedrockAdapter`, `CursorAdapter`, `OpenRouter` via Codex |
| Isolation tier declared and reported | CURRENT | `harness.processIsolation`, `ExecutionResult.enforcement.isolation` |
| Runtime kind declared | PARTIAL | `providerDetail.runtime: "claude-agent-sdk"` on one adapter only; not a typed field. **Revision 2: stays untyped** (§4.5) |
| Provider session survives plane restart | PARTIAL | `HarnessRecovery` offers resume for resume-capable sessions; consumption unwired (deferral #6) |
| Detach/reattach an interactive session | CURRENT, in Cockpit | `cockpit/pty.ts` PTY attach for observed sessions; not a managed-execution feature |
| Remote runner | DEFERRED, correctly | Phase 8; contracts carry the keys (`ExecutionTarget`) |
| Single launch seam | CURRENT, **conceptually named only** | `ProviderSessionDriver` is a name used in design documents; the implementation seam is `SessionRunner.startProvider` in `session-runner.ts`. The legacy `orchestrator.ts` path still launches adapters until increment 6 retires it |
| A `RuntimeBackend` interface | MISSING, and **one implementation exists** | building an interface for one implementation is exactly what `AGENTS.md` / the standing rules forbid |

---

## 2. External reference adoption matrix

Verdict vocabulary: **KEEP CURRENT** (we already have it, keep ours) · **BORROW DESIGN** (copy
the idea, not the code) · **INTEGRATE OPTIONAL** (an adapter/skill/backend behind config, never
core) · **REPLACE CURRENT** (theirs is better; swap) · **REJECT** · **DEFER** (decided useful,
unscheduled until a named need).

Inspected at: deepseek-harness `d347e70` (0.1.3-alpha.1), herdr `af7e189`, agent-room `3593f19`,
archify `d8e4daf` (2.17.0-dev.1), omarchy `e8e92c5` — all 2026-09-04/05.

Revision 2 summary — **keep:** inspectable resolved composition; durable ownership and
verification evidence; provider-neutral checkpoints and immutable audit history. **Modify:**
DeepSeek compaction ideas to fit provider-owned context; Agent Room markers become untrusted
reported evidence, never authority; Omarchy probes become optional scoped observations.
**Defer:** Herdr, `DshAdapter`, Archify integration, generic pruning and resource slots,
additional benchmark sources until one useful source is demonstrated. **Reject:** plugin-kernel
replacement, terminal-regex canonical state, a new agent coordination bus, unrelated OS-shell
integration.

### 2.1 DeepSeek Harness (`dsh`) — architecture reference

| Feature | Verdict | Reason |
|---|---|---|
| Everything-is-a-plugin (Cordis) core | REJECT | The plane's seams are fixed and few (adapters, verifiers, sinks, guards). A plugin kernel is architecture for a product that *is* a harness; ours is a control plane over foreign harnesses. Standing rule: no interface with one implementation. |
| **Profiles = ordered bundle layers + patch; `--dump-config` prints the resolved tree** | BORROW DESIGN | This is our `AgentSpec`/`CompositionDecision` in another vocabulary: layered, inspectable, replayable composition. Borrow the *dump* idea: every composed run must be able to print its resolved composition. Already the intent of M7; make it an acceptance criterion of increment 5. |
| Per-agent `preset` mounted under an agent scope | BORROW DESIGN | Same as our per-run ephemeral profile (A6). Confirms the ownership split. |
| **Compaction family** (`compaction-basic` + `tool-result-pruner` + `/compact`): threshold of routed window, prune before summarize, skip summary if pruning relieved pressure, `compaction/start`→`summary`→`end` bracket as durable events, "one token meter prices every decision", re-measure after acting | BORROW DESIGN, **modified for provider-owned context** | dsh compacts *its own* session log and can measure it exactly. For Claude/Codex the transcript belongs to the provider: occupancy is an estimate or unavailable, "prune" has no mechanism, and "compact" is a provider command where one exists. What survives: durable before/after observations around any action, re-measure after acting, stop escalating when pressure is relieved, and provider auto-management as the primary mechanism (§4.3). The fixed prune→compact ladder does **not** survive. |
| Tool-output **spill** (oversized tool text to a file + locator) | REJECT for now | Applies to a harness that owns tool results. Our injected content (handoff prompt, bundle) is already size-bounded. Revisit only if a `DshAdapter` lands. |
| `goal-round-driver` (same-session goal continued in rounds) | KEEP CURRENT | Our continuation unit is checkpoint → handoff package → new session; it is provider-neutral and survives failover, which rounds inside one session do not. |
| `schedule` package (session-local reminders) | REJECT | Reminders delivered as chat messages inside one session. Not task scheduling. M13 is a plane-level scheduler over durable tasks. |
| `jobs` (background jobs a model can start/collect) | REJECT | Model-facing background work inside one session. The plane's unit is the task; subtasks arrive in increments 10–11. |
| Session projections (fold events into typed state) | KEEP CURRENT | `state-vocab.ts` read-time derivation and `EvidenceBundle` are the same pattern. |
| Agent Teams (roster, task board, mailbox) | REJECT | See Agent Room row: the Harness rule "a running agent never spawns sessions" stands. |
| **dsh as an assistant environment** (SDK JSON-RPC server, `--profile sdk`, ACP) | DEFER (`DshAdapter`) | Fits the six-method contract. Build only when a task class needs a DeepSeek model with a real harness; OpenRouter-in-Codex already covers "evaluate a model". |

### 2.2 Herdr — persistent runtime reference

| Feature | Verdict | Reason |
|---|---|---|
| Background server owns PTYs; close the lid, reattach later | DEFER (optional, unscheduled) | Solves "the interactive terminal survives"; our managed runs are SDK streams, not terminals, and `HarnessRecovery` + provider `resume()` is the restart story. **No K1–K14 requirement needs it.** |
| working / blocked / idle by **screen-tail regex** (`src/detect`) | REJECT as a state source | Heuristic over terminal text. Cockpit already infers richer `RuntimeStatus` from hooks with `{source, confidence}` (CR-2). Managed sessions have canonical states. |
| Socket API `wait` (block until another agent is blocked) | BORROW DESIGN → M13 `dependency` wait | "Wake when task X reaches a terminal state", delivered by the scheduler, not by polling a pane. |
| Agent resume plans (`AgentResumePlan`: agent, argv, dedupe key) | KEEP CURRENT | We hold `providerSessionRef` + `canResume` per adapter; deferral #6 is the wiring, not a design gap. |
| Server handoff during replacement (`HandoffRuntimeState`) | KEEP CURRENT | Our restart safety is lease fencing + boot reconciliation over durable rows. |

### 2.3 Agent Room — inter-agent protocol reference

| Feature | Verdict | Reason |
|---|---|---|
| Structured markers `[DECISION] [TODO] [STATUS] [RESULT]` extracted into artifacts | BORROW DESIGN, **as untrusted reported evidence** | `TaskEnvelope` already has `decisions` (provenance-tagged), `completed`, `remaining`, `nextAction`, derived from events (`envelope-derivation.ts`). A marker an agent emits is *reported* evidence with provenance `agent-reported`; it never becomes a verdict, a state, or authority over verification. Small addition to `deriveEnvelopeUpdate`; no new entity. |
| Evidence-gated task board (claim → submit with evidence → verified by a **different** agent) | KEEP CURRENT + BORROW one rule | Verification with evidence, verdict separate from execution, is already stronger here (H-I6, `EvaluationResult`, artifacts). Borrow: a `review`/`evaluator` check may require `verifier ≠ implementer`. Lands with the first `evaluator` provider (vNext §8). |
| Task turn lease (CAS grant, holder-only renew/release, expiry sweep, ordered ledger) | KEEP CURRENT | `handoff_envelopes` claim protocol + `uq_live_successor` + session lease fencing are the same mechanics (deferral #7 wires them; K1 reuses them, §4.2). |
| Presence / long-poll listen loop / turn discipline | REJECT | Presence is for peers in a chat. Our agents do not talk to each other. |
| **Webhook wake-up** | BORROW DESIGN → M13, unscheduled | An inbound webhook is a legitimate future *source* of a wake — off the roadmap until a real integration asks. |
| Shared room as the coordination bus | REJECT | Orchestration stays in the Control Plane (Harness §11). |
| Exportable report | KEEP CURRENT | `progress.md` / `handoff.md` are rendered projections; increment 13 adds structural progress. |

### 2.4 Archify — Cockpit Asset Registry candidate

| Feature | Verdict | Reason |
|---|---|---|
| Agent skill producing typed JSON IR → deterministic self-contained diagrams | DEFER (registry asset after increment 5) | Fits Cockpit's existing skill install path; no plane code. Attached by the Composer only once the Composer exists and M12's task dimensions include `architecture` — neither is scheduled before increment 5 and K13 activation. |
| Using Archify for *this* document's diagrams | REJECT here | Markdown with ASCII/mermaid is the design corpus. |

### 2.5 Omarchy — OS-shell / UX reference

| Feature | Verdict | Reason |
|---|---|---|
| Per-subscription 5-hour / weekly utilisation + reset time, refreshed every 15 min | BORROW DESIGN (UX) + **BORROW the probes as optional scoped observations** (K3) | `bin/omarchy-agent-usage-claude` reads the OAuth token from `~/.claude/.credentials.json` and GETs `https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) → `five_hour` / `seven_day*` buckets with `utilization` and `resets_at`. `bin/omarchy-agent-usage-codex` calls the Codex app-server RPC `account/rateLimits/read` → `primary`/`secondary` windows with `usedPercent`, `windowDurationMins`, `resetsAt`. Both use the provider's own credentials in place. **Scope:** each probe is evidence for one provider **account and quota bucket**; it is recorded as a `provider-api` observation (§4.2), never as a manifest capability. The Codex RPC is observed in Omarchy's script and **not present on the documented App Server page as fetched 2026-09-05** — unresolved until verified against a running app-server. |
| `omarchy agent prompt "…"` launches the default agent unattended | REJECT | Shell convenience; the plane's intake is the API. |
| Crash → hand the core dump to an agent | REJECT (idea noted) | A future webhook wake source at most. |
| One skill symlinked into every harness's skill directory | KEEP CURRENT | Cockpit already installs per assistant. |
| Theme sync, top bar, menus | REJECT | No reusable functionality for the plane. |

### 2.6 Benchmark sources (M12 cold-start priors) — one source first

| Source | What it gives | Access | Constraint |
|---|---|---|---|
| Provider-official | model ids, context window, max output, pricing, capabilities | Claude SDK `supportedModels()` + `ModelUsage`; Codex App Server `model/list` (beyond installed SDK); provider pricing pages | authoritative for capacity/price; **highest non-telemetry tier** |
| Artificial Analysis | intelligence/coding/math indices, LiveCodeBench, GPQA, MMLU-Pro, `price_1m_input/output_tokens`, `median_output_tokens_per_second`, `median_time_to_first_token_seconds` | REST, `x-api-key`, free tier 1 000 req/day (`artificialanalysis.ai/api-reference`) | **attribution required** ("https://artificialanalysis.ai/"); ids stable, slugs drift. **Candidate for the one verified source (K8)** |
| LiveBench | category scores: coding (incl. agentic coding), reasoning, math, language, data analysis, instruction following | leaderboard site; `all_groups.csv` / `all_tasks.csv` are **generated output of the repository's scripts, not a published feed**; HuggingFace datasets | The repository `LICENSE` is dual Apache-2.0 / MIT and covers **code**; it does not by itself state reuse terms for a leaderboard artifact (checked 2026-09-05). Before automated ingestion: pin the exact score source and release, and establish that artifact's reuse terms (`docs/DATASHEET.md`, `LiveBench/new-livebench`). Deferred until then |
| BenchLM | 8 weighted categories; context window and output price per model | `benchlm.ai/data` documents machine-readable exports: `/api/data/leaderboard`, `/api/data/pricing` (JSON) and versioned downloads such as `/data/models.json`, dated "Last updated" (checked 2026-09-05). Revision 1's "no documented API" claim is **withdrawn** | reuse terms and long-term compatibility **unproven**; treat as a pinned snapshot with recorded fetch date until terms are established. Deferred until one source (above) is demonstrated useful |

None of these is fetched on the routing path. They are refreshed by the existing daily job,
stored with provenance and TTL, and read from SQLite. **Benchmark prices are never used for
budget enforcement** (§4.4).

---

## 3. Conflict and overlap decisions — KEEP vs REPLACE

Numbering continues vNext CR-1…CR-15. Revision 2 amends CR-22, CR-23, CR-24, CR-25, CR-26,
CR-27, CR-28, CR-29 in place and adds CR-30…CR-34.

### CR-16 — `WAITING_RESOURCE` vs "the 9-state task machine is not extended" (CR-14)
- **A:** keep 9 states; express scheduler waits as `WAITING_INPUT` with a reason field.
- **B:** add one state, `WAITING_RESOURCE`, for waits the **scheduler** resolves.
- **Decision:** **REPLACE A with B — exactly one new state.** CR-14's rule is narrowed, not
  reversed: *outcomes and verdicts never become states* (still true); *a lifecycle wait with a
  non-human resolver is a state*.
- **Meaning (revision 2, normative):** `WAITING_RESOURCE` means **the scheduler owns a parked
  task and there is no live or ambiguous execution owner** — no `RUNNING`/`STARTING`
  session, no dispatch in `reserved` or `start_attempted`, and the predecessor session (if any)
  is terminal with its result persisted. `WAITING_INPUT` alone does not establish that: a task
  in `WAITING_INPUT` may be there because of a pending approval, a failed verification awaiting
  a call, or an unresolved comparison, and none of those may be deferred around (CR-32).
- **Reason:** `WAITING_INPUT` means "a person must act". Putting scheduler waits there makes the
  board lie: the operator cannot tell "needs me" from "resumes at 06:53". The state is also the
  scheduler's ownership boundary — only the scheduler (or the operator via the scheduler's own
  operation) may leave it.
- **Cost:** the transition matrix tests, `apps/web` board, Cockpit's state list and API 2.x
  contract all gain one enum member. Additive under the 1a compatibility policy (unknown enum
  member tolerated; minor bump to 2.1).
- **Migration:** none for rows; `WAITING_RESOURCE` has no existing producer.

### CR-17 — Model-level auto-selection was "deferred indefinitely"
- **Decision:** **REPLACE the deferral** (`plans/implementation-plan.md`) with M12, **in two
  steps**: execution identity and provider facts first (K7), selection in shadow mode later
  (K13), activation gated (§4.4).
- **Reason:** the deferral predates: per-run usage with `modelUsage`, the AgentSpec
  `model: {primary, fallbacks}` field, and a request that names model selection as kernel
  scope. The synthetic-benchmark half of that deferral **stays deferred**: we consume published
  scores, we never spend subscription quota running benchmarks.

### CR-18 — Routing profiles vs task-dimension weights
- **Decision:** **KEEP profiles, as named weight presets.** `fastest` = speed, `lowest-tokens` =
  token-efficiency, `preserve-quota` = quota-preservation, `best-quality` = coding+reasoning+review,
  `auto` = balanced. No second concept; the existing `profile` field on `tasks` is the API.
  Revision 2: the initial supported dimension set is small (§4.4); presets that name an
  unsupported dimension fall back to assistant-level behaviour and say so.

### CR-19 — Two pricing tables (Cockpit `modelPricing.ts` vs M12 catalog)
- **Decision:** **plane catalog is authoritative for price evidence** once `models.read` ships.
  Cockpit's local table is retired **after** Cockpit keeps an **offline read** of the last
  fetched plane catalog snapshot (so Usage/Retro still price with the plane down). Cockpit's
  **family-match fallback is never used to authorize a hard cost cap**, and neither is a
  benchmark price (§4.4).
- **Reason:** `BudgetPolicy.pricingVersion` is a plane contract; cost caps (deferral #3) and the
  Economics Ledger (§3.7 of the master plan) both need one versioned source — but K7 supplies
  the *evidence*; bounded enforcement has further gates (§4.4).

### CR-20 — Cockpit Schedule tab vs the plane Scheduler
- **Decision:** **KEEP both, distinct sources.** Cockpit's tab keeps owning Cockpit jobs (scans,
  retros, Claude desktop `scheduled-tasks.json`, launchd/systemd, cloud crontab). It gains a
  **read** of plane schedules and `WAITING_RESOURCE` tasks (`schedules.read`) and may **create**
  plane schedules only through `commands.write`. Execution semantics, next-fire computation,
  wake and re-composition are plane-only. Cockpit reuses `humanizeCron` / `classifyJobPurpose`
  for rendering. Recurring schedules are K5, demand-driven; the minimal waiting-state UI that
  accompanies K1 is a read of `WAITING_RESOURCE` tasks only.

### CR-21 — `classifyGoal` (4 kinds) vs `TaskDimension`
- **Decision:** **EXTEND, not replace, initially.** `classifyTask()` produces weights over the
  small initial dimension set (§4.4) and `classifyGoal` remains the derived projection
  `TelemetryService.scores(taskKind)` reads. The full eleven-dimension vocabulary of revision 1
  is not a commitment; dimensions are added when a prior and a telemetry metric both exist.

### CR-22 — "Idle quota cannot be polled without violating the adapter contract" (Phase 3 note)
- **Decision:** **REPLACE the note; probes are optional evidence, not a capability.** Probes
  already sit outside the six-method contract (`capability-probe.ts`). A `QuotaProbe` per
  provider is a probe, not an adapter method, and it is **optional and account-specific**: it
  exists only where a provider/account exposes an idle endpoint and the operator enables it.
  Its output is a `QuotaObservation` with `source: "provider-api"` and an explicit account/bucket
  scope (§4.2). **The manifest flag `reportsLimits` describes the run stream and is untouched:**
  an idle probe does not make the Codex SDK stream report limits, so Codex stays
  `reportsLimits: false` even with a working probe.

### CR-23 — Dependency-complete waits vs increment 11's subtask DAG
- **Decision:** **MERGE, with cycle rejection at first ship.** M13 ships the primitive "wake
  when task X reaches a terminal state" (flat, any task) in K4. Self-dependencies and
  dependency cycles are **rejected when K4 ships**, not later in increment 11; a missing or
  deleted dependency is treated as `FAILED` for `onDependencyFailure` purposes. Increment 11's
  DAG scheduling builds on it and adds skip-with-reason, not a second wait mechanism.

### CR-24 — `jobs.ts` daily timer vs the Scheduler timer
- **Decision:** **KEEP `jobs.ts`; consolidation (K16) is deferred** until a demonstrated
  operational need (a real double-fire, missed run or ordering bug caused by two loops). Two
  timer loops are not a defect by themselves.

### CR-25 — `yield.kind` growth for context pressure
- **Decision:** **add `"context"`** to `ExecutionResult.yield.kind` and the guard directive
  `yield(kind)` union. Additive; reason strings are not a vocabulary. **A healthy context
  yield is not a provider error and never counts as a reliability failure** in telemetry
  (§4.4, I-M4).

### CR-26 — Provider `resume()` (deferral #6) vs M14's clean-session continuation
- **Decision:** **distinct, both kept.** `resume()` continues the *same* provider context (no
  reduction) and is right after a plane crash. M14's last rung starts a **fresh** session from
  a specific checkpoint precisely to shed context, and is **not lossless** (§4.3). M14 does not
  wait on deferral #6.

### CR-27 — O10 optional gauge vs M14
- **Decision:** **REPLACE**: O10 moves into M14's mandatory scope **and becomes M14's first
  deliverable** (observation before intervention): the `apps/web` Usage tab and Cockpit's
  managed session view show occupancy, window, method and freshness, including "unknown". O9
  (cheap-model pre-flight) folds into M12 as a selection outcome once K13 is activated; its
  "SDK-direct single-model run" half stays deferred.

### CR-28 — Herdr / dsh as mandatory runtime
- **Decision:** **REJECT mandatory; DEFER optional.** Herdr remains optional and unscheduled;
  no K1–K14 requirement justifies it. M15's typed runtime enum is deferred with it (§4.5).

### CR-29 — Parking a task the scheduler cannot wake
- **Decision (revision 2 replaces revision 1):** the scheduler may take a task into
  `WAITING_RESOURCE` only when (a) the ownership precondition of CR-16 holds, and (b) it can
  compute a **retry instant** (`notBefore`: a time, a controlling reset per §4.2, a bounded
  inferred backoff, or a dependency). `CooldownStore.until` is such a retry instant; it is
  **not** evidence that quota has recovered, so a wake on it **revalidates** before starting.
  Execution wake attempts that re-park are counted in `autoWakes`; probe attempts are counted
  separately and never consume the wake budget. After `maxAutoWakes` (default 3) consecutive
  re-parks, or when the blocker kind is `intervention-required`, the task falls back to
  `WAITING_INPUT` with the history attached. Humans are never bypassed forever.

### CR-30 — One routing entry point (new)
- **Decision:** intake, wake, failover and context yield all route through **one** Control
  Plane operation, `routeTask(taskId, origin)`, which always supplies telemetry scores,
  cooldowns, the effective quota projection and the persisted user intent. `Orchestrator.
  routeFor()` (which omits telemetry) is replaced by it. `origin ∈ {intake, wake, failover,
  context-yield}` is an audit label; it never changes *what* is routed.

### CR-31 — Fresh-vs-resume is a continuation decision, not a trigger label (new)
- **Decision:** `startTask` takes an explicit `continuation: {kind:"fresh"} | {kind:"checkpoint",
  checkpointId}` and renders the prompt from it. `trigger` (`handoff`, `wake`, `context`, …) is
  recorded on `handoffs.trigger` for audit only. Today's rule "render the handoff prompt only
  when `trigger === "handoff"`" is retired in the same change.

### CR-32 — Deferral never bypasses a human decision (new)
- **Decision:** `WAITING_INPUT → WAITING_RESOURCE` is legal only when the task's recorded
  `pause_kind` is one of `limit`, `provider_unavailable`, `no_candidate`, `harness_error`
  (recovered). It is **illegal** for `approval_pending`, `verification_failed`,
  `comparison_pending`, `handoff_requested`. `pause_kind` is written on every transition into
  `WAITING_INPUT` (K1 migration) and is required by the transition guard.

### CR-33 — Execution identity has one authority (new)
- **Decision:** `ExecutionRequest.model` is the Control Plane's **requested selector**; the
  Harness bridge builds `RunSpec.model` as a validated projection of it (never the other way
  round), and the **resolved** identity is a separate observation recorded from provider
  evidence, allowed to be `unknown`. Historical aliases are never resolved with today's catalog
  (§4.4).

### CR-34 — Provider auto-management is primary where it exists (new)
- **Decision:** where a provider manages its own context (Claude autocompaction, Codex
  experimental context management), the plane **observes** and records; it intervenes only
  when the provider's mechanism is absent or has demonstrably not relieved pressure, and only
  with fresh observations (§4.3). Provider-specific storage/search mechanisms (Astra notes and
  history search) stay out of generic kernel types and are described on the adapter manifest.

---

## 4. Architecture

### 4.1 Placement

```text
                     Cockpit (renders waiting tasks · schedules · context gauge · model catalog; never executes)
                                            │ API 2.1 (additive caps: models.read, schedules.read, context.read)
   ┌────────────────────────────────────────┴────────────────────────────────────────┐
   │ CONTROL PLANE                                                                    │
   │  intake ─► [Scheduler M13: durable dispatch] ─► routeTask(origin) (CR-30)        │
   │                 ▲                                └─► assistant eligibility (existing)│
   │                 │                                    └─► M12 identity/shadow selection│
   │   wake conditions: time · quota(QuotaProjection) · dependency(task terminal)     │
   │   [resource slots deferred]  [recurring schedules: K5, demand-driven]            │
   │   Model catalog + evidence (provider-official · one external prior · own telemetry)│
   │   Effective quota projection shared by scheduler and router (§4.2)               │
   └────────────────────────────────────────┬────────────────────────────────────────┘
                                            │ ExecutionRequest (model selector + contextPolicy + capacity hints)
   ┌────────────────────────────────────────┴────────────────────────────────────────┐
   │ EXECUTION HARNESS                                                                │
   │  SessionRunner guards: Budget · Timeout · ToolPolicy · Approval · Quota          │
   │                        + ContextObserver (K9) → ContextGuard (K10/K11, gated)    │
   │  observations: occupancy · window · advertised max · source · freshness         │
   │  continuation: checkpoint-anchored clean session, bounded per task              │
   └────────────────────────────────────────┬────────────────────────────────────────┘
                                            │ AgentAdapter (6 methods) + optional capability-gated context controls
                     launch seam: SessionRunner.startProvider (M15 enum/abstraction deferred)
```

### 4.2 M13 — Scheduler

#### 4.2.1 Entities

```ts
/** Durable user intent. Persisted on the task; survives every dispatch unchanged. */
interface TaskIntent {
  goal: string;
  constraints: string[];
  repository?: { path: string; branch?: string };
  profile: RoutingProfile;
  /** Explicit user overrides. These are intent, not resolved choices, and are re-applied as
   *  FILTERS at every dispatch (a pinned assistant still limited at wake → re-park). */
  overrides?: { assistantId?: AssistantId; modelSelector?: string; budget?: BudgetPolicy;
                permissionPolicy?: PermissionPolicy };
}

/** Attached to a task; exactly one ACTIVE condition per task. Durable. */
interface WaitCondition {
  schemaVersion: 1;
  taskId: TaskId;
  /** Monotone per task. Every wake names the generation it consumes (CAS). */
  generation: number;
  state: "active" | "consumed" | "replaced" | "cancelled" | "expired";
  kind: "time" | "quota" | "dependency";          // "resource" deferred (K4b)
  /** Retry instant. kind=time: the requested instant. Every kind: earliest re-check. */
  notBefore: string;
  /** kind=quota: wait SUBJECTS (which assistants' blockers must clear); empty = any eligible
   *  assistant. A subject is not a choice — I-S1. */
  assistants?: AssistantId[];
  /** kind=quota: the blocker(s) this wait is parked on, with provenance (§4.2.4). */
  blockers?: QuotaBlocker[];
  /** kind=dependency: wake when every listed task is terminal. Validated acyclic at attach. */
  dependsOn?: TaskId[];
  onDependencyFailure?: "cancel" | "wake-anyway" | "wait-input";
  createdBy: "user" | "scheduler" | "failover" | "operator";
  createdAt: string;
  /** Execution wake attempts that re-parked (CR-29). Probe attempts are NOT counted here. */
  autoWakes: number;
  /** Bounded history of retry decisions (last 10): {at, actor, outcome, reason}. */
  history: WakeAttempt[];
  consumedAt?: string; consumedBy?: "timer" | "operator" | "event";
  reason: string;
}

/** Durable dispatch identity — one row per attempt to start a task out of a wait. */
interface Dispatch {
  dispatchId: string;                 // ULID; also the successor ExecutionRequest id on the Harness path
  taskId: TaskId;
  conditionGeneration: number;        // the generation this dispatch consumed
  origin: "intake" | "wake" | "failover" | "context-yield" | "run-now";
  /** Continuation anchor. null = fresh start from TaskIntent (K1 scope). */
  checkpointId: string | null;
  phase: "reserved" | "start_attempted" | "started" | "reparked" | "aborted" | "cancelled";
  routingDecisionId?: number;         // written when routing has been persisted
  sessionId?: ExecutionSessionId;     // written when the session row exists
  createdAt: string; updatedAt: string;
  reason?: string;
}
```

`Schedule` (recurring template) and `schedule_occurrences` are defined in §4.2.6 (K5).

**Invariant (I-S1, revised): a wait condition or schedule stores intent and wait subjects,
never a resolved execution choice.** Durable user intent (`TaskIntent`, including explicit
overrides) is preserved verbatim. Execution choices — assistant, model, assets, composition
revision — are **recomputed at every dispatch** by `routeTask` against *current* cooldowns,
quota projection, catalog and telemetry, and each dispatch records a **new accepted routing
decision**. A quota wait may name assistants as *subjects* (whose blockers it waits on); that
is not a frozen choice, and routing at wake may pick a different assistant if one is eligible.
Continuation is anchored to a **specific checkpoint** (`Dispatch.checkpointId`) or is
explicitly fresh.

**Composer status.** Full asset recomposition at wake is **conditional on increment 5**; the
Composer is planned, not implemented. K1 promises routing at wake (assistant, and model once
K13 is active); it does not promise asset recomposition.

#### 4.2.2 Task state machine — one added state, seven added edges, with preconditions

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> ROUTING
    CREATED --> WAITING_RESOURCE : wait attached at creation (time · dependency)
    CREATED --> CANCELLED
    ROUTING --> RUNNING
    ROUTING --> WAITING_INPUT : no eligible candidate and no computable retry
    ROUTING --> WAITING_RESOURCE : no eligible candidate, retry computable (CR-29)
    ROUTING --> FAILED
    ROUTING --> CANCELLED
    RUNNING --> WAITING_INPUT
    RUNNING --> LIMIT_PAUSED
    RUNNING --> HANDING_OFF
    RUNNING --> COMPLETED
    RUNNING --> FAILED
    RUNNING --> CANCELLED
    LIMIT_PAUSED --> HANDING_OFF
    LIMIT_PAUSED --> WAITING_INPUT
    LIMIT_PAUSED --> WAITING_RESOURCE : all candidates blocked; session settled; retry computable
    LIMIT_PAUSED --> CANCELLED
    WAITING_INPUT --> RUNNING
    WAITING_INPUT --> ROUTING
    WAITING_INPUT --> HANDING_OFF
    WAITING_INPUT --> WAITING_RESOURCE : operator defers; pause_kind wait-eligible (CR-32)
    WAITING_INPUT --> COMPLETED
    WAITING_INPUT --> FAILED
    WAITING_INPUT --> CANCELLED
    WAITING_RESOURCE --> ROUTING : wake(generation) — timer, event or operator run-now
    WAITING_RESOURCE --> WAITING_INPUT : maxAutoWakes / intervention-required / dependency failed with wait-input
    WAITING_RESOURCE --> CANCELLED
    HANDING_OFF --> RUNNING
    HANDING_OFF --> WAITING_INPUT
    HANDING_OFF --> FAILED
    HANDING_OFF --> CANCELLED
```

| Edge | Trigger | Precondition (checked inside the transaction) | Atomic side effects |
|---|---|---|---|
| `CREATED → WAITING_RESOURCE` | `wait_attached` | task has no session, no dispatch; condition valid (`notBefore` parses; dependency set acyclic and non-self) | insert `wait_conditions` gen 1 `active`; `tasks.state`; SSE |
| `ROUTING → WAITING_RESOURCE` | `no_candidate_retry_computable` | routing produced no eligible candidate; a controlling retry instant exists (§4.2.4); no dispatch in `reserved`/`start_attempted` for this task (the routing dispatch, if any, is marked `reparked` in the same tx) | insert condition (`kind: quota`, blockers, `notBefore`); `autoWakes` carried from the consumed condition + 1 when this is a re-park after a wake; `tasks.state` |
| `LIMIT_PAUSED → WAITING_RESOURCE` | `all_blocked_wait_for_retry` | predecessor session terminal **and** its `ExecutionResult` persisted (settled); checkpoint taken (as today); all candidates blocked with a computable retry | insert condition; `tasks.state`; the checkpoint id is recorded on the condition as the continuation anchor |
| `WAITING_INPUT → WAITING_RESOURCE` | `operator_deferred` | `tasks.pause_kind ∈ {limit, provider_unavailable, no_candidate, harness_error}` (CR-32); no live/ambiguous session; no open dispatch | insert condition (operator-supplied `time` or `quota`); `tasks.state` |
| `WAITING_RESOURCE → ROUTING` | `wake` | active condition `generation == expected`; task state is `WAITING_RESOURCE`; no open dispatch | condition → `consumed`; insert `dispatches` row `reserved`; `tasks.state`; (Harness path with a checkpoint anchor: claim the successor envelope and insert the successor `ExecutionRequest` in the same tx — deferral #7 machinery) |
| `WAITING_RESOURCE → WAITING_INPUT` | `auto_wake_budget_exhausted` / `intervention_required` / `dependency_failed` | as named; no open dispatch | condition → `expired`; `tasks.pause_kind` set; history attached to the task notice |
| `WAITING_RESOURCE → CANCELLED` | `cancel_requested` | — | condition → `cancelled`; any dispatch `reserved`/`start_attempted` → `cancelled`; `tasks.state` |

`ExecutionSessionState` is **unchanged**. A session that yields on quota already ends
`YIELDED(limit)`; the plane decides to wait.

#### 4.2.3 Durable dispatch and ownership — the wake protocol

One operation, used by the timer, by dependency/quota events and by operator run-now:

```text
wake(taskId, expectedGeneration, actor)                              ← ONE SQLite transaction
  1. SELECT active condition FOR task; require generation == expectedGeneration
     and tasks.state == WAITING_RESOURCE and no dispatch in {reserved, start_attempted}.
     Otherwise: return {outcome: "stale"} — a no-op with a reason (duplicate timer,
     replaced condition, concurrent run-now, cancel already applied).
  2. UPDATE wait_conditions SET state='consumed', consumed_at, consumed_by=actor.
  3. INSERT dispatches (dispatchId, taskId, conditionGeneration, origin, checkpointId, phase='reserved').
  4. tasks.transition(WAITING_RESOURCE → ROUTING, trigger='wake').
  5. Harness path with checkpointId ≠ null: handoff.claim(envelopeId, {requestId: dispatchId,
     insertRequest}) — the successor ExecutionRequest is built once and inserted here.
COMMIT.

then, outside the transaction:
  6. routeTask(taskId, origin)  → persistRoutingDecision → dispatches.routingDecisionId.
     No candidate → re-park (ROUTING → WAITING_RESOURCE, dispatch phase='reparked', autoWakes+1)
     or → WAITING_INPUT when CR-29 says so.
  7. dispatches.phase='start_attempted'  (durable, BEFORE any provider call)
  8. startTask(taskId, {continuation, dispatchId}) → session row exists → dispatches.phase='started',
     sessionId recorded. The session start re-reads tasks.state under its own transaction and refuses
     to insert a session for a task no longer in ROUTING (cancel raced ahead).
  9. First event ack (Harness path): markConsumed(envelope) co-committed as deferral #7 specifies.
```

**Timer wake and operator run-now use exactly this operation.** Run-now reads the current
generation, calls `wake(taskId, generation, "operator")`; a stale generation is a visible
no-op, never a second dispatch. `POST /api/tasks/:id/wait` **replaces** a condition by
inserting generation `n+1` and marking generation `n` `replaced` in one transaction; a timer
that later fires for `n` is stale.

**Cancellation.** `cancel(taskId)` in one transaction: `tasks → CANCELLED`, active condition →
`cancelled`, any dispatch in `reserved`/`start_attempted` → `cancelled`. A dispatch already
`started` gets the existing durable cancel intent (`requestCancel(sessionId)`), which the
runner's loop and heartbeat observe. A successor whose start is in flight observes the cancel
at step 8 (state re-read) or at its first heartbeat; the plane never has two owners.

**Recovery on boot** (`Scheduler.reconcileOnBoot`, part of **K1**, runs after
`HarnessRecovery.reconcileOnBoot`):

| Dispatch phase found | Meaning | Action |
|---|---|---|
| `reserved` | wake committed, routing/start never began | **not started**: continue at step 6 (route + start) — or, if the task was cancelled meanwhile, mark `cancelled` |
| `start_attempted`, no session row | provider may or may not have been called | **ambiguous**: do not start again. Harness path: `HarnessRecovery` ack-lookup-or-hold on the claimed envelope (`start_ambiguous`); if no session appears within the recovery window, mark `aborted`, re-park with `autoWakes+1` and reason `start_ambiguous`. Legacy path: hold in `ROUTING` with a notice; operator run-now re-arms |
| `start_attempted`, session row exists | start succeeded, phase update lost | mark `started`; normal session recovery owns it |
| `started` | ordinary running/terminal session | nothing (session recovery) |
| condition `active`, `notBefore` in the past, no dispatch | timer lost across restart | evaluate now (a wake, not a catch-up policy) |

**Exactly-once provider execution is not promised.** Providers offer no idempotent start;
the protocol guarantees **at most one live owner** and a **recoverable, labelled ambiguity**,
never silent double-start.

**K1 scope and the ownership-safety deferral.** K1 supports **newly created single-task
`time` waits** (`CREATED → WAITING_RESOURCE → ROUTING`, `checkpointId = null`, fresh start from
`TaskIntent`), run-now, cancel, replacement, and boot recovery of all dispatch phases.
Converting **existing parked work** (`LIMIT_PAUSED`/`WAITING_INPUT → WAITING_RESOURCE`, with a
checkpoint anchor and a predecessor session) is **K2**, because it requires the settled-
predecessor precondition and, on the Harness path, the deferral #7 claim machinery to be wired.

**Failover-vs-scheduler race.** `failoverTask` runs only from a settling session and must
observe, inside its transaction, that the task is still in the state it settled from
(`RUNNING`/`LIMIT_PAUSED`). If the task is already `WAITING_RESOURCE` (a scheduler dispatch
took ownership) or a dispatch is open, failover records a notice and does nothing
(`assertNoMixedOwnership` extended to dispatches). Conversely, the scheduler never evaluates a
condition for a task with a non-terminal session.

#### 4.2.4 Quota semantics — evidence, not timestamps

```ts
type BlockerKind =
  | "provider-reset"            // provider reported a reset time for a named bucket
  | "inferred-backoff"          // limit observed, no reset reported; we chose a retry
  | "transient-unavailable"     // 5xx / network / provider fault marked retryable
  | "unknown-recovery"          // blocked, no evidence when it clears
  | "intervention-required";    // auth/config/credential problem; retry cannot help

interface QuotaBlocker {
  kind: BlockerKind;
  assistantId: AssistantId;
  /** Account and bucket the observation is about; unknown allowed. */
  scope: { account?: string; bucket?: string /* five_hour | seven_day | primary | secondary | … */ };
  source: EvidenceSource | "provider-api";        // runtime-probe (run stream) · provider-api (idle probe) · manual (fallback)
  observedAt: string;
  /** Retry instant the scheduler will use. */
  retryAt: string;
  resetProvenance: "provider-reported" | "inferred" | "fallback";
  reason: string;
}

interface QuotaObservation {          // one row in quota_snapshots (extended)
  assistantId: AssistantId; scope: QuotaBlocker["scope"];
  usedPercent?: number; resetsAt?: string;
  source: QuotaBlocker["source"]; observedAt: string;
}
```

- **`CooldownStore.until` is a retry timestamp**, not proof of recovery. It becomes
  `QuotaBlocker.retryAt` with `resetProvenance` recorded; the row keeps `kind` and `source`.
- **Harness path fix (K2):** `QuotaGuard` puts the `limit.hit` payload's quota list (with
  `resetsAt`) into `yield.detail`; the `yielded/limit` settlement passes the first
  provider-reported reset to `failoverTask` exactly as the legacy path does. Today the Harness
  path drops it (`orchestrator.ts:726-731`).
- **Effective quota projection (one reader for scheduler and router):**
  `QuotaProjection.for(assistantId)` merges, per `(account, bucket)`, the manifest `core.limits`,
  `quota_snapshots`, active cooldown/blocker rows and probe observations, choosing **the freshest
  observation by `observedAt`**; source priority breaks ties only among observations of the same
  age class. A fresh `provider-api` probe supersedes a stale `runtime-probe` snapshot; a stale
  probe never supersedes a fresh run-stream observation. The router's `latestQuota()` reads the
  projection instead of the manifest.
- **Controlling reset with multiple exhausted windows:** for each candidate that passes every
  *other* filter, the controlling retry is the **latest** `retryAt` among that candidate's
  blocked buckets (all must clear). The task's `notBefore` is the **earliest** controlling retry
  across such candidates. A cooldown on a candidate that fails another hard filter is ignored.
- **Retry on re-park:** provider-reported reset if fresh; else bounded inferred backoff
  (10 min → 30 min → 60 min, capped) recorded as `inferred-backoff`; `transient-unavailable`
  uses the short ladder; `intervention-required` never re-parks (→ `WAITING_INPUT`).
- **Probe attempts vs wake attempts:** probes (`K3`) are rate-limited (one per assistant per
  15 min) and recorded in `history` with `outcome: probe`; they never increment `autoWakes`.
- **Truthful guarantee (replaces "wake never starts into an exhausted window"):** at wake, the
  scheduler **revalidates** the projection (running a probe first when one is enabled and due).
  If the projection says exhausted, it re-parks without starting. If the projection is unknown
  or stale, **one bounded attempt** may start; a `limit.hit` on that attempt re-parks with an
  `inferred-backoff` blocker and `autoWakes + 1`. A wake may therefore start into an exhausted
  window at most once per wake budget, and never twice without new evidence.

#### 4.2.5 Routing and start — one entry point, explicit continuation

```ts
routeTask(taskId, origin: "intake" | "wake" | "failover" | "context-yield",
          opts?: { exclude?: AssistantId; preferSame?: { assistantId; model? } })
  → RoutingExplanation   // always: intent overrides as filters, cooldowns, QuotaProjection, telemetry scores

startTask(taskId, {
  continuation: { kind: "fresh" } | { kind: "checkpoint"; checkpointId: string },
  trigger: "intake" | "handoff" | "wake" | "context" | "run-now",
  dispatchId?: string,
})
```

Prompt rendering follows `continuation` only (CR-31): `fresh` renders from `TaskIntent`;
`checkpoint` renders the handoff prompt from that checkpoint's committed envelope. `trigger`
is written to `handoffs.trigger` (CHECK extended with `wake`, `context`) for audit.
`Orchestrator.routeFor()` is replaced by `routeTask` so failover/handoff routing gains the
telemetry that intake already supplies (CR-30).

#### 4.2.6 Recurring schedules (K5, demand-driven) — atomic firing, unique occurrences

```ts
interface Schedule {
  schemaVersion: 1; scheduleId: string; kind: "user" | "system";
  intent: TaskIntent;              // I-S1: intent only
  cron: string;                    // 5-field
  timezone: string;                // IANA
  enabled: boolean;
  overlap: "skip";                 // "queue" deferred
  catchUpWindowMinutes: number;    // default 1440
  lastFiredAt?: string; nextFireAt?: string;  // persisted; recomputed on boot, edit and fire
  createdAt: string; updatedAt: string;
}
/** One row per scheduled occurrence; UNIQUE(schedule_id, occurrence_at). */
interface ScheduleOccurrence {
  scheduleId: string; occurrenceAt: string;   // the cron instant in UTC — the dedup key
  firedAt: string; outcome: "created" | "skipped-overlap" | "skipped-catch-up" | "skipped-disabled";
  taskId?: TaskId;
}
```

- **Firing is one transaction:** insert the occurrence (unique on `(scheduleId,
  occurrenceAt)` — a duplicate tick is a constraint violation, not a second task), create the
  task in `CREATED → WAITING_RESOURCE`/`ROUTING`, advance `nextFireAt`, set `lastFiredAt`.
  `lastTaskId` is a display field, **not** the deduplication mechanism.
- **Timezone/DST:** next-fire is computed in the schedule's IANA zone by the cron library
  (`croner` or `cron-parser` — the one new dependency of M13). A local time that does not
  exist (spring-forward) is skipped; an ambiguous local time (fall-back) fires once, at the
  first instant.
- **Edits:** `PATCH` recomputes `nextFireAt` from now; occurrences already fired are untouched;
  changing `enabled` to false leaves in-flight tasks alone.
- **Catch-up:** on boot, at most **one** missed occurrence per schedule is fired, and only if
  it is within `catchUpWindowMinutes`; older misses are recorded `skipped-catch-up`.
- **Overlap:** `skip` only — while the previous occurrence's task is non-terminal, the
  occurrence is recorded `skipped-overlap`. Queue mode is deferred.
- **Disabled scheduler** (`scheduler.enabled: false`): the timer is not armed, schedules do not
  fire (`skipped-disabled` recorded on the next enable, at most one), conditions are not
  evaluated; `WAITING_RESOURCE` tasks remain, the UI shows a "scheduler disabled" banner, and
  operator run-now still works (it is the same `wake` operation).

#### 4.2.7 Dependency waits (K4) and deferred resource slots (K4b)

- `dependency` waits ship in K4 with **self-dependency and cycle rejection at attach time**
  (walk `dependsOn` across non-terminal tasks' active conditions). A dependency that does not
  exist or is deleted is treated as `FAILED` for `onDependencyFailure`. Wake is event-driven
  (task terminal) with the same `wake(generation)` operation.
- **Resource slots (`kind: "resource"`, `maxConcurrent`) are deferred (K4b)** until every
  launch path — legacy `orchestrator.ts`, Harness `SessionRunner`, parallel compare — shares
  one reservation/release protocol. Until then a slot count cannot be honest.

#### 4.2.8 Scheduler service, ownership, persistence, API

```text
Scheduler (Control Plane, single process, no queue)
  ├─ armTimer():   one setTimeout for min(notBefore over active conditions, nextFireAt over enabled schedules)
  │                unref'd, always re-armed, failures contained (jobs.ts pattern)
  ├─ onTick():     wake(due conditions by generation); fire due schedules (K5)
  ├─ onEvent():    task terminal → dependency conditions (K4); quota projection changed → quota conditions (K2)
  ├─ reconcileOnBoot(): dispatch phases (§4.2.3), overdue conditions, schedule catch-up (K5)
  └─ status():     armed timer, due conditions, open dispatches, last tick, probe freshness
```

**Ownership.** Plane: `wait_conditions`, `dispatches`, `schedules`, `schedule_occurrences`,
next-fire, wake, routing at wake, recovery. Cockpit: renders; creates via `commands.write`;
never computes next-fire.

**Persistence.** Migration `014_scheduler.sql` (placeholder number; assign at merge,
forward-only): `wait_conditions` (partial unique index on `task_id WHERE state='active'`),
`dispatches` (partial unique index on `task_id WHERE phase IN ('reserved','start_attempted')`),
`tasks.pause_kind TEXT NULL`, `tasks.intent_json` (persisted `TaskIntent`, backfilled from
`goal`/`constraints`/`repo_path`/`profile`/`user_override`), `handoffs.trigger` CHECK extended,
`quota_snapshots` gains `account`, `bucket`, `blocker_kind`, `reset_provenance`. K5 adds
`schedules`, `schedule_occurrences`.

**API (additive, 2.1).**

```text
POST   /api/tasks                       body gains `wait?: WaitConditionInput` (K1: kind=time)   → WAITING_RESOURCE
POST   /api/tasks/:id/wait              attach/replace a condition (new generation)              commands.write
POST   /api/tasks/:id/run-now           wake(currentGeneration, "operator"); stale → 409 with reason  commands.write
GET    /api/tasks/:id/wait              active condition + history + open dispatch                tasks.read
GET    /api/scheduler/status            armed timer, due conditions, open dispatches, probe freshness  schedules.read
GET    /api/schedules · POST · PATCH /:id · DELETE /:id        (K5)                                schedules.read / commands.write
SSE    task.state (existing) carries WAITING_RESOURCE + the condition summary
```

### 4.3 M14 — Context Lifecycle Manager: observation first

#### 4.3.1 Observation model

```ts
interface ContextObservation {
  sessionId: ExecutionSessionId;
  observedAt: string;
  sequence: number;                                   // monotonic per session
  /** Live occupancy of the active context. Unknown is a first-class value. */
  occupancyTokens?: number;
  occupancySource: "provider-reported" | "estimated" | "unavailable";
  estimator?: { name: string; version: string };      // present when estimated
  /** The window the provider actually manages against (e.g. Claude's resolved autocompaction window). */
  effectiveWindowTokens?: number;
  effectiveWindowSource?: "provider-reported" | "catalog" | "unavailable";
  /** The model's advertised maximum (ModelUsage.contextWindow / catalog). Not the same thing. */
  advertisedMaxTokens?: number;
  /** occupancy / effectiveWindow; undefined unless both are known and fresh. May exceed 1. */
  pressure?: number;
  freshness: "live" | "stale" | "unavailable";
  breakdown?: Array<{ category: string; tokens: number }>;
}
```

Token/cost **accounting** (`usage` on results, `ModelUsage.costUSD`, Codex per-turn usage) is a
separate stream and never feeds `occupancyTokens`. A `usage.updated` event that carries only
quota information produces **no** observation. Nothing manufactures `usedTokens` or `pressure`
from every `usage.updated`.

**Expected sources at implementation time (to be verified, not asserted):**

| Adapter | occupancy | effective window | advertised max | compaction control | auto-management |
|---|---|---|---|---|---|
| Claude (Agent SDK 0.3.238) | `provider-reported` via `get_context_usage` → `SDKContextUsage` (an **estimate** against the resolved autocompaction window); requires the adapter to forward structured context info it currently drops | `provider-reported` (`raw_max_tokens`); may differ from `ModelUsage.contextWindow` | `ModelUsage.contextWindow` | `provider-command`: `/compact` as a prompt on the existing conversation; `compact_boundary` reported — requires a session control the adapter does not expose today | provider autocompaction (observed via `compact_boundary`) |
| Codex (SDK 0.149.0) | **`unavailable`** — `turn.completed` accounting is not established as live occupancy | `unavailable` (catalog hint only) | catalog | **none in the installed SDK**; App Server `thread/compact/start` and `thread/tokenUsage/updated` exist beyond it — requires an app-server transport, unscheduled | provider-managed; with experimental context management enabled (opt-in, account-dependent) the harness keeps notes and searches earlier task history — described on the manifest as `autoManagement: "provider"`, detail text only |
| Cursor / Bedrock | `unavailable` | `unavailable` | catalog / unknown | none | none known |
| Fake | `provider-reported` (scripted) | `provider-reported` | scripted | `provider-command` (scripted) | scripted |

```ts
/** Adapter manifest, `harness.context`. Honest tiers, like isolation. */
interface ContextCapability {
  occupancy: "provider-reported" | "estimated" | "unavailable";
  effectiveWindow: "provider-reported" | "catalog" | "unavailable";
  compact: "provider-command" | "none";
  autoManagement: "provider" | "none";
  /** Free text for provider-specific mechanisms (e.g. Codex experimental context management, opt-in). */
  autoManagementDetail?: string;
  observesAutoCompaction: boolean;
}
```

**Adapter contract.** The six-method contract is not "unchanged while requiring measure/prune/
compact": measuring and compacting need controls today's adapters do not expose. The smallest
capability-gated extension is an **optional** `context?: { observe?(): Promise<ContextObservation>;
compact?(): Promise<void> }` on the session handle, implemented only by an adapter that has a
real mechanism (Claude first). No `prune` operation exists; pruning of provider transcripts is
not a plane capability.

**Gauge (O10, K9 + K12, first deliverable).** `GET /api/tasks/:id/context` and `context.observed`
SSE drive the `apps/web` Usage tab and Cockpit's managed session view. Rules: no percentage
without a known **effective window** (render "occupancy N tokens (estimated), window unknown" or
"occupancy unavailable"); method chip and freshness always visible; provider auto-compaction
shown as "observed", never as our action; the legacy path shows "context observation
unavailable (legacy execution path)".

#### 4.3.2 Policy and guard (K10/K11) — gated on observations

```ts
interface ContextPolicy {
  warnRatio: 0.70;            // eager checkpoint once; gauge turns amber
  actRatio: 0.85;             // ask the provider to compact (if compact = provider-command)
  criticalRatio: 0.92;        // checkpoint + yield(context) when no compaction control or compaction did not relieve
  maxCompactionsPerSession: 3;
  minTurnsBetweenActions: 2;  // hysteresis; never act twice on one turn
  /** Task-level bounds — session counters reset per session and cannot stop a loop. */
  maxContinuationsPerTask: 3;
  noProgressContinuationLimit: 2;  // consecutive continuations without envelope progress → WAITING_INPUT
  onUnknown: "warn-only";     // unknown/stale observations never authorize automatic destructive continuation
}
```

Rules (replace revision 1's fixed prune→compact ladder):

- **No action without a fresh observation before and after** (I-C2). An unavailable or stale
  observation permits `warn`, an eager checkpoint and a gauge state — nothing destructive.
- **Provider auto-management is primary** where declared (CR-34). The guard requests a
  compaction only when `compact = provider-command` **and** pressure ≥ `actRatio` **and** no
  provider auto-compaction has been observed since the last action.
- **Success is relief, not a percentage:** an action that brings pressure below `actRatio`
  ends escalation, even if it freed less than any fixed fraction. An action that leaves
  pressure ≥ `criticalRatio` is **not** success and escalates. No `verifyMinReduction`.
- **Compaction is not replay-idempotent.** A `compact` directive is durable with `requestedAt`;
  a crash after the provider applied it but before the observation was persisted leaves the
  outcome **ambiguous**. On recovery the directive is marked `outcome: unknown`, is **never
  re-issued blindly**, and the next step is an observation. Sequence numbers on normalized
  events do not make provider-side actions idempotent.
- **The event pump keeps running** while the guard waits for an action's outcome; waiting is
  by observing the stream (`compact_boundary` / a new observation), never by blocking it.
- **Directive vocabulary:** existing plus `observe`, `compact`; no `prune`.

**Events (typed, append-only):** `context.observed`, `context.warn`, `context.compaction.requested`,
`context.compaction.observed` (also for provider auto-compaction we did not request),
`context.compaction.relieved`, `context.compaction.unrelieved`, `context.compaction.unknown`,
`context.yield`. **Invariant (I-C1): compaction never mutates or deletes any persisted event,
checkpoint, envelope or result.** The provider's transcript is not our record; ours is
append-only and a `compact_boundary` is one more event in it. The guard **never** issues
`/clear` (I-C3).

#### 4.3.3 Clean-session continuation (K11, with the minimum K10 safety) — bounded, anchored, not lossless

`yield(context)` → `YIELDED` with `yield.kind = "context"` → the plane may start a successor
**only when all of the following hold**, each recorded on the dispatch:

1. **Explicit checkpoint anchor:** a checkpoint id taken at or after the yield.
2. **Adequate continuation evidence:** the checkpoint has a committed Git ref **and** an
   envelope with `nextAction`; an **envelope-only checkpoint after a Git failure is inadequate**
   and parks the task in `WAITING_INPUT` (`pause_kind: continuation_evidence_missing`).
3. **Settled predecessor:** the yielding session is terminal with its result persisted.
4. **Preserved constraints:** `TaskIntent` (including overrides) is re-applied; the successor's
   routing prefers the same assistant/model (`preferSame`) with no cooldown penalty, and may
   legitimately differ when the same one is ineligible.
5. **Composition provenance:** the successor's routing decision references the predecessor
   session, the checkpoint id and the continuation number.
6. **Task-level bounds:** `maxContinuationsPerTask` and `noProgressContinuationLimit` (progress
   = a change in `completed`/`remaining` between the two checkpoints) — exceeding either parks
   the task in `WAITING_INPUT`.

The successor receives a **bounded handoff input** (the rendered handoff prompt, size-capped as
today). There is **no guarantee** that the successor starts below `warnRatio`; if its first
fresh observation is already ≥ `criticalRatio`, it yields with reason
`successor_immediately_critical` and the task parks in `WAITING_INPUT` — no further automatic
continuation. Clean continuation is **not lossless**: the bounded summary is not a provider
memory export, and provider-side notes/search history (Codex Astra) are **not assumed to
survive** a fresh thread or to cross providers.

**Ownership.** Control Plane: policy, continuation decision, routing of the successor. Harness:
observer, guard, directives, events. Adapter: mechanism (`get_context_usage`, `/compact`,
`compact_boundary`, App Server controls when they exist). Cockpit / web: render.

### 4.4 M12 — Model Intelligence Service: identity before catalog completeness

#### 4.4.1 Execution identity (K7)

```ts
interface ExecutionIdentity {
  /** What the Control Plane asked for — an alias or id as the user/router named it. */
  requestedModelSelector?: string;
  /** What the provider reported it served. "unknown" is allowed and common. */
  resolvedModelId?: string;          // Claude: run.started msg.model; Codex: not reported today
  resolvedSource?: "run.started" | "result" | "unknown";
  servingProvider: string;           // "anthropic" | "openai" | "bedrock" | "openrouter" | …
  harness: { id: AssistantId; version?: string };
  executionSettings?: Record<string, string | number | boolean>;   // reasoning effort, sandbox mode, …
  catalogRevision?: string; pricingRevision?: string;               // the revisions in force when the run started
}
```

- **One authority (CR-33):** `ExecutionRequest.model` is the requested selector; the Harness
  bridge (`buildExecutionRequest` → `SessionRunner` → adapter `RunSpec`) copies it into
  `RunSpec.model` as a validated projection and records `requestedModelSelector`. **The bridge
  plumbing that does this is part of K7.**
- **No alias resolution against today's catalog.** `runs.model_requested` and
  `runs.model_resolved` are separate columns; the backfill writes only what persisted
  `run.started` payloads prove — Claude rows get `model_resolved`; Codex rows stay `unknown`
  because Codex `run.started` (`thread.started`) carries no model.
- **Provider discovery owns assistant availability** (`capability-probe.ts`, `registry.ts`).
  M12 joins and version-controls evidence about models; Cockpit presents and configures without
  a competing catalog.

#### 4.4.2 Catalog and evidence

```ts
type EvidenceTier = "measured-own" | "provider-official" | "external-benchmark" | "manual";

interface Provenance {
  source: EvidenceSource | "external:artificial-analysis" | "external:livebench" | "external:benchlm";
  tier: EvidenceTier;
  observedAt: string;              // when WE observed/fetched it
  /** External only: the benchmark's own release/config identity and publication date. */
  benchmark?: { release: string; configuration?: string; publishedAt?: string; category: string };
  normalizationVersion: string;    // how raw → 0..1 was computed; bump = re-normalize, never mix
  freshness: "live" | "fresh" | "stale" | "expired";   // computed at read time from per-source TTL
  sampleSize?: number;             // own telemetry only
  attribution?: string;
}

interface ModelCatalogEntry {
  schemaVersion: 1;
  modelId: string; provider: string; displayName: string; aliases: string[];
  contextWindowTokens?: number & Provenanced;
  maxOutputTokens?: number & Provenanced;
  /** Price EVIDENCE / estimate, versioned. Not by itself an enforcement tariff (§4.4.5). */
  pricing?: { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number;
              cacheWritePerMtok?: number; currency: "USD"; pricingVersion: string;
              appliesTo?: { servingProvider: string; accountKind?: string } } & Provenanced;
  capabilities?: { toolUse?: boolean; reasoningEffort?: string[]; vision?: boolean } & Provenanced;
  availableVia: AssistantId[];     // joined from provider discovery, never decided here
  status: "active" | "deprecated" | "unknown";
}
```

**Refresh.** The daily job refreshes provider-official data (Claude `supportedModels()`,
`ModelUsage` seen in runs) and, in K8, **one** external source (Artificial Analysis is the
candidate: documented REST, stable ids, attribution stored on every row; `x-api-key` from
`AA_API_KEY` env, never config). LiveBench and BenchLM stay pinned manual snapshots until their
reuse terms are established (§2.6). TTLs: official 7 d, external 30 d; expired evidence is
shown with `freshness: expired` and excluded from selection. An unreachable source changes
nothing (local-first: routing never blocks on the network). No task data, prompt, repository
name or usage leaves the machine in these requests (I-M3).

#### 4.4.3 Conservative selection (K13) — shadow first

**Hard filters come first and nothing external can pass them:** authentication, capabilities,
workspace policy, quota projection, security policy, hard compatibility (a model the assistant
cannot run). External benchmark evidence **never grants eligibility** and never bypasses a
filter. Unknown capacity is **advisory** only when capacity is not a hard requirement of the
task; when it is (a declared minimum window), unknown excludes with a named reason.

**Initial dimensions (three):** `coding`, `speed`, `cost`. Each has both a prior and a
telemetry metric:

| Dimension | Own telemetry metric (per resolved model, cohort-filtered) | Prior |
|---|---|---|
| coding | success × test-pass × verification-pass rate on `coding` tasks | AA coding index |
| speed | median run duration; median output tokens/s where reported | AA `median_output_tokens_per_second` |
| cost | median cost per completed task (price evidence × usage) | provider price per Mtok |

Other dimensions of revision 1 (architecture, frontend, review, reasoning, long-context,
tool-use, token-efficiency, quota-preservation) are added only when both a prior and a metric
exist; `quota-preservation` is live state (the projection), not evidence.

**Blending rule (deterministic, table-tested).** For each candidate and dimension `d`:
`score_d = w(n_d) · telemetry_d + (1 − w(n_d)) · prior_d`, with `w(n) = n / (n + k_d)`;
`k_d` defaults to 5 (speed, cost) or 10 (coding).

Definitions the rule needs:
- **Missing prior:** `prior_d` absent → the dimension contributes `telemetry_d · w(n_d)` only
  and the candidate is flagged `priorMissing:d`; with `n_d = 0` the dimension contributes
  nothing and cannot decide.
- **Source ties:** two external sources for one dimension → the pinned primary source wins;
  ties within a source by `benchmark.publishedAt` then `observedAt`, deterministically.
- **Versioned normalization:** values from different `normalizationVersion`s are never mixed;
  a bump re-normalizes the whole source.
- **Evidence age:** `benchmark.publishedAt` (age of the evidence) and `observedAt` (when we
  fetched it) are both stored and both shown; TTL applies to `observedAt`, staleness display to
  `publishedAt`.
- **Telemetry cohort:** `n_d` counts runs with the same resolved model, the same task kind, the
  same harness major version, inside the 30-day window; runs with `model_resolved = unknown`
  never join a model's cohort.
- **Healthy context yields** (`yield.kind = "context"` with a successful continuation) are not
  provider errors and are excluded from failure/reliability aggregates; **one predicate**
  (`isReliabilityFailure(result)`) is used by the outcome, test-pass and handoff aggregates so
  task/model filtering cannot drift between them (I-M4).

**What the rule does and does not guarantee (corrects revision 1).** `w(n)` is **monotone in
`n`**; with a rolling window `n` can fall, so it is **not** monotone over time. Greater telemetry
weight does not by itself reverse a ranking: at `n > k` telemetry weighs more than the prior,
but a candidate with worse own telemetry still wins if the prior gap outweighs the telemetry
gap. The acceptance test therefore asserts the formula on a table **and** one constructed case
where a sufficient telemetry gap reverses a prior-best ranking — not "worse telemetry always
loses once `n > k`".

**Shadow mode, then gated activation.** K13 first ships `selectModel` in **shadow**: the
recommendation is computed and persisted inside `routing_decisions.explanation` as
`modelRecommendation` with every number sourced, **without** setting `RunSpec.model`.
Activation (`models.selection.enabled: true`) requires: per-model telemetry with resolved
identity on ≥ `k` runs for at least one candidate pair, the shadow log reviewed for one week
with no filter violations, and the egress test green. `userOverride` may name a model
(`assistantId/modelId`) at any time — it is intent, applied as a filter.

#### 4.4.4 API (additive, 2.1)

```text
GET  /api/models                         catalog + evidence + freshness                       models.read
GET  /api/models/:id                     one entry with every evidence row and attribution     models.read
POST /api/models/refresh                 run the refresh now                                  commands.write
GET  /api/tasks/:id/routing              existing; explanation carries modelRecommendation (shadow or applied)
```

Cockpit renders the catalog with its honesty chips (`tier` × `freshness`, `publishedAt` vs
`observedAt`) and the recommendation under the managed task's Routing view, labelled
**shadow** until activated. It never scores.

#### 4.4.5 Pricing and cost-cap ownership

**K7 supplies versioned price evidence and estimates. It does not by itself close standing
deferral #3.** `BudgetPolicy.maxCostUsd` with `enforcement: "bounded"` stays rejected
(`policy_unenforceable`) until **all** of:

1. an **applicable tariff**: a priced catalog row whose `appliesTo` matches the run's serving
   provider and account kind (subscription runs may have no per-token tariff at all);
2. the **resolved** execution identity is known (not `unknown`);
3. the adapter's `usageReporting` contract is proven by real-adapter conformance (deferral #4);
4. **reporting latency and overshoot bounds** are declared (how far a run can exceed the cap
   between usage reports), so "bounded" has a number;
5. **relevant call costs** beyond the main model (verification providers, tool calls billed
   separately) are either priced or declared out of scope for the cap.

**Benchmark prices (Artificial Analysis, BenchLM) and Cockpit's family-match fallback are
never used to authorize a hard cap.** They may price *estimates* and dashboards, labelled.

### 4.5 M15 — Runtime Backend seam: deferred

**Decision (revision 2):** name the seam, defer the enum and the abstraction.

- The implementation seam is `SessionRunner.startProvider` in `session-runner.ts`.
  `ProviderSessionDriver` is a **conceptual name** used in design documents, not a type in the
  tree.
- The typed `harness.runtime` enum, `ExecutionResult.enforcement.runtime`, and any
  `RuntimeBackend` interface are **deferred** (K15 deferred). A speculative enum with one
  value is the abstraction-with-one-implementation the standing rules forbid.
- A global "no provider launches outside `harness/`" test is **not** required before increment
  6 retires the legacy `orchestrator.ts` launch path; requiring it earlier would fail on code
  that is still the sole implementation of a live mode.
- Herdr remains optional and unscheduled; no K1–K14 requirement justifies it. `DshAdapter`
  likewise.

---

## 5. Acceptance criteria and tests

Each mandatory item lists what must be true and the test that proves it. Tests follow the
existing layout (`apps/api/test/**`, `packages/core/test/**`, `eval/scenarios/*`).

### 5.1 M13 Scheduler

**K1 — durable dispatch, single-task time waits, boot recovery, minimal waiting UI.**

1. `POST /api/tasks` with `wait.kind = "time"` creates the task in `WAITING_RESOURCE` with an
   `active` condition, generation 1; at `notBefore` the timer calls `wake(taskId, 1, "timer")`,
   which in one transaction consumes the condition, inserts a `reserved` dispatch and moves the
   task to `ROUTING`; routing happens **at wake** with telemetry supplied (a cooldown added
   between creation and wake changes the chosen assistant; a telemetry change between creation
   and wake is visible in the explanation).
2. **Duplicate wakeups:** two concurrent `wake` calls with the same generation produce exactly
   one dispatch; the second returns `stale`. Property: `dispatches` has at most one open row per
   task (partial unique index test).
3. **Condition replacement:** `POST /wait` creates generation 2 and marks generation 1
   `replaced`; a timer firing for generation 1 is `stale` and creates nothing.
4. **Wake vs cancel:** cancel committed before `wake` → `wake` is `stale`; cancel committed
   between `wake` commit and session insert → step 8 refuses the session insert, the dispatch
   is marked `cancelled`, no provider is called; cancel after `started` → durable cancel intent
   observed by the runner (existing test extended).
5. **Crash between persistence and start steps** (fault-injection, existing harness):
   - after `wake` commit, before routing → boot recovery finds `reserved`, routes and starts once;
   - after `start_attempted`, before the session row → boot recovery holds as ambiguous, never
     starts a second session; with no session appearing in the recovery window, re-parks with
     `autoWakes = 1` and reason `start_ambiguous`;
   - after the session row, before `phase = started` → boot recovery marks `started`, session
     recovery owns it. In every case exactly zero or one provider start occurred (`FakeAdapter`
     start counter).
6. **Failover vs scheduler race:** a session settling for a task the scheduler has already
   taken into `WAITING_RESOURCE` (constructed by holding the settle callback) records a notice
   and performs no transition; `assertNoMixedOwnership` covers dispatches.
7. `run-now` calls the same `wake` operation (spy test) and re-routes; a stale generation
   returns 409 with the reason.
8. Invariant I-S1: no `wait_conditions` or `schedules` row contains a resolved assistant,
   model or composition id (schema test); `TaskIntent` overrides are present and re-applied as
   filters at wake (a pinned assistant still in cooldown at wake → re-park, not a different
   assistant).
9. CR-32: `WAITING_INPUT → WAITING_RESOURCE` is rejected for `pause_kind ∈ {approval_pending,
   verification_failed, comparison_pending, handoff_requested}` (transition matrix test).
10. Scheduler failure containment: a throwing wake never stops the timer; the next tick is
    re-armed (jobs.ts parity test). Overdue conditions are evaluated on boot.
11. `scheduler.enabled: false`: timer unarmed, `WAITING_RESOURCE` tasks preserved and shown
    with a banner, `run-now` still works.
12. Minimal waiting-state UI: `apps/web` board shows `WAITING_RESOURCE` tasks with the
    condition summary and next check; Cockpit (K6 read half) may follow later.

**K2 — quota retry with explicit evidence semantics; converting parked work.**

13. All-blocked failover on **both** paths: with every candidate blocked, the task checkpoints
    and enters `WAITING_RESOURCE` (not `WAITING_INPUT`) with `blockers` carrying `kind`,
    `source`, `observedAt`, scope and `resetProvenance`; the Harness path passes the
    provider-reported `resetsAt` (today it is dropped — regression test on
    `yielded/limit` settlement).
14. Controlling reset: two candidates, one with two exhausted buckets (resets at T+10 and
    T+40) and one with a single bucket (T+25) → `notBefore = T+25`; a cooldown on a candidate
    that fails another hard filter is ignored.
15. Projection: a fresh `provider-api` observation supersedes a stale `runtime-probe` snapshot
    and vice versa by `observedAt`, not by source rank alone; the router's `latestQuota` reads
    the projection (manifest-only reads removed).
16. Truthful revalidation: at wake with an exhausted projection → re-park without a provider
    start; with an unknown/stale projection → one start; a `limit.hit` on it re-parks with an
    `inferred-backoff` blocker and `autoWakes = 1`; after `maxAutoWakes` → `WAITING_INPUT` with
    history; `intervention-required` → `WAITING_INPUT` immediately.
17. Converting parked work requires a settled predecessor: a `LIMIT_PAUSED` task whose session
    result is not yet persisted cannot enter `WAITING_RESOURCE` (precondition test); on the
    Harness path the successor is claimed through `handoff.claim` in the `wake` transaction
    (deferral #7 wiring, its acceptance criteria apply).
18. `eval/scenarios/quota-wait-and-resume.ts`: two `FakeAdapter`s with `[FAKE:LIMIT]`,
    provider-reported `resetsAt` in 2 s, asserts resume on whichever assistant is eligible at
    wake and that the successor's routing decision references the checkpoint anchor.

**K3 — optional probes.** Probe results are `provider-api` observations scoped to account and
bucket; tokens are read in memory from the provider's own credential files, never persisted,
logged or echoed (redaction test); probe attempts appear in `history` and never increment
`autoWakes`; Codex `reportsLimits` stays `false` with a working probe (manifest test); a probe
whose endpoint is unavailable changes nothing.

**K4 — dependency waits.** A task waiting on two tasks wakes only when both are terminal;
`FAILED` applies `onDependencyFailure`; self-dependency and a 3-task cycle are rejected at
attach with a named error; a dependency deleted after attach is treated as `FAILED`.

**K5 — recurring schedules.** One task per occurrence; a duplicate tick for the same
`occurrenceAt` violates the unique constraint and creates nothing; `overlap: skip` records
`skipped-overlap`; after restart at most one missed occurrence within the catch-up window
fires; DST spring-forward skips the nonexistent local time and fall-back fires once; editing
cron recomputes `nextFireAt`; disabled scheduler records `skipped-disabled` once on re-enable.

**K6 — Cockpit.** Renders plane schedules and `WAITING_RESOURCE` tasks from reads alone;
creating a schedule without `commands.write` fails closed.

Tests: `packages/core/test/state-machine.test.ts` (every new edge legal with its precondition,
every non-listed edge illegal, CR-32 rejections); `apps/api/test/scheduler.test.ts` (fake
clock, generation CAS, dispatch phases); `apps/api/test/harness/boot-recovery` dispatch cases;
`apps/api/test/failover.test.ts` all-blocked case on both paths; `quota-projection.test.ts`;
`eval/scenarios/quota-wait-and-resume.ts`; Cockpit `schedule` unit tests (K6).

### 5.2 M14 Context Lifecycle

**K9 + K12 — observation and gauges (no intervention).**

1. A Harness session produces a `ContextObservation` only when a source exists: Claude via the
   forwarded `SDKContextUsage` (`occupancySource: provider-reported`, effective window from
   `raw_max_tokens`, advertised max from `ModelUsage.contextWindow`, and the two may differ —
   asserted); Codex produces `occupancySource: unavailable` (no estimator from `turn.completed`
   accounting); a `usage.updated` carrying only quota produces no observation.
2. Gauge: `apps/web` and Cockpit show occupancy, effective window, method chip and freshness;
   unknown renders as unknown; no percentage without a known effective window; provider
   auto-compaction (`compact_boundary`) is recorded `context.compaction.observed` and shown as
   "observed".
3. The Claude adapter forwards `compact_boundary` system messages and structured context info
   instead of dropping them (adapter test with a scripted stream).
4. Real-provider evidence (credential-gated eval): a Claude session driven past `warnRatio`
   produces a provider-reported observation and, when the provider auto-compacts, an observed
   `compact_boundary`; a Codex session renders "occupancy unavailable" and no invented number.

**K11 (+ minimum K10 safety) — bounded checkpoint-backed continuation.**

5. With `compact = none` and a fresh observation ≥ `criticalRatio`, the session checkpoints and
   yields `context`; the successor starts from that checkpoint id on the same assistant and
   model when eligible, without a cooldown penalty; the successor's routing decision references
   the predecessor session, the checkpoint and the continuation number.
6. An envelope-only checkpoint (Git failure injected) does **not** start a successor; the task
   parks in `WAITING_INPUT` with `continuation_evidence_missing`.
7. Task-level bounds: the fourth continuation of one task, or the third consecutive
   continuation without envelope progress, parks the task in `WAITING_INPUT` — asserted across a
   process restart (session counters alone would reset).
8. A successor whose first fresh observation is already ≥ `criticalRatio` yields
   `successor_immediately_critical` and no further automatic continuation occurs.
9. Unknown or stale observations never trigger a yield or compaction (`onUnknown: warn-only`).
10. Healthy context yields do not appear in provider-error or reliability aggregates (shared
    `isReliabilityFailure` predicate test, I-M4).

**K10 — provider-command compaction (after conformance).**

11. With `compact = provider-command` and pressure ≥ `actRatio`, the guard requests compaction
    while the event pump keeps running, then observes; relief below `actRatio` ends escalation
    regardless of the fraction freed; pressure still ≥ `criticalRatio` escalates to K11.
12. Crash after the provider applied compaction and before the observation was persisted →
    recovery marks the directive `outcome: unknown`, does not re-issue it, and the next action
    is an observation (fault-injection test).
13. `maxCompactionsPerSession` and `minTurnsBetweenActions` enforced; the guard never issues a
    clear (I-C3); I-C1 row-count + digest test.

Tests: `apps/api/test/harness/context-observer.test.ts`, `context-guard.test.ts` (pure,
table-driven), `session-runner` integration with `FakeAdapter` gaining `[FAKE:CONTEXT:<pressure>]`
and a scripted `compact_boundary`, fault-injection replay case, `eval/scenarios/context-pressure.ts`,
web/Cockpit rendering tests for the gauge states including unknown.

### 5.3 M12 Model Intelligence

**K7 — execution identity, provider facts, price evidence.**

1. Every run records `requestedModelSelector` and, separately, `resolvedModelId` or `unknown`;
   Claude rows resolve from `run.started`; Codex rows are `unknown` and the backfill never
   guesses (migration test); the bridge copies `ExecutionRequest.model` into `RunSpec.model`
   (plumbing test) and nothing else writes `RunSpec.model`.
2. `GET /api/models` lists every model any configured assistant can run (joined from provider
   discovery, never decided by M12), each field with provenance, tier, `observedAt`, freshness
   and (external) attribution; nothing lacks a `source`.
3. Pricing rows carry `pricingVersion` and `appliesTo`; **`BudgetPolicy.maxCostUsd` with
   `enforcement: bounded` remains rejected** until §4.4.5's five gates hold (negative test); a
   benchmark price or family-match price never satisfies gate 1 (test).
4. Offline: with every external source unreachable, refresh records the failure, routing
   proceeds on existing rows, freshness degrades on schedule; no request ever contains task,
   prompt, repository or usage data (egress test with a recording fetch).

**K8 — one verified benchmark source.** Artificial Analysis rows carry the required
attribution and the UI shows it; `benchmark.release`, `publishedAt` and `normalizationVersion`
are stored; a second source is not fetched until the first is demonstrated useful in the
shadow log.

**K13 — shadow selection, then gated activation.**

5. In shadow mode every routing decision carries `modelRecommendation` with candidates, filter
   failures, prior, telemetry, sample size, weight and evidence rows, and `RunSpec.model` is
   **not** changed by it.
6. Hard filters: a candidate failing auth, capability, workspace policy, quota projection,
   security or hard compatibility is excluded with a named failure regardless of any benchmark
   score (table test); unknown capacity is annotated, and excludes only when the task declares
   a minimum window.
7. Blending: table test over synthetic telemetry asserts `w(0) = 0`, `w(k) = 0.5`, `w(4k) = 0.8`
   and the score formula; one constructed case where a sufficient telemetry gap reverses a
   prior-best ranking at `n > k`; one where it does not (documenting that weight alone does not
   guarantee reversal); a rolling-window case where `n` falls and `w` falls with it.
8. Missing prior, source tie and normalization-version cases behave as §4.4.3 defines;
   `unknown`-model runs never join a cohort.
9. Activation requires the stated gate (config + telemetry precondition test); rollback
   `models.selection.enabled: false` returns routing to assistant-only with the catalog readable.

**K14 — Cockpit catalog/pricing presentation (independent of K13).** Cockpit reads
`GET /api/models` when `models.read` is advertised, keeps an offline snapshot of the last
plane catalog, prices Usage/Retro from it, and labels every price with its source; the local
table is removed only after the offline snapshot works with the plane down.

Tests: `packages/core/test/model-intelligence.test.ts` (classifyTask determinism over three
dimensions, blending table, missing-prior/tie/normalization cases); `apps/api/test/router-model.test.ts`
(filters, shadow persistence, override); `catalog-refresh.test.ts` (TTL, freshness,
unreachable source, egress recorder); migration test for `runs.model_requested/model_resolved`;
Cockpit catalog view + offline snapshot tests.

### 5.4 M15 Runtime seam — deferred

No acceptance in this revision. When a second backend is proposed, its slice must show: durable
`providerSessionRef`, unchanged lease fencing, events through `EventRecorder`, honest isolation
tier, and no new filesystem path outside `WorkspaceAuthority`.

---

## 6. Implementation sequence — small demonstrable vertical slices

Ordering rationale (revision 2): the durable dispatch contract first, because everything that
"waits" depends on ownership being safe; quota with honest evidence next; identity before
catalog completeness; observation before intervention; presentation independent of scoring;
one benchmark source before any second; selection in shadow before activation. Slices are
independent unless a dependency is named — **no blanket dependency** forces benchmark, context
or runtime work to finish before unrelated increments.

**Core sequence**

| # | Slice | Repo | Demonstrable outcome | Depends on |
|---|---|---|---|---|
| K1 | `WAITING_RESOURCE` + `WaitCondition` (generations) + `dispatches` + `wake` protocol + `time` kind for newly created tasks + `run-now`/`cancel`/replace + boot recovery of dispatch phases + `pause_kind` + `TaskIntent` persistence + `routeTask`/explicit `continuation` + minimal waiting-state UI; migration 014 | ai-control-plan | "run this tonight": task parks, wakes exactly once at the instant, routes then, survives crashes at every step with at most one owner | inc. 2 (auth) — done |
| K2 | `quota` kind + `QuotaBlocker` evidence + effective `QuotaProjection` shared by router and scheduler + Harness-path `resetsAt` propagation fix + controlling-reset computation + bounded retry/`maxAutoWakes` + converting parked work (`LIMIT_PAUSED`/`WAITING_INPUT → WAITING_RESOURCE`) with the settled-predecessor precondition and deferral #7 claim wiring on the Harness path; `handoffs.trigger = wake` | ai-control-plan | "continue when Claude/Codex quota resets": limit → checkpoint → wait → revalidate → resume on whoever is eligible, with the blocker's provenance visible | K1; deferral #7 (Harness path) |
| K3 | Optional `QuotaProbe` (Claude OAuth usage; Codex app-server RPC once verified) as scoped `provider-api` observations; probe history separate from wake budget; redaction test | ai-control-plan | headroom visible while idle where an account exposes it; wake revalidates with it | K2 |
| K7 | Execution identity (`requestedModelSelector` / `resolvedModelId`, bridge plumbing, `runs.model_*` backfill of proven evidence only) + provider-official catalog + versioned price **evidence** + `GET /api/models`; deferral #3 stays open with its five gates named | ai-control-plan | every run says what was asked for and what served it (or `unknown`); `/api/models` lists capacity and price evidence with provenance | none |
| K9 | `ContextCapability` on manifests + `ContextObserver` (Claude provider-reported with the adapter forwarding `SDKContextUsage` and `compact_boundary`; Codex `unavailable`) + `context.observed` events + `GET /api/tasks/:id/context` + web gauge | ai-control-plan | live gauge on a Harness single-mode run, honest about unknown (O10 delivered as observation) | inc. 3 staging flag; K7 only for catalog window hints (optional) |
| K12 | Cockpit managed session context gauge (`context.read`) | cockpit | Cockpit shows occupancy/window/method/freshness for managed sessions | K9 |
| K11 | `yield(context)` + bounded checkpoint-anchored clean-session continuation with the minimum K10 safety (`criticalRatio` yield on fresh observations only, task-level limits, evidence adequacy) + real-provider eval scenario | ai-control-plan | a run with no compaction control checkpoints and continues from that checkpoint on the same model, at most N times per task, never on inadequate evidence | K9, K2 |
| K10 | Provider-command compaction (Claude `/compact` via a capability-gated session control), durable non-idempotent directives, observe-after-act, `[FAKE:CONTEXT]` scripting, fault-injection | ai-control-plan | a Claude run crosses `actRatio`, compacts, is observed relieved — all as events | K11; real-adapter conformance for the Claude control (deferral #4) |
| K14 | Cockpit catalog/pricing presentation + offline catalog snapshot; local table retired after | cockpit | one labelled price source, works with the plane down | K7 (**not** K13) |
| K8 | One verified benchmark source (Artificial Analysis) with attribution, release identity, normalization version, TTL/freshness, egress test | ai-control-plan | catalog shows one external prior with freshness chips; offline degrades cleanly | K7 |
| K13 | `classifyTask` (three dimensions) + `selectModel` in **shadow** + blending + explanation inside the routing decision; then gated activation | ai-control-plan | Routing view shows "shadow: would pick Claude / opus — coding 0.71 (own runs 12, prior AA coding 0.66)"; activation only after the gate | K7, K8 |

**Demand-driven**

| # | Slice | Repo | Demonstrable outcome | Depends on |
|---|---|---|---|---|
| K4 | `dependency` kind with cycle/self rejection and missing-dependency semantics; scheduler event hook on task terminal. **K4b (resource slots) deferred** until all launch paths share reservation/release | ai-control-plan | "run reviewer after implementation finishes" | K1; before increment 11 |
| K5 | Recurring `Schedule` + `schedule_occurrences` + cron dependency + atomic firing + catch-up + skip-only overlap + `GET/POST /api/schedules`; `schedules.read` | ai-control-plan | nightly template creates exactly one task per occurrence | K1 soaked (time waits in use) |
| K6 | Cockpit Schedule tab third source (read) + create via `commands.write`; `WAITING_RESOURCE` in managed views | cockpit | plane schedules and waiting tasks visible beside Cockpit jobs | K5, Cockpit auth follow-up |

**Deferred (decided, unscheduled)**

| # | Slice | Reason |
|---|---|---|
| K4b | Resource slots (`kind: resource`, `maxConcurrent`) | needs one reservation/release protocol across legacy, Harness and parallel-compare launch paths |
| K15 | Typed `harness.runtime` enum, `enforcement.runtime`, import-boundary test | speculative abstraction with one implementation; boundary test only after increment 6 retires the legacy launch path |
| K16 | Fold `jobs.ts` daily jobs into `system` schedules | no demonstrated operational need |
| — | Second/third benchmark sources (LiveBench, BenchLM), Archify asset, `DshAdapter`, herdr backend, generic pruning, Codex app-server transport for compaction | on demonstrated need / after the named gate |

---

## 7. Invariants added (summary)

- **I-S1** A wait condition or schedule stores durable user intent and wait subjects only;
  assistant, model and assets are chosen at every dispatch by `routeTask`, anchored to an
  explicit checkpoint or explicitly fresh, and recorded as a new routing decision. Explicit user
  overrides persist as intent and are applied as filters.
- **I-S2** `WAITING_RESOURCE` means the scheduler owns a parked task with no live or ambiguous
  execution owner; only `wake(generation)` (timer, event or operator) leaves it; a human is
  never bypassed forever (`maxAutoWakes` / `intervention-required` → `WAITING_INPUT`), and
  deferral never bypasses an approval, verification or comparison decision (CR-32).
- **I-S3** No queue, broker or second database; one durable table per concept, one re-armed
  timer, dispatch identity durable before any provider call, reconciled on boot. At most one
  live owner per task; exactly-once provider execution is not claimed.
- **I-S4** A retry timestamp is not recovery evidence; every quota blocker carries kind, source,
  observation time, scope and reset provenance, and wake revalidates before it starts.
- **I-C1** Context management never mutates or deletes persisted events, checkpoints, envelopes
  or results; provider compaction is observed and recorded, not trusted.
- **I-C2** No context action without a fresh observation before and after; unknown or stale
  observations never authorize automatic destructive continuation; a reduction that leaves
  critical pressure is not a success.
- **I-C3** The guard never clears a session; the last rung is a checkpoint-anchored clean
  session, bounded per task, and it is not lossless.
- **I-M1** Every model number the router uses carries source, tier, observation time,
  benchmark release (external) or sample size (own), normalization version and freshness; the
  explanation lists them.
- **I-M2** External evidence is a prior with weight `1 − n/(n+k)`; own telemetry's weight is
  monotone in `n` (not in time) and cannot be disabled; external evidence never grants
  eligibility or bypasses a hard filter.
- **I-M3** Catalog refresh sends no task, prompt, repository or usage data off the machine, and
  routing never waits on the network.
- **I-M4** A healthy context yield is not a provider error; one reliability predicate is shared
  by every telemetry aggregate.
- **I-M5** Requested selector and resolved identity are recorded separately; `unknown` is
  allowed; historical aliases are never resolved with a later catalog.
- **I-R1** (deferred with M15) Every provider process is launched through the Harness's
  `SessionRunner.startProvider` once increment 6 retires the legacy path; no runtime enum or
  backend interface exists before a second implementation.

---

## 8. Revision notes

### 2026-09-05 — revision 2 (adversarial review reconciliation)

- K1 redefined as a durable dispatch/ownership contract: condition generations, `dispatches`,
  one `wake` operation for timer/event/operator, cancellation semantics, boot recovery that
  distinguishes not-started / start-attempted-ambiguous / started; no exactly-once claim.
  Scope limited to newly created single-task time waits; converting parked work moved to K2.
- `WAITING_RESOURCE` given a normative ownership meaning; `pause_kind` added; deferral cannot
  bypass approval/verification/comparison (CR-32).
- Recomposition defined (intent preserved, choices recomputed, checkpoint anchor, new decision);
  I-S1 corrected for wait subjects and user overrides; one routing entry point (CR-30) and
  explicit fresh-vs-resume (CR-31); Composer stated as planned, not built.
- Quota: `CooldownStore.until` reclassified as a retry timestamp; `QuotaBlocker` kinds and
  provenance; Harness-path `resetsAt` drop recorded and scheduled for K2; controlling reset per
  candidate; one effective projection; freshness supersedes source rank; probe attempts
  separated from wake attempts; the "never starts into an exhausted window" promise replaced
  with revalidation and a bounded retry; probes optional and account-scoped, `reportsLimits`
  untouched (CR-22, CR-29).
- K5: atomic firing with unique occurrences; timezone/DST, edits, catch-up, skip-only overlap,
  disabled scheduler defined; queue mode deferred. K4: cycle rejection at first ship; missing
  dependency semantics; resource slots split off and deferred (K4b) (CR-23).
- M14: observation model separating occupancy, accounting, effective window, advertised max,
  source and freshness; unknown allowed; Codex estimator withdrawn; Claude programmatic
  `/compact` and Codex App Server compaction recorded from primary references; TUI-only claim
  withdrawn; capability-gated session control instead of an "unchanged" contract; compaction
  not replay-idempotent; event pump keeps running; fixed prune→compact ladder replaced by
  relief-based rules with provider auto-management primary (CR-34).
- Clean-session continuation: checkpoint anchor, evidence adequacy, settled predecessor,
  preserved constraints, provenance, task-level limits, bounded handoff input with a defined
  failure path; not lossless; Astra treated as a provider-specific session capability.
- M12: execution identity before catalog; requested vs resolved; no alias resolution against
  today's catalog; one authority for `ExecutionRequest.model`/`RunSpec.model` (CR-33); hard
  filters no benchmark can bypass; three initial dimensions; shadow selection then gated
  activation; missing priors, ties, normalization versions, benchmark identity, evidence age
  and cohorts defined; the "worse telemetry loses once n>k" claim corrected; monotone in `n`,
  not time; healthy context yields excluded from reliability (I-M4).
- Pricing: K7 supplies evidence; bounded cost caps keep five gates; benchmark prices and
  Cockpit family-match never authorize hard caps; offline catalog read preserved (CR-19).
- M15: runtime enum and abstraction deferred (K15); `ProviderSessionDriver` is conceptual,
  the seam is `SessionRunner.startProvider`; no global launch-boundary test before increment 6;
  Herdr optional and unscheduled (CR-28). K16 deferred (CR-24).
- External references: DeepSeek compaction modified for provider-owned context; Agent Room
  markers as untrusted reported evidence; Omarchy probes as optional scoped observations;
  BenchLM "no documented API" corrected; LiveBench licence vs leaderboard artifact
  distinguished, `all_groups.csv` is generated output; additional sources deferred until one
  is demonstrated useful.
- Delivery order reconciled: K1 → K2 → K3 → K7 → K9+K12 → K11 (+min K10) → K10 → K14
  (independent of K13) → K8 → K13; K4/K5/K6 demand-driven; K15/K16 deferred; blanket
  dependencies removed.

### 2026-09-05 — revision 1

- Initial architecture for M12–M15 with gap matrix, external-reference matrix, CR-16…CR-29,
  types, state transitions, acceptance and slices K1–K16.
