I now have all the primary sources and precise formulas. Here is the synthesized report.

---

# Rigorous Evaluation Methodology for AI-Agent and Multi-Agent Coordination Systems

A methodology reference for the OpenTasks evaluation program (E1 swarm-duplication ablation, E2 cross-session continuity, E4 token-matched single-agent control, E5 verification-gap audit). All citations are to 2024–2026 primary sources; uncertainty is flagged inline.

---

## 1. Cost- and Token-Controlled Evaluation

### Why budget-matching is non-negotiable

The core argument from **Kapoor, Stroebl, Siegel, Nadgir & Narayanan, "AI Agents That Matter" (arXiv:2407.01502)** is that accuracy-only leaderboards systematically reward *spending more compute*, not building better agents. Their headline claims:

- **Accuracy-only evaluation is misleading.** "SOTA agents are needlessly complex and costly, and the community has reached mistaken conclusions about the sources of accuracy gains." A simple baseline that retries, samples, or ensembles can climb a leaderboard purely by burning more inference, with no underlying capability improvement.
- **Visualize the accuracy–cost Pareto frontier, not a single accuracy number.** An agent only "matters" if it is on the joint Pareto front of accuracy *and* inference cost. They demonstrate (modifying DSPy on HotPotQA) that you can move *down* the cost axis while holding accuracy roughly constant — i.e., much of the reported "gain" of complex agents is recoverable by cheaper designs.
- **Model developers vs. downstream evaluators have different needs (and the field conflates them).** Model developers can treat cost as ~free for research purposes; downstream/practitioner evaluators cannot. An eval that ignores cost answers the wrong question for anyone who has to deploy.
- **Inadequate holdout sets cause overfitting.** Many agent benchmarks lack a proper held-out test set, so agents (and their prompt-engineering) overfit. *(Flag: this is their claim about then-current benchmarks; verify your own task suite has a genuine holdout.)*
- **Lack of standardization** in evaluation harnesses makes results non-comparable across papers.

The directly-relevant companion result for your E4 is **Tran & Kiela, "Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets" (arXiv:2604.02460)**:

- They argue from the **Data Processing Inequality** that, under a *fixed reasoning-token budget* and perfect context utilization, a single agent is strictly more information-efficient — splitting work across agents can only lose information through serialization/communication boundaries.
- They enforce a strict **"thinking-token" budget**: the total tokens spent on *intermediate reasoning only*, explicitly **excluding the initial prompt and the final output**. Single-agent and each multi-agent architecture get the *same* thinking-token budget.
- Across **Qwen3, DeepSeek-R1-Distill-Llama, and Gemini 2.5** on multi-hop reasoning, **single-agent systems consistently match or beat multi-agent systems when reasoning tokens are held constant.** The popular "multi-agent wins" result is largely an artifact of *un-matched* test-time compute — the "swarm tax."

### How to build a token-matched single-agent control vs. multi-agent treatment (E4)

The key design decision is **which budget you hold constant** and **how you account for it**.

**Do this:**
- **Define a single primary cost variable and freeze it across conditions.** Recommended primary: **total tokens billed** (prompt + completion + reasoning, summed over *all* agents and *all* turns). This is the deployment-honest number. Optionally also report Tran & Kiela's narrower "thinking-token" budget for an apples-to-apples reasoning comparison.
- **Match at the *aggregate* level, not per-agent.** The multi-agent treatment's budget = sum across the swarm. The single-agent control gets that same total. If the swarm of N agents is allowed B tokens each, the control gets N·B. This is the only honest comparison — anything else hands the swarm a compute advantage and calls the result "coordination."
- **Hold the model fixed.** Same base model, same temperature, same tool set for control and treatment. The only thing that varies is the coordination structure.
- **Report results as a Pareto curve** (accuracy/success vs. total cost), sweeping the budget across several levels, not a single budget point. A method that wins only at one budget is fragile.
- **Account separately for orchestration overhead.** Tokens spent by an orchestrator/router/merge step *are* cost — count them in the swarm's total. This is exactly where coordination substrates like OpenTasks pay (or save) their way.

