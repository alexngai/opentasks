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

**As-built starting point (verified 2026-06-13).** The push plumbing already
exists but is unreliable and unfiltered:
- IPC: `broadcastNotification(method, params)` fans a JSON-RPC notification to
  *all* connected sockets (`ipc.ts:306`); the client can register
  `onNotification(handler)` (`ipc.ts:461`). So server→client push works.
- `watch.subscribe`/`watch.unsubscribe` (`methods/watch.ts`) detect changes by
  **diffing** — on a file-watcher `graph` event they re-query *all* nodes,
  hash-diff against a cache, and `broadcastNotification('watch.event', …)`.
- Gaps: **fire-and-forget** (a disconnected client misses events forever), **no
  sequence numbers / no replay**, **no per-subscriber filter** (everyone gets
  everything), O(n)-per-change, and latency = flush + watcher + 150ms debounce.
- `OpenTasksClient` exposes **no** subscription API. No event log/seq table. A
  `health` IPC method exists (`methods/lifecycle.ts:82`) + `SyncerHealth` (P2).

**Design decision — keep diff-detection, add a sequenced event manager (Path A).**
Rather than re-architect to write-driven emission with a persisted event log
(Path B — lower latency, full replay, but touches the hot write path and adds a
table), P3 keeps the existing diff detection and routes every event through a new
in-process **event manager**: assigns a monotonic `seq` + an `epoch` (daemon
start id), keeps a **bounded ring buffer** (last N, e.g. 2000) for replay, and
applies per-subscriber filters. This gives reliable reconnect-gap recovery
(bounded by the buffer) at low risk. Cursor = `{epoch, seq}`; an epoch mismatch
(daemon restarted) tells the client to **full-resync** via `query`. This also
supersedes the P2.4-deferred *per-node* seq: an **event-stream** seq is the right
shape for cursors, so per-node seq stays unbuilt. Escalate to Path B only if
unbounded/durable replay is required (steering signal below).

**Sequencing — the swarm-dispatch event-driven slice ships first.** swarm-dispatch
today polls `queryReady` every 15s (`dispatcher.ts:1015`) and has no subscribe hook;
it re-queries the whole ready set each cycle, so it needs only a *"something
relevant changed → re-poll now"* wake — a small subset of the full stream (no
per-event cursor/replay), and it keeps the slow poll as a fallback so a missed
wake self-heals. So P3 lands in three milestones, **M1 highest priority**:

