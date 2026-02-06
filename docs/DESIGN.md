# OpenTasks Design Document

**See also:** [SCHEMA.md](./SCHEMA.md) (data model) · [ARCHITECTURE.md](./ARCHITECTURE.md) (hierarchy, daemon) · [PERSISTENCE.md](./PERSISTENCE.md) (storage) · [PROVIDERS.md](./PROVIDERS.md) (integrations) · [INTERFACE.md](./INTERFACE.md) (API)

---

## Vision

OpenTasks is a **graph connector** that links heterogeneous task and spec systems:

1. **A graph layer over existing tools** — connects Claude Tasks, Beads, Taskmaster, and other systems without replacing them
2. **Cross-system relationships** — edges that span system boundaries (e.g., Claude subtask blocks Beads issue)
3. **Unified queries** — find blockers, ready items, and dependencies across all connected systems
4. **Optional native storage** — lightweight specs/issues for simple use cases when external providers aren't needed

**What OpenTasks is NOT:**
- Not a replacement for Claude's built-in tasks (use `TaskCreate`/`TaskUpdate` directly)
- Not a replacement for Beads (use `bd` CLI directly)
- Not a unified CRUD API (each system keeps its own interface)

The goal is to provide the **relationship layer** that existing tools lack — the ability to say "this Claude task implements that Beads issue which references that Jira ticket."

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agents / UIs                             │
└─────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Claude Tasks   │  │     Beads       │  │   Taskmaster    │
│  TaskCreate()   │  │   bd new/show   │  │   tm task       │
│  TaskUpdate()   │  │   bd update     │  │   tm prd        │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  OpenTasks Graph Layer                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                      Edges                                │   │
│  │  claude://t-abc ──implements──▶ beads://./bd-x7k9        │   │
│  │  beads://./bd-x7k9 ──blocks──▶ jira://PROJ-123           │   │
│  │  taskmaster://./prd ◀──discovered-from── beads://./bd-y  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  3 Tools: link() | query() | annotate()                         │
│                                                                  │
│  Optional: Native specs/issues for lightweight use              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Motivations

### Why a graph connector?

Existing tools are good at what they do:

**Beads** — Distributed issue tracker for AI agent swarms (100+ fields, 19 dependency types, sophisticated)

**Claude's Tasks** — Simple session-scoped work tracking (TaskCreate, TaskUpdate, TaskList)

**Taskmaster** — PRD management and task breakdown

**Jira/Linear/GitHub** — Team collaboration and project management

**The problem**: These systems don't talk to each other. You can't say:
- "This Claude subtask implements that Beads issue"
- "This Beads issue is blocked by that Jira ticket"
- "What's ready to work on across all my systems?"

**OpenTasks solves this** by providing:
- **Cross-system edges** — relationships that span system boundaries
- **Unified queries** — find blockers/ready items across all connected systems
- **Feedback routing** — comments that reference nodes in different systems
- **Optional native storage** — simple specs/issues when you don't need a full-featured tracker

### Core Principles

1. **Graph-first** — edges/relationships are the primary value; node storage is secondary
2. **Non-invasive** — works alongside existing tools without replacing them
3. **Progressive enhancement** — start with edges only, add native nodes when needed
4. **Provider-agnostic** — any system with a URI can participate in the graph
5. **Git-friendly** — JSONL storage designed for version control
6. **Designed for multi-agent** — handles concurrent access, branches, worktrees

### File Structure (Hybrid Model)

```
.opentasks/
├── graph.jsonl           # Local nodes + edges + external refs (append-only, source of truth)
├── tombstones.jsonl      # Soft deletes (configurable gitignore)
├── cache.db              # SQLite in WAL mode (queries, external cache) — gitignored
├── config.json           # Configuration, connections, role, redirects
├── write.lock            # Advisory lock for JSONL writes — gitignored
├── specs/                # Optional: markdown expansion
└── issues/               # Optional: markdown expansion

.git/opentasks/           # Shared across all worktrees (Phase 3)
├── daemon.sock           # Single daemon socket
├── daemon.lock           # PID lock
└── worktrees.json        # Registered worktrees
```

