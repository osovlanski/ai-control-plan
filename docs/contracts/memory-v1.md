# Memory contract v1

Status: normative for memory v1 (O6, `docs/agentic-os-o6-memory-writeback.md` §3, slice S1).
It fixes two wires that travel in opposite directions:

- **MemoryBundleSnapshot**: Cockpit serves it at `GET /api/v1/registry/memory/bundles`, the
  Control Plane consumes it. Cockpit owns memory; the plane reads digests and health only.
- **MemoryProposalEvent** and its feed page: the plane serves them at `GET /api/memory/proposals`
  under `memory.read` (API 2.8), Cockpit consumes them. A proposal is never a write.

Neither route exists yet: Cockpit's snapshot route is O6 S2, the plane's feed is O6 S5. This
document and the schemas are what both slices build against.

The JSON Schemas (draft 2020-12) in `contracts/memory/v1/` (`memory-bundle-snapshot.schema.json`,
`memory-proposal-event.schema.json`, `memory-proposal-page.schema.json`) are the wire authority.
`apps/api/src/memory-contract.ts` is the reference implementation of the rules below that a
schema cannot express. The conformance fixtures in `contracts/memory/v1/fixtures/` are run by both
repositories; a fixture named `snapshot*` is a snapshot, `page*` a page, any other an event.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## MemoryBundleSnapshot

```text
{ schemaVersion, snapshotDigest, observedAt,
  bundles: [{ id, digest, tags, repoScopes, visibility: "repo_scoped" | "any_repo",
              members: [{ path, digest }], estimatedTokens,
              health: { members, staleMembers, oldestAgeDays, duplicatePairs, ghosts,
                        oversized, findingsDigest } }] }
```

A bundle is an operator-declared entry in Cockpit config (`memory.bundles`, plan Q1). Its members
are the `.md` files in its `memory/` directory, `MEMORY.md` included. The directory itself never
travels: no absolute path, hostname or Cockpit config reaches the plane.

- Every object is closed: an unknown field is rejected.
- `bundles` are strictly sorted by `id` (byte order). `id` is the bundle v1 memory bundle id
  pattern, so a snapshot id is directly a `memoryBundles[].id` pin.
- `members` are strictly sorted by `path` (UTF-8 byte order). A `path` is relative to the
  bundle's `memory/` directory, ends in `.md`, and has no leading `/`, no `.` or `..` segment, no
  backslash and no NUL. Cockpit v1 emits single file names.
- A member `digest` is `sha256:` + hex sha256 of the file's raw bytes.
- A bundle `digest` is the registry v1 asset digest over its members: sha256 of the lines
  `<hex member digest> <path>\n` sorted by path bytes, prefixed `sha256:`. It is recomputable
  from `members`, and a reader MUST reject a bundle whose digest does not match. The empty bundle
  digests the empty string. This is the digest bundle v1 pins; a pin whose digest moved is
  `404` at render, unchanged from bundle v1.
- `tags` and `repoScopes` are sorted and unique. A repo scope is `owner/name`. `repoScopes` is
  empty exactly when `visibility` is `any_repo`. In v1 nothing selects a bundle by tag, scope or
  visibility: only a composition pin renders one (plan §4).
- `estimatedTokens` is Cockpit's estimate for rendering every member; advisory.
- `health` is the Garden's findings on the bundle's members as Cockpit computed them at
  `observedAt`:
  - `members` equals the number of members; `staleMembers ≤ members`.
  - A member is stale when its age exceeds the Garden's `staleDays` (180 by default). Age is
    measured from the frontmatter `metadata.modified` when present, else the file mtime.
  - `oldestAgeDays` is whole days from the oldest member's age basis to `observedAt`, and `null`
    exactly when the bundle has no members.
  - `duplicatePairs`, `ghosts` and `oversized` are counts of those findings. They are shown, and
    in v1 they never demote (plan Q3).
  - `findingsDigest` is opaque to the plane. It changes exactly when the findings behind the
    counts change.
- `snapshotDigest` is `sha256:` + hex sha256 of the RFC 8785 JSON of `bundles`. Health is inside
  it; `observedAt` is not. A reader MUST reject a snapshot whose digest does not match.
- `observedAt` is when Cockpit read the files, and the time base for every age in the snapshot.
  A consumer uses it as "now" for anything it derives from health; it never reads its own clock
  for that.

### Endpoint (Cockpit, S2)

