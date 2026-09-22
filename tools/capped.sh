#!/bin/bash
# Run a headless-browser tool under a hard memory cap AND a machine-wide lock, so only one
# SwiftShader Chrome runs at a time and a runaway one is killed alone (see HANDOFF.md: two
# parallel ~6 GB Chromes OOM-killed the whole session on this 16 GB, no-swap box).
# Usage: tools/capped.sh [MAX, default 4G] -- cmd args...
# Every tool that launches a browser (verify, shot, labshot) must be run through this.
MAX=4G; if [ "$1" != "--" ]; then MAX=$1; shift; fi; shift
exec flock /tmp/toytanks-browser.lock systemd-run --user --scope --quiet -p MemoryMax=$MAX -p MemorySwapMax=0 "$@"
