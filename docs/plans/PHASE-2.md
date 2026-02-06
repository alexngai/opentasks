# Phase 2: Cross-Location References

> Spec ID: s-7es6 | Tags: phase-2, v2, cross-location, wal
>
> Implements: [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md)
> Depends on: [PHASE-1.md](./PHASE-1.md)
>
> **Revised**: Replaces per-location daemon with SQLite WAL + file locks.
> Replaces global registry with explicit connections. Adds location identity hashes.

## Scope

Add the ability to reference nodes in other OpenTasks locations, enabling multi-repo and multi-worktree scenarios. **No daemon required** — uses SQLite WAL mode for concurrent reads and advisory file locks for write serialization.

## Prerequisites

- Phase 1 complete (single-location + provider URIs)

---

## What's Included

### 1. Location Identity

Each `.opentasks/` directory gets a deterministic identity on initialization:

```json
// .opentasks/config.json
{
  "version": "1.0",
  "location": {
    "hash": "k7m2x9p4",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "name": "myapp"
  }
}
```

#### Hash Generation

```typescript
import { createHash } from 'node:crypto'

function generateLocationHash(repoRoot: string, relativePath: string): string {
  // Use git remote URL as stable root identity
  const remoteUrl = execSync('git remote get-url origin', { cwd: repoRoot })
    .toString().trim()
  const input = `${remoteUrl}:${relativePath}`
  const hash = createHash('sha256').update(input).digest('hex')
  return hexToBase36(hash).slice(0, 8)
}

// Fallback for repos without a remote:
function generateLocationHashFallback(absolutePath: string): string {
  const hash = createHash('sha256').update(absolutePath).digest('hex')
  return hexToBase36(hash).slice(0, 8)
}
```

**Properties:**
- **Deterministic**: Same repo + path always produces same hash, even across machines
- **Short**: 8 chars base36 = ~2.8 trillion possibilities (collision-free for practical use)
- **Stable**: Survives directory renames (git remote URL is the anchor)
- **Fallback**: UUID provides uniqueness guarantee when hash can't be deterministic

### 2. opentasks:// URI Scheme

```
opentasks://k7m2x9p4/i-x7k9           # By location hash (preferred)
opentasks://./i-x7k9                    # Current location (convenience)
opentasks:///abs/path/.opentasks/s-g8h9 # Absolute path (fallback)
```

#### URI Resolution

```typescript
interface ParsedOpentasksUri {
  scheme: 'opentasks'
  locationHash?: string           // e.g., "k7m2x9p4"
  relativePath?: string           // e.g., "./" or "../other/"
  absolutePath?: string           // e.g., "/abs/path/.opentasks/"
  nodeId: string                  // e.g., "i-x7k9"
}

function resolveOpentasksUri(
  uri: string,
  connections: Connection[],
  currentLocation: Location
): ResolvedLocation {
  const parsed = parseOpentasksUri(uri)

  // 1. Current location shorthand
  if (parsed.relativePath === './') {
    return { location: currentLocation, nodeId: parsed.nodeId }
  }

  // 2. Hash-based resolution (preferred)
  if (parsed.locationHash) {
    const connection = connections.find(c => c.hash === parsed.locationHash)
    if (connection) {
      return { location: connectionToLocation(connection), nodeId: parsed.nodeId }
    }
    // Hash not found in connections — error
    throw new Error(`Unknown location hash: ${parsed.locationHash}`)
  }

  // 3. Absolute path resolution (fallback)
  if (parsed.absolutePath) {
    const connection = connections.find(c =>
      path.resolve(c.path) === parsed.absolutePath
    )
    if (connection) {
      return { location: connectionToLocation(connection), nodeId: parsed.nodeId }
    }
    // Not in connections but path exists — direct access
    return { location: pathToLocation(parsed.absolutePath), nodeId: parsed.nodeId }
  }

  throw new Error(`Cannot resolve URI: ${uri}`)
}
```

### 3. Explicit Connections

Locations declare their connections in `config.json`:

```json
{
  "connections": [
    {
      "hash": "m3p8q2w5",
      "path": "../other-repo/.opentasks/",
      "role": "peer",
      "name": "other-repo"
    },
    {
      "hash": "r7t1v9z3",
      "path": "../../shared-specs/.opentasks/",
      "role": "parent",
      "name": "shared-specs"
    }
  ]
}
```

#### Connection Management CLI

