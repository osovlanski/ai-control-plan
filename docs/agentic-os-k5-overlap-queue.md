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

Immediate creation and promotion call the **same** private helper,
`createOccurrenceTask(intent, occurrenceAt)`, so the two paths cannot drift
apart on what a `TaskIntent` produces — `requirements` included. `repository`
in the intent is path intent only: the task it produces still gets its own
fresh branch/worktree identity at creation, exactly like any other task. A
schedule never freezes a task-generated branch into itself.

**Fail closed on a missing or corrupt snapshot.** A row with `outcome =
'queued'` is schema-guaranteed to carry a non-NULL `intent_json` (§4), so a
queued row that fails to parse is a defect, not a legitimate gap. Promotion
never falls back to the schedule's *current* intent in that case — doing so
would silently rewrite what already-queued work is claimed to have run.
Instead it throws before touching the row, which rolls back the whole
promotion transaction: the occurrence stays `queued`, auditable, and un-
promoted, and the caller's `onError` observes a message naming the schedule
and occurrence.

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

A schema `CHECK` makes exactly these four rows the only representable ones —
not a convention but an enforced invariant:

```sql
CHECK(
  (outcome = 'queued'  AND queued_at IS NOT NULL AND intent_json IS NOT NULL AND task_id IS NULL     AND promoted_at IS NULL)
  OR (outcome = 'created' AND queued_at IS NULL     AND promoted_at IS NULL     AND task_id IS NOT NULL)
  OR (outcome = 'created' AND queued_at IS NOT NULL AND promoted_at IS NOT NULL AND task_id IS NOT NULL)
  OR (outcome IN ('skipped-overlap','skipped-catch-up','skipped-disabled')
      AND queued_at IS NULL AND promoted_at IS NULL AND task_id IS NULL)
)
```

Because of this, promotion cannot move a row through outcome/promoted_at/
task_id one column at a time — the transient state "`created`, no `task_id`
yet" would itself violate the CHECK. §6 writes all three together, in the
task's own creation transaction, in one statement.

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
  1. front   = oldest 'queued' occurrence for this schedule       (FIFO, §2)
  2. guard   = schedule enabled AND scheduler enabled AND
               this schedule has NO non-terminal occurrence task  (§10)
  3. intent  = parse front.intent_json, or THROW (fail closed, §3)
               -- never falls back to the schedule's current intent
  4. task    = createOccurrenceTask(intent, front.occurrence_at)  (§3)
               -- tasks.create(...) + attach(task, { kind:'time',
               -- notBefore: occurrence_at }) — the EXISTING K1 wake path;
               -- K5 still owns no execution path
  5. CAS     = UPDATE ... SET outcome='created', promoted_at=?, task_id=?
               WHERE schedule_id=? AND occurrence_at=? AND outcome='queued'
               -- 0 rows changed → someone else won → THROW (never commit an
               -- orphaned task with no occurrence pointing at it)
  6. UPDATE schedules SET last_fired_at, last_task_id (display only)
