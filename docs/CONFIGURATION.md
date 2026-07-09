# Configuration

OpenTasks reads its configuration from `.opentasks/config.json` inside your
project (created by `opentasks init`). Every field is optional — a valid config
can be `{}`, and sensible defaults fill in the rest. The schema is defined and
validated with Zod in [`src/config/schema.ts`](../src/config/schema.ts).

## Precedence

Configuration is layered, lowest priority first:

```
built-in defaults  <  .opentasks/config.json  <  OPENTASKS_* environment variables
```

Environment variables always win, so you can override a committed config per-shell
or per-CI-job without editing the file. (See [`src/config/index.ts`](../src/config/index.ts).)

## Minimal example

```json
{
  "version": "1.0",
  "location": {
    "hash": "a1b2c3d4",
    "uuid": "…",
    "name": "my-project"
  }
}
```

`location` is written for you by `opentasks init`; you rarely edit it by hand.

## Full reference

Only set the keys you want to change — everything below shows the **default**.

### `storage`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `storage.jsonlPath` | string | `"graph.jsonl"` | Source-of-truth log, relative to `.opentasks/`. Git-tracked. |
| `storage.sqlitePath` | string | `"cache.db"` | Query cache, relative to `.opentasks/`. Gitignored, rebuilt on startup. |
| `storage.autoCompactRatio` | number ≥ 1 | `2.0` | Rewrite `graph.jsonl` when it grows past this ratio of live-to-total records. |

### `daemon`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `daemon.socketPath` | string | `"daemon.sock"` | Unix socket, relative to `.opentasks/`. See [socket resolution](./TROUBLESHOOTING.md#how-the-socket-is-located). |
| `daemon.autoStart` | boolean | `true` | Auto-start the daemon on the first operation that needs it. |
| `daemon.flushInterval` | number ≥ 100 | `1000` | Debounce (ms) before flushing writes to `graph.jsonl`. |

### `providers`

Each provider is enabled by default but only activates if its backend is
detected. Every provider except `map` supports `materializeMode`:
`"cached"` (default — full node data stored in the graph) or `"pointer"` (only
the `provider_uri` is stored; data is fetched on access). See
[PROVIDER-RECONCILIATION.md](./PROVIDER-RECONCILIATION.md).

**`providers.beads`**

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `true` |
| `executable` | string | `"bd"` |
| `timeout` | number ≥ 1000 | `30000` |
| `materializeMode` | `"cached"` \| `"pointer"` | `"cached"` |

**`providers.claudeTasks`**

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `true` |
| `tasksDir` | string | *(unset)* — optional filesystem dir for persistent task storage |
| `materializeMode` | `"cached"` \| `"pointer"` | `"cached"` |

**`providers.sudocode`**

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `true` |
| `executable` | string | `"sudocode"` |
| `timeout` | number ≥ 1000 | `30000` |
| `materializeMode` | `"cached"` \| `"pointer"` | `"cached"` |

**`providers.sessionlog`** (alias `providers.entire` is accepted for backwards compat)

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `true` |
| `executable` | string | *(unset)* — path to the sessionlog CLI; falls back to the built-in TS store |
| `timeout` | number ≥ 1000 | `30000` |
| `autoLink` | boolean | `true` |
| `autoLinkMinConfidence` | `"high"` \| `"medium"` \| `"low"` | `"medium"` |
| `sessionDirName` | string | `"sessionlog-sessions"` |
| `checkpointsBranch` | string | `"sessionlog/checkpoints/v1"` |
| `shadowBranchPrefix` | string | `"sessionlog/"` |

**`providers.global`** — federation with the shared `~/.opentasks` store

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `true` |
| `path` | string | `""` (empty = `~/.opentasks`) |
| `timeout` | number ≥ 1000 | `10000` |
| `cacheTTL` | number ≥ 0 | `300000` |

**`providers.map`** — Multi-Agent Protocol (disabled by default)

| Key | Type | Default |
|-----|------|---------|
| `enabled` | boolean | `false` |
| `server` | string | `""` (WebSocket URL, e.g. `ws://localhost:8080`; required when enabled) |
| `systemId` | string | `"default"` |
| `timeout` | number ≥ 1000 | `30000` |
| `agentName` | string | `"opentasks-daemon"` |
| `scope` | string | `""` (e.g. `swarm:team-name`) |
| `eventBridge` | boolean | `true` |

The MAP client SDK is an **optional dependency**; if it isn't installed the
provider degrades gracefully. See [PROVIDERS.md](./PROVIDERS.md).

### `sync.git`

Git sync for `graph.jsonl` (disabled by default). Full design in [SYNC.md](./SYNC.md).

| Key | Type | Default |
|-----|------|---------|
| `sync.git.enabled` | boolean | `false` |
| `sync.git.remote` | string | *(unset)* — e.g. `"origin"`; omit to disable push/pull |
| `sync.git.autoCommit` | boolean | `false` |
| `sync.git.autoPush` | boolean | `false` |
| `sync.git.pushDebounceMs` | number ≥ 1000 | `60000` |
| `sync.git.pullOnStartup` | boolean | `false` |

### `reconciliation`

When provider-backed nodes are re-checked against their source. See
[PROVIDER-RECONCILIATION.md](./PROVIDER-RECONCILIATION.md).

