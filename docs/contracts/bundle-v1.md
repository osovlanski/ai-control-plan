# Bundle contract v1

Status: normative for bundle v1, the second M0 slice (plan §3.3 stage 4; vnext increment 5).
Cockpit renders a per-run bundle and returns it; the Control Plane puts it inline into the
`ExecutionRequest`; the Execution Harness materializes it. This document fixes the wire between
Cockpit and the Control Plane. Rendering, provisioning and persistence are not part of it.

The JSON Schemas (draft 2020-12) in `contracts/bundle/v1/` are the wire authority:

| Schema | Body |
|---|---|
| `bundle-request.schema.json` | what the Control Plane asks Cockpit to render |
| `bundle-response.schema.json` | the rendered files and their manifest |

`apps/api/src/bundle-contract.ts` is the reference implementation of the rules below that a schema
cannot express, plus `assembleBundle`, which turns rendered files into a conforming response. The
conformance fixtures in `contracts/bundle/v1/fixtures/` are run by both repositories. Errors and
authentication are as in [registry v1](registry-v1.md); the transport endpoint is not fixed here.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## BundleRequest

```text
{ schemaVersion, harness, fragments: [name], memoryBundles: [{ id, digest }], skills: [{ id, digest }],
  model: { id, charsPerToken }, tokenBudget }
```

- `harness` is `claude-code` or `codex`.
- `fragments` is sorted ascending (byte order) with no duplicates. `memoryBundles` and `skills`
  are sorted by `id`, strictly.
- **Memory bundles and skills are pinned by digest.** Cockpit renders exactly that revision or
  fails the request; it never substitutes the current content. `skills` are the Composer's
  selected skills (registry v1 ids and digests) and the only skills that may be rendered.
- `model.charsPerToken` is the per-model estimator ratio (plan §3.3 stage 4). `tokenBudget` is the
  estimated-token ceiling for the whole bundle.
- **There is no output path.** The request object is closed: an unknown field, including any
  `outputDir`, `outputPath` or similar, is a schema violation. Cockpit returns bytes and never
  writes to a caller-supplied location (invariant 2). Adding a field that names a filesystem
  location is forbidden in every version, not just v1.

## BundleResponse

```text
{ schemaVersion, files: [{ relPath, content, digest }], manifest }
manifest = { harness, bundleDigest, compiler: { name, version },
             included: [{ kind, ref, digest, reason, relPath? }], excluded: [{ kind, ref, reason }],
             tokens: { estimated, tokenMethod: "estimated", charsPerToken, budget } }
```