COMMIT
```

`outcome`, `promoted_at` and `task_id` move together in the single UPDATE at
step 5, never one column at a time: the schema `CHECK` (§4) does not allow a
`created` row with no `task_id`, so nothing in this transaction may ever write
that combination, even transiently within it.

**The crash boundary is the commit, and there is only one.** SQLite commits
steps 3–6 together or none of them, so neither failure mode is reachable:

- **A — task created but the occurrence is still promotable.** Impossible: the
  task in step 4 and the CAS in step 5 are in the same transaction. A crash
  before the commit rolls back the task with the occurrence.
- **B — occurrence marked promoted but no task exists.** Impossible for the same
  reason, in the other direction.

Step 5 is also the concurrency answer. SQLite serialises writers, so of two
racing promoters exactly one sees `outcome = 'queued'` and flips it; the other
throws and rolls back its own just-created task, promoting nothing. A cron
tick, a terminal event, the fallback sweep and boot recovery all call the same
function and all lose to each other the same way.

Step 4 reuses `Scheduler.attach`, which is how an occurrence has always been
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
| `overlap` → `skip` | none — the backlog stays durable, keeps its order and still drains oldest-first; `overlap` governs only what happens to the *next* occurrence, and never lets it overtake the backlog (§10) |

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

### An existing backlog outranks every later occurrence, in both modes

Firing asks two durable questions, never `last_task_id`:

```
busy    = this schedule has a non-terminal occurrence task
backlog = this schedule has a queued occurrence
```

`overlap` decides what happens to the **new** occurrence, and nothing else:

| `overlap` | `busy` or `backlog` | the newly-due occurrence |
|---|---|---|
| `queue` | no | created immediately |
| `queue` | yes | `queued`, at the back of the line |
| `skip` | no | created immediately |
| `skip` | yes | `skipped-overlap`, no task |

A queued occurrence is work the operator has already been told is accepted, so
it outranks every instant that comes after it — including under `skip`, where
the older queued occurrence still drains first and the newer one is recorded as
skipped. An `overlap` edit is future policy: it changes how the next occurrence
is treated and rewrites no queued row, no `occurrence_at` and no snapshot. This
holds wherever `drain()` runs relative to firing; it is a property of the firing
decision, not of tick ordering.

### Catch-up: the newest eligible miss, chosen independently of the audit cap

One reconciliation at `now` reconciles **one** downtime interval:

```
windowStart       = now - catchUpWindowMinutes
latestEligibleMiss = the newest real local occurrence in [max(nextFireAt, windowStart), now]
```

That occurrence is the only candidate that may fire, be enqueued under
`overlap: queue`, or become the single `skipped-disabled` of a disabled period.
It is found by walking **backwards from `now`**, so it is the same occurrence
whether the outage missed three instants or three thousand. Older eligible
misses never become tasks and never enter the queue; they are audit history.

**`MAX_CATCH_UP_ROWS` (200) is an audit cap only.** It bounds how many older
misses are recorded as `skipped-catch-up`, so a per-minute schedule cannot write
a row per instant after a long outage. It cannot change which occurrence runs.
Consequently **per-occurrence skipped history is deliberately bounded**: after
an outage longer than the cap, the oldest misses have no individual row. No
queued work is invented to represent them.

Walking *forwards* and taking the last row enumerated is what made the cap
decide execution: a per-minute schedule down for a day resynced onto its 200th
miss, stayed overdue, and turned one downtime interval into a fresh durable
occurrence on every tick.

**After reconciliation `nextFireAt` is strictly greater than `now`**, unless the
cron has no future occurrence at all. `nextFireAt` is recomputed from
`latestEligibleMiss`, and there is by construction no real occurrence between it
and `now`, so the whole downtime interval is behind the schedule. Repeating the
same reconciliation at the same `now` — another tick, a restart, a cold process
against the same database — therefore creates no task, no queued occurrence and
no further audit row.

In queue mode the one legitimate catch-up occurrence is *appended behind* an
existing backlog, preserving FIFO. Queue mode never replays a missed cron
series.

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

`GET /api/schedules/:id` returns two occurrence views, not one:

- `occurrences` — recent history, newest first, capped at 50. Good for "what
  just happened", wrong for "what's next": once a backlog outgrows the page,
  the queue HEAD (the oldest queued row, next to promote) is exactly the row a
  newest-first cap pushes out first.
- `queuedOccurrences` — the FIFO backlog itself, oldest first, capped but never
  truncated from the front, so position 1 is always in the response regardless
  of how large the backlog or the schedule's total history has grown. Same
  server-computed `queuePosition`; the browser still sorts nothing.

Schedule **creation** still lives in Cockpit's Schedule tab (K6); this repo's
operator UI has no intake form for one and does not gain one here. What it does
have is the Orbital Inspector's Schedule tab, and that is where the queue is
rendered: each schedule with its cron, timezone, next fire, active occurrence
task and backlog count, a Skip/Queue selector that issues the ordinary
`PATCH /api/schedules/:id`, and its occurrence list — the queue head from
`queuedOccurrences` first, then recent non-queued history — labelled with what
actually happened: "Queued — waiting for the previous occurrence" with its
position, "Promoted from the queue" with the promotion time and task, plain
"created" with its task, and the unchanged `skipped-overlap`. Every one of those
values arrives decided from the reads above; the browser sorts nothing.

The readout runs its own bounded schedule refresh while mounted, at the same 4 s
cadence the rest of the Inspector panel uses — a matching interval, not a shared
loop — so a promotion, a terminal task, a new queued occurrence or the
fallback sweep — none of which the browser initiates — eventually becomes
visible without remounting the panel; an overlap-mode change still refreshes
immediately, on top of that poll.
