# OpenTasks - Claude Context

Cross-system task graph. Links Claude Tasks, Beads, Jira, Linear, MAP, and other systems via a shared edge layer.

## Project Structure

```
src/
├── graph/              # Graph store, edge operations, query engine
├── providers/          # Provider implementations (see below)
│   ├── native.ts       # Native provider (graph.jsonl storage)
│   ├── beads.ts        # Beads CLI provider
│   ├── claude-tasks.ts # Claude Tasks provider
│   ├── sudocode.ts     # Sudocode provider
│   ├── global.ts       # Global store provider (~/.opentasks)
│   ├── sessionlog.ts   # Sessionlog session provider
│   ├── map.ts          # MAP provider (inbound — remote tasks → graph)
│   ├── map-event-bridge.ts  # MAP event bridge (outbound — graph → MAP events)
│   ├── map-client-factory.ts # MAP SDK client factory (dynamic import)
│   ├── registry.ts     # Provider registry
│   ├── from-config.ts  # Config-based provider factory
│   ├── materialization.ts # Materialization manager
│   ├── sync.ts         # Sync extensions
│   ├── types.ts        # Provider types and interfaces
│   └── traits/         # Provider traits (Watchable, TaskManageable, RelationshipQueryable)
├── context-files/      # File-backed context nodes (see below)
│   ├── types.ts        # ContextFileMetadata, ContextFileResolution, DriftResult
│   ├── context-files.ts # ContextFileManager — create, resolve, checkDrift, sync
│   ├── resolver.ts     # File I/O, git show, content hashing
│   └── watcher-integration.ts # Daemon file watcher bridge for drift detection
├── daemon/             # Unix socket daemon, IPC, lifecycle
├── client/             # Client library (connects to daemon)
├── mcp/                # MCP server (Model Context Protocol tool interface)
├── config/             # Config schema (Zod), parsing, validation
├── materialization/    # Materialization stores (git, remote)
├── persistence/        # JSONL persister, SQLite cache
└── __tests__/          # Test files co-located with modules
```

## Key Concepts

- **Graph store** owns edges and node references
- **Providers** own node content — OpenTasks delegates CRUD to them
- **Daemon** coordinates access via Unix socket IPC
- **Providers are federated** — each handles its own URI scheme (`native://`, `beads://`, `map://`, etc.)

## MAP Integration

Two independent components for MAP (Multi-Agent Protocol) support:

### MAP Provider (`src/providers/map.ts`)

Inbound: surfaces remote MAP tasks as `map://` nodes in the graph.

- **Ephemeral / pass-through** — no local cache, every operation is a direct RPC call
- When connection is open, MAP tasks are visible alongside native/beads/claude-tasks nodes
- When connection drops, `map://` nodes stop being queryable — no stale data
- Implements `Provider` + `TaskManageable` + optional `Watchable`
- Depends on `MAPTaskClient` interface (MAP SDK connections satisfy this naturally)
- Status mapping: MAP `completed`/`failed` → OpenTasks `closed`; OpenTasks `closed` → MAP `completed`

### MAP Event Bridge (`src/providers/map-event-bridge.ts`)

Outbound: emits OpenTasks graph changes as MAP task events.

- **Standalone** — not daemon-owned, agents create their own bridges
- Two input modes: raw `send` function OR shared `MAPConnection` object
- Two usage patterns: agent-side direct emit OR daemon-side provider change handler
- Echo prevention: skips `map` provider changes, stamps `_origin` on events
- `MAPConnection` interface is compatible with agent-inbox's `MapConnection` and MAP SDK connections

### MAP Client Factory (`src/providers/map-client-factory.ts`)

Creates `MAPTaskClient` + `MAPEventSender` from a MAP server URL.

- Dynamically imports `@multi-agent-protocol/sdk` (optional dependency)
- Returns `null` if SDK not installed or connection fails — graceful degradation
- No `package.json` dependency on the SDK

### Why Agent-Owned (Not Daemon-Owned)

MAP connections are an agent-level concern. Different agents may connect to different MAP servers with different scopes. The daemon stays dumb about MAP — it doesn't establish connections or own bridges. Agents/plugins read config and create their own connections.

## Context Files

Context nodes can reference codebase files instead of storing content inline. File-backed contexts are lightweight pointers — content is resolved on access from the working tree or at a pinned git commit.

### Source types

| Source | Stored in node? | How content is resolved |
|--------|-----------------|------------------------|
| inline (default) | Yes (`content` field) | Read directly from the node |
| file | No (pointer) | `readFileFromWorktree()` or `git show <sha>:<path>` |
| snippet | No (pointer) | Same as file, scoped to a line range |

### Metadata (on `node.metadata`)

- `context_file: true` — marker distinguishing file-backed from inline contexts
- `context_file_path` — repo-relative path (e.g. `"src/auth/middleware.ts"`)
- `context_file_type` — `"markdown"` | `"code"` | `"text"` (inferred from extension)
- `context_file_commit` — git SHA when last synced
- `context_file_content_hash` — SHA-256 of content at sync time
- `context_file_synced_at` — ISO timestamp

For snippets, additional metadata: `context_source: "snippet"`, `context_line_start`, `context_line_end`.

### ContextFileManager (`src/context-files/context-files.ts`)

Factory: `createContextFileManager(store, repoRoot)`. Methods:

- `create(input)` — verify file exists, compute hash, record HEAD commit, create context node (no content stored)
- `resolve(nodeId)` — read file from worktree, return content + drift status
- `resolveAtCapturedCommit(nodeId)` — read file at pinned commit via `git show`
- `checkDrift(nodeId)` — compare current hash vs captured hash (no content returned)
- `sync(nodeId, options?)` — re-pin to current HEAD (no-ops if unchanged unless `force: true`)
- `list()` — all context-file nodes in the store

### Daemon RPC (`src/daemon/methods/context-files.ts`)

IPC methods: `contextFiles.create`, `contextFiles.resolve`, `contextFiles.checkDrift`, `contextFiles.sync`, `contextFiles.checkDriftBatch`. Derives `repoRoot` from `LocationState.opentasksPath`.

## MCP Server

Exposes the OpenTasks tool interface over Model Context Protocol (`src/mcp/server.ts`). Connects to daemon via `OpenTasksClient`.

### Scopes

- `tasks` (default) — `create_task`, `get_task`, `update_task`, `delete_task`, `list_tasks`, `list_providers`, `reconcile`
- `graph` — `link`, `query`, `context_summary`
- `annotate` — `annotate`
- `context` — `create_context`, `get_context`, `update_context`, `list_contexts`

### Context tools — source support

The 4 context tools handle all source types (inline, file, snippet) with zero additional tools:

- **`create_context`** — optional `source` param: `{ type: "file", path, commit? }` or `{ type: "snippet", path, startLine, endLine }`. Omit for inline.
- **`get_context`** — `resolve: true` fetches file content + drift status for file-backed contexts. `atCapturedCommit: true` reads at the pinned commit.
- **`update_context`** — `sync: true` re-pins file to current HEAD. `force: true` forces re-pin even if unchanged.
- **`list_contexts`** — `filesOnly: true` filters to file-backed. `checkDrift: true` batch-checks drift for all file-backed contexts.

## Config Schema

Defined in `src/config/schema.ts` using Zod. Key sections:

- `storage` — JSONL/SQLite paths, compaction ratio
- `daemon` — socket path, auto-start, flush interval
- `providers` — per-provider config (beads, claudeTasks, sudocode, sessionlog, global, map); each supports `materializeMode: 'cached' | 'pointer'`
- `providers.map` — `enabled`, `server`, `systemId`, `agentName`, `scope`, `eventBridge`
- `logging` — level, file
- `materialization` — git archiving, remote stores, policies
- `sync` — git sync settings

## Testing

```bash
npm test                    # Watch mode
npm run test:run           # Single run
npx vitest run <path>      # Single file
npm run test:slow          # Include slow tests
npm run test:e2e           # End-to-end
```

Tests are co-located: `src/providers/__tests__/map-event-bridge.test.ts`, etc.

## Build

```bash
npm run build              # TypeScript compilation
npm run typecheck          # Type checking only
```

## Provider Traits

Providers can implement optional traits (in `src/providers/traits/`):

- **TaskManageable** — semantic task actions (`start`, `complete`, `block`, `reopen`, `close`), assignment, ready queries
- **Watchable** — real-time change events with configurable granularity
- **RelationshipQueryable** — edge queries from the provider's perspective
- **Reconcilable** — batch reconciliation with content hashes (optimization for remote providers)

Check with `isTaskManageable(provider)`, `isWatchable(provider)`, `isRelationshipQueryable(provider)`, `isReconcilable(provider)`.

## Provider Reconciliation

Provider-backed nodes cache data from the provider but mark it non-authoritative. See [docs/PROVIDER-RECONCILIATION.md](./docs/PROVIDER-RECONCILIATION.md) for full design.

**Key metadata fields** (on `node.metadata`):
- `provider_uri` — canonical URI in the owning provider
- `provider_source` — provider scheme name
- `provider_cached_at` — ISO timestamp of last fetch from provider
- `provider_authoritative` — flag marking provider as source of truth
- `provider_content_hash` — optional hash for fast diff during reconciliation
- `provider_pointer_only` — opt-in mode: data resolved on access, not cached

**Materialization modes** (per-provider via `materializeMode`):
- `cached` (default) — full data (title, content, status) stored in graph node
- `pointer` — only `provider_uri` stored; data fetched transparently on access with session-scoped cache

**Reconciliation** (`providerStore.reconcileProviders()`):
- Scans nodes with `metadata.provider_authoritative === true`
- Checks `provider.isAvailable()` before processing (skips unavailable providers)
- Positive-writes-only: never deletes/archives when provider is unavailable
- Edge reconciliation via `rawData` extraction (zero extra provider calls)
- Triggered on `store.reload()` (file watcher detects `graph.jsonl` changes)

**Storage layer**: SQLite `nodes` table has a `metadata TEXT` column (JSON). `findByProviderUri()` and `findExternalNodeByUri()` scan by node type since SQLite `search` only checks title/content, not metadata.

## Common Patterns

- Providers return `ProviderNode` (normalized view) — raw data goes in `rawData`
- Errors use `ProviderError` with typed codes (`OPERATION_FAILED`, `NOT_FOUND`, etc.)
- URIs follow `scheme://workspace/id` pattern — each provider parses/builds its own
- Config uses Zod schemas with sensible defaults — partial configs are valid
