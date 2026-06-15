# GLM-5 via Bedrock Mantle — local model stack

The eval harness is model-agnostic (`EVAL_MODEL`). To run it on **GLM-5**, the
spawned `claude` CLI talks to a local LiteLLM proxy instead of Anthropic:

```
claude CLI ──Anthropic Messages API──▶ LiteLLM :4000 ──OpenAI──▶ SigV4 shim :8787 ──SigV4──▶ Mantle /v1/chat/completions ──▶ GLM-5 (zai.glm-5)
```

GLM-5 is **not** a Bedrock-SDK model — do NOT set `CLAUDE_CODE_USE_BEDROCK=1`.
`mantle` = the proxy; the model id `zai.glm-5` lives at
`https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions` (us-east-1; GLM-5
is not in us-west-1). LiteLLM's `bedrock_mantle` provider hits the right endpoint
but only does static Bearer auth — we have AWS SigV4 creds only — so
`sigv4_shim.py` re-signs each request with the AWS default profile creds.

## Start the stack

```bash
bash evals/glm5/start-stack.sh        # idempotent; builds .venv on first run
```

## Run the eval against GLM-5

```bash
EVAL_MODEL=glm-5 \
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
ANTHROPIC_API_KEY=sk-glm5-spike-master \      # MUST equal litellm-config.yaml master_key
  npx tsx evals/run.ts
```

The runner handles the rest: it gives each run a **unique empty
`CLAUDE_CONFIG_DIR`** (because `ANTHROPIC_API_KEY` is set) so the box's Max-plan
login can't leak through and override the key.

## Gotchas (cost real time)

- Use **`ANTHROPIC_API_KEY`**, not `ANTHROPIC_AUTH_TOKEN` — the CLI ignores
  `AUTH_TOKEN` and sends its stored `sk-ant-…` login → LiteLLM `400 No connected db`.
- **Unique empty `CLAUDE_CONFIG_DIR` per run** — else the existing login leaks and
  overrides the key (same `400`). The runner does this automatically.
- **Token accounting:** ignore `total_cost_usd` (LiteLLM estimating Anthropic
  pricing — meaningless for GLM-5). The runner sums `modelUsage[*]` instead.
- The shim is threaded but has **no retry/backoff**, and Mantle has a per-minute
  TPM limit (no daily cap) — keep concurrency low (sequential or ≤2-way).
- Keep GLM-5 results in a **separate dir** so they never pool with other models.

## Files

- `sigv4_shim.py` — ~40-line stdlib+botocore SigV4 reverse proxy (:8787).
- `litellm-config.yaml` — maps `glm-5` → `bedrock_mantle/zai.glm-5` via the shim.
- `start-stack.sh` — idempotent launcher (venv + shim + LiteLLM).

`master_key: sk-glm5-spike-master` in the config is a **local throwaway** key for
the local proxy only — not an AWS credential (those come from the environment).

## Status

Verified end-to-end through the OpenTasks eval harness: `EVAL_MODEL=glm-5` stock
arm passed the smoke task with real `modelUsage` token accounting.