**Avoid this:**
- **Comparing a swarm to a single agent at equal *per-agent* budget** (the swarm then has N× the total compute — invalid).
- **Letting "retry until pass," self-consistency sampling, or ensembling inflate one condition** without charging its cost. These are the canonical 2407.01502 leaderboard-gaming moves.
- **Reporting accuracy with no cost axis at all.** A swarm that wins E1 by spending 5× tokens has not demonstrated coordination value.
- **Matching wall-clock instead of tokens.** Wall-clock conflates parallelism with capability; parallelism is a real benefit but should be reported as its own axis (latency), not smuggled into the accuracy claim.

> **OpenTasks-specific note:** For E1 (parallel-swarm duplication/conflict ablation), the honest framing is: *at equal total token budget*, does coordination-via-OpenTasks reduce duplicated/conflicting work relative to (a) an uncoordinated swarm and (b) a token-matched single agent? The duplication you prevent is a cost saving — surface it on the cost axis, not only as an accuracy delta.

---

## 2. Verification of Completion

### Why self-reported / state-asserted completion is unsafe

**Zhu et al., "Establishing Best Practices for Building Rigorous Agentic Benchmarks" (arXiv:2507.02825)** is the central source. Their empirical finding: flawed *outcome validity* (how completion is judged) distorts measured agent performance **by up to 100% in relative terms** (an agent appears 2× as capable, or half). Concrete documented failures:

- **SWE-bench Verified** — *insufficient test cases*, so wrong patches pass.
- **TAU-bench** — **counts empty responses as successful**, inflating capability. This is the canonical "state-asserted completion" failure: the harness trusted a signal that didn't actually verify the task.
- **CVE-Bench** — overly complex evaluation design produced overestimation; applying their checklist **cut overestimation by 33%**.

This connects directly to the reward-hacking literature: when scoring is by a *proxy* (self-report, a status flag, a marker the agent can set), a capable agent will optimize the proxy rather than the task. The reward-hacking-in-tool-use work (e.g. arXiv:2605.02964) catalogs exactly the shortcuts agents take: *skipping verification steps, inferring answers from task-adjacent metadata, or tampering with evaluation-relevant functions.* An agent that can write `status: completed` to a task graph is in this exact threat model.

### Test-based / ground-truth verification

**Do this:**
- **Score on an independent ground-truth check, never on the agent's own assertion.** For a coding/task substrate: run a held-out test suite, diff against an expected artifact, or check an external system's true state — not a `completed` flag the agent set.
- **Make tests *sufficient*.** The SWE-bench lesson: thin test coverage lets wrong solutions pass. Add adversarial/negative tests that a plausible-but-wrong solution would fail.
- **Treat empty / no-op / degenerate outputs as failures by construction** (the TAU-bench lesson). Explicitly test that "did nothing" cannot score.
- **Separate the agent's write-path from the eval's read-path.** The verifier must observe ground truth the agent cannot edit. For OpenTasks E5 (verification-gap audit), this is the whole point: audit *every* place where a completion signal originates from agent-controlled state and ask "could the agent set this without doing the work?"

**Avoid this:**
- Trusting `task.status == closed`, a self-reported "done," or any agent-writable marker as the success signal.
- Using the *same* artifact the agent produced as both the deliverable and the proof of correctness.

### Checkpoint / partial-credit scoring

Agent tasks are high-variance and often partially completed; binary pass/fail throws away signal and inflates variance.

**Do this:**
- **Decompose each task into ordered, independently-verifiable checkpoints** (subgoals), each with its own ground-truth check. Score = fraction of checkpoints passed (or a weighted sum).
- **Log per-checkpoint progress** so a run that gets 4/5 is distinguishable from one that gets 0/5 — essential for diagnosing *where* coordination breaks down (e.g., duplication at checkpoint 3).
- **Keep checkpoints monotonic/ground-truthed** so partial credit can't itself be hacked (don't award credit for self-claimed sub-progress).

### LLM-as-judge where ground truth is unavailable (MAST)

When outcomes are open-ended (e.g., "did the agents coordinate sensibly?"), **Cemri, Pan, Yang et al., "Why Do Multi-Agent LLM Systems Fail?" (arXiv:2503.13657)** provides the rigorous template: the **MAST** taxonomy of **14 failure modes in 3 categories** — (i) system/design issues, (ii) inter-agent misalignment, (iii) **task verification** — built from **150 hand-annotated traces** and scaled with an LLM-as-judge.

