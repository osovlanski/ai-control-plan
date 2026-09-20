# Current-shell preservation captures — 2026-09-18

Production Vite bundle, isolated Fastify/SQLite test workspaces, real kernel state,
scripted FakeAdapters, injected clock. Fixture labels are not live provider data.
No credentials or provider transcripts are included. Reference inspected:
`/home/ubuntu/workspace/reference-images/agentic-os-target.png`.

Reproduce: `pnpm --filter @agent-plane/web build`, then
`pnpm --filter @agent-plane/web exec playwright test --project=chromium --project=visual shell.spec.ts visual.spec.ts`.
Transient originals: `apps/web/test-results/`; the selected captures below are
committed so another browser run cannot erase acceptance evidence.

| Capture | Meaning |
| --- | --- |
| [Desktop Overview](overview-desktop.png) | 1440×1000; real active/held/settled task partitions |
| [Active mission](active-mission.png) | Running adapter held before first message; no invented response |
| [Completed mission](completed-mission.png) | Recorded normalized conversation and explicit follow-up limitation |
| [Routing preview](routing-preview.png) | Persisted mission, proposed assistant, no execution |
| [Approval required](approval-required.png) | Durable pending request, session identity, Approve/Deny |
| [Agents](agents.png) | Configured environments, capability evidence |
| [Memory](memory.png) | Current capabilities and explicitly planned federation |
| [Routing](routing.png) | Link to available per-mission routing evidence |
| [Traces](traces.png) | Link to existing normalized mission/session evidence |
| [Tools](tools.png) | Ownership and missing inventory boundary |
| [Settings](settings.png) | Workspace identity and configuration ownership |
| [Laptop](laptop.png) | 1100×800; preserved two-column composition |
| [Tablet](tablet.png) | 900×1000; stacked composition |
| [Mobile](mobile.png) | 390×844; wrapping rail, no horizontal overflow |
| [Reduced motion](reduced-motion.png) | Infinite animation stopped; all state readable |
| [Empty desktop](empty-desktop.png) | Successful empty task read |
| [Empty mobile](empty-mobile.png) | Same state at 390px; also tested at 320px |
| [Loading](loading.png) | Delayed task read, unknown counts and register |
| [Unavailable](unavailable.png) | Failed provider discovery explicitly identified |
| [Failure](failure.png) | Failed task read, unknown counts/register |
| [Detail unavailable](detail-unavailable.png) | Stale inspector evidence cannot assert provider participation |
| [Quota wait](quota-wait.png) | Kernel-owned wait and reset evidence |

Desktop and state captures were reviewed against the target. The semantic SVG
orbit, restrained glow and longer evidence panels intentionally differ from the
illustration; no decorative “all agents online” status or invented capabilities.
Keyboard, browser history, route focus, reduced motion and overflow are asserted
in the harness. The full-page mobile capture is deliberately tall: this is the
Operator presentation, not yet the standalone conversational workspace.

See [canonical findings and exact validation](../../agentic-os-ui-v3.md#preservation-review--2026-09-18).
