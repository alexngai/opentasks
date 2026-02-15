# Materialization — development guide

## Module structure

- `types.ts` — all interfaces and type definitions; the source of truth for the module's contracts
- `archiver.ts` — `createMaterializationArchiver()` coordinator; fans out snapshots to git + remote stores
- `snapshot.ts` — `buildSnapshot()`, `buildSessionSnapshot()`, `buildCheckpointSnapshot()`, `buildProvenance()`
- `git-archive-store.ts` — `createGitArchiveStore()`; uses git plumbing commands (no working tree)
- `http-remote-store.ts` — `createHttpRemoteStore()`; POSTs snapshots to HTTP endpoints (write-only)
- `git-remote-store.ts` — `createGitRemoteStore()`; archives to a remote git repo via local bare clone (read + write)
- `remote-store-factory.ts` — `registerRemoteStoreFactory()` plugin registry + `createRemoteStoresFromConfig()`
- `graph-id.ts` — `resolveGraphId()` with 4-level fallback chain + slug helpers
- `index.ts` — barrel file; all public exports go through here

## Key patterns

### Git plumbing (no porcelain)

`git-archive-store.ts` never checks out files. It uses:
- `git hash-object -w` to write blobs
- `git update-index` with a temporary `GIT_INDEX_FILE` to avoid touching the working tree
- `git write-tree` / `git commit-tree` / `git update-ref` for atomic commits

Temporary index files are created at `.git/index-archive-<timestamp>` to allow concurrent operations without conflicts.

### Store fan-out

The archiver runs the git store first, then all enabled remote stores in parallel. Each store is error-isolated — a remote store failure never blocks the git archive or other remote stores.

### Snapshot immutability

Snapshots are immutable once committed. The `archivedAt` field is set at archive time; everything else comes from the graph node at that moment. `version: 1` is always set for forward compatibility.

### Remote store plugin interface

To add a new remote store type:
1. Implement `RemoteStore` from `types.ts` (extends `MaterializationStore` with `events: string[]`)
2. Create a factory function `(config: RemoteStoreConfig) => RemoteStore`
3. Register it: `registerRemoteStoreFactory('mytype', factory)`

The HTTP store is write-only (`retrieve()` returns null, `list()` returns `[]`). The git remote store supports both reads and writes via a local bare repo cache. New stores can implement reads if the backend supports it.

## Testing

Tests are in `__tests__/` and cover:
- `snapshot.test.ts` — snapshot assembly from various node types
- `archiver.test.ts` — fan-out, error isolation, rematerialization flows
- `git-archive-store.test.ts` — (via `archive-methods.test.ts`) storage and retrieval
- `http-remote-store.test.ts` — HTTP webhook integration
- `git-remote-store.test.ts` — git remote store with real bare repo operations
- `remote-store-factory.test.ts` — factory registration and config parsing
- `graph-id.test.ts` — ID derivation, slug helpers, remote URL parsing
- `config.test.ts` — config schema validation
- `materialize-before-archive.test.ts` — provider integration for pre-archive materialization

## Common tasks

### Adding a field to snapshots

1. Add the field to the relevant interface in `types.ts` (`MaterializationSnapshot`, `SessionSnapshot`, or `CheckpointSnapshot`)
2. Populate it in `snapshot.ts` (`buildSnapshot` / `buildSessionSnapshot` / `buildCheckpointSnapshot`)
3. Update tests in `__tests__/snapshot.test.ts`
4. If the field affects archive layout, update `git-archive-store.ts` path logic

### Adding a new remote store type

1. Create `my-store.ts` implementing `RemoteStore`
2. Export the factory from `index.ts`
3. Register in `remote-store-factory.ts` or let consumers call `registerRemoteStoreFactory()`
4. Add tests in `__tests__/my-store.test.ts`

### Changing archive policy defaults

Defaults are in `types.ts` at `DEFAULT_ARCHIVE_POLICY`. The archiver reads these from config via `MaterializationArchiverConfig.policy`.

### Changing the git tree layout

Paths are constructed in `git-archive-store.ts` and `git-remote-store.ts`. The pattern is `<graphId>/sessions/<session-id>/session.json` (and `edges.json`, `checkpoints/<id>.json`). Both stores must use the same layout. Changing this requires a migration strategy for existing archives.

## Important constraints

- The git archive branch (`opentasks/archive`) is an orphan branch — it shares no history with the main branch
- `pushToRemote()` handles conflicts via fetch + rebase; this is safe because paths are namespaced by graphId and don't overlap across repos
- Snapshots use `version: 1` — bump this if making breaking schema changes
- The archiver depends on `GraphStore` for node/edge queries — it cannot run without a store instance
- `materializeBeforeArchive` requires a `MaterializationProvider` to be set on the archiver; without one, it archives whatever is already in the graph node
- `git-remote-store.ts` manages its own bare repo cache; the cache path can be configured or defaults to a temp directory. The `fetchBeforeRead` option (default: true) fetches from the remote before `retrieve()` and `list()` operations
- The git remote store uses the same tree layout and plumbing approach as the local git archive store — changes to one should be reflected in the other
