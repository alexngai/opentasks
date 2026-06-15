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

## Cell-D robustness (k=5, added 2026-06-15)

The headline metric is **race incidents** (`doubleEmits`) — it isolates the
coordination failure from infra noise:

| arm | correct | doubleEmits per run | reading |
|---|---|---|---|
| stock | **0/5** | 15, 15, 20, 13, 21 | always chaos |
| notes | **0/5** | 4, 2, 3, 1, 4 | **never zero** — races `claims.txt` every run (`p2ReEmits=0` throughout: its `done.txt` recovery works; only the concurrency half fails) |
| opentasks | 4/5 | **0, 0, 0, 0, 0** | **never races** |

opentasks's single non-perfect run was a `missed=1` caused by a **proxy error**
(ERRS=3, phase 1 only completed 2 of 3 before the GLM-5 stack erred) — not a
coordination failure (`doubleEmits=0`). So on the safety metric opentasks is **5/5
clean**; notes and stock are 0/5. Direction confirmed across repeats.

> Infra note: this k=5 ran as the GLM-5 proxy began to strain (several runs logged
> `ERRS`, 600–1300s); the *cell-C* k=5 that followed was **invalidated** by a full
> proxy outage (most runs `tokens=0`). Cell C's evidence remains the earlier clean
> n=1 (M=6) run; a clean cell-C repeat is pending a hardened proxy. See follow-ups.

## The full synthetic 2×2

| arm | A (anchor) | B (concurrency, k=4) | C (continuity, n=1) | **D (both, k=5)** |
|---|---|---|---|---|
| stock | null (saturated) | 0/4 correct | fails (re-emits) | **0/5** (13–21 races) |
| notes | null | 2/4 (unreliable) | **6/6 (works)** | **0/5** (1–4 races every run) |
| opentasks | null | **4/4** | 6/6 | **5/5 race-clean** (4/5 fully correct; 1 infra-miss) |

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

**Caveats / status:** B is k=4, **D is now k=5** (above), C is n=1 (its k=5 repeat
was invalidated by a proxy outage — pending a hardened GLM-5 stack). Results are
GLM-5-only; no second model / saturation curve yet; tokens reported but not
formally matched; no contention sweep (N∈{2,8}) yet. The GLM-5 proxy (SigV4 shim
→ Mantle) has **no retry/backoff** and falls over under sustained load — the
top eval-infra fix before scaling runs. Next: harden the proxy, clean cell-C k≥5
+ contention sweep, then the TheAgentCompany GitLab-only host (Stage 2).

Traces: `evals/.runs/cellD__{stock,notes,opentasks}__n3__m6__r0.json` (gitignored).
