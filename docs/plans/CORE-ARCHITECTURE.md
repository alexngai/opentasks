# OpenTasks Core Architecture

> Spec ID: c-9jju | Tags: architecture, core, cross-location, multi-agent
>
> **Revised**: Incorporates single-daemon model, location hashes, explicit connections,
> provider-based cross-location queries, append-only JSONL, and custom merge driver.

## Overview

OpenTasks is a **graph connector** that links heterogeneous task and context systems. It does not replace existing tools — each keeps its own interface, storage, and semantics. OpenTasks provides the **relationship layer** that existing tools lack.

### What OpenTasks Is
- A graph layer over existing tools (Claude Tasks, Beads, Taskmaster, Jira, etc.)
- Cross-system edges that span system boundaries
- Unified queries for blockers, ready items, and dependencies across all connected systems
- Optional native storage for lightweight context/issues when external providers aren't needed

### What OpenTasks Is NOT
- Not a replacement for Claude's built-in tasks (use `TaskCreate`/`TaskUpdate` directly)
- Not a replacement for Beads (use `bd` CLI directly)
- Not a unified CRUD API (each system keeps its own interface)

---

## Core Concepts

### Node Types

| Type | Purpose | Storage |
|------|---------|---------|
| `spec` | User intent, requirements, context | Native (graph.jsonl) or provider |
| `issue` | Actionable work items | Native (graph.jsonl) or provider |
| `feedback` | Comments, suggestions, anchored discussion | Native (graph.jsonl) |
| `external` | Cached references to external systems | Native (graph.jsonl) |

### Edges

Edges are the primary value of OpenTasks. They connect nodes across system boundaries:

```
claude://current/t-abc ──implements──▶ beads://./bd-x7k9
beads://./bd-x7k9 ──blocks──▶ jira://PROJ-123
taskmaster://./prd ◀──discovered-from── beads://./bd-y8z0
```

**Core edge types**: `blocks`, `implements`, `references`, `related`
**Extended types**: `parent-of`, `child-of`, `duplicates`, `supersedes`, `depends-on`, `discovered-from`

### The 3-Tool Interface

Agents use native tools for CRUD (TaskCreate, bd new, etc.). OpenTasks provides 3 tools for the graph layer:

| Tool | Purpose |
|------|---------|
| `link()` | Create/remove edges between any nodes |
| `query()` | Find relationships, blockers, ready items |
| `annotate()` | Add cross-system feedback |

---

## URI Schemes

### Provider URIs

Reference nodes in external systems:

```
claude://[session]/[task-id]      # Claude Code task
beads://[workspace]/[id]          # Beads issue
taskmaster://[project]/[id]       # Taskmaster PRD/task
linear://[team]/[id]              # Linear issue
jira://[project]/[key]            # Jira issue
github://[owner]/[repo]/[num]     # GitHub issue
native://[type]/[id]              # OpenTasks native node
```

**Relative notation**: `beads://./bd-123` means current workspace
**Implicit current**: `beads://bd-123` equivalent to `beads://./bd-123`

### OpenTasks URIs (Phase 2+)

Reference nodes in other OpenTasks locations using deterministic location hashes:

```
opentasks://k7m2x9p4/t-x7k9           # By location hash (preferred, stable)
opentasks://./t-x7k9                    # Current location (relative convenience)
opentasks:///abs/path/.opentasks/c-g8h9 # Absolute path (fallback)
```

**Location hash**: 8-character base36 derived from `SHA256(git_remote_url + ":" + repo_relative_path)`. Deterministic across machines for the same repo. See [PHASE-2.md](./PHASE-2.md) for details.

---

## Cross-Location Model

### Location Identity

Each `.opentasks/` directory has a deterministic identity stored in `config.json`:

```json
{
  "location": {
    "hash": "k7m2x9p4",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "name": "myapp"
  }
}
```

- **hash**: Deterministic, derived from git remote + path. Primary identifier in URIs and connections.
- **uuid**: Random UUID v4, generated at init. Uniqueness guarantee for edge cases (no remote, path collisions).
- **name**: Human-readable label. Informational only.

### Isolation by Default

Each location is **isolated by default**:
- Queries only return nodes from the current location
- No automatic inheritance from parent locations
- No automatic discovery of child locations
- Explicit connectivity via edges with URIs or declared connections

### Explicit Connections (Not Discovery)

Locations are connected via explicit declarations in `config.json`:

```json
{
  "connections": [
    { "hash": "m3p8q2w5", "path": "../other-repo/.opentasks/", "role": "peer" },
    { "hash": "r7t1v9z3", "path": "../../shared-context/.opentasks/", "role": "parent" }
  ]
}
```