See [PERSISTENCE.md](./PERSISTENCE.md) for storage details and [plans/CORE-ARCHITECTURE.md](./plans/CORE-ARCHITECTURE.md) for cross-location architecture.

---

## Core Concepts

### Entity Model

OpenTasks has two primary local node types:

#### Specs (Intent/Requirements)
Captures user intent, requirements, and context that should persist. Derived from sudocode's spec concept.

#### Issues (Actionable Work)
Trackable units of work with status. The primary entity for task tracking.

#### External Nodes
References to entities in external systems (Jira, Linear, GitHub, beads, etc.) that can participate in the graph.

### Relationships (Edges)

Edges connect nodes and can target:
- Local node IDs (`i-x7k9`, `s-a2b3`)
- External URIs (`jira://PROJ-123`, `bd://bd-x7k9`, `gh://owner/repo#42`)

Core relationship types (minimal set, extensible):
- `blocks` — dependency blocking
- `implements` — issue implements a spec
- `references` — general reference
- `related` — loose association

Additional types can be added by integrations or users.

---

## External References

### Hybrid Phantom Node Model

External references use a progressive materialization approach:

```
Stage 1: URI Reference (Edge Target)
┌─────────────┐      ┌─────────────────────┐
│ Local Issue │─────▶│ "jira://PROJ-123"   │
└─────────────┘      └─────────────────────┘
                     (just a URI string)

Stage 2: Phantom Node (Lazy Creation)
┌─────────────┐      ┌─────────────────────┐
│ Local Issue │─────▶│ Phantom Node        │
└─────────────┘      │ id: jira://PROJ-123 │
                     │ materialized: false │
                     └─────────────────────┘
                     (exists in graph, not yet resolved)

Stage 3: Materialized Node (On-Demand Fetch)
┌─────────────┐      ┌─────────────────────┐
│ Local Issue │─────▶│ Materialized Node   │
└─────────────┘      │ id: jira://PROJ-123 │
                     │ title: "Fix bug..." │
                     │ status: "In Progress"│
                     │ cached_at: ...      │
                     │ materialized: true  │
                     └─────────────────────┘
                     (fetched from integration)
```

### Benefits

- **Lightweight by default** — edges can just be URIs, no overhead
- **Progressive enhancement** — materialize only when needed
- **Offline capable** — cached materialized nodes work without network
- **Clear boundaries** — explicit distinction between local and external

### Materialization Triggers

Nodes materialize when:
- Explicitly requested (user/agent asks for details)
- Traversing the graph and node data is needed
- Sync operation pulls from external system
- Cache refresh on configured schedule

---

## Integration Model

OpenTasks provides flexible hooks rather than forcing a uniform integration pattern. Different backends can integrate in the way that makes most sense for them.

### Integration Interface

```typescript
interface Integration {
  name: string

  // Required: identify what this integration handles
  handles(ref: string | Node): boolean

  // Optional: choose integration style(s)
  asProvider?: Provider      // URI-based capability dispatch
  asAdapter?: Adapter        // Full interface translation
  asSyncTarget?: SyncTarget  // Bidirectional sync

  // Extension point
  extensions?: Record<string, unknown>
}
```

### Pattern: Provider (URI-Based Dispatch)

Providers declare capabilities and handle URI schemes. Good for read-heavy integrations.

```typescript
interface Provider {
  name: string
  schemes: string[]           // ["jira://", "linear://"]
  capabilities: Capability[]  // What operations supported

  resolve?(uri: string): Promise<Node>
  search?(query: string): Promise<Node[]>
  create?(node: Node): Promise<string>
  update?(uri: string, updates: Partial<Node>): Promise<void>
}
```

