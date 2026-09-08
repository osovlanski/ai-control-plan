# K11 context continuation — implementation and acceptance record

Implemented on `feat/agentic-os-k11-context-continuation`, from
`docs/agentic-os-kernel-services.md` §4.3.2, §4.3.3, §5.2 (K11 items 5–10),
CR-30, CR-31, CR-32, CR-34 and invariants I-C1, I-C3, I-M4. K1–K7, K9 and K12
are unchanged; K8, K10 and K13 are untouched.

**K11 is CLEAN-SESSION CONTINUATION.** A session that observes critical context
pressure checkpoints, settles `YIELDED(context)`, and the Control Plane starts a
fresh successor from that exact checkpoint. **K11 is not provider-command
compaction**: no `/compact`, no `/clear`, no compaction directive, no
`context.compaction.requested` — that is K10 and it remains unimplemented.

## The shape

```
fresh critical ContextObservation      (K9 sampler, provider-reported only)
        ↓  ContextGuard (pure)
durable checkpoint                     reason = "context", committed Git ref
        ↓
continuation envelope                  derived from the immutable snapshot
        ↓
YIELDED(context)                       terminal, ExecutionResult persisted
        ↓
Control Plane decides                  adequacy → safety stop → bounds
        ↓
scheduler park (origin "context-yield")
        ↓
routeTask(taskId, "context-yield")     preferSame, normal filters
        ↓
successor from continuation: { kind: "checkpoint", checkpointId }
```

## 1. Context decision policy

`ContextPolicy` (`packages/core/src/context.ts`) carries the canonical defaults:
`warnRatio 0.70`, `actRatio 0.85`, `criticalRatio 0.92`,
`maxContinuationsPerTask 3`, `noProgressContinuationLimit 2`,
`onUnknown "warn-only"`.

`evaluateContextGuard` (`apps/api/src/modules/harness/context-guard.ts`) is pure:
`(policy, capability, observation, clocks) → continue | warn | yield`. It is
evaluated by `SessionRunner.sampleContext` immediately after a fresh
`context.observed` is recorded, and the only escalation it can produce is a
`context` yield.

It refuses to yield on, in this order:

| Input | Decision |
|---|---|
| capability `occupancy: "unavailable"` (Codex, Cursor, Bedrock) | continue |
| no observation yet | continue |
| `pressure === undefined` (occupancy known, effective window unknown) | continue |
| observation older than `CONTEXT_STALE_MS` (45 s) or `freshness !== "live"` | continue |
| a `context.compaction.observed` newer than the observation (CR-34) | continue |
| `capability.compact === "provider-command"` (K10 seam, inert) | continue |
| `pressure >= criticalRatio` | **yield** |
| `pressure >= warnRatio` | warn |

Only `ContextObservation.pressure` is ever read, and `buildContextObservation`
computes that solely from a known occupancy over a real **effective** window.
Token accounting, quota usage, an advertised model maximum and a guessed
occupancy are structurally incapable of reaching the guard. `actRatio` has no
behaviour attached: K10 is not implemented.

## 2. Checkpoint adequacy

`decideContextContinuation` (`apps/api/src/modules/context-continuation.ts`)
requires all three before a successor may exist:

1. a checkpoint id from the yield;
2. `result.checkpoint.committed` **and** a `gitRef` — an envelope-only checkpoint
   left by a Git failure is explicitly inadequate;
3. a committed continuation envelope whose `currentSubtask` is non-blank.

The third needed a decision. `TaskEnvelope.nextAction` is cleared on every
assistant message (`envelope-derivation.ts`) and nothing populates `remaining`
yet, so a literal "envelope carries `nextAction`" test would make K11 never
continue. `continuationNextAction` (`packages/core/src/task.ts`) derives it
truthfully instead, quoting only state the envelope already has: the explicit
`nextAction`, else the first outstanding item, else — when the checkpoint records
completed work or changed files — "continue from the checkpoint commit". When
the envelope has *none* of those, the answer is `undefined` and the task parks:
restarting from nothing is a fresh run, not a continuation. `deriveEnvelope`
stamps the same value it approved onto `currentSubtask`, so the adequacy gate and
the rendered successor prompt can never disagree.

