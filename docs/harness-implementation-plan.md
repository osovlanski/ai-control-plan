# Execution Harness — Implementation Plan

**Status:** Approved for implementation (review gate passed 2026-08-31, 9.0/10 —
`docs/harness-review.md`). **No implementation on this documentation branch.**
**Design:** `docs/execution-harness.md` (revision 7). Section references below point there.

Sequencing follows the design's strangler migration (§10): characterization first, then
contracts/schema, then cutovers, each phase independently shippable and revertible, public
API green throughout. Verification per phase: `pnpm typecheck && pnpm test`.

---

## Phase 0 — Characterization + contracts + invariants

- **Goal:** pin current behavior; land all contract types and the session state machine as
  pure code with no runtime consumer.
- **Components:** core contract types (§2), session transition table, canonical fingerprint
  function, typed event payloads.
- **Files:** `packages/core/src/execution.ts` (new: request/policy/result/failure/envelope/
  reroute/verification types), `packages/core/src/session-state.ts` (new),
  `packages/core/src/events.ts` (typed payloads, additive event types),
  `apps/api/test/characterization.test.ts` (new).
- **Contracts:** `ExecutionRequest/Policy/Context/Session/Result/Failure`, `HandoffEnvelope`,
  `RerouteRequest`, `VerificationPlan/VerificationSpec/EvaluationResult`, repository/worktree
  identities, additive evidence artifact kinds, `ExecutionSessionState` +
  transitions, `requestFingerprint` canonicalization v1.
- **Persistence/API/Cockpit:** none.
- **Tests:** property-based transition sweep; fingerprint canonicalization (field coverage,
  exclusions, version); characterization of orchestrator public behavior (start, failover,
  handoff, approval relay, cancel, parallel) against the fake adapter.
- **Acceptance:** suite green; zero runtime behavior change (docs+types+tests only diff).
- **Rollback/risk:** trivial — nothing consumes the new code. Risk: characterization tests
  encode accidental behavior; mark intentional-vs-accidental in test names.
- **Depends on:** nothing.

## Phase 1 — Schema + session persistence cutover

- **Goal:** runs become session records with CAS, leases, start-ack, fingerprint dedupe.
- **Components:** migrations; session store; boot-reconcile v2 (probe/orphan instead of
  blanket fail, §9).
- **Files:** `apps/api/src/db/migrations/005_harness.sql` (runs columns + state vocabulary
  rewrite, `execution_requests` with partial unique live-successor index, `approvals`,
  `guard_directives`, `execution_results`, `handoff_envelopes`, `checkpoints.session_id`),
  `apps/api/src/modules/harness/session-store.ts` (new), orchestrator write paths.
- **Contracts:** `RUN_STATES` → `ExecutionSessionState` mapping (§5); legacy `state` read
  mapping.
- **Persistence:** the migration above; old rows rewritten per the §5 table.
- **API:** run reads serve `state` (legacy) + `sessionState` (dual-field window).
- **Cockpit/frontend:** none yet (legacy field keeps existing UI working).
- **Tests:** migration up on a seeded legacy DB; CAS/lease fencing unit tests; duplicate
  `executionRequestId` same-fingerprint dedupe vs different-fingerprint conflict; boot
  reconcile resume-offer vs orphan+checkpoint-attempt.
- **Acceptance:** characterization suite green; mixed-vocabulary reads correct.
- **Rollback/risk:** down-migration restores old vocabulary; risk is the state rewrite —
  gated by the migration test on a production-shaped fixture.
- **Depends on:** Phase 0.

## Phase 2 — Event path + workspace authority

- **Goal:** transactional event commits (event batch + envelope + session CAS, §9) and the
  workspace authority (§3) as the single filesystem/process boundary.
- **Files:** `apps/api/src/modules/harness/event-recorder.ts`,
  `apps/api/src/modules/harness/workspace-authority.ts` (new), checkpoint service
  session-scoping (`apps/api/src/modules/checkpoint.ts`).