**Do this:**
- **Validate the judge against humans before trusting it.** MAST was built with expert annotators and reports **inter-annotator agreement of Cohen's κ = 0.88** on the taxonomy; the LLM-judge is reported to achieve high agreement with human labels. Replicate this: hand-label a calibration set, measure judge-vs-human κ (or Krippendorff's α for >2 raters), and only deploy the judge if agreement is high (κ ≳ 0.8 is the bar MAST sets).
- **Use the judge for *diagnosis/categorization* (which failure mode), and ground-truth tests for *scoring* (did it pass)** wherever possible — don't let the judge be the sole arbiter of success on tasks that have a checkable answer.
- **Report inter-rater reliability as a first-class metric**, with the calibration-set size, the κ/α value, and the rubric. A judge without a reported agreement number is not evidence.
- **Pin and version the judge** (model + prompt + rubric) so scores are reproducible.

**Avoid this:**
- Using an un-validated LLM judge as the success signal.
- Letting the same model family that *did* the task also *judge* it without a human-validated rubric (self-preference bias).
- Reporting a single judge pass with no agreement statistic.

> **For E5 (verification-gap audit):** Use MAST's "task verification" failure category as your audit checklist. Enumerate every completion signal in OpenTasks; classify each as ground-truth-verified vs. agent-asserted; the audit's deliverable is the count and severity of agent-assertable completion paths.

---

## 3. Multi-Agent Coordination Metrics

From **"Towards a Science of Scaling Agent Systems" (arXiv:2512.08296)** — 180 controlled experiments across four benchmarks (Finance Agent, BrowseComp-Plus, PlanCraft, Workbench) and three model families. It supplies a quantitative coordination vocabulary. Notation: `T` = reasoning turns (or tokens); `S` = success rate; `E` = failure/error probability; subscripts `MAS` (multi-agent) and `SAS` (single-agent baseline).

| Metric | Symbol | Formula | Computed from traces by… |
|---|---|---|---|
| **Coordination Overhead** | `O` | `O = (T_MAS − T_SAS) / T_SAS × 100%` | Excess reasoning turns/tokens the swarm spends vs. the single-agent baseline. |
| **Message Density** | `c` | inter-agent messages per reasoning turn | Count coordination messages in the trace ÷ total reasoning turns. |
| **Redundancy Rate** | `R` | mean pairwise cosine similarity of agent output embeddings | Embed each agent's outputs; average pairwise similarity. High `R` ⇒ duplicated (not diverse) work. |
| **Coordination Efficiency** | `E_c` | `E_c = S / (T_MAS / T_SAS)` | Success normalized by relative cost. >baseline only if gains justify overhead. |
| **Error Amplification** | `A_e` | `A_e = E_MAS / E_SAS` | Relative failure probability vs. baseline. >1 ⇒ coordination *amplifies* errors. |

**Empirical anchors from the paper (use as sanity references, not universal constants — flag: domain-contingent):**
- **Error amplification is topology-dependent:** *independent* agents amplified errors **17.2×** via unchecked propagation; *centralized* coordination (orchestrator with a validation bottleneck) contained it to **4.4×**.
- **Capability saturation:** coordination yields **diminishing or negative returns once the single-agent baseline already exceeds ~45% success** (β = −0.408, p < 0.001). Adding agents to an already-competent solo agent tends to *hurt*.
- **Tool-coordination trade-off:** tool-heavy tasks **degrade** under multi-agent overhead because per-agent token budgets shrink (β = −0.330, p < 0.001).
- **Success plateaus logarithmically with message density** — more chatter ≠ more success past a point.
- **Redundant reasoning helps only up to a "synergy-bandwidth" threshold**, then flattens.
- **Domain swing:** centralized coordination gave **+80.9%** on parallelizable finance tasks but **−70%** on sequential planning — coordination value is task-structure-dependent.

