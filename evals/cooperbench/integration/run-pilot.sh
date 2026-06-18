#!/usr/bin/env bash
#
# CooperBench A/B pilot — Redis vs OpenTasks coordination backend.
#
#   3 conflicting feature-pairs × {solo, team(redis), opentasks} on Bedrock sonnet-4-5.
#   Headline = RETENTION (coop pass-rate / solo pass-rate); OpenTasks arm vs Redis arm.
#
# Usage:
#   ./run-pilot.sh solo        # the retention DENOMINATOR — run + inspect this first
#   ./run-pilot.sh redis       # CooperBench's stock Redis-backed team mode
#   ./run-pilot.sh opentasks   # team mode, OpenTasks backend + attempt/verify nudge (injected)
#   ./run-pilot.sh all         # all three, in order
#
# Each arm uses a DISTINCT run-name so redis & opentasks (both setting=team) don't
# collide on disk. Re-running the same arm is a FREE cache hit (no --force).
#
# Report: python3 ./pilot-report.py "$RUN_TAG"
#
set -uo pipefail   # deliberately NOT -e: best-effort across cells (one failure ≠ abort battery)
HERE="$(cd "$(dirname "$0")" && pwd)"
CB="$HERE/../../../references/cooperbench"

CONC="${CB_CONCURRENCY:-1}"
TAG="${RUN_TAG:-otpilot}"
DAEMON_IMAGE="${OPENTASKS_DAEMON_IMAGE:-opentasks-daemon:smoke}"

# repo:task:features — confirmed conflicting pairs, mature/heavily-tested Python libs
# (sonnet has a real shot solo → meaningful retention denominator).
TASKS=(
  "pallets_click_task:2068:1,2"
  "pallets_jinja_task:1465:1,2"
  "openai_tiktoken_task:0:1,2"
)

# Region is overridable (CB_REGION) so an arm can run against a separate per-day
# Bedrock token bucket — quotas are per-region/geography. The inference-profile
# prefix is DERIVED from the region automatically (override wholesale with CB_MODEL),
# so you never mismatch e.g. a `us.` profile against an eu-* region.
REGION="${CB_REGION:-us-east-1}"
case "$REGION" in
  us-*)            _PFX=us ;;
  eu-*)            _PFX=eu ;;
  ap-southeast-2)  _PFX=au ;;   # Australia
  ap-northeast-1)  _PFX=jp ;;   # Japan
  *)               _PFX=us ;;
esac
MODEL="${CB_MODEL:-bedrock/${_PFX}.anthropic.claude-sonnet-4-5-20250929-v1:0}"
# Bedrock-only AWS region/quota routing. To ISOLATE the provider, set
# CB_MODEL=anthropic/claude-sonnet-4-5-... with ANTHROPIC_API_KEY in the env
# (litellm reads it) — AWS routing is then skipped.
if [[ "$MODEL" == bedrock/* ]]; then
  export AWS_REGION_NAME="$REGION" AWS_DEFAULT_REGION="$REGION"
fi

# Belt-and-suspenders teardown: the injection's atexit/signal handler already cleans
# the specific run's sidecar; if THIS wrapper is killed, clean any cb-ot-* here too.
# (Assumes serial pilot runs — removes ALL cb-ot-* sidecars, not just one run's.)
_cleanup_sidecars() {
  local c v
  c=$(docker ps -aq --filter name=cb-ot 2>/dev/null)        # cb-ot-<run> daemons + cb-otbridge-<run>
  v=$(docker volume ls -q --filter name=cb-ot- 2>/dev/null)  # cb-ot-<run> socket volumes
  [ -n "$c" ] && docker rm -f $c >/dev/null 2>&1
  [ -n "$v" ] && docker volume rm $v >/dev/null 2>&1
  return 0
}
trap _cleanup_sidecars EXIT INT TERM

cd "$CB"

# Load the injection for EVERY arm so seam-5 hardening (timeout/modify_params/caps)
# applies to the redis baseline + solo too (fair A/B). Seams 1-4 (OpenTasks backend)
# gate on CB_OPENTASKS, set only for the opentasks arm below.
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
export COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench
export OPENTASKS_DAEMON_IMAGE="$DAEMON_IMAGE"

run_cell () {  # $1=arm label  $2=run-name  $3=setting
  local spec repo tid feats rc
  for spec in "${TASKS[@]}"; do
    IFS=: read -r repo tid feats <<< "$spec"
    echo ">>> [$1] $repo task$tid f$feats  (name=$2 setting=$3 model=$MODEL)"
    .venv/bin/cooperbench run -n "$2" -r "$repo" -t "$tid" -f "$feats" \
      -m "$MODEL" -a mini_swe_agent_v2 -c "$CONC" --backend docker --setting "$3"
    rc=$?
    [ $rc -ne 0 ] && echo "    !! cell rc=$rc (continuing): $1 $repo task$tid f$feats"
  done
}

ARM="${1:-all}"

if [[ "$ARM" == "solo" || "$ARM" == "all" ]]; then
  run_cell solo "${TAG}-solo" solo
fi
if [[ "$ARM" == "redis" || "$ARM" == "all" ]]; then
  run_cell redis "${TAG}-redis" team
fi
if [[ "$ARM" == "opentasks" || "$ARM" == "all" ]]; then
  export CB_OPENTASKS=1   # activates seams 1-4 (OpenTasks backend); seam 5 already on for all arms
  run_cell opentasks "${TAG}-ot" team
fi

echo "=== arm '$ARM' done. report: python3 $HERE/pilot-report.py $TAG ==="
