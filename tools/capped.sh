#!/bin/bash
# Run a headless-browser tool under a machine-wide lock (and a memory cap where systemd allows),
# so only one SwiftShader Chrome runs at a time. See docs/DESIGN.md "Ground rules".
# Usage: tools/capped.sh [MAX, default 4G] -- cmd args...
MAX=4G; if [ "$1" != "--" ]; then MAX=$1; shift; fi; shift
if systemd-run --user --scope --quiet true 2>/dev/null; then
  exec flock /tmp/toytanks-browser.lock systemd-run --user --scope --quiet -p MemoryMax=$MAX -p MemorySwapMax=0 "$@"
fi
exec flock /tmp/toytanks-browser.lock timeout 900 "$@"
