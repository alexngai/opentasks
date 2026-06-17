#!/usr/bin/env bash
#
# Proves the Python OpenTasks client (the Option-A `coop-task-*` backend for the
# CooperBench integration) against a live host daemon: create_task / claim_next /
# atomic claim + record_attempt / list_attempts / verifies-edge.
#
# `daemon start` blocks until the socket is bound, so no sleep is needed.
#
set -euo pipefail
cd "$(dirname "$0")/../../.."  # repo root
[ -f dist/cli.js ] || { echo "build first: npm run build"; exit 1; }

DIR=$(mktemp -d)
export OPENTASKS_PROJECT_DIR="$DIR"
cleanup() { node dist/cli.js daemon stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

node dist/cli.js init >/dev/null 2>&1 || true
node dist/cli.js daemon start >/dev/null 2>&1 || true
[ -S "$DIR/daemon.sock" ] || { echo "daemon socket not bound at $DIR/daemon.sock"; exit 1; }

OT_SOCK="$DIR/daemon.sock" python3 evals/cooperbench/integration/test_ot_client.py
