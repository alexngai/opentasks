# TheAgentCompany — stack requirements & setup plan (2026-06-14)

Scoping for the E2′ benchmark integration (see
[2026-06-14-P6-evaluation-design.md](./2026-06-14-P6-evaluation-design.md)).
Based on reading the repo (`~/GitHub/TheAgentCompany`, shallow clone).

## 1. Architecture

- **Two layers, decoupled:** (a) a set of long-running **service containers**
  (GitLab, ownCloud, RocketChat, Plane + an `api-server` controller on :2999),
  pre-baked with company data; (b) per-task **Docker images** (`FROM
  task-base-image:1.0.0`) holding `/instruction/task.md`, `/utils/init.sh`
  (env setup), `/utils/dependencies.yml` (which services), and
  **`/utils/eval.py` + `evaluator.py`** (the grader).
- **The agent is pluggable.** `evaluation/run_eval.py` is the *default* driver
  and is OpenHands-specific (it boots an OpenHands runtime from the task base
  image with **host networking** to the services, feeds it
  `"Complete the task in /instruction/task.md"`, then runs the evaluator). The
  task images + evaluators don't depend on OpenHands.
- **Scoring queries live services, not files.** `evaluator.py` checks final
  state in GitLab/ownCloud/etc. (e.g. "did a merge request get created"),
  weighted-checkpoint partial credit → exactly TheAgentCompany's `S_partial`.
  ⇒ we must run **their** evaluator; our simple file-checkpoint model doesn't
  apply to TAC tasks (a TAC *task adapter* shells out to `eval.py`).

## 2. Resource footprint

- Full stack: **30+ GB disk, ~32 GB RAM** (their baseline = EC2 t3.2xlarge,
  8 vCPU/32 GB). Plane is the heaviest + flakiest component.
