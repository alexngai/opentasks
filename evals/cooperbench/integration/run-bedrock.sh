#!/usr/bin/env bash
#
# Run CooperBench on AWS Bedrock, with optional OpenTasks injection (no fork).
#
#   ./run-bedrock.sh solo        baseline: one agent does both features
#   ./run-bedrock.sh team        CooperBench's stock Redis-backed team mode
#   ./run-bedrock.sh opentasks   team mode, OpenTasks coordination backend (injected)
#
# Overridable via env: CB_MODEL, CB_REPO, CB_TASK, CB_FEATURES, CB_NAME, CB_CONCURRENCY.
#
# Bedrock: uses the default AWS profile (us-east-1). Verified working with
# bedrock/us.anthropic.claude-{haiku-4-5,sonnet-4-5}-... (litellm + boto3).
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CB="$HERE/../../../references/cooperbench"

MODEL="${CB_MODEL:-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
REPO="${CB_REPO:-pallets_click_task}"
TASK="${CB_TASK:-2068}"
FEATURES="${CB_FEATURES:-1,2}"
CONC="${CB_CONCURRENCY:-1}"
MODE="${1:-}"
NAME="${CB_NAME:-ot-${MODE:-run}-$(date +%s)}"

export AWS_REGION_NAME=us-east-1 AWS_DEFAULT_REGION=us-east-1

cd "$CB"
COMMON=(-n "$NAME" -r "$REPO" -t "$TASK" -f "$FEATURES" -m "$MODEL"
        -a mini_swe_agent_v2 -c "$CONC" --backend docker)

case "$MODE" in
  solo)
    exec .venv/bin/cooperbench run "${COMMON[@]}" --setting solo
    ;;
  team)
    exec .venv/bin/cooperbench run "${COMMON[@]}" --setting team
    ;;
  opentasks)
    # No-fork injection: CooperBench imports our patch module via its external-agent
    # hook; CB_OPENTASKS=1 activates the Redis->OpenTasks backend swap.
    export CB_OPENTASKS=1
    export OPENTASKS_DAEMON_IMAGE="${OPENTASKS_DAEMON_IMAGE:-opentasks-daemon:smoke}"
    export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
    export COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench
    exec .venv/bin/cooperbench run "${COMMON[@]}" --setting team
    ;;
  *)
    echo "usage: $0 {solo|team|opentasks}" >&2
    exit 1
    ;;
esac
