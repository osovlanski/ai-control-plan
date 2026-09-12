# Agentic OS K5 — `overlap: queue`

The one capability `docs/agentic-os-kernel-services.md` §4.2.6 deferred out of K5.
Everything else about K5 — cron evaluation, IANA timezone handling, DST, atomic
firing, unique occurrences, catch-up bounds, the disabled-scheduler protocol, the
single shared timer — is unchanged and is not restated here.

`overlap: "skip"` keeps its shipped behaviour exactly. No existing bug was found
in it, so nothing about it changed except which query answers "is a previous
occurrence still running" (§10 below), which is behaviour-equivalent.

---

## 1. What a queued occurrence is, durably

A row in `schedule_occurrences` with `outcome = 'queued'`.

There is no queue table, no queue id and no second scheduling system. The
occurrence row **is** the unit of queued work, because the occurrence row was
already the durable unit of scheduled work.

```sql
schedule_occurrences (
  schedule_id, occurrence_at,          -- PRIMARY KEY: the identity (unchanged)
  fired_at,
  outcome,                             -- + 'queued'
  task_id,
  queued_at    TEXT,                   -- NEW: when it was enqueued. Never cleared.
  promoted_at  TEXT,                   -- NEW: when it became a task.
  intent_json  TEXT                    -- NEW: the intent snapshot (§3).
)
```

`(schedule_id, occurrence_at)` is still the primary key, so a duplicate tick for
the same occurrence cannot create a second queue entry any more than it could
create a second task. `INSERT OR IGNORE` is still what a repeated tick hits.

## 2. Immutable identity

`(schedule_id, occurrence_at)` — the existing occurrence identity, unchanged.

Queue order is `ORDER BY occurrence_at ASC` over `outcome = 'queued'`. Because
`occurrence_at` is half of the primary key it is unique per schedule, so
`occurrence_at` is already a total order and **no tie-break is needed**. Nothing
else — not `fired_at`, not `rowid`, not task duration, not a restart — takes part
in the ordering.

## 3. Intent snapshot — what a queued occurrence preserves

A queued occurrence copies the schedule's `intent_json` into its own
`intent_json` at the moment it is enqueued, and the promotion creates the task
from **that** copy.

This is the invariant:

> An occurrence produces the task its schedule described **at that occurrence's
> instant**, whenever it actually runs.

```
09:00  occurrence queued        → snapshot: goal A
09:05  operator edits schedule  → schedule now says goal B
09:10  the running task settles → 09:00 is promoted and runs goal A
10:00  next occurrence fires    → goal B
```

The snapshot is `TaskIntent` and nothing else: goal, constraints, repository,
profile, requirements and the requested **selectors** in `overrides`. It is the
same object shape K5 already stores on the schedule (I-S1), so it carries no
resolved assistant, provider, model, routing decision or K13 recommendation, and
freezing it freezes no execution choice. See §8.

An occurrence that fires immediately (no queue involved) does **not** write a
snapshot: it reads the live schedule intent exactly as it does today, and its
`intent_json` stays `NULL`. Snapshots exist to survive a delay; an occurrence
with no delay has nothing to survive.

## 4. Occurrence provenance — the smallest truthful representation

`outcome` alone cannot carry this: an occurrence that was queued and later
promoted really did produce a task, so its outcome really is `created`, but
saying only `created` would claim a task was made at the cron instant when it
was not. The two new timestamps carry the rest, and are **never cleared**:

| Operator question | `outcome` | `queued_at` | `promoted_at` | `task_id` |
|---|---|---|---|---|
| created immediately | `created` | NULL | NULL | set |
| queued because of overlap | `queued` | set | NULL | NULL |
| promoted from the queue | `created` | **set** | set | set |
| skipped (`skip` mode overlap) | `skipped-overlap` | NULL | NULL | NULL |
| skipped by the catch-up bound | `skipped-catch-up` | NULL | NULL | NULL |
| skipped while the scheduler was off | `skipped-disabled` | NULL | NULL | NULL |

`queued_at` surviving promotion is what keeps the audit honest: "this task was
created at 09:10 for the 09:00 occurrence, which had been queued since 09:00."

Rows written before this slice keep `NULL` in all three columns. No historical
queue state is invented for them — a pre-existing `created` row means "created
immediately", which is what it was.

## 5. Crash recovery

The queue is a query, not a cache:

```sql
SELECT * FROM schedule_occurrences WHERE schedule_id = ? AND outcome = 'queued'
ORDER BY occurrence_at LIMIT 1
```

