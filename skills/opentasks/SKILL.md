---
name: opentasks
description: Use when managing work items, linking external data (Slack, docs, URLs) to tasks, querying task dependencies or blockers, leaving cross-system feedback on specs or issues, or coordinating work across multiple task systems. Use when the agent has access to an OpenTasks daemon via IPC.
---

# OpenTasks

OpenTasks is a graph connector that adds a relationship layer across task systems. It does not replace those systems — it provides cross-system edges, feedback, and dependency tracking.

## Two API Layers

| Layer | Methods | Use For |
|-------|---------|---------|
| **Tools** (high-level) | `tools.link`, `tools.query`, `tools.annotate` | Relationships, queries, feedback |
| **Graph** (low-level) | `graph.create`, `graph.get`, `graph.update`, `graph.delete`, `graph.createEdge`, `graph.deleteEdge` | Node CRUD, direct manipulation |

All calls are JSON-RPC over IPC (Unix socket). Pass optional `location` param to route to a specific store.

## Quick Reference

### tools.link

Create or remove edges between any nodes.

```json
{ "fromId": "i-x7k9", "toId": "s-a2b3", "type": "implements", "metadata": {} }
```

Returns `{ success, edgeId? }`. Idempotent. `blocks` edges are cycle-checked.

Set `"remove": true` to delete an edge.

### tools.query

Query the graph. Exactly one query key per call.

| Key | Purpose | Required Params |
|-----|---------|-----------------|
| `nodes` | Filter nodes | `NodeFilter` (type, status, tags, search, etc.) |
| `edges` | Filter edges | `EdgeFilter` (from_id, to_id, type) |
| `ready` | Unblocked open issues | `ReadyOptions` (tags?, priority?, assignee?) |
| `blockers` | What blocks a node | `{ nodeId, transitive?, activeOnly? }` |
| `blocking` | What a node blocks | `{ nodeId, transitive? }` |
| `feedback` | Feedback on a node | `{ nodeId, type?, resolved? }` |
| `unresolvedFeedback` | All unresolved feedback | `{ targetId? }` |
| `implementers` | Issues implementing a spec | `{ specId }` |
| `specs` | Specs an issue implements | `{ issueId }` |

Returns `{ items, total?, hasMore }`. Set `verbose: true` for full objects.

### tools.annotate

Feedback lifecycle. Exactly one operation per call.

```json
{ "targetId": "s-a2b3", "create": { "content": "...", "type": "comment", "anchor": { "line": 15 } } }
{ "targetId": "s-a2b3", "resolve": "f-t1u2" }
{ "targetId": "s-a2b3", "dismiss": "f-t1u2" }
{ "targetId": "s-a2b3", "reopen": "f-t1u2" }
```

Set `fromId` to link feedback to its source issue.

### graph.create

Create nodes directly. Required fields depend on type.

```json
{ "type": "external", "title": "Slack: SSO bug report", "uri": "slack://C04ABCD/p123", "source": "slack", "metadata": {} }
```

### graph.update / graph.delete

```json
{ "id": "i-x7k9", "status": "closed" }
{ "id": "i-x7k9", "options": { "hard": true } }
```

## Node Types

| Type | Prefix | Required | Purpose |
|------|--------|----------|---------|
| `spec` | `s-` | title | Requirements, intent, context |
| `issue` | `i-` | title, status | Actionable work items |
| `feedback` | `f-` | title, target_id, feedback_type | Comments, suggestions, requests |
| `external` | `e-` | title, uri, source | References to external systems |

All nodes support optional: `content`, `priority` (0-4), `tags[]`, `parent_id`, `metadata`.

## Edge Types

| Type | Semantics | Cycle-checked |
|------|-----------|---------------|
| `blocks` | from must complete before to can start | Yes |
| `implements` | issue implements spec | No |
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
native://s-a2b3                    # OpenTasks native node
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
