"""Inject OpenTasks into CooperBench's `team` mode WITHOUT forking it.

Load via CooperBench's external-agent hook (it just `__import__`s the module):

    PYTHONPATH=evals/cooperbench/integration \
    CB_OPENTASKS=1 \
    OPENTASKS_DAEMON_IMAGE=opentasks-daemon:smoke \
    COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench \
    cooperbench run --backend docker --setting team -a mini_swe_agent_v2 ...

Importing this module ALWAYS applies seam 5 (provider/budget hardening — a
backend-agnostic Bedrock/litellm + step-cap correctness fix, so the redis baseline
gets the same treatment and the A/B stays fair). When `CB_OPENTASKS=1` it
ADDITIONALLY monkeypatches seams 1-4 so the `team` setting coordinates through an
OpenTasks daemon (a REAL atomic claim + the attempt/verify layer) instead of Redis.
Nothing under `references/cooperbench` is modified:

  1. ``TeamSession.scratchpad_mount_args`` — also mount a per-run named volume
     holding the daemon's Unix socket into each agent container.
  2. ``mini_swe_agent_v2.adapter._install_team_cli_in_container`` — provision a
     per-run daemon sidecar, ship ``ot_client.py`` + the OpenTasks-backed
     ``coop-task`` CLI into the container, create the ``coop-task-*`` /
     ``coop-attempt-*`` wrappers, and point them at the shared socket.
  3. ``team_harness.{build_team_instruction,team_task_section}`` — append a short
     block teaching agents to record *evidenced* attempts and verify a partner's
     work before relying on it (exercises the attempt/verify layer Redis can't
     express). The block is appended only for real (>=2-agent) teams.
  4. ``runner.team._redis_client`` + ``loop_refresh.TeamPoller._ensure_client`` —
     redirect the HOST-side task paths (the bench's task pre-seed and the
     auto-refresh poller) to the SAME OpenTasks store via an ``OpenTasksRedisShim``
     (``ot_redis_shim.py``). Without this only the agents' CLI was swapped, so the
     pre-seeded tasks + auto-refresh stayed in Redis while ``coop-task-list`` read
     an empty OpenTasks store — a split-brain that confused agents. The host
     reaches the (container) daemon socket through a per-run ``socat`` TCP bridge
     (Docker Desktop can't carry a Unix socket over a host bind mount). Daemon +
     bridge are provisioned at ``TeamSession.__init__`` so they're up before the
     pre-seed runs.
  5. provider + budget hardening (``_harden_runtime``): a per-call timeout +
     retries on ``litellm.completion`` (a Bedrock call once stalled a run ~1h),
     ``litellm.modify_params=True`` (the auto-refresh poller injects a user msg
     after each tool result -> consecutive user blocks Bedrock rejects; this
     inserts a dummy assistant turn instead of lossy merging), and raised agent
     cost/step caps (the default $3 cost_limit fits a solo agent but cut the team
     LEAD off mid-integration). Tunable via CB_LLM_TIMEOUT / CB_COST_LIMIT / etc.

The per-run daemon sidecar, socat bridge, and named volume are torn down at
process exit (``atexit``) and on SIGTERM/SIGINT so a battery doesn't leak them.

The agents keep the identical ``coop-task-*`` shell interface; only the
substrate changes. Scoring is untouched (CooperBench scores patches against
ground-truth tests, independent of the coordination backend — verified in the
integration plan, §7).

STATUS: the OpenTasks backend (``ot_client.py`` + ``coop_task_opentasks.py``) and
the host-side shim (``ot_redis_shim.py``) are unit-tested against a live daemon
(``run-shim-test.sh``). This injection glue needs a full ``cooperbench run`` to
verify end-to-end; the monkeypatch targets are pinned to the vendored CooperBench.
"""

from __future__ import annotations

import atexit
import logging
import os
import signal
import subprocess
import time

_log = logging.getLogger("opentasks_cooperbench")
_HERE = os.path.dirname(os.path.abspath(__file__))

DAEMON_IMAGE = os.environ.get("OPENTASKS_DAEMON_IMAGE", "opentasks-daemon:smoke")
MOUNT_DIR = "/srv/ot"
SOCKET_PATH = f"{MOUNT_DIR}/daemon.sock"
# Host<->daemon TCP bridge (socat): the host pre-seed + poller can't reach a Unix
# socket inside a Docker named volume, so a socat sidecar exposes it on localhost.
BRIDGE_PORT = int(os.environ.get("CB_OT_BRIDGE_PORT", "47600"))
BRIDGE_IMAGE = os.environ.get("CB_OT_BRIDGE_IMAGE", "alpine/socat")

