"""Validate the OpenTasks-backed _RedisLike shim against a live daemon.

Drives CooperBench's REAL `TaskListClient` (pre-seed) + `_read_tasks` /
`format_task_summary` (the auto-refresh poller) through the shim, then proves the
agents' `coop-task-list` (a direct `ot_client`) sees the SAME tasks — i.e. the
Redis/OpenTasks split-brain is gone. Run via run-shim-test.sh (needs OT_SOCK).
"""
from __future__ import annotations

import os
import sys

INT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INT)
from ot_client import OpenTasksClient  # noqa: E402
from ot_redis_shim import OpenTasksRedisShim  # noqa: E402
from cooperbench.team_harness.task_list import TaskListClient  # noqa: E402
from cooperbench.team_harness.loop_refresh import _read_tasks, format_task_summary  # noqa: E402

EP = os.environ["OT_SOCK"]
RUN = "testrun"
ok = True


def check(cond: bool, msg: str) -> None:
    global ok
    print(("  ok " if cond else "  FAIL ") + msg)
    if not cond:
        ok = False


shim = OpenTasksRedisShim(EP)

# 1. Pre-seed exactly like runner/team.py (host side, through the shim).
tl = TaskListClient(shim, RUN)
tl.create(title="Implement feature 2", created_by="bench-runner", owner="agent2",
          metadata={"feature_id": 2, "assigned_to": "agent2"})
tl.create(title="Lead-only: integrate and submit feature 1", created_by="bench-runner", owner="agent1",
          metadata={"feature_id": 1, "assigned_to": "agent1", "lead_task": True})

# 2. Auto-refresh poller view, via CooperBench's real _read_tasks + format.
summary = format_task_summary(_read_tasks(shim, RUN), viewer="agent2")
print("\n-- poller summary (what the agent sees between steps) --\n" + summary + "\n")
check("Implement feature 2" in summary, "poller shows the member's pre-seeded task")
check("Lead-only" in summary, "poller shows the lead's pre-seeded task")
check("(you own)" in summary, "owner marker resolves (assignee -> owner)")

# 3. Agent's coop-task-list (a direct ot_client) sees the SAME store — no split-brain.
agent = OpenTasksClient(EP)
at = agent.list_tasks()
titles = sorted(t.get("title", "") for t in at)
check(len(at) == 2, f"agent CLI sees exactly the 2 pre-seeded tasks (got {len(at)}: {titles})")
check(any(t.get("title") == "Implement feature 2" for t in at), "agent CLI can read a host-pre-seeded task")

# 4. Bidirectional: an agent-created task shows up in the poller too.
agent.create_task("agent-made task", status="open", metadata={"created_by": "agent2"})
summary2 = format_task_summary(_read_tasks(shim, RUN), viewer="agent2")
check("agent-made task" in summary2, "poller reflects a task the agent created via its CLI")

# 5. Host-side reads round-trip (list_ids + get).
ids = tl.list_ids()
check(len(ids) == 3, f"list_ids round-trips all tasks (got {len(ids)})")
g = tl.get(ids[0])
check(g.get("status") in ("open", "in_progress", "done", "blocked"), "get() returns a coop-vocab status")

print("\n" + ("PASS: pre-seed + poller + agent CLI share ONE OpenTasks store" if ok
              else "FAILED: split-brain not fully closed"))
sys.exit(0 if ok else 1)