Filesystem discovery exists only as a one-time interactive setup aid (`opentasks discover`), never as a runtime query mechanism. This eliminates non-determinism, performance issues, and security concerns from ancestor/descendant filesystem traversal.

---

## Worktree Model

### Single Daemon per Git Repository

OpenTasks uses **one daemon per git repository**, not one per `.opentasks/` directory. The daemon socket lives at `.git/opentasks/daemon.sock`, shared across all worktrees (since worktrees share `.git/`).

```
repo/
├── .git/
│   └── opentasks/
│       ├── daemon.sock          # Single daemon, shared by all worktrees
│       ├── daemon.lock          # PID lock
│       └── worktrees.json       # Registry of registered worktrees
├── main-worktree/
│   └── .opentasks/              # Manager agent's graph
├── feature-a-worktree/
│   └── .opentasks/              # Worker A (role: worker, redirect → manager)
│       └── config.json
└── feature-b-worktree/
    └── .opentasks/              # Worker B (role: worker, redirect → manager)
        └── config.json
```

**Why single daemon:**
- Eliminates N+1 process proliferation for agent swarms
- Writes serialized in-process (atomic claims, no cross-IPC races)
- Cross-location queries are function calls, not network hops
- Socket discovery is trivial (always `.git/opentasks/daemon.sock`)
- No global registry needed — no stale entries, no race conditions

**Phase 2 skips the daemon entirely** — SQLite WAL mode supports concurrent reads across processes, and an advisory file lock serializes JSONL writes. The daemon becomes valuable in Phase 3 for real-time coordination and cross-location queries.

### Explicit Worktree Registration

Worktrees are registered explicitly via CLI, not auto-detected:

```bash
opentasks worktree setup ./feature-worktree --branch feature-a --role worker --redirect-to .
opentasks worktree list
opentasks worktree teardown ./feature-worktree --remove-git-worktree
```

Registration stores actual paths (not inferred relative paths), solving the problem of worktrees placed anywhere on the filesystem. See [PHASE-3.md](./PHASE-3.md) for details.

### Role-Based Redirect Rules

Redirects use **roles** (set in config by orchestrator), not self-reported agent identity:

```json
{
  "role": "worker",
  "redirects": [
    {
      "operations": ["read", "write"],
      "pattern": "*",
      "target": "opentasks://k7m2x9p4/",
      "priority": 100,
      "fallback": "error"
    }
  ]
}
```

Rule evaluation: sorted by priority (ascending), first match wins. If no rule matches, operation is local. Conditional rules can match on `branch` and `role` (not agent identity).

### Cross-Location Queries via Provider Infrastructure

Connected opentasks locations register as **providers** in the existing `ProviderRegistry`. This eliminates the need for a separate "expansion coordinator":

- `ready()` queries resolve cross-location blockers via provider resolution
- Materialization (phantom -> cached -> hydrated) works for opentasks nodes
- Existing `NodeResolver` infrastructure handles URI resolution
- No new query coordination code needed

See [PHASE-3.md](./PHASE-3.md) for the location-as-provider pattern.

### Custom Merge Driver for JSONL

Git's default text merge fails on concurrent `graph.jsonl` modifications. OpenTasks ships a custom merge driver that combines **append-only writes** with **field-level merge**:

1. Writes always append (never overwrite lines in-place)
2. Git auto-merges appends from both branches (no line conflicts)
3. The merge driver deduplicates by keeping latest `updated_at` per ID
4. Field-level merge resolves concurrent edits to the same node

See [PHASE-3.md](./PHASE-3.md) for the merge driver specification.

---

## Storage Design

### File Structure

```
.opentasks/
├── graph.jsonl           # Nodes + edges, append-only (source of truth, git-tracked)
├── tombstones.jsonl      # Soft deletes (configurable gitignore)
├── cache.db              # SQLite in WAL mode (queries, indexes) — gitignored
├── config.json           # Configuration, connections, redirects, role
├── write.lock            # Advisory lock for JSONL writes — gitignored
├── context/                # Optional: markdown expansion
└── tasks/               # Optional: markdown expansion

.git/opentasks/           # Shared across all worktrees (Phase 3)
├── daemon.sock           # Single daemon socket
├── daemon.lock           # Daemon PID lock
└── worktrees.json        # Registered worktrees
```

### Append-Only JSONL Writes

All mutations to `graph.jsonl` are **append-only**. Updates append a new line with the same `id` and a newer `updated_at`. On load, the latest version of each ID wins.

```jsonl
{"id":"t-x7k9","status":"open","updated_at":"2025-01-28T10:00:00Z"}
{"id":"t-x7k9","status":"in_progress","updated_at":"2025-01-28T11:00:00Z"}
{"id":"t-x7k9","status":"closed","updated_at":"2025-01-28T12:00:00Z"}
```

