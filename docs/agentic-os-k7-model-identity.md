# K7 model identity and catalog — implementation and acceptance record

Implemented on `feat/agentic-os-k7-model-identity-catalog`, based on
`docs/agentic-os-kernel-services.md` (§4.4, §5.3 K7, CR-33, invariants I-M1/I-M3/I-M5).
K1–K6 are unchanged. **K8 (Artificial Analysis / benchmarks) and K13 (model scoring and
selection) are not implemented**, and nothing here selects a model.

## The two facts

After K7 every execution answers two independent questions:

- **What model did we ask for?** The requested *selector*, carried by
  `ExecutionRequest.model` and persisted as `runs.model_requested`.
- **What model did the provider actually serve?** The provider's own reported model id,
  persisted as `runs.model_resolved` with `runs.model_resolved_source`.

They are never derived from each other. A run whose provider reported no model identity
stays `NULL` — "unknown" is a valid, honest answer, and it is not back-filled from the
request, from an alias table, or from today's catalog.

## Requested identity (CR-33)

`TaskIntent.overrides.model` is where an operator's model request enters the plane. It is
task intent: immutable, recorded with the task, and never rewritten by later catalog
state. `POST /api/tasks` accepts it alongside `assistantId` and rejects every other
override key.

One derivation carries it to the adapter:

```
TaskIntent.overrides.model
  → Orchestrator.requestedModel(taskId)
  → BridgeStartInput.model
  → buildExecutionRequest: ExecutionRequest.model AND RunSpec.model   (control-plane-bridge.ts)
  → adapter.start(runSpec)
```

`buildExecutionRequest` computes the `ModelRef` once and copies it into both places, so the
request stays the sole authority and the RunSpec is a projection of it. The legacy
(flag-OFF) start path has no `ExecutionRequest`; it projects the *same* immutable task
intent into its inline `runSpec`, so an operator's request is not silently dropped there
either. No layer chooses a model on its own, and nothing consults the catalog to pick one.

If no model was requested, the selector stays absent through the whole chain. No provider
default name is invented before provider evidence exists.

`requestFingerprint` already includes `request.model` in its canonical projection, so a
different requested selector is a different execution request — as an execution-affecting
field should be. No fingerprint change was needed.

## Resolved identity (evidence only)

`SessionRunner.observe` records `run.started`'s `model` payload through
`SessionStore.recordResolvedModel` (first evidence wins; the store remains the only writer
of harness `runs` rows). The legacy path does the same in `Orchestrator.applyEvent`. Both
write only what the provider reported.

Per-adapter evidence, audited in `packages/adapters/test/model-evidence.test.ts`:

| Adapter | Declared model list | Resolved id in the stream | Notes |
|---|---|---|---|
| Claude | `opus` / `sonnet` CLI aliases, `local-config` evidence | **yes** — `system/init` carries `model` | the only production adapter with resolved-model evidence today |
| Codex | `default` placeholder (CLI-configured) | no — `thread.started` reports no model | stays `unknown`; never inferred from CLI config or defaults |
| Cursor | configured `--model` or `default` | no — `run.started` payload is `{ pid }` | |
| Bedrock | `DEFAULT` / qualifier | no | the model is chosen inside the deployed agent |
| OpenRouter | its configured model | no (delegates to Codex) | its configured id is adapter launch config, not provider evidence |
| Fake | `fake-1` | yes | deterministic test adapter reporting its own model |

Usage, context-window and capability metadata are not normalized into false equivalence:
where a provider reports nothing, the catalog carries nothing for it.

## Migration and backfill

`019_model_identity_catalog.sql` (forward-only, numbered, transactional — the repo's
existing convention) adds `runs.model_requested`, `runs.model_resolved`,
`runs.model_resolved_source` and backfills **only proven values**:

- `model_requested` from the committed `execution_requests.model` for that run's request.
- `model_resolved` from a persisted `run.started` event payload that actually contains a
  model, oldest first.

Claude/Fake rows therefore resolve; Codex/Cursor/Bedrock rows stay `NULL`. No alias is
resolved through the current catalog during migration, and no run gains an identity it
never had. Serving provider is not a stored column — it is joined at read time from
`assistants.provider`, so there is nothing to backfill wrongly.

## Catalog and price evidence

`ModelCatalogService` (`apps/api/src/modules/model-catalog.ts`) is local-first. At K7 its
sources are:

1. **provider-discovery** — the models each assistant's manifest advertises. Tier follows
   the manifest's own evidence source (`provider-api` → `provider-official`,
   `runtime-probe` → `measured-own`, otherwise `manual`).
2. **observed-runs** — model ids this workspace was actually served, from
   `runs.model_resolved` (`runtime-probe` / `measured-own`).
3. **price-seed** — a pinned, versioned price snapshot, labelled `tier: "manual"` with the
   attribution "manually transcribed from the published provider pricing page", because
   that is how it was obtained. It is not dressed up as fetched provider-official data.

### Identity is (provider, model id)

Model ids are **not** globally unique: Codex (`openai`) and Cursor both advertise a model
whose id is literally `default`. Keyed on the id alone, the two collapsed into one entry
and the higher-priority source overwrote the other provider's evidence. Catalog identity
is therefore `(provider, model_id)`, surfaced as `modelKey = "provider:modelId"`
(`020_model_catalog_provider_identity.sql` re-keys `model_catalog` and `model_prices`;
both tables hold only re-derivable evidence, so the rows are rebuilt rather than
migrated). Availability, observed-run evidence and price rows all join on that identity,
so nothing crosses providers.

### Field-level provenance

Rows are stored per `(provider, model_id, source)` and merged at read time by
`EVIDENCE_PRIORITY` (ties by `observedAt`), so weaker evidence only fills gaps a stronger
source left empty. A filled gap keeps **its own** provenance: `displayName`,
`contextWindowTokens`, `maxOutputTokens`, `capabilities` and each alias are
`{ value, provenance }` (`Attributed<T>`), so a field supplied by a manual transcription
never reads as provider-official just because a provider-official row established the
entry. The entry-level `provenance` describes what established the entry — and therefore
its `provider` and `status` — and nothing else. Every fact carries `source`, `tier`,
`observedAt`, `normalizationVersion`, `freshness` (computed at read time from a per-tier
TTL: 7 d official/own, 30 d external/manual) and `catalogRevision`. Nothing is flattened
into an untraceable number.

`availableVia` is a **join** onto provider discovery, not a second availability system: a
model no enabled assistant advertises is still listed, with an empty `availableVia`.

Price evidence keeps `inputPerMtok`, `outputPerMtok`, optional cache prices, `currency`,
`pricingVersion`, `appliesTo` (serving provider, account kind) and its own provenance, and
is read back with a read-time `freshness` label.

### The price snapshot is pinned in time

`PRICE_SEED_OBSERVED_AT` is the date the snapshot was transcribed, not the time of the
refresh that loaded it. Refreshing records that a refresh was attempted now; the evidence
keeps its original `observedAt` and therefore ages out on schedule. Only a newer price
revision, with its own evidence row, makes a price fresh again.

### Cold start

`refreshLocalEvidence()` is split from `refresh()`: it re-derives the three local sources
synchronously, contacts no network and no `CatalogSource`. A read against an empty catalog
hydrates through it once per process, so a fresh workspace that has synced provider
discovery already answers `GET /api/models` without the operator knowing to press Refresh
first. Routing never depends on this — it reads the registry.

### Refresh

`refresh()` re-derives the local sources and then polls any registered `CatalogSource`.
It never throws: each attempt is recorded in `model_catalog_refresh` with `ok`/`failed`
and a **classified** detail (never the raw transport error, which can echo a request).
Existing rows stay readable under the freshness policy, and routing — which reads the
registry, not the catalog — is unaffected by a failed refresh.

A `CatalogSource` receives only a transport (`{ fetch }`), never task, prompt, repository
or usage content, so none can be sent. There are no external sources in production at K7;
the seam exists for K8. The egress test registers a stub network source with a recording
fetch and asserts no goal, constraint, workspace path, task id or usage field appears in
the request.

Credentials are never stored in, or logged by, the catalog: no source at K7 takes one.

## Cost-cap deferral #3 stays open

`SessionRunner` still rejects `budget.enforcement: "bounded"` with `maxCostUsd`
(`policy_unenforceable`). The comment now names the five §4.4.5 gates: an applicable
tariff whose `appliesTo` matches, a **known** resolved identity, proven `usageReporting`
conformance (deferral #4), declared reporting latency/overshoot bounds, and non-model call
costs priced or scoped out. A catalog price, a family match or an estimate satisfies none
of them — pinned by a negative test that grants proven usage reporting *and* has catalog
prices loaded, and still expects rejection. Bounded token caps are unaffected.

## API

| Route | Capability |
|---|---|
| `GET /api/models` | `models.read` |
| `GET /api/models/:id` (by `provider:modelId`, model id, or known alias) | `models.read` |
| `POST /api/models/refresh` | `commands.write` |

The three routes are unchanged. `GET /api/models/:id` still accepts a bare model id or an
alias; when several providers claim it (`default`), it answers **409** with the candidate
`modelKey`s rather than picking a provider. `GET /api/models` returns the merged
projection for the UI; `GET /api/models/:id` additionally returns `evidence`, the unmerged
stored rows behind the entry. Catalog entries are `schemaVersion: 2` — `modelKey` is new,
and the merged fields listed above are now `{ value, provenance }`.

`models.read` was added to `OBSERVABILITY_CAPABILITIES`; the existing capability
negotiation, credential file and `GET /api/meta` advertisement carry it with no parallel
auth mechanism and no API version bump (`2.1` already covers it per §4.4.4). **Credentials
minted before this change do not carry `models.read` and get a fail-closed 403 on the new
routes until they are rotated.**

`GET /api/tasks/:id` and the session detail endpoint expose `modelIdentity`
(`requestedSelector`, `resolvedModelId`, `resolvedSource`, `servingProvider`) per run.

## UI

No redesign — the existing Orbital design system only:

- Inspector identity grid now reads **Requested model** / **Served model** / **Serving
  provider**. An unknown served identity renders as
  "Unknown — provider did not report model identity" in the muted style, not the error
  style, because it is not an error. The stale "Serving-provider identity awaits K7" fine
  print is replaced with the requested-vs-served rule.
- The Agents screen gains a **Model catalog** card listing each model with provider, tier,
  source, freshness, availability and price evidence (version, applicability, and the
  explicit "evidence only, not an enforcement tariff" label), plus a Refresh button. A
  catalog error renders as "Routing is unaffected".

`modelIdentityView` in `apps/web/src/orbital.ts` is the single pure function behind the
Inspector rows, so the honesty rules are unit-tested rather than asserted in prose.

## Recovery, handoff, scheduler

Recovery and scheduler wake replay the committed `execution_requests.request_json`, which
already carries `model` on both the request and its `runSpec` (the stored projection strips
only prompt and secrets). Re-dispatching the *same* request therefore reuses the original
requested selector and cannot re-resolve it against a newer catalog. A future *new*
dispatch may legitimately request something else. K1–K6 ownership semantics are untouched.

## Acceptance criteria → tests

| Criterion (§5.3 K7 / goal §12) | Test |
|---|---|
| `ExecutionRequest.model` is the sole requested-model authority | `apps/api/test/model-identity.test.ts` — "is the only layer that writes RunSpec.model" |
| Bridge copies it into `RunSpec.model` | same file — "carried by ExecutionRequest.model and copied into RunSpec.model (CR-33)" |
| Unspecified stays unspecified | same file — "stays unspecified when no model was requested" |
| Requested and resolved persisted separately | same file — "flows from task intent through the API to the persisted request and run row" |
| Claude resolves from provider-shaped `run.started` | same file — "records the model a Claude-shaped run.started reports" |
| Codex stays unknown | same file — "keeps a Codex-shaped run.started (no model) unknown" |
| Migration never guesses | same file — "resolves only what persisted evidence proves" |
| Recovery/scheduler reuse the immutable selector | same file — "reuses the immutable requested selector when the scheduler re-dispatches" |
| Every catalog fact has provenance | `apps/api/test/model-catalog.test.ts` — "gives every fact a source, tier and observation time" |
| Availability comes from discovery | same file — "takes assistant availability from provider discovery" |
| Price evidence is versioned and scoped | same file — "keeps price evidence versioned, attributed and scoped" |
| Catalog egress carries no task/prompt/repo/usage data | same file — "sends no task, prompt, repository or usage content" |
| Refresh failure leaves routing operational | same file — "records a failing source and leaves the stored catalog readable" |
| `GET /api/models` capability enforcement | same file — "requires models.read", "fails closed for a credential without models.read" |
| Codex and Cursor `default` never collapse or overwrite | same file — "keeps Codex `default` and Cursor `default` as two model identities" |
| Observed-run evidence merges onto the serving provider only | same file — "merges observed-run evidence onto the provider that actually served it" |
| Price evidence binds to the priced provider | same file — "binds price evidence to the priced provider only" |
| An ambiguous id fails explicitly instead of guessing | same file — "refuses to guess a provider for an ambiguous id" |
| Each merged field keeps its own provenance | same file — "keeps each merged field attributable to the evidence that supplied it" |
| Detail returns the unmerged evidence rows | same file — "returns the unmerged evidence rows from GET /api/models/:id" |
| Cold start lists models without a manual refresh | same file — "lists the models configured assistants expose without a manual refresh" |
| A pinned price snapshot does not become fresh on refresh | same file — "does not become live again just because the catalog was refreshed" |
| Refresh command capability enforcement | same file — "gates refresh behind commands.write" |
| Bounded `maxCostUsd` still rejected | same file's sibling in `model-identity.test.ts` — "stay rejected even though the catalog now carries price evidence" |
| Unknown identity renders honestly | `apps/web/src/orbital.test.ts` — "model identity (K7)" |
| Per-adapter evidence audit | `packages/adapters/test/model-evidence.test.ts` |

## Validation

`pnpm typecheck`, `pnpm lint`, `pnpm test` (665 tests), `pnpm build`,
`pnpm test:harness-on` (564), `pnpm test:recovery-chaos` (56), `pnpm demo:a`,
`pnpm demo:a5`, `pnpm eval` (7/7 fake scenarios; the three real scenarios remain skipped
without `AGENT_PLANE_EVAL=1` and provider env keys) — all green.

**Real-provider smoke test.** A single bounded Claude run through `SessionRunner` with the
real `ClaudeAdapter` and the local CLI OAuth credential: requested selector `sonnet`,
provider-reported resolved model `claude-sonnet-5`, `model_resolved_source = run.started`,
outcome `completed`. The equivalent Codex run did not complete in this environment
(`provider_fault`, "provider session ended with an error"); its identity behavior was still
honest — `model_resolved` stayed `NULL`. The smoke scripts were throwaway and are not
committed.

## Explicitly not implemented

- **K8** — Artificial Analysis / LiveBench / any external benchmark ingestion. The
  `CatalogSource` seam exists and is empty in production.
- **K13** — task classification, model scoring, blending, shadow selection, automatic model
  switching. The router does not pick a model in K7.
- K9 context observation, K10 compaction, K11 continuation, K12, K14 Cockpit catalog.
- Bounded `maxCostUsd` enforcement (standing deferral #3), for the reasons above.
