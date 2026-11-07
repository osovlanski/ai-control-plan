# Agentic OS — operating plan: from manual lanes to a proven autonomous loop

Status: **PROPOSED**, revision 2, 2026-11-07. Plan only. Nothing here is implemented, enabled or
deployed by this PR. Where this file and the diff disagree, the diff wins.

Revision 2 answers itay's review (ChatGPT acting as principal reviewer) of revision 1. It was
re-checked against `main` `6a5ef9e` (ai-control-plan) and `6e2e052` (cockpit). Every claim below
names its evidence; **test** means a repo test, **fake drive** means a recorded run against a fake
provider, **live** means a recorded run on the OCI operator plane with a real provider. Anything
without one of those is marked UNVERIFIED.

An independent Codex review has **not** run (no Codex tool is available in the session that wrote
this). The brief to run it is `docs/agentic-os-auto-copilot-codex-review-brief.md`. Review status:
**PENDING**.

---

## A. Executive recommendation

**Build no new kernel. Prove one autonomous loop on OCI with the kernel that exists, and add only
the four pieces that are actually missing.**

The repository already contains most of what the vision asks for: durable dispatch with
generations (K1), quota re-park with evidence (K2), quota probes (K3), dependency waits (K4),
**resource slots (K4b)**, recurring schedules with IANA timezones (K5), resolved model identity
(K7), AA evidence (K8), context observation (K9) and clean-session continuation (K11), the
composer and per-run provisioning (M1–M3), shadow model selection with activation gates (K13),
routing profiles, approvals, project verification, parallel compare, and a conversational web
shell with an orbital view, an inspector and a terminal-style view. Revision 1 under-used that and
proposed duplicates. The biggest corrections:

1. **No duplicate scheduler slot (revision 1's N1 is withdrawn).** K4b already serialises work
   through named pools. The real gaps are narrower: a task only competes for a pool if it
   *carries* a requirement, the pool counts plane runs but not other load on the box, and a slot is
   released at the plane's terminal boundary, not when the provider process exits (§B.1).
2. **`backlog.yaml` does not control execution.** It holds desired work only. Live state stays in
   the plane's SQLite (tasks, waits, dispatches, claims); code and review evidence stay in GitHub;
   the progress report is a projection of both (§C.3).
3. **The missing pieces for an unattended loop are concrete:** idempotent task intake, a host
   admission check, PR publication after verification, and a small dispatcher from backlog to plane
   tasks (§F, P0).
4. **Cloud chat sessions are manual lanes.** The plane cannot dispatch Claude project threads or
   Codex cloud tasks; no supported integration from the plane exists (§C.4).
5. **Auto-merge is out of the roadmap.** The owner-merge rule stands unchanged; Markdown carries
   agent instructions, so even a docs-only allowlist is not low-risk (§H, D-10).
6. **"OS ≥ best single assistant" becomes a measured hypothesis** on a 24-task corpus with separate
   quality, time and cost results (§D.5).

### The eight questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | What existing code already solves these requirements? | Scheduling, recovery, resource slots, quota handling, model evidence and shadow selection, context continuation, composition, approvals, verification, compare, the web shell and Cockpit integration. Inventory in §B with evidence. |
| 2 | What is genuinely missing? | Idempotent intake, host admission, PR publication, backlog→task dispatch, a native CLI, an OS-vs-solo corpus and scorecard on real providers, grounded AA ids, AI Doctor, a provider manifest. Remote auth stage 2, subtasks/fan-out (vNext 10–13) and K10 compaction are missing too, but are not needed for the first loop. |
| 3 | What is the smallest autonomous workflow we can prove on OCI? | One backlog item → one plane task created idempotently with a `resource` wait on pool `oci-heavy: 1` → K1 dispatch → composed Harness run in a worktree → project verification → draft PR published once → state persisted → next item. Proven by experiments G1–G8. |
| 4 | Which features improve measured outcomes versus adding complexity? | Improve: the loop itself (work happens unattended), idempotency and admission (no duplicate or overloaded runs), the scorecard (tells us whether routing helps), grounded AA priors. Complexity until proven: multi-agent planner/reviewer chains, Jev on new hot-path sites, 3D graph, auto-merge, a plugin runtime. |
| 5 | What depends on subscriptions, separate APIs or future integrations? | Claude and Codex execution on OCI: subscription logins (with D-1/D-2). Eval in GitHub Actions: API keys (metered). AA: its API key. Jev: an OpenRouter or TypeSafe key (metered). Plane → cloud workers: no integration exists. Matrix in §D.2. |
| 6 | How do we evaluate model selection, effort and multi-agent coordination? | Shadow first (K13 already logs every decision with its would-be pick), cohorts keyed by exact (assistant, resolved model, effort, task kind), activation only through K13's six gates; multi-agent only as a compare arm of the scorecard until it beats single-agent at equal budget. §D.4–D.5. |
| 7 | How does AI Doctor stay useful, cheap and non-repetitive? | Deterministic incremental checks first (zero tokens), a fingerprinted findings ledger that suppresses unchanged findings, a hard per-run budget, at most three recommendations, read-only. §C.6. |
| 8 | How does a first-time user get a task done without learning the architecture? | Type the goal into the shell or `aos`; the default goal is Balanced; the OS shows a one-line plan ("Claude · coding · in your repo · verify with tests"), asks only for approvals it needs, and ends with a PR link and a verdict. Everything else is behind the inspector. §E.4. |

---

## B. Verified implementation inventory

Status vocabulary: **SHIPPED** (merged, with evidence named), **PARTIAL**, **DESIGN-ONLY**,
**BLOCKED**, **UNVERIFIED** (merged code, but the named property has not been observed).

### B.1 Scheduling and recovery

| Item | Status | Evidence | Test vs live |
|---|---|---|---|
| K1 durable dispatch, generations, boot reconciliation | SHIPPED | `apps/api/src/modules/scheduler.ts`, migration 014, `docs/agentic-os-k1-implementation.md` | tests + `pnpm demo:a` (fake clock); no recorded live crash test on OCI |
| K2 quota re-park with blocker evidence | SHIPPED | `docs/agentic-os-plan.md` header; `quota.ts` | tests; no recorded live quota exhaustion |
| K3 quota probe (Claude OAuth usage endpoint; others `unsupported`) | SHIPPED, opt-in, default off | PROJECT_MEMORY "K3"; `quota-probe.ts`, migration 016 | tests; live use UNVERIFIED |
| K4 dependency waits | SHIPPED | `WaitInput` kind `dependency` in `packages/core/src/scheduler.ts:51` | tests |
| **K4b resource slots** | **SHIPPED** | `docs/agentic-os-k4b-resource-slots.md`, migration `023_resource_slots.sql`, `scheduler.ts` (`resourceGate`, `assertLaunchClaim`, `releaseIfIdle`), `apps/api/test/resource-slots.test.ts` (59 cases) | tests; **never configured or exercised on OCI** (UNVERIFIED live) |
| K5 recurring schedules, IANA timezones, `overlap: skip/queue` | SHIPPED | `schedules.ts`, `docs/agentic-os-k5-overlap-queue.md` | tests |

**K4b, checked against the review's question.** The claim is granted only inside the wake
transaction, together with the dispatch reservation, and `assertLaunchClaim` is a closed gate in
the launch funnel (`orchestrator.startTask()` is the single funnel for legacy, Harness, replay and
compare starts, per the K4b record §1). So a heavy-run limit **can and should use the existing
pools** — `scheduler.resources: { oci-heavy: 1 }` in workspace config. Three gaps remain, and none
needs new slot machinery:

1. **Opt-in per task.** Only a task that carries a pool requirement competes. A task created
   without one, or a compare started directly, runs outside the pool. `POST /api/tasks` already
   accepts `wait` and attaches it in the same transaction as the task (`server.ts` `/api/tasks`,
   `scheduler.attach`), so the dispatcher must always create tasks with
   `wait: { kind: "resource", resource: "oci-heavy" }`. Whether a direct `/start` or
   `/parallel` call bypasses the pool is UNVERIFIED and is part of G1.
2. **Counts plane runs, not the machine.** A human `pnpm test` or another agent's build on the
   1-CPU box is invisible to the pool. Needs a host admission check (P0-3).
3. **Release at the plane's terminal boundary.** The K4b record §3 "Known ceiling": a provider still
   winding down after the task is terminal no longer holds the slot. On 1 CPU the next job can
   start while the last one is still exiting. Covered by P0-3's admission check (load and live
   provider processes), not by changing the claim protocol.

### B.2 Model intelligence

