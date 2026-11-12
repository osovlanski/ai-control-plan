#!/bin/sh
# Timed safety net for the network/sudo step only. Safe to run twice.
# Does NOT touch the aos-agent user, its login, /var/lib/aos or the wrapper:
# an earlier version deleted them when it fired (2026-11-12 11:19Z).
# Full teardown is teardown.sh, run by hand only.
nft delete table inet aos_agent_net 2>/dev/null
rm -f /etc/sudoers.d/aos
visudo -c >/dev/null
