# Standalone Shell · bounded first step

2026-09-18. Design reviewed against the source and preservation commit `64bd08d`;
this is not a claim of stakeholder acceptance of the future backend slices.

## One product, two modes

Shell is focused conversation and execution. Operator is system-wide supervision
and configuration. Both read the same kernel tasks, sessions, events, routing
decisions and approvals through `api.ts`. Orbit is a shared process visualization,
not a lifecycle authority. Harness owns execution/recovery mechanisms under kernel
policy. Cockpit owns durable memory, installed tooling, global configuration and
external-session monitoring under its accepted Spec E ownership record (`a45a750`).
Sirius is an optional integration described in [its specification](../sirius-integration.md).

Use `#/shell` and `#/shell/:taskId`: the existing router uses hash destinations,
including `#/missions/:taskId`, so these links work with the same static server,
authentication bootstrap and browser history without new server rewrite rules.
Operator has a Shell mode link outside its seven-application navigation. Shell
has an Operator link and mission evidence links. Mode selection is presentation,
never a second workspace or API origin.

## Presentation and truth

| Surface | First step | Later boundary |
| --- | --- | --- |
| History | Existing tasks, including unstarted route previews; state labels and task IDs | Pagination/search API when scale warrants it |
| Transcript | Persisted goal, readable normalized events, session ownership and timestamps; bounded recent window with full evidence link; flag-gated follow-ups read back from the input ledger with their delivery state | Attachments and a delivery receipt per provider turn |
| Updates | Existing authenticated SSE invalidates canonical reads; periodic reconciliation and reconnect refresh | Resumable event cursor and heartbeat protocol |
| Composer | Shared goal form, automatic routing, preview then start; persistent draft within mounted mode; flag-gated session-addressed send reusing one client message id | Attachments; a finished conversation experience |
| Context | Allowlisted repository path, constraints, routing profile in disclosure | Attachments, memory recall and tool selection explicitly future |
| Approvals | Same durable pending approvals and task approval command as Operator | Provider acknowledgement exposed separately from recorded decision |
| Commands | Link to existing mission controls, which gate stop/continue/retry/reroute/schedule/context actions by real state | No new unsupported command handlers |
| Identity | Assistant from run, requested selector separate from observed model evidence | Never infer model from assistant brand |
| Pressure | Existing context observation and quota/wait evidence | No invented context percentages or quota balance |
| Orbit | Reuse execution field and effective-state semantics, optionally disclosed | Only participating execution is highlighted |
| Memory/traces | Links to existing mission evidence and Memory destination | No second memory or transcript store |

The goal is labelled **recorded in the kernel**, not provider-confirmed delivery.
New mission is not a claim to clear an existing provider session. A successful
start request is not a message-delivery acknowledgement. A lost create response
is currently ambiguous; inspect history before retrying. Do not manufacture a
delivery badge.

While `sessionInput.enabled` is false — the default — there is no Send button
for arbitrary follow-ups: the composer area explains the missing capability and
offers a new mission and existing controls, and no transcript entry, no ledger
read and no delivery wording exist at all.

With it on, each follow-up is rendered from the plane's own ledger rather than
from what the browser remembers sending, so a reload, a second tab and a
scheduler-owned redelivery agree. The wording never runs ahead of the plane:
`queued` is "recorded · waiting to send", an unknown outcome is never "sent",
and provider receipt is claimed only where one was recorded.
`manual_recovery_required` is named as itself — **delivery unresolved · needs
manual recovery** — with the tone reserved for "a person is needed", because
the plane has decided it will not resend and that is a fact to act on, not a
softer kind of pending. Retry and cancel are offered only where the plane
accepts them, so no button returns a 409.

Shared code: task discovery hook, mission snapshot hook, `MissionConversation`
(compact in Operator, expanded in Shell), `NewTask`, `OrbitalField`, execution and
model identity helpers. Hooks are transient read projections; no new persistence,
localStorage transcript, Shell message table, session IDs or routing implementation.
Unavailable reads are visibly labelled; stale snapshots never imply live execution.
SSE is a refresh hint, not a second event ledger; replacement reads prevent duplicate
append on reconnect. Approval state still comes from durable session records.

## Interaction and accessibility

History is a labelled navigation list; current mission uses `aria-current`. Route
changes focus main. Native links/buttons/disclosures provide keyboard operation;
Ctrl/Cmd+Enter previews a goal, Enter stays a newline. Inputs have unique IDs even
when the Operator draft is retained. Do not steal focus when events arrive or
force scroll while reading history. Long IDs, goal text and summaries wrap.
Desktop has history beside the primary transcript and a composer at the bottom
of the conversation; narrow screens stack history with a bounded scroll region.
The sticky composer must not obscure focused controls. Reuse reduced-motion CSS;
no streaming typewriter, animated text or new motion requirement.

## Acceptance and next slices

Preservation evidence: [canonical record](agentic-os-ui-v3.md) and
[22 screenshots](assets/shell-review/README.md). Standalone implementation evidence
is recorded separately — [14 captures](assets/standalone-shell/README.md) and the
2026-09-19 acceptance section of the canonical record — so the preserved Operator
baseline remains auditable.

1. **Durable conversational input**: the disabled-by-default backend slice of the
   [contract plan](../contracts/session-input.md) — one deterministic adapter plus
   restart and ambiguous-delivery tests — is implemented and recorded in
   [its implementation record](../agentic-os-session-input.md), and the first live
   adapters (Claude Code, then Codex) are implemented on top of it.
2. **Transcript delivery UI**: done for both modes — per-message delivery state
   in the Shell transcript and a cross-session Delivery recovery section in
   Traces, over `/api/inputs/unresolved`. Evidence:
   [3 captures](assets/session-input-delivery/). Remaining: nothing new is
   surfaced for a provider turn's own delivery, and attachments stay future.
3. **Sirius proof**: accept ownership/API seam first, then manifest, isolation,
   deterministic execution, trace/cancel/approval/restart conformance. No live
   capability claim before all safety gates pass.
4. **Authenticated remote mode**: browser identity, origin policy, session expiry,
   TLS, workspace authorization and resumable events. Private preview first.
5. **Execution-worker protocol**: fenced leases, durable dispatch and recovery,
   then evaluate moving the control plane. See [deployment ADR](../adr/agentic-os-deployment.md).

Full provider text delivery, Sirius execution, production hosting, attachments,
durable-memory editing and replacing all external assistant chats are deferred.
This slice makes the route and shared presentation concrete without claiming
those capabilities exist.
