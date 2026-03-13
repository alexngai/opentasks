# Provider Reconciliation Design

How provider-backed nodes stay consistent across git-synced environments.

**See also:** [PROVIDERS.md](./PROVIDERS.md) (provider architecture) · [PERSISTENCE.md](./PERSISTENCE.md) (JSONL/SQLite layers) · [DESIGN.md](./DESIGN.md) (vision)

**Status:** Phase 1–2 implemented, Phase 4 partial (edge reconciliation via rawData)

---

## Problem

When `graph.jsonl` is git-synced across environments (team members, worktrees), provider-backed nodes can diverge from their source of truth:

```
Alice (machine A)                    Bob (machine B)
─────────────────                    ────────────────
updates beads task bd-x7k9
  → graph node t-abc1 updated
  → graph.jsonl flushed

git push ──────────────────────────► git pull
                                     graph.jsonl reloaded
                                     t-abc1 has Alice's cached data
                                     but Bob's beads may have
                                     different state for bd-x7k9
                                     → no mechanism to detect drift
```

### Root Causes

1. **No staleness tracking for local-provider nodes.** Remote provider nodes (`type: 'external'`) have `cached_at` and `staleAfter` for staleness detection. Local provider nodes (`type: 'task'` with `metadata.provider_uri`) have no equivalent — they look like regular tasks.

2. **No reconciliation on reload.** When the daemon reloads `graph.jsonl` (after git pull, branch switch, or restart), it syncs JSONL → SQLite but never re-checks with providers. Stale cached data is served as-is.

3. **Merge driver is provider-unaware.** The JSONL three-way merge driver (`src/core/merge-driver.ts`) resolves conflicts with last-writer-wins by `updated_at`. It doesn't know that provider-backed nodes should defer to the provider as the source of truth.

### Affected Scenarios

| Scenario | What breaks |
|---|---|
| Git pull with changed provider data | Graph has stale title/status/content for provider-backed nodes |
| Two people update the same provider task | Merge conflict in graph.jsonl on cached fields (title, status) |
| Worktree switch | Different branch may have different provider state |
| Daemon restart | No re-fetch of provider-backed nodes on startup |
| Provider not configured in this environment | Provider-backed nodes sit with stale cached data, write routing unavailable |

---

## Design: Cached-but-Non-Authoritative

Provider-backed nodes cache data from the provider but explicitly mark it as non-authoritative. The provider is always the source of truth.

### Principles

1. **Provider is authoritative.** For any node with `provider_authoritative: true`, the provider's current state wins over the cached graph data.
2. **Cache enables offline access.** Cached data is available when the provider is offline — queries, edge traversal, and git diffs all work with stale data.
3. **Reconciliation is explicit.** The system reconciles on defined triggers (reload, startup, timer) rather than on every read.
4. **Reconciliation only writes positive state.** Reconciliation updates cached data when the provider confirms newer state. It never archives, deletes, or marks nodes as unreachable — avoiding oscillation across environments with different provider configurations (see [Oscillation Avoidance](#oscillation-avoidance)).
5. **Per-provider control.** Providers can opt into pointer-only mode (no cached data) if they prefer zero cache divergence.

---

## Node Metadata

### Cached Mode (default for local providers)

```json
{
  "id": "t-abc1",
  "type": "task",
  "title": "Fix auth",
  "status": "open",
  "content": "Token expiry is too short",
  "metadata": {
    "provider_uri": "beads://./bd-x7k9",
    "provider_source": "beads",
    "provider_cached_at": "2025-03-12T10:00:00Z",
    "provider_authoritative": true
  }
}
```

| Field | Purpose |
|---|---|
| `provider_uri` | Canonical URI in the owning provider (existing) |
| `provider_source` | Provider scheme name (existing) |
| `provider_cached_at` | When the cached data was last fetched from the provider (new) |
| `provider_authoritative` | Flag: provider is source of truth for this node's data (new) |

### Pointer-Only Mode (opt-in per provider)

```json
{
  "id": "t-abc1",
  "type": "task",
  "title": "(pending)",
  "status": "open",
  "metadata": {
    "provider_uri": "beads://./bd-x7k9",
    "provider_source": "beads",
    "provider_authoritative": true,
    "provider_pointer_only": true
  }
}
```

Title is a placeholder (`"(pending)"`), content is omitted, status is minimal. Data is resolved from the provider on every access via transparent session-scoped caching. Edges still reference the graph ID.

---

## Provider Interface Changes

### Materialization Mode

```typescript
interface Provider {
  // ... existing fields
  readonly materializeMode?: 'cached' | 'pointer';  // default: 'cached'
}
```

Also configurable per-provider in `opentasks.config.json`:

```json
{
  "providers": {
    "beads": { "enabled": true, "materializeMode": "cached" },
    "claudeTasks": { "enabled": true, "materializeMode": "pointer" }
  }
}
```

Config overrides the provider's default.

### Optional: Content Hash

```typescript
interface ProviderNode {
  // ... existing fields
  contentHash?: string;  // provider-computed hash of canonical state
}
```

Enables fast diff during reconciliation — compare stored hash vs provider's current hash without deep-comparing every field. Optional; providers that don't implement it fall back to full comparison.

### Provider Availability Check

```typescript
interface Provider {
  // ... existing fields
  isAvailable?(): Promise<boolean>;  // lightweight reachability check
}
```

Each provider defines its own availability check, appropriate to its access mechanism:

| Provider | `isAvailable()` implementation |
|---|---|
| **beads** | `fs.access(beadsDir)` — check directory exists |
| **sudocode** | `fs.access(dataDir)` — check directory exists |
| **claude-tasks** | `fs.access(tasksDir)` — check directory exists |
| **global** | IPC ping to global daemon (with short timeout) |
| **map** | Connection health check on MAP client |

**Provider-side caching:** Providers cache the result of `isAvailable()` internally with a short TTL (e.g., 5–10 seconds). This avoids redundant checks when reconciliation iterates over many nodes grouped by the same provider. The cache is per-provider-instance and resets on daemon restart.

```typescript
// Example provider-side caching pattern
function createIsAvailable(checkFn: () => Promise<boolean>, ttlMs = 5000) {
  let cached: { value: boolean; expiresAt: number } | null = null;

  return async (): Promise<boolean> => {
    const now = Date.now();
    if (cached && now < cached.expiresAt) return cached.value;
    const value = await checkFn();
    cached = { value, expiresAt: now + ttlMs };
    return value;
  };
}
```

Reconciliation calls `isAvailable()` once per provider before processing that provider's nodes. If unavailable, the entire provider is skipped (positive-writes-only rule).

Providers that don't implement `isAvailable()` are assumed always available.

### Optional: Batch Reconciliation

```typescript
interface Reconcilable {
  listForReconciliation(options?: ListReconcilableOptions): Promise<ReconcilableNodeSummary[]>;
}

interface ListReconcilableOptions {
  ids?: string[];
}

interface ReconcilableNodeSummary {
  id: string;
  uri: string;
  contentHash: string;
  updatedAt?: string;
}
```

Providers that implement `Reconcilable` return lightweight summaries with content hashes. The reconciliation engine compares these hashes against `provider_content_hash` stored on graph nodes — unchanged nodes skip the full `get()` call entirely. Providers that don't implement it fall back to individual `get(id)` calls.

**Phase 2 cost:** Individual `get()` calls are acceptable for Phase 2. For local filesystem providers (beads, sudocode, claude-tasks), each call is a single file read — the cost of N calls is negligible. `contentHash` and `Reconcilable` are Phase 3+ optimizations for when remote providers (Jira, Linear) are added and network round-trips become the bottleneck.

---

## Materialization Changes

When materializing a local-provider node, stamp the reconciliation metadata:

```typescript
// In materialize() — local provider path
const node = await store.createNode({
  type: nodeType,
  title: providerNode.title,
  content: providerNode.content,
  status: providerNode.status ?? 'open',
  priority: providerNode.priority,
  metadata: {
    provider_uri: uri,
    provider_source: source,
    provider_cached_at: new Date().toISOString(),
    provider_authoritative: true,
    provider_content_hash: providerNode.contentHash,
    ...(provider.materializeMode === 'pointer' ? { provider_pointer_only: true } : {}),
  },
});
```

For pointer-only mode, omit title/content/status (or set to empty defaults).

---

## Merge Driver Changes

The JSONL merge driver (`src/core/merge-driver.ts`) needs provider-awareness for nodes with `provider_authoritative: true`.

### Current Behavior

Three-way merge with last-writer-wins by `updated_at` for all fields.

### New Behavior

When both sides modified a node with `metadata.provider_authoritative === true`:

1. **Structural fields** (id, type, metadata keys) — merge normally
2. **Cached data fields** (title, content, status, priority) — do NOT three-way merge
3. **Resolution** — keep whichever side's data, but set `provider_cached_at: null` and add `provider_needs_reconcile: true`

This avoids false merge conflicts on cached data. The node is marked for re-fetch from the provider on next reconciliation.

When only one side modified: take the modified side as-is (normal merge behavior). Cached data may be stale but is the best available until reconciliation.

### Merge Driver Sequencing

The merge driver runs as a **standalone git process** — it has no connection to the daemon. It reads three JSONL versions (base, ours, theirs), produces a merged result, and exits. The daemon is not involved during the merge.

After the merge completes, the daemon picks up the changed `graph.jsonl` via its existing `FileWatcher` mechanism, which triggers `store.reload()`. If any nodes were stamped `provider_needs_reconcile` by the merge driver, the reconciliation engine (triggered by `onReload`) will process them. There is no timing issue — the merge driver writes the file, and the daemon reacts to the file change.

### Edge Merging

Edges use the existing last-writer-wins strategy. Provider-originated edges carry `edge_source` metadata for future reconciliation (see [Edge Reconciliation](#edge-reconciliation)).

---

## Reconciliation Flow

### Configuration

```json
{
  "reconciliation": {
    "onStartup": "async",
    "onReload": "async",
    "backgroundInterval": 300000
  }
}
```

| Field | Values | Default | Description |
|---|---|---|---|
| `onStartup` | `"async"` \| `"blocking"` \| `"none"` | `"async"` | Reconcile provider-backed nodes when daemon starts |
| `onReload` | `"async"` \| `"blocking"` \| `"none"` | `"async"` | Reconcile after `store.reload()` (git pull, branch switch) |
| `backgroundInterval` | milliseconds, `0` to disable | `300000` (5 min) | Periodic reconciliation for nodes with aging `provider_cached_at` |

Async (non-blocking) is the default — the daemon serves cached data immediately and reconciles in the background. Blocking mode is available for environments that need consistency guarantees (e.g., CI pipelines).

### Algorithm

```
reconcileProviders(options?: { providers?: string[], nodeIds?: string[] }):

  1. Scan graph for nodes with metadata.provider_authoritative === true
  2. Filter by options.providers / options.nodeIds if specified
  3. Group by provider_source

  4. For each provider:
     a. Check provider.isAvailable() (provider-side cached, see Provider Interface Changes)
        If not available: SKIP entirely — do not modify any nodes
                          (avoids oscillation across environments)

     b. If provider implements Reconcilable:
          summaries = provider.listForReconciliation({ ids })
          Compare contentHash vs stored provider_content_hash
          Only fetch (via get()) nodes whose hash changed or is missing
        Else:
          Fetch all via individual get() calls

     c. For each result:
        - Provider returns node with same data:
            → update provider_cached_at only
            → clear provider_needs_reconcile if set
        - Provider returns node with different data:
            → update graph node with provider data
            → update provider_cached_at
            → update provider_content_hash if available
        - Provider returns null (deleted in provider):
            → leave node as-is, do NOT archive or delete
            → implicit staleness: provider_cached_at stays old
        - Error fetching:
            → leave node as-is, preserve cached data

     d. Edge reconciliation (piggyback on node data):
        → extract edges from ProviderNode.rawData
        → diff against graph edges where edge_source === provider.name
        → add missing provider edges (stamp edge_source)
        → remove stale provider edges
        → never touch graph-owned edges (edge_source absent or "native")

  5. Flush dirty nodes to JSONL
```

### Pointer-Only Resolution

Resolution is **transparent** — callers never see stub nodes. The store layer handles fetching and session-caching internally.

For nodes with `provider_pointer_only: true`:
- On `providerGet()`: always resolve from provider, cache in session-scoped memory only. Caller receives a fully populated node.
- On `providerUpdate()`: route to provider, return full updated data to caller, but do not persist content to JSONL — only the pointer metadata is persisted
- On `providerListTasks()`: resolve from provider for display, session-cache results. Caller receives full nodes indistinguishable from cached-mode nodes.
- On provider unavailable: return session-cached data if available, otherwise the stub node with empty title as a last resort
- Session cache is cleared on daemon restart

---

## Oscillation Avoidance

A critical constraint for git-synced environments: **reconciliation must never write negative state to the JSONL.**

### The Problem

If reconciliation archives or deletes nodes when a provider is unavailable, environments with different provider configurations will oscillate:

```
Alice (has beads)          Bob (no beads)
─────────────────          ────────────────
reconcile: bd-x7k9 ✓
  → node is live

push ──────────────────► pull
                          reconcile: beads unavailable
                          → archives node
                          push ──────────────► pull
                                               reconcile: bd-x7k9 ✓
                                               → unarchives node
                                               push ────► ...oscillation
```

### The Rule

Reconciliation only performs **positive writes**:

| Provider response | Action |
|---|---|
| Returns updated data | Update graph node, stamp `provider_cached_at` |
| Returns same data | Stamp `provider_cached_at` (confirms freshness) |
| Returns null (deleted) | **No action** — leave node as-is |
| Provider unavailable | **No action** — skip entirely |
| Error | **No action** — preserve cached data |

Staleness is implicit: `provider_cached_at` gets progressively older when the provider can't be reached. Consumers can use the age of `provider_cached_at` to judge trustworthiness.

**Node cleanup is an explicit user action**, not an automated side effect. If someone wants to remove nodes for a provider they'll never configure, they do it manually (or via a future `cleanup` tool with confirmation).

---

## Edge Reconciliation

Edges have two origins that must be handled differently:

### Edge Provenance

```json
{
  "id": "x-r8s9",
  "from_id": "t-abc1",
  "to_id": "t-ghi3",
  "type": "blocks",
  "metadata": {
    "edge_source": "beads"
  }
}
```

| `edge_source` value | Meaning | Reconciliation behavior |
|---|---|---|
| Provider name (e.g., `"beads"`) | Created from provider data (watch event or reconciliation) | Provider-owned — can be added/removed by reconciliation |
| `"native"` or absent | Created via OpenTasks `link` tool or user action | Graph-owned — never touched by reconciliation |

### How Edge Reconciliation Works

Edge reconciliation piggybacks on node reconciliation — no extra provider calls. When a `ProviderNode` is fetched during node reconciliation, its `rawData` already contains relationship information (e.g., `blocks`, `blockedBy`, `dependencies`, `relationships`).

```
For each reconciled node with updated ProviderNode data:
  1. Extract provider edges from ProviderNode.rawData
     (provider-specific: beads uses blocks/blockedBy, sudocode uses relationships)
  2. Query graph edges involving this node where edge_source === provider.name
  3. Diff:
     - In provider but not graph → create edge with edge_source: provider.name
     - In graph but not provider → remove edge (provider no longer reports it)
     - In both → no-op
  4. Never touch edges where edge_source is absent or "native"
```

### Edge Source Stamping

All edge creation paths must stamp `edge_source`:

| Creation path | `edge_source` value |
|---|---|
| `link` MCP tool / user action | `"native"` (or omit) |
| Provider watch event | Provider name |
| Reconciliation | Provider name |
| Import / migration | Source system name |

### Scope

Edge reconciliation is included in the design for completeness but is a **Phase 2+ concern**. Phase 1 reconciles node data only. The `edge_source` metadata can be stamped from Phase 1 onward to build provenance data for future use.

---

## Per-Provider Behavior

| Provider | Default Mode | Reconciliation Cost | Edge Data in rawData | Notes |
|---|---|---|---|---|
| **native** | N/A | N/A | N/A | Not provider-backed; JSONL is the data |
| **beads** | cached | Low (filesystem) | `blocks`, `blockedBy`, `dependencies`, `parent`, `children` | Could implement Reconcilable |
| **sudocode** | cached | Low (JSONL reads) | `relationships[]`, `parent_id` | Could implement Reconcilable |
| **claude-tasks** | cached | Low (filesystem) | `blocks`, `blockedBy` | Shared across worktrees |
| **global** | cached | Low (IPC) | Depends on global store | Has its own daemon |
| **map** | pointer | Zero (pass-through) | N/A | Ephemeral, no caching |
| **sessionlog** | pointer | Zero (direct-read) | N/A | External state |

---

## Implementation Phases

### Phase 1: Metadata Stamping + Edge Source — DONE

- [x] Add `provider_cached_at` and `provider_authoritative` to materialization (local provider path)
- [x] Add `materializeMode` to Provider interface and config schema
- [x] Add `isAvailable()` to Provider interface with provider-side caching pattern
- [x] Pointer-only materialization path in `materialize()` (title stored as `"(pending)"` placeholder)
- [x] Stamp `edge_source` on edges created by provider watch events
- [x] Update `provider_cached_at` on every re-materialize (update path)
- [x] SQLite `nodes` table metadata column + JSON persistence in `createNode`/`updateNode`/`rowToNode`

**Files:** `src/providers/materialization.ts`, `src/providers/types.ts`, `src/config/schema.ts`, `src/storage/sqlite-schema.ts`, `src/storage/sqlite.ts`, `src/graph/store.ts`, provider watch handlers, individual provider files

### Phase 2: Reconciliation Engine — DONE

- [x] `reconcileProviders()` method on ProviderAwareStore
- [x] Reconciliation via individual `provider.get()` calls (sufficient for local filesystem providers)
- [x] `isAvailable()` check per provider before processing (provider-side cached)
- [x] Positive-writes-only constraint (no archives/deletes on unavailable providers)
- [x] `provider_content_hash` comparison for fast skip when hashes match
- [x] Trigger on `store.reload()` via file watcher (async by default, `onReload` configurable as `"async"` | `"blocking"` | `"none"`)
- [x] `findExternalNodeByUri` / `findByProviderUri` scan by node type (SQLite `search` only checks title/content, not metadata)
- [ ] Reconciliation config section in `opentasks.config.json` schema (Phase 5)
- [ ] Trigger on daemon startup (Phase 5)

**Files:** `src/graph/provider-store.ts`, `src/providers/types.ts`, `src/daemon/location-state.ts`

### Phase 3: Merge Driver — NOT STARTED

- Detect `provider_authoritative` nodes during three-way merge
- For both-sides-modified conflicts: mark as `provider_needs_reconcile` instead of merging cached fields
- One-side-modified: normal merge behavior
- Edge merging unchanged

**Files:** `src/core/merge-driver.ts`

### Phase 3.5: Batch Reconciliation (optimization) — INTERFACE DEFINED

- [x] `Reconcilable` trait defined in `src/providers/traits/Reconcilable.ts`
- [x] `ReconcilableNodeSummary` and `ListReconcilableOptions` interfaces
- [x] `isReconcilable()` type guard
- [ ] No providers implement `Reconcilable` yet (local filesystem providers don't need it)
- [ ] Reconciliation engine falls back to individual `get()` calls (correct Phase 2 behavior)

**Files:** `src/providers/types.ts`, `src/providers/traits/Reconcilable.ts`

### Phase 4: Edge Reconciliation — DONE (via rawData extraction)

- [x] `extractEdgesFromRawData()` helper in `provider-store.ts` — extracts edges from `ProviderNode.rawData` during node reconciliation (zero extra provider calls)
- [x] Supports beads (`blocks`/`blockedBy`/`dependencies`), sudocode (`relationships`/`parent_id`)
- [x] Diff against graph edges filtered by `edge_source === provider.name`
- [x] Add missing provider edges (stamped with `edge_source`, `from_uri`, `to_uri`)
- [x] Remove stale provider edges
- [x] Never touch graph-owned edges (`edge_source` absent or `"native"`)
- Edge reconciliation failure is non-fatal (caught silently)

**Note:** Edge data availability depends on the provider's output. Beads `--no-db` mode does not include `blocks`/`blockedBy` in rawData, so edge reconciliation is a no-op in that configuration.

**Files:** `src/graph/provider-store.ts`

### Phase 5: Background Sync + MCP Tool — PARTIAL

- [ ] Configurable background reconciliation interval (not wired to daemon startup)
- [ ] `reconcile` MCP tool for manual trigger (IPC handler exists at `provider.reconcile`, not yet registered in all E2E setups)
- [ ] Per-provider interval configuration
- [x] Session-scoped memory cache for pointer-only nodes (30s TTL, cleared on restart)
- [x] `reconcileProviders()` returns structured `ReconcileResult` with per-node status

**Files:** `src/graph/provider-store.ts`, `src/daemon/methods/provider.ts`

---

## Resolved Decisions

### Pointer-only resolution transparency

**Decision:** Transparent. The store layer handles fetching and session-caching internally. Callers never see stub nodes — `providerGet()` and `providerListTasks()` return fully populated nodes regardless of mode.

### Metadata query path for reconciliation

**Decision:** Full scan + filter in Phase 2. Load all nodes, filter by `metadata.provider_authoritative === true` in application code. Acceptable for local graph sizes. Add a `provider_authoritative` SQLite column as a Phase 5 optimization if needed.

### Reconciliation error handling (async mode)

**Decision:** Log-only in Phase 2. Errors logged at warn level, daemon continues serving cached data. Add event emission in Phase 5 when the MCP `reconcile` tool provides explicit reporting.

### Permanently misconfigured providers

**Decision:** By design. Nodes with stale `provider_cached_at` are visibly stale but never auto-deleted (positive-writes-only). Explicit cleanup via future `cleanup` MCP tool with user confirmation.

---

## Known Limitations

1. **No transactional locking during reconciliation.** If a user updates a node while reconciliation is in-flight, the provider fetch may overwrite the local change. Acceptable for Phase 2 — provider is authoritative by design.

2. **Edge reconciliation depends on rawData availability.** Providers that don't include relationship data in `rawData` (e.g., beads in `--no-db` mode) get no edge reconciliation. Edges are silently skipped, not reported as errors.

3. **Orphaned edge targets.** If a provider edge references a node not yet materialized in the graph, the edge is silently dropped. It will be created on the next reconciliation after both nodes are materialized.

4. **Metadata merge is full-replace.** `store.updateNode()` replaces the entire `metadata` object, not merging. All callers must spread existing metadata. This is a footgun for future developers but works correctly in current reconciliation code.

5. **No reconciliation config in `opentasks.config.json` yet.** The `onReload` trigger is hardcoded. Background interval and `onStartup` triggers are Phase 5.

---

## Open Questions

### 1. Reconciliation reporting

What level of visibility should reconciliation provide beyond logging?

- **MCP tool result** — the `reconcile` tool returns a diff summary (Phase 5)
- **Events** — emit change events that consumers (watch handlers, MCP) can subscribe to (Phase 5)

### 2. Content hash implementation

For providers that support `contentHash` (Phase 3.5):
- Who computes the hash? The provider, from its canonical data representation?
- What's hashed? All fields, or a subset (title + status + content)?
- Is the hash format standardized (SHA-256) or provider-defined?

### 3. Reconciliation scope on reload

After `store.reload()`, should reconciliation target:
- **All provider-backed nodes** — complete but potentially expensive
- **Only nodes that changed in the reload** — requires diffing JSONL before/after
- **Only nodes with `provider_needs_reconcile`** — cheapest, but misses nodes that changed in the provider while the daemon was down
- **Changed nodes + needs_reconcile nodes** — balanced approach

### 4. Provider-specific reconciliation intervals

Should background sync support per-provider intervals? (Phase 5)

```json
{
  "reconciliation": {
    "backgroundInterval": 300000,
    "providerIntervals": {
      "beads": 30000,
      "global": 60000
    }
  }
}
```

Local filesystem providers (beads, sudocode) are cheap to reconcile and could run more frequently. Remote providers (future Jira, Linear) are expensive and should run less often. Is this worth the configuration complexity?

---

## References

- `src/providers/materialization.ts` — Materialization manager (local/remote paths)
- `src/graph/provider-store.ts` — Provider-aware store (`providerGet`, `providerUpdate`, `resolveForWrite`)
- `src/providers/sync.ts` — SyncableProvider interface (prior art for version/conflict tracking)
- `src/core/merge-driver.ts` — JSONL three-way merge driver
- `src/graph/store.ts` — `reload()` method (trigger point for reconciliation)
- `src/daemon/location-state.ts` — FileWatcher → reload trigger
- `src/providers/traits/Watchable.ts` — Watch trait (edge_source stamping point)
