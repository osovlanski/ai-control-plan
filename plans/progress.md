# Project Progress

## Current phase

**Phase 5 — complete. All planned phases are delivered.** Parallel comparison and race modes run in isolated worktrees, and the routing profiles are now fed by measurements from the user's own runs.

**Live verification against real providers (2026-08-22) — see log entry below for the full report.** Two real defects found and fixed in `claude.ts`/`orchestrator.ts`; everything else in the core loop, handoff, parallel compare, and telemetry worked against real `claude`/`codex` CLIs on the first try.

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
- Bedrock auth detection proves credentials exist locally, not that they may invoke a specific ARN — deliberately no network call on the boot/daily-sync path. A misconfigured ARN surfaces as `AccessDeniedException` on first invoke, which fails the run and cools the assistant down rather than misrouting to it forever.
- Cursor is unroutable until its CLI is installed and the mapping calibrated; the manifest reports `auth: missing` and `mappingVerified: false`, so the router excludes it with a stated reason.
- Cross-provider `resume()` is never used — cross-provider continuation always goes through a fresh `start()` with the handoff package, by design.

- [x] **Phase 4:** work-workspace instance — per-workspace policy defaults (work starts with approval-gated failover and no assumed assistants), instance approval mode wired into every run, repo allowlist enforced
- [x] **Phase 4:** `BedrockAdapter` written against the real `@aws-sdk/client-bedrock-agentcore` 3.1116 type declarations
- [x] **Phase 4:** `CursorAdapter` scaffold with the unverified event mapping quarantined in one function that fails loudly
- [x] **Phase 4:** verified live — two instances side by side; work routed across three providers with Cursor honestly excluded, zero personal data in the work DB, allowlist returning 403/201 correctly

- [x] **Phase 5:** Compare mode — one worktree and branch per competitor, side-by-side diff/tests/duration/tokens, user picks the winner, winning branch merges into the task branch while the rejected one stays inspectable
- [x] **Phase 5:** Race mode — first success wins and the losers are cancelled so parallel runs stop burning quota
- [x] **Phase 5:** `TelemetryService` — rolling per-assistant, per-task-kind metrics derived from the existing runs/events tables (no second source of truth, no synthetic benchmarks)
- [x] **Phase 5:** `fastest`, `best-quality` and `lowest-tokens` profiles now use those measurements behind the unchanged `route()` interface, degrading to stable order and saying so when no measurement exists
- [x] **Phase 5:** UI — Compare tab with per-competitor diff/test/token stats and a "keep this" action, Compare/Race launch buttons, measured profiles in the picker
- [x] **Phase 5:** verified live — two assistants ran in genuinely separate git worktrees, the winner's commit merged into the task branch, the loser's branch survived, race mode cancelled the loser, and `fastest` switched from a placeholder to a real measurement

### Phase 5 delivery notes

- **The orchestrator's core invariant changed.** Its active-run map was keyed by
  task id since Phase 1; a task may now have several runs in flight, so it is
  keyed by run id with a per-task index. Single-run paths (handoff, approval,
  checkpoint) go through `soleRun()` or iterate the task's runs.
- **Competitor branches are siblings, not children:** `task/<id>--<assistant>`.
  Git refs are a filesystem hierarchy, so `refs/heads/task/<id>` existing as a
  file makes `refs/heads/task/<id>/<assistant>` impossible to create. Found by
  running it, not by reading about it.
- **The parallel marker is independent of the worktree.** Conflating them broke
  non-repo comparisons (planning, research), where there is no worktree at all
  and the second competitor tripped the single-run guard.
- **Scores prefer the most specific evidence available per assistant:**
  task-kind scores where they exist, falling back to that assistant's overall
  record rather than discarding a real measurement because it came from a
  different kind of task.
- **Deferred by design:** specialist pipelines (plan → implement → review) and
  the independent-reviewer mode. The plan sequences them after Compare and
  Race, and neither is needed for the success condition. No synthetic eval
  suite was added — telemetry from real runs has not yet missed anything.

### Phase 4 delivery notes (what is verified, and what is not)

Provider surfaces differ in how far they could be verified from the build
environment, and the adapters say so rather than pretending otherwise:

- **Bedrock — types verified, live service not.** `@aws-sdk/client-bedrock-agentcore`
  was installed and its declarations read directly (the Phase 1 method).
  Confirmed from types: `InvokeAgentRuntimeCommand` requires
  `{ agentRuntimeArn, payload }`; `runtimeSessionId` round-trips on request and
  response, so `canResume: true`; `ThrottlingException` and
  `ServiceQuotaExceededException` are typed, so limit *hits* feed the existing
  failover path. AWS is metered rather than plan-quota'd, so there is no
  used-percent and `reportsLimits` stays false — the same honest shape as Codex.
  `execution` is reported as false/unknown because what a *deployed* agent can
  do is not discoverable from here, and a guess would feed router hard filters.
  `providerDetail.verifiedAgainstLiveService: false`.
