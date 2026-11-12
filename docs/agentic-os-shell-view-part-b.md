# Shell view, part B

2026-11-04 · **PROPOSED, design only.** Nothing here is built. Checked against `main` at
`d74424d`. Part A is the shipped baseline (#113, then #115 and #130; PROJECT_MEMORY "Shell
view, part A"). The part A note and the reference images live in the project files
(`ui-reference/shell-view-design-note.md`, `compact-view-design-note.md`,
`software-factory-board.png`, `software-factory-card.png`, `shell-view-a/*.png`); this note
restates what a session needs from them, so it can be read from the repo alone.

**Short answer.** Part B adds what an operator asks after "what is running": *how far along is
it, did it pass, what did it cost, is it about to run out of context*. Each of those is already
served by a plane route the web reads elsewhere (Task detail), so part B is two web-only
slices with no API change. The factory-board pieces (Spec/Build/Review rail, sec/ux/ui/code
review chips, Merged) are **not** in part B: the plane does not publish them, and the rule is
that stages are plane-owned, never inferred in the UI. They are questions 2 and 3 below.

## 1. What part A left out

| Left out | Why | Where it goes |
| --- | --- | --- |
| Stage rail (Spec, Build, Review, Approve, Done) | No plane stage. `TaskState` is RUNNING, AWAITING_APPROVAL, WAITING_INPUT, COMPLETED and so on (`board/execution.ts`) | Q2: a plane-computed field first |
| Review chips (sec, ux, ui, code) and review round `R1` | No review-lane result shape in any contract (vNext increment 9 has no code) | Q3: later, own note |
| Merged | The plane has no push, PR or merge facts; nothing in `apps/api` or `packages/core` reads a PR | Q3 |
| Verification state per row | Part A shows `verification.result` only as a log line | **B1** (column) and **B2** (pane) |
| Cost per row | Part A shows tokens only; #127 added `consumed.costUsd` and `costMethod` later | **B1** |
| Context pressure | Read exists (`/api/tasks/:id/context`, K9) but only Task detail uses it | **B1** and **B2** |
| Changed files and checkpoints | Only in Task detail and the Inspector | **B2** |
| Conversation in the shell | `sessionInput` is off by default; the command line is single-shot | Out of scope (unchanged) |
| A real terminal (xterm.js, PTY) | Out of scope in part A; still out | — |

Already closed since part A, so not part B: the "Shell mode" naming clash and light chrome
(#115, now "Mission mode" with a `#/mission` alias), repository selection on the command line
(#115), and the Restart control in the status line (#130, `ShellView.tsx:306`).

## 2. What part B adds

### 2.1 Process list: four columns (slice B1)

```
PID        STATE      PHASE    ASSIST  MODEL          TOKENS    COST     CTX   CHECKS  AGE  GOAL
AG-mvm9h   RUNNING    editing  claude  claude-sonnet  4.1k/10k  ~$0.02   31%   —       3m   fix handoff …
AG-k2p1q   NEEDS-YOU  —        codex   gpt-…          unknown   unknown  —     3✓ 1⊘   12m  verify: blocked
AG-x81ab   COMPLETED  —        claude  claude-sonnet  9.8k/10k  $0.11    —     4✓      1h   add smoke test
```

| Column | Plane read (exists today) | Rule; `unknown` / `—` when |
| --- | --- | --- |
| PHASE | `GET /api/tasks` → `phase` (`server.ts:414`, the task's `activity_phase`) | Shown verbatim (`planning`, `editing`, `testing`, `reviewing`, `core/task.ts:7`). `—` when null. **Finding:** only the fake adapter emits a phase (`adapters/src/fake.ts:40`); `claude.ts` and `codex.ts` never do, so for real runs this column is `—` until an adapter reports one. It is labelled PHASE, not STAGE, because it is provider-reported activity, not a plane stage. |
| COST | `GET /api/tasks/:id/composition/budget` → `consumed.costUsd`, `costMethod` (`core/composer/accounting.ts:63`), already fetched per row by `useProcessDetails` (`shell-view/reads.ts:14`) | `$x` when `costMethod` is `measured`, `~$x` when `estimated`, `unknown` when `costMethod` is `unknown` or any run's accounting is `none` (same rule as TOKENS, `model.ts:76`). Never computed in the web. |
| CTX | `GET /api/tasks/:id/context` → `observation.pressure`, `freshness` | Percent only when `status` is `known` and the observation is `live`; `stale` shows the percent dimmed; otherwise `—`. Read for RUNNING rows only, inside the existing bounded batch. |
| CHECKS | `GET /api/sessions/:id` → `result.verification.checks` for the row's last run | Counts by status: `n✓` passed, `n✗` failed, `n⊘` blocked, skipped not counted. `—` while running or with no result. **Finding:** the web's `SessionResult` type (`apps/web/src/api.ts:629`) has only `passed`, but the plane sends `status` with `blocked` and `skipped` (`core/events.ts:121`). B1 widens the web type to match; it is the plane's existing shape, not a new one. |

NEEDS-YOU stays pinned first. A NEEDS-YOU row whose cause is known shows it in GOAL's place
as `approve: <tool>`, `verify: blocked`, `restart offered` or `limit paused`, taken from the
same reads (pending approvals, CHECKS, `useRestartOffered`, state). That is the shell's answer
to the factory board's "Approve" column without inventing a stage.

At 390 px only PID, STATE, TOKENS and GOAL stay; the rest move into the detail pane header.

### 2.2 Detail pane: tabs, like `/proc/<pid>` (slice B2)

Part A's pane is `tail -f` plus the Inspector on Enter. B2 makes it four tabs on the selected
task, switched with `1`–`4` (not Tab, which stays the command line's route preview):

| Tab | Shows | Plane read |
| --- | --- | --- |
| `1 log` | Part A's event log, unchanged | `/api/tasks/:id/events` + SSE |
| `2 verify` | Each check: name, status, required, summary; the plan revision reason (`initial`, `post_change`, `recovery`); a blocked check's install hint verbatim | `/api/sessions/:id` `result.verification`, `/api/sessions/:id/verification` |
| `3 files` | Branch, changed files, checkpoints with `gitRef` and `diffStat` | `/api/tasks/:id` (`branch`, `envelope.artifacts.changedFiles`), `/api/tasks/:id/checkpoints` |
| `4 ctx` | Occupancy / window, source, freshness, breakdown, auto-compaction count, continuation number | `/api/tasks/:id/context` |

Enter still opens the Inspector and Esc still goes back. No tab writes anything. Each tab
reads only while it is visible, every 4 s while the task runs (like `usePendingApprovals`).

### 2.3 Top panel

No change in data. One fix: in headless Chromium the quota bars rendered as empty boxes
(PROJECT_MEMORY, dogfood run). B1 swaps `▮▯` for a CSS bar with the same `unknown` text rule,
so a missing glyph can't hide a real value.

## 3. Slices

Both slices touch `ShellView.tsx`, so they run **one after the other**, B1 first. Neither
changes `apps/api`, `packages/*` or a contract, so neither needs Cockpit work.

| Slice | Owns | Gate and drive | Model / effort |
| --- | --- | --- | --- |
| **B1** columns, NEEDS-YOU cause, quota bar | `apps/web/src/shell-view/{model.ts,reads.ts,ShellView.tsx}`, its tests, the shell CSS, `apps/web/src/api.ts` (widen `SessionResult.verification` only), `apps/web/e2e/shell-view.spec.ts`, the "Shell view, part A" PROJECT_MEMORY section | `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @agent-plane/web test:e2e`; `pnpm dev` with fake assistants: one running (phase shown), one blocked verification, one completed with cost; screenshots light and dark at 1280 and 390 px | Sonnet 5.5 / high |
| **B2** detail pane tabs | `apps/web/src/shell-view/*` (new `DetailTabs.tsx`), shell CSS, web tests, the e2e spec, the same PROJECT_MEMORY section | Same gate; drive keyboard-only through `1`–`4`, Enter, Esc on a task with checkpoints and a context observation | Sonnet 5.5 / medium |
| **B3** plane stage field (only if Q2 is yes) | `packages/core` (a pure `deriveStage`), `apps/api` task list and SSE state frame (additive field, API minor bump), the contract doc first; then a web slice to render it | `pnpm typecheck && pnpm lint && pnpm test`, `demo:a`; drive a request against `pnpm dev` | Opus 5.5 / high |

B3, if approved, lands in ai-control-plan first. If Cockpit ever shows the stage, it vendors the
shape SHA-pinned (VENDORED.json) and never recomputes it.

## 4. Questions for itay

1. **Real runs show PHASE `—`. Ship the column anyway?** Recommended: **yes**, labelled PHASE
   and honest, and treat "adapters report phase" as a separate adapter slice later. The
   alternative, hiding it until adapters report, leaves the fake path as the only evidence.
2. **Add a plane-computed `stage` (B3)?** Recommended: **yes, but small**: five stages derived
   in core from facts the plane already owns, each with a named rule: `queued` (no run, or a
   wait/resource condition), `working` (a live run), `verifying` (run ended, verification run
   not completed), `needs-you` (WAITING_INPUT, AWAITING_APPROVAL, LIMIT_PAUSED), `done`
   (terminal). No Spec/Review split: the plane can't tell those apart yet, and guessing is
   what the rule forbids.
3. **Review chips and Merged: GitHub now or later?** Recommended: **later, in its own note.**
   It needs either the plane pushing branches and opening PRs (new credential, outward-facing
   approval boundary), or a read-only GitHub poll (a token outside the plane DB, a new threat
   surface on OCI). Both are bigger than a view and should be weighed with the stage 2 remote
   auth work in `agentic-os-cloud-note.md`.
4. **Cost with `~` for estimated?** Recommended: **yes**: `$x` measured, `~$x` estimated,
   `unknown` otherwise, matching the budget read's `costMethod`. Hiding cost until every
   served model has a price would hide the one estimate the plane already makes.

Verdict for this note: **SKIP** (docs only, no runtime surface).
