# Skill: Dependency Management

Set up dependency chains between issues, query what's blocked and what's ready, and manage work ordering across systems.

## When to Use

- Breaking a feature into ordered steps where some must complete before others
- An agent needs to know what work is available right now
- Checking why an issue is stuck (transitive blocker chain)
- Managing parallel workstreams with shared prerequisites

## Edge Types for Dependencies

| Edge Type | Semantics | Cycle Detection |
|-----------|-----------|-----------------|
| `blocks` | Hard dependency — `from` must close before `to` can start. Used by `ready` queries. | Yes |
| `depends-on` | Soft dependency — informational only. Not checked by `ready` queries. | No |

Use `blocks` when the dependency actually prevents work. Use `depends-on` when it's "nice to have done first" but not strictly required.

## Pattern: Linear Dependency Chain

```
A → B → C → D
(A blocks B, B blocks C, C blocks D)
```

```json
// RPC: tools.link
{ "fromId": "i-aaa", "toId": "i-bbb", "type": "blocks" }
{ "fromId": "i-bbb", "toId": "i-ccc", "type": "blocks" }
{ "fromId": "i-ccc", "toId": "i-ddd", "type": "blocks" }
```

Ready query returns only `i-aaa`. As each completes, the next becomes ready.

## Pattern: Diamond Dependency

```
    A
   / \
  B   C
   \ /
    D
```

Both B and C must complete before D is ready. B and C can run in parallel once A is done.

```json
// RPC: tools.link
{ "fromId": "i-aaa", "toId": "i-bbb", "type": "blocks" }
{ "fromId": "i-aaa", "toId": "i-ccc", "type": "blocks" }
{ "fromId": "i-bbb", "toId": "i-ddd", "type": "blocks" }
{ "fromId": "i-ccc", "toId": "i-ddd", "type": "blocks" }
```

## Cycle Detection

`blocks` edges are cycle-checked. If you try to create an edge that would form a cycle:

```json
// Given: A blocks B, B blocks C
// RPC: tools.link
{ "fromId": "i-ccc", "toId": "i-aaa", "type": "blocks" }
// Returns: { success: false, error: "Would create circular dependency" }
```

Other edge types (`depends-on`, `references`, etc.) are not cycle-checked.

## Querying Dependencies

### What blocks this issue? (direct)

```json
// RPC: tools.query
{
  "blockers": {
    "nodeId": "i-ddd"
  }
}
// Returns: [i-bbb, i-ccc] (direct blockers only)
```

### What blocks this issue? (transitive)

```json
// RPC: tools.query
{
  "blockers": {
    "nodeId": "i-ddd",
    "transitive": true
  }
}
// Returns: [i-aaa, i-bbb, i-ccc] (full chain)
```

### Only active blockers (ignore closed ones)

```json
// RPC: tools.query
{
  "blockers": {
    "nodeId": "i-ddd",
    "activeOnly": true
  }
}
// If i-aaa is closed, returns only [i-bbb, i-ccc] (or fewer if they're also closed)
```

### What does this issue block?

```json
// RPC: tools.query
{
  "blocking": {
    "nodeId": "i-aaa"
  }
}
// Returns: [i-bbb, i-ccc] (direct)

// Transitive:
{
  "blocking": {
    "nodeId": "i-aaa",
    "transitive": true
  }
}
// Returns: [i-bbb, i-ccc, i-ddd]
```

## Querying Ready Work

The `ready` query returns open issues with **no active (non-closed) blockers**.

### All ready work

```json
// RPC: tools.query
{ "ready": {} }
```

### Ready work with filters

```json
// RPC: tools.query
{
  "ready": {
    "tags": ["auth"],
    "priority": { "min": 0, "max": 2 },
    "assignee": "agent-1",
    "limit": 10
  }
}
```

### How "ready" works

1. Finds all issues with `status` != `closed` and `archived` != `true`
2. For each, checks if any `blocks` edges point to it from non-closed issues
3. Returns only issues with zero active blockers

## Pattern: Agent Work Loop

An agent that picks up and executes ready work:

```
loop:
  1. Query ready work:
     tools.query({ ready: { limit: 1 } })
     → Returns highest-priority unblocked issue

  2. If no ready work, stop.

  3. Claim the issue:
     graph.update({ id: "i-x7k9", status: "in_progress" })

  4. Do the work.

  5. Mark complete:
     graph.update({ id: "i-x7k9", status: "closed" })

  6. Check what's now unblocked:
     tools.query({ blocking: { nodeId: "i-x7k9" } })
     → Shows what was waiting on this issue

  7. Go to 1.
```

## Removing Dependencies

```json
// RPC: tools.link
{
  "fromId": "i-aaa",
  "toId": "i-bbb",
  "type": "blocks",
  "remove": true
}
// Returns: { success: true }
```

## Cross-System Dependencies

Dependencies can span systems:

```json
// Beads issue blocks an OpenTasks issue
// RPC: tools.link
{
  "fromId": "beads://./bd-setup",
  "toId": "i-x7k9",
  "type": "blocks"
}

// OpenTasks issue blocks a Claude task
// RPC: tools.link
{
  "fromId": "i-x7k9",
  "toId": "claude://current/t-abc",
  "type": "blocks"
}
```

The `ready` query evaluates blockers across all systems — a Beads issue being closed unblocks an OpenTasks issue, which unblocks a Claude task.

## Pattern: Discovering New Work During Implementation

When working on an issue reveals something unexpected:

```json
// Create the discovered issue
// RPC: graph.create
{
  "type": "issue",
  "title": "Token refresh fails for expired sessions",
  "content": "Discovered during OAuth implementation: refresh tokens fail silently when the session has expired.",
  "status": "open",
  "tags": ["auth", "bug"],
  "priority": 1
}
// Returns: { id: "i-new1", ... }

// Link it back to the issue where it was found
// RPC: tools.link
{ "fromId": "i-new1", "toId": "i-x7k9", "type": "discovered-from" }

// If the new issue blocks the current work:
// RPC: tools.link
{ "fromId": "i-new1", "toId": "i-x7k9", "type": "blocks" }

// Update original issue to blocked
// RPC: graph.update
{ "id": "i-x7k9", "status": "blocked" }
```
