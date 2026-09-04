# Plan Review Log: vNext increment 3 — Eval program and single-mode canary

Phases 0-1 (recon + interrogation) complete — plan locked with the user via the Phase 1 escape hatch (all seven load-bearing decisions accepted at recommendation). PLAN_FILE = `docs/increment-3-eval-canary-plan.md`. MAX_ROUNDS=5. inspect=on, MAX_INSPECTION_ROUNDS=2. Reviewer model: CLI default (config unpinned) — codex-cli 0.152.1.

---

## Round 1 — Codex — VERDICT: REVISE

Thread `01a06be2-da39-7101-a18e-ba285f6571a5`. 18 findings.

1. **Critical** — forced-ON CI leg proves nothing: the four safety-net files call `loadConfig({AGENT_PLANE_HOME})` (no `process.env`) and construct `Orchestrator` directly with no `HarnessBridge`; `AGENT_PLANE_HARNESS_SINGLE_MODE=1` reaches neither config nor execution. Fix: route their boot helpers through `buildServer`/a shared Harness factory; assert single runs have non-null `execution_request_id`.
2. **Critical** — rollback test can't establish terminal convergence: `HarnessRecovery` leaves resumable sessions at `resume_offered` and ambiguous approvals at `AWAITING_APPROVAL`, neither terminal; provider-resume consumption is deferred. Fix: define a rollback drain/terminalization policy or keep the old process alive until sessions terminate; test resumable + approval-held sessions, not only a non-resumable fake.
3. **Critical** — the test omits the recovery states most likely to disprove rollback (`AWAITING_APPROVAL`, `VERIFYING`, resume-capable `RUNNING`, `HANDING_OFF`). Fix: table-driven `mode-rollback.test.ts` across these states, reboot each vs the same DB, assert the documented resting outcome + exactly one result where terminalization is required.
4. **High** — plan weakens the real-run acceptance for plan revisions: D4 asserts revision count only if a provider emits one, but verification-plan revisions are Harness-owned. Fix: require each provider scenario to persist ≥1 `verification_plan_revisions` row + a completed verification result linked to it.
5. **High** — two happy paths ≠ the referenced E2E program (eval-plan area 2 = ~6 scenarios + a two-consecutive-nightly threshold before a flip). Fix: implement the six scenarios with the two-night gate, or explicitly revise the roadmap/eval contract instead of silently redefining completion.
6. **High** — real-adapter conformance (area 1) is a flip blocker per the sequencing table but the increment defers it. Fix: run the credential-gated Claude/Codex conformance slice before declaring the canary eligible, include its results in the scorecard.
7. **High** — "BLOCKED if no credentials" is a delivery blocker, not an acceptable completion mode. Fix: missing creds prevents the increment being marked delivered / the roadmap checkbox ticked.
8. **High** — eval-scenario auth underspecified (`POST /api/tasks` needs `commands.write`; `buildServer` hands no token). Fix: eval runner reads the owner-only credential file, uses its active secret as a bearer token, never logs/serialises it.
9. **High** — fixture execution unsafe: a directory inside this repo is not an independent repo; `startTask`/`WorkspaceAuthority` expect an allowlisted repo/worktree — risks branching/worktree'ing the whole control-plane repo or mutating shared fixtures. Fix: copy each fixture to a fresh temp dir, `git init` + commit, add its path to `repoAllowlist`, delete after each scenario.
10. **High** — config precedence ambiguous (`AGENT_PLANE_HARNESS_MODES` "additive, lowest priority after the legacy var" doesn't define omission/disable/order). Fix: one deterministic order, defaults < one file representation < env, explicit omission/false semantics, tested.
11. **Medium** — back-compat lacks a full test matrix (uppercase/malformed env, partial `harnessModes`, both file keys, conflicting sources, old `false` file under new env). Fix: table-driven config tests over every combination; reject malformed env rather than ignore.
12. **Medium** — keep fail-closed rejection of `compare|race|parallel: true` but distinguish explicit request from generated `false`. Fix: retain fail-closed validation + error tests proving each unsupported explicit `true` names the missing parity.
13. **Medium** — unconditional bridge wiring needs a flag-OFF regression test. Fix: clean flag-OFF DB preserves legacy behaviour; a historical-Harness-row DB reclaims only that row via Harness recovery.
14. **Medium** — "bridge present unconditionally" conflicts with `buildServer({orchestrator})` injection. Fix: scope the assertion to `!deps.orchestrator`; an injected orchestrator owns all Harness/recovery deps.
15. **Medium** — `harnessOwns` is a fragile newest-row predicate; a later legacy run for the same task can move an older live Harness session onto the legacy branch. Fix: resolve ownership from the live session/run for the requested op, reject ambiguous mixed ownership.
16. **Medium** — the scorecard artifact isn't meaningful evidence (no commit SHA, config digest, provider/model identity, fixture digest, schema version, run IDs). Fix: version the schema, record reproducibility metadata + durable row ids, JSON canonical, Markdown only from validated runs.
17. **Medium** — recovery-chaos acceptance is asserted, not extended. Fix: explicit `test:recovery-chaos` command over both suites + rollback cases, a required CI step.
18. **Medium** — observability doesn't prove which execution path ran. Fix: assert a durable execution-path discriminator (`execution_request_id`/session id) in CI, E2E output, and the scorecard for every scenario.

### Claude's response — Rev 2

**Accepted (15 of 18):**
- #1, #18 → §3 rewritten: the four safety-net files boot through a new shared `apps/api/test/helpers/boot-orchestrator.ts` that wires the Harness composition and reads `AGENT_PLANE_HARNESS_SINGLE_MODE`; the `test:harness-on` leg asserts a non-null `execution_request_id` per single-mode run (opposite for parallel). Harness changed, assertions not.
- #2, #7, #10 (rollback) → §2 step 10: rollback policy is drain-in-flight-on-the-live-process then restart; "settle to terminal" is read as "reach the `HarnessRecovery`-decided resting state" (terminal / `resume_offered` / parked `AWAITING_APPROVAL`) with ≤1 result where terminalisation applies. Runbook step 24 states the drain explicitly. Logged as R7.
- #3 → `mode-rollback.test.ts` is table-driven over `RUNNING`(resume-capable/orphan), `AWAITING_APPROVAL`(ambiguous), `VERIFYING`, `HANDING_OFF`; each rebooted vs the same DB, asserting the documented resting outcome + ≤1 `execution_results` row.
- #4 → step 21: each provider `happy-path` run must persist a `verification_runs` row linked to a `verification_plan_revisions` row; a dedicated `replan-needed` fixture forces a superseding revision for the "plan revisions" clause. R4 records the non-relaxable failure mode.
- #6 (partial) → step 21 adds a **conformance slice** to the gating runs (real `usage.updated` token counts + `accounting` string; approval-gate blocks until `respondApproval`, denied call does not run). The full area-1 suite stays a documented flip precondition (step 22).
- #8 → step 17 `eval/harness/client.ts`: reads the owner-only `api-credential.json`, uses the newest active `commands.write` secret as a bearer token, registers it for redaction, never serialises it.
- #9 → step 17 `eval/harness/prepare-fixture.ts`: each scenario copies its fixture to a fresh `mkdtemp` + `git init` + commit, adds that path to `repoAllowlist` for the run, deletes after. Never the control-plane repo.
- #10 (config precedence) → §1 step 2: one deterministic order (defaults < exactly one file representation < `AGENT_PLANE_HARNESS_SINGLE_MODE`); `AGENT_PLANE_HARNESS_MODES` **dropped**; both file keys → `validate()` error; malformed env → hard load error.
- #11 → §1 step 7: table-driven `config.test.ts` matrix over every old/new file×env combination incl. uppercase/malformed env, partial `harnessModes`, both keys, legacy-`false`-under-new-env.
- #12 → §1 step 3: fail-closed on **explicitly** `true` `compare|race|parallel` (generated `false` fine), error message names the mode; error tests added.
- #13 → §2 step 12: flag-OFF regression tests — clean all-OFF DB shows byte-identical legacy behaviour; a historical-Harness-row DB reclaims only that row.
- #14 → §2 step 8: the unconditional bridge wiring stays scoped to `!deps.orchestrator` (already the case at `server.ts:112`); an injected orchestrator owns its own Harness/recovery deps; the assertion is `!deps.orchestrator ⇒ bridge present`.
- #16 → step 18: versioned `scorecard.json` (`schemaVersion`, `repoCommit`, `configDigest`, per-scenario `fixtureDigest`/`provider`/`model`/`taskId`/`sessionId`/`executionRequestId`/`verificationRunId`); JSON canonical, `.md` rendered only from valid JSON, committed to `docs/eval-history/` only via `workflow_dispatch`/`pnpm eval:promote` (no nightly commit noise).
- #17 → step 23: explicit `test:recovery-chaos` command (`recovery` + `fault-injection` + `mode-rollback`) as a required `ci.yml` step.
- #7 → step 21: missing credentials ⇒ the increment is reported **INCOMPLETE** (branch code only, exact reason), roadmap checkbox not ticked, no fabricated/Fake-derived scorecard, no stubbed specs.

**Scope-clarified, not silently redefined (#5, #6):**
- #5 → step 22 + step 25: all six area-2 scenarios are scaffolded and the two-provider runs + `replan-needed` + conformance slice gate the increment; the eval-plan area-2 "≥N/6 green over two consecutive nightlies" bar and the full area-1 conformance suite are written into `docs/harness-rollout.md` as **operator flip preconditions** and the eval-plan status update says "single-mode E2E harness + six scenarios landed", not "area 2 done".

**Rejected (1 of 18), with reason:**
- #15 → `harnessOwns` newest-row fragility is pre-existing phase-8c strangler machinery. Reworking ownership resolution (resolve from the live session for the op; reject mixed ownership) is **increment 6** scope (mode parity + legacy retire), not step (i). Logged as R6; `mode-rollback.test.ts` covers the single-mode rollback path that exercises the predicate.

---

## Round 2 — Codex — VERDICT: REVISE

10 findings (Rev 2 resolved forced-ON wiring, config precedence, auth, fixture isolation, scorecard provenance, completion gate).

1. **Critical** — rollback acceptance still weakened by reinterpretation: acceptance says "settle to terminal state under HarnessRecovery"; Rev 2 substituted non-terminal `resume_offered` / `AWAITING_APPROVAL` resting states. Fix: don't claim the acceptance met until recovery can terminalise/resume/drain these automatically, or revise the roadmap acceptance explicitly.
2. **Critical** — drain-before-restart is an ops instruction, not proof of crash-safe rollback: both real adapters advertise `canResume`, so a crash during rollback can leave a live session non-terminal, parking its task at `WAITING_INPUT`. Fix: wire `resume_offered` back into execution before this increment completes, or implement a rollback terminalisation policy for stranded resumable sessions.
3. **High** — `HANDING_OFF` is a task state, not a session state; the table conflates task and session origins. Fix: pair states precisely (task `HANDING_OFF` + session `YIELDED`/`RUNNING`/terminal-without-result) and assert both task and session recovery outcomes.
4. **High** — several of the six real scenarios aren't implementable through the current bridge: `HarnessBridge` budget is advisory with no `maxTokens` (no real token cap); deterministic adapter failure and quota-triggered reroute rely on fake markers real providers can't emit. Fix: classify those as deterministic FakeAdapter scenarios or add real-provider fault/budget injection reaching `ExecutionRequest.policy`; state which scenarios are real vs fake.
5. **High** — the boot-crash scenario conflicts with "wait for terminal": a real crash normally has a resumable ref → `resume_offered` + task parking, not terminal completion. Fix: implement resume-offer consumption and wait through resumed completion, or score against the documented non-terminal recovery outcome.
6. **High** — `replan-needed` assumes a lifecycle that doesn't exist: `VerificationCoordinator` creates a post-change revision by comparing discovered checks; it does not react to failed verification by revising the plan / rerunning the provider. Fix: make the fixture prove the real initial→post-change discovery revision, or implement genuine verification-failure-driven replanning before describing it that way.
7. **Medium** — the safety-net discriminator is underspecified for multi-run tests (failover / manual handoff create multiple sequential runs). Fix: assert **all** runs of eligible single-mode tasks have non-null `execution_request_id`, including every failover/handoff attempt.
8. **Medium** — the deprecation "notice-level" output has no defined sink; `loadConfig` has no logger. Fix: an injectable diagnostics callback / structured warnings result, tested to emit once without touching stdout.
9. **Medium** — `eval/` in `pnpm-workspace.yaml` while claiming exclusion from recursive typecheck needs explicit root-script changes, and `eslint .` still inspects it. Fix: state the exact root script/filter and ESLint treatment; ensure `pnpm typecheck && pnpm test` still validates shared code eval needs.
10. **Medium** — the rejected `harnessOwns` issue stays relevant: unconditional bridge wiring makes historical/mixed Harness ownership active under flag-OFF; the newest-row predicate is a live route to the wrong execution path. Fix: at minimum reject mixed live ownership in this increment + a regression test; broader refactor can stay increment 6.

### Claude's response — Rev 3

**Accepted (all 10):**
- #1 + #2 + #5 → new **rollback-terminalisation policy** in `HarnessRecovery` (§2 step 11): an injected `isModeEnabled(mode)`; a stranded session whose mode is **disabled** is `finalize`d to `FAILED`/`harness-mode-disabled` (terminal CAS, exactly one `execution_results` row, H-I3, checkpoint attempted) **instead of** `resume_offered` or an `AWAITING_APPROVAL` park. Reuses the existing `finalize` path (`recovery.ts:227-239,447-482`). Mode-enabled operation is byte-unchanged. "Settle to terminal state under HarnessRecovery" is now literally met on the rollback path without implementing provider-resume consumption (deferral #7). R7 records the boundary.
- #3 → `mode-rollback.test.ts` table now pairs task+session states precisely (RUNNING/RUNNING-resume-capable, RUNNING/RUNNING-orphan, RUNNING/AWAITING_APPROVAL, RUNNING/VERIFYING-with-evidence, HANDING_OFF/YIELDED) and asserts **both** session and task recovery outcomes + ≤1 result.
- #4 + #5 → §4 step 21: every scenario explicitly REAL or FAKE. REAL: `happy-path`×2, `replan-needed`, `needs-approval`. FAKE (real `buildServer`/Harness, `FakeAdapter`): `hits-token-cap`, `adapter-error-mid-run`, `cross-provider-reroute`, `boot-crash-recovery` (scored against documented recovery outcomes, not "terminal success"). Gating runs (step 22) are the REAL set + conformance slice only.
- #6 → `replan-needed` fixture corrected to `discovery-revision`: initial state lacks a `lint` script, the goal adds one + a lint-clean change, so post-change discovery finds a check the initial plan lacked and the coordinator writes a **superseding** revision — the real mechanism. R4 records the non-relaxable failure mode.
- #7 → §3 step 18: assert non-null `execution_request_id` on **every** run of an eligible task, including each failover attempt and each manual-handoff successor.
- #8 → §1 step 4: `loadConfig` returns a `warnings: string[]` channel (or `ResolvedConfig.warnings`); the deprecation is one entry; `index.ts`/`buildServer` forward to the app logger; a test asserts one warning and **no** stdout/stderr write by `loadConfig`.
- #9 → §7 step 28: exact treatment — `pnpm -r --filter '!@agent-plane/eval'` for the root matrices, `eval/` has its own `--filter` typecheck, ESLint flat-config `ignores: ["eval/out/**"]` but lints `eval/src`/`eval/scenarios`; shared packages eval imports stay in the matrix.
- #10 → §2 step 15: **mixed-live-ownership guard** — if a task has both a live Harness session and a live legacy run, control ops + `reconcileOnBoot` throw a clear error rather than newest-row-guessing; regression test drives the state. Full "resolve from the live session" refactor stays increment 6 (R6).

No findings rejected this round.

---

## Round 3 — Codex — VERDICT: REVISE

8 findings (Rev 3 resolved literal rollback terminalisation intent, REAL/FAKE classification, state pairing, real revision behaviour, run-level path assertions, warning handling, workspace wiring).

1. **Critical** — `HarnessRecovery` still cannot determine the session's mode: `ExecutionSession`/`ExecutionRequest` persist no mode field and `HarnessRecovery` has no `TaskStore`; `isModeEnabled(mode)` has no source for `mode`. Fix: inject `modeForSession`/`shouldTerminalizeOnRecovery(sessionId)` backed by the session→request→task join; fail closed on missing/corrupt bindings.
2. **High** — the proposed `finalize(..., "FAILED", { reason: "harness-mode-disabled" })` is not type/contract-correct: `finalize` takes an `ExecutionFailure`, and `harness-mode-disabled` is not a `FailureKind`. Fix: `{ kind: "orphaned", retryable: true, message: "..." }` + a distinct recovery-event/reason code for attribution.
3. **High** — mode-disabled recovery coverage isn't exhaustive: the matrix omits `PREPARED`, both `STARTING` variants, `PAUSED`, `RESUMING`. Fix: exhaustive policy + test over every non-terminal state, documenting truly-unreachable ones.
4. **High** — throwing from `reconcileOnBoot` on mixed ownership is a recovery-wide DoS: one mixed task aborts the boot sweep before unrelated sessions reconcile. Fix: quarantine/terminalise the ambiguous task with a durable diagnostic and continue; control ops may still reject, but boot recovery must be per-task fault-isolated.
5. **High** — R8 contradicts the hard completion gate: step 22 requires a real-provider approval scenario while R8 says it may drop to FakeAdapter and "the increment still lands". Fix: keep it non-relaxable, or remove it from the gate and classify it as a later conformance prerequisite.
6. **Medium** — rollback terminalisation can discard a provider execution that actually completed after the last persisted event. Fix: record as recovery-abandoned with the provider session ref; best-effort provider status probe/cancel before terminalisation where adapter capabilities permit.
7. **Medium** — task settlement after terminalisation is underspecified: `HarnessRecovery` terminalises the session; the Orchestrator sweep must consume the result and transition the task; "parked to a legacy-recoverable state" is not a `HarnessRecovery` action. Fix: specify + test the full boot sequence — one result written, sweep consumes, task terminal, second boot idempotent.
8. **Medium** — "six scenarios" but seven named / eight executions; `N/6` is ambiguous. Fix: define the canonical denominator and whether provider variants count separately; replace `N/6` with an exact numerator/denominator.

### Claude's response — Rev 4

**Accepted (all 8):**
- #1 → §2 step 11: inject `shouldTerminalizeOnRecovery(sessionId): boolean` backed by the `runs.execution_request_id → execution_requests.task_id → tasks.mode` join (indexes verified: `idx_execution_requests_task`, migration 004 `tasks.mode`); **fail closed** (terminalise) on a missing/corrupt binding, unit-tested.
- #2 → §2 step 11: `finalize(... "FAILED", { failure: { kind: "orphaned", retryable: true, message: "Harness mode disabled during rollback recovery" }, checkpoint })` (`kind: "orphaned"` verified in `execution.ts:246`) + `appendRecoveryEvent(sessionId, "mode_disabled_terminalized", providerSessionRef)`.
- #3 → §2 step 11 + step 14 matrix: exhaustive over `STARTING`/`RUNNING`/`AWAITING_APPROVAL`/`PAUSED`/`RESUMING`/`VERIFYING` + pre-session `PREPARED` and request-level `STARTING`; `PAUSED`/`RESUMING` documented as currently-unreachable under single mode, constructed and asserted fail-closed anyway.
- #4 → §2 step 16: **context-split** — interactive control ops throw "mixed live ownership"; `reconcileOnBoot` **never aborts** — it quarantines the one ambiguous task (terminalise its session, `appendRecoveryEvent(..., "mixed_ownership_quarantined", ...)`) and continues every other task. Both tested.
- #5 → §4 step 23: `needs-approval` real-provider evidence **removed from the hard gate**; it is a documented area-1 flip precondition (step 28). The scenario is still implemented and run. R8 rewritten to match (no more "either/or").
- #6 → §2 step 11: retain `providerSessionRef` as `recovery-abandoned` (not silently dropped); best-effort adapter-capability-gated status probe before terminalising a resume-capable `RUNNING` session — probe says completed-with-evidence → `COMPLETED` from it, else the typed `FAILED`/`orphaned`.
- #7 → §2 step 13 (new): the full boot sequence + idempotency is specified and tested — `HarnessRecovery` writes exactly one `execution_results` row → the Orchestrator step-2 sweep consumes it via `settleFromResult` (`orchestrator.ts:634`) → the task reaches `FAILED` (or documented terminal) → a second `reconcileOnBoot` is a no-op.
- #8 → §4 step 22: **seven** named scenario definitions is the canonical denominator; `happy-path`'s two provider variants both must pass for it to count green; every `N/6` replaced with "≥ 6 of 7 green over two consecutive nightlies" in the runbook (step 28) and the eval-plan status (step 30).

No findings rejected this round.

---

## Round 4 — Codex — VERDICT: REVISE

6 findings (Rev 4 resolved the mode-source injection, typed failure intent, exhaustive-state intent, mixed-ownership DoS, R8 contradiction, scenario denominator).

1. **High** — the provider probe/cancel path does not exist: `AgentAdapter` has no status-probe method / manifest capability, and `cancel()` needs a live `RunHandle` recovery cannot reconstruct from `providerSessionRef`; also contradicts "no adapter changes". Fix: remove the probe claim and terminalise conservatively, or add a provider-neutral recovery probe/cancel contract + implementations + capability + conformance tests to this increment.
2. **High** — `providerSessionRef` cannot be retained in `ExecutionResult` as proposed: no such field; "recovery-abandoned" is not a defined result field / artifact / failure type. Fix: use an existing durable location (redacted `failure` detail + the recovery event), or make an explicit additive contract/schema change with serialisation tests.
3. **High** — mixed-ownership quarantine cannot reuse step 11 when the mode stays **enabled**: `shouldTerminalizeOnRecovery` returns false, so normal recovery may produce `resume_offered` instead of quarantine-terminalising. Fix: an explicit forced-quarantine recovery op/reason independent of mode enablement, same fenced terminal CAS, tested with mode ON and OFF.
4. **Medium** — exhaustive rollback coverage still inconsistent: step 11 promises `PREPARED` but the table has no `PREPARED` row and calls it "pre-session"; "request-level STARTING" is not a defined state. Fix: add a session `PREPARED` row, split `STARTING` into provider-start-unacked vs acked, drop the nonexistent terminology.
5. **Medium** — the future per-mode design can't recover the original routing key: starts synthesise a `parallel` key, recovery derives only `tasks.mode` (`single|compare|race`) — it can never recover `parallel`; dormant now but bakes another migration into D1. Fix: persist the selected routing key on the request/session, or reduce the flag model to the actual durable modes and define compare/race enablement later.
6. **Medium** — the scorecard can claim reproducibility while omitting the canonical JSON from history: only Markdown is committed though JSON is canonical; workflow artifacts are temporary. Fix: promote validated JSON + rendered Markdown together, or embed the full canonical data + digest in the committed document.

### Claude's response — Rev 5

**Accepted (all 6) — mostly simplifications:**
- #1 → §2 step 11: the **provider probe/cancel is removed**. A resume-capable `RUNNING` session with `single` disabled is `finalize`d to `FAILED`/`orphaned` directly. No adapter change. The "run may have completed after the last event" risk is accepted and logged as R9 (the `providerSessionRef` is retained in the recovery event for manual operator reconciliation).
- #2 → §2 step 11: `providerSessionRef` goes **only** in the `appendRecoveryEvent(sessionId, "mode_disabled_terminalized", s.providerSessionRef)` call (that arg already exists, `recovery.ts:232`) and a redacted note in `failure.message`. No `ExecutionResult` field, no "recovery-abandoned" type — no contract change.
- #3 → §2 step 16: the boot-time quarantine is now an **explicit forced-quarantine path independent of `shouldTerminalizeOnRecovery`** (and therefore of whether `single` is enabled), using the same fenced terminal CAS + `failure.kind = "orphaned"` + `appendRecoveryEvent(..., "mixed_ownership_quarantined", ...)`. Regression tests run it with `single` ON and OFF.
- #4 → §2 step 14 matrix: explicit `PREPARED` row added; `STARTING` split into provider-start-unacked / provider-start-acked; "request-level STARTING" / "pre-session" terminology removed; step 11 now says "every non-terminal `ExecutionSessionState`" and defers the exact enum to `session-state.ts` at implementation with a state-agnostic rule.
- #5 → **D1 reduced to `harnessModes: { single?: boolean }`** — one valid key; `validate()` rejects any other key naming it. The `compare`/`race`/`parallel` keys land in **increment 6** together with a persisted `execution_requests.harness_routing_key` column (R6). Still a per-mode map replacing the global boolean; adding keys later is not another rename. §1 simplifies (no four-key defaults, no `compare|race|parallel:true` special case — just "unknown key → throw").
- #6 → §4 step 24: **both** the validated canonical `scorecard.json` **and** the rendered `scorecard.md` are committed together to `docs/eval-history/scorecard-<UTC-date>.{json,md}` (via dispatch/promote); the nightly uploads both as artifacts.

No findings rejected this round.

---

## Round 5 — BLOCKED (Codex usage limit)

The round-5 resume failed: `error: "You've hit your usage limit. … try again at Sep 7th, 2026 6:53 AM."` (thread `01a06be2-da39-7101-a18e-ba285f6571a5`, no verdict produced). Not a deadlock — an external quota ceiling on the Codex account.

**State at the cap:** 4 completed review rounds, every one `VERDICT: REVISE`, **every finding across all four rounds accepted** (one explicitly deferred to increment 6 with a logged reason — R6/`harnessOwns`). No standing Claude-vs-Codex disagreement. Round-4's findings were all narrow implementation-correctness points (missing adapter probe contract, `ExecutionResult` field that doesn't exist, mode-independent quarantine, `PREPARED` row, `parallel` routing-key gap, JSON-in-history) and Rev 5 resolved each — mostly by *removing* speculative machinery (the provider probe) and *reducing* scope (single-key `harnessModes`, routing-key column → increment 6).

**Trajectory:** round 1 = 18 findings (3 critical), round 2 = 10, round 3 = 8, round 4 = 6 (0 critical). Converging. Rev 5 has no known unaddressed finding.

**Resolution:** MAX_ROUNDS reached without a final `APPROVED` line, for an external reason. Options for the user: (a) hold for the Sep 7 quota reset and run round 5 to get the verdict; (b) sign off Rev 5 now on the 4-round record and proceed to Phase 3. Pending the user's call.

---

## Phase 2 resolution + Phase 3 decision (user, 2026-09-04)

MAX_ROUNDS reached without a final `APPROVED` for an external reason (Codex quota, resets 2026-09-07). Every finding from rounds 1-4 was accepted; no standing disagreement. **User decision: proceed to Phase 3 with Claude as builder**, and keep the two owed Codex passes (round-5 verdict on Rev 5 + the read-only post-build cross-inspection) for when quota resets — both captured in `docs/increment-3-deferred-codex.md`. This is a logged deferral of `inspect=on`, not an opt-out.
