# Project Memory

Durable facts live above the first `##`. Below that is a log of outcomes, newest last.

Append a section only when a contract changed, a gate opened or closed, a defect was found that the code alone does not explain, or a decision was made that the next session would otherwise re-litigate. Give each new section a date and tag it `SHIPPED`, `PROPOSED` or `BLOCKED`; sections written before this rule carry neither and need not be back-filled. Do not record what the code, the tests or git history already say. Delete a section once it becomes wrong — stale memory costs more than none.

Never write credentials, provider transcripts, hostnames, tunnel ports or internal URLs here.

Plans and review logs are not kept in this file; it records outcomes.

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

## K1 durable dispatch implementation

- `feat/agentic-os-k1-durable-dispatch` starts at kernel-services `56cf244`; Orbital UI is a sibling and excluded.
- Newly created single-task time waits now have generation-aware durable dispatch, cancellation, boot reconciliation, immutable intent, pause kinds, routing at wake, and minimal waiting UI. API 2.1 adds scheduler-status reads under `schedules.read`.
- Migration 014 separates waits/dispatches/task-scoped scheduler events from provider run events. A missing fresh Harness session can safely re-park after its recovery window; missing legacy run evidence remains an explicit operator-reconciled ambiguity, never an automatic retry.
- K1 evidence: `docs/agentic-os-k1-implementation.md` maps all 12 acceptance criteria and records architecture corrections. Typecheck/lint/build passed; default tests core 70 / adapters 8 / API 475 / web 6, plus forced-Harness API 475.
- K2+ quota conversion/projection/probes, model/context services, runtime backends, and Composer remain deferred. This feature branch implements K1 in the canonical application; it does not create a duplicate product.

## K3 optional quota probes implementation

- `feat/agentic-os-k3-quota-probes` adds an opt-in idle quota probe (`scheduler.quotaProbe`, default off) whose results are `provider-api` observations in the K2 `QuotaProjection`, scoped to account and bucket.
- The Claude OAuth usage endpoint is implemented; every other provider returns `unsupported`. The Codex app-server rate-limits RPC stays unimplemented until it is verified against a running app-server — no placeholder data stands in for it.
- Credentials are read in memory from the provider's own file and used only as the request credential; probe outcomes carry a classified reason, never a response body, and a redaction test asserts the credential reaches no table, log or API read.
- Migration 016 adds `quota_probes` (attempts only) so the one-per-assistant-per-15-minutes window survives a restart and `GET /api/scheduler/status` can report probe freshness. A failed probe writes no observation and changes nothing.
- Probe attempts are recorded in the wait condition's `history` and never increment `auto_wakes`; wake revalidates the projection with a probe before deciding, so an exhausted window re-parks without a provider start.
- K3 evidence: `docs/agentic-os-k3-implementation.md`.

## Demo A: K1-K3 through the Orbital operator UI

- `feat/agentic-os-demo-a` reconciles the Orbital UI (`feat/agentic-os-orbital-ui@04cbfb5`) onto current `main` instead of replacing the shipped board: one primary experience, with K1/K2/K3 backend truth winning wherever the two disagreed.
- The Orbital inspector now reads persisted kernel state — wait kind/generation/next eligible time, quota blocker scope and provenance, checkpoint and continuation, dispatch phases, post-wake assistant identity, scheduler enablement and K3 probe freshness. The Context tab is `Implemented · K9`; `Planned` labels now point forward to K10 (provider-command compaction) and K11 (context yield / continuation).
- `pnpm demo:a` runs `apps/web/e2e/demo-a.spec.ts` against an in-process API with an injected clock and probe transport: deterministic, no provider credentials, no real quota consumption, with trace/video/screenshots kept under `apps/web/test-results/`.
- Operator runbook: `docs/demo/demo-a.md` (prerequisites, Oracle start, SSH tunnel, deterministic run, optional real-Claude smoke, artefact locations, deliberately unimplemented functionality).
- Defect found and fixed here: routing-side quota reads (`routeTask`, `Orchestrator.quotaPlan`) and `CooldownStore` used wall time while the scheduler ran on the injected kernel clock, so under a divergent clock fresh evidence read as stale and expired cooldowns read as live — a blocked assistant could be started at a wake. All of them now share the kernel clock, with a regression test in `apps/api/test/quota-probe.test.ts`.
- An API credential minted before K1 lacks `schedules.read`, so `GET /api/scheduler/status` answers 403 until `pnpm --filter @agent-plane/api rotate`.

## Orbital operator UI v2 (2026-09-07)

