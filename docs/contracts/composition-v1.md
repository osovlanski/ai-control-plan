# Composition contract v1

Status: normative for composition v1, the second M0 slice (plan §3.1, §3.2, §3.3). These are
plane-internal, persisted documents: the immutable **AgentSpec** composition revision and its
**CompositionDecision**. No table, Composer or adapter provisioning is defined here; those land in
`packages/core` and the M1 tables against this contract.

The JSON Schemas (draft 2020-12) in `contracts/composition/v1/` are the authority:

| Schema | Document |
|---|---|
| `agent-spec.schema.json` | one composition revision |
| `composition-decision.schema.json` | that revision's explanation |

`apps/api/src/composition-contract.ts` is the reference implementation of the rules a schema
cannot express. Fixtures are in `contracts/composition/v1/fixtures/`.

Field names are `snake_case`, following plan §3.2 and the persisted form. Wire contracts
(registry, bundle) are `camelCase`. Where the two meet, `context.compiler.token_method` and
`chars_per_token` correspond to bundle `manifest.tokens.tokenMethod` and `charsPerToken`, and
`opt_in` is the plan's `optIn`.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## AgentSpec

```text
{ schema_version, composition_revision_id, task_id, intent, harness, model, registry,
  assets: { skills, mcp_servers, subagents }, context, policy, workspace, provisioning,
  explanation_ref }
```

**Immutable.** A revision is never updated. Every object is closed (`additionalProperties` or
`unevaluatedProperties: false`), so a mutable pointer (`version`, `path`, `url`, `latest`), an
inline secret or any unknown field cannot be persisted. Failover and re-composition produce a new
`composition_revision_id` (invariant 4).

| Field | Meaning |
|---|---|
| `intent` | `kind`, sorted `domains`, `complexity` (`S`/`M`/`L`), `risk` (`low`/`normal`/`high`). |
| `harness` | `claude-code`, `codex`, `cursor` or `bedrock`. |
| `model` | `primary`, `fallbacks` (ModelRef `{ id }`), optional `reasoning_effort`. |
| `registry` | `snapshot_digest` (registry v1 `snapshotDigest`), `observed_at`, `stale`. A stale snapshot is recorded, never hidden. |
| `assets.*[]` | `{ id, digest, allowlisted, opt_in? }`. The digest **is** the revision (invariant 1). `mcp_servers` add sorted `tools_allowed` and `secret_refs`. |
| `context` | sorted `fragments`, `memory_bundles` `{ id, digest, reason }`, `bundle_digest` (bundle v1 `bundleDigest`), `compiler { name, version, tokens, token_method: estimated, chars_per_token }`. |
| `policy` | `permission`, sorted `tool_allowlist`, `budget { max_tokens?, max_cost_usd?, max_runtime_ms? }`. |
| `workspace` | `repository_id`, `branch`, `worktree_id`. Opaque ids, never a filesystem path. |
| `provisioning` | `requested` (`isolated`/`ambient`), `achieved?` (`full`/`high`/`partial`/`ambient`/`select-only`), `profile_digest?`. |
| `explanation_ref` | The `id` of this revision's CompositionDecision. |

Rules the validator enforces:

- Asset lists are sorted by `id`, strictly. `domains`, `tool_allowlist`, `fragments`,
  `memory_bundles` (by `id`) and `tools_allowed` are sorted with no duplicates.
- **Trust (invariant 6).** An asset with `allowlisted: false` MUST carry `opt_in
  { digest, actor, at }`, and `opt_in.digest` MUST equal the attached `digest`. An opt-in pins one
  digest; a changed asset needs a new opt-in.
- **No silent ambient (invariant 3).** `achieved: ambient` with `requested: isolated` is invalid.
  Policy that permits ambient says so in `requested`.
- **Zero optional assets is valid (invariant 7).** All three asset lists may be empty.

The rendered bundle is not embedded in the AgentSpec; `context.bundle_digest` binds the revision
to it. The M1 tables MUST persist the BundleResponse bytes with the revision so the revision stays
replayable (vnext increment 5); that is a storage rule for wave 2, not a field here.

## Secrets

Secrets appear only as `SecretRef` (`{ type: env | keychain, name }`), by `$ref` to the registry
v1 definition, not a copy. `SecretRef` is closed, so a string or an object carrying a value fails
validation. No field of either document holds a secret value.

## CompositionDecision

```text
{ schema_version, id, composition_revision_id,
  stages: [{ stage, candidates: [{ ref, digest?, evidence? }], filters: [{ filter, removed, reason }],
             chosen: [ref], why, override: null | { actor, from, to, reason } }] }
```

- `stages` is exactly `intent`, `harness_model`, `assets`, `context`, `policy`, `confirm`, in that
  order (plan §3.3).
- Every `chosen` and every filter's `removed` ref is a candidate; nothing chosen was removed;
  candidates are unique.
- `why` is required and non-empty. **`chosen: []` with a `why` is a valid outcome**, and is how
  the assets stage records "no optional asset fits".
- `override` is `null` or records who changed the stage's outcome, from what, to what and why.

## Consistency between documents

`checkComposition(spec, decision, bundle?)` holds when:

- `spec.explanation_ref == decision.id` and both name the same `composition_revision_id`;
- the assets stage's `chosen` set equals the ids of every attached asset, and a chosen
  candidate's `digest` equals the attached `digest`;
- with a bundle: its `bundleDigest`, harness, fragments, compiler and token estimate match
  `context`; its pinned `memoryBundles` and `skills` equal `context.memory_bundles` and
  `assets.skills` by id **and digest**; every attached skill was rendered at that digest; and every
  rendered memory bundle is one the spec records at that digest.

## Versioning

`schema_version` is `MAJOR.MINOR`. These are persisted rows: a reader accepts a stored minor up to
its own and rejects a newer minor or another major. Because objects are closed, any added field is
a minor version and requires the reader to be upgraded first.

## Distribution

Plane-internal: not vendored by Cockpit. The `$ref`s to registry v1 and bundle v1 resolve by `$id`
inside this repository.
