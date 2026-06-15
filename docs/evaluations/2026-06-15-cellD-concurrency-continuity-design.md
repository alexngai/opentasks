# Cell-D Evaluation — Concurrency × Continuity Design (2026-06-15)

**Status:** Design for review. Supersedes the benchmark/continuity decisions in
[2026-06-14-P6-evaluation-design.md](./2026-06-14-P6-evaluation-design.md) §"Benchmarks
decided" with empirical justification gathered 2026-06-15.
**Extends:** the P6 thesis (substrate = coordination *safety*, not a multiplier) and the
`evals/` harness already built.

---

## 0. TL;DR

- Two empirical nulls this session bracket the problem precisely: OpenTasks is null
  whenever the working state fits **in context** (single-session, capability-saturated)
  OR **in the work dir** (post-reset but file-recoverable). It can only be load-bearing
  where **neither** holds.
- Those two escape hatches are two axes of one variable — *state exceeds one context
  window*. **Concurrency** spreads it across agents (space); **continuity** spreads it
  across resets (time). → a **2×2 "load-bearing matrix"**: test each axis alone, then the
  interaction.
- One **unifying task property** defeats both nulls at once: a **non-idempotent
  side-effect not visible on disk** → an **exactly-once** ground-truth check that catches
  both the concurrency race (two agents double-act) and the continuity re-do (a reset
  agent re-acts).
