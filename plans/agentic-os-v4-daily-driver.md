# Agentic OS v4 — from prototype to daily driver

**Status:** PROPOSED, 2026-09-26. Owner: Itay. Executed unattended by the autopilot
(`autopilot/README.md`) during the week of 2026-09-27 → 2026-10-04 on the
`autopilot/integration` branch of both repositories. Nothing here merges to `main`
without the owner.

**Goal (owner's words):** an Agentic OS for daily usage for *all* AI usage — one place
to direct, watch and remember AI work, with a clean view per tab.

**Written against:** `ai-control-plan` `main@2e3c9f4` (API contract 2.3, migrations
through 030) and `cockpit` `main@a929bed`.

---

## 1. Where it stands (verified 2026-09-26)

| Area | State | Evidence |
|---|---|---|
| Kernel: routing, handoff, quota failover, waits (K1–K5), model intel (K7–K14) | Done, live on OCI | `plans/progress.md`, PRs #34–#42 |
| Shell mode + session input (Stream A) | Landed on `main` (#47, #51, #58, #65) | `git log origin/main` |
| Harness flip (legacy → harness) | Flipped on the operator 2026-09-25; soak running | #60–#62, `pnpm soak:check` |
| M16 Decision Service (Jev) | K17–K19k on `main`, **shadow only**; K20 proposed (docs), K21/K22 not started | `plans/jev-decision-service-plan.md`, `plans/k20-task-classifier-proposal.md` |
| Web shell tabs | **Overview + Agents real; Memory, Routing, Traces, Tools, Settings are placeholders** | `apps/web/src/shell/ApplicationWorkspace.tsx` ("Planned integration" copy) |
| API surface for those tabs | Exists for Routing (`/api/tasks/:id/routing`, `/api/decisions`, `/api/scores`), Traces (`/api/tasks/:id/events`), Settings (`/api/schedules`, `/api/workspace`); **none for memory or tools** | route grep over `apps/api/src` |
| Cockpit | 15 working tabs (memory graph + garden, installed skills/agents/MCP, retro, usage, schedule, logs, knowledge, context compile); vanilla JS; reads the plane read-only at contract 2.0 (compatible with 2.3) | `cockpit/README.md`, `controlPlane.ts` |
| Mission titles | None — a task has only `goal`; Overview shows the raw prompt as the heading | screenshot 2026-09-26; `packages/core/src/contracts.ts` has no `title` |

### Why Jev is not on the Agents tab

Jev is not an assistant environment — it is M16, a decision service *beside* the kernel
(tool gate, task classifier, context breakpoint, failure attribution). The Agents tab lists
environments (`personal-claude`, `personal-codex`, `personal-ox-alpha`). M16 has records and an
API (`GET /api/decisions`, `/api/decisions/prompt-rate`) but **no operator surface** — that is
slice K22, never started. It also runs the `rules` provider by default, so "Jev" as a hosted
vendor is not called at all today. Status in one line: *gate built and soaking in shadow; the
classifier (K20) waits on the owner's corpus approval; nothing is visible in the UI.*

---

## 2. Research findings and recommendations

### 2.1 `msitarzewski/agency-agents` — ADOPT as a catalog source, curated

~154k stars, MIT. 23 divisions, ~200 Markdown agent personas with frontmatter, plus
`scripts/install.sh` / `convert.sh` targeting Claude Code, Codex, Cursor, Copilot, Gemini
CLI, OpenCode and others.

- **Do:** add it to Cockpit's discovery sources as a *catalog* (not an auto-install), so each
  agent shows up in Tools → Catalog with division, target tools and an install button that
  runs `convert.sh` for the chosen assistant. Seed a curated set for daily use:
  Engineering (Code Reviewer, Backend Architect, AI Engineer, DevOps Automator), Testing
  (Reality Checker, Evidence Collector, API Tester), Security (AppSec Engineer), Specialized
  (Agents Orchestrator, MCP Builder), Product (Sprint Prioritizer, Feedback Synthesizer).
- **Don't:** bulk-install all ~200. Personas cost context on every session and several tools
  cap agent counts (OpenCode ~119). Personas are prompts, so they go through the same
  security gate as any skill (see AI-Infra-Guard below).
- **Fit with the plane:** a persona is an *asset* in the kernel-services model (assets
  layer), so the routing explanation can later say "routed to Claude + Reality Checker".

### 2.2 The seven tools

| Tool | What it is | Verdict | Where it lands |
|---|---|---|---|
| **Serena** (`oraios/serena`, ~28k★, MIT) | MCP server giving agents LSP-backed symbol search, references and symbolic edits across 40+ languages | **ADOPT** | Install on `ai-workstation` for both Claude Code and Codex; register in the assistant manifests so the capability probe reports it. Low risk, direct token savings on this TypeScript monorepo. |
| **AI-Infra-Guard** (`Tencent/AI-Infra-Guard`, ~6k★, Apache-2.0) | Red-team platform: skill scan (9 categories), MCP scan (14 risk classes), agent scan, AI-infra CVE scan, jailbreak eval; Docker web UI + CLIs | **ADOPT (trial)** | Run its `skill-scan` / `mcp-scan` CLIs nightly over installed skills, MCP servers and any catalog item *before* install; surface findings in Tools. Complements Cockpit's existing security gate instead of replacing it. |
| **OpenWiki** (`langchain-ai/openwiki`, ~16k★, MIT) | CLI that writes and maintains an agent-facing wiki for a repo, with claim→code evidence sidecars, scheduled CI PRs | **TRIAL** | Trial on `cockpit` first (smaller, fewer hand-written docs). `ai-control-plan` already has dense, hand-verified docs and a graphify index; judge by whether agents need fewer broad searches. Weekly CI job opens a docs PR, never auto-merges. |
| **evo** (`evo-hq/evo`, ~1.3k★, Apache-2.0) | Claude Code/Codex plugin: discovers a metric, instruments a benchmark, runs tree search over experiments in parallel worktrees | **LATER** | Good fit once there is a numeric target worth optimising — e.g. the eval harness score or tool-gate floor p95. Not a daily-driver need this week. |
| **LangWatch** (`langwatch/langwatch`, ~3.5k★, Apache-2.0 core) | LLM observability + evals + agent simulations; OTLP-native; self-host needs Postgres + Redis + ClickHouse | **DEFER** | Heavy for a single OCI box, and no native Claude Code / Codex session tracing. Instead add an **OTLP exporter** to the plane's normalized event bus (small, vendor-neutral) so LangWatch or any OTel backend can be plugged in later. |
| **Orca** (`stablyai/orca`, ~73k★, MIT) | Desktop "agent development environment": parallel agents in worktrees, SSH remote runtime, iOS/Android companion with push notifications | **USE PERSONALLY, DON'T INTEGRATE** | It overlaps the plane's own core (parallel worktrees, compare, handoff). But its mobile companion answers "watch my OCI agents from my phone" today, before the plane has authenticated remote mode. Borrow the pattern: push notifications on *needs you* / *done*. |
| **project-atlas** (ambiguous name; closest match `WezzSide/project-atlas`, 1★) | Local-first documentation compiler with provenance vault | **SKIP** | No public licence — code cannot be reused. The ideas (provenance, bitemporal catalog) already exist in the plane's evidence/redaction design. If you meant a different repo, add its URL to the backlog note. |

### 2.3 Chase AI "Agentic OS" video — what we are missing

The video could not be fetched directly (TikTok blocks crawlers); these insights come from the
screenshots attached on 2026-09-26 and the public companion material (Chase AI blog,
`ctskool/agentic-os-starter-v2`).

Their architecture: **two front doors** (Obsidian plugin + Jarvis browser HUD) → **one bridge**
→ **Jev sorts each request into three tiers** → **one shared vault** of plain Markdown.

| Their idea | Our state | Gap → backlog |
|---|---|---|
| **Tiered requests** — Tier 1 rules + saved data, no AI, instant ("what are my priorities?"); Tier 2 small fast model quick answer; Tier 3 real work opens a Claude/Codex terminal | Every mission is Tier 3: routed to a full agent environment | **Biggest conceptual gap.** Add a fast path in front of the mission pipeline, decided by K20's classifier floors (`T-C4`). |
| **Receipts of every request** written to the vault | `progress.md` / `handoff.md` per task inside the workspace dir; not browsable as a knowledge base | Daily Markdown receipts + Obsidian-compatible vault export (`T-D3`). |
| **Skill backbone** — domain → task → skill → automation; "done twice → skill", "5 green runs → automate", "sends, spends or publishes → stays manual" | Cockpit tracks installed skills; the plane has schedules; nothing links them | Skills registry with domain/automation status and the three rules of thumb enforced as badges (`T-D2`). |
| **Weekly usage meters** per provider on the home screen | Quota probes exist (K3) but no weekly-usage readout | Usage meter cards on Overview (`T-D4`). |
| **Provider switch** Claude ⇄ Codex in one click | Routing is automatic; override exists per task | Keep automatic routing; add a visible "prefer" toggle on New mission (`T-B7`). |
| **Voice** (Whisper ears, Kokoro voice) | None | Proposal + spike only (`T-D1`); not daily-critical. |
| **Directives / Today** — top 3 priorities and documents inbox | None | "Today" panel on Overview fed from the vault/Todoist later (`T-B7`). |
| **Doctor / service monitor** | `soak:check`, health endpoint | Surface health + doctor in Settings (`T-B5`). |

---

## 3. Gap analysis — BE / FE per tab

Principles for every tab: a one-line purpose, **KPI row first**, then collapsible sections
(default-open only what needs action), charts where a trend matters, empty states that say
what to do next, and every value labelled with its source (kernel, cockpit, estimate).

| Tab | Today | Target | BE work | FE work |
|---|---|---|---|---|
| **Overview** | Mission composer, system overview, selected mission (raw prompt as title), orbital field | KPI row (running / need you / waiting / settled / cost today / weekly quota per provider); missions list with **titles**; Today panel; charts: missions per day, success rate | `title` on tasks (`T-A1`); usage aggregate endpoint (`T-D4`) | Collapsible sections, titles everywhere, sparklines (`T-B7`) |
| **Agents** | 3 cards, expandable models | Per-agent: auth, quota gauge, running missions, success/latency sparkline, installed MCP/skills count; **Decision Service card** (M16/Jev: provider, mode, soak n/500, prompt rate) | `/api/decisions/summary` (`T-C3`) | Card redesign (`T-B6`) |
| **Memory** | Placeholder | Force-graph of Claude memory + Obsidian vault + mission context; Garden findings; search | Cockpit bridge (`T-A2`, `T-A3`) | Graph view (`T-B1`) |
| **Routing** | Placeholder | Recent routing decisions with explanation, K13 shadow vs actual, decision records, prompt-rate chart; read-only policy | Existing endpoints + summary (`T-C3`) | `T-B4` |
| **Traces** | Placeholder | Cross-mission timeline, per-run event drill-down, tokens/cost by assistant chart | Paginated cross-task events endpoint (`T-B3`) | `T-B3` |
| **Tools** | Placeholder | Inventory of skills, agents, MCP servers, plugins, hooks per assistant; catalog (agency-agents, trends proposals); security findings | Cockpit bridge (`T-A3`), scans (`T-E2`) | `T-B2` |
| **Settings** | Placeholder | Providers + auth, schedules, retention, doctor/health, read-only config with file paths | Existing `/api/workspace`, `/api/schedules` | `T-B5` |

### Gaps not mentioned in the request (found during the audit)

1. **Remote access is the real blocker for "daily use from anywhere".** The ADR
   (`docs/adr/agentic-os-deployment.md`) forbids exposing the loopback API; authenticated remote
   mode is unbuilt. Until then use the SSH tunnel, or Orca's companion. Tracked as `T-G1` (design
   only this week).
2. **Notifications.** "Need you" missions sit silently. Add a notifier (ntfy/Telegram/email) on
   `needs_operator` and `settled` transitions (`T-G2`).
3. **Cockpit ↔ plane contract drift.** Cockpit pins 2.0 while the plane serves 2.3; compatible by
   policy, but Cockpit uses none of 2.1–2.3 (decisions, session input). Resolved by the merge.
4. **Three copies of the task classifier** (K20 proposal §2) silently disagree — fixed by `T-C1`.
5. **`personal-ox-alpha` shows `auth: missing`** because `OPENROUTER_API_KEY` is unset in the
   service env — an ops item for the owner, not code (listed in §6).
6. **No backup of `~/.agent-plane`** (SQLite, checkpoints) off the box (`T-G3`).

---

## 4. Two repos or one? — **Recommendation: one product, merged in stages**

**Merge Cockpit into `ai-control-plan` as `apps/cockpit`, then retire Cockpit's UI tab by tab.**

Why: two servers, two UIs and a versioned HTTP contract between two repos that one person owns
is overhead with no isolation benefit — both run on the same box, under the same user. The daily
driver needs one shell. Cockpit's value is its **modules** (memory graph, garden, installed-tools
inventory, context compile, retro/usage, schedule, logs, trends scan), not its vanilla-JS UI.

