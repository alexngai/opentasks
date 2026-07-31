# Tier 3 — does coordination buy *throughput*, or only *safety*?

**Status: designed, not run.** This is a pre-registration: the question, the task
class, the metrics, the predictions, and the conditions under which each outcome
would be reported. Written before the run so a null is as reportable as a win.

## The gap this closes

Every Tier-2 result
([`results/2026-07-31-workbench-tier2-coordination.md`](./results/2026-07-31-workbench-tier2-coordination.md))
is a **harm-avoidance** result. The winning configuration, Option 1a
(`WB_SEED_MODE=single`), is single-writer *by construction*: one agent claims the whole
task, the rest stand down. It cannot regress below the model's solo ceiling — and it
cannot exceed it.

So the honest current claim is: **OpenTasks makes a swarm as good as one careful
agent.** The claim we have not earned is: **better than one agent.**

That gap is not a measurement oversight — it is baked into the task class. Every task
in the Tier-2 stratum requires **exactly one** side-effecting action. With k = 1
required actions, the maximum achievable parallelism is 1, and no arm, seeding mode, or
agent count can produce a speedup. Amdahl's serial fraction is 1.0 by construction.

**Tier 3 changes the task class, not the substrate.** Multi-action tasks are the only
place where a coordination layer can pay for itself in something other than avoided
damage.

## The question

> On tasks requiring k ≥ 2 **independent** side-effecting actions, does OpenTasks
> coordination let N agents finish in less critical-path work than one agent, **while
> preserving the correctness and harm profile** Tier 2 established?

Three sub-questions, in priority order:

1. **Throughput.** Does per-domain claiming beat single-writer on critical-path length
   at equal completion?
2. **Where the crossover is.** k = 1 favours single-writer (Tier 2 proved it). Some k
   must favour partitioned claiming. Locating that boundary is the design's real
   product — it converts "which mode?" from a guess into a rule.
3. **Cost.** What does the speedup cost in tokens, and is the (critical path, tokens,
   completion) frontier ever better than solo?

## Task class

**Required properties**, in order of importance:

| property | why | how it's obtained |
|---|---|---|
| k ≥ 2 required side-effecting actions | parallelism is impossible below this | classify against WorkBench's sealed answers |
| actions **mutually independent** | a serial dependency caps speedup regardless of coordination | actions touch distinct entities; no create→update chain on one id |
| actions in ≥ 2 distinct **public** domains | the split must be derivable from public metadata, or seeding leaks ground truth | the `domains` column |
| solo-correct at N=1 | ceiling = 1.00, so any drop is attributable to coordination | N=1 scan, per model |

Of the 210 `multi_domain` tasks, 123 are single-action side-effecting; the ≤ 87
remainder is the candidate pool, before the independence and solo-correct filters.
**The realized n is unknown until the classification runs** — if it lands below ~15,
the design falls back to the mitigation in *Threats* below.

### Seeding must not leak

A `per-action` seeding mode — one claimable unit per *required* action — would be the
theoretically ideal partition and is **disallowed**: the required actions are the sealed
ground truth. Every seeding mode must derive its partition from public metadata (the
`domains` column) or from the agent's own reading of the instruction. This is why
per-domain is the throughput candidate: on k = d tasks with one action per domain, the
public split *coincides* with the ideal one without ever consulting the answer.

## Conditions

Reference cell, then a 2 × 2 of coordination mode × agent count:

| condition | N | seeding | role |
|---|--:|---|---|
| `solo` | 1 | — | **reference**: the ceiling, and the critical-path denominator |
| `stock` | 2, 4 | — | uncoordinated baseline (expect fast + harmful) |
| `notes` | 2, 4 | `claims.txt` | convention baseline |
| `opentasks-single` | 2, 4 | `single` (1a) | Tier-2 winner; the safety control, expected ≈ solo |
| `opentasks-per-domain` | 2, 4 | `per-domain` | **the throughput candidate** |
| `opentasks-agent` | 2, 4 | agent-authored (below) | stretch: removes the harness's privileged split |

Models: **haiku-4.5 and sonnet-4.6**, both. Tier 2's central finding was that
per-domain is capability-gated — a throughput result on sonnet alone would not tell us
whether it generalises down.

### `WB_SEED_MODE=agent` (stretch)

Per-domain seeding uses the harness's knowledge of the `domains` column. That is public,
but it is still the *harness* partitioning the work — not how OpenTasks would be used.
The `agent` mode has one designated leader read the instruction, call
`mcp__opentasks__create_task` once per unit of work it identifies, then join the claim
loop like everyone else. Decomposition quality becomes part of what is measured, which
is both more realistic and noisier. Run it only after the per-domain result is in.

## Metrics

### Primary — hardware-independent

**Critical path (`criticalPathCalls`)** = max over agents of that agent's tool-call
count. Wall clock on a shared box, behind a rate-limited gateway, is too noisy to be a
headline. Critical-path calls measure the same thing — the longest serial chain — and are
reproducible.

- **Speedup** `S(N) = criticalPathCalls(solo) / criticalPathCalls(arm, N)`
- **Parallel efficiency** `E(N) = S(N) / N`
- Both are **computed only on cells where completion = 1.0 in both the arm and solo.**
  A speedup on a failed task is not a speedup. This is the single most important scoring
  rule in the design.

### Secondary

| metric | meaning |
|---|---|
| `makespanMs` | cell wall clock — reported, never the headline (see *Threats*) |
| `activeAgents` | agents performing ≥ 1 side-effecting action — **realized** parallelism, vs the N we asked for |
| `distinctSideEffects` | unique action refs in the union log |
| `unionSideEffects` | total actions in the union log (existing) |
| `R` | redundancy, `1 − distinct/total` (existing) |
| `maxAgentShare` | largest single agent's share of productive actions — detects "one agent silently did everything" masquerading as coordination |
| `totalTokens` | cost (existing) |

`activeAgents` and `maxAgentShare` are the falsification guards. Single-writer will show
`activeAgents = 1, maxAgentShare = 1.0` by design; if per-domain shows the same, it has
**degenerated into single-writer** and any completion parity is not a coordination
result. Without these two, that failure is invisible.

### Carried forward from Tier 2

`completion`, `harmful`, `R` — unchanged, same grader. Tier 3 must not trade away the
harm profile to buy speed; a mode that is faster and harmful has lost.

## Predictions (pre-registered)

| # | prediction | what it would mean |
|---|---|---|
| **H1** | per-domain: completion ≈ single-writer AND `S(N) > 1` with `activeAgents > 1` | **coordination buys throughput.** The efficiency claim is earned. |
| **H2** | per-domain: `S(N) > 1` but completion < single-writer | speed at the cost of correctness — the mode is capability-gated even where the split is right. Value stays safety-only; *report as such*. |
| **H3** | per-domain: completion ≈ single-writer but `S(N) ≈ 1`, `activeAgents ≈ 1` | agents serialize themselves regardless of the substrate. **The bottleneck is agent behaviour, not the coordination primitive** — a finding about swarms, not about OpenTasks. |
| **H4** | stock: `S(N) > 1` but harmful ≫ 0 | expected: uncoordinated swarms are fast and damaging. Sets up "speedup at equal safety" as the only meaningful comparison. |

**H2 and H3 are nulls for the efficiency thesis and will be reported as prominently as
H1.** Tier 2 already stands on its own as a safety result; it does not need Tier 3 to
succeed, which is exactly why Tier 3 can afford to be honest.

Expected crossover: single-writer should dominate at k = 1 (proven) and lose at large k;
the interesting region is k ∈ {2, 3}. If the classified pool supports it, report
completion and `S(N)` **as a function of k** — that is the publishable shape.

## Threats to validity

1. **Are the agents actually concurrent?** *Blocking prerequisite.* If swarmkit-eval's
   marble engine runs a phase's N agents sequentially, `makespanMs` measures nothing and
   even the critical-path metric is fine but the wall-clock secondary is a lie. **Verify
   before spending tokens:** instrument per-agent start/end timestamps and assert
   `makespanMs < 0.8 × Σ(agent durations)` at N = 2. Ship this as a cheap assertion in
   the runner, not a manual check.
2. **Gateway serialization.** `concurrency.modelConnections` currently defaults to
   `EVAL_CONCURRENCY` (1). With N agents per cell that caps in-cell parallelism at the
   connection pool and silently converts H1 into H3. Set `modelConnections ≥ N × cells`
   and record whether any request queued.
3. **Wall clock noise.** Shared box, rate-limited gateway, variable task length. Hence
   critical-path calls as primary; wall clock reported with medians over ≥ 3 repeats.
4. **Token inflation.** Each parallel agent re-reads the instruction and re-searches for
   entity ids, so tokens rise even when the critical path shrinks. This is a real cost,
   not an artefact — report the (critical path, tokens, completion) Pareto frontier
   rather than a single ratio. swarmkit-eval already renders a Pareto view.
5. **Thin stratum.** If k ≥ 2 ∧ independent ∧ solo-correct yields n < 15, the paired CI
   will not exclude 0 for anything short of a very large effect. Mitigations, in order:
   widen to all WorkBench domains rather than `multi_domain` only; add seeds per task
   (accepting that the bootstrap unit stays the task); and if still thin, report Tier 3
   as a **mechanism demonstration with per-task traces** rather than an effect size — and
   say so in the title.
6. **Grader blindness to partial work.** WorkBench grades the union of side effects
   against the final state; it has no notion of "half the task done fast." A cell where
   agents split the work but one stalls scores the same as one where nobody started.
   `activeAgents` + `distinctSideEffects` are the only visibility into that — another
   reason they are not optional.

## Execution plan

1. **Classifier** — `evals/swarmkit/wb-classify-tasks.ts`: read the WorkBench
   `multi_domain` CSV, parse each task's ground-truth answer into its side-effecting
   action list, and emit per-task `{id, k, domains, actionDomains, independent}` as JSON
   + a ready-to-paste `EVAL_TASK_IDS` list per stratum. *Needs the WorkBench repo
   checked out to pin the answer-column schema.*
2. **Parallelism assertion** — the timestamp check from Threat 1. Cheapest possible
   step, and it gates everything downstream.
3. **Metrics** — add `criticalPathCalls`, `activeAgents`, `distinctSideEffects`,
   `maxAgentShare`, `makespanMs` to `workbench-marble.ts`'s `score()`.
4. **Solo scan** — N = 1 over the k ≥ 2 pool, per model, to fix the ceiling and the
   critical-path denominator.
5. **Main run** — the condition table, N ∈ {2, 4}, ≥ 3 repeats, both models.
6. **Write-up** — `results/<date>-workbench-tier3-throughput.md`, reporting whichever
   of H1–H4 obtains, with the k-dependence curve if n supports it.

Steps 2–3 are harness work with no model spend and no WorkBench checkout required.
Step 1 needs the checkout. Step 4 onward needs the gateway.
