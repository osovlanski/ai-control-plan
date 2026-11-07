# Agentic OS — auto copilot operating plan

Status: **PROPOSED**, 2026-11-07. Plan only; nothing here is implemented. Written for itay's
approval before any slice starts. Where this file and the diff disagree, the diff wins.

Inputs read: `docs/agentic-os-plan.md` (§3.8, §4–§6 phase table), `docs/agentic-os-vnext-plan.md`
(§8 build vs buy, increments 10–13, P2 backlog), `docs/PROJECT_MEMORY.md` (to "K8 AA map grounding
diagnostic"), `docs/agentic-os-phase8-readiness.md` (#161), `docs/agentic-os-cloud-note.md` (#133),
`docs/agentic-os-eval-plan.md`, and the open-PR lists of both repos (REST, 2026-11-07 15:25Z: **none
open** in either repo).

---

## 0. What changes, in one paragraph

Today the work moves because itay pastes prompts into Claude Code cloud, Codex cloud or the OCI box
one at a time, and merges every PR. The new strategy makes progress continuous: a **backlog file in
the repo** is the single source of truth every lane reads (Claude and Codex, cloud and OCI); a
**daily report** turns it into "% done / % left"; work that hits a usage limit is **re-queued for
the next free window, preferring the night**; every slice follows the same **session hygiene**
rules; and, only if itay confirms it, a **guarded auto-merge** lands the lowest-risk PRs without
him. Over time the OS itself takes these jobs over (its scheduler, handoff and composer already
exist), so the copilot becomes the first real user of the OS.

## 1. The goal: "every prompt goes through the OS, and OS ≥ best single assistant"

**Meaning.** For any prompt, sending it to the Agentic OS should never be worse than sending it to
the best single assistant (Claude Code or Codex on their own), and should usually be better: right
model, right tools, right memory, resumed after limits, verified before it is called done.

**How we prove it, not just claim it.** The plane already has the parts:

- **Parallel compare** (shipped, Phases 0–5) can run the same task as `auto` (OS-composed) and as
  fixed `claude` / `codex` arms.
- **The eval harness** (`pnpm eval`, scorecard schema, `docs/eval-history/`) can store the result —
  but no real scorecard has ever been promoted (eval plan, area 1/2), because no session had a
  provider credential for `AGENT_PLANE_EVAL=1`.

So the target is a measured statement: **on a fixed corpus of N real tasks, the OS arm's verified
pass rate is ≥ the best single arm's, at ≤ its cost and wall time** (each reported separately, with
`unknown` where it is unknown). Until a scorecard exists, the report says "OS ≥ solo: **not
measured**", never a number.

**Stages to "every prompt is an OS prompt":**

| Stage | What itay does | What the OS does | Gate to next |
|---|---|---|---|
| S0 (today) | pastes prompts per lane, merges | nothing; the coordinator plans by hand | backlog + daily report exist (W1) |
| S1 | answers decisions only | coordinator dispatches from the backlog; night queue; re-queue on limits | two weeks of daily reports |
| S2 | types prompts into `aos` (the OS CLI) or the web shell | plane composes, routes, schedules, verifies, opens the PR | CLI-2 shipped; dogfood tasks on OCI pass |
| S3 | as S2 | K13 picks the model live (gate open), compare-arm sampling feeds the scorecard | first promoted OS-vs-solo scorecard |

## 2. Where we are (facts, 2026-11-07)

