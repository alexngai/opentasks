---
name: opentasks
description: Use when managing work items, linking external data (Slack, docs, URLs) to tasks, querying task dependencies or blockers, leaving cross-system feedback on specs or issues, or coordinating work across multiple task systems. Use when the agent has access to the `opentasks` CLI.
user-invocable: false
---

# OpenTasks

OpenTasks is a graph connector that adds a relationship layer across task systems. It does not replace those systems — it provides cross-system edges, feedback, and dependency tracking.

## CLI Commands

All operations go through the `opentasks` CLI, which talks to the daemon over IPC.

### Link — create or remove edges

```bash
opentasks link --from t-x7k9 --to c-a2b3 --type implements
opentasks link --from t-x7k9 --to t-m4n5 --type blocks
opentasks link --from t-x7k9 --to e-k7m2 --type references --metadata '{"context":"bug report"}'
opentasks link --from t-aaa --to t-bbb --type blocks --remove
```

Returns `{ success, edgeId? }`. Idempotent. `blocks` edges are cycle-checked.

### Query — search nodes, edges, blockers, ready work

```bash
opentasks query '{"ready": {}}'
opentasks query '{"blockers": {"nodeId": "t-r8s9", "activeOnly": true}}'
opentasks query '{"blocking": {"nodeId": "t-x7k9", "transitive": true}}'
opentasks query '{"edges": {"from_id": "t-x7k9", "type": "references"}}'
opentasks query '{"tasks": {"specId": "c-a2b3"}}'
opentasks query '{"feedback": {"nodeId": "c-a2b3", "resolved": false}}'
opentasks query '{"unresolvedFeedback": {}}'
```

Exactly one query key per call. Returns `{ items, total?, hasMore }`.

| Key | Purpose |
|-----|---------|
| `nodes` | Filter nodes by type, status, tags, search |
| `edges` | Filter edges by from_id, to_id, type |
| `ready` | Unblocked open tasks (tags?, priority?, assignee?) |
| `blockers` | What blocks a node (transitive?, activeOnly?) |
| `blocking` | What a node blocks (transitive?) |
| `feedback` | Feedback on a node (type?, resolved?) |
| `unresolvedFeedback` | All unresolved feedback (targetId?) |
| `tasks` | Tasks implementing a context (specId) |
| `specs` | Specs a task implements (issueId) |

### Annotate — feedback lifecycle

```bash
# Create feedback
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Implemented OAuth.","type":"comment"}}'

# With source issue link
opentasks annotate '{"targetId":"c-a2b3","fromId":"t-x7k9","create":{"content":"Done.","type":"comment"}}'

# Anchored suggestion
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Add rate limiting","type":"suggestion","anchor":{"line":15}}}'

# Resolve / dismiss / reopen
opentasks annotate '{"targetId":"c-a2b3","resolve":"f-t1u2"}'
opentasks annotate '{"targetId":"c-a2b3","dismiss":"f-t1u2"}'
opentasks annotate '{"targetId":"c-a2b3","reopen":"f-t1u2"}'
```

### Create — add nodes

```bash
opentasks create --type issue --title "Fix SSO redirect" --status open --tags auth,bug --priority 1
opentasks create --type spec --title "OAuth2 for API" --status active --content "## Requirements\n..."
opentasks create --type external --title "Slack: SSO bug" --uri "slack://C04ABCD/p123" --source slack --metadata '{"author":"alex"}'
```

### Get / Update / Delete

```bash
opentasks get t-x7k9
opentasks update t-x7k9 --status closed
opentasks update t-x7k9 --title "New title" --metadata '{"key":"val"}'
opentasks delete t-x7k9
opentasks delete t-x7k9 --hard
```

## Node Types

| Type | Prefix | Required | Purpose |
|------|--------|----------|---------|
| `spec` | `s-` | title | Requirements, intent, context |
| `issue` | `i-` | title, status | Actionable work items |
| `feedback` | `f-` | title, target_id, feedback_type | Comments, suggestions, requests |
| `external` | `e-` | title, uri, source | References to external systems |

