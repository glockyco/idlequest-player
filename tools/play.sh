#!/bin/sh
# Play the account until this script is stopped: the browser relay and the collector with its
# coordinator, in the foreground of the terminal tab it runs in. Ctrl-C, closing the tab or a
# reboot stops both, and nothing starts them again.
cd "$(dirname "$0")/.." || exit 1
# A relay that already listens keeps its port, and this one exits at once.
omp browser-relay &
relay=$!
collector=
trap 'kill "$relay" $collector 2>/dev/null; wait $collector 2>/dev/null; trap - EXIT; exit 130' INT TERM HUP
trap 'kill "$relay" $collector 2>/dev/null' EXIT

# The collector writes runs/status.md at the end of every cycle. One that finishes no cycle for
# STALL seconds plays nobody: the tabs lose their focus and sign-in keeper and the groups get no
# tasks. On 2026-11-12 it stood for eleven minutes until it was restarted by hand. It is ended
# here and started again, and so is one that exits by itself. The loop is this script's last
# command, so the shell that runs it has read all of it and a later edit of the file does not
# reach it.
STALL=300
while :; do
  bun tools/iqd.mjs run --interval 30 --coordinate --recover &
  collector=$!
  started=$(date +%s)
  while kill -0 "$collector" 2>/dev/null; do
    sleep 15
    cycled=$(stat -f %m runs/status.md 2>/dev/null || stat -c %Y runs/status.md 2>/dev/null || echo 0)
    [ "$cycled" -lt "$started" ] && cycled=$started
    age=$(($(date +%s) - cycled))
    if [ "$age" -gt "$STALL" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') play: the collector finished no cycle for ${age} s, so it is started again"
      kill "$collector" 2>/dev/null
      sleep 3
      kill -9 "$collector" 2>/dev/null
    fi
  done
  wait "$collector" 2>/dev/null
  echo "$(date '+%Y-%m-%d %H:%M:%S') play: the collector ended, starting it again in 10 s"
  sleep 10
done
