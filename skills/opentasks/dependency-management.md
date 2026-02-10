# Dependency Management

Set up dependency chains, query what's blocked and ready, manage work ordering.

## blocks vs depends-on

| Edge | Used by `ready` query | Cycle-checked | Use when |
|------|----------------------|---------------|----------|
| `blocks` | Yes | Yes | Work genuinely can't start until blocker closes |
| `depends-on` | No | No | "Nice to have first" but not strictly required |

## Setting Up Dependencies

### Linear chain: A → B → C → D

```json
// tools.link
{ "fromId": "i-aaa", "toId": "i-bbb", "type": "blocks" }
{ "fromId": "i-bbb", "toId": "i-ccc", "type": "blocks" }
{ "fromId": "i-ccc", "toId": "i-ddd", "type": "blocks" }
```

### Diamond: A blocks B+C, both block D

```json
{ "fromId": "i-aaa", "toId": "i-bbb", "type": "blocks" }
{ "fromId": "i-aaa", "toId": "i-ccc", "type": "blocks" }
{ "fromId": "i-bbb", "toId": "i-ddd", "type": "blocks" }
{ "fromId": "i-ccc", "toId": "i-ddd", "type": "blocks" }
```

B and C can run in parallel once A closes. D waits for both.

### Cycle detection

Creating a `blocks` edge that would form a cycle returns an error:

```json
// Given: A blocks B, B blocks C
{ "fromId": "i-ccc", "toId": "i-aaa", "type": "blocks" }
// → { success: false, error: "Would create circular dependency" }
```

### Removing dependencies

```json
{ "fromId": "i-aaa", "toId": "i-bbb", "type": "blocks", "remove": true }
```

## Querying

### What blocks a node?

```json
// Direct blockers
{ "blockers": { "nodeId": "i-ddd" } }

// Full chain (transitive)
{ "blockers": { "nodeId": "i-ddd", "transitive": true } }

// Only active (non-closed, non-archived)
{ "blockers": { "nodeId": "i-ddd", "activeOnly": true } }
```

### What does a node block?

```json
{ "blocking": { "nodeId": "i-aaa", "transitive": true } }
```

### What's ready to work on?

Returns open issues with zero active blockers.

```json
// All ready work
{ "ready": {} }

// Filtered
{ "ready": { "tags": ["auth"], "priority": { "min": 0, "max": 2 }, "limit": 5 } }
```

## Agent Work Loop

```
loop:
  1. tools.query({ ready: { limit: 1 } })         → pick highest-priority unblocked issue
  2. If empty, stop.
  3. graph.update({ id: "i-x7k9", status: "in_progress" })
  4. Do the work.
  5. graph.update({ id: "i-x7k9", status: "closed" })
  6. tools.query({ blocking: { nodeId: "i-x7k9" } })  → see what's now unblocked
  7. Repeat.
```

## Cross-System Dependencies

`blocks` edges work across systems. The `ready` query evaluates them uniformly.

```json
{ "fromId": "beads://./bd-setup", "toId": "i-x7k9", "type": "blocks" }
{ "fromId": "i-x7k9", "toId": "claude://current/t-abc", "type": "blocks" }
```

## Discovering Work During Implementation

```json
// Create the discovered issue
// graph.create
{ "type": "issue", "title": "Token refresh fails for expired sessions", "status": "open", "tags": ["auth", "bug"], "priority": 1 }
// → i-new1

// Link to where it was discovered
// tools.link
{ "fromId": "i-new1", "toId": "i-x7k9", "type": "discovered-from" }

// If it blocks current work:
{ "fromId": "i-new1", "toId": "i-x7k9", "type": "blocks" }

// Update original to blocked
// graph.update
{ "id": "i-x7k9", "status": "blocked" }
```
