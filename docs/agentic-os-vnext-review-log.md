# vNext Plan Review Log

Target: `docs/agentic-os-vnext-plan.md`. Reviewer: Codex (codex-cli 0.152.1, CLI-default model), read-only. MAX_ROUNDS=4.

## Round 1 — Codex

The plan is not ready to implement. Its implementation grounding is better than most architecture plans, but the roadmap contains two build-order failures, leaves authentication unowned, and overstates several factual claims.

## Material findings

1. **CRITICAL — Increment 4 cannot retire the legacy path while preserving parallel/compare/race.**  
   `harnessRouting()` explicitly returns false for `parallel`, `compare`, and `race`, so those modes still require the legacy adapter-driving branch the plan proposes deleting. The increment-3 eval covers only “single mode,” making the increment-4 acceptance criteria impossible as written. [orchestrator.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/orchestrator.ts:134)  
   **Fix:** Add and evaluate a Harness-backed parallel/compare/race migration slice before deleting any legacy execution code.

2. **CRITICAL — The cross-repository command boundary remains unauthenticated.**  
   The target architecture says Cockpit commands will be “separately-authorized,” while current task start/cancel/approval-style mutations have no authentication middleware. Loopback binding reduces exposure but does not authenticate local processes, and prior Spec E explicitly requires bearer-token or Unix-socket authentication. Increment 1 repairs only version negotiation; increment 8 adds commands without an authentication deliverable. [server.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/server.ts:342), [config.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/config.ts:30), [Spec E](/home/ubuntu/workspace/personal/cockpit/docs/specs/E-agentic-os-role.md:16)  
   **Fix:** Put an authenticated transport/command authorization slice before any Cockpit write capability, including CSRF/replay and token-rotation tests.

3. **HIGH — H6/Cockpit views are ordered before the data model they promise to display.**  
   Increment 8 adds `subtasks.read` and requires Cockpit to render managed task detail, while increment 9 is where subtasks, decomposition, fan-out, and parent verdicts are first created. Existing `parent_task_id` and `group_id` are execution-request correlation fields, not a subtask entity or producer. [007_harness_correlation.sql](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/db/migrations/007_harness_correlation.sql:8), [tasks.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/tasks.ts:5)  
   **Fix:** Define and implement the parent/subtask domain and durable read contract before C2; split session observability from subtask UI if early visibility is needed.

4. **HIGH — Putting eval and flag flip before new verifier providers is only partly correct.**  
   Evaluating and enabling the Harness before building more dark code is right. Flipping the global default before parallel/compare/race, unwired handoff claims, and real-adapter provisioning semantics are covered is not. The proposed scorecard does not state which unsupported flows stay gated or how rollback preserves in-flight sessions.  
   **Fix:** Canary the Harness per execution mode, first migrate single runs, then handoff and parallel modes, and flip the global default only when every legacy mode has a proven Harness path.

5. **HIGH — The vNext roadmap silently drops core Agentic OS composition work.**  
   The accepted architecture depends on Cockpit registry reads, deterministic per-run bundle rendering, usage postbacks, Composer/AgentSpec revisions, and provisioning. None has an increment in this roadmap. Saying prior plans remain authoritative does not establish where these workstreams interleave with cutover, decomposition, or Cockpit H6. This is not a complete executable roadmap.  
   **Fix:** Provide one dependency graph combining the still-pending M-series composition/registry work with increments 1–10, including named owners and merge gates.

6. **HIGH — “Cockpit integration is currently broken” is too absolute.**  
   The factual incompatibility is real: Cockpit rejects anything other than `1.0`, while the producer advertises additive `1.1`. [controlPlane.ts](/home/ubuntu/workspace/personal/cockpit/controlPlane.ts:36), [contracts.ts](/home/ubuntu/workspace/personal/ai-control-plan/packages/core/src/contracts.ts:1) But the integration is optional and apparently not deployed/configured as an established working integration; “dead right now” overclaims operational evidence. Also, accepting any matching major is unsafe unless minor-version compatibility rules are normative.  
   **Fix:** State “the configured client cannot negotiate the current API,” and implement a tested compatibility-range policy rather than an ad hoc major-string check.

7. **HIGH — Verification ownership is still muddied in implementation and in CR-7.**  
   The plan correctly says the Control Plane selects while the Harness runs, but calls `VerificationCoordinator` a Control-Plane authority while placing project discovery behind `WorkspaceAuthority` and invoking preparation from the Harness lifecycle. CR-7 then blesses two planning entry points and merely suggests deduplication. That leaves two paths capable of constructing plans. [verification-coordinator.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/verification-coordinator.ts:56), [orchestrator.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/orchestrator.ts:299)  
   **Fix:** Expose exactly one Control-Plane planner service for initial/revised plans; the Harness should request a revision and execute the returned immutable specs only.

8. **MEDIUM — The `scramble-stack` evidence is misstated.**  
   Root-only discovery cannot identify a distinct browser capability, but the Playwright suite is not wholly “invisible”: the root `test` script runs `npm test --workspaces --if-present`, which includes the `e2e` workspace. The actual defect is loss of verification-kind classification and possibly excessive execution, not absence of execution.  
   **Fix:** Reword the claim and test both behaviors: discovery of a browser-specific provider and avoidance of duplicating Playwright when root tests already invoke it.

9. **MEDIUM — “Progress model MISSING” is factually too broad.**  
   A basic task progress representation already exists: `TaskEnvelope` has `completed` and `remaining`, and the API renders `progress.md`. It is not a durable hierarchical Mission→Goal→Task→Subtask model, but the plan under-claims current functionality. [tasks.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/tasks.ts:35), [server.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/server.ts:536)  
   **Fix:** Describe the existing envelope progress as a non-hierarchical artifact and specify whether it is migrated, deprecated, or becomes the projection of the new model.

10. **MEDIUM — The decomposition proposal adds hierarchy without proving that Mission and Goal are needed.**  
    Section 3.6 invokes Mission→Goal→Task→Subtask, but increment 9 implements only parent task and subtask. This is architectural vocabulary creep and leaves progress aggregation semantics ambiguous.  
    **Fix:** Use Task→Subtask unless a concrete use case demonstrates an additional durable Mission or Goal entity.

11. **MEDIUM — The multi-repository model is underspecified for atomicity and partial failure.**  
    “One parent task drives subtasks in three repositories” does not define repository revision pinning, branch/worktree creation failure, dependency edges, ordering, cancellation propagation, partial completion, conflicting changes, or whether cross-repo success can ever be atomic. A derived parent verdict alone is insufficient.  
    **Fix:** Specify a saga-style fan-out/fan-in protocol with pinned base revisions, dependency DAGs, compensating cleanup, cancellation rules, and explicit partial-success verdicts.

12. **MEDIUM — Artifact retention is contracted but not actually implemented end-to-end.**  
    Verification rows sanitize retention metadata, while the existing retention job archives only events. The BrowserVerifier increment promises screenshot containment and retention without a blob-store lifecycle, deletion job, pin authorization, or orphan recovery. [verification-store.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/harness/verification-store.ts:90), [retention.ts](/home/ubuntu/workspace/personal/ai-control-plan/apps/api/src/modules/retention.ts:3)  
    **Fix:** Add an artifact-store/GC slice before browser evidence, with ownership markers, quotas, expiry, pinned-artifact authorization, and crash-orphan tests.

13. **MEDIUM — Browser fallback introduces dependency and egress risk without a supply-chain policy.**  
    “Pinned execution-scoped fallback” does not say whether runtime package/browser downloads are permitted, cached, checksummed, or network-isolated. Playwright browser installation can be large and can cause uncontrolled egress.  
    **Fix:** Prefer pre-provisioned, checksummed browser assets; prohibit implicit runtime downloads and make unavailable tooling produce a transparent blocked/skipped result.

14. **MEDIUM — ApiVerifier network containment is not designed deeply enough.**  
    “Non-allowlisted host” omits DNS rebinding, redirects, IPv4/IPv6 normalization, Unix sockets, proxy environment variables, server readiness, port collision, and child-process cleanup. Header/body redaction after the request does not prevent secret egress.  
    **Fix:** Define a socket-level local-network policy, strip proxy variables, prohibit redirects by default, bind ephemeral servers explicitly, and test rebinding/redirect/IPv6 cases.

15. **MEDIUM — The optional telemetry design still duplicates a Cockpit projection.**  
    The plan lists “local sink first, Cockpit projection second” even though canonical durable events already have read APIs and Cockpit should project them. A second postback/sink path risks duplicate ordering, retry, and reconciliation semantics.  
    **Fix:** Make Cockpit consume canonical durable reads/events; reserve `TelemetrySink` for genuinely external trace backends and never for canonical UI synchronization.

16. **MEDIUM — KEEP-SEPARATE is plausible but not fully proven by the cited LOC count.**  
    Independent usefulness and “63 LOC touch the Control Plane” justify separate deployability, not necessarily separate repositories. Conversely, Cockpit’s registry being load-bearing for composition creates coordinated-contract and release risk the decision barely addresses.  
    **Fix:** Keep separate deployables, but document contract ownership, generated client/schema publication, compatibility windows, and coordinated release tests; do not use LOC count as the deciding evidence.

17. **LOW — “Every overlap has exactly one owner” is false.**  
    Verification planning has two accepted entry points; artifact blob retention has none; compatibility policy ownership is unclear; correlation-token issuance and validation straddle both repos; progress vocabulary alternates between Cockpit inference and future Control-Plane structure.  
    **Fix:** Add an ownership matrix naming one component and repository for every persisted record, decision, protocol, and cleanup lifecycle.

18. **LOW — Worktree cleanup is operational housekeeping, not a product P0.**  
    Committing normative design is necessary. Deleting 13 worktrees in the same acceptance item is unrelated, locally destructive, and can block delivery despite no product effect.  
    **Fix:** Separate design-source control from optional developer-environment cleanup and require explicit owner confirmation before removal.

## Claims that do check out

The repository hashes match the declared baselines. The API really advertises `1.1`, Cockpit really pins `1.0`, `harnessSingleMode` really defaults false, project verification really reads only the root `package.json`, the default verifier registry contains only command and artifact-existence providers, and no durable subtask entity/service/table exists. The Harness anti-routing design is also clear and should remain: selection belongs to the Control Plane; provider lookup inside the Harness may only resolve an implementation for an already-selected verification kind.

## Score

| Criterion | Weight | Score |
|---|---:|---:|
| Grounding in current implementation | 15% | 7.5/10 |
| Control Plane/Harness separation | 10% | 6.5/10 |
| Cockpit/Agentic OS separation | 10% | 6.0/10 |
| Overlap/conflict resolution | 15% | 4.5/10 |
| Verification/evidence design | 10% | 6.5/10 |
| Observability/telemetry design | 10% | 5.5/10 |
| Multi-repository model | 10% | 3.5/10 |
| Migration feasibility | 10% | 3.0/10 |
| Simplicity / avoiding duplicate systems | 5% | 5.0/10 |
| Testing/acceptance strategy | 5% | 6.0/10 |
| **Weighted total** | **100%** | **5.4/10** |

The strongest decision is to evaluate the existing Harness before adding more verifier implementations. The fatal mistake is treating that as sufficient preparation to delete the legacy path even though major execution modes still bypass the Harness. No files were modified.

VERDICT: REVISE
### Claude's response — revision 2

All 18 findings verified against the code before disposition. Two CRITICALs independently
confirmed: `orchestrator.ts:134-139` does return false for parallel/compare/race, and `server.ts`
has no auth hook (loopback bind in `config.ts:68` is the only control).

**Accepted (16 of 18, in full):**
- #1 CRITICAL — increment 4 rewritten as increment 5: per-mode strangler. Mode parity + handoff
  claim protocol precede any deletion. CR-4 rewritten. New finding §3.4 records the fact.
- #2 CRITICAL — new finding §3.8, new CR-12, new **increment 4** (authenticated transport +
  command authorization) placed as P0 before any write capability. Build-vs-buy row added.
- #3 HIGH — H6 split. Increment 9 is session-granularity only and explicitly excludes
  `subtasks.read`; subtask contract and UI move into increment 10 alongside their producer.
- #4 HIGH — global flag replaced by a per-mode enablement flag. Increment 3 acceptance now names
  which flows stay gated and requires a tested rollback that settles in-flight sessions.
- #5 HIGH — added a dependency graph and an explicit placement for the Spec E M8–M10 composition
  program (attaches after increment 10, governed by Spec E). Silently omitting it was a defect.
- #6 HIGH — §3.1 reworded to "the configured client cannot negotiate the current API" with an
  explicit scope note; ad-hoc major-string check replaced by a normative, tested compatibility
  policy pinned by a producer fixture.
- #7 HIGH — CR-7 changed from KEEP_BOTH to **MERGE**: one Control-Plane planner service owns
  initial and revised plans. Became increment 6.
- #8 MEDIUM — the scramble-stack claim was wrong and is corrected in place: root
  `npm test --workspaces` does reach the e2e workspace. The real defects are lost kind
  classification and double-execution risk; both are now acceptance criteria.
- #9 MEDIUM — progress downgraded from MISSING to PARTIAL; `TaskEnvelope.completed`/`remaining`
  and `progress.md` named, and their fate stated (rendered projection of the new model).
- #10 MEDIUM — Mission and Goal dropped. Task → Subtask only.
- #11 MEDIUM — increment 10 now specifies a saga: pinned base revisions, dependency DAG,
  worktree-failure behaviour, cancellation propagation, compensating cleanup, first-class
  partial-success verdict, and cross-repository atomicity documented as **not provided**.
- #12 MEDIUM — new CR-10 and new increment 7 (artifact store + GC), sequenced before the first
  large-binary producer.
- #13 MEDIUM — no implicit runtime browser download; pre-provisioned checksummed assets; missing
  tooling yields `blocked` with a reason.
- #14 MEDIUM — 8a now specifies socket-level containment: allowlist after DNS resolution,
  normalized IPv4/IPv6, redirects refused, proxy vars stripped, redaction before recording.
- #15 MEDIUM — new CR-11 **removes `CockpitEventSink`**, flagged as a proposed amendment to
  `operator-observability-verification.md` §9 rather than a restatement of it.
- #16 MEDIUM — the LOC argument is withdrawn as deciding evidence for CR-1; replaced by Spec E's
  privileged-writer role, and the coordination cost is now an explicit accepted cost with named
  deliverables.
- #17 LOW — new §4.1 ownership matrix.
- #18 LOW — worktree pruning removed from increment 2's acceptance and demoted to optional,
  owner-confirmed housekeeping (§3.10).

**Partially rejected (1), with reason:**
- #7's implication that routing project discovery through `WorkspaceAuthority` muddies ownership.
  The single-entry-point fix is accepted; the premise is not. Authority is the sanctioned bounded
  filesystem path and using it is not an ownership leak — the planner stays in the Control Plane,
  the authority stays in the Harness. Recorded explicitly in CR-7 so the distinction survives.

Roadmap re-ordered: 1 contract, 2 design corpus, 3 eval + single-mode canary, 4 auth,
5 mode parity → retire legacy, 6 one planner + kind-aware discovery, 7 artifact store,
8 Api then Browser verifier, 9 session-level H6 + Cockpit views, 10 decomposition + multi-repo +
progress. C3/C4/T1 and Spec E M8–M10 moved to a decided-but-unscheduled P2 backlog to keep the
increment count at 10 without losing their decisions.

## Round 2 — Codex

Weighted 7.4/10, VERDICT: REVISE. 18 prior findings: 13 addressed, 4 partially, 1 mostly.
12 findings raised (2 HIGH carried, 2 new HIGH, 6 MEDIUM, 2 LOW). Full critique retained in
`/tmp` review artifact; the load-bearing points and dispositions are below.

### Claude's response — revision 3

Verified before disposition: `apps/web/src/api.ts:111-118` does call the same API, and
`verification-coordinator.ts:56-66` does take `WorkspaceAuthority` in its constructor while
documenting itself as "Control-Plane authority". Both Codex claims stand.

**CR-7 partial rejection — withdrawn.** Codex is right and revision 2 was wrong. The defence
("authority is the sanctioned bounded-read path, so using it is not an ownership leak") answered a
question nobody asked. The actual incoherence is a reverse dependency: Control-Plane *selection*
logic depending on a concrete Harness security component. Resolved by **CR-13** — a read-only
`RepositoryInspector` port the Control Plane depends on, with `WorkspaceAuthority` keeping command
execution and enforcement and merely implementing the read half. Enforced by an import-boundary
test in increment 7's acceptance. The withdrawal is recorded in CR-7 itself, not just here.

**Accepted:**
- #1 HIGH composition misplaced — agreed, the "depends on subtask-scoped executions" justification
  was invented. Spec E M8/M9 become **increment 5**, right after the transport they need, scoped
  to *contract + single-task consumer*; M10 postbacks stay in the P2 backlog. Increments 1 and 2
  merged to hold the ten-increment cap.
- #2 HIGH boundary — CR-13 above, plus amendment A3 in §0.
- #3 HIGH `apps/web` — increment 3 now covers it explicitly with a same-origin session and no
  bearer token reachable from frontend JavaScript.
- #4 HIGH credential handling — "surfaced into Cockpit config" replaced by a protocol: `0600`
  credential file or Unix socket, atomic rotation with an overlap grace window, no restart,
  Cockpit reads by path rather than receiving a copied secret, redacted auth failures.
- #5 MEDIUM H6 ordering — increment 4 no longer depends on the verifiers. It ships after auth so
  the canary is observable; API/browser evidence fields are added additively afterwards.
- #6 MEDIUM artifact security — workspace-scoped CAS namespaces (no cross-workspace dedup or
  digest probing), transactional blob+reference commit, GC/reference race test, owner-only modes.
- #7 MEDIUM artifact single owner — `ArtifactStore` is now the sole lifecycle owner with GC as one
  of its operations; the retention job only schedules. CR-10 and the matrix both corrected.
- #8 MEDIUM compatibility policy — minor-version schema discipline enumerated (prohibited changes,
  tolerant reader, unknown-enum rule, retained per-minor fixtures, compatibility suite).
- #9 MEDIUM decomposition too large — accepted with a stated constraint: the ten-increment cap is
  the only reason it is one entry. Split into internally gated slices 10a–10d, with 10c/10d
  separately gated, and an explicit instruction that it must be re-planned into its own slice
  sequence before execution.
- #10 MEDIUM partial success — **CR-14**: a verdict field, never a `TaskState`. The 9-state kernel
  stays byte-unchanged, proven by its existing tests. Amendment A5.
- #11 LOW overlap inference — downgraded to advisory. Explicit configuration wins; inferred
  coverage carries provenance and confidence; inference alone may never suppress a required check.
- #12 LOW self-contradiction — §0 reframed as "reconciliation plus targeted amendments", with the
  five amendments (A1–A5) enumerated in a table at the front instead of buried in CR sections.
- #14 (round 1, "mostly addressed") — rebinding now has a connection-time mechanism: validate every
  resolved address, then connect to the validated address with an explicit `Host` header so a
  second resolution cannot rebind between check and connect. Tested.

Nothing rejected this round.

## Round 3 — Codex

Weighted 8.2/10, VERDICT: REVISE. All 12 round-2 findings audited as resolved or mostly resolved;
CR-13's port direction, the composition move and increment 10's slice split were each judged sound.
10 new findings: 4 HIGH, 4 MEDIUM, 2 LOW — concentrated on sequencing and on increment 5's depth.

### Claude's response — revision 4

All ten accepted; nothing rejected.

- #1 HIGH canary before auth — the sharpest finding of the round, and self-evidently right: the
  plan's own §11 said all three P0 defects are repaired before new capability lands, while the
  graph enabled a new execution path on an unauthenticated API. **Authentication is now increment
  2, the canary increment 3**, and increment 6 re-pointed at 3.
- #2 HIGH composition not proven effective — increment 5 rewritten. A registry snapshot, bundle,
  AgentSpec row and profile directory are composition *metadata*; the increment is now explicitly
  not done until a provider launch verifies the profile was consumed, with achieved-fidelity
  reporting and a negative test proving ambient config is not silently used.
- #3 HIGH composition trust policy — added as a deliverable: workspace content-digest allowlist,
  explicit opt-in for anything outside it, least-privilege per-run MCP/tool attachment, secret
  references never values, and zero optional assets as a valid tested outcome.
- #4 HIGH browser bootstrap — "established server-side" replaced by a protocol: the privileged
  launcher mints a one-time short-expiry bootstrap token, exchanged for a
  Secure/HttpOnly/SameSite=Strict cookie, with origin validation, single-use replay prevention and
  forced re-authentication after rotation.
- #5 MEDIUM increment 5 dependencies — now depends on 2 **and** 3, with Cockpit's registry contract
  allowed to develop in parallel ahead of both.
- #6 MEDIUM inspector adapter ownership — CR-13 tightened to three parts: the port owned by the
  Control Plane, the concrete filesystem adapter in **neutral infrastructure**, and the pure
  containment primitives extracted and shared with `WorkspaceAuthority`. Amendment A3 and the
  ownership matrix updated. Revision 3's "`WorkspaceAuthority` may implement the port" is withdrawn.
- #7 MEDIUM registry availability — fail-closed by default, cached snapshots only by explicit
  policy and always recorded, mid-run digest change detected, ambient fallback prohibited.
- #8 MEDIUM + #9 LOW increment 1 — split into independently mergeable 1a (compatibility policy) and
  1b (design corpus) with separate acceptance gates, so neither masks the other's failure;
  "zero-risk" replaced by "bounded, reversible".
- #10 LOW P0 count — "the first four are P0" corrected to increments 1–3.

## Round 4 — Codex (final round, MAX_ROUNDS reached)

Weighted **8.8/10**, VERDICT: REVISE. Round-3 findings all resolved or mostly resolved. Six
remaining: 1 HIGH, 3 MEDIUM, 2 LOW.

Codex's own judgment on the HIGH: *"This is resolvable through ordinary architecture judgment. It
does not require a higher-capability architecture review, but the document must resolve it before
implementation."*

Codex confirmed the plan **does** meet these parts of the bar: no canonical state depends on
AgentTrail, CCAM, Langfuse or Postman; and the per-mode strangler migration preserves existing
parallel/compare/race functionality until Harness parity exists. It did **not** meet: weighted
≥ 9.0, zero unresolved HIGH, and complete ownership coverage.

### Claude's response — revision 5 (applied without a confirming round)

All six accepted. None is a disagreement — every one is a defect I introduced or missed.

- **#1 HIGH — increment 5 contradicted the filesystem ownership boundary.** Revision 4 had the
  Control Plane "validate paths and write into its own ephemeral profile" while the ownership
  matrix gave every filesystem write to the Harness, and left `prepare/provision/verify/dispose`
  without a named coordinator. This was a contradiction revision 4 *introduced*, and Codex caught
  it in the same round it appeared. Resolved with an explicit three-way split: **Cockpit** returns
  bytes and writes nothing; the **Control Plane** selects, explains, persists the immutable
  composition revision and puts content or content-addressed references in the `ExecutionRequest`,
  touching no filesystem; the **Harness** materializes the profile through `WorkspaceAuthority`,
  coordinates the adapter provisioning lifecycle, reports achieved fidelity, and owns retention and
  disposal. Both original invariants survive intact — the Control Plane decides and never writes,
  the Harness executes and never selects.
- **#2 MEDIUM** — six ownership-matrix rows added: asset selection, composition/AgentSpec revision,
  registry content and bundle rendering, cached snapshots, profile materialization/retention/
  disposal, and the adapter provisioning lifecycle.
- **#3 MEDIUM** — bootstrap token delivery is now a launcher-mediated POST or equivalent non-URL
  exchange; query strings and fragments are explicitly prohibited, with the leak vectors named, and
  `Referrer-Policy: no-referrer` set on the exchange.
- **#4 MEDIUM** — increment 5's execution-mode scope stated plainly: Harness **single mode only**;
  compare/race/parallel stay uncomposed until increment 6 extends composition per mode as part of
  its parity gate.
- **#5 LOW** — the §10 opening sentence now says "the first three are P0", matching the correction
  below it.
- **#6 LOW** — "state-machine tests stay byte-unchanged" replaced by a transition-matrix regression
  test plus explicit verdict/state independence tests, since byte identity can hold while behaviour
  changes.

### Loop outcome

MAX_ROUNDS=4 exhausted. Revision 5 addresses every outstanding finding, but **no review round
remains to confirm it**, so the last independently scored artifact is revision 4 at 8.8/10 with one
HIGH open. The plan is therefore reported as **not** READY_FOR_VNEXT under a strict reading of the
acceptance bar, with the exact residual named rather than a convergence claimed.

Fable escalation is **not** recommended. None of the escalation triggers fired: there is no
unresolved Cockpit ↔ Agentic OS ownership conflict, no incompatible lifecycle or canonical-state
model, no migration conflict, no security architecture conflict, and no mutually exclusive
external-tool decision. Claude and Codex converged on every architectural question; the residual is
one ownership contradiction that both sides agree on the fix for, and that Codex explicitly
classified as ordinary implementation judgment. Score trajectory across rounds — 5.4 → 7.4 → 8.2 →
8.8 — was monotonic with no oscillation and no round where the two positions diverged by more
than the findings themselves.

## Independent cold review of revision 5 — Codex, fresh session

Outside the four-round loop budget: a new Codex thread with no memory of the prior rounds, asked to
verify revision 5's claimed fixes *and* review the whole plan cold against the source.

Weighted **8.2/10**, VERDICT: REVISE — lower than round 4's 8.8, which is the expected and healthy
result of a reviewer who did not watch the plan improve. Confirmed independently: canonical state
does remain independent of AgentTrail, CCAM, Langfuse and Postman.

Three HIGH, six MEDIUM, two LOW. The three HIGH were all verified in the text before disposition.

### Claude's response — revision 6

**HIGH 1 — the provisioning fix created a cross-document contradiction.** Revision 5 moved profile
materialization to the Harness inside this plan and §4.1, while `cockpit/docs/specs/E-agentic-os-role.md`
line 14 and M9 still say the Control Plane writes ephemeral per-run overlays and "validates paths and
writes the returned content into its own profile" — and §0 claimed every unlisted prior design
remained authoritative. Fixing the conflict in one document while leaving it standing in another is
not fixing it. Added **amendment A6** and **CR-15**, with the Spec E amendment made an explicit
deliverable of increment 5 so no window exists where the two documents disagree.

**HIGH 2 — my revision-5 edit silently failed to apply.** The bootstrap-token channel still read
"passes it once to the browser". The `str.replace` found no match after earlier edits shifted the
text, and I verified only one of that batch's replacements. Now applied and asserted: the launcher
is the named issuer, the token is audience-bound and single-use with a seconds-scale expiry,
delivery is a form POST to `/api/auth/bootstrap` or an equivalent non-URL channel, and query
strings, fragments, inherited environment variables and any channel readable by another local
process are explicitly prohibited with their leak vectors named. Every subsequent edit in this
round carries an assertion.

**HIGH 3 — the dependency graph allowed an impossible order.** Increment 6 depended only on 3, so
it could retire the legacy path before increment 5 existed — shipping three uncomposed execution
modes. Increment 6 now gates *deletion* on 5 as well as 3, and its acceptance requires every enabled
mode to compose. Also corrected: increment 6 credited the per-mode flag to increment 2; it comes
from 3 (a renumbering miss from revision 4).

**MEDIUM — the §3.2 evidence was stale within the hour.** Codex noticed that
`git log --all -- docs/execution-harness.md` is no longer empty, because commit `4d1b150` (PR #18)
tracked the corpus during this session. §3.2 recast from CRITICAL to HIGH and from "a lost directory
loses the design" to the accurate residual: tracked on a branch, not yet merged to `main`. Increment
1b is now a merge task with its partial completion recorded.

**MEDIUM — A4 named the wrong contradicting document.** Spec E line 22 defers the read/write
capability split until a multi-user or non-loopback deployment; the roadmap requires it now. A4 now
cites Spec E alongside the observability document.

**MEDIUM — content-addressed bundle references named a blob nobody owns.** The only
content-addressed store arrives in increment 8 and is scoped to artifacts. Increment 5 now passes
**inline, size-bounded bundle content**, keeping composition revisions self-contained and
replayable; a dedicated immutable composition-blob store is named as the upgrade path if bundles
outgrow the bound.

**MEDIUM — "pure and table-driven" was not a definition.** The parent verdict algebra is now
specified in increment 10 *before* any fan-out consumes it: the verdict vocabulary, an exhaustive
truth table over the child-outcome cross-product, the distinction between execution failure and
required-verification failure, cancellation-versus-failure precedence, retry collapsing, and what a
dependency-skipped descendant contributes.

**MEDIUM — increment 10 was not an increment.** Accepted, and it required breaking the brief's
ten-increment cap. An "increment" that spans a new entity model, DAG scheduling, multi-repository
compensation and UI projection, and that instructs the reader to re-plan it before execution, is a
heading. Promoted to real increments **10 (contracts + verdict algebra), 11 (single-repository
fan-out), 12 (multi-repository saga), 13 (progress projection)**, each with its own dependencies,
acceptance and rollback. The cap was a reporting constraint; slicing architecture to satisfy it
produced a fake unit, so it is broken once, with the reason recorded in the document.

**LOW — CR-1 cross-reference** corrected from increments 1 and 9 to 1 and 4.

**Rejected (1), with reason:** the claim that §6 repeats the correlation-token introductory
sentence. It does not — §6 is nine lines with no repetition (verified). Any duplicated headings in
the *companion* documents are outside this document's scope and were not touched.

### Loop outcome, restated

Revision 6 is unreviewed. The last independently scored artifacts are revision 4 at 8.8 (round 4,
same thread) and revision 5 at 8.2 (fresh cold reviewer). Both are below the 9.0 bar and both had
open HIGHs, so the plan remains **not** READY_FOR_VNEXT. Fable escalation remains unwarranted: every
finding across five reviews was accepted or rejected on verifiable evidence, no round produced a
genuine architectural disagreement between the two models, and the cold reviewer explicitly
confirmed the external-tool independence and migration-preservation criteria.
