I now have all the primary sources I need. Here is the report.

---

# Multi-Agent / "Swarm" Orchestration for Long-Horizon Software Engineering — with a Kimi Deep Dive

*Research compiled June 2026. Primary sources cited inline; uncertainty flagged explicitly. Read-only research — no files modified.*

---

## 1. Kimi specifically (Moonshot AI)

### 1a. The Kimi K2 model line — single-agent foundation

Kimi K2 is Moonshot AI's flagship open-weight model series, released July 2025 under a modified MIT license. The base/Instruct architecture is a **1T-parameter Mixture-of-Experts (MoE), 32B active parameters per token, 384 experts (8 selected), 128K context** (256K in later variants). The whole line is positioned as "Open Agentic Intelligence" — i.e., the *single model* is trained for tool-use and agentic loops, not just chat.

Reported agentic/coding benchmarks for **K2-Instruct** (single agent, single attempt unless noted):
- **SWE-bench Verified (agentic): 65.8%** single attempt; **71.6%** multiple attempts
- **SWE-bench Multilingual (agentic): 47.3%**
- **SWE-bench Verified (agentless, single patch, no test): 51.8%**
- **Tau2-bench tool use:** Retail 70.6, Airline 56.5, Telecom 65.8 (avg@4); AceBench 76.5%

**Kimi K2 Thinking** (Nov 2025) is the long-horizon-focused upgrade and the single most relevant Kimi artifact for your use case. It is explicitly **a single thinking agent that interleaves chain-of-thought with tool calls — not a swarm.** Key claims:
- Sustains **200–300 consecutive tool invocations** without goal drift, "surpassing prior models that degrade after 30–50 steps." This is the headline long-horizon number.
- End-to-end agentic RL training; INT4 quantization-aware training on MoE for ~2× speed; 256K context.
- Benchmarks: **Humanity's Last Exam (w/ tools) 44.9; BrowseComp 60.2; SWE-bench Verified 71.3; SWE-bench Multilingual 61.1; Terminal-Bench 47.1; AIME25 (w/ Python) 99.1.**

> **Key framing for OpenTasks:** Moonshot's *primary* long-horizon strategy is **a single agent that survives hundreds of serial steps**, not multi-agent coordination. The swarm (below) is a *separate, parallelism-oriented* product feature layered on top. This is an important distinction — their best long-horizon coding numbers come from the single-agent K2 Thinking, not the swarm.

### 1b. "Kimi swarm" — CONFIRMED to exist as a named feature: **Agent Swarm**

Yes, a named "Kimi swarm" exists. It is officially called **"Agent Swarm,"** introduced with **Kimi K2.5** (the K2.5 tech blog calls it out by name) and scaled up in **K2.6**. It is also the engine behind **Kimi Work**, a local desktop agent launched ~June 12, 2026. I can confirm the feature exists and is documented in Moonshot's own K2.5 blog; some of the larger K2.6/Kimi Work figures (300 sub-agents, 4,000 steps) come from secondary coverage (MarkTechPost, VentureBeat, Constellation) and are described there as "reportedly/documented," so treat those specific numbers as **medium-confidence**.