# Provider + budget hardening (seam 5). Bedrock-via-litellm team runs hung (no
# timeout) and the default $3 cost cap cut the team lead off mid-integration.
LLM_TIMEOUT = float(os.environ.get("CB_LLM_TIMEOUT", "300"))  # per-call Bedrock timeout (s)
LLM_RETRIES = int(os.environ.get("CB_LLM_RETRIES", "2"))
COST_LIMIT = float(os.environ.get("CB_COST_LIMIT", "8.0"))  # raise the $3 cap so the lead can finish
STEP_LIMIT = int(os.environ.get("CB_STEP_LIMIT", "150"))


def _enabled() -> bool:
    return os.environ.get("CB_OPENTASKS", "").lower() in ("1", "true", "yes")


def _read(name: str) -> str:
    with open(os.path.join(_HERE, name), encoding="utf-8") as f:
        return f.read()


def _vol(run_id: str) -> str:
    return f"cb-ot-{run_id or 'default'}"


# --- teardown: the per-run daemon sidecar + its named volume leak otherwise ---
_CREATED_RUNS: set[str] = set()
_PREV_SIGNAL: dict[int, object] = {}
_CURRENT_RUN_ID: str = ""


def _host_endpoint() -> str:
    """ot_client endpoint the HOST (pre-seed + poller) uses to reach the daemon."""
    return f"tcp://127.0.0.1:{BRIDGE_PORT}"


_SEAM4_INSTALLED = False


def _install_storage_redirect() -> None:
    """Point the host task paths (pre-seed + poller) at the OpenTasks shim. Idempotent.

    DEFERRED to run time (called from the TeamSession.__init__ wrapper) on purpose:
    at module-load time this module is imported *during* ``cooperbench.agents`` init
    (the external-agent hook), so ``import cooperbench.runner.team`` — which does
    ``from cooperbench.agents import get_runner`` — hits a circular import. By the
    time a TeamSession is constructed, cooperbench is fully loaded; and that still
    happens BEFORE the bench pre-seeds the task list (runner/team.py).
    """
    global _SEAM4_INSTALLED
    if _SEAM4_INSTALLED:
        return
    from ot_redis_shim import OpenTasksRedisShim
    import cooperbench.runner.team as team_mod
    import cooperbench.team_harness.loop_refresh as loop_refresh

    team_mod._redis_client = lambda *_a, **_k: OpenTasksRedisShim(_host_endpoint())
    loop_refresh.TeamPoller._ensure_client = lambda self: OpenTasksRedisShim(_host_endpoint())
    _SEAM4_INSTALLED = True


def _harden_runtime() -> None:
    """Seam 5 — provider + budget hardening for Bedrock-via-litellm team runs.

    (1) per-call timeout + retries on every litellm.completion so a stalled Bedrock
        response can't hang a run for an hour (observed: a cell froze ~1h, no error);
    (2) litellm.modify_params=True so the consecutive user blocks created by the
        auto-refresh poller (it injects a user msg after each tool result) are
        handled by inserting a dummy assistant turn rather than lossy merging
        (3793 "consecutive user/tool blocks" warnings in a team run vs 0 in solo);
    (3) raise the agent cost/step caps — the default $3 cost_limit fits a solo agent
        but cut the team LEAD off mid-integration (implement + integrate + verify),
        so the result measured budget-fit, not coordination. Both are no-ops if the
        config already allows more.

    Safe at load time (no cooperbench.runner.team import); idempotent.
    """
    try:
        import litellm

        litellm.modify_params = True
        if not getattr(litellm.completion, "_ot_wrapped", False):
            _orig_completion = litellm.completion

            def _completion(*a, **kw):  # type: ignore[no-untyped-def]
                kw.setdefault("timeout", LLM_TIMEOUT)
                kw.setdefault("num_retries", LLM_RETRIES)
                return _orig_completion(*a, **kw)

            _completion._ot_wrapped = True  # type: ignore[attr-defined]
            litellm.completion = _completion  # type: ignore[assignment]
    except Exception as e:  # noqa: BLE001
        _log.warning("litellm hardening failed: %s", e)

    try:
        from cooperbench.agents.mini_swe_agent_v2.agents.default import DefaultAgent

        if not getattr(DefaultAgent.__init__, "_ot_wrapped", False):
            _orig_agent_init = DefaultAgent.__init__

            def _agent_init(self, *a, **kw):  # type: ignore[no-untyped-def]
                _orig_agent_init(self, *a, **kw)
                try:
                    c = self.config
                    if getattr(c, "cost_limit", 0) and c.cost_limit < COST_LIMIT:
                        c.cost_limit = COST_LIMIT
                    if getattr(c, "step_limit", 0) and c.step_limit < STEP_LIMIT:
                        c.step_limit = STEP_LIMIT
                except Exception:  # noqa: BLE001
                    pass

            _agent_init._ot_wrapped = True  # type: ignore[attr-defined]
            DefaultAgent.__init__ = _agent_init  # type: ignore[assignment]
    except Exception as e:  # noqa: BLE001
        _log.warning("agent cap hardening failed: %s", e)


