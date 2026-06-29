# TAC Dispatch Carrier Follow-Up (2026-06-29)

**Status:** gated follow-up design; dispatch implementation deferred.
**Extends:** [TAC OpenTeams Team Contract Design](./2026-06-26-tac-openteams-team-contract-design.md).
**Scope:** define how `swarm-dispatch` should carry the TAC team protocol once
the static `swarm-harness` protocol is behaviorally adopted.

## 1. Live V1 Evidence

Two live TAC cells ran with:

- `TAC_AGENT_HARNESS=swarm-harness`
- `TAC_SWARM_HARNESS_VERSION=0.3.5`
- `TAC_TEAM_PROTOCOL=agent-inbox-v1`
- `EVAL_MODEL=azureoai/gpt-5.5`
- `EVAL_ARMS=opentasks-team-contract`

| Run | Task | TAC result | Tokens | Env error | Team result | Inbox protocol |
|---|---|---:|---:|---:|---|---|
| `tac-team-protocol-smoke-2026-06-29T13-20Z` | `pm-update-plane-issue-from-gitlab-status` | `7/7`, full success | `92,986` | `0` | spawned team, durable evidence and verification records | `teamProtocolPassed=0`; assignment/reply counters all `0` |
| `tac-team-protocol-hard-2026-06-29T13-45Z` | `pm-update-gitlab-issue-from-plane-status` | `2/3`, failure | `67,276` | `0` | spawned team, durable evidence and verification records | `teamProtocolPassed=0`; assignment/reply counters all `0` |

The implementation proved that role packets, helper-based OpenTasks evidence,
summary metrics, and full TAC cleanup work. It did not prove the `agent-inbox`
assignment/reply protocol. In both runs, `teamProtocolAgentInboxEnabled=1` but
`teamInboxAssignmentCount`, `teamInboxEvidenceReplyCount`,
`teamInboxVerifierRequestCount`, and `teamInboxVerifierReplyCount` stayed `0`.

## 2. Dispatch Gate

Do not add `swarm-dispatch` as the runtime carrier yet.

Dispatch should carry a working team protocol; it should not compensate for a
protocol that currently depends on prompt text and spawned-worker final output.
The next dispatch step is therefore a design and fixture layer, not a live TAC
carrier.

The gate to begin dispatch implementation is one of:

- at least one live TAC cell with `teamProtocolPassed=1`; or
- a local fixture that proves dispatch can force explicit assignment, reply,
  evidence, verification, and durable OpenTasks writes while preserving the same
  protocol metrics.

## 3. Diagnosed Blockers

### Inbox Is Not Behaviorally Adopted

The prompt packets asked for an `agent-inbox-v1` flow, but observed traces used
spawned workers and coordinator-consumed worker output. No observed
`message_sent`, `send_message`, or `check_inbox` protocol sequence reached the
metric gate.

Dispatch must therefore be introduced only where it can make assignment and
reply explicit lifecycle events, not as another prompt paragraph.

### Native Role Enforcement Is Still Absent

Both live cells reported `teamProtocolNativeRoleEnforcement=0`. Roles were
prompt-packet enforced. That is acceptable for static V1 measurement, but a
dispatch carrier must make the runtime handoff role-aware enough for artifacts
to show which role claimed which task and which runtime handled it.

### Plane-State Evidence Needs A Better Adapter Contract

The known-hard retry failed because the team read Plane through
`tac-plane-api`, concluded both target issues were open, and made no GitLab
write. TAC's checkpoint for that task expects `Model: security problem` to be
closed in GitLab. Before scaling dispatch, the TAC helper contract needs a
clear way to expose the benchmark-relevant Plane status for this task class, or
the runbook must require page-level Plane inspection when helper output and the
TAC task expectation disagree.

## 4. Carrier Design

The dispatch carrier should preserve the same `agent-inbox-v1` envelope:

```text
OpenTasks seeded node
  -> swarm-dispatch claim
  -> swarm-harness role runtime
  -> explicit assignment/reply event
  -> durable OpenTasks evidence record
  -> coordinator decision
  -> verifier reply
  -> durable OpenTasks verification record
```

### OpenTasks TaskSource Mapping

`swarm-dispatch` should read seeded TAC team nodes from OpenTasks:

| OpenTasks node | Dispatch role | Runtime packet | Required result |
|---|---|---|---|
| root TAC task | `coordinator` | coordinator packet | assignment, decision, final answer |
| `service_inspection` | `service_inspector` | inspector packet | `TEAM_EVIDENCE` plus durable graph record id |
| `mutation_plan` | `coordinator` | coordinator packet | accepted decision before service write |
| `verification` | `verifier` | verifier packet | `TEAM_VERIFICATION` plus durable graph record id |

The TaskSource must include:

- stable OpenTasks task id;
- role slug;
- capability set;
- `correlation_id`;
- parent/root TAC cell id;
- retry/continuation metadata;
- last durable evidence or blocker pointer.

### AgentRuntime Handoff

The dispatch `AgentRuntime` should invoke `swarm-harness` with a single role
packet and task payload. It should not ask one coordinator prompt to remember
every routing rule.

Minimum handoff payload:

```json
{
  "protocol": "agent-inbox-v1",
  "cell_key": "<tac cell key>",
  "correlation_id": "tac-service-sync:<cell>:<role-step>",
  "role": "service_inspector",
  "opentasks_task_id": "t-...",
  "root_task_id": "t-...",
  "capabilities": ["task-read", "service-read", "graph-evidence"],
  "packet_path": "/eval/team-roles/service_inspector.md",
  "evidence_target": "/workspace/.opentasks"
}
```

The runtime result must include either a durable OpenTasks record id or a
structured blocker. Local swarm task output alone is not sufficient.

### Lifecycle Artifacts

Each TAC cell should archive:

- `dispatch-manifest.json`
- `dispatch-claims.jsonl`
- `dispatch-lifecycle.jsonl`
- `dispatch-runtime-handoffs.jsonl`
- `dispatch-opentasks-records.jsonl`
- raw `swarm-harness` stream
- existing TAC `summary.json` and report artifacts

The summary extractor should keep TAC score, team protocol score, and dispatch
lifecycle score separate.

## 5. First Dispatch Fixture

Before a live TAC dispatch run, add a local fixture with:

1. a fake OpenTasks TaskSource containing the root, inspection, mutation, and
   verification nodes;
2. a fake `swarm-harness` AgentRuntime that emits assignment, evidence reply,
   decision, verifier reply, and durable record ids;
3. a negative case where the runtime emits only local task output;
4. a negative case where the inspector replies after mutation;
5. a negative case where dispatch retries a stale claim and preserves the same
   `correlation_id`.

Acceptance:

- positive fixture yields `teamProtocolPassed=1`;
- negative fixtures keep `teamProtocolPassed=0`;
- dispatch lifecycle metrics do not alter TAC score fields;
- every durable evidence pass includes an OpenTasks record id.

## 6. Live Dispatch Smoke Shape

Only after the fixture or static harness gate passes, run one live TAC cell:

```bash
TAC_AGENT_HARNESS=swarm-harness \
TAC_SWARM_HARNESS_VERSION=0.3.5 \
TAC_TEAM_PROTOCOL=agent-inbox-v1 \
TAC_DISPATCH_CARRIER=1 \
EVAL_MODEL=azureoai/gpt-5.5 \
EVAL_ARMS=opentasks-team-contract \
EVAL_TASKS=pm-update-plane-issue-from-gitlab-status \
EVAL_SEEDS=1 \
TAC_POOL_WORKER_COUNT=1 \
TAC_POOL_MAX_WORKERS=1 \
TAC_POOL_INSTANCE_TYPE=m7i.2xlarge \
TAC_CELL_TIMEOUT_SEC=2400 \
evals/tac/scripts/run-ec2-pool.sh
```

The first live dispatch run should pass or fail on protocol observability, not
TAC score:

- `teamInboxAssignmentCount > 0`
- `teamInboxEvidenceReplyCount > 0`
- `teamOpenTasksEvidenceAfterInbox=1`
- `teamInboxVerifierReplyCount > 0`
- `teamOpenTasksVerificationAfterVerifier=1`
- cleanup verification passes

## 7. Non-Goals

- Do not compare dispatch against baseline arms until protocol metrics pass.
- Do not make OpenTasks score influence TAC score.
- Do not add OpenHive in the first dispatch fixture.
- Do not add multiple seeds before one dispatch cell has interpretable protocol
  evidence.

## 8. Next Work

1. Make static `swarm-harness` runs produce explicit inbox assignment/reply
   events, or document that dispatch will be the first component to force them.
2. Add the local dispatch carrier fixture before live TAC carrier wiring.
3. Improve the Plane helper/page-inspection contract for `pm-update-*` tasks.
4. Add dispatch lifecycle fields to the summary extractor only after the fixture
   format is stable.
