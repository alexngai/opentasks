# Troubleshooting

Most OpenTasks issues are daemon-related: the CLI, the MCP server, and the client
all talk to a background daemon over a Unix socket, and problems show up as
"can't find the daemon" or "commands hang." This guide covers the daemon; for
config keys see [CONFIGURATION.md](./CONFIGURATION.md).

## The daemon model in one paragraph

There is **one daemon per location**. You don't start it manually — the first
command that needs it auto-starts a detached process (unless `autoStart` is off).
It writes three runtime files into the location directory: `daemon.sock` (the IPC
socket), `daemon.lock` (an exclusive lock so only one daemon runs per location),
and `cache.db` (the SQLite query cache, rebuilt from `graph.jsonl` on startup).
`daemon.sock`, `daemon.lock`, and `cache.db` are gitignored.

## First step: check status

```bash
opentasks daemon status
```

- `{"status":"not_running", ...}` — no daemon; the next real command will
  auto-start one (or run `opentasks daemon start`).
- `{"status":"unreachable", "pid":…, "socketPath":…}` — a socket exists but the
  daemon isn't answering (likely stale or wedged — see below).
- A full JSON status object — the daemon is healthy.

To see startup errors directly, run it in the foreground:

```bash
opentasks daemon start --foreground
```

This prints logs to your terminal instead of detaching, which is the fastest way
to see why a daemon is failing to come up (config errors, port/socket problems,
native-module errors).

## How the socket is located

When a client needs the daemon it resolves the socket in this order
(see [`src/client/client.ts`](../src/client/client.ts)):

1. **`.git/opentasks/daemon.sock`** — the multi-location / worktree daemon
   (shared across all worktrees of a git repo).
2. **`.opentasks/daemon.sock`** — walking up from the current directory
   (single-location layout; `.openswarm/opentasks` and legacy `.swarm/opentasks`
   are checked first if present).
3. **`~/.opentasks/daemon.sock`** — the global store (auto-initialized).

Overrides:

- `OPENTASKS_PROJECT_DIR=/path/to/.opentasks` forces an exact location.
- `--global` / `OPENTASKS_GLOBAL=1` targets `~/.opentasks`.
- `daemon.socketPath` / `OPENTASKS_DAEMON_SOCKET_PATH` changes the socket filename.

If a command is operating on the "wrong" tasks, you're almost certainly hitting a
different location than you expect — run `opentasks daemon status` and check the
`locationPath`, or set `OPENTASKS_PROJECT_DIR` explicitly.

## Common problems

### "Could not find daemon socket. Is the daemon running?" (`SOCKET_NOT_FOUND`)

The client couldn't resolve a socket via the order above. Usually one of:

- You're not inside a directory with a `.opentasks/` and haven't run
  `opentasks init`. Fix: `opentasks init`, or pass `OPENTASKS_PROJECT_DIR`.
- Auto-start is disabled (`--no-autostart`, `OPENTASKS_NO_AUTOSTART=1`, or
  `daemon.autoStart: false`). Fix: `opentasks daemon start`, or re-enable
  auto-start.
- You expected the global store. Fix: add `--global`.

### Commands hang or time out

The daemon is up but not responding, or auto-start silently failed.

1. `opentasks daemon status` — if `unreachable`, the socket is stale.
2. `opentasks daemon stop` to clear it, then retry (the next command re-starts a
   fresh daemon).
3. If it still hangs, start in the foreground to see the error:
   `opentasks daemon start --foreground`.

### Stale socket or lock after a crash

If the daemon process died without cleaning up, a stale `daemon.sock` and/or
`daemon.lock` can remain. Symptoms: `status` says `unreachable`, or startup
complains the lock is held.

```bash
opentasks daemon stop          # graceful attempt first
# if that doesn't help, from the location dir (.opentasks/ or .git/opentasks/):
rm -f daemon.sock daemon.lock  # only when you're sure no daemon is running
```

The lock is validated against a live PID, so a lock left by a dead process is
treated as stale on the next start — you usually don't need to delete it by hand.
`graph.jsonl` is never touched by this; your data is safe.

### Daemon won't start after editing `config.json`

The daemon validates config on load and refuses to start on a schema error.
Run `opentasks daemon start --foreground` to see the validation message, or
validate programmatically:

```ts
import { validateConfig } from 'opentasks'
const r = validateConfig(JSON.parse(require('fs').readFileSync('.opentasks/config.json','utf8')))
console.log(r.success ? 'ok' : r.errors)
```

Common mistakes: a number below its minimum (e.g. `daemon.flushInterval` < 100,
any `timeout` < 1000), or an invalid enum (`logging.level`, `materializeMode`).
See [CONFIGURATION.md](./CONFIGURATION.md) for valid ranges.

### `NODE_MODULE_VERSION` / `better-sqlite3` errors

```
Error: The module '…/better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION …
```

The native SQLite addon was built for a different Node version (common after
switching Node with nvm). Fix:

```bash
npm rebuild better-sqlite3
```

If the cache itself is corrupted, it's safe to delete — it rebuilds from
`graph.jsonl` on next startup:

```bash
rm -f .opentasks/cache.db   # (or .git/opentasks/cache.db)
```

### "Socket path too long" (macOS/Linux)

Unix domain socket paths are capped (~104 chars on macOS, ~108 on Linux). A very
deep project path can exceed this. Fix by shortening the socket path via
`OPENTASKS_DAEMON_SOCKET_PATH`, or use the global store (`--global`).

### Multiple daemons / worktrees

In a git repo, all worktrees share **one** daemon at `.git/opentasks/daemon.sock`
(workers redirect reads/writes to the manager). If you see multiple daemons or
inconsistent state across worktrees, confirm they resolve to the same
`.git/opentasks/` common dir (`git rev-parse --git-common-dir`) and stop stray
daemons with `opentasks daemon stop` from each location.

## Turning on debug logging

Set the level to `debug` and send logs to a file for a session:

```bash
OPENTASKS_LOGGING_LEVEL=debug OPENTASKS_LOGGING_FILE=daemon.log \
  opentasks daemon start --foreground
```

Or persist it in `.opentasks/config.json`:

```json
{ "logging": { "level": "debug", "file": "daemon.log" } }
```

The file path is relative to the location directory.

## Still stuck?

Open an issue with the output of `opentasks daemon status`, the foreground
startup logs, your Node version (`node --version`), and a redacted
`.opentasks/config.json`. See [SECURITY.md](../SECURITY.md) for reporting
anything sensitive privately.
