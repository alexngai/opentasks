# Spec to Implementation

Full lifecycle: create a spec, break into issues, set up dependencies, track to completion.

## Native Workflow

### 1. Create spec

```bash
opentasks create --type spec \
  --title "OAuth2 authentication for API" \
  --content "## Requirements\n\n- Google OAuth2 with PKCE\n- GitHub OAuth2\n- Token refresh\n- Session management" \
  --status active --tags auth --priority 1
# → { id: "s-a2b3" }
```

### 2. Create issues

```bash
opentasks create --type issue --title "Set up OAuth provider config" --status open --tags auth --priority 1
# → i-x7k9

opentasks create --type issue --title "Implement Google OAuth login" --status open --tags auth --priority 1
# → i-m4n5

opentasks create --type issue --title "Implement GitHub OAuth login" --status open --tags auth --priority 2
# → i-p6q7

opentasks create --type issue --title "Token refresh and sessions" --status open --tags auth --priority 2
# → i-r8s9
```

### 3. Link issues to spec

```bash
opentasks link --from i-x7k9 --to s-a2b3 --type implements
opentasks link --from i-m4n5 --to s-a2b3 --type implements
opentasks link --from i-p6q7 --to s-a2b3 --type implements
opentasks link --from i-r8s9 --to s-a2b3 --type implements
```

### 4. Set up dependencies

```bash
opentasks link --from i-x7k9 --to i-m4n5 --type blocks   # config before Google
opentasks link --from i-x7k9 --to i-p6q7 --type blocks   # config before GitHub
opentasks link --from i-m4n5 --to i-r8s9 --type blocks   # Google before sessions
opentasks link --from i-p6q7 --to i-r8s9 --type blocks   # GitHub before sessions
```

### 5. Execute with ready queries

```bash
opentasks query '{"ready": {}}'
# → [i-x7k9] (only config is unblocked)

# Work on it
opentasks update i-x7k9 --status in_progress
# ... do work ...
opentasks update i-x7k9 --status closed

# Query again
opentasks query '{"ready": {}}'
# → [i-m4n5, i-p6q7] (both unblocked, parallelizable)
```

### 6. Leave implementation feedback

```bash
opentasks annotate '{"targetId":"s-a2b3","fromId":"i-m4n5","create":{"content":"Google OAuth implemented with PKCE. Requires access_type=offline for refresh tokens.","type":"comment","anchor":{"text":"Google OAuth2 with PKCE"}}}'
```

### 7. Check progress

```bash
# All implementers of the spec
opentasks query '{"implementers": {"specId": "s-a2b3"}}'

# Remaining blockers for sessions issue
opentasks query '{"blockers": {"nodeId": "i-r8s9", "activeOnly": true}}'
```

## Cross-System Workflow

When specs and issues live in different systems, OpenTasks provides the graph layer between them.

```bash
# Taskmaster spec + Beads issue
opentasks link --from "beads://./bd-x7k9" --to "taskmaster://./auth-prd" --type implements

# Query implementers across systems
opentasks query '{"implementers": {"specId": "taskmaster://./auth-prd"}}'

# Native issue + Claude subtask
opentasks link --from "claude://current/t-abc" --to i-x7k9 --type child-of
```

OpenTasks doesn't manage content in external systems. Use their native tools (bd CLI, tm CLI, Claude TaskCreate) for CRUD, then use OpenTasks for cross-system edges.
