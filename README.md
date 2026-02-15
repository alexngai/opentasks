# OpenTasks

Cross-system graph for tasks and specs. Link Claude Tasks to Beads issues to Jira tickets. Query blockers and ready work across all of them.

```
npm install opentasks
```

## Quick Start

```typescript
import { link, query, annotate } from 'opentasks'

// Connect a Beads issue to a Jira ticket
await link({
  fromId: 't-x7k9',
  toId: 'jira://PROJ-123',
  type: 'blocks',
})

// What's ready to work on?
const ready = await query({ ready: {} })

// What blocks this task?
const blockers = await query({
  blockers: { nodeId: 't-x7k9', transitive: true },
})

// Leave feedback on a context
await annotate({
  targetId: 'c-a2b3',
  create: {
    content: 'Needs error handling for token refresh',
    type: 'suggestion',
    anchor: { text: 'OAuth2 with PKCE' },
  },
})
```

## The Problem

Claude Tasks, Beads, Jira, Linear, Taskmaster each manage their own content. None of them can express cross-system relationships. You cannot say "this Claude subtask implements that Beads issue" or "this Beads issue is blocked by that Jira ticket."

OpenTasks adds edges between them.

```mermaid
graph TD
    subgraph Native Systems
        CT["Claude Tasks<br/><small>TaskCreate / TaskUpdate</small>"]
        BD["Beads<br/><small>bd new / bd show</small>"]
        TM["Taskmaster<br/><small>tm task / tm prd</small>"]
        JR["Jira<br/><small>REST API</small>"]
    end

    subgraph OpenTasks Graph Layer
        E1["claude://t-abc"]
        E2["beads://./bd-xyz"]
        E3["jira://PROJ-123"]
        E4["taskmaster://./auth-prd"]

        E1 -- "blocks" --> E2
        E2 -- "implements" --> E3
        E4 -- "discovered-from" --> E2
    end

    CT -.-> E1
    BD -.-> E2
    JR -.-> E3
    TM -.-> E4

    style E1 fill:#e8f4fd,stroke:#4a90d9
    style E2 fill:#e8f4fd,stroke:#4a90d9
    style E3 fill:#e8f4fd,stroke:#4a90d9
    style E4 fill:#e8f4fd,stroke:#4a90d9
```

You keep using each system's native tools. OpenTasks owns the graph.

## Three Tools

### link()

Create or remove edges between any nodes.

```typescript
await link({ fromId: 't-x7k9', toId: 'c-a2b3', type: 'implements' })
await link({ fromId: 't-setup', toId: 't-impl', type: 'blocks' })
await link({ fromId: 't-setup', toId: 't-impl', type: 'blocks', remove: true })
```

Edge types: `blocks` (cycle-checked), `implements`, `references`, `related`, `parent-of`, `depends-on`, `discovered-from`, `duplicates`, `supersedes`. Add custom types as strings.

### query()

Search nodes, edges, and computed views.

```typescript
await query({ ready: {} })                                        // Unblocked open tasks
await query({ blockers: { nodeId: 't-impl' } })                  // Direct blockers
await query({ blockers: { nodeId: 't-impl', transitive: true }}) // Full blocker chain
await query({ nodes: { type: 'task', status: 'open' } })        // Filter nodes
await query({ feedback: { nodeId: 'c-auth' } })                  // Feedback on a context
```

### annotate()

Feedback with anchoring, threading, and resolution.

```typescript
// Comment anchored to a line
await annotate({
  targetId: 'c-spec',
  create: {
    content: 'Consider rate limiting here',
    type: 'suggestion',
    anchor: { line: 42 },
  },
})

// Resolve feedback
await annotate({ targetId: 'c-spec', resolve: 'f-c4d5' })
```

Types: `comment`, `suggestion`, `request`. Each can be resolved, dismissed, or reopened.

## Nodes

Four types, all stored in `.opentasks/graph.jsonl`:

