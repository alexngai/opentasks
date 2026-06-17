#!/usr/bin/env bash
#
# Cross-container claim smoke — the §8 must-pass gate for the sidecar topology.
# Builds the daemon image, brings up the sidecar daemon, seeds N tasks, races
# two agents (in separate containers) to drain via claim_next, and verifies
# exactly-once across the container boundary.
#
# Usage: ./run-smoke.sh            # default 6 tasks
#        OT_TASKS=12 ./run-smoke.sh
#
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.smoke.yml)
TASKS="${OT_TASKS:-6}"

cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> [1/5] build daemon image"
"${COMPOSE[@]}" build

echo "==> [2/5] start sidecar daemon (wait until socket is bound / healthy)"
"${COMPOSE[@]}" up -d --wait ot-daemon

echo "==> [3/5] seed ${TASKS} tasks"
"${COMPOSE[@]}" run --rm --no-deps -e "OT_TASKS=${TASKS}" seed

echo "==> [4/5] race two agents draining claim_next (separate containers)"
"${COMPOSE[@]}" run --rm --no-deps -e OT_AGENT_ID=agent-a agent &
A=$!
"${COMPOSE[@]}" run --rm --no-deps -e OT_AGENT_ID=agent-b agent &
B=$!
wait "$A"
wait "$B"

echo "==> [5/5] verify exactly-once across containers"
"${COMPOSE[@]}" run --rm --no-deps -e "OT_TASKS=${TASKS}" check

echo "==> SMOKE PASSED — cross-container atomic claim holds"
