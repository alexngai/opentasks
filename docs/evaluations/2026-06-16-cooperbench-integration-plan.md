# CooperBench × OpenTasks — Integration Plan (2026-06-16)

**Status:** Architecture mapped. Backend (`ot_client.py` + the OpenTasks-backed `coop-task-*` CLI) **built + tested** against a live daemon (atomic claim + attempts). **No-fork injection module built** (`opentasks_cooperbench.py`) — loaded via CooperBench's `COOPERBENCH_EXTERNAL_AGENTS` hook, monkeypatches two seams, gated by `CB_OPENTASKS=1`; **CooperBench is NOT modified.** **VERIFIED end-to-end on AWS Bedrock (2026-06-17):** `--setting team`, 2 agents (haiku), the injection provisioned the daemon sidecar + the agents coordinated through OpenTasks (task `t-1idd` created by lead → atomically claimed by member → closed); eval ran (0% pass — haiku is weak, as expected; scoring is intact). Runner: `evals/cooperbench/integration/run-bedrock.sh`.
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

## No-fork injection (built) — `opentasks_cooperbench.py`

CooperBench exposes an external-agent hook (`agents/registry.py:93`: `COOPERBENCH_EXTERNAL_AGENTS=<module>` is `__import__`ed at startup). We ship a module from the OpenTasks side that, on import (gated by our own `CB_OPENTASKS=1`), **monkeypatches two seams** so `team` mode coordinates through OpenTasks — **nothing under `references/cooperbench` is modified** (verified: all three targets exist where expected):

1. `TeamSession.scratchpad_mount_args` (`team_harness/__init__.py:231`) → also mount a per-run named volume `cb-ot-<run_id>:/srv/ot` (the daemon socket) into each agent container.
2. `mini_swe_agent_v2.adapter._install_team_cli_in_container` (`adapter.py:30`) → idempotently provision a per-run daemon sidecar (`ensure_opentasks_daemon`, mirrors `infra/redis.py`), `write_file_in_container` (`_coop/runtime.py:135`) the `ot_client.py` + OpenTasks-backed CLI, create the `coop-task-*` / `coop-attempt-*` wrappers pointing at `/srv/ot/daemon.sock`, and set `CB_OPENTASKS_SOCKET` on the container env.

Files (all in `evals/cooperbench/integration/`):
- `ot_client.py` — stdlib Python JSON-RPC client (**tested**).
- `coop_task_opentasks.py` — the `coop-task-*` CLI backed by OpenTasks, same verbs/JSON/exit-codes as `coop_task.py`, **+** `attempt-record` / `attempt-list` (**tested** via `run-coop-task-cli-test.sh`: atomic-claim rejection rc=2, done↔closed mapping, attempts).
- `opentasks_cooperbench.py` — the injection glue (the two monkeypatches + `ensure_opentasks_daemon`). Imports cleanly; targets verified present. *Needs a full `cooperbench run` to verify end-to-end.*

Invocation (no fork):
```bash
PYTHONPATH=evals/cooperbench/integration CB_OPENTASKS=1 \
  OPENTASKS_DAEMON_IMAGE=opentasks-daemon:smoke \
  COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench \
  cooperbench run --backend docker --setting team -a mini_swe_agent_v2 ...
```

*Do NOT touch:* `eval/` — scoring is backend-agnostic (§7), so this stays a clean Redis-vs-OpenTasks A/B.

## Next (verify the injection end-to-end)

1. `pip install -e references/cooperbench` (+ its mini-swe deps) and `cooperbench prepare` a tiny subset (one repo, one task).
2. Run one task pair with the no-fork invocation above (needs Docker + an LLM key). Confirm: the daemon sidecar comes up, the `coop-task-*` wrappers resolve to OpenTasks, agents coordinate, and `cooperbench eval` scores the merged patches.
3. Fix whatever the real run surfaces (the way the daemon e2e + the smoke each caught real bugs) — likely candidates: container can't reach the named-volume socket, `write_file_in_container` quirks, wrapper PATH.
4. Then the headline A/B: solo vs coop, Redis-backend vs OpenTasks-backend, on the mid-difficulty band — same tasks, same scoring, only the coordination substrate differs.

*(Optional later: Option B — register the OpenTasks MCP for the CLI agents (claude_code/codex) so `record_attempt`/`list_attempts` surface as MCP tools, via the same monkeypatch approach on `TeamSession.mcp_config`.)*
