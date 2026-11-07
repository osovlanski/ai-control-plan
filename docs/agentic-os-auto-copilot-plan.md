# Agentic OS — operating plan: from manual lanes to a proven autonomous loop

Status: **PROPOSED**, revision 4, 2026-11-07 (D-13, D-14, D-15 decided by itay the same day). Plan only. Nothing here is implemented, enabled or
deployed by this PR. Where this file and the diff disagree, the diff wins.

Revision 2 answered itay's architecture review. Revision 3 answered the independent Codex review
of revision 2 at `662e020` (FAIL, 13 findings; ledger §I.2). Revision 4 answers the **Codex
review of revision 3 at `a15ce6e`** (FAIL, 14 findings, three blockers; pasted by itay on
2026-11-07). Every finding was re-checked against the code on this branch; all fourteen hold and
the ledger is §I.4. Every claim below names its evidence: **test** means a repo test, **fake
drive** a recorded run against a fake provider, **live** a recorded run on the OCI operator plane
with a real provider. Anything without one of those is UNVERIFIED.

The Codex review brief is `docs/agentic-os-auto-copilot-codex-review-brief.md`. Reviews of
revisions 2 and 3: **done (FAIL)**. Revision 4's re-review: **PENDING**.

---

## A. Executive recommendation

**Build no new kernel. Prove one bounded autonomous loop on OCI, with Claude only, using the
kernel that exists, and add one small module — the autopilot — that owns what is genuinely
missing: stopping, reservation, attempt accounting, acceptance, publication and recovery. Before
any of that, run agents as a different Unix user from the plane.**

The repository already contains most of what the vision asks for: durable dispatch with
generations (K1), quota re-park with evidence (K2), quota probes (K3), dependency waits (K4),
resource slots (K4b), recurring schedules (K5), resolved model identity (K7), AA evidence (K8),
context observation (K9) and clean-session continuation (K11), the composer and per-run
provisioning (M1–M3), shadow model selection with activation gates (K13), five routing profiles,
approvals, Harness hard runtime deadlines, checkpoint commits, project verification, parallel
compare, and a conversational web shell.

What revision 4 changes, and why:

1. **Agents stop sharing the plane's identity (§C.0, P0-A).** Both real adapters run with
   `processIsolation: "none"`, so any provider tool could read the plane's bearer credential,
   database and GitHub token. Providers and acceptance commands move to a separate `aos-agent`
   user; starting the autopilot needs an `autopilot.operate` secret that only itay holds. This is
   what makes "no agent restarts it" enforceable (review 2, finding 3).
2. **Reservation uses GitHub's create-ref API with a recoverable owner (§C.2.2).** An ordinary
   `git push` is not create-if-absent. Every lane creates `os/<id>` pointing at its own
   deterministic reservation commit and requires HTTP 201 or an owned 422 (findings 1, 4, 5).
3. **The launch gate sits at provider launch, not in `wake()` (§C.2.3).** Recovery resumes
   reserved dispatches without re-entering `wake()`, so the stop, window, budget, billing and host
   checks run beside `assertLaunchClaim` on every path (finding 2).
4. **Serial ownership lasts until publication (§C.2.1),** with a recovery rule for every state,
   including acceptance on a detached checkout of the checkpoint SHA (§C.2.7, finding 7) and
   publication identified by repo, head, base, SHA and a marker instead of a lease (§C.2.4,
   finding 6).
5. **Runtime is budgeted per attempt and per window (§C.2.5).** Continuations share one budget,
   sessions are cut at the window's close, and the window count is charged at first launch
   (finding 8). Approval denial or expiry ends the attempt `blocked` (§C.2.8, finding 9).
6. **Billing is attested, not assumed (§D.2).** A subscription login does not by itself stop at
   plan limits when usage credits or auto-reload are on; the gate requires itay's attestation
   (finding 10).
7. **The OCI box stays a single host, and that is stated (§C.5).** An external heartbeat detects
   it going silent, restore is drilled on a replacement host and fails closed (finding 12).
8. **The first loop is Claude-only (§F).** Codex joins after its own auth, approval, cancel and
   usage drives (finding 14).
9. Kept from revision 3: token caps are advisory on both real providers (`claude.ts:120`,
   `codex.ts:110`, `control-plane-bridge.ts:85`); the dispatcher is an in-plane `selectNext()`;
   AI Doctor, the provider manifest, Apps, mobile, graph and radar are outside launch acceptance;
   **auto-merge stays off and off the roadmap**, and `AGENTS.md` merge authority is unchanged.

### The eight questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | What existing code already solves these requirements? | Scheduling, recovery, resource slots, quota handling, runtime deadlines, checkpoint commits, model evidence and shadow selection, context continuation, composition, approvals, verification, compare, the web shell and Cockpit integration. Inventory in §B. |
| 2 | What is genuinely missing? | For the loop: agent/plane user separation and an operator-only start authority, a launch gate on every launch path, attempt-wide runtime budgets, stop conditions and admission accounting, host admission, item reservation and attempts, verification-to-SHA binding with explicit acceptance commands, durable publication, an in-plane dispatcher, system-level restore. Later: a native CLI, an OS-vs-solo scorecard on real providers, grounded AA ids, effort-aware cohorts. Remote auth stage 2, subtasks (vNext 10–13) and K10 are missing but not needed for the loop. |
| 3 | What is the smallest autonomous workflow we can prove on OCI? | With agents running as `aos-agent`, the autopilot started by itay and the night window open: reserve `os/<item>` by create-ref → create the plane task and attempt in one transaction with a `resource` wait on `oci-heavy: 1` → K1 dispatch → launch gate → composed Harness run with **Claude** under the attempt's runtime budget → checkpoint commit → the item's acceptance commands on a detached checkout of that SHA → one draft PR identified by its publication marker → next item, until the count, the window, a failure limit or the stop switch ends it. Proven by experiments G0–G18 (§G). |
| 4 | Which features improve measured outcomes versus adding complexity? | Improve: the loop, its stops and its recovery (work happens unattended and safely), the scorecard (tells us whether routing helps), grounded AA priors. Complexity until proven: multi-agent chains, Jev on new hot-path sites, Doctor escalation, a provider manifest, 3D graph, auto-merge. |
| 5 | What depends on subscriptions, separate APIs or future integrations? | §D.2 binds each lane to one auth mode. OCI loop: Claude subscription login under `aos-agent`, with a billing attestation (D-1, D-13). Codex is not in the first loop; its lane and auth (D-2) come with P1-0. Eval in GitHub Actions: API keys. AA and Jev: their own keys. Plane → cloud workers: no integration exists. |
| 6 | How do we evaluate model selection, effort and multi-agent coordination? | Shadow first; cohorts by exact identity, with effort added as a new key (it is not one today, §B.2) and unknown kept unknown; activation only through K13's six gates; multi-agent only as a scorecard arm until it beats single-agent under comparable controls. §D.4–D.5. |
| 7 | How does AI Doctor stay useful, cheap and non-repetitive? | Deferred out of launch. When it starts: deterministic, fingerprinted ledger, hard budget, at most three findings, read-only (§C.6). |
| 8 | How does a first-time user get a task done without learning the architecture? | Type the goal into the shell; Balanced is the default; the OS shows a one-line plan, asks only for approvals it needs, and ends with a PR link and a verdict. §E.4. |

---

## B. Verified implementation inventory

Status vocabulary: **SHIPPED** (merged, with evidence named), **PARTIAL**, **DESIGN-ONLY**,
**BLOCKED**, **UNVERIFIED** (merged code, but the named property has not been observed),
**MISSING**. Project decisions recorded in PROJECT_MEMORY (phase closes, owner verdicts) are
decisions, not properties the code establishes.

### B.1 Scheduling, recovery and bounds

| Item | Status | Evidence | Test vs live |
|---|---|---|---|
| K1 durable dispatch, generations, boot reconciliation | SHIPPED | `apps/api/src/modules/scheduler.ts`, migration 014, `docs/agentic-os-k1-implementation.md` | tests + `pnpm demo:a` (fake clock); no recorded live crash test on OCI |
| K2 quota re-park with blocker evidence; `maxAutoWakes` (default 3) bounds re-parks **per task** | SHIPPED | `quota.ts`; `scheduler.ts:594` | tests; no recorded live quota exhaustion |
| K3 quota probe (Claude OAuth usage endpoint; others `unsupported`) | SHIPPED, opt-in, default off; **endpoint is configurable** (`quota-probe.ts:41` reads `options.usageEndpoint` from assistant config and sends the bearer token there) | `quota-probe.ts`, migration 016 | tests; live use UNVERIFIED |
| K4 dependency waits | SHIPPED | `packages/core/src/scheduler.ts:51` | tests |
| K4b resource slots | SHIPPED | `docs/agentic-os-k4b-resource-slots.md`, migration `023_resource_slots.sql`, `apps/api/test/resource-slots.test.ts` | tests; **never configured or exercised on OCI** |
| K5 recurring schedules, IANA timezones, `overlap: skip/queue` | SHIPPED; occurrences create ordinary tasks parked on a `time` wait with **no pool requirement** (`schedules.ts:402`) | `schedules.ts`, `docs/agentic-os-k5-overlap-queue.md` | tests |
| Harness hard runtime deadline (`maxRuntimeMs` → `TIMED_OUT`) | SHIPPED on the Harness path | `harness/session-runner.ts` (hard/idle timeouts, l. 398, 649); composer policy takes the lower of spec and workspace cap (`control-plane-bridge.ts:85`) | tests |
| Token caps | **advisory** on Claude and Codex | no `usageReporting` contract (`claude.ts:120`, `codex.ts:110`); bounded only with one (`control-plane-bridge.ts:85`, `session-runner.ts:1089`) | — |
| Checkpoint commit returning a SHA | SHIPPED | `apps/api/src/repo/git.ts` `commitCheckpoint` | tests |
| Project verification bound to a commit SHA | **MISSING** | `project-verification.ts` records no SHA. Discovery warnings (malformed or missing `packageManager`, ambiguous lockfiles, malformed `package.json`, l. 38–57) **do not pass silently on the Harness path**: `verification-coordinator.ts:136` throws on any warning, which ends verification `blocked` (revision 3 said they were skipped — wrong, review 2 finding 13). What is missing is the SHA binding and an explicit per-item command list | tests |
| Recovery of reserved dispatches | SHIPPED; **does not re-enter `wake()`** | `continueDispatch()` → `start()` at boot and sweep (`scheduler.ts:973`, `:1057`, `:835`); any gate placed only in `wake()` is skipped there | tests |
| Process isolation of provider tools | **none** | both real adapters declare `processIsolation: "none"` (`claude.ts:121`, `codex.ts:111`); the plane's bearer credential file is mode 0600 but owned by the same user (`auth/credential-file.ts:8–24`); auth checks capability, not identity (`auth/index.ts:23`) | — |
| Per-session vs per-attempt runtime | per session only | each execution request gets its own hard timeout (`control-plane-bridge.ts:128`; `session-runner.ts:354–357`), so failover, restart and K11 continuation each start a fresh clock | tests |
| Approval denial | returns the session to `RUNNING` | `session-runner.ts:1507–1532`; expiry cancels (`:1498–1501`) | tests |
| Plane pushes branches or opens PRs | **MISSING** | no push or PR code in `apps/api/src` | — |
| Global automation stop, per-window counts, closing time | **MISSING** | `notBefore` gates opening only (`packages/core/src/scheduler.ts:54`) | — |

