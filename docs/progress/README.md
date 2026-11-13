# docs/progress

The backlog the autopilot and the manual lanes take work from (auto copilot plan §C.1 "Desired
work", §C.3). It holds desired work for **both** repositories. Merged PRs are its only writers.

| File | What |
|---|---|
| `backlog.yaml` | the items |
| `backlog.schema.json` | the item shape (JSON Schema 2020-12) |
| `../../scripts/backlog-check.mjs` | the check: `node scripts/backlog-check.mjs [file] [--digests]` |

`backlog-check` exits 0 on a valid file, 1 on errors (one line each), 2 on a read or usage error.
It reads enums and required fields from the schema, and adds the rules a schema cannot hold:
unique ids, known `depends_on` targets, no cycles, and no dependency install without `--offline`.
`--digests` prints `<id> <sha256>` per item, over canonical JSON, so YAML layout and key order do
not change it: this is the revision digest of §C.3.

## Item fields

| Field | Rule |
|---|---|
| `id` | stable forever; becomes the ref `os/<id>`; `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 60 chars |
| `title`, `phase` | free text |
| `repo` | `ai-control-plan` or `cockpit` |
| `size` | `S`, `M` or `L` (1, 3, 8 estimated scope points) |
| `depends_on` | ids in this file |
| `files` | repo-relative paths or globs the item expects to touch; keeps parallel items disjoint |
| `lane` | `oci-loop` (the OCI autopilot may run it), `manual-cloud` (a cloud thread reserves `os/<id>` first), `owner` (only itay) |
| `profile` | the routing profile for the run: `auto`, `preserve-quota`, `fastest`, `best-quality`, `lowest-tokens` |
| `night` | eligible for the night window |
| `source`, `notes` | optional: where the audit found it, and anything the runner or reviewer must know |
| `acceptance` | required for `oci-loop`; see below |

There is no status field. Status is derived (§C.3) from the `os/<id>` ref, its PR and the plane's
attempts.

## Acceptance (§C.2.7)

```yaml
acceptance:
  commands:                 # non-empty, run in order in the snapshot root, offline
    - { run: "pnpm test", replaySafe: true, timeoutSec: 2700 }
  writable:                 # repo-relative; everything else in the snapshot is read-only
    - "node_modules"        # a directory (created if missing)
    - { file: "x.json" }    # one file that may not exist yet; its parent stays read-only
  drive: "free text"         # optional; not executed
```

- Commands are read from this file at `origin/main`, never from the task worktree.
- `replaySafe` is required on every command, never implied. Mark it `true` only when re-running
  the command after a crash cannot repeat an effect outside the writable paths. A run that crashed
  during a command that is not replay-safe is `blocked`.
- A dependency install must be offline: `pnpm install --offline --frozen-lockfile` or
  `npm ci --offline`. The plane fills the package store before the run.
- `writable` may not be absolute, contain `..`, be the root, or sit under `.git`. Temp files go
  to the system temp directory, which is outside the snapshot.

### How the writable lists were measured (2026-11-13)

Each repository's `origin/main` was checked out fresh, detached, and its acceptance commands were
run under `unshare -rn` with only a private `lo` up (no route out; a probe to the npm registry
failed) and a pre-filled package store. Afterwards
`git status --ignored` listed only the paths below, and the tracked tree was unchanged.

| Repo | Commands | Written |
|---|---|---|
| ai-control-plan | `pnpm install --offline --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` | `node_modules`, `apps/api/node_modules`, `apps/web/node_modules`, `packages/core/node_modules`, `packages/adapters/node_modules`, `eval/node_modules` |
| cockpit | `npm ci --offline`, `npm test`, `npm run build` | `node_modules`, `.generated`, and the files `memory-garden-status.json`, `retro-action-status.json` |

**Loopback.** Both suites start servers on `127.0.0.1` and connect to them. With loopback down,
cockpit fails 118 of 1507 tests (`fetch failed`) and the plane's api package fails 176 of 1902.
With a private loopback up and still no route out, both pass in full (cockpit 1507; plane core
679, adapters 170, web 136, api 1819 + 83 skipped). So the acceptance scope needs its **own**
network namespace with only `lo` up, not just the §C.0 `skuid` rule that drops `127.0.0.0/8` for
`aos-agent` (that rule would also drop the test's own servers). P0-4's runner does this.

Cockpit's `npm test` is marked `replaySafe: false`: some of its tests spawn local servers and PTYs,
and that has not been shown to be free of effects outside the snapshot.

## The audit

The first `backlog.yaml` (P0-9) lists only open work, from: the auto copilot plan §F and §H, the
open findings in both repositories' `docs/PROJECT_MEMORY.md`, and the open PRs in both
repositories (none on 2026-11-13). Shipped work stays in `PROJECT_MEMORY.md`. Items whose code
claim was checked against `main` say so in `source`; the others say "re-check on main first".
