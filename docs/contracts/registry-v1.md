# Cockpit registry contract v1

Status: normative for registry v1 (the M0 slice for the registry only; plan §3.5, §4 M0/M4/M8).
Cockpit serves this API and the Control Plane consumes it. Selection, composition, attachment
and provisioning are not part of v1.

The JSON Schemas (draft 2020-12) in `contracts/registry/v1/` are the wire authority:

| Schema | Body |
|---|---|
| `registry-snapshot.schema.json` | `GET /api/v1/registry/assets` |
| `registry-asset-content.schema.json` | `GET /api/v1/registry/assets/:id/content` |
| `registry-error.schema.json` | every non-2xx response |

TypeScript types in `apps/api/src/registry-contract.ts` are a convenience. That module is also the
reference implementation of the rules below that a schema cannot express. The conformance fixtures
in `contracts/registry/v1/fixtures/` are run by both repositories.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Endpoints

```text
GET /api/v1/registry/assets?kind=&assistant=&tag=   → RegistrySnapshot
GET /api/v1/registry/assets/:id/content             → RegistryAssetContent (current content only)
```

- Both are read-only. The API accepts no write and no caller-supplied filesystem path. Cockpit
  returns bytes and never writes into a caller's directory (invariant 2).
- `kind` is one of the asset kinds below; `assistant` matches `targets`; `tag` matches `tags`.
  All three are optional exact matches. An unknown `kind` or a malformed value is `400 bad_request`.
- `:id` is the asset `id`, percent-encoded as one path segment.
- Every response carries `X-Cockpit-Registry-Version: <schemaVersion>`, including errors.
- `/fragments`, `/memory/bundles`, `/memory/findings` and usage postbacks are not part of v1.

## Authentication

- Every request MUST carry `Authorization: Bearer <token>`. A missing or wrong token is
  `401 unauthenticated` with `WWW-Authenticate: Bearer`, and no other information is disclosed.
- Loopback binding is transport scope, not authentication (invariant 5). The token is required on
  loopback.
- The token is held in a regular, non-symlink file owned by the current user with mode `0600` (no
  group or world bits). Both sides refuse a file that fails these checks. Neither side copies the
  token into config, environment, logs, responses, telemetry or a database. Both redact it from
  their logs for the process lifetime and compare it in constant time.

## RegistrySnapshot

```text
{ schemaVersion, snapshotDigest, assets: [RegistryAsset] }
```

Each response is a full snapshot. There are no cursors, ETags or tombstones; a consumer detects
removal by absence.

**Ordering.** `assets` MUST be sorted by `id` in strictly ascending order of UTF-16 code units,
which for the permitted `id` alphabet equals byte order, so ids are unique. `tags`, `targets`,
`conflicts`, `compatibility.assistants` and `requirements.commands` MUST be sorted the same way and
contain no duplicates. A snapshot that violates ordering is invalid, even if its digest matches.

### RegistryAsset

| Field | Meaning |
|---|---|
| `id` | Stable identity across content changes, `^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,255}$` (no `/`). Cockpit uses `<nativeKind>:<name>`. |
| `digest` | Content digest (below). An asset revision **is** its digest; Cockpit keeps no history. |
| `kind` | `skill`, `plugin`, `agent`, `hook`, `mcp_server` or `rule`. |
| `nativeKind` | Producer-specific type, for example `claude-skills` or `codex-rules`. |
| `name`, `description` | Display metadata. `description` is `""` when unknown, at most 2048 characters. |
| `tags` | Sorted tag set. |
| `targets` | Sorted assistants the asset is installed for now. |
| `compatibility.assistants` | Sorted assistants that can load this kind of asset. |
| `requirements.secretRefs` | Secrets the asset needs, as references (below). `commands` is optional. |
| `conflicts` | Sorted asset ids known to conflict. `[]` when unknown. |
| `lineage` | `origin` (`proposal`, `library`, `manual`, `backfill`, `unknown`) and optional `sourceUrl`. Provenance, not a security verdict (invariant 6). |
| `enabled` | Whether the asset is active in the producer. A disabled asset is still listed. |
| `mcp` | Required when `kind` is `mcp_server`: `transport`, `command?`, `args?`, `url?`, `env`. |
| `installedAt` | Last observed install or modification time. Volatile. |
| `lastUsedAt?`, `stats?` | Optional usage metadata. Volatile. |

