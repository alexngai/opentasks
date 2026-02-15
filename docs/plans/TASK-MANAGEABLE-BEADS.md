# TaskManageable Implementation: Beads Provider

## Overview

Add the `TaskManageable` trait to the Beads provider so that task lifecycle
operations (start, complete, block, reopen, close) route through `bd` CLI
commands and Beads-native ready-task queries participate in federated
`taskReady()` aggregation.

## Status Model

Beads issues use these statuses (from `bd` CLI):

| Native Status   | Semantic Meaning                        |
|-----------------|-----------------------------------------|
| `open`          | Not started                             |
| `in_progress`   | Actively being worked on                |
| `blocked`       | Waiting on a dependency                 |
| `closed`        | Completed or won't-do                   |
| `tombstone`     | Soft-deleted (already filtered by CRUD) |
| `pinned`        | Pinned for visibility                   |
| `hooked`        | Linked to external system               |
| `deferred`      | Postponed                               |

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
  supportsAssignment: true,    // bd issues have assignee field
  supportsReadyQuery: true,    // client-side: filter open issues without active blockers
  statusModel: ['open', 'in_progress', 'blocked', 'closed'],
}
```

## Method Implementations

### `transitionTask(id, action, context?)`

Delegates to `bd update <id> --status <mapped-status> --json` via `execBd()`.
Returns the updated `ProviderNode`.

Validation: throws `NOT_SUPPORTED` if action is not in `taskCapabilities.actions`
(currently all five are supported, so this is a safety guard).

### `readyTasks(options?, context?)`

Implementation: list all issues via `execBd(['list', '--json'])`, then
client-side filter:

1. Exclude tombstoned issues
2. Keep only `status === 'open'` issues
3. For each candidate, check `blockedBy` / `dependencies` — if any blocker
   has a non-closed status, the issue is not ready
4. Apply `options.tags`, `options.priority`, `options.assignee`, `options.limit`
5. Sort by priority (lower number = higher priority)

This is client-side filtering because `bd` CLI doesn't expose a native
`--ready` flag. The `supportsReadyQuery` flag is still `true` because the
provider can compute readiness from its own data.

### `assignTask(id, assignee, context?)` (optional)

Delegates to `bd update <id> --assignee <assignee> --json`.

### `validActions(id, context?)` (optional)

Fetches the issue via `get()` and returns valid next actions based on
current status:

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

## Dependencies

- `TaskManageable`, `TaskAction`, `TaskCapabilities`, `ReadyTaskOptions`
  from `./traits/TaskManageable.js`
- Existing `execBd()`, `parseJson()`, `beadsIssueToProviderNode()` helpers
