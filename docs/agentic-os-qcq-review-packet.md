# Quality, Cost & Quota: review packet for dispatch-changing follow-ups

Status: PROPOSED, revision 2, 2026-11-24. Applies to `qcq-04-account-concurrency` and
`qcq-05-act-on-recommendation` only. `qcq-01` (advisory estimate, API 2.15) changes no dispatch,
budget or schedule and needs none of this. Paid verification runs stay pending itay's budget
approval; any live scheduling change stays pending his rollout approval.

Revision 1 (2026-11-21) proposed one K4b claim per task, keyed by `core.auth.account`, taken in the
wake transaction and released at task settlement. A GPT-6.2-Astra High review of `main` at
`4997dc4` returned FAIL with six blocking findings. Revision 2 replaces that design. The finding map
in section 4 says where each finding is answered. Nothing here is implemented: every code
reference is to `main` at `4997dc4`, and every "today" describes that revision.

## 1. What changes

- **qcq-04**: one hard concurrency limit per provider account. It counts each provider attempt,
  whether it comes from a scheduler wake, a direct `/start`, a compare or race candidate, an
  autopilot attempt, a failover, a retry or a restart. The unit is the **attempt**, not the task
  (section 2.1). The limit applies only to accounts the operator declares (section 2.2). With
  enforcement off, which is the default, no account claim exists and dispatch behaves as it does
  today.
- **qcq-05**: an opt-in that turns a `run-in-window` recommendation into an extra readiness bound
  on the task's wait. It never replaces an existing wait, and it never applies to
  `wait-for-approval`. **A timer never answers an approval, never authorizes a changed proposal, and
  never marks an attempt accepted** (section 3).

## 2. qcq-04 design

### 2.1 The unit is an attempt

An **attempt** is one provider execution: one Harness session or one legacy adapter run. It is the
thing that occupies an account. A single task has one attempt at a time. A compare or race task has
one attempt per candidate. A failover, retry, K11 continuation, quota resume or restart is a new
attempt of the same task.

Every attempt has a durable row from the moment it needs capacity, created before any provider
call, and that row owns the attempt's claims. It moves through these states:

| State | Meaning | Holds claims |
|---|---|---|
| `queued` | waiting for capacity; owns nothing | no |
| `held` | every requirement granted, provider not yet entered | yes |
| `starting` | `start_attempted` (or the candidate equivalent) committed; provider entry may have happened | yes |
| `live` | a session or run row exists for it | yes |
| `stopping` | a stop was requested (cancel, race loss, timeout); the provider has not confirmed exit | yes |
| `ambiguous` | the plane cannot prove whether a provider is live (legacy start ambiguity, stop never confirmed) | yes |
| `settled` | provider exit is proven (section 2.6) | released |
| `dropped` | released without ever entering a provider: cancelled while queued or held, race decided, refused by a launch check, mapping changed, re-routed | released |

Claims exist exactly while the attempt is `held`, `starting`, `live`, `stopping` or `ambiguous`.
`settled` and `dropped` are final, and a final attempt's claims are released in the same
transaction that makes it final.

### 2.2 Account identity

`core.auth.account` is **not** an account identity. Claude and Codex both report the label
`env-credential` for any environment credential, and Codex reports `env:<VAR>` when
`authEnvVars` is set, so two aliases of one credential get different labels
(`packages/adapters/src/claude.ts` `detectAuth`, `packages/adapters/src/codex.ts` `detectAuth`).
The autopilot lane runs as the agent user, whose login the plane deliberately does not read
(`scheduler.ts` `revalidateQuota`). The plane therefore cannot discover which assistants share an
account. The operator declares it.

```yaml
scheduling:
  accounts:
    enforce: false            # default. false: no account claims, today's dispatch
    defaultLimit: null        # limit of an undeclared assistant's own fallback account; null = no claim
    groups:
      anthropic-personal:     # operator label: [a-z0-9-]{1,40}, non-secret, never a credential
        provider: anthropic
        limit: 2
        members:
          - { assistant: claude-code, runAs: plane }
          - { assistant: claude-code-opus, runAs: plane }
      anthropic-agent:
        provider: anthropic
        limit: 1
        members:
          - { assistant: claude-code, runAs: agent }
```

The resolver `accountKey(assistantId, runAs)` returns one of:

| Case | Key | `account_source` |
|---|---|---|
| `(assistant, runAs)` is a member of group `g` | `account:g` | `declared` |
| not a member, `defaultLimit` set | `account:fallback:<runAs>:<assistantId>` | `fallback` |
| not a member, `defaultLimit` null | none: the attempt has no account requirement | `none` |

The rules are these:

