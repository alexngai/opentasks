# TheAgentCompany × OpenTasks — Experiment Design (2026-06-18)

**Status:** design for implementation. This is the concrete E2′ plan referenced by
[2026-06-14-P6-evaluation-design.md](./2026-06-14-P6-evaluation-design.md).
The harness is `swarmkit-eval`; TheAgentCompany (TAC) is a benchmark adapter.

## 0. Objective

Evaluate whether OpenTasks improves TAC performance as a **durable external
state substrate** while holding model, benchmark task, service state, agent
scaffold, and token budget fixed.

Headline question:

> On TAC SDE tasks, does `stock + OpenTasks MCP` beat `stock` and `stock +
> NOTES.md` on TAC-native `S_partial`, redundant exploration, and reliability
> at matched cost?

This is not a new benchmark. TAC supplies the task images, services, and
evaluator. OpenTasks is only a harness ablation.

## 1. TAC Task Inventory

Local TAC clone: `~/GitHub/TheAgentCompany`, 175 tasks total.

Full task dependency mix from `workspaces/tasks/*/dependencies.yml`:

| Dependency set | Count |
|---|---:|
| gitlab | 47 |
| owncloud+rocketchat | 33 |
| owncloud | 33 |
| rocketchat | 24 |
| gitlab+rocketchat | 15 |
| plane | 6 |
| plane+rocketchat | 5 |
| gitlab+plane | 5 |
| none | 3 |
| gitlab+owncloud | 2 |
| gitlab+owncloud+rocketchat | 1 |
| gitlab+owncloud+plane+rocketchat | 1 |

SDE subset: 69 tasks.

| Dependency set | Count |
|---|---:|
| gitlab | 44 |
| gitlab+rocketchat | 10 |
| plane | 4 |
| owncloud | 3 |
| none | 2 |
| gitlab+plane | 2 |
| gitlab+owncloud | 2 |
| rocketchat | 1 |
| gitlab+owncloud+rocketchat | 1 |

Implication: the first serious TAC experiment should be GitLab-only SDE. It
covers most of the SDE slice with one service and avoids browser/NPC/Plane
fragility while still exercising real TAC evaluators.

## 2. Harness Contract

`swarmkit-eval` owns:

- matrix expansion: task × arm × seed × model
- content-addressed result store and resume
- retries/backoff, concurrency caps, and report generation
- trace capture and aggregate/bootstrap CIs
- model selection through `EVAL_MODEL` and the NativeCliAdapter path

The `TACBenchmarkAdapter` owns:

- loading TAC task metadata from `workspaces/tasks/<task-id>/`
- selecting or building task images
- starting the required TAC services for a dependency set
- running `/utils/init.sh`
- presenting `/instruction/task.md` to the agent
- collecting the agent trajectory in the format expected by `/utils/eval.py`
- running `/utils/eval.py` with `DECRYPTION_KEY`
- parsing `result.json` into TAC-native score fields

Score mapping:

- `earned = result_json.final_score.result`
- `total = result_json.final_score.total`
- `S_fraction = earned / total`
- `S_full = earned == total`
- `S_partial = 0.5 * S_fraction + 0.5 * S_full`

Never read OpenTasks graph state for scoring.

## 3. Arms

All arms use the same TAC adapter, same model, same task image, same services,
same timeout, and same tool surface except for the state mechanism.

| Arm | Mechanism |
|---|---|
| `stock` | Native Claude-CLI context only |
| `notes` | Same runner plus instructed `NOTES.md` discipline |
| `opentasks` | Same runner plus OpenTasks MCP, daemon, and prompt nudge |

Browser/API rule: start API-only. If a task requires browser interaction, add
the same browser tool to all arms and label that task as browser-required.

## 4. Metrics

Primary:

- TAC `S_partial`
- `pass^k`: all-seed full-completion reliability per task
- total tokens, wall-clock, and `S_partial` per 100k tokens

Diagnostics:

- `readGraph`: whether the OpenTasks arm actually calls graph/context tools
- redundant exploration: repeated reads/searches of paths or service facts
- time-to-first-productive-action after start or reset
- setup/eval failure rate split from agent failure rate

Coordination metrics for multi-agent variants:

- duplicate service mutation attempts
- redundant work overlap across agents
- `O`, `E_c`, and `R` from traces

## 5. Experiment Sequence

### E2.0 — Adapter Smoke

Purpose: prove TAC can run inside `swarmkit-eval` without testing OpenTasks yet.

Matrix:

- tasks: `sde-install-go`, `sde-install-openjdk`, one GitLab-only task
- arms: `stock`
- seeds: 1
- model: cheapest available working model

Pass gate:

- task container starts
- `/utils/init.sh` completes
- agent runs to timeout or completion
- `/utils/eval.py` produces parseable `result.json`
- `swarmkit-eval` writes report/cache artifacts

### E2.1 — GitLab-Only Capability Smoke

Purpose: test whether the headless agent can solve TAC GitLab tasks without a
browser.

Suggested tasks:

| Task | Why |
|---|---|
| `sde-close-an-issue` | Small API mutation, clear evaluator |
| `sde-change-branch-policy` | GitLab settings mutation |
| `sde-collect-open-issues` | Read/query/write local artifact |
| `sde-add-wiki-page` | Multi-step read/summarize/write to GitLab |
| `sde-write-a-unit-test-for-append_file-function` | Clone/edit/test local code |

Matrix:

- arms: `stock`
- seeds: 1-2
- timeout: short enough to fail fast, then raise only if plumbing is clean

Pass gate:

- at least 3 of 5 tasks can complete or earn partial credit without browser
- evaluator failures are below 10%
- service state reset is reliable across seeds

Failure branch:

- If GitLab API-only cannot solve the small mutation tasks, add a browser MCP to
  all arms before running E2.2.

### E2.2 — Headline Pilot RCT

Purpose: first real OpenTasks-vs-notes-vs-stock signal on TAC.

Task set: 6 GitLab-only SDE tasks, stratified by work type.

| Stratum | Candidate tasks |
|---|---|
| service mutation | `sde-close-an-issue`, `sde-change-branch-policy` |
| service search/report | `sde-collect-open-issues`, `sde-create-commit-table-for-all-gitlab-users` |
| local code edit/test | `sde-write-a-unit-test-for-append_file-function`, `sde-fix-factual-mistake` |
| longer coding/MR | `sde-fix-rising-wave-datatype`, `sde-sotopia-create-agent` |

Pick one or two from each stratum after E2.1 identifies runnable tasks.

Matrix:

- arms: `stock`, `notes`, `opentasks`
- seeds: 3 per task/arm
- models: GLM-5 primary
- concurrency: 1 initially, then raise only after service reset is reliable

Decision rule:

- Go to E2.3 if `opentasks` has higher mean `S_partial` than both baselines or
  materially lower redundant exploration at similar `S_partial`.
- Fix prompt/context surfacing and rerun once if `readGraph` is low.
- If `notes` ties `opentasks` on both score and redundant exploration, OpenTasks
  is not load-bearing on GitLab-only single-session TAC; move to reset/width
  variants rather than scaling the same condition.

### E2.3 — Direct Retention Variant

Purpose: isolate the continuity claim on TAC instead of relying on natural task
length.

Protocol:

1. Run phase 1 until a fixed wall-clock/token budget or until the first
   checkpoint-looking action.
2. Stop the agent and discard conversation context.
3. Keep only the world state, workdir, and each arm's allowed durable state:
   none for `stock`, `NOTES.md` for `notes`, OpenTasks graph for `opentasks`.
4. Start phase 2 with the same task and remaining budget.
5. Score with unmodified TAC evaluator at the end.

Tasks:

- prefer long GitLab-only tasks whose progress is not fully obvious from local
  files: `sde-create-commit-table-for-all-gitlab-users`,
  `sde-add-wiki-page`, `sde-fix-rising-wave-datatype`,
  `sde-sotopia-create-agent`

Matrix:

- arms: `stock`, `notes`, `opentasks`
- tasks: 4
- seeds: 5
- reset timing: 30-40% of per-task budget

Primary diagnostics:

- phase-2 time-to-first-productive-action
- repeated service reads/searches
- retained work fraction: checkpoint progress at phase-1 end that survives to
  final evaluation

### E2.4 — Width / Scaling Variant

Purpose: test whether OpenTasks pushes out the negative-return point as agent
count grows.

Protocol:

- Run multiple agents against one TAC task instance and one shared service
  state.
- Give each arm the same aggregate token budget.
- For `opentasks`, require claim/attempt discipline.
- For `notes`, use a shared `NOTES.md` or shared task file with claim-by-
  convention.
- For `stock`, agents only share the environment.

Task classes:

- fan-out GitLab tasks: close many issues/PRs, collect all issues, create commit
  table
- multi-repo tasks: license changes, update docs across repos
- optional PM/Plane tasks after GitLab-only results are stable

Matrix:

- N: 1, 2, 4
- arms: `stock`, `notes`, `opentasks`
- tasks: 3
- seeds: 3

Decision rule:

- Report the largest N where each arm improves or maintains `S_partial` per
  token over N=1.
- OpenTasks wins this axis only if its duplicate/redundant work rate stays lower
  and `E_c` remains competitive after charging graph overhead.

### E2.5 — Full-Ecosystem Team Contract Variant

Purpose: test whether OpenTasks becomes more load-bearing when it is used as the
durable evidence/verification graph behind a structured team runtime, rather
than only as an optional MCP graph exposed to one agent.

Design: [2026-06-26 TAC OpenTeams team contract design](./2026-06-26-tac-openteams-team-contract-design.md).

Protocol:

- Use OpenTeams to declare TAC roles, topology, communication channels, and
  capability loadouts.
- Use openswarm to run the coordinator and workers.
- Use OpenTasks for root task content, subtasks, evidence, decisions, and
  verification records.
- Use swarm-dispatch for claim/retry/continuation only after the static team
  contract smoke proves productive coordination.
- Keep TAC evaluator scoring unchanged; graph state is diagnostic only.

Decision rule:

- Scale only if at least two agents use OpenTasks graph state, a child produces
  useful evidence, the coordinator consumes that evidence before mutation, and
  an independent verifier records final evidence.
- Treat mere worker spawning as insufficient evidence of coordination.

## 6. Pre-Registered Null Branches

- If `opentasks` is not read, the experiment is an adoption failure, not a
  substrate failure. Fix the prompt/initial graph summary and rerun once.
- If all arms saturate near `S_partial=1.0`, increase task difficulty or lower
  the budget; do not claim no effect from saturated cells.
- If `notes` ties `opentasks` in single-session TAC, move to reset/width cells;
  disciplined notes are expected to be competitive when the state fits in one
  file and no atomicity is needed.
- If browser-required tasks fail API-only, browser capability becomes a constant
  tool across all arms, not an OpenTasks-specific affordance.
- If evaluator failures exceed 10%, freeze experiments and harden service reset
  / eval parsing first.

## 7. Implementation Order

1. Build `evals/tac/` adapter around `swarmkit-eval`.
2. Implement task metadata loader and dependency filter (`sde`, `gitlab-only`,
   `has-scenarios`, service set).
3. Implement single-task lifecycle: pull/build image, init, run agent, run eval,
   parse score.
4. Add arms by reusing `evals/arms.ts` semantics.
5. Run E2.0 and E2.1.
6. Add TAC-specific metrics extraction.
7. Run E2.2 pilot and write dated result summary.
8. Add reset support for E2.3 only after E2.2 proves the baseline path stable.

## 8. Remote Compute / E2B Scope

Remote execution is a requirement before scaling TAC. The local Mac path is only
for adapter development and small GitLab-only smoke tests.

### 8.1 Execution Shapes

There are three possible E2B shapes.

| Shape | Description | Pros | Risks |
|---|---|---|---|
| **A. E2B sandbox runs Docker** | Create an E2B template with Docker/Compose installed; inside each sandbox, pull/run TAC task image and required service containers. | Closest to local Docker semantics; least TAC-specific rewrite. | Nested Docker cost, image-pull latency, memory pressure, host-network differences. |
| **B. E2B template per service slice** | Pre-bake GitLab-only (and later full-stack) TAC services into an E2B template/snapshot; each cell starts from that ready state. | Fast startup and deterministic reset if snapshots work. | Heavy template builds; GitLab/Plane may be too large; snapshotting long-running Docker services needs validation. |
| **C. External service host + E2B task sandboxes** | Keep TAC services on a persistent Linux host; E2B sandboxes run only task containers/agents and connect over network. | Cheapest per-cell sandbox; avoids nested service startup. | Requires network reachability, stable DNS/TLS, service reset orchestration outside E2B. |

Recommended path:

1. **Spike Shape A** for one GitLab-only task because E2B documents Docker and
   Docker Compose templates, and it matches the `TacDockerAdapter` lifecycle
   most closely.
2. If image pulls or GitLab service startup are too slow, move to **Shape C**:
   one persistent remote TAC GitLab host plus E2B per-cell task/agent sandboxes.
3. Consider **Shape B** only if E2B snapshots can reliably capture a warmed TAC
   service stack and template size/startup remain acceptable.

### 8.2 Adapter Boundary

The existing `swarmkit-eval` `E2BBackend` provisions one sandbox and exposes it
as a `Workspace`. The TAC implementation follows that boundary: `TacDockerAdapter`
is a backend-placed adapter that expresses task lifecycle operations as workspace
commands/files, then runs Docker inside that workspace.

