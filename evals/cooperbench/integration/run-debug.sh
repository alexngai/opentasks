#!/usr/bin/env bash
#
# Single-instance debug runner: ONE (repo,task,features) x ONE arm x ONE provider.
# For isolating the team-mode failures (provider vs harness vs budget).
#
#   ./run-debug.sh {solo|team|opentasks}
#
# Provider is chosen by CB_MODEL:
#   bedrock/*    -> AWS region routing (CB_REGION, default eu-central-1)
#   azure/*      -> AZURE_API_KEY/BASE/VERSION (key pulled from login shell if unset)
#   anthropic/*  -> ANTHROPIC_API_KEY (must be in env)
# Default model = Bedrock sonnet-4-5. Azure example: CB_MODEL=azure/gpt-5.5
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CB="$HERE/../../../references/cooperbench"

ARM="${1:-opentasks}"
REPO="${CB_REPO:-pallets_jinja_task}"   # jinja = the discriminating cell (solo+redis pass)
TASK="${CB_TASK:-1465}"
FEATS="${CB_FEATURES:-1,2}"
REGION="${CB_REGION:-eu-central-1}"
case "$REGION" in
  us-*) _PFX=us ;; eu-*) _PFX=eu ;; ap-southeast-2) _PFX=au ;; ap-northeast-1) _PFX=jp ;; *) _PFX=us ;;
esac
MODEL="${CB_MODEL:-bedrock/${_PFX}.anthropic.claude-sonnet-4-5-20250929-v1:0}"
TAG=$(printf '%s' "$MODEL" | tr '/:.' '___' | cut -c1-18)
NAME="${CB_NAME:-dbg-${ARM}-${TAG}}"

# Load the injection module for EVERY arm so seam-5 hardening (timeout/modify_params/
# caps) applies to the redis baseline + solo too (fair A/B). The OpenTasks backend
# swap is gated separately on CB_OPENTASKS (set only for the opentasks arm). Opentasks
# runs self-clean their sidecar via the injection's atexit; parallel runs use distinct
# CB_OT_BRIDGE_PORT + run_ids so they don't collide.
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
export COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench
export OPENTASKS_DAEMON_IMAGE="${OPENTASKS_DAEMON_IMAGE:-opentasks-daemon:smoke}"

# --- provider env ---
if [[ "$MODEL" == bedrock/* ]]; then
  export AWS_REGION_NAME="$REGION" AWS_DEFAULT_REGION="$REGION"
elif [[ "$MODEL" == azure/* ]]; then
  : "${AZURE_API_BASE:=https://staging-west-us3.openai.azure.com/}"
  : "${AZURE_API_VERSION:=2025-04-01-preview}"
  export AZURE_API_BASE AZURE_API_VERSION
  if [ -z "${AZURE_API_KEY:-}" ]; then
    export AZURE_API_KEY="$(zsh -lic 'printf %s "$AZURE_API_KEY"' 2>/dev/null)"
  fi
  [ -z "${AZURE_API_KEY:-}" ] && { echo "AZURE_API_KEY not found (login shell)"; exit 1; }
  echo "azure: base=$AZURE_API_BASE version=$AZURE_API_VERSION key=present(${#AZURE_API_KEY})"
fi

cd "$CB"
COMMON=(-n "$NAME" -r "$REPO" -t "$TASK" -f "$FEATS" -m "$MODEL" -a mini_swe_agent_v2 -c 1 --backend docker)

case "$ARM" in
  solo) SETTING=solo ;;
  team) SETTING=team ;;
  opentasks)
    SETTING=team
    export CB_OPENTASKS=1   # activates seams 1-4 (OpenTasks backend); seam 5 already on
    ;;
  *) echo "usage: $0 {solo|team|opentasks}" >&2; exit 1 ;;
esac

echo "DEBUG: arm=$ARM setting=$SETTING model=$MODEL task=$REPO/$TASK f$FEATS name=$NAME"
.venv/bin/cooperbench run "${COMMON[@]}" --setting "$SETTING"
echo "=== rc=$? — results: logs/$NAME/$SETTING/$REPO/$TASK/ ==="
