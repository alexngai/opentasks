# OpenTasks Providers

This document defines the provider architecture for OpenTasks.

See also:
- [DESIGN.md](./DESIGN.md) — Design rationale and core concepts
- [SCHEMA.md](./SCHEMA.md) — Data model and types
- [PERSISTENCE.md](./PERSISTENCE.md) — Storage and sync
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Location hierarchy and daemon
- [INTERFACE.md](./INTERFACE.md) — API

---

## Overview

OpenTasks uses a **federated graph model** where:

- **OpenTasks owns the graph structure** — edges, relationships, and node references
- **Providers own node content** — the actual context and task data
- **Daemon coordinates access** — all provider operations go through the location daemon
- **Location isolation** — each `.opentasks/` location has its own provider configuration

This separation allows OpenTasks to integrate with existing tools (Beads, Taskmaster, Linear) without duplicating data or creating sync conflicts.

### Integration Patterns

OpenTasks supports multiple integration patterns depending on the external system:

| Pattern | Direction | Use Case | Example |
|---------|-----------|----------|---------|
| **Provider** | Read-heavy | External system is source of truth | Beads, Jira (read-only) |
| **Adapter** | Bidirectional | Full sync between systems | Linear ↔ OpenTasks |
| **SyncTarget** | Write-heavy | OpenTasks is source of truth | Export to GitHub Issues |

The Provider interface (described below) is the foundation. Adapters and SyncTargets extend it with additional capabilities.

```
┌─────────────────────────────────────────────────────────────────┐
│               OpenTasks Location (graph.jsonl)                   │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Native Nodes                             │ │
│  │  Context (c-a2b3)    Task (t-x7k9)    Feedback (f-m4n5)      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  ExternalNodes (cached)                     │ │
│  │  e-bd1: beads://./bd-123     (materialized)                │ │
│  │  e-tm1: taskmaster://./prd-1 (materialized)                │ │
│  │  e-jir: jira://PROJ-456      (phantom, not yet fetched)    │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                        Edges                                │ │
│  │  t-x7k9 ──implements──▶ c-a2b3                             │ │
│  │  t-x7k9 ──blocks──▶ beads://./bd-456                       │ │
│  │  e-bd1 ──discovered-from──▶ e-tm1                          │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                        Daemon (IPC)
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
┌───────────────────┐ ┌───────────────┐ ┌───────────────────┐
│  Task Providers  │ │ Context Providers│ │  Other Locations  │
│                   │ │               │ │                   │
│  • Beads CLI      │ │ • Taskmaster  │ │  opentasks://~    │
│  • Linear API     │ │ • spec-kit    │ │  opentasks://../  │
│  • Jira API       │ │               │ │                   │
└───────────────────┘ └───────────────┘ └───────────────────┘
```

---

## Design Principles

### 1. Separation of Concerns

| Component | Owner | Storage |
|-----------|-------|---------|
| **Graph Structure** | OpenTasks | `.opentasks/graph.jsonl` |
| ↳ Edges/Relationships | OpenTasks | (in graph.jsonl) |
| ↳ Native Nodes | OpenTasks | (in graph.jsonl) |
| ↳ ExternalNodes (cache) | OpenTasks | (in graph.jsonl) |
| ↳ Feedback | OpenTasks | (in graph.jsonl) |
| **External Task Content** | Task Provider | Provider's storage |
| **External Context Content** | Context Provider | Provider's storage |

See [PERSISTENCE.md](./PERSISTENCE.md) for details on the unified graph storage.

### 2. Provider Authority

Providers are the **source of truth** for their content. OpenTasks:

- **Reads** content from providers on demand
- **Caches** metadata for display (title, status)
- **Never duplicates** full content
- **Delegates** CRUD operations to providers

### 3. URI-Based References

OpenTasks uses two URI schemes:

**Provider URIs** — References to external system content:
```
beads://[workspace]/[id]        # Beads issue
taskmaster://[project]/[id]     # Taskmaster PRD/task
linear://[team]/[id]            # Linear issue
jira://[project]/[key]          # Jira issue
github://[owner]/[repo]/[num]   # GitHub issue
```

**OpenTasks URIs** — Cross-location references (see [ARCHITECTURE.md](./ARCHITECTURE.md)):
```
opentasks://~/.opentasks/c-a2b3              # User location
opentasks://./t-x7k9                         # Current location
opentasks://../.opentasks/c-c4d5             # Parent directory
opentasks:///abs/path/.opentasks/t-e6f7      # Absolute path
```

**URI Resolution Priority:**
1. Local ID lookup (if no scheme prefix, e.g., `c-a2b3`)
2. OpenTasks URI resolution (for `opentasks://` scheme)
3. Provider URI resolution (for provider schemes like `beads://`, `jira://`)

### 4. Graceful Degradation & Phantom Nodes

OpenTasks supports **progressive materialization** for external references:

```
URI Reference → Phantom Node → Materialized Node
     │                │                │
     │                │                └── Full data fetched, cached
     │                └── ExternalNode exists, materialized=false
     └── Just a string in an edge target
```

**Degradation chain:**
1. **Provider available**: Fetch fresh data, cache it
2. **Provider unavailable**: Use cached data (with `stale: true`)
3. **No cache**: Return phantom node (just URI and type)
4. **No ExternalNode**: Edge still valid, target resolves to URI string

This aligns with the `ExternalNode` type in [SCHEMA.md](./SCHEMA.md):
```typescript
interface ExternalNode {
  type: 'external'
  uri: string                    // Canonical URI (e.g., "jira://PROJ-123")
  source: string                 // Provider name
  materialized: boolean          // Has data been fetched?
  cached_at?: string             // When last fetched
  stale?: boolean                // Needs refresh
  external_data?: Record<string, unknown>
}
```

---

## Provider Interface

### Base Provider