**K4b, corrected (finding 5).** For a task that carries a pool requirement, the single-task path is
sound: `POST /api/tasks` creates the task and attaches the wait in one transaction
(`server.ts:462`), `resourceGate` grants inside the wake transaction (`scheduler.ts:740`, claim at
`:759`), the wake calls `startTask` (`:864`), and `startTask` asserts the claim
(`orchestrator.ts:609`). Revision 2's "every start goes through `startTask`" was **wrong**:
composed compare/race starts candidates through `startComposedCandidates` → `HarnessBridge.start`
→ `SessionRunner` → `adapter.start` (`orchestrator.ts:2018`, `:2102`;
`control-plane-bridge.ts:200`; `session-runner.ts:1264`) without `assertLaunchClaim`. It is not an
open hole for autopilot tasks — `/parallel` refuses a task that is not `CREATED`/`ROUTING` or has an
open dispatch (`orchestrator.ts:1962–1966`) — but the autopilot must never create parallel tasks,
and G2 tests resource-bearing tasks against both parallel implementations, replay, restart,
handoff, failover and continuation. Requirement-free tasks legitimately run without claims
(`scheduler.ts:255`).

Remaining K4b gaps, handled by the launch gate (P0-2) and the host gate (P0-3) rather than by new slot machinery:

1. Only tasks carrying a requirement compete; K5 occurrences carry none. The autopilot creates its
   own tasks with the requirement and does not use K5.
2. The pool counts plane runs, not the machine.
3. `releaseIfIdle` releases a terminal task's claim even while a provider process is still exiting
   (`scheduler.ts:387`; K4b record §3 "Known ceiling").
4. `resourceReady` admits every operator wake unconditionally (`scheduler.ts:132`), so a host check
   placed there would be bypassable. Revision 3 moved it into the wake transaction; revision 4 moves
   it again, to provider launch (§C.2.3), because recovery does not pass through `wake()`.
5. `capacity()` accepts only integers (`scheduler.ts:96`; `config.ts:884`), so admission settings
   go under a separate key and the numeric pool format stays as it is.

### B.2 Model intelligence

| Item | Status | Evidence | Test vs live |
|---|---|---|---|
| K7 requested vs resolved identity, price evidence | SHIPPED | K12/K14 closure record; `model-catalog.ts` | live: opus → `claude-opus-5` ×4 (A0, CLI 2.1.238, 2026-11-06) |
| K8 AA evidence pipeline | SHIPPED, **0 of 726 rows mapped** | `artificial-analysis.ts` `AA_MODEL_MAP` (only 4.x slug guesses), PROJECT_MEMORY "K8 AA map grounding diagnostic" | live refresh 2026-11-07 mapped 0; grounding list ready to read (O12 phase 2) |
| K13 shadow selection, `w(n)=n/(n+k)`, six activation gates | SHIPPED, shadow only | `model-selection.ts`, `packages/core/test/model-intelligence.test.ts`; A1 #156, A2 #155, A4 #157, P2 #162 | live: decisions carry no recommendation (no priors, sonnet n=0) |
| Hard filters before scoring (auth, capability, policy, quota, security) | SHIPPED | `model-selection.ts:80–184` takes the router's own per-assistant filter verdict | tests |
| Routing profiles | SHIPPED | `RoutingProfile` = `auto`, `preserve-quota`, `fastest`, `best-quality`, `lowest-tokens` (`server.ts` `/api/tasks`) | tests |
| AA rows for OpenAI/Codex models | MISSING | `AA_MODEL_MAP` has Anthropic entries only | — |
| Effort as an identity dimension | PARTIAL | AA scores effort variants as separate rows (K8 grounding note); "no effort reported anywhere" in A0 | live A0 |
| Cohorts keyed by effort or assistant | **MISSING** | `modelCohorts` (`apps/api/src/modules/telemetry.ts:201`) filters by task kind and harness major and groups by resolved provider/model; it selects neither effort nor assistant | — |

### B.3 Context

