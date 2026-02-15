# Phase 1: Single-Location + Provider URIs

> Spec ID: c-9hf5 | Tags: phase-1, v1, implementation
>
> Implements: [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md)

## Scope

The minimal viable OpenTasks that provides the core graph connector value:
- One `.opentasks/` directory per working context
- Edges that reference provider URIs (`beads://`, `claude://`, `jira://`, etc.)
- Optional native context/tasks for lightweight use
- Direct file access (no daemon)

## What's Included

### Core Data Layer
- Node types: `spec`, `issue`, `feedback`, `external`
- Edge types: `blocks`, `implements`, `references`, `related`, etc.
- JSONL storage (`graph.jsonl`) as source of truth
- SQLite cache (`cache.db`) for fast queries

### Provider System
- Provider registry with URI scheme routing
- Native provider (optional, toggleable) for local context/issues
- Provider interface for external systems
- Stub implementations for Beads, Claude Tasks

### 3-Tool Interface
- `link(from, to, type)` — create/remove edges
- `query(find, node?, filters)` — query graph relationships
- `annotate(target, feedback)` — add feedback to nodes

### Storage Format

**graph.jsonl** — Nodes and edges:
```jsonl
{"id":"c-a2b3","uuid":"...","type":"spec","title":"Auth requirements","content":"...","created_at":"...","updated_at":"..."}
{"id":"t-x7k9","uuid":"...","type":"issue","title":"Implement login","status":"open","created_at":"...","updated_at":"..."}
{"id":"x-r8s9","uuid":"...","from_id":"t-x7k9","to_id":"c-a2b3","type":"implements","created_at":"..."}
{"id":"x-t1u2","uuid":"...","from_id":"t-x7k9","to_id":"beads://./bd-123","type":"blocks","created_at":"..."}
```

**config.json** — Location configuration:
```json
{
  "version": "1.0",
  "location": {
    "name": "myapp",
    "uri": "opentasks:///Users/alex/projects/myapp/.opentasks/"
  },
  "providers": {
    "native": { "enabled": true },
    "beads": { "workspace": "." }
  }
}
```

## What's NOT Included (Phase 2+)

- `opentasks://` URIs to other locations
- Cross-location queries
- Daemon architecture
- Redirect rules
- Location discovery
- Global registry

## Schema Preparation for Future

Even though we're not implementing cross-location yet, the schema should support it:

1. **Location URI in config** — Store canonical location URI
2. **Full URI support in edges** — Parser handles `opentasks://` even if not resolved
3. **Source tracking on nodes** — Know where nodes came from

## Deliverables

### Core Package (`@opentasks/core`)
- [ ] TypeScript types for all node/edge types
- [ ] ID generation (hash-based, prefix by type)
- [ ] Content hashing for dedup
- [ ] Validation functions

### Storage Package (`@opentasks/storage`)
- [ ] Persister interface (TinyBase-inspired)
- [ ] JSONL persister
- [ ] SQLite persister (cache/index)
- [ ] Persistence manager (coordinates persisters)

### Graph Package (`@opentasks/graph`)
- [ ] Graph data structure (nodes + edges)
- [ ] Query engine (filters, traversal)
- [ ] Mutation handlers (create, update, delete, archive)

### Interface Package (`@opentasks/interface`)
- [ ] `link()` implementation
- [ ] `query()` implementation
- [ ] `annotate()` implementation
- [ ] Error types and handling

### Provider Package (`@opentasks/providers`)
- [ ] Provider interface
- [ ] Provider registry
- [ ] Native provider (context, tasks)
- [ ] External node management (phantom → materialized)
- [ ] Beads provider stub
- [ ] Claude Tasks provider stub

### CLI (`@opentasks/cli`)
- [ ] `opentasks init` — Initialize .opentasks/ directory
- [ ] `opentasks link` — Create edges
- [ ] `opentasks query` — Query graph
- [ ] `opentasks show` — Show node details

## Technical Decisions

### URI Parsing
```typescript
interface ParsedURI {
  scheme: string        // "beads", "claude", "opentasks", etc.
  path: string          // "./bd-123", "current/t-abc", etc.
  nodeId: string        // "bd-123", "t-abc", etc.
  isRelative: boolean   // true for "./", false for absolute
}

function parseURI(uri: string): ParsedURI
function isLocalId(ref: string): boolean  // "t-x7k9" vs "beads://..."
function toCanonicalURI(ref: string, location: string): string
```

### Query Types
```typescript
type QueryType =
  | 'edges'          // Get edges for a node
  | 'blockers'       // What blocks this node?
  | 'blocking'       // What does this node block?
  | 'ready'          // What's ready to work on?
  | 'tasks'   // Tasks implementing a context
  | 'context'          // Specs that a task implements
  | 'children'       // Child nodes
  | 'parents'        // Parent nodes
  | 'resolve'        // Get node metadata by URI
```

### Provider Interface
```typescript
interface Provider {
  name: string
  schemes: string[]
  capabilities: { read, write, search, watch, ready }

  get(id: string): Promise<ProviderNode | null>
  list(filter?: Filter): Promise<ProviderNode[]>
  create?(input: CreateInput): Promise<ProviderNode>
  update?(id: string, updates: Updates): Promise<ProviderNode>
}
```

## Success Criteria

Phase 1 is complete when:
1. Can initialize `.opentasks/` in a directory
2. Can create native context and issues
3. Can create edges between native nodes
4. Can create edges to provider URIs (e.g., `beads://./bd-123`)
5. Can query blockers, ready items across the graph
6. Can add feedback/annotations to nodes
7. Storage persists correctly to JSONL and rebuilds SQLite cache
