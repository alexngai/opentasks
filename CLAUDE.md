# OpenTasks - Claude Context

Cross-system task graph. Links Claude Tasks, Beads, Jira, Linear, MAP, and other systems via a shared edge layer, with a CLI, a local daemon, and an MCP server.

## Project Structure

```
src/
├── graph/              # Graph store, edge operations, query engine
├── providers/          # Provider implementations (native, beads, claude-tasks, sudocode,
│                       #   global, sessionlog, map, map-event-bridge, map-client-factory)
│   └── traits/         # Provider traits (Watchable, TaskManageable, RelationshipQueryable)
├── context-files/      # File-backed context nodes (see below)
├── daemon/             # Unix socket daemon, IPC, lifecycle (methods/ = per-domain RPC handlers)
├── client/             # Client library (connects to daemon)
├── mcp/                # MCP server (Model Context Protocol tool interface)
├── config/             # Config schema (Zod), parsing, validation
├── storage/            # JSONL persister, SQLite cache
├── materialization/    # Materialization stores (git, remote archiving)
├── schema/             # Node/edge Zod schemas and validation
├── core/               # ID generation, hashing, location/worktree discovery, git merge driver
├── tools/              # Shared tool-call implementations (task, link, query, annotate)
├── tracking/           # Skill/tool-use tracking from agent transcripts
├── sessionlog/         # Sessionlog integration (agent, hooks, session store)
└── cli.ts, index.ts    # CLI entrypoint and package entrypoint
```

Tests are co-located in `__tests__/` directories alongside the modules they cover.

## Key Concepts

- **Graph store** owns edges and node references
- **Providers** own node content — OpenTasks delegates CRUD to them
- **Daemon** coordinates access via Unix socket IPC
- **Providers are federated** — each handles its own URI scheme (`native://`, `beads://`, `map://`, etc.)

## Git Sync in Daemon Lifecycle

When `sync.git.enabled: true` in `.opentasks/config.json`:

- **Startup** — installs merge driver, pulls (if `pullOnStartup`), starts auto-sync timer
- **Runtime** — auto-commits (if `autoCommit`) and auto-pushes (if `autoPush`) per `pushDebounceMs`
- **Shutdown** — final commit+push (best-effort)
- **Four IPC methods** — `sync.now` (manual full cycle), `sync.pull`, `sync.status`, `sync.reload` (hot-swap config)

## MAP Integration

MAP (Multi-Agent Protocol) support has two independent, agent-owned components — the daemon never establishes MAP connections itself, since different agents may connect to different servers/scopes:

- **MAP Provider** (`src/providers/map.ts`) — inbound: surfaces remote MAP tasks as ephemeral `map://` nodes (no local cache, direct RPC per operation; nodes stop being queryable when the connection drops). Implements `Provider` + `TaskManageable` + optional `Watchable`. Status maps MAP `completed`/`failed` ↔ OpenTasks `closed`.
- **MAP Event Bridge** (`src/providers/map-event-bridge.ts`) — outbound: emits graph changes as MAP `task.*`/`context.*` events, either agent-side (direct emit) or daemon-side (provider change handler). Skips `map`-provider changes to prevent echo loops.
- **MAP Client Factory** (`src/providers/map-client-factory.ts`) — dynamically imports `@multi-agent-protocol/sdk` (the only SDK reference in the codebase) and returns `null` on failure. The SDK is an `optionalDependency`; the package installs and runs without it — only the inbound MAP client path needs it.

## Context Files

Context nodes can reference codebase files instead of storing content inline. File-backed contexts are lightweight pointers, tracked via `node.metadata` (`context_file: true`, `context_file_path`, `context_file_type`, `context_file_commit`, `context_file_content_hash`, `context_file_synced_at`); snippets add `context_source: "snippet"`, `context_line_start`/`context_line_end`.

- **inline** (default) — content stored directly on the node.
- **file** / **snippet** — no content stored; resolved on access via `readFileFromWorktree()` or `git show <sha>:<path>` (snippet scopes to a line range).

`ContextFileManager` (`src/context-files/context-files.ts`, factory `createContextFileManager(store, repoRoot)`) provides `create`, `resolve`, `resolveAtCapturedCommit`, `checkDrift`, `sync` (re-pin to HEAD, no-op unless `force: true`), and `list`. Exposed over daemon IPC in `src/daemon/methods/context-files.ts` (`contextFiles.create/resolve/checkDrift/sync/checkDriftBatch`).

## MCP Server

Exposes the OpenTasks tool interface over Model Context Protocol (`src/mcp/server.ts`). Connects to daemon via `OpenTasksClient`.

### Scopes

- `tasks` (default) — `create_task`, `get_task`, `update_task`, `delete_task`, `list_tasks`, `list_providers`, `reconcile`, and atomic claiming: `claim_task`, `claim_next`, `release_task`, `renew_claim`
- `graph` — `link`, `query`, `context_summary`, `events_since`
- `annotate` — `annotate`
- `context` — `create_context`, `get_context`, `update_context`, `list_contexts`
- `attempts` — `record_attempt`, `list_attempts`

22 tools across 5 scopes total; `--scope all` enables everything.

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

## Build & Test

```bash
npm run build               # Clean + TypeScript compilation (also the type-check)
npm test                    # Single run (vitest)
npm run test:watch          # Watch mode
npx vitest run <path>       # Single file
npm run test:slow           # Include slow tests (RUN_SLOW_TESTS=1)
npm run test:e2e            # End-to-end (RUN_FULL_AGENT_TESTS=1)
npm run lint / lint:fix     # ESLint
npm run format              # Prettier
```

## Provider Traits

Providers can implement optional traits (in `src/providers/traits/`):

- **TaskManageable** — semantic task actions (`start`, `complete`, `block`, `reopen`, `close`), assignment, ready queries
- **Watchable** — real-time change events with configurable granularity
- **RelationshipQueryable** — edge queries from the provider's perspective
- **Reconcilable** — batch reconciliation with content hashes (optimization for remote providers)

Check with `isTaskManageable(provider)`, `isWatchable(provider)`, `isRelationshipQueryable(provider)`, `isReconcilable(provider)`.

## Provider Reconciliation

Provider-backed nodes cache data from the provider but mark it non-authoritative via `node.metadata.provider_authoritative`. Other key metadata: `provider_uri`, `provider_source`, `provider_cached_at`, `provider_content_hash`, `provider_pointer_only`. See [docs/PROVIDER-RECONCILIATION.md](./docs/PROVIDER-RECONCILIATION.md) for full design.

- **Materialization modes** (per-provider via `materializeMode`): `cached` (default — full data stored in the graph node) or `pointer` (only `provider_uri` stored; fetched on access with a session-scoped cache).
- **Reconciliation** (`providerStore.reconcileProviders()`) scans nodes with `provider_authoritative === true`, skips providers that fail `isAvailable()`, is positive-writes-only (never deletes/archives when a provider is unreachable), and reconciles edges via `rawData` extraction with zero extra provider calls. Triggered on `store.reload()` (file watcher detects `graph.jsonl` changes).
- SQLite's `nodes.metadata` is a JSON text column; `findByProviderUri()`/`findExternalNodeByUri()` scan by node type since SQLite `search` only indexes title/content.

## Common Patterns

- Providers return `ProviderNode` (normalized view) — raw data goes in `rawData`
- Errors use `ProviderError` with typed codes (`OPERATION_FAILED`, `NOT_FOUND`, etc.)
- URIs follow `scheme://workspace/id` pattern — each provider parses/builds its own
- Config uses Zod schemas with sensible defaults — partial configs are valid
