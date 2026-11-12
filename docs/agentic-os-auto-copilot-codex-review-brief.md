# Codex review brief — Agentic OS operating plan

Whole-document reviews are **closed**. Revision 2 was reviewed at `662e020` (FAIL, 13; ledger
§I.2), revision 3 at `a15ce6e` (FAIL, 14; §I.4) and revision 4 at `954ba49` (FAIL, 14;
disposition §0.2). Revision 5 adopts the Architecture Freeze Gate (plan §0): after #163 merges,
reviews look at **implementation PRs** and the code they change.

**For an implementation PR,** paste the block below with these changes. Replace "Review
docs/agentic-os-auto-copilot-plan.md …" with "Review PR #<n> (slice <id>) against the plan sections
it names". Limit the attack list to the slice's area. Check that every G-test the slice claims in
§F/§G exists and passes. A finding that says the design itself is wrong must cite new evidence
(§0.1 rule 4).

Historical brief, kept for reference:

```
You are an independent reviewer. Repo osovlanski/ai-control-plan, branch claude/project-thread-qo32zd
(PR #163). Read AGENTS.md and docs/PROJECT_MEMORY.md; they bind you. Review
docs/agentic-os-auto-copilot-plan.md (revision 4; also check each §I.4 resolution) against the CODE, not against other docs. The diff and the code are
ground truth. Do not edit files, do not push, do not merge. Read-only.

Check every row of §B (inventory) that cites a file: open the file and confirm or refute the claim.
Then attack the plan on:
1. Hidden single points of failure (the OCI box, the single SQLite file, the dispatcher, GitHub token).
2. Duplicate sources of truth (backlog vs plane vs GitHub; does any state have two writers?).
3. Unverified provider capabilities (anything claimed for Claude, Codex, AA or Jev without a test or a
   recorded live run).
4. Subscription and cost assumptions (§D.2; flag anything that reads as using a subscription login for
   a service used by others, or tokens leaving the machine).
5. Unsafe recovery and replay: can P0-5 (publication by identity) or P0-6 (selectNext + create-ref
   reservation) create duplicate tasks, refs, pushes or PRs under a timeout, crash or restart? Is
   "release at terminal" (K4b §3) handled by the launch gate and P0-3?
6. Does every launch path enforce the K4b pool and the proposed launch gate for autopilot tasks?
   Trace apps/api/src/server.ts POST /api/tasks (wait attach) -> scheduler.ts wake/resourceGate and
   continueDispatch -> orchestrator startTask -> assertLaunchClaim. Name any path that starts a
   provider without passing where assertAutopilotLaunch is proposed.
7. Unbounded automation: what stops the loop (per-night cap, token caps, kill switch)?
8. Missing acceptance tests in §F and §G.
9. Overengineering: anything in §C.6 (AI Doctor), §C.7 (provider manifest) or §E that the first
   autonomous loop does not need.
10. UI features that distract from the chat/CLI primary workflow.

Output: a numbered list of findings, each as
  [severity: blocker|high|medium|low] [area] claim — evidence (file:line or test name) — recommendation
then a short "agree / disagree" line per row of the plan's dispute log. End with exactly one verdict:
PASS (plan is sound as written) / FAIL (at least one blocker) / BLOCKED / SKIP.
```

Review comment format (for the PR): one comment, title "Codex review of revision 4 at <commit SHA>",
the findings list, the dispute-log lines, and the verdict. The reviewer names the commit SHA it read.
