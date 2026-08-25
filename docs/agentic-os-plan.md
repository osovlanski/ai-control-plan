# Agentic OS — Design & Change Plan

**Status:** Proposed (plan only — no implementation in this document's branch)
**Builds on:** `docs/revised-architecture.md` (control plane, Phases 0–5 delivered) and the
`osovlanski/cockpit` repo (tooling manager, context compiler, lineage, memory garden — specs A–D implemented).
**Companion doc:** `docs/specs/E-agentic-os-role.md` in the cockpit repo (cockpit-side view of the same plan).

---

## 1. Vision — what "Agentic OS" adds

Today the two repos split the problem in half:

- **ai-control-plan** answers *"which existing assistant environment should run this prompt?"*
  It routes between **fixed** environments (Claude Code, Codex, Cursor, Bedrock as they are
  configured on the machine), observes execution, checkpoints, and hands off.
- **cockpit** answers *"what tooling do my assistants have, where did it come from, and is it healthy?"*
  It manages the **inventory** — skills, rules, agents, hooks, MCP servers, context fragments,
  memory — but never participates in running a task.

The Agentic OS closes the loop between them:

> **For a given user prompt, the system *composes* the agent that should exist for that task —
> the right harness, the right LLM, the right skills/tools/MCP servers, the right context and
> memory — provisions it, runs it, observes it, and learns from the outcome.**

The conceptual shift is from **routing to a static environment** to **composing a per-task agent
from an inventory of capabilities**. Everything already built remains load-bearing:

| OS concept | Already exists as | Becomes |
|---|---|---|
| Kernel (scheduling, processes, syscalls) | control plane: tasks, runs, 9-state machine, normalized events, checkpoints, handoff, failover | unchanged core; gains a Composer stage |
| Drivers | `AgentAdapter` (Claude, Codex, Cursor, Bedrock, Fake) | same contract + a `provision()` extension |
| Package manager + registry | cockpit: Installed tab, library repo, lineage ledger, trends-scan proposals | the OS **Asset Registry** the Composer draws from |
| Filesystem / config compiler | cockpit Context tab (fragments → `CLAUDE.md`/`AGENTS.md`/`.mdc`/copilot) | gains a **per-run bundle** render target |
| Memory subsystem | cockpit memory graph + Garden findings | the **Memory Service** feeding context bundles |
| Accounting | control-plane usage events + cockpit Usage/Retro tabs | unified **Economics Ledger** (cost, ROI, tier advice) |
| Shell / desktop | control-plane web UI + cockpit tabs | one **Operator UI** (the dashboard in the mockups) |

## 2. Current state and the gap

**What ai-control-plan already proves** (Phases 0–5, live-verified 2026-08-22):
prompt → explainable route → execute via adapter → normalized event timeline → checkpoint →
cross-provider handoff, automatic quota failover, parallel compare/race in worktrees, and
telemetry-fed routing profiles. Domain model: Assistant, Task, Run, Event, Checkpoint, Handoff,
RoutingDecision, QuotaSnapshot, CapabilityChange.

**What cockpit already proves:** a queryable inventory of every installed item across
`~/.claude` / `~/.cursor` / `~/.codex` with provenance (lineage.json: clean / edited /
update-available / forked / orphaned), a fragment-based context compiler with drift detection,
a daily discovery pipeline (trends scan → proposals), a memory graph with health findings
(ghost / orphan / stale / duplicate / oversized), per-session usage and cost aggregates, and
local + cloud scheduling.

**The gap — five missing pieces:**

1. **No shared contract.** The control plane's `CapabilityManifest.provider` bag *mentions*
   skills/plugins/MCP but nothing structured connects it to cockpit's inventory or lineage.
2. **No composition step.** The router picks an assistant; nothing picks *which subset* of
   skills, MCP servers, context fragments, and memory a task should get. Every run inherits
   whatever happens to be globally installed — maximal context, zero task fit.
3. **No provisioning.** Adapters start sessions against the machine's ambient config
   (`~/.claude`, `~/.codex`). There is no way to start a run with a *generated* profile
   (selected skills only, a composed system prompt, a scoped MCP list) without mutating
   global state.
4. **No memory-in-the-loop.** The memory graph is a viewer/gardener; no run consumes a
   memory bundle at start or writes structured memory back at checkpoint.
5. **No unified economics.** Usage is counted twice in two shapes (control-plane `usage.updated`
   events vs cockpit session parsing); neither can answer the dashboard questions
   (net ROI, subscription vs API-equivalent, tier advice, skill payback).

## 3. Target architecture

```text
┌──────────────────────────── Operator UI (shell) ─────────────────────────────┐
│ New Task · Task Board · Task Detail · Catalog · Dashboard (ROI/insights)     │
│ Installed · Context · Proposals · Memory/Garden · Schedule · Logs            │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTP + SSE
┌───────────────▼──────────────── Agentic OS core ─────────────────────────────┐
│                                                                              │
│  intake ─▶ COMPOSER ──────────────▶ orchestrator ─▶ adapters (drivers)       │
│            │ 1 classify intent          │              claude · codex ·      │
│            │ 2 select harness+model     │              cursor · bedrock      │
│            │   (existing router,        │                 │                  │
│            │    now a stage)            │            provision(spec):        │
│            │ 3 retrieve assets ◀──────┐ │            per-run profile dir,    │
│            │ 4 assemble context bundle│ │            settings, MCP config    │
│            │ 5 set policy + budget    │ │                                    │
│            │ 6 explain (Composition-  │ └─▶ events ─▶ checkpoints ─▶ handoff │
│            │   Decision, persisted)   │         │                            │
│            ▼                          │         ▼                            │
│        AgentSpec (per task)           │   TELEMETRY ─▶ Economics Ledger      │
│                                       │   (composition outcomes,            │
│  ┌────────────────────────────────────┴──  skill attribution, cost)         │
│  │ ASSET REGISTRY (fed by cockpit)                                          │
│  │  skills · agents · hooks · MCP servers · context fragments ·             │
│  │  memory bundles — each with lineage status + usage stats                 │
│  └─────────────▲───────────────────────────▲─────────────────────────────── │
└────────────────┼───────────────────────────┼─────────────────────────────────┘
        cockpit inventory + lineage    Memory Service
        (library repo, proposals,      (graph + garden + optional
         context fragments)             vector indexes)
```

One instance per machine stays the workspace/isolation model. Nothing in the Phases 0–5
kernel is discarded; the Composer is inserted **between intake and the orchestrator**, and the
existing router becomes stage 2 of it.

### 3.1 AgentSpec — the central new artifact

A persisted, explainable description of the agent composed for one task. This is to the
Agentic OS what `RoutingDecision` is to the control plane today — and it embeds one.

```yaml
agent_spec:
  task_id: AG-2001
  intent:                      # stage-1 output; heuristic first, LLM-assist later
    kind: coding | planning | review | research | ops | content
    domains: [typescript, fastify]
    complexity: S | M | L
    risk: low | normal | high          # gates approval policy
  harness: claude-code | codex | cursor | bedrock      # stage-2 (existing router)
  model: { primary: ModelRef, fallbacks: [ModelRef], reasoning_effort?: low|med|high }
  assets:                      # stage-3; every ref carries lineage status at compose time
    skills: [{ id, source: library|local, lineage: clean|edited|... }]
    mcp_servers: [{ id, scope: [tools allowed] }]
    subagents: [{ id }]
  context:                     # stage-4; rendered by the context compiler, per-run
    fragments: [typescript-style, repo:cockpit]
    memory_bundles: [{ id, files: [...], reason: "linked from repo notes" }]
    rendered_system_prompt_ref: <blob>
  policy:                      # stage-5
    permission: auto | prompt-on-escalation
    tool_allowlist: [...]
    budget: { max_tokens, max_cost_usd, max_runtime_ms }
  workspace: { repo, branch: task/AG-2001, worktree }
  explanation_ref: <CompositionDecision id>
```

**CompositionDecision** extends today's routing explanation object: for each stage it records
candidates considered, filters applied, what was chosen and why, and any user override —
rendered in the UI *before* start, exactly like the routing recommendation panel today.

### 3.2 Composer pipeline (stages)

1. **Intent classification** — v1 is the existing heuristic classifier (prompt + repo flags),
   extended with domain tagging from repo signals (languages, frameworks in the worktree).
   An optional cheap-LLM classifier slots in later behind the same interface; it must always
   be overridable and its output always shown.
2. **Harness + model selection** — the existing `route()` unchanged in contract; candidates
   widen from "assistant" to "assistant × model" where the manifest lists multiple models.
   All existing hard filters, profiles, cooldowns, and telemetry scoring apply as-is.
3. **Asset retrieval** — query the Asset Registry for skills/MCP/subagents matching the intent
   (tag match first; vector retrieval optional later). Hard rules: an asset with lineage
   `orphaned` or `update-available` past a staleness threshold is flagged in the explanation;
   third-party assets accepted from the trends scan are only auto-attached if their lineage is
   `clean` and they are on the workspace allowlist — otherwise they require a one-click opt-in.
4. **Context assembly** — call the context compiler with the selected fragments + memory
   bundles and render a **per-run bundle** (system prompt / `CLAUDE.md` / `AGENTS.md` for the
   task worktree) instead of the machine-global files. Size-budgeted: the compiler already
   knows fragment priorities; the Composer gives it a token budget and it renders in priority
   order, recording what was cut.
5. **Policy + budget** — from intent risk + workspace defaults (personal: broad auto-approve;
   work: prompt-on-escalation), plus per-task cost/runtime caps that the orchestrator's
   existing runtime-cap and limit-monitor machinery enforces.
6. **Explain + confirm** — persist the CompositionDecision; the UI shows the full spec with
   per-stage reasons; user can override any stage (recorded, feeds telemetry).

### 3.3 Provisioning (the adapter extension)

The one genuinely new adapter responsibility: start a run against a **generated profile**
without touching global config.

```ts
interface AgentAdapter {
  // ...existing six methods unchanged...
  /** Materialize the spec's assets into an isolated, disposable profile for this run.
      Returns what start() needs. Throws NotSupportedError per-capability, honestly. */
  provision?(spec: AgentSpec): Promise<ProvisionedProfile>;
}
```

Per adapter, honestly tiered like everything else in the manifest:

| Adapter | Provisioning mechanism | Fidelity |
|---|---|---|
| Claude | Agent SDK options: `systemPrompt`, per-run `settingSources`/settings dir, explicit `mcpServers`, skills via a per-run `.claude` profile dir in the worktree | full |
| Codex | per-run `AGENTS.md` in the worktree + config profile (`-c` overrides), scoped MCP config | high |
| Cursor | per-run `.cursor/rules/*.mdc` in the worktree | partial (rules only) |
| Bedrock | none — deployed agents are pre-composed; the Composer can only *select* among them | select-only |

Rule: provisioning writes **only inside the task worktree or a per-run temp profile dir** —
never into `~/.claude` / `~/.codex` / `~/.cursor`. Cockpit remains the sole writer of the
machine-global config; the OS composes ephemeral overlays.

### 3.4 Asset Registry (cockpit becomes the OS package manager)

The Composer needs to query, not scrape. Cockpit gains a read API (loopback, same trust model
as its UI) — or, minimally, a versioned file contract — exposing:

```text
GET /api/registry/assets?kind=skill|agent|hook|mcp|fragment&assistant=&tag=
      → [{ id, kind, name, description, tags, targets, lineage: {status, sourceUrl, stars},
           installedAt, lastUsedAt?, stats?: { runs, tokensMedian, successRate } }]
GET /api/registry/fragments/:name          # raw fragment for the context compiler
GET /api/registry/memory/bundles?repo=&tags=
GET /api/registry/memory/findings          # garden output, machine-readable
```

The control plane's registry module federates this into its own catalog (cached, synced by the
existing daily sync), so the Composer works even when cockpit is briefly down, and the
Assistant Catalog UI can show "what this environment has installed" from real data instead of
the opaque `provider` bag.

