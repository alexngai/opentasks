# Spec to Implementation

Full lifecycle: create a spec, break into issues, set up dependencies, track to completion.

## Native Workflow

### 1. Create spec

```json
// graph.create
{
  "type": "spec",
  "title": "OAuth2 authentication for API",
  "content": "## Requirements\n\n- Google OAuth2 with PKCE\n- GitHub OAuth2\n- Token refresh\n- Session management",
  "status": "active",
  "tags": ["auth"],
  "priority": 1
}
// → { id: "s-a2b3" }
```

### 2. Create issues

```json
// graph.create (repeat for each issue)
{ "type": "issue", "title": "Set up OAuth provider config", "status": "open", "tags": ["auth"], "priority": 1 }
// → i-x7k9

{ "type": "issue", "title": "Implement Google OAuth login", "status": "open", "tags": ["auth"], "priority": 1 }
// → i-m4n5

{ "type": "issue", "title": "Implement GitHub OAuth login", "status": "open", "tags": ["auth"], "priority": 2 }
// → i-p6q7

{ "type": "issue", "title": "Token refresh and sessions", "status": "open", "tags": ["auth"], "priority": 2 }
// → i-r8s9
```

### 3. Link issues to spec

```json
// tools.link (for each issue)
{ "fromId": "i-x7k9", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-m4n5", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-p6q7", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-r8s9", "toId": "s-a2b3", "type": "implements" }
```

### 4. Set up dependencies

```json
// tools.link
{ "fromId": "i-x7k9", "toId": "i-m4n5", "type": "blocks" }  // config before Google
{ "fromId": "i-x7k9", "toId": "i-p6q7", "type": "blocks" }  // config before GitHub
{ "fromId": "i-m4n5", "toId": "i-r8s9", "type": "blocks" }  // Google before sessions
{ "fromId": "i-p6q7", "toId": "i-r8s9", "type": "blocks" }  // GitHub before sessions
```

### 5. Execute with ready queries

```json
// tools.query
{ "ready": {} }
// → [i-x7k9] (only config is unblocked)

// Work on it
// graph.update
{ "id": "i-x7k9", "status": "in_progress" }
// ... do work ...
{ "id": "i-x7k9", "status": "closed" }

// Query again
{ "ready": {} }
// → [i-m4n5, i-p6q7] (both unblocked, parallelizable)
```

### 6. Leave implementation feedback

```json
// tools.annotate
{
  "targetId": "s-a2b3",
  "fromId": "i-m4n5",
  "create": {
    "content": "Google OAuth implemented with PKCE. Requires access_type=offline for refresh tokens.",
    "type": "comment",
    "anchor": { "text": "Google OAuth2 with PKCE" }
  }
}
```

### 7. Check progress

```json
// All implementers of the spec
// tools.query
{ "implementers": { "specId": "s-a2b3" } }

// Remaining blockers for sessions issue
{ "blockers": { "nodeId": "i-r8s9", "activeOnly": true } }
```

## Cross-System Workflow

When specs and issues live in different systems, OpenTasks provides the graph layer between them.

```
// Taskmaster spec + Beads issue
tools.link({ fromId: "beads://./bd-x7k9", toId: "taskmaster://./auth-prd", type: "implements" })

// Query implementers across systems
tools.query({ implementers: { specId: "taskmaster://./auth-prd" } })

// Native issue + Claude subtask
tools.link({ fromId: "claude://current/t-abc", toId: "i-x7k9", type: "child-of" })
```

OpenTasks doesn't manage content in external systems. Use their native tools (bd CLI, tm CLI, Claude TaskCreate) for CRUD, then use OpenTasks for cross-system edges.
