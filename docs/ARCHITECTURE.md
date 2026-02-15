# OpenTasks Architecture

This document describes the overall architecture of OpenTasks, including the hierarchical location model, daemon design, and cross-location connectivity.

See also:
- [DESIGN.md](./DESIGN.md) — Design rationale and core concepts
- [SCHEMA.md](./SCHEMA.md) — Data model and types
- [PERSISTENCE.md](./PERSISTENCE.md) — Storage and sync
- [PROVIDERS.md](./PROVIDERS.md) — Provider integration
- [INTERFACE.md](./INTERFACE.md) — API

---

## Architectural Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agents / Clients                          │
│              (Claude, CLI, IDE integrations, etc.)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
┌───────────────────────────┐ ┌───────────────────────────────────┐
│      OpenTasks Client     │ │        Location Discovery          │
│  - Connect to daemon      │ │  - Find .opentasks/ locations     │
│  - Query with expansion   │ │  - Resolve URIs                   │
│  - Cross-location refs    │ │  - Registry lookup                │
└───────────────────────────┘ └───────────────────────────────────┘
                    │                   │
                    └─────────┬─────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Global Registry                              │
│                 (~/.opentasks/registry.json)                     │
│  - Tracks all running daemons                                    │
│  - Enables daemon discovery                                      │
│  - Cleanup of stale entries                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────────────┐
│ User Daemon   │   │Workspace Daemon│  │  Project Daemon       │
│ ~/.opentasks/ │   │~/proj/.opentasks│ │~/proj/app/.opentasks/ │
└───────────────┘   └───────────────┘   └───────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────────────┐
│  Persistence  │   │  Persistence  │   │     Persistence       │
│  - graph.jsonl│   │  - graph.jsonl│   │  - graph.jsonl        │
│  - cache.db   │   │  - cache.db   │   │  - cache.db           │
└───────────────┘   └───────────────┘   └───────────────────────┘
```

---

## Location Hierarchy

OpenTasks supports multiple `.opentasks/` locations at different levels of the filesystem hierarchy.

### Location Levels

| Level | Path Example | Typical Use |
|-------|--------------|-------------|
| **User** | `~/.opentasks/` | Personal tasks, cross-project work |
| **Workspace** | `~/projects/.opentasks/` | Team coordination, shared context |
| **Project** | `~/projects/myapp/.opentasks/` | Project-specific work |
| **Subproject** | `~/projects/myapp/packages/core/.opentasks/` | Package/module work |

### Isolation by Default

Each location is **isolated by default**:
- Queries only return nodes from the current location
- No automatic inheritance from parent locations
- No automatic discovery of child locations

**Rationale:**
- Predictable behavior
- No surprise data leakage
- Clear ownership boundaries
- Performance (no hierarchy traversal by default)

### Explicit Connectivity

Locations connect through **explicit outbound edges**:

```json
{
  "id": "x-r8s9",
  "from_id": "t-x7k9",
  "to_id": "opentasks://~/projects/.opentasks/c-a2b3",
  "type": "implements"
}
```

This edge explicitly connects a local task to a context in the parent workspace.

### Query Expansion

When needed, queries can expand to other locations:

```typescript
type ExpansionMode =
  | 'none'           // Only current location (default)
  | 'follow-refs'    // Follow outbound edge references
  | 'ancestors'      // Include parent locations (upward)
  | 'descendants'    // Include child locations (downward)
  | 'siblings'       // Include sibling locations
  | 'all'            // Full hierarchy traversal
```

**Example usage:**

```typescript
// Default: isolated query
const issues = await client.query({ type: 'task' })

// Expand to follow references
const issues = await client.query(
  { type: 'task' },
  { expand: 'follow-refs' }
)

// Expand to include ancestor locations
const ctx = await client.query(
  { type: 'context' },
  { expand: 'ancestors' }
)
```

---

## URI Scheme

Cross-location references use the `opentasks://` URI scheme.

### URI Format

```
opentasks://<path>/<node-id>
```

### Path Types

| Pattern | Meaning | Example |
|---------|---------|---------|
| `~` | User home | `opentasks://~/.opentasks/c-a2b3` |
| `.` | Current location | `opentasks://./t-x7k9` |
| `..` | Parent directory | `opentasks://../.opentasks/c-c4d5` |
| `/abs/path` | Absolute path | `opentasks:///home/user/proj/.opentasks/t-e6f7` |

