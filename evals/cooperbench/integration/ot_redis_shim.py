"""An OpenTasks-backed ``_RedisLike`` for CooperBench's team task list.

CooperBench's `team_harness/task_list.py` (`TaskListClient`) and the auto-refresh
`loop_refresh.TeamPoller` both talk to a small subset of the redis client — and
CooperBench *designs* for substitution (the `_RedisLike` protocol; "tests pass
fakeredis.FakeRedis"). This class is that substitution, but backed by the
OpenTasks daemon instead of fakeredis, so the host-side **pre-seed** + **poller**
share ONE task store with the agents' `coop-task-*` CLI (which already talks to
the daemon). That closes the Redis/OpenTasks split-brain where the agents saw a
Redis-seeded task list via auto-refresh but `coop-task-list` (OpenTasks) was empty.

It implements exactly the redis ops those two callers use, over the documented
wire schema (namespace ``cb:<run_id>:``):

    task:<task_id>   Hash {id,title,owner,status,created_by,created_at,last_note,metadata}
    tasks:all        Set of task ids
    task-log         List of JSON mutation events

Reads mirror ``coop_task_opentasks._to_row`` field-for-field so the poller renders
identically to the agents' `coop-task-list`. The ``task-log`` is a process-shared
in-memory list: agent mutations go straight to the daemon via their CLI (not through
this shim), so the host log only captures host-side (pre-seed) events — the daemon
graph is the authoritative coordination record, read separately for metrics.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ot_client import OpenTasksClient, OpenTasksError  # noqa: E402

# Process-shared audit log per namespace (host-side events only; see module docstring).
_LOG: dict[str, list[str]] = {}


def _to_ot_status(s: str) -> str:
    return "closed" if s == "done" else s


def _from_ot_status(s: str) -> str:
    return "done" if s == "closed" else s


def _row(node: dict) -> dict[str, str]:
    """OpenTasks task node → CooperBench redis-hash shape (mirror of _to_row)."""
    meta = dict(node.get("metadata") or {})
    created_by = str(meta.pop("created_by", ""))
    last_note = str(meta.pop("last_note", ""))
    return {
        "id": str(node["id"]),
        "title": str(node.get("title", "")),
        "owner": str(node.get("claimed_by") or node.get("assignee") or ""),
        "status": _from_ot_status(str(node.get("status", "open"))),
        "created_by": created_by,
        "created_at": str(node.get("created_at", "")),
        "last_note": last_note,
        "metadata": json.dumps(meta),
    }


class OpenTasksRedisShim:
    """``_RedisLike`` backed by the OpenTasks daemon at ``endpoint`` (unix path or tcp://)."""

    def __init__(self, endpoint: str) -> None:
        self._ep = endpoint

    # one short-lived connection per op — robust against stale sockets; these
    # callers (pre-seed: a few creates; poller: between agent steps) are not hot.
    def _client(self) -> OpenTasksClient:
        try:
            return OpenTasksClient(self._ep)
        except OpenTasksError as e:
            raise OSError(str(e)) from e  # so TeamPoller.poll() degrades like Redis-down

    @staticmethod
    def _task_id(name: str) -> str:
        return name.split(":task:", 1)[-1]

    # --- writes -------------------------------------------------------------

    def hset(self, name: str, key: str | None = None, value: Any = None, mapping: Any = None) -> int:
        fields: dict[str, Any] = dict(mapping) if mapping else {}
        if key is not None:
            fields[key] = value
        try:
            with self._client() as c:
                # A create carries the full row (has 'title'); anything else is an update.
                if "title" in fields and "id" in fields:
                    meta = {}
                    try:
                        meta = json.loads(fields.get("metadata") or "{}")
                    except (TypeError, json.JSONDecodeError):
                        meta = {}
                    if fields.get("created_by"):
                        meta["created_by"] = fields["created_by"]
                    if fields.get("last_note"):
                        meta["last_note"] = fields["last_note"]
                    kw: dict[str, Any] = {"metadata": meta}
                    if fields.get("owner"):
                        kw["assignee"] = fields["owner"]
                    c.create_task(fields["title"], status=_to_ot_status(fields.get("status", "open")), **kw)
                    return 1
                # update path (claim sets owner+status; update sets status/last_note)
                tid = self._task_id(name)
                node = c.get(tid)
                if not node:
                    return 0
                updates: dict[str, Any] = {}
                if "status" in fields:
                    updates["status"] = _to_ot_status(str(fields["status"]))
                if fields.get("owner"):
                    updates["assignee"] = fields["owner"]
                if "last_note" in fields:
                    m = dict(node.get("metadata") or {})
                    m["last_note"] = fields["last_note"]
                    updates["metadata"] = m
                if updates:
                    c.update(tid, **updates)
                return 1
        except OpenTasksError as e:
            raise OSError(str(e)) from e

    def hsetnx(self, name: str, key: str, value: Any) -> int:
        # Only meaningful for 'owner'; set iff currently empty. (TaskListClient.claim
        # actually uses hset, so this is defensive.)
        with self._client() as c:
            tid = self._task_id(name)
            node = c.get(tid)
            if not node:
                return 0
            if key == "owner" and not (node.get("claimed_by") or node.get("assignee")):
                c.update(tid, assignee=value)
                return 1
            return 0

    def sadd(self, name: str, *values: Any) -> int:
        return len(values)  # no-op: the OpenTasks task list IS the set

    def rpush(self, name: str, *values: Any) -> int:
        log = _LOG.setdefault(name, [])
        log.extend(v if isinstance(v, str) else v.decode() if isinstance(v, bytes) else str(v) for v in values)
        return len(log)

    # --- reads --------------------------------------------------------------

    def hget(self, name: str, key: str) -> Any:
        try:
            with self._client() as c:
                node = c.get(self._task_id(name))
                return _row(node).get(key) if node else None
        except OpenTasksError as e:
            raise OSError(str(e)) from e

    def hgetall(self, name: str) -> dict:
        try:
            with self._client() as c:
                node = c.get(self._task_id(name))
                return _row(node) if node else {}
        except OpenTasksError as e:
            raise OSError(str(e)) from e

    def smembers(self, name: str) -> set:
        try:
            with self._client() as c:
                return {str(n["id"]).encode() for n in c.list_tasks()}
        except OpenTasksError as e:
            raise OSError(str(e)) from e

    def lrange(self, name: str, start: int, end: int) -> list:
        log = _LOG.get(name, [])
        if end == -1:
            return list(log[start:])
        return list(log[start : end + 1])
