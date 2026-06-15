# Cross-session continuity (reset) — build-todo, 3 arms, GLM-5 (2026-06-15)

Second signal. The single-session run (`2026-06-15-build-todo-glm5.md`) was a
*null with overhead*: a capable model one-shots a tractable task in one context,
so external state can't help. The fix the design doc points to is the
**cross-session continuity** test — make context NOT carry, so durable state has
to do work. This run is that test on the same task.

- **Harness:** `opentasks/evals/` reset mode (`EVAL_RESET=1`). Two phases per
  cell in ONE persistent work dir: phase 1 (full task, wall-clock capped at 90s)
  → context reset → phase 2 (fresh `claude -p`, told "a previous session started
  this; recover what's done, then finish"). Each phase is its own one-shot
  invocation, so phase 2 starts with EMPTY context — only the work dir carries.
- **Durable state per arm:** opentasks → the detached task-graph daemon (survives
  phase-1 exit); notes → `NOTES.md`; stock → only the partial files on disk.
- **Model:** GLM-5 via the Bedrock-Mantle LiteLLM proxy. 1 run per arm.

## Result

| Arm | Final S | Phase-2 tokens | Phase-2 readGraph | Phase-2 redundant |
|---|---|---|---|---|
| stock | 1.00 (full) | 317,962 | false | 0 |
| notes | 1.00 (full) | 315,580 | false | 0 |
| opentasks | 1.00 (full) | 295,630 | **true** | 0 |

Phase 1 was interrupted in every arm (~90s, partial S=0.10–0.35, no completion).
Phase-1 token cost reads 0: `claude -p` exits 0 on SIGTERM so no final `result`
event fires, and GLM-5-via-LiteLLM emits no per-message usage to fall back on.
This doesn't affect the headline — phase 2 (the re-orientation measurement)
completes cleanly and reports real usage.

## Findings

1. **Adoption is solvable.** Unlike the single-session run (0 graph calls), the
   opentasks arm here **read the graph on resume** (`readGraph=true`). The resume
   framing + arm instruction was enough to activate it. Non-adoption was a
   property of the regime (single context, nothing to recover), not a hard wall.
2. **Clean null — not null-with-overhead.** All three arms converge to S=1.00 at
   ~300–320K phase-2 tokens, indistinguishable at n=1 (opentasks nominally
   *lowest*, within noise). The 2.4× overhead of the single-session run is gone:
   with a fresh phase-2 context, unused schemas don't compound.
3. **The graph was read but didn't help** — because build-todo's state lives
   entirely in the work dir. On resume, reading the half-built files is just as
   good as reading the graph. External state is redundant when the work dir *is*
   the state.

## Interpretation

The two nulls now bracket the problem precisely:

> OpenTasks is null whenever the state fits in **context** (single-session) OR in
> the **work dir** (reset, file-recoverable). It can only be load-bearing when
> neither holds.

So **adoption is not the blocker; value is** — and value requires a regime where
the relevant state is *not* reconstructable for free. Two such regimes:

- **Hidden-state continuity** — tasks whose meaningful state is NOT in the work
  dir: decisions made, hypotheses *ruled out*, what was already verified, plan
  ordering. (Salvages this reset harness, which is plumbed and validated — it
  just needs discriminating tasks.)
- **Multi-agent concurrency** — the safety thesis. NOTES.md structurally cannot
  offer a safe concurrent claim, so the baseline fails by construction. The
  claim-to-work protocol also *forces* adoption (no prompt-begging), and the
  metrics (dup-work, races) are safety metrics that saturation can't hide.

**Value of this run:** for ~$2 it confirmed the reset mechanism works AND that
reset *alone* isn't sufficient on a file-recoverable task — closing the
"continuity will fix it" hypothesis and pointing at hidden-state / concurrency as
the real load-bearing regimes.

Traces: `evals/.runs/build-todo__{stock,notes,opentasks}__reset__r0.json`
(gitignored).
