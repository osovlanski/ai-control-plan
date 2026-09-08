# K9 context observation — implementation and acceptance record

Implemented on `feat/agentic-os-k9-context-observation`, from
`docs/agentic-os-kernel-services.md` §4.3.1, §5.2 (K9 + K12), CR-34 and
invariants I-C1/I-C3. K1–K8 are unchanged.

**K9 is OBSERVATION ONLY.** Nothing here compacts, prunes, yields, issues
`/compact` or `/clear`, or starts a clean-session continuation. **K10**
(provider-command compaction), **K11** (context yield / bounded continuation) and
**K12** (Cockpit gauge) are explicitly pending. **K8** and **K13** are untouched.

## The one question K9 answers

> How full is this active agent context?

with one of two truthful outcomes:

- **KNOWN** — occupancy, effective window, source/method and freshness (and a
  percentage *only* when a fresh observation has both occupancy and a real
  effective window), or
- **UNAVAILABLE / UNKNOWN** — and never a percentage manufactured from unrelated
  token-accounting data.

## Accounting is not occupancy

`UsagePayload` (input/output tokens), `ExecutionResult.usage`, Codex per-turn
usage and quota-only `usage.updated` are a separate stream and never feed
`occupancyTokens`. A `usage.updated` that carries only quota produces **no**
`ContextObservation`. `SessionRunner.observe()` still routes those events to the
budget/quota guards; the K9 sampler is a distinct path keyed off turn boundaries.

## ContextCapability by provider

`CapabilityManifest.context` (new, optional, top-level — a sibling of `harness`,
so adapters without a `harness` block declare it without inheriting harness
enforceability semantics). Tiers represent **proven** provider behaviour only; no
adapter declares `compact: "provider-command"` at K9.

| Adapter | occupancy | effectiveWindow | compact | autoManagement | observesAutoCompaction | evidence |
|---|---|---|---|---|---|---|
| **Claude** | `provider-reported` | `provider-reported` | `none` | `provider` | `true` | Agent SDK 0.3.238 `query().getContextUsage()` → `totalTokens` / `rawMaxTokens`; `compact_boundary` system messages in the `SDKMessage` stream |
| **Codex** | `unavailable` | `unavailable` | `none` | `provider` | `false` | `turn.completed` accounting is not live occupancy; App Server `thread/compact/*` needs an unwired transport |
| **OpenRouter-in-Codex** | `unavailable` | `unavailable` | `none` | `provider` | `false` | delegates to the Codex adapter |
| **Cursor** | `unavailable` | `unavailable` | `none` | `none` | `false` | no verified mechanism at the CLI layer |
| **Bedrock** | `unavailable` | `unavailable` | `none` | `none` | `false` | the context lives inside the deployed agent |
| **Fake** | `provider-reported` | `provider-reported` | `none` | `none` | `true` | scripted via `[FAKE:CONTEXT:<pressure>]` / `[FAKE:COMPACT]` |

## Claude — evidence for the fields the adapter claims

The installed Agent SDK (0.3.238) already carries the data; the adapter used to
drop it. K9 forwards it:

- **occupancy** ← `SDKControlGetContextUsageResponse.totalTokens` (a control
  request the adapter now issues via the retained `Query`). Source
  `provider-reported` — the provider's own figure; the Harness adds no estimator.
- **effective window** ← `SDKControlGetContextUsageResponse.rawMaxTokens` — the
  resolved autocompaction window. Source `provider-reported`.
- **advertised model maximum** ← `result.modelUsage[*].contextWindow` (the
  largest across entries), captured on the `result` message. Stored and rendered
  **separately** from the effective window; the two legitimately differ (e.g.
  200k managed window on a 1M-window model).
- **provider auto-compaction** ← `system` / `compact_boundary` messages, forwarded
  as `context.compaction.observed` with `requestedByPlane: false`.

Real-provider smoke (Claude CLI login, bounded, no transcript committed):
`observeContext` returned `occupancyTokens` from `totalTokens` (~39k) against an
`effectiveWindowTokens` from `rawMaxTokens` (~967k), both `provider-reported`;
`breakdown` populated from `categories` (non-content buckets — "Free space",
"Autocompact buffer" — filtered out); no `compact_boundary` in the short run.

## Codex — unavailable behaviour

Codex declares `context.occupancy: "unavailable"` and implements no
`observeContext`. `SessionRunner` never samples it. `GET /api/tasks/:id/context`
for a Codex session returns `status: "unavailable"` with reason
"<provider> does not expose live context occupancy" — a successful honesty test,
not a failure.

## Persistence and events (append-only)

Two typed normalized event types were added to the closed set:

- `context.observed` — payload is the canonical `ContextObservation` (with a
  monotonic per-session `sequence`).
- `context.compaction.observed` — `{ trigger, preTokens?, postTokens?,
  requestedByPlane: false }`.

