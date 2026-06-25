# TheAgentCompany adapter

This is the `swarmkit-eval` path for TAC E2′.

Current status:

- Loads real TAC task metadata from `TAC_ROOT` (default `~/GitHub/TheAgentCompany`).
- Filters by role, dependency set, task id, and scenario presence.
- Reuses the OpenTasks `stock` / `notes` / `opentasks` arms.
- Maps TAC `result.json` shape to `S_partial`.
- Supports `EVAL_FAKE=1` to validate matrix/cache/report plumbing without Docker
  or model spend.
- Supports the real TAC task-image lifecycle through `TacDockerAdapter`. The
  adapter runs Docker through the selected `swarmkit-eval` workspace, so local
  mode uses host Docker, E2B mode requires a template with Docker installed,
  and EC2 mode uses a Docker-capable SSH host through `swarmkit-eval`'s
  generic `Ec2Backend`.

Fake smoke:

```bash
EVAL_FAKE=1 TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=2 EVAL_REPEATS=1 \
  npx tsx evals/tac/run.ts
```

Local Docker smoke:

```bash
npm run build
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=1 EVAL_ARMS=stock \
  TAC_SERVER_HOSTNAME=127.0.0.1 TAC_AGENT_USER=agent \
  TAC_AGENT_SETUP_CMD='apt-get update && apt-get install -y nodejs npm git && npm install -g @anthropic-ai/claude-code && useradd -m -s /bin/sh agent && chown -R agent:agent /workspace /eval' \
  EVAL_BACKEND=in-process npx tsx evals/tac/run.ts
```

E2B Docker smoke:

```bash
npx e2b template build --path evals/tac --name opentasks-tac-docker \
  --cpu-count 4 --memory-mb 4096

npm run build
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=1 EVAL_ARMS=stock \
  EVAL_BACKEND=e2b E2B_TEMPLATE=opentasks-tac-docker \
  TAC_DOCKER_COMMAND='sudo docker' TAC_AGENT_USER=agent \
  TAC_AGENT_SETUP_CMD='apt-get update && apt-get install -y nodejs npm git && npm install -g @anthropic-ai/claude-code && useradd -m -s /bin/sh agent && chown -R agent:agent /workspace /eval' \
  npx tsx evals/tac/run.ts
```

EC2 Docker smoke against an existing TAC service host:

```bash
npm run build
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=1 EVAL_ARMS=stock \
  EVAL_BACKEND=ec2 EC2_HOST=<public-ip-or-dns> EC2_SSH_KEY_PATH=<private-key.pem> \
  EC2_SETUP_COMMANDS='docker --version' \
  TAC_SERVER_HOSTNAME=127.0.0.1 TAC_AGENT_USER=agent \
  TAC_AGENT_SETUP_CMD='apt-get update && apt-get install -y nodejs npm git && npm install -g @anthropic-ai/claude-code && useradd -m -s /bin/sh agent && chown -R agent:agent /workspace /eval' \
  npx tsx evals/tac/run.ts
```

For the `opentasks` arm on EC2, `TAC_OPENTASKS_MOUNT` must be a path on the
remote EC2 host, not this laptop. Build or sync the OpenTasks checkout there
first, then set `TAC_OPENTASKS_MOUNT=/path/on/ec2/opentasks`.

Useful selectors:

| Env | Meaning |
|---|---|
| `TAC_ROOT` | Local TAC checkout path |
| `TAC_VERSION` | Task image version, default `1.0.0` |
| `TAC_ROLE` | Role prefix, e.g. `sde`, `pm`, `hr` |
| `TAC_DEPS` | Comma-separated service deps, e.g. `gitlab` |
| `TAC_DEPS_MODE` | `exact` (default) or `contains` |
| `TAC_HAS_SCENARIOS` | `1` / `0`, filters NPC tasks |
| `EVAL_TASKS` | Comma-separated exact TAC task ids |
| `EVAL_TASK_LIMIT` | Pilot limit after filtering |

Real-run configuration:

| Env | Meaning |
|---|---|
| `EVAL_BACKEND` | `in-process` for host Docker, `e2b` for E2B Docker, `ec2` for AWS EC2 over SSH |
| `EVAL_TIMEOUT` | Agent timeout, default 900000 ms |
| `CLAUDE_CODE_USE_BEDROCK` / `AWS_REGION` / AWS auth env | Required for Bedrock-backed remote Claude runs |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Alternative remote Claude auth for Anthropic/gateway-backed runs |
| `TAC_INIT_TIMEOUT` | `/utils/init.sh` and agent setup timeout, default 600000 ms |
| `TAC_EVAL_TIMEOUT` | `/utils/eval.py` timeout, default 300000 ms |
| `TAC_DOCKER_NETWORK` | Docker network for task containers, default `host` |
| `TAC_DOCKER_COMMAND` | Docker command prefix, e.g. `sudo docker` on E2B |
| `TAC_SERVER_HOSTNAME` | Service hostname passed to TAC init, default `the-agent-company.com` |
| `TAC_AGENT_HARNESS` / `TAC_AGENT_RUNTIME` | Agent harness selected for TAC task containers. Supported runtimes: `claude-code` (default) and `swarm-harness` |
| `TAC_SWARM_HARNESS_VERSION` | npm version used by the default `swarm-harness` setup command, default `0.3.4` |
| `TAC_AGENT_SETUP_CMD` | Optional command run inside each task container before the selected agent harness. Overrides the default Node/harness/user setup, useful for testing a local or unpublished harness build |
| `TAC_AGENT_USER` | Optional non-root user for the agent phase |
| `TAC_OPENTASKS_MOUNT` | Local/remote OpenTasks checkout mounted only for the `opentasks` arm |
| `TAC_OPENTASKS_CONTAINER_DIR` | Container path for that mount, default `/opentasks` |
| `TAC_OPENTASKS_MCP_PREFLIGHT` | Set `0` to skip the OpenTasks MCP list/call preflight before the agent |
| `TAC_OPENTASKS_CLAUDE_MCP_SMOKE` | Set `0` to skip the tiny harness-level OpenTasks MCP smoke. Name retained for compatibility |
| `TAC_OPENTASKS_CLAUDE_MCP_SMOKE_FAIL_FAST` | Set `0` to continue the TAC task even when the harness-level MCP smoke fails. Name retained for compatibility |
| `TAC_OPENTASKS_GRAPH_SEED` | Set `0` to skip deterministic OpenTasks graph seeding from `/instruction/task.md`; default enabled for the OpenTasks arm when the LLM prelude is disabled |
| `TAC_OPENTASKS_TASK_PRELUDE` | Set `1` to enable the optional LLM OpenTasks task-graph prelude before the main TAC agent. Default disabled for benchmark fairness |
| `TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST` | Set `0` to continue the TAC task even when the optional task-graph prelude fails |
| `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE` | Optional prelude failure behavior: `fail-fast` (default when prelude is enabled) or `degrade`; overrides `TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST` |
| `TAC_OPENTASKS_TASK_PRELUDE_RETRIES` | Optional prelude retries after the first attempt for init-only timeouts; default `1` when prelude is enabled |
| `TAC_OPENTASKS_TASK_PRELUDE_TIMEOUT_MS` | Optional prelude per-attempt timeout; default `min(TAC_INIT_TIMEOUT, 240000)` when prelude is enabled |
| `TAC_OPENTASKS_MCP_COMMAND` | OpenTasks MCP command shape: `wrapper` (default), `sh-lc`, or `direct` |
| `TAC_GITLAB_TOKEN_REFRESH` | Set `0` to skip refreshing TAC's documented GitLab `root-token` after GitLab task resets |
| `TAC_ENV_PREFLIGHT` | Set `0` to skip the TAC GitLab health/token preflight before Claude |
| `TAC_GITLAB_WIKI_SMOKE` | Set `0` to skip the scratch-project GitLab wiki API smoke before agent spend |
| `TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT` | Set `1` to require the diagnostic Git HTTP wiki clone/commit/push path, not only API wiki create/read/delete |
| `TAC_EVAL_LLM_PREFLIGHT` | Set `0` to skip the TAC LLM-grader preflight for tasks whose evaluator calls `llm_complete`; requires working `LITELLM_*` env for scored LLM-graded tasks |
| `TAC_GRADER_PROXY` | Set `bedrock` in EC2 pool runs to start a worker-local LiteLLM proxy for TAC LLM graders and default `LITELLM_*` to that proxy |
| `TAC_GRADER_BEDROCK_MODEL` | Bedrock model routed behind the proxy alias; default `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `TAC_GRADER_BEDROCK_REGION` | Bedrock region for the proxy; default `AWS_REGION` or `us-west-2` |
| `TAC_GRADER_PROXY_MODEL` / `TAC_GRADER_PROXY_PORT` / `TAC_GRADER_PROXY_KEY` | Proxy alias, port, and local bearer key; defaults `tac-grader`, `4000`, and `sk-tac-grader-local`; TAC's LiteLLM client defaults to `openai/<alias>` against the proxy |
| `TAC_GITLAB_WIKI_TARGET_SMOKE_PROJECT` | Optional target project path such as `root/sotopia`; only valid with `TAC_PREFLIGHT_ONLY=1` because it writes and cleans up target wiki pages |
| `TAC_PREFLIGHT_ONLY` | Set `1` to stop after TAC init/token/env/wiki preflights and return a self-scored diagnostic success without invoking an agent |
| `TAC_STRICT_MCP_CONFIG` | Set `0` to omit `--strict-mcp-config` for Claude MCP isolation runs |
| `TAC_ALLOWED_TOOLS` | Set `0` to omit `--allowed-tools` for Claude MCP isolation runs |
| `TAC_OPERATING_PROMPT` | Set `0` to disable the shared TAC CLI/service operating prompt |
| `TAC_AGENT_PROMPT_APPENDIX` | Optional prompt text appended equally for every arm in TAC runs |
| `E2B_TEMPLATE` | Docker-enabled E2B template; omit only for E2B's stock template |
| `E2B_SETUP_COMMANDS` | Optional `;;`-separated setup commands run after sandbox boot |
| `EC2_HOST` | Attach to an existing EC2 host by public IP/DNS |
| `EC2_INSTANCE_ID` | Attach to an existing EC2 instance by id; resolves host through AWS CLI |
| `EC2_AMI_ID` | Launch-mode AMI id when no host/instance is supplied |
| `EC2_INSTANCE_TYPE` | Launch-mode instance type, e.g. `m7i.2xlarge` |
| `EC2_KEY_NAME` / `EC2_SSH_KEY_PATH` | AWS key-pair name and local private key path |
| `EC2_SECURITY_GROUP_IDS` | Comma-separated launch-mode security groups |
| `EC2_ROOT_VOLUME_GB` | Launch-mode gp3 root volume size |
| `EC2_USER_DATA_FILE` | Launch-mode user-data file path |
| `EC2_SETUP_COMMANDS` | Optional `;;`-separated commands run on the EC2 workspace before task files |
| `EC2_ROOT` | Remote workspace root; default is per-cell under the SSH user's home |
| `EC2_TERMINATE_ON_DISPOSE` | Launch-mode cleanup toggle, default `true` |
| `TAC_POOL_SKIP_LLM_AUTH_CHECK` | Set `1` only for environment-only EC2 canaries that intentionally stop before agent auth |

Real mode assumes each TAC task container can run the selected agent harness as
a non-root user. `TAC_AGENT_HARNESS=claude-code` is the default and preserves the
current `claude -p --output-format stream-json` behavior. The TAC adapter now has
an explicit harness seam (`evals/tac/agent-harness.ts`) so future runtimes can add
their own install command, CLI invocation, output parser, and usage extraction
without changing TAC task setup or grading. If the image does not include the
selected harness, the default setup installs Node 22 when needed, installs the
selected harness, creates `TAC_AGENT_USER` when set, and fixes `/workspace` and
`/eval` ownership. Set `TAC_AGENT_SETUP_CMD` to override this path for local or
unpublished harness builds, or bake an image/template that already provides the
agent CLI and user.
The `opentasks` arm also requires a built OpenTasks
checkout (`dist/cli.js`) at `TAC_OPENTASKS_MOUNT`; for E2B this must be an
absolute path inside the remote sandbox, which means baking or uploading the
repo before the Docker task container starts.

For GitLab-dependent TAC tasks, the adapter now runs pre-agent environment
checks after TAC init/reset and token refresh. `TAC_ENV_PREFLIGHT` verifies
service health and the documented root token. `TAC_GITLAB_WIKI_SMOKE` creates a
unique scratch project, creates and reads a scratch wiki page through the GitLab
API, then deletes the scratch project. It also records a diagnostic Git HTTP
wiki clone/commit/push attempt, but that git path is non-blocking unless
`TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT=1`. The smoke does not modify the task target
project and its artifact is not injected into the agent prompt. Use
`TAC_PREFLIGHT_ONLY=1` for cheap live validation of this machinery. For
diagnosing a specific task target, set `TAC_GITLAB_WIKI_TARGET_SMOKE_PROJECT`
with `TAC_PREFLIGHT_ONLY=1`; the adapter will create/read/delete unique target
wiki pages and will refuse to run this target smoke in scored agent mode.
For tasks whose evaluator calls TAC's LLM grader helpers, `TAC_EVAL_LLM_PREFLIGHT`
runs a tiny `llm_complete` check before agent spend. Configure `LITELLM_API_KEY`,
`LITELLM_BASE_URL`, and `LITELLM_MODEL` for scored runs; otherwise those tasks
can silently lose LLM-graded checkpoints even when the agent completed the
service-side work.

For Bedrock-graded EC2 pool runs, set `TAC_GRADER_PROXY=bedrock` instead of
manually exporting `LITELLM_*`. The pool starts
`evals/tac/scripts/start-litellm-bedrock-proxy.sh` on each worker, exposes a
worker-local OpenAI-compatible LiteLLM endpoint at `127.0.0.1:4000`, and points
TAC graders at `LITELLM_MODEL=openai/tac-grader`; the proxy maps that request to
the stable `tac-grader` alias. Bedrock API-key auth is picked up from
`AWS_BEARER_TOKEN_BEDROCK`; IAM credentials can also be used through the standard
AWS env vars. Claude 3.5 Sonnet may be unavailable in newer Bedrock
accounts/regions, so keep `TAC_GRADER_BEDROCK_MODEL` explicit in run metadata.

EC2 worker pool:

```bash
TAC_POOL_WORKER_COUNT=4 \
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2 \
EVAL_MODEL=haiku EVAL_ARMS=stock,notes,opentasks \
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=12 \
evals/tac/scripts/run-ec2-pool.sh
```

`run-ec2-pool.sh` destroys the Terraform-created EC2 pool on exit by default.
Set `TAC_POOL_KEEP_WORKERS=1` to leave workers running for debugging or reuse.
It also verifies instance/security-group/key cleanup after destroy by default;
set `TAC_POOL_VERIFY_DESTROY=0` only when AWS CLI verification is unavailable.

For faster repeated runs, bake a TAC worker AMI once, then reuse it:

```bash
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
npm run eval:tac:pool:bake-ami