| Type | Prefix | Purpose |
|------|--------|---------|
| Spec | s- | Requirements, context, user intent |
| Task | i- | Actionable work with status (open / in_progress / blocked / closed) |
| Feedback | f- | Anchored comments on nodes, with threading |
| ExternalNode | e- | References to Jira, Beads, Linear, GitHub |

A typical feature graph looks like this:

```mermaid
graph LR
    S["c-a2b3<br/>Auth Spec"]
    I1["t-x7k9<br/>Implement OAuth"]
    I2["i-m4n5<br/>Add rate limiting"]
    F["f-p8q9<br/>suggestion"]
    EXT["e-jira<br/>PROJ-123"]

    I1 -- "implements" --> S
    I2 -- "blocks" --> I1
    F -. "anchored on" .-> S
    I1 -- "references" --> EXT

    style S fill:#d4edda,stroke:#28a745
    style I1 fill:#fff3cd,stroke:#ffc107
    style I2 fill:#fff3cd,stroke:#ffc107
    style F fill:#e2e3f1,stroke:#6c757d
    style EXT fill:#f8d7da,stroke:#dc3545
```

External nodes start as bare URIs. When you query them, OpenTasks fetches the data from the provider and caches it locally.

## Programmatic API

For direct graph manipulation without the daemon:

```typescript
import { createGraphStore, createJSONLPersister } from 'opentasks'

const persister = createJSONLPersister({ path: '.opentasks/graph.jsonl' })
const store = createGraphStore({ storage: persister })

const spec = await store.create({
  type: 'context',
  title: 'OAuth2 authentication',
  content: 'Users authenticate via OAuth2 with PKCE...',
})

const issue = await store.create({
  type: 'task',
  title: 'Implement OAuth2 flow',
  status: 'open',
})

await store.createEdge({
  from_id: issue.id,
  to_id: spec.id,
  type: 'implements',
})

const ready = await store.ready()
const blockers = await store.blockers(issue.id)
```

## Client Library

Connects to a running daemon via Unix socket:

```typescript
import { createClient } from 'opentasks'

const client = createClient({ autoConnect: true })
await client.link({ fromId: 't-x7k9', toId: 'c-a2b3', type: 'implements' })
const result = await client.query({ ready: {} })
await client.disconnect()
```

## Storage

```
.opentasks/
├── graph.jsonl       # Append-only source of truth (git-tracked)
├── tombstones.jsonl  # Soft deletes with configurable TTL
├── cache.db          # SQLite for fast queries (gitignored, rebuilt from JSONL)
├── config.json       # Location config, providers, retention
├── daemon.lock       # Exclusive lock (gitignored)
├── daemon.sock       # IPC socket (gitignored)
├── context/            # Optional markdown expansion
└── tasks/           # Optional markdown expansion
```

```mermaid
graph TB
    A["Agent / CLI"] --> Q["Query Layer<br/><small>SQLite cache.db</small><br/><small>Indexes on status, priority, edges</small>"]
    Q --> P["Persistence Layer<br/><small>graph.jsonl (append-only)</small><br/><small>Git-tracked source of truth</small>"]
    P --> I["Integration Layer<br/><small>Provider resolution</small><br/><small>External node cache</small>"]
    P --> MD["Markdown Expansion<br/><small>context/*.md, tasks/*.md</small><br/><small>Optional, human-readable</small>"]

    style A fill:#f5f5f5,stroke:#333
    style Q fill:#e8f4fd,stroke:#4a90d9
    style P fill:#d4edda,stroke:#28a745
    style I fill:#fff3cd,stroke:#ffc107
    style MD fill:#f0f0f0,stroke:#999,stroke-dasharray: 5 5
```

JSONL is the source of truth (git-tracked, append-only). SQLite is the query cache (gitignored, rebuilt on startup). Markdown is optional human-readable expansion.

## Providers

OpenTasks owns the graph. Providers own node content. Three patterns:

| Pattern | Use | Example |
|---------|-----|---------|
| Provider | Resolve URIs on demand | Jira, Linear, GitHub |
| Adapter | Delegate all CRUD to backend | Beads (`bd` CLI) |
| SyncTarget | Two-way sync | Sudocode |

External nodes go through three stages:

```mermaid
graph LR
    S1["Stage 1<br/><b>URI String</b><br/><small>jira://PROJ-123</small><br/><small>Just an edge target</small>"]
    S2["Stage 2<br/><b>Phantom Node</b><br/><small>In graph, not resolved</small><br/><small>No API call yet</small>"]
    S3["Stage 3<br/><b>Fetched Node</b><br/><small>Title, status, assignee</small><br/><small>Cached with TTL</small>"]

    S1 -- "first edge<br/>created" --> S2
    S2 -- "query requests<br/>node data" --> S3

    style S1 fill:#f5f5f5,stroke:#999
    style S2 fill:#fff3cd,stroke:#ffc107
    style S3 fill:#d4edda,stroke:#28a745
```

No upfront API calls. References stay cheap until you need the data.

## Locations

Multiple `.opentasks/` directories at different filesystem levels. Each is isolated by default.

```
~/.opentasks/                         # User global
  └── ~/projects/.opentasks/          # Workspace
      └── ~/projects/app/.opentasks/  # Project
```

Cross-location references use `opentasks://` URIs:

```
opentasks://./t-x7k9              # Current location
opentasks://~/t-a2b3              # User global
opentasks://../other-repo/c-c4d5  # Relative path
```

## Worktrees

For agent swarms working across git worktrees:

```bash
opentasks worktree setup ./feature-a --branch feature-a --role worker --redirect-to .
opentasks worktree setup ./feature-b --branch feature-b --role worker --redirect-to .
```

```mermaid
graph TB
    D["Daemon<br/><small>.git/opentasks/daemon.sock</small>"]

    D --- M["main worktree<br/><small>role: manager</small><br/><small>.opentasks/graph.jsonl</small>"]
    D --- W1["feature-a worktree<br/><small>role: worker</small><br/><small>redirects to manager</small>"]
    D --- W2["feature-b worktree<br/><small>role: worker</small><br/><small>redirects to manager</small>"]
    D --- W3["feature-c worktree<br/><small>role: worker</small><br/><small>redirects to manager</small>"]

    style D fill:#e8f4fd,stroke:#4a90d9
    style M fill:#d4edda,stroke:#28a745
    style W1 fill:#fff3cd,stroke:#ffc107
    style W2 fill:#fff3cd,stroke:#ffc107
    style W3 fill:#fff3cd,stroke:#ffc107
```

One daemon serves all worktrees. Workers redirect reads and writes to the manager. Hash-based IDs prevent collisions across concurrent agents. Append-only JSONL plus a custom merge driver handle branch merges.

```gitattributes
.opentasks/graph.jsonl merge=opentasks
```

## IDs

Hash-based, collision-resistant. Generated from UUID v4 through SHA256 and base36 encoding, with adaptive length based on entity count.

| Entity count | ID length | Example |
|-------------|-----------|---------|
| < 1,000 | 4 chars | t-x7k9 |
| < 6,000 | 5 chars | t-x7k9p |
| < 35,000 | 6 chars | t-x7k9pm |

## What This Is Not

OpenTasks is not a replacement for Claude Tasks, Beads, Jira, or any existing tool. It is not a unified CRUD API. It is not a project management tool. It is not an orchestration platform.

It adds the relationship layer these tools lack.

## Development

```bash
npm install
npm run build        # TypeScript compilation
npm test             # Unit tests
npm run test:slow    # Include slow tests
npm run test:e2e     # End-to-end tests
npm run test:all     # Everything
```

## Tech Stack

TypeScript 5.3+, better-sqlite3, graphology, chokidar, zod, proper-lockfile, Vitest.

Node >= 18 | MIT License | [github.com/alexngai/opentasks](https://github.com/alexngai/opentasks)
