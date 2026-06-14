# P6 — Evaluation & Long-Horizon Improvement Design (2026-06-14)

**Status:** Design draft for review. No harness code yet (design-first, per decision 2026-06-14).
**Extends:** [2026-06-11 evaluation appendix](./2026-06-11-evaluation-appendix.md) (Report 5 = prior literature base) and Phase 6 of [docs/HARDENING-PLAN.md](../HARDENING-PLAN.md).
**Scope shift (Alex, 2026-06-14):** P6 is no longer only *defensively prove the narrow claims*. It is also *find where OpenTasks measurably improves long-horizon-benchmark success, and how it lets us take advantage of multi-agent / swarm execution* (cf. Kimi Agent Swarm). The evals are how we tell the difference between a real lever and wishful positioning.

---

## 0. TL;DR

- The 2026 literature converged on a sharp, useful conclusion: **a shared task substrate buys coordination *safety* (race-free claims, zero duplicate work, resumable state), not a universal performance multiplier.** Multi-agent helps on *decomposable / breadth-first / read-heavy* work and *hurts* on *coupled / write-heavy* work; even Kimi's swarm routes coupled coding back to a single agent.
- Long-horizon failure is dominated by **execution-state management** (context rot, self-conditioning on prior errors, goal drift, memory limits), not raw reasoning — exactly the failure class an external structured graph attacks.
- **The single most valuable study in the field does not exist yet:** *typed dependency graph vs. freeform `NOTES.md` vs. stock long-context, holding total tokens constant.* OpenTasks is uniquely positioned to run it. This is our **headline eval (E2′)** — and we run it on a **standard benchmark (TheAgentCompany)** as a harness ablation, so the numbers compare directly to published results rather than to a bespoke corpus.
- **Benchmarks (decided 2026-06-14):** E2′ on **TheAgentCompany** (long-horizon/state; `S_partial` scoring), E1 on **MultiAgentBench/MARBLE** (coordination; add OpenTasks as a topology). No custom benchmark — OpenTasks is the independent variable, the benchmark is canonical. Continuity tested *indirectly* on the long tasks (no forced-reset protocol).
- We adopt **test-/ground-truth-verified scoring** (never graph state), **cost-matched budgets** (Pareto curve, not a point), and a **3-baseline** design (token-matched single agent / stock or message-passing baseline / `NOTES.md`-or-shared-markdown).
- First build: stand up TheAgentCompany + OpenHands, graft the OpenTasks MCP, run the **E2′ pilot** (~3 tasks × 3 arms × 3 runs) to de-risk plumbing and confirm agents actually *read* the graph — then scale.

---

## 1. Literature delta since the 2026-06-11 appendix

Four parallel research passes (full reports archived under `docs/evals/lit/`). The appendix already covered classic coordination theory, blackboard/stigmergy/CodeCRDT, Contract Net, HTN, MAST, and the protocol landscape. This delta adds the **long-horizon-improvement** and **swarm** angles, plus newer (2026) primary sources.

### 1.1 The multi-agent / swarm landscape — Kimi Agent Swarm and the production consensus

