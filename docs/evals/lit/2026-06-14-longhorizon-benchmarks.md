I have all the material needed. Synthesizing the final report now.

---

# Long-Horizon Agent Benchmarks & Why Agents Fail at Long Horizons

**Prepared for: OpenTasks evaluation program design** | Research window: 2024–2026 primary sources

> **Bottom line for OpenTasks:** The literature now strongly supports the claim that long-horizon agent failure is driven less by reasoning capacity and more by *execution-state management* — context rot, self-conditioning on prior errors, goal/plan drift, and memory limits. These are precisely the failure modes an external, structured, persistent task store is positioned to attack. The strongest empirical lever is checkpoint-based partial-credit scoring (TheAgentCompany's `S_partial` formula), which lets you measure progress at a fixed budget rather than pass/fail — ideal for an A/B of "agent + task graph" vs. "agent alone."

---

## 1. The Benchmark Landscape (2024–2026)

### Summary table: benchmark → horizon → scoring → SOTA

| Benchmark | What it measures | Horizon / task length | Scoring method | Current SOTA (holder) |
|---|---|---|---|---|
| **TheAgentCompany** (arXiv:2412.14161) | Consequential "digital worker" tasks in a simulated software company (browse, code, run programs, chat with simulated coworkers) | Long: ~29 steps avg per task; 175 tasks | **Checkpoint partial-credit** (`S_partial`, see §4) + binary full-completion | ~24% full / ~34.4% partial (Claude 3.5 Sonnet at paper time; frontier ~30%+ since) |
| **SWE-bench Verified** | Resolve real GitHub issues; human-validated 500-task subset | Medium-long; repo-scale patches | **Test-based** (hidden tests pass) | ~80%+ (Claude Fable 5 / DeepSeek-V4-Pro ~80.6%, mid-2026) |
| **SWE-bench Pro** | Harder, contamination-resistant SWE tasks | Longer/harder than Verified | Test-based | ~80.3% (Claude Fable 5, Jun 2026, vendor-reported) |
| **SWE-bench Multimodal** | SWE tasks with visual inputs (screenshots, UI, diagrams) | Repo-scale + visual | Test-based | (lower than Verified; visual grounding gap) |
| **SWE-bench Live** | Auto-updating, multi-language/OS SWE tasks (anti-contamination) | Repo-scale, continuously refreshed | Test-based | Continuously updated leaderboard |
| **Terminal-Bench (2.0 / 2.x)** | Operate a computer via terminal end-to-end (compile, train models, sysadmin, security); 89 expert tasks, 5 attempts each | Long, end-to-end CLI workflows | **End-state / outcome verification** in containers | ~0.50 (Claude Sonnet 4.5 leads the 2.x board) |
| **GAIA** | General assistant Qs needing reasoning + multimodality + web + tools; 3 difficulty levels, 450 Qs | Multi-hop, tool-use | **Exact-match answer** (unambiguous) | Humans ~92%; top agents ~75% (varies sharply by scaffold; HAL Generalist ~65% reported) |
| **τ-bench / τ²-bench** | Tool-Agent-User customer-service dialogues (retail, airline, telecom); τ² adds dual-control (user also has tools) | Multi-turn conversational | **DB end-state vs. goal state**; **pass^k** reliability metric | τ²-Telecom ~98–99% (frontier models incl. Claude Fable 5 ~98.5%); original τ-airline was <40% for GPT-4o era |
| **WebArena** | Realistic self-hosted web tasks (e-commerce, forums, CMS) | Multi-step web navigation | **Functional / end-state** checks | ~54–60% (Gemini 3.1 Pro ~53.8%; "standard model" Planner+Executor+Memory architectures push ~60%) |
| **VisualWebArena** | Visually-grounded web tasks for multimodal agents | Multi-step, vision-grounded | Functional / end-state | Low historically (~16% for early VLMs); improving with replay/tree-search methods |
| **BrowseComp** (arXiv:2504.12516) | Locate hard-to-find, entangled info via persistent multi-hop browsing; 1,266 Qs | Deep multi-hop research | **Exact-match answer** | ~59.5% (GPT-5 Pro); OpenAI Deep Research 51.5% at launch; open MiroThinker-1.7 reports ~74% |
| **OSWorld** (arXiv:2404.07972) | Open-ended tasks in real OS/GUI environments | Up to 50–100 steps | **Execution-based** (final state) | ~72.6% (GPT-5 + Opus 4.5 ensembles), now ~human (72.36%); was 12% at launch |

**Caveats / uncertainty flags:**
- SOTA numbers move monthly and **vendor-reported scores** (especially SWE-bench Pro, τ²) are not always independently reproduced — treat headline numbers as upper bounds.
- GAIA scores diverge wildly across leaderboard snapshots because they depend on the **agent scaffold**, not just the base model. The same is true for WebArena/OSWorld (scaling/ensemble methods inflate scores).
- "Newer long-horizon-specific" benchmarks surfaced in search (RetailBench, MemoryArena, LOCA-bench, LoCoMo, InfiAgent's infinite-horizon framing) — these explicitly target *evolving execution state* and *memory*, which is the most relevant emerging category for OpenTasks (see §5).

---

## 2. Horizon-Length as a Metric (METR and follow-ups)

**METR's task-completion time horizon** ("Measuring AI Ability to Complete Long Tasks," Mar 2025; updated Time Horizon 1.1, Jan 2026) is the canonical way to quantify "long-horizon."

**Core definition:** The *time horizon* is the human-expert task duration at which an agent succeeds with a given reliability. The **50%-time horizon** = the task length the model completes half the time; the **80%-time horizon** is the more demanding reliability bar.

**Key findings (original, Mar 2025):**
- Task length the best models can do has been growing **exponentially**, doubling roughly **every 7 months** over 2019–2025.
- Frontier models are near-perfect on tasks taking humans **<4 minutes**, but succeed **<10% of the time on tasks taking >4 hours**.
- Claude 3.7 Sonnet had a ~1-hour 50%-horizon at the time.
- Task suites: HCAST, RE-Bench, plus SWE-bench Verified (which showed a faster <3-month doubling).

**Time Horizon 1.1 update (Jan 2026):**
- Task suite expanded **170 → 228 tasks** (+34%); long (8+ hr) tasks went **14 → 31**. Migrated from in-house Vivaria to UK AISI's open **Inspect** framework.
- Doubling time **accelerated recently**: ~196 days (7 mo) over the full history, but **~131 days since 2023** and **~89 days for 2024+ models**.
- Updated 50%-horizons: **Claude Opus 4.5 ≈ 320 min [170–729]**, **GPT-5 ≈ 214 min [117–480]**, **o3 ≈ 121 min [74–201]**. (Wide CIs — flag the uncertainty.)

**Follow-ups worth citing:**
- **"The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs"** (arXiv:2509.09677, ICLR 2026). Central claims directly relevant to OpenTasks: (a) **marginal single-step-accuracy gains compound into exponential gains in executable task length**; (b) long-task failures are **execution failures, not reasoning failures** — when you *give* the model the plan and knowledge, the bottleneck is reliably executing many steps; (c) a **self-conditioning effect** — models get *more* error-prone when their own prior errors are in context, and this **does not go away with model scale**; (d) **"thinking" (sequential test-time compute) mitigates self-conditioning** and extends single-turn executable length.
- **"Half-life for success rates of AI agents"** (arXiv:2505.05115) — models per-step constant failure hazard producing exponential decay of success with horizon.
- **"On Training LLMs for Long-Horizon Tasks"** (arXiv:2605.02572) — empirical study of horizon length as a training variable.

**Takeaway for OpenTasks:** The self-conditioning result (errors-in-context beget more errors) is your strongest theoretical hook. An external task graph that keeps the *clean canonical plan/state* out-of-context and re-injects only the relevant slice could plausibly blunt self-conditioning by reducing the error-laden history the model conditions on.

---

## 3. Failure-Mode Taxonomy at Long Horizons

Synthesized from the empirical sources below. Each mode is tagged with whether **external persistent state (memory / task graph)** plausibly addresses it.

| Failure mode | Mechanism / evidence | Source(s) | External state helps? |
|---|---|---|---|
| **Context rot / lost-in-the-middle** | U-shaped attention: info in the middle of long context is under-attended; 30%+ accuracy drop moving an answer to mid-context. All 18 frontier models tested degrade as input length grows (Chroma). RoPE long-term decay is a root cause. | Liu et al. 2024 (TACL); Chroma "Context Rot" | **Yes** — graph stores authoritative state out-of-window; agent reads only the relevant scoped slice, avoiding mid-context burial. |
| **Error compounding / cascading** | A single root-cause error cascades; each step off the "canonical path" raises P(next step also off) by **22.7 pp**; on >4-hr tasks success <10%. | arXiv:2602.19008 (Canonical Path Deviation); METR; multi-agent error studies | **Partial** — graph can anchor canonical plan + checkpoints to detect/re-anchor drift, but cannot undo an already-bad action. |
| **Self-conditioning on own errors** | Models become more error-prone when prior errors are in context; not fixed by scale. | arXiv:2509.09677 | **Yes** — externalizing state lets you re-inject a clean plan and prune error-laden history. |
| **Context-window / memory limits** | Working+episodic+semantic+procedural memory jammed into one window with nothing to persist/scope; "Memory Limitations" = 27.5% design-level risk bucket. | Long-Horizon Task Mirage (2604.11978); Redis/mem0 surveys | **Yes** — this is the core externalization argument. |
| **Catastrophic forgetting** | Agent ignores early instructions *still present* in context as horizon grows. | Long-Horizon Task Mirage | **Yes** — durable goal/constraint nodes re-surfaced on demand. |
| **Goal drift** | Behavior diverges from system-prompt goal under contextual/adversarial pressure; measured via GD_actions (commission) and GD_inaction (omission). Community converged late-2025/2026 on goal drift as a distinct, measurable mode; also "inherited goal drift" across delegation. | arXiv:2505.02709; arXiv:2603.03258 | **Yes** — a persisted, authoritative goal/task node is the explicit anti-drift anchor. |
| **Planning errors / no explicit plan** | Flawed subplanning/sequencing; "Planning Error" dominates as horizon extends. | Long-Horizon Task Mirage; "Where LLM Agents Fail" (2509.25370) | **Yes** — task graph *is* an explicit, inspectable plan with dependency edges. |
| **Redundant re-exploration** | Without persistent memory of what's been tried, agents re-explore solved sub-paths (implicit in "history error accumulation" + memory-loss findings). | Long-Horizon Task Mirage; memory surveys | **Yes** — completed/visited nodes recorded; agent avoids redoing work, esp. cross-session. |
| **Derailment / transition regions** | Not a single threshold but a **transition region** where success collapses and failures shift from recoverable-local to irreversible-trajectory-level; model differentiation vanishes near the breaking region. | Long-Horizon Task Mirage; "Towards a Science of AI Agent Reliability" | **Partial** — checkpoints + state can catch drift *before* the irreversible region; can't reverse it after. |

**Two anchor empirical taxonomies:**
- **"The Long-Horizon Task Mirage?"** (arXiv:2604.11978): 7-category taxonomy split into **Process-Level risks (72.5% of failures)** — Environment, Instruction, Planning, History Error Accumulation — and **Design-Level risks (27.5%)** — Catastrophic Forgetting, Memory Limitations, False Assumptions. Degradation is **non-linear** (stable, then sharp collapse), **domain-specific** (web collapses earliest; OS/DB sustain longest), and failures **shift toward planning + memory** as horizon extends. Human-judge κ=0.84.
- **"Where LLM Agents Fail and How They Can Learn From Failures"** (arXiv:2509.25370): hierarchical taxonomy over real execution traces — Planning, Memory/state management, Action execution, Environmental understanding, Reasoning. Explicitly implicates state/memory management as a failure category, and argues base-model improvements alone won't close it.

---

## 4. Checkpoint / Partial-Credit Scoring Methodology

This is the directly actionable part for your "measure partial progress at a fixed budget" goal.

**TheAgentCompany's formula:**

```
S_partial = 0.5 · (Result / Total) + 0.5 · S_full
```

- **Result** = sum of points awarded across all checkpoints (including partial credit on individual checkpoints).
- **Total** = sum of all checkpoint points available.
- **`Result/Total`** = fractional progress toward completion (the partial-credit signal).
- **`S_full`** = binary indicator, =1 only when **every** checkpoint passes.
- The **+0.5·S_full** term strongly incentivizes *full* completion — you can't score high on partial progress alone; finishing is rewarded with a 50% bonus.

**How checkpoints work:** Each task ships an **evaluation script** with multiple intermediate-milestone checkpoints, point-weighted by significance. Checkpoint verifiers test categories like **Action Completion**, **Data Accuracy**, and **Collaboration** (did the agent message the right simulated coworker, etc.). Tasks average ~29 steps, so checkpoints carve a long trajectory into gradeable segments.

**Reference numbers (paper):** Claude 3.5 Sonnet — 24.0% full completion, 34.4% partial score, 29.17 avg steps, $6.34 avg cost. 175 tasks across 7 domains (SDE 69, PM 28, HR 29, Admin 15, DS 14, Finance 12, Other 8).

**Related scoring methods to borrow:**
- **τ-bench / τ²-bench**: compares **final DB state vs. annotated goal state** (end-state, not trajectory) and introduces **pass^k** — probability *all k* attempts succeed (= p^k, decays exponentially). This is a *reliability* metric, not a progress metric, but it's the right tool if your OpenTasks claim is about **consistency across sessions/runs**, not just mean success. (A 90% pass@1 agent is only ~57% at pass^8.)
- **Test-based** (SWE-bench): cleanest for verifiable code outcomes but binary — no partial credit.

**Recommendation for OpenTasks eval design:**
1. Adopt **TheAgentCompany-style weighted checkpoints** so you can read *partial progress at a fixed step/token budget* — exactly the regime where a task graph should help an agent get *further* even if neither arm finishes.
2. Report **both** `S_partial` (progress) and **pass^k** (cross-run reliability/continuity) — the latter directly operationalizes the "cross-session continuity" claim.
3. Design at least one **multi-session** task (force a context reset / new session mid-task) so the task-graph arm can demonstrate continuity the bare arm cannot — this is the discriminating test your strongest claim needs, and no current public benchmark cleanly isolates it (MemoryArena and InfiAgent come closest but target memory, not an external task substrate).

---

## Failure Modes a Task-Graph Substrate Could Address

**Strong fit (external persistent state directly attacks the mechanism):**
- **Context rot / lost-in-the-middle** — keep authoritative state out of the window; inject only the scoped, relevant slice.
- **Context-window / memory limits & catastrophic forgetting** — durable goal, constraint, and progress nodes survive window pressure and session boundaries.
- **Self-conditioning on prior errors** — externalized clean state lets you prune error-laden history and re-anchor on the canonical plan (arXiv:2509.09677 is your citation).
- **Goal drift (incl. inherited drift across delegation)** — a persisted, authoritative goal/task node is the explicit anti-drift anchor; measurable via GD_actions/GD_inaction.
- **Redundant re-exploration** — completed/visited nodes prevent re-doing solved sub-paths, especially across sessions.
- **Missing/implicit plans** — the task graph *is* an explicit, inspectable plan with dependency edges (the Mirage paper's top recommended intervention is exactly "memory mechanisms that preserve long-range constraints" + "hierarchical subplanning").
- **Cross-session continuity** — the unique selling point; no public benchmark isolates this, so it's where OpenTasks can show a clean win.

**Partial fit (helps detect/limit, but can't fully fix):**
- **Error compounding / canonical-path deviation** — checkpoints + state can *detect* drift and trigger re-anchoring before the irreversible region, but cannot undo a bad committed action.
- **Derailment / transition-region collapse** — earlier detection only; once past the breaking region, recovery probability decreases monotonically regardless of external state.

**Poor fit (orthogonal to a task store — don't over-claim):**
- **Single-step execution/reasoning errors** within one step (a wrong tool call, a miscalculation) — a task graph doesn't make any individual step more accurate; per the Illusion paper, that's where model scale + thinking help, not external memory.
- **Environment errors / false assumptions about world state** — unless the graph also mirrors environment state, it won't catch the agent misreading the environment.

> **Framing tip:** Position OpenTasks as targeting the **27.5% "Design-Level" risk bucket** (memory limits, catastrophic forgetting) plus **planning + goal-drift** from the Process-Level bucket — and explicitly *not* claiming to fix single-step execution accuracy. This makes the claim falsifiable and credible: the task-graph arm should win most on *long, multi-session, plan-heavy* tasks and tie on *short, single-step-accuracy-bound* ones.

---

## Sources

**Benchmarks**
- TheAgentCompany (arXiv:2412.14161) — https://arxiv.org/abs/2412.14161 · https://arxiv.org/html/2412.14161v1
- SWE-bench leaderboards — https://www.swebench.com/ · Verified: https://www.swebench.com/verified.html · Pro (2026): https://www.morphllm.com/swe-bench-pro · https://labs.scale.com/leaderboard/swe_bench_pro_public · Live: https://swe-bench-live.github.io/
- Terminal-Bench 2.x leaderboard — https://www.tbench.ai/leaderboard/terminal-bench/2.0 · https://benchmarkingagents.com/terminal-bench/ · https://artificialanalysis.ai/evaluations/terminalbench-hard
- GAIA (arXiv:2311.12983) — https://arxiv.org/pdf/2311.12983 · Leaderboard: https://huggingface.co/spaces/gaia-benchmark/leaderboard
- τ-bench (arXiv:2406.12045) — https://arxiv.org/abs/2406.12045 · τ²-bench: https://github.com/sierra-research/tau2-bench · https://artificialanalysis.ai/evaluations/tau2-bench
- WebArena / VisualWebArena (arXiv:2401.13649) — https://arxiv.org/html/2401.13649v2 · https://www.emergentmind.com/topics/webarena-benchmark
- BrowseComp (arXiv:2504.12516) — https://arxiv.org/abs/2504.12516 · https://openai.com/index/browsecomp/
- OSWorld (arXiv:2404.07972) — https://arxiv.org/abs/2404.07972 · Scaling agents: https://arxiv.org/html/2510.02250v1

**Horizon-length metric**
- METR, "Measuring AI Ability to Complete Long Tasks" (Mar 2025) — https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/
- METR, "Time Horizon 1.1" (Jan 2026) — https://metr.org/blog/2026-1-29-time-horizon-1-1/ · https://metr.org/time-horizons/
- "The Illusion of Diminishing Returns: Measuring Long Horizon Execution in LLMs" (arXiv:2509.09677, ICLR 2026) — https://arxiv.org/abs/2509.09677
- "Is there a half-life for the success rates of AI agents?" (arXiv:2505.05115) — https://arxiv.org/pdf/2505.05115
- "On Training LLMs for Long-Horizon Tasks" (arXiv:2605.02572) — https://arxiv.org/html/2605.02572v1

**Failure-mode literature**
- "The Long-Horizon Task Mirage? Diagnosing Where and Why Agentic Systems Break" (arXiv:2604.11978) — https://arxiv.org/html/2604.11978v1
- "Where LLM Agents Fail and How They Can Learn From Failures" (arXiv:2509.25370) — https://arxiv.org/pdf/2509.25370
- "Capable but Unreliable: Canonical Path Deviation..." (arXiv:2602.19008) — https://arxiv.org/pdf/2602.19008
- "Lost in the Middle: How Language Models Use Long Contexts" (Liu et al., TACL 2024) — https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630/
- Chroma, "Context Rot" — https://www.morphllm.com/context-rot · https://www.morphllm.com/lost-in-the-middle-llm
- "Technical Report: Evaluating Goal Drift in Language Model Agents" (arXiv:2505.02709) — https://arxiv.org/pdf/2505.02709
- "Inherited Goal Drift" (arXiv:2603.03258) — https://arxiv.org/pdf/2603.03258
- "Towards a Science of AI Agent Reliability" (arXiv:2602.16666) — https://arxiv.org/pdf/2602.16666

**Memory / external-state (relevant to the OpenTasks claim)**
- "Externalization in LLM Agents: A Unified Review of Memory, Skills, Protocols and Harness Engineering" (arXiv:2604.08224) — https://arxiv.org/html/2604.08224v1
- "Beyond Semantic Organization: Memory as Execution State Management for Long-Horizon Agents" (arXiv:2606.06090) — https://arxiv.org/html/2606.06090v1
- "InfiAgent: An Infinite-Horizon Framework..." (arXiv:2601.03204) — https://arxiv.org/pdf/2601.03204
- mem0 / LoCoMo memory survey — https://mem0.ai/blog/state-of-ai-agent-memory-2026 · Redis long-horizon memory — https://redis.io/blog/long-horizon-ai-agents-memory-state-infrastructure/

---

*Uncertainty flags: SOTA figures are volatile and several (SWE-bench Pro, τ²) are vendor-reported and not independently reproduced. arXiv IDs in the 2602–2606 range are very recent (2026) preprints — verify peer-review status before citing as settled. METR 50%-horizons carry wide confidence intervals. The "cross-session continuity" claim that OpenTasks most wants to test is not cleanly isolated by any existing public benchmark — that is both a gap and an opportunity for your eval program.*