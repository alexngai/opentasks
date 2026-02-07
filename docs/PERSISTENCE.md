# OpenTasks Persistence Layer

This document describes the persistence architecture for OpenTasks. The design enables flexible, pluggable storage while maintaining a consistent graph data model.

**See also:** [DESIGN.md](./DESIGN.md) (vision) · [SCHEMA.md](./SCHEMA.md) (data model) · [ARCHITECTURE.md](./ARCHITECTURE.md) (hierarchy, daemon) · [PROVIDERS.md](./PROVIDERS.md) (integrations) · [INTERFACE.md](./INTERFACE.md) (API)

---

## Design Goals

1. **Modular persisters** — Pluggable storage backends (like [TinyBase](https://tinybase.org/guides/persistence/))
2. **Git-native source of truth** — JSONL files for version control (like beads/sudocode)
3. **Fast queries** — SQLite cache layer for complex queries
4. **Agent-friendly editing** — Markdown file expansion for direct file editing
5. **Incremental sync** — Dirty tracking to minimize writes
6. **Multi-location support** — Worktrees, redirects, delegated storage
7. **Provider integration** — Delegate to underlying systems (beads, etc.)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Application Layer                           │
│              (Graph operations, queries, mutations)              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Persistence Manager                         │
│  - Coordinates persisters                                        │
│  - Manages dirty tracking                                        │
│  - Handles flush scheduling                                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Persister Interface                         │
│  getPersisted() | setPersisted() | subscribe() | unsubscribe()  │
└─────────────────────────────────────────────────────────────────┘
          ↓                   ↓                   ↓
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────┐
│ JSONL Persister │ │ SQLite Persister│ │ Markdown Persister      │
│ (source of truth)│ │ (query cache)   │ │ (file expansion)        │
└─────────────────┘ └─────────────────┘ └─────────────────────────┘
          ↓                   ↓                   ↓
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────┐
│  graph.jsonl    │ │   cache.db      │ │  specs/*.md, issues/*.md│
│  (git-tracked)  │ │  (gitignored)   │ │  (git-tracked)          │
└─────────────────┘ └─────────────────┘ └─────────────────────────┘
```

---

## Persister Interface

Inspired by [TinyBase's persister model](https://tinybase.org/guides/persistence/custom-persistence/), OpenTasks uses a modular interface for storage backends.

```typescript
/**
 * Core persister interface
 * Each persister handles one storage format/location
 */
interface Persister<ListenerHandle = unknown> {
  /** Unique identifier for this persister */
  readonly id: string

  /** Human-readable name */
  readonly name: string

  /** Persister capabilities */
  readonly capabilities: PersisterCapabilities

  /**
   * Load graph data from persistence layer
   * Returns null/undefined if no data exists
   */
  getPersisted(): Promise<PersistedGraph | null | undefined>

  /**
   * Save graph data to persistence layer
   * @param getContent - Function to get current graph state
   * @param changes - Optional incremental changes (for dirty tracking)
   */
  setPersisted(
    getContent: () => PersistedGraph,
    changes?: GraphChanges
  ): Promise<void>

  /**
   * Subscribe to external changes in persistence layer
   * @param listener - Called when external changes detected
   * @returns Handle for unsubscribing
   */
  subscribe(listener: PersisterListener): ListenerHandle

  /**
   * Unsubscribe from external changes
   */
  unsubscribe(handle: ListenerHandle): void

  /**
   * Optional: Destroy/cleanup resources
   */
  destroy?(): Promise<void>
}

interface PersisterCapabilities {
  /** Can read data */
  read: boolean
  /** Can write data */
  write: boolean
  /** Can watch for external changes */
  watch: boolean
  /** Supports incremental updates (vs full rewrite) */
  incremental: boolean
  /** Is source of truth (vs cache) */
  authoritative: boolean
}

interface PersistedGraph {
  nodes: StoredNode[]
  edges: StoredEdge[]
  metadata?: GraphMetadata
}

interface GraphChanges {
  /** Nodes that were added/modified */
  dirtyNodes: string[]
  /** Nodes that were deleted */
  deletedNodes: string[]
  /** Edges that were added/modified */
  dirtyEdges: string[]
  /** Edges that were deleted */
  deletedEdges: string[]
}

type PersisterListener = (changes?: GraphChanges) => void
```

---

## Built-in Persisters

### 1. JSONL Persister (Source of Truth)

Primary storage format, git-tracked and merge-friendly.

```typescript
interface JSONLPersisterConfig {
  /** Path to JSONL file(s) */
  path: string | {
    nodes: string     // e.g., "graph.jsonl" or split files
    edges?: string    // e.g., "edges.jsonl"
  }

  /** Whether to split by node type */
  splitByType?: boolean   // specs.jsonl, issues.jsonl, etc.

  /** Atomic write strategy */
  atomicWrite?: 'rename' | 'write-sync' | 'none'

  /** Content hashing for dedup */
  contentHashing?: boolean
}

const jsonlPersister = createJSONLPersister({
  path: '.opentasks/graph.jsonl',
  atomicWrite: 'rename',
  contentHashing: true,
})
```

**Features:**
- **Append-only writes** — updates append a new line with the same ID and newer `updated_at` (never overwrite in-place)
- Content hashing to detect actual changes
- On load, deduplicate by keeping latest `updated_at` per ID
- Custom merge driver for conflict-free git merges (see [plans/PHASE-3.md](./plans/PHASE-3.md))
- Periodic compaction to remove duplicate entries

**File Format:**
```jsonl
{"id":"s-a2b3","type":"spec","title":"Auth requirements",...}
{"id":"i-x7k9","type":"issue","title":"Implement login",...}
{"id":"x-r8s9","type":"edge","from_id":"i-x7k9","to_id":"s-a2b3",...}
```

### 2. SQLite Persister (Query Cache)

Fast query layer, rebuilt from JSONL.

```typescript
interface SQLitePersisterConfig {
  /** Path to database file */
  path: string              // e.g., ".opentasks/cache.db"

  /** WAL mode for better concurrency */
  walMode?: boolean

  /** Rebuild triggers */
  rebuildOn?: ('startup' | 'jsonl-change' | 'manual')[]

  /** Indexes to create */
  indexes?: IndexConfig[]
}

const sqlitePersister = createSQLitePersister({
  path: '.opentasks/cache.db',
  walMode: true,
  rebuildOn: ['startup', 'jsonl-change'],
})
```

**Features:**
- Indexes on common query patterns (status, priority, type, etc.)
- Views for computed queries (ready_issues, blocked_issues)
- Dirty tracking table for incremental export
- Content hash table for dedup
- Gitignored (ephemeral cache)

**Schema:**
```sql
-- Core tables
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  uuid TEXT UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT,
  priority INTEGER,
  -- ... other fields
  content_hash TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT
);

-- Dirty tracking
CREATE TABLE dirty_nodes (
  node_id TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL
);

CREATE TABLE export_hashes (
  node_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL
);

-- Metadata
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Views
CREATE VIEW ready_issues AS
SELECT i.* FROM nodes i
WHERE i.type = 'issue'
  AND i.status = 'open'
  AND i.archived IS NOT TRUE
  AND NOT EXISTS (
    SELECT 1 FROM edges e
    JOIN nodes blocker ON e.from_id = blocker.id
    WHERE e.to_id = i.id
      AND e.type = 'blocks'
      AND blocker.status != 'closed'
  );
```

### 3. Markdown Persister (File Expansion)

Expands nodes to individual markdown files for agent editing.

```typescript
interface MarkdownPersisterConfig {
  /** Base directory for markdown files */
  basePath: string          // e.g., ".opentasks/"

  /** Directory structure */
  structure: {
    specs?: string          // e.g., "specs/" → .opentasks/specs/*.md
    issues?: string         // e.g., "issues/"
    feedback?: string       // e.g., "feedback/"
  }

  /** Filename pattern */
  filenamePattern?: 'id' | 'id-title' | 'title-slug'

  /** Frontmatter format */
  frontmatter?: 'yaml' | 'toml' | 'json'

  /** Which node types to expand */
  expandTypes?: NodeType[]

  /** Bidirectional sync */
  watchFiles?: boolean
}

const markdownPersister = createMarkdownPersister({
  basePath: '.opentasks/',
  structure: {
    specs: 'specs/',
    issues: 'issues/',
  },
  filenamePattern: 'id-title',
  frontmatter: 'yaml',
  watchFiles: true,
})
```

**Features:**
- Bidirectional sync (JSONL ↔ Markdown)
- Frontmatter for metadata, body for content
- File watcher for external changes
- Agents can edit markdown directly with standard tools
- Git-tracked alongside JSONL

**File Format:**
```markdown
---
id: s-a2b3
type: spec
title: Authentication Requirements
status: active
priority: 1
tags:
  - auth
  - security
created_at: 2025-01-26T10:00:00Z
updated_at: 2025-01-26T10:00:00Z
---

## Overview

Users should be able to authenticate using OAuth2...

## Requirements

1. Support Google and GitHub OAuth providers
2. Session management with secure cookies
3. ...
```

### 4. Provider Persister (Delegated Storage)

Delegates storage to an underlying system (beads, sudocode, etc.).

```typescript
interface ProviderPersisterConfig {
  /** Provider integration to use */
  provider: Integration

  /** Sync direction */
  direction: 'read-only' | 'write-through' | 'bidirectional'

  /** Conflict resolution */
  conflictStrategy: 'local-wins' | 'remote-wins' | 'manual'

  /** Node filter (which nodes to delegate) */
  filter?: (node: Node) => boolean
}

const beadsPersister = createProviderPersister({
  provider: beadsIntegration,
  direction: 'bidirectional',
  conflictStrategy: 'remote-wins',
  filter: (node) => node.source === 'beads',
})
```

**Features:**
- Routes operations to underlying provider
- Respects provider's native storage format
- Syncs changes bidirectionally
- Can filter which nodes are delegated

---

## Persistence Manager

Coordinates multiple persisters with priority and sync logic.

```typescript
interface PersistenceManagerConfig {
  /** Ordered list of persisters (first = highest priority for reads) */
  persisters: Persister[]

  /** Flush configuration */
  flush: {
    /** Debounce delay for batching writes */
    debounceMs: number        // e.g., 5000 (5 seconds)

    /** Maximum delay before forced flush */
    maxDelayMs: number        // e.g., 30000 (30 seconds)

    /** Flush on shutdown */
    flushOnShutdown: boolean
  }

  /** Sync configuration */
  sync: {
    /** Auto-import on external changes */
    autoImport: boolean

    /** Auto-export dirty nodes */
    autoExport: boolean

    /** Incremental threshold (full export if more dirty) */
    incrementalThreshold: number   // e.g., 1000
    incrementalRatio: number       // e.g., 0.2 (20%)
  }
}

class PersistenceManager {
  constructor(config: PersistenceManagerConfig)

  /** Load graph from persisters (merges with priority) */
  async load(): Promise<Graph>

  /** Mark nodes as dirty (triggers flush scheduling) */
  markDirty(nodeIds: string[]): void

  /** Force immediate flush */
  async flush(): Promise<void>

  /** Shutdown with final flush */
  async shutdown(): Promise<void>

  /** Subscribe to graph changes (from any persister) */
  subscribe(listener: GraphListener): () => void
}
```

### Flush Manager

Event-driven flush coordination (inspired by beads' FlushManager).

```typescript
/**
 * FlushManager handles debounced, batched writes
 * Single goroutine/async loop owns all state (no locks needed)
 */
class FlushManager {
  private dirtyNodes: Set<string> = new Set()
  private debounceTimer: Timer | null = null
  private maxDelayTimer: Timer | null = null

  /** Mark node as dirty, schedule flush */
  markDirty(nodeId: string): void {
    this.dirtyNodes.add(nodeId)
    this.scheduleFlush()
  }

  /** Schedule debounced flush */
  private scheduleFlush(): void {
    // Reset debounce timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs)

    // Start max delay timer if not running
    if (!this.maxDelayTimer) {
      this.maxDelayTimer = setTimeout(() => this.flush(), this.maxDelayMs)
    }
  }

  /** Execute flush */
  private async flush(): Promise<void> {
    if (this.dirtyNodes.size === 0) return

    const toFlush = new Set(this.dirtyNodes)
    this.dirtyNodes.clear()
    this.clearTimers()

    // Determine full vs incremental export
    const totalNodes = await this.getTotalNodeCount()
    const dirtyRatio = toFlush.size / totalNodes
    const useIncremental =
      totalNodes > this.incrementalThreshold &&
      dirtyRatio < this.incrementalRatio

    // Execute flush on each persister
    for (const persister of this.persisters) {
      if (persister.capabilities.write) {
        await persister.setPersisted(
          () => this.getGraphContent(),
          useIncremental ? { dirtyNodes: [...toFlush] } : undefined
        )
      }
    }
  }
}
```

---

## Dirty Tracking

Track which nodes have changed for incremental sync.

```typescript
interface DirtyTracker {
  /** Mark node as dirty */
  markDirty(nodeId: string): void

  /** Mark multiple nodes as dirty */
  markDirtyBatch(nodeIds: string[]): void

  /** Get all dirty node IDs */
  getDirtyNodes(): string[]

  /** Clear dirty status for exported nodes */
  clearDirty(nodeIds: string[]): void

  /** Clear all dirty status */
  clearAll(): void
}

interface ContentHashTracker {
  /** Get last exported hash for node */
  getExportHash(nodeId: string): string | null

  /** Set export hash after successful export */
  setExportHash(nodeId: string, hash: string): void

  /** Check if node content has changed */
  hasChanged(nodeId: string, currentHash: string): boolean

  /** Clear all hashes (forces full re-export) */
  clearAll(): void
}
```

**Integration with SQLite cache:**
```sql
-- Mark node dirty
INSERT OR REPLACE INTO dirty_nodes (node_id, marked_at)
VALUES (?, datetime('now'));

-- Get dirty nodes (ordered by marked time)
SELECT node_id FROM dirty_nodes ORDER BY marked_at;

-- Clear dirty after export
DELETE FROM dirty_nodes WHERE node_id IN (?);

-- Track export hashes
INSERT OR REPLACE INTO export_hashes (node_id, content_hash)
VALUES (?, ?);

-- Check if changed
SELECT content_hash FROM export_hashes WHERE node_id = ?;
```

---

## Multi-Location Support

### Location Identity

Each `.opentasks/` directory has a deterministic identity. See [plans/PHASE-2.md](./plans/PHASE-2.md) for full specification.

```typescript
interface Location {
  /** Deterministic hash: SHA256(git_remote_url + ":" + repo_relative_path) → 8-char base36 */
  hash: string

  /** Random UUID v4 for uniqueness guarantee */
  uuid: string

  /** Human-readable name */
  name: string
}
```

### Explicit Connections (Not Discovery)

Locations declare connections explicitly in `config.json`. No filesystem discovery at runtime.

```typescript
interface Connection {
  /** Location hash of the target */
  hash: string

  /** Relative or absolute path to target's .opentasks/ */
  path: string

  /** Relationship: peer, parent, worker, manager */
  role: string

  /** Human-readable name */
  name?: string
}
```

### Redirect Support (Role-Based)

For worktree and multi-location scenarios. Redirects use **roles** (set by orchestrator in config), not agent identity.

```typescript
interface RedirectRule {
  /** Operations to redirect */
  operations: ('read' | 'write')[]

  /** Pattern for node IDs (glob): "*", "i-*", "s-*" */
  pattern: string

  /** Target location (hash URI or relative path) */
  target: string

  /** Lower = higher priority, default 100 */
  priority: number

  /** What to do if target unreachable */
  fallback: 'local' | 'error'

  /** Conditions (optional) */
  when?: {
    role?: string           // from config.json role field (trusted)
    branch?: string         // git branch glob pattern
  }
}
```

Rule evaluation: sorted by priority (ascending), first match wins. Max redirect depth: 3 hops.

### Worktree Registration (Explicit, Not Passive)

Worktrees are registered explicitly via `opentasks worktree setup`, not auto-detected from `.git` files. This stores actual paths and avoids assumptions about directory layout.

```typescript
interface RegisteredWorktree {
  /** Worktree root path */
  path: string

  /** Path to .opentasks/ directory */
  opentasksPath: string

  /** Location hash */
  hash: string

  /** Git branch */
  branch: string

  /** Role: manager or worker */
  role: 'manager' | 'worker'

  /** Location hash of redirect target (if worker) */
  redirectTarget?: string
}
```

Registry stored at `.git/opentasks/worktrees.json` (shared across worktrees, daemon is sole writer).

See [plans/PHASE-3.md](./plans/PHASE-3.md) for worktree CLI specification.

---

## Sync Strategies

### Import Strategy

```typescript
interface ImportStrategy {
  /** Detect if import needed */
  needsImport(): Promise<boolean>

  /** Execute import */
  import(): Promise<ImportResult>
}

interface ImportResult {
  imported: number
  conflicts: ConflictInfo[]
  errors: Error[]
}

// Content-hash based detection (git-proof)
class ContentHashImportStrategy implements ImportStrategy {
  async needsImport(): Promise<boolean> {
    const currentHash = await this.computeJSONLHash()
    const storedHash = await this.getStoredJSONLHash()
    return currentHash !== storedHash
  }
}
```

### Export Strategy

```typescript
interface ExportStrategy {
  /** Determine export mode */
  getMode(): 'full' | 'incremental'

  /** Execute export */
  export(mode: 'full' | 'incremental'): Promise<ExportResult>
}

interface ExportResult {
  exported: number
  mode: 'full' | 'incremental'
  duration: number
}

// Incremental with fallback to full
class HybridExportStrategy implements ExportStrategy {
  getMode(): 'full' | 'incremental' {
    const dirtyCount = this.getDirtyCount()
    const totalCount = this.getTotalCount()

    if (totalCount < this.incrementalThreshold) return 'full'
    if (dirtyCount / totalCount > this.incrementalRatio) return 'full'
    return 'incremental'
  }
}
```

### Conflict Resolution

```typescript
interface ConflictResolver {
  /** Detect conflicts */
  detectConflicts(local: Node, remote: Node): Conflict | null

  /** Resolve conflict */
  resolve(conflict: Conflict, strategy: ConflictStrategy): Node
}

type ConflictStrategy =
  | 'local-wins'
  | 'remote-wins'
  | 'newer-wins'
  | 'merge'
  | 'manual'

interface Conflict {
  nodeId: string
  local: Node
  remote: Node
  type: 'update-update' | 'update-delete' | 'delete-update'
}
```

---

## Atomic Operations

### Atomic File Writes

```typescript
/**
 * Atomic write using temp file + rename
 * Prevents partial writes on crash
 */
async function atomicWrite(
  path: string,
  content: string | Buffer
): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`

  try {
    await fs.writeFile(tempPath, content)
    await fs.rename(tempPath, path)
  } catch (error) {
    // Clean up temp file on failure
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}
```

### Transaction Support

```typescript
interface Transaction {
  /** Begin transaction */
  begin(): Promise<void>

  /** Commit transaction */
  commit(): Promise<void>

  /** Rollback transaction */
  rollback(): Promise<void>

  /** Execute in transaction */
  execute<T>(fn: () => Promise<T>): Promise<T>
}

// Two-phase commit for multi-persister writes
class MultiPersisterTransaction implements Transaction {
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.begin()
    try {
      const result = await fn()
      await this.commit()
      return result
    } catch (error) {
      await this.rollback()
      throw error
    }
  }
}
```

---

## Configuration

### Default Configuration

```typescript
const defaultPersistenceConfig: PersistenceManagerConfig = {
  persisters: [
    createJSONLPersister({
      path: '.opentasks/graph.jsonl',
      atomicWrite: 'rename',
      contentHashing: true,
    }),
    createSQLitePersister({
      path: '.opentasks/cache.db',
      walMode: true,
      rebuildOn: ['startup', 'jsonl-change'],
    }),
  ],

  flush: {
    debounceMs: 5000,
    maxDelayMs: 30000,
    flushOnShutdown: true,
  },

  sync: {
    autoImport: true,
    autoExport: true,
    incrementalThreshold: 1000,
    incrementalRatio: 0.2,
  },
}
```

### With Markdown Expansion

```typescript
const withMarkdownConfig: PersistenceManagerConfig = {
  persisters: [
    createJSONLPersister({ /* ... */ }),
    createSQLitePersister({ /* ... */ }),
    createMarkdownPersister({
      basePath: '.opentasks/',
      structure: {
        specs: 'specs/',
        issues: 'issues/',
      },
      watchFiles: true,
    }),
  ],
  // ...
}
```

### With Provider Delegation

```typescript
const withBeadsConfig: PersistenceManagerConfig = {
  persisters: [
    // Local storage for opentasks-native nodes
    createJSONLPersister({ /* ... */ }),
    createSQLitePersister({ /* ... */ }),

    // Delegate to beads for beads-sourced nodes
    createProviderPersister({
      provider: beadsIntegration,
      direction: 'bidirectional',
      filter: (node) => node.source === 'beads',
    }),
  ],
  // ...
}
```

---

## File Structure

```
.opentasks/
├── graph.jsonl           # Source of truth: nodes + edges, append-only (git-tracked)
├── tombstones.jsonl      # Soft-deleted nodes (configurable gitignore)
├── cache.db              # SQLite cache in WAL mode (gitignored, can be rebuilt)
├── config.json           # Configuration, connections, role, redirects
├── write.lock            # Advisory lock for JSONL writes (gitignored)
├── specs/                # Optional: markdown expansion
│   ├── s-a2b3-auth-requirements.md
│   └── s-c4d5-api-design.md
└── issues/               # Optional: markdown expansion
    ├── i-x7k9-implement-login.md
    └── i-y8z0-add-tests.md

.git/opentasks/           # Shared across all worktrees (Phase 3)
├── daemon.sock           # Single daemon socket
├── daemon.lock           # Daemon PID lock
└── worktrees.json        # Registered worktrees
```

See [plans/CORE-ARCHITECTURE.md](./plans/CORE-ARCHITECTURE.md) for cross-location architecture and daemon details.

**.gitignore:**
```gitignore
# Cache files (rebuilt from JSONL)
.opentasks/cache.db
.opentasks/cache.db-*

# Write lock
.opentasks/write.lock

# Temp files
.opentasks/*.tmp

# Optional: tombstones (user choice)
# .opentasks/tombstones.jsonl
```

**.gitattributes:**
```gitattributes
# Custom merge driver for conflict-free JSONL merges
.opentasks/graph.jsonl merge=opentasks
```

---

## Open Questions

- [ ] **Split vs single JSONL**: One `graph.jsonl` or split by type?
- [ ] **Cross-persister transactions**: How to ensure atomicity across JSONL + SQLite + Markdown?
- [ ] **Compaction trigger**: Automatic vs manual compaction scheduling?

---

## Markdown Sync Design

Bidirectional sync between JSONL (source of truth) and Markdown files (agent-editable).

### The Challenge

```
                    ┌─────────────────┐
                    │   git pull      │
                    │   git checkout  │
                    └────────┬────────┘
                             ↓
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  graph.jsonl    │←──→│     Daemon      │←──→│  specs/*.md     │
│  (git-tracked)  │    │   (mediator)    │    │  (git-tracked)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        ↑                                              ↑
        │                                              │
   git operations                              user/agent edits
   (merge, rebase)                             (random access)
```

**Conflict scenarios:**
1. **Git updates JSONL** → markdown files need refresh
2. **User edits markdown** → JSONL needs update
3. **Both change simultaneously** → conflict resolution needed
4. **Git updates both** → merge may create inconsistencies

### Content Hash Tracking

Track hashes at multiple levels to detect changes:

```typescript
interface SyncState {
  /** Per-node tracking */
  nodes: Map<string, NodeSyncState>

  /** File-level tracking */
  files: Map<string, FileSyncState>

  /** Last successful sync timestamp */
  lastSync: string
}

interface NodeSyncState {
  nodeId: string

  /** Hash of node content in JSONL */
  jsonlHash: string

  /** Hash of node content in markdown (if expanded) */
  markdownHash?: string

  /** Hash at last successful sync */
  lastSyncHash: string

  /** Sync status */
  status: 'synced' | 'jsonl-ahead' | 'markdown-ahead' | 'conflict'
}

interface FileSyncState {
  path: string

  /** File content hash */
  contentHash: string

  /** File mtime (for quick dirty check) */
  mtime: number

  /** Associated node ID */
  nodeId: string
}
```

### Sync Algorithm

```typescript
class MarkdownSyncManager {
  /**
   * Detect and categorize changes
   */
  async detectChanges(): Promise<SyncChanges> {
    const changes: SyncChanges = {
      jsonlUpdated: [],    // JSONL changed, markdown needs update
      markdownUpdated: [], // Markdown changed, JSONL needs update
      conflicts: [],       // Both changed differently
      newInJsonl: [],      // New nodes to expand to markdown
      deletedInJsonl: [],  // Nodes removed, delete markdown files
    }

    for (const [nodeId, state] of this.syncState.nodes) {
      const currentJsonlHash = await this.computeJsonlHash(nodeId)
      const currentMarkdownHash = await this.computeMarkdownHash(nodeId)

      const jsonlChanged = currentJsonlHash !== state.jsonlHash
      const markdownChanged = currentMarkdownHash !== state.markdownHash

      if (jsonlChanged && markdownChanged) {
        // Both changed - potential conflict
        if (currentJsonlHash === currentMarkdownHash) {
          // Same content - no conflict, just update state
          changes.jsonlUpdated.push(nodeId) // or markdownUpdated, same result
        } else {
          changes.conflicts.push({
            nodeId,
            jsonlHash: currentJsonlHash,
            markdownHash: currentMarkdownHash,
          })
        }
      } else if (jsonlChanged) {
        changes.jsonlUpdated.push(nodeId)
      } else if (markdownChanged) {
        changes.markdownUpdated.push(nodeId)
      }
    }

    return changes
  }

  /**
   * Apply sync with conflict resolution
   */
  async sync(strategy: SyncStrategy): Promise<SyncResult> {
    const changes = await this.detectChanges()

    // Handle non-conflicting changes
    for (const nodeId of changes.jsonlUpdated) {
      await this.updateMarkdownFromJsonl(nodeId)
    }

    for (const nodeId of changes.markdownUpdated) {
      await this.updateJsonlFromMarkdown(nodeId)
    }

    // Handle conflicts based on strategy
    for (const conflict of changes.conflicts) {
      await this.resolveConflict(conflict, strategy)
    }

    // Update sync state
    await this.updateSyncState()

    return { /* results */ }
  }
}
```

### Conflict Resolution Strategies

```typescript
type SyncStrategy =
  | 'jsonl-wins'           // JSONL is authoritative
  | 'markdown-wins'        // Markdown edits take priority
  | 'newer-wins'           // Compare timestamps
  | 'merge-content'        // Attempt content merge
  | 'manual'               // Create .conflict file for user
  | 'interactive'          // Prompt user/agent

interface ConflictResolution {
  strategy: SyncStrategy

  /** For merge-content: how to merge */
  mergeOptions?: {
    /** Merge frontmatter (metadata) */
    frontmatter: 'jsonl' | 'markdown' | 'merge-fields'

    /** Merge body (content) */
    body: 'jsonl' | 'markdown' | 'diff3'
  }

  /** For manual: where to write conflict file */
  conflictFilePattern?: string  // e.g., "{path}.conflict"
}
```

### Recommended Default Strategy

```typescript
const defaultSyncStrategy: ConflictResolution = {
  strategy: 'merge-content',
  mergeOptions: {
    // Metadata: JSONL wins (more structured, less likely user-edited)
    frontmatter: 'merge-fields',  // Per-field: newer timestamp wins

    // Content: Markdown wins (user/agent edits are intentional)
    body: 'markdown',
  },
}
```

**Rationale:**
- **Frontmatter/metadata**: JSONL is structured, edits there are programmatic
- **Body/content**: Markdown edits are intentional (user or agent writing)
- **Fallback**: If merge fails, create `.conflict` file

### Git Operation Handling

```typescript
interface GitEventHandler {
  /**
   * Called after git pull/merge/checkout
   * JSONL may have changed, need to refresh markdown
   */
  async onGitUpdate(): Promise<void> {
    // 1. Detect JSONL changes via content hash
    const jsonlChanged = await this.hasJsonlChanged()

    if (jsonlChanged) {
      // 2. Check for uncommitted markdown changes
      const uncommittedMd = await this.getUncommittedMarkdownChanges()

      if (uncommittedMd.length > 0) {
        // 3. Stash markdown changes, apply JSONL, re-apply markdown
        await this.stashMarkdownChanges(uncommittedMd)
        await this.refreshMarkdownFromJsonl()
        await this.reapplyMarkdownChanges(uncommittedMd)
      } else {
        // Simple case: just refresh markdown
        await this.refreshMarkdownFromJsonl()
      }
    }
  }

  /**
   * Called before git commit
   * Ensure JSONL is up-to-date with markdown changes
   */
  async onPreCommit(): Promise<void> {
    // Sync markdown changes to JSONL before commit
    await this.syncMarkdownToJsonl()
  }
}
```

### File Watcher Integration

```typescript
interface FileWatcher {
  /** Watch markdown directory for changes */
  watch(paths: string[], callback: WatchCallback): WatchHandle

  /** Debounce rapid changes */
  debounceMs: number  // e.g., 500ms

  /** Ignore patterns */
  ignore: string[]    // e.g., ['*.tmp', '*.conflict']
}

class MarkdownFileWatcher {
  private watcher: FSWatcher
  private pending: Map<string, NodeJS.Timeout> = new Map()

  constructor(private syncManager: MarkdownSyncManager) {}

  async onFileChange(path: string, event: 'change' | 'add' | 'unlink') {
    // Debounce rapid changes
    if (this.pending.has(path)) {
      clearTimeout(this.pending.get(path))
    }

    this.pending.set(path, setTimeout(async () => {
      this.pending.delete(path)

      switch (event) {
        case 'change':
          await this.syncManager.onMarkdownChanged(path)
          break
        case 'add':
          await this.syncManager.onMarkdownCreated(path)
          break
        case 'unlink':
          await this.syncManager.onMarkdownDeleted(path)
          break
      }
    }, this.debounceMs))
  }
}
```

---

## Compaction Strategy

Prevent JSONL files from growing unbounded. Inspired by beads' tiered compaction.

### The Problem

```
graph.jsonl grows over time:
- New nodes added
- Node updates append (for merge-friendliness)
- Deleted nodes become tombstones
- Old closed issues accumulate

Without compaction:
- File size grows linearly
- Parse time increases
- Git history bloats
```

### Compaction Levels

```typescript
interface CompactionConfig {
  /** Enable automatic compaction */
  enabled: boolean

  /** Tier 1: Basic compaction */
  tier1: {
    /** Days after close before eligible */
    afterDays: number           // default: 30

    /** Don't compact if has open dependents within N levels */
    dependencyLevels: number    // default: 2

    /** Summarization approach */
    summarize: 'truncate' | 'llm' | 'none'

    /** Target size reduction */
    targetReduction: number     // default: 0.7 (70%)
  }

  /** Tier 2: Aggressive compaction */
  tier2: {
    afterDays: number           // default: 90
    dependencyLevels: number    // default: 5
    targetReduction: number     // default: 0.95 (95%)
  }

  /** Tombstone cleanup */
  tombstones: {
    /** TTL before hard delete */
    ttlDays: number             // default: 30

    /** Minimum TTL (safety) */
    minTtlDays: number          // default: 7
  }

  /** JSONL file management */
  file: {
    /** Max entries before triggering compaction */
    maxEntries: number          // default: 10000

    /** Max file size before triggering */
    maxSizeMb: number           // default: 10

    /** Compact on daemon startup */
    compactOnStartup: boolean
  }
}
```

### Compaction Operations

```typescript
interface Compactor {
  /**
   * Analyze compaction candidates
   */
  analyze(): Promise<CompactionAnalysis>

  /**
   * Execute compaction
   */
  compact(options: CompactOptions): Promise<CompactionResult>

  /**
   * Prune expired tombstones
   */
  pruneTombstones(): Promise<PruneResult>

  /**
   * Rewrite JSONL (dedupe entries, remove old versions)
   */
  rewriteJsonl(): Promise<RewriteResult>
}

interface CompactionAnalysis {
  /** Nodes eligible for Tier 1 */
  tier1Candidates: NodeSummary[]

  /** Nodes eligible for Tier 2 */
  tier2Candidates: NodeSummary[]

  /** Expired tombstones */
  expiredTombstones: string[]

  /** Duplicate entries (same node, multiple versions) */
  duplicateEntries: number

  /** Current file size */
  currentSizeMb: number

  /** Estimated size after compaction */
  estimatedSizeMb: number
}
```

### JSONL Rewrite Strategy

```typescript
/**
 * Rewrite JSONL to remove duplicates and old versions
 * Only keeps latest version of each node
 */
async function rewriteJsonl(path: string): Promise<void> {
  const nodes = new Map<string, StoredNode>()
  const edges = new Map<string, StoredEdge>()

  // Read all entries, keep only latest
  for await (const line of readLines(path)) {
    const entry = JSON.parse(line)

    if (entry.type === 'edge' || entry.id?.startsWith('x-')) {
      edges.set(entry.id, entry)
    } else {
      // Compare timestamps, keep newer
      const existing = nodes.get(entry.id)
      if (!existing || entry.updated_at > existing.updated_at) {
        nodes.set(entry.id, entry)
      }
    }
  }

  // Filter out archived/deleted beyond retention
  const retained = [...nodes.values()].filter(node => {
    if (node.deleted_at) {
      const age = Date.now() - new Date(node.deleted_at).getTime()
      return age < TOMBSTONE_TTL_MS
    }
    return true
  })

  // Atomic rewrite
  const tempPath = `${path}.${process.pid}.tmp`
  const output = fs.createWriteStream(tempPath)

  for (const node of retained) {
    output.write(JSON.stringify(node) + '\n')
  }
  for (const edge of edges.values()) {
    output.write(JSON.stringify(edge) + '\n')
  }

  await output.close()
  await fs.rename(tempPath, path)
}
```

### Content Summarization

For Tier 1+ compaction, optionally summarize content:

```typescript
interface ContentSummarizer {
  /**
   * Summarize node content
   * Can use LLM or simple truncation
   */
  summarize(node: Node): Promise<SummarizedNode>
}

interface SummarizedNode {
  /** Compressed content */
  content: string

  /** Original content size */
  originalSize: number

  /** Compressed content size */
  compressedSize: number

  /** Reduction percentage */
  reductionPct: number
}

// Simple truncation summarizer
class TruncateSummarizer implements ContentSummarizer {
  async summarize(node: Node): Promise<SummarizedNode> {
    const original = node.content || ''
    const maxLength = 500

    const compressed = original.length > maxLength
      ? original.slice(0, maxLength) + '\n\n[Content truncated during compaction]'
      : original

    return {
      content: compressed,
      originalSize: original.length,
      compressedSize: compressed.length,
      reductionPct: 1 - (compressed.length / original.length),
    }
  }
}

// LLM-based summarizer (like beads' Haiku integration)
class LLMSummarizer implements ContentSummarizer {
  async summarize(node: Node): Promise<SummarizedNode> {
    const prompt = `
      Summarize this completed task for archival:

      Title: ${node.title}
      Content: ${node.content}

      Provide:
      - Summary: 2-3 sentences on what was done
      - Key Decisions: Important technical choices
      - Resolution: One sentence on outcome

      Keep it shorter than the original.
    `

    const summary = await this.llm.complete(prompt)

    return {
      content: summary,
      originalSize: (node.content || '').length,
      compressedSize: summary.length,
      reductionPct: 1 - (summary.length / (node.content || '').length),
    }
  }
}
```

### Snapshot for Recovery

Before compaction, save original for potential recovery:

```typescript
interface CompactionSnapshot {
  /** Node ID */
  nodeId: string

  /** Compaction level applied */
  level: number

  /** Full original content */
  originalContent: string

  /** Original metadata */
  originalMetadata: Record<string, unknown>

  /** When compacted */
  compactedAt: string

  /** Git commit at compaction (for recovery) */
  gitCommit?: string
}

// Store in SQLite (not JSONL - too large)
// Can be pruned after longer retention (e.g., 1 year)
```

### Pinned Nodes

Protect important nodes from compaction:

```typescript
interface Node {
  // ... other fields

  /** Protected from compaction */
  pinned?: boolean

  /** Why pinned */
  pinReason?: string
}

// Compactor skips pinned nodes
function isCompactionEligible(node: Node): boolean {
  if (node.pinned) return false
  if (node.status !== 'closed') return false
  if (hasOpenDependents(node)) return false
  // ... other checks
}
```

---

## Daemon Architecture

### Phased Approach

- **Phase 2**: No daemon. SQLite WAL mode handles concurrent reads. Advisory file lock (`write.lock`) serializes JSONL writes. Direct file access only.
- **Phase 3**: Single daemon per git repository at `.git/opentasks/daemon.sock`. Manages all registered worktrees.

### Why a Single Daemon per Git Repo? (Phase 3)

1. **File watching** — Monitor JSONL and markdown for changes across all worktrees
2. **Debounced writes** — Batch rapid changes before persisting
3. **Cross-location coordination** — Multiple agents sharing state via in-process function calls (not IPC hops)
4. **Background sync** — Provider sync, remote fetch
5. **Compaction** — Periodic cleanup without blocking operations
6. **Branch caching** — Watch `.git/HEAD` for branch changes

**Why NOT one daemon per location (previous design):**
- N+1 processes for agent swarms is wasteful
- Cross-location queries require IPC between daemons (latency)
- Claim atomicity requires distributed coordination
- Process lifecycle management is complex (orphaned daemons)

### Daemon Location

```
.git/opentasks/
├── daemon.sock           # Unix socket (shared by all worktrees)
├── daemon.lock           # PID lock
└── worktrees.json        # Registered worktrees
```

Socket lives in `.git/opentasks/` because `.git/` is shared across all worktrees. No global registry needed — any worktree finds the daemon at the same path.

### IPC Protocol

```typescript
interface DaemonRequest {
  id: string
  method: DaemonMethod
  params?: unknown
}

interface DaemonResponse {
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

type DaemonMethod =
  // Graph operations (include location parameter)
  | 'graph.get'
  | 'graph.query'
  | 'graph.create'
  | 'graph.update'
  | 'graph.delete'

  // Sync operations
  | 'sync.flush'
  | 'sync.import'

  // Lifecycle
  | 'daemon.ping'
  | 'daemon.health'
  | 'daemon.status'
  | 'daemon.shutdown'

  // Worktree management
  | 'worktree.register'
  | 'worktree.unregister'
  | 'worktree.list'
  | 'worktree.find'

  // Connections
  | 'connection.health'
```

See [plans/PHASE-3.md](./plans/PHASE-3.md) for full daemon specification, auto-start behavior, and lifecycle.

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Split vs single JSONL | **Single `graph.jsonl`** with compaction to manage size |
| Markdown sync priority | **Merge strategy**: frontmatter from JSONL, body from markdown |
| Compaction strategy | **Tiered**: 30 days → Tier 1, 90 days → Tier 2, with LLM summarization option |
| Daemon model | **Single daemon per git repo** (Phase 3 only); Phase 2 uses WAL + file locks |
| JSONL write mode | **Append-only** — updates append new line, never overwrite in-place |
| Git merge conflicts | **Custom merge driver** with field-level three-way merge |
| Location discovery | **One-time setup aid** (`opentasks discover`), not runtime; explicit connections |
| Worktree detection | **Explicit registration** via `opentasks worktree setup`, not passive detection |
| Redirect conditions | **Role-based** (set in config by orchestrator), not agent-identity-based |
| Global registry | **Eliminated** — socket at `.git/opentasks/daemon.sock` + explicit connections |

---

## References

### Beads Persistence Patterns
- **FlushManager**: Event-driven, single-goroutine flush coordination with debouncing
- **Dirty tracking**: Per-node dirty flags with `marked_at` ordering
- **Content hashing**: SHA256 of substantive fields for dedup
- **Atomic writes**: Temp file with PID suffix + rename
- **Multi-repo export**: Filter by prefix, route to separate files
- **Worktree redirect**: `.beads/redirect` file for shared state

### TinyBase Persister Model
- [Custom Persistence Guide](https://tinybase.org/guides/persistence/custom-persistence/)
- [Persister Interface](https://tinybase.org/api/persisters/interfaces/persister/persister/)
- Four core methods: `getPersisted`, `setPersisted`, `subscribe`, `unsubscribe`

### Sudocode Three-Layer Model
- Markdown ↔ JSONL ↔ SQLite with bidirectional sync
- File watcher for markdown changes
- Frontmatter for metadata, body for content
