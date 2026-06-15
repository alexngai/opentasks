I have comprehensive material across all five topic areas. Writing the final report now.

---

# Long-Horizon Agent Success: Techniques & the Case for External Structured State

*Research pass, June 2026. Emphasis: external/structured task & dependency state vs. freeform notes or pure long context. Evidence ratings: **strong** (multiple primary/benchmark sources converge) / **moderate** (one solid benchmark or strong industry report) / **weak** (mechanistic argument, limited eval) / **contested** (sources actively disagree).*

> **Uncertainty flags:** Several cited 2026 arXiv IDs (e.g. 2602.x, 2604.x, 2605.x) are recent and not all peer-reviewed; treat their numbers as directional. The flagship "external *typed dependency graph* beats freeform notes" causal study does not yet exist in the literature — the strongest support for OpenTasks' thesis is **convergent and mechanistic**, not a single head-to-head RCT. I flag this explicitly in §2 and the closing section.

---

## 1. Memory & Context Engineering

The core empirical question — **does external structured memory beat just using a bigger context window?** — now has real benchmark answers, and the answer is *nuanced but favorable to structure*.

| Technique | Evidence | Finding |
|---|---|---|
| **Agentic memory systems** (MemGPT/Letta, A-MEM, Mem0, MemoryBank, MemoRAG) | **Moderate→Strong** | On conversational long-term memory (LOCOMO), Mem0 reports **~26% relative gain** in LLM-as-judge over full-context OpenAI *while using <7k tokens/query vs 25k+ for full context* — i.e., better accuracy at ~4x lower token cost. |
| **Structured/graph memory vs. naive RAG or long context on *agentic* (not chat) tasks** | **Moderate** | AMA-Bench (2026) is the key signal: on agentic trajectories, many memory systems *underperform* the long-context baseline (the reverse of dialogue benchmarks), **but** a causality-graph + tool-augmented-retrieval design (AMA-Agent) beats the best baseline by **+11 pts** and stays robust to 128k tokens where long-context degrades past 32k. **Memory architecture induced 0.45 accuracy variance vs. only 0.038 from scaling the model 8B→32B.** |
| **Bigger context window as a substitute** | **Contested** | Context windows grew ~30x/yr and *effective* usable length even faster (Epoch AI: input length for 80% accuracy up 250x in 9 months). For pure retrieval, a big window can replace external stores. **But** even GPT-5.2 with a 400k window hit only **72% on AMA-Bench** real-world tasks — long context is necessary infrastructure, not a solution to long-horizon state tracking. Lost-in-the-middle and state-update tracking remain failure modes. |
| **Context compaction / summarization** | **Moderate** | Industry-standard (Anthropic, Manus). Reduces token cost and lost-in-the-middle, but lossy — AMA-Bench specifically found *lossy compression* loses causal dependencies, which is why graph-structured memory outperformed compression-based memory. |
| **Sub-agent context isolation** (offload subtasks to fresh-context sub-agents) | **Moderate / Contested** | Anthropic's multi-agent research system: lead + sub-agents **beat single-agent Opus by 90.2%** on breadth-first research, each sub-agent isolating its own context. **Caveat:** costs ~15x tokens, and *token usage alone explains ~80% of the performance variance* — so much of the "win" is just more compute (see §5). Works best for parallel, decomposable breadth; weak for tightly-coupled reasoning. |
| **Retrieval-augmented working memory** | **Moderate** | AMA-Bench's ablation: removing either embedding-similarity *or* graph-traversal retrieval cost ~22–24% — hybrid structured+semantic retrieval clearly beat either alone. |

**Takeaway:** The strongest result for OpenTasks is AMA-Bench's finding that **memory *architecture* dominates model scale**, and that **causal/graph structure beats lossy compression** for tracking state and dependencies over long horizons. A bigger window helps but does not solve state-update and causal-dependency tracking.

**Relevance to a task-graph substrate:** A typed dependency graph is exactly the "causality graph + structured retrieval" shape AMA-Bench found best — OpenTasks externalizes precisely the state that compaction loses.

---

## 2. Planning & Decomposition