- **Mac caveats (we're on darwin):** Docker Desktop **host networking must be
  enabled** or `api-server` hangs forever; **RocketChat's bitnami mongodb fails
  on Apple Silicon** unless you switch the Docker VM to QEMU/Docker-VMM. These
  make the *full* stack painful on a Mac.

## 3. SDE subset (our 69 tasks) — service dependencies

| Service | # of the 69 SDE tasks | Notes |
|---|---|---|
| GitLab | most | repos, MRs, CI, wiki, branch policy |
| RocketChat | ~11 | + needs an **env-LLM** to drive NPC coworkers |
| ownCloud | ~6 | file search / docs |
| Plane | ~5 | project mgmt |

- **~44/69 SDE tasks are GitLab-only** → a **GitLab-only slice** covers ~2/3 of
  the subset with **one service** (no Plane/RocketChat/ownCloud, no env-LLM,
  no Apple-Silicon mongodb issue). Much more Mac-tractable.

## 4. The agent / browser question (the real fork)

TheAgentCompany is a **browsing + coding** benchmark. The agent must often drive
web UIs (GitLab/ownCloud). Our committed harness runs a headless `claude -p`
with Bash/Read/Write/Edit — **no browser**. Three ways forward:

1. **claude-CLI + GitLab API (no browser)** — many GitLab-only tasks (create
   repo, add wiki, change branch policy, add CI) are doable via the GitLab REST
   API + `git` over Bash with a token. **Unknown how many**; the pilot measures
   it. Cheapest, keeps our runner + GLM-5 wiring as-is.
2. **claude-CLI + a browser MCP** (playwright/chrome-devtools) — adds browsing
   to *all* arms equally (not a confound). Keeps our runner; more setup.
3. **OpenHands as the agent** — the reference scaffold (leaderboard-comparable),
   *has* a browser, and uses **LiteLLM** so GLM-5 rides the same proxy we built.
   The 3 arms become OpenHands configs (stock / +NOTES.md / +OpenTasks MCP —
   OpenHands supports MCP). Heaviest to stand up; most faithful.

Note: GLM-5 works in **all three** (LiteLLM proxy already up).

## 5. Integration approach (a TAC task adapter)

Regardless of agent, the per-task loop is:
1. `docker build` the task image (or pull prebuilt) `FROM task-base-image`.
2. Bring up the required services (GitLab-only for the pilot slice).
3. Run `/utils/init.sh` (with `SERVER_HOSTNAME=the-agent-company.com` + env-LLM
   vars if the task needs NPCs).
4. Run the **agent** against `/instruction/task.md` with host-network access to
   the services (+ the GitLab token; arm = stock / notes / opentasks-MCP).
5. Run `/utils/eval.py` → parse points → `S_partial`; archive trace.

This is a new `tasks/` adapter in `evals/` (`theagentcompany.ts`) that wraps
steps 1–5 and emits our `RunResult`, reusing the existing arm/trace/metrics
plumbing but delegating scoring to the TAC evaluator.

## 6. Recommended tiered plan

- **Tier 0 — de-risk (cheap, Mac-friendly):** stand up **GitLab only**; pick
  **3–5 GitLab-only SDE tasks**; run the **stock** arm with the claude-CLI
  runner + a GitLab token (Bash/git/curl, no browser). **Measure: can it
  complete them via the API?** This answers the browser question empirically
  before any heavy investment, on a single service.
- **Tier 1 — E2′ pilot:** same GitLab-only slice, all **3 arms** on GLM-5,
  3 runs each, token-matched. Validates the full ablation on real tasks.
- **Tier 2 — scale:** expand to the ~44 GitLab-only SDE tasks; decide browser
  path (MCP vs OpenHands) for the remaining ~25 multi-service tasks; add
  ownCloud/RocketChat/Plane + env-LLM only if we pursue full-subset coverage.

If Tier 0 shows the API-only agent can't do enough, jump to OpenHands (option 3)
— it's the reference scaffold and GLM-5 already works through LiteLLM.

## 6b. How others in the literature run it (does everyone do heavyweight infra?)

Short answer: **the service infra is unavoidable for TAC (scoring queries live
services) — but it's modular, the agent is pluggable, and the field already has
a lighter API-over-browser variant.** Evidence:

- **Custom agents are officially supported.** TAC's own docs: if you're not using
  OpenHands, set your LLM env vars, run `/utils/init.sh`, point your agent at
  `/instruction/task.md`, score with `/utils/eval.py`. OpenHands (CodeAct +
  Browsing) is just the *baseline*; OWL-RolePlay (planner+browser+coder
  multi-agent) is another published baseline. So our claude-CLI runner is a
  sanctioned path, not a hack.
- **The services are modular.** `servers/docker-compose.yml` defines each service
  independently (gitlab / owncloud / rocketchat+mongodb / plane). The `setup.sh`
  all-in-one path uses an `api-server` controller, but `docker compose up gitlab`
  brings up just the prebaked GitLab image — so a **GitLab-only slice is real**,
  not a hack. `--run-npc-tasks-only` (tasks with `scenarios.json`) conversely
  isolates the RocketChat/env-LLM tasks; the GitLab-only tasks are the non-NPC
  complement and need **no env-LLM**.
- **Not GPU-heavy; modest per-task cost.** It's Docker-services + API agents, no
  local GPU. Published per-task cost **$0.79–$6.34** (model-dependent; GLM-5
  cheaper). The "few days" runtime is the *full 175* with OpenHands building a
  runtime image per task — a small GitLab-only slice is far lighter.
- **The field is moving toward API/MCP-over-browser.** **TheMCPCompany**
  (arXiv:2510.19286) rebuilds this style of company-services eval with **MCP
  tools instead of web-UI browsing** — direct evidence that an API/tool agent
  (no browser) is a legitimate, current approach. (Different service set —
  GitLab/Azure/Terraform — so it's a sibling benchmark, not a drop-in.)

**Implication:** our recommended Tier-0 (GitLab-only service + custom claude-CLI
+ GitLab API, no browser) is *literature-aligned*, not a corner-cut: it uses
TAC's supported custom-agent + subset path and mirrors TheMCPCompany's
API-over-browser insight. Heavyweight infra is only required if we pursue the
full multi-service subset.

## 7. Open decisions

1. **Tier 0 agent:** start with our claude-CLI + GitLab API (cheapest, tests
   browser-necessity), or go straight to OpenHands (browser + reference) ?
2. **Scope ceiling:** GitLab-only (~44 tasks, one service, Mac-friendly) as the
   eval, or commit to the full 69 (all services, browser, env-LLM, EC2-class
   host) for completeness?
3. **Host:** run the stack on this Mac (GitLab-only is fine; full stack is
   painful) or on a Linux/EC2 box (t3.2xlarge-class) for the full subset?

## Appendix — verified facts

- 175 tasks total; SDE = 69. `~/GitHub/TheAgentCompany` (depth-1 clone).
- Each task: `Dockerfile`, `dependencies.yml`, `task.md`, `checkpoints.md`,
  `evaluator.py`. Base: `ghcr.io/theagentcompany/task-base-image:1.0.0`.
- Services compose: `servers/docker-compose.yml`; setup script pulls prebaked
  images (`ghcr.io/theagentcompany/servers-*:1.0.0`).
- `run_eval.py`: `max_iterations=100`, `max_budget_per_task=4`,
  `use_host_network=True`, evaluator runs in-runtime; env-LLM passed to
  `init.sh` for NPC tasks.