`GET /api/v1/registry/memory/bundles` → `MemoryBundleSnapshot`, behind the registry v1 bearer
token, with the same authentication, header and error rules as registry v1. Read-only; no query
parameters in v1. Health travels inside the snapshot; there is no `/memory/findings` route.

## MemoryProposalEvent

```text
{ schemaVersion, proposalId, seq, sessionId, taskId, compositionRevisionId, checkpointId,
  harness, model, kind: "decision" | "gotcha" | "fact", name, description, body,
  target: { bundleId, bundleDigest } | null, supersedes,
  evidence: { outcome: "success", verificationPassed, changedFiles }, at }
```

One candidate memory the plane parsed from the fenced `agent-plane-memory` block at the end of a
composed session that reached a `completion` checkpoint with outcome `success` (plan Q2, Q4).

- The object is closed: an unknown field is rejected.
- `proposalId` is `mp1_` + hex sha256 of the RFC 8785 JSON of
  `{v: 1, sessionId, index, bodyDigest}`, where `index` is the entry's 0-based position in the
  block and `bodyDigest` is `sha256:` + hex sha256 of the UTF-8 `body`. The same entry gives the
  same id on every parse, restart and machine.
- `seq` is the plane's ingest order, assigned once, strictly increasing. A cursor; gaps allowed.
- `model` is the session's resolved model, or `null` when the harness reported none.
- `name` is a kebab-case slug (at most 64 characters), the memory file name without `.md`.
  `description` is one line (1–300 characters). `body` is 1 to 4096 UTF-8 bytes, the memory file
  limit; the byte limit is checked by the reference validator.
- `target` names a bundle the session's revision pinned, at the pinned digest, or is `null` when
  the agent named none or one the revision did not pin. `supersedes` is the sorted, unique member
  paths of that bundle the proposal replaces, and is empty when `target` is `null`.
- `evidence` is counts only: `outcome` is always `success` in v1, `verificationPassed` is the
  session's last verification (`null` when none ran), `changedFiles` a count. No file names, no
  transcript, no tool input.
- `at` is the completion checkpoint's time, never the time of extraction.
- `name`, `description` and `body` MUST NOT contain an absolute path, an inline credential or a
  hostname or IP address. The plane drops (never redacts) an entry that trips a guard and counts
  the reason; a reader MUST reject an event that carries one anyway. The guards are in
  `memoryProposalGuardHits`; they catch common leaks, and the rule is the requirement.

## Feed (plane, S5)

`GET /api/memory/proposals?after=<seq>&limit=<n>` with a bearer credential holding `memory.read`
(API 2.8). Same rules as the asset usage v1 feed, except `limit` is 1 to 100 (default 100):

- `after` is an integer from 0 (the default) to 2^53 − 1; anything malformed is `400 { error }`.
- The answer is a `MemoryProposalPage` `{ schemaVersion, events, next }`: the proposals with
  `seq > after` in `seq` order, at most `limit`. Every event's `schemaVersion` is the page's.
- `next` is the last event's `seq`, or `after` when the page is empty.
- Stored proposals are immutable, so paging by `after` neither skips nor repeats one.
- Without `memory.read`, `403`; no credential, `401`. The plane validates each page before
  sending it and answers `500` rather than send one that fails.
- The plane has no route that accepts, rejects or writes memory.

`memory.read` is separate from `telemetry.read` because proposal bodies are memory content, not
counts (plan Q5). It is browser-optional: `open` requests it only when the credential holds it, so
a credential minted before 2.8 still opens the UI. Cockpit rotates its credential once with
`--capabilities …,memory.read`.

## Reader obligations

- Snapshot (plane): keep the last snapshot that validated; a failed fetch or a failed validation
  keeps it and marks it stale, as registry federation does. Health never enters a composition
  decision, spec or digest; it feeds only the shadow log (plan §2.2).
- Proposals (Cockpit): deduplicate by `proposalId`. A second, different body under a known id is
  a conflict: keep the first and set the second aside. Only an operator's accept writes a memory
  file; no proposal is auto-accepted.

## Versioning

`schemaVersion` is `MAJOR.MINOR`, policy as in [registry v1](registry-v1.md). The objects are
closed, so a reader rejects a minor newer than its own. A minor bump is announced by an API
version bump (plane side) or a Cockpit registry version bump (snapshot side).

## Distribution

As registry v1: Cockpit vendors `contracts/memory/v1` into `contracts/memory/`, pinned to a commit
SHA of this repository, with `VENDORED.json` and a sha256 manifest test. No moving-branch
dependency.
