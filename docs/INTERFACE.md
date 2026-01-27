# OpenTasks Agent Interface

This document defines the programmatic interface for interacting with OpenTasks.

See also:
- [DESIGN.md](./DESIGN.md) — Design rationale and core concepts
- [SCHEMA.md](./SCHEMA.md) — Data model and types
- [PERSISTENCE.md](./PERSISTENCE.md) — Storage and sync
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Location hierarchy and daemon
- [PROVIDERS.md](./PROVIDERS.md) — Provider integration

---

## Design Philosophy

OpenTasks is a **graph connector** that adds a relationship layer to existing task systems. It does not replace those systems — each keeps its own tools, storage, and semantics. OpenTasks provides what they lack: cross-system edges.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Working Session                        │
│                                                                  │
│  Native Systems (each with their own interface):                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Claude Tasks   │  │     Beads       │  │   Taskmaster    │  │
│  │                 │  │                 │  │                 │  │
│  │ • Subtasks      │  │ • Persistent    │  │ • PRD specs     │  │
│  │ • Session-scoped│  │ • Multi-agent   │  │ • Task breakdown│  │
│  │ • Immediate     │  │ • Git-tracked   │  │ • Planning      │  │
│  │ • Ephemeral     │  │ • Rich deps     │  │                 │  │
│  │                 │  │                 │  │                 │  │
│  │ TaskCreate()    │  │ bd new          │  │ tm task         │  │
│  │ TaskUpdate()    │  │ bd update       │  │ tm prd          │  │
│  │ TaskGet()       │  │ bd show         │  │                 │  │
│  │ TaskList()      │  │ bd list         │  │                 │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│           │                   │                   │              │
│           └───────────────────┼───────────────────┘              │
│                               │                                  │
│                               ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    OpenTasks (Graph Layer)                   ││
│  │                                                              ││
│  │  • Links nodes across systems                                ││
│  │  • Queries relationships (blockers, implementers, ready)     ││
│  │  • Stores cross-system feedback                              ││
│  │  • Maintains node registry with cached metadata              ││
│  │                                                              ││
│  │  3 Tools: link, query, annotate                              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### What OpenTasks Owns

| Component | Description |
|-----------|-------------|
| **Edges** | Relationships between nodes (any system) |
| **Node Registry** | Tracks what exists where, with cached metadata |
| **Cross-System Feedback** | Annotations that span system boundaries |

### What OpenTasks Does NOT Own

| Component | Owner |
|-----------|-------|
| **Task/Issue CRUD** | Native systems (Claude Tasks, Beads, Linear, etc.) |
| **Status Workflows** | Each system's semantics |
| **Content Storage** | Providers own their data |
| **Same-System Feedback** | Native comment systems (Beads comments, GH comments, etc.) |

---

## URI Scheme

All nodes are identified by URIs:

```
claude://[session]/[task-id]      # Claude Code task
beads://[workspace]/[id]          # Beads issue
taskmaster://[project]/[id]       # Taskmaster PRD/task
linear://[team]/[id]              # Linear issue
jira://[project]/[key]            # Jira issue
github://[owner]/[repo]/[num]     # GitHub issue
native://[type]/[id]              # OpenTasks native node
```

**Examples:**
```
claude://current/t-abc123         # Claude task in current session
beads://./bd-x7k9                 # Beads issue in current workspace
taskmaster://./auth-prd           # Taskmaster PRD
linear://ENG/ENG-123              # Linear issue
native://s-a2b3                   # Native OpenTasks spec
```

---

## The 3-Tool Interface

OpenTasks exposes three tools that provide the graph connectivity layer:

```
┌─────────────────────────────────────────────────────────────────┐
│                      OpenTasks Tools                             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  link                                                       │ │
│  │  Create or remove relationships between any nodes           │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  query                                                      │ │
│  │  Query the graph: edges, blockers, ready, resolve URIs      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  annotate                                                   │ │
│  │  Add feedback, tags, or metadata to any node                │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tool: `link`

Create or remove relationships between nodes across any systems.

### Signature

```typescript
function link(params: LinkParams): LinkResult

interface LinkParams {
  // Create edge
  from: string                    // Source URI
  to: string                      // Target URI
  type: EdgeType                  // Relationship type

  // Optional
  remove?: boolean                // If true, removes the edge instead
  metadata?: Record<string, unknown>
}

type EdgeType =
  | 'blocks'           // from must complete before to can start
  | 'implements'       // issue implements spec
  | 'child-of'         // hierarchical parent-child
  | 'references'       // general reference
  | 'related'          // loose association
  | 'duplicates'       // marks duplicate
  | 'supersedes'       // replaces another node
  | 'depends-on'       // soft dependency (informational)
  | 'discovered-from'  // found while working on
  | string             // extensible

