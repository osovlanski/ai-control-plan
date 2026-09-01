# Agentic OS — evaluation & test plan (post-cutover)

Status: proposal. Written after the Execution Harness cutover (Phases 0–8, PR #4)
landed on `main` with `config.execution.harnessSingleMode` **OFF** in production.

## Why this exists

Current automated coverage is a good unit/integration pyramid but stops at the
fakes:

- 35 `vitest` files — `apps/api/test` (12), `apps/api/test/harness` (17),
  `apps/web/test` (1), `packages/adapters/test` (1), `packages/core/test` (4).
  The harness suite drives the real `SessionRunner` + `EventRecorder` +
  `SessionStore` against `FakeAdapter` on an in-repo SQLite database.
- CI (`.github/workflows/ci.yml`) runs `pnpm typecheck && pnpm lint && pnpm test
  && pnpm build` on every PR and every push to `main`. No provider credentials,
  no real models, no long-running scenarios.

Nothing exercises the question that actually matters for an "Agentic OS": **does
a real goal, given a real model, come out the far end as a correct, verified
change — and does the system stay consistent when that run crashes, hits a quota
wall, or gets rerouted?** That is entirely deferred today (progress-doc standing
deferrals #4, #6, #7).

This plan turns those deferrals into a concrete, staged eval program. It does not
require flipping the flag in production — most of it runs behind a credential
gate on a schedule.

## Scope

In scope: how we gain confidence to flip `harnessSingleMode` ON, and how we keep
that confidence afterward.

Out of scope: building the remote runner; multi-tenant concerns; anything the
`Avoid` section of `ROADMAP.md` rules out.

---

## The six areas

### 1. Real-adapter conformance (credential-gated)

**Gap.** The Claude and Codex adapters declare `toolGating`, `processIsolation`,
`usageReporting`, `approvalAckLookup` capabilities that are only ever checked
against `FakeAdapter`'s scripted markers. Standing deferral #4.

**Plan.**
- Add a `conformance` vitest project that runs the existing adapter-contract
  assertions against a live provider session for each adapter.
- Gate it on a `AGENT_PLANE_CONFORMANCE=1` env flag plus per-provider API keys
  pulled from CI secrets. It is skipped locally and on normal PR runs.
- New workflow `.github/workflows/conformance.yml`: `schedule` nightly + manual
  `workflow_dispatch`. Non-blocking for PRs; a red nightly opens an issue.
- Assertions per adapter: emits `file.changed` / `test.result` / `usage.updated`
  in the documented envelope shape; `usage.updated` carries real token counts and
  an `accounting` string; an approval-gated tool call actually blocks until
  `respondApproval`; a denied tool call does not run; process isolation tier is
  what the manifest claims (probe, not just assert).
- Exit criterion: each manifest capability currently "asserted" is moved to
  "verified against provider X at commit Y" in `harness-implementation-progress.md`.

**Cost control.** One session per adapter per run, smallest model, a trivial
one-file goal. Nightly, not per-commit.

### 2. End-to-end scenario evals (golden outcomes)

**Gap.** No test takes `POST /api/tasks` → routed → session runs → verified diff,
with a real model, and scores the result.

**Plan.**
- Fixture repo(s) under `eval/fixtures/<name>/` — a small real TypeScript project
  with a failing test or a `TODO`, plus `expected.md` describing the done state
  (which test must pass, which file must change).
- `eval/scenarios/*.ts` — each: boot `buildServer` with `harnessSingleMode: true`
  and a real adapter, submit a goal, wait for the run to reach a terminal state,
  then assert against `expected.md`.
- Scorer emits per scenario: reached-terminal (bool), verification-passed (bool),
  wall-clock, total tokens, `execution_results` outcome, checkpoint count,
  failover count.
- Start with ~6 scenarios: happy path, needs-approval, hits token cap, adapter
  error mid-run, cross-provider reroute, boot-crash-recovery (kill mid-run,
  reboot, assert convergence).
- Runs in the same credential-gated nightly workflow as area 1.

**Exit criterion.** ≥ N/6 scenarios green for two consecutive nightlies before
any flag flip.

### 3. Routing accuracy

**Gap.** `routeFor` picks an assistant; nothing measures whether it picks well.

**Plan.**
- `eval/routing/cases.jsonl` — labelled goals with an expected assistant (or
  expected "harness vs legacy" branch).
- A cheap offline eval (no model call — just `routeFor` + config) that reports a
  confusion matrix and overall accuracy. Runs on every PR (fast, deterministic).
- Feed real outcomes back: extend `telemetry.scores()` consumption so a dashboard
  can compare "routed to X" against X's actual success rate over a window.

### 4. Recovery chaos

**Gap.** `HarnessRecovery.reconcileOnBoot` is unit-tested with hand-built rows,
not with a process actually killed mid-write.

**Plan.**
- `eval/chaos/*.ts` — for each session state (`PREPARED`, `STARTING`, `RUNNING`,
  `AWAITING_APPROVAL`, `YIELDED`, `HANDING_OFF`): start a run with `FakeAdapter`,
  `process.kill` the runner at that state, reboot `buildServer`, assert the row
  and its task converge to a legal terminal-or-resumable state and no double
  `execution_results` row appears.
- Fakes only, so this runs on every PR — it is fast and needs no credentials.
- Also assert the four byte-frozen safety-net files
  (`characterization`, `orchestrator`, `failover`, `parallel`) stay green with
  the flag ON in this harness — they already do; keep it enforced here.

### 5. Rollout canary

**Gap.** `harnessSingleMode` goes from OFF to ON with no staged step and no
documented rollback.

**Plan (runbook, `docs/harness-rollout.md`).**
1. Flip ON in a staging workspace only (separate config, separate DB).
2. Mirror a sample of real goals to staging; compare against the legacy path on:
   task completion rate, verification pass rate, median tokens, error rate,
   approval-relay latency. Parity within an agreed band for one week.
3. Flip ON in production. Watch the same five metrics for 48h.
4. Rollback = set `AGENT_PLANE_HARNESS_SINGLE_MODE=0` and restart. No schema
   change is required to roll back (deferral #2 is read-time derivation, deferral
   #1 leaves the legacy path intact) — state this explicitly in the runbook.

### 6. Scorecard artifact

**Gap.** Eval output would be scattered across CI logs.

**Plan.**
- `pnpm eval` script: runs areas 2–4, writes `eval/out/scorecard.json` +
  a rendered `scorecard.md`.
- Nightly workflow uploads it as a build artifact and (optional) commits the
  `.md` to a `docs/eval-history/` directory so trend is visible in git.

---

## Sequencing

| Step | Area | Blocks flag flip? | CI cost |
| --- | --- | --- | --- |
| 1 | 4 — recovery chaos (fakes) | yes | per-PR, cheap |
| 2 | 3 — routing offline eval | no | per-PR, cheap |
| 3 | 1 — adapter conformance | yes | nightly, creds |
| 4 | 2 — E2E scenarios | yes | nightly, creds |
| 5 | 6 — scorecard | no | nightly |
| 6 | 5 — rollout runbook + canary | yes (the flip itself) | staging |

Steps 1–2 are cheap and unblock nothing external — do them first regardless of
the flip timeline. Steps 3–4 need the CI-with-creds workflow that deferral #4
already anticipates. Step 6 is the gate on production.

## Non-goals / explicitly deferred

- Load and soak testing — only once a real remote use case is proven
  (`ROADMAP.md` "Later").
- Cost-cap enforcement evals — blocked on a pricing table (standing deferral #3).
- Handoff-envelope claim-protocol evals — that protocol is not wired yet
  (standing deferral #7); area 2's "cross-provider reroute" scenario covers the
  current fresh-prompt path only.
