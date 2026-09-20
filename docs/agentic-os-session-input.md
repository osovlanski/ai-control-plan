# Durable session-addressed conversational input — implementation record

2026-09-20. Branch `feat/agentic-os-session-input`, built on the standalone
Shell slice (`a7401a3`). Contract: [`contracts/session-input.md`](contracts/session-input.md).

## What this slice is

The smallest truthful, provider-independent implementation of durable
conversational input: a user message addressed to a specific execution session
is persisted with a client-generated idempotency key **before** any delivery is
attempted, moves through an explicit state machine, and can be retried after a
crash or a lost acknowledgement without ever producing a second logical message
or a second provider delivery.

The whole capability is off by default. `sessionInput.enabled` is false in every
workspace unless an operator writes it into `config.yaml`; there is no
environment override, because the capability writes durable provider-facing
records. With the flag off the routes are not registered, so the API behaves
exactly as it did before this branch.

## Design

**State machine** (`packages/core/src/session-input.ts`)

| State | Meaning |
| --- | --- |
| `queued` | Persisted; waiting for an eligible dispatch |
| `accepted` | A dispatcher took an attempt; provider delivery not established |
| `delivered` | The adapter produced the declared provider-level acknowledgement |
| `rejected` | Definitive capability, policy, session or provider refusal |
| `expired` | Deadline passed while the message was definitely undispatched |

`accepted -> expired` is not a legal edge. Once an attempt has been taken the
outcome may be unknown, and turning uncertainty into a terminal "not delivered"
would be a false audit. Such a message stays `accepted` with
`delivery_unknown = 1` and an `input.delivery_unknown` trace.

**Idempotency.** `UNIQUE(workspace, session_id, client_message_id)` plus a
payload fingerprint. The same key with the same payload returns the original
record; the same key with different text is a 409, because that is a client bug
and not a retry. The row and its `input.queued` trace are committed in one
transaction before any adapter call, so a lost HTTP response costs nothing: the
client resubmits its key and converges on the same message.

**Attempts and the ambiguous case.** An attempt row is written `in_flight`
*before* `deliver()` is called, carrying the dispatcher's lease epoch, the
adapter and the capability version it was made under. A failure that is not a
definitive `SessionInputRejectedError` is recorded as `unknown`, never as
rejected — the adapter may have delivered before it failed. On boot, any
`in_flight` attempt from a different lease epoch is fenced to `unknown`, which
is how a process kill between send and durable outcome is recognised.

Reconciliation of an unknown outcome, in order:

1. `receiptLookup` — ask the provider what it holds. A receipt settles the
   message `delivered` with no second send; a null answer is authoritative that
   nothing arrived, so a fresh attempt cannot duplicate anything.
2. `idempotentSend` — re-deliver the SAME message id, which the adapter
   deduplicates by declaration.
3. Neither — refuse to send, mark `manual_recovery_required` and wait for a
   human. A blind retry is exactly how a double-delivery happens.

**Adapter seam.** `SessionInputAdapter` is deliberately not `AgentAdapter.send`:
that method has no idempotency, receipt or acknowledgement contract, and a typed
`send` is not acceptance evidence. `FakeSessionInputAdapter` was the only
implementation in the original slice; the live Claude Code adapter has since
landed on the same seam, and every other real provider still resolves to no
capability and is rejected before dispatch.

**Where a person sees it.** Delivery state only the plane can see is not state
anyone can act on. Two flag-gated surfaces read it and hold none of their own:
the Shell transcript renders each follow-up from the session's input ledger, and
Traces renders `GET /api/inputs/unresolved` — every message in the workspace
whose delivery cannot be accounted for, across sessions. `delivery_unknown = 1`
is that whole set by construction, so `manual_recovery_required` is a
distinction on the row rather than a second query. Both surfaces name manual
recovery as itself instead of softening it into "unconfirmed", and offer only
the commands `canRetryInput` / `canCancelInput` already accept, so no button
returns a 409.

**Traces.** `session_input_events` is its own ledger, for the same reason
`scheduler_events` is: these events exist before and independently of provider
run events and must not fabricate a per-run sequence number. Every event carries
message, attempt, session, task and workspace ids, the actor and a safe reason.

## Validation

For the original slice: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`
(941 API + 56 web), `pnpm test:harness-on`, `pnpm test:recovery-chaos` and the
Chromium E2E project, plus a clean-checkout install/build/test verification.

After the delivery-state surfaces (2026-09-20): the same gates green at 976 API
+ 61 web unit tests and 34 Chromium E2E tests, against a 970 + 57 / 32 baseline
at `da1f7d0`.

The two correctness cases are in `apps/api/test/session-input-recovery.test.ts`.
The restart is simulated deterministically in-process: the server instance and
its database handle are closed mid-delivery and a new server is built over the
same SQLite file with a new lease epoch, while the provider double survives as a
real provider would. No child process is forked.

## Not in this slice

No default-on flag, no Sirius/NanoClaw work and no deployment change.
`compacting` is a policy arm only — the kernel has no compaction record until
K10 exists.

Two things landed on top of this slice on the same branch stack and are recorded
with it: the live Claude Code adapter (contract §"Live delivery against the real
Claude Code CLI") and the delivery-state surfaces above, whose visual evidence
is [3 captures](ui/assets/session-input-delivery/README.md). Still absent:
adapters for any other provider, delivery evidence for a provider's own turns,
and attachments.
