# Phase 7 continuation — 2026-10-30

> Note (2026-10-31): the attribution slice below landed as #121, not #122 (#122 was closed in favour of #121).
> The "Next slices, in order" list still stands.

This is the handoff for continuing in Codex or Claude. Implementation evidence wins over the
older Phase 7 close record in `PROJECT_MEMORY.md`. Phase 7 remains open.

## Starting point

The local checkout was clean on `fix/web-parallel-composition` (`d2023d6`). Work continued on
`feat/phase7-usage-reconciliation`, created from fetched `origin/main` at `dd2a7e2`.
No other checkout, operator instance, provider credentials or Cockpit working tree was changed.

GitHub was checked directly, rather than assuming the previous session's handoff was current:

| PR | Observed status at the start of this continuation |
| --- | --- |
| [#118](https://github.com/osovlanski/ai-control-plan/pull/118) | Merged at `dd2a7e2`. Includes the unpriced-model test fix. |
| [#119](https://github.com/osovlanski/ai-control-plan/pull/119) | Open, not draft, merge conflicts reported. Crash-recovery restart route. |
| [#120](https://github.com/osovlanski/ai-control-plan/pull/120) | Open, not draft, merge conflicts reported. Revision model binding. |
| [#115](https://github.com/osovlanski/ai-control-plan/pull/115) | Open, draft. Body still records the standalone-shell locator failure and a required full e2e rerun. |

These statuses can change. Re-fetch before acting. Agents prepare PRs; the owner merges.
Local `git merge-tree --write-tree --name-only` against `dd2a7e2` confirmed #119's conflicts in
`apps/api/test/accounting-real-adapters.test.ts` and `docs/PROJECT_MEMORY.md`; #120 conflicts in
`apps/api/test/accounting-real-adapters.test.ts`. These were read-only merge simulations; neither
remote branch was changed.

## Implemented slice: attribute imported usage to a unique run

The Phase 7 close record found that Cockpit posts `runId: null`, while settlement queried only
`usage_records.run_id`. Cockpit's tracked `usageImport.ts` confirms that it sends provider-qualified
session references and environment assistant names (`claude`, `codex`), which need not equal the
plane's configured assistant ids.

`UsageLedger.runIdFor` now resolves an absent run id through `(provider, provider_session_ref)`
only if exactly one run matches in this workspace's database. `recordsForRun` applies that rule
at read time alongside explicitly bound records. Consequently:

- An import can contribute to the task budget without the importer knowing a plane run id.
- An import received before the run identity is persisted is found on a later settlement read.
- A provider mismatch, missing session, external session or session shared by several runs is
  left unattributed. An explicit valid run id retains its existing meaning.
- The submitted record is never rewritten. The body digest, null run id, replay response and
  conflict semantics remain unchanged. There is no schema change or migration.
- A newly delivered, uniquely attributable import invokes the existing late-overrun path.
- Existing settlement semantics remain `max(in-run total, combined import total)`, never their
  sum. Within imports, deltas sum and cumulative evidence subsumes deltas as before.

Changed production paths: `apps/api/src/modules/usage.ts`,
`apps/api/src/modules/composer/accounting.ts`, and the usage route in `apps/api/src/server.ts`.
Regression coverage: `apps/api/test/usage-reconciliation.test.ts`.

## Verification

**Verdict: PASS for this attribution slice.** The targeted accounting/ingestion run passed:
3 files, 22 tests, including all five new reconciliation tests.

`pnpm typecheck && pnpm test` passed on the final code: core 584, adapters 154 (+1 skipped),
API 1,630 (+83 skipped), web 94 — 2,462 passed, 84 skipped overall. The API's 101 files all
passed, including the previously reported flaky provisioning teardown test. `pnpm lint` and
`git diff --check` also passed. The staged/unstaged/last-commit secret scan found no credential;
one broad-pattern match was manually confirmed to be a repository path.

The API was driven over HTTP while running `pnpm --filter @agent-plane/api dev`, using a scratch
workspace, a scratch git repository, the existing fake Cockpit registry/bundle server and the fake
assistant. No provider calls or quota were used. Observed:

| Action | Result |
| --- | --- |
| Start a composed run and wait for completion | `COMPLETED`, 1,650 in-run tokens |
| Import a 6,000-token delta with `runId: null`, matching provider/session, assistant id `claude` | 201, response preserves null run id; budget settles to 6,000 tokens and one record |
| Exceed its 5,000-token revision cap | One late `budget.overrun` of 1,000 tokens; task remains `COMPLETED` |
| Replay the identical record | 200, still one record and one overrun |
| Send another body under the same key | 409 |
| Send the same session under another provider | 201 into the ledger, excluded from this run's settlement |

Local raw captures: `/tmp/phase7-usage-live.json`, `/tmp/phase7-usage-drive.log`,
`/tmp/phase7-usage-dev.log`, `/tmp/phase7-usage-tests.log`, `/tmp/phase7-usage-lint.log`.
The temporary drive script is `/tmp/phase7-usage-drive.mts`. Temporary captures are not durable
repository artifacts and contain only this deterministic drive's data.

Web e2e and the scheduler demos were not run for this API accounting slice: no web or scheduler
implementation changed. There was no real-provider call and no fresh real-Cockpit import drive.

The first drive attempt used API port 0, which config validation rejects. The final drive acquired
an available valid port and completed all assertions. No product change was needed for that.

## Next slices, in order

1. Resolve #119/#120 against current main and re-run their acceptance after integration. The
   duplicate accounting-test fix must not be applied twice. Do not merge on behalf of the owner.
2. Finish #115's standalone-shell locator updates and run the full web e2e gate on its final tree.
   Its current body is explicit that selected reruns do not close that gate.
3. Drive unpatched Cockpit's real importer against the integrated plane with a scratch fixture
   HOME: counted usage before import, import, identical replay, budget read, no double counting.
   This continuation proves the plane ingestion/settlement path, not a fresh Cockpit outbox run.
4. Define allocation for a provider session shared by multiple plane runs. This slice refuses
   inference for that case. Assigning the whole transcript to every resumed run would double count;
   a unique match can also become ambiguous when a later run reuses the session. Reads then exclude
   the unbound imports from both runs. Do not claim this closes resumed-session accounting.
5. Read provider-measured in-run `costUsd` during settlement with explicit source precedence.
   It is currently carried on Claude's event but ignored by `settleSession`; cache creation is
   also estimated at the ordinary input rate. This slice changes neither cost policy nor token
   enforcement. Multi-source import precedence remains a separate policy gap.
6. Re-drive Phase 7 closure on the final integrated tree: resume/restart, failover, parallel
   lifecycle, verified digests, deterministic bundles and the deduped usage stream. #119's
   reported restart is a new provider session/revision via run-now, not provider-native resume.
7. Only after the Phase 7 success condition is demonstrated, advance Phase 8's M6/M10 learning
   and asset-usage work. K13 activation and deferred runtime work do not become implicit scope.

Additional findings in the existing PR bodies remain open: #120's conflicting task/stage-2 model
override precedence; #119's refused handoff writing a checkpoint, misleading same-assistant
handoff refusal, approval accepted for a recovered session without delivery, and missing restart
UI control. Keep those separate from this accounting change.

The checked graph at `graphify-out/graph.json` was built at `8fdde61`, well behind current main;
it was queried locally for orientation and then checked against current source. The Python
graphify module is unavailable in this environment. Nothing was sent to a semantic graph service.
