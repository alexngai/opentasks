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
├── daemon/             # Unix socket daemon, IPC, lifecycle
├── client/             # Client library (connects to daemon)
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
