"""Minimal Python client for the OpenTasks daemon.

This is the linchpin of the CooperBench integration (Option A): the agents'
task-repo containers (python/go/rust images, not node) can't run the node
`opentasks` CLI, so they coordinate by speaking the daemon's wire protocol
directly — newline-delimited JSON-RPC 2.0 over its Unix socket (or a tcp://
endpoint). Same protocol as the node OpenTasksClient.

Backs the OpenTasks-flavored `coop-task-*` commands + exposes the attempt/verify
layer (record_attempt / list_attempts / verify) that the Redis task list can't.
"""

from __future__ import annotations

import itertools
import json
import os
import socket
from typing import Any


class OpenTasksError(RuntimeError):
    pass


class OpenTasksClient:
    def __init__(self, endpoint: str | None = None, timeout: float = 30.0) -> None:
        self.endpoint = endpoint or os.environ.get("OT_SOCK") or os.environ.get("CB_OPENTASKS_SOCKET")
        if not self.endpoint:
            raise OpenTasksError("no OpenTasks endpoint (set OT_SOCK / CB_OPENTASKS_SOCKET or pass endpoint)")
        self._ids = itertools.count(1)
        self._buf = b""
        self._sock = self._connect(timeout)

    def _connect(self, timeout: float) -> socket.socket:
        ep = self.endpoint
        if ep.startswith("tcp://"):
            host, _, port = ep[len("tcp://"):].partition(":")
            return socket.create_connection((host, int(port)), timeout=timeout)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(ep)
        return s

    def _request(self, method: str, params: Any) -> Any:
        rid = next(self._ids)
        wire = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n"
        self._sock.sendall(wire.encode("utf-8"))
        while b"\n" not in self._buf:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise OpenTasksError("daemon closed the connection")
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        resp = json.loads(line.decode("utf-8"))
        if resp.get("error"):
            raise OpenTasksError(resp["error"].get("message", str(resp["error"])))
        return resp.get("result")

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass

    def __enter__(self) -> "OpenTasksClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # --- tasks (the coop-task-* backend) ---

    def create_task(self, title: str, status: str = "open", **fields: Any) -> dict:
        return self._request("graph.create", {"type": "task", "title": title, "status": status, **fields})

    def get(self, node_id: str) -> dict | None:
        return self._request("graph.get", {"id": node_id})

    def update(self, node_id: str, **updates: Any) -> dict:
        return self._request("graph.update", {"id": node_id, **updates})

    def list_tasks(self, **filt: Any) -> list[dict]:
        r = self._request("tools.query", {"nodes": {"type": "task", **filt}, "verbose": True})
        return (r or {}).get("items", [])

    def claim_next(self, agent_id: str, duration_ms: int | None = None) -> dict:
        cn: dict[str, Any] = {"agentId": agent_id}
        if duration_ms:
            cn["durationMs"] = duration_ms
        r = self._request("tools.task", {"claimNext": cn})
        return (r or {}).get("data", r) or {}  # {claimed, nodeId, fence}

    def claim(self, node_id: str, agent_id: str, force: bool = False) -> dict:
        r = self._request("tools.task", {"claim": {"id": node_id, "agentId": agent_id, "force": force}})
        return (r or {}).get("data", r) or {}

    # --- attempt / verify (the OpenTasks differentiator) ---

    def record_attempt(
        self,
        task_id: str,
        agent: str,
        outcome: str = "pending",
        summary: str | None = None,
        evidence: dict | None = None,
        failure_reason: str | None = None,
    ) -> dict:
        meta: dict[str, Any] = {"outcome": outcome}
        if summary is not None:
            meta["summary"] = summary
        if evidence is not None:
            meta["evidence"] = evidence
        if failure_reason is not None:
            meta["failureReason"] = failure_reason
        terminal = outcome in ("success", "failure", "abandoned", "inconclusive")
        return self._request(
            "graph.create",
            {
                "type": "attempt",
                "title": (summary or f"Attempt at {task_id} by {agent}")[:120],
                "target_id": task_id,
                "assignee": agent,
                "status": "closed" if terminal else "in_progress",
                "metadata": {"attempt": meta},
            },
        )

    def list_attempts(self, task_id: str | None = None) -> list[dict]:
        r = self._request("tools.query", {"nodes": {"type": "attempt"}, "verbose": True})
        items = (r or {}).get("items", [])
        if task_id:
            items = [n for n in items if n.get("target_id") == task_id]
        return items

    def verify(
        self,
        verifier_attempt_id: str,
        attempt_id: str,
        verdict: str = "pass",
        verifier: str | None = None,
        evidence: dict | None = None,
    ) -> dict:
        meta: dict[str, Any] = {"verdict": verdict}
        if verifier:
            meta["verifier"] = verifier
        if evidence:
            meta["evidence"] = evidence
        return self._request(
            "tools.link",
            {"fromId": verifier_attempt_id, "toId": attempt_id, "type": "verifies", "metadata": meta},
        )

    def verifies_edges(self) -> list[dict]:
        r = self._request("tools.query", {"edges": {"type": "verifies"}, "verbose": True})
        return (r or {}).get("items", [])