| Item | Status | Evidence |
|---|---|---|
| K9 context observation, gauge in web and Cockpit (#37) | SHIPPED | K12 live acceptance #41 (2026-09-15) — live |
| K11 clean-session continuation from a checkpoint | SHIPPED, **fake provider only** | `docs/agentic-os-k11-context-continuation.md`; 7b close record names the exclusion |
| K10 provider-command compaction | DESIGN-ONLY, out of scope | 7b close record |

### B.4 Session input and handoff

| Item | Status | Evidence |
|---|---|---|
| Cross-provider handoff / failover (fresh-prompt start of the successor) | SHIPPED | `harness-implementation-progress.md` deferral 1 note; `failover.test.ts` |
| Handoff claim protocol (resume from provider session) | DESIGN-ONLY | standing deferral #7; scorecard 2026-09-05 "deliberately gated" |
| Live session input, Claude | SHIPPED | `ClaudeCodeSessionInputAdapter`, delivery proved from the CLI's own transcript (`server.ts:1270–1290`); tests |
| Live session input, Codex | **SHIPPED, opt-in** (revision 3 called it a spike — wrong, review 2 finding 13) | `CodexAdapter.sessionInput` exists only when the app-server runtime is configured (`codex.ts:78`, `codex-app-server-runtime.ts:31`); correlated receipts in `codex-session-input.ts`; wired at `server.ts:1279`. Not established: idempotent send, a consumption guarantee; SDK attach stays BLOCKED on 0.154.0; tests, live UNVERIFIED |
| Restart after crash (`POST /api/tasks/:id/restart`) | SHIPPED | #119 |
| Harness single mode | SHIPPED, **default off** | `config.ts` `resolveExecution` (default `false`); the operator's setting is UNVERIFIED (O7 composed runs imply on) |

### B.5 Evaluation

| Item | Status | Evidence |
|---|---|---|
| `pnpm eval`, scorecard schema, `pnpm eval:promote` | SHIPPED | `docs/agentic-os-eval-plan.md` |
| Promoted scorecards | **one, fake scenarios only** | `docs/eval-history/scorecard-2026-09-05.md` (revision 1 said "none promoted": wrong) |
| `.github/workflows/eval.yml` | **manual only** (`workflow_dispatch`), uses `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` secrets (metered API), not set | the workflow file; decision D3 2026-11-05 |
| Real-provider scorecard, OS-vs-solo corpus | MISSING | — |
| Routing offline eval (labelled corpus) | SHIPPED | `routing-eval.test.ts` |

### B.6 CLI and shell

| Item | Status | Evidence |
|---|---|---|
| Conversational shell: mission composer, command bar, inspector, orbital field, applications (Overview, Agents, Memory, Routing, Traces, Tools, Settings) | SHIPPED | `docs/ui/agentic-os-ui-v3.md` (2026-09-17); `apps/web/src/shell/MissionShell.tsx`, `board/CommandBar.tsx`, `board/Inspector.tsx`, `board/OrbitalField.tsx` |
| Terminal-style shell view (process list, STAGE column, detail tabs, keyboard 1–4/Enter/Esc) | SHIPPED | part A (#113), B1 (#150), B2 (#152), `apps/web/src/shell-view/*` |
| `aos` native CLI | MISSING | only `apps/api/src/bin/*` operator tools (`open-web`, `rotate-credential`, reports) |
| Authenticated non-loopback serving | DESIGN-ONLY | API refuses a non-loopback bind (`config.ts:886`); `docs/adr/remote-auth-design.md` stage 2 not built. Tunnelling loopback over SSH works today |

### B.7 Cockpit integration

| Item | Status | Evidence |
|---|---|---|
| Vendored contracts: registry, bundle, usage, asset-usage, memory, task-stage | SHIPPED, **no drift** | checked 2026-11-07: every file in cockpit `contracts/*/VENDORED.json` hashes equal to the same path on plane `main` 6a5ef9e |
| Plane-only contract `composition` | not consumed by Cockpit | plane `contracts/composition/v1`; no Cockpit vendor (no finding: Cockpit does not read it) |
| M8 registry, M9 bundles, M10 asset usage, O6 S2/S6 memory, task stage #53 | SHIPPED | Cockpit PROJECT_MEMORY; live O7b dogfood 2026-11-06 |
| Cockpit tabs: Agents, Usage, Retro, Discover, Memory (2D graph), Proposals, Schedule, Knowledge, Context | SHIPPED | `public/index.html` tab list |
| Cockpit as a registered app in the plane | MISSING | no apps/providers read in the plane |

### B.8 Phases

| Phase | Status | Evidence |
|---|---|---|
| 6, 7 | closed 2026-10-31 | plan §6, PROJECT_MEMORY |
| 7b | closed 2026-11-05 with named exclusions (K10 out, K11 fake only) | PROJECT_MEMORY close record |
| 8 | open; all slices merged; close path in `docs/agentic-os-phase8-readiness.md` §4 | #161 |
| 9, 10 | not started | plan §6 |
| vNext increments 10–13 | DESIGN-ONLY | `docs/agentic-os-vnext-plan.md` |
| vNext increments 1–9 | not audited here | W-audit in P1 |

### B.9 Jev

"JET" in itay's notes is taken to mean **Jev**, TypeSafe's System One model, which is the only
"J" decision provider in the repository (M16, `apps/api/src/modules/decision-typesafe.ts`). If JET
names a different product, it is not integrated anywhere in either repo.

| Item | Status | Evidence |
|---|---|---|
| `TypeSafeDecisionProvider` behind the `DecisionProvider` seam | SHIPPED | `decision-typesafe.ts`, `decision-typesafe.test.ts` |
| Role | **offline only**: floor discovery (`decision:floor-discovery`), Jev first and Haiku behind it, pinned `jev-1.13` (owner yes, 2026-10-21) | PROJECT_MEMORY 2026-10-04 / 2026-10-21 |
| Hot path | **none, by owner decision**: the tool gate reads rules and deterministic floors only | PROJECT_MEMORY "Owner decision: M16 converts" |
| Measured | p50 303 ms, $0.047 per 1,000 decisions via OpenRouter, 0/150 benign removed, agrees with 29/29 floors; §7.2 risk-cross bar FAILED for Jev and Haiku | PROJECT_MEMORY 2026-10-04 |
| Live operator config | missing `decisions.typesafeApiKeyRef` / `typesafeRoute` | O2, 2026-11-05 |

---

## C. Target architecture

### C.0 The root fix: agents do not run as the plane's Unix user

Both Codex reviews kept finding one cause behind several defects: both real adapters declare
`processIsolation: "none"` (`claude.ts:121`, `codex.ts:111`), so a provider tool can read and write
anything the plane's Unix user can — the command-capable bearer credential
(`auth/credential-file.ts`, mode 0600 but owned by that same user), the SQLite database, and any
GitHub token the plane holds. The API authorises by capability only (`auth/index.ts:23`), not by
who is asking. With that layout, "only itay restarts the autopilot", "agents cannot alter
accounting" and "agents cannot read the GitHub token" cannot be true.

Revision 4 therefore makes **user separation** the first P0 slice (P0-A):

- **`aos-agent`** — a second Unix user that owns the provider logins (`~aos-agent/.claude`,
  `~aos-agent/.codex`) and runs every provider process and every acceptance command. It cannot
  read the plane's home, database, credential file or GitHub token, and it has a user manager
  (`loginctl enable-linger aos-agent`) so each run gets its own systemd scope.
- **Plane user** (today's operator user) — runs the plane, owns SQLite, the bearer credential
  file and the GitHub token. It starts a run through a single sudoers rule that allows exactly one
  wrapper, `/usr/local/lib/aos/run-as-agent`, as `aos-agent` with no other commands. The wrapper
  starts the provider CLI inside `systemd-run --user --scope --unit=aos-run-<task>-<session>`. The
  Agent SDK and Codex SDK both accept an executable-path override, so the adapters point at the
  wrapper; **that this works end to end with each SDK is UNVERIFIED** and is what P0-A's spike
  proves first.
- Worktrees live under a directory owned by the plane user with group `aos`, group-writable,
  `setgid`, and `aos-agent` in group `aos` — the agent can edit the task's worktree, not the
  plane's state.
- **Operator authority**: a new capability `autopilot.operate`, required by
  `/api/autopilot/start`, `/release` and any change to windows or limits. Its secret is **not** in
  the plane's credential file. The plane stores only its hash (in config, written by a
  `rotate-credential`-style bin run by itay); itay holds the secret on his own machine and uses it
  through the SSH tunnel. `stop` stays available to the ordinary `commands.write` credential —
  stopping is always allowed, starting is not.

If P0-A's spike fails for an SDK, that vendor does not join the autopilot; nothing else in the
design relies on a weaker fallback.

### C.1 Components and who owns what

```
 itay ──(SSH tunnel, autopilot.operate)──► Plane API (loopback)
                                             │
   plane user ┌──────────────────────────────┼──────────────────────────────────────┐
              │ autopilot: reservations, attempts, windows, acceptance, publications │
              │ scheduler K1–K5 + K4b + launch gate (new, in startTask)              │
              │ composer + router + K13 ─► Harness ─► run-as-agent wrapper ──────────┼─┐
              │ SQLite · bearer credential · GitHub token (plane user only)          │ │
              └──────────────┬───────────────────────────────────────────────────────┘ │
                             │ GitHub API (refs, pushes, draft PRs)                     │
                             ▼                                                          ▼
                          GitHub ◄── manual lanes reserve via create-ref        aos-agent user
                                                                                 systemd scope per run:
                                                                                 provider CLI, acceptance
```

| Concern | Single authority | Writers |
|---|---|---|
| Desired work | `docs/progress/backlog.yaml` at `origin/main` | merged PRs |
| Reservation of an item, all lanes | GitHub ref `os/<item-id>` pointing at a **reservation commit** (§C.2.2) | create-ref only (never `git push`) |
| Attempts, windows, runtime used, acceptance, publications, task state | plane SQLite | plane user only |
| Code, PRs, review, CI | GitHub | — |
| Progress and the daily report | derived | nobody by hand |
| Machine assistant config, skills, memory sources | Cockpit | Cockpit |

### C.2 The autopilot

#### C.2.1 Attempt lifecycle (serial ownership until the end)

`autopilot_attempts.state`: `reserving → admitted → running → settled → accepting → accepted →
publishing → published`, or a final `failed | blocked | cancelled | window_closed | conflict`.
The loop is serial: **`selectNext()` refuses while any attempt is in a non-final state** — not
"while a task is non-terminal". A task can be `COMPLETED` (`orchestrator.ts:1308`) while its
attempt is still `accepting` or `publishing`, and that attempt still owns the loop.

Every state change is one SQLite transaction by the plane user. Each non-final state has a
recovery rule run at boot and on the sweep:

| State | On boot / sweep with no live owner | Rule |
|---|---|---|
| `reserving` | reconcile the ref (§C.2.2) | owned → `admitted`; absent after grace → retry or release; external → `cancelled` (not ours) |
| `admitted` / `running` | existing K1/K4b reconciliation for the task | plus the launch gate before any start |
| `settled` | start acceptance | — |
| `accepting` | acceptance run row without a live scope | discard the partial run, start a new run number |
| `accepted` | insert the publication intent | idempotent on attempt id |
| `publishing` | publication reconcile (§C.2.4) | never re-runs the provider |

#### C.2.2 Reservation — exclusive across lanes, owner recoverable remotely

`git push origin <base>:refs/heads/os/<id>` is **not** create-if-absent: if the ref already points
at the same base the push succeeds as up to date, and a fast-forward can move an existing ref
(review 2, finding 1). So every lane reserves with GitHub's create-ref API and requires
**HTTP 201**:

1. Build a **reservation commit**: tree = base commit's tree, parent = base, message
   `aos-reservation item=<id> lane=<lane> reservation=<uuid>`, author/committer name, email and
   date fixed from the reservation intent. Its SHA is computed locally before any request, so it is
   unique per reservation and deterministic for retries.
2. Persist the intent (`reservation_id`, `item_id`, `commit_sha`) — plane lanes in SQLite, manual
   lanes in the prompt's own first output.
3. `POST /git/commits` (same content → same SHA, so a retry is harmless), then
   `POST /git/refs` with `ref=refs/heads/os/<id>`, `sha=<commit_sha>`.
4. Outcomes: **201** → owned. **422 exists** → `GET` the ref: if it points at our `commit_sha` (or a
   descendant whose root reservation commit is ours) → owned (a retry or a lost 201); otherwise →
   external, recorded with the other reservation id read from the commit message, never re-run.
   **Timeout / 5xx** → uncertain: re-read the ref; absent → retry the create; present → apply the
   422 rule. Ownership is never inferred from the base SHA.

Manual lanes (Claude Code cloud, Codex cloud, itay) run the same three API calls as their first
step (`gh api` or the GitHub MCP `create_branch`, which is create-ref) and stop on anything but 201
or an owned 422. The work then goes on top of the reservation commit, so the PR's first commit is
an empty marker commit; that is the visible cost of a remotely recoverable owner.

The GitHub write token is the plane user's (C.0), so `selectNext()` can reserve without a second
credential.

#### C.2.3 Launch gate — at provider launch, on every path

Revision 3 put the stop/window/host checks in `wake()`. Review 2 showed why that is not enough:
reserved dispatches are resumed through `continueDispatch()` → `start()` at boot and on the sweep
(`scheduler.ts:973`, `:1057`, `:835`) without re-entering `wake()`, so a reservation made before
07:00, or recovered after a restore with the autopilot stopped, would still launch.

Revision 4 puts one check, `assertAutopilotLaunch(taskId, dispatchId)`, **immediately before the
provider launch, beside `assertLaunchClaim`** in `startTask` (`orchestrator.ts:609`), and makes the
composed parallel path refuse any autopilot task outright (`startComposedCandidates` never sees
one; the autopilot never creates parallel tasks, and the refusal is defence in depth). It applies to
every launch of an autopilot task: first start, `continueDispatch` recovery, K2 wake, K11
continuation, failover, handoff and `/restart`. It checks, in one read transaction:

- autopilot `running`;
- now ∈ an open window **and** `closes_at − now ≥ minSliceMs` (default 10 min);
- the attempt's remaining runtime budget > 0 (§C.2.5);
- the window allowance for this attempt is charged or chargeable (§C.2.5);
- billing attestation present for the launching assistant (§D.2);
- host gate (§C.2.6).

A refusal happens before any provider process exists. It ends the start through the existing
"failed start / no candidate re-park" path (dispatch released, claim released, task re-parked with a
`time` wait to the next window opening, or to `WAITING_INPUT` when stopped), so no new recovery
path is introduced.

#### C.2.4 Publication — exactly-once by identity, not by lease

The plane is a single process, so there is one publisher and the DB lease of revision 3 is dropped;
it could not fence an outstanding GitHub request anyway (review 2, finding 6). Instead:

- **Identity.** A publication is (`repo`, head `os/<id>`, base branch, `verified_sha`,
  `publication_id`). The PR body must carry `aos-publication: <publication_id>`. A PR is adopted
  only if repo, head ref, head SHA, base branch and marker all match.
- **Push** uses `--force-with-lease=os/<id>:<expected>` where `expected` is the reservation commit
  or the last pushed SHA, so a moved branch fails atomically on GitHub's side.
- **Uncertain requests.** After a timeout or unreadable response on a push or PR create, the
  publisher issues **no further mutation** for that publication until a reconcile read finds the
  effect (adopt) or finds it absent twice, at least `uncertainGraceMs` (default 2 min) apart.
  Because the publisher is the only writer of `os/<id>` and of PRs carrying the marker, "absent
  after grace" cannot be a request still in flight from another publisher.
- **Re-check before each mutation**: autopilot not stopped, attempt still `publishing`, remote ref
  at `expected`, no PR for the head in any state with another marker. Closed or merged → `closed`,
  never reopened. Head changed → `conflict`.
- **Auth failure** (401/403) → publication `failed`, autopilot `stopped` with reason `github-auth`.
  429/5xx → backoff, bounded attempts, then `failed`.

#### C.2.5 Bounds — per attempt and per window, across continuations

Review 2 (finding 8) showed each Harness session gets its own fresh hard timeout
(`control-plane-bridge.ts:128`, `session-runner.ts:354–357`), so failover, restart and K11
continuation would each get a full allowance. Revision 4:

- **Attempt runtime budget.** `autopilot_attempts.runtime_budget_ms` (default 90 min) and
  `runtime_used_ms`, updated at every session settlement from the session's start/end. Each new
  session of an autopilot task gets
  `maxRuntimeMs = min(workspace cap, budget − used, closes_at − now − graceMs)`, so a session
  started at 06:50 is cut at 07:00 minus the grace, and continuations share one budget.
- **Closing time with active work.** The per-session deadline above ends the active session at the
  window's close; its attempt becomes `window_closed` (retryable, runtime used carried) and parks to
  the next window. Nothing autopilot runs in the day.
- **Window allowance.** The count is charged **at the first launch of an attempt in a window**, not
  at task creation: a row `autopilot_window_charges(window_id, attempt_id)` is inserted by the
  launch gate, unique per pair. A quota-parked attempt carried into tonight consumes one of
  tonight's units when it launches; it never runs uncharged.
- K2's `maxAutoWakes` and the per-item attempt limit remain.

#### C.2.6 Host gate

Per `scheduler.admission.<pool>` (numeric `scheduler.resources` unchanged): load, free memory,
free disk, and **no live agent process**. With C.0, every provider and acceptance process runs in
an `aos-run-*` scope under `aos-agent`'s user manager. The check reads the `populated` field of
`cgroup.events` for `aos-agent`'s `app.slice` — the kernel's recursive "any process in this
subtree" signal, covering nested cgroups — rather than a `cgroup.procs` census, which revision 3
wrongly called descendant-complete and PID-reuse-proof. A process that moves itself elsewhere inside
`aos-agent`'s delegated tree is still in that user's slice, so the gate reads the whole
`user-<uid>.slice` minus the user manager's own `init.scope`. Unreadable → not admitted.

#### C.2.7 Acceptance — on an immutable tree, with its own lifecycle

At `settled`, after the launch scope of the run is empty (§C.2.6), the plane:

1. commits the worktree with `commitCheckpoint` (`repo/git.ts:132–144`) → `sha`;
2. creates a **fresh detached checkout** of `sha` in a separate directory (`git worktree add
   --detach`), owned by group `aos`, so no late writer in the task worktree can affect it;
3. inserts `acceptance_runs(attempt_id, run_no, sha, state=running)` and runs the item's explicit
   commands there as `aos-agent` in their own scope, each with a timeout;
4. records `{ command, exit, duration }` per command and the run as `passed | failed | blocked`;
5. verifies after the run that the checkout's `HEAD` is still `sha` and the tree is clean; otherwise
   `blocked`.

An empty command list, a skipped discovery or a missing item `acceptance` is `blocked`, never
`passed`. A crash mid-run leaves `running` with no live scope → discarded, new `run_no`. Success
before the publication insert is recovered by the `accepted` rule in §C.2.1.

#### C.2.8 Approvals in unattended runs

The existing path delivers a denial to the provider and returns the session to `RUNNING`
(`session-runner.ts:1507–1532`); expiry cancels the session (`:1498–1501`). Neither ends an
autopilot attempt by itself. Autopilot policy: on any approval answer `denied` for an autopilot
task, the autopilot requests cancellation through the existing cancel path and records the attempt
`blocked` (non-retryable); a session cancelled by approval expiry is recorded the same way. The
task's state machine is unchanged; only the attempt outcome is autopilot's.

### C.3 Backlog and progress

Item fields: `id` (stable forever), `title`, `phase`, `repo`, `size` (S=1, M=3, L=8),
`depends_on`, `files`, `lane` (`oci-loop | manual-cloud | owner`), `profile`, `acceptance`
(commands + drive, required for `oci-loop`), `night` (bool). No status field. Derived status, from
GitHub and the plane:

| Status | Rule |
|---|---|
| done | PR from `os/<id>` merged |
| in review | open PR from `os/<id>` |
| running | autopilot attempt `running`, or `os/<id>` exists with no PR (manual lane working) |
| retryable | last attempt failed `retryable` and attempts < max |
| blocked | last attempt `blocked`/`terminal` failure, attempts exhausted, or a closed unmerged PR — needs itay |
| queued | none of the above |

A revised item (new revision digest) keeps its `id`; the next attempt records the new revision.
The report shows **estimated scope points** done / total, labelled as an estimate, and scope added
that day as its own line.

### C.4 Lanes, honestly

| Lane | Reaches the plane? | Reserves an item by | Auth (§D.2) |
|---|---|---|---|
| OCI autopilot → Claude Code adapter (first loop) | yes | `selectNext()`: intent row, then create-ref (§C.2.2) | D-1, D-13 |
| OCI autopilot → Codex adapter | — | **not in the first loop**; joins with P1-0 | D-2 |
| Claude Code cloud (project threads) | **no** | first step: create-ref with its own reservation commit; anything but 201 or an owned 422 → stop | Anthropic's own product, itay's own login |
| Codex cloud | **no** (no integration demonstrated) | same first-step rule | ChatGPT sign-in + MFA (Codex cloud requires it) |
| itay | via SSH tunnel | same | — |

A manual lane that does not reserve first can still collide; the prompt template makes the
create-ref call its first command and its output names the reservation id, so a collision is
visible in the thread. A plane-side remote worker contract (registration, short-lived scoped
credentials, leases with fencing, artifact transfer) stays unscheduled until a real need exceeds
the OCI box.

### C.5 OCI topology, failure detection, backup and restore

**Single host, stated.** The OCI VM, its one SQLite file and its one plane process are a single
point of failure, and the first loop accepts that: when the box is down, nothing runs and nothing
is lost beyond the recovery point below. What revision 3 lacked was a way to **notice** (review 2,
finding 12): its stale-tick flag lived in a report produced on the same box.

- **Units:** `agent-plane-operator.service` (plane user), `cockpit-dashboard.service` (#51), and
  per-run scopes under `aos-agent`'s user manager (§C.0). No separate publisher unit (§C.2.4). All
  loopback. Access over SSH or Tailscale only; the API stays private until remote-auth stage 2.
- **External heartbeat (D-14).** While the autopilot is `running`, the plane pings an external
  dead-man's-switch URL every 10 min with no payload beyond the check id. A missed ping inside a
  window alerts itay by email from the external service. The ping URL is a secret of the plane
  user; nothing else leaves the box.
- **Backup:** nightly online backup (sqlite3 backup API + `integrity_check`) before the window
  opens, kept 7 days on the box and copied **off-host**, encrypted (D-11). Recovery point: up to
  24 h of plane DB. GitHub holds reservations (the reservation commit names its id) and
  publications (the PR marker), so those are recoverable from it.
- **Restore fails closed.** A restored DB (detected by a `restored_at` marker the restore script
  writes) boots with the autopilot **stopped**, treats the current window as **exhausted** (no
  launch until the next window, even after a start), and runs one reconciliation before `start` is
  accepted:
  - every `os/*` ref: reservation commit with a known reservation id → reattached to its attempt;
    unknown id → recorded as an external reservation, never re-run;
  - every PR with an `aos-publication` marker → matched to its publication; unknown → external;
  - every worktree on disk without a task → quarantined (moved aside, not deleted);
  - every attempt in a non-final state → its §C.2.1 rule, with no provider launch;
  - any process in `aos-agent`'s slice → reported, and the host gate stays closed until it exits.
  `start` is refused until the report exists and has been read back through `autopilot.operate`.
- **Replacement-host drill (P0-7).** Restore is proven on a **fresh VM**, not the original: install
  from the docs, restore the latest off-host copy, log in as `aos-agent`, run the reconciliation, and
  compare its report with GitHub. The drill's time to a startable plane is recorded as the recovery
  time.
- **Other outages:** GitHub auth failure stops the autopilot (§C.2.4). Disk below
  `minFreeDiskMb` closes the host gate. A token revocation needs a new token file and a start with
  `autopilot.operate`.

### C.6 AI Doctor — deferred out of launch

Design kept for later (finding 13): deterministic daily job, fingerprinted findings ledger, hard
budget, at most three findings, read-only, presented in Cockpit. `jobs.ts` is an in-process timer
without durable occurrence catch-up (`jobs.ts:25`), which is acceptable for an advisory scan whose
next run reads "changes since the last cursor". Starts only after G0–G18 pass and only with a
stated need.

### C.7 Provider manifest — deferred

The existing seams (`AgentAdapter` capability blocks, `DecisionProvider`, `EvidenceSource`,
registry v1, `/api/models`) already present capabilities. A manifest is added only if a second
consumer needs a single projection of them, and then strictly as a read projection with no
loading of third-party code.

---

## D. Provider intelligence and economic strategy

### D.1 Capability matrix

| Capability | Claude (Code / Agent SDK) | Codex (CLI / SDK / app-server) | AA | Jev | OCI VM |
|---|---|---|---|---|---|
| Executes coding tasks | yes (adapter, live) | yes (adapter, live) | no | no | host only |
| Typed decisions | via `ModelDecisionProvider` (Haiku) | not wired | no | yes (M16) | — |
| External model intelligence | no | no | yes (K8) | no | — |
| Unattended execution | yes on OCI via the plane | yes on OCI via the plane | daily refresh job | offline jobs | systemd |
| Resume / checkpoints | plane checkpoints + K11 (fake-only proof); provider resume deferred (#7) | same; app-server input on a spike | n/a | n/a | — |
| Auth verified | subscription login on OCI (live) | subscription login on OCI (live) | API key on OCI | OpenRouter key (measured 2026-10-04) | — |
| Observable quota / cost | K3 probe (Claude OAuth usage endpoint); counted usage on results | counted usage; rate-limit RPC unimplemented | n/a | `usage` tokens, $ per 1k | CPU/mem (P0-3) |
| Where it runs | local, OCI | local, OCI | API | API | — |

### D.2 Authorisation matrix

Sources read 2026-11-07: Claude support article "Use the Claude Agent SDK with your Claude plan"
(updates of 2026-06-15 and 2026-10-07), `code.claude.com/docs/en/legal-and-compliance`,
`learn.chatgpt.com/docs/auth`. The OpenAI help article on Codex with a ChatGPT plan **failed to
load**; rows depending on it are UNVERIFIED. itay's plan tiers are not known here and are not
assumed.

| Use | Anthropic | OpenAI / Codex |
|---|---|---|
| Personal interactive CLI | subscription OAuth is intended for plan purchasers' "ordinary use of Claude Code and other native Anthropic applications" | ChatGPT sign-in for subscription access, or API key for usage-based access; both for local CLI |
| Personal SDK / `claude -p` / `codex exec` on own machine or own VM | signed in with a plan, the Agent SDK and `claude -p` **draw from subscription limits** (2026-10-07); advertised limits "assume ordinary, individual usage" | docs: "use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs"; personal unattended use on own VM with ChatGPT sign-in is not addressed in what was read → **D-2** |
| Non-interactive automation (night queue on OCI) | same as above; keep volume ordinary and individual; an API key from a linked Console org is the documented alternative (monthly API credits are included on some plans per the 2026-10-07 update; tier unknown) | API key recommended for programmatic workflows → **D-2** |
| Remote cloud workers / CI (GitHub Actions eval) | API key (repo secret), metered | API key, metered; Codex cloud itself requires ChatGPT sign-in + MFA and is a separate product |
| Product used by other people | API key only; no Claude.ai login offered in the product; no routing requests through Free/Pro/Max credentials for users; no collecting or intermediating Claude.ai tokens | API key / enterprise auth; not designed here |
| Sharing tokens with remote workers | never | never (`~/.codex/auth.json` is a password) |

Cost categories reported separately everywhere: **included subscription usage** (tokens counted,
$ shown as API-equivalent and labelled so), **API credits included with a plan** (only if itay
links them), **metered API spend**, **infrastructure** (OCI, OpenRouter, AA). No quota limit is
reverse-engineered or bypassed. K3 calls only the provider's own usage endpoint by default; P0-8
makes that the only production destination (today it is configurable, `quota-probe.ts:41`).

**Precision on Anthropic's product-hosting rule** (finding 10): the legal page does not say
"API key only" for every product. A product may let its own end users sign in to the unmodified
binary with **their own** subscription; what it forbids is offering Claude.ai login inside a
third-party app, routing requests through Free/Pro/Max credentials on users' behalf, and
collecting, storing or intermediating Claude.ai credentials or tokens. Nothing in this plan lets
anyone other than itay consume itay's subscription.

**Lane → auth binding** (each lane has exactly one approved mode; a lane never borrows another's):

| Lane | Claude | Codex |
|---|---|---|
| itay interactive (laptop, OCI over SSH) | subscription login | ChatGPT sign-in |
| OCI autopilot (unattended, personal) | subscription login under `aos-agent` (D-1), with billing attestation (D-13) | **not in the first loop**; per D-2 when P1-0 adds it: API key (recommended) or ChatGPT sign-in |
| OCI scorecard runs (§D.5) | same as the autopilot lane | same as the autopilot lane |
| GitHub Actions `eval.yml` | API key secret (metered) | API key secret (metered) |
| Claude Code cloud / Codex cloud | the provider's own product with itay's own login | the provider's own product with itay's own login |
| Any multi-user future | each user's own credentials or the product's API key; never itay's login | same |

**Billing attestation** (review 2, finding 10). Revision 3 claimed the subscription lane meant "no
metered spend; plan limits are a hard stop". That is not established by the login alone: Claude
plans can continue past their limits on usage credits or extra-usage settings, and OpenAI spend
limits on an API project can be exceeded before they take effect. So the launch gate (§C.2.3)
requires, per assistant, a **billing attestation** row written by itay with `autopilot.operate`:
which auth mode the lane uses, that extra usage / usage credits / auto-reload are **off** or capped
at a stated amount, the date checked, and a re-check interval (default 30 days; expired → not
admitted). The plane cannot read billing settings; the attestation is itay's statement, recorded
and shown in the report, not a verified fact. Spend that appears anyway (a metered line in a
provider's usage page) is reported as an incident and stops the autopilot by hand.

### D.3 Two-stage selection (already the design; keep it)

1. **Eligibility (deterministic, cheap):** the router's hard filters — auth, capability, workspace
   policy, quota evidence (K2 projection), security, compatibility, explicit overrides. No score can
   re-admit a filtered candidate (`model-selection.ts`).
2. **Choice among eligible (evidence):** K13 blends AA priors and own telemetry with `w(n)=n/(n+k)`
   per dimension, under the task's routing profile. Shadow until the six gates pass.

**User-facing goals map onto existing profiles — no new concept:** Best Quality → `best-quality`,
Balanced (default) → `auto`, Fast & Efficient → `fastest`. Advanced: `preserve-quota`,
`lowest-tokens`, model/assistant overrides.

**Spending bounds, corrected (finding 2).** On Claude and Codex a token cap is **advisory**: the run
is told the cap and usage is counted, but nothing stops it at the cap. What is enforced for an
unattended run is: the attempt-wide runtime budget shared by every session of the attempt
(§C.2.5; the Harness hard deadline alone is per session), the autopilot's per-window item count,
charged at first launch, and per-item attempt limit, K2's `maxAutoWakes` per task, the window's
closing time, which cuts the active session, and the provider's plan limits **only where itay has
attested that no overage source is on** (§D.2, review 2 finding 10). Token use is measured per attempt and **overshoot against the advisory
cap is reported** in the daily report. Dollar caps stay deferred (deferral #3's five gates).

### D.4 Effort and roles

- **Effort is identity, not a knob shared across vendors** — and today it is **not** a cohort key
  (`modelCohorts` groups by resolved provider/model only, `telemetry.ts:201`). P1-5 adds effort and
  assistant to the cohort key, keeps `unknown` effort as its own value, and adds identity-specific
  tests. Claude `high` and Codex `high` are never treated as equal; AA's per-effort rows are the
  only cross-vendor anchor.
- **Roles.** Single agent + deterministic verification is the default. A separate **reviewer run
  on the other vendor** is added only by policy (size L; paths under `contracts/`, `migrations/`,
  `auth/`, `.github/`, or agent-instruction Markdown), as a second task with
  `assistantId ≠ implementer` and its own runtime cap; it counts against the window's item count.
  Planner → implementer chains wait for vNext 10. Multi-agent patterns earn a default only by
  beating single-agent on the scorecard under comparable controls.

### D.5 OS-vs-solo measurement

Hypothesis: *under the same runtime cap and the same prompts, the OS (Balanced) reaches a verified
result on at least as many corpus tasks as the better of Claude-solo and Codex-solo, with no more
unauthorised actions; tokens, time and cost are reported per arm, not traded silently.* This is
**not** an equal-token-budget experiment: token caps are advisory on both vendors, so token use is
an outcome, with each arm's overshoot reported.

- **Corpus:** 24 tasks — 8 small fixes, 6 features with tests, 4 refactors, 3 docs/research, 3 UI —
  across `ai-control-plan`, `cockpit` and a scratch fixture repo, each with explicit acceptance
  commands (never discovery alone).
- **Arms:** OS = personal workspace, composer on, profile `auto`. Solo = a second workspace with
  composer off and `overrides.assistantId` fixed, one per vendor. Every arm gets the same runtime
  cap and the same advisory token cap explicitly (solo runs do not inherit the composed arm's
  budget automatically). Every arm uses the same auth as the OCI autopilot lane (§D.2).
- **Metrics, separately:** verified success, unassisted completion, time to verified result,
  tokens and $ by category, overshoot, code quality (other-vendor review findings + lint/complexity
  deltas), recovery success after an injected kill on 6 tasks, incorrect or unauthorised actions,
  orchestration overhead.
- **Where:** on OCI as autopilot items at night, serialised in `oci-heavy`. Not in GitHub Actions.
- **Judging:** the acceptance commands decide; the implementer never judges itself.
- **Output:** a promoted scorecard (`pnpm eval:promote`). Until then: "OS ≥ solo: not measured".

### D.6 AA and Jev specifics

- **AA:** map exact ids from the live grounding list (never guessed), including the effort row
  that matches the CLI's default effort; add OpenAI rows for the Codex models in use; keep A4's
  base-config attestation as the precondition for priors. AA is evidence only. Mapping the CLI's
  default-effort row gives a **prior for that configuration**; it does not prove a run used that
  effort. A run's effort stays `unknown` unless the provider reports it, and such runs join no
  effort-specific cohort.
- **Jev:** stays offline (floor discovery). Candidate new sites, in order of expected value:
  (1) task classification against the frozen v1 regex classifier and the K20 v2 shadow rules,
  (2) review escalation ("does this diff need a cross-vendor reviewer?"), (3) prioritisation hints
  for the dispatcher. Each enters as a **shadow** `DecisionSite` with: a labelled corpus,
  calibration curve, a confidence threshold below which the rule answer is used, fail-closed to
  rules on timeout/error, and a pass bar stated before the run (e.g. ≥ rules accuracy at p95 < 500
  ms and < $0.10 per 1k). Never the tool gate (owner decision stands), never a scheduler.

---

## E. OS product experience

**Outside launch acceptance.** Nothing in this section is needed for the first autonomous loop
(Codex finding 13). The loop needs only what exists: task creation, approvals, logs, blockers,
the publication receipt and the stop switch, through `MissionShell.tsx`, `CommandBar.tsx` and
`shell-view/ShellView.tsx`. Each stage below needs a measured need before it starts.

### E.1 Philosophy

The conversation is the OS. Everything else is an app or an inspector you open when you need it.
Linux supplies the ownership model and the keyboard; modern apps supply discoverability.
The existing shell (`docs/ui/agentic-os-ui-v3.md`) already has the right parts; the work is
**hierarchy and defaults, not a rewrite**.

### E.2 Information architecture

- **Primary workspace — Chat/CLI:** one composer that takes natural language or `/` commands (the
  same verbs as `aos`: `/ps`, `/logs`, `/approve`, `/tonight`, `/quota`, `/apps`); streaming
  results with structured tool activity; inline plan, approval, diff and verdict cards; session
  history and resumable missions; command palette (Ctrl/⌘-K).
- **Left rail:** Missions · Agents · Memory · Models/Routing · Apps · Activity/Traces · Settings
  (today's applications, renamed where needed; Tools folds into Apps).
- **Inspector:** collapsed by default; opens on a task that needs you (approval, blocker) or on
  demand; shows assistant + model + why, stage, progress, usage/quota, blockers, approvals.
- **Orbital view:** an optional Agents-map app and the empty-state hero, not a fixture of every
  screen. The terminal-style shell view stays as a mode (`/view shell`).
- **Mobile:** monitoring and approvals only — mission list, notifications, approve/deny, PR links.

### E.3 Layout

Desktop: `rail 64px | conversation (flex, max 880px text column) | inspector 360px (closed by
default)`. ≤ 1024px: rail collapses to icons, inspector becomes a sheet. ≤ 640px: missions list →
mission detail → approval sheet; no composer of code tasks beyond a short goal box.

Visual identity (from the reference as described; the image itself is on the OCI box at the path
in `ui-v3.md` and was not available to this revision): very dark navy background, electric-blue
primary, violet for agent/AI activity, gold reserved for "needs you" and success moments only.
Restrained glow (focus and live state only), one type family plus a mono for commands, motion under
200 ms and disabled under `prefers-reduced-motion`, visible focus rings, every 3D view with a 2D
fallback. No new UI framework; evaluate small additions only where they replace hand-written code
(e.g. a command-palette primitive), each under a size budget.

### E.4 Journey: one prompt to a reviewed PR

1. itay types "Add retry with backoff to the Cockpit registry client" (Balanced).
2. The OS replies with a one-line plan card: *Codex · coding · cockpit · verify: npm test && npm run
   build · tonight if busy*, with "Change" (opens the inspector) and "Run".
3. Run → the mission streams: worktree created, files touched, tests running. If a tool needs
   approval, an inline approval card appears (and on mobile).
4. A limit hit shows "Paused until 03:10, will continue on Claude if eligible" — no action needed.
5. Verification passes → "Draft PR #N opened · PASS · 14 min · 38k tokens (subscription)".
6. itay reviews on GitHub, merges. The mission shows "merged".

### E.5 Staged frontend plan (reuses existing components)

| Stage | Change | Reuses |
|---|---|---|
| U1 | Chat-first default route; inspector collapsed by default; orbital moved behind an Agents-map toggle | `MissionShell`, `Inspector`, `OrbitalField`, `routes.ts` |
| U2 | `/` commands in the composer, mapped to existing reads/commands; command palette | `CommandBar`, `api.ts` |
| U3 | Plan/approval/verdict/PR cards inline in the conversation | `Composition.tsx`, `VerificationChecks`, `delivery.tsx` |
| U4 | Mobile monitor + approvals | shell routes, existing approval commands |
| U5 | Apps launcher (after the deferred manifest, §C.7) | `ApplicationWorkspace` |

A mockup is deferred until the reference image is uploaded to the project; it would be a static
page built from these stages, not a change to `apps/web`.

### E.6 Cockpit as the first installed app

Cockpit keeps its own UI, loopback bind and authority over assistant config. The plane links to
it; it does not re-implement Cockpit pages. A registered-app listing waits for the provider
manifest, which is deferred (§C.7). Cockpit features stay Cockpit's: the 3D memory/lineage
graph (O7 half, with a 2D fallback), the Retro tab gaining per-task retros from verdicts and the
scorecard, Discover's trends ranked by fit to this machine's asset usage (O2 radar), and the AI
Doctor view (deferred, §C.6).

---

## F. Prioritised roadmap

Complexity: S ≈ half a day, M ≈ 1–2 days, L ≈ 3+ days of one session. Every slice: own worktree,
named files, gate `pnpm typecheck && pnpm lint && pnpm test` (plane) or `npm test && npm run build`
(Cockpit), a drive where it executes, one verdict, PR to main, never merged by an agent.

### P0 — a bounded, recoverable autonomous loop, Claude only

| Slice | What | Files | Model / effort | Acceptance (tests unless marked drive) | Size |
|---|---|---|---|---|---|
| P0-0 | This plan; Codex re-review of revision 4 | docs | itay runs the brief | findings recorded in §I | S |
| P0-A | **User separation, spike then slice.** Spike on OCI: Claude Agent SDK launched through `run-as-agent` inside a `systemd-run --user --scope` as `aos-agent`, with a login owned by `aos-agent`; observe start, streaming, cancel (scope stop), exit code and usage. Then: the wrapper, the sudoers rule, the worktree group layout, the adapter's executable-path setting, and the `autopilot.operate` capability (hash in config, secret with itay) | `setup/run-as-agent`, `setup/sudoers.d/aos`, adapter config in `packages/adapters/src/claude.ts`, `auth/**`, `server.ts` (capability on the autopilot routes) | spike: OCI, Claude Code / Sonnet 5.5 medium; slice: Opus 5.5 / high | drive: the spike's run completes and cancels; tests + drive: a process as `aos-agent` cannot read the plane's credential file, DB or token, cannot call `/api/autopilot/start` with the ordinary credential, and cannot write autopilot tables | M (spike S) |
| P0-1 | OCI config only: `scheduler.resources: { oci-heavy: 1 }`; confirm `execution.harnessModes.single`, composer settings; plane runs as its systemd unit | live config | OCI, Codex / low | `GET /api/scheduler/status` lists the pool; config backed up | S |
| P0-2 | **Autopilot core + launch gate:** migration 042 (`autopilot_state`, `autopilot_windows`, `autopilot_window_charges`, `autopilot_attempts` with the §C.2.1 states and runtime budget, `billing_attestations`), stop/start/release routes (start and release need `autopilot.operate`), `assertAutopilotLaunch` beside `assertLaunchClaim` in `startTask`, composed-parallel refusal, per-session `maxRuntimeMs` from the attempt budget and the window close, approval denial/expiry → cancel + `blocked` | new `modules/autopilot.ts`, `orchestrator.ts` (gate call, parallel refusal), `harness/control-plane-bridge.ts` (runtime input), `session-runner.ts` (approval hook), `server.ts`, `config.ts`, migration lists in `db.test.ts`/`task-classifier.test.ts` | Opus 5.5 / high | default stopped; a reserved dispatch recovered by `continueDispatch` after 07:00 or while stopped is refused before any adapter call; continuation and failover share the budget; a session started 06:50 ends by 07:00 − grace; a carried attempt is charged at tonight's first launch; 4th charge in a window refused; denied approval with a provider that continues → attempt `blocked`, session cancelled; expiry → `blocked`; stop survives restart | L |
| P0-3 | **Host gate:** `scheduler.admission.<pool>` (`maxLoad1`, `minFreeMemMb`, `minFreeDiskMb`, slice `populated`), called from the launch gate | new `modules/host-admission.ts`, `config.ts` | Opus 5.5 / high | a live process in `aos-agent`'s slice blocks the next launch; a process that moved to another cgroup in that slice still blocks; unreadable `cgroup.events` → refused with reason; existing `resource-slots.test.ts` unchanged and green | M |
| P0-4 | **Acceptance on an immutable tree:** `acceptance_runs`, detached checkout of the checkpoint SHA, commands as `aos-agent` with timeouts, HEAD/clean check, recovery of `accepting` | new `modules/acceptance-run.ts`, migration 042 | Opus 5.5 / high | empty plan / skipped discovery → `blocked`; crash before, mid-command and after success before the publication insert each recover per §C.2.1; a writer touching the task worktree during the run does not change the result; result SHA = checkpoint SHA | M |
| P0-5 | **Publications by identity:** migration 043, force-with-lease push, PR create with the marker, the uncertain-request rule, re-check before each mutation, in the plane process | new `modules/publications.ts` | Opus 5.5 / high | fake-GitHub tests: push response delayed past the grace then landing; PR create landing after a timeout; stale lookup result; old process revived after restart; stop / close / merge / head change between lookup and mutation; wrong base or missing marker → not adopted; 401/403 stops the autopilot; retry never re-runs the provider | L |
| P0-6 | **`selectNext()` + reservation:** backlog fetch and validation, intent row, reservation commit, create-ref with the four outcomes, attempt + task in one transaction, triggers (attempt final, boot, sweep) | `modules/autopilot.ts`, `docs/progress/backlog.schema.json`, `scripts/backlog-check.mjs`, `docs/progress/manual-lane-reserve.md` | Opus 5.5 / high | fake GitHub: two plane retries of one intent → one owner; lost 201 → owned via 422; another lane's ref at the same base → external; manual-vs-plane at the same base SHA → exactly one 201; 3 items from an **empty** queue in one window, the 4th refused; no second attempt while one is `accepting` or `publishing` | M |
| P0-7 | **Restore, heartbeat, backup:** `restored_at` marker, fail-closed boot, reconciliation report, start refused until read; external heartbeat (D-14); nightly encrypted off-host copy (D-11); replacement-host drill runbook | `modules/autopilot.ts`, `scripts/backup.sh`, `docs/runbooks/autopilot-restore.md` | Sonnet 5.5 / high | stale restore after a push and a PR → refs and PR reattached or external, nothing re-run; current window treated as exhausted; lost worktree → attempt `blocked`; missed heartbeat simulated → alert received | M |
| P0-8 | K3 probe egress: production endpoint fixed to the Anthropic host, `redirect: "error"`, transport injection for tests | `quota-probe.ts`, its test | Sonnet 5.5 / high | a configured foreign endpoint is refused at load; a redirect is not followed | S |
| P0-9 | `docs/progress/backlog.yaml` audited from both repos (incl. vNext 1–9 status), every `oci-loop` item with acceptance commands | `docs/progress/**` | Sonnet 5.5 / high | `backlog-check` passes | M |
| P0-10 | **Minimum morning report** (moved up from P1 because an unattended night needs a readout): per attempt outcome, runtime used, tokens and overshoot, charges, stop reason, heartbeat gaps, billing attestation age; a plain-text endpoint and a file under the plane's data dir | `modules/autopilot.ts` (read route), `scripts/morning-report.mjs` | Sonnet 5.5 / high | numbers reproduce from the DB and GitHub | S |
| P0-11 | Live proof G0–G18 on OCI | none (drives + evidence) | OCI, Claude Code / Sonnet 5.5 medium, one experiment per session | §G | M |

Order and parallel safety: P0-A first (it decides whether the design stands). P0-2 next; P0-3, P0-4
and P0-5 touch disjoint files after it and can run in parallel. P0-8 and P0-9 run beside anything.
P0-6 follows P0-2 and P0-5. P0-7 and P0-10 follow P0-6. P0-1 runs on OCI any time.

### P1 — Codex lane, visibility and intelligence

| Slice | What | Model / effort | Gate |
|---|---|---|---|
| P1-0 | **Codex joins the autopilot**, first as the **quota fallback** itay asked for (D-13): when an attempt's Claude run is re-parked by K2 on a plan limit and Codex has no quota blocker, the next launch of that attempt routes to Codex inside the same attempt budget and window charge, as a fresh-prompt start from the checkpoint (the existing failover path, `failover.test.ts`). Preconditions: its own P0-A spike under `aos-agent`; drives of auth (per D-2), approval relay (today `approvalRelay: false`, so autopilot Codex runs use a policy that needs no relayed approval), cancel, usage and window cut. Codex extra usage stays off too | Opus 5.5 / high, then OCI | G2–G9 repeated with Codex; a fake Claude limit mid-attempt → the attempt finishes on Codex with one charge and one budget |
| P1-1 | AA map grounding (O12 phase 2 ids → `AA_MODEL_MAP`; OpenAI rows) | OCI read (Codex / low), then cloud Opus 5.5 / high | `mapped > 0` on the next live refresh |
| P1-2 | Full daily report as a projection (backlog + GitHub REST + plane reads), % of estimated scope points | Sonnet 5.5 / high | numbers reproduce from sources |
| P1-3 | `aos` CLI-1 read-only (`ps`, `logs`, `attach`, `quota`, `models`, `autopilot status`) | Opus 5.5 / high | drive against `pnpm dev` |
| P1-4 | `aos` CLI-2/3: create with preview (with a `clientRequestId` for the CLI's own retries), stream, approvals, `autopilot stop` (start only with `autopilot.operate`) | Opus 5.5 / high | idempotent create |
| P1-5 | Effort- and assistant-aware cohorts (`telemetry.ts` `modelCohorts`), `unknown` preserved | Opus 5.5 / high | identity-specific tests |
| P1-6 | Scorecard corpus + baseline workspace + night runs as autopilot items | Sonnet 5.5 / high, then OCI | promoted scorecard |
| P1-7 | Phase 8 close (readiness §4) with cohort runs as autopilot items | OCI + docs | close record |
| P1-8 | Jev shadow site #1 (task classification) with calibration and a pre-stated pass bar | Opus 5.5 / high | D-7 |
| P1-9 | AI Doctor D0, only with a stated need after G passes | Opus 5.5 / high | ≤ 3 findings, duplicate rate 0 on a replayed week |

### P2 — integrated product

U1–U5 (shell hierarchy), Cockpit 3D graph / retro / radar, remote-auth stage 2 then a Vercel UI
(after the cloud note's four answers), vNext 10–13, K13 activation (after a week of shadow log
and itay's review), the provider manifest and a remote worker contract (each only on demonstrated
need).

---

## G. Live proof plan (OCI, after P0-A…P0-10 merge)

One experiment per session, load < 1.5 before each, backup first. Fake assistant first
(`FAKE-*-not-real` for any secret), then real Claude where marked. A fake GitHub is used for
G10–G13; G15 uses the real repo with a draft PR.

| # | Experiment | Pass |
|---|---|---|
| G0 | Isolation: from inside a run as `aos-agent`, try to read the credential file, DB and GitHub token; call `/api/autopilot/start` and `/release` with the ordinary credential; write an autopilot table | every attempt refused; autopilot state unchanged |
| G1 | 3 autopilot items from an **empty** task queue in one window; a 4th eligible | 3 launched serially, 4th refused with reason "window count" |
| G2 | Resource-bearing autopilot task against `/start`, compare and race (legacy and composed), replay, `/restart`, handoff, failover, K11 continuation | no provider start without both gates; parallel refused; refusals recorded |
| G3 | `kill -9` the plane with an attempt in each of `reserving`, `admitted` (reserved dispatch), `accepting`, `publishing`; restart | each recovers per §C.2.1; no second provider start; charges unchanged |
| G4 | Recovered reservation after 07:00, and with the autopilot stopped | refused before any adapter call; task re-parked |
| G5 | Delayed composition crossing the close: launch at 06:50 | session ends by 07:00 − grace; attempt `window_closed`; nothing runs at 07:05 |
| G6 | Continuation and failover inside one attempt | total runtime ≤ the attempt budget |
| G7 | Yesterday's quota-parked attempt woken tonight | charged once tonight at launch |
| G8 | Host: child kept alive after settlement; a process moved to another cgroup in the slice; unreadable `cgroup.events`; disk below the floor | next launch refused in all four, reason shown |
| G9 | Approval pause; denial with a provider that continues; expiry | slot held while paused; deny and expiry → session cancelled, attempt `blocked` |
| G10 | Acceptance: empty plan, skipped discovery, FAIL, PASS, crash mid-command, writer touching the task worktree during the run | blocked, blocked, failed, PASS with the checkpoint SHA, re-run with a new `run_no`, result unaffected |
| G11 | Reservation on fake GitHub: retry of one intent, lost 201, another lane at the same base, manual vs plane race | one owner, owned, external, exactly one 201 |
| G12 | Publication on fake GitHub: delayed push past the grace, PR create landing after timeout, stale lookup, revived old process, 401 | exactly one PR; no duplicate mutation; 401 stops the autopilot |
| G13 | Closed PR; merged PR; branch moved; head changed; PR on the wrong base or without the marker | stop / stop / conflict / conflict / not adopted |
| G14 | Stale restore after a push and a PR; a deleted worktree | boots stopped, window exhausted, refs and PR reattached, worktree attempt blocked, start refused until the report is read |
| G15 | Real Claude: one item end to end on the real repo, draft PR | one draft PR with the marker and the verdict in the body |
| G16 | Real night: 3 items queued at 22:50 | morning report: 3 outcomes, runtime, overshoot, any K2 re-park, stop reason none |
| G17 | Heartbeat: stop the plane for 20 min inside a window | external alert received |
| G18 | Replacement-host restore drill | fresh VM reaches a startable plane; report matches GitHub; recovery time recorded |

Overall verdict PASS only when all nineteen pass.

---

## H. Decision log (needs itay)

| # | Decision | Recommended default | Consequence |
|---|---|---|---|
| D-1 | Claude unattended on OCI with the subscription login, under `aos-agent` | **yes**, personal and individual volume (2026-10-07 update: Agent SDK and `claude -p` draw from plan limits) | spend stays inside the plan **only with D-13**; revision 3's "no metered spend; plan limits are a hard stop" is withdrawn |
| D-2 | Codex unattended on OCI: ChatGPT sign-in or API key | **needed before P1-0** (the Claude→Codex fallback, D-13); an API key is metered, a ChatGPT sign-in draws on the plan, so given D-13's no-overage preference the recommendation becomes **ChatGPT sign-in under `aos-agent`, for personal use only**, unless OpenAI's terms rule that out (the help article did not load, UNVERIFIED). The docs read recommend an API key for programmatic workflows; if itay picks that, it gets a provider-side spend limit, which can be exceeded before it takes effect | Codex is not in the first loop; it is the fallback from P1-0 |
| D-3 | GitHub write token for the plane user: fine-grained, `contents:write` + `pull_requests:write`, two repos, **draft** PRs only | yes; held by the plane user, unreadable by `aos-agent` (§C.0). The separate publisher user of revision 3 is dropped | PRs appear without you; merging stays yours |
| D-4 | Night window | 23:00–07:00 Asia/Jerusalem; sessions cut at the close | nothing autopilot runs in the day |
| D-5 | Items per window, attempts per item, runtime budget per attempt | 3, 2, 90 min across all sessions of the attempt | the loop stops at the first limit hit |
| D-6 | Cloud note (#133) four questions | as the note recommends | Vercel waits for stage 2 |
| D-7 | Jev shadow experiment spend | ≤ $1 on OpenRouter, shadow only | measures Jev on classification |
| D-8 | Phase 8 close basis | close on "gate holds and is shown live" after P1-7 | does not wait a week |
| D-9 | AI Doctor | deferred until G passes | no work now |
| D-10 | Auto-merge | **off; not on the roadmap**; a future option would need its own approval, independently verified checks, head-SHA binding, branch protection, a kill switch, and a rule treating agent-instruction Markdown as code | `AGENTS.md` merge authority unchanged |
| D-11 | Off-host backup destination | OCI Object Storage bucket in the same tenancy, client-side encrypted, 7-day retention | a small storage cost; restore needs the key |
| D-12 | Who may start or release the autopilot | itay only, **enforced** by the `autopilot.operate` secret that lives on his machine (§C.0); anyone may stop | no agent can restart it |
| D-13 | Billing attestation | **decided 2026-11-07 (itay): extra usage and auto-reload stay off.** The attestation records that, re-checked every 30 days. When Claude's plan limit is reached, work should continue on Codex if Codex has quota left (P1-0) | without the attestation the launch gate admits nothing; until P1-0 lands, a Claude limit re-parks the attempt to its reset or the next window |
| D-14 | External heartbeat service | **decided 2026-11-07 (itay): yes.** A free dead-man's-switch check (e.g. Healthchecks.io), email to itay, 10-min period inside the window | one outbound ping with no payload; an outage is noticed within ~20 min |
| D-15 | User separation on OCI: a second Unix user `aos-agent`, linger, one sudoers rule for one wrapper, Claude re-login as that user | **decided 2026-11-07 (itay): yes.** P0-A is a spike first and the plan stops if it fails | providers lose access to the plane's state; one extra login |
| D-16 | Single-host risk | accept for the first loop; no hot standby; restore drilled on a replacement VM | an OCI outage stops the loop; nothing duplicates |

---

## I. What changed

### I.1 Revision 4 versus revision 3

**Root cause addressed:** agents ran as the plane's Unix user with no process isolation → §C.0
user separation and an operator-only start secret (P0-A, G0).

**Corrected:** "`git push` reserves the ref" → create-ref with a deterministic reservation commit;
"gates in the wake transaction cover every actor" → recovery bypasses `wake()`, the gate moves to
launch; "boot adopts or deletes an orphan ref" → owner identity in the commit; "no task
non-terminal" → no attempt non-final; per-session runtime → per-attempt budget; count at creation
→ charge at first launch; approval denial → explicit `blocked`; "no metered spend" → attested;
`cgroup.procs` census → `cgroup.events` `populated` on the agent's slice; "discovery warnings are
skipped" → they block on the Harness path, only SHA binding is missing; "Codex input is a spike" →
shipped opt-in.

**Dropped:** the separate publisher user and its token split (one plane process is the only
publisher; the agent cannot read the token anyway); the publication lease.

**Added:** P0-A, P0-10 (minimum morning report, moved up from P1-2), P1-0 (Codex lane), external
heartbeat, replacement-host drill, fail-closed restore, G0 and G3–G18 rewritten, D-13…D-16.

**Earlier (revision 3 versus revision 2):** token caps advisory; composed compare/race bypasses
`assertLaunchClaim`; effort cohorts missing; K3 endpoint configurable; precise Anthropic rule; an
in-plane dispatcher instead of `clientRequestId` intake; restore reconciliation and off-host
backup; AI Doctor and the manifest cut from launch.

### I.2 Codex review of revision 2 (`662e020`, FAIL) — ledger

Rows 3, 4, 6 and 9 were replaced by revision 4; see the end of §I.4.

| # | Finding | Checked against | Verdict | Resolution |
|---|---|---|---|---|
| 1 | No enforceable stop conditions | `packages/core/src/scheduler.ts:54` (`notBefore` only), `scheduler.ts:594` (`maxAutoWakes` per task) | **holds** | P0-2: durable counts, closing-time re-park for every actor, attempt limit, persistent stop; G1, G6, G7 |
| 2 | "Token caps enforced" is false | `claude.ts:120`, `codex.ts:110`, `control-plane-bridge.ts:85` | **holds** | §D.3 bounds rewritten; overshoot reported; §D.5 not equal-budget |
| 3 | Lookup is not exactly-once publication | settlement → `COMPLETED` (`orchestrator.ts:1308`); no publication code exists | **holds** | §C.2.1 durable record, lease, exact reconcile, closed/merged/moved handling; P0-5; G10–G11 |
| 4 | Dedup is not item ownership | `tasks.ts` has no item mapping | **holds**, with one challenge: the review asks for one authority across lanes; the plane cannot be it because cloud lanes cannot reach it | stable id + revision + attempt in the plane; the GitHub ref is the cross-lane reservation, created first by every lane; §C.3 statuses fixed |
| 5 | `startTask` funnel has an exception | `orchestrator.ts:2018, 2102`, `control-plane-bridge.ts:200`, `session-runner.ts:1264`; guard at `orchestrator.ts:1962–1966` | **holds** (not exploitable for autopilot tasks) | §B.1 corrected; autopilot never creates parallel tasks; G2 |
| 6 | P0-3 does not close release-at-terminal | `scheduler.ts:387`, `:132`, `:96` | **holds** | gate in the wake transaction for every actor; cgroup-based liveness; separate config key; G4, G5 |
| 7 | No dispatcher liveness | `schedules.ts:402` (K5 creates task intents), `jobs.ts:25` | **holds** | in-plane `selectNext()` on durable triggers; G1 from an empty queue |
| 8 | Restore ≠ system recovery | single WAL file (`db/index.ts:13`) | **holds** | P0-7: off-host copy, stopped boot, reconcile refs/PRs/worktrees; G13 |
| 9 | K3 egress configurable; publisher isolation | `quota-probe.ts:40–52` | **holds; severity challenged** to medium: the override comes from the operator's own config file, not from request input, so it needs a config edit by someone who can already read the credential file | P0-8; publisher as a separate Unix user (§C.2.1) |
| 10 | Auth assumptions inconsistent | §D.5 vs D-2; legal page wording | **holds** | lane → auth binding; precise Anthropic rule (§D.2) |
| 11 | Effort cohorts not implemented | `telemetry.ts:201`; AA map has two Anthropic entries | **holds** | §B.2 MISSING row; P1-5; effort `unknown` kept |
| 12 | Acceptance gaps | `project-verification.ts:38–57` skips with warnings | **holds** | P0-4 explicit acceptance bound to SHA; G-list extended (G8–G13) |
| 13 | Doctor, manifest, UI not needed for the loop | `MissionShell.tsx`, `CommandBar.tsx`, `ShellView.tsx` exist | **holds** | cut from launch; manifest deferred entirely (accepting the review's disagreement) |

### I.3 Disputes with itay's architecture review (from revision 2, still standing)

| Issue | Resolution |
|---|---|
| K4b deferred vs shipped | reuse K4b; no duplicate slot |
| Planner → Implementer → Reviewer → Verifier by default | single agent + deterministic acceptance; other-vendor reviewer by policy |
| A new plugin contract | deferred (§C.7) |
| Best / Balanced / Fast | existing routing profiles |
| Docs-only auto-merge | off; Markdown carries instructions |
| Backlog drives execution | backlog = desired work; plane = attempts; GitHub ref = reservation |
| Cloud chats as workers | manual lanes |

### I.4 Codex review of revision 3 (`a15ce6e`, FAIL) — ledger

All fourteen findings were checked against the code on this branch. None was pushed back on; two
(10 and 13) correct statements of mine rather than the design.

| # | Sev. | Finding | Checked against | Verdict | Resolution |
|---|---|---|---|---|---|
| 1 | blocker | Manual-lane `git push` is not an exclusive reservation | git push semantics: an up-to-date push succeeds, a fast-forward moves an existing ref | **holds** | §C.2.2 create-ref with a reservation commit, 201 or owned 422 only, every lane; §C.4; P0-6; G11 |
| 2 | blocker | Gates only in `wake()` leave recovery ungated | `scheduler.ts:973`, `:1057` → `continueDispatch()`; `start()` at `:835` does not re-enter `wake()` | **holds** | §C.2.3 `assertAutopilotLaunch` beside `assertLaunchClaim` (`orchestrator.ts:609`) on every launch; P0-2; G2–G5 |
| 3 | blocker | "Only itay restarts" is unenforceable | `auth/index.ts:23` capability only; `auth/credential-file.ts:8–24` same user; `claude.ts:121`, `codex.ts:111` `processIsolation: "none"` | **holds** | §C.0 `aos-agent` user + `autopilot.operate` secret off the box; P0-A; G0; D-12, D-15 |
| 4 | high | An orphan ref cannot be adopted or deleted safely; 422 rule breaks owned retries | revision 3 text: ref at the base SHA only; unconditional "422 → someone else" | **holds** | intent persisted first; owner id in the reservation commit; separate owned / uncertain / external rules; never inferred from the base SHA (§C.2.2) |
| 5 | high | Reservation writer cannot use the isolated publisher token | revision 3 put create-ref in the plane and the token in another user | **holds** | separate publisher dropped; the plane user holds the token, `aos-agent` cannot read it (§C.0, D-3) |
| 6 | high | A DB lease does not fence an outstanding GitHub request; adoption lacks base and marker | revision 3 §C.2.1 | **holds** | lease dropped (single process); force-with-lease push; uncertain-request rule with a grace; identity = repo + head + base + SHA + marker (§C.2.4); G12–G13 |
| 7 | high | Settlement → acceptance has no recovery protocol; checkpoint does not exclude a late writer | `orchestrator.ts:1308–1312` terminal; `repo/git.ts:132–144` stages and commits only | **holds** | serial ownership to the final attempt state (§C.2.1); `acceptance_runs` on a detached checkout after the slice is empty (§C.2.7); G3, G10 |
| 8 | high | Bounds are per session; window gate does not stop active work; count at creation | `control-plane-bridge.ts:128`; `session-runner.ts:354–357` | **holds** | attempt runtime budget; per-session `maxRuntimeMs` capped by the close; charge at first launch (§C.2.5); G5–G7 |
| 9 | high | Denial does not end an attempt | `session-runner.ts:1507–1532` → `RUNNING`; expiry cancels `:1498–1501` | **holds** | autopilot cancels and records `blocked` (§C.2.8); P0-2; G9 |
| 10 | high | Subscription login does not make plan limits a hard stop | Claude usage credits / extra usage; OpenAI spend limits can be exceeded | **holds** (my claim, withdrawn) | billing attestation in the launch gate (§D.2, D-13); D-1 reworded |
| 11 | medium | `cgroup.procs` is neither descendant-complete nor reuse-proof | cgroup v2: `cgroup.procs` lists only that cgroup; `cgroup.events` `populated` is recursive | **holds** | §C.2.6 reads `populated` for the agent's whole slice; G8 |
| 12 | medium | SPOF detection runs on the failing host | revision 3 stale-tick flag lived in the on-box report | **holds** | external heartbeat (D-14), stated single-host acceptance (D-16), replacement-host drill, fail-closed restore (§C.5); G14, G17, G18 |
| 13 | medium | Inventory: Codex input is shipped opt-in; discovery warnings block on the Harness path | `server.ts:1279`, `codex.ts:78`, `codex-session-input.ts`; `modules/verification-coordinator.ts:136` throws on warnings | **holds** (my inventory, corrected) | §B.4 and §B.1 rows rewritten |
| 14 | medium | The proof list is Claude-only but the loop claims both vendors | G12/G14 named Claude only; Codex `approvalRelay: false` | **holds** | first loop declared Claude-only; Codex is P1-0 with its own drives (§F, §C.4) |

Revision 3 resolutions replaced by this ledger: §I.2 row 3 (lease), row 4 (ref by `git push`),
row 6 (gate in the wake transaction), row 9 (publisher as a separate user).

## Verdict

**SKIP** — plan document only; no runtime surface. Codex reviews of revisions 2 and 3: **FAIL,
addressed above**. Codex re-review of revision 4: **PENDING**.
