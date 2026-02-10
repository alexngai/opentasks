# Skill: Feedback and Review

Leave feedback on specs and issues, manage suggestion lifecycles, and query unresolved items across the graph.

## When to Use

- An agent finishes implementing a spec and wants to report what was done (or deferred)
- Reviewing a spec and leaving suggestions before implementation
- Tracking open questions or action items against a spec/issue
- Cross-system feedback (e.g., Beads issue commenting on a Taskmaster spec)

## Feedback Types

| Type | Use For |
|------|---------|
| `comment` | General observations, status updates, implementation notes |
| `suggestion` | Proposed changes to the target content |
| `request` | Action needed from someone (blocking question, approval needed) |

## Pattern: Implementation Feedback

After completing an issue that implements a spec, report back on what happened.

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "fromId": "i-x7k9",
  "create": {
    "content": "Implemented Google OAuth with PKCE. Deferred GitHub OAuth to follow-up — their API requires a different grant type than expected.",
    "type": "comment"
  }
}
// Returns: { success: true, feedbackId: "f-t1u2" }
```

The `fromId` creates a link from the issue to the feedback, so you can trace which implementation produced which comments.

## Pattern: Anchored Suggestions on a Spec

Leave feedback tied to a specific location in the spec content.

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "create": {
    "content": "Rate limiting should be added here — OAuth endpoints are prime brute-force targets.",
    "type": "suggestion",
    "anchor": {
      "line": 15,
      "text": "OAuth2 endpoints"
    }
  }
}
```

Anchors can use `line` (exact), `text` (fuzzy match), or both. The text anchor survives content edits better than line numbers alone.

## Pattern: Blocking Request

Flag something that needs resolution before work can continue.

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "create": {
    "content": "Which OAuth scopes should we request for GitHub? The spec says 'user profile' but we may need repo access for the integration features.",
    "type": "request"
  }
}
```

## Querying Feedback

### All feedback on a node

```json
// RPC: tools.query
{
  "feedback": {
    "nodeId": "s-a2b3"
  }
}
// Returns: FeedbackSummary[] with id, targetId, feedbackType, resolved, contentPreview
```

### Only unresolved suggestions

```json
// RPC: tools.query
{
  "feedback": {
    "nodeId": "s-a2b3",
    "type": "suggestion",
    "resolved": false
  }
}
```

### All unresolved feedback across the graph

```json
// RPC: tools.query
{
  "unresolvedFeedback": {}
}
// Returns all unresolved, non-dismissed feedback globally
```

### Unresolved feedback for a specific target

```json
// RPC: tools.query
{
  "unresolvedFeedback": {
    "targetId": "s-a2b3"
  }
}
```

## Managing Feedback Lifecycle

### Resolve (feedback was addressed)

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "resolve": "f-t1u2"
}
```

### Dismiss (feedback is not applicable)

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "dismiss": "f-t1u2"
}
```

### Reopen (re-evaluate previously resolved/dismissed feedback)

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "reopen": "f-t1u2"
}
```

## Pattern: Review Workflow

An agent reviewing a spec before implementation begins.

```
1. Read the spec:
   graph.get({ id: "s-a2b3" })
   → Returns full spec content

2. Check existing feedback:
   tools.query({ feedback: { nodeId: "s-a2b3" } })
   → See what's already been said

3. Leave review feedback:
   tools.annotate({
     targetId: "s-a2b3",
     create: {
       content: "The token refresh flow should handle concurrent refresh requests. Consider a mutex or single-flight pattern.",
       type: "suggestion",
       anchor: { section: "Requirements", text: "Token refresh flow" }
     }
   })

   tools.annotate({
     targetId: "s-a2b3",
     create: {
       content: "Missing: error handling for revoked OAuth tokens. Users should be redirected to re-auth.",
       type: "request"
     }
   })

4. Implementation agent checks feedback before starting:
   tools.query({ feedback: { nodeId: "s-a2b3", resolved: false } })
   → Sees unresolved suggestions and requests

5. After addressing feedback:
   tools.annotate({ targetId: "s-a2b3", resolve: "f-abc1" })
   tools.annotate({ targetId: "s-a2b3", resolve: "f-abc2" })
```

## Cross-System Feedback

When the feedback source and target live in different systems, OpenTasks stores the feedback (native systems can't handle cross-refs).

```json
// Beads issue commenting on Taskmaster spec
// RPC: tools.annotate
{
  "targetId": "taskmaster://./auth-prd",
  "fromId": "beads://./bd-x7k9",
  "create": {
    "content": "Implemented sections 1-3. Section 4 (SAML) descoped per discussion.",
    "type": "comment"
  }
}
// Stored in OpenTasks (cross-system feedback)
```

When both source and target are in the same system, feedback is routed to that system's native comments if supported.
