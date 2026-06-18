#!/usr/bin/env python3
"""Summarize the CooperBench A/B pilot → a retention table.

Reads logs/<name>/<setting>/<repo>/<task>/<features>/{eval,result}.json for each
arm (solo / redis / opentasks) and prints per-task pass/fail + per-arm pass-rate +
RETENTION (coop pass-rate / solo pass-rate). Pure read; safe to run anytime.

    python3 pilot-report.py [RUN_TAG]   # default tag: otpilot
"""
from __future__ import annotations

import glob
import json
import os
import sys

TAG = sys.argv[1] if len(sys.argv) > 1 else "otpilot"
CB = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../../references/cooperbench"))

# arm label -> (run-name, setting)
ARMS = [("solo", f"{TAG}-solo", "solo"), ("redis", f"{TAG}-redis", "team"), ("opentasks", f"{TAG}-ot", "team")]
TASKS = [("pallets_click_task", 2068), ("pallets_jinja_task", 1465), ("openai_tiktoken_task", 0)]


def load(name: str, setting: str, repo: str, task: int) -> dict | None:
    base = os.path.join(CB, "logs", name, setting, repo, str(task))
    evs = sorted(glob.glob(os.path.join(base, "*", "eval.json")))
    if not evs:
        return None
    ev = json.load(open(evs[0]))
    rs_path = os.path.join(os.path.dirname(evs[0]), "result.json")
    rs = json.load(open(rs_path)) if os.path.exists(rs_path) else {}
    agents = [a for a in (rs.get("agents") or {}).values() if isinstance(a, dict)]
    # A cell is INVALID (not a coordination signal) when an agent was terminated by the
    # hard Bedrock daily-token cap — distinct from an agent spending its own step budget
    # ("LimitsExceeded"), which is a legitimate outcome we DO count.
    rate_capped = any("Too many tokens" in (a.get("error") or "") for a in agents)
    return {
        "passed": ev.get("both_passed"),
        "f1": (ev.get("feature1") or {}).get("passed"),
        "f2": (ev.get("feature2") or {}).get("passed"),
        "merge": (ev.get("merge") or {}).get("status"),
        "cost": rs.get("total_cost"),
        "steps": rs.get("total_steps"),
        "rate_capped": rate_capped,
        "statuses": [f"{a.get('team_role', '?')}:{a.get('status')}" for a in agents],
    }


def main() -> None:
    print(f"# CooperBench A/B pilot — tag={TAG}\n")
    rates: dict[str, float] = {}
    costs: dict[str, float] = {}
    for arm, name, setting in ARMS:
        print(f"## {arm}  (name={name}, setting={setting})")
        npass = ndone = ninvalid = 0
        cost_sum = 0.0
        for repo, task in TASKS:
            r = load(name, setting, repo, task)
            short = repo.replace("_task", "")
            if r is None:
                print(f"  {short:24} task{task:<6}  —  (no eval.json yet)")
                continue
            cost_sum += r["cost"] or 0.0  # count spend even for excluded cells (transparency)
            if r["rate_capped"]:
                ninvalid += 1
                print(f"  {short:24} task{task:<6}  ⚠ RATE-LIMITED — excluded "
                      f"({', '.join(r['statuses'])})  ${(r['cost'] or 0):.2f}")
                continue
            ndone += 1
            npass += 1 if r["passed"] else 0
            mark = "PASS" if r["passed"] else "fail"
            merge = f" merge={r['merge']}" if r["merge"] else ""
            cost = f"${r['cost']:.2f}" if r["cost"] is not None else "$?"
            print(
                f"  {short:24} task{task:<6}  {mark}  "
                f"(f1={r['f1']} f2={r['f2']}{merge})  {cost}/{r['steps']}st"
            )
        rate = (npass / ndone) if ndone else None
        rates[arm] = rate if rate is not None else float("nan")
        costs[arm] = cost_sum
        rate_s = f"{npass}/{ndone}" + (f" = {rate:.0%}" if rate is not None else "")
        inv = f"  ({ninvalid} rate-limited, excluded)" if ninvalid else ""
        print(f"  -> pass-rate {rate_s}{inv}   arm-cost ${cost_sum:.2f}\n")

    solo = rates.get("solo")
    print("## Retention (coop pass-rate / solo pass-rate)")
    if not solo or solo != solo or solo == 0:
        print("  solo pass-rate is 0 or not run → retention undefined."
              " (Coordination deltas — merge conflicts, cost — still informative above.)")
    else:
        for arm in ("redis", "opentasks"):
            r = rates.get(arm)
            if r is None or r != r:
                continue
            print(f"  {arm:10} retention = {r:.0%} / {solo:.0%} = {r / solo:.2f}")
        rr, ro = rates.get("redis"), rates.get("opentasks")
        if rr == rr and ro == ro:
            print(f"\n  Δ(opentasks − redis) pass-rate = {(ro - rr):+.0%}"
                  f"   (total cost: redis ${costs.get('redis',0):.2f} vs opentasks ${costs.get('opentasks',0):.2f})")


if __name__ == "__main__":
    main()
