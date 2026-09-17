# Agentic OS shell: product architecture and implementation

**2026-09-17 · supersedes V3 navigation/composition decisions below.**
Reference inspected: `/home/ubuntu/workspace/reference-images/agentic-os-target.png`.
This is the canonical UI plan, not a second kernel or Cockpit roadmap.

## Product thesis and ownership

One conversational shell turns intent into an explainable, observable mission.
Ordinary work defaults to automatic routing. The operator gives goals and
constraints, reviews a proposal, and handles exceptions without selecting a
provider first. Linux is an ownership metaphor, not a terminal skin:

| Layer | Responsibility / owner |
| --- | --- |
| Resources | Repository/files, credentials, compute, quotas and context capacity remain with their existing authorities; Cockpit owns durable memory/config sources |
| Kernel | Control plane owns task lifecycle, routing, scheduling, resource claims, quota recovery, checkpoints, permissions and model identity |
| Execution harness | Existing SessionRunner/adapters own process execution, normalized events, approvals, verification and recovery |
| System libraries | Cockpit owns installed skills/plugins/hooks/MCP, lineage and machine-global writes; core owns capability contracts |
| Shell | Control-plane React application owns conversational intent and mission interaction, consuming existing authenticated APIs |
| Processes | Tasks, sessions, waits and schedules retain their existing IDs/state machines; no new frontend lifecycle |
| Applications | Overview, Agents, Memory, Routing, Traces, Tools, Settings provide stable destinations |
| System monitor | Orbital projects task/session truth; Cockpit continues to monitor external observed sessions and local/cloud jobs |

Control-plane hosting is chosen because intake, auth, routing, SSE, approvals,
mission inspection and the orbit already live here. Moving these into Cockpit
now would require a second mutation/auth boundary. Cockpit remains the package
and memory authority. Integration must use versioned, authenticated contracts;
there is no cross-origin fetch, hard-coded Cockpit port, embedded privileged UI,
or copy of its memory/scheduler implementations in this slice.

## Current-state audit (verified bases)

Fetched remote bases: control plane `6a0eb55` and Cockpit `7af84bd`.
Original primary checkouts: control plane `2952fb3` on
`feat/agentic-os-k5-overlap-queue` (clean); Cockpit `833d420` on `main`
with 11 untracked dated proposal folders. Both are left untouched.
Worktree metadata, branch, HEAD and status were compared for every registered
worktree. The old Agentic OS documentation worktree has modified/untracked plans;
none were copied. The UI V3, K12/K14, headless bootstrap and Codex runtime branches
are historical feature worktrees, not alternative product roots. Fresh dedicated
worktrees start at current remote main, retaining the merged K5/K6 fixes.

`AGENTS.md` and `PROJECT_MEMORY.md` retain stale documentation-worktree wording.
Git metadata is authoritative for topology. Existing Graphify JSON was queried
locally (CLI absent); its older revisions omit recent services. Source and tests
are authoritative for capabilities. Read plans: master Agentic OS plan, vNext,
kernel-services, harness implementation progress, Orbital/V3, Cockpit Spec E and
K6/K14 implementation records. Historical implementation counts are not reused
as current validation results.

Entry points: `apps/web/src/main.tsx`, `App.tsx`, `NewTask.tsx`,
`OrbitalBoard.tsx`, `TaskDetail.tsx`; React 19/Vite, IBM Plex and CSS tokens.
API: Fastify `apps/api/src/server.ts`, SQLite stores, core contracts, adapters.
Tests: Vitest workspace suites plus real in-process API/FakeAdapter Playwright.
Cockpit: Express `server.ts`, vanilla `public/app.js`/`index.html`, local source
scanners, `controlPlane.ts`, `controlPlaneScheduleSource.ts`, Node tests and
public wiring checks. Cockpit has no configured Playwright runner.

## Current-to-target capability and migration matrix

