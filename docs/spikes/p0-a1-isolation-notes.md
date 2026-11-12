# P0-A1 isolation spike: notes (throwaway branch `spike/autopilot-isolation-20261111`)

Plan: `docs/agentic-os-auto-copilot-plan.md` §F Stage 2. Status: **PREPARATION DONE; BLOCKED on approval of sudoers + nftables** (2026-11-12). The `aos-agent` Claude login is done (see below).

## Implementation state at `87d9274` (main after #163)

- No autopilot code exists: `grep -ril autopilot apps packages scripts` finds nothing. P0-A1 is the earliest slice and is incomplete; P0-A2 and Stage 3 depend on it.
- `origin/autopilot/integration` is an older v4 roadmap branch (`52056db`), not implementation.
- No backlog ledger exists yet (`docs/progress/backlog.yaml` is P0-9). Progress is recorded here and in `docs/PROJECT_MEMORY.md`.

## Observed on this host (read-only and unprivileged probes)

| Check | Result |
|---|---|
| `id aos-agent` | no such user |
| `/var/lib/aos` | absent |
| `loginctl show-user ubuntu` | `Linger=yes`; user manager state `degraded` (a unit failed; not investigated) |
| systemd | 255; cgroup v2 with cpu, memory, pids controllers |
| `systemd-run --user --scope -p RuntimeMaxSec=3 sleep 30` | terminated at 3 s (exit 143) |
| same with a backgrounded child (`bash -c 'sleep 30 & sleep 30'`) | terminated at 3 s, no `sleep 30` left behind |

So the `RuntimeMaxSec` kill of a scope and its children works for the `ubuntu` user manager. This is evidence for the mechanism behind G20 only; it is not G20 (no plane, no `aos-agent`, no real session).

## Sequence of host changes

On 2026-11-11, before any authorization, nothing on the host was changed; only the read-only and unprivileged probes above ran. Later that day, under the staged authorization recorded below, the `aos` group, the `aos-agent` user, linger, `/var/lib/aos` and the wrapper were installed. Still **not applied**: `/etc/sudoers.d/aos` and the nftables table `inet aos_agent_net` (both drafts pass `visudo -c -f` and `nft -c`). Until they are, G0, G21 and G26 are **not run**.

## Rollback plan proposed for approval

1. `userdel -r aos-agent`, `loginctl disable-linger aos-agent`, remove `/var/lib/aos`.
2. Delete `/etc/sudoers.d/aos` (validate with `visudo -c` before and after).
3. `nft delete table inet aos_agent_net` and remove the unit; confirm with `nft list ruleset`.
4. Keep an SSH session open and schedule `at now + 10 min` to run the rollback while nftables rules are first tried.

## Done under the staged authorization (2026-11-11)

- `aos` group and `aos-agent` user (uid 1002, nologin, no sudo, home 0700), linger on, user manager `running`.
- `/var/lib/aos/{profiles,worktrees}` owned `ubuntu:aos`: profiles 0750 (agent reads, cannot write), worktrees 2770 setgid (agent writes).
- `/usr/local/lib/aos/run-as-agent` installed root:root 0755 (draft: `docs/spikes/p0-a1/run-as-agent`). Exercised via full sudo: runs as `aos-agent`, `RuntimeMaxSec=3` kills scope and child (exit 143), rejects a bad id and a cwd outside allowed roots (exit 64).
- Degraded user manager (ubuntu): caused by my own two probe scopes (cleared with `reset-failed`) and a pre-existing failed `codex-0929.service`. Neither affects the spike.
- `nft -c` and `visudo -c -f` pass on the drafts. Nothing applied.

## Findings

- `/home/ubuntu` is 0750, so `aos-agent` cannot read the main checkout or the plane's worktrees. Good isolation, but task worktrees must live under `/var/lib/aos/worktrees`, and a `git worktree` created from a `/home/ubuntu` repo keeps its metadata in the plane user's `.git`, which the agent cannot read. P0-6 must clone or give the agent a repo under the `aos` tree. Plan §C.0 says "worktrees group aos" but does not resolve this; recorded as slice evidence for P0-A2.
- The Claude binary lives under `/home/ubuntu/.local`, so `aos-agent` cannot execute it ("Permission denied"). Copied 2.1.322 to `/usr/local/lib/aos/claude-2.1.322` (root-owned, symlink `claude`); this is the adapter executable path P0-A2 must make permanent, with an update procedure (a new CLI version is a root-side copy).
- `aos-agent` has no Claude login. That is itay's credential action (subscription login only, no API key, nothing metered): `! sudo -u aos-agent -H env XDG_RUNTIME_DIR=/run/user/1002 /usr/local/lib/aos/claude` then `/login`. Until then G26 (a real composed session) cannot run.

## 2026-11-12

- itay logged `aos-agent` in to Claude. Verified without reading credential contents: `/home/aos-agent/.claude/.credentials.json` exists (owner `aos-agent`, mode 0600), and `run-as-agent run login-check 120 /var/lib/aos/worktrees -- /usr/local/lib/aos/claude -p "Reply with exactly: OK" --max-turns 1` (via full sudo, since the sudoers rule is not applied) printed `OK`, exit 0.
- itay approved the hook. Sudoers and nftables still wait on his explicit approval.
- PR #164 (`fix/accounting-test-pinned-clock`, 44252d4) pins the composed-Claude rig clock in `accounting-real-adapters.test.ts`. It is unrelated to P0-A1 code, but it unblocks the ai-control-plan gate on main, which P0-A2 needs green.
