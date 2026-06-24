#!/usr/bin/env bash
set -euo pipefail

host="${TAC_GRADER_PROXY_HOST:-127.0.0.1}"
port="${TAC_GRADER_PROXY_PORT:-4000}"
alias_name="${TAC_GRADER_PROXY_MODEL:-tac-grader}"
proxy_key="${TAC_GRADER_PROXY_KEY:-${LITELLM_API_KEY:-sk-tac-grader-local}}"
bedrock_model="${TAC_GRADER_BEDROCK_MODEL:-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
bedrock_region="${TAC_GRADER_BEDROCK_REGION:-${AWS_REGION:-us-west-2}}"
state_dir="${TAC_GRADER_PROXY_STATE_DIR:-$HOME/.cache/opentasks-tac-grader-proxy}"
venv_dir="$state_dir/venv"
config_file="$state_dir/config.yaml"
pid_file="$state_dir/litellm.pid"
log_file="$state_dir/litellm.log"

mkdir -p "$state_dir"

echo "Configuring TAC grader LiteLLM proxy at $host:$port as $alias_name -> $bedrock_model"

if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip
  fi
fi

smoke_proxy() {
  python3 - "$host" "$port" "$proxy_key" "$alias_name" <<'PY'
import json
import sys
import urllib.error
import urllib.request

host, port, key, model = sys.argv[1:]
url = f"http://{host}:{port}/v1/chat/completions"
body = json.dumps({
    "model": model,
    "messages": [{"role": "user", "content": "Answer exactly: ok"}],
    "max_tokens": 8,
}).encode()
req = urllib.request.Request(
    url,
    data=body,
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as res:
        payload = json.loads(res.read().decode())
except Exception as exc:
    print(f"proxy smoke failed: {exc}", file=sys.stderr)
    sys.exit(1)

content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
if "ok" not in content.lower():
    print(f"proxy smoke returned unexpected content: {content!r}", file=sys.stderr)
    sys.exit(1)
PY
}

if smoke_proxy >/dev/null 2>&1; then
  echo "TAC grader LiteLLM proxy already healthy on $host:$port as $alias_name"
  exit 0
fi

if [[ -f "$pid_file" ]]; then
  old_pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill "$old_pid" >/dev/null 2>&1 || true
    sleep 2
  fi
fi

if [[ ! -x "$venv_dir/bin/litellm" ]]; then
  python3 -m venv "$venv_dir"
  "$venv_dir/bin/python" -m pip install --upgrade pip
  "$venv_dir/bin/python" -m pip install 'litellm[proxy]'
fi

cat > "$config_file" <<YAML
model_list:
  - model_name: ${alias_name}
    litellm_params:
      model: ${bedrock_model}
      aws_region_name: ${bedrock_region}

litellm_settings:
  drop_params: true
YAML

export LITELLM_MASTER_KEY="$proxy_key"
export AWS_REGION="$bedrock_region"
nohup "$venv_dir/bin/litellm" \
  --config "$config_file" \
  --host "$host" \
  --port "$port" \
  > "$log_file" 2>&1 &
echo "$!" > "$pid_file"

deadline=$((SECONDS + ${TAC_GRADER_PROXY_START_TIMEOUT_SEC:-180}))
until smoke_proxy >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "TAC grader LiteLLM proxy did not become healthy. Last log lines:" >&2
    tail -n 120 "$log_file" >&2 || true
    exit 1
  fi
  if ! kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    echo "TAC grader LiteLLM proxy exited before becoming healthy. Last log lines:" >&2
    tail -n 120 "$log_file" >&2 || true
    exit 1
  fi
  sleep 5
done

echo "TAC grader LiteLLM proxy healthy on $host:$port as $alias_name -> $bedrock_model"
