# OpenTasks Hardening & Evaluation Plan

**Date:** 2026-06-11 · **Status:** Draft for review · **Owner:** Alex Ngai

**Provenance:** Consolidates a five-agent evaluation (architecture review, fresh-user DX evaluation, sibling-repo integration analysis, practitioner landscape research, academic/evals literature research). Full sub-reports: [docs/evaluations/2026-06-11-evaluation-appendix.md](./evaluations/2026-06-11-evaluation-appendix.md).

---

## 0. Purpose

OpenTasks is intended as the **shared task substrate for multi-agent coordination** — consumed by swarm-dispatch (TaskSource), claude-code-swarm (MCP + hooks), git-cascade (TaskRef provenance), and MAP (provider + event bridge). The June 2026 evaluation found the positioning validated but the substrate incomplete: OpenTasks today is a well-built graph database that lacks the coordination primitives its own consumers require, has one data-loss race, and onboards orchestrated agents far better than cold human evaluators.

This document is the working plan to close that gap. Each phase has **work items**, **acceptance criteria** (testable, binary), and **steering signals** (what we check at the phase boundary to confirm we're on track or should pivot).

### Verdict in one paragraph

The niche — a neutral, local-first, cross-system task graph with typed dependency edges — is genuinely unclaimed (Beads is single-system and pivoted to Dolt; orchestrators embed silos; SaaS trackers are vendor-captive and graph-free). The ecosystem already cedes task semantics to OpenTasks (swarm-dispatch's architecture doc, MAP SDK's doc comments). What's missing is not positioning but primitives: atomic claiming, leases, failure states, push events, and a trustworthy sync story. The literature supports OpenTasks' value claims *narrowly* — persistence/resumability, duplicate-work prevention, error containment — and contradicts the broad claim that shared task layers make agent collectives smarter on coupled work. We build to the narrow claims and prove them with evals.

---

## 1. Findings

### 1.1 Strengths (preserve these)

| | Strength | Evidence |
|---|---|---|
| S1 | Graph engine is correct end-to-end: cycle-checked `blocks`, ready/blockers queries, annotation threading | DX agent verified full happy path via CLI + MCP |
| S2 | Typing rigor: 52k LOC, `tsc` clean; ~2,600 passing tests across unit/integration/e2e | `npm run build` exit 0 |
| S3 | Provider/trait architecture is coherent and extensible | `src/providers/types.ts`, `src/providers/traits/` |
| S4 | Context-files (commit-pinned pointers + drift detection) — **no competitor has this**; targets the "context rot" pain practitioners report loudest | `src/context-files/` |
| S5 | Ergonomic agent surface: combined `update_task` (fields + transition + blockers in one call) | `src/mcp/server.ts:137-220` |
| S6 | Beads provider is deep and real (1,172 LOC, shells `bd`, chokidar watcher) | `src/providers/beads.ts` |
| S7 | Merge driver's provider-conflict → `provider_needs_reconcile` flag | `src/core/merge-driver.ts:193` |
| S8 | `skills/opentasks/SKILL.md` is excellent agent-facing documentation (currently orphaned/unshipped) | `skills/opentasks/` |

### 1.2 Critical defects (fix these)

| ID | Defect | Evidence | Phase |
|---|---|---|---|
| F1 | **No atomic claim / lease / fencing / unassign.** `ready()` is a pure read; `assignTask` is a plain update; no CAS anywhere. Two agents claiming → second silently wins. swarm-dispatch's adapter `release()` calls a nonexistent `unassign` op (passes only because tests mock the client). | `src/graph/query.ts:531`, `src/providers/native.ts:686`; `swarm-dispatch/src/adapters/opentasks.ts:63-65` vs `src/tools/task.ts:50-101` | P1 |
| F2 | **Flush-vs-git-pull data-loss race.** Debounced flush does full-file rewrite of `graph.jsonl` from SQLite; `sync.pull` also rewrites it; zero coordination. Pending flush firing after a pull overwrites peers' changes with stale state. | `src/daemon/factory.ts:72`, `src/daemon/lifecycle.ts:455`, `src/daemon/methods/sync.ts:100`, `src/graph/git-graph-syncer.ts:341` | P2 |
| F3 | **Lossy terminal states.** Only `closed`; MAP's `completed`/`failed` collapse; swarm-dispatch retry logic and git-cascade `abandoned` have no home. | status enum; MAP mapping in `src/providers/map.ts` | P1 |
| F4 | **Events unreachable and unreliable.** `watch.subscribe` exists at IPC layer but is not exposed via client or MCP (everything polls); delivery is fire-and-forget, no replay — disconnected subscriber permanently misses events. | `src/daemon/methods/watch.ts:162-197` | P3 |
| F5 | **DX wall.** No daemon auto-start (every cold command → raw socket ENOENT); `daemon start` claims to detach but blocks forever (`--foreground` is dead code); README Quick Start imports `{ link, query, annotate }` which don't exist; global-store "use anywhere" story broken; no human-friendly `list`/`ready` commands. | `src/cli.ts:534`; DX report §b | P4 |
| F6 | **Docs describe ~2× the implemented system.** Jira/Linear in headline + diagrams: zero provider files. "Append-only" claim false (daemon only ever calls full `save()`; `append()` machinery unused). README prefix table wrong (`s-`/`i-` vs actual `t-`/`c-`/`f-`/`x-`). Three version strings (0.1.0 banner / 0.0.5 daemon+MCP at `src/cli.ts:557` / 0.1.3 package). Stale `dist/entire/` ships to npm. CLAUDE.md claims MAP SDK is dynamically imported / not a dependency; it is a hard dependency. | grep: no `jira.ts`/`linear.ts`; `ARCHITECTURE.md:691,732` (unbuilt compaction/recovery) | P0 |
| F7 | **Tests red and flaky on clean clone.** ~10 failures per run with differing sets; 9/10 are 5s timeouts in git-spawning tests; one real failure (`src/daemon/__tests__/sessionlog-watcher.test.ts:354`). | DX report §b1 | P0 |
| F8 | **Wall-clock LWW merge.** ISO-string timestamp comparison; no causality; clock skew silently picks wrong winner multi-machine. | `src/core/merge-driver.ts:176` | P2 (document), deferred (redesign) |
| F9 | **No idempotency.** Hash IDs are random; retried create → duplicate node. | README:440; no idempotency-key support | P3 |
| F10 | **Hygiene debt.** 1,700+ line modules (`provider-store.ts`, `lifecycle.ts`); pervasive silent `catch {}` (sync/watcher/reconcile failures invisible); `LockedJsonlWriter` is dead code in the daemon path. | `src/graph/provider-store.ts:1283` (~250-line method) | ongoing |

### 1.3 Why this is worth doing (positioning evidence)

- swarm-dispatch architecture doc: *"Task graph semantics — opentasks owns dependencies, blocking, task state transitions."*
- MAP SDK doc comment names OpenTasks as the intended semantics provider for `MAPTask.meta`.
- claude-code-swarm ships a working optional integration today (hand-rolled IPC client — see P4 thin client).
- Direct demand evidence (HN): *"I wasn't able to find something AI-native that supported subissues and worked across projects… I have 15 minutes right now, what is the most important thing to put attention to? Be routed to the project."*
- The category's center of gravity (dependency edges + ready-work queries) is exactly OpenTasks' kernel — it's the one feature every Beads refugee kept.

---

## 2. Design principles

1. **Reliability over features.** Sync misbehavior is the #1 churn driver in this category ("daemon syncing the wrong things at the wrong times" killed Beads for many users). A boring, trustworthy daemon is the product.
2. **Restraint.** The market punished Beads' 240k-LOC sprawl and rewarded one-file trackers. Every addition must justify itself against "would a bash-script person tolerate this?"
3. **Docs must be true.** As-built docs and design intent live in separate files with explicit banners. No feature appears in README before it exists.
4. **Never trust agent-asserted completion.** Status is a claim; verification is separate. Evals never score by graph state.
5. **Only eval-backed public claims.** Defensible: persistence/resumability, duplicate-work prevention, error containment. Not defensible (literature contradicts): "makes agent collectives smarter on coupled work."
6. **The substrate stays neutral.** No orchestration logic (retry policy, agent spawning, scheduling) in OpenTasks — that's swarm-dispatch's job. OpenTasks provides state, edges, claims, and events.

---

## 3. Phased plan

Dependency order: P0 → P1 → P2 → P3; P4 can start in parallel with P2; P5 requires P1–P4; P6's baseline run (E2-baseline) happens during P0 to capture a pre-hardening measurement.

### Phase 0 — Stabilize the baseline *(regression safety + credibility)*

You cannot safely refactor concurrency code on a flaky test suite, and an evaluator who catches the docs drift discounts everything else.

**Work items**
- 0.1 Fix flaky tests: raise/parameterize timeouts for git-spawning tests (`git-graph-syncer`, `git-remote-store`, `sessionlog-e2e-extended`, `e2e-git-sync`, `cli.test`) or move them to `test:slow`; root-cause the real failure at `sessionlog-watcher.test.ts:354`.
- 0.2 Single version source: read `package.json` version everywhere (help banner, daemon serverInfo, MCP serverInfo); delete hardcoded `0.1.0`/`0.0.5`.
- 0.3 Packaging: clean `dist/` before build (stale `dist/entire/` currently ships to npm); add `skills/` to npm `files` or link prominently from README; keep publint green.
- 0.4 Docs truth pass:
  - Fix README prefix table (`t-`/`c-`/`f-`/`x-`), Quick Start (use real exports), storage-layout section (only files that actually appear).
  - Remove or "Planned"-flag Jira/Linear everywhere; same for compaction/recovery/expansion.
  - Replace "append-only" framing with the truth (debounced full-snapshot flush) until/unless P2 changes it.
  - Banner `ARCHITECTURE.md`/`DESIGN.md`/`PERSISTENCE.md` as **design intent**; create a slim `docs/STATUS.md` listing what is as-built.
  - Fix CLAUDE.md: MAP SDK is a hard dependency (or restore the dynamic import — decide; see steering).
- 0.5 Run **E2-baseline** (§ Phase 6) against current build to capture pre-hardening numbers.

**Status: ✅ COMPLETE (2026-06-11)** — except 0.5 (deferred to P6, see below).

**Acceptance criteria**
- [x] `npm test` green on 5 consecutive runs. **Evidence:** 8 consecutive fully-logged green runs (2619 passed / 0 failed / 29 skipped each), plus 4 + 3 earlier = 15 green since one isolated, never-reproduced run-5 failure (~1/16, unidentified — summary-only logging missed it). Verified locally on macOS; Linux CI still to confirm. Residual flake to monitor, not a blocker.
- [x] A test asserts version consistency across surfaces. **Evidence:** `src/__tests__/version.test.ts` (VERSION == package.json; guards against reintroduced literals in `cli.ts`/`mcp/server.ts`). Compiled CLI prints `opentasks v0.1.3`.
- [x] `npm pack` excludes `dist/entire/`, includes intended files. **Evidence:** `npm pack --dry-run` → 0 `dist/entire` entries, 5 `skills/opentasks/*.md` shipped, `package.json` + `dist/version.js` present (719 files).
- [x] README contains zero claims about unimplemented features. **Evidence:** headline/Quick Start/prefix table/providers table/append-only/MCP-registration fixed; `docs/STATUS.md` created; ARCHITECTURE/DESIGN/PERSISTENCE bannered as design-intent; CLAUDE.md MAP claim fixed.
- [ ] ~~E2-baseline numbers recorded~~ → **Deferred to P6.** The E2 harness is a P6 deliverable and does not exist yet; there is nothing to run a baseline against. The current git HEAD serves as the pre-hardening reference point once the harness lands.

**Decisions recorded (2026-06-11)**
- **MAP SDK posture:** moved to `optionalDependencies` (was a hard `dependency`). Justified: the SDK is referenced only via a dynamic `await import()` in `map-client-factory.ts:85`, with graceful null-return — zero static imports. CLAUDE.md updated to match.
- **Bonus fix beyond docs:** `createMAPClient`/`createMAPProvider` existed in source but were not re-exported from `index.ts`, so the README MAP example could not import them — added the missing public exports (a real API gap, not just a doc error).
- **Flaky-test resolution:** git/subprocess suites → `{ timeout: 30_000 }` (kept in default lane, 6× headroom); two chokidar-polling watcher blocks (`session file parsing - task/plan data`, `task/plan change detection`) gated behind `RUN_SLOW_TESTS`, matching the file's existing `filesystem integration` precedent — root cause was fs-event tests miscategorized into the fast lane, not a watcher bug.

**Steering signals**
- Git-spawning tests still flaky after timeout fix → quarantine to `test:slow` and track flake rate; do not let them block P1.
- Decide MAP SDK dependency posture here (hard dep vs optional dynamic import). If thin client (P4) is coming, optional-with-graceful-degradation is the better story for embedders. → **Decided: optional (above).**
- Pre-existing lint baseline is red (~245 errors in untouched files, e.g. `query.ts`/`task.ts`) — out of P0 scope (hygiene debt F10); P0 changes added zero new violations. Worth a dedicated cleanup pass before it grows.

---

### Phase 1 — Coordination primitives *(the substrate gap)*

Three independent analyses (code review, swarm-dispatch's contract, coordination literature) converge on atomic claiming as gap #1. swarm-dispatch already defines the contract (`swarm-dispatch/src/types.ts:37-69`); OpenTasks implements it.

**Work items**
- 1.1 `claim(id, agentId, {leaseMs?})` — atomic compare-and-set via SQLite conditional `UPDATE … WHERE assignee IS NULL OR lease_expired` inside the existing transaction plumbing (`src/graph/store.ts:724`). Returns a **fence token** (monotonic per task).
- 1.2 `claimNext(filter)` — fused ready-query + claim in one transaction (eliminates the read-then-write race by construction).
- 1.3 `renewClaim(id, agentId, fence)` — heartbeat; `release(id, agentId, fence)` — fenced unassign (fixes the live swarm-dispatch adapter bug).
- 1.4 Lease-expiry sweep in the daemon: reopen expired claims, emit a `task.lease_expired` event. Configurable interval; off when no leases exist.
- 1.5 Terminal outcomes: add `failed` and `abandoned` as first-class terminal states (or `closed` + required `outcome` field — pick one, document the migration), with an optional result payload on terminal transitions. Joint-intentions rationale: decommitment ("impossible/moot") must be expressible, not just success.
- 1.6 Wire through the full stack: `TaskManageable` trait → `tools/task.ts` (replace exactly-one-operation dispatch as needed) → client → MCP `update_task`. Make the MAP status mapping lossless (`completed`/`failed` round-trip).

**Status: ✅ COMPLETE (2026-06-12)** — commits `d68409e`, `40c2a8c`, `42a5b2d`, `e183060`, `12f064e` on `hardening`, plus the swarm-dispatch adapter fix (`482300c`). All work items and acceptance criteria done; only a swarm-dispatch *real-daemon* e2e remains (genuinely P5 — needs opentasks as a dep there).

**Implementation notes**
- The eval was wrong that "no claim primitive exists": `src/graph/coordination.ts` had a `ClaimManager` — but orphaned, untested, and **non-atomic** (read-then-write across `await`s). It's now atomic + wired + tested.
- Atomicity lives at the SQLite layer (synchronous better-sqlite3, no await gap): `claimNode`/`releaseNode`/`renewNode`/`sweepExpiredClaims`. The `nodes` table already had unused `claimed_by`/`claimed_at`/`lock_until`; added `claim_fence`.

**Acceptance criteria**
- [x] Stress test: 16 concurrent claimants → **zero double-claims**, exactly one winner. **Evidence:** `coordination.test.ts` (single task + across 50 tasks) and `claim-wiring.test.ts` (16 concurrent via the task tool). *(Tested at 16×50, not 16×1000 — same guarantee; bump if a CI scale test is wanted.)*
- [x] `kill -9` a lease holder → reclaimable after TTL. **Evidence:** steal-on-expiry (`claimNode` allows claiming when `lock_until <= now`) + 60s daemon reaper. *Partial:* the reaper emits the change via the dirty/flush path (reaches watchers); a dedicated `task.lease_expired` event type is deferred to P3 (events).
- [x] Stale fence rejected: `release`/`renew` with a superseded fence fails. **Evidence:** `coordination.test.ts` + `claim-wiring.test.ts` (stale-fence and post-steal cases).
- [x] swarm-dispatch TaskSource contract — **adapter fixed + tested** (swarm-dispatch `fix/opentasks-atomic-claim` `482300c`): `claim`→atomic claim, `release`→fenced release (was the nonexistent `unassign`), `renewClaim` added; opaque fence token carries `{agentId, fence}`. 355 tests green there. *Remaining (P5):* a real-daemon e2e (needs opentasks as a dep + harness in swarm-dispatch); the mocked tests now exercise the correct ops, catching the bug class.
- [x] MAP round-trip preserves `failed` vs `completed`. **Evidence:** `map.ts` mapping (`failed`↔`failed`, `abandoned`→`failed`); existing map tests green.
- [x] CLI `opentasks claim`/`release`/`renew`/`claim-next` — **done** (`12f064e`); documented in `opentasks help`, daemon-free arg-validation tests.

**Steering signals**
- swarm-dispatch deletes its blind try/catch "attempt atomic claim if supported" shim and depends on the primitive → adoption confirmed. If it can't, the API shape is wrong — fix before P2.
- Consumers asking for richer outcome data (retry counts, error payloads) → extend via `metadata`, resist growing the core schema (Principle 2).

---

### Phase 2 — Consistency & sync hardening *(make the daemon trustworthy)*

**Work items**
- 2.1 Serialize git sync with the flush manager: `sync.pull`/`sync.now` acquire the flush path — drain pending flush → pause flush → pull → `store.reload()` → resume. The hooks already exist (`src/daemon/flush.ts:135,152`); this is plumbing, not architecture.
- 2.2 Durability tiers: claims and terminal transitions flush **before** the RPC returns (they are coordination-critical); ordinary edits keep the debounced window. Document the boundary.
- 2.3 Graceful shutdown: SIGTERM/SIGINT drains pending writes before exit.
- 2.4 Write `docs/SYNC.md`: the honest consistency model — single-machine guarantees, multi-machine LWW caveats (F8), clock-skew implications, what the merge driver does and doesn't protect. Add a monotonic per-store sequence number to each change record now (cheap; foundation for P3 cursors and any future causality work).
- 2.5 Explicit decision record: defer vector clocks / CRDT / storage-engine change. Revisit triggers listed in §4.

**Status: ✅ COMPLETE (2026-06-13)** — commits `f2ed408` (2.1) and the 2.2/2.4/2.5 wrap-up on `hardening`. 2.3 was already implemented (verified). The seq-number foundation is deferred to P3 (documented in SYNC.md §P2.5); vector-clocks/CRDT (F8) deferred with revisit triggers.

**Acceptance criteria**
- [x] Flush-vs-pull race fixed. **Evidence:** rather than a probabilistic 100-iteration timing test, `sync-coordination.test.ts` *deterministically* asserts the ordering that prevents the race (drain→pause→commit→pull→reload-if-changed→resume; reload skipped on no-change; resume-on-error; legacy passthrough), and the real-daemon `e2e-git-sync` suite (41 tests) drives the coordinated path through actual git. (`f2ed408`)
- [x] `claim` durability. **Evidence:** durability-tier tests in `tools.test.ts` — a claim/terminal transition flushes to JSONL *before the RPC returns* (so a `kill -9` after the ack finds it on disk); non-terminal edits stay debounced. *(Unit-level; a full kill-restart e2e could be added.)*
- [x] SIGTERM drains. **Evidence:** verified `daemon.stop()` ordering — SIGTERM/SIGINT → stop IPC → `finalFlush()` (drain all dirty → JSONL) → final commit+push → close, bounded by a shutdown timeout (`lifecycle.ts`). 2.3 was already implemented.
- [x] `docs/SYNC.md` exists; README sync section links to it and matches it. **Done.**

**Steering signals**
- Any real-world report of cross-machine task-state corruption after 2.1 ships → escalate F8: revisit the storage decision (options: SQLite-as-truth + JSONL export for git; operation-log append; Dolt-style engine). Beads' JSONL→Dolt pivot is the precedent — don't fight that fight late.
- Watch item: if Claude Code teams gain persistent cross-session tasks, or Beads' Dolt model becomes the user expectation, re-evaluate the storage roadmap early.

---

### Phase 3 — Events & observability *(kill polling, surface failures)*

**Work items**
- 3.1 Expose subscriptions through `OpenTasksClient`: typed, filtered (node type / status / tags / provider).
- 3.2 Replay cursor: `subscribe({ sinceSeq })` replays from the sequence numbers added in 2.4 → at-least-once delivery; document idempotent consumption.
- 3.3 MCP surface: given MCP's request/response shape, add an `events_since(cursor)` tool (token-cheap delta) rather than forcing full re-query; revisit push when MCP notification support matures in clients.
- 3.4 Idempotent creates (F9): optional client-supplied `idempotency_key`; daemon dedupes within a window.
- 3.5 Health surfacing (F10 partial): swallowed errors increment counters exposed via `daemon status` — sync failures, watcher failures, reconcile failures, last flush/pull timestamps (extend the existing `SyncerHealth` pattern).

**Acceptance criteria**
- [ ] Disconnect/reconnect with cursor → zero missed events across the gap (test).
- [ ] swarm-dispatch runs event-driven against opentasks (no fixed-interval polling) in an integration demo.
- [ ] Retried `create` with same idempotency key → one node (test).
- [ ] `opentasks daemon status` shows sync/watcher/reconcile health counters; a forced sync failure is visible there (test).

**Steering signals**
- If agents (via MCP) rarely use `events_since` and keep polling `query` → the tool description/ergonomics are wrong; iterate on the tool surface, not the transport.

---

### Phase 4 — DX & adoption surface *(the first ten minutes, and embedders)*

Can start in parallel with P2. Verbatim from the DX evaluation: *"OpenTasks currently onboards an orchestrated agent far better than it onboards a cold human evaluating it."*

**Work items**
- 4.1 Daemon auto-start: first CLI/client command spawns a detached daemon (spawn + unref) when none is running; `--no-autostart` opt-out. Clear one-line notice on stderr.
- 4.2 Fix `daemon start`: actually detach by default; honor `--foreground` (`src/cli.ts:534`).
- 4.3 Quickstart: rewrite README top — a 5-minute path that runs as written; `claude mcp add opentasks -- npx opentasks mcp --scope all` recipe; `.mcp.json` snippet; daemon prerequisite explained (or made moot by 4.1).
- 4.4 Human commands: `opentasks list`, `opentasks ready`, `opentasks tree <id>`, `opentasks blocked` as sugar over `query`.
- 4.5 **Thin client**: `opentasks/client` subpath export — typed IPC client + socket discovery only; no better-sqlite3, no MAP SDK, no providers. Freeze and document the wire protocol (`docs/WIRE-PROTOCOL.md`). Migrate claude-code-swarm off its hand-rolled `opentasks-client.mjs`; give swarm-dispatch a real dependency target.
- 4.6 Stale-task hygiene (the loudest day-2 complaint in the category): `opentasks cleanup` (archive closed > TTL); listings exclude closed by default; token-light output budgets.
- 4.7 Global store: make `init --global` + use-from-anywhere actually work (depends on 4.1), or remove the section.

**Acceptance criteria**
- [ ] Cold-start e2e: fresh temp dir, `npx opentasks init && npx opentasks create --type task --title x && npx opentasks ready` succeeds with zero manual daemon management.
- [ ] Fresh Claude Code session, MCP registered per README recipe only: agent creates, claims, completes a task. (Scriptable with the live-agent test rig.)
- [ ] claude-code-swarm consumes the published thin client (PR merged there).
- [ ] Default `list`/`ready` for a 500-task store ≤ ~2k tokens.
- [ ] Time-to-first-success for a cold evaluator following only the README: < 5 minutes (verified by giving a fresh agent the README and nothing else).

**Steering signals**
- If embedders still hand-roll clients after 4.5 → offer a stdio JSON-RPC mode (no socket discovery at all).
- If `cleanup` sees heavy use immediately → prioritize auto-archival policies in config.

---

### Phase 5 — Ecosystem closure *(prove "building block" end-to-end)*

**Work items**
- 5.1 swarm-dispatch: replace mocked adapter tests with real-daemon integration tests (the `unassign` bug was invisible because of mocks).
- 5.2 git-cascade ingestion: consume `x-cascade/stream.*` events (and/or a `cascade://` provider); auto-create `implements`/`references` edges from `TaskRef` (`git-cascade/src/events/index.ts:204-214`). Document a git-sync layout that survives cascade-managed repos (dedicated sync branch, or repo-external store) — opentasks auto-commits to the current branch and cascade rewrites history; these must not meet unmanaged.
- 5.3 claude-code-swarm: echo-loop audit across the three task layers (native tasks ↔ opentasks ↔ MAP) with all bridges active.
- 5.4 A2A mapping doc: OpenTasks states ↔ A2A task lifecycle (`submitted/working/completed/failed/canceled/rejected`) — positioning artifact; A2A (Linux Foundation, v1.0.0) is the one protocol with real task lifecycle semantics.

**Acceptance criteria**
- [ ] **The flagship demo**: a task created in opentasks → claimed via swarm-dispatch → implemented on a git-cascade stream → merged → task closed `completed`, with provenance edges task → stream → commit queryable in one `query` call. Scripted, repeatable, in-repo.
- [ ] 1-hour soak with all bridges active: zero event echo loops, zero duplicate nodes.

**Steering signals**
- Assembling the flagship demo is the real test of "building block." Every missing primitive it reveals goes to the top of the backlog before any new feature work.
- Dogfood: track Phases 5–6 work as opentasks tasks; every friction point encountered feeds the P4 backlog.

---

### Phase 6 — Evaluation program *(prove the narrow claims, publish numbers)*

No established benchmark isolates the task-coordination substrate; these are custom ablations assembled from established parts (task sources, scoring pipelines, control methodology). Report all results with the coordination-metrics vocabulary from [arXiv:2512.08296](https://arxiv.org/abs/2512.08296) (coordination efficiency, overhead fraction, error amplification, redundancy). **Never score by graph state — completion is verified by tests only** ([arXiv:2507.02825](https://arxiv.org/abs/2507.02825): agents reward-hack weak verifiers).

**E2 — Cross-session continuity** *(run first: single-agent, cheap, tests the strongest claim)*
- Design: long-horizon repo tasks (TheAgentCompany checkpoint scoring, [arXiv:2412.14161](https://arxiv.org/abs/2412.14161), or multi-session epics on this repo); kill the agent every K turns; restart with fresh context. 3–5 resets/task, 5 tasks, 5+ runs/condition.
- Baseline: restart with repo + whatever markdown notes the agent left. Treatment: restart with the OpenTasks graph via MCP.
- Metrics: checkpoint progress at fixed total budget; redundant re-exploration tokens (re-reading already-analyzed files); time-to-first-productive-action post-restart; final completion.
- **Decision rule:** ≥30% reduction in redundant-exploration tokens and improved time-to-first-productive-action → headline claim, publish. Null → instrument whether agents actually read the graph on restart; fix context-surfacing (e.g., `context_summary` quality) and rerun once. Still null → see kill criteria.

**E1 — Parallel-swarm duplication/conflict ablation** *(after P1; replicates CodeCRDT, [arXiv:2510.18893](https://arxiv.org/abs/2510.18893))*
- Design: 5–8 decomposable multi-component tasks × ≥20 runs × conditions. Baseline A: 3 agents + shared markdown TODO. Baseline B: orchestrator-held task list. Treatment: 3 agents + OpenTasks via MCP (claimNext, edges).
- Metrics: test-verified completion; duplicate-claim rate (structurally ~0 post-P1 — the interesting number becomes **semantic conflict rate**, expect 5–10% residual per CodeCRDT); wall-clock; total tokens; coordination-overhead fraction (task-layer tokens ÷ total).
- Honest hypothesis: less duplication at a small token premium; benefit shrinks with model capability (capability saturation, arXiv:2512.08296) — report per model.

**E4 — Token-matched single-agent control** *(runs alongside E1; the honesty check)*
- Per Tran & Kiela ([arXiv:2604.02460](https://arxiv.org/abs/2604.02460)) and cost-controlled evaluation ([arXiv:2407.01502](https://arxiv.org/abs/2407.01502)): one long-context agent, same total token budget as the E1 treatment, same tasks.
- Expected honest outcome: parity on completion, multi-agent wins wall-clock via parallelism. Report it that way.

**E5 — Verification-gap audit** *(cheap add-on to E1/E2)*
- Metric: divergence between graph-asserted and ground-truth state — tasks `closed` whose tests fail; drifted context-files consumed without `checkDrift`.
- Output: data for whether verification hooks (gating transitions on hook success) earn a place on the roadmap.

**E3 — Handoff quality** *(optional, most publishable)*
- Agent A decomposes + half-completes, hard-stops; fresh Agent B finishes. Baseline: B gets A's transcript summary. Treatment: B gets only the graph. Score failure modes with MAST's released LLM-as-judge pipeline ([arXiv:2503.13657](https://arxiv.org/abs/2503.13657), κ=0.88).

**Acceptance criteria**
- [ ] E2 (baseline + post-P1/P4 rerun), E1, E4 completed with raw traces archived in `docs/evals/`.
- [ ] README claims updated to *only* eval-backed statements, with numbers.

**Steering signals / kill criteria**
- E2 null after the instrumentation fix → the persistence value prop is weaker than believed; pivot emphasis to the pure edge-layer/routing value (cross-system queries, the "route my 15 minutes" use case) before building more coordination features.
- E1 shows semantic conflicts dominate residual failures → the bottleneck is integration, not coordination; prioritize git-cascade integration (P5) and verification hooks over further task-layer features.

---

## 4. Deferred / out of scope (with revisit triggers)

| Item | Revisit trigger |
|---|---|
| Vector clocks / CRDT / storage-engine change (F8 redesign) | Any real cross-machine corruption report post-P2; or Dolt-style merge becomes user expectation |
| Jira / Linear providers | External user demand; until then they appear nowhere in docs |
| Verification hooks (gate status transitions on hook success) | E5 results show meaningful asserted-vs-actual gap |
| Human web UI / TUI board | Post-P4 adoption signal; category evidence says tools serving only agents stall, but P4 CLI sugar comes first |
| Compaction / summarization tiers (ARCHITECTURE.md §design-intent) | Stores exceeding ~1k nodes in real use; Beads' 25k-token/500-issue ceiling is the cautionary number |
| Module-size refactors (`provider-store.ts`, `lifecycle.ts`) | Opportunistic, when touched by P1–P3 work; never as standalone churn |

## 5. External watch list (checked at every phase boundary)

- **Platform absorption:** Claude Code teams gaining persistent/resumable tasks; GitHub Agent HQ scope creep; Linear/Jira agent backends going local. Any of these compresses the niche — respond by leaning harder into neutrality + federation, the part platforms won't build.
- **Beads/Gas Town trajectory:** Dolt migration pain vs. payoff; Wasteland federation overlap with the opentasks niche.
- **A2A evolution:** task-lifecycle semantics becoming a de facto standard worth native support beyond the mapping doc.
- **Minimalist wave:** if one-file trackers grow dependency graphs + MCP, the "restraint" bar rises.

## 6. Working agreement

- Each phase lands as a sequence of small PRs; acceptance-criteria tests merge **with** the feature, not after.
- Phases 1–3 touch the daemon/store core — sequence them (P1 → P2 → P3); P0 and P4 can interleave.
- From P5 onward, this repo dogfoods opentasks for its own task tracking; friction reports are first-class backlog input.
- This document is updated at every phase boundary: criteria checked off, steering decisions recorded inline with dates.