Failure → `WAITING_INPUT`, `pause_kind = continuation_evidence_missing`.

## 3. `YIELDED(context)` as a distinct healthy outcome

- `ExecutionResult.yield.kind` gains `"context"` alongside `reroute | handoff |
  limit`, with a typed `ContextYieldRequest` detail (session, task, reason,
  checkpoint id, envelope id, and the fresh critical observation).
- One new normalized event type, `context.yield`, with a typed payload. Nothing
  else was added.
- The checkpoint reason is `context`, not `limit` — the continuation anchors are
  identifiable in the checkpoints table, which is where the bounds read them from.
- The envelope's `reason` reads "the previous session reached its context limit
  and checkpointed", not "session yielded".

## 4. Successor ownership and routing

The predecessor is terminal with its `ExecutionResult` persisted before
`settleFromResult` runs, and `Scheduler.hasOwner` re-checks inside its own
transaction, so predecessor-live + successor-live is impossible.

`Orchestrator.continueFromContextYield` parks the task with
`Scheduler.parkContextContinuation`, which inserts an immediately-due `time` wait
carrying `checkpoint_id` and the new durable `wait_conditions.origin =
'context-yield'`. From there the **ordinary K1 path** owns everything: wake →
`dispatch` row → `routeTask(taskId, 'context-yield', { dispatchId })` →
`startTask` with `continuation: { kind: 'checkpoint', checkpointId }`. No second
continuation queue, no second routing entry point, no `routeForContext()`.

`RUNNING → WAITING_RESOURCE` was added to the task state machine for this park.
It is the only new edge; `Scheduler.attach` keeps its own narrower allowlist, so
the edge is reachable only from the K11 path.

**preferSame.** `RouteRequest.preferSame` is applied *after* every hard filter
(auth, capabilities, workspace allowlist, cooldown, quota) and *after* a user
override, among candidates that already passed. It is a preference, never a
bypass; when the previous assistant is ineligible the router picks another and
records why. A healthy context yield adds no cooldown penalty of its own. The
requested model selector is the task's durable intent and is unchanged by a
continuation.

## 5. Bounded input (CR-31)

`startTask` renders from `continuation`, never from a trigger string.
`HandoffService.bindSuccessor` binds the committed envelope and renders
`renderCommittedHandoff` — objective, constraints, completed, outstanding,
decisions, repository/git ref, reason, next action. No provider transcript is
copied; prompts are never persisted at all (only `rendered_prompt_digest`).
Clean continuation is intentionally lossy, and no provider-side memory is assumed
to survive.

## 6. Provenance (no new subsystem)

Everything is derived from rows that already exist — `dispatches` (one row per
continuation attempt), `checkpoints` (anchor + immutable snapshot), `runs`,
`handoff_envelopes`, `routing_decisions`. `RoutingExplanation.contextContinuation`
extends the existing routing record with: continuation number and limit,
checkpoint id, predecessor session, previous assistant, previous requested and
resolved model, the requested selector, the critical pressure and its
`observedAt`, `preferSameSatisfied`, and `changedBecause` when it was not.

Because the counters are derived rather than stored, they cannot drift from the
dispatch log and they survive a process restart for free.

## 7. Task-level bounds

- **Continuation number** = `COUNT(dispatches WHERE origin = 'context-yield')`,
  counting *every* phase: a reparked or aborted attempt still consumed one.
  `attemptsSoFar >= 3` → `continuation_limit_reached`.
- **Progress** = a change in `completed` or `remaining` between successive
  context-anchor checkpoint envelopes. More tokens, more events, elapsed time and
  reworded summaries are explicitly not progress. Two consecutive no-progress
  continuations → `continuation_no_progress`.
