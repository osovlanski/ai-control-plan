# Task stage contract v1

Status: normative for task stage v1 (API 2.9, shell view part B slice B3, owner answer Q2 on
`docs/agentic-os-shell-view-part-b.md`, 2026-11-05). It fixes one additive field, `stage`, on the
two reads that carry a task's orchestration state: the task list and the SSE `state` frame. Both
reads existed before 2.9 without a written contract; this note records the fields they serve so
the new one has something to sit beside.

The JSON Schema (draft 2020-12) `contracts/task-stage/v1/task-stage.schema.json` is the wire
authority for the `stage` object. `deriveStage` in `packages/core/src/task-stage.ts` is the only
implementation of the rules below. The conformance fixtures in `contracts/task-stage/v1/fixtures/`
are run by both repositories.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Why a stage

`TaskState` is the orchestration machine (`CREATED`, `ROUTING`, `RUNNING`, `WAITING_RESOURCE`,
`WAITING_INPUT`, `LIMIT_PAUSED`, `HANDING_OFF`, `COMPLETED`, `FAILED`, `CANCELLED`). An operator
asks a coarser question: is it waiting its turn, working, checking its work, waiting on me, or
finished? Some of the answer is not in `TaskState` at all: a `RUNNING` task can hold a session that
is `AWAITING_APPROVAL` or `VERIFYING`. Clients used to work that out themselves (the web's
`missionState`). The stage is that answer, computed once by the plane from facts it already owns,
so no client infers it. There is no Spec, Build or Review split: the plane cannot tell those apart,
and a stage the plane cannot back with a fact is not served.

## The `stage` object

```text
stage: { value: "queued" | "working" | "verifying" | "needs-you" | "done", rule: <rule name> }
```

`rule` names the one rule that produced `value`, so a stage can always be explained. Each rule
belongs to exactly one stage (ten rules):

| `value` | `rule` | Fires when |
| --- | --- | --- |
| `done` | `terminal` | The task state is `COMPLETED`, `FAILED` or `CANCELLED`. |
| `needs-you` | `waiting-input` | The task state is `WAITING_INPUT` (any pause kind: a verification failure, a pending comparison, an intervention, no candidate). |
| `needs-you` | `limit-paused` | The task state is `LIMIT_PAUSED`. |
| `needs-you` | `awaiting-approval` | A live session of the task is `AWAITING_APPROVAL`. |
| `verifying` | `verification-running` | A live session of the task is `VERIFYING`. |
| `working` | `live-run` | A live session of the task is `PREPARED`, `STARTING`, `RUNNING`, `PAUSED` or `RESUMING`. |
| `working` | `run-starting` | The task state is `RUNNING` and it has no run yet: the plane enters `RUNNING` just before it writes the first session row. |
| `queued` | `wait-condition` | The task state is `WAITING_RESOURCE`, or a `CREATED`, `ROUTING` or `HANDING_OFF` task has an active wait condition. |
| `verifying` | `run-ended-unsettled` | The task state is `RUNNING`, it has runs, and none is live: the run ended and the plane has not settled the verdict yet. Known imprecision: a successor started from `HANDING_OFF` or `WAITING_INPUT` also passes through this for the moment before its session row is written, because its predecessor's ended run is the newest fact the plane has. |
| `queued` | `no-run` | The task state is `CREATED`, `ROUTING` or `HANDING_OFF`, with no live session and no active wait. |

Rules are tried in the table's order and the first match wins. A session is **live** when its
effective state (`session_state` for Harness rows, the legacy `runs.state` mapped through
`effectiveStateSql` otherwise) is not terminal (`COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`,
`YIELDED`). Every `TaskState` and every `ExecutionSessionState` is handled by an exhaustive switch;
a new state fails the plane's build until it is given a rule.

**Legacy runs.** A run on the legacy (non-Harness) path never records `AWAITING_APPROVAL` or
`VERIFYING`: its pending approval lives in the adapter, not in a durable row, and it has no verify
stage. Such a run reads `working/live-run` while it waits on an approval. That is the plane telling
the truth about what it knows, not a rule to work around in a client; it closes when
`execution.harnessModes.single` is on (the default is off).

Inputs are exactly three facts: the task state, the effective states of the task's runs, and
whether the task's latest wait condition is `active`. Nothing else (phase, usage, cost, the
verification verdict) moves a stage.

## Where it is served

### `GET /api/tasks` (`tasks.read`)

Each element, as served before 2.9, plus `stage`:

```text
{ id, goal, state, phase, profile, repoPath, createdAt, updatedAt, wait?, schedulerEnabled,
  stage: { value, rule } }
```

`state` is the `TaskState`; `phase` is the provider-reported `activity_phase` or `null`; `wait` is
the latest `WaitCondition` (any state) or absent.

### `GET /api/tasks/:id/events/stream` (`events.stream`), `state` frames

The stream is Server-Sent Events, one JSON object per `data:` line. A frame with
`kind: "state"` carries:

```text
{ kind: "state", state: { state, phase?, assistantId?, wait?, schedulerEnabled?, stage: { value, rule } } }
```

The frame sent when the stream opens has `state`, `phase`, `wait` and `schedulerEnabled`. Frames
published later carry the fields their publisher knows (the orchestrator adds `assistantId`, the
scheduler adds `wait` and `schedulerEnabled`); from 2.9 every one carries `stage`, computed when
the frame is published. A frame is also published when a session enters or leaves
`AWAITING_APPROVAL` or `VERIFYING` and the stage changes as a result, so a client following the
stream sees `verifying` and `awaiting-approval` without polling.

## Rules for clients

- A client MUST treat `stage` as the plane's answer and MUST NOT recompute it from `state`.
  Cockpit vendors `contracts/task-stage/v1` SHA-pinned (VENDORED.json) when it shows the stage.
- The field is additive. A client written before 2.9 ignores it; nothing else in either read
  changed.
- A client MUST tolerate an unknown `value` or `rule` from a newer minor (show it verbatim, or as
  unknown). A new stage or rule is a minor bump of this contract and of the API.

## Versioning

`stage` arrived in API 2.9. The schema's `$id` carries `v1`; a breaking change (removing a stage,
re-meaning a rule) is a v2 and a major API bump.
