# Orbital operator console — visual language (UI v2)

The Orbital board is the awareness layer of the Agentic OS operator UI; the
inspector beside it is the precision layer. Everything the board draws is
derived from persisted K1–K3 kernel truth (`/api/tasks`, `/api/tasks/:id`,
`/api/scheduler/status`, `/api/assistants`, `/api/cooldowns`). The board never
invents state, and it never forecasts time.

## 1. Shell

| Region | Role |
|---|---|
| Left rail | System navigation: **Orbital** (board), **Intake** (new mission), **Agents** (assistant catalog). Same three screens as before; the routes did not change. |
| Top bar | Brand, workspace, and the **system health pill** — scheduler armed / idle / disabled, due conditions and open dispatches, read from `/api/scheduler/status`. |
| Command bar | The one obvious way to issue work. Submitting sends the goal to Intake, which creates the task and previews routing before anything runs. |
| Status row | Running / need you / waiting for the scheduler / settled counts — the same partition the core ring draws. |

## 2. The execution field

Geometry lives in `apps/web/src/orbital.ts` (`RINGS`, `layoutBodies`,
`pointAt`, `ringPath`, `arcPath`); rendering lives in
`apps/web/src/board/OrbitalField.tsx`; tokens in `apps/web/src/styles/tokens.css`.

**Ring = state group. Angle = index.** Neither is a forecast.

| Ring | States | Why |
|---|---|---|
| Inner | `ROUTING`, `RUNNING`, `HANDING_OFF` | In motion — closest to the core |
| Middle | `WAITING_RESOURCE`, `WAITING_INPUT`, `LIMIT_PAUSED`, `CREATED` | Held — something must happen before execution |
| Outer | `COMPLETED`, `FAILED`, `CANCELLED` | Settled — history, faded, labels on hover/selection only |

Bodies are HTML buttons riding the same SVG path the ring draws
(`offset-path` + arc-length `--phase`), so keyboard focus, `aria-pressed` and the
semantic arcs all agree on where a body is. A rectangle-aware separation pass
keeps labels from overlapping (asserted in `orbital.test.ts`).

### Semantic mapping

| Kernel truth | Visual |
|---|---|
| `RUNNING` / `ROUTING` | Luminous body, expanding pulse ring, slow local drift along its orbit; the sphere's inner energy layer breathes while anything runs |
| `WAITING_RESOURCE` (K1 time / K2 quota) | Hollow, still body; a dashed **wake horizon** arc ahead of it on the orbit. A K2 quota wait adds a broken **blocker arc** behind it |
| `WAITING_INPUT` | Amber **beacon** (breathing glow, dashed halo) — a person is needed, and the scheduler will not wake it |
| `LIMIT_PAUSED` | Limit tone with a broken arc around it |
| `HANDING_OFF` | Lavender body with a trailing glow toward where it came from |
| `COMPLETED` / `FAILED` / `CANCELLED` | Small, faded, outer ring; failure keeps a restrained red |
| Selected mission | Enlarged body with a halo; the inspector follows |
| Provider constellation | One satellite per configured assistant on the outer track. Lit when it is executing the selected mission; dashed orange when it is on a cooldown |
| Core | `live missions` = missions the kernel still owns. The ring around the sphere is the workload partition (running / need you / waiting / settled) in the same colours as the status row. The eyebrow reads *Executing*, *Holding* or *Idle* |

Motion is reserved for meaning: execution drifts, attention beacons, arrivals
flash. `prefers-reduced-motion` freezes all of it; the static frame reads the
same because every state also has a shape.

### Planned, not drawn

A scheduled/future occurrence (K5) would be a prospective position on the middle
ring with a distinct hollow-dashed body and a horizon arc. Dependency waits (K4)
would draw a link to the blocking mission. Neither exists in the backend, so the
field draws neither; the inspector lists them as `Planned`.

## 3. The inspector

Header: state badge, goal, task id, one-sentence reason. Then the **decision
strip** — *Decided* (run/route target), *Because* (`ruleFired`, or the wait
reason), *Next* (derived by `nextStep()` from the wait condition, scheduler
enablement and state). Then the tabs Demo A relies on: Execution, Decision,
Context, Schedule, Quota. Operator controls (Run now, replace wait, cancel)
stay in the Schedule tab.

Future sections (model intelligence, composition, attached skills/MCP/memory,
context pressure, dependency/schedule state) are listed under Context as
`Planned` with their milestone. They are not mocked.

## 4. Design tokens

- Environment: near-black blue base with two soft light sources and a grain
  layer, generated in CSS — no image.
- One accent (ion teal) for execution and selection; amber for human
  attention; slate for scheduler waits; orange for limits; lavender for
  handoffs; green for completion; red for failure.
- Type: IBM Plex Sans Variable for UI, IBM Plex Mono for identifiers, times and
  rules (OFL, bundled via `@fontsource`).

## 5. Reference captures

```bash
pnpm --filter @agent-plane/web visual
```

Boots the same deterministic in-process API as Demo A (`e2e/harness.ts`),
seeds one mission per state, and writes to
`apps/web/test-results/visual-*/`:
`1-desktop-active`, `2-desktop-quota-wait`, `3-desktop-needs-you`, `4-laptop`,
`5-mobile`, `6-desktop-reduced-motion`, `7-intake` (plus `-full` page variants).
The Demo A stills in `docs/demo/assets/` come from `pnpm demo:a`.

## PR #26 independent review corrections

The command entry describes its preview-before-run boundary. Intake invalidates
its recommendation after any goal, constraint, repository or profile edit;
starting always uses the currently previewed immutable intent. Earlier previews
remain unstarted missions in the register.

Task state and runtime state are separate. For RUNNING missions, the board reads
existing task detail and session endpoints in batches of at most six missions.
An effective AWAITING_APPROVAL run becomes a stationary amber attention body,
while the inspector retains the explanation that task state is RUNNING. Legacy
runs without durable sessions, and failed runtime reads, display Runtime unknown
without execution motion; they do not imply that approval is safe or absent.
CREATED missions count as ready to start, not as scheduler-owned waits. Only
WAITING_RESOURCE contributes to the scheduler-wait count. LIMIT_PAUSED alone does
not prove that the automatic wake budget was exhausted.

Provider highlights are tied to the selected task ID and every currently
running, unended session. Disabled/auth-unavailable/unknown providers and cooldowns
have explicit labels. No model catalog or model intelligence is inferred.

The field admits at most eight bodies, further limited by label footprints at
the actual scene scale. Selection has priority; the count links to the complete
register. Attention and unfinished missions precede history. The desktop shell,
state colours, sphere and motion vocabulary are retained. Mobile command entry
and full task toolbars/tabs wrap within the viewport.

The browser harness now uses the server's existing Registry dependency injection
and public adapter method, without accessing its private map. The visual approval
is produced by the real Execution Harness using FakeAdapter, not a fabricated
session row. Browser time matches the injected kernel clock. Additional review
coverage lives in `apps/web/e2e/review.spec.ts`.

Session detail renders durable pending approvals with the existing Approve/Deny
command, including when the task was opened after the request arrived. This
closes the board → inspector → full controls → Sessions path without depending
on a live-only SSE approval event. Approval authorization and provider delivery
remain backend-owned and unchanged.