def _teardown_all() -> None:
    """Remove every per-run daemon sidecar (+ its volume) this process provisioned.

    Registered with ``atexit`` so a ``cooperbench run`` self-cleans. The graph is
    a per-run isolated coordination scratch — scoring reads patches, not the graph —
    so a hard ``rm -f`` + volume rm after the run is safe.
    """
    for rid in list(_CREATED_RUNS):
        subprocess.run(["docker", "rm", "-f", f"cb-ot-{rid}"], capture_output=True)
        subprocess.run(["docker", "rm", "-f", f"cb-otbridge-{rid}"], capture_output=True)
        subprocess.run(["docker", "volume", "rm", _vol(rid)], capture_output=True)
    _CREATED_RUNS.clear()


def _is_team(kw: dict) -> bool:
    """True when the prompt call is for a real (>=2 agent) team — gates the nudge."""
    ags = kw.get("agents")
    return bool(kw.get("team_role")) and bool(ags) and len(ags) >= 2 and bool(kw.get("agent_id"))


# Appended to the team prompt so agents actually exercise the attempt/verify layer
# (the OpenTasks differentiator Redis can't express). Targets CooperBench's two
# named pair-failure causes: Commitment ("unverifiable claims") + Expectation
# ("can't model partner's in-progress work").
_ATTEMPT_BLOCK = """

### Shared attempt + verification log (do NOT trust a bare "done")

The coop-task commands above are backed by a shared **task graph**. It also records
*evidenced* attempts so teammates can verify each other's work instead of trusting
claims — the single biggest reason paired agents fail is acting on a partner's
unverifiable "done".

```bash
coop-attempt-record <task_id> --outcome success --summary "<what you did>" --evidence '{"kind":"test","ref":"<the command or file that proves it>"}'
coop-attempt-record <task_id> --outcome failure --failure-reason "<why it did not work>"
coop-attempt-list <task_id>
```

- When you finish a task, record a `success` attempt whose `--evidence` names the
  test or command that proves it — in addition to `coop-task-update done`.
- Hit a dead-end? Record a `failure` attempt so no teammate repeats it.
- BEFORE you integrate or build on a teammate's task, run `coop-attempt-list <task_id>`
  and read their evidence. If an attempt has no checkable evidence, re-run their test
  yourself before relying on it.
"""


def _wait_socket(name: str, tries: int = 80) -> None:
    """Block until the daemon (in container ``name``) has bound its socket."""
    for _ in range(tries):
        r = subprocess.run(["docker", "exec", name, "test", "-S", SOCKET_PATH], capture_output=True)
        if r.returncode == 0:
            return
        time.sleep(0.25)
    _log.warning("opentasks daemon socket not ready in %s", name)


def ensure_opentasks_daemon(run_id: str) -> None:
    """Idempotently start a per-run OpenTasks daemon sidecar.

    Mirrors ``infra.redis.ensure_redis``: one daemon per run = one isolated
    graph = one writer; its socket lives on a per-run named volume shared with
    the agent containers. Safe to call from each agent thread — the first
    creates it, the rest find it running.
    """
    name = f"cb-ot-{run_id or 'default'}"
    _CREATED_RUNS.add(run_id or "default")  # mark for atexit teardown
    inspect = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name], capture_output=True, text=True
    )
    if inspect.returncode == 0 and inspect.stdout.strip() == "true":
        _wait_socket(name)
        return
    # exists-but-stopped -> start; otherwise create.
    if subprocess.run(["docker", "start", name], capture_output=True).returncode != 0:
        subprocess.run(
            [
                "docker", "run", "-d", "--name", name,
                "-e", f"OPENTASKS_PROJECT_DIR={MOUNT_DIR}",
                "-v", f"{_vol(run_id)}:{MOUNT_DIR}",
                DAEMON_IMAGE, "sh", "-c",
                "node dist/cli.js init 2>/dev/null || true; "
                "exec node dist/cli.js daemon start --foreground",
            ],
            capture_output=True,
        )
    _wait_socket(name)


def _wait_bridge_ready(port: int, tries: int = 120) -> None:
    """Block until a real request succeeds over the bridge (host -> socat -> daemon).

    A plain TCP connect only proves socat is *listening*; the daemon behind it may
    not be accepting yet — that startup race made the very first pre-seed request
    fail with "daemon closed the connection". Probe with an actual list_tasks until
    it succeeds so the path is proven before the pre-seed runs.
    """
    from ot_client import OpenTasksClient, OpenTasksError

    ep = f"tcp://127.0.0.1:{port}"
    for _ in range(tries):
        try:
            c = OpenTasksClient(ep, timeout=2)
            try:
                c.list_tasks()
                return
            finally:
                c.close()
        except (OpenTasksError, OSError):
            time.sleep(0.25)
    _log.warning("opentasks bridge not serving requests on 127.0.0.1:%s", port)


def ensure_socat_bridge(run_id: str) -> None:
    """Expose the (container) daemon Unix socket as a localhost TCP port.

    The host pre-seed + poller can't reach a Unix socket living inside a Docker
    named volume, so a tiny socat sidecar mounts that volume and bridges
    TCP->unix. Fixed host port (runs are serial); any stale bridge is removed
    first to free it.
    """
    name = f"cb-otbridge-{run_id or 'default'}"
    insp = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", name], capture_output=True, text=True
    )
    if insp.returncode == 0 and insp.stdout.strip() == "true":
        _wait_bridge_ready(BRIDGE_PORT)
        return
    # Remove only THIS run's stale bridge (same name) to free it — concurrent runs
    # use distinct run_ids + ports (CB_OT_BRIDGE_PORT), so never touch theirs.
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    subprocess.run(
        [
            "docker", "run", "-d", "--name", name,
            "-v", f"{_vol(run_id)}:{MOUNT_DIR}",
            "-p", f"127.0.0.1:{BRIDGE_PORT}:{BRIDGE_PORT}",
            BRIDGE_IMAGE,
            f"TCP-LISTEN:{BRIDGE_PORT},fork,reuseaddr",
            f"UNIX-CONNECT:{SOCKET_PATH}",
        ],
        capture_output=True,
    )
    _wait_bridge_ready(BRIDGE_PORT)


# Shell that creates the coop-task-* / coop-attempt-* wrappers in the container,
# each exec'ing the OpenTasks-backed CLI at /tmp/cb-coop-task.py.
_WRAPPER_SNIPPET = r"""
set -e
for pair in coop-task-create:create coop-task-claim:claim coop-task-update:update \
            coop-task-list:list coop-attempt-record:attempt-record coop-attempt-list:attempt-list; do
  name=${pair%%:*}; verb=${pair##*:}
  printf '#!/bin/sh\nexec python3 /tmp/cb-coop-task.py %s "$@"\n' "$verb" > "/usr/local/bin/$name"
  chmod +x "/usr/local/bin/$name"
done
"""


