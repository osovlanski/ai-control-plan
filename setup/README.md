# Host setup for the agent user (P0-A2)

Design: `docs/agentic-os-auto-copilot-plan.md` §C.0. Evidence from the spike:
`docs/spikes/p0-a1-isolation-notes.md` (PR #166). Inventory of plane-side spawns:
`docs/autopilot/spawn-inventory.md`.

The boundary: for a task created with `runAs: "agent"`, nothing that came from the repository or
from a provider runs as the plane user, and nothing running as `aos-agent` can reach the plane's
files, its API, Cockpit, or the network beyond HTTPS.

| File | Installed as | What it is |
|---|---|---|
| `run-as-agent` | `/usr/local/lib/aos/run-as-agent` (root, 0755) | the one command the plane may run as `aos-agent`; starts a `systemd-run --user --scope` bounded by `RuntimeMaxSec` (`run`), the same with no network for acceptance (`accept`: `unshare --user --map-root-user --net`, its own loopback up), or stops one |
| `sudoers.d/aos` | `/etc/sudoers.d/aos` (root, 0440) | `ubuntu ALL=(aos-agent:aos) NOPASSWD:` that wrapper only, `env_reset` |
| `aos-agent-net.nft`, `aos-agent-net.service` | `/usr/local/lib/aos/`, `/etc/systemd/system/` | egress rules for uid 1002, loaded at boot |
| `aos-setup` | `/usr/local/lib/aos/aos-setup` | idempotent install of everything above, plus user, group and directories |
| `aos-status` | `/usr/local/lib/aos/aos-status` | read-only check, exit 1 on any gap |
| `rollback.sh` | `/usr/local/lib/aos/rollback.sh` | reverts sudoers + nft only |
| `teardown.sh` | not installed | full removal, by hand only; deletes `aos-agent`'s Claude login |
| `sudoers.d/aos-operator` | **not installed** | proposal that narrows the plane user's own sudo; see below |
| `aos-close` | `/usr/local/lib/aos/aos-close` (root, 0755) | P0-3: at an autopilot window's close, stops every `aos-run-*.scope` and checks the slice is empty |
| `aos-close.service`, `aos-close.timer` | `/etc/systemd/user/` (root, 0644), enabled `--global`, `ConditionUser=aos-agent` | P0-3: runs `aos-close` every minute in `aos-agent`'s own user manager; works with the plane dead |

Layout it creates: `/var/lib/aos/profiles` (`ubuntu:aos`, 2750: the agent reads, cannot write) and
`/var/lib/aos/worktrees` (`ubuntu:aos`, 2770: the agent writes). The plane user is added to group
`aos`, so it can read and commit what the agent wrote and so its profile files keep the group.

## What changed against the spike's files

- `run-as-agent`: the working directory must resolve (`realpath`) under `/var/lib/aos/worktrees`.
  The spike matched the raw string, which accepted `…/worktrees/../..`, and also allowed
  `/home/ubuntu/workspace` and `/tmp/aos-spike`. `umask` is 007, not 027, so the plane user (group
  member) can commit and remove agent-written files. `stop` on a unit that already ended exits 0.
- `aos-setup`: profiles are setgid (2750); adds the plane user to `aos`; installs the tools
  root-owned under `/usr/local/lib/aos`; adds git `safe.directory` for the worktree tree to
  `aos-agent`'s own git config (never the system's, see `docs/autopilot/spawn-inventory.md`);
  reads the Claude binary as the plane user rather than as root.

## Apply (itay, on the box)

Changing the box is itay's action. Each step is safe to repeat.

```
cd <checkout>/setup
sudo ./aos-setup --no-net          # user, group, dirs, tools. No sudo or network rule yet.
echo 'sh /usr/local/lib/aos/rollback.sh' | sudo at now + 10 minutes   # safety net
sudo ./aos-setup                   # sudoers + nftables
sudo /usr/local/lib/aos/aos-status # expect every line "ok"
# from a second terminal: a fresh SSH login must still work. Then cancel the net:
sudo atrm <job>
```

Restart the plane afterwards, so it picks up group `aos`.

Then tell the plane the host is set up (`<workspace>/config.yaml`; every key has the default
shown in `apps/api/src/config.ts`, so an empty mapping is enough):

```yaml
execution:
  harnessModes: { single: true }
  agentUser: {}
```

A new Claude CLI version is a root-side copy: remove `/usr/local/lib/aos/claude` and re-run
`aos-setup --no-net`.

## The host gate and the close timer (P0-3)

Design: plan §C.2.5 and §C.2.6. Host drive: `docs/autopilot/p0-3-host-drive.md`.

- **Host gate** (observation, `apps/api/src/modules/host-admission.ts`): every autopilot launch
  check reads load per CPU, `MemAvailable`, free disk, and the cgroup tree of
  `user.slice/user-1002.slice`. Anything populated there other than the user manager's own
  `init.scope` (`systemd`, `(sd-pam)`) refuses the launch `host_busy`; so does anything
  unreadable. It is **fail-closed**: without `scheduler.admission.<pool>` every autopilot launch
  is refused. Floors (defaults shown):

  ```yaml
  scheduler:
    resources: { oci-heavy: 1 }
    admission:
      oci-heavy: { maxLoadPerCpu: 1.5, minFreeMemMb: 1024, minFreeDiskMb: 5120 }  # diskPath: the agent worktrees root
  ```

- **Close schedule**: at boot and at every launch check the plane rewrites
  `/var/lib/aos/schedule/windows` (dir `ubuntu:aos` 2750, file 0640) from its windows table. If
  it cannot, the check refuses: nothing runs whose close the timer does not know.
- **Close timer**: `aos-close.timer` fires every minute in `aos-agent`'s user manager. Within 15
  minutes after a listed close it runs `systemctl --user stop 'aos-run-*.scope'` and fails the
  unit (`systemctl --user -M aos-agent@ status aos-close.service`) if the slice is not empty
  after 10 s. It also stops a manual agent task still running at that moment.

## The operator secret (itay only)

`POST /api/autopilot/start`, `/release` and `/resolve` need `autopilot.operate`. No stored
credential and no browser session can carry it. Only the operator secret does, and only its
SHA-256 is on the box. `stop` stays on `commands.write`.

Best: make the secret on your own device and give the box the hash only.

```
# your device
SECRET="aop_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"; printf %s "$SECRET" | sha256sum
# the box
pnpm --filter @agent-plane/api rotate-operate -- --hash sha256:<the hex>
```

Or let the box generate it and print it once (`pnpm --filter @agent-plane/api rotate-operate`).
Run that in your own terminal, not from an agent session.

## Narrowing the plane user's sudo (NOT applied; needs itay's explicit OK)

Finding from the spike: cloud-init gives `ubuntu ALL=(ALL) NOPASSWD:ALL`. While that holds, the
plane user is root, so the agent boundary protects the plane from `aos-agent` but not the box
from anything that runs as `ubuntu` (the plane itself, or an agent session on this box).

`sudoers.d/aos-operator` replaces the cloud-init rule with: sudo for everything **with ubuntu's
password**, and no-password sudo only for `aos-setup`, `aos-status` and `rollback.sh` (the
root-owned copies under `/usr/local/lib/aos`). Root stays reachable for a human, and no process
on the box holds the password.

Consequences to accept first:

- Every agent session on this box that uses `sudo` today stops being able to. That is the point,
  and it also ends "an agent fixes the host for me".
- A lockout is possible if the password is not set first. Keep the OCI serial console as the
  way back in, and test it before you start.

Steps:

```
sudo passwd ubuntu                                  # 1. set a password only you know
sudo ./aos-setup --no-net                           # 2. root-owned tools in /usr/local/lib/aos
sudo visudo -cf sudoers.d/aos-operator              # 3. must print "parsed OK"
sudo cp /etc/sudoers.d/90-cloud-init-users /root/90-cloud-init-users.bak
echo 'cp /root/90-cloud-init-users.bak /etc/sudoers.d/90-cloud-init-users' | sudo at now + 10 minutes
sudo install -o root -g root -m 0440 sudoers.d/aos-operator /etc/sudoers.d/90-cloud-init-users
sudo visudo -c
# 4. in a NEW SSH session:
sudo -k; sudo -n true                               #    must fail: "a password is required"
sudo -n /usr/local/lib/aos/aos-status               #    must work without a password
sudo true                                           #    must work with the password
sudo atrm <job>                                     # 5. only now cancel the safety net
```

Check that no other file under `/etc/sudoers.d` and no group (`sudo`, `admin`) still grants
`ubuntu` a no-password rule: `sudo -l -U ubuntu`. cloud-init writes its file once per instance,
so it does not come back on reboot; it would on a re-provisioned instance.

## Known gaps (recorded, not hidden)

- A worktree made with `git worktree add` from a repository under `/home/ubuntu` keeps its
  metadata in that repository's `.git`, which `aos-agent` cannot read. The agent can edit files
  in the worktree but cannot run `git` there. Cloning the repository into the `aos` tree is P0-6.
- Every agent task's worktree is in one group-writable tree, so an agent run can touch another
  agent task's worktree. Runs are serial for the first loop (`oci-heavy: 1`).
- The egress rule allows any HTTPS host, not only the provider and GitHub (plan §C.0 row
  "Network egress"); acceptance with no network is the acceptance runner's (§C.2.7).
- Live session input and the K3 quota probe read the plane user's `~/.claude`, which holds no
  login for an agent run. Both stay off for agent tasks.
- Not tested: a reboot (does `aos-agent-net.service` load before the first agent run).
