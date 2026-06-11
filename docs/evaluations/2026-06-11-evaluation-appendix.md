# OpenTasks Evaluation — Full Sub-Agent Reports (2026-06-11)

Five parallel agent reports backing the synthesis review.

---
## Report 1: Architecture Review (code-level)
I now have a complete, evidence-backed picture. Two key confirmations:

1. **`build: tsc` passes cleanly** (exit 0) — strong typing rigor, no type errors across 52k LOC.
2. **The "append-only JSONL" claim in the README is misleading** — the daemon flush always does a full-file `jsonl.save(nodes, edges)` rewrite (factory.ts:72, location-state.ts:134), never `append()`. The `append`/`appendMany`/`LockedJsonlWriter` machinery exists but is unused by the daemon. So it's a full-rewrite-on-flush model, not append-only.

I have enough to write the report.

---

# OpenTasks Architecture Review

## Summary

OpenTasks is a genuinely well-built single-machine, single-daemon task graph. The core edge-layer abstraction is coherent, the TypeScript is rigorous (52k LOC, `tsc` clean, 3,233 test cases across unit/integration/e2e including a real multi-agent e2e workflow), and the provider/trait system is thoughtfully factored. But it is **substantially over-documented relative to what's implemented**, and — most importantly for its stated goal as a multi-agent coordination building block — **it has no atomic claim primitive, no single-writer guarantee against its own git sync, and a fire-and-forget event model**. The federation, materialization, and reconciliation machinery is real but adds large accidental complexity for a feature set most agent swarms won't use. As a *relationship layer for one developer's machine*, it's solid. As a *coordination substrate for N agents across machines*, the foundational consistency primitives are missing.

---

## 1. Core Abstractions — Coherent, with real leaks

**What's coherent:**
- The split is clean in principle: graph store owns edges + node *references* (`src/graph/store.ts`), providers own node *content* (`src/providers/types.ts:293`). The `Provider` interface plus opt-in traits (`TaskManageable`, `Watchable`, `RelationshipQueryable`, `Reconcilable`) via duck-typed guards (`isTaskManageable` at `traits/TaskManageable.ts:203`) is a sound, extensible design.
- Materialization modes (`cached` vs `pointer`, `types.ts:321`) and the three-stage phantom model for external nodes are well-reasoned.
- The native provider (`native.ts`) is a faithful adapter over the graph store with a real state machine (`validActionsForStatus`, `native.ts:96`).

**Where abstractions leak / accidental complexity:**

1. **Node-type vocabulary is triple-mapped and inconsistent.** The graph uses `'context' | 'task' | 'feedback' | 'external'` (`graph/types.ts:17`). Providers use `'spec' | 'issue' | 'task' | 'feedback' | 'external'` (`providers/types.ts:105`). Two mapping functions bridge them (`native.ts:61` `mapNodeType`, `native.ts:79` `mapProviderType`) and they are not inverses — `mapNodeType('task')→'issue'` but `mapProviderType('task')→'task'` AND `mapProviderType('issue')→'task'`. The README compounds this: it documents node prefixes as `s-`/`i-` (README line 130-135) but the actual `LOCAL_ID_PATTERN` is `/^[ctfex]-/` (`native.ts:47`) — IDs are `c-`/`t-`/`f-`/`e-`. The README's own examples mix `t-x7k9`, `c-a2b3`, and `i-m4n5` inconsistently. This is a vocabulary that drifted and was never unified.

2. **The `external` node type vs. provider-materialized-as-native split is a fork in the core model.** Per `providers/types.ts:304-311`, "local" providers (beads, sudocode, claude) materialize as `type:'task'` with a `provider_uri` back-reference, while "remote" providers (jira, linear) materialize as `type:'external'`. So the same conceptual thing — "a task owned by another system" — has two completely different representations depending on a `local` boolean. Reconciliation, merge, and query code all have to handle both paths.

3. **Storage layer can't index the metadata it depends on.** Per the project's own CLAUDE.md and confirmed in code, `findByProviderUri()`/`findExternalNodeByUri()` must *scan by node type* because SQLite `search` only checks title/content, not the `metadata` JSON column where `provider_uri` lives. This is an index that should exist but doesn't — it's a correctness-via-full-scan workaround.

---

## 2. Implemented vs. Aspirational — Significant gap

**Real and working end-to-end** (verified by reading impls + e2e tests):
- Native provider, graph CRUD, edges, cycle detection on `blocks` (`store.ts:582`), `ready()`/`blockers()` queries.
- **Beads** (`beads.ts`, 1,172 LOC) — real: shells out to the `bd` CLI via `execAsync` (`beads.ts:520`), has a chokidar watcher. This is the deepest external provider.
- **Sudocode** (1,309 LOC) and **Claude Tasks** (798 LOC) — substantial implementations.
- **MAP provider** (`map.ts`) — real RPC pass-through against an injected client (`map.ts:300` `client.listTasks`), genuinely ephemeral.
- Daemon lifecycle, IPC, file watching, git sync, context-files with drift detection.

**Aspirational / not implemented:**
- **Jira and Linear do not exist.** The README headline ("Link Claude Tasks to Beads issues to Jira tickets"), the CLAUDE.md, the mermaid diagrams, and `Provider.local` docs (`types.ts:309`) all reference Jira/Linear. Grep result: **zero provider files**, only mentions in comments, `config/schema.ts`, and type docstrings. The entire `external`-node three-stage phantom model exists to serve providers that haven't been written. This is the single biggest "docs vs. reality" gap.
- **Compaction / tier1/tier2 summarization** — fully specified in `ARCHITECTURE.md:691-723` (LLM summarization, retention tiers) but I found no compaction engine wired into the daemon.
- **Recovery service** (`recoverFromTombstone`, `recoverFromSnapshot`, `recoverFromGit`, `ARCHITECTURE.md:732`) is an interface in docs with no corresponding implementation surfaced.
- **Cross-location query expansion** (`'ancestors'|'descendants'|'siblings'|'all'`, `ARCHITECTURE.md:107`) — the type vocabulary is documented; only `follow-refs`/global-federation paths appear actually wired.

**Net:** the docs describe a product roughly 2x the size of the code. ARCHITECTURE.md, DESIGN.md, and PERSISTENCE.md read as design specs, not as-built documentation, and they aren't marked as such.

---

## 3. Concurrency & Consistency — The weakest area

I traced the write path end to end. Findings, in severity order:

**(a) No single-writer guarantee against the daemon's own git sync — data-loss race.**
The flush path (`store.ts:236` `doFlush` → `jsonlSave` → `jsonl.save()` at `factory.ts:72`) does a **full-file overwrite** of `graph.jsonl` from SQLite state, via atomic temp+rename. Separately, the git syncer does `git pull` which **also rewrites `graph.jsonl`** (`git-graph-syncer.ts:341`). These are **not serialized**. The flush manager pauses only the *file watcher* during its own flush (`lifecycle.ts:455`), and `sync.now`/`sync.pull` (`methods/sync.ts:100,109`) call the syncer directly with zero coordination with the flush manager or store. Concrete failure: a debounced flush is pending (5s window, `factory.ts:77`); `sync.pull` rewrites the file with a peer's changes; the pending flush fires and overwrites the file with SQLite's *pre-pull* state. Pulled native-node changes are silently lost. The reconcile-on-reload (`lifecycle.ts:714`) only re-fetches *provider-authoritative* nodes — native/task nodes are not protected.

**(b) The advisory write-lock infrastructure is dead code in the daemon.** `LockedJsonlWriter`/`FileLock`/`write.lock` (`storage/locked-writer.ts`, `storage/file-lock.ts`) exists and is tested, but grep confirms the daemon never uses it — only `claude-tasks-fs.ts` and `worktree.ts` do. The daemon's sole write-serialization is the single-daemon `proper-lockfile` on `daemon.lock` (`daemon/lock.ts:110`). So the *only* thing preventing concurrent writers is "there's one daemon." A direct `opentasks` CLI write or a `git pull` bypasses that entirely (see (a)).

**(c) Multi-machine = last-writer-wins with a custom merge driver.** The merge driver (`core/merge-driver.ts`) does field-level 3-way merge keyed by `updated_at` string comparison (`fieldLevelMerge:176`). This is genuinely clever — and the provider-authoritative conflict→`provider_needs_reconcile` flag (`merge-driver.ts:193`) is a nice touch. But: ISO-string timestamp comparison has **no causality** (clock skew across machines silently picks the wrong winner), and the merge is invoked only on `git merge`. Two agents on two machines that both pull, both edit, both push will resolve by wall-clock, not by intent. There is no vector clock, no operation log, no CRDT — despite "append-only" framing, the store is a **full-state snapshot** (the `append()` methods are never called by the daemon), so you lose the one property that would make merge tractable.

**(d) SQLite cache as source-of-truth-in-practice.** JSONL is documented as source of truth, but every write goes SQLite-first, then flushes to JSONL. Between writes, SQLite and JSONL diverge for up to 30s (`maxDelayMs`). A crash in that window loses un-flushed writes (SQLite `cache.db` is gitignored and "rebuilt from JSONL"). So the durability boundary is the debounced flush, not each operation — acceptable for a dev tool, surprising given the "append-only source of truth" framing.

**Bottom line:** single daemon + single machine + no concurrent git pull = consistent. Add git sync or a second writer and you have unguarded races. There is no single-writer guarantee in the multi-process or multi-machine case.

---

## 4. Agent Consumer API Surface (via MCP) — Ergonomic for CRUD, missing for coordination

A coding agent through MCP (`mcp/server.ts`) gets a well-designed surface for the *single-agent* lifecycle:

- **Create a task:** 1 call (`create_task`, with `scheme` routing to any provider — nice).
- **Mark done:** 1 call (`update_task` with `transition: 'complete'`, `server.ts:152`). The combined `update_task` (fields + transition + blocker add/remove in one call, `server.ts:137-220`) is genuinely ergonomic.
- **"What's ready for me":** 1 call (`query({ ready: { assignee } })`) — `ready()` filters by assignee (`query.ts:551`).
- **Attach context:** 1-2 calls (`create_context` + `link`).

**What's missing for an agent to *coordinate*:**
1. **No atomic claim.** This is the critical gap. `ready()` is a pure read (`query.ts:531`); claiming is a separate `assignTask`/`update`. There is no compare-and-swap, no `claimNext()`, no conditional update ("set assignee=me IF assignee IS NULL"). Grep for `compareAndSwap|optimistic|expectedVersion|lease` → nothing. Two agents calling `ready()` both see task `t-x` and both `assignTask(t-x, self)` — the second silently wins. **For N agents pulling from a shared ready-queue, this guarantees double-work.**
2. **No leases / no dead-agent recovery.** Assignee is a plain string field. If an agent claims a task and dies, the task stays assigned forever. No TTL, no heartbeat, no reclaim.
3. **No notification subscription over MCP.** `watch.subscribe` exists at the IPC layer (`methods/watch.ts:218`) but isn't exposed as an MCP tool — an MCP agent must poll `query({ ready })`.
4. **`update_task` is non-atomic across its sub-operations.** It applies field update, then transition, then each blocker link as *independent* calls collecting partial results (`server.ts:161`). A failure mid-way leaves a partially-applied update with no rollback.

---

## 5. Multi-Agent Coordination Readiness — Primitives largely absent

| Primitive | Status | Evidence |
|---|---|---|
| Assignment / ownership | Partial — string field, no enforcement | `native.ts:686` `assignTask` is a plain update |
| **Atomic claim** | **Missing** | No CAS anywhere; `ready()` read-only `query.ts:531` |
| Conflict resolution | LWW by wall-clock | `merge-driver.ts:176` |
| Event delivery guarantee | **At-most-once, fire-and-forget** | `broadcastNotification('watch.event', …)` `methods/watch.ts:162` — no buffer, no ack, no replay; a disconnected subscriber misses events permanently |
| Ordering | None across machines | string-timestamp merge, no sequence numbers |
| Idempotency | None | hash-IDs are random (UUID→SHA256, README:440); no client-supplied idempotency key, so a retried create makes a duplicate |
| Dead-agent recovery | **Missing** | no leases/heartbeats |