- **Kimi's best long-horizon result is a *single* agent, not a swarm.** Kimi K2 Thinking (Nov 2025) sustains **200–300 consecutive tool calls without goal drift** ("surpassing prior models that degrade after 30–50 steps"); SWE-bench Verified 71.3, Terminal-Bench 47.1. The headline long-horizon lever is *serial-step survival via test-time "thinking,"* not parallelism.
- **"Kimi swarm" = Agent Swarm** (named feature, introduced K2.5, scaled in K2.6; engine behind "Kimi Work"). Architecture: a **trainable orchestrator + frozen, dynamically-instantiated sub-agents**, hub-and-spoke scatter-gather, **no shared task store or persistent inter-agent memory**. Trained with PARL (Parallel Agent RL) against two failure modes — *serial collapse* (degenerating to one agent) and *spurious parallelism* (fan-out without real decomposition). Wins are concentrated in **breadth-first search/research** (BrowseComp 78.4 swarm vs 74.9 single; up to 80% wall-clock reduction), and **Moonshot's own swarm correctly declines to parallelize tightly-coupled coding.**
- **The only production systems exposing OpenTasks' exact niche** (a shared, claimable, resumable task substrate) are **Claude Code Agent Teams** (shared read/write task list; claim-by-status; sweet spot 2–4 agents) and **LangGraph** (checkpointed graph state, replay/rollback). Anthropic's research swarm, OpenAI handoffs, CrewAI, AutoGen, MetaGPT all coordinate via orchestrator/message-passing with **isolated** sub-agent context, not shared write-state.
- **Anthropic's own guidance**: multi-agent beat single-agent Opus by **+90.2%** on breadth-first *research* — but at **~15× tokens**, and *token usage alone explains ~80% of the performance variance*. They state "most coding tasks involve fewer truly parallelizable tasks than research" and that shared-context / many-dependency domains "are not a good fit."

> **Implication:** "Take advantage of multi-agent" via OpenTasks ≠ "spawn more agents." It means: give the swarm the substrate to (a) *decide* parallelize-vs-serialize from dependency structure, (b) claim work race-free, (c) carry the interface contract across handoffs, (d) resume from durable state. The win is **safety + the right structural decision**, and it is the niche the in-model swarms (Kimi) leave open.

### 1.2 Long-horizon benchmarks & failure modes

- **Horizon as a metric (METR Time Horizon 1.1, Jan 2026):** task-length the best models complete 50% of the time is doubling every **~89–131 days** for recent models; Opus 4.5 ≈ 320 min 50%-horizon. Frontier models are near-perfect under ~4 min and <10% past ~4 hr — the long tail is where substrates could matter.
- **Failure is execution, not reasoning.** "The Illusion of Diminishing Returns" (arXiv:2509.09677): long-task failures are *execution* failures; a **self-conditioning effect** makes models *more* error-prone when their own prior errors are in context, and **it does not vanish with scale**. → An external graph that keeps the *clean canonical plan* out-of-context and re-injects only the relevant slice is a direct counter.
- **"Long-Horizon Task Mirage" (arXiv:2604.11978):** Process-level risks 72.5% (environment, instruction, planning, history-error accumulation) + **Design-level 27.5% (catastrophic forgetting, memory limits, false assumptions)**. Degradation is non-linear; web collapses earliest, OS/DB sustain longest.
- **No public benchmark cleanly isolates cross-session continuity.** TheAgentCompany (checkpoint scoring), SWE-bench (test-based), τ²-bench (`pass^k` reliability) are the relevant scaffolds, but the multi-session reset regime is a gap → an opportunity to own.

### 1.3 Techniques that improve long-horizon success (external structured state)

- **Memory architecture dominates model scale.** AMA-Bench (arXiv:2602.22769): on *agentic* trajectories, naive memory often *underperforms* long-context, **but** a causal-graph + structured-retrieval design beats the best baseline by **+11 pts** and stays robust to 128k where long-context degrades past 32k. **Memory architecture induced 0.45 accuracy variance vs only 0.038 from scaling the model 8B→32B**, and **graph structure beat lossy compression** (compaction loses causal dependencies). This is the strongest empirical support for the typed-graph thesis.
- **Resume-from-external-state is the clearest practical win.** Anthropic's long-running-agent harness: initializer + incremental coding agent leaving **a structured JSON feature list** (JSON deliberately, because "the model is less likely to overwrite JSON than Markdown"), a progress file, and git checkpoints; each session reads logs→progress→features→tests before new work — explicitly to stop agents "guessing at what had happened" and burning tokens. LangGraph durable execution journals non-deterministic calls so they're *never re-run on replay* (5–20% overhead).
- **Plan/objective persistence** across the context-truncation boundary is load-bearing (Anthropic persists the lead plan to memory; Manus "recites" `todo.md` into recent attention to fight lost-in-the-middle).
- **Verification gating helps — only if the verifier is hard to game** (see 1.4).

