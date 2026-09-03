# Operator Observability, Verification & Evidence — Architecture

**Status:** Proposed (design only; no implementation on this branch)  
**Date:** 2026-09-01  
**Builds on:** `docs/agentic-os-plan.md`, `docs/execution-harness.md`  
**Implementation plan:** `docs/operator-observability-verification-implementation-plan.md`  
**Cockpit companion:** `docs/specs/E-agentic-os-role.md` in the Cockpit repository

## 1. Decision

Cockpit and Agentic OS remain separate products with a strong, versioned API contract:

- **Cockpit** observes, inspects, commands and visualizes.
- **Agentic OS** decides, decomposes, routes, orchestrates, executes and verifies.
- **The Execution Harness** provisions and runs verification capabilities after the Control
  Plane has selected them. It never chooses a provider, assistant, model or task verdict.
- **Cockpit continues to observe ad-hoc coding-agent sessions** that Agentic OS did not launch.

The two observable data classes are deliberately different:

1. A **managed execution** is canonical Agentic OS data with task, composition, session,
   lifecycle, verification, evidence, recovery and handoff semantics.
2. An **observed external session** is Cockpit-owned, best-effort telemetry about a Claude,
   Codex or other coding-agent session. It may be linked to a managed execution explicitly,
   but is never silently promoted into canonical task state.

Repository convergence is not a target. A shared contract removes schema drift without joining
two privileged local applications or coupling their release cadence.

## 2. Normative boundaries

| Concern | Owner |
|---|---|
| Task/subtask decomposition and repository assignment | Agentic OS Control Plane |
| Assistant/model/tool composition | Agentic OS Composer/router |
| Verification requirements and final task verdict | Agentic OS Control Plane |
| Verifier provisioning, execution and artifact collection | Execution Harness |
| Canonical task/session/verification/evidence persistence | Agentic OS |
| Managed-task operator commands | Cockpit through versioned Agentic OS commands |
| Managed-task visualization | Cockpit from durable Agentic OS reads |
| Ad-hoc Claude/Codex observation | Cockpit observer adapters |
| Machine-global assistant tooling and registry | Cockpit |
| Optional trace analytics | `TelemetrySink` adapters |

Invariants:

- Cockpit never infers a managed task transition from hook silence, cwd, a provider session ID,
  a trace, or a `PLAN.md` marker.
- The Harness never decides whether browser/API/evaluation verification is required. It receives
  a persisted `VerificationPlan` and reports what happened.
- A Tester agent's claim that a check passed is not verification evidence. Required checks run
  through the Harness-controlled verifier boundary.
- Provider session references, AgentTrail, CCAM and Langfuse are references/adapters only.
- Optional telemetry failure never changes execution, verification or task state.
- No verifier mutates global Claude/Codex configuration or requires globally installed tools.

## 3. Multi-repository identity

The current path-based task model is insufficient for a parent task spanning repositories.
Add stable identities without making remote Git hosting mandatory:

```ts
type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
type RepositoryId = string & { readonly __brand: "RepositoryId" };
type WorktreeId = string & { readonly __brand: "WorktreeId" };
type ExecutionRequestId = string & { readonly __brand: "ExecutionRequestId" };
type ExecutionSessionId = string & { readonly __brand: "ExecutionSessionId" };

interface RepositoryRef {
  repositoryId: RepositoryId;
  workspaceId: WorkspaceId;
  canonicalRoot: string;
  vcs: "git" | "none";
  remoteFingerprint?: string; // normalized remote identity digest, never a credential-bearing URL
}

interface WorktreeRef {
  worktreeId: WorktreeId;
  repositoryId: RepositoryId;
  canonicalPath: string;
  branch?: string;
  baseRef?: string;
}

interface TaskCorrelation {
  parentTaskId?: TaskId;
  groupId?: string;
}
```

`canonicalRoot` and `canonicalPath` are placement metadata guarded by Workspace Authority. They
are not identities by themselves. `ProviderSessionRef` stays opaque and external.

One parent task may therefore own repository-scoped subtasks:

```text
Parent Task
├── Subtask → Repository A → Worktree A → Claude execution
├── Subtask → Repository B → Worktree B → Codex execution
└── Subtask → Repository C → verification-only execution
```

The Harness remains recursion-agnostic: it receives one flat `ExecutionRequest` for one worktree.
The Control Plane owns fan-out, fan-in and cross-repository verdicts.

## 4. Verification planning

### 4.1 Responsibility split

Add a pure, deterministic Control Plane service:

```ts
interface VerificationPlanner {
  plan(input: VerificationPlanningInput): VerificationPlan;
  revise(plan: VerificationPlan, actualChanges: ChangeSet): VerificationPlan;
}
```

Planning happens twice:

1. **Before execution:** acceptance criteria, task metadata, repository capabilities and risk
   establish the expected checks.
2. **After implementation:** the normalized change set may add checks justified by actual files,
   routes, components, schemas or styles changed. It may not silently remove required checks.

Every decision records matched signals and reasons. LLM assistance may propose checks later, but
deterministic policy validates and persists the final plan.

```ts
interface VerificationPlan {
  schemaVersion: 1;
  planId: string;
  taskId: TaskId;
  revision: number;
  checks: VerificationSpec[];
  decisions: VerificationDecision[];
}

interface VerificationDecision {
  kind: VerificationKind;
  selected: boolean;
  required: boolean;
  signals: string[];
  reason: string;
}
```

### 4.2 Provider abstraction

`VerificationSpec.kind` expands to:

```ts
type VerificationKind =
  | "tests"
  | "typecheck"
  | "lint"
  | "api"
  | "browser"
  | "artifact_exists"
  | "evaluator"
  | "review"
  | "command";
```

Harness implementations conform to:

```ts
interface VerificationProvider {
  readonly kind: VerificationKind;
  detect(context: VerificationContext): Promise<Applicability>;
  prepare(context: VerificationContext): Promise<PreparedVerification>;
  run(prepared: PreparedVerification): Promise<VerificationCheckResult>;
  collectArtifacts(result: VerificationCheckResult): Promise<ExecutionArtifact[]>;
}
```

Initial providers:

- `UnitTestVerifier`
- `TypecheckVerifier`
- `LintVerifier`
- `ApiVerifier`
- `BrowserVerifier` with a Playwright adapter
- `EvaluationVerifier`
- `ReviewVerifier`

The Harness selects an implementation only for the already-selected kind. If several adapters
exist for one kind, repository-native configuration wins, followed by an explicitly configured
workspace adapter, then the pinned Harness default.

### 4.3 Automatic selection rules

| Signal | Required/default checks |
|---|---|
| Existing project test command and changed source | tests |
| Typed source, build configuration or public types changed | typecheck |
| Lintable source or lint configuration changed | lint |
| Route/controller/OpenAPI/schema/API-client contract changed | api |
| Page/component/route/style/template/frontend asset changed | browser |
| Acceptance criteria mention visible interaction/layout/navigation | browser |
| Prompt/routing/retrieval/evaluator behavior changed | evaluator |
| Security-sensitive, cross-cutting or policy change | review plus applicable deterministic checks |

Task metadata and explicit acceptance criteria can add required checks. They cannot weaken
workspace-mandated checks without an explicit, audited policy override.

When an applicable verifier cannot run, it returns `skipped` or `blocked` with a structured
reason; it never disappears from the result.

## 5. Playwright as a Harness capability

Playwright is adopted as the first `BrowserVerifier` adapter and as an optional capability in a
Tester agent's composed `AgentSpec`.

These are separate paths:

1. **Harness-owned verification:** after provider execution, the Harness runs browser checks and
   produces canonical evidence independently of the implementation agent.
2. **Tester-agent tooling:** when exploratory navigation, test authoring or diagnosis is useful,
   the Composer attaches the Playwright skill/tool to that Tester execution only.

Provisioning order:

1. Use the repository's existing Playwright dependency, configuration and tests.
2. Otherwise use a workspace-configured, pinned Playwright CLI/skill adapter.
3. Otherwise record an unavailable/skipped check with the exact reason.

No global installation is assumed. The capability is scoped to the execution profile/worktree,
and all Harness-owned commands run through Workspace Authority with bounded output, reduced env,
timeouts and path containment.

Browser evidence includes where applicable:

- application launch/base URL and browser/project used;
- named flows and steps executed;
- assertions and pass/fail status;
- screenshots for materially changed states and failures;
- page errors, browser console errors and failed network requests;
- trace/video references when enabled by repository policy;
- verifier/tool version and configuration digest.

## 6. API verification and Postman

`ApiVerifier` is local-first and provider-neutral. Its default preference is:

1. repository-native API/integration tests;
2. OpenAPI/schema validation;
3. bounded local HTTP assertions against an isolated server;
4. an optional collection adapter.

Postman MCP is deferred. A future `PostmanApiVerifier` may be enabled when a repository already
maintains collections/specs and the workspace policy permits Postman API access. It is never a
required Agentic OS dependency, and adding MCP alone is not evidence of value.

## 7. Evidence model

Reuse the Harness's `EvaluationResult` and `ExecutionArtifact`; do not add a competing persisted
`EvidenceBundle` entity.

Extend artifact kinds additively:

```ts
type ExecutionArtifactKind =
  | "diff"
  | "file_list"
  | "test_report"
  | "checkpoint"
  | "rendered_output"
  | "api_report"
  | "browser_report"
  | "screenshot"
  | "console_log"
  | "evaluation_report"
  | "review_report"
  | "trace_ref";
```

Each verification check carries `status: passed | failed | skipped | blocked`, `required`, a
bounded summary and zero or more artifact refs. Large outputs remain in an artifact store or
worktree-owned retention area; database rows contain references, digests, media types, sizes and
retention metadata.

`EvidenceBundle` is permitted only as a read-model/API projection that joins:

```text
ExecutionResult
├── EvaluationResult/checks
├── ExecutionArtifact[]
├── changed files + diff ref
├── checkpoint/handoff refs
└── optional telemetry trace refs
```

Cockpit renders this projection but does not store a second canonical copy.

## 8. Cockpit contract and UX

### 8.1 Managed Agentic OS data

Extend the Control Plane capability handshake additively:

```text
tasks.read
subtasks.read
sessions.read
events.read
events.stream
routing.read
verification.read
artifacts.read
approvals.read
commands.write       # separately authorized; never implied by read capabilities
```

SSE is a resync notification channel, not the record of truth. Every feed provides a durable
cursor and Cockpit recovers by reading rows after reconnect.

Cockpit drill-down:

```text
Task → repository-scoped subtasks → composition/routing
     → assistant + model → execution attempts/sessions
     → lifecycle + approvals + checkpoints/handoffs
     → verification checks → evidence → optional trace links
```

### 8.2 Observed external sessions

Cockpit keeps its native observer adapters and persistence. An external-session record contains:

```ts
interface ObservedSession {
  observedSessionId: string;       // Cockpit identity
  provider: string;
  source: string;                  // local hook, rollout, remote host, etc.
  host: string;
  providerSessionRef?: string;
  repositoryId?: RepositoryId;     // resolved best-effort
  cwd?: string;
  branch?: string;
  model?: string;
  observedStatus: string;
  observedPhase?: { value: string; confidence: number; source: string };
  linkedExecutionSessionId?: ExecutionSessionId; // explicit link only
}
```

The UI labels these records **Observed**, shows inference confidence, and never presents their
phase/status as Agentic OS lifecycle. A manual link is auditable and reversible.

## 9. Telemetry sinks and Langfuse

Canonical state is persisted before telemetry export:

```ts
interface TelemetrySink {
  readonly id: string;
  emit(batch: readonly RedactedTelemetryEvent[]): Promise<TelemetryDeliveryResult>;
}
```

Initial/future sinks:

- `LocalTelemetrySink`
- `CockpitEventSink`
- `LangfuseTelemetrySink` (optional)
- `OpenTelemetrySink` (future)

Langfuse may hold traces, nested tool observations, token/cost metrics, scores and evaluator
results. It never owns task state, session state, verification results, evidence retention or
recovery decisions.

Default export excludes prompts, source, diffs, tool arguments/results and provider transcripts.
Those fields require explicit workspace policy and client-side redaction before the sink. Secret
and PII detection runs before enqueue; sink queues are bounded and local; exporter failure is
non-blocking. Local/self-hosted endpoints are preferred.

Development tracing of Claude/Codex is a separate opt-in from product Harness tracing. Global
hooks are not a prerequisite for the product sink.

## 10. External-tool decisions

| Tool | Decision | Boundary |
|---|---|---|
| AgentTrail | Adopt as optional adapter/tool | General development observability for any repository; optional Cockpit link/projection; never canonical Agentic OS state |
| CCAM | Reference only | Learn from SQLite, transcript sync, remote sources, alerts and event contracts; do not run a second overlapping dashboard by default |
| Playwright | Adopt | Harness `BrowserVerifier` plus relevant Tester-agent capability; automatically selected |
| Postman MCP | Defer | Future optional `ApiVerifier` adapter only when maintained Postman assets justify it |
| Langfuse | Adopt as optional adapter | Redacted `TelemetrySink`; development tracing separately opt-in |

AgentTrail remains useful across arbitrary development repositories, including but not limited
to Agentic OS. Its `PLAN.md`, daemon and inferred component state are intentionally outside the
canonical execution model.

## 11. Delivery plan

This spec refines existing phases; it does not create a parallel implementation track.

1. **P0 / Harness Phase 0:** add identity, verification-plan, richer check-status and artifact
   contracts; characterization only, no runtime behavior change.
2. **P0 / Harness Phase 1–2:** persist repository/worktree/session correlation and preserve it
   through events, checkpoints and artifacts.
3. **P0 / Harness Phase 5 vertical slice:** implement the Control Plane
   `VerificationPlanner` and Harness provider registry with native tests/typecheck/lint first;
   then `ApiVerifier` and Playwright `BrowserVerifier`.
4. **P1 / Harness Phase 6:** publish durable managed-execution reads and evidence projection;
   extend the versioned capability handshake.
5. **P1 / Cockpit:** render Managed and Observed data classes separately; add explicit linking
   and managed-task command authorization.
6. **P1 / Cockpit:** migrate observer persistence toward append-only SQLite with provider/source
   identities and resumable event cursors, informed by CCAM patterns.
7. **P2:** add `TelemetrySink` after redaction/egress tests; pilot local or self-hosted Langfuse.
8. **P2:** evaluate optional AgentTrail projection and Postman adapter only from demonstrated
   usage, without putting either on the critical path.

## 12. Acceptance criteria

- A frontend change automatically produces a browser verification requirement without the user
  naming Playwright.
- The repository's native Playwright suite is preferred; otherwise a pinned scoped adapter runs,
  or the result records why it could not.
- A successful provider execution with failing required browser assertions remains execution
  `COMPLETED` plus verification `failed`; only the Control Plane changes the task verdict.
- Cockpit shows tests/API/UI/review states and artifact links entirely from durable reads.
- An ad-hoc Codex session appears as Observed and cannot alter a managed task.
- One parent task can correlate subtasks and executions in three repositories without using cwd
  or provider session IDs as canonical identity.
- Langfuse unavailable produces no execution or verification failure.
- Default telemetry export contains no prompt, source code, diff, tool argument/result,
  transcript, secret or PII payload.
- AgentTrail may run for any repository without becoming an Agentic OS dependency.
- Postman is absent without reducing local API verification capability.
