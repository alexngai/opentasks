# Materialization Stores

Pluggable archival layer for materialized external node snapshots. When an Entire session ends (or at other configured lifecycle points), a full snapshot of the session — its checkpoints, edges, and provenance — is archived to durable storage that survives cloning, forking, and repo transfers.

## What this provides

1. **Git-native local store** — Archives session snapshots as commits on an orphan branch (`opentasks/archive`), using git's content-addressed storage for deduplication and versioning
2. **Remote store interface** — Pluggable backends for non-git storage (HTTP webhooks, analytics pipelines, data warehouses)
3. **Rematerialization** — Reconstruct graph nodes from archived snapshots after clone, fork, or data loss
4. **Cross-repo traceability** — Shared archive repos can aggregate session data from multiple source repos

## Architecture

```
EntireAutoLinker
  │  (session lifecycle events)
  ▼
MaterializationArchiver
  │  Builds snapshots from GraphStore nodes + edges
  │  Fans out to all enabled stores (errors isolated per-store)
  │
  ├──▶ GitArchiveStore (local orphan branch)
  │      Commits to opentasks/archive branch
  │      Optional push to remote
  │
  └──▶ RemoteStore[] (pluggable)
         HTTP webhook, analytics API, custom implementations
```

## File overview

| File | Purpose |
|---|---|
| `types.ts` | All type definitions — snapshots, store interfaces, policies, config |
| `index.ts` | Public API barrel file |
| `archiver.ts` | `MaterializationArchiver` — coordinates between event sources and stores |
| `snapshot.ts` | Snapshot assembly — builds self-contained snapshots from graph nodes/edges |
| `git-archive-store.ts` | `GitArchiveStore` — git orphan branch archive using plumbing commands |
| `http-remote-store.ts` | `HttpRemoteStore` — POSTs snapshots to an HTTP endpoint |
| `remote-store-factory.ts` | Factory + registry for creating remote stores from config |
| `graph-id.ts` | Graph ID resolution with 4-level fallback chain |

## Key concepts

### Snapshots

A `MaterializationSnapshot` is a self-contained record with everything needed to reconstruct a node:

- **URI** — canonical identifier (`entire://session/<id>` or `entire://checkpoint/<id>`)
- **Node data** — title, content, status, external_data, tags
- **Provenance** — graphId, graphPath, git remote/branch/HEAD at archive time

Specialized variants: `SessionSnapshot` (adds edges + checkpoint IDs) and `CheckpointSnapshot` (adds code commit correlation + parent session URI).

### Git archive store

Uses pure git plumbing (no working tree) to commit snapshots:

1. `git hash-object -w` — write snapshot JSON as a blob
2. `git update-index` — add blob to a temporary index
3. `git write-tree` — create a tree object
4. `git commit-tree` — commit with explicit parent tracking
5. `git update-ref` — advance the branch ref

Tree layout inside the archive branch:
```
<graphId>/
  sessions/
    <session-id>/
      session.json
      edges.json
      checkpoints/
        <checkpoint-id>.json
```

Supports pushing to a remote with configurable policy (`immediate`, `on-session-end`, `manual`) and automatic conflict resolution via fetch + rebase.

### Remote stores

Non-git backends that implement the `RemoteStore` interface (extends `MaterializationStore` with event filtering). The built-in `http` / `webhook` type POSTs snapshot JSON to a URL with configurable headers, timeout, and batch mode.

Custom store types can be registered:
```typescript
registerRemoteStoreFactory('mytype', createMyStore)
```

### Graph ID resolution

Determines the namespace for archive paths. Fallback chain:

1. Explicit config (`materialization.graphId`)
2. Location name from config
3. Slugified git remote URL (e.g., `github.com:org/repo` -> `org--repo`)
4. Slugified directory name

### Archive policy

Controls when archival happens:

| Policy | Default | Description |
|---|---|---|
| `archiveOnStart` | `false` | Archive when a session starts |
| `archiveOnCheckpoint` | `true` | Archive on each checkpoint |
| `archiveOnEnd` | `true` | Archive when a session ends |
| `materializeBeforeArchive` | `true` | Fetch fresh data from provider before building snapshot |

### Rematerialization

When the daemon detects missing nodes (URIs referenced in edges but no corresponding node), it can reconstruct them from the git archive:

1. `GitArchiveStore.retrieve(uri)` reads the snapshot from the orphan branch
2. `Archiver.rematerialize()` recreates the `ExternalNode` in the graph

`rematerializeAll()` scans for all orphaned edge references and restores them in bulk.

## Configuration

Minimal (local archive in same repo):
```json
{
  "materialization": {
    "git": { "enabled": true }
  }
}
```

With remote push and HTTP webhook:
```json
{
  "materialization": {
    "graphId": "payments-service",
    "git": {
      "enabled": true,
      "remote": "origin",
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
    ]
  }
}
```

## Integration points

- **`src/daemon/entire-linker.ts`** — Auto-linker calls `archiver.onSessionEvent()` on session lifecycle events
- **`src/daemon/location-state.ts`** — Creates and wires the archiver during daemon startup
- **`src/graph/store.ts`** — Queries nodes/edges for snapshot building and reconstruction
- **`src/providers/materialization.ts`** — Provider for `materializeBeforeArchive` (fetches fresh external data)
- **`src/config/schema.ts`** — Config validation for materialization settings
