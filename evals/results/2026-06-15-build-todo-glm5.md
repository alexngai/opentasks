# First comparative signal — build-todo, 3 arms, GLM-5 (2026-06-15)

First real OpenTasks-vs-baseline run. Goal: a cheap signal on whether OpenTasks
helps, before investing in the full AppWorld arm.

- **Harness:** `opentasks/evals/` (headless `claude -p`, ground-truth checkpoints).
- **Task:** `build-todo` (multi-step Python package build; stdlib-only; hard
  checkpoints = tests pass + CLI runs). See `evals/tasks/build-todo.ts`.
- **Model:** GLM-5 via the Bedrock-Mantle LiteLLM proxy. 1 run per arm.

## Result

| Arm | S_partial | Tokens | Time | Used OpenTasks? |
|---|---|---|---|---|
| stock | 1.00 (full) | 213,239 | 164s | — |
| notes | 1.00 (full) | 277,590 (+30%) | 264s | — |
| opentasks | 1.00 (full) | 516,745 (+142%) | 735s | **no — 0 graph calls** (MCP connected) |

## Findings

1. **Capability saturation.** GLM-5 aced the task in every arm — a strong model
   one-shots a moderate multi-step task in a single context, so external state
   can't improve completion (stock already maxes out). Matches the
   ~45%-single-agent saturation result (arXiv:2512.08296).
2. **Non-adoption + overhead.** The `opentasks` arm made **zero**
   `mcp__opentasks__*` calls despite the MCP being connected and a prompt nudge.
   The unused tool schemas bloated context → **2.4× tokens, 4.5× time** vs stock
   for the identical result. This is the design doc's "null because the agent
   doesn't read the graph" branch.

## Interpretation

A naive "give the agent OpenTasks and hope" produces a **null with overhead**:
capable models don't need external state on tractable tasks, and won't adopt it
unless the task forces it. To get a real signal, OpenTasks must be
**load-bearing**, which requires (a) context pressure (length/resets) and
(b) necessity. Both point to the **cross-session continuity test (E2′ proper)**:
run partway → reset context → resume, where the `opentasks` arm recovers from
the graph, `notes` from NOTES.md, and `stock` has only the work-dir.

**Value of this run:** for ~$2 of GLM-5 it showed the naive single-session
comparison is null — the same null we'd have hit (far more expensively) on the
full AppWorld arm build. Next: the minimal reset/continuity harness variant.

Traces: `evals/.runs/build-todo__{stock,notes,opentasks}__r0.json` (gitignored).
