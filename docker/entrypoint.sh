#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/processing /videos/unprocessed /videos/archived /videos/processed

node /app/apps/api/dist/server.js &
api_pid=$!

nginx -g "daemon off;" &
nginx_pid=$!

shutdown() {
  kill "$api_pid" "$nginx_pid" 2>/dev/null || true
}

trap shutdown TERM INT

wait -n "$api_pid" "$nginx_pid"
exit_code=$?
shutdown
exit "$exit_code"