```typescript
/**
 * Base interface for all content providers
 */
interface ContentProvider {
  /** Unique provider identifier */
  readonly name: string

  /** URI scheme(s) this provider handles */
  readonly schemes: string[]

  /** Node types this provider manages */
  readonly nodeTypes: ('context' | 'task')[]

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities

  // === Lifecycle ===

  /** Initialize provider (called once on startup) */
  initialize?(config: ProviderConfig): Promise<void>

  /** Check if provider is available/healthy */
  healthCheck?(): Promise<HealthStatus>

  // === Read Operations ===

  /** Get a single node by ID */
  get(id: string): Promise<ProviderNode | null>

  /** List nodes with optional filtering */
  list(filter?: ProviderFilter): Promise<ProviderNode[]>

  /** Search nodes by query string */
  search?(query: string): Promise<ProviderNode[]>

  /** Get nodes ready for work (no blockers) */
  ready?(): Promise<ProviderNode[]>

  // === Write Operations (optional) ===

  /** Create a new node */
  create?(input: CreateNodeInput): Promise<ProviderNode>

  /** Update an existing node */
  update?(id: string, updates: UpdateNodeInput): Promise<ProviderNode>

  /** Close/complete a node */
  close?(id: string, reason?: string): Promise<ProviderNode>

  /** Delete a node */
  delete?(id: string): Promise<void>

  // === Sync Operations (optional) ===

  /** Watch for changes (real-time updates) */
  watch?(callback: (event: ProviderEvent) => void): Unsubscribe

  /** Pull changes since last sync */
  pullChanges?(since?: string): Promise<ChangeSet>

  // === Mapping ===

  /** Convert provider-native format to OpenTasks node */
  toOpenTasks(native: unknown): ProviderNode

  /** Convert OpenTasks node to provider-native format */
  fromOpenTasks(node: ProviderNode): unknown
}

interface ProviderCapabilities {
  read: boolean
  write: boolean
  delete: boolean
  search: boolean
  watch: boolean
  ready: boolean  // supports "ready" query
}

interface ProviderNode {
  /** Provider-specific ID */
  id: string

  /** Full URI for this node */
  uri: string

  /** Node type */
  type: 'context' | 'task'

  /** Display title */
  title: string

  /** Full content (markdown) */
  content?: string

  /** Provider's status value */
  status?: string

  /** Priority (0-4) */
  priority?: number

  /** Tags/labels */
  tags?: string[]

  /** Assignment */
  assignee?: string

  /** Timestamps */
  created_at: string
  updated_at: string

  /** Provider-specific data */
  provider_data?: Record<string, unknown>
}

interface ProviderEvent {
  type: 'created' | 'updated' | 'deleted'
  uri: string
  node?: ProviderNode
  timestamp: string
}

type Unsubscribe = () => void
```

---

## Daemon Integration

All provider operations are coordinated through the location daemon. This ensures:
- Consistent caching across clients
- Proper lock management
- Event propagation to watchers
- Cross-location resolution

### Provider Registration Flow

```
┌───────────────────────────────────────────────────────────────────┐
│                      Daemon Startup                                │
│                                                                    │
│  1. Read .opentasks/config.json for provider config               │
│  2. Initialize configured providers                                │
│  3. Register providers in ProviderRegistry                        │
│  4. Start watchers for providers with watch capability            │
└───────────────────────────────────────────────────────────────────┘
```

### Request Flow

```typescript
// Client makes request
const node = await client.get('beads://./bd-x7k9')

// Daemon handles:
// 1. Parse URI to determine provider
// 2. Check ExternalNode cache
// 3. If stale or missing, delegate to provider
// 4. Update ExternalNode with fetched data
// 5. Return to client
```

### IPC Methods for Providers

The daemon exposes these provider-related IPC methods:

| Method | Description |
|--------|-------------|
| `provider.resolve` | Resolve URI to node (with caching) |
| `provider.list` | List nodes from a provider |
| `provider.search` | Search across providers |
| `provider.ready` | Get ready items (with cross-provider blocking) |
| `provider.create` | Create via provider (if writable) |
| `provider.update` | Update via provider (if writable) |
| `provider.refresh` | Force refresh from provider |

### Cross-Location Provider Resolution

When an edge references a node in another location:

```typescript
// Edge in ~/projects/app-a/.opentasks/
{
  from_id: "t-local",
  to_id: "opentasks://~/projects/app-b/.opentasks/t-x7k9",
  type: "blocks"
}

// Resolution:
// 1. Parse opentasks:// URI
// 2. Find daemon for ~/projects/app-b/.opentasks/
// 3. Request node from that daemon
// 4. That daemon may further resolve to a provider URI
```

This enables multi-hop resolution:
```
opentasks://location-b/e-ext1 → beads://./bd-123 → Beads CLI
```

---

## Task Providers

### Beads Provider

