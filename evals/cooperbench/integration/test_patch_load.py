"""Regression guard: the injection must apply on CooperBench's real load path.

CooperBench imports external-agent modules from `agents/registry.py` *while*
`cooperbench.agents` is still initializing. If `opentasks_cooperbench` imports
`cooperbench.runner.team` at module-load time it hits a circular import, `_patch()`
throws, and the WHOLE injection silently falls back to Redis (split-brain). This
test reproduces that exact load order and asserts the patch applies + the storage
redirect is correctly deferred to run time. No Docker / no daemon needed.

Run: references/cooperbench/.venv/bin/python test_patch_load.py
"""
from __future__ import annotations

import os
import sys

INT = os.path.dirname(os.path.abspath(__file__))
os.environ["CB_OPENTASKS"] = "1"
os.environ["COOPERBENCH_EXTERNAL_AGENTS"] = "opentasks_cooperbench"
sys.path.insert(0, INT)

# Importing cooperbench.agents triggers registry.py's __import__ of our module
# mid-init — the circular-import-prone path that previously aborted _patch().
import cooperbench.agents  # noqa: F401,E402
import cooperbench.team_harness as th  # noqa: E402
import opentasks_cooperbench as ot  # noqa: E402
from ot_redis_shim import OpenTasksRedisShim  # noqa: E402

ok = True


def check(cond: bool, msg: str) -> None:
    global ok
    print(("  ok " if cond else "  FAIL ") + msg)
    ok = ok and cond


# _patch() applied despite the load order (the bug was: it threw here).
check(th.TeamSession.__init__.__name__ == "_ts_init", "patch applies (TeamSession.__init__ wrapped)")
# The storage redirect must be DEFERRED — installing it at load time is the bug.
check(ot._SEAM4_INSTALLED is False, "storage redirect deferred to run time (not installed at load)")
# Seam 3 (the attempt/verify nudge) still intact.
check("coop-attempt-record" in th.team_task_section(agents=["l", "m"], agent_id="l", team_role="lead"),
      "attempt/verify nudge intact")
# At run time (cooperbench now fully loaded) the deferred install works — no circular import.
ot._install_storage_redirect()
import cooperbench.runner.team as team_mod  # noqa: E402
check(isinstance(team_mod._redis_client("redis://x"), OpenTasksRedisShim), "redirect installs at run time")
check(ot._SEAM4_INSTALLED is True, "redirect marked installed (idempotent)")

# seam 5: provider + budget hardening applied at load time.
import litellm  # noqa: E402
check(litellm.modify_params is True, "litellm.modify_params on (consecutive-block fix)")
check(getattr(litellm.completion, "_ot_wrapped", False), "litellm.completion wrapped (timeout + retries)")
from cooperbench.agents.mini_swe_agent_v2.agents.default import DefaultAgent  # noqa: E402
check(getattr(DefaultAgent.__init__, "_ot_wrapped", False), "agent cost/step caps raised")

print("\n" + ("PASS: injection applies on the real load path" if ok else "FAILED"))
sys.exit(0 if ok else 1)