| Key | Type | Default |
|-----|------|---------|
| `reconciliation.onStartup` | `"async"` \| `"blocking"` \| `"none"` | `"async"` |
| `reconciliation.onReload` | `"async"` \| `"blocking"` \| `"none"` | `"async"` |
| `reconciliation.backgroundInterval` | number ≥ 0 | `300000` (0 disables) |
| `reconciliation.providerIntervals` | `{ [provider]: ms }` | `{}` (e.g. `{ "jira": 60000 }`) |

### `materialization`

Archiving graph history to git or a remote store. See [PERSISTENCE.md](./PERSISTENCE.md).

| Key | Type | Default |
|-----|------|---------|
| `materialization.graphId` | string | *(unset)* |
| `materialization.git.enabled` | boolean | `false` |
| `materialization.git.branch` | string | `"opentasks/archive"` |
| `materialization.git.remote` | string | *(unset)* |
| `materialization.git.repoPath` | string | *(unset)* |
| `materialization.git.pushPolicy` | `"immediate"` \| `"on-session-end"` \| `"manual"` | `"on-session-end"` |
| `materialization.remoteStores` | array | `[]` |
| `materialization.policy.archiveOnStart` | boolean | `false` |
| `materialization.policy.archiveOnCheckpoint` | boolean | `true` |
| `materialization.policy.archiveOnEnd` | boolean | `true` |
| `materialization.policy.materializeBeforeArchive` | boolean | `true` |
| `materialization.rematerializeOnStartup` | boolean | `false` |

### `logging`

| Key | Type | Default | Notes |
|-----|------|---------|-------|
| `logging.level` | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"` | |
| `logging.file` | string \| null | `null` | Relative to `.opentasks/`; `null` = no file logging. |

### `tracking`

| Key | Type | Default |
|-----|------|---------|
| `tracking.skillTracking` | boolean | `false` |
| `tracking.maxInvocationsPerSession` | number ≥ 10 | `1000` |

### Multi-location (federation)

These wire a `.opentasks/` into a federation of stores. They are normally
managed by `opentasks connect` / `opentasks worktree`, not hand-edited. See
[MULTI-LOCATION-WATCH.md](./MULTI-LOCATION-WATCH.md).

| Key | Type | Default |
|-----|------|---------|
| `defaultProvider` | string | `"native"` |
| `role` | `"manager"` \| `"worker"` \| `"standalone"` | `"standalone"` |
| `connections` | array of `{ hash, path, role, name }` | `[]` |
| `redirects` | array of redirect rules | `[]` |
| `location` | `{ hash, uuid, name }` | written by `opentasks init` |

## Environment variable overrides

A subset of keys can be overridden with `OPENTASKS_*` variables (see
[`src/config/env.ts`](../src/config/env.ts)). Booleans accept `true`/`1`;
numbers are parsed as-is; an empty string or `null` clears a nullable string.

| Variable | Config key |
|----------|-----------|
| `OPENTASKS_STORAGE_JSONL_PATH` | `storage.jsonlPath` |
| `OPENTASKS_STORAGE_SQLITE_PATH` | `storage.sqlitePath` |
| `OPENTASKS_STORAGE_AUTO_COMPACT_RATIO` | `storage.autoCompactRatio` |
| `OPENTASKS_DAEMON_SOCKET_PATH` | `daemon.socketPath` |
| `OPENTASKS_DAEMON_AUTO_START` | `daemon.autoStart` |
| `OPENTASKS_DAEMON_FLUSH_INTERVAL` | `daemon.flushInterval` |
| `OPENTASKS_PROVIDERS_BEADS_ENABLED` | `providers.beads.enabled` |
| `OPENTASKS_PROVIDERS_BEADS_EXECUTABLE` | `providers.beads.executable` |
| `OPENTASKS_PROVIDERS_BEADS_TIMEOUT` | `providers.beads.timeout` |
| `OPENTASKS_PROVIDERS_CLAUDE_TASKS_ENABLED` | `providers.claudeTasks.enabled` |
| `OPENTASKS_LOGGING_LEVEL` | `logging.level` |
| `OPENTASKS_LOGGING_FILE` | `logging.file` |
| `OPENTASKS_TRACKING_SKILL_TRACKING` | `tracking.skillTracking` |
| `OPENTASKS_TRACKING_MAX_INVOCATIONS` | `tracking.maxInvocationsPerSession` |

A few environment variables affect **discovery/routing** rather than the config
object itself:

| Variable | Effect |
|----------|--------|
| `OPENTASKS_PROJECT_DIR` | Use this exact `.opentasks` directory instead of walking up from the cwd. |
| `OPENTASKS_GLOBAL=1` | Target the shared store at `~/.opentasks` (same as `--global`). |
| `OPENTASKS_NO_AUTOSTART=1` | Never auto-start a daemon (same as `--no-autostart`). |

## Validating a config

The daemon validates config on load and refuses to start on a schema error.
To check a config programmatically:

```ts
import { validateConfig } from 'opentasks'

const result = validateConfig(JSON.parse(fileContents))
if (!result.success) {
  console.error(result.errors) // [{ path, message }, …]
}
```

If the daemon won't start after a config change, see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