The MAP event bridge (`map-event-bridge.ts`) gives *observability* (outbound emit of changes) and has echo-prevention via `_origin` stamping — good for a dashboard. But observability is not coordination. The hard primitives an orchestrator needs (atomic claim, lease, ordered delivery, idempotent writes) are not present.

---

## 6. Code Quality Signals — Generally strong

**Strong:**
- `tsc` (the `build` script) passes clean across 52k LOC — real typing rigor, discriminated unions, `satisfies`.
- Test depth is excellent: 3,233 test cases, 118 test files, genuine integration/e2e tiers including `tests/e2e/workflows/multi-agent.e2e.test.ts` and provider-compat suites.
- Error handling is consistent via typed error classes (`GraphError` with codes `graph/types.ts:435`, `ProviderError` `providers/types.ts:525`).
- Thoughtful comments explaining *why* (e.g., the realpath/symlink rationale at `git-graph-syncer.ts:209`, the `--untracked-files=all` note at `git-graph-syncer.ts:245`).

**Concerns:**
- **Module size.** `provider-store.ts` is 1,745 lines, `lifecycle.ts` 1,446, `sudocode.ts` 1,309, `cli.ts` 1,150. `reconcileProviders` alone (`provider-store.ts:1283`) is a ~250-line method with deeply nested try/catch. These are doing too much.
- **Pervasive empty `catch {}`.** The codebase swallows errors widely ("resilient — continue" at `native.ts:299`, `git-graph-syncer.ts:405`, reconcile loops `lifecycle.ts:714`). Resilient by design, but it means sync failures, watcher failures, and reconcile failures are silent. The `SyncerHealth` snapshot (`git-graph-syncer.ts:79`) is a partial mitigation, but most swallowed errors have no health surface.
- **Dead code:** `LockedJsonlWriter`/`FileLock` unused by the daemon (section 3b). The `append()`/`appendMany()` JSONL methods are unused by the daemon flush (only full `save()` is used) despite "append-only" being a headline claim.
- **97 TODO/stub markers** in non-test source. Mostly minor (`tools/task.ts:189` "provider: unknown // TODO"), but they accumulate.
- **`reload()` is O(n) and lossy under churn** (`store.ts:329`): full diff of all nodes/edges, delete+recreate edges to pick up changes, with `catch {}` swallowing cascade failures — runs on every external file change.

---

## The 5 Biggest Architectural Risks

1. **Flush-vs-git-pull data-loss race (no single-writer guarantee).** A pending debounced flush overwrites a freshly-pulled `graph.jsonl` with stale SQLite state. Native-node changes from peers are silently lost. No coordination exists between `methods/sync.ts:100` and the flush manager. *This breaks the core "git sync for multi-machine" value prop.* (`factory.ts:72`, `lifecycle.ts:455`, `git-graph-syncer.ts:341`)

2. **No atomic claim → guaranteed double-work for N agents.** The single most important primitive for the stated use case is absent. `ready()`+`assignTask` is a read-then-write with no CAS. (`query.ts:531`, `native.ts:686`)

3. **Wall-clock last-writer-wins conflict resolution.** Multi-machine convergence relies on ISO-timestamp string comparison with no causality tracking. Clock skew silently corrupts merges. (`merge-driver.ts:176`)

4. **At-most-once, unbuffered event delivery.** `broadcastNotification` is fire-and-forget; a momentarily-disconnected agent permanently misses state transitions. No replay/cursor. (`methods/watch.ts:162`)

5. **Docs describe ~2x the implemented system (Jira/Linear/compaction/recovery/expansion).** A consumer reading README/ARCHITECTURE.md will build against features that don't exist, and the `external`-node model carries complexity entirely for unbuilt providers. (Grep: no `jira.ts`/`linear.ts`; `ARCHITECTURE.md:691,732`)

---

## The 5 Highest-Leverage Missing Pieces

1. **An atomic `claimTask(id, agentId, {ifUnassigned, leaseMs})` primitive** backed by a SQLite conditional `UPDATE ... WHERE assignee IS NULL` inside `storage.runInTransaction` (the transaction plumbing already exists, `store.ts:724`). Plus `claimNext(filter)` to fuse ready+claim. This single addition is what turns OpenTasks from a graph into a coordination substrate.

2. **Serialize git sync with the flush manager.** Make `sync.pull`/`sync.now` acquire the flush lock: drain pending flush → pause flush → pull → `store.reload()` → resume. Mechanically small (the `pause()`/`flush()` hooks exist at `flush.ts:135,152`), eliminates Risk #1.

3. **Leases with TTL + heartbeat for dead-agent recovery.** Store `claim_expires_at` in metadata; a background sweep reopens expired claims. Without this, any agent crash strands its tasks.

4. **Durable, resumable event delivery.** Add a monotonic sequence number per change and let `watch.subscribe` pass a `sinceSeq` cursor for replay. Expose it as an MCP tool so agents stop polling. Upgrades delivery from at-most-once to at-least-once.

5. **Split as-built docs from design specs, and either build or delete the `external`/Jira/Linear path.** Mark ARCHITECTURE/DESIGN as "design intent," move implemented behavior into a slim accurate README, and either ship one real remote provider (Jira) to justify the `external` three-stage model or collapse it into the unified provider-materialization path that beads/sudocode already use.

---

## References

- `/Users/alexngai/GitHub/opentasks/src/daemon/factory.ts:68-73` — daemon flush uses unlocked full-file `jsonl.save()`, not the locked writer
- `/Users/alexngai/GitHub/opentasks/src/daemon/lifecycle.ts:451-462` — flush pauses only the watcher, not git sync
- `/Users/alexngai/GitHub/opentasks/src/daemon/methods/sync.ts:95-111` — `sync.now`/`sync.pull` call syncer with no flush coordination
- `/Users/alexngai/GitHub/opentasks/src/graph/git-graph-syncer.ts:321-353` — `pull()` rewrites graph.jsonl unguarded
- `/Users/alexngai/GitHub/opentasks/src/core/merge-driver.ts:141-211` — wall-clock LWW field merge + provider-reconcile flag
- `/Users/alexngai/GitHub/opentasks/src/graph/query.ts:531-588` — `ready()` is read-only; no atomic claim
- `/Users/alexngai/GitHub/opentasks/src/providers/native.ts:686-708` — `assignTask` is a plain update (no CAS)
- `/Users/alexngai/GitHub/opentasks/src/daemon/methods/watch.ts:162` — fire-and-forget `broadcastNotification` (no buffer/replay)
- `/Users/alexngai/GitHub/opentasks/src/storage/locked-writer.ts` + `src/storage/file-lock.ts` — write-lock infra unused by daemon
- `/Users/alexngai/GitHub/opentasks/src/providers/types.ts:304-321` — `local` flag forks node representation; `materializeMode`
- `/Users/alexngai/GitHub/opentasks/src/providers/native.ts:47,61-91` — `[ctfex]-` ID pattern; non-inverse type mappings (vs README `s-`/`i-`)
- `/Users/alexngai/GitHub/opentasks/src/providers/beads.ts:520-544` — beads is the deepest real provider (shells `bd`)
- `/Users/alexngai/GitHub/opentasks/src/graph/provider-store.ts:1283-1450` — 250-line reconcile method; positive-writes-only
- `/Users/alexngai/GitHub/opentasks/src/daemon/lock.ts:110` — single-daemon guarantee via `proper-lockfile`
- Grep (no matches): `jira.ts`/`linear.ts` provider files do not exist; `compareAndSwap|optimistic|lease|expectedVersion` absent from source
- `package.json` — `build: tsc` (passes clean); CLAUDE.md references a non-existent `npm run typecheck` script (minor doc drift)

**One caveat on my own analysis:** I read the write/flush/sync paths statically and traced the race by construction rather than reproducing it at runtime. The race in Risk #1 is real per the code (no shared lock between `sync.pull` and the flush manager), but the exact probability depends on debounce timing and how often `sync.pull` is actually triggered in a given deployment — a runtime repro under concurrent load would quantify it. Everything else is directly grounded in the cited lines.
---
## Report 2: Fresh-User DX Evaluation
# OpenTasks DX Evaluation — Full Report (skeptical first-time user, repo at v0.1.3)

**Method**: read README.md + docs/, ran a fresh `npm run build`, ran `npm test` twice, exercised the CLI happy path from clean temp dirs (`/tmp/opentasks-dx-test`, a git-repo variant, and an uninitialized dir), smoke-tested the MCP server over real stdio JSON-RPC, and probed daemon lifecycle/conflict behavior. No repo files modified, nothing committed; all temp dirs and test daemons cleaned up.

---

## (a) What works out of the box

- **Build**: `npm run build` (tsc) compiles cleanly with zero errors — type checking fully passes, so a separate `tsc --noEmit` was redundant.
- **`opentasks init`**: instant, clean output (hash/uuid/name). In a git repo it correctly installs the merge driver (`git config merge.opentasks.driver` → `opentasks merge-driver %O %A %B %L %P`) and writes `.opentasks/.gitattributes` with `graph.jsonl merge=opentasks` — the worktree/merge claims in the README check out.
- **Core graph semantics are real** (once a daemon is running):
  - `create --type task --title "Set up database" --status open` → clean JSON node (`t-3hkb`)
  - `link --from t-3hkb --to t-377d --type blocks` → `{"success": true, "edgeId": "x-5w9x"}`
  - `query '{"ready": {}}'` correctly excluded the blocked task; after `update t-3hkb --status closed`, the dependent task became ready. Blocker queries correct.
  - Cycle detection works: reversing the edge → `{"success": false, "error": "Would create cycle in dependency graph"}`
  - `annotate` creates `f-` feedback nodes; `create --type context` creates `c-` nodes; `context-summary` returns useful recently-completed/active breadcrumbs; `update`, `get`, `discover` (human-readable table), `connections` all work.
- **Daemon basics**: `daemon status` returns `not_running` or full status JSON (pid, socketPath, connectionCount); `daemon stop` works; double-start is safely handled — `{"status":"already_running","pid":...,"socketPath":...}`. Socket lives at `.opentasks/daemon.sock` (non-git) or `.git/opentasks/daemon.sock` (git multi-location).
- **MCP server**: `node dist/cli.js mcp --scope all` speaks correct MCP over stdio. `initialize` succeeds, `tools/list` returns exactly the 15 tools the README promises (create_task, get_task, update_task, delete_task, list_providers, reconcile, list_tasks, link, query, context_summary, annotate, create_context, get_context, update_context, list_contexts), and `tools/call create_task` round-trips to the daemon and returns the created node.
- **npm**: the package is genuinely published — `opentasks@0.1.3`, last modified 2026-04-22, maintained by the author.
- **Hidden gem**: `skills/opentasks/SKILL.md` (+ 4 companion docs) is the best CLI documentation in the repo — but it's unlinked from the README and excluded from the npm tarball (`files: ["dist"]`).

---

## (b) What breaks (exact errors)

1. **`npm test` fails on a clean checkout — twice, with different failures (flaky).**
   - Run 1: `Test Files 5 failed | 111 passed | 2 skipped (118)` / `Tests 10 failed | 2614 passed | 20 skipped (2644)`, 52s.
   - Run 2: `Test Files 6 failed | 110 passed | 2 skipped (118)` / `Tests 10 failed | 2614 passed | 20 skipped (2644)` — a *different* set of 10.
   - 9 of 10 failures are `Error: Test timed out in 5000ms` in git-spawning tests:
     - `src/graph/__tests__/git-graph-syncer.test.ts` (3: commitIfDirty, push, fetch+rebase+retry)
     - `src/materialization/__tests__/git-remote-store.test.ts` (2: archive snapshot, archive with edges)
     - `src/providers/__tests__/sessionlog-e2e-extended.test.ts` (2: checkpoint listing/multiple sessions)
     - `src/daemon/__tests__/e2e-git-sync.test.ts` (1: sync.now commits and pushes)
     - `src/__tests__/cli.test.ts` (1: "should show help after unknown command error")
   - One genuine assertion failure: `src/daemon/__tests__/sessionlog-watcher.test.ts:354` — `AssertionError: expected null not to be null`.
   - Test stderr is littered with `fatal: Not a valid object name sessionlog/checkpoints/v1`.

