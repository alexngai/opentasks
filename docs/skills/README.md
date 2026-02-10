# OpenTasks Agent Skills

Practical patterns for agents working with the OpenTasks graph.

These documents are written for **agents** (LLMs, automation scripts, MCP clients) — not humans reading docs. Each skill describes a specific workflow pattern with the exact RPC calls needed.

## Prerequisites

All skills assume the agent connects to the OpenTasks daemon via IPC (Unix socket). Two API layers are available:

| Layer | Methods | Use For |
|-------|---------|---------|
| **Tools** (high-level) | `tools.link`, `tools.query`, `tools.annotate` | Graph relationships, queries, feedback |
| **Graph** (low-level) | `graph.create`, `graph.get`, `graph.update`, `graph.delete`, `graph.createEdge`, `graph.deleteEdge` | Node CRUD, direct graph manipulation |

The tools layer is sufficient for most relationship work. The graph layer is needed when creating or modifying nodes directly (e.g., creating ExternalNodes).

## Skills

| Skill | When to Use |
|-------|-------------|
| [Link External Data](./SKILL-link-external-data.md) | Bind Slack messages, docs, URLs, or any non-task artifact to specs/issues |
| [Spec to Implementation](./SKILL-spec-to-implementation.md) | Full workflow: spec creation, issue breakdown, tracking to completion |
| [Feedback and Review](./SKILL-feedback-review.md) | Leave cross-system feedback, manage suggestion lifecycle |
| [Dependency Management](./SKILL-dependency-management.md) | Set up blockers, query ready work, manage dependency chains |

## Quick Reference: RPC Methods

### Tools Layer

```
tools.link      { fromId, toId, type, remove?, metadata? }        → { success, edgeId? }
tools.query     { nodes? | edges? | ready? | blockers? | ... }    → { items, total?, hasMore }
tools.annotate  { targetId, create? | resolve? | dismiss? | ... } → { success, feedbackId? }
```

### Graph Layer

```
graph.create     { type, title, content?, status?, uri?, source?, metadata?, ... }  → Node
graph.get        { id }                                                              → Node
graph.update     { id, title?, content?, status?, metadata?, ... }                   → Node
graph.delete     { id, options?: { hard? } }                                         → void
graph.createEdge { from_id, to_id, type, metadata? }                                → Edge
graph.deleteEdge { id }                                                              → void
graph.query      { type?, filter?, limit?, offset? }                                 → Node[]
```

### Node Types

| Type | ID Prefix | Required Fields |
|------|-----------|-----------------|
| `spec` | `s-` | title |
| `issue` | `i-` | title, status |
| `feedback` | `f-` | title, target_id, feedback_type |
| `external` | `e-` | title, uri, source |

### Edge Types

| Type | Semantics | Cycle-checked? |
|------|-----------|----------------|
| `blocks` | from must complete before to can start | Yes |
| `implements` | issue implements spec | No |
| `references` | general reference | No |
| `related` | loose association | No |
| `child-of` | hierarchical containment | No |
| `parent-of` | inverse of child-of | No |
| `duplicates` | from is duplicate of to | No |
| `supersedes` | from replaces to | No |
| `depends-on` | softer than blocks (informational) | No |
| `discovered-from` | found while working on | No |
