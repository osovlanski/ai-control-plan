# Agentic OS — Design & Change Plan

**Status:** Proposed (plan only — no implementation in this document's branch)
**Builds on:** `docs/revised-architecture.md` (control plane, Phases 0–5 delivered) and the
`osovlanski/cockpit` repo (tooling manager, context compiler, lineage, memory garden — specs A–D implemented).
**Companion doc:** `docs/specs/E-agentic-os-role.md` in the cockpit repo (cockpit-side view of the same plan).
**Kernel services (M12–M15):** `docs/agentic-os-kernel-services.md` — model intelligence, scheduler, context lifecycle, runtime seam (2026-09-05).

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

### 3.1 Normative ownership and lifecycle invariants

These constraints are part of the architecture, not implementation guidance:

1. **A composition is an immutable revision.** A task may have several composition revisions:
   the initial run, parallel competitors, or a re-composition after failover. Every run points at
   exactly one revision. A revision snapshots asset IDs **and content digests**, the registry
   snapshot digest it was composed from, compiler version, rendered-bundle digest, policy revision
   and provisioning fidelity. An asset revision *is* its content digest — cockpit keeps no version
   history — so the control plane caches the exact content it composed with.
2. **The control plane owns run state and ephemeral files.** Cockpit owns machine-global inventory
   and config. Cockpit returns metadata and deterministic bundle content; it never accepts an
   arbitrary directory and writes into a control-plane worktree.
3. **Global config is never the silent fallback.** If requested isolation is unsupported, the
   CompositionDecision says so before execution and policy either rejects the run or explicitly
   permits an `ambient` fidelity tier.
4. **Failover is a new composition revision.** Cross-harness handoff revalidates asset
   compatibility, permissions, secrets, budget and bundle rendering for the destination. A
   same-provider resume reuses the original immutable profile unless an explicit re-composition
   is requested.
5. **All cross-repo writes are idempotent and authenticated.** Registry reads are versioned;
   usage postbacks have event IDs; retries cannot double count. Loopback is transport scope, not
   authentication.
6. **Assets and retrieved memory are untrusted inputs.** Lineage describes provenance/drift, not
   safety. Auto-attachment additionally requires an allowed content digest, compatible capability
   requirements and workspace policy approval; anything outside the allowlist needs an explicit
   one-click opt-in that pins the digest.
7. **Selection may correctly choose no optional assets.** Composition optimizes task fit and
   least privilege; it never attaches skills merely to satisfy a count.

### 3.2 AgentSpec — the immutable composition revision

A persisted, explainable and immutable description of the agent composed for one run or a set
of deliberately equivalent runs. This is to the Agentic OS what `RoutingDecision` is to the
control plane today — and it embeds one. `Task.agentSpecId` is therefore replaced by a run's
`compositionRevisionId`; the task may separately point at its latest recommended revision.

Two entities, not three: an **AgentSpec** row *is* the content of one composition revision
(`composition_revision_id` is its identity), and a **CompositionDecision** is that revision's
explanation. There is no separate CompositionRevision table.

```yaml
agent_spec:
  schema_version: 1
  composition_revision_id: CR-2001-1
  task_id: AG-2001
  intent:                      # stage-1 output; heuristic first, LLM-assist later
    kind: coding | planning | review | research | ops | content
    domains: [typescript, fastify]
    complexity: S | M | L
    risk: low | normal | high          # gates approval policy
  harness: claude-code | codex | cursor | bedrock      # stage-2 (existing router)
  model: { primary: ModelRef, fallbacks: [ModelRef], reasoning_effort?: low|med|high }
  registry: { snapshot_digest: sha256:..., observed_at: "...", stale: false }
  assets:                      # immutable refs, not mutable catalog pointers
    skills: [{ id, digest, source, lineage, allowlisted }]   # digest *is* the revision
    mcp_servers: [{ id, digest, tools_allowed: [...], secret_refs: [...] }]
    subagents: [{ id, digest }]
  context:                     # stage-4; rendered by the context compiler, per-run
    fragments: [typescript-style, repo:cockpit]
    memory_bundles: [{ id, digest, members: [{ path, digest }], reason: "linked from repo notes" }]
    rendered_system_prompt_ref: <blob>
    bundle_digest: sha256:...
    compiler: { version: 1, tokens: 8120, token_method: estimated, chars_per_token: 3.7 }
  policy:                      # stage-5
    permission: auto | prompt-on-escalation
    tool_allowlist: [...]
    budget: { max_tokens, max_cost_usd, max_runtime_ms }
  workspace: { repo, branch: task/AG-2001, worktree }
  provisioning: { requested: isolated, achieved: full|partial|ambient, profile_digest: sha256:... }
  explanation_ref: <CompositionDecision id>
```

**CompositionDecision** extends today's routing explanation object: for each stage it records
candidates considered, filters applied, what was chosen and why, and any user override —
rendered in the UI *before* start, exactly like the routing recommendation panel today.

### 3.3 Composer pipeline (stages)

1. **Intent classification** — v1 is the existing heuristic classifier (prompt + repo flags),
   extended with domain tagging from repo signals (languages, frameworks in the worktree).
   An optional cheap-LLM classifier slots in later behind the same interface; it must always
   be overridable and its output always shown.
2. **Harness + model selection** — the existing `route()` unchanged in contract; candidates
   widen from "assistant" to "assistant × model" where the manifest lists multiple models.
   All existing hard filters, profiles, cooldowns, and telemetry scoring apply as-is.
3. **Asset retrieval** — query the Asset Registry for skills/MCP/subagents matching the intent
   (tag match first; vector retrieval optional later). Apply hard filters before ranking:
   harness/model/OS compatibility, required binaries and secrets, conflicts, workspace policy and
   the content-digest allowlist; anything outside the allowlist requires an explicit opt-in that
   pins the digest. Lineage `clean` is useful provenance but is not a trust decision. Ranking is
   deterministic for equal inputs, records positive and negative evidence, and permits selecting
   no optional assets.
4. **Context assembly** — call the context compiler with the selected fragments + memory
   bundles and request a **per-run bundle** (system prompt / `CLAUDE.md` / `AGENTS.md`) instead
   of machine-global files. Cockpit returns content plus a manifest; the control plane writes it
   into its own worktree/profile. Rendering is budgeted against an *estimated* token count for
   the selected model — no exact local tokenizer exists for Claude or Codex, so the estimator's
   chars-per-token ratio is per-model config and the figure carries its method chip. Output is
   deterministic (no timestamps, hostnames or absolute paths) and records included and excluded
   fragments with reasons.
5. **Policy + budget** — from intent risk + workspace defaults (personal: broad auto-approve;
   work: prompt-on-escalation), plus per-task token/cost/runtime caps. Runtime enforcement exists;
   M2 adds explicit token/cost accounting semantics, including provider reports that arrive late
   or are cumulative, and defines cancel/overrun behavior when a hard cap cannot be exact.
6. **Explain + confirm** — persist the CompositionDecision; the UI shows the full spec with
   per-stage reasons; user can override any stage (recorded, feeds telemetry).

### 3.4 Provisioning (the adapter extension)

The one genuinely new adapter responsibility: start a run against a **generated profile**
without touching global config.

```ts
interface AgentAdapter {
  // ...existing six methods unchanged...
  /** Produce an inspectable plan without writing. */
  prepare?(spec: AgentSpec): Promise<ProvisioningPlan>;
  /** Atomically materialize an isolated profile owned by the control plane. */
  provision?(plan: ProvisioningPlan): Promise<ProvisionedProfile>;
  /** Prove the requested isolation/assets are effective before start(). */
  verify?(profile: ProvisionedProfile): Promise<ProvisioningVerification>;
  /** Idempotent cleanup after terminal run or retention expiry. */
  dispose?(profile: ProvisionedProfile): Promise<void>;
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
machine-global config; the OS composes ephemeral overlays. Applying a plan is atomic and
idempotent; generated files carry ownership metadata and never overwrite an unowned worktree
file. Secret values are resolved at launch and are neither stored in AgentSpec nor rendered to
disk. Profiles have a retention policy for same-provider resume and crash-safe garbage collection.

Adapters below `full` fidelity leave some machine-global config visible to the agent. Those runs
are recorded as `partial` or `ambient`, are policy-gated (invariant 3), are labelled in the
CompositionDecision and the UI, and are explicitly outside the "only its verified profile
visible" claim in §4's definition of done.

### 3.5 Asset Registry (cockpit becomes the OS package manager)

The Composer needs to query, not scrape. Cockpit gains a versioned loopback API behind a single
bearer token (or a Unix domain socket), exposing:

```text
GET /api/v1/registry/assets?kind=&assistant=&tag=
      → { schemaVersion, snapshotDigest, assets: [{ id, digest, kind, nativeKind,
           name, description, tags, targets, compatibility, requirements, conflicts,
           lineage, installedAt, lastUsedAt?, stats? }] }
GET /api/v1/registry/assets/:id/content    # current content only — no version history
GET /api/v1/registry/fragments/:name
GET /api/v1/registry/memory/bundles?repo=&tags=
GET /api/v1/registry/memory/findings       # garden output, machine-readable
```

Each list response is a **full snapshot** in deterministic order carrying a `snapshotDigest`.
For a single-user machine with a few hundred assets that is cheaper to build than incremental
sync and structurally cannot produce a mixed-snapshot composition; cursors, ETags and tombstones
are deferred until one response is measurably too large. Bounded payloads and structured errors
still apply. Cockpit stores no content history, so the control plane caches the bytes it composed
with — that, not a version-addressed endpoint, is what reproducibility requires.

The control plane's registry module federates this into its own catalog (cached, synced by the
existing daily sync), so the Composer works even when cockpit is briefly down, and the
Assistant Catalog UI can show "what this environment has installed" from real data instead of
the opaque `provider` bag. Workspace policy defines a maximum cache age; stale data is visible
in CompositionDecision and may block high-risk runs.

The reverse edge closes the learning loop: after each run the control plane POSTs per-asset
usage back as idempotent events (`eventId`, asset ID + digest, attached, invocation count,
observed outcome and attribution method). Cockpit stores operational usage separately from the
lineage ledger and joins by asset ID + digest; an event naming a digest that is no longer
installed is stored and displayed as such rather than quarantined. Attachment, invocation and
causal value remain distinct; telemetry must not claim that an attached asset caused success.

### 3.6 Memory Service

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

### 3.7 Economics Ledger (the dashboard's substrate)

One append-only logical ledger with one idempotent ingestion authority:

```text
UsageRecord   eventId, runId?, provider, sessionRef?, source, assistantId, model,
              accounting(delta|cumulative), tokensIn, tokensOut, cachedTokens,
              costUsd?, apiEquivalentUsd, pricingVersion, observedAt
SubscriptionPlan  provider, name, monthlyUsd, includedQuota, renewsAt
AssetUsage    eventId, assetId, assetDigest, runId, attached, invocationCount,
              outcome, attributionMethod, at
SavingsEstimate   runId|assetId, minutesSavedEstimate, method(model-estimate|user-set), at
```

- The control plane owns ingestion. Its `usage.updated` events are primary; cockpit's session
  parsers submit import events through the same idempotent boundary. Dedup keys include provider
  and session ref, and source precedence plus delta-vs-cumulative semantics are explicit.
  Cockpit appends import events to a local outbox and drains it when the control plane is
  reachable, so the dependency is not one-directional: cockpit keeps rebuildable local aggregates
  and never blocks on the plane, the mirror of M4's federated cache.
- `apiEquivalentUsd` prices subscription tokens at API list price — that single derived column
  powers "Tokens used $174 vs flat $240 → 0.7× ROI" and the tier advisor.
- "Skills saved $X" is explicitly an **estimate**: minutes-saved per run is model-estimated,
  labeled as such (the mockup's "AI-estimated, click to tune"), and user-tunable per asset.
  Net ROI = savings estimate − spend, always shown with its assumptions.

### 3.8 Operator UI (the shell)

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
| M0 | **Versioned contracts package** — schemas for `AgentSpec`, `CompositionDecision`, registry and telemetry plus OpenAPI | Independently versioned artifact consumed by both repos; generated types are convenience, JSON Schema/OpenAPI are the wire authority. No moving-branch git dependency |

### ai-control-plan

| # | Change | Builds on |
|---|---|---|
| M1 | Domain + migrations: immutable `AgentSpec` (the composition revision), `CompositionDecision`, `AssetUsage` tables, plus the idempotent `UsageRecord` ingestion boundary M11 posts into; Run gains `compositionRevisionId` | existing migration runner |
| M2 | **Composer module** (module #6) with the 6-stage pipeline; existing router called as stage 2 unchanged | router, classifier |
| M3 | Adapter prepare/provision/verify/dispose lifecycle for Claude and Codex; RunSpec gains an immutable verified profile | adapters, git worktrees |
| M4 | Registry federation: consume cockpit's registry API into the catalog; extend daily sync + CapabilityChange to assets | registry module |
| M5 | Context-bundle request path: Cockpit returns deterministic bundle content + manifest; control plane writes and owns it | M9 |
| M6 | Idempotent composition telemetry: distinguish attached/invoked/validated and observed outcome; shadow-score before affecting selection | telemetry |
| M7 | UI: New Task shows the full CompositionDecision (not just routing); Task Detail gains a "Composition" tab | existing panels |
| M12 | **Model Intelligence Service** — model catalog (capacity, pricing, capabilities) with provenance; task-dimension classification; assistant × model selection blending provider-official data, external benchmark priors (Artificial Analysis, LiveBench, BenchLM) and own telemetry, with telemetry weight `n/(n+k)` so personal evidence progressively dominates; recommendation persisted inside the routing explanation. Closes standing deferral #3 (pricing for bounded cost caps). Supersedes the "model-level auto-selection deferred indefinitely" entry in `plans/implementation-plan.md` (CR-17) | router, telemetry, `EvidenceSource`; design: `docs/agentic-os-kernel-services.md` §4.4 |
| M13 | **Deferred Execution / Scheduler** — one new task state `WAITING_RESOURCE` (CR-16) plus durable `WaitCondition` (time · quota · resource · dependency) and recurring `Schedule` templates; all-limited failover waits for the earliest reset instead of parking for a human; idle `QuotaProbe` per provider. Invariant I-S1: a scheduled task is **re-composed at wake**, never frozen to the assistant/model chosen when scheduled. Cockpit renders/creates; the plane owns semantics (CR-20) | cooldowns, quota snapshots, `failoverTask`, `jobs.ts` pattern; design: kernel-services §4.2 |
| M14 | **Context Lifecycle Manager** — per-session `ContextMeter` (provider-reported or estimated, capacity from provider or M12 catalog), `ContextPressureGuard` in the Harness with the ladder healthy → warn → prune → compact → verify → checkpoint + clean session; typed `context.*` events; never a blind clear; compaction never touches persisted history (I-C1). **Absorbs O10** (live gauge) as mandatory scope in `apps/web` and Cockpit. Harness path only | session-runner guards, checkpoint/handoff path; DeepSeek Harness compaction as reference; design: kernel-services §4.3 |
| M15 | **Runtime Backend seam** — `harness.runtime: native-sdk \| local-process \| herdr \| remote` typed on the manifest and reported on the result; `ProviderSessionDriver` named as the only launch path; a `RuntimeBackend` interface arrives only with its second implementation (herdr / remote are optional, on demonstrated need) | adapter manifest, session-runner; design: kernel-services §4.5 |

### cockpit

| # | Change | Builds on |
|---|---|---|
| M8 | **Versioned registry API** (`/api/v1/registry/...` above) over Installed + lineage + fragments + memory, with a bearer token, content digests and full-snapshot sync | installed/lineage/context modules |
| M9 | Context compiler: pure **per-run bundle target** returning selected content + manifest under an estimated-token budget | Spec B compiler |
| M10 | Accept idempotent per-asset usage events into an operational ledger; show attachment/invocation/outcome separately | Usage/Retro infrastructure |
| M11 | Usage unification: session parsers submit provider-qualified `UsageRecord` imports to the control-plane ingestion boundary, buffered through a local outbox | Usage/Retro tabs, M1's ingestion boundary |

**Definition of done for the mandatory core:** representative prompts produce fully explained,
immutable AgentSpecs (including a legitimate zero-optional-asset case); each run on a
full-fidelity adapter executes with only its verified profile visible, and partial/ambient runs
are labelled rather than silently accepted. Same-provider resume reuses the snapshot, while a simulated
cross-provider failover creates and explains a compatible new revision. Bundle/profile digests
make the run reproducible; duplicate telemetry delivery does not double count; observed asset
usage and validation outcome are queryable without claiming unsupported causal attribution.

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
| O9 | ~~Cheap-model **pre-flight**~~ — the model-selection half is **folded into M12** (a small model is an ordinary selection outcome); the "SDK-direct single-model run for non-repo tasks" half stays deferred (CR-27) | M12 |
| O10 | ~~Live context-window gauge per running agent~~ — **moved into M14 mandatory scope** (CR-27); listed here only so the numbering stays stable | M14 |
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
| **6 — Contracts, threat model & registry** | M0, M8, M4 | Versioned contract tests pass in both repos; catalog sync handles digests, deletions, auth and a stale cache |
| **7 — Bundles, Composer & provisioning** | M9, M5, M1, M2, M3, M7, M11 | Deterministic bundle and verified isolated profile; resume, failover and parallel-run lifecycle demonstrated; one deduped usage stream once M1's ingestion boundary exists |
| **7b — Kernel services** (may run in parallel with 7; **must close before 9**) | M13, M12 (catalog + priors), M14, M15 seam | "run tonight" / "continue when quota resets" / "run reviewer after implementation" work and re-compose at wake; a Harness run crossing 85 % context pressure compacts, re-measures and verifies, or continues clean from a checkpoint on the same model; `/api/models` lists capacity, price and benchmark priors with provenance; the live context gauge (ex-O10) is on |
| **8 — Learning loop & memory** | M6, M10, O6, M12 (blended selection) | Telemetry is idempotent; shadow scoring is inspectable; a stale memory bundle is visibly demoted without automatically changing production selection; per-model telemetry visibly overtakes benchmark priors as runs accumulate |
| **9 — Economics & insights** | O1–O4 | Dashboard matches mockups with honest chips; tier advice derived from real ledger (pricing from the M12 catalog, CR-19). **Does not start before 7b closes** — kernel services outrank dashboards |
| **10 — Depth** | O5, O7, O8, O9, O11, O12 | per feature |

Each phase is a vertical slice ending demonstrable, same discipline as Phases 0–5; no phase
starts until the previous one's success condition is shown live. Phases now span both repos
(M8–M11 are cockpit items): a phase closes only when both sides' slices are demonstrable.

## 7. Risks & open decisions

1. **Provisioning fidelity drift.** Per-run profiles depend on SDK/CLI surfaces (Claude
   `settingSources`, Codex `-c` overrides) that move. Mitigation: version-pin, probe in
   `describe()`, and keep the manifest honest (`provisioning: full|partial|none`) so the
   Composer degrades to "ambient config" explicitly rather than silently.
2. **Registry availability coupling.** The Composer must not hard-depend on cockpit being up:
   federated cache in the control plane (M4) is mandatory, not an optimization. The reverse edge
   is symmetric — cockpit's importer and postback receiver buffer locally rather than blocking on
   the plane (§3.7).
3. **Third-party asset safety.** Trends-scan skills are third-party code now being
   *auto-attached* to agents. Content-digest allowlisting, explicit opt-in for anything outside
   the allowlist, compatibility checks and workspace policy are the security boundary and must be enforced in
   the Composer, not the UI; `lineage: clean` alone never authorizes attachment.
4. **Economics honesty.** ROI numbers built on estimated minutes-saved can rot into fiction.
   Every derived figure carries its method chip (`guessed` / `estimated` / `measured`) end to
   end — the mockups already gesture at this; make it a schema field, not a CSS class.
5. **Double counting** during the M11 transition — dedup by provider session ref must land
   with the importer, not after.
6. **Scope creep via the dashboard.** The nine cards are queries, not subsystems. Any card
   needing a new store beyond §3.7 gets deferred, not grown.
7. **Open decisions to make before Phase 7:** (a) contracts artifact distribution and release
   process (private registry vs pinned release artifact; never a moving branch); (b) embedding runtime for O7 (local model vs API — privacy default
   says local); (c) whether stage-1 LLM assist (O8) is worth its per-task cost, decided by
   measuring heuristic misroutes first; (d) single-port Operator UI now vs linked shells.
8. **Composition reproducibility.** Mutable catalog IDs make old decisions impossible to audit.
   Mitigation: snapshot content/bundle/profile digests on every AgentSpec revision, and cache the
   composed content locally, since cockpit keeps no version history.
9. **Failover/profile mismatch.** A profile composed for Claude may be invalid or unsafe in
   Codex. Mitigation: cross-harness failover always recomposes and verifies; it never translates
   silently or reuses an incompatible overlay.
10. **Filesystem and secret leakage.** A remote compiler writing caller-selected paths or a
    generated MCP file containing credentials breaks the ownership boundary. Mitigation: Cockpit
    returns content only; the control plane writes bounded paths and resolves secret references
    in memory at launch.
11. **False attribution.** Successful runs with attached assets do not prove those assets helped.
    Mitigation: distinguish attached, invoked and validated outcomes; begin with shadow scoring,
    expose the attribution method and require stronger evidence before automatic ranking changes.

## 8. Revision notes

### 2026-09-05 — kernel services (M12–M15)

- Added M12 Model Intelligence, M13 Scheduler, M14 Context Lifecycle, M15 Runtime seam to §4;
  architecture, types, state transitions, API and acceptance live in
  `docs/agentic-os-kernel-services.md` (single source; this table only sequences them).
- Moved O10 into M14 and folded O9's selection half into M12.
- Inserted Phase 7b ahead of Phase 9: kernel services before economics/dashboards.
- Recorded conflict decisions CR-16…CR-29 (one new task state; model-level selection no longer
  deferred; profiles become dimension presets; plane catalog owns pricing; Cockpit Schedule tab
  stays, reads plane schedules; herdr/dsh optional, never mandatory).
- Increments 14–17 in `docs/agentic-os-vnext-plan.md` §10 carry the delivery slices (K1–K16).

### 2026-08-26 — contract and lifecycle hardening

- Replaced task-level mutable AgentSpec linkage with immutable per-run CompositionRevisions.
- Stated resume, failover and parallel-run rules as invariants, with profile retention and GC.
- Strengthened registry versioning, compatibility, trust, authentication and idempotency.
- Moved worktree writes to the control plane and made Cockpit's bundle API pure.
- Corrected the M5/M9 phase dependency and removed the artificial two-skill acceptance target.
- Defined conservative telemetry semantics before economics or learning influences selection.

### 2026-08-26 — review pass: scope trim and gap fixes

- Collapsed `CompositionRevision` into `AgentSpec`; an asset revision is its content digest.
- Dropped cursors, ETags, tombstones, dual credentials and the version-history content endpoint:
  one consumer on one machine, and a full snapshot cannot go mixed.
- Removed `security_review_id` — neither repo has a producer for it. The digest allowlist plus
  explicit opt-in is the gate until security review has an owner.
- Gave M11 an ingestion boundary to post into (M1), moved it to Phase 7, and added cockpit's
  outbox so the availability coupling runs both ways.
- Fixed the stale `AssetUsage` ledger row, the local-tokenizer promise, and the contradiction
  between ambient fidelity and the isolation claim.
