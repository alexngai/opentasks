import json, glob, os
CB = "references/cooperbench/logs"
TASKS = [("jinja","pallets_jinja_task","1465"),("tiktoken","openai_tiktoken_task","0"),("click","pallets_click_task","2068")]
ARMS = {
  "solo":      ("solo", {"jinja":"dbg-az-solo-jinja","tiktoken":"dbg-az-solo-tiktoken","click":"dbg-az-solo-click"}),
  "redis":     ("team", {"jinja":"dbg-az-redis-jinja","tiktoken":"dbg-az-redis-tiktoken","click":"dbg-az-redis-click"}),
  "opentasks": ("team", {"jinja":"dbg-opentasks-azure_gpt-5_5","tiktoken":"dbg-az-ot-tiktoken","click":"dbg-az-ot-click"}),
}
def cell(name, setting, repo, task):
    ev = glob.glob(f"{CB}/{name}/{setting}/{repo}/{task}/*/eval.json")
    if not ev: return None
    e = json.load(open(ev[0]))
    rp = os.path.join(os.path.dirname(ev[0]),"result.json")
    r = json.load(open(rp)) if os.path.exists(rp) else {}
    cap = any("Too many tokens" in (a.get("error") or "") for a in (r.get("agents") or {}).values() if isinstance(a,dict))
    return {"pass": e.get("both_passed"), "cap": cap, "cost": (r.get("agent",{}).get("cost",0) if "agent" in r else sum(a.get("cost",0) for a in (r.get("agents") or {}).values() if isinstance(a,dict)))}
print(f"{'':11}{'jinja':>12}{'tiktoken':>12}{'click':>12}   pass-rate")
rates={}
for arm,(setting,names) in ARMS.items():
    row=[]; npass=ndone=0
    for tk,repo,task in TASKS:
        c=cell(names[tk],setting,repo,task)
        if c is None: row.append("running")
        elif c["cap"]: row.append("RATECAP")
        else:
            ndone+=1; npass+= 1 if c["pass"] else 0
            row.append(("PASS" if c["pass"] else "fail")+f"(${c['cost']:.2f})")
    rates[arm]=(npass,ndone)
    rate = f"{npass}/{ndone}" if ndone else "-"
    print(f"{arm:11}"+"".join(f"{x:>12}" for x in row)+f"   {rate}")
s=rates["solo"]
if s[1] and s[0]:
    sr=s[0]/s[1]
    print(f"\nsolo pass-rate = {s[0]}/{s[1]} = {sr:.0%}")
    for a in ("redis","opentasks"):
        n,d=rates[a]
        if d: print(f"  {a:10} retention = {n}/{d} / {sr:.0%} = {(n/d)/sr:.2f}")
else:
    print("\n(solo denominator incomplete — retention pending)")
