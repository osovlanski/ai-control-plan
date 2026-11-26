# Quality, Cost & Quota: review packet for dispatch-changing follow-ups

Status: PROPOSED, revision 6 (errata), 2026-11-25, with the 04a as-built notes of section 8.1 and the 04b part 1 notes of section 8.2. Applies to `qcq-04-account-concurrency` and
`qcq-05-act-on-recommendation` only. `qcq-01` (advisory estimate, API 2.15) changes no dispatch,
budget or schedule and needs none of this. Paid verification runs stay pending itay's budget
approval; any live scheduling change stays pending his rollout approval.

Revision history. Revision 1 (2026-11-21) proposed one K4b claim per task keyed by
`core.auth.account`; Astra High at `4997dc4`: FAIL. Revision 2 (PR #257, merged `c34c29e`)
introduced per-attempt claims; Astra High at `c34c29e`: FAIL. Revision 3 (PR #260 head `428f859`)
added a provider-entry gate, exit proofs, a boot barrier and a global grant pass; Astra High at
`428f859`: FAIL, with the crossed-age FIFO deadlock and the qcq-05 recheck placement resolved, and
the gate, upgrade, exit evidence, legacy loser, successor intent, wake/grant ordering, rollout and
test seams still open. Revision 4 (PR #261, merged `d0c2099`, head `641c4a3`) answered those and
narrowed account enforcement to Harness starts (itay's decision, 2026-11-24); Astra High at
`641c4a3`: FAIL, with the qcq-05 placement and positive control resolved, and a stale-lease commit,
backfill precedence, scope registration, boot identity, the first-enable legacy path, G write order,
re-route replay, the compat insert order and test-slice gaps open. Revision 5 (PR #262, merged
`6ce303a`) answered those; Astra High at `6ce303a`: FAIL with eight blocking findings. Revision 6 is
an **errata** that closes them, after which itay chose (2026-11-25) to stop whole-packet rounds and
review each implementation slice against its own tests (section 6).
Section 4 maps every round's findings. Nothing here is implemented:
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
The upgrade migration writes no `starting` row (section 2.3.1); it writes only `live`, `ambiguous`,
`held` and final rows. Boot recovery, cancellation and group settlement rely on this
invariant, and test 1 enforces it with a call-site allowlist.

**The session-terminal rule.** `SessionStore.terminalize` (`session-store.ts` 413 to 448), the one
transaction every Harness session terminal state goes through, also reads the attempt bound to the
session (its `extra` hook already runs inside that transaction). If that attempt is still
`held`, the same transaction moves it to `dropped` with `never_entered` and releases its claims.
This covers every runner exit that never reaches the commit: an abort while waiting for the
provider-start slot (`finalizeBeforeStream`, `session-runner.ts` 447 to 452), a preparation error,
a session-only cancel, and a lease takeover. A fence that throws at `session-runner.ts` 451 leaves
finalization to recovery, whose `terminalize` applies the same rule; until then the `held` attempt
keeps its claims, which is safe because it cannot enter (the commit checks the lease, section 2.4.1).
If the attempt is `starting` or later, the rule leaves it alone; only an exit proof settles it.

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
  explanation; nothing is held and nothing starts. G, the re-route and boot reconciliation apply
  the same check (sections 2.5.2, 2.5.3, 2.8.2), and `trg_claim_account_harness` makes a legacy
  account claim impossible whatever code tries to write one. Config check warns when `enforce: true` is set
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
 entered_boot_id TEXT,                          -- /proc/sys/kernel/random/boot_id at the commit; NULL only on migrated rows (2.6.1)
 stop_requested_at TEXT,
 provider_unit TEXT,                            -- the systemd unit / cgroup the provider runs in (2.6.1)
 provider_unit_seen_at TEXT,                    -- first time the plane read that unit populated: registration (2.6.1)
 exit_proof TEXT CHECK(exit_proof IN ('cgroup_empty','unscoped_exit','host_rebooted','operator_confirmed',
                                      'never_entered','stream_closed_unverified','boot_unverified',
                                      'task_terminal_unverified','migrated_historical')),
 occupies_account TEXT,                         -- an owner without a unit that resolves to an account: occupancy, no claim (2.8.2)
 exit_proof_at TEXT,
 predecessor_id TEXT REFERENCES execution_attempts(attempt_id),  -- failover / retry / restart chain
 inherited_hops INTEGER NOT NULL DEFAULT 0,     -- times this lineage inherited a queue_key (2.5.1)
 deadline_at TEXT,                              -- absolute launch deadline D from the precheck (2.4.1)
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_at TEXT, reason TEXT,
 CHECK((account_key IS NULL) = (account_source IN ('none','unresolved','pending'))),
 -- an owner-state dispatch attempt is bound to its dispatch; queued attempts may sit between dispatches (2.5.3)
 CHECK(kind != 'dispatch' OR dispatch_id IS NOT NULL OR state IN ('queued','settled','dropped')),
 -- queued and held prove no entry (the entry invariant, 2.1)
 CHECK(state NOT IN ('queued','held') OR (entered_at IS NULL AND exit_proof IS NULL)),
 CHECK(state IN ('queued','held','dropped') OR entered_at IS NOT NULL),
 -- final states carry their proof; dropped is always never_entered. COALESCE: a NULL must not pass.
 CHECK(state != 'dropped' OR COALESCE(exit_proof, '') = 'never_entered'),
 CHECK(state != 'settled' OR COALESCE(exit_proof, '') IN ('cgroup_empty','unscoped_exit','host_rebooted',
                                                          'operator_confirmed','stream_closed_unverified',
                                                          'boot_unverified','task_terminal_unverified',
                                                          'migrated_historical')),
 -- an attempt with an account key is never settled by a weak proof (the claim side is a trigger below).
 -- account_key is set only on an attempt that requires the account; occupancy-only owners use occupies_account.
 CHECK(COALESCE(exit_proof, '') NOT IN ('stream_closed_unverified','boot_unverified','task_terminal_unverified')
       OR account_key IS NULL),
 CHECK(occupies_account IS NULL OR account_key IS NULL),
 -- a runtime entry records its boot; only a migrated row (proof or state from the migration) may lack it
 CHECK(entered_at IS NULL OR entered_boot_id IS NOT NULL OR attempt_id LIKE 'att_mig_%')
);
CREATE UNIQUE INDEX uq_attempt_dispatch ON execution_attempts(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_attempt_session ON execution_attempts(session_id) WHERE session_id IS NOT NULL;
-- At most one owner per (task, candidate slot): a slot never has two providers or two claim sets.
CREATE UNIQUE INDEX uq_attempt_owner ON execution_attempts(task_id, candidate_slot)
 WHERE state IN ('held','starting','live','stopping','ambiguous');
-- At most one waiting successor per slot. It may coexist with the owner it succeeds (2.8.1, 2.9).
CREATE UNIQUE INDEX uq_attempt_queued ON execution_attempts(task_id, candidate_slot) WHERE state = 'queued';
CREATE INDEX idx_attempt_queue ON execution_attempts(queue_key, task_id, candidate_slot) WHERE state = 'queued';
-- A queued attempt in a slot that has an owner must name that owner as its predecessor (2.9).
CREATE TRIGGER trg_attempt_successor BEFORE INSERT ON execution_attempts
WHEN NEW.state = 'queued' AND EXISTS (SELECT 1 FROM execution_attempts o
  WHERE o.task_id = NEW.task_id AND o.candidate_slot = NEW.candidate_slot
    AND o.state IN ('held','starting','live','stopping','ambiguous')
    AND o.attempt_id IS NOT COALESCE(NEW.predecessor_id, ''))
BEGIN SELECT RAISE(ABORT, 'queued attempt in an owned slot must name the owner as predecessor'); END;
-- The same rule for the other write directions (Astra, round 5): moving a queued row's lineage, and an
-- owner appearing in a slot that already holds a queued row which does not name it.
CREATE TRIGGER trg_attempt_successor_update BEFORE UPDATE OF predecessor_id, state, task_id, candidate_slot
ON execution_attempts
WHEN NEW.state = 'queued' AND EXISTS (SELECT 1 FROM execution_attempts o
  WHERE o.task_id = NEW.task_id AND o.candidate_slot = NEW.candidate_slot AND o.attempt_id != NEW.attempt_id
    AND o.state IN ('held','starting','live','stopping','ambiguous')
    AND o.attempt_id IS NOT COALESCE(NEW.predecessor_id, ''))
BEGIN SELECT RAISE(ABORT, 'queued attempt in an owned slot must name the owner as predecessor'); END;
CREATE TRIGGER trg_attempt_owner_insert BEFORE INSERT ON execution_attempts
WHEN NEW.state IN ('held','starting','live','stopping','ambiguous') AND EXISTS (SELECT 1 FROM execution_attempts q
  WHERE q.task_id = NEW.task_id AND q.candidate_slot = NEW.candidate_slot AND q.state = 'queued'
    AND q.predecessor_id IS NOT NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'slot holds a queued attempt that is not this owner''s successor'); END;
CREATE TRIGGER trg_attempt_owner_update BEFORE UPDATE OF state ON execution_attempts
WHEN OLD.state IN ('queued','settled','dropped') AND NEW.state IN ('held','starting','live','stopping','ambiguous')
  AND EXISTS (SELECT 1 FROM execution_attempts q
  WHERE q.task_id = NEW.task_id AND q.candidate_slot = NEW.candidate_slot AND q.state = 'queued'
    AND q.attempt_id != NEW.attempt_id AND q.predecessor_id IS NOT NEW.attempt_id)
BEGIN SELECT RAISE(ABORT, 'slot holds a queued attempt that is not this owner''s successor'); END;

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
- Add two triggers, so the cross-table invariants hold whatever code writes the rows (Astra showed
  the attempt-side CHECK alone accepts a weak proof when the account lives only on the claim):

```sql
-- An account claim exists only on a Harness attempt in an owner state (Harness-only rule, 2.2).
-- Writers set the attempt's owner state before inserting its claims, in the same transaction.
CREATE TRIGGER trg_claim_account_harness BEFORE INSERT ON resource_claims
WHEN NEW.resource LIKE 'account:%' AND NOT EXISTS (SELECT 1 FROM execution_attempts a
  WHERE a.attempt_id = NEW.attempt_id AND a.execution_path = 'harness'
    AND a.state IN ('held','starting','live','stopping','ambiguous'))
BEGIN SELECT RAISE(ABORT, 'account claim requires a Harness owner attempt'); END;
-- An attempt that ever held an account claim is never settled by a weak proof.
CREATE TRIGGER trg_attempt_weak_proof BEFORE UPDATE OF exit_proof ON execution_attempts
WHEN NEW.exit_proof IN ('stream_closed_unverified','boot_unverified','task_terminal_unverified') AND EXISTS (SELECT 1 FROM resource_claims c
  WHERE c.attempt_id = NEW.attempt_id AND c.resource LIKE 'account:%')
BEGIN SELECT RAISE(ABORT, 'weak exit proof on an account attempt'); END;
-- A claim's identity never changes and a claim row is never deleted, so "ever held an account" survives
-- release, removal and regrouping (regrouping releases the old row and inserts a new one). Astra turned
-- a legacy pool claim into an account claim by UPDATE in round 5; that write is now impossible.
CREATE TRIGGER trg_claim_identity BEFORE UPDATE OF attempt_id, resource, units, task_id, dispatch_id ON resource_claims
BEGIN SELECT RAISE(ABORT, 'a claim''s identity is immutable; release it and insert a new one'); END;
CREATE TRIGGER trg_claim_no_delete BEFORE DELETE ON resource_claims
BEGIN SELECT RAISE(ABORT, 'claim history is never deleted'); END;
```

The only permitted update of a claim sets `released_at` and `release_reason`. Retention
does not touch `resource_claims` today (`retention.ts` deletes run events only), and it must not
start to.

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
the run carrying that dispatch (`runs.dispatch_id`). Revision 4 tested the claim's release first;
Astra showed that loses to the entry mark (K4b releases a claim when the task turns terminal,
`scheduler.ts` 395 to 403 and 713 to 718, while a legacy `adapter.start` may still be in flight with
no run row, `orchestrator.ts` 1016 to 1019 and 2163 to 2174) and that a live claim on an ended run
matched no row. Revision 5 orders the rows by evidence of entry, then by the claim:

| # | Pre-upgrade row | Attempt | State | `entered_at` / `exit_proof` |
|---|---|---|---|---|
| 1 | a run carrying the dispatch has `ended_at IS NULL` (claim live, released or none) | `att_mig_<claim_id>` or `att_mig_d_<dispatch_id>`, `session_id` = that run | `live` | `run.started_at` / none |
| 2 | a run carrying the dispatch has ended (claim live, released or none) | as row 1 | `settled` | `run.started_at` / `migrated_historical`; a live claim is released in the migration, `final_at` = `released_at` or the migration time |
| 3 | **legacy** dispatch with an entry mark, no run, no operator confirmation (claim live, released or none; any current phase) | as row 1 | **`ambiguous`** | the entry mark's time / none |
| 3b | **legacy** dispatch with an entry mark, no run, **with** the operator's confirmation (`dispatch.aborted` "Operator confirmed no live execution owner", written by `runNow(..., true)`, `scheduler.ts` 934 to 946), claim live, released or none | as row 1 | `settled` | the entry mark's time / `operator_confirmed`; a live claim is released in the migration. Revision 5 let this valid, operator-reconciled database fall through to the abort |
| 4 | **Harness** dispatch with an entry mark, no session, a claim (live or released) | `att_mig_<claim_id>` | `dropped` | none / `never_entered` |
| 5 | **Harness** dispatch with an entry mark, no session, no claim | none: nothing was entered and nothing is owned | | |
| 6 | live claim, no entry mark, dispatch `reserved` | `att_mig_<claim_id>` | `held` | none |
| 7 | claim (live or released), no entry mark, no run | `att_mig_<claim_id>` | `dropped` | none / `never_entered` |
| 8 | anything else | the migration **aborts** with `qcq_backfill_unclassified` and the row's ids, rather than failing later on `attempt_id NOT NULL` | | |

The scan covers every claim row and every dispatch with an entry mark; a dispatch with neither gets
no attempt and is not an "anything else" row. Rows 1 and 2 come first because a run row is the strongest pre-upgrade evidence of entry, whatever
the claim says.

**Pool accounting of a possibly live owner whose claim was released.** Rows 1 and 3 can make an
attempt `live` or `ambiguous` whose K4b pool claim was already released (K4b releases at task
terminal while a provider may still run). The migration does **not** reopen that claim or invent
another occupancy record: the attempt is an owner with zero pool units, which is exactly K4b's view
of that pool before the upgrade (`claimed(resource)` at `scheduler.ts` 113 already counts it as
free). This is the K4b known ceiling carried over, recorded on the attempt (`reason =
'k4b_released_before_upgrade'`) and visible in `attempts`. Such an attempt never holds an account
(section 2.8.2 step 3). Row 3 precedes every claim-only row, so a released claim never hides an entry mark.
A run carrying a dispatch is unique per dispatch already (`014_durable_dispatch.sql` 42 to 43), so
rows 1 and 2 are unambiguous. The migration's `execution_path` comes from `dispatches.execution_path`,
and for a run without a dispatch from whether `runs.execution_request_id` is set (04a as built:
migration 005 backfills `session_state` on legacy runs too, so it does not mark a Harness run).

A migrated final attempt carries `dispatch_id` only for audit. `uq_attempt_dispatch` holds because
there is one attempt per dispatch. A migrated attempt never holds an account claim: before 04d no
account claim exists, and `trg_claim_account_harness` forbids one on a legacy attempt. Every migrated
row has `entered_boot_id` NULL, because the pre-upgrade plane never recorded it (section 2.6.1 says
how such an attempt is settled).

Then, for every run or session that is still **open** and has no attempt yet (direct starts,
parallel candidates, runs from before the upgrade): an attempt `att_mig_run_<run_id>` in state
`live`, with `account_source = 'unresolved'`, `entered_at = run.started_at`. A run is open when
`ended_at IS NULL`, its legacy `state` is not an end state (`ENDED_OK`, `ENDED_ERROR`, `CANCELLED`),
a Harness session's `session_state` is not terminal, and its task is not terminal. Its
`candidate_slot` is 1..n on a compare or race task, ordered by `started_at` and then run id (a
stable tie-break for equal timestamps; Astra's run gave `f_a = 1`, `f_z = 2` whatever the insertion
order). On a single task it is the first free slot, 0 when no dispatch attempt owns slot 0.

04a as built (section 8.1): a single task with **more than one** open run is not aborted. A crash can
leave a legacy run open beside a later one (the 005 legacy fixture has exactly that), and today's
boot reconcile already ends such runs (`orchestrator.ts` `reconcileOnBoot` steps 1.5 and 3). Each
extra run is kept as an owner on the next slot (`reason = 'migrated: extra open run on a single
task'`), never released or guessed away; the boot sweep settles its attempt `boot_unverified` on any
task state, since at boot a legacy run row owns nothing (section 8.1 note 6). Two **dispatch** owners on one slot do break K4b's own
one-open-dispatch rule, and that still aborts with `qcq_backfill_two_owners`. Ended runs with no
claim get no attempt.

SQL cannot read manifests or config, so `unresolved` keys are resolved at boot, behind the launch
barrier (section 2.8).

#### 2.3.2 Every claim reader is per attempt and per resource

Today several readers assume one live claim per task. Once an attempt can own a pool and an account,
and a task several attempts, each `.get` returns an arbitrary row. qcq-04a replaces every such
reader. These are the call sites at `c34c29e`, from `git grep resource_claims` and their callers:

| Reader today | Becomes |
|---|---|
| `Scheduler.assertLaunchClaim` (`scheduler.ts` 261 to 269) | per attempt: the start's attempt is `held` and has a live claim for every requirement, **each with at least the required units** (today's `held.units < need.units` check is kept per resource). An early check; the commit is authoritative |
| `Scheduler.claim(taskId)` (`scheduler.ts` 381) | `claimsOf(attemptId)`: all live rows, keyed by resource |
| `releaseIfIdle(taskId)` (`scheduler.ts` 395) | `releaseIfSettled(attemptId)` releases every claim of the attempt in one transaction, notifying each freed resource |
| `releaseIdleClaims` (`scheduler.ts` 419) | walks open attempts, not claim rows |
| dispatch abort release, `.get(dispatch_id)` (`scheduler.ts` 892) | `.all(dispatch_id)` |
| `autopilotPark` release via `claim(taskId)` (`scheduler.ts` 1150) | releases every claim of the attempt bound to the dispatch |
| `Autopilot.launchCheck` step 2, `.get(taskId)` (`autopilot.ts` 585) | the attempt with `dispatch_id = ?`; it must list `this.cfg.pool` **and** its account (if any) in `attempt_requirements`, and hold a live claim with that `dispatch_id` for **every** requirement |
| `GET /api/tasks/:id` `resourceClaim` (`server.ts` 914) and the task wait read (`server.ts` 950) | `resourceClaim` keeps its K4b meaning: the live **pool** claim of the task's single-path owner **when that claim carries a `dispatch_id`**, or null. A direct-owner or candidate pool claim (no dispatch) is never projected there; it appears only in `attempts`. Today a direct start with a pool requirement is refused by `assertLaunchClaim` (no dispatch owns a claim), so null is the K4b value for it. New: `attempts`, the task's open attempts, each with its state, slot, account, requirements and live claims (`dispatchId: string \| null`) |
| web `TaskDetail.resourceClaim` (`apps/web/src/api.ts` 191 to 196, 272) | unchanged type, whose `dispatch_id: string` (the existing wire spelling) stays correct because of the projection rule above; `attempts?: AttemptStatus[]` added. Cockpit reads neither field at `c34c29e` |
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
a doomed start does no preparation work, and it computes the **absolute launch deadline** `D`: the
earliest of the autopilot window's end, the qcq-05 window end (its minimum-slice rule is checked
separately, section 3), and the request's own runtime bound, which is turned into an instant once, at
the precheck (`precheckAt + min(policy.timeout.hardMs - elapsed, runSpec.env.maxRuntimeMs)`). For
an autopilot task the autopilot's term is today's `deadlineAtMs = min(now + remainingBudget,
closesAt - graceMs)` (`autopilot.ts` 623 to 627), so the remaining runtime budget and the window
grace are kept exactly. The precheck writes nothing: it returns `D` to its caller, which passes it to
the commit, and **the commit** stores it in `deadline_at`. Today's "launch admitted" event moves to the commit.

**The deadline contract.** Every path derives its remaining duration from `D` at the commit, never
from a duration measured earlier, and never floors it upward:

- *Refusal.* The commit refuses with `deadline_expired` (owner refused, below) when
  `D - now < scheduling.minLaunchMs` (default 1,000 ms). Today the Harness final check floors the
  remaining time at 1,000 ms (`session-runner.ts` 1328 to 1336), which can extend a run past its
  window; the floor becomes this refusal.
- *Harness.* `startProvider` sets `runSpec.env.maxRuntimeMs = D - now` and `policy.timeout.hardMs`
  to the elapsed time plus that value, in the statement before the commit returns, so the adapter's
  own bound and the runner's timer both end at `D`.
- *Legacy.* Both legacy paths arm their timeout **after** the awaited adapter call
  (`orchestrator.ts` 922 to 924, 1022 to 1023), so an outstanding `adapter.start` can run past `D`,
  and one that never returns has no timer at all (Astra's case: `D` = 100,000, commit at 90,000,
  `start` returning at 120,000). Revision 6 arms the **deadline timer inside `enterProvider`**,
  synchronously after its transaction commits (`setTimeout(onDeadline, D - now)`, no I/O), so the
  timer exists before the awaited call and the adapter call is still the next statement. If it fires while the
  handle is outstanding, it sets the attempt's `stop_requested_at` with reason `deadline`; the
  post-start read of section 2.7 then cancels the handle the moment it arrives, without registering
  an `ActiveRun`, and starts the loser drain. If the handle never arrives, the attempt stays
  `starting` with its pool claim and becomes `ambiguous` after `stopEvidenceMs`, as any start with
  no proof does. Once the handle arrives before `D`, the same timer cancels the live run at `D`; no
  second timer is armed after the call. `maxRuntimeMs = D - now` is still passed in the spec, so
  an adapter that honours it stops on its own.

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
   session-only cancel during handoff or shutdown (`orchestrator.ts` 1842 to 1844, 2240), **and the
   caller's lease is current**: `runs.lease_token = ctx.leaseToken AND runs.lease_expires_at > now`.
   Astra showed that recovery can take the lease over (`recovery.ts` 161 to 174, `acquireLease` at
   `session-store.ts` 599 to 610) while the original runner is still preparing, and that a `held`
   attempt bound to the right session passed every revision-4 predicate after its token was
   replaced. A stale caller is `not_owner`; it makes no provider call, and recovery's
   `terminalize` then drops the `held` attempt through the session-terminal rule. For a
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
5. Checks `D` (the deadline contract above).
6. On success, sets `state = 'starting'`, `entered_at = now`, `entered_boot_id` and
   `provider_unit`, writes the admission event, and commits.

Refusals come in two kinds:

- **Not the owner.** Step 1 finds the attempt not `held` (already `starting`, `live` or final), bound
  to another session or dispatch, or the caller's Harness lease not current. The commit changes
  nothing and returns `not_owner`. A duplicate or stale caller can never drop or release an owner,
  and never enters a provider.
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

Test 1's **call-site allowlist** works on the TypeScript syntax tree with the type checker, not on
source text (a regex matches the comment at `secret-broker.ts` 6 and misses a renamed receiver).
Revision 5 named the wrong declarations; Astra's checker run against the real program fixed them.
The test pins these **declarations** and every method that implements or overrides them:

| Pinned declaration | Where | Implementations also matched |
|---|---|---|
| `AgentAdapter.start`, `AgentAdapter.resume` | `packages/core/src/adapter.ts` 13 to 23 | every class method that implements `AgentAdapter` (`ClaudeAdapter`, `CodexAdapter`, the fakes and refusal adapters), so a concrete-typed receiver resolving to `ClaudeAdapter.start` is still counted |
| `HarnessBridge.start`, `HarnessBridge.startRequest` | `control-plane-bridge.ts` 164 | none |
| `SessionRunner.start`, `SessionRunner.run` | `session-runner.ts` 262 (`run` calls `this.start(request)`) | none |
| `RunContext.startProvider` | `session-runner.ts` 1346 | none |

A call is matched when its resolved symbol, or the symbol's `implements`/override target, is one of
those. The test then asserts the **exact inventory** in `apps/api/src`, with counts: five
credentialed adapter calls (`session-runner.ts` 1374, 1377; `orchestrator.ts` 885, 886, 1016); two
conformance calls (`runtime-conformance.ts` 229, 255); three bridge calls (`orchestrator.ts` 822,
1009, 2444); the internal delegation `start` → `startRequest` (`control-plane-bridge.ts` 204); one
`runner.start` (208); one `this.start` from `run` (`session-runner.ts` 262); one
`this.startProvider` (471). Any other matched call fails the test. For each of the five credentialed
calls it asserts that the preceding statement in the same block is the guarded commit,
`if (!enterProvider(...).ok) return ...;`, so only a **successful** commit reaches the call. A
conformance run against a credentialed descriptor fails the same test at runtime.

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

1. Every attempt has a fixed `queue_key`, set once at creation, by the first rule that applies:
   the minimum `queued_at` of its known requirements; else the creation time of the wait that
   produced it (for a wake, the consumed condition's `created_at`, so waking a task does not reset
   its age); else **the attempt's own `created_at`**. The last case covers a fresh direct start and
   a group candidate, which have neither a requirement nor a producing wait (`server.ts` 1121 to
   1135, `orchestrator.ts` 2273 to 2280). Adding or replacing the account requirement later never
   changes it. The global order is (`queue_key`,
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
  `resource.unsatisfiable` expiry, unchanged); operator run-now is used finitely; an attempt stays
  eligible (it is not cancelled or re-parked out of readiness); and only finitely many attempts with
  an older key can arrive. Revision 4 claimed `maxAutoWakes` enforced the last premise. It does not:
  a pool handoff and a context continuation write their new wait with `autoWakes = 0`
  (`scheduler.ts` 339 to 344, 659 to 663), so a task's chain of successors is not bounded by it.
  Revision 5 bounds the key instead of the chain. **With `enforce: true`**, a successor inherits its
  predecessor's `queue_key` only while its lineage has inherited fewer than
  `scheduling.accounts.maxInheritedKeys` times (default 3, counted on the attempt as
  `inherited_hops`); after that it takes its own `created_at`. Each lineage (one task slot's chain of
  successors) can therefore place at most `maxInheritedKeys + 1` attempts ahead of an attempt with
  key `k` (a compare task contributes one lineage per candidate slot), and no lineage created after
  `k` can, so finitely many older lineages give finitely many older keys, which is all the
  eventual-service argument needs. **With `enforce: false`** the
  successor inherits the pool age exactly as `deferResourceContinuation` does today, so K4b order is
  unchanged, and pool fairness is K4b's existing property, not a new claim of this design.
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
| **G, grant** | a grant pass, for a queued attempt with a fixed route | single path, in one transaction **in this order**: re-checks the effective execution path (an `account:` requirement on a legacy path refuses `account_requires_harness`, as R does); consumes the attempt's condition; inserts the `reserved` dispatch whose `routing_decision_id` is the attempt's; binds the attempt to it and sets `held`; inserts the claims with that `dispatch_id`; **moves the task `WAITING_RESOURCE` → `ROUTING`** and records `dispatch.reserved`, as the K4b wake does in its own transaction (`scheduler.ts` 803 to 804). Candidate: sets `held`, inserts the claims, then `grantCandidate` launches |

After G, `continueDispatch` runs `Scheduler.start`, which takes its existing replay branch because
`routing_decision_id` is already set (`scheduler.ts` 969 to 976), including the disabled-assistant
recheck. So a single-path attempt that waited is launched on the route it waited for, and the claims
G wrote always match its requirement set. The write order matters: Astra's SQLite run showed that
inserting the claim before its new dispatch fails the immediate `dispatch_id` foreign key, and
`trg_claim_account_harness` needs the attempt in an owner state before an account claim is inserted.
Revision 5 omitted the task transition: Astra drove `continueDispatch` on G's output and got
"Dispatch no longer owns task" with the dispatch left `reserved`, because `beforeStart` requires the
task in `ROUTING` (`scheduler.ts` 1008 to 1015). G now writes it, and test 4 carries a G grant
through provider entry.

**Who else writes claims.** R and G are the only claim writers **at runtime from 04b on**. Two named
exceptions exist and are the only ones: the 04a compat writes, which keep K4b's wake-time claim
until 04b replaces them (section 2.12), and boot reconciliation, which inserts or replaces an account
claim for a Harness owner (section 2.8.2 step 3) behind the closed barrier.

A timer or event wake of a condition whose `attempt_id`
names a queued attempt with a fixed route does not consume it: it schedules a pass. That removes
both conflicts Astra found. Granting an unbound dispatch attempt can no longer violate the CHECK,
because the dispatch is created inside G. Re-waking a consumed condition can no longer return stale,
because a condition is consumed only by W or G.

#### 2.5.3 The wait, the gap and the wake budget

The durable wait for a single path is the existing `wait_conditions` row, kind `resource`, with
`attempt_id` set. The task is `WAITING_RESOURCE`, so it is visible and explained exactly like a pool
wait. A candidate's wait is its `queued` attempt row, and the task stays `RUNNING` (section 2.7).

- **The gap between W and R.** The attempt exists from W, at its `queue_key`, and readiness counts it
  (section 2.5: dispatch `reserved`, route `pending`), so a pass closes its known resources to later
  attempts. A second wake cannot overtake it. A crash in the gap leaves a `reserved` dispatch and its
  `queued` attempt; boot continues the dispatch after the barrier opens (section 2.8), with the same
  attempt and key.
- **R never leaves a routed attempt without a wait.** R's no-grant branch writes the re-park and the
  new `resource` condition (with `attempt_id`) **inside R's own transaction**, together with the
  route. So no durable state has a consumed condition, a fixed route and no active wait; the
  readiness rule for a routed queued attempt is always "its condition is ready", and the
  `pending` term applies only before R commits.
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
  transaction is a compare-and-set on the route it replaces: `UPDATE execution_attempts SET
  routing_decision_id = :new ... WHERE attempt_id = :a AND state = 'queued' AND routing_decision_id
  = :expected`. Only when that changes one row does the same transaction replace the account
  requirement (after the effective-path check of G), keep `queue_key`, and spend exactly one wake
  (`auto_wakes + 1`, as today's `no_candidate` re-park does). A replay of the same event carries the
  old `:expected`, changes nothing and spends nothing. Capacity-aware routing, which prefers a free account, is not in
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

- **Every Harness provider runs in its own cgroup**, named for its attempt. On the plane lane the
  adapter spawns `systemd-run --user --scope --unit=aos-att-<attempt> -- <cmd>` through the same
  `spawnProvider` seam (`claude.ts` 583); `systemd-run --scope` registers the scope and then execs
  the command inside it, or fails without running the command. On the agent lane it is the scope
  `aos-run-<id>.scope` that `setup/run-as-agent` already creates in **the agent user's** manager
  (`run-as-agent` 22 to 38), with the attempt id as `<id>`. The commit writes the unit name to
  `provider_unit`. The plane reads a unit through its cgroup file, `cgroup.events` under the owning
  user's `user@<uid>.service`, not through `systemctl`, so it can read the agent's scope without
  privilege. A host without systemd and cgroup v2, or whose `/proc` hides other users' processes
  (`hidepid`), has no strong evidence (section 2.2), and config check says which.
- The tracker keeps its role, terminating the tree. Its outcome is never a proof. Neither is
  `stopAgentUnit` resolving: it swallows every error (`claude.ts` 669 to 682, `run-as-agent` stop
  ends in `|| true`), and the stray-unit reaper records a unit as stopped even when the stop failed
  (`provider-processes.ts` 290 to 299).

**Registration.** A missing unit is not, by itself, a proof. Astra drove a real transient scope and
observed: launcher alive with the unit not found, then `populated 1`, then the leader gone and a
worker still present (`populated 1`), then the unit not found after the worker exited. The first and
last observations look the same. So the plane records **registration**: `provider_unit_seen_at` is
set the first time it reads the unit populated (the runner polls for it after the adapter call
resolves; the sweep and boot also set it). The proofs then distinguish the two absent cases:

| Proof | Written by | Strong |
|---|---|---|
| `cgroup_empty` | the plane, for a **registered** unit (`provider_unit_seen_at` set): `cgroup.events` reports `populated 0`, or the unit no longer exists. A scope exists while any process is in it, and every descendant stays in it, so once registered, empty means every provider process is gone | yes |
| `unscoped_exit` | the plane, for an attempt **with** a `provider_unit` that was never registered, only when the spawn path is provably closed **and** no launcher can still register it. *Spawn path closed* (revision 6; Astra showed that `ClaudeAdapter.start` returns its handle before the SDK spawns, so a settled start promise proves nothing, `claude.ts` 204 to 233): either the spawning plane incarnation is dead (boot), or, in the same incarnation, the adapter reports `spawnClosed` for that run: its event stream has ended and its spawn seam was never invoked for the handle (`state.process` never set), after which the SDK cannot spawn for it. A lease takeover alone does not close it: the stale runner's adapter can still spawn, and `terminate` of an untracked process returns `untracked` (`provider-processes.ts` 153 to 161). *No launcher left*: (1) no live process on this boot carries the attempt's id in any launcher form, matched as a token in argv: `--unit=aos-att-<attempt>`, `run-as-agent run <id>` (sudo's argv carries it too), and `--unit=aos-run-<id>`, which is what the agent wrapper's argv becomes after its `exec systemd-run` (Astra observed exactly that window, `run-as-agent` 22 to 39); **then** (2) the unit does not exist. Never applied to an attempt with no `provider_unit`: "no unit was ever assigned" is not "an unregistered unit is absent" | yes |
| `host_rebooted` | boot reconciliation: the current `/proc/sys/kernel/random/boot_id` differs from the attempt's `entered_boot_id`. Revision 4 compared `/proc/stat` `btime` with a 5-second margin; Astra pointed out that `btime` is derived from wall time and moves when the clock is set, so it is not a proof. A boot id changes exactly at boot | yes |
| `operator_confirmed` | `POST /api/attempts/:id/confirm-stopped`, with the scope `runNow` uses today, or `runNow(confirmNoLiveOwner)` on the attempt's dispatch. **Refused with 409 `unit_populated`** when the attempt has a `provider_unit` that reads populated: the operator stops it first (the response offers the stop). It is accepted when the unit is absent or unreadable, which is the case it exists for | yes |
| `never_entered` | any transition from `queued` or `held` to `dropped` (the entry invariant) | yes, but `dropped`, not `settled` |
| `stream_closed_unverified` | the end of the event stream after finish or cancel, for an attempt with no `provider_unit` (a legacy run, or an adapter that cannot spawn into a cgroup) | **no** |
| `boot_unverified` | boot, for a migrated or legacy attempt with no `provider_unit` whose owning plane incarnation is dead; this is today's K4b boot release (`orchestrator.ts` 599 to 603), kept only where K4b had it | **no** |
| `task_terminal_unverified` | **04a only** (revision 6): today's K4b release points, the task-terminal release (`scheduler.ts` 395 to 403, 713 to 718), for a pool-only attempt. It names what K4b actually observed, a terminal task, not a closed stream; 04b replaces it with `stream_closed_unverified` at stream end | **no** |

Consequences:

- An **account** claim is released only by a strong proof. The attempt CHECK forbids a weak proof
  on an attempt with an account key, and `trg_attempt_weak_proof` forbids it on any attempt that
  ever held an account claim, whatever `account_key` says. Under the Harness-only rule, every
  account-bearing attempt runs in a cgroup. Codex joins an enforced group once its adapter spawns
  into one; until then `enforce: true` rejects it as a member (section 2.2).
- A **pool-only** attempt without a cgroup (every legacy run, and Codex) may settle on
  `stream_closed_unverified`, `boot_unverified` or, in 04a only, `task_terminal_unverified`. That
  is today's K4b known ceiling, kept only
  there, recorded on the attempt and in `attempt.released`, so it is visible rather than silent.
- A **migrated** attempt (`entered_boot_id` NULL) can never prove `host_rebooted`, has no unit, and
  never held an account. If it is pool-only and its incarnation is dead, boot settles it
  `boot_unverified`, as K4b does today; a Harness one is settled through its session's recovery
  with the same weak proof. It therefore never holds an account claim; at first enable it counts
  toward its account through `occupies_account` until it settles (2.8.2 step 3).

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
  post-start check requires a dispatch id and a `CANCELLED` task (`orchestrator.ts` 888 to 891), and
  a losing candidate has neither. Revision 5 replaces that check with one read of the attempt,
  **before** the run becomes active, and defines every outcome of the start and of the cancel:

  | Event on a legacy candidate in `starting` | What the plane does | Attempt |
  |---|---|---|
  | `adapter.start` resolves, `stop_requested_at` not set | today's path: run row `ACTIVE`, `ActiveRun`, `consume` | `live` |
  | `adapter.start` resolves, `stop_requested_at` set | writes the run row with `outcome = 'rejected'` (so the attempt has its `session_id`), never registers the `ActiveRun`, starts the **loser drain** (below), and only then calls `adapter.cancel(handle)` without awaiting it | `stopping` |
  | a loser that is already `live` (an `ActiveRun` exists) when the race is decided | the winner's transaction sets `stop_requested_at`; `finishComparison` never awaits the loser's cancel. Its existing `consume` loop is the drain, so `adapter.cancel` is issued without being awaited | `stopping` |
  | `adapter.cancel` throws, rejects or stays pending until its events are read | logged; the drain is already running independently of the cancel, so the stream is read and closes; the deadline timer (armed at `D`) cancels again | `stopping` |
  | `adapter.start` rejects (throws) | no handle exists, so nothing can be cancelled or drained. A legacy adapter that threw from `start` may still have spawned a process the plane cannot see. The attempt is pool-only (Harness-only rule), so it settles `stream_closed_unverified` with reason `start_rejected`, which is today's K4b behaviour for a failed start; group settlement then runs | `settled` (weak) |

  The **loser drain** is the same `consume` loop (`orchestrator.ts` 1074 to 1129) run in a
  `role: 'loser'` mode. It persists the loser's events, skips `settleRun`'s task transitions (the
  winner owns them), and at the end of the stream writes `stream_closed_unverified` on the attempt
  and releases its pool claim. Without it, a loser excluded from `ActiveRun` would have no one to
  close its stream and its slot would be held until boot. The drain starts **before** the cancel and
never waits on it: Astra pointed out that a cancel which completes only once events are consumed
would otherwise deadlock with an unread stream (`orchestrator.ts` 1082 to 1096). The same read
replaces the dispatch-only
  `CANCELLED` check at 1018.

Either way the slot stays held until a proof (for a Harness loser, `cgroup_empty`; for a legacy
pool-only loser, `stream_closed_unverified` from the drain). A loser's later settlement never re-runs
group settlement for a decided group (`consumePlaneOwnsTerminal` returns early at `orchestrator.ts`
2481).

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
   - Resolve the account key of **every** open attempt from its assistant, its `runAs`, its
     `execution_path` and the current config, not only the `unresolved` ones. Revision 4 inserted a
     missing account claim for every open attempt; Astra's literal run of that rule gave a migrated
     legacy owner `[('legacy','account:A'), ('legacy','pool')]` and gave a queued Harness attempt a
     live account claim. Revision 5 keyed the rule by lane; Astra's round-5 run then gave a migrated,
     unitless Harness owner an account claim it could never settle (its only boot disposition is the
     weak `boot_unverified`, which `trg_attempt_weak_proof` refuses), and a legacy owner that stored
     its resolved key in `account_key` failed the attempt CHECK on the same proof. Revision 6 keys the
     rule by **whether the owner can produce a strong proof**, that is, whether it has a
     `provider_unit`:

     | Open attempt | Account handling at reconciliation |
     |---|---|
     | owner state, **with** a `provider_unit` (a runtime Harness attempt in a cgroup) | insert the missing account claim, or release and re-insert one whose key changed after regrouping; `account_key` and `attempt_requirements` updated to match |
     | owner state, **without** a `provider_unit` (every legacy owner, every migrated owner, a pool-only Harness adapter such as Codex), key resolves to an account | **no claim** and `account_key` stays NULL. The key goes to `occupies_account`, and the attempt counts as **one unit of occupancy** on that account until it is final. It keeps its K4b pool disposition and may settle with a weak proof |
     | Harness, `queued` | update `attempt_requirements` only (add, replace or remove the account row); **no claim** |
     | legacy, `queued`, key resolves to an account | `dropped` `account_requires_harness`; the task goes `WAITING_INPUT` `intervention_required`, exactly as R refuses it |
     | any, key resolves to none | the account requirement row removed, a live account claim released (never deleted), `occupies_account` cleared |

     The operator's current declaration is the authority. A live owner that pushes an account over its
     limit is allowed: it is not cancelled, and the grant pass grants nothing on that account until
     occupancy falls below the limit. **Occupancy** of an account is its live claimed units plus the
     number of open attempts with `occupies_account` equal to it. That term exists only for owners
     from before enforcement was enabled, since no unitless attempt can obtain an account at runtime,
     and it reaches zero as they settle. Host pools keep the plain `claimed(resource)` sum
     (`scheduler.ts` 113); only the account check and the account listing add the term.
   - Classify every open attempt (table below).
   - **Group recovery**: for each compare or race task, settle each candidate's session result
     individually, apply the classification, then run group settlement once.

   After this step every owner of every resource is counted, so the first enabled boot, and every
   boot after a regrouping, opens the barrier on a complete count.
4. `acceptance.reconcileOnBoot` and `Scheduler.reconcileOnBoot` (`index.ts` 19, 20), changed as in
   section 2.8.1.
5. **Barrier opens.** Continue every `reserved` dispatch (in `created_at` order), run one grant pass,
   then `startTimer` and the first tick.

Classification in step 3, keyed by binding rather than kind, first match wins. Revision 4's row for
a migrated Harness `starting` attempt is removed: the backfill never produces it (rows 4 and 5 of
section 2.3.1 give `dropped` or no attempt). Revision 5 adds the runtime Harness `starting` attempt
whose session exists, which had no row:

| Open attempt at boot | Disposition |
|---|---|
| task terminal, attempt `queued` or `held` | `dropped` (`never_entered`) |
| candidate, group decided, `queued` or `held` | `dropped` (`never_entered`) |
| `queued` (task non-terminal; for a candidate, group open) | kept, with its `queue_key`; granted by a pass after the barrier |
| `held`, bound to a `reserved` dispatch | kept `held`; continued after the barrier with its claims |
| `held`, bound to a `start_attempted` or `started` dispatch, Harness, session row exists and is not terminal | the session's recovery decides. The attempt was never entered (the commit did not happen), so when recovery ends the session, the session-terminal rule drops it. If recovery offers a resume, that is a new dispatch-kind attempt |
| `held`, bound to a `start_attempted` dispatch, no session or run (Harness **or legacy**) | never entered, by the entry invariant. The dispatch re-parks with reason `start_not_entered`, which does not spend a wake; the attempt returns to `queued` with its `queue_key` and route (claims released) and is re-granted by a pass. Today a legacy dispatch here stays `start_attempted` indefinitely and a Harness one waits 60 seconds (`scheduler.test.ts` 93 to 102); both change (section 2.13) |
| `held`, bound to a re-parked, aborted or cancelled dispatch | `dropped` (`never_entered`) |
| `held`, kind `direct`, no dispatch | `dropped` (`never_entered`). The task takes today's crash outcome for an interrupted direct start (`WAITING_INPUT` `harness_error`, "start interrupted by restart") and is never re-launched automatically |
| `held`, candidate, group open | returns to `queued` with its `queue_key` (claims released); granted after the barrier |
| `starting` or later, `host_rebooted` holds (boot id differs) | `settled` (`host_rebooted`) |
| `starting` or later, unit **registered** and empty or gone | `settled` (`cgroup_empty`) |
| `starting` or later, **has** a `provider_unit`, never registered, launcher scan empty in every launcher form, unit absent | `settled` (`unscoped_exit`): the spawning incarnation is dead, so the spawn path is closed |
| `starting`, Harness, runtime, session row exists, unit populated or a launcher still running | the session's recovery takes the lease and terminates the tree (`recovery.ts` 161 to 169); the attempt goes `stopping`, is settled `cgroup_empty` once the unit reads empty (setting registration first if it was not), and becomes `ambiguous` with `attempt.stop_unconfirmed` if that has not happened within `stopEvidenceMs` |
| `starting`, `live`, `stopping` or `ambiguous`, **no** `provider_unit` (legacy, migrated, or a pool-only Harness adapter such as Codex, `codex.ts` 231 to 239), owning incarnation dead | `settled` (`boot_unverified`), as K4b releases today. Such an attempt never has `account_key` or an account claim (step 3), only possibly `occupies_account`, so the weak proof is allowed; a same-boot `stopping` legacy owner is covered here too |
| `live` or `stopping`, Harness, unit populated or a launcher still running | `stopping`; recovery terminates the tree; settled at `cgroup_empty`, else `ambiguous` after `stopEvidenceMs` |
| `ambiguous`, has a `provider_unit` | kept until a strong proof (`cgroup_empty`, `unscoped_exit`, `host_rebooted`, `operator_confirmed`) |

Every open state is covered: `queued` by rows 1 to 3, `held` by rows 1, 2 and 4 to 9, and
`starting`, `live`, `stopping` and `ambiguous` by rows 10 to 16. Every attempt without a unit meets
row 14 (boot runs only after the previous incarnation died); every attempt with a unit meets row 10,
11, 12, 13, 15 or 16 by whether the boot id changed, the unit was registered, a launcher remains and
the unit is populated. A Harness attempt
in `starting` always has a session row: the runtime commit runs inside an existing session, and the
backfill never writes a Harness `starting` row.

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
- **Compat attempt, defined.** From 04a through 04c, a path 04d has not converted still creates an
  attempt row (04a does that for every start path), with no account requirement. Astra pointed out
  that revision 4's "adopt the K4b row later" cannot work: the K4b writer inserts its claim without an
  `attempt_id` (`scheduler.ts` 797 to 799), and 04a makes that column `NOT NULL`, so the insert fails
  before anything can adopt it. Revision 5 creates the compat attempt **in the transaction that
  writes the K4b claim, before the claim**, and passes its id in the original insert:
  - *Wake* (`scheduler.ts` 787 to 799): consume the condition, insert the `reserved` dispatch,
    insert the compat attempt (kind `dispatch`, bound to that dispatch, `held`, `queue_key` per
    2.5.1), then insert the claim, if the condition has a pool, with `attempt_id` and the
    `dispatch_id`. The claim's identity (task, dispatch, generation, resource, units) is exactly
    K4b's; only the new column is added.
  - *A deferred continuation* (`deferResourceContinuation`): the continuation's wake is a wake, so
    the same order applies when its condition is woken. Nothing is granted outside a wake, so 04a
    does **not** depend on G, which arrives in 04b.
  - *A start with no pool* (direct `/start`, a candidate): the compat attempt is created `held` with
    no requirement in the path's existing start transaction, so the commit has an attempt to move.
  04b replaces the single-path compat writes with W, R and G; 04c the candidate ones; 04d the rest,
  and deletes the shim. A test in 04d asserts no compat write remains.
- **The entry invariant holds from 04a.** A compat attempt is `held` before its provider is called,
  so 04a must also move it, or a later boot would read "held, never entered" for a provider that
  ran. 04a therefore ships the commit at all three boundaries in its **ownership-only** form
  (step 1 of section 2.4.1, then step 6; the account, autopilot, qcq-05 and deadline steps arrive in
  04b), the session-terminal rule, the allowlist test, and the settlement transitions with the
  proofs 04a can produce: `never_entered`, and, at exactly the points where K4b releases today,
  `task_terminal_unverified` at runtime (K4b releases when the task is terminal and no owner row
  remains, `scheduler.ts` 395 to 403 and 713 to 718, possibly while the stream is still open, so
  revision 5's `stream_closed_unverified` would have named an event that had not happened) and
  `boot_unverified` at boot. Every 04a attempt is pool-only, so those weak proofs are allowed, and
  the K4b release timing is unchanged in 04a. 04b adds cgroups and the strong proofs, and moves
  pool-only release to the stream end (section 2.13 item 4); `task_terminal_unverified` is not
  written after 04b.
- **First enabled boot.** Enabling `enforce: true`, or regrouping, takes effect at boot. Step 3 of
  section 2.8.2 re-resolves every open attempt (owners with a unit get claims, owners without one
  count as occupancy through `occupies_account`, Harness queued attempts get requirements only,
  legacy queued attempts that now need an account are refused), before the barrier opens. No grant on an account
  happens before every possibly live owner of it is counted.
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
4. A pool slot is released at the attempt's exit proof, not at the task's terminal transition. With
   a cgroup-backed provider that is `cgroup_empty`. **A pool-only attempt without a cgroup** (every
   legacy run) releases at `stream_closed_unverified`, the end of its event stream, where today K4b
   releases as soon as the task is terminal and no owner row remains (`scheduler.ts` 395 to 403,
   413, 713 to 718), possibly while the stream is still open. A legacy race loser holds its slot
   until the loser drain closes its stream (section 2.7).
5. A `held` attempt bound to a `start_attempted` dispatch with no session or run at boot is known
   not to have entered a provider, on **both** paths, so it re-parks at once (`start_not_entered`,
   no wake spent). Today the Harness waits the 60-second window and then re-parks spending a wake
   (`start_ambiguous`), and legacy keeps the dispatch `start_attempted` indefinitely
   (`scheduler.test.ts` 93 to 102).
6. A legacy or migrated attempt still open at boot with no unit releases with `boot_unverified` at
   the same point K4b releases today; the change is only that the proof is recorded.

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

### Round 4 (Astra High, `641c4a3`)

| Finding | Round 4 status | Answered in revision 5 |
|---|---|---|
| R4-1. Entry: stale Harness lease | not resolved: the commit accepted a caller whose lease recovery had taken over | 2.4.1 step 1 (current lease required; a stale caller is `not_owner`), 2.1 (session-terminal rule names `terminalize`; fence-throw path) |
| R4-1b. Deadline `D` | contract incomplete: per-path derivation, the 1,000 ms floor, legacy timers armed after the call | 2.4.1 deadline contract (`deadline_at` stored; refuse `deadline_expired`; Harness and legacy derive from `D` at the commit) |
| R4-1c. Allowlist | regexes match a comment and miss a renamed receiver | 2.4.2 (type-checked call symbols; successful-commit guard as the preceding statement) |
| R4-2. Backfill precedence | released claim beat the entry mark; a live claim on an ended run matched no row | 2.3.1 (rows reordered by entry evidence; row 2 covers ended runs with any claim; row 8 aborts by name) |
| R4-2b. `resourceClaim` for a direct owner | projection undefined for a claim with no dispatch | 2.3.2 (projected only with a `dispatch_id`; units check kept) |
| R4-3. Exit evidence | an unregistered or vanished unit looked like exit; `btime` moves with the clock; operator confirm unchecked; weak proof accepted when only the claim held the account | 2.6.1 (registration; `cgroup_empty` only when registered; `unscoped_exit` with the launcher scan and its ordering; `host_rebooted` by boot id; operator refused while populated; agent scope read by cgroup path), 2.3 (`trg_attempt_weak_proof`) |
| R4-4. Legacy loser paths | rejected start, throwing cancel and stream drain undefined | 2.7 (outcome table; the loser drain) |
| R4-5. Boot table | no row for a runtime Harness `starting` attempt with a populated unit; an unreachable migrated row | 2.8.2 (row added, unreachable row removed, coverage stated) |
| R4-7. Starvation | `maxAutoWakes` does not bound successor chains | 2.5.1 (`maxInheritedKeys` with enforcement on; K4b inheritance unchanged with it off; premises restated) |
| R4-8. G order, re-route replay, fresh keys | G inserted the claim before its dispatch; re-route not replay-safe; no key for a fresh start or candidate | 2.5.2 (write order), 2.5.3 (compare-and-set re-route; R writes its re-park in its own transaction), 2.5.1 (own `created_at`) |
| R4-9. Rollout | boot gave legacy and queued attempts account claims; compat adoption impossible under `NOT NULL`; 04a depended on G | 2.8.2 step 3 (by attempt kind; legacy owners as occupancy), 2.3 (`trg_claim_account_harness`), 2.12 (compat attempt created before the K4b claim; ownership-only commit in 04a; no G in 04a) |
| R4-9b. Successor lineage | an unrelated queued row was admitted into an owned slot | 2.3 (`trg_attempt_successor`) |
| R4-10. Tests and slices | test 11 lines wrong; missing negative mutation, legacy fixtures, migration, first-enable and registration cases; slice ordering | section 5 (r5 cases; test 11 corrected), section 6 (matrix corrected) |
| Non-blocking: references | `terminalize`, `orchestrator.ts` 2481 | 2.1, 2.7 |

### Round 5 (Astra High, `6ce303a`)

From revision 6 the packet stops taking whole-design rounds (itay, 2026-11-25). Each slice PR is
reviewed against its own tests, and a finding blocks that PR only when the slice can reach it.

| Finding | Answered in revision 6 |
|---|---|
| R5-1. `unscoped_exit` could release before the provider spawned | 2.6.1 (`unscoped_exit` needs a recorded `provider_unit`, a closed spawn path and a scan of all three launcher forms before the unit read), 2.8.2 (boot row 14 for owners with no unit) |
| R5-2. A legacy start that returns after `D` keeps running | 2.4.1 (the deadline timer is armed inside `enterProvider`, synchronously after its transaction; a late handle is cancelled and drained; a start that never returns goes `ambiguous`) |
| R5-3. Allowlist named the wrong declarations and missed `SessionRunner.run` | 2.4.2 (pinned declarations, every implementation, and the exact call inventory) |
| R5-4. An operator-confirmed entry mark aborts the upgrade; released-claim owners | 2.3.1 (row 3b; zero-unit owners with `k4b_released_before_upgrade`) |
| R5-5. First enable gave weak-proof and unitless rows a claim the triggers then reject | 2.3 (`occupies_account`), 2.8.2 step 3 (reconciliation keyed by `provider_unit`), 2.12 |
| R5-6. G misses the `WAITING_RESOURCE` → `ROUTING` transition | 2.5.2 (G row and the dispatch-ownership paragraph) |
| R5-7. Triggers guard one write direction only | 2.3 (`trg_attempt_successor_update`, `trg_attempt_owner_insert`, `trg_attempt_owner_update`, `trg_claim_identity`, `trg_claim_no_delete`) |
| R5-8. `pausedWithoutItsSlot` fixture and slice order | section 5 test 11, section 6 (matrix corrected) |
| Non-blocking: `dispatch_id` spelling, inheritance wording, migration as a `starting` writer | 2.3.2, 2.5.1, 2.1 |

## 5. Required tests for the implementation PRs

Every test uses an injected clock and fake adapters that independently record: entry into `start` or
`resume`, cancellation acknowledgement, provider exit, and the state of a fake cgroup the test
controls (populated or empty), read through the same seam the plane uses. Every test asserts both the
durable claims **and** the maximum number of fake providers live at the same time. Account contention
in 04b and 04c is exercised through the test seam of section 2.12. Cases new in revision 6 are marked
**r6**; **r3**, **r4** and **r5** cases are kept.

1. **Last-slot contention and the entry gate.** (ownership commit, session-terminal rule and
   allowlist in 04a; account contention and the full commit in 04b; parallel parts in 04c)
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
   - **r5** Lease takeover (04a): while the runner is preparing (hold it inside secret resolution),
     let recovery acquire the expired lease. The runner reaches the commit and gets `not_owner`, with
     zero provider calls; recovery's `terminalize` drops the `held` attempt `never_entered`.
   - **r6** Legacy start crossing `D` (04b): `D` = 100 s, commit at 90 s, `adapter.start` returns at
     120 s. The deadline timer fires at 100 s while the handle is outstanding and sets
     `stop_requested_at`; the handle is cancelled on arrival, never becomes an `ActiveRun`, and is
     drained. With a `start` that never returns, the attempt becomes `ambiguous` after
     `stopEvidenceMs` and keeps its pool claim.
   - **r5** Deadline (04b): advance the injected clock by 90 s during preparation on the Harness
     (secret resolution) and on legacy (spec build), and make the legacy `adapter.start` take 30 s.
     The provider's `maxRuntimeMs` and the plane's timer both end at `D`, not later. With `D` already
     past at the commit, the result is `deadline_expired` and zero provider calls; no 1,000 ms floor
     extends it.
   - **r5** Allowlist (04a): a call through a renamed receiver (`const a = adapter; a.start(spec)`)
     fails the test, a comment naming `adapter.start()` does not, and an adapter call preceded by an
     unguarded `enterProvider(...)` (result ignored) fails.
2. **Identity, configuration and readers.** (04a; the mapping-change and limit-change cases in 04b)
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
   - **r5** A direct-owner pool claim with no `dispatch_id`: `resourceClaim` is null and the claim is
     listed under `attempts` with `dispatchId: null`; `assertLaunchClaim` refuses an attempt whose
     claim has fewer units than its requirement.
3. **Parallel progress and fairness.** (04c)
   - At limit 1, compare two profiles on A, with an older ready single waiter and later arrivals.
     Both candidates eventually run in the documented order. The compare enters `comparison_pending`
     only after both are final, with zero claims.
   - **r3/r6** Composed compare at account limit 1, and legacy compare at **host pool** limit 1 (a
     legacy candidate cannot need an account, so the legacy case uses an explicit pool): the first
     candidate is granted from the group-open commit, with no deadlock.
   - **r6** Fresh candidate key (moved here from test 4, because group open ships in 04c): a group
     candidate with no requirement gets `queue_key = created_at`.
   - **r6** Loser drain with a pending cancel: the fake's `cancel` resolves only after its events
     are read. The drain still reads the stream, the slot is released at stream end, and
     `finishComparison` never waits for the cancel. Repeat with an already-`live` loser.
   - **r3** Dropped compare: candidate 1 finishes, and candidate 2 is refused at its deferred launch
     check. The refusal transaction moves the task to `comparison_pending`. With every candidate
     refused, the task goes `intervention_required`.
   - For race: a first failure lets the queued sibling run, a first success drops queued losers, and
     all-failed (including all-refused) is recorded only after the last candidate is final.
   - **r3/r4** Race decided while a loser is `starting`, on the **legacy** path and the Harness path:
     the loser goes `stopping`, its cancel is delivered when start resolves, the legacy run never
     becomes an `ActiveRun` and is written `rejected`, and the slot is held until its proof.
   - **r5** Legacy loser outcomes, on an explicit pool-only fixture (legacy cannot hold an account):
     (a) the start resolves after the race is decided: cancel delivered, the loser drain persists its
     events, writes `stream_closed_unverified` at stream end and only then releases the pool slot;
     (b) `adapter.cancel` throws: the drain still runs and the slot is released at stream end; (c)
     `adapter.start` rejects: the attempt settles `stream_closed_unverified` with `start_rejected`
     and group settlement runs once. In each case the winner's task transitions are not repeated.
   - **r5** Legacy contention at the pool (04c): two legacy candidates and a legacy single waiter on
     a pool of 1 run one at a time in `queue_key` order.
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
   - **r5** Write order: run G with immediate foreign keys on; the dispatch is inserted before the
     claim, the attempt is `held` before its claims, and no FK or trigger error occurs.
   - **r5** Re-route replay: deliver the same disabled-assistant event twice; the second re-route
     changes nothing (compare-and-set on `routing_decision_id`) and `auto_wakes` rises by one in
     total.
   - **r5/r6** Fresh keys: a fresh direct start with no pool gets `queue_key = created_at` (the
     candidate case is in test 3, 04c).
   - **r6** G through provider entry: a G grant moves the task `WAITING_RESOURCE` → `ROUTING`, and
     `continueDispatch` takes the replay branch and enters the provider exactly once; the dispatch
     never stays `reserved` with "Dispatch no longer owns task".
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
   - **r6** Delayed spawn: drive the real `ClaudeAdapter` with an injectable query stream that
     holds before spawning. `start` has returned and `providerProcess(handle)` is absent: no proof,
     claim held. Release the stream: the unit reads populated. `unscoped_exit` is written only after
     the adapter reports `spawnClosed`.
   - **r6** Wrapper exec window: stop the agent wrapper right after its `exec systemd-run`, so argv
     carries `--unit=aos-run-<id>` and the scope does not exist yet. The launcher scan matches that
     form, and no proof is written.
   - **r5** Registration: (a) the launcher is alive and the unit not yet created: no proof, claim
     held; (b) registered, then empty: `cgroup_empty`; (c) never registered, the runner's adapter
     call has settled, the launcher scan is empty and the unit absent: `unscoped_exit`; (d) the
     sweep does not apply (c) while the runner holds a live lease; (e) on the agent lane,
     `stopAgentUnit` swallows a failing stop and the reaper records the unit stopped, but the scope
     still reads populated, so the claim stays held.
   - **r5** Boot identity: a changed `boot_id` gives `host_rebooted`; setting the wall clock back or
     forward with the same `boot_id` gives nothing.
   - **r5** Operator confirmation is refused with `unit_populated` while the unit reads populated,
     and accepted when it is absent.
   - **r5** `trg_attempt_weak_proof` rejects `stream_closed_unverified` on an attempt whose account
     lives only on its claim (`account_key` NULL).
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
   - **r6** Operator-reconciled upgrade (04a): `runNow(..., true)` on a legacy dispatch leaves an
     aborted dispatch with an entry mark, the confirmation event and no run. The migration gives row
     3b, `settled` `operator_confirmed`, and does not abort; with a live claim, the claim is released.
   - **r6** Released-claim owner (04a): rows 1 and 3 with a released claim give an owner with zero
     pool units and `reason = 'k4b_released_before_upgrade'`; no claim is reopened.
   - **r5** Backfill counterexamples (04a): a legacy entry mark with a **released** claim and no run
     gives `ambiguous`; a live claim on a dispatch whose run has ended gives `settled`
     `migrated_historical` and releases the claim; a released claim with a still-open run gives
     `live`; an unclassifiable row aborts with `qcq_backfill_unclassified`, not a `NOT NULL` error.
   - **r5** Boot (04b): a runtime Harness `starting` attempt with its session and a populated unit
     goes `stopping`, recovery terminates it, and it settles `cgroup_empty` only after the unit
     empties; a legacy `start_attempted` dispatch with a `held` attempt and no run re-parks
     `start_not_entered`.
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
   - **r5** Compat attempt (04a): a wake writes the dispatch, the compat attempt and the claim, in
     that order, in one transaction; the claim's task, dispatch, generation, resource and units equal
     K4b's; a crash after the wake leaves all three or none. No G exists in 04a. In 04d no compat write
     remains, and the allowlist asserts that every path uses R or G.
   - **r5/r6** First enable by unit (04d): a migrated legacy owner and a migrated, unitless Harness
     owner whose keys resolve to A get no account claim and no `account_key`, only
     `occupies_account = 'account:A'`, so a Harness waiter on A at limit 1 does not start until they
     settle, and each settles `boot_unverified` without a CHECK or trigger error; a runtime Harness
     owner with a unit gets the claim; a queued Harness attempt gets the account requirement and no
     claim; a queued legacy attempt that now needs A is dropped `account_requires_harness`.
   - **r5** Inherited keys (04d, enforcement on): a task whose successors keep inheriting an older
     key stops inheriting after `maxInheritedKeys`, and a younger waiter is then granted. With
     enforcement off the successor keeps K4b's inherited pool age.
   - **r5/r6** Schema triggers (moved to **04a**, which ships them): inserting a `queued` attempt
     into an owned slot without naming the owner fails; so do the reverse order (an unrelated queued
     row, then an owner in the same slot), clearing a waiting successor's `predecessor_id`, updating
     a legacy pool claim's `resource` to an account, and deleting a claim row. A weak proof is
     rejected when only a released historical claim names the account.
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
    - **r5** Negative mutation after a successful precheck: let the slot open and the precheck pass,
      then, inside preparation (the secret-resolution hook on the Harness, the spec build on legacy),
      close the window, and separately insert a pending approval. The precheck never sees the change,
      so only the commit can refuse it: zero provider calls, the right reason, the attempt `dropped`.
    - Capture the effective approval mode, including the autopilot's and the workspace read-only mode.
    - Fail a required acceptance command, and assert no accepted state and no publication.
    - The wait and refusal evidence names the account, the limit, the live owners and the
      recommendation used.
11. **Changed K4b expectations.** (04b; corrected in r5) The existing K4b tests are the regression
    set, except for these assertions, which contradict the intended changes of section 2.13. They
    are updated in the same PR, each with a comment naming 2.13. Revision 4 pointed at the wrong
    lines; these are the ones that change:
    - `resource-slots.test.ts` 210 (cancel at `reserved`): `claimRows(id)` is empty instead of one
      released row; the attempt is `dropped` `never_entered`. Lines 211 to 215 (the waiter gets the
      slot and finishes) are kept.
    - `resource-slots.test.ts` 225 (restart at the reservation boundary): after the crash there is no
      live claim, but a `queued` attempt and a `reserved` dispatch. Lines 228 to 231 (one provider
      start after boot, claims settle to zero) are kept.
    - `resource-slots.test.ts` 235 to 246 (sweep of a claim on a cancelled task): the fixture's
      approval-blocked fake is still running, so neither proof exists, with a cgroup or without. The
      claim must **stay held** while the fake runs; the test then ends the fake and asserts the
      release with `cgroup_empty` (cgroup fixture) or `stream_closed_unverified` (pool-only fixture),
      replacing the "no execution owner" release reason.
    - `resource-slots.test.ts` 249 to 262 (Harness start ambiguity): the claim is released at once
      and the condition is `reason: 'start_not_entered'`, `autoWakes: 0`, with no 60-second wait.
    - `scheduler.test.ts` 93 to 102 (attempted start without a session): both paths re-park at once
      as `start_not_entered` with `autoWakes: 0`, instead of the 60-second window on the Harness and
      an indefinite `start_attempted` on legacy.
    - `resource-slots.test.ts` 760 to 784 (`pausedWithoutItsSlot`, used by the handoff cases after
      it): the fixture parks the holder at the `reserved` boundary and then waits for a live claim.
      Under W no claim exists at `reserved`, so the fixture would wait forever on both execution
      modes (Astra, round 5). The hold moves to the post-grant boundary, `start_attempted`, where the
      holder's claim is live; the handoff assertions after it are kept.
    - Kept unchanged: the strict-FIFO test (`resource-slots.test.ts` 150 to 161), `scheduler.test.ts`
      105 to 109 (a committed session is recovered without replay) and 111 to 120 (cancel of an
      entered provider reaches the adapter).

## 6. Evidence and slices

The implementation lands in four slices, each a separate PR reviewed against this packet, plus
qcq-05:

| Slice | Scope | Tests |
|---|---|---|
| qcq-04a | Migration, backfill and triggers (2.3, 2.3.1); per-attempt claim readers and the `attempts` projection (2.3.2); compat attempts written before the K4b claim on every start path (2.12); the **ownership-only** commit at all three boundaries, the session-terminal rule and the allowlist (2.1, 2.4.1 steps 1 and 6, 2.4.2); settlement with `never_entered`, `task_terminal_unverified` and `boot_unverified` at today's K4b release points (2.12); resolver and config (`enforce: false` only, `ACCOUNT_ENFORCEMENT_READY = false`) | 1 (lease takeover, allowlist, cancel during preparation), 2 (identity, unset, enforcement refused, readers, direct-owner projection), 6 (upgrade backfill and its counterexamples, operator-reconciled upgrade, released-claim owner), 7 (compat attempt order, schema triggers) |
| qcq-04b | Cgroup spawn, registration and the strong proofs (2.6.1); the full commit: account re-resolve, autopilot check, deadline `D` (2.4.1); W, R, G and the grant pass (2.5) on the single, direct `/start` and autopilot paths; re-park, re-route compare-and-set and wake budget (2.5.3); the Harness-only refusal (2.2); launch barrier, boot order and classification (2.8); `runNow` predicate; K4b test updates | 1 (single paths, account contention, deadline incl. legacy start crossing `D`, Harness-only), 2 (mapping and limit change), 4 (except inherited keys; incl. fresh direct keys and G through provider entry), 5 (incl. delayed spawn and the wrapper exec window), 6 (boot, barrier, classification incl. unitless owners, recovery failover under compat), 8, 11 |
| qcq-04c | Group open, candidate grants, group settlement on drops, the legacy loser outcomes and the loser drain, group recovery (2.7, 2.8.2) | 1 (parallel), 3 (incl. legacy loser outcomes, pool contention, fresh candidate keys, the loser drain with a pending cancel and an already-live loser), 5 (race loser), 6 (group recovery) |
| qcq-04d | Failover, handoff, restart and resume through W, R and G as recorded intent; successor intent and inherited keys (2.5.1, 2.9); first-enable reconciliation by unit, with `occupies_account` (2.8.2 step 3); delete the compat writes; flip `ACCOUNT_ENFORCEMENT_READY`; config-enabled end-to-end test | 7 (incl. boot-time failover, first enable by unit, regrouping, inherited keys, no compat write), 1 (allowlist asserts R or G on every path) |
| qcq-05 | Window bound and rechecks in the commit, after qcq-04b | 9, 10 (incl. between the hooks, the positive control and the negative mutation) |

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

## 8. What each slice review must check

Revision 6 replaces the whole-design checklist with a per-slice one. The reviewer of a slice PR
checks the code and tests in that PR against the sections it implements (section 6), runs the
slice's tests in section 5, and blocks only on a finding the slice can reach. A finding that belongs
to a later slice is recorded as a note for that slice's PR and does not block.

For every slice:

1. The diff matches the packet sections the slice owns; where they disagree, the reviewer says which
   is wrong.
2. Every test the slice owns in section 5 exists, fails on the mutation it names, and passes.
3. With `enforce: false`, the K4b outcomes are unchanged apart from section 2.13, shown by the demo
   captures.
4. No path can configure `enforce: true` before qcq-04d.

Per slice:

- **qcq-04a.** The migration applies over 001 to the previous migration, classifies every row of
  section 2.3.1 (including 3b and released-claim owners) and aborts by name on anything else;
  `pragma_foreign_key_check` is clean; the triggers of section 2.3 reject every write in both
  directions; each claim reader is per attempt and keeps the units check; the compat attempt is
  written before the K4b claim in the wake transaction; the ownership-only commit is the statement
  before each credentialed call, and the allowlist test finds every call by declaration; the
  session-terminal rule drops `held` attempts; weak settlement uses only `never_entered`,
  `task_terminal_unverified`, `boot_unverified`, `operator_confirmed`, and `stream_closed_unverified`
  where K4b releases a non-terminal task with no owner (section 8.1).
- **qcq-04b.** The strong proofs and their order (2.6.1), the full commit and deadline (2.4.1), W, R
  and G as the only runtime claim writers (2.5.2), the barrier and boot table (2.8), the Harness-only
  refusal (2.2) and test 11.
- **qcq-04c.** Group grants, settlement on drops, the legacy loser table and the drain (2.7), group
  recovery.
- **qcq-04d.** Recorded failover intent, inherited keys, first enable by unit with
  `occupies_account`, no compat write left, and the flipped constant.
- **qcq-05.** The rechecks in the commit and the positive control (section 3, tests 9 and 10).

### 8.1 qcq-04a as built

Where the 04a code and the sections above differ, the code is what the slice review checks against,
and these notes say why:

1. **Settlement at a non-terminal release point.** K4b releases a claim at a terminal task *or* when
   no owner row remains (`releaseIfIdle`, the sweep, the autopilot park). The first is
   `task_terminal_unverified`. The second is an attempt whose run, session or dispatch no longer owns
   execution while the task is not terminal (the run ended and the task parked); 04a settles it
   `stream_closed_unverified`, since that is the event that did happen there. Both are weak, pool-only
   proofs, allowed by `trg_attempt_weak_proof`; the release timing is K4b's.
2. **A legacy start whose provider call threw.** With no run row, K4b sees no owner. An entered
   (`starting`) direct or candidate attempt whose adapter call **rejected** (no handle) is settled
   `stream_closed_unverified` when `startTask` throws; a `held` one is dropped `never_entered`. A start
   that failed **after** the adapter returned a handle (the run-row insert, the bind) has a provider
   nothing consumes: the catch cancels the handle, ends any run row it wrote, and drains the stream
   for up to 10 s. The attempt settles `stream_closed_unverified` only once the stream ended;
   otherwise it is `ambiguous` and keeps its slot until the boot proof (04b adds `confirm-stopped`).
   A dispatch's attempt is left to the dispatch's ambiguity. Every attempt and claim reason is
   redacted before it is written (#264 review finding 5).
3. **The autopilot park** releases exactly as K4b did: a `held` attempt drops `never_entered`
   whatever still points at it, and an entered attempt whose session has ended settles like any
   idle one (note 1). The timing differs by path: an early refusal drops the `held` attempt at the
   park, but on a Harness final-check refusal `terminalize` has already dropped it and released its
   claim (the session-terminal rule) before the detached callback parks the task (#264 review).
4. **Guard form.** The commit's result is kept for the bind that follows the adapter call, so each
   credentialed call is preceded by `const entry = enterProvider(...)` (or `store.enterProvider`) and
   `if (!entry.ok) throw ...`. The allowlist test accepts that two-statement form and the one-statement
   `if (!enterProvider(...).ok)` form, and fails an unguarded or ignored commit.
5. **`starting` to `live`.** A Harness attempt becomes `live` when the session's handle is acknowledged:
   `ackHandle` (the returned provider reference) or, for a provider that reports its reference only
   with its first event, the STARTING to RUNNING transition, in the same write. A legacy one when its
   run row is written. (#264 review: as merged, `ackHandle` moved only the session.)
6. **Upgrade backfill.** Runs are classified Harness by `execution_request_id` (005 populated
   `session_state` on legacy rows too). Whether a dispatch-bound run has ended decides rows 1 and 2
   whatever its task's state, so a terminal task's open run with a released claim is row 1 with zero
   units (`k4b_released_before_upgrade`); only runs no dispatch carries skip terminal tasks. Extra open
   runs on one single task are kept as owners (section 2.3.1), and at boot a legacy run row (no
   `execution_request_id`) is never an owner, whatever its `ended_at`, because the process that
   consumed its stream is dead: the boot sweep settles them `boot_unverified` on every task state,
   not only the running tasks boot reconcile ends. A dispatch reserved before the upgrade with no
   claim gets its compat attempt lazily: in its route transaction, for a fresh or a replayed saved
   route, at the `start_attempted` mark, or at Harness session insert (#264 review findings 1 to 3).
7. **Account config.** `scheduling.accounts` is parsed beside, not inside, the advisory
   `SchedulingPolicy` contract. 04a resolves keys but writes none: every 04a attempt has
   `account_source = 'none'` (migrated ones `unresolved`). The strong-exit-evidence check for
   `enforce: true` arrives with the units of 04b; until 04d the build gate refuses `enforce: true`
   first.
8. **Events.** `attempt.entered`, `attempt.dropped`, `attempt.settled` and `attempt.ambiguous` join
   `scheduler_events` as durable history. The live stream keeps its pre-04a outcome: `publish` sends
   the newest event that is not `attempt.*`, so a settlement written after its release does not
   displace `resource.released` (#264 review finding 6).
9. **Review fixes (#264, Codex).** Operator run-now with `confirmNoLiveOwner` refuses on a run of the
   ambiguous dispatch itself, not on any run of the task, so an ended handoff predecessor no longer
   strands an entered continuation whose start rejected (finding 4). Migration 059 closes three write
   paths: an owner moved by `task_id` or `candidate_slot` beside an unrelated queued row, a rewrite of
   `claim_id`, `claimed_at` or `generation`, and an `INSERT OR REPLACE` that would delete a claim
   without its DELETE trigger. The allowlist resolves the callee by symbol, so bracket, destructured
   and aliased calls are sites. The early launch check reads every requirement the attempt carries.

### 8.2 qcq-04b part 1 as built

04b ships in two PRs. Part 1 is the exit proofs of 2.6.1, the release points of 2.13 item 4, and the
operator path. Part 2 is W, R and G with the grant pass (2.5), the Harness-only refusal (2.2), the
full commit (account re-resolve, autopilot check, deadline `D`) and the launch barrier (2.8). Part 1
writes no account claim, so `trg_attempt_weak_proof` has nothing to refuse yet beyond the 04a
trigger tests. Where part 1 and the sections above differ:

1. **Who gets a unit.** Only a Harness attempt whose adapter declares `scopedSpawn`, on a lane where
   the host has strong evidence (`ExitEvidence.unavailable(lane)` is undefined). The plane lane needs
   cgroup v2, a user manager reachable through `XDG_RUNTIME_DIR` and `systemd-run` on PATH. The agent
   lane needs `execution.agentUser`, the agent's `user@<uid>.service` cgroup (lingering) and a
   `/proc` without `hidepid`. Everything else is pool-only and settles `stream_closed_unverified`.
   `AGENT_PLANE_PROVIDER_SCOPES=off` turns units off on every lane, and boot logs the reason per lane.
   Every legacy run is pool-only.
2. **Reading.** The plane reads `cgroup.events` under the owning user's manager, never `systemctl`,
   so it reads the agent's scope without privilege. A name that is not `aos-(att|run)-<id>.scope` is
   `unreadable`, and `unreadable` proves nothing.
3. **Proof order** (`AttemptStore.settleEntered`): `host_rebooted` first, for an attempt another
   incarnation entered on a different, known `boot_id`. Then, with a unit: `populated` registers
   it (`provider_unit_seen_at`) and holds; `empty` or `absent` once registered is `cgroup_empty`.
   Never registered, `empty` or `absent` is `unscoped_exit` only when the spawn path is closed, the
   launcher scan finds nothing, and a second read is still `empty` or `absent` (an empty scope may
   exist before systemd moves the launcher into it: #268 review, note 10). Without a unit, the end of
   the provider stream (`stream_closed_unverified`), or `boot_unverified` for a dead incarnation's
   attempt.
4. **Spawn path.** In this incarnation, the runner registers the adapter's `spawnClosed` once its
   start call settled; until then the path is open. For the Claude adapter, `spawnClosed` is true
   when the query stream has ended and the CLI either never spawned, exited, or failed to spawn. The
   fake spawns nothing, so its path closes with its stream. A dead incarnation's spawn path is closed.
5. **Stop and ambiguity.** A task cancel moves every entered attempt to `stopping` (`stopTask`) and
   keeps its claims. An attempt asked to stop, or whose execution ended, with no proof after
   `stopEvidenceMs` (65 s) becomes `ambiguous` and writes `attempt.stop_unconfirmed` with its
   claims. A wall-clock jump can only bring that forward: it never writes a proof. A plane-lane stop
   (`systemctl --user stop`) kills everything in the scope, including hook daemons the CLI started.
6. **Watching.** An entered attempt with a unit is re-read every second from entry, and again after
   its session ends, until it is final or `ambiguous`; from `ambiguous` the sweep and the operator
   settle it. A dead incarnation's provider found running at boot is stopped and watched (2.8.2 row 13).
7. **Release points.** A task's terminal transition alone releases nothing that entered. A legacy run
   is released in the transaction that writes its `ended_at` after its stream drained; a Harness
   session at `terminalize`. The K4b tests that expected release at the terminal transition now
   expect release at the stream's end.
8. **Operator path (API 2.20, capability `commands.write`).** `POST /api/attempts/:id/confirm-stopped`
   writes `operator_confirmed`; it answers 409 `unit_populated` with the stop link while the unit reads
   populated, and 409 `attempt_live` while a live execution still owns the attempt.
   `POST /api/attempts/:id/stop-unit` moves the attempt to `stopping` and stops its unit; the proof
   follows on the next read. Run-now with `confirmNoLiveOwner` uses the same check.
9. **Not exercised here.** The real scope on a systemd host (OCI), and the agent wrapper's stop on
   that host. The cgroup and `/proc` reads are tested against fake trees, and the Claude adapter's
   `systemd-run` argv against a recording stub.
10. **Review fixes (#268 Codex review, FAIL, fixed in their own PR).** One regression test per finding
    in `apps/api/test/qcq-04b-part1-review.test.ts`.
    1. *Registration first.* `cgroup_empty` needs `provider_unit_seen_at`. A never-registered empty
       unit is treated like an absent one (note 3).
    2. *Incarnation identity.* Migration 060 records, per entry, the plane incarnation
       (`entered_incarnation`, a row in `plane_incarnations` with pid, `/proc/<pid>/stat` start time
       and `boot_id`). `AttemptStore.incarnationOf` answers here, alive or dead. Another open handle
       in this process, or another process whose pid still has the recorded start time on this boot,
       is alive, and its attempts are left to it (the sweep and confirm-stopped do nothing). A start
       time the plane cannot read is alive. A different boot, a gone pid, a reused pid, or this
       process's own pid with no open handle is dead. Rows from before 060 read as dead, as before.
    3. *Incomplete reads prove nothing.* A cgroup search that hits a stat or readdir error other than
       ENOENT (ENOTDIR included, round 2) is `unreadable`, and a launcher scan that cannot read some process's argv
       reports the launcher alive.
    4. *Launch-time manager.* Entry records `provider_unit_owner` (`{ uid, user?, group?, wrapper? }`,
       `ExitEvidence.unitOwner(lane)`). Reads, the launcher scan and stops (recovery and
       `stop-unit`) use it, not today's agent user. The scan matches `run-as-agent`, the recorded
       wrapper and the configured wrapper, by basename or full path.
    5. *The provider stream decides.* Entry opens the attempt's provider stream in this incarnation.
       It closes when the adapter call rejects, an iterator `next()` finishes or fails, or
       `return()` settles: the runner reports it through `providerStreamClosed`, the legacy path at
       `settleRun`, `startFailed`, a rejected call (`legacyCall`) and the abandon drain, even a late
       one. While it is open, a unitless attempt is never settled `stream_closed_unverified`: a
       legacy dispatch cancelled with `adapter.start` pending, and a session that ended on the
       `run.ended` grace, both hold their claims until the stream closes. A stream that never closes
       goes `ambiguous` after `stopEvidenceMs`. After an early return (cancel after start, profile or
       isolation failure) the runner drains the stream once the provider tree is terminated.
    6. *confirm-stopped.* Refused `attempt_live` while this incarnation's stream is open on a
       `starting`, `live` or `stopping` attempt, or while another live incarnation holds it.
       `ambiguous` stays the operator's.
    7. *Recovery stop.* A dead incarnation's populated unit is stopped in any entered state
       (`stopping` and `ambiguous` too), once per attempt and incarnation.
    8. *Spawn report.* The exit watch stops at `ambiguous`, but the spawn-closed report stays until
       the attempt is final (`finalize` drops it), so a later `unscoped_exit` is still provable.

11. **Review fixes, round 2 (#272 Codex review, FAIL, fixed on the same branch).** One regression
    test per reproduced failure in `apps/api/test/qcq-04b-part1-review-r2.test.ts` (16, all fail on
    the first fix). Codex did not reproduce findings 1, 6 and 8.
    1. *Pre-060 rows (4).* An attempt with no recorded `provider_unit_owner` is read under today's
       manager, but only a populated read counts: it records that manager and carries on. Empty,
       absent or unreadable proves nothing (the unit may live under the manager it was assigned
       under, which a renamed agent user no longer is), so the attempt waits.
    2. *Stops (4, 7).* `ExitEvidence.stopUnit` resolves true only when a command was issued. The
       wrapper is the recorded one (`agentStopLauncher`), also with `execution.agentUser` removed;
       the plane lane never stops another uid's unit. `Scheduler.stopUnit` issues first, and
       answers 409 `stop_unavailable` (nothing moved) when no manager could be asked. The boot
       reaper always runs, stops through the recorded owner, and shares `claimRecoveryStop` with the
       proof test, so one attempt is stopped once per incarnation; a stop that was not issued is
       claimed again on the next proof test. A unit id with no attempt is stopped as before.
    3. *Legacy stream (5).* `consume` iterates by hand: only the iterator's own end or failure marks
       the stream closed. A failure while recording an event cancels the run and drains the stream in
       the background, reporting `providerStreamClosed` when it ends (`streamClosed(runId, false)`
       keeps the stream open meanwhile). An entered direct or candidate start with no run row is
       owned only while this incarnation holds its stream, so a drain that ends after the abandon
       deadline settles the attempt instead of leaving it `ambiguous`. `legacyCall` takes a thunk,
       so a synchronous throw from `adapter.start` is a rejected call.
    4. *Harness stream (5).* `closeProviderStream` asks `return()` at once, beside any pending
       `next()`. The stream is closed when that `next()` finishes or fails, or `return()` settles
       without a yielded value (`done !== false`) or fails. Otherwise it is read to its end. A close
       that races the provider call waits for the handle. A synchronous `adapter.start` throw is a
       rejected call (`callOf`). The exit watch now also covers unitless attempts, and `awaitProof`
       starts it, so a held-open stream reaches `ambiguous` (and the operator can confirm it)
       without a scheduler sweep.
    5. *Overlapping boot (2).* `HarnessRecovery.reconcileOnBoot` skips, and `voidAllLeases` keeps the
       lease of, a session whose entered attempt a live incarnation holds (`liveElsewhere`, wired to
       `heldByLiveIncarnation`). A session that has not entered needs no guard: the entry commit
       requires a current lease. A zombie or dead process (`/proc/<pid>/stat` state `Z` or `X`)
       counts as gone.
    6. *Reads (3).* ENOTDIR is incomplete everywhere (cgroup search, launcher scan, start time).
    7. The two runtime-conformance tests that timed out at 5 s on a slow machine now run with a 30 s
       timeout.

### 8.3 qcq-04b part 2a as built

Part 2 ships in three PRs. Part 2a is W, R and G with the grant pass (2.5) and the Harness-only
refusal (2.2) on the scheduler's single-path dispatch (a wake, then `Scheduler.start`). Part 2b brings
direct `/start` and autopilot through R and adds the full commit (account re-resolve, autopilot
check, deadline `D`, 2.4.1). Part 2c is the launch barrier, boot order and classification (2.8).
Account enforcement stays refused at config load (`ACCOUNT_ENFORCEMENT_READY` false). The tests turn
it on by setting `config.accounts` directly, the seam of 2.12. Where part 2a and the sections above
differ:

1. **W writes no claim.** The wake consumes the condition, inserts the `reserved` dispatch and creates
   the attempt `queued`, with `account_source = 'pending'`, bound to that dispatch. Its known
   requirement is the condition's pool. Units in use are live claims plus the requirements of
   pending attempts (`Scheduler.inUse`), so the gap between W and R never lets a second wake take a
   slot. The gate W applies is K4b's `resourceGate` (readiness, FIFO front, free units), with
   `inUse` in place of `claimed`.
2. **R is in the route transaction.** It runs in both the fresh route and the replayed one. It
   resolves the account for (chosen assistant, `runAs`) only while `accounts.enforce` is on;
   otherwise the key is null and `account_key` stays NULL. On the legacy path, an account key refuses
   with `account_requires_harness`: the attempt is `dropped` (`never_entered`), the dispatch is
   re-parked with that reason, and the task goes to `WAITING_INPUT` `intervention_required`. Otherwise R
   writes the route and the account requirement (`queued_at` = the attempt's `queue_key`), then
   grants every requirement or none. With no grant, the dispatch re-parks `resource_wait` without
   spending a wake. The attempt stays `queued` with its route, unbound from the dispatch, and a new
   `resource` wait names it (`wait_conditions.attempt_id`). Its resource is the pool if there is
   one, otherwise the account key. A replayed route whose attempt is already `held` changes nothing.
3. **G.** `Scheduler.grantPass` walks every `queued` dispatch attempt in the order (`queue_key`,
   `task_id`, `candidate_slot`) in one immediate transaction. A pending attempt closes its known
   resources. A routed, ready attempt is granted when every requirement has free units, none is
   closed and it is at its resource's K4b queue front. Otherwise it closes them. G's transaction order
   is 2.5.2's: path recheck, consume the wait, insert the `reserved` dispatch carrying the attempt's
   `routing_decision_id`, bind and `held`, claims with that dispatch, task `WAITING_RESOURCE` →
   `ROUTING`, then `dispatch.reserved`. The dispatch then goes through `start`'s replay branch, so it
   launches on the route it waited for. G runs on every release, on every tick, and when a wake
   reaches a wait that names an attempt. Such a wake never consumes that wait.
4. **Enforcement off is K4b.** There is one requirement (the pool). W gates as today and R always
   grants, so who runs, and in what order, is unchanged. Only the claim moves after routing
   (2.13 items 1 to 3). Two resource-slots tests changed for that reason:
   - A cancel between reservation and start finds no claim, and the attempt is `dropped`
     (`never_entered`).
   - A restart at the reservation boundary finds a `queued` pending attempt and no claim before
     reconcile.

   The handoff helpers park at `routed` instead of `reserved`.
5. **An account attempt without a unit.** 2.2 requires strong exit evidence for every member before
   `enforce: true` loads. That config check lands with the gate (04d); behind the test seam it is
   not applied. So `settleEntered` never offers a weak proof to an attempt that has an `account_key`
   or ever held an account claim. Instead it waits (`ambiguous` after `stopEvidenceMs`, claims held)
   for a strong proof or the operator. Without this, `trg_attempt_weak_proof` would fail the
   session's terminal transaction and park the task `harness_error`.
6. **Scheduler.stop** also removes the scheduler's release listener, so a stopped scheduler no longer
   reacts to releases. The tests that build their own scheduler stop the server's first.
7. **Not in 2a.** Direct `/start`, autopilot and compare/race candidates still take the 04a path:
   their attempt is created `held` at the start and is pool-only. The wake budget's re-route
   compare-and-set (2.5.3), the full commit, the boot-time re-resolve and first-enable
   reconciliation are 2b and 2c.
