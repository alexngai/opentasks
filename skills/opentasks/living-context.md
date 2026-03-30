# Living Context

Maintain project knowledge that stays accurate and grows richer over time. Context nodes are the knowledge layer; feedback nodes are the memory layer; the task graph is the relevance signal.

## Core Principle

Context nodes capture what's true about the project. Feedback nodes capture what agents learn while working. Tasks connecting to contexts tell you which knowledge is active, stale, or battle-tested. The agent drives all of this — the system stores, the agent decides.

## Session Start — Orient

At the start of a session, discover what's available and load relevant context:

### Discover providers

```bash
# What systems are connected? What can each do?
opentasks list_providers
```

This returns every registered provider with its capabilities (read/write/search/watch), task lifecycle actions (start, complete, block, etc.), metadata fields it accepts, and limitations. Read the `description` and `metadataSchema` fields — they tell you what works and what doesn't for each provider.

Use this to answer: Can I create tasks in Beads? Does the MAP provider support assignment? What metadata fields does the native provider accept?

### Load context

```bash
# What's active and what needs attention?
opentasks query '{"context_summary": {"limit": 10}}'

# If picking up a specific task:
opentasks query '{"context_summary": {"taskId": "t-x7k9"}}'
```

Context summary returns:
- **relatedContexts** — specs/requirements linked to the task
- **unresolvedFeedback** — open observations, suggestions, requests
- **activeTasks** — sibling work on the same contexts
- **recentlyCompleted** — what just finished (may inform your work)
- **blockedTasks** — what's waiting

Before diving into a context, check its feedback. Unresolved feedback is accumulated knowledge from previous sessions:

```bash
opentasks query '{"feedback": {"nodeId": "c-a2b3", "resolved": false}}'
```

This tells you what other agents (or your past self) learned, flagged, or left unfinished.

## During Work — Record What You Learn

As you work on a task, you'll discover things about the codebase, conventions, gotchas, and decisions. Record them as feedback on the relevant context node:

### Implementation discoveries

```bash
# Something you learned that future agents should know
opentasks annotate '{"targetId":"c-a2b3","fromId":"t-x7k9","create":{"content":"OAuth refresh tokens require access_type=offline — not documented in the spec but required by Google.","type":"comment"}}'
```

The `fromId` creates a `discovered-from` edge, linking the learning to the task that produced it.

### Drift observations

When you notice a context node's content doesn't match reality:

```bash
# File reference is stale
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"References src/auth/handler.ts but this was renamed to src/auth/middleware.ts in the refactor.","type":"suggestion","anchor":{"text":"src/auth/handler.ts"}}}'

# Architectural claim is outdated
opentasks annotate '{"targetId":"c-m1n2","create":{"content":"Says we use REST but the payments module migrated to gRPC. See t-p6q7.","type":"suggestion"}}'
```

### Blocking questions

When you need information to proceed:

```bash
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Spec says rate limit at 100 req/min but the infra team mentioned 50. Which is correct?","type":"request"}}'
```

### Cross-context inconsistencies

When two contexts contradict each other:

```bash
# Flag on both
opentasks annotate '{"targetId":"c-a2b3","create":{"content":"Claims PostgreSQL 14, but c-m1n2 (stack doc) says PostgreSQL 15. One of these is wrong.","type":"suggestion"}}'
opentasks annotate '{"targetId":"c-m1n2","create":{"content":"Claims PostgreSQL 15, but c-a2b3 (architecture doc) says PostgreSQL 14. One of these is wrong.","type":"suggestion"}}'
```

## After Work — Close the Loop

When you finish a task, leave a summary and resolve feedback you addressed:

```bash
# Summary of what was done
opentasks annotate '{"targetId":"c-a2b3","fromId":"t-x7k9","create":{"content":"Implemented Google OAuth with PKCE. Added refresh token rotation. Rate limiting deferred to t-r8s9.","type":"comment"}}'

# Resolve feedback you addressed during the task
opentasks annotate '{"targetId":"c-a2b3","resolve":"f-t1u2"}'
opentasks annotate '{"targetId":"c-a2b3","resolve":"f-v3w4"}'

# Dismiss feedback that turned out to be wrong
opentasks annotate '{"targetId":"c-a2b3","dismiss":"f-y5z6"}'
```

If the context is file-backed and you changed the file, sync it:

```json
// MCP: update_context
{ "id": "c-a2b3", "sync": true }
```

## Navigating Context by Relevance

The graph tells you which contexts matter. Use these signals:

### Active contexts (tasks in progress)

```bash
# Contexts linked to active tasks
opentasks query '{"nodes": {"type": "context", "status": "active"}}'
```

### Contexts for your area of work

```bash
# What contexts does your task implement?
opentasks query '{"specs": {"issueId": "t-x7k9"}}'

# What sibling tasks share those contexts?
opentasks query '{"tasks": {"specId": "c-a2b3"}}'
```

### Contexts with unresolved questions

```bash
# Global: what has open feedback?
opentasks query '{"unresolvedFeedback": {}}'
```

### Edge metadata as routing hints

When creating edges, add metadata that helps future navigation:

```bash
# Scope hints for routing
opentasks link --from t-x7k9 --to c-a2b3 --type implements --metadata '{"scope":"auth","layer":"backend"}'

# When linking related contexts, explain the relationship
opentasks link --from c-a2b3 --to c-m1n2 --type related --metadata '{"relevance":"auth architecture depends on the database stack decisions in this doc"}'
```

These are hints for agents, not system-evaluated conditions. When you load a context, check its edges and read the metadata to decide what else to load.

## Growing the Context Scaffold

### When to create new context nodes

- You wrote a design doc or architecture decision → create file-backed context
- You discovered a non-obvious convention → create inline context
- A pattern emerged across multiple tasks → create a pattern context

```bash
# Pattern discovery
opentasks create --type spec \
  --title "Pattern: Adding API endpoints" \
  --content "## Steps\n1. Define route in src/routes/\n2. Add validation schema\n3. Register in router index\n\n## Gotchas\n- Always add rate limiting middleware\n- Validation errors must return 422, not 400\n\n## Verify\n- Route appears in GET /api/docs\n- Rate limit header present in response" \
  --status active --tags pattern,api
```

### When to update existing context

- You resolved a `suggestion` feedback by editing the underlying content → sync the file-backed context
- Multiple feedback items point to the same outdated section → update the context content, resolve the feedback
- A context has no linked active tasks and hasn't been referenced in a while → consider archiving

```bash
# Archive stale context
opentasks update c-old1 --status archived
```

### When to link contexts together

- Two contexts cover related areas → `related` edge with metadata explaining the connection
- One context supersedes another → `supersedes` edge, archive the old one
- A context references implementation covered by another context → `references` edge

## Reading Relevance from the Graph

There is no explicit staleness score. Instead, read the graph:

| Signal | What it means | How to check |
|--------|--------------|--------------|
| Active tasks linked | Context is in active use | `query tasks → check statuses` |
| Recent feedback | Someone engaged with it recently | `query feedback → check timestamps` |
| Unresolved suggestions | Known issues pending | `query unresolvedFeedback` |
| All tasks closed, no recent feedback | Possibly stale, possibly stable | Agent judgment call |
| Drift detected on file-backed context | Source changed, context pointer outdated | `get_context with resolve: true` |
| Many resolved feedback items | Battle-tested, high confidence | `query feedback → count resolved` |

The agent interprets these signals. A context with all tasks closed might be "done and stable" or "abandoned and stale" — only the agent working in the codebase can tell.
