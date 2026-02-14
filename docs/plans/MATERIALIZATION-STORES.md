# Materialization Stores: Git-Native Archival & Rematerialization

> Tags: materialization, archival, git, remote-storage, traceability
>
> Extends: [DESIGN.md](../DESIGN.md) · [PROVIDERS.md](../PROVIDERS.md) · [ENTIRE-INTEGRATION.md](./ENTIRE-INTEGRATION.md)
>
> Depends on: Entire integration (auto-linker, watcher, provider)

## Overview

This document specifies a **pluggable archival layer** for materialized external nodes. When an Entire session ends (or at other configured lifecycle points), a full snapshot of the session, its checkpoints, edges, and provenance is archived to durable storage that survives cloning, forking, and repo transfers.

**What this provides:**

1. **Git-native local store** — Archives session snapshots as commits on an orphan branch, using git's own content-addressed storage, versioning, and deduplication
2. **Remote store interface** — Pluggable interface for non-git backends (HTTP webhooks, analytics pipelines, data warehouses)
3. **Rematerialization** — Reconstruct graph nodes from archived snapshots after clone, fork, or data loss
4. **Cross-repo traceability** — Shared archive repos aggregate session data from multiple source repos, enabling org-wide queries

**Who this serves:**

- **Agents** — Session context survives across clones and worktree setups
- **Client applications** — Queryable archive of all session history without parsing ephemeral state files
- **Users** — Complete audit trail: what happened, when, what it cost, what it touched

---

## Motivation

### The Problem

Entire session state lives in `.git/entire-sessions/*.json` — ephemeral files that are:
- Not committed to any branch
- Lost on clone
- Not queryable by external tools
- Only available while the daemon is running

The auto-linker (`entire-linker.ts:465-486`) captures minimal data on session end:

```typescript
case 'ended': {
  await store.updateNode(nodes[0].id, {
    status: 'closed',
    metadata: { phase: 'ENDED', endedAt: session.endedAt },
  })
}
```

This discards the rich session payload (token usage, files touched, checkpoint sequence, agent identity, branch context) that was available at that moment.

### Why Git as Storage

The local graph already uses JSONL inside a git repo. Building a separate append-only log format inside git is redundant — git **is** an append-only, content-addressed, version-controlled store with built-in remote sync. Using it directly means:

- **No new storage format** — JSON files in a tree, committed to an orphan branch
- **Built-in deduplication** — Git's object store handles unchanged files across commits
- **Built-in remote sync** — `git push` to any remote
- **Built-in history** — `git log` shows the archive timeline
- **Built-in access** — `git show <sha>:<path>` reads any historical state
- **Survives clone** — Orphan branches are fetched by default

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      OpenTasks Daemon                                │
│                                                                      │
│  ┌──────────────┐    ┌─────────────────────────────────────────┐    │
│  │ Entire       │    │         MaterializationArchiver          │    │
│  │ Auto-Linker  │───▶│                                         │    │
│  │              │    │  Builds snapshots from nodes + edges     │    │
│  │ (session     │    │  Fans out to enabled stores              │    │
│  │  events)     │    │  Handles errors per-store independently  │    │
│  └──────────────┘    └───────────┬─────────────────┬───────────┘    │
│                                  │                 │                 │
│                    ┌─────────────▼──────┐  ┌───────▼──────────┐     │
│                    │  GitArchiveStore   │  │  RemoteStore[]   │     │
│                    │  (local)           │  │  (pluggable)     │     │
│                    │                    │  │                  │     │
│                    │  Commits to orphan │  │  HTTP webhook    │     │
│                    │  branch in target  │  │  Analytics API   │     │
│                    │  git repo          │  │  Custom impl     │     │
│                    └────────┬───────────┘  └──────────────────┘     │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                ┌─────────────▼──────────────┐
                │   Git Repository            │
                │   (same repo or separate)   │
                │                             │
                │   Branch: opentasks/archive │
                │   ┌─────────────────────┐   │
                │   │ <graphId>/          │   │
                │   │   sessions/         │   │
                │   │     <session-id>/   │   │
                │   │       session.json  │   │
                │   │       edges.json    │   │
                │   │       checkpoints/  │   │
                │   │         cp-001.json │   │
                │   │         cp-002.json │   │
                │   └─────────────────────┘   │
                └─────────────────────────────┘
```

### Data Flow

```
1. Session event fires (checkpoint, ended, etc.)
   ┌────────────────────────────────────────────────────────────────┐
   │ EntireWatcher detects session state change                     │
   │ → Auto-Linker updates graph node (existing behavior)           │
   │ → Auto-Linker calls archiver.onEvent(node, event)     [NEW]   │
   └────────────────────────────────────────────────────────────────┘

2. Archiver builds snapshot
   ┌────────────────────────────────────────────────────────────────┐
   │ → Reads full node data from GraphStore (external_data)         │
   │ → Reads related edges (worked-on, implemented-by, contains)    │
   │ → Reads checkpoint nodes if checkpoint event                   │
   │ → Resolves provenance (git remote, graph path, graphId)        │
   │ → Assembles MaterializationSnapshot                            │
   └────────────────────────────────────────────────────────────────┘

3. Archiver fans out to stores
   ┌────────────────────────────────────────────────────────────────┐
   │ → GitArchiveStore: write files to tree, commit, optionally push│
   │ → RemoteStore[]: POST snapshot to each enabled remote          │
   │ → Errors are isolated per-store (one failure doesn't block)    │
   └────────────────────────────────────────────────────────────────┘

4. Rematerialization (on clone / on demand)
   ┌────────────────────────────────────────────────────────────────┐
   │ → Daemon startup detects missing nodes (URIs in edges but no   │
   │   corresponding ExternalNode)                                  │
   │ → GitArchiveStore.retrieve(uri) reads from orphan branch       │
   │ → Archiver reconstructs ExternalNode + edges in GraphStore     │
   └────────────────────────────────────────────────────────────────┘
```

---

## Store Taxonomy

Two categories, one shared base interface:

```
MaterializationStore (base interface)
  │
  ├── GitArchiveStore (built-in)
  │     One implementation, configurable target repo
  │     Local orphan branch + optional git push
  │     Handles both "local" and "remote" via git remotes
  │
  └── RemoteStore (interface for non-git backends)
        Must be implemented by plugins/extensions
        Receives snapshots, returns them on query
        Examples: HTTP webhook, analytics pipeline
```

`GitArchiveStore` is the primary store — always available, zero external dependencies. Remote stores are optional and additive.

---

## Snapshot Format

### MaterializationSnapshot

The unit of archival. Self-contained — everything needed to reconstruct the node and its relationships without access to the original system.

```typescript
interface MaterializationSnapshot {
  /** Schema version for forward compatibility */
  version: 1

  /** Canonical URI of the archived entity */
  uri: string                              // entire://session/2026-02-14-abc123

  /** Provider source */
  source: string                           // "entire"

  /** Entity type within the source */
  entityType: 'session' | 'checkpoint'

  /** When the original entity was created */
  createdAt: string                        // ISO 8601

  /** When this snapshot was captured */
  archivedAt: string                       // ISO 8601

  /** Complete node data for reconstruction */
  node: {
    title: string
    content?: string
    status: string
    external_status?: string
    external_data: Record<string, unknown>
    tags?: string[]
  }

  /** Provenance — where this data came from */
  provenance: {
    /** Configured graph ID (namespace in archive) */
    graphId: string

    /** Absolute path to .opentasks/ directory at archive time */
    graphPath: string

    /** Git remote URL (if available) */
    gitRemote?: string

    /** Git branch the session operated on */
    gitBranch?: string

    /** Git commit SHA at archive time */
    gitHead?: string
  }
}
```

### SessionSnapshot (extends MaterializationSnapshot for sessions)

```typescript
interface SessionSnapshot extends MaterializationSnapshot {
  entityType: 'session'

  /** Related edges at archive time */
  edges: Array<{
    fromUri: string                        // task URI or session URI
    toUri: string                          // session URI or checkpoint URI
    edgeType: string                       // 'worked-on' | 'implemented-by' | 'contains'
    metadata?: Record<string, unknown>     // correlation context
  }>

  /** Checkpoint IDs that belong to this session */
  checkpointIds: string[]
}
```

### CheckpointSnapshot (extends MaterializationSnapshot for checkpoints)

```typescript
interface CheckpointSnapshot extends MaterializationSnapshot {
  entityType: 'checkpoint'

  /** The code commit this checkpoint corresponds to */
  codeCommit?: string

  /** The session this checkpoint belongs to */
  sessionUri: string
}
```

---

## Git Archive Store

### Tree Layout

The archive lives on an orphan branch. The tree is namespaced by `graphId` to support multi-repo archives.

```
opentasks/archive (orphan branch)
│
├── <graphId>/
│   ├── sessions/
│   │   ├── <session-id>/
│   │   │   ├── session.json                 # SessionSnapshot
│   │   │   ├── edges.json                   # Edge snapshots (denormalized)
│   │   │   └── checkpoints/
│   │   │       ├── <checkpoint-id>.json     # CheckpointSnapshot
│   │   │       └── <checkpoint-id>.json
│   │   │
│   │   └── <session-id>/
│   │       ├── session.json
│   │       ├── edges.json
│   │       └── checkpoints/
│   │           └── ...
│   │
│   └── manifest.json                        # Index of all sessions (optional optimization)
│
└── <other-graphId>/                         # Another repo's sessions
    └── sessions/
        └── ...
```

### Commit Strategy

Each archive event produces one commit on the orphan branch:

```
Commit: "archive: <graphId> session <session-id> ended"

  Modified:
    <graphId>/sessions/<session-id>/session.json     (updated: phase → ENDED, final token usage)
    <graphId>/sessions/<session-id>/edges.json       (updated: any new edges)

Commit: "archive: <graphId> session <session-id> checkpoint <cp-id>"

  Added:
    <graphId>/sessions/<session-id>/checkpoints/<cp-id>.json
  Modified:
    <graphId>/sessions/<session-id>/session.json     (updated: checkpoint list)
    <graphId>/sessions/<session-id>/edges.json       (updated: new implemented-by edge)

Commit: "archive: <graphId> session <session-id> started"

  Added:
    <graphId>/sessions/<session-id>/session.json     (initial snapshot)
    <graphId>/sessions/<session-id>/edges.json       (initial worked-on edges)
```

### Loading from a Specific Point

Because each checkpoint has a corresponding code commit SHA stored in `CheckpointSnapshot.codeCommit`, you can correlate archive state to code state:

```typescript
// "What was the session state at code commit fa3bc91?"
const checkpoint = await archiveStore.findByCodeCommit('fa3bc91')
// → reads the archive commit that contains this checkpoint
// → git show <archive-commit>:<graphId>/sessions/<id>/session.json
//   gives the session state at that point in time

// "Show me everything about checkpoint cp-002"
const snapshot = await archiveStore.getCheckpoint('session-abc', 'cp-002')
// → git log opentasks/archive -- <graphId>/sessions/session-abc/checkpoints/cp-002.json
// → git show <first-commit>:<path>

// "What did the session look like after checkpoint cp-002?"
const sessionAtCp = await archiveStore.getSessionAt('session-abc', { afterCheckpoint: 'cp-002' })
// → finds the archive commit that added cp-002.json
// → reads session.json from that same commit
```

### Separate Repo Target

The archive branch doesn't have to live in the source repo. Configuration determines the target:

**Same repo (default):**
```
Commits go to local orphan branch `opentasks/archive`
Optional: push to origin
```

**Separate repo:**
```
git remote add opentasks-archive git@github.com:my-org/opentasks-archive.git
Commits go to local orphan branch, push to opentasks-archive remote
```

**The GitArchiveStore always commits locally first** (fast, works offline). Pushing to a remote is a separate, optional step that can fail without losing data.

Implementation:

```typescript
interface GitArchiveStoreConfig {
  /** Branch name for the archive (default: 'opentasks/archive') */
  branch: string

  /** Git remote name to push to (default: none — local only) */
  remote?: string

  /**
   * For separate archive repos: path to the git repo.
   * If set, commits go to this repo instead of the source repo.
   * Can be a local path or will be cloned from remote on first use.
   */
  repoPath?: string

  /** Push after every commit, or batch (default: 'on-session-end') */
  pushPolicy: 'immediate' | 'on-session-end' | 'manual'
}
```

When `repoPath` is set, the store operates on a separate git working tree:

```
1. On initialization:
   - If repoPath exists and is a git repo → use it
   - If repoPath doesn't exist but remote is set → clone from remote
   - If neither → create a bare repo at repoPath

2. On archive:
   - Checkout orphan branch in the archive repo
   - Write files under <graphId>/sessions/...
   - Commit
   - Push to remote (if configured and pushPolicy allows)
```

---

## Multi-Repo Support

### The Problem

When a single archive repo receives data from multiple source repos, sessions from different repos must not collide.

### graphId Resolution

Each source repo needs a unique namespace in the archive tree. The `graphId` is resolved with a fallback chain:

```typescript
function resolveGraphId(config: OpenTasksConfig, gitDir: string): string {
  // 1. Explicit config (highest priority)
  if (config.materialization?.graphId) {
    return config.materialization.graphId
  }

  // 2. Location name from existing config
  if (config.location?.name) {
    return slugify(config.location.name)
  }

  // 3. Derive from git remote URL
  const remoteUrl = getGitRemoteUrl(gitDir, 'origin')
  if (remoteUrl) {
    // github.com/my-org/my-repo → my-org--my-repo
    return slugifyRemoteUrl(remoteUrl)
  }

  // 4. Derive from directory name
  const repoRoot = path.dirname(gitDir)
  return slugify(path.basename(repoRoot))
}
```

The resolved `graphId` is written back to config on first archive (so it's stable):

```json
{
  "materialization": {
    "graphId": "my-org--payments-service"
  }
}
```

### Cross-Repo Queries

With a shared archive repo, queries can span all contributing repos:

```typescript
// List all graphs in the archive
await archiveStore.listGraphs()
// → ['my-org--payments-service', 'my-org--auth-service', 'my-org--gateway']

// List sessions across all graphs
await archiveStore.listSessions({ graphId: '*' })

// Total token usage across the org this week
await archiveStore.listSessions({
  graphId: '*',
  archivedAfter: '2026-02-07T00:00:00Z',
})
// → aggregate tokenUsage from each session's external_data
```

### Concurrent Multi-Repo Pushes

Multiple source repos may push to the same archive remote concurrently. Since each repo writes under its own `<graphId>/` prefix, tree paths don't overlap. The push flow handles conflicts:

```
1. Fetch latest opentasks/archive from remote
2. Checkout the tree
3. Write changes under our graphId/ prefix only
4. Commit
5. Push
   → If rejected (someone else pushed):
     a. Fetch again
     b. Rebase our commit (safe — paths don't overlap)
     c. Push again
     d. Retry up to 3 times
```

This is the same pattern used by CI systems pushing to `gh-pages` from concurrent jobs.

---

## Remote Store Interface

For non-git backends. Receives the same snapshot data, different transport.

```typescript
interface RemoteStore {
  /** Store identifier */
  readonly name: string

  /** Store type (for factory resolution) */
  readonly type: string

  /** Whether this store is currently enabled */
  readonly enabled: boolean

  // =========================================================================
  // Write Path
  // =========================================================================

  /**
   * Archive a single snapshot.
   * Called by the MaterializationArchiver on each archive event.
   */
  archive(snapshot: MaterializationSnapshot): Promise<RemoteArchiveResult>

  /**
   * Archive multiple snapshots in a batch.
   * Used for bulk operations (e.g., initial archive of existing sessions).
   */
  archiveBatch(snapshots: MaterializationSnapshot[]): Promise<RemoteBatchResult>

  // =========================================================================
  // Read Path
  // =========================================================================

  /**
   * Retrieve a snapshot by URI.
   * Returns the most recent snapshot for the URI, or null if not found.
   */
  retrieve(uri: string): Promise<MaterializationSnapshot | null>

  /**
   * List available snapshots with optional filtering.
   */
  list(filter?: RemoteStoreFilter): Promise<RemoteStoreEntry[]>

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Initialize the store (validate credentials, create buckets, etc.) */
  initialize(): Promise<void>

  /** Gracefully shut down (flush buffers, close connections) */
  close(): Promise<void>

  /** Health check */
  status(): Promise<RemoteStoreStatus>
}

interface RemoteArchiveResult {
  stored: boolean
  uri: string
  error?: string
}

interface RemoteBatchResult {
  results: RemoteArchiveResult[]
  successCount: number
  failureCount: number
}

interface RemoteStoreFilter {
  source?: string
  graphId?: string
  entityType?: 'session' | 'checkpoint'
  archivedAfter?: string
  archivedBefore?: string
  uriPattern?: string
}

interface RemoteStoreEntry {
  uri: string
  entityType: string
  archivedAt: string
  graphId: string
}

interface RemoteStoreStatus {
  healthy: boolean
  message?: string
  lastArchiveAt?: string
  lastError?: string
}
```

### Example: HTTP Webhook Remote Store

```typescript
// Configured in .opentasks/config.json:
{
  "materialization": {
    "remoteStores": [
      {
        "type": "http",
        "name": "analytics",
        "enabled": true,
        "config": {
          "url": "https://analytics.internal/opentasks/ingest",
          "headers": { "Authorization": "Bearer ${OPENTASKS_ANALYTICS_TOKEN}" },
          "events": ["session.ended"],
          "timeout": 10000
        }
      }
    ]
  }
}

// Implementation POSTs the snapshot as JSON:
// POST https://analytics.internal/opentasks/ingest
// Content-Type: application/json
// { "version": 1, "uri": "entire://session/...", "node": {...}, ... }
```

---

## Materialization Archiver

Coordinator between the daemon's event handlers and the stores.

### Interface

```typescript
interface MaterializationArchiver {
  /**
   * Called by the auto-linker when a session lifecycle event occurs.
   * Builds snapshot and fans out to all enabled stores.
   */
  onSessionEvent(
    event: EntireSessionEvent,
    sessionNode: ExternalNode,
    store: GraphStore
  ): Promise<ArchiveEventResult>

  /**
   * Manually archive a specific node (CLI / IPC).
   */
  archiveNode(
    nodeId: string,
    store: GraphStore
  ): Promise<ArchiveEventResult>

  /**
   * Rematerialize a node from the archive into the graph.
   * Tries GitArchiveStore first, then remote stores in order.
   */
  rematerialize(
    uri: string,
    store: GraphStore
  ): Promise<ExternalNode | null>

  /**
   * Rematerialize all nodes that have edges but no corresponding
   * ExternalNode in the graph (e.g., after clone).
   */
  rematerializeAll(store: GraphStore): Promise<RematerializeAllResult>

  /**
   * List all archived sessions (across all stores).
   */
  listArchived(filter?: ArchiveListFilter): Promise<ArchiveListEntry[]>
}

interface ArchiveEventResult {
  uri: string
  stores: Array<{
    storeName: string
    stored: boolean
    error?: string
  }>
}

interface RematerializeAllResult {
  restored: number
  failed: number
  skipped: number
  errors: Array<{ uri: string; error: string }>
}

interface ArchiveListFilter {
  graphId?: string
  source?: string
  status?: string
  archivedAfter?: string
  archivedBefore?: string
}

interface ArchiveListEntry {
  uri: string
  entityType: string
  graphId: string
  archivedAt: string
  storeName: string
  title?: string
  status?: string
}
```

### Snapshot Assembly

The archiver builds snapshots by reading from the GraphStore:

```typescript
async function buildSessionSnapshot(
  sessionNode: ExternalNode,
  store: GraphStore,
  config: ArchiveConfig
): Promise<SessionSnapshot> {
  // 1. Read all edges involving this session node
  const edges = await store.query.edges({
    nodeId: sessionNode.id,
  })

  // 2. Map edges to URI-based representation (portable across graphs)
  const edgeSnapshots = edges.map(edge => ({
    fromUri: resolveNodeUri(edge.from_id, store),
    toUri: resolveNodeUri(edge.to_id, store),
    edgeType: edge.type,
    metadata: edge.metadata,
  }))

  // 3. Collect checkpoint IDs from edges
  const checkpointIds = edges
    .filter(e => e.type === 'contains')
    .map(e => extractCheckpointId(e.to_id, store))

  // 4. Build provenance
  const provenance = await resolveProvenance(config)

  return {
    version: 1,
    uri: sessionNode.uri,
    source: sessionNode.source,
    entityType: 'session',
    createdAt: sessionNode.created_at,
    archivedAt: new Date().toISOString(),
    node: {
      title: sessionNode.title,
      content: sessionNode.content,
      status: sessionNode.status,
      external_status: sessionNode.external_status,
      external_data: sessionNode.external_data ?? {},
      tags: sessionNode.tags,
    },
    edges: edgeSnapshots,
    checkpointIds,
    provenance,
  }
}
```

### Fan-Out Strategy

```typescript
async function fanOut(
  snapshot: MaterializationSnapshot,
  stores: MaterializationStore[]
): Promise<ArchiveEventResult> {
  // Archive to all stores in parallel, isolate failures
  const results = await Promise.allSettled(
    stores
      .filter(s => s.enabled)
      .map(async (store) => ({
        storeName: store.name,
        ...(store.type === 'git'
          ? await (store as GitArchiveStore).archive(snapshot)
          : await (store as RemoteStore).archive(snapshot)),
      }))
  )

  return {
    uri: snapshot.uri,
    stores: results.map(r =>
      r.status === 'fulfilled'
        ? r.value
        : { storeName: 'unknown', stored: false, error: r.reason?.message }
    ),
  }
}
```

---

## Rematerialization

### On-Demand

When a query references a URI with no corresponding ExternalNode in the graph:

```typescript
// In query resolution or explicit request:
const node = await store.query.nodeByUri(uri)
if (!node && archiver) {
  const restored = await archiver.rematerialize(uri, store)
  // restored is now in the GraphStore, queryable normally
}
```

### On Startup (Optional)

When the daemon starts, it can scan for "orphaned edges" — edges that reference URIs with no corresponding node — and backfill from the archive:

```typescript
// In daemon initialization, after store is loaded:
if (config.materialization?.rematerializeOnStartup) {
  const orphanedUris = await findOrphanedEdgeTargets(store)
  for (const uri of orphanedUris) {
    await archiver.rematerialize(uri, store)
  }
}
```

This is opt-in because it could be slow for large archives and the user may prefer on-demand.

### Retrieval Priority

When rematerializing, stores are tried in order:

1. **GitArchiveStore** (local branch — fastest, always tried first)
2. **GitArchiveStore** (fetch from remote — if local doesn't have it)
3. **RemoteStore[]** (in config order — fallback)

---

## Archive Policies

Control **when** archival happens:

```typescript
interface ArchivePolicy {
  /**
   * Archive when a session starts.
   * Captures initial state (agent, branch, base commit).
   * Default: false
   */
  archiveOnStart: boolean

  /**
   * Archive on each checkpoint.
   * Creates a commit per checkpoint with the new checkpoint file.
   * Default: true (when strategy is 'eager')
   */
  archiveOnCheckpoint: boolean

  /**
   * Archive when a session ends.
   * Captures final state (total token usage, all files touched, end time).
   * Default: true
   */
  archiveOnEnd: boolean

  /**
   * Full materialization before archiving.
   * When true, fetches complete data from the Entire provider (including
   * transcript references) before archiving. When false, archives only
   * what's already in the GraphStore.
   * Default: true for 'eager', false for others
   */
  materializeBeforeArchive: boolean
}
```

The archive policy interacts with the existing `MaterializationStrategy`:

| Strategy | Default archive behavior |
|----------|------------------------|
| `eager` | Archive on start + checkpoint + end. Full materialization. |
| `lazy` | Archive on end only. Use existing graph data. |
| `on-demand` | No automatic archival. Manual via CLI/IPC only. |
| `none` | No archival. |

---

## Configuration

### Config Schema Addition

```typescript
// In src/config/schema.ts

const GitArchiveConfigSchemaInner = z.object({
  /** Enable git-based archival */
  enabled: z.boolean().default(false),

  /** Branch name for archive commits */
  branch: z.string().default('opentasks/archive'),

  /**
   * Git remote to push archive branch to.
   * If not set, archive stays local only.
   */
  remote: z.string().optional(),

  /**
   * Path to a separate git repo for the archive.
   * If not set, uses the source repo.
   */
  repoPath: z.string().optional(),

  /**
   * When to push to remote.
   * - 'on-session-end': push after each session ends
   * - 'immediate': push after every archive commit
   * - 'manual': never auto-push, user runs opentasks archive push
   */
  pushPolicy: z.enum(['immediate', 'on-session-end', 'manual']).default('on-session-end'),
})

const RemoteStoreConfigSchema = z.object({
  /** Store type (resolved by factory) */
  type: z.string(),

  /** Human-readable name */
  name: z.string(),

  /** Whether this store is active */
  enabled: z.boolean().default(true),

  /** Store-specific configuration */
  config: z.record(z.unknown()).default({}),

  /** Which events trigger archival to this store */
  events: z.array(z.enum([
    'session.started',
    'session.checkpoint',
    'session.ended',
  ])).default(['session.ended']),
})

const MaterializationArchiveConfigSchemaInner = z.object({
  /**
   * Graph ID — namespace in the archive tree.
   * Auto-derived from git remote URL or directory name if not set.
   */
  graphId: z.string().optional(),

  /** Git archive store configuration */
  git: GitArchiveConfigSchema,

  /** Remote (non-git) store configurations */
  remoteStores: z.array(RemoteStoreConfigSchema).default([]),

  /** Archive policy overrides */
  policy: z.object({
    archiveOnStart: z.boolean().default(false),
    archiveOnCheckpoint: z.boolean().default(true),
    archiveOnEnd: z.boolean().default(true),
    materializeBeforeArchive: z.boolean().default(true),
  }).default({}),

  /**
   * Restore missing nodes from archive on daemon startup.
   * Scans for edges referencing URIs with no corresponding node.
   */
  rematerializeOnStartup: z.boolean().default(false),
})
```

### Config File Examples

**Minimal (local archive in same repo):**
```json
{
  "materialization": {
    "git": {
      "enabled": true
    }
  }
}
```

**With remote push:**
```json
{
  "materialization": {
    "git": {
      "enabled": true,
      "remote": "origin",
      "pushPolicy": "on-session-end"
    }
  }
}
```

**Separate archive repo:**
```json
{
  "materialization": {
    "graphId": "payments-service",
    "git": {
      "enabled": true,
      "repoPath": "/shared/opentasks-archive",
      "remote": "origin",
      "pushPolicy": "on-session-end"
    }
  }
}
```

**Multi-repo org setup with analytics webhook:**
```json
{
  "materialization": {
    "graphId": "payments-service",
    "git": {
      "enabled": true,
      "remote": "opentasks-archive",
      "pushPolicy": "on-session-end"
    },
    "remoteStores": [
      {
        "type": "http",
        "name": "analytics",
        "enabled": true,
        "config": {
          "url": "https://analytics.internal/opentasks/ingest",
          "headers": { "Authorization": "Bearer ${OPENTASKS_ANALYTICS_TOKEN}" }
        },
        "events": ["session.ended"]
      }
    ],
    "policy": {
      "archiveOnCheckpoint": true,
      "archiveOnEnd": true,
      "materializeBeforeArchive": true
    },
    "rematerializeOnStartup": true
  }
}
```

---

## Integration Points

### What Changes

| File | Action | Description |
|------|--------|-------------|
| `src/config/schema.ts` | Edit | Add `MaterializationArchiveConfigSchema` to root config |
| `src/materialization/types.ts` | Create | Snapshot types, store interfaces, archiver interface |
| `src/materialization/archiver.ts` | Create | MaterializationArchiver implementation |
| `src/materialization/snapshot.ts` | Create | Snapshot assembly from GraphStore nodes/edges |
| `src/materialization/git-archive-store.ts` | Create | GitArchiveStore implementation |
| `src/materialization/remote-store.ts` | Create | RemoteStore base, HTTP remote store |
| `src/materialization/graph-id.ts` | Create | graphId resolution logic |
| `src/materialization/index.ts` | Create | Public exports |
| `src/daemon/location-state.ts` | Edit | Wire archiver into LocationState, add to create/destroy |
| `src/daemon/entire-linker.ts` | Edit | Call archiver in `ended`, `checkpoint`, `started` handlers |
| `src/daemon/methods/` | Edit | Add IPC methods: `archive.list`, `archive.rematerialize` |

### What Doesn't Change

- `src/graph/store.ts` — GraphStore untouched
- `src/storage/` — Storage layer untouched
- `src/providers/materialization.ts` — Existing MaterializationManager untouched (archiver is complementary)
- `src/providers/types.ts` — Provider interface untouched
- `src/providers/entire.ts` — Entire provider untouched
- `src/daemon/entire-watcher.ts` — Watcher untouched
- JSONL format — No schema changes

### Wiring in Location State

```typescript
// In src/daemon/location-state.ts, within createLocationState():

// Initialize MaterializationArchiver (if configured)
let archiver: MaterializationArchiver | undefined

if (config.materialization?.git?.enabled) {
  const gitArchiveStore = createGitArchiveStore({
    branch: config.materialization.git.branch,
    remote: config.materialization.git.remote,
    repoPath: config.materialization.git.repoPath,
    pushPolicy: config.materialization.git.pushPolicy,
    sourceRepoPath: opentasksPath,
  })

  const remoteStores = createRemoteStoresFromConfig(
    config.materialization.remoteStores ?? []
  )

  archiver = createMaterializationArchiver({
    gitStore: gitArchiveStore,
    remoteStores,
    policy: config.materialization.policy,
    graphId: resolveGraphId(config, gitDir),
  })

  await archiver.initialize()
}

// Pass archiver to auto-linker
entireLinker = createEntireAutoLinker({
  store,
  flushManager,
  archiver,  // ← NEW optional dependency
})
```

### Auto-Linker Changes

```typescript
// In src/daemon/entire-linker.ts, case 'ended':

case 'ended': {
  try {
    const nodes = await store.query.nodes({
      type: 'external',
      search: `entire://session/${sessionId}`,
      limit: 1,
    })

    if (nodes.length > 0) {
      // Existing: update status
      await store.updateNode(nodes[0].id, {
        status: 'closed',
        metadata: { phase: 'ENDED', endedAt: session.endedAt },
      })
      flushManager.markDirty(nodes[0].id)
      flushManager.schedule()

      // NEW: archive if configured
      if (archiver && archivePolicy.archiveOnEnd) {
        await archiver.onSessionEvent(event, nodes[0] as ExternalNode, store)
      }
    }
  } catch {
    // Best-effort
  }
  break
}
```

---

## CLI / IPC Interface

### IPC Methods

New daemon RPC methods for archive operations:

```typescript
// archive.list — List archived sessions
{
  method: 'archive.list',
  params: {
    graphId?: string,      // filter by graph
    source?: string,       // filter by provider source
    limit?: number,
  },
  result: ArchiveListEntry[]
}

// archive.rematerialize — Restore a node from archive
{
  method: 'archive.rematerialize',
  params: {
    uri: string,           // URI to restore
  },
  result: { restored: boolean, nodeId?: string, error?: string }
}

// archive.rematerializeAll — Restore all missing nodes
{
  method: 'archive.rematerializeAll',
  params: {},
  result: RematerializeAllResult
}

// archive.push — Manually push archive to remote
{
  method: 'archive.push',
  params: {},
  result: { pushed: boolean, commits: number, error?: string }
}
```

### CLI Commands

```bash
# List archived sessions
opentasks archive list
opentasks archive list --graph payments-service

# Restore a specific session
opentasks archive restore entire://session/2026-02-14-abc123

# Restore all missing nodes
opentasks archive restore --all

# Push archive to remote
opentasks archive push

# Show archive status
opentasks archive status
```

---

## Edge Cases & Design Decisions

### Archive repo doesn't exist yet

On first archive, if `repoPath` is set but doesn't exist:
- If `remote` is also set → `git clone --bare <remote> <repoPath>`
- If no `remote` → `git init --bare <repoPath>`

### Push fails (network error)

Archive commit is preserved locally. Next successful push will include all unpushed commits. The archive is never lost due to a push failure.

### Concurrent sessions

Each session gets its own directory in the tree. Concurrent sessions produce interleaved commits on the archive branch, but each commit only modifies files under its own session directory.

### Session spans multiple checkpoints rapidly

Each checkpoint produces a separate archive commit. Git's object deduplication handles the repeated session.json efficiently (only the diff is stored).

### graphId collision

If two repos derive the same graphId (e.g., both named "api"), their archives would collide in a shared repo. The daemon logs a warning if it detects existing data under its graphId that doesn't match its provenance. Users should set explicit graphIds for shared archives.

### Large transcript data

Entire checkpoint transcripts can be large. The `materializeBeforeArchive` policy controls whether full transcript data is fetched. When false, only what's already in `external_data` (typically metadata, not full transcripts) is archived. When true, the provider is queried for complete data before archiving.

### Orphan branch not fetched on clone

By default, `git clone` fetches all branches including orphan branches. However, `git clone --single-branch` would miss it. The archive branch name (`opentasks/archive`) should be documented. Users of `--single-branch` need to explicitly fetch: `git fetch origin opentasks/archive`.

### Existing sessions at daemon startup

When the daemon starts with archival enabled for the first time, there may be existing sessions in the graph that were never archived. The daemon does **not** retroactively archive these — it only archives events going forward. Users can manually trigger: `opentasks archive --backfill`.

---

## Testing Strategy

### Unit Tests

**Snapshot assembly:**
- Build SessionSnapshot from mock GraphStore data
- Build CheckpointSnapshot
- Provenance resolution (with/without git remote)
- graphId derivation (explicit, from remote URL, from directory name)
- Edge URI mapping (internal IDs → URIs)

**GitArchiveStore:**
- Create orphan branch
- Commit session files to tree
- Read session from specific commit
- Read session at checkpoint point-in-time
- Multi-graphId tree layout
- Push flow (with mock git commands)
- Conflict resolution on concurrent push

**MaterializationArchiver:**
- Fan-out to multiple stores (success, partial failure, total failure)
- Policy enforcement (archiveOnEnd, archiveOnCheckpoint, etc.)
- Rematerialization from archive → GraphStore
- Orphaned edge detection for rematerializeAll

**RemoteStore (HTTP):**
- POST snapshot to webhook
- Error handling (timeout, 4xx, 5xx)
- Event filtering (only archive on configured events)

### Integration Tests

- Full flow: session starts → checkpoint → session ends → verify archive branch
- Clone repo → rematerialize → verify nodes restored
- Multi-repo → shared archive → cross-repo query
- Daemon startup with `rematerializeOnStartup: true`
- Daemon startup without materialization configured (graceful skip)

---

## Implementation Phases

### Phase 1: Core Infrastructure

1. Snapshot types and assembly (`src/materialization/types.ts`, `snapshot.ts`)
2. GitArchiveStore — same-repo orphan branch (`git-archive-store.ts`)
3. MaterializationArchiver — coordinator with fan-out (`archiver.ts`)
4. Wire into auto-linker `ended` handler
5. Wire into LocationState create/destroy
6. graphId resolution (`graph-id.ts`)

**Delivers:** Sessions are archived to a local orphan branch on end.

### Phase 2: Rematerialization

1. `rematerialize()` — single node restore from archive
2. `rematerializeAll()` — orphaned edge scan + bulk restore
3. Optional `rematerializeOnStartup` config
4. IPC methods for archive operations

**Delivers:** Nodes can be restored after clone.

### Phase 3: Remote & Multi-Repo

1. Separate repo target (`repoPath` config)
2. Push to remote (with retry and conflict resolution)
3. RemoteStore interface + HTTP webhook implementation
4. Cross-repo queries in shared archive
5. CLI commands (`opentasks archive list/restore/push/status`)

**Delivers:** Org-wide archival and traceability.

### Phase 4: Eager Lifecycle

1. `archiveOnStart` — capture initial session state
2. `archiveOnCheckpoint` — incremental archive per checkpoint
3. `materializeBeforeArchive` — full data fetch before archive
4. Point-in-time queries (session state at specific checkpoint/commit)

**Delivers:** Full session timeline in archive, loadable at any point.

---

## References

### Internal

- [DESIGN.md](../DESIGN.md) — Core architecture (materialization lifecycle)
- [PROVIDERS.md](../PROVIDERS.md) — Provider system
- [ENTIRE-INTEGRATION.md](./ENTIRE-INTEGRATION.md) — Entire auto-linker and watcher
- [PERSISTENCE.md](../PERSISTENCE.md) — Storage architecture

### Existing Code

- `src/providers/materialization.ts` — MaterializationManager (strategies, staleness, background sync)
- `src/providers/types.ts` — MaterializationConfig, MaterializationStrategy
- `src/daemon/entire-linker.ts` — Auto-linker event handlers (integration point)
- `src/daemon/location-state.ts` — LocationState factory (wiring point)
- `src/config/schema.ts` — Config schema (extension point)
