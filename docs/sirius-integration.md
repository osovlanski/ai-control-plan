# Sirius / NanoClaw integration decision

2026-09-18 · Proposed ownership, source-reviewed; implementation proof is gated
on acceptance of this decision and the API seam. No Sirius runtime was registered,
restarted or sent a task during this review.

## Evidence and current installation

Actual repository: `/home/ubuntu/workspace/oss/nanoclaw`, `main@5168c0c6`, package
2.3.0, origin `https://github.com/nanocoai/nanoclaw.git`. It has local package/lock/
workspace and channel-barrel edits plus untracked Telegram and `src/ops` additions;
all were preserved. Do not treat the checkout as the pristine upstream release.
Its AGENTS.md describes the v2 mailbox architecture; older v1 integration ideas
do not describe this installation. Node >=22 host, Bun container runner, pnpm 11.

The user service `nanoclaw-v2-899f8402.service` was active/running, launching
`/home/ubuntu/.local/bin/node /home/ubuntu/workspace/oss/nanoclaw/dist/index.js` from
the repository. The generic `nanoclaw.service` was not the actual service. Docker
showed OneCLI 1.41.0 and PostgreSQL 18; no agent container was observed. This is
host-process evidence only: provider availability, source-to-dist equivalence,
credential validity and successful model execution were not tested. Selected
nonsecret configuration identifies default provider `claude` and timezone UTC;
the source defaults to Docker. No served model is inferred from that default.

Source audit (paths relative to NanoClaw):

- `src/index.ts`, `router.ts`, `session-manager.ts`: initialize/migrate central DB,
  register channels, route messages to groups/sessions, adopt running sessions at
  startup and run polling/sweeps. Shutdown of host loops does not establish that
  every container is terminated; adapter cancellation must confirm the outcome.
- `src/mailbox/model.ts`, `src/db/migrations`: `data/v2.db` plus per-session
  `data/v2-sessions/<group>/<session>/{inbound,outbound}.db`; host/container have
  opposite write ownership. Sequence parity distinguishes writers. Inbound records
  include ID, status, tries, due time and recurrence. `processing_ack` reports
  processing/completion/failure, not necessarily provider acceptance of prompt text.
  Outbound delivery reports channel delivery, a different acknowledgement.
- `src/container-runner.ts`, `src/drivers/types.ts`, `src/drivers/index.ts`: a
  SessionDriver has ensure/watch/snapshot/stop and install/group/session keys;
  Docker is the shipped default. Mounts, scoped labels and OneCLI setup already
  exist. These are useful runtime mechanisms, not an Agentic OS kernel contract.
- `container/agent-runner/src/providers/types.ts`: provider query events include
  continuation, text, activity and result; translation to Agentic OS events is
  required. Claude provider enables `bypassPermissions` with dangerous permission
  skipping and tool hooks/allowlists. Preventive Agentic OS approval parity is
  **not established**; post-hoc tool events cannot supply it.
- `src/delivery.ts`, `src/host-sweep.ts`: guarded host actions, delivery, scheduled
  wakeups, recurrence, heartbeat and idle cleanup. These can conflict with the
  plane's scheduler and recovery policies unless disabled/adapted for managed work.
- `container/agent-runner/src/memory/context.ts`: group `memory/index.md` and
  `memory/system/definition.md` composed at start/clear/compaction with bounded
  character budgets; agent memory is writable. Continuation rotation and stale
  reference reset are local policies that need kernel-visible ownership.
- Local untracked `src/ops/snapshot.ts` combines central SQLite backup with plain
  session file copies; restore/path safety and consistency are not proven.
  `poll-external.ts` can send outside the kernel delivery path. Neither is an
  approved managed-mission backup or notification mechanism.

Cockpit already observes NanoClaw central/mailbox data via its NanoClaw adapter
and memory reader. Preserve external monitoring identities; observation does not
make an external session a kernel-owned mission.

## Decision and integration matrix

Present **Sirius** as an opt-in assistant environment backed by a restricted
NanoClaw runtime under Harness. Technical diagnostics retain NanoClaw/version and
installation identity. A resident supervisory role may later execute explicit
kernel-issued missions. It receives no independent authority over the kernel.
It is neither a replacement scheduler nor a generic privileged UI plugin.

