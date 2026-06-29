# TAC EC2 Experiment Log (2026-06-21)

Status: current spike complete.

Objective: reduce TAC worker startup cost enough to run OpenTasks-vs-baseline
experiments while preserving clean TAC service state and reliable cleanup.

## Known Baseline: Image-Only Full-Stack Snapshot

Date: 2026-06-20.

Snapshot: `snap-07ca1df7ab4a5ead6`.

Configuration:

- worker: `m7i.2xlarge`
- root volume: 80 GiB gp3
- Docker volume: 200 GiB gp3
- Docker volume perf for successful run: 16000 IOPS / 1000 MiB/s
- FSR: enabled for `us-west-1a` during run, disabled afterward
- TAC services: full stack
- task: `sde-add-one-gitlab-pipeline`
- arm/model/seed: `stock` / `haiku` / `1`

Result:

- infrastructure: pass
- post-destroy verification: pass
- FSR cleanup: disabled after run
- TAC cell: completed as benchmark failure, not env error
- `S_partial`: 0.333
- tokens: 351953
- cell latency: 142s
- summary: `evals/.tac-pool-runs/tac-pool-2026-06-20T10-23-09-685061000Z/summary.md`

Finding:

- image-only snapshot avoids Docker image pulls but still spends worker startup
  time restoring all TAC service data, especially Plane.
- max gp3 materially improves Docker startup throughput.
- next useful experiment is a GitLab-only service slice, because the selected
  SDE smoke tasks depend only on GitLab.

## Experiment 1: GitLab Service Slice Snapshot

Status: complete.

Question: Can a GitLab-only service slice reduce worker ready time while still
running TAC reset/init/eval correctly for GitLab-only SDE tasks?

Planned configuration:

- `TAC_DOCKER_SNAPSHOT_SERVICE_SLICE=gitlab`
- `TAC_DOCKER_SNAPSHOT_MODE=services`
- worker run with `TAC_POOL_SERVICE_SLICE=gitlab`
- one GitLab task, one stock/haiku/seed1 cell

Pass gate:

- worker reaches GitLab healthcheck without starting Plane/OwnCloud/RocketChat
- `/utils/init.sh` can reset GitLab through the API server
- one TAC cell completes with success/failure, not env error
- default teardown removes EC2 instance, Docker EBS volume, security group, and
  generated key

### Bake Result

Command shape:

```bash
TAC_DOCKER_SNAPSHOT_MODE=services \
TAC_DOCKER_SNAPSHOT_SERVICE_SLICE=gitlab \
TAC_DOCKER_SNAPSHOT_VOLUME_GB=120 \
TAC_DOCKER_SNAPSHOT_VOLUME_IOPS=16000 \
TAC_DOCKER_SNAPSHOT_VOLUME_THROUGHPUT=1000 \
evals/tac/scripts/bake-docker-volume-snapshot.sh
```

Result:

- snapshot: `snap-0c7c6eb08119771e0`
- source instance: `i-02b1ba5cdb55bbd7e`
- source Docker volume: `vol-0f9cce674171151ae`
- snapshot size: 120 GiB
- snapshot state: completed / 100%
- cleanup: pass
- builder instance: terminated
- builder Docker volume: deleted
- builder security group/key pair: deleted

Bake-time Docker footprint:

- images: 3
- image bytes: 33.22 GiB
- containers after cleanup: 0
- preserved local volumes: 4
- preserved volume bytes: 9.189 GiB

Finding:

- GitLab slice starts only API server + GitLab and avoids full TAC service
  startup during bake.
- The GitLab image creates anonymous local volumes; preserving service volumes
  is harmless, but later worker validation must confirm whether Compose reuses
  them or creates fresh anonymous volumes.
- FSR was enabled for `snap-0c7c6eb08119771e0` in `us-west-1a` before the
  one-cell pilot.

### One-Cell Pilot Result

Command shape:

```bash
TAC_POOL_WORKER_COUNT=1 \
TAC_POOL_SERVICE_SLICE=gitlab \
TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID=snap-0c7c6eb08119771e0 \
EVAL_MODEL=haiku EVAL_ARMS=stock EVAL_REPEATS=1 EVAL_CONCURRENCY=1 \
TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=1 \
EVAL_TASKS=sde-add-one-gitlab-pipeline \
evals/tac/scripts/run-ec2-pool.sh
```

Result:

- run: `tac-pool-2026-06-21T21-29-20-651390000Z`
- worker instance: `i-086296fb4dafa1fb3`
- worker Docker volume: `vol-0d6f329229f71dbd5`
- startup: reached ready state with only API server + GitLab running
- restored Docker footprint at boot: 3 images, 0 containers, 4 local volumes
- TAC cell: completed as benchmark failure, not env error
- `S_partial`: 0.333
- tokens: 48095
- cell latency: 117s
- summary: `evals/.tac-pool-runs/tac-pool-2026-06-21T21-29-20-651390000Z/summary.md`
- cleanup: pass
- Terraform state after destroy: empty
- worker instance: terminated
- worker Docker volume/security group/key pair: deleted
- FSR cleanup: disabled after run

Finding:

- The GitLab slice is sufficient for `sde-add-one-gitlab-pipeline`.
- The env-reset path through TAC's API server works with the API server running
  in `SKIP_SETUP=True` mode against GitLab only.
- Worker readiness is now dominated by EC2 launch, Ubuntu package install,
  TAC/OpenTasks checkout/sync, Docker daemon setup, and GitLab startup. The
  prior full-stack Plane/OwnCloud/RocketChat startup cost is removed for
  GitLab-only tasks.

## Experiment 2: Fresh Worker Per GitLab Cell

Status: complete.

Question: Does the GitLab service-slice snapshot support multiple fresh workers
in one pool run without worker reuse or cross-cell service contamination?

Planned configuration:

- snapshot: `snap-0c7c6eb08119771e0`
- `TAC_POOL_WORKER_COUNT=3`
- `TAC_POOL_SERVICE_SLICE=gitlab`
- one `stock` / `haiku` / `seed1` cell per worker
- tasks:
  - `sde-add-one-gitlab-pipeline`
  - `sde-close-an-issue`
  - `sde-collect-open-issues`

Pass gate:

- all three workers reach GitLab healthcheck
- each worker receives one planned cell
- all cells finish with success/failure, not env error
- default teardown removes all EC2 instances, Docker EBS volumes, security
  groups, and generated key
- FSR is disabled after the run

### Result

Command shape:

```bash
TAC_POOL_WORKER_COUNT=3 \
TAC_POOL_SERVICE_SLICE=gitlab \
TAC_POOL_DOCKER_VOLUME_SNAPSHOT_ID=snap-0c7c6eb08119771e0 \
EVAL_MODEL=haiku EVAL_ARMS=stock EVAL_REPEATS=1 EVAL_CONCURRENCY=1 \
TAC_ROLE=sde TAC_DEPS=gitlab \
EVAL_TASKS=sde-add-one-gitlab-pipeline,sde-close-an-issue,sde-collect-open-issues \
evals/tac/scripts/run-ec2-pool.sh
```

Run:

- run: `tac-pool-2026-06-21T21-44-06-806984000Z`
- worker instances:
  - `i-070164cf53f263c5c`
  - `i-021f3099650094b87`
  - `i-00cdba34ec085bea9`
- worker Docker volumes:
  - `vol-091203a8dcb9dbcfe`
  - `vol-09064a797313c128f`
  - `vol-050813797d98746af`
- security group: `sg-02f70dfcce2e1779c`
- generated key pair:
  `opentasks-tac-gitlab-3worker-pilot-20260621-key`
- FSR: enabled for the run, then disabled afterward

Aggregate result:

- cells: 3
- unstarted cells: 0
- quarantined workers: 0
- EnvErr: 0
- success: 33.3%
- `S_partial`: 0.444
- tokens: 5323972
- p50 latency: 128s
- summary: `evals/.tac-pool-runs/tac-pool-2026-06-21T21-44-06-806984000Z/summary.md`

Per-cell result:

| Task | Worker | Status | S_partial | Full | EnvErr | Tokens | Latency |
|---|---|---:|---:|---:|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | `opentasks-tac-gitlab-3worker-pilot-20260621-0` | failure | 0.333 | false | 0 | 172593 | 128s |
| `sde-close-an-issue` | `opentasks-tac-gitlab-3worker-pilot-20260621-1` | failure | 0.000 | false | 0 | 4935549 | 452s |
| `sde-collect-open-issues` | `opentasks-tac-gitlab-3worker-pilot-20260621-2` | success | 1.000 | true | 0 | 215830 | 114s |

Cleanup:

- Terraform state after destroy: empty
- worker instances: terminated
- worker Docker volumes: deleted
- security group/key pair: deleted
- FSR state: disabled

## Debug: OpenTasks GitLab Pipeline Failure

Date: 2026-06-22.

Status: root cause identified.

Question: Why did the `opentasks` arm fail `sde-add-one-gitlab-pipeline`
after the OpenTasks runtime sync fix?

Debug run:

- run: `tac-pool-2026-06-22T21-05-02-139869000Z`
- task: `sde-add-one-gitlab-pipeline`
- arm/model/seed: `opentasks` / `haiku` / `1`
- worker instance: `i-03b3fc14f5872afa9`
- worker Docker volume: `vol-0c49cfce5bc8ea8be`
- security group: `sg-052b367a628a5d8cc`
- raw stream:
  `evals/.tac-pool-runs/tac-pool-2026-06-22T21-05-02-139869000Z/cells/sde-add-one-gitlab-pipeline__opentasks__haiku__seed1/agent-stream.jsonl`

Result:

- TAC status: benchmark failure, not env error
- `S_partial`: 0.333
- tokens: 48718
- checkpoints:
  - `checkpoint-1`: failed
  - `checkpoint-2`: passed
- metrics in this short debug rerun:
  - `readGraph=0`
  - `mcpServersConnected=0`

Observed trajectory:

- the agent read `/instruction/task.md`
- the task text instructed it to navigate to
  `http://the-agent-company.com:8929/root/api-server/-/ci/editor?branch_name=main`
- the agent responded that it could not directly open web browsers or access
  external URLs and asked for clarification
- no Bash, GitLab API, Git operations, or OpenTasks MCP tools were used

Evaluator caveat:

- TAC task text points at `root/api-server`
- the checkpoint/evaluator expects trajectory text containing
  `root/openhands/-/ci/editor`
- checkpoint 1 is a raw trajectory substring check, not a functional GitLab
  state check
- checkpoint 2 only checks whether the `root/openhands` project has any
  pipeline data, so a pass is not strong evidence that the agent configured a
  pipeline during the run

Finding:

- this failure is primarily a TAC adapter/scaffold prompt failure, not an
  OpenTasks graph-runtime failure
- the agent stopped before doing meaningful work because the TAC prompt shape
  looked browser-only to a CLI agent
- the task/evaluator URL mismatch makes this task fragile for benchmark
  interpretation, especially when comparing arms by partial score

Follow-up:

- capture raw agent stdout/stderr for every TAC cell when `EVAL_OUT_DIR` is
  available, so future TAC failures can be diagnosed from the exact stream
- add TAC-specific operating guidance to the scaffold: use Bash/curl/python or
  GitLab API against TAC service URLs, do not ask for clarification in benchmark
  tasks, and treat "navigate to URL" as an instruction to interact with the
  service from the CLI when no browser is available
- treat `sde-add-one-gitlab-pipeline` scores as noisy until the task URL and
  evaluator URL mismatch is either understood, patched upstream, or handled by
  a benchmark-level normalization policy

Cleanup:

- Terraform state after destroy: empty
- worker instance: terminated
- worker Docker volume/security group/key pair: deleted
- FSR state: disabled

Finding:

- The GitLab slice supports multiple concurrent fresh workers and one-cell
  sharding through the existing swarmkit-eval pool flow.
- The experiment passed the infrastructure gate: no env errors, no worker
  quarantine, and teardown verification succeeded.
- `sde-close-an-issue` produced a very large token count and long latency even
  though the environment remained healthy. That is a benchmark/agent behavior
  signal rather than an EC2 backend failure, and should be included in the next
  optimization pass.

## Follow-Up: Token/Runtime Guardrails

Date: 2026-06-22.

Status: implemented and locally verified.

Implemented controls:

- `TAC_CELL_TIMEOUT_SEC`: kills an active cell process after a per-cell
  wall-clock budget.
- `TAC_CELL_MAX_TOKENS`: enforces a live cell token kill when stream usage is
  visible and marks completed cells as over budget when reported token use
  exceeds the configured ceiling.
- `TAC_CELL_LIVE_TOKEN_KILL`: enabled by default; disables live termination
  when set to `0`.
- `TAC_AGENT_LIVE_MAX_TOKENS`: optional in-container live Claude token ceiling;
  defaults to `TAC_CELL_MAX_TOKENS`.
- `TAC_CELL_MAX_OUTPUT_BYTES`: kills a noisy child cell process when combined
  stdout/stderr exceeds the configured byte ceiling.
- `TAC_POOL_MAX_FINISHED_CELLS` / `TAC_POOL_MAX_COMPLETED_CELLS`: stops
  scheduling new cells after a run-level finished-cell count.
- `TAC_POOL_MAX_TOTAL_TOKENS`: stops scheduling new cells after completed cells
  reach a run-level token budget.
- `TAC_POOL_MAX_ENV_ERRORS`: stops scheduling new cells after completed cells
  reach a run-level env-error budget.

Semantics:

- budgeted cells are terminal `status=budget_exceeded`
- budgeted cells are not retried
- budgeted cells do not count as EnvErr
- run-level caps stop scheduling new cells and write a partial summary

Verification:

- `npx vitest run src/__tests__/tac-pool-guardrails.test.ts`: pass
- covered timeout kill, token ceiling, output byte ceiling, and run-level token
  stop behavior using the fake TAC adapter

## Experiment 3: GitLab-Only Arm Comparison Mini Run

Date: 2026-06-22.

Status: complete, with one infrastructure issue found and fixed.

Question: Can the GitLab-only service-slice pool run a small arm comparison
across `stock`, `notes`, and `opentasks` with fresh-worker isolation?

Configuration:

- snapshot: `snap-0c7c6eb08119771e0`
- FSR AZ: `us-west-1a`
- subnet: `subnet-03737c8747ed61d61`
- `TAC_POOL_WORKER_COUNT=6`
- `TAC_POOL_SERVICE_SLICE=gitlab`
- `TAC_POOL_INSTANCE_TYPE=m7i.2xlarge`
- `TAC_POOL_DOCKER_VOLUME_GB=120`
- `TAC_POOL_DOCKER_VOLUME_IOPS=16000`
- `TAC_POOL_DOCKER_VOLUME_THROUGHPUT=1000`
- `TAC_POOL_SYNC_OPENTASKS=1`
- `TAC_POOL_FAIL_ON_ENV_ERROR=0`
- `TAC_CELL_TIMEOUT_SEC=900`
- `TAC_CELL_MAX_TOKENS=1500000`
- `TAC_CELL_MAX_OUTPUT_BYTES=100000000`
- `EVAL_MODEL=haiku`
- `EVAL_ARMS=stock,notes,opentasks`
- `EVAL_REPEATS=1`
- tasks:
  - `sde-add-one-gitlab-pipeline`
  - `sde-collect-open-issues`

Run:

- run: `tac-pool-2026-06-22T19-43-02-629550000Z`
- cells: 6
- unstarted cells: 0
- quarantined workers: 0
- stop reason: none
- summary:
  `evals/.tac-pool-runs/tac-pool-2026-06-22T19-43-02-629550000Z/summary.md`

Aggregate result:

| Arm | Model | n | Success | S_partial | EnvErr | Budget | Tokens | p50 latency |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| `notes` | `haiku` | 2 | 0.0% | 0.333 | 0 | 0 | 594332 | 120s |
| `opentasks` | `haiku` | 2 | 0.0% | 0.000 | 2 | 0 | 0 | 110s |
| `stock` | `haiku` | 2 | 0.0% | 0.083 | 0 | 1 | 3143131 | 125s |

Per-cell result:

| Task | Arm | Status | S_partial | Full | EnvErr | Budget | Tokens | Latency |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | `notes` | failure | 0.333 | false | 0 | 0 | 171501 | 119s |
| `sde-add-one-gitlab-pipeline` | `opentasks` | env_error | 0.000 | false | crash | 0 | 0 | 110s |
| `sde-add-one-gitlab-pipeline` | `stock` | budget_exceeded | 0.000 | false | 0 | tokens | 2886075 | 296s |
| `sde-collect-open-issues` | `notes` | failure | 0.333 | false | 0 | 0 | 422831 | 148s |
| `sde-collect-open-issues` | `opentasks` | env_error | 0.000 | false | crash | 0 | 0 | 112s |
| `sde-collect-open-issues` | `stock` | failure | 0.167 | false | 0 | 0 | 257056 | 125s |

Finding:

- Fresh-worker GitLab-only pool orchestration worked: all workers reached
  readiness, all cells finished, Terraform destroyed the pool, and FSR was
  disabled after the run.
- Both `opentasks` cells failed before agent execution with
  `Cannot find module '/opentasks/dist/cli.js'`.
- Root cause: `evals/tac/scripts/sync-opentasks-ec2.sh` ran `ssh` without
  `-n`. When called from `run-ec2-pool.sh` inside `while read ip`, the first
  SSH command consumed the remaining worker IPs from stdin, so only worker 0
  received the OpenTasks runtime. The `opentasks` cells were scheduled on
  workers 2 and 5.
