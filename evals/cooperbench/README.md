# CooperBench × OpenTasks harness

The `opentasks` arm of the E6 CooperBench coordination eval:
two agents in **separate containers** coordinate through **one shared OpenTasks
daemon** (the sidecar topology), instead of CooperBench's stock chat-only message bus.

## Status

- **Cross-container claim smoke — built & runnable here.** Proves the topology
  premise (one daemon, shared socket, atomic claim holds across the container
  boundary) before wiring in CooperBench's task suite. This is the design's
  *must-pass gate*.
- **Full CooperBench task integration — not yet.** CooperBench isn't vendored
  in this repo; the next step is to clone it and merge the daemon sidecar +
  `opentasks mcp --socket` into its agent compose as a delta. See "Next".

## The smoke

```
ot-daemon (sole writer) ──shared named volume /srv/ot── agent-a │ agent-b
```

```bash
./run-smoke.sh            # 6 tasks (default)
OT_TASKS=12 ./run-smoke.sh
```

What it does: builds the daemon image from local source (so it has the
attempt/verify feature), starts the sidecar daemon, seeds N ready tasks, then
**races two agents in separate containers** to drain the queue via atomic
`claim_next`, and verifies **exactly-once** — no task claimed by both, every
task claimed by one. A clean run proves the claim serializes across the
container boundary through the single shared daemon (the cross-container analog
of the in-process synthetic cell-B/D result).

Files:
- `Dockerfile` — the OpenTasks daemon image (local source → `dist/`).
- `docker-compose.smoke.yml` — sidecar daemon + one-shot thin clients.
- `smoke/{seed,drain,check}.cjs` — seed tasks / drain via claim_next / verify.
- `run-smoke.sh` — orchestrates build → daemon → seed → race → check → teardown.

### Why a named volume (not a bind mount)

The daemon's IPC is a Unix domain socket; it must live on a filesystem that
both containers share **and** that supports sockets. On Docker Desktop (macOS)
a host bind mount goes through virtiofs, which does **not** support Unix
sockets — so the socket must sit on a **named volume** (the VM's ext4). On a
native-Linux host either a named volume or a same-host bind mount works. (This
refines the compose-draft doc's "bind mount, not named volume" note, which holds
only for native Linux.)

### Zero OpenTasks code change

The agents reach the shared daemon via `--socket` / an explicit `socketPath`,
which is the externally-managed-daemon mode (skips auto-start). The daemon binds
its socket via `OPENTASKS_PROJECT_DIR`. One daemon = one writer, so the atomic
claim's conditional-UPDATE is the same single-writer path proven in the unit
suite — no daemon code changes for the cross-container case.

## Next (full integration)

1. Vendor CooperBench (clone; it isn't in `references/` yet).
2. Add the `ot-daemon` sidecar service to CooperBench's agent compose; point
   each agent's OpenTasks MCP at the shared socket
   (`opentasks mcp --socket /srv/ot/daemon.sock --scope all`).
3. Map a CooperBench task → an OpenTasks task/spec node; let the two agents
   coordinate through `record_attempt` / `list_attempts` + claims.
4. Score on CooperBench's own merged-test ground truth; report solo-vs-coop
   retention (the headline metric).
