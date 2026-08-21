# Architecture Review — AI Agent Control Plane

**Reviewed document:** `docs/original-plan.md`
**Review date:** 2026-08-21
**Verdict:** The product idea is sound and the core abstractions are the right ones, but the proposal is roughly **3× larger than the smallest architecture that proves the core loop** (`prompt → route → execute → observe → checkpoint → handoff`). Two structural assumptions are wrong (providers can export handoff state; benchmarks can drive routing from day one), one major component is premature (the distributed Runner architecture), and the adapter contract is too fat to be honestly implementable across the four target providers.

This review: (1) summarizes the product, (2) verifies provider capabilities against current reality, (3) challenges the architecture point by point, (4) gives the KEEP / CHANGE / REMOVE / DEFER decision list. The revised architecture is in `docs/revised-architecture.md`; the phased plan is in `plans/implementation-plan.md`.

---

## 1. Product understanding (confirmed)

A **meta-orchestrator for complete assistant environments** — not another assistant, and not an LLM gateway. The routing unit is *Claude Code + its models + skills + MCP + account limits* vs. *Codex + its sandbox + ChatGPT-plan quota* vs. *Cursor + its rules* vs. *a deployed Bedrock agent + IAM*. It:

- accepts a prompt in a workspace (`personal` | `work`),
- catalogs what each assistant environment can currently do,
- picks (explainably) the best one per user-chosen criteria,
- runs it, normalizing execution into a provider-independent event timeline,
- checkpoints portable task state, and
- hands off — manually, or automatically when the chosen assistant hits its quota (personal workspace requirement #1).

The differentiator claim in §36 of the original plan is correct and worth protecting: **this is a runtime/capability routing problem, not a model benchmark problem.** Every simplification below is tested against that.

---

## 2. Provider capability verification (2026-08)

This is the ground truth the architecture must fit. Verified against current documentation and release notes:

| Provider | Best integration | Structured events | Resume | Limit visibility | Tier |
|---|---|---|---|---|---|
| **Claude Code** | Claude Agent SDK (TypeScript) — `query()` with streaming messages, `resume`/session IDs, hooks, MCP, subagents, permission modes, `includePartialMessages` | Rich (typed message/tool/usage stream) | Yes (session id) | Usage events + limit errors; subscription draws from a separate Agent SDK credit pool since June 2026 | **1 (full)** |
| **OpenAI Codex** | Official `@openai/codex-sdk` (TypeScript) — wraps the CLI, JSONL events over stdio, `runStreamed()`, thread resume, ChatGPT-subscription auth | Rich (JSONL: tool calls, file changes, streaming responses) | Yes (thread id) | **Excellent:** `token_count` events carry a `rate_limits` payload — `primary/secondary.used_percent`, `plan_type`, `resets_at` | **1 (full)** |
| **Cursor** | `agent` CLI headless: `-p/--print`, `--output-format json` / stream, MCP support, resume by chat id | Moderate (thinner than the SDKs; output-format dependent) | Yes (chat id, less robust) | Weak — errors only, no usage stream | **2 (degraded)** |
| **AWS Bedrock (AgentCore)** | AgentCore Runtime — GA since Oct 2025; `InvokeAgentRuntime` (streaming), shell-command API (Mar 2026), interactive shells over WebSocket (Jun 2026), EC2-backed runtime instances (Aug 2026) | Depends on the agent you deploy — AgentCore is a **hosting platform, not an assistant** | Session-based | AWS-metered (API billing, not plan quota) | **2 (different shape)** |

Four consequences that reshape the architecture:

1. **Quota failover is genuinely implementable** for the personal workspace — Codex reports `used_percent`/`resets_at` in-stream, and Claude surfaces usage and typed limit errors. No scraping, no guessing. This validates the plan's Phase-2 centerpiece.
2. **No provider exports a handoff package.** `exportHandoff()`/`createCheckpoint()` as *adapter* methods assume a capability nobody has. Handoff must be a **control-plane function** built from data the plane already owns (its normalized event log, the TaskEnvelope, git state).
3. **Both tier-1 providers are TypeScript-first.** That settles question 9: TypeScript/Node is the right stack — the adapters are thin wrappers over official SDKs rather than protocol reimplementations.
4. **"Bedrock" is not an assistant.** Routing to Bedrock means invoking a *specific agent you have deployed* on AgentCore. The adapter is easy (invoke + stream); the missing requirement is *which agent exists there and what it can do* — that's registry configuration, not discovery.

---

## 3. Challenges to the architecture

### 3.1 The Runner architecture is premature — replace with process-level workspace isolation

The plan's biggest cost center is the Control Plane + Runner split: a secure runner protocol, runner lifecycle management, remote credential delegation, reconnect handling. For a single user whose personal and work environments **already live on different machines**, all of that is solved by a simpler construction:

> **One control-plane instance per machine. A workspace is an instance, not a row.**

- Personal Mac runs the whole stack (API + UI + adapters) locally; work machine runs its own, with its own config dir and its own SQLite file.
- Credentials never leave the machine they're on — which is exactly the plan's own §6/§32 security goal, achieved by construction instead of by protocol.
- Cross-workspace handoff becomes *impossible* rather than *forbidden by policy* — the strongest kind of guarantee.
- The `Runner` entity, `runner-manager` service, runner auth, and the control-plane↔runner transport all disappear from the MVP.

The interface seam is preserved: adapters already abstract "how do I execute here." If a work EC2 runner is truly needed later (Phase 4+), it enters as a `RemoteAdapter` that proxies the same adapter contract over HTTP — the domain model doesn't change. **Tradeoff:** no single pane of glass across both workspaces initially. That's acceptable; a read-only federated view is a small later feature, and mixing work task metadata into a personal dashboard is a security liability anyway.

### 3.2 The AgentAdapter is too fat — 17 methods → 6

Six of the original methods (`getModels/getTools/getSkills/getPlugins/getMcpServers/discoverCapabilities`) force every provider to answer questions only Claude Code can answer well (Codex has no plugins; Cursor has rules, not skills; a Bedrock agent has none of these). Two more (`createCheckpoint`, `exportHandoff`) assume capabilities no provider has (§2.2 above). `sendMessage` mid-run is only cleanly supported by tier-1 providers, and `getUsage`/`getLimits`/`health` duplicate what the event stream already reports.

Revised contract (full version in `docs/revised-architecture.md`):

```ts
interface AgentAdapter {
  readonly id: AssistantId;
  describe(): Promise<CapabilityManifest>;   // one call; provider-shaped detail in a typed bag
  start(run: RunSpec): Promise<RunHandle>;   // RunSpec = rendered TaskEnvelope + workdir + policy
  resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle>;  // throws NotSupported
  events(handle: RunHandle): AsyncIterable<NormalizedEvent>;         // adapter maps in-stream
  cancel(handle: RunHandle): Promise<void>;
}
```

Key changes and why:

- **`describe()` replaces six getters.** Capabilities are a manifest with a common core (`canResume`, `canMcp`, `reportsUsage`, `reportsLimits`, `supportsMidRunInput`, models list) plus a provider-specific section. The registry stores the manifest; the router reads the common core; the catalog UI can render the provider bag. Nobody pretends Cursor has "plugins."
- **Adapters emit `NormalizedEvent`s directly** instead of raw `ProviderEvent`s plus a separate event-normalizer service. The mapping knowledge lives where the provider knowledge lives. Raw provider payloads ride along in `event.raw` for debugging — normalization is lossy by design, deletion is not.
- **Usage and limits are events, not polls.** `usage.updated` and `limit.approaching`/`limit.hit` are normalized event types the adapter emits when the provider reports them (Codex `token_count.rate_limits`, Claude usage messages/limit errors). The Limit Monitor is a *consumer of the event stream*, not a poller. `getLimits()` survives only as an optional field inside `describe()` for pre-routing checks.
- **Checkpoint/handoff move to the control plane.** The plane assembles: current TaskEnvelope + git branch/diff + last-N normalized events summary + decisions. Adapter involvement: zero. `resume()` exists for *same-provider* continuation (both tier-1 SDKs support it); *cross-provider* handoff always goes through `start()` with a handoff-rendered prompt.

### 3.3 Routing: the scoring engine has no data to eat — start with rules, keep the explanation

The 7-factor weighted score requires quality/speed/reliability/token-efficiency measurements that don't exist on day one, and the plan's own §26 admits the score table is fictional. Worse, §25's benchmark suite would *burn the same subscription quota the router is trying to preserve* — a daily benchmark run against Claude and Codex is self-defeating on plan-based pricing.

Replacement, in order of introduction:

1. **Phase 1 — deterministic rule router.** Hard filters (workspace-allowed, authenticated, healthy, quota not exhausted, required capabilities present) → then user's profile maps to a simple preference order over the 2 candidates. With two assistants, a weighted score is indistinguishable from an `if` statement — but the *explanation object* ("chose Codex: Claude at 92% of 5h window, resets 14:00; both satisfy repo+shell") is built from day one, because explainability is a UI/trust feature, not a scoring feature.
2. **Phase 3+ — passive scoring.** Every real task already produces the metrics §25 wants (duration, tokens, retries, tests passed, user corrections, failover count). Score from *real telemetry*, rolling-windowed, segmented by task type. No synthetic benchmark suite until there's a demonstrated routing mistake that telemetry can't catch.
3. **Routing profiles collapse for subscription providers:** `Lowest Cost` ≈ `Lowest Tokens` ≈ *quota-budget preservation* when both providers are flat-rate plans. Keep three honest profiles at first — `Auto`, `Preserve Quota`, `Fastest` — and add the rest when metered providers (Bedrock) make cost a real axis.

Task classification: same story. A keyword/heuristic classifier (needs repo? needs shell? long-context?) plus an optional user override covers routing needs; an LLM classification call per task adds latency, quota use, and a failure mode. DEFER the LLM classifier until heuristics demonstrably misroute.

### 3.4 Capability sync: right idea, wrong granularity

Daily sync is in the user's requirements and stays. But for CLI-based assistants, capabilities are **static per installed version** — tools/skills/MCP change when config or version changes, not hourly. So sync =

- fast probe: CLI/SDK version, auth state, model list where enumerable, MCP/skills config hash — re-`describe()` only when something changed;
- quota state: refreshed *continuously from run events* (free) + a lightweight probe when idle;
- a `capability.changed` diff event feeding the UI's "what changed today" feed (keep — it's cheap and directly serves the "updated on daily basis" requirement).