2. **Every tool command fails when no daemon is running, and nothing auto-starts one:**
   ```
   {"error":"Failed to connect to daemon: connect ENOENT /private/tmp/opentasks-dx-test/.opentasks/daemon.sock"}
   ```
   Exit 1, no remediation hint. Same in git and non-git dirs. The client (`src/client/client.ts`) only connects to an existing socket — there is no spawn/auto-start anywhere in the CLI path.

3. **`daemon start` blocks the terminal forever while claiming to detach.** Help text: `daemon start [--foreground]   Start the daemon (detaches by default)` — false on both counts. `cmdDaemonStart` (`src/cli.ts:534`) never parses `--foreground`, and its own comment admits: *"By default runs in the foreground (keeps the process alive). The caller (e.g., claude-code-swarm's ensureDaemon) spawns this as a detached subprocess."* Verified empirically — the command only returned when `daemon stop` was issued from another shell.

4. **Global store fallback broken as advertised.** `~/.opentasks` exists on this machine, yet running from an uninitialized directory:
   ```
   {"error":"Could not find daemon socket. Is the daemon running?"}
   ```
   README claims "Now use from any directory (no per-project init needed)." Reality: requires a running global daemon, which (per #3) means a permanently occupied terminal.

5. **MCP with daemon down fails closed.** The server starts silently, advertises all 15 tools, then every call returns:
   ```
   {"result":{"content":[{"type":"text","text":"{\"error\":\"Failed to connect to daemon: connect ENOENT .../.opentasks/daemon.sock\"}"}],"isError":true},...}
   ```
   A Claude Code user registering it would see a "working" server whose every tool errors.

6. **Minor**: the `mcp` process lingers after stdin EOF once a daemon connection has been made (left 2 zombie processes during testing); `get <missing-id>` prints `null` with exit 0.

---

## (c) README/docs claims vs reality

| Claim | Reality |
|---|---|
| Node prefix table: Spec `s-`, Task `i-`, Feedback `f-`, ExternalNode `e-` | Actual prefixes: task `t-`, context `c-`, feedback `f-`, edge `x-`. The README's **own examples** use `t-`/`c-`, contradicting its own table. |
| Quick Start: `import { link, query, annotate } from 'opentasks'` | No such top-level exports in `src/index.ts`. You need `createClient()` plus a running daemon. The Quick Start as written does not run. |
| `daemon start` "detaches by default" (`--help`) | Blocks foreground forever; `--foreground` flag is dead code. |
| Global store: "use from any directory (no per-project init needed)" | Fails without a manually started, never-detaching global daemon. |
| Storage layout lists `tombstones.jsonl`, `daemon.lock`, `daemon.sock`, `context/`, `tasks/` | A real session produces only `graph.jsonl`, `config.json`, `cache.db`, `.gitattributes`, `.gitignore`. |
| Version | Help banner: `opentasks v0.1.0` (hardcoded in `printHelp`); daemon + MCP serverInfo: `0.0.5` (hardcoded at `src/cli.ts:557`); package.json: `0.1.3`. Three versions in one binary. |
| MCP docs | One line total: `opentasks mcp --scope tasks,graph,annotate,context`. No `claude mcp add` example, no `.mcp.json` snippet, no mention that a daemon must be pre-started, no `npx opentasks` note. **Would not work without reading source.** |
| Development: `npm test — Unit tests` | Fails out of the box (flaky, see above). |
| Error terminology | `create` without `--status` → `"Status is required for issues (status)"` — calls tasks "issues" (stale terminology). |
| Packaging | `dist/entire/` exists with no `src/entire/` counterpart — `tsc` never cleans `dist`, and `files: ["dist"]` ships stale dead code to npm. |
| No quickstart doc | `docs/` contains ARCHITECTURE/DESIGN/INTERFACE/PERSISTENCE/PROVIDER-RECONCILIATION/PROVIDERS/SCHEMA/TESTING — zero getting-started or CLI onboarding content. |

---

## (d) Ranked top-10 DX gaps blocking adoption as a daily devtool

1. **No daemon auto-start.** The first command every new user tries fails with a socket ENOENT and no hint. The CLI should spawn a detached daemon on demand — the code comment even admits external callers are expected to do this themselves.
2. **`daemon start` hangs the terminal while claiming to detach.** Even users who discover the workaround get burned. Implement real detach (spawn + unref) and honor `--foreground`.
3. **No CLI quickstart anywhere.** The minimal working sequence (`init` → `daemon start` → `create`) is documented in zero places, and the README Quick Start doesn't even compile against the actual exports.
4. **Red, flaky `npm test` on a clean checkout.** Instant credibility killer for contributors. The 5s timeout is too tight for git-spawning tests; the sessionlog-watcher assertion failure needs real triage.
5. **MCP registration undocumented and fails closed.** Needs a `claude mcp add opentasks -- npx opentasks mcp --scope all` recipe plus a daemon health check (or auto-start) at server boot instead of per-call ENOENT errors.
6. **No human-friendly `list`/`ready` commands.** `opentasks list` → "Unknown command"; listing requires `query '{"nodes":{"type":"task"}}'` raw-JSON incantations. Great for agents, hostile for humans — cheap aliases would fix this.
7. **Global-store story broken end-to-end** (`init --global` → "use anywhere"). Compounds gaps #1 and #2; as shipped, that README section is fiction.
8. **Three conflicting version strings in one binary** (0.1.0 banner / 0.0.5 daemon+MCP / 0.1.3 package). Trivial fix — read package.json — but it screams unmaintained to an evaluator.
9. **README factual drift**: wrong ID-prefix table (contradicting its own examples), phantom top-level exports, "issues" terminology in errors, `null`-with-exit-0 on missing IDs.
10. **Build/packaging hygiene**: stale `dist/entire/` artifacts ship to npm with no clean step; the excellent `skills/opentasks/` agent docs are orphaned — unlinked from the README and excluded from the published package.

---

**Bottom line**: the engine is legitimately good — graph semantics, cycle checking, the IPC daemon, the git merge driver, and the MCP surface all genuinely work once a daemon is up. But the first ten minutes are a wall: nothing tells you a daemon is required, the command to start it lies about detaching, the README Quick Start doesn't run, and the test suite is red. As shipped, OpenTasks onboards an agent (via SKILL.md, with a daemon pre-arranged by an orchestrator like claude-code-swarm) far better than it onboards a human evaluating it cold.
---
## Report 3: Sibling-Repo Integration Analysis (swarm-dispatch, git-cascade, MAP, agent-inbox, claude-code-swarm)
# OpenTasks as the Coordination Substrate for Its Sibling Repos

Read-only analysis of `/Users/alexngai/GitHub/opentasks` (v0.1.3) against its five sibling repos. Nothing was modified.

---

## Part 1: Per-repo profiles

### 1. swarm-dispatch (`/Users/alexngai/GitHub/swarm-dispatch`, v0.3.4)

**What it does.** A runtime-agnostic dispatch orchestrator: polls task sources, claims work, routes to idle agents or spawns new ones, handles retry/continuation/stall-detection/reconciliation. Built around five adapter ports — TaskSource, AgentRuntime, MessagePort, AgentRoster, Journal (`src/types.ts`, `src/dispatcher.ts`). Also ships a cron scheduler (`src/scheduler/`).

**Task/coordination model.** `DispatchTask` is deliberately thin: id, title, content, status, tags, priority, assignee, `claimed_by`, metadata. Orchestration state (claimed → running → continuing / retryQueued → dead) lives in RAM with an opt-in write-ahead journal. It distinguishes *continuation* (normal agent exit, task still active → short delay, same logical run) from *retry* (abnormal exit → exponential backoff, capped attempts). Crucially, `docs/architecture.md:31` explicitly cedes territory: "**Task graph semantics — opentasks owns dependencies, blocking, task state transitions.**" Distributed multi-dispatcher coordination is delegated to the task source's claim primitive — fence tokens, `renewClaim`, fenced `release` (`src/types.ts:37-69`).

**References opentasks today: YES — it is the reference TaskSource.** `src/adapters/opentasks.ts` exports `createOpenTasksSource(client)`, adapting via structural typing (`OpenTasksClientLike`) with no package dependency. The README architecture diagram lists opentasks as the primary TaskSource. However, the adapter is partly broken against the real daemon:

- `release()` calls `client.task({ unassign: { id } })` (`src/adapters/opentasks.ts:63-65`) — **opentasks has no unassign operation**. `TaskParams` (`opentasks/src/tools/types.ts:332-370`) and the handler dispatch in `opentasks/src/tools/task.ts:50-101` support only `transition | ready | assign | validActions`. An `unassign` call fails the exactly-one-operation validation. The adapter test passes only because the client is mocked (`src/__tests__/opentasks-adapter.test.ts:99-106`).
- `claim()` is a blind `taskAssign` in a try/catch ("Attempt atomic claim if supported") — opentasks' `assignTask` (`opentasks/src/providers/traits/TaskManageable.ts:165-169`) has no compare-and-set, no fence, no lease. Two dispatchers can both "claim" the same task successfully.

**Maturity:** mid. 26 test files, versioned releases, phase-2 features (fencing, mail dispatch, rosters) designed and tested against mocks; only hard dependency is cron-parser.

### 2. git-cascade (`/Users/alexngai/GitHub/git-cascade`, v0.0.7)

**What it does.** Multi-agent git coordination: streams (work units 1:1 with branches), Change-Ids stable across rebases via commit trailers, cascade rebase propagating to dependent streams, deferred conflict handling, per-agent worktrees, stacked review, GC/recovery/rollback. SQLite is the source of truth ("database-first"; git verified against DB).

**Task/coordination model.** Two work representations of its own:
- **Streams** — lifecycle `active | paused | merged | abandoned | conflicted` (`src/models/stream.ts`).
- **WorkerTasks** — a full task table (`src/worker-tasks.ts`, `src/models/task.ts:13`): status `open | in_progress | completed | abandoned`, plus priority, agentId, streamId, branchName, `listTasks({status})`. Ephemeral worker branches (`worker/<agent>/<task>@<ts>`) that merge into integration streams on `completeTask` — task completion is transactionally coupled to a git merge.

**References opentasks today: by name only, no dependency.** The event schema defines a pass-through `TaskRef` — "Optional reference to an external task (e.g., an OpenTasks node)" with `resource_id`/`node_id` (`src/events/index.ts:204-214`; also `src/tracker.ts:848`). Its opt-in emitter speaks MAP vendor-extension conventions (`x-cascade/stream.opened|committed|merged|conflicted|abandoned`) so events can be forwarded verbatim to a MAP connection — transport-agnostic, no MAP dependency.

**Where it would plug in.** Two directions: (a) an opentasks `cascade://` provider surfacing streams/worker-tasks as graph nodes; (b) the opentasks daemon (or a bridge) consuming `x-cascade/stream.*` events to auto-create `task → stream` edges from `TaskRef` metadata. The cascade side is pre-built; nothing exists on the opentasks side.

**Maturity:** low version number but substantial — ~750 tests, recovery/GC/rollback machinery, well-documented API.

### 3. multi-agent-protocol / MAP (`/Users/alexngai/GitHub/multi-agent-protocol`, SDK v0.1.10)

**What MAP is** (opentasks has a MAP provider + event bridge, so in detail):

- **Transport:** JSON-RPC over duplex streams (WebSocket in practice; `createStreamPair` for in-process), with client/agent/system connection roles, auto-reconnect with subscription restoration, federation with envelope-based routing, a 4-layer permission system (system/participant/scope/agent), and persistent agent identity (W3C DID:key, CNCF SPIFFE, DID:web). 27 protocol methods in 3 tiers (core/structure/extensions).
- **Event model:** subscription-based with event-type filters, backpressure, causal ordering. Typed task events: `task.created`, `task.assigned`, `task.status`, `task.completed` (`ts-sdk/src/types/index.ts:1044-1048`), plus agent lifecycle events. Vendor-extension namespaces (`x-cascade/*`, mail conventions) are an explicit convention.
- **Task model:** intentionally minimal. `MAPTask` = id, assignee, title, status (`open | in_progress | blocked | completed | failed`), description, `meta` (`ts-sdk/src/types/index.ts:3534-3567`). The doc comment names OpenTasks directly: "MAP defines the coordination envelope, not the task semantics. Providers (e.g., OpenTasks) can use the `meta` field for implementation-specific data (graph edges, priority levels, content hashes)." Methods `map/tasks/create|assign|update|list` are capability-gated (`schema/meta.json:475-507`).
- **Maturity:** 0.1.x. SDK is well tested (71 test files), but the protocol is still evolving — a 1,050-line `docs/01-open-questions.md` sits beside the 496-line design spec. Notably, opentasks now lists `@multi-agent-protocol/sdk ^0.1.9` as a **hard dependency** in package.json, while `opentasks/CLAUDE.md` still claims "No package.json dependency on the SDK" (dynamic import / graceful degradation) — doc drift worth fixing.

### 4. agent-inbox (`/Users/alexngai/GitHub/agent-inbox`, v0.2.3) — brief

A MAP-native **message router**: per-agent inboxes with to/cc/bcc, threading (`thread_tag`, `in_reply_to`), delivery/read tracking, traceability (auto conversations/turns/threads per MAP mail conventions), federation via MAP WebSocket or agentic-mesh encrypted P2P, exposed as MCP tools (`send_message`, `check_inbox`, `read_thread`, `list_agents`), NDJSON IPC socket, and `mail/*` JSON-RPC methods. Storage: in-memory or SQLite+FTS5.

**No task model and zero opentasks references** (grep clean across the repo). It is complementary, not overlapping: messages vs. tasks. The two already meet inside swarm-dispatch, whose `createAgentInboxPort` MessagePort adapter lets work arrive by mail (`x-dispatch/work` schema) and returns typed ResultEnvelopes — that payload is the natural place to carry an opentasks URI.

### 5. claude-code-swarm (`/Users/alexngai/GitHub/claude-code-swarm`, v0.3.25) — brief

Claude Code plugin launching agent teams from openteams YAML topologies, using native Claude teams for coordination, optional MAP for external observability, and **optional OpenTasks — the deepest live consumer today**:

- `opentasks >= 0.1.1` as an optional peerDependency (`package.json:27,34`; devDep `^0.1.2`).
- Hand-rolled daemon IPC client `src/opentasks-client.mjs` (JSON-RPC 2.0 over Unix socket; discovery walks `.swarm/opentasks/` → `.opentasks/` → `.git/opentasks/` → parent dirs).
- Registers the opentasks MCP server for agents; `PostToolUse(opentasks)` hooks bridge MCP tool use into MAP task events (`hooks/hooks.json:57-61`); `TaskCompleted` hook writes back to the opentasks graph; `UserPromptSubmit` forwards inbound MAP `task.*` events into the graph.
- Lives with three task layers simultaneously, documented in `CLAUDE.md:325-334`: Claude native tasks (ingested reactively by opentasks' `claude-tasks` provider via chokidar — no hooks needed), opentasks MCP tools, and MAP tasks (`map://` ephemeral pass-through).

**Maturity:** actively developed; tiered e2e suite.

---

## Part 2: Integration map

```
 PRODUCERS                          SUBSTRATE                         CONSUMERS
 ─────────                          ─────────                         ─────────
 claude-code-swarm agents ──MCP──►                                ◄──poll/claim── swarm-dispatch
 Claude native tasks ──provider──►  OpenTasks graph                   (TaskSource adapter)
 MAP remote systems ──map:// ────►  (nodes + edges:               ──events──► MAP event bridge
 beads/jira/linear ──providers──►   blocks, depends-on,                        └─► agent-inbox /
 git-cascade x-cascade/* ──[GAP]─►  implements, discovered-from)               observers
                                    daemon + git sync             ◄──IPC────── claude-code-swarm hooks
```

- **swarm-dispatch is the consumer that justifies the graph.** Its entire eligibility pipeline starts from `queryReady()`, and "ready = no active blockers" is computed only by opentasks' edge layer (`blocks`/`depends-on`, `opentasks/src/schema/edges.ts:12-27`). No sibling repo computes dependency-readiness. This is the single highest-value join in the ecosystem.
- **claude-code-swarm is the producer and bridge.** Agents create tasks (MCP or native), the `claude-tasks` provider ingests them, and plugin hooks fan changes out to MAP — making the graph visible to remote systems.
- **MAP is the wire, not the store.** `MAPTask` is an envelope; opentasks correctly treats `map://` as ephemeral pass-through (no stale cache), and the MAP event bridge (`opentasks/src/providers/map-event-bridge.ts`) handles echo prevention via `_origin` stamping. The MAP SDK names OpenTasks as the intended semantics provider.
- **git-cascade is the missing edge.** It carries `TaskRef` (opentasks node ids) through its events and emits MAP-compatible `x-cascade/stream.*`, but nothing on the opentasks side ingests them. Wiring this closes the provenance loop — *task → stream → commits → merge* — joined with opentasks' context-files (already commit-pinned via `context_file_commit`) for full "what code implemented this task" lineage.
- **agent-inbox stays orthogonal** — transport for messages while opentasks is the ledger for work; the contract between them is swarm-dispatch's `x-dispatch/work` mail schema.

## Part 3: Overlaps and conflicts

1. **swarm-dispatch claim semantics vs. opentasks assign — the sharpest conflict, live today.** DispatchTaskSource wants atomic claim + fence tokens + renewClaim + fenced release; opentasks offers only a non-atomic `assign` and *no unassign at all*, so the shipped adapter's `release()` fails against a real daemon (falls through the exactly-one-operation check in `opentasks/src/tools/task.ts:50-53`). Multi-dispatcher safety — the point of swarm-dispatch's fencing design — currently has no backing primitive.
2. **git-cascade worker-tasks duplicate opentasks task state.** `worker_tasks` is a parallel queue (status, priority, list-by-status) in its own SQLite. Partly justified — completion is transactionally coupled to a git merge — but without TaskRef-based mirroring, status diverges between the two ledgers.
3. **git-cascade vs. opentasks git sync — coexistence hazard, not a design conflict.** Opentasks auto-commits `.opentasks/graph.jsonl` on the *current branch* (`opentasks/src/config/schema.ts:546-563`); git-cascade rewrites history via cascade rebases and runs many worktrees. If graph.jsonl lives on a cascade-managed branch, sync commits get rebased and conflicted, and each worktree may resolve a different `.opentasks` store (claude-code-swarm's socket walk-up shows how fragile discovery already is). Needs an explicit story: dedicated sync branch or repo-external store for cascade-managed repos.
4. **Status vocabulary loss.** MAP distinguishes `completed` vs `failed`; opentasks maps both to `closed` (per its own CLAUDE.md). swarm-dispatch's retry-vs-done logic and git-cascade's `abandoned` both need an outcome distinction the substrate cannot currently represent.
5. **Triple task representation in claude-code-swarm** (native Claude tasks, opentasks nodes, MAP tasks) is reconciled by design — provider watcher + bridges + `_origin` echo guards — and acceptable, but every new hop multiplies echo-loop risk.

## Part 4: Top 5 missing opentasks features for adoption as the shared substrate

1. **Atomic claim/lease primitive with fencing.** `claim(id, claimant)` as compare-and-set, fence token returned, `renewClaim` (heartbeat/lease expiry), and `release`/`unassign`. Add to the `TaskManageable` trait (`src/providers/traits/TaskManageable.ts`), the task tool (`src/tools/task.ts`), and the client. This unbreaks swarm-dispatch's `release()` and makes its multi-dispatcher fencing real. Highest priority — the contract already exists in `swarm-dispatch/src/types.ts:37-69`; opentasks just doesn't fulfill it.
2. **Client-exposed task-change subscription (push).** The daemon already broadcasts `watch.event` (`src/daemon/methods/watch.ts:162-197`), but it's an internal hash-diff scan not surfaced through `OpenTasksClient`. A filtered subscription (type/status/tags/provider) lets swarm-dispatch go event-driven instead of 15-second polling, and gives claude-code-swarm hooks and MAP bridges a single fan-out point.
3. **Outcome-bearing terminal states.** Add `failed` (and arguably `abandoned`) distinct from `completed`, plus a result/attempt payload on terminal transition — making the MAP status mapping lossless and giving swarm-dispatch's retry ledger and git-cascade's abandonment a home in the shared graph.
4. **git-cascade ingestion: a `cascade://` provider and/or `x-cascade/*` event consumer.** Surface streams/worker-tasks as nodes; auto-create `implements`/`references` edges from `TaskRef` (`git-cascade/src/events/index.ts:204-214`). Pair with a documented git-sync layout that survives cascade-managed repos (dedicated sync branch, worktree-aware store/socket resolution).
5. **A lightweight, published thin client.** Every consumer reinvents the wire client: claude-code-swarm hand-wrote `src/opentasks-client.mjs`, swarm-dispatch duck-types `OpenTasksClientLike`. A small `opentasks/client` subpath export (or separate package) with the typed IPC client, socket discovery, and a frozen wire-protocol doc removes the biggest practical adoption barrier — siblings could depend on the client without pulling in the daemon, providers, better-sqlite3, or the MAP SDK (currently a hard dependency of the whole package, contradicting `opentasks/CLAUDE.md`'s "no package.json dependency" claim).

**Bottom line.** The ecosystem already treats opentasks as the intended task substrate — swarm-dispatch names it the primary TaskSource and explicitly cedes graph semantics to it, MAP's SDK names it as the semantics provider for `MAPTask.meta`, claude-code-swarm ships a working optional integration, and git-cascade carries opentasks node refs through its events. What's missing is not positioning but primitives: atomic claiming, push subscriptions in the client, failure semantics, cascade ingestion, and an embeddable client. One outright bug found along the way: swarm-dispatch's adapter calls a nonexistent `unassign` operation (`swarm-dispatch/src/adapters/opentasks.ts:63-65` vs `opentasks/src/tools/task.ts:50-101`), masked by mocked tests.
---
## Report 4: Practitioner Landscape (Beads, orchestrators, SaaS trackers)
# Task Management for AI Coding Agents: Practitioner Landscape, Mid-2026

Research conducted June 2026 via web search, primary-source fetches (READMEs, vendor docs, blog posts), HN thread analysis (via Algolia API), and live GitHub API star counts (pulled 2026-06-11). Purpose: evidence base for an honest competitive review of OpenTasks (local-first, daemon-backed, federated cross-system task graph with JSONL+SQLite storage, git sync, MCP tools).

## Verified traction snapshot (GitHub API, 2026-06-11)

| Project | Stars | Forks | Last push | Notes |
|---|---|---|---|---|
| ruvnet/ruflo (was claude-flow) | 58,902 | 6,767 | active (Jun 2026) | renamed; controversial |
| eyaltoledano/claude-task-master | 27,367 | 2,563 | **Apr 28, 2026** | momentum slowing |
| BloopAI/vibe-kanban | 26,919 | 2,844 | **Apr 24, 2026** | company dead, community-maintained |
| gastownhall/beads (was steveyegge/beads) | 24,459 | 1,633 | active (Jun 2026) | v1.0.4, May 2026 |
| gastownhall/gastown | 15,854 | 1,477 | active | Yegge's orchestrator |
| git-bug/git-bug | 9,892 | 308 | active | no native MCP/agent focus |
| automazeio/ccpm | 8,182 | 831 | **Mar 18, 2026** | slowing |
| smtg-ai/claude-squad | 7,769 | 553 | May 2026 | TUI session manager |
| GothenburgBitFactory/taskwarrior | 5,863 | 409 | active | human tool; 3rd-party MCPs |
| MrLesk/Backlog.md | 5,723 | 342 | active (Jun 2026) | markdown-native, growing |

---

## 1. Beads — the category-definer, now a full stack

**What it is.** Steve Yegge's "memory upgrade for your coding agent": a distributed, dependency-aware graph issue tracker where agents file, link, and claim work. Solves the "50 First Dates" problem — agents losing context between sessions and littering repos with markdown plans (https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a).

**Design evolution — the single most instructive datapoint for OpenTasks.** Beads launched (Oct 2025) on exactly OpenTasks' architecture: **JSONL in git (`.beads/issues.jsonl`) + local SQLite cache**, hash-based IDs (`bd-a1b2`, with birthday-paradox-driven ID lengthening) to avoid merge collisions, and `bd ready` for unblocked-work queries. By v0.56 (early 2026) it **abandoned JSONL+SQLite for Dolt** (git-for-databases, cell-level merge), because JSONL merge conflicts and daemon sync were the top user complaints; JSONL is now read-only interchange, not the store (https://github.com/gastownhall/beads, https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/). The migration itself was rocky (e.g. issues #1752, #2276 — failed `bd migrate --to-dolt` runs leaving empty Dolt DBs).

**Ecosystem.** Repo moved to the `gastownhall` org; v1.0 shipped alongside **Gas Town** (15.8k stars), Yegge's orchestrator managing 20-30 parallel Claude Code instances with beads as the atomic work unit; then **Gas City** (Apr 2026), an SDK of composable "packs"; the **Wasteland** ("public commons board for federated work arbitrage" — cross-machine/cross-org task federation); and a ~2,000-member Discord (https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607, https://gastownhall.ai/, https://softwareengineeringdaily.com/2026/02/12/gas-town-beads-and-the-rise-of-agentic-development-with-steve-yegge/).

**Strengths.** First-mover mindshare; dependency graph + ready-work queries proved out as *the* killer features; praised as competing "with markdown specs, not gh issues" for work spanning multiple context windows (HN: https://news.ycombinator.com/item?id=46075616).

**Weaknesses (well-documented).** (a) Bloat: ~130-240k lines of vibe-coded Go for "a lightweight tracker"; "could not tell what all that code is doing" (https://news.ycombinator.com/item?id=46669791); "the number of overlapping and ad-hoc concepts is overwhelming" (https://news.ycombinator.com/item?id=46467414). (b) Reliability: "really buggy... bugs confuse the agent" — instructions reference behavior that doesn't work. (c) Daemon misbehavior: "background daemon processes syncing the wrong things at the wrong times," "six months of Beads conflicts" (Show HN: ticket, https://news.ycombinator.com/item?id=46487580). (d) Scale: Yegge's own best-practices post admits agents grepping `issues.jsonl` hit ~25k-token limits around 500 issues; advises `bd cleanup` every few days and working sets under 200 issues (https://steve-yegge.medium.com/beads-best-practices-2db636b9760c). (e) Multi-repo footguns: agents filing beads outside the right directory get dumped into a global `~/.beads/default.db` "and make a mess" (HN 46487580). (f) Interferes with agents' built-in todo systems (HN 46075616).

**Backlash spawned a minimalist counter-wave:** `ticket` (single bash script, markdown files, deps-only), **Trekker** ("intentionally minimal... no extra abstraction"), **Beans** (markdown tickets beside code), `git-issue`, `agent-issue-tracker` (https://news.ycombinator.com/item?id=46487580, https://news.ycombinator.com/item?id=46709872, https://github.com/hmans/beans).

**Vs. a federated graph:** Beads is a *single-system* graph that wants to be your only tracker; its answer to federation is "adopt the whole Gas Town/Dolt stack" (Wasteland). It does not link existing systems. Its JSONL→Dolt pivot is both a warning (JSONL merge pain at multi-writer scale) and an opening (many users explicitly rejected the Dolt/daemon complexity).

## 2. Claude Code native tasks & agent teams

Agent teams (experimental, v2.1.32+, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) coordinate 2-16 sessions: a lead spawns teammates; coordination runs through a **shared task list** (TaskCreate/TaskUpdate/TaskList) with three states, **task dependencies** (a pending task with unresolved deps can't be claimed), file-locked claiming, and a mailbox for peer messaging. Hooks (`TaskCreated`, `TaskCompleted`, `TeammateIdle`) can gate quality (https://code.claude.com/docs/en/agent-teams).

**Critical limitations (from Anthropic's own docs):** task lists live at `~/.claude/tasks/{team-name}/` and **exist only while the team is active — removed on cleanup or session end**; no `/resume` for in-process teammates; "**task status can lag: teammates sometimes fail to mark tasks as completed, which blocks dependent tasks**"; one team per lead, no nested teams; 3-7x token cost. In practice people coordinate multiple Claude instances via git worktrees + tmux (Claude Squad, 7.8k stars) or external boards. Anthropic's harness-design engineering post notably uses *files passed between planner/generator/evaluator agents*, not a tracker (https://www.anthropic.com/engineering/harness-design-long-running-apps).

**Vs. a federated graph:** Claude's native tasks are exactly the ephemeral, siloed substrate a cross-system layer should capture and persist. That Anthropic ships dependency-aware claiming validates the semantics; that it's session-scoped and single-team validates the gap. OpenTasks' claude-tasks provider targets precisely this.

## 3. Orchestration entrants

- **claude-task-master / Taskmaster** (27.4k stars): PRD → AI-decomposed task DAG (`tasks.json`), ~36 MCP tools, works across Cursor/Windsurf/Claude Code; 1,000+ Discord members. Strength: PRD-to-task pipeline and complexity analysis. Weakness: own JSON silo, single-project orientation, AI-API-key costs for parsing; push cadence slowed after April 2026 (https://github.com/eyaltoledano/claude-task-master).
- **vibe-kanban** (26.9k stars): kanban UI over parallel agents in worktrees, MCP card creation, inline diff review, 10+ agent support. **Bloop shut down April 10, 2026 — "thousands of engineers use Vibe Kanban every day, but the vast majority are free users and we couldn't find a business model"** — now Apache-2.0 community-maintained, moving fully local (https://www.vibekanban.com/blog/shutdown). The sharpest monetization cautionary tale in this space.
- **claude-flow → ruflo** (58.9k stars): "hive-mind" queen/worker swarms, SQLite memory, neural-pattern branding. Highest stars, lowest practitioner trust: documented issues where `hive-mind spawn` silently runs a single agent or hangs (https://github.com/ruvnet/claude-flow/issues/655, /issues/368). Widely viewed as marketing-heavy.
- **CCPM** (8.2k stars): PRD → epic → GitHub Issues, worktree parallel execution, "Issues are the source of truth"; repackaged as a portable Agent Skill for Claude Code/Codex/Cursor/Amp. Slowing since March (https://github.com/automazeio/ccpm).
- **GitHub-Issues-as-queue pattern:** Baton (polls Issues, dispatches agents to worktrees), Code Conductor, and many homegrown `gh` CLI loops. Augment's 2026 orchestrator survey notes recurring gaps: no dependency management between tasks, no shared learning across agents, noisy issue queues triggering excess runs (https://www.augmentcode.com/tools/open-source-agent-orchestrators).
- **Newer 2025-26 entrants:** Emdash (YC W26; 22+ CLI agents in parallel, ticket intake from Linear/GitHub/Jira but *no inter-task dependencies*), Bernstein (deterministic Python-scheduled task graph + pre-merge "Janitor" verification), Backlog.md (5.7k stars, markdown tasks + TUI/web kanban + MCP server), Nimbalyst (Crystal successor), Agent Kanban (Copilot-only, markdown board).

**Pattern:** every orchestrator embeds its *own* task store (tasks.json, kanban DB, GH Issues, markdown folder) — none interoperate. Federation across them is unclaimed territory.

## 4. Issue trackers as agent backends

- **Linear** is the most aggressive: "Linear for Agents" makes agents workspace members you can assign, @mention, or auto-delegate via triage rules — with the human kept as primary assignee and the agent as "contributor" for accountability (Codex, Cursor, Copilot, Devin, Factory, Charlie integrated) (https://linear.app/agents). April 2026: Linear's own agent gained outbound MCP (https://linear.app/changelog/2026-04-23-linear-agent-mcp-support). Their "Issue Tracking Is Dead" repositioning drew a large HN debate — Linear says it's "growing faster than it has in years" on agentic workflows; skeptics warned of enshittification and noted "multi-player collaboration remains Linear's defensible moat" vs. local agent tools (https://news.ycombinator.com/item?id=47507253).
- **Atlassian:** "Agents in Jira" open beta (Feb 2026) — assign work items to Rovo or MCP-enabled third-party agents, iterate in comments; Rovo MCP Server is the hosted gateway; Rovo Dev CLI completes Jira work items end-to-end (https://www.businesswire.com/news/home/20260224033792/en/Atlassian-Introduces-Agents-in-Jira-to-Drive-Human-AI-Collaboration-at-Enterprise-Scale, https://www.atlassian.com/platform/remote-mcp-server).
- **GitHub Agent HQ** (public preview for paid Copilot, ~Feb 2026): "mission control" assigns/steers/tracks Copilot, Claude, and Codex tasks across repos, including assigning one issue to multiple agents and merging the best PR; Jules/Devin/xAI integrations announced (https://github.blog/news-insights/company-news/welcome-home-agents/, https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/).
- **What teams actually do:** GitHub MCP for code/PR context + Linear or Jira MCP for tickets "covers 80% of an engineering agent's day"; gateways like Port and Composio's UCL offer one governed MCP entry point routing to many SaaS backends — routing, but **no persistent local graph, no edges, no offline story** (https://www.mindstudio.ai/blog/issue-trackers-ai-agent-infrastructure-jira-linear, https://docs.port.io/guides/all/automatically-resolve-tickets-with-coding-agents/).
- Practitioner objections to SaaS-as-agent-backend, verbatim from HN: vendor lock-in, "slow network calls (+ GitHub is down sometimes)," and "I don't particularly like the aesthetics of having a bunch of LLM-generated prose in my issue trackers" (simonw) (https://news.ycombinator.com/item?id=46487580, https://news.ycombinator.com/item?id=46075616).

## 5. Local-first / git-native incumbents

**git-bug** (9.9k stars): issues as git objects, bridges to GitHub/GitLab/Jira — architecturally the closest pre-AI ancestor of a federated layer, but **no native MCP/agent integration** (verified: nothing in-repo), and HN commenters dismissed it for agent use as "much more involved, collaboration-focused" vs. one-file trackers. **Taskwarrior** (5.9k stars): at least four third-party MCP servers exist (awwaiid, 0xbeedao, MCP Warrior, taskwarrior-ng), and HN users note "most LLMs already understand Taskwarrior" — but it lacks dependency-graph/ready semantics suited to agents and has no first-party agent strategy (https://a2a-mcp.org/entry/mcp-warrior, https://github.com/meirm/taskwarrior-ng). Neither captured the agent wave; the wave instead produced purpose-built tools (Beads, Backlog.md, Beans, ticket, and a git-issue Markdown-in-repo revival — https://news.ycombinator.com/item?id=47973644).

## 6. What practitioners say is missing or broken

Drawn from HN threads (46075616, 46487580, 46709872, 47507253), Yegge's own posts, Anthropic docs, and the orchestrator surveys:

1. **Agents don't update status.** Anthropic documents it in its own product ("teammates sometimes fail to mark tasks as completed, which blocks dependent tasks"); Beads users report agents confused by buggy instructions; GH-Issues loops re-run noisy queues. Nobody has closed the loop between *claimed done* and *verified done* (hooks/Janitor-style gates are early attempts).
2. **Stale tasks poison context.** "There's some risk in agents tripping over stale tickets and consuming tokens — I see it with .md all the time"; requests for one-command purge/archive of closed items; Yegge mandates `bd cleanup` + <200-issue working sets; 25k-token ceiling reading the backlog.
3. **Cross-project routing is unsolved.** The single most OpenTasks-shaped quote in the corpus (bredren, HN 46487580): "I wasn't able to find something AI-native that supported subissues, and worked across projects... I want it to handle integration with systems like Linear or even GH issues... The idea is: I have 15 minutes right now, what is the most important thing to put attention to? Be routed to the project." Related: beads escaping into `~/.beads/default.db`, and "why do all these projects assume I want to store this stuff in my current repo?"
4. **Sync/merge of distributed task state is genuinely hard.** JSONL merge conflicts drove Beads to Dolt; the daemon "syncing the wrong things at the wrong times" drove users off Beads entirely; HN asks "how is merge handled?" of every new tracker.
5. **Dependency/ready semantics are the retained kernel.** Every Beads refugee kept exactly one thing: the dependency graph ("dependencies are everything here"; "tk dep tree"). Tagging/labels and cleanup come next; everything else is regarded as bloat.
6. **Human-agent handoff is two-sided.** Agents want CLIs/MCP; humans want boards (every successful tool grew a TUI/web UI — Backlog.md, Trekker dashboard, vibe-kanban) and accountability (Linear deliberately keeps the human as primary assignee). Tools serving only one side stall.
7. **Interop friction with the harness.** External trackers fight Claude Code's built-in todo list; duplicated state across harness tasks, repo tracker, and SaaS tracker is the norm.

---

## Conclusions

### (a) Where the ecosystem is converging
- **"Issue tracker = agent memory" is now consensus** — structured, dependency-aware task state beats markdown plans for multi-session work; even skeptics concede it competes with markdown, not with Jira.
- **Two poles consolidating:** local git-native trackers (Beads + a Cambrian minimalist wave) and SaaS trackers absorbing agents (Linear, Jira/Rovo, GitHub Agent HQ). The middle — orchestrators with bespoke silos — is being squeezed (Bloop dead, Taskmaster/CCPM slowing, claude-flow distrusted).
- **MCP is the universal interface**; every serious tool ships an MCP server; dependency-gated "ready work" claiming and git-worktree isolation are table-stakes patterns.
- **Federation is emerging as the next frontier from three directions:** Yegge's Wasteland (within his stack), GitHub's mission control (within GitHub), MCP gateways like Port/UCL (stateless routing). Nobody has shipped a neutral, persistent, cross-system graph.

### (b) The 5 hardest unsolved problems (per practitioners)
1. **Status truthfulness** — agents that claim, then don't close; no verified-done loop; dependent work blocks on phantom state.
2. **Task-state merge/sync across machines and agents** — the problem hard enough to make Beads swap its entire storage engine mid-flight.
3. **Cross-repo/cross-system identity and routing** — one piece of work mirrored in Claude tasks, a repo tracker, and Linear, with no shared ID, edges, or priority view across them.
4. **Context attachment without context rot** — binding specs/files/decisions to tasks while keeping listings token-light and detecting drift in attached artifacts.
5. **Bidirectional human-agent handoff** — accountability models, human-legible boards over agent-legible stores, and trust in agent-reported progress.

### (c) The niche a cross-system task graph could credibly own — and its table stakes
**The credible niche:** the neutral **edge layer** — "git-bug's bridge idea, rebuilt agent-native." Nothing today persists relationships *between* Claude Code's ephemeral team tasks, a repo's Beads/Backlog.md store, Linear/Jira/GitHub, and multi-agent protocols. Closest analogs are either stack-captive (Wasteland → Gas Town/Dolt), vendor-captive (Agent HQ → GitHub), or stateless (Port/UCL → no graph, no offline, no edges). OpenTasks' federated provider model + local graph + positive-writes-only reconciliation is differentiated here, and bredren's "route my 15 minutes across projects and trackers" comment is direct demand evidence.

**Table stakes the research says it must nail:**
1. Dependency edges + ready-work queries across providers (the one universally retained feature).
2. An MCP server *and* a CLI (agents use both; CLIs are often preferred for speed/token cost).
3. Stale-task hygiene: cleanup/archival commands, token-light listings, closed-task exclusion by default (the loudest day-2 complaint).
4. Merge-safe sync — learn from Beads: hash IDs help, but JSONL-in-git conflicts at multi-writer scale; OpenTasks' daemon-mediated single-writer + git merge driver must be visibly more reliable than Beads' daemon, which is the most common reason users churned.
5. A daemon that is silent and trustworthy — "syncing the wrong things at the wrong times" is a brand-killing failure mode.
6. Context attachment with drift detection (OpenTasks' file-backed context nodes map well; nobody else has pinned-commit + drift semantics).
7. Some human-facing view (TUI/board) and an accountability model for agent-claimed completion (hook-gated status transitions).
8. Restraint: the market punished Beads' 240k-LOC sprawl and rewarded one-file trackers; a federation layer must feel small per-provider or it inherits the bloat critique.

**Honest risks:** the graveyard is crowded — 27k stars and "thousands of daily users" did not save Bloop; platform absorption (Anthropic teams, Agent HQ, Linear) threatens any neutral layer; N providers × M semantics is a real maintenance tax; and the minimalist wave shows many practitioners will choose a bash script over any daemon they don't trust.

**Key sources:** [Beads repo](https://github.com/gastownhall/beads) · [Beads intro](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a) · [Beads best practices](https://steve-yegge.medium.com/beads-best-practices-2db636b9760c) · [Gas City](https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607) · [Gas Town Hall](https://gastownhall.ai/) · [Beads HN](https://news.ycombinator.com/item?id=46075616) · [ticket Show HN](https://news.ycombinator.com/item?id=46487580) · [Trekker Show HN](https://news.ycombinator.com/item?id=46709872) · [Beads LOC critique](https://news.ycombinator.com/item?id=46669791) · [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) · [Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) · [Taskmaster](https://github.com/eyaltoledano/claude-task-master) · [vibe-kanban shutdown](https://www.vibekanban.com/blog/shutdown) · [CCPM](https://github.com/automazeio/ccpm) · [claude-flow issues](https://github.com/ruvnet/claude-flow/issues/655) · [orchestrator survey](https://www.augmentcode.com/tools/open-source-agent-orchestrators) · [Linear for Agents](https://linear.app/agents) · [Linear Agent MCP](https://linear.app/changelog/2026-04-23-linear-agent-mcp-support) · ["Issue Tracking Is Dead" HN](https://news.ycombinator.com/item?id=47507253) · [Agents in Jira](https://www.businesswire.com/news/home/20260224033792/en/Atlassian-Introduces-Agents-in-Jira-to-Drive-Human-AI-Collaboration-at-Enterprise-Scale) · [GitHub Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/) · [Mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/) · [Backlog.md](https://github.com/MrLesk/Backlog.md) · [Beans](https://github.com/hmans/beans) · [Day in Gas Town (Dolt)](https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/) · [git-bug](https://github.com/git-bug/git-bug) · [Taskwarrior MCP](https://a2a-mcp.org/entry/mcp-warrior)
---
## Report 5: Academic / Protocols / Evals Literature
# Literature Review: Foundations and Evaluation of Multi-Agent Task Coordination (as of mid-2026)

Context: this informs an honest review of **OpenTasks**, a local-first shared task-graph layer (graph store + federated providers + daemon + MCP interface) intended as coordination infrastructure for LLM coding-agent swarms. No evals have been run yet; section 7(b) gives concrete designs.

---

## 1. Classic coordination theory and its LLM-era revival

The pre-LLM multi-agent systems (MAS) literature developed essentially every coordination primitive OpenTasks implements, and most have been explicitly revived in 2024–2026 LLM-agent papers:

- **Blackboard architectures** (Hearsay-II lineage) — directly revived. "Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture" ([arXiv:2507.01701](https://arxiv.org/abs/2507.01701)) builds a control unit + shared blackboard + role-specialized LLM agents and reports it is competitive with state-of-the-art static/dynamic MAS *while spending fewer tokens* — a notable data point that shared-state coordination can be token-cheaper than message passing. A follow-up applies the pattern to data-science information discovery ([arXiv:2510.01285](https://arxiv.org/abs/2510.01285)): a central agent posts requests to a shared blackboard and subordinate agents volunteer based on capability.
- **Stigmergy** (coordination via traces left in a shared environment) — revived in exactly OpenTasks' design space. **CodeCRDT** ([arXiv:2510.18893](https://arxiv.org/html/2510.18893)) is the closest prior art I found: LLM agents coordinate by *observing* a shared Yjs CRDT document, claiming TODOs via an optimistic write-verify protocol with provable at-most-one-winner safety under strong eventual consistency. Related: "Emergent Coordination in Multi-Agent Systems via Pressure Fields and Temporal Decay" ([arXiv:2601.08129](https://arxiv.org/pdf/2601.08129)) argues foundation models make stigmergic coordination practical in ways prior agent architectures couldn't; "Ledger-State Stigmergy" ([arXiv:2604.03997](https://arxiv.org/html/2604.03997v1)) formalizes indirect coordination grounded in shared ledger state.
- **Contract Net Protocol** (Smith 1980: announce → bid → award → commitment) — revived in token-economic form. "Cost-Effective Communication: An Auction-based Method for Language Agent Interaction" ([arXiv:2511.13193](https://arxiv.org/html/2511.13193v1)) explicitly frames CNP's negotiation cycle against LLM token economics. "Agent Contracts: A Formal Framework for Resource-Bounded Autonomous AI Systems" ([arXiv:2601.08815](https://arxiv.org/html/2601.08815), COINE@AAMAS 2026) extends the contract metaphor to resource-bounded execution, reporting ~90% token reduction and zero conservation violations in multi-agent delegation. COALESCE ([arXiv:2506.01900](https://arxiv.org/pdf/2506.01900)) covers economic task-allocation mechanisms for LLM agents.
- **HTN planning** — revived as the formal backbone for LLM task decomposition: ChatHTN ([arXiv:2505.11814](https://arxiv.org/pdf/2505.11814)), online learning of HTN methods for integrated LLM-HTN planning ([arXiv:2511.12901](https://arxiv.org/abs/2511.12901)), LLM-generated heuristics for HTN search ([arXiv:2605.07707](https://arxiv.org/html/2605.07707v1)). Consistent theme: LLMs propose decompositions; symbolic HTN machinery supplies the soundness guarantees LLMs lack.
- **Joint intentions / teamwork theory** (Cohen & Levesque's joint persistent goals; Tambe's STEAM, [arXiv:cs/9709101](https://arxiv.org/abs/cs/9709101)) — *not* substantially revived in LLM literature, which is a gap the failure-mode papers implicitly point at. The theory's core claim: a commitment isn't just "task assigned" — it obligates the holder to notify teammates when the goal is achieved, impossible, or irrelevant. MAST's "premature termination" and "information withholding" failure modes (Section 3) are precisely violations of joint-intention obligations.
- **Partial global planning / GPGP / TAEMS** (Durfee & Lesser; Decker & Lesser) — essentially dormant in LLM literature, but TAEMS is the closest historical analog to OpenTasks: a task graph with `enables`/`facilitates` edges, quality-accumulation functions, and commitments as first-class coordination objects. Nobody has rebuilt GPGP for LLM agents; the nearest modern equivalents are dependency-aware "ready work" queries in tools like Beads.

**Takeaway:** OpenTasks sits at the intersection of blackboard (shared readable state), stigmergy (coordination via observed graph changes — the Watchable trait), CNP (task claiming/assignment), and TAEMS (typed dependency edges). All four have LLM-era validation; the *commitment semantics* layer (joint intentions, decommitment) is the piece the modern literature has skipped — and the failure data suggests it matters.

---

## 2. How major LLM frameworks represent shared task state (2024–2026)

| System | Coordination substrate | Task state representation |
|---|---|---|
| **AutoGen (AG2)** | Asynchronous message passing, conversation protocols | Decentralized per-agent conversation context; no shared task object ([comparison](https://www.truefoundry.com/blog/autogen-vs-langgraph)) |
| **MetaGPT** | Shared message pool + role-based publish/subscribe | SOP-structured artifacts (PRD → design → code); roles subscribe to message types |
| **CAMEL** | Two-role role-playing dialogue | State lives entirely in the transcript |
| **LangGraph** | Explicit shared state object threaded through a node graph | Centralized typed State, checkpointed after every step (in-memory → Postgres/Redis); the closest framework analog to "shared task state as first-class citizen" ([comparison](https://qubittool.com/blog/langgraph-vs-autogen-multi-agent-frameworks)) |
| **OpenAI Swarm → Agents SDK** | Handoffs (control transfer carrying conversation context) + Sessions | Orchestrator-held; Swarm officially replaced by Agents SDK (March 2025); April 2026 overhaul added long-horizon harness, subagent primitive, file checkpointing ([docs](https://openai.github.io/openai-agents-python/)) |
| **CrewAI** | Sequential/hierarchical task lists + optional shared RAG-backed memory | Task outputs chained; practitioners report adding explicit central state for determinism ([crewAI discussion #4111](https://github.com/crewAIInc/crewAI/discussions/4111)) |
| **Anthropic's Research system** | Orchestrator-worker; lead agent decomposes, subagents work in isolated contexts | Lead agent's plan saved to **Memory** to survive context truncation; subagent outputs written **to the filesystem** "to minimize the 'game of telephone'" ([anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system)) |
| **Beads** (Yegge, 2025) | Git-backed dependency-aware issue graph; `bd ready` surfaces unblocked work | Direct ecosystem neighbor of OpenTasks — 18k+ GitHub stars; solves the "50 First Dates" cross-session amnesia problem ([steveyegge.github.io/beads](https://steveyegge.github.io/beads/)) |

The clear 2025→2026 trend: **away from pure message passing, toward durable artifact/file/graph-based shared state**. Anthropic's production advice — persist plans to memory, write subagent outputs to a filesystem rather than relaying through the coordinator — endorses exactly the artifact-pointer pattern OpenTasks' context-files implement.

---

## 3. Failure-mode literature: MAST and successors

**MAST** ("Why Do Multi-Agent LLM Systems Fail?", Berkeley, [arXiv:2503.13657](https://arxiv.org/abs/2503.13657)) annotated 200+ traces (later 1600+ in MAST-Data) across 7 frameworks (MetaGPT, ChatDev, HyperAgent, AppWorld, AG2, Magentic-One, OpenManus), inter-annotator κ = 0.88. The 14 failure modes with frequencies:

- **FC1 Specification issues (41.8%)**: disobey task spec (11.0%), disobey role spec (0.5%), **step repetition (17.1%)**, **loss of conversation history (3.3%)**, unaware of termination conditions (9.8%)
- **FC2 Inter-agent misalignment (36.9%)**: conversation reset (2.3%), fail to ask for clarification (11.7%), **task derailment (7.2%)**, information withholding (1.7%), ignored other agent's input (0.2%), reasoning-action mismatch (14.0%)
- **FC3 Task verification (21.3%)**: **premature termination (7.8%)**, no/incomplete verification (6.8%), incorrect verification (6.7%)

Directly task/state-management-related modes — step repetition (duplicate work), history loss, termination unawareness, task derailment, premature termination, verification gaps — together account for roughly **half of all observed failures**. These are precisely what a persistent task graph with status, ownership, dependencies, and verification hooks claims to address. MAST's tested interventions were modest: better role specs gave ChatDev +9.4% success; a multi-level verification architecture gave +15.6% absolute on ProgramDev — the authors conclude structural solutions, not prompt patches, are needed. MAST also ships a **validated LLM-as-judge annotation pipeline**, reusable in your own evals.

Successors (2025–2026): **TRAIL** (Deshpande et al. 2025 — turn-level trace taxonomy; finds even strong long-context models struggle to debug agent traces), failure-*attribution* work answering "which agent, which step, which error" ([arXiv:2509.13782](https://arxiv.org/pdf/2509.13782); also Who&When, AgenTracer, RAFFLES), **DoVer** intervention-driven auto-debugging ([arXiv:2512.06749](https://arxiv.org/pdf/2512.06749)), **EAGER** ([arXiv:2603.21522](https://arxiv.org/html/2603.21522v1)), and IBM/Berkeley applying MAST to enterprise IT agents ([huggingface.co/blog/ibm-research/itbenchandmast](https://huggingface.co/blog/ibm-research/itbenchandmast)).

---

## 4. Interoperability protocols and task lifecycle semantics (status mid-2026)

- **MCP** (Anthropic) — the de facto tool-access standard; JSON-RPC client-server; **no task lifecycle semantics of its own** (tasks are whatever tools expose). OpenTasks' MCP server is the idiomatic integration path.
- **A2A** (Google → **Linux Foundation**, spec v1.0.0, 150+ supporting orgs as of April 2026) — the one protocol with real task lifecycle semantics, and the reference point OpenTasks should map onto ([spec](https://a2a-protocol.org/latest/specification/); [LF press release](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)). Key semantics: `Task` is "the fundamental unit of work managed by A2A," with states `submitted → working → {input-required, auth-required} → {completed, failed, canceled, rejected}`; **the remote agent owns task state** (clients cannot mint task IDs); **Artifacts are separated from Messages** (data output vs communication); terminal states are immutable; streaming is explicitly *not* a reliable delivery mechanism — durable state is. Contrast: A2A tasks are remote-agent-owned and dyadic (client↔server); OpenTasks' graph is *shared, multi-reader/multi-writer with explicit typed edges* — a different and complementary model.
- **ACP** (IBM/BeeAI; REST-mapped task verbs: POST create, GET status, PUT update, DELETE cancel) — **merged into A2A under the Linux Foundation**; BeeAI now runs on A2A ([i-am-bee discussion #5](https://github.com/orgs/i-am-bee/discussions/5); [agentcommunicationprotocol.dev](https://agentcommunicationprotocol.dev/introduction/welcome)).
- **AGNTCY** (Cisco/LangChain/Galileo et al.) — donated to the Linux Foundation in July 2025; its work largely folded into the A2A orbit. **ANP** (DID-based open-network discovery, JSON-LD graphs) remains niche/academic.
- Surveys: [arXiv:2505.02279](https://arxiv.org/abs/2505.02279) (MCP/ACP/A2A/ANP comparison + phased adoption roadmap) and [arXiv:2504.16736](https://arxiv.org/pdf/2504.16736) (broader AI agent protocol survey).

The landscape consolidated to **MCP for tools + A2A for inter-agent tasks**. Neither standardizes a *shared task graph with typed dependency edges* — genuinely unclaimed territory — but OpenTasks should articulate its mapping onto A2A task states (its MAP `closed`↔`completed` mapping is the right instinct).

---

## 5. Evaluation benchmarks and what they measure

**Coordination-specific:**
- **MultiAgentBench / MARBLE** ([arXiv:2503.01935](https://arxiv.org/abs/2503.01935), ACL 2025; [github.com/ulab-uiuc/MARBLE](https://github.com/ulab-uiuc/MARBLE)) — the headline coordination benchmark. Metrics: milestone-based KPIs, planning-quality and **communication scores**, per-agent contribution; ablates coordination **topologies** (star/chain/tree/graph — graph topology won for research tasks).
- **Collab-Overcooked** ([arXiv:2502.20073](https://arxiv.org/abs/2502.20073), EMNLP 2025) — process-oriented collaboration metrics (initiating vs responding to collaboration); 13 LLMs tested; finding: LLMs interpret goals well but fail at *active* collaboration and continuous adaptation.
- **SwarmBench** ([arXiv:2505.04364](https://arxiv.org/abs/2505.04364)) — decentralized swarm coordination (pursuit, foraging, flocking, transport) under local perception/communication constraints.
- **AgentsNet** ([arXiv:2507.08616](https://arxiv.org/abs/2507.08616)) — classic distributed-computing problems (leader election, consensus, graph coloring, matching, vertex cover) scaled to 100 agents.

**Realistic agentic work:**
- **TheAgentCompany** ([arXiv:2412.14161](https://arxiv.org/abs/2412.14161)) — simulated software company (GitLab/ownCloud/RocketChat, NPC coworkers); **checkpoint-based partial credit**; best agents ~30% autonomous completion at launch, long-horizon tasks still failing in 2026.
- **SWE-bench Verified / Pro** — Pro keeps a structural ~20–25 pt gap below Verified (Opus-class: ~87% Verified vs ~53% Pro per [2026 trackers](https://www.digitalapplied.com/blog/swe-bench-terminal-bench-benchmark-guide-2026)); **terminal-bench** is the rising shell-agent standard ([tracker](https://benchmarkingagents.com/terminal-bench/)); **GAIA** is effectively saturated at the top tiers.
- **Galileo Agent Leaderboard v2** ([galileo.ai/blog/agent-leaderboard-v2](https://galileo.ai/blog/agent-leaderboard-v2)) — enterprise multi-turn scenarios; two reusable metrics: **Action Completion** (every user goal met) and **Tool Selection Quality** (right tool, right args).

**Methodological caution:** "Establishing Best Practices for Building Rigorous Agentic Benchmarks" / the Agentic Benchmark Checklist ([arXiv:2507.02825](https://arxiv.org/pdf/2507.02825); [checklist site](https://uiuc-kang-lab.github.io/agentic-benchmarks/)) documents that weak reward functions and task shortcuts distort reported agent performance by up to ~100% relative; 2026 work shows frontier agents reward-hack realistic eval setups at high rates. Any OpenTasks eval needs outcome checks agents can't game by editing the task graph itself — "task marked done" must be verified against tests, never trusted.

---

## 6. Does shared task/memory state actually help? The empirical record

Honest answer: **conditionally, and the conditions are now well characterized.**

**Against (or null), under controlled budgets:**
- Tran & Kiela, "Single-Agent LLMs Outperform Multi-Agent Systems on Multi-Hop Reasoning Under Equal Thinking Token Budgets" ([arXiv:2604.02460](https://arxiv.org/html/2604.02460v1)): with thinking tokens held equal across 5 MAS topologies (sequential, subtask-parallel, parallel-roles, debate, ensemble), single-agent matched or beat all of them on FRAMES/MuSiQue across 4 models; MAS message-passing creates information bottlenecks (Data Processing Inequality framing). MAS only became competitive when single-agent *context was heavily corrupted* (~70% noise) — i.e., multi-agent is a remedy for context degradation, not a reasoning amplifier.
- **"Towards a Science of Scaling Agent Systems"** ([arXiv:2512.08296](https://arxiv.org/html/2512.08296v1)) — the most useful single paper for eval design. Findings: (1) **capability saturation** — coordination yields diminishing/negative returns once the single-agent baseline exceeds ~45% (β=−0.408, p<0.001); (2) **topology-dependent error amplification** — independent agents amplify errors **17.2×** vs **4.4×** under centralized coordination; (3) sequential-reasoning tasks *degraded 39–70%* under every multi-agent variant, while parallelizable tasks gained up to **+80.9%** under centralized coordination. Their predictive model (cross-validated R²=0.513) uses exactly the metrics you'd want to report: coordination efficiency, overhead, error amplification, redundancy.
- Cognition, "Don't Build Multi-Agents" ([cognition.ai/blog/dont-build-multi-agents](https://cognition.ai/blog/dont-build-multi-agents)): parallel subagents are fragile due to context isolation → conflicting decisions; default to single-threaded agents with context compression.

**For, under the right task structure:**
- Anthropic ([engineering blog](https://www.anthropic.com/engineering/multi-agent-research-system)): Opus 4 orchestrator + Sonnet 4 subagents beat single Opus 4 by **90.2%** on an internal *breadth-first research* eval — but at **15× chat token cost** (vs 4× for a single agent), with token usage alone explaining ~80% of performance variance on BrowseComp. Explicit caveats: "most coding tasks involve fewer truly parallelizable tasks than research"; multi-agent only makes economic sense when task value covers the token premium.
- **CodeCRDT** ([arXiv:2510.18893](https://arxiv.org/html/2510.18893)) — the nearest thing to a direct OpenTasks ablation: shared-state TODO-claiming across 600 trials (6 TypeScript/React tasks × 50 runs × 2 modes, Claude Sonnet 4.5). Headline: 13.1% average *slowdown* raw, but normalized per output character, parallel was 11–52% faster on 5/6 tasks; speedup correlated with **component independence**; 100% CRDT convergence and zero character-level merge conflicts, but **5–10% semantic conflicts** (duplicate declarations, type mismatches) that syntactic convergence can't catch. Lesson: a task graph prevents claim collisions but not semantic integration failures.
- Shared/collaborative memory ablations are positive: G-Memory hierarchical multi-agent memory ([arXiv:2506.07398](https://arxiv.org/abs/2506.07398)), Collaborative Memory with dynamic access control ([arXiv:2505.18279](https://arxiv.org/abs/2505.18279)), MemCollab cross-agent trajectory distillation ([arXiv:2603.23234](https://arxiv.org/pdf/2603.23234)). The blackboard result (arXiv:2507.01701) adds: shared state beat message-passing MAS *on tokens*, because agents read one board instead of N pairwise threads.
- Practitioner synthesis ([philschmid.de/single-vs-multi-agents](https://www.philschmid.de/single-vs-multi-agents)): "read" tasks (research, analysis) parallelize well; "write" tasks (most coding) don't — coordination conflicts dominate.

---

## 7. Conclusions for OpenTasks

### (a) What theory says a shared task-graph layer must provide

Synthesizing CNP, joint-intentions theory, TAEMS/GPGP, blackboard systems, and the A2A spec, a task layer is a *coordination* layer (not just a database) only if it provides:

1. **Exclusive claiming / ownership transfer** — at-most-one-owner semantics with an auditable claim/award event (CNP award; CodeCRDT's write-verify claim). OpenTasks' TaskManageable `start`/assignment maps here; the open question is whether claims are atomic under concurrent daemon clients.
2. **Commitment semantics including decommitment** — Cohen & Levesque: a commitment obligates notifying the team when the task is done, impossible, or moot. Concretely: status transitions must be *broadcast* (Watchable), and "blocked"/"abandoned" must be first-class states — otherwise you reproduce MAST's premature-termination and termination-unawareness modes (~18% of failures combined).
3. **Typed dependency edges driving a ready-set** — TAEMS `enables`/`facilitates`; Beads' `bd ready`. The graph must answer "what is unblocked now" cheaply, or agents fall back to re-reading everything.
4. **Result integration separate from chatter** — A2A's Artifact-vs-Message split; Anthropic's filesystem-artifact advice. OpenTasks' context-file nodes (pointer + content hash + drift detection) are this; drift detection targets the verification category MAST says dominates residual failures.
5. **Verification hooks** — "done" must be distinguishable from *verified* done (MAST FC3 = 21.3% of failures; the reward-hacking literature says never trust agent-asserted completion).
6. **Observability for stigmergy** — agents coordinate by watching the graph change; eventing granularity and latency are functional requirements, not nice-to-haves.

### (b) The 3–5 most credible cheap eval designs

All runnable with Claude Code agents on a Max plan; each isolates the *task layer* as the only variable.

**E1 — Parallel-swarm conflict/duplication ablation (highest priority; CodeCRDT replication).**
- *Tasks:* 5–8 decomposable repo tasks (multi-component feature builds — reuse CodeCRDT's 6 UI-task design, or bundle 3 SWE-bench Verified / terminal-bench issues per repo), 10–20 runs per condition.
- *Baseline A:* N=3 agents sharing only the repo + a markdown TODO file. *Baseline B:* orchestrator-held task list (lead agent spawning subagents). *Treatment:* same N agents wired to OpenTasks via MCP (create/claim/complete + dependency edges).
- *Metrics:* completion (tests pass — external verification, not graph state); **duplicate-claim rate**; **semantic conflict rate** (duplicate declarations, conflicting edits — expect 5–10% residual per CodeCRDT); wall-clock; total tokens; **coordination-overhead fraction** (task-layer tokens ÷ total).
- *Honest hypothesis:* OpenTasks cuts duplication/conflicts vs markdown-TODO at small token premium; expect the benefit to shrink as model capability rises (arXiv:2512.08296) — report per model.

**E2 — Cross-session continuity ("50 First Dates" eval).**
- *Tasks:* 5 long-horizon tasks from TheAgentCompany (checkpoint scoring built in) or multi-session repo epics; kill the agent every K turns, restart with a fresh context window, 3–5 resets per task.
- *Baseline:* restart with repo + whatever markdown notes the agent left. *Treatment:* restart with the OpenTasks graph (tasks, statuses, context-file pointers) via MCP.
- *Metrics:* checkpoint progress at fixed total budget; **redundant re-exploration tokens** (re-reading files already analyzed pre-reset); time-to-first-productive-action after restart; final completion. Single-agent, so cheap; Beads' organic adoption predicts this shows the clearest win.

**E3 — Handoff quality (MAST-instrumented).**
- *Design:* Agent A decomposes a task and completes ~half, then hard-stops; Agent B (fresh context, new session) must finish. ~20 tasks × 2 conditions.
- *Baseline:* B receives A's transcript summary (status-quo handoff). *Treatment:* B receives only the OpenTasks graph (task nodes, edges, context-file pointers with drift status).
- *Metrics:* completion; rework rate (B redoing A's finished subtasks); **MAST failure-mode incidence scored with the paper's released LLM-as-judge pipeline** (arXiv:2503.13657) — especially step repetition, history loss, task derailment, premature termination. Using an externally validated taxonomy makes this publishable rather than anecdotal.

**E4 — Token-matched single-agent control (the honesty check).**
- *Design:* per Tran & Kiela (arXiv:2604.02460), give one long-context agent the *same total token budget* as the E1 swarm+OpenTasks condition, on the same tasks.
- *Metrics:* completion per token; wall-clock (the legitimate multi-agent win at token parity is latency via parallelism). If swarm+OpenTasks only wins wall-clock, say so — still a real result, and it's the claim reviewers will scrutinize first.

**E5 — Verification-gap audit (cheap add-on to E1–E3).**
- *Metric:* divergence between graph-asserted state and ground truth — tasks marked `closed` whose tests fail; stale context-file pointers actually consumed by agents, with drift detection off vs on. Targets MAST FC3 and the reward-hacking concern (arXiv:2507.02825); also the eval most specific to OpenTasks' differentiating features (drift detection, provider reconciliation).

For every eval, report per-condition tokens, latency, and topology — the scaling-science paper's coordination metrics (efficiency, overhead, error amplification, redundancy) are the emerging standard vocabulary. Anthropic's methodology advice applies: start with ~20 hand-checked queries + an LLM-judge rubric (factual accuracy, completeness, tool efficiency) and end-state evaluation before building anything heavier.

### (c) Where the literature says shared task graphs help vs don't

**Help:**
- Parallelizable, read-heavy, breadth-first work exceeding one context window (Anthropic; philschmid's read-vs-write framing)
- Component-independent parallel code generation (CodeCRDT: speedup correlates with independence)
- **Cross-session persistence and resumability** — uncontested in the literature, validated by Beads' adoption; arguably OpenTasks' strongest claim since it is orthogonal to the single-vs-multi-agent debate
- Containing error amplification: centralized/shared-state coordination held amplification to 4.4× vs 17.2× for uncoordinated agents (arXiv:2512.08296)
- Token-efficient coordination vs N² pairwise message passing (blackboard result, arXiv:2507.01701)
- Weaker models / harder task regimes, where coordination benefits concentrate (arXiv:2512.08296)

**Don't help (or hurt):**
- Tightly coupled sequential reasoning/writing — all multi-agent variants degraded performance 39–70% (arXiv:2512.08296); "most coding tasks involve fewer truly parallelizable tasks than research" (Anthropic)
- Equal-token-budget reasoning with a clean context — single agent wins (arXiv:2604.02460)
- Strong models on tasks they already do well (capability saturation above ~45% single-agent baseline)
- Low-value tasks — the ~15× token premium must be paid for
- Semantic integration: CodeCRDT achieved 100% claim-safety yet still 5–10% semantically conflicting outputs. A shared graph removes *coordination* failures (MAST FC1/FC2, ~79% of failures) but *verification* (FC3) needs hooks beyond state tracking.

**Bottom line for the review:** the literature supports OpenTasks' premise narrowly, not broadly. Defensible claims — persistence/resumability, duplicate-work prevention in parallel swarms, error containment via shared authoritative state — are each cheaply measurable with E1/E2/E3. The claim to avoid (controlled studies contradict it) is that a shared task layer makes agent collectives smarter on coupled work. E4's token-matched control is what separates an honest result from the kind of multi-agent claim the 2026 literature has learned to discount.

---

### Source index

Theory revival: [arXiv:2507.01701](https://arxiv.org/abs/2507.01701), [arXiv:2510.01285](https://arxiv.org/abs/2510.01285), [arXiv:2510.18893](https://arxiv.org/html/2510.18893) (CodeCRDT), [arXiv:2511.13193](https://arxiv.org/html/2511.13193v1), [arXiv:2601.08815](https://arxiv.org/html/2601.08815), [arXiv:2506.01900](https://arxiv.org/pdf/2506.01900), [arXiv:2505.11814](https://arxiv.org/pdf/2505.11814), [arXiv:2511.12901](https://arxiv.org/abs/2511.12901), [arXiv:2605.07707](https://arxiv.org/html/2605.07707v1), [arXiv:cs/9709101](https://arxiv.org/abs/cs/9709101), [arXiv:2601.08129](https://arxiv.org/pdf/2601.08129), [arXiv:2604.03997](https://arxiv.org/html/2604.03997v1) · Failure modes: [arXiv:2503.13657](https://arxiv.org/abs/2503.13657) (MAST), [arXiv:2509.13782](https://arxiv.org/pdf/2509.13782), [arXiv:2512.06749](https://arxiv.org/pdf/2512.06749), [arXiv:2603.21522](https://arxiv.org/html/2603.21522v1), [IBM/Berkeley IT-Bench+MAST](https://huggingface.co/blog/ibm-research/itbenchandmast) · Protocols: [A2A spec v1.0.0](https://a2a-protocol.org/latest/specification/), [LF A2A](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents), [ACP→A2A merger](https://github.com/orgs/i-am-bee/discussions/5), [arXiv:2505.02279](https://arxiv.org/abs/2505.02279), [arXiv:2504.16736](https://arxiv.org/pdf/2504.16736) · Benchmarks: [arXiv:2503.01935](https://arxiv.org/abs/2503.01935) (MultiAgentBench), [arXiv:2502.20073](https://arxiv.org/abs/2502.20073) (Collab-Overcooked), [arXiv:2505.04364](https://arxiv.org/abs/2505.04364) (SwarmBench), [arXiv:2507.08616](https://arxiv.org/abs/2507.08616) (AgentsNet), [arXiv:2412.14161](https://arxiv.org/abs/2412.14161) (TheAgentCompany), [Galileo v2](https://galileo.ai/blog/agent-leaderboard-v2), [arXiv:2507.02825](https://arxiv.org/pdf/2507.02825) (rigorous-benchmark checklist) · Evidence: [arXiv:2604.02460](https://arxiv.org/html/2604.02460v1), [arXiv:2512.08296](https://arxiv.org/html/2512.08296v1), [Anthropic blog](https://www.anthropic.com/engineering/multi-agent-research-system), [Cognition blog](https://cognition.ai/blog/dont-build-multi-agents), [philschmid](https://www.philschmid.de/single-vs-multi-agents), [arXiv:2506.07398](https://arxiv.org/abs/2506.07398) (G-Memory), [arXiv:2505.18279](https://arxiv.org/abs/2505.18279), [arXiv:2603.23234](https://arxiv.org/pdf/2603.23234), [Beads](https://steveyegge.github.io/beads/)

*Note on recency: arXiv IDs from 2026 (26xx.xxxxx) and post-2025 status claims (A2A v1.0.0, ACP merger, SWE-bench Pro gaps, OpenAI Agents SDK 2026 releases) come from live web search/fetch during this session; pre-2026 sources were additionally cross-checked against the papers' abstract pages.*