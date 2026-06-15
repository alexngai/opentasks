# AppWorld + GLM-5 — working setup recipe

The verified recipe to run **AppWorld** (HAL's E2′ benchmark) on **GLM-5** (via
our Bedrock-Mantle LiteLLM proxy). This took several non-obvious steps to get
past upstream packaging drift — captured here so it's reproducible.

**Verified 2026-06-14:** a single `test_normal` task ran end-to-end on GLM-5,
`task_goal_completion = 100.0`, ~$0.07, 3.6 min, 19 ReAct steps.

## Why it's fiddly (the gotchas, in order)

1. **Env isolation.** AppWorld can't share HAL's core venv: HAL/weave need
   pydantic v2, AppWorld's old `sqlmodel==0.0.10` needs pydantic v1. Use a
   **separate venv** (and bump sqlmodel — see #4).
2. **PyPI vs git version drift.** PyPI `appworld 0.1.3.post1` is too old for the
   current methods package (`appworld-agents@main` imports `appworld.common.misc`,
   added in `0.2.0`). Install **both from git@main** (or editable from a clone).
3. **Methods package renamed** `appworld-experiments` → `appworld-agents`
   (HAL's `.[appworld]` extra is stale).
4. **sqlmodel pin is too conservative.** `sqlmodel>=0.0.18` (e.g. 0.0.38) imports
   fine on pydantic v2 — fixes the v1/v2 clash.
5. **Apps bundle is Git-LFS.** A plain `pip install git+…` / `git clone` gets a
   131-byte LFS *pointer*, not the real `apps.bundle` → `appworld install` fails.
   Need `git lfs pull` in a clone, then editable-install the clone.
6. **Run from the appworld repo root.** Editable ("repo") installs make
   `appworld run` look for `src/appworld/.source/apps.bundle` **relative to cwd**.
7. **Bare `OpenAI()` needs `OPENAI_API_KEY`.** The method constructs a bare
   `OpenAI()` at init (even though the real key/base_url come from the config),
   so the standard `OPENAI_API_KEY`/`OPENAI_BASE_URL` env vars must be set too.

## Setup

```bash
# 1. git-lfs + a real clone (for the apps bundle)
brew install git-lfs && git lfs install
git clone https://github.com/stonybrooknlp/appworld.git ~/GitHub/appworld
cd ~/GitHub/appworld && git lfs pull          # apps.bundle becomes a real ~190KB file

# 2. isolated venv (separate from HAL core)
cd ~/GitHub/hal-harness
uv venv --python 3.12 .venv-appworld && source .venv-appworld/bin/activate

# 3. editable install from the clone + pydantic-v2 sqlmodel
uv pip install -e ~/GitHub/appworld -e ~/GitHub/appworld/experiments "sqlmodel>=0.0.18"

# 4. unpack apps + data (run from the appworld repo root)
cd ~/GitHub/appworld
appworld install
appworld download data --root .
```

## GLM-5 model config

A config pointing AppWorld's OpenAI-compatible client at our LiteLLM proxy lives
at:
`~/GitHub/appworld/experiments/configs/simplified_react_code_agent/zai/glm-5/test_normal.jsonnet`
(clone of the `zai/glm-4.6` config with `base_url: http://127.0.0.1:4000/v1`,
`name: glm-5`). The GLM-5 proxy stack must be up:
`bash ~/GitHub/opentasks/evals/glm5/start-stack.sh`.

## Run one task

```bash
cd ~/GitHub/appworld && source ~/GitHub/hal-harness/.venv-appworld/bin/activate
OPENAI_API_KEY=sk-glm5-spike-master \
OPENAI_BASE_URL=http://127.0.0.1:4000/v1 \
ZAI_API_KEY=sk-glm5-spike-master \
appworld run simplified_react_code_agent/zai/glm-5/test_normal \
  --task-id 3d9a636_1 --root . --with-setup
# (drop --task-id to run the whole test_normal split; --num-processes N for parallel)
```

Outputs + the ground-truth evaluation land in
`experiments/outputs/simplified_react_code_agent/zai/glm-5/test_normal/`.

## Status / next

- ✅ **Stock arm validated** — `simplified_react_code_agent` + GLM-5 passes a task.
- ⏭️ Build the **OpenTasks** and **NOTES** arms as AppWorld *method* variants
  (give the agent an OpenTasks MCP / NOTES discipline alongside the app APIs),
  reusing this model config. Then the E2′ pilot: 3 arms × a small task slice × k,
  token-matched.

> Note: this lives outside the opentasks package build (it drives external repos
> `~/GitHub/appworld` + `~/GitHub/hal-harness`). The eval-orchestration code is
> being consolidated under `swarmkit/src/eval` (see that repo).
