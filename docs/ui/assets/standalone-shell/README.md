# Standalone Shell-mode captures — 2026-09-19

Production Vite bundle, isolated Fastify/SQLite test workspaces, real kernel state,
scripted FakeAdapters, injected clock. Fixture labels (`fake-a`, `fake-1`,
`[FAKE:APPROVAL]`) are not live provider data. No credentials or provider
transcripts are included. Reference inspected:
`/home/ubuntu/workspace/reference-images/agentic-os-target.png`.

Reproduce: `pnpm --filter @agent-plane/web build`, then
`pnpm --filter @agent-plane/web exec playwright test --project=chromium standalone-shell.spec.ts`.
Transient originals: `apps/web/test-results/`; the captures below are committed so
another browser run cannot erase acceptance evidence.

Full-page captures pin the docked composer in flow (`.shell-dock { position: static }`)
for the screenshot only. On screen it stays docked to the viewport bottom, so an
unpinned full-page capture would overlay the transcript and misrepresent the state.

| Capture | Meaning |
| --- | --- |
| [New mission](new-mission-desktop.png) | 1440×1000; `#/shell`, history rail, welcome, docked composer, draft retained across a mode round trip |
| [Routing preview](routing-preview.png) | Persisted unstarted mission, proposed assistant, zero runs |
| [Completed mission](completed-mission.png) | Normalized transcript from the kernel event ledger; goal recorded, provider delivery not claimed |
| [Approval required](approval-desktop.png) | Durable pending request inline in the conversation, session identity, Approve/Deny |
| [Orbit panel](orbit.png) | Per-mission orbit, opened on demand; participation follows observed execution only |
| [Empty history](empty.png) | No missions recorded; not confused with an unavailable read |
| [Loading history](loading.png) | Read in flight; no fabricated list |
| [History unavailable](history-unavailable.png) | `/api/tasks` 503; alert states the listing is stale |
| [Mission unavailable](mission-unavailable.png) | Selected mission read fails; approvals withdrawn, no stale controls |
| [Laptop](laptop.png) | 1280 width |
| [Tablet](tablet.png) | 900 width |
| [Mobile](mobile.png) | 390 width |
| [Narrow](narrow.png) | 320 width; no horizontal overflow |
| [Reduced motion](reduced-motion.png) | `prefers-reduced-motion: reduce` |

Differences against the target reference, all deliberate: the target renders an
Operator dashboard, so Shell mode drops the left application rail for a mission
history rail and a single transcript column. Suggested-action chips, `Search`,
`Attach` and `Tools` composer affordances from the reference are not shown because
no backend supports them; attachments are labelled a future capability instead. The
follow-up composer is present but disabled — session-addressed text delivery has no
contract yet (`docs/contracts/session-input.md`).
