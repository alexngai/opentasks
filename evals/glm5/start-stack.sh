#!/usr/bin/env bash
# Stand up the GLM-5-via-Bedrock-Mantle stack the eval harness talks to:
#
#   claude CLI -> LiteLLM :4000 -> SigV4 shim :8787 -> Mantle /v1/chat/completions -> GLM-5 (zai.glm-5)
#
# GLM-5 is NOT a Bedrock-SDK model: the CLI speaks the Anthropic Messages API to
# LiteLLM, which translates to Mantle's OpenAI /v1/chat/completions. The shim
# re-signs each request with AWS SigV4 (service=bedrock, region us-east-1 — GLM-5
# is not in us-west-1) using the AWS default profile creds, because LiteLLM's
# bedrock_mantle provider only does static Bearer auth (we have SigV4 creds only).
#
# Idempotent: skips any component already listening. /tmp is ephemeral, so this
# rebuilds the stack from the committed shim + config.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="${GLM5_VENV:-$DIR/.venv}"
SHIM_PORT="${SHIM_PORT:-8787}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
LOGDIR="$DIR/.logs"; mkdir -p "$LOGDIR"

if [ ! -x "$VENV/bin/litellm" ]; then
  echo "[glm5] creating venv at $VENV (litellm[proxy]==1.89.0 + botocore) ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" -q install --upgrade pip
  "$VENV/bin/pip" -q install "litellm[proxy]==1.89.0" botocore
fi

if ! lsof -nP -iTCP:"$SHIM_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[glm5] starting SigV4 shim on :$SHIM_PORT ..."
  SHIM_PORT="$SHIM_PORT" nohup "$VENV/bin/python3" "$DIR/sigv4_shim.py" >"$LOGDIR/shim.log" 2>&1 &
  sleep 1
fi

if ! curl -s -m 2 "http://127.0.0.1:$LITELLM_PORT/health/liveliness" >/dev/null 2>&1; then
  echo "[glm5] starting LiteLLM on :$LITELLM_PORT ..."
  nohup "$VENV/bin/litellm" --config "$DIR/litellm-config.yaml" --port "$LITELLM_PORT" >"$LOGDIR/litellm.log" 2>&1 &
  for _ in $(seq 1 30); do curl -s -m 2 "http://127.0.0.1:$LITELLM_PORT/health/liveliness" >/dev/null 2>&1 && break; sleep 1; done
fi

echo "[glm5] stack up — LiteLLM http://127.0.0.1:$LITELLM_PORT  shim :$SHIM_PORT"
echo "[glm5] run evals with:"
echo "  EVAL_MODEL=glm-5 ANTHROPIC_BASE_URL=http://127.0.0.1:$LITELLM_PORT ANTHROPIC_API_KEY=sk-glm5-spike-master npx tsx evals/run.ts"
