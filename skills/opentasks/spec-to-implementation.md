# Spec to Implementation

Full lifecycle: create a context, break into issues, set up dependencies, track to completion.

## Native Workflow

### 1. Create context

```bash
opentasks create --type spec \
  --title "OAuth2 authentication for API" \
  --content "## Requirements\n\n- Google OAuth2 with PKCE\n- GitHub OAuth2\n- Token refresh\n- Session management" \
  --status active --tags auth --priority 1
# → { id: "c-a2b3" }
```

### 2. Create issues

```bash
opentasks create --type issue --title "Set up OAuth provider config" --status open --tags auth --priority 1
# → t-x7k9

opentasks create --type issue --title "Implement Google OAuth login" --status open --tags auth --priority 1
# → t-m4n5

opentasks create --type issue --title "Implement GitHub OAuth login" --status open --tags auth --priority 2
# → t-p6q7

opentasks create --type issue --title "Token refresh and sessions" --status open --tags auth --priority 2
# → t-r8s9
```

### 3. Link issues to spec

```bash
opentasks link --from t-x7k9 --to c-a2b3 --type implements
opentasks link --from t-m4n5 --to c-a2b3 --type implements
opentasks link --from t-p6q7 --to c-a2b3 --type implements
opentasks link --from t-r8s9 --to c-a2b3 --type implements
```

### 4. Set up dependencies

```bash
opentasks link --from t-x7k9 --to t-m4n5 --type blocks   # config before Google
opentasks link --from t-x7k9 --to t-p6q7 --type blocks   # config before GitHub
opentasks link --from t-m4n5 --to t-r8s9 --type blocks   # Google before sessions
opentasks link --from t-p6q7 --to t-r8s9 --type blocks   # GitHub before sessions
```

### 5. Execute with ready queries

```bash
opentasks query '{"ready": {}}'
# → [t-x7k9] (only config is unblocked)

# Work on it
opentasks update t-x7k9 --status in_progress
# ... do work ...
opentasks update t-x7k9 --status closed

# Query again
opentasks query '{"ready": {}}'
# → [t-m4n5, t-p6q7] (both unblocked, parallelizable)
```

### 6. Leave implementation feedback

```bash
opentasks annotate '{"targetId":"c-a2b3","fromId":"t-m4n5","create":{"content":"Google OAuth implemented with PKCE. Requires access_type=offline for refresh tokens.","type":"comment","anchor":{"text":"Google OAuth2 with PKCE"}}}'
```

### 7. Check progress

```bash
# All tasks of the context
opentasks query '{"tasks": {"specId": "c-a2b3"}}'

# Remaining blockers for sessions issue
opentasks query '{"blockers": {"nodeId": "t-r8s9", "activeOnly": true}}'
```

## File-Backed Context Workflow (MCP)

When the spec already exists as a file in the repo (design doc, architecture spec, etc.), reference it directly instead of duplicating content.

### 1. Create file-backed context

```json
// MCP: create_context
{
  "title": "Auth Architecture",
  "source": { "type": "file", "path": "docs/auth-architecture.md" },
  "tags": ["auth"]
}
// → { id: "c-a2b3", metadata: { context_file: true, context_file_path: "docs/auth-architecture.md", ... } }
```

No content is copied — just a pointer to the file with a content hash for drift detection.

### 2. Reference key implementation files

```json
// MCP: create_context
{
  "source": { "type": "file", "path": "src/auth/middleware.ts" },
  "tags": ["auth"]
}
// → { id: "c-m1n2" }

// MCP: create_context — snippet for a specific function
{
  "title": "Token validation",
  "source": { "type": "snippet", "path": "src/auth/middleware.ts", "startLine": 42, "endLine": 58 },
  "tags": ["auth"]
}
// → { id: "c-s3n4" }
```

### 3. Create tasks and link to context

```json
// MCP: create_task
{ "title": "Add JWT refresh tokens", "status": "open", "tags": ["auth"] }
// → { id: "t-x7k9" }

// MCP: link
{ "fromId": "t-x7k9", "toId": "c-a2b3", "type": "implements" }
```

### 4. Later — resolve context with drift detection

```json
// MCP: get_context — check if spec has changed
{ "id": "c-a2b3", "resolve": true }
// → { ..., _resolved: { content: "# Auth Architecture\n...", drifted: true, ... } }
```

If `drifted: true`, the file has changed since the context was created. The agent can re-read the spec and decide if the task needs updating.

### 5. Re-pin after changes

```json
// MCP: update_context — sync to current HEAD
{ "id": "c-a2b3", "sync": true }
```

### 6. Batch drift check

```json
// MCP: list_contexts — check all file-backed contexts at once
{ "filesOnly": true, "checkDrift": true }
// → each item has _drift: { drifted, currentCommit, capturedCommit, ... }
```

## Cross-System Workflow

When context and tasks live in different systems, OpenTasks provides the graph layer between them.

```bash
# Taskmaster spec + Beads issue
opentasks link --from "beads://./bd-x7k9" --to "taskmaster://./auth-prd" --type implements

# Query tasks across systems
opentasks query '{"tasks": {"specId": "taskmaster://./auth-prd"}}'

# Native issue + Claude subtask
opentasks link --from "claude://current/t-abc" --to t-x7k9 --type child-of
```

OpenTasks doesn't manage content in external systems. Use their native tools (bd CLI, tm CLI, Claude TaskCreate) for CRUD, then use OpenTasks for cross-system edges.