| Item | Status | Evidence | Test vs live |
|---|---|---|---|
| K7 requested vs resolved identity, price evidence | SHIPPED | K12/K14 closure record; `model-catalog.ts` | live: opus → `claude-opus-5` ×4 (A0, CLI 2.1.238, 2026-11-06) |
| K8 AA evidence pipeline | SHIPPED, **0 of 726 rows mapped** | `artificial-analysis.ts` `AA_MODEL_MAP` (only 4.x slug guesses), PROJECT_MEMORY "K8 AA map grounding diagnostic" | live refresh 2026-11-07 mapped 0; grounding list ready to read (O12 phase 2) |
| K13 shadow selection, `w(n)=n/(n+k)`, six activation gates | SHIPPED, shadow only | `model-selection.ts`, `model-intelligence.test.ts`; A1 #156, A2 #155, A4 #157, P2 #162 | live: decisions carry no recommendation (no priors, sonnet n=0) |
| Hard filters before scoring (auth, capability, policy, quota, security) | SHIPPED | `model-selection.ts:80–184` takes the router's own per-assistant filter verdict | tests |
| Routing profiles | SHIPPED | `RoutingProfile` = `auto`, `preserve-quota`, `fastest`, `best-quality`, `lowest-tokens` (`server.ts` `/api/tasks`) | tests |
| AA rows for OpenAI/Codex models | MISSING | `AA_MODEL_MAP` has Anthropic entries only | — |
| Effort as an identity dimension | PARTIAL | AA scores effort variants as separate rows (K8 grounding note); "no effort reported anywhere" in A0 | live A0 |

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
| Remote access | DESIGN-ONLY | API refuses non-loopback bind; `docs/adr/remote-auth-design.md` stage 2 not built |

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

### C.1 Components and who owns what

```
 itay ──► Shell (web) / aos (CLI) ──► Plane API (loopback, bearer)          GitHub
                                        │                                     ▲
                    ┌───────────────────┼───────────────────────┐            │ draft PR
                    │ Kernel (apps/api)                          │            │
                    │  intake ─► scheduler (K1–K5, K4b pools)    │            │
                    │        ─► composer (M2) + router + K13     │            │
                    │        ─► Harness SessionRunner ─► adapters│──► worktree ─► verify ─► publish
                    │  SQLite: tasks, waits, dispatches, claims, │
                    │  runs, checkpoints, telemetry, shadow logs │
                    └──────────┬────────────────┬────────────────┘
                               │ contracts v1   │ evidence
                         Cockpit (app)     AA (K8), Jev (offline)
```

| Concern | Single authority | Not an authority |
|---|---|---|
| Desired work, dependencies, scope estimates | `docs/progress/backlog.yaml` (git, changed by merged PRs only) | — |
| Live task state, leases (dispatch generations), resource claims, retries, ownership | plane SQLite | backlog, GitHub, chat history |
| Code, branches, PRs, review findings, CI | GitHub | backlog status text |
| Cross-provider recovery evidence | plane checkpoints (immutable ids) + the branch's commits | handoff Markdown |
| Progress % and daily report | **derived** from the three above | nobody writes a percentage by hand |
| Machine assistant config, skills, memory sources | Cockpit | plane |

### C.2 The autonomous loop (one item at a time on OCI)