Visual/product redesign of the operator console on top of the merged K1-K3
semantics; no backend change. OS shell (rail: Orbital / Intake / Agents, system
health pill from `/api/scheduler/status`), command bar that routes a goal through
Intake, and an execution field whose rings are state groups and whose arcs are
kernel truth (wake horizon for waits, blocker arc for quota, beacon for human
input, drift for execution). Bodies ride the SVG orbit path via `offset-path`
with arc-length phases; `layoutBodies` keeps labels from overlapping and is
unit-tested. Inspector gained a decided / because / next strip derived by
`nextStep()`; tabs and Demo A selectors unchanged. Fonts: IBM Plex via
`@fontsource` (OFL). Reference captures: `pnpm --filter @agent-plane/web visual`.
Docs: `docs/ui/orbital-operator.md`.

## K7 model identity and catalog (2026-09-08)

- Requested vs served model identity are now two separate persisted facts:
  `runs.model_requested` (from `TaskIntent.overrides.model` via
  `ExecutionRequest.model`, CR-33) and `runs.model_resolved` /
  `model_resolved_source` (provider evidence only). Unknown is a valid answer and
  is never back-filled from the request, an alias, or the catalog.
- Only Claude reports a resolved model today (`system/init`); Codex, Cursor,
  Bedrock and OpenRouter report none, and the per-adapter evidence matrix is a
  test (`packages/adapters/test/model-evidence.test.ts`), not a sentence.
- `ModelCatalogService` merges provider-discovery, observed-run and manual price
  evidence by `EVIDENCE_PRIORITY`; availability is a JOIN onto provider discovery,
  never a second availability system. Refresh never throws and never blocks
  routing; external sources exist only as the `CatalogSource` seam for K8.
- Catalog identity is `(provider, model_id)`, exposed as `modelKey`. Model ids are
  not globally unique — Codex (`openai`) and Cursor both advertise `default` — so
  a bare id that several providers claim resolves to 409 with the candidates,
  never to an arbitrary provider.
- Merged catalog fields are `{ value, provenance }`: a gap filled by weaker
  evidence keeps that evidence's provenance instead of inheriting the entry's.
  `GET /api/models/:id` also returns the unmerged evidence rows.
- The catalog hydrates from local evidence on first read
  (`refreshLocalEvidence()`, no network), so a fresh workspace lists its models
  without a manual refresh; the pinned price snapshot keeps its transcription
  date (`PRICE_SEED_OBSERVED_AT`) and ages out even when refresh re-runs.
- `models.read` is new in `OBSERVABILITY_CAPABILITIES`, so credentials minted
  before this change get a fail-closed 403 on `/api/models` until
  `pnpm --filter @agent-plane/api rotate`.
- Catalog price evidence did NOT close standing deferral #3: bounded `maxCostUsd`
  is still rejected, with the five §4.4.5 gates named in the code and a negative
  test that grants proven usage reporting and still expects rejection.
- Evidence: `docs/agentic-os-k7-model-identity.md`.

## K9 context observation (2026-09-08)

- OBSERVATION ONLY. Nothing added compacts, prunes, yields, issues `/compact` or
  `/clear`, or starts a clean-session continuation. K10 (provider-command
  compaction), K11 (context yield / continuation) and K12 (Cockpit gauge) stay
  explicitly pending.
- Canonical `ContextObservation` and `ContextCapability` live in
  `packages/core/src/context.ts`. `buildContextObservation` computes `pressure`
  ONLY from `occupancy / effectiveWindow` when both are known and fresh — never
  from the advertised maximum or from token/cost accounting. Effective
  (provider-managed) window and advertised model maximum are stored and rendered
  as separate facts.
- `CapabilityManifest.context` (new, top-level, optional) carries honest tiers:
  Claude `provider-reported` occupancy + effective window via the Agent SDK's
  `getContextUsage` control request (`totalTokens` / `rawMaxTokens`), observes
  auto-compaction via `compact_boundary`; Codex/Cursor/Bedrock/OpenRouter
  `unavailable` (Codex `turn.completed` accounting is not occupancy). No adapter
  declares a `compact` control at K9.
- The Claude adapter forwards `compact_boundary` system messages as
  `context.compaction.observed` (`requestedByPlane: false` — the provider
  compacted, not the plane) instead of dropping them, and exposes
  `observeContext` off the live SDK query.
- `SessionRunner` samples context at a turn boundary (assistant `message`, or
  right after a witnessed `compact_boundary`) and records `context.observed` with
  a monotonic per-session `sequence`. A quota-only `usage.updated` produces no
  observation; an `unavailable`/`null` sample records nothing (no fabricated
  number). Recovery never fabricates an observation.
- `GET /api/tasks/:id/context` (`context.read`, new in
  `OBSERVABILITY_CAPABILITIES` — pre-K9 credentials fail closed 403 until
  rotated) returns the latest truthful state via `apps/api/src/modules/context.ts`:
  KNOWN (occupancy + window + source + freshness, pressure only when valid) or
  UNAVAILABLE. A terminal session or an observation older than 45s renders
  `stale` and drops pressure. The legacy execution path returns UNAVAILABLE with
  reason `legacy execution path` — no synthesised parity.
