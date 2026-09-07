# Independent review — PR #26, Agentic OS Orbital UI v2

Reviewed 2026-09-07. Published head: `d139aca439cc5265f5d5bf873e07c4c93086a193`.
Reference inspected: `/home/ubuntu/workspace/reference-images/Agentic_OS_View.png`
(the supplied prompt contained a placeholder; this matching workspace image was used).
Fresh before/after browser captures, isolated API workspaces and real K1–K3 reads
were used. No production provider was invoked and no production session was fabricated.

## Verdict and score

**REQUEST CHANGES on the published PR head.** The original has two P0 issues and
several P1 issues described below. The accompanying validated local corrections are suitable
for **APPROVE WITH MINOR NOTES**, once
included in the PR. This review does not publish a GitHub review or push the branch.

**Corrected product/visual score: 7.3/10.** The design is coherent enough to retain.
It has an OS shell, a clear command entry and a stateful awareness surface with
useful drill-down. It has not yet reached the reference's level of spatial richness
or first-use simplicity. The inspector and Agents page remain recognizably technical
administration surfaces. Another redesign is not warranted to resolve this review.

| Category | Score | Assessment of corrected UI |
|---|---:|---|
| First-time usability | 7 | Command and attention are clear; kernel vocabulary and detailed approval navigation still require learning. |
| Command-entry discoverability | 8 | Full-width, prominent entry; explicit preview-before-run copy. Mobile input has its own row. |
| Product hierarchy | 7 | Command → awareness → selected evidence is coherent. Long inspector content pushes the register below the fold. |
| Orbital/spatial quality | 8 | Layered sphere, rim lighting and state-specific shapes feel intentional. Dense scenes need the register. |
| Distinctiveness / brand | 7 | Teal sphere and restrained shell are recognizable; secondary screens are generic. |
| Semantic truth | 8 | Approval, unknown runtime, scheduler wait and ready states are separated; run identity remains evidence-based. Polling has freshness limits. |
| Operator usefulness | 7 | Routing, quota, checkpoints, dispatch events and approval actions are connected. Some decisive evidence is several clicks away. |
| Information density | 7 | Comfortable desktop overview; long technical explanations and tiny labels compete with useful evidence. |
| Typography / materials | 8 | Plex pairing, controlled contrast and consistent surfaces work. Frequent 10–12px metadata is less comfortable. |
| Responsive quality | 6 | Overflow corrections pass. Mobile still requires considerable scrolling and hides the constellation. |
| Accessibility / motion | 7 | Native buttons, pressed states, keyboard selection, visible focus and reduced motion work. Mobile dot targets and navigation focus transfer deserve follow-up. |
| Frontend maintainability | 7 | Component extraction and pure geometry are useful. The 629-line inspector, duplicated polling and parallel token definitions remain debt. |

## P0/P1 findings and corrections

1. **P0 — Intake could execute an obsolete goal/constraints.** `NewTask.tsx`
   retained its original task ID after editable fields changed. Re-route and Run
   therefore used the earlier immutable intent. Command submission made this easy
   to encounter by automatically creating the first preview. Edits now invalidate
   the recommendation and task ID; controls cannot edit during an in-flight action.
   A new preview persists the revised goal/constraints before Run is offered.
   Previous previews remain unstarted, explicitly explained in the UI. A browser
   regression failed on the original and passes after checking persisted intent
   and the actual completed revised task.

2. **P0 — Approval waits appeared as execution, and late-arriving operators lacked
   durable approval controls.** A RUNNING task can contain an AWAITING_APPROVAL
   session. The field, counters, provider highlight and Next strip previously
   ignored that distinction. Existing task/session reads now supply a presentation
   overlay: stationary amber attention, explicit task/session distinction and a
   path to full controls. Sessions now renders pending persisted approval records
   with the existing authorized Approve/Deny command. The test opens the task after
   the approval arrived, reviews its request, approves it and verifies completion.
   No task state, approval policy or backend transition was changed.

3. **P1 — Summary text overstated backend truth.** CREATED was counted as waiting
   for the scheduler; LIMIT_PAUSED was always described as an exhausted wake budget.
   Ready drafts now have their own count; only WAITING_RESOURCE counts as scheduler
   waiting. Limit text asks the operator to inspect the actual evidence. The summary
   distinguishes the latest historical run from the latest routing decision.

4. **P1 — Provider relationships could be stale or incomplete.** A single remembered
   assistant could remain lit after selecting another task and represented only the
   last run of a parallel mission. The highlight is now scoped to the selected task
   ID and all running, unended, session-backed runs. Disabled, auth-unavailable and
   unknown availability are explicitly labeled. Failed provider/cooldown reads are
   disclosed instead of silently presenting stale provider data as current.

5. **P1 — Label collisions and responsive overflow.** Eight real running missions
   produced overlapping labels, with a label extending under the laptop inspector.
   The geometry test's scene dimensions did not match fixed pixel label dimensions.
   Label bounds now use rendered scale; a bounded density pass keeps selection and
   admits only bodies whose bounds fit each other. The true shown count links to
   the complete register. At 390px the full task page originally measured 595px
   wide; toolbar and tab wrapping now pass the 390px check. Mobile command entry
   no longer compresses its question beside the submit button.

6. **P1 — Attention could be buried beyond the bounded field.** Attention and
   unfinished work now precede history; the need-you count filters the register.
   Search, the existing filters and the new register link provide access beyond
   the displayed bodies. Selection outside the initial field brings that mission
   into the field. No clustering, dependency graph or schedule redesign was added.

## First-use product test

| Operator question | Where the corrected experience answers it | Remaining friction |
|---|---|---|
| Where do I ask? | Full-width command input; route button and Enter both enter Intake. | No global shortcut or focus transfer to recommendation. |
| What is happening? | Counts, core, shapes and state labels. | At narrow widths, selected mission details require scrolling. |
| Which assistant/provider? | Selected-mission constellation highlight; Execution identity grid. | Small configured IDs are less recognizable than the reference's provider marks. |
| Why that choice? | Because strip, Decision candidates and full Routing tab. | Rule identifiers are technical; historical routing is explicitly task-level. |
| Anything blocked? | Hollow wait, quota blocker arc, attention count, Schedule evidence. | Quota reason/provenance is below the initial fold. |
| Does it need me? | Amber approval/input signal and need-you filter. | Durable approval review uses full controls → Sessions → session. |
| What happens next? | Always-visible Next strip; real wait instant or human action. | Unknown runtime is explicitly unknown rather than guessed. |

## Visual reference comparison

The implementation captures the useful shell structure, prominent command entry,
spatial centerpiece, luminous active bodies and restrained material system. The
field occupies roughly half the desktop content width. The sphere itself occupies
considerably less visual area than the reference's large sculptural core.

The reference has stronger depth, layered light and recognizable active-provider
relationships. This UI is quieter and flatter: a wireframe sphere, small floating
labels, plain configured-provider names and conventional rectangular detail pages.
The long metadata-heavy inspector also makes it feel more technical. These are
quality differences, not reasons to copy the reference pixel-for-pixel or invent
future integrations. Keeping unavailable model/context capabilities honest is a
better product decision than adding unsupported reference-like decoration.

## Orbital and observability semantics

- RUNNING/ROUTING: active tone, pulse/drift; runtime execution is checked for
  session-backed running tasks. ROUTING represents route evaluation, not provider work.
- WAITING_RESOURCE: still hollow body and wake horizon; Schedule exposes wait
  kind/generation, eligibility, scheduler enablement and controls.
- K2 quota: blocker arc plus stored reason, scope, provenance, checkpoint and
  continuation. Demo A verifies revalidation and resumption on the eligible assistant.
- WAITING_INPUT and AWAITING_APPROVAL: amber human attention; neither implies a
  scheduler wake. The latter retains the RUNNING task/session distinction.
- LIMIT_PAUSED: limit tone and broken arc; no invented exhaustion cause.
- HANDING_OFF: lavender transition/trailing treatment. No invented transfer ETA.
- COMPLETED/FAILED/CANCELLED: settled outer historical state; labels accessible
  through focus/selection as well as hover.
- Provider constellation: configured assistant identities, session-backed selected
  execution and cooldown/availability observations. Cooldown can coexist with an
  already-running session because it gates new routing. No K7 intelligence is inferred.
- Inspector/full controls: routing candidates, run events, session audit, quota
  evidence and scheduler dispatch history connect awareness to diagnosis. K9 context
  observation and K4/K5/Composer material remain Planned/Unknown/Unavailable.

## Known caveats