**Coordination mechanism (from Moonshot's K2.5 tech blog — primary source):**
- **Dynamic orchestrator + frozen sub-agents.** A single *trainable orchestrator agent* decomposes a task into parallelizable subtasks, each executed by **dynamically instantiated, "frozen" sub-agents** (e.g., AI Researcher, Physics Researcher, Fact Checker). **No predefined roles** — the orchestrator decides at runtime when to parallelize, how many agents to spawn, which tools, and how to merge.
- **No shared task store or persistent inter-agent memory is described.** Coordination is **orchestrator-mediated**, not shared-state. Sub-agents run concurrently with their own tools (search/browse/code/file), return results, and the orchestrator **aggregates and reconciles** outputs into a final deliverable. This is a classic hub-and-spoke / scatter-gather pattern, *not* a CRDT/blackboard/shared-graph pattern.
- **Scale:** K2.5 — up to **100 sub-agents**, up to **1,500 tool calls**; K2.6/Kimi Work — reportedly up to **300 sub-agents** across **~4,000 coordinated steps**.

**Training — PARL (Parallel Agent Reinforcement Learning):** Moonshot trains *only the orchestrator* (sub-agents frozen) with a composite reward addressing three failure modes that are directly relevant to your substrate design:
1. **"Serial collapse"** — orchestrator degenerates to running one agent (parallel-instantiation reward).
2. **"Spurious parallelism"** — spawning many agents without meaningful decomposition (sub-agent finish-rate reward).
3. Overall solution quality (task-performance reward).
A latency metric, **"Critical Steps"** = Σ(orchestrator step + slowest sub-agent step), explicitly models the straggler/coordination tax.

**Reported swarm benchmark numbers** (K2.5 blog — note these are *breadth/search* benchmarks, not coupled coding):
- **BrowseComp: 78.4%** (Swarm) vs 74.9% (K2.5 single) vs 57.8% (Claude Opus 4.5)
- **WideSearch (item-f1): 79.0%** (Swarm) vs 72.7% (single)
- Up to **80% wall-clock runtime reduction**, **3×–4.5× fewer critical steps** on wide-search.

**Crucial caveat from hands-on testing (DataCamp):** when given a **tightly-coupled, stateful coding problem**, the swarm orchestrator *correctly chose NOT to parallelize heavily*, recognizing that parallelism would add coordination overhead. The swarm's wins are concentrated in **breadth-first research/search**, not coupled code. Practical limits observed: 20–25 min latency, sequential bottlenecks ("some agents wait for others"), under-cited outputs.

> **Bottom line on Kimi swarm:** It exists, it is orchestrator-mediated (not shared-state), it wins on **decomposable breadth-first** tasks, and Moonshot itself routes **coupled coding back toward serial single-agent execution.** No shared task-graph substrate is used or claimed.

---

## 2. Other production multi-agent coding / orchestration systems

| System | Coordination mechanism | Evidence on long-horizon / coupled work |
|---|---|---|
| **Anthropic Multi-Agent Research** | Orchestrator-worker. Lead agent spawns 1–10+ subagents, each with **own context/tools/trajectory; subagents do NOT share state** — they return findings, lead synthesizes + separate citation pass. | **+90.2%** vs single-agent Opus 4 on internal *research* eval. Costs **~15× chat tokens**. Anthropic explicitly says it's for **breadth-first** queries and that **"most coding tasks involve fewer truly parallelizable tasks than research"** and domains needing shared context / many dependencies "are not a good fit." |
| **Claude Code subagents vs Agent Teams** | Two distinct models. **Subagents** = fire-and-forget, can't talk to each other. **Agent Teams** (experimental, shipped Feb 2026 w/ Opus 4.6) = independent CC instances that **share a read/write task list, claim work by updating status, and message each other** — the closest production analog to OpenTasks. | "Sweet spot **2–4 agents**; beyond that coordination + parallel-worktree overhead outpaces gains." The shared task list *is* their coordination substrate (claim → status → complete → poll next). |
| **OpenAI Swarm → Agents SDK** | **Handoffs** (a handoff = a function returning another agent). Lightweight, message/control-transfer based; **no shared global state primitive**. Agents SDK adds sandboxed agents + guardrails. | Swarm is explicitly "educational"; Agents SDK is the production successor. Coordination is intentionally minimal — state lives in the conversation/handoff payload, not a shared store. |
| **CrewAI** | Role-based "crews" with **shared context**, predefined workflow. | Mirrors human team structure; good for structured pipelines, weaker for dynamic/coupled work. |
| **AutoGen** | **Conversation / message-passing** — agents post messages, take turns (writer/critic/executor). | Flexible but turn-taking adds latency; coordination is implicit in the chat transcript. |
| **LangGraph** | **Stateful directed graph** with checkpoints you can **replay/roll back**. State is explicit and shared via the graph. | The most "substrate-like" framework: explicit shared state + resumability. LangChain's own guidance (below) is the nuanced position. |
| **MetaGPT** | Role-based **structured message passing** + a **shared message pool**; SOPs encoded as structured docs/diagrams. | Shared message pool is a blackboard-lite; works for waterfall-style software pipelines. |
| **ChatDev** | Role-specialized message passing simulating a software company. | Demo-grade; coordination via scripted role dialogue. |
| **OpenHands** | **Hierarchical delegation/composition** — generalist CodeActAgent delegates subtasks (e.g., browsing) to specialized agents via built-in coordination primitives. | Strong single-agent SWE-bench; community reports **much lower reliability on ambiguous/long-horizon real-world tasks**. Multi-agent is delegation, not shared-state. |
| **Cognition / Devin** | **Deliberately single-agent.** Planning may use sub-agent-like components but "integrated so it feels like a single system." | See §3 — their thesis is that coupled coding needs *unbroken shared context*, which multi-agent fragments. |

**Pattern across all of them:** for *coding*, the production consensus is either (a) **single agent with long context** (Devin, K2 Thinking) or (b) **orchestrator-worker where workers don't share write-state** (Anthropic, Kimi swarm, OpenAI handoffs). The only systems that expose a genuine **shared, claimable, resumable task substrate** are **Claude Code Agent Teams** (shared task list) and **LangGraph** (checkpointed graph state) — which is exactly the niche OpenTasks targets.

---

## 3. Research evidence: multi-agent on coupled vs decomposable work

The 2025–2026 literature has converged on a clear, quantified conclusion: **multi-agent helps on decomposable/breadth-first/parallelizable work and hurts on tightly-coupled, capability-saturated work.** The disagreement in the field is now about *where the boundary is*, not *whether* it exists.

**MAST — "Why Do Multi-Agent LLM Systems Fail?" (arXiv:2503.13657).** First empirical failure taxonomy: 1,600+ annotated traces across 7 MAS frameworks, **14 failure modes in 3 categories**: **System Design 44.2%**, **Inter-Agent Misalignment 32.3%**, **Task Verification 23.5%**. The headline: MAS gains on popular benchmarks are "often minimal," and most failures are **coordination/specification/verification** failures, not raw model capability. → *A substrate that enforces specification, handoff discipline, and verification gates attacks the largest failure buckets directly.*

**CodeCRDT — "Observation-Driven Coordination" (arXiv:2510.18893).** The most directly relevant paper to OpenTasks. Agents coordinate by **observing a shared CRDT state** (lock-free, conflict-free, strong eventual consistency) rather than message-passing. Contributions: (1) a **formal TODO-claim protocol with provable at-most-one-winner safety** — this is precisely your atomic-claim primitive; (2) empirical proof that **task structure determines coordination payoff**: across 600 trials, **up to +21.1% speedup on some tasks, up to −39.4% slowdown on others, but 100% convergence with zero merge failures.** → *Strong evidence that a well-designed claim/observe substrate eliminates merge conflicts entirely, but does NOT guarantee speedup — speedup depends on decomposability of the task, which the substrate cannot manufacture.*

**"Towards a Science of Scaling Agent Systems" (arXiv:2512.08296).** 260 configurations × 6 benchmarks × 5 architectures × 3 model families. Derives coordination metrics (efficiency, overhead, **error amplification**, **redundancy**) and finds three dominant effects: (1) a **tool-coordination trade-off** — tool-heavy tasks suffer disproportionately from MA overhead under fixed compute; (2) **capability saturation** — coordination yields **diminishing or negative returns once single-agent baselines exceed ~45%**; (3) performance depends on **alignment between coordination structure and task structure** (mismatch degrades). → *The ~45% saturation threshold is a concrete go/no-go signal: if a single agent already clears the bar, adding agents tends to hurt.*

**"The Specification Gap" (arXiv:2603.24284).** 51 class-generation tasks; strips spec detail L0→L3. Two-agent integration accuracy **drops 58% → 25%** as detail is removed, while single-agent **degrades gracefully 89% → 56%**, leaving a persistent **25–39 pp coordination gap** (consistent across Claude Sonnet/Haiku, 3 runs). Critically: **richer specification closes the gap; "conflict reports" add no improvement.** → *Semantic conflicts between agents come from under-specified shared interfaces, not from lack of conflict-detection. The fix is upstream (better contracts/specs in the shared state), not downstream (conflict alerts).*

**LangChain's reconciliation of the Cognition-vs-Anthropic debate.** LangChain argues both camps actually agree:
- Multi-agent **excels** at: parallelizable, breadth-first, **read-heavy** tasks where info exceeds one context window, and where task value justifies the cost.
- Multi-agent **hurts** at: **write-heavy** tasks ("conflicting *write* actions produce far worse outcomes than conflicting *read* actions"), tasks needing shared context / many dependencies, and "most coding" (fewer truly parallelizable subtasks). And "context engineering is crucial" — which makes MA **harder, not easier**, partly vindicating Cognition.

**Synthesis — when MA wins vs loses:**

| Wins (use multi-agent) | Loses (use single agent) |
|---|---|
| Decomposable, breadth-first, **read-heavy** (research, wide search, codebase exploration) | Tightly-coupled, **write-heavy**, shared-interface (implementing one coupled feature/class) |
| Info exceeds a single context window | Single-agent already > ~45% (capability saturation) |
| High task value justifies 4–15× token cost | Latency-sensitive / tool-heavy under fixed compute |
| Subtasks have low write-conflict surface | Under-specified shared interfaces (spec gap) |

**Duplicate-work and semantic-conflict rates** are real and measured: CodeCRDT shows merge conflicts go to **zero** with a proper claim protocol, but the *gross* coordination cost can still be a **−39% slowdown**; the Specification Gap quantifies semantic (not merge) conflict as a **25–39 pp** accuracy loss that no amount of conflict-reporting fixes — only better specs do.

---

## 4. Implications for a shared task-graph substrate (OpenTasks)

**What the evidence says a swarm substrate SHOULD provide:**

1. **Atomic claim / lease primitives — strongly validated.** CodeCRDT's "TODO-claim protocol with provable at-most-one-winner safety" and Claude Code Agent Teams' "claim by updating status" are independent confirmations that the single most valuable substrate primitive is **race-free claiming**. This is OpenTasks's atomic claim/lease — it is the *right* core bet, and the literature shows it eliminates duplicate-work/merge conflicts entirely.
2. **Typed dependency edges as the decomposability signal.** Every "science of scaling" result hinges on **alignment between coordination structure and task structure.** A task graph with explicit dependency edges is exactly the artifact that lets an orchestrator (or the substrate itself) *decide whether to parallelize* — i.e., avoid the "spurious parallelism" / "serial collapse" failures PARL trains against, and avoid parallelizing coupled work where MA loses.
3. **Provenance + handoff records to attack MAST's top failure buckets.** 44% system-design + 32% inter-agent-misalignment failures are coordination/handoff failures. A substrate that records **who claimed what, what they produced, and the handoff contract** gives the verification layer (MAST's 23.5% bucket) something concrete to check.
4. **Resumable / checkpointed state.** LangGraph's replay/rollback and K2 Thinking's 200–300-step horizon both point to **resumability** as the long-horizon enabler. A durable task graph that survives agent restarts is the persistence layer single long-horizon agents lack.
5. **Push events for observation-driven coordination.** CodeCRDT's entire thesis is that **observing shared state beats message-passing** — agents skip completed work, integrate context, avoid conflicts by *watching* rather than *talking*. OpenTasks's push-events + MCP interface is the right shape for this; lean into "observe the graph" over "message other agents."
6. **Carry the specification, not just the task.** The Specification Gap proves semantic conflicts come from under-specified shared interfaces, and that **richer specs close the gap while conflict reports don't.** A task node should be able to carry/link the **interface contract** for coupled work — the substrate's job is to make the shared spec a first-class, claimable artifact, not to bolt on conflict-detection after the fact.

