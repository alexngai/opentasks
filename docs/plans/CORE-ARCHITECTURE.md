# OpenTasks Core Architecture

> Spec ID: s-9jju | Tags: architecture, core, cross-location, multi-agent

## Overview

OpenTasks is a **graph connector** that links heterogeneous task and spec systems. It does not replace existing tools — each keeps its own interface, storage, and semantics. OpenTasks provides the **relationship layer** that existing tools lack.

### What OpenTasks Is
- A graph layer over existing tools (Claude Tasks, Beads, Taskmaster, Jira, etc.)
- Cross-system edges that span system boundaries
- Unified queries for blockers, ready items, and dependencies across all connected systems
- Optional native storage for lightweight specs/issues when external providers aren't needed

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

Reference nodes in other OpenTasks locations:

```
opentasks://./i-x7k9                         # Current location
opentasks://~/.opentasks/s-a2b3              # User-level location
opentasks://../.opentasks/i-e6f7             # Parent directory
opentasks:///abs/path/.opentasks/s-g8h9      # Absolute path
```

---

## Cross-Location Model

### Location Hierarchy

```
~/.opentasks/                                    # User level
~/projects/.opentasks/                           # Workspace level
~/projects/myapp/.opentasks/                     # Project level
~/projects/myapp/packages/core/.opentasks/       # Subproject level
```

### Isolation by Default

Each location is **isolated by default**:
- Queries only return nodes from the current location
- No automatic inheritance from parent locations
- No automatic discovery of child locations
- Explicit connectivity via edges with URIs

### Worktree Model

For agent swarms in git worktrees:

```
repo/
├── .git/
├── main-worktree/
│   └── .opentasks/           # Manager agent's graph
├── feature-a-worktree/
│   └── .opentasks/           # Worker A's graph (cloned, with redirect)
│       └── config.json       # redirect → main-worktree
└── feature-b-worktree/
    └── .opentasks/           # Worker B's graph (cloned, with redirect)
        └── config.json       # redirect → main-worktree
```

**Redirect Rules**:
- Sub-agents get their own cloned `.opentasks/` directory
- Config contains redirect rules pointing to manager's location
- Manager can update worker's config during worktree setup
- Supports chained redirects (worker → manager → orchestrator)

```json
{
  "redirects": [
    {
      "operations": ["read", "write"],
      "pattern": "*",
      "target": "opentasks://../main-worktree/.opentasks/"
    }
  ]
}
```

---

## Storage Design

### File Structure

```
.opentasks/
├── graph.jsonl           # Nodes + edges (source of truth)
├── tombstones.jsonl      # Soft deletes (configurable gitignore)
├── cache.db              # SQLite (queries, indexes) - gitignored
├── config.json           # Configuration, redirects
├── specs/                # Optional: markdown expansion
├── issues/               # Optional: markdown expansion
└── daemon.sock           # Daemon socket (when running)
```

### Edge Storage Format (Option C)

Short IDs for local nodes, full URIs for external:

```jsonl
{"id":"x-r8s9","from_id":"i-x7k9","to_id":"s-a2b3","type":"implements",...}
{"id":"x-t1u2","from_id":"i-x7k9","to_id":"beads://./bd-123","type":"blocks",...}
{"id":"x-v3w4","from_id":"i-x7k9","to_id":"opentasks://../other/.opentasks/i-y8z0","type":"references",...}
```

### ID Generation

Hash-based IDs for collision resistance in multi-agent scenarios:
- Prefix indicates type: `s-` (spec), `i-` (issue), `f-` (feedback), `e-` (external), `x-` (edge)
- Adaptive length based on entity count (4-8 chars)
- Example: `i-x7k9`, `s-a2b3f`

---

## Implementation Phases

### Phase 1 / L2: Single-Location + Provider URIs (v1)

**Scope**:
- One `.opentasks/` directory per working context
- Edges reference provider URIs: `beads://`, `claude://`, `jira://`, etc.
- Native provider for optional local specs/issues (toggleable)
- Direct file access (no daemon)
- No `opentasks://` URIs to other locations
- No cross-location queries

See: [PHASE-1.md](./PHASE-1.md)

### Phase 2 / L3: Cross-Location References (v2)

**Scope**:
- `opentasks://` URIs for referencing other locations
- URI resolution (relative paths, absolute paths, `~` expansion)
- Daemon per location (auto-start on first operation)
- Global registry for daemon discovery (`~/.opentasks/registry.json`)
- Redirect rules (basic: single target per location)

See: [PHASE-2.md](./PHASE-2.md)

### Phase 3 / L4-L5: Multi-Location Queries (v3)

**Scope**:
- Location discovery (find .opentasks/ in ancestors/descendants)
- Query expansion modes: `follow-refs`, `ancestors`, `descendants`, `siblings`, `all`
- Advanced redirect rules (conditional, pattern-based)
- Cross-location `ready()` queries
- Worktree detection and automatic redirect setup

See: [PHASE-3.md](./PHASE-3.md)

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core identity | Graph connector | Existing tools handle CRUD; OpenTasks adds relationships |
| Interface | 3 tools (link, query, annotate) | Providers have their own CRUD; OpenTasks is additive |
| Edge storage | Option C (short local, URI external) | Simple common case, explicit for cross-boundary |
| Worktree model | Clone + redirect | Sub-agents get isolation with configurable routing |
| Daemon | Required for multi-agent (Phase 2+) | Coordination, caching, cross-location resolution |
| Native provider | Optional, toggleable | Lightweight use without external dependencies |

---

## Open Questions

### For Phase 1
- [ ] Exact provider interface for Beads, Claude Tasks
- [ ] How to handle `claude://current/` session scoping
- [ ] Feedback routing rules (native vs provider comments)

### For Phase 2+
- [ ] Daemon auto-start behavior and lifecycle
- [ ] Registry cleanup for stale daemons
- [ ] Authentication for cross-location access

### Deferred
- [ ] Remote repository locations (`opentasks://github.com/...`)
- [ ] P2P sync between locations
- [ ] Compaction and archival strategies
