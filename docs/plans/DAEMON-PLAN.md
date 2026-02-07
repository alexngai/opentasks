# Daemon Implementation Plan

## Status: Phase A Complete, Phase B In Progress

## Overview

The daemon has all individual components built and tested (IPC, watcher, flush,
method handlers, lock, registry). What's missing is:

1. **Phase A**: Wire components together in lifecycle.ts (single-location)
2. **Phase B**: Extend to multi-location architecture (one daemon per git repo)

Phase A is prerequisite for Phase B. Phase B unlocks the remaining gaps (#1, #5, #10).

---

## Phase A: Wire Single-Location Daemon

### Goal

Get a working daemon where `start()` creates all components, registers handlers,
and `stop()` tears them down cleanly. No architectural changes.

### Design Decisions

**D1: Store injection, not construction.** The `DaemonConfig` accepts a `GraphStore`
rather than constructing one internally. The caller (CLI, test) builds the store.
This keeps lifecycle.ts focused and storage-agnostic.

**D2: Flush coordination.** The daemon's flush manager does NOT replace the
GraphStore's built-in SyncManager. The flush manager tracks dirty nodes from IPC
operations and calls `store.flush()` on its schedule. The store's own sync handles
persistence to both SQLite (immediate) and JSONL (debounced).

**D3: Watcher → flush coordination.** When the watcher detects external JSONL
changes, it pauses the flush manager (to avoid overwriting external edits) and
signals that the store should reload. When the daemon writes to JSONL via flush,
it pauses the watcher (to avoid self-triggered events).

### Changes

#### A1. `DaemonConfig` — add `store` field

```typescript
export interface DaemonConfig {
  locationPath: string
  version: string
  store: GraphStore              // NEW: injected by caller
  shutdownTimeoutMs?: number
  registryPath?: string
  openTasksConfig?: PartialOpenTasksConfig
}
```

#### A2. `start()` — wire components after lock acquisition

After step 5 (signal handlers), add:

```
6. Create flush manager
   - onFlush callback: pause watcher → store.flush() → resume watcher
7. Create IPC server at socketPath
8. Register method handlers:
   - registerLifecycleMethods(server, getStatus, stop, version, startedAt)
   - registerGraphMethods(server, store, flushManager)
   - registerToolsMethods(server, store, flushManager)
9. Start IPC server (begin listening on socket)
10. Create file watcher for locationPath
11. Register watcher change handler:
    - On graph.jsonl change: log (reload deferred to Phase B)
    - On config change: log (hot-reload deferred to Phase B)
12. Start watcher
```

#### A3. `stop()` — reverse order teardown

```
1. Remove signal handlers
2. Stop IPC server (close connections, stop listening)
3. Stop file watcher
4. Final flush (flushManager.finalFlush())
5. Close store (store.close())
6. Unregister from registry
7. Remove socket file
8. Release lock
```

#### A4. `getStatus()` — use real component state

```typescript
getStatus(): DaemonStatus {
  return {
    state,
    startedAt,
    pid: process.pid,
    socketPath,
    pendingFlush: flushManager?.hasPendingChanges() ?? false,
    connectionCount: ipcServer?.getConnectionCount() ?? 0,
  }
}
```

#### A5. New `createDaemonWithStore()` convenience factory

Exported from `index.ts`. Handles the boilerplate of creating SQLite + JSONL
persisters, building a GraphStore, and passing it to `createDaemon`:

```typescript
export async function createDaemonWithStore(config: {
  locationPath: string
  version: string
  registryPath?: string
}): Promise<Daemon>
```

#### A6. Export updates in `index.ts`

Export `createDaemonWithStore` alongside existing `createDaemon`.

### Testing Strategy (Phase A)

- **Integration test**: `createDaemonWithStore()` → `start()` → IPC client
  connects → `ping` → `graph.create` → `graph.get` → `stop()` → cleanup verified
- **Flush coordination test**: IPC `graph.create` → verify dirty tracking → force
  flush → verify JSONL updated
- **Status test**: start → verify `getStatus()` reflects IPC connections and
  pending flush state
- **Watcher test**: confirm watcher starts/stops with daemon lifecycle

### Files Modified (Phase A — Complete)

| File | Changes |
|------|---------|
| `src/daemon/lifecycle.ts` | Wire start/stop, add store param |
| `src/daemon/factory.ts` | New: createDaemonWithStore convenience |
| `src/daemon/index.ts` | Export createDaemonWithStore |
| `src/daemon/__tests__/lifecycle.test.ts` | Updated with mock store |
| `src/daemon/__tests__/integration.test.ts` | New integration tests |

### Effort

~300 lines production code, ~300 lines test code.

### Phase B Files Modified

| File | Changes |
|------|---------|
| `src/daemon/types.ts` | Add LOCATION_NOT_FOUND, LocationInfo |
| `src/daemon/location-state.ts` | New: LocationState, LocationResolver |
| `src/daemon/lifecycle.ts` | Unified createDaemon with branching |
| `src/daemon/methods/graph.ts` | Use LocationResolver |
| `src/daemon/methods/tools.ts` | Use LocationResolver |
| `src/daemon/methods/location.ts` | New: location IPC methods |
| `src/daemon/factory.ts` | Multi-location convenience factory |
| `src/daemon/index.ts` | Updated exports |
| `src/client/client.ts` | Discovery: git common dir first, fallback |
| `src/daemon/__tests__/multi-location.test.ts` | New integration tests |

---

## Phase B: Multi-Location Daemon

### Goal

Single daemon per git repo at `.git/opentasks/daemon.sock`, managing all
worktrees. Unlocks gaps #1, #5, #10.

### Design Decisions

**D4: Socket location.** `.git/opentasks/daemon.sock`. Shared by all worktrees.
The daemon's "home" is the git common dir, not any single worktree.

**D5: Per-request location field.** IPC requests include optional `location` hash
in params. Default = primary location. Stateless — any client can target any
location without rebinding. Implemented via middleware that extracts
`params.location` and resolves to the correct LocationState before delegating
to the handler.

**D6: Branch caching — deferred.** Heterogeneous per-worktree branch tracking is
deferred. Each worktree has its own HEAD file but implementing that is additive
and can be layered on after the core multi-location routing works.

**D7: Eager initialization at startup, graceful degradation.** On start, read
worktree registry, initialize `LocationState` for each registered worktree +
the primary location. If a location fails to initialize, the daemon starts in
a degraded state with the remaining locations — it does not fail entirely.
Dynamic add/remove via IPC methods.

**D8: LocationProvider registration per-location.** Each location gets its own
ProviderRegistry with providers for all *other* connected locations. Avoids a
global registry mixing concerns. (Deferred to follow-up — core routing first.)

**D9: Unified API.** `createDaemon` accepts either a single-location config
(with `store: GraphStore`, backward compatible) or a multi-location config
(with `gitCommonDir: string`). The function branches internally based on which
fields are present.

**D10: Client discovery.** Client checks `.git/opentasks/daemon.sock` first
(multi-location), then falls back to walking up for `.opentasks/daemon.sock`
(single-location). This ensures backward compatibility while preferring the
shared daemon.

**D11: Primary location.** In multi-location mode, the git root's `.opentasks/`
is the primary location (default when `params.location` is omitted). This can be
overridden via `primaryLocationPath` in the config.

**D12: Redirect transparency.** Within the daemon (same repo's worktrees),
redirects are resolved transparently — the daemon routes to the target location's
store directly. For external locations (different repos), the daemon returns a
redirect response to the client.

### Architecture

```
.git/opentasks/
  daemon.sock        ← single IPC socket
  daemon.lock        ← exclusive lock (daemon-level)
  worktrees.json     ← registry of all worktrees

worktree-1/.opentasks/
  graph.jsonl, cache.db  ← own data
  config.json            ← own connections, redirects

worktree-2/.opentasks/
  graph.jsonl, cache.db  ← own data
  config.json            ← own connections, redirects
```

```
┌──────────────────────────────────────────────┐
│ MultiLocationDaemon                          │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ IPC Server (.git/opentasks/daemon.sock)  │ │
│ │   resolve location from params.location  │ │
│ │   delegate to LocationState.store        │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ┌────────────┐ ┌────────────┐               │
│ │ Location A │ │ Location B │  ...          │
│ │  store     │ │  store     │               │
│ │  flush     │ │  flush     │               │
│ │  watcher   │ │  watcher   │               │
│ │  config    │ │  config    │               │
│ │  providers │ │  providers │               │
│ └────────────┘ └────────────┘               │
│                                              │
│ HEAD watcher (.git/HEAD)                     │
│ Branch cache: Map<hash, string>              │
└──────────────────────────────────────────────┘
```

### New Types

```typescript
// Per-worktree state
interface LocationState {
  hash: string
  opentasksPath: string
  store: GraphStore
  flushManager: DaemonFlushManager
  watcher: FileWatcher
}

// Location resolver (abstracts single vs multi-location)
interface LocationResolver {
  resolve(locationHash?: string): LocationState
  getDefault(): LocationState
  list(): LocationInfo[]
  has(hash: string): boolean
  add(state: LocationState): void
  remove(hash: string): Promise<void>
}

// Config is a discriminated union
interface DaemonConfigBase {
  version: string
  shutdownTimeoutMs?: number
  registryPath?: string
}
interface SingleLocationDaemonConfig extends DaemonConfigBase {
  locationPath: string
  store: GraphStore
  openTasksConfig?: PartialOpenTasksConfig
}
interface MultiLocationDaemonConfig extends DaemonConfigBase {
  gitCommonDir: string
  primaryLocationPath?: string
}
type DaemonConfig = SingleLocationDaemonConfig | MultiLocationDaemonConfig
```

### IPC Protocol Changes

All graph/tools methods accept optional `location?: string` in params.

New methods:

```
location.register   { hash, opentasksPath }  → { success }
location.unregister { hash }                 → { success }
location.list       {}                       → LocationInfo[]
location.resolve    { target, operation? }   → { hash, opentasksPath }
```

### Implementation Steps

| Step | Description | Depends On |
|------|-------------|------------|
| B1 | `src/daemon/types.ts`: Add LOCATION_NOT_FOUND, LocationInfo | Phase A |
| B2 | `src/daemon/location-state.ts`: LocationState, LocationResolver | B1 |
| B3 | Refactor graph/tools methods to use LocationResolver | B2 |
| B4 | `src/daemon/methods/location.ts`: register/unregister/list | B2 |
| B5 | Refactor lifecycle.ts: unified createDaemon with branching | B2, B3 |
| B6 | Update factory.ts for multi-location convenience | B5 |
| B7 | Client discovery: prefer `.git/opentasks/daemon.sock` | B1 |
| B8 | Update daemon/index.ts exports | B1-B7 |
| B9 | Integration tests for multi-location scenarios | B1-B8 |
| B10 | (Deferred) `.git/HEAD` watcher, branch cache | B5 |
| B11 | (Deferred) Gap #5: recursive redirect resolution | B3, B5 |
| B12 | (Deferred) Gap #10: LocationProvider auto-registration | B5 |

### Gap Resolution

| Gap | Resolved By | How |
|-----|-------------|-----|
| #1 (daemon integration) | B1-B3 | Multi-location daemon manages all worktrees |
| #5 (recursive redirects) | B5 | All configs in memory, pure computation |
| #10 (LocationProvider) | B6 | Auto-register providers at location init |

### Risk Mitigation

- **Client backward compatibility**: If `location` omitted, default to primary.
  Phase A clients work unchanged.
- **Incremental rollout**: Phase A daemon works standalone. Phase B extends it.
  No big-bang migration.
- **Memory**: Each location ≈ 10MB (SQLite WAL + JSONL cache). 10 worktrees =
  100MB. Acceptable for a daemon.
- **SQLite contention**: Each location has its own DB. WAL mode handles concurrent
  reads. Daemon serializes writes per-location via flush manager.

### Effort

~600-800 lines production code, ~400 lines test code. Can be split across
multiple PRs (B1-B3, then B4-B6, then B7-B9).

---

## Execution Order

```
Phase A  (this PR)
  └─► Phase B1-B3  (multi-location core)
        ├─► Phase B4 (branch caching)
        ├─► Phase B5 (recursive redirects, Gap #5)
        ├─► Phase B6 (provider registration, Gap #10)
        └─► Phase B7-B9 (CLI/client updates)
```
