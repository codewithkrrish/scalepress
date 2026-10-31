#!/usr/bin/env bash
# Run the ScalePress frontend checks: syntax + the jsdom harness.
# jsdom is installed into /tmp so the shipped site stays dependency-free.
set -euo pipefail
cd "$(dirname "$0")/.."

for f in js/*.js; do
  node --check "$f"
done
echo "node --check: all JS files parse"

python3 -m py_compile backend/app.py deploy/modal/modal_app.py deploy/beam/beam_app.py
echo "py_compile: backend + Modal/Beam wrappers parse"

if [ ! -d /tmp/scalepress-test/node_modules/jsdom ]; then
  mkdir -p /tmp/scalepress-test
  (cd /tmp/scalepress-test && npm init -y >/dev/null 2>&1 && npm install jsdom --no-audit --no-fund)
fi

node tests/harness.mjs
