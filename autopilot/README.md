# Autopilot — unattended work on the Agentic OS v4 backlog

Two lanes work through [`backlog.json`](backlog.json) one item per run while the owner is away.
The plan behind every item is [`plans/agentic-os-v4-daily-driver.md`](../plans/agentic-os-v4-daily-driver.md).
Every agent follows [`LANE_PROMPT.md`](LANE_PROMPT.md).

| Lane | Runs where | Cadence | Provider |
|---|---|---|---|
| `claude` | Claude Code scheduled task (cloud session, visible in claude.ai → Code) | every 2 h | Claude subscription |
| `codex` | `ai-workstation`, systemd user timer `autopilot@codex.timer` | hourly | Codex / ChatGPT subscription |

## Landing rules

- One slice = one branch `autopilot/<id>-<slug>` = one PR **into `autopilot/integration`** of the
  item's repo (`ai-control-plan` or `cockpit`). The lane merges its own PR only when the gate is
  green, with a merge commit. **`main` is never touched**; the owner reviews
  `autopilot/integration → main` afterwards.
- An item that fails 3 attempts becomes `failed` and the lane moves on.
- `owner` items are never started.

## Usage limits

Limits pause a lane; they never lose work.

1. Every run starts with `ap.py gate`. While `blocked_until` is in the future the run exits at once.
2. When the agent sees a limit (or a warning that one is close) it pushes a WIP commit, records
   `blocked_until` (the provider's reset time, else +60 min), comments on the tracking issue, and stops.
3. On OCI, if the provider kills the agent outright, `runner/autopilot-run.sh` parses the reset hint
   from the log and records the window itself.
4. The first run after the reset clears the window and **resumes the same item** from its branch.
5. Cloud Claude runs that start while the account is still limited simply fail fast; the item state
   is unchanged, so the next firing picks it up.

## State

- `state/<lane>.json` — owned by exactly one lane, so concurrent lanes never conflict. Holds
  `blocked_until`, `current`, per-item state (`queued → in_progress → pr_open → merged | failed`),
  and a rolling log.
- `ap.py` reads and writes state in a dedicated worktree pinned to `autopilot/integration`
  (`../.autopilot-state-<repo>`), so a sync from a slice branch can never push slice commits.

## Monitors (all read-only)

- **GitHub:** tracking issue [#68](https://github.com/osovlanski/ai-control-plan/issues/68) — each lane
  comments on start, finish, failure and limit pauses. Subscribe in the GitHub mobile app.
- **Web:** `monitor/index.html`, deployed to Vercel as a static page. It reads the state files from
  `raw.githubusercontent.com` and open PRs from the public GitHub API. It never talks to the control
  plane API, which stays loopback-only per `docs/adr/agentic-os-deployment.md`.
- **claude.ai:** the scheduled task run list, plus the "Autopilot Tracker" artifact.
- **OCI:** `~/.local/state/autopilot/<lane>-latest.log`, `systemctl --user list-timers 'autopilot@*'`.

## Operate

```bash
# install / update the OCI runner (idempotent)
curl -fsSL https://raw.githubusercontent.com/osovlanski/ai-control-plan/autopilot/integration/autopilot/runner/install.sh | bash
systemctl --user start autopilot@codex.service     # run one item now
python3 autopilot/ap.py status                      # backlog table from any checkout
```

Pause a lane: set `"paused": true` in `state/<lane>.json` on `autopilot/integration` (GitHub web
editor works from a phone). Stop everything on OCI: `systemctl --user disable --now autopilot@codex.timer`.
