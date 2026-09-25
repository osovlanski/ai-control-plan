# Harness-mode parity report: operator workspace, `single` mode

Date: 2026-09-25. Build: `main` at 7ccadf0 (#57 merged). This report changes no code and no
operator config. The owner decides whether to flip.

**Question.** What changes for an operator task when `execution.harnessModes.single` routes it
through `SessionRunner` instead of the legacy `Orchestrator` path? Should the operator workspace
flip, so that the §7.1 tool-gate soak can start?

## 1. Differences, read from the code

Flag: **better** (the harness path is safer or more observable), **neutral** (different but
equivalent for an operator), **risky** (could hurt an operator task, or loses something the legacy
path had).

### Routing

| # | Difference | Flag |
|---|---|---|
| R1 | Intake routing is shared: `/start` calls `routeTask` and hands the same `routingDecisionRef` to either path. Only a start with no ref makes the harness path write a synthetic routing decision (`orchestrator.ts:530`). `/start` always passes one. | neutral |
| R2 | The harness path applies only to non-parallel starts whose task mode is not compare/race (`harnessRouting`, `orchestrator.ts:250`). Compare, race and parallel stay legacy even after the flip. | neutral |
| R3 | A scheduled dispatch keeps the path it was reserved with (`dispatches.execution_path`, `scheduler.ts:749`). A wait reserved before the flip runs legacy, and one reserved after a rollback still runs harness. | neutral, but see the rollback in §4 |
| R4 | Harness repo tasks resolve a stable repository identity (`repositoryIdentities.resolve`). Legacy tasks do not. | better |

### Approvals

| # | Difference | Flag |
|---|---|---|
| A1 | Harness approvals are durable rows (`approvals`: pending → answered → delivering → delivered, plus `delivery_unknown`), readable at `GET /api/sessions/:id`. A legacy approval exists only in the adapter's in-memory map, so it cannot be read back and a restart loses it. | better |
| A2 | Harness answers are compare-and-set on `state = 'pending'`. Legacy answers resolve the in-memory promise, and a second answer gets a 409. Neither path lets a second answer reach the provider. Only harness lets a client check before sending. | better |
| A3 | While a harness session waits for an approval, it pauses its clocks and renews its lease (`session-runner.ts:1145`). The legacy `maxRuntimeMs` timer keeps running during the wait, so a slow human can let a legacy task time out. | better |
| A4 | A harness session answers one approval at a time (`AWAITING_APPROVAL`), while legacy can hold several pending at once. Single mode rarely has two in flight. | neutral |
| A5 | The **tool gate runs only on the harness path**. It writes `decision_records` at `pre-exec` and `post-start` (shadow). The legacy path writes no gate rows, so the §7.1 soak cannot start there. | better (the reason to flip) |
| A6 | `auto-approve` and `read-only` answer immediately on harness, with no `AWAITING_APPROVAL` hop. The operator runs `prompt-on-escalation`, so this does not apply. | neutral |

### Session input

| # | Difference | Flag |
|---|---|---|
| S1 | Session input landed on `main` after these runs (#58, #47, #51). It is off by default, and the operator config does not enable it. It addresses any `runs` row, legacy or harness, by run id. Its `approvalPending` condition reads only the harness `approvals` table, so a legacy run with a pending approval looks free for input. The code was not changed and not driven. | better |

### Scheduler and quota

| # | Difference | Flag |
|---|---|---|
| Q1 | Both paths snapshot quota on `usage.updated`, `limit.approaching` and `limit.hit`, and both nudge `scheduler.quotaObserved()`. | neutral |
| Q2 | The early checkpoint triggers differently. Legacy checkpoints when **any `usage.updated` quota window reaches `softThresholdPct`** (85 on the operator config, `orchestrator.ts:815`). Harness checkpoints only on a `limit.approaching` event, or on a token budget, which the operator does not set (`guards.ts:90,196`). A provider that reports usage percent but never emits `limit.approaching` gets no early checkpoint on harness. The checkpoint on `limit.hit` still happens. | risky (low) |
| Q3 | On a limit or a retryable provider fault, both paths go through the same `failoverTask`. Harness reaches it from a typed `ExecutionResult` (`yielded(limit)`, or `failed` with `provider_fault` and `retryable`). Legacy reaches it from `run.limit` or `sawError`. | neutral |
| Q4 | A same-assistant continuation **resumes the provider session** on legacy (`adapter.resume`, `orchestrator.ts:583`). On harness it starts fresh from the rendered handoff prompt, and resumes only in boot recovery. That costs more tokens and loses the provider's own context. | risky (low) |
| Q5 | Only harness has K11 context-yield continuation (`continueFromContextYield`) and K9 `context.observed` sampling. | better |

### Events and traces

| # | Difference | Flag |
|---|---|---|
| E1 | Both write the same `events` table and the same SSE frames. Harness also writes `guard.decision`, `context.observed`, `verification.result` and `recovery.decision`. | better |
| E2 | Harness writes one terminal `execution_results` row per session. Legacy has only `runs.state`. | better |
| E3 | Harness runs project verification after a repo or scratch task and stores its result. A failed check parks the task in `WAITING_INPUT(verification_failed)` instead of `COMPLETED`. Legacy has no verification. | better, but it is a behaviour change: a task can stop completing |
| E4 | Harness takes a `pre_verification` checkpoint, which on a repo task is a commit on the task branch. Legacy takes a `completion` checkpoint commit. | neutral |

### Failure recovery

| # | Difference | Flag |
|---|---|---|
| F1 | Harness sessions carry a 60 s fencing lease, and a sweeper runs every 60 s (`server.ts:911`). **A session renews its lease only once it is `RUNNING`**, which needs the first provider event (`onTick` returns early unless `RUNNING`, `session-runner.ts:621`; the heartbeat starts only after `startProvider` returns). A provider that is silent for 60–120 s after launch is orphaned: the session goes `FAILED(orphaned)` and the task goes `FAILED`. Legacy has no lease and would wait until `maxRuntimeMs`, which is 30 min. Observed live: see §2, batch 1. | **risky** |
| F2 | After recovery takes the lease, the runner's next write fails its compare-and-set and `execute()` unwinds. It **never cancels the provider handle**. `iter.return()` does not stop the CLI. Observed live: three `claude` CLIs were still running 4 min after their sessions were `FAILED`, until I killed them by hand. K19k had already deleted their working directory (the scratch directory goes when the task is terminal). | **risky** |
| F3 | Boot recovery decides every live harness session (resume offer, orphan with checkpoint, or complete from verifying), and a mode-disabled boot terminalises stranded sessions. Legacy boot fails every in-flight task. | better |
| F4 | A task with both a live legacy run and a live harness session is quarantined at boot, and control operations refuse it. | better |
| F5 | Legacy fails over when any `error` event plus a not-ok end occur. Harness fails over only on `failure.kind = provider_fault && retryable`. An `orphaned` failure (F1) does **not** fail over, so the task simply fails. | risky (it compounds F1) |

### Other

| # | Difference | Flag |
|---|---|---|
| O1 | Harness validates the worktree and repo roots against `WorkspaceAuthority` before start. Legacy does not. | better |
| O2 | Harness can resolve secret references and run an isolation probe. Both are unused here: the requirement is `ambient` and there are no `secretRefs`. | neutral |
| O3 | Harness adds `guard.decision` audit rows and pending directives for the Phase 7 replay. | neutral |
| O4 | **Doc/code disagreement.** `docs/harness-rollout.md` §4 said that new starts route legacy "the instant the flag flips". Config is read once, at boot (`index.ts:7`, `loadConfig`), and nothing reloads it. Editing `config.yaml` changes nothing until a restart. The runbook is corrected in the same PR as this report, and the rollback in §4 below is written against the code. | finding, fixed |

## 2. Live runs

Setup:
- The operator workspace (`~/.agent-plane/personal`, config unchanged: sha256 `62ad7317…`, mtime
  2026-09-24) ran the no-repo and approval tasks.
- The repo task could not run there, because the operator's `repoAllowlist` is empty and
  `POST /api/tasks` returns 403. It ran in a scratch workspace instead, whose `config.yaml` is the
  operator's with one change: a throwaway repo added to the allowlist. The workspace name and port
  also differed.
- Every task was pinned to `personal-claude`, so the model varied as little as possible.
- The normal path was a plain `pnpm start`. The harness path was the same with
  `AGENT_PLANE_HARNESS_SINGLE_MODE=1` in that process's environment only. I checked
  `/proc/<pid>/environ`.
- Approvals were identical on both paths. The driver auto-approved read-only calls. I approved
  writes that stayed inside the scratch directory or the worktree by hand, and logged each one as
  `SENT-MANUAL`.

| Task | Normal (legacy) | Harness |
|---|---|---|
| **No-repo** (write `parity.txt` in cwd, print cwd and contents) | `AG-mugvnmwk1` COMPLETED. cwd = `scratch/<task>` (K19k applies to both paths). 1 approval. 7 events. 0 gate rows. | `AG-mugwf1744` COMPLETED. Same cwd, same answer. 1 approval, durable `delivered/approved`. Gate: `pre-exec` and `post-start` both **auto-approve** ("no floor fired"), yet the provider still prompted (see note). Verification passed. |
| **Approval** (`ls ~/.agent-plane/personal`) | `AG-mugvnmwu2` COMPLETED, "13 entries". 1 approval. 0 gate rows. 32 s. | `AG-mugwd0gx3` and `AG-mugwifiz5` COMPLETED, same answer. Gate: both hooks **prompt**, `path-outside-worktree`. Approval durable. 20 s and 36 s. |
| **Repo** (fix `add`, commit, test) | `AG-mugvrw4s1` COMPLETED. Commit `8d1a01c fix add` on `task/…`, plus a `completion` checkpoint commit. 5 approvals, including a hallucinated `Read /Users/itay/…`. | `AG-mugwf1742` COMPLETED. Commit `f22d470 fix add`, same one-line diff, plus a `pre_verification` checkpoint commit. 4 approvals, including the same hallucinated `Read`, which the gate marks `prompt / path-outside-worktree`. 10 gate rows. Verification passed. |

Wall time is not comparable. The legacy repo run took 729 s because its first driver instance
timed out while it waited for my manual approval.

**Batch 1 failed: 3 of 3 harness sessions, cause not explained.** The first harness attempt
started all three tasks within 1 s, about 60 s after the two processes booted:
- Tasks `AG-mugw9pov2` and `AG-mugw9po11` on the operator workspace, and `AG-mugw9pos1` on the
  scratch workspace.
- Each `claude` CLI started, then emitted **no event for 70 s**. It sat in `ep_poll` with open
  sockets.
- The sweeper then logged `lease_taken_over` followed by `orphaned — checkpoint not committed`,
  and the task went `FAILED`.
- The CLIs stayed alive after that (F2).

Two concurrent retries and two single retries all worked, with `run.started` 11 s after launch.
On the legacy path, `run.started` came 22–23 s after launch. I could not reproduce the hang, so I
cannot say whether it came from the harness or from the provider (auth refresh, network, or a cold
start). F1 and F2 are what turned a stall into a failed task and leaked processes. The legacy path
would have kept waiting.

**Gate evidence.** The harness path wrote `decision_records` rows at both hooks on every tool
call. Legacy wrote none. Across these runs, the gate agreed with the provider's prompt on the `~`
and `/Users` paths. It said `auto-approve` on the in-scratch and in-worktree writes that the
provider still prompted on. That second case is the prompt-rate gap §7.1(7) exists to measure.

## 3. The approval driver fix

The old driver, from the K19k session, did not check whether a request was still pending. It
logged only what it sent, and it would deny any non-safe call. The new driver
(`drive.py`, in the session scratchpad):
- **Harness:** before sending anything, it reads the approval's durable state from
  `GET /api/sessions/:id`. It sends only when the state is `pending`. Otherwise it logs a `SKIP`
  with the state it saw. Live example: `apr_fani2r07` was already `delivered`, so the driver
  logged SKIP and sent nothing.
- **Legacy:** there is no durable state, so the driver **never auto-denies**. It logs `HOLD` and
  leaves the call to a human. An approve is still sent. The server resolves it atomically, and a
  second answer gets a 409.
- It skips any request whose run has ended or whose task is no longer `RUNNING`.
- `HOLD_UNSAFE=1` holds non-safe calls on both paths. The parity runs used it so that neither path
  got an automatic deny.
- It logs every decision, sent, skipped or held, as one JSON line with the durable state and the
  HTTP result. Manual decisions go to the same log as `SENT-MANUAL`.
- Its Bash allow-list is stricter. A command must start with `ls`, `cat`, `head`, `wc`, `pwd`,
  `echo` or a read-only `git`. It may not contain `; & | \` < > $(`, `rm`, `mv`, `chmod`, `curl`
  or `sudo`.

A bug found during the runs: the first harness batch was classified `legacy`, because the sessions
list has a `sessionId` key, not `id`. Harmless, because only approves went out and each one was
still pending. Fixed before the retries, which logged `path: harness` with the durable state.

## 4. Recommendation

**Owner decision, 2026-09-25: don't flip yet.** F1 and F2 get fixed first, in a separate PR, and the parity tasks are then re-run. The operator config stays unchanged until the owner says "flip".

**Don't flip yet.** F1 and F2 are real defects on the harness path. Batch 1 showed them costing a
task: a provider stall that legacy would have waited out became `FAILED` in about 70 s and left a
live CLI with no working directory. Everything else is parity or better, and the soak needs the
flip. So the flip should come right after two small fixes:

1. **F1.** Renew the lease while the session is `STARTING`: start the heartbeat before
   `startProvider`, and have `onTick` renew in `STARTING` as well as `RUNNING`. Bound the wait for
   the first event with its own start timeout, instead of the 60 s lease.
2. **F2.** When the runner loses its lease, or recovery orphans a session this process still
   holds, cancel the adapter handle (`safeCancel`) before unwinding.

Each fix needs a test in `apps/api/test/harness/`. Rerun this report's three tasks after them. If
the owner accepts F1 and F2 as known risks, the flip is otherwise safe to make now. Q2, Q4 and E3
are acceptable for an operator workspace.

**Rollback**, written against the code (this corrects O4):
1. Stop starting new tasks.
2. Wait for live harness sessions to drain. Repeat this query until it returns 0:
   `SELECT count(*) FROM runs WHERE execution_request_id IS NOT NULL AND ended_at IS NULL;`
3. `cp ~/.agent-plane/personal/config.yaml.pre-flip ~/.agent-plane/personal/config.yaml`, or set
   `execution.harnessModes.single: false`.
4. Restart the API. Config is read only at boot, so nothing changes before this step. If step 2
   was skipped, boot recovery terminalises each stranded session as `FAILED/orphaned`, keeps its
   `providerSessionRef` on the recovery event, and writes a checkpoint.
5. Check that `GET /api/health` returns ok. Then start one no-repo task and check that its run has
   `execution_request_id IS NULL`, which means legacy.
6. A dispatch already reserved on the harness path still runs on harness (R3). List them with
   `SELECT dispatch_id, task_id FROM dispatches WHERE execution_path='harness' AND phase IN ('reserved','start_attempted');`
   and cancel them or let them run.

No schema change is involved in either direction.