`CapabilityEvidence` gets simplified: keep `{value, source, observedAt}`; **drop `confidence: number`** — nobody can assign 0.7 vs 0.8 meaningfully, and unused precision is complexity. A source-priority rule (runtime-probe > provider-api > local-config > manual) resolves conflicts deterministically.

### 3.5 Lifecycle: 21 states → 9

Fine-grained states like `PLANNING/EXECUTING/TESTING/REVIEWING` and `WAITING_FOR_{AGENT,USER,APPROVAL,TOOL}` are not reliably distinguishable from provider streams — adapters would be guessing, and a state machine built on guesses corrupts orchestration decisions. Split the concept:

- **Orchestration state** (machine-authoritative, drives failover/handoff): `CREATED → ROUTING → RUNNING → WAITING_INPUT → LIMIT_PAUSED → HANDING_OFF → COMPLETED | FAILED | CANCELLED`.
- **Activity phase** (informational, best-effort, shown in the timeline): planning/editing/testing/reviewing as *event annotations*, never as orchestration triggers.

This directly answers review question 3: yes, event-source the run history (append-only `events` table, SQLite is fine) and materialize current task state — but keep the authoritative state machine small enough that every transition has an unambiguous trigger.

### 3.6 TaskEnvelope and task files: the crown jewel — keep, with two corrections