**Use when**: Integration is primarily about resolving external references on-demand.

**Example**: Jira provider that resolves `jira://PROJ-123` URIs.

### Pattern: Adapter (Interface Translation)

Adapters implement opentasks' full CRUD interface, translating to backend operations.

```typescript
interface Adapter {
  createIssue(node: Node): Promise<string>
  updateIssue(id: string, updates: Partial<Node>): Promise<void>
  getIssue(id: string): Promise<Node>
  query(filter: Filter): Promise<Node[]>
  watch?(callback: (event: Event) => void): void
}
```

**Use when**: Integration should fully delegate storage/operations to backend.

**Example**: Beads adapter where all issue operations go through `bd` CLI.

### Pattern: Sync Target (Bidirectional Sync)

Sync targets enable bidirectional synchronization with external systems.

```typescript
interface SyncTarget {
  name: string
  direction: 'push' | 'pull' | 'bidirectional'

  mapToExternal(node: Node): ExternalFormat
  mapFromExternal(external: ExternalFormat): Node

  push(nodes: Node[]): Promise<SyncResult>
  pull(): Promise<Node[]>

  conflictStrategy: 'local-wins' | 'remote-wins' | 'manual' | 'merge'
}
```

**Use when**: Both systems should stay in sync, either direction.

**Example**: Sudocode sync that keeps opentasks and sudocode issues aligned.

### Integration Examples

| System | Likely Pattern | Rationale |
|--------|---------------|-----------|
| Beads | Provider + Adapter | Resolve `bd://` URIs, optionally delegate full storage |
| Jira | Provider | Read-heavy, resolve on-demand, maybe push updates |
| Linear | Provider | Similar to Jira |
| GitHub Issues | Provider | Resolve `gh://` URIs |
| Sudocode | Sync Target | Bidirectional sync with existing sudocode storage |

---

## Storage Model

### Hybrid: Owned Local + Delegated External

OpenTasks owns storage for:
- Local nodes (specs, issues)
- All edges/relationships (including those targeting external URIs)
- Cached external nodes (materialized phantoms)
- Integration configuration

External systems own their own data; opentasks caches/references it.

```
.opentasks/
├── graph.jsonl       # Local nodes + edges (source of truth)
├── cache.db          # SQLite for queries + cached external nodes
└── config.json       # Integration configurations
```

### Storage Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                    Application Layer                             │
│              (queries, mutations, graph ops)                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Query Layer (SQLite)                          │
│  - Fast queries on local + cached nodes                          │
│  - Indexes on status, priority, relationships                    │
│  - Gitignored, rebuilt from JSONL                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                 Persistence Layer (JSONL)                        │
│  - Source of truth for local data                                │
│  - Git-tracked, merge-friendly                                   │
│  - Append-optimized, compact on demand                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                 Integration Layer                                │
│  - Delegated storage for configured backends                     │
│  - Cache population for external nodes                           │
│  - Sync operations                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Approach

| Requirement | How Addressed |
|-------------|---------------|
| Works standalone | JSONL + SQLite provide full functionality with no integrations |
| Git-friendly | JSONL is merge-friendly, SQLite is gitignored |
| Fast queries | SQLite cache enables complex queries |
| External refs | Edges can target URIs; nodes materialize on demand |
| Offline capable | Cached external nodes available without network |
| Delegated storage | Adapters can route operations to external backends |

### Cache Considerations

For materialized external nodes:
- **TTL-based expiry** — configurable per integration
- **Stale-while-revalidate** — serve cached, refresh in background
- **Manual refresh** — explicit invalidation when needed
- **Sync-driven** — refresh during pull operations

Cache invalidation risks are acknowledged; design should favor explicit refresh over implicit staleness.

---

## Location Model

OpenTasks supports flexible deployment across different location contexts while maintaining a consistent graph model.

### Location Types

