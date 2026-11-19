# Agent runtime contract v1

Status: normative for agent runtime v1 (API 2.10, Agent Runtime Registry PR 3, owner decision
G.1 of 2026-11-18), v1.1 (API 2.11, PR 4: the conformance probe). It fixes the read-only projection of the plane's in-tree runtime catalogue,
each assistant's lifecycle states, and the operator disable overlay. Consumers: the Control Plane
web UI and the `aos runtimes` CLI (`apps/cli`). Cockpit does not read it; it vendors this contract only if it
ever does.

The JSON Schemas (draft 2020-12) under `contracts/agent-runtime/v1/` are the wire authority:
`catalog.schema.json`, `assistant-lifecycle.schema.json`, `operator-state-change.schema.json` and
(1.1) `conformance-result.schema.json`.
`apps/api/src/agent-runtime-contract.ts` is the reference validator and adds the rules a schema
cannot state. The fixtures in `contracts/agent-runtime/v1/fixtures/` are run by the API tests.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## What this is not

The catalogue is a frozen array literal in this repository (`apps/api/src/modules/runtime-catalog.ts`
and core `RUNTIME_KINDS`). A runtime is added by a reviewed PR that adds an adapter class and one
descriptor. This contract projects that catalogue as data. It MUST NOT carry code, adapter
options, an executable path, a package name or a credential, and nothing in it is ever loaded,
installed, executed or fetched by the plane. Being listed grants nothing.

Configuring an instance stays a local edit of the workspace config file. No route here adds a
runtime, changes options, installs a CLI or signs in.

Two registries exist and are different things: Cockpit's registry v1 serves assets (skills, MCP
servers, memory bundles); this contract describes the plane's runtimes. The only join is a
runtime's `registryAssistant`, which is a registry v1 `compatibility.assistants` id.

## Routes

| Route | Scope | Since | Response |
| --- | --- | --- | --- |
| `GET /api/runtimes/catalog` | `tasks.read` | 2.10 | `RuntimeCatalog` |
| `GET /api/assistants` | `tasks.read` | 2.10 (additive) | each element gains `lifecycle: AssistantLifecycle` |
| `GET /api/assistants/:id/lifecycle` | `tasks.read` | 2.10 | `AssistantLifecycle`; 404 for an unknown id |
| `POST /api/assistants/:id/disable` | `commands.write` | 2.10 | `OperatorStateChange`; 404 for an unknown id |
| `POST /api/assistants/:id/enable` | `commands.write` | 2.10 | `OperatorStateChange`; 404 for an unknown id |
| `POST /api/assistants/:id/test` | `commands.write` | 2.11 | `ConformanceResult`; 404 for an unknown id; 409 while a test of the same assistant runs or when the assistant is no longer configured |

No new capability is introduced (owner decision G.4), so no credential rotation is needed. An
unknown id is one the registry has no row for; the 404 body is `{ "error": "Unknown assistant: <id>" }`
and nothing is written.

`GET /api/assistants` keeps every field it served before 2.10, with the same meaning and in the
same order: `id`, `provider`, `enabled`, `manifest`, `manifestUpdatedAt`, `quota` (absent when
unknown), `quotaObservations`. `enabled` is still config `enabled` only. `lifecycle` is appended.

## RuntimeCatalog

`{ schemaVersion, descriptorVersion, runtimes[] }`. Each runtime: `provider`, `label`,
`transport` (`native`; `acp` is reserved for the ACP bridge), `maturity` (`verified` or `scaffold`:
the event mapping is not proven against a pinned CLI), optional `harness` (absent: routable,
never composed), optional `registryAssistant`, `approvalModes` (the modes the adapter enforces; it
refuses the rest before a process starts), `conformanceRequired`, optional `docs` (official
`https://` URLs shown to the operator; the plane never fetches them). Order is catalogue order.
Providers are unique.

## AssistantLifecycle

Separate states, each with its own evidence. No state implies the next.

