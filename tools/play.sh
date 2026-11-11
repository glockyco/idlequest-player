#!/bin/sh
# Play the account until this script is stopped: the browser relay and the collector with its
# coordinator, in the foreground of the terminal tab it runs in. Ctrl-C, closing the tab or a
# reboot stops both, and nothing starts them again.
cd "$(dirname "$0")/.." || exit 1
# A relay that already listens keeps its port, and this one exits at once.
omp browser-relay &
relay=$!
trap 'kill "$relay" 2>/dev/null' EXIT INT TERM
bun tools/iqd.mjs run --interval 30 --coordinate --recover
