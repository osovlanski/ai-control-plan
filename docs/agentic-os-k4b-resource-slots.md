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
| handoff / failover continuation | held while the source session is live, released when it settles — the successor acquires its OWN claim |
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

### 5.1 Repairing an unsatisfiable request

Expiring the request stops it blocking the queue, but the task still has to be recoverable, and the
only repair for "the pool cannot satisfy this" is another wait. That pause is therefore the ONE
`intervention_required` an operator may replace with a resource wait (`CR-35`):

- **Evidence, not pause kind.** `Scheduler.resourceRepairable` requires the durable pair the expiry
  itself wrote — an `expired` condition that still names the pool, plus a `resource.unsatisfiable`
  scheduler event at that generation. Delete the event and the pause is an ordinary human decision
  again. Nothing makes `intervention_required` generically wait-eligible, and approval,
  verification and comparison pauses are exactly as non-deferrable as before.
- **Resource waits only.** A time or quota wait is still refused with `Pause requires an operator
  decision`; the repair IS the new request.
- **`validate` still applies.** A repair that still exceeds capacity is refused at attach rather
  than parked forever.
- **Seniority follows the requirement, not the row.** A changed pool or unit count is a NEW
  requirement and queues from now. The SAME pool and unit count restored after the configuration
  is fixed keeps its original `resource_queued_at`: it is the same requirement, it has been waiting
  all along, and the configuration error was not the task's fault.

The transition is authorized by an explicit `TransitionGrant` passed from `attach`, so the
state-machine guard stays closed for every other caller rather than being widened.

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
time or quota wait without one never does); the 60 s sweep covers them, exactly as for dependency
waits. A missed release event therefore costs one tick, never a hang.

### 6.1 The sweep deadline is absolute

Because those waits are excluded from exact deadlines, the sweep is the ONLY thing that
re-evaluates them — so its cadence has to be bounded by construction, not by luck. A single timer
still fires the earliest of three deadlines:

```
arm() → min( earliest exact wait deadline ,   ← time/quota waits carrying no requirement
             earliest schedule deadline   ,   ← K5
             nextSweepAt )                    ← ABSOLUTE, = lastTick + 60 s
```

`nextSweepAt` advances **when a tick happens**, never when `arm()` is called. `arm()` runs on
attach, publish, a stale wake, a schedule edit and every resource notification; a deadline
recomputed from "now" on each of those is a deadline ordinary traffic can postpone indefinitely,
and a busy instance would sweep zero times per hour. Unrelated activity now re-arms the same timer
onto the same absolute deadline, so it can only make the next sweep sooner, never later.

A fresh process has no sweep history, so the first `arm()` sets `nextSweepAt = now + 60 s`: a
restart schedules its first sweep rather than busy-looping on a deadline it never recorded. Still
one `setTimeout`, no second timer, no wall-clock sleeps, and schedule/time deadlines can still fire
earlier than the sweep.

## 6.2 One launch funnel, one acquisition path

A claim is granted in exactly one place: the wake transaction. Every other way a task can reach a
provider is a LAUNCH path, and a launch path must not be able to acquire capacity — which is
precisely the hole a manual handoff went through:

```
task enters execution through a resource requirement
  → hits a limit, automatic failover off → WAITING_INPUT
  → releaseIfIdle releases the claim (no owner)     ← correct
  → another task takes the pool's last slot          ← correct
  → operator requests a handoff
  → Orchestrator.handoff → startTask → RUNNING       ← execution with no claim
```

The requirement outlives the condition that carried it: a consumed, expired or replaced condition
that still names a pool still describes what the task needs in order to run
(`Scheduler.requirement`). Two mechanisms close this, and they are deliberately different:

**1. The gate (defence in depth).** `Scheduler.assertLaunchClaim(taskId, dispatchId)`, called at the
top of `Orchestrator.startTask`, refuses to start a task that carries a requirement unless a live
claim for that pool exists — and, when the start belongs to a dispatch, unless that claim is the one
THIS dispatch owns. It only ever refuses; it never acquires.