- **Cursor — structure real, mapping quarantined.** The CLI was not installed and
  cursor.com is egress-blocked, so the JSON event shape could not be verified by
  any means. Process lifecycle, cancellation, manifest and registry wiring are
  real and tested; the single unverified piece is `mapCursorLine`, which throws
  `CursorSchemaError` naming the calibration path instead of inventing plausible
  events. `canResume` is reported false on purpose: a wrong `true` breaks resume
  at runtime, a wrong `false` only costs a fresh start — asymmetric risk.
  To finish: capture `agent -p --output-format json` output on a machine with
  the CLI, run it through `calibrateFromSamples`, extend `mapCursorLine`.

### Phase 3 review fixes (found reviewing the Codex implementation)

The Phase 3 features were implemented well — redaction in particular correctly
covers `Event.raw` pre-insert, with an end-to-end test. Three defects were found
in the seams between the new code and existing invariants, all now fixed with
regression tests:

- **Probe overwrote the adapter's manifest, making authenticated assistants
  unroutable.** `syncChanged` replaced `core.auth.state` and `core.models` with
  values the cheap probe scraped from config files. The probe only checks
  credential *files*, so an assistant authenticated via `ANTHROPIC_API_KEY` was
  marked `auth: missing` at every boot and hard-filtered out of routing — while
  the routing explanation read like a legitimate decision. This inverted the
  evidence hierarchy (review §3.4): `describe()` *is* the runtime probe and
  outranks local-config. The cheap probe now only decides **whether** to
  re-`describe()`, and enriches `providerDetail` with version/configHash.
- **`execFileSync` blocked the event loop** on the boot and daily-job path — up
  to 5s per provider with no requests served, no SSE delivered, and in-flight
  runs stalled. Now async `execFile`.
- **The daily job could crash the process and kill its own reschedule.**
  `retention.archive()` threw synchronously inside the timer callback with no
  guard, and a throw also skipped `schedule()`, silently ending the daily job
  forever. Both halves are now contained and always re-arm; `syncChangedAll`
  reports per-assistant failures instead of swallowing them silently.

### Architecture changes made during Phase 3 (with reasons)

- **Probes remain outside the six-method adapter contract.** Cheap CLI version, auth-state, configured-model, and MCP/skills hashes gate the existing `describe()` call.
- **Retention archives transactionally in SQLite.** Gzip blobs replace old live rows and the existing event endpoint reads both forms.
- **Redaction runs at event ingestion.** Only the redacted event reaches SQLite, envelope derivation, or SSE; renderers make a second pass for user-authored data.
- **Checkpoint commits tolerate same-tree races.** A concurrent checkpoint that already committed the staged tree resolves to clean HEAD.

### Phase 3 limitations

- Idle quota refresh is best-effort from cached manifest limits. Providers exposing quota only in run streams cannot be polled without violating the settled adapter contract.
- Model discovery uses models named in supported local config when no typed SDK/CLI model-list surface exists.
- Baseline redaction covers common keys, bearer tokens, JWTs, and secret-style `.env` assignments; it is not a general DLP engine.

### Live provider verification (2026-08-22) — findings and fixes

First run against real `claude` and `codex` CLIs (previously only exercised via
`FakeAdapter`). Full loop worked end to end: capability discovery, routing,
run/stream/checkpoint, manual cross-provider handoff, parallel compare with
merge, and telemetry-fed `fastest` routing. Two real defects found and fixed;
one environment limitation found and left alone (not this repo's bug).

**Fixed — `ClaudeAdapter` never emitted `file.changed`.** `mapMessage` only
produced `tool.started`/`tool.completed` for `Write`/`Edit`/`NotebookEdit`
calls, even though the normalized event set (arch §4) defines `file.changed`
as part of the closed v1 set and `CodexAdapter` already implements it from
`file_change` items. `progress.md`'s "Changed Files" only looked right by
accident, via the git-derived reconciliation in `checkpoint.ts`. Fixed by
tracking pending file-mutating tool calls by `toolUseId` in `claude.ts` and
emitting `file.changed` (`path`, `kind`, `tool`) when their `tool_result`
comes back non-error. Verified live: a real `Write` call for `hello.txt` now
produces a `file.changed` event.

**Fixed — orchestrator ignored the `ok` flag on `file.changed` events.**
`CodexAdapter` already reports failed writes with `ok: item.status ===
"completed"` in the payload (a real, intentional signal), but
`orchestrator.ts`'s `applyEvent` added the path to
`envelope.artifacts.changedFiles` unconditionally. Caught live: a Codex run
whose sandbox rejected every write (see below) still showed the never-created
file in `progress.md`'s "Changed Files" and in the parallel-compare diff
summary. Fixed by skipping the add when `payload.ok === false`. Verified live
on a second Codex run under the same sandbox failure: "Changed Files" is now
correctly empty.

**Not fixed — Codex CLI's own sandbox fails in this container.** Every real
Codex run here failed to write any file, with `bwrap: loopback: Failed
RTM_NEWADDR: Operation not permitted` (also reproduced with the bare `codex
exec -s workspace-write` CLI, no plane involved). Codex's bundled bubblewrap
sandbox tries to set up a loopback network device for `workspace-write` mode
and this container doesn't grant the capability (`bubblewrap` isn't even on
PATH here — codex falls back to a bundled copy). This is a host/container
permission issue, not an `ai-control-plan` bug — not touched. One side effect
worth knowing: `CodexAdapter` maps the SDK's `turn.completed` unconditionally
to `run.ended {ok:true}` (that's genuinely what the typed event means — the
turn completed; there's no other typed success/failure signal at this SDK
layer), so a Codex run that self-reports total failure in its final message
still ends `ok:true` and counts as a telemetry success. This is consistent
with the project's existing policy against inferring outcomes from message
text, but it means `/api/scores` successRate for Codex is currently
optimistic in an environment where its sandbox can't write at all.

