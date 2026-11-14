#!/bin/sh
# Play the account until this script is stopped: the browser relay and the collector with its
# coordinator, in the foreground of the terminal tab it runs in. Ctrl-C, closing the tab or a
# reboot stops both, and nothing starts them again.
cd "$(dirname "$0")/.." || exit 1
# A relay that already listens keeps its port, and this one exits at once.
omp browser-relay &
relay=$!
relayStarted=$(date +%s)
collector=
# A stop gives the collector 20 s to end its cycle, then ends it. On 2026-11-12 one went on for
# 105 s after Ctrl-C, with the relay already gone, and the account stood meanwhile.
stop() {
  kill "$relay" $collector 2>/dev/null
  n=0
  while [ -n "$collector" ] && kill -0 "$collector" 2>/dev/null && [ "$n" -lt 20 ]; do
    sleep 1
    n=$((n + 1))
  done
  kill -9 $collector 2>/dev/null
}
trap 'stop; trap - EXIT; exit 130' INT TERM HUP
trap 'kill "$relay" $collector 2>/dev/null' EXIT

# The collector writes runs/status.md at the end of every cycle. One that finishes no cycle for
# STALL seconds plays nobody: the tabs lose their focus and sign-in keeper and the groups get no
# tasks. On 2026-11-12 it stood for eleven minutes until it was restarted by hand. It is ended
# here and started again, and so is one that exits by itself. A start is the collector's heaviest
# work, and on a machine short of memory one took over five minutes to its second cycle, so the
# time is a quarter of an hour: a shorter one ended that start and began the next. The loop is
# this script's last command, so the shell that runs it has read all of it and a later edit of
# the file does not reach it.
STALL=900
while :; do
  bun tools/iqd.mjs run --interval 30 --coordinate --recover &
  collector=$!
  started=$(date +%s)
  while kill -0 "$collector" 2>/dev/null; do
    sleep 15
    # The collector asks for a new relay with this file (`relayStuck` in tools/iqd.mjs). Only a
    # relay this script started can be replaced. The block below starts the new one.
    ask="${IQD_RUNS:-runs}/state/relay-restart"
    if [ -e "$ask" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') play: the collector asked for a new relay: $(cat "$ask")"
      rm -f "$ask"
      kill "$relay" 2>/dev/null
      sleep 2
      relayStarted=0
    fi
    # Another relay may own the port, so retry our exited relay at most once a minute.
    if ! kill -0 "$relay" 2>/dev/null && [ "$(($(date +%s) - ${relayStarted:-0}))" -ge 60 ]; then
      omp browser-relay &
      relay=$!
      relayStarted=$(date +%s)
    fi
    cycled=$(stat -f %m "${IQD_RUNS:-runs}/status.md" 2>/dev/null || stat -c %Y "${IQD_RUNS:-runs}/status.md" 2>/dev/null || echo 0)
    [ "$cycled" -lt "$started" ] && cycled=$started
    age=$(($(date +%s) - cycled))
    if [ "$age" -gt "$STALL" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') play: the collector finished no cycle for ${age} s, so it is started again"
      kill "$collector" 2>/dev/null
      sleep 3
      kill -9 "$collector" 2>/dev/null
      break
    fi
  done
  wait "$collector" 2>/dev/null
  echo "$(date '+%Y-%m-%d %H:%M:%S') play: the collector ended, starting it again in 10 s"
  sleep 10
done
