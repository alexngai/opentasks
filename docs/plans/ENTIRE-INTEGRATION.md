# Entire Integration: Intent Tracking Provider & Auto-Linker

> Tags: entire, provider, intent-tracking, auto-linking, daemon
>
> Extends: [PROVIDERS.md](../PROVIDERS.md) · [ARCHITECTURE.md](../ARCHITECTURE.md)
>
> External: [Entire CLI](https://github.com/entireio/cli)

## Overview

This document specifies the integration between OpenTasks and [Entire](https://github.com/entireio/cli), an intent-tracking system for AI-assisted coding workflows. Entire captures the complete conversation history (prompts, responses, file changes, token usage) between a developer and an AI agent, preserving it alongside git history.

**What this integration provides:**

1. **Entire Provider** — Read-only provider that resolves `entire://` URIs to session and checkpoint data
2. **Entire Watcher** — Daemon component that monitors Entire session state files for changes
3. **Auto-Linker** — Correlation engine that automatically creates edges between OpenTasks tasks and Entire sessions/checkpoints

**The key value:** A complete, automatic audit trail from `spec → issue → session → checkpoint → commit` — answering both "what needs to be done" (OpenTasks) and "how was it done" (Entire).

---

## Motivation

### The Gap

OpenTasks tracks *what* needs doing and *how things relate* across systems. But it doesn't capture *the conversation and decision-making process* that led to implementation. When reviewing code later, you can see what changed (git diff) and why it was requested (OpenTasks issue), but not the back-and-forth that shaped the implementation.

### How Entire Fills It

Entire records the full AI session transcript — every prompt, every response, every file touched — and ties it to git commits via checkpoint IDs in commit trailers. By connecting OpenTasks' task graph to Entire's session records, we create a complete traceability chain.

### Why Automatic Linking Matters

Manual linking (`opentasks link --from i-x7k9 --to entire://checkpoint/a3b2`) would work but defeats the purpose. The integration should be zero-friction: work on tasks normally, and the graph builds itself. The daemon watches for Entire session events and correlates them with in-progress tasks automatically.

---

## Entire Concepts

### Sessions

An Entire **session** represents a single AI coding interaction (e.g., one Claude Code conversation). Sessions are identified by `YYYY-MM-DD-<UUID>` and have a lifecycle:

```
ACTIVE → IDLE → ENDED
```

Session state is stored in `.git/entire-sessions/<session-id>.json` and contains:
- Agent type (claude-code, gemini)
- Base commit hash
- Transcript position (for incremental parsing)
- Active checkpoint references

### Checkpoints

An Entire **checkpoint** is a snapshot tied to a git commit. Checkpoints are identified by hex hashes (e.g., `a3b2c4d5e6f7`) and contain:
- Full transcript (JSONL)
- User prompts (text)
- Context summary (markdown)
- Metadata (files touched, tokens used, session reference)

Checkpoints are stored on the `entire/checkpoints/v1` orphan branch in a sharded layout: `<id[:2]>/<id[2:]>/`.

### Commit Trailers

Entire adds `Entire-Checkpoint: <checkpoint-id>` trailers to commit messages, creating bidirectional links between user commits and checkpoint metadata.

---

## Data Model

### Node Mapping

| Entire Concept | OpenTasks Type | URI Format | Status Mapping |
|---|---|---|---|
| Session | `external` | `entire://session/<session-id>` | ACTIVE/IDLE → `open`, ENDED → `closed` |
| Checkpoint | `external` | `entire://checkpoint/<checkpoint-id>` | Always `closed` (immutable snapshots) |

### Edge Types

Three new edge types for Entire integration:

| Edge Type | Direction | Meaning | Example |
|---|---|---|---|
| `worked-on` | Task → Session | "This task was worked on during this session" | `i-x7k9 --worked-on→ entire://session/2026-02-13-abc` |
| `implemented-by` | Task → Checkpoint | "This commit checkpoint implements this task" | `i-x7k9 --implemented-by→ entire://checkpoint/a3b2c4` |
| `contains` | Session → Checkpoint | "This session produced this checkpoint" | `entire://session/... --contains→ entire://checkpoint/...` |

### ExternalNode Examples

**Session node in graph.jsonl:**
```jsonl
{"id":"e-en01","uuid":"...","type":"external","title":"Session: Implement auth flow","uri":"entire://session/2026-02-13-abc","source":"entire","materialized":true,"cached_at":"2026-02-13T15:30:00Z","external_status":"active","external_data":{"agent":"claude-code","baseCommit":"f4a2b1c","phase":"ACTIVE","tokenUsage":{"input":12500,"output":8300},"filesTouched":["src/auth.ts","src/middleware.ts"]},"created_at":"2026-02-13T15:00:00Z","updated_at":"2026-02-13T15:30:00Z"}
```

**Checkpoint node in graph.jsonl:**
```jsonl
{"id":"e-en02","uuid":"...","type":"external","title":"Checkpoint: Add login endpoint","uri":"entire://checkpoint/a3b2c4d5","source":"entire","materialized":true,"cached_at":"2026-02-13T15:35:00Z","external_status":"closed","external_data":{"sessionId":"2026-02-13-abc","commitHash":"d7e8f9a","promptCount":5,"filesModified":["src/auth.ts"],"filesNew":["src/routes/login.ts"],"tokenUsage":{"input":12500,"output":8300,"cache":4200}},"created_at":"2026-02-13T15:35:00Z","updated_at":"2026-02-13T15:35:00Z"}
```

**Auto-created edges:**

> **Note:** `from_id` and `to_id` use the graph store's internal node IDs (e.g., `x-en01`), not URIs. The URI is stored on the node itself.

```jsonl
{"id":"x-ew01","uuid":"...","from_id":"i-x7k9","to_id":"x-en01","type":"worked-on","created_at":"2026-02-13T15:00:00Z","metadata":{"_context":{"source":"entire-auto-linker","correlation":"claimed-task","confidence":"high"}}}
{"id":"x-ew02","uuid":"...","from_id":"i-x7k9","to_id":"x-en02","type":"implemented-by","created_at":"2026-02-13T15:35:00Z","metadata":{"_context":{"source":"entire-auto-linker","correlation":"claimed-task","confidence":"high","checkpointId":"a3b2c4d5"}}}
{"id":"x-ew03","uuid":"...","from_id":"x-en01","to_id":"x-en02","type":"contains","created_at":"2026-02-13T15:35:00Z","metadata":{"_context":{"source":"entire-auto-linker"}}}
```

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     OpenTasks Daemon                              │
│                                                                   │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ Entire       │  │ Entire           │  │ Entire            │  │
│  │ Provider     │  │ Watcher          │  │ Auto-Linker       │  │
│  │              │  │                  │  │                   │  │
│  │ Resolves     │  │ Monitors         │  │ Correlates        │  │
│  │ entire://    │  │ .git/entire-     │  │ sessions ↔ tasks  │  │
│  │ URIs via CLI │  │ sessions/*.json  │  │ via claims/status │  │
│  └──────┬───────┘  └────────┬─────────┘  └─────────┬─────────┘  │
│         │                   │                      │             │
│         │          ┌────────▼─────────┐            │             │
│         │          │  Session Event   │────────────▶│             │
│         │          │  (new/update/    │             │             │
│         │          │   delete)        │    ┌────────▼─────────┐  │
│         │          └──────────────────┘    │  Graph Store     │  │
│         │                                  │  - Create nodes  │  │
│         └─────────────────────────────────▶│  - Create edges  │  │
│                                            │  - Mark dirty    │  │
│                                            │  - Flush to JSONL│  │
│                                            └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
┌───────────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ .git/entire-      │ │ Entire CLI   │ │ .opentasks/          │
│ sessions/*.json   │ │ (entire      │ │ graph.jsonl          │
│ (session state)   │ │  explain,    │ │ (nodes + edges)      │
│                   │ │  status)     │ │                      │
└───────────────────┘ └──────────────┘ └──────────────────────┘
```

### Data Flow

```
1. Agent claims task
   ┌────────────────────────────────────────────────────────────┐
   │ opentasks update i-x7k9 --status in_progress              │
   │ → GraphStore: i-x7k9.status = "in_progress"               │
   │ → GraphStore: i-x7k9.claimed_by = "claude-agent-1"        │
   └────────────────────────────────────────────────────────────┘

2. Entire SessionStart hook fires
   ┌────────────────────────────────────────────────────────────┐
   │ Entire writes .git/entire-sessions/2026-02-13-abc.json     │
   │ → EntireWatcher detects new file                           │
   │ → EntireWatcher parses session metadata                    │
   │ → EntireWatcher emits SessionEvent { type: 'started' }     │
   └────────────────────────────────────────────────────────────┘

3. Auto-Linker correlates session with tasks
   ┌────────────────────────────────────────────────────────────┐
   │ → Queries graph for in_progress/claimed tasks              │
   │ → Finds i-x7k9 (claimed, in_progress, matching branch)    │
   │ → Creates ExternalNode: entire://session/2026-02-13-abc    │
   │ → Creates edge: i-x7k9 --worked-on→ session               │
   │ → Marks dirty, schedules flush                             │
   └────────────────────────────────────────────────────────────┘

4. Agent works, makes commits
   ┌────────────────────────────────────────────────────────────┐
   │ Entire post-commit hook fires                              │
   │ → Checkpoint a3b2c4 condensed to orphan branch             │
   │ → Session file updated with checkpoint reference           │
   │ → EntireWatcher detects file change                        │
   │ → EntireWatcher emits SessionEvent { type: 'checkpoint' }  │
   └────────────────────────────────────────────────────────────┘

5. Auto-Linker creates checkpoint edges
   ┌────────────────────────────────────────────────────────────┐
   │ → Reads checkpoint ID from session state                   │
   │ → Creates ExternalNode: entire://checkpoint/a3b2c4         │
   │ → Creates edge: i-x7k9 --implemented-by→ checkpoint       │
   │ → Creates edge: session --contains→ checkpoint             │
   │ → Fetches metadata via `entire explain` for node content   │
   │ → Marks dirty, schedules flush                             │
   └────────────────────────────────────────────────────────────┘

6. Session ends
   ┌────────────────────────────────────────────────────────────┐
   │ Entire Stop hook fires                                     │
   │ → Session file updated: phase = "ENDED"                    │
   │ → EntireWatcher detects file change                        │
   │ → Auto-Linker updates session node: status → "closed"      │
   │ → Marks dirty, schedules flush                             │
   └────────────────────────────────────────────────────────────┘
```

---

## Component Specifications

### 1. Entire Provider (`src/providers/entire.ts`)

Read-only provider that resolves `entire://` URIs by shelling out to the Entire CLI.

#### Configuration

```typescript
interface EntireConfig {
  /** Enable Entire provider */
  enabled: boolean           // default: true

  /** Path to entire executable */
  executable: string         // default: 'entire'

  /** Command timeout (ms) */
  timeout: number            // default: 30000
}
```

#### URI Scheme

```
entire://session/<session-id>
entire://checkpoint/<checkpoint-id>

Examples:
  entire://session/2026-02-13-a1b2c3d4
  entire://checkpoint/a3b2c4d5e6f7
```

#### Provider Interface

```typescript
function createEntireProvider(config: EntireConfig): Provider {
  return {
    name: 'entire',
    schemes: ['entire'],
    capabilities: {
      read: true,
      write: false,      // Entire manages its own lifecycle
      search: true,       // Search prompts/transcripts
      watch: false,       // Watcher is separate daemon component
    },

    parseUri(uri: string): ParsedUri | null
    buildUri(id: string, options?: UriOptions): string
    isValidUri(uri: string): boolean

    get(id: string): Promise<ProviderNode | null>
    list(filter?: ProviderFilter): Promise<ProviderNode[]>
    search(query: string, options?: SearchOptions): Promise<ProviderNode[]>

    // Write operations throw NOT_SUPPORTED
    create(): Promise<never>
    update(): Promise<never>
    delete(): Promise<never>
  }
}
```

#### URI Parsing

```typescript
// Pattern: entire://(session|checkpoint)/<id>
const ENTIRE_URI_PATTERN = /^entire:\/\/(session|checkpoint)\/(.+)$/i

// Parse into components
parseUri('entire://session/2026-02-13-abc')
// → { scheme: 'entire', workspace: 'session', id: '2026-02-13-abc', isRelative: false }

parseUri('entire://checkpoint/a3b2c4d5')
// → { scheme: 'entire', workspace: 'checkpoint', id: 'a3b2c4d5', isRelative: false }
```

#### CLI Integration

The provider shells out to Entire CLI commands:

| Operation | CLI Command | Fallback |
|---|---|---|
| Get session | `entire status --json` | Read `.git/entire-sessions/<id>.json` directly |
| Get checkpoint | `entire explain --json --checkpoint <id>` | Read from orphan branch via `git show` |
| List sessions | `entire status --json --all` | Glob `.git/entire-sessions/*.json` |
| List checkpoints | `entire rewind --list` | Parse orphan branch tree |
| Search | `entire explain --json` + grep prompts | Grep session files |

**Fallback strategy:** If the `entire` CLI is not available, the provider can fall back to direct git/filesystem reads. This makes the provider resilient to Entire not being installed, while still being able to read previously-recorded data.

#### Node Conversion

**Session → ProviderNode:**
```typescript
function sessionToProviderNode(session: EntireSession): ProviderNode {
  return {
    id: session.id,
    uri: `entire://session/${session.id}`,
    type: 'external',
    title: `Session: ${session.summary || session.id}`,
    content: session.prompts?.join('\n---\n'),
    status: session.phase === 'ENDED' ? 'closed' : 'open',
    rawData: {
      agent: session.agent,
      baseCommit: session.baseCommit,
      phase: session.phase,
      tokenUsage: session.tokenUsage,
      filesTouched: session.filesTouched,
      checkpoints: session.checkpoints,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    },
    fetchedAt: new Date().toISOString(),
  }
}
```

**Checkpoint → ProviderNode:**
```typescript
function checkpointToProviderNode(checkpoint: EntireCheckpoint): ProviderNode {
  return {
    id: checkpoint.id,
    uri: `entire://checkpoint/${checkpoint.id}`,
    type: 'external',
    title: `Checkpoint: ${checkpoint.commitMessage || checkpoint.id}`,
    content: checkpoint.context,           // context.md summary
    status: 'closed',                      // checkpoints are immutable
    rawData: {
      sessionId: checkpoint.sessionId,
      commitHash: checkpoint.commitHash,
      promptCount: checkpoint.promptCount,
      filesModified: checkpoint.filesModified,
      filesNew: checkpoint.filesNew,
      filesDeleted: checkpoint.filesDeleted,
      tokenUsage: checkpoint.tokenUsage,
      transcript: checkpoint.transcript,   // full.jsonl path reference
    },
    fetchedAt: new Date().toISOString(),
  }
}
```

---

### 2. Entire Watcher (`src/daemon/entire-watcher.ts`)

Daemon component that watches `.git/entire-sessions/` for session state changes and emits structured events.

#### Interface

```typescript
interface EntireWatcher {
  /** Start watching for session changes */
  start(): void

  /** Stop watching */
  stop(): void

  /** Register event handler */
  onSessionEvent(handler: SessionEventHandler): void

  /** Check if watching */
  readonly isWatching: boolean
}

