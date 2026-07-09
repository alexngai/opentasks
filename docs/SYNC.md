# OpenTasks Consistency & Sync Model

The honest, as-built consistency model. For the broader status see
[STATUS.md](./STATUS.md).

## TL;DR

- **One daemon per location = single writer.** Within it, all writes are
  serialized (Node is single-threaded) and SQLite is the working authority.
- **JSONL is the git-tracked source of truth**, written by a debounced flush as
  a full-file snapshot (atomic temp+rename) — *not* append-only.
- **Atomic claiming is race-free** — a single conditional SQLite `UPDATE`.
- **Coordination-critical writes are durable** (flushed before the RPC returns);
  ordinary edits use a ~5s debounce.
- **Multi-machine convergence is last-writer-wins by wall-clock** via a git merge
  driver — **no causality**. Clock skew can pick the wrong winner (F8, deferred).

## Storage layers

| Layer | File | Role |
|---|---|---|
| SQLite | `cache.db` (gitignored) | Working authority — all reads/writes; rebuilt from JSONL on startup |
| JSONL | `graph.jsonl` (git-tracked) | Durable source of truth; full-file snapshot on flush |

The daemon's flush manager debounces SQLite→JSONL writes (default 5s debounce,
30s max delay). The flush is a full-file `save()` via atomic temp-file + rename,
so `graph.jsonl` is never observed partially written.

## Durability tiers (P2.2)

| Tier | Operations | Persistence |
|---|---|---|
| **Durable** | `claim` / `release` / `renew` / `claimNext`; terminal transitions (`complete` / `close` / `fail` / `abandon`) | Flushed to JSONL **before the RPC returns** |
| **Debounced** | field updates, `assign`, non-terminal transitions (`start` / `block` / `reopen`) | Flushed within the debounce window (≤5s) |

**Crash window:** a *debounced* write not yet flushed is lost on a hard crash
(`kill -9`). *Durable* writes (claims, terminal outcomes) are not — they are on
disk before the caller is told the operation succeeded. (While a git sync has
the flush paused, a durable flush is a no-op; the node stays dirty and is
flushed when sync resumes — still within the brief sync window.)

## Git sync (single machine ↔ remote)

- **Auto-sync timer:** commits and pushes on an interval. It **never pulls**, so
  it cannot hit the flush-vs-pull race.
- **`sync.now`:** commit → pull → push. **`sync.pull`:** commit → pull (no push).
- **Flush ↔ pull serialization (P2.1, the F2 fix):** `sync.now`/`sync.pull`
  drain the pending flush, **freeze** it, run the git op, then **reload** SQLite
  from the (possibly merged) JSONL — only when a pull actually changed the file —
  then resume. This prevents a pending debounced flush from firing mid-pull and
  overwriting freshly-pulled data. `sync.pull` commits first so the merge driver
  merges local+remote instead of git refusing the pull over uncommitted changes.
- **Merge driver:** field-level 3-way merge keyed by `updated_at`;
  provider-authoritative conflicts are flagged `provider_needs_reconcile`.

## Graceful shutdown (P2.3)

On `SIGTERM`/`SIGINT` the daemon: stops the IPC server (no new writes) → stops
watchers and background timers → **`finalFlush()`** (drains all dirty nodes to
JSONL) → best-effort final commit+push → closes the store. Bounded by a
shutdown timeout. So an orderly stop never loses pending writes.

## Known limitations / residual races

- **Write-during-sync (F2 residual):** a write that arrives *during* the brief
  sync window can be clobbered by the post-pull reload. The window is small
  (one pull) and the complete fix is tied to multi-machine causality (F8).
- **Multi-machine LWW by wall-clock (F8):** two machines that both edit the same
  node and push converge by ISO-timestamp comparison, not causality. Clock skew
  can silently pick the wrong winner. There is no vector clock, CRDT, or
  operation log.

## Deferred decisions (P2.5)

- **Vector clocks / CRDT / storage-engine change (e.g. Dolt-style):** **deferred.**
  Single-daemon single-writer + the git merge driver is sufficient for the
  dominant single-machine and worktree-swarm use cases, and a full causality
  layer is a large investment with its own failure modes. **Revisit when:** (1) a
  real cross-machine corruption is reported; (2) a multi-writer-at-scale
  deployment loses data to wall-clock LWW; or (3) the Beads/Dolt model becomes
  the user expectation. (Beads' JSONL→Dolt pivot is the cautionary precedent —
  don't fight that fight late.)
- **Per-record monotonic sequence numbers:** **deferred to P3 (events)**, where
  replay cursors actually consume them. Cursors start from "now", so historical
  records need no retroactive sequence; adding an unused column to the hot write
  path now would carry risk without benefit.