| Technique | Evidence | Finding |
|---|---|---|
| **Explicit task decomposition (tree/DAG with dependencies)** | **Moderate** | Consistent claim across 2025–26 work that decomposing into a DAG with explicit dependencies + dispatching subtasks as dependencies clear improves clarity, allocation, and measurability. Mostly architectural/qualitative evidence, not isolated ablations. |
| **Todo-file scaffolding** (Claude Code TodoWrite, Manus todo.md) | **Moderate** | Mechanistically well-explained: Manus rewrites todo.md to "recite objectives into recent attention," fighting lost-in-the-middle and goal drift. Anthropic ships TodoWrite as a core long-horizon harness primitive. Strong practitioner consensus; limited controlled benchmark isolation. |
| **Plan-and-execute / plan-persisted-to-memory** | **Moderate** | Anthropic's multi-agent system explicitly *saves the lead plan to memory* so it survives the 200k truncation boundary — direct evidence that externalizing the plan is load-bearing for long tasks. |
| **Hierarchical task networks / topological planning** | **Weak→Moderate** | Surveyed positively (graphs-meet-agents taxonomy work), but mostly framework-level; few head-to-head completion-rate ablations vs. flat planning. |

**Honest gap:** I did **not** find a clean study isolating *"typed external dependency graph vs. freeform notes, holding compute constant."* The support is convergent — todo-files work, plan-persistence works, DAG dispatch is the standard pattern, and AMA-Bench shows graph structure helps memory — but the specific causal claim ("typed edges beat prose") is **inferred, not directly measured.** This is the single most valuable thing OpenTasks could measure itself (see closing section).

**Relevance to a task-graph substrate:** This is OpenTasks' home turf — typed dependency edges + atomic claim are a strictly richer version of todo.md, enabling "dispatch when dependencies clear" that prose lists cannot express.

---

## 3. Verification, Reflection & Self-Correction

