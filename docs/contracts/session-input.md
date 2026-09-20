# Durable session-addressed conversational input

2026-09-18 · Proposed next vertical slice. Source audit complete; no API, schema or
provider text-delivery capability is implemented by this document.

## Existing boundary and decision

`POST /api/tasks/:id/input` in `apps/api/src/server.ts` accepts approval responses
only (`kind`, `requestId`, `approved`); arbitrary message input returns 400.
`AgentAdapter.send(handle, RunInput): Promise<void>` has a text variant in its type,
but no idempotency/acknowledgement contract. Claude's implementation rejects
mid-run text and handles pending approvals only; the deterministic FakeAdapter also
does not prove general text input. A `supportsMidRunInput` flag is insufficient.
There is no session-addressed user-message endpoint, persisted input ledger,
delivery-attempt ledger or provider text receipt. Task goals and provider message
events must not be relabelled as delivered conversational user messages.

Harness ApprovalService provides useful durable intent/delivery/unknown-outcome
patterns, including capability-gated redelivery; reuse those principles, not the
approval endpoint or an artificial approval request for ordinary input. Current
approval UI says recorded when the kernel records the choice, without claiming
provider delivery. Start/retry/continue/context actions are lifecycle commands,
not arbitrary conversation. Parallel execution requires an explicit session owner.

Implementing this safely requires persistence migrations, session ownership,
adapter capabilities, ack semantics, recovery and API authorization together.
That exceeds a route/UI boundary. This pass therefore implements the truthful
frontend boundary and specifies one provider-independent slice for separate review.

## Proposed API and persisted records

`POST /api/sessions/:sessionId/inputs` with `{ clientMessageId, text, expiresAt? }`.
Client generates the opaque idempotency key **before** the first request and keeps
it for retry. Workspace is derived from authenticated server context, not trusted
from the body. Resolve session → task → workspace and authorize command access;
reject cross-workspace IDs without revealing existence. Bound text size, expiry
and request rate. Reject unsupported input kind/capability before dispatch.

Persist one user-input row: server message ID, workspace/task/session IDs,
clientMessageId, payload fingerprint, text, actor, creation time, expiry, state,
reason and version. Unique `(workspace, session, clientMessageId)`. Same key and
payload returns the original record; different payload returns 409. The initial
transaction creates the record and dispatch/outbox intent together. A successful
202 response means kernel persistence only. A lost response is retried with the
same key, never a new logical input. Do not automatically retarget a successor
session; retain the original identity in terminal records.

Persist a separate attempt row per dispatch: attempt ID/ordinal, message ID,
execution owner and lease epoch, adapter/runtime, start/end times, capability
version, provider receipt/reference, outcome and bounded diagnostic code. Never
store credentials or unrestricted raw provider responses in receipts.

`GET /api/sessions/:id/inputs` returns canonical messages/receipts with cursor;
`GET /api/inputs/:id` resolves a lost response after authorization. A retry command
references the original message ID and expected version, not replacement text.
Return conflict if ownership/session version changed. Old approval API semantics
remain compatible. Proposed names are reviewable contracts, not currently valid
API routes.

## State and acknowledgement semantics

| State | Meaning | UI delivery wording |
| --- | --- | --- |
| queued | Persisted; waiting for eligible dispatch | Recorded · waiting to send |
| accepted | Current dispatcher accepted the attempt; provider delivery not established | Sending · confirmation pending |
| delivered | Adapter produced the declared sufficient provider acknowledgement | Provider confirmed; show receipt level |
| rejected | Definitive capability/policy/session/provider rejection before successful delivery | Not delivered · reason |
| expired | Deadline passed while definitely undispatched or positively rejected as stale | Expired · not delivered |

An attempt may be `outcome_unknown` after send-before-ack crash, timeout or lost
transport. Keep the message accepted with explicit unknown delivery metadata;
never turn uncertainty into rejection/expiry, show “sent”, or retry blindly.
Reconcile by provider receipt lookup or repeat the **same** idempotency key only
when the adapter guarantees idempotent delivery. Without either capability,
require explicit recovery and show possible delivery. A recorded process write
is not provider acceptance. An assistant response alone is not a reliable input
receipt unless the provider associates it with the input ID.

Capability negotiation declares supported input kinds, eligible lifecycle states,
acknowledgement level (transport/provider accepted/provider consumed), provider
idempotency, receipt lookup and cancellation semantics. `delivered` requires the
agreed provider-level receipt; transport-only adapters cannot claim it. Persist
the capability version used per attempt. No blanket promise of exactly-once
external effects; prove logical deduplication and state the provider limitation.

## Session-state behavior