interface LinkResult {
  edge_id: string
  from: string
  to: string
  type: EdgeType
  created_at: string
}
```

### Examples

```typescript
// Beads issue implements Taskmaster spec
link({
  from: 'beads://./bd-x7k9',
  to: 'taskmaster://./auth-prd',
  type: 'implements'
})

// Claude subtask is child of Beads issue
link({
  from: 'claude://current/t-abc',
  to: 'beads://./bd-x7k9',
  type: 'child-of'
})

// One Beads issue blocks another
link({
  from: 'beads://./bd-setup',
  to: 'beads://./bd-impl',
  type: 'blocks'
})

// Remove a relationship
link({
  from: 'beads://./bd-setup',
  to: 'beads://./bd-impl',
  type: 'blocks',
  remove: true
})
```

### Behavior

- **Idempotent**: Creating a duplicate edge returns the existing edge
- **Cross-system**: Can link nodes from any registered provider
- **Auto-registration**: Referenced URIs are automatically registered in the node registry
- **Cycle detection**: Returns error if edge would create circular `blocks` dependency

---

## Tool: `query`

Query the graph for relationships, nodes, and computed views.

### Signature

```typescript
function query(params: QueryParams): QueryResult

interface QueryParams {
  // What to find
  find: QueryType

  // Starting point (required for most query types)
  node?: string                   // URI

  // Filters
  type?: EdgeType | EdgeType[]    // Filter by edge type
  direction?: 'in' | 'out' | 'both'
  providers?: string[]            // Filter by provider
  status?: string | string[]      // Filter by status (canonical)

  // Options
  transitive?: boolean            // Follow chains (for blockers/blocking)
  active_only?: boolean           // Only non-closed nodes
  include_metadata?: boolean      // Include cached node metadata
  limit?: number
}

type QueryType =
  | 'edges'          // Get edges for a node
  | 'blockers'       // What blocks this node?
  | 'blocking'       // What does this node block?
  | 'ready'          // What's ready to work on? (no active blockers)
  | 'implementers'   // Issues implementing a spec
  | 'specs'          // Specs that an issue implements
  | 'children'       // Child nodes
  | 'parents'        // Parent nodes
  | 'resolve'        // Get node metadata by URI

type QueryResult = {
  nodes?: NodeRef[]
  edges?: Edge[]
  node?: NodeRef      // For 'resolve' query
}

interface NodeRef {
  uri: string
  provider: string
  title?: string
  status?: string           // Canonical status
  provider_status?: string  // Provider's actual status
  type?: 'spec' | 'issue' | 'task' | 'feedback'
  cached_at?: string
  stale?: boolean
}

interface Edge {
  id: string
  from: string
  to: string
  type: EdgeType
  created_at: string
  metadata?: Record<string, unknown>
}
```

### Query Types

#### `edges` — Get relationships for a node

```typescript
// All edges for a Beads issue
query({ find: 'edges', node: 'beads://./bd-x7k9' })

// Only outgoing 'blocks' edges
query({
  find: 'edges',
  node: 'beads://./bd-x7k9',
  direction: 'out',
  type: 'blocks'
})
```

#### `blockers` — What blocks this node?

```typescript
// Direct blockers
query({ find: 'blockers', node: 'beads://./bd-impl' })
// Returns: [{ uri: 'beads://./bd-setup', title: 'Set up database', status: 'in_progress' }]

// Transitive blockers (blockers of blockers)
query({ find: 'blockers', node: 'beads://./bd-impl', transitive: true })

// Only active blockers (not closed)
query({ find: 'blockers', node: 'beads://./bd-impl', active_only: true })
```

#### `blocking` — What does this node block?

```typescript
query({ find: 'blocking', node: 'beads://./bd-setup' })
// Returns nodes that are waiting on bd-setup
```

#### `ready` — What's ready to work on?

```typescript
// All ready work across all providers
query({ find: 'ready' })

// Ready work from specific providers
query({ find: 'ready', providers: ['beads', 'claude'] })

// Ready work with specific status
query({ find: 'ready', status: 'open' })
```

**Ready logic:**
1. Queries each provider for open/pending items
2. Filters out items with active (non-closed) blockers in OpenTasks graph
3. Returns unified list with provider metadata

#### `implementers` — Issues implementing a spec

```typescript
query({ find: 'implementers', node: 'taskmaster://./auth-prd' })
// Returns: [{ uri: 'beads://./bd-x7k9', title: 'Implement OAuth', ... }]
```

#### `specs` — Specs that an issue implements

```typescript
query({ find: 'specs', node: 'beads://./bd-x7k9' })
// Returns: [{ uri: 'taskmaster://./auth-prd', title: 'Auth PRD', ... }]
```

#### `children` / `parents` — Hierarchical queries

```typescript
// Get subtasks of a Beads issue
query({ find: 'children', node: 'beads://./bd-x7k9' })
// Might return Claude tasks that are children

