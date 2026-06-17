# E6 — CooperBench Coordination Eval Design (2026-06-16)

**Status:** Design draft for review. No harness code yet (design-first, per the P6 convention).
**Extends:** [2026-06-14 P6 evaluation design](./2026-06-14-P6-evaluation-design.md) (this is a new coordination eval, sibling to **E1/MARBLE**) and reuses the `evals/` runner + `stock/notes/opentasks` arm pattern.
**Source benchmark:** CooperBench — *"Why Coding Agents Cannot be Your Teammates Yet"* (arXiv:2601.13295). 652 collaborative coding tasks, 12 libraries, 4 languages (Python/TS/Go/Rust); 77.3% of tasks have conflicting ground-truth solutions.

---

## 0. TL;DR

- **CooperBench is the adversarial null-hypothesis for OpenTasks.** Two agents implement overlapping features from **isolated Docker containers**, coordinating only through a **SQL message bus** — *no shared state, no shared filesystem*. They fail: SOTA models lose **~41% of solo capability when paired** (retention `AUC_coop/AUC_solo = 0.59` pooled; GPT-5 63%→25%, Claude Sonnet 4.5 65%→25%), and adding more agents makes it worse (2→68.6%, 3→46.5%, 4→30.0%). **More talk does not help** — "with comm" vs "no comm" is statistically insignificant.
- **The paper's own future-work section describes OpenTasks without naming it:** *"lightweight mechanisms that turn conversation into verifiable shared state… explicit insertion-point contracts, and integration checks before declaring safety."* They built the failing baseline and **explicitly declined to test any such substrate** (measuring intrinsic model capability). That open slot is the experiment.
- **Their failure-cause taxonomy is a prioritized OpenTasks build list.** Expectation (42%, "can't model the partner's in-progress changes") + Commitment (32%, "unverifiable claims, trust was all they had") = **74% of failure causes map onto exactly two OpenTasks primitives** — *observable in-progress state* (atomic claim ✅ shipped + visible attempt nodes) and *verifiable completion* (`verifies` edge + structured outcome). One of the two is already built.
- **Design = lift the E2′ `stock/notes/opentasks` RCT into the multi-agent setting.** Hold tasks/model/agent-count fixed; vary only the **inter-agent coordination substrate**: `stock` (CooperBench's native message bus) · `notes` (shared scratchpad file) · `opentasks` (the graph: claims + attempts + verify edges + a shared spec node). Score on CooperBench's **ground-truth merged-test-pass** (never graph state). Focus on the **mid-difficulty band**, where the coordination gap is largest (30–50%).
- **Headline number to move: retention.** If `opentasks` lifts retention above `notes` above the `stock`/published baseline, that's the "structured substrate closes the coordination gap" result — with a published baseline to anchor against. **CooperBench should arguably become the *primary* coordination headline** (it has the solo-vs-coop delta MARBLE lacks); **MARBLE/E1 stays as the breadth + process-metric + research-domain complement.**
- **The one hard part is the harness**, not the science: CooperBench's agents live in **separate containers**, so OpenTasks must run as **cross-container shared state** (daemon reachable from both). That integration is the open risk — scoped in §8, to be designed next.

---

## 1. Why CooperBench (and how it relates to E1 / E2′)

The P6 program already has two coordination-relevant evals. CooperBench is complementary, not redundant:

| | **E6 · CooperBench** (new) | **E1 · MARBLE** (planned) | **E2′ · TheAgentCompany** (headline, planned) |
|---|---|---|---|
| Shape | Adversarial **stress test** — conflict by construction | Topology comparison + process metrics | Long-horizon single-agent state |
| Agents | 2 (scales 2→4) | N, topology-varied | 1 |
| Outcome | Binary: merged patches pass **both** feature test suites (ground truth) | Milestone KPI (graded) | `S_partial` (graded) |
| Domain | Coding only, 4 languages | 6 domains incl. **research** | Digital office work |
| Free baseline it gives us | **Solo-vs-coop retention** (published `0.59`) + a failure-cause taxonomy with frequencies | "Graph topology wins" over LLM-memory | Published `S_partial` numbers |
| Proves | The substrate **prevents named coordination failures** | The substrate **generalizes** + measures coordination *quality* | Structured state beats notes/long-context |

**Why E6 is the sharper coordination headline than E1:** CooperBench is *built* to make coordination fail (77% conflicting tasks, partial observability, isolated workspaces) and reports the solo→coop delta directly. That delta is the cleanest possible "coordination is the bottleneck, not capability" signal, and it's exactly the bottleneck OpenTasks claims to attack. MARBLE has no curse-of-coordination delta — it compares topologies over LLM-maintained memory. **Recommendation:** promote E6 to primary coordination eval; keep E1/MARBLE for breadth, the research domain, and the milestone/coordination-quality metrics (§7). *(This is a proposed amendment to the P6 §6 "settled: E1 → MARBLE" decision — flagged for Alex, §9.)*

---

## 2. The failure taxonomy → OpenTasks primitive map (the core of the design)

CooperBench gives two breakdowns of the same failed runs. **Do not sum across the two tables** — symptoms and causes are different lenses.

**Failure *symptoms*** (their Table 1, % of failed coop runs):

| Symptom | Freq | OpenTasks structural answer |
|---|---|---|
| Work overlap (both implement the same thing) | 33.2% | Atomic claim-to-exclude (**shipped**) + visible in-progress attempts → dedup |
| Divergent architecture (incompatible designs, clean merge but semantic loss) | 29.7% | Shared spec/`context` node both agents `implements` against (the "interface contract") |
| Repetition (verbose status, low signal) | 14.7% | Structured state replaces status-chatter |
| Unresponsiveness (questions unanswered) | 8.7% | Reads come from the graph, not a partner's goodwill |
| Unverifiable claims | 4.3% | `verifies` edge + evidence ref |
| Broken commitment (false completion claims) | 3.7% | Completion gated on a checkable artifact |

**Failure *causes*** (their Table 2, 50 hand-reviewed traces):

| Cause | Freq | What it is | OpenTasks primitive | Build status |
|---|---|---|---|---|
| **Expectation** | 42% | "Failure to model the state of the other agent's code changes" | Partner state **is** the graph — observable attempt/claim nodes, queryable; not inferred from chat | claim ✅; **attempt-visibility ❌** |
| **Commitment** | 32% | "Unverifiable claims… trust is all they had" | `verifies` edge + structured `outcome` + an "integration check before declaring safe" gate | **❌ to build** |
| **Communication** | 26% | Decision loops collapse over free text | Graph is the channel; chat becomes the exception | structurally implied |

**The convergence that makes this worth doing:** the two highest-frequency causes (74% combined) are answered by the *same two primitives* the schema discussion already identified — observable state and verifiable completion — and they're the same primitives E1's "spec-carrying task node" and E5's "non-self-assertable gate" need. **CooperBench's measured frequencies turn the OpenTasks roadmap into a priority-ordered list with predicted ceilings**, rather than a guess.

---

## 3. Arms (the E2′ RCT, lifted to multi-agent)

Same tasks, same model, same agent count (2 for the primary matrix); **only the inter-agent coordination substrate varies.** Naming reuses `evals/arms.ts` for consistency.

| Arm | Coordination substrate | Tests |
|---|---|---|
| `stock` | CooperBench native: SQL message bus, isolated containers, no shared state | Reproduces the published baseline (retention ≈ 0.59) — the anchor |
| `notes` | Shared append-only scratchpad file both agents read/write (unstructured shared blackboard) | "Does *any* shared state help?" — the honest middle baseline |
| `opentasks` | The OpenTasks graph as cross-container shared state: atomic `claim_next`, visible `attempt` nodes, `verifies` edges, one shared spec/`context` node | The treatment: structured + claimable + verifiable shared state |
| `registry` *(optional ablation)* | A structured-but-dumb shared JSON commitment registry (key/value: "agent X owns feature Y", "Y status=done") — no deps, no verify, no graph queries | Isolates "*structure* helps" from "*OpenTasks' specific affordances* help" |

The `stock → notes → opentasks` ladder is deliberately the same shape as the E2′ RCT, so results are directly comparable across the two evals. The optional `registry` arm answers the reviewer question "is it the graph, or just any structured shared state?" — include it only if `opentasks > notes` is significant and we need to attribute *why*.

**Solo reference.** Retention needs the denominator: run each agent's single feature **solo** (CooperBench's solo protocol) as a fixed reference. Solo is identical across arms (no coordination to vary), so it's run once per (task, model) and reused. `retention_arm = AUC_coop(arm) / AUC_solo`.