- Fix: make the sync helper's SSH command non-interactive with `ssh -n`.
- One `stock` cell exceeded the posthoc token ceiling. This confirms the
  posthoc token guardrail works, but it does not prevent token spend inside a
  live Claude run.

Cleanup:

- Terraform state after destroy: empty
- worker instances: terminated
- worker Docker volumes: deleted
- security group/key pair: deleted
- FSR state: disabled

## Experiment 4: GitLab-Only OpenTasks Rerun After Sync Fix

Date: 2026-06-22.

Status: complete.

Question: After fixing EC2 OpenTasks sync, do the two `opentasks` GitLab cells
initialize, connect MCP, and produce benchmark results?

Configuration:

- snapshot: `snap-0c7c6eb08119771e0`
- FSR AZ: `us-west-1a`
- subnet: `subnet-03737c8747ed61d61`
- `TAC_POOL_WORKER_COUNT=2`
- `TAC_POOL_SERVICE_SLICE=gitlab`
- `TAC_POOL_INSTANCE_TYPE=m7i.2xlarge`
- `TAC_POOL_DOCKER_VOLUME_GB=120`
- `TAC_POOL_SYNC_OPENTASKS=1`
- `TAC_POOL_FAIL_ON_ENV_ERROR=0`
- `TAC_CELL_TIMEOUT_SEC=900`
- `TAC_CELL_MAX_TOKENS=1500000`
- `EVAL_MODEL=haiku`
- `EVAL_ARMS=opentasks`
- `EVAL_REPEATS=1`
- tasks:
  - `sde-add-one-gitlab-pipeline`
  - `sde-collect-open-issues`

Run:

- run: `tac-pool-2026-06-22T20-02-22-763945000Z`
- worker instances:
  - `i-0ca7e40d78ef08155`
  - `i-00650368b39e4332b`
- worker Docker volumes:
  - `vol-02498981c8302ff38`
  - `vol-08b15bec6e7469514`
- security group: `sg-01373200731e26a13`
- generated key pair:
  `opentasks-tac-gitlab-opentasks-rerun-20260622-key`
- summary:
  `evals/.tac-pool-runs/tac-pool-2026-06-22T20-02-22-763945000Z/summary.md`

Aggregate result:

| Arm | Model | n | Success | S_partial | EnvErr | Budget | Tokens | p50 latency | Metrics |
|---|---|--:|--:|--:|--:|--:|--:|--:|---|
| `opentasks` | `haiku` | 2 | 50.0% | 0.667 | 0 | 0 | 322176 | 108s | `readGraph=1.00`, `mcpServersConnected=1.00` |

Per-cell result:

| Task | Status | S_partial | Full | EnvErr | Budget | Tokens | Latency | readGraph | mcpServersConnected |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | failure | 0.333 | false | 0 | 0 | 49009 | 107s | 1 | 1 |
| `sde-collect-open-issues` | success | 1.000 | true | 0 | 0 | 273167 | 130s | 1 | 1 |

Finding:

- The OpenTasks runtime sync issue is fixed. Both workers printed
  `opentasks runtime ok` before the pool runner started.
- Both `opentasks` cells initialized successfully and connected the OpenTasks
  MCP server.
- `sde-collect-open-issues` is a useful positive signal: the `opentasks` arm
  reached full TAC score on the same task where the earlier mini run's
  `stock` arm scored 0.167 and `notes` scored 0.333.
- The failure mode for full scaling is no longer OpenTasks runtime sync. The
  remaining scaling concern is token spend control during live Claude runs,
  because `TAC_CELL_MAX_TOKENS` is currently posthoc.

Cleanup:

- Terraform state after destroy: empty
- worker instances: terminated
- worker Docker volumes: deleted
- security group/key pair: deleted
- FSR state: disabled

## Experiment 5: Shared TAC Operating Prompt on Pipeline Task

Date: 2026-06-22.

Status: complete, but task remains noisy.

Question: Does a shared TAC CLI/service operating prompt prevent CLI agents
from stopping on browser-shaped GitLab instructions?

Implementation:

- added a shared TAC prompt in `TacDockerAdapter`
- applied it equally to `stock`, `notes`, and `opentasks`
- kept arm-specific state scaffolds separate
- added `TAC_OPERATING_PROMPT=0` for ablations
- added `TAC_AGENT_PROMPT_APPENDIX` for experiment-wide additions
- added raw stream redaction for common auth env vars before artifact capture

Local verification:

- `npm run build`: pass
- `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`: pass
- `bash -n evals/tac/scripts/run-ec2-pool.sh && bash -n evals/tac/scripts/sync-opentasks-ec2.sh`: pass
- `terraform -chdir=infra/tac-ec2-pool fmt -check && terraform -chdir=infra/tac-ec2-pool validate`: pass

Invalid auth run:

- run: `tac-pool-2026-06-22T22-08-39-247029000Z`
- arms: `stock`, `notes`, `opentasks`
- result: all three cells were `env_error`
- root cause: launch env omitted `CLAUDE_CODE_USE_BEDROCK=1` and
  `AWS_REGION=us-west-2`; each `claude` invocation returned "Not logged in"
- cleanup: pass

Corrected configuration:

- run: `tac-pool-2026-06-22T22-24-25-977526000Z`
- snapshot: `snap-0c7c6eb08119771e0`
- FSR AZ: `us-west-1a`
- subnet: `subnet-03737c8747ed61d61`
- `CLAUDE_CODE_USE_BEDROCK=1`
- `AWS_REGION=us-west-2`
- `TAC_POOL_WORKER_COUNT=3`
- `TAC_POOL_SERVICE_SLICE=gitlab`
- `TAC_POOL_INSTANCE_TYPE=m7i.2xlarge`
- `TAC_POOL_DOCKER_VOLUME_GB=120`
- `TAC_POOL_DOCKER_VOLUME_IOPS=16000`
- `TAC_POOL_DOCKER_VOLUME_THROUGHPUT=1000`
- `TAC_POOL_SYNC_OPENTASKS=1`
- `TAC_CELL_TIMEOUT_SEC=900`
- `TAC_CELL_MAX_TOKENS=1500000`
- `EVAL_MODEL=haiku`
- `EVAL_ARMS=stock,notes,opentasks`
- task: `sde-add-one-gitlab-pipeline`

Run:

- worker instances:
  - `i-0544585e579f39f79`
  - `i-0f12161c249ca7e6b`
  - `i-0862adbaca44464aa`
- worker Docker volumes:
  - `vol-097ea39b484a79df6`
  - `vol-0880e65231a8783e1`
  - `vol-03be9cff0f4fac399`
- security group: `sg-0506efca53a835bf8`
- generated key pair:
  `opentasks-tac-tacprompt-pipeline-auth-20260622-key`
- summary:
  `evals/.tac-pool-runs/tac-pool-2026-06-22T22-24-25-977526000Z/summary.md`

Per-cell result:

| Task | Arm | Pool status | Raw TAC status | Original S_partial | Full | Budget | Tokens | Latency | readGraph | mcpServersConnected |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | `stock` | `budget_exceeded` | failure | 0.333 | false | tokens | 1519066 | 228s | 0 | 0 |
| `sde-add-one-gitlab-pipeline` | `opentasks` | `budget_exceeded` | failure | 0.333 | false | tokens | 3271218 | 312s | 0 | 0 |
| `sde-add-one-gitlab-pipeline` | `notes` | `budget_exceeded` | failure | 0.333 | false | tokens | 5987664 | 439s | 0 | 0 |

Checkpoint result:

- all three raw TAC reports earned 2/3
- checkpoint 1 failed for all arms
- checkpoint 2 passed for all arms
- the pool correctly marked all three cells as `budget_exceeded` because they
  exceeded the 1.5M token ceiling after completion

Finding:

- the shared TAC prompt fixed the earlier browser-stop behavior. Raw streams now
  show agents reading the task, then using `curl`, `git clone`, GitLab HTTP/API
  calls, and local git commands instead of asking for clarification.
- the remaining failure is not the same failure mode. Agents followed the task
  URL and worked on `root/api-server`, while the evaluator still checks for
  `root/openhands/-/ci/editor` in the trajectory.
- this reinforces that `sde-add-one-gitlab-pipeline` is a noisy comparison task
  unless the task/evaluator URL mismatch is handled uniformly.
- OpenTasks did not provide a useful graph signal in this run: the raw stream
  showed the MCP server as pending and `mcpServersConnected=0`.
- token spend is now the main blocker. The posthoc token guardrail correctly
  marks cells over budget, but it does not prevent live spend.

Cleanup:

- Terraform state after destroy: empty
- worker instances: terminated
- worker Docker volumes/security group/key pair: deleted
- FSR state: disabled

## Debug: OpenTasks MCP Discoverability

Date: 2026-06-22.

Status: local diagnosis complete; next remote TAC cell should verify the
container path.

Question: Why did the OpenTasks arm in Experiment 5 have
`mcpServersConnected=0` and no graph reads?

Observed in Experiment 5:

- the raw Claude init event for the OpenTasks cell had
  `mcp_servers=[{"name":"opentasks","status":"pending"}]`
- the init tool list did not include any `mcp__opentasks__*` tools
- therefore the agent could not use the graph, regardless of task behavior

Local checks:

- direct MCP SDK stdio probe against `node dist/cli.js mcp --scope all`: pass
  - listed 22 OpenTasks tools
  - `list_tasks` call worked when pointed at an initialized `.opentasks`
- Claude Code smoke with equivalent local MCP config: pass
  - init showed `opentasks` as `connected`
  - init tool list included `mcp__opentasks__list_tasks`
- Claude Code project skill smoke: pass
  - a workspace-local `.claude/skills/opentasks/SKILL.md` appears in the init
    skill list as `opentasks`

Implementation changes:

- pinned the OpenTasks MCP server to the TAC workspace graph with
  `OPENTASKS_PROJECT_DIR=/workspace/.opentasks`
- propagated the same env var into the agent process
- added an OpenTasks MCP preflight script:
  `evals/tac/scripts/check-opentasks-mcp.mjs`
  - starts an MCP stdio client
  - lists tools
  - verifies required tools: `create_task`, `list_tasks`, `record_attempt`,
    `query`
  - calls `list_tasks` to confirm daemon connectivity
  - writes `opentasks-mcp-preflight.json`
- adapter now fails the OpenTasks cell before model spend if preflight fails
- added `TAC_OPENTASKS_MCP_PREFLIGHT=0` to disable that fail-fast check for
  ablations
- installed a TAC-local Claude project skill for the OpenTasks arm at
  `.claude/skills/opentasks/SKILL.md`
- added `Skill` to the OpenTasks arm allowlist so that project skill can be
  loaded explicitly
- strengthened the OpenTasks arm prompt to say:
  - use the `opentasks` skill before task-specific Bash work
  - make a native OpenTasks MCP tool call early
  - do not invoke `mcp__opentasks__*` names as shell commands

Validation:

- `npm run build`: pass
- `node evals/tac/scripts/check-opentasks-mcp.mjs ...`: pass against an
  initialized local `.opentasks`
- `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`:
  pass
- `bash -n evals/tac/scripts/run-ec2-pool.sh && bash -n evals/tac/scripts/sync-opentasks-ec2.sh && bash -n evals/tac/scripts/bake-docker-volume-snapshot.sh`:
  pass

Remaining verification:

- run one remote GitLab-only OpenTasks cell and inspect:
  - `opentasks-mcp-preflight.json` exists and `ok=true`
  - raw init has `mcp_servers[opentasks].status=connected`
  - raw init includes `opentasks` in the skills list
  - trajectory includes at least one real `mcp__opentasks__*` tool call

Follow-up remote smoke:

- run: `tac-mcp-smoke-2026-06-22T23-27-23Z`
- configuration: one EC2 worker, GitLab service slice, one
  `sde-add-one-gitlab-pipeline` OpenTasks/haiku/seed1 cell
- infrastructure cleanup: pass
- result: expected fail-fast env error before Claude spend (`tokens=0`)
- cause: EC2 sync only copied `dist/` and runtime dependencies, so the TAC
  task container could not find
  `/opentasks/evals/tac/scripts/check-opentasks-mcp.mjs`
- fix: `evals/tac/scripts/sync-opentasks-ec2.sh` now syncs the preflight helper
  into the remote OpenTasks mount
- second smoke: `tac-mcp-smoke-2026-06-22T23-35-27Z`
  - result: sync failed before eval because the remote
    `evals/tac/scripts` directory did not exist
  - cleanup: pass
  - fix: sync now creates `$remote_dir/evals/tac/scripts` before rsyncing the
    helper
- third smoke: `tac-mcp-smoke-2026-06-22T23-40-49Z`
  - result: full TAC flow completed with no env error; pool marked
    `budget_exceeded` because 2,706,746 tokens exceeded the 1,500,000-token
    posthoc ceiling
  - raw TAC score before budget override: 2/3, original `S_partial=0.333`
  - project skill discoverability: pass (`opentasks` appeared in Claude's init
    skill list)
  - MCP connection: still failed (`mcp_servers[opentasks].status=pending`,
    zero `mcp__opentasks__*` tools)
  - artifact capture gap: the MCP preflight report was written under `.tac/`
    but not copied into the cell artifact directory
  - security issue found and remediated locally: the raw stream contained an
    agent-printed Bedrock bearer token before redaction caught it; local
    artifacts were redacted and the redaction patterns were tightened
  - next fix: launch the MCP server through `sh -lc` so it inherits the agent
    process environment while explicitly exporting
    `OPENTASKS_PROJECT_DIR=/workspace/.opentasks`; also copy
    `opentasks-mcp-preflight.json` into the cell artifacts
- fourth smoke: `tac-mcp-smoke-2026-06-22T23-52-43Z`
  - configuration: MCP-only prompt appendix, 500k posthoc token ceiling,
    shell-wrapper MCP config
  - infrastructure cleanup: pass
  - preflight: pass
    - `opentasks-mcp-preflight.json` captured in the cell artifacts
    - listed 22 tools in 220 ms
    - `list_tasks` returned without `isError`
  - Claude project skill discoverability: pass (`opentasks` in init skills)
  - Claude MCP discovery: still fail
    - init reported `mcp_servers=[{"name":"opentasks","status":"pending"}]`
    - init had zero `mcp__opentasks__*` tools
    - the model attempted `ToolSearch` for `mcp__opentasks__list_tasks`,
      then fell back to Bash/simulated calls because the native MCP tool was
      not registered
  - result: no env error; 179,260 tokens; raw TAC `S_partial=0.333`
  - interpretation: the OpenTasks server and task-container preflight are
    healthy; the remaining failure is specific to Claude Code's MCP server
    startup/registration path inside the TAC container

### OpenTasks MCP Debug Follow-Up

- implementation changes:
  - generated a per-cell `opentasks-mcp-wrapper.sh` and captured
    `opentasks-mcp-wrapper.log`
  - added a Claude-only MCP smoke before the expensive TAC task
  - added fail-fast behavior for OpenTasks cells when the Claude smoke cannot
    execute a native `mcp__opentasks__*` tool
  - added debug toggles:
    - `TAC_OPENTASKS_CLAUDE_MCP_SMOKE`
    - `TAC_OPENTASKS_CLAUDE_MCP_SMOKE_FAIL_FAST`
    - `TAC_OPENTASKS_MCP_COMMAND=wrapper|sh-lc|direct`
    - `TAC_STRICT_MCP_CONFIG=0`
    - `TAC_ALLOWED_TOOLS=0`
- local verification:
  - `npm run build`: pass
  - `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`:
    pass

Live debug runs:

- run: `tac-mcp-debug-2026-06-23T00-14-38Z`
  - result: fail-fast before model use (`tokens=0`)
  - SDK preflight: pass (`22` tools, `list_tasks` succeeded)
  - wrapper log: pass; Claude launched `/bin/bash /eval/.../opentasks-mcp-wrapper.sh`
    as `agent`, with `node=/usr/bin/node` and
    `OPENTASKS_PROJECT_DIR=/workspace/.opentasks`
  - Claude result: auth setup error (`Not logged in`) because the run did not
    set `CLAUDE_CODE_USE_BEDROCK=1` / `AWS_REGION`
  - cleanup: pass
- run: `tac-mcp-debug-bedrock-2026-06-23T00-23-26Z`
  - configuration: same one-cell OpenTasks smoke with Bedrock mode enabled
  - SDK preflight: pass (`22` tools, `list_tasks` succeeded)
  - wrapper log: pass
  - Claude init still reported `mcp_servers=[{"name":"opentasks","status":"pending"}]`
    and listed zero `mcp__opentasks__*` tools
  - important finding: despite init `pending`, Claude used `ToolSearch` for
    `select:mcp__opentasks__list_tasks`, then successfully executed native
    `mcp__opentasks__list_tasks`; the tool result returned an empty task list
  - adapter correction: treat successful native `mcp__opentasks__*` execution
    as the MCP success signal, rather than requiring init status `connected`
  - prompt/skill correction: tell the OpenTasks arm to use `ToolSearch` when
    tools are pending/not yet visible, and not to echo or simulate MCP tool
    names in Bash
  - cleanup: pass

### OpenTasks GitLab Pilot

- run: `tac-opentasks-gitlab-pilot-2026-06-23T01-51-12Z`
- configuration:
  - one EC2 worker
  - GitLab service slice
  - one `sde-add-one-gitlab-pipeline` OpenTasks/haiku/seed1 cell
  - Claude MCP smoke enabled with fail-fast
  - `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION=us-west-2`
- infrastructure:
  - worker reached ready state
  - OpenTasks runtime sync succeeded
  - Terraform cleanup and post-destroy verification passed