[Beads](https://github.com/steveyegge/beads) is a distributed, git-backed issue tracker designed for AI agents.

```typescript
interface BeadsProvider extends ContentProvider {
  name: 'beads'
  schemes: ['beads']
  nodeTypes: ['task']

  capabilities: {
    read: true,
    write: true,
    delete: true,
    search: true,
    watch: true,    // via file watcher on .beads/issues.jsonl
    ready: true     // `bd ready` command
  }
}
```

#### URI Format

```
beads://[workspace]/[id]

Examples:
  beads://./bd-x7k9           # Current workspace
  beads:///path/to/repo/bd-y8  # Absolute path
  beads://bd-z9a1             # Implicit current workspace
```

#### Field Mapping

| Beads Field | OpenTasks Field | Notes |
|-------------|-----------------|-------|
| `id` | `id` | Hash-based (bd-xxxx) |
| `title` | `title` | Direct mapping |
| `description` | `content` | Primary content |
| `design`, `acceptance_criteria`, `notes` | `content` | Concatenated with separators |
| `status` | `status` | open, in_progress, blocked, closed, etc. |
| `priority` | `priority` | 0-4 (same semantics) |
| `labels` | `tags` | Direct mapping |
| `assignee` | `assignee` | Direct mapping |
| `dependencies` | Edges | Converted to OpenTasks edges |
| `comments` | Feedback nodes | Each comment becomes feedback |

#### Dependency Mapping

Beads dependencies map to OpenTasks edges:

| Beads Dependency | OpenTasks Edge | Direction |
|------------------|----------------|-----------|
| `blocks` | `blocks` | from → to |
| `parent-child` | `parent-of` | parent → child |
| `related` | `related` | bidirectional |
| `discovered-from` | `discovered-from` | from → to |

#### Implementation

```typescript
class BeadsProvider implements ContentProvider {
  private workspace: string

  constructor(config: { workspace?: string }) {
    this.workspace = config.workspace || process.cwd()
  }

  async get(id: string): Promise<ProviderNode | null> {
    // Use `bd show <id> --json` or read directly from .beads/
    const result = await exec(`bd show ${id} --json`, {
      cwd: this.workspace
    })
    if (!result) return null
    return this.toOpenTasks(JSON.parse(result))
  }

  async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
    // Use `bd list --json` with filters
    const args = this.buildListArgs(filter)
    const result = await exec(`bd list ${args} --json`, {
      cwd: this.workspace
    })
    return JSON.parse(result).map(this.toOpenTasks)
  }

  async ready(): Promise<ProviderNode[]> {
    // Use `bd ready --json`
    const result = await exec('bd ready --json', {
      cwd: this.workspace
    })
    return JSON.parse(result).map(this.toOpenTasks)
  }

  async create(input: CreateNodeInput): Promise<ProviderNode> {
    // Use `bd new`
    const result = await exec(
      `bd new -t "${input.title}" -d "${input.content || ''}"`,
      { cwd: this.workspace }
    )
    const id = this.parseCreatedId(result)
    return this.get(id)
  }

  async update(id: string, updates: UpdateNodeInput): Promise<ProviderNode> {
    // Use `bd update`
    const args = this.buildUpdateArgs(updates)
    await exec(`bd update ${id} ${args}`, { cwd: this.workspace })
    return this.get(id)
  }

  watch(callback: (event: ProviderEvent) => void): Unsubscribe {
    // Watch .beads/issues.jsonl for changes
    const watcher = fs.watch(
      path.join(this.workspace, '.beads', 'issues.jsonl'),
      () => callback({ type: 'updated', uri: 'beads://*', timestamp: new Date().toISOString() })
    )
    return () => watcher.close()
  }

  toOpenTasks(bead: BeadsIssue): ProviderNode {
    // Concatenate content fields
    const contentParts = [
      bead.description,
      bead.design && `## Design\n\n${bead.design}`,
      bead.acceptance_criteria && `## Acceptance Criteria\n\n${bead.acceptance_criteria}`,
      bead.notes && `## Notes\n\n${bead.notes}`,
    ].filter(Boolean)

    return {
      id: bead.id,
      uri: `beads://${this.workspace}/${bead.id}`,
      type: 'task',
      title: bead.title,
      content: contentParts.join('\n\n---\n\n'),
      status: this.mapStatus(bead.status),
      priority: bead.priority,
      tags: bead.labels,
      assignee: bead.assignee,
      created_at: bead.created_at,
      updated_at: bead.updated_at,
      provider_data: {
        issue_type: bead.issue_type,
        estimated_minutes: bead.estimated_minutes,
        dependencies: bead.dependencies,
      }
    }
  }

  private mapStatus(beadsStatus: string): string {
    // Beads has more statuses; map to OpenTasks core set
    const mapping: Record<string, string> = {
      'open': 'open',
      'in_progress': 'in_progress',
      'blocked': 'blocked',
      'deferred': 'blocked',
      'closed': 'closed',
      'tombstone': 'closed',
      'pinned': 'open',
      'hooked': 'blocked',
    }
    return mapping[beadsStatus] || beadsStatus
  }
}
```

#### Configuration

```json
// .opentasks/config.json
{
  "providers": {
    "issues": {
      "primary": "beads",
      "beads": {
        "workspace": ".",
        "cli": "bd"
      }
    }
  }
}
```

---

### Linear Provider

[Linear](https://linear.app) is a project management tool with a GraphQL API.

```typescript
interface LinearProvider extends ContentProvider {
  name: 'linear'
  schemes: ['linear']
  nodeTypes: ['task']

  capabilities: {
    read: true,
    write: true,
    delete: false,   // Linear doesn't support hard delete
    search: true,
    watch: true,     // via webhooks
    ready: false     // no native "ready" concept
  }
}
```

#### URI Format

```
linear://[team]/[id]

Examples:
  linear://ENG/ENG-123
  linear://PROD/PROD-456
```

#### Field Mapping

| Linear Field | OpenTasks Field |
|--------------|-----------------|
| `id` | `id` |
| `identifier` | URI path (`ENG-123`) |
| `title` | `title` |
| `description` | `content` |
| `state.name` | `status` |
| `priority` | `priority` (mapped 0-4) |
| `labels` | `tags` |
| `assignee.name` | `assignee` |

---

### Native Task Provider

Fallback provider when no external task tracker is configured. Unlike external providers, native nodes are stored directly in `graph.jsonl` as `Task` type (not `ExternalNode`).

```typescript
interface NativeTaskProvider extends ContentProvider {
  name: 'native'
  schemes: ['native', 'opentasks']
  nodeTypes: ['task']

