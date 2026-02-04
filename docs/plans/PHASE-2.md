# Phase 2: Cross-Location References

> Spec ID: s-7es6 | Tags: phase-2, v2, daemon, cross-location
>
> Implements: [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md)
> Depends on: [PHASE-1.md](./PHASE-1.md)

## Scope

Add the ability to reference nodes in other OpenTasks locations, enabling multi-repo and multi-worktree scenarios.

## Prerequisites

- Phase 1 complete (single-location + provider URIs)

## What's Included

### opentasks:// URI Resolution
```
opentasks://./i-x7k9                         # Current location
opentasks://~/.opentasks/s-a2b3              # User-level location
opentasks://../.opentasks/i-e6f7             # Parent directory
opentasks://../other-repo/.opentasks/s-g8h9  # Sibling directory
opentasks:///abs/path/.opentasks/i-j0k1      # Absolute path
```

### Daemon Architecture

One daemon per `.opentasks/` location:
- Auto-starts on first operation (configurable)
- Unix socket for IPC (`.opentasks/daemon.sock`)
- JSON-RPC protocol
- Graceful shutdown with final flush

**Lifecycle**:
```
START → acquire lock → init persistence → start socket → register in global registry
RUNNING → handle IPC requests → watch files → flush changes
STOP → flush → unregister → cleanup socket/lock
```

### Global Registry

Central tracking of all running daemons (`~/.opentasks/registry.json`):
```json
{
  "daemons": [
    {
      "workspacePath": "/Users/alex/projects/myapp/.opentasks",
      "socketPath": "/Users/alex/projects/myapp/.opentasks/daemon.sock",
      "pid": 12345,
      "version": "1.0.0",
      "startedAt": "2025-01-27T10:00:00Z"
    }
  ]
}
```

### Redirect Rules

Configuration for routing operations to another location:
```json
{
  "redirects": [
    {
      "operations": ["read", "write"],
      "pattern": "*",
      "target": "opentasks://../main-worktree/.opentasks/"
    }
  ]
}
```

**Use case**: Manager agent spawns worker in worktree, configures worker's `.opentasks/` to redirect to manager's location.

**Chained redirects**: Worker → Manager → Orchestrator (each hop resolves)

## What's NOT Included (Phase 3)

- Location discovery (find .opentasks/ in ancestors/descendants)
- Query expansion modes (follow-refs, ancestors, descendants)
- Conditional redirect rules
- Cross-location aggregated queries

## Deliverables

### Daemon Package (`@opentasks/daemon`)
- [ ] Daemon process with socket server
- [ ] Lock file management
- [ ] IPC protocol (JSON-RPC over Unix socket)
- [ ] Auto-start behavior
- [ ] Graceful shutdown
- [ ] Health monitoring

### Registry Package (`@opentasks/registry`)
- [ ] Global registry read/write
- [ ] Daemon registration/unregistration
- [ ] Stale entry cleanup (dead PIDs)
- [ ] Find daemon for path

### URI Resolution (`@opentasks/uri`)
- [ ] opentasks:// URI parser
- [ ] Relative path resolution
- [ ] Tilde (~) expansion
- [ ] Cross-location node fetching (via daemon IPC)

### Redirect System
- [ ] Redirect rule configuration
- [ ] Redirect resolution logic
- [ ] Chained redirect support

## Technical Design

### Daemon IPC Protocol
```typescript
// Request
{ "id": "uuid", "method": "graph.query", "params": { "find": "ready" } }

// Response
{ "id": "uuid", "result": { "nodes": [...] } }
// or
{ "id": "uuid", "error": { "code": -32000, "message": "..." } }
```

**Methods**:
- Lifecycle: `ping`, `health`, `status`, `shutdown`
- Graph: `query`, `get`, `create`, `update`, `delete`
- Sync: `flush`, `import`, `export`
- Discovery: `resolve-uri`

### Cross-Location Resolution Flow
```
1. Parse URI: opentasks://../other/.opentasks/i-x7k9
2. Resolve path: /Users/alex/projects/other/.opentasks/
3. Find daemon in registry (or start if auto-start enabled)
4. Send IPC request to that daemon
5. Return resolved node
```

### Redirect Resolution Flow
```
1. Operation requested on local location
2. Check config.json for matching redirect rule
3. If redirect found, resolve target location
4. Forward operation to target location
5. Handle chained redirects (max depth)
```

## Success Criteria

Phase 2 is complete when:
1. Can create edges referencing `opentasks://` URIs in other locations
2. Daemon starts automatically and handles IPC requests
3. Global registry tracks all running daemons
4. Can query a node in another location via URI
5. Redirect rules route operations to configured target
6. Chained redirects work (worker → manager → orchestrator)