**What the evidence says a swarm substrate should NOT promise:**

- **Do not promise speedup or quality gains on coupled coding.** CodeCRDT (−39% on some tasks), the Specification Gap (−25–39 pp two-agent vs single), the scaling paper (negative returns past ~45% single-agent), Anthropic, LangChain, and Cognition all converge: **a substrate guarantees *safety* (no duplicate work, no merge conflicts, race-free claims) — it cannot manufacture *decomposability*.** If the work is coupled, the right answer is often *one* agent, and the substrate should make that easy (claim the whole epic) rather than force fan-out.
- **Do not promise to fix capability saturation.** When a single agent already clears the bar, the substrate should *get out of the way*, not add coordination tax. Position OpenTasks as **coordination insurance for genuinely parallel work**, not a performance multiplier for everything.
- **Don't conflate "shared task list" with "shared context."** The production systems that work (Anthropic, Kimi swarm) deliberately **isolate sub-agent contexts** and share only structured results. A task graph should share **state and contracts**, not dump every agent's full context on every other agent — that's the trap Cognition warns about.

---

## Key takeaways for OpenTasks

1. **Your core bet — atomic claim/lease + typed dependency edges — is exactly what the strongest 2025–2026 evidence (CodeCRDT, Claude Code Agent Teams) independently converged on.** The race-free claim protocol is the single highest-value primitive, and it provably eliminates duplicate work and merge conflicts.
2. **Frame OpenTasks as a *safety/coordination* substrate, not a *speedup* substrate.** The honest, defensible promise is: zero duplicate work, race-free claiming, resumable long-horizon state, and provenance for verification. Speedup is contingent on task decomposability, which only the *task structure* (your dependency edges) can reveal — the substrate can't create it.
3. **Lean into observation-driven coordination (push events + MCP "observe the graph") over message-passing.** CodeCRDT shows watching shared state beats agents talking to each other.
4. **Make the dependency graph the decomposability oracle.** The recurring failure modes — "serial collapse," "spurious parallelism" (Kimi/PARL), structure-mismatch (scaling paper) — are all *"should we parallelize this?"* decisions. Explicit edges let an orchestrator answer that. Consider exposing a graph-derived "this subtree is coupled — claim it whole" signal.
5. **Carry interface contracts/specs as first-class node content for coupled work.** The Specification Gap proves under-specification (not missing conflict-detection) is the root of semantic conflicts. A task node that links its shared-interface spec attacks the real cause.
6. **Your evaluation should test the boundary, not just the happy path.** Build evals that include *both* decomposable (research/wide-search/multi-file-independent) and tightly-coupled (single coupled class/feature) tasks, and measure duplicate-work rate, merge-conflict rate, semantic-integration accuracy, and wall-clock vs single-agent. Expect and *report* the −39%-style slowdowns on coupled work — that's the credibility move. Use the **~45% single-agent saturation** threshold and the **read-heavy vs write-heavy** axis as your primary slicing dimensions.
7. **On Kimi specifically:** their long-horizon coding strength comes from a **single agent (K2 Thinking, 200–300 serial tool calls)**, while the **Agent Swarm** (orchestrator + frozen sub-agents, no shared task store) wins on **breadth-first search**, and Moonshot itself routes coupled coding back to serial. This is corroborating evidence that a shared task-graph substrate's sweet spot is **parallel/decomposable coordination**, and that for coupled long-horizon coding the field's answer is currently *better single agents*, not more agents. OpenTasks complements both: it's the durable, claimable, resumable coordination layer that neither a lone long-horizon agent nor a shared-state-less orchestrator swarm currently provides.

