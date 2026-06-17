# CooperBench × OpenTasks — Integration Plan (2026-06-16)

**Status:** Architecture mapped; the integration *crux* (Python OpenTasks client over the wire) is **built + proven**. CooperBench-side wiring (the `coop_task.py` backend swap + adapter mounts + MCP registration) is specced below, not yet applied.
**Companion to:** [E6 eval design](./2026-06-16-cooperbench-coordination-eval-design.md) · [compose draft](./2026-06-16-cooperbench-compose-draft.md). CooperBench vendored at `references/cooperbench`.

---

## What CooperBench gives us (the map)

CooperBench (`references/cooperbench`, Python, MIT) already has a **`team`** setting that is a Redis-backed "OpenTasks-lite":

- **Coordination backend = one shared host Redis** (`infra/redis.py`: `docker run -d --name cooperbench-redis -p 6379:6379`), reached from inside each agent container via `--add-host=host.docker.internal:host-gateway` (`mini_swe_agent_v2/adapter.py:173`). *Not* a per-run sidecar; namespaced per run via a `#run:<id>` URL fragment.
- **`coop-task-*` commands** are PATH shell wrappers (`/usr/local/bin/`, installed by `team_harness/install_snippet.sh`) that run **inside the agent's task-repo container** and call `team_harness/coop_task.py`, which talks to Redis directly. Verbs: `create` / `list` / `claim` / `update`.
- **Their atomic claim is a non-atomic read-then-write** (`team_harness/task_list.py:153-168`, self-admitted) — *exactly* the weakness OpenTasks's real atomic claim replaces.
- **MCP** (`team_harness/mcp_server.py`) is minimal: one tool, `wait_for_message` (Redis `BLPOP`). The CLI adapters (claude_code, codex) already know how to install + register a stdio MCP server (`~/.claude.json` / `~/.codex/config.toml`); the default `mini_swe_agent_v2` (Python-loop) registers **no MCP**.
- **Scoring is backend-agnostic** — `eval/` only reads each agent's patch + runs the per-feature ground-truth tests (`eval/sandbox.py:test_merged`). Zero coupling to Redis / the task list. **Swapping Redis→OpenTasks cannot affect the success metric.** (Verified: grep of `eval/` for `redis|task_list|CB_TEAM` is empty.)

Run path is local-Docker-capable: `cooperbench run --backend docker --setting team -a mini_swe_agent` uses `mini_swe_agent_v2/environments/docker.py` (raw `docker` CLI). `openhands_sdk` is Modal-only — avoid it.

## Chosen approach

**Option A (backend swap) + Option B (MCP for attempt/verify):**

- **A — swap the `coop-task-*` backend Redis→OpenTasks**, keeping the same verbs/JSON shape, gated by a new `--task-backend opentasks` flag. The agents see an identical interface; only the substrate changes — so the prompt, metrics harvest, and fs-mirror are untouched. This buys the **atomic claim** drop-in.
- **B — register OpenTasks's tools** (incl. `record_attempt` / `list_attempts`) for the agents, since there's no `coop-task-*` verb for attempt/verify. The differentiator Redis can't express.

**Reachability decision — shared named-volume socket (not TCP, not host-gateway).** CooperBench reaches Redis over TCP via host-gateway, but OpenTasks's IPC is a Unix socket. Rather than build a TCP transport, mount a **shared named volume** holding the daemon socket into the daemon sidecar *and* each agent container (the proven [smoke topology](../../evals/cooperbench/README.md); named volume = the VM's ext4, which supports sockets). The agent-container mount points are known: alongside `team_session.scratchpad_mount_args()` in `mini_swe_agent_v2/adapter.py:175`, `claude_code/adapter.py:428`, `codex/adapter.py:328`. *(TCP transport stays the documented fallback for multi-host.)*

**Per-run isolation.** Each run gets its own daemon (its own graph) — a per-run sidecar like CooperBench's git-server (`team.py:164-182`), not a single shared daemon. Start with `--concurrency 1` (one daemon per run) and generalize later.

## The crux — BUILT + PROVEN

The agents' task-repo containers are python/go/rust images, **not** node — they can't run the node `opentasks` CLI. So coordination is a **Python client speaking the daemon's JSON-RPC directly** over the mounted socket. Built and tested against a live daemon:

- `evals/cooperbench/integration/ot_client.py` — ~140-line stdlib-only client (Unix socket or `tcp://`); methods: `create_task`, `claim_next`, `claim`, `update`, `list_tasks`, `record_attempt`, `list_attempts`, `verify`, `verifies_edges`.
- `evals/cooperbench/integration/test_ot_client.py` + `run-ot-client-test.sh` — **all checks pass**: create → drain via `claim_next` (distinct, then empty) → **atomic claim on a contended task (one winner)** → attempt lifecycle (pending=in_progress, terminal=closed) → `verifies` edge.

This de-risks the whole integration: the protocol, the atomic claim, and the attempt/verify layer all work from a non-node process over the wire.

## Remaining CooperBench-side wiring (specced, not applied)

*New files:*
- `src/cooperbench/infra/opentasks.py` — `ensure_opentasks_daemon(run_id)`: a per-run daemon sidecar container + a `cb-ot-<run_id>` named volume for its socket (mirrors `infra/redis.py` + the git-server sidecar).
- `src/cooperbench/team_harness/opentasks_task.py` — the `coop-task-*` verbs backed by `ot_client.py` (drop-in for `coop_task.py`; same JSON output), **+** `coop-attempt-record` / `coop-attempt-list`.

*Modify:*
- `cli.py:196` — add `--task-backend {redis,opentasks}`; thread through `run()`.
- `runner/core.py:109,143` — call `ensure_opentasks_daemon` when selected (next to `ensure_redis`); forward the flag.
- `runner/team.py:121-162,286-297` — provision the daemon sidecar + shared-socket volume; pre-seed + harvest via OpenTasks.
- adapters (`mini_swe_agent_v2`, `claude_code`, `codex`) — mount the shared socket volume into agent containers; install the OpenTasks-backed `coop-task-*` wrappers; (CLI agents) point MCP registration at the OpenTasks MCP for attempt/verify.
- `team_harness/runtime.py:build_team_env` — inject `CB_OPENTASKS_SOCKET=/srv/ot/daemon.sock`.

*Do NOT touch:* `eval/` — scoring is backend-agnostic.

## Next

1. Bring up the daemon sidecar via the agent task-repo image (the `coop-task-*` wrappers need python3 + `ot_client.py` in-container — both already present in repo images; mount `ot_client.py` + the socket).
2. Wire `opentasks_task.py` behind the `coop-task-*` wrappers + the `--task-backend opentasks` flag.
3. `cooperbench prepare` a tiny subset → run one task pair under `--backend docker --setting team --task-backend opentasks -a mini_swe_agent` → confirm agents coordinate via OpenTasks and `cooperbench eval` scores it.
4. Then the headline: solo-vs-coop retention, Redis vs OpenTasks backend, on the mid-difficulty band.