// Get parent of a Claude task
query({ find: 'parents', node: 'claude://current/t-abc' })
```

#### `resolve` — Get node metadata by URI

```typescript
query({ find: 'resolve', node: 'beads://./bd-x7k9' })
// Returns: {
//   node: { uri: 'beads://./bd-x7k9', provider: 'beads', title: '...', status: 'open', ... }
// }

// With fresh fetch (bypass cache)
query({ find: 'resolve', node: 'beads://./bd-x7k9', include_metadata: true })
```

---

## Tool: `annotate`

Add feedback, tags, or metadata to any node. Handles routing between native comment systems and OpenTasks storage.

### Signature

```typescript
function annotate(params: AnnotateParams): AnnotateResult

interface AnnotateParams {
  // Target node
  target: string                  // URI of node to annotate

  // Source context (optional - for cross-system feedback)
  source?: string                 // URI of node providing the feedback

  // Annotation content (at least one required)
  feedback?: {
    content: string
    type: 'comment' | 'suggestion' | 'request'
    anchor?: Anchor
  }
  tags?: string[]                 // Add tags
  metadata?: Record<string, unknown>  // Add metadata
}

interface Anchor {
  line?: number                   // Line number (1-indexed)
  text?: string                   // Text snippet for fuzzy matching
  section?: string                // Section heading
}

interface AnnotateResult {
  id: string
  stored_in: 'opentasks' | 'native'
  provider?: string               // If stored in native system
  target: string
  created_at: string
}
```

### Feedback Routing

Feedback is automatically routed based on context:

| Scenario | Destination | Rationale |
|----------|-------------|-----------|
| Cross-system feedback (source and target in different systems) | OpenTasks | Native systems can't handle cross-refs |
| Implementation feedback on spec | OpenTasks | Anchored feedback with relocation |
| Same-system, provider supports comments | Native | Keep feedback where it belongs |
| Same-system, no comment support | OpenTasks | Fallback |

### Examples

```typescript
// Cross-system feedback: Beads issue commenting on Taskmaster spec
annotate({
  target: 'taskmaster://./auth-prd',
  source: 'beads://./bd-x7k9',
  feedback: {
    content: 'Implemented Google OAuth; GitHub OAuth deferred to follow-up',
    type: 'comment'
  }
})
// Stored in: OpenTasks (cross-system)

// Anchored suggestion on a spec
annotate({
  target: 'taskmaster://./auth-prd',
  feedback: {
    content: 'Consider adding rate limiting for security',
    type: 'suggestion',
    anchor: { line: 15, text: 'OAuth2 endpoints' }
  }
})
// Stored in: OpenTasks (anchored feedback)

// Comment on Beads issue (same-system)
annotate({
  target: 'beads://./bd-x7k9',
  feedback: {
    content: 'Started implementation, ETA 2 hours',
    type: 'comment'
  }
})
// Stored in: Native (Beads comments)

// Add tags to any node
annotate({
  target: 'beads://./bd-x7k9',
  tags: ['urgent', 'security']
})

// Add metadata
annotate({
  target: 'claude://current/t-abc',
  metadata: { estimated_minutes: 30 }
})
```

### Querying Feedback

Feedback can be queried via the `query` tool:

```typescript
query({
  find: 'edges',
  node: 'taskmaster://./auth-prd',
  type: 'feedback'
})
```

Or via provider-specific feedback aggregation (see PROVIDERS.md).

---

## Complete Workflow Example

An agent implementing a feature using multiple systems:

```typescript
// 1. PRD exists in Taskmaster (created via tm CLI)
const prdUri = 'taskmaster://./auth-feature'

// 2. Check what specs exist for context
const specs = await query({ find: 'resolve', node: prdUri })
console.log(specs.node.title)  // "Authentication Feature PRD"

// 3. Create main issue in Beads (using bd CLI)
// $ bd new -t "Implement OAuth2 authentication"
const mainIssue = 'beads://./bd-x7k9'

// 4. Link issue to spec
await link({
  from: mainIssue,
  to: prdUri,
  type: 'implements'
})

// 5. Break down into Claude subtasks for immediate work
const subtask1 = TaskCreate({
  subject: 'Set up OAuth provider config',
  description: '...'
})
const subtask2 = TaskCreate({
  subject: 'Implement login endpoint',
  description: '...'
})

// 6. Link subtasks to parent Beads issue
await link({
  from: `claude://current/${subtask1.id}`,
  to: mainIssue,
  type: 'child-of'
})
await link({
  from: `claude://current/${subtask2.id}`,
  to: mainIssue,
  type: 'child-of'
})

