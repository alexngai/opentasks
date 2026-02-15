# Feedback and Review

Leave feedback on context and tasks, manage suggestion lifecycles, query unresolved items.

## Feedback Types

| Type | Use For |
|------|---------|
| `comment` | Status updates, implementation notes, observations |
| `suggestion` | Proposed changes to target content |
| `request` | Action needed — blocking questions, approvals |

## Creating Feedback

### Basic comment

```bash
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Implemented OAuth. Deferred SAML to follow-up.","type":"comment"}}'
```

### Implementation feedback (linked to source issue)

```bash
opentasks annotate '{"targetId":"c-a2b3","fromId":"t-x7k9","create":{"content":"Google OAuth requires access_type=offline for refresh tokens — added to config.","type":"comment"}}'
```

`fromId` creates a link from the task to the feedback for traceability.

### Anchored suggestion

```bash
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Rate limiting needed here — OAuth endpoints are brute-force targets.","type":"suggestion","anchor":{"line":15,"text":"OAuth2 endpoints"}}}'
```

Anchors use `line` (exact), `text` (fuzzy match), or both. Text anchors survive content edits better.

### Blocking request

```bash
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Which GitHub OAuth scopes? Spec says user profile but integration may need repo access.","type":"request"}}'
```

## Querying Feedback

```bash
# All feedback on a node
opentasks query '{"feedback": {"nodeId": "c-a2b3"}}'

# Unresolved suggestions only
opentasks query '{"feedback": {"nodeId": "c-a2b3", "type": "suggestion", "resolved": false}}'

# All unresolved feedback globally
opentasks query '{"unresolvedFeedback": {}}'

# Unresolved feedback for a specific target
opentasks query '{"unresolvedFeedback": {"targetId": "c-a2b3"}}'
```

## Lifecycle Management

```bash
# Resolve (addressed)
opentasks annotate '{"targetId":"c-a2b3","resolve":"f-t1u2"}'

# Dismiss (not applicable)
opentasks annotate '{"targetId":"c-a2b3","dismiss":"f-t1u2"}'

# Reopen
opentasks annotate '{"targetId":"c-a2b3","reopen":"f-t1u2"}'
```

## Review Workflow

```bash
# 1. Read spec
opentasks get c-a2b3

# 2. Check existing feedback
opentasks query '{"feedback": {"nodeId": "c-a2b3"}}'

# 3. Leave feedback
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"...","type":"comment"}}'

# 4. Before implementing — check unresolved
opentasks query '{"feedback": {"nodeId": "c-a2b3", "resolved": false}}'

# 5. After addressing — resolve
opentasks annotate '{"targetId":"c-a2b3","resolve":"f-abc1"}'
```

## Cross-System Feedback

When source and target are in different systems, OpenTasks stores the feedback (native systems can't handle cross-refs).

```bash
# Beads issue commenting on Taskmaster spec
opentasks annotate '{"targetId":"taskmaster://./auth-prd","fromId":"beads://./bd-x7k9","create":{"content":"Sections 1-3 done. Section 4 descoped.","type":"comment"}}'
```

Same-system feedback routes to native comments when the provider supports them.