All nodes support optional: `content`, `priority` (0-4), `tags[]`, `parent_id`, `metadata`.

## Context Sources

Context nodes support multiple content source types. The source type determines how content is stored and resolved.

| Source | Stored in node? | How content is accessed |
|--------|-----------------|------------------------|
| inline (default) | Yes, in `content` field | Read directly from the node |
| file | No (pointer only) | Resolved from the working tree or a pinned git commit |
| snippet | No (pointer only) | Resolved from specific line range in a file |

### Inline context (default)

Content is stored directly in the node. Use for design decisions, requirements written by agents, meeting notes, etc.

```bash
# CLI
opentasks create --type spec --title "OAuth2 for API" --content "## Requirements\n..."
```

```json
// MCP: create_context
{ "title": "OAuth2 for API", "content": "## Requirements\n..." }
```

### File-backed context

References a codebase file. Content is NOT stored — it's resolved on access from the working tree or at a specific git commit. Includes drift detection (has the file changed since it was captured?).

```json
// MCP: create_context with source
{
  "title": "Auth Middleware",
  "source": { "type": "file", "path": "src/auth/middleware.ts" },
  "tags": ["auth"]
}

// Pin to a specific commit
{
  "source": { "type": "file", "path": "src/auth/middleware.ts", "commit": "abc123" }
}
```

### Snippet context

References specific lines in a file. Like file-backed, but scoped to a line range.

```json
// MCP: create_context with snippet source
{
  "title": "Token validation logic",
  "source": { "type": "snippet", "path": "src/auth/middleware.ts", "startLine": 42, "endLine": 58 }
}
```

### Resolving content

File and snippet contexts don't store content. Use `get_context` with `resolve: true` to fetch the current file content.

```json
// MCP: get_context — lightweight (metadata only, no file I/O)
{ "id": "c-x7k9" }

// MCP: get_context — with file content resolved
{ "id": "c-x7k9", "resolve": true }

// MCP: get_context — content at the originally captured commit
{ "id": "c-x7k9", "resolve": true, "atCapturedCommit": true }
```

The response includes `_resolved.drifted: true/false` indicating whether the file has changed since capture.

### Syncing and drift detection

```json
// MCP: update_context — re-pin to current HEAD
{ "id": "c-x7k9", "sync": true }

// MCP: update_context — force re-pin even if unchanged
{ "id": "c-x7k9", "sync": true, "force": true }

// MCP: list_contexts — check drift for all file-backed contexts
{ "checkDrift": true }

// MCP: list_contexts — only file-backed contexts
{ "filesOnly": true, "checkDrift": true }
```

## Edge Types

| Type | Semantics | Cycle-checked |
|------|-----------|---------------|
| `blocks` | from must complete before to can start | Yes |
| `implements` | task implements context | No |
| `references` | general reference | No |
| `related` | loose association | No |
| `child-of` | hierarchical containment | No |
| `parent-of` | inverse of child-of | No |
| `depends-on` | soft dependency (informational, not used by `ready`) | No |
| `discovered-from` | found while working on | No |
| `duplicates` | from is duplicate of to | No |
| `supersedes` | from replaces to | No |

Edge types are extensible via string.

## URI Conventions

Nodes across systems are identified by URIs:

```
native://c-a2b3                    # OpenTasks native node
beads://./bd-x7k9                  # Beads issue
taskmaster://./auth-prd            # Taskmaster spec
claude://current/t-abc             # Claude task
slack://C04ABCD/p1234567890        # Slack message (custom)
github://owner/repo/pull/42        # GitHub PR (custom)
```

The `uri` field on ExternalNodes is freeform. Use consistent schemes for deduplication.

## Specialized Workflows

**Linking external data** (Slack messages, docs, URLs): See [linking-external-data.md](linking-external-data.md)

**Spec to implementation** (create spec, break into issues, track to completion): See [spec-to-implementation.md](spec-to-implementation.md)

**Feedback and review** (cross-system feedback, suggestion lifecycle): See [feedback-and-review.md](feedback-and-review.md)

**Dependency management** (blockers, ready queries, work loops): See [dependency-management.md](dependency-management.md)
