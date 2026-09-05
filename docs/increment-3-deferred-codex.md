# Increment 3 — deferred Codex passes

Codex hit its account usage limit during the claudex-loop Phase 2 review (resets **2026-09-07 06:53**). Two Codex passes are owed and were deferred; run them once quota is back and fold the results into `docs/increment-3-eval-canary-review-log.md`.

Increment 3 was **built by Claude** in the interim (Phase 3, Claude-built path, commits `09174dd`..`5b7c074` on `increment-3-eval-canary`). The plan is `docs/increment-3-eval-canary-plan.md` Rev 5, which had already absorbed every finding from Codex review rounds 1-4. Build status is in the review log's `## Phase 3 — Claude build` section: everything is built, tested, and green except the real-credentialled `pnpm eval` run (§4 step 22's hard completion gate) — no provider credentials were available in the building session. Run that gate first if it still hasn't landed; it changes what "cold" means for the inspection below.

---

## Pass 1 — the outstanding review round 5 (verdict on Rev 5)

Resume the **same** review thread and ask for the round-5 verdict on the plan as it stood at Rev 5 (tag/commit the plan doc first if it has moved since).

```bash
cd ~/workspace/personal/ai-control-plan
codex exec resume 01a06be2-da39-7101-a18e-ba285f6571a5 -c sandbox_mode="read-only" --json \
  -o /tmp/codex-i3-r5.txt \
  "Round 5 of 5 (the cap), delayed by a quota limit. Re-review docs/increment-3-eval-canary-plan.md (Rev 5 — the review log records every round-1..4 disposition). Confirm the round-4 findings are addressed and flag anything material that remains. End with VERDICT: APPROVED or VERDICT: REVISE." \
  < /dev/null 2>/dev/null >/dev/null
cat /tmp/codex-i3-r5.txt
```

Append the verdict + critique to the review log under `## Round 5 — Codex`. If REVISE with material findings, arbitrate them against the already-built code (the loop is at its cap, so this is a fix-list, not another revise cycle).

## Pass 2 — post-build cross-inspection (inspect=on, deferred)

The claudex-loop default is a fresh **read-only** Codex session inspecting the Claude-built diff cold (NOT the review thread). `MAX_INSPECTION_ROUNDS=2`. This was deferred with the review, never opted out.

```bash
cd ~/workspace/personal/ai-control-plan
BASE=ebe1c41b6d2cc90c86e7ffd5df744126768cb24f   # git merge-base main increment-3-eval-canary (re-derive if either has moved)
codex exec -s read-only --json -o /tmp/codex-i3-inspect.txt "$(cat <<PROMPT
You are doing a cold PR-style review of a completed implementation. Read docs/increment-3-eval-canary-plan.md (the spec, Rev 5) and docs/increment-3-eval-canary-review-log.md (rounds 1-5). Then review the diff of branch increment-3-eval-canary against ${BASE}: git diff ${BASE}...HEAD. You are read-only; do NOT modify files.
Report PR-style findings only — correctness, spec fidelity vs the plan, edge cases, missing tests, anything that would break the acceptance criteria (four safety-net files green with single mode ON on the Harness path; recovery-chaos + E2E scenario suites; real Claude + real Codex single-mode E2E with durable sessions/plan revisions/verification results; scorecard names the gated flows; rollback = new-starts-legacy + in-flight settle to terminal under HarnessRecovery, proven by a test). No verdict line needed — this is advisory review, not a gate.
Focus especially on: the per-mode flag back-compat shim and precedence; the HarnessRecovery rollback-terminalisation policy (typed failure, fail-closed mode resolution, exhaustive non-terminal state coverage, forced-quarantine independence from mode enablement, full boot sequence + idempotency); the boot-orchestrator.ts test factory actually routing through the Harness (execution_request_id discriminator asserted on every run); the eval/ workspace isolation (fixture temp-dir + git init + repoAllowlist + cleanup; bearer auth from the credential file, redacted); the scorecard schema + JSON-and-MD both committed.
PROMPT
)" < /dev/null 2>/dev/null | grep '"type":"thread.started"'
cat /tmp/codex-i3-inspect.txt
```

Arbitrate each finding (accept → fix + rerun affected tests, or reject with a logged reason), cap at 2 inspection rounds, and append to the review log under `## Post-build inspection`.