type SessionEventHandler = (event: EntireSessionEvent) => void

interface EntireSessionEvent {
  type: 'started' | 'updated' | 'checkpoint' | 'ended' | 'deleted'
  sessionId: string
  session: EntireSessionState
  previousPhase?: string        // For 'updated' and 'ended' events
  checkpointId?: string         // For 'checkpoint' events
  timestamp: string
}

interface EntireSessionState {
  id: string
  agent: string                 // 'claude-code' | 'gemini'
  phase: 'ACTIVE' | 'IDLE' | 'ENDED'
  baseCommit: string
  branch?: string
  startedAt: string
  endedAt?: string
  checkpoints: string[]         // Checkpoint IDs
  lastPromptAt?: string
}
```

#### Watch Path

```
.git/entire-sessions/
├── 2026-02-13-a1b2c3d4.json    ← session state files
├── 2026-02-13-e5f6g7h8.json
└── ...
```

The watcher resolves the git directory from the OpenTasks location path (handling worktrees correctly via `git rev-parse --git-dir`).

#### Event Detection

The watcher uses chokidar (same as existing file watcher) with debouncing:

```typescript
function createEntireWatcher(options: EntireWatcherOptions): EntireWatcher {
  // Resolve .git directory (supports worktrees)
  const gitDir = resolveGitDir(options.locationPath)
  const sessionsDir = path.join(gitDir, 'entire-sessions')

  // Track known state for diff detection
  const sessionCache = new Map<string, EntireSessionState>()

  // Watch with chokidar
  const watcher = chokidar.watch(path.join(sessionsDir, '*.json'), {
    ignoreInitial: false,     // Process existing sessions on startup
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  })

  watcher.on('add', (filePath) => handleFileChange(filePath, 'add'))
  watcher.on('change', (filePath) => handleFileChange(filePath, 'change'))
  watcher.on('unlink', (filePath) => handleFileDelete(filePath))
}
```

**Event type determination:**

| File Event | Previous State | New State | Emitted Event |
|---|---|---|---|
| `add` | — | ACTIVE | `started` |
| `add` | — | ENDED | `ended` (late detection) |
| `change` | ACTIVE | ACTIVE (more checkpoints) | `checkpoint` |
| `change` | ACTIVE | IDLE | `updated` |
| `change` | ACTIVE/IDLE | ENDED | `ended` |
| `change` | same checkpoints, same phase | — | (suppressed, no event) |
| `unlink` | any | — | `deleted` |

#### Resilience

- **Missing directory:** If `.git/entire-sessions/` doesn't exist, the watcher waits for it silently (chokidar handles this via `ignorePermissionErrors`). This means the watcher can be started before Entire is enabled.
- **Malformed JSON:** Parse errors are logged but don't crash the watcher. The session is skipped until the file becomes valid.
- **Git worktrees:** The watcher resolves the correct `.git` path per worktree, so each worktree's sessions are tracked independently.
- **Rapid writes:** Entire may write session files rapidly during agent responses. The `awaitWriteFinish` option ensures we only process stable files.

---

### 3. Auto-Linker (`src/daemon/entire-linker.ts`)

Correlation engine that matches Entire sessions to OpenTasks tasks and creates edges automatically.

#### Interface

```typescript
interface EntireAutoLinker {
  /** Handle a session event from the watcher */
  handleSessionEvent(event: EntireSessionEvent): Promise<void>

