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
├── graph.jsonl           # Local nodes + edges + external refs (source of truth)
├── tombstones.jsonl      # Soft deletes (configurable gitignore)
├── cache.db              # SQLite (queries, external cache, snapshots)
├── config.json           # Configuration
├── specs/                # Optional: markdown expansion
├── issues/               # Optional: markdown expansion
└── daemon.sock           # Daemon socket (when running)
```

See [PERSISTENCE.md](./PERSISTENCE.md) for storage details and [ARCHITECTURE.md](./ARCHITECTURE.md) for location hierarchy.

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

OpenTasks is designed to handle complex git topologies including branches, worktrees, and distributed agent coordination.

### The Challenge

```
repo/
├── .git/                         ← shared git database
├── main-worktree/
│   ├── .opentasks/
│   │   └── graph.jsonl           ← branch: main
│   └── src/
├── feature-a-worktree/
│   ├── .opentasks/
│   │   └── graph.jsonl           ← branch: feature-a (diverged)
│   └── src/
└── feature-b-worktree/
    ├── .opentasks/
    │   └── graph.jsonl           ← branch: feature-b (diverged)
    └── src/
```

**Problems:**
- Each worktree has its own view of the graph (from its branch)
- Parallel agents creating issues → potential ID collisions
- Status updates in parallel → merge conflicts
- Orchestrator needs visibility across all worktrees

### Branch-Aware Nodes

Nodes can optionally track their branch context:

```typescript
interface Node {
  id: string
  // ... other fields

  // Branch awareness (optional)
  branch?: string              // which branch created this node
  merged_from?: string[]       // branches this was merged from
  superseded_by?: string       // if replaced during merge
}
```

**Branch switching behavior:**
- Switching from `feature-a` to `main` changes which nodes are visible
- Nodes created on `feature-a` only appear when on that branch (or after merge)
- Edges can reference nodes on other branches (resolved when both visible)

### Redirect Rules

Inspired by beads' redirect concept, opentasks supports configurable read/write routing:

```typescript
interface RedirectRule {
  // What operations this rule applies to
  operations: ('read' | 'write' | 'both')[]

  // Pattern matching for which refs to redirect
  pattern: string              // glob or regex

  // Where to redirect
  target: LocationRef          // path, URI, or special value

  // Conditions
  when?: {
    branch?: string            // only on specific branch
    worktree?: string          // only in specific worktree
    agent?: string             // only for specific agent
  }
}

// Configuration example
{
  "redirects": [
    {
      // Sub-agents write to their worktree, read from main
      "operations": ["read"],
      "pattern": "i-*",
      "target": "opentasks://../main-worktree/",
      "when": { "worktree": "feature-*" }
    },
    {
      // All writes go to central orchestrator location
      "operations": ["write"],
      "pattern": "*",
      "target": "opentasks://.git/opentasks/",
      "when": { "agent": "sub-agent-*" }
    }
  ]
}
```

### Coordination Patterns

#### Pattern 1: Optimistic Merge (Simple)

```
Each worktree works independently
Merge happens via git when branches merge
Hash-based IDs prevent collisions
Content hashing deduplicates on merge
```

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Worktree A  │  │  Worktree B  │  │  Worktree C  │
│  (feature-a) │  │  (feature-b) │  │    (main)    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │   create i-x1   │   create i-y2   │
       │                 │                 │
       └────────────────┬┴─────────────────┘
                        │ git merge
                        ▼
              ┌─────────────────┐
              │  Merged graph   │
              │  i-x1, i-y2     │
              │  (no collision) │
              └─────────────────┘
```

**Best for:** Independent work streams, async collaboration

#### Pattern 2: Shared State via .git/

```
repo/
├── .git/
│   └── opentasks/              ← shared across all worktrees
│       ├── graph.jsonl
│       └── cache.db
├── main-worktree/
└── feature-worktree/
```

```
┌──────────────┐     ┌──────────────┐
│  Worktree A  │     │  Worktree B  │
└──────┬───────┘     └──────┬───────┘
       │                    │
       └──────────┬─────────┘
                  │
                  ▼
        ┌─────────────────┐
        │ .git/opentasks/ │
        │  (shared state) │
        └─────────────────┘
```