**2. The re-entry (the actual correction).** `Orchestrator.deferResourceContinuation` →
`Scheduler.deferForResource` puts the continuation back through the ordinary funnel:

```
source settles (cancelled/drained for a handoff, limit-settled for a failover)
  → release the PREDECESSOR's claim, by the predecessor's ownership
  → persist the continuation intent → WAITING_RESOURCE
  → wake(taskId, generation, actor)
  → capacity check                       ← never skipped
  → claim + dispatch reservation (one transaction)
  → routeTask() → materialize → start
```

**The predecessor's claim ends with the predecessor.** A claim belongs to the dispatch it was
granted to, and that dispatch ends with the session it launched, so a successor never inherits one.
Letting a dispatchless successor reuse a live claim looked cheaper and was not: the moment the
source settles there is no live run and no open dispatch, which is exactly the state
`releaseIdleClaims` is entitled to act on — a routine tick between the check and the start could
take the capacity away and strand the task mid-handoff. So the release is explicit, it uses the
same `releaseIfIdle` ownership test every other release path uses, and the successor acquires a new
claim inside the wake transaction: `resource_claims.dispatch_id == successor dispatch_id`, always.
`assertLaunchClaim` therefore has no dispatchless exception left — it demands the claim be the one
this start's dispatch owns, and it still only ever refuses.

**Wake authority is the caller's, not a constant.** A manual handoff is an operator decision: it
may skip the FIFO (choosing what runs next is an operator decision) and never the capacity. An
automatic quota/failure continuation is ordinary scheduler work: it wakes as `event` and respects
`resourceReady`, the resource FIFO and the capacity like every other waiter — and it is recorded as
`scheduler`, never as an operator, so the audit trail never shows a human who was not there.

If the pool is full the continuation returns `{ deferred: 'resource', resource, units }`, nothing
starts, and the release of the holder wakes the task through the same FIFO every other waiter uses
— exactly one successor, holding the claim its own dispatch was granted.

Carried across the deferral: the continuation anchor (the latest checkpoint of the settled
predecessor run, which is what a `WAITING_RESOURCE` transition already demands), the requirement,
its `resource_queued_at` seniority (same pool + same units = the same requirement), and the
operator's own intent — target, the assistant being handed off from, the reason rendered into the
receiving agent's prompt, and the `handoffs.trigger` the eventual start closes out — stored durably
in `wait_conditions.continuation` and applied by `Scheduler.start` at the grant.

Deliberately NOT carried: the routing decision. Routing runs fresh at the grant, because a target
chosen minutes ago may be in cooldown or at a limit by the time the slot frees; replaying it would
trade a correctness property for a stale answer. The operator's `to` is applied as the routing
OVERRIDE at that fresh decision, not as a pre-resolved choice.

The automatic failover path re-enters the same way (it pins no target — its own re-route runs at
the grant), so the invariant has one implementation rather than one per caller. It also re-enters
BEFORE routing: `failoverTask` checkpoints, gives the quota park its existing first refusal (every
candidate blocked is not a pool problem, and that park carries the requirement forward), and then
defers — so a continuation that parks produces NO routing decision. One resource-deferred
continuation, one routing decision, made by the dispatch that actually gets the slot, and therefore
one K13 shadow recommendation rather than an unused pre-grant one polluting the evidence. Only
resource-bearing tasks take this order; every other failover keeps the one it had.

**One continuation per task, decided durably.** The parking transaction refuses to overwrite an
active condition that already carries a continuation intent, so two concurrent handoff requests
cannot both park: the winner owns the intent, the pending `handoffs` row commits with that intent
(or not at all), and the loser is told `already has a pending manual continuation` rather than
silently replacing the winner's target. A sequential second request on an already-deferred task is
still refused earlier by the pre-existing `Scheduler owns task; use run-now` guard; an operator
`run-now` on it is still capacity-checked, and a stale generation is inert. No process-local lock
is involved — the durable condition row is the arbiter.

## 6.3 A pool exists only if it is declared

`Scheduler.capacity` is the single definition of "this pool exists", and it fails closed twice:

- **Own property only.** A pool name is durable TASK data read out of a wait row, not a config key
  the code controls, so an ordinary lookup lets `constructor`, `toString`, `valueOf` or an injected
  prototype answer for a pool nobody declared. An inherited answer is not a declaration.
- **A validated non-negative integer, or nothing.** `Object.prototype.constructor` is a *function*:
  every capacity comparison against it is `NaN`, and `NaN` is false for BOTH `>` and `<`, so the
  request is neither "larger than capacity" nor "larger than what is free" — the gate GRANTS it.
  That is a capacity bypass, not a capacity failure.

Anything else is `undefined`: undeclared, which `validate` rejects at attach and `resourceGate`
treats as unsatisfiable. `loadConfig` additionally normalizes `scheduler.resources` into a
null-prototype map of own keys (a plain `{...spread}` invokes the `__proto__` SETTER, so one
crafted key re-parents the whole map), and the existing name/range validation still reports a bad
declaration by name rather than silently dropping it. A genuinely declared pool whose name merely
LOOKS inherited keeps working — the policy is "own key", not "a name we like".

## 7. Operator surface

- `POST /api/tasks/:id/wait` accepts `{ kind: "resource", resource, units? }` — no new route.
- `GET /api/tasks/:id/wait` and `GET /api/tasks/:id` add `resourceWait` (pool, requested units,
  capacity/availability when known, queue position — 0 when it is not in the queue —, `blockedBy`
  including `condition`, the blocking reason, and the kind of wait carrying the requirement) and
  `resourceClaim`.
- `GET /api/scheduler/status` adds `resources[]`: capacity, claimed units, available units, the
  ready FIFO wait queue (`waitingTaskIds`) and the requirements held out of it (`notReadyTaskIds`)
  per pool.
- `resourceWait` also carries `dependencyFailure` (`{ failed, policy }`) when the wait carrying the
  requirement is a dependency wait whose subjects have already FAILED. A failed dependency never
  "clears", so the operator surface reports the action the next wake will take — cancel, move to
  operator input, or (under `wake-anyway`) continue and compete for the slot — instead of a wait
  that will never end.
- `POST /api/tasks/:id/handoff` returns either `{ runId, assistantId }` or, when the task still owes
  the pool a claim, `{ deferred: "resource", resource, units }`.
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
- `wait_conditions.continuation` — the operator/failover continuation intent a deferral carried
  (trigger, target, from-assistant, reason). NULL for every row that carries no requirement.
- New `resource_claims` table with `uq_claim_live` / `uq_claim_dispatch` / `idx_claim_live_resource`
  and foreign keys to `tasks`, `dispatches` and `(task_id, generation)` on `wait_conditions`.

No historical fabrication: existing rows migrate with `resource` NULL, and no resource ownership is
backfilled for work that never recorded any.

## 9. Tests

