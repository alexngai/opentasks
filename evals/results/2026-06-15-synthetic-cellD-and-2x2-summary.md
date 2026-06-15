# Synthetic 2×2 complete — cell D (swarm × reset) + the full matrix (2026-06-15)

Cell D is the decisive interaction test: a swarm ACROSS a reset, where both
hazards hit at once. It closes the synthetic 2×2 and demonstrates the core thesis.

- **Harness:** `evals/synthetic/` cell D. Phase 1 = N agents do the first K items
  concurrently; reset; phase 2 = N FRESH agents finish the rest without
  re-emitting (continuity) and without racing (concurrency). opentasks uses one
  `claim_next` loop for both phases; notes must race two flat files
  (`done.txt` + `claims.txt`); stock has neither.
- **Model:** GLM-5 via the LiteLLM proxy. **N=3, M=6, K=3, 1 run/arm.**

## Cell-D result

| Arm | exactly-once | double-emits | p2 re-emits | failure source | tokens | correct |
|---|---|---|---|---|---|---|
| stock | 0/6 | 21 | 9 | races both phases + re-does reset | 767K | ❌ |
| notes | 3/6 | 3 | 0 | `done.txt` recovered; swarm raced `claims.txt` (3 dup in phase 1) | 1.20M | ❌ |
| opentasks | **6/6** | 0 | 0 | — one atomic primitive covers both | 1.22M | ✅ |

Phase-1 gradient for K=3 items: stock emitted 9 (3× over), notes 6 (2× over),
opentasks exactly 3.

## The full synthetic 2×2

| arm | A (anchor, N=1, 1 session) | B (concurrency) | C (continuity) | **D (both)** |
|---|---|---|---|---|
| stock | null (saturated) | 0/4 correct | fails (re-emits) | 0/6 |
| notes | null | 2/4 (unreliable) | **6/6 (works)** | **3/6 (fails)** |
| opentasks | null | **4/4** | 6/6 | **6/6** |

## Findings

1. **Super-additivity confirmed.** notes works on continuity ALONE (6/6) and limps
   on concurrency alone (2/4), but COLLAPSES when both hit at once (3/6) — worse
   than either axis predicts. A flat file cannot be a safe claim register *and* a
   durable done-log under concurrent access simultaneously. (Its `done.txt`
   recovery even worked here — p2ReEmits=0 — it died on the `claims.txt` race.)
2. **opentasks is the only arm correct in every stressed cell**, and uniquely so in
   D — the regime that matches the real product scenario (a swarm resuming
   long-horizon work). One primitive (`claim_next`, returning items neither done
   nor in-flight) covers both hazards.
3. **The anchor (A) is null** (capability saturation), exactly as the negative
   control requires — the substrate adds nothing when state fits in one context.

## Interpretation

The 2×2 demonstrates the thesis cleanly: **OpenTasks is a coordination-SAFETY
substrate, load-bearing exactly where the working state exceeds one context in
space (concurrency) and/or time (continuity) — and irreplaceable where both hold
at once.** The baselines that limp through a single axis fail when the axes
combine. This is the empirical core for the P6 program: the standard-benchmark
hosts (TheAgentCompany anchor, EntCollabBench) instantiate cell D on real tasks;
the synthetic predicts where their lift appears.

**Caveats:** cell D and C are n=1 (B is k=4). The cell-D story is sharp enough at
n=1 that repeats are for tightening, not direction. GLM-5 single-agent/sequential
work is slow through the proxy (cell C); the N-agent cells (B, D) parallelize and
run cleaner. Next: repeats (k≥5) on D for CI-grade separation, a contention sweep,
then the TheAgentCompany GitLab-only host build (Stage 2).

Traces: `evals/.runs/cellD__{stock,notes,opentasks}__n3__m6__r0.json` (gitignored).