### URI Resolution

```typescript
interface URIResolver {
  /**
   * Resolve URI to absolute path and node ID
   */
  resolve(uri: string, fromLocation: string): ResolvedURI

  /**
   * Create URI from absolute path
   */
  create(path: string, nodeId: string): string

  /**
   * Normalize URI (resolve . and ..)
   */
  normalize(uri: string, fromLocation: string): string
}

interface ResolvedURI {
  /** Absolute path to .opentasks/ directory */
  locationPath: string

  /** Node ID within that location */
  nodeId: string

  /** Whether location exists */
  exists: boolean

  /** Whether daemon is running for location */
  daemonRunning: boolean
}
```

### ID Uniqueness

- **Within location**: Hash-based IDs prevent collisions
- **Across locations**: Full URI is globally unique
- Same short ID can exist in different locations:
  ```
  opentasks://~/projects/app-a/.opentasks/t-x7k9  ← unique
  opentasks://~/projects/app-b/.opentasks/t-x7k9  ← unique (different location)
  ```

---

## Daemon Architecture

Following beads' model: **one daemon per `.opentasks/` location**.

### Daemon Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                         START                                     │
│  1. Check for existing daemon (via lock file)                    │
│  2. Acquire exclusive lock (.opentasks/daemon.lock)              │
│  3. Write PID + metadata to lock file                            │
│  4. Initialize persistence layer                                  │
│  5. Start IPC server (Unix socket: .opentasks/daemon.sock)       │
│  6. Register in global registry (~/.opentasks/registry.json)     │
│  7. Start file watchers                                           │
│  8. Start background tasks (flush, compaction, sync)             │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                        RUNNING                                    │
│  - Handle IPC requests                                            │
│  - Watch files for changes                                        │
│  - Debounced flush to persistence                                 │
│  - Periodic health checks                                         │
│  - Track last activity time                                       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         STOP                                      │
│  1. RPC shutdown request (2s timeout)                            │
│  2. Fallback: SIGTERM (3s timeout)                               │
│  3. Fallback: SIGKILL (1s timeout)                               │
│  4. Final flush to persistence                                    │
│  5. Unregister from global registry                              │
│  6. Cleanup: socket file, lock file                              │
└──────────────────────────────────────────────────────────────────┘
```

### Lock File

```typescript
interface DaemonLock {
  pid: number
  parentPid: number
  version: string
  startedAt: string
  socketPath: string
  databasePath: string
}

// Location: .opentasks/daemon.lock
// Exclusive flock prevents multiple daemons
```

### Socket Communication

```
Transport: Unix domain socket (.opentasks/daemon.sock)
Protocol: Line-based JSON-RPC

Request:  {"id":"...", "method":"graph.query", "params":{...}}\n
Response: {"id":"...", "result":{...}}\n
   - or - {"id":"...", "error":{"code":..., "message":"..."}}\n
```

### IPC Methods

| Category | Methods |
|----------|---------|
| **Lifecycle** | `ping`, `health`, `status`, `metrics`, `shutdown` |
| **Graph** | `query`, `get`, `create`, `update`, `delete` |
| **Sync** | `flush`, `import`, `export` |
| **Compaction** | `analyze`, `compact`, `prune` |
| **Discovery** | `locations`, `resolve-uri` |

### Global Registry

```typescript
interface DaemonRegistry {
  /** Registry file path */
  path: string  // ~/.opentasks/registry.json

  /** All registered daemons */
  daemons: DaemonInfo[]
}

interface DaemonInfo {
  /** Workspace path (absolute) */
  workspacePath: string

  /** Socket path */
  socketPath: string

  /** Process ID */
  pid: number

  /** OpenTasks version */
  version: string

  /** When started */
  startedAt: string

  /** Last activity timestamp */
  lastActivity: string
}
```

**Registry operations:**
- **Register**: On daemon start
- **Unregister**: On daemon stop
- **Cleanup**: Remove stale entries (dead PIDs)
- **List**: Find all running daemons
- **Find**: Locate daemon for specific path

### Auto-Start Behavior

```typescript
interface AutoStartConfig {
  /** Enable auto-start on first operation */
  enabled: boolean

