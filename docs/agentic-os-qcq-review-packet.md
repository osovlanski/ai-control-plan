# Quality, Cost & Quota: review packet for dispatch-changing follow-ups

Status: PROPOSED, revision 3, 2026-11-24. Applies to `qcq-04-account-concurrency` and
`qcq-05-act-on-recommendation` only. `qcq-01` (advisory estimate, API 2.15) changes no dispatch,
budget or schedule and needs none of this. Paid verification runs stay pending itay's budget
approval; any live scheduling change stays pending his rollout approval.

Revision 1 (2026-11-21) proposed one K4b claim per task, keyed by `core.auth.account`, taken in the
wake transaction and released at task settlement. A GPT-6.2-Astra High review of `main` at
`4997dc4` returned FAIL with six blocking findings. Revision 2 (PR #257, merged as `c34c29e`)
replaced that design with per-attempt claims. A second Astra High review of `c34c29e` returned FAIL
again: the per-attempt representation and the identity rule held, but the final gate, the upgrade,
the release proof, group settlement, boot order, the qcq-05 recheck point and the multi-resource
FIFO rule did not. Revision 3 closes those. Section 4 maps both rounds' findings to where each is
answered. Nothing here is implemented: every code reference is to `main` at `c34c29e`, and every
"today" describes that revision.

## 1. What changes

- **qcq-04**: one hard concurrency limit per provider account. It counts each provider attempt,
  whether it comes from a scheduler wake, a direct `/start`, a compare or race candidate, an
  autopilot attempt, a failover, a retry or a restart. The unit is the **attempt**, not the task
  (section 2.1). The limit applies only to accounts the operator declares (section 2.2). With
  enforcement off, which is the default, no account claim exists and dispatch behaves as it does
  today, except for the one intended K4b change in section 2.6 (a pool slot is released at proven
  provider exit, not at the plane's terminal transition).
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
| `held` | every requirement granted; **the provider has provably not been entered** | yes |
| `starting` | the provider-entry gate committed (section 2.4.1); the adapter call may have happened | yes |
| `live` | a session or run row has the provider's handle | yes |
| `stopping` | a stop was requested (cancel, race loss, timeout); exit is not yet proven | yes |
| `ambiguous` | the plane cannot prove whether a provider is live (legacy start ambiguity, exit never proven) | yes |
| `settled` | provider exit is proven by an exit proof (section 2.6) | released |
| `dropped` | released without ever entering a provider: cancelled while queued or held, race decided, refused by a launch check, mapping changed | released |

Claims exist exactly while the attempt is `held`, `starting`, `live`, `stopping` or `ambiguous`.
`settled` and `dropped` are final, and a final attempt's claims are released in the same
transaction that makes it final.

**The entry invariant.** The only transition into `starting` is the provider-entry gate, and the
gate is the statement immediately before the adapter call (section 2.4.1). So an attempt that is
`queued` or `held` has never entered a provider, on any path, across any number of crashes. Boot
recovery, cancellation and group settlement all rely on this invariant, and test 1 enforces it with
a call-site allowlist.

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
- `enforce: true` also requires that every assistant that would receive an account requirement
  (a declared member, or any assistant when `defaultLimit` is set) has an adapter with **strong
  exit evidence** (section 2.6.1). An account limit that cannot observe exit cannot be enforced, so
  config load rejects it instead of enforcing it loosely.
- `enforce: true` is refused at config load until the enforcement gate opens (section 2.12).
- `core.auth.account` stays as evidence only. Config check warns when two undeclared assistants
  report the same specific label, for example the same `env:<VAR>`, and suggests declaring a group.
  It never merges them.
- The existing `scheduling.accountConcurrency` stays advisory. With `enforce: true`, the estimator
  reports the enforced limit and live claims instead.
- Each attempt stores the resolved key, its source, and `account_config_hash`, a hash of the group
  definition it was resolved from. The provider-entry gate resolves the key again (section 2.4.1).

### 2.3 Schema change

This is one migration, using the next free number at implementation (057 is taken by
`057_run_effort.sql`, so 058 or later). It follows the 017/023 rebuild pattern, under deferred
foreign keys with an explicit `pragma_foreign_key_check`.

```sql
CREATE TABLE execution_attempts (
 attempt_id TEXT PRIMARY KEY,                   -- 'att_<uuid>'; migrated rows 'att_mig_<claim_id>' / 'att_mig_run_<run_id>'
 task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL CHECK(kind IN ('dispatch','direct','candidate','restart')),
 dispatch_id TEXT REFERENCES dispatches(dispatch_id),   -- the dispatch this attempt is bound to now
 candidate_slot INTEGER NOT NULL DEFAULT 0,     -- 0 single; 1..n parallel ordinal
 assistant_id TEXT,                             -- NULL only while queued before its first route
 run_as TEXT NOT NULL CHECK(run_as IN ('plane','agent')),
 account_key TEXT,                              -- NULL iff account_source IN ('none','unresolved','pending')
 account_source TEXT NOT NULL CHECK(account_source IN ('declared','fallback','none','unresolved','pending')),
 account_config_hash TEXT,
 queue_key TEXT NOT NULL,                       -- FIFO position: MIN(requirement queued_at), fixed at creation (section 2.5)
 state TEXT NOT NULL CHECK(state IN ('queued','held','starting','live','stopping','ambiguous','settled','dropped')),
 session_id TEXT REFERENCES runs(id),
 launch_plan_json TEXT,                         -- candidate / direct: the bound plan a deferred grant launches from
 entered_at TEXT,                               -- set by the provider-entry gate, never otherwise
 stop_requested_at TEXT,
 provider_pid INTEGER, provider_started_at TEXT,-- recorded when the adapter exposes its process
 exit_proof TEXT CHECK(exit_proof IN ('process_exit','pid_gone','adapter_exit','never_entered',
                                      'operator_confirmed','stream_closed_unverified','migrated_historical')),
 exit_proof_at TEXT,
 predecessor_id TEXT REFERENCES execution_attempts(attempt_id),  -- failover / retry / restart chain
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_at TEXT, reason TEXT,
 CHECK((account_key IS NULL) = (account_source IN ('none','unresolved','pending'))),
 -- a dispatch attempt is bound to a dispatch, except while queued between dispatches (2.5.2) or when final
 CHECK(kind != 'dispatch' OR dispatch_id IS NOT NULL OR state IN ('queued','settled','dropped')),
 -- queued and held prove no entry (the entry invariant, 2.1)
 CHECK(state NOT IN ('queued','held') OR (entered_at IS NULL AND exit_proof IS NULL)),
 CHECK(state IN ('queued','held','dropped') OR entered_at IS NOT NULL),
 -- final states carry their proof; dropped is always never_entered
 CHECK(state != 'dropped' OR COALESCE(exit_proof, '') = 'never_entered'),  -- COALESCE: a NULL must not pass
 CHECK(state != 'settled' OR COALESCE(exit_proof, '') IN ('process_exit','pid_gone','adapter_exit','operator_confirmed',
                                            'stream_closed_unverified','migrated_historical'))
);
CREATE UNIQUE INDEX uq_attempt_dispatch ON execution_attempts(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_session ON execution_attempts(session_id) WHERE session_id IS NOT NULL;
-- One open attempt per (task, candidate slot): a single task, or one parallel candidate, never has two.
CREATE UNIQUE INDEX uq_attempt_open ON execution_attempts(task_id, candidate_slot)
 WHERE state IN ('queued','held','starting','live','stopping','ambiguous');
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

The state CHECKs say: `queued` and `held` have no `entered_at` and no proof; every state past the
gate has `entered_at`; `dropped` always carries `never_entered`; `settled` always carries a real
proof. A `dropped` attempt may still have `entered_at` in one case only: a migrated Harness
`start_attempted` attempt with no session, dropped at boot by the pre-upgrade Harness invariant
(section 2.8.2).

`resource_claims` is rebuilt as follows:

- Add `attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id)` and
  `account_source TEXT`.
- Make `dispatch_id` and `generation` nullable. A direct start and a parallel candidate have no
  dispatch. **A dispatch-kind attempt writes its `dispatch_id` and `generation` on every claim it
  holds, pool and account alike**, so the dispatch-to-pool association the autopilot uses survives.
- Replace `uq_claim_live ON (task_id)` with `uq_claim_live ON (attempt_id, resource) WHERE
  released_at IS NULL`. Several candidates of one task, and the host pool and the account of one
  autopilot attempt, can then all be live at once.
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

The migration gives **every** `resource_claims` row an owner, live or released, because the new FK
is `NOT NULL` on every claim. It classifies by the claim, its dispatch and the run carrying that
dispatch (`runs.dispatch_id = claim.dispatch_id`), in this order:

| Existing row | Attempt `att_mig_<claim_id>` | State | `exit_proof` |
|---|---|---|---|
| claim **released** (`released_at` set) | kind `dispatch`, bound to the claim's dispatch | `settled` if a run carries the dispatch, else `dropped` | `migrated_historical` (settled, with `entered_at = run.started_at`) or `never_entered` (dropped); `final_at = released_at` |
| live claim, dispatch `reserved`, no run | kind `dispatch` | `held` | none; `reserved` precedes `start_attempted`, so no provider was entered |
| live claim, dispatch `start_attempted`, legacy, no run | kind `dispatch`, `entered_at = dispatch.updated_at` | **`ambiguous`** | none; legacy calls the adapter before inserting the run, so the adapter may have been entered |
| live claim, dispatch `start_attempted`, Harness, no run | kind `dispatch`, `entered_at = dispatch.updated_at` | `starting` | none; boot applies the 60-second rule (section 2.8) |
| live claim, a run carries the dispatch | kind `dispatch`, `session_id` = that run, `entered_at = run.started_at` | `live` | none; boot decides exit (section 2.8) |
| live claim, dispatch `reparked`, `aborted` or `cancelled`, no run | kind `dispatch` | `held` | none; the boot sweep drops it with `never_entered` |

A migrated historical attempt is final and carries `dispatch_id` only for audit; it cannot be
reopened. `uq_attempt_dispatch` holds because `uq_claim_dispatch` already allowed one claim per
dispatch.

Then, for every run or session with no attempt and `ended_at IS NULL` (direct starts, parallel
candidates, runs from before the upgrade): an attempt `att_mig_run_<run_id>` in state `live`, with
`account_source = 'unresolved'`, `entered_at = run.started_at`. Its `candidate_slot` is 0 on a
single task, and 1..n by `started_at` on a compare or race task, so `uq_attempt_open` holds. A
single task that would get two open slot-0 attempts (a live claim attempt and an unbound live run)
already violates today's ownership rules; the migration aborts with a named error and the operator
reconciles before upgrading, rather than the migration guessing. Ended runs with no claim get no
attempt: they own nothing.

SQL cannot read manifests or config, so `unresolved` keys are resolved at boot, behind the launch
barrier (section 2.8).

#### 2.3.2 Every claim reader is per attempt and per resource

Today several readers assume one live claim per task and use `.get(taskId)`. Once an attempt can
own a pool and an account, and a task can own several attempts, each `.get` returns an arbitrary
row. qcq-04a replaces every such reader. These are the call sites at `c34c29e`:

| Reader today | Becomes |
|---|---|
| `Scheduler.claim(taskId)` (`scheduler.ts` 381) | `claimsOf(attemptId)`: all live rows, keyed by resource |
| `releaseIfIdle(taskId)` (`scheduler.ts` 395) | `releaseIfSettled(attemptId)` releases every claim of the attempt in one transaction, notifying each freed resource |
| `releaseIdleClaims` (`scheduler.ts` 419) | walks live attempts, not claim rows |
| dispatch abort release, `.get(dispatch_id)` (`scheduler.ts` 892) | `.all(dispatch_id)` |
| `autopilotPark` release via `claim(taskId)` (`scheduler.ts` 1150) | releases every claim of the attempt bound to the dispatch |
| `Autopilot.launchCheck` step 2, `.get(taskId)` (`autopilot.ts` 585) | the attempt with `dispatch_id = ?`; it must list `this.cfg.pool` **and** its account (if any) in `attempt_requirements`, and hold a live claim with that `dispatch_id` for **every** requirement |
| `claimed(resource)` sum, pool listing (`scheduler.ts` 113, 178) | unchanged: already per resource |

A test inserts a pool claim and an account claim on one attempt, plus a second attempt's claim on
the same task, and asserts each reader above (test 2).

### 2.4 One reservation point, on every provider start

The **launch reservation** is the only place a claim is granted. It is one transaction that does
the following:

1. Fixes the routing choice: a fresh route, or the stored decision on replay.
2. Resolves `accountKey(chosen, runAs)`.
3. Writes or reuses the attempt row and its `attempt_requirements`: the task's host pool, if any,
   plus the account, if any.
4. Runs the grant rule of section 2.5 for that attempt, with the launch barrier open
   (section 2.8).
5. Either inserts every claim, with the attempt moving to `held`, or inserts none, with the attempt
   staying `queued` and a durable wait as described in section 2.5.

A partial grant is not expressible. Either the whole requirement set commits with the attempt, or
nothing does.

Today the K4b pool claim commits in the wake transaction, before routing (`scheduler.ts` `wake`
795, then `start` routes in a later transaction). Revision 3 moves the pool claim to the launch
reservation, so pool and account are granted together, **and keeps the attempt's FIFO position
across the gap** between wake and reservation (section 2.5.2). The wake keeps the pool check as a
non-binding pre-check, which avoids consuming a condition that obviously cannot be granted, but it
no longer claims.

Every path that enters a provider goes through the launch reservation:

| Path today | What changes |
|---|---|
| Scheduler dispatch (`Scheduler.start`, route transaction) | The route transaction becomes the launch reservation. A `queued` result re-parks the dispatch with reason `resource_wait` (section 2.5.2). |
| Direct `/start` (`server.ts` `launch`) | The `CREATED -> ROUTING` transaction also creates an attempt of kind `direct` and reserves it. When capacity is full, the task goes `WAITING_RESOURCE` with an attempt wait whose continuation intent carries the confirmed assistant and composition digest. The idempotency record stores `queued`, and the route returns 202 `{ queued: true, reason: "resource_wait", account, limit, liveOwners }`. A capacity wait **never** reaches the `catch` that marks the task `FAILED`. |
| Legacy compare/race (`startTask(..., { parallel: true })` per candidate) | Section 2.7: one group-open transaction, then a per-candidate reservation in slot order. |
| Composed compare/race (`startComposedCandidates` calls `harnessBridge.start` directly) | Binding stays up front, but launch is per attempt. The bound plan is persisted on the attempt (`launch_plan_json`), and a queued candidate launches from it on grant, after rechecking the composition budget and policy. |
| Autopilot (`admit` attaches the pool wait, then a scheduler dispatch) | The attempt's requirements are the pool **and** the agent-lane account. Section 2.4.1 covers the launch checks. |
| Failover, handoff, K11 continuation, quota resume, same-assistant cooldown resume | Each is a new attempt with `predecessor_id`, reserved at its own grant (section 2.9). |
| `POST /api/tasks/:id/restart` and Harness `origin.kind = 'resume'` | A new provider process is a new attempt of kind `restart`, reserved like a dispatch. |
| Approval answer or verification continuation inside a live session | **No new attempt.** The live attempt already holds its claims (section 2.10). |

`assertLaunchClaim` stays a closed gate, now per attempt, at the top of `startTask`. It is an early
check only. The authoritative check is the provider-entry gate below, because `startTask` awaits
worktree creation, repository identity and composition binding after `assertLaunchClaim` returns
(`orchestrator.ts` 651 to 885), and a cancel can commit during any of those awaits.

#### 2.4.1 The provider-entry gate

The provider-entry gate is one synchronous SQLite transaction, `enterProvider(attemptId, ctx)`.
The adapter call is the **next statement** after the transaction commits: no `await`, no I/O and no
other transaction between them. In one transaction it does the following:

1. Confirms the attempt is `held` (never `starting`: a second entry is impossible), has no
   `stop_requested_at`, its task is not `CANCELLED`, and it owns a live claim for every row in
   `attempt_requirements`. For a dispatch-kind attempt, it also confirms the dispatch is
   `start_attempted` and still bound to this attempt.
2. Re-resolves `accountKey(request.assistantId, runAs)` and compares the key and
   `account_config_hash` with the attempt's.
3. Runs the autopilot final launch check, when the task is the autopilot's (window, budget,
   attestation, typed refusal; the window charge commits only on admission).
4. Runs the qcq-05 rechecks, when the task carries a window bound (section 3).
5. On success, sets `state = 'starting'` and `entered_at = now`, in the same transaction.
6. On any refusal, sets the attempt `dropped` with `exit_proof = 'never_entered'` and the refusal
   reason, releases every claim, and leaves the caller to park the task by that reason. No provider
   is called. A refused autopilot pass charges nothing.

A cancel and the gate serialize on the database. Either the cancel commits first, and the gate sees
`stop_requested_at` or `CANCELLED` and refuses with zero provider calls, or the gate commits first,
and the cancel finds `starting` and moves it to `stopping` with its claims held (section 2.6).
There is no interleaving in which a held claim is released and the provider still starts.

#### 2.4.2 Provider-entry call sites

There are exactly three call sites at `c34c29e` that can reach a credentialed provider, and the gate
sits immediately before each one:

| Call site | Gate placement |
|---|---|
| Harness `RunContext.execute` → `startProvider` (`session-runner.ts` 471, which calls `adapter.resume` 1374 or `adapter.start` 1377) | After the provider-start slot wait (`starts.acquire`, 447) and **inside the runner's `beforeProviderStart` hook** (`finalLaunchCheck`, 462). In plane mode, `composition.ts` always installs the hook; a plane-mode runner built without it refuses to start. The hook's autopilot check (`Autopilot.beforeProviderStart`) becomes step 3 of the gate. |
| Legacy single, non-dispatch `startTask` (`orchestrator.ts` 885 `adapter.resume`, 886 `adapter.start`) | Directly before the `priorRef ? resume : start` expression, after the worktree, identity and `bindComposition` awaits. This covers a direct `/start` and every legacy compare/race candidate. |
| Legacy dispatch `executeDispatch` (`orchestrator.ts` 1016 `adapter.start`) | Directly before `adapter.start`. `beforeStart` (994) still marks the dispatch `start_attempted` first; the attempt stays `held` until the gate. |

Composed candidates and Harness dispatches enter through the Harness row. The runtime conformance
probes (`runtime-conformance.ts` 229 and 255) also call `adapter.start`, but only on a refusal
adapter built against an absent provider binary (`refusalAdapter(id, options, "absent-provider")`)
and on descriptors whose `create` is an in-process scripted runtime. They are not provider
entries, and they stay outside the gate. Test 1 pins all of this with a **call-site allowlist**: a
source test that finds every `adapter.start(`, `adapter.resume(`, `.startProvider(`,
`harnessBridge.start(` and `harnessBridge.startRequest(` call in `apps/api/src` and fails on any
call site not in the allowlist above. A conformance run against a credentialed descriptor fails the
same test at runtime.

### 2.5 Waiting without holding

A `queued` attempt holds no units of any resource.

**Readiness** keeps the K4b rule (`resourceReady`), extended to the gap:

- A single-path attempt is ready when its task's active wait condition is ready, **or** when its
  dispatch is `reserved` and routing is in flight (section 2.5.2). Not-due, dependency-pending and
  quota-blocked heads are skipped, so they cannot stall ready work.
- A candidate is ready while its group is open (section 2.7).

#### 2.5.1 The grant rule

Revision 2 granted an attempt only if it was the ready front of every queue it was in. With
crossed ages that can grant nothing while every resource is free. Example: host H and account A
have one unit each. X has host age 1 and reroutes onto A at time 3; Y queued for both at time 2. H
orders X, Y; A orders Y, X; neither is the front of both.

Revision 3 replaces the per-resource fronts with **one global order and a single pass**:

1. Every attempt has a fixed `queue_key`: the minimum `queued_at` of its requirements at creation.
   A carried pool age keeps the attempt's key, and adding or replacing the account requirement
   later (a first route, a re-route) never changes it. The global order is (`queue_key`, `task_id`,
   `candidate_slot`).
2. A grant pass reads every ready `queued` attempt in global order, inside one `BEGIN IMMEDIATE`
   transaction, with the live free units of each resource.
3. For each attempt in order: if every requirement has enough free units, it is granted, and its
   units are subtracted for the rest of the pass. Otherwise it is **blocked**, and every resource
   it requires is closed for the rest of the pass, so no later attempt takes units it needs.
4. An attempt whose account is not yet known (`account_source = 'pending'`, routing in flight) is
   blocked on its known requirements in the same way.
5. The pass ends after the last attempt. It is deterministic: the same durable state gives the same
   grants.

Properties:

- **No deadlock with free capacity.** The first ready attempt in the global order is granted
  whenever all its units are free, because nothing before it can close a resource. In the example,
  X has key 1 and is granted. The SQLite evaluation Astra ran (zero grants with both units free)
  becomes one grant.
- **No starvation.** A blocked attempt closes its resources to everyone behind it, so its position
  only improves until it is first, and the first attempt waits only for releases.
- **K4b equivalence with enforcement off.** An attempt then has at most one requirement, the pool.
  The global order restricted to one pool is the K4b per-pool order (`resource_queued_at`, then
  `task_id`), and closing a blocked attempt's pool is K4b's strict FIFO. Who runs, in what order,
  and every `resource.*` event are unchanged.
- **Cost, stated plainly.** With enforcement on, an attempt blocked on account A also closes host
  pool H to later attempts, even when H is free. Revision 2's sentence "work that needs only one of
  them proceeds when it is the front there" is withdrawn: it is what made the crossed-age deadlock
  possible. Work that shares **no** resource with a blocked attempt still proceeds. Backfilling
  around a blocked head is a later optimisation, not in scope (section 7).
- Operator run-now may move one attempt to the front of the pass, as it may skip FIFO today, but
  never past capacity.

Notifications work as in K4b, but drive the pass. A release, a grant, a new queued attempt and a
readiness change each schedule one pass (coalesced per event-loop turn). The pass then fires the
granted attempts: a single-path attempt through `wake` of its condition, a candidate through
`grantCandidate(attemptId)`. The timer sweep runs the pass as the fallback for a missed event.

#### 2.5.2 The wait and the wake gap

The durable wait for a single path is the existing `wait_conditions` row, kind `resource`, with
`attempt_id` set. The task is `WAITING_RESOURCE`, so it is visible and explained exactly like a pool
wait. A candidate's wait is its `queued` attempt row. The task stays `RUNNING` (section 2.7).

Today a busy pool leaves the condition active, and a successful wake consumes it, reserves the
dispatch and claims, in one transaction (`scheduler.ts` 788 to 799). Moving the claim to the launch
reservation opens a gap: the condition is consumed and the dispatch reserved, but nothing is
claimed until routing commits. Revision 3 closes it this way:

- **The FIFO position lives on the attempt, not on the condition.** The wake transaction that
  consumes the condition and reserves the dispatch also creates the attempt in `queued` (or rebinds
  the task's existing queued attempt to the new dispatch), with its pool requirement at the
  condition's `resource_queued_at` and `account_source = 'pending'` until routing. The attempt is in
  the global order for the whole gap, at its old `queue_key`, and readiness counts it as ready
  (section 2.5), so the pass closes its pool to later attempts. A second wake cannot overtake it.
- **A crash in the gap** leaves a `reserved` dispatch and its `queued` attempt. Boot continues the
  dispatch after the barrier opens (section 2.8), with the same attempt and key.
- **A `resource_wait` re-park keeps the attempt.** When the reservation finds the full requirement
  set (now including the account) not grantable, the re-park transaction releases nothing (the
  attempt holds nothing), keeps the attempt `queued` with its `queue_key`, unbinds it from the
  aborted dispatch, and writes the new `resource` condition with `attempt_id` pointing at it. The
  next wake rebinds the same attempt to its new dispatch. `uq_attempt_open` holds throughout.
- **The wake budget.** A `resource_wait` re-park does **not** increment `auto_wakes`, and does not
  count toward `maxAutoWakes`. Today `repark` increments on every re-park (`scheduler.ts` 1059), so
  reusing it for capacity contention would eventually send a ready task to `WAITING_INPUT`. A
  capacity wait is not a failed wake. The one exception: if the reservation routed to a different
  account than the attempt's last known requirement (a re-route), that re-park counts once, as
  today's `no_candidate` re-park does, because routing churn, not capacity, caused it. The pass
  only wakes an attempt whose current requirement set is grantable, so a capacity wait never spins.

When a single-path wake re-routes at grant and the chosen account changes, the attempt's account
requirement is replaced in the reservation transaction. The attempt, its `queue_key` and its pool
age are kept; the new account requirement's `queued_at` is now, which only matters for the reported
age. Capacity-aware routing, which prefers a free account, is not in this design (section 7).

### 2.6 Release at proven provider exit

The release boundary is the attempt's own **exit proof**. Task settlement is not it, a sibling is
not it, the plane's terminal transition is not it, and neither is the session's result commit.

At `c34c29e` the Harness writes `execution_results` in `finalize` (`session-store.ts` 437 to 446),
and only later does the runner's `finally` call `processes.terminate(sessionId)`
(`session-runner.ts` 314). Cancellation runs `safeCancel` and `finalize` even when the adapter
throws (`session-runner.ts` 486, 1978). Codex's cancel only signals an abort (`codex.ts` 405). So a
sweep between the result commit and the end of cleanup would release A while a provider may still
run. Revision 2's predicate ("the session is terminal and its `execution_results` row exists") is
withdrawn.

#### 2.6.1 Exit proofs

An attempt becomes `settled` only in a transaction that writes one of these proofs, specific to
that attempt:

| Proof | Written by | Strong |
|---|---|---|
| `process_exit` | Harness runner `finally`, **after** `processes.terminate(sessionId)` resolves with the tracked process tree reported exited or gone; Harness recovery's `terminate` of an orphaned session (`recovery.ts` 171), on the same report; legacy run end, after the legacy path registers its process with the same tracker (new in 04b: it has none today) and the tracker reports the tree gone | yes |
| `pid_gone` | Boot attempt reconciliation: the attempt recorded `provider_pid` and `provider_started_at`, and `/proc/<pid>` is absent or its start time differs (so pid reuse is not mistaken for life) | yes |
| `adapter_exit` | An adapter with no process handle that implements `exitProof(handle)`: a core adapter method that resolves only after the provider it started is gone, conformance-tested with a fake provider that delays exit. A rejected `adapter.start` is covered by the same contract: the adapter rejects only after anything it spawned has exited | yes |
| `operator_confirmed` | `POST /api/attempts/:id/confirm-stopped`, with the scope `runNow` uses today | yes |
| `never_entered` | Any transition from `queued` or `held` to `dropped` (the entry invariant) | yes, but `dropped`, not `settled` |
| `stream_closed_unverified` | End of the event stream after finish or cancel, for an adapter with neither a process handle nor `exitProof` | **no** |

**Strong exit evidence** means the adapter can produce `process_exit` or `adapter_exit`. At
`c34c29e` only the Claude adapter exposes `providerProcess` (`claude.ts` 610); Codex, in both its SDK
and app-server modes, exposes neither. Consequences:

- An **account** claim is released only by a strong proof. `enforce: true` is rejected at config
  load for an assistant without strong exit evidence (section 2.2). Codex joins an enforced group
  once its adapter implements `exitProof`, which is its own adapter PR.
- A **pool-only** attempt of an adapter without strong evidence may settle on
  `stream_closed_unverified`. That is today's K4b known ceiling, kept only there, recorded on the
  attempt and in `attempt.released`, so it is visible rather than silent.
- Legacy boot recovery writes `runs.ended_at` as crash bookkeeping (`orchestrator.ts` 601) without
  observing exit. That write stays for the run's own state, but it is **not** an exit proof: a
  legacy attempt whose run was ended by boot bookkeeping is `ambiguous` unless `pid_gone` holds.

`releaseIfIdle(taskId)` becomes `releaseIfSettled(attemptId)`. The sweep walks live attempts and
applies the proof test. `hasOwner(taskId)` stays for the task-level questions it answers today, such
as whether `attach` may proceed.

| Outcome | Attempt | Claims |
|---|---|---|
| completed / failed, exit proven | `settled` | released once, notify every freed resource |
| completed / failed, result committed, cleanup still running | `live` until the runner's `finally` writes the proof | **held** |
| cancel while `queued` or `held` | `dropped` (`never_entered`) | released (`held`) or none (`queued`); **zero provider calls** |
| cancel during an unresolved `adapter.start` (`starting`) | `stopping` | **held** until a proof, or `ambiguous` (below) |
| cancel while running, adapter slow to acknowledge | `stopping` | **held** until a proof |
| race loser | `stopping` | held until a proof |
| approval / verification pause in a live session | `live` | held |
| compare waiting only for the operator's pick | all `settled` or `dropped` | **zero** claims for the task |
| no proof within `stopEvidenceMs` | `ambiguous` | **held**, operator event `attempt.stop_unconfirmed` |
| launch-check refusal, mapping change, race decided before entry | `dropped` (`never_entered`) | released in that transaction |

`stopEvidenceMs` defaults to the run's hard-kill timeout plus 60 seconds. Today `cancelTask`
commits `CANCELLED` before adapter cancellation finishes. That stays true for the task. The task's
state and the attempt's capacity are now separate facts.

A duplicate cancel, a duplicate settle or a stale-generation wake is inert. A final attempt cannot
change state, and a claim is released with `released_at IS NULL` in its `WHERE` clause.

**This supersedes the K4b "known ceiling"** (`docs/agentic-os-k4b-resource-slots.md` §3), which
releases at the plane's terminal boundary. It applies to pool claims too, independent of `enforce`,
because they now belong to the same attempt. Astra's round-2 review judged holding through
`stopping` and `ambiguous` sound for both. It is the one intended observable K4b change with
enforcement off: a pool slot frees at proven exit, slightly later than today.

### 2.7 Parallel groups

A compare or race task is a **group**. Its lifecycle is explicit:

1. **Open.** `startParallel` creates the worktrees as today, then commits one transaction that
   creates every candidate attempt (slots 1..n, `queued`, each with its `launch_plan_json`) **and
   moves the task to `RUNNING`**, for both legacy and composed launches. Today the legacy path
   leaves the task `ROUTING` until a candidate's `startTask` advances it (`orchestrator.ts` 744,
   2313), while candidate readiness requires `RUNNING`, so the first grant could never happen.
   After this change, readiness is "the group is open", which is true from this commit, and
   `startTask`'s own `ROUTING -> RUNNING` step is a no-op for candidates. Then each candidate is
   reserved in slot order.
2. **Running.** A group is never reserved as a whole. Each candidate competes for its own slot
   through the grant pass, ordered by (`queue_key`, `task_id`, `candidate_slot`). Neither a compare
   at limit 1 nor a group larger than the account limit can deadlock: candidate 1 runs, candidate 2
   queues, and candidate 1's proven exit releases its slot.
3. **Group settlement** runs after **every** transition of a candidate attempt to a final state:
   a session settling, a proof arriving, **and a drop** (a refusal at the provider-entry gate, a
   composition budget recheck, a cancel). A drop has no session to settle, so the drop transaction
   itself schedules group settlement. `settleParallelRun` counts unfinished candidate attempts
   (`queued`, `held`, `starting`, `live`, `stopping`, `ambiguous`). Today it counts live siblings
   only, so a queued candidate is invisible to it.

Each slot's outcome is its last attempt's: `succeeded`, `failed`, `refused` (dropped by a launch
refusal), `race_decided` or `cancelled`. Decisions:

| Group | Condition | Outcome |
|---|---|---|
| race | a candidate succeeds | winner's transaction: every `queued` or `held` candidate goes `dropped` (`race_decided`), every `starting` or `live` loser goes `stopping` (below); `finishComparison` runs without waiting for loser exit, only the slots wait |
| race | a candidate fails or is refused, others unfinished | the next queued candidate stays eligible and runs when the pass grants it |
| race | no unfinished candidate, none succeeded | `FAILED` ("every racing assistant failed or was refused"), as today, with each slot's reason |
| compare | no unfinished candidate, at least one ran (`settled`) | `WAITING_INPUT` `comparison_pending`; the comparison lists refused slots as "not run: <reason>"; the task holds zero claims |
| compare | no unfinished candidate, none ran (all `dropped`) | `WAITING_INPUT` `intervention_required` with the refusal reasons; there is nothing to compare |

Today compare enters `comparison_pending` once every competitor is done, whatever its outcome, so
the first compare row keeps that, and a refused slot counts as done. That closes the case Astra
found: candidate 1 finishes, candidate 2 is refused at its deferred launch check, and the group
now enters `comparison_pending` from the refusal transaction.

**A `starting` loser.** When the race is decided while a loser's provider call is unresolved
(`starting`), the winner's transaction sets that attempt `stopping` with `stop_requested_at`. When
the call resolves, the existing post-start cancel check delivers the cancel to the new handle
(`session-runner.ts` 482 to 494 on the Harness; the legacy path does the same through
`handingOff` and `adapter.cancel`). If the call rejects, the adapter's start-rejection contract
decides the proof (section 2.6.1). Either way the slot stays held until a proof. A loser's later
settlement never re-runs group settlement for a decided group (`consumePlaneOwnsTerminal` already
returns early, `orchestrator.ts` 2492).

Autopilot tasks never run in parallel. That is unchanged (`startTask` throws).

### 2.8 Recovery and upgrade

#### 2.8.1 The launch barrier

A **launch barrier** guards every grant. It is closed when the plane process starts, and it opens
exactly once, at the end of boot. While it is closed:

- The grant pass and every launch reservation **grant nothing**. A reservation that would grant
  instead leaves its attempt `queued` with reason `boot_barrier`, holding nothing.
- The provider-entry gate refuses with `boot_barrier`, as a second line of defence. An attempt only
  reaches the gate while `held`, and nothing becomes `held` behind a closed barrier, so this refusal
  should never fire; a test asserts it does not.
- Any path that wants to start work **records intent** instead. A failover, handoff, retry or
  restart requested by recovery becomes a successor attempt in `queued` with `predecessor_id`, plus
  its durable wait, exactly as a deferred continuation is recorded today
  (`deferResourceContinuation`). A direct `/start` cannot arrive, because the HTTP listener starts
  after boot.
- `Scheduler.reconcileOnBoot` does not call `continueDispatch` for a `reserved` dispatch. It leaves
  it `reserved`, and the barrier's opening continues it.

This is what Astra's boot finding needs. Today `orchestrator.reconcileOnBoot` calls
`settleFromResult` (`orchestrator.ts` 566), which can call `failoverTask` (1460, 1468) and start B
before B's unresolved owners are counted, and `Scheduler.reconcileOnBoot` replays a `reserved`
dispatch inline (`scheduler.ts` 1211). Behind the barrier, both only record intent.

#### 2.8.2 Boot order

`index.ts` keeps its order, with the barrier around it:

1. Barrier closed (construction).
2. `orchestrator.reconcileOnBoot` (`index.ts` 12): Harness and legacy execution recovery. It may
   settle sessions and record successor intent; it grants nothing. Its step 2 Harness sweep no
   longer parks a parallel task with an open candidate attempt (it parks only when the task has no
   open attempt), so a queued candidate survives the restart.
3. **Attempt reconciliation**, a new step before `acceptance.reconcileOnBoot` (`index.ts` 19):
   resolve every `unresolved` account key from the attempt's assistant, its `runAs` and the current
   config, and insert its claims. A live owner that pushes an account over its limit is allowed: it
   is not cancelled, and the grant pass grants nothing on that account until occupancy falls below
   the limit. Then classify every open attempt (table below). After this step every owner of every
   resource is counted.
4. `acceptance.reconcileOnBoot` and `Scheduler.reconcileOnBoot` (`index.ts` 19, 20), unchanged
   except that the scheduler acts per attempt and does not replay `reserved` dispatches.
5. **Barrier opens.** Continue every `reserved` dispatch (in `created_at` order), run one grant
   pass, then `startTimer` and the first tick.

Classification in step 3:

| Open attempt at boot | Disposition |
|---|---|
| `queued` | kept, with its `queue_key`; granted by the pass after the barrier opens |
| `held`, dispatch kind, dispatch `reserved` or `start_attempted` | kept `held`; the replay after the barrier reuses its claims. By the entry invariant it was never entered, so a Harness `start_attempted` dispatch whose attempt is `held` needs no 60-second wait |
| `held`, dispatch kind, dispatch `reparked`, `aborted` or `cancelled` | `dropped` (`never_entered`), claims released |
| `held`, kind `direct` (no dispatch to replay) | `dropped` (`never_entered`), claims released; the task takes today's crash outcome for an interrupted direct start (`WAITING_INPUT` `harness_error`, "start interrupted by restart") and is never re-launched automatically |
| `held` or `queued`, kind `candidate`, group open | `held` returns to `queued` with its `queue_key` (claims released); the group stays `RUNNING`, and the pass grants it after the barrier |
| `held` or `queued`, kind `candidate`, group decided or task terminal | `dropped` (`never_entered`) |
| `starting`, Harness, session row exists | `live` |
| `starting`, Harness, no session row | This only occurs for a migrated attempt: a fresh Harness start persists its session before the gate. At `c34c29e` a Harness start persists its session before calling the provider, so no session proves no call. At least `RECOVERY_WINDOW_MS` (60 seconds) after `entered_at`: `dropped` (`never_entered`), the dispatch re-parks as today. Inside the window: kept, rechecked by the sweep |
| `starting`, legacy, no run | `ambiguous`, held across any number of boots until explicit reconciliation |
| `live` or `stopping`, a proof holds (`pid_gone` from a recorded pid) | `settled` |
| `live` or `stopping`, no proof possible | `ambiguous`, held, `attempt.stop_unconfirmed` |
| `ambiguous` | kept until `confirm-stopped` or a later `pid_gone` |

Every Harness provider started after this change records `provider_pid` and
`provider_started_at` when the adapter exposes its process, so a restart can usually prove exit with
`pid_gone` instead of leaving the slot `ambiguous`.

#### 2.8.3 The `runNow` predicate

`runNow(confirmNoLiveOwner)` today refuses when **any** run exists on the task (`SELECT 1 FROM runs
WHERE task_id = ?`, `scheduler.ts` 937). A settled predecessor can therefore block reconciliation of
an ambiguous successor. The predicate becomes "a run exists for **this** dispatch"
(`runs.dispatch_id = ?`). Confirming no live owner also writes `operator_confirmed` on the
ambiguous attempt, which is what releases its claims.

### 2.9 Failover and retries

- The predecessor attempt releases its account at its own exit proof, and that settlement is why
  failover runs. A same-account retry therefore never waits on its own claim. When failover is
  triggered before the proof (the result committed, cleanup still running), the successor is
  `queued` and is granted after the predecessor's proof frees the slot.
- Today `deferResourceContinuation` carries the predecessor's pool requirement forward and routes
  at grant. Revision 3 keeps that for the pool, with the same age (so the successor's `queue_key`
  is the predecessor's pool age), and **does not** carry the account. The account is derived from
  whatever the successor is routed to at its reservation. A successor routed from A to B owns only
  B, and only once it is granted. If B is saturated, the successor is `queued` on B and holds
  nothing on A.
- Every failover, handoff, retry and restart records the successor as intent (a queued attempt and
  its wait) rather than calling `startTask` inline, so the same code is correct at runtime and
  behind the boot barrier.
- Manual handoff, unattended same-assistant quota resume (`parkSameAssistant`), K2 backoff and
  `maxAutoWakes` are unchanged. They decide **when** the successor's wake fires. The launch
  reservation decides whether it may take a slot, and a `resource_wait` re-park does not spend the
  wake budget (section 2.5.2). A reset that arrives while quota stays blocked re-parks with backoff,
  makes no provider call and does not loop. A reset is a recheck time, not headroom
  (`QuotaProjection`).
- Checkpoint continuity is unchanged. The successor attempt continues from the predecessor's
  checkpoint exactly as the dispatch does today.

### 2.10 Approval ownership

- A live session waiting on an approval or a verification is a live attempt and keeps its claims.
  This keeps the K4b table row both reviews judged sound.
- A pre-start human hold, such as a pending start approval, has no attempt and owns no slot.
- An explicit approval continues the **same** session and attempt. No reservation runs, and no
  second provider is admitted.
- Nothing in qcq-04 answers, expires or skips an approval. Time advancing, a tick, run-now and a
  restart only ever reach the launch reservation, and the reservation never touches an approval.
- Denial, expiry and cancellation keep their existing outcomes. The attempt releases its claims at
  its exit proof, as section 2.6 describes.

### 2.11 Explainability

Every grant, wait, refusal and release writes a `scheduler_events` row:
`attempt.queued`, `attempt.granted`, `attempt.entered`, `attempt.dropped`, `attempt.released`,
`attempt.stop_unconfirmed` or `attempt.mapping_changed`. The payload carries the following:

- `attemptId`, `kind`, `candidateSlot`, `queueKey`
- `account` and `accountSource`
- `limit`, `claimedUnitsAfter`
- `liveOwners`: the attempt ids and task ids holding that account
- `blockedBy`: for a blocked attempt, the earlier attempt in the pass that closed the resource
- the requirement's age
- the reason, and for a release the `exitProof`

For qcq-05, it also carries the recommendation used (section 3). The operator pool listing shows
`account:` resources beside host pools. The estimator's `capacity` reads enforced claims when
`enforce: true`, and stays advisory otherwise. The API minor version is bumped once, using the next
free number at implementation.

### 2.12 Enforcement gate and rollout

Slices 04b and 04c land before 04d converts failover, handoff, restart and resume. With
`enforce: true` deployed in between, those paths would either run outside the account limit or fail
closed. Neither is acceptable, so:

- A code constant, `ACCOUNT_ENFORCEMENT_READY`, is `false` from 04a through 04c. While it is false,
  config load rejects `scheduling.accounts.enforce: true` with "account enforcement is not
  available in this build". 04d flips it, in the same PR that makes the call-site allowlist test
  (section 2.4.2) assert that every allowlisted path obtains its claims through the launch
  reservation.
- From 04a through 04c, the paths 04d has not converted still create attempt rows (04a does that
  for every start path), but through a **compat grant**: the attempt is created `held` with exactly
  the pool claim K4b takes today and no account requirement. The provider-entry gate's coverage
  check therefore passes on those paths with enforcement off, and K4b behaviour is preserved. 04d
  replaces each compat grant with a real reservation and deletes the shim; a test asserts no compat
  grant remains.
- `actOnRecommendation` (qcq-05) is independent of this constant, but qcq-05 lands after 04b
  because its rechecks live in the provider-entry gate.

## 3. qcq-05 design

- **Opt-in**: global `scheduling.actOnRecommendation: false` by default, plus a per-request
  `deferToWindow: true` on start. It needs the `tasks.start` grant. A read-only estimate credential
  (`routing.read`) and a create-only credential cannot schedule execution.
- **Kinds**: only `run-in-window` is acted on. `run-now`, `wait-for-quota-reset` (that is K2's job)
  and `wait-for-approval` (whose `startAt` is null) never create a window bound.
- **A bound, not a replacement**: the window is written to `window_json` on the task's active
  condition. That covers a time, quota, dependency or resource wait. It is carried forward
  explicitly across replacement, including a `resource_wait` re-park, the way the K4b requirement
  is. If the task has no active condition, a `time` wait is created at the window start. The opt-in
  **never** replaces or consumes an existing dependency, quota, resource or human-hold condition.
  On a task paused for an operator decision, it is refused.
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
- **Window closed**: on a wake after the window closes, on a restart after it closes, when an
  account grant arrives after it closes, or when the provider-entry gate finds it closed, nothing
  starts. The task re-plans. A new `run-in-window` recommendation writes a new bound, counted
  against `maxAutoWakes` with K2 backoff. Any other recommendation moves the task to
  `WAITING_INPUT` (`window_replan`) with the explanation. A task never starts late into closed
  hours.
- **Where the rechecks run.** Early, at the wake and at the launch reservation, so doomed work does
  no work. **Authoritatively, inside the provider-entry gate** (section 2.4.1 step 4), which is:
  - on the Harness, the runner's `beforeProviderStart` hook, which runs **after** the provider-start
    slot wait (`session-runner.ts` 447 to 462). Revision 2 put the last recheck in `beforeStart`,
    which runs before `harnessBridge.startRequest` (`orchestrator.ts` 994, 1008), so a window could
    close, or an approval become pending, while the session waited for its start slot, including on
    a materialized replay;
  - on the legacy paths, the gate directly before `adapter.start` / `adapter.resume`
    (`orchestrator.ts` 885 and 1016).

  A materialized replay skips recomposition (`recompose` returns undefined), and it still passes
  through the gate, so the replay cannot slip through. Each failure refuses before provider entry
  with its own reason, drops the attempt with `never_entered` and releases its claims:
  - The window is open.
  - Current quota allows the start.
  - `pendingApprovalCount(task) == 0`. This is the combined Harness and legacy reader in
    `task-outcome.ts` (28), not the estimator's Harness-only count.
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
| 1. Acquisition point misses real starts and precedes account selection; capacity error can mark `/start` FAILED | 2.4 (launch reservation on every path, direct `/start` returns 202 queued), 2.4.1, 2.4.2 |
| 2. Schema cannot represent per-candidate owners, multi-resource claims or candidate waits | 2.1, 2.3 (`execution_attempts`, `attempt_requirements`, rebuilt indexes), 2.5 |
| 3. Task settlement is the wrong release boundary; group settlement ignores queued candidates | 2.6 (per-attempt exit proof, supersedes K4b ceiling), 2.7 |
| 4. Recovery and failover need attempt-specific evidence; `runNow` predicate; A→B failover | 2.8 (barrier, boot order, `runs.dispatch_id` predicate), 2.9 |
| 5. `core.auth.account` is not an account identity | 2.2 (declared groups, `(assistant, runAs)`, fallback namespace, config hash) |
| 6. A qcq-05 timer establishes a due time, not continuing authorization | 3 |

### Round 2 (Astra High, `c34c29e`)

| Finding | Status in round 2 | Answered in revision 3 |
|---|---|---|
| 1. Final gate misses legacy `startTask`; claim assertion precedes async worktree prep; a held claim can be lost to cancel and the provider still entered | not resolved | 2.4.1 (synchronous provider-entry gate, `held -> starting` in the same transaction as the checks, cancel serializes against it), 2.4.2 (gate before all three call sites; conformance probes classified; call-site allowlist test), entry invariant in 2.1 |
| 2. Upgrade: owners for historical claims under the `NOT NULL` FK; legacy `start_attempted` with claim and no run backfilled as `held`; autopilot dispatch-to-pool association; readers assume one claim | resolved for new rows, upgrade blocking | 2.3.1 (every claim gets an owner, released claims become final `migrated_historical` / `never_entered` attempts, legacy `start_attempted` with no run is `ambiguous`), 2.3 (`dispatch_id` on every claim of a dispatch attempt), 2.3.2 (every reader per attempt and resource, with the `launchCheck` rewrite) |
| 3. Release before provider exit: result commit precedes cleanup; cancel finalizes when the adapter throws; Codex cancel only aborts | not resolved | 2.6, 2.6.1 (attempt-specific exit proofs; result commit is not one; strong evidence required for account claims; `stream_closed_unverified` limited to pool-only and recorded; boot `ended_at` is not a proof) |
| 4. Compare/race settlement: a dropped candidate blocks `comparison_pending`; first grant needs `RUNNING` while the legacy path is `ROUTING`; winner vs a `starting` loser | not resolved | 2.7 (group open moves the task to `RUNNING` before the first grant; settlement runs on drops; outcome table for partial and total drops; `starting` loser goes `stopping` and is cancelled on resolve) |
| 5. Boot: recovery's `settleFromResult` can fail over and start B before owners are counted; scheduler replays `reserved` before the first-grant step; legacy `ended_at` is bookkeeping; held direct start or candidate with no dispatch | not resolved | 2.8.1 (launch barrier on every grant, recovery records intent), 2.8.2 (boot order, classification table incl. held direct and candidate), 2.9 (successors recorded as intent), 2.6.1 (`ended_at` not a proof) |
| 6. qcq-05 last recheck in `beforeStart`, before the Harness start-slot wait | approval and acceptance resolved; launch authorization not | 3 (rechecks inside the provider-entry gate: the runner's `beforeProviderStart` after the slot wait, and the legacy boundary), test 10 |
| Crossed-age FIFO: two free resources, no grantable waiter | blocking | 2.5.1 (one global order by fixed `queue_key`, single pass that closes a blocked attempt's resources), test 4 |
| Wake gap and `auto_wakes`: FIFO position lost between consume and reservation; capacity re-parks spend the wake budget | blocking | 2.5.2 (attempt created at wake keeps the position; `resource_wait` re-park keeps the attempt and does not increment `auto_wakes`) |
| Enforcement through 04d; uncovered paths while 04b–c are deployed | blocking | 2.12 (`ACCOUNT_ENFORCEMENT_READY`, compat grant until 04d), section 6 |
| Missing tests in owning slices | blocking | section 5 (new cases marked **r3**), section 6 matrix |
| Non-blocking: unreliable account identity | resolved for declared groups | unchanged (2.2); strong exit evidence added as a load-time requirement |

The non-blocking findings of round 1 are kept as well:

- Section 2.10 keeps the approval-slot rule.
- Section 2.5 keeps the in-transaction capacity check, the sweep and run-now's capacity rule, and
  keeps K4b's per-pool FIFO with enforcement off.
- Section 2.7 keeps the stable slot tie-break and never reserves a whole group.
- Section 3 records the recommendation at deferral.

## 5. Required tests for the implementation PRs

Every test uses an injected clock and fake adapters that independently record four things: entry
into `start` or `resume`, cancellation acknowledgement, provider exit, and (for fakes declaring
strong evidence) the exit proof they hand back. Every test asserts both the durable claims **and**
the maximum number of fake providers live at the same time. Claim counts alone would miss an early
release. Cases new in revision 3 are marked **r3**.

1. **Last-slot contention and the entry gate.**
   - Set account A's limit to 1. Two scheduler wakes, a direct `/start`, a compare/race candidate
     and an admitted autopilot attempt all race for the slot. Exactly one provider enters. Every
     other eligible attempt has a durable resource wait, with no provider call, no failure and no
     duplicate dispatch. Repeat with legacy and composed parallel launches. An independent account
     B can still start.
   - **r3** Cancel a direct start and a legacy candidate while `startTask` is awaiting worktree
     creation (after `assertLaunchClaim`, before the gate). Assert zero provider calls, the attempt
     `dropped` `never_entered`, and its claims released. Repeat for `executeDispatch` between
     `beforeStart` and the gate.
   - **r3** Call-site allowlist: the source test of section 2.4.2 passes on the implementation and
     fails when a new `adapter.start(` call site is added outside the allowlist. A conformance run
     against a credentialed descriptor fails.
2. **Identity, configuration and readers.**
   - Two assistant ids mapped to A share one slot. Two undeclared assistants each use their own
     fallback. A fallback key cannot collide with a declared group or a host pool.
   - Exercise identical provider labels, credential aliases (`env:<VAR>`) and the agent-user lane.
   - Change a mapping between reservation and the provider-entry gate: the provider that starts
     must match the charged account (`account_mapping_changed`, zero provider calls).
   - Lower a limit from 2 to 1 while two attempts are live: both finish, and no new start happens
     until occupancy falls below 1.
   - With the limit unset (`enforce: false`), behavior is unchanged.
   - **r3** `enforce: true` is rejected while `ACCOUNT_ENFORCEMENT_READY` is false, and rejected for
     an assistant without strong exit evidence.
   - **r3** Claim readers: one attempt with a pool and an account claim, and a second attempt of the
     same task with its own claim. Every reader in section 2.3.2 returns or releases the right rows,
     and `launchCheck` finds its pool claim by dispatch.
3. **Parallel progress and fairness.**
   - At limit 1, compare two profiles on A, with an older ready single waiter and later arrivals.
     Both candidates eventually run under the documented order. The compare enters
     `comparison_pending` only after both settle, with zero claims.
   - **r3** Legacy and composed compare at limit 1: the first candidate is granted from the
     group-open commit (the task is `RUNNING` before any `startTask`), with no deadlock.
   - **r3** Dropped compare: candidate 1 finishes, candidate 2 is refused at its deferred launch
     check (budget exhausted, assistant disabled). The refusal transaction moves the task to
     `comparison_pending`, listing slot 2 as not run. With every candidate refused, the task goes
     `intervention_required`.
   - For race: a first failure lets the queued sibling run, a first success drops queued losers,
     and all-failed (including all-refused) is recorded only after the last candidate is final.
   - **r3** Race decided while a loser is `starting` (its fake `adapter.start` is unresolved): the
     loser goes `stopping`, its cancel is delivered when start resolves, its slot is held until its
     exit proof, and the winner's comparison does not wait for it. Repeat with the start rejecting.
   - A quota-blocked or dependency-blocked head cannot stall ready work, and run-now cannot exceed
     capacity.
4. **Multiple resources, ordering and autopilot.**
   - Occupy the host pool and account A separately, then contend for both in opposite orders. An
     unsuccessful attempt holds neither, work that shares no resource with it progresses, and on
     grant both claims belong to the same attempt.
   - **r3** Crossed ages: H and A have one unit each. X carries host age 1 and reroutes onto A at
     time 3; Y queued for both at time 2. With both units free, the pass grants X. Then Y is granted
     after X's proof. Every sweep gives the same answer.
   - **r3** Wake gap: X is woken (condition consumed, dispatch reserved) and a second waiter's wake
     fires before X's routing commits. X keeps its position; the second waiter cannot take X's pool
     units. Crash in the gap: after boot X continues with the same attempt and `queue_key`.
   - **r3** Wake budget: a task re-parked `resource_wait` more than `maxAutoWakes` times stays
     `WAITING_RESOURCE`, with `auto_wakes` unchanged, and starts when capacity frees. A re-route to a
     different account counts once.
   - **r3** K4b equivalence: with `enforce: false`, the existing K4b tests and `demo:a5` give the
     same grants, order and events as on `main`.
   - Close the autopilot window, or expire its billing attestation, between the early and final
     checks. Assert zero provider calls, the existing typed refusal, release of both claims and no
     duplicate window charge.
5. **Cancellation, settlement and exit proof.**
   - Cancel at four points: while queued, after reservation but before the gate, during an
     unresolved `adapter.start`, and while a running adapter delays its cancellation
     acknowledgement. Also delay a race loser's exit.
   - A pre-entry cancellation makes zero calls. A possibly live provider keeps occupying its slot.
     After a proof, the next waiter wakes exactly once.
   - **r3** Result before exit: the fake commits its result, then delays process exit. Run the sweep
     between the `execution_results` commit and the runner's `finally`. The claim stays held; it is
     released only after `processes.terminate` reports the tree gone. Repeat with the adapter
     throwing in `cancel`.
   - **r3** An adapter with no process handle and no `exitProof`: a pool-only attempt settles on
     `stream_closed_unverified` and says so in `attempt.released`; the same adapter cannot be in an
     enforced group.
   - A duplicate cancel, a duplicate settle and a stale-generation wake are inert.
6. **Crash and upgrade recovery.**
   - Kill and reopen the plane at five points: after the claim, after route or request
     materialization, after `start_attempted` with no run, after session creation but before the
     phase update, and after a durable end but before the proof.
   - Include a queued sibling, and a live pre-upgrade run with no new-format claim (an `unresolved`
     backfill).
   - Assert no over-admission on first boot, no duplicate start and no leaked settled claim.
   - Harness missing-session recovery respects 60 seconds for migrated `starting` attempts.
   - Legacy ambiguity survives repeated boots until explicit reconciliation, including when the task
     has a historical predecessor (the `runs.dispatch_id` predicate).
   - **r3** Upgrade backfill: a database with a released historical claim, a live claim on a
     `reserved` dispatch, a live claim on a legacy `start_attempted` dispatch with no run, and an
     autopilot pool claim. The migration passes `pragma_foreign_key_check`; the attempts are
     `settled`/`dropped` final, `held`, `ambiguous` and `held`, and the autopilot's `launchCheck`
     finds its pool claim.
   - **r3** Boot classification: a `held` direct start is dropped with today's interrupted-start
     outcome; a `held` candidate of an open group returns to `queued` and runs after boot; a
     recorded `provider_pid` that is gone gives `pid_gone`; one that is alive gives `ambiguous`.
   - **r3** Barrier: with the barrier closed, no grant, no `held` transition and no provider-entry
     gate pass happens, even when a reservation is attempted; the gate's `boot_barrier` refusal never
     fires.
7. **Failover and retries.**
   - At limit 1, fail on A and retry on A. Then fail on A and route to a saturated B. The
     predecessor releases exactly once, a same-account retry cannot wait on itself, and a B
     successor owns only B once it is granted.
   - **r3** Boot-time failover: B is at its limit with an `unresolved` pre-upgrade owner, and A's
     session result is waiting for boot recovery. Recovery's `settleFromResult` requests failover
     to B. The successor is recorded `queued`; nothing starts on B until reconciliation counts B's
     owner and occupancy falls below the limit.
   - Repeat for manual handoff and for unattended same-assistant quota resume. Assert checkpoint
     continuity, K2 backoff and the maximum number of automatic wakes.
   - A reset while quota stays blocked produces no provider call and no tight timer loop.
   - **r3** No compat grant remains after 04d, and the allowlist test asserts every path uses the
     reservation.
8. **Approval ownership.**
   - In both legacy and Harness, park a live provider on an approval while another A waiter exists.
     Advance time, tick, run-now and restart. No timer sends an approval response, and no second
     provider is admitted while ownership is live or ambiguous.
   - An explicit approval continues the same session. Denial, expiry and cancellation follow their
     existing outcomes and release after the exit proof.
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
   - An existing dependency, quota delay or human hold survives the opt-in, and the bound survives
     a `resource_wait` re-park.
10. **Authorization, spend and acceptance (qcq-05).**
    - A read-only estimate credential and a create-only credential cannot schedule execution.
    - Insert a pending approval after deferral, change the confirmed assistant or digest, tighten
      permissions, and exhaust the remaining Composer budget. Repeat each after request
      materialization and after a restart. Each gate refuses before provider entry, with its own
      reason.
    - **r3** Between the hooks: set `maxConcurrentProviderStarts` to 1 and hold the slot with another
      session. Let the deferred task pass `beforeStart` (dispatch `start_attempted`) and queue for
      the slot. While it waits, close the window, and separately insert a pending approval. Release
      the slot: the runner's `beforeProviderStart` refuses with the right reason, zero provider
      calls, the attempt `dropped`. Repeat on a materialized replay, and at the legacy boundary.
    - Capture the effective approval mode, including the autopilot's and workspace read-only mode.
    - Fail a required acceptance command, and assert no accepted state and no publication.
    - Verify that the wait and refusal evidence names the account, the limit, the live owners and
      the recommendation used.

## 6. Evidence and slices

The implementation lands in four slices, each a separate PR reviewed against this packet, plus
qcq-05:

| Slice | Scope | Tests |
|---|---|---|
| qcq-04a | Migration and backfill (2.3.1); per-attempt claim readers (2.3.2); attempt rows on every start path, with the compat grant (2.12); resolver and config (`enforce: false` only, `ACCOUNT_ENFORCEMENT_READY = false`); exit-proof columns; boot reconciliation of `unresolved` keys | 2 (identity, unset, enforcement refused, readers), 6 (upgrade backfill) |
| qcq-04b | Launch reservation and grant pass (2.5) on the single, direct `/start` and autopilot paths; wake-gap attempt and `resource_wait` re-park (2.5.2); provider-entry gate at all three call sites and the allowlist (2.4.1, 2.4.2); exit-proof release (2.6); launch barrier and boot order (2.8); `runNow` predicate | 1 (single paths, gate, allowlist), 4, 5, 6 (crash, classification, barrier), 8 |
| qcq-04c | Parallel group open, candidate grants and group settlement on drops (2.7) | 1 (parallel), 3, 5 (race loser) |
| qcq-04d | Failover, handoff, restart and resume as reserved attempts recorded as intent; delete the compat grant; flip `ACCOUNT_ENFORCEMENT_READY` | 7 (incl. boot-time failover), 1 (allowlist asserts the reservation on every path) |
| qcq-05 | Window bound and rechecks in the provider-entry gate, after qcq-04b | 9, 10 (incl. between the hooks) |

`enforce: true` cannot be configured on any build before qcq-04d, so 04b and 04c never run with an
uncovered path under enforcement (section 2.12).

Every slice attaches the following:

- The gates: `pnpm typecheck && pnpm lint && pnpm test`.
- `pnpm demo:a`, `demo:a5` and `demo:b`. Through 04c they run with `enforce: false`, and the capture
  shows the K4b outcomes unchanged. From 04d they also run with account A's limit set to 1 and two
  fake assistants in group A, with an injected clock, no credentials and no quota spend; the
  capture shows one live provider and one resource wait naming account A, its limit and its live
  owner.
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
- Backfilling around a blocked attempt in the grant pass (section 2.5.1).
- Exit proof for the Codex adapter. It is its own adapter PR; until it lands, Codex cannot be in an
  enforced group.
- Budget enforcement beyond the existing Composer caps.
- Paid runs.
- Turning on `enforce: true` or `actOnRecommendation` in live config.
- Any live change on the OCI box.

The last three need itay's explicit approval.

## 8. What the re-review must check

1. Every provider entry goes through the provider-entry gate, and the gate is the statement
   immediately before the adapter call at each of the three call sites in section 2.4.2. Look for
   `adapter.start`, `adapter.resume`, `startProvider`, `harnessBridge.start` and
   `harnessBridge.startRequest` call sites the allowlist does not name, and for any `await` between
   the gate's commit and the call.
2. The entry invariant holds: nothing but the gate moves an attempt to `starting`, so `queued` and
   `held` prove no provider entry, and a cancel serializes against the gate.
3. The schema admits every legal owner and the CHECKs reject an unproven `settled`. The backfill in
   section 2.3.1 gives every claim, released or live, a valid owner under the `NOT NULL` FK, and
   classifies a legacy `start_attempted` dispatch with a claim and no run as `ambiguous`.
4. Every claim reader in section 2.3.2 is per attempt and per resource, and the autopilot
   `launchCheck` finds its pool claim by dispatch once an attempt holds two claims.
5. The exit proofs in section 2.6.1 are attempt-specific and none is written before the provider is
   gone. The result commit, a cancel acknowledgement and boot `ended_at` bookkeeping are not proofs.
   Requiring strong evidence for account claims, and limiting `stream_closed_unverified` to
   pool-only attempts, is acceptable.
6. The grant pass in section 2.5.1 is deterministic, grants the first ready attempt whenever its
   units are free (the crossed-age case), cannot starve, and equals K4b with enforcement off.
7. The wake gap in section 2.5.2 keeps FIFO position across consume, routing, re-park and crash,
   and a `resource_wait` re-park does not spend `auto_wakes`.
8. The group lifecycle in section 2.7 has no first-grant deadlock, reaches a decision when some or
   all candidates are dropped, and holds a `starting` loser's slot until its proof.
9. The launch barrier in section 2.8 covers every grant path, recovery only records intent, and
   the boot classification gives every open attempt, including a held direct start and a held
   candidate with no dispatch, exactly one disposition.
10. The qcq-05 rechecks run in the provider-entry gate: after the Harness start-slot wait in
    `beforeProviderStart`, and at the legacy boundary. No timer path can answer an approval or mark
    an attempt accepted.
11. `ACCOUNT_ENFORCEMENT_READY` and the compat grant keep `enforce: true` unconfigurable until every
    path is converted in qcq-04d.
12. The tests in section 5 are sufficient, and each maps to a slice in section 6.