---

## 4. Metrics

**Primary (ground truth — never graph state; complies with P6 §1.4):**
- **CooperBench success** = both feature test suites pass on the merged codebase (their 2-stage `git merge-file` + correctness eval). Scoring is 100% CooperBench-stock.
- **Retention** `= AUC_coop(arm) / AUC_solo`, swept over their difficulty stratification `d̃(t)`. This is the headline; report per-arm with CIs.

**Coordination diagnostics** (computed from the trace + the edge layer; layered on top, never affect scoring — same discipline as `evals/metrics.ts`):

| Metric | Definition | Why it's here |
|---|---|---|
| **Work-overlap rate** | fraction of runs where both agents wrote the same functionality | CooperBench symptom #1 (33%); `opentasks` should drive → ~0 via atomic claim, **measured directly from the claim trace** |
| **Verified-completion rate** | fraction of "done" declarations backed by a `verifies` edge + evidence | targets Commitment (32%); diagnostic, `opentasks`/`registry` only |
| **Semantic-conflict rate** | fraction of actions writing incompatible changes to the same resource (their "divergent architecture") | computed **from the edge layer** in `opentasks` (OpenTasks' structural advantage; cf. P6 §3) |
| **Redundancy `R`** | mean pairwise cosine sim of agent outputs (P6 §1.4) | duplicated-not-diverse work |
| **Error amplification `A_e`** | `E_MAS / E_SAS` (P6 §1.4) | does the substrate stop coordination from amplifying errors? |
| **Coordination efficiency `E_c`** | `S / (T_MAS / T_SAS)` (P6 §1.4) | success normalized by relative cost |
| **Message density `c`** | inter-agent msgs ÷ reasoning turns | expect `opentasks` to **reduce** chat reliance (CooperBench's "talk doesn't help") |
| **Read-graph flag** | did the agent call a graph-read tool? (reuse `didReadGraph`) | the null-result gate: if agents ignore the graph, fix surfacing before concluding null |

**Optional process metrics (borrowed from MARBLE, §7):** milestone-based KPI (partial credit per feature sub-step) + LLM-judged coordination score, for graded signal where binary pass/fail is too coarse.

**Cost control (P6 §1.4):** match **total tokens summed across both agents** (aggregate, not per-agent — the swarm-tax rule from Tran & Kiela). Count OpenTasks MCP/daemon traffic as cost in the `opentasks` arm. Report an accuracy–cost Pareto curve, not a point.

---

## 5. OpenTasks surface area each arm needs (build list, ordered by measured frequency)

The `opentasks` arm is only as good as the primitives it exposes. Ordered by the failure-cause frequency they target (§2):

1. **Observable in-progress state** *(targets Expectation 42% + work-overlap 33%)* — atomic claim **shipped** (`coordination.ts` `claimNode`, fence tokens). **To build:** `attempt` nodes (or attempt edges) that are *visible in `query`/`ready`*, plus a "what is every agent doing right now" view. This is the single highest-ROI item.
2. **Verifiable completion** *(targets Commitment 32%)* — **to build:** a `verifies`/`reproduces` edge in the (open) `EdgeTypeRegistry`, a structured `outcome` metadata convention (`pass`/`fail`/`inconclusive` + evidence ref), an "unverified completion" query, and a *don't-declare-safe-until-checked* gate. Directly implements CooperBench's proposed "integration checks before declaring safety."
3. **Shared spec/interface contract** *(targets divergent architecture 30%)* — `implements` edge **exists**; **to build:** the usage pattern — one shared `context` node carrying the agreed interface signatures as structured data, both agents `implements` against it (their "explicit insertion-point contracts"). Doubles as the research-mode shared-hypothesis node.
4. **Graph-as-channel** *(targets Communication 26%)* — coordination reads/writes route through structured state; the system-prompt nudge (cf. `arms.ts`) tells agents to consult the graph before messaging.

Items 2–3 are the same primitives the schema discussion landed on (`verifies` edges, `outcome` metadata, shared spec) — so the eval and the schema work fund the same small build surface.

---

## 6. Run matrix, pilot, and decision rule

**Task subset.** Don't run all 652. Select the **mid-difficulty band** (`d̃(t)` ≈ 0.3–0.6) where the solo→coop gap is 30–50% — maximal signal — stratified across the 4 languages. ~15–25 tasks.

**Pilot first** (de-risk the cross-container plumbing, §8, before scale):
- ~5 tasks × 3 arms (`stock`/`notes`/`opentasks`) × 3 runs + solo references.
- Confirm: (a) the daemon is reachable from both containers and both agents see a *consistent* graph; (b) atomic claim actually prevents the double-grab across containers; (c) `didReadGraph` shows agents *use* it; (d) the token-match is honest; (e) `stock` reproduces CooperBench's published retention within noise (validates our harness against ground truth).

**Scale:** ~15–25 tasks × {`stock`,`notes`,`opentasks`(,`registry`)} × ≥5 runs × 2 models (GLM-5 via mantle + one contrast model, per P6 §6) + solo references. Paired-by-task, report CIs.

**Decision rule:**
- `retention(opentasks) > retention(notes) > retention(stock≈published)`, at matched tokens, with the work-overlap rate → ~0 in `opentasks` → **headline: structured shared substrate closes the coordination gap.** Publish against CooperBench's scale.
- `opentasks ≈ notes > stock` → shared state helps but *structure doesn't* — weaker claim; investigate via the `registry` arm.
- `opentasks ≈ stock` → the substrate doesn't transfer to adversarial coordination. First check `didReadGraph` (surfacing failure → fix and rerun once); if agents *did* read it and still no lift → **kill/pivot** to the edge-layer/routing value (per P6 §7).

**Predicted shape (state it up front, per the MARBLE caveat).** Expect the lift to concentrate in **mid-difficulty, strong-model** runs and to shrink toward capability saturation (P6: negative returns once single-agent > ~45%). Predicting *where* it helps and being right is more convincing than a single average. The honest claim remains **safety, not multiplier** — `opentasks` should *prevent the coordination tax*, not make two agents smarter than one strong agent.

---

## 7. MultiAgentBench (MARBLE / E1) fit — what to reuse, how it complements

CooperBench and MARBLE are the two halves of the coordination story:

- **CooperBench = depth/adversarial.** Narrow (coding), binary, conflict-by-construction, published solo-vs-coop delta. Proves *prevention of named failures*.
- **MARBLE = breadth/process.** 6 domains incl. **research**, graded milestone KPI, LLM-judged coordination score, and a **topology ablation that already found graph wins.** Proves *generalization* + measures *coordination quality*.

**Reuse from MARBLE into E6:**
- **Milestone-based KPI** (`KPI = (1/NM)·Σ nⱼ`) for partial credit where CooperBench's binary outcome is too coarse — define per-feature sub-milestones.
- **Coordination Score** (LLM-judged Communication + Planning, 5-pt, human-validated via Kendall/Pearson/Spearman) as the process-quality metric across both evals.

**E6 → E1 sequencing:** MARBLE already found the **graph *topology*** wins over `star/tree/chain` — but over **LLM-maintained memory**, *not* a durable structured store. So OpenTasks-on-MARBLE is the natural follow-up: add `opentasks` as one more coordination protocol (per P6 §5b, via swarm-dispatch `claimNext`) and test whether a real graph *substrate* beats their graph *topology* on the same KPI — and whether it carries to the **research domain** (the coding-vs-research generalization). Run **E6 first** (sharper, cheaper, published baseline), **E1 second** (breadth + research + process metrics).

---

## 8. Harness integration — cross-container daemon (RESOLVED 2026-06-16: sidecar, zero code change)

CooperBench's defining property is **workspace isolation**: each agent runs in its own Docker container with no shared filesystem, coordinating only via the SQL bus. The `opentasks` arm must expose **one shared graph reachable from both containers**, consistent and race-free across the boundary, or the eval is invalid.

**Decision: a dedicated daemon *sidecar* + thin MCP clients over a bind-mounted Unix socket. No OpenTasks code change** — the externally-managed-daemon mode already exists (traced 2026-06-16):

- `opentasks mcp --socket <path>` parses the path ([`cli.ts:1379`](../../src/cli.ts)), then **skips auto-start because the guard is `!socketPath`** ([`cli.ts:1390`](../../src/cli.ts); the comment: *"Skip when an explicit `--socket` is given (the daemon is externally managed)"*) and connects the client to that socket ([`cli.ts:1402`](../../src/cli.ts) → [`server.ts:56`](../../src/mcp/server.ts) `new OpenTasksClient({ socketPath })`). So `--socket` **is** the "connect to a shared daemon, never fork a local one" mode we needed.
- The daemon binds its socket at `path.join(locationPath, daemon.socketPath ?? 'daemon.sock')` ([`lifecycle.ts:337–340`](../../src/daemon/lifecycle.ts), `createIPCServer` at `:471`), and `locationPath` is driven by **`OPENTASKS_PROJECT_DIR`** (top priority in `resolveProjectDir`, [`cli.ts:36–39`](../../src/cli.ts)). Pointing the daemon's socket + data at the shared mount is one env var.
- **One daemon = one writer**, so the atomic claim's conditional-UPDATE serializes exactly as in the single-writer SQLite case the synthetic cell-B/D already proved race-clean. Cross-container contention introduces **no new concurrency risk** — only plumbing. (This also rules out the rejected alternative of two daemons over a shared `graph.jsonl`: multi-writer breaks the single-writer assumption the claim relies on — the flush/pull hazard the hardening work closed.)

**The recipe (single host, mirrors CooperBench's shared-SQL topology):**

```
# one shared host dir bind-mounted into all three containers, e.g. /srv/ot
sidecar:  OPENTASKS_PROJECT_DIR=/srv/ot  opentasks daemon start --foreground
          # binds /srv/ot/daemon.sock; sole owner of graph.jsonl + SQLite
agent A:  OPENTASKS_NO_AUTOSTART=1  opentasks mcp --socket /srv/ot/daemon.sock --scope all
agent B:  OPENTASKS_NO_AUTOSTART=1  opentasks mcp --socket /srv/ot/daemon.sock --scope all
```

Agents need only the **socket** visible (thin clients; all reads/writes go through IPC), not the data dir. `OPENTASKS_NO_AUTOSTART=1` is belt-and-suspenders on top of the `--socket` guard. **Sidecar (not co-located in an agent container)** keeps the two agents symmetric peers — neither is privileged or owns the store.

**Only harness change:** add `--socket $OT_SOCK` to the `opentasks` arm's MCP launch in [`evals/arms.ts`](../../evals/arms.ts) (env-gated, so the single-container E2′/synthetic runs are unaffected).

**Remaining pilot gates (non-code, compose-level):**
1. **Bind-mount, not a named volume** — the socket inode must sit on a host dir shared by same-host containers (the `docker.sock`-sharing pattern); overlayfs/named volumes don't reliably carry socket files.
2. **uid/permission alignment** — the sidecar creates the socket; both agent containers' users need rw on it.
3. **Ordering** — sidecar up + socket bound before agents connect (compose healthcheck / wait-for).
4. **The correctness gate** — two containers race `claim_next` on the same node, **exactly one wins**: the cross-container analog of the cell-B/D race-clean result. The single must-pass check before scaling.

---

## 9. Decisions

**Proposed (this doc):**
- Add **E6 · CooperBench** as a coordination eval; reuse the `stock/notes/opentasks` arm ladder and the `evals/` runner.
- Score on CooperBench's **ground-truth merged-test-pass**; headline metric = **retention**; focus the matrix on the **mid-difficulty band**.
- Run **E6 before E1**; reuse MARBLE's **milestone KPI + coordination score** as process metrics in both.

**Recommended amendment to P6 (flag for Alex):**
- Promote **E6/CooperBench to the *primary* coordination headline** (it has the solo-vs-coop delta MARBLE lacks); demote **E1/MARBLE to the breadth + research + process-metric complement.** *(P6 §6 currently settles "E1 coordination → MARBLE"; this revises it.)*

**Resolved (2026-06-16):**
- **Cross-container daemon integration** (§8) — **dedicated sidecar + thin MCP clients over a bind-mounted Unix socket; zero code change** (`mcp --socket` is the externally-managed-daemon mode; `OPENTASKS_PROJECT_DIR` places the sidecar's socket on the shared mount). Was the gating runnability risk; now plumbing only.

**Open (to design next):**
1. Whether to include the **`registry` ablation arm** in the first scale run or hold it for the attribution follow-up.
2. **Model set** — same GLM-5 + contrast as E2′, or add one of CooperBench's evaluated models (GPT-5 / Claude Sonnet 4.5) to compare against their published per-model retention directly.

---

## Sources

- **CooperBench** — *Why Coding Agents Cannot be Your Teammates Yet* (arXiv:2601.13295; cooperbench.com). All numbers in §0/§2 (retention 0.59, per-model solo→coop, 2→4 scaling, failure Tables 1–2, the "verifiable shared state" future-work quote) are drawn from the paper.
- **MultiAgentBench / MARBLE** (arXiv:2503.01935, ACL 2025) — milestone KPI, coordination score, graph-topology finding (§7).
- **P6 program** — [2026-06-14 P6 evaluation design](./2026-06-14-P6-evaluation-design.md) (coordination metrics §1.4, arms, scoring discipline); `evals/` harness (`arms.ts`, `metrics.ts`, runner).

*Uncertainty: CooperBench figures here come from a structured read of the arXiv HTML, not a line-by-line pass of the PDF/tables. **Verify the exact numbers (retention 0.59, the Table 1/2 percentages, the 2→4 scaling) against the published PDF before citing them in any external write-up.** Several are also model-version-specific (GPT-5 / Claude Sonnet 4.5 as of the paper's runs).*
