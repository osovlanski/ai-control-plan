# Usage contract v1

Status: normative for usage v1 (plan §3.7, M1; Cockpit's M11 import posts into it). It fixes the
wire of one usage observation sent to the Control Plane's ingestion boundary and the idempotency
rule that boundary applies. Aggregation, pricing and source precedence are not part of it.

The JSON Schema (draft 2020-12) `contracts/usage/v1/usage-record.schema.json` is the wire
authority. `validateUsageRecord` in `apps/api/src/modules/usage.ts` is the reference implementation
of the rules below that a schema cannot express. The conformance fixtures in
`contracts/usage/v1/fixtures/` are run by both repositories.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## UsageRecord

```text
{ schemaVersion, eventId, runId?, provider, sessionRef?, source, assistantId, model,
  accounting: "delta" | "cumulative", tokensIn, tokensOut, cachedTokens,
  costUsd?, apiEquivalentUsd, pricingVersion, observedAt }
```

- The object is closed: an unknown field is rejected.
- Ids are 1 to 256 characters and carry a non-space character. `runId`, `sessionRef` and
  `costUsd` may be absent or `null`; the two mean the same thing.
- Token counts are integers from 0 to 2^53 − 1. USD amounts are from 0 to 1,000,000.
- `observedAt` is an RFC 3339 date-time. An instant a JavaScript `Date` cannot hold (a leap second,
  an `+HH` offset without minutes, an expanded year) is rejected. The plane stores the instant as
  `toISOString()`, so two spellings of one instant are the same record.
- `runId`, when present, MUST name a run the plane knows.

## Idempotency

The key is **(provider, sessionRef, eventId)**. An `eventId` MUST be unique within its provider and
session. A record without a `sessionRef` is keyed in its own space, so a sessionless `evt-1` and
`evt-1` under session `s` are two records, and two sessionless `evt-1` are one.

| Outcome | Status |
|---|---|
| First delivery | `201 { replayed: false, record }` |
| Same key, same record | `200 { replayed: true, record }` with the stored row |
| Same key, different record | `409 { error, record }` with the stored row; never an overwrite |
| `runId` unknown | `422` |
| Not a valid UsageRecord | `400 { error, details }` |

"Same record" compares every field after normalization (absent optionals as `null`, `observedAt`
as above), except `schemaVersion`. Stored records are immutable. The `record` in a response omits
`schemaVersion`: it describes the envelope, not the observation.

Authentication is a bearer credential with the `usage.write` capability, which browser sessions
never carry.

## Versioning

`schemaVersion` is `MAJOR.MINOR`, policy as in [registry v1](registry-v1.md). The record is
closed, so the plane rejects a minor newer than its own: an older plane cannot honour a newer
field. A client sends the highest minor the plane supports.

## Distribution

As registry v1: Cockpit vendors these files pinned to a commit SHA of this repository with a
sha256 manifest test. No moving-branch dependency.
