# Orbital operator UI

Implemented in the existing `apps/web` board, against committed kernel-services revision 2
(`56cf244`) and Cockpit Spec E (`e9ab5b0`). This is a frontend change to the shared control-plane
application, not a second deployment. Kernel CR decisions and Cockpit runtime are unchanged.

## Audit and architecture

- KEEP: authenticated API/SSE, task intake and routing preview, assistant overrides, compare/race,
  task controls, session/verification diagnostics and provider discovery.
- MODIFY: flat task-card board into a spatial task map with a synchronized inspector and searchable
  task register; shared UI palette becomes dark; intake stacks on narrow screens.
- ADD: explicit state meanings, run-scoped model evidence, session approval/verification status,
  partial-read errors, planned-capability explanations and a typed context presentation seam.
- REMOVE: pointer-only card navigation. Map and register selection use native buttons.

The map occupies about 48% of the desktop workspace; the inspector occupies the remainder.
Six task bodies maximum keep labels apart. The register exposes every matching task; selecting
one outside the first six brings it into the map. Positions are an index, not timestamps, priorities
or forecasts. Task identities, state text and accessible names carry truth independently of color.
Unknown future task states remain visible. Run selection covers parallel execution and history;
comparison decisions and handoff lineage remain in the existing task detail.

The inspector separates execution, recorded task routing, context and scheduling. Latest task routing
is explicitly not a per-run CompositionDecision. Provider adapter and harness identity remain
separate. Resolved model identity is read only from the selected run's `run.started` evidence;
missing evidence renders Unknown. Discovery models never backfill identity. Requested model and
serving-provider identity are not available from the current run read.

## Capability boundaries

Inspection found **no K1 producer in this checkout**. Time waits/run-now overrides (K1), quota
wake (K2), dependencies (K4), recurrence and occurrence outcomes (K5), model evidence/shadow routing
(M12) and context observation/intervention (M14) are labelled planned/unavailable. No buttons
invoke nonexistent endpoints, no future dispatch choices are invented and no scheduler logic is
implemented. Composer assets and memory are explained as planned, never as attached satellites.

`ContextView` / `ContextReadout` are a narrowly typed presentation seam. Percentage requires fresh,
finite occupancy and a known positive effective window. Advertised maximum and accounting never
substitute for those observations. Current integration passes unavailable values; there is no
context API caller or controller. Provider commands and clean-session continuation await backend
capabilities. No clear/compact workflow is invented.

Reads refresh every four seconds, serialized to avoid overlapping polls, with cleanup and late-response
guards. Failed task reads show the last snapshot as stale; independent inspector failures are named
without hiding the task. Authentication expiry continues through the existing global handler.
No provider is launched by the board. Motion is a brief event-row arrival highlight; reduced-motion
preferences suppress it.

## Verification and follow-up

`apps/web/e2e/orbital.spec.ts` serves the production bundle over loopback with deterministic API
fixtures. It covers selection, search beyond the map cap, unknown model identity, routing exclusions,
planned capabilities, empty/error states, session approval/verification distinctions and partial reads.
It captures 1440px desktop, 1100px laptop and 390px mobile screenshots and checks horizontal overflow.
The existing authentication/SSE suite continues to run against the real API in an isolated temporary home.
These fixture screenshots demonstrate presentation, not shipped kernel services or live provider work.

Follow-up: connect K1/K7/K9 durable reads when implemented; render real composition asset satellites
only when immutable revisions exist; add actual handoff transition geometry once source/destination
run evidence can be represented without guessing. The map intentionally truncates long labels while
the inspector/register expose full goals. Existing deep task-detail layouts still merit a separate
mobile usability pass. No live provider run was necessary for this read-only board change.

Validated 2026-09-05: control-plane `pnpm typecheck`, `pnpm lint`, `pnpm test` (515 tests),
`pnpm build`, and web `test:e2e` (9 tests) passed. Cockpit `npm test` (1,303 tests) and
`npm run build` passed. Rendered screenshots were inspected at all three widths; secondary
inspector type was enlarged and the sphere tightened after the first review. `git diff --check`
passed. Cockpit's four pre-existing untracked proposal directories remain untouched.
