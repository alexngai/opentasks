# OpenTasks evaluation harness

Runs a standard benchmark's tasks with OpenTasks as a **harness ablation** (the
*arm*), scoring on the benchmark's own ground-truth scale. See the design:
[docs/evaluations/2026-06-14-P6-evaluation-design.md](../docs/evaluations/2026-06-14-P6-evaluation-design.md).

Inspired by `~/GitHub/skill-tree/test/eval/disclosure` (headless `claude -p` per
cell, model-swappable, Bedrock-capable, JSON token accounting, hidden post-hoc
verifier).

## Arms (the E2′ RCT — same model+tasks, only state mechanism differs)

| Arm | State mechanism |
|---|---|
| `stock` | native context only |
| `notes` | an instructed `NOTES.md` discipline |
| `opentasks` | the OpenTasks MCP (`node dist/cli.js mcp`) as a durable task graph |

## Run

```bash
npm run build                      # ensure dist/cli.js exists (opentasks arm uses it)
EVAL_MODEL=haiku EVAL_ARMS=stock npx tsx evals/run.ts          # smoke one arm (Max plan)
EVAL_ARMS=stock,notes,opentasks npx tsx evals/run.ts           # all 3 arms

# On Bedrock (GLM-5 / mantle): creds come from the AWS default profile / env.
CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-1 \
  EVAL_MODEL=<glm-5-model-id> npx tsx evals/run.ts
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

## Scoring (hard rules)

- **Ground-truth only.** Pass/fail comes from checkpoints run against the work
  dir after the agent finishes — never the agent's self-reported / graph state.
- `S_partial = 0.5·(earned/total) + 0.5·S_full` (TheAgentCompany).
- Diagnostics (`redundantExplorationOps`, `readGraph`, `tokenCost`) are layered
  on top from the tool-call trace; they never affect the score.

## Layout

- `types.ts` — Arm / Task / Checkpoint / RunResult.
- `arms.ts` — the 3 arms.
- `runner.ts` — spawn `claude -p` (stream-json), parse trace + usage, verify.
- `metrics.ts` — graph-read + re-exploration from the trace.
- `run.ts` — CLI: (task × arm × repeat) → console + `.runs/*.json`.
- `tasks/` — task definitions (currently a smoke task; TheAgentCompany SDE next).

## Eval hygiene

The runner passes `--mcp-config <explicit> --strict-mcp-config` so the spawned
agent sees **only** the MCP we inject — never the user's global servers/plugins
(OMC, cc-swarm, claude.ai connectors), which would otherwise leak an OpenTasks
MCP into the stock/notes arms and break the ablation. OMC is disabled via
`DISABLE_OMC=1` / `OMC_SKIP_HOOKS=1`. (Full config-dir isolation — global
`CLAUDE.md` is a constant across arms, not a differential confound — is a future
hardening item.)

## Status

Skeleton + smoke task validated end-to-end (all 3 arms; ground-truth scoring,
token accounting, tool-call trace, MCP isolation confirmed: stock=none,
opentasks=only-opentasks). **Next:** wire TheAgentCompany SDE tasks (its Docker
services + checkpoint evaluators) and confirm the `bedrock-mantle`/GLM-5 model id.
