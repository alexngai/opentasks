#!/usr/bin/env bash
#
# Validate the host<->daemon socat bridge (the Option-B reachability piece):
# provision a daemon sidecar + socat bridge via the injection's REAL functions,
# then run the shim test over tcp://127.0.0.1:PORT (host -> bridge -> daemon).
# No Bedrock / no agents — pure infra check. Needs Docker + the daemon image.
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../.."  # repo root
PY="references/cooperbench/.venv/bin/python"
[ -x "$PY" ] || { echo "cooperbench venv missing"; exit 1; }
RID="bridgetest"
PORT="${CB_OT_BRIDGE_PORT:-47600}"
export OPENTASKS_DAEMON_IMAGE="${OPENTASKS_DAEMON_IMAGE:-opentasks-daemon:smoke}"

cleanup() { docker rm -f "cb-ot-$RID" "cb-otbridge-$RID" >/dev/null 2>&1; docker volume rm "cb-ot-$RID" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup  # clear any prior

# Provision daemon + socat bridge using the REAL injection functions (CB_OPENTASKS
# unset -> no monkeypatching; the functions are still importable).
PYTHONPATH="$HERE" "$PY" - "$RID" <<'PYEOF'
import sys
import opentasks_cooperbench as ot
rid = sys.argv[1]
ot.ensure_opentasks_daemon(rid)
ot.ensure_socat_bridge(rid)
print("provisioned daemon + socat bridge for run", rid)
PYEOF

echo "=== shim test over the TCP bridge ==="
OT_SOCK="tcp://127.0.0.1:$PORT" PYTHONPATH="$HERE" "$PY" "$HERE/test_shim.py"
