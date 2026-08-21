# Revised Architecture — AI Agent Control Plane

**Status:** Proposed (accepted output of `docs/architecture-review.md`)
**Scope principle:** the smallest architecture that proves `prompt → route → execute → observe → checkpoint → handoff`, with seams left where deferred features re-enter without remodeling.

---

## 1. Topology

**One control-plane instance per machine. A workspace is an instance.**

```text
┌─────────────────────── personal Mac ────────────────────────┐
│  Web UI (React/Vite, localhost)                             │
│        │ HTTP + SSE                                         │
│  ┌─────▼──────────────────────────────────────────┐         │
│  │ Control Plane (Node/TS, Fastify, one process)  │         │
│  │                                                │         │
│  │  api ── router ── orchestrator ── registry     │         │
│  │              └──────┬──────┘                   │         │
│  │                   tasks                        │         │
│  │                     │                          │         │
│  │              SQLite (one file per workspace)   │         │
│  └───────┬───────────────────────┬────────────────┘         │
│          ▼                       ▼                          │
│   ClaudeAdapter            CodexAdapter                     │
│   (Claude Agent SDK)       (@openai/codex-sdk)              │
│          │                       │                          │
│   local CLI auth,          local CLI auth,                  │
│   repos, MCP, skills       repos, MCP                       │
└─────────────────────────────────────────────────────────────┘

Work machine: identical stack, its own config dir + DB,
plus CursorAdapter (agent CLI) and BedrockAdapter (AgentCore) in Phase 4.
```