def _patch() -> None:
    import cooperbench.team_harness as th
    from cooperbench.agents.mini_swe_agent_v2 import adapter as v2

    # --- seam 1: mount the shared socket volume into each agent container ---
    _orig_mounts = th.TeamSession.scratchpad_mount_args

    def scratchpad_mount_args(self):  # type: ignore[no-untyped-def]
        args = list(_orig_mounts(self))
        args += ["--volume", f"{_vol(self.run_id)}:{MOUNT_DIR}"]
        return args

    th.TeamSession.scratchpad_mount_args = scratchpad_mount_args  # type: ignore[assignment]

    # --- seam 2: provision the daemon + install the OpenTasks coop-task CLI ---
    def _install_team_cli_in_container(env) -> None:  # type: ignore[no-untyped-def]
        from cooperbench.agents._coop.runtime import write_file_in_container

        run_id = ""
        cfg = getattr(env, "config", None)
        if cfg is not None and getattr(cfg, "env", None):
            run_id = cfg.env.get("CB_TEAM_RUN_ID", "")
        try:
            ensure_opentasks_daemon(run_id)
            write_file_in_container(env, "/tmp/ot_client.py", _read("ot_client.py"))
            write_file_in_container(env, "/tmp/cb-coop-task.py", _read("coop_task_opentasks.py"))
            env.execute({"command": _WRAPPER_SNIPPET}, timeout=60)
            # Make the socket path visible to every subsequent docker-exec.
            if cfg is not None and getattr(cfg, "env", None) is not None:
                cfg.env["CB_OPENTASKS_SOCKET"] = SOCKET_PATH
        except Exception as e:  # noqa: BLE001 -- best-effort, like the original
            _log.warning("opentasks team CLI install failed: %s", e)

    v2._install_team_cli_in_container = _install_team_cli_in_container

    # --- seam 3: nudge agents to use the attempt/verify layer (the OpenTasks
    # differentiator). Append the block to the team prompt; both prompt seams
    # are bare-name globals in `th`, so reassigning them here is picked up. ---
    _orig_bti = th.build_team_instruction
    _orig_tts = th.team_task_section

    def build_team_instruction(*a, **kw):  # type: ignore[no-untyped-def]
        text = _orig_bti(*a, **kw)
        return text + _ATTEMPT_BLOCK if _is_team(kw) else text

    def team_task_section(*a, **kw):  # type: ignore[no-untyped-def]
        text = _orig_tts(*a, **kw)
        return text + _ATTEMPT_BLOCK if _is_team(kw) else text

    th.build_team_instruction = build_team_instruction  # type: ignore[assignment]
    th.team_task_section = team_task_section  # type: ignore[assignment]

    # --- seam 4: redirect the HOST task paths (pre-seed + auto-refresh poller) to
    # the SAME OpenTasks store the agents' CLI uses — closes the split-brain. The
    # host reaches the container daemon socket via a per-run socat TCP bridge.
    # The storage redirect is installed LAZILY from this wrapper (run time) — see
    # _install_storage_redirect for why it can't happen at module-load time. ---
    _orig_ts_init = th.TeamSession.__init__

    def _ts_init(self, *a, **kw):  # type: ignore[no-untyped-def]
        _orig_ts_init(self, *a, **kw)
        global _CURRENT_RUN_ID
        _CURRENT_RUN_ID = getattr(self, "run_id", "") or ""
        try:
            ensure_opentasks_daemon(_CURRENT_RUN_ID)
            ensure_socat_bridge(_CURRENT_RUN_ID)
            _install_storage_redirect()  # idempotent; runs before the pre-seed
        except Exception as e:  # noqa: BLE001
            _log.warning("opentasks daemon/bridge/redirect setup failed: %s", e)

    th.TeamSession.__init__ = _ts_init  # type: ignore[assignment]

    # Self-clean the per-run daemon sidecars + bridges + volumes when the run exits.
    atexit.register(_teardown_all)

    # atexit doesn't fire when the run is *killed*; also tear down on SIGTERM/SIGINT,
    # chaining to any handler CooperBench installed so we don't swallow its shutdown.
    def _signal_teardown(signum, frame):  # type: ignore[no-untyped-def]
        _teardown_all()
        prev = _PREV_SIGNAL.get(signum)
        if callable(prev):
            prev(signum, frame)
        else:
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            _PREV_SIGNAL[_sig] = signal.getsignal(_sig)
            signal.signal(_sig, _signal_teardown)
        except (ValueError, OSError):
            pass  # not the main thread / unsupported platform


# Seam 5 (provider + budget hardening) is backend-AGNOSTIC — a Bedrock/litellm +
# step-cap correctness fix, not an OpenTasks feature. Apply it to EVERY arm (solo,
# the redis baseline, opentasks) whenever this module is loaded, so the A/B is fair.
# The OpenTasks backend swap (seams 1-4) still only activates under CB_OPENTASKS=1.
try:
    _harden_runtime()
    _log.info("opentasks_cooperbench: runtime hardening applied (timeout/modify_params/caps)")
except Exception as e:  # noqa: BLE001
    _log.warning("opentasks_cooperbench: runtime hardening failed (%s)", e)

if _enabled():
    try:
        _patch()
        _log.info("opentasks_cooperbench: CooperBench team mode -> OpenTasks backend")
    except Exception as e:  # noqa: BLE001
        _log.warning("opentasks_cooperbench: patch failed (%s) — leaving Redis backend in place", e)