The TaskEnvelope design (goal/constraints/repo/status/completed/remaining/decisions/artifacts/next_action) is the best part of the plan and is what makes cross-provider handoff work. Corrections:

1. **The envelope must be updated by the plane, not only by agent goodwill.** The plan hopes the active agent calls a progress API. Reality: sometimes it will (instruct it to in the rendered prompt), often it won't. So the plane also *derives* envelope updates from the event stream (files changed, tests run, phase annotations) and treats agent-reported progress as an enrichment. Handoff quality then degrades gracefully instead of collapsing when an agent ignores instructions.
2. **`decisions` need provenance** (`made_by: user | agent:<id>`, timestamp) — during handoff, the receiving agent must know which constraints are user-imposed (inviolable) vs. inherited agent choices (revisitable).

Markdown as generated projection (DB = truth, `progress.md`/`handoff.md` = rendered): keep exactly as proposed. This was correctly designed.

### 3.7 What handoff actually passes (review question 5)

In the package: TaskEnvelope, git branch + diffstat + key hunks, last test results, decisions with provenance, a ~1-page summarized recent activity. By reference (fetchable via plane API if the receiving agent asks): full event log, full diffs, prior transcripts. Never: raw provider transcripts by default (token waste, cross-provider leakage of provider-specific artifacts), secrets (redaction pass before render).

