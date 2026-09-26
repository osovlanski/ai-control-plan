#!/usr/bin/env bash
# Autopilot runner for ai-workstation (OCI). One backlog item per invocation; the systemd timer
# fires it hourly. Usage-limit aware: it never starts an agent while the lane is inside a limit
# window, and when the agent hits a limit it records blocked_until so later firings skip until reset.
set -uo pipefail

LANE="${AUTOPILOT_LANE:-codex}"
WORK="${AUTOPILOT_WORKDIR:-$HOME/workspace/personal/autopilot}"
ACP="$WORK/ai-control-plan"
LOGDIR="${AUTOPILOT_LOGDIR:-$HOME/.local/state/autopilot}"
RUN_TIMEOUT="${AUTOPILOT_RUN_TIMEOUT:-3h}"
# The box is a dedicated dev VM the owner already drives Codex on. The agent needs network (pnpm,
# git push, GitHub API) and write access to .git, which the workspace-write sandbox withholds.
# Override with e.g. AUTOPILOT_CODEX_ARGS="--full-auto -c sandbox_workspace_write.network_access=true".
CODEX_ARGS="${AUTOPILOT_CODEX_ARGS:---dangerously-bypass-approvals-and-sandbox}"
CLAUDE_ARGS="${AUTOPILOT_CLAUDE_ARGS:---permission-mode bypassPermissions}"

mkdir -p "$LOGDIR" "$WORK"
exec 9>"$LOGDIR/$LANE.lock"
flock -n 9 || { echo "another $LANE run is active"; exit 0; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$LOGDIR/$LANE-$STAMP.log"
ln -sf "$OUT" "$LOGDIR/$LANE-latest.log"
find "$LOGDIR" -name "$LANE-*.log" -mtime +10 -delete 2>/dev/null || true

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$OUT"; }

if [ ! -d "$ACP/.git" ]; then
  git clone -q https://github.com/osovlanski/ai-control-plan "$ACP" || { log "clone failed"; exit 1; }
fi
[ -d "$WORK/cockpit/.git" ] || git clone -q https://github.com/osovlanski/cockpit "$WORK/cockpit" || log "cockpit clone failed (private repo needs gh auth)"

cd "$ACP"
git fetch -q origin autopilot/integration && git checkout -q autopilot/integration && git reset -q --hard origin/autopilot/integration \
  || { log "cannot reach autopilot/integration"; exit 1; }
AP="python3 autopilot/ap.py"

if ! GATE="$($AP gate --lane "$LANE")"; then
  log "gated: $GATE"; exit 0
fi
$AP sync --lane "$LANE" --message "gate reopened" >/dev/null 2>&1 || true

if ! $AP next --lane "$LANE" >/dev/null; then
  log "nothing ready for $LANE"; exit 0
fi

PROMPT="You are the ${LANE} autopilot lane running unattended on ai-workstation. Working directory: ${ACP}. The cockpit checkout is ${WORK}/cockpit. Read autopilot/LANE_PROMPT.md completely and follow it exactly for ONE backlog item, using lane '${LANE}'. The owner is away; never wait for input."

log "starting $LANE agent"
if [ "$LANE" = "codex" ]; then
  timeout "$RUN_TIMEOUT" codex exec $CODEX_ARGS -C "$ACP" "$PROMPT" >>"$OUT" 2>&1; RC=$?
else
  timeout "$RUN_TIMEOUT" claude -p $CLAUDE_ARGS "$PROMPT" >>"$OUT" 2>&1; RC=$?
fi
log "agent exited rc=$RC"

# Limit detection — the agent should already have blocked itself, but a hard limit can kill it
# before it gets the chance. Parse the tail of the log for the provider's limit text.
TAIL="$(tail -n 80 "$OUT")"
# Only a failed run is inspected: a clean exit means the agent handled any limit itself, and the
# protocol text it read mentions limits, so scanning successful output would false-positive.
if [ "$RC" -ne 0 ] && [ "$RC" -ne 124 ] && echo "$TAIL" | grep -Eiq 'usage limit|rate limit|limit reached|hit your limit|quota exceeded|too many requests|\b429\b|resets? (at|in)|try again (at|in)'; then
  git fetch -q origin autopilot/integration && git reset -q --hard origin/autopilot/integration
  if ! $AP gate --lane "$LANE" >/dev/null; then
    log "agent already recorded the limit window"
  else
    MIN="$(echo "$TAIL" | python3 -c '
import re,sys
t=sys.stdin.read().lower()
h=re.search(r"(?:in|after)\s+(\d+)\s*(?:h|hours?)(?:\s+(\d+)\s*(?:m|min|minutes?))?",t)
m=re.search(r"(?:in|after)\s+(\d+)\s*(?:m|min|minutes?)\b",t)
print(int(h.group(1))*60+int(h.group(2) or 0)+5 if h else (int(m.group(1))+5 if m else 60))')"
    REASON="$(echo "$TAIL" | grep -Eio '.{0,80}(usage limit|rate limit|limit reached|hit your limit|quota exceeded).{0,80}' | tail -n1 | tr -d '\"')"
    UNTIL="$($AP block --lane "$LANE" --minutes "$MIN" --reason "${REASON:-provider limit}")"
    $AP sync --lane "$LANE" --message "paused on limit until $UNTIL" || true
    $AP comment --lane "$LANE" --body "Paused on usage limit until $UNTIL (runner-detected). Will resume the same item after reset." || true
    log "limit detected; blocked until $UNTIL"
  fi
elif [ "$RC" -eq 124 ]; then
  git fetch -q origin autopilot/integration && git reset -q --hard origin/autopilot/integration
  $AP log --lane "$LANE" --msg "run hit the ${RUN_TIMEOUT} wall-clock timeout; will resume" && $AP sync --lane "$LANE" --message "timeout" || true
fi
exit 0