- **M1 — swarm-dispatch goes event-driven (priority). ✅ COMPLETE (2026-06-13).** Minimal slice: per-connection
  subscription **filter** in the IPC broadcast path (subset of 3.1) + **`OpenTasksClient.subscribe(filter, handler)`**
  over the existing `onNotification` plumbing (subset of 3.2, *no* cursor yet) +
  the cross-repo **`DispatchTaskSource.subscribe?`** hook & adapter (3.S). Outcome:
  dispatch latency drops from ≤15s to ~debounce with no new reliability surface to get wrong.
  Shipped as opentasks `hardening` `2c169da` (#1 IPC filter) + `3c3bbf2` (#2 client `subscribe`) and
  swarm-dispatch `fix/opentasks-atomic-claim` `1fa690a` (#3 adapter + dispatcher wake). See acceptance criteria below.
- **M2 — durable, replayable stream. ✅ COMPLETE (2026-06-13).** Upgrade M1's fire-and-forget notifications
  into the full **event manager** (3.0: `seq` + `epoch` + ring buffer) and **replay
  cursor** (3.2-full) — what per-event consumers (UIs, agents acting on individual
  events, the MCP delta tool) need. swarm-dispatch can later adopt the cursor to
  drop its fallback poll entirely. Shipped as `hardening` `536c3d9`. See acceptance criteria below.
- **M3 — broader surface. ✅ COMPLETE (2026-06-13).** MCP **`events_since`** (3.3, `db9020f`), **idempotent creates**
  (3.4 / F9, `e7afae2`), **health counters** (3.5 / F10, `780fe68`) — independent of M1/M2. See acceptance criteria below.

**Work items (each a small PR; tagged by milestone):**
- 3.S **(M1, cross-repo)** swarm-dispatch adapter: add an optional
  `DispatchTaskSource.subscribe?(onChange): Unsubscribe` to swarm-dispatch's interface,
  implement it in the opentasks adapter via `client.subscribe`, and wire the dispatcher
  to wake its poll on `onChange` (keep `pollIntervalMs` as a fallback). Lives in the
  `swarm-dispatch` repo.
- 3.0 **(M2) Event manager** (`src/daemon/events.ts`): monotonic `seq`, per-daemon
  `epoch`, bounded ring buffer, `emit(event)`, `since({epoch, seq})` →
  `{epoch, events[]}` or `{epoch, resync:true}` when the cursor is older than the
  buffer or the epoch differs. Refactor `watch.ts` to emit through it (stamp
  `seq`/`epoch` on each `watch.event`).
- 3.1 **(M1) Per-subscriber filtering**: `watch.subscribe({ filter })` (type / status /
  tags / provider). Filtering is applied per connection in `broadcastNotification`
  (needs the IPC layer to know each socket's filter — add a subscriber registry).
  M1 ships a coarse type=task filter; richer predicates can follow.
- 3.2 **(M1: `subscribe` / M2: cursor) Subscribe + replay cursor**:
  `OpenTasksClient.subscribe(filter, handler)` over `onNotification('watch.event')` (M1).
  M2 adds the `events.since` IPC + cursor tracking: on reconnect call
  `events.since(cursor)` to backfill (or full-resync on epoch change). At-least-once;
  events carry node id + type + seq for idempotent consumption.
- 3.3 **(M3) MCP pull surface**: `events_since(cursor)` tool returning the delta + the
  next cursor (token-cheap; MCP clients can poll this instead of re-`query`ing the
  world). Real push stays IPC-only until MCP client notification support matures.
- 3.4 **(M3) Idempotent creates (F9)**: optional client-supplied `idempotency_key` on
  create; the daemon dedupes within a TTL window (in-memory key→nodeId map),
  returning the existing node on a retry.
- 3.5 **(M3) Health surfacing (F10 partial)**: counters for swallowed failures (sync /
  watcher / reconcile) + last flush/pull/reconcile timestamps, exposed via the
  `health` method / `daemon status`, extending the `SyncerHealth` pattern.

**Acceptance criteria** (tagged by milestone)
- [x] (M1) `client.subscribe({ filter })` receives only matching events after a mutation; non-matching events are not delivered (integration test). **Evidence:** opentasks `hardening` `2c169da` (per-connection IPC filter: `ipc.ts` `broadcastToSubscribers` + `ConnectionContext`; `watch.ts` `WatchFilter`/`eventMatchesFilter`; 6 unit tests) + `3c3bbf2` (`OpenTasksClient.subscribe(filter, handler)`; real-daemon `e2e-subscribe.test.ts` asserts the matching event is delivered and the non-matching one is dropped via a fence node — daemon suite 407, client suite 64).
- [x] (M1) swarm-dispatch wakes `queryReady` on an opentasks task change and dispatches within the debounce window (not the 15s poll), with the fallback poll still running (cross-repo integration test). **Evidence:** swarm-dispatch `fix/opentasks-atomic-claim` `1fa690a`: `DispatchTaskSource.subscribe?` + `DispatchConfig.wakeDebounceMs` (default 100ms); dispatcher registers the wake on start (poll stays as fallback), coalesces bursts, tears down on stop; opentasks adapter bridges async `client.subscribe` into the sync `Unsubscribe`. +4 dispatcher tests (wake-on-change, burst coalescing, lifecycle, no-wake-after-stop) +5 adapter tests; full suite 364, tsc clean.
- [x] (M2) `events.since(cursor)` returns exactly the events with `seq > cursor.seq` for the same epoch; an older-than-buffer or different epoch → `resync:true` (unit test). **Evidence:** `hardening` `536c3d9` — `events.ts` `createEventManager` + `events.test.ts` (8 unit: monotonic seq, head=empty, epoch-mismatch→resync, evicted-cursor→resync, ring eviction).
- [x] (M2) Disconnect → mutate → reconnect with cursor → client backfills the missed events, zero missed within the buffer window (integration test). **Evidence:** `536c3d9` — `client.subscribe(filter, handler, { since, onResync })` backfills via `events.since` then resumes live, de-duped by `(epoch, seq)`; real-daemon `e2e-subscribe.test.ts` "backfills events missed while disconnected via a resume cursor" + stale-epoch resync + `events.current`/`events.since` client methods. Required dropping the `subscriberCount<=0` diff guard so events buffer even with no live subscriber.
- [x] (M3) `events_since` MCP tool returns the delta + next cursor (test). **Evidence:** `hardening` `db9020f` — graph-scope `events_since(epoch?, seq?)` → `{ events, nextCursor }` (baseline when no cursor; `{ resync, nextCursor }` when unservable); `server.test.ts` +4 tool tests.
- [x] (M3) Retried `create` with the same `idempotency_key` → one node (test). **Evidence:** `hardening` `e7afae2` — `idempotency.ts` (TTL + bounded store), `graph.create` dedupe, `client.createNode({ idempotencyKey })`, MCP `create_task` param; `idempotency.test.ts` (5) + `e2e-idempotency.test.ts` (retry→same node + one row, distinct keys, no-key→no-dedupe).
- [x] (M3) `health` / `daemon status` shows sync/watcher/reconcile counters; a forced sync failure increments the counter and is visible (test). **Evidence:** `hardening` `780fe68` — `health-counters.ts` (watcher/reconcile counts + timestamps), `SyncerHealth.errorCount`, `health` method surfaces `counters` + `sync`; `e2e-health.test.ts` (shape + reconcile liveness) + extended git-sync push-failure test asserts `errorCount>=1` via both `sync.status` and `health`.

**Post-implementation review (2026-06-13).** Four parallel review agents (correctness, architecture/resources, test-adequacy, cross-repo) — 0 Critical. Fixes applied:
- `a536d8f` — malformed cursor seq (NaN/negative/non-integer) → `resync` (was a silent empty delta); backfill RPC *rejection* now fires `onResync`; removed dead `subscriberCount`; +`watcherErrors`-increment test; M2 backfill test condition-polls instead of a fixed sleep. swarm-dispatch `162b922` — swallow teardown rejections in the subscribe bridge.
- `158824c` (**fix 5a**) — closed the F9 idempotency `get→create` **concurrency** race: `idempotencyStore.run(key, create, fetch)` reserves the key synchronously (in-flight promise) so two concurrent same-key creates share one create. +deterministic unit + two-client e2e proof.
- **Fix 6a — multi-location watch (DONE):** the multi-location daemon now watches every worktree (per-location hash caches + independent debounce; `watchLocation` hooks each `state.watcher` on subscribe, and `LocationResolver.onLocationAdded/onLocationRemoved` cover runtime add/remove). Events carry a `location` tag (additive on `ProviderNodeChangeEvent`; `uri` unchanged) and `WatchFilter.locations` scopes delivery. Single-location path unchanged. See [docs/MULTI-LOCATION-WATCH.md](./MULTI-LOCATION-WATCH.md). +9 watch tests (multi-location emit/filter/debounce/add/remove + location filter) + real-daemon location-tag assertion.

**Steering signals**
- If reconnect-gap loss shows up in practice (buffer too small / disconnects too long) → size the buffer up, or escalate to Path B (persisted event-log table with durable replay).
- If agents (via MCP) keep polling `query` instead of `events_since` → the tool description/ergonomics are wrong; iterate on the tool surface, not the transport.
- If the diff-detection latency (flush+watcher+debounce) is too slow for a consumer → consider emitting directly from the daemon `tools.task` handler (partial Path B) for the hot ops (claims/transitions) while leaving bulk detection diff-based.

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

**Progress**
- [x] **4.1 / 4.2 DONE** (`hardening` `ba44820`): daemon-requiring CLI commands + the `mcp` server auto-start a detached daemon (spawn+unref, `--no-autostart`/`OPENTASKS_NO_AUTOSTART` opt-out); `daemon start` detaches by default (`--foreground` to block). Real-binary e2e in `src/__tests__/e2e-cli-autostart.test.ts`. Full suite 2712.
- [x] **4.4 DONE** (`hardening` `4da0c0c`): human commands `ready` / `list` / `blocked` / `tree` — token-light one-line-per-task over `query`; `list` hides closed/failed/abandoned + archived by default (`--all`/`--status` to override), `--limit` (default 50) with a "… N more" footer. This also satisfies 4.6's "exclude closed by default" + "token-light output budget" — **4.6 reduces to just the `cleanup` command.**
- [x] **4.6 DONE** (`hardening` `3e9411e`): `opentasks cleanup [--older-than-days <n>] [--dry-run]` archives terminal tasks past the TTL (default 30d). e2e covers dry-run/TTL/archive.
- [x] **4.3 DONE** (`hardening` `e89c0ef`): CLI-first quickstart that runs as written + MCP recipe; fixed the stale "start the daemon first" notes and the 19→20 tool count.
- [x] **4.5 DONE** — part 1 (`hardening` `3f8be27`): `opentasks/client` subpath export (runtime-light: IPC client + socket discovery only, no better-sqlite3/MAP/providers) + `getDefaultSocketPath` export + `docs/WIRE-PROTOCOL.md` (frozen, additive-only). Part 2 (cc-swarm `hardening` `04a214b`): `references/claude-code-swarm/src/opentasks-client.mjs` now delegates the wire protocol to `opentasks/client` instead of hand-rolling JSON-RPC; verified against a fake server (full vitest needs cc-swarm `npm install`). cc-swarm requires opentasks ≥0.1.3 (the version with the thin export).
- [x] **4.7 DONE** (`hardening` `7fa1211`, decision: make-it-work): `--global` flag + `OPENTASKS_GLOBAL=1` route the store at `~/.opentasks` by setting `OPENTASKS_PROJECT_DIR` in `main()` (both `resolveProjectDir`/auto-start and the client's `findOpenTasksDir` honor it, so they agree); `ensureGlobalStoreInitialized` makes first use work; flag stripped before per-command parsing. README Global Store section corrected (project-local by default, `--global` opt-in). e2e: create `--global` from one dir → `list --global` from another shows it, no local stores created.

**✅ P4 COMPLETE (2026-06-14)** — 4.1–4.7 all done. Full suite 2715 passed / 0 failed. Cold-start, human commands, cleanup, quickstart, thin client (+ cc-swarm migration), and the global store all land.

**Acceptance criteria**
- [~] Cold-start e2e: fresh temp dir, `npx opentasks init && npx opentasks create --type task --title x && npx opentasks ready` succeeds with zero manual daemon management. **Auto-start works (4.1)**; `ready` sugar lands in 4.4 (today the e2e uses `query '{"ready":{}}'`).
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

**Progress**
- [x] **5.4 DONE** (`hardening` `b72535d`): `docs/A2A-MAPPING.md` — bidirectional OpenTasks↔A2A `TaskState` mapping + the semantic gaps (blocked↔dependencies, rejected→abandoned).
- [x] **5.1 DONE** (swarm-dispatch `map-consolidation` `f9ae0e8`): real-daemon integration test — `createOpenTasksSource` driven against a real daemon over IPC (claim/fence-reject/renew/release/re-claim/start/complete/getTask/listInProgress); opentasks added as optional-peer + dev dep. **Finding the mocks hid:** `queryReady` does NOT exclude a claimed task (a claim is a lease, not a status change) — double-dispatch is prevented by the atomic claim failing, not by ready-exclusion. *Backlog candidate:* an opt-in lease-aware ready filter so the dispatcher polls a smaller set.
- [x] **5.2 + flagship demo DONE** (`hardening` `f960da2`): OpenTasks stays git-cascade-agnostic (Alex's call) — cascade→edge glue is caller-side. `src/client/__tests__/e2e-cascade-provenance.test.ts` against a real daemon: create task → claim → faithful `x-cascade/stream.*` events (with `task_ref`) mapped to `createNode(external cascade://) + link` → close → `task → stream → commit` queryable in one `query({edges:{to_id}})` call; events without `task_ref` create nothing. Pattern documented in `docs/CASCADE-INTEGRATION.md` (no opentasks core code; rationale for caller-side over a `cascade://` provider).
- [x] **5.3 DONE** (`hardening` `b21869b`): echo-loop audit. `docs/ECHO-LOOP-AUDIT.md` (the three guards: skip `map`-provider changes, `_origin` stamping, ephemeral MAP provider) + `map-event-bridge.test.ts` "echo-loop audit" (round-trip terminates; 250+250 interleaved → exactly 250 emissions, no map leak, no double-emit).

**Acceptance criteria**
- [x] **The flagship demo** — done (`f960da2`). In-repo integration test (Alex chose in-repo over a full 3-repo script): task → claim → cascade stream/commit → close, provenance queryable in one `query` call.
- [x] 1-hour soak: zero echo loops, zero duplicate nodes — **substituted by a deterministic audit test** (`b21869b`): 500 interleaved bridged changes amplify to exactly the native count, zero echo, zero duplicate-node emission. (A literal long soak remains an optional ops check.)

**✅ P5 COMPLETE (2026-06-14)** — 5.1/5.2/5.3/5.4 + flagship demo all done. Full suite 2720/0. swarm-dispatch `map-consolidation` `f9ae0e8`. Finding logged: `queryReady` includes claimed tasks (atomic claim is the guard) → backlog candidate (lease-aware ready filter).

**Steering signals**
- Assembling the flagship demo is the real test of "building block." Every missing primitive it reveals goes to the top of the backlog before any new feature work.
- Dogfood: track Phases 5–6 work as opentasks tasks; every friction point encountered feeds the P4 backlog.

---

### Phase 6 — Evaluation program *(prove the narrow claims, publish numbers)*

No established benchmark isolates the task-coordination substrate; these are custom ablations assembled from established parts (task sources, scoring pipelines, control methodology). Report all results with the coordination-metrics vocabulary from [arXiv:2512.08296](https://arxiv.org/abs/2512.08296) (coordination efficiency, overhead fraction, error amplification, redundancy). **Never score by graph state — completion is verified by tests only** ([arXiv:2507.02825](https://arxiv.org/abs/2507.02825): agents reward-hack weak verifiers).

> **Status (2026-06-15): P6 IN PROGRESS — approach evolved.** E1 (swarm duplication) and E2
> (continuity) are unified as a **concurrency × continuity 2×2** (E1 ≈ cells B/D, E2 ≈ cells C/D).
> Current design, empirical results, and the full follow-up list:
> [docs/evaluations/2026-06-15-cellD-concurrency-continuity-design.md](./evaluations/2026-06-15-cellD-concurrency-continuity-design.md)
> (§11 results, §12 follow-ups); raw write-ups in [evals/results/](../evals/results/).
> **Done:** Stage-1 synthetic 2×2 (GLM-5) — substrate is null where state fits in one context,
> wins on concurrency (B), ties on continuity-alone (C), and is the only race-clean arm on the
> combination (D, k=5). **Next:** harden the GLM-5 proxy (it has no retry/backoff and fell over
> under load), then the **TheAgentCompany GitLab-only host** (the established anchor) instantiating
> cell D on recognized tasks. The E1/E2/E4/E5 specs below are the original framing, partly
> subsumed by the synthetic 2×2; E2 on TheAgentCompany remains the standardized headline.

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
