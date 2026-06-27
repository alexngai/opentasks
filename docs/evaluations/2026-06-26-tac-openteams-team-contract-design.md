# TAC OpenTeams Team Contract Design (2026-06-26)

**Status:** design draft for review.
**Extends:** [2026-06-18 TheAgentCompany experiment design](./2026-06-18-theagentcompany-experiment-design.md).
**Scope:** a full-ecosystem TAC arm that uses OpenTeams, swarm-dispatch,
swarm-harness, and OpenTasks to emulate the "team-first orchestration" pattern
seen in OMC/OMX-style workflows.

## 0. Objective

Evaluate whether OpenTasks becomes more load-bearing when it is paired with a
structured team contract instead of only being exposed as an optional MCP graph.

The single-harness TAC path already tests:

- `stock`: agent plus native task instructions
- `notes`: agent plus unstructured durable notes
- `opentasks`: agent plus OpenTasks MCP/graph nudge
- `swarm-harness --single`: one swarm-harness worker with OpenTasks available
- `swarm-harness swarm run`: model-driven worker spawning

This design adds an experimental arm:

| Arm | Purpose |
|---|---|
| `opentasks-team-contract` | OpenTeams defines roles/topology/loadouts; swarm-dispatch schedules work; swarm-harness executes agents; OpenTasks records task/evidence/verification state. |

The headline question is not "can we spawn more agents?" The previous smoke
already proved that. The question is:

> Does a runtime-enforced team contract make OpenTasks useful as the coordination
> substrate, enough to beat a strong coordinator solving mostly solo?

## 1. Recent Evidence

Latest successful full-stack smoke:

- run: `tac-complex-plane-gitlab-opentasks-swarmrun-azure-gpt55-2026-06-26T00-46-56Z`
- task: `pm-update-plane-issue-from-gitlab-status`
- arm/model: `opentasks` / `azureoai/gpt-5.5`
- harness mode: `swarm-harness swarm run`
- result: full TAC success, `S_partial=1.0`
- reported tokens: `55,306`
- latency: `453s`

Trajectory read:

- swarm mechanics worked: root coordinator, task worker, and one delegated
  inspection worker were present in the raw trace.
- OpenTasks graph was seeded but not used by native `mcp__opentasks__*` calls.
- the worker called swarm task tools (`task_list`, `task_output`) but reported
  that native OpenTasks and ToolSearch were not exposed.
- the delegated child used `permissionMode=read-only`; in that mode Bash was
  unavailable, `/instruction/task.md` was outside the file-tool workspace, and
  permission escalation was unavailable.
- the coordinator solved the task mostly solo through Bash/Python/API probes.

Pipeline issues found in that run:

- success cells still received `taxonomyUndifferentiatedTaskFailure=1`.
- diagnostics did not parse swarm lane events, so tool errors were missed.
- token accounting double-counted the final swarm `succeeded` usage after
  `message_stop` usage.
- the store `.trace.jsonl` flattened a 6,477-line raw trace to 37 entries,
  losing multi-agent lifecycle detail.

Implication: the current multi-agent smoke proves execution mechanics, not
productive coordination or OpenTasks graph adoption.

## 2. Design Thesis

Prompting the model to "coordinate more" is insufficient. The failing part of
the last run was structural:

- the child did not have the capability needed for the assignment;
- task content was not available in the child's readable workspace;
- OpenTasks graph tools were not exposed in the worker's visible tool surface;
- no stop-gate forced useful delegation or graph evidence before final answer.

The full-ecosystem design should make coordination a contract:

1. OpenTeams declares role and topology intent.
2. swarm-dispatch owns durable dispatch lifecycle, retries, continuation, and
   reconciliation.
3. swarm-harness owns agent execution and tool exposure.
4. OpenTasks owns root task, subtask, attempt, evidence, decision, and
   verification state.
5. TAC evaluator remains the only scoring authority.

## 3. Component Responsibilities

| Component | Responsibility in this arm | Not responsible for |
|---|---|---|
| OpenTeams | Declarative team shape: roles, loadouts, topology, communication rules, role prompts. | Runtime state, claims, retry, scoring. |
| swarm-dispatch | Poll/claim ready work, route or spawn agents, track lifecycle, retry, continuation, reconcile stale work. | Defining domain roles or grading TAC. |
| swarm-harness | Run coordinator/workers, expose role-appropriate tools, capture raw team trace. | Owning task graph semantics. |
| OpenTasks | Durable graph: task content, claims, attempts, evidence, decisions, verification records, provenance edges. | Choosing which worker process to spawn. |
| TAC adapter | Seed task graph, prepare container/services, collect traces, run TAC grader, report metrics. | Letting graph state affect TAC score. |

This preserves the SwarmKit ownership boundary: OpenTasks owns work state,
swarm-dispatch owns generic dispatch mechanics, and swarm-harness owns runtime
execution.

## 4. TAC Team Template

Initial OpenTeams template: `tac-service-sync`.

```yaml
name: tac-service-sync
version: 1
roles: [coordinator, service_inspector, api_mapper, verifier]

topology:
  root:
    role: coordinator
  spawn_rules:
    coordinator: [service_inspector, api_mapper, verifier]
    service_inspector: []
    api_mapper: []
    verifier: []

communication:
  enforcement: audit
  channels:
    evidence:
      signals: [EVIDENCE_FOUND, BLOCKED, VERIFIED]
    decisions:
      signals: [DECISION_PROPOSED, DECISION_ACCEPTED, DECISION_REJECTED]
  subscriptions:
    coordinator:
      - channel: evidence
      - channel: decisions
    verifier:
      - channel: decisions
  emissions:
    coordinator: [DECISION_PROPOSED, DECISION_ACCEPTED, DECISION_REJECTED]
    service_inspector: [EVIDENCE_FOUND, BLOCKED]
    api_mapper: [EVIDENCE_FOUND, BLOCKED]
    verifier: [VERIFIED, BLOCKED]
```

Role contracts:

| Role | Allowed behavior | Required output |
|---|---|---|
| `coordinator` | Read root task, decompose, assign, mutate services after evidence, write decisions and final answer. | accepted decision, write plan, final verification pointer. |
| `service_inspector` | Read TAC instruction, inspect service state and source systems, no mutation. | issue IDs/statuses, endpoints used, confidence, blockers. |
| `api_mapper` | Probe API shape with bounded read and safe OPTIONS/GET-style calls; no mutation. | endpoint map, payload schema candidates, known unsafe calls. |
| `verifier` | Inspect final service state after coordinator writes; no mutation. | pass/fail verification evidence. |

## 5. Capability-Aware Delegation

Each worker packet must carry an explicit capability declaration. TAC read-only
inspection is not the same as no-shell access; it needs bounded shell/API reads.

Minimum capability sets:

| Capability set | Tools | Mutation policy |
|---|---|---|
| `task-read` | read `/instruction/task.md` or receive mirrored task text in prompt. | none |
| `service-read` | bounded Bash, `curl`, `tac-gitlab-api`, `tac-plane-api`, Python `requests`, service env reads. | no non-GET writes unless explicitly allowed |
| `api-probe` | `OPTIONS`, `GET`, schema/list endpoints, bounded output. | no mutation |
| `service-write` | mutation endpoints required by TAC task. | coordinator only |
| `verify` | independent read-only service inspection after write. | no mutation |

Pass gate before spawning a child:

- child prompt includes full TAC task content or a readable mirror path;
- child has the declared capability set;
- child output schema is included;
- mutation policy is explicit;
- timeout/max-turn budget is explicit.

For the first implementation, use `danger-full-access` for child inspectors with
explicit no-mutation instructions and post-hoc mutation checks. This is broader
than the desired end state, but it isolates the coordination contract from the
current permission-mode limitation where `read-only` blocks the shell/API reads
that TAC inspection requires. A bounded read/API permission mode can replace it
after the useful-coordination smoke passes.

## 6. OpenTasks Graph Contract

The team contract should use OpenTasks as the durable coordination substrate,
not merely as a prompt appendix.

Seeded nodes:

| Node | Purpose |
|---|---|
| root task | Full TAC instruction text and TAC metadata. |
| `service_inspection` subtask | Read-only status discovery assignment. |
| `api_mapping` subtask | API shape discovery assignment. |
| `mutation_plan` task/context | Coordinator's proposed write plan. |
| `verification` subtask | Independent final check. |

Edges and metadata:

- `blocks`: mutation blocked by required evidence tasks.
- `implements`: subtasks implement root TAC task.
- `references`: evidence records reference service URLs, issue IDs, or endpoint
  names.
- `verifies`: verifier evidence verifies the mutation plan and final state.
- `metadata.role`: OpenTeams role slug.
- `metadata.capabilities`: declared capability set.
- `metadata.evidence`: structured evidence summary.
- `metadata.outcome`: `pass` / `fail` / `blocked` / `inconclusive`.

The graph should be both human-readable and machine-checkable. Agents may still
communicate through swarm task/inbox tools, but durable claims and evidence live
in OpenTasks.

Minimum evidence record schema:

```json
{
  "role": "service_inspector",
  "task_id": "service_inspection",
  "status": "pass",
  "evidence": [
    {
      "kind": "api",
      "target": "GET /projects/root/janusgraph/issues?state=all",
      "summary": "Issue 4659 is opened; issue 4660 is closed."
    }
  ],
  "commands_or_endpoints": [
    "tac-gitlab-api GET projects/root/janusgraph/issues?state=all",
    "tac-plane-api GET workspaces/tac/projects/<project-id>/issues/?expand=state"
  ],
  "confidence": "high",
  "blockers": []
}
```

`status` is one of `pass`, `fail`, `blocked`, or `inconclusive`.
`confidence` is one of `low`, `medium`, or `high`.

For v1, evidence may be stored as task metadata or annotation payloads. If
`verifies` is not available as a first-class edge type in the active OpenTasks
schema, represent verification with a `references` edge plus
`metadata.relation="verifies"` and promote it later.

## 7. Stop-Gate

The coordinator cannot finish the `opentasks-team-contract` arm unless all
required gates are satisfied or explicitly marked blocked:

1. root task content read from OpenTasks or mirrored packet;
2. at least one child spawned with declared capabilities;
3. at least one child writes usable evidence, or a blocked evidence node
   explains why not;
4. coordinator consumes child evidence before first service mutation;
5. final verifier runs after mutation;
6. verification evidence is recorded in OpenTasks;
7. final answer cites the verification record.

This gate distinguishes "spawned a worker" from "coordinated productively."

For v1, enforce the stop-gate in the TAC adapter's post-run metric pass. Do not
block the running agent process yet. The first goal is a reliable measurement
that can classify a run as `productive_coordination=true|false`; runtime
termination or retry can move into swarm-harness/swarm-dispatch after the
contract is stable.

## 8. Evaluation Arms

Do not replace the current OpenTasks arm. Add a new arm so attribution stays
clean.

| Arm | Harness | Coordination substrate |
|---|---|---|
| `stock` | same baseline harness | none beyond task instruction |
| `notes` | same baseline harness | shared `NOTES.md` discipline |
| `opentasks` | same baseline harness | OpenTasks MCP graph |
| `opentasks-swarm` | swarm-harness `swarm run` | swarm task tools + optional OpenTasks |
| `opentasks-team-contract` | swarm-harness + OpenTeams + swarm-dispatch | OpenTasks graph + runtime team contract |

Primary score remains TAC `S_partial`. Graph state never changes score.

For the first runnable slice, `opentasks-team-contract` means static OpenTeams
role packets plus swarm-harness execution and OpenTasks evidence records. Do not
include swarm-dispatch in the first smoke; add it only after static team
coordination produces useful child evidence.

## 9. Metrics

Outcome:

- TAC `S_partial`
- full success rate
- env error rate
- wall-clock latency
- total tokens, with swarm double-counting fixed

OpenTasks adoption:

- root task graph read before first task action
- OpenTasks graph read count
- OpenTasks evidence write count
- OpenTasks verification write count
- number of distinct agents touching OpenTasks

Coordination quality:

- worker spawned count
- useful child result count
- child blocked count
- child had required capability
- coordinator consumed child evidence before mutation
- verifier ran after mutation
- redundant service probes
- duplicate mutation attempts

Pipeline health:

- raw swarm trace line count
- derived trajectory line count
- parsed tool-result error count
- failure taxonomy labels only on failed cells
- task-runtime token count separated from smoke/preflight token count

Native OpenTasks graph tool use is required for this arm. Swarm task tools such
as `task_list` and `task_output` may be useful for harness coordination, but do
not count as OpenTasks graph adoption.

## 10. V1 Static Smoke Contract

The first implementation should prove exactly one thing: a child worker can
produce useful TAC evidence, the coordinator consumes it before mutation, and the
result is visible in OpenTasks.

Run shape:

- task: `pm-update-plane-issue-from-gitlab-status`
- model: same model for coordinator, inspector, and verifier
- roles: coordinator + one `service_inspector`
- OpenTeams: precompiled/generated role prompt packets, not a native
  `--openteams-template` runtime yet
- swarm-dispatch: disabled
- child permission: `danger-full-access` plus no-mutation contract and mutation
  audit
- task content: mirrored into workspace or injected into every worker prompt
- OpenTasks: native graph tools must be visible to coordinator and child

Pass gate:

1. coordinator reads the seeded OpenTasks root task before first task action;
2. child receives full TAC task text;
3. child writes one evidence record matching the schema in section 6;
4. coordinator reads or cites that evidence before the first service mutation;
5. coordinator completes or attempts the mutation;
6. verifier or coordinator writes a final verification record;
7. TAC evaluator runs normally.

Non-goals for v1:

- dynamic OpenTeams template loading in swarm-harness;
- swarm-dispatch retries or continuation;
- heterogeneous verifier model;
- runtime stop-gate enforcement;
- proving benchmark lift.

## 11. Implementation Order

### Phase A - Measurement fixes

1. Fix success-cell failure taxonomy.
2. Fix swarm token double-counting.
3. Extend diagnostics to parse swarm lane events.
4. Preserve raw swarm trace alongside flattened trajectory.
5. Split smoke reports into `swarm-task` and `opentasks-graph` checks.

### Phase B - Static team contract smoke

1. Add a TAC OpenTeams template fixture.
2. Generate role prompts/loadouts for coordinator, inspector, API mapper, and
   verifier.
3. Mirror `/instruction/task.md` into the child-readable workspace or inject it
   into every worker prompt.
4. Spawn one inspector with bounded shell/API read capability.
5. Require structured child evidence and verify the coordinator consumes it.

### Phase C - OpenTasks-backed team state

1. Seed subtasks/evidence placeholders into OpenTasks before agent start.
2. Ensure each worker can read/write the shared OpenTasks graph.
3. Add evidence and verification record helpers if the raw MCP surface is too
   cumbersome for agents.
4. Add stop-gate evaluation to the TAC adapter metrics.

### Phase D - Dispatch integration

1. Wrap seeded OpenTasks tasks in a swarm-dispatch `TaskSource`.
2. Use swarm-harness as the `AgentRuntime`.
3. Add continuation/retry for blocked or failed children.
4. Emit dispatch lifecycle events into run artifacts.

### Phase E - Comparative TAC run

1. Re-run `pm-update-plane-issue-from-gitlab-status` across
   `stock`/`notes`/`opentasks`/`opentasks-team-contract`.
2. Expand to a small complex-task set only after productive-coordination
   metrics are nonzero.
3. Compare `S_partial`, latency, tokens, and useful coordination metrics.

## 12. Resolved Choices

| Question | Decision |
|---|---|
| First proof target | Useful child evidence consumed before mutation, not full benchmark lift. |
| Product boundary | `opentasks-team-contract` is a full-ecosystem experimental arm; plain `opentasks` remains the product baseline. |
| First stop-gate location | TAC adapter metrics, not swarm-harness core. |
| OpenTeams integration v1 | Precompile/generate role packets first; native runtime loading later. |
| Child permissions v1 | `danger-full-access` plus no-mutation contract and audit; bounded-read mode later. |
| Child task content | Every child receives full TAC task text or a readable mirrored file. |
| OpenTasks adoption | Native `mcp__opentasks__*` graph tools are required; swarm task tools are not enough. |
| Verifier model v1 | Same model as coordinator to avoid adding a variable. |
| swarm-dispatch timing | After static team contract works. |

## 13. Decision Rules

Scale this arm only if:

- TAC outcome is at least parity with `opentasks` or `stock` on the same task
  class;
- token overhead is explainable by useful child work, not smoke/preflight or
  parser double-counting;
- OpenTasks graph adoption is nonzero from at least two agents;
- stop-gate passes without relying on self-reported coordination.

Do not scale if:

- child workers remain unable to read task content or inspect services;
- OpenTasks remains hidden behind only swarm `task_list`;
- the coordinator solves solo and merely records a decorative delegation;
- failure taxonomy or token accounting is still known-bad.

## 14. Remaining Open Questions

1. Should evidence writes use raw OpenTasks `annotate`/`update_task`, or a new
   benchmark helper that writes a standard evidence record?
2. Should `verifies` become a first-class OpenTasks edge type before the first
   TAC team-contract run, or should v1 use metadata conventions?
3. Should the OpenTasks MCP surface expose a higher-level `record_evidence`
   helper to reduce prompt/tool friction?
4. What mutation audit is sufficient to verify child inspectors obeyed their
   no-mutation contract?
5. Which second TAC task should be added after the Plane/GitLab smoke passes?

## 15. Relationship To Existing Designs

- This is an E2 extension, not a replacement for the baseline TAC RCT.
- It is complementary to the CooperBench coordination design: CooperBench tests
  conflict-heavy collaborative coding; this TAC arm tests digital-office tasks
  with service state and cross-application verification.
- It implements the same general lesson as the swarm-harness adaptive
  orchestration design: multi-agent work must earn its cost through
  heterogeneity, parallelism, or independent verification.
- It keeps OpenTasks within its intended role: durable task/spec/evidence graph,
  not runtime scheduler or benchmark scorer.
