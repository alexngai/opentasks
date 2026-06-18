#!/usr/bin/env bash
#
# Validates the OpenTasks-backed _RedisLike shim (the Option-B split-brain fix)
# against a live host daemon, driving CooperBench's REAL TaskListClient + poller
# read-path through it. Uses the cooperbench venv python (so `cooperbench` imports).
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../.."  # repo root
[ -f dist/cli.js ] || { echo "build first: npm run build"; exit 1; }
PY="references/cooperbench/.venv/bin/python"
[ -x "$PY" ] || { echo "cooperbench venv missing: cd references/cooperbench && uv sync"; exit 1; }

DIR=$(mktemp -d)
export OPENTASKS_PROJECT_DIR="$DIR"
cleanup() { node dist/cli.js daemon stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

node dist/cli.js init >/dev/null 2>&1 || true
node dist/cli.js daemon start >/dev/null 2>&1 || true
[ -S "$DIR/daemon.sock" ] || { echo "daemon socket not bound at $DIR/daemon.sock"; exit 1; }

OT_SOCK="$DIR/daemon.sock" "$PY" "$HERE/test_shim.py"