- The execution identity is the pair (assistant, `runAs`). The same assistant run as the plane
  user and run as the agent user are two members, which may sit in two groups.
- A pair belongs to at most one group. Two groups that both list it are a config error.
- A group's `provider` must equal the provider family of each member's manifest, so a mis-mapped
  assistant fails config load instead of sharing the wrong slot.
- The `account:` prefix is reserved. A `scheduler.resources` pool whose name starts with `account:`
  is a config error, so a fallback key can never collide with a declared group or a host pool, and
  a declared label can never collide with a fallback (`fallback` is not a valid group label).
- `enforce: true` requires `scheduler.enabled: true`. Without a scheduler, a queued attempt would
  never be granted, so config load rejects the combination.
- `core.auth.account` stays as evidence only. Config check warns when two undeclared assistants
  report the same specific label, for example the same `env:<VAR>`, and suggests declaring a group.
  It never merges them.
- The existing `scheduling.accountConcurrency` stays advisory. With `enforce: true`, the estimator
  reports the enforced limit and live claims instead.
- Each attempt stores the resolved key, its source, and `account_config_hash`, a hash of the group
  definition it was resolved from. The final pre-provider check resolves the key again (section 2.4).

### 2.3 Schema change

This is one migration, using the next free number at implementation (057 on `main` at `4997dc4`).
It follows the 017/023 rebuild pattern, under deferred foreign keys with an explicit
`pragma_foreign_key_check`.

```sql
CREATE TABLE execution_attempts (
 attempt_id TEXT PRIMARY KEY,                   -- 'att_<uuid>'
 task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('dispatch','direct','candidate','restart')),
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),   -- set for kind = 'dispatch'
 candidate_slot INTEGER NOT NULL DEFAULT 0,     -- 0 single; 1..n parallel ordinal, the stable tie-break
 assistant_id TEXT NOT NULL,
 run_as TEXT NOT NULL CHECK(run_as IN ('plane','agent')),
 account_key TEXT,                              -- NULL iff account_source IN ('none','unresolved')
 account_source TEXT NOT NULL CHECK(account_source IN ('declared','fallback','none','unresolved')),
 account_config_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('queued','held','starting','live','stopping','ambiguous','settled','dropped')),
 session_id TEXT REFERENCES runs(id),
 predecessor_id TEXT REFERENCES execution_attempts(attempt_id),  -- failover / retry / restart chain
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_at TEXT, reason TEXT,
 CHECK((account_key IS NULL) = (account_source IN ('none','unresolved'))),
 CHECK(kind != 'dispatch' OR dispatch_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_attempt_dispatch ON execution_attempts(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_session ON execution_attempts(session_id) WHERE session_id IS NOT NULL;
-- One open attempt per (task, candidate slot): a single task, or one parallel candidate, never has two.
CREATE UNIQUE INDEX uq_attempt_open ON execution_attempts(task_id, candidate_slot)
 WHERE state IN ('queued','held','starting','live','stopping','ambiguous');

-- Everything an attempt needs to launch, granted all together or not at all.
CREATE TABLE attempt_requirements (
 attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
 resource TEXT NOT NULL,                        -- a host pool, or an 'account:' key
 units INTEGER NOT NULL CHECK(units > 0),
 queued_at TEXT NOT NULL,                       -- requirement age, carried as K4b carries resource_queued_at
 PRIMARY KEY(attempt_id, resource)
);
CREATE INDEX idx_requirement_queue ON attempt_requirements(resource, queued_at, attempt_id);
```

`resource_claims` is rebuilt as follows:

- Add `attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id)` and
  `account_source TEXT`.
- Make `dispatch_id` and `generation` nullable. A direct start and a parallel candidate have no
  dispatch.
- Replace `uq_claim_live ON (task_id)` with `uq_claim_live ON (attempt_id, resource) WHERE
  released_at IS NULL`. Several candidates of one task, and the host pool and the account of one
  autopilot attempt, can then all be live at once. Both of the reviewer's failed inserts become
  legal.
- Replace `uq_claim_dispatch ON (dispatch_id)` with `UNIQUE(dispatch_id, resource) WHERE
  dispatch_id IS NOT NULL`.
- Keep `idx_claim_live_resource`.

`wait_conditions` is rebuilt as follows:

- Add `attempt_id TEXT REFERENCES execution_attempts(attempt_id)`: the queued attempt a
  single-path `resource` wait is waiting on.
- Add `window_json TEXT` for qcq-05 (section 3).
- Widen the CHECK to `kind != 'resource' OR resource IS NOT NULL OR attempt_id IS NOT NULL`, so a
  wait can be on an account alone.

`resource`, `resource_units` and `resource_queued_at` keep their K4b meaning: the task's durable
host-pool intent (I-S1).