```bash
# Add a connection
opentasks connect ../other-repo/.opentasks/
# Reads target's config.json to get hash/name
# Adds to current location's connections[]

# Remove a connection
opentasks disconnect m3p8q2w5
# Removes from connections[] by hash

# List connections with health status
opentasks connections
# HASH      NAME          PATH                              ROLE    STATUS
# m3p8q2w5  other-repo    ../other-repo/.opentasks/         peer    reachable
# r7t1v9z3  shared-specs  ../../shared-specs/.opentasks/    parent  unreachable
```

#### Connection Health

Health is determined by probing the target path:
1. Does the path exist?
2. Is there a valid `config.json`?
3. Does the hash in `config.json` match the stored hash?

No daemon probing needed — just filesystem checks.

### 4. Concurrent Access (SQLite WAL + File Locks)

Phase 2 supports multiple processes accessing the same `.opentasks/` without a daemon.

#### Read Path (SQLite WAL)

```typescript
// Multiple processes can read concurrently via WAL mode
const db = new Database('.opentasks/cache.db')
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// Any process can query
const readyIssues = db.prepare(`
  SELECT * FROM ready_issues
`).all()
```

WAL mode allows:
- **Multiple concurrent readers** across processes
- **Single writer** (serialized by SQLite's own WAL lock)
- No daemon coordination needed

#### Write Path (Advisory File Lock)

```typescript
import { flockSync } from 'fs-ext'  // or equivalent

async function appendToJsonl(path: string, entry: object): Promise<void> {
  const lockPath = path.replace('graph.jsonl', 'write.lock')
  const lockFd = fs.openSync(lockPath, 'w')

  try {
    // Acquire exclusive lock (blocks until available)
    flockSync(lockFd, 'ex')

    // Append entry
    fs.appendFileSync(path, JSON.stringify(entry) + '\n')

    // Update SQLite cache
    await updateSqliteCache(entry)
  } finally {
    // Release lock
    flockSync(lockFd, 'un')
    fs.closeSync(lockFd)
  }
}
```

**Why this works:**
- Reads don't need locks (SQLite WAL handles concurrent reads)
- Writes are serialized by the advisory lock
- JSONL append is atomic at the OS level for reasonable line sizes
- No daemon process to manage

### 5. Basic Redirect Rules

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

#### Redirect Resolution

```typescript
interface RedirectRule {
  operations: ('read' | 'write')[]
  pattern: string                    // Glob for node IDs: "*", "i-*", "s-*"
  target: string                     // Location hash URI or relative path
  priority: number                   // Lower = higher priority, default 100
  fallback: 'local' | 'error'       // What to do if target unreachable
}

function resolveRedirect(
  operation: 'read' | 'write',
  nodeIdOrPattern: string,
  rules: RedirectRule[]
): RedirectRule | null {
  // Sort by priority (ascending)
  const sorted = [...rules].sort((a, b) => a.priority - b.priority)

  for (const rule of sorted) {
    if (!rule.operations.includes(operation)) continue
    if (!globMatch(rule.pattern, nodeIdOrPattern)) continue
    return rule
  }

  return null  // No redirect — operate locally
}
```

**Redirect target resolution** uses the same connection-based lookup as URI resolution. The target must be a declared connection or a resolvable `opentasks://` URI.

**Max redirect depth**: 3 hops. Prevents infinite loops.

### 6. Append-Only JSONL Writes

All mutations append rather than overwrite:

```typescript
async function updateNode(id: string, updates: Partial<StoredNode>): Promise<void> {
  // 1. Read current state from SQLite cache
  const current = await sqliteGet(id)
  if (!current) throw new Error(`Node not found: ${id}`)

  // 2. Merge updates
  const updated = {
    ...current,
    ...updates,
    updated_at: new Date().toISOString(),
  }

  // 3. Append to JSONL (never overwrite existing lines)
  await appendToJsonl('.opentasks/graph.jsonl', updated)

  // 4. Update SQLite cache (overwrite in-place — cache is ephemeral)
  await sqliteUpsert(updated)
}
```

On load (startup or cache rebuild), JSONL is read sequentially. For each ID, only the entry with the latest `updated_at` is kept.

---

## What's NOT Included (Phase 3)

- Single daemon per git repo
- Cross-location queries (query expansion modes)
- Worktree CLI (`opentasks worktree setup/teardown`)
- Conditional redirect rules (branch/role matching)
- Custom JSONL merge driver
- Location discovery

---

## Deliverables

### Location Identity (`src/core/location.ts`)
- [ ] Hash generation from git remote + path
- [ ] Fallback hash for repos without remote
- [ ] UUID generation on init
- [ ] Location identity in `config.json`

### URI Resolution (`src/core/uri.ts`)
- [ ] `opentasks://` URI parser
- [ ] Hash-based resolution via connections list
- [ ] Absolute path resolution (fallback)
- [ ] Current-location shorthand (`./`)

### Connection Management (`src/core/connections.ts`)
- [ ] `opentasks connect <path>` — add connection
- [ ] `opentasks disconnect <hash>` — remove connection
- [ ] `opentasks connections` — list with health status
- [ ] Connection health check (filesystem probe)

### Concurrent Access (`src/storage/`)
- [ ] SQLite WAL mode configuration
- [ ] Advisory file lock for JSONL writes (`write.lock`)
- [ ] Append-only JSONL write path
- [ ] Cache rebuild from JSONL (dedup by latest `updated_at`)

### Redirect System (`src/core/redirects.ts`)
- [ ] Redirect rule matching (pattern + operation + priority)
- [ ] Target resolution via connections
- [ ] Fallback behavior (local vs error)
- [ ] Max depth enforcement (3 hops)

### Init Updates (`src/commands/init.ts`)
- [ ] Generate location hash on `opentasks init`
- [ ] Generate UUID on `opentasks init`
- [ ] Store in `config.json`

---

## Technical Design

### Cross-Location Node Fetching

Without a daemon, cross-location reads happen via direct file access:

```typescript
async function fetchRemoteNode(
  connection: Connection,
  nodeId: string
): Promise<StoredNode | null> {
  const remoteCachePath = path.join(connection.path, 'cache.db')

  // Prefer SQLite read (WAL mode allows concurrent readers)
  if (fs.existsSync(remoteCachePath)) {
    const remoteDb = new Database(remoteCachePath, { readonly: true })
    remoteDb.pragma('journal_mode = WAL')
    const node = remoteDb.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId)
    remoteDb.close()
    return node || null
  }

  // Fallback: parse JSONL directly
  return parseJsonlForNode(path.join(connection.path, 'graph.jsonl'), nodeId)
}
```

### Redirect Resolution Flow

```
1. Agent requests operation (e.g., read node i-x7k9)
2. Check config.json redirect rules
3. First matching rule by priority:
   - If redirect found → resolve target via connections
   - If target reachable → perform operation on target location
   - If target unreachable → apply fallback (local or error)
   - If no redirect matches → operate on local location
4. Track redirect depth (max 3)
```

### Cache Rebuild on Startup

```typescript
async function rebuildCache(jsonlPath: string, cachePath: string): Promise<void> {
  const nodes = new Map<string, StoredNode>()
  const edges = new Map<string, StoredEdge>()

  // Read all JSONL entries, keep latest per ID
  for await (const line of readLines(jsonlPath)) {
    const entry = JSON.parse(line)
    const id = entry.id

    if (entry.type === 'edge' || id.startsWith('x-')) {
      edges.set(id, entry)
    } else {
      const existing = nodes.get(id)
      if (!existing || entry.updated_at > existing.updated_at) {
        nodes.set(id, entry)
      }
    }
  }

  // Write to SQLite
  const db = new Database(cachePath)
  db.pragma('journal_mode = WAL')

  const insertNode = db.prepare(`
    INSERT OR REPLACE INTO nodes (id, uuid, type, title, content, status, priority,
      content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    db.exec('DELETE FROM nodes')
    db.exec('DELETE FROM edges')

    for (const node of nodes.values()) {
      insertNode.run(node.id, node.uuid, node.type, node.title, node.content,
        node.status, node.priority, node.content_hash, node.created_at, node.updated_at)
    }

    // ... insert edges similarly
  })()
}
```

---

## Success Criteria

Phase 2 is complete when:
1. `opentasks init` generates location hash + UUID in `config.json`
2. Can create edges referencing `opentasks://hash/node-id` URIs
3. Can resolve `opentasks://` URIs via connections list
4. `opentasks connect/disconnect` manages connections
5. SQLite WAL allows concurrent reads across processes
6. File lock serializes JSONL writes without a daemon
7. Redirect rules route operations to configured targets
8. Append-only JSONL writes work correctly (dedup on load)
