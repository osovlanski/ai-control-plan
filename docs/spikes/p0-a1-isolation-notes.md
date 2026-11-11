# P0-A1 isolation spike: notes (throwaway branch `spike/autopilot-isolation-20261111`)

Plan: `docs/agentic-os-auto-copilot-plan.md` §F Stage 2. Status: **BLOCKED on operator approval of host changes** (2026-11-11).

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

## Not done, and why

Everything else in P0-A1 changes host security controls: creating the `aos-agent` Unix user, enabling its linger, installing a sudoers rule and wrapper, adding nftables `skuid` rules, creating `/var/lib/aos/profiles`. No approval or rollback plan has been given, so none was attempted. G0, G21 and G26 are therefore **not run**.

## Rollback plan proposed for approval

1. `userdel -r aos-agent`, `loginctl disable-linger aos-agent`, remove `/var/lib/aos`.
2. Delete `/etc/sudoers.d/aos` (validate with `visudo -c` before and after).
3. `nft delete table inet aos_agent_net` and remove the unit; confirm with `nft list ruleset`.
4. Keep an SSH session open and schedule `at now + 10 min` to run the rollback while nftables rules are first tried.