| Capability | Action / destination | Authority and implementation evidence |
| --- | --- | --- |
| Three-tab rail | Redesign to seven routes; Overview default | `App.tsx`; hash routes preserve reload/back/forward without server rewrite |
| Intake and command bar | Merge into one Overview command surface | Existing task create/route/start APIs; previews remain durable unstarted tasks |
| Orbital/task register | Keep in Overview | `orbital.ts`, `OrbitalField`, `executionRead`; bounded field plus full accessible register |
| Task controls and evidence | Keep, progressively disclose | `Inspector` and `TaskDetail`; all existing K-slice actions retain a destination |
| Assistant discovery/auth/catalog | Move behind Agents | `/api/assistants`, changes, cooldowns, models; discovery remains availability authority |
| Routing explanations | Move entry point to Routing; retain mission inspector | Persisted routing decisions; observed data, configuration and external priors remain distinct |
| Traces/usage/verification | Merge navigation, retain existing detail renderer | Control-plane normalized events/session audits; Cockpit Usage/Retro for observed external sessions |
| Working memory/checkpoints | Keep in mission context/controls | Existing envelope/checkpoint/context observation, not durable semantic memory |
| Durable memory/search/graph/garden | Defer shell integration; Memory names available Cockpit surfaces | Cockpit memory/knowledge/context APIs; M8 registry absent |
| Skills/plugins/hooks/tools/MCP | Defer shell integration; Tools describes real types and owner | Cockpit installed/lineage/discovery; no authenticated M8 inventory snapshot yet |
| Mission scheduling and recovery | Keep mission inspector; Settings explains schedule ownership | Plane K1–K5; Cockpit K6 federated schedule source, local/OS/cloud jobs |
| Global configuration, retention, security | Keep Cockpit/config authorities; Settings lists availability | Existing workspace/auth/policies, Cockpit guarded configuration |
| Free-text continuation, semantic state questions, file upload | Defer with explicit UI limit | `/api/tasks/:id/input` only accepts approval; no generic chat or attachment contract |
| Automatic composition / subtask topology | Defer | Composer and Task/Subtask fan-out are proposed, not represented by decorative orbit nodes |
| Redundant top-level Intake/Orbital names | Remove navigation only after inline destination exists | No backend, task detail or K-slice implementation removed |

Missions do not need a separate application: selection, orbit, register and detail
cover the observed workflows. Schedule remains a mission/system concern;
Cockpit already provides the cross-source schedule application.

## Navigation and shell interaction

Routes: `#/overview`, `#/agents`, `#/memory`, `#/routing`, `#/traces`,
`#/tools`, `#/settings`. Mission diagnostics use `#/missions/:taskId` under
Overview. Unknown routes explain the problem and offer Overview. Native fragment
anchors continue to reach mission evidence/register. Browser history and reload
retain the application boundary. Drafts stay in memory across application
navigation, never in localStorage (goals may contain private context).

Overview hierarchy: calm heading and scheduler read; wide luminous command
surface; system summary and selected mission to the left, mission orbit about
half the useful width to the right; attention/activity; disclosed evidence and
mission register. No green “all healthy” inference from API reachability.

New-mission mode: goal → optional repository/constraints/profile → Preview
routing → concise chosen assistant/rule → Run recommended. Alternative assistants,
filters and compare/race stay behind an advanced disclosure. Edits invalidate the
preview; no start can use an edited intent until previewed again. Preview creates
a durable task but starts no provider. Start returns to the same Overview and
selects the task. API revalidates execution eligibility at start.

Selected-mission mode: show the persisted goal and recent normalized messages,
explicit read errors, durable pending approvals with Approve/Deny, and access to
full controls. This is a bounded mission interaction surface, not a simulated
LLM response. General natural-language follow-up is explicitly unavailable.
Changing selection never sends a message or an approval to the old mission.

## Chat-to-execution lifecycle and smallest missing contracts

1. In-memory draft captures goal, allowlisted repository path, constraints and
   routing profile. Auto is the default; assistant selection is an override.
2. Existing `POST /api/tasks` persists intent. `POST /:id/route` records an
   explainable recommendation; no fabricated topology/asset plan.