| Concern | Authority / seam | Reuse, adapt or reject |
| --- | --- | --- |
| Lifecycle | Kernel task/execution/session transitions; Harness dispatch/recovery | Reuse container mechanics; adapt status into canonical states; reject competing mission lifecycle |
| Identity | Durable workspace + task + execution request + session mapping to install/group/session/inbound ID | Adapt immutable mapping before launch; never join by goal text or display name |
| Launch/shutdown | Adapter under SessionRunner owns idempotent dispatch, adoption and confirmed stop | Reuse driver ensure/watch/stop and labels; no global service restart to cancel one mission |
| Health/availability | Manifest plus time-bounded host/driver/provider probes | Host running is insufficient; report unknown/stale/unavailable distinctly; quota separate |
| Capabilities | Existing assistant manifest and explicit capability checks | Declare only conformance-tested approval, cancellation, checkpoint and input capabilities; default deny |
| Model/provider | Run evidence from provider initialization/result | Separate requested/resolved/observed; never display “Sirius” as a model |
| Tools/permissions | Kernel approval and workspace policy before effect | Adapt blocking tool gate; current bypass mode fails proof gate; reject arbitrary external sends/self-modification |
| Working memory | Session/workspace-bound scratch and checkpoint references | Reuse limited mounts; forbid cross-workspace group reuse |
| Durable memory | Cockpit owns global durable memory and installed tools | Read-only scoped context bundle; proposed writes reviewed through Cockpit; no second global memory writer |
| Events | Canonical event ledger with stable source IDs and cursor | Adapt mailbox/provider events; dedup by mapped session + source record identity, not rendered summary |
| Checkpoints/continuation | Kernel policy, Harness verification/recovery | Reuse provider references as opaque checkpoints; expose rotation/compaction; reject silent policy override |
| Scheduling | Kernel scheduler only for managed missions | Disable Nano recurrence, autonomous wakeups and direct cron dispatch in managed profile |
| Failure/recovery | Kernel attempt state and fenced Harness ownership | Adopt surviving process; reconcile mailbox acknowledgements; unknown delivery stays unknown; no duplicate launch |
| Security/secrets | Workspace mount allowlist, least privilege, scoped OneCLI identity | Reuse credential gateway; selective secrets, not default broad access; no provider session export |
| UI | Generic Agents/mission/session/trace/orbit surfaces | Display Sirius via manifest; show in orbit only while participating; no scattered Sirius conditions |
| External monitoring | Cockpit read-only inventory | Reuse existing NanoClaw reader; do not turn every observed session into a managed task |

## API seam and smallest proof

The current seam is `packages/core/src/adapter.ts` (`AgentAdapter`) and
`SessionRunner.startProvider`; M15 runtime abstraction remains deferred. Do not
pretend a `RuntimeBackend` interface already exists. An eventual Sirius adapter
can call a restricted local bridge around NanoClaw SessionDriver/mailbox APIs.
Do not couple browser code to those files or write arbitrary SQLite rows from UI.

The bridge needs versioned commands: capability/health read; start with stable
execution-request ID and workspace policy; watch from a source cursor; inspect;
approval response with durable ID; cancel with acknowledgement; checkpoint and
adopt. Input is unavailable until the separate session-input contract is supported.
Persist mapping and dispatch intent transactionally before launch. Apply lease
epoch/fencing to every mutating command; replay same command returns same result,
conflicting payload fails. Never trust a client-supplied filesystem path as authority.

Proof sequence after ownership/API acceptance:

1. Register Sirius manifest, diagnostic implementation/version and honest probes.
   Agents shows unavailable when bridge, driver, credential scope or provider fails.
2. Route a deterministic eligible task using normal router; adapter starts a
   restricted fixture worker, with persisted mapping and workspace-scoped mounts.
3. Normalize start/message/tool/approval/usage/error/end/checkpoint events through
   the normal event ledger. Replays and reconnects do not duplicate traces.
4. Orbit participation follows effective running session evidence only; discovery,
   an idle daemon, completed work or failed health never lights an execution edge.
5. Prove denied tool action has **no effect**, approval recording and provider
   acknowledgement are distinct, cancel reaches the exact process and late events
   cannot revive a terminal session. Retain actor/command/source audit IDs.
6. Restart host/bridge at prelaunch, postlaunch/preack, running and approval-blocked
   points. Adopt or mark explicit unknown/recovery-needed; fence stale workers;
   no repeated side effect or second session. Exercise workspace escape rejection.
7. Only then consider a live provider smoke test with explicit scope and quota.

Blocking gates: preventive approvals, selective secrets, managed-mode scheduling
and continuation control, durable mapping/fencing, stop confirmation, consistent
checkpoint/backup and source/build identification. Review found no evidence these
all pass today. No integration implementation or live availability claim in this pass.
