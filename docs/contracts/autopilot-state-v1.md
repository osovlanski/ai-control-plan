# Autopilot state contract v1

Status: normative for autopilot state v1 (API 2.21, backlog item `cockpit-autopilot-view`, plane
half). It fixes one read, `GET /api/autopilot/state`, so Cockpit can show the autopilot read-only
without recomputing anything the plane already decides.

The JSON Schema (draft 2020-12) `contracts/autopilot-state/v1/autopilot-state.schema.json` is the
wire authority. `projectAutopilotState` in `packages/core/src/autopilot-state.ts` is the only
projection; `apps/api/src/modules/autopilot-state.ts` serves it. The conformance fixtures in
`contracts/autopilot-state/v1/fixtures/` are run by both repositories; Cockpit vendors this
directory pinned by commit SHA with a sha256 manifest test.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## The route

- `GET /api/autopilot/state`, capability `tasks.read` (the same as `GET /api/autopilot`). No new
  capability; `autopilot.operate` is never needed to read. No credential is 401; a credential
  without `tasks.read` is 403.
- The plane MUST validate every body against the schema before it is sent. A body that fails is
  answered 500 `{ "error": "autopilot state failed the autopilot-state v1 contract" }`, never sent.
- `GET /api/autopilot` is unchanged and unversioned: it stays the plane web UI's own read. A
  consumer outside this repository MUST use `/api/autopilot/state`.

## What it is

A projection of three readers the plane already has, each called once per request: the autopilot
service (`status`, `windows`, `attempts(20)`, unresolved `externals`), the dispatcher (`status`)
and the restore service (`status`). The projection only copies, renames and redacts. A consumer
MUST NOT derive autopilot state itself (for example "can it start", "is the window charged out",
"is this attempt final"): every such answer is a field.

## Fields

Every field is always present; an absent value is `null`, never a missing key.
`additionalProperties` is false at every level.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `"1.0"`. |
| `observedAt` | When the plane read the snapshot (ISO 8601). |
| `status` | `stopped`, `draining` or `running` (`autopilot_state.status`). |
| `stopReason` | Why it last stopped (redacted text), or null. |
| `startedBy` | The credential id (`kid`) that last started it, or null. An id, never a secret. |
| `updatedAt` | When `status` last changed. |
| `window` | The window open at `observedAt`, or null. |
| `nextWindowOpensAt` | When the next window opens, or null. |
| `windows` | Every window that has not closed yet, by `opensAt`. |
| `billingAttestation` | `{ attestedAt, expiresAt, current }`, or null when none was recorded. |
| `settingProblems` | `{ setting, detail }` per setting that refuses a start (§C.2.10). Empty = none. |
| `currentAttempt` | The one non-final attempt, or null. |
| `recentAttempts` | Up to 20 attempts, newest first. |
| `dispatcher.problems` | Configuration gaps that stop the dispatcher selecting anything. |
| `dispatcher.inFlight` | Keys of background acceptance or publication calls (`accept:<attemptId>`, `publish:<attemptId>`). |
| `dispatcher.selection` | `{ itemId, status, reason }` per backlog item, as the dispatcher saw it on its last selection. |
| `dispatcher.lastTick` | `{ at, action, itemId, attemptId, detail }` for the last dispatch tick, or null. `action` is `idle`, `reserved` or `drove`. |
| `restore` | `pending`, `reconciling`, `restoreId`, `detectedAt`, `reconciledAt`, `reconcileError`, `reportComplete`, `reportReadCurrent`, `startBlockedBy`. Never the report. |
| `openExternals` | The number of unresolved external records (the reader caps its list at 200). |

A window is `{ id, opensAt, closesAt, maxItems, charged, exhaustedByRestore }`;
`exhaustedByRestore` is true when a restore was detected inside it, so it admits no launch.

An attempt is `{ id, itemId, attemptNo, state, final, reason, repo, taskId, runtimeBudgetMs,
runtimeUsedMs, deadlineAt, deadlineBound, createdAt, updatedAt, finalAt, requeuedAt }`. `state` is
one of the sixteen attempt states; `final` is true exactly for `published`, `closed`, `failed`,
`blocked`, `cancelled`, `conflict` and `external` (the schema enforces the pairing). `repo` is the
`autopilot.repos` key, not a path.

## Redaction

- Left out on purpose: worktree and repository paths, reservation ids and refs, SHAs, backup names,
  the restore report, approval or provider content, and every configuration value.
- Free-text fields (`stopReason`, `settingProblems[].detail`, attempt `reason`,
  `dispatcher.problems`, `selection[].reason`, `lastTick.detail`, `restore.reconcileError`,
  `restore.startBlockedBy.detail`) pass the core secret rules (`redactText`), then URLs become
  `[url]` and absolute or `~/` filesystem paths become `[path]`. The plane's own API routes
  (`/api/...`) are kept, because details name the route that fixes them.

## Versioning

v1 is never changed in place: every field is required and `additionalProperties` is false, so any
change to the shape is a new schema directory (`v2`), a new `schemaVersion` and a new API minor
version. A consumer MUST reject a `schemaVersion` it does not know.
