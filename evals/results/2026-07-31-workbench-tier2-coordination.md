# WorkBench Tier 2 — multi-agent coordination on outcome-graded work (2026-07-31)

The consolidated write-up of the WorkBench arc (2026-07-09 → 2026-07-12): the first
result where OpenTasks' coordination payoff is measured on a **standard, externally
authored benchmark** with its own outcome grader, rather than on the homegrown
synthetic emit-queue.

This supersedes the running prose in [`../swarmkit/README.md`](../swarmkit/README.md)
as the citable record. That file remains the operator's manual (setup, env vars,
gotchas); this is the finding.

- **Benchmark:** WorkBench "Revisited" (olly-styles/WorkBench) — 690 outcome-graded
  workplace-agent tasks over calendar / email / analytics / CRM / project-board.
  Graded by **replaying the agent's recorded side-effecting tool calls against a
  fresh sandbox**, using WorkBench's own `is_correct` / `has_side_effects`, plus a
  **harmful-action** flag. Ground truth throughout — never graph state, never
  self-report.
- **Harness:** `evals/swarmkit/workbench-marble-run.ts` (`npm run eval:workbench:marble`)
  on swarmkit-eval's native `marble` engine. All WorkBench machinery (tool bridge,
  grader, benchmark) lives in swarmkit-eval; this repo only composes it with the arms.
  **No OpenTasks core change** — base functionality only.
- **Tier 2 setup:** N agents on ONE `multi_domain` task, sharing one sandbox and one
  workspace, so their per-agent WorkBench MCP servers append to ONE union action log.
  Grading replays the **union** of all agents' side-effecting calls — so a *duplicate*
  side effect (two agents both send the email) is a WorkBench **harmful action**.
  That is precisely what `claim_next` exists to prevent.
- **Arms** (same model, same tasks; only the coordination channel varies):
  `stock` (no channel) · `notes` (`claims.txt` by convention) · `opentasks` (atomic
  `claim_next` + `update_task` close).
- **Models:** claude-sonnet-4.6 and claude-haiku-4.5, both via the Bedrock LiteLLM
  gateway.

## Result 1 — Tier 1 (single agent) is a non-result, by construction

A first live smoke put WorkBench behind ONE OpenTasks-scaffolded agent (3 email
tasks, haiku): stock 0.33 vs opentasks 1.00 completion, 0 harmful, 0 env-errors.
**n=3 — not significant, and not the interesting question.** Single-domain WorkBench
tasks are 1–4 tool calls: too short for a planning scaffold to move the needle. The
Tier-1 entrypoint is retained as a substrate check, not as evidence.

## Result 2 — the effect is real but **sample-gated**

WorkBench's `harmful` flag is duplication-COUNT-insensitive: one wrong action and two
duplicate wrong actions both score `harmful`. So coordination can only move the score
on tasks where the required action is **(a) side-effecting AND (b) single-agent-correct**
— there, and only there, does a duplicate flip pass → fail.

Of 210 `multi_domain` tasks, 123 are single-action side-effecting. An N=1 solo scan
identifies which of those the model gets right alone (sonnet: `send_email` 10/10,
`create_task` 7/7, `add_customer` 1/3, `create_event` 0/4 — the time-computation trap
fails). Running N=2 stock-vs-opentasks (per-domain seeding) on that stratum:

| sample | n | opentasks compl | stock compl | Δ (paired) | opentasks harmful | stock harmful | redundancy R (ot/stock) |
|---|--:|--:|--:|--:|--:|--:|--:|
| first-6 (mixed, default) | 6 | 0.50 | 0.50 | **+0.000** | 0.50 | 0.50 | 0.00 / 0.25 |
| single-action-correct | 12 | 0.92 | 0.08 | +0.833 ✓ (CI 0.58–1.00) | 0.00 | 0.92 | 0.00 / 0.40 |
| single-action-correct (widened) | **18** | **0.94** | **0.06** | **+0.889** ✓ (CI 0.72–1.00) | 0.00 | 0.94 | 0.00 / 0.43 |

_(sonnet-4.6; paired Δ with a cluster bootstrap over tasks. The CI excludes 0 on the
targeted stratum and tightens as the stratum widens.)_

**Mechanism, confirmed in 17 of the 18 widened cells** (per-cell dumps via
`EVAL_DEBUG_DIR`): stock's two agents BOTH perform the one required action (union
side-effects ≈ 2) → the duplicate is harmful → fail. opentasks claims distinct domains
→ 1 action → correct → pass (R 0.00 vs 0.43). The lone opentasks miss is an
`add_customer` task whose public domain split (`crm` / `project_management`) did not
isolate the single required action — both agents updated the same customer.

