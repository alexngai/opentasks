# Synthetic cell-B (concurrency) — first positive signal, GLM-5 (2026-06-15)

The first run where OpenTasks is unambiguously **load-bearing**. After two nulls
(single-session, reset-with-file-recoverable-state), this is the concurrency
regime where coordination *safety* can't be faked.

- **Harness:** `evals/synthetic/` — N agents race a shared queue; processing an
  item = `./emit <id>` to an in-process HTTP collector with **no read path**, so
  "done-ness" is not observable to agents. Ground truth = each item emitted
  **exactly once**.
- **Arms:** stock (no coordination) / notes (racy claim-by-convention in a shared
  file) / opentasks (atomic `claim_next` + `update_task` complete).
- **Model:** GLM-5 via the LiteLLM proxy. **N=4 agents, M=8 items, 1 run/arm.**

## Result

| Arm | exactly-once | double-emits | missed | tokens | time | correct |
|---|---|---|---|---|---|---|
| stock | 0/8 | **24** | 0 | 537K | 106s | ❌ |
| notes | 7/8 | 0 | **1** | 1.88M | 231s | ❌ |
| opentasks | **8/8** | 0 | 0 | 1.23M | 132s | ✅ |

`opentasks`: claimers=4/4, clean 2-2-2-2 split. `stock`: every agent emitted all
8 → 32 total emits, 24 redundant.

## Findings

1. **The two baselines fail in their two characteristic ways; only the atomic
   substrate is correct.**
   - **stock fails by duplication** — no coordination → 4× work, every item
     emitted four times.
   - **notes fails by omission** — racy claim-by-convention avoided duplicates but
     **orphaned one item**: an agent reserved it in `claims.txt` then dropped it,
     and the others skipped it (a reservation with no expiry and no recovery).
     This is exactly the case a **lease** (claim + fence + expiry) recovers and a
     notes-convention cannot.
2. **OpenTasks is correct *and* cheaper than the coordinating baseline.** vs
   `notes`: 1.23M vs 1.88M tokens (−35%), 132s vs 231s (−43%). The agents don't
   burn effort negotiating a flat file — they call one atomic primitive. (stock
   is cheapest only because it's wrong — it blasts everything without
   coordinating.)
3. **Adoption was not a problem here.** claimers=4/4: every agent used
   `claim_next`. Unlike the single-session null, the task *forced* the substrate —
   you cannot safely emit without claiming.

## Interpretation

This is the safety thesis demonstrated: in a concurrent regime with a
non-idempotent, not-on-disk side-effect, **only the atomic-claim substrate
achieves exactly-once**; the naive alternatives fail (duplication without
coordination; omission + 1.5× cost with racy coordination). The effect is the
*opposite* of the single-session null — here the substrate is necessary, adopted,
and net-cheaper than the realistic baseline.

## Robustness (k=4 at N=4/M=8 — the run above + 3 repeats)

| Arm | correct | failure mode(s) | tokens (range) |
|---|---|---|---|
| stock | **0/4** | duplication every run (6–24 double-emits) | 0.42–0.68M |
| notes | **2/4** | **bimodal** — 1 run omits an item, 1 run duplicates (2 dup) | 1.6–2.05M |
| opentasks | **4/4** | none — claimers=4/4 every run, clean even split | 1.2–1.55M |

Per-run correct flags: stock = ✗✗✗✗; notes = ✗(miss) ✓ ✓ ✗(2 dup); opentasks = ✓✓✓✓.

**The robust result:** OpenTasks is the only arm that is *reliably* correct (100%),
and it is **cheaper than the coordinating baseline in every run** (notes is ~50%
correct at 1.5–1.7× the tokens). The notes failure is **bimodal** — it loses
items (orphaned reservation, no lease recovery) *or* duplicates them (TOCTOU on
the shared file) depending on timing — precisely the two failure modes an atomic
lease+fence eliminates. stock never coordinates and always duplicates.

**Caveats:** k=4 (a clean separation but not yet CI-grade; k≥8 would tighten the
notes failure-rate estimate). No agent errors (proxy handled 4 concurrent fine).
Next: contention sweep (N∈{2,8}) for monotonic degradation, then cells C
(continuity) and D (both).

Traces: `evals/.runs/concB__{stock,notes,opentasks}__n4__m8__r0.json` (gitignored).
