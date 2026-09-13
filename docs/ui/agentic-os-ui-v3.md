# Agentic OS UI V3 convergence

Scope: UI evolution from origin/main `8ed98c6` (PR #38), isolated in
`feat/agentic-os-ui-convergence-v3`. The K5 worktree and PR #37 are protected.
Reference inspected: `/home/ubuntu/workspace/reference-images/Agentic_OS_View.png`.
The screenshot supplies visual direction, never an API specification.

## Bounded audit before implementation

| Target element | Current equivalent | Backend support / evidence | Action |
| --- | --- | --- | --- |
| Sidebar | Narrow Orbital / Intake / Agents rail | Three real App views | RECOMPOSE into product rail; retain destinations |
| Branding | Small Agentic OS wordmark | Identity, not operational data | RESTYLE |
| Command composer | Single-line goal → Intake | NewTask creates immutable intent and previews routing before explicit run | RESTYLE; preserve boundary |
| Suggested actions | Goal presets | Ordinary task prompts only | KEEP; use prompts without implying agent provisioning |
| System health | Scheduler pill | `/api/scheduler/status`: enabled, armed, due, open | RESTYLE; never say all agents online |
| Overview cards | Inline partition counts | `fieldPulse(tasks)` / `missionState`, bounded session reads | RECOMPOSE; unknown/loading/error stay explicit |
| Active mission | Full inspector dominates first screen | Selected task + inspector snapshot | IMPLEMENT compact selected summary; do not call every selection active |
| Recent activity | Inspector event list | `/api/tasks/:id/events` only | IMPLEMENT selected-mission activity, label scope |
| Approvals / needs attention | Attention filter, durable Sessions controls | Effective AWAITING_APPROVAL, WAITING_INPUT, LIMIT_PAUSED | RECOMPOSE task list, preserve full approval controls |
| Orbital sphere | SVG shells + semantic HTML bodies | Canonical state partition, actual/shadow relationships | RESTYLE depth and increase visual territory |
| Provider satellites | Configured assistants / model candidates | Discovery auth, enabled, cooldowns, selected execution, K13 evidence | RESTYLE; no invented logos or online state |
| Mission stages | Kernel state and next step | No universal PLAN→BUILD→TEST pipeline | KEEP kernel state; REJECT-AS-FAKE stage tracker |
| Task register | Searchable / filterable task rows | `/api/tasks` | KEEP complete register |
| Inspector | Execution, Decision, Context, Schedule, Quota | Persisted task, routing, sessions, events, context and waits | RECOMPOSE below overview, preserve all evidence and commands |
| Memory | Proposed federation/context design | No integrated memory-management backend | DEFER / omit navigation |
| Routing | Intake preview + Decision tab | Existing routing endpoint and explanations | KEEP through these existing screens |
| Traces | Task event timeline / full diagnostics | Task-scoped events and sessions | KEEP in mission controls; no invented global trace browser |
| Tools | Discovered canMcp/capabilities in Agents | No integrated tool install/management contract | DEFER destination; keep discovered capability evidence in Agents |
| Agents | Catalog, sync, auth, models and evidence | Assistants, cooldowns, changes and model catalog | KEEP / shared shell restyle |
| Settings | No product settings screen | No corresponding settings editor | DEFER / omit navigation |

Design: near-black/navy, blue/violet illumination, restrained gold surface reflections; amber for attention
and advisory contrast. Existing IBM Plex fonts, React and CSS retained.
Design variance 5 / motion intensity 3 / density 5: clear operational hierarchy,
state-driven motion, readable evidence. No new frontend framework or runtime
architecture. The semantic sphere remains SVG + keyboard-operable HTML buttons.

## Truth boundaries

Counts use the existing kernel partition, including ready and unknown states.
Events are explicitly scoped to the selected mission, not a global activity feed.
Unavailable reads are visible. No production fixture data, inferred provider
availability, model identity, execution stage, or K13 activation is introduced.
The complete inspector retains Decided / Because / Next, Execution / Decision /
Context / Schedule / Quota, approvals and full diagnostics. ACTUAL remains solid;
SHADOW remains dashed amber and advisory; waiting remains still/hollow.


## Implemented composition

- Product rail: Agentic OS identity, Orbital (mission overview), Intake (goals and
  routing), Agents (providers and models). Workspace and scheduler state remain
  in the header. Memory, Tools and Settings destinations are omitted; Routing
  lives in Intake/Decision and traces remain task-scoped diagnostics.
- The primary composer has a larger luminous border, visible focus state,
  explicit Route mission action and inline preview-before-run guidance. Four
  ordinary goal presets use the same Intake workflow. No Search, Attach, tool
  invocation, provisioning action or direct-execution shortcut was added.
- System overview reuses `fieldPulse`: running, need you, scheduler waits, ready,
  settled and unknown. Initial/failed reads do not invent zero counts. Stale
  snapshots and unavailable evidence remain visible.
- The existing Inspector is split into a selected-mission summary and complete
  mission evidence below the overview. ACTUAL/SHADOW, Decided/Because/Next,
  Execution/Decision/Context/Schedule/Quota and full controls remain available.
  K13 summaries now retain Decided/Because/Next in the evidence panel as well.
- Recent activity is explicitly the selected mission's last three provider
  events. Needs attention lists real tasks in effective approval/input/limit
  states and selects them; approval decisions still use durable full controls.
- The field uses approximately 47% of the desktop main region. Layered blue and
  violet shells, static refraction contours and specular reflections add depth
  to the existing SVG; all semantic bodies remain HTML buttons. Atmosphere
  breathes only with witnessed execution. No generated image replaces the field.
- Constellation labels have paired positions and readable dark backing. Provider
  initials come from discovered provider identifiers, not hard-coded brands.
  Label footprints are reserved by the existing mission placement algorithm;
  selection receives priority and bodies that cannot fit remain in the complete
  register. Position continues to mean index, never a forecast.
- At 1200px and below the field reflows into a larger stacked composition; mobile
  retains bottom navigation and the complete evidence/register workflow. All
  existing motion honors reduced motion. A skip link and focusable evidence
  anchor improve keyboard navigation; inspector section controls wrap on mobile.

## Validation and visual review

The visual harness now has its documented `visual` package script. Existing
captures are extended with 1920px and 900px cases, real routing-preview evidence,
no-provider-start assertion, field-width bounds and rendered label clearance.
The crowded-field test waits for ResizeObserver's rendered invariant instead of
assuming a fixed 150ms delay. Geometry tests cover constellation obstacles,
selection priority, canonical ring retention and bounded density.

Browser authentication tests use isolated port 4276 because 4176 is owned by a
running headless-open worktree on this host. The CLI test uses its existing
`--origin` option. Production auth/bootstrap code is unchanged.

Self-review: compared baseline and target against active, scheduler wait,
verification, durable approval, K13 shadow, 1920/1440/1280/1100/900/390px,
reduced-motion and Intake captures. Corrected constellation overlap, viewport
compression, shell vertical centering and loading/stale summary treatment.
The field and composer are prominent; semantic shapes remain distinct. Task
labels use ellipsis with the complete accessible name and selected mission
summary/register available. The desktop ACTUAL/SHADOW summary remains visible at
1440×900 and 1280×800. No P0/P1 issue remains in the tested scenarios.

Known P2 gaps: the procedural globe is less cinematic than the concept artwork;
mobile uses dots with model/provider detail in the existing evidence/catalog
rather than tiny orbital labels; very large model catalogs still need a richer
constellation density/pagination treatment. Laptop/tablet reflow deliberately
uses vertical scrolling. No new global activity or resource inventory service
was invented to fill the concept's empty destinations.

## Review captures

The committed bundle contains 12 V3 views and one pre-change baseline. All task,
provider and approval data in these images comes from deterministic test
workspaces and FakeAdapter. No production workspace or provider transcript was
captured. The visual and Demo B runs produce 42 PNG files in total, including
full-page/evidence variants under `apps/web/test-results/ui-v3-final/` (ignored).

| Capture | Viewport / purpose |
| --- | --- |
| [Before](assets/v3/00-before.png) | 1440×1000 baseline from origin/main |
| [Active mission](assets/v3/01-desktop-active.png) | 1440×1000; running plus mixed kernel states |
| [Scheduler wait](assets/v3/02-scheduler-wait.png) | 1440×1000; quota wait, exclusions and paused ACTUAL |
| [Needs attention](assets/v3/03-needs-attention.png) | 1440×1000; human verification decision |
| [Durable approval](assets/v3/04-durable-approval.png) | 1440×1000; approval required, no execution motion |
| [K13 SHADOW](assets/v3/05-k13-shadow.png) | 1440×900; advisory model versus unchanged actual route |
| [Laptop 1280](assets/v3/06-laptop-1280.png) | 1280×800; both truth panels above the fold |
| [Laptop 1100](assets/v3/07-laptop-1100.png) | 1100×800 full page; larger stacked field |
| [Mobile](assets/v3/08-mobile.png) | 390×844 full page; complete evidence and register |
| [Reduced motion](assets/v3/09-reduced-motion.png) | 1440×1000; same static semantic distinctions |
| [Intake preview](assets/v3/10-intake-preview.png) | 1440×1000; real hard-filtered route, zero provider starts |
| [Wide desktop](assets/v3/11-wide-1920.png) | 1920×1080; capped field, readable identity labels |
| [Tablet](assets/v3/12-tablet-900.png) | 900×1000 full page; reflow without horizontal overflow |

## Validation record

| Command / suite | Result |
| --- | --- |
| `pnpm typecheck` | Pass: core, adapters, API, web |
| `pnpm lint` | Pass; no diagnostics |
| `pnpm test` | 994 tests: core 116 / adapters 21 / API 818 / web 39; 73 test files |
| `pnpm build` | Pass |
| `pnpm --filter @agent-plane/web test` | 39 tests in 5 files |
| Chromium (`--project=chromium`) | 15 browser tests |
| Demo A (`--project=demo-a`) | 1 complete walkthrough |
| Demo B (`--project=demo-b`) | 5 scenarios; unchanged provider-request evidence |
| Visual (`pnpm --filter @agent-plane/web visual`) | 1 complete capture flow; extended assertions |

All 22 browser tests pass. Keyboard selection, durable Approve/Deny after reload,
preview invalidation, runtime unknown, failed/partial reads, zero horizontal
overflow and reduced motion are covered. The final visual/Demo B run uses the
same built assets and an isolated output directory. No automated WCAG audit is
claimed; focus, labels, contrast and responsive composition were reviewed in the
rendered browser.


## Change inventory and safety checks

The staged/unstaged secret scan found no credential-shaped additions. The
last-commit scope reported one false positive in merged PR #38: a call to
`selectCredential()`, not a credential literal. Captures contain FakeAdapter
fixtures only. The protected worktree still reports only the pre-existing
uncommitted `apps/api/src/modules/schedules.ts` on
`feat/agentic-os-k5-overlap-queue`. No API/runtime source is changed by V3.

Changed files (the image bundle is indexed above):

- `apps/web/e2e/auth.spec.ts`
- `apps/web/e2e/demo-a.spec.ts`
- `apps/web/e2e/demo-a5.spec.ts`
- `apps/web/e2e/harness.ts`
- `apps/web/e2e/headless-open.spec.ts`
- `apps/web/e2e/review.spec.ts`
- `apps/web/e2e/visual.spec.ts`
- `apps/web/package.json`
- `apps/web/src/App.tsx`
- `apps/web/src/OrbitalBoard.tsx`
- `apps/web/src/board/CommandBar.tsx`
- `apps/web/src/board/Inspector.tsx`
- `apps/web/src/board/OrbitalField.tsx`
- `apps/web/src/board/Overview.tsx`
- `apps/web/src/board/readouts.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/orbital.test.ts`
- `apps/web/src/orbital.ts`
- `apps/web/src/styles/command-center.css`
- `apps/web/src/styles/inspector.css`
- `apps/web/src/styles/orbital.css`
- `apps/web/src/styles/shell.css`
- `apps/web/src/styles/tokens.css`
- `docs/PROJECT_MEMORY.md`
- `docs/ui/agentic-os-ui-v3.md`
- `docs/ui/orbital-operator.md`