The migration backfills these rows:

1. For every live `resource_claims` row, an attempt `att_mig_<claim_id>` of kind `dispatch`, bound
   to the claim's dispatch, in state `live` if a run carries that dispatch and `held` otherwise. The
   claim gets that `attempt_id`, so the autopilot ownership check keeps finding its pool claim.
2. For every live run or session with no attempt (direct starts, parallel candidates, runs from
   before the upgrade), an attempt in state `live` with `account_source = 'unresolved'`.

SQL cannot read manifests or config, so `unresolved` keys are resolved at boot, before the first
grant (section 2.8).

### 2.4 One reservation point, on every provider start

The **launch reservation** is the only place a claim is granted. It is one transaction that does
the following:

1. Fixes the routing choice: a fresh route, or the stored decision on replay.
2. Resolves `accountKey(chosen, runAs)`.
3. Writes or reuses the attempt row and its `attempt_requirements`: the task's host pool, if any,
   plus the account, if any.
4. Runs the K4b gate for **every** requirement: declared capacity, readiness, FIFO front, and free
   units.
5. Either inserts every claim, with the attempt moving to `held`, or inserts none, with the attempt
   staying `queued` and a durable wait as described in section 2.5.

A partial grant is not expressible. Either the whole requirement set commits with the attempt, or
nothing does.

Today the K4b pool claim commits in the wake transaction, before routing
(`scheduler.ts` `wake`, then `start` routes in a later transaction). Revision 2 moves the pool claim
to the launch reservation as well, so pool and account are granted together. The wake keeps the
pool gate as a non-binding pre-check, which avoids consuming a condition that obviously cannot be
granted, but it no longer claims. With enforcement off and no account requirement, the observable
K4b outcomes are unchanged: who runs, FIFO order, events, `resource.unsatisfiable`. Only the claim
moves later, from before routing to after it. The existing K4b tests and `demo:a5` are the
regression set for that.

Every path that enters a provider goes through the launch reservation:

| Path today | What changes |
|---|---|
| Scheduler dispatch (`Scheduler.start`, route transaction) | The route transaction becomes the launch reservation. A `queued` result re-parks the dispatch `reparked` with reason `resource_wait`. |
| Direct `/start` (`server.ts` `launch`) | The `CREATED -> ROUTING` transaction also creates an attempt of kind `direct` and reserves it. When capacity is full, the task goes `WAITING_RESOURCE` with an attempt wait whose continuation intent carries the confirmed assistant and composition digest. The idempotency record stores `queued`, and the route returns 202 `{ queued: true, reason: "resource_wait", account, limit, liveOwners }`. A capacity wait **never** reaches the `catch` that marks the task `FAILED`. |
| Legacy compare/race (`startTask(..., { parallel: true })` per candidate) | `startParallel` creates every candidate attempt (slots 1..n) in one transaction, then reserves each in slot order. Granted candidates start, and the rest stay `queued` (section 2.7). |
| Composed compare/race (`startComposedCandidates` calls `harnessBridge.start` directly) | Binding stays up front, but launch is per attempt. The bound plan is persisted on the attempt, and a queued candidate launches from it on grant, after rechecking the composition budget and policy. |
| Autopilot (`admit` attaches the pool wait, then a scheduler dispatch) | The attempt's requirements are the pool **and** the agent-lane account. Section 2.4.1 covers the launch checks. |
| Failover, handoff, K11 continuation, quota resume, same-assistant cooldown resume | Each is a new attempt with `predecessor_id`, reserved at its own grant (section 2.9). |
| `POST /api/tasks/:id/restart` and Harness `origin.kind = 'resume'` | A new provider process is a new attempt of kind `restart`, reserved like a dispatch. |
| Approval answer or verification continuation inside a live session | **No new attempt.** The live attempt already holds its claims (section 2.10). |

`assertLaunchClaim` stays a closed gate, now per attempt. A start with no `held` attempt, or with
one whose claims do not cover its requirements, throws before any provider call. Any path not in
this table therefore fails closed instead of running outside capacity. That covers the reviewer's
finding that a task with no declared resource returns immediately today.

#### 2.4.1 The final check

The Harness runner's `beforeProviderStart` and the legacy `executeDispatch` both call it,
immediately before `adapter.start` or `adapter.resume`. In one transaction, it does the following:

1. Confirms the attempt is still `held` or `starting` and owns live claims for every requirement.
2. Re-resolves `accountKey(request.assistantId, runAs)` and compares the key and
   `account_config_hash` with the attempt's.
3. On mismatch, refuses with `account_mapping_changed`. The attempt goes `dropped`, its claims are
   released, the dispatch re-parks, and no provider is called. The started provider can therefore
   never differ from the charged account.