- OpenTasks machinery:
  - SDK preflight passed: `22` tools, `list_tasks` succeeded
  - Claude MCP smoke passed:
    - init still reported `opentasks` as `pending`
    - native `mcp__opentasks__list_tasks` executed successfully after
      `ToolSearch`
  - actual task-agent OpenTasks usage failed:
    - actual agent init again reported `opentasks` as `pending`
    - actual agent tool counts: `Bash=75`, `Read=8`, `Write=1`
    - actual agent made no `Skill`, `ToolSearch`, or `mcp__opentasks__*` calls
  - scoring metrics therefore stayed `readGraph=0`, `mcpServersConnected=0`
- TAC result:
  - status: `failure` (not env error)
  - `S_partial=0.333`
  - checkpoints: `2/3` earned; checkpoint 1 failed, checkpoint 2 passed
  - duration: `367s`
  - tokens: `3,432,682`
- interpretation:
  - the benchmark pipeline, EC2 cleanup, OpenTasks server, and Claude MCP
    smoke are working end-to-end
  - the remaining benchmark problem is agent behavior during the real TAC task:
    the prompt/skill nudge is insufficient for haiku to use OpenTasks once it
    starts task work
  - next optimization should force or scaffold an initial real-task OpenTasks
    call after the smoke, or split the run into a short mandatory planning
    prelude that creates/records the task graph before the open-ended TAC work
    begins

### OpenTasks Mandatory Prelude Pilot

- implementation changes:
  - added `TAC_OPENTASKS_TASK_PRELUDE` and
    `TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST`
  - prelude runs after SDK preflight and Claude MCP smoke, before the main TAC
    agent
  - prelude allows only `Read`, `Skill`, `ToolSearch`, and OpenTasks MCP tools
  - prelude must call native `create_task`, `record_attempt`, and `list_tasks`
  - prelude output is written to `opentasks-task-prelude-summary.txt` and
    embedded into the main agent prompt
  - prelude usage and trajectory are counted in the benchmark run
- local verification:
  - `npm run build`: pass
  - `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`:
    pass
- live run: `tac-opentasks-prelude-pilot-2026-06-23T02-47-26Z`
- configuration:
  - one EC2 worker
  - GitLab service slice
  - one `sde-add-one-gitlab-pipeline` OpenTasks/haiku/seed1 cell
  - Claude MCP smoke enabled
  - mandatory task prelude enabled
- infrastructure:
  - worker reached ready state
  - OpenTasks runtime sync succeeded
  - Terraform cleanup and post-destroy verification passed
- OpenTasks machinery:
  - SDK preflight passed
  - prelude passed:
    - called `mcp__opentasks__create_task` twice
    - called `mcp__opentasks__record_attempt` twice
    - called `mcp__opentasks__list_tasks` once
    - summary recorded task `t-66ek` and attempt `a-3hev`
  - main task agent now used OpenTasks:
    - `ToolSearch=2`
    - `mcp__opentasks__list_tasks=1`
    - `mcp__opentasks__record_attempt=1`
    - `mcp__opentasks__update_task=2`
  - scoring metric changed from `readGraph=0` to `readGraph=1`
- TAC result:
  - status: `failure` (not env error)
  - `S_partial=0.333`
  - checkpoints: `2/3` earned; checkpoint 1 failed, checkpoint 2 passed
  - duration: `336s`
  - tokens: `2,287,369`
- interpretation:
  - mandatory prelude fixed the OpenTasks adoption problem for this haiku run:
    the real task agent used OpenTasks tools instead of only Bash/Read
  - TAC score did not improve on this task; remaining failure appears tied to
    task completion semantics rather than OpenTasks availability
  - token use was lower than the prior no-prelude pilot (`2.29M` vs `3.43M`),
    but this is a one-cell signal and needs repeats before treating it as an
    efficiency improvement

### GitLab 3-Arm 2-Task Pool Run

- run: `tac-gitlab-3arm-2task-2026-06-23T03-07-37Z`
- configuration:
  - three EC2 workers
  - GitLab service slice
  - `m7i.2xlarge` workers with dedicated Docker gp3 volumes from snapshot
    `snap-0c7c6eb08119771e0`
  - arms: `stock`, `notes`, `opentasks`
  - model: `haiku`
  - seed: `1`
  - tasks:
    - `sde-add-one-gitlab-pipeline`
    - `sde-add-wiki-page`
  - Claude MCP smoke and mandatory OpenTasks task prelude enabled for the
    OpenTasks arm
- infrastructure:
  - all three workers bootstrapped successfully
  - OpenTasks runtime sync/build succeeded on all workers
  - all six cells were scheduled and reached a terminal state
  - pool summary reported no unstarted cells, no worker quarantines, and no
    stop reason
  - default cleanup succeeded; Terraform post-destroy verification passed
  - local Terraform state after the run contained `0` resources
  - artifact secret scan for Bedrock/Claude token patterns passed
- results:

| Task | Arm | Status | S_partial | Tokens | Duration | Notes |
|---|---|---:|---:|---:|---:|---|
| `sde-add-one-gitlab-pipeline` | `stock` | failure | 0.333 | 3,352,339 | 362s | earned 2/3 |
| `sde-add-one-gitlab-pipeline` | `notes` | failure | 0.333 | 1,818,139 | 242s | earned 2/3 |
| `sde-add-one-gitlab-pipeline` | `opentasks` | failure | 0.333 | 1,750,919 | 278s | earned 2/3; `readGraph=1` |
| `sde-add-wiki-page` | `stock` | failure | 0.125 | 2,649,596 | 315s | earned 1/4 |
| `sde-add-wiki-page` | `notes` | failure | 0.125 | 2,905,714 | 336s | earned 1/4 |
| `sde-add-wiki-page` | `opentasks` | env_error | 0.000 | 0 | 393s | prelude timeout |

- aggregate summary:
  - `stock`: `n=2`, success `0%`, mean `S_partial=0.229`,
    tokens `6,001,935`, env errors `0`
  - `notes`: `n=2`, success `0%`, mean `S_partial=0.229`,
    tokens `4,723,853`, env errors `0`
  - `opentasks`: `n=2`, success `0%`, mean `S_partial=0.167`,
    tokens `1,750,919`, env errors `1`
- OpenTasks machinery:
  - `sde-add-one-gitlab-pipeline` OpenTasks cell:
    - prelude passed
    - prelude native calls: `create_task`, `create_task`, `record_attempt`,
      `list_tasks`
    - main agent native calls: `list_tasks`, `update_task`, `update_task`
    - main agent tool counts: `Bash=37`, `Read=1`, `ToolSearch=1`,
      `mcp__opentasks__list_tasks=1`,
      `mcp__opentasks__update_task=2`
  - `sde-add-wiki-page` OpenTasks cell:
    - SDK preflight passed
    - Claude MCP smoke passed and executed native `mcp__opentasks__list_tasks`
      via `ToolSearch`
    - mandatory prelude timed out before model/tool progress beyond the init
      event
    - missing required calls: `create_task`, `record_attempt`, `list_tasks`
    - cell was marked `env_error=crash` with message
      `OpenTasks task prelude failed: OpenTasks task prelude timed out`
- interpretation:
  - the EC2 pool, multiplexing, artifact collection, cleanup, and guardrails are
    working for a larger bounded run
  - OpenTasks adoption works when the mandatory prelude completes, and the main
    agent then continues to use native OpenTasks tools
  - the current fail-fast prelude policy is too brittle for larger runs: one
    prelude timeout removes the OpenTasks cell from scored comparison
  - next implementation step should make prelude timeout handling more
    benchmark-friendly, for example by increasing/instrumenting the prelude
    timeout, retrying the prelude once when only an init event is observed, or
    allowing the main cell to proceed with a degraded diagnostic flag instead
    of converting the whole cell into an env error

### Prelude Robustness Patch

- implementation changes:
  - added a retry loop for OpenTasks task prelude attempts
  - default behavior now retries once when the failed prelude timed out after
    only a Claude `init` event, with no assistant, tool, or result events
  - added per-attempt artifacts:
    - `opentasks-task-prelude-attempt-N.jsonl`
    - `opentasks-task-prelude-attempt-N-stderr.log`
    - `opentasks-task-prelude-attempt-N-report.json`
  - canonical `opentasks-task-prelude-report.json` now aggregates retry usage
    and trajectory while retaining compact per-attempt diagnostics
  - prelude reports now include stream event counts and explicit
    `initOnly` / `initOnlyTimeout` fields
  - added `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=fail-fast|degrade`; this
    overrides the legacy `TAC_OPENTASKS_TASK_PRELUDE_FAIL_FAST=0` switch
  - added `TAC_OPENTASKS_TASK_PRELUDE_RETRIES`
  - added `TAC_OPENTASKS_TASK_PRELUDE_TIMEOUT_MS`
  - degraded continuation prompt no longer claims the task graph was
    initialized; it instructs the main agent to attempt OpenTasks setup itself
    before falling back to normal TAC execution
- local verification:
  - `npx vitest run src/__tests__/tac-docker-adapter.test.ts`: pass
  - `npm run build`: pass
  - `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`:
    pass
- recommended next run settings:
  - keep smoke fail-fast enabled
  - use `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=degrade` for comparison runs
    where we want OpenTasks failures to remain scored TAC attempts
  - keep `TAC_OPENTASKS_TASK_PRELUDE_RETRIES=1` initially; increase only if
    init-only timeouts remain common

### GitLab 3-Arm 2-Task Degraded Prelude Run

- run: `tac-gitlab-3arm-2task-degrade-2026-06-23T03-50-53Z`
- configuration:
  - same task/arm/model/seed shape as
    `tac-gitlab-3arm-2task-2026-06-23T03-07-37Z`
  - three EC2 workers
  - GitLab service slice
  - arms: `stock`, `notes`, `opentasks`
  - model: `haiku`
  - seed: `1`
  - tasks:
    - `sde-add-one-gitlab-pipeline`
    - `sde-add-wiki-page`
  - `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=degrade`
  - `TAC_OPENTASKS_TASK_PRELUDE_RETRIES=1`
- infrastructure:
  - all three workers bootstrapped successfully
  - OpenTasks runtime sync/build succeeded on all workers
  - all six cells reached terminal states
  - no unstarted cells, no worker quarantines, and no stop reason
  - default cleanup succeeded; Terraform post-destroy verification passed
  - local Terraform state after the run contained `0` resources
  - artifact secret scan for Bedrock/Claude token patterns passed
- results:

| Task | Arm | Status | S_partial | Tokens | Duration | Notes |
|---|---|---:|---:|---:|---:|---|
| `sde-add-one-gitlab-pipeline` | `stock` | failure | 0.333 | 4,201,244 | 426s | earned 2/3 |
| `sde-add-one-gitlab-pipeline` | `notes` | failure | 0.333 | 799,808 | 169s | earned 2/3 |
| `sde-add-one-gitlab-pipeline` | `opentasks` | failure | 0.333 | 4,710,808 | 395s | earned 2/3; `readGraph=1` |
| `sde-add-wiki-page` | `stock` | failure | 0.125 | 4,473,111 | 387s | earned 1/4 |
| `sde-add-wiki-page` | `notes` | failure | 0.125 | 3,964,280 | 399s | earned 1/4 |
| `sde-add-wiki-page` | `opentasks` | failure | 0.125 | 3,584,996 | 410s | earned 1/4; `readGraph=1` |

- aggregate summary:
  - `stock`: `n=2`, success `0%`, mean `S_partial=0.229`,
    tokens `8,674,355`, env errors `0`
  - `notes`: `n=2`, success `0%`, mean `S_partial=0.229`,
    tokens `4,764,088`, env errors `0`
  - `opentasks`: `n=2`, success `0%`, mean `S_partial=0.229`,
    tokens `8,295,804`, env errors `0`
- OpenTasks machinery:
  - both OpenTasks Claude MCP smoke checks passed; both still showed
    `mcp_servers=[{"name":"opentasks","status":"pending"}]`, but both
    executed native OpenTasks MCP tools
  - both mandatory preludes passed on attempt `1` of max `2`; no retry was
    needed in this run
  - `sde-add-one-gitlab-pipeline` prelude:
    - native calls: `create_task`, `create_task`, `list_tasks`,
      `record_attempt`
    - usage: `127,882` tokens
    - main agent used OpenTasks:
      - `ToolSearch=3`
      - `mcp__opentasks__list_tasks=1`
      - `mcp__opentasks__record_attempt=3`
      - `mcp__opentasks__update_task=2`
  - `sde-add-wiki-page` prelude:
    - native calls: `create_task`, `record_attempt`, `create_task`,
      `list_tasks`
    - usage: `101,637` tokens
    - main agent did not call native OpenTasks tools after the prelude; tool
      counts were `Bash=70`, `Read=7`, `ToolSearch=1`
    - `readGraph=1` therefore came from the successful prelude trajectory
- interpretation:
  - degraded prelude mode fixed the comparison-shape problem observed in the
    prior run: the OpenTasks wiki-page cell is now a scored TAC attempt instead
    of an env error
  - on these two tasks all arms tied on partial score; OpenTasks did not improve
    accuracy in this sample
  - OpenTasks adoption is reliable at prelude time, but not yet reliable in the
    main agent for every task
  - token usage remains noisy and high; OpenTasks was cheaper than stock on the
    wiki task but more expensive than notes overall in this run
  - next optimization target is main-agent continuation behavior after a
    successful prelude, especially ensuring the agent actually inspects and
    updates the existing graph during the TAC task rather than relying on the
    prelude alone

### Main-Agent Graph Handoff Patch

- implementation changes:
  - changed TAC OpenTasks metrics so `readGraph` now reflects main-agent graph
    inspection, not prelude-only graph use
  - added separate diagnostic metrics:
    - `preludeGraphInitialized`
    - `mainGraphInspected`
    - `mainGraphUpdated`
  - strengthened the post-prelude main prompt with a required first step:
    - `ToolSearch` for `select:mcp__opentasks__list_tasks`
    - native `mcp__opentasks__list_tasks`
    - native `record_attempt` or `update_task` with task id, target, and first
      verification plan
  - added a test for the stricter main-agent graph handoff language
- local verification:
  - `npx vitest run src/__tests__/tac-docker-adapter.test.ts src/__tests__/tac-pool-guardrails.test.ts`:
    pass
  - `npm run build`: pass

### GitLab 3-Arm 2-Task Main-Graph Run

- run: `tac-gitlab-3arm-2task-main-graph-2026-06-23T04-38-19Z`
- configuration:
  - same task/arm/model/seed shape as the prior two-task runs
  - three EC2 workers
  - GitLab service slice
  - arms: `stock`, `notes`, `opentasks`
  - model: `haiku`
  - seed: `1`
  - tasks:
    - `sde-add-one-gitlab-pipeline`
    - `sde-add-wiki-page`
  - `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=degrade`
  - `TAC_OPENTASKS_TASK_PRELUDE_RETRIES=1`
  - stricter main-agent graph handoff patch enabled
- infrastructure:
  - all three workers bootstrapped successfully
  - OpenTasks runtime sync/build succeeded on all workers
  - all six cells reached terminal states
  - default cleanup succeeded; Terraform post-destroy verification passed
  - local Terraform state after the run contained `0` resources
  - artifact secret scan for Bedrock/Claude token patterns passed
- pool-level summary:
  - stop reason: `TAC_POOL_MAX_TOTAL_TOKENS=25000000 was reached`
  - the stop happened after all six cells completed
  - three cells exceeded the posthoc per-cell token cap of `5,000,000`, so the
    pool summary marks those cells as `budget_exceeded`
- original TAC results before posthoc budget penalty:

| Task | Arm | Original status | Original S_partial | Tokens | Duration | Main graph |
|---|---|---:|---:|---:|---:|---|
| `sde-add-one-gitlab-pipeline` | `stock` | failure | 0.333 | 1,203,923 | 266s | none |
| `sde-add-one-gitlab-pipeline` | `notes` | failure | 0.333 | 7,613,374 | 586s | none |
| `sde-add-one-gitlab-pipeline` | `opentasks` | failure | 0.333 | 1,594,947 | 236s | inspect+update |
| `sde-add-wiki-page` | `stock` | failure | 0.125 | 5,202,489 | 423s | none |
| `sde-add-wiki-page` | `notes` | failure | 0.125 | 3,678,509 | 455s | none |
| `sde-add-wiki-page` | `opentasks` | failure | 0.125 | 6,130,291 | 578s | inspect+update |

- pool-scored summary after posthoc token budget:
  - `stock`: `n=2`, success `0%`, mean `S_partial=0.167`,
    tokens `6,406,412`, budget-exceeded cells `1`
  - `notes`: `n=2`, success `0%`, mean `S_partial=0.063`,
    tokens `11,291,883`, budget-exceeded cells `1`
  - `opentasks`: `n=2`, success `0%`, mean `S_partial=0.167`,
    tokens `7,725,238`, budget-exceeded cells `1`
- OpenTasks machinery:
  - both Claude MCP smoke checks passed
  - both mandatory preludes passed on attempt `1` of max `2`
  - `sde-add-one-gitlab-pipeline` OpenTasks metrics:
    - `preludeGraphInitialized=1`
    - `mainGraphInspected=1`
    - `mainGraphUpdated=1`
    - main tool counts: `ToolSearch=1`,
      `mcp__opentasks__list_tasks=1`,
      `mcp__opentasks__record_attempt=2`
  - `sde-add-wiki-page` OpenTasks metrics:
    - `preludeGraphInitialized=1`
    - `mainGraphInspected=1`
    - `mainGraphUpdated=1`
    - main tool counts: `ToolSearch=1`,
      `mcp__opentasks__list_tasks=1`,
      `mcp__opentasks__record_attempt=4`
