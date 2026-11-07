# Agentic OS — operating plan: from manual lanes to a proven autonomous loop

Status: **PROPOSED**, revision 3, 2026-11-07. Plan only. Nothing here is implemented, enabled or
deployed by this PR. Where this file and the diff disagree, the diff wins.

Revision 2 answered itay's architecture review. Revision 3 answers the **independent Codex review
of revision 2 at `662e020`** (verdict FAIL, 13 findings, pasted by itay into the planning thread on
2026-11-07). Each finding was re-checked against `main` `6a5ef9e`; the ledger is §I.2. Every claim
below names its evidence: **test** means a repo test, **fake drive** a recorded run against a fake
provider, **live** a recorded run on the OCI operator plane with a real provider. Anything without
one of those is UNVERIFIED.

The Codex review brief is `docs/agentic-os-auto-copilot-codex-review-brief.md`. Revision 2's
review: **done (FAIL)**. Revision 3's re-review: **PENDING**.

---

## A. Executive recommendation

**Build no new kernel. Prove one bounded autonomous loop on OCI with the kernel that exists, and
add one small module — the autopilot — that owns what is genuinely missing: stopping, item
reservation, attempt accounting, publication and recovery.**

The repository already contains most of what the vision asks for: durable dispatch with
generations (K1), quota re-park with evidence (K2), quota probes (K3), dependency waits (K4),
resource slots (K4b), recurring schedules (K5), resolved model identity (K7), AA evidence (K8),
context observation (K9) and clean-session continuation (K11), the composer and per-run
provisioning (M1–M3), shadow model selection with activation gates (K13), five routing profiles,
approvals, Harness hard runtime deadlines, checkpoint commits, project verification, parallel
compare, and a conversational web shell. Revision 3's corrections over revision 2:

1. **An unattended loop needs enforceable stops, not a promise.** Durable per-window admission
   counts, a closing time, a per-item attempt limit, a persistent stop switch, and a host gate that
   no wake — operator or timer — can bypass (findings 1, 6).
2. **Token caps are advisory on the real providers.** Neither the Claude nor the Codex adapter
   declares a `usageReporting` contract (`packages/adapters/src/claude.ts:120`,
   `codex.ts:110`), so `composedExecutionPolicy` never selects bounded enforcement
   (`harness/control-plane-bridge.ts:85`). The enforceable unattended bounds are the Harness hard
   runtime deadline, the window, the admission count and the attempt limit; token spend is measured
   and its overshoot reported (finding 2).
3. **Publication is a durable lifecycle, not "one call after verification".** A `publications`
   record holds the intent and the verified SHA before any external effect; reconciliation matches
   repository, ref, SHA and PR exactly; closed or merged PRs and moved branches stop it; the
   publisher runs as a separate Unix user so provider tools cannot read its token (findings 3, 9).
4. **One reservation authority across lanes: the GitHub ref `os/<item-id>`.** Creating a ref that
   exists fails atomically, and every lane — the OCI loop and manual cloud sessions — can reach
   GitHub, while only OCI can reach the plane. Execution attempts live in the plane (finding 4).
5. **The dispatcher lives in the plane, not in cron.** One idempotent `selectNext()` runs on a
   task's settlement, on publication completion, at boot and on the scheduler sweep; catch-up is
   derived from durable state, not from timer occurrences (finding 7).
6. **Recovery covers the system, not just the file.** Off-host DB backup, restore that starts the
   autopilot stopped and reconciles GitHub refs/PRs and worktrees before it may resume (finding 8).
7. **Scope cut.** AI Doctor, the provider manifest, Apps, mobile, graph and radar are outside launch
   acceptance (finding 13). The manifest is deferred entirely.
8. **Auto-merge stays off and off the roadmap.** `AGENTS.md` merge authority is unchanged.

### The eight questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | What existing code already solves these requirements? | Scheduling, recovery, resource slots, quota handling, runtime deadlines, checkpoint commits, model evidence and shadow selection, context continuation, composition, approvals, verification, compare, the web shell and Cockpit integration. Inventory in §B. |
| 2 | What is genuinely missing? | For the loop: stop conditions and admission accounting, host admission, item reservation and attempts, verification-to-SHA binding with explicit acceptance commands, durable publication, an in-plane dispatcher, system-level restore. Later: a native CLI, an OS-vs-solo scorecard on real providers, grounded AA ids, effort-aware cohorts. Remote auth stage 2, subtasks (vNext 10–13) and K10 are missing but not needed for the loop. |
| 3 | What is the smallest autonomous workflow we can prove on OCI? | With the autopilot started and inside the night window: reserve `os/<item>` on GitHub → create the plane task and attempt in one transaction with a `resource` wait on `oci-heavy: 1` → K1 dispatch → composed Harness run → checkpoint commit → the item's own acceptance commands, bound to that SHA → durable publication of one draft PR → next item, until the count, the window, a failure limit or the stop switch ends it. Proven by experiments G1–G14. |
| 4 | Which features improve measured outcomes versus adding complexity? | Improve: the loop, its stops and its recovery (work happens unattended and safely), the scorecard (tells us whether routing helps), grounded AA priors. Complexity until proven: multi-agent chains, Jev on new hot-path sites, Doctor escalation, a provider manifest, 3D graph, auto-merge. |
| 5 | What depends on subscriptions, separate APIs or future integrations? | §D.2 binds each lane to one auth mode. OCI loop: Claude subscription login (D-1), Codex per D-2. Eval in GitHub Actions: API keys. AA and Jev: their own keys. Plane → cloud workers: no integration exists. |
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
| Project verification bound to a commit SHA | **MISSING** | `project-verification.ts` records no SHA; discovery can be **skipped** with a warning (malformed or missing `packageManager`, ambiguous lockfiles, malformed `package.json`, l. 38–57) | — |
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

Remaining K4b gaps, all handled by P0-3 rather than by new slot machinery:

1. Only tasks carrying a requirement compete; K5 occurrences carry none. The autopilot creates its
   own tasks with the requirement and does not use K5.
2. The pool counts plane runs, not the machine.
3. `releaseIfIdle` releases a terminal task's claim even while a provider process is still exiting
   (`scheduler.ts:387`; K4b record §3 "Known ceiling").
4. `resourceReady` admits every operator wake unconditionally (`scheduler.ts:132`), so a host check
   placed there would be bypassable. P0-3 puts host admission in the wake transaction itself, for
   every actor.
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
| Live session input, Claude and Codex | PARTIAL | PROJECT_MEMORY 2026-09-22/23: shared contract shipped; Codex app-server transport with correlated receipts on a spike; SDK attach BLOCKED on 0.154.0 |
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


---

## C. Target architecture

### C.1 Components and who owns what

```
 itay ──► Shell (web) / aos (CLI, P1) ──► Plane API (loopback, bearer)
                                            │
          ┌─────────────────────────────────┼──────────────────────────────────┐
          │ Kernel (apps/api)                                                   │
          │  autopilot (new) ─ selectNext ─► tasks + attempts (one txn)         │
          │  scheduler K1–K5, K4b pools, host gate (new, in the wake txn)       │
          │  composer + router + K13 shadow ─► Harness ─► adapters ─► worktree  │
          │  checkpoint commit ─► acceptance commands bound to SHA (new)        │
          │  publications (new) ──────────────► publisher (separate Unix user) ─┼──► GitHub (draft PR)
          │  SQLite: tasks, waits, dispatches, claims, runs, attempts, pubs     │       ▲
          └─────────────────────────────────────────────────────────────────────┘       │ ref os/<item>
                  │ contracts v1              │ evidence                                │ reserved by
             Cockpit (app)              AA (K8), Jev (offline)          manual cloud lanes ─┘
```