The placement contract is:

- `EVAL_BACKEND=in-process`: run the adapter against the local workspace and host
  Docker. This is for local/EC2 smoke runs.
- `EVAL_BACKEND=e2b`: run the same adapter against an E2B workspace. The E2B
  template must provide Docker; OpenTasks must be baked/uploaded for the
  `opentasks` arm.

This keeps the TAC semantics identical across local and E2B. The only difference
is where commands run.

Backend `setupCommands` run once per acquired sandbox/cell. Starting TAC
services there is correct for isolation, but repeats GitLab warmup cost for
every cell unless we move to snapshots or a persistent service host.

### 8.3 E2B Spike Gates

Before running E2.0 remotely, prove these in order:

1. **Docker-in-E2B gate:** an E2B sandbox can run `docker run --rm hello-world`
   and `docker compose version`.
2. **TAC task-image gate:** an E2B sandbox can pull and run one TAC task image,
   then read `/instruction/task.md`.
3. **GitLab service gate:** either start TAC GitLab in the sandbox, or reach an
   external TAC GitLab host from inside E2B.
4. **Agent gate:** Claude CLI runs inside the E2B sandbox with the same model
   routing as local `swarmkit-eval`.
5. **OpenTasks gate:** the `opentasks` arm can start the MCP/daemon inside the
   sandbox and the agent can call graph tools.
6. **Evaluator gate:** `/utils/eval.py` runs in the task container and writes
   parseable `result.json`.

Only after all six gates pass should E2.0 run on E2B.

Observed status on 2026-06-18:

- Gate 1 passed with template `opentasks-tac-docker`: `sudo docker version`,
  `sudo docker compose version`, and `sudo docker run --rm hello-world` work in
  E2B.
- Gate 2 passed: the E2B sandbox can pull/run
  `ghcr.io/theagentcompany/sde-add-one-gitlab-pipeline-image:1.0.0` and read
  `/instruction/task.md` plus `/utils/init.sh` and `/utils/eval.py`.
- Gate 3 failed for Shape A on the current sandbox size: pulling/extracting
  `ghcr.io/theagentcompany/servers-gitlab:1.0.0` hit `no space left on device`.
- Larger-capacity check: existing team templates such as
  `e2b_gym_server_staging` and `name-your-template-dev` mount about 35 GB at
  `/` and already have Docker installed. On `e2b_gym_server_staging`, TAC
  GitLab pulls successfully, starts, and reaches healthy status with
  `localhost:8929` returning a redirect.
- The larger GitLab-only sandbox is still tight: after GitLab is healthy, the
  filesystem is about 92% used with only about 2.8 GB free. Use 35-37 GB as the
  minimum viable Shape A size for one GitLab-backed cell, not the target size
  for full TAC.
- The installed E2B CLI/JS SDK build path exposes CPU and RAM options but no
  disk-size option; `diskSizeMB` is visible on listed templates/sandboxes but
  not accepted by the public build option shape we are using. Practically, that
  means larger disk capacity currently comes from pre-existing larger templates
  or an E2B-side account/template setting, not from `npx e2b template build`.

### 8.4 Resource Sizing

Use larger templates than the E2B Docker example defaults:

- Docker-only task-container spike: at least 2 vCPU / 2 GB RAM.
- GitLab-only service spike: at least 35-37 GB disk, 4 vCPU, and 6 GB RAM; prefer
  materially more disk headroom if E2B can provision it.
- Full TAC stack: assume EC2 t3.2xlarge-class resources until measured.

### 8.5 Open Questions

- Does E2B allow the Docker networking mode TAC needs, or must we patch TAC
  service URLs away from host networking?
- Are GHCR image pulls fast and reliable enough, or do we need a pre-pulled
  template layer?
- Can E2B snapshots capture warmed Docker services robustly?
- Is per-cell E2B cost lower than a persistent EC2 worker when GitLab warmup is
  included?
- Should the result store be remote-backed before large E2B runs, so failed
  controller sessions do not strand run artifacts?

## 9. Reporting Template

Each result write-up should include:

- exact TAC commit/tag and task image version
- service dependency set and service reset method
- model ID, proxy path, token budget, timeout, concurrency
- task × arm × seed matrix
- score table with CIs
- infra failure table separated from agent failures
- graph adoption table (`readGraph`, graph tool count)
- redundant exploration table
- decision: scale, rerun with fix, move to reset/width, or stop