**relPath.** A relative POSIX path from a closed allowlist. It never starts with `/` or a drive
letter, never contains `\`, and never contains a `.` or `..` segment. The allowlist is:

| Harness | Allowed relPath |
|---|---|
| `claude-code` | `CLAUDE.md`, `.claude/skills/<id>/SKILL.md` |
| `codex` | `AGENTS.md` |

`<id>` matches `[a-z0-9][a-z0-9-]{0,63}`. The schema pattern is the union of the table; the
per-harness narrowing is a validator rule. Widening the allowlist is a minor version.

**Files.** `files` MUST be sorted by `relPath` in strictly ascending byte order, so paths are
unique. `content` is UTF-8 text and must be well-formed Unicode: an unpaired surrogate is rejected (RFC 8785). `digest` is `sha256:` + hex sha256 of the UTF-8 bytes of
`content`. An empty `files` array is valid.

**Manifest.** `kind` is `fragment`, `memory_bundle` or `skill`. Every requested input appears
exactly once, in `included` (with the digest of the revision that was rendered) or in `excluded`,
each with a human-readable `reason`. An included pinned input MUST carry the pinned digest.
`compiler` names the renderer and its semver.

**Skills.** An included skill names the file it became in `relPath`. Every
`.claude/skills/<id>/SKILL.md` file MUST be named by exactly one included skill, and every
included skill MUST have its file, so a renderer cannot add a skill nobody selected. A harness
without a skill path in this version (`codex`) excludes requested skills with a reason.

**Finalization.** A composition is final only when no requested skill is excluded. When the
manifest excludes a skill (no skill path for the harness, or over budget), the Composer drops it
from the selection, records why in the assets stage, and requests the bundle again. The revision
is persisted from that second request; it never carries an attached skill that was not rendered.

**Tokens.** `estimated` is `ceil(total Unicode code points of all contents / charsPerToken)`, and
`tokenMethod` is always `estimated`: no exact local tokenizer exists for Claude or Codex. The
estimate MUST NOT exceed `budget`; the renderer excludes inputs (and says so) to fit.
`charsPerToken` and `budget` echo the request.

**Secrets.** Rendered content MUST NOT contain a secret value. Cockpit is responsible for not
rendering one; the plane rejects a bundle whose content matches registry v1's inline-credential
shape (`noInlineSecret`, read from that schema, not copied) and never persists it. As in registry
v1, the guard covers recognised shapes only.

The response object and the manifest are open for additive minor fields; `BundleFile` and the
request are closed.

## Determinism

Identical requests against identical inputs MUST produce byte-identical `files` and the same
`bundleDigest`.

- Content MUST NOT contain timestamps, hostnames or absolute paths. The validator guards the
  common shapes (an ISO-like `YYYY-MM-DD HH:MM` / `T` timestamp; `/home/`, `/Users/`, `/root/`,
  `/tmp/`, `/var/`, `/private/`, `~/`, `C:\`). Guards catch common leaks; the rule is the
  requirement. Hostnames have no guard.
- **bundleDigest** is `sha256:` + hex sha256 of the RFC 8785 canonical JSON of `files` sorted by
  `relPath` bytes (each element `{ content, digest, relPath }`), using `canonicalJson` from
  registry v1. The manifest is not covered: it describes the bundle, it is not the bundle.

## Limits

| Limit | Value | Why |
|---|---|---|
| Total decoded UTF-8 bytes of all `content` | 256 KiB (262144) | See below |
| Files | 65 | One instruction file plus the 64 skills a request may select |
| Bytes or code points per file | 262144 (schema `maxLength`) | Coarse schema guard; the total is the binding limit |
| Manifest entries, each of `included` / `excluded` | 192 | Three request lists of at most 64 inputs each; a `ref` is up to 256 characters, the registry asset id bound |

The bundle travels inline in the `ExecutionRequest` (vnext increment 5: inline, size-bounded, not
a content-addressed reference), so it lands in a persisted request row and in every replay of the
revision. 256 KiB is chosen because:

- At a typical 3.5–4 characters per token it is roughly 65k–75k estimated tokens, well beyond any
  sensible instruction bundle. The token budget, not the byte cap, binds in practice; the byte cap
  stops a runaway render.
- It matches the bounds the plane already applies to comparable inline blobs
  (`WorkspaceAuthority` output, 256 KiB; verification evidence, 256 KiB).
- JSON escaping of Markdown (newlines, quotes) roughly doubles at worst for normal text, so the
  encoded bundle plus the rest of a request stays under Fastify's default 1 MiB body limit if the
  bundle is ever posted over HTTP.

A bundle over the limit is a renderer error (`413 payload_too_large`), never a silent truncation.
A dedicated immutable composition-blob store is the upgrade path if real bundles approach it.

## Versioning

`schemaVersion` is `MAJOR.MINOR`, policy as in registry v1. Cockpit accepts a request whose minor
does not exceed its own (the request is closed, so an older server cannot honour a newer field),
and answers with the **request's** `schemaVersion`, using only what that version allows. A newer
server therefore never sends an older client a path its allowlist rejects; widening the allowlist
is a minor version that a client opts into by asking for it.

## Distribution (open owner decision, plan §7.7a)

As registry v1: Cockpit vendors these files pinned to a commit SHA of this repository with a
sha256 manifest test, until the owner decides §7.7a. No moving-branch dependency.
