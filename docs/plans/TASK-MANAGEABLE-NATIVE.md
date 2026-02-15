# TaskManageable Implementation: Native Provider

## Overview

Add the `TaskManageable` trait to the Native provider so that task lifecycle
operations on local issues (`i-*` IDs) work through the `ProviderAwareStore`
task methods, and native issues participate in federated `taskReady()`
aggregation.

## Why Native Needs TaskManageable

The `resolveTaskProvider()` helper in `provider-store.ts:860-864` explicitly
checks whether the native provider is `TaskManageable` when handling local
non-external IDs. Without this trait, calling `taskTransition('i-x7k9', 'start')`
throws `NOT_SUPPORTED`. The native provider is the only route for managing
local issues through the task interface.

Additionally, `taskReady()` iterates all providers and only includes those
passing `isTaskManageable()`. Without this, native issues are invisible to
federated ready-task queries.

## Status Model

Native issues use the `Issue` schema statuses (from `src/schema/nodes.ts`):

| Native Status   | Semantic Meaning                 |
|-----------------|----------------------------------|
| `open`          | Not started                      |
| `in_progress`   | Actively being worked on         |
| `blocked`       | Waiting on dependency            |
| `closed`        | Completed or won't-do            |

## Action → Status Mapping

| TaskAction   | Target Status  | Notes                                    |
|--------------|----------------|------------------------------------------|
| `start`      | `in_progress`  | Begin work on the issue                  |
| `complete`   | `closed`       | Mark as done                             |
| `block`      | `blocked`      | Mark as blocked by dependency            |
| `reopen`     | `open`         | Re-open a closed/blocked issue           |
| `close`      | `closed`       | Close without completing (won't-do, etc) |

## TaskCapabilities Declaration

```typescript
taskCapabilities: {
  actions: ['start', 'complete', 'block', 'reopen', 'close'],
  supportsAssignment: true,    // Issue nodes have assignee field
  supportsReadyQuery: true,    // delegates to store.query.ready()
  statusModel: ['open', 'in_progress', 'blocked', 'closed'],
}
```

## Method Implementations

### `transitionTask(id, action, context?)`

1. Validate the node exists and is an issue (not spec/feedback/external)
2. Map action to target status
3. Build update payload: `{ status }`, plus `closed_at` for close/complete,
   clear `closed_at` for reopen
4. Call `store.updateNode(id, updates)`
5. Return as `ProviderNode`

### `readyTasks(options?, context?)`

Delegates to the existing `store.query.ready()` method, which already:
- Queries open, non-archived issues
- Checks for active blockers via `blocks` edges
- Sorts by priority
- Supports `limit`, `tags`, `priority`, `assignee` filters

Maps `ReadyTaskOptions` to `ReadyOptions` and converts results to
`ProviderNode[]`.

### `assignTask(id, assignee, context?)` (optional)

1. Validate the node is an issue
2. Call `store.updateNode(id, { assignee })`
3. Return as `ProviderNode`

### `validActions(id, context?)` (optional)

Fetches the node, checks current status, returns valid transitions:

| Current Status | Valid Actions                      |
|----------------|-----------------------------------|
| `open`         | `start`, `block`, `close`         |
| `in_progress`  | `complete`, `block`, `close`      |
| `blocked`      | `reopen`, `close`                 |
| `closed`       | `reopen`                          |

## Return Type Change

```typescript
// Before
Provider & RelationshipQueryable & Partial<Watchable>

// After
Provider & RelationshipQueryable & Partial<Watchable> & TaskManageable
```

## Design Advantages

- **Reuses `store.query.ready()`**: The native provider already has the
  full query engine with blocker resolution. No need to reimplement.
- **Direct store access**: No CLI calls, no serialization overhead.
  `transitionTask` is a single `updateNode()` call.
- **Completes the routing**: Without native TaskManageable, the federated
  task interface has a hole for the most common case (local issues).

## Dependencies

- `TaskManageable`, `TaskAction`, `TaskCapabilities`, `ReadyTaskOptions`
  from `./traits/TaskManageable.js`
- Existing `store` (GraphStore) instance
- `nodeToProviderNode()` helper
