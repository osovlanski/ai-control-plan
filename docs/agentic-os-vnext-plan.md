# Agentic OS — vNext Enhancement Plan

**Status:** Proposed — revision 6 (planning only; no production implementation in this pass)
**Review:** `docs/agentic-os-vnext-review-log.md` (Codex adversarial review, rounds 1–4, plus an independent cold review of revision 5 — `docs/agentic-os-vnext-review-log.md`)
**Date:** 2026-09-03
**Reconciled against:** `ai-control-plan` `main@37066e9`, `cockpit` `main@f17bd1b`
**Verified baselines:** ai-control-plan `pnpm typecheck && pnpm test` → core 70 / adapters 8 / api 378 / web 3, exit 0. cockpit `npm test` → 1296 pass / 0 fail, exit 0.

## 0. Why this document exists

The architecture for this program is **already written and already good**:

- `docs/operator-observability-verification.md` — boundaries, multi-repository identity, verification planning, evidence model, telemetry, external-tool verdicts.
- `docs/operator-observability-verification-implementation-plan.md` — slice ordering H0A→H0B→H1→H5A–H5D→H6→C1–C4→T1.
- `docs/execution-harness.md` (rev 7) + `docs/harness-implementation-plan.md` — Harness lifecycle and phase sequence.
- `docs/harness-implementation-progress.md` — Phase 0–8e evidence and standing deferrals.
- `cockpit/docs/specs/E-agentic-os-role.md` — Cockpit as registry/package-manager plus operator UI.

This document is a **reconciliation plus a small set of targeted architecture amendments**. It
restates none of the prior design and replaces none of it wholesale. It does four things the
existing set cannot do, because they postdate it:

1. **Reconcile** the plan's baseline (`main@88e03e7`) with what has since merged (`main@37066e9`).
2. **Record three defects/risks found by inspecting the running code**, not the design.
3. **Name the capability gaps that no current document owns** — decomposition and progress.
4. **Re-order the roadmap** around the fact that the Harness is dark code behind a default-OFF flag.

### Amendments to prior accepted design

Everything not listed here is **accepted unchanged**, and where this document is silent the prior
documents remain authoritative. These five points *do* change accepted design and are called out
up front rather than buried:

| # | Amendment | Supersedes | Where |
|---|---|---|---|
| A1 | Remove `CockpitEventSink`; Cockpit consumes canonical durable reads, never a telemetry push path | `operator-observability-verification.md` §9 sink list | CR-11 |
| A2 | One Control-Plane planning service owns the initial plan and every revision (was two entry points) | current implementation, not a document | CR-7 |
| A3 | Pre-execution repository inspection moves behind a read-only `RepositoryInspector` port with a **neutral-infrastructure** adapter; `WorkspaceAuthority` keeps writes and command execution and stays a Harness adapter | current implementation | CR-7, CR-13 |
| A4 | Authenticated transport becomes a precondition of the whole API, not just the command surface, **and read/write capabilities are independently grantable now** | `operator-observability-verification.md` §8.1 (`commands.write` "separately authorized") **and `cockpit/docs/specs/E-agentic-os-role.md:22`, which defers the read/write split until a multi-user or non-loopback deployment** | CR-12 |
| A5 | Parent partial-success is a **verdict field**, never a new `TaskState`; the 9-state task machine is untouched | implied by §3 of this document | CR-14 |
| A6 | Ephemeral per-run profiles are materialized, retained and disposed by the **Harness** through `WorkspaceAuthority`; the Control Plane selects and passes content or references but writes no files | `cockpit/docs/specs/E-agentic-os-role.md` line 14 ("the control plane only ever writes ephemeral per-run overlays inside task worktrees") and M9 ("The control plane validates paths and writes the returned content into its own profile") | CR-15, increment 5 |

---

## 1. Current implementation — verified

`ai-control-plan` is ~13.6k LOC of TypeScript across `packages/core`, `packages/adapters`,
`apps/api`, `apps/web`, with 12 SQLite migrations.

| Capability | Status | Evidence |
|---|---|---|
| Task state machine (9-state, Control-Plane only) | IMPLEMENTED | `packages/core/src/state-machine.ts` |
| Deterministic routing + persisted explanation | IMPLEMENTED | `apps/api/src/modules/router.ts`, `routing_decisions` |
| Provider adapters (claude, codex, cursor, bedrock, openrouter, fake) | IMPLEMENTED | `packages/adapters/src/` |
| Control Plane ↔ Harness contract, request fingerprint | IMPLEMENTED | `packages/core/src/execution.ts`, `fingerprint.ts` |
| Execution session state machine (12 states) | IMPLEMENTED | `packages/core/src/session-state.ts` |
| Durable sessions/events/approvals/checkpoints | IMPLEMENTED | `harness/session-store.ts`, `event-recorder.ts`, `checkpoint.ts`, migrations 005–007 |
| Guards (budget/timeout/tool/approval/quota) | IMPLEMENTED | `harness/guards.ts`, `approval-service.ts` |
| Workspace Authority + SecretBroker + isolation tiers | IMPLEMENTED | `harness/workspace-authority.ts`, `secret-broker.ts` |
| Handoff envelopes + claim protocol | IMPLEMENTED (unwired) | `harness/handoff.ts`; standing deferral #7 |
| Crash recovery / lease fencing / directive replay | IMPLEMENTED | `harness/recovery.ts`, `test/harness/{recovery,fault-injection}.test.ts` |
| Observability API 1.1 (`sessions.read`/`verification.read`/`approvals.read`) | IMPLEMENTED | `packages/core/src/contracts.ts`, `server.ts` |
| Workspace/Repository/Worktree identities + registry | IMPLEMENTED | `core/repository-identity.ts`, `repo/identity-registry.ts`, migration 009 |
| Stable `ExecutionTarget` persistence | IMPLEMENTED | migration 010, `execution.ts` `ExecutionTarget` |
| Verification/evidence vocabulary (4-state checks, 12 artifact kinds, `EvidenceBundle` as projection) | IMPLEMENTED | `core/events.ts`, `core/execution.ts` |
| Deterministic `VerificationPlanner` (+ revise) | IMPLEMENTED | `core/verification-planner.ts` |
| Verifier provider registry | IMPLEMENTED | `harness/verification-providers.ts` |
| Project-native capability discovery | PARTIAL | `modules/project-verification.ts` — root `package.json`, `test`/`typecheck`/`lint` only |
| Durable verification plan/run lifecycle + recovery + API | IMPLEMENTED | `harness/verification-store.ts`, `verification-coordinator.ts`, migrations 011–012 |
| **Harness as the live execution path** | **DESIGNED_ONLY in default config** | `config.ts:81` `harnessSingleMode: false` |
| Harness parity for parallel / compare / race | MISSING | `orchestrator.ts:134-139` — `harnessRouting()` returns false for all three |
| `ApiVerifier` (H5C) | MISSING | no provider beyond `CommandVerifier` / `ArtifactExistsVerifier` |
| `BrowserVerifier` / Playwright (H5D) | MISSING | same |
| `TelemetrySink` (T1) | MISSING | `modules/telemetry.ts` is local scoring, not a sink |
| Task decomposition / subtasks | MISSING | no entity, no service, no table |
| Authenticated API / command authorization | MISSING | no auth middleware in `server.ts`; loopback bind is the only control |
| Artifact blob store + GC | MISSING | `ExecutionArtifact.retention` is contracted; `modules/retention.ts` archives events only |
| Progress model | PARTIAL | `TaskEnvelope.completed`/`remaining` + rendered `progress.md` exist; no durable hierarchical model |

`cockpit` is a ~30.7k LOC loopback operator dashboard: agent monitor with provider-neutral
normalized events and explicitly-labelled inferred phases (`agents.ts`), Claude hook ingest
(`agentmonInstall.ts`, `hooksInstall.ts`), Codex rollout ingest (`codexSource.ts`), PTY attach
(`pty.ts`), assistant tooling install/registry (`install.ts`, `catalog.ts`, `mcp.ts`), memory,
lineage, context compiler, discovery, and a 3-endpoint read-only Agentic OS client
(`controlPlane.ts`).

---

## 2. Harness phase status

Phases 0–8e are merged and green. Detail and per-phase evidence live in
`docs/harness-implementation-progress.md`; that table is not restated here.

| Phase | Status | Note |
|---|---|---|
| 0 Contracts + invariants | IMPLEMENTED | Extended twice since (H0A, H0B) |
| 1 Minimal CP→Harness→Adapter | IMPLEMENTED | behind flag |
| 2 Lifecycle + persistence + checkpoints | IMPLEMENTED | |
| 3 Approval / permissions / budgets / guards | IMPLEMENTED | bounded *cost* caps still rejected (deferral #3) |
| 4 Provider-neutral handoff | PARTIAL | envelopes built and tested; claim protocol unwired (deferral #7) |
| 5 Verification / evaluation | PARTIAL | planner + registry + lifecycle done; API and browser verifiers missing |
| 6 Cockpit observability | PARTIAL | producer at API 1.1; consumer still on 1.0 and **currently broken** (§3.1) |
| 7 Recovery / concurrency / idempotency | IMPLEMENTED | |
| 8 Remote runners | NOT STARTED — correctly | contracts carry the keys; no real remote use case |
| 8a–8e Orchestrator cutover | IMPLEMENTED, DEFAULT OFF | the value blocker (§3.3) |

**No external tool changes any of these phases.** Playwright and Postman are candidate
`VerificationProvider` implementations inside Phase 5's existing registry. Langfuse is a
candidate `TelemetrySink` in T1. AgentTrail and CCAM touch nothing in this list.

---

## 3. Findings from the running code

### 3.1 CRITICAL — the configured Cockpit client cannot negotiate the current API

`cockpit/controlPlane.ts:37` throws when `meta.apiVersion !== "1.0"`. The Control Plane serves
`"1.1"` (`packages/core/src/contracts.ts:5`). Any Cockpit instance with `CONTROL_PLANE_URL` set
therefore fails closed on every Agentic OS route (`/api/control-plane/{status,tasks,tasks/:id/events}`)
and reports `connected: false`.

Scope note: the integration is optional and there is no evidence it was ever running against a
1.1 plane, so this is a latent incompatibility rather than a regression of a working deployment.
It still blocks every downstream Cockpit slice.

The intent was fail-closed on *incompatible* versions; the implementation fails closed on
*additive* ones, contradicting the H6 acceptance criterion "tolerate additive fields". The fix is
**not** an ad-hoc major-string comparison: it is a normative, tested compatibility policy —
same major required, client minor ≤ server minor accepted, unknown fields ignored, feature
availability decided by the existing capability list and never by version arithmetic. The policy
belongs in the contract document, with the client and a producer fixture both testing it.

### 3.2 HIGH — the design corpus is tracked but not yet merged to canonical main

**Restated 2026-09-03 after this defect was partly repaired.** As originally found, five documents
— `execution-harness.md`, `harness-implementation-plan.md`, `harness-review.md`,
`operator-observability-verification.md` and
`operator-observability-verification-implementation-plan.md` — were **untracked files in one local
worktree**, cited as the normative source for ~13.6k merged LOC. `git log --all --` returned
nothing for them.

They are now tracked: commit `4d1b150` on branch `docs/agentic-os-vnext` (PR #18) adds all five
plus this plan and its review log, and repoints two references that named the sibling worktree by
path. `git log --all -- docs/execution-harness.md` is therefore no longer empty.

The residual defect is narrower and still real: **the corpus is on a branch, not on `main`.** Until
that PR merges, canonical main still cites a source of truth it does not contain, and the untracked
copies in the worktree remain the ones people edit. Increment 1b is consequently a *merge and
reconciliation* task, not a rescue.

### 3.3 HIGH — the Harness is dark code

`config.ts:81` defaults `execution.harnessSingleMode: false`. With the flag OFF the Orchestrator
drives adapters directly and **no verification planning runs at all** — the coordinator, planner,
provider registry, plan revisions and verification lifecycle are only reachable from the flag-ON
branch (`orchestrator.ts:299–323`). Phases 1–8e and the whole H5 track currently deliver zero
operator-visible value.

This inverts the roadmap's priorities: shipping H5D Playwright behind an OFF flag adds capability
nobody can observe. **The eval program and the flag flip are the value-unlocking increment and
must come first.** `docs/agentic-os-eval-plan.md` already specifies that program.

### 3.4 HIGH — two live execution paths, and the Harness covers only one execution mode

`orchestrator.ts` (1260 LOC, legacy adapter-driving) and `harness/session-runner.ts` (1295 LOC)
both execute tasks. This is the intended strangler shape, but two facts make it a harder problem
than "flip the flag and delete the old branch":

1. The flag never flips, so the duplication is currently permanent (§3.3).
2. **`harnessRouting()` returns `false` for `parallel`, `compare` and `race`**
   (`orchestrator.ts:134-139`). Even with the flag ON, those three modes still run on the legacy
   adapter-driving path. The Harness has parity for **single mode only**.

Consequence for sequencing: the legacy execution path **cannot** be deleted after a single-mode
eval, because three execution modes still depend on it. Retiring it requires a Harness parity
slice for the remaining modes first — and the flag flip must be scoped per mode, not global.

### 3.5 MEDIUM — the Control Plane does not decompose

The goal for the Control Plane names intake, extraction, **decomposition**, subtask
classification and capability matching. What exists is one task → one route → one execution.
There is no Mission/Goal/Subtask entity, no decomposition service, no subtask table.
`parentTaskId` / `groupId` (migration 007) are correlation columns **with no producer** — nothing
in the Control Plane ever writes a parent/child relationship.

Consequences: the multi-repository target in the architecture ("one parent task owning
repository-scoped subtasks") is representable but unreachable; and no progress model can have a
denominator.

### 3.6 MEDIUM — progress exists, but only as a flat rendered artifact

`TaskEnvelope.completed` / `remaining` (`core/task.ts:61-62`) and the rendered
`GET /api/tasks/:id/files/progress.md` (`server.ts:536`, `render/progress.ts`) already give a
task a coarse done/todo list. What does not exist is a durable, hierarchical, queryable model —
so nothing can express "6 / 8 subtasks complete" across repositories, and Cockpit has nothing
structural to render.

The envelope lists stay as a **rendered projection for the handoff prompt**. They are not
promoted to canonical progress and are not deleted; once subtasks exist, the projection derives
from them.

### 3.7 MEDIUM — native discovery loses verification-kind classification

`project-verification.ts` reads the root `package.json`, accepts `test`/`typecheck`/`lint` only,
and requires exactly one recognized lockfile. Measured against the sibling repositories:

| Repo | Root scripts found | Gap |
|---|---|---|
| `cockpit` | test, typecheck | none |
| `zuzim` | test, lint | none |
| `pocketknife` | test | none (custom runner works) |
| `scramble-stack` | test, lint | see below; no root `typecheck` |

Correction to an earlier draft of this document: `scramble-stack`'s root `test` is
`npm test --workspaces --if-present`, which **does** reach the `e2e` workspace, so its Playwright
suite is not invisible and would in fact run. The real defects are narrower and both matter:

1. **Lost classification.** That Playwright run is reported as `kind: "tests"`. The planner
   cannot know browser verification happened, cannot mark the `browser` requirement met, and
   cannot attach `browser_report` / `screenshot` evidence to it.
2. **Double execution risk.** Once a `BrowserVerifier` is added, a repository whose root `test`
   already invokes Playwright would run the browser suite twice unless discovery detects the
   overlap.

`scramble-stack/e2e/playwright.config.ts` + `@playwright/test` is therefore in-repo evidence for
both the "prefer the project's native suite" rule *and* the need for workspace-aware,
kind-classifying discovery before H5D.

### 3.8 CRITICAL — the command boundary is unauthenticated

`apps/api/src/server.ts` installs **no authentication or authorization hook**. The only control is
the loopback bind (`config.ts:68` `host: "127.0.0.1"`). Loopback restricts which *hosts* can
connect; it does not authenticate which *local process* did. Task creation, cancellation and
approval responses are already mutating endpoints reachable by any local process.

Cockpit's own Spec E (`docs/specs/E-agentic-os-role.md:16`) states the rule plainly for the
mirror-image direction: "Registry and postback APIs are versioned and authenticated even on
loopback — one bearer token (or Unix socket) for this single-user machine; loopback placement
alone is not authentication." The Agentic OS side has not applied its own counterpart rule.

This is load-bearing for vNext: the target architecture adds a `commands.write` capability so
Cockpit can drive managed tasks. **No write capability may ship before an authenticated
transport exists**, and the read surface should be authenticated in the same slice rather than
retrofitted afterwards.

### 3.9 MEDIUM — artifact retention is contracted but has no runtime

`ExecutionArtifact` carries `retention: ephemeral | session | task | pinned`, `digest`,
`mediaType`, `sizeBytes` (`core/execution.ts`). Nothing enforces any of it:
`verification-store.ts:90` sanitizes the metadata on the way in, and `modules/retention.ts`
archives **events** only. There is no blob store, no quota, no expiry job, no pin authorization
and no orphan recovery.

Browser verification is the first producer of large binary evidence (screenshots, traces,
video). Shipping it onto a contract with no lifecycle behind it puts unbounded growth in the
workspace. The store must precede the producer.

### 3.10 LOW — workspace hygiene

`git worktree list` shows 11 slice worktrees whose branches are all merged into `main`, plus two
stale documentation worktrees (`ai-control-plan-agentic-os`, `cockpit-agentic-os`) hundreds of
commits behind their mains. `cockpit-agentic-os` is a full second checkout of a 30k-LOC repo.

This is developer-environment housekeeping, **not** a product gate, and it is locally
destructive. It is explicitly separated from §3.2 (which is a real risk) and requires owner
confirmation before any removal.

---

## 4. Conflict and overlap decisions

Format per §13 of the request. Prior decisions already recorded in `docs/DECISIONS.md` and
`docs/operator-observability-verification.md` §10 are **carried forward unchanged** and listed
here only where this pass adds a migration path.

### CR-1 — Cockpit repository vs Agentic OS repository
- **A:** `cockpit` (separate product, own release cadence, own privileged local scope).
- **B:** merging Cockpit into `ai-control-plan`.
- **Decision:** **KEEP_A** — keep separate, integrate through the versioned contract.
- **Reason:** Cockpit is independently useful (assistant tooling registry, ad-hoc session
  observation, memory/lineage) with 1296 of its own tests and no Agentic OS dependency; Agentic
  OS must stay headless for CI/remote use. Merging couples release cadence and joins two
  high-privilege local surfaces. Cockpit additionally holds a *load-bearing producer* role, not
  just a consumer one: Spec E makes it the machine-global assistant-tooling registry the Composer
  reads from and the sole writer of `~/.claude` / `~/.codex` / `~/.cursor`. A merge would put that
  privileged writer inside the execution engine's process boundary.
- **Not the reason:** line counts. An earlier draft cited "only 63 of 30.7k LOC touch the Control
  Plane"; that argues for separate *deployables*, not separate *repositories*, and is withdrawn as
  deciding evidence.
- **Cost this decision accepts:** two-repo contract coordination. It is only safe with the
  compatibility policy of §3.1 made normative, published producer fixtures, a stated support
  window for older clients, and a coordinated release test that runs both sides together. Those
  are deliverables of increments 1 and 4, not assumptions.
- **Migration:** none. Delete the stale `cockpit-agentic-os` worktree (CR-6, owner-confirmed).

### CR-2 — Cockpit inferred phases vs Agentic OS lifecycle states
- **A:** Cockpit `Phase` (`DISCOVERY…COMPLETED`) with `{source, confidence}` (`agents.ts:73–87`).
- **B:** Agentic OS `TaskState` (9) + `ExecutionSessionState` (12).
- **Decision:** **KEEP_A and KEEP_B as distinct vocabularies.** Never map one onto the other.
- **Reason:** A is a best-effort inference over hook traffic for sessions Agentic OS did not
  launch; B is canonical. Cockpit already models the honesty correctly. Collapsing them would let
  an inference masquerade as canonical state — the exact failure the architecture forbids.
- **Migration:** UI must visually separate Managed from Observed (slice C2). No data change.

### CR-3 — `agents-state.json` snapshot vs durable observed-session store
- **A:** one JSON snapshot (`server.ts:191`).
- **B:** append-only SQLite/WAL with provider/source-qualified ids and cursors.
- **Decision:** **REPLACE_A_WITH_B** (existing slice C3), **learning from CCAM's schema, not
  depending on it**.
- **Reason:** a whole-file snapshot cannot express cursors, retention or multi-source identity,
  and loses history on corruption.
- **Migration:** dual-write, then read from SQLite, then drop the JSON. Rebuildable from hooks if
  migration fails, so no backfill risk.

### CR-4 — Legacy Orchestrator execution vs SessionRunner execution
- **A:** `orchestrator.ts` adapter-driving path (default; sole path for parallel/compare/race).
- **B:** `harness/session-runner.ts` (flag-ON; single mode only).
- **Decision:** **REPLACE_A_WITH_B**, but only after B reaches parity on every execution mode.
  Not after a single-mode eval.
- **Reason:** B is strictly more capable (durable sessions, recovery, guards, verification) and A
  is the only thing keeping verification unreachable. But `harnessRouting()` excludes three modes
  (§3.4), so deleting A on single-mode evidence alone would delete the only implementation of
  parallel, compare and race.
- **Migration:** per-mode strangler. (i) eval + enable single mode; (ii) soak; (iii) build and
  eval Harness parity for compare/race/parallel, and wire the handoff-envelope claim protocol
  (standing deferral #7); (iv) only then delete A's execution branch, remove `harnessSingleMode`
  as a branch point, and rename `Orchestrator` → `ControlPlane` (deferral #5) in a separate
  no-behaviour-change commit. The four safety-net test files stay green until step (iv).
  Rollback at any step must preserve in-flight sessions: a disabled mode reverts to the legacy
  path for *new* starts only, while existing Harness sessions run to terminal state under
  `HarnessRecovery`.

### CR-5 — Cockpit `ControlPlaneClient` vs a new managed client
- **A:** existing `controlPlane.ts` (API 1.0, read-only, loopback-guarded).
- **B:** a second, richer managed client for API 1.1+.
- **Decision:** **KEEP_A, upgraded in place** (as slice C1 already says).
- **Reason:** A already owns loopback normalization and capability gating. A second client would
  duplicate the trust boundary.
- **Migration:** fix the version check first (§3.1, P0), then add typed reads incrementally.

### CR-6 — Documentation worktrees vs canonical repositories
- **A:** `ai-control-plan-agentic-os` + `cockpit-agentic-os` worktrees.
- **B:** docs committed on branches of the canonical repositories, then merged to `main`.
- **Decision:** **REPLACE_A_WITH_B**, then **REMOVE** A. Partly executed: `4d1b150` / PR #18.
- **Reason:** §3.2 — untracked normative design. Also removes two stale code checkouts.
- **Migration:** commit the untracked docs (plus this one and the review log) to a branch off
  current `main` and merge. Worktree removal is **separate and optional** — developer-environment
  housekeeping, locally destructive, gated on explicit owner confirmation, and never a delivery
  gate (§3.10).

### CR-7 — Two verification-planning entry points
- **A:** `Orchestrator` calls `planProjectVerification()` pre-execution (`orchestrator.ts:299`).
- **B:** `VerificationCoordinator.prepare()` re-discovers and revises post-execution
  (`verification-coordinator.ts`).
- **Decision:** **MERGE** into one Control-Plane planning service owning the initial plan and
  every revision.
- **Reason:** plan-then-revise is the right *lifecycle*, but it does not need two *code paths*
  building plans from the same snapshot. Two constructors are two places for policy to drift.
- **Migration:** extract the single planner service; both current callers use it; the coordinator
  keeps sole ownership of revision persistence. No schema change — revisions already live in
  `verification_plan_revisions`.
- **Correction, revision 3:** revision 2 argued that routing discovery through
  `WorkspaceAuthority` was not an ownership problem. That defence was wrong and is withdrawn. The
  incoherence is real and visible in the code: `VerificationCoordinator` documents itself as
  "Control-Plane authority" while taking a Harness-owned `WorkspaceAuthority` in its constructor
  (`verification-coordinator.ts:56-66`). Control-Plane selection logic depending on a concrete
  Harness security component is a reverse dependency across the boundary, whatever the comment
  says. See CR-13 for the resolution.

### CR-8 — `EvidenceBundle` vs `ExecutionResult` + `ExecutionArtifact`
- **Decision:** **already resolved and implemented** — `EvidenceBundle` exists in
  `core/execution.ts` explicitly commented "Read projection only; canonical state remains
  EvaluationResult + ExecutionArtifact." No action.

### CR-9 — Cockpit workflow phases vs an AgentTrail PLAN.md component map
- **Decision:** **KEEP_A** (Cockpit), **REJECT** the PLAN-file concept as canonical state.
- **Reason:** a repository-local `PLAN.md` is a per-repo artifact a human or agent edits; making
  progress depend on it makes canonical state editable by the thing being measured.
- **Migration:** none. AgentTrail deep links may appear in Cockpit later without ingestion.

### CR-10 — Artifact retention contract vs no artifact runtime
- **A:** `ExecutionArtifact.retention` / `digest` / `sizeBytes` metadata (contracted, sanitized).
- **B:** no store, no quota, no expiry, no pin authorization (`modules/retention.ts` does events only).
- **Decision:** **BUILD B to match A** — one `ArtifactStore` that is the **sole lifecycle owner**,
  with GC exposed as one of its operations. The existing retention job only *schedules* that
  operation; it does not own blob lifecycle. (Revision 3: revision 2 named two owners here, which
  contradicted the matrix.)
- **Reason:** §3.9. A contract with no runtime is worse than no contract: it invites producers to
  believe retention is handled.
- **Migration:** store + GC land before the first large-binary producer (BrowserVerifier).
  Existing artifacts are refs only, so there is nothing to backfill.

### CR-11 — `CockpitEventSink` vs Cockpit reading canonical durable events
- **A:** a `CockpitEventSink` telemetry sink pushing to Cockpit
  (listed in `operator-observability-verification.md` §9).
- **B:** Cockpit consuming the canonical durable reads and SSE it already has.
- **Decision:** **KEEP_B, REMOVE_A.** This is a **proposed amendment to the prior architecture
  document**, not a restatement of it.
- **Reason:** canonical events already have a versioned read API with cursors. A second push path
  to the same consumer duplicates ordering, retry, dedup and reconciliation semantics, and blurs
  the telemetry/canonical line the same document is careful to draw everywhere else.
  `TelemetrySink` should exist only for genuinely external trace backends.
- **Migration:** none — neither exists yet. Update §9 of the architecture document when this plan
  is accepted.

### CR-12 — Loopback bind vs authenticated transport
- **A:** loopback bind as the only access control (`config.ts:68`).
- **B:** authenticated transport (bearer token or Unix socket) as Spec E already requires of Cockpit.
- **Decision:** **REPLACE_A_WITH_B** for the command surface, and adopt B for reads in the same
  slice. A remains as defence in depth, never as the control.
- **Reason:** §3.8. Loopback authenticates a host, not a process. Agentic OS has not applied the
  rule its own companion spec states.
- **Migration:** add the transport with reads authenticated behind a config default that keeps
  the current single-user local flow working (generated token on first run, surfaced to Cockpit's
  config), then gate `commands.write` on a separate capability. No write capability ships before it.

### CR-13 — Who may inspect a repository before execution
- **A:** `WorkspaceAuthority` (Harness-owned) doing bounded reads *and* command execution, called
  by Control-Plane planning code.
- **B:** Control-Plane planning reaching the filesystem directly.
- **Decision:** **ADAPTER**, in three parts:
  1. a read-only `RepositoryInspector` **port owned by the Control Plane** — bounded reads,
     containment proof, size caps, no writes, no command execution;
  2. its concrete filesystem adapter living in **neutral infrastructure**, owned by neither layer;
  3. the pure containment / path-validation primitives extracted and **shared** by that adapter
     and `WorkspaceAuthority`, which remains a Harness adapter for writes and command execution.
- **Reason:** the Control Plane must inspect repositories to route, plan verification and later
  decompose. Dependency inversion alone (revision 3, which said `WorkspaceAuthority` "may
  implement" the port) removes the compile-time coupling but leaves a Harness-owned object as the
  Control Plane's runtime collaborator — ownership that is hard to explain and harder to test.
  Sharing the *containment primitives* gets the safety reuse without the ownership ambiguity.
  B is worse than both — it duplicates containment in the layer least equipped to enforce it.
- **Migration:** extract the containment primitives (pure, already unit-testable); add the neutral
  read adapter over them; change `VerificationCoordinator`'s constructor to take the port.
  Behaviour-preserving, no schema change. First task of increment 7.

### CR-14 — Where parent partial-success lives
- **A:** a new `TaskState` in the 9-state machine.
- **B:** a verdict field separate from execution state.
- **Decision:** **KEEP_B.** The task state machine is not extended.
- **Reason:** the 9-state machine is a stable kernel with characterization tests and a documented
  Control-Plane-only invariant. Adding an outcome flavour to it breaks compatibility for a concern
  that is not a lifecycle state. Execution state answers "is it still running"; the verdict
  answers "what did it conclude". Child outcomes map deterministically into the parent verdict.
- **Migration:** parent verdict is a new versioned read-contract field; child→parent mapping is a
  pure function with a table-driven test; no migration of existing task rows.

### CR-15 — Who materializes the per-run profile
- **A:** Spec E — the Control Plane writes ephemeral per-run overlays into task worktrees and
  "validates paths and writes the returned content into its own profile"
  (`cockpit/docs/specs/E-agentic-os-role.md:14`, M9).
- **B:** this plan's ownership matrix — every filesystem write belongs to the Harness's
  `WorkspaceAuthority`.
- **Decision:** **KEEP_B**, and amend Spec E (amendment A6).
- **Reason:** Spec E was written before the Execution Harness existed, when the Control Plane was
  the only thing with a workspace. Now that `WorkspaceAuthority` owns containment, symlink
  refusal, size caps and command execution, a second writer with its own path validation is both
  duplicated safety logic and a second place for a containment bug. The split that keeps every
  invariant intact is: Cockpit renders and returns bytes, the Control Plane decides and passes
  content or content-addressed references, the Harness materializes.
- **Why this is called out separately:** revision 5 corrected the contradiction *inside* this
  document and inside §4.1, but left Spec E saying the opposite while §0 claimed every unlisted
  prior design remained authoritative — recreating across two documents the exact conflict it had
  just closed in one. Found by an independent cold review.
- **Migration:** amending Spec E's line 14 and M9 is a **deliverable of increment 5**, merged in
  the same change as the split, so no window exists where the two documents disagree. Spec E's
  other invariants — no caller-supplied output directory, no content history, no security verdict
  — are unaffected.

## 4.1 Ownership matrix

One named owner for every persisted record, decision, protocol and cleanup lifecycle. An overlap
without a row here is an unresolved overlap.

| Thing | Sole owner | Notes |
|---|---|---|
| Task / subtask records and verdicts | Control Plane | incl. cross-repository parent verdict |
| Routing decision + explanation | Control Plane | |
| Verification plan (initial **and** revisions) | Control Plane — single planner service | CR-7 |
| Verification execution + check results | Execution Harness | never selects |
| Execution session, events, approvals, checkpoints | Execution Harness | |
| Handoff envelopes + claim protocol | Execution Harness | Control Plane picks the target |
| Workspace/repository/worktree identity | Control Plane (registry) | Harness gets resolved refs |
| Pre-execution repository inspection (read-only) | Control Plane owns the `RepositoryInspector` port; adapter is neutral infrastructure | CR-13 |
| Filesystem writes and command execution | Harness `WorkspaceAuthority` | sole sanctioned path |
| Containment / path-validation primitives | neutral shared module | used by both adapters, owned by neither |
| Artifact blob lifecycle, incl. GC | `ArtifactStore` (sole owner) | GC is one of its operations; the retention job only *schedules* it |
| API version-compatibility policy | Control Plane contract doc; Cockpit conforms | §3.1 |
| Transport authentication + command authorization | Control Plane | CR-12 |
| Managed↔observed correlation token issuance | Control Plane | Cockpit validates only |
| Observed external sessions | Cockpit | never writes managed state |
| Assistant tooling registry, `~/.claude` etc. | Cockpit | Spec E |
| Progress denominator (subtask counts) | Control Plane | Cockpit renders |
| Parent verdict incl. partial success | Control Plane | a verdict field, never a `TaskState` (CR-14) |
| Asset selection + composition/AgentSpec revision | Control Plane | decides and explains; writes no files |
| Registry asset content + bundle rendering | Cockpit | returns bytes; never writes a caller path |
| Cached registry snapshots | Control Plane | staleness recorded on the revision; fail-closed default |
| Provisioned profile materialization, retention, disposal | Execution Harness (`WorkspaceAuthority`) | |
| Adapter `prepare`/`provision`/`verify`/`dispose` + achieved fidelity | Execution Harness | Control Plane never invokes it |
| API credential issuance, storage, rotation | Control Plane | clients read, never mint |
| Inferred phase + confidence | Cockpit | never presented as managed lifecycle |
| External trace export | `TelemetrySink` adapters | never canonical |

---

## 5. Tool verdicts

Unchanged from `docs/operator-observability-verification.md` §10 — restated here with the
implementation-anchored overlap each one hits.

| Tool | Verdict | Overlaps with | Anchor |
|---|---|---|---|
| **AgentTrail** | `USE_AS_DEVELOPMENT_TOOL` | Cockpit agent monitor; project progress (§3.6) | Useful for developing *with* agents in any repo. Its PLAN.md/daemon/inferred-component model must never become canonical Agentic OS state (CR-9). Its "component map" idea is the one worth stealing — into Cockpit, once §3.5 decomposition gives it a real denominator. Not on any critical path. |
| **CCAM** | `USE_AS_REFERENCE_IMPLEMENTATION` | Cockpit `agents.ts` + `codexSource.ts` + C3 | Cockpit already ingests Claude hooks and Codex rollouts, models subagents/tools/costs, and attaches via PTY. Running CCAM alongside means two dashboards for one concern. Borrow its SQLite schema, remote-source and cursor patterns for slice C3. |
| **Playwright** | `ADOPT` | `VerificationProviderRegistry` (H5D) | Adopt as a `BrowserVerifier` provider inside the existing registry — no new subsystem. Prefer the repository's own suite (`scramble-stack/e2e` proves this case is real); pinned execution-scoped fallback otherwise. Automatic selection already works: `verification-planner.ts` emits `impact:frontend` from changed files and acceptance-criteria text with no mention of Playwright. |
| **Postman MCP** | `DEFER` | `ApiVerifier` (H5C) | H5C's local-first ladder (native API tests → OpenAPI/schema → bounded local HTTP) covers every current repository without credentials, installation or egress. Define the `PostmanVerifier` seam; build it only when a repo maintains real collections. MCP availability is not a reason. |
| **Langfuse** | `ADOPT_AS_OPTIONAL_ADAPTER` | `TelemetrySink` (T1) | One optional, redacted sink behind explicit config, local/self-hosted preferred. Core must never import it; sink failure must never change state. Development tracing of our own Claude/Codex work is a *separate* opt-in and needs no product coupling. |

**Invariant (unchanged, and satisfied today):** no canonical Agentic OS state depends on
AgentTrail, CCAM, Langfuse or Postman.

---

## 6. Managed vs Observed

**Make it first-class — it already is, on both sides.** Agentic OS owns managed executions;
Cockpit owns observed external sessions with explicit `{source, confidence}`; linking is explicit,
reversible and operator-confirmed (slice C4). No change to the accepted design.

The one thing to add: when Agentic OS launches a provider session it should emit a **correlation
token** the observer can recognize, so linking is exact rather than heuristic for the managed
case. Heuristic suggestion + operator confirmation stays the fallback for genuinely external
sessions. This is a small addition to H6, not a new subsystem — but the token is only meaningful
once the transport is authenticated (CR-12), and it must be issued by the Control Plane and
merely *validated* by Cockpit, never minted on the observer side.

---

## 7. Verification and evidence — recommended model

**No new model.** The canonical model is already implemented and correct:

```
Task
└── ExecutionSession                      (runs row; 12-state machine)
    ├── ExecutionResult                   (one per terminal session)
    │   ├── outcome                       (execution: completed/failed/…)
    │   ├── verification: EvaluationResult (checks: passed/failed/skipped/blocked)
    │   ├── artifacts: ExecutionArtifact[] (12 kinds incl. browser_report, screenshot,
    │   │                                   api_report, console_log, trace_ref)
    │   └── enforcement                   (what was ACTUALLY enforced)
    ├── VerificationPlan revisions        (verification_plan_revisions; initial + post_change)
    └── EvidenceBundle                    (READ PROJECTION — never persisted separately)
```

Execution and verification stay separate: `outcome: "completed"` with
`verification.passed === false` is legal, and only the Control Plane turns that into a task
verdict. Verification strategy derives from changed files, acceptance criteria and task metadata
in `verification-planner.ts` — already, with no user instruction. What is missing is only the two
**providers** (API, browser) and workspace-aware discovery to feed them.

---

## 8. Build vs buy

| Capability | Decision | Note |
|---|---|---|
| Routing | KEEP_EXISTING | deterministic + explained; telemetry scoring already behind the same interface |
| Decomposition / subtasks | **BUILD** | §3.5 — the real missing Control-Plane responsibility |
| Orchestration | KEEP_EXISTING | after CR-4 retires the legacy execution branch |
| Harness lifecycle | KEEP_EXISTING | Phases 0–7 done |
| Provider adapters | KEEP_EXISTING | 6 adapters |
| Handoff | KEEP_EXISTING | wire the claim protocol (deferral #7) |
| Agent monitoring | KEEP_EXISTING (Cockpit) | CCAM as reference only |
| Project progress | **BUILD** (small) | structural counts only; depends on decomposition |
| Traces | OPTIONAL_PLUGIN | `TelemetrySink` + optional self-hosted Langfuse; external backends only (CR-11) |
| Cost/token telemetry | KEEP_EXISTING | `usage` on results, quota snapshots, `telemetry.ts` |
| UI verification | ADAPT_EXTERNAL | Playwright as a provider |
| API verification | BUILD (local-first) | Postman deferred as an optional provider |
| Evaluation | KEEP_EXISTING | `evaluator` kind exists; no provider yet |
| Screenshots / evidence | KEEP_EXISTING contract, **BUILD** the runtime | store + GC missing (CR-10) |
| Cockpit visualization | KEEP_EXISTING, extend | slices C1–C4 |
| Remote runners | DEFER | no real use case; contracts already carry the keys |
| Task persistence | KEEP_EXISTING | SQLite + 12 migrations |
| Transport auth / command authorization | **BUILD** | bearer token or Unix socket (CR-12) |
| Composer / AgentSpec / registry reads (Spec E M8–M9) | KEEP_EXISTING plan, **BUILD** | increment 5; M10 postbacks deferred |
| Pre-execution repository inspection | **BUILD** (port) | `RepositoryInspector`, CR-13 |
| Session observation | KEEP_EXISTING (Cockpit), harden | slice C3 |

---

## 9. Target architecture

The request's diagram is **accepted with two corrections**, both from repository evidence.

```
                          COCKPIT  (separate repo, separate product)
             operator UI · assistant-tooling registry · observed sessions
                                      │
                   ┌──────────────────┴──────────────────┐
                   │ versioned HTTP contract (API 1.x)   │  ← must be major-compatible (§3.1)
                   │ reads + separately-authorized cmds  │
                   └──────────────────┬──────────────────┘
                                      │
                                 AGENTIC OS  (ai-control-plan)
                                      │
        ┌─────────────────────────────┴──────────────────────────────┐
        │ CONTROL PLANE                                              │
        │  intake · decomposition (MISSING) · routing · policy       │
        │  VerificationPlanner · verdicts · reroute/failover         │
        └─────────────────────────────┬──────────────────────────────┘
                                      │ ExecutionRequest (provider-neutral)
        ┌─────────────────────────────┴──────────────────────────────┐
        │ EXECUTION HARNESS                                          │
        │  sessions · context · workspace authority · guards         │
        │  approvals · checkpoints · handoff · recovery              │
        │  VerificationProviderRegistry                              │
        │    ├── CommandVerifier      (native test/lint/typecheck) ✅ │
        │    ├── ArtifactExistsVerifier                            ✅ │
        │    ├── ApiVerifier          (local-first; Postman seam)  ⬜ │
        │    └── BrowserVerifier      (Playwright)                 ⬜ │
        └─────────────────────────────┬──────────────────────────────┘
                                      │
                              Provider Adapters
                claude · codex · cursor · bedrock · openrouter · fake
                                      │
                          durable events + results (canonical)
                                      │
                              TelemetrySink (optional, redacted)
                            local file · self-hosted Langfuse?
            (Cockpit reads canonical durable events directly — never via a sink; CR-11)
```

**Correction 1 — Cockpit is not only a viewer.** Spec E gives it a second, load-bearing role:
the machine-global assistant-tooling **registry** the Composer draws from, and sole writer of
`~/.claude` / `~/.codex` / `~/.cursor`. The request's diagram omits this; it is the strongest
argument for keeping the repositories separate.

**Correction 2 — Evidence is not a third top-level branch.** The diagram shows
`Managed Tasks | External Sessions | Evidence` as siblings. Evidence is a *projection of* managed
executions, not a peer of them. There are exactly **two** data classes: Managed and Observed.

**Verification Router** in the request's diagram is two already-implemented things, deliberately
split across the boundary: the Control Plane's `VerificationPlanner` *selects*, the Harness's
`VerificationProviderRegistry` *runs*. Do not merge them — that would put selection in the
Harness and make it a router.

---

## 10. vNext roadmap

Thirteen increments (see the note above increment 10 for why not ten). The first three are P0, all
three defect repair; nothing new ships on a
broken boundary, an unauthenticated command surface, or an untracked design.

### Dependency graph

```text
1a compat policy ──┐
1b design into git ┴─► 2 authenticated transport ─► 3 eval + single-mode canary ─┬─► 6 mode parity
                                     │                          │                 │    ─► retire legacy
                                     ├─► 4 session-level H6 + Cockpit views       │
                                     │                                            │
                                     └─► 5 registry contract + composition ◄──────┘
                                          (provisioned and verified)
              7 RepositoryInspector + one planner + kind-aware discovery ─┐
                          │                                               │
              8 ArtifactStore + GC ──► 9 ApiVerifier ─► BrowserVerifier ──┤
                                                                          │
                                    10 contracts + verdict algebra ─► 11 single-repo fan-out
                                              ─► 12 multi-repo saga ─► 13 progress projection
```

**P0 is increments 1–3.** Increment 4 is the first P1. *(Revision 4: revision 3's prose said "the
first four are P0" while labelling increment 4 as P1 — corrected.)*

**Authentication now precedes the canary.** Revision 3 let increment 2 enable Harness execution
while the API was still unauthenticated, which would have exposed a newly enabled execution path
to every local process and contradicted this document's own §11. Auth is increment 2; the canary
is increment 3.

**Composition is no longer parked behind decomposition.** Registry lookup, per-run bundle
rendering and AgentSpec revisions are useful for an ordinary single-repository task and are the
capability that makes this an *Agentic OS* rather than a harness with a dashboard. Increment 5
delivers the **contract plus a provisioned, verified single-task consumer**; M10 usage postbacks
and subtask-scoped composition extend the same contracts later.

### 1 — Repair the boundary and the record · **P0**

Two **bounded, reversible** repairs — not zero-risk: version negotiation is live cross-repository
runtime behaviour, and committing normative documents can surface inconsistent baselines. They
share a roadmap number but are **independently mergeable commits with separate acceptance gates**;
neither may mask the other's failure.

**1a — compatibility policy.**
- **Reuses:** `controlPlane.ts` and its capability gating.
- **Adds:** a normative policy in the contract document — same major required, client minor ≤
  server minor accepted, **plus the schema discipline that makes that safe**: an enumerated list of
  changes prohibited in a minor (no field-meaning change, no new required field, no narrowing, no
  command-semantics change), tolerant-reader rules, a stated policy for unknown enum members, and a
  retained fixture per released minor. Implemented in the client, pinned by a producer fixture.
- **Acceptance:** `/api/control-plane/status` reports `connected: true` against a live API-1.1
  plane; `2.0` rejected clearly; a 1.2 client against a 1.1 server rejected; an unknown enum member
  tolerated per the stated rule; a compatibility suite runs every supported minor's retained
  fixture; 1296 Cockpit tests stay green.

**1b — design corpus into git.**
- **Adds:** a docs branch off `main` carrying the five untracked docs plus this plan and its review
  log, baselines updated to `37066e9`.
- **Status:** partly done — `4d1b150` on `docs/agentic-os-vnext` (PR #18) tracks all seven documents
  and repoints the two worktree-path references. What remains is the merge.
- **Acceptance:** PR #18 merged to `main`; `git log main -- docs/execution-harness.md` is non-empty;
  no document cites a worktree-local path as source of truth; amendments A1–A6 are reflected in the
  documents they amend, including Spec E (A6, and A4's read/write split). *(Worktree pruning is out of scope — §3.10.)*

- **Repos:** cockpit + ai-control-plan. **Depends on:** nothing. **Model:** CHEAP.

### 2 — Authenticated transport and command authorization · **P0**
- **Objective:** close §3.8 for **every** client, before any write capability exists **and before
  any new execution path is enabled**.
- **Reuses:** the loopback bind as defence in depth; Spec E's stated rule.
- **Adds:** authenticated transport across the whole API; a `commands.write` authorization
  independent of every read capability; and two client stories:
  - **`apps/web` browser bootstrap.** The built-in web client calls this same API
    (`apps/web/src/api.ts`) and would break the moment auth is mandatory. Minting a session for any
    loopback request would defeat the local-process threat model, and handing the long-lived bearer
    to JavaScript would violate the acceptance criterion below. The protocol is therefore: the
    privileged launcher that already has filesystem access to the credential is the **issuer**: it
    mints a **one-time bootstrap token** — short expiry (seconds, not minutes), bound to the
    intended audience (the API origin) and to a single use — and delivers it by a
    **launcher-mediated form POST to a dedicated exchange endpoint** (`POST /api/auth/bootstrap`),
    or an equivalent non-URL channel.
    **Explicitly prohibited channels:** a query string (leaks through history, server logs,
    screenshots and referrers), a URL fragment (JavaScript-readable, which would violate the
    acceptance criterion below), an environment variable inherited by unrelated child processes,
    and any channel readable by another local process.
    The token is never stored — it is consumed on first exchange and discarded; the server returns
    a `Secure` + `HttpOnly` + `SameSite=Strict` cookie as the only durable browser credential, and
    sets `Referrer-Policy: no-referrer` on the exchange. Origin is validated, replay of a consumed
    token is refused, and credential rotation forces browser re-authentication.
  - **Credential protocol, not "surfaced".** An OS-permissioned credential file (mode `0600`,
    owner-only directory) or a Unix domain socket; atomic rotation with an overlap grace window so
    active clients are not cut off and no restart is required; Cockpit reads the file by path from
    its own config rather than having a secret copied across repositories; every auth failure is
    redacted and never echoes the presented credential.
- **Repos:** ai-control-plan (+ `apps/web`) + cockpit.
- **Depends on:** 1a.
- **Acceptance:** an unauthenticated local request to any endpoint is rejected; `apps/web` works
  end to end with no token reachable from JavaScript; a bootstrap token cannot be replayed; a
  cross-origin request cannot obtain a session; read and write capabilities are independently
  grantable; rotation with a grace window keeps an in-flight client working and forces browser
  re-authentication, both tested; replay and CSRF cases tested; no credential appears in a log,
  event, artifact, error body or telemetry payload.
- **Model:** STANDARD (security review STRONG).

### 3 — Eval program and single-mode canary · **P0**
- **Objective:** make the Harness reachable for the one mode it supports. **Highest-value
  increment** — it converts ~13.6k LOC of dark code into observable behaviour.
- **Reuses:** `docs/agentic-os-eval-plan.md` — all six areas already specified.
- **Adds:** eval execution, a committed scorecard, and a **per-mode** enablement flag replacing the
  global `harnessSingleMode` boolean.
- **Repos:** ai-control-plan.
- **Depends on:** 2 — the newly enabled execution path must not be reachable unauthenticated.
- **Acceptance:** the four safety-net test files stay green with single mode ON; recovery-chaos and
  E2E scenario suites pass; a real Claude and a real Codex single-mode execution complete end to
  end with durable sessions, plan revisions and verification results; the scorecard names which
  flows remain gated (compare, race, parallel, provider-resume, handoff claim) and why; a
  documented rollback disables the mode for *new* starts only while in-flight Harness sessions
  settle to terminal state under `HarnessRecovery`, proven by a test.
- **Model:** STANDARD (STRONG for real-adapter conformance).

### 4 — Session-level H6 contract and Cockpit managed views · **P1**
- **Objective:** operator feedback **early** — this is what makes the canary observable. Session
  granularity only; subtasks wait for their producer.
- **Reuses:** API 1.1 reads (durable sessions, native verification results, approvals, checkpoints
  all exist today); the repaired client (1a); the transport (2).
- **Adds:** `artifacts.read` and `commands.write` capabilities, durable event cursors and resync,
  published producer fixtures and a stated support window; Cockpit managed task detail rendering
  Tests/Typecheck/Lint status and evidence links, visually distinct from Observed; the managed
  correlation token from §6, minted by the Control Plane and only validated by Cockpit.
  **`subtasks.read` is deliberately excluded** — it would contract a shape nothing produces.
  API and browser evidence fields are added additively after increment 9, gated by capability.
- **Repos:** ai-control-plan + cockpit.
- **Depends on:** 1a, 2. May run in parallel with 3.
- **Acceptance:** Cockpit renders every managed *session* state from durable reads alone; SSE loss
  and reconnect lose nothing; an older client tolerates additive fields and fails clearly on a
  major mismatch; a coordinated release test runs both repos' fixtures together; no artifact blob
  loads until requested; commands require the write capability and fail closed without it.
- **Model:** STANDARD.

### 5 — Registry contract and provisioned single-task composition · **P1**
- **Objective:** deliver the capability that makes this an Agentic OS — a per-run composed agent
  that **demonstrably changed what the provider ran with** — for single-repository tasks.
- **Execution-mode scope:** **Harness single mode only.** "Single-task" in this increment means the
  `single` execution mode, not merely one task; compare, race and parallel stay uncomposed until
  increment 6 extends composition to each mode as part of its parity gate, before legacy retirement.
  A registry snapshot, a rendered bundle, an AgentSpec row and a profile directory are
  *composition metadata*, not a composed agent; this increment is not done until the provider is
  proven to have consumed them.
- **Reuses:** Cockpit's existing installed-asset scanners, lineage, context compiler and memory
  (Spec E M8/M9); the routing decision as the composition trigger; the
  `ExecutionRequest.compositionRevisionId` field already reserved; the adapter manifest's existing
  achieved-fidelity reporting pattern (`enforcement`, isolation tiers).
- **Adds:**
  - Cockpit's versioned, **authenticated** registry read API (M8) returning deterministic full
    snapshots with a `snapshotDigest`; per-run bundle rendering (M9) returning content and a
    manifest, with **no output directory accepted** — Cockpit returns bytes, never writes.
  - **A clean three-way ownership split for provisioning** (revision 5, resolving a contradiction
    revision 4 introduced: it had the Control Plane writing profile files while the ownership
    matrix gave every filesystem write to the Harness):
    - **Cockpit** renders and returns bundle content and its manifest. It writes nothing outside
      its own machine-global scope.
    - **Control Plane** selects assets, records the explanation, persists the immutable
      composition/AgentSpec revision, and puts the **bundle content inline, size-bounded** into
      the `ExecutionRequest`. It performs no filesystem write and holds no profile.
      *Not* content-addressed references: the only content-addressed store in this roadmap arrives
      in increment 8 and is scoped to artifacts, so a reference here would name a blob no component
      owns, authorizes, resolves or retains — and would make composition revisions unreplayable the
      moment that blob aged out. Inline bounded bytes keep the revision self-contained. A dedicated
      immutable composition-blob store is the upgrade path if bundles outgrow the bound, and would
      become an explicit dependency of this increment.
    - **Execution Harness** materializes the ephemeral profile through `WorkspaceAuthority`,
      invokes the adapter `prepare` / `provision` / `verify` / `dispose` lifecycle, reports
      achieved fidelity on the result, and owns profile retention and disposal.
    This keeps every existing invariant intact: the Control Plane still decides and never touches
    the filesystem; the Harness still executes and never selects.
  - **Deterministic asset selection with an explanation**, in the same style as the routing
    explanation: why each asset was attached, and why each candidate was not.
  - **Trust policy.** Registry content and memory are untrusted inputs. A workspace
    content-digest allowlist gates attachment; anything outside it requires explicit operator
    opt-in; MCP/tool attachment is least-privilege and per-run, never ambient; secret *references*
    only, never values; **selecting zero optional assets is a valid, tested outcome**.
  - **Adapter provisioning lifecycle** — `prepare` / `provision` / `verify` / `dispose`, coordinated
    by the **Harness** — with **achieved-fidelity reporting** on the result, mirroring how isolation
    already reports what was actually enforced rather than what was requested.
  - **Availability and staleness semantics.** Defined behaviour when Cockpit is unavailable, when
    the snapshot digest changes between compose and execute, and when a cached snapshot is stale:
    **fail closed by default**, with cached-snapshot use permitted only by explicit policy and
    always recorded on the revision. **Silent fallback to ambient assistant configuration is
    prohibited.**
- **Repos:** cockpit (producer) + ai-control-plan (consumer).
- **Depends on:** 2 (the registry API is authenticated even on loopback, per Spec E) and 3 (the
  Harness path is the consumer; composing against a legacy execution mode would prove nothing).
  Cockpit's registry API contract may be developed in parallel ahead of both.
- **Acceptance:** a composition revision is durable, replayable and referenced from the execution
  request; identical inputs render byte-identical bundles; **a provider launch verifies the
  generated profile was actually consumed, and a negative test proves ambient configuration is not
  silently used**; achieved fidelity is reported and may differ from requested; an asset outside
  the digest allowlist is not attached without explicit opt-in; Cockpit unavailable fails closed
  rather than degrading to ambient; a snapshot changing mid-run is detected and recorded; no secret
  value is ever returned by the registry; Cockpit never writes to a caller-supplied path.
  M10 usage postbacks and subtask-scoped composition are explicitly out of scope.
- **Model:** STANDARD (security review STRONG for the trust policy).

### 6 — Harness parity for the remaining modes, then retire the legacy path · **P1**
- **Objective:** one execution path (CR-4).
- **Reuses:** everything under `harness/`; the per-mode flag from increment 3.
- **Adds:** Harness-backed compare / race / parallel; the handoff-envelope claim protocol
  (standing deferral #7); then deletion of the legacy execution branch and the
  `Orchestrator` → `ControlPlane` rename (deferral #5) as a separate no-behaviour-change commit.
- **Repos:** ai-control-plan.
- **Depends on:** 3 + soak for the parity work; **and 5 before the legacy path is deleted**,
  because increment 5 composes single mode only and this increment is where composition is
  extended to compare/race/parallel. Retiring the legacy path before that would silently ship
  three uncomposed execution modes. Parity and composition-extension may proceed in either order;
  deletion is gated on both.
- **Acceptance:** each mode is evaluated and enabled independently with the scorecard extended per
  mode; `uq_live_successor` enforces one live successor per origin envelope and a crash between
  claim and first event leaves a recoverable `start_ambiguous` row; only after every mode is
  enabled and soaked, no `adapter.start` call exists outside `harness/` and the per-mode flags are
  removed; **every enabled mode composes** — a compare or race run carries a composition revision
  and a verified profile exactly as single mode does; failover/retry/parallel/verdict behaviour is
  unchanged and still tested.
- **Model:** STANDARD.

### 7 — `RepositoryInspector` port, one planner, kind-aware discovery · **P1**
- **Objective:** close CR-13, CR-7 and §3.7 — in that order, because the port is what makes the
  single planner architecturally clean rather than merely deduplicated.
- **Reuses:** `core/verification-planner.ts`, `project-verification.ts`, `WorkspaceAuthority`'s
  existing bounded-read implementation, `verification_plan_revisions`.
- **Adds:** the read-only `RepositoryInspector` port (CR-13) that Control-Plane code depends on;
  a single Control-Plane planning service owning initial and revised plans; npm/pnpm workspace
  traversal at bounded depth and count; classification of a discovered script into its real
  `VerificationKind`; detection of a root script that already covers a nested suite.
  Per Codex round 2 #11, that detection is **advisory, never authoritative**: explicit
  per-repository capability configuration wins, inferred coverage carries provenance and
  confidence, and inference alone may **never** suppress a required check — only a deterministic
  signal (an explicit config entry, or the nested runner reporting its own kind) may.
- **Repos:** ai-control-plan.
- **Depends on:** nothing (parallel with 3–6).
- **Acceptance:** no Control-Plane module imports `WorkspaceAuthority`, enforced by an
  import-boundary test; exactly one code path constructs a plan; discovery on a `scramble-stack`
  fixture classifies the `e2e` workspace as a `browser` capability and flags the root `test` script
  as *probably* covering it, with provenance; a required browser check is never skipped on
  inference alone; ambiguous or absent capabilities produce explicit `skipped`/`blocked` reasons;
  traversal is bounded and cannot escape the worktree.
- **Model:** STANDARD.

### 8 — `ArtifactStore` and GC · **P1**
- **Objective:** give the retention contract a runtime before the first large-binary producer
  (CR-10), with a stated security model.
- **Reuses:** `ExecutionArtifact` metadata; the existing retention job as a *scheduler only*.
- **Adds:** a worktree-external content-addressed store that is the **sole lifecycle owner**, with
  GC as one of its operations; **workspace-scoped CAS namespaces** — content is deduplicated
  *within* a workspace and never across, so a digest from one workspace is neither readable nor
  probe-able from another; reference counting with the blob write and the reference write
  committed transactionally; per-workspace quotas; expiry by retention class; pin authorization;
  owner-only file modes; orphan recovery after a crash mid-write.
- **Repos:** ai-control-plan.
- **Depends on:** nothing (parallel with 7).
- **Acceptance:** an `ephemeral` artifact is gone after its session; a `pinned` one survives task
  GC and cannot be pinned without authorization; a cross-workspace read of a known digest fails,
  and a probe cannot distinguish "absent" from "present in another workspace"; a GC racing a
  concurrent reference-add never deletes a referenced blob; exceeding quota fails the write with a
  typed error; a crash mid-write leaves no unreferenced blob after boot; no artifact path escapes
  the store root.
- **Model:** STANDARD (security review STRONG).

### 9 — `ApiVerifier`, then `BrowserVerifier` · **P1**
- **Objective:** automatic API and UI verification, in that order, with no SaaS and no implicit egress.
- **Reuses:** `VerificationProviderRegistry`; the `api` / `browser` kinds and `api_report`,
  `browser_report`, `screenshot`, `console_log` artifact kinds; the planner's `impact:frontend`
  selection; increment 8's store; increment 7's classification.
- **Adds (9a, ApiVerifier):** native-API-test → OpenAPI/schema → bounded local HTTP ladder;
  isolated server lifecycle with explicit ephemeral binding, readiness and child-process cleanup;
  a **connection-time** egress control — resolve the host, validate every returned address against
  the allowlist as a normalized IPv4/IPv6 literal, then **connect to the validated address with an
  explicit `Host` header** so a second resolution cannot rebind between check and connect;
  redirects refused by default; proxy environment variables stripped; Unix sockets only when
  explicitly configured; redaction applied before a request or response is recorded; a
  defined-but-unbuilt `PostmanVerifier` seam.
- **Adds (9b, BrowserVerifier):** native-Playwright detection from increment 7; a
  **pre-provisioned, checksummed** browser asset policy with **no implicit runtime download** —
  missing tooling yields `blocked` with a reason, never an ad-hoc install; flow/assertion/console/
  page-error capture; screenshot containment and retention through increment 8.
- **Repos:** ai-control-plan.
- **Depends on:** 7, 8. 9b depends on 9a's server-lifecycle abstraction.
- **Acceptance:** a route change automatically selects `api` and a frontend change automatically
  selects `browser`, neither naming a tool in the prompt; a DNS-rebinding attempt (first
  resolution allowlisted, second not) cannot reach the second address, proven by a test; redirect
  and IPv6-literal cases are refused; no auth header or secret reaches a durable artifact; the
  project's own Playwright suite wins over the fallback; a failing UI assertion yields execution
  `COMPLETED` + verification `failed`; no verifier writes `~/.claude`, `~/.codex` or any global
  config; a network-isolated run produces `blocked` with a reason rather than attempting a download.
- **Model:** STANDARD (security review STRONG for 9a).

### Increments 10–13 — decomposition and multi-repository fan-out

> **The ten-increment cap is deliberately broken here, once.** The original brief asked for no more
> than ten ordered increments. Slicing decomposition to fit that produced a single "increment" that
> spanned a new entity model, DAG scheduling, multi-repository compensation and UI projection, and
> that carried an instruction to re-plan itself before execution — which is the definition of not
> being an increment. An independent cold review named this presentation-driven architecture, and it
> was right. The cap was a reporting constraint, not an architectural one, so these are four real
> increments with their own dependencies and rollback gates. Increments 1–9 are unchanged.

**Vocabulary across all four:** **Task → Subtask only.** No Mission, no Goal.

#### 10 — Task/Subtask contracts and verdict algebra · **P1**
- **Objective:** the durable model and, before anything consumes it, the complete rule for turning
  child outcomes into a parent verdict.
- **Reuses:** the `parent_task_id` / `group_id` columns that already exist and have no producer;
  the task state machine, unchanged.
- **Adds:** Task/Subtask entities and `subtasks.read` on the contract. Parent partial-success is a
  **verdict field, never a new `TaskState`** (CR-14). And the part revision 5 hand-waved as "a pure,
  table-driven function" without ever defining it — the **verdict algebra**, written before any
  fan-out exists:
  - the parent verdict vocabulary, enumerated;
  - a truth table over mixed child outcomes — completed, failed, cancelled, blocked, timed-out,
    yielded — including children that completed execution but failed **required** verification,
    which is a distinct case from failing execution (H-I6);
  - precedence between cancellation and failure when both are present;
  - how a retried child collapses into one contribution rather than two;
  - what a descendant skipped because its DAG dependency failed contributes, and whether that is
    distinguishable from one never scheduled.
- **Depends on:** 4.
- **Acceptance:** no `TaskState` is added, proven by a transition-matrix regression test plus tests
  asserting verdict/state independence — not by test-file byte identity; the truth table is
  exhaustive over the outcome cross-product and every cell is asserted; a required-verification
  failure and an execution failure produce distinguishable parent verdicts.
- **Model:** STRONG.

#### 11 — Single-repository fan-out · **P1**
- **Objective:** multiple subtasks under one parent, in one repository, before any cross-repository
  concern is introduced.
- **Adds:** the decomposition service; a dependency DAG between subtasks; cancellation propagation
  from parent to children.
- **Depends on:** 10, 6.
- **Acceptance:** cancelling a parent cancels its children and cleans up their worktrees; a DAG
  cycle is rejected at decomposition, never at execution; a child failing mid-DAG marks its
  dependents skipped with a reason and produces the verdict increment 10's table specifies.
- **Rollback:** decomposition is off by default; a parent with one subtask is behaviourally
  identical to today's single task.
- **Model:** STRONG.

#### 12 — Multi-repository saga · **P1**
- **Objective:** one parent task spanning repositories.
- **Adds:** a **pinned base revision per repository**; defined behaviour for worktree-creation
  failure; compensating cleanup of already-created worktrees; partial success as a first-class
  outcome. **Cross-repository atomicity is explicitly not provided** and is documented as such.
- **Depends on:** 11, 7.
- **Acceptance:** one parent drives subtasks in three repositories (`cockpit`, `ai-control-plan`,
  `scramble-stack` fixtures) with no cwd, `PLAN.md` or provider session id as canonical identity;
  each subtask records the base revision it ran against; a mid-fan-out failure yields an
  explainable partial-success verdict and leaves no orphaned worktree.
- **Rollback:** single-repository fan-out (increment 11) remains fully functional if this is
  disabled.
- **Model:** STRONG.

#### 13 — Progress projection · **P1**
- **Objective:** make a long mission legible without inventing precision.
- **Adds:** **structural** progress only — `6 / 8 subtasks complete`, current phase, blockers,
  per-subtask repo/assistant/model/elapsed/usage; `TaskEnvelope.completed` / `remaining` becomes a
  rendered projection of this model rather than a parallel one. **No percentage without a real
  denominator; absent progress renders as absent, never as zero or as a spinner implying motion.**
- **Depends on:** 11 (12 only for the multi-repository columns).
- **Acceptance:** progress is always a count over a known total or is explicitly absent; a task
  whose decomposition is still in flight shows no denominator rather than a provisional one; no
  UI surface derives a percentage from elapsed time, event count or token spend.
- **Model:** STANDARD.

### P2 backlog — decided, not scheduled
These have owners and decisions (CR-3, CR-11, §5) but no vNext increment; they follow increment 13.
- **C3** observed-session store: JSON snapshot → append-only SQLite/WAL with cursors and retention,
  CCAM patterns as reference only.
- **C4** explicit, reversible managed↔observed linking; a provider-session-id collision must never auto-link.
- **T1** `TelemetrySink` with a local sink first and an optional self-hosted Langfuse adapter, after
  redaction/egress tests prove the default payload carries no prompt, source, diff, tool
  argument/result, transcript, secret or PII. **No `CockpitEventSink`** (CR-11).
- **Spec E M10** per-asset usage postbacks, and subtask-scoped composition — both extend the
  increment-5 contracts rather than introducing new ones.

### Explicitly not on this roadmap
- **Remote runners (Phase 8).** No real remote use case. Contracts already carry the keys.
- **Bounded cost caps.** Needs a pricing table; token caps work today.
- **Postman, AgentTrail ingestion, CCAM deployment.** Deferred per §5, off the critical path.
- **Cross-repository atomic commits.** Not offered; partial success is the contract.
- **Repository merges of any kind.**

## 11. Acceptance for this plan

- Every capability claim cites a file, migration or test.
- No increment restarts merged work, and no increment can be built before its dependencies.
- No canonical state depends on AgentTrail, CCAM, Langfuse or Postman.
- Every overlap in §4 has exactly one owner, and §4.1 names an owner for every persisted record,
  decision, protocol and cleanup lifecycle.
- The three P0 defects (§3.1 contract negotiation, §3.2 untracked design, §3.8 unauthenticated
  commands) are repaired in increments 1–3, before any new capability lands.
- No execution path is *enabled* before the API is authenticated — the canary follows the transport.
- Composition is not called delivered until a provider launch is proven to have consumed the
  generated profile, and ambient fallback is proven not to occur silently.
- No layer both selects and materializes: the Control Plane decides and writes nothing; the Harness
  materializes and selects nothing; Cockpit returns bytes and writes nothing outside its own scope.
- No execution path is deleted while it is the sole implementation of a live execution mode.
- No write capability ships before authenticated transport.
- No large-binary evidence producer ships before the artifact store and GC.
- No Control-Plane module depends on a Harness class; pre-execution inspection goes through the
  `RepositoryInspector` port (CR-13), enforced by an import-boundary test.
- The 9-state task machine is not extended; partial success is a verdict, not a state (CR-14).
- Every amendment to prior accepted design is listed in §0, not discovered in a later section, and
  **is reconciled in the document it amends** — an amendment that leaves the companion contract
  saying the opposite has not been made.
