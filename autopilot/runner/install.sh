#!/usr/bin/env bash
# One-shot install on ai-workstation:
#   curl -fsSL https://raw.githubusercontent.com/osovlanski/ai-control-plan/autopilot/integration/autopilot/runner/install.sh | bash
# Re-run safe. Pass LANES="codex claude" to also run the Claude lane locally (default: codex only).
set -euo pipefail
LANES="${LANES:-codex}"
WORK="$HOME/workspace/personal/autopilot"
mkdir -p "$WORK" "$HOME/.config/systemd/user" "$HOME/.config/autopilot" "$HOME/.local/state/autopilot"
if [ -d "$WORK/ai-control-plan/.git" ]; then
  git -C "$WORK/ai-control-plan" fetch -q origin autopilot/integration
  git -C "$WORK/ai-control-plan" checkout -q autopilot/integration
  git -C "$WORK/ai-control-plan" reset -q --hard origin/autopilot/integration
else
  git clone -q -b autopilot/integration https://github.com/osovlanski/ai-control-plan "$WORK/ai-control-plan"
fi
R="$WORK/ai-control-plan/autopilot/runner"
chmod +x "$R/autopilot-run.sh"
cp "$R/autopilot@.service" "$R/autopilot@.timer" "$HOME/.config/systemd/user/"
[ -f "$HOME/.config/autopilot/env" ] || cat > "$HOME/.config/autopilot/env" <<'ENV'
# Autopilot overrides (systemd EnvironmentFile). Uncomment to change.
# AUTOPILOT_CODEX_ARGS=--full-auto -c sandbox_workspace_write.network_access=true
# AUTOPILOT_RUN_TIMEOUT=3h
# GITHUB_TOKEN=   # only if gh is not installed/authenticated
ENV
systemctl --user daemon-reload
for lane in $LANES; do systemctl --user enable --now "autopilot@$lane.timer"; done
loginctl enable-linger "$USER" 2>/dev/null || echo "WARN: run 'sudo loginctl enable-linger $USER' so timers survive logout"

echo "--- preflight"
for bin in git python3 node pnpm codex claude gh flock timeout; do
  printf '%-8s %s\n' "$bin" "$(command -v $bin >/dev/null && echo ok || echo MISSING)"
done
gh auth status >/dev/null 2>&1 && echo "gh auth: ok" || echo "gh auth: MISSING — run 'gh auth login' (needed for PRs, merges, cockpit clone)"
git -C "$WORK/ai-control-plan" push --dry-run -q origin HEAD:autopilot/integration 2>/dev/null && echo "git push: ok" || echo "git push: FAILED — configure credentials"
systemctl --user list-timers 'autopilot@*' --no-pager
echo "Logs: ~/.local/state/autopilot/<lane>-latest.log · Run now: systemctl --user start autopilot@codex.service"
echo "Pause a lane: set \"paused\": true in autopilot/state/<lane>.json on the integration branch."