- interpretation:
  - the main-agent graph handoff patch fixed the adoption issue observed in the
    previous wiki-page run: both OpenTasks cells now inspected and updated the
    graph during the main TAC task
  - this improved instrumentation quality but did not improve TAC partial score
    on these two tasks
  - the stricter handoff did not explode tokens on the first pipeline task, but
    the OpenTasks wiki task still crossed the 5M posthoc cap
  - next optimization target should shift from discoverability/adoption to
    bounded update cadence and task-solving effectiveness: fewer graph updates,
    more targeted GitLab actions, and possibly a lower-cost model/prompt mode
    for bookkeeping

### Main-Graph Run Trace Debug

Source artifacts:
`evals/.tac-pool-runs/tac-gitlab-3arm-2task-main-graph-2026-06-23T04-38-19Z`.

Evaluator details:

- `sde-add-one-gitlab-pipeline`:
  - task instruction says to navigate to
    `http://the-agent-company.com:8929/root/api-server/-/ci/editor?branch_name=main`
  - evaluator checkpoint 1 instead checks for
    `root/openhands/-/ci/editor` in the trajectory
  - evaluator checkpoint 2 checks only that `root/openhands` has any pipeline
    returned by the GitLab API
  - result: all arms followed the task instruction and created or observed an
    `api-server` pipeline, but missed checkpoint 1 because of the task/evaluator
    URL mismatch
- `sde-add-wiki-page`:
  - checkpoint 1 checks whether the trajectory contains the Sotopia project URL
  - checkpoint 2 checks whether GitLab API returns at least one wiki page from
    `root/sotopia`
  - checkpoint 3 uses an LLM grader to compare that remote wiki page content to
    the Sotopia README
  - result: local wiki markdown and local git commits cannot pass checkpoint 2;
    the page must exist in the GitLab wiki API

Per-cell trace findings:

| Task | Arm | Trace behavior | Failure mode |
|---|---|---|---|
| `sde-add-one-gitlab-pipeline` | `stock` | fetched the `api-server` CI editor, created `.gitlab-ci.yml`, committed locally, tried push/API auth, verified a pending pipeline on project `2` | missed checkpoint 1 because evaluator expects `root/openhands/-/ci/editor`, not the instructed `root/api-server/-/ci/editor` |
| `sde-add-one-gitlab-pipeline` | `notes` | created a CI file, then spent most of the run on GitLab credential/session/API-token attempts | same URL mismatch; token blowup came from repeated 401/403 auth probing |
| `sde-add-one-gitlab-pipeline` | `opentasks` | used `ToolSearch`, listed OpenTasks tasks, recorded start and success attempts, created CI config, verified pending pipeline `15` | OpenTasks handoff worked; TAC failure is still the URL mismatch |
| `sde-add-wiki-page` | `stock` | researched Sotopia, authored wiki content, committed it locally, tried API, web CSRF, git, and token routes | never created a remote GitLab wiki page; repeated auth probing drove token use over the posthoc cap |
| `sde-add-wiki-page` | `notes` | same broad pattern with fewer tool calls: local wiki content plus failed push/API/web attempts | never created a remote GitLab wiki page |
| `sde-add-wiki-page` | `opentasks` | used OpenTasks in main agent, recorded progress/blocker attempts, produced a 168-line `home.md`, then kept probing auth routes | OpenTasks recorded the blocker but did not change policy enough to stop repeated auth attempts |

Diagnosis:

- The OpenTasks integration is no longer the main blocker for this slice:
  `preludeGraphInitialized=1`, `mainGraphInspected=1`, and
  `mainGraphUpdated=1` for both OpenTasks cells.
- `sde-add-one-gitlab-pipeline` is a poor accuracy signal until the TAC task
  instruction/evaluator mismatch is handled. It can still be used for machinery,
  runtime, and token-loop testing.
- `sde-add-wiki-page` is a better task-solving signal. The concrete blocker is
  missing a reliable GitLab write path for wiki creation. The traces repeatedly
  hit `401 Unauthorized`, `403 Forbidden`, or token/password failures.
  Pipeline cells eventually reached remote commits through Git HTTP basic
  credentials, but the wiki cells mostly tried empty/basic placeholders, API
  sessions, CSRF form posts, and token-generation routes. A targeted rerun
  should test the same Git HTTP credential strategy against
  `root/sotopia.wiki.git` before treating wiki creation as an environment
  limitation.
- Token blowups are dominated by unbounded auth exploration after the first
  failed write attempt, especially for the notes pipeline cell and the stock /
  OpenTasks wiki cells.

Recommended next experiments:

1. Add a TAC GitLab-write guidance prompt that tells agents to try the canonical
   Git HTTP credential strategy used by successful repository pushes, then try
   the GitLab API write path once, then stop generic auth guessing after a small
   failure budget.
2. Add trace metrics for `authFailureCount`, `gitPushAttempts`,
   `gitlabApiWriteAttempts`, `remoteWikiCreated`, and `pipelineEditorUrlSeen`.
3. Treat known TAC task/evaluator mismatches as metadata so benchmark summaries
   can mark affected tasks as machinery-only or exclude those checkpoints from
   product-quality comparisons.
4. Rerun the two-task GitLab slice after adding the auth-loop guard. The expected
   success criterion is lower token use with equal or better partial score, not
   necessarily full wiki success until the canonical GitLab write method is
   identified.

### TAC Environment Auth Debug

Follow-up diagnosis from the same main-graph run found an environment-level
failure that was hidden by the broad auth exploration loops.

Trace evidence:

- `sde-add-wiki-page__stock` read `/utils/config.py` and found TAC's documented
  GitLab API token path: `GITLAB_ACCESS_TOKEN = "root-token"`.
- The same cell then posted to
  `http://the-agent-company.com:8929/api/v4/projects/13/wikis` with that token
  and GitLab returned `invalid_token` with the message that the token is
  expired.
- The notes and OpenTasks cells repeatedly hit `401 Unauthorized`,
  `403 Forbidden`, or Git HTTP token/password failures while trying to write.
- This means the agents were not simply failing to discover GitLab. At least one
  trajectory followed TAC's own helper/config path and still found a broken
  write credential.

Root cause hypothesis:

- The TAC GitLab image creates `root-token` during image build with a finite
  expiry. Running the pinned `ghcr.io/theagentcompany/servers-gitlab:1.0.0`
  image in June 2026 can therefore produce a GitLab service that passes HTTP
  health checks but fails API writes through TAC's documented token.
- Each TAC cell calls `/utils/init.sh`, which calls `reset-gitlab` for GitLab
  tasks. A one-time EC2 bootstrap token fix would not be enough because reset
  recreates GitLab from the same stale image.

Harness changes:

- `TacDockerAdapter` now captures `tac-init-stdout.log` and
  `tac-init-stderr.log` plus `*-result.json` metadata for every cell so reset
  behavior and remote command status are auditable.
- For GitLab-dependent tasks, the adapter now refreshes the documented
  `root-token` in the live GitLab container after TAC init/reset and before
  model spend.
- For GitLab-dependent tasks, the adapter now runs a TAC environment preflight
  before Claude:
  - DNS/hosts resolution for `the-agent-company.com`
  - TAC API server GitLab healthcheck
  - `GET /api/v4/user` with `PRIVATE-TOKEN: root-token`, requiring username
    `root`
- The preflight writes `tac-env-preflight.json` plus stdout/stderr logs. A
  broken token now fails fast as a sandbox environment error instead of spending
  millions of tokens on auth guessing.
- `run-ec2-pool.sh` now fails before provisioning unless a remote-usable Claude
  auth route is present: Anthropic/gateway auth, or Bedrock mode with
  `AWS_REGION` and AWS credentials/token. `TAC_POOL_SKIP_LLM_AUTH_CHECK=1` is
  reserved for environment-only canaries.
- The Claude env passthrough now includes `ANTHROPIC_AUTH_TOKEN` in addition to
  `ANTHROPIC_API_KEY`.

Validation:

- `npx vitest run src/__tests__/tac-docker-adapter.test.ts`: pass
- `npx tsc --noEmit`: pass
- `tac-env-preflight-canary-2026-06-23T05-59-16Z`: reproduced that the initial
  GitLab dependency detector missed YAML list items such as `- gitlab`; fixed
  the detector.
- `tac-env-preflight-canary-2-2026-06-23T06-09-54Z`: reproduced GitLab's max
  personal-access-token expiry validation (`Expiration date must be before
  2027-06-23`); fixed refresh to use `364.days.from_now`.
- `tac-env-preflight-canary-3-2026-06-23T06-20-47Z`: token refresh printed
  `root-token refreshed` but the SSH wrapper returned nonzero with only the
  known-host warning on stderr; changed refresh success handling so the explicit
  success marker can advance to the API preflight.
- `tac-pool-2026-06-23T06-30-29-917399000Z`: TAC init, token refresh, and
  GitLab preflight all passed. The run then failed at Claude auth
  (`apiKeySource:"none"`, `Not logged in`) because Bedrock env was omitted.
- Local auth-guard check: with auth env removed, `run-ec2-pool.sh` exits `2`
  before Terraform provisioning and prints the missing remote-auth guidance.
- `tac-auth-canary-2026-06-23T06-40-05Z`: rerun with
  `CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2`. TAC init passed, token
  refresh passed, `tac-env-preflight.json` passed all checks, and Claude executed
  a real Bedrock-backed tool trajectory. The only failure was the intentionally
  short `EVAL_TIMEOUT=10000` (`claude -p timed out`) after 169,429 total tokens.
- EC2 cleanup was verified after each live canary by the pool script's
  post-destroy verification.

### Real GitLab 3-Arm Verification Run

Run:

- id: `tac-real-gitlab-3arm-2026-06-23T07-05-37Z`
- command shape: `TAC_POOL_WORKER_COUNT=3`, `TAC_POOL_SERVICE_SLICE=gitlab`,
  Docker volume snapshot `snap-0c7c6eb08119771e0`,
  `CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2`
- cells: `sde-add-wiki-page` x `stock,notes,opentasks` x seed `1`
- budgets: `EVAL_TIMEOUT=900000`, `TAC_CELL_TIMEOUT_SEC=1500`,
  `TAC_CELL_MAX_TOKENS=1200000`

Machinery results:

- EC2 provisioning, OpenTasks sync/build, and EC2 teardown all passed.
- Post-destroy verification passed.
- No worker was quarantined.
- All three cells wrote `tac-env-preflight.json` with:
  - DNS/hosts resolution for `the-agent-company.com`: pass
  - GitLab healthcheck: `200`
  - `GET /api/v4/user` with `PRIVATE-TOKEN: root-token`: `200`, username
    `root`
- All three cells reached TAC grading; there were zero `env_error` cells.
- The OpenTasks arm successfully initialized and used the graph:
  `readGraph=1`, `preludeGraphInitialized=1`, `mainGraphInspected=1`,
  `mainGraphUpdated=1`.

Scoring results before posthoc token cap:

| Arm | Runtime | Tokens | TAC earned / total | Original partial | Failed checkpoint |
|---|---:|---:|---:|---:|---|
| `notes` | 346s | 2,321,243 | 2 / 4 | 0.25 | `checkpoint-3` |
| `stock` | 463s | 4,225,909 | 2 / 4 | 0.25 | `checkpoint-3` |
| `opentasks` | 685s | 8,917,810 | 2 / 4 | 0.25 | `checkpoint-3` |

Budget interpretation:

- The pool summary reports all three cells as `budget_exceeded` because this
  run used the older posthoc-only `TAC_CELL_MAX_TOKENS=1200000` implementation
  in `run-pool.ts`.
- The posthoc cap zeroes `partial` and preserves the TAC score as
  `budgetOriginalPartial=0.25`.
- This verifies the benchmark machinery and scoring path, but the run is not a
  clean product-quality comparison until either:
  - the token cap is raised/disabled for scored pilot runs, or
  - a live token kill/soft-stop policy is implemented so expensive cells stop
    before multi-million-token loops.

### Live Token Guardrail Real Validation

Run:

- id: `tac-live-guardrail-validate-2026-06-23T09-30Z`
- command shape: `TAC_POOL_WORKER_COUNT=1`, `TAC_POOL_SERVICE_SLICE=gitlab`,
  Docker volume snapshot `snap-0c7c6eb08119771e0`,
  `CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2`
- cell: `sde-add-wiki-page` x `stock` x `haiku` x seed `1`
- budgets: `TAC_CELL_MAX_TOKENS=250000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=250000`, `TAC_CELL_TIMEOUT_SEC=900`

Result:

- EC2 provisioning, GitLab health readiness, OpenTasks sync/build, and teardown
  all passed.
- Post-destroy verification passed; AWS showed the instance terminated and no
  tagged volumes remaining for the run id.
- The adapter-side live token monitor fired and wrote
  `agent-live-token-budget.json`:
  `{"limit":250000,"reason":"tokens_live","tokens":278388}`.
- The TAC inner report reached grading and originally had `status=failure`,
  `S_partial=0.125`, `tacEarned=1`, `tacTotal=4`, `tokens=278388`,
  `durationMs=170760`.
- The pool correctly reclassified the cell as terminal
  `status=budget_exceeded`, `budgetExceeded=tokens_live`, `EnvErr=0`,
  `budgetOriginalPartial=0.125`.
- Trace taxonomy metrics were present:
  `liveTokenBudgetExceeded=1`, `taxonomyBudgetLiveTokens=1`, and
  `failure-taxonomy.json` primary label `budget_live_tokens`.

Interpretation:

- The real EC2/TAC path now validates the intended live-token semantics:
  live monitor signal -> taxonomy metric -> pool budget classification.
- The inner `swarmkit-eval` report still prints the pre-pool TAC status
  (`failure`) before pool-level reclassification; use the pool summary and
  `cell-result.json` as the source of truth for budgeted runs.

### Sonnet GitLab 3-Arm Real Run

Run:

- id: `tac-sonnet-gitlab-3arm-2026-06-23T10-00Z`
- command shape: `TAC_POOL_WORKER_COUNT=3`, `TAC_POOL_SERVICE_SLICE=gitlab`,
  Docker volume snapshot `snap-0c7c6eb08119771e0`,
  `CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-2`
- cells: `sde-add-wiki-page` x `stock,notes,opentasks` x `sonnet` x seed `1`
- budgets: `TAC_CELL_MAX_TOKENS=1500000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=1500000`, `TAC_CELL_TIMEOUT_SEC=1200`

Machinery results:

- EC2 provisioning, GitLab slice startup, OpenTasks sync/build, and teardown all
  passed.
- Post-destroy verification passed; the three EC2 workers were terminated and no
  tagged run volumes remained.
- No worker was quarantined and no cell was classified as `env_error`.
- The OpenTasks arm successfully initialized and used the graph:
  `readGraph=1`, `preludeGraphInitialized=1`, `mainGraphInspected=1`,
  `mainGraphUpdated=1`.
- The live-token monitor fired in all three cells, so the pool classified all
  cells as `budget_exceeded` with `budgetExceeded=tokens_live`.

Scoring results before pool budget zeroing:

| Arm | Runtime | Tokens | TAC earned / total | Original partial | Failed checkpoints |
|---|---:|---:|---:|---:|---|
| `notes` | 248s | 1,533,109 | 1 / 4 | 0.125 | `checkpoint-2`, `checkpoint-3` |
| `stock` | 269s | 1,512,285 | 1 / 4 | 0.125 | `checkpoint-2`, `checkpoint-3` |
| `opentasks` | 304s | 1,524,729 | 1 / 4 | 0.125 | `checkpoint-2`, `checkpoint-3` |

Trace observations:

- `stock`: read the task, ran repeated GitLab/wiki commands, cloned an empty
  `sotopia.wiki` repository, wrote `/tmp/sotopia.wiki/home.md`, committed
  locally, then failed to push with HTTP Basic/auth errors.
- `notes`: read the task and browsed GitLab/wiki URLs, cloned an empty wiki
  repository, wrote `/workspace/sotopia-wiki/home.md`, but did not create the
  remote wiki page before the live-token cap.
- `opentasks`: used `ToolSearch`, `mcp__opentasks__list_tasks`, and
  `mcp__opentasks__record_attempt`; then it hit the same GitLab write path
  failures, including `401 Unauthorized`, `403 Forbidden`, `could not read
  Username`, and HTTP Basic access-denied errors.

Interpretation:

- Switching from Haiku to Sonnet did not produce lift on this task under the
  current scaffold and `1.5M` live token cap.
- This run is worse than the earlier Haiku GitLab 3-arm pilot, where all arms
  reached `2 / 4` before posthoc budget zeroing.
- OpenTasks discoverability appears fixed for this slice: the agent found and
  updated the graph. The remaining gap is mostly task execution mechanics for
  creating/updating GitLab wiki content inside TAC, especially authentication and
  remote write behavior.
- The live-token guardrail is working as intended and prevented another
  multi-million-token runaway. Raising the cap could make this a more generous
  model-capability test, but the current evidence points first to scaffold and
  environment-mechanics improvements rather than simply using a stronger model.

### GitLab Wiki Smoke Preflight

Run:

- first canary id: `tac-gitlab-wiki-smoke-2026-06-23T14-31Z`
- required-git canary id: `tac-gitlab-wiki-smoke-2026-06-23T14-46Z`
- command shape: one EC2 worker, GitLab service slice, Docker volume snapshot
  `snap-0c7c6eb08119771e0`, `TAC_PREFLIGHT_ONLY=1`,
  `TAC_GITLAB_WIKI_SMOKE=1`