  capabilities: {
    read: true,
    write: true,
    delete: true,
    search: true,
    watch: true,    // file watcher on graph.jsonl
    ready: true     // computed from edges
  }
}
```

**Storage**: Native tasks use the `Task` type directly in `graph.jsonl`:
```json
{
  "id": "t-x7k9",
  "type": "task",
  "title": "Implement feature",
  "status": "open",
  ...
}
```

This is different from external providers, which create `ExternalNode` wrappers.

---

## Context Providers

### Taskmaster Provider

[Taskmaster](https://github.com/eyaltoledano/claude-task-master) manages PRDs and breaks them into subtasks.

```typescript
interface TaskmasterProvider extends ContentProvider {
  name: 'taskmaster'
  schemes: ['taskmaster', 'tm']
  nodeTypes: ['context']

  capabilities: {
    read: true,
    write: true,
    delete: true,
    search: true,
    watch: true,    // file watcher on tasks/
    ready: false
  }
}
```

#### URI Format

```
taskmaster://[project]/[id]

Examples:
  taskmaster://./prd            # Root PRD
  taskmaster://./task-1         # Subtask
  tm://task-1                   # Short form
```

#### Field Mapping

| Taskmaster Field | OpenTasks Field |
|------------------|-----------------|
| `id` | `id` |
| `title` | `title` |
| `description` | `content` |
| `status` | `status` |
| `priority` | `priority` |
| `dependencies` | Edges (`depends-on`) |
| `subtasks` | Child specs via `parent-of` edges |

#### Directory Structure

```
tasks/
├── tasks.json          # Task definitions
├── prd.txt            # Product requirements document
└── complexity-report.json
```

---

### Native Context Provider

Fallback provider for context when no external context tool is configured. Like native tasks, these are stored directly as `Context` type in `graph.jsonl`.

```typescript
interface NativeContextProvider extends ContentProvider {
  name: 'native'
  schemes: ['native', 'opentasks']
  nodeTypes: ['context']

  capabilities: {
    read: true,
    write: true,
    delete: true,
    search: true,
    watch: true,    // file watcher on graph.jsonl
    ready: false
  }
}
```

**Storage**: Native context use the `Context` type directly in `graph.jsonl`:
```json
{
  "id": "c-a2b3",
  "type": "context",
  "title": "Authentication requirements",
  "content": "## Overview\n...",
  ...
}
```

---

## Provider Registry

The provider registry manages configured providers and routes operations.

```typescript
interface ProviderRegistry {
  /** Register a provider */
  register(provider: ContentProvider): void

  /** Get provider for a URI */
  getProvider(uri: string): ContentProvider | null

  /** Get provider by name */
  getByName(name: string): ContentProvider | null

  /** Get primary provider for a node type */
  getPrimary(nodeType: 'context' | 'task'): ContentProvider

  /** Get fallback provider for a node type */
  getFallback(nodeType: 'context' | 'task'): ContentProvider

  /** Resolve a URI to a node (with caching) */
  resolve(uri: string, options?: ResolveOptions): Promise<ProviderNode | null>

  /** List all registered providers */
  list(): ContentProvider[]
}

interface ResolveOptions {
  /** Skip cache and fetch fresh */
  fresh?: boolean

  /** Return cached even if stale */
  allowStale?: boolean

  /** Timeout for fetch */
  timeout?: number
}
```

### Resolution Flow

```typescript
async function resolve(uri: string, options?: ResolveOptions): Promise<ProviderNode | null> {
  // 1. Check cache (unless fresh requested)
  if (!options?.fresh) {
    const cached = await cache.get(uri)
    if (cached && (!cached.stale || options?.allowStale)) {
      return cached.node
    }
  }

  // 2. Find provider for URI scheme
  const provider = registry.getProvider(uri)
  if (!provider) {
    // Return cached if available, even without provider
    return cache.get(uri)?.node || null
  }

  // 3. Fetch from provider
  const id = parseIdFromUri(uri)
  const node = await provider.get(id)

  // 4. Update cache
  if (node) {
    await cache.set(uri, node)
  }

  return node
}
```

---

## Adapter Pattern

Adapters extend Providers with bidirectional sync capabilities. Use adapters when:
- Changes in OpenTasks should propagate to the external system
- The external system and OpenTasks need to stay in sync

### Adapter Interface

```typescript
/**
 * Adapter extends Provider with write-back capabilities
 */
interface ContentAdapter extends ContentProvider {
  /** Adapter-specific capabilities */
  readonly adapterCapabilities: AdapterCapabilities

  // === Sync Operations ===

  /** Push local changes to external system */
  push(changes: ChangeSet): Promise<PushResult>

  /** Pull and merge external changes */
  pull(): Promise<PullResult>

  /** Resolve sync conflicts */
  resolveConflict?(conflict: SyncConflict): Promise<Resolution>

  /** Get sync status */
  syncStatus(): Promise<SyncStatus>
}

interface AdapterCapabilities {
  /** Can push changes to external system */
  pushEnabled: boolean

  /** Can handle conflicts */
  conflictResolution: boolean

  /** Supports incremental sync */
  incrementalSync: boolean

  /** Supports webhooks for real-time sync */
  webhooks: boolean
}

interface SyncConflict {
  uri: string
  localVersion: ProviderNode
  remoteVersion: ProviderNode
  conflictType: 'update' | 'delete' | 'create'
}

interface Resolution {
  winner: 'local' | 'remote' | 'merged'
  mergedNode?: ProviderNode
}

interface SyncStatus {
  lastSync: string
  pendingPush: number
  pendingPull: number
  conflicts: SyncConflict[]
}
```

### Conflict Resolution Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| `local-wins` | Local changes overwrite remote | OpenTasks is authoritative |
| `remote-wins` | Remote changes overwrite local | External system is authoritative |
| `last-write-wins` | Most recent `updated_at` wins | Simple merge |
| `manual` | Queue for user resolution | Critical data |
| `content-hash` | Skip if content identical | Avoid false conflicts |

### Example: Linear Adapter

```typescript
class LinearAdapter extends LinearProvider implements ContentAdapter {
  readonly adapterCapabilities = {
    pushEnabled: true,
    conflictResolution: true,
    incrementalSync: true,
    webhooks: true
  }