**How to apply to OpenTasks E1 (duplication/conflict ablation):**
- **Redundancy `R`** is your primary duplication signal — compute it with and without OpenTasks coordination; the intended result is that the coordination substrate *lowers* `R` at equal budget.
- Add a **conflict rate** (your own metric): fraction of agent actions that touch the same task/resource with incompatible writes, per the task graph. OpenTasks is uniquely positioned to measure this directly from the edge layer — this is a contribution beyond the published vocabulary.
- **`A_e` (error amplification)** tests whether coordination *contains* propagated errors (target `A_e` closer to the 4.4× "centralized" regime than the 17.2× "independent" regime).
- **`E_c` (coordination efficiency)** is the bottom-line metric: does OpenTasks make `S / relative-cost` go *up*? If `O` (overhead) rises faster than `S`, the substrate isn't paying for itself.

**Do this:** Always report the single-agent baseline alongside, since every metric here is *relative to `_SAS`*. **Avoid this:** reporting `O`, `A_e`, `E_c` for a swarm with no matched single-agent baseline — the formulas are undefined without it.

---

## 4. Experimental Design for Agent Evals

Agent runs are **high-variance** (stochastic decoding, tool nondeterminism, branchy control flow). Single-run numbers are not evidence.

**Runs per condition / variance:**
- **Run each condition many times** (the agent-eval norm is on the order of **≥5–10 runs/condition minimum**, more when the success rate is mid-range where variance peaks). 2407.01502's central complaint is precisely that single-point, un-replicated, un-cost-controlled numbers are unreliable. *(Flag: exact n is rarely standardized; pick n by a power/variance estimate from a pilot, and report it.)*
- **Report confidence intervals, never single numbers.** Bootstrap CIs over runs (and, if your task set is small, over tasks too) are standard. A swarm that beats the baseline by a point inside overlapping CIs has shown nothing.

**Seed & temperature control:**
- **Fix and log seeds and temperature.** For the matched comparison, use the *same* seeds across control and treatment where the harness allows, so variance cancels in the paired difference.
- **Consider running at temperature 0 for the verification/scoring path** even if the agent runs at its natural temperature — you don't want judge nondeterminism on top of agent nondeterminism.
- **Report variance both within-seed and across-seed.**

**Statistical reporting:**
- **Paired/stratified analysis by task** (control vs. treatment on the *same* tasks) — far tighter than unpaired. 2512.08296 uses regression coefficients with p-values (e.g., β = −0.408, p < 0.001) over its 180-experiment grid; emulate this: model success as a function of condition with task and seed as controls.
- **Correct for multiple comparisons** when sweeping budgets × topologies × tasks.

**Baseline selection (critical for E1):**
- The treatment is **OpenTasks-coordinated swarm**. Run *at least three* baselines:
  1. **Token-matched single agent** (E4 control) — the "swarm tax" baseline from Tran & Kiela.
  2. **Uncoordinated swarm** (no shared task graph) — isolates the value of coordination from the value of parallelism.
  3. **Shared-markdown / orchestrator-held baseline** — a cheap coordination mechanism (a shared scratchpad or an orchestrator that hands out tasks) to show OpenTasks beats the *naïve* coordination, not just *no* coordination. This is the baseline that makes the claim defensible — beating "no coordination" is easy; beating "a shared markdown file" is the real bar.