**Why append-only:**
- Git merges are trivially correct (appends don't produce line conflicts)
- No concurrent-modification conflicts on status updates
- Compaction deduplicates periodically
- The merge driver handles dedup at merge time

### Edge Storage

Short IDs for local nodes, full URIs for external references:

```jsonl
{"id":"x-r8s9","from_id":"t-x7k9","to_id":"c-a2b3","type":"implements",...}
{"id":"x-t1u2","from_id":"t-x7k9","to_id":"beads://./bd-123","type":"blocks",...}
{"id":"x-v3w4","from_id":"t-x7k9","to_id":"opentasks://m3p8q2w5/t-y8z0","type":"references",...}
```

### ID Generation

Hash-based IDs for collision resistance in multi-agent scenarios:
- Prefix indicates type: `s-` (spec), `i-` (issue), `f-` (feedback), `e-` (external), `x-` (edge)
- Adaptive length based on entity count (4-8 chars base36)
- SHA256(UUID v4) -> base36 -> truncated
- Example: `t-x7k9`, `c-a2b3f`

---

## Implementation Phases

### Phase 1: Single-Location + Provider URIs (v1) — Current

**Scope**:
- One `.opentasks/` directory per working context
- Edges reference provider URIs: `beads://`, `claude://`, `jira://`, etc.
- Native provider for optional local context/issues (toggleable)
- Direct file access (no daemon)
- No `opentasks://` URIs to other locations
- No cross-location queries

See: [PHASE-1.md](./PHASE-1.md)

### Phase 2: Cross-Location References (v2)

**Scope**:
- Location identity: deterministic hash + UUID in `config.json`
- `opentasks://` URIs with hash-based addressing
- URI resolution via connections list (no filesystem discovery)
- SQLite WAL mode for concurrent reads across processes
- Advisory file lock (`write.lock`) for JSONL write serialization
- Explicit connection management: `opentasks connect`, `opentasks disconnect`
- Basic redirect rules (role-based, single target per rule)
- Append-only JSONL writes

**No daemon required.** Direct file access with WAL and file locks.

See: [PHASE-2.md](./PHASE-2.md)

### Phase 3: Multi-Location Queries + Worktrees (v3)

**Scope**:
- Single daemon per git repo (`.git/opentasks/daemon.sock`)
- Cross-location queries via location-as-provider pattern
- Query expansion: `none`, `follow-refs`, `connections`, `all`
- Worktree CLI: `opentasks worktree setup/teardown/list`
- Explicit worktree registration in `.git/opentasks/worktrees.json`
- Conditional redirect rules (branch + role conditions)
- Custom JSONL merge driver for `graph.jsonl`
- Discovery as one-time setup aid (`opentasks discover`)

See: [PHASE-3.md](./PHASE-3.md)

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core identity | Graph connector | Existing tools handle CRUD; OpenTasks adds relationships |
| Interface | 3 tools (link, query, annotate) | Providers have their own CRUD; OpenTasks is additive |
| Edge storage | Short local IDs, URI external | Simple common case, explicit for cross-boundary |
| **Daemon model** | **Single per git repo** | Eliminates N+1 processes; simplifies coordination |
| **Phase 2 concurrency** | **SQLite WAL + file locks** | No daemon needed for concurrent reads/writes |
| **Location identity** | **Deterministic hash + UUID** | Stable across renames; short for URIs |
| **Worktree model** | **Explicit registration + role-based redirect** | Predictable; no passive detection fragility |
| **Cross-location queries** | **Provider-based resolution** | Reuses existing ProviderRegistry; no new coordinator |
| **JSONL writes** | **Append-only** | Trivially merge-safe; compaction handles growth |
| **Git merge** | **Custom merge driver** | Field-level merge with last-writer-wins per field |
| **Location discovery** | **One-time setup aid only** | Not runtime; explicit connections for all queries |
| **Redirect conditions** | **Role + branch, not agent ID** | Roles set in config by orchestrator; not self-reported |
| **Global registry** | **Eliminated** | Socket probing + explicit connections replace it entirely |
| Native provider | Optional, toggleable | Lightweight use without external dependencies |

---

## Open Questions

### For Phase 1
- [ ] Exact provider interface for Beads, Claude Tasks
- [ ] How to handle `claude://current/` session scoping
- [ ] Feedback routing rules (native vs provider comments)

### For Phase 2+
- [ ] Location hash fallback for repos without git remote (use absolute path hash?)
- [ ] Merge driver behavior for edge deletions (tombstone wins? or re-creation wins?)
- [ ] Compaction frequency and triggers for append-only JSONL

### Deferred
- [ ] Remote repository locations (`opentasks://github.com/...`)
- [ ] P2P sync between locations
- [ ] LLM-based compaction summarization
