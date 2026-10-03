# Codex session input: transport only

2026-09-22. Implementation on `feat/agentic-os-session-input-codex-adapter`.

This is the historical **transport-v1** record at `4c0c6bd`; its claims and
manual runner apply to that commit. The later [correlated-receipt investigation
and receipt-v2 implementation](codex-session-input-correlated-receipts.md)
adds evidence-backed lookup on a separate branch.

## Base and contract

The exact common ancestor with Claude `da1f7d0` is
`f48ff484f53669da260537885d6d9edf2459db3e` (redelivery). This branch starts from
its provider-neutral prerequisite `0221ab2`, already present in the Codex
worktree when work resumed. No Claude provider commit is an ancestor.
`packages/core/src/session-input.ts` is byte-for-byte identical to Claude's
interface at `da1f7d0`. No shared interface or Claude adapter changes are made
in this provider slice, and there is no UI work.

The interface's acknowledgement values are `transport`, `provider-accepted`,
and `provider-consumed`. `accepted` and `delivered` are ledger states, not
acknowledgement values. This adapter always declares and returns **transport**.
It cannot cause a message to become delivered.

## Empirical result

The existing `CodexAdapter` uses `@openai/codex-sdk` 0.154.0. Its execution
helper launches `codex exec`, writes the initial prompt, then closes stdin.
That stdin is not a live follow-up channel. The SDK emits thread, turn, tool,
message and usage events; successful initial writes do not prove receipt of
subsequent session input.

The [original same-session attachment experiment](codex-session-input-app-server-spike.md)
found that a separate app-server could read stored history but could not own
or steer the SDK execution's active thread: resume returned `already has an
active writer`, and steer returned `thread not found`. A history read was
therefore not sufficient capability evidence.

This implementation adds an explicitly configured execution path in which one
app-server child owns both the AgentAdapter run and its input channel. The
[official protocol](https://learn.chatgpt.com/docs/app-server) documents steering
an active turn with its expected turn ID. The real run used the SDK's own
**0.154.0** executable, not PATH's **0.155.1**.

The manual run executed one bounded sleep in a temporary Git directory. During
that tool execution, the exact execution owner's input adapter was enabled and
sent a follow-up. The steer response identified the expected active turn. After
completion, a fresh history reader found the marker in a `userMessage` item;
the assistant output also contained it. Thus Codex demonstrably incorporated
this test's text. However, the stored item's `clientId` was null, its ID was
provider-generated, and it contained no caller message ID. Neither the turn
response nor that text match implements a reliable receipt lookup for the
ledger's logical message, especially across crash, timeout and duplicate text.

The adapter conservatively remains transport-only even when output incorporates
the message. It does not infer consumption from an assistant reply, parse raw
rollouts, inject identity markers into user text, or upgrade based on arbitrary
ack fields in a response. A newer local CLI schema exposes
`clientUserMessageId`; its receipt and duplicate-send semantics have **not**
been verified here. This report does not claim that Codex can never support a
stronger contract.

Metadata captures contain IDs, property names and boolean predicates only:
[evidence/codex-session-input-live-2026-09-22.json](evidence/codex-session-input-live-2026-09-22.json).
No credentials, raw diagnostics, message content or provider transcripts are
committed. The committed manual runner is reproducible:

```sh
LIVE_CODEX_SESSION_INPUT=1 \
  SPIKE_REPORT_PATH=/tmp/codex-session-input-live.json \
  pnpm --filter @agent-plane/api exec tsx \
  ../../packages/adapters/spikes/codex-session-input.mts
```

This is a manually invoked real-provider test, not part of the credential-free
unit suite. It checks disabled-before-enable, same-owner live reachability,
transport receipt, duplicate refusal, unavailable-after-exit, and observed
history/output incorporation. It does not prove live crash recovery or live
provider idempotency. Those unknown paths are tested deterministically.

## Enablement and execution

All defaults remain off. A workspace must explicitly configure both:

```yaml
sessionInput:
  enabled: true
assistants:
  codex:
    provider: openai
    options:
      appServerInput: true
```

The second option selects app-server execution for that assistant's new runs.
Existing SDK-owned runs cannot be attached or migrated in place. Other
assistants retain their execution path. Turning the workspace flag off forces
the SDK path even if `appServerInput` is present. Constructors and capability
description launch no process.

For each running session, an authenticated command must then grant input:

```http
POST /api/sessions/:sessionId/input-enablement
Content-Type: application/json

{"enabled":true}
```

The command uses the same write authorization as input submission. It derives
assistant and provider identity from the workspace's own session record; clients
cannot nominate an arbitrary provider thread. Missing sessions return 404,
invalid booleans 400, unsupported/non-running/unreachable sessions 409. Send
`{"enabled":false}` to revoke the grant. All grants are process-local and are
lost on restart. Revocation during a probe prevents sending. The shared
`SessionInputOptInGate` binds session, assistant and provider-session identities.

`GET /api/sessions/:sessionId/input-capability` reports availability only after
that grant and a current `thread/read` round trip on the **execution owner's**
connection confirms the same active thread with no provider waiting flags.
The owner must also have a current turn ID. Disconnect, exit, cancellation,
identity change or history-only `notLoaded` state makes input unavailable.
New input uses the existing `/inputs` route and ledger. With the workspace
flag off, input and enablement routes remain absent and no input adapter is
registered. No grant is implicit in the workspace flag or assistant option.

The app-server path preserves run identity, requested model, cwd, normalized
run/tool/message/file/usage events, bounded cancellation and cleanup. It uses
workspace-write (read-only for an explicit read-only request) and approval
policy `never`; unexpected provider approval/tool requests are refused. Generic
AgentAdapter `send` remains unsupported. No new approval, context-management,
quota-reporting or preventive tool-policy capabilities are advertised. The
SDK path remains unchanged when the option is disabled. Custom SDK account/env/
config overrides are rejected on the opt-in path rather than silently ignored;
only an explicit executable override is supported by the programmatic constructor.

## Unknown outcomes and recovery

Capabilities declare `idempotentSend:false` and `receiptLookup:false`. There is
no `lookupReceipt` method. A local duplicate guard rejects repeated message IDs
without sending again; it is **not** a provider idempotency guarantee.

A valid steer response returns a transport receipt. The service records
`accepted`, `deliveryUnknown:true`, reason `transport_ack_only`. Response loss,
malformed/mismatched replies and RPC errors remain unknown rather than being
misclassified as definitive rejection. A retry reconciles to
`manual_recovery_required`, with the same single attempt and no additional
send. This persists across database reopen and fresh adapter construction.
Revocation, provider exit and expiry cannot turn ambiguity into proof of failure.

There is no automatic resolution path or in-place resend for these attempts.
Manual recovery means an operator must inspect provider history and decide what
work is safe next; this slice adds no “mark delivered”, replay override or manual
settlement endpoint. A new client message can duplicate effects, so it is not a
recovery algorithm. A pre-send unavailable/disabled probe is a definitive refusal
because no provider operation was attempted.

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: passed.
- `pnpm test`: full existing suites passed with zero failures. Final package
  counts, including the subsequent complete adapter-suite and focused API
  reruns after the last identity/option checks: core **118**, adapters **45**,
  API **969**, web **57** (**1,189** tests). The initial all-package invocation
  had 39 adapter tests; the final adapter run includes six added checks.
- `pnpm --filter @agent-plane/web exec playwright test --project=chromium`:
  **32 passed**. Generated tracked screenshots were restored; no UI changes
  are included.
- Two manually invoked real Codex app-server input runs passed on CLI 0.154.0.
  The later metadata capture includes the final single usage snapshot mapping.
  The earlier SDK-owner attachment experiment is documented separately.
- Secret scan: staged, unstaged, last-commit and complete-slice additions were
  clean; only documented Git commit hashes matched the generic token pattern.
- Shared input interface and Claude implementation are unchanged. The flag-off
  configuration and default SDK path pass the existing regressions and the new
  explicit opt-in checks.

Deterministic tests cover the ack ceiling (including forged provider-consumed/delivered fields),
exact thread/turn targeting, grants, revocation races, history-only unavailability,
lost/late responses, disconnect, malformed frames, no approval bypass, duplicate
suppression, same-owner execution, cancellation, stream failures, identity fencing,
authenticated enablement, disabled routes, and database restart without resend.

## Deferred and recommended next slice

Verify `clientUserMessageId` and provider-generated input-item correlation on the
pinned CLI, including duplicate text, duplicate caller IDs, disconnect before
and after response, provider restart, and durable history visibility. Only then
consider provider-level receipts or lookup. Keep this transport capability
version's historical claims unchanged. Broader app-server version/platform
coverage and live restart/cancellation fault injection remain follow-up work.
