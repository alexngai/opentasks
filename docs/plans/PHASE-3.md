# Phase 3: Multi-Location Queries + Worktrees

> Spec ID: s-2qms | Tags: phase-3, v3, daemon, worktrees, merge-driver
>
> Implements: [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md)
> Depends on: [PHASE-2.md](./PHASE-2.md)
>
> **Revised**: Single daemon per git repo. Provider-based cross-location queries.
> Explicit worktree registration. Custom JSONL merge driver. Role-based redirects.

## Scope

Enable queries that span multiple OpenTasks locations, provide first-class git worktree support for agent swarms, and ensure safe JSONL merging across branches.

## Prerequisites

- Phase 1 complete (single-location + provider URIs)
- Phase 2 complete (location identity, connections, redirect rules, WAL mode)

---

## What's Included

### 1. Single Daemon per Git Repository

One daemon process manages all `.opentasks/` locations within a git repo.

#### Daemon Location

```
.git/opentasks/
├── daemon.sock           # Unix socket for IPC
├── daemon.lock           # PID + metadata for single-instance enforcement
└── worktrees.json        # Registered worktrees
```

The socket lives in `.git/opentasks/` because `.git/` is shared across all worktrees. Every worktree can find the daemon at the same path.

#### Daemon Responsibilities

- Hold SQLite connections for all registered locations (one `cache.db` handle per location)
- Serialize writes across all locations (replaces file-lock approach from Phase 2)
- Watch files for external changes (git operations, manual edits)
- Route cross-location queries in-process (no IPC hops between locations)
- Manage worktree registration
- Cache branch detection (watch `.git/HEAD` for changes)

#### IPC Protocol

```typescript
// Request — now includes location parameter
{
  "id": "uuid",
  "method": "graph.query",
  "params": {
    "location": "/path/to/.opentasks/",  // Which location to query
    "find": "ready",
    "expand": "follow-refs"               // Expansion mode
  }
}

// Response
{ "id": "uuid", "result": { "nodes": [...], "queriedLocations": [...] } }
```

**Methods**:
- Lifecycle: `ping`, `health`, `status`, `shutdown`
- Graph: `graph.query`, `graph.get`, `graph.create`, `graph.update`, `graph.delete`
- Sync: `sync.flush`, `sync.import`
- Worktree: `worktree.register`, `worktree.unregister`, `worktree.list`
- Connection: `connection.health`

#### Daemon Lifecycle

```
START:
  1. Check .git/opentasks/daemon.lock (fail if another daemon is alive)
  2. Write PID to lock file
  3. Open SQLite connections for all registered worktrees
  4. Start Unix socket server at .git/opentasks/daemon.sock
  5. Start file watchers for all locations
  6. Cache current branch from .git/HEAD

RUNNING:
  7. Handle IPC requests, routing to correct location
  8. Watch .git/HEAD for branch changes (invalidate branch cache)
  9. Debounced flush for dirty nodes across all locations

STOP:
  10. Stop accepting new connections
  11. Flush all pending writes
  12. Close SQLite connections
  13. Remove socket and lock files
```

#### Auto-Start

The daemon starts automatically on any operation that requires it:

```typescript
async function ensureDaemon(): Promise<DaemonClient> {
  const socketPath = path.join(gitDir, 'opentasks', 'daemon.sock')

  // Try connecting to existing daemon
  try {
    const client = new DaemonClient(socketPath)
    await client.ping()
    return client
  } catch {
    // Daemon not running — start it
  }

  // Fork daemon process
  const child = fork(daemonEntryPoint, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GIT_DIR: gitDir }
  })
  child.unref()

  // Wait for socket to appear
  await waitForSocket(socketPath, { timeout: 5000, retries: 10 })

  return new DaemonClient(socketPath)
}
```

### 2. Cross-Location Queries via Provider Infrastructure

Connected opentasks locations register as **providers** in the existing `ProviderRegistry`:

```typescript
function createLocationProvider(connection: Connection, db: Database): Provider {
  return {
    name: `opentasks-${connection.hash}`,
    schemes: ['opentasks'],

    capabilities: {
      read: true,
      write: connection.role !== 'readonly',
      search: true,
      watch: false,
      ready: true,
    },

    parseUri(uri: string): ParsedUri | null {
      const match = uri.match(/^opentasks:\/\/([a-z0-9]+)\/(.+)$/)
      if (match && match[1] === connection.hash) {
        return { scheme: 'opentasks', workspace: match[1], id: match[2] }
      }
      return null
    },

    async get(id: string): Promise<ProviderNode | null> {
      // In-process SQLite query (daemon holds the connection)
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
      return node ? toProviderNode(node, connection) : null
    },

    async list(filter?: ProviderFilter): Promise<ProviderNode[]> {
      // Query remote location's SQLite directly
      let query = 'SELECT * FROM nodes WHERE 1=1'
      if (filter?.status) query += ` AND status = '${filter.status}'`
      if (filter?.type) query += ` AND type = '${filter.type}'`
      return db.prepare(query).all().map(n => toProviderNode(n, connection))
    },

    async ready(): Promise<ProviderNode[]> {
      return db.prepare('SELECT * FROM ready_issues').all()
        .map(n => toProviderNode(n, connection))
    },
  }
}
```

#### Auto-Registration on Daemon Start

When the daemon starts, it registers a provider for each connected location:

```typescript
async function initializeLocationProviders(
  registry: ProviderRegistry,
  connections: Connection[]
): Promise<void> {
  for (const conn of connections) {
    const cachePath = path.join(conn.path, 'cache.db')
    if (!fs.existsSync(cachePath)) continue

    const db = new Database(cachePath, { readonly: true })
    db.pragma('journal_mode = WAL')

    const provider = createLocationProvider(conn, db)
    registry.register(provider)
  }
}
```

#### What This Gives You

The existing `HydratingFederatedGraph.ready()` query already resolves blockers via providers. With each connected location as a provider:

1. **`ready()` works across locations for free.** An issue blocked by `opentasks://k7m2x9p4/i-x7k9` resolves through the provider, just like `beads://./bd-123`.

2. **Materialization works.** Remote opentasks nodes materialize like any external node — phantom -> cached -> hydrated.

3. **No separate "expansion coordinator" needed.** The existing `NodeResolver` and `ProviderRegistry` handle everything.

### 3. Query Expansion Modes

```typescript
type ExpansionMode =
  | 'none'            // Only current location (default)
  | 'follow-refs'     // Follow outbound edge references via providers
  | 'connections'      // Query all declared connections
  | 'all'             // follow-refs + connections
```

**Simplified from the original 6 modes.** `ancestors`/`descendants`/`siblings` are dropped because the filesystem hierarchy is not a meaningful semantic relationship. The connection graph (explicit declarations) replaces it.

```typescript
// Default: isolated query
const issues = await query({ find: 'ready' })

// Follow references (resolve blockers in other locations)
const issues = await query({ find: 'ready' }, { expand: 'follow-refs' })

// Query all connected locations
const allIssues = await query({ find: 'ready' }, { expand: 'connections' })
```

#### Expansion Result

```typescript
interface ExpandedResult {
  /** Results from current location */
  local: Node[]

  /** Results from connected locations, keyed by hash */
  connected: Record<string, Node[]>

  /** Edges spanning locations */
  crossLocationEdges: Edge[]

  /** All locations queried */
  queriedLocations: string[]

  /** Locations that were unreachable */
  unreachableLocations: string[]

  /** Confidence level */
  completeness: 'full' | 'partial'
}
```

**Consistency model**: Intra-repo queries (single daemon) are strongly consistent. Inter-repo queries (different daemon) are eventually consistent. The `completeness` field indicates whether all locations responded.

### 4. Worktree CLI

```bash
# Setup a new worker worktree
opentasks worktree setup <path> [options]
  --branch <name>          # Git branch (default: creates new branch)
  --role <worker|manager>  # Role (default: worker)
  --redirect-to <target>   # Location hash or "." for current (default: current)
  --no-git-worktree        # Don't create git worktree, just configure opentasks

# List registered worktrees
opentasks worktree list
  # HASH      PATH                              BRANCH      ROLE     STATUS
  # k7m2x9p4  /home/user/repo                   main        manager  active
  # n5q1w8r3  /home/user/repo-feature-a         feature-a   worker   active
  # p2r4t6v8  /home/user/repo-feature-b         feature-b   worker   unreachable

# Teardown a worker worktree
opentasks worktree teardown <path-or-hash>
  --remove-git-worktree    # Also run git worktree remove
  --keep-data              # Don't delete .opentasks/ contents
```

#### `setup` Implementation

```typescript
async function worktreeSetup(targetPath: string, options: SetupOptions): Promise<void> {
  const managerLocation = await getCurrentLocation()

  // 1. Create git worktree (unless --no-git-worktree)
  if (!options.noGitWorktree) {
    const branch = options.branch ?? `worker-${Date.now()}`
    await exec(`git worktree add "${targetPath}" -b "${branch}"`)
  }

  // 2. Initialize .opentasks/ in the worktree
  const workerDir = path.join(targetPath, '.opentasks')
  await fs.mkdir(workerDir, { recursive: true })

  // 3. Generate location hash
  const repoRoot = await getRepoRoot()
  const relativePath = path.relative(repoRoot, workerDir)
  const workerHash = generateLocationHash(repoRoot, relativePath)

  // 4. Write worker's config.json
  const role = options.role ?? 'worker'
  const redirectTarget = options.redirectTo === '.'
    ? managerLocation.hash
    : options.redirectTo

  const config = {
    version: '1.0',
    location: { hash: workerHash, uuid: randomUUID(), name: path.basename(targetPath) },
    role,
    connections: [
      { hash: managerLocation.hash, path: path.relative(targetPath, managerLocation.path), role: 'manager' }
    ],
    redirects: role === 'worker' ? [
      {
        operations: ['read', 'write'],
        pattern: '*',
        target: `opentasks://${redirectTarget}/`,
        priority: 100,
        fallback: 'error',
      }
    ] : [],
  }
  await writeJson(path.join(workerDir, 'config.json'), config)

  // 5. Initialize empty graph.jsonl
  await writeFile(path.join(workerDir, 'graph.jsonl'), '')

  // 6. Register worktree with daemon
  const daemon = await ensureDaemon()
  await daemon.request('worktree.register', {
    path: targetPath,
    opentasksPath: workerDir,
    hash: workerHash,
    branch: options.branch,
    role,
    redirectTarget,
  })

  // 7. Add connection in manager's config.json
  await addConnection(managerLocation.configPath, {
    hash: workerHash,
    path: path.relative(path.dirname(managerLocation.configPath), workerDir),
    role: 'worker',
    name: path.basename(targetPath),
  })

  // 8. Install merge driver (if not already configured)
  await installMergeDriver(targetPath)
}
```

#### `teardown` Implementation

```typescript
async function worktreeTeardown(pathOrHash: string, options: TeardownOptions): Promise<void> {
  const daemon = await ensureDaemon()
  const worktree = await daemon.request('worktree.find', { pathOrHash })

  // 1. Flush pending writes
  await daemon.request('sync.flush', { location: worktree.opentasksPath })

  // 2. Unregister from daemon
  await daemon.request('worktree.unregister', { hash: worktree.hash })

  // 3. Remove connection from manager
  if (worktree.redirectTarget) {
    const manager = await daemon.request('worktree.find', { pathOrHash: worktree.redirectTarget })
    if (manager) {
      await removeConnection(
        path.join(manager.opentasksPath, 'config.json'),
        worktree.hash
      )
    }
  }

  // 4. Optionally remove data
  if (!options.keepData) {
    await fs.rm(worktree.opentasksPath, { recursive: true })
  }

  // 5. Optionally remove git worktree
  if (options.removeGitWorktree) {
    await exec(`git worktree remove "${worktree.path}"`)
  }
}
```

#### Worktree Registry

Stored at `.git/opentasks/worktrees.json` (shared across worktrees, daemon is sole writer):

```json
{
  "worktrees": [
    {
      "path": "/home/user/repo",
      "opentasksPath": "/home/user/repo/.opentasks/",
      "hash": "k7m2x9p4",
      "branch": "main",
      "role": "manager"
    },
    {
      "path": "/home/user/repo-feature-a",
      "opentasksPath": "/home/user/repo-feature-a/.opentasks/",
      "hash": "n5q1w8r3",
      "branch": "feature-a",
      "role": "worker",
      "redirectTarget": "k7m2x9p4"
    }
  ]
}
```

### 5. Conditional Redirect Rules

Phase 2 redirect rules are extended with conditions:

```json
{
  "redirects": [
    {
      "operations": ["write"],
      "pattern": "s-*",
      "target": "opentasks://k7m2x9p4/",
      "priority": 50,
      "fallback": "error",
      "when": {
        "role": "worker"
      }
    },
    {
      "operations": ["read"],
      "pattern": "*",
      "target": "opentasks://k7m2x9p4/",
      "priority": 100,
      "fallback": "local",
      "when": {
        "branch": "feature-*"
      }
    }
  ]
}
```

#### Conditions

| Condition | Source | Notes |
|-----------|--------|-------|
| `role` | `config.json` role field | Set by orchestrator at setup time; trusted |
| `branch` | `.git/HEAD` (cached by daemon) | Glob pattern matching |

**Agent identity is NOT a condition.** Roles are set in config by the orchestrator and are inherent to the location, not self-reported by the calling agent.

**Rule evaluation**:
1. Filter rules by matching operation (`read`/`write`)
2. Filter by matching pattern (glob against node ID)
3. Filter by matching conditions (`when` clause)
4. Sort remaining by priority (ascending)
5. First match wins
6. If no match, operate locally

**Branch caching**: The daemon watches `.git/HEAD` for changes and caches the current branch per worktree. No per-operation `git rev-parse` call.

### 6. Custom JSONL Merge Driver

Registered in `.gitattributes` and `.git/config`:

```gitattributes
# .gitattributes (committed to repo)
.opentasks/graph.jsonl merge=opentasks
```

```ini
# .git/config (or ~/.gitconfig for global)
[merge "opentasks"]
    name = OpenTasks JSONL merge driver
    driver = opentasks merge-driver %O %A %B %L %P
```

#### Merge Algorithm

The driver receives three files: base (O), ours (A), theirs (B).

```typescript
async function mergeDriver(
  basePath: string,
  oursPath: string,
  theirsPath: string
): Promise<number> {
  // 1. Parse all three versions into Maps keyed by ID
  const base = parseJsonlToMap(basePath)
  const ours = parseJsonlToMap(oursPath)
  const theirs = parseJsonlToMap(theirsPath)

  const result = new Map<string, JsonLine>()
  const allIds = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])

  for (const id of allIds) {
    const b = base.get(id)
    const o = ours.get(id)
    const t = theirs.get(id)

    // Both sides agree — take either
    if (deepEqual(o, t)) {
      if (o) result.set(id, o)
      continue
    }

    // Only theirs changed — take theirs
    if (deepEqual(b, o)) {
      if (t) result.set(id, t)
      continue
    }

    // Only ours changed — take ours
    if (deepEqual(b, t)) {
      if (o) result.set(id, o)
      continue
    }

    // Both added same ID with different content (unlikely with hash IDs)
    if (!b && o && t) {
      result.set(id, pickByNewerTimestamp(o, t))
      continue
    }

    // True conflict: base exists, both modified differently
    // Field-level merge with last-writer-wins per field
    if (b && o && t) {
      result.set(id, fieldLevelMerge(b, o, t))
      continue
    }

    // One side deleted, other modified — keep the modification
    if (!o && t) { result.set(id, t); continue }
    if (o && !t) { result.set(id, o); continue }
  }

  // 2. Write merged result to "ours" path (git convention)
  writeJsonl(oursPath, result)

  // 3. Return 0 = success (no unresolved conflicts)
  return 0
}
```

#### Field-Level Merge

Instead of treating each JSONL line as atomic, merge individual fields:

```typescript
function fieldLevelMerge(
  base: JsonLine,
  ours: JsonLine,
  theirs: JsonLine
): JsonLine {
  const result = { ...base }

  const allKeys = new Set([
    ...Object.keys(base),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ])

  for (const key of allKeys) {
    const bVal = base[key]
    const oVal = ours[key]
    const tVal = theirs[key]

    if (deepEqual(oVal, tVal)) {
      result[key] = oVal              // Both agree
    } else if (deepEqual(bVal, oVal)) {
      result[key] = tVal              // Only theirs changed this field
    } else if (deepEqual(bVal, tVal)) {
      result[key] = oVal              // Only ours changed this field
    } else {
      // Both changed this field differently — last writer wins
      const oursTime = ours.updated_at || ''
      const theirsTime = theirs.updated_at || ''
      result[key] = oursTime >= theirsTime ? oVal : tVal
    }
  }

  // Ensure updated_at is the latest
  result.updated_at = [ours.updated_at, theirs.updated_at]
    .filter(Boolean)
    .sort()
    .pop() || result.updated_at

  return result
}
```

#### Why This Works for OpenTasks

1. **New nodes never conflict** — hash-based IDs from UUIDs are unique across agents.
2. **Edges are immutable** — created or deleted, not modified. Delete-vs-keep: keep the modification.
3. **Status updates are the main conflict** — field-level last-writer-wins handles correctly (later `updated_at` wins).
4. **Append-only writes make git's job easier** — appends rarely produce line conflicts; the merge driver deduplicates.

#### Installation

Auto-installed on `opentasks init` and `opentasks worktree setup`:

```typescript
async function installMergeDriver(worktreePath: string): Promise<void> {
  // 1. Add to .gitattributes if not present
  const attrPath = path.join(worktreePath, '.gitattributes')
  const attrContent = await readOrDefault(attrPath, '')
  if (!attrContent.includes('merge=opentasks')) {
    await appendFile(attrPath,
      '\n# OpenTasks merge driver for graph.jsonl\n' +
      '.opentasks/graph.jsonl merge=opentasks\n'
    )
  }

  // 2. Configure in .git/config if not present
  const gitDir = await getGitDir(worktreePath)
  await exec(`git config merge.opentasks.name "OpenTasks JSONL merge driver"`)
  await exec(`git config merge.opentasks.driver "opentasks merge-driver %O %A %B %L %P"`)
}
```

### 7. Location Discovery (Setup Aid)

Discovery exists as a **one-time interactive command**, not a runtime mechanism:

```bash
opentasks discover [--direction ancestors|descendants|siblings|all] [--max-depth 5]
```

```
Found opentasks locations:
  1. ~/projects/.opentasks/ (hash: m3p8q2w5, name: "projects-workspace")
  2. ~/.opentasks/ (hash: r7t1v9z3, name: "global")

Connect to any? [1,2,all,none]:
```

After selection, adds entries to `config.json` connections list. All subsequent queries use the declared connections.

---

## Deliverables

### Daemon (`src/daemon/`)
- [ ] Single daemon per git repo at `.git/opentasks/daemon.sock`
- [ ] Lock file with PID for single-instance enforcement
- [ ] Multi-location SQLite connection management
- [ ] IPC protocol with `location` parameter
- [ ] Auto-start on first operation
- [ ] Graceful shutdown with final flush
- [ ] `.git/HEAD` watcher for branch caching

### Location-as-Provider (`src/providers/location.ts`)
- [ ] `createLocationProvider()` factory
- [ ] Auto-registration from connections on daemon start
- [ ] In-process SQLite queries (no IPC between locations)
- [ ] Health tracking for connected locations

### Query Expansion (`src/graph/expansion.ts`)
- [ ] `none`, `follow-refs`, `connections`, `all` modes
- [ ] `ExpandedResult` with `completeness` indicator
- [ ] Unreachable location tracking

### Worktree CLI (`src/commands/worktree.ts`)
- [ ] `opentasks worktree setup` — create + configure + register
- [ ] `opentasks worktree teardown` — flush + unregister + cleanup
- [ ] `opentasks worktree list` — show registered worktrees with status
- [ ] Worktree registry at `.git/opentasks/worktrees.json`

### Conditional Redirects (`src/core/redirects.ts`)
- [ ] `when.role` condition matching
- [ ] `when.branch` condition matching (glob)
- [ ] Branch cache integration with daemon
- [ ] Priority-based rule evaluation

### Merge Driver (`src/commands/merge-driver.ts`)
- [ ] `opentasks merge-driver` command (git merge driver interface)
- [ ] JSONL parsing and ID-keyed map construction
- [ ] Three-way merge with field-level resolution
- [ ] Last-writer-wins for conflicting fields
- [ ] Auto-installation in `opentasks init` and `opentasks worktree setup`

### Discovery (`src/commands/discover.ts`)
- [ ] Filesystem traversal (ancestors, descendants, siblings)
- [ ] Interactive connection selection
- [ ] Skip patterns (node_modules, .git, vendor, etc.)

---

## Success Criteria

Phase 3 is complete when:
1. Single daemon starts at `.git/opentasks/daemon.sock` and serves all worktrees
2. Connected locations are queryable as providers via `ProviderRegistry`
3. `query({ find: 'ready' }, { expand: 'follow-refs' })` resolves cross-location blockers
4. `opentasks worktree setup` creates a fully configured worker worktree
5. `opentasks worktree teardown` cleanly unregisters and removes worktrees
6. Conditional redirects match on `role` and `branch`
7. Custom merge driver resolves concurrent `graph.jsonl` modifications
8. `opentasks discover` finds nearby locations and offers to connect