**Trade-offs:**
- Single source of truth across worktrees
- Requires locking or atomic operations
- Not versioned with branches
- Good for orchestrator coordination

#### Pattern 3: Daemon Coordination

```
┌─────────────────────────────────────────────┐
│           Opentasks Daemon                   │
│  - Runs per-repo (or per-workspace)         │
│  - Serializes writes                         │
│  - Broadcasts updates                        │
│  - Manages locks and claims                  │
└─────────────────────────────────────────────┘
       ↑              ↑              ↑
  Worktree A    Worktree B    Worktree C
```

**Trade-offs:**
- Real-time coordination
- No merge conflicts
- More complex infrastructure
- Single point of failure (recoverable)

#### Pattern 4: Redirect Hierarchy (Recommended for Agent Swarms)

Combines the above patterns using redirect rules:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Orchestrator Agent                           │
│                    (main-worktree)                               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  .opentasks/ (authoritative)                             │    │
│  │  - All specs live here                                   │    │
│  │  - Orchestrator issues live here                         │    │
│  │  - Receives writes from sub-agents (via redirect)        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↑
              ┌───────────────┼───────────────┐
              │               │               │
┌─────────────┴───┐ ┌────────┴────────┐ ┌────┴──────────────┐
│  Sub-Agent A    │ │  Sub-Agent B    │ │  Sub-Agent C      │
│  (feature-a)    │ │  (feature-b)    │ │  (feature-c)      │
│                 │ │                 │ │                   │
│  Redirects:     │ │  Redirects:     │ │  Redirects:       │
│  read: main     │ │  read: main     │ │  read: main       │
│  write: main    │ │  write: main    │ │  write: main      │
└─────────────────┘ └─────────────────┘ └───────────────────┘
```

Sub-agents:
- Read specs and orchestrator issues from main
- Write status updates redirected to main
- Can have local scratch state if needed

### P2P / Central Source of Truth

The redirect model also supports centralized coordination:

```
┌─────────────────────────────────────────────────────────────────┐
│              Central Repository (source of truth)                │
│              github.com/org/tasks.opentasks                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  .opentasks/ (authoritative)                             │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              ↑
              ┌───────────────┼───────────────┐
              │               │               │
┌─────────────┴───┐ ┌────────┴────────┐ ┌────┴──────────────┐
│  Dev Machine A  │ │  Dev Machine B  │ │  CI/CD Agent      │
│                 │ │                 │ │                   │
│  Redirects:     │ │  Redirects:     │ │  Redirects:       │
│  read: central  │ │  read: central  │ │  read: central    │
│  write: central │ │  write: central │ │  write: central   │
│  (via git sync) │ │  (via git sync) │ │  (via git sync)   │
└─────────────────┘ └─────────────────┘ └───────────────────┘
```

### Agent Coordination Primitives

While detailed agent coordination is left to higher layers, opentasks provides basic primitives:

```typescript
interface Node {
  // ... other fields

  // Coordination hints (optional)
  claimed_by?: string          // agent ID that claimed this work
  claimed_at?: string          // when claimed
  lock_until?: string          // soft lock expiry
}
```

**Claim semantics:**
- Advisory, not enforced at storage layer
- Agents check claims before starting work
- Expired claims can be re-claimed
- Conflict resolution is application-level

**Why not more?**
- Beads has sophisticated async gates, waiters, etc.
- Those belong in beads integration or application layer
- OpenTasks provides the graph; coordination built on top

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
- [x] **Daemon**: Required for multi-agent, but defer implementation to v2
- [x] **3-tool interface**: Sufficient because providers have their own CRUD tools
- [x] **Feedback**: Native first, design for cross-system routing

### Active — Cross-Location Design (Priority)
- [ ] **v1 scope**: Single-location + provider URIs, or include opentasks:// URIs?
- [ ] **URI canonicalization**: How to store/resolve relative vs absolute URIs?
- [ ] **Schema preparation**: What fields needed now to support cross-location later?

### Deferred to v2
- [ ] Location discovery and expansion modes
- [ ] Redirect rules for worktrees
- [ ] Global daemon registry
- [ ] Multi-location queries (ancestors, descendants, siblings)

### Implementation Details (Address During Build)
- [ ] Hash-based ID generation (adopt from beads?)
- [ ] Compaction strategy for JSONL
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