- K7 integration: `advertisedMaxTokens` falls back to the catalog
  `contextWindowTokens` ONLY when the resolved model id is known; a catalog
  maximum is never turned into an effective managed window.
- Web: the Orbital inspector Context tab is now `Implemented · K9` and renders
  the KNOWN / partial (tokens, no %) / UNAVAILABLE / stale states with a
  method chip, freshness, a separate advertised-maximum line, and provider
  auto-compaction shown as "Observed". Context events flow over the existing
  SSE/event stream — no new streaming subsystem.
- Real-provider smoke (Claude CLI login): `observeContext` returned
  `totalTokens` occupancy against a `rawMaxTokens` effective window, both
  `provider-reported`; no `compact_boundary` in a short run. No transcript
  committed.
- Evidence: `docs/agentic-os-k9-context-observation.md`.


## Orbital UI V3 convergence (2026-09-13)

- UI-only evolution from PR #38 in `feat/agentic-os-ui-convergence-v3`: Agentic OS
  product rail, prominent preview-before-run composer, real kernel overview,
  scoped activity/attention and a compact mission summary beside the semantic
  field. Complete inspector evidence follows below; no backend controls removed.
- Blue/violet visual system with solid ACTUAL and dashed amber SHADOW. SVG depth
  and constellation-aware mission placement preserve canonical state rings.
  Unknown/loading/stale reads remain explicit; no provider availability or
  product destinations are invented. Memory/Tools/Settings navigation stays out.
- Existing visual harness is restored as `pnpm --filter @agent-plane/web visual`.
  Audit, captures, validation and P2 limits: `docs/ui/agentic-os-ui-v3.md`.
- Protected K5 worktree, scheduler implementation, K13 activation policy and
  production auth/bootstrap code are unchanged by this slice.


## K12/K14 reconciliation (2026-09-14)

- K12 presentation already shipped through K9 in apps/web and Cockpit #37
  (`ec1569a`). K14 already shipped through K7/K8 and Cockpit #38 (`833d420`),
  including the durable offline snapshot and shared Usage/Retro resolver.
- Current closure adds only bounded web presentation: latest-session identity,
  supplied-pressure rendering, truthful K11 status, catalog loading/unknown
  states and each price's own source/date. No service, schema or policy change.
- **K12 PARTIAL overall:** kernel-services §5.2.4's real-provider warning-pressure
  scenario is not proved by the recorded short K9 smoke or scripted tests.
  **K14 COMPLETE.** Do not reopen completed implementation as new packages.
- Matrices, evidence and validation: `docs/agentic-os-k12-k14-closure.md`.
  Older slice notes above are historical, not current pending-work lists.

## Conversational shell (2026-09-17)

Git metadata supersedes old worktree descriptions above. Shell work starts at
remote main `6a0eb55`, preserving K5, K12/K14 and Codex runtime fixes. Canonical
product architecture and verified capability matrix: `docs/ui/agentic-os-ui-v3.md`.
The control-plane React app owns the seven-destination shell; Cockpit retains
durable memory, installed tooling and machine-global writes. Task input currently
accepts approvals only; do not claim arbitrary conversational continuation.

Shell implementation: URL-backed seven-application navigation, inline goal and
route preview, selected-mission messages and durable approval controls, in-memory
draft retention, and explicit backend gaps. No generic follow-up delivery is
claimed. Existing K12 live closure on 2026-09-15 remains valid; older PARTIAL
headers describe historical checkpoints.

Final shell acceptance (2026-09-18): full control-plane unit/integration suite
1,078 passed; final web 49 passed; 34 browser checks passed across final bounded
runs; Cockpit 1,401 passed. Screenshot index and exact validation scope are in
`docs/ui/agentic-os-ui-v3.md`. Failed task reads freeze orbit motion; re-entering
Overview clears paused snapshots before refresh. Input delivery remains the next
backend slice; seven destinations do not imply seven fully implemented apps.


## Shell preservation review (2026-09-18)

Revalidated the existing conversational-shell branch before standalone work.
Failed selected-task reads now clear provider participation; initial loading/failed
task reads no longer present an empty register. Agents explains that its input
flag does not prove text delivery. Canonical findings, exact suite outcomes and
22 fresh deterministic captures are indexed in `docs/ui/agentic-os-ui-v3.md`
and `docs/ui/assets/shell-review/README.md`. Cockpit ownership remains at
`a45a750`; its runtime and existing dirty worktrees were not modified.

## 2026-09-22 — M16 K19a: the decision no-basis contract (PROPOSED)