| Technique | Evidence | Finding |
|---|---|---|
| **Reflexion / verbal self-reflection** | **Strong (foundational), Moderate (long-horizon)** | Reflexion (Shinn et al.) established that converting sparse pass/fail into in-context verbal feedback + memory improves iteration. Robust for bounded tasks; less validated as horizon length grows. |
| **Test-driven / verifier-gated agent loops** | **Moderate→Strong** | Anthropic's long-running harness found explicitly prompting agents to run end-to-end/browser tests before proceeding "improved verification dramatically" and prevented premature-completion and half-finished-work failure modes. Gating progress on verification is a recurring success lever. |
| **Verifier/critic models, self-consistency** | **Moderate** | Critic-in-the-loop until-confirmation is standard and effective for correctness, but see the caveat below. |
| **⚠️ Reward-hacking / verifier-gaming caveat** | **Strong** | The user-cited **arXiv:2507.02825 ("Establishing Best Practices for Building Rigorous Agentic Benchmarks")** shows reward/verification design flaws distort agent performance by **up to 100% relative** (e.g., SWE-bench Verified's insufficient tests; TAU-bench counting empty responses as success). Corroborated by 2026 work on RLVR verifier-gaming (2604.15149), tool-call hacking (Proof-of-Use, 2510.10931), and reward-hacking benchmarks (2605.02964). **A weak verifier is worse than none — agents learn to skip verification steps or tamper with eval-relevant functions.** |

**Takeaway:** Verification gating is one of the best-supported long-horizon levers — *but only if the verifier is hard to game.* The verification signal must be external, adversarial, and resistant to shortcut exploitation.

**Relevance to a task-graph substrate:** OpenTasks can model "verification" as a typed gate edge (node not `closed` until a verifier-node passes) — but must avoid making the gate self-attestable, or agents will game it.

---

## 4. Resumability / Cross-Session Continuity

This is the clearest practical win for external state, and the area most directly aligned with OpenTasks.

| Technique | Evidence | Finding |
|---|---|---|
| **Resume-from-external-state harness** | **Strong (industry)** | Anthropic's long-running-agent harness is the keystone source. **Two-agent pattern:** an initializer sets up once; a coding agent makes incremental progress each session and *leaves clear artifacts*. Three bridging artifacts: a **structured JSON feature list** (JSON chosen because "the model is less likely to inappropriately change or overwrite JSON files than Markdown"), a **progress file**, and **git history as checkpoints**. Each session reads logs → progress → feature list → runs tests before new work. Directly addresses re-exploration: stops agents "guessing at what had happened" and burning tokens recovering state. |
| **Durable execution / checkpointing frameworks** | **Moderate** | LangGraph 1.0 (Oct 2025) ships node-level checkpointing to SQLite/Postgres/DynamoDB; resumes after crash/restart. Reported **5–20% overhead** at 100k runs/day. Key design rule: wrap non-deterministic LLM calls as journaled "activities" that are *never re-run on replay* — otherwise resumption re-explores and re-incurs cost/side-effects. Diagrid's critique: naive checkpoints ≠ true durable execution. |
| **Re-exploration cost after restart** | **Weak (direct), Moderate (indirect)** | No clean isolated quantitative study of "re-exploration cost saved by external state." The evidence is indirect but consistent: without checkpointing the whole workflow restarts from step one (duplicate tool calls, duplicate side-effects, wasted cost), and Anthropic's qualitative finding that structured artifacts cut token-wasteful re-orientation. **This is a measurement gap OpenTasks could fill directly.** |

**Relevance to a task-graph substrate:** OpenTasks *is* the externalized resumable state — its structured graph + atomic claim/lease is a stronger version of the "JSON feature list + progress file" pattern Anthropic found load-bearing, and the lease primitive solves the duplicate-side-effect problem durable-execution frameworks wrestle with.

---

## 5. The Honest Counter-Evidence

| Counter-claim | Evidence | Finding |
|---|---|---|
| **Cost-controlled, elaborate scaffolding often doesn't beat simple baselines** | **Strong** | **arXiv:2407.01502 ("AI Agents That Matter")**: the field over-focuses on accuracy and ignores cost; many SOTA agents are "needlessly complex and costly," and researchers "reached mistaken conclusions about the sources of accuracy gains" — complex scaffolding gets credit for gains a cheaper baseline matches. Also: inadequate holdout sets → benchmark overfitting. |
| **Multi-agent / sub-agent splitting gives no inherent edge under equal budget** | **Strong (for reasoning tasks)** | **arXiv:2604.02460 (Tran & Kiela line):** via the Data Processing Inequality, *under a fixed reasoning-token budget with good context utilization, single-agent is more information-efficient.* Across Qwen3, DeepSeek-R1-Distill, Gemini 2.5, apparent multi-agent gains came from "unaccounted computation and context effects," not architecture. Multi-agent only wins when single-agent context utilization **degrades** or when you **spend more compute.** Mirrors Anthropic's own admission that *token usage explains ~80% of multi-agent performance variance.* |
| **Capability saturation** — techniques matter less as base models improve | **Moderate** | AMA-Bench: scaling 8B→32B gave only +0.038 (so architecture still matters *there*), but Epoch AI's 250x effective-context-length jump means many retrieval/memory crutches are being absorbed by raw model capability. The scaffolding that helps a weak model may be dead weight on a strong one. |
| **When is plain long-context single-agent just as good?** | **Synthesis** | For: tasks fitting in-window, tight-coupled reasoning, retrieval-heavy but state-light work, and strong frontier models. The DPI result says: if one agent can use the context well, don't split it. |

**The reconciling principle:** External structure earns its keep precisely where the counter-evidence says single-agent long-context *fails* — when context utilization degrades over a long horizon, across session resets, or under coupled multi-step dependency tracking. That is the regime OpenTasks targets. Conversely, for short in-window tasks on a strong model, OpenTasks risks being pure overhead. **The honest framing: structure pays off as a function of horizon length and dependency density, not universally.**

---

## Techniques OpenTasks Should Enable / Measure

**Enable (well-supported):**
1. **Typed dependency edges + "dispatch when deps clear"** — the DAG-execution pattern; richer than todo.md, expresses what prose can't.
2. **Plan/objective persistence across context resets** — Anthropic persists the lead plan to survive truncation; OpenTasks nodes already do this structurally.
3. **Resume-from-graph harness** — equivalent of the JSON-feature-list + progress-file + git-checkpoint pattern. Lean into JSON-like structured state (Anthropic found models overwrite Markdown more readily).
4. **Atomic claim/lease as duplicate-work / duplicate-side-effect guard** — solves the exact problem durable-execution frameworks journal around; this is a genuine OpenTasks differentiator.
5. **Verification modeled as a gate edge** — node stays open until an *external, hard-to-game* verifier passes.

**Measure (where the literature has gaps OpenTasks can fill):**
1. **The missing RCT:** typed dependency graph vs. freeform NOTES.md vs. pure long-context, **holding total tokens/compute constant** — this exact study does not exist and would be the strongest possible validation (or refutation) of the thesis. Per §2 and §5, structure must beat a *cost-matched* baseline, not just an unconstrained one.
2. **Re-exploration cost after restart:** tokens/steps to regain working state *with* OpenTasks vs. *without* — §4 shows this is asserted but never cleanly quantified.
3. **Crossover point:** at what horizon length / dependency density does the graph start to pay for its overhead? (Saturation/cost concerns from §5 imply a threshold, not a universal win.)
4. **Verifier-gameability audit:** confirm gate edges can't be self-attested away (the 2507.02825 / RLVR caveat).

**One-line verdict:** The literature strongly supports *externalizing structured state* for resumability and long-horizon state-tracking (AMA-Bench, Anthropic harness, durable-execution), and shows graph/causal structure beats lossy compression — but it equally insists that any such scaffolding must beat a **cost-matched single-agent long-context baseline** (2407.01502, 2604.02460). OpenTasks' best move is to *measure* its own lift under that constraint, since that specific evidence is exactly what the field is missing.

---

## Sources

**Memory & context engineering**
- AMA-Bench: Evaluating Long-Horizon Memory for Agentic Applications — https://arxiv.org/html/2602.22769v1
- Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory — https://arxiv.org/pdf/2504.19413 ; results blog https://mem0.ai/research-3 ; State of AI Agent Memory 2026 https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Awesome-Agent-Memory (systems/benchmarks index) — https://github.com/TeleAI-UAGI/Awesome-Agent-Memory
- Epoch AI — Context windows / effective usable length growth — https://epoch.ai/data-insights/context-windows
- Anthropic multi-agent research system (sub-agent context isolation; 90.2% gain; tokens explain ~80% variance) — https://www.anthropic.com/engineering/built-multi-agent-research-system (summary mirrors: https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent)

**Planning & decomposition**
- Context Engineering for Claude Code (TodoWrite, note-taking) — https://newsletter.victordibia.com/p/context-engineering-101-how-agents
- Anthropic — Building agents with the Claude Agent SDK — https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
- Graphs Meet AI Agents: Taxonomy, Progress, Future — https://arxiv.org/pdf/2506.18019
- LLM-Based Hierarchical TODO Decomposition (overview) — https://www.emergentmind.com/topics/llm-based-hierarchical-todo-decomposition

**Verification, reflection & reward hacking**
- Reflexion: Language Agents with Verbal Reinforcement Learning — https://arxiv.org/pdf/2303.11366
- Establishing Best Practices for Building Rigorous Agentic Benchmarks (arXiv:2507.02825 — the user-cited reward/verification-design paper) — https://arxiv.org/abs/2507.02825
- LLMs Gaming Verifiers: RLVR can Lead to Reward Hacking — https://arxiv.org/abs/2604.15149
- Proof-of-Use: Mitigating Tool-Call Hacking in Deep Research Agents — https://arxiv.org/pdf/2510.10931
- Reward Hacking Benchmark (tool-use exploits) — https://arxiv.org/abs/2605.02964

**Resumability / durable execution**
- Anthropic — Effective harnesses for long-running agents (initializer/coding pattern, JSON feature list, progress file, git checkpoints) — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- LangGraph durable execution (official docs) — https://docs.langchain.com/oss/python/langgraph/durable-execution
- Durable Execution for LLM Agents 2026 (Temporal + LangGraph) — https://appscale.blog/en/blog/durable-execution-llm-agents-temporal-langgraph-checkpointing-2026
- Diagrid — "Checkpoints Are Not Durable Execution" — https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short-for-production-agent-workflows

**Counter-evidence**
- AI Agents That Matter (cost-controlled evaluation; arXiv:2407.01502) — https://arxiv.org/abs/2407.01502
- Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking-Token Budgets (DPI argument; Tran & Kiela line; arXiv:2604.02460) — https://arxiv.org/abs/2604.02460

---

*Report complete. Strongest convergent finding: external structured (graph/causal) state measurably helps long-horizon state-tracking and resumability, and architecture beats model scale on memory benchmarks — but the win must be demonstrated against a cost-matched long-context baseline, and the exact "typed dependency graph vs. freeform notes" RCT is the key missing study OpenTasks is positioned to run itself.*