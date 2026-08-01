# Experiment plan — the runs the paper needs

Companion to [`PAPER-PLAN.md`](./PAPER-PLAN.md) (claim + exhibits) and
[`TIER3-THROUGHPUT.md`](./TIER3-THROUGHPUT.md) (the throughput pre-registration). This file
is the execution order: what to run, in what sequence, what each run feeds, and the
decision gate that follows it.

Sequencing principle: **cheapest falsification first.** E1 can invalidate the paper's
framing for the price of 48 agent-runs; Tier 3 cannot change the framing at all. So E1
runs before anything gets widened.

## Cost unit

Cells × agents-per-cell = **agent-runs**, the thing that actually costs tokens and wall
clock. A standard arm spends N agent-runs per cell; the manager arm spends **1 + N** (the
planning stage is charged, in cost and in `criticalPathCalls`). Observed from Tier 2: the
opentasks arm costs ≈ 2.4× stock's tokens per agent-run, so agent-runs are an ordinal
guide, not a linear cost model.

---

## E0 · Stratum census — free

**Feeds:** F2, and the C1 census sentence ("most of the benchmark cannot register a
throughput effect").

```sh
npm run eval:workbench:classify                      # multi_domain
EVAL_DOMAIN=email npm run eval:workbench:classify     # repeat per domain for the full census
```

**Cost:** zero model spend. Needs only a WorkBench checkout.
**Gate:** if `t3-ideal + t3-multi` < 15, take the thin-stratum mitigation in
`TIER3-THROUGHPUT.md` (widen beyond `multi_domain`) *before* planning E4. Also: any
non-zero `unparsed` count invalidates every stratum until explained.

---

## E1 · Manager baseline — **the gating run**

**Feeds:** T2. **Blocks:** the paper's framing.

The realistic alternative to an atomic claim is a planner that assigns work. If
`claim_next` does not beat it, the structural-vs-instructed axis is wrong and we need to
know now. It is also a direct test of C3, not merely a baseline: delegation is *instructed*
and has two compliance points (manager partitions correctly; worker obeys its line), so the
hypothesis predicts it degrades with capability and with N just as per-domain claiming does.

Manager runs as its own experiment (own `runId`, own store dir) because it changes the
swarm shape; the runner **refuses** to run it alongside other arms. Compare by pairing on
task id — the same way `single` was compared against `per-domain`.

**E1a — decision gate (cheap).** The 8 single-action-correct tasks already used for the 1a
matrix, so it pairs directly against known numbers.

```sh
# per model ∈ {claude-haiku, claude-sonnet}:
WB_GATEWAY_BASE_URL=… WORKBENCH_LLM_API_KEY=… AWS_REGION=us-east-1 \
  EVAL_MODEL=<model> EVAL_ARMS=manager EVAL_N=2 EVAL_TASK_IDS=<the 8 ids> \
  EVAL_DEBUG_DIR=evals/.wb-debug-manager npm run eval:workbench:marble
```

- **Cells:** 2 models × 8 tasks = 16. **Agent-runs:** 16 × 3 = **48**.
- **Compare against (already have):** stock 0.13/0.00, per-domain 0.25/0.13, single 1.00/1.00
  (haiku/sonnet completion).

**Decision gate:**

| outcome | reading | action |
|---|---|---|
| manager ≈ stock/per-domain (≤ 0.25) | delegation fails the same way — instructed mechanisms share a failure mode | proceed; T2 becomes strong evidence for C3 |
| manager ≈ 1.00, matching single-writer | delegation is *sufficient* on single-action tasks | reframe: the claim narrows to N-scaling and throughput, where a manager has a single point of failure. Run E1b before writing anything |
| manager > single-writer | the framing is wrong | stop and re-plan the paper |

Watch `plannerSideEffects` in every cell: a manager that performs the action *and* assigns
it duplicates by itself — an instructed failure invisible in completion alone.

**E1b — N-scaling (conditional on E1a).** Same tasks at N=4, both models. **Cells:** 16,
**agent-runs:** 16 × 5 = **80**. The structural hypothesis predicts manager degrades at
N=4 (more workers, more compliance points, one planner to get it wrong) while single-writer
holds at 0.75/R=0.00.

---

## E2 · Widening — n and models

**Feeds:** F1, T1 (tightens the CIs reviewers will attack).

Current counts are n = 8 (1a matrix) and n = 18 (widest). Both are thin at `seeds: [1]`.

1. Extend the solo scan across all 123 single-action tasks per model → the full
   solo-correct stratum, not the 24 scanned so far.
2. Re-run {stock, per-domain, single, manager} at N=2 over that stratum, `EVAL_REPEATS=3`.
3. **Non-Anthropic model.** Capability-gating shown only across two Anthropic tiers invites
   "artefact of one family." Blocked on the GLM-5 proxy hardening (no retry/backoff — it
   crashed the cell-C k=5 repeat in June). **Harden the proxy before this run, not during.**

**Cost:** the dominant run in the paper; size it after E0 reports the true stratum size.

---

## E3 · Error amplification A(N)

**Feeds:** F3, the figure most likely to be remembered.

`A(N) = harm(N) / harm(1)`. Needs the **N=1 solo** denominator, which `EVAL_SOLO=1`
already produces, plus a filled N-grid.

```sh
EVAL_SOLO=1 EVAL_N=<2|4> EVAL_ARMS=stock … npm run eval:workbench:marble
```

- **Have:** N ∈ {2,4} haiku for stock/per-domain/single.
- **Need:** N=1 solo per arm per model; sonnet at N=4; ideally N=8 for one arm to show the
  trend does not saturate.
- Report alongside `unionSideEffects`, which already tracks N almost exactly under stock
  (1.88 at N=2 → 3.88 at N=4). The claim is that *adding agents monotonically degrades
  irreversible-action tasks without structural coordination*, which is worth one clean
  figure.

---

## E4 · Tier 3 throughput

**Feeds:** F4, C5. Fully specified in [`TIER3-THROUGHPUT.md`](./TIER3-THROUGHPUT.md) —
conditions, metrics, H1–H4, threats. Not repeated here.

Ordering note: E4 is **last among the WorkBench runs**. It cannot change the paper's
framing (the paper reports whichever of H1–H4 obtains), so it must not consume budget that
E1/E2 need. Prerequisites: E0 (stratum exists and is large enough) and the parallelism
check — the runner now warns when `agentOverlap < 0.2` across all multi-agent cells, and
`EVAL_MODEL_CONNECTIONS` defaults to `EVAL_CONCURRENCY × EVAL_N` so the pool cannot
silently serialize the agents.

---

## E5 · Second host

**Feeds:** T3. One benchmark is not generality; this is the main-track/workshop line.

Two candidates, both with adapters already in-repo:

- **CooperBench** — team-mode integration exists, OpenTasks as coordination backend. Closest
  in shape to the WorkBench Tier-2 setup, so likely the cheaper port.
- **TheAgentCompany** — adapter, TAC-native `S_partial`, and Docker/E2B/EC2 lifecycle all
  exist, but **no real arm results have ever been produced**. Higher risk, higher payoff
  (it is the recognised name).

The port needs the same three things WorkBench needed: a union action log across agents, a
grader that penalizes duplication, and a task stratum satisfying C1. **If a candidate host
cannot satisfy C1, that is a finding for the paper, not a blocker** — it is direct evidence
for the census claim.

---

## Discipline that applies to every run

- **Pair on task id.** Every cross-experiment comparison (manager vs single, single vs
  per-domain) pairs on the id list, never on "the first N."
- **One experiment per store dir.** `WB_SEED_MODE` and `manager` are each folded into the
  `runId` *and* the store directory, because the marble cache keys cells by
  benchmark/task/arm/model/seed — without that separation, switching modes silently reuses
  the other mode's cached cells.
- **Node 22.** The `better-sqlite3` ABI probe covers drift, but the system node has drifted
  to v26 before; run under 22 and check the daemon actually bound.
- **`EVAL_DEBUG_DIR` on every headline run.** Per-agent tool sequences and who-claimed-what
  are what turned Tier 2's numbers into a mechanism claim. A number without the trace is
  not reportable.
- **Record the un-stratified Δ too.** The honest framing needs both: the stratified effect
  *and* the ≈ 0 whole-benchmark effect. The second is not an embarrassment — it is C2.
