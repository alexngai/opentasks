"""Exercise the Python OpenTasks client against a live daemon.

Proves the crux of the CooperBench Option-A integration: a non-node process can
coordinate through OpenTasks over the wire — atomic claim + the attempt/verify
layer — exactly what the `coop-task-*` backend swap needs.

Run via run-ot-client-test.sh (which starts a host daemon and sets OT_SOCK).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from ot_client import OpenTasksClient  # noqa: E402


def _holds(r: dict) -> bool:
    """Did this claim result leave the caller holding the claim?"""
    return bool(r.get("claimed") or r.get("success"))


def main() -> None:
    c = OpenTasksClient()  # OT_SOCK from env

    # 1. create_task -> 't-' ids
    ids = [c.create_task(f"feature-{i}")["id"] for i in range(3)]
    assert all(i.startswith("t-") for i in ids), ids
    print(f"[1] created tasks: {ids}")

    # 2. claim_next drains the queue, distinct nodeIds, claimed:true
    claimed = []
    for _ in range(3):
        r = c.claim_next("agent-py")
        assert r.get("claimed") is True, r
        claimed.append(r["nodeId"])
    assert sorted(claimed) == sorted(ids), (claimed, ids)
    print(f"[2] claim_next drained 3 distinct: {claimed}")

    # 3. empty queue -> claimed:false
    r = c.claim_next("agent-py")
    assert r.get("claimed") is False, r
    print("[3] claim_next on empty -> claimed:false")

    # 4. atomic claim on a SPECIFIC task: exactly one agent wins
    contended = c.create_task("contended")["id"]
    a = c.claim(contended, "agent-a")
    b = c.claim(contended, "agent-b")
    assert _holds(a) and not _holds(b), f"double-claim! a={a} b={b}"
    print(f"[4] atomic claim: agent-a wins, agent-b rejected (a={_holds(a)}, b={_holds(b)})")

    # 5. record_attempt: pending stays in_progress; terminal outcome closes
    at_wip = c.record_attempt(ids[0], "agent-a", outcome="pending", summary="touching utils/parse.py")
    assert at_wip["id"].startswith("a-") and at_wip["status"] == "in_progress", at_wip
    at_done = c.record_attempt(
        ids[0], "agent-a", outcome="success",
        evidence={"kind": "test", "ref": "suiteX", "detail": "12/12"},
    )
    assert at_done["status"] == "closed", at_done
    attempts = c.list_attempts(task_id=ids[0])
    assert {at_wip["id"], at_done["id"]} <= {x["id"] for x in attempts}, attempts
    print(f"[5] attempts: wip={at_wip['id']}(in_progress), done={at_done['id']}(closed), listed {len(attempts)}")

    # 6. verify edge (an independent check of the successful attempt)
    verifier = c.record_attempt(ids[0], "agent-b", outcome="success", evidence={"kind": "test", "ref": "suiteX"})
    link = c.verify(verifier["id"], at_done["id"], verdict="pass", verifier="agent-b")
    assert link.get("success"), link
    edges = c.verifies_edges()
    match = [e for e in edges if e["from_id"] == verifier["id"] and e["to_id"] == at_done["id"]]
    assert match and match[0].get("metadata", {}).get("verdict") == "pass", edges
    print(f"[6] verifies edge: {verifier['id']} --verifies(pass)--> {at_done['id']}")

    c.close()
    print("\nPYTHON OT CLIENT: ALL CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print(f"\nFAIL: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