### 3.8 Backend/Frontend stack (review questions 9–11)

- **TypeScript everywhere** — confirmed by §2.3. One repo, shared domain types between API/adapters/UI.
- **Fastify over NestJS** — the domain complexity is in adapters and orchestration, not in HTTP; NestJS ceremony buys nothing here.
- **SQLite only** (better-sqlite3 + a thin query layer or drizzle) — single user, single machine, one writer. Postgres enters if/when a multi-machine deployment actually exists. **No Redis/BullMQ ever in MVP**: orchestration is in-process with persisted state; crash recovery = on boot, reconcile `RUNNING` tasks against reality (provider session resumable? → offer resume; else mark `FAILED(orphaned)`), which answers §33's restart-survival requirement without a distributed queue.
- **SSE, not WebSocket** — event flow is one-way (plane → UI); user actions are plain HTTP POSTs. SSE reconnection semantics are simpler and sufficient.
- **UI: React + Vite, 4 screens** (New Task + recommendation, Task board, Task detail with timeline/diff/usage tabs, Assistant catalog with change feed). The plan's screen list is right; it just arrives across phases, not at once.
- **13 services → 5 modules in a modular monolith**: `registry` (assistants + capabilities + sync), `tasks` (envelope + lifecycle + files), `router`, `orchestrator` (runs + events + limits + checkpoint/handoff), `api` (HTTP + SSE). Module boundaries mirror the plan's service boundaries, so extraction later is possible — but no network hops between them now.

### 3.9 Missing requirements the plan doesn't cover

