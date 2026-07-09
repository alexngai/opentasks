# OpenTasks — Implementation Status (as-built)

**Last updated:** 2026-07-02 · **Package version:** 0.1.4

This is the **as-built** inventory: what actually ships and runs today, versus what
is designed/planned. The design docs ([ARCHITECTURE.md](./ARCHITECTURE.md),
[DESIGN.md](./DESIGN.md), [PERSISTENCE.md](./PERSISTENCE.md)) describe *intent* and
include features not yet implemented — read them as design notes, not as
descriptions of current behavior.

Legend: ✅ implemented & tested · 🟡 partial / caveats · ⏳ planned (not in code)

## Providers

All 7 are registered in `src/providers/from-config.ts`:

| Provider | Scheme | Status | Notes |
|---|---|---|---|
| Native | `native://` | ✅ | Graph-backed; full CRUD + lifecycle state machine |
| Beads | `beads://` | ✅ | Shells out to the `bd` CLI; chokidar watcher; deepest external provider |
| Claude Tasks | `claude://` | ✅ | Ingests Claude Code native tasks (filesystem) |
| Sudocode | `sudocode://` | ✅ | Two-way sync target |
| Sessionlog | `sessionlog://` | ✅ | Session/checkpoint provider |
| Global store | `global://` | ✅ | Federates to `~/.opentasks` over IPC |
| MAP | `map://` | ✅ | Inbound, ephemeral pass-through (no local cache) |
| Jira / Linear / GitHub | `jira://` etc. | ⏳ | **Not implemented.** Referenced in docs/diagrams as the target design; no provider files exist. `external` nodes can still hold bare `jira://`-style URIs as edge targets, but their data is not resolved. |
| git-cascade | `cascade://` | ⏳ | Planned ingestion |

## Core graph

| Capability | Status |
|---|---|
| Node CRUD (context/task/feedback/external/attempt), edges | ✅ |
| Cycle-checked `blocks` edges | ✅ |
| 12 edge types (`blocks`, `implements`, `references`, `related`, `parent-of`, `child-of`, `duplicates`, `supersedes`, `depends-on`, `discovered-from`, `verifies`, `reproduces`) + custom strings | ✅ |
| `ready()` / `blockers()` (incl. transitive) queries | ✅ |
| Annotations (feedback) with anchoring, threading, resolution | ✅ |
| Attempt/verify: `attempt` nodes + `verifies`/`reproduces` edges (see [ATTEMPT-VERIFY-SCHEMA.md](./ATTEMPT-VERIFY-SCHEMA.md)) | ✅ |
| Context-files: pointer + content-hash + git-commit pinning + drift detection | ✅ |
| Hash-based collision-resistant IDs (`c-`/`t-`/`f-`/`e-`/`a-` nodes, `x-` edges) | ✅ |

## Daemon, storage & sync

| Capability | Status | Notes |
|---|---|---|
| Unix-socket daemon + IPC | ✅ | Single-daemon guarantee via `proper-lockfile` on `daemon.lock` |
| SQLite query cache + JSONL persistence | ✅ | JSONL is the git-tracked source of truth |
| JSONL write model | 🟡 | Daemon writes a **full-file snapshot on a debounced flush** — *not* literally append-only (the README/design docs previously implied otherwise) |
| chokidar file watcher + reload/reconcile | ✅ | |
| Git sync (auto-commit/-push/-pull, merge driver) | ✅ | `sync.now/pull/status/reload` IPC methods |
| Multi-machine consistency | 🟡 | Last-writer-wins via a wall-clock (`updated_at`) field-level merge driver; no causality/vector clocks |
| Flush ↔ git-pull serialization | ✅ | `sync.now`/`sync.pull` drain→pause→git→reload→resume so a pending flush can't overwrite freshly-pulled state (P2, `f2ed408`). Residual: a write *during* the brief sync window — see [SYNC.md](./SYNC.md) |
| Daemon auto-start from CLI | ✅ | Tool commands auto-start a daemon on first use; opt out with `--no-autostart` or `OPENTASKS_NO_AUTOSTART=1` |

## MCP server

✅ 22 tools across 5 scopes (`tasks`, `graph`, `annotate`, `context`, `attempts`) — including
atomic claiming (`claim_task`/`claim_next`/`release_task`/`renew_claim`), change polling
(`events_since`), and attempt/verify (`record_attempt`/`list_attempts`). The daemon
auto-starts on first use. Register with
`claude mcp add opentasks -- npx opentasks mcp --scope all`.

## Multi-agent coordination primitives

The substrate features for multi-agent coordination:

| Primitive | Status | Notes |
|---|---|---|
| Assignment / ownership | 🟡 | Plain `assignee` string (non-atomic); for exclusive ownership use atomic claim below |
| Atomic claim / `claimNext` | ✅ 🟡 | Single conditional SQLite UPDATE (no TOCTOU); `claimNext` fuses ready-query + claim. Via `client.task({claim})`, MCP `claim_task`/`claim_next`, CLI (P1). **Native tasks only** — external providers (beads/MAP/sudocode) model ownership their own way and are rejected with `NOT_SUPPORTED` |
| Leases / heartbeat / dead-agent reclaim | ✅ | `lock_until` lease; expired claims are stealable; `renew_claim` heartbeat; 60s daemon reaper actively clears expired claims (P1) |
| Fenced `release` / `renew` | ✅ | `claim_fence` token bumped per claim; release/renew reject a stale/superseded fence (P1) |
| Terminal outcomes | ✅ | `failed` / `abandoned` distinct from `closed`. MAP round-trip is lossless for `completed`↔`closed` and `failed`↔`failed`; `abandoned` maps to MAP `failed` (MAP has no abandoned state) (P1) |
| Change events to client/MCP | ✅ | `client.subscribe` with resume cursor + `onResync` backfill; MCP `events_since` polling tool |
| Idempotent writes | ✅ | Client-supplied `idempotencyKey` on writes, deduplicated daemon-side (`src/daemon/idempotency.ts`) |

## Documented but not implemented

Present in the design docs only — **no current implementation**:

- Compaction / tier1–tier2 LLM summarization (`ARCHITECTURE.md`)
- Recovery service (`recoverFromTombstone` / `recoverFromSnapshot` / `recoverFromGit`)
- Cross-location query expansion (`ancestors` / `descendants` / `siblings` / `all`)