- **Contracts:** two-view redaction (policy view in-memory, durable view persisted, §4).
- **Persistence:** none new (uses Phase 1 tables).
- **API:** SSE unchanged externally; now post-commit only.
- **Tests:** transaction failure between event insert and CAS (no partial visibility); seq
  monotonicity; redaction identifier-preservation; path canonicalization/symlink-escape/
  allowlist/reduced-env; session-scoped checkpoints for parallel siblings.
- **Acceptance:** characterization green; injected fault tests green.
- **Rollback/risk:** recorder is swappable behind the same insert call sites; risk is SQLite
  transaction scope around async adapter iteration — resolved by batching within
  better-sqlite3 sync transactions (spike first).
- **Depends on:** Phase 1.

## Phase 3 — SessionRunner + guards + durable approvals

- **Goal:** execution driving cutover: SessionRunner replaces ActiveRun/consume/settle;
  guards (budget/timeout/tool/approval/quota) with durable directives; approval protocol
  (§4) replaces try-every-run relay.
- **Files:** `apps/api/src/modules/harness/session-runner.ts`, `guards/*.ts`,
  `approval-service.ts` (new); `orchestrator.ts` delegates execution.
- **Contracts:** `RunSpec.toolPolicy` + `runControl` (§6); manifest fields
  (`usageAccounting`, `usageReporting`, `toolGating`, `approvalRelay`, `processIsolation`);
  adapter conformance suite skeleton in `packages/adapters`.
- **Persistence:** uses `approvals`, `guard_directives`.
- **API:** approval POST → durable protocol (idempotent/conflict semantics);
  `delivery_unknown` surfaced on session reads.
- **Cockpit/frontend:** approval UI reads the durable rows (same endpoints, richer states).
- **Tests:** design §12 layer 3 (approval pause/resume/expiry/conflict, cancel-vs-completion
  CAS race, timeouts, bounded budget + reporting gap, `policy_unenforceable` rejections,
  directive replay cap) + layer 4 crash cases for approvals and directives.
- **Acceptance:** characterization green; orchestrator no longer touches adapters directly
  for single-mode runs.
- **Rollback/risk:** largest phase — mitigate by keeping the old consume/settle path behind a
  config flag for one release; risk of subtle settle-order changes is covered by the
  characterization suite.
- **Depends on:** Phase 2.

## Phase 4 — Handoff envelopes + reroute + decision-side extraction

- **Goal:** typed handoff transaction (§7), claim protocol incl. `start_ambiguous`, reroute
  yield (§8); failover/retry/parallel/verdict logic remains in the renamed control-plane
  orchestrator, calling the Harness only.
- **Files:** `harness/handoff.ts` (new); `orchestrator.ts` → control-plane decisions only;
  render templates consume `HandoffEnvelope`.
- **Persistence:** `handoff_envelopes` state machine columns; supersession updates.
- **API:** handoff/reroute reads expose envelope + claim state.
- **Tests:** §12 handoff transaction cases: claim/release/supersede, pre-start expiry,
  `start_ambiguous` probe settle, corrected successor accepted, second live successor blocked
  by the partial index; reroute yields with no Harness-side target.
- **Acceptance:** cross-provider handoff demo (fake→fake) reproduces today's behavior with
  envelope rows; failover flow green.
- **Rollback/risk:** old prompt-render path kept as fallback template for one release.
- **Depends on:** Phase 3.

## Phase 5 — Verification + SecretBroker + isolation tiers

- **Goal:** Control Plane-owned deterministic `VerificationPlanner`, Harness-owned provider-based
  `VerificationRunner` (§2/§4),
  `SecretBroker` (§3), isolation fidelity (`isolation.required`, per-session containment
  verification). Native tests/typecheck/lint land first, followed by local-first API verification
  and Playwright browser verification per `docs/operator-observability-verification.md`.
- **Files:** `apps/api/src/modules/verification-planner.ts`,
  `apps/api/src/modules/harness/verification-runner.ts`,
  `apps/api/src/modules/harness/verifiers/*.ts`,
  `apps/api/src/modules/harness/secret-broker.ts` (new); adapter
  `provision()/verify()` extension for Claude/Codex where available.