  async push(changes: ChangeSet): Promise<PushResult> {
    const results: PushResult = { success: [], failed: [] }

    for (const change of changes.updates) {
      try {
        await this.linearClient.updateIssue(change.id, {
          title: change.title,
          description: change.content,
          state: this.mapStatusToLinear(change.status)
        })
        results.success.push(change.uri)
      } catch (err) {
        results.failed.push({ uri: change.uri, error: err })
      }
    }

    return results
  }

  async pull(): Promise<PullResult> {
    const since = await this.getLastSyncTimestamp()
    const remoteChanges = await this.linearClient.issues({
      filter: { updatedAt: { gte: since } }
    })

    return {
      changes: remoteChanges.map(this.toOpenTasks),
      syncTimestamp: new Date().toISOString()
    }
  }
}
```

---

## SyncTarget Pattern

SyncTargets are write-only integrations where OpenTasks is the source of truth.

```typescript
interface SyncTarget {
  readonly name: string
  readonly schemes: string[]

  /** Export nodes to target system */
  export(nodes: Node[]): Promise<ExportResult>

  /** Map OpenTasks node to target format */
  toTargetFormat(node: Node): unknown

  /** Get export status */
  exportStatus(): Promise<ExportStatus>
}
```

Use SyncTargets for:
- Exporting to read-only systems (static sites, docs)
- One-way mirroring to backup systems
- Publishing to external trackers

---

## Node Registry & ExternalNodes

The node registry bridges provider URIs to the OpenTasks graph. When an edge references an external URI, the registry manages the corresponding `ExternalNode`.

### Relationship to ExternalNode

```
┌─────────────────────────────────────────────────────────────────┐
│                        Edge                                      │
│  { from_id: "t-local", to_id: "beads://./bd-123", type: "..." } │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Node Registry                                 │
│  - Looks up or creates ExternalNode for "beads://./bd-123"      │
│  - Manages materialization state                                 │
│  - Coordinates with Provider for fetching                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ExternalNode (in graph.jsonl)                 │
│  {                                                               │
│    "id": "e-p6q7",                                               │
│    "type": "external",                                           │
│    "uri": "beads://./bd-123",                                    │
│    "source": "beads",                                            │
│    "materialized": true,                                         │
│    "title": "Fix login bug",  // cached from provider            │
│    "external_data": { ... }   // provider-specific data          │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Registry Interface

```typescript
interface NodeRegistry {
  /** Get or create ExternalNode for a URI */
  ensureNode(uri: string): Promise<ExternalNode>

  /** Get ExternalNode by URI (returns null if not registered) */
  get(uri: string): Promise<ExternalNode | null>

  /** Materialize a phantom node (fetch from provider) */
  materialize(uri: string, options?: MaterializeOptions): Promise<ExternalNode>

  /** Mark node as stale (needs refresh) */
  markStale(uri: string): Promise<void>

  /** List all external nodes */
  list(filter?: RegistryFilter): Promise<ExternalNode[]>

  /** Remove ExternalNode (and its edges) */
  remove(uri: string): Promise<void>
}

interface MaterializeOptions {
  /** Force refresh even if cached */
  force?: boolean

  /** Timeout for provider fetch */
  timeout?: number

  /** Depth to follow nested references */
  depth?: number
}

interface RegistryFilter {
  /** Filter by provider */
  provider?: string

  /** Filter by materialization state */
  materialized?: boolean

  /** Filter by stale state */
  stale?: boolean

  /** Filter by source type */
  source?: string
}
```

### Storage

ExternalNodes are stored in `graph.jsonl` alongside other node types (see [SCHEMA.md](./SCHEMA.md)):

```jsonl
{"id":"e-x7k9","uuid":"...","type":"external","title":"Implement auth","uri":"beads://./bd-x7k9","source":"beads","materialized":true,"cached_at":"2025-01-26T12:00:00Z","external_data":{"status":"in_progress"},"created_at":"2025-01-26T10:00:00Z","updated_at":"2025-01-26T12:00:00Z"}
{"id":"e-prd1","uuid":"...","type":"external","title":"Authentication PRD","uri":"taskmaster://./prd-1","source":"taskmaster","materialized":true,"cached_at":"2025-01-26T12:00:00Z","created_at":"2025-01-26T10:00:00Z","updated_at":"2025-01-26T12:00:00Z"}
{"id":"e-jira","uuid":"...","type":"external","title":"","uri":"jira://PROJ-123","source":"jira","materialized":false,"created_at":"2025-01-26T10:00:00Z","updated_at":"2025-01-26T10:00:00Z"}
```

**Key points:**
- `materialized: false` indicates a phantom node (just the reference, no data)
- `external_data` contains provider-specific fields
- `cached_at` tracks freshness
- Standard `id`, `uuid`, `created_at`, `updated_at` fields like other nodes

---

## Cache Strategy

### Cache Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                      Application / Client                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Daemon (coordinator)                         │
│  - Routes requests to appropriate cache/provider                 │
│  - Manages materialization                                       │
│  - Handles cross-location resolution                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ExternalNodes (in graph.jsonl)                 │
│  - Persistent cache of external data                             │
│  - Title, external_data for display                              │
│  - Tracked materialization/stale state                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SQLite Index (cache.db)                       │
│  - Fast lookups and queries                                      │
│  - Query indexes over graph.jsonl                                │
│  - Gitignored (can be rebuilt)                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Provider (source of truth)                  │
│  - Beads: .beads/issues.jsonl                                    │
│  - Taskmaster: tasks/tasks.json                                  │
│  - Linear: GraphQL API                                           │
└─────────────────────────────────────────────────────────────────┘
```

**Important**: ExternalNodes in `graph.jsonl` are the persistent cache. The SQLite `cache.db` is an index/query accelerator that can be rebuilt from the JSONL files.

### Cache Invalidation

```typescript
interface CacheConfig {
  /** Default TTL for cached nodes (ms) */
  defaultTtl: number  // default: 300000 (5 minutes)

  /** TTL overrides per provider */
  providerTtl?: Record<string, number>

  /** Stale-while-revalidate window (ms) */
  staleWhileRevalidate: number  // default: 60000 (1 minute)

  /** Maximum cache size (entries) */
  maxSize: number  // default: 10000
}

// Invalidation triggers:
// 1. TTL expiry
// 2. Provider watch event
// 3. Manual invalidation (user request)
// 4. Write operation to same node
```

### Watch-Based Invalidation

When a provider supports `watch()`, OpenTasks subscribes to changes:

```typescript
// On startup, subscribe to provider changes
for (const provider of registry.list()) {
  if (provider.capabilities.watch && provider.watch) {
    provider.watch((event) => {
      // Invalidate cache for changed node
      cache.markStale(event.uri)

      // Optionally refresh immediately
      if (config.eagerRefresh) {
        registry.resolve(event.uri, { fresh: true })
      }
    })
  }
}
```

---

## Configuration

### Provider Configuration

```json
// .opentasks/config.json
{
  "version": "1.0",

  "providers": {
    "issues": {
      "primary": "beads",
      "fallback": "native",
      "beads": {
        "workspace": ".",
        "cli": "bd"
      },
      "linear": {
        "api_key": "${LINEAR_API_KEY}",
        "team": "ENG"
      }
    },
    "context": {
      "primary": "taskmaster",
      "fallback": "native",
      "taskmaster": {
        "project": "."
      }
    }
  },

  "cache": {
    "default_ttl": 300000,
    "stale_while_revalidate": 60000,
    "max_size": 10000,
    "provider_ttl": {
      "linear": 60000,
      "beads": 0
    }
  },

  "sync": {
    "watch": true,
    "debounce": 1000
  }
}
```

### Environment Variables

```bash
# Provider API keys
export LINEAR_API_KEY=lin_api_xxxxx
export JIRA_API_TOKEN=xxxxx

# Override primary providers
export OPENTASKS_ISSUE_PROVIDER=linear
export OPENTASKS_SPEC_PROVIDER=native

# Disable caching (for debugging)
export OPENTASKS_NO_CACHE=1
```

---

## Cross-Provider Edges

Edges can connect nodes from different providers:

```typescript
// Context from Taskmaster implements Task from Beads
{
  id: "x-abc123",
  from_id: "beads://./bd-x7k9",
  to_id: "taskmaster://./prd-1",
  type: "implements"
}

// Native context blocks Beads issue
{
  id: "x-def456",
  from_id: "native://c-local",
  to_id: "beads://./bd-y8z9",
  type: "blocks"
}
```

### Cross-Provider Queries

```typescript
// Get all tasks implementing a context (across providers)
async function getImplementingIssues(specUri: string): Promise<ProviderNode[]> {
  // 1. Get edges from this context
  const edges = await edgeStore.query({
    to_id: specUri,
    type: 'implements'
  })

  // 2. Resolve each source node (may be from different providers)
  return Promise.all(
    edges.map(edge => registry.resolve(edge.from_id))
  )
}

// Get blockers for a task (may include context and tasks)
async function getBlockers(issueUri: string): Promise<ProviderNode[]> {
  const edges = await edgeStore.query({
    to_id: issueUri,
    type: 'blocks'
  })

  return Promise.all(
    edges.map(edge => registry.resolve(edge.from_id))
  )
}
```

---

## Ready Query

The `ready()` query finds nodes that are ready to work on. This requires checking cross-provider blocking relationships.

```typescript
async function ready(): Promise<ProviderNode[]> {
  // 1. Get all open tasks from primary provider
  const provider = registry.getPrimary('task')
  let candidates: ProviderNode[]

  if (provider.capabilities.ready && provider.ready) {
    // Provider has native ready support (e.g., Beads `bd ready`)
    candidates = await provider.ready()
  } else {
    // Fall back to listing open tasks
    candidates = await provider.list({ status: 'open' })
  }

  // 2. Filter by OpenTasks edges (cross-provider blockers)
  const ready: ProviderNode[] = []

  for (const candidate of candidates) {
    const blockers = await edgeStore.query({
      to_id: candidate.uri,
      type: 'blocks'
    })

    // Check if all blockers are resolved
    const unresolvedBlockers = await Promise.all(
      blockers.map(async (edge) => {
        const blocker = await registry.resolve(edge.from_id)
        return blocker && blocker.status !== 'closed'
      })
    )

    if (!unresolvedBlockers.some(Boolean)) {
      ready.push(candidate)
    }
  }

  return ready
}
```

---

## Adding a New Provider

To add a new provider:

1. **Implement the interface**

```typescript
class MyProvider implements ContentProvider {
  name = 'myprovider'
  schemes = ['myprovider', 'mp']
  nodeTypes = ['task'] // or ['context'] or both

  capabilities = {
    read: true,
    write: true,
    delete: false,
    search: true,
    watch: false,
    ready: false
  }

  async get(id: string): Promise<ProviderNode | null> {
    // Implement fetching
  }

  async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
    // Implement listing
  }

  toOpenTasks(native: MyNativeFormat): ProviderNode {
    // Implement mapping
  }

  fromOpenTasks(node: ProviderNode): MyNativeFormat {
    // Implement reverse mapping
  }
}
```

2. **Register the provider**

```typescript
import { registry } from 'opentasks'

