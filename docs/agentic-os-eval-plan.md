# Agentic OS — evaluation & test plan (post-cutover)

Written after the Execution Harness cutover (Phases 0–8, PR #4) landed on `main`
with `config.execution.harnessSingleMode` **OFF** in production.

**Status per area:**

| Area | State |
| --- | --- |
| 3 — routing offline eval | **done** — `router.test.ts` cases + `routing-eval.corpus.json` + `routing-eval.test.ts` (labelled corpus, accuracy gate) |
| 4 — recovery crash-origin coverage | **done** — `recovery.test.ts` PREPARED/STARTING crash-origin cases |
| 1 — real-adapter conformance | **proposal / future** — needs a CI-with-creds workflow (standing deferral #4) |
| 2 — end-to-end scenario evals | **proposal / future** — needs CI-with-creds + fixture repos |
| 5 — rollout canary | **proposal / future** — needs a staging workspace and a real flip decision |
| 6 — scorecard artifact | **proposal / future** — wraps areas 1+2, blocked with them |

The "done" areas are the cheap, per-PR, fakes-only slices. The rest is scoped
below but not built — pick each up as its own effort when its blocker clears.

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

### 1. Real-adapter conformance (credential-gated) — proposal / future

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

### 2. End-to-end scenario evals (golden outcomes) — proposal / future

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

### 3. Routing accuracy — done (per-PR slice)

`route()` (`apps/api/src/modules/router.ts`) is pure, so the eval is offline and
deterministic.

**Landed:**
- `apps/api/test/router.test.ts` — hand-written cases for every profile, plus
  `auto` config-order + quota tie-break and all-candidates-in-cooldown →
  `no-eligible-candidate`.
- `apps/api/test/routing-eval.corpus.json` — a labelled corpus (data, not code:
  add a case by appending an entry). Each entry is a compact `RouteRequest` +
  candidate spec with an expected `chosen` / `ruleFired` / `tieBreaker`.
- `apps/api/test/routing-eval.test.ts` — feeds the corpus through `route()`,
  prints a per-case pass/fail table, and gates corpus accuracy at 1.0. Runs in
  the normal `pnpm test` (per-PR, no model call).

**Future:** feed real outcomes back — extend `telemetry.scores()` consumption so
a dashboard can compare "routed to X" against X's actual success rate over a
window, and let the corpus carry real anonymised goals rather than only
hand-built `RouteRequest` fixtures.

### 4. Recovery crash-origin coverage — done (per-PR slice)

**Gap was smaller than first assessed.** `apps/api/test/harness/recovery.test.ts`
and `fault-injection.test.ts` already simulate a crash (drop the fencing lease,
construct a fresh `HarnessRecovery` against the same DB) and assert
`reconcileOnBoot` converges — across `STARTING`, `RUNNING`, `VERIFYING`,
`AWAITING_APPROVAL`, cancel-intent, guard-directive replay, and the
`delivery_unknown` approval paths, with "exactly one `execution_results` row"
(H-I3) checked throughout. The harness runs **in-process**, so there is no
subprocess to `process.kill` — abandon-the-lease is the established and correct
crash model.

**Landed:** the crash-origin gaps in `recovery.test.ts` — `PREPARED` (crashed
after Prepare, before any lease) and `STARTING` with and without an acked provider
handle (orphan vs. start-ambiguous resume).

**Future:** a `PAUSED` / `RESUMING` crash-origin case, only once the plane drives
those states under flag-ON (today it does not).

No `eval/chaos/` tree — these are additions to existing suites, per-PR, fakes only.

### 5. Rollout canary — proposal / future

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

### 6. Scorecard artifact — proposal / future

**Gap.** Eval output (once areas 1 and 2 exist) would be scattered across CI logs.

**Plan.**
- `pnpm eval` script: runs areas 1+2, writes `eval/out/scorecard.json` +
  a rendered `scorecard.md`.
- Nightly workflow uploads it as a build artifact and (optional) commits the
  `.md` to a `docs/eval-history/` directory so trend is visible in git.
- Blocked with areas 1+2 — nothing to score until the credentialled evals run.

---

## Sequencing

| Step | Area | Status | Blocks flag flip? | CI cost |
| --- | --- | --- | --- | --- |
| 1 | 4 — recovery crash-origin gaps (fakes) | **done** | yes | per-PR, cheap |
| 2 | 3 — router hand-written cases (fakes) | **done** | no | per-PR, cheap |
| 3 | 3 — labelled routing corpus + accuracy | **done** | no | per-PR, cheap |
| 4 | 1 — adapter conformance | proposal / future | yes | nightly, creds |
| 5 | 2 — E2E scenarios | proposal / future | yes | nightly, creds |
| 6 | 6 — scorecard | proposal / future | no | nightly |
| 7 | 5 — rollout runbook + canary | proposal / future | yes (the flip itself) | staging |

Steps 1–3 (cheap, per-PR, fakes only) are done. Steps 4–5 need the CI-with-creds
workflow that deferral #4 already anticipates; step 6 wraps them; step 7 is the
gate on production. None of 4–7 is built — each is scoped above as its own
follow-up effort.

## Non-goals / explicitly deferred

- Load and soak testing — only once a real remote use case is proven
  (`ROADMAP.md` "Later").
- Cost-cap enforcement evals — blocked on a pricing table (standing deferral #3).
- Handoff-envelope claim-protocol evals — that protocol is not wired yet
  (standing deferral #7); area 2's "cross-provider reroute" scenario covers the
  current fresh-prompt path only.