---

## Sources

**Kimi / Moonshot AI (primary):**
- Kimi K2 — Open Agentic Intelligence (model card / GitHub): https://github.com/moonshotai/kimi-k2
- Kimi K2 project page: https://moonshotai.github.io/Kimi-K2/
- Kimi K2 Thinking (model card, HF): https://huggingface.co/moonshotai/Kimi-K2-Thinking
- Kimi K2 Thinking (announcement): https://moonshotai.github.io/Kimi-K2/thinking.html
- Kimi K2.5 Tech Blog — Visual Agentic Intelligence / Agent Swarm + PARL: https://www.kimi.com/blog/kimi-k2-5

**Kimi swarm / Kimi Work (secondary — medium confidence on K2.6 numbers):**
- DataCamp — Kimi K2.5 Agent Swarm hands-on guide: https://www.datacamp.com/tutorial/kimi-k2-agent-swarm-guide
- MarkTechPost — Kimi Work launch (K2.6, 300 sub-agents): https://www.marktechpost.com/2026/06/12/moonshot-ai-launches-kimi-work-a-local-desktop-agent-reportedly-running-on-kimi-k2-6-with-a-300-sub-agent-agent-swarm/
- VentureBeat — "Kimi K2.6 runs agents for days... limits of enterprise orchestration" (could not fetch, 403; title-level only): https://venturebeat.com/orchestration/kimi-k2-6-runs-agents-for-days-and-exposes-the-limits-of-enterprise-orchestration
- Constellation Research — K2.5 Agent Swarm: https://www.constellationr.com/insights/news/moonshots-kimi-k25-introduces-agent-swarm-highlights-open-source-model-momentum
- Wikipedia — Kimi (chatbot), OK Computer feature context: https://en.wikipedia.org/wiki/Kimi_(chatbot)

