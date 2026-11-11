#!/bin/sh
# Remove only what P0-A1 added. Safe to run twice.
nft delete table inet aos_agent_net 2>/dev/null
rm -f /etc/sudoers.d/aos
loginctl terminate-user aos-agent 2>/dev/null
loginctl disable-linger aos-agent 2>/dev/null
userdel -r aos-agent 2>/dev/null
groupdel aos 2>/dev/null
rm -rf /var/lib/aos /usr/local/lib/aos
