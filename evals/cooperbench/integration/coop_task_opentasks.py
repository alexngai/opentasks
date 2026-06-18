#!/usr/bin/env python3
"""OpenTasks-backed drop-in for CooperBench's `team_harness/coop_task.py`.

Same `coop-task-*` verbs, JSON output shape, and exit codes — but the shared
task list is an OpenTasks graph (a REAL atomic claim) instead of Redis, and two
extra verbs (`attempt-record` / `attempt-list`) expose the attempt/verify layer
the Redis task list can't express.

Injected into the agent container by the OpenTasks external-agent patch (no
CooperBench fork). Self-contained except for `ot_client.py`, shipped alongside
to the same dir. Reads:

    CB_OPENTASKS_SOCKET   unix socket path or tcp://host:port of the daemon
    CB_TEAM_AGENT_ID      this agent's id
    CB_TEAM_TASKS_DIR     optional scratchpad mirror dir
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ot_client import OpenTasksClient, OpenTasksError  # noqa: E402

# CooperBench's status vocabulary uses "done"; OpenTasks tasks use "closed".
VALID_STATUSES = frozenset({"open", "in_progress", "blocked", "done"})


def _to_ot_status(s: str) -> str:
    return "closed" if s == "done" else s


def _from_ot_status(s: str) -> str:
    return "done" if s == "closed" else s


def _client() -> OpenTasksClient:
    ep = os.environ.get("CB_OPENTASKS_SOCKET") or os.environ.get("OT_SOCK")
    if not ep:
        raise OpenTasksError("CB_OPENTASKS_SOCKET not set")
    return OpenTasksClient(ep)


def _agent() -> str:
    return os.environ.get("CB_TEAM_AGENT_ID", "agent")


def _to_row(node: dict) -> dict:
    """Map an OpenTasks task node onto CooperBench's coop_task list shape."""
    meta = dict(node.get("metadata") or {})
    return {
        "id": node["id"],
        "title": node.get("title", ""),
        "owner": node.get("claimed_by") or node.get("assignee") or "",
        "status": _from_ot_status(node.get("status", "open")),
        "created_by": meta.pop("created_by", ""),
        "created_at": node.get("created_at", ""),
        "last_note": meta.pop("last_note", ""),
        "metadata": meta,
    }


def cmd_create(a: argparse.Namespace) -> int:
    c = _client()
    fields: dict = {"metadata": {"created_by": _agent()}}
    if a.assign:
        fields["assignee"] = a.assign
    node = c.create_task(a.title, status="open", **fields)
    print(node["id"])  # the OpenTasks id (t-…) is what agents pass to claim/update
    return 0


def cmd_claim(a: argparse.Namespace) -> int:
    c = _client()
    node = c.get(a.task_id)
    if not node or node.get("type") != "task":
        print(f"task {a.task_id} does not exist", file=sys.stderr)
        return 1
    owner = node.get("claimed_by")
    if owner and owner != _agent():
        print(f"task {a.task_id} owned by {owner}", file=sys.stderr)
        return 2
    r = c.claim(a.task_id, _agent())
    if r.get("claimed") or r.get("success"):
        return 0
    # Lost the race between get() and claim() — the real atomic guard caught it.
    holder = (r.get("existingClaim") or {}).get("agentId") or "another agent"
    print(f"task {a.task_id} owned by {holder}", file=sys.stderr)
    return 2


def cmd_update(a: argparse.Namespace) -> int:
    c = _client()
    node = c.get(a.task_id)
    if not node or node.get("type") != "task":
        print(f"task {a.task_id} does not exist", file=sys.stderr)
        return 1
    owner = node.get("claimed_by") or node.get("assignee")
    if owner != _agent():
        print(f"task {a.task_id} owned by {owner!r}, not you", file=sys.stderr)
        return 3
    if a.status not in VALID_STATUSES:
        print(f"invalid status {a.status!r}; expected one of {sorted(VALID_STATUSES)}", file=sys.stderr)
        return 4
    updates: dict = {"status": _to_ot_status(a.status)}
    if a.note is not None:
        meta = dict(node.get("metadata") or {})
        meta["last_note"] = a.note
        updates["metadata"] = meta
    c.update(a.task_id, **updates)
    return 0


def cmd_list(a: argparse.Namespace) -> int:
    c = _client()
    rows = [_to_row(n) for n in c.list_tasks()]
    me = _agent()
    if a.mine:
        rows = [r for r in rows if r["owner"] == me]
    if a.open_only:
        rows = [r for r in rows if r["status"] == "open"]
    print(json.dumps(rows, indent=2, default=str))
    # Best-effort scratchpad mirror (matches coop_task.py's side effect).
    target = os.environ.get("CB_TEAM_TASKS_DIR")
    if target:
        try:
            os.makedirs(target, exist_ok=True)
            for r in rows:
                with open(os.path.join(target, f"{r['id']}.json"), "w", encoding="utf-8") as f:
                    json.dump(r, f, indent=2, default=str)
        except OSError:
            pass
    return 0


# --- attempt / verify: the OpenTasks differentiator (no Redis equivalent) ---


def cmd_attempt_record(a: argparse.Namespace) -> int:
    c = _client()
    evidence = json.loads(a.evidence) if a.evidence else None
    node = c.record_attempt(
        a.task_id, _agent(), outcome=a.outcome, summary=a.summary,
        evidence=evidence, failure_reason=a.failure_reason,
    )
    print(node["id"])
    return 0


def cmd_attempt_list(a: argparse.Namespace) -> int:
    c = _client()
    print(json.dumps(c.list_attempts(task_id=a.task_id), indent=2, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="coop-task")
    sub = p.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("create")
    pc.add_argument("title")
    pc.add_argument("--assign", default=None, help="pre-assign owner (still requires claim)")
    pc.set_defaults(func=cmd_create)

    pcl = sub.add_parser("claim")
    pcl.add_argument("task_id")
    pcl.set_defaults(func=cmd_claim)

    pu = sub.add_parser("update")
    pu.add_argument("task_id")
    pu.add_argument("status")
    pu.add_argument("-n", "--note", default=None)
    pu.set_defaults(func=cmd_update)

    pl = sub.add_parser("list")
    pl.add_argument("--mine", action="store_true")
    pl.add_argument("--open", dest="open_only", action="store_true")
    pl.set_defaults(func=cmd_list)

    pa = sub.add_parser("attempt-record")
    pa.add_argument("task_id")
    pa.add_argument("--outcome", default="pending")
    pa.add_argument("--summary", default=None)
    pa.add_argument("--evidence", default=None, help="JSON EvidenceRef")
    pa.add_argument("--failure-reason", dest="failure_reason", default=None)
    pa.set_defaults(func=cmd_attempt_record)

    pal = sub.add_parser("attempt-list")
    pal.add_argument("task_id", nargs="?", default=None)
    pal.set_defaults(func=cmd_attempt_list)

    args = p.parse_args(argv)
    try:
        return args.func(args)
    except OpenTasksError as e:
        print(f"opentasks error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