Nothing about the queue lives in memory, so a crash loses nothing and recovery
is not a separate mechanism. `reconcileOnBoot()` already ends in `tick()`, and
`tick()` drains (§6), so boot promotes exactly what an uninterrupted process
would have promoted.

## 6. Promotion protocol — exactly one, in one transaction

Promotion is one synchronous `better-sqlite3` transaction:

```
BEGIN
  1. front  = oldest 'queued' occurrence for this schedule       (FIFO, §2)
  2. guard  = schedule enabled AND scheduler enabled AND
              this schedule has NO non-terminal occurrence task  (§10)
  3. CAS    = UPDATE ... SET outcome='created', promoted_at=?
              WHERE schedule_id=? AND occurrence_at=? AND outcome='queued'
              -- 0 rows changed → someone else won → abort, promote nothing
  4. task   = tasks.create(front.intent_json)                    (§3)
  5. park   = attach(task, { kind:'time', notBefore: occurrence_at })
              -- the EXISTING K1 wake path; K5 still owns no execution path
  6. link   = UPDATE ... SET task_id = ? WHERE (schedule_id, occurrence_at)
  7. UPDATE schedules SET last_fired_at, last_task_id (display only)
COMMIT
```

**The crash boundary is the commit, and there is only one.** SQLite commits
steps 3–7 together or none of them, so neither failure mode is reachable:

- **A — task created but the occurrence is still promotable.** Impossible: the
  CAS in step 3 and the task in step 4 are in the same transaction. A crash
  before the commit rolls back the task with the CAS.
- **B — occurrence marked promoted but no task exists.** Impossible for the same
  reason, in the other direction.

Step 3 is also the concurrency answer. SQLite serialises writers, so of two
racing promoters exactly one sees `outcome = 'queued'` and flips it; the other's
`UPDATE` matches zero rows and promotes nothing. A cron tick, a terminal event,
the fallback sweep and boot recovery all call the same function and all lose to
each other the same way.

Step 5 reuses `Scheduler.attach`, which is how an occurrence has always been
launched. No second task-launch path exists.

## 7. Wake protocol — event-driven, with the existing bounded fallback

**Primary.** `TaskStore.onTerminal` already notifies the scheduler. When the
terminal task is a schedule occurrence task, the same handler queues a drain for
that schedule on the existing microtask (so it runs after the enclosing
transaction commits, exactly as the K4b claim release does).

**Fallback.** `tick()` drains every schedule that has a backlog, immediately
after `fireDue()`. A lost terminal notification therefore costs one sweep, never
permanent starvation.

**No second timer, and no new deadline.** A queued occurrence contributes
nothing to `arm()`. It does not need to: K4b's absolute `nextSweepAt` already
guarantees a sweep at a bounded cadence, and it advances only when a tick
actually happens, so a busy instance cannot postpone it. Adding a queue deadline
would have been exactly the sliding re-arm K4b removed.

Both paths are gated on the global `scheduler.enabled` and on the schedule's own
`enabled` (§9).

## 8. Routing and K13

Queueing calls `routeTask()` zero times, produces zero routing decisions and
zero K13 recommendations — by construction, because queueing creates no task,
and routing is a property of dispatching a task.

A promoted task is an ordinary task on the ordinary path: it is parked on a K1
time wait, woken by the ordinary wake, and routed **at the wake** against live
capabilities, quota and catalog, with the ordinary K13 SHADOW recommendation.
Nothing about the assistant or the model is decided at queue time or frozen in
the snapshot (§3). K13 stays SHADOW; this slice adds no attestation and no
activation surface.

## 9. Schedule edits, enable/disable, delete

**Edits** affect future occurrences only, and already-queued occurrences are
immune to all of them:

| Edited | Effect on a queued occurrence |
|---|---|
| `goal`, `constraints`, `repoPath`, `profile`, `overrides` | none — it holds its own snapshot (§3) |
| `cron`, `timezone` | none — `occurrence_at` is its primary key and cannot move, so its FIFO position cannot move either |
| `catchUpWindowMinutes` | none — the window bounds enumeration of *missed* instants, not the queue |
| `overlap` → `skip` | queued occurrences stay durable and still drain; `skip` governs what happens to the *next* occurrence |

`nextFireAt` is still recomputed from now on every edit, for future occurrences.

**Disable the schedule** (`enabled: false`):

- new occurrences stop (unchanged),
- the already-running task is left alone (unchanged),
- **queued occurrences are kept and are not promoted.** Deleting them would
  destroy work the operator asked for without being asked to; promoting them
  would make "disabled" untrue. Keeping and pausing them is the only option
  that is both.

