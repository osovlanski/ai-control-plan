#!/bin/sh
# Full teardown of the agent-user setup. Run by hand only, never from `at`.
# Deletes aos-agent's Claude login and every worktree and profile under /var/lib/aos.
sh "$(dirname "$0")/rollback.sh"
systemctl --global disable aos-close.timer 2>/dev/null
loginctl terminate-user aos-agent 2>/dev/null
loginctl disable-linger aos-agent 2>/dev/null
userdel -r aos-agent 2>/dev/null
gpasswd -d ubuntu aos 2>/dev/null
groupdel aos 2>/dev/null
rm -rf /var/lib/aos /usr/local/lib/aos /etc/systemd/system/aos-agent-net.service /etc/systemd/user/aos-close.service /etc/systemd/user/aos-close.timer
systemctl daemon-reload
