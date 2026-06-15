# OpenTasks Daemon Wire Protocol

The OpenTasks daemon speaks **JSON-RPC 2.0 over a Unix domain socket**, framed as
newline-delimited JSON (NDJSON). This document freezes that protocol so embedders
can talk to the daemon directly without depending on the full package.

> Most consumers should use the thin client instead of speaking the wire protocol
> by hand: `import { createClient, getDefaultSocketPath } from 'opentasks/client'`
> (typed IPC client + socket discovery; no SQLite/providers/MAP SDK). This
> document is for non-JS embedders and for understanding what the client does.

## Stability

The protocol is **frozen and additive-only**: new methods and new optional
fields may be added; existing method names, request/response shapes, and field
meanings will not change incompatibly. There is no version handshake — call
`ping` to confirm liveness.

## Transport & framing

- **Socket**: a Unix domain socket (see *Socket discovery*).
- **Framing**: each message is a single JSON object followed by `\n`. Read until
  a newline, parse the line as JSON. Multiple messages may arrive in one TCP read;
  split on `\n`. A partial line means "wait for more data."
- **Encoding**: UTF-8.
- **Connections**: a connection may carry many requests and receives server-push
  notifications interleaved with responses. One-shot connections (connect → one
  request → read response → close) are also fine.

## Socket discovery

Resolve the socket path in this order (the client's `getDefaultSocketPath()`):

1. **Multi-location**: `<git-common-dir>/opentasks/daemon.sock` — i.e.
   `.git/opentasks/daemon.sock` (worktree-aware), if inside a git repo.
2. **Single-location**: walk up from the cwd for a `.opentasks/` directory →
   `<...>/.opentasks/daemon.sock`.
3. **Global**: `~/.opentasks/daemon.sock` (auto-initialized if absent).

The configured socket filename defaults to `daemon.sock` (override via
`daemon.socketPath` in `.opentasks/config.json`).

## Messages

### Request (client → daemon)

```json
{ "jsonrpc": "2.0", "id": 1, "method": "graph.create", "params": { "type": "task", "title": "x", "status": "open" } }
```

- `id`: number or string, unique per connection. Use `null` for a notification
  the daemon should not respond to.
- `params`: method-specific object (may be omitted).

### Response (daemon → client) — success

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "id": "t-ab12", "type": "task", "status": "open" } }
```

### Response (daemon → client) — error

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found", "data": "..." } }
```

Error codes are standard JSON-RPC:

| Code | Meaning |
|------|---------|
| -32700 | Parse error (malformed JSON) |
| -32600 | Invalid request (missing/!"2.0" jsonrpc) |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error (handler threw; `data` carries the message) |

### Notification (daemon → client, server-push)

Server-push messages have `id: null` and a `method`. The main one is the watch
stream (after `watch.subscribe`):

```json
{ "jsonrpc": "2.0", "id": null, "method": "watch.event",
  "params": { "type": "created", "nodeId": "t-ab12", "uri": "global://t-ab12",
              "location": "primary", "seq": 42, "epoch": "…", "node": { … }, "timestamp": "…" } }
```

`seq` + `epoch` form a resume cursor: persist the last one and call
`events.since({ epoch, seq })` after reconnecting to backfill missed events (or
get `{ resync: true }` if the cursor is too old / the daemon restarted).

## Methods

Grouped by namespace. The thin client wraps each as a typed method; the bare
names are what goes on the wire.

- **Lifecycle**: `ping`, `health`, `status`, `shutdown`, `flush`.
- **Graph**: `graph.create` (accepts optional `idempotency_key`), `graph.get`,
  `graph.update`, `graph.delete`, `graph.query`, `graph.createEdge`,
  `graph.deleteEdge`.
- **Tools**: `tools.link`, `tools.query`, `tools.annotate`, `tools.task`
  (claim/release/renew/transition + CRUD), `tools.contextSummary`.
- **Events / watch**: `watch.subscribe` (`{ filter?: { types?, statuses?, locations? } }`),
  `watch.unsubscribe`, `events.since` (`{ cursor: { epoch, seq } }`), `events.current`.
- **Sync**: `sync.now`, `sync.pull`, `sync.status`, `sync.reload`.
- **Context files**: `contextFiles.create`, `contextFiles.resolve`,
  `contextFiles.checkDrift`, `contextFiles.sync`, `contextFiles.checkDriftBatch`.
- **Providers / locations / archive**: `provider.list`, `provider.reconcile`,
  `location.register`, `location.unregister`, `archive.list`, `archive.node`.

For exact params/results, see the typed client (`src/client/client.ts`) and the
method handlers under `src/daemon/methods/`.

## Minimal one-shot client (illustrative)

```js
import net from 'node:net';
import { getDefaultSocketPath } from 'opentasks/client';

function rpc(method, params = {}, socketPath = getDefaultSocketPath()) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath, () => {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const msg = JSON.parse(buf.slice(0, nl));
      sock.end();
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    });
    sock.on('error', reject);
  });
}

await rpc('ping'); // { pong: true }
```

Prefer `createClient()` for anything beyond a one-off — it manages the persistent
connection, server-push notifications, and the `subscribe`/`events.since` replay
cursor.