| Concern | Single authority | Not an authority |
|---|---|---|
| Desired work: items, dependencies, acceptance, scope | `docs/progress/backlog.yaml` at `origin/main` (changed by merged PRs only) | — |
| **Reservation of an item** across all lanes | the GitHub ref `os/<item-id>` (atomic create; every lane can reach it) | backlog text, chat history |
| Execution attempts, live task state, leases, claims, retries | plane SQLite (`autopilot_attempts`, tasks, waits, dispatches, claims) | backlog, GitHub |
| Publication intent and its reconciled outcome | plane `publications`, reconciled against GitHub | PR text |
| Code, PRs, review, CI | GitHub | — |
| Cross-provider recovery evidence | plane checkpoints + checkpoint commits | handoff Markdown |
| Progress and the daily report | **derived** from the above | nobody writes a percentage by hand |
| Machine assistant config, skills, memory sources | Cockpit | plane |

### C.2 The autopilot (new module, the only new kernel code for the loop)

**State (one migration):**

- `autopilot_state` — one row: `running | stopped`, `stopped_reason`, `changed_at`, `changed_by`.
  Default **stopped**; config cannot start it, only `POST /api/autopilot/start` (`commands.write`).
  `POST /api/autopilot/stop` with `mode: drain` (no new admissions; active task finishes) or
  `mode: now` (also cancels the active autopilot task through the existing cancel path).