| Session condition | Policy for a new text input |
| --- | --- |
| Running | Queue; dispatch only if the adapter explicitly supports live text and current lease owns this session |
| Waiting for input | Accept only the expected text capability; distinguish task wait reasons from a conversational prompt |
| Approval-blocked | Queue without bypassing approval; approval answer uses the approval contract, not text |
| Quota-paused | Persist queued with quota reason/deadline; scheduler owns recovery, no local retry timer launching a provider |
| Compacting | Queue under context-policy barrier; release after verified completion with same session identity, otherwise require explicit retarget |
| Completed | Reject new input; a continuation/new session is an explicit lifecycle action with new target |
| Failed | Reject new input until explicit recovery creates/identifies an eligible live session |
| Cancelled | Reject new input; never restart by sending text |

Previously queued rows on terminal transition expire or reject only if known
undispatched. In-flight unknown attempts remain auditable and are reconciled;
late acknowledgement cannot revive the session. Context overflow is a policy
decision before dispatch, not permission for an adapter to silently compact or
change model. Serialize dispatch against approval, compaction and cancellation
using session version/lease fencing. Cancelled provider work may still have effects;
retain receipt history and do not erase the user's input.

## Recovery, traces and authorization

Use durable outbox/event writes in the same transaction as state changes. Proposed
normalized events: `input.queued`, `input.accepted`, `input.delivered`,
`input.rejected`, `input.expired`, `input.delivery_unknown`; include stable event,
message, attempt, session, task and workspace IDs, actor, timestamp and safe reason.
Operator and Shell subscribe to the same records. Normalize provider references,
preserve event ordering/cursors and deduplicate adapter replay. Trace display
cannot advance message state independently of persistence.

On restart, acquire a new lease epoch, reconcile attempts before dispatch, and
fence the old owner. Never recover by generating new clientMessageIds. Re-evaluate
authorization and workspace ownership on retry, receipt lookup and event reads.
Use existing local browser/headless authentication; remote authorization is a
separate prerequisite. Inputs and receipts follow workspace retention/deletion
policy; no browser durable shadow transcript or unscoped diagnostic export.

Goal creation also lacks a client idempotency key today. Document its ambiguous
response behavior; extend it separately or in a follow-on command-envelope slice
before claiming every user intent has durable retry semantics.

## Smallest implementation and review gate

1. Add migrations, repository and command service for records/attempts/outbox,
   session/workspace authorization and exact idempotency semantics.
2. Add capability/receipt types and a deterministic adapter supporting receipt
   lookup and idempotent replay. All existing adapters default to unsupported.
3. Add API reads/command, normal traces and crash recovery behind a default-off
   feature gate. Do not add real-provider behavior or UI optimistic delivery.
4. Validate duplicate keys, conflicting payloads, lost HTTP response, pre/post-send
   restart, stale lease, unknown delivery, receipt reconciliation, TTL, cancellation
   races, every lifecycle row above, parallel sessions, workspace isolation and
   hostile auth/origin. Assert one logical row and no duplicated fixture effect.
5. Review persisted outcomes before wiring shared Shell/Operator delivery cards.
   A live adapter slice follows with actual provider acknowledgement evidence;
   a typed `send` method or successful stdin write is not sufficient acceptance.

Review outcome for this pass: boundary is explicit and consistent with current
source; backend implementation and stakeholder acceptance remain deferred.

## Implementation status — 2026-09-20

The first vertical slice of §"Smallest implementation and review gate" is
implemented on `feat/agentic-os-session-input`, behind `sessionInput.enabled`,
which defaults to **false**. While the flag is false the routes below are not
registered at all, no ledger row is ever written, and the Shell composer keeps
its pre-slice disabled wording. Migration `025_session_input.sql` applies
unconditionally so enabling the flag later needs no schema step.

Implemented and covered by tests:

* `POST /api/sessions/:sessionId/inputs`, `GET /api/sessions/:sessionId/inputs`
  and `GET /api/inputs/:id`. These names are now valid routes **when the flag is
  on**; they remain absent otherwise. 202 means kernel persistence only; a
  message refused on arrival answers 422 carrying its persisted record.
* `session_inputs`, `session_input_attempts`, `session_input_events` with the
  unique `(workspace, session_id, client_message_id, generation)` key, the payload
  fingerprint, per-attempt lease epoch and capability version, and the
  normalized `input.*` events written in the state-change transaction.
* The five-state machine, with `accepted -> expired` deliberately absent.
* The session-condition policy for all eight conditions in §"Session-state
  behavior". Seven are derived from kernel records; `compacting` is policy-only,
  because the kernel has no compaction record yet (K10 is unimplemented).
  Inventing one would be a false audit.
* Capability negotiation (`kinds`, `ackLevel`, `idempotentSend`,
  `receiptLookup`, `liveDelivery`). `delivered` requires a provider-level
  acknowledgement; a transport-only adapter leaves the message `accepted` with
  explicit unknown delivery.