Cost: opentasks ≈ **2.4× tokens** for the claim/close overhead.

> **The methodological point is as important as the number.** On the mixed default
> sample the same mechanism produces Δ = 0.000, because pure-query tasks pass under
> both arms and hard-accuracy tasks fail under both. Reporting the default sample would
> have concluded "coordination doesn't help." To *measure* coordination you must
> oversample the stratum where duplication is the binding constraint.

## Result 3 — per-domain coordination is **capability-gated**

Splitting by public domain only prevents duplication if each agent *stands down* on a
domain whose work it did not claim. That is a prompt-compliance property, not a
structural one, and it fails in two distinct ways:

1. **Weak models don't stand down.** A haiku agent that claims a read-only domain
   (`analytics`) still fires the task's one side effect anyway. Union stays ≈ 2 → harmful.
2. **The domain split ≠ the action split.** A `send_email` task tagged `[email, calendar]`,
   or a `create_task` tagged `[analytics, project_management]`, has one required action
   but two claimable domains. **Even sonnet duplicates** here.

## Result 4 — Option 1a (single-writer seeding) removes the capability dependence

`WB_SEED_MODE=single` seeds exactly ONE claimable "do the whole task" unit instead of
one per domain. Atomic `claim_next` awards it to exactly one agent; every other agent
receives `claimed:false` and stops. Duplication becomes **structurally impossible**,
independent of model capability, and the domain-split≠action-split failure disappears.

Validated at N=2 on 8 single-action-correct `multi_domain` tasks (4 `send_email` +
4 `create_task`; each solo-correct, so the **solo ceiling is 1.00**):

| model | arm / mode | completion | harmful | union side-effects | redundancy R |
|---|---|--:|--:|--:|--:|
| haiku-4.5 | stock | 0.13 | 0.88 | 1.88 | 0.38 |
| haiku-4.5 | opentasks per-domain | 0.25 | 0.75 | 1.75 | 0.38 |
| haiku-4.5 | **opentasks single (1a)** | **1.00** | **0.00** | **1.00** | **0.00** |
| sonnet-4.6 | stock | 0.00 | 1.00 | 2.00 | 0.50 |
| sonnet-4.6 | opentasks per-domain | 0.13 | 0.88 | 1.88 | 0.38 |
| sonnet-4.6 | **opentasks single (1a)** | **1.00** | **0.00** | **1.00** | **0.00** |