  /** Timeout waiting for daemon */
  timeoutMs: number  // default: 5000

  /** Retry attempts */
  retries: number    // default: 3
}

async function ensureDaemon(location: string): Promise<Client> {
  // 1. Try connect to existing daemon
  const existing = await tryConnect(location)
  if (existing) return existing

  // 2. Start daemon if auto-start enabled
  if (config.autoStart) {
    await startDaemon(location)
    return await waitForDaemon(location, config.timeoutMs)
  }

  throw new Error('Daemon not running')
}
```

### Health Monitoring

```typescript
interface DaemonHealth {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number           // seconds
  version: string
  lastFlush: string        // ISO timestamp
  pendingWrites: number
  dbResponseTime: number   // ms
}

// Parent process monitoring
// Daemon exits if parent process dies (prevents orphans)
```

---

## Location Discovery

Clients can discover `.opentasks/` locations in the filesystem.

### Discovery Interface

```typescript
interface LocationDiscovery {
  /**
   * Find .opentasks/ locations relative to current
   */
  discover(options: DiscoveryOptions): Promise<LocationInfo[]>
}

interface DiscoveryOptions {
  /** Starting path */
  from: string

  /** Search direction */
  direction: 'ancestors' | 'descendants' | 'siblings' | 'all'

  /** Max depth to search */
  maxDepth?: number   // default: 10

  /** Include locations without running daemon */
  includeInactive?: boolean

  /** Skip patterns */
  skip?: string[]     // default: ['node_modules', '.git', 'vendor']
}

interface LocationInfo {
  /** Absolute path */
  path: string

  /** Canonical URI */
  uri: string

  /** Hierarchy level */
  level: 'user' | 'workspace' | 'project' | 'subproject'

  /** Daemon status */
  daemonRunning: boolean

  /** If running, basic stats */
  stats?: {
    nodeCount: number
    lastActivity: string
  }

  /** Has edges connecting to/from origin location */
  hasConnectionTo?: boolean
}
```

### Discovery Examples

```typescript
// From ~/projects/myapp/.opentasks/

// Find ancestors (parent locations)
const ancestors = await discover({
  from: '~/projects/myapp/.opentasks/',
  direction: 'ancestors'
})
// Returns:
// - opentasks://~/projects/.opentasks/
// - opentasks://~/.opentasks/

// Find descendants (child locations)
const children = await discover({
  from: '~/projects/myapp/.opentasks/',
  direction: 'descendants',
  maxDepth: 3
})
// Returns:
// - opentasks://~/projects/myapp/packages/core/.opentasks/
// - opentasks://~/projects/myapp/packages/utils/.opentasks/

// Find all and check connections
const all = await discover({
  from: '~/projects/myapp/.opentasks/',
  direction: 'all',
  includeInactive: true
})

const connected = all.filter(l => l.hasConnectionTo)
```

---

## Cross-Location Operations

### Following References

When edges reference external locations, clients can follow them:

```typescript
interface CrossLocationQuery {
  /**
   * Expand query to follow references
   */
  queryWithExpansion(
    filter: QueryFilter,
    options: ExpansionOptions
  ): Promise<ExpandedResult>

  /**
   * Resolve a single external reference
   */
  resolveRef(uri: string): Promise<Node | null>

  /**
   * Get all nodes reachable from a starting node
   */
  expandFrom(
    nodeId: string,
    options: { depth: number; direction: 'outbound' | 'inbound' | 'both' }
  ): Promise<Node[]>
}

interface ExpandedResult {
  /** Results from primary location */
  local: Node[]

  /** Results from other locations (keyed by URI) */
  external: Map<string, Node[]>

  /** Edges that cross locations */
  crossLocationEdges: Edge[]

