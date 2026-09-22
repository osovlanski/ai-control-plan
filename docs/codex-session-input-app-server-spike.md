# Codex app-server session-input spike

2026-09-22. Historical experiment: **BLOCKED** at attachment to the existing
SDK execution owner's active thread. No input adapter existed at that stage.
The subsequent [provider implementation](codex-session-input-adapter.md) adds an
explicitly opted-in app-server execution owner; SDK-owned threads remain
unavailable. The observations below describe the original experiment.

## Scope and reproducibility

Parent: shared live-input prerequisite `0221ab2`, based on redelivery `f48ff48`.
Claude is a sibling provider implementation, not a dependency. The dirty
checkout, decision-service work and PR #48 are excluded.

The documented protocol is `initialize` / `initialized`, `thread/resume`,
`thread/read`, `turn/steer` with `expectedTurnId`. Official reference, accessed
2026-09-22: <https://learn.chatgpt.com/docs/app-server>. A steer response names
the accepted turn; that does not establish a receipt for a caller's message ID.

Run the bounded experiment from the repository root:

```sh
LIVE_CODEX_APP_SERVER_SPIKE=1 \
  SPIKE_REPORT_PATH=/tmp/codex-app-server-summary.json \
  pnpm --filter @agent-plane/api exec tsx \
  ../../packages/adapters/spikes/codex-app-server.mts
```

The default binary is the installed SDK's own Linux CLI, version 0.154.0 for this
run, on arm64. The PATH CLI (0.155.1) was not substituted. `SPIKE_CODEX_BINARY`
can explicitly override both sides for a future version-specific experiment.
The script starts the real, unchanged `CodexAdapter`, waits for its normalized
`tool.started` event, and addresses only `handle.providerSessionRef`. It asks
for one `sleep 40` in a fresh temporary Git workspace, bounds the run at 90
seconds, and cancels its own execution in cleanup. It does not send follow-up
input through SDK stdin, start a second provider thread, or call `turn/start`
on a competing execution owner.

The JSON-RPC client is experiment tooling under `test/support`, with no shipping
export or production wiring. Five deterministic tests cover initialization,
fragmented responses, exact steer parameters, transport-only acknowledgement,
response timeout, disconnect, late responses, malformed frames and no replay.
It rejects server-initiated tool requests; no automatic approvals are granted.

Initial local launch attempts failed before provider execution because the
probe used CommonJS resolution for the ESM-only SDK and then the obsolete
native binary layout. The final script resolves the import and current `bin/`
layout; the real run below completed its observations. These setup errors are
not evidence about the protocol.

## Empirical observations

The committed [metadata capture](evidence/codex-app-server-spike-2026-09-22.json)
contains exact error responses, IDs, response keys and notification shapes.
Provider message text, transcript contents, credentials, user-agent paths and
raw diagnostic streams are excluded.

| Operation | Observed result while SDK execution was active |
| --- | --- |
| `initialize` | Response keys: `userAgent`, `codexHome`, `platformFamily`, `platformOs` |
| `thread/read`, `includeTurns: true` | Same thread ID; status `notLoaded`; stored turn reported `interrupted` despite ongoing SDK tool execution |
| `thread/resume` | JSON-RPC error `-32600`: `thread <id> already has an active writer` |
| `turn/steer` using the provider's recorded turn ID | JSON-RPC error `-32600`: `thread not found: <id>` |
| Restart app-server; repeat `thread/read` | Same history and `notLoaded` status; SDK execution still active |
| Read this experiment's own durable file | Exact follow-up marker absent; no message-identity receipt established |

Notifications were `remoteControl/status/changed` and `deprecationNotice`.
There was no successful steer response, input item event, provider delivery
receipt, or consumption event for the follow-up. The SDK emitted `run.started`,
`message`, `tool.started`, then `error` / `run.ended` on deliberate cancellation.
The historical thread read is not an attachment or a live capability probe.
Restarting a reader did not transfer active execution ownership.

## Ack ceiling and reconciliation

No live acknowledgement was earned: the follow-up was refused. For a future
successful steer, the conservative ceiling remains **transport** until a
provider-authored event or durable record proves incorporation of that exact
message. The protocol test refuses to upgrade a turnId-only response even if
an extra field purports to claim `provider-consumed`.

No caller-message-id idempotency or reliable receipt lookup was demonstrated.
An ambiguous non-idempotent send must never be replayed; an inconclusive lookup
must throw `SessionInputUnresolvedError`, leaving `accepted` with unknown
delivery and `manual_recovery_required`. Marker absence in this refused-send
experiment does not establish an authoritative negative-lookup algorithm for
future ambiguous sends. Restart/disconnection does not provide such an algorithm.

Production remains `adapter_input_unsupported` for Codex. The workspace flag
still defaults off. A future adapter must additionally use the shared explicit
per-session opt-in gate, verify app-server reachability and the exact live
session identity, and report unavailable when either cannot be established.

## Exact remaining prerequisite

A separate app-server cannot take ownership of a thread actively owned by
`codex exec`. Supporting live input requires a reviewed execution-transport
change: the same `AgentAdapter` run must be launched/owned through a persistent
app-server connection that the input adapter can address. That migration must
preserve run events, cancellation, sandboxing, approval boundaries, provider
identity and the default SDK path when disabled. It is not proven by creating
an unrelated app-server thread and was not implemented after the requested stop
condition triggered.

The ownership prerequisite is implemented in the subsequent provider slice.
Do not infer provider delivery or publish available capability from a successful
history read, JSON-RPC response, or matching historical thread ID.