registry.register(new MyProvider())
```

3. **Configure in config.json**

```json
{
  "providers": {
    "issues": {
      "primary": "myprovider",
      "myprovider": {
        "api_key": "${MY_API_KEY}"
      }
    }
  }
}
```

---

## Analogous Systems

The federated graph model draws inspiration from:

| System | Pattern | Similarity |
|--------|---------|------------|
| **RDF/Linked Data** | URIs reference external resources | Node URIs can point anywhere |
| **GraphQL Federation** | Gateway stitches across services | OpenTasks stitches across providers |
| **Git Object Model** | Trees (structure) separate from blobs (content) | Edges separate from node content |
| **Neo4j + MongoDB** | Graph DB for relationships, doc DB for content | OpenTasks for graph, providers for content |
| **Kubernetes + External Secrets** | K8s references, external systems own data | OpenTasks references, providers own data |

---

## MAP Provider

[MAP (Multi-Agent Protocol)](https://github.com/multi-agent-protocol/multi-agent-protocol) is a JSON-RPC 2.0 protocol for observing and coordinating multi-agent systems. The MAP integration has two independent components:

1. **MAP Provider** — Inbound: surfaces remote MAP tasks in the OpenTasks graph
2. **MAP Event Bridge** — Outbound: emits OpenTasks graph changes as MAP task events

These are independent. You can use either or both.

### MAP Provider (Inbound)

The MAP provider bridges `map://` URIs to a remote MAP server's task store. It implements the full Provider interface plus the `TaskManageable` and (optionally) `Watchable` traits.

