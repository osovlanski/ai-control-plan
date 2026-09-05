# Plan: vNext increment 3 — Eval program and single-mode canary

_Locked via claudex-loop — by Claude + the user (Phase 1 escape hatch: all load-bearing decisions accepted at recommendation). Rev 5 after Codex review rounds 1-4._

## Goal

Convert the flag-OFF Execution Harness from dark code into observable, evidenced behaviour, and make single-mode execution safe to enable **per mode** without touching the production default. Deliverables: (a) a per-mode enablement flag replacing the global `execution.harnessSingleMode` boolean; (b) a credential-gated end-to-end eval program (`eval/` tree) with a versioned, reproducible, committed scorecard; (c) proof that the four safety-net test files stay green with single mode ON **while actually exercising the Harness path**; (d) a **rollback-terminalisation policy** in `HarnessRecovery` plus its proving test, so disabling a mode reverts *new* starts to the legacy path **and** any in-flight Harness session for that mode settles to a terminal state on the next boot; (e) `docs/harness-rollout.md`, the staged canary + rollback runbook. CR-4 migration **step (i) only** — no compare/race/parallel parity, no legacy-path deletion, no `Orchestrator`→`ControlPlane` rename, committed production default stays all-modes-OFF.

## Approach

### 1. Per-mode flag (D1; R1-#10/#11/#12, R2-#8)

