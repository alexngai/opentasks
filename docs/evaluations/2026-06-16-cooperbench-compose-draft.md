# CooperBench × OpenTasks — Compose Topology Draft (2026-06-16)

**Status:** Cross-container claim smoke **BUILT + PASSING** — see [`evals/cooperbench/`](../../evals/cooperbench/) (`./run-smoke.sh`: two agents in separate containers raced `claim_next`, 4/2 split, exactly-once, 0 double-claims). Full CooperBench *task* integration still pending its harness.
**Companion to:** [E6 CooperBench eval design](./2026-06-16-cooperbench-coordination-eval-design.md) §8 (the resolved sidecar decision).

This is the `opentasks` arm's runtime: **one daemon sidecar (sole writer) + two symmetric agent containers**, sharing one graph over a **bind-mounted Unix socket**. Single host. The `stock` arm runs CooperBench unmodified (its SQL message bus); the `notes` arm swaps the shared socket for a shared scratchpad file. Only the `opentasks` arm needs this topology.

---

## Constraints this encodes (from E6 §8)

- **Zero OpenTasks code change.** `opentasks mcp --socket <path>` is the externally-managed-daemon mode (skips auto-start, connects to the shared socket). `OPENTASKS_PROJECT_DIR` places the daemon's socket + store on the shared mount.
- **One writer.** Single daemon ⇒ the atomic claim's conditional-UPDATE serializes exactly as in the proven single-writer case. Two daemons over a shared file is the rejected alternative.
- **Same host; the socket must live on a real shared filesystem that supports Unix sockets.** Corrected empirically (2026-06-16): on **Docker Desktop (macOS) a host bind mount goes through virtiofs, which does NOT support Unix domain sockets** — so the smoke uses a **named volume** (the Linux VM's ext4) for the shared `/srv/ot`. On a **native-Linux host** either a same-host bind mount or a named volume works. (The original "bind mount, not named volume" advice was wrong for Docker Desktop.) Multi-host ⇒ needs the (unbuilt) TCP transport fallback.

---

## `docker-compose.opentasks-arm.yml` (template)

```yaml
# Adapt <agent-image> + the agent entrypoint to CooperBench's real harness.
# All three services share ONE host dir via bind mount (NOT a named volume).

x-ot-mount: &ot-mount
  type: bind
  source: ./.ot-shared          # host dir; created before `up`
  target: /srv/ot

services:
  ot-daemon:                     # the sole writer — owns graph.jsonl + SQLite + the socket
    image: opentasks:latest      # built from this repo: `npm run build` then package the CLI
    user: "1000:1000"            # MUST match the agents' uid (socket rw permission)
    environment:
      OPENTASKS_PROJECT_DIR: /srv/ot
    command: ["opentasks", "daemon", "start", "--foreground"]
    volumes:
      - <<: *ot-mount
    healthcheck:                 # ready ⇔ the socket exists
      test: ["CMD", "test", "-S", "/srv/ot/daemon.sock"]
      interval: 2s
      timeout: 2s
      retries: 30

  agent-a:
    image: <agent-image>         # CooperBench agent runtime + the opentasks CLI on PATH
    user: "1000:1000"
    depends_on:
      ot-daemon: { condition: service_healthy }   # ordering gate
    environment:
      OPENTASKS_NO_AUTOSTART: "1"  # belt-and-suspenders on top of --socket
      OT_SOCK: /srv/ot/daemon.sock
      OT_AGENT_ID: agent-a
    volumes:
      - <<: *ot-mount            # agents need only the socket (thin clients; all I/O via IPC)
    # The agent launches its OpenTasks MCP subprocess wired to the shared socket:
    #   opentasks mcp --socket "$OT_SOCK" --scope all
    # i.e. the agent's MCP config points its `opentasks` server at the shared daemon.

  agent-b:
    image: <agent-image>
    user: "1000:1000"
    depends_on:
      ot-daemon: { condition: service_healthy }
    environment:
      OPENTASKS_NO_AUTOSTART: "1"
      OT_SOCK: /srv/ot/daemon.sock
      OT_AGENT_ID: agent-b
    volumes:
      - <<: *ot-mount
```

---

## Harness wiring (the only repo change)

In [`evals/arms.ts`](../../evals/arms.ts), the `opentasks` arm's MCP launch gains an env-gated `--socket`:

```ts
// single-container runs (E2′, synthetic): OT_SOCK unset → unchanged (auto-start, local socket)
// cross-container (CooperBench): OT_SOCK=/srv/ot/daemon.sock → connect to the sidecar
mcp: {
  name: 'opentasks', command: 'opentasks',
  args: ['mcp', '--scope', 'all', ...(process.env.OT_SOCK ? ['--socket', process.env.OT_SOCK] : [])],
},
```

No other arm changes; `stock`/`notes` and the existing single-container evals are untouched.

---

## The must-pass correctness gate (run before any scaling)

The cross-container analog of synthetic cell-B/D: **two containers race `claim_next` on the same node; exactly one wins.** A standalone smoke, not the full eval:

```
1. ot-daemon up; seed one task node T.
2. agent-a and agent-b each call claim(T) "simultaneously" (tight loop / barrier).
3. ASSERT exactly one ClaimResult.success === true; the other returns existingClaim.
4. ASSERT the loser sees the winner's claim (fence token present, consistent).
```

If this passes, cross-container claiming reduces to the already-proven single-writer case and scaling is safe. If it doesn't, the bind-mount/socket plumbing is wrong (not the claim logic).

---

## Open / to verify against CooperBench's actual harness

1. **Agent image** must carry the `opentasks` CLI on PATH (it launches the MCP subprocess). Either bake it into `<agent-image>` or mount the built `dist/` + a wrapper. Confirm CooperBench lets us extend its agent image.
2. **uid alignment** — CooperBench's agent containers may run as a fixed user; match `ot-daemon`'s `user:` to it (or `chmod`/`chown` the socket on the shared mount).
3. **CooperBench's compose** likely defines its own networks/agents; this file is the *delta* to merge into theirs, not a standalone stack.
4. **`.ot-shared` lifecycle** — created empty per task/run, torn down after (each task gets a fresh graph). Wire into the run harness's per-task setup/teardown.
5. **TCP fallback** — only if same-host bind-mount proves infeasible in their CI; would need a small `createIPCServer` host:port addition (not built).