For an autopilot attempt, `launchCheck` step 2 changes from "the dispatch holds a live pool claim"
to "the attempt bound to this dispatch holds live claims for the pool **and** its account".
Everything else in `launchCheck` is unchanged: window, budget, attestation, typed refusal, and
the window charge only on the final pass. A refusal at either pass drops the attempt and releases
both claims in the refusal transaction. The final pass already commits the window charge, so a
refused final pass charges nothing.

### 2.5 Waiting without holding

A `queued` attempt holds no units of any resource. The queue for a resource `R` is every `queued`
attempt with a requirement on `R`. They are ordered by requirement `queued_at`, then `task_id`,
then `candidate_slot`. Readiness keeps the K4b rule (`resourceReady`):

- A single-path attempt is ready when its task's active wait condition is ready. Not-due,
  dependency-pending and quota-blocked heads are skipped, so they cannot stall ready work.
- A candidate is ready while its group is undecided and the task is `RUNNING`.

The grant side applies the same rule. An attempt is granted only if it is the ready front of
**every** queue it is in, and every requirement has free units. Strict FIFO per resource is kept, as
in K4b. An attempt that needs both the host pool and account A waits until it is the front of both,
and holds neither in the meantime. Work that needs only one of them proceeds when it is the front
there. Taking nothing while waiting is what prevents the opposite-order deadlock in test 4.

Notifications work as in K4b. A release notifies every resource it freed. The front ready attempt
of each is re-evaluated: a single-path attempt through `wake` of its condition, a candidate through
`grantCandidate(attemptId)`. The timer sweep re-checks anything that missed its event.

Operator run-now may skip FIFO, as it may today, but never capacity.

The durable wait for a single path is the existing `wait_conditions` row, kind `resource`, with
`attempt_id` set. The task is `WAITING_RESOURCE`, so it is visible and explained exactly like a pool
wait. A candidate's wait is its `queued` attempt row. The task stays `RUNNING` because other
candidates may be live.

When a single-path wake re-routes at grant and the chosen account changes, the queued attempt is
dropped (`rerouted`) and a new attempt reserves the new account. The new requirement starts with
the current time as its age. Same pool and same units carry their age, as in K4b. Capacity-aware
routing, which prefers a free account, is not in this design (section 7).

### 2.6 Release at attempt settlement

The release boundary is the attempt's own **provider-exit evidence**. Task settlement is not it, a
sibling is not it, and the plane's terminal transition is not it. The evidence for each kind of
attempt is:

- **Harness**: the session is terminal and its `execution_results` row exists. This is the
  per-session half of today's `hasOwner`, applied to one session instead of the task.
- **Legacy**: the adapter run's exit was observed and the run row has `ended_at`. A cancel request
  is not exit evidence, and neither is `adapter.cancel` resolving.

`releaseIfIdle(taskId)` becomes `releaseIfSettled(attemptId)`. The sweep `releaseIdleClaims` walks
live attempts and applies the same per-attempt evidence test. `hasOwner(taskId)` stays for the
task-level questions it answers today, such as whether `attach` may proceed.

| Outcome | Attempt | Claims |
|---|---|---|
| completed / failed, provider exited | `settled` | released once, notify every freed resource |
| cancel while `queued` or `held` | `dropped` | released (`held`) or none (`queued`); **zero provider calls** |
| cancel during an unresolved `adapter.start` (`starting`) | `stopping` | **held** until exit evidence, or `ambiguous` (below) |
| cancel while running, adapter slow to acknowledge | `stopping` | **held** until exit evidence |
| race loser | `stopping` | held until its exit is observed |
| approval / verification pause in a live session | `live` | held |
| compare waiting only for the operator's pick | all `settled` | **zero** claims for the task |
| stop never confirmed within `stopEvidenceMs` | `ambiguous` | **held**, operator event `attempt.stop_unconfirmed` |
| launch-check refusal, mapping change, re-route, race decided before launch | `dropped` | released in that transaction |

`stopEvidenceMs` defaults to the run's hard-kill timeout plus 60 seconds. Today `cancelTask`
commits `CANCELLED` before adapter cancellation finishes. That stays true for the task. The task's
state and the attempt's capacity are now separate facts.

A duplicate cancel, a duplicate settle or a stale-generation wake is inert. A final attempt cannot
change state, and a claim is released with `released_at IS NULL` in its `WHERE` clause.

