# OpenTasks Design Document

**See also:** [SCHEMA.md](./SCHEMA.md) (data model) · [ARCHITECTURE.md](./ARCHITECTURE.md) (hierarchy, daemon) · [PERSISTENCE.md](./PERSISTENCE.md) (storage) · [PROVIDERS.md](./PROVIDERS.md) (integrations) · [INTERFACE.md](./INTERFACE.md) (API)

---

## Vision

OpenTasks is a universal work graph data structure that serves as:

1. **A replacement for Claude's built-in tasks** — simple, immediate use for session-based work tracking
2. **An abstraction over systems like beads/sudocode** — unified interface for different task management paradigms
3. **A bridge to external systems** — Jira, Linear, GitHub Issues as graph nodes

The goal is to create a minimal but extensible graph that can encapsulate different data sources centered around actionable work tracking, while providing integration points for existing systems.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agents / UIs                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    OpenTasks Core Graph                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐                   │
│  │  Specs   │──│  Issues  │──│    Edges     │                   │
│  │ (intent) │  │  (work)  │  │ (relations)  │                   │
│  └──────────┘  └──────────┘  └──────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Integration Layer                             │
│  ┌─────────┐ ┌─────────┐ ┌──────┐ ┌────────┐ ┌───────────────┐  │
│  │  Beads  │ │Sudocode │ │ Jira │ │ Linear │ │ GitHub Issues │  │
│  └─────────┘ └─────────┘ └──────┘ └────────┘ └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Motivations

### Why not just use beads or sudocode directly?

**Beads** is a powerful distributed issue tracker optimized for AI agent swarms, with:
- 100+ fields on the Issue type
- 19 dependency types
- HOP federation, molecules, async gates
- Sophisticated but complex

**Sudocode** provides a requirements-to-implementation pipeline:
- Specs (user intent) → Issues (work) → Executions (agent runs)
- Anchored feedback flowing back to specs
- Workflow orchestration
- Tightly coupled to execution

**Claude's Tasks** is simple but limited:
- Session-scoped, no persistence
- Basic status tracking
- No external integrations

**OpenTasks** aims to be:
- **Simpler than beads** — not 100+ fields, selective feature adoption
- **More structured than Claude's tasks** — persistent, richer semantics
- **Decoupled from execution** — unlike sudocode, no workflow/execution layer
- **Interoperable** — works with all of the above

### Core Principles

1. **Standalone first** — works fully without any integrations configured
2. **Graph-native** — relationships are first-class, not an afterthought
3. **Progressive complexity** — simple by default, rich when needed
4. **Integration flexibility** — different backends can integrate differently
5. **Git-friendly** — designed for version control and offline use
6. **Location flexible** — works in-repo, cross-repo, or standalone
7. **Topology aware** — handles branches, worktrees, and distributed agents

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
| Entity model | Specs + Issues (two types) | Captures both intent and work, from sudocode |
| External refs | Phantom nodes with materialization | Flexible, progressive, clear boundaries |
| Integration model | Flexible hooks (provider/adapter/sync) | Different backends need different patterns |
| Storage | Owned local + delegated external | Standalone works; integrations optional |
| Storage format | JSONL + SQLite | Git-friendly + fast queries |
| Relationship storage | Always local | Opentasks owns the graph structure |
| Location model | Hierarchical (global < workspace < repo) | Flexibility for different deployment scenarios |
| Remote repos | Hybrid (location + provider resolution) | Git-native fetch, but with caching like external refs |
| Standalone (no git) | Works but degraded | Future-proof, not fundamental |
| Worktree handling | Redirect rules + optimistic merge | Balances simplicity with coordination needs |
| Agent coordination | Basic primitives (claims), rest in app layer | Opentasks is graph, not orchestrator |

---

## Open Questions

### Core Data Model
- [ ] What fields should be first-class on Spec and Issue vs. metadata?
- [ ] Should we adopt beads' hash-based ID generation?
- [ ] What's the minimal useful set of relationship types?
- [ ] Branch-awareness fields: optional or always present?

### External References
- [ ] How to handle broken/unavailable external refs?
- [ ] Should phantom nodes be persisted or transient?
- [ ] Cache TTL defaults per integration type?

### Integrations
- [ ] How to handle authentication for external systems?
- [ ] Should integrations be plugins (dynamic) or compiled in?
- [ ] How to version integration schemas?

### Storage
- [ ] Single `graph.jsonl` or split files (`specs.jsonl`, `issues.jsonl`, `edges.jsonl`)?
- [ ] Compaction strategy for JSONL?
- [ ] Schema migration approach?

### Location Model
- [ ] URI scheme finalization (`opentasks://` vs alternatives)
- [ ] How to discover/configure workspace-level locations?
- [ ] Remote repo authentication and caching strategy
- [ ] What exactly degrades in standalone (no-git) mode?

### Git Topology
- [ ] Redirect rule syntax and configuration format
- [ ] How to detect worktree context automatically?
- [ ] Daemon vs. daemonless: when is daemon justified?
- [ ] Conflict resolution strategies for optimistic merge
- [ ] Should claims be stored in nodes or separate table?

### Agent Coordination
- [ ] What primitives belong in opentasks vs. application layer?
- [ ] How much of beads' async gates to adopt (if any)?
- [ ] Lock semantics: advisory vs. enforced?
- [ ] How to handle orphaned claims (agent dies)?

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