Stages (each reversible):

1. **Bridge (this week):** the plane's API reads Cockpit over loopback through a read-only
   `cockpit-bridge` module (`T-A3`), so the React shell's Memory/Tools tabs get real data now.
2. **Import (owner-gated):** `git subtree add --prefix=apps/cockpit` keeps Cockpit's history; add
   it to the pnpm workspace. **Blocker:** `ai-control-plan` is **public** and Cockpit is
   **private** — importing publishes Cockpit's code and its `proposals/` history. Either make the
   merged repo private or scrub first. The autopilot prepares a secrets/PII audit and a dry-run
   branch (`T-F1`) but **does not merge or change visibility**.
3. **Retire:** once each React tab reaches parity, drop the matching Cockpit tab; archive the
   Cockpit repo.

---

## 5. Backlog (the autopilot executes this, in order, respecting `deps`)

Machine-readable source of truth: `autopilot/backlog.json`. Lanes: **claude** = Claude Code
scheduled cloud sessions; **codex** = Codex on `ai-workstation` via the OCI runner.
`owner` = needs a human decision; the autopilot prepares it and stops.

| ID | Lane | Repo | Title | Deps |
|---|---|---|---|---|
| T-A1 | claude | acp | Mission titles: `title` column at intake (deterministic, ≤60 chars) + UI everywhere | — |
| T-A2 | codex | cockpit | Bridge contract: versioned read-only `/api/bridge/*` (meta, memory graph, garden, installed, usage, schedules, logs) | — |
| T-A3 | claude | acp | `cockpit-bridge` module: config `cockpit.url`, capability-gated read-only proxy endpoints | T-A2 |
| T-C1 | codex | acp | K20 step 1: one `classifyTaskV1`, delete two copies, golden test (pure refactor) | — |
| T-C3 | claude | acp | K22 operator surface: `/api/decisions/summary` + `pnpm decision:shadow-report` | — |
| T-B7 | claude | acp | Overview v4: KPI row, titled missions list, collapsible sections, sparklines, Today panel | T-A1 |
| T-B6 | codex | acp | Agents v4: richer cards + Decision Service (M16) card | T-C3 |
| T-B4 | claude | acp | Routing tab: decisions, explanations, K13 shadow, prompt-rate chart | T-C3 |
| T-B3 | codex | acp | Traces tab: cross-mission timeline + cost/tokens charts (+ paginated events endpoint) | — |
| T-B5 | codex | acp | Settings tab: providers/auth, schedules, retention, doctor — read-only | — |
| T-B1 | claude | acp | Memory tab: force graph + garden + search via bridge | T-A3 |
| T-B2 | claude | acp | Tools tab: inventory + catalog + security findings via bridge | T-A3 |
| T-E4 | codex | cockpit | agency-agents catalog source + curated install via `convert.sh` | T-A2 |
| T-E1 | codex | acp | Serena: install doc + manifest registration on ai-workstation (no secrets) | — |
| T-E2 | codex | cockpit | AI-Infra-Guard nightly skill/MCP scan → findings JSON in bridge | T-A2 |
| T-D4 | claude | acp | Weekly usage meters per provider (from quota probes) on Overview | T-B7 |
| T-D2 | claude | acp | Skills backbone: domain → task → skill → automation, rules-of-thumb badges | T-B2 |
| T-D3 | codex | acp | Receipts: daily Markdown receipts + Obsidian-compatible vault export job | — |
| T-G2 | codex | acp | Notifier on `needs_operator` / `settled` (ntfy topic via env, off by default) | — |
| T-C4 | claude | acp | Tiered fast path proposal (Tier 1/2/3 in front of missions) — docs only | T-C1 |
| T-E3 | codex | cockpit | OpenWiki trial on cockpit; weekly docs-PR workflow | — |
| T-F1 | claude | cockpit | Merge prep: secrets/PII audit + subtree dry-run branch (no merge, no visibility change) | — |
| T-G1 | claude | acp | Authenticated remote mode design addendum to the deployment ADR — docs only | — |
| T-D1 | codex | acp | Voice proposal + spike (Whisper/Kokoro on OCI) — docs + spike branch | — |
| T-C2 | owner | acp | K20 step 2: stored label + v2 shadow — needs corpus approval | T-C1 |

Each slice: branch `autopilot/<id>-<slug>`, PR into `autopilot/integration`, gate
`pnpm typecheck && pnpm test` (+ `pnpm lint`; web slices also `pnpm --filter @agent-plane/web build`),
verdict PASS/FAIL/BLOCKED/SKIP per `AGENTS.md`, then the lane merges its own green PR into
`autopilot/integration` with a **merge commit** (never squash).

## 6. Owner actions (cannot be automated)

- Approve/merge `autopilot/integration` → `main` after the week (one PR per repo, or cherry-pick).
- Decide Cockpit visibility for the merge (§4 stage 2).
- Approve the K20 corpus (`plans/k20-corpus-draft.md`) to unblock T-C2.
- Set `OPENROUTER_API_KEY` in the service env if Ox Alpha should stay enabled; otherwise disable it.