- `autopilot_windows` — `window_id` (local date of its start), `opens_at`, `closes_at`,
  `admitted` count. Config: `autopilot.window { start: "23:00", end: "07:00", timeZone:
  "Asia/Jerusalem" }`, `autopilot.maxItemsPerWindow` (default 3), `autopilot.maxAttemptsPerItem`
  (default 2), `autopilot.maxRuntimeMs` per task (passed as the task's runtime cap).
- `autopilot_attempts` — `item_id` (stable), `item_revision` (content digest of the item at
  admission), `attempt_no`, `task_id` (unique), `window_id`, `admitted_at`, `outcome`
  (`running | verified | publish_failed | failed | blocked | cancelled`), `failure_class`
  (`retryable | terminal`).

**`selectNext()`** — one function, idempotent, run in a single SQLite transaction after the
network reads it needs (fetch backlog at `origin/main`, list `os/*` refs):

1. Refuse unless `running`, now ∈ an open window, `admitted < maxItemsPerWindow`, and no autopilot
   task is non-terminal (the loop is serial by design on 1 CPU).
2. Candidate = first item in backlog order with dependencies satisfied (each dependency's PR
   merged), an explicit `acceptance` list, `lane: oci-loop`, no `os/<id>` ref on GitHub unless it
   was created by this plane for an attempt of this item, and `attempt count < maxAttemptsPerItem`
   with the last failure `retryable`.
3. Reserve: create ref `os/<id>` at the base SHA through the GitHub API (outside the transaction,
   before it). `422 already exists` → the item is someone else's; record and skip.
4. In the transaction: insert the attempt, create the task (`clientRequestId`-free: the task and its
   attempt row are written together, so there is no HTTP retry to deduplicate), attach
   `wait: { kind: "resource", resource: "oci-heavy" }`, increment `admitted`.

**Triggers** (all call `selectNext()`; none carries state of its own): the autopilot task's
settlement hook, publication completion, boot (after reconciliation, §C.5), and the existing
scheduler sweep tick. Missed triggers need no catch-up: the next call reads durable state. Two
concurrent calls cannot both admit, because the count and the "no active autopilot task" check are
in the same transaction in a single-process SQLite plane.

**Window and stop gates, non-bypassable.** In the wake transaction (the one that already does the
generation CAS and the claim), an autopilot task (one with an `autopilot_attempts` row) is re-parked
with a `time` wait to the next window opening when the window is closed or the autopilot is
stopped — for every actor, operator included. A quota wake that comes due after 07:00 therefore
waits for tomorrow's window rather than running into the day. The operator's way to run it in the
day is to stop treating it as autopilot work (`POST /api/autopilot/attempts/:task/release`, which
ends the attempt as `cancelled` and leaves an ordinary task).

**Host gate** (P0-3), also in the wake transaction and for every actor, for any task that carries a
pool requirement whose pool declares admission under `scheduler.admission.<pool>` (the numeric
`scheduler.resources` format is unchanged): 1-minute load below `maxLoad1`, free memory above
`minFreeMemMb`, free disk above `minFreeDiskMb`, and **no live process left in the plane's own
cgroup** other than the plane itself. The plane runs as a systemd unit, so every provider process
and its descendants live in the unit's cgroup; counting `cgroup.procs` sees descendants, is immune
to PID reuse, and catches a provider still exiting after its task went terminal. Unreadable
cgroup or `/proc` data → **not admitted**, reported as `blockedBy: host` with the reason.

**Lifecycle of one attempt:**

| Step | Mechanism | Failure behaviour |
|---|---|---|
| Reserve | GitHub create-ref | exists → skip item; network/5xx → no attempt written, retried on the next trigger |
| Admit | `selectNext` transaction | crash before commit → nothing admitted; the ref exists with no attempt → boot reconciliation adopts or deletes it (§C.5) |
| Wait for slot | K4b + host gate | parked; reported |
| Execute | K1 dispatch → composer → Harness; hard runtime deadline | quota → K2 re-park (and window gate); provider error → existing failover or `WAITING_INPUT`; crash → K1 boot reconciliation |
| Commit | `commitCheckpoint` at settlement → SHA | dirty-tree race already handled in `commitCheckpoint` |
| Verify | the item's `acceptance` commands, run by the plane in the worktree, result persisted with the SHA (P0-4) | empty or skipped plan → attempt `blocked` (never "passed"); FAIL → `failed` (`terminal`) |
| Publish | `publications` (C.2.1) | retried without re-running the provider |
| Next | settlement and publication hooks call `selectNext()` | — |

#### C.2.1 Publication

`publications` row written **before** any external effect: `publication_id`, `task_id`,
`attempt`, `repo`, `ref` (`os/<item>`), `base_sha`, `verified_sha`, `state`
(`intended → pushed → pr_open → done`, or `conflict | closed | failed`), `pr_number`, `attempts`,
`last_error_class`. Only the publisher may advance it, through two plane routes under a new
`publications.write` capability; the row carries a `lease_owner` + `lease_until` so a second
publisher instance cannot act on the same row (fencing by compare-and-set on `state` + lease).

Reconcile-then-act, every time:

1. Local: the worktree `HEAD` equals `verified_sha` and the tree is clean; otherwise `conflict`.
2. Remote ref: if it points at `verified_sha` → already pushed. If at `base_sha` (just reserved) →
   push with `--force-with-lease=os/<item>:<base_sha>`. Anything else → `conflict`, stop; the
   branch moved unexpectedly.
3. PR: list PRs with `head = os/<item>`, state all. Open with head SHA = `verified_sha` → adopt
   (this is the "PR created, response lost" case). Closed or merged → `closed`, stop, never reopen.
   Open with another head SHA → `conflict`. None → create a **draft** PR whose body carries
   `publication_id`; a lost response is found on the next pass by step 3.
4. GitHub 401/403 → `failed` + autopilot `stopped` with reason `github-auth`. 429/5xx/network →
   retry with backoff, bounded by `attempts`.

The task state machine is unchanged: the task is `COMPLETED` on settlement as today
(`orchestrator.ts:1308`); publication is a separate durable record keyed by the task, so a crash
anywhere in it never re-runs the provider.

**Credential isolation.** Providers run with `processIsolation: "none"`, so any file the plane's
Unix user can read, a provider tool can read. The publisher therefore runs as a **separate Unix
user** in its own systemd unit, holding a fine-grained GitHub token (`contents:write`,
`pull_requests:write`, the two repos only) in a file only that user can read. It talks to the plane
over the loopback API with its own bearer credential limited to `publications.*`, and fetches the
worktree's commits by `git fetch` from a read-only path the plane exposes, never by sharing the
token. Tests assert the plane user cannot open the token file and that no provider environment
contains it (D-3).

**K3 egress (finding 9).** The probe's `usageEndpoint` override becomes test-only: production
accepts only the Anthropic host, `redirect: "error"`; tests inject a transport instead (P0-8).

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
| OCI autopilot → Claude Code / Codex adapters | yes | `selectNext` creating `os/<id>` | D-1, D-2 |
| Claude Code cloud (project threads) | **no** | the prompt's **first** command creates `os/<id>` (`git push origin <base>:refs/heads/os/<id>`); failure → stop | Anthropic's own product, the user's own login |
| Codex cloud | **no** (no integration demonstrated) | same first-command rule | ChatGPT sign-in + MFA (Codex cloud requires it) |
| itay | via SSH tunnel | same | — |

The only cross-lane race left is work started before the ref, which the first-command rule closes.
A plane-side remote worker contract (registration, short-lived scoped credentials, leases with
fencing, artifact transfer) stays unscheduled until a real need exceeds the OCI box.

### C.5 OCI topology, backup and restore

- Units: `agent-plane-operator.service` (plane), `cockpit-dashboard.service` (#51),
  `aos-publisher.service` (new, separate user). All loopback. Access over SSH or Tailscale only;
  the API stays private until remote-auth stage 2.
- **Backup:** nightly online backup (sqlite3 backup API + `integrity_check`) before the window
  opens, kept 7 days on the box and copied **off-host** encrypted (destination is D-11). Stated
  recovery point: up to 24 h of plane DB; GitHub is the record for reservations and publications,
  so they are recoverable from it.
- **Restore = reconcile before resume.** A restored DB (detected by a `restored_at` marker the
  restore script writes) boots with the autopilot **stopped** and runs one reconciliation:
  every `os/*` ref and PR on GitHub is matched to attempts/publications — unknown ones are imported
  as external reservations (never re-run); every worktree on disk without a DB task is quarantined
  (moved aside, not deleted); every live process in the cgroup is reported. Only itay restarts the
  autopilot after reading that report.
- **Liveness and outages:** the autopilot writes `last_tick`; the daily report flags a stale tick
  inside the window. GitHub auth failure stops the autopilot (C.2.1). Disk below
  `minFreeDiskMb` fails the host gate closed. A token revocation needs a new token file and
  `POST /api/autopilot/start`.

### C.6 AI Doctor — deferred out of launch

Design kept for later (finding 13): deterministic daily job, fingerprinted findings ledger, hard
budget, at most three findings, read-only, presented in Cockpit. `jobs.ts` is an in-process timer
without durable occurrence catch-up (`jobs.ts:25`), which is acceptable for an advisory scan whose
next run reads "changes since the last cursor". Starts only after G1–G14 pass and only with a
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
| OCI autopilot (unattended, personal) | subscription login (D-1) | per D-2: API key (recommended) or ChatGPT sign-in |
| OCI scorecard runs (§D.5) | same as the autopilot lane | same as the autopilot lane |
| GitHub Actions `eval.yml` | API key secret (metered) | API key secret (metered) |
| Claude Code cloud / Codex cloud | the provider's own product with itay's own login | the provider's own product with itay's own login |
| Any multi-user future | each user's own credentials or the product's API key; never itay's login | same |


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
unattended run is: the Harness hard runtime deadline per task, the autopilot's per-window item
count and per-item attempt limit, K2's `maxAutoWakes` per task, the window's closing time, and the
provider's own plan limits. Token use is measured per attempt and **overshoot against the advisory
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


---

## F. Prioritised roadmap

Complexity: S ≈ half a day, M ≈ 1–2 days, L ≈ 3+ days of one session. Every slice: own worktree,
named files, gate `pnpm typecheck && pnpm lint && pnpm test` (plane) or `npm test && npm run build`
(Cockpit), a drive where it executes, one verdict, PR to main, never merged by an agent.

### P0 — a bounded, recoverable autonomous loop

| Slice | What | Files | Model / effort | Acceptance (tests unless marked drive) | Size |
|---|---|---|---|---|---|
| P0-0 | This plan; Codex re-review of revision 3 | docs | itay runs the brief | findings recorded in §I.2 | S |
| P0-1 | OCI config only: `scheduler.resources: { oci-heavy: 1 }`; confirm `execution.harnessModes.single`, composer settings; plane runs as its systemd unit | live config | OCI, Codex / low | `GET /api/scheduler/status` lists the pool; config backed up | S |
| P0-2 | **Autopilot core:** migration 042 (`autopilot_state`, `autopilot_windows`, `autopilot_attempts`), stop/start/release routes, window + stop gate in the wake transaction for every actor, per-window count, per-item attempt limit, per-task runtime cap | new `modules/autopilot.ts`, `scheduler.ts` (one gate call in the wake transaction), `server.ts` (3 routes), `config.ts`, migration lists in `db.test.ts`/`task-classifier.test.ts` | Opus 5.5 / high | default stopped; 4th admission in a window refused; restart mid-window keeps the count; quota wake due 07:05 re-parks to 23:00; operator run-now on a closed window re-parks; `stop drain` admits nothing and lets the active task finish; `stop now` cancels it; stop survives restart | L |
| P0-3 | **Host gate:** `scheduler.admission.<pool>` (`maxLoad1`, `minFreeMemMb`, `minFreeDiskMb`, `cgroupIdle`), evaluated in the wake transaction for every actor; numeric `scheduler.resources` unchanged | new `modules/host-admission.ts`, `scheduler.ts` (call site), `config.ts` | Opus 5.5 / high | terminal task with a child still alive → next task not admitted until it exits; grandchild counted; unreadable cgroup → not admitted with reason; operator run-now while a predecessor lives → refused; existing `resource-slots.test.ts` unchanged and green | M |
| P0-4 | **Acceptance bound to a SHA:** run the item's explicit `acceptance` commands in the worktree after the settlement checkpoint; persist `{ sha, command, exit, duration }`; empty or skipped plan → `blocked`, never passed | `project-verification.ts` (or a sibling `acceptance-run.ts`), result table in migration 042 | Opus 5.5 / high | malformed `packageManager` → `blocked`; FAIL → no publication row; result SHA = checkpoint SHA | M |
| P0-5 | **Publications:** migration 043, plane routes under `publications.read/write`, lease + CAS, the reconcile-then-act publisher as a separate Unix user and unit; token file readable only by that user | new `modules/publications.ts`, `apps/publisher/**` (small Node bin), `setup/aos-publisher.service` | Opus 5.5 / high | fake-GitHub tests at every boundary: crash after push, after PR create with response lost, 401/403/429/5xx, concurrent publishers (one wins the lease), closed and merged PRs (stop, never reopen), branch moved (conflict), head changed (conflict), retry never re-runs the provider; the plane user cannot read the token file | L |
| P0-6 | **`selectNext()` + reservation:** backlog fetch and validation, `os/<id>` create-ref, attempt + task in one transaction, triggers (settlement, publication done, boot, sweep) | `modules/autopilot.ts`, `docs/progress/backlog.schema.json`, `scripts/backlog-check.mjs` | Opus 5.5 / high | ref exists → skip; crash between create-ref and the transaction → boot adopts or deletes the ref; 3 items from an **empty** task queue in one window, the 4th refused; concurrent triggers admit once; missed trigger caught by the sweep | M |
| P0-7 | **Restore reconcile + off-host backup:** `restored_at` marker, boot in stopped state, GitHub/worktree/cgroup reconciliation report, nightly encrypted off-host copy (D-11) | `modules/autopilot.ts` (reconcile), `scripts/backup.sh`, docs | Sonnet 5.5 / high | stale restore after push/PR creation → refs imported, nothing re-run; lost worktree → attempt `blocked`; restore report lists every mismatch | M |
| P0-8 | K3 probe egress: production endpoint fixed to the Anthropic host, `redirect: "error"`, transport injection for tests | `quota-probe.ts`, its test | Sonnet 5.5 / high | a configured foreign endpoint is refused at load; a redirect is not followed | S |
| P0-9 | `docs/progress/backlog.yaml` audited from both repos (incl. vNext 1–9 status), every `oci-loop` item with acceptance | `docs/progress/**` | Sonnet 5.5 / high | `backlog-check` passes | M |
| P0-10 | Live proof G1–G14 on OCI | none (drives + evidence) | OCI, Claude Code / Sonnet 5.5 medium, one experiment per session | §G | M |

Order and parallel safety: P0-2 and P0-3 both touch the wake transaction in `scheduler.ts`, so P0-3
follows P0-2. P0-4, P0-8 and P0-9 are disjoint from P0-2 and run beside it. P0-5 and P0-6 follow
P0-2 and P0-4. P0-7 follows P0-5 and P0-6. P0-1 runs on OCI any time.

### P1 — visibility and intelligence

| Slice | What | Model / effort | Gate |
|---|---|---|---|
| P1-1 | AA map grounding (O12 phase 2 ids → `AA_MODEL_MAP`; OpenAI rows) | OCI read (Codex / low), then cloud Opus 5.5 / high | `mapped > 0` on the next live refresh |
| P1-2 | Daily report as a projection (backlog + GitHub REST + plane autopilot/publication reads), incl. overshoot, stale tick, stop reason | Sonnet 5.5 / high | numbers reproduce from sources |
| P1-3 | `aos` CLI-1 read-only (`ps`, `logs`, `attach`, `quota`, `models`, `autopilot status`) | Opus 5.5 / high | drive against `pnpm dev` |
| P1-4 | `aos` CLI-2/3: create with preview (with a `clientRequestId` for the CLI's own retries), stream, approvals, `autopilot stop/start` | Opus 5.5 / high | idempotent create |
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

## G. Live proof plan (OCI, after P0-1…P0-9 merge)

One experiment per session, load < 1.5 before each, backup first. Fake assistant first
(`FAKE-*-not-real` for any secret), then real where marked. A fake GitHub is used for G9–G11;
G12 uses the real repo with a draft PR.

| # | Experiment | Pass |
|---|---|---|
| G1 | 3 autopilot items from an **empty** task queue in one window; a 4th item eligible | 3 admitted, serial, 4th refused with reason "window count" |
| G2 | Resource-bearing task against `/start`, compare and race (legacy and composed), replay, `/restart`, handoff, failover, K11 continuation | no provider start without a claim; refusals recorded |
| G3 | `kill -9` the plane mid-run, restart | one owner; no second provider start; count unchanged |
| G4 | Terminal-before-exit: provider child kept alive after settlement | next task not admitted until the cgroup is idle |
| G5 | Unreadable cgroup (permissions removed) | nothing admitted; reason shown |
| G6 | Quota re-park whose retry is due after 07:00 (fake limit event) | re-parked to 23:00 |
| G7 | `stop drain` with one active and two queued; then `stop now`; restart in between | drain: active finishes, none admitted; now: active cancelled; state survives restart |
| G8 | Approval pause; then approval denial; then expiry | slot held while paused; deny/expiry end the attempt `blocked` |
| G9 | Acceptance: empty plan, skipped discovery, FAIL, PASS | blocked, blocked, failed (no publication), PASS → publication row with the checkpoint SHA |
| G10 | Publication boundaries on fake GitHub: crash after push; PR created + response lost; 401; 429; 5xx; concurrent publishers | exactly one PR; 401 stops the autopilot; one lease winner |
| G11 | Closed PR; merged PR; branch moved; head changed | stop / stop / conflict / conflict; nothing reopened or force-pushed |
| G12 | Real: one item end to end on the real repo, draft PR | one draft PR, verdict in body, token unreadable by the plane user |
| G13 | Stale restore after a push and a PR; a deleted worktree; disk below the floor | autopilot boots stopped; refs imported; worktree attempt blocked; host gate closed on disk |
| G14 | Real night: 3 items queued at 22:50 | morning report: 3 outcomes, overshoot, any K2 re-park and wake, stop reason none |

Overall verdict PASS only when all fourteen pass.

---

## H. Decision log (needs itay)

| # | Decision | Recommended default | Consequence |
|---|---|---|---|
| D-1 | Claude unattended on OCI with the subscription login | **yes**, personal and individual volume (2026-10-07 update: Agent SDK and `claude -p` draw from plan limits) | no metered spend; plan limits are a hard stop |
| D-2 | Codex unattended on OCI: ChatGPT sign-in or API key | **API key** (the docs' recommendation for programmatic workflows), with a provider-side spend limit; ChatGPT sign-in stays for interactive use | metered spend, capped |
| D-3 | Separate-user publisher with a fine-grained token (`contents:write`, `pull_requests:write`, two repos) opening **draft** PRs | yes | PRs appear without you; merging stays yours |
| D-4 | Night window | 23:00–07:00 Asia/Jerusalem | nothing autopilot runs in the day |
| D-5 | Items per window, attempts per item, runtime cap per task | 3, 2, 90 min | the loop stops at the first limit hit |
| D-6 | Cloud note (#133) four questions | as the note recommends | Vercel waits for stage 2 |
| D-7 | Jev shadow experiment spend | ≤ $1 on OpenRouter, shadow only | measures Jev on classification |
| D-8 | Phase 8 close basis | close on "gate holds and is shown live" after P1-7 | does not wait a week |
| D-9 | AI Doctor | deferred until G passes | no work now |
| D-10 | Auto-merge | **off; not on the roadmap**; a future option would need its own approval, independently verified checks, head-SHA binding, branch protection, a kill switch, and a rule treating agent-instruction Markdown as code | `AGENTS.md` merge authority unchanged |
| D-11 | Off-host backup destination | OCI Object Storage bucket in the same tenancy, client-side encrypted, 7-day retention | a small storage cost; restore needs the key |
| D-12 | Who may restart the autopilot after a stop or restore | itay only (`POST /api/autopilot/start` over SSH or the shell) | no agent restarts it |

---

## I. What changed

### I.1 Revision 3 versus revision 2

**Corrected:** "token caps enforced" → advisory on Claude/Codex; "every start goes through
`startTask`" → composed compare/race bypasses `assertLaunchClaim`; "cohorts keyed by effort" →
not implemented; "K3 uses only the provider's endpoint" → configurable today; "API key only" for
products → the precise Anthropic rule; §D.5 is no longer called equal-budget.

**Replaced:** `clientRequestId` intake (P0-2 of revision 2) → tasks and attempts created in one
plane transaction by an in-plane dispatcher (the CLI keeps an idempotency key in P1-4); host
admission inside `resourceReady` → a gate in the wake transaction for every actor, keyed separately
from numeric pool capacity, using the unit's cgroup; "publish by lookup" → a durable publication
lifecycle with lease, exact reconciliation and a separate-user publisher; a one-shot dispatcher →
`selectNext()` on durable triggers; backlog revision in the key → stable id + revision + attempt;
G1–G8 → G1–G14.

**Added:** stop switch, window and counts (P0-2); acceptance bound to SHA (P0-4); restore
reconciliation and off-host backup (P0-7); probe egress fix (P0-8); lane → auth binding (§D.2);
D-11, D-12.

**Cut from launch:** AI Doctor, provider manifest (deferred entirely), Apps launcher, mobile,
graph, radar.

### I.2 Codex review of revision 2 (`662e020`, FAIL) — ledger

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

## Verdict

**SKIP** — plan document only; no runtime surface. Codex review of revision 2: **FAIL, addressed
above**. Codex re-review of revision 3: **PENDING**.