  /** Locations that were queried */
  queriedLocations: string[]
}
```

### Multi-Daemon Queries

When expansion requires multiple locations, the client handles coordination:

```typescript
async function queryWithExpansion(
  filter: QueryFilter,
  expansion: ExpansionMode
): Promise<ExpandedResult> {
  // 1. Query local daemon
  const local = await localClient.query(filter)

  // 2. Find external references in results
  const externalRefs = findExternalRefs(local)

  // 3. Group by location
  const byLocation = groupByLocation(externalRefs)

  // 4. Query each external daemon
  const external = new Map<string, Node[]>()
  for (const [location, refs] of byLocation) {
    const daemon = await getDaemonForLocation(location)
    if (daemon) {
      const nodes = await daemon.getMany(refs.map(r => r.nodeId))
      external.set(location, nodes)
    }
  }

  return { local, external, /* ... */ }
}
```

---

## Query Architecture

OpenTasks provides multiple query layers with different trade-offs between performance and cross-provider support.

### Query Layers Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Query Consumers                          │
│           (Daemon methods, CLI, MCP tools, etc.)                │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐   ┌───────────────────────────────────┐
│    Native QueryEngine   │   │     Federated Query Methods       │
│  (createQueryEngine)    │   │  (HydratingFederatedGraph.ready)  │
│  - Storage-only queries │   │  - Cross-provider resolution      │
│  - Local node IDs only  │   │  - Hydration on demand            │
└─────────────────────────┘   └───────────────────────────────────┘
              │                               │
              ▼                               ▼
┌─────────────────────────┐   ┌───────────────────────────────────┐
│      SQLite Storage     │   │        Provider Registry          │
│    (graph.jsonl sync)   │   │   (Native + External Providers)   │
└─────────────────────────┘   └───────────────────────────────────┘
```

### Native Query Engine

The base `QueryEngine` operates on local SQLite storage:

```typescript
import { createQueryEngine } from './graph/query.js'

// Create storage-only query engine
const queryEngine = createQueryEngine(storage)

// Queries resolve local node IDs only
const blockers = await queryEngine.blockers('t-abc123')
// External URI blockers (beads://...) are silently skipped
```

**Use cases:**
- Quick local queries when external providers are unavailable
- Performance-critical paths
- Backward-compatible API

### Federated Query Engine

For cross-provider queries, provide a `nodeResolver`:

```typescript
import { createQueryEngine, type NodeResolver } from './graph/query.js'

const resolver: NodeResolver = async (idOrUri) => {
  return providerAwareStore.resolveNode(idOrUri)
}

const queryEngine = createQueryEngine({
  storage,
  nodeResolver: resolver,
})

// Now queries resolve both local IDs and external URIs
const blockers = await queryEngine.blockers('t-abc123')
```

**How resolution works:**
1. Local IDs (matching `/^[ctfex]-[a-z0-9]+$/`) use storage directly
2. External URIs (e.g., `beads://./bd-123`) go through the resolver

### HydratingFederatedGraph

Provides high-level federated queries with automatic hydration:

```typescript
const graph = createHydratingFederatedGraph(adapter, {
  storage,
  providerRegistry,
  cacheConfig: { defaultTTL: 5 * 60 * 1000 }
})

// Federated ready query - considers blockers from all providers
const readyIssues = await graph.ready({
  type: 'task',
  status: 'open',
  providers: ['native', 'beads']
})

// Resolve any URI to full node data
const node = await graph.resolve('beads://./bd-123')

// Traverse relationships across providers
const blockers = graph.related('native://t-123', {
  edgeType: 'blocks',
  direction: 'in'
})
```

### Cache Management

External node data is cached in SQLite with TTL-based staleness:

```typescript
// Check staleness
const isStale = graph.isStale('beads://./bd-123')

// Invalidate cache (persists to storage)
await graph.invalidateCache('beads')
```

**Important:** Cache invalidation persists to SQLite storage, ensuring invalidation survives process restarts.

### Provider URI Conventions

| Source | URI Format | Example |
|--------|------------|---------|
| Native | `native://{id}` | `native://t-abc123` |
| Beads | `beads://{workspace}/{id}` | `beads://./bd-xyz789` |
| Jira | `jira://{project}/{key}` | `jira://PROJ/PROJ-123` |

### Query Method Resolution

| Method | Without Resolver | With Resolver |
|--------|------------------|---------------|
| `blockers()` | Local IDs only | Resolves external URIs |
| `blocking()` | Local IDs only | Resolves external URIs |
| `ready()` | Skips unresolvable blockers | Considers all blockers |

**Note:** External nodes affect `ready()` blocking behavior but don't appear in `blockers()`/`blocking()` results (they're not valid `Node` types).

---

