# Session-input delivery state captures — 2026-09-20

Production Vite bundle, an isolated Fastify/SQLite test workspace, real kernel
state, a scripted `FakeAdapter` for execution and a scripted
`FakeSessionInputAdapter` for delivery, injected clock. Fixture labels
(`fake-a`, `fake-1`) are not live provider data. No credentials and no provider
transcripts are included.

Every state below was produced by the plane, not by the UI. The delivery
adapter declares neither `receiptLookup` nor `idempotentSend` and loses exactly
one acknowledgement, which is the only way `manual_recovery_required` is
reachable: the provider really does hold the message, the plane really cannot
tell, and a blind resend really could deliver it twice.

Reproduce: `pnpm --filter @agent-plane/web build`, then
`pnpm --filter @agent-plane/web exec playwright test --project=chromium session-input-delivery.spec.ts`.
Transient originals: `apps/web/test-results/`; the captures below are committed
so another browser run cannot erase acceptance evidence.

Full-page captures pin the docked composer in flow (`.shell-dock { position: static }`)
for the screenshot only. On screen it stays docked to the viewport bottom, so an
unpinned full-page capture would overlay the transcript and misrepresent the state.

| Capture | Meaning |
| --- | --- |
| [Shell · delivery unknown](shell-delivery-unknown.png) | 1440×1000; the follow-up is in the transcript with the attempt's own diagnostic. Not "sent", not "failed" — an attempt was taken and the outcome is unknown |
| [Shell · manual recovery](shell-manual-recovery.png) | The same message after a retry that could not reconcile it: named as unresolved, toned as needing a person, with what retrying will and will not do, and the plane's own retry command |
| [Operator · delivery recovery](operator-delivery-recovery.png) | Traces, `/api/inputs/unresolved`: the same record found without knowing which mission to open, with mission and session identity, the last attempt's diagnostic, and links back into the conversation and the trace |

With `sessionInput.enabled` false — the default — none of this exists: no
transcript section, no Traces section, and no ledger row. That case is asserted
in the same spec rather than captured, because the evidence is an absence.