  /** Manually trigger correlation for a session */
  correlate(sessionId: string): Promise<CorrelationResult>

  /** Get correlation history */
  getCorrelations(): Map<string, CorrelationResult>
}

interface CorrelationResult {
  sessionId: string
  matchedTasks: MatchedTask[]
  edgesCreated: string[]        // Edge IDs
  nodesCreated: string[]        // External node IDs
  strategy: CorrelationStrategy
  timestamp: string
}

interface MatchedTask {
  nodeId: string
  uri: string
  matchReason: CorrelationStrategy
  confidence: 'high' | 'medium' | 'low'
}

type CorrelationStrategy = 'claimed-task' | 'in-progress-branch' | 'in-progress-any'
```

#### Correlation Strategy

The auto-linker uses three signals to match sessions to tasks, checked in priority order:

**1. Claimed Tasks (high confidence)**

Tasks with `claimed_by` matching the agent identifier from the Entire session. This is the strongest signal because it represents an explicit claim.

```typescript
// Query: find tasks claimed by this agent
const claimed = await store.query.nodes({
  type: 'issue',
  filter: (node) =>
    node.claimed_by != null &&
    !isExpired(node.lock_until) &&
    matchesAgent(node.claimed_by, session.agent),
})
```

**2. In-Progress on Same Branch (medium confidence)**

Tasks with `status: 'in_progress'` whose `branch` field matches the current git branch. This catches tasks that were set to in-progress but not formally claimed.

```typescript
// Query: find in-progress tasks on this branch
const branchTasks = await store.query.nodes({
  type: 'issue',
  status: 'in_progress',
  filter: (node) => node.branch === session.branch,
})
```

**3. In-Progress (Any) (low confidence)**

All tasks with `status: 'in_progress'` when no higher-confidence matches exist. This is the broadest fallback — useful when a single task is in progress.

```typescript
// Only used when strategies 1 and 2 find nothing
const allInProgress = await store.query.nodes({
  type: 'issue',
  status: 'in_progress',
})
// Only auto-link if there's exactly 1 in-progress task (ambiguity guard)
```

**Ambiguity guard:** For the lowest-confidence strategy, the linker only auto-links when there is exactly one in-progress task. If multiple tasks are in-progress with no branch/claim differentiation, the linker creates the session node but skips edge creation (logged as "ambiguous correlation"). Users can manually link later.

#### Event Handling

```typescript
async function handleSessionEvent(event: EntireSessionEvent): Promise<void> {
  switch (event.type) {
    case 'started': {
      // 1. Create session ExternalNode
      const sessionNode = await ensureSessionNode(event.session)
      // 2. Correlate with tasks
      const tasks = await findCorrelatedTasks(event.session)
      // 3. Create worked-on edges
      for (const task of tasks) {
        await createEdgeIfNotExists(task.nodeId, sessionNode.uri, 'worked-on')
      }
      break
    }

    case 'checkpoint': {
      // 1. Create checkpoint ExternalNode
      const cpNode = await ensureCheckpointNode(event.checkpointId!, event.session)
      // 2. Create contains edge (session → checkpoint)
      const sessionUri = `entire://session/${event.sessionId}`
      await createEdgeIfNotExists(sessionUri, cpNode.uri, 'contains')
      // 3. Create implemented-by edges (tasks → checkpoint)
      const tasks = await findCorrelatedTasks(event.session)
      for (const task of tasks) {
        await createEdgeIfNotExists(task.nodeId, cpNode.uri, 'implemented-by')
      }
      break
    }

    case 'ended': {
      // Update session node status to closed
      await updateSessionNodeStatus(event.sessionId, 'closed')
      break
    }

    case 'updated': {
      // Update session node metadata (token usage, files touched, etc.)
      await refreshSessionNode(event.sessionId, event.session)
      break
    }

    case 'deleted': {
      // Log but don't delete nodes (preserve history)
      // Edges remain valid as historical record
      break
    }
  }
}
```

#### Idempotency

All operations are idempotent:
- `ensureSessionNode` creates only if no ExternalNode with matching URI exists
- `ensureCheckpointNode` creates only if no ExternalNode with matching URI exists
- `createEdgeIfNotExists` queries existing edges before creating

This is important because:
- Session files may be written multiple times
- The watcher may re-process files on daemon restart
- Multiple checkpoints may trigger re-correlation with the same tasks

#### Edge Metadata

Auto-created edges include metadata for auditability:

```typescript
{
  _context: {
    source: 'entire-auto-linker',
    correlation: 'claimed-task',  // which strategy matched
    timestamp: '2026-02-13T15:00:00Z',
    sessionAgent: 'claude-code',
    confidence: 'high',
  }
}
```

---

## Daemon Integration

### Startup Sequence

The Entire watcher and auto-linker are initialized during daemon startup, alongside the existing file watcher:

```typescript
// In src/daemon/location-state.ts (or equivalent)