- **Evidence ladder:** synthetic emit-queue 2×2 (internal validity) → **TheAgentCompany**
  as the *established external anchor* (NeurIPS'25; carries credibility) → **EntCollabBench**
  as a *novel richer second host* (best fit for the OpenTasks-vs-handoff story, but
  unadopted — gated). **MARBLE is dropped** (turn-based, no shared store, LLM-judge
  scoring → can't ground a safety claim).
- Scoring is always **ground-truth + token-matched + k-repeats**, with a **pre-registered**
  win/null rule and an **N=1 negative control**.

---

## 1. Why a new design (the two nulls)

| Run | Regime | Result |
|---|---|---|
| `build-todo` single-session, GLM-5 | N=1, one context | **null with overhead** — all arms S=1.00; opentasks arm made 0 graph calls, +2.4× tokens (saturation + non-adoption) |
| `build-todo` reset, GLM-5 | N=1, context reset | **clean null** — all arms S=1.00 at ~300–320K phase-2 tokens; opentasks *did* read the graph on resume but gained nothing (state was file-recoverable) |

Conclusion: **adoption is solvable** (the resume framing activated graph reads); **value
is the open question**, and it requires a regime where state is neither in-context nor
in-the-work-dir. Results: `evals/results/2026-06-15-build-todo-glm5.md`,
`…-build-todo-reset-glm5.md`.

## 2. The load-bearing matrix (2×2)

Axes = the two ways state outgrows one context:

|  | single session (time-cheap) | reset / multi-session (time-stressed) |
|---|---|---|
| **swarm (N>1)** | **B · concurrency alone** — atomic claim vs race | **D · both** — swarm across resets (the real regime; interaction) |
| **solo (N=1)** | **A · anchor** — null control (done ✓) | **C · continuity alone** — resume vs re-derive |

- **A** = negative control. Must stay null (we confirmed it). If any arm shows an OpenTasks
  benefit at N=1/single-session, the metric is confounded — stop and fix.
- **B** isolates **safe-claim** value (space).
- **C** isolates **resumability** value (time) — reuses the `EVAL_RESET` harness already
  built + validated.
- **D** is the product regime (agent-teams-on-long-work). The factorial lets us measure the
  **interaction = D − additive(B, C)**; the hypothesis worth the program is that it's
  **super-additive** (a dying agent loses claims *and* progress; a replacement can't tell
  what's claimed *or* done).

## 3. The unifying task property

A queue of M items; processing an item performs a **non-idempotent side-effect that is not
visible on disk** (e.g. `./emit <id>` appends to a log the agent can't read back — a
stand-in for "send / charge / post"). Ground truth: each id must appear **exactly once**.

- **Concurrency hazard:** two agents claim the same item → emitted twice (lost-update race).
- **Continuity hazard:** a reset agent can't tell from disk what's done → re-emits → twice.

One scorer (`exactly-once`) captures both. `stock` fails by re-doing/clobbering; `notes`
works only if it maintained the record faithfully; `opentasks` (atomic `claim` + persistent
`complete`) is correct by construction. This is *the* property that makes "done-ness" not
file-recoverable — the lesson from build-todo's null.

## 4. Arms (constant across every cell)

- `stock` — no shared state (collision / redo baseline)
- `notes-freeform` — a scratchpad
- `notes-claim-by-convention` — *attempts* coordination but racy (TOCTOU). **Required** — it
  makes the comparison "atomic vs racy claim," not "coordination vs none," killing the
  "rigged baseline" critique.
- `opentasks` — atomic `claim`/`release`/`fence` + persistent `complete` (the P0 primitives)
- `static-partition` — items split upfront (concurrency cells only; the "you didn't need a
  substrate" control). Tasks must be **dynamically contended** (discovered work-list /
  failure-reassignment) so this baseline can't trivially win.

## 5. Metrics

Completion (S_partial) is **not** the headline — saturation hides it. Measure
safety/efficiency **at matched completion**:

- **double-emit / lost-update incidents** (primary, concurrency)
- **re-orientation cost** after reset (tokens/time to recover; already captured)
- **resilience** — wasted-work-on-kill, recovery cost (cell D)
- coordination-overhead ratio; throughput-under-concurrency (charging OpenTasks its daemon
  round-trip latency honestly)

Discipline: ground-truth only (never graph self-report); token-matched at swarm-sum;
**k ≥ 5** paired runs with CIs; GLM-5 primary + one contrast model for the saturation curve;
sweep N∈{1,4,8} and contention; **pre-register** the win/null rule per stage.

## 6. Evidence ladder — hosts and why

The synthetic 2×2 gives internal validity but is dismissible ("you built a task that needs
your tool"). Standard benchmarks give external validity but most live in **cell A** (single
agent, single session = the null regime) — so they must be *operated in a stressed regime*,
not pointed-at as-is.

**Adoption check (2026-06-15) drove the host choice:**

| Host | Establishment | Role |
|---|---|---|
| synthetic emit-queue | n/a | internal validity; predicts the contention/N/reset settings where a host lift appears |
| **TheAgentCompany** | NeurIPS'25, populated leaderboard | **established anchor** — carries the credibility |
| **EntCollabBench** | **2★ GitHub, ~0 citations, 1 mo old, no license** | **novel 2nd host** — best fit, but gated on adoption-risk + license |
| ~~MARBLE~~ | ACL'25 | **dropped** — turn-based (no real race), no shared task store, LLM-judge scoring (gameable) → can't ground a safety claim |

The synthetic property (non-idempotent, not-on-disk) is a deliberate *reduction* of a real
benchmark mechanic (AppWorld/TAC side-effects are world-state-scored), so it isn't contrived
— it's the unit-test version.

## 7. Host plan — TheAgentCompany (established anchor)

Single-agent + browser-oriented by design, so **we engineer both axes** (same as any host).
Confirmed feasible; the costs are known and mitigated:

- **Driver:** TAC ships only an OpenHands driver, but tasks + `evaluator.py` are
  scaffold-agnostic (`/utils/eval.py` decrypts + runs `grade_checkpoints(trajectory)`). We
  write a headless `claude -p`/GLM-5 driver that emits a compatible trajectory; the
  init/reset/eval plumbing is reusable as-is.
- **Cheap footprint:** start **GitLab-only** (~47 API-friendly tasks, **no browser**,
  sidesteps the Apple-Silicon MongoDB pain and image rot). Graduate to the PM tasks
  (`pm-update-sprint-cycles`, `pm-check-backlog-update-issues` — per-issue move+notify
  fan-out) on the fuller stack for the headline.
- **Scoring fix:** stock graders under-detect duplicates (`check_rocketchat_message_posted`
  reads last-10, presence-only). Add a thin **exactly-once** assertion (count
  issues/MRs/messages, assert == expected) — small, evaluators are plain Python with full
  API access via `common.py`.
- **Axis injection:** concurrency = ≥2 headless agents on **one shared GitLab instance**
  working a shared per-item task list; continuity = inject a mid-task kill/reset.
- **Arms:** stock / shared-notes-file / opentasks.

## 8. Host plan — EntCollabBench (novel 2nd host, gated)

Verdict **GO-WITH-WORK** (clone `yutao1024/EntCollabBench`, data on HF). Its own paper names
its bottlenecks — *delegation, context transfer, workflow closure, coordination cost* —
which **are** OpenTasks's value proposition, so the OpenTasks arm intervenes on exactly what
the benchmark measures.

- **GLM-5 routing = EASY** — all agent calls via one `langchain_openai.ChatOpenAI`
  (`agent.py:438`); env-only (`OPENAI_BASE_URL`, `AGENT_LLM_MODEL=glm-5`), no code change.
- **Scoring correction (paper oversells):** scoring is **LLM-judge majority vote**, not
  deterministic — the DB diff is advisory ("allow harmless extra steps"), so a duplicate
  **passes**. The diff already computes closed-world insert/update/delete counts
  (`benchmark.py:1569`); we add a **deterministic exactly-once gate** (`~:2263`). Mandatory.
- **Axis injection:** concurrency = wrap the sequential subtask loop (`benchmark.py:2154`,
  one shared seeded DB) in a thread pool (its sequentiality is partly *prompt*-suppressed);
  continuity = reset via `/sessions/clear` (state is `InMemorySaver`, lost on restart; the
  seeded DB survives) → opentasks supplies the durable resume.
- **OpenTasks slot:** replace the isolated `ask_<target>_by_http` delegation tool
  (`agent.py:653-838`) with claim/observe/complete.
- **Gates before investing:** resolve the missing **LICENSE**; verify Apple-Silicon image
  arch (or run on Linux/amd64); skip the missing **gitea** service slice.

## 9. Staged sequence with decision gates

| Stage | Build | Gate to advance |
|---|---|---|
| 0 | (done) anchor A null + reset harness | ✓ |
| 1 | **synthetic emit-queue 2×2** (cells B, C, D) | B: opentasks ≈0 incidents while notes-by-convention material; C: opentasks re-orient < notes < stock |
| 2 | **TAC GitLab-only smoke** — 1 task headless on GLM-5 | the pipeline runs end-to-end (retires the no-browser/infra risk) |
| 3 | **TAC cell-D** — exactly-once gate + 2-agent concurrency + reset, 3 arms | a real signal on the established anchor |
| 4 | **EntCollabBench extension** (gated on §8 + a TAC signal) | license resolved + GO confirmed |

N=1 negative control runs at every stage. Null branches are pre-committed (e.g. if
notes-by-convention also hits ~0 incidents → capable models self-coordinate at this
contention → raise contention or conclude value is elsewhere).

## 10. Threats to validity (and mitigations)

- **Rigged baseline** → notes arm *attempts* claim-by-convention; we measure naive-coordination
  failure rate, not coordination-vs-none.
- **Static partitioning makes it moot** → task is dynamically contended; static-partition is an
  included control.
- **Saturation** → lead with safety/correctness metrics (a wrong answer can't be hidden), not
  completion; contrast model on the capability curve.
- **Re-derivability defeats continuity** → the not-on-disk side-effect; choose sub-actions whose
  done-ness is ambiguous from world state.
- **Gameable scoring** → ground-truth only; for EntCollabBench, the deterministic gate (never the
  stock LLM judge); never score by graph state.
- **Single-source host risk** → TheAgentCompany anchors credibility; EntCollabBench is the
  extension, not the foundation.

## 11. Status & empirical results (as of 2026-06-15)

**Implementation:** the substrate (HARDENING-PLAN P0–P5 — atomic claim/lease/fence, sync
coordination, events, DX, ecosystem) is **complete**. P6 (this eval program) is the active
phase. Harness built: `evals/synthetic/` (cells B/C/D — collector + emit-queue + the three
runners), the base `evals/` harness, the GLM-5 stack (`evals/glm5/`), and the AppWorld+GLM-5
pipeline (`evals/appworld/`, stock arm validated).

**What's been proven (GLM-5; results in `evals/results/`):**

| Experiment | Result | File |
|---|---|---|
| build-todo, single session | **null with overhead** — saturated model, 0 graph calls, +2.4× tokens | `…-build-todo-glm5.md` |
| build-todo, reset (file-recoverable) | **clean null** — adopted but no value (work-dir is the state) | `…-build-todo-reset-glm5.md` |
| **Cell B** (concurrency, k=4) | opentasks **4/4** correct & cheapest-correct; notes 2/4 (bimodal); stock 0/4 | `…-synthetic-cellB-…md` |
| **Cell C** (continuity, n=1) | opentasks **ties** disciplined-notes (both 6/6); stock fails; opentasks pricier single-agent | `…-synthetic-cellC-…md` |
| **Cell D** (both, k=5) | opentasks **0 races in all 5** (4/5 fully correct, 1 infra-miss); notes 0/5 (1–4 races every run); stock 0/5 | `…-synthetic-cellD-and-2x2-summary.md` |

**Bottom line (thesis demonstrated):** OpenTasks is a coordination-**safety** substrate —
*null* when state fits in one context (anchor / single-session), a *qualitative* win on
concurrency (B), a *tie* on continuity-alone (C, a disciplined log suffices), and
**irreplaceable on the combination** (D — the swarm-across-reset regime, where the baselines
fail super-additively and only the atomic primitive stays race-clean). The two nulls are
load-bearing context: they show the effect is real (it appears only where predicted), not a
artifact of a rigged setup.

## 12. Follow-ups / open validations

**Eval infra (do first — currently blocking):**
- **GLM-5 proxy reliability.** The SigV4 shim → Mantle path has **no retry/backoff** and low
  TPM; it falls over under sustained load (it crashed mid the cell-D/C k=5 battery on
  2026-06-15, invalidating the cell-C repeat). Add retry+exponential backoff in the shim and a
  concurrency cap in the harness before scaling any runs.

**Stage 1 finish (synthetic):**
- Clean **cell-C k≥5** (blocked on the proxy fix; the existing cell-C is n=1).
- **Contention sweep** N∈{2, 8} on cells B/D for monotonic baseline degradation (watch N=8 vs
  proxy TPM).
- A **second model** (saturation curve) — show the effect varies with capability.
- **Token-matching** enforced at swarm-sum, **pass^k** + CIs for publication-grade numbers.

**Stage 2 (the big lift — standardized anchor):**
- **TheAgentCompany GitLab-only host:** write a headless `claude -p` driver (TAC ships only an
  OpenHands one), add an **exactly-once evaluator gate**, inject 2-agent concurrency + a
  mid-task reset, run the 3 arms — i.e. instantiate cell D on recognized tasks.

**Stage 3 (gated):**
- **EntCollabBench** host — resolve its missing LICENSE + verify Apple-Silicon image arch
  first; add the deterministic exactly-once gate (its stock scoring is LLM-judge); parallelize
  the subtask loop; durable-resume wiring.
- **AppWorld** OpenTasks/NOTES arms (the pipeline already runs the stock arm).

**Carried over from hardening (deferred by design, revisit if eval surfaces them):**
- F8 wall-clock LWW merge (no causality/CRDT — still in place); swarm-dispatch *real-daemon*
  e2e; E2-baseline never captured (current HEAD is the reference point); lint debt (~245
  pre-existing errors, F10).

**Release hygiene:** the `hardening` branch is far ahead of `origin` and **unpushed**;
`opentasks@0.1.4` is **unpublished**; 2 spawned follow-up task chips remain (multi-loc
materialization config; 3 deferred daemon-coverage e2es).
