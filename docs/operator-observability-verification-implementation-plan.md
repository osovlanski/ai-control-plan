# Operator Observability, Verification & Evidence — Implementation Plan

**Status:** Reconciled with `ai-control-plan` main at `88e03e7` and approved for incremental
execution. No implementation belongs on this documentation worktree.  
**Date:** 2026-09-01  
**Architecture:** `docs/operator-observability-verification.md`  
**Harness sequence:** `docs/harness-implementation-plan.md`

## 1. Delivery strategy

This work extends the existing Harness strangler migration. Harness Phases 0 through 8e are now
merged on `main`; the single-execution cutover remains default OFF. This plan must extend that
implementation rather than recreate its persistence, recovery, correlation or API foundations.

### 1.1 Current-main reconciliation (2026-09-01)

Implemented on `main` and therefore removed from the critical path:

- durable execution sessions, events, approvals, checkpoints and recovery;
- `ExecutionSessionId`, `ExecutionRequest`, `ExecutionSession`, `ExecutionResult`,
  `ExecutionArtifact`, `EvaluationResult` and the initial verification vocabulary;
- optional `parentTaskId`/`groupId` correlation persisted and indexed;
- Observability API 1.1 session, verification and approval reads plus SSE/task-envelope work;
- routing corpus evaluation and PREPARED/STARTING crash-origin recovery evaluation.

Still required by this program:

- canonical workspace/repository/worktree identities in addition to path authority;
- expanded API/browser/review verification and evidence vocabulary;
- a deterministic `VerificationPlanner` (the managed bridge currently submits an empty
  verification list);
- provider extraction and automatic native/API/browser verification;
- artifact reads and a complete managed Cockpit client/UI;
- optional redacted telemetry sinks.

`docs/PROJECT_MEMORY.md` and the checked-in Graphify output predate the merged Harness and must
not be used as evidence for current implementation status until regenerated. Real-provider
conformance, end-to-end scenario evaluation, the scorecard and rollout canary remain separate
credentialed/staging work. This plan neither supplies credentials nor turns the rollout flag on.

### 1.2 Approved local execution checkpoints

These isolated branches passed monorepo tests and independent review. They are local
checkpoints, not evidence of merge or deployment until the normal integration process lands
them:

| Slice | Branch | Commit | Review |
|---|---|---|---|
| H0A.1 core identity vocabulary | `agentic/h0-identities-contracts` | `ddf4ed2` | independent Codex approval |
| H0B verification/evidence vocabulary | `agentic/h0-verification-contracts` | `03481d7` | independent Codex approval |
| H5A pure deterministic planner | `agentic/h5-verification-planner` | `e5fe851` | independent Codex approval; remains unwired |
| H0A.2 local repository registry | `agentic/h0-repository-registry` | `3a3dcd6` | bounded Claude/Codex loop approval |
| H1 additive target persistence/read projection | `agentic/h0-execution-target-persistence` | `32c4894` | bounded Claude/Codex loop approval |
| H5B verifier-provider extraction | `agentic/h5-verifier-providers` | `b554c9e` | bounded Claude/Codex loop approval |

The next accepted boundary is project-native capability discovery and verifier connection. Do
not connect H5A browser/API plans until their real verifier providers exist, and do not flip
`harnessSingleMode`.

The delivery model is **coordinator-led, subagent-driven, worktree-isolated**:

- One coordinator owns scope, dependency ordering, integration decisions and the acceptance
  ledger. It should avoid implementation except for small integration fixes.
- Each implementation slice has one writing agent in one dedicated Git worktree.
- Read-only research/review/test agents may run concurrently, but two writers never edit the
  same package, migration or contract surface in parallel.
- Every slice starts from an accepted base commit, has a bounded file-ownership declaration and
  ends with tests plus a handoff note.
- Contract/schema changes merge before consumers. Cockpit never guesses an unreleased Agentic OS
  payload.
- Cross-repository phases close only after producer and consumer contract tests pass together.

Do not implement from `docs/agentic-os-contract-lifecycle`. That worktree holds design changes
and exists to review the architecture. Implementation branches are created from current
`ai-control-plan/main` and Cockpit `main` (or an explicitly designated release branch).

