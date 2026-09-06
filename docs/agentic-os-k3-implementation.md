# K3 optional quota probes — implementation and acceptance record

Implemented on `feat/agentic-os-k3-quota-probes`, based on
`docs/agentic-os-kernel-services@c05322b` (kernel-services revision 2, CR-22, §4.2.4,
§5.1 K3, §6). K1 and K2 are unchanged; only K3 is implemented here.

## Delivered behavior

An optional idle quota probe now produces `provider-api` observations for the shared
`QuotaProjection` that K2 already made the single reader for both the router and the
scheduler. A probe is not an adapter method and not a manifest capability: like
`capability-probe.ts`, it sits outside the six-method adapter contract, is
account-specific, and is off unless the operator turns it on
(`scheduler.quotaProbe`, default `false`).

`probeQuota(provider, options)` implements the Claude OAuth usage probe: the access
token is read in memory from the provider's own credential file
(`~/.claude/.credentials.json`, overridable per assistant) and used only as the
request credential for `GET https://api.anthropic.com/api/oauth/usage`
(`anthropic-beta: oauth-2025-04-20`). Every top-level window in the response with a
numeric `utilization` becomes one bucket observation (`five_hour`, `seven_day`,
`seven_day_opus`, …), so a new provider window needs no code change.

Every other provider returns `unsupported` rather than fabricated headroom. The
Codex app-server RPC `account/rateLimits/read` is observed in Omarchy's script but
absent from the documented App Server page; per the doc it stays unimplemented until
it is verified against a running app-server, and no placeholder data stands in for it.

`QuotaProbeService` runs due probes, records each attempt, and writes only successful
results as `quota_snapshots` rows with `source = 'provider-api'`, scoped to the
assistant's manifest account and the provider's own bucket name. Attempts are
rate-limited to one per assistant per 15 minutes, durably: migration
`016_quota_probes.sql` adds a `quota_probes` attempt row per assistant, so a restart
does not reset the window. That table holds attempts only — an `unavailable`,
`unauthorized`, `unsupported` or throwing probe writes no observation and therefore
changes nothing the projection, router or cooldowns read.

The scheduler consults probes in two places. On each tick, due probes run for every
enabled assistant, so headroom is visible while idle rather than only after a limit
is hit. At wake, a `quota` condition revalidates its own subjects first: the attempt
is appended to the condition's `history` with `outcome: probe` and never touches
`auto_wakes`, so probe attempts and wake attempts stay separate budgets exactly as
§4.2.4 requires. If the refreshed projection is exhausted, the existing K2 re-park
runs and no provider start happens.

Reads: `GET /api/scheduler/status` gains `probesEnabled` and per-assistant probe
freshness (last attempt, outcome, age); `GET /api/assistants` reports the effective
projection (`quota`, `quotaObservations`) instead of leaving headroom visible only
inside the manifest's own copy.

## Acceptance criteria (§5.1 K3, §4.2.4, §6)

| Criterion | Where |
|---|---|
| Probe results are `provider-api` observations scoped to account and bucket | `records a successful probe as a provider-api observation scoped to account and bucket`; `an exhausted probe observation blocks routing with provider-api provenance` |
| Tokens read in memory, never persisted, logged or echoed (redaction test) | `never persists, logs or echoes the credential through the service` (asserts every table, console output, attempt results and scheduler status); `classifies … without leaking the response`; `reports unauthorized without credentials and unavailable when the endpoint cannot be reached` |
| Probe attempts appear in `history` and never increment `autoWakes` | `records probe attempts in wait history without spending the wake budget`; `re-parks at wake without a provider start when the probe reports an exhausted window` |
| Codex `reportsLimits` stays `false` with a working probe (manifest test) | `leaves reportsLimits false for an assistant whose run stream does not report limits` (manifest byte-identical apart from the flag under test) |
| A probe whose endpoint is unavailable changes nothing | `changes nothing when the endpoint is unavailable`; `a probe that throws is contained and recorded as unavailable` |
| One probe per assistant per 15 minutes | `rate-limits to one attempt per assistant per 15 minutes` |
| Wake revalidates with the probe | `re-parks at wake without a provider start when the probe reports an exhausted window` |
| Freshness supersedes source rank in both directions | `a fresh probe supersedes a stale run-stream snapshot and a stale probe never supersedes a fresh one` |
| Headroom visible while idle where the account exposes it | scheduler tick refresh; `surfaces probe freshness on scheduler status`; `/api/assistants` effective projection |
| Optional and operator-enabled | `is off unless the operator enables it` |
| No unsupported provider capability behind fake data | `reports unsupported for a provider with no verified idle endpoint, without inventing data` |

## Architecture assumptions confirmed

- CR-22 holds as written: probes are evidence, not capability. Nothing in this slice
  writes a manifest, so `reportsLimits` continues to describe the run stream alone.
- K2's `QuotaProjection` needed no change to consume probe evidence. Freshness by
  `observedAt` with source priority as a tie-break already gives "a fresh
  `provider-api` probe supersedes a stale `runtime-probe` snapshot, and a stale probe
  never supersedes a fresh run-stream observation".
- The 15-minute probe window is durable state, not process state; the attempt table is
  the smallest thing that survives a restart and also answers "probe freshness" for
  `GET /api/scheduler/status`.

## Intentionally not implemented

- **Codex idle probe.** Unverified endpoint; `unsupported` is returned rather than
  invented data. Unblocked by a verification against a running app-server, not by code.
- **Cockpit presentation** of probe headroom (K6/K12 own presentation).
- **`quota_snapshots.blocker_kind` / `reset_provenance` columns** named in §4.2.8's
  persistence sketch: blockers are still derived by the projection, and no reader needs
  a denormalized copy.

## Validation

`pnpm typecheck`, `pnpm lint`, `pnpm build`; `pnpm test` 601 tests (core 70, adapters 8,
API 517, web 6); `pnpm test:harness-on` 517; `pnpm test:recovery-chaos` 56; `pnpm eval`
7/7 fake scenarios (the three real-provider scenarios remain credential-gated, an
unchanged increment-3 deferral).