```typescript
interface MAPProviderConfig {
  client: MAPTaskClient;   // MAP SDK connection or adapter
  systemId?: string;       // URI namespace (default: 'default')
  timeout?: number;        // Request timeout in ms
}
```

#### Ephemeral / Pass-Through Design

The MAP provider has **no local cache or persistence**. Every operation is a direct RPC call to the MAP server:

- `list()` → `client.listTasks()`
- `get(id)` → `client.listTasks()` + find by ID
- `create(input)` → `client.createTask()`
- `update(id, updates)` → `client.updateTask()`
- `delete(id)` → `client.updateTask({ status: 'failed' })` (MAP has no delete)

When the MAP connection is open, MAP tasks appear in the graph alongside native/beads/claude-tasks nodes — agents query them transparently via the provider registry. When the connection drops, `map://` nodes simply stop being queryable. No stale data lingers.

#### URI Format

```
map://[systemId]/[taskId]

Examples:
  map://default/task-abc123     # Default system
  map://prod-cluster/task-xyz   # Named system
```

#### Status Mapping

| MAP Status | OpenTasks Status |
|------------|------------------|
| `open` | `open` |
| `in_progress` | `in_progress` |
| `blocked` | `blocked` |
| `completed` | `closed` |
| `failed` | `closed` |

#### TaskManageable Trait

The MAP provider implements `TaskManageable`, supporting semantic task actions:

| Action | MAP Status |
|--------|------------|
| `start` | `in_progress` |
| `complete` | `completed` |
| `block` | `blocked` |
| `reopen` | `open` |
| `close` | `completed` |

It also supports `assignTask()` and `readyTasks()` (filters for `status: 'open'`).

#### Watchable Trait

If the `MAPTaskClient` provides `onTaskEvent()`, the provider implements `Watchable` and translates MAP task events (`task.created`, `task.assigned`, `task.status`, `task.completed`) into `ProviderChangeEvent`s that flow through the graph store's watch system.

#### MAPTaskClient Interface

The provider depends on a `MAPTaskClient` — an abstraction boundary between OpenTasks and MAP:

```typescript
interface MAPTaskClient {
  createTask(params: { task: Omit<MAPTask, 'id'> & { id?: string } }): Promise<{ task: MAPTask }>;
  assignTask(taskId: string, agentId: string): Promise<{ task: MAPTask }>;
  updateTask(params: { taskId: string; status?: MAPTaskStatus; ... }): Promise<{ task: MAPTask }>;
  listTasks(params?: { filter?: { ... }; limit?: number; cursor?: string }): Promise<{ tasks: MAPTask[]; hasMore: boolean }>;
  onTaskEvent?(callback: (event: MAPTaskEvent) => void): () => void;
}
```

A MAP SDK `ClientConnection` or `AgentConnection` satisfies this naturally — no adapter needed.

#### Client Factory

`createMAPClient()` connects to a MAP server and returns a `MAPTaskClient` + event sender:

```typescript
const result = await createMAPClient({
  server: 'ws://localhost:8080',
  agentName: 'opentasks-daemon',
  scope: 'my-team',
});

if (result) {
  const provider = createMAPProvider({ client: result.client });
  const bridge = createMAPEventBridge({ send: result.send });
  // ... use provider and bridge
  await result.disconnect();
}
```

The factory dynamically imports `@multi-agent-protocol/sdk` — if the SDK isn't installed, it returns `null` and MAP is gracefully skipped. No `package.json` dependency required.

---

### MAP Event Bridge (Outbound)

The event bridge translates OpenTasks graph changes into MAP task events for external observability. It is **standalone** — not owned by the daemon, not tied to any particular MAP server.

```typescript
interface MAPEventBridgeConfig {
  send?: MAPEventSender;           // Direct send function
  connection?: MAPConnection;       // Shared MAP connection (alternative to send)
  scope?: string;                   // Target scope (used with connection)
  agentId?: string;                 // Origin stamp for echo prevention
  filter?: (eventType: string, data: Record<string, unknown>) => boolean;
}
```

#### Two Input Modes

**1. Direct send function** — for simple cases or custom transports:

```typescript
const bridge = createMAPEventBridge({
  send: (eventType, data) => ws.send(JSON.stringify({ type: eventType, ...data })),
  agentId: 'agent-alice',
});
```

**2. Shared MAP connection** — for sharing a connection with other systems (e.g., agent-inbox handles messaging, bridge handles task events):

```typescript
const bridge = createMAPEventBridge({
  connection: mapConnection,  // Compatible with agent-inbox's MapConnection
  scope: 'swarm:my-team',
  agentId: 'agent-alice',
});
```