TAC_POOL_AMI_ID=ami-... TAC_POOL_BOOTSTRAP_TAC=false \
TAC_POOL_WORKER_COUNT=4 \
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
evals/tac/scripts/run-ec2-pool.sh
```

The root-AMI path is useful but can be slow when the root volume is large. For
repeated TAC rounds, prefer the two-volume Docker cache path:

```bash
TAC_POOL_PUBLIC_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool.pub \
TAC_POOL_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
npm run eval:tac:pool:bake-docker-snapshot

TAC_POOL_DOCKER_VOLUME_ENABLED=1 \
TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID=snap-... \
TAC_POOL_SERVICE_SLICE=gitlab \
TAC_POOL_ROOT_VOLUME_GB=80 \
TAC_POOL_DOCKER_VOLUME_GB=200 \
TAC_POOL_DOCKER_VOLUME_IOPS=16000 \
TAC_POOL_DOCKER_VOLUME_THROUGHPUT=1000 \
TAC_POOL_WORKER_COUNT=4 \
evals/tac/scripts/run-ec2-pool.sh
```

This keeps the OS/root volume small and puts Docker image layers, task images,
containers, Docker volumes, and containerd state on a separate EBS volume mounted
at `/mnt/tac-docker`, with bind mounts for `/var/lib/docker` and
`/var/lib/containerd`. The snapshot bake bootstraps one TAC worker, waits for
service health checks, removes live containers/networks, stops Docker, snapshots
only the Docker volume, and destroys the builder by default.

Use `TAC_POOL_SERVICE_SLICE=gitlab` for GitLab-only TAC tasks. In that mode the
worker starts only the TAC API server and GitLab, and the wrapper readiness check
waits only for GitLab. The default `full` slice starts the whole TAC service
stack. For Docker snapshot bakes, `TAC_DOCKER_SNAPSHOT_SERVICE_SLICE` defaults
to the same value as `TAC_POOL_SERVICE_SLICE`.

Use `TAC_DOCKER_SNAPSHOT_MODE=images` to remove containers, networks, and Docker
volumes before snapshotting. Use `TAC_DOCKER_SNAPSHOT_MODE=services` to remove
containers/networks but preserve Docker volumes; this is useful when measuring
whether a service-slice checkpoint gives better startup behavior. Workers still
start fresh containers on boot, so treat service snapshots as a cache seed, not a
long-lived mutable service host.

For snapshot-backed workers, use Fast Snapshot Restore in the target AZ and
raise the Docker volume gp3 IOPS/throughput when measuring TAC startup latency.

For durable results, prefer an external S3 bucket:

```bash
TAC_POOL_RESULTS_S3_URI=s3://my-eval-bucket/opentasks/tac \
TAC_POOL_RESUME_FROM_S3=1 \
evals/tac/scripts/run-ec2-pool.sh
```

The runner syncs to `TAC_POOL_RESULTS_S3_URI/<run-id>` after completed cells
and at the end of the run. Reuse the same `TAC_POOL_RUN_ID` to resume from S3.

Summarize one or more completed pool runs:

```bash
npm run eval:tac:pool:summarize -- \
  evals/.tac-pool-runs/tac-run-a \
  evals/.tac-pool-runs/tac-run-b
