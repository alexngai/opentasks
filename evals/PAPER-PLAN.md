# Paper plan — one paper, research-question-first

**Decision (2026-07-31):** a single paper, not a system tech report plus a research paper.
OpenTasks appears as the *instrument* and as the reference implementation of one
coordination mechanism; it is not the contribution. The system description earns its
space only by making the paper's central distinction — **structural vs. instructed
coordination** — concrete enough to be falsifiable.

The test every claim must pass: **it survives OpenTasks being replaced by any other
substrate with a compare-and-set.** A claim that does not survive that substitution is a
product claim and belongs in the README, not the paper.

## Central claim

> Coordination effects in multi-agent LLM systems are observable only on a task stratum
> that current benchmarks systematically under-sample, and they transfer across models
> only when the coordination mechanism is **structural** rather than **instructed**.

Two halves, both falsifiable, both already partly evidenced:

- **Measurement half.** The same mechanism, benchmark, and model yields Δ = 0.000 or
  Δ = +0.889 depending only on task stratification. The false null is the exhibit.
- **Mechanism half.** Instructed coordination ("claim your domain, then stand down")
  degrades with model capability and collapses as N grows; structural coordination (an
  atomic claim that makes duplication impossible) is invariant to both.

### Working titles

1. *When Can a Benchmark See Coordination? Stratification and Capability-Gating in
   Multi-Agent LLM Evaluation*
2. *The Coordination Effect You Cannot Measure: Task Strata and Structural Guarantees in
   Multi-Agent LLM Systems*
3. *Structural, Not Instructed: Why Multi-Agent Coordination Results Do Not Transfer*

(1) is the most accurate to the contribution set; (3) is the most memorable if the
mechanism half ends up carrying the paper.

## Contributions

| | contribution | kind | status |
|---|---|---|---|
| **C1** | Necessary conditions for a benchmark to register a coordination effect (below), and a census of how much of a real benchmark satisfies them | conceptual | conditions drafted; census needs the classifier run |
| **C2** | Demonstration that violating any condition yields a **false null** — Δ 0.000 vs +0.889, same mechanism | empirical | **have** (n=6 vs n=18) |
| **C3** | Instructed coordination is capability-gated and N-fragile; structural coordination is invariant | empirical | **have** at n=8, 2 models, N ∈ {2,4}; needs widening |
| **C4** | Released harness: stratifier, union-grading multi-agent adapter, coordination metrics | artifact | **have**, needs packaging |
| **C5** | Structural coordination buys **safety, not throughput** — the honest limit | empirical | Tier 3, not yet run |

C5 is deliberately in the contribution list rather than the limitations section. Reviewers
reward a paper that reports the boundary of its own result, and the paper does not depend
on Tier 3 returning a win — see `TIER3-THROUGHPUT.md`, where H1–H4 are pre-registered.

## C1 — the conditions (the paper's spine)

For a benchmark to register a coordination effect on task *t* under grader *G*:

1. *t* requires ≥ 1 **side-effecting** action — otherwise both arms pass (query-only tasks)
2. *t* is **solo-achievable** by the model — otherwise both arms fail (capability ceiling)
3. *G* **penalizes duplication** — WorkBench's `harmful` flag does; most graders do not
4. *(throughput effects only)* *t* requires ≥ 2 **independent** side-effecting actions

Conditions 1–3 gate *safety* effects; 4 additionally gates *throughput* effects. This is
the paper's most transferable output: it applies to anyone evaluating coordination, and it
explains published nulls without needing to re-run them.

**The census is the punchline.** 123 of 210 WorkBench `multi_domain` tasks are
single-action side-effecting — which satisfies 1 and 3 but *violates 4*, so most of the
benchmark is structurally incapable of showing a throughput effect no matter what system
you evaluate. `npm run eval:workbench:classify` produces this table.

## Structural vs. instructed — the distinction OpenTasks exists to make concrete

This is the section that justifies describing the system at all. Keep it to ~1 page.

| | instructed | structural |
|---|---|---|
| mechanism | the prompt tells each agent to claim a domain and stand down elsewhere | exactly one claimable unit; `claim_next` is a conditional UPDATE, so at most one agent ever observes `claimed:true` |
| failure mode | agent ignores the instruction — a weak model fires the side effect on a domain it did not claim | none available: the losing agent has nothing to act on |
| evidence | collapses 1.00 → 0.25 (haiku) and → 0.13 (sonnet); → 0.00 at N=4 | 1.00 at N=2 both models; R = 0.00 at every N |

The system content worth including, all of it in service of this distinction: atomic claim
with **lease + fence token + reaper** (the cell-B result is the motivation — `notes`
orphaned an item via a reservation with no expiry, exactly the failure a lease recovers);
the union action log that makes duplication *gradeable*; and the honest substrate caveat
(git-native JSONL, field-level last-writer-wins on wall clock, no causality).

Everything else about OpenTasks — providers, URI schemes, MCP scopes, context files — is
out of scope. It goes in the repo docs.

## Structure

1. **Introduction** — the false null as the opening exhibit
2. **Related work** — multi-agent frameworks; agent benchmarks; leases/fencing from
   distributed systems (the mechanism is old, the application is not); evaluation validity
3. **When can a benchmark see coordination?** — C1, before any experiment. The conditions
   motivate the design rather than rationalizing it afterwards
4. **Instrument** — arms, the union-grading multi-agent setup, structural vs. instructed,
   metrics (`completion`, `harmful`, `R`, `A(N)`, `criticalPathCalls`)
5. **R1 — stratification** (C2)
6. **R2 — capability-gating and N-fragility** (C3)
7. **R3 — throughput** (C5)
8. **R4 — generality**: second benchmark host; controlled microbenchmark (the synthetic
   2×2, incl. the super-additivity interaction) as mechanism isolation
9. **Limitations** — selection on ground truth, n, model families
10. **Conclusion**

Note on §8: the synthetic 2×2 is *supporting*, not headline. Reviewers discount
self-authored benchmarks, but it isolates concurrency × continuity in a way no standard
host does, and the super-additivity result (convention-based coordination works on either
axis alone and collapses when both hit) is a genuine finding. Frame it as a controlled
complement to the external-benchmark evidence, never as primary evidence.

## Exhibit plan

Each exhibit maps to a run. This is the actual work list.

| # | exhibit | supports | data status |
|---|---|---|---|
| **F1** | The false null: paired Δ by stratum (mixed n=6 → targeted n=18), with CIs | C2 | **have** |
| **F2** | Stratum census of WorkBench — fraction of tasks that can register safety vs. throughput effects | C1 | **needs classifier run** (checkout only, no spend) |
| **T1** | Capability-gating: model × {stock, instructed, structural} × completion/harmful/R | C3 | **have** (n=8, haiku + sonnet) |
| **F3** | Error amplification A(N) = harm(N)/harm(1) vs N, per arm | C3 | **partial** — have N ∈ {2,4} haiku; need N=1 solo + sonnet N=4 |
| **T2** | Baselines incl. **manager/orchestrator agent** | C3 | **arm implemented** (`EVAL_ARMS=manager`); run E1 |
| **F4** | Throughput Pareto: `criticalPathCalls` × completion × tokens | C5 | needs Tier 3 |
| **T3** | Replication on a second host | C1/C3 | missing |
| **F5** | Synthetic 2×2 super-additivity | §8 | **have** |

F3 is worth building deliberately: `A(N)` is one number, rises roughly linearly in N
without coordination (union side-effects 1.88 → 3.88), and is flat with it. It is the
figure most likely to be remembered, and it directly contradicts the prevailing
more-agents-is-better framing.

Execution order, cost, and the decision gate after each run are in
[`EXPERIMENT-PLAN.md`](./EXPERIMENT-PLAN.md).

## Gating work, ranked

1. **Manager/orchestrator baseline (T2).** Without it the comparison set is two strawmen —
   nobody deploys uncoordinated agents. The real-world alternative is a planner agent that
   assigns work, which is what AutoGen/CrewAI/LangGraph do. If atomic claiming does not beat
   a manager agent, the framing must change; better to learn that now. *Design note:* the
   manager is an **instructed** mechanism with a single point of failure, so the paper's
   structural/instructed axis predicts it degrades with model capability too — which makes
   it a genuine test of C3, not just a baseline. **Implemented** — a width-1 `plan` phase before the
   width-N `work` phase, charged on the critical path, with `plannerSideEffects` catching a manager
   that acts as well as assigns. E1a in `EXPERIMENT-PLAN.md` is the 48-agent-run decision gate.
2. **Second host (T3).** Adapters exist for TAC and CooperBench. One benchmark is not
   generality; this is what separates a workshop paper from main track.
3. **Non-Anthropic model.** Capability-gating across two Anthropic tiers invites "artefact
   of one model family." Needs the GLM-5 proxy hardening that has blocked since June.
4. **n and seeds.** n = 8–18 at `seeds: [1]`. The cluster bootstrap over tasks is the right
   unit; the counts are thin. The classifier makes widening cheap.
5. **Tier 3 (F4).** Lowest priority for *acceptance* — the paper stands under any H1–H4
   outcome — but highest for completeness, and it is the only item that can convert C5 from
   a limitation into a result.

## Framing risk to manage

A paper whose thesis is "benchmarks cannot see this" reads as pure criticism, and pure
criticism is hard to accept. The constructive half must be foregrounded: the conditions
(C1) are a *design tool*, the classifier (C4) *operationalizes* them, and the structural
mechanism (C3) is a *fix*, not just a diagnosis. Lead with what to do, not with what is
broken.
