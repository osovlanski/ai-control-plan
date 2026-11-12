#!/bin/sh
# Full P0-A1 teardown. Run by hand only, never from `at`. Deletes aos-agent's Claude login.
sh "$(dirname "$0")/rollback.sh"
loginctl terminate-user aos-agent 2>/dev/null
loginctl disable-linger aos-agent 2>/dev/null
userdel -r aos-agent 2>/dev/null
groupdel aos 2>/dev/null
rm -rf /var/lib/aos /usr/local/lib/aos