**This supersedes the K4b "known ceiling"** (`docs/agentic-os-k4b-resource-slots.md` §3), which
releases at the plane's terminal boundary. Under a hard account limit, releasing a slot while a
provider may still be running over-admits the account. Revision 2 holds the slot, and an
operator reconciles an `ambiguous` attempt. That reconciliation is `POST
/api/attempts/:id/confirm-stopped`, which uses the scope `runNow` uses today. The change applies to
pool claims too, because they now belong to the same attempt. The re-review should confirm this is
acceptable for host pools.

### 2.7 Parallel groups

- A group is never reserved as a whole. Each candidate competes for its own slot in slot order.
  Neither a compare at limit 1 nor a group larger than the account limit can deadlock: candidate
  1 runs, candidate 2 queues, and candidate 1's own settlement releases its slot.
- `settleParallelRun` counts **unfinished candidate attempts** of the task: `queued`, `held`,
  `starting`, `live`, `stopping` or `ambiguous`. Today it counts live siblings only, so a queued
  candidate is invisible to it.
- **Race, first success**: in the winner's transaction, every `queued` or `held` candidate goes
  `dropped` (`race_decided`), with no provider call. Every live loser goes `stopping`, and its
  slot stays held until exit. `finishComparison` does not wait for loser exit; only the slots wait.
- **Race, a failure**: the next queued candidate stays eligible and runs when it reaches the front.
  The task is `FAILED` ("every racing assistant failed") only when every candidate attempt is
  `settled` failed or `dropped` by a refusal, and none is still unfinished.
- **Compare**: `WAITING_INPUT` `comparison_pending` is entered only when every candidate attempt is
  `settled`. The task then holds zero claims.
- Autopilot tasks never run in parallel. That is unchanged (`startTask` throws).

### 2.8 Recovery and upgrade

Boot runs in this fixed order, and no grant happens before step 4:

1. Existing Harness and legacy execution recovery, unchanged.
2. **Attempt reconciliation.** Resolve every `unresolved` account key from the attempt's assistant,
   its `runAs` and the current config, and insert its claims. A live owner that pushes an account
   over its limit is allowed: it is not cancelled, and no new grant happens until occupancy falls
   below the limit. Then classify every open attempt:
   - `held` with a `reserved` dispatch: kept; the replay reuses its claims.
   - `starting`, Harness, with a session row: `live`.
   - `starting`, Harness, no session, at least `RECOVERY_WINDOW_MS` (60 seconds) since
     `start_attempted`: `dropped`, re-park as today. A fresh Harness start persists its session
     before calling the provider, so no session proves no call.
   - `starting`, Harness, inside the 60-second window: held, rechecked on the next sweep.
   - `starting`, legacy, no run: `ambiguous`, held across any number of boots until explicit
     reconciliation. Legacy calls the adapter before inserting the run, so the plane cannot know.
   - `live` or `stopping` with exit evidence: `settled`. Legacy runs do not survive a restart, and
     step 1 already ends them.
3. Dispatch reconciliation (`reconcileOnBoot`), unchanged except that it acts per attempt.
4. Sweep, then the first tick.

The reviewer found a retry edge, and the fix is this: `runNow(confirmNoLiveOwner)` today refuses
when **any** run exists on the task (`SELECT 1 FROM runs WHERE task_id = ?`). A settled predecessor
can therefore block reconciliation of an ambiguous successor. The predicate becomes "a run exists
for **this** dispatch" (`runs.dispatch_id = ?`).

### 2.9 Failover and retries

- The predecessor attempt released its account when its session settled, and that settlement is
  why failover runs. A same-account retry therefore never waits on its own claim.
- Today `deferResourceContinuation` carries the predecessor's pool requirement forward and routes
  at grant. Revision 2 keeps that for the pool, with the same age, and **does not** carry the
  account. The account is derived from whatever the successor is routed to at its grant. A
  successor routed from A to B owns only B, and only once it is launched. If B is saturated, the
  successor is `queued` on B and holds nothing on A.
- Manual handoff, unattended same-assistant quota resume (`parkSameAssistant`), K2 backoff and
  `maxAutoWakes` are unchanged. They decide **when** the successor's wake fires. The launch
  reservation decides whether it may take a slot. A reset that arrives while quota stays blocked
  re-parks with backoff, makes no provider call and does not loop. A reset is a recheck time, not
  headroom (`QuotaProjection`).
- Checkpoint continuity is unchanged. The successor attempt continues from the predecessor's
  checkpoint exactly as the dispatch does today.

### 2.10 Approval ownership

- A live session waiting on an approval or a verification is a live attempt and keeps its claims.
  This keeps the K4b table row the reviewer judged sound.
- A pre-start human hold, such as a pending start approval, has no attempt and owns no slot.
- An explicit approval continues the **same** session and attempt. No reservation runs, and no
  second provider is admitted.
- Nothing in qcq-04 answers, expires or skips an approval. Time advancing, a tick, run-now and a
  restart only ever reach the launch reservation, and the reservation never touches an approval.
- Denial, expiry and cancellation keep their existing outcomes. The attempt releases its claims at
  provider exit, as section 2.6 describes.

### 2.11 Explainability

Every grant, wait, refusal and release writes a `scheduler_events` row:
`attempt.queued`, `attempt.granted`, `attempt.dropped`, `attempt.released`,
`attempt.stop_unconfirmed` or `attempt.mapping_changed`. The payload carries the following:

- `attemptId`, `kind`, `candidateSlot`
- `account` and `accountSource`
- `limit`, `claimedUnitsAfter`
- `liveOwners`: the attempt ids and task ids holding that account
- the requirement's age
- the reason

For qcq-05, it also carries the recommendation used (section 3). The operator pool listing shows
`account:` resources beside host pools. The estimator's `capacity` reads enforced claims when
`enforce: true`, and stays advisory otherwise. The API minor version is bumped once, using the next
free number at implementation.

## 3. qcq-05 design

- **Opt-in**: global `scheduling.actOnRecommendation: false` by default, plus a per-request
  `deferToWindow: true` on start. It needs the `tasks.start` grant. A read-only estimate credential
  (`routing.read`) and a create-only credential cannot schedule execution.
- **Kinds**: only `run-in-window` is acted on. `run-now`, `wait-for-quota-reset` (that is K2's job)
  and `wait-for-approval` (whose `startAt` is null) never create a window bound.
- **A bound, not a replacement**: the window is written to `window_json` on the task's active
  condition. That covers a time, quota, dependency or resource wait. It is carried forward
  explicitly across replacement, the way the K4b requirement is. If the task has no active
  condition, a `time` wait is created at the window start. The opt-in **never** replaces or
  consumes an existing dependency, quota, resource or human-hold condition. On a task paused for an
  operator decision, it is refused.
- **Recorded when the bound is created, not at run start**: `window_json` records:
  - the recommendation kind, the window start and end, and `estimatorVersion`
  - the evidence run ids and the policy hash
  - the confirmed assistant and composition digest
  - the effective approval mode, including the autopilot's configured `approvalMode` and the
    workspace's read-only mode
- **Readiness**: `now >= windowStart` and `now < windowEnd - scheduling.windowMinSliceMs` (new, default 10 minutes) are added to the condition's
  readiness. This applies to the time wake, the resource FIFO readiness and the launch reservation.
  A duplicate timer or event wake is inert (generation check), so the start happens exactly once.
- **Window closed**: on a wake after the window closes, on a restart after it closes, or when an
  account grant arrives after it closes, nothing starts. The task re-plans. A new `run-in-window`
  recommendation writes a new bound, counted against `maxAutoWakes` with K2 backoff. Any other
  recommendation moves the task to `WAITING_INPUT` (`window_replan`) with the explanation. A task
  never starts late into closed hours.
- **Rechecks**: these run at the wake, at the launch reservation, and again in `beforeStart`, which
  includes a replay of a materialized request. That replay skips recomposition (`recompose` returns
  undefined), so the replay is where a stale authorization would otherwise slip through. Each
  failure refuses before provider entry with its own reason:
  - The window is open.
  - Current quota allows the start.
  - `pendingApprovalCount(task) == 0`. This is the combined Harness and legacy reader in
    `task-outcome.ts`, not the estimator's Harness-only count.
  - The effective approval mode is not looser than the recorded one (`tightenedApproval`).
  - The chosen assistant and digest equal the recorded confirmation. Otherwise the result is
    `route_changed` and `WAITING_INPUT`, never a silent swap.
  - The assistant is not disabled (`disabledForNewStart`).
  - The Composer stage-5 spend cap is not exhausted.
  - The workspace is not read-only.
- **Never**: a timer never answers an approval, authorizes a changed proposal, or marks an attempt
  accepted. Acceptance keeps its existing path, with the required acceptance command run before
  publication in `autopilot-dispatcher.ts`. A failed acceptance command leaves no accepted state
  and no publication.

## 4. Finding map

| Astra finding (2026-11-24, `4997dc4`) | Answered in |
|---|---|
| 1. Acquisition point misses real starts and precedes account selection; capacity error can mark `/start` FAILED | 2.4 (launch reservation on every path, direct `/start` returns 202 queued), 2.4.1 |
| 2. Schema cannot represent per-candidate owners, multi-resource claims or candidate waits | 2.1, 2.3 (`execution_attempts`, `attempt_requirements`, rebuilt indexes), 2.5 |
| 3. Task settlement is the wrong release boundary; group settlement ignores queued candidates | 2.6 (per-attempt exit evidence, supersedes K4b ceiling), 2.7 |
| 4. Recovery and failover need attempt-specific evidence; `runNow` predicate; A→B failover | 2.8 (boot order, `runs.dispatch_id` predicate), 2.9 |
| 5. `core.auth.account` is not an account identity | 2.2 (declared groups, `(assistant, runAs)`, fallback namespace, config hash) |
| 6. A qcq-05 timer establishes a due time, not continuing authorization | 3 |

The non-blocking findings are kept as well:

- Section 2.10 keeps the approval-slot rule.
- Section 2.5 keeps the K4b FIFO, the in-transaction capacity check, the sweep and run-now's
  capacity rule.
- Section 2.7 adds a stable slot tie-break and never reserves a whole group.
- Section 3 records the recommendation at deferral.

## 5. Required tests for the implementation PRs

Every test uses an injected clock and fake adapters that independently record three things: entry
into `start` or `resume`, cancellation acknowledgement, and provider exit. Every test asserts both
the durable claims **and** the maximum number of fake providers live at the same time. Claim counts
alone would miss an early release.

1. **Last-slot contention.** Set account A's limit to 1. Two scheduler wakes, a direct `/start`, a
   compare/race candidate and an admitted autopilot attempt all race for the slot. Exactly one
   provider enters. Every other eligible attempt has a durable resource wait, with no provider
   call, no failure and no duplicate dispatch. Repeat with legacy and composed parallel launches.
   An independent account B can still start.
2. **Identity and configuration.**
   - Two assistant ids mapped to A share one slot. Two undeclared assistants each use their own
     fallback. A fallback key cannot collide with a declared group or a host pool.
   - Exercise identical provider labels, credential aliases (`env:<VAR>`) and the agent-user lane.
   - Change a mapping between reservation and launch: the provider that starts must match the
     charged account (`account_mapping_changed`).
   - Lower a limit from 2 to 1 while two attempts are live: both finish, and no new start happens
     until occupancy falls below 1.
   - With the limit unset (`enforce: false`), behavior is unchanged.
3. **Parallel progress and fairness.**
   - At limit 1, compare two profiles on A, with an older ready single waiter and later arrivals.
     Both candidates eventually run under the documented ready FIFO. The compare enters
     `comparison_pending` only after both settle, with zero claims.
   - For race: a first failure lets the queued sibling run, a first success drops queued losers,
     and all-failed is recorded only after the last candidate fails.
   - A quota-blocked or dependency-blocked head cannot stall ready work, and run-now cannot exceed
     capacity.
4. **Multiple resources and autopilot.**
   - Occupy the host pool and account A separately, then contend for both in opposite orders. An
     unsuccessful attempt holds neither, and unrelated eligible work progresses. On grant, both
     claims belong to the same attempt.
   - Close the autopilot window, or expire its billing attestation, between the early and final
     checks. Assert zero provider calls, the existing typed refusal, release of both claims and no
     duplicate window charge.
5. **Cancellation and settlement.**
   - Cancel at four points: while queued, after reservation but before spawn, during an unresolved
     `adapter.start`, and while a running adapter delays its cancellation acknowledgement. Also
     delay a race loser's exit.
   - A pre-spawn cancellation makes zero calls. A possibly live provider keeps occupying its slot.
     After confirmed settlement, the next waiter wakes exactly once.
   - A duplicate cancel, a duplicate settle and a stale-generation wake are inert.
6. **Crash and upgrade recovery.**
   - Kill and reopen the plane at five points: after the claim, after route or request
     materialization, after `start_attempted` with no run, after session creation but before the
     phase update, and after a durable end but before release.
   - Include a queued sibling, and a live pre-upgrade run with no new-format claim (an `unresolved`
     backfill).
   - Assert no over-admission on first boot, no duplicate start and no leaked settled claim.
   - Harness missing-session recovery respects 60 seconds.
   - Legacy ambiguity survives repeated boots until explicit reconciliation, including when the task
     has a historical predecessor (the `runs.dispatch_id` predicate).
7. **Failover and retries.**
   - At limit 1, fail on A and retry on A. Then fail on A and route to a saturated B. The
     predecessor releases exactly once, a same-account retry cannot wait on itself, and a B
     successor owns only B once it is launched.
   - Repeat for manual handoff and for unattended same-assistant quota resume. Assert checkpoint
     continuity, K2 backoff and the maximum number of automatic wakes.
   - A reset while quota stays blocked produces no provider call and no tight timer loop.
8. **Approval ownership.**
   - In both legacy and Harness, park a live provider on an approval while another A waiter exists.
     Advance time, tick, run-now and restart. No timer sends an approval response, and no second
     provider is admitted while ownership is live or ambiguous.
   - An explicit approval continues the same session. Denial, expiry and cancellation follow their
     existing outcomes and release after settlement.
   - A pre-start approval hold owns no slot. Exercise the verification pause and the final
     comparison pause separately.
9. **Window durability (qcq-05).**
   - With the opt-in off, or with `run-now`, `wait-for-quota-reset` or `wait-for-approval`, no
     recommendation bound is created.
   - With an authorized `run-in-window`, defer to Sunday 19:00 Asia/Jerusalem, restart before then,
     and deliver duplicate timer and event wakes. Assert zero early calls and exactly one eligible
     start.
   - Restart after the window closes, or hold capacity until it closes: the task re-plans without
     starting late.
   - An existing dependency, quota delay or human hold survives the opt-in.
10. **Authorization, spend and acceptance (qcq-05).**
    - A read-only estimate credential and a create-only credential cannot schedule execution.
    - Insert a pending approval after deferral, change the confirmed assistant or digest, tighten
      permissions, and exhaust the remaining Composer budget. Repeat each after request
      materialization and after a restart. Each gate refuses before provider entry, with its own
      reason.
    - Capture the effective approval mode, including the autopilot's and workspace read-only mode.
    - Fail a required acceptance command, and assert no accepted state and no publication.
    - Verify that the wait and refusal evidence names the account, the limit, the live owners and
      the recommendation used.

## 6. Evidence and slices

The implementation lands in four slices, each a separate PR reviewed against this packet, plus
qcq-05:

| Slice | Scope | Tests |
|---|---|---|
| qcq-04a | Migration, attempt rows on every start path, resolver and config (`enforce: false` only), boot reconciliation of `unresolved` keys | 2 (identity, unset), 6 (upgrade backfill) |
| qcq-04b | Launch reservation on the single, direct `/start` and autopilot paths; attempt release; final check; `runNow` predicate | 1 (single paths), 4, 5, 6, 8 |
| qcq-04c | Parallel candidates and group settlement | 1 (parallel), 3, 5 (race loser) |
| qcq-04d | Failover, handoff, restart and resume as attempts | 7 |
| qcq-05 | Window bound and rechecks, after qcq-04b | 9, 10 |

Every slice attaches the following:

- The gates: `pnpm typecheck && pnpm lint && pnpm test`.
- `pnpm demo:a`, `demo:a5` and `demo:b` with account A's limit set to 1 and two fake assistants
  in group A, run with an injected clock, no credentials and no quota spend. The capture shows one
  live provider and one resource wait naming account A, its limit and its live owner.
- A restart capture that kills the plane at each point in test 6 and shows zero leaked claims and
  zero over-admission.
- For qcq-05, a capture that defers a fake task to Sunday 19:00 Asia/Jerusalem, restarts before
  then, and shows the scheduler starting it exactly once inside the window.

Every implementation PR needs one Opus 5.5 High reviewer, or GPT-6.2-Astra High. qcq-04b and
qcq-04c change dispatch on every path, so they get both reviewers.

## 7. Not in scope

These are not part of this design:

- Capacity-aware routing, meaning a router that prefers a free account. Routing stays as it is,
  then waits.
- Budget enforcement beyond the existing Composer caps.
- Paid runs.
- Turning on `enforce: true` or `actOnRecommendation` in live config.
- Any live change on the OCI box.

The last four need itay's explicit approval.

## 8. What the re-review must check

1. Every provider entry in section 2.4's table goes through the launch reservation, and no other
   path exists. Look for `adapter.start`, `adapter.resume`, `harnessBridge.start` and
   `harnessBridge.startRequest` call sites that the table does not name.
2. The schema in section 2.3 admits every legal owner, including several candidates of one task and
   a pool claim plus an account claim on one attempt. It rejects two open attempts on one
   (task, slot). The backfill leaves the autopilot `launchCheck` able to find its pool claim.
3. Moving the K4b pool claim from wake to the launch reservation keeps every observable K4b
   outcome when enforcement is off.
4. Holding slots through `stopping` and `ambiguous` is acceptable for host pools as well as
   accounts. This supersedes the K4b known ceiling.
5. The `(assistant, runAs)` group declaration, the `account:` namespace rule and the config-hash
   recheck close finding 5. No path uses `core.auth.account` as a key.
6. Boot order in section 2.8 grants nothing before reconciliation, and the `runs.dispatch_id`
   predicate fixes the ambiguous-successor edge.
7. The qcq-05 window is a bound that never replaces a condition. Its rechecks run on materialized
   replay. No timer path can answer an approval or mark an attempt accepted.
8. The ten tests in section 5 are sufficient, and each maps to a slice.