Per-domain collapses to 0.13–0.25 for **both** models on this stratum (chosen so the
domain split does *not* isolate the action — the adversarial case for Result 2's mode).
Single-writer recovers the **full solo ceiling** (1.00 / harmful 0.00 / union → 1 /
R → 0) for both. Mechanism confirmed in every cell via `EVAL_DEBUG_DIR`: exactly one
agent acts, and the non-claiming agent performs **zero** side effects
(`claim_next` → `claimed:false` → stop).

## Result 5 — only single-writer survives more agents

Scaling N (haiku), reported as `completion / R / union side-effects`:

| mode | N=2 | N=4 |
|---|---|---|
| stock | 0.13 / 0.38 / 1.88 | 0.00 / 0.71 / 3.88 |
| opentasks per-domain | 0.25 / 0.38 / 1.75 | 0.00 / 0.66 / 3.38 |
| **opentasks single (1a)** | **1.00 / 0.00 / 1.00** | **0.75 / 0.00 / 0.88** |

Stock and per-domain both **collapse to 0.00 as N grows** — duplication scales with
agent count (union → ~4, R → ~0.7). Per-domain cannot cap it because haiku ignores both
forms of self-restraint it requires: at N=4 only 2 domains are claimable, yet 3–4 of the
4 agents fire the side effect regardless. Single-writer holds at **R = 0.00 at every N**;
its N=4 completion (0.75) sits at haiku's *solo* ceiling ± n=8 noise — the two misses are
the lone writer failing the task, not a coordination failure. **1a vs stock at N=4:
Δ +0.75.**

## Findings

1. **Coordination has a large, significant effect on outcome-graded workplace tasks —
   in the stratum where duplication binds.** Paired Δ +0.889 (CI 0.72–1.00) at n=18,
   harmful 0.94 → 0.00. This is the synthetic emit-queue result (cell B/D) reproduced on
   a benchmark we did not author, with that benchmark's own grader.
2. **Convention-based coordination is capability-gated; an atomic primitive is not.**
   Per-domain claiming still relies on the agent restraining itself; it degrades with
   weaker models and collapses entirely as N grows. Single-writer `claim_next` is
   structural — one agent can hold the unit, so no amount of agent misbehaviour produces
   a duplicate. R = 0.00 in every single-writer cell at every N and both models.
3. **Duplication is the dominant multi-agent failure mode, and it scales with N.** Union
   side-effects track agent count almost exactly under stock (1.88 at N=2, 3.88 at N=4).
   Adding agents to an uncoordinated swarm makes irreversible workplace tasks
   monotonically worse, not better.
4. **Safety-critical benchmarks under-report coordination unless you stratify.** The
   duplication-count-insensitive `harmful` flag means the effect is invisible on a
   naive first-N sample (Δ = 0.000). Stratifying on `single-action ∧ solo-correct`
   surfaces it. This generalises: any outcome grader that saturates will hide a
   coordination effect.
5. **The measured guarantee is safety, not speed** — see the limits below.

## What this does **not** show

Stated plainly, because the trade-off is real:

- **No throughput claim.** Option 1a is single-writer by construction: one effective
  worker per task. It cannot regress below the model's solo ceiling — and it cannot
  exceed it either. Every number above is a *harm-avoidance* result. On this evidence
  OpenTasks makes a multi-agent swarm **as good as one careful agent**; it has not yet
  been shown to make it **better than one agent**. Closing that gap requires the
  multi-action task class where parallelism can actually pay — designed in
  [`../TIER3-THROUGHPUT.md`](../TIER3-THROUGHPUT.md), not yet run.
- **Coordination is not free.** ≈ 2.4× tokens for the claim/close overhead at N=2. On
  the targeted stratum that buys a 0.06 → 0.94 completion swing, so the trade is
  overwhelmingly worth it there; on the mixed sample it is pure cost.
- **Selection is on ground truth.** The stratum is chosen using WorkBench's sealed
  answers (action count) plus a solo scan (solo-correctness). That is legitimate
  *stratification* — the agents never see it, and the arms are compared within an
  identical task set — but the headline Δ is an effect size **conditional on the
  stratum**, not a whole-benchmark improvement. The un-stratified `multi_domain` Δ is
  ≈ 0.
- **Small n, one seed per cell.** n = 18 (widest), n = 8 for the 1a matrix, `seeds: [1]`.
  The bootstrap is over tasks (the D9 clustering), which is the right unit, but these are
  effect-size estimates from tens of tasks, not hundreds.
- **One benchmark, one task family.** `multi_domain` WorkBench only. The synthetic 2×2
  agrees directionally, but two agreeing evaluations are not a literature.
- **Single-writer's 1.00 is a ceiling artefact.** The 1a stratum was chosen for
  solo-correctness, so 1.00 is exactly the expected best case. The informative part is
  harmful 0.00 / R 0.00 / union → 1, which is mechanism, not accuracy.

## Reproduce

```sh
# targeted oversample, per-domain (Result 2) — sonnet via the Bedrock gateway:
WB_GATEWAY_BASE_URL=http://127.0.0.1:4000 WORKBENCH_LLM_API_KEY=sk-… AWS_REGION=us-east-1 \
  EVAL_MODEL=claude-sonnet EVAL_ARMS=stock,opentasks EVAL_N=2 \
  EVAL_TASK_IDS=wb-multi_domain-78b0f2e1b29a,wb-multi_domain-cc223e5fe99f,… \
  npm run eval:workbench:marble

# Option 1a single-writer (Results 4–5) — add WB_SEED_MODE=single, sweep EVAL_N:
WB_SEED_MODE=single EVAL_N=4 EVAL_MODEL=claude-haiku EVAL_ARMS=stock,opentasks \
  EVAL_DEBUG_DIR=evals/.wb-debug EVAL_TASK_IDS=… npm run eval:workbench:marble
```

Task ids are `wb-<domain>-sha1(task)[:12]`. `WB_SEED_MODE` is folded into both the
`runId` and the store directory, so `single` and `per-domain` are distinct experiments
and never share a cache entry.

**Two environment gotchas that silently disable coordination** (both fixed in the
harness; symptom of either is `Daemon did not start within 10000ms` and a false Δ = 0):
a daemon socket nested under the deep in-process workspace exceeds macOS's 103-byte
`sun_path` limit and fails to bind (fixed: short `/tmp/ote-XXXXXX/daemon.sock`
published to `ws.root/.ot_sock`); and `npx tsx`'s node can differ in ABI from the node
that built `better-sqlite3`, crashing the daemon before it binds (fixed:
`resolveOpentasksNode()` probes candidates by instantiating a DB). Run under node@22.

Reports → `evals/.swarmkit-workbench-marble-{single,per-domain}/report.{md,html,json}`
(gitignored). Per-cell agent tool sequences, who-claimed-what, and the union action log
land in `EVAL_DEBUG_DIR`.
