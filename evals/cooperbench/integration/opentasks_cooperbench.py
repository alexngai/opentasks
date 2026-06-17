"""Inject OpenTasks into CooperBench's `team` mode WITHOUT forking it.

Load via CooperBench's external-agent hook (it just `__import__`s the module):

    PYTHONPATH=evals/cooperbench/integration \
    CB_OPENTASKS=1 \
    OPENTASKS_DAEMON_IMAGE=opentasks-daemon:smoke \
    COOPERBENCH_EXTERNAL_AGENTS=opentasks_cooperbench \
    cooperbench run --backend docker --setting team -a mini_swe_agent_v2 ...

When `CB_OPENTASKS=1`, importing this module monkeypatches two CooperBench seams
so the `team` setting coordinates through an OpenTasks daemon (a REAL atomic
claim + the attempt/verify layer) instead of Redis. Nothing under
`references/cooperbench` is modified:

  1. ``TeamSession.scratchpad_mount_args`` — also mount a per-run named volume
     holding the daemon's Unix socket into each agent container.
  2. ``mini_swe_agent_v2.adapter._install_team_cli_in_container`` — provision a
     per-run daemon sidecar, ship ``ot_client.py`` + the OpenTasks-backed
     ``coop-task`` CLI into the container, create the ``coop-task-*`` /
     ``coop-attempt-*`` wrappers, and point them at the shared socket.

The agents keep the identical ``coop-task-*`` shell interface; only the
substrate changes. Scoring is untouched (CooperBench scores patches against
ground-truth tests, independent of the coordination backend — verified in the
integration plan, §7).

STATUS: the backend it wires in (``ot_client.py`` + ``coop_task_opentasks.py``)
is unit-tested against a live daemon. This injection glue needs a full
``cooperbench run`` (prepare + Docker task images + an LLM key) to verify
end-to-end; the monkeypatch targets are pinned to the vendored CooperBench.
"""

from __future__ import annotations

import logging
import os
import subprocess
import time

_log = logging.getLogger("opentasks_cooperbench")
_HERE = os.path.dirname(os.path.abspath(__file__))

DAEMON_IMAGE = os.environ.get("OPENTASKS_DAEMON_IMAGE", "opentasks-daemon:smoke")
MOUNT_DIR = "/srv/ot"
SOCKET_PATH = f"{MOUNT_DIR}/daemon.sock"


def _enabled() -> bool:
    return os.environ.get("CB_OPENTASKS", "").lower() in ("1", "true", "yes")


def _read(name: str) -> str:
    with open(os.path.join(_HERE, name), encoding="utf-8") as f:
        return f.read()


def _vol(run_id: str) -> str:
    return f"cb-ot-{run_id or 'default'}"


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


if _enabled():
    try:
        _patch()
        _log.info("opentasks_cooperbench: CooperBench team mode -> OpenTasks backend")
    except Exception as e:  # noqa: BLE001
        _log.warning("opentasks_cooperbench: patch failed (%s) — leaving Redis backend in place", e)