```

The summary extractor accepts run directories, `summary.json` files, or a
directory containing run subdirectories. It emits Markdown by default and supports
`--format csv` or `--format jsonl` for cell-level analysis. The output includes
task, arm, model, seed, status, partial score, tokens, env/budget flags,
OpenTasks `get_task`, seeded full-content-before-Bash, and stricter seeded
full-content-before-task-work metrics, graph update counts, GitLab helper usage,
raw GitLab curl count, and HTTP 404/5xx counts.

Manual pool operation:

```bash
terraform -chdir=infra/tac-ec2-pool init
terraform -chdir=infra/tac-ec2-pool apply \
  -var 'worker_count=4' \
  -var 'public_key_path=/Users/alexngai/.ssh/opentasks-tac-pool.pub' \
  -var 'allowed_cidr_blocks=["<your-ip>/32"]' \
  -var 'delete_after=2026-06-20'

terraform -chdir=infra/tac-ec2-pool output -json runner_manifest > /tmp/tac-pool-manifest.json

for ip in $(jq -r '.workers[].public_ip' /tmp/tac-pool-manifest.json); do
  evals/tac/scripts/sync-opentasks-ec2.sh "$ip" /Users/alexngai/.ssh/opentasks-tac-pool
done

TAC_POOL_MANIFEST=/tmp/tac-pool-manifest.json \
EC2_SSH_KEY_PATH=/Users/alexngai/.ssh/opentasks-tac-pool \
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2 \
EVAL_MODEL=haiku EVAL_ARMS=stock,notes,opentasks \
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=12 \
npm run eval:tac:pool
```

The pool runner expands selected work into a durable cell manifest:

```text
task id x arm x model x seed
```

Each worker leases one cell at a time and runs one `evals/tac/run.ts` process
for that cell. Completed success/failure cells are skipped on resume; env errors
are retried up to `TAC_POOL_CELL_MAX_ATTEMPTS` and workers are quarantined after
`TAC_POOL_WORKER_ENV_ERROR_THRESHOLD` consecutive env errors. Keep
`EVAL_CONCURRENCY=1` unless we prove a TAC service stack can safely reset
multiple cells concurrently.

Budget guardrails are intentionally separate from env errors. A cell that exceeds
`TAC_CELL_TIMEOUT_SEC`, `TAC_CELL_MAX_TOKENS`, or
`TAC_CELL_MAX_OUTPUT_BYTES` is recorded as `status=budget_exceeded`, is not
retried, and does not count against the EnvErr rate. `TAC_CELL_MAX_TOKENS`
is enforced live when stream usage is visible and remains a posthoc classifier
for completed cells. Run-level caps stop scheduling new cells and write a
partial summary; already-running cells are allowed to finish unless they hit a
per-cell guardrail.

Useful pool controls:

| Env | Meaning |
|---|---|
| `TAC_POOL_AMI_ID` | Optional pre-baked TAC worker AMI |
| `TAC_POOL_BOOTSTRAP_TAC` | Run bootstrap user-data; defaults to `false` when `TAC_POOL_AMI_ID` is set |
| `TAC_POOL_SUBNET_ID` | Optional subnet pin; useful when matching workers to a Fast Snapshot Restore AZ |
| `TAC_POOL_DOCKER_VOLUME_ENABLED` | `1` attaches a separate Docker data EBS volume |
| `TAC_POOL_DOCKER_VOLUME_GB` | Docker data volume size, default `200` |
| `TAC_POOL_DOCKER_VOLUME_IOPS` | Docker gp3 IOPS, default `3000`, max `16000` |
| `TAC_POOL_DOCKER_VOLUME_THROUGHPUT` | Docker gp3 throughput in MiB/s, default `125`, max `1000` |
| `TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID` | Optional snapshot used to seed `/var/lib/docker` |
| `TAC_POOL_SERVICE_SLICE` | TAC services to start on workers: `full` or `gitlab`; default `full` |
| `TAC_DOCKER_SNAPSHOT_SERVICE_SLICE` | TAC services to start during Docker snapshot bake; defaults to `TAC_POOL_SERVICE_SLICE`/`full` |
| `TAC_DOCKER_SNAPSHOT_MODE` | Docker snapshot cleanup mode: `images` removes volumes, `services` preserves volumes |
| `TAC_POOL_RUN_ID` | Stable run id; set this when resuming a run |
| `TAC_POOL_RESUME` | `1` default; skip completed local cells |
| `TAC_POOL_RESULTS_S3_URI` | External S3 prefix for result uploads |
| `TAC_POOL_RESUME_FROM_S3` | Pull prior results from S3 before scheduling cells |
| `TAC_POOL_CELL_MAX_ATTEMPTS` | Env-error retry attempts per cell, default `2` |
| `TAC_POOL_WORKER_ENV_ERROR_THRESHOLD` | Consecutive env errors before worker quarantine, default `2` |
| `TAC_CELL_TIMEOUT_SEC` | Per-cell wall-clock timeout; `0`/unset disables |
| `TAC_CELL_MAX_TOKENS` | Per-cell token ceiling; live kill when available plus posthoc classification |
| `TAC_CELL_LIVE_TOKEN_KILL` | `1` default; set `0` to disable live token termination |
| `TAC_AGENT_LIVE_MAX_TOKENS` | Optional in-container live Claude token ceiling; defaults to `TAC_CELL_MAX_TOKENS` |
| `TAC_CELL_MAX_OUTPUT_BYTES` | Combined stdout/stderr byte ceiling for the child cell process |
| `TAC_CELL_MAX_STDOUT_BYTES` | Backward-compatible alias for `TAC_CELL_MAX_OUTPUT_BYTES` |
| `TAC_POOL_MAX_FINISHED_CELLS` | Stop scheduling after this many finished cell attempts |
| `TAC_POOL_MAX_COMPLETED_CELLS` | Alias for `TAC_POOL_MAX_FINISHED_CELLS` |
| `TAC_POOL_MAX_TOTAL_TOKENS` | Stop scheduling once completed cells reach this token total |
| `TAC_POOL_MAX_ENV_ERRORS` | Stop scheduling once completed cells reach this env-error count |
| `TAC_POOL_MAX_WORKERS` | Launch guardrail, default `32` |
| `TAC_POOL_MAX_RUNTIME_SEC` | Optional scheduler wall-clock cap; unset/`0` disables |
| `TAC_POOL_KEEP_WORKERS` | `1` leaves EC2 workers running |
| `TAC_POOL_VERIFY_DESTROY` | `1` default; verify cleanup after Terraform destroy |

Current E2B gate status:

- Docker template builds and can run `sudo docker run --rm hello-world`.
- The template can pull/run a TAC task image and read `/instruction/task.md`.
- Starting TAC GitLab inside the sandbox currently fails with `no space left on
  device` while extracting `ghcr.io/theagentcompany/servers-gitlab:1.0.0`.
- A larger existing team template, `e2b_gym_server_staging`, reports about 35 GB
  mounted at `/`, has Docker available via `sudo docker`, can pull
  `ghcr.io/theagentcompany/servers-gitlab:1.0.0`, and can boot the GitLab
  container to healthy status on `localhost:8929`.
- After GitLab is healthy on that larger template, only about 2.8 GB remains
  free. Treat 35-37 GB as a minimum viable GitLab-only Shape A capacity, not as
  enough headroom for full TAC or concurrent cells.