- second canary set `TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT=1`, so success required
  both API wiki writes and Git wiki clone/commit/push

Implementation:

- `TacDockerAdapter` now has a GitLab wiki smoke preflight for GitLab-dependent
  tasks.
- The smoke creates a scratch GitLab project, creates and reads a wiki page via
  the GitLab API, optionally clones the scratch wiki repo, commits a markdown
  page, pushes it to `master`, then deletes the scratch project.
- `TAC_PREFLIGHT_ONLY=1` returns a self-scored zero-token TAC result after
  preflights, making environment canaries cheap and non-leaky.
- `TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT=1` promotes the git diagnostic from
  advisory to required.
- `root-token` is redacted in command artifacts.

Validation:

- first canary: API create/read/delete passed, but the advisory git diagnostic
  failed because the generated smoke script did not shell-quote
  `git config user.name "TAC Wiki Smoke"` correctly
- fix: quote generated git command arguments with `shlex.quote`
- second canary:
  - pool result: `success`, `S_partial=1.000`, `tokens=0`, latency `42s`
  - `tac-env-preflight.json`: pass
  - `tac-gitlab-wiki-smoke.json`: `ok=true`, `apiOk=true`, `gitOk=true`,
    `requireGit=true`
  - checks passed: `create-scratch-project` `201`,
    `create-wiki-page-api` `201`, `read-wiki-page-api` `200`,
    `git-wiki-clone-commit-push` exit `0`, `delete-scratch-project` `202`
  - artifact:
    `evals/.tac-pool-runs/tac-gitlab-wiki-smoke-2026-06-23T14-46Z/cells/sde-add-wiki-page__stock__preflight__seed1/tac-gitlab-wiki-smoke.json`

Infrastructure finding:

- The original GitLab-only EC2 bootstrap used TAC's `make start-gitlab`. During
  the first canary it stalled before a `gitlab` container appeared; a manual
  direct `docker run` of the same GitLab image and ports recovered the worker.
- The GitLab-only user-data path now starts the API server and GitLab container
  directly. The full-stack TAC path remains unchanged.
- The second canary bootstrapped successfully through the direct GitLab path.
  GitLab startup still has noticeable latency, but no manual recovery was
  needed.

Cleanup:

- both canaries used the pool default cleanup path
- Terraform post-destroy verification passed
- AWS verification for `tac-gitlab-wiki-smoke-2026-06-23T14-46Z` showed the
  worker instance `i-0fc5a9cb134e91307` terminated and no tagged Docker EBS
  volumes remaining

Interpretation:

- The TAC GitLab wiki environment is now verified independently of agent
  behavior: the live service accepts the documented `root-token` for API wiki
  writes and supports Git wiki clone/commit/push against a scratch project.
- Future `sde-add-wiki-page` failures should be treated as scaffold/agent
  execution failures first, not as evidence that the GitLab wiki service is
  unwritable.

### Target Wiki and LLM-Grader Diagnosis

Date: 2026-06-23.

Status: root cause updated.

Question: after the scratch wiki smoke passed, why did guided
`sde-add-wiki-page` runs still stop at `2 / 4`?

Implementation changes:

- Added a target-project wiki smoke guarded by `TAC_PREFLIGHT_ONLY=1`:
  `TAC_GITLAB_WIKI_TARGET_SMOKE_PROJECT=root/sotopia`.
- Added trace metrics for GitLab wiki API attempts/success, wiki git
  clone/push attempts, remote wiki creation, and pipeline editor URL sightings.
- Tightened GitLab wiki API success detection to count JSON-only `curl -s`
  responses with `format`, `slug`, `title`, and `content`.
- Added TAC eval stdout/stderr artifacts: `tac-eval-stdout.log`,
  `tac-eval-stderr.log`, and `tac-eval-result.json`.
- Marked TAC tasks whose evaluator calls `llm_complete` /
  `evaluate_with_llm` via `publicMetadata.usesLlmGrader`.
- Added `TAC_EVAL_LLM_PREFLIGHT`, enabled by default for LLM-graded tasks, to
  run a tiny `/utils/common.py` `llm_complete` call before agent spend.

Validation:

- `npx vitest run src/__tests__/tac-docker-adapter.test.ts
  src/__tests__/tac-pool-guardrails.test.ts`: pass
- `npx tsc --noEmit`: pass

Target smoke results:

| Run | Result | Finding |
|---|---|---|
| `tac-target-wiki-smoke-2026-06-23T15-31Z` | success, `S_partial=1.000`, zero tokens | target `root/sotopia` accepted API create/read/delete and accepted a wiki git push |
| `tac-target-wiki-smoke-readback-2026-06-23T15-40Z` | env diagnostic failure, zero tokens | API create/read/delete passed, but git wiki push was not API-readable afterward |

Target smoke conclusion:

- The canonical write path for `root/sotopia` is GitLab Wiki REST API.
- Git wiki push can be accepted by Git but still not appear through
  `GET /api/v4/projects/:id/wikis`, so agents should not prefer wiki git for
  this TAC task.

Guided scored canaries:

| Run | Prompt focus | Result | Tokens | Key metrics |
|---|---|---:|---:|---|
| `tac-wiki-api-guidance-stock-2026-06-23T15-45Z` | use Wiki REST API and stop auth guessing | `2 / 4`, failed checkpoint 3 | 398,812 | API write/readback succeeded; initial metric under-detected it |
| `tac-wiki-readme-faithful-stock-2026-06-23T16-02Z` | API path plus README-faithful content | `2 / 4`, failed checkpoint 3 | 218,855 | `gitlabApiWriteSucceeded=1`, `remoteWikiCreated=1`, no auth/error loop |
| `tac-wiki-readme-mirror-stock-2026-06-23T16-12Z` | close README mirror plus update if missing | `2 / 4`, failed checkpoint 3 | 608,344 | remote wiki created, but extra probing increased tokens and errors |

Trace interpretation:

- The first guided canary created `Introduction to Sotopia` through
  `POST /api/v4/projects/13/wikis`, fetched it by slug, and listed it through
  the Wiki API.
- The README-faithful canary did the same with lower token use and no auth loop.
- Both passed checkpoint 1 and checkpoint 2. The only failing checkpoint was
  checkpoint 3, which calls TAC's LLM grader to compare the remote wiki content
  to `README.md`.

LLM-grader preflight:

Run:

- id: `tac-eval-llm-preflight-missing-2026-06-23T16-20Z`
- command shape: preflight-only, GitLab service slice, Docker volume snapshot
  `snap-0c7c6eb08119771e0`, `TAC_GITLAB_WIKI_SMOKE=0`,
  `TAC_POOL_SKIP_LLM_AUTH_CHECK=1`
- cell: `sde-add-wiki-page` x `stock` x `preflight` x seed `1`

Result:

- cell status: `env_error`
- tokens: `0`
- artifact:
  `evals/.tac-pool-runs/tac-eval-llm-preflight-missing-2026-06-23T16-20Z/cells/sde-add-wiki-page__stock__preflight__seed1/tac-eval-llm-preflight.json`
- artifact error: LiteLLM fell back to OpenAI and failed because no API key was
  configured (`The api_key client option must be set...`).
- cleanup: Terraform destroy completed; post-destroy verification passed; AWS
  showed instance `i-09438f6340fe2ccd7` terminated and no tagged volumes.

Updated conclusion:

- The API/wiki execution mechanics now work.
- Existing `sde-add-wiki-page` checkpoint-3 failures are not trustworthy
  product-quality signals until TAC's LLM grader route is configured.
- A full TAC round that includes LLM-graded tasks must pass
  `TAC_EVAL_LLM_PREFLIGHT` first with valid `LITELLM_API_KEY`,
  `LITELLM_BASE_URL`, and `LITELLM_MODEL`, or explicitly exclude/label
  LLM-graded tasks as grader-unavailable.

### Bedrock Grader Proxy E2E

Run:

- id: `tac-bedrock-grader-proxy-e2e-2026-06-24T01-05-00Z`
- command shape: preflight-only, one GitLab worker, Docker volume snapshot
  `snap-0c7c6eb08119771e0`, `TAC_GRADER_PROXY=bedrock`,
  `TAC_GRADER_BEDROCK_MODEL=bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- cell: `sde-add-wiki-page` x `stock` x `preflight` x seed `1`

Result:

- cell status: `success`
- `S_partial=1.000`, `full=true`, zero tokens
- `tacEvalLlmGraderRequired=1`, `tacEvalLlmPreflightRan=1`
- artifact `tac-eval-llm-preflight.json`:
  `{"ok":true,"model":"openai/tac-grader","baseUrl":"http://127.0.0.1:4000/v1","contentPreview":"yes"}`
- cleanup: Terraform destroy completed; post-destroy verification passed.

Implementation notes:

- Added worker-local LiteLLM proxy startup through
  `evals/tac/scripts/start-litellm-bedrock-proxy.sh`.
- The proxy alias is `tac-grader`; TAC's LiteLLM client must call
  `LITELLM_MODEL=openai/tac-grader` against the proxy URL so the LiteLLM SDK
  uses the OpenAI-compatible provider route instead of treating `tac-grader` as
  a native provider name.
- Claude 3.5 Sonnet was unavailable/EOL in the current Bedrock route; Sonnet
  4.5 worked for the grader proxy.

### GitLab 3-Task 3-Arm Validation With Bedrock Grader Proxy

Run:

- id: `tac-gitlab-3task-3arm-bedrock-grader-2026-06-24T01-20Z`
- command shape: 3 GitLab EC2 workers, Docker volume snapshot
  `snap-0c7c6eb08119771e0`, `CLAUDE_CODE_USE_BEDROCK=1`,
  `AWS_REGION=us-west-2`, `TAC_GRADER_PROXY=bedrock`
- cells:
  `sde-add-one-gitlab-pipeline,sde-add-wiki-page,sde-close-an-issue` x
  `stock,notes,opentasks` x `haiku` x seed `1`
- guardrails: `TAC_CELL_MAX_TOKENS=1000000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=1000000`, `TAC_CELL_TIMEOUT_SEC=1200`,
  `TAC_POOL_MAX_TOTAL_TOKENS=12000000`,
  `TAC_OPENTASKS_TASK_PRELUDE_FAILURE_MODE=degrade`

Machinery result:

- All 9 cells started and completed.
- `EnvErr=0`, quarantined workers `0`, unstarted cells `0`.
- Terraform destroyed all 3 workers, generated key pair, and security group;
  post-destroy verification passed.
- The three `sde-add-wiki-page` cells all passed TAC's LLM-grader preflight
  through the Bedrock proxy:
  `model=openai/tac-grader`, `baseUrl=http://127.0.0.1:4000/v1`,
  `contentPreview=yes`.
- The OpenTasks arm initialized, inspected, and updated the graph in all three
  OpenTasks cells: `readGraph=1`, `preludeGraphInitialized=1`,
  `mainGraphInspected=1`, `mainGraphUpdated=1`.

Scoring result:

| Task | Arm | Pool status | Original TAC earned / total | Tokens |
|---|---|---|---:|---:|
| `sde-add-one-gitlab-pipeline` | `stock` | `budget_exceeded` (`tokens_live`) | 0 / 3 | 1,043,486 |
| `sde-add-one-gitlab-pipeline` | `notes` | `budget_exceeded` (`tokens_live`) | 0 / 3 | 1,022,753 |
| `sde-add-one-gitlab-pipeline` | `opentasks` | `budget_exceeded` (`tokens_live`) | 0 / 3 | 1,045,760 |
| `sde-add-wiki-page` | `stock` | `budget_exceeded` (`tokens_live`) | 1 / 4 | 1,032,298 |
| `sde-add-wiki-page` | `notes` | `budget_exceeded` (`tokens_live`) | 1 / 4 | 1,059,848 |
| `sde-add-wiki-page` | `opentasks` | `budget_exceeded` (`tokens_live`) | 1 / 4 | 1,021,866 |
| `sde-close-an-issue` | `stock` | `budget_exceeded` (`tokens_live`) | 0 / 2 | 1,007,275 |
| `sde-close-an-issue` | `notes` | `budget_exceeded` (`tokens_live`) | 0 / 2 | 1,019,516 |
| `sde-close-an-issue` | `opentasks` | `budget_exceeded` (`tokens_live`) | 0 / 2 | 1,001,011 |

Interpretation:

- The EC2 pool, Docker snapshot path, TAC GitLab setup, OpenTasks mount/MCP
  machinery, live token guardrails, and Bedrock-backed TAC grader proxy are
  validated on a larger 9-cell run.
- The run is not a clean product-quality comparison because every cell hit the
  1M live token cap. Pool-level `S_partial` is therefore zeroed by budget
  policy; use `budgetOriginalPartial` / TAC earned metrics only for diagnostics.
- The dominant remaining issue is agent efficiency/strategy: all arms spend the
  token budget before completing simple GitLab tasks, with repeated signals for
  wrong target/not-found and auth/permission probing.

### GitLab Wiki Shared-Prompt Rerun With Per-Arm Worker Isolation

Run:

- id: `tac-wiki-3arm-shared-prompt-gitlab-3w-grounded-2026-06-24T04-55Z`
- command shape: 3 GitLab EC2 workers, one arm per worker, Docker volume
  snapshot `snap-0c7c6eb08119771e0`, `CLAUDE_CODE_USE_BEDROCK=1`,
  `AWS_REGION=us-west-2`, `TAC_GRADER_PROXY=bedrock`
- cells: `sde-add-wiki-page` x `stock,notes,opentasks` x `haiku` x seed `1`
- config: `tac-shared-prompt-v2-grounded`
- guardrails: `TAC_CELL_MAX_TOKENS=3000000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=3000000`, `TAC_CELL_TIMEOUT_SEC=1200`

Implementation changes before this run:

- Added generic shared prompt guidance to keep documentation/wiki content
  tightly grounded in source material and to stop after verified successful
  writes.
- Fixed GitLab write diagnostics for Python `requests.post(.../wikis)` traces
  with `Status code: 201` output.
- After the run, fixed `mcpServersConnected` so future OpenTasks TAC reports
  count observed `mcp__opentasks__...` tool calls as a connected MCP path even
  when the stream lacks an explicit connected server status.

Machinery result:

- All 3 cells started and completed.
- `EnvErr=0`, quarantined workers `0`, unstarted cells `0`.
- Terraform destroyed all 3 workers, generated key pair, and security group;
  post-destroy verification passed.
- The GitLab-only startup path reused the preseeded GitLab volumes and avoided
  the previous anonymous-volume copy stall.
- Per-arm worker isolation removed the cross-arm wiki state contamination seen
  in the earlier 1-worker 3-arm run.

Scoring result:

| Task | Arm | Pool status | TAC earned / total | S_partial | Tokens | Latency |
|---|---|---|---:|---:|---:|---:|
| `sde-add-wiki-page` | `stock` | `failure` | 2 / 4 | 0.250 | 439,573 | 120s |
| `sde-add-wiki-page` | `notes` | `success` | 4 / 4 | 1.000 | 461,468 | 143s |
| `sde-add-wiki-page` | `opentasks` | `success` | 4 / 4 | 1.000 | 635,000 | 164s |

Interpretation:

- The TAC GitLab wiki machinery is now validated end to end: the successful
  arms created wiki pages, the TAC LLM grader saw the pages, and the pool
  preserved non-budgeted success.
- The earlier "no lift" signal was confounded by three issues: low token cap,
  single-worker state leakage across arms, and missing Python-request GitLab
  write diagnostics.
- The stock failure was not a GitLab write failure. It created a wiki page, but
  checkpoint 3 failed because the LLM grader judged its page as not matching the
  README closely enough. Notes and OpenTasks passed the same LLM checkpoint.
- OpenTasks used the graph path (`readGraph=1`, `preludeGraphInitialized=1`,
  `mainGraphInspected=1`, `mainGraphUpdated=1`) and achieved full TAC credit on
  this task.

### GitLab-Only Larger Isolated Runs

Runs:

- attempted id: `tac-gitlab-5task-3arm-isolated-2026-06-24T05-10Z`
- batch 1 id:
  `tac-gitlab-batch1-pipeline-close-3arm-isolated-2026-06-24T05-25Z`
- batch 2 id:
  `tac-gitlab-batch2-branch-3arm-isolated-2026-06-24T05-45Z`
- command shape: GitLab-only EC2 workers, one TAC cell per worker, Docker
  volume snapshot `snap-0c7c6eb08119771e0`, `CLAUDE_CODE_USE_BEDROCK=1`,
  `AWS_REGION=us-west-2`, `TAC_GRADER_PROXY=bedrock`
- model: `haiku`
- arms: `stock,notes,opentasks`
- guardrails: `TAC_CELL_MAX_TOKENS=3000000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=3000000`, `TAC_CELL_TIMEOUT_SEC=1200`

Capacity result:

- The first 15-worker attempt failed during Terraform provisioning after 8
  instances were created. The default cleanup path destroyed the partial pool.
  Manual AWS checks confirmed the tagged instances were terminated and no
  tagged volumes or security groups remained.
- The run plan was split into 6-worker batches. Both completed their eval cells
  and passed post-destroy verification.

Batch 1 scoring result:

| Task | Arm | Pool status | TAC earned / total | Tokens | Latency |
|---|---|---|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | `stock` | `failure` | 0 / 3 | 447,557 | 108s |
| `sde-add-one-gitlab-pipeline` | `notes` | `failure` | 0 / 3 | 344,855 | 106s |
| `sde-add-one-gitlab-pipeline` | `opentasks` | `failure` | 0 / 3 | 908,040 | 174s |
| `sde-close-an-issue` | `stock` | `success` | 2 / 2 | 174,445 | 89s |
| `sde-close-an-issue` | `notes` | `success` | 2 / 2 | 202,391 | 91s |
| `sde-close-an-issue` | `opentasks` | `success` | 2 / 2 | 448,012 | 150s |

Batch 2 scoring result:

| Task | Arm | Pool status | TAC earned / total | Tokens | Latency |
|---|---|---|---:|---:|---:|
| `sde-change-branch-policy` | `stock` | `success` | 2 / 2 | 247,783 | 94s |
| `sde-change-branch-policy` | `notes` | `success` | 2 / 2 | 280,083 | 103s |
| `sde-change-branch-policy` | `opentasks` | `success` | 2 / 2 | 524,530 | 153s |
| `sde-delete-stale-branch` | `stock` | `success` | 2 / 2 | 171,185 | 88s |
| `sde-delete-stale-branch` | `notes` | `success` | 2 / 2 | 222,523 | 93s |
| `sde-delete-stale-branch` | `opentasks` | `success` | 2 / 2 | 502,848 | 144s |

Interpretation:

- The isolated EC2 pool is now producing clean non-budgeted TAC completions on
  the simpler GitLab state-edit tasks.
- OpenTasks passed `sde-add-wiki-page`, `sde-close-an-issue`,
  `sde-change-branch-policy`, and `sde-delete-stale-branch` under the 3M token
  cap. It continues to spend about 2x the baseline tokens on the branch/issue
  tasks because it initializes and updates the graph path.
- `sde-add-one-gitlab-pipeline` failed for all three arms, with common wrong
  target/not-found signals and editor URL detection. Treat it as a task-specific
  benchmark mechanics/debug target before using it for OpenTasks lift claims.
- One batch-2 worker missed the preseeded GitLab volume markers and fell back to
  anonymous Docker volumes during bootstrap. The cell still completed, but this
  is an infra efficiency issue worth fixing before full-scale runs.

### OpenTasks vs Baseline Optimization Signals

Artifact basis:

- Compared `stock`, `notes`, and `opentasks` on the isolated GitLab-only runs
  using the same model, tasks, seed, and one-cell-per-worker setup.
- Parsed per-cell token totals, latency, OpenTasks prelude reports, and raw
  `agent-stream.jsonl` tool trajectories.

Token and latency deltas:

| Task | OpenTasks status | OpenTasks tokens | Baseline avg tokens | Total ratio | OpenTasks prelude | Main-agent ratio after subtracting prelude |
|---|---|---:|---:|---:|---:|---:|
| `sde-add-wiki-page` | success | 635,000 | 450,521 | 1.41x | 97,592 | 1.19x |
| `sde-close-an-issue` | success | 448,012 | 188,418 | 2.38x | 197,372 | 1.33x |
| `sde-change-branch-policy` | success | 524,530 | 263,933 | 1.99x | 147,262 | 1.43x |
| `sde-delete-stale-branch` | success | 502,848 | 196,854 | 2.55x | 257,312 | 1.25x |
| `sde-add-one-gitlab-pipeline` | failure | 908,040 | 396,206 | 2.29x | 286,903 | 1.57x |

Findings:

- The dominant OpenTasks overhead is the LLM-driven task prelude. It consumes
  98k-287k tokens before the main TAC agent starts. Removing or replacing this
  with a deterministic graph seed would cut a large fraction of the total
  overhead while preserving the main graph-inspection behavior.
- The prelude currently has avoidable retries and detours. In observed traces it
  sometimes calls `mcp__opentasks__create_task` without `status`, receives
  `Status is required for issues (status)`, then retries with `status: "open"`.
  Some preludes also use the `Skill` tool and Bash probes before native MCP
  calls. These are scaffolding inefficiencies, not TAC task difficulty.
- The main OpenTasks agent still spends 19%-57% more tokens than the average
  baseline after subtracting prelude tokens. The extra work is mostly graph
  handoff calls (`ToolSearch`, `list_tasks`, `record_attempt` or `update_task`)
  plus one or two additional recovery probes after tool/API errors.
- The GitLab helper prompt is ambiguous. Agents tried `tac-gitlab-api GET
  projects/root%2Fsotopia`, but the helper currently treats that as
  `http://.../projects/...` rather than `/api/v4/projects/...`, causing a 404
  before falling back to raw `curl`. This creates avoidable wrong-target
  evidence and extra turns.
- The shared TAC prompt tells agents to prefer `jq`-selected JSON fields, but
  the TAC task containers do not consistently have `jq`. Both baseline and
  OpenTasks traces hit or route around this. Prefer Python/helper examples or
  install `jq` in the agent setup.
- `sde-add-one-gitlab-pipeline` is not a useful OpenTasks comparison yet. Its
  task text targets `root/api-server`, while its evaluator checks
  `root/openhands` and searches the trajectory for `root/openhands/-/ci/editor`.
  All three arms failed for this reason.

Recommended optimization order:

1. Replace the LLM task prelude with a deterministic adapter-side graph seed:
   create one `open` task from `/instruction/task.md`, record a pending attempt,
   and write a compact handoff summary. Keep an option to run the old LLM
   prelude for experiments.
2. Fix `create_task` defaulting so omitted `status` becomes `open`, matching the
   tool description and removing a common failed first call.
3. Relax the main OpenTasks handoff: after a successful prelude, require one
   graph inspection and one final outcome update, not an immediate second
   attempt record before any TAC work.
4. Make `tac-gitlab-api` accept API shorthand paths by prepending `/api/v4/`
   when the path is not absolute and does not already start with `/api/v4/`.
5. Remove `jq` from TAC prompt examples or install it in the task container
   setup.
6. Quarantine or patch `sde-add-one-gitlab-pipeline` before including it in
   efficacy claims.

### No-Prelude Smoke: `sde-delete-stale-branch`

Run:

- `tac-no-prelude-smoke-delete-3arm-2026-06-24T07-15Z`
- model: `haiku`
- arms: `stock,notes,opentasks`
- task: `sde-delete-stale-branch`
- seed: `1`
- guardrails: `TAC_CELL_MAX_TOKENS=3000000`,
  `TAC_AGENT_LIVE_MAX_TOKENS=3000000`, `TAC_CELL_TIMEOUT_SEC=1200`
- `TAC_OPENTASKS_TASK_PRELUDE` was intentionally unset to verify the new
  default-disabled LLM prelude behavior.

Result:

| Arm | Pool status | TAC earned / total | Tokens | Latency | Main OpenTasks graph calls |
|---|---|---:|---:|---:|---:|
| `stock` | `success` | 2 / 2 | 473,207 | 111s | 0 |
| `notes` | `success` | 2 / 2 | 368,025 | 105s | 0 |
| `opentasks` | `success` | 2 / 2 | 123,925 | 97s | 0 |

Interpretation:

- The LLM task prelude is now disabled by default in a live EC2 TAC run. The
  OpenTasks cell produced no `opentasks-task-prelude` artifacts and reported
  `preludeGraphInitialized=0`.
- The OpenTasks MCP connection path still works in the separate Claude MCP
  smoke: the smoke run loaded `mcp__opentasks__list_tasks` through `ToolSearch`
  and completed successfully.
- The main OpenTasks task trajectory did not use OpenTasks graph tools. Its
  `agent-stream.jsonl` contained one `Read` call and three `Bash` calls, with no
  `ToolSearch` or native `mcp__opentasks__*` calls. This makes the run a valid
  no-prelude machinery smoke, but not evidence of graph-assisted OpenTasks lift.
- EC2 cleanup worked: Terraform state was empty after destroy, the three tagged
  instances were terminated, and no tagged volumes or security groups remained.

### OpenTasks Optimization Signals After No-Prelude Smoke

Artifact basis:

- Re-read the isolated GitLab batch runs:
  - `tac-gitlab-batch1-pipeline-close-3arm-isolated-2026-06-24T05-25Z`
  - `tac-gitlab-batch2-branch-3arm-isolated-2026-06-24T05-45Z`
- Compared each OpenTasks cell against the average of `stock` and `notes`.
- Parsed `opentasks-task-prelude-report.json` for prelude token cost and
  `agent-stream.jsonl` for main-agent tool calls.
- Rechecked the no-prelude smoke:
  `tac-no-prelude-smoke-delete-3arm-2026-06-24T07-15Z`.

Corrected token split:

| Task | OpenTasks status | OpenTasks tokens | LLM prelude tokens | Prelude share | Main-agent tokens | Baseline avg | Total ratio | Main-only ratio |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sde-add-one-gitlab-pipeline` | failure | 908,040 | 286,903 | 31.6% | 621,137 | 396,206 | 2.29x | 1.57x |
| `sde-close-an-issue` | success | 448,012 | 197,372 | 44.1% | 250,640 | 188,418 | 2.38x | 1.33x |
| `sde-change-branch-policy` | success | 524,530 | 147,262 | 28.1% | 377,268 | 263,933 | 1.99x | 1.43x |
| `sde-delete-stale-branch` | success | 502,848 | 257,312 | 51.2% | 245,536 | 196,854 | 2.55x | 1.25x |

Trajectory signals:

- The LLM prelude is the largest avoidable overhead. Each prelude performs the
  same shape of work: read `/instruction/task.md`, discover OpenTasks tools,
  create a top-level task, record a pending attempt, and list tasks. The traces
  show 147k-287k tokens spent on this before the TAC work starts.
- The prelude still contains scaffolding mistakes and unnecessary probes. It
  sometimes uses `Skill`, `Bash`, `which mcp__opentasks__create_task`, heredoc
  payload construction, or even a shell-shaped `mcp__opentasks__create_task`
  attempt before making the native MCP call.
- `create_task` missing-status retries are still present in the prelude traces.
  The first `create_task` call often omits `status`, fails, and is retried with
  `status: "open"`.
- Main-agent graph use is much cheaper than the prelude but still adds 3-5
  graph calls per run. On successful tasks the main-only OpenTasks overhead
  drops to 1.25x-1.43x over baseline, which is a much more plausible target for
  optimization.
- The main prompt currently requires a graph call before any task-specific
  `Read` or `Bash` when a prelude succeeds. This guarantees graph usage but can
  front-load bookkeeping. After deterministic graph seeding, the required main
  behavior should be: inspect once near start, update once at final outcome, and
  update mid-task only when a material blocker or target change occurs.
- Without the LLM prelude, the OpenTasks arm may ignore the graph entirely. In
  the no-prelude smoke it succeeded on `sde-delete-stale-branch` with only one
  `Read` and three `Bash` calls, no OpenTasks MCP calls. That run was faster and
  cheaper, but it is not graph-assisted evidence.

Harness and environment signals:

- The `opentasks` arm appendix asks the agent to use the skill and native MCP
  tools, but this is not sufficient by itself. Without either an explicit
  prelude or a stronger first-step contract, Haiku can solve a simple TAC task
  directly and never touch OpenTasks.
- The shared TAC operating prompt still says to prefer `jq` for selected JSON
  fields. Several trajectories call `jq` before falling back to raw output or
  Python. The eval container should either install `jq` reliably or the prompt
  should prefer `python3 -m json.tool` / compact Python field selection.
- `tac-gitlab-api GET projects/root%2Fsotopia` produced wrong-target friction
  because the helper treats relative paths as web paths unless `/api/v4/` is
  included. The helper should prepend `/api/v4/` for API-looking shorthand paths.

Updated optimization order:

1. Add deterministic adapter-side OpenTasks graph seeding as the default graph
   initialization path. It should create one top-level task directly through the
   OpenTasks CLI or MCP client, using `/instruction/task.md`, without an LLM.
2. Keep the LLM prelude opt-in only for research comparisons. It is too
   expensive and too agent-behavior-shaped for the default benchmark arm.
3. Make `create_task` default omitted `status` to `open` so both human prompts
   and agent calls stop paying the failed-call retry cost.
4. Tighten the OpenTasks main prompt: require one graph inspection and one final
   outcome update, but avoid “update after every discovery” language for TAC.
5. Fix `tac-gitlab-api` API shorthand handling and remove or satisfy the `jq`
   assumption to reduce non-OpenTasks noise in both baseline and OpenTasks arms.

### Deterministic Graph Seed Smoke: `sde-delete-stale-branch`

Run:

- `tac-graph-seed-smoke-delete-3arm-2026-06-24T00-10Z`
- model: `haiku`
- arms: `stock,notes,opentasks`
- task: `sde-delete-stale-branch`
- seed: `1`
- config: `tac-graph-seed-smoke-v1`
- `TAC_OPENTASKS_TASK_PRELUDE` was unset, so the LLM prelude stayed disabled.
- `TAC_OPENTASKS_GRAPH_SEED` was unset, so deterministic graph seeding used the
  new default-enabled path for the OpenTasks arm.

Result:

| Arm | Pool status | TAC earned / total | Tokens | Latency | Seeded graph | Main graph inspected | Main graph updated |
|---|---|---:|---:|---:|---:|---:|---:|
| `stock` | `success` | 2 / 2 | 303,069 | 97s | 0 | 0 | 0 |
| `notes` | `success` | 2 / 2 | 121,537 | 83s | 0 | 0 | 0 |
| `opentasks` | `success` | 2 / 2 | 326,574 | 158s | 1 | 1 | 1 |

Artifact findings:

- The deterministic seed succeeded. `opentasks-graph-seed-report.json` created
  seeded task `t-15fw` with title
  `Delete the stale branch feature/ssl from http://the-agent-company.com:8929/root/OpenSearch`,
  tags `tac,seeded`, status `open`, and metadata tying it to
  `sde-delete-stale-branch`.
- The main OpenTasks trajectory used the graph rather than ignoring it. The raw
  `agent-stream.jsonl` contained one `ToolSearch`, two
  `mcp__opentasks__list_tasks` calls, two `mcp__opentasks__record_attempt`
  calls, and five `Bash` calls.
- The main agent used the seeded task id `t-15fw`, recorded a starting attempt,
  performed the GitLab branch deletion, then updated the same attempt with
  `outcome: success` and command evidence.
- The run did not create `opentasks-task-prelude` artifacts and reported
  `preludeGraphInitialized=0`, confirming that the LLM prelude was not used.
- EC2 cleanup worked: Terraform state was empty after destroy, the three tagged
  instances were terminated, and no tagged volumes or security groups remained.

Remaining issue surfaced:

- The agent first tried `tac-gitlab-api DELETE "/projects/root%2FOpenSearch/..."`,
  which still missed `/api/v4` because the helper treats leading-slash paths as
  web paths. It recovered with raw `curl`, but this caused extra tool errors and
  turns. The next scaffolding fix should make `tac-gitlab-api` prepend
  `/api/v4/` for API-looking shorthand paths even when the path starts with
  `/projects`, `/groups`, `/users`, or similar GitLab API roots.

### GitLab 4-Task Seeded Batch + Wiki Title Fix

Runs:

- Batch: `tac-gitlab-4task-3arm-seeded-2026-06-24T08-05Z`
- Targeted validation: `tac-wiki-opentasks-gettask-titlefix-2026-06-24T08-20Z`
- model: `haiku`
- batch arms: `stock,notes,opentasks`
- batch tasks: `sde-delete-stale-branch`, `sde-close-an-issue`,
  `sde-change-branch-policy`, `sde-add-wiki-page`
- seed: `1`
- EC2: GitLab-only service slice, m7i.2xlarge workers, preseeded Docker volume
  snapshot `snap-0c7c6eb08119771e0`

Adapter/scaffolding changes before the batch:

- `tac-gitlab-api` now normalizes GitLab API-looking shorthand such as
  `projects/root%2Frepo/...` and `/projects/root%2Frepo/...` to `/api/v4/...`.
- TAC reports now include trace efficiency metrics for main tool count, Bash
  count, OpenTasks MCP calls, OpenTasks calls before first Bash / after last
  Bash, helper calls, shorthand helper calls, and raw GitLab API curl calls.

Batch result:

| Arm | n | Success | S_partial | Tokens | p50 latency | EnvErr | Budget |
|---|---:|---:|---:|---:|---:|---:|---:|
| `stock` | 4 | 100% | 1.000 | 1,202,522 | 80s | 0 | 0 |
| `notes` | 4 | 100% | 1.000 | 1,207,440 | 92s | 0 | 0 |
| `opentasks` | 4 | 75% | 0.781 | 904,192 | 107s | 0 | 0 |

OpenTasks per-task result:

| Task | Status | Tokens | Seeded | Inspected | Updated | OpenTasks calls | Helper shorthand | Raw GitLab curl |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sde-add-wiki-page` | failure | 161,784 | 1 | 1 | 1 | 2 | 0 | 0 |
| `sde-change-branch-policy` | success | 309,789 | 1 | 1 | 1 | 2 | 0 | 7 |
| `sde-close-an-issue` | success | 220,400 | 1 | 1 | 1 | 3 | 2 | 1 |
| `sde-delete-stale-branch` | success | 212,219 | 1 | 1 | 1 | 2 | 0 | 3 |

Failure analysis:

- The only batch failure was OpenTasks on `sde-add-wiki-page`.
- GitLab wiki infrastructure was healthy: the per-cell wiki smoke created and
  read a wiki page through both the GitLab API and git-backed wiki route.
- The OpenTasks agent read the Sotopia README and recorded a successful
  OpenTasks attempt, but it never created the GitLab wiki page.
- Root cause: deterministic graph seeding stored the full instruction in
  `content`, but the task `title` was truncated before the final clause:
  "create a new wiki page under gitlab sotopia repository to introduce
  Sotopia." The agent used `list_tasks` but did not call `get_task`, so it acted
  on the shortened title.

Follow-up fix and validation:

- Seeded task titles now keep both the head and tail of long single-line TAC
  instructions, so the final action remains visible in list output.
- The OpenTasks TAC skill now tells agents to call `mcp__opentasks__get_task`
  on a seeded task and read full `content` before acting.
- Focused tests and build passed:
  `npm test -- src/__tests__/tac-docker-adapter.test.ts`,
  `npm test -- src/mcp/__tests__/server.test.ts src/__tests__/cli-tools.test.ts`,
  and `npm run build`.
- Targeted live validation on `sde-add-wiki-page` with the OpenTasks arm then
  passed: full score, 474,942 tokens, 148s latency, `remoteWikiCreated=1`,
  `gitlabApiWriteAttempts=1`, `gitlabApiWriteSucceeded=1`.
- The targeted validation still did not call `mcp__opentasks__get_task`; the
  visible title-tail fix was sufficient for this task. This means a future
  batch should track `get_task` explicitly if we want to verify the full-content
  graph contract rather than relying on title quality.
- Cleanup worked for both runs. Terraform state was empty after destroy; tagged
  EC2 instances were terminated, and no tagged volumes or security groups
  remained.

### GitLab 4-Task Seeded Batch + List Output Metrics

Runs:

- Failed provisioning attempt:
  `tac-gitlab-4task-3arm-listtasks-metrics-2026-06-24T17-00Z`
- Completed batch:
  `tac-gitlab-4task-3arm-listtasks-metrics-2026-06-24T17-10Z`
- model: `haiku`
- arms: `stock,notes,opentasks`
- tasks: `sde-delete-stale-branch`, `sde-close-an-issue`,
  `sde-change-branch-policy`, `sde-add-wiki-page`
- seed: `1`
- config: `tac-gitlab-4task-listtasks-metrics-v1`
- EC2: GitLab-only service slice, m7i.2xlarge workers, preseeded Docker volume
  snapshot `snap-0c7c6eb08119771e0`

Adapter/scaffolding changes before the batch:

- `list_tasks` now includes list-level guidance, per-task
  `fullContentAvailableViaGetTask`, and a per-task `getTaskHint` when full
  content is available.
- TAC trace metrics now track dynamic OpenTasks MCP calls by exact tool name,
  including `mainOpenTasksListTasksCallCount`,
  `mainOpenTasksGetTaskCallCount`, and
  `mainOpenTasksRecordAttemptCallCount`.

Provisioning attempt:

- The first 6-worker attempt failed before an eval run directory was created,
  likely due to EC2 provisioning/capacity behavior.
- Cleanup completed: Terraform state was empty, the tagged instances were
  terminated, and no tagged volumes or security groups remained.

Completed batch result:

| Arm | n | Success | S_partial | Tokens | p50 latency | EnvErr | Budget |
|---|---:|---:|---:|---:|---:|---:|---:|
| `stock` | 4 | 50% | 0.563 | 1,726,979 | 83s | 1 | 0 |
| `notes` | 4 | 50% | 0.563 | 792,354 | 78s | 1 | 0 |
| `opentasks` | 4 | 100% | 1.000 | 1,320,950 | 109s | 0 | 0 |

Per-task result:

| Task | Stock | Notes | OpenTasks |
|---|---|---|---|
| `sde-add-wiki-page` | failure, 0.25, 492,696 tok | failure, 0.25, 359,589 tok | success, 618,397 tok |
| `sde-change-branch-policy` | success, 1,059,726 tok | success, 285,309 tok | success, 299,790 tok |
| `sde-close-an-issue` | success, 174,557 tok | env_error | success, 244,938 tok |
| `sde-delete-stale-branch` | env_error | success, 147,456 tok | success, 157,825 tok |

OpenTasks metric findings:

| Task | Status | Tokens | `list_tasks` | `get_task` | `record_attempt` | Distinct OpenTasks tools |
|---|---|---:|---:|---:|---:|---:|
| `sde-add-wiki-page` | success | 618,397 | 1 | 0 | 2 | 2 |
| `sde-change-branch-policy` | success | 299,790 | 1 | 0 | 2 | 2 |
| `sde-close-an-issue` | success | 244,938 | 2 | 0 | 1 | 2 |
| `sde-delete-stale-branch` | success | 157,825 | 1 | 0 | 1 | 2 |

Findings:

- The OpenTasks arm passed all four tasks in this seed, including the wiki task
  that previously exposed the truncated-title failure mode.
- The new per-tool metrics are present in the summary output and the raw traces.
- The new `list_tasks` hints are present in `agent-stream.jsonl`. Agents still
  did not call `get_task`, so the current lift came from visible title/tail
  quality and seeded graph usage rather than from a reliable full-content read
  habit.
- The run remains noisy because one worker hit two sandbox env errors and was
  quarantined. That produced one env error in `notes` and one in `stock`, but no
  unstarted cells.
- Wiki behavior is still high variance across arms: OpenTasks created the wiki
  page successfully in this batch while `stock` and `notes` both failed despite
  partial progress.
- Cleanup worked: post-destroy verification passed, Terraform state was empty,
  all four tagged instances were terminated, and no tagged volumes or security
  groups remained.

### GitLab 4-Task Full-Content Metric Follow-Ups

Runs:

- Failed setup attempt:
  `tac-gitlab-4task-3arm-gettask-metrics-seed2-2026-06-24T18-30Z`
- Haiku repeated-seed batch:
  `tac-gitlab-4task-3arm-gettask-metrics-seed2b-2026-06-24T18-45Z`
- Sonnet comparison batch:
  `tac-sonnet-gitlab-4task-3arm-gettask-metrics-seed1-2026-06-24T19-30Z`
- tasks: `sde-delete-stale-branch`, `sde-close-an-issue`,
  `sde-change-branch-policy`, `sde-add-wiki-page`
- arms: `stock`, `notes`, `opentasks`
- EC2: GitLab-only service slice, 4 m7i.2xlarge workers, preseeded Docker
  volume snapshot `snap-0c7c6eb08119771e0`

Adapter/scaffolding changes before the batches:

- Added first-class trace metrics for full-content reads:
  `mainOpenTasksGetTaskCallCount`, `openTasksGetTaskCallsBeforeFirstBash`,
  `mainFullTaskContentReadBeforeFirstBash`,
  `seededTaskGetTaskCallCount`,
  `seededTaskGetTaskBeforeFirstBashCallCount`, and
  `seededTaskFullContentReadBeforeFirstBash`.
- Tightened the seeded OpenTasks prompt to require
  `mcp__opentasks__get_task` with the seeded task id before task-specific
  Bash/curl/git/python/API work.
- Focused TAC adapter tests and the build passed after the metric change.

Failed setup attempt:

- The first seed2 attempt forwarded `AWS_PROFILE=default` into the EC2 worker
  environment. The worker-local LiteLLM/Bedrock grader proxy failed because the
  profile was not present on the worker.
- The run was interrupted before useful cells completed. Terraform cleanup and
  post-destroy verification passed.

Haiku seed2 repeated batch result:

| Arm | n | Success | S_partial | Tokens | p50 latency | EnvErr | Budget |
|---|---:|---:|---:|---:|---:|---:|---:|
| `stock` | 4 | 100% | 1.000 | 1,128,662 | 86s | 0 | 0 |
| `notes` | 4 | 100% | 1.000 | 891,852 | 78s | 0 | 0 |
| `opentasks` | 4 | 100% | 1.000 | 1,570,435 | 117s | 0 | 0 |

Haiku OpenTasks metric findings:

| Task | Status | Tokens | `get_task` | seeded full content before Bash |
|---|---|---:|---:|---:|
| `sde-add-wiki-page` | success | 543,843 | 1 | 1 |
| `sde-change-branch-policy` | success | 353,793 | 1 | 1 |
| `sde-close-an-issue` | success | 301,884 | 1 | 1 |
| `sde-delete-stale-branch` | success | 370,915 | 1 | 0 |

Sonnet seed1 comparison result:

| Arm | n | Success | S_partial | Tokens | p50 latency | EnvErr | Budget |
|---|---:|---:|---:|---:|---:|---:|---:|
| `stock` | 4 | 75% | 0.813 | 825,243 | 91s | 0 | 0 |
| `notes` | 4 | 100% | 1.000 | 815,759 | 87s | 0 | 0 |
| `opentasks` | 4 | 100% | 1.000 | 1,538,511 | 134s | 0 | 0 |

Sonnet per-task result:

| Task | Stock | Notes | OpenTasks |
|---|---|---|---|
| `sde-add-wiki-page` | failure, 0.25, 307,356 tok | success, 308,982 tok | success, 345,022 tok |
| `sde-change-branch-policy` | success, 222,285 tok | success, 121,706 tok | success, 366,204 tok |
| `sde-close-an-issue` | success, 173,399 tok | success, 205,221 tok | success, 583,755 tok |
| `sde-delete-stale-branch` | success, 122,203 tok | success, 179,850 tok | success, 243,530 tok |

Findings:

- The full-content metric is now informative. It distinguishes "called
  `get_task` eventually" from "read the seeded task before acting."
- In the Haiku seed2 batch, OpenTasks called `get_task` on all four tasks but
  performed the pre-action seeded full-content read on only three. The stale
  branch cell called `get_task` after an initial Bash command.
- In the Sonnet seed1 batch, OpenTasks called `get_task` and read the seeded
  full content before first Bash on all four tasks.
- The Sonnet run is a useful capability comparison but not a benchmark claim:
  OpenTasks and notes both reached 4/4, while stock missed the wiki task.
- Cleanup worked for both completed batches. Terraform state was empty after
  destroy, the tagged instances were terminated, and no tagged volumes or
  security groups remained.

### Standalone OpenTasks Get-Task Protocol Smokes

Runs:

- seed 6 baseline after first strict prompt patch:
  `tac-haiku-gitlab-4task-opentasks-gettask-direct-seed6-2026-06-24T22-30Z`
- seed 7 after aligning the shared OpenTasks arm appendix with the seeded
  `get_task`-first prompt:
  `tac-haiku-gitlab-4task-opentasks-gettask-direct-seed7-2026-06-24T22-42Z`
- seed 8 after adding strict task-work timing metrics and trace backfill:
  `tac-haiku-gitlab-4task-opentasks-gettask-direct-seed8-2026-06-25T00-13Z`
- seed 9 after preferring the GitLab API helper and adding helper path
  normalization:
  `tac-haiku-gitlab-4task-opentasks-helper-pref-seed9-2026-06-25T00-27Z`
- model: Haiku via Bedrock
- arms: `opentasks` only
- tasks: `sde-delete-stale-branch`, `sde-close-an-issue`,
  `sde-change-branch-policy`, `sde-add-wiki-page`
- EC2: GitLab-only service slice, 4 m7i.2xlarge workers, Docker volume snapshot
  `snap-0c7c6eb08119771e0`

Aggregate:

| Run | n | Success | S_partial | Tokens | `get_task` mean | seeded full before Bash | seeded full before task work | helper mean | raw API curl mean | HTTP 404 mean | HTTP 5xx mean |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| seed 6 | 4 | 100% | 1.000 | 1,694,397 | 0.50 | 0.25 | 0.25 | 0.75 | 7.25 | 1.25 | 0.75 |
| seed 7 | 4 | 100% | 1.000 | 1,497,066 | 1.00 | 1.00 | 0.75 | 0.00 | 3.75 | 1.75 | 1.00 |
| seed 8 | 4 | 100% | 1.000 | 1,463,038 | 1.00 | 1.00 | 1.00 | 0.00 | 7.25 | 4.00 | 1.25 |
| seed 9 | 4 | 100% | 1.000 | 1,263,515 | 1.00 | 0.75 | 0.75 | 4.50 | 1.25 | 2.50 | 0.00 |
| seed 10c, 2 workers | 4 | 100% | 1.000 | 2,451,924 | 1.00 | 1.00 | 1.00 | 5.00 | 5.50 | 11.00 | 0.75 |
| seed 10d, 2 workers | 4 | 75% | 0.813 | 1,257,571 | 1.00 | 1.00 | 1.00 | 4.75 | 0.00 | 1.50 | 0.25 |
| seed 11, 2 workers | 4 | 100% | 1.000 | 1,359,235 | 1.00 | 1.00 | 0.75 | 2.50 | 3.00 | 2.75 | 0.00 |
| seed 12, 2 workers | 4 | 100% | 1.000 | 1,320,709 | 1.00 | 0.75 | 0.75 | 4.25 | 2.00 | 2.75 | 0.00 |

Seed 6 findings:

- The first strict prompt improved clarity but did not reliably change Haiku's
  behavior.
- `sde-add-wiki-page` and `sde-close-an-issue` still made no native OpenTasks
  calls in the main agent.
- `sde-delete-stale-branch` called `get_task`, but only after task-specific
  work had started.
- Trace inspection showed recurring failure modes: reading `/instruction/task.md`
  before `get_task`, shelling or Python-subprocessing the MCP tool name after
  ToolSearch, and combining multiple `select:` targets despite the prompt.

Intervention before seed 7:

- Aligned the shared OpenTasks arm appendix with the seeded `get_task`-first
  protocol. It had still told agents to select `list_tasks` or `record_attempt`,
  which conflicted with the seeded prompt.
- Tightened the OpenTasks skill and seeded prompt to say:
  use exactly `select:mcp__opentasks__get_task`, call native `get_task` next,
  do not read `/instruction/task.md` before `get_task`, and do not shell,
  Python, node, curl, or subagent the OpenTasks read.

Seed 7 findings:

- All four cells succeeded and all four called native `get_task` with the seeded
  task before first Bash.
- The first tool sequence improved materially on three tasks:
  `ToolSearch -> mcp__opentasks__get_task -> task work`.
- Manual trace derivation gives 3/4 seeded full-content reads before first
  task-work tool. The stale-branch trace still inserted an `Agent` delegation
  between ToolSearch and native `get_task`, so "before first Bash" is not strict
  enough for the coordination contract.
- Added stricter metrics after this run:
  `openTasksGetTaskCallsBeforeFirstTaskWork`,
  `mainFullTaskContentReadBeforeFirstTaskWork`,
  `seededTaskGetTaskBeforeFirstTaskWorkCallCount`, and
  `seededTaskFullContentReadBeforeFirstTaskWork`. These count `Read`, `Bash`,
  and agent delegation as task work, while allowing `ToolSearch` and native
  OpenTasks calls as graph-discovery work.
- One seed 7 worker cold-started GitLab because it did not find the preseeded
  GitLab Docker volumes, but the cell completed and cleanup still passed.

Seed 8 findings:

- All four cells succeeded with no environment errors.
- All four cells followed the intended first-tool sequence:
  `ToolSearch -> mcp__opentasks__get_task -> task work`.
- Strict seeded full-content read before first task-work improved to 4/4. This
  is the first Haiku run where the stronger OpenTasks coordination protocol held
  across the full 4-task GitLab slice.
- Each cell also recorded an OpenTasks update/attempt after task work.
- GitLab helper usage remained 0/4. Agents still used raw GitLab API curl
  heavily: 29 raw API curls across four cells, with 16 HTTP 404 signals and
  five HTTP 5xx signals. This makes GitLab helper ergonomics the next practical
  standalone optimization target.
- Terraform destroy and post-destroy verification passed for all three runs;
  tagged instances were terminated and no tagged volumes or security groups
  remained.

Intervention before seed 9:

- Strengthened the shared TAC GitLab operating guidance to prefer
  `tac-gitlab-api METHOD PATH [JSON_BODY]` over raw curl for GitLab REST API
  calls.
- Added concrete generic helper examples for project reads, branch reads,
  branch deletes, and issue-note writes.
- Extended `tac-gitlab-api` so shorthand paths such as
  `projects/root/repo/repository/branches/feature/old` are normalized to the
  URL-encoded GitLab API form.

Seed 9 findings:

- All four cells succeeded with no environment errors.
- Helper usage improved sharply: 18 helper calls across four cells, all using
  API shorthand paths. Raw GitLab API curl dropped from 29 calls in seed 8 to
  five calls in seed 9.
- HTTP 5xx signals dropped from five to zero. HTTP 404 signals dropped from 16
  to 10, but stale-branch still produced seven 404s while probing a deleted
  branch and branch-name path variants.
- Total tokens dropped from 1,463,038 in seed 8 to 1,263,515 in seed 9.
- Strict seeded full-content read before first task-work regressed from 4/4 to
  3/4. The failing stale-branch trace did not perform real GitLab work before
  `get_task`; it inserted `Bash echo "Fetching task..."` between ToolSearch and
  native `get_task`, which still violates the tool-order contract and trips the
  strict metric.
- Follow-up patch after seed 9: OpenTasks skill, seeded prompt, and arm appendix
  now explicitly forbid Bash status/logging commands between ToolSearch and the
  native OpenTasks tool call.
- Terraform destroy and post-destroy verification passed; tagged instances were
  terminated and no tagged volumes or security groups remained.

Seed 10d findings:

- Reran the same seed 10 4-task OpenTasks-only slice after making helper suffix
  quoting idempotent for already encoded branch/file/wiki/protected-branch
  tails.
- Strict OpenTasks coordination remained 4/4: every cell read the seeded task
  with native `mcp__opentasks__get_task` before task work, and every cell
  recorded an OpenTasks update afterward.
- The stale-branch target improved sharply. The cell used
  `tac-gitlab-api GET/DELETE/GET projects/root/OpenSearch/repository/branches/feature%2Fssl`,
  made zero raw GitLab API curl calls, and dropped from 1,347,214 tokens in
  seed 10c to 212,124 tokens.
- Across the whole 4-task run, raw GitLab API curl dropped from 22 calls in
  seed 10c to zero in seed 10d. Aggregate tokens dropped from 2,451,924 to
  1,257,571.
- The run was not a clean accuracy win: `sde-add-wiki-page` failed with 2/4
  earned checkpoints despite creating a remote wiki page. Trace inspection
  showed a separate helper normalization bug during README reads:
  `repository/files/README.md/raw?ref=main` was encoded as if `raw?ref=main`
  were part of the file path.
- Follow-up patch after seed 10d: helper normalization now preserves query
  strings and special-cases GitLab file raw paths as
  `repository/files/<file>/raw?ref=<ref>`.
- Terraform destroy and post-destroy verification passed; tagged instances were
  terminated and no tagged volumes or security groups remained.

Targeted wiki validation after file raw patch:

- Run:
  `tac-haiku-gitlab-wiki-opentasks-helper-file-raw-seed10-2026-06-25T03-40Z`.
- Scope: one OpenTasks/Haiku `sde-add-wiki-page` cell, seed 10, one EC2 worker.
- Result: success, `S_partial=1.000`, 437,362 tokens, no environment error.
- Strict seeded full-content read before task work remained true.
- The agent did not directly exercise the API file raw helper path in this
  trajectory; it read the README through GitLab web raw URLs, then used
  `tac-gitlab-api` for repository tree and wiki API operations.
- Terraform destroy and post-destroy verification passed; tagged instances were
  terminated and no tagged volumes or security groups remained.

Seed 10/10b bootstrap attempts:

- Two 4-worker relaunches were aborted before agent execution/model spend
  because one GitLab worker failed to become healthy during bootstrap.
- The observed failed worker state was `gitlab` unhealthy with local GitLab not
  serving the expected endpoint; in the second attempt `postgresql` was down
  while the other GitLab services were running.
- Cleanup traps ran successfully both times. Terraform destroy and explicit AWS
  checks showed tagged instances terminated and no tagged volumes or security
  groups remaining.

Seed 10c findings:

- Relaunched the same seed as a 2-worker pool. The pool scheduler still covered
  all four cells by queueing two cells per worker, and both workers bootstrapped
  cleanly.
- All four cells succeeded with no environment errors.
- Strict seeded full-content read before first task-work recovered to 4/4 after
  the anti-echo prompt patch. First tool sequence was consistently
  `ToolSearch -> mcp__opentasks__get_task -> task work`.
- Helper usage stayed high: 20 helper calls across four cells, all using API
  shorthand. The easiest tasks (`close issue`, `wiki page`) had zero raw GitLab
  API curl calls.
- The stale-branch cell still fell into a raw-curl verification loop: 18 raw
  GitLab API curls, 32 HTTP 404s, two HTTP 5xx signals, and 1,347,214 tokens.
  It succeeded, but this dominated the run cost.
- Trace inspection found a concrete helper bug: `tac-gitlab-api DELETE
  projects/root/OpenSearch/repository/branches/feature%2Fssl` double-encoded the
  already encoded branch tail to `feature%252Fssl`, causing the initial helper
  DELETE to 404.
- Follow-up patch after seed 10c: helper suffix normalization now decodes once
  before quoting branch/file/tag/wiki/protected-branch tails, so raw
  `feature/ssl` and encoded `feature%2Fssl` normalize idempotently.
- Terraform destroy and post-destroy verification passed; tagged instances were
  terminated and no tagged volumes or security groups remained.

Seed 11 findings after both helper normalization fixes:

- Run:
  `tac-haiku-gitlab-4task-opentasks-helper-fixed-seed11-2w-2026-06-25T03-48Z`.
- The full 4-task OpenTasks/Haiku slice succeeded with no environment errors:
  `S_partial=1.000`, 1,359,235 tokens, and p50 latency 118s.
- The cross-run summary extractor was validated across seed 10c, seed 10d, and
  seed 11. It shows the stale-branch helper fix holding across two full runs:
  raw GitLab API curl stayed at zero for that cell, while tokens were 212,124
  in seed 10d and 187,324 in seed 11, down from 1,347,214 in seed 10c.
- Strict seeded full-content read before first Bash remained 4/4, but strict
  full-content read before first task-work regressed to 3/4. The close-issue
  cell selected multiple OpenTasks tools, emitted an `Agent` event, then called
  native `get_task`; it still succeeded, but the trace violates the stronger
  coordination contract.
- Wiki succeeded, created the remote page, and kept the seeded task read before
  work, but this trajectory used raw GitLab/web curl rather than
  `tac-gitlab-api`. The file-raw helper path is fixed and covered by focused
  tests, but still needs a live trajectory that actually uses it.
- Branch-policy succeeded but fell back from helper calls to raw GitLab API curl
  for delete/recreate operations after helper/protected-branch friction. This
  leaves protected-branch helper ergonomics as another practical optimization
  target.
- Terraform destroy, runner post-destroy verification, and independent AWS
  tag-based checks passed. Tagged instances were terminated and no tagged
  volumes or security groups remained.

Seed 12 repeated-seed findings:

- Run:
  `tac-haiku-gitlab-4task-opentasks-helper-fixed-seed12-2w-2026-06-25T03-58Z`.
- The full 4-task OpenTasks/Haiku slice again succeeded with no environment
  errors: `S_partial=1.000`, 1,320,709 tokens, and p50 latency 108s.
- This run directly exercised the fixed file-raw helper trajectory. The wiki
  cell used only `tac-gitlab-api`, including
  `repository/files/README.md/raw`, created the remote wiki page, made zero raw
  GitLab API curl calls, and used 415,351 tokens.
- The stale-branch helper fix also held: zero raw GitLab API curl calls and
  188,158 tokens, almost identical to seed 11's 187,324-token cell.
- Strict OpenTasks coordination remained imperfect under Haiku. The stale-branch
  cell emitted a Bash status echo between ToolSearch and native `get_task`, so
  seeded full-content read before first Bash/task-work was 3/4. This repeats
  the broader pattern from seeds 9, 11, and 12: the agents usually call
  `get_task`, but weaker-model tool-order discipline is still not reliable.
- Branch-policy remains the noisiest task after the helper fixes. It succeeded,
  but helper attempts fell back into eight raw GitLab API curl calls, six HTTP
  404s, and 497,669 tokens. The next standalone optimization target should be
  protected-branch helper ergonomics or a more explicit generic helper example
  for delete/recreate policy changes.
- Terraform destroy, runner post-destroy verification, and independent AWS
  tag-based checks passed. Tagged instances were terminated and no tagged
  volumes or security groups remained.

### 2026-06-25 Standalone Optimization Sweep

This sweep stayed on standalone TAC with the `claude-code` harness and did not
use the full OpenHive/swarm-dispatch/swarm-harness stack. The goal was to
separate product/tooling effects from ecosystem orchestration effects.

Instrumentation and prompt changes:

- Added trace metrics for multi-select `ToolSearch` calls and protected-branch
  helper usage:
  `mainToolSearchMultiSelectCallCount` and
  `gitlabProtectedBranchHelperCallCount`.
- Tightened the OpenTasks appendix to ask for exactly one initial
  `mcp__opentasks__get_task` selection and to avoid comma-combined tool
  searches before the initial task read.
- Focused tests and TypeScript build passed after the patch:
  `npm test -- src/__tests__/tac-docker-adapter.test.ts` and
  `npm run build`.

Fixed-state 4-task, 3-arm Haiku comparison:

- Run:
  `tac-haiku-gitlab-4task-3arm-helper-fixed-seed12-2w-2026-06-25T05-02Z`.
- Tasks: stale branch, close issue, branch policy, wiki page.
- All three arms landed at the same aggregate score: 3/4 success,
  `S_partial=0.813`, no environment errors.
- Tokens: `notes=1,085,410`, `stock=1,188,876`,
  `opentasks=1,232,104`.
- The common miss was wiki. OpenTasks kept strict seeded full-content reads, so
  this result does not support the hypothesis that full task reads alone solve
  the wiki variance.

Protected-branch helper canary:

- Run:
  `tac-haiku-branch-policy-3arm-protect-helper-seed13-14-2w-2026-06-25T05-20Z`.
- All six cells succeeded with no environment errors.
- Tokens: `notes=147,585`, `stock=170,631`, `opentasks=465,546`.
- The helper path is now effective, but OpenTasks still pays visible
  coordination overhead on this simple single-action task.

OpenTasks-only coordination slice:

- Run:
  `tac-haiku-opentasks-coordination-seed15-16-2w-2026-06-25T05-40Z`.
- Result: 7/8 success, `S_partial=0.875`, one environment error from the Claude
  MCP smoke behavior rather than TAC service state.
- Six of eight cells satisfied the strict seeded full-content read metric. One
  successful branch-policy cell made 30 `ToolSearch` calls, made no native
  OpenTasks calls, and used 1,105,600 tokens.
- Follow-up decision: keep direct MCP preflight, but disable
  `TAC_OPENTASKS_CLAUDE_MCP_SMOKE_FAIL_FAST` for later runs. The smoke failure
  is a product/tool-discovery signal, not a reason to discard the cell as
  infrastructure failure.

Broader 8-task Haiku GitLab slice:

- Run:
  `tac-haiku-gitlab-8task-3arm-seed17-4w-2026-06-25T06-05Z`.
- Aggregate:
  - `notes`: 6/8 success, `S_partial=0.750`, one environment error,
    2,223,850 tokens.
  - `opentasks`: 5/8 success, `S_partial=0.667`, one environment error,
    5,160,025 tokens.
  - `stock`: 5/8 success, `S_partial=0.625`, two environment errors,
    4,191,215 tokens.
- The run is useful for failure discovery but too noisy for a benchmark claim.
  The pipeline task failed for every arm; the close-all-issues task caused
  timeout/env-error noise; issue-label management produced sandbox env errors
  for stock and notes while OpenTasks succeeded.
- Cleaner-task signal: wiki, branch-policy, close-issue, and stale-branch all
  succeeded across all arms. OpenTasks was token-cheapest on wiki but much more
  expensive on stale-branch because the Haiku cell ignored OpenTasks native
  calls and entered raw/helper retry churn.

Sonnet 4-task, 3-arm comparison:

- Run:
  `tac-sonnet-gitlab-4task-3arm-seed17-3w-2026-06-25T06-25Z`.
- Tasks: same 4-task GitLab core as above, seed 17.
- Aggregate:
  - `opentasks`: 4/4 success, `S_partial=1.000`, 1,367,647 tokens,
    p50 latency 136s.
  - `stock`: 4/4 success, `S_partial=1.000`, 954,890 tokens,
    p50 latency 89s.
  - `notes`: 3/4 success, `S_partial=0.813`, 839,291 tokens,
    p50 latency 89s.
- Sonnet used OpenTasks reliably in this run: every OpenTasks cell read the
  seeded task full content before task work and then updated the graph.
- OpenTasks' accuracy lift over notes came from the wiki task, but stock also
  solved wiki without OpenTasks. The cost/latency tax remains clear:
  OpenTasks used about 43% more tokens than stock on the same 4/4 successful
  seed.

Cross-run interpretation:

- The strongest current product win is not graph coordination by itself; it is
  better task visibility plus GitLab helper ergonomics. Helper fixes removed
  large raw-curl loops, and wiki visibility improved several trajectories.
- Standalone OpenTasks does improve reliability in some cells, especially wiki,
  but on this small sample it does not yet dominate stock/notes on
  accuracy-cost. Coordination often adds 80k-200k tokens on simple tasks.
- The main optimization target is now the coordination contract:
  make the first full task read cheap and reliable, eliminate `ToolSearch`
  loops/pending MCP behavior, and consider making post-action graph updates
  lighter or conditional for single-action TAC tasks.
- Keep the benchmark split into two sets: a clean 4-task core for optimization
  signal, and a noisy/stress GitLab set for infrastructure/helper discovery.
- All pools in this sweep destroyed successfully. Independent AWS checks showed
  terminated tagged instances, no tagged volumes, no tagged security groups,
  and empty `standalone-tac` Terraform state.

### Session Wrap-Up

Current ready state:

- The TAC GitLab slice can be run through `swarmkit-eval` with
  `stock`, `notes`, and `opentasks` arms.
- EC2 is the practical backend for larger TAC work. E2B remains useful for
  small Docker smoke tests, but TAC's service stack, Docker cache, disk, and
  runtime requirements make EC2 the better target for real rounds.
- The EC2 pool wrapper provisions multiple TAC service hosts, syncs OpenTasks,
  schedules one TAC cell per worker, quarantines workers after repeated
  environment failures, writes combined summaries, uploads to S3 when
  configured, and destroys workers by default.
- The two-volume Docker-cache design is the preferred repeated-run path: keep
  root volumes small and place Docker image/containerd state on a disposable
  snapshot-backed EBS data volume.
- Deterministic OpenTasks graph seeding is enabled by default for the
  OpenTasks arm, while the optional LLM graph prelude is disabled by default
  for benchmark fairness.
- The adapter has an explicit TAC agent harness seam. `claude-code` is the only
  implemented harness today, but future harnesses can plug in install,
  invocation, stream parsing, and usage extraction without rewriting TAC setup
  and scoring.
- GitLab preflights now catch common environment issues before model spend:
  health/token refresh, scratch wiki API create/read/delete, optional target
  wiki smoke in preflight-only mode, and LLM-grader proxy checks for
  LLM-graded tasks.
- OpenTasks list output and trace metrics are now instrumented enough to see
  whether agents inspected seeded tasks, updated graph state, and which exact
  MCP tools were used.
- Full-content graph reads are now first-class report metrics, including
  whether the seeded task was read with `get_task` before the first
  task-specific Bash call.

Outstanding work before a full benchmark claim:

- Run repeated seeds and a larger GitLab-only set. The latest 4-task result is
  a positive signal, not a statistically meaningful claim.
- Reduce sandbox env errors. Worker quarantine prevents cascading failures, but
  env-error cells still distort arm comparisons.
- Make full-content task reads more reliable across weaker models. The metric
  is now surfaced, and Sonnet read the seeded task before action on all four
  cells, but Haiku still misses the strict pre-action timing intermittently
  even after the prompt/tool-order fixes.
- Compare stronger models/harnesses, especially Sonnet-class Claude and the
  planned Azure/GPT adapter path, once the harness seam has another concrete
  implementation.
- Decide which OpenTasks guidance is benchmark-legitimate. Generic graph
  protocol and tool-use hygiene are acceptable; task-specific TAC playbooks
  should remain out of the prompt.
- Harden result persistence and resume behavior for multi-day full rounds:
  stable run manifests, S3 result sync, cell retry policy, cost/runtime
  budgets, and a PR/report artifact for every round.
- Audit E2B cleanup paths before any future E2B usage so TAC eval cleanup cannot
  terminate unrelated developer sandboxes.

### 2026-06-29 Team Protocol Smoke And Dispatch Gate

Goal:

- validate the `opentasks-team-contract` arm with `swarm-harness@0.3.5`,
  `TAC_TEAM_PROTOCOL=agent-inbox-v1`, and `azureoai/gpt-5.5`;
- measure protocol behavior separately from TAC score;
- decide whether dispatch is ready to become the carrier.

Runs:

| Run | Task | TAC result | Tokens | Env error | Protocol result |
|---|---|---:|---:|---:|---|
| `tac-team-protocol-smoke-2026-06-29T13-20Z` | `pm-update-plane-issue-from-gitlab-status` | `7/7`, full success | `92,986` | `0` | `teamProtocolPassed=0` |
| `tac-team-protocol-hard-2026-06-29T13-45Z` | `pm-update-gitlab-issue-from-plane-status` | `2/3`, failure | `67,276` | `0` | `teamProtocolPassed=0` |

What worked:

- EC2 pool provisioning and default cleanup completed; post-destroy
  verification passed and Terraform state was empty after both runs.
- `swarm-harness` spawned teams in both cells.
- Static role packets and team artifacts were produced.
- The durable OpenTasks helper path worked: both runs wrote durable evidence
  and verification records with graph record ids.
- Failure taxonomy stayed specific on the known-hard retry:
  `not_found_or_wrong_target`, not an undifferentiated failure.

What did not work:

- No live run exercised the explicit `agent-inbox-v1` assignment/reply flow.
  `teamInboxAssignmentCount`, `teamInboxEvidenceReplyCount`,
  `teamInboxVerifierRequestCount`, and `teamInboxVerifierReplyCount` were all
  zero in both cells.
- `teamProtocolNativeRoleEnforcement=0`, so roles were prompt-packet enforced
  only.
- The known-hard retry exposed a TAC helper/page-inspection gap: the team read
  Plane through `tac-plane-api`, interpreted both target issues as open, and
  made no GitLab write, while TAC's checkpoint expects `Model: security problem`
  to be closed.

Decision:

- Do not wire `swarm-dispatch` into live TAC yet. Dispatch should carry a
  working protocol, not hide the fact that static `swarm-harness` traces still
  lack explicit inbox assignment/reply events.
- Add dispatch only behind a fixture or a static-harness run that proves
  ordered assignment, evidence reply, durable OpenTasks evidence, verifier
  reply, and durable verification. The detailed carrier plan is in
  `docs/evaluations/2026-06-29-tac-dispatch-carrier-follow-up.md`.