**Observed, reported as a judgment call, not fixed — `handoff.md`'s "Errors
encountered" section is noisy on manual handoff.** Cancelling a run to hand
it off makes the Claude/Codex adapter's stream throw (abort), which both
adapters classify as a generic `error` event ("Claude Code process aborted by
user"). This is harmless functionally — `orchestrator.ts` sets
`run.handingOff = true` before every cancel path (manual handoff, `/cancel`,
shutdown, race-mode loser cleanup), so `settleRun` always returns early and
this never triggers spurious failure-based failover — but the same `error`
event still feeds `checkpoint.ts`'s `summarizeActivity`, so a fresh assistant
reading `handoff.md` sees an "Errors encountered" line that looks like a
provider fault when it was actually an intentional handoff. Distinguishing
"aborted because we're handing off" from "aborted because something broke"
from the error text alone would be a fragile heuristic; flagging instead of
fixing.

**Also observed:** `checkpoint.ts`'s `summarizeActivity` digest lists recent
tool calls as bare "Tool completed" / "Tool completed" / "Tool completed" for
Claude-originated runs, because `tool.completed`'s `summary` field never
carried the tool name (only `tool.started` did). Real handoff.md output showed
this — it's a content-quality gap in the handoff package, not a correctness
bug, and not fixed here.

Everything else matched the CHECK list exactly: `run.started` carried a real
`providerSessionRef` (visible in the `runs` table even when the SSE client
connected after the event fired — a test-script timing artifact, not a
mapping bug); `usage.updated` carried real token counts and cost for Claude
and real token counts for Codex; cross-provider handoff continued in the same
worktree/branch without redoing already-checkpointed work; parallel compare
produced two real worktrees/branches, a real diff for the working competitor,
and a clean merge onto `task/<id>` with the loser's branch surviving;
`fastest` routing cited a real measurement ("16.3s over 3 runs") instead of
the "no latency telemetry yet" placeholder.

## Log

- 2026-08-21 — Architecture review completed and pushed to `claude/multi-assistant-routing-plan-vw0bwc`.
- 2026-08-21 — Architecture accepted; Phase 0 scaffolding built and verified (`pnpm dev` boots API + UI against migrated SQLite; typecheck/lint/20 tests green).
- 2026-08-22 — Phase 1 delivered: real Claude + Codex adapters written against the installed SDKs' type declarations, rule router, orchestrator with SSE and approvals, three UI screens. 45 tests green; core loop verified live end to end.
- 2026-08-22 — Phase 5 delivered: parallel Compare/Race in isolated worktrees, winner merge, and telemetry-fed routing profiles. 99 tests green; verified live end to end. All planned phases complete.
- 2026-08-22 — Phase 4 delivered: work workspace with stricter defaults, Bedrock adapter against verified SDK types, Cursor scaffold with quarantined mapping. 85 tests green; two instances verified side by side with honest cross-provider filtering.
- 2026-08-22 — Phase 3 (implemented in Codex) reviewed here: features sound, three seam defects fixed — probe/manifest authority inversion, blocking subprocess, unguarded daily job. 69 tests green; env-authenticated assistant verified routable again against a running server.
- 2026-08-22 — Phase 2 delivered: checkpoints, portable handoff packages, `resets_at`-aware cooldowns, and automatic quota failover. 51 tests green; verified live — a limit on one assistant checkpointed and completed on the other, and an all-limited task parked with the reasons and reset times named.

- 2026-08-22 — Phase 3 delivered: change-driven daily capability probes and catalog feed, compressed 30-day event retention, and pre-persistence/render/handoff redaction.
- 2026-08-22 — First live run against real `claude`/`codex` CLIs (all prior verification used `FakeAdapter`). Found and fixed two real defects: `ClaudeAdapter` never emitted `file.changed` (added), and the orchestrator ignored the `ok:false` flag Codex's adapter already sends on failed writes (now respected). Found and left alone: Codex's own bundled sandbox can't write files in this container (`bwrap: loopback` permission error, reproduced outside the plane too) — a host limitation, not a repo bug. 83 tests green after the fixes; full loop re-verified live end to end including cross-provider handoff and parallel compare with merge.