## 2. Assistant recommendation

### Default pairing

| Role | Recommended assistant | Reason |
|---|---|---|
| Coordinator / architecture custodian | Claude | Maintain cross-document/domain invariants, decompose work and review whether implementation still matches the accepted boundary |
| TypeScript/SQLite implementation lead | Codex | Execute bounded code slices, migrations and deterministic tests with strong repository/tool discipline |
| Adversarial contract/recovery reviewer | Claude, fresh context | Challenge ownership, failure modes, privacy and state-machine semantics without inheriting implementer assumptions |
| Test/fault-injection lead | Codex, fresh context | Build table-driven/property/fault tests and reproduce failures independently |
| Cockpit UX integration lead | Codex | Implement typed API consumption and incremental UI slices against contract fixtures |
| Privacy/telemetry reviewer | Claude, fresh context | Audit redaction, egress and optional-sink failure isolation |

This is a default, not a protocol dependency. Either Claude or Codex may fill a role when the
other is unavailable, but the **implementer and final reviewer should not be the same session**.
Provider diversity is useful for high-risk contracts and state transitions because it reduces
shared blind spots.

### Optional claudex-loop review gate

`claudex-loop` may replace the ordinary adversarial-review step when Claude quota/capacity is
available. It is a development workflow only: never a runtime dependency, required global hook,
or prerequisite for resuming work after a quota outage.

Use it for high-risk plans or diffs involving state machines, migrations, recovery, approval,
workspace authority, evidence contracts or telemetry egress:

1. The coordinator freezes the review target (base/head commits, architecture revision and
   acceptance ledger) before starting the loop.
2. Claude and Codex alternate independent critique/resolution rounds; the implementation agent
   does not act as the only reviewer.
3. Configure a bounded `MAX_ROUNDS` and retain the complete review log plus the final verdict.
4. `APPROVE` closes the review gate. `REVISE` produces owned follow-up work and must be reviewed
   again unless the maximum-round policy explicitly records the remaining finding as accepted
   risk or sends it to another independent reviewer.
5. If Claude quota is exhausted, pause the loop itself—not implementation—and use the normal
   fresh-Codex reviewer plus human approval. A later claudex-loop may audit the already-merged
   slice against its commits and evidence without rewriting history.

Do not run two claudex-loops over the same writable branch concurrently. The loop reviews one
frozen slice at a time and writes only its review artifacts through the designated coordinator.

### Per-slice agent roles

Every non-trivial slice uses at least these bounded roles:

1. **Implementer** — sole writer in the slice worktree.
2. **Reviewer** — read-only inspection against architecture, invariants and diff.
3. **Tester** — independently runs the required verification matrix and inspects artifacts.

High-risk slices add:

- **Migration reviewer** for schema/backfill/rollback work.
- **Security reviewer** for Workspace Authority, commands, artifacts or telemetry.
- **Consumer reviewer** when a shared contract affects Cockpit.

Subagents receive concrete deliverables, owned paths, forbidden paths, required tests and a
definition of done. “Implement Phase N” is too broad for one worker.

## 3. Worktree and branch model

### Naming

Use one branch/worktree per reviewable slice:

```text
agentic/h0-identities-contracts
agentic/h0-verification-contracts
agentic/h1-session-correlation
agentic/h5-verification-planner
agentic/h5-native-verifiers
agentic/h5-api-verifier
agentic/h5-browser-verifier
agentic/h6-observability-contract

cockpit/managed-client-contract
cockpit/managed-task-detail
cockpit/observed-session-store
cockpit/managed-observed-linking
```

Worktree directories should be explicit siblings, never the repository root and never derived
from unvalidated task text. Example layout:

```text
~/workspace/personal/worktrees/
├── ai-control-plan-h0-identities/
├── ai-control-plan-h5-browser/
└── cockpit-managed-client/
```

### Rules

- Create every slice from the latest accepted integration commit, not from another agent's
  unreviewed worktree.
- Record base commit, branch and owned files before the implementer starts.
- Never share a writable worktree between agents.
- Never stack two schema migrations independently. Migration slices are strictly serialized.
- Never edit the shared contract and both consumers in three uncoordinated branches. Merge the
  contract first, publish/pin its fixture/artifact, then update consumers.
- Rebase/update a slice only when its implementer is idle and after checking its worktree state.
- Do not delete a worktree until its branch is merged, tests are recorded and no untracked
  evidence remains.
- Generated browser screenshots/traces belong in ignored test-artifact directories unless an
  explicit golden is reviewed and intentionally committed.

### File-ownership ledger

The coordinator maintains a temporary per-phase ledger outside production source:

| Slice | Repository | Branch/base | Owned paths | Forbidden overlaps | Agent | Status |
|---|---|---|---|---|---|---|

Only the coordinator changes ownership. A worker that discovers necessary edits outside its
allocation stops and returns a dependency request; it does not widen its own scope.

## 4. Phase and dependency map

```text
H0A additive identities ─┐
                         ├─► additive persistence mapping ───────────┐
H0B evidence vocabulary ┘                                           │
                                                                     ▼
                 H5A planner ─► H5B native ─► H5C API ─► H5D browser
                                                                     │
                                                                     ▼
                           H6 managed observability contract
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
              Cockpit managed views      Cockpit observed-store hardening
                         └────────────┬────────────┘
                                      ▼
                          explicit optional linking
                                      │
                                      ▼
                         optional telemetry sinks (P2)
```

Identity and verification contracts may be separate Phase 0 PRs if their files do not overlap.
All schema migrations, execution-driving changes and shared-contract releases remain serialized.

## 5. Implementation slices

### Slice H0A — multi-repository identities

**Priority:** P0  
**Recommended lead:** Codex implementer; Claude domain reviewer  
**Depends on:** accepted Harness Phase 0 base

Scope:

- Add branded `WorkspaceId`, `RepositoryId`, `WorktreeId` and `ExecutionRequestId` contracts;
  reuse the existing `ExecutionSessionId`.
- Add `RepositoryRef` and `WorktreeRef`; reuse existing parent/group task correlation.
- Define canonicalization and remote-fingerprint rules without making a remote mandatory.
- Keep `ProviderSessionRef` external and opaque.

Deliver this in two review gates:

- **H0A.1 core vocabulary:** branded ids, an optional discriminated repository/worktree target,
  fingerprint coverage and legacy-request compatibility. `ExecutionRequestId` remains a raw
  schemaVersion 1 field until its coordinated migration.
- **H0A.2 registry semantics:** canonical-root and credential-safe remote fingerprint rules plus
  the identity assignment service. Do not infer stable ids merely to close H0A.1.

Tests:

- IDs cannot be interchanged at compile time.
- Equivalent canonical repository roots resolve consistently.
- Credential-bearing remote URLs never persist verbatim in fingerprints.
- Parent tasks correlate repository-scoped children without cwd joins.

H0A.1 acceptance:

- Pure contracts/tests only; zero runtime behavior change.
- Existing public payloads remain valid through additive fields or an explicit new version.

H0A is complete only after H0A.2 also satisfies the canonical-root, credential-bearing remote
and multi-repository parent/child test cases listed above.

### Slice H0B — verification and evidence contracts

**Priority:** P0  
**Recommended lead:** Codex implementer; Claude Harness-boundary reviewer  
**Depends on:** accepted Harness Phase 0 base

Scope:

- Add `VerificationPlan`, `VerificationDecision`, extended kinds and four-state check status.
- Extend `ExecutionArtifact.kind` and metadata for digest/media type/size/retention.
- Define `EvidenceBundle` as a read projection only.
- Include every execution-affecting verification field in the request fingerprint.

Tests:

- Fingerprints change for required check/provider/config changes.
- Observational metadata does not change fingerprints.
- Required skipped/blocked checks cannot be reported as passed.
- Artifact refs reject inline unbounded payloads.

Acceptance:

- Existing `tests/typecheck/lint/command/artifact_exists/evaluator` requests remain readable.
- No new evidence aggregate table is introduced.

### Slice H1/H2 — durable repository/session correlation

**Priority:** P0  
**Recommended lead:** Codex; separate migration reviewer  
**Depends on:** H0A and the already-merged Harness persistence model

Scope:

- Add stable repository/worktree/request identity columns and compatibility mapping alongside
  the existing paths and parent/group/session correlation.
- Carry the new identities through the already durable events, approvals, checkpoints,
  handoffs, verification and results.
- Add only the indexed reads not already supplied by Observability API 1.1.
- Preserve path authority and session-scoped checkpoint behavior.

Tests:

- Production-shaped migration fixture and rollback plan.
- Parallel sessions in separate worktrees never cross-link checkpoints/artifacts.
- Provider session reference collisions across providers do not merge executions.
- Restart/reconcile retains repository and parent-task correlation.

Acceptance:

- No Cockpit dependency.
- All existing characterization and fault tests remain green.

### Slice H5A — VerificationPlanner

**Priority:** P0  
**Recommended lead:** Codex; Claude policy reviewer  
**Depends on:** H0B and normalized post-execution change set

Scope:

- Implement a pure Control Plane planner.
- Load repository verification capabilities from deterministic project signals/config.
- Plan before execution and revise additively after actual changes.
- Persist decisions, signals and policy overrides.

Tests:

- Table-driven file/acceptance-criteria matrix.
- Frontend changes select browser without the prompt saying Playwright.
- Route/schema changes select API verification.
- Planner may add but never silently remove a required check after execution.
- LLM output, when later enabled, cannot bypass deterministic policy.

Acceptance:

- Planner contains no provider SDK imports and runs without live assistants.
- Same inputs produce byte-equivalent canonical plans.

### Slice H5B — native verifiers

**Priority:** P0  
**Recommended lead:** Codex implementer/tester in separate sessions  
**Depends on:** H5A and Workspace Authority

Scope:

- Extract the existing inline command/artifact verification behind a provider registry and
  runner lifecycle without changing behavior first.
- Retain unit/integration test, typecheck, lint, command and artifact-exists behavior.
- Output/time limits, reduced env and cwd pinning through Workspace Authority.
- Normalize and wire-validate results and artifact refs, derive aggregate status, and propagate
  planner `checkId` from every selected spec into its result/evidence join.

Acceptance:

- Repository-native commands are preferred.
- Missing commands return explicit skipped/blocked results.
- Successful execution plus failed verification remains represented separately.

### Slice H5C — local-first ApiVerifier

**Priority:** P1  
**Recommended lead:** Codex; security reviewer for server lifecycle/network scope  
**Depends on:** H5B

Scope:

- Prefer native API tests, then OpenAPI/schema checks, then bounded local HTTP assertions.
- Manage isolated server startup/readiness/shutdown as verification preparation/finalization.
- Capture assertion, schema and bounded request/response evidence with header/body redaction.
- Define but do not implement the future Postman adapter seam.

Acceptance:

- Postman credentials/workspaces are unnecessary.
- Verifier cannot address non-allowed hosts unless workspace policy explicitly permits it.
- Secrets and auth headers never enter durable artifacts.

### Slice H5D — Playwright BrowserVerifier

**Priority:** P1  
**Recommended lead:** Codex implementation lead; independent Claude UX/evidence reviewer;
Codex Tester  
**Depends on:** H5B and application lifecycle abstraction from H5C where reusable

Scope:

- Detect project-native Playwright configuration/dependency/tests.
- Add a pinned, execution-scoped official Playwright CLI/skill fallback.
- Provision the same capability into relevant Tester `AgentSpec`s without global installation.
- Capture flows, assertions, screenshots, console/page/network errors and optional trace/video
  refs.
- Apply artifact retention, output caps and screenshot path containment.

Tests:

- Native project Playwright wins over the fallback.
- A representative frontend change automatically runs browser verification.
- Console error and failed assertion evidence survive normalization.
- Browser unavailable produces an explicit reason.
- A Tester can use Playwright interactively, but Harness verification still runs independently.
- No verifier writes `~/.claude`, `~/.codex` or other global assistant configuration.

Acceptance:

- Demonstrate successful and failing UI tasks with durable evidence.
- No live SaaS credential is required.

### Slice H6 — managed observability contract

**Priority:** P1  
**Recommended lead:** Codex producer implementation; Claude contract reviewer; Cockpit consumer
reviewer  
**Depends on:** durable sessions and H5 evidence

Scope:

- Extend the existing versioned task/session/verification/approval reads with repository
  subtasks, artifacts and any missing evidence projection.
- Add durable event cursor/resync semantics.
- Add a separately authorized command capability; read capabilities never imply writes.
- Publish OpenAPI/JSON Schema fixtures and compatibility rules.

Acceptance:

- Cockpit can render every state from durable reads alone.
- SSE loss/reconnect does not lose state.
- Older Cockpit clients fail clearly on unsupported major versions and tolerate additive fields.

### Slice C1 — Cockpit managed client

**Priority:** P1  
**Recommended lead:** Codex; Agentic OS contract owner reviews fixtures  
**Repository:** Cockpit  
**Depends on:** released/pinned H6 contract

Scope:

- Upgrade the existing API 1.0/status-level `ControlPlaneClient` to the released Agentic OS
  contract rather than create a second client.
- Add typed managed-task/session/evidence reads and cursor resync.
- Keep Control Plane URL restrictions and fail-closed version checks.
- Add consumer contract tests from published fixtures.

Acceptance:

- No lifecycle inference in the client.
- Agentic OS unavailable does not break Cockpit's external-session board.

### Slice C2 — Managed task detail

**Priority:** P1  
**Recommended lead:** Codex UI implementer; independent UX reviewer  
**Depends on:** C1

Scope:

- Render task → repository subtask → assistant/model → session/attempt.
- Render Tests/API/UI/Review status and evidence links.
- Surface skipped/blocked reasons and enforcement fidelity.
- Keep managed status vocabulary visually distinct from inferred external-session phase.

Acceptance:

- UI source wiring tests and new workflow tests pass.
- No raw transcript or artifact blob is loaded until explicitly requested.

### Slice C3 — observed-session persistence hardening

**Priority:** P1  
**Recommended lead:** Codex; CCAM-pattern research agent read-only  
**Depends on:** none of C1/C2, but serialize any overlap in `server.ts`

Scope:

- Move observer history from one JSON snapshot toward append-only SQLite/WAL.
- Add provider/source-qualified IDs, event cursors and bounded retention.
- Preserve existing Claude hook and Codex rollout behavior during migration.
- Learn from CCAM's schema/import/remote-source patterns without adding CCAM as a dependency.

Acceptance:

- Existing agent records migrate or rebuild safely.
- Hook ingest remains fast and best-effort.
- No provider transcript is newly persisted by default.

### Slice C4 — explicit managed/observed linking

**Priority:** P1  
**Recommended lead:** Codex; Claude boundary reviewer  
**Depends on:** C1 and C3

Scope:

- Add explicit, reversible link records.
- Suggest possible matches using provider/source/session/repository metadata, but require operator
  confirmation unless Agentic OS itself supplied a signed correlation token.
- Never merge histories or let observed state update managed state.

Acceptance:

- Incorrect link can be removed without data loss.
- A provider session ID collision cannot auto-link records.

### Slice T1 — optional telemetry sinks

**Priority:** P2  
**Recommended lead:** Codex implementation; Claude privacy reviewer  
**Depends on:** canonical durable events/results and redaction tests

Scope:

- `TelemetrySink` interface, local queue and delivery result.
- Local sink first, Cockpit projection second.
- Optional local/self-hosted Langfuse adapter behind explicit configuration.
- OpenTelemetry-compatible envelope seam without committing to a backend.

Acceptance:

- Sink failure never changes task/session/verification state.
- Default payload contains no prompts, source, diffs, tool args/results or transcripts.
- Egress tests use a capturing fake endpoint and assert the forbidden-field list.

### Deferred evaluation slices

- **AgentTrail projection:** only after real general-repository usage identifies a stable,
  valuable Cockpit projection. Deep links may precede ingestion.
- **Postman adapter:** only after maintained collections/workspaces exist.
- **CCAM integration:** not planned; re-evaluate only if maintaining Cockpit collectors becomes
  materially more expensive than consuming a stable observer API.

## 6. Subagent task template

The coordinator should issue tasks in this form:

```text
Slice: H5D BrowserVerifier
Base: <commit>
Worktree: <absolute path>
Owned paths: <exact directories/files>
Forbidden paths: <overlapping contracts/migrations/other worktrees>
Objective: <one demonstrable outcome>
Contracts already accepted: <versions/links>
Required tests: <exact commands and cases>
Required evidence: <test output/artifact list>
Non-goals: <explicit exclusions>
Stop conditions: contract mismatch, needed out-of-scope edit, dirty base, missing policy decision
Handoff: summary, changed files, decisions, risks, tests, remaining work
```

Review agents receive the same contract and acceptance criteria but no implementation narrative
beyond the diff and handoff. This preserves independent reasoning.

## 7. Integration and merge gates

Every slice passes:

1. **Worktree gate** — correct base, no unrelated changes, ownership ledger clear.
2. **Contract gate** — schemas/types and compatibility tests pass.
3. **Unit gate** — affected package tests and typecheck pass.
4. **Integration gate** — fake adapters/SQLite fixtures; no live credentials.
5. **Adversarial review gate** — fresh reviewer resolves every high/medium finding or records an
   explicit accepted risk. For high-risk slices, prefer the optional bounded `claudex-loop` when
   Claude capacity is available; otherwise use fresh-Codex review plus human approval.
6. **Consumer gate** — required for cross-repo payloads; producer and Cockpit fixtures agree.
7. **Security/privacy gate** — required for process/network/artifact/telemetry changes.
8. **Demo gate** — the slice's acceptance scenario is reproduced from a clean worktree.

Recommended repository commands remain:

```text
ai-control-plan: pnpm typecheck && pnpm test
cockpit: npm test && npm run build
```

Browser/API slices add their own scoped integration commands and retain references to generated
evidence. Live-provider conformance stays in the credentialed Harness Phase 7 lane, not ordinary
worker branches.

## 8. Coordinator acceptance ledger

The coordinator tracks each architecture invariant to implementation evidence:

| Invariant | Owning slice | Evidence required |
|---|---|---|
| Managed and Observed stay distinct | H6, C1–C4 | Contract + UI + negative-link tests |
| Provider session is not canonical identity | H0A, H1/H2 | collision/restart tests |
| Control Plane selects; Harness runs | H5A–H5D | import-boundary + planner/runner tests |
| Execution and verification remain separate | H0B, H5B | failed-check integration test |
| Playwright is automatic and scoped | H5A, H5D | frontend-selection + no-global-write tests |
| Evidence reuses result/artifact model | H0B, H6 | schema and read-projection tests |
| Telemetry is optional and redacted | T1 | failure-isolation + captured-egress tests |
| Multi-repository parent tasks work | H0A, H1/H2, H6 | three-repository fixture/demo |

No phase is complete because code was merged. It is complete when its ledger entries point to
repeatable evidence and the prior phase remains green.

## 9. Recommended first execution train

Do not start with Playwright or Cockpit UI. Start with the contracts that make both safe:

1. Reconcile and review the operator documentation against `ai-control-plan/main@88e03e7`.
2. Implement H0A additive identities from current main; preserve paths and database behavior.
3. Implement H0B additive verification/evidence vocabulary from the accepted H0A base.
4. Run independent review and the full control-plane suite after each slice; use a bounded
   `claudex-loop` when Claude capacity is available.
5. Add persistence mapping for the new identities only after the contract is accepted.
6. Implement H5A as a pure, disconnected deterministic planner, then extract H5B providers
   without behavior change.
7. Connect project-native verification before adding API and Playwright adapters separately.
8. Extend/publish the managed observability contract before Cockpit consumes it; keep Cockpit's
   observed-session board operational and distinct throughout.

This ordering preserves current Agentic OS progress, provides early reversible checkpoints and
keeps external tools off the critical path until the canonical contracts are proven.