1. **Approval flow-through** — tier-1 assistants ask permission for risky actions. The plane must surface `approval.requested` to the UI and route the answer back (supported by both SDKs' permission modes). Without this, every non-trivial run stalls. *This is Phase 1 scope, not polish.*
2. **Concurrency/budget caps** — max concurrent runs, max runtime per task, per-day quota budget the router may spend. One runaway agent can drain a 5-hour window.
3. **Mid-run cancellation semantics during handoff** — cancel source *after* checkpoint assembly, and record partial state if cancel races completion.
4. **Repository allowlist per workspace** — the plan implies it; make it explicit config: work instance refuses paths outside its allowlist.
5. **UI exposure** — bind to localhost by default; if ever exposed, it needs auth. Single-user ≠ no security.
6. **Failover notification** — automatic failover must be *loud* (UI banner + event), never silent; the user asked for automation, not surprises.
7. **Event-log retention** — append-only grows forever; add a pruning/archival policy (e.g., compress events of tasks completed >30 days).
8. **Dirty-worktree policy** — refuse to start a coding task on a dirty tree unless the user opts in; create `task/<id>` branch per task (already implied by §24, now explicit for the single-agent case too).

### 3.10 Unnecessary complexity — condensed

Runner protocol (§3.1), 17-method adapter (§3.2), scoring engine + benchmark suite at MVP (§3.3), LLM task classifier (§3.3), 21-state machine (§3.5), separate event-normalizer service (§3.2), 13-service topology (§3.8), confidence numbers (§3.4), Postgres/Redis/BullMQ (§3.8), `GenericMcpAdapter`/`GenericCliAdapter` (no concrete target; the fifth adapter will teach what generic means).

---

## 4. KEEP / CHANGE / REMOVE / DEFER

### KEEP
- Product definition & differentiator: route **assistant environments**, not LLM APIs (§36).
- The five core abstractions: TaskEnvelope, AgentAdapter, CapabilityRegistry, Router, NormalizedEventStream.
- TaskEnvelope as structured, provider-independent task state; DB = truth, Markdown (`progress.md`, `handoff.md`) = generated projection.
- Normalized event timeline instead of raw chain-of-thought; append-only event log + materialized state.
- Explainable routing (persisted decision + reasons, shown before execution).
- Automatic quota failover for personal workspace, with cooldown penalties for failed providers.
- Worktree isolation rule: never two assistants in one working tree.
- Daily + on-demand capability sync with a "what changed" feed.
- Security principles: credential isolation, redaction, audit of routing/handoff/approvals, no cross-workspace handoff.
- TypeScript; SQLite for MVP; SSE for live events; native SDKs over terminal scraping.
- Phased delivery with a vertical slice first; §35's not-to-build list (extended below).

### CHANGE
- **Workspace isolation:** from Runner protocol → one control-plane instance per machine ("workspace = instance"); isolation by construction (§3.1).
- **AgentAdapter:** 17 methods → 6; capability getters collapse into `describe()`; adapters emit normalized events directly; usage/limits become event types (§3.2).
- **Checkpoint/handoff:** from adapter methods → control-plane functions over owned data; `resume()` for same-provider only, `start()` + rendered handoff prompt cross-provider (§3.7).
- **Routing:** from weighted scoring engine → hard filters + rule-based preference with a first-class explanation object; scoring later, fed by passive telemetry (§3.3).
- **Routing profiles:** 9 profiles → 3 honest ones (`Auto`, `Preserve Quota`, `Fastest`); rest when metered providers arrive.
- **Lifecycle:** 21 states → 9 orchestration states + informational activity-phase annotations (§3.5).
- **Task classification:** LLM-assisted → heuristics + user override (§3.3).
- **CapabilityEvidence:** drop `confidence`; keep `{value, source, observedAt}` + deterministic source priority (§3.4).
- **Backend topology:** 13 services → 5-module modular monolith; Fastify; no NestJS (§3.8).
- **TaskEnvelope:** add decision provenance; plane derives progress from events rather than trusting agent self-reporting alone (§3.6).
- **Bedrock:** reframed from "assistant" to "registry of deployed AgentCore agents you invoke" — configuration, not discovery (§2.4).

### REMOVE
- Runner entity, runner-manager, control-plane↔runner protocol and its auth (re-enters, if ever, as a `RemoteAdapter` behind the same interface).
- Separate event-normalizer service (folded into adapters).
- `getSkills()/getPlugins()/getMcpServers()/getTools()/getModels()/discoverCapabilities()` as separate adapter methods.
- `createCheckpoint()/exportHandoff()` from the adapter contract.
- Synthetic benchmark suite that consumes subscription quota (replaced by passive telemetry; a tiny opt-in eval set may return post-MVP if telemetry proves insufficient).
- Numeric confidence scores on capability evidence.
- `GenericMcpAdapter`, `GenericCliAdapter` (speculative).
- Redis/BullMQ/Postgres from every phase currently in scope.

### DEFER
- Remote/EC2 runner support → after work-workspace basics (and only if actually needed).
- Parallel modes (Race / Compare / Specialist Pipeline / Independent Reviewer) → Phase 5; worktree-per-task lands earlier since it also protects single-agent runs.
- LLM-assisted task classification → after heuristic misrouting is observed.
- Weighted scoring + extended routing profiles (`Best Quality`, `Lowest Cost`, `Long Context`, `Custom`) → Phase 5, telemetry-fed.
- Cursor + Bedrock adapters → Phase 4 (work workspace).
- Cross-instance federated dashboard (read-only view over both workspaces) → post-MVP, if wanted.
- Model-level auto-selection within an assistant (e.g., choosing Sonnet vs. Opus per task) → after assistant-level routing is proven.
- Mid-run `sendMessage` steering in the UI → tier-1 adapters support it; wire it when the observability UI is stable.

---

## 5. Answers to the original §38 review questions (index)

| # | Question | Answer |
|---|---|---|
| 1 | Adapter at right level? | No — too fat; see §3.2 |
| 2 | What can't normalize? | Plugins/skills/rules taxonomies, approval semantics, checkpoint/handoff, fine activity phases → capability manifest bag + informational annotations |
| 3 | Event-sourced? | Yes for run history (append-only + materialized state); no full event-sourcing framework |
| 4 | TaskEnvelope sufficient? | Nearly — add decision provenance + event-derived progress (§3.6) |
| 5 | Handoff contents? | §3.7 — envelope + diff + decisions + summary inline; transcripts/logs by reference |
| 6 | Limit detection: subscription vs API? | Subscription: in-stream events (Codex `rate_limits`, Claude usage/limit errors) + error classification; API/Bedrock: metered cost tracking. Never generic polling |
| 7 | Avoid unstable CLI output? | Official SDKs for tier 1 (JSONL/typed streams); Cursor pinned to `--output-format json`; version-gate adapters and fail loud on schema drift |
| 8 | Direct launch vs Runners? | Direct, in-process, per-machine instance (§3.1) |
| 9 | TypeScript both sides? | Yes — both tier-1 SDKs are TS-first (§2.3) |
| 10 | SQLite only? | Yes, indefinitely for single-user (§3.8) |
| 11 | When Redis/BullMQ? | Only with multi-machine distribution — i.e., possibly never |
| 12 | Cheap classification? | Heuristics + override; LLM deferred (§3.3) |
| 13 | Benchmark overfitting? | Moot — benchmarks removed; passive telemetry measures the real workload by definition (§3.3) |
| 14 | Router confidence? | Not a number — an explanation object: filters applied, rule fired, quota states, tie-broken-by |
| 15 | Parallel evaluation? | Deferred to Phase 5: tests + lint + diff review in worktrees; user picks winner (auto-evaluator later) |
| 16 | Worktree/checkpoint safety? | Branch-per-task, worktree-per-assistant, dirty-tree refusal, merge only after review (§3.9.8, §24 kept) |
| 17 | Per-provider specifics? | §2 table; Bedrock = deployed-agent registry entry |
| 18 | Brittle assumptions? | Adapter-exported handoffs (wrong), enumerable capabilities everywhere (wrong), benchmark-fed router (self-defeating), Cursor output stability (version-pin) |
| 19 | Postpone/delete? | §4 REMOVE + DEFER lists |
| 20 | Smallest proving architecture? | `docs/revised-architecture.md` — 2 adapters, 5 modules, 1 machine, 9 states, rule router |