## Compaction and Deletion

### File Structure

```
.opentasks/
├── graph.jsonl           # Active nodes + edges (source of truth)
├── tombstones.jsonl      # Soft-deleted nodes (TTL-based cleanup)
├── cache.db              # SQLite cache (queries, snapshots)
├── config.json           # Configuration and retention policies
├── context/                # Optional: markdown expansion
├── tasks/               # Optional: markdown expansion
└── daemon.sock           # Daemon socket (when running)
```

See [PERSISTENCE.md](./PERSISTENCE.md) for details on file formats and sync.

### Retention Configuration

```typescript
interface RetentionConfig {
  /** Tombstone retention before hard delete */
  tombstoneTTL: {
    days: number          // default: 30
    minDays: number       // safety minimum: 7
  }

  /** Compaction settings */
  compaction: {
    /** Enable automatic compaction */
    enabled: boolean

    /** Tier 1: basic summarization */
    tier1: {
      afterDays: number   // default: 30
      summarize: 'truncate' | 'llm' | 'none'
    }

    /** Tier 2: aggressive compression */
    tier2: {
      afterDays: number   // default: 90
    }
  }

  /** What to gitignore */
  gitignore: {
    tombstones: boolean   // user choice
    archive: boolean      // user choice
    cache: true           // always gitignored
  }
}
```

### Recovery Mechanisms

1. **Tombstone file**: Soft deletes preserved for TTL period
2. **SQLite snapshots**: Compaction snapshots for longer retention
3. **Git history**: Ultimate recovery via `git show HEAD~n:graph.jsonl`

```typescript
interface RecoveryService {
  /** Recover from tombstones (within TTL) */
  recoverFromTombstone(nodeId: string): Promise<Node | null>

  /** Recover from SQLite snapshot */
  recoverFromSnapshot(nodeId: string): Promise<Node | null>

  /** Recover from git history */
  recoverFromGit(nodeId: string, ref?: string): Promise<Node | null>

  /** List recoverable nodes */
  listRecoverable(options: {
    source: 'tombstones' | 'snapshots' | 'git'
    filter?: QueryFilter
  }): Promise<RecoverableNode[]>
}
```

---

## Configuration

### Location Configuration

```typescript
// .opentasks/config.json
interface LocationConfig {
  /** Schema version */
  version: string

  /** Location metadata */
  location: {
    /** Optional friendly name */
    name?: string

    /** Hierarchy level hint */
    level?: 'user' | 'workspace' | 'project' | 'subproject'
  }

  /** Daemon configuration */
  daemon: {
    autoStart: boolean
    flushDebounceMs: number
    flushMaxDelayMs: number
  }

  /** Persistence configuration */
  persistence: {
    /** Enable markdown expansion */
    markdownExpansion: boolean

    /** Markdown config (if enabled) */
    markdown?: {
      context: string     // directory
      tasks: string       // directory
    }
  }

  /** Retention configuration */
  retention: RetentionConfig

  /** Known connections to other locations */
  connections?: {
    uri: string
    role: 'parent' | 'child' | 'peer'
  }[]
}
```

### Default Configuration

```json
{
  "version": "1.0",
  "daemon": {
    "autoStart": true,
    "flushDebounceMs": 5000,
    "flushMaxDelayMs": 30000
  },
  "persistence": {
    "markdownExpansion": false
  },
  "retention": {
    "tombstoneTTL": { "days": 30, "minDays": 7 },
    "compaction": {
      "enabled": false,
      "tier1": { "afterDays": 30, "summarize": "truncate" },
      "tier2": { "afterDays": 90 }
    },
    "gitignore": {
      "tombstones": false,
      "archive": false,
      "cache": true
    }
  }
}
```

---

## Design Principles Summary

1. **Isolation by default**: Locations don't see each other without explicit connection
2. **Explicit connectivity**: Cross-location references via URIs in edges
3. **One daemon per location**: Following beads' model
4. **Global registry**: Central tracking of all running daemons
5. **Query expansion**: Optional, client-controlled expansion to other locations
6. **URI-based uniqueness**: Full URIs are globally unique, short IDs are location-scoped
7. **Configurable retention**: Users control tombstone/archive behavior
8. **Git as ultimate recovery**: History available even after hard delete
