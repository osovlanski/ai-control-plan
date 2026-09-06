# K1 durable dispatch — implementation and acceptance record

Implemented on `feat/agentic-os-k1-durable-dispatch`, based directly on
`docs/agentic-os-kernel-services@56cf244`. Orbital UI was not the baseline and is
not included. Authority: kernel-services revision 2, vNext revision 8, and the
reconciled master-plan M13. Only K1 is implemented; the remaining Agentic OS
material is still proposed.

## Delivered behavior

New single-mode tasks can carry `wait: {kind: "time", notBefore: "2030-01-01T22:00:00Z"}`.
Creation and attachment commit together. The task enters `WAITING_RESOURCE` with
an active generation-1 condition and no execution owner. Routing happens at wake,
using current telemetry and cooldowns plus persisted task intent. Explicit
assistant pins remain hard eligibility requirements; K1 accepts no other override
fields, rather than silently accepting policy/model selectors it cannot enforce.

Migration `014_durable_dispatch.sql` adds `tasks.intent_json`, `pause_kind`,
`wait_conditions`, `dispatches`, `runs.dispatch_id`, and task-scoped
`scheduler_events`. Partial unique indexes enforce one active condition and one
open dispatch per task. A run can reference a dispatch only once. Existing intent
is backfilled; historical human pauses receive `unknown`, not a guessed reason.
Every new transition into `WAITING_INPUT` records a pause kind. K1 rejects conversion
of existing parked/executed work, even when its pause kind would qualify for K2.

Timer, event, and operator wake use the same generation-aware transaction:
consume the condition, reserve a dispatch, and move to `ROUTING`. Replacement adds
a generation and preserves the old row. Duplicates and stale generations do
nothing. Dispatch identity and `start_attempted` are durable before provider
startup. The Harness request uses the dispatch ID; both paths persist a run join.
The session insert rechecks ownership transactionally. Cancellation co-commits
task/condition/dispatch state and Harness cancel intent; a late provider handle
receives cancellation. No exactly-once provider execution is claimed.

`routeTask` replaces the separate intake/handoff routing implementations and always
supplies telemetry. Continuation is explicitly fresh or anchored to a particular
checkpoint, whose snapshot supplies the handoff prompt; the trigger label does
not select the prompt. Existing immediate, failover, comparison, approval, and
verification paths remain covered by regression tests.

## Recovery and verified architecture corrections

- Boot first performs existing execution recovery, then dispatch reconciliation.
  Reserved attempts route and start; a correlated run/session repairs a lost
  `started` phase update and stays under normal execution recovery. Overdue active
  conditions wake without a catch-up policy. A disabled scheduler preserves waits
  and leaves its timer unarmed; operator run-now remains available.
- **No-session ambiguity differs by execution path.** Code inspection verified
  that a fresh Harness start always creates its session before any provider call.
  After a persisted 60-second recovery window, absence of that row therefore
  permits abort/re-park with `autoWakes + 1` and `start_ambiguous`. K1 has no claimed
  successor envelope: wiring checkpoint claims remains K2/standing deferral #7.
  A legacy provider call precedes its run insert, so absence of a run proves
  nothing. It stays held in `ROUTING` with a durable ambiguity event. Operator
  run-now must include `confirmNoLiveOwner: true`, after reconciling the provider;
  it refuses this acknowledgement while a start remains in flight or run evidence
  exists. This follows the path-specific recovery table in §4.2.3 and clarifies
  §5.1 item 5's broader re-park wording without making an unsafe retry promise.
- Persisted `execution_path` fences a start across flag changes. A reserved
  dispatch may adopt the current path before `start_attempted`; an attempted start
  retains its path for launch and recovery.
- K1 no-candidate retries remain **time** waits: a 60-second recheck, with at most
  three unsuccessful attempts before `WAITING_INPUT`. This satisfies the pinned
  assistant acceptance case without claiming a quota reset or implementing K2's
  blocker/projection logic. Retry history is durable and bounded to ten entries.
- Existing IDs use prefixed UUIDs and the repository has no ULID dependency. The
  dispatch uses the same prefixed UUID convention rather than adding a dependency
  solely for the example type's ULID comment. Ordering uses persisted timestamps
  and SQLite row order, not the opaque identity.
- Existing provider events require a real run FK. Scheduler events can precede
  every run, so they use a separate typed task-scoped event table and SSE frame;
  no provider run or transcript is fabricated. State frames include wait details.
- Failure injection found a pre-existing Harness startup cancellation gap: cancel
  intent bumped the version before handle acknowledgement, causing a CAS failure
  without cancelling the eventual handle. The runner now delivers cancellation
  before acknowledgement and persists its cancellation result.
- The auth signature-negative test previously replaced a trailing Base64 character,
  which sometimes changed only unused bits and left the decoded signature valid.
  It now flips a decoded signature byte deterministically. Production auth behavior
  is unchanged; the advertised API minor version changes to 2.1.

