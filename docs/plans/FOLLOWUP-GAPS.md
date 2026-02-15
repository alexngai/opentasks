# Phase 2 + Phase 3: Implementation Gaps & Weaknesses

Post-implementation review of the worktree/multi-location system.
Each item includes severity, what the context requires, what we built, and a proposed fix.

---

## Critical Gaps

### 1. No daemon integration (Phase 3 §1)

**Spec requires:** Single daemon per git repo at `.git/opentasks/daemon.sock` managing all worktrees — multi-location SQLite connections, IPC with `location` parameter, auto-start, `.git/HEAD` watcher for branch caching, graceful shutdown.

**What we built:** All operations (registry reads/writes, health checks, queries) happen via direct filesystem access. No daemon involvement.

**Impact:**
- No write serialization across locations (only per-file locking within a single location)
- No branch caching (conditional redirects require caller to provide branch)
- No in-process query routing (cross-location queries open/close SQLite each time)
- No auto-start lifecycle

**Proposed fix:** Extend the existing `src/daemon/` infrastructure:
- Add `location` field to IPC request protocol
- Hold a `Map<hash, { db, storage }>` of SQLite connections
- Route requests to the correct storage by location hash
- Watch `.git/HEAD` and cache branch name for conditional redirects
- Register/unregister LocationProviders on connection changes

**Effort:** Large — this is the backbone that ties Phase 2+3 modules together.

---

### 2. `follow-refs` expansion mode doesn't follow references (Phase 3 §3)

**Spec requires:** `follow-refs` should analyze local edges, identify which point to other locations via `opentasks://` URIs, and only query those specific locations.

**What we built:** `follow-refs`, `connections`, and `all` all do the same thing — query every connected provider indiscriminately.

```typescript
// expansion.ts:155-176 — all non-none modes are identical
if (mode === 'none') { ... }
// For follow-refs, connections, and all — query connected locations
const { connected, ... } = await queryConnectedReady(locationProviders, maxLocations)
```

**Impact:** No way to do targeted cross-location lookups. A query about a single node that references one remote location ends up querying all 10 connected locations.

**Proposed fix:**
- `follow-refs`: Query local edges, parse `opentasks://` URIs in edge targets, resolve to location hashes, query only those specific providers
- `connections`: Query all connected providers (current behavior)
- `all`: Union of both strategies

**Effort:** Medium — requires edge analysis + URI parsing in the expansion path.

---

### 3. `opentasks discover` command missing (Phase 3 §7)

**Spec requires:** `opentasks discover [--direction up|down|both] [--max-depth 5]` for finding nearby opentasks locations by walking the filesystem.

**What we built:** Nothing.

**Impact:** Users must manually specify connection paths. No way to auto-detect sibling worktrees or parent/child locations.

**Proposed fix:** Implement filesystem walker:
- Walk up from cwd looking for `.opentasks/config.json` (parent discovery)
- Walk down into immediate subdirectories (child discovery)
- Read each found config to extract hash/name
- Output discovered locations with path + hash + name

**Effort:** Small-medium — straightforward filesystem traversal.

---

## Significant Design Weaknesses

### 4. Redirect resolution uses `__placeholder__` hack

**Location:** `src/core/redirects.ts:131`

```typescript
const resolved = resolveOpentasksUri(
  uri.endsWith('/') ? uri + '__placeholder__' : uri, ...
)
```

**Problem:** Redirect targets identify a *location*, not a specific node. But `resolveOpentasksUri` requires a node ID. The hack injects `"__placeholder__"` as the node ID, which leaks into the returned `ResolvedLocation.nodeId`.

**Proposed fix:** Add a `resolveOpentasksLocation()` function that resolves just the location part of a URI (or a bare hash) without requiring a node ID. Then `resolveRedirect` calls that instead.

**Effort:** Small.

---

### 5. Redirect depth tracking is dead code

**Location:** `src/core/redirects.ts:115-118`

```typescript
if (depth >= MAX_REDIRECT_DEPTH) {
  throw new Error(`Redirect depth exceeded maximum of ${MAX_REDIRECT_DEPTH} hops`)
}
```

**Problem:** `resolveRedirect` accepts `depth` but never recurses. If location A redirects to B which redirects to C, only the A→B hop is resolved. The depth check never triggers.

**Proposed fix:** `resolveOperationRedirect` should check if the resolved target location also has redirect rules, and recursively resolve with `depth + 1`. This requires loading the target's config to read its redirects — which is where daemon integration (gap #1) would help.

**Effort:** Medium — requires reading target config and recursive resolution. Tightly coupled with daemon integration.

---

### 6. Conditional redirects not integrated into redirect resolution

**Location:** `src/core/conditional-redirects.ts` exists separately from `src/core/redirects.ts`

**Problem:** The main redirect flow (`resolveOperationRedirect`) calls `findRedirectRule()` which has no concept of conditions. `findConditionalRedirectRule()` exists but nothing calls it during actual operation. The two modules are parallel, not composed.

**Proposed fix:** Either:
- (a) Replace `findRedirectRule` with `findConditionalRedirectRule` everywhere (backward-compatible since `when` is optional), or
- (b) Have `resolveOperationRedirect` accept an optional `RedirectContext` and delegate to the conditional finder when context is present

Option (a) is cleaner — make `ConditionalRedirectRule` the only rule type.

**Effort:** Small — mostly wiring.

---

### 7. `crossLocationEdges` missing from `ExpandedResult`

**Location:** `src/graph/expansion.ts`

**Spec defines:**
```typescript
interface ExpandedResult {
  crossLocationEdges: Edge[]  // Edges spanning locations
}
```

**What we built:** `ExpandedResult` has `local`, `connected`, `queriedLocations`, `unreachableLocations`, `completeness` — but no `crossLocationEdges`.

**Impact:** The caller has no way to know which edges span locations. This is the primary data needed for rendering cross-location dependency graphs.

**Proposed fix:** After querying connected locations, scan local edges for any where `from_id` or `to_id` appears in a connected result set. Collect these as `crossLocationEdges`.

**Effort:** Small-medium — requires edge scanning after queries complete.

---

### 8. Query expansion queries providers sequentially

**Location:** `src/graph/expansion.ts:101-114`, `117-145`

```typescript
for (const [hash, provider] of providers.entries()) {
  // ... await provider.ready()
}
```

**Problem:** With 5 connected locations, queries run in series. If each takes 100ms, that's 500ms instead of ~100ms.

**Proposed fix:** Use `Promise.allSettled` to query all providers in parallel:
```typescript
const results = await Promise.allSettled(
  [...providers.entries()].map(([hash, provider]) =>
    provider.ready().then(nodes => ({ hash, nodes }))
  )
)
```
Fulfilled results go into `connected`, rejected into `unreachableLocations`.

**Effort:** Small.

---

## Moderate Issues

### 9. `worktreeSetup` doesn't install merge driver

**Location:** `src/core/worktree.ts:200-352`

**Problem:** The spec's setup flow includes `installMergeDriver(targetPath)` as a step. The CLI calls `installMergeDriver` during `init` but not during `worktree setup`. New worktrees won't have `.gitattributes` configured for JSONL merge.

**Proposed fix:** Add `installMergeDriver(resolvedTarget)` call after writing worker config in `worktreeSetup`.

**Effort:** Trivial.

---

### 10. LocationProvider not registered in existing ProviderRegistry

**Location:** `src/providers/location.ts`

**Problem:** The spec says "Connected opentasks locations register as providers in the existing ProviderRegistry". But `LocationProvider` is standalone. The existing `HydratingFederatedGraph.ready()` won't discover cross-location blockers.

**Proposed fix:** In daemon startup (gap #1), after initializing LocationProviders, register each in the existing `ProviderRegistry`. This requires adapting `LocationProvider` to match the registry's registration API.

**Effort:** Medium — tightly coupled with daemon integration.

---

### 11. `installMergeDriver` uses `require()` in ESM context

**Location:** `src/core/merge-driver.ts:285`

```typescript
const { execSync } = require('node:child_process')
```

**Problem:** The file is an ES module but uses CommonJS `require()`. This works in Node with certain configurations but is incorrect and may break in strict ESM environments.

**Proposed fix:** Use the top-level `import { execSync } from 'node:child_process'` that already exists in other files like `worktree.ts`.

**Effort:** Trivial.

---

### 12. Hardcoded LIMIT 100 in LocationProvider

**Location:** `src/providers/location.ts` — `list()` method

```sql
SELECT * FROM nodes WHERE ... ORDER BY updated_at DESC LIMIT 100
```

**Problem:** Large locations silently return incomplete results. No pagination support.

**Proposed fix:** Accept `limit` and `offset` in `ProviderFilter`, default to a higher limit (e.g., 1000), and pass through to SQL.

**Effort:** Small.

---

### 13. No concurrency protection on worktree registry

**Location:** `src/core/worktree.ts` — `registerWorktree`, `unregisterWorktree`

**Problem:** The registry file (`worktrees.json`) is read-modify-written without any locking. Concurrent `worktreeSetup`/`worktreeTeardown` calls can lose writes.

**Proposed fix:** Either:
- (a) Use `FileLock` around registry writes (quick fix), or
- (b) Route all registry writes through the daemon (proper fix, depends on gap #1)

**Effort:** Small for (a), part of gap #1 for (b).

---

## Minor Issues

### 14. URI parser doesn't validate hash format

**Location:** `src/core/uri.ts:88-101`

`parseOpentasksUri("opentasks://NOT-VALID/node")` succeeds with `locationHash: "NOT-VALID"`. Resolution catches it later, but early validation gives better errors.

**Proposed fix:** After extracting `hashPart`, check `isValidLocationHash(hashPart)` and return `null` if invalid.

**Effort:** Trivial.

---

### 15. Edge deduplication has fragile timestamp comparison

**Location:** `src/storage/locked-writer.ts` — `deduplicateEdges`

If neither edge has `created_at`, the first one wins silently. If only the existing has `created_at`, it wins even if the incoming is newer.

**Proposed fix:** When timestamps are missing, prefer the incoming entry (last-write-wins semantics).

**Effort:** Trivial.

---

### 16. Merge driver CLI doesn't catch errors

**Location:** `src/cli.ts` — `cmdMergeDriver`

If `mergeJsonl` throws (file not found, parse error), the process crashes with a stack trace instead of returning exit code 1 as git expects.

**Proposed fix:** Wrap in try/catch, print error to stderr, `process.exit(1)`.

**Effort:** Trivial.

---

### 17. LocationConfigSchema transform fails on partial input

**Location:** `src/config/schema.ts`

If a manually-edited config has `location: { hash: "abc" }` without `uuid`, the Zod transform rejects it. Real-world configs may be hand-edited or partially migrated.

**Proposed fix:** Make `uuid` and `name` optional in the inner schema with defaults (generate UUID, default name to empty string).

**Effort:** Small.

---

## Proposed Fix Order

Prioritized by impact and dependency chain:

| Priority | Items | Rationale |
|----------|-------|-----------|
| P0 | 4, 11, 9, 16 | Trivial fixes, immediate code quality improvement |
| P1 | 6, 8, 14, 15, 17 | Small fixes that improve correctness |
| P2 | 2, 7 | Medium fixes that make query expansion actually useful |
| P3 | 5, 12, 13 | Moderate fixes, some depend on daemon |
| P4 | 1, 10 | Daemon integration — large effort, enables everything else |
| P5 | 3 | Discovery command — nice-to-have, independent |

The P0 and P1 items can all be done immediately. P2 makes the expansion system actually work as designed. P4 (daemon) is the big-ticket item that unlocks P3 fully and is required for production use.