### 1.4 Evaluation methodology (the rules we must follow)

- **Cost must be matched.** "AI Agents That Matter" (arXiv:2407.01502): accuracy-only leaderboards reward *spending more compute*; report the **accuracy–cost Pareto frontier**. Tran & Kiela (arXiv:2604.02460): under equal **thinking-token budget**, single-agent is information-theoretically ≥ multi-agent (Data Processing Inequality) — apparent swarm wins are largely the "swarm tax." **Match total tokens at the aggregate (swarm-sum) level**, not per-agent.
- **Never score by graph state.** "Establishing Best Practices for Rigorous Agentic Benchmarks" (arXiv:2507.02825): bad outcome-validity distorts results up to **100% relative** (SWE-bench insufficient tests; τ-bench counted empty responses as success). An agent that can write `status: closed` is in the reward-hacking threat model — score on independent ground truth only.
- **Coordination metrics** (arXiv:2512.08296), computed from traces (subscripts: `MAS`=multi-agent, `SAS`=single-agent baseline):

  | Metric | Formula | Meaning |
  |---|---|---|
  | Coordination Overhead `O` | `(T_MAS − T_SAS) / T_SAS` | excess turns/tokens the swarm spends |
  | Message Density `c` | inter-agent msgs ÷ reasoning turns | chatter (success plateaus log-ly in `c`) |
  | Redundancy `R` | mean pairwise cosine sim of agent outputs | duplicated (not diverse) work — **our primary duplication signal** |
  | Coordination Efficiency `E_c` | `S / (T_MAS / T_SAS)` | success normalized by relative cost |
  | Error Amplification `A_e` | `E_MAS / E_SAS` | >1 ⇒ coordination amplifies errors |

  Anchors (domain-contingent): independent agents amplified errors **17.2×** vs **4.4×** for centralized-with-validation; **coordination yields negative returns once single-agent > ~45%** (capability saturation, β=−0.408, p<0.001).

---

## 2. Strategic thesis — where OpenTasks actually moves the needle

Stated as falsifiable bets, each mapped to an eval.

1. **Resumable structured state beats freeform notes and bare long-context on long, multi-session, dependency-dense tasks — at matched token budget.** This is the AMA-Bench + Anthropic-harness + self-conditioning argument. **The exact RCT does not exist.** → **E2′ (headline).**
2. **A claim/lease substrate makes a swarm *safe* (zero duplicate work, zero merge conflicts) and lets it make the parallelize-vs-serialize decision from dependency edges — but it does not manufacture speedup on coupled work.** CodeCRDT proves safety with provable at-most-one-winner claiming, and that task structure (not the substrate) sets the −39%…+21% wall-clock swing. → **E1.**
3. **Semantic conflicts come from under-specified shared interfaces, and richer specs close the gap while conflict reports don't** (arXiv:2603.24284). So the substrate's job is to make the **spec/contract a first-class, claimable artifact**, not to bolt on conflict alerts. → tested as an E1 condition + E5.
4. **Every completion signal that an agent can self-assert is a verification gap.** → **E5.**

**What we will NOT claim** (the literature contradicts it, so the README must not say it): that a task layer makes agent collectives "smarter" on coupled work; that more agents help once a single agent already clears the bar (~45% saturation); that shared task state means shared *context* (the Cognition trap).

---

## 3. The eval program (revised)

Cross-cutting principles (non-negotiable, from §1.4):
- **Score on ground-truth tests / external state, never on graph status.**
- **Match total token budget across conditions; report an accuracy–cost Pareto curve, not a point.**
- **≥3 baselines where coordination is claimed:** token-matched single agent · uncoordinated swarm · shared-markdown/orchestrator-held.
- **High n, paired-by-task, report CIs** (agent runs are high-variance; single runs are not evidence).
- **Archive machine-parseable JSONL traces** (per-agent/per-turn tokens, every tool call, inter-agent messages, per-checkpoint ground-truth evidence, full config/seed/model-version).