| Area | State |
|---|---|
| Phase 6 contracts + registry, Phase 7 bundles/composer/provisioning | **closed** (2026-10-31) |
| Phase 7b kernel services | **closed with named exclusions** (2026-11-05: K10 out of scope, K11 fake only) |
| Phase 8 learning loop + memory | **open**. All slices merged (M6 S1–S4, M10, O6 S0–S6, K13 A1/A2/A4/P2). Close path in `agentic-os-phase8-readiness.md` §4: AA map ids → base-config attestation → ≥10 opus and ≥10 sonnet composed coding runs → live re-drive → owner decision on the gate → close record |
| AA (Artificial Analysis) map | 0 of 726 rows mapped; ids come from the grounding list O12 phase 2 reads on OCI |
| Jev (TypeSafe decision provider, M16) | shipped and measured offline; live operator config lacks `decisions.typesafeApiKeyRef` / `typesafeRoute` (itay's call) |
| Vercel / cloud | design note merged (#133); its 4 questions are **unanswered**; recommendation (b) stage 2 remote auth on OCI first |
| Phase 9 economics (O1–O4), Phase 10 depth (O5, O7 3D graph, O8, O11, O12) | not started |
| vNext increments 10–13 (subtasks, fan-out, multi-repo saga, progress projection) | not started |
| Real eval scorecard | never promoted; nightly Eval is manual and needs the `ANTHROPIC_API_KEY` repo secret |
| OCI | 1 CPU: one heavy job at a time (load < 1.5 gate) |
| Cockpit | Agents, Usage, **Retro**, **Discover** (trends scan), **Memory** (2D graph), Proposals, Schedule, Knowledge, Context tabs; consumes plane contracts SHA-pinned via `VENDORED.json` |

## 3. Operating model

### 3.1 Lanes

| Lane | Runs | Good for | Limits |
|---|---|---|---|
| **Coordinator** (Claude project chat) | planning, prompts, reviews, daily report | reading project files, GitHub REST | cannot run on OCI; its project files are invisible to the other lanes |
| **Claude Code cloud** (project threads) | code slices, docs PRs, drives on fakes | Opus/Sonnet; isolated container per slice | shares itay's Claude plan quota with OCI Claude |
| **Codex cloud** | code slices with a clear file list | parallel capacity on a second quota | needs repo-only prompts |
| **OCI — Claude Code / Codex** | live operator plane, live drives, quota-spending runs, night queue | the only lane with real logins and the live DB | 1 CPU, one heavy job |

**Key fact for scheduling:** quota belongs to the **account**, not the machine. Claude cloud and
Claude on OCI draw from the same plan; Codex likewise. "Schedule where available" therefore means
*switch assistant* (Claude ↔ Codex) or *wait for the window*, not *switch machine*.

### 3.2 The repo is the shared memory

OCI and Codex cannot read `/mnt/project-files` (PROJECT_MEMORY feedback, 2026-11-01). So everything
a lane needs lives in the repo:

| File | Role | Written by |
|---|---|---|
| `AGENTS.md` (both repos) | rules; Claude reads it through `CLAUDE.md`, Codex natively | itay-approved PRs only |
| `docs/PROJECT_MEMORY.md` | durable outcomes (unchanged rules) | each slice, one section |
| **`docs/progress/backlog.yaml`** (new, W1) | every remaining item: id, title, phase, repo, size, status, lane, model/effort, deps, files owned, PR, verdict, `resume_after` | the slice that changes an item's state, and the coordinator |
| **`docs/progress/handoff/<id>.md`** (new, only while an item is mid-flight) | state, last commit, next step, open risk — written before a session ends early (limit, compaction, crash) | the session that stops |
| PR body | claim of what changed + verdict | the slice |

A Codex session can pick up a Claude session's half-done item (and the reverse) by reading
`backlog.yaml` + its handoff file + the branch. That is the same claim/handoff idea the plane's
`handoff_envelopes` implement for its own tasks; at S2 the plane does it for real.

The coordinator's project memory stays the planning log; once a day it mirrors anything a worker
lane needs into `backlog.yaml` (never credentials, transcripts, hostnames or ports).

### 3.3 Daily progress report (% done / % left)

**Denominator.** Weighted backlog points, so a percentage has a real denominator (the same rule
vNext increment 13 sets: no percentage from time, events or tokens). Size points: S = 1, M = 3,
L = 8. `% done = done points / total points`, per phase and overall. Scope added during the day is
shown as its own line ("+5 points added: …") so the percentage never silently moves backwards.

**Content (one screen):**

1. Overall % and per phase (6, 7, 7b, 8, 9, 10, vNext 10–13, OS features).
2. Done in the last 24 h (PR, verdict), in flight (lane, since), blocked (on whom), queued for
   tonight.
3. Quota: per account, last limit hit and `resume_after` (from slice reports; at S2 from the plane's
   `GET /api/scheduler/status` and K3 probes).
4. Decisions waiting on itay.
5. "OS ≥ solo": the latest scorecard line, or "not measured".

**Delivery.** `scripts/progress-report.mjs` (W1) renders `backlog.yaml` + GitHub REST PR state to
Markdown. A daily routine (morning, itay's timezone) runs it, writes
`/mnt/project-files/progress/<date>.md` and posts the summary in the project chat. Later the same
data shows in the OS (CLI `aos progress`, a Cockpit "Progress" panel).

**Draft baseline** (rough, from the phase table, to show the shape; W1 replaces it with the audited
backlog): done 46 points (Phase 6 L, 7 L, 7b L, M6 L, M10 M, O6 L, K13 shadow M); remaining 92
(Phase 8 close 7, K13 activation 1, Phase 9 8, Phase 10 15, vNext 10–13 27, stage 2 remote auth 8,
Vercel UI 3, Jev live 1, real scorecard 3, CLI 8, copilot infra 7, Cockpit-as-app 4). **≈ 33 % done,
67 % left.** vNext increments 1–9 are not counted until W1 audits them.

### 3.4 Usage limits and night runs

**Rule set (S1, no code needed):**

1. A slice that hits a usage limit stops cleanly: commits, pushes, writes its handoff file, reports
   `BLOCKED (usage limit, resets <time>)`.
2. The coordinator sets the item's `resume_after`, then either re-dispatches it now to the other
   assistant (if its prompt is assistant-neutral and the other quota is free) or schedules a resume
   at `resume_after` with a one-shot reminder.
3. **Night queue.** Heavy or quota-spending items (Phase 8 cohort runs, eval scorecard runs, long
   refactors, multi-slice chains) are tagged `night: true` and dispatched at the start of itay's
   night window. Night runs may use higher effort and longer drives, but keep every gate and never
   merge. OCI still runs one heavy job at a time, so the night queue on OCI is a serial list.
4. Morning report shows what the night did.

**S2: the OS does it itself.** The plane already has the scheduler: K1 "run tonight" time waits,
K2 "continue when quota resets" with blocker evidence, K3 Claude quota probe, K5 recurring
schedules, and routing recomputed at every wake. What is missing for this use:

- a **concurrency slot of 1 for heavy runs on OCI** (K4b resource slots are deferred; a minimal
  "max concurrent runs" config is enough) — slice N1;
- a **night window** config (`scheduler.preferredWindow`) that `run tonight` uses as its default
  instant — slice N2;
- a CLI verb to enqueue (`aos tonight "<prompt>"`) — CLI-3.

### 3.5 Session hygiene (best practices every prompt carries)

- **One slice per session; new session per slice.** Never continue a finished slice's session for
  the next one; context from slice A is noise for slice B.
- **Own worktree, disjoint files** for parallel sessions (standing rule), listed in the backlog item.
- **Compact or restart by threshold.** At ~60 % context: write the handoff file, then `/compact`
  with a focus line (Claude) or start a new session from the handoff (Codex, or Claude after a
  second compaction). At a phase boundary always start fresh. Never compact mid-edit of a migration
  or contract.
- **Model and effort by work type:** Opus 5.5 / high for contracts, migrations, core, scheduler,
  security; Sonnet 5.5 / high for UI, vendoring, cross-repo plumbing; Sonnet 5.5 / medium for docs
  and audits; Codex low/medium for OCI operations and mechanical changes. Every prompt names one.
- **Verdict discipline** unchanged: PASS / FAIL / BLOCKED / SKIP, drive where it executes.
- **Load gate on OCI** (`uptime` < 1.5) before any heavy step.
- In the OS (S2+), the same rules become kernel behaviour: the K9 context gauge reports pressure,
  K11 continues from a checkpoint in a clean session, and the composer attaches the slice's memory
  bundle so a new session does not start cold.

## 4. The OS terminal (`aos`)

Like bash for Linux or the Claude Code / Codex chat TUIs: a terminal front end for the OS, talking
only to the plane API (loopback, bearer credential from the existing credential file; remote use
waits for stage 2).

| Command | Does | Plane surface |
|---|---|---|
| `aos` | chat REPL: each prompt becomes a task; shows the composition preview (assistant, model, assets, memory, why), asks to confirm, streams events, answers approvals inline | task create + composer preview, SSE |
| `aos ps` / `aos logs <id>` / `aos attach <id>` | process list with stage, follow a task | task list (stage v1), events |
| `aos approve <id>` / `aos cancel <id>` | approvals and control | command routes (`commands.write`) |
| `aos tonight "<prompt>"` / `aos at <time>` / `aos queue` | defer to the night window, list parked work | K1/K5 waits, scheduler status |
| `aos quota` / `aos models` | quota projection and model catalog | scheduler status, `/api/models` |
| `aos progress` | the daily report from `backlog.yaml` | repo file (no plane change) |
| `aos apps` | list installed apps (Cockpit first) with health and link | apps manifest (§5) |

Slices: **CLI-1** read-only (`ps`, `logs`, `quota`, `models`, `progress`) · **CLI-2** chat + preview +
stream + approvals · **CLI-3** scheduling verbs. New package `apps/cli`, no new API except what §5
adds. Borrow: opencode's client/server split (TUI is just an API client), Claude Code's slash
commands and inline approvals, Claude Squad's tmux attach for long runs.

## 5. Cockpit as an installed application

The OS framing: the **plane is the kernel and shell** (scheduling, composition, routing, contracts);
**Cockpit is the first installed application** — the package manager and config owner for the
machine's assistants, plus insight views. It keeps its loopback bind, path guards and read-only
mode; the plane never writes through it.

**Make "installed" real (small):**

- **A1 apps manifest** (plane, contract first): `apps-v1` — `{ id, name, url, healthUrl,
  contracts: [{ name, vendoredSha }], capabilities }`, read at `GET /api/apps`, declared in plane
  config. The web shell gets an Apps launcher; `aos apps` lists it. Cockpit reports its vendored
  contract SHAs on its health route so the plane can flag drift.
- **A2 integration audit** (both repos, docs + one test): a matrix of every contract Cockpit
  consumes (registry, bundles, asset-usage, memory, task-stage, context gauge, model catalog, usage
  ingestion) with the plane's latest SHA vs Cockpit's `VENDORED.json`, and any consumed shape without
  a plane counterpart (an AGENTS.md finding). This is the definition of "full integration" — every
  row green.

**App features itay asked for:**

| Feature | Today | Plan |
|---|---|---|
| **3D graph** | Memory tab is a 2D force graph | O7 half: render the memory + asset lineage graph in 3D (`3d-force-graph`, pinned version, local bundle), same data, 2D fallback, keyboard and reduced-motion support |
| **Retro page for improvements** | Retro tab (usage/pricing retro) | add per-slice retros fed from `backlog.yaml` verdicts and the OS-vs-solo scorecard: what failed, what repeated, which assets paid (O4 skill ROI) |
| **Trending skills** | Discover tab + trends scan proposals | O2 "new-tool radar": rank trends by fit to *this* machine's usage (asset_usage invocations), with an install proposal through the existing proposals flow |

## 6. Remaining features, in order

1. **Phase 8 close** — readiness §4 steps 1–6 (AA map, attestation, cohorts at night on OCI,
   live re-drive, owner gate decision, close record).
2. **Copilot infra** — W1 backlog + report, N1/N2 scheduler bits, guarded auto-merge if confirmed.
3. **CLI-1 → CLI-3.**
4. **Cockpit-as-app** — A1, A2, then 3D graph, retro, radar.
5. **Real OS-vs-solo scorecard** — needs the repo secret (or an OCI-run `pnpm eval` with the
   subscription login) and a fixed task corpus.
6. **Jev live** — add the typesafe config on OCI (itay's call), one live drive, role verdict.
7. **Phase 9 economics** (O1–O4; needs K7 + K14, both shipped).
8. **Stage 2 remote auth → Vercel UI** — per cloud note recommendation (b) then (a), after its four
   questions are answered.
9. **vNext 10–13** — subtasks, fan-out, multi-repo saga, progress projection (which then replaces
   `backlog.yaml` points with real subtask counts for OS tasks).
10. **Phase 10 depth** — O5 named agents, O8 LLM intent classifier, O11 Cursor/Bedrock
    provisioning, O12 personal integrations.
11. **K13 activation** — after a week of shadow log and itay's review.

## 7. Auto-merge: a guarded option (needs itay's explicit confirmation)

The standing rule is **"Agents never merge. I do."** This plan does **not** change it. It proposes
an option; nothing auto-merges until itay confirms in writing **and** merges the PR that edits the
rule in both `AGENTS.md` files.

| Option | What merges automatically | itay merges |
|---|---|---|
| **A — keep the rule** | nothing | everything |
| **B — guarded (recommended)** | PRs that pass *every* guard below | everything else |
| C — broad | any green agent PR | nothing | (not recommended) |

**Guards for B (all must hold, evaluated by a workflow, not by the agent):**

1. Branch `claude/*` or `codex/*`, base `main`, not a draft, not stacked.
2. **Path allowlist:** `docs/**` and `*.md` only — excluding `AGENTS.md`, `CLAUDE.md`,
   `docs/contracts/**`, `contracts/**`, `.github/**`. (A later widening, e.g. web-only tests, is a
   separate decision.)
3. Diff ≤ 400 changed lines; no migration, workflow, lockfile or credential-path change.
4. All required checks green **on the exact head SHA**; the merge call sends that SHA (GitHub
   returns 409 if it moved, and the guard re-evaluates rather than retrying blindly).
5. Merge commit only (standing rule); never squash or rebase.
6. **Kill switch:** a repo variable `AUTO_MERGE=off` (default off) checked on every run; itay flips
   it, no code change needed. A `no-auto-merge` label on a PR always wins.
7. **Audit:** every auto-merge is listed in the daily report with PR, SHA and guard results; itay can
   revert.
8. The merging identity is the workflow's `GITHUB_TOKEN` with `contents: write` scoped to that job;
   agent sessions get no merge credential, and branch protection has no bypass for them.

Implementation (only after confirmation): `.github/workflows/auto-merge-guard.yml` +
`.github/auto-merge-policy.yml` + a test fixture, plane first, then Cockpit. Branch protection with
required checks is a repo setting itay sets.

## 8. What to borrow from comparable projects

| Project (status per its own pages/third-party comparisons, Nov 2026) | Mechanism worth borrowing | Where it lands |
|---|---|---|
| **Claude Squad** (AGPL, tmux + worktrees, Claude/Codex/Gemini/Aider) | one worktree + one terminal per task; attach/detach | `aos attach`; standing worktree rule |
| **Vibe Kanban** (Apache-2.0, now community-maintained) | kanban of agent tasks with per-task diff review | Cockpit Progress panel over `backlog.yaml` |
| **Conductor**, **Nimbalyst** (Claude + Codex side by side) | one UI for both assistants, PR flow per workspace | web shell + Apps launcher |
| **Orcy** (MIT) | atomic task claiming, auto-release after 30 min silence, peer review between agents | backlog `lane`/`claimed_at`; stale claim release in the daily routine; `verifier ≠ implementer` (vNext P2) |
| **Bernstein** | deterministic scheduler, pre-merge "janitor" verifier, HMAC audit trail | auto-merge guard as a separate verifier; audit line per merge |
| **Composio Agent Orchestrator** | milestone gates, automatic CI-failure retry | backlog deps as gates; CI-fix loop stays per PR |
| **Sculptor** (Imbue) | container per agent, changes move in only after approval | already our model (cloud container / worktree + PR) |
| **opencode** | TUI as a thin client of a local server | `aos` design |
| usage-limit tools (claude-auto-resume and similar) | detect the limit message, sleep to reset, resume | rule 3.4; at S2 the plane's K2 does it with evidence |
| **ccusage / Claude-Code-Usage-Monitor** | per-window burn rate and reset prediction | `aos quota`, daily report quota line |
| WorkOS merge-policy guidance | merge as a separate governed path, pinned head SHA, stale-review dismissal, no bypass | §7 guards |

Not borrowed: hosted SaaS orchestrators (provider logins must stay on OCI), and anything that
makes an external tool the source of canonical state (vNext §11).

Sources: [Nimbalyst comparison](https://nimbalyst-website.pages.dev/blog/best-agent-management-tools-2026/),
[Orcy comparison](https://orcy-website.pages.dev/compare),
[WorkOS merge policies](https://workos.com/blog/ai-coding-agent-github-merge-policies),
[claude-auto-resume](https://www.sourcepulse.org/projects/8194741),
[usage-limit topic](https://github.com/topics/usage-limit?l=python). Both comparison pages are
vendor-written; treat their claims about competitors as unverified.

## 9. First wave (ordered)

Parallel items touch disjoint files. Prompts reference repo files only.

| # | Item | Lane | Model / effort | Owns | Starts after |
|---|---|---|---|---|---|
| W0 | Answer the decisions in §10 | itay | — | — | now |
| W1 | `docs/progress/backlog.yaml` (audited from both repos' docs and merged PRs, incl. vNext 1–9 status) + `scripts/progress-report.mjs` + one AGENTS.md pointer line | Claude cloud | Sonnet 5.5 / high | `docs/progress/**`, `scripts/progress-report.mjs`, AGENTS.md (1 line) | this plan merged |
| W2 | O12 phase 2: read the AA grounding list on OCI | OCI | Codex / low | none (read-only) | now |
| W3 | AA map grounding (`AA_MODEL_MAP` from W2's ids) | Claude cloud | Opus 5.5 / high | the AA map file + its test | W2 |
| W4 | A2 integration audit (matrix + drift test) | Claude cloud | Sonnet 5.5 / medium | cockpit `docs/integration-matrix.md`, one cockpit test | now (cockpit repo, disjoint) |
| W5 | CLI-1 read-only `aos` | Claude cloud | Opus 5.5 / high | `apps/cli/**`, root `package.json` script, `pnpm-workspace.yaml` | now |
| W6 | Daily report routine (morning, itay's timezone) | coordinator | — | — | W1 merged |
| W7 | Phase 8 step 2–3: attest base config, then ≥10 sonnet + opus composed coding runs, **night**, serial | OCI | Claude Code / Sonnet 5.5 medium | live config only | W3 merged, itay OKs the quota spend |
| W8 | Auto-merge guard (option B) | Claude cloud | Sonnet 5.5 / high | `.github/workflows/auto-merge-guard.yml`, `.github/auto-merge-policy.yml`, AGENTS.md rule text | itay confirms §7 |
| W9 | N1 + N2: heavy-run slot of 1, preferred night window | Claude cloud | Opus 5.5 / high | scheduler config + dispatch check + tests | W5 merged (both touch root config docs) |

W1, W2, W4 and W5 can start together. W1 and W8 both touch `AGENTS.md`, so W8 waits for W1.
Prompts for W1–W5 go in the planning thread once this plan is approved.

## 10. Open questions for itay

1. **Auto-merge:** keep option A, or adopt B with the §7 guards? (Recommended: B, docs-only, kill
   switch default off until you flip it.) The rule "Agents never merge" stays in force until you say so.
2. **Night window and timezone:** which hours count as night, in which timezone? (Default proposal:
   23:00–07:00 local.)
3. **Daily report:** what time, and where — project chat only, or also a pinned artifact page?
4. **Quota spend at night:** may night runs spend subscription quota on Phase 8 cohorts and eval runs
   without asking each time, up to a cap you name?
5. **Cloud note (#133):** the four questions there (path, fixture preview, IdP, metered billing) are
   still open; Vercel waits on them.
6. **Jev live:** add the typesafe config on OCI now, or after Phase 8 closes?
7. **Phase 8 close:** close on "the gate holds and is shown live", or wait a week for one applied
   decision? (Readiness §4 step 5.)

## Verdict

**SKIP** — plan document only; no runtime surface.
