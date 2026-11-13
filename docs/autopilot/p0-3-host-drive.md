# P0-3 host drive: G8 and G20

`docs/agentic-os-auto-copilot-plan.md` §G, §C.2.5, §C.2.6. Both rows need the reference host: G8
reads the kernel's cgroup tree for `aos-agent`'s slice, and G20 needs `aos-agent`'s user manager,
a real scope and the close timer.

What was already driven off the host: the gate's four G8 refusals on a cgroup v2 fixture tree,
through the real scheduler and launch check (`apps/api/test/host-admission.test.ts`); the gate's
fail-closed default without `scheduler.admission`; the close schedule's file format and mode; and
`setup/aos-close` against a fixture tree with a stand-in `systemctl` (PR body).

## 0. Prepare (host changes: the owner's action)

```
cd <checkout of this branch>/setup
sudo ./aos-setup --no-net                 # installs aos-close, the units, /var/lib/aos/schedule
sudo /usr/local/lib/aos/aos-status        # every line "ok" except "close schedule written" until the plane runs
systemctl --user -M aos-agent@ list-timers aos-close.timer   # next run within a minute
```

Workspace `config.yaml`: add `scheduler.admission: { oci-heavy: {} }` next to
`scheduler.resources: { oci-heavy: 1 }`, then restart the plane. `aos-status` must now show the
schedule. Load < 1.5, one experiment per session.

**Check the idle census first.** With nothing running as `aos-agent`:

```
find /sys/fs/cgroup/user.slice/user-1002.slice -name cgroup.procs -size +0 -exec sh -c 'echo "$1: $(cat "$1" | tr "\n" " ")"' _ {} \;
```

**Pass:** only `user@1002.service/init.scope` lists processes, and their `comm` is `systemd` and
`(sd-pam)`. If another unit (for example a socket-activated `dbus`) lives there permanently, the
gate will refuse every launch: record it, and that unit has to be disabled in `aos-agent`'s
manager (`systemctl --user -M aos-agent@ mask <unit>`), which is a host change for itay.

## G8 — next launch refused `host_busy` in four cases

Use an autopilot task through the HTTP API (window, attestation, start, then an attempt). After
each case, read `GET /api/tasks/<id>/events` for `autopilot.parked` and confirm no run started.

1. **Child alive after settlement**: `sudo -u aos-agent /usr/local/lib/aos/run-as-agent run t-g8
   600 /var/lib/aos/worktrees/<clone> -- sleep 600`. **Pass:** `host_busy`, detail names
   `aos-run-t-g8.scope`. Then `run-as-agent stop t-g8`.
2. **Moved to another cgroup in the slice**: as `aos-agent`, `systemd-run --user --unit=hide sleep
   600` (a service under `app.slice`, not a scope). **Pass:** `host_busy`, detail names
   `hide.service`. Then `systemctl --user -M aos-agent@ stop hide`.
3. **Unreadable `cgroup.events`**: run the plane with `scheduler.admission.oci-heavy` set and
   `execution.agentUser.user` pointed at an account with no slice (no linger), or disable linger
   for `aos-agent` for the duration. **Pass:** `host_busy`, detail contains `unreadable`.
   Re-enable linger afterwards.
4. **Disk below the floor**: set `minFreeDiskMb` above the free space of `/var/lib/aos/worktrees`
   (`df -m`), restart. **Pass:** `host_busy`, detail names the disk. Restore the value.

Each case ends with the task launching once the cause is removed (the retry is two minutes).

## G20 — kill the plane during a running session, and leave it dead

1. Add a window that closes about 15 minutes from now (a launch needs `minSliceMs`, 10 minutes, left) (`POST /api/autopilot/windows`), start the
   autopilot, admit a task whose session runs long (a composed Claude session asked to work
   through a large refactor, or a fake long run started through the wrapper).
2. Five minutes before the close: `kill -9` the plane. Do not restart it.
3. Watch: `journalctl _UID=1002 -f` and
   `cat /sys/fs/cgroup/user.slice/user-1002.slice/user@1002.service/app.slice/cgroup.events`.
4. **Pass:** by the window's close, the scope is gone, stopped by `RuntimeMaxSec` (its deadline is
   `closes_at − graceMs`, 2 minutes before the close) or at the latest by the close timer at the
   close minute; `aos-close` logs `slice empty`; nothing but `init.scope` is populated in the
   slice afterwards.
5. Also record which of the two stopped it (`journalctl _UID=1002 | grep -E 'aos-run|aos-close'`).
   If `RuntimeMaxSec` did, run step 1–4 once more with a scope started by hand with
   `run-as-agent run t-g20 3600 …` (no `RuntimeMaxSec` cut before the close), to prove the timer
   alone.

## Known limits (not part of the exit)

- `aos-agent` owns its user manager: a process running as `aos-agent` can stop or mask
  `aos-close.timer` and can `set-property` a scope's `RuntimeMaxSec`. Both bounds are therefore
  against a crashed or dead plane, not against a hostile agent. A root-side backstop (a system
  timer that stops `user@1002.service`'s scopes) would close that; it is a design change for itay.
- A process that moves itself into `init.scope` and names itself `systemd` or `(sd-pam)` is not
  seen, as long as `init.scope` still holds at most two processes.
