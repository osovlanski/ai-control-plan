# Execution Harness rollout runbook — single mode

Staged canary + rollback for `execution.harnessModes.single`, the per-mode flag that routes single-mode task execution through `SessionRunner` instead of the legacy `Orchestrator` adapter-driving path (increment 3, `docs/increment-3-eval-canary-plan.md`).

**Scope.** Only `single` is eligible. `compare`, `race`, and `parallel` have no Execution Harness parity yet (roadmap §3.4) and stay on the legacy path until vNext increment 6, which also adds their `harnessModes` keys and the durable `execution_requests.harness_routing_key` column recovery will need.

## 1. Staging flip

Flip `harnessModes.single: true` in a **staging workspace only** — a separate `AGENT_PLANE_HOME`, separate config, separate DB from production. Do not touch the production workspace's config yet.

## 2. One-week parity watch

Mirror a sample of real goals to staging and compare against the legacy production path on:

- task completion rate
- verification pass rate
- median tokens
- error rate
- approval-relay latency

Hold for **one week** within an agreed parity band before considering production.

## 3. Production flip

Set `harnessModes.single: true` in the production workspace's `config.yaml` (or `AGENT_PLANE_HARNESS_SINGLE_MODE=1` for a one-release override — see the deprecation note below) and restart. Watch the same five metrics for **48 hours**.

## 4. Rollback

Set the mode back to `false` (`harnessModes.single: false`, or `AGENT_PLANE_HARNESS_SINGLE_MODE=0`) and restart. No schema change is required to roll back — deferral #2 (state-vocabulary) is read-time derivation with no dual-write, and deferral #1 leaves the legacy execution path fully intact.

**Rollback is not a kill.** The graceful path:

1. Set the mode `false` in config.
2. Let the **live process** drain in-flight Harness sessions to a terminal state on its own — new starts already route legacy the instant the flag flips (`Orchestrator.harnessRouting()` checks it per start).
3. Only then restart.

**Crash-during-rollback safety net.** If the process dies before every in-flight session drains, the **rollback-terminalisation policy** in `HarnessRecovery` is what makes the next boot safe: on `reconcileOnBoot`, any stranded session whose task's mode is disabled is driven to a terminal state (`FAILED`/`orphaned`, one `execution_results` row, the provider's `providerSessionRef` recorded on the recovery event for manual reconciliation) instead of being offered for resume or left parked awaiting an approval nobody will relay. Proven exhaustively over every reachable non-terminal session state by `apps/api/test/harness/mode-rollback.test.ts`, and enforced per-PR by the `test:recovery-chaos` CI step. A task with both a live legacy run and a live Harness session (an ambiguity the ownership predicate can't resolve) is quarantined the same way, independent of the mode flag, and never blocks the rest of the boot sweep from reconciling other tasks.

**Accepted limitation (R9).** A provider run that actually completed after the last persisted event, discovered only during a mode-disabled reboot, is terminalised as `FAILED`/`orphaned` rather than salvaged — no provider status-probe contract exists yet. The `providerSessionRef` is retained on the `mode_disabled_terminalized` recovery event so an operator can check the external session manually. A clean terminal state for a mode being disabled was judged worth more than the alternative (an unbounded resume window on a mode nobody is watching).

## Legacy config key

`execution.harnessSingleMode: <bool>` and the `AGENT_PLANE_HARNESS_SINGLE_MODE` env var are accepted for one release and mapped onto `harnessModes.single`, with a startup warning. Setting both `harnessModes` and `harnessSingleMode` in the same config file is a hard error.

## Go/no-go: the full flip bar

The staged flip above is judged on the five-metric parity watch. Separately, before this canary is considered *proven* against the broader eval program (`docs/agentic-os-eval-plan.md`), the following are flip preconditions — **not** increment-3 deliverables, and not required for the staging→production flip described above to be attempted:

- **Area 2 (E2E scenarios):** ≥ 6 of the 7 scenario definitions in `eval/scenarios/` green over two consecutive nightly runs, where `happy-path` counts green only if both provider variants (Claude, Codex) pass.
- **`needs-approval` real-provider evidence:** the `needs-approval` scenario currently runs against `FakeAdapter` (a documented fallback — no real-provider goal that reliably reaches an approval gate has been validated yet). A real-provider run proving the approval-gated call blocks until `respondApproval` and a denied call does not run is a precondition, tracked with area 1.
- **Area 1 (real-adapter conformance):** every manifest capability currently "asserted" moved to "verified against provider X at commit Y" in `docs/harness-implementation-progress.md`, via the credential-gated nightly `eval.yml` workflow.

None of these block the staging flip in §1 — they gate declaring the canary *complete*, per the eval plan's own sequencing table.
