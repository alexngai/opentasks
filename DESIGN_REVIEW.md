# OpenTasks Design Review: User Stories, Integration, and Missing Pieces

**Date**: 2026-02-04
**Reviewer**: Claude Code Review

---

## Executive Summary

This document analyzes OpenTasks from a **design intent and usage flow perspective**, examining how users/agents would actually integrate and use the system. While the architecture is well-designed with excellent documentation, there are significant gaps between what's documented and what's implemented.

**Key Findings**:
- **Agent Coordination**: Schema exists but zero implementation
- **Provider Sync**: Basic materialization works, but no conflict resolution or watch support
- **Metadata Context**: Fields defined but never populated or used
- **Multi-Agent**: No mechanism for agents to identify themselves or claim work

---

## 1. INTENDED USER WORKFLOWS

### 1.1 Spec-Driven Development (Primary Workflow)

**What Should Happen**:
```
1. Create Spec (requirements)
   └── Spec contains intent, acceptance criteria

2. Create Issues (work items)
   └── Each issue is a discrete, actionable task

3. Link Issues to Spec
   └── issue --implements--> spec

4. Create Dependencies
   └── issue1 --blocks--> issue2

5. Query Ready Work
   └── Find issues with no active blockers

6. Claim Work (MISSING)
   └── Agent locks issue to prevent conflicts

7. Execute Work
   └── Agent performs the task

8. Add Feedback
   └── Comments, suggestions linked back to spec

9. Complete and Release
   └── Close issue, release lock
```

**What Actually Works**:
- ✅ Steps 1-5 (create, link, query)
- ❌ Step 6 (claiming not implemented)
- ⚠️ Step 7 (works but no tracking)
- ⚠️ Step 8 (feedback creates nodes but no routing to external systems)
- ⚠️ Step 9 (close works, no lock to release)

### 1.2 Multi-Agent Coordination

**Intended Flow**:
```
Agent A                    Agent B
   │                          │
   ├─── Check ready items ────┤
   │                          │
   ├─── Claim issue-1 ────────│ (exclusive lock)
   │                          ├─── Claim issue-2
   │                          │
   ├─── Work on issue-1       ├─── Work on issue-2
   │                          │
   ├─── Add feedback          ├─── Add feedback
   │                          │
   └─── Close & release ──────└─── Close & release
```

**Current State**:
Agents operate independently with no coordination mechanism. Same issue can be "worked on" by multiple agents simultaneously.

### 1.3 Cross-Provider Integration

**Intended Flow**:
```
Native Issue (OpenTasks)
       │
       ├──implements──► Beads Spec (beads://./bd-123)
       │
       └──blocks──► Jira Issue (jira://PROJ-456)
```

**Current State**:
- ✅ Native ↔ Beads linking works
- ❌ Jira provider not implemented
- ❌ Linear provider not implemented
- ⚠️ No bidirectional sync (one-way cache only)

---

## 2. AGENT EXECUTION CONTEXT

### 2.1 The Problem: Anonymous Operations

Currently, all operations are anonymous. There's no way to answer:
- "Who created this node?"
- "Who is working on this?"
- "What has agent X done today?"

### 2.2 Schema Fields Exist But Unused

The schema defines coordination fields that are never used:

```typescript
// In StoredNode - DEFINED BUT UNUSED
claimed_by?: string      // Never set
claimed_at?: string      // Never set
lock_until?: string      // Never set

// In StoredEdge - DEFINED BUT UNUSED
created_by?: string      // Never set
```

### 2.3 What's Missing: Agent Context Flow

**Current Call Stack** (anonymous):
```
Agent
  └── OpenTasksClient (no context)
      └── IPCClient.request(method, params) // no agent info
          └── Daemon.handle(params) // no agent info
              └── store.createNode() // no tracking
```

**Required Call Stack** (with context):
```
Agent(id: 'agent-1')
  └── OpenTasksClient({ agentId: 'agent-1' })
      └── IPCClient.request(method, params, { agentId: 'agent-1' })
          └── Daemon.handle(params, context)
              └── store.createNode(input, { createdBy: 'agent-1' })
```

### 2.4 Recommended Fix: Context Parameter

```typescript
// Add to IPC types
interface OperationContext {
  agentId: string
  agentName?: string
  sessionId?: string
  timestamp: string
}

// Add to tool methods
export async function link(
  store: GraphStore,
  params: LinkParams,
  context?: OperationContext  // NEW
): Promise<LinkResult>

// Add to storage
await storage.createEdge({
  ...edge,
  created_by: context?.agentId  // NOW TRACKED
})
```

---

## 3. WORK CLAIMING AND LOCKING

### 3.1 The Problem: No Coordination

Multiple agents can work on the same issue simultaneously because there's no claiming mechanism.

### 3.2 Schema Is Ready, Implementation Is Missing

The schema has the right fields:
```typescript
claimed_by?: string    // WHO has claimed
claimed_at?: string    // WHEN claimed
lock_until?: string    // HOW LONG (soft lock)
```

But there's no API to use them:
```typescript
// THESE DON'T EXIST:
await store.claim(issueId, agentId, duration)
await store.release(issueId, agentId)
await store.renewClaim(issueId, agentId, duration)
```

### 3.3 Recommended Fix: Claim Manager

```typescript
interface ClaimManager {
  // Claim a node (sets claimed_by, claimed_at, lock_until)
  claim(nodeId: string, agentId: string, durationMs: number): Promise<boolean>

  // Release a claim (clears fields)
  release(nodeId: string, agentId: string): Promise<void>

  // Extend lock
  renew(nodeId: string, agentId: string, durationMs: number): Promise<boolean>

  // Check claim status
  getClaim(nodeId: string): Promise<ClaimInfo | null>

  // Query for unclaimed/expired items
  getUnclaimedReady(options?: ReadyOptions): Promise<Issue[]>
}

// Usage
const claimed = await claimManager.claim(issueId, 'agent-1', 30 * 60 * 1000)
if (claimed) {
  try {
    await doWork(issueId)
  } finally {
    await claimManager.release(issueId, 'agent-1')
  }
}
```

---

## 4. PROVIDER SYNCHRONIZATION GAPS

### 4.1 Current Architecture (Simplified)

```
┌─────────────────┐     ┌─────────────────┐
│  Native Store   │     │    Provider     │
│  (SQLite/JSONL) │────►│  (Beads, etc.)  │
└─────────────────┘     └─────────────────┘
        │                       │
        ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│ HydratingGraph  │◄───►│ MaterializeMgr  │
└─────────────────┘     └─────────────────┘
```

### 4.2 What Works

- **On-demand materialization**: External nodes fetched when needed
- **TTL-based staleness**: 5-minute default cache
- **Background sync**: Optional interval-based refresh
- **Debounced persistence**: Efficient write batching

### 4.3 What's Missing

#### No Watch/Push Support
```typescript
// Interface defines watch() but it's never used
watch?(callback: WatchCallback): Unsubscribe

// Daemon doesn't subscribe to provider changes
// Changes only detected via polling (background sync)
```

#### No Conflict Resolution
```
Timeline:
  T0: User reads external issue (cached)
  T1: External system modifies issue
  T2: User modifies cached copy
  T3: ??? How to resolve?

Current: Last-write-wins (silent data loss)
Needed: Conflict detection + merge strategy
```

#### No Bidirectional Sync
```
Current Flow:
  External → (materialize) → OpenTasks

Missing Flow:
  OpenTasks → (sync back) → External
```

### 4.4 Recommended Fixes

**Priority 1: Watch Support**
```typescript
// In daemon startup
for (const provider of registry.providers) {
  if (provider.watch) {
    provider.watch((event) => {
      if (event.type === 'update') {
        hydratingGraph.invalidateNode(event.uri)
      }
    })
  }
}
```

**Priority 2: Conflict Detection**
```typescript
interface SyncState {
  localVersion: number
  remoteVersion: number
  lastSyncAt: string
}

// Before write-back to provider
if (localVersion !== remoteVersion) {
  throw new ConflictError({
    local: localData,
    remote: remoteData,
    resolution: 'manual' | 'local-wins' | 'remote-wins'
  })
}
```

---

## 5. METADATA AND EXTENSIBILITY

### 5.1 Current Metadata Usage

```typescript
// Defined in schema
metadata?: Record<string, unknown>

// Used for:
// - Nothing in core code
// - Tests use it occasionally
// - No standard conventions
```

### 5.2 Recommended Metadata Conventions

```typescript
interface StandardMetadata {
  // Execution context
  execution?: {
    started_at: string
    completed_at?: string
    duration_ms?: number
    agent_id?: string
  }

  // Work tracking
  tracking?: {
    estimated_minutes?: number
    actual_minutes?: number
    complexity?: 'trivial' | 'simple' | 'moderate' | 'complex'
  }

  // Integration
  external?: {
    synced_from?: string      // e.g., 'jira://PROJ-123'
    synced_at?: string
    external_version?: string
  }

  // Custom fields (namespaced)
  custom?: Record<string, unknown>
}
```

### 5.3 Metadata Querying (Missing)

Currently cannot query by metadata. Needed:
```typescript
// Find all issues estimated > 30 minutes
await store.query.nodes({
  type: 'issue',
  metadata: { 'tracking.estimated_minutes': { $gt: 30 } }
})

// Find all unsynced external nodes
await store.query.nodes({
  type: 'external',
  metadata: { 'external.synced_at': { $exists: false } }
})
```

---

## 6. EXECUTION HISTORY AND AUDIT TRAIL

### 6.1 The Problem: No History

Cannot answer:
- "What operations happened on this node?"
- "Who made this change?"
- "When was this modified and by whom?"

### 6.2 Current State

Only timestamps tracked:
```typescript
created_at: string   // When created
updated_at: string   // When last modified
// WHO modified? Unknown
// WHAT changed? Unknown
```

### 6.3 Recommended: Operation Log

```typescript
interface OperationLog {
  id: string
  timestamp: string
  nodeId: string
  operation: 'create' | 'update' | 'delete' | 'link' | 'unlink'
  agentId: string
  changes?: {
    field: string
    before: unknown
    after: unknown
  }[]
}

// Storage in SQLite
CREATE TABLE operation_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  changes JSON,
  INDEX idx_node (node_id),
  INDEX idx_agent (agent_id),
  INDEX idx_timestamp (timestamp)
);

// Query API
await store.getHistory(nodeId, { limit: 10 })
await store.getAgentActivity(agentId, { since: '2024-01-01' })
```

---

## 7. INTEGRATION SCENARIOS

### 7.1 Scenario: Sync with Jira

**User Story**: "Link my OpenTasks issues to Jira tickets for team visibility"

**Required Components** (Missing):
1. JiraProvider implementation
2. OAuth authentication flow
3. Field mapping (status, priority, assignee)
4. Bidirectional sync (changes flow both ways)
5. Conflict resolution for concurrent edits

**Current Gap**: JiraProvider is documented but not implemented.

### 7.2 Scenario: Multi-Agent Task Execution

**User Story**: "Multiple Claude agents work on issues in parallel"

**Required Components** (Partially Missing):
1. ✅ Query ready items
2. ❌ Claim work (locks issue)
3. ❌ Track who's working on what
4. ⚠️ Blocking relationships work
5. ❌ Release work when done
6. ❌ Handle claim expiry

**Current Gap**: Agents can work on same item simultaneously with no coordination.

### 7.3 Scenario: Feedback Loop

**User Story**: "Agent provides feedback on spec while implementing"

**Required Components** (Partially Implemented):
1. ✅ Create feedback node
2. ✅ Link feedback to spec
3. ✅ Link feedback to source issue
4. ❌ Route feedback to external system (if spec is external)
5. ❌ Notify stakeholders
6. ⚠️ Resolve/dismiss feedback works locally

**Current Gap**: Feedback stays in OpenTasks, doesn't sync to external systems.

---

## 8. RECOMMENDED IMPLEMENTATION PRIORITIES

### Phase 1: Critical Fixes (Week 1)
1. ~~Fix crypto import in HydratingFederatedGraph.ts~~ ✅ DONE
2. ~~Fix transaction isolation in store.ts~~ ✅ DONE
3. ~~Fix empty UUID strings~~ ✅ DONE

### Phase 2: Agent Context (Week 2)
1. Add `OperationContext` parameter to IPC layer
2. Add `agentId` to tool parameters
3. Populate `created_by` on nodes and edges
4. Add context to daemon method handlers

### Phase 3: Work Claiming (Week 3)
1. Implement `ClaimManager` with claim/release/renew
2. Update `ready()` query to respect claims
3. Add claim checking to update operations
4. Add claim status to node queries

### Phase 4: Provider Sync (Week 4)
1. Implement provider watch subscriptions in daemon
2. Add conflict detection to materialization
3. Implement write-back for bidirectional sync
4. Add sync status tracking

### Phase 5: Audit Trail (Week 5)
1. Add operation_log table to SQLite
2. Log all mutations with agent context
3. Add query APIs for history
4. Add retention policy for log cleanup

### Phase 6: External Providers (Weeks 6-8)
1. Implement JiraProvider
2. Implement LinearProvider
3. Add authentication flows
4. Add field mapping configuration

---

## 9. ARCHITECTURAL OBSERVATIONS

### 9.1 Design Philosophy (From DESIGN.md)

> "OpenTasks provides the graph; coordination built on top"

This means:
- Schema has coordination fields (correct)
- Enforcement is advisory (correct)
- But advisory layer isn't implemented (incorrect)

### 9.2 Schema Is Ready

The data model is well-designed:
- ✅ Node types (spec, issue, feedback, external)
- ✅ Edge types (blocks, implements, references, etc.)
- ✅ Coordination fields (claimed_by, lock_until)
- ✅ Extensible metadata

The problem is implementation, not design.

### 9.3 Test Infrastructure Is Ready

The E2E test framework exists:
- TestAgent helper class
- Mock providers
- System bootstrap helpers

But many tests are skipped (`skipIf(!AGENT_TESTS)`) because infrastructure isn't complete.

---

## 10. FILES REQUIRING CHANGES

### For Agent Context
| File | Change |
|------|--------|
| `src/daemon/types.ts` | Add OperationContext type |
| `src/daemon/ipc.ts` | Pass context through IPC |
| `src/daemon/methods/tools.ts` | Accept context parameter |
| `src/tools/link.ts` | Use context for created_by |
| `src/tools/query.ts` | Include agent info in results |
| `src/client/client.ts` | Accept agent config |

### For Claiming
| File | Change |
|------|--------|
| `src/graph/store.ts` | Add ClaimManager methods |
| `src/graph/query.ts` | Respect claims in ready() |
| `src/tools/types.ts` | Add claim tool params |
| `src/daemon/methods/graph.ts` | Add claim handlers |

### For Provider Sync
| File | Change |
|------|--------|
| `src/daemon/lifecycle.ts` | Subscribe to provider watches |
| `src/providers/materialization.ts` | Add conflict detection |
| `src/graph/HydratingFederatedGraph.ts` | Add write-back support |

---

## Summary

OpenTasks has **excellent architecture** with the right schema and abstractions. The gaps are in **implementation**, not design. The highest priority items are:

1. **Agent context flow** - Let operations know who's making them
2. **Work claiming** - Prevent concurrent work on same items
3. **Provider sync** - Make external integration reliable

With these additions, the system would be production-ready for multi-agent coordination workflows.

---

*End of Design Review*
