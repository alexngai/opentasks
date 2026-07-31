# OpenTasks evaluation harness

Runs a standard benchmark's tasks with OpenTasks as a **harness ablation** (the
*arm*), scoring on the benchmark's own ground-truth scale.

Inspired by a headless disclosure-style eval harness (`claude -p` per cell,
model-swappable, Bedrock-capable, JSON token accounting, hidden post-hoc verifier).

## Arms (the E2′ RCT — same model+tasks, only state mechanism differs)

| Arm | State mechanism |
|---|---|
| `stock` | native context only |
| `notes` | an instructed `NOTES.md` discipline |
| `opentasks` | the OpenTasks MCP (`node dist/cli.js mcp`) as a durable task graph |

## Run

The harness is the shared [`swarmkit-eval`](../package.json) package (matrix →
sealed `claude -p` → ground-truth grade → content-addressed store/resume → stats →
report); the files under `evals/swarmkit/` are thin OpenTasks adapters over it.

```bash
npm run build                      # ensure dist/cli.js exists (opentasks arm uses it)
EVAL_MODEL=haiku EVAL_ARMS=stock npx tsx evals/swarmkit/run.ts   # smoke one arm (Max plan)
EVAL_ARMS=stock,notes,opentasks npx tsx evals/swarmkit/run.ts    # all 3 arms

# On Bedrock (GLM-5 / mantle): creds come from the AWS default profile / env.
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-1 \
  EVAL_MODEL=<glm-5-model-id> npx tsx evals/swarmkit/run.ts
```

### Env

| Var | Default | Meaning |
|---|---|---|
| `EVAL_MODEL` | `haiku` | `claude --model` id. For GLM-5 set this + Bedrock/mantle vars below. |
| `EVAL_ARMS` | `stock,notes,opentasks` | which arms to run |
| `EVAL_REPEATS` | `1` | runs per cell (k) |
| `EVAL_TIMEOUT` | `600000` | per-run ms |
| `EVAL_TASKS` | `smoke-greeting` | task ids |

`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_PROFILE`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_MODEL` are passed through to the spawned agent when set.

## Synthetic 2×2 — concurrency × continuity (cells B/C/D)

`evals/synthetic/` is the microbenchmark that isolates *where* OpenTasks is
load-bearing, ahead of the standard-benchmark hosts. N agents work a shared queue;
processing an item = `./emit <id>` to an in-process HTTP collector with **no read
path**, so "done-ness" is not observable to agents (the property build-todo lacked).
Ground truth = each item emitted **exactly once**. Arms: `stock` (none) / `notes`
(racy claim-by-convention) / `opentasks` (atomic `claim_next` + complete).

| Cell | Stressor | How to run |
|---|---|---|
| B · concurrency | N agents, 1 session | `EVAL_CELL=B EVAL_N=4 EVAL_M=8 …` |
| C · continuity | 1 agent, reset (phase 1 does K, phase 2 finishes) | `EVAL_CELL=C EVAL_M=6 EVAL_K=3 …` |
| D · both | swarm across a reset | `EVAL_CELL=D EVAL_N=3 EVAL_M=6 EVAL_K=3 …` |

```bash
# GLM-5 (proxy stack must be up: bash evals/glm5/start-stack.sh)
EVAL_CELL=D EVAL_MODEL=glm-5 ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
  ANTHROPIC_API_KEY=glm5-local-master EVAL_N=3 EVAL_M=6 EVAL_K=3 EVAL_REPEATS=5 \
  npx tsx evals/swarmkit/synth-run.ts   # +CIs/report; synth-marble-run.ts = native multi-agent engine
```

Headline metric = **race incidents** (`doubleEmits`) and **re-emits** (`p2ReEmits`),
not completion (saturation hides completion).

## Scoring (hard rules)

- **Ground-truth only.** Pass/fail comes from checkpoints run against the work
  dir after the agent finishes — never the agent's self-reported / graph state.
- `S_partial = 0.5·(earned/total) + 0.5·S_full` (TheAgentCompany).
- Diagnostics (`redundantExplorationOps`, `readGraph`, `tokenCost`) are layered
  on top from the tool-call trace; they never affect the score.

## Layout

- `types.ts` — Arm / Task / Checkpoint / RunResult.
- `arms.ts` — the 3 arms.
- `runner.ts` — reusable `claude -p` spawn/parse/score helpers (stream-json trace +
  usage + checkpoint verify), consumed by the synthetic runners.
- `metrics.ts` — graph-read + re-exploration from the trace.
- `swarmkit/` — the canonical harness: thin adapters over `swarmkit-eval` plus the
  entrypoints — `run.ts` (task × arm × repeat), `synth-run.ts` / `synth-marble-run.ts`
  (the synthetic 2×2), and `bench.ts` (whose `metricsOf` folds the graph-adoption
  diagnostics onto the ground-truth score).
- `tasks/` — task definitions (smoke + `build-todo`).
- `synthetic/` — the concurrency × continuity 2×2 *execution* (cells B/C/D): collector
  + emit-queue + concurrency/continuity/cellD runners (driven from `swarmkit/`).
- `cooperbench/` — CooperBench team-mode integration (OpenTasks as the coordination backend).
- `tac/` — TheAgentCompany adapter path over `swarmkit-eval` (task inventory,
  TAC-native score mapping, fake execution smoke, and Docker task lifecycle for
  local/E2B runs).
- `results/` — dated empirical write-ups (the proven findings).
- `glm5/`, `appworld/` — the GLM-5 proxy stack and the AppWorld setup recipe.

## Eval hygiene

The runner passes `--mcp-config <explicit> --strict-mcp-config` so the spawned
agent sees **only** the MCP we inject — never the user's global servers/plugins
(OMC, cc-swarm, claude.ai connectors), which would otherwise leak an OpenTasks
MCP into the stock/notes arms and break the ablation. OMC is disabled via
`DISABLE_OMC=1` / `OMC_SKIP_HOOKS=1`. (Full config-dir isolation — global
`CLAUDE.md` is a constant across arms, not a differential confound — is a future
hardening item.)

## Status (2026-07-31)

**Stage 1 (synthetic 2×2) — done, robust.** On GLM-5: two informative nulls
(single-session; reset-with-file-recoverable-state), then the 2×2 — cell B
(concurrency, k=4) opentasks 4/4 & cheapest-correct; cell C (continuity, n=1)
opentasks ties disciplined-notes; **cell D (both, k=5) opentasks is the only
race-clean arm** (0 races in all 5; notes 0/5, stock 0/5). Super-additivity
confirmed. Write-ups: `results/2026-06-15-*`.

**Stage 2 (standard benchmark host) — done on WorkBench.** The synthetic result
reproduces on a benchmark we did not author, with its own outcome grader: N agents
on one WorkBench `multi_domain` task, graded on the **union** of their side effects,
so a duplicate = a WorkBench *harmful action*. Paired Δ **+0.889 (CI 0.72–1.00)** at
n=18 on the stratum where duplication binds; single-writer seeding (`WB_SEED_MODE=single`)
recovers the full solo ceiling for both haiku-4.5 and sonnet-4.6 and is the only mode
robust to agent count. Full write-up:
[`results/2026-07-31-workbench-tier2-coordination.md`](./results/2026-07-31-workbench-tier2-coordination.md).

**The standing limitation.** Every result so far is *harm avoidance*. The winning
configuration is single-writer by construction, so it cannot beat one careful agent —
only match it. OpenTasks has not yet been shown to buy **throughput**.

**Open / next:**
- **Stage 3 (throughput) — designed, not run.** Pre-registered in
  [`TIER3-THROUGHPUT.md`](./TIER3-THROUGHPUT.md): multi-action tasks where parallelism
  can actually pay, with `criticalPathCalls` / `activeAgents` / `agentOverlap` as the
  measures and H1–H4 declared in advance so a null is reportable. Harness steps 2–3
  (parallelism check, metrics) are **done**; step 1 (`npm run eval:workbench:classify`)
  needs a WorkBench checkout; the runs need the gateway.
- **Eval-infra:** the GLM-5 proxy (`glm5/`) has no retry/backoff and falls over under
  sustained load — it crashed the cell-C k=5 repeat. Harden it (retry+backoff,
  concurrency cap) before scaling GLM-5 runs.
- Clean cell-C k≥5 + contention sweep (N∈{2,8}) on a hardened proxy.
- **Long-horizon anchor:** RoadmapBench's OpenTasks arm needs in-container daemon +
  `.mcp.json` wiring (the `tac/docker-adapter.ts` pattern). TAC has an adapter and
  smokes but no real arm results.