- **Contracts:** `VerificationPlan/VerificationSpec/EvaluationResult` live; expanded
  browser/API/review kinds and artifact refs; `enforcement` block on results.
- **API:** verification results on session reads; task verdict endpoint logic in Control
  Plane (completed-but-verification-failed → retry/re-route/park).
- **Tests:** deterministic pre/post-change selection; a frontend change selects browser without
  the user naming Playwright; project-native Playwright wins over the scoped default; browser
  screenshots/console/page/network errors become artifact refs; API selection for route/schema
  changes; unavailable providers produce explicit skipped/blocked checks; verification failure
  after successful execution (outcome `completed`, plane decides); command policy (env reduction,
  cwd pinning, output caps); isolation ordering; below-required verification fails before RUNNING.
- **Acceptance:** a task with `required` failing tests ends session COMPLETED +
  verification failed, and the plane's decision is observable.
- **Rollback/risk:** verification is opt-in per request — zero-spec requests behave as today.
- **Depends on:** Phase 3 (Phase 4 not required).

## Phase 6 — Cockpit observability

- **Goal:** durable correlated drill-down (§11): Task → repository-scoped subtasks → session →
  phase → checkpoints → handoffs → verification → evidence → result. Cockpit renders managed
  executions separately from its best-effort observed external sessions.
- **Files:** `apps/api` read endpoints + `contracts.ts` capability additions; `apps/web`
  Task Detail session/verification panels; Cockpit consumes via the versioned meta handshake.
- **API:** additive read-only endpoints; `sessionState` becomes primary, legacy `state`
  deprecated (flip of the Phase 1 dual-field window).
- **Tests:** contract tests on the observability payload shapes; frontend smoke (existing
  gap — first frontend tests land here per ROADMAP "Next").
- **Acceptance:** every §11 state distinction renderable from durable reads alone.
- **Rollback/risk:** additive; low.
- **Depends on:** Phases 3–5 for data to show.

## Phase 7 — Recovery/concurrency hardening + real-adapter conformance

- **Goal:** full fault-injection matrix (§12 layer 4) green; lease sweeper productionized;
  retention/GC extensions (§10); real-adapter conformance runs (CI-with-creds) unlocking
  `toolGating`/`processIsolation`/`usageReporting` declarations for Claude/Codex.
- **Tests:** kill-mid-RUNNING restart matrix, stale-writer fencing, ambiguous-start probe,
  approval `delivery_unknown` settlement, orphan sweeps of profiles/worktrees.
- **Acceptance:** the design's reliability invariants (H-I3/4/8/12/14) each map to at least
  one passing fault test; real-adapter suite passing for both tier-1 adapters.
- **Rollback/risk:** hardening only; risk is flaky fault tests — quarantine lane + fix-first.
- **Depends on:** Phases 1–5.

## Phase 8 (optional) — Remote-runner seam

- **Goal:** only if a real remote use case is proven (ROADMAP "Later"): `RemoteAdapter`
  proxying the same adapter contract; cross-process heartbeats; event delivery dedup by
  `(sessionId, seq)`; runner auth. The Phase 0 contracts already carry the keys — no domain
  remodel.
- **Acceptance/risk:** defined when scheduled; explicitly out of current scope.

---

## Cross-cutting

- **Testing without live providers:** everything through Phase 6 runs on the fake adapter +
  scripted streams + in-repo SQLite (design §12); live creds appear only in Phase 7's
  conformance lane.
- **Migration discipline:** one phase = one reviewable PR train; no phase starts before the
  previous phase's acceptance is demonstrated (same rule as Phases 0–5 of the control plane).
- **Agentic OS alignment:** Composer (agentic-os-plan M2) slots in front of the Harness
  without contract change — `ExecutionRequest` fields map 1:1 onto `AgentSpec` sections;
  provisioning (M3) lands inside Phase 5's adapter extension work.
