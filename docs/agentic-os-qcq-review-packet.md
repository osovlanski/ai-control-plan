# Quality, Cost & Quota: review packet for dispatch-changing follow-ups

Status: PROPOSED, revision 4, 2026-11-24. Applies to `qcq-04-account-concurrency` and
`qcq-05-act-on-recommendation` only. `qcq-01` (advisory estimate, API 2.15) changes no dispatch,
budget or schedule and needs none of this. Paid verification runs stay pending itay's budget
approval; any live scheduling change stays pending his rollout approval.

Revision history. Revision 1 (2026-11-21) proposed one K4b claim per task keyed by
`core.auth.account`; Astra High at `4997dc4`: FAIL. Revision 2 (PR #257, merged `c34c29e`)
introduced per-attempt claims; Astra High at `c34c29e`: FAIL. Revision 3 (PR #260 head `428f859`)
added a provider-entry gate, exit proofs, a boot barrier and a global grant pass; Astra High at
`428f859`: FAIL, with the crossed-age FIFO deadlock and the qcq-05 recheck placement resolved, and
the gate, upgrade, exit evidence, legacy loser, successor intent, wake/grant ordering, rollout and
test seams still open. Revision 4 answers those, and narrows account enforcement to Harness starts
(itay's decision, 2026-11-24). Section 4 maps every round's findings. Nothing here is implemented:
every code reference is to `main` at `c34c29e`, and every "today" describes that revision.

## 1. What changes

- **qcq-04**: one hard concurrency limit per provider account. It counts each provider attempt,
  whether it comes from a scheduler wake, a direct `/start`, a compare or race candidate, an
  autopilot attempt, a failover, a retry or a restart. The unit is the **attempt**, not the task
  (section 2.1). The limit applies only to accounts the operator declares (section 2.2), and only to
  **Harness** starts: with enforcement on, a legacy start that would need an account slot is refused
  with a typed reason (section 2.2). With enforcement off, which is the default, no account claim
  exists and dispatch behaves as it does today, except for the intended K4b changes listed in
  section 2.13.
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
| `queued` | waiting for capacity, or waiting for its predecessor in the same slot to be final; owns nothing | no |
| `held` | every requirement granted; **the provider has provably not been entered** | yes |
| `starting` | the provider-entry commit happened (section 2.4.1); the adapter call may have happened | yes |
| `live` | a session or run row has the provider's handle | yes |
| `stopping` | a stop was requested (cancel, race loss, timeout); exit is not yet proven | yes |
| `ambiguous` | the plane cannot prove whether a provider is live (legacy start ambiguity, exit never proven) | yes |
| `settled` | provider exit is proven by an exit proof (section 2.6) | released |
| `dropped` | released without ever entering a provider: cancelled while queued or held, race decided, refused by a launch check, mapping changed, session ended before the commit | released |

Claims exist exactly while the attempt is `held`, `starting`, `live`, `stopping` or `ambiguous`
(the **owner states**). `settled` and `dropped` are final, and a final attempt's claims are released
in the same transaction that makes it final.

**The entry invariant.** At runtime, the only transition into `starting` is the provider-entry
commit, and the adapter call is the next statement after that commit (section 2.4.1). So an attempt
that is `queued` or `held` has never entered a provider, on any path, across any number of crashes.
The upgrade migration is the one other writer of `starting`, for pre-upgrade dispatches it cannot
classify otherwise (section 2.3.1). Boot recovery, cancellation and group settlement rely on this
invariant, and test 1 enforces it with a call-site allowlist.

**The session-terminal rule.** Every Harness session terminal transaction (`SessionStore.finalize`
and the failure finalizers) also reads the attempt bound to the session. If that attempt is still
`held`, the same transaction moves it to `dropped` with `never_entered` and releases its claims.
This covers every runner exit that never reaches the commit: an abort while waiting for the
provider-start slot (`finalizeBeforeStream`, `session-runner.ts` 447 to 452), a fence, a preparation
error, and a session-only cancel. If the attempt is `starting` or later, the rule leaves it alone;
only an exit proof settles it.

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
- **Harness only** (itay, 2026-11-24). With `enforce: true`, an account requirement is only ever
  satisfied on the Harness execution path. The launch reservation refuses an attempt whose
  requirement set contains an `account:` key and whose execution path is legacy (a legacy dispatch, a
  legacy direct start, a plain legacy compare/race candidate), with reason
  `account_requires_harness`. The task goes to `WAITING_INPUT` `intervention_required` with that
  explanation; nothing is held and nothing starts. Config check warns when `enforce: true` is set
  while `execution.harnessModes.single` is off, because every single-path start would then be
  refused. Legacy paths keep K4b pool semantics.
- `enforce: true` also requires that every assistant that would receive an account requirement
  (a declared member, or any assistant when `defaultLimit` is set) has **strong exit evidence** on
  this host (section 2.6.1). An account limit that cannot observe exit cannot be enforced, so config
  load rejects it instead of enforcing it loosely.
- `enforce: true` is refused at config load until the enforcement gate opens (section 2.12).
- `core.auth.account` stays as evidence only. Config check warns when two undeclared assistants
  report the same specific label, for example the same `env:<VAR>`, and suggests declaring a group.
  It never merges them.
- The existing `scheduling.accountConcurrency` stays advisory. With `enforce: true`, the estimator
  reports the enforced limit and live claims instead.
- Each attempt stores the resolved key, its source, and `account_config_hash`, a hash of the group
  definition it was resolved from. The provider-entry commit resolves the key again
  (section 2.4.1), and every boot re-resolves every open attempt (section 2.8.2).

### 2.3 Schema change

This is one migration, using the next free number at implementation (057 is taken by
`057_run_effort.sql`, so 058 or later). It follows the 017/023 rebuild pattern, under deferred
foreign keys with an explicit `pragma_foreign_key_check`.

```sql
CREATE TABLE execution_attempts (
 attempt_id TEXT PRIMARY KEY,                   -- 'att_<uuid>'; migrated 'att_mig_<claim_id>' / 'att_mig_d_<dispatch_id>' / 'att_mig_run_<run_id>'
 task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('dispatch','direct','candidate')),
 execution_path TEXT NOT NULL CHECK(execution_path IN ('harness','legacy')),
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),   -- the dispatch this attempt is bound to now
 candidate_slot INTEGER NOT NULL DEFAULT 0,     -- 0 single; 1..n parallel ordinal
 assistant_id TEXT,                             -- NULL only while queued before its first route
 routing_decision_id INTEGER,                   -- the route this attempt waits on (2.5.2); NULL before the first route
 run_as TEXT NOT NULL CHECK(run_as IN ('plane','agent')),
 account_key TEXT,                              -- NULL iff account_source IN ('none','unresolved','pending')
 account_source TEXT NOT NULL CHECK(account_source IN ('declared','fallback','none','unresolved','pending')),
 account_config_hash TEXT,
 queue_key TEXT NOT NULL,                       -- FIFO position, fixed at creation (2.5.1)
 state TEXT NOT NULL CHECK(state IN ('queued','held','starting','live','stopping','ambiguous','settled','dropped')),
 session_id TEXT REFERENCES runs(id),
 launch_plan_json TEXT,                         -- candidate / direct: the bound plan a deferred grant launches from
 entered_at TEXT,                               -- set by the provider-entry commit (or the migration), never otherwise
 stop_requested_at TEXT,
 provider_unit TEXT,                            -- the systemd unit / cgroup the provider runs in (2.6.1)
 exit_proof TEXT CHECK(exit_proof IN ('cgroup_empty','host_rebooted','operator_confirmed','never_entered',
                                      'stream_closed_unverified','migrated_historical')),
 exit_proof_at TEXT,
 predecessor_id TEXT REFERENCES execution_attempts(attempt_id),  -- failover / retry / restart chain
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_at TEXT, reason TEXT,
 CHECK((account_key IS NULL) = (account_source IN ('none','unresolved','pending'))),
 -- an owner-state dispatch attempt is bound to its dispatch; queued attempts may sit between dispatches (2.5.3)
 CHECK(kind != 'dispatch' OR dispatch_id IS NOT NULL OR state IN ('queued','settled','dropped')),
 -- queued and held prove no entry (the entry invariant, 2.1)
 CHECK(state NOT IN ('queued','held') OR (entered_at IS NULL AND exit_proof IS NULL)),
 CHECK(state IN ('queued','held','dropped') OR entered_at IS NOT NULL),
 -- final states carry their proof; dropped is always never_entered. COALESCE: a NULL must not pass.
 CHECK(state != 'dropped' OR COALESCE(exit_proof, '') = 'never_entered'),
 CHECK(state != 'settled' OR COALESCE(exit_proof, '') IN ('cgroup_empty','host_rebooted','operator_confirmed',
                                                          'stream_closed_unverified','migrated_historical')),
 -- an account claim is never released by a weak proof
 CHECK(COALESCE(exit_proof, '') != 'stream_closed_unverified' OR account_key IS NULL)
);
CREATE UNIQUE INDEX uq_attempt_dispatch ON execution_attempts(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_session ON execution_attempts(session_id) WHERE session_id IS NOT NULL;
-- At most one owner per (task, candidate slot): a slot never has two providers or two claim sets.
CREATE UNIQUE INDEX uq_attempt_owner ON execution_attempts(task_id, candidate_slot)
 WHERE state IN ('held','starting','live','stopping','ambiguous');
-- At most one waiting successor per slot. It may coexist with the owner it succeeds (2.8.1, 2.9).
CREATE UNIQUE INDEX uq_attempt_queued ON execution_attempts(task_id, candidate_slot) WHERE state = 'queued';
CREATE INDEX idx_attempt_queue ON execution_attempts(queue_key, task_id, candidate_slot) WHERE state = 'queued';

-- Everything an attempt needs to launch, granted all together or not at all.
CREATE TABLE attempt_requirements (
 attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
 resource TEXT NOT NULL,                        -- a host pool, or an 'account:' key
 units INTEGER NOT NULL CHECK(units > 0),
 queued_at TEXT NOT NULL,                       -- requirement age, carried as K4b carries resource_queued_at
 PRIMARY KEY(attempt_id, resource)
);
CREATE INDEX idx_requirement_resource ON attempt_requirements(resource, attempt_id);
```

Revision 3's single `uq_attempt_open` is split into `uq_attempt_owner` and `uq_attempt_queued`.
Astra reproduced that the single open index rejects the queued successor that boot recovery and
failover must record while the predecessor is still `live`, `stopping` or `ambiguous`. The split
admits exactly that pair and still rejects two owners or two waiters in one slot. A queued attempt
whose slot still has an owner is not ready (section 2.5), so it can never be granted next to it.

`kind` loses `restart`: a restart converges on a dispatch (`server.ts` 1362 to 1375 reaches
`wake`), so it is a dispatch-kind attempt. `execution_path` is stored so the Harness-only rule and
the boot table apply without re-deriving it.

`resource_claims` is rebuilt as follows:

- Add `attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id)` and
  `account_source TEXT`.
- Make `dispatch_id` and `generation` nullable. A direct start and a parallel candidate have no
  dispatch. **A dispatch-kind attempt writes its `dispatch_id` and `generation` on every claim it
  holds, pool and account alike**, so the dispatch-to-pool association the autopilot uses survives.
- Replace `uq_claim_live ON (task_id)` with `uq_claim_live ON (attempt_id, resource) WHERE
  released_at IS NULL`.
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

#### 2.3.1 Upgrade backfill

The migration gives every `resource_claims` row an owner, because the new FK is `NOT NULL` on every
claim, and it gives every possibly entered pre-upgrade dispatch an attempt, with a claim or without.

**What "entered" means before the upgrade.** The current dispatch phase is not evidence. Astra's
case: a legacy `adapter.start` is in flight with no run row, and `cancelTask` changes
`start_attempted` to `cancelled` before the call returns (`orchestrator.ts` 1016 to 1019, 2162). The
backfill therefore classifies by whether the dispatch **ever** reached `start_attempted`, which the
`dispatch.start_attempted` event in `scheduler_events` records in the same transaction as the phase
change (`scheduler.ts` 1011 to 1014; retention does not prune `scheduler_events`). Call that the
**entry mark**. Before the upgrade, a legacy dispatch with an entry mark and no run may have entered
the adapter. A Harness dispatch with an entry mark and no session did not, because a Harness start
persists its session before calling the provider. An operator's `confirmNoLiveOwner` (the
`dispatch.aborted` event "Operator confirmed no live execution owner") closes a legacy entry mark.

Classification, first match wins, by the claim (if any), its dispatch, the dispatch's entry mark and
the run carrying that dispatch (`runs.dispatch_id`):

| Pre-upgrade row | Attempt | State | `entered_at` / `exit_proof` |
|---|---|---|---|
| claim **released**, a run carries the dispatch | `att_mig_<claim_id>`, kind `dispatch` | `settled` | `run.started_at` / `migrated_historical`; `final_at = released_at` |
| claim **released**, no run | `att_mig_<claim_id>` | `dropped` | none / `never_entered` |
| any dispatch (claim or not) carried by a run with `ended_at IS NULL` | `att_mig_<claim_id>` or `att_mig_d_<dispatch_id>`, `session_id` = that run | `live` | `run.started_at` / none |
| **legacy** dispatch with an entry mark, no run, no operator confirmation, live claim or none, whatever the current phase | `att_mig_<claim_id>` or `att_mig_d_<dispatch_id>` | **`ambiguous`** | the entry mark's time / none |
| **Harness** dispatch with an entry mark, no session, live claim | `att_mig_<claim_id>` | `dropped` | none / `never_entered` |
| **Harness** dispatch with an entry mark, no session, no claim | none: nothing was entered and nothing is owned | | |
| live claim, no entry mark, dispatch `reserved` | `att_mig_<claim_id>` | `held` | none |
| live claim, no entry mark, dispatch re-parked, aborted or cancelled | `att_mig_<claim_id>` | `dropped` | none / `never_entered` |

A migrated final attempt carries `dispatch_id` only for audit. `uq_attempt_dispatch` holds because
there is one attempt per dispatch. Under the Harness-only rule, a legacy `ambiguous` attempt can only
ever hold a pool claim, never an account, so a legacy call in flight at upgrade cannot undercount an
account. It still counts against its pool, as K4b intends.

Then, for every run or session with `ended_at IS NULL` and no attempt yet (direct starts, parallel
candidates, runs from before the upgrade): an attempt `att_mig_run_<run_id>` in state `live`, with
`account_source = 'unresolved'`, `entered_at = run.started_at`. Its `candidate_slot` is 0 on a
single task, and 1..n on a compare or race task, ordered by `started_at` and then run id (a stable
tie-break for equal timestamps). A single task that would get two owners in slot 0 already violates
today's ownership rules; the migration aborts with a named error and the operator reconciles before
upgrading, rather than the migration guessing. Ended runs with no claim get no attempt.

SQL cannot read manifests or config, so `unresolved` keys are resolved at boot, behind the launch
barrier (section 2.8).

#### 2.3.2 Every claim reader is per attempt and per resource

Today several readers assume one live claim per task. Once an attempt can own a pool and an account,
and a task several attempts, each `.get` returns an arbitrary row. qcq-04a replaces every such
reader. These are the call sites at `c34c29e`, from `git grep resource_claims` and their callers:

| Reader today | Becomes |
|---|---|
| `Scheduler.assertLaunchClaim` (`scheduler.ts` 261 to 269) | per attempt: the start's attempt is `held` and has a live claim for every requirement (an early check; the commit is authoritative) |
| `Scheduler.claim(taskId)` (`scheduler.ts` 381) | `claimsOf(attemptId)`: all live rows, keyed by resource |
| `releaseIfIdle(taskId)` (`scheduler.ts` 395) | `releaseIfSettled(attemptId)` releases every claim of the attempt in one transaction, notifying each freed resource |
| `releaseIdleClaims` (`scheduler.ts` 419) | walks open attempts, not claim rows |
| dispatch abort release, `.get(dispatch_id)` (`scheduler.ts` 892) | `.all(dispatch_id)` |
| `autopilotPark` release via `claim(taskId)` (`scheduler.ts` 1150) | releases every claim of the attempt bound to the dispatch |
| `Autopilot.launchCheck` step 2, `.get(taskId)` (`autopilot.ts` 585) | the attempt with `dispatch_id = ?`; it must list `this.cfg.pool` **and** its account (if any) in `attempt_requirements`, and hold a live claim with that `dispatch_id` for **every** requirement |
| `GET /api/tasks/:id` `resourceClaim` (`server.ts` 914) and the task wait read (`server.ts` 950) | `resourceClaim` keeps its K4b meaning: the live **pool** claim of the task's single-path owner, or null, so a K4b client sees the same value with enforcement off. New: `attempts`, the task's open attempts, each with its state, slot, account, requirements and live claims |
| web `TaskDetail.resourceClaim` (`apps/web/src/api.ts` 272) | unchanged type; `attempts?: AttemptStatus[]` added. Cockpit reads neither field at `c34c29e` |
| `claimed(resource)` sum, pool listing (`scheduler.ts` 113, 178) | unchanged: already per resource |

The `attempts` field is an additive API change, so it takes the API minor bump of section 2.11.

### 2.4 One reservation point, on every provider start

The **launch reservation** is the only place an attempt's route and requirement set are fixed.
Claims are written only by it or by the grant pass (section 2.5.2). The reservation is one
transaction that does the following:

1. Fixes the routing choice: a fresh route, or the stored decision on replay.
2. Resolves `accountKey(chosen, runAs)`. With `enforce: true`, an account key on a legacy execution
   path refuses with `account_requires_harness` (section 2.2).
3. Writes or reuses the attempt row, its `routing_decision_id` and its `attempt_requirements`: the
   task's host pool, if any, plus the account, if any.
4. Runs the grant rule of section 2.5.1 for that attempt, with the launch barrier open
   (section 2.8).
5. Either inserts every claim, with the attempt moving to `held`, or inserts none, with the attempt
   staying `queued`, its route stored, and a durable wait as described in section 2.5.3.

A partial grant is not expressible. Either the whole requirement set commits with the attempt, or
nothing does.

Today the K4b pool claim commits in the wake transaction, before routing (`scheduler.ts` `wake`
795, then `start` routes in a later transaction). Revision 4 moves the pool claim to the reservation
or the grant pass, so pool and account are granted together, and keeps the attempt's FIFO position
across the gap (section 2.5.3).

Every path that enters a provider goes through the launch reservation:

| Path today | What changes |
|---|---|
| Scheduler dispatch (`Scheduler.start`, route transaction) | The route transaction becomes the launch reservation. A `queued` result re-parks the dispatch with reason `resource_wait` (section 2.5.3). |
| Direct `/start` (`server.ts` `launch`) | The `CREATED -> ROUTING` transaction also creates an attempt of kind `direct` and reserves it. When capacity is full, the task goes `WAITING_RESOURCE` with an attempt wait whose continuation intent carries the confirmed assistant and composition digest. The idempotency record stores `queued`, and the route returns 202 `{ queued: true, reason: "resource_wait", account, limit, liveOwners }`. A capacity wait **never** reaches the `catch` that marks the task `FAILED`. |
| Legacy compare/race (`startTask(..., { parallel: true })` per candidate) | Section 2.7: one group-open transaction, then a per-candidate reservation in slot order. With `enforce: true`, a candidate needing an account is refused (`account_requires_harness`) at group open. |
| Composed compare/race (`startComposedCandidates` calls `harnessBridge.start` directly) | Binding stays up front, but launch is per attempt. The bound plan is persisted on the attempt (`launch_plan_json`), and a queued candidate launches from it on grant, after rechecking the composition budget and policy. |
| Autopilot (`admit` attaches the pool wait, then a scheduler dispatch) | The attempt's requirements are the pool **and** the agent-lane account. Section 2.4.1 covers the launch checks. |
| Failover, handoff, K11 continuation, quota resume, same-assistant cooldown resume | Each is a new attempt with `predecessor_id`, recorded as intent and reserved at its own grant (section 2.9). |
| `POST /api/tasks/:id/restart` and Harness `origin.kind = 'resume'` | Converge on a dispatch, so a new provider process is a new dispatch-kind attempt. |
| Approval answer or verification continuation inside a live session | **No new attempt.** The live attempt already holds its claims (section 2.10). |

`assertLaunchClaim` stays a closed gate, now per attempt, at the top of `startTask`. It is an early
check only. The authoritative check is the provider-entry commit below, because `startTask` awaits
worktree creation, repository identity and composition binding after `assertLaunchClaim` returns
(`orchestrator.ts` 651 to 885), and a cancel can commit during any of those awaits.

#### 2.4.1 The provider-entry gate

The gate has two parts. Only the second is authoritative.

**Precheck** (read-only, writes nothing). It runs where today's checks run: on the Harness in the
runner's `beforeProviderStart` hook after the provider-start slot wait (`session-runner.ts` 462), on
the legacy paths before the run spec is built. It evaluates every condition of the commit below, so
a doomed start does no preparation work, and it computes the **absolute launch deadline** `D` (the
autopilot window's remaining time, the request's runtime bound, the qcq-05 window end). The runner's
spec and its runtime timer use `D`, not a duration measured from the precheck, so preparation time
cannot extend a run past its window. Today's "launch admitted" event moves to the commit.

**Commit**, `enterProvider(attemptId, ctx)`, is one synchronous SQLite transaction. It runs **after
all fallible preparation**: on the Harness inside `startProvider`, after `effectiveRunSpec`, both
secret-broker resolutions and the resume-reference read (`session-runner.ts` 1346 to 1373); on the
legacy paths after the run spec is built. The adapter call is the **next statement** after the
transaction commits: no `await`, no I/O and no other transaction between them. A preparation
failure therefore happens while the attempt is still `held`, and the session-terminal rule (or, on
the legacy paths, the caller's `catch`) drops it with `never_entered`.

In one transaction the commit does the following:

1. **Ownership.** The attempt is `held`, has no `stop_requested_at`, its task is not `CANCELLED`,
   and it owns a live claim for every row in `attempt_requirements`. On the Harness, the session
   bound to the attempt has `cancel_requested = 0` (`session-store.ts` 586 to 593), which covers a
   session-only cancel during handoff or shutdown (`orchestrator.ts` 1842 to 1844, 2240). For a
   dispatch-kind attempt, the dispatch is bound to this attempt, is in `start_attempted` **or
   `started`** with `dispatches.session_id` NULL or equal to this session, and is not `aborted`,
   `reparked` or `cancelled`. Today `startRequest` returns the session id while execution is
   detached, so the scheduler commits `started` while the runner may still wait for a slot
   (`control-plane-bridge.ts` 208 to 226, `scheduler.ts` 1018 to 1024). Revision 3's
   "`start_attempted` only" predicate would have refused that valid dispatch.
2. Re-resolves `accountKey(request.assistantId, runAs)` and compares the key and
   `account_config_hash` with the attempt's.
3. Runs the autopilot final launch check, when the task is the autopilot's (window, budget,
   attestation, typed refusal; the window charge commits only on admission), against `D`.
4. Runs the qcq-05 rechecks, when the task carries a window bound (section 3).
5. On success, sets `state = 'starting'`, `entered_at = now` and `provider_unit`, writes the
   admission event, and commits.

Refusals come in two kinds:

- **Not the owner.** Step 1 finds the attempt not `held`: already `starting`, `live`, final, or bound
  to another session or dispatch. The commit changes nothing and returns `not_owner`. A duplicate
  caller can never drop or release a live owner.
- **Owner refused.** Any other failure while the attempt is `held`. The attempt goes `dropped` with
  `never_entered` and the refusal reason, every claim is released, and the caller parks the task by
  that reason. A refused autopilot pass charges nothing.

A cancel and the commit serialize on the database. Either the cancel commits first, and the commit
sees `stop_requested_at`, `CANCELLED` or `cancel_requested` and refuses with zero provider calls, or
the commit is first, and the cancel finds `starting` and moves it to `stopping` with its claims held
(section 2.6). An abort while waiting for the slot never reaches the commit; the session-terminal
rule drops the `held` attempt instead.

#### 2.4.2 Provider-entry call sites

There are exactly three credentialed boundaries in `apps/api/src` at `c34c29e`, comprising five
adapter call expressions. The commit sits immediately before each:

| Boundary | Adapter calls | Commit placement |
|---|---|---|
| Harness `RunContext.startProvider` (`session-runner.ts` 1346, called from 471) | `adapter.resume` 1374, `adapter.start` 1377 | inside `startProvider`, after the spec, secrets and resume reference, before either call |
| Legacy single, non-dispatch `startTask` | `adapter.resume` 885, `adapter.start` 886 | directly before the `priorRef ? resume : start` expression |
| Legacy dispatch `executeDispatch` | `adapter.start` 1016 | directly before the call; `beforeStart` (994) still marks the dispatch `start_attempted` first |

Every Harness provider entry reaches the first boundary through `ControlPlaneBridge.startRequest`
(`control-plane-bridge.ts` 204 to 208), which calls `runner.start`. Its callers are
`harnessBridge!.start` at `orchestrator.ts` 822 (single direct start), `harnessBridge!.startRequest`
at 1009 (dispatch) and `harnessBridge!.start` at 2444 (composed candidates).

The runtime conformance probes (`runtime-conformance.ts` 228 to 229 and 251 to 255) also call
`adapter.start`, but only on refusal adapters built against a missing executable and on the scripted
in-process run (`runtime-catalog.ts` 170 to 206: missing executables, Bedrock without a runtime ARN,
`FakeAdapter`). They are not provider entries and stay outside the gate.

Test 1's **call-site allowlist** is a source test over `apps/api/src`. It matches
`/\badapter\.(start|resume)\(/`, `/\.startProvider\(/`, `/\bharnessBridge!?\.(start|startRequest)\(/`
and `/\brunner\.start\(/`, and fails on any match not in the two tables above (five adapter calls,
three bridge calls, one `runner.start`, the conformance calls). It also asserts, by parsing each
boundary, that `enterProvider(` is the statement directly before each adapter call. A conformance
run against a credentialed descriptor fails the same test at runtime.

### 2.5 Waiting without holding

A `queued` attempt holds no units of any resource.

**Readiness** keeps the K4b rule (`resourceReady`) and adds two terms:

- A single-path attempt is ready when its task's active wait condition is ready, **or** when its
  dispatch is `reserved` and its first route is in flight (`account_source = 'pending'`,
  section 2.5.3). Not-due, dependency-pending and quota-blocked heads are skipped, so they cannot
  stall ready work.
- A candidate is ready while its group is open (section 2.7).
- **No attempt is ready while its (task, slot) still has an owner.** A queued successor waits for
  its predecessor's final state (section 2.9).

#### 2.5.1 The grant rule

Revision 2 granted an attempt only if it was the ready front of every queue it was in, which with
crossed ages granted nothing while every resource was free. Revision 3 replaced that with one global
order and a single pass; Astra's round-3 SQLite run confirmed it grants X in both insertion orders
and matches strict K4b FIFO with enforcement off. Revision 4 keeps the rule and defines `queue_key`
for every case:

1. Every attempt has a fixed `queue_key`, set once at creation: the minimum `queued_at` of its known
   requirements; with no known requirement yet, the creation time of the wait that produced it (for
   a wake, the consumed condition's `created_at`, so waking a task does not reset its age). Adding or
   replacing the account requirement later never changes it. The global order is (`queue_key`,
   `task_id`, `candidate_slot`).
2. A grant pass reads every ready `queued` attempt in global order, inside one `BEGIN IMMEDIATE`
   transaction, with the live free units of each resource.
3. For each attempt in order: if its route is fixed and every requirement has enough free units, it
   is granted (section 2.5.2 says what that writes), and its units are subtracted for the rest of
   the pass. Otherwise it is **blocked**, and every resource it requires is closed for the rest of
   the pass, so no later attempt takes units it needs.
4. A ready attempt whose first route is in flight (`pending`) is blocked on its known requirements
   in the same way. The pass never grants it, because its reservation will (section 2.5.2).
5. The pass ends after the last attempt. It is deterministic: the same durable state gives the same
   grants.

Properties, with their premises stated:

- **No deadlock with free capacity.** The first ready attempt with a fixed route is granted whenever
  all its units are free, because nothing before it in the order can close a resource it needs
  except a `pending` attempt, whose reservation completes in one routing transaction.
- **Bounded waiting.** A blocked attempt closes its resources to everyone behind it, so its position
  only improves. An attempt is eventually first and then waits only for releases, **provided that**:
  every `pending` route completes (a crash in the gap is resumed after the barrier, section 2.8);
  every owner eventually reaches a final state (an exit proof, or the operator's `confirm-stopped`
  for an `ambiguous` attempt, section 2.6); a permanently unsatisfiable head leaves the queue (K4b's
  `resource.unsatisfiable` expiry, unchanged); operator run-now is used finitely; and an older key
  cannot recur indefinitely. The last premise matters because a successor inherits its
  predecessor's pool age (section 2.9), and Astra observed repeated older successors winning every
  pass. Inheritance is bounded: a chain of successors on one task is capped by `maxAutoWakes` and the
  existing failover limits, and a successor never inherits a key older than its task's first wait.
- **K4b equivalence with enforcement off.** An attempt then has at most one requirement, the pool.
  The global order restricted to one pool is the K4b per-pool order (`resource_queued_at`, then
  `task_id`), and closing a blocked attempt's pool is K4b's strict FIFO. Who runs, in what order, and
  every `resource.*` event type are unchanged. The strict-FIFO test in `resource-slots.test.ts` is
  kept as it is.
- **Cost, stated plainly.** With enforcement on, an attempt blocked on account A also closes host
  pool H to later attempts, even when H is free. Work that shares **no** resource with a blocked
  attempt still proceeds. Backfilling around a blocked head is a later optimisation (section 7).
- Operator run-now may move one attempt to the front of the pass, as it may skip FIFO today, but
  never past capacity.

A release, a grant, a new queued attempt, a predecessor becoming final and a readiness change each
schedule one pass (coalesced per event-loop turn). The timer sweep runs the pass as the fallback for
a missed event.

#### 2.5.2 Which transaction does what

Revision 3 left the order of "select", "rebind" and "claim" inconsistent between sections. Revision
4 fixes it. There are three transactions, and **claims are written only by the reservation (R) and
by the grant (G)**:

| Transaction | Runs on | Writes |
|---|---|---|
| **W, wake** | a single-path condition with no `attempt_id`, or whose attempt has no route yet | consumes the condition, reserves the dispatch, and creates the attempt (`queued`, `pending`, `queue_key` per 2.5.1) or binds the task's routeless queued attempt to this dispatch. **No claims.** |
| **R, reservation** | the dispatch's route transaction (`Scheduler.start`), a direct `/start`, a group open | fixes the route, writes the requirements, runs the grant rule for this attempt. Grant: claims, attempt `held`. No grant: re-park `resource_wait` (2.5.3), route kept on the attempt |
| **G, grant** | a grant pass, for a queued attempt with a fixed route | single path, in one transaction: writes the claims, consumes the attempt's condition, reserves a dispatch whose `routing_decision_id` is the attempt's, binds the attempt to it, sets `held`. Candidate: writes the claims and sets `held`, then `grantCandidate` launches |

After G, `continueDispatch` runs `Scheduler.start`, which takes its existing replay branch because
`routing_decision_id` is already set (`scheduler.ts` 969 to 976), including the disabled-assistant
recheck. So a single-path attempt that waited is launched on the route it waited for, and the claims
G wrote always match its requirement set. A timer or event wake of a condition whose `attempt_id`
names a queued attempt with a fixed route does not consume it: it schedules a pass. That removes
both conflicts Astra found. Granting an unbound dispatch attempt can no longer violate the CHECK,
because the dispatch is created inside G. Re-waking a consumed condition can no longer return stale,
because a condition is consumed only by W or G.

#### 2.5.3 The wait, the gap and the wake budget

The durable wait for a single path is the existing `wait_conditions` row, kind `resource`, with
`attempt_id` set. The task is `WAITING_RESOURCE`, so it is visible and explained exactly like a pool
wait. A candidate's wait is its `queued` attempt row, and the task stays `RUNNING` (section 2.7).

- **The gap between W and R.** The attempt exists from W, at its `queue_key`, and readiness counts it
  (section 2.5), so a pass closes its known resources to later attempts. A second wake cannot
  overtake it. A crash in the gap leaves a `reserved` dispatch and its `queued` attempt; boot
  continues the dispatch after the barrier opens (section 2.8), with the same attempt and key.
- **A `resource_wait` re-park keeps the attempt.** When R finds the full requirement set not
  grantable, the re-park transaction releases nothing (the attempt holds nothing), keeps the attempt
  `queued` with its `queue_key` and its route, unbinds it from the aborted dispatch, and writes the
  new `resource` condition with `attempt_id` pointing at it. G later binds it to a new dispatch.
- **The wake budget.** A `resource_wait` re-park does **not** increment `auto_wakes` and does not
  count toward `maxAutoWakes`. Today `repark` increments on every re-park (`scheduler.ts` 1059), so
  reusing it for capacity contention would eventually send a ready task to `WAITING_INPUT`. Astra
  confirmed the reopened image keeps `('01','queued',NULL,0,'active')`. A satisfiable requirement
  that loses to capacity alone has no route to `WAITING_INPUT`. K4b's impossible-request expiry
  (`resource.unsatisfiable`) is separate and unchanged.
- **Re-route.** A queued attempt keeps its route. It is re-routed only by an explicit event: its
  stored assistant becomes disabled, or a cooldown or quota block is observed on it. The re-route
  transaction replaces the route and the account requirement, keeps `queue_key`, and spends exactly
  one wake (`auto_wakes + 1`, as today's `no_candidate` re-park does) **in that same transaction**,
  so a replay cannot spend it twice. Capacity-aware routing, which prefers a free account, is not in
  this design (section 7).

### 2.6 Release at proven provider exit

The release boundary is the attempt's own **exit proof**. Task settlement is not it, a sibling is
not it, the plane's terminal transition is not it, and neither is the session's result commit
(`session-store.ts` 437 to 448), a cancel acknowledgement, the process tracker's report, or boot's
`ended_at` bookkeeping (`orchestrator.ts` 599 to 603).

#### 2.6.1 Exit proofs

Revision 3 treated the process tracker's report and a root-pid check as strong evidence. Astra drove
`ProviderProcessTracker` with a process-group leader that exited while a worker in its group stayed
alive, and observed `{"leaderAlive":false,"outcome":"gone","groupWorkerAlive":true}`. The tracker
enumerates descendants by current parentage (`provider-processes.ts` 59 to 65), `killed` can follow a
timeout without observed exit (153 to 165), the agent lane's recorded pid is the sudo wrapper, and a
unit-stop error is swallowed (`provider-processes.ts` 159, `claude.ts` 585 to 617). A pid would also
need an OS process identity to survive reuse. Revision 4 bases strong evidence on the **cgroup**,
which contains every process the provider starts, whatever its parentage, and has a durable name.

- **Every Harness provider runs in its own cgroup**, named for its attempt. On the agent lane this is
  the transient unit the `aos-agent` wrapper already runs (`claude.ts` 587 to 589, `agent.unit`),
  with the attempt id in the unit name. On the plane lane the adapter spawns the provider inside a
  transient user scope, `systemd-run --user --scope --unit=aos-att-<attempt>`, through the same
  `spawnProvider` seam (`claude.ts` 583). The commit writes the unit name to `provider_unit`. A host
  without systemd and cgroup v2 has no strong evidence (section 2.2).
- The tracker keeps its role, terminating the tree. Its outcome is never a proof.

An attempt becomes `settled` only in a transaction that writes one of these proofs:

| Proof | Written by | Strong |
|---|---|---|
| `cgroup_empty` | the plane, after reading the attempt's own cgroup: `cgroup.events` reports `populated 0`, or the unit no longer exists. Read by the runner's `finally` after `processes.terminate`, by the sweep, and at boot. Never inferred from `stop()` resolving, from the tracker's `gone` or `killed`, or from a pid | yes |
| `host_rebooted` | boot reconciliation: the host's boot time (`/proc/stat` `btime`) is later than `entered_at` plus a 5-second margin, so no process from before can exist | yes |
| `operator_confirmed` | `POST /api/attempts/:id/confirm-stopped`, with the scope `runNow` uses today, or `runNow(confirmNoLiveOwner)` on the attempt's dispatch | yes |
| `never_entered` | any transition from `queued` or `held` to `dropped` (the entry invariant) | yes, but `dropped`, not `settled` |
| `stream_closed_unverified` | the end of the event stream after finish or cancel, for an attempt with no `provider_unit` (a legacy run, or an adapter that cannot spawn into a cgroup) | **no** |

Consequences:

- An **account** claim is released only by a strong proof, and the schema CHECK forbids
  `stream_closed_unverified` on an attempt with an account key. Under the Harness-only rule, every
  account-bearing attempt runs in a cgroup. Codex joins an enforced group once its adapter spawns
  into one; until then `enforce: true` rejects it as a member (section 2.2).
- A **pool-only** attempt without a cgroup (every legacy run, and Codex) may settle on
  `stream_closed_unverified`. That is today's K4b known ceiling, kept only there, recorded on the
  attempt and in `attempt.released`, so it is visible rather than silent.
- A legacy run's `ended_at` written by boot bookkeeping is not a proof. Such an attempt is
  `ambiguous` unless `host_rebooted` holds, and it holds only a pool claim.

`releaseIfIdle(taskId)` becomes `releaseIfSettled(attemptId)`. The sweep walks open attempts and
applies the proof test. `hasOwner(taskId)` stays for the task-level questions it answers today.

| Outcome | Attempt | Claims |
|---|---|---|
| completed / failed, exit proven | `settled` | released once, notify every freed resource |
| completed / failed, result committed, cgroup still populated | `live` until the proof | **held** |
| cancel while `queued` or `held` (including while waiting for the start slot) | `dropped` (`never_entered`) | released (`held`) or none (`queued`); **zero provider calls** |
| cancel during an unresolved `adapter.start` (`starting`) | `stopping` | **held** until a proof, or `ambiguous` (below) |
| cancel while running, adapter slow to acknowledge | `stopping` | **held** until a proof |
| race loser | `stopping` | held until a proof |
| approval / verification pause in a live session | `live` | held |
| compare waiting only for the operator's pick | all `settled` or `dropped` | **zero** claims for the task |
| no proof within `stopEvidenceMs` | `ambiguous` | **held**, operator event `attempt.stop_unconfirmed` |
| launch-check refusal, mapping change, race decided before entry | `dropped` (`never_entered`) | released in that transaction |

`stopEvidenceMs` defaults to the run's hard-kill timeout plus 60 seconds. Today `cancelTask` commits
`CANCELLED` before adapter cancellation finishes. That stays true for the task. The task's state and
the attempt's capacity are separate facts.

A duplicate cancel, a duplicate settle or a stale-generation wake is inert. A final attempt cannot
change state, and a claim is released with `released_at IS NULL` in its `WHERE` clause.

**This supersedes the K4b "known ceiling"** (`docs/agentic-os-k4b-resource-slots.md` §3) for every
attempt with a cgroup. Astra's round-2 and round-3 reviews judged holding through `stopping` and
`ambiguous` sound.

### 2.7 Parallel groups

A compare or race task is a **group**. Its lifecycle is explicit:

1. **Open.** `startParallel` creates the worktrees as today, then commits one transaction that
   creates every candidate attempt (slots 1..n, `queued`, each with its `launch_plan_json`) **and
   moves the task to `RUNNING`**, for both legacy and composed launches. Astra confirmed this removes
   the circular first-grant dependency. With `enforce: true`, a legacy candidate whose requirement
   set holds an account is created `dropped` (`account_requires_harness`) in the same transaction,
   and group settlement then runs (step 3).
2. **Running.** A group is never reserved as a whole. Each candidate competes for its own slot
   through the grant pass. Neither a compare at limit 1 nor a group larger than the account limit
   can deadlock: candidate 1 runs, candidate 2 queues, and candidate 1's proof releases its slot.
3. **Group settlement** runs after **every** transition of a candidate attempt to a final state: a
   session settling, a proof arriving, and a drop (a refusal at the commit, a composition-budget
   recheck, a cancel, the session-terminal rule). A drop has no session to settle, so the drop
   transaction itself schedules group settlement. `settleParallelRun` counts unfinished candidate
   attempts (`queued` and the owner states).

Each slot's outcome is its last attempt's: `succeeded`, `failed`, `refused`, `race_decided` or
`cancelled`. The decisions, which Astra's round-3 review accepted, are:

| Group | Condition | Outcome |
|---|---|---|
| race | a candidate succeeds | winner's transaction: every `queued` or `held` candidate goes `dropped` (`race_decided`), every `starting` or `live` loser goes `stopping` with `stop_requested_at` (below); `finishComparison` runs without waiting for loser exit, only the slots wait |
| race | a candidate fails or is refused, others unfinished | the next queued candidate stays eligible and runs when the pass grants it |
| race | no unfinished candidate, none succeeded | `FAILED` ("every racing assistant failed or was refused"), as today, with each slot's reason |
| compare | no unfinished candidate, at least one ran (`settled`) | `WAITING_INPUT` `comparison_pending`; the comparison lists refused slots as "not run: <reason>"; the task holds zero claims |
| compare | no unfinished candidate, none ran (all `dropped`) | `WAITING_INPUT` `intervention_required` with the refusal reasons |

**A `starting` loser.** The winner's transaction sets the loser `stopping` with `stop_requested_at`.

- *Harness.* When `adapter.start` resolves, the runner's existing post-start check delivers the
  cancel (`session-runner.ts` 480 to 492). That check also reads the attempt's `stop_requested_at`,
  so a race loss is honoured even without a task cancel.
- *Legacy.* Today a legacy candidate has no `ActiveRun` while `adapter.start` is unresolved, and the
  post-start check requires a dispatch id and a `CANCELLED` task (`orchestrator.ts` 884 to 891), and
  a losing candidate has neither. Revision 4 replaces that check with one read of the attempt,
  **before** the run becomes active. If `stop_requested_at` is set, the plane calls
  `adapter.cancel(handle)`, writes the run row with `outcome = 'rejected'` (so the attempt has its
  `session_id`), never registers the `ActiveRun`, and leaves the attempt `stopping`. The same read
  replaces the dispatch-only `CANCELLED` check at 1018.

Either way the slot stays held until a proof (for legacy, `stream_closed_unverified` on a pool-only
attempt). A loser's later settlement never re-runs group settlement for a decided group
(`consumePlaneOwnsTerminal` returns early, `orchestrator.ts` 2492).

Autopilot tasks never run in parallel. That is unchanged (`startTask` throws).

### 2.8 Recovery and upgrade

#### 2.8.1 The launch barrier

A **launch barrier** guards every grant. It is closed when the plane process starts, and it opens
exactly once, at the end of boot. While it is closed:

- The grant pass, every launch reservation and `grantCandidate` **grant nothing**. A reservation that
  would grant instead leaves its attempt `queued` with reason `boot_barrier`, holding nothing.
- `Scheduler.reconcileOnBoot` does not call `continueDispatch` for a `reserved` dispatch and does not
  call `tick` (today it does both, `scheduler.ts` 1211 and 1229). The timer's reserved-dispatch sweep
  (`scheduler.ts` 1294 to 1298) and every tick run only after the barrier opens, because
  `startTimer` is called after it.
- `runNow` and the restart route converge on `wake` (`scheduler.ts` 946, `server.ts` 1362 to 1375),
  which only ever reaches W, R or G, all behind the barrier. A direct `/start` cannot arrive, because
  the HTTP listener starts after boot (`index.ts` 49).
- The commit refuses with `boot_barrier` as a second line of defence. Nothing becomes `held` behind a
  closed barrier, so this refusal should never fire, and a test asserts it does not.
- **Recovery records intent.** Today recovery calls `settleFromResult`, which can call `failoverTask`
  and then `startTask` (`orchestrator.ts` 566, 1356, 1460, 1468). Revision 4 makes every failover,
  handoff, retry and restart record its successor as a `queued` attempt in the predecessor's slot,
  with `predecessor_id`, plus its durable wait. `uq_attempt_queued` admits it next to the still-open
  predecessor (section 2.3), readiness keeps it waiting until the predecessor is final (section 2.5),
  and the same code path is used at runtime (section 2.9).

#### 2.8.2 Boot order

`index.ts` keeps its order, with the barrier around it:

1. Barrier closed (construction).
2. `orchestrator.reconcileOnBoot` (`index.ts` 12): Harness and legacy execution recovery. It may
   settle single-path sessions and record successor intent; it grants nothing. **Both recovery steps
   skip tasks in compare or race mode.** Today the Harness step settles a task by its latest session
   (`orchestrator.ts` 559 to 572), which treats the latest candidate as a single task, and the legacy
   step marks the task `FAILED` (590 to 603). Both are wrong for an open group.
3. **Attempt reconciliation**, a new step before `acceptance.reconcileOnBoot` (`index.ts` 19):
   - Resolve the account key of **every** open attempt from its assistant, its `runAs` and the
     current config, not only the `unresolved` ones. Insert a missing account claim (an attempt from
     an enforcement-off build has none), and replace a claim whose key changed after regrouping: the
     operator's current declaration is the authority. A live owner that pushes an account over its
     limit is allowed: it is not cancelled, and the grant pass grants nothing on that account until
     occupancy falls below the limit.
   - Classify every open attempt (table below).
   - **Group recovery**: for each compare or race task, settle each candidate's session result
     individually, apply the classification, then run group settlement once.

   After this step every owner of every resource is counted, so the first enabled boot, and every
   boot after a regrouping, opens the barrier on a complete count.
4. `acceptance.reconcileOnBoot` and `Scheduler.reconcileOnBoot` (`index.ts` 19, 20), changed as in
   section 2.8.1.
5. **Barrier opens.** Continue every `reserved` dispatch (in `created_at` order), run one grant pass,
   then `startTimer` and the first tick.

Classification in step 3, keyed by binding rather than kind, first match wins:

| Open attempt at boot | Disposition |
|---|---|
| task terminal, attempt `queued` or `held` | `dropped` (`never_entered`) |
| candidate, group decided, `queued` or `held` | `dropped` (`never_entered`) |
| `queued` (task non-terminal; for a candidate, group open) | kept, with its `queue_key`; granted by a pass after the barrier |
| `held`, bound to a `reserved` dispatch | kept `held`; continued after the barrier with its claims |
| `held`, bound to a `start_attempted` or `started` dispatch, Harness, session row exists and is not terminal | the session's recovery decides. The attempt was never entered (the commit did not happen), so when recovery ends the session, the session-terminal rule drops it. If recovery offers a resume, that is a new dispatch-kind attempt |
| `held`, bound to a `start_attempted` dispatch, no session or run | never entered, by the entry invariant. The dispatch re-parks with reason `start_not_entered`, which does not spend a wake; the attempt returns to `queued` with its `queue_key` and route (claims released) and is re-granted by a pass. Revision 3 promised a replay here that `Scheduler.start` cannot perform, since it returns for any phase but `reserved` (`scheduler.ts` 960 to 964) |
| `held`, bound to a re-parked, aborted or cancelled dispatch | `dropped` (`never_entered`) |
| `held`, kind `direct`, no dispatch | `dropped` (`never_entered`). The task takes today's crash outcome for an interrupted direct start (`WAITING_INPUT` `harness_error`, "start interrupted by restart") and is never re-launched automatically |
| `held`, candidate, group open | returns to `queued` with its `queue_key` (claims released); granted after the barrier |
| `starting` or later, with a `provider_unit` whose cgroup is empty or gone | `settled` (`cgroup_empty`) |
| `starting` or later, `host_rebooted` holds | `settled` (`host_rebooted`) |
| `starting`, Harness, migrated, no session row | kept inside `RECOVERY_WINDOW_MS` (60 seconds) after `entered_at`; after it, `dropped` (`never_entered`), by the pre-upgrade Harness invariant. A runtime Harness attempt cannot be in this row, because the commit happens after the session exists |
| `starting`, legacy, no run | `ambiguous`, held (pool only) until a proof |
| `live` or `stopping`, no proof possible | `ambiguous`, held, `attempt.stop_unconfirmed` |
| `ambiguous` | kept until a proof (`cgroup_empty`, `host_rebooted`, `operator_confirmed`) |

#### 2.8.3 The `runNow` predicate

`runNow(confirmNoLiveOwner)` today refuses when **any** run exists on the task (`SELECT 1 FROM runs
WHERE task_id = ?`, `scheduler.ts` 937). A settled predecessor can therefore block reconciliation of
an ambiguous successor. The predicate becomes "a run exists for **this** dispatch"
(`runs.dispatch_id = ?`). Confirming no live owner also writes `operator_confirmed` on the
ambiguous attempt, which is what releases its claims.

### 2.9 Failover and retries

- The predecessor attempt releases its account at its own exit proof. A successor is recorded
  `queued` in the same slot as soon as failover is decided, and is granted only after the
  predecessor is final (the readiness rule, section 2.5). A same-account retry therefore never waits
  on its own claim and never runs beside its predecessor.
- Today `deferResourceContinuation` carries the predecessor's pool requirement forward and routes at
  grant. Revision 4 keeps the pool, with the same age (so the successor's `queue_key` is the
  predecessor's pool age, bounded as in section 2.5.1), and **does not** carry the account. The
  successor's route is fixed by its own reservation (W, then R). A successor routed from A to B owns
  only B, and only once it is granted. If B is saturated, the successor waits on B and holds nothing
  on A.
- Every failover, handoff, retry and restart records its successor as intent rather than calling
  `startTask` inline, so the same code is correct at runtime and behind the boot barrier.
- Manual handoff, unattended same-assistant quota resume (`parkSameAssistant`), K2 backoff and
  `maxAutoWakes` are unchanged. They decide **when** the successor's wake fires. The reservation and
  the pass decide whether it may take a slot, and a capacity wait does not spend the wake budget
  (section 2.5.3). A reset that arrives while quota stays blocked re-parks with backoff, makes no
  provider call and does not loop. A reset is a recheck time, not headroom (`QuotaProjection`).
- Checkpoint continuity is unchanged.

### 2.10 Approval ownership

- A live session waiting on an approval or a verification is a live attempt and keeps its claims.
- A pre-start human hold, such as a pending start approval, has no attempt and owns no slot.
- An explicit approval continues the **same** session and attempt. No reservation runs, and no
  second provider is admitted.
- Nothing in qcq-04 answers, expires or skips an approval. Time advancing, a tick, run-now and a
  restart only ever reach W, R or G, and none of them touches an approval.
- Denial, expiry and cancellation keep their existing outcomes. The attempt releases its claims at
  its exit proof.

### 2.11 Explainability

Every grant, wait, refusal and release writes a `scheduler_events` row:
`attempt.queued`, `attempt.granted`, `attempt.entered`, `attempt.dropped`, `attempt.released`,
`attempt.stop_unconfirmed` or `attempt.mapping_changed`. The payload carries:

- `attemptId`, `kind`, `candidateSlot`, `queueKey`, `predecessorId`
- `account` and `accountSource`
- `limit`, `claimedUnitsAfter`
- `liveOwners`: the attempt ids and task ids holding that account
- `blockedBy`: for a blocked attempt, the earlier attempt in the pass that closed the resource
- the requirement's age
- the reason, and for a release the `exitProof`

For qcq-05, it also carries the recommendation used (section 3). The operator pool listing shows
`account:` resources beside host pools. The estimator's `capacity` reads enforced claims when
`enforce: true`, and stays advisory otherwise. The API minor version is bumped once (for the
`attempts` field of section 2.3.2 and the events), using the next free number at implementation.

### 2.12 Enforcement gate and rollout

Slices 04b and 04c land before 04d converts failover, handoff, restart and resume.

- **Build constant.** `ACCOUNT_ENFORCEMENT_READY` is `false` from 04a through 04c, and config load
  rejects `scheduling.accounts.enforce: true` with "account enforcement is not available in this
  build". 04d flips it, in the PR whose allowlist test asserts that every allowlisted path obtains its
  claims through R or G. Astra confirmed this keeps `enforce: true` unavailable through 04c.
- **Compat grant, defined.** From 04a through 04c, a path 04d has not converted still creates an
  attempt row (04a does that for every start path), through a compat grant with no account
  requirement. The compat grant **adopts the exact K4b claim row** the path already owns, matched by
  dispatch identity (`resource_claims.dispatch_id`, as `assertLaunchClaim` and `launchCheck` match it
  today, `scheduler.ts` 261 to 269), by setting that row's `attempt_id`. It never inserts a second pool
  claim. A path that owns no claim and needs a pool takes it through G, synchronously; if G cannot
  grant, the path defers exactly as `deferResourceContinuation` does today. So the compat path keeps
  K4b's claim identity for that path. 04d replaces every compat grant with W, R and G and deletes the
  shim, and a test asserts none remains.
- **First enabled boot.** Enabling `enforce: true`, or regrouping, takes effect at boot. Step 3 of
  section 2.8.2 re-resolves every open attempt, inserting missing account claims and replacing stale
  keys, before the barrier opens. No grant on an account happens before every possibly live owner of
  it is counted.
- **Test seam.** 04b and 04c must test account contention while production config rejects it. The
  capacity module takes its policy as a constructor argument, and tests construct it with
  `{ enforce: true }` directly (the seam `resource-slots.test.ts` already uses for pools). Config load
  is the only reader of `ACCOUNT_ENFORCEMENT_READY`. 04d adds an end-to-end test that enables
  enforcement through config.
- `actOnRecommendation` (qcq-05) is independent of this constant, but qcq-05 lands after 04b, because
  its rechecks live in the commit.

### 2.13 Intended K4b changes with enforcement off

The design is not a pure no-op with `enforce: false`. These are the intended differences, each with
the existing test it changes (section 5, test 11):

1. The pool claim is written by R or G, after routing, not in the wake transaction.
2. A cancel at `reserved` leaves a `dropped` attempt and no claim row at all, where today a claim is
   written at wake and then released.
3. A crash at the reservation boundary leaves a `queued` attempt and a `reserved` dispatch with no
   live claim, where today the claim is live.
4. A pool slot with a cgroup-backed provider is released at `cgroup_empty`, not at the task's
   terminal transition while a provider may still be running.
5. A Harness `start_attempted` dispatch whose attempt is still `held` at boot is known not to have
   entered a provider, so it re-parks at once (`start_not_entered`, no wake spent) instead of after
   the 60-second window.

Who runs, in what order, the strict FIFO and every `resource.*` event type stay as in K4b.

## 3. qcq-05 design

- **Opt-in**: global `scheduling.actOnRecommendation: false` by default, plus a per-request
  `deferToWindow: true` on start. It needs the `tasks.start` grant. A read-only estimate credential
  (`routing.read`) and a create-only credential cannot schedule execution.
- **Kinds**: only `run-in-window` is acted on. `run-now`, `wait-for-quota-reset` (that is K2's job)
  and `wait-for-approval` (whose `startAt` is null) never create a window bound.
- **A bound, not a replacement**: the window is written to `window_json` on the task's active
  condition. That covers a time, quota, dependency or resource wait. It is carried forward explicitly
  across replacement, including a `resource_wait` re-park, the way the K4b requirement is. If the task
  has no active condition, a `time` wait is created at the window start. The opt-in **never** replaces
  or consumes an existing dependency, quota, resource or human-hold condition. On a task paused for
  an operator decision, it is refused.
- **Recorded when the bound is created, not at run start**: `window_json` records:
  - the recommendation kind, the window start and end, and `estimatorVersion`
  - the evidence run ids and the policy hash
  - the confirmed assistant and composition digest
  - the effective approval mode, including the autopilot's configured `approvalMode` and the
    workspace's read-only mode
- **Readiness**: `now >= windowStart` and `now < windowEnd - scheduling.windowMinSliceMs` (new,
  default 10 minutes) are added to the condition's readiness. This applies to the time wake, the
  grant pass readiness and the launch reservation. A duplicate timer or event wake is inert
  (generation check), so the start happens exactly once.
- **Window closed**: on a wake after the window closes, on a restart after it closes, when an account
  grant arrives after it closes, or when the commit finds it closed, nothing starts. The task
  re-plans. A new `run-in-window` recommendation writes a new bound, counted against `maxAutoWakes`
  with K2 backoff. Any other recommendation moves the task to `WAITING_INPUT` (`window_replan`) with
  the explanation. A task never starts late into closed hours.
- **Where the rechecks run.** Early, at W, R and G and in the precheck, so doomed work does no work.
  **Authoritatively, in the provider-entry commit** (section 2.4.1 step 4): on the Harness after the
  provider-start slot wait (`session-runner.ts` 447 to 471) and after preparation, and on the legacy
  paths directly before `adapter.start` or `adapter.resume` (`orchestrator.ts` 885 and 1016). Astra's
  round-3 review resolved this placement. With revision 4's commit after preparation it also holds
  end to end. A materialized replay skips recomposition but still goes through `executeDispatch` and
  the commit. Each failure refuses before provider entry with its own reason, drops the attempt with
  `never_entered` and releases its claims:
  - The window is open, and `D` leaves at least `windowMinSliceMs`.
  - Current quota allows the start.
  - `pendingApprovalCount(task) == 0`. This is the combined Harness and legacy reader in
    `task-outcome.ts` (28 to 36), not the estimator's Harness-only count.
  - The effective approval mode is not looser than the recorded one (`tightenedApproval`).
  - The chosen assistant and digest equal the recorded confirmation. Otherwise the result is
    `route_changed` and `WAITING_INPUT`, never a silent swap.
  - The assistant is not disabled (`disabledForNewStart`).
  - The Composer stage-5 spend cap is not exhausted.
  - The workspace is not read-only.
- **Never**: a timer never answers an approval, authorizes a changed proposal, or marks an attempt
  accepted. Acceptance keeps its existing path, with the required acceptance command run before
  publication in `autopilot-dispatcher.ts` (348), and publication requires a verified SHA (382). A
  failed acceptance command leaves no accepted state and no publication.

## 4. Finding map

### Round 1 (Astra High, `4997dc4`)

| Finding | Answered in |
|---|---|
| 1. Acquisition point misses real starts and precedes account selection; capacity error can mark `/start` FAILED | 2.4, 2.4.1, 2.4.2 |
| 2. Schema cannot represent per-candidate owners, multi-resource claims or candidate waits | 2.1, 2.3, 2.5 |
| 3. Task settlement is the wrong release boundary; group settlement ignores queued candidates | 2.6, 2.7 |
| 4. Recovery and failover need attempt-specific evidence; `runNow` predicate; A→B failover | 2.8, 2.9 |
| 5. `core.auth.account` is not an account identity | 2.2 |
| 6. A qcq-05 timer establishes a due time, not continuing authorization | 3 |

### Round 2 (Astra High, `c34c29e`) and round 3 (Astra High, `428f859`)

| Finding | Round 3 status | Answered in revision 4 |
|---|---|---|
| R2-1 / R3-1. Provider entry and cancellation | not resolved: the commit came before fallible preparation; a Harness `started` dispatch failed the phase predicate; a session-only cancel and a slot-wait abort bypassed the gate; a duplicate caller's refusal dropped a live owner; the allowlist missed the bridge callers | 2.4.1 (precheck/commit split; commit after the spec, secrets and resume reference; absolute deadline `D`; `start_attempted` or `started` predicate; `cancel_requested` read; `not_owner` leaves the owner intact), 2.1 (session-terminal rule; migration named as the second `starting` writer), 2.4.2 (bridge callers 822, 1009 and 2444; convergence at 204 to 208; regexes) |
| R2-2 / R3-2. Upgrade and claim readers | not resolved: an in-flight legacy call cancelled before it returned was misclassified; a `start_attempted` dispatch with no claim was invisible; three readers were missing | 2.3.1 (classification by the durable entry mark; dispatches without claims scanned; run-id tie-break), 2.2 (Harness-only: a legacy ambiguity can only hold a pool), 2.3.2 (`assertLaunchClaim`, `server.ts` 914 and 950, the web type, an additive `attempts` projection) |
| R2-3 / R3-3. Exit evidence | not resolved: the tracker and the wrapper pid are not strong evidence | 2.6.1 (per-attempt cgroup; `cgroup_empty`, `host_rebooted`, `operator_confirmed`; the tracker outcome is never a proof; the CHECK forbids a weak proof on an account) |
| R2-4 / R3-4. Compare/race | not resolved: legacy `starting` loser | 2.7 (the durable `stop_requested_at` is read before the legacy run becomes active; the cancel is delivered; the run row is written `rejected`) |
| R2-5 / R3-5. Boot and successor intent | not resolved: `uq_attempt_open` rejects the queued successor; tick and reserved sweep not suppressed; gaps in the dispositions; group hazards in recovery | 2.3 (`uq_attempt_owner` plus `uq_attempt_queued`), 2.5 (a successor is not ready while its slot has an owner), 2.8.1 (no tick or replay before the barrier), 2.8.2 (recovery skips groups; a group recovery step; the table is keyed by binding and covers a `started` Harness dispatch, `start_attempted` with no session, and restart as dispatch kind) |
| R2-6 / R3-6. qcq-05 recheck placement | resolved for placement; positive control missing | 3; test 10 positive control |
| R3-7. Crossed-age FIFO | resolved for the deadlock; starvation premises missing | 2.5.1 (premises listed; inherited keys bounded) |
| R3-8. Wake gap and grant ordering | budget resolved; W/G/claim ordering inconsistent; changed-account re-park; `queue_key` with no requirement | 2.5.2 (three transactions; claims only in R and G; the dispatch is created inside G; a timer wake of a routed queued attempt schedules a pass), 2.5.3 (a re-route spends one wake in its own transaction), 2.5.1 (`queue_key` rule) |
| R3-9. Enforcement through 04d | not a rollout guarantee | 2.12 (the compat grant adopts the exact K4b row by dispatch identity; every open attempt is reconciled at first enable; test seam) |
| R3-10. Slice tests | not resolved | section 5 (r4 cases, test 11 for changed K4b expectations), section 6 (owning slices corrected) |
| Non-blocking: account identity | resolved | unchanged (2.2) |

## 5. Required tests for the implementation PRs

Every test uses an injected clock and fake adapters that independently record: entry into `start` or
`resume`, cancellation acknowledgement, provider exit, and the state of a fake cgroup the test
controls (populated or empty), read through the same seam the plane uses. Every test asserts both the
durable claims **and** the maximum number of fake providers live at the same time. Account contention
in 04b and 04c is exercised through the test seam of section 2.12. Cases new in revision 4 are marked
**r4**, and **r3** cases are kept.

1. **Last-slot contention and the entry gate.** (04b; parallel parts in 04c)
   - Set account A's limit to 1. Two scheduler wakes, a direct `/start`, a compare/race candidate and
     an admitted autopilot attempt all race for the slot. Exactly one provider enters. Every other
     eligible attempt has a durable resource wait, with no provider call, no failure and no duplicate
     dispatch. Repeat with composed parallel launches (04c). An independent account B can still start.
   - **r3** Cancel a direct start and a candidate while `startTask` is awaiting worktree creation:
     zero provider calls, the attempt `dropped` `never_entered`, claims released. Repeat for
     `executeDispatch` between `beforeStart` and the commit.
   - **r4** Harness: hold the provider-start slot so the dispatch reaches `started` while the runner
     waits. Release the slot: the commit accepts the `started` dispatch and the provider enters once.
   - **r4** Harness: cancel only the session (`cancel_requested`, no task cancel) while it waits for
     the slot, and separately abort the wait. Zero provider calls; the session-terminal rule drops the
     attempt.
   - **r4** Make secret resolution throw after the precheck: zero provider calls, the attempt
     `dropped` `never_entered`, no autopilot window charge.
   - **r4** A duplicate caller reaches the commit for an attempt that is already `starting`: the result
     is `not_owner`, and the attempt and its claims are untouched.
   - **r3/r4** The call-site allowlist of section 2.4.2, including the `harnessBridge!` calls and
     `enterProvider(` adjacency. It fails when a call site is added outside the allowlist.
   - **r4** With `enforce: true`, a legacy dispatch, a legacy direct start and a plain legacy compare
     candidate that need account A refuse with `account_requires_harness`, hold nothing and start
     nothing.
2. **Identity, configuration and readers.** (04a; the mapping-change case in 04b)
   - Two assistant ids mapped to A share one slot. Two undeclared assistants each use their own
     fallback. A fallback key cannot collide with a declared group or a host pool.
   - Exercise identical provider labels, credential aliases (`env:<VAR>`) and the agent-user lane.
   - Change a mapping between the reservation and the commit: `account_mapping_changed`, zero
     provider calls.
   - Lower a limit from 2 to 1 while two attempts are live: both finish, and no new start happens
     until occupancy falls below 1.
   - With `enforce: false`, behavior is unchanged except for section 2.13.
   - **r3** `enforce: true` is rejected while `ACCOUNT_ENFORCEMENT_READY` is false, and rejected for
     an assistant without strong exit evidence.
   - **r3/r4** Claim readers: one attempt with a pool and an account claim, and a second attempt of
     the same task with its own claim. Every reader in section 2.3.2 returns or releases the right
     rows, including `assertLaunchClaim`, `GET /api/tasks/:id` and the task wait read. `launchCheck`
     finds its pool claim by dispatch, and `resourceClaim` keeps its K4b value.
3. **Parallel progress and fairness.** (04c)
   - At limit 1, compare two profiles on A, with an older ready single waiter and later arrivals.
     Both candidates eventually run in the documented order. The compare enters `comparison_pending`
     only after both are final, with zero claims.
   - **r3** Legacy and composed compare at limit 1: the first candidate is granted from the group-open
     commit, with no deadlock.
   - **r3** Dropped compare: candidate 1 finishes, and candidate 2 is refused at its deferred launch
     check. The refusal transaction moves the task to `comparison_pending`. With every candidate
     refused, the task goes `intervention_required`.
   - For race: a first failure lets the queued sibling run, a first success drops queued losers, and
     all-failed (including all-refused) is recorded only after the last candidate is final.
   - **r3/r4** Race decided while a loser is `starting`, on the **legacy** path and the Harness path:
     the loser goes `stopping`, its cancel is delivered when start resolves, the legacy run never
     becomes an `ActiveRun` and is written `rejected`, and the slot is held until its proof. Repeat
     with the start rejecting.
   - A quota-blocked or dependency-blocked head cannot stall ready work, and run-now cannot exceed
     capacity.
4. **Multiple resources, ordering and autopilot.** (04b)
   - Occupy the host pool and account A separately, then contend for both in opposite orders. An
     unsuccessful attempt holds neither, work sharing no resource with it progresses, and on grant
     both claims belong to the same attempt.
   - **r3** Crossed ages (X: host age 1, account age 3; Y: age 2 on both): the pass grants X in both
     insertion orders, then Y after X's proof.
   - **r4** Transactions: claims are written only by R and G; a G grant creates the dispatch with the
     attempt's `routing_decision_id`, and `Scheduler.start` replays it; a timer wake of a routed
     queued attempt's condition schedules a pass and does not consume the condition.
   - **r3** Wake gap: a second waiter's wake fires between W and R, and X keeps its position. After a
     crash in the gap, boot continues X with the same attempt and `queue_key`.
   - **r3/r4** Wake budget: a task re-parked `resource_wait` more than `maxAutoWakes` times stays
     `WAITING_RESOURCE` with `auto_wakes` unchanged, and starts when capacity frees. A re-route spends
     exactly one wake, and replaying the re-route transaction does not spend a second.
   - **r4** Inherited age: a task whose successors repeatedly inherit an older pool age stops winning
     once its chain reaches `maxAutoWakes`, and a younger waiter is then granted.
   - Close the autopilot window, or expire its billing attestation, between the precheck and the
     commit: zero provider calls, the existing typed refusal, release of both claims and no duplicate
     window charge.
5. **Cancellation, settlement and exit proof.** (04b; race loser in 04c)
   - Cancel at four points: while queued, after the reservation but before the commit, during an
     unresolved `adapter.start`, and while a running adapter delays its cancellation acknowledgement.
   - A pre-entry cancellation makes zero calls. A possibly live provider keeps occupying its slot.
     After a proof, the next waiter wakes exactly once.
   - **r3** Result before exit: the fake commits its result and keeps its cgroup populated. Run the
     sweep between the `execution_results` commit and the runner's `finally`. The claim stays held
     until the cgroup reads empty. Repeat with the adapter throwing in `cancel`.
   - **r4** Reproduce Astra's tracker case: the group leader exits while a worker in its cgroup stays
     alive. The tracker reports `gone`, but the attempt stays `live` and its account claim held until
     the worker exits and the cgroup reads empty. Repeat on the agent lane with a failing unit stop.
   - **r3** An adapter with no cgroup: a pool-only attempt settles on `stream_closed_unverified` and
     says so, and the schema rejects that proof on an attempt with an account key.
   - A duplicate cancel, a duplicate settle and a stale-generation wake are inert.
6. **Crash and upgrade recovery.** (backfill in 04a; boot, barrier and classification in 04b)
   - Kill and reopen the plane at five points: after the claim, after route or request
     materialization, after `start_attempted` with no run, after session creation but before the
     phase update, and after a durable end but before the proof.
   - Include a queued sibling, and a live pre-upgrade run with no new-format claim.
   - No over-admission on first boot, no duplicate start and no leaked settled claim.
   - Legacy ambiguity survives repeated boots until a proof, including when the task has a historical
     predecessor (the `runs.dispatch_id` predicate).
   - **r3/r4** Upgrade backfill (04a): a released historical claim with and without a run; a live
     claim on a `reserved` dispatch; a legacy dispatch with an entry mark and no run, **including one
     whose phase is now `cancelled`** and one **with no claim**; a Harness entry mark with no session;
     an autopilot pool claim; a compare with two live runs of equal `started_at`. The migration passes
     `pragma_foreign_key_check`, and every classification matches section 2.3.1.
   - **r4** Boot classification (04b): every row of the section 2.8.2 table, including a `held`
     Harness attempt on a `started` dispatch, a `held` attempt on a `start_attempted` dispatch with no
     session (re-parked `start_not_entered`, no wake spent, re-granted), a `held` direct start, a
     terminal task's queued attempt, and `host_rebooted`.
   - **r4** Barrier (04b): with the barrier closed, no grant, no `held` transition, no tick, no
     reserved-dispatch replay and no commit happens, and the `boot_barrier` refusal never fires.
   - **r4** Recovery failover under the compat path (04b): a recovered result requests failover. The
     successor is recorded `queued` beside its still-`stopping` predecessor (`uq_attempt_queued`) and
     starts only after the predecessor's proof and the barrier.
   - **r4** Group recovery (04c): an open compare with one settled and one queued candidate survives a
     restart. The Harness step does not settle it as a single task, and the legacy step does not mark
     it `FAILED`.
7. **Failover, retries and rollout.** (04d, except where marked)
   - At limit 1, fail on A and retry on A. Then fail on A and route to a saturated B. The predecessor
     releases exactly once, a same-account retry cannot run beside its predecessor, and a B successor
     owns only B once it is granted.
   - **r3** Boot-time failover: B is at its limit with an `unresolved` pre-upgrade owner, and A's
     result waits for boot recovery. Nothing starts on B until reconciliation counts B's owner and
     occupancy falls below the limit.
   - **r4** First enable: boot an enforcement-off database with a live attempt on account A, then boot
     with `enforce: true` through config. Reconciliation inserts A's claim before the barrier opens,
     and a second A waiter does not start. Regroup a member from A to B and reboot: the claim moves to
     B before any grant.
   - **r4** Compat grant (04b, 04c): an unconverted path adopts the exact K4b claim row by dispatch
     identity, and no second pool claim is inserted. In 04d, no compat grant remains, and the allowlist
     asserts that every path uses R or G.
   - Repeat for manual handoff and unattended same-assistant quota resume. Assert checkpoint
     continuity, K2 backoff and the maximum number of automatic wakes.
   - A reset while quota stays blocked produces no provider call and no tight timer loop.
8. **Approval ownership.** (04b)
   - In both legacy and Harness, park a live provider on an approval while another waiter exists (the
     legacy case on a pool, since legacy cannot hold an account). Advance time, tick, run-now and
     restart. No timer sends an approval response, and no second provider is admitted while ownership
     is live or ambiguous.
   - An explicit approval continues the same session. Denial, expiry and cancellation follow their
     existing outcomes and release after the exit proof.
   - A pre-start approval hold owns no slot. Exercise the verification pause and the final comparison
     pause separately.
9. **Window durability (qcq-05).**
   - With the opt-in off, or with `run-now`, `wait-for-quota-reset` or `wait-for-approval`, no
     recommendation bound is created.
   - With an authorized `run-in-window`, defer to Sunday 19:00 Asia/Jerusalem, restart before then,
     and deliver duplicate timer and event wakes: zero early calls and exactly one eligible start.
   - Restart after the window closes, or hold capacity until it closes: the task re-plans without
     starting late.
   - An existing dependency, quota delay or human hold survives the opt-in, and the bound survives a
     `resource_wait` re-park.
10. **Authorization, spend and acceptance (qcq-05).**
    - A read-only estimate credential and a create-only credential cannot schedule execution.
    - Insert a pending approval after deferral, change the confirmed assistant or digest, tighten
      permissions, and exhaust the remaining Composer budget. Repeat each after request
      materialization and after a restart. Each gate refuses before provider entry, with its own
      reason.
    - **r3** Between the hooks: set `maxConcurrentProviderStarts` to 1 and hold the slot with another
      session. Let the deferred task pass `beforeStart` and queue for the slot. While it waits, close
      the window, and separately insert a pending approval. Release the slot: the commit refuses with
      the right reason, zero provider calls, the attempt `dropped`. Repeat on a materialized replay and
      at the legacy boundary.
    - **r4** Positive control for the same setup: nothing changes while the task waits, and when the
      slot opens the still-authorized task passes the commit and its provider enters exactly once. A
      blanket phase refusal would fail this case.
    - Capture the effective approval mode, including the autopilot's and the workspace read-only mode.
    - Fail a required acceptance command, and assert no accepted state and no publication.
    - The wait and refusal evidence names the account, the limit, the live owners and the
      recommendation used.
11. **r4 Changed K4b expectations.** (04b) The existing K4b tests are the regression set, except for
    these assertions, which contradict the intended changes of section 2.13. They are updated in the
    same PR, each with a comment naming 2.13:
    - `resource-slots.test.ts` 202 to 216 (cancel at `reserved`): there is no claim row for the
      cancelled task, the attempt is `dropped` `never_entered`, and the waiter still gets the slot.
    - `resource-slots.test.ts` 219 to 232 (restart at the reservation boundary): after the crash there
      is no live claim, but a `queued` attempt and a `reserved` dispatch; after boot the provider
      starts once and the claim is released after its proof.
    - `resource-slots.test.ts` 235 to 246 (sweep of an owner-less claim): with a cgroup-backed fake the
      claim is released at `cgroup_empty`, not because the task is terminal while the fake is still
      running. A pool-only fake without a cgroup keeps today's assertion, with
      `stream_closed_unverified`.
    - `resource-slots.test.ts` 249 to 262 and `scheduler.test.ts` 111 to 120 (Harness start ambiguity
      and the 60-second window): a fresh pre-commit Harness attempt is `held` and re-parks at once as
      `start_not_entered` without spending a wake. The 60-second expectation stays only for a migrated
      `starting` attempt.
    - The strict-FIFO test (`resource-slots.test.ts` 150 to 161) is kept unchanged.

## 6. Evidence and slices

The implementation lands in four slices, each a separate PR reviewed against this packet, plus
qcq-05:

| Slice | Scope | Tests |
|---|---|---|
| qcq-04a | Migration and backfill (2.3, 2.3.1); per-attempt claim readers and the `attempts` projection (2.3.2); attempt rows on every start path with the compat grant (2.12); resolver and config (`enforce: false` only, `ACCOUNT_ENFORCEMENT_READY = false`); proof columns | 2 (identity, unset, enforcement refused, readers), 6 (upgrade backfill) |
| qcq-04b | Cgroup spawn for Harness providers and `cgroup_empty` (2.6.1); W, R, G and the grant pass (2.5) on the single, direct `/start` and autopilot paths; re-park and re-route budget (2.5.3); precheck/commit gate at all three boundaries, the session-terminal rule and the allowlist (2.1, 2.4.1, 2.4.2); the Harness-only refusal (2.2); launch barrier, boot order and classification (2.8); `runNow` predicate; K4b test updates | 1 (single paths, gate, allowlist, Harness-only), 4, 5, 6 (boot, barrier, classification, recovery failover under compat), 7 (compat grant adoption), 8, 11 |
| qcq-04c | Group open, candidate grants, group settlement on drops, the legacy `starting` loser, group recovery (2.7, 2.8.2) | 1 (parallel), 3, 5 (race loser), 6 (group recovery), 7 (compat adoption on parallel paths) |
| qcq-04d | Failover, handoff, restart and resume through W, R and G as recorded intent; delete the compat grant; flip `ACCOUNT_ENFORCEMENT_READY`; config-enabled end-to-end test | 7 (incl. boot-time failover, first enable, regrouping, no compat grant), 1 (allowlist asserts R or G on every path) |
| qcq-05 | Window bound and rechecks in the commit, after qcq-04b | 9, 10 (incl. between the hooks and the positive control) |

`enforce: true` cannot be configured on any build before qcq-04d, so 04b and 04c never run with an
uncovered path under enforcement (section 2.12). Their account cases run through the test seam.

Every slice attaches the following:

- The gates: `pnpm typecheck && pnpm lint && pnpm test`.
- `pnpm demo:a`, `demo:a5` and `demo:b`. Through 04c they run with `enforce: false`, and the capture
  shows the K4b outcomes unchanged apart from section 2.13. From 04d they also run with account A's
  limit set to 1 and two fake assistants in group A, with an injected clock, no credentials and no
  quota spend. That capture shows one live provider and one resource wait naming account A, its limit
  and its live owner.
- A restart capture that kills the plane at each point in test 6 and shows zero leaked claims and
  zero over-admission.
- For 04b, a capture on a systemd host showing a fake provider's `aos-att-<attempt>` scope populated
  while it runs and the claim released only after the scope empties. If that host is the OCI box, the
  step needs itay's approval.
- For qcq-05, a capture that defers a fake task to Sunday 19:00 Asia/Jerusalem, restarts before then,
  and shows the scheduler starting it exactly once inside the window.

Every implementation PR needs one Opus 5.5 High reviewer, or GPT-6.2-Astra High. qcq-04b and qcq-04c
change dispatch on every path, so they get both reviewers.

## 7. Not in scope

These are not part of this design:

- Capacity-aware routing, meaning a router that prefers a free account. Routing stays as it is,
  then waits.
- Backfilling around a blocked attempt in the grant pass (section 2.5.1).
- Account enforcement on legacy execution paths (section 2.2).
- Cgroup spawn for the Codex adapter. It is its own adapter PR; until it lands, Codex cannot be in an
  enforced group.
- Budget enforcement beyond the existing Composer caps.
- Paid runs.
- Turning on `enforce: true` or `actOnRecommendation` in live config.
- Any live change on the OCI box.

The last three need itay's explicit approval.

## 8. What the re-review must check

1. The commit is the statement immediately before each of the five adapter calls in section 2.4.2,
   after every fallible preparation step, and the allowlist names every bridge caller. No `await`,
   I/O or transaction sits between the commit and the call.
2. The entry invariant holds at runtime: only the commit writes `starting` (the migration is the
   named exception); the session-terminal rule drops every `held` attempt whose session ends without
   the commit; every kind of cancel (task, session-only, slot-wait abort) serializes against the
   commit; and a `not_owner` refusal never touches an owner.
3. The commit accepts a Harness dispatch in `started` bound to its session, and the absolute deadline
   `D` stops preparation time from extending a run.
4. The backfill in section 2.3.1 classifies by the durable entry mark, so an in-flight legacy call
   whose dispatch is now `cancelled`, and a `start_attempted` dispatch with no claim, are not
   misclassified. The run-id tie-break is stable.
5. Every claim reader in section 2.3.2, including `assertLaunchClaim` and both HTTP reads, is per
   attempt and per resource, and `resourceClaim` keeps its K4b value.
6. `cgroup_empty`, `host_rebooted` and `operator_confirmed` are strong proofs. The tracker outcome and
   a pid never release an account. The CHECK forbids `stream_closed_unverified` on an account.
7. The Harness-only rule (itay's scope decision) refuses every legacy account requirement before
   anything is held, on every legacy path.
8. The three transactions in section 2.5.2 are the only claim writers, G creates and binds the
   dispatch, no wake re-consumes a routed attempt's condition, and a re-route spends one wake once.
   The starvation premises in section 2.5.1 are sufficient.
9. `uq_attempt_owner` and `uq_attempt_queued` admit the successor beside its predecessor and nothing
   else, and readiness keeps the successor waiting until the predecessor is final.
10. The barrier stops every grant path, tick and replay before boot step 5. Recovery skips groups, and
    group recovery settles them. The classification table gives every open attempt exactly one
    disposition.
11. The compat grant adopts the exact K4b row, and the first enabled boot counts every possibly live
    owner before any grant.
12. Section 2.13 lists every intended K4b change, and test 11 updates exactly the contradicting
    assertions.
13. The tests in section 5 are sufficient, and each maps to its owning slice in section 6.