Objects are open: a consumer MUST ignore fields it does not know, so a minor version can add
fields. `SecretRef` and `mcp.env` are the exceptions; they are closed.

## Digests

All digests are `sha256:` followed by 64 lowercase hex characters.

**Canonical JSON** is RFC 8785 (JCS). The digested value space is strings, booleans, `null`,
integers, arrays and objects; a non-integer number in a digested field is a producer error,
and so is a string (or key) containing an unpaired UTF-16 surrogate. A content file's `path`, and
the content of a `utf8` file, must likewise be well-formed Unicode.

**Asset digest.** The producer decides which files make up an asset, and the content endpoint
returns exactly those files. For that file set, build one line per file,
`<hex sha256 of the file bytes> <path>\n`, where `path` is relative, `/`-separated, with no `.` or
`..` segment. Sort the lines by the UTF-8 bytes of `path`, concatenate them, and take the sha256
of the result. A single-file asset uses the same rule with one line. For an `mcp_server` the file
set is one file, `server.json`, whose bytes are the canonical JSON of the asset's `mcp` object.

**snapshotDigest.** Take the `assets` array in its required order. From each asset remove the
volatile fields, then compute `sha256(canonicalJson(assets))`. The volatile fields are exactly
`installedAt`, `lastUsedAt` and `stats`: they change without the asset changing. Every other
field, including fields from a newer minor version, is covered. Two snapshots with the same
`snapshotDigest` therefore list the same assets with the same content and metadata.

A filtered request (`kind`, `assistant` or `tag`) returns the digest of the filtered list. A
consumer that caches the catalog MUST request the unfiltered snapshot.

## RegistryAssetContent

```text
{ schemaVersion, id, kind, digest, files: [{ path, size, digest, encoding, content }], mcp? }
```

`encoding` is `utf8` or `base64`. `size` is the decoded byte length and each file `digest` is the
sha256 of the decoded bytes. The consumer MUST recompute the asset digest from `files` and compare
it with `digest` and with the snapshot entry it came from. A mismatch means the asset changed
between the two reads; the consumer re-reads the snapshot and never mixes the two.

## Secrets

- An MCP server is described with secret **references** only: an environment variable name
  (`{ "type": "env", "name": "API_TOKEN" }`) or a keychain reference. The producer MUST NOT emit a
  secret value in any field.
- Schema guards: `mcp.env` values must be `SecretRef` objects, so a string value fails validation.
  `mcp.command`, `mcp.args[]`, `mcp.url` and the `server.json` content must not contain a
  recognised inline credential (`Bearer <value>`, `token=`, `api_key=`, `secret=`, `password=`,
  `key=`, case-insensitive, quoted or unquoted, with optional spaces around `=`) unless the value
  is a `${VAR}` placeholder or the redaction marker `***`. The producer replaces any such value with `***` before emitting it.
- Guards only cover recognised shapes. The normative rule above is the requirement; the guards
  catch common violations.

## Limits and errors

| Limit | Value | On breach |
|---|---|---|
| Assets per snapshot | 5000 | `413 payload_too_large` |
| Content files per asset | 500 | `413 payload_too_large` |
| Content bytes per asset (decoded) | 4 MiB | `413 payload_too_large` |

A consumer enforces the decoded-bytes limit itself: the reference validator sums the decoded size of
every file and rejects a body above 4 MiB (`MAX_ASSET_CONTENT_BYTES`) before decoding it.

Errors use `{ "error": { "code", "message" } }`. Codes: `unauthenticated` (401), `bad_request`
(400), `not_found` (404), `payload_too_large` (413), `unavailable`
(503), `internal` (500). A `message` never contains a token, a secret value or an absolute path
under the user's home directory.

## Versioning and compatibility

`schemaVersion` is `MAJOR.MINOR`. A client written against `C` accepts a server version `S` when
`S.major == C.major` and `C.minor <= S.minor`. A client MUST reject an unknown major. A minor
version may only add optional fields or enum-free metadata. Removing or renaming a field, changing
the meaning of a field, or adding a value to a closed enum (`kind`, `origin`, `SecretRef.type`)
needs a new major.

## Distribution (open owner decision, plan §7.7a)

Default for v1: the schema files live in this repository under `contracts/registry/v1/`. Cockpit
vendors a copy pinned to a commit SHA of this repository, with a test that checks each vendored
file's sha256 against a recorded manifest. A moving-branch git dependency is never used. A
published package or release artifact can replace this once the owner decides §7.7a.