```
┌─────────────────────────────────────────────────────────────────┐
│                      Location Hierarchy                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  User Global (~/.opentasks/)                             │    │
│  │  - Personal tasks, cross-project work                    │    │
│  │  - Default fallback location                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            ↓ inherits                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Workspace (~/<workspace>/.opentasks/)                   │    │
│  │  - Team/project-level coordination                       │    │
│  │  - Shared across related repos                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            ↓ inherits                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Repo-Local (<repo>/.opentasks/)                         │    │
│  │  - Repository-specific work                              │    │
│  │  - Git-tracked with the repo                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Scenarios

| Scenario | Location | Git Integration | Use Case |
|----------|----------|-----------------|----------|
| **Single repo** | `<repo>/.opentasks/` | Tracked in repo | Typical project work |
| **Multi-repo workspace** | `<workspace>/.opentasks/` | Own repo or untracked | Coordinating across microservices |
| **Personal/global** | `~/.opentasks/` | Optional | Cross-project tasks, scratch work |
| **Standalone** | Any directory | None (degraded) | Non-code projects, quick planning |

### Cross-Location References

Nodes can reference other nodes across locations via URIs:

```typescript
// URI scheme encodes location
"opentasks://./i-x7k9"                    // same location (relative)
"opentasks://~/i-a2b3"                    // user global
"opentasks://../other-repo/s-c4d5"        // relative path to another repo
"opentasks:///absolute/path/i-e6f7"       // absolute path
"opentasks://github.com/org/repo/i-g8h9"  // remote repository
```

### Remote Repositories

Remote git repos present an interesting design question: are they **external integrations** (like Jira) or **virtual locations** (like local paths)?

**As External Integration:**
```
- Treated like jira://, linear://, etc.
- Provider resolves remote references
- Fetch-on-demand, cache locally
- Clear boundary: local vs. remote
```

**As Virtual Location:**
```
- Part of the location hierarchy
- Can clone/sync like a local location
- Participates in redirect rules (see Git Topology)
- Blurred boundary: just another location
```

**Hybrid Approach (Recommended):**
```
Remote repos are locations that use provider-like resolution:
- URIs identify them as locations (opentasks://github.com/...)
- Resolution happens via git clone/fetch (not HTTP API)
- Can be configured as redirect targets
- Cached locally like materialized external nodes
```

### Standalone Mode (No Git)

When no git repository is present:

| Capability | Behavior |
|------------|----------|
| Persistence | JSONL still works |
| Queries | SQLite cache still works |
| History | No automatic versioning |
| Sync | Manual export/import only |
| Merge | No automatic conflict resolution |
| Cross-location refs | Work, but no git-based sync |

**Future consideration:** Could offer `opentasks init --git` to bootstrap minimal git repo for standalone directories that want versioning.

---

## Git Topology

OpenTasks is designed to handle complex git topologies including branches, worktrees, and distributed agent coordination. The revised design uses a **single daemon per git repo**, **explicit worktree registration**, **append-only JSONL writes**, and a **custom merge driver** to solve concurrency and merge challenges.

See [plans/CORE-ARCHITECTURE.md](./plans/CORE-ARCHITECTURE.md) for the full cross-location architecture.

### The Challenge

```
repo/
├── .git/
│   └── opentasks/                ← shared state (daemon, worktree registry)
│       ├── daemon.sock
│       └── worktrees.json
├── main-worktree/
│   ├── .opentasks/
│   │   └── graph.jsonl           ← branch: main (manager)
│   └── src/
├── feature-a-worktree/
│   ├── .opentasks/
│   │   └── config.json           ← role: worker, redirect → manager
│   └── src/
└── feature-b-worktree/
    ├── .opentasks/
    │   └── config.json           ← role: worker, redirect → manager
    └── src/
```

**Problems solved:**
- Each worktree has its own view of the graph (from its branch) → **redirect rules route to manager**
- Parallel agents creating issues → **hash-based IDs prevent collisions**
- Status updates in parallel → **append-only writes + custom merge driver**
- Orchestrator needs visibility across all worktrees → **single daemon manages all locations**

### How Worktrees Work

1. **Explicit registration** — `opentasks worktree setup` creates and configures worker worktrees
2. **Role-based routing** — workers redirect reads/writes to manager via config (not agent identity)
3. **Single daemon** — one process at `.git/opentasks/daemon.sock` serves all worktrees
4. **Provider-based queries** — connected locations register as providers; `ready()` resolves cross-location blockers

```
┌─────────────────────────────────────────────────────────────────┐
│              Single Daemon (.git/opentasks/daemon.sock)          │
│  - Manages all registered worktrees                              │
│  - Serializes writes                                             │
│  - Cross-location queries are in-process                         │
└─────────────────────────────────────────────────────────────────┘
       ↑                    ↑                    ↑
  main-worktree        feature-a            feature-b
  (role: manager)      (role: worker)       (role: worker)
```

### Redirect Rules (Role-Based)

Redirects are configured by the orchestrator at worktree setup time. Rules match on **role** and **branch**, not agent identity:

```json
{
  "role": "worker",
  "redirects": [
    {
      "operations": ["read", "write"],
      "pattern": "*",
      "target": "opentasks://k7m2x9p4/",
      "priority": 100,
      "fallback": "error",
      "when": { "role": "worker" }
    }
  ]
}
```

Rule evaluation: sorted by priority (ascending), first match wins. Max redirect depth: 3 hops.

### Merge Safety

Concurrent work across branches is handled by two complementary mechanisms:

1. **Append-only JSONL writes** — updates append new lines with the same ID and newer `updated_at`. Git merges appends trivially (no line conflicts).

2. **Custom merge driver** — registered via `.gitattributes`, deduplicates by ID (keeps latest `updated_at`), performs field-level three-way merge for concurrent edits.

```gitattributes
.opentasks/graph.jsonl merge=opentasks
```

See [plans/PHASE-3.md](./plans/PHASE-3.md) for the full merge driver specification.

### Coordination Patterns

#### Pattern 1: Optimistic Merge (Simple)

Each worktree works independently. Append-only writes + merge driver handle merging:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Worktree A  │  │  Worktree B  │  │  Worktree C  │
│  (feature-a) │  │  (feature-b) │  │    (main)    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │   create i-x1   │   create i-y2   │
       │   update i-z3   │   update i-z3   │
       │                 │                 │
       └────────────────┬┴─────────────────┘
                        │ git merge + merge driver
                        ▼
              ┌──────────────────┐
              │  Merged graph    │
              │  i-x1, i-y2     │  ← new nodes: union
              │  i-z3           │  ← conflict: field-level merge
              └──────────────────┘
```

**Best for:** Independent work streams, async collaboration.

#### Pattern 2: Redirect Hierarchy (Recommended for Agent Swarms)

Workers redirect to manager. Single daemon coordinates. Setup via `opentasks worktree setup`:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Manager Agent (main-worktree)                │
│  .opentasks/ (authoritative) — role: manager                     │
│  - All specs live here                                           │
│  - All issues centrally managed                                  │
│  - Single daemon handles all requests                            │
└─────────────────────────────────────────────────────────────────┘
                              ↑
              ┌───────────────┼───────────────┐
              │               │               │
┌─────────────┴───┐ ┌────────┴────────┐ ┌────┴──────────────┐
│  Worker A       │ │  Worker B       │ │  Worker C         │
│  (feature-a)    │ │  (feature-b)    │ │  (feature-c)      │
│  role: worker   │ │  role: worker   │ │  role: worker     │
│  redirect: mgr  │ │  redirect: mgr  │ │  redirect: mgr   │
└─────────────────┘ └─────────────────┘ └───────────────────┘
```

**Setup:**
```bash
opentasks worktree setup ./feature-a --branch feature-a --role worker --redirect-to .
opentasks worktree setup ./feature-b --branch feature-b --role worker --redirect-to .
```

### Agent Coordination Primitives

OpenTasks provides basic advisory primitives for coordination:

```typescript
interface Node {
  // ... other fields

  // Coordination hints (optional, advisory)
  claimed_by?: string          // agent ID that claimed this work
  claimed_at?: string          // when claimed
  lock_until?: string          // soft lock expiry (default: 30 min)
}
```

With the single-daemon model, claims are atomic (in-process check-and-set). Expired claims auto-release.

**Why not more?** Beads has sophisticated gates, waiters, and dependency types. Those belong in the beads integration or application layer. OpenTasks provides the graph; coordination is built on top.

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Core identity | Graph connector, not task system | Existing tools (Claude Tasks, Beads) handle CRUD; OpenTasks adds relationships |
| Entity model | Edges + optional native nodes | Edges are primary; native specs/issues for lightweight use |
| External refs | Phantom nodes with materialization | Flexible, progressive, clear boundaries |
| Integration model | Provider URIs + native tools | Agents use each system's tools directly; OpenTasks links them |
| Storage | Edges always local, nodes via providers | OpenTasks owns graph structure, providers own content |
| Storage format | JSONL + SQLite | Git-friendly + fast queries |
| Location model | Single-location v1, multi-location v2 | Start simple, design for future cross-location |
| Agent coordination | Basic primitives (claims), rest in app layer | OpenTasks is graph, not orchestrator |

---

## Open Questions

### Resolved
- [x] **Core identity**: Graph connector, not task replacement
- [x] **Daemon model**: Single daemon per git repo (Phase 3); no daemon for Phase 2 (WAL + file locks)
- [x] **3-tool interface**: Sufficient because providers have their own CRUD tools
- [x] **Feedback**: Native first, design for cross-system routing
- [x] **URI canonicalization**: Use deterministic location hashes (8-char base36) as primary URI identifier
- [x] **Global daemon registry**: Eliminated — socket at `.git/opentasks/daemon.sock` + explicit connections
- [x] **Location discovery**: One-time setup aid only, not runtime; explicit connections for queries
- [x] **Redirect conditions**: Role-based (set by orchestrator in config), not agent-identity-based
- [x] **Worktree detection**: Replaced with explicit registration via `opentasks worktree setup`
- [x] **JSONL merge conflicts**: Append-only writes + custom merge driver with field-level resolution

### Active
- [ ] **Location hash fallback**: What to use when repo has no git remote? (absolute path hash?)
- [ ] **Merge driver edge deletions**: If one side deletes and other modifies, keep or delete?
- [ ] **Compaction frequency**: Triggers and scheduling for append-only JSONL growth

### Implementation Details (Address During Build)
- [ ] Compaction strategy for append-only JSONL
- [ ] Cache TTL defaults per provider
- [ ] Provider authentication handling

---

## References

### Sudocode
- Repository: `references/sudocode/`
- Key concepts: Specs, Issues, Relationships, Anchored Feedback
- Storage: JSONL + SQLite + Markdown (three-layer)

### Beads
- Repository: `references/beads/`
- Documentation: https://github.com/steveyegge/beads
- Key concepts: Issues, Dependencies (19 types), Gates, Molecules, HOP
- Storage: JSONL + SQLite (two-layer)
- Relevant patterns:
  - **Hash-based IDs**: Collision-resistant for multi-agent concurrent creates
  - **Content hashing**: Deduplication on merge
  - **Redirects**: Configurable read/write routing for worktree coordination
  - **Dirty tracking**: Incremental export with debounce

### Claude's Tasks
- Built-in to Claude Code CLI
- Simple status tracking (pending → in_progress → completed)
- Session-scoped, basic blocking relationships
