# Plane-side process spawns (P0-A2 inventory)

`docs/agentic-os-auto-copilot-plan.md` §C.0, row "Any other plane-side spawn": every `spawn` /
`execFile` under `apps/api/src` and `packages/adapters/src`, classified by what decides the
command line and whether it executes content an agent can edit. Taken at `ecd8b78` plus this
slice. Re-run: `grep -rnE "spawn\(|execFile|execFileSync|spawnSync|execSync" apps/api/src packages/adapters/src --include=*.ts | grep -v '\.test\.'`.

"Agent task" = a task created with `runAs: "agent"` (`tasks.run_as`, `ExecutionPolicy.runAs`).

| Site | Command | Input that picks it | Runs agent-editable content? | For an agent task |
|---|---|---|---|---|
| `apps/api/src/modules/harness/workspace-authority.ts` `runCommand` (`spawn(..., { shell: true })`) | a verification command discovered from the project | the repository's own `package.json` etc. | **Yes** | **Never reached.** `CommandVerifier` returns `skipped` before it (`verification-providers.ts`, `repositoryCommands: "refused"`). It is the only caller. |
| `packages/adapters/src/claude.ts` `spawnProvider` | the Claude CLI | plane config | **Yes** (the provider runs tools) | Launched as `aos-agent` through `sudo -n -u aos-agent -g aos -- run-as-agent run …`. A run with `runAs` and no launcher is refused. |
| `packages/adapters/src/claude.ts` `stopAgentUnit` | `sudo … run-as-agent stop <unit>` | session id (validated) | No | New in this slice. |
| `packages/adapters/src/codex-app-server-runtime.ts`, `codex-app-server-history.ts`, `codex-probe.ts` | the Codex CLI | plane config | **Yes** | Refused at Prepare: the Codex adapter does not declare `harness.agentUser`. Codex as `aos-agent` is P1-0. |
| `packages/adapters/src/cursor.ts` | the Cursor CLI | plane config | **Yes** | Refused at Prepare, same reason. |
| `apps/api/src/repo/git.ts` | `git -C <repo or worktree> …` (worktree add/remove, status, diff, add, commit, rev-parse) | fixed argv; paths from the plane | **Indirectly**: `git` reads the worktree's and the repository's config and hooks | Kept as the plane user. See "Residual" below. |
| `apps/api/src/modules/verification-coordinator.ts` | `git -C <worktree> rev-parse / status` | fixed argv | Indirectly (config) | Kept. Read-only commands. |
| `apps/api/src/modules/composer/repo-signals.ts` | `git -C <repo> …` read-only | fixed argv | Indirectly (config) | Kept. Runs on the source repository, before a worktree exists. |
| `apps/api/src/modules/harness/provider-processes.ts` | `ps -A -o pid=,ppid=` | none | No | Kept. |
| `apps/api/src/modules/capability-probe.ts` | `<assistant command> --version` | plane config | No | Kept. |
| `apps/api/src/bin/open-web.ts` | a browser opener | operator's shell | No | Not part of the server. |

The legacy (non-Harness) path, compare/race and parallel candidates call `adapter.start` without
`RunSpec.runAs`. An agent task is refused on all of them (`orchestrator.startTask`), and the
session runner rejects any request for an agent task that lacks `policy.runAs`, whoever built it.

## Residual: git as the plane user in an agent-written worktree

`commitCheckpoint` runs `git add -A` and `git commit` as the plane user in a worktree the agent
can write. What an agent could plant there, and why it does not run as the plane user:

- hooks: a linked worktree's hooks directory is the main repository's `.git/hooks`, which is under
  the plane user's home and not writable by `aos-agent`;
- a replaced `.git`: the agent can delete the worktree's `.git` file and put a `.git` directory of
  its own there, with its own config and hooks. Git refuses to use it as the plane user, because
  the directory is owned by another user ("dubious ownership"). **This holds only while the plane
  user has no `safe.directory` entry covering `/var/lib/aos`.** `aos-setup` therefore writes the
  agent's `safe.directory` into `aos-agent`'s own git config, and `aos-status` fails if the system
  or the plane user's config trusts that tree. The checkpoint then fails and the plane reports it.

What remains is content-driven git behaviour: a committed `.gitattributes` naming a filter only
runs a filter that is already defined in the plane user's or the repository's config, which the
agent cannot write. No fix is made in this slice. When P0-6 moves the repository clone into the
`aos` tree, the repository's `.git/config` and hooks become agent-adjacent and this row must be
re-examined (run checkpoint git with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, or
move it behind the wrapper).