// 7. Subtask 2 depends on subtask 1
await link({
  from: `claude://current/${subtask1.id}`,
  to: `claude://current/${subtask2.id}`,
  type: 'blocks'
})

// 8. Check what's ready to work on
const ready = await query({ find: 'ready' })
// Returns subtask1 (subtask2 is blocked)

// 9. Work on subtask 1 (using Claude Tasks)
TaskUpdate({ taskId: subtask1.id, status: 'in_progress', owner: 'agent-1' })
// ... do work ...
TaskUpdate({ taskId: subtask1.id, status: 'completed' })

// 10. Now subtask2 is ready
const nowReady = await query({ find: 'ready' })
// Returns subtask2

// 11. Add feedback on the spec after implementation
await annotate({
  target: prdUri,
  source: mainIssue,
  feedback: {
    content: 'Implemented Google OAuth. GitHub OAuth requires additional scopes - created follow-up issue.',
    type: 'comment',
    anchor: { section: 'OAuth Providers' }
  }
})

// 12. Update Beads issue status (using bd CLI)
// $ bd update bd-x7k9 -s closed
```

---

## Error Handling

```typescript
interface OpenTasksError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

type ErrorCode =
  | 'NOT_FOUND'           // URI doesn't resolve
  | 'INVALID_URI'         // Malformed URI
  | 'UNKNOWN_PROVIDER'    // No provider for URI scheme
  | 'VALIDATION_ERROR'    // Invalid parameters
  | 'CYCLE_DETECTED'      // Would create circular blocks dependency
  | 'PROVIDER_ERROR'      // Provider failed
  | 'STORAGE_ERROR'       // Persistence failure
```

**Examples:**

```typescript
// Self-referencing edge
link({ from: 'beads://./bd-x7k9', to: 'beads://./bd-x7k9', type: 'blocks' })
// Error: { code: 'VALIDATION_ERROR', message: 'Cannot create self-referencing edge' }

// Circular dependency
link({ from: 'beads://./bd-c', to: 'beads://./bd-a', type: 'blocks' })
// (when bd-a blocks bd-b, bd-b blocks bd-c)
// Error: { code: 'CYCLE_DETECTED', message: 'Would create circular dependency',
//          details: { cycle: ['bd-a', 'bd-b', 'bd-c', 'bd-a'] } }

// Unknown provider
query({ find: 'resolve', node: 'unknown://foo' })
// Error: { code: 'UNKNOWN_PROVIDER', message: 'No provider registered for scheme: unknown' }
```

---

## Native System Integration

OpenTasks doesn't replace native systems — it connects them. Here's how each system fits:

### Claude Code Tasks

| Aspect | Handling |
|--------|----------|
| **CRUD** | Use native `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList` |
| **URI scheme** | `claude://[session]/[task-id]` |
| **Linking** | Use OpenTasks `link` to connect to other systems |
| **Feedback** | No native comments; use OpenTasks `annotate` |

### Beads

| Aspect | Handling |
|--------|----------|
| **CRUD** | Use `bd` CLI or Beads API |
| **URI scheme** | `beads://[workspace]/[id]` |
| **Linking** | Native deps for same-system; OpenTasks for cross-system |
| **Feedback** | Native comments for same-system; OpenTasks for cross-system |

### Taskmaster

| Aspect | Handling |
|--------|----------|
| **CRUD** | Use `tm` CLI or Taskmaster API |
| **URI scheme** | `taskmaster://[project]/[id]` |
| **Linking** | Use OpenTasks for all relationships |
| **Feedback** | Use OpenTasks `annotate` |

---

## Status Mapping

Different systems have different status models. OpenTasks uses canonical statuses for cross-system queries:

| Canonical | Meaning | Maps From |
|-----------|---------|-----------|
| `open` | Not started | Claude `pending`, Beads `open`/`pinned`, Linear `Backlog` |
| `in_progress` | Active work | Claude `in_progress`, Beads `in_progress`, Linear `In Progress` |
| `blocked` | Waiting | Beads `blocked`/`hooked`/`deferred`, Linear `Blocked` |
| `closed` | Done | Claude `completed`, Beads `closed`, Linear `Done`/`Cancelled` |

The original provider status is preserved in `provider_status` for display.

---

## Open Questions

- [ ] **Session URIs**: How to handle `claude://current/...` when session changes?
- [ ] **Cache invalidation**: When to refresh node metadata from providers?
- [ ] **Bulk operations**: Should `link` and `annotate` support batching?
- [ ] **Event subscriptions**: Should tools support watching for changes?
- [ ] **Offline mode**: Behavior when providers are unavailable?

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.2.0 | 2025-01-27 | Reframed as graph connector; 3-tool interface |
| 0.1.0 | 2025-01-26 | Initial draft |