1. `config.ts`: replace `execution.harnessSingleMode?: boolean` with
   `execution.harnessModes?: { single?: boolean }`. Default: `execution: { harnessModes: { single: false } }`.
   **One key only this increment (R4-#5).** `tasks.mode` is `single | compare | race` and has no `parallel`; starts synthesise a `"parallel"` routing key from `options.parallel` that recovery cannot reconstruct from durable state. Rather than bake that mismatch into a four-key type, `harnessModes` carries `single` alone now; **increment 6** adds the `compare`/`race`/`parallel` keys *together with* a persisted `execution_requests.harness_routing_key` column so recovery can derive the key. The type is already an object, so adding keys later is not another rename.
2. **Single deterministic precedence** (lowest → highest), exhaustively tested:
   1. default (`single: false`).
   2. **exactly one** file representation: `execution.harnessModes` **or** the deprecated `execution.harnessSingleMode` — a file setting **both** is a `validate()` error. `harnessSingleMode: true|false` maps to `harnessModes.single`; the raw key is never persisted back.
   3. `AGENT_PLANE_HARNESS_SINGLE_MODE` env: exactly `1|true|0|false` (case-insensitive); any other non-empty value is a hard load error (no silent ignore). Present ⇒ sets `harnessModes.single`, overriding the file. Absent/empty ⇒ no-op. No new `AGENT_PLANE_HARNESS_MODES` var.
3. `validate()` throws when: both file keys set; `harnessModes.single` is non-boolean; `harnessModes` carries **any key other than `single`** (message: "`<key>` mode has no Harness parity — increment 6", cites §3.4).
4. **Deprecation-warning sink (R2-#8).** `loadConfig` currently has no logger. Change its return to `{ config: ResolvedConfig; warnings: string[] }` (or add `ResolvedConfig.warnings: string[]` — pick the smaller diff across call sites). The `harnessSingleMode` deprecation is one `warnings` entry. `index.ts` / `buildServer` forward `warnings` to the app logger at startup. A test asserts exactly one warning is produced for a legacy-key file and **nothing is written to stdout/stderr** by `loadConfig` itself.
5. The generated-config YAML comment describes `harnessModes` and notes `harnessSingleMode` is deprecated (accepted one release).
6. `orchestrator.ts` `harnessRouting(taskId, options)`: `false` unless `this.harnessBridge` **and** `this.config.execution?.harnessModes?.single === true` **and** the task is single-mode (`!options.parallel` and `mode` is neither `compare` nor `race`, `mode = this.tasks.get(taskId)?.mode`). Byte-equivalent to today's `harnessSingleMode` behaviour. Update the `harnessBridge` constructor doc comment.
7. Migrate every reader of the old key: `config.test.ts`, `cutover.test.ts`, `characterization-harness.test.ts`, `project-verification-cutover.test.ts`, the four safety-net boot helpers (§3). Grep for `harnessSingleMode` returns only the `config.ts` shim + the deprecation-path test.
8. `config.test.ts` table-driven matrix: `harnessModes.single` on/off; legacy key `true`/`false`; both keys → throw; legacy env `1`/`true`/`0`/`false`/`FALSE`/malformed→throw; legacy env over each file representation; `harnessModes` with an unknown key (`compare`/`race`/`parallel`/typo) → throw naming the key; `single` non-boolean → throw; legacy-key file emits exactly one warning.

### 2. Composition + rollback safety (D6; R1-#2/#3/#13/#14, R2-#1/#2/#3/#5/#10)

9. `buildServer` constructs `harnessBridge` whenever `!deps.orchestrator` — **not** gated on any `harnessModes` value. `harnessRecovery` is already unconditional (`server.ts:100`). Existing `!deps.orchestrator` scoping preserved: a `buildServer({ orchestrator })` caller owns its Harness/recovery deps. The `server.ts:202` assertion becomes: `!deps.orchestrator ⇒ harnessBridge present`.
10. `harnessRouting()` stays the **only** flag-gated *start* decision. `harnessOwns(taskId)` (newest `runs` row has non-null `execution_request_id`) is unchanged and flag-independent.
11. **Rollback-terminalisation policy (new, in `HarnessRecovery`; R3-#1/#2/#3/#6, R4-#1/#2/#4).**
    - **Mode source.** Neither `ExecutionSession` nor `ExecutionRequest` persists an execution mode and `HarnessRecovery` has no `TaskStore`. Inject `shouldTerminalizeOnRecovery(sessionId): boolean`, backed by the `runs.execution_request_id → execution_requests.task_id → tasks.mode` join (`idx_execution_requests_task`; `tasks.mode` migration 004). A Harness session only ever exists for a `single`-mode task (`compare`/`race` are rejected at start), so this reduces to "is `harnessModes.single` currently `false`". A **missing or corrupt** session→request→task binding → return `true` (**fail closed** — terminalise, never silently resume). Unit-test the missing/corrupt binding.
    - **Typed failure (R3-#2).** Terminalisation calls the existing `finalize(sessionId, s, lease, "FAILED", { failure, checkpoint })` (`recovery.ts:239,447-482`) with `failure = { kind: "orphaned", retryable: true, message: "Harness single mode disabled during rollback recovery; providerSessionRef=<redacted-ref>" }` (`kind: "orphaned"` is a real `FailureKind`, `execution.ts:246`) **plus** `appendRecoveryEvent(sessionId, "mode_disabled_terminalized", s.providerSessionRef)` — the recovery **event** carries the `providerSessionRef` for machine-readable attribution (`appendRecoveryEvent` already takes that detail arg, `recovery.ts:232`). No new `ExecutionResult` field; no probe/cancel of the provider (R4-#1: `AgentAdapter` has no status-probe and `cancel()` needs a live `RunHandle` recovery cannot reconstruct — out of scope, no adapter change).
    - **Exhaustive over every non-terminal session state (R3-#3, R4-#4).** The policy and the `mode-rollback.test.ts` matrix cover every non-terminal `ExecutionSessionState`: `PREPARED`, `STARTING` (provider-start-unacked and provider-start-acked), `RUNNING` (resume-capable and orphan), `AWAITING_APPROVAL`, `PAUSED`, `RESUMING`, `VERIFYING`. `PAUSED`/`RESUMING` are **not reachable under single mode today** (the plane does not drive them, eval-plan §4) — the test constructs those rows directly and asserts the fail-closed terminalisation anyway. (The exact set of persisted non-terminal session states is confirmed against `packages/core/src/session-state.ts` at implementation; the policy's rule — "not terminal ⇒ terminalise when `single` disabled" — is state-agnostic.)
    - `COMPLETED` (crashed mid-VERIFYING with durable evidence — `finalize(... "COMPLETED" ...)` from that evidence, unchanged), `FAILED`, `CANCELLED`, `TIMED_OUT`, `YIELDED`, `already_terminal` — unchanged.
    - With `single` **enabled** (normal operation) every decision is exactly as today — a resume-capable crash still yields `resume_offered` (R7). A provider run that completed after the last persisted event and before a mode-disabled reboot is terminalised as `FAILED`/`orphaned` with its `providerSessionRef` in the recovery event; an operator can inspect that ref (R9).
12. **Rollback policy in the runbook** = graceful path: set the mode `false`, let the live process drain in-flight Harness sessions to terminal (new starts already route legacy), then restart. Step 11 is the crash-safety net if the process dies mid-drain.
13. **Full boot sequence + idempotency (R3-#7).** `HarnessRecovery` only writes the terminal `execution_results` row; the task transition is the existing Orchestrator `reconcileOnBoot` step-2 sweep consuming that row via `settleFromResult` (`orchestrator.ts:634`). The test asserts the whole sequence: recovery writes exactly one result → the sweep consumes it → the **task** reaches `FAILED` (or the documented terminal state) → a **second** `reconcileOnBoot` is a no-op (`already_terminal`, no new rows).
14. New `apps/api/test/harness/mode-rollback.test.ts`, **table-driven** over precisely-paired origin states (R2-#3, R3-#3):
    | task state | session state | expected under `single`-OFF reboot |
    |---|---|---|
    | ROUTING/RUNNING | PREPARED (crashed before any lease) | `FAILED`/`orphaned` `mode_disabled_terminalized`, 1 result |
    | ROUTING/RUNNING | STARTING, provider-start-unacked | `FAILED`/`orphaned` `mode_disabled_terminalized`, 1 result |
    | RUNNING | STARTING, provider-start-acked (start-ambiguous) | `FAILED`/`orphaned` `mode_disabled_terminalized`, 1 result |
    | RUNNING | RUNNING, resume-capable (`canResume` + `providerSessionRef`) | `FAILED`/`orphaned` `mode_disabled_terminalized`, `providerSessionRef` in the recovery event, 1 result |
    | RUNNING | RUNNING, orphan (no resumable ref) | `FAILED`/`orphaned`, checkpoint attempted, 1 result |
    | RUNNING | AWAITING_APPROVAL (ambiguous) | `FAILED`/`orphaned` `mode_disabled_terminalized`, 1 result |
    | RUNNING | VERIFYING with durable evidence | `COMPLETED` from evidence, 1 result (unchanged) |
    | (constructed) | PAUSED / RESUMING | fail-closed `FAILED`/`orphaned`, 1 result (unreachable under single mode today — asserted anyway) |
    | HANDING_OFF | YIELDED | session `already_terminal`; task handoff resolved by the existing legacy sweep |
    For each: drive/construct a single-mode Harness session at that state (fakes, in-process, abandon-the-lease); set `harnessModes.single = false`; then
    (a) a fresh `startTask` for a **new** task takes the legacy path — no `execution_requests` row for it, legacy `runs` row present, `harnessRouting` false;
    (b) a fresh production-equivalent `Orchestrator` + `HarnessRecovery` (`shouldTerminalizeOnRecovery` resolving to `true` for `single`) against the same DB → `reconcileOnBoot` → assert the table outcome, **exactly one** `execution_results` row, no second start, **both** session and task terminal/legacy-recoverable, and idempotency per step 13.
15. Flag-OFF regression tests (R1-#13): a clean all-modes-OFF DB through `buildServer` shows byte-identical legacy behaviour (no `execution_requests`/session rows; `reconcileOnBoot` uses the legacy blanket-fail path); a DB seeded with a historical Harness row + all modes OFF reclaims **only that row** via Harness recovery and leaves legacy rows to the legacy sweep.
16. **Mixed-live-ownership guard (R2-#10, narrowed R1-#15) — context-split (R3-#4).** If a task has **both** a live (non-terminal) Harness session **and** a live legacy run:
    - **interactive control ops** (`cancelTask`/`respondApproval`/`createCheckpoint`/`handoff`) → throw a clear "mixed live ownership" error (caller decides).
    - **`reconcileOnBoot`** → **per-task fault isolation, never abort the sweep**: a dedicated **forced-quarantine** path — independent of `shouldTerminalizeOnRecovery` and therefore of whether `single` is enabled (R4-#3) — terminalises the ambiguous task's Harness session through the **same fenced terminal CAS** `finalize` uses, with `failure.kind = "orphaned"` and `appendRecoveryEvent(..., "mixed_ownership_quarantined", ...)`, then **continues** reconciling every other task. A boot-wide throw is prohibited (it would strand unrelated sessions — the exact failure the rollback guarantee must not have).
    Regression tests drive both contexts **with `single` ON and OFF** (R4-#3). The full "resolve ownership from the live session for the requested op" refactor stays **increment 6** (R6).

### 3. Safety-net files green with single mode ON, on the Harness path (D5; R1-#1/#18, R2-#7)

17. Root cause: `characterization/orchestrator/failover/parallel.test.ts` each `loadConfig({ AGENT_PLANE_HOME })` (no `process.env`) and `new Orchestrator(...)` directly with no bridge — an env flag reaches nothing. Fix the **harness**, not the assertions:
    - `apps/api/test/helpers/boot-orchestrator.ts`: builds an `Orchestrator` **with** the Harness composition (bridge + recovery + session store) wired exactly as `buildServer`, taking an explicit `harnessModes` arg (default all-OFF) and reading `AGENT_PLANE_HARNESS_SINGLE_MODE` into it.
    - the four files' `beforeEach` helpers call it. `harnessModes` OFF ⇒ existing assertions byte-unchanged and green (current per-PR leg).
18. Second vitest project `test:harness-on`: re-runs `apps/api/test/{characterization,orchestrator,failover,parallel}.test.ts` + `apps/api/test/harness/**` with the factory forced to `harnessModes: { single: true }`. Added to `ci.yml` after the normal `pnpm test`. Both legs gate every PR.
19. **Execution-path discriminator, asserted for every run (R2-#7):** in the ON leg, for every task eligible for single-mode Harness routing, **every** `runs` row it produced — including each failover attempt and each manual-handoff successor — has a non-null `execution_request_id`. `parallel.test.ts` asserts the opposite for its parallel runs. A completion-only pass that silently used the legacy path fails the leg.
20. Any ON-leg failure is a real single-mode parity gap fixed **in this increment**; the four files' assertions are never weakened. A fix ballooning past scope is a stop-and-re-plan signal (R1).

### 4. Eval program (D2/D3/D4/D7; R1-#4/#5/#6/#7/#8/#9/#16, R2-#4/#5/#6)

21. New `eval/` workspace tree (added to `pnpm-workspace.yaml`; see §7 for exact matrix/lint treatment):
    - `eval/fixtures/<name>/` — a minimal real TypeScript project skeleton + `expected.md`. Ship two:
      - `failing-test` — a red unit test the goal must make pass by editing one file (used by `happy-path`).
      - `discovery-revision` — the fixture's initial state has **no** `lint` script; the goal adds a lint script + a lint-clean change, so post-change discovery finds a check the initial verification plan lacked and `VerificationCoordinator` writes a **superseding** `verification_plan_revisions` row (this is the *actual* revision mechanism — coordinator compares initial vs post-change discovered checks; it does **not** react to failed verification, R2-#6). Used by `replan-needed`.
    - `eval/harness/prepare-fixture.ts` — per scenario: copy the fixture to a fresh `mkdtemp`, `git init` + `git add -A` + commit, return the path; teardown deletes it. The scenario adds that path to `repoAllowlist` for its `buildServer` config. Never the control-plane repo (R1-#9).
    - `eval/harness/client.ts` — reads the workspace's owner-only `api-credential.json`, picks the newest active secret with `commands.write`, calls the API with `Authorization: Bearer <secret>`. The secret is registered in the redaction literal set; never written to a scorecard/log/artifact (R1-#8).
    - `eval/scorer.ts` — per scenario: `reachedTerminal`, `terminalState`, `verificationRan`, `verificationPassed`, `verificationPlanRevisions` (row count), `verificationRunId`, `durableSessionCount`, `executionRequestId` (path discriminator — non-null for real scenarios), `checkpointCount`, `failoverCount`, `wallClockMs`, `totalTokens`, `usageAccountingPresent`, `executionResultsOutcome`.
    - `eval/run.ts` + root `pnpm eval` → writes `eval/out/scorecard.json` (canonical) and renders `eval/out/scorecard.md` **only from a schema-valid JSON**.
22. **Scenario set — seven named scenario *definitions* (the canonical denominator, R3-#8), each explicitly classified REAL or FAKE (R2-#4/#5).** `happy-path` has two provider variants (Claude, Codex) and counts "green" only when **both** pass; the other six are single executions. Denominator for the rollout threshold = **7**.
    | scenario | kind | why |
    |---|---|---|
    | `happy-path` (×2: Claude, Codex) | **REAL** | trivial one-file goal; the two provider gating runs |
    | `replan-needed` (one provider) | **REAL** | `discovery-revision` fixture forces a real superseding revision |
    | `needs-approval` | **REAL** | goal that genuinely reaches an approval gate; proves an approval-gated tool call blocks until `respondApproval` and a denied one does not run |
    | `hits-token-cap` | **FAKE** | `HarnessBridge` budget is advisory with no `maxTokens`; not reachable with real providers — deterministic `FakeAdapter` |
    | `adapter-error-mid-run` | **FAKE** | deterministic mid-run failure needs a fake marker; scored against the documented recovery outcome |
    | `cross-provider-reroute` | **FAKE** | quota-triggered reroute needs injected quota state; deterministic `FakeAdapter` |
    | `boot-crash-recovery` | **FAKE** | kill-mid-run + reboot; scored against its **documented non-terminal/terminal recovery outcome** (`resume_offered` / `FAILED(orphaned)` / `COMPLETED`-from-evidence), **not** "terminal E2E success" (R2-#5) |
    The FAKE scenarios still boot the real `buildServer` + Harness path; only the adapter is fake. If real provider fault/budget injection that reaches `ExecutionRequest.policy` is added later, any FAKE scenario can be promoted — noted, not done here.
23. **Increment completion gate (D4/D7; R1-#7) — hard, same status as increment 2's Playwright gate.** The increment is **not delivered and its roadmap checkbox is not ticked** until a real `pnpm eval` run has produced a committed `docs/eval-history/scorecard-<UTC-date>.md` in which:
    - `happy-path` on real Claude and on real Codex each: `reachedTerminal` with `terminalState` terminal, `verificationPassed`, `durableSessionCount ≥ 1`, `executionRequestId` non-null, `verificationRunId` non-null linked to a `verification_plan_revisions` row;
    - `replan-needed` (one provider): `verificationPlanRevisions ≥ 1` with a superseding revision;
    - **conformance slice** on each provider session: `usage.updated` carried real token counts + a non-empty `accounting` string (`usageAccountingPresent`).
    `needs-approval` real-provider evidence (an approval-gated call blocks until `respondApproval`; a denied call does not run) is **not** in this hard gate (R3-#5) — it is a documented **area-1 flip precondition** (step 28). The `needs-approval` scenario is still implemented and run; only its real-provider assertion is deferred.
    If provider credentials are unavailable in-session, the code lands on the branch but the increment is reported **INCOMPLETE** with the exact reason — no fabricated or FakeAdapter-derived scorecard is committed, no eval spec is stubbed or deleted.
24. **Scorecard schema (versioned, reproducible; R1-#16).** `scorecard.json`: `schemaVersion`, `generatedAt`, `repoCommit` (SHA), `configDigest`; per scenario: `name`, `kind` (real/fake), `fixtureDigest`, `provider`, `model`, `taskId`, `sessionId`, `executionRequestId`, `verificationRunId`, plus the scorer metrics. The `.md` is a rendered human summary of that JSON. `docs/eval-history/scorecard-<UTC-date>.{json,md}` — **both the validated canonical JSON and the rendered Markdown are committed together** (R4-#6; workflow artifacts are ephemeral, the canonical record must be in git) — **only** from `workflow_dispatch` or `pnpm eval:promote`, never every nightly. The nightly uploads both as artifacts and opens/updates a tracking issue on failure.
25. Adapter selection: `AGENT_PLANE_EVAL=1` + provider creds ⇒ real adapters for REAL scenarios. Otherwise `eval/run.ts` runs FAKE scenarios only + a `FakeAdapter` dry pass of the REAL ones for plumbing coverage (not in CI this increment).
26. `.github/workflows/eval.yml` — `schedule` (nightly) + `workflow_dispatch`. Secrets: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; `OPENAI_API_KEY` or `CODEX_API_KEY`. Non-blocking for PRs and `main`.

### 5. Recovery-chaos suite (R1-#17)

27. Root script `test:recovery-chaos` = `apps/api/test/harness/recovery.test.ts` + `fault-injection.test.ts` + `mode-rollback.test.ts`, an explicit required step in `ci.yml` (so "recovery-chaos … suites pass" maps to a named enforced command). Add any still-missing `PREPARED`/`STARTING` crash-origin cases eval-plan §4 lists as landed-here.

### 6. Rollout runbook (acceptance)

28. `docs/harness-rollout.md` per eval-plan §5: staging-only flip → one-week five-metric parity watch → production flip → 48h watch → rollback = set the mode `false`, **drain in-flight Harness sessions on the live process**, then restart; no schema change (deferral #2 read-time derivation, deferral #1 legacy path intact); crash-during-rollback safety net is the step-11 terminalisation policy (step 14 is the proof). Only `single` is eligible; `compare`/`race`/`parallel` stay legacy-only until increment 6. **Go/no-go flip preconditions listed explicitly (R2-#5/#6, R3-#5/#8):** (a) **≥ 6 of the 7 scenario definitions green over two consecutive nightlies**, where `happy-path` counts green only if both provider variants pass; (b) the `needs-approval` real-provider assertion green; (c) the full area-1 conformance suite (every manifest capability moved from "asserted" to "verified against provider X at commit Y"). None of (a)–(c) is an increment-3 deliverable.

### 7. Workspace & docs (R2-#9)

29. `eval/` wiring, stated exactly: `pnpm-workspace.yaml` gains `eval/`. Root `package.json` `typecheck`/`test`/`lint` use `pnpm -r --filter '!@agent-plane/eval' <script>` (or an explicit include list) so `eval/` stays out of the per-PR matrices; `eval/` carries its own `pnpm --filter @agent-plane/eval typecheck`. ESLint flat config `ignores: ["eval/out/**"]` but lints `eval/src/**` and `eval/scenarios/**` under a Node/vitest env. `pnpm typecheck && pnpm test` still validates every shared package `eval/` imports (`@agent-plane/api`, `@agent-plane/core`) because those stay in the matrix.
30. `docs/agentic-os-eval-plan.md` status: area 2 → "single-mode E2E harness + seven scenario definitions landed (increment 3); ≥ 6/7 green over two consecutive nightlies remains a flip precondition"; area 5 → "runbook landed (increment 3)"; area 6 → "scorecard schema + `pnpm eval` landed (increment 3)"; area 1 stays "future — flip precondition", noting the conformance slice increment 3 added.
31. `docs/harness-implementation-progress.md` standing deferrals #4/#6/#7 notes point at this increment for the single-mode slice each closed and what each still owes.
32. Roadmap increment 3 acceptance ticked in `docs/agentic-os-vnext-plan.md` **only** once the step-23 gate is satisfied.

## Key decisions & tradeoffs

- **D1 — per-mode flag.** `execution.harnessModes: { single?: boolean }` — a per-mode *map* with `single` its only valid key this increment; any other key is a hard `validate()` error naming it (Rev 5, R4-#5: `parallel` has no durable routing key recovery can reconstruct, so the `compare`/`race`/`parallel` keys land in increment 6 with the `execution_requests.harness_routing_key` column). One deterministic precedence (default < one file representation < `AGENT_PLANE_HARNESS_SINGLE_MODE`); no new modes env var; both file keys is an error; malformed env is an error. `loadConfig` gains a `warnings` channel for the deprecation (no stdout writes).
- **D2 — eval off the per-PR path.** Non-blocking `eval.yml`; per-PR `pnpm test` stays fakes-only. The real-run requirement is a **hard completion gate** (increment not delivered without the committed real scorecard).
- **D3 — new `eval/` tree, isolated fixtures.** Each scenario runs against a fresh `mkdtemp` + `git init` copy added to `repoAllowlist` and deleted after. Exact workspace/lint treatment in §7.
- **D4 — scorecard real, versioned, reproducible, or INCOMPLETE.** Schema-versioned JSON with commit SHA / config+fixture digests / provider+model / durable row ids; `.md` from valid JSON only; committed via dispatch/promote. Bearer secret redacted, never serialised.
- **D5 — forced-ON CI leg that actually exercises the Harness.** The four files boot through `boot-orchestrator.ts` (wires the Harness composition, reads the env); the ON leg asserts a non-null `execution_request_id` on **every** run of an eligible task (incl. failover/handoff attempts), the opposite for parallel. Assertions never weakened.
- **D6 — composition unconditional (scoped `!deps.orchestrator`); routing flagged; rollback terminalises.** `HarnessRecovery` gains an injected `isModeEnabled`; a stranded session for a disabled mode is `finalize`d to `FAILED`/`harness-mode-disabled` (one result, H-I3) instead of `resume_offered`/`AWAITING_APPROVAL`-park — so "settle to terminal state" is literally met on the rollback path. Normal operation (mode enabled) is byte-unchanged. `mode-rollback.test.ts` is table-driven over precisely-paired task+session origin states. Plus a mixed-live-ownership guard (throws rather than newest-row-guesses); the full ownership refactor is increment 6.
- **D7 — real-run minimum + explicit scenario classification.** REAL: `happy-path`×2, `replan-needed`, `needs-approval` (+ conformance slice). FAKE (deterministic, real `buildServer`/Harness, fake adapter): `hits-token-cap`, `adapter-error-mid-run`, `cross-provider-reroute`, `boot-crash-recovery` (scored against documented recovery outcomes, not "terminal success"). `replan-needed` proves the *real* discovery-comparison revision mechanism, not verification-failure-driven replanning (which does not exist). The full area-2 two-night bar and area-1 conformance suite are documented flip preconditions.

## Assumptions

_Confirmed ledger (Phase 0), with sources — Rev 4 additions marked._

1. Scope = CR-4 step (i) only. — roadmap §10 CR-4.
2. The four safety-net files = `apps/api/test/{characterization,orchestrator,failover,parallel}.test.ts`. — progress.md standing deferral #1.
3. Per-mode flag replaces the global boolean; only `single` may be ON. — roadmap §3, §3.4, `orchestrator.ts:135-139`.
4. Legacy env + legacy file key keep working via a one-release shim; `config.test.ts` gets a full matrix; `loadConfig` gains a `warnings` channel. — `config.ts:152-156,202-216`, R2-#8.
5. Real-adapter runs are credential-gated and off the per-PR path (`eval.yml`, nightly + dispatch). — eval-plan §1/§2/§6.
6. Adapters accept real creds via env — no adapter code change. — `claude.ts:326`, `codex.ts:266`.
7. Recovery-chaos = a named `test:recovery-chaos` command; E2E scenarios get a new `eval/` tree. — eval-plan §4 vs §2/§6, R1-#17.
8. Scorecard is a versioned, reproducible, committed artifact; `.md` promoted via dispatch. — eval-plan §6, R1-#16.
9. Increment does NOT flip the production default. — eval-plan §5.
10. `buildServer` currently gates `harnessBridge` on the flag (`server.ts:112`); `harnessRecovery` is already unconditional (`server.ts:100`). D6 ungates the bridge under the existing `!deps.orchestrator` scope. — `server.ts:100-218`.
11. `HarnessRecovery` already has a `finalize(...)` terminal-CAS path writing one result (H-I3) — the rollback-terminalisation policy reuses it, gated by an injected `shouldTerminalizeOnRecovery(sessionId)`. — `recovery.ts:227-239,447-482`.
12. Session terminal states = `COMPLETED|FAILED|CANCELLED|TIMED_OUT|YIELDED`; task `HANDING_OFF` pairs with session `YIELDED`. — `session-state.ts:36-40,91`.
13. `verification_plan_revisions` + `verification_runs` exist (migration 012); `VerificationCoordinator` revises by comparing initial vs post-change **discovered checks**, not by reacting to failed verification. — `012_verification_lifecycle.sql`, R2-#6.
14. Plan/review artifacts: `docs/increment-3-eval-canary-{plan,review-log}.md`. Root `PLAN.md`/`PLAN-REVIEW-LOG.md` untouched.
15. Reviewer model: CLI default — codex-cli 0.152.1. MAX_ROUNDS=5, inspect=on, MAX_INSPECTION_ROUNDS=2.

## Risks / open questions

- **R1 — the forced-ON leg (§3) may surface real single-mode parity failures in the four safety-net files.** Fixing a genuine defect is in scope; a ballooning fix is a stop-and-re-plan signal.
- **R2 — the real `pnpm eval` completion gate depends on provider credentials in-session.** Without them the code lands on a branch and the increment is INCOMPLETE with the exact reason (no fabricated scorecard).
- **R3 — `AGENT_PLANE_HARNESS_SINGLE_MODE` is read by the `config.ts` shim, `eval.yml`, and the `boot-orchestrator.ts` factory.** The `config.ts` shim is the single source of truth; the factory only passes the env through it.
- **R4 — `replan-needed` depends on the discovery-comparison revision path actually firing for the `discovery-revision` fixture.** If a real run reaches terminal with **no** `verification_runs` row at all, that is an acceptance failure to investigate, not to relax. If the coordinator does not write a superseding revision for a genuinely-changed check set, the fixture is wrong and must be reshaped until it exercises the real mechanism.
- **R5 — `eval/` as a workspace** touches `pnpm-workspace.yaml`, root scripts, ESLint config, possibly `tsconfig` refs (§7 states the exact treatment). Must typecheck under its own `--filter`.
- **R6 — `harnessOwns` newest-`runs`-row fragility + no durable Harness routing key.** Increment 3 adds only the mixed-live-ownership **guard/forced-quarantine**. The full "resolve ownership from the live session for the requested op" refactor **and** persisting `execution_requests.harness_routing_key` (so recovery can derive `parallel`/`compare`/`race`, and `harnessModes` can grow past `single`) both land in **increment 6** alongside the parity work that needs them (R4-#5).
- **R7 — acceptance #3 "settle to terminal state under HarnessRecovery" is met on the rollback path by the step-11 terminalisation policy**, not by implementing provider-resume consumption (standing deferral #7). Normal-operation recovery semantics are unchanged: a resume-capable crash with the mode still **enabled** still yields `resume_offered` — that is correct behaviour, not a rollback.
- **R8 — real-provider approval-gating evidence is deferred to area 1, not part of the increment-3 completion gate (R3-#5).** The `needs-approval` scenario is implemented and run this increment; if a real-provider goal that reliably reaches an approval gate proves unstable, that scenario runs against `FakeAdapter` for now. The real-provider assertion (blocks until `respondApproval`; denied call does not run) is a documented flip precondition (step 28).
- **R9 — the rollback path can discard a provider run that actually completed** between the last persisted event and a `single`-disabled reboot (no provider status-probe exists to check — R4-#1). Accepted: a clean terminal state for a mode being disabled is worth more than salvaging one ambiguous run; the `providerSessionRef` is retained in the `mode_disabled_terminalized` recovery event so an operator can reconcile the external session manually. Revisit only if provider-resume consumption (deferral #7) is built.

## Out of scope

- Compare / race / parallel Harness parity (increment 6).
- Deleting the legacy `orchestrator.ts` execution branch; removing `harnessModes` as a branch point; `Orchestrator` → `ControlPlane` rename (CR-4 step iv).
- The full "resolve ownership from the live session" `harnessOwns` refactor **and** the `execution_requests.harness_routing_key` column + the `compare`/`race`/`parallel` `harnessModes` keys (R6 — all increment 6); increment 3 ships only the mixed-live-ownership guard/forced-quarantine and a single-key `harnessModes`.
- Provider-resume / resume-offer consumption (standing deferral #7) — the rollback path terminalises instead.
- Flipping the production `harnessModes.single` default to ON (operator action per `docs/harness-rollout.md`).
- The full eval-plan area-1 conformance suite and the full area-2 ≥N/6-over-two-nights bar — documented flip preconditions.
- Real-provider fault/budget injection reaching `ExecutionRequest.policy` — the three affected scenarios are FAKE this increment.
- Handoff-envelope claim protocol (standing deferral #7); bounded cost-cap enforcement evals (deferral #3).
- Cockpit repo changes; increment 2 stage 2.
- Provisioning staging-workspace infrastructure — the runbook documents the procedure only.
