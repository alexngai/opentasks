# TaskManageable Implementation: Sudocode Provider

## Overview

Add the `TaskManageable` trait to the Sudocode provider so that issue
lifecycle operations route through `sudocode` CLI commands and Sudocode
issues participate in federated `taskReady()` aggregation.

Note: Only **issues** have status in Sudocode. Specs use `draft`/`active`/
`archived` but are not task-workflowed. The TaskManageable implementation
operates exclusively on issue entities (`i-*` IDs).

## Status Model

Sudocode issues use these statuses (from schema `Issue.status`):

| Native Status   | Semantic Meaning                 |
|-----------------|----------------------------------|
| `open`          | Not started                      |
| `in_progress`   | Actively being worked on         |
| `blocked`       | Waiting on a dependency          |
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
  supportsAssignment: true,    // sudocode issues have assignee field
  supportsReadyQuery: true,    // client-side: filter open issues without active blockers
  statusModel: ['open', 'in_progress', 'blocked', 'closed'],
}
```

## Method Implementations

### `transitionTask(id, action, context?)`

Validates the ID is an issue (not a spec). Delegates to:
`sudocode --json issue update <id> -s <mapped-status>`

Returns the updated `ProviderNode`.

Throws `NOT_SUPPORTED` if called with a spec ID (specs are not task-managed).

### `readyTasks(options?, context?)`

Implementation: read issues from JSONL (via existing `readEntitiesFromJsonl('issue')`),
then client-side filter:

1. Exclude archived issues
2. Keep only `status === 'open'` issues
3. For each candidate, check `relationships` for incoming `blocks`/`depends-on`
   edges — if any blocker has non-closed status, the issue is not ready
4. Apply `options.tags`, `options.priority`, `options.assignee`, `options.limit`
5. Sort by priority (lower number = higher priority)

To check blocker status, the provider resolves each blocker ID via
`findEntityById()`. This is O(n*m) but acceptable for typical project sizes.

### `assignTask(id, assignee, context?)` (optional)

Validates the ID is an issue. Delegates to:
`sudocode --json issue update <id> --assignee <assignee>`

### `validActions(id, context?)` (optional)

Fetches the issue and returns valid next actions based on current status:

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

## Design Decisions

- **Specs are excluded**: `transitionTask` throws if called with a spec ID.
  Specs don't participate in task workflows.
- **Ready computation is client-side**: Sudocode CLI doesn't have a native
  `ready` query. The provider reads JSONL and filters locally.
- **Blocker resolution**: Uses `findEntityById()` to check blocker status.
  This reads from JSONL first, falling back to CLI — efficient for local data.

## Dependencies

- `TaskManageable`, `TaskAction`, `TaskCapabilities`, `ReadyTaskOptions`
  from `./traits/TaskManageable.js`
- Existing `execSudocode()`, `parseJson()`, `readEntitiesFromJsonl()`,
  `findEntityById()`, `entityToProviderNode()`, `entityTypeFromId()` helpers