The reverse edge closes the learning loop: after each run the control plane POSTs per-asset
usage back (`skill X attached, invoked N times, task succeeded, tokens/cost share`), which
cockpit stores next to lineage — this is the ground truth behind "which skills actually pay."

### 3.5 Memory Service

- **Read path (compose time):** memory bundles are selected by repo + tag + graph proximity
  (files linked from the repo's notes), filtered by Garden health — `stale`/`duplicate`
  findings demote a bundle and the demotion is visible in the CompositionDecision
  ("excluded `video-scripts`: stale 18d"). This is the "is the model on stale docs?" card
  made operational rather than decorative.
- **Write path (checkpoint time):** the checkpoint assembler already digests activity; add an
  optional structured step that proposes memory writes (decisions made, gotchas found) into a
  **proposals inbox for memory** — same accept/reject UX as trends proposals. Never
  auto-write memory; the Garden's whole value is that memory stays curated.
- **Vector indexes (optional):** per-workspace embedding index over memory + repo docs to
  power stage-3/4 retrieval and the Knowledge tab; the 3D graph mockup's "vector index" nodes
  visualize these. Pure enhancement — tag/graph retrieval must work without it.

### 3.6 Economics Ledger (the dashboard's substrate)

One append-only store, one writer path:

```text
UsageRecord   runId?, sessionRef?, source(plane|cockpit-import), assistantId, model,
              tokensIn, tokensOut, cachedTokens, costUsd?, apiEquivalentUsd, at
SubscriptionPlan  provider, name, monthlyUsd, includedQuota, renewsAt
AssetUsage    assetId, runId, invoked, outcome, at
SavingsEstimate   runId|assetId, minutesSavedEstimate, method(model-estimate|user-set), at
```

- The control plane's `usage.updated` events are the primary source; cockpit's session
  parsers (Claude/Codex logs) become **importers** into the same store with dedup by session
  ref — ending the double-count.
- `apiEquivalentUsd` prices subscription tokens at API list price — that single derived column
  powers "Tokens used $174 vs flat $240 → 0.7× ROI" and the tier advisor.
- "Skills saved $X" is explicitly an **estimate**: minutes-saved per run is model-estimated,
  labeled as such (the mockup's "AI-estimated, click to tune"), and user-tunable per asset.
  Net ROI = savings estimate − spend, always shown with its assumptions.

### 3.7 Operator UI (the shell)

Merge direction (recommendation, see §6): the control-plane web app absorbs cockpit's tabs
over time; until then, one shared header/nav shell links the two locally. Target screens
beyond what exists:

- **Dashboard ("Today at a glance")** — Spent on AI · Skills Saved · Net ROI cards; the
  subscriptions vs tokens toggle; period switcher (today / 7d / 28d).
- **Insight cards** (the nine-questions grid — each a query over the ledgers, each with an
  honesty chip): monthly cost (`guessed` where costUsd missing) · where to save (top spend
  clusters vs outcomes) · revenue/ROI (`blind` until SavingsEstimate is tuned) · live context
  window per running agent (from usage events) · which skills pay (AssetUsage × Savings) ·
  stale memory (Garden) · right tier (apiEquivalent vs plans) · automation candidates
  (repeated similar prompts/sessions → propose a skill or a scheduled job) · new-tool radar
  (trends scan ranked by fit to *your* usage).
- **Builder profile quadrant** — plots the user's own volume × subscription/API mix against
  archetypes; the tier advisor's visual.
- **Named agents** — a saved AgentSpec becomes a reusable, named agent ("Hermes-agent"):
  pin composition, still re-validated per run (lineage, auth, quota).

## 4. Mandatory changes

The minimum set to *be* an Agentic OS (prompt → composed agent → provisioned run → learning
loop), in dependency order.

### Shared (new)

| # | Change | Notes |
|---|---|---|
| M0 | **Contracts package** — `AgentSpec`, `CompositionDecision`, `AssetRef`+lineage enum, `UsageRecord`, registry API types | Single source of truth both repos consume. Lives in `ai-control-plan/packages/contracts`; cockpit consumes it (git dep or published private pkg) |

### ai-control-plan

| # | Change | Builds on |
|---|---|---|
| M1 | Domain + migrations: `AgentSpec`, `CompositionDecision`, `AssetUsage` tables; Task gains `agentSpecId` | existing migration runner |
| M2 | **Composer module** (module #6) with the 6-stage pipeline; existing router called as stage 2 unchanged | router, classifier |
| M3 | Adapter `provision()` for Claude and Codex (per-run profile dir + worktree files); RunSpec gains `profile` | adapters, git worktrees |
| M4 | Registry federation: consume cockpit's registry API into the catalog; extend daily sync + CapabilityChange to assets | registry module |
| M5 | Context-bundle request path: call cockpit's compiler for per-run rendering (or vendor the render fn via contracts pkg) | — |
| M6 | Composition telemetry: per-asset attribution on run end → POST back to cockpit; extend the Phase-5 scorer to read it | telemetry |
| M7 | UI: New Task shows the full CompositionDecision (not just routing); Task Detail gains a "Composition" tab | existing panels |

### cockpit

| # | Change | Builds on |
|---|---|---|
| M8 | **Registry read API** (`/api/registry/...` above) over Installed + lineage + fragments + memory | installed/lineage/context modules |
| M9 | Context compiler: **per-run bundle target** — render selected fragments to a caller-supplied dir with a token budget, no drift-tracking (ephemeral) | Spec B compiler |
| M10 | Accept per-asset usage postbacks; store next to lineage; show "used N times / last outcome" in Installed | lineage ledger |
| M11 | Usage unification: session parsers write `UsageRecord`s (dedup by session ref) instead of a private shape | Usage/Retro tabs |

**Definition of done for the mandatory core:** one prompt entered in the UI produces a fully
explained AgentSpec (harness, model, 2+ selected skills, scoped MCP list, composed context
bundle with a memory file, budget); the run executes in a worktree with **only** that profile
visible to the agent; on completion, per-asset usage appears in cockpit's Installed tab and
the composition outcome is queryable for the scorer.

## 5. Optional changes (features from the mockups)

None block the core; each lists its prerequisite.

| # | Feature | Needs |
|---|---|---|
| O1 | Economics dashboard (3 cards + subscription/token toggle + periods) | M11 + SubscriptionPlan config |
| O2 | Nine insight cards (each independently shippable; automation-candidates and new-tool-radar are the two with real new logic) | O1; trends scan (exists) |
| O3 | Tier advisor + builder-profile quadrant | O1 |
| O4 | Skill ROI ("which skills pay") with tunable minutes-saved | M10 + SavingsEstimate |
| O5 | Named/persistent agents (saved AgentSpecs, the "installed agents" rail) | M2 |
| O6 | Memory write-back proposals at checkpoint | M2, checkpoint assembler |
| O7 | Vector indexes + retrieval for stage 3/4; 3D memory graph upgrade (current graph is 2D force-directed) | M8; embedding runtime choice |
| O8 | LLM-assisted intent classifier (stage 1 upgrade) | M2; budget it, cache it |
| O9 | Cheap-model **pre-flight** ("route small prompts to a small model entirely") — extends stage 2 candidates with SDK-direct single-model runs for non-repo tasks | M2, M3 |
| O10 | Live context-window gauge per running agent | usage events (exist) — mostly UI |
| O11 | Cursor/Bedrock provisioning (partial by design) | M3 pattern |
| O12 | Personal integrations (Gmail/Calendar/Drive/Notion) as first-class MCP assets in the registry | M4, M8 |

## 6. Repo & delivery strategy

**Recommendation: keep two repos through M0–M11, converge afterward.**

- The contracts package (M0) removes the drift risk that is the real argument for merging.
- Cockpit's value as the machine-global config owner + scraper of `~/.claude`/`~/.codex` is
  orthogonal to the kernel and iterates on a different rhythm (daily scans, UI-heavy).
- Revisit after the mandatory core ships: the likely end state is cockpit's server folding
  into the ai-control-plan monorepo as `apps/registry`, and one Operator UI. Deciding that
  now would stall both repos on a migration nobody needs yet.

**Phasing (continues the existing numbering):**

| Phase | Content | Success condition |
|---|---|---|
| **6 — Contracts & registry** | M0, M8, M4, M11 | Control-plane catalog lists every cockpit asset with lineage; one deduped UsageRecord stream |
| **7 — Composer & provisioning** | M1, M2, M3, M5, M7 | The §4 definition-of-done demo, minus learning |
| **8 — Learning loop & memory** | M6, M9 (if not pulled into 7), M10, O6 | Composition scorer demonstrably prefers assets with better outcomes; a stale memory bundle is visibly demoted |
| **9 — Economics & insights** | O1–O4, O10 | Dashboard matches mockups with honest chips; tier advice derived from real ledger |
| **10 — Depth** | O5, O7, O8, O9, O11, O12 | per feature |

Each phase is a vertical slice ending demonstrable, same discipline as Phases 0–5; no phase
starts until the previous one's success condition is shown live.

## 7. Risks & open decisions

1. **Provisioning fidelity drift.** Per-run profiles depend on SDK/CLI surfaces (Claude
   `settingSources`, Codex `-c` overrides) that move. Mitigation: version-pin, probe in
   `describe()`, and keep the manifest honest (`provisioning: full|partial|none`) so the
   Composer degrades to "ambient config" explicitly rather than silently.
2. **Registry availability coupling.** The Composer must not hard-depend on cockpit being up:
   federated cache in the control plane (M4) is mandatory, not an optimization.
3. **Third-party asset safety.** Trends-scan skills are third-party code now being
   *auto-attached* to agents. The lineage gate in stage 3 (clean + allowlisted, else opt-in)
   is a security boundary and must be enforced in the Composer, not the UI.
4. **Economics honesty.** ROI numbers built on estimated minutes-saved can rot into fiction.
   Every derived figure carries its method chip (`guessed` / `estimated` / `measured`) end to
   end — the mockups already gesture at this; make it a schema field, not a CSS class.
5. **Double counting** during the M11 transition — dedup by provider session ref must land
   with the importer, not after.
6. **Scope creep via the dashboard.** The nine cards are queries, not subsystems. Any card
   needing a new store beyond §3.6 gets deferred, not grown.
7. **Open decisions to make before Phase 7:** (a) contracts distribution (workspace path dep
   vs published package); (b) embedding runtime for O7 (local model vs API — privacy default
   says local); (c) whether stage-1 LLM assist (O8) is worth its per-task cost, decided by
   measuring heuristic misroutes first; (d) single-port Operator UI now vs linked shells.