Re-enabling promotes the oldest queued occurrence on the next drain, if no
occurrence task is active.

**Disable the scheduler** (`scheduler.enabled: false`) stops all automatic
promotion, like every other automatic scheduler action. Operator run-now on an
already-created task is unchanged — it is the same `wake` it always was, and a
queued occurrence is not a task, so there is nothing to run-now on it.

**Delete** — decision: **(A) unpromoted queued occurrences are dropped with the
schedule.**

`DELETE /api/schedules/:id` already cascades the whole occurrence history, and a
queued occurrence is occurrence history. Option (B), rejecting the delete while a
backlog exists, would give the operator a schedule they cannot remove without
first draining work they have already decided they do not want — a new failure
mode in exchange for nothing. Nothing is orphaned: the queue lives entirely in
`schedule_occurrences`, so the existing `ON DELETE CASCADE` is complete.

Tasks the schedule already created are ordinary tasks. They are not cancelled,
then or ever, by deleting the schedule.

## 10. How no-overlap stays guaranteed

At most one non-terminal task may belong to a schedule, in both modes. The
authority is durable occurrence/task state, not `last_task_id`:

```sql
SELECT o.task_id FROM schedule_occurrences o JOIN tasks t ON t.id = o.task_id
WHERE o.schedule_id = ? AND t.state NOT IN ('COMPLETED','FAILED','CANCELLED')
```

read inside the firing transaction and inside the promotion transaction.
`last_task_id` remains what §4.2.6 always said it was: a display field.

This query is now used by `skip` as well. It is behaviour-equivalent there —
under `skip` the newest occurrence task is the only one that can be non-terminal,
because an older non-terminal one would have caused the newer occurrence to be
skipped rather than created — and having one answer to "is this schedule busy"
is what stops the two modes from ever disagreeing.

**Catch-up is unchanged.** `advance()` still enumerates at most one legitimate
missed occurrence per sweep, and still records older misses `skipped-catch-up`.
In queue mode that one legitimate occurrence is *enqueued behind* an existing
backlog instead of being skipped. Queue mode never replays a missed cron series:
the catch-up bound, not the queue, decides how many occurrences exist at all.

**DST is unchanged.** Occurrence calculation is untouched: a nonexistent
spring-forward local instant produces no occurrence and therefore nothing to
queue, an ambiguous fall-back local instant produces exactly one occurrence and
therefore at most one queue entry, and `occurrence_at` is the UTC instant, so
FIFO never compares local wall-clock strings.

## 11. K4b

A queued occurrence holds **no resource claim** and reserves no future capacity.
It cannot: a claim hangs off a dispatch or a session, a queued occurrence has no
task, and a task is where a wait condition and therefore a pool requirement live.

The two FIFOs are separate and are not merged:

- **schedule FIFO** — which occurrence of this schedule becomes a task next.
  Key: `occurrence_at`. Scope: one schedule.
- **resource FIFO** (K4b) — whether a task that already exists gets a pool slot.
  Key: `resourceQueuedAt`. Scope: one pool, across all tasks.

A promoted task acquires a pool requirement only if something later attaches one,
and then it follows ordinary K4b semantics with no privilege from having been
queued.

## 12. API and UI

`overlap` is accepted on create and update, defaults to `skip`, and existing
schedules migrate as `skip`, so default behaviour is unchanged.

Reads expose queue truth, all of it computed in the control plane — the browser
never orders the queue:

- `Schedule.overlap`
- `Schedule.queuedCount` — the backlog, derived at read (never stored: a stale
  backlog number would be worse than none)
- `Schedule.activeTaskId` — the current non-terminal occurrence task, from §10
- per occurrence: `occurrenceAt`, `outcome`, `queuedAt`, `promotedAt`, `taskId`
- per **queued** occurrence: `queuePosition` — 1-based FIFO rank

Schedule **creation** still lives in Cockpit's Schedule tab (K6); this repo's
operator UI has no intake form for one and does not gain one here. What it does
have is the Orbital Inspector's Schedule tab, and that is where the queue is
rendered: each schedule with its cron, timezone, next fire, active occurrence
task and backlog count, a Skip/Queue selector that issues the ordinary
`PATCH /api/schedules/:id`, and its recent occurrences labelled with what
actually happened to them — "Queued — waiting for the previous occurrence" with
its position, "Promoted from the queue" with the promotion time and task, plain
"created" with its task, and the unchanged `skipped-overlap`. Every one of those
values arrives decided from the reads above; the browser sorts nothing.
