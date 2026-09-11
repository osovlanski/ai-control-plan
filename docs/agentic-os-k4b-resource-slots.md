# Agentic OS K4b — durable resource-slot waits

Acceptance record for the K4b slice. Canonical design: [`agentic-os-kernel-services.md`](agentic-os-kernel-services.md)
§4.2.7 (shipped design), §4.2.3 (the wake protocol this reuses), §5.1 (acceptance criteria).

**Status:** implemented and regression-verified. K13 remains in SHADOW; this slice writes no
activation attestation and changes nothing about the running shadow soak.

## 1. Why the deferral could be lifted

§4.2.7 deferred resource slots "until every launch path — legacy `orchestrator.ts`, Harness
`SessionRunner`, parallel compare — shares one reservation/release protocol. Until then a slot
count cannot be honest."

That gate is satisfied on current `main`:

- `orchestrator.startTask()` is the sole launch funnel. The legacy path, the Harness bridge, the
  dispatch-replay path and every parallel/compare competitor enter through it.
- `runs` + `dispatches` is the one durable ownership record both execution paths write, and
  `Scheduler.hasOwner()` already reads it uniformly to decide whether anything owns a task.

So K4b does not need a new per-path reservation hook. It hangs a claim off the ownership record
the plane already keeps, which is what makes the count honest rather than advisory.

## 2. Resource model

Named generic pools declared in workspace config:

```yaml
scheduler:
  resources:
    gpu: 1
    heavy-build: 2
```

No provider-specific GPU/CPU semantics — a pool is a name and an integer. Capacity is read fresh
at every wake, so an operator edit plus restart is the whole change protocol; there is no pool
CRUD surface and no stored capacity to drift.

Fail-closed at attach: an undeclared pool is rejected, and so is a request above the pool's
capacity (it could never be granted, so it is a config error, not a task that waits forever).

A wait row carries `resource` / `resource_units` **independently of `kind`**. The requirement
outlives any one condition: a task that claimed a slot and then re-parks on quota or yields on
context still needs that slot, so the successor condition carries the requirement forward and must
re-acquire. `kind: "resource"` means the slot is the only thing the wait is for.

## 3. Claim / release protocol

**Claim.** Inside the existing `wake(taskId, generation, actor)` reservation transaction, and only
there:

```
wake(taskId, expectedGeneration, actor)                        ← one transaction
  generation CAS · WAITING_RESOURCE · settled predecessor · no open dispatch
  if the condition names a pool:
      capacity (config) − SUM(live claim units)  ≥  requested units
      this task is READY (§4.1) and is the FIFO front of that pool's queue (operator may skip the queue)
      otherwise: visible stale no-op, or expire to WAITING_INPUT if unsatisfiable
  consume condition · INSERT dispatches(reserved) · INSERT resource_claims · → ROUTING
COMMIT
```

The capacity sum and the claim insert are in the same synchronous transaction as the dispatch
reservation, so two concurrent wakes cannot both observe the last slot as free. Two durable
constraints back it up: `uq_claim_live` (one live claim per task) and `uq_claim_dispatch` (one
claim per dispatch, ever). No process-local lock is load-bearing — single-process SQLite ownership
(§4.2.8) is. Crash at the boundary leaves either both the claim and its dispatch, or neither.

**Release** is one ownership test rather than a list of call sites:

```
releaseIfIdle(taskId): release the live claim when
    the task is terminal                       (it can never run again)
 OR hasOwner(taskId) is false                  (no live session, no open dispatch)
```

`hasOwner` is the same test `WAITING_RESOURCE` is defined by (CR-16), so a leak is not
expressible: every park, abort, cancel, settle and boot path already ends with no owner. It is
called from the task-terminal hook, the quota and context-yield parks, `repark`, boot
reconciliation and the timer sweep — the sweep bounding any missed event to one tick.

Per lifecycle outcome:

| Outcome | Claim |
|---|---|
| `COMPLETED` / `FAILED` / `CANCELLED` | released (terminal: the task can never run again) |
| approval / verification pause | **held** — a paused session is still a live owner |
| healthy context yield (K11) | released; the continuation condition carries the requirement and re-acquires |
| quota re-park (K2) | released; the quota condition carries the requirement and re-acquires |
| `WAITING_INPUT` (operator) | released once no session is live; re-acquired on the next wake |
| handoff | held while the session is live, released when it settles |
| failed start / no candidate re-park | released with the dispatch |
| start ambiguity | **held** until the recovery window or operator confirmation settles it |
| crash recovery | swept by the boot reconciliation using the same ownership test |

Release on a start-ambiguous re-park follows exactly the evidence the re-park itself acted on (no
session row on the Harness path — a fresh Harness start always persists a session before calling
the provider — or an operator-confirmed non-start on the legacy path). It never guesses that a
provider is idle.

