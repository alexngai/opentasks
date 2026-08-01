# OpenTasks evals on `swarmkit-eval`

Runs OpenTasks' **own** eval tasks + arms through the shared
[`swarmkit-eval`](../../../swarmkit/src/eval) package instead of the local `evals/` runner —
a proof that the ecosystem can share one eval substrate (matrix → sealed boundary → `claude -p` →
ground-truth grade → content-addressed store/resume → cluster-bootstrap stats → Pareto/CI report).

This is now the **canonical** harness: the homegrown entrypoints (`../run.ts`, `../reset-runner.ts`,
`../synthetic/run.ts`) have been retired in favour of swarmkit-eval. `../runner.ts` (the `claude -p`
spawn/parse/score helpers) and `../metrics.ts` (the graph-adoption diagnostics) remain as the shared
OpenTasks-specific pieces these adapters build on.

Two entrypoints:
- **`run.ts`** — the single-agent E2′ tasks (smoke / build-todo), 3 arms, checkpoint grading. (Below.)
- **`synth-run.ts`** — the **synthetic emit-queue 2×2** (concurrency × continuity, cells B/C/D) — the
  active eval. ([jump](#synthetic-emit-queue-2×2-cells-bcd))

## Why this is a thin layer

OpenTasks' eval types are a near-exact ancestor of swarmkit-eval's, so [`bench.ts`](./bench.ts) is a
field-rename, not a rewrite:

| OpenTasks (`../types.ts`) | swarmkit-eval |
|---|---|
| `EvalArm{systemPromptAppendix, extraTools, mcp}` | `Arm.scaffold{systemPromptAppendix, extraTools, mcpServers}` |
| `EvalTask{prompt, setupFiles, checkpoints}` | `EvalTask{prompt, setup.files, checkpoints}` |
| `Check{fileExists\|fileContains\|cmd}` | `Check` (identical subset) |
| `S_partial = 0.5·(earned/total)+0.5·S_full` | `Score.partial` (same formula) |
| `claude -p` runner | `NativeCliAdapter` |

## Setup & dependency

**Verified 2026-06-17:** this entrypoint runs end-to-end today — `EVAL_MOCK=1`
(pipeline) and a real `EVAL_ARMS=stock,notes` run (live `claude -p` via the
Max-plan keychain, 0 env errors) both produce the full CI + Pareto report.

**Dependency (pinned `^0.1.0` in `package.json`).** `swarmkit-eval` is published and
pinned here as a devDependency — no symlink, no sibling-repo requirement,
reproducible on CI. The WorkBench Tier-2 exports (`workbenchNativeBenchmark`,
`WorkbenchGrader`, the `marble` engine) require ≥ 0.1.0.

Validated against the **published** package: `EVAL_MOCK=1 run.ts` (the E2′
pipeline), `EVAL_FAKE=1 EVAL_CELL=D synth-run.ts` (the synthetic 2×2 metric
aggregation: `doubleEmits`/`p2ReEmits`/`exactlyOnce` → per-arm CIs), and
`bench-check.ts` (the `metricsOf` diagnostics hook, added in 0.0.3) are all green.
Bump the pin as swarmkit-eval evolves; for live co-dev of the package,
`npm link swarmkit-eval` against a local checkout.

> **Note:** `evals/` is outside the `tsconfig.json` `include` (which is `src/**/*`),
> so `npm run build` does **not** typecheck these adapters. To check them:
> `npx tsc --noEmit -p <a tsconfig extending the root one with `include: ["evals/**/*.ts"]`>`.
> `evals/tac/` and `synth-marble.ts` currently carry pre-existing type errors under
> that check; the WorkBench entrypoints are clean.

## Run

```bash
# zero-token plumbing check (MockAdapter; validates matrix → grade → stats → report):
EVAL_MOCK=1 EVAL_REPEATS=8 npx tsx evals/swarmkit/run.ts

# real run, no MCP / no opentasks build needed:
EVAL_ARMS=stock,notes npx tsx evals/swarmkit/run.ts

# all 3 arms (the opentasks-MCP arm needs dist/cli.js):
npm run build && npx tsx evals/swarmkit/run.ts

# harder, multi-checkpoint task (needs python3 on PATH):
EVAL_TASKS=build-todo EVAL_REPEATS=3 npx tsx evals/swarmkit/run.ts
```

Outputs per-cell lines + a Markdown report to the console, and writes
`evals/.swarmkit-runs/report.{md,html,json}` (plus the content-addressed `cache/` — a second run of the
same cells resumes instead of re-spawning).

### Env

| var | default | meaning |
|---|---|---|
| `EVAL_MODEL` | `haiku` | `claude --model` id |
| `EVAL_ARMS` | `stock,notes,opentasks` | comma list |
| `EVAL_TASKS` | `smoke-greeting` | comma list (`smoke-greeting`, `build-todo`) |
| `EVAL_REPEATS` | `1` | seeds per cell |
| `EVAL_CONCURRENCY` | `2` | concurrent cells |
| `EVAL_MOCK` | — | `1` → MockAdapter (smoke task, zero tokens) |
| `EVAL_PASS_ANTHROPIC` | — | `1` → forward `ANTHROPIC_BASE_URL`/`API_KEY` (GLM-5/gateway runs) |

## Notes & known differences vs the local runner

- **Auth.** By default the spawned `claude` uses the box's **Max-plan keychain** login. Ambient
  `ANTHROPIC_BASE_URL` (Claude Code sets one) is deliberately **not** forwarded — forwarding it ran the
  agent as "Not logged in". For a GLM-5/gateway stack, set `EVAL_PASS_ANTHROPIC=1` (and the Bedrock/
  proxy vars). *(This also required a fix in swarmkit-eval's `native-cli` adapter — it now scrubs ambient
  `ANTHROPIC_*` so it can't clobber keychain auth, and classifies "Not logged in" as an `env_error`.)*
- **Stats are task-clustered.** swarmkit-eval averages seeds into per-task scores and bootstraps the CI
  over **tasks** (the D9 methodology), so a single task yields a degenerate `n=1` CI. Real CIs need a
  task **suite** — the local runner's per-repeat variance is not a substitute.
- **Diagnostics (ported, 0.0.3):** the `readGraph` / `redundantExplorationOps` metrics (`../metrics.ts`)
  are folded onto the score by [`bench.ts`](./bench.ts)'s `metricsOf` hook. swarmkit-eval's `native-cli`
  captures the full per-tool-call trajectory (`{type:'tool', name, input}` per `tool_use` block), and the
  orchestrator's `metricsOf` seam (new in 0.0.3) derives the graph-adoption scalars from it post-grade —
  never affecting pass/fail — so they aggregate into per-arm CIs. *(The cross-session **reset** mode is
  also ported — see cells C/D below, phase1→reset→phase2 through swarmkit-eval.)*
- **Cost** is blank unless you run through swarmkit-eval's LiteLLM gateway (cost comes from the
  spend-log, not the CLI's self-estimate).

---

## Synthetic emit-queue 2×2 (cells B/C/D)

`synth-run.ts` runs OpenTasks' **active** eval — the concurrency × continuity microbenchmark
(`../synthetic/`) — through swarmkit-eval. N agents share a queue + an HTTP collector (`./emit <id>`,
no read path); ground truth = each item emitted **exactly once**. Cells: **B** concurrency (N agents,
1 session), **C** continuity (1 agent across a reset), **D** both (swarm × reset).

The multi-agent + collector + reset **execution is unchanged** — `synth-adapter.ts` wraps the existing
`concurrency`/`continuity`/`celld` runners as a swarmkit-eval `ExecutionAdapter` (`placement: 'self'`).
swarmkit-eval adds what the local runner lacks: **cluster-bootstrap CIs over repeats** + a report, so the
race metrics get confidence intervals instead of raw "5/5 vs 0/5" counts.

- Each **repeat** is modelled as a swarmkit "task" → the bootstrap CI is over trials (the synthetic eval's
  unit of power). More repeats = more bootstrap units. `rm -rf evals/.swarmkit-synth` to force fresh trials
  (the content-addressed store otherwise resumes completed trials).
- The race counts ride in `score.metrics` (`doubleEmits`, `p2ReEmits`, `missed`, `exactlyOnce`), which
  swarmkit-eval's `aggregate()` now turns into per-arm CIs (rendered in a **Metrics** table) — this needed a
  small swarmkit-eval change (metric aggregation + render).

```bash
# zero-token pipeline validation (deterministic planted result; no agents):
EVAL_FAKE=1 EVAL_CELL=D EVAL_M=8 EVAL_K=4 EVAL_REPEATS=8 npx tsx evals/swarmkit/synth-run.ts

# real (needs `npm run build` for the opentasks arm's MCP/daemon):
EVAL_CELL=B EVAL_N=2 EVAL_M=4 EVAL_REPEATS=3 npx tsx evals/swarmkit/synth-run.ts
EVAL_CELL=D EVAL_N=2 EVAL_M=8 EVAL_K=4 EVAL_REPEATS=5 npx tsx evals/swarmkit/synth-run.ts
```

| var | default | meaning |
|---|---|---|
| `EVAL_CELL` | `B` | `B` concurrency · `C` continuity · `D` both |
| `EVAL_N` | `2` | agents per cell |
| `EVAL_M` | `6` | queue length |
| `EVAL_K` | `~M/2` | items phase-1 does before the reset (C/D) |
| `EVAL_REPEATS` | `3` | trials per arm = bootstrap units |
| `EVAL_FAKE` | — | `1` → deterministic zero-token runners |
| `EVAL_PHASE1_MS` / `EVAL_TIMEOUT` | `200000` / `240000` | phase budgets |

**Validated:** `EVAL_FAKE` reproduces the full 2×2 incl. reset metrics with CIs; a real cell-B run
(stock vs opentasks, N=2, M=3) reproduced it live — **stock doubleEmits 3.00 (every item raced), opentasks
0.00 / exactly-once 3/3** — at ~3× the tokens (the coordination cost, visible on the Pareto frontier).

---

## RoadmapBench (`roadmap-run.ts`) — the long-horizon anchor

`roadmap-run.ts` runs **RoadmapBench** (arXiv:2605.15846) — start on a source-version repo snapshot,
implement the functionality of a *later* target version from a multi-target roadmap, ordering 3–12
sub-goals yourself (median **3,700 LoC across 51 files**, **2h wall-clock cap**). This is the
long-horizon/state regime the earlier evals lacked. Grading is **Harbor-owned and test-based**
(`test.sh` → reward: Resolved Rate + weighted Completion Score) — ground truth, never graph state.

**One substrate — Harbor** (`execution: "harbor"`), so every agent is directly comparable:
- `claude-code` — Harbor built-in agent.
- `openswarm` — via openswarm's **own** Harbor agent (`openswarm_harbor_agent:OpenswarmAgent`, a
  `BaseInstalledAgent` Harbor loads by import path). Chosen over ACP because ACP loses token/cost
  accounting and model routing. Multi-agent coordinator team via `--ak swarm=true`.

The **model is pinned per arm** (Bedrock Anthropic / Bedrock-via-gateway / Azure-via-gateway) and each
arm runs in its own `runEval`, so we get exactly the `(agent, model)` pairs — not the arm×model
cross-product. Results merge into one report.

```bash
# zero-token substrate smoke (nop agent; local docker image auto-used). VALIDATED 2026-07-02:
#   fal-1.3.0-roadmap | nop → status=failure reward=0.000 tokens=0 (~160s) — correct nop outcome.
npx tsx evals/swarmkit/roadmap-run.ts

# single real arm (needs the arm's creds — see below):
ROADMAP_ARMS=claude-code-bedrock npx tsx evals/swarmkit/roadmap-run.ts

# the full comparison on e2b:
ROADMAP_ARMS=claude-code-bedrock,openswarm-bedrock,openswarm-azure \
  ROADMAP_ENVIRONMENT=e2b npx tsx evals/swarmkit/roadmap-run.ts
```

### Arms (registry in `roadmap-run.ts`)

| arm id | agent | model (env override) | needs |
|---|---|---|---|
| `nop` | `nop` | `nop/mock` | — (zero-token smoke) |
| `claude-code-bedrock` | `claude-code` | `ROADMAP_CLAUDE_BEDROCK_MODEL` | AWS creds + `CLAUDE_CODE_USE_BEDROCK=1` |
| `openswarm-bedrock` | `openswarm_harbor_agent:OpenswarmAgent` | `ROADMAP_OPENSWARM_BEDROCK_MODEL` | LiteLLM gateway (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`) |
| `openswarm-azure` | `openswarm_harbor_agent:OpenswarmAgent` | `ROADMAP_OPENSWARM_AZURE_MODEL` | gateway (Azure route) |
| `openswarm-bedrock-swarm` | same, `--ak swarm=true` | `ROADMAP_OPENSWARM_BEDROCK_MODEL` | gateway (multi-agent / E1) |

### Env

| var | default | meaning |
|---|---|---|
| `ROADMAP_DATA_DIR` | `evals/.roadmap-data` | dir of `<task>/task.toml` (gitignored; staged from the HF dataset) |
| `ROADMAP_ARMS` | `nop` | comma list from the registry |
| `ROADMAP_TASK_IDS` / `ROADMAP_TASK_LIMIT` | — / `1` | task subset / cap |
| `ROADMAP_ENVIRONMENT` | `docker` | `docker` (proven, local image) or `e2b` |
| `ROADMAP_SEEDS` | `1` | seeds per cell |
| `ROADMAP_TIMEOUT_MS` | `5400000` | per-trial cap (90min, under the 2h benchmark cap) |
| `ROADMAP_OPENSWARM_HARBOR_DIR` | `~/GitHub/openswarm/integrations/harbor` | PYTHONPATH for openswarm's Harbor agent |

### Setup notes

- **`roadmapBench` now ships in the pinned dependency.** This note previously said it was
  `npm link`-only; the pin has since moved to `^0.1.0` (installed: 0.1.0), which exports
  `roadmapBench` / `roadmapBenchArms`. No symlink needed.
- **The RoadmapBench task dir** (`task.toml` + `instruction.md` + sealed `tests/`/`solution/`) is staged
  under `evals/.roadmap-data/` (gitignored). The `fal-1.3.0-roadmap` image (`znpt/roadmapbench-*`) is
  auto-pulled by Harbor.
- **openswarm** installs itself in-sandbox from npm (`openswarm@latest`, ≥0.3.7 has the engine fix). Its
  Harbor agent + parser must be importable by the host Harbor process → the runner sets `PYTHONPATH` to
  `ROADMAP_OPENSWARM_HARBOR_DIR` whenever an openswarm arm is selected.
- **Creds ride in the ambient env** (forwarded into the Harbor process/sandbox, never baked into arm
  content hashes): AWS_*/`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (gateway),
  `E2B_API_KEY` (e2b).

### OpenTasks arm — the one remaining piece

Harbor agents install and run **inside the sandbox**, so an OpenTasks-MCP arm can't just pass a host
`--mcp-config`: it needs `opentasks` installed + its daemon started **in-container**, and a
`.mcp.json`/`.openswarm/mcp.json` pointing at the in-container MCP (the pattern `evals/tac/docker-adapter.ts`
uses). That container-side wiring is the next step; the agent×model comparison above stands on its own
(openswarm *is* the multi-agent/coordination story).

## WorkBench × OpenTasks (`workbench-run.ts` · `npm run eval:workbench`)

Benchmark OpenTasks — as a *planning/coordination scaffold* — on **WorkBench** (olly-styles/WorkBench
"Revisited": 690 outcome-graded workplace-agent tasks over calendar/email/analytics/CRM/project-board;
graded by replaying the agent's recorded side-effecting tool calls against a fresh sandbox, plus a
**harmful-action** flag).

**Where the code lives.** Everything WorkBench-specific is in `swarmkit-eval`, not here: the tool bridge
(`wb_mcp.py`, WorkBench's 26 tools over MCP), the faithful `{kind:"workbench"}` grader (`wb_grade.py`,
WorkBench's own `is_correct`/`has_side_effects`), and the benchmark (`workbenchNativeBenchmark`). This
entrypoint only **composes** them with OpenTasks arms — no WorkBench knowledge here, and **no change to
OpenTasks core**.

**Arms** (same model, same tasks; only the scaffold varies):

| arm | scaffold |
|-----|----------|
| `stock` | WorkBench tools only (`mcp__workbench__*`) |
| `notes` | + a NOTES.md durable-log nudge |
| `opentasks` | + the OpenTasks MCP graph (`mcp__opentasks__*`) as a planning/decomposition scaffold |

**Base OpenTasks functionality only — no daemon changes required:**
- **Isolation** is a relative `OPENTASKS_PROJECT_DIR=.opentasks` in the opentasks-MCP env → resolves
  against each cell's workspace cwd → every cell gets its own `.opentasks/` + daemon.
- **Teardown**: after the run the entrypoint reaps **only** opentasks daemons started from *this build's*
  `dist/cli.js` that appeared during the run (path-scoped + new-PID — never touches another project's
  daemon). Optionally set `OPENTASKS_DAEMON_IDLE_TIMEOUT` to let them self-reap (a no-op on builds that
  don't support it).

**Setup:** `git clone …/WorkBench ~/GitHub/WorkBench && cd ~/GitHub/WorkBench && uv sync && uv pip install mcp`,
then `npm run build` here so the opentasks arm's MCP server (`dist/cli.js`) exists.

```sh
# via the LiteLLM gateway (Bedrock, no local model); or drop WB_GATEWAY_BASE_URL for ambient Max-plan auth
WB_GATEWAY_BASE_URL=http://127.0.0.1:4000 WORKBENCH_LLM_API_KEY=sk-… AWS_REGION=us-east-1 \
  EVAL_ARMS=stock,opentasks EVAL_DOMAIN=multi_domain EVAL_TASK_LIMIT=20 EVAL_REPEATS=3 \
  npm run eval:workbench
```

The report (→ `evals/.swarmkit-workbench/report.md`) gives per-arm **completion** + **harmful-action**
rates with 95% CIs and a paired stock-vs-opentasks Δ. A first live smoke (3 email tasks, claude-haiku via
Bedrock) ran clean end-to-end: stock 0.33 vs opentasks 1.00 completion, 0 harmful, 0 env-errors — not
significant at n=3 (that's the point of the CIs). **Arena note:** single-domain tasks are 1–4 tool calls —
too short for a planning scaffold to move the needle; the real signal is on the `multi_domain` tasks and,
ultimately, multi-agent (Tier 2), where a duplicate side effect from two agents = a WorkBench harmful
action = the coordination payoff.

## WorkBench × OpenTasks — Tier 2: multi-agent coordination (`workbench-marble-run.ts` · `npm run eval:workbench:marble`)

Tier 1 puts WorkBench *behind* one OpenTasks-scaffolded agent; **Tier 2** puts N agents on ONE WorkBench
`multi_domain` task, sharing one sandbox + workspace, coordinating through OpenTasks' `claim_next`. Grading
replays the **union** of all agents' side-effecting tool calls — so a *duplicate* side effect (two agents
both send the same email) becomes a WorkBench **harmful action**. That duplication is exactly what
`claim_next` is meant to prevent → the coordination payoff, on realistic outcome-graded work.

Runs on swarmkit-eval's native `marble` engine (`execution: 'marble'`): the WorkBench substrate is a
first-class *service* (`workbench-marble.ts`) that seeds one claimable subtask per public domain, and each
agent's prompt says claim → do that domain's WorkBench actions → close. Arms: `stock` (no channel),
`notes` (claims.txt), `opentasks` (`claim_next`). All WorkBench machinery stays in swarmkit-eval; the
marble adapter only composes. **No OpenTasks core change.**

### Two gotchas that silently disabled coordination (both fixed)

Symptom of either: `Daemon did not start within 10000ms` / `no daemon running`, both agents duplicate → a
false Δ=0. Isolation tests pass while the eval fails, because the login shell hides both.

1. **Daemon socket path.** One daemon per cell on a SHORT `/tmp/ote-XXXXXX/daemon.sock` — a socket nested
   under the deep in-process workspace exceeds macOS's 103-byte `sun_path` limit and silently fails to
   bind. The path is published to `ws.root/.ot_sock`; each agent attaches as a thin `mcp --socket` client
   (`OPENTASKS_NO_AUTOSTART=1`, the CooperBench pattern).
2. **Native-module ABI.** The eval runs under `npx tsx`, whose node can differ from the one that built
   OpenTasks' `better-sqlite3` (e.g. homebrew 23 / `MODULE_VERSION` 131 vs nvm 22 / 127). Spawning the
   daemon with `process.execPath` crashes it on `new Database()` (`ERR_DLOPEN_FAILED`) before it binds.
   `resolveOpentasksNode()` probes candidate nodes (incl. nvm/fnm sweeps) by *instantiating* a DB and uses
   the ABI-matched one for the daemon, seed/list, AND the agents' MCP wrapper.

### Results — coordination decisively helps, but only on the right task class

> The citable write-up of everything below (with the caveats and the "what this does not
> show" section) is
> [`../results/2026-07-31-workbench-tier2-coordination.md`](../results/2026-07-31-workbench-tier2-coordination.md).
> What follows is the operator's summary.

WorkBench's `harmful` flag is duplication-COUNT-insensitive (1 wrong action and 2 duplicate wrong actions
both = harmful), so coordination only moves the score on tasks where the required action is (a)
side-effecting AND (b) single-agent-CORRECT — there a duplicate flips pass→fail. The default first-N
sample buries those under pure-query tasks (both pass) and hard-accuracy tasks (both fail), reading Δ≈0.

**Oversampling** (`EVAL_TASK_IDS`, id = `wb-multi_domain-sha1(task)[:12]`) targets that class. Of 210
`multi_domain` tasks, 123 are single-action side-effecting; an N=1 scan finds which the model does
correctly *solo* (sonnet: send_email 10/10, create_task 7/7, add_customer 1/3, create_event 0/4 — the
time-computation trap fails). Running N=2 stock-vs-opentasks on those:

| sample | n | opentasks compl | stock compl | Δ (paired) | opentasks harmful | stock harmful | redundancy R (ot/stock) |
|---|--:|--:|--:|--:|--:|--:|--:|
| first-6 (mixed) | 6 | 0.50 | 0.50 | **+0.000** | 0.50 | 0.50 | 0.00 / 0.25 |
| single-action-correct | 12 | 0.92 | 0.08 | +0.833 ✓ (CI 0.58–1.00) | 0.00 | 0.92 | 0.00 / 0.40 |
| single-action-correct (widened) | **18** | **0.94** | **0.06** | **+0.889** ✓ (CI 0.72–1.00) | 0.00 | 0.94 | 0.00 / 0.43 |

_(sonnet via Bedrock gateway; the paired Δ CI excludes 0 on the targeted set, and tightens as it widens.)_

Mechanism (17/18 in the widened targeted set): stock's two agents BOTH perform the one action (union
side-effects ≈ 2) → the duplicate is harmful → fail; opentasks claims distinct domains → 1 action →
correct → pass (redundancy R 0.00 vs 0.43). The lone opentasks miss is an `add_customer` task whose domain
split (crm / project_management) didn't match the single required action — both agents updated the same
customer. Cost: opentasks ~2.4× tokens for the claim/close overhead. **Takeaway: to measure coordination,
oversample single-action-correct side-effect tasks; the mixed default sample hides the effect.**

### Capability-gating and Option 1a — single-writer seeding (`WB_SEED_MODE=single`)

The per-domain split above is **capability-gated**: it only prevents duplication if each agent *stands
down* on a domain whose action it didn't claim. Weak models don't — a haiku agent that claims a read-only
domain (`analytics`) still fires the task's one side effect, so the union stays ≈2 and the duplicate is
harmful. And when the domain split doesn't cleanly isolate the single action (a `send_email` task tagged
`[email, calendar]`, or `create_task` tagged `[analytics, project_management]`), **even sonnet duplicates**.

**Option 1a (`WB_SEED_MODE=single`)** removes the reliance on self-restraint: seed exactly ONE claimable
"do the whole task" unit instead of one-per-domain. Atomic `claim_next` gives it to exactly one agent; every
other agent gets `claimed:false` and STOPS. Duplication becomes structurally impossible regardless of model
capability, and it also fixes the domain-split≠action-split miss. Default stays `per-domain` (the results
above reproduce with it). Trade-off: 1 effective worker (no parallelism) — optimal for single-action tasks,
and single-writer = solo-equivalent, so it can never regress below the model's solo ceiling.

Validated N=2 on 8 single-action-correct `multi_domain` tasks (4 `send_email` + 4 `create_task`; each
solo-correct, so the solo ceiling is 1.00):

| model | arm / mode | completion | harmful | union side-effects | redundancy R |
|---|---|--:|--:|--:|--:|
| haiku-4.5 | stock | 0.13 | 0.88 | 1.88 | 0.38 |
| haiku-4.5 | opentasks per-domain | 0.25 | 0.75 | 1.75 | 0.38 |
| haiku-4.5 | **opentasks single (1a)** | **1.00** | **0.00** | **1.00** | **0.00** |
| sonnet-4.6 | stock | 0.00 | 1.00 | 2.00 | 0.50 |
| sonnet-4.6 | opentasks per-domain | 0.13 | 0.88 | 1.88 | 0.38 |
| sonnet-4.6 | **opentasks single (1a)** | **1.00** | **0.00** | **1.00** | **0.00** |

Per-domain collapses to 0.13–0.25 for **both** models (both agents duplicate → harmful). Single-writer
recovers the **full solo ceiling** (1.00, harmful 0.00, union→1, R→0) for both — **capability-independent**.
Mechanism confirmed in every cell via `EVAL_DEBUG_DIR`: exactly one agent acts; the non-claiming agent
performs ZERO side effects (`claim_next` → `claimed:false` → stop). _(Bedrock gateway; run under node@22 —
see the ABI gotcha above; the system node drifted to v26, whose better-sqlite3 prebuild doesn't match.)_

**Scaling to N=4 (haiku)** sharpens the point — 1a is the *only* mode robust to agent count (`completion / R / union side-effects`):

| mode | N=2 | N=4 |
|---|---|---|
| stock | 0.13 / 0.38 / 1.88 | 0.00 / 0.71 / 3.88 |
| opentasks per-domain | 0.25 / 0.38 / 1.75 | 0.00 / 0.66 / 3.38 |
| **opentasks single (1a)** | **1.00 / 0.00 / 1.00** | **0.75 / 0.00 / 0.88** |

Stock and per-domain both **collapse to 0.00 as N grows** — duplication scales with agent count (union → ~4,
R → ~0.7). Per-domain fails to cap it because haiku ignores *both* forms of self-restraint it needs: at N=4
only 2 domains are claimable, yet 3–4 of the 4 agents fire the side effect anyway (the `claimed:false` agents
don't stop). Single-writer holds at **R=0.00** (never a duplicate, any N); its N=4 completion (0.75) is
haiku's *solo* ceiling ± n=8 noise — the two misses are the lone writer failing the task, not coordination.
1a vs stock at N=4: Δ +0.75 (significant).

### The standing limitation → Tier 3

Option 1a wins by being **single-writer**: one agent works, the rest stand down. That
makes duplication structurally impossible — and also caps the swarm at the model's *solo*
ceiling. Every result above is therefore **harm avoidance**, not throughput. Every task in
the stratum needs exactly ONE side effect, so parallelism is impossible by construction and
no arm could have shown a speedup.

**Tier 3** ([`../TIER3-THROUGHPUT.md`](../TIER3-THROUGHPUT.md)) is the pre-registered design
that tests the other half: multi-action tasks where splitting can actually pay, with H1–H4
declared up front so a null is as reportable as a win. Two pieces already landed here:

- `npm run eval:workbench:classify` — stratifies the WorkBench CSV by ground-truth action
  structure (`t3-ideal` / `t3-multi` / `t3-serial` / `single` / `query-only`) and emits
  paste-ready `EVAL_TASK_IDS`. Replaces the ad-hoc scan behind the Tier-2 stratum, so the
  selection is reproducible and auditable. Needs a WorkBench checkout.
- **Throughput metrics** on every marble cell: `criticalPathCalls` (longest per-agent
  tool-call chain — the hardware-independent speedup measure), `activeAgents`,
  `distinctSideEffects`, `maxAgentShare`, `makespanMs`, `agentOverlap`. `maxAgentShare` and
  `activeAgents` are the falsification guards: a per-domain cell that has quietly degenerated
  into single-writer scores identical completion and is otherwise invisible.

The runner also warns when `agentOverlap < 0.2` across every multi-agent cell — the agents
ran serially, so any speedup reading is invalid. The usual cause is the model connection
pool: it now defaults to `EVAL_CONCURRENCY × EVAL_N` (override with `EVAL_MODEL_CONNECTIONS`)
rather than `EVAL_CONCURRENCY`, which under-provisioned it whenever N > 1.

### The `opentasks-gated` arm — validating the claim at the resource

The Tier-2 results leave OpenTasks with a choice it should not have to make: single-writer is safe but
caps the swarm at one worker; per-domain is parallel but collapses because a `claimed:false` agent is
merely *asked* to stand down (at N=4, 3–4 of 4 haiku agents fired the side effect anyway).

That is the classic distributed-systems failure: **a lease is advisory unless the resource checks the
fence before accepting a write.** OpenTasks already mints claims with monotonic fence tokens
(`claim_fence`) and — like every current agent framework — nothing validates them at the point of effect.

`EVAL_ARMS=opentasks-gated` moves enforcement to the resource. `wb-claim-gate.ts` is an MCP proxy between
the agent and the WorkBench server: read-only calls pass through, and a side-effecting call is forwarded
**only if the calling agent holds a live claim**. A non-claiming agent is not asked to stand down — it
*cannot* act, because the call is refused before reaching WorkBench, so the email genuinely is not sent.

This is the one configuration that need not choose: N agents hold DISTINCT claims and work concurrently
(parallelism), and duplication is impossible regardless of model compliance (safety). It is therefore the
mechanism that could let a swarm beat a solo agent — the thing single-writer cannot do by construction.

- **Identity is structural.** The gate reads `AGENT_ID`, which the marble engine sets per agent and
  `NativeCliAdapter` merges into the spawned CLI env; the MCP child inherits it. The gate never asks the
  agent who it is — an agent that could name itself could also lie.
- **Always per-domain.** The arm ignores `WB_SEED_MODE=single` (and the runner refuses the combination):
  its whole point is keeping the parallelism single-writer gives up.
- **Same visible surface.** The proxy keeps the MCP name `workbench` and passes `tools/list` through
  untouched, so arms differ in what may be *committed*, never in what the agent can see or attempt.
- **Fails closed** — and that is a validity hazard, not just a safety property. If `AGENT_ID` does not
  arrive or the daemon is unreachable, every side effect is refused and the cell scores completion 0.00
  with zero duplicates, which superficially reads as flawless coordination. `gateMetrics` separates the
  cases: `no-claim` / `claim-expired` are the mechanism working, `no-agent-id` / `claim-lookup-failed` are
  the gate broken. **`gateBroken > 0` invalidates the cell**, and the runner warns loudly.

> **Preflight before spending tokens.** `AGENT_ID` propagation into MCP children is the one link that
> could not be verified offline. Run a single gated cell first and check `.wb_gate.jsonl` in the cell
> workspace: if denials say `no-agent-id`, the fix is upstream — swarmkit-eval's `native-cli` adapter
> should add `AGENT_ID` to each `mcpServers[...].env` when it writes the MCP config.

### The `manager` arm — the orchestrator-worker baseline

`stock` (no channel) and `notes` (a racy shared file) are both strawmen: nobody deploys
uncoordinated agents. The realistic alternative to an atomic claim is a **planner that assigns
work** — what AutoGen/CrewAI/LangGraph hierarchical modes do. `EVAL_ARMS=manager` adds it.

Shape: a width-1 `plan` phase (`role: orchestrator`) sequenced before the width-N `work` phase —
the engine runs phases in order and agents within a phase concurrently, so this is
`topology: 'orchestrator-worker'`. The manager may use read-only WorkBench tools, is told to
delegate and NOT act, and writes one line per worker to `assignments.md`. Workers start with a
**fresh context** (`reset` defaults true past phase 0), so the assignment must survive through the
substrate rather than a shared conversation — the honest version of the baseline.

It is also a test of the paper's axis rather than only a baseline: delegation is *instructed* and
has TWO compliance points (the manager must partition correctly; each worker must obey its line)
plus a single point of failure, so the structural/instructed hypothesis predicts it degrades with
capability and with N exactly as per-domain claiming does — while single-writer `claim_next`, with
zero compliance points, does not.

- **Runs alone.** Phases belong to the benchmark, not the arm, so enabling the plan phase would
  charge every other arm a wasted planning agent and invalidate their cached Tier-2 cells. The
  runner throws if `manager` is combined with another arm; compare by pairing on task id.
- **Charged fairly.** `criticalPathCalls` sums the per-phase maximum across phases (phases are
  sequential), so the planning stage counts against the manager rather than being free.
- **`plannerSideEffects`** counts side effects by the orchestrator: a manager that performs the
  action *and* assigns it duplicates by itself — an instructed failure invisible in completion.

### Env (beyond the Tier-1 vars)

| var | default | meaning |
|---|---|---|
| `EVAL_N` | `2` | agents per task |
| `EVAL_MODEL_CONNECTIONS` | `EVAL_CONCURRENCY × EVAL_N` | model connection pool; must be ≥ N or the cell's agents serialize |
| `EVAL_ARMS=manager` | — | the orchestrator-worker baseline (below). Must run ALONE — the runner errors otherwise |
| `WB_SEED_MODE` | `per-domain` | opentasks arm seeding: `per-domain` (one claimable subtask per domain) or `single` (Option 1a — one "whole task" unit; single writer). Folded into `runId` + store dir so modes don't share cache. |
| `EVAL_TASK_IDS` | — | comma list of exact `wb-*` ids to oversample (else first-N via `EVAL_TASK_LIMIT`) |
| `EVAL_SOLO` | — | `1` → also run an N=1 baseline for the A_e error-amplification KPI |
| `EVAL_DEBUG_DIR` | — | per-task dump: each agent's tool sequence + who-claimed-what + union actions |

```sh
# targeted oversample — the run that shows the payoff (sonnet via Bedrock gateway):
WB_GATEWAY_BASE_URL=http://127.0.0.1:4000 WORKBENCH_LLM_API_KEY=sk-… AWS_REGION=us-east-1 \
  EVAL_MODEL=claude-sonnet EVAL_ARMS=stock,opentasks EVAL_N=2 \
  EVAL_TASK_IDS=wb-multi_domain-78b0f2e1b29a,wb-multi_domain-cc223e5fe99f,… \
  npm run eval:workbench:marble
```