- Credentials never leave the machine (each provider's own CLI/SDK auth is used in place; the plane stores **no** provider secrets).
- Cross-workspace handoff is impossible by construction — the instances share nothing.
- UI binds to `127.0.0.1` by default.
- A future remote runner, if ever needed, is a `RemoteAdapter` proxying this same adapter contract over authenticated HTTP — no domain-model change.

## 2. Modules (modular monolith, 5 modules)

| Module | Owns | Key contents |
|---|---|---|
| `registry` | assistant instances + capability manifests + sync | `describe()` cache, daily/on-demand sync, capability diff feed, quota snapshots |
| `tasks` | TaskEnvelope + lifecycle + task files | envelope CRUD, state machine, `progress.md`/`handoff.md` rendering, decision log |
| `router` | selection | hard filters, profile rules, explanation objects, cooldowns |
| `orchestrator` | runs | adapter invocation, event ingestion/persistence, limit monitoring, checkpoint assembly, handoff, failover, crash reconciliation |
| `api` | HTTP + SSE | REST endpoints, SSE fan-out, approval round-trips |

Module boundaries match the original plan's service boundaries, so later extraction is possible — but there are no network hops between them now.

## 3. Domain model (entities)

```text
Assistant            id, provider, tier, enabled, manifest (JSON), manifestUpdatedAt
CapabilityChange     assistantId, field, old, new, source, observedAt        # feeds "what changed" UI
QuotaSnapshot        assistantId, window, usedPercent, resetsAt, source, observedAt

Task                 id, goal, constraints(JSON), repoPath, branch, state, activityPhase,
                     profile, createdAt, updatedAt
TaskDecision         taskId, text, madeBy(user|agent:<assistantId>), at
RoutingDecision      taskId, chosenAssistantId, explanation(JSON), at

Run                  id, taskId, assistantId, providerSessionRef, state, startedAt, endedAt,
                     usage(JSON)                                             # one Task has 1..n Runs
Event                id, runId, seq, ts, type, phase?, summary, payload(JSON), raw(JSON)  # append-only
Checkpoint           id, taskId, runId, envelopeSnapshot(JSON), gitRef, diffStat, reason, at
Handoff              id, taskId, fromRunId, toRunId, checkpointId, trigger(manual|quota|failure), at
```

Notes:
- **Task 1..n Runs** is the load-bearing relationship: failover/handoff = end run A, checkpoint, start run B on the same task.
- `Event.raw` preserves the provider payload; normalization is lossy, deletion is not.
- Materialized task state lives on `Task`/`Run`; the `Event` table is the audit/history source. Retention: compress/archive events of tasks completed >30 days.

## 4. AgentAdapter contract

```ts
interface AgentAdapter {
  readonly id: AssistantId;

  /** Full capability manifest. Called by registry sync, cached. */
  describe(): Promise<CapabilityManifest>;

  /** Start a fresh provider session for this run. */
  start(run: RunSpec): Promise<RunHandle>;

  /** Same-provider continuation. Throws NotSupportedError if !manifest.core.canResume. */
  resume(ref: ProviderSessionRef, run: RunSpec): Promise<RunHandle>;

  /** Normalized events; adapter maps provider stream in place. Ends when the run ends. */
  events(handle: RunHandle): AsyncIterable<NormalizedEvent>;

  /** Mid-run user input / approval responses. Optional capability. */
  send?(handle: RunHandle, input: RunInput): Promise<void>;

  cancel(handle: RunHandle): Promise<void>;
}

interface CapabilityManifest {
  core: {                       // what the ROUTER reads — uniform across providers
    models: ModelRef[];
    canResume: boolean;
    canMcp: boolean;
    supportsMidRunInput: boolean;
    reportsUsage: boolean;
    reportsLimits: boolean;
    execution: { shell: boolean; filesystem: boolean; web: TriState };
    auth: { state: "ok" | "expired" | "missing"; account?: string };
    limits?: QuotaSnapshot[];   // best-effort pre-routing view
  };
  provider: Record<string, unknown>;  // typed per adapter: skills/plugins (Claude),
                                      // sandbox config (Codex), rules (Cursor),
                                      // deployed agents + IAM (Bedrock). CATALOG UI only.
  evidence: { source: "runtime-probe"|"provider-api"|"local-config"|"manual"; observedAt: string };
}

interface RunSpec {
  taskId: string;
  prompt: string;              // rendered from TaskEnvelope (fresh-start or handoff template)
  workdir: string;             // task branch / worktree path
  model?: ModelRef;
  permissionPolicy: PermissionPolicy;   // maps to SDK permission modes; escalations → approval.requested
  env: { redactionRules: RedactionRule[]; maxRuntimeMs: number };
}
```

`NormalizedEvent.type` (closed set, v1):

```text
run.started | run.ended
message                      # assistant-visible output text
phase                        # informational: planning|editing|testing|reviewing (annotation, never a trigger)
tool.started | tool.completed | tool.failed
file.changed                 # path + change kind (+ diff ref when cheap)
test.result                  # summary counts + failures
approval.requested           # blocks until api relays the user's answer (or policy auto-answers)
usage.updated                # tokens, and quota % / resets_at when the provider reports them
limit.approaching | limit.hit
error
```

Adapter implementations:

| Adapter | Underlying | Notes |
|---|---|---|
| `ClaudeAdapter` | Claude Agent SDK (TS) | session resume, permission modes, hooks; usage from SDK messages; richest `provider` bag (skills/plugins/MCP) |
| `CodexAdapter` | `@openai/codex-sdk` | thread resume; `token_count.rate_limits` → `usage.updated`/`limit.approaching` (`used_percent`, `resets_at`) |
| `CursorAdapter` (P4) | `agent` CLI, `-p --output-format json`, version-pinned | thinner events; resume by chat id; fail loud on schema drift |
| `BedrockAdapter` (P4) | AgentCore `InvokeAgentRuntime` (streaming) | wraps *configured, already-deployed* agents; manifest from registry config + IAM check, not discovery |

## 5. Orchestration state machine (authoritative, 9 states)

```text
CREATED → ROUTING → RUNNING ⇄ WAITING_INPUT
                      │  │
                      │  ├→ LIMIT_PAUSED → HANDING_OFF → RUNNING (new Run)
                      │  │        └────────── (no eligible target) → WAITING_INPUT
                      ├→ COMPLETED
                      ├→ FAILED
                      └→ CANCELLED           (cancel valid from any non-terminal state)
```

- Every transition has an unambiguous trigger (adapter event, user action, or policy timer). Activity phases (`planning/testing/...`) are display-only annotations on events.
- **Crash recovery:** on boot, orchestrator reconciles tasks in `RUNNING`: provider session resumable → offer/perform resume; else `FAILED(orphaned)` with checkpoint of last known state. No external queue needed.

## 6. Routing

```text
1. HARD FILTERS  (any failure excludes; all recorded in the explanation)
   enabled ∧ auth ok ∧ repo path allowed ∧ required capabilities ⊆ manifest.core
   ∧ quota not exhausted ∧ not in failure cooldown

2. PROFILE RULE  (v1 profiles)
   Auto           → priority order per task-kind heuristic (coding→Codex/Claude tie-break by quota headroom; planning/review→Claude first), overridable in config
   Preserve Quota → most quota headroom (min used_percent, earliest resets_at as tie-break)
   Fastest        → static latency class from manifest + rolling median duration once telemetry exists

3. EXPLANATION OBJECT (persisted on RoutingDecision, rendered in UI before start)
   { candidates: [{id, passedFilters, filterFailures[], quota: {usedPercent, resetsAt}}],
     ruleFired, chosen, tieBreaker, userOverride? }
```

- User can always override; overrides are recorded (future telemetry signal).
- Failure cooldown: a provider that errored or hit limits gets a decaying penalty window (`resets_at`-aware for quota).
- Task classification: heuristics over the prompt + repo flags (`needsRepo`, `needsShell`, `kind`), plus explicit user override. No LLM call.
- Phase 5 replaces step 2 with telemetry-fed scoring **behind the same interface** (`route(task, candidates) → RoutingDecision`).

## 7. TaskEnvelope, checkpoint, handoff

**TaskEnvelope** (structured, DB-backed; `progress.md` and `handoff.md` are rendered projections):

```yaml
task_id: AG-1042
goal: ...
constraints: [...]                  # user-imposed; inviolable
repository: { path, branch: task/AG-1042 }
status: { state: RUNNING, phase: testing }
completed: [...]                    # derived from events ∪ agent-reported
remaining: [...]
decisions:                          # provenance-tagged
  - { text: preserve public auth API, made_by: user, at: ... }
  - { text: reuse token cache,        made_by: "agent:personal-claude", at: ... }
artifacts: { diff_ref, changed_files[], test_results[] }
next_action: ...
```

- **Dual-source progress:** the orchestrator derives `completed`/`artifacts`/`phase` from the event stream; the rendered prompt also instructs the agent to report progress via a plane endpoint (tier-1) — agent reports enrich, never solely carry, the envelope.
- **Checkpoint** (control-plane function; no adapter involvement): snapshot envelope + commit work on the task branch (`checkpoint: <task> <reason>`) + diffstat + last test results + summarized recent activity. Taken on: limit events, handoff, cancellation, completion, and periodic timer during long runs.
- **Handoff package:** inline → envelope, git branch + diffstat + key hunks, decisions with provenance, ~1-page activity summary. By reference (plane API) → full event log, full diff, prior run transcripts. Redaction pass before render.
- **Same-provider continuation** uses `resume(providerSessionRef)`; **cross-provider handoff** always `start()` with the handoff-rendered prompt.

## 8. Quota failover (personal workspace)

```text
CodexAdapter: token_count.rate_limits → usage.updated (used_percent, resets_at)
ClaudeAdapter: usage messages + typed limit errors → usage.updated / limit.hit

orchestrator.limitMonitor (event consumer, not a poller):
  used_percent ≥ soft threshold (default 85%) → limit.approaching → checkpoint eagerly
  limit.hit | quota-classified error          → LIMIT_PAUSED → checkpoint →
      router.route(task, remaining candidates) →
        target found → HANDING_OFF → start/resume on target → RUNNING   [loud UI banner + event]
        none         → WAITING_INPUT ("all providers limited; Codex resets 14:00")
  cooldown: source provider penalized until resets_at (or decaying window if unknown)
```

Config: `failover: { auto: true, softThresholdPct: 85, triggers: [quota, rate_limit, provider_unavailable] }` per workspace instance. Work instance defaults `auto: false` (approval-gated) until trusted.

## 9. API surface (v1)

```text
GET  /api/assistants                      # catalog + manifests + quota
POST /api/assistants/:id/sync             # on-demand describe()
GET  /api/assistants/changes              # capability diff feed

POST /api/tasks                           # intake: goal, repo, constraints, profile, overrides
GET  /api/tasks · GET /api/tasks/:id
POST /api/tasks/:id/route                 # returns RoutingDecision (explanation) without starting
POST /api/tasks/:id/start                 # accepts chosen/overridden assistant
POST /api/tasks/:id/input                 # mid-run input + approval responses
POST /api/tasks/:id/cancel
POST /api/tasks/:id/checkpoint
POST /api/tasks/:id/handoff               # manual handoff { to?: assistantId }

GET  /api/tasks/:id/events                # paged history
GET  /api/tasks/:id/events/stream         # SSE
GET  /api/tasks/:id/files/progress.md     # rendered projections
GET  /api/tasks/:id/files/handoff.md
```

Daily sync: node-cron in-process (configurable hour) → registry sync → `CapabilityChange` rows → change feed.

## 10. Frontend (React + Vite, 4 screens)

1. **New Task** — prompt, repo picker (workspace allowlist), constraints, profile (`Auto`/`Preserve Quota`/`Fastest`), assistant/model override → routing recommendation panel (ranked candidates, filter results, quota bars, reasons) → Run / Override.
2. **Task Board** — cards: id, goal, assistant, state badge, quota warnings, failover banners.
3. **Task Detail** — tabs: **Activity** (normalized timeline w/ phase annotations, approval prompts inline), **Diff/Files**, **Tests**, **Usage** (tokens + quota trajectory), **Decisions**, **Routing** (explanation history incl. handoffs).
4. **Assistant Catalog** — per assistant: manifest core, provider bag (skills/plugins/MCP for Claude, etc.), auth state, quota, last sync, "what changed today" feed.

Workspace switcher is **not** a dropdown — each instance *is* a workspace; the UI header just names it (color-coded). A federated read-only view across instances is deferred.

## 11. Git safety

- Every coding task gets branch `task/<id>`; refuse dirty worktrees unless overridden.
- Single-agent runs execute in a dedicated worktree per task (cheap, and makes Phase-5 parallelism a loop instead of a redesign: worktree per assistant, compare, merge winner after review).
- Checkpoints are commits on the task branch; handoff diffs derive from `merge-base` with the origin branch.

## 12. Security

1. No provider secrets in the plane's DB/config — provider CLIs/SDKs authenticate in place.
2. Workspace isolation by construction (separate machines/instances/DB files).
3. Repo allowlist per instance; refusal is a hard filter, not a warning.
4. Redaction rules applied to events, rendered files, and handoff packages before persistence/render.
5. Audit = the append-only Event table + RoutingDecision + Handoff rows (already in the model; no separate audit system).
6. UI on localhost; any future remote exposure requires auth added first.
7. Approval policy per instance: personal may default to broad auto-approve; work defaults to prompt-on-escalation.