**Known ceiling.** A task that goes terminal while its provider is still winding down releases its
slot at the plane's terminal boundary, not the provider's. The plane has no owner at that point,
and holding the slot against a provider that may ignore cancellation would strand it indefinitely.

## 4. Fairness

Durable FIFO by **requirement age** (`resource_queued_at`, `task_id` tie-break) among the conditions
naming that pool **whose other preconditions are already satisfied**.

### 4.1 Readiness — who is in the queue

One side-effect-free rule, `Scheduler.resourceReady(condition)`, answers "may this requirement
compete for units now?". It drives the FIFO, the grant in `resourceGate`, the pool status and the
per-task readout, so those four cannot tell an operator different stories. Every clause defers to
the authority the wake path already uses — there is no second dependency or quota policy:

| carried by | ready when |
| --- | --- |
| `resource` (pool only) | `not_before <= now` |
| `time` + resource | `not_before <= now` |
| `dependency` + resource | no pending subject, and no failed subject unless the policy is `wake-anyway` |
| `quota` + resource | the retry is due **and** `quotaPlan().quotaBlocked` is false |

The requirement is independent of `kind`, so a task can be at the head of the pool's line while its
dependency is unfinished or its quota evidence still blocks every candidate. Such a requirement
would refuse the slot at every sweep, so leaving it in the queue would hold free capacity idle
behind a task that cannot use it (P1-A). It is therefore out of the queue and out of the grant path,
and reported as `blockedBy: "condition"` rather than as a queue position it does not have.

What that rule deliberately does **not** do:

- A failed dependency under `cancel` / `wait-input` is not decided by the pool. The task's own wake
  performs that transition; until it does, the requirement simply is not competing.
- `quotaBlocked` means *every* candidate this task could use carries a live blocker. Unknown or
  stale evidence is not "blocked", so K2's bounded revalidation (wake, re-route, re-park) is
  unchanged. No eligible candidate at all is not quota evidence either, and still routes and
  re-parks through the existing path.
- An operator run-now skips readiness along with the queue, and never the capacity.

### 4.2 Seniority — where it re-enters

`resource_queued_at` is when THIS requirement started waiting for the pool, which is not when the
condition carrying it was written. Carrying the same pool and the same units across a quota re-park,
a context continuation, a recovery re-park or an operator wait replacement preserves it; a genuinely
different request starts at now; a task with no requirement has NULL. `created_at` is untouched and
still means when that row was written — nothing is falsified to express seniority (P1-B).

Without it, every re-park would mint a new `created_at` and make the same requirement younger than
work that arrived while it was ineligible, so repeated re-parks could lose a place indefinitely.

### 4.3 Remaining properties

- Strict FIFO: a 1-unit request does not overtake a 2-unit front waiter. A large request therefore
  cannot starve, at the cost of deliberate head-of-line blocking.
- No priority scheduler. An operator run-now may skip the **queue** — choosing what runs is an
  operator decision — but never the **capacity**: over-allocation is not something an operator can
  ask for, because the slot count would stop being true.

Evidence an operator can read: the claim rows (who holds what, since when), the
`resource_queued_at` ordering, the pool status split into `waitingTaskIds` (ready, in FIFO order)
and `notReadyTaskIds` (carrying a requirement, held out of the queue), and the `resource.claimed` /
`resource.released` / `resource.unsatisfiable` scheduler events.

## 5. Capacity change

- **Increase:** picked up by the next wake evaluation (release event or timer sweep).
- **Decrease:** never preempts a live claim. New claims wait until usage drops below the new
  capacity.
- **Below an outstanding request** (or the pool undeclared): that wait expires to
  `WAITING_INPUT(intervention_required)` with a `resource.unsatisfiable` event, so one impossible
  request cannot hang every task behind it.

## 6. Scheduler integration

No new timer, no second queue, no new routing entry point:

```
resource release / capacity change
   ↓ notifyResource(pool)            (or the existing ≤60 s timer sweep)
wake(taskId, generation, 'event')    ← the same single wake operation
   ↓
reservation (+ claim) → routeTask() → materialize → start
```

Neither resource waits nor any wait CARRYING a requirement sets the timer deadline (their
`notBefore` is an earliest re-check and is normally already past, which would re-arm the timer at
1 ms: a withheld requirement stays active and due for as long as the pool withholds it, which a
time or quota wait without one never does); the existing 60 s cap sweeps them, exactly as for
dependency waits. A missed release event therefore costs one tick, never a hang.

## 7. Operator surface

- `POST /api/tasks/:id/wait` accepts `{ kind: "resource", resource, units? }` — no new route.
- `GET /api/tasks/:id/wait` and `GET /api/tasks/:id` add `resourceWait` (pool, requested units,
  capacity/availability when known, queue position — 0 when it is not in the queue —, `blockedBy`
  including `condition`, the blocking reason, and the kind of wait carrying the requirement) and
  `resourceClaim`.
