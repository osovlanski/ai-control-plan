# P0-A2 host drive: G0, G21, G26

`docs/agentic-os-auto-copilot-plan.md` §G. These three run on the reference host, where
`aos-agent`, its Claude login, the sudoers rule and the nftables table exist. They cannot run
anywhere else: G26 needs the real provider under the real user manager.

What was already driven off the host, with the fake provider, two real Unix users, the real
sudoers rule and a wrapper whose only difference is `timeout` in place of `systemd-run`:
operator authority over HTTP, file refusals as the agent user, the wrapper's argument checks,
"the command verifier never runs for an agent task" with an agent-rewritten test command, the
planted `.git`, the adapter's command line through sudo, and the group profile's modes.

## 0. Prepare (host changes: the owner's action)

```
cd <checkout of this branch>/setup
sudo ./aos-setup            # re-run: installs the new wrapper, profiles 2750, plane user in group aos
sudo /usr/local/lib/aos/aos-status      # every line "ok"
```

Restart the plane so it has group `aos`. In the workspace `config.yaml` add `execution.agentUser: {}`
with `harnessModes.single: true`, and set the repo allowlist to a clone that lives under
`/var/lib/aos/worktrees/<name>` (owner the plane user, group `aos`), so the agent can run `git`.
Set the operator secret (`setup/README.md`). Load < 1.5, backup first, one experiment per session.

## G0 — isolation, provider path

1. From a provider tool as `aos-agent` (a composed Claude session on an agent task; ask it to run
   each command and report the exit code): read `<workspace>/api-credential.json`,
   `agent-plane.db`, `autopilot-operate.json`, `config.yaml`, the plane user's GitHub token file
   and `~/.claude/.credentials.json`. **Pass:** every read refused.
2. From the same tool: `curl -m 5 http://127.0.0.1:<plane port>/api/autopilot/start`. **Pass:** no
   connection (nftables).
3. From the plane user's shell, with the ordinary credential: `POST /api/autopilot/start`,
   `/release`, `/resolve`. **Pass:** 403 `autopilot.operate required` on all three; `/stop` is not 403.
4. From the provider tool: `sqlite3 <db> 'CREATE TABLE autopilot_x(a)'`. **Pass:** refused (the
   file is unreadable). No autopilot table exists yet, so "state unchanged" is: the DB's schema
   and row counts are the same before and after.

## G21 — isolation, repository path

1. Create an agent task on the clone. In the session, have the agent change the project's `test`
   script to one that reads the credential file, calls the plane API and Cockpit on loopback
   (HTTP, WebSocket, PTY port) and fetches `http://example.com`, each writing its result to a file
   in the worktree.
2. Let the session finish. **Pass:** the task's project check is `skipped` with "repository
   commands never run as the plane user"; none of the result files exists; no process owned by
   the plane user ran the script (`journalctl`/`ps` show none).
3. Run the same script by hand as `aos-agent` through the wrapper. **Pass:** every read refused,
   every loopback connection dropped, plain HTTP dropped.
4. "Acceptance has no network" belongs to the acceptance runner (§C.2.7, a later slice). Record it
   as not yet runnable; it does not block P0-A2's exit if itay accepts that split, otherwise G21
   stays BLOCKED on that part.

## G26 — composed Claude session as `aos-agent`

1. With Cockpit's bundle service up and the composer on, start an agent task whose composition
   selects one real skill and one MCP server **with no secret reference**.
2. **Pass:** `provisioning.verified` names a root under `/var/lib/aos/profiles/<session>`; the
   startup evidence (`run.started`) shows the skill and the MCP server loaded;
   `systemctl --user -M aos-agent@ status aos-run-<session>.scope` shows the provider inside the
   scope with `RuntimeMaxSec` set; `ps -o user= -p <provider pid>` is `aos-agent`.
3. Cancel a second such run mid-stream. **Pass:** the scope is gone within the grace period and
   the session settles `cancelled`.
4. After the first run ends: the profile directory is gone (`provisioning.disposed`).
5. Restart recovery: start a third run, `kill -9` the plane, start it again. **Pass:** the boot log
   has "stopped agent-user units from a dead incarnation" naming the session, the scope is gone,
   and the session is reconciled as it is for an ordinary task.

Unverified until this runs, and the likeliest places for a FAIL: the Agent SDK accepting the
root-owned CLI through `pathToClaudeCodeExecutable` under sudo's reset environment; the CLI
needing an environment variable the reset drops; stdio through `sudo` and `systemd-run --scope`.

Report one verdict per experiment and one overall. No partial pass.