| Field | Evidence | Meaning |
| --- | --- | --- |
| `catalogued` | code | this build has a descriptor for the provider |
| `configured` | config file | the workspace config defines this assistant now |
| `installed.state` | `capability_probes`, or a live check of the SDK-bundled Codex executable for a configured OpenRouter assistant | `present` (with `version` when it is safe to repeat), `missing` (the CLI did not run), `in-process` (no CLI), `unknown` (no probe yet) |
| `auth.state` | the adapter's manifest | `core.auth.state`, or `unknown` when no manifest exists; `source` is the manifest's evidence source. Since 1.1 the manifest itself may say `unknown`: installed, sign-in not verified (Cursor) |
| `conformance` | `runtime_conformance` | see below |
| `enablement` | config + overlay | `config` (config `enabled`), `operator` (`none` or `disabled`), `effective` = config AND operator is not `disabled` |
| `readiness` | derived | see below |
| `requestDependent` | fixed list | constraints evaluated per request, which `readiness` does not cover |

### Readiness is not eligibility

`readiness` has `scope: "request-independent"`. `ready` is true exactly when `reasons` is empty.
The reasons are the router's own hard-filter texts for the facts that do not depend on a task:
`disabled in workspace config`, `disabled by operator`, `no capability manifest (sync has not run)`,
`auth <state>` and (1.1, only for an instance that requires conformance)
`conformance required: <state> for the observed CLI and descriptor version`, in that order.

A ready assistant MAY still be filtered for a specific task. Whether an assistant is eligible for
a task is decided only by the router (and Prepare) for that request, against the constraints in
`requestDependent`: the repository allowlist, filesystem and shell capability for a repository
task, cooldowns, quota projections and blockers, workspace policy, approval-mode enforceability, a
user override, and composition. A client MUST NOT present `readiness.ready` as "will be routed".
For a task's actual answer, read its routing explanation (`GET /api/tasks/:id/routing`).

### Conformance

Rows are keyed by `(assistant_id, cli_version, descriptor_version)`. `conformance.state` is:

- `pass` or `fail`: a row exists for the CLI version the last probe observed AND the runtime's
  current descriptor version. `cliVersion` and `checkedAt` are reported only then.
- `stale`: rows exist, but none for that pair (a new CLI version or a new descriptor version, or
  no probe yet). Earlier evidence never vouches for a version it was not taken on.
- `not-run`: no row exists.

`POST /api/assistants/:id/test` writes the rows (below). The stored `checks` column is never
served by the lifecycle.

`conformance.required` is the instance's effective requirement: the descriptor's
`conformanceRequired`, or (the fake only) its per-instance test option `conformanceRequired: true`.
Every shipped descriptor has `conformanceRequired: false` (owner decision G.3, pinned by a test), so
a failed, missing or stale row never changes an existing runtime's eligibility. An instance that
requires conformance fails closed: the router, the quota plan, the Composer's stage 2 (filter
`conformance`) and an explicit compare/race start all refuse it unless `state` is `pass`, and
`readiness.ready` is false with the router's text. A CLI or descriptor version change voids the
evidence (`stale`) until the instance is tested again.

### ConformanceResult (1.1)

`POST /api/assistants/:id/test` runs only checks that are credential-free and quota-free by
construction. It never calls the registered adapter, starts a generation, installs a runtime,
changes a credential or writes config.