| Eval | Benchmark | Question | Baselines (arms) | Primary metrics |
|---|---|---|---|---|
| **E2′** (headline) | **TheAgentCompany** | Does OpenTasks-as-external-state beat `NOTES.md` and the stock scaffold on long tasks at equal tokens? | NOTES.md · stock OpenHands | `S_partial`, redundant-exploration tokens, time-to-first-productive-action, `pass^k` |
| **E1** | **MARBLE** | Does an OpenTasks coordination protocol match/beat MARBLE's topologies and cut duplication/conflict at equal tokens? | MARBLE graph/star/chain topologies · token-matched single agent | milestone KPI, duplicate-claim rate, **semantic-conflict rate**, `R`, `A_e`, `E_c` |
| **E4** | (control for E1) | Is the swarm's win real or just more compute? | token-matched single agent | completion & cost vs E1 treatment at matched budget |
| **E5** | (audit over E1/E2′ traces) | How many completion signals are self-assertable? | — | count/severity of agent-assertable completion paths (MAST "task verification" lens) |
| **E3** (optional) | TheAgentCompany | Is a graph-only handoff better than a transcript handoff? | transcript-summary handoff | MAST failure-mode rate (validated LLM-judge, report κ) |

### Metric definitions specific to OpenTasks
- **Redundant-exploration tokens:** tokens spent re-reading/re-deriving files or facts already established pre-reset (detected from tool-call traces: repeat reads of the same path, repeat searches). The core E2′ number.
- **Time-to-first-productive-action:** wall-steps from session restart to the first action that advances a ground-truth checkpoint (not orientation/reading).
- **Semantic-conflict rate (E1):** fraction of agent actions writing incompatible changes to the same task/resource — computed **directly from the edge layer** (OpenTasks' structural advantage; not in the published vocabulary).
- **`S_partial = 0.5·(Result/Total) + 0.5·S_full`** (TheAgentCompany): weighted-checkpoint partial credit with a completion bonus.
- **`pass^k = p^k`** (τ²-bench): probability *all k* runs of a task succeed — operationalizes "cross-session reliability."

---

## 4. E2′ — Long-horizon state / the missing RCT, on TheAgentCompany (headline, detailed)

**Benchmark (decided 2026-06-14): TheAgentCompany** (arXiv:2412.14161) — 175 consequential digital-work tasks in a self-hosted simulated company (GitLab, Plane, RocketChat, ownCloud), ~29 steps/task, **checkpoint partial-credit `S_partial`**. We run its tasks and score on its native scale → directly comparable to published numbers. **OpenTasks is a harness ablation, not a benchmark change.**

**Hypothesis.** On TheAgentCompany's long, multi-step tasks, **at equal total token budget**, an agent whose scaffold has **OpenTasks as external structured state (via MCP)** reaches a higher `S_partial` and spends **≥30% fewer redundant-exploration tokens** than the same agent with (a) a freeform `NOTES.md`/`todo.md`, or (b) the stock scaffold (native context only / compaction).

**Three arms — same tasks, same model, same OpenHands harness; only the state mechanism varies (this is the "typed graph vs notes vs long-context" RCT the field is missing, instantiated on a standard benchmark):**
1. **Graph** — stock OpenHands **+ OpenTasks MCP** (cc-swarm's MCP server). Agent records/queries tasks, deps, and context nodes.
2. **Notes** — stock OpenHands + an instructed `NOTES.md`/`todo.md` discipline (the honest baseline — beating a good markdown file is the bar, not beating "nothing").
3. **Stock** — unmodified OpenHands (its native context handling / compaction), no external task store.

**Continuity is tested *indirectly* (decided: no forced-reset protocol).** TheAgentCompany's ~29-step tasks naturally exceed the working window, so external-state vs notes vs compaction is exercised by the benchmark's own length — keeping the task **and** the `S_partial` score fully canonical. (A labeled forced-reset variant is explicitly out of scope for now; revisit only if the indirect signal can't discriminate.)

**Cost control.** Hold **total tokens** (prompt+completion+reasoning, summed over the run) constant across arms; report an accuracy(`S_partial`)–cost Pareto curve, not a single point. Count OpenTasks MCP traffic as cost in the Graph arm (it must pay its way).

**Instrumentation layered on top (does not change scoring).** Per-run JSONL: per-turn token accounting, every tool call (to compute **redundant-exploration tokens** = repeat reads/searches of already-seen paths/facts), and **whether the agent actually reads the graph** (did it call `query`/`get_context`?). The null-result branch hinges on this: if agents ignore the graph, fix context-surfacing (`context_summary` quality, the system-prompt nudge) before concluding null.

**Scoring.** TheAgentCompany `S_partial` (standard) + `pass^k` across runs for cross-run reliability. Redundant-exploration tokens and time-to-first-productive-action are our diagnostic metrics. **Never** score by graph state.

**Decision rule.** Higher `S_partial` at matched budget **and** ≥30% redundant-token reduction → headline claim, publish on TheAgentCompany's scale. Null → fix graph-surfacing, rerun once. Still null → persistence value prop weaker than believed; pivot to the pure edge-layer/routing value.

**Task subset + run matrix.** Pick a representative subset (e.g., the SWE/PM/Admin-heavy tasks where multi-step dependency tracking is densest) rather than all 175 to bound cost. **Pilot first:** ~3 tasks × 3 arms × 3 runs to validate the OpenHands+OpenTasks harness, the token-match, and the graph-read instrumentation; then scale to ~15–25 tasks × 3 arms × ≥5 runs.

---

## 5. Multi-agent / swarm — the coordination claim, on MARBLE (E1)

**Benchmark (decided 2026-06-14): MultiAgentBench / MARBLE** (arXiv:2503.01935, ACL 2025; `ulab-uiuc/MARBLE`) — a modular multi-agent framework with a **Coordination Engine** + **Agent Graph Module** that already **ablates coordination topologies** (star / chain / tree / graph) and reports milestone-based KPIs. Their headline finding: the **graph topology wins** for research tasks. This is the ideal home for the OpenTasks coordination claim because it is *built to compare topologies* — we add OpenTasks as **one more coordination protocol** and compare on the same tasks + same KPIs. Open-source, so we extend rather than fork.

Given §1.1, the swarm eval's honest target is **safety and the structural decision**, not raw speedup:

- **Treatment:** a new MARBLE coordination protocol — agents coordinate **through the OpenTasks task graph** (atomic `claimNext`, dependency edges, push events → *observe the graph* rather than message-pass; CodeCRDT's stigmergic pattern), driven via swarm-dispatch's `claimNext` TaskSource.
- **Comparators (MARBLE's own + our controls):** MARBLE's built-in **graph topology** (the published winner — the bar to beat or match), **star/chain** message-passing topologies, plus a **token-matched single agent** (E4) to test whether any swarm win is real or just more compute.
- **Primary results we expect and will report honestly:** duplicate-claim rate → ~0 (structural, post-P1); **semantic-conflict rate** the interesting residual (expect 5–10% per CodeCRDT) and whether a **spec-carrying task node** (condition: task links its interface contract) reduces it where conflict-reports wouldn't; redundancy `R` lower at equal budget; milestone KPI *parity-or-better* vs MARBLE's graph topology; per model (benefit shrinks above ~45% single-agent saturation).
- **Substrate affordances this motivates (candidate roadmap, gated on E1 signal):** (a) a decomposability hint surfaced from dependency edges so an orchestrator parallelizes only when the graph is wide; (b) first-class spec/contract attachment on task nodes; (c) `excludeClaimed` lease-aware ready (already shipped) as the dispatcher primitive.

---

## 5b. Ecosystem setup — how OpenTasks plugs into each harness (the "use it properly" part)

The agent scaffold is the integration surface; P5 already built the pieces. Across all arms we hold **model + harness fixed** and vary only the OpenTasks involvement.

**TheAgentCompany (E2′):**
- Runner (decided 2026-06-14): **reuse the skill-tree eval harness pattern** (`~/GitHub/skill-tree/test/eval/disclosure`) — a **headless Claude-CLI runner on Bedrock**, model-swappable via `EVAL_MODEL`, region-multiplexed for rate limits, k-repeats + batched, already MCP-capable. This is our proven infra and *is* the (task × arm) shape. **OpenHands is NOT required** — it's only TheAgentCompany's reference agent + a browser, and GLM-5 has no published TAC number to match anyway.
- The three arms are the same runner + same model; only the state mechanism differs: *Graph* = runner + **OpenTasks MCP** (cc-swarm's `run-opentasks-mcp` → daemon over Unix socket); *Notes* = runner + a `NOTES.md` instruction; *Stock* = runner alone.
- Setup per task: boot the OpenTasks daemon in the task container (auto-start, P4), register the MCP, add a short system-prompt nudge to record/consult tasks. Tasks, Docker services, and `S_partial` scoring are TheAgentCompany-stock.
- **Risk to verify in the pilot:** can the headless coding agent complete the **SDE subset's** interaction surface (GitLab via API/MCP vs strictly web UI)? If specific tasks need a browser, add a browser tool/MCP or run those few via OpenHands as a fallback. (Comparability is preserved either way — same canonical tasks + `S_partial`; the scaffold is a documented choice, and an OpenHands *reference run* can be added later for leaderboard-methodology parity.)

**MARBLE (E1):**
- Add an `opentasks` coordination protocol alongside MARBLE's star/chain/tree/graph in its Coordination Engine. Agents claim/observe via the OpenTasks graph; **swarm-dispatch** provides the `claimNext`/lease dispatch (its adapter is already real-daemon tested, P5).
- The OpenTasks edge layer *is* the coordination trace → compute `R`, conflict rate, `A_e` directly from the graph instead of reconstructing from logs.
- Risk to verify: mapping MARBLE's task/milestone model onto OpenTasks nodes+edges; ensuring the comparison to MARBLE's built-in graph topology is apples-to-apples (same tasks, same KPI scorer).

**Shared:** one JSONL trace schema (per-turn tokens, every tool call, inter-agent messages, per-checkpoint ground-truth evidence, config/seed/model-version) so all §3 metrics are script-derivable and runs are reproducible.

---

## 6. Decisions

**Settled (2026-06-14):**
- **Standard benchmarks, no custom corpus** — clear comparison to published numbers; OpenTasks is a *harness ablation*, not a benchmark.
- **E2′ (long-horizon/state) → TheAgentCompany**; **E1 (coordination) → MultiAgentBench/MARBLE.**
- **Cross-session continuity tested *indirectly*** on TheAgentCompany's long tasks (no forced-reset protocol; revisit only if the indirect signal can't discriminate).
- **Headline = E2′** (the typed-graph vs notes vs stock RCT, on a standard benchmark) as the publishable contribution.
- **Runner = the skill-tree headless Claude-CLI/Bedrock harness pattern** (model-swappable, MCP-capable), not OpenHands. See §5b.
- **Models = run on Bedrock, non-Claude-first:** primary **GLM-5 via bedrock-mantle** (the proven skill-tree setup); add a **contrast model** (e.g. Bedrock Sonnet 4.6, the skill-tree default) to draw the capability-saturation curve — cheap given `EVAL_MODEL` is swappable.
- **Budget = not conservative** (large Bedrock credit pool). Still run a small **plumbing pilot first** (correctness, not cost), then the full matrix.
- **Task subset = SWE-heavy** (TheAgentCompany SDE tasks, ~69 of 175) — densest dependency tracking, best fit for the OpenTasks lever, and the subset most runnable by a headless coding agent.

**Still open:**
1. **Exact `bedrock-mantle` invocation for GLM-5** — confirm whether the Claude CLI reaches GLM-5 via an Anthropic-compatible proxy (`ANTHROPIC_BASE_URL`/model id) so the runner config can be copied from skill-tree verbatim.
2. **MARBLE/E1 model** — same GLM-5/Bedrock, or run E1 later once E2′ validates the pipeline.

## 7. Risks & kill criteria

- **Null E2′ after the graph-read fix** → persistence prop weaker than believed; pivot to edge-layer/routing value (cross-system queries, "route my 15 minutes").
- **E1 shows semantic conflict dominates** → bottleneck is integration, not coordination; prioritize spec-carrying nodes + git-cascade integration + verification hooks over more task-layer features.
- **Capability saturation** → if single-agent already clears the bar, report it; position OpenTasks as *coordination insurance for genuinely parallel work*, not a multiplier.
- **Verifier gaming** → E5 must confirm gate edges can't be self-attested; a weak verifier is worse than none.

## 8. Recommended next steps

1. **Stand up TheAgentCompany's SDE-subset locally** (its Docker services + checkpoint evaluators) and confirm a single SDE task scores end-to-end on `S_partial` with the headless Claude-CLI/Bedrock runner (copy the skill-tree runner config; confirm the `bedrock-mantle`/GLM-5 invocation).
2. **Define the 3 arms in the runner** (stock / +NOTES.md / +OpenTasks MCP): register cc-swarm's OpenTasks MCP + in-container daemon auto-start for the Graph arm; add the JSONL trace schema (§3), token accounting, and graph-read instrumentation.
3. **Run the E2′ pilot** (~3 SDE tasks × 3 arms × 3 runs, token-matched) → confirm: the agent can actually drive the SDE tasks (API vs browser surface), MCP wiring holds, budget-match is honest, agents read the graph, the redundant-token metric discriminates.
4. Read pilot → scale E2′ across the SDE subset (× ≥5 runs, GLM-5 + a contrast model) and publish on TheAgentCompany's scale.
5. **Then E1 on MARBLE:** add the `opentasks` coordination protocol (swarm-dispatch `claimNext`), compare to MARBLE's graph/star/chain topologies + the token-matched single agent (E4). E5 verification-gap audit runs as a cheap static+trace pass alongside.

---

## Sources (delta; full per-stream reports under `docs/evals/lit/`)

**Swarm / multi-agent:** Kimi K2.5 Agent Swarm tech blog; K2 Thinking model card; Anthropic multi-agent research system (anthropic.com/engineering/built-multi-agent-research-system); Claude Code Agent Teams docs; CodeCRDT (arXiv:2510.18893); MAST (arXiv:2503.13657); Science of Scaling (arXiv:2512.08296); Specification Gap (arXiv:2603.24284).
**Long-horizon benchmarks/failure:** TheAgentCompany (arXiv:2412.14161); METR Time Horizon 1.1 (metr.org, Jan 2026); Illusion of Diminishing Returns (arXiv:2509.09677); Long-Horizon Task Mirage (arXiv:2604.11978); Where LLM Agents Fail (arXiv:2509.25370); τ²-bench; SWE-bench Verified/Pro.
**Techniques:** AMA-Bench (arXiv:2602.22769); Mem0 (arXiv:2504.19413); Anthropic effective-harnesses-for-long-running-agents; LangGraph durable execution; Reflexion (arXiv:2303.11366).
**Methodology:** AI Agents That Matter (arXiv:2407.01502); Rigorous Agentic Benchmarks/ABC (arXiv:2507.02825); Tran & Kiela equal-thinking-token (arXiv:2604.02460); Reward-Hacking Benchmark (arXiv:2605.02964); Science of Scaling metrics (arXiv:2512.08296).

*Uncertainty: many 2026 arXiv IDs are recent preprints (verify peer-review status before citing as settled); several SOTA figures are vendor-reported; a few methodology details were drawn from abstracts/secondary summaries and are flagged in the per-stream reports for verification against full PDFs.*
