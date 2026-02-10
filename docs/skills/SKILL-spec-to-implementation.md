# Skill: Spec to Implementation

Full lifecycle from creating a spec through issue breakdown, implementation tracking, and completion.

## When to Use

- Starting a new feature from requirements
- Breaking down a PRD or design doc into trackable work
- An agent needs to plan, execute, and track a multi-step implementation
- Connecting work across multiple systems (Taskmaster specs, Beads issues, Claude tasks)

## Pattern: Native OpenTasks Workflow

When using OpenTasks as the primary task system (no external providers).

### Step 1: Create the Spec

```json
// RPC: graph.create
{
  "type": "spec",
  "title": "OAuth2 authentication for API",
  "content": "## Overview\n\nAdd OAuth2 login support for Google and GitHub providers.\n\n## Requirements\n\n- Google OAuth2 with PKCE\n- GitHub OAuth2\n- Token refresh flow\n- Session management\n\n## Out of Scope\n\n- SAML/SSO (follow-up)\n- Custom OAuth providers",
  "status": "active",
  "tags": ["auth", "api"],
  "priority": 1
}
// Returns: { id: "s-a2b3", ... }
```

### Step 2: Break Down into Issues

```json
// RPC: graph.create
{
  "type": "issue",
  "title": "Set up OAuth2 provider configuration",
  "content": "Create configuration schema for OAuth providers. Support client_id, client_secret, scopes, callback URLs.",
  "status": "open",
  "tags": ["auth"],
  "priority": 1
}
// Returns: { id: "i-x7k9", ... }

// RPC: graph.create
{
  "type": "issue",
  "title": "Implement Google OAuth2 login endpoint",
  "content": "POST /auth/google - initiate OAuth flow with PKCE. GET /auth/google/callback - handle redirect.",
  "status": "open",
  "tags": ["auth", "google"],
  "priority": 1
}
// Returns: { id: "i-m4n5", ... }

// RPC: graph.create
{
  "type": "issue",
  "title": "Implement GitHub OAuth2 login endpoint",
  "content": "POST /auth/github - initiate OAuth flow. GET /auth/github/callback - handle redirect.",
  "status": "open",
  "tags": ["auth", "github"],
  "priority": 2
}
// Returns: { id: "i-p6q7", ... }

// RPC: graph.create
{
  "type": "issue",
  "title": "Token refresh and session management",
  "content": "Implement refresh token rotation, session storage, and logout.",
  "status": "open",
  "tags": ["auth", "sessions"],
  "priority": 2
}
// Returns: { id: "i-r8s9", ... }
```

### Step 3: Link Issues to Spec

```json
// RPC: tools.link
{ "fromId": "i-x7k9", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-m4n5", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-p6q7", "toId": "s-a2b3", "type": "implements" }
{ "fromId": "i-r8s9", "toId": "s-a2b3", "type": "implements" }
```

### Step 4: Set Up Dependencies

```json
// Config must be done before login endpoints
// RPC: tools.link
{ "fromId": "i-x7k9", "toId": "i-m4n5", "type": "blocks" }
{ "fromId": "i-x7k9", "toId": "i-p6q7", "type": "blocks" }

// Login endpoints must exist before session management
{ "fromId": "i-m4n5", "toId": "i-r8s9", "type": "blocks" }
{ "fromId": "i-p6q7", "toId": "i-r8s9", "type": "blocks" }
```

### Step 5: Find Ready Work

```json
// RPC: tools.query
{ "ready": {} }
// Returns: [{ id: "i-x7k9", title: "Set up OAuth2 provider configuration", ... }]
// Only i-x7k9 is ready — everything else is blocked
```

### Step 6: Work and Update Status

```json
// Claim and start work
// RPC: graph.update
{ "id": "i-x7k9", "status": "in_progress" }

// ... agent does the work ...

// Mark complete
// RPC: graph.update
{ "id": "i-x7k9", "status": "closed" }
```

### Step 7: Check What's Unblocked

```json
// RPC: tools.query
{ "ready": {} }
// Returns: [
//   { id: "i-m4n5", title: "Implement Google OAuth2 login endpoint" },
//   { id: "i-p6q7", title: "Implement GitHub OAuth2 login endpoint" }
// ]
// Both are now unblocked — can be worked in parallel
```

### Step 8: Leave Implementation Feedback on Spec

```json
// RPC: tools.annotate
{
  "targetId": "s-a2b3",
  "fromId": "i-m4n5",
  "create": {
    "content": "Google OAuth2 implemented with PKCE. Discovered that Google requires `access_type=offline` for refresh tokens — added to config schema.",
    "type": "comment",
    "anchor": { "section": "Requirements", "text": "Google OAuth2 with PKCE" }
  }
}
```

### Step 9: Check Implementation Progress

```json
// RPC: tools.query
{ "implementers": { "specId": "s-a2b3" } }
// Returns all issues linked to this spec with their current status
```

## Pattern: Cross-System Workflow

When specs live in one system and issues in another.

### Taskmaster Spec + Beads Issues

```
1. Spec exists in Taskmaster (created via `tm` CLI):
   URI: taskmaster://./auth-feature

2. Issues created in Beads (via `bd` CLI):
   URI: beads://./bd-x7k9

3. Link them in OpenTasks:
   tools.link({ fromId: "beads://./bd-x7k9", toId: "taskmaster://./auth-feature", type: "implements" })

4. Query implementers across systems:
   tools.query({ implementers: { specId: "taskmaster://./auth-feature" } })
   → Returns Beads issues that implement the Taskmaster spec
```

### Native Spec + Claude Tasks for Subtasks

```
1. Create spec in OpenTasks:
   graph.create({ type: "spec", title: "Auth feature", ... })
   → s-a2b3

2. Create issue in OpenTasks:
   graph.create({ type: "issue", title: "Implement OAuth", status: "open", ... })
   → i-x7k9

3. Agent breaks into Claude subtasks for immediate execution:
   Claude TaskCreate({ subject: "Set up provider config" })
   → claude://current/t-abc

4. Link Claude task to OpenTasks issue:
   tools.link({ fromId: "claude://current/t-abc", toId: "i-x7k9", type: "child-of" })

5. Query children of the issue:
   tools.query({ edges: { from_id: "claude://current/t-abc", type: "child-of" } })
```

## Checking Overall Progress

### All open issues for a spec

```json
// RPC: tools.query
{
  "implementers": { "specId": "s-a2b3" }
}
// Filter results client-side by status != "closed"
```

### Remaining blockers for a specific issue

```json
// RPC: tools.query
{
  "blockers": {
    "nodeId": "i-r8s9",
    "transitive": true,
    "activeOnly": true
  }
}
// Returns all issues (direct and transitive) still blocking i-r8s9
```

### What work is available right now

```json
// RPC: tools.query
{
  "ready": {
    "tags": ["auth"],
    "priority": { "min": 0, "max": 2 }
  }
}
```