They are recorded through the existing `EventRecorder.recordBatch` transaction
(CAS + monotonic `seq`), so they inherit redaction, the SSE fan-out and
recovery semantics unchanged. No migration: the `events` table has no `type`
CHECK. Invariant I-C1 holds trivially — nothing mutates or deletes prior events.

## API

`GET /api/tasks/:id/context` — capability `context.read` (new in
`OBSERVABILITY_CAPABILITIES`; credentials minted before K9 fail closed with 403
until `pnpm --filter @agent-plane/api rotate`). `apps/api/src/modules/context.ts`
projects the latest truthful state for the task's most recent session:

- legacy run row (`execution_request_id IS NULL`) → `unavailable`, reason
  `legacy execution path`;
- no `context.observed` event → `unavailable`, reason from the capability tier;
- otherwise `known` with the observation, `autoCompaction` summary, and
  `capability`. A terminal session **or** an observation older than 45s renders
  `freshness: "stale"` and drops `pressure` — a stale reading never masquerades
  as live.

K7 integration: `advertisedMaxTokens` falls back to the catalog
`contextWindowTokens` **only** when the resolved model id is known; a catalog
maximum is never promoted into an effective managed window, and an unknown
resolved model triggers no lookup.

Context events reach the web over the existing `/api/tasks/:id/events/stream`
SSE — no new streaming subsystem.

## Web gauge

Orbital inspector **Context** tab, now `Implemented · K9`, using the existing
visual system (`ContextReadout` in `board/readouts.tsx`). States:

- **KNOWN** — `82k / 180k tokens`, `46%` with a `<meter>`, method chip
  (`Provider-reported`), `Live`, and a separate `Advertised model maximum` line.
- **PARTIAL** — `72k tokens`, "Effective window unknown", method chip, **no
  percentage, no meter**.
- **UNAVAILABLE** — "Occupancy unavailable" + the honest reason (and the
  provider auto-management note); the legacy case reads "Context observation
  unavailable — legacy execution path".
- **STALE** — `Stale` (not `Live`), no percentage.
- Provider auto-compaction shows as **Observed**, with the explicit note that it
  is the provider compacting its own transcript, not an Agentic OS action.

## Acceptance criteria → tests

| # | Criterion | Test |
|---|---|---|
| 1 | `ContextCapability` truth per adapter | `packages/adapters/test/context-capability.test.ts` |
| 2 | Claude-shaped structured context observation | `packages/adapters/test/claude-context.test.ts`; `packages/core/test/context.test.ts` |
| 3 | Effective window ≠ advertised maximum | `packages/core/test/context.test.ts` ("separate facts and may differ"); `claude-context.test.ts` |
| 4 | Pressure only with a known, fresh effective window | `packages/core/test/context.test.ts`; `apps/api/test/harness/context-observer.test.ts` |
| 5 | Quota-only `usage.updated` → no observation | `apps/api/test/harness/context-observer.test.ts` |
| 6 | Token accounting is not occupancy | `apps/api/test/harness/context-observer.test.ts` (quota-only + no marker) |
| 7 | Codex occupancy stays `unavailable` | `packages/adapters/test/context-capability.test.ts`; `apps/api/test/harness/context-observer.test.ts` ("Codex-shaped"); `apps/api/test/context-endpoint.test.ts` |
| 8 | `compact_boundary` → `context.compaction.observed` | `packages/adapters/test/claude-context.test.ts`; `apps/api/test/harness/context-observer.test.ts` |
| 9 | K9 never issues a compaction command | `apps/api/test/harness/context-observer.test.ts` (no `guard.decision` touches compaction; `requestedByPlane: false`) |
| 10 | Observation sequence is monotonic | `apps/api/test/harness/context-observer.test.ts` |
| 11 | `context.read` authorization | `apps/api/test/context-endpoint.test.ts` (admitted / pre-K9 403 / 404) |
| 12 | Legacy path returns explicit unavailable | `apps/api/test/context-endpoint.test.ts` |
| 13 | UI known state | `apps/web/src/context.test.tsx` |
| 14 | UI partial state — occupancy known / window unknown / no % | `apps/web/src/context.test.tsx` |
| 15 | UI unavailable state | `apps/web/src/context.test.tsx` |
| 16 | Stale observation renders stale, not live | `apps/api/test/context-endpoint.test.ts`; `apps/web/src/context.test.tsx`; `apps/web/src/orbital.test.ts` (`contextPercent`) |

Kernel-services §5.2 K9 items 1–4 map to the adapter + observer + endpoint tests
above; items 5–13 (K10/K11) are **not implemented**.

## Deferred (unchanged)

K10 provider-command compaction, `/compact`, context pruning, `/clear`; K11
`yield(context)` and clean-session continuation; K12 Cockpit gauge; K8 benchmark
ingestion; K13 scoring / automatic model switching; any generic estimated
occupancy.
