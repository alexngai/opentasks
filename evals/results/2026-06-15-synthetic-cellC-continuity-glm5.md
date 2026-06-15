# Synthetic cell-C (continuity) — GLM-5 (2026-06-15)

The continuity axis, isolated: ONE agent processes part of a queue, its context is
RESET, a fresh agent must finish WITHOUT re-emitting done items — and the
side-effect is **not observable on disk**, so it must recover done-ness from its
arm's durable state. This is the build-todo regime *fixed* (there the work dir was
the record, so it went null).

- **Harness:** `evals/synthetic/` cell C. Deterministic phase split: phase 1 does
  exactly K items then stops (clean exit, no flaky wall-clock interrupt); phase 2
  is a fresh `claude -p` told "some are done, you can't see which — recover and
  finish." Ground truth = exactly-once across both phases.
- **Model:** GLM-5 via the LiteLLM proxy. **M=6, K=3, 1 run/arm.**

## Result

| Arm | exactly-once | phase-2 re-emits | recovered via | tokens | correct |
|---|---|---|---|---|---|
| stock | 5/6 | 1 | nothing | 200K* | ❌ |
| notes | 6/6 | 0 | `done.txt` | 450K | ✅ |
| opentasks | 6/6 | 0 | `claim_next` (returns only undone) | 829K | ✅ |

\* stock hit a transient proxy error (ERRS=1; phase 1 completed only 1 of 3) but
still re-emitted that item in phase 2 — the failure direction holds.

## Findings

1. **stock fails continuity** — a fresh agent with no durable record re-emits work
   it can't see is done. This is the discriminator build-todo lacked (there the
   half-built files *were* the record → null; here the emit is off-disk).
2. **notes AND opentasks both recover** — a *disciplined* `done.txt` is sufficient
   for single-agent continuity, and opentasks recovers via the graph (`claim_next`
   only hands back undone items).
3. **opentasks does NOT beat disciplined-notes on continuity alone, and is pricier
   single-agent** (829K vs 450K — the MCP claim loop has no concurrency to amortize
   its per-item overhead).

## Interpretation

This is the factorial design paying off honestly. Pairing with cell B:

- **Cell B (concurrency): opentasks wins** (4/4 vs notes 2/4, and cheaper) — atomic
  claim is a *qualitative* advantage notes structurally can't match.
- **Cell C (continuity alone): opentasks ties notes** — persistence is a
  *quantitative* property a flat log also has; the atomic substrate isn't required.

Exactly the design doc's prediction (concurrency = qualitative, continuity =
quantitative). So OpenTasks's unique value is concurrency-shaped, and the decisive
experiment is **cell D (both at once)**: a swarm across resets, where notes should
fail on *both* counts (its `done.txt` is raced *and* it has no atomic claim) while
opentasks survives. Hypothesis: **super-additivity** — D fails worse than B and C
alone would predict.

**Caveats:** n=1; stock's proxy hiccup warrants a clean repeat. Next: build cell D.

Traces: `evals/.runs/cellC__{stock,notes,opentasks}__m6__r0.json` (gitignored).