async function initializeLocation(state: LocationState): Promise<void> {
  // ... existing initialization ...

  // Initialize Entire integration (if enabled)
  if (config.providers.entire?.enabled) {
    const entireWatcher = createEntireWatcher({
      locationPath: state.locationPath,
      debounceMs: 200,
    })

    const autoLinker = createEntireAutoLinker({
      store: state.store,
      flushManager: state.flushManager,
      provider: state.registry.get('entire'),
    })

    entireWatcher.onSessionEvent((event) => {
      autoLinker.handleSessionEvent(event)
    })

    entireWatcher.start()
    state.entireWatcher = entireWatcher
  }
}
```

### Shutdown Sequence

```typescript
async function shutdownLocation(state: LocationState): Promise<void> {
  // Stop Entire watcher before final flush
  state.entireWatcher?.stop()

  // ... existing shutdown (flush, close store, etc.) ...
}
```

---

## Configuration

### Config Schema Addition

```typescript
// In src/config/schema.ts

const EntireProviderConfigSchemaInner = z.object({
  /** Enable Entire provider and auto-linking */
  enabled: z.boolean().default(true),

  /** Path to entire executable */
  executable: z.string().default('entire'),

  /** Command timeout (ms) */
  timeout: z.number().min(1000).default(30000),

  /** Enable automatic session ↔ task linking */
  autoLink: z.boolean().default(true),

  /** Minimum confidence for auto-linking */
  autoLinkMinConfidence: z.enum(['high', 'medium', 'low']).default('medium'),
})
```

### Config File Example

```json
{
  "providers": {
    "entire": {
      "enabled": true,
      "executable": "entire",
      "timeout": 30000,
      "autoLink": true,
      "autoLinkMinConfidence": "medium"
    }
  }
}
```

### Auto-Detection

Like the Beads and Sudocode providers, the Entire provider checks for CLI availability on startup:

```typescript
// Check if entire CLI is available
const isAvailable = await isCliAvailable('entire')

// Also check if Entire is enabled in this repo
const hasEntireSessions = await pathExists(
  path.join(gitDir, 'entire-sessions')
)
```

If `entire` CLI is not installed but `.git/entire-sessions/` exists, the watcher still works (using direct file reads). The provider falls back to git operations for checkpoint data.

---

## Query Examples

### What sessions relate to a task?

```bash
opentasks query '{"edges": {"fromId": "i-x7k9", "type": "worked-on"}}'
```

Returns:
```json
[
  {
    "id": "x-ew01",
    "from_id": "i-x7k9",
    "to_id": "entire://session/2026-02-13-abc",
    "type": "worked-on"
  }
]
```

### What checkpoints implement a task?

```bash
opentasks query '{"edges": {"fromId": "i-x7k9", "type": "implemented-by"}}'
```

### Get full session details

```bash
opentasks get entire://session/2026-02-13-abc
```

Returns the ExternalNode with `external_data` containing agent, tokens, files touched, etc.

### Get checkpoint with transcript

```bash
opentasks get entire://checkpoint/a3b2c4d5
```

Returns the ExternalNode with `external_data` containing commit hash, prompts, files modified, token usage.

### Full traceability chain

```bash
# Spec → Issues implementing it
opentasks query '{"implementers": {"specId": "s-a2b3"}}'

# Issue → Checkpoints that implemented it
opentasks query '{"edges": {"fromId": "i-x7k9", "type": "implemented-by"}}'

# Checkpoint → Session that produced it
opentasks query '{"edges": {"toId": "entire://checkpoint/a3b2c4d5", "type": "contains"}}'
```

This gives the complete chain: `spec → issue → checkpoint → session → transcript`.

### Find sessions by file

```bash
# Which sessions touched auth.ts?
opentasks query '{"nodes": {"type": "external", "source": "entire"}}' \
  | jq '.[] | select(.external_data.filesTouched | index("src/auth.ts"))'
```

---

## File Manifest

| File | Action | Description |
|---|---|---|
| `src/providers/entire.ts` | Create | Entire provider (read-only, CLI-based, ~350 lines) |
| `src/providers/__tests__/entire.test.ts` | Create | Provider unit tests (~300 lines) |
| `src/daemon/entire-watcher.ts` | Create | Session file watcher (~200 lines) |
| `src/daemon/entire-linker.ts` | Create | Auto-correlation engine (~300 lines) |
| `src/daemon/__tests__/entire-watcher.test.ts` | Create | Watcher unit tests (~200 lines) |
| `src/daemon/__tests__/entire-linker.test.ts` | Create | Linker unit tests (~250 lines) |
| `src/config/schema.ts` | Edit | Add `EntireProviderConfigSchema` |
| `src/providers/from-config.ts` | Edit | Wire up Entire provider creation |
| `src/providers/index.ts` | Edit | Export Entire provider |
| `src/daemon/location-state.ts` | Edit | Initialize watcher + linker on startup |
| `docs/plans/ENTIRE-INTEGRATION.md` | Create | This document |

---

## Edge Cases & Design Decisions

### Multiple tasks in progress

When multiple tasks are in progress and the correlation strategy cannot differentiate (no claims, no branch match), the auto-linker creates the session node but **does not create edges** to avoid false positives. A warning is logged. Users can manually link with `opentasks link`.

### Concurrent Entire sessions

Entire supports concurrent sessions. The watcher handles each session file independently. If two sessions overlap, both get their own ExternalNode and edges. Tasks may be linked to multiple concurrent sessions (this is correct — the task was worked on in both).

### Session spanning multiple tasks

A single session may touch multiple tasks. The auto-linker creates edges to **all** correlated tasks, not just one. This accurately reflects multi-task sessions.

### Task status changes during session

If a task moves from `in_progress` to `closed` while a session is active, existing edges remain. The auto-linker only correlates at event time — it doesn't retroactively remove edges if task status changes.

### Entire not installed

If Entire CLI is not installed:
- Provider gracefully degrades to direct git/file reads
- Watcher still works if `.git/entire-sessions/` exists
- Auto-linker still works (doesn't depend on CLI)
- Provider `list()` and `search()` may return fewer results without CLI

### Repo without Entire enabled

If Entire was never enabled in the repo:
- No `.git/entire-sessions/` directory exists
- Watcher starts but detects no files (silent)
- Provider returns empty results
- No errors, no noise

### Checkpoint without session

Edge case where a checkpoint exists on the orphan branch but no session file remains. The provider can still resolve `entire://checkpoint/<id>` via git, and the checkpoint node is standalone (no `contains` edge to a session).

---

## Testing Strategy

### Unit Tests

**Provider tests** (mirror claude-tasks.test.ts pattern):
- URI parsing (session and checkpoint URIs)
- URI building
- Node conversion (session → ProviderNode, checkpoint → ProviderNode)
- Status mapping
- CLI command construction
- Fallback to git reads when CLI unavailable
- Error handling (CLI timeout, malformed JSON)

**Watcher tests:**
- Event detection from file creates/updates/deletes
- Correct event type determination (started vs checkpoint vs ended)
- Debouncing rapid writes
- Missing directory handling
- Malformed JSON handling
- Cache consistency (previous state tracking)

**Linker tests:**
- Correlation strategy priority (claimed > branch > any)
- Ambiguity guard (multiple in-progress, no edges)
- Idempotent node/edge creation
- All event types (started, checkpoint, ended, updated)
- Edge metadata correctness
- Concurrent session handling

### Integration Tests

- Full flow: claim task → session starts → checkpoint → session ends → verify graph
- Daemon startup with Entire enabled
- Daemon startup without Entire (graceful skip)
- Provider resolution through registry

---

## Future Extensions

### v2: Bi-directional Context

When an agent starts working on a task, inject the task's context (title, spec, blocking issues) into the Entire session metadata. This gives the agent richer context and makes the session transcript more informative.

### v3: Session Summaries as Feedback

Auto-generate a summary of each session and attach it as feedback to the linked tasks. This creates a running commentary: "Session 2026-02-13: Implemented login endpoint, added JWT validation, hit CORS issue and worked around it."

### v4: Checkpoint-Based Rollback

Integrate Entire's `rewind` capability with OpenTasks. When a task is re-opened, offer to rewind to the checkpoint where it was last stable.

### v5: Cross-Agent Correlation

Track multiple agents working on related tasks. If Agent A's session touches files that Agent B's task depends on, create a `related` edge between the tasks automatically.

---

## References

### External
- [Entire CLI Repository](https://github.com/entireio/cli)
- [Entire Documentation](https://github.com/entireio/cli#readme)

### Internal
- [PROVIDERS.md](../PROVIDERS.md) — Provider architecture
- [ARCHITECTURE.md](../ARCHITECTURE.md) — Daemon and location model
- [SCHEMA.md](../SCHEMA.md) — Node and edge types
- [DESIGN.md](../DESIGN.md) — Core design rationale
