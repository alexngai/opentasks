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

**Dependency (pinned `^0.0.3`, 2026-06-17).** `swarmkit-eval` is published and
pinned here as a devDependency — no symlink, no sibling-repo requirement,
reproducible on CI:

```bash
npm i -D swarmkit-eval@0.0.3
```

Validated against the **published** package: `EVAL_MOCK=1 run.ts` (the E2′
pipeline), `EVAL_FAKE=1 EVAL_CELL=D synth-run.ts` (the synthetic 2×2 metric
aggregation: `doubleEmits`/`p2ReEmits`/`exactlyOnce` → per-arm CIs), and
`bench-check.ts` (the `metricsOf` diagnostics hook new in 0.0.3) are all green.
Bump the pin as swarmkit-eval evolves; for live co-dev of the package,
`npm link swarmkit-eval` against a local checkout.

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
