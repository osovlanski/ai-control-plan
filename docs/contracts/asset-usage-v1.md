# Asset usage contract v1

Status: normative for asset usage v1 (plan §3.5 reverse edge, M6 S3, M10). It fixes the wire of
one per-asset, per-session usage event and of the feed page the Control Plane serves it in.
Cockpit (M10) pulls the feed; the plane never posts it (plan Q2). Scoring, aggregation and the
task-level outcome are not part of it.

The JSON Schemas (draft 2020-12) `contracts/asset-usage/v1/asset-usage-event.schema.json` and
`asset-usage-page.schema.json` are the wire authority. `validateAssetUsageEvent` and
`validateAssetUsagePage` in `apps/api/src/asset-usage-contract.ts` are the reference
implementation of the rules below that a schema cannot express. The conformance fixtures in
`contracts/asset-usage/v1/fixtures/` are run by both repositories; a fixture named `page*` is a
page, any other is an event.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## AssetUsageEvent

```text
{ schemaVersion, eventId, seq, compositionRevisionId, sessionId, taskId,
  assetKind: "skill" | "mcp_server" | "memory_bundle" | "fragment", assetId, assetDigest,
  harness, fidelity: "full" | "partial" | "none",
  attached, validation, invocation: { method, count, failed },
  sessionOutcome: "success" | "error" | "neutral" | "not_run", verificationPassed,
  attributionMethod, deriverVersion, at }
```

One event is one asset the composition revision selected, in one session (a run) of that
revision. It states five facts, and none implies the next:

1. **selected**: every event. The revision listed the asset.
2. **attached** (`attached`): the asset is in the session's verified profile. Always `false` when
   `fidelity` is `none` (an ambient session has no profile).
3. **validated** (`validation`): provider-side evidence that it loaded, strongest first:
   `runtime_confirmed`, `runtime_pending` (an MCP server the provider reported pending),
   `rendered`, `files_verified`, `failed` (the startup judge or probe failed), `none`.
   `validation` is `none` exactly when `attached` is `false`.
4. **invoked** (`invocation`): with `method: "tool_event"`, `count` is the number of distinct
   tool calls that used the asset and `failed` how many of those failed (`failed ≤ count`). With
   `not_applicable` (instructions, which are always in the prompt) or `not_observable` (the
   harness reports no usable tool events), `count` and `failed` are `null`. **`null` is not 0**: a
   reader MUST NOT sum or rank a `null` as zero.
5. **outcome**: `sessionOutcome` is the session's reliability class, or `not_run` when the provider
   never acknowledged a start. `verificationPassed` is the session's last verification, `null`
   when no check ran.

Field rules:

- The object is closed: an unknown field is rejected.
- `eventId` is `au1_` plus the hex sha256 of the RFC 8785 JSON of
  `{v: 1, revision, session, kind, id, digest}`. The same session and asset give the same id on
  every derivation, restart and machine.
- `seq` is the plane's ingest order, assigned once when the event is stored, strictly increasing.
  It is a cursor, not a count: gaps are allowed.
- `assetId` is a registry asset id, memory bundle id or fragment name; it never contains a path
  separator. `assetDigest` is the digest the revision pinned, or `excluded` for a fragment the
  bundle left out, which is never attached.
- `attributionMethod` (`co-occurrence/v1` today) names how the facts were associated. Every
  method is co-occurrence: **no event claims that an asset caused an outcome** (plan risk 11).
- `at` is when the session's result was stored, never the time the event was derived.
- An event carries no hostname, absolute path, secret, secret reference, tool input or
  transcript text, and no storage internals (the ledger's body digest stays in the plane).

## Feed

`GET /api/composition/asset-usage?after=<seq>&limit=<n>` with a bearer credential holding
`telemetry.read` (API 2.7).

- `after` is an integer from 0 (the default, the start) to 2^53 − 1. `limit` is an integer from
  1 to 500, default 100. Anything else (0, 501, a sign, a fraction, an exponent, a leading zero,
  an empty value) is `400 { error }`.
- The answer is an `AssetUsagePage`: `{ schemaVersion, events, next }`, the events with
  `seq > after` in `seq` order, at most `limit` of them. Every event's `schemaVersion` is the
  page's.
- `next` is the last event's `seq`, or `after` when the page is empty. A reader passes `next` as
  `after` to read on. A page shorter than `limit` means the reader has caught up for now.
- Stored events are immutable and a `seq` is assigned once, so paging by `after` neither skips nor
  repeats an event, whatever the plane stores between two pages.
- A credential without `telemetry.read` gets `403`; no credential, `401`. The plane validates
  each page against this contract before sending it and answers `500` rather than send one that
  fails.

## Reader obligations

- Deduplicate by `eventId`. A second, different body under an `eventId` already held is a
  conflict: keep the first and set the second aside. The plane never rewrites an event, so a
  conflict means a defect somewhere and is worth showing.
- Join to installed assets by `assetId` and `assetDigest`. A digest no longer installed is still
  a valid event; show it as such.
- Treat the counts as facts, not scores. Shadow scores are plane state, served separately, and a
  reader shows them as served.

## Versioning

`schemaVersion` is `MAJOR.MINOR`, policy as in [registry v1](registry-v1.md). The objects are
closed, so a reader rejects a minor newer than its own. The plane serves the highest minor it
writes; a minor bump is announced by an API version bump.

## Distribution

As registry v1: Cockpit vendors these files pinned to a commit SHA of this repository with a
sha256 manifest test. No moving-branch dependency.