- `GET /api/scheduler/status` adds `resources[]`: capacity, claimed units, available units, the
  ready FIFO wait queue (`waitingTaskIds`) and the requirements held out of it (`notReadyTaskIds`)
  per pool.
- Orbital Inspector renders a "Resource slot" panel in the existing schedule tab: pool, requested
  units, availability, queue position, why waiting, claim state, next action. Orbital is not
  redesigned and the Demo B sphere/product visuals are untouched.

Every number above is **derived at read time**. Nothing about occupancy is stored: a persisted
slot count goes stale the moment another task claims, and a stale count is worse than none (the
K9 lesson).

## 8. Schema

Migration `023_resource_slots.sql`, forward-only:

- `wait_conditions` rebuilt (the 015/017 pattern: deferred foreign keys, explicit
  `pragma_foreign_key_check`, then clear the deferral) to widen the `kind` CHECK with `resource`
  and add `resource` / `resource_units`, with `CHECK((resource IS NULL) = (resource_units IS NULL))`
  and `CHECK(kind != 'resource' OR resource IS NOT NULL)`.
- `wait_conditions.resource_queued_at` — the requirement's age, NULL exactly when `resource` is
  NULL (CHECK-enforced). Backfilled to NULL: no row before 023 ever held a pool requirement.
- `idx_wait_resource(resource, resource_queued_at, task_id) WHERE state='active' AND resource IS NOT NULL`
  serves the FIFO scan.
- New `resource_claims` table with `uq_claim_live` / `uq_claim_dispatch` / `idx_claim_live_resource`
  and foreign keys to `tasks`, `dispatches` and `(task_id, generation)` on `wait_conditions`.

No historical fabrication: existing rows migrate with `resource` NULL, and no resource ownership is
backfilled for work that never recorded any.

## 9. Tests

`apps/api/test/resource-slots.test.ts` (39 cases, injected clock and the scheduler's own
tick/event paths; no wall-time sleeps). A holder occupies its slot with a real live session — the
fake adapter parks on an approval nobody answers — so the hold is the actual ownership record
rather than a stub. Unexpected scheduler errors fail the test: a swallowed wake failure would
otherwise look exactly like "the slot was correctly withheld".

Coverage against the required matrix: one task with a free slot dispatches (A); with none it waits
with a truthful reason (B); release wakes the next waiter by generation through `wake()` (C, I);
two concurrent wakes for one slot yield exactly one owner, and a smaller request does not overtake
the front (D); duplicate and stale wakes never double-claim (E); cancellation while waiting (F) and
after the claim before the start (G); restart at the reservation boundary keeps one claim, and a
restart whose owner is gone is swept (H); no starvation in FIFO order (J);
approval/verification/comparison pauses are not deferrable onto a resource wait (K); routing is
recomputed at the wake (L); time, quota and dependency waits stay claim-free (M); K13 stays in
SHADOW across a resource dispatch (N). Plus: double release is idempotent; a slot is held through
an approval pause; capacity increase wakes eligible work; capacity decrease preempts nothing; an
unsatisfiable request becomes an operator decision; quota re-park, context-yield continuation and
operator wait-replacement all carry the requirement forward; start-ambiguous re-park release.

Fairness (`describe('K4b pool fairness')`), each written to fail before the readiness rule and the
requirement age existed: a pending dependency at the front does not hold a ready waiter behind it,
and re-enters at its original seniority once it clears; a failed dependency awaiting an operator
does not hold the pool while its own wake performs the transition; a due-but-still-quota-blocked
requirement does not hold the pool, and re-enters at its original seniority once the evidence
clears; the age survives a context-yield continuation and a no-candidate re-park; run-now still
skips the queue and never the capacity; the pool status, the per-task readout and the grant agree
on readiness; a not-yet-due requirement is never reported "eligible"; and a due requirement the
pool withholds does not re-arm the timer at 1 ms.

`apps/web/src/orbital.test.ts` covers the `Resource wait · K4b` label, every `blockedBy`
next-action string, and the wording for a pool requirement carried under a dependency or quota
wait.

## 10. Deferred, still

- Per-launch pool accounting for tasks that never declare a resource wait. `attach` is
  single-mode only (unchanged from K1), so compare/race competitors never claim units either.
- Pool-wide notification beyond the FIFO front: a release wakes the front waiter, and each grant
  re-evaluates the pool, so available headroom drains in one pass; a wake that goes stale for a
  non-capacity reason falls back to the ≤60 s sweep.
- Pool CRUD / runtime capacity API (config plus restart is the change protocol).
- Priority or weighted fairness (deliberate: FIFO only, see §4).
- `overlap: queue`, K10, K13 activation, K15/K16 — all out of scope for this slice.