`RulesDecisionProvider` now maps `(site, questionKey)` rather than `site` alone. The previous
site-only switch returned the same answer for every question asked at a site — harmless while each
site asked one question, wrong as soon as K19's tool-gate battery asks several.

The contract that falls out, and that K19 must honour when it wires the gate: **`decide()` answers
only the keys a provider has a basis for, and an absent key means "no basis"** — never `false`,
never `0`, never `none`. `DecisionAnswer` deliberately has no `unknown` variant and
`DecisionOutcome` carries no separate unanswered set; absence is the encoding, and
`noUncheckedIndexedAccess` (on repo-wide) makes the compiler force every caller to handle it. Per
I-D2 a caller must resolve an absent answer to its site's conservative outcome — for the tool gate,
prompt the operator. A key a provider *does* map, asked with the wrong primitive, still throws:
that is a malformed request, not an unanswerable one.

Consequence worth knowing before reading any shadow report: with only the rules provider
registered, the tool-gate battery comes back with `denied` answered and `risk`, `destructive`,
`outside_repo`, `exfiltration` and `credential_reach` absent. The §7.2 prompt-injection suite
(`apps/api/test/decision-injection.test.ts`) therefore asserts a property of absence today. It is a
real regression guard on the mapping and the contract, and it is not yet a measurement of injection
resistance; it becomes one, with no edits to that file, once `decisionProviders()` registers a
provider that can judge risk.

Two errors in `plans/jev-decision-service-plan.md` were corrected rather than worked around, both
noted in its §11:

- §5 K18 and the §9.3 step table named `pnpm demo:a` as the acceptance vehicle for decision
  records. `demo-a.spec.ts` never sets `execution.harnessModes.single`, so it runs the legacy
  orchestrator path, which has no tool gate and records nothing; `demo-b.spec.ts` does set it.
- The §5 K19 battery listed five questions, none of which the rules provider can answer — which
  contradicts K18's requirement that the rules answer be recorded on every call "so a shadow
  comparison always has a baseline". `denied` is now the battery's first key.

## 2026-09-22 — M16 K19b: the decision state boundary (SHIPPED)

`buildToolGateState()` in `packages/core/src/decision.ts` is §4.4's `DecisionStateBuilder`. The
rule that shaped it: no field survives that no battery question reads. Applying that rule deleted
the entire content surface — every question in `TOOL_GATE_BATTERY` (`denied`, `risk`,
`destructive`, `outside_repo`, `exfiltration`, `credential_reach`) is answerable from the action,
so the state carries the action, the policy tool lists, path counts, path samples, network
destinations and a trust flag, and nothing else. There is deliberately no field for a README
excerpt, a source comment, a test fixture, a commit message, prior tool output or the task goal.
That is not an omission to be filled in later: §4.4's rule is that a question a sentence in a
README can flip is a question we do not ask, and `rm -rf` is not less destructive because the goal
text says so. A later slice that wants one of those fields must first name the question that reads
it.

Trust is Junie's model and it is fail-closed in both directions that matter: a repo absent from
`repoAllowlist` — and equally a repo that is simply unknown, or an empty allowlist — is UNTRUSTED,
and an untrusted repo contributes only the structural facts (`pathsInside` / `pathsOutside` /
`repoTrusted`). Path samples are withheld entirely, because a filename is attacker-chosen content.
The action itself is never trust-gated: withholding it for an untrusted repo would blind the gate
exactly where it is most needed.

Order inside the builder is load-bearing and easy to get wrong: **redact → trust-gate → bound**.
Redacting first means no secret survives by straddling a truncation boundary; trust-gating before
bounding means untrusted content is dropped rather than merely shortened. Truncation is fixed caps
in a fixed order, so the same observation always produces the same bytes and the same flag, and the
flag now reaches `decision_records.state_truncated` through `DecisionRecordContext.stateTruncated`
— K18 hardcoded that column to 0 because no bounded state existed yet.

The composition seam (`observeToolGate`) now builds its state with the builder and asks the full
six-question battery instead of an inline one-question state. It cannot see paths, network
destinations or the repo path — it fires on `tool.started` and carries only the policy inputs — so
production rows read `repoTrusted: false` with zero path counts until K19c moves the evaluation
ahead of execution and widens the seam. That is the honest reading of what the seam observes, not a
defect.

One invariant was missing from the plan and is now §5 K19 (I-D8), with a §11 note: the gate must
REFUSE to activate (`mode: applied`) at a site whose provider chain holds no judging provider. With
rules alone, five of six answers are absent, absence resolves conservatively, and activation would
turn every rules-allowed tool call into an operator prompt — the inverse of the intent, and the
fastest way to get the gate switched off. §7.1's seven activation preconditions are evidence
checks; this eighth one is structural, and K19c cannot be reviewed without it.