**Other production systems:**
- Anthropic — How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Cognition — Don't Build Multi-Agents: https://cognition.ai/blog/dont-build-multi-agents
- Cognition — Multi-Agents: What's Actually Working: https://cognition.ai/blog/multi-agents-working
- LangChain — How and when to build multi-agent systems: https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
- OpenAI Swarm (GitHub): https://github.com/openai/swarm
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- Claude Code Agent Teams + shared task list (MindStudio): https://www.mindstudio.ai/blog/claude-code-agent-teams-shared-task-list
- OpenHands platform paper (ICLR 2025): https://arxiv.org/pdf/2407.16741
- OpenHands Software Agent SDK: https://arxiv.org/html/2511.03690v1
- Framework comparison (CrewAI/LangGraph/AutoGen): https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen

**Research evidence:**
- MAST — Why Do Multi-Agent LLM Systems Fail? (arXiv:2503.13657): https://arxiv.org/abs/2503.13657
- CodeCRDT — Observation-Driven Coordination (arXiv:2510.18893): https://arxiv.org/abs/2510.18893
- Towards a Science of Scaling Agent Systems (arXiv:2512.08296): https://arxiv.org/abs/2512.08296
- The Specification Gap (arXiv:2603.24284): https://arxiv.org/abs/2603.24284

---

**Confidence notes:** Kimi K2/K2.5/K2 Thinking architecture and benchmark figures are from Moonshot primary sources (high confidence). The K2.6 "300 sub-agents / 4,000 steps" and Kimi Work figures are from June 2026 secondary coverage citing Moonshot but not a directly-fetched Moonshot K2.6 page (medium confidence). The VentureBeat "limits of enterprise orchestration" piece returned HTTP 403 and is cited at title level only. The named feature **"Agent Swarm" is confirmed** via the K2.5 tech blog; "OK Computer" is a separate Sept-2025 agentic feature (slides/websites), not the swarm. All four research papers were confirmed by abstract/landing page.