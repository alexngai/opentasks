# Dependency Management

Set up dependency chains, query what's blocked and ready, manage work ordering.

## blocks vs depends-on

| Edge | Used by `ready` query | Cycle-checked | Use when |
|------|----------------------|---------------|----------|
| `blocks` | Yes | Yes | Work genuinely can't start until blocker closes |
| `depends-on` | No | No | "Nice to have first" but not strictly required |

## Setting Up Dependencies

### Linear chain: A → B → C → D

```bash
opentasks link --from t-aaa --to t-bbb --type blocks
opentasks link --from t-bbb --to t-ccc --type blocks
opentasks link --from t-ccc --to t-ddd --type blocks
```

### Diamond: A blocks B+C, both block D

```bash
opentasks link --from t-aaa --to t-bbb --type blocks
opentasks link --from t-aaa --to t-ccc --type blocks
opentasks link --from t-bbb --to t-ddd --type blocks
opentasks link --from t-ccc --to t-ddd --type blocks
```

B and C can run in parallel once A closes. D waits for both.

### Cycle detection

Creating a `blocks` edge that would form a cycle returns an error:

```bash
# Given: A blocks B, B blocks C
opentasks link --from t-ccc --to t-aaa --type blocks
# → { success: false, error: "Would create circular dependency" }
```

### Removing dependencies

```bash
opentasks link --from t-aaa --to t-bbb --type blocks --remove
```

## Querying

### What blocks a node?

```bash
# Direct blockers
opentasks query '{"blockers": {"nodeId": "t-ddd"}}'

# Full chain (transitive)
opentasks query '{"blockers": {"nodeId": "t-ddd", "transitive": true}}'

# Only active (non-closed, non-archived)
opentasks query '{"blockers": {"nodeId": "t-ddd", "activeOnly": true}}'
```

### What does a node block?

```bash
opentasks query '{"blocking": {"nodeId": "t-aaa", "transitive": true}}'
```

### What's ready to work on?

Returns open tasks with zero active blockers.

```bash
# All ready work
opentasks query '{"ready": {}}'

# Filtered
opentasks query '{"ready": {"tags": ["auth"], "priority": {"min": 0, "max": 2}, "limit": 5}}'
```

## Agent Work Loop

```
loop:
  1. opentasks query '{"ready": {"limit": 1}}'       → pick highest-priority unblocked issue
  2. If empty, stop.
  3. opentasks update t-x7k9 --status in_progress
  4. Do the work.
  5. opentasks update t-x7k9 --status closed
  6. opentasks query '{"blocking": {"nodeId": "t-x7k9"}}'  → see what's now unblocked
  7. Repeat.
```

## Cross-System Dependencies

`blocks` edges work across systems. The `ready` query evaluates them uniformly.

```bash
opentasks link --from "beads://./bd-setup" --to t-x7k9 --type blocks
opentasks link --from t-x7k9 --to "claude://current/t-abc" --type blocks
```

## Discovering Work During Implementation

```bash
# Create the discovered issue
opentasks create --type issue --title "Token refresh fails for expired sessions" --status open --tags auth,bug --priority 1
# → t-new1

# Link to where it was discovered
opentasks link --from t-new1 --to t-x7k9 --type discovered-from

# If it blocks current work:
opentasks link --from t-new1 --to t-x7k9 --type blocks

# Update original to blocked
opentasks update t-x7k9 --status blocked
```