* Restart fencing by lease epoch, and unknown-outcome reconciliation by receipt
  lookup, by declared-idempotent replay of the same message id, or — with
  neither — by refusing to send again and requiring explicit recovery.
* One deterministic adapter, `FakeSessionInputAdapter`. Every real provider
  resolves to no input capability and is rejected before dispatch.

Still deferred, and still only proposed text above:

* Any live provider adapter and its actual acknowledgement evidence.
* Retention/deletion policy for inputs and receipts, and the goal-creation
  idempotency key noted above.
* Operator/Shell delivery cards beyond the minimal flag-gated Shell composer.

## Commands and redelivery — 2026-09-20

The second slice closes the two operational gaps above. Both are behind the same
`sessionInput.enabled` flag, which still defaults to **false**, and both still
use `FakeSessionInputAdapter` only. Migration `026_session_input_commands.sql`
applies unconditionally, like 025.

### Retry and cancel over a message id

`POST /api/inputs/:id/retry` and `POST /api/inputs/:id/cancel`, addressed by
MESSAGE id rather than session id, both accepting an optional
`expectedVersion`. Authorization is re-evaluated per command exactly as on the
send path: a record outside the caller's workspace answers 404 rather than
revealing that it exists. A command the record's own state forbids answers 409
with a machine-readable `reason` — never a silent no-op, because "nothing
happened" and "we refused, here is why" are different facts to an operator.

Retry is legal from exactly two places, and the difference is the safety
argument:

| From | What retry means | Why it is safe |
| --- | --- | --- |
| `accepted` + unknown delivery | Reconcile: receipt lookup, or a declared-idempotent replay of the SAME message id | Never a second send; identical to the recovery path the ambiguous-delivery tests prove |
| `rejected` | A successor row in the same retry chain | The refusal was definitive, so nothing was delivered and a fresh attempt cannot duplicate anything |

Every other state is refused: `accepted` with a live attempt as
`delivery_in_flight` (exactly the ambiguous-delivery case — sending on top of an
unresolved attempt is the double-delivery bug), `queued` as `not_dispatched`,
and `delivered`/`expired` as `already_settled`.

A retry of a rejection does **not** reopen the terminal record. `rejected` stays
terminal exactly as the state machine proved it: the settled row keeps its
identity, its reason and its trace, and a successor row inherits the client
message id, the payload fingerprint and the text — copied in SQL so the
inherited identity cannot drift — under the next `generation`. The chain is
still one logical message to its client: a resubmit of that client key resolves
to the newest generation, which is its live incarnation. The uniqueness key is
also the fence: two concurrent retries of one row compute the same next
generation, so exactly one creates it and the other adopts the winner.

Cancel is legal only from `queued`, and settles the message `rejected` with
reason `cancelled_by_actor` — an edge the state machine already had. A cancel of
an already-dispatched message is refused with `already_dispatched` rather than
silently ignored: the provider may already hold the text, and the plane cannot
recall it. A cancel that loses a race to a dispatch is reported as what is now
true, not as the race.

Both commands emit their own normalized trace event — `input.retry_requested`
and `input.cancelled` — distinct from the send's events. They are intents,
recorded even when they change no state; any state change they cause still emits
its own `input.*` event afterwards.

### Scheduler-owned redelivery

A message queued behind a quota pause or a pending approval resumes on its own
when the condition clears, with no client action. The driver is the kernel's
existing task-state announcement — the `{kind: "state"}` frame the orchestrator,
the scheduler and the harness event recorder already publish on the task bus.
The session-input module owns no timer and does no polling, as the contract's
quota rule requires. The bus gained one in-process fan-out subscription
(`subscribeAll`) because a redelivery consumer cannot know in advance which task
ids to subscribe to; the signal itself is unchanged.

Scope is deliberately narrow: only messages queued with reason `quota_paused` or
`approval_pending` are reconsidered. `context_barrier` is **not** in scope —
compaction remains policy-only until the kernel has a compaction record (K10).

A redelivery is an ordinary dispatch, so it inherits every guarantee already
proven: the same idempotency, the same lease-epoch fencing, the same
ambiguous-delivery rules. The pump is serialized and runs off the publish stack,
so two announcements can never dispatch one message twice, and a publish inside
a SQLite transaction cannot re-enter the database. Losing a race to a concurrent
client command is the fence working, not a pump failure.

The hard case this slice adds is proven end to end: while an automatic
redelivery is parked inside the adapter with the provider already holding the
text, a client retry for the same message is refused with `delivery_in_flight`;
one attempt exists, the provider holds the message once, and only after a
restart fences the dead owner's attempt into a known-unknown does a retry become
legal — and it then reconciles rather than re-sends.