`apps/api/test/resource-slots.test.ts` (64 cases, injected clock and the scheduler's own
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

Capacity is not operator-bypassable, and a successor never inherits a claim
(`describe.each(['legacy','harness'])('K4b manual handoff')`, 7 cases run under BOTH execution
modes because the defect was in the shared launch boundary).

A task runs on its slot, hits a limit with automatic failover off, has its claim swept, and another
task takes the only slot; then the operator asks for a handoff. Asserted: nothing starts and no
unclaimed execution exists; the requirement, the continuation anchor, the operator intent and the
`resource_queued_at` seniority all survive the deferral; releasing the holder produces exactly ONE
successor, whose dispatch owns the claim it runs on, with the `manual` handoff row closed by it; a
duplicate handoff is refused, an operator run-now is still capacity-checked and a stale generation
is inert; and a direct `startTask` of an unclaimed resource-bearing task fails closed before any
provider call. The holder parks at the reservation boundary, so it owns its dispatch — and
therefore its claim — until the test hands the slot back: no wall-time hold, and the same ownership
record every release path reads.

The three continuation-ownership races, each with a full scheduler tick (sweep included) injected
deterministically at the checkpoint the handoff takes — the exact window where the predecessor has
settled, the claim is still live and no dispatch owns it:

- **A — sweep at the boundary.** The sweep takes the predecessor's claim mid-handoff. The old claim
  is released with the predecessor's dispatch, the successor runs on a NEW dispatch-owned claim,
  and the task is never left stranded in `HANDING_OFF` with an unresolved handoff.
- **B — another task takes the swept slot.** The rival legitimately wins the capacity; the handoff
  answers `{ deferred: 'resource' }` and the task waits in `WAITING_RESOURCE` with no claim and no
  new execution. When the rival gives the slot back, exactly one successor takes it, on exactly one
  claim owned by exactly one new dispatch, with exactly one `manual` handoff row.
- **C — no race at all.** Capacity free throughout, a task holding its own slot handed off: it
  still releases the predecessor's claim and acquires a new one for the successor's dispatch
  (two claim rows: the first released, the second live and owned by the dispatch that runs).

Concurrent duplicate handoff (P2): two `handoff()` calls entered before either parks. Exactly one
wins with `{ deferred: 'resource' }`, exactly one active condition and one continuation intent
exist, exactly one pending `manual` handoff row is written, one successor runs, and the loser is
rejected with an explicit already-owned error rather than silently replacing the winner's target.

Automatic continuation (`describe('K4b automatic continuation')`): a resource-bearing task hits a
quota limit with automatic failover ON while a SENIOR two-unit requirement is ready and ahead of
it, and one unit frees. Asserted: the automatic continuation does not take the unit it could have
had — `task <senior> is ahead in the wait queue` — it parks as `createdBy: 'scheduler'` with a
`quota` continuation intent and a `quota` handoff row (never `manual`, never `operator`); parking
persists NO routing decision; and the same state asked by an operator (`run-now`) skips the FIFO
but not the capacity, producing exactly one new dispatch whose claim it owns, exactly one routing
decision per dispatch and none spare, with K13 still `shadow`/`unchanged` and the execution
request's model untouched.

Bounded sweep (`describe('K4b bounded sweep')`): with the release event deliberately LOST (the
claim row released behind the scheduler's back), only a sweep can free the waiter — and it does,
while unrelated waits are attached at half the cadence, and while stale wakes re-arm the timer
repeatedly. A fresh scheduler arms one cadence out rather than busy-looping on a deadline it never
recorded, and the pre-existing no-1 ms-spin test is retained unchanged.

Pool declaration safety (`describe('K4b pool declaration safety')`): `constructor`, `__proto__`,
`prototype`, `toString`, `valueOf` and `hasOwnProperty` are refused at attach, and a wait forged
past that guard reports `undeclared`, is never granted by wake or run-now, produces no claim, no
dispatch and no `NaN` arithmetic, and expires to an operator decision. A declared capacity that is
`NaN`, fractional, negative, `Infinity`, a string or `undefined` reads as undeclared. A pool
genuinely declared under an awkward own name still works and still enforces its capacity.

Unsatisfiable repair (`describe('K4b unsatisfiable repair')`): a reduced request is accepted and
re-enters the queue as a NEW requirement (new seniority); the SAME request restored after the
config is fixed keeps its original seniority; a time wait onto the same pause is still refused; a
repair that still exceeds capacity is refused at attach; and with the `resource.unsatisfiable`
evidence removed the pause is an ordinary human decision again.

`apps/web/src/orbital.test.ts` covers the `Resource wait · K4b` label, every `blockedBy`
next-action string, the wording for a pool requirement carried under a dependency or quota wait,
and the three failed-dependency next actions (cancel, wait-input, wake-anyway).

## 10. Deferred, still

- Per-launch pool accounting for tasks that never declare a resource wait. `attach` is
  single-mode only (unchanged from K1), so compare/race competitors never claim units either.
- Pool-wide notification beyond the FIFO front: a release wakes the front waiter, and each grant
  re-evaluates the pool, so available headroom drains in one pass; a wake that goes stale for a
  non-capacity reason falls back to the ≤60 s sweep.
- Pool CRUD / runtime capacity API (config plus restart is the change protocol).
- Priority or weighted fairness (deliberate: FIFO only, see §4).
- `overlap: queue`, K10, K13 activation, K15/K16 — all out of scope for this slice.