## API and UI

| Surface | K1 behavior / authorization |
|---|---|
| `POST /api/tasks` | Optional time wait and persisted assistant pin; `commands.write` |
| `POST /api/tasks/:id/wait` | Attach to unexecuted single tasks or replace an active condition; `commands.write` |
| `POST /api/tasks/:id/run-now` | Optional expected `generation`; stale returns 409 and reason; `commands.write` |
| `POST /api/tasks/:id/cancel` | Cancels wait/dispatch and reaches any successor owner; existing authorization |
| `GET /api/tasks/:id/wait` | Latest condition/history and open dispatch; `tasks.read` |
| `GET /api/scheduler/status` | Enabled/armed, due conditions, open dispatches, last tick; `schedules.read` |
| Task list/detail and SSE | Wait summary, next check, disabled status; detail includes durable dispatch/event history |

API version is **2.1**. `schedules.read` currently grants scheduler-status reads;
recurring schedule CRUD is not implemented. Existing credentials are not silently
expanded to grant a new capability. The existing web board shows waiting tasks,
reason, and next check; task detail offers run-now/cancel and scheduling history,
with a disabled-scheduler banner. No Orbital redesign or Cockpit change is included.

## Canonical K1 acceptance review

All API/domain failure-window tests below live in `apps/api/test/scheduler.test.ts`.
They use injected clocks, fake timers, explicit promise gates, and FakeAdapter
start/cancel counters, without new sleep-based tests.

| §5.1 criterion | Evidence |
|---|---|
| 1 — time wait, atomic reservation, routing at wake | Creation/API test; clock-driven wake; cooldown added after creation changes assistant; new durable telemetry changes accepted routing explanation |
| 2 — duplicate wake / one open dispatch | Concurrent operator/event wakes yield one dispatch; SQL partial-unique-index violation tested |
| 3 — replacement / stale generation | API replacement produces generation 2; generation-1 timer returns stale |
| 4 — cancellation windows | Both paths: before wake, reserved, attempted before session, unresolved provider start, and after started; direct session insertion rejects cancelled ownership |
| 5 — crash boundaries | Reserved replay, actual DB close/reopen, attempted/no-session hold and path-specific timeout, lost phase update with a durable run/session, normal recovery of a PREPARED Harness/legacy start without a second provider call |
| 6 — stale failover and ownership | Checkpoint/settlement held while task state changes to scheduler ownership; no successor transition; unrelated run plus open dispatch rejected by mixed-ownership guard |
| 7 — authoritative run-now | Spy proves operator calls `wake`; API stale generation returns 409; explicit legacy ambiguity acknowledgement tested |
| 8 — intent vs choices | Wait schema has no assistant/model/composition column; assistant pin survives retries/replacement, never falls back; intent survives DB reopen |
| 9 — pause-kind guard | Table tests reject approval, verification, comparison, and handoff pauses; migration backfills unknown safely; K2 conversion remains rejected |
| 10 — timer containment / overdue boot | Throwing wake re-arms; overdue boot evaluation; slow unresolved provider start does not block another due task or timer |
| 11 — disabled scheduler | No automatic wake; preserved visible condition; run-now still dispatches through wake; status exposes unarmed timer |
| 12 — minimal waiting UI | Board/detail use `WaitingSummary`; `apps/web/src/WaitingSummary.test.tsx` proves summary, timestamp, and disabled banner rendering |

Additional tests cover auth on the new endpoints, out-of-scope input rejection,
durable event redaction, alternate-start/handoff/parallel bypass rejection,
existing failover from a dispatched task on both paths, and exact checkpoint
snapshot selection independent of trigger and newer checkpoints.

## Validation

- `pnpm typecheck` — passed (core, adapters, API, web).
- `pnpm test` — passed: core **70**, adapters **8**, API **475**, web **6**;
  **559 total**, zero failures.
- `AGENT_PLANE_HARNESS_SINGLE_MODE=1 pnpm test:harness-on` — all **475 API tests**
  passed with the forced-mode test helper exercising Harness execution.
- `pnpm lint` — passed.
- `pnpm build` — passed; production web bundle built successfully.
- New coverage: **46 scheduler/domain/API tests** and **1 waiting-state UI test**.
- `git diff --check` — passed. Secret scan over staged, unstaged, untracked, and
  last-commit additions found no credential matches. No provider transcripts are
  included.

K2 quota conversion/projections/blockers and reset-evidence fixes, K3 probes,
K4 dependencies, K5 recurrence, K6 Cockpit integration, K7+ model intelligence,
K9+ context lifecycle, RuntimeBackend/Herdr, and Composer remain deferred. No
standing Harness claim/resume/conformance/cost-cap deferral is closed by K1.