- **Successor immediately critical**: the yielding session was itself started by
  a `context-yield` dispatch **and** the yield came on `observation.sequence === 1`
  → `successor_immediately_critical`. This is checked before the bounds and
  overrides any remaining budget.

All four stops park the task in `WAITING_INPUT` with a truthful `pause_kind`.
None of them is in CR-32's wait-eligible set, so an operator — not a deferral —
resolves them.

## 8. Reliability (I-M4)

`isReliabilityFailure(result)` (`packages/core/src/execution.ts`) is the single
predicate: `completed` and `cancelled` are not failures; a `yielded` result is a
failure unless `yield.kind === "context"`; everything else is. `TelemetryService`
uses it for the success/error split, and excludes `handoffs.trigger = 'context'`
from the failover count — a continuation of the same work by the same assistant
is not a rescue.

## 9. Recovery

No new recovery mechanism. The crash boundaries are the existing dispatch ones:

| Boundary | Behaviour |
|---|---|
| A — critical observation persisted, crash before checkpoint | no result, no successor; existing session recovery settles it |
| B — checkpoint committed, crash before `YIELDED` settlement | no result, no successor; the checkpoint is reused if the task is resumed |
| C — result persisted, crash before successor dispatch | the active, due `context-yield` wait wakes on the next boot and dispatches |
| D — routing decision committed, crash before materialization | `continueDispatch` reuses the committed `routing_decision_id` |
| E — immutable successor request persisted, crash before provider start | `startTask` reuses the committed `request_json` |

`uq_dispatch_open`, `uq_live_successor` and the envelope claim protocol make a
duplicate successor impossible; the continuation number is derived, so it cannot
be double-incremented. Exactly-once provider execution is not claimed.

## 10. Invariants

- **I-C1**: a context yield only ever appends. Proven by a byte-for-byte
  comparison of every event, checkpoint, envelope and result row captured at the
  moment the continuation is reserved against the same rows after it completes.
- **I-C3**: `/clear` is never issued; neither is `/compact`. No adapter declares
  `compact: "provider-command"`, `adapter.send` is never called, and the rendered
  successor prompt is asserted free of both commands.

## Acceptance criteria → tests

Kernel-services §5.2 K11 items 5–10, and the K11 test matrix:

| # | Criterion | Test |
|---|---|---|
| 1 | below critical → no yield | `context-guard.test.ts` ("continues below the warn threshold"); `context-continuation.test.ts` ("below critical") |
| 2 | fresh critical → yield eligible | `context-guard.test.ts` ("yields on a fresh observation…"); `context-continuation.test.ts` ("checkpoints, settles YIELDED(context)…") |
| 3 | stale critical → no yield | `context-guard.test.ts` ("never yields on a stale critical observation", "…marked stale") |
| 4 | unavailable → no yield | `context-guard.test.ts` ("…cannot report occupancy (Codex)"); `context-continuation.test.ts` ("unavailable occupancy never yields") |
| 5 | advertised max without effective window → no yield | `context-guard.test.ts` ("never yields from an advertised maximum…"); `context-continuation.test.ts` ("occupancy without an effective window") |
| 6 | provider auto-compaction relief → no yield | `context-guard.test.ts` (CR-34 block: waits for the post-compaction observation; relief; still-critical escalation) |
| 7 | checkpoint + nextAction required | `context-continuation.test.ts` ("an envelope-only checkpoint (git failure)…"); adequacy is asserted on the happy path (`checkpoint.committed`, `gitRef`, envelope `currentSubtask`) |
| 8 | envelope-only / Git failure → `WAITING_INPUT` | `context-continuation.test.ts` ("an envelope-only checkpoint (git failure) starts no successor") |
| 9 | predecessor settled before successor | `context-continuation.test.ts` (predecessor `YIELDED` + result persisted before the successor row exists; I-C1 snapshot taken at reservation) |
| 10 | exact checkpoint continuation used | `context-continuation.test.ts` (`dispatch.checkpoint_id === detail.checkpointId`, origin/prompt_source bound to the envelope); `eval/scenarios/context-pressure.ts` |
| 11 | same assistant/model preferred | `context-continuation.test.ts` ("prefers the same assistant and records the routing provenance") |
| 12 | unavailable preferred candidate can change | `context-continuation.test.ts` ("routes to another eligible assistant…") |
| 13 | routing provenance recorded | `context-continuation.test.ts` (`contextContinuation` block on the persisted explanation) |
| 14 | continuation #4 blocked | `context-continuation.test.ts` ("continuation #4 is blocked from the durable dispatch log alone") |
| 15 | two no-progress continuations blocked | `context-continuation.test.ts` ("two consecutive continuations with no envelope progress park the task", incl. the streak clearing on real progress) |
| 16 | bounds survive restart | `context-continuation.test.ts` ("bounds are recomputed from committed rows…", second connection to the same file) |
| 17 | immediately-critical successor cannot continue again | `context-continuation.test.ts` ("an immediately critical successor stops the loop and overrides the budget") |
| 18 | healthy context yield not a reliability failure | `context-continuation.test.ts` ("…is not a reliability failure and costs no cooldown": `isReliabilityFailure`, no cooldown, telemetry errors/failovers 0) |
| 19 | cancel before successor start → no provider call | `context-continuation.test.ts` ("a cancellation committed before the successor starts makes no provider call") |
| 20 | crash boundaries create no duplicate successor | `context-continuation.test.ts` (parameterised over `reserved`, `routed`, `materialized`, `start_attempted`, `session_created`) |
| 21 | no compact command issued | `context-continuation.test.ts` ("issues no compaction command and never a clear") |
| 22 | `/clear` never issued | same test — both commands asserted absent from every rendered prompt |
| — | I-C1 append-only | `context-continuation.test.ts` ("I-C1: a context yield mutates no prior event, checkpoint, envelope or result") |
| — | UI renders continuation truthfully | `context-continuation.test.ts` (two `readTaskContext` cases: live continuation, and the named stop) |
| — | deterministic eval | `eval/scenarios/context-pressure.ts` |

## Validation

All green on this branch:

`pnpm typecheck` · `pnpm lint` · `pnpm test` (751 tests) · `pnpm build` ·
`pnpm test:harness-on` (629) · `pnpm test:recovery-chaos` (56) · `pnpm demo:a` ·
`pnpm demo:a5` · `pnpm eval` (8/11 fake ok, 3 real skipped for credentials).

No real-provider run was made for K11. Forcing genuine provider context pressure
costs a very large token volume for no additional control-plane evidence: K9
already carries real Claude observation evidence (`totalTokens` / `rawMaxTokens`
from a live session), and everything K11 adds downstream of that observation is
exercised deterministically here.

## UI

The existing Orbital **Context** tab gains one block, rendered only once a
context yield has happened: continuation *n* of 3, the reason, the checkpoint,
the predecessor session, the successor session or `pending`, and — when the plane
refused to continue — the explicit stop (continuation evidence missing /
continuation limit reached / no progress between continuations / successor
immediately critical). `GET /api/tasks/:id/context` carries it under the existing
`context.read` capability. Cockpit was not modified; K12 (PR #37) is untouched.

## Deferred — K10, explicitly

Not implemented, and no inert code pretends otherwise: `/compact`, an adapter
compact control, `context.compaction.requested` / `.relieved` / `.unrelieved`,
replay of compaction directives, `maxCompactionsPerSession`,
`minTurnsBetweenActions`. The two declared seams are honest and inert:
`ContextPolicy.actRatio` has no behaviour, and the guard explicitly declines to
yield when an adapter declares `compact: "provider-command"`, because that case
belongs to the K10 ladder. No adapter declares it today.