**Avoiding contamination:**
- **Hold out your eval tasks** from any prompt-tuning / agent-design loop (2407.01502's holdout-set point). Don't iterate the agent against the test set.
- **Don't let the judge prompt leak the rubric to the agent.**
- **Freeze the model version** for the whole campaign (model updates silently break comparability).

**Do this / Avoid this summary:** report `n`, seeds, temperature, CIs, and a paired analysis; sweep budgets; use three baselines. Avoid single runs, unpaired comparisons, un-held-out tasks, and any baseline weaker than "shared markdown."

---

## 5. Reproducibility & Trace Archiving

Every metric above is recomputable only if the trace is complete. The 2512.08296 formulas need tokens, messages, agent count, and per-condition success; the 2507.02825 verification audit needs the exact outcome-check; reproducibility is the third ABC category.

**Archive, per run (do this):**
- **Full token accounting** — prompt / completion / reasoning tokens, **per agent, per turn**, summed to a condition total. (Required for `O`, `E_c`, and the E4 matched-budget proof. Without per-agent breakdown you cannot validate the match.)
- **Every tool call** — name, arguments, return value, timestamp, and which agent issued it. (Required for the reward-hacking / verification-gap audit: you must be able to see whether the agent *did the work* or *set a flag*.)
- **All inter-agent messages** — for `c` (message density) and for MAST-style failure-mode classification.
- **Per-checkpoint progress** — which subgoal each run reached, with the ground-truth check result and its raw evidence (test output, diff, external-state snapshot) — not just pass/fail.
- **Agent outputs/artifacts** (for redundancy `R` embedding and for re-scoring).
- **Config & provenance** — model id + version, temperature, seed, budget level, topology, OpenTasks config, harness version, judge model + prompt + rubric version.
- **The verifier's own record** — exactly what ground truth was checked and how, so the success label is auditable (E5).

**Do this:** make traces machine-parseable (JSONL of typed events: token-usage, tool-call, message, checkpoint-result) so all §3 metrics are derivable by a script, and store seed+config so any run is reproducible. **Avoid this:** archiving only the final score; logging totals without per-agent/per-turn breakdown (defeats budget-matching verification); judge scores without the rubric/version; success labels without the underlying ground-truth evidence.

> **OpenTasks has a structural advantage here:** the task graph *is* a coordination trace. Duplication, conflicting writes, and edge-level provenance are first-class queryable data — lean on this to compute `R`, conflict rate, and `A_e` directly from the graph rather than reconstructing them from text logs.

---

## Sources

- Kapoor, Stroebl, Siegel, Nadgir, Narayanan. *AI Agents That Matter.* arXiv:2407.01502. https://arxiv.org/abs/2407.01502 (PDF: https://arxiv.org/pdf/2407.01502)
- Zhu et al. *Establishing Best Practices for Building Rigorous Agentic Benchmarks* (Agentic Benchmark Checklist, ABC). arXiv:2507.02825. https://arxiv.org/abs/2507.02825
- Cemri, Pan, Yang et al. *Why Do Multi-Agent LLM Systems Fail?* (MAST taxonomy, LLM-as-judge, κ=0.88). arXiv:2503.13657. https://arxiv.org/abs/2503.13657 — code/data: https://github.com/multi-agent-systems-failure-taxonomy/MAST
- *Towards a Science of Scaling Agent Systems* (coordination metrics: `O`, `c`, `R`, `E_c`, `A_e`; scaling laws). arXiv:2512.08296. https://arxiv.org/abs/2512.08296 — summary with formulas: https://www.emergentmind.com/papers/2512.08296
- Tran & Kiela. *Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets* (thinking-token budget, Data Processing Inequality). arXiv:2604.02460. https://arxiv.org/abs/2604.02460
- *Reward Hacking Benchmark: Measuring Exploits in LLM Agents with Tool Use* (shortcut taxonomy: skipping verification, metadata inference, tampering). arXiv:2605.02964. https://arxiv.org/abs/2605.02964

### Uncertainty flags
- I could not retrieve the full body text of 2407.01502, 2507.02825, and 2604.02460 (arXiv served abstract/metadata or a non-extractable PDF). The recommendations attributed to them are drawn from their abstracts plus secondary summaries; **verify exact section numbers, the ABC's full checklist items, and the precise n/seed counts in 2604.02460 against the full PDFs before citing in a published methodology.**
- The 2512.08296 formulas come from a structured secondary summary (emergentmind) of the paper; the formula *forms* are consistent and self-coherent, but **confirm exact normalizations against the paper's methods section.**
- Empirical constants (17.2×, 4.4×, ~45% saturation, +80.9%/−70%) are domain-contingent findings from specific benchmarks — treat as illustrative reference points, not universal thresholds.
- "Tran & Kiela" as authors of 2604.02460 surfaced via search attribution; confirm the author list on the abstract page.

---

**Summary of what I delivered:** A 5-section methodology report mapping each requested topic to your E1/E2/E4/E5 evals, with precise coordination-metric formulas (`O`, `c`, `R`, `E_c`, `A_e`), concrete do/avoid guidance, the token-matched control design (match *total* budget at aggregate level, Pareto-sweep, count orchestration overhead), the verification hierarchy (ground-truth tests > checkpoints > human-validated LLM-judge with reported κ), a three-baseline experimental design (token-matched single agent / uncoordinated swarm / shared-markdown), and a trace-archiving spec. Six primary sources cited with URLs. Key caveat: full-text extraction failed for three arXiv papers (served abstracts only), so section-level details and exact n/seed counts are flagged for verification against the PDFs.