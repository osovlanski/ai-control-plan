# P0-3 host drive results (2026-11-13, OCI ai-workstation)

Verdict: **BLOCKED** for G8 as written (no autopilot attempt can be created over HTTP); G8 at the gate with real probes: PASS. G20: **PASS**.

Method: `setup/aos-setup --no-net` re-run (installed `aos-close`, units, `/var/lib/aos/schedule`; no prompt), then a scratch plane on :4199 from main 6e88827 (own `AGENT_PLANE_HOME`, own generated operator secret, `execution.agentUser: {}`, `scheduler.admission.oci-heavy: {}`). The live plane on :4176 was not restarted: it runs the old operator checkout (eca9746, no `host-admission.ts`). Scratch plane, secret and clone dirs were removed afterwards. No credential was printed or stored in the repo.

## Host changes made (itay approved in the thread)
- `systemctl --user mask dbus.service dbus.socket` for `aos-agent`. Without it `dbus.service` sat in `session.slice` permanently (since 2026-11-12) and the gate would refuse every launch. Idle census afterwards: only `init.scope` (`systemd`, `(sd-pam)`).
- Live `~/.agent-plane/personal/config.yaml`: appended `scheduler: {resources: {oci-heavy: 1}, admission: {oci-heavy: {}}}` (it had no scheduler block). Backup: `~/.agent-plane/backups/personal-20261113-p03.config.yaml`. Not loaded until the live plane is restarted on a build that has P0-3.

## G8 — gate with real probes (`hostGate`, real `/sys/fs/cgroup`, `/proc`, `/etc/passwd`; `maxLoadPerCpu` raised to 50 for the slice and disk cases because one CPU's own load from the drive tripped the load floor first)
1. Scope `aos-run-t-g8` via the wrapper (`sleep 600`): `agent slice is not empty: user-1002.slice/user@1002.service/app.slice/aos-run-t-g8.scope: 1 process(es)`. After `run-as-agent stop`: ok.
2. `systemd-run --user --unit=hide sleep 600` (a service in `app.slice`): `... app.slice/hide.service: 1 process(es)`. After stop: ok.
3. Account without a slice (`nobody`): the probe throws `ENOENT ... user-65534.slice/cgroup.events`; the autopilot launch check turns a throw into `host_busy: host gate unreadable: <message>`.
4. `minFreeDiskMb` above free: `free disk on /var/lib/aos/worktrees 54718 MB is below 100000000 MB`.
Idle: `{ok:true}`. Load floor also seen refusing (`load 1.99 per CPU is above 1.5`).
Not driven: refusal through an autopilot task and `autopilot.parked` events, and "launches once the cause is removed". `reserve` + `admit` have no HTTP route (`autopilot.ts`), so the doc's HTTP flow cannot create an attempt.

## G20 — PASS (timer alone; scope started by hand with 3600 s, no `RuntimeMaxSec` cut before the close)
Window 18:41:12 to 18:58:12 added with the operator secret. Plane restarted so it wrote `/var/lib/aos/schedule/windows` (`1794595272 1794596292`). Scope `aos-run-t-g20` started 18:42:48; plane `kill -9` at 18:42:52, not restarted. 18:59:00 journal: `aos-close: window closed at 2026-11-13T18:58:12Z; stopping aos-run-*.scope`, `Stopped aos-run-t-g20.scope`, `aos-close: slice empty`. Afterwards only `init.scope` is populated. `aos-status`: close timer active, close schedule written. The `RuntimeMaxSec` variant was not run (it only matters if that bound stopped the scope).

## Findings
- The doc's idle-census command (`find ... -size +0`) prints nothing on cgroupfs (files report size 0). Use a `cat` loop.
- Masking dbus makes `systemctl --user -M aos-agent@ ...` fail ("Transport endpoint is not connected"), so `aos-status` timer checks and the doc's `list-timers` line need `sudo -u aos-agent env XDG_RUNTIME_DIR=/run/user/1002 systemctl --user ...`. The wrapper already uses that path and works. Any `-M` call before the mask respawns dbus in the slice.
- The close schedule is written at plane boot and at launch checks, not when a window is added: a window added to a running plane is not covered until then. Before the file exists `aos-close` fails every minute (`schedule ... unreadable`).
- `POST /api/autopilot/windows` needs the operator secret; an ordinary credential gets 403.
- Live plane still on the old checkout; it needs a deploy of main before P0-3 is real there.