3. Explicit Run uses existing `POST /:id/start` (or deliberate parallel command).
4. Existing task/session/events APIs drive the orbit, summary and mission stream.
5. Existing `POST /:id/input {kind: approval, requestId, approved}` handles
   permission decisions; persisted session approvals survive reload.
6. Existing inspection, checkpoint/handoff/wait/cancel controls remain reachable.

**Next contract, not implemented:** a session-addressed input command containing
`clientMessageId`, `sessionId`, `expectedVersion`, `kind: message`, and text;
authenticated `commands.write`, bounded/redacted persistence, durable accepted/
delivered/rejected/unknown result, idempotency and capability/state checks.
Target a specific live owner, reject ambiguous/parallel/stale targets, and never
reinterpret a follow-up as a new task or an approval. Adapters advertising
`supportsMidRunInput` alone are not proof the API can deliver it. Return available
actions from the kernel so the shell can expose continuation/compaction/scheduling
without guessing. Completed-session continuation needs an explicit checkpoint-
anchored new execution command, not reuse of an ended handle.

Other gaps: authenticated Cockpit M8 inventory/memory reads, content-digest and
visibility filtering, M9 deterministic bundle rendering, per-run provisioning,
attachment manifests, composition revisions, subtask/dependency projection and
normalized external usage ingestion. Existing task dependency waits are real;
subtask topology is not. Free-text scheduling and semantic memory recall remain
unavailable until those contracts are implemented.

## Mission-orbit semantics

Preserve `orbital.ts` geometry and mission-state derivation. One task body per
persisted task; rings mean active/held/settled; angle is layout, never progress
or forecast. Selection is a button with `aria-pressed`. Effective Harness approval
is stationary amber even when the task remains RUNNING. Unknown session reads
cannot animate execution. Wait horizons indicate scheduler ownership, not a
promise of quota recovery. Provider satellites are configured discoveries;
participation requires an active session. Requested and observed model identity
remain separate. Dashed amber model candidates are advisory SHADOW evidence,
never running agents. Core counts derive from the same task snapshot as summary.
Dependencies/handoffs are explained from recorded evidence; graph links/subtask
bodies wait for a bounded projected topology contract. No invented links or
percentage progress. Existing phase/event information is the progress evidence.

## Responsive, accessibility and acceptance rules

- Desktop/laptop: command remains above the fold; orbit uses approximately half
  the primary two-column region. Tablet/mobile stack command, summary, orbit and
  inspector. Seven destinations remain named and keyboard reachable; mobile uses
  a wrapping top rail, not seven cramped fixed bottom icons.
- Use semantic links, labels, native disclosures, explicit buttons, visible focus,
  skip link and route-focus restoration. Polling must not steal focus or announce
  entire transcripts repeatedly. Announce command results/errors only.
- Maintain bundled typography, high contrast text, blue selection, restrained
  violet ambient light and amber attention. No decorative provider logos.
- Reduced motion disables continuous movement; shape/text still convey every
  state. No overflow at 1440, 1280, 900, 390 or 320px.
- Verify real task creation → route → explicit start → orbit selection and
  approval after reload. No separate Intake navigation or model selection required.
- Verify editing invalidates preview, drafts survive application switches,
  route/back/reload, keyboard, empty/loading/unavailable/failed/waiting/approval/
  quota/completed states. Reuse real API/FakeAdapter fixtures; label captures as
  deterministic test workspaces, not live provider evidence.
- Preserve all K-slice backend tests and existing detailed controls. Validate both
  repositories and compare browser captures to the reference and these semantics.

## Decisions and explicit deferrals

Rejected: copying Cockpit into React; iframe integration into a privileged UI;
a new shell backend; fake chat replies; animation implying unsupported processes;
a universal health verdict; full implementation of seven applications in one PR.
Memory, Tools and Settings are truthful destination structures. Routing and
Traces link to existing mission evidence until their richer workspaces arrive.
No K13 activation, model-policy change, remote runtime, cost-cap enforcement,
provider-command compaction, generated artwork or production credential use.

Validation and final artifact inventory are recorded at the end of this section
once the implementation checks complete. Historical V3 evidence follows.

---

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