**FakeAdapter and approval.** FakeAdapter itself can exercise the real Execution
Harness. The original harness used the legacy execution path, which explains the
empty session list. Production Harness reads already expose AWAITING_APPROVAL;
ignoring those reads was a UI defect. The corrected visual harness enables the
real Harness and reaches approval through a scripted adapter. Legacy execution
still lacks durable session-level truth; its board presentation is explicitly
Runtime unknown and does not animate execution. Adding legacy observability is
outside this UI review and has not been fabricated.

**Private registry map.** Unnecessary test debt, corrected using the server's
existing Registry dependency injection and a test subclass overriding its public
adapter read. No production registry refactor or API contract change was needed.
The browser clock is aligned with the injected kernel clock so cooldown captures
are meaningful. Test teardown closes pages and settles sessions before closing SQLite.

## Scale and frontend architecture

0 missions has a useful empty prompt and idle core. 1 mission remains understandable;
6 mixed missions fit naturally. 20 and 100 retain complete searchable registers,
truthful totals and a bounded field. Eight simultaneous running missions are denser
than eight mixed-state missions, so the field may show fewer bodies at laptop width.
This is explicit and selection is preserved; the register is the reliable list.

Geometry work stays bounded at eight candidate bodies. The register still renders
all matching rows; 100 tasks were exercised, not a 100-concurrent-provider load test.
Runtime reads add two reads per RUNNING task in batches of six. This is a deliberate
small fix using existing endpoints, not proof of high-concurrency scalability.

The 1007→180-line board change is mostly a sensible extraction, not a complete
architectural simplification: the inspector remains large and data reads repeat
across shell, board and inspector. Geometry is pure and independently testable.
CSS tokens establish consistency, but `ui.tsx` still mirrors values and the sphere
uses literal colors. Those are follow-up maintenance concerns, not release blockers.

`offset-path: path(...)` and `offset-anchor` are used together; current-browser
support is documented by [MDN offset-path](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/offset-path)
and [MDN offset-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/offset-anchor).
This review exercised Chromium, not Safari or Firefox; older engines have no
explicit positional fallback. Accessibility checks used the
[Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md),
source inspection and browser interaction. This was not a full assistive-technology audit.

## P2 follow-ups — maximum five

1. Put a short human explanation ahead of routing rule IDs and milestone-heavy copy.
2. Give selected-provider relationships a clearer visual connection; retain the
   distinction between current execution and cooldown for future dispatch.
3. Bring selected-mission context closer to the mobile field, improve touch targets
   and transfer keyboard focus when navigating between views.
4. Consolidate repeated reads and token values when the next relevant change touches
   these components; consider a narrow batch runtime summary if concurrency grows.
5. Repair the documented `pnpm --filter @agent-plane/web visual` script (absent in
   package.json) and add a small stable screenshot baseline: the current visual
   suite captures images and asserts behavior, but has no pixel regression matcher.

## Validation and artifacts

Fresh captures and logs are under `/tmp/pr26-review/`; the original PR images were
not substituted for fresh rendering. See `artifact-index.html` for a clickable gallery.

- `before/`: original active/quota/input/laptop/mobile/reduced-motion/Intake/detail/Agents captures.
- `validated-browser/visual-*/`: final required visual states, including real approval.
- `validated-browser/review-*/`: 0/1/6/20/100, eight-running geometry, durable approval
  controls, loading, disabled provider, failed reads and additional state captures.
- `validated-demo/`: final successful K1/K2/K3 walkthrough, PNGs, video and trace.
- `validated-*.log`: final validation logs.

| Validation | Final result |
|---|---|
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | 615 passed: core 70, adapters 8, API 518, web 19 |
| `pnpm build` | Pass |
| Browser auth suite | 6 passed |
| Targeted review regressions | 7 passed |
| Visual suite | 1 passed; fresh screenshots manually inspected |
| Demo A | 1 passed (30.4s including suite setup/teardown) |
| Console/page exceptions | Zero unexpected errors across review/visual paths |
| Reduced motion | No running infinite animations; selection and evidence remain usable |
| Secret scan | Clean after excluding the published commit SHA and documentation path matches |

Browser auth, review and visual checks completed together: 14 passed (1.2m).
Demo A was run separately after them to avoid resource contention. Chromium was
the tested browser. Original expected reproduction failures and an initial Demo A
timeout remain in the evidence directory for audit.
No assertion was weakened to obtain the successful Demo A rerun. Expected HTTP 503
console messages are confined to the intentional outage test; successful UI paths
assert zero console errors/page exceptions from before navigation.

No files under `apps/api` or `packages` were modified. No K4+ implementation,
credentials, production provider transcripts or generated browser traces were committed.
