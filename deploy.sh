#!/bin/bash
# Push Toy Tanks to https://toytanks.jer.couleetech.network — see ~/Projects/GAME_HOSTING.md
set -e
cd "$(dirname "$0")"
node tools/build.mjs
for f in index.html game.js ui.css hud.css; do sudo install -m 644 "dist/$f" "/var/www/toytanks/$f"; done
echo "deployed:"
curl -s --resolve toytanks.jer.couleetech.network:443:172.18.22.13 --max-time 20 \
  -o /dev/null -w "  https://toytanks.jer.couleetech.network/  HTTP %{http_code}  %{size_download} bytes\n" \
  https://toytanks.jer.couleetech.network/