The `MAPConnection` interface is minimal — any object with `send(to, payload, meta?)` works:

```typescript
interface MAPConnection {
  send(
    to: { scope?: string; agentId?: string } | string,
    payload: unknown,
    meta?: Record<string, unknown>,
  ): Promise<void>;
}
```

If both `send` and `connection` are provided, `send` takes precedence.

#### Two Usage Patterns

**Agent-side (emit your own actions):**

```typescript
const bridge = createMAPEventBridge({ send, agentId: 'agent-alice' });

bridge.emitTaskCreated({ id: 'task-1', title: 'Do thing', status: 'open' });
bridge.emitTaskStatus('task-1', 'open', 'in_progress');
bridge.emitTaskAssigned('task-1', 'agent-bob');
bridge.emitTaskCompleted('task-1', { output: 'Done' });
```

**Daemon-side (translate graph watch events):**

```typescript
const bridge = createMAPEventBridge({ send, agentId: 'daemon' });

// Attach to provider change events
graphStore.onProviderChange('native', (event) => {
  bridge.handleProviderChange('native', event);
});
```

The `handleProviderChange()` method translates `ProviderChangeEvent`s into the appropriate MAP events:
- `created` node → `task.created`
- `updated` node with status change → `task.status` (+ `task.completed` for terminal states)
- `updated` node with assignee change → `task.assigned`
- `deleted` node → `task.status` (to `failed`, since MAP has no delete)

#### Echo Prevention

- Events from the `map` provider are skipped (prevents MAP→OpenTasks→MAP loops)
- All emitted events are stamped with `_origin: agentId` so receivers can filter their own events
- Non-task node types are ignored

#### Lifecycle

```typescript
bridge.active;  // true
bridge.stop();  // prevents further events
bridge.active;  // false
```

The bridge does NOT own the connection lifecycle. Calling `stop()` only prevents further events — it does not disconnect the underlying transport.

#### Why Standalone?

MAP connections are an **agent-level concern**, not a daemon-level concern. Different agents may connect to different MAP servers. The bridge is standalone so that:

- An agent can create its own bridge targeting its own MAP server
- Multiple bridges can coexist (e.g., one per agent in a swarm)
- The daemon stays dumb about MAP — no single-connection bottleneck
- A shared connection (e.g., from agent-inbox) can be reused without duplication

---

### MAP Configuration

The MAP provider is configured in `.opentasks/config.json`:

```json
{
  "providers": {
    "map": {
      "enabled": false,
      "server": "ws://localhost:8080",
      "systemId": "default",
      "timeout": 30000,
      "agentName": "opentasks-daemon",
      "scope": "my-team",
      "eventBridge": true
    }
  }
}
```

These fields are declarative — agents and plugins read them to configure their own MAP connections. The daemon does not establish the MAP connection itself.

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `false` | Whether MAP integration is active |
| `server` | `''` | MAP server WebSocket URL |
| `systemId` | `'default'` | URI namespace for `map://` URIs |
| `timeout` | `30000` | Request timeout in ms |
| `agentName` | `'opentasks-daemon'` | Agent name for MAP registration |
| `scope` | `''` | MAP scope to join |
| `eventBridge` | `true` | Whether to enable outbound event bridging |

---

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      OpenTasks Graph                              │
│                                                                   │
│  native://t-abc    beads://bd-xyz    map://default/task-123       │
│       │                 │                    │                    │
│       └─────── edges ───┴──────── edges ─────┘                   │
└──────────────────────────┬────────────────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
              ▼            ▼                ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
     │ Native       │ │ Beads    │ │ MAP Provider     │
     │ Provider     │ │ Provider │ │ (pass-through)   │
     │ (graph.jsonl)│ │ (bd CLI) │ │                  │
     └──────────────┘ └──────────┘ └────────┬─────────┘
                                             │ RPC calls
                                             ▼
                                    ┌──────────────────┐
                                    │   MAP Server     │
                                    │  (remote tasks)  │
                                    └──────────────────┘

              ▲                              ▲
              │ graph changes                │ task events
              │                              │
     ┌────────┴──────────────────────────────┴─────────┐
     │              MAP Event Bridge                      │
     │  (standalone — agent-owned, not daemon-owned)      │
     │                                                    │
     │  Translates ProviderChangeEvents → MAP events      │
     │  OR direct emit from agent code                    │
     └────────────────────────────────────────────────────┘
```

---

## Open Questions

### Resolved
- [x] **Provider discovery**: Providers configured in `.opentasks/config.json`; auto-detection is optional enhancement
- [x] **Bidirectional edges**: Providers don't need to know about OpenTasks edges; edges are OpenTasks-owned

### Open
- [ ] **Multi-workspace**: How to handle multiple Beads workspaces in same project? Multiple provider instances?
- [ ] **Conflict resolution**: When edge says "blocks" but provider says "closed"? Trust provider status, mark edge stale?
- [ ] **Provider versioning**: How to handle provider schema changes? Migration scripts per provider?
- [ ] **Adapter sync frequency**: How often should adapters sync? Event-driven vs polling vs manual?
- [ ] **Cross-location providers**: Can a provider span multiple locations? Or one provider instance per location?
- [ ] **Provider health checks**: Should daemon periodically verify provider availability?
- [ ] **Materialization depth**: When materializing, how deep to follow nested external references?

---

## References

### External
- [Beads Documentation](https://github.com/steveyegge/beads)
- [Taskmaster Documentation](https://github.com/eyaltoledano/claude-task-master)
- [Linear API](https://developers.linear.app/docs)

### Internal
- [DESIGN.md](./DESIGN.md) — Design rationale and core concepts
- [SCHEMA.md](./SCHEMA.md) — Data model (ExternalNode, edges)
- [PERSISTENCE.md](./PERSISTENCE.md) — Storage layer and sync
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Daemon, locations, URIs
