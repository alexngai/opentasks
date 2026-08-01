# Experiment plan — the runs the paper needs

Companion to [`PAPER-PLAN.md`](./PAPER-PLAN.md) (claim + exhibits) and
[`TIER3-THROUGHPUT.md`](./TIER3-THROUGHPUT.md) (the throughput pre-registration). This file
is the execution order: what to run, in what sequence, what each run feeds, and the
decision gate that follows it.

Sequencing principle: **cheapest falsification first.** E1 can invalidate the paper's
framing for the price of 48 agent-runs; Tier 3 cannot change the framing at all. So E1
runs before anything gets widened.

Order: **E0 → E1a → E6 → (E1b, E2, E3) → E4 → E5.** E6 is pulled forward because it is the
only experiment that can turn the paper's standing limitation (safety, not throughput) into
a result, and because it needs E0's multi-action stratum but nothing else.

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
   "artefact of one family." **This needs no code change here** and is *not* blocked on the
   GLM-5 stack — see below.

**Cost:** the dominant run in the paper; size it after E0 reports the true stratum size.

### Adding a model family — what it actually takes

`NativeCliAdapter` routes via `routeModel(gateway, cell.model)`, which for the `anthropic`
dialect sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` at the LiteLLM gateway. LiteLLM
resolves the friendly model name against its `model_list` and translates to whatever backend
serves it. So the runner needs only `EVAL_MODEL=<friendly-name>` through the existing
`WB_GATEWAY_BASE_URL` — all the work is in the gateway config, and swarmkit-eval already
exports the builders:

| path | builder | notes |
|---|---|---|
| **Bedrock non-Anthropic** (Nova, Llama, DeepSeek, Qwen, Mistral) | `bedrockDeployment` | **lowest friction** — same gateway, same AWS creds the sonnet/haiku runs already used. No new credentials. |
| **Azure OpenAI** (GPT-class) | `azureOpenAIDeployment` | needs `api_base` / `api_version` / a key env; the RoadmapBench runner already has an Azure-via-gateway arm as precedent |
| **Open-weight, self-served** | `openaiCompatDeployment` | any `/v1/chat/completions` server (vLLM, Together) |

**Do not confuse this with `evals/glm5/`.** That is a separate homegrown stack (LiteLLM plus a
hand-rolled sigv4 shim) with no retry/backoff, and it is the thing that fell over in June. The
Bedrock gateway the WorkBench Tier-2 runs used is a different, working path. GLM-5 is one
option among several, not the only route to a second family — prefer a Bedrock-native
non-Anthropic model, which reuses infrastructure already proven on these exact runs.

> **Validity threat — the scaffold is Claude Code.** The agent is `claude -p`, whose system
> prompt and tool-calling conventions are tuned for Claude, and a non-Anthropic model reaches it
> through LiteLLM's Anthropic-dialect translation. Absolute completion for a GPT- or Llama-class
> model is therefore confounded by scaffold fit, and the paper **must not** claim "model X is
> worse at coordination than sonnet."
>
> The C3 claim survives intact, because it is comparative *within* a model: the question is
> whether the instructed→structural gap widens as effective capability falls, and a
> scaffold-handicapped model is simply a lower point on that curve. Frame every cross-family
> number as **effective capability within a fixed scaffold**, hold the scaffold constant across
> all arms and models, and state the confound in Limitations. Sanity check before trusting a new
> family: confirm its N=1 solo completion is non-trivial — if the model cannot do the task alone
> in this scaffold, its multi-agent cells measure scaffold fit, not coordination.

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

## E6 · Advisory vs enforced — **the outperformance run**

**Feeds:** T4, C6. **This is the only experiment that can show a swarm beating a solo agent.**

Everything measured so far is advisory: instructed stand-down, per-domain claiming, and manager
delegation all trust the agent to honour a partition. `opentasks-gated` validates the claim at the
resource — a side-effecting tool call from an agent holding no live claim is refused before it reaches
WorkBench. That keeps per-domain's parallelism while removing its dependence on compliance.

Run it on the **multi-action** stratum from E0 (`t3-ideal`), not the single-action one: with k=1 there is
nothing to parallelise and gating can only match single-writer.

```sh
WB_GATEWAY_BASE_URL=… WORKBENCH_LLM_API_KEY=… AWS_REGION=us-east-1 \
  EVAL_MODEL=<model> EVAL_ARMS=opentasks-gated EVAL_N=<2|4> \
  EVAL_TASK_IDS=<t3-ideal ids> EVAL_DEBUG_DIR=evals/.wb-debug-gated \
  npm run eval:workbench:marble
```

**Preflight — do this first, on ONE cell.** The gate fails closed, so if `AGENT_ID` does not reach the
MCP child every side effect is refused and the cell scores 0.00 with zero duplicates, which reads as
flawless coordination. Check `gateBroken` (the runner warns) and `.wb_gate.jsonl` in the cell workspace:
denials of `no-claim`/`claim-expired` are the mechanism working; `no-agent-id`/`claim-lookup-failed` mean
the gate is broken and the cell is invalid. The fix for `no-agent-id` is upstream — swarmkit-eval's
`native-cli` adapter should add `AGENT_ID` to each `mcpServers[...].env` when it writes the MCP config.

**Compare against**, on the same task ids: `opentasks` per-domain (same parallelism, advisory only),
`opentasks` single-writer (safe, one worker), and the **N=1 solo** cell (the ceiling to beat).

**What each outcome means:**

| outcome | reading |
|---|---|
| completion ≥ single-writer, `activeAgents` > 1, `criticalPathCalls` < solo | **the result** — parallel *and* safe. C5 flips from limitation to finding; C6 is demonstrated |
| completion ≥ single-writer but `criticalPathCalls` ≈ solo | enforcement gives safety without speed — agents serialize anyway. Still a C6 result (advisory → enforced closes the per-domain collapse), but not an outperformance claim |
| `gateDenied` high and completion low | agents spend their turns bouncing off the gate. Mechanism is sound but the protocol is expensive — report the cost and revisit the prompt, not the gate |
| completion ≈ per-domain (still collapsing) | duplication is coming from somewhere the gate does not cover. Inspect the union log: two DISTINCT claims whose actions overlap means the partition, not the enforcement, is wrong |

The last row is the honest risk: gating guarantees at most one agent acts *per claim*, not that the
partition carves the required actions cleanly. On `t3-ideal` tasks the public domain split coincides with
the action split by construction, which is exactly why E0's stratification comes first.

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
