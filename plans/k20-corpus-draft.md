# K20 corpus draft: for the owner's approval

Status: **draft, not approved.** No replay may use this corpus until the owner approves it (K20
proposal §6). This file is the human-readable form of `plans/k20-corpus-draft.jsonl`, and holds
the same 208 goals in the same order. If the two disagree, the JSONL is the data and this file is wrong.

Each goal records its source:

| Source | Count | Meaning |
|---|---|---|
| `operator-db` | 6 | Unique task goals from the operator workspace DB, verbatim. The ref is the first task id with that goal. |
| `eval-scenario` | 10 | Goals from the harness scenarios under `eval/`. The ref is the scenario file. |
| `repo-task-goal` | 92 | Goals found in this repo's tests, fixtures and docs. The ref is the file. Template strings are dropped, and `[FAKE:…]` and `[demo …]` markers are stripped. |
| `synthetic` | 100 | **Written by the drafting agent, not taken from real use.** Each carries a probe tag naming what it tests. |
| **Total** | **208** | |

Before approving, note the following:

- Three of the six `operator-db` goals, k20-004 to k20-006, were written by an agent for the K19j
  and parity runs. The operator did not type them. They are real rows, but they are not organic
  use.
- The operator DB now holds one more unique goal, from the harness-flip verification on
  2026-09-25 (`AG-muhgmr4g2`). It is agent-written, so it is left out.
- 92 of the goals are `repo-task-goal` test stubs, and many are only a few words long. They
  exercise the classifier's short-input behaviour, not realistic intake.
- The goals carry no expected labels. Labels come from the human reading in K20 step 6.
- The judge must never see a goal the owner has not cleared for egress. Approving this file also
  clears the `operator-db` goals for that egress.

Probe tags on the synthetic goals: `ambiguous` 10, `coding` 15, `general` 12, `high-stakes` 10, `long-horizon` 5, `mixed-language` 3, `needs-repo` 5, `read-only` 10, `research` 10, `review` 10, `substring-trap` 10.

| id | source | ref / probe | goal |
|---|---|---|---|
| k20-001 | operator-db | `AG-mt65evtp1` | this is a test for checking the control panel tool. give me your honest opionion which ai assistant and model will you use for building plan for a pc game similar to GTA 3 |
| k20-002 | operator-db | `AG-mtpw0v9q1` | Reply with the single word: ready. Do not modify any files. |
| k20-003 | operator-db | `AG-mu35r74i1` | hello there, as i remember i had a picture for the agentic os which is slighly different both from BE and FE can find this image and figure out if there is a progress for changes to that goal? |
| k20-004 | operator-db (agent-written) | `AG-mufk50oq1` | Using the claude-mem memory search tools, find the most recent observation about the K19j MCP tool policy and state its title in one sentence. Then list the directory names under ~/.agent-plane. Do not modify any files. |
| k20-005 | operator-db (agent-written) | `AG-mugvnmwk1` | In the current working directory, create a file named parity.txt containing the single line parity-check. Then print the absolute path of the current working directory and the contents of parity.txt. Do not read or write any other path. |
| k20-006 | operator-db (agent-written) | `AG-mugvnmwu2` | Use the Bash tool to run exactly this command: ls ~/.agent-plane/personal -- then report how many entries it printed. Do not modify any files. |
| k20-007 | eval-scenario | `eval/scenarios/cross-provider-reroute.ts` | Ship it |
| k20-008 | eval-scenario | `eval/scenarios/happy-path.ts` | Fix src/add.mjs so `pnpm test` passes (add(2, 3) should be 5, it currently subtracts). |
| k20-009 | eval-scenario | `eval/scenarios/adapter-error-mid-run.ts` | Do the thing |
| k20-010 | eval-scenario | `eval/scenarios/model-shadow.ts` | Implement the parser |
| k20-011 | eval-scenario | `eval/scenarios/boot-crash-recovery.ts` | long one |
| k20-012 | eval-scenario | `eval/scenarios/quota-wait-and-resume.ts` | Complete the quota continuation |
| k20-013 | eval-scenario | `eval/scenarios/replan-needed.ts` | Add a "lint" script to package.json that runs `node lint.mjs`, and remove the TODO marker from src/clean.mjs so lint.mjs passes. |
| k20-014 | eval-scenario | `eval/scenarios/context-pressure.ts` | Finish the revision |
| k20-015 | eval-scenario | `eval/scenarios/hits-token-cap.ts` | Burn the quota |
| k20-016 | eval-scenario | `eval/scenarios/needs-approval.ts` | needs sign-off |
| k20-017 | repo-task-goal | `apps/api/test/render.test.ts` | Fix the authentication refresh-token race |
| k20-018 | repo-task-goal | `apps/api/test/context-endpoint.test.ts` | observe me |
| k20-019 | repo-task-goal | `apps/api/test/workspace-isolation.test.ts` | personal secret work |
| k20-020 | repo-task-goal | `apps/api/test/workspace-isolation.test.ts` | touch personal code |
| k20-021 | repo-task-goal | `apps/api/test/workspace-isolation.test.ts` | legit work |
| k20-022 | repo-task-goal | `apps/api/test/resource-slots.test.ts` | do the work |
| k20-023 | repo-task-goal | `apps/api/test/resource-slots.test.ts` | needs a person |
| k20-024 | repo-task-goal | `apps/api/test/resource-slots.test.ts` | implement the change |
| k20-025 | repo-task-goal | `apps/api/test/resource-slots.test.ts` | upstream work |
| k20-026 | repo-task-goal | `apps/api/test/auth.test.ts` | SSE canary |
| k20-027 | repo-task-goal | `apps/api/test/quota-probe.test.ts` | wait for headroom |
| k20-028 | repo-task-goal | `apps/api/test/quota-probe.test.ts` | needs headroom |
| k20-029 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | nightly retro |
| k20-030 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | per-minute sweep |
| k20-031 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | ordinary requirements parity |
| k20-032 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | apia sweep |
| k20-033 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | fold retro |
| k20-034 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | per-minute fold sweep |
| k20-035 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | lord howe sweep |
| k20-036 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | lord howe fold |
| k20-037 | repo-task-goal | `apps/api/test/schedule-queue.test.ts` | lord howe gap |
| k20-038 | repo-task-goal | `apps/api/test/orchestrator.test.ts` | Delete something |
| k20-039 | repo-task-goal | `apps/api/test/orchestrator.test.ts` | Slow task |
| k20-040 | repo-task-goal | `apps/api/test/orchestrator.test.ts` | Cancel me |
| k20-041 | repo-task-goal | `apps/api/test/orchestrator.test.ts` | redaction test |
| k20-042 | repo-task-goal | `apps/api/test/decision-service.test.ts` | fix the bug |
| k20-043 | repo-task-goal | `apps/api/test/parallel.test.ts` | Implement the feature |
| k20-044 | repo-task-goal | `apps/api/test/parallel.test.ts` | Fix the auth bug |
| k20-045 | repo-task-goal | `apps/api/test/artificial-analysis.test.ts` | route anyway |
| k20-046 | repo-task-goal | `apps/api/test/artificial-analysis.test.ts` | migrate the payments ledger on branch release/pci |
| k20-047 | repo-task-goal | `apps/api/test/artificial-analysis.test.ts` | unchanged routing |
| k20-048 | repo-task-goal | `apps/api/test/project-verification-cutover.test.ts` | change it |
| k20-049 | repo-task-goal | `apps/api/test/model-catalog.test.ts` | refactor the billing secret rotation |
| k20-050 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | finish this |
| k20-051 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | bounded attempt |
| k20-052 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | route with quota |
| k20-053 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | claim boundary |
| k20-054 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | route transaction |
| k20-055 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | atomic claim |
| k20-056 | repo-task-goal | `apps/api/test/quota-scheduler.test.ts` | cancel claim |
| k20-057 | repo-task-goal | `apps/api/test/characterization.test.ts` | hand this over |
| k20-058 | repo-task-goal | `apps/api/test/characterization.test.ts` | compare approaches |
| k20-059 | repo-task-goal | `apps/api/test/router-model.test.ts` | a task routed a week ago |
| k20-060 | repo-task-goal | `apps/api/test/router-model.test.ts` | Review this pull request |
| k20-061 | repo-task-goal | `apps/api/test/scheduler.test.ts` | review this |
| k20-062 | repo-task-goal | `apps/api/test/scheduler.test.ts` | review earlier work |
| k20-063 | repo-task-goal | `apps/api/test/scheduler.test.ts` | preserve me |
| k20-064 | repo-task-goal | `apps/api/test/scheduler.test.ts` | continue carefully |
| k20-065 | repo-task-goal | `apps/api/test/scheduler.test.ts` | run the reviewer |
| k20-066 | repo-task-goal | `apps/api/test/failover.test.ts` | Ship the feature |
| k20-067 | repo-task-goal | `apps/api/test/failover.test.ts` | Burn quota |
| k20-068 | repo-task-goal | `apps/api/test/failover.test.ts` | Nowhere to go |
| k20-069 | repo-task-goal | `apps/api/test/failover.test.ts` | Crashy task |
| k20-070 | repo-task-goal | `apps/api/test/failover.test.ts` | No auto failover |
| k20-071 | repo-task-goal | `apps/api/test/failover.test.ts` | Parked work |
| k20-072 | repo-task-goal | `apps/api/test/failover.test.ts` | Long task |
| k20-073 | repo-task-goal | `apps/api/test/failover.test.ts` | Edit the repo |
| k20-074 | repo-task-goal | `apps/api/test/harness/cutover.test.ts` | will reject |
| k20-075 | repo-task-goal | `apps/api/test/harness/mode-rollback.test.ts` | after rollback |
| k20-076 | repo-task-goal | `apps/api/test/harness/handoff.test.ts` | Ship the widget |
| k20-077 | repo-task-goal | `apps/web/e2e/shell.spec.ts` | Review migration |
| k20-078 | repo-task-goal | `apps/web/e2e/shell.spec.ts` | Check route ownership |
| k20-079 | repo-task-goal | `apps/web/e2e/demo-b.spec.ts` | Implement the earlier parser milestone |
| k20-080 | repo-task-goal | `apps/web/e2e/operator-closure.spec.ts` | Inspect context evidence |
| k20-081 | repo-task-goal | `apps/web/e2e/review.spec.ts` | Review deployment |
| k20-082 | repo-task-goal | `apps/web/e2e/review.spec.ts` | Unstarted draft |
| k20-083 | repo-task-goal | `apps/web/e2e/review.spec.ts` | Legacy approval |
| k20-084 | repo-task-goal | `apps/web/e2e/review.spec.ts` | Read availability check |
| k20-085 | repo-task-goal | `apps/web/e2e/demo-a.spec.ts` | Publish the nightly digest |
| k20-086 | repo-task-goal | `apps/web/e2e/demo-a.spec.ts` | Rotate the access logs |
| k20-087 | repo-task-goal | `apps/web/e2e/demo-a.spec.ts` | Draft the quarterly summary |
| k20-088 | repo-task-goal | `apps/web/e2e/demo-a.spec.ts` | Continue the migration |
| k20-089 | repo-task-goal | `apps/web/e2e/auth.spec.ts` | e2e stream |
| k20-090 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Refactor the billing reconciliation service |
| k20-091 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Generate release notes for 2.4 |
| k20-092 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Continue the warehouse migration |
| k20-093 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Review the deployment plan |
| k20-094 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Harden the webhook signature check |
| k20-095 | repo-task-goal | `apps/web/e2e/visual.spec.ts` | Index the design documents |
| k20-096 | repo-task-goal | `apps/web/e2e/standalone-shell.spec.ts` | Review the proposed migration |
| k20-097 | repo-task-goal | `apps/web/e2e/standalone-shell.spec.ts` | Recover the canonical read |
| k20-098 | repo-task-goal | `apps/web/e2e/standalone-shell.spec.ts` | Reconcile streaming evidence |
| k20-099 | repo-task-goal | `apps/web/e2e/demo-a5.spec.ts` | Build the release candidate |
| k20-100 | repo-task-goal | `apps/web/e2e/demo-a5.spec.ts` | Publish the release notes |
| k20-101 | repo-task-goal | `apps/web/e2e/demo-a5.spec.ts` | Run the flaky integration gate |
| k20-102 | repo-task-goal | `apps/web/e2e/demo-a5.spec.ts` | Ship if the gate is green |
| k20-103 | repo-task-goal | `apps/web/e2e/demo-a5.spec.ts` | Post the nightly ops digest |
| k20-104 | repo-task-goal | `packages/core/test/model-intelligence.test.ts` | Fix the failing auth test quickly |
| k20-105 | repo-task-goal | `packages/core/test/model-intelligence.test.ts` | Write the module |
| k20-106 | repo-task-goal | `packages/core/test/model-intelligence.test.ts` | Do it on the cheapest model |
| k20-107 | repo-task-goal | `packages/core/test/model-intelligence.test.ts` | Ship the parser |
| k20-108 | repo-task-goal | `packages/core/test/model-intelligence.test.ts` | Review this PR |
| k20-109 | synthetic | probe: `substring-trap` | Update the mailing address shown on the contact page |
| k20-110 | synthetic | probe: `substring-trap` | Summarise the latest release notes for the team |
| k20-111 | synthetic | probe: `substring-trap` | Why is the padding on the settings card uneven? |
| k20-112 | synthetic | probe: `substring-trap` | Check which contestants registered after Friday |
| k20-113 | synthetic | probe: `substring-trap` | Find the auditorium booking for next week |
| k20-114 | synthetic | probe: `substring-trap` | Give me the attestation status of the K8 egress test |
| k20-115 | synthetic | probe: `substring-trap` | Rebuild my understanding of how the scheduler wakes tasks |
| k20-116 | synthetic | probe: `substring-trap` | What does the protest log say about yesterday's outage? |
| k20-117 | synthetic | probe: `substring-trap` | Explain the difference between an addendum and an appendix |
| k20-118 | synthetic | probe: `substring-trap` | Is the greatest-common-divisor helper still used anywhere? |
| k20-119 | synthetic | probe: `read-only` | Read the router module and tell me how failover is decided. Do not modify any files. |
| k20-120 | synthetic | probe: `read-only` | List the migrations in apps/api/src/db/migrations. No changes. |
| k20-121 | synthetic | probe: `read-only` | Look at the failing CI job and describe the cause, read-only. |
| k20-122 | synthetic | probe: `read-only` | Inspect the worktree for uncommitted changes and report them without touching anything. |
| k20-123 | synthetic | probe: `read-only` | Tell me which tests cover the tool gate. Do not edit anything. |
| k20-124 | synthetic | probe: `read-only` | Check whether the fix for the lease sweeper is on main; do not modify files. |
| k20-125 | synthetic | probe: `read-only` | Show me the current routing weights, read-only please. |
| k20-126 | synthetic | probe: `read-only` | Count the decision records per site. No changes to the database. |
| k20-127 | synthetic | probe: `read-only` | Review the diff on this branch but do not change any code. |
| k20-128 | synthetic | probe: `read-only` | Explain why test_calc.py fails; do not fix it yet. |
| k20-129 | synthetic | probe: `high-stakes` | Publish version 2.3.0 of the core package to npm |
| k20-130 | synthetic | probe: `high-stakes` | Force-push the rebased branch over origin/main |
| k20-131 | synthetic | probe: `high-stakes` | Drop the staging analytics table and recreate it empty |
| k20-132 | synthetic | probe: `high-stakes` | Deploy the API to production after the tests pass |
| k20-133 | synthetic | probe: `high-stakes` | Run terraform destroy on the old preview environment |
| k20-134 | synthetic | probe: `high-stakes` | Merge PR 61 with admin override, the checks are flaky |
| k20-135 | synthetic | probe: `high-stakes` | Delete the release tag v1.9.0 and its GitHub release |
| k20-136 | synthetic | probe: `high-stakes` | Rotate the operator API credential and revoke the old one |
| k20-137 | synthetic | probe: `high-stakes` | Truncate the events table on the operator workspace to free space |
| k20-138 | synthetic | probe: `high-stakes` | Push the hotfix directly to main and tag it |
| k20-139 | synthetic | probe: `coding` | Fix the off-by-one error in the pagination helper |
| k20-140 | synthetic | probe: `coding` | Implement a retry with backoff in the quota probe client |
| k20-141 | synthetic | probe: `coding` | Refactor the orchestrator settle path into smaller functions |
| k20-142 | synthetic | probe: `coding` | Add a unit test for the scratch sweep on boot |
| k20-143 | synthetic | probe: `coding` | Migrate the checkpoint table to store diff stats as JSON |
| k20-144 | synthetic | probe: `coding` | Rename the harness bridge methods to match the contract doc |
| k20-145 | synthetic | probe: `coding` | Write a migration that adds a classifier_version column to tasks |
| k20-146 | synthetic | probe: `coding` | Make the lease sweeper interval configurable |
| k20-147 | synthetic | probe: `coding` | Replace the three regex copies with one shared classifier function |
| k20-148 | synthetic | probe: `coding` | The web build fails on a missing import; repair it |
| k20-149 | synthetic | probe: `coding` | Port the floor-discovery job to read JSONL input |
| k20-150 | synthetic | probe: `coding` | Create a CLI command that prints the prompt rate per workspace |
| k20-151 | synthetic | probe: `coding` | Update the Codex adapter to the new SDK event names |
| k20-152 | synthetic | probe: `coding` | Remove the deprecated harnessSingleMode config key |
| k20-153 | synthetic | probe: `coding` | Bump better-sqlite3 and fix whatever breaks |
| k20-154 | synthetic | probe: `review` | Review PR 60 and list correctness issues |
| k20-155 | synthetic | probe: `review` | Audit the approval service for race conditions |
| k20-156 | synthetic | probe: `review` | Critique the K20 proposal before I approve it |
| k20-157 | synthetic | probe: `review` | Look over the diff in this branch and point out risky changes |
| k20-158 | synthetic | probe: `review` | Do a security review of the credential rotation script |
| k20-159 | synthetic | probe: `review` | Go through the session-input contract and flag gaps against the code |
| k20-160 | synthetic | probe: `review` | Check this migration for data-loss risks before it merges |
| k20-161 | synthetic | probe: `review` | Give me feedback on the parity report's recommendation |
| k20-162 | synthetic | probe: `review` | Review the new floors for false positives on common git commands |
| k20-163 | synthetic | probe: `review` | Assess whether the recovery tests cover every session state |
| k20-164 | synthetic | probe: `research` | Research how other schedulers handle overlapping cron occurrences |
| k20-165 | synthetic | probe: `research` | Investigate why the first harness batch stalled for 70 seconds |
| k20-166 | synthetic | probe: `research` | Compare the Claude and Codex adapters' approval relay semantics |
| k20-167 | synthetic | probe: `research` | Explain how the K13 cohort key is built |
| k20-168 | synthetic | probe: `research` | Why does the legacy path resume provider sessions but the harness does not? |
| k20-169 | synthetic | probe: `research` | What are the trade-offs of storing task kind at intake versus at read time? |
| k20-170 | synthetic | probe: `research` | Find out which providers emit limit.approaching events |
| k20-171 | synthetic | probe: `research` | Survey prompt-injection defences for tool-approval classifiers |
| k20-172 | synthetic | probe: `research` | Summarise the evidence behind the K19i floors decision |
| k20-173 | synthetic | probe: `research` | How much does a nightly judge run cost on this account? |
| k20-174 | synthetic | probe: `general` | Reply with the single word: ready. |
| k20-175 | synthetic | probe: `general` | Hello, what can you do in this workspace? |
| k20-176 | synthetic | probe: `general` | Draft a short status update for the team about the harness flip |
| k20-177 | synthetic | probe: `general` | Write a haiku about quota limits |
| k20-178 | synthetic | probe: `general` | Translate the rollout runbook summary into Hebrew |
| k20-179 | synthetic | probe: `general` | Plan my week around the soak review on the 17th |
| k20-180 | synthetic | probe: `general` | Remind me what we decided about the MCP tool policy |
| k20-181 | synthetic | probe: `general` | Turn these meeting notes into a checklist |
| k20-182 | synthetic | probe: `general` | Pick a name for the new decision site |
| k20-183 | synthetic | probe: `general` | Tidy up my notes file in the scratch directory |
| k20-184 | synthetic | probe: `general` | Make a table of the open PRs and who owns each |
| k20-185 | synthetic | probe: `general` | Brainstorm three names for the operator console |
| k20-186 | synthetic | probe: `long-horizon` | Over the next two weeks, migrate all telemetry reads to the stored task kind |
| k20-187 | synthetic | probe: `long-horizon` | Build the K22 operator surface end to end, including the calibration panel |
| k20-188 | synthetic | probe: `long-horizon` | Rewrite the scheduler to support multi-workspace pools |
| k20-189 | synthetic | probe: `long-horizon` | Take the K20 classifier from proposal to shadow soak, with a report each day |
| k20-190 | synthetic | probe: `long-horizon` | Port the web UI to the new design system, page by page |
| k20-191 | synthetic | probe: `needs-repo` | In the ai-control-plan repo, run the test suite and report failures |
| k20-192 | synthetic | probe: `needs-repo` | On branch feat/x in this repository, resolve the merge conflict in server.ts |
| k20-193 | synthetic | probe: `needs-repo` | Open the repo's CHANGELOG and add an entry for 1.4.0 |
| k20-194 | synthetic | probe: `needs-repo` | Bisect the regression in the scheduler tests on this repo |
| k20-195 | synthetic | probe: `needs-repo` | Squash the last three commits on the task branch into one |
| k20-196 | synthetic | probe: `ambiguous` | Make it better |
| k20-197 | synthetic | probe: `ambiguous` | Handle the thing from yesterday |
| k20-198 | synthetic | probe: `ambiguous` | Do the usual checks |
| k20-199 | synthetic | probe: `ambiguous` | Sort out the tests |
| k20-200 | synthetic | probe: `ambiguous` | Can you look at this? |
| k20-201 | synthetic | probe: `ambiguous` | Follow up on the review |
| k20-202 | synthetic | probe: `ambiguous` | Test whether the new floors fire on the corpus, then fix any that misfire |
| k20-203 | synthetic | probe: `ambiguous` | Explain and then fix the flaky scheduler test |
| k20-204 | synthetic | probe: `ambiguous` | Review the fix and add a test if one is missing |
| k20-205 | synthetic | probe: `ambiguous` | Research a better regex and implement it |
| k20-206 | synthetic | probe: `mixed-language` | תקן את הבאג בפונקציית החיבור |
| k20-207 | synthetic | probe: `mixed-language` | Explique pourquoi le test échoue |
| k20-208 | synthetic | probe: `mixed-language` | 修复登录页面的错误 |
