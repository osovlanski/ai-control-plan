# Quality, Cost & Quota: qcq-06 decomposition and overhead estimate (design)

Status: PROPOSED, 2026-11-26. Backlog item `qcq-06-decomposition-overhead`. Nothing here is
implemented; every "today" describes `main` at `6afa23b` (API 2.20). No code starts until itay has
answered the questions in section 9 (each has a recommended default, so "defaults" is a valid
answer).

The goal from the backlog: an estimate of a parent task is the sum over its subtasks plus measured
overhead (planning, handoff, retry, verification), and each part carries its own evidence.

## 1. Summary

- **Advisory first.** Every slice in this plan is read-only or record-only, like qcq-01 and qcq-02.
  No dispatch, scheduler wait, budget, approval, acceptance or Autopilot path reads a subtask link
  or a parent estimate. A change that would let either affect dispatch is a later item and goes
  through `docs/agentic-os-qcq-review-packet.md`, as qcq-04 and qcq-05 do.
- **Producer.** The first producer of a parent/child link is the operator, through one new
  route, `POST /api/tasks/:id/subtasks`, under `commands.write`. A child is an ordinary task. A
  planner run that proposes subtasks for the operator to accept is a later, optional slice (Q2).
  Automatic decomposition and fan-out stay with vNext increment 11 and are not in qcq-06.
- **Estimate.** A new advisory read, `GET /api/tasks/:id/estimate/breakdown`, returns one part per
  child (the existing `run-estimate/1` answer for that child, unchanged) plus four overhead parts.
  Tokens and spend add up. Duration is given two ways: the serial sum (an upper bound) and, when
  the children declare an order, the critical path. A part with no evidence is `null` with a
  reason, never zero.
- **Contract.** Additive only. The three existing schema files in `contracts/run-estimate/v1/`
  and the two existing estimate bodies stay byte-identical; the breakdown gets its own schema file
  in the same directory. `RUN_ESTIMATOR_VERSION` stays `run-estimate/1`; the breakdown has its own
  version, `parent-estimate/1`.
- **Files avoided.** No slice edits `scheduler.ts`, `orchestrator.ts`, `attempts.ts`,
  `accounts.ts`, `exit-evidence.ts`, `session-runner.ts` or `autopilot.ts`. The qcq-04 thread owns
  them. Two slices need a one-line route registration in `server.ts` and the API version line;
  they rebase on qcq-04b/c (section 7).

## 2. What exists today

| Piece | State on `main` | Where |
|---|---|---|
| Parent/child between tasks | **No producer.** `execution_requests.parent_task_id` / `group_id` are Harness correlation columns (migration 007), opaque to the Harness, never written with a value by the plane. `GET /api/sessions?parentTaskId=` reads them. | `005`/`007` migrations, `server.ts:1607`, vNext §3.5 |
| Task ordering | **Exists.** K4 dependency waits: `wait_conditions.kind = 'dependency'`, `depends_on` task ids, validated non-self and acyclic at attach, `on_dependency_failure`. | `017_dependency_waits.sql`, `packages/core/src/scheduler.ts:51` |
| Per-run estimate | `estimateRun` over a cohort of ended runs (assistant+model+kind, then wider), quartile ranges, `null` with no evidence. Per **run**, not per task. | `packages/core/src/run-estimate.ts`, `docs/contracts/run-estimate-v1.md` |
| Recorded estimates | `run_estimates` (056), one row per run start, append-only. | qcq-02 |
| Handoff records | `handoffs(task_id, from_run_id, to_run_id, checkpoint_id, trigger, at)`. Triggers written today: `manual`, `quota`, `failure`, `harness`, `context` (K11 yield), `wake`. Harness requests also carry `origin.kind` in `fresh` / `resume` / `handoff`. | `001_init.sql`, `orchestrator.ts:1093`, `005_harness.sql` |
| Verification | Harness `verification_runs` (state, `claimed_at`, `updated_at`, `evaluation`); checks are plane-run commands (`tests`, `typecheck`, `lint`, ...). Legacy runs only emit a `verification.result` event. | `012_verification_lifecycle.sql`, `verification-coordinator.ts` |
| Activity phase | `tasks.activity_phase` and event `phase` (`planning`, `editing`, `testing`, `reviewing`): best-effort, display only. | `packages/core/src/task.ts:7`, `events.ts:63` |
| Parallel modes | `tasks.mode` `single` / `compare` / `race`: several candidate runs of one task by design. | `004_parallel.sql` |

Consequences for the design:

1. A task's cost today is already more than one run when it was handed off, resumed, retried or
   continued after a context yield. qcq-01 estimates one run. So "measured overhead" is mostly
   about **extra runs per task**, and it can be measured from history that exists now, before any
   subtask exists.
2. Planning overhead is the one part with no history at all, because nothing decomposes today.
3. The order between children already has a mechanism (dependency waits). qcq-06 reads it; it does
   not build a second DAG.

## 3. Who produces subtasks

### 3.1 Stage A: the operator (recommended first producer)

`POST /api/tasks/:id/subtasks` creates a **new** child task under parent `:id`.

- Body: the same fields `POST /api/tasks` accepts for a full credential (`goal`, `constraints`,
  `repoPath` or `repo`, `profile`, `wait`, `overrides`, `mode`, `runAs`, `idempotencyKey`). The child
  is created through the same create path, so allowlist, idempotency and redaction rules are the
  ones that already apply. The answer is the created task plus `parentTaskId`.
- Capability: `commands.write` (Q1). A narrow credential (the MCP service) is refused, as it is for
  any knob outside its fixed list today.
- Rules, enforced in the migration (triggers) and the route:
  - the parent exists and is not terminal;
  - depth 1: a parent cannot itself be a child (Q4);
  - `mode` of the child is `single` (compare and race children are out of v1);
  - the link is immutable: no re-parent, no detach, no attach of an existing task (Q5);
  - a cap on children per parent, 20 by default (config `subtasks.maxChildren`).
- Ordering between children uses the existing dependency wait (`wait.kind = 'dependency'`,
  `dependsOn` naming sibling ids). The route validates that every `dependsOn` id is a sibling or the
  parent's other children; it does not add a new ordering field.
- The parent itself is a **container** for estimation (Q3): its own runs, if any, are reported as a
  separate `parentOwnRuns` note and are not summed. Nothing stops the operator starting the parent
  in the advisory stages; the breakdown says so in `warnings`.

Why the operator first: it is the only producer whose decisions are already authorized and
audited, it needs no model spend, and it gives the estimate real parents to measure before any
automation exists.

### 3.2 Stage B: planner proposals (optional, Q2)

A run whose task is marked for planning (a profile flag or an explicit request, decided in that
slice) may emit a structured subtask proposal. The plane stores it record-only, in the pattern of
memory proposals (O6 S5/S6: proposal table, inbox, explicit operator accept). Accepting a proposal
calls the stage A route; rejecting stores the reason. The planner never creates a task itself.
This slice makes the planning overhead measurable (section 4.4), because the proposal names the
run that produced it.

### 3.3 Not in qcq-06

Automatic decomposition, fan-out, cancellation propagation from parent to children, and the parent
verdict algebra stay with vNext increments 10 and 11. The stage A link is designed to be the
entity increment 10 extends (it adds the verdict field and `subtasks.read`), not a parallel model.
`execution_requests.parent_task_id` stays a correlation field: filling it from the new link is
left to the slice that next edits the Harness request builder after qcq-04, because that builder
is in the avoided files.

## 4. The parent estimate

### 4.1 Shape

```text
ParentEstimate {
  estimatorVersion: "parent-estimate/1",
  advisory: true,
  asOf,
  parentTaskId,
  children: [{ taskId, state, estimate: RunEstimate | null, actual: ChildActual | null }],
  overhead: {
    planning:     OverheadPart,
    handoff:      OverheadPart,
    retry:        OverheadPart,
    verification: OverheadPart,
  },
  totals: {
    tokens:      { input: EstimateRange | null, output: EstimateRange | null },
    spend:       { apiUsd: EstimateRange | null, apiEquivalentUsd: EstimateRange | null },
    durationMs:  { serial: EstimateRange | null, criticalPath: EstimateRange | null, order: "dependency-waits" | "none" },
    confidence,
  },
  warnings: string[],
  evidence: { missing: string[] },
}

OverheadPart {
  method: string,                  // e.g. "extra-runs-per-task/1"
  expectedCount: { mean: number, share: number } | null,  // per child
  durationMs: EstimateRange | null,
  tokens: { input: EstimateRange | null, output: EstimateRange | null },
  sampleSize: number,
  evidence: { taskIds: string[], runIds: string[], records: string[] },
  missing: string[],
}
```

`RunEstimate`, `EstimateRange` and `EstimateConfidence` are the existing types, reused by `$ref`
in the schema. A child that has ended carries `actual` (duration, settled tokens, cost, from its
runs' own records) and its estimate is still shown, as the recorded read does today.

### 4.2 Sum rules

- **Per child base**: the existing `estimateRun` for that child, as `GET /api/tasks/:id/estimate`
  would answer it at `asOf`. No new cohort logic.
- **Tokens and API spend** add up across children and overhead parts. A sum of quartile ranges is
  not a quartile of the sum; the doc and the field name say so (`sum of p25`, `sum of p50`,
  `sum of p75`), and confidence is the lowest part's. If any child or part is `null`, the total is
  `null` and `missing` names which (Q7). A partial total is never shown as the total.
- **Subscription quota** is not summed: a run's share of a quota is not observable (qcq-01 rule).
  The breakdown repeats the parent's proposed assistant's `subscriptionQuota` once.
- **Duration**: `serial` is the sum. `criticalPath` is the longest path through the children's
  dependency waits using each child's range plus its share of overhead; children with no
  dependency are treated as able to run at once. `order: "none"` and `criticalPath: null` when no
  child declares a dependency. Neither figure models the qcq-04 account limit or the K4b pools; a
  warning says so until qcq-04d makes the limit enforceable.
- **Wait until start** and **approval wait** stay per child, as served; they are not summed.

### 4.3 Overhead from extra runs (handoff, retry)

Measured over ended, non-cancelled, `single`-mode tasks in the child's cohort (same assistant and
task kind, then assistant, the qcq-01 ladder at task level), at most the 50 most recent that ended
before `asOf`. For each such task its runs are ordered by `started_at`; the first is the base run,
and every later run is classified once, by the first rule that matches:

| Class | Rule (durable record) |
|---|---|
| handoff | a `handoffs` row with `to_run_id` = the run and `trigger` in `manual`, `quota`, `harness`, `context`, `wake`; or Harness `origin.kind` = `handoff` |
| retry | a `handoffs` row with `trigger = 'failure'`; or the previous run ended `ENDED_ERROR` and this run is `origin.kind` `fresh` or `resume` |
| other | anything else (for example an operator restart after `ENDED_OK`) |

`other` is reported as its own count in `missing`/`warnings` and is not folded into either class
(Q6). The part's `expectedCount` is the mean extra runs of that class per task and the share of
tasks that had one; `durationMs` and `tokens` are quartiles of the per-task total of those runs;
`durationMs` also includes the wall gap from the predecessor's `ended_at` to the run's `started_at`
(the time the task waited between runs). Compare and race tasks are excluded: their extra runs are
the mode, not overhead.

This history exists today, so these two parts can show evidence from the first slice that serves
the breakdown, before any parent has ended.

### 4.4 Planning overhead

- Stage A (operator decomposition): `null`, `missing: ["operator-authored decomposition: planning
  time and tokens are not observed"]`. The time between parent creation and the last child
  creation is **not** used: it measures the operator, not the plan.
- Stage B (planner proposals): the producing run's duration and settled tokens, as quartiles over
  past accepted proposals in the planner's cohort.
- Event `phase: planning` is never evidence: it is display-only by contract.

### 4.5 Verification overhead

- Harness children: per verification run of the child's latest session, `updated_at - claimed_at`
  of `completed` verification runs; quartiles over the cohort. Command checks spend no model
  tokens, so `tokens` is `{ input: 0, output: 0 }` with `method` naming that rule; any later check
  kind that calls a model must change the method.
- A re-run after a failed required check is already a run, and is classified by section 4.3.
- Legacy children: `null`, `missing: ["legacy run: verification time not recorded"]`.

### 4.6 What the breakdown never does

It never writes (no routing decision, dispatch, wait or estimate row); it never starts, defers or
refuses anything; it never reads or produces a verdict; and it never shows a percentage of
progress (vNext increment 13 owns structural progress).

## 5. Schema and contract changes (additive only)

### 5.1 `packages/core/src/run-estimate.ts`

Additive exports only; no existing type, constant or function changes, so `run-estimate/1` output
is byte-identical:

- `PARENT_ESTIMATOR_VERSION = "parent-estimate/1"`;
- types `ParentEstimate`, `OverheadPart`, `ChildActual`, `HistoricalTask` (a task with its ordered
  runs, handoff rows and verification timings, as the api reads them back);
- pure functions `classifyExtraRuns(task)`, `overheadFor(cohortTasks, asOf)`,
  `criticalPath(children, dependsOn)`, `estimateParent(children, overheadHistory, ctx)`.

If the file grows past readability, the functions move to `packages/core/src/parent-estimate.ts`
and `run-estimate.ts` re-exports them; the slice PR decides, the contract is the same.

### 5.2 `contracts/run-estimate/v1/`

- New `task-estimate-breakdown.schema.json` (JSON Schema 2020-12, closed objects like the rest)
  for the body of `GET /api/tasks/:id/estimate/breakdown`. It `$ref`s `RunEstimate` and
  `EstimateRange` in `run-estimate.schema.json`; it does not add `$defs` there.
- New fixtures under `fixtures/valid` and `fixtures/invalid` named by the new prefix.
- `run-estimate.schema.json`, `task-estimate.schema.json`, `task-recorded-estimates.schema.json`
  and their fixtures stay byte-identical, so a Cockpit pinned to the current SHA keeps validating.
  Cockpit validates at runtime with closed objects, which is why the breakdown cannot be a new
  field on the existing estimate body.
- `docs/contracts/run-estimate-v1.md` gains a "Breakdown (qcq-06)" section.

### 5.3 Tasks contract

- Migration (next free number at rebase; #272 holds 060): `tasks.parent_task_id TEXT REFERENCES
  tasks(id)`, partial index on it, and triggers: immutable once set, non-self, parent has no parent
  (depth 1), set only at insert.
- `GET /api/tasks/:id` gains `parentTaskId` (string or null) and `subtaskIds` (array, possibly
  empty). Additive; the task-stage contract Cockpit vendors does not change.
- `GET /api/tasks?parentTaskId=` filters children (read, `tasks.read`).
- API minor bump once for the link and once for the breakdown, or once if they land together.

## 6. Rollout (advisory first)

| Stage | What changes | Writes | Reads it | Gate to the next stage |
|---|---|---|---|---|
| R0 | This design | none | none | itay answers section 9 |
| R1 | Operator subtask link (stage A) | new tasks with a parent | task reads only | gate + drive PASS; merged |
| R2 | Breakdown read + schema | none | operator surfaces only | gate + drive PASS; merged |
| R3 | Web/CLI surfaces, then Cockpit vendoring | none | humans | drive PASS each |
| R4 | Accuracy replay at parent level | none | humans | at least 5 ended parents in the live DB |
| R5 | Planner proposals (stage B, if Q2 yes) | proposal rows | inbox | itay accepts some proposals; planning part shows evidence |
| later | Anything that lets a parent estimate gate, defer, budget or reserve | — | dispatch | review packet + one Opus High reviewer + itay's rollout approval; not qcq-06 |

Rollback at every stage: R2–R4 have no writes, so reverting the route is the rollback. R1's
column is nullable and unread by dispatch; a parent created in R1 runs exactly like any task today.

## 7. Slices

| # | Slice | Size | Files | Waits for |
|---|---|---|---|---|
| S1 | Subtask link: migration, `POST /api/tasks/:id/subtasks` in a new module, task read fields, `?parentTaskId=` filter | M | `apps/api/src/db/migrations/06x_task_parent.sql`, `apps/api/src/modules/subtasks.ts` (new), `apps/api/src/modules/tasks.ts`, one registration line in `server.ts`, `packages/core/src/contracts.ts` (API version line), `apps/api/test/subtasks.test.ts` | Q1, Q3–Q5; rebase on qcq-04's API version and migration numbers |
| S2 | Pure overhead and parent estimate in core | M | `packages/core/src/run-estimate.ts` (additive) or `parent-estimate.ts`, `packages/core/test/parent-estimate.test.ts` | Q6, Q7; can land before S1 (pure, no route) |
| S3 | Breakdown route, schema, contract test, doc | M | `apps/api/src/modules/run-estimate.ts` (input gathering, additive) or a new `parent-estimate.ts`, one registration line in `server.ts`, `contracts/run-estimate/v1/task-estimate-breakdown.schema.json` + fixtures, `apps/api/test/run-estimate-breakdown.test.ts`, `docs/contracts/run-estimate-v1.md` | S1, S2 |
| S4 | Surfaces: `aos task estimate <id> --breakdown`, Web Usage tab section | S | `apps/cli/src/estimate.ts`, `apps/web/src/TaskEstimate.tsx` | S3 |
| S5 | Cockpit vendors the new schema (cockpit repo) | S | cockpit `contracts/run-estimate/**`, `VENDORED.json`, `runEstimate.ts`, `public/**` | S3 merged |
| S6 | Parent accuracy replay | S | core + `GET /api/estimates/accuracy?scope=parent` | S3; R4 gate |
| S7 | Planner proposals (stage B) | M | new proposal module + migration, inbox read/accept routes | Q2 yes; S1 |

S2 is the only slice that can start before qcq-04 finishes; it touches no avoided file. S1 and S3
each add one line to `server.ts` and take the API version line, so they land after the qcq-04 thread
says `server.ts` is free (after qcq-04b part 2c) or rebase onto it.

## 8. Tests

Pure (S2), each asserting `null` and the `missing` text where evidence is absent:

1. No history: every overhead part `null`, totals `null`, `missing` names each part.
2. Classification table: one fixture per row of section 4.3, including a `failure` handoff
   (retry), a `context` handoff (handoff), an `ENDED_ERROR` then `fresh` run (retry), an
   `ENDED_OK` then operator restart (other, reported not folded), and compare/race tasks excluded.
3. A run is classified once: a run that matches both a handoff row and an error predecessor goes
   to the first matching class only.
4. Cohort cut: only tasks whose last run ended before `asOf` count (no look-ahead), matching
   qcq-01's replay rule.
5. Sum: totals equal the sum of the parts' p25/p50/p75 exactly; one `null` child makes the total
   `null`.
6. Critical path: a chain, a diamond and independent children; `order: "none"` without
   dependencies.
7. Verification: Harness completed runs give a duration range and zero tokens with the named
   method; interrupted runs are excluded; legacy gives `null` with the reason.
8. `run-estimate/1` unchanged: the existing estimate and recorded fixtures still validate and the
   existing estimator tests pass untouched.

Route and contract (S1, S3):

9. Subtask create: parent missing (404), terminal parent (409), depth 2 refused, `mode` not
   `single` refused, cap reached refused, narrow credential refused (403), idempotent replay
   returns the same child, `dependsOn` naming a non-sibling refused.
10. Triggers: an `UPDATE` of `parent_task_id` aborts; a self-parent insert aborts.
11. Breakdown served body validates against the new schema for: no children, children with no
    history, children with history and handoffs, an ended child with `actual`.
12. Advisory: the breakdown read writes nothing (row counts of `routing_decisions`, `dispatches`,
    `wait_conditions`, `run_estimates` unchanged), and the scheduler's dispatch tests pass with a
    parent and children present.
13. Drive (per AGENTS.md): `pnpm dev`, create a parent and two children with a dependency under a
    `FAKE-*-not-real` credential, run the FakeAdapter with a forced failure and a handoff to seed
    history, then `curl` the breakdown and report what it served.

## 9. Owner questions (itay)

Each has a recommended default. "Defaults" accepts all of them.

1. **Who may create subtasks?** Default: the operator only, under `commands.write`, through
   `POST /api/tasks/:id/subtasks`. The MCP narrow credential and Autopilot may not. (Alternative:
   a new `subtasks.write` capability so a named credential can hold it without `commands.write`.)
2. **Should a planner run be allowed to propose subtasks?** Default: yes, but only as stage B
   after R2, record-only, and only an operator accept creates a child. Never automatic creation in
   qcq-06.
3. **Is a parent a container, or work of its own?** Default: a container for estimation. Its own
   runs are reported apart and not summed; starting it is not refused while everything is
   advisory.
4. **How deep can decomposition go?** Default: one level (a child cannot have children) until
   the vNext increment 10 verdict algebra exists.
5. **Can links change after creation?** Default: no. Children are created under the parent; no
   re-parent, detach or attach of an existing task in v1.
6. **How are extra runs classified?** Default: the table in section 4.3, with `other` reported
   separately and never folded into retry or handoff, and compare/race excluded from overhead.
7. **What does a total show when one part has no evidence?** Default: `null` with the missing part
   named. (Alternative: a partial total labelled "lower bound".)
8. **Is decomposition advisory-only first?** Default: yes. Through R5 no dispatch, scheduler,
   budget, approval or Autopilot path reads a link or a breakdown. Any change that lets a parent
   estimate defer, gate or reserve goes through the review packet with one Opus High reviewer and
   needs your rollout approval.
9. **Should a parent estimate be recorded at a start, like qcq-02?** Default: no in qcq-06. Parent
   accuracy is a replay (S6) until at least 5 parents have ended; recording would need a hook in
   `orchestrator.ts`, which qcq-04 owns.
10. **Children per parent cap?** Default: 20, configurable as `subtasks.maxChildren`.
11. **Does qcq-06 wait for vNext increment 10?** Default: no. S1 builds only the link, shaped so
    increment 10 adds the verdict and `subtasks.read` on top; it adds no verdict and no task state.

## 10. Not in scope

Parent verdicts and partial success (vNext 10), automatic decomposition, fan-out and cancellation
propagation (vNext 11), multi-repository sagas (vNext 12), structural progress (vNext 13),
modelling the qcq-04 account limit in the critical path, effort as a cohort key (p1-5), paid
verification runs, and any live OCI or scheduling change.