1. **Select.** The dispatcher (P0-6) reads `backlog.yaml` at `origin/main`, takes the first item
   whose dependencies are satisfied (each dependency's PR merged on GitHub) and that has no plane
   task and no open PR yet.
2. **Reserve.** `POST /api/tasks` with `clientRequestId = <item id>@<backlog revision>` (P0-2) and
   `wait: { kind: "resource", resource: "oci-heavy" }`. A retry after a timeout returns the same
   task, never a second one. Admission (P0-3) is a readiness clause of that pool, so a busy box
   keeps the task parked.
3. **Compose.** Existing composer + router + K13 shadow, under the task's routing profile.
4. **Execute.** Harness single mode in the task's own worktree (existing).
5. **Observe, checkpoint, approve.** Existing events, K9 observation, K11 continuation, approval
   pauses (the slot is held during an approval pause, K4b §3).
6. **Verify.** Existing project verification. A FAIL or BLOCKED ends here with no PR.
7. **Publish.** P0-5: push `os/<item id>` and open a **draft** PR, idempotent on (task id, head
   SHA): before creating, look up an existing PR for the branch, so a timeout followed by a retry
   finds the first PR rather than opening a second one.
8. **Persist and continue.** The task goes terminal, the claim is released, the pool wakes the next
   FIFO waiter. Nothing merges; itay merges.

**Failure handling, by case:**

| Case | Behaviour | Mechanism |
|---|---|---|
| Usage limit | re-park with blocker evidence, retry at reset, routed fresh at wake (may pick the other assistant if eligible) | K2 (+K3 if enabled) |
| Lost session / plane crash | boot reconciliation: not-started / start-attempted-ambiguous / started; ambiguity holds the slot until resolved | K1, K4b |
| Provider error mid-run | existing failover to an eligible assistant, or `WAITING_INPUT` | orchestrator failover |
| Timeout on an external side effect (task create, push, PR create) | never assumed not to have happened: reconcile by idempotency key (task) or by lookup (branch, PR) before retrying | P0-2, P0-5 |
| Two lanes on the same item | OCI: the plane's unique `clientRequestId`. Manual cloud lanes: they work on branch `os/<item id>`; creating a ref that exists fails on GitHub, so a second lane cannot silently start the same item | P0-2, branch naming rule |

### C.3 Backlog and progress

`docs/progress/backlog.yaml` items: `id`, `title`, `phase`, `repo`, `size` (S=1, M=3, L=8),
`depends_on`, `files`, `lane` (`oci-loop` | `manual-cloud` | `owner`), `night` (bool), `profile`
(routing profile), `acceptance` (commands and drive). No `status` field: status is derived —
**done** = PR merged with verdict PASS or SKIP; **in progress** = plane task non-terminal or open
PR; **blocked** = plane task `WAITING_INPUT` or a BLOCKED verdict; **queued** = otherwise.

The daily report shows **scope points done / total** per phase and overall, labelled "estimated
scope points", plus scope added that day as its own line. The percentage is an estimate of scope
and says so; vNext increment 13 replaces it with real subtask counts for OS tasks once subtasks
exist.

### C.4 Lanes, honestly

| Lane | Dispatchable by the plane? | How work reaches it today |
|---|---|---|
| OCI plane → Claude Code / Codex adapters | **yes** (this is the loop) | plane tasks |
| Claude Code cloud (project threads) | **no** | the coordinator starts threads; Claude Code routines/triggers can start cloud sessions from the coordinator, not from the plane |
| Codex cloud | **no** (no integration demonstrated) | itay pastes a repo-only prompt |
| itay's laptop | no | manual |

Missing integration, named: a plane-side remote worker contract (registration, short-lived scoped
credentials, leases with fencing, artifact transfer). It stays unscheduled (§F, P2) until a real
need exceeds the OCI box. Provider credential homes never move into cloud sandboxes.

### C.5 OCI deployment topology

- Plane as the existing systemd user unit `agent-plane-operator.service`; Cockpit as
  `cockpit-dashboard.service` (#51). Both loopback.
- Access: SSH or Tailscale only. The plane API stays private until remote-auth stage 2 is built
  (`docs/adr/remote-auth-design.md`).
- SQLite: nightly online backup with the sqlite3 backup API + `integrity_check` (the O8 procedure),
  scheduled with the existing daily-jobs pattern, and a tested restore (G7).
- Worktree per task (existing); orphaned-worktree and orphaned-process sweep at boot (P0-3 adds the
  process half).
- Secrets: provider homes stay where the CLIs put them (`~/.claude`, `~/.codex`); API keys in
  per-key files referenced by config (the `typesafe.key` pattern); never in the repo, logs or
  PROJECT_MEMORY.
- Night window: 23:00–07:00 Asia/Jerusalem (default for D-4). Night items get a `time` wait for the
  window start plus the pool requirement, both through existing `WaitInput` kinds.

### C.6 AI Doctor (new, small, read-only)

**Where it runs.** The deterministic pass is an in-process daily job in `apps/api/src/modules/jobs.ts`
(the pattern the AA refresh already uses), at 02:30 Asia/Jerusalem. `msUntilDailyHour` takes a
whole hour in the server's local time today, so the slice adds a minute argument and the unit sets
`TZ=Asia/Jerusalem` (or the job runs at 02:00). It uses no model and needs no pool slot. Escalation to a model is an ordinary plane task with the `oci-heavy` requirement and a
token cap, so the Doctor never has its own scheduler.

**Inputs, incremental since the last run's cursor:** commits and PRs on both repos (GitHub REST),
CI conclusions, plane tasks ended FAILED/BLOCKED or with verification failures, K1/K4b
reconciliation events, re-parks per task, approval prompt rate, token use per verified task,
K13 shadow `would_differ` counts, new AA rows unmatched by the map.

**Ledger** (new table, one migration): `fingerprint` (rule id + component + normalised evidence
key), `component`, `evidence_refs`, `first_seen`, `last_seen`, `severity`, `confidence`,
`expected_benefit`, `recommendation`, `disposition` (`open | accepted | rejected | resolved |
snoozed until`), `related` (issues/PRs), `reopen_reason`. An unchanged fingerprint is never
re-reported; a resolved one reopens only with new evidence, and says why.

**Budget:** per run ≤ 1 model call by default, ≤ 20k input / 2k output tokens, ≤ 10 min wall time,
$0 external spend unless D-7 allows Jev. A `deterministic-only` mode is the default whenever quota
evidence is blocked. Output: at most three findings, each with evidence, benefit, effort and a
suggested slice. Zero findings is a success.

**Presentation:** a Cockpit Doctor view (or an OS diagnostics app) and one line in the daily report;
nothing permanent in the shell. Measured by acceptance rate, verified benefit, duplicate rate and
resources used. It never edits policy, installs tools, implements its own recommendations or
merges.

### C.7 Provider and application manifest (descriptive, not a plugin runtime)

The seams already exist: `AgentAdapter` (+ capability blocks, `provision()`), `DecisionProvider`,
`EvidenceSource`, the registry v1 contract, MCP assets via Cockpit. The review's "plugin contract"
is therefore a **manifest** describing what each provider supplies, read through one plane route,
not a mechanism for loading third-party code.

`provider-manifest v1` (JSON Schema under `contracts/`, Cockpit vendors it SHA-pinned):
`id`, `kind` (`coding-agent | model | decision | evidence | tool | app`), `auth`
(`subscription-login | api-key | none`, never the secret), `identity` (requested/resolved model
rules), `efforts` (provider-native names, uncalibrated), `pricing` / `quota` (evidence source or
`unknown`), `targets` (`local | oci | cloud`), `controls` (`resume | cancel | input | compact`, each
`supported | unsupported | unknown`), `permissions`, `telemetry`, `health`. Unknown is a value;
unsupported is explicit.

`GET /api/providers` projects today's adapters, decision providers, AA and Cockpit into it.
Adding a hypothetical tool "0xAlpha" means: write an adapter or provider behind the existing seam,
declare its manifest, pass capability probes; until then it shows as `unavailable`. The OS keeps
working with any provider down because routing already filters ineligible candidates.

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
reverse-engineered or bypassed; K3 uses only the provider's own usage endpoint.

### D.3 Two-stage selection (already the design; keep it)

1. **Eligibility (deterministic, cheap):** the router's hard filters — auth, capability, workspace
   policy, quota evidence (K2 projection), security, compatibility, explicit overrides. No score can
   re-admit a filtered candidate (`model-selection.ts`).
2. **Choice among eligible (evidence):** K13 blends AA priors and own telemetry with `w(n)=n/(n+k)`
   per dimension, under the task's routing profile. Shadow until the six gates pass.

**User-facing goals map onto existing profiles — no new concept:** Best Quality → `best-quality`,
Balanced (default) → `auto`, Fast & Efficient → `fastest`. Advanced: `preserve-quota`,
`lowest-tokens`, token caps (enforced today), model/assistant overrides. Cost caps in dollars stay
deferred (deferral #3's five gates).

### D.4 Effort and roles

- **Effort is identity, not a knob shared across vendors.** A cohort is (assistant, resolved model,
  provider-native effort, task kind). Claude `high` and Codex `high` are never treated as equal; AA
  scores each effort as its own row, which is the only cross-vendor anchor, and local outcomes
  calibrate from there. Until a provider reports the effort it ran with, the requested effort is
  recorded as requested, not resolved.
- **Roles.** Single-agent + deterministic verification is the default for every task. A separate
  **reviewer run on the other vendor** is added only by policy: size L, or paths under
  `contracts/`, `migrations/`, `auth/`, `.github/`, or `AGENTS.md`/`CLAUDE.md`. It is a second plane
  task with `assistantId ≠ implementer` (vNext P2 "verifier ≠ implementer"). Planner → implementer
  chains wait for vNext 10 (subtasks); until then a "plan" is a docs PR, as now. Multi-agent
  patterns earn a default only by beating single-agent on the scorecard at equal budget.

### D.5 OS-vs-solo measurement

Hypothesis: *at equal token budget, the OS (Balanced) reaches a verified result on at least as many
corpus tasks as the better of Claude-solo and Codex-solo, with no more unauthorised actions; time
and cost are reported, not traded silently.*

- **Corpus:** 24 tasks — 8 small fixes, 6 features with tests, 4 refactors, 3 docs/research, 3 UI —
  across `ai-control-plan`, `cockpit` and a scratch fixture repo, each with deterministic acceptance
  (tests, typecheck, a drive script).
- **Arms:** OS = personal workspace, composer on, profile `auto`. Solo = a second workspace with
  composer off and `overrides.assistantId` fixed (unmodified ambient config), one per vendor. Same
  token cap per task.
- **Metrics, separately:** verified success, unassisted completion (no human input), time to
  verified result, tokens and $ by category, code quality (reviewer findings from the other vendor
  + lint/complexity deltas), recovery success after an injected interruption (kill mid-run on 6
  tasks), incorrect or unauthorised actions (gate log), orchestration overhead (extra tokens and
  wall time of compose/verify).
- **Where:** on OCI with subscription logins, serialised in the `oci-heavy` pool, at night. Not in
  GitHub Actions (that needs metered keys; eval.yml stays manual).
- **Judging:** deterministic checks decide pass/fail; the implementer never judges itself; quality
  review uses the other vendor.
- **Output:** a promoted scorecard in `docs/eval-history/` via `pnpm eval:promote`. Until it
  exists, every report says "OS ≥ solo: not measured".

### D.6 AA and Jev specifics

- **AA:** map exact ids from the live grounding list (never guessed), including the effort row
  that matches the CLI's default effort; add OpenAI rows for the Codex models in use; keep A4's
  base-config attestation as the precondition for priors. AA is evidence only.
- **Jev:** stays offline (floor discovery). Candidate new sites, in order of expected value:
  (1) task classification against the frozen v1 regex classifier and the K20 v2 shadow rules,
  (2) review escalation ("does this diff need a cross-vendor reviewer?"), (3) prioritisation hints
  for the dispatcher. Each enters as a **shadow** `DecisionSite` with: a labelled corpus,
  calibration curve, a confidence threshold below which the rule answer is used, fail-closed to
  rules on timeout/error, and a pass bar stated before the run (e.g. ≥ rules accuracy at p95 < 500
  ms and < $0.10 per 1k). Never the tool gate (owner decision stands), never a scheduler.

---

## E. OS product experience

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
| U5 | Apps launcher from `GET /api/providers` (Cockpit first) | `ApplicationWorkspace` |

A mockup is deferred until the reference image is uploaded to the project; it would be a static
page built from these stages, not a change to `apps/web`.

### E.6 Cockpit as the first installed app

Cockpit keeps its own UI, loopback bind and authority over assistant config. The plane lists it
through the provider manifest (`kind: app`) with health and vendored-contract SHAs, and links to
it; it does not re-implement Cockpit pages. Cockpit features stay Cockpit's: the 3D memory/lineage
graph (O7 half, with a 2D fallback), the Retro tab gaining per-task retros from verdicts and the
scorecard, Discover's trends ranked by fit to this machine's asset usage (O2 radar), and the AI
Doctor view.

---

## F. Prioritised roadmap

Complexity: S ≈ half a day, M ≈ 1–2 days, L ≈ 3+ days of one session. Every slice: own worktree,
named files, gate `pnpm typecheck && pnpm lint && pnpm test` (plane) or `npm test && npm run build`
(Cockpit), a drive where it executes, one verdict, PR to main, never merged by an agent.

### P0 — correctness and the first autonomous loop

| Slice | What | Files | Lane, model / effort | Acceptance | Size |
|---|---|---|---|---|---|
| P0-0 | This plan + independent Codex review (brief) | docs | itay runs the brief in Codex | review findings recorded in the dispute log | S |
| P0-1 | Configure the pool on OCI: `scheduler.resources: { oci-heavy: 1 }`; confirm `execution.harnessModes.single` and composer settings; no code | live config | OCI, Codex / low | `GET /api/scheduler/status` lists the pool; config backup taken | S |
| P0-2 | Idempotent intake: optional `clientRequestId` on `POST /api/tasks`, unique, returns the existing task on repeat; migration 042 | `server.ts` (route), `tasks.ts`, migration 042, tests, `db.test.ts`/`task-classifier.test.ts` migration lists | cloud, Opus 5.5 / high | two concurrent POSTs with one key → one task; a different body with the same key → 409; restart-safe | M |
| P0-3 | Host admission as a pool readiness clause: optional `scheduler.resources.<pool>.admission { maxLoad1, minFreeMemMb, noLiveProviderProcesses }`, evaluated in `resourceReady`; boot sweep of orphaned provider processes | `scheduler.ts` (readiness only), `config.ts`, a small `host-admission.ts`, tests | cloud, Opus 5.5 / high | with load faked high the FIFO front stays parked and is reported `blockedBy: host`; a leftover child process from a killed plane is found and reported at boot; capacity math untouched | M |
| P0-4 | Backlog file: `docs/progress/backlog.yaml` + JSON Schema + validation test, audited from both repos (incl. vNext 1–9 status) | `docs/progress/**`, `scripts/backlog-check.mjs` | cloud, Sonnet 5.5 / high | schema test passes; every item has acceptance and files | M |
| P0-5 | Publish after verification: push `os/<item>` and open a draft PR, idempotent by lookup; never merge; GitHub token scoped to `contents:write` + `pull_requests:write` on allowlisted repos (D-3) | new `publisher.ts`, one call after verification PASS, tests with a fake GitHub | cloud, Opus 5.5 / high | verification FAIL → no push; killed between push and PR create → rerun opens exactly one PR; token value never logged | M |
| P0-6 | Dispatcher: selects the next eligible item, creates the task with `clientRequestId` + resource wait (+ night `time` wait), records nothing in git | `apps/api/src/bin/dispatch.ts` (one-shot, run by a K5 schedule or a daily job) | cloud, Opus 5.5 / high | dry-run lists the pick and why; a second run creates no second task; an item with an open PR is skipped | M |
| P0-7 | Live proof G1–G8 on OCI | none (drives + evidence) | OCI, Claude Code / Sonnet 5.5 medium, one experiment per session | §G pass criteria | M |

Parallel safety: P0-2 (`tasks.ts`, route, migration) ∥ P0-4 (docs) ∥ P0-3 (`scheduler.ts`,
`config.ts`) touch disjoint files; P0-5 and P0-6 follow P0-2. P0-1 runs on OCI any time.

### P1 — visibility and intelligence

| Slice | What | Lane, model / effort | Gate |
|---|---|---|---|
| P1-1 | AA map grounding (O12 phase 2 ids → `AA_MODEL_MAP`, effort row matching the CLI default; OpenAI rows) | OCI read (Codex / low) then cloud Opus 5.5 / high | `mapped > 0` on the next live refresh |
| P1-2 | Daily report as a projection (`scripts/progress-report.mjs`: backlog + GitHub REST + optional plane read) + a morning routine | cloud, Sonnet 5.5 / high | numbers reproduce from sources; no hand-written % |
| P1-3 | `aos` CLI-1 read-only (`ps`, `logs`, `attach`, `quota`, `models`, `progress`) | cloud, Opus 5.5 / high, `apps/cli/**` | drive against `pnpm dev` |
| P1-4 | `aos` CLI-2 chat (create with preview, stream, approvals) and CLI-3 (`tonight`, `at`, `queue`) | cloud, Opus 5.5 / high | idempotent create via P0-2 |
| P1-5 | Scorecard corpus (24 tasks) + baseline workspace + night runs | cloud (corpus) then OCI night | promoted scorecard |
| P1-6 | Phase 8 close (readiness §4: attestation, cohorts ≥10 opus and ≥10 sonnet **as loop items at night**, live re-drive, owner gate decision, close record) | OCI + docs | close record |
| P1-7 | Jev shadow site #1 (task classification) with calibration and a pre-stated pass bar | cloud, Opus 5.5 / high | D-7 |
| P1-8 | AI Doctor D0 (deterministic job + ledger migration + Cockpit view later) | cloud, Opus 5.5 / high | ≤ 3 findings, duplicate rate 0 on a replayed week |
| P1-9 | Audit vNext increments 1–9 status into the backlog | cloud, Sonnet 5.5 / medium | each item with evidence |

### P2 — integrated product

U1–U5 (shell hierarchy), provider manifest + `GET /api/providers` + Apps launcher, Cockpit 3D
graph / retro / radar / Doctor view, remote-auth stage 2 then a Vercel UI (after the cloud note's
four answers), vNext 10–13 (subtasks, fan-out, multi-repo saga, progress projection), K13
activation (after a week of shadow log and itay's review), remote worker contract (only on
demonstrated need).

Order rationale: nothing in P1/P2 is useful unattended until P0 proves the loop is safe; AA
grounding (P1-1) is cheap and independent, so it runs in parallel on a manual lane rather than
waiting.

---

## G. Live proof plan (OCI, after P0-1…P0-6 merge)

Run one experiment per session, load < 1.5 before each, backups first. Fake assistant first
(`FAKE-*-not-real` values for any secret), then one real run where marked.

| # | Experiment | Pass |
|---|---|---|
| G1 | 3 tasks on `oci-heavy: 1`; also try a direct `/start` and a `/parallel` on a task with no requirement | one claim at a time; FIFO order; the direct starts' pool behaviour recorded (expected: outside the pool → dispatcher-only rule confirmed) |
| G2 | `kill -9` the plane mid-run, restart | boot reconciliation leaves one owner; no second provider start; the slot is held or released exactly per K4b §3 |
| G3 | Orphan process: kill the plane while a provider child runs | P0-3 reports the child; the pool does not admit the next task until it exits |
| G4 | Intake idempotency: same `clientRequestId` twice, once across a restart | one task |
| G5 | Approval pause: a task that needs approval | slot held while paused; approve via API; continues |
| G6 | Verification fail, then pass | FAIL → no branch pushed; PASS → one draft PR; killed between push and PR → rerun finds and keeps one PR |
| G7 | DB backup and restore | restored DB passes `integrity_check` and lists the same tasks |
| G8 | Night run (real providers): 3 loop items queued for 23:00 | morning report shows 3 outcomes with verdicts; any limit hit shows a K2 re-park and a later wake |

Overall verdict PASS only when all eight pass.

---

## H. Decision log (needs itay)

| # | Decision | Recommended default | Consequence |
|---|---|---|---|
| D-1 | Run Claude unattended on OCI with the subscription login | **yes**, personal and individual volume, per the 2026-10-07 update; switch to a Console API key if volume grows | draws from plan limits; no metered spend |
| D-2 | Codex unattended on OCI: ChatGPT sign-in or API key | **API key for unattended night runs** (the documented recommendation for programmatic workflows), ChatGPT sign-in for interactive use; or keep sign-in if you accept that the docs I could read do not address personal unattended use | API key = metered spend with a cap you set |
| D-3 | Let the OCI plane push branches and open **draft** PRs | yes, fine-grained token: `contents:write`, `pull_requests:write`, the two repos only | PRs appear without you; merging stays yours |
| D-4 | Night window | 23:00–07:00 Asia/Jerusalem | night items wait for 23:00 |
| D-5 | Night quota: may loop items spend subscription quota without asking each time | yes, up to N items per night (default 3) | the loop stops after N |
| D-6 | Cloud note (#133) four questions | as the note recommends: (b) OCI + stage 2 first; no fixture preview; Google OIDC; no metered billing now | Vercel waits for stage 2 |
| D-7 | Jev shadow experiment spend | ≤ $1 on OpenRouter, shadow only | measures Jev on classification |
| D-8 | Phase 8 close basis | close on "gate holds and is shown live" after P1-6 | does not wait a week |
| D-9 | AI Doctor schedule and budget | 02:30 Asia/Jerusalem, deterministic-only until you raise the budget | zero tokens by default |
| D-10 | Auto-merge | **off; not on the roadmap.** A future guarded option would need its own approval, independently verified checks, head-SHA binding, branch protection, a kill switch, and a path rule that treats `*.md` agent instructions as code | the owner-merge rule in both `AGENTS.md` files is unchanged |

---

## I. What changed from revision 1

**Discarded:** N1 "heavy-run slot of 1" (duplicates K4b); `backlog.yaml` with live status, claims
and `resume_after` (live state belongs to the plane); a hand-maintained percentage; auto-merge
option B and its workflow slice; "OS ≥ best single assistant for every prompt" as an absolute
goal; handoff Markdown as recovery evidence; treating cloud chat sessions as dispatchable lanes.

**Corrected:** "no scorecard ever promoted" → one fake-only scorecard exists (2026-09-05);
"nightly Eval" → manual only, metered keys; K4b, routing profiles and the existing shell are now
reused instead of re-proposed.

**Added:** verified inventory (§B), single-authority table and the autonomous loop with failure
handling (§C), authorisation matrix (§D.2), OS-vs-solo hypothesis and corpus (§D.5), AI Doctor
(§C.6), provider manifest (§C.7), shell-first UX plan on existing components (§E), live proof
plan (§G), decision log (§H), Codex review brief.

**Retained:** quota is per account, not per machine; repo files are the only context OCI and Codex
sessions can read; session hygiene (one slice per session, own worktree, disjoint files, model and
effort per work type, compact or restart with a handoff note); the night queue, now on existing
K1 time waits plus the K4b pool.

### Disputes between the review and revision 1

| Issue | Evidence | Resolution | Why |
|---|---|---|---|
| K4b deferred vs shipped | K4b record, migration 023, 59 tests | review right; N1 dropped | code wins |
| "Use the existing pools" is enough | pool applies only to tasks carrying a requirement; no host load; release at terminal (K4b §3) | **partly disagree**: pools yes, plus dispatcher-only intake with a resource wait and P0-3 admission | an unconfigured or non-plane load would still overrun 1 CPU |
| Planner → Implementer → Reviewer → Verifier by default | verification is already deterministic; no subtasks yet (vNext 10) | **disagree as a default**: single agent + deterministic verify; cross-vendor reviewer by policy | overhead without measured benefit |
| A new provider/plugin contract | adapters, `DecisionProvider`, `EvidenceSource`, registry v1 exist | **narrowed** to a descriptive manifest + one read route | no second extension mechanism |
| Best / Balanced / Fast goals | `RoutingProfile` already has `best-quality`, `auto`, `fastest` | mapped to existing profiles | no new concept |
| AI Doctor scheduling | `jobs.ts` daily jobs, K5 schedules | deterministic part in `jobs.ts`; model escalation as a pooled plane task | no parallel scheduler |
| Docs-only auto-merge is safe | Markdown carries agent instructions (AGENTS.md, skills, memory) | review right; auto-merge off | instructions are code |
| backlog drives execution | plane already has leases, generations, claims | review right; backlog = desired work | one authority per state |
| Cloud chats as workers | no plane→cloud integration | review right; manual lanes named | no fictional capability |
| Eval nightly | `eval.yml` is `workflow_dispatch` only | review right | — |
| P0 order | the missing pieces are intake idempotency, admission, publish, dispatch | agree, with AA grounding in parallel | cheap, independent |

## Verdict

**SKIP** — plan document only; no runtime surface. Independent Codex review: **PENDING**.