| Check | Level | What it does |
| --- | --- | --- |
| `executable` | host | `<cli> --version` (the probe's command, bounded, default 5 s). `pass`, `unavailable` (`executable_missing`, `executable_not_runnable`), `fail` (`timeout`, `nonzero_exit`, `empty_version`, `unsafe_version_output`) or `unsupported` for an in-process runtime |
| `approval-refusal:<mode>` | build | for each mode outside the descriptor's `approvalModes`: the runtime's real adapter class, its provider entry point pointed at a binary that cannot exist (Bedrock: no runtime ARN), must refuse with `NotSupportedError` naming the mode. A missed refusal can only fail to start. `approval-refusal` is `unsupported` when every mode is enforced |
| `manifest-claims` | build | every unit-level `harness` claim of the stored manifest is one the adapter conformance suite proves (`UNIT_PROVEN_CLAIMS`) |
| `host-claims` | host | `pass` when the manifest makes no host-level claim (`processIsolation` other than `none`, `agentUser`); otherwise `not-run` (`host_probe_not_authorized`): host evidence needs a separately authorized probe, and the result is `fail` |
| `manifest-redaction` | host | the stored manifest carries no inline credential and no value of a credential-named environment variable |
| `self-description` | provider | never executed: no CLI self-description (Claude `system/init` then cancel, Codex `debug prompt-input`) is proven here to make no model call, so it is `not-run` (`quota_free_unverified`), or `unsupported` where none exists |
| `in-process-run` | build | the in-process fake only: a scripted run ends exactly once, last, ok |

`status` is `pass` when no check is `fail` or `unavailable`, no claim is unproven and at least one
check passed; `unsupported` when nothing could be checked (not recorded); otherwise `fail` with
classified `reasons`. A `pass` covers exactly the checks listed as `pass`: `not-run` and
`unsupported` checks are never counted as passing. The row is keyed by the version this test
observed (`in-process`, or `unavailable` when the CLI did not run) and the descriptor version; a
re-test of the same pair replaces it. An unsafe version string is neither repeated nor recorded.
The response and the row carry check names, statuses, evidence levels, fixed reasons and
timestamps only: never stdout, stderr, a transcript or a credential.

## The operator disable overlay

`assistants.operator_state` (migration 051) is NULL or `disabled`.

- It can only REMOVE eligibility. `disabled` excludes the assistant from routing whatever config
  says; the router's failure text is `disabled by operator`, listed after
  `disabled in workspace config` when both hold. There is no operator `enabled`.
- `enable` clears the overlay and nothing else. A config-disabled assistant stays disabled, and
  every other router filter still applies.
- Both routes are idempotent. A request for the state the row already has answers
  `changed: false` and writes nothing. A change sets `operator_state_at` and appends a
  `capability_changes` row with `field: "operator.state"`, `old_value`/`new_value` `none` or
  `disabled`, and `source: "manual"`.
- It affects future routing decisions (intake, wake, run-now, failover, handoff, the Composer's
  stage 2) and quota planning. It does not touch a session that is already running, which
  finishes on the assistant it started on. An explicit operator `compare`/`race` start names its
  assistants directly and is not a routing decision; since the parallel disable gate (#195) it is
  refused (HTTP 409) when a named assistant is config-disabled or operator-disabled, and since 1.1
  when one requires conformance it does not have.
- It survives restarts: `Registry.init()` re-seeds provider and config `enabled` only.
- In the Composer's decision the overlay is the existing `disabled` filter; its reason reads
  `disabled by operator` (or `disabled in workspace config or by operator` when both sources
  removed candidates). No composition contract value changes.

## Credentials

No field in this contract carries a credential, an environment value or a provider transcript.
A descriptor may name an environment variable internally (`credentialEnv`); neither the name nor
its value is projected. A CLI version is repeated only when it is at most 128 printable
characters and does not match the shared inline-credential guard (`noInlineSecret`, the same
pattern as registry v1, pinned by a test). Malformed timestamps are omitted rather than repeated.

## Versioning

`schemaVersion` is `1.1` (1.0 plus `ConformanceResult` and the conformance readiness reason). A reader accepts the same major with a minor no newer than its own: the
objects are closed (`additionalProperties: false`), so an older reader cannot honour a newer field.
A new field is a minor bump of this contract and of the Control Plane API.

## Rollback

Revert the code. Migration 051 is additive (two nullable columns, one table) and older code
ignores both, so no down-migration is needed. A row left `disabled` by the overlay is ignored by
older code: the assistant routes again on config `enabled` alone.
