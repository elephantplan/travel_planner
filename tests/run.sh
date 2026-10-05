#!/bin/sh
# Serves the repo and runs the browser tests against it.
#   sh tests/run.sh
# Needs playwright (npm i playwright) and a chromium at PW_CHROMIUM, or the
# one these containers ship with.
set -e
cd "$(dirname "$0")/.."
python3 -m http.server 8799 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
for t in tests/*.js; do
  case "$t" in */fixture.js) continue ;; esac
  echo "── $t"
  node "$t"
done
