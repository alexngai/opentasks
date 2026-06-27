import type { TraceEvent } from 'swarmkit-eval';

export const TAC_TEAM_CONTRACT_ARM_ID = 'opentasks-team-contract';

export const TAC_SERVICE_SYNC_TEAM = {
  name: 'tac-service-sync',
  version: 1,
  roles: ['coordinator', 'service_inspector', 'api_mapper', 'verifier'],
  topology: {
    root: { role: 'coordinator' },
    spawnRules: {
      coordinator: ['service_inspector', 'api_mapper', 'verifier'],
      service_inspector: [],
      api_mapper: [],
      verifier: [],
    },
  },
  communication: {
    enforcement: 'audit',
    channels: {
      evidence: { signals: ['EVIDENCE_FOUND', 'BLOCKED', 'VERIFIED'] },
      decisions: { signals: ['DECISION_PROPOSED', 'DECISION_ACCEPTED', 'DECISION_REJECTED'] },
    },
  },
} as const;

export const TAC_TEAM_CONTRACT_EVIDENCE_SCHEMA = {
  role: 'service_inspector',
  task_id: 'service_inspection',
  status: 'pass',
  evidence: [
    {
      kind: 'api',
      target: 'GET /projects/root/example/issues?state=all',
      summary: 'Concise factual service-state finding.',
    },
  ],
  commands_or_endpoints: ['tac-gitlab-api GET projects/root/example/issues?state=all'],
  confidence: 'high',
  blockers: [],
} as const;

export interface TacTeamContractPacketOptions {
  sourceTaskId: string;
  taskText: string;
  seededRootTaskId?: string;
}

export function isTacTeamContractArm(armId: string | undefined): boolean {
  return armId === TAC_TEAM_CONTRACT_ARM_ID;
}

export function buildTacTeamContractPacket(opts: TacTeamContractPacketOptions): string {
  const rootTaskLine = opts.seededRootTaskId
    ? `Seeded OpenTasks root task id: ${opts.seededRootTaskId}`
    : 'Seeded OpenTasks root task id: pending graph seed';
  return [
    '# TAC Team Contract Packet',
    '',
    `Template: ${TAC_SERVICE_SYNC_TEAM.name}@${TAC_SERVICE_SYNC_TEAM.version}`,
    `Source TAC task id: ${opts.sourceTaskId}`,
    rootTaskLine,
    '',
    'Coordinator contract:',
    '- Read the seeded OpenTasks root task before task-specific service work.',
    '- Delegate service-state discovery to a service_inspector when the task requires external service inspection.',
    '- Do not perform service mutation until useful child evidence exists or the evidence task is explicitly blocked.',
    '- Record the accepted decision and final verification evidence in OpenTasks.',
    '',
    'service_inspector contract:',
    '- Read this full TAC task text from the packet or mirrored file.',
    '- Use bounded shell/API reads such as tac-gitlab-api, curl GET, or Python requests.',
    '- Do not mutate service state.',
    '- Return one structured evidence JSON object matching the schema below.',
    '',
    'Required evidence JSON schema:',
    '```json',
    JSON.stringify(TAC_TEAM_CONTRACT_EVIDENCE_SCHEMA, null, 2),
    '```',
    '',
    'Stop-gate signals for the post-run TAC metric pass:',
    '- at least one child worker is spawned;',
    '- child evidence is written or a blocker is recorded;',
    '- coordinator consumes child evidence before first service mutation;',
    '- final verification evidence is written.',
    '',
    'Full TAC task text mirrored for every worker:',
    '```text',
    opts.taskText.trim(),
    '```',
  ].join('\n');
}

export function tacTeamContractMetrics(trajectory: TraceEvent[]): Record<string, number> {
  const toolEvents = trajectory.filter((event) => event.type === 'tool');
  const agentIds = new Set<string>();
  let openTasksGraphCallCount = 0;
  let openTasksEvidenceWriteCount = 0;
  let openTasksVerificationWriteCount = 0;
  let firstEvidenceIndex = -1;
  let firstVerificationIndex = -1;
  let firstMutationIndex = -1;

  toolEvents.forEach((event, index) => {
    const input = isRecord(event.input) ? event.input : {};
    const agentId = typeof input.agentId === 'string' ? input.agentId : undefined;
    if (agentId) agentIds.add(agentId);

    if (event.name.startsWith('mcp__opentasks__')) {
      openTasksGraphCallCount += 1;
      const text = JSON.stringify(input).toLowerCase();
      const isWrite = event.name === 'mcp__opentasks__record_attempt' || event.name === 'mcp__opentasks__update_task';
      if (isWrite && /evidence|service_inspection|commands_or_endpoints/.test(text)) {
        openTasksEvidenceWriteCount += 1;
        if (firstEvidenceIndex < 0) firstEvidenceIndex = index;
      }
      if (isWrite && /verification|verified|verifies/.test(text)) {
        openTasksVerificationWriteCount += 1;
        if (firstVerificationIndex < 0) firstVerificationIndex = index;
      }
    }

    if (firstMutationIndex < 0 && event.name === 'Bash' && isServiceMutationCommand(String(input.command ?? ''))) {
      firstMutationIndex = index;
    }
  });

  const distinctAgentCount = agentIds.size;
  const workerSpawned = distinctAgentCount > 1 ? 1 : 0;
  const childEvidenceWritten = openTasksEvidenceWriteCount > 0 ? 1 : 0;
  const verificationWritten = openTasksVerificationWriteCount > 0 ? 1 : 0;
  const evidenceBeforeMutation =
    firstEvidenceIndex >= 0 && (firstMutationIndex < 0 || firstEvidenceIndex < firstMutationIndex) ? 1 : 0;
  const verificationAfterMutation =
    firstVerificationIndex >= 0 && firstMutationIndex >= 0 && firstVerificationIndex > firstMutationIndex ? 1 : 0;
  const productiveCoordination =
    workerSpawned && childEvidenceWritten && evidenceBeforeMutation && verificationWritten ? 1 : 0;

  return {
    teamContractDistinctAgentCount: distinctAgentCount,
    teamContractWorkerSpawned: workerSpawned,
    teamContractOpenTasksGraphCallCount: openTasksGraphCallCount,
    teamContractEvidenceWriteCount: openTasksEvidenceWriteCount,
    teamContractChildEvidenceWritten: childEvidenceWritten,
    teamContractCoordinatorConsumedEvidenceBeforeMutation: evidenceBeforeMutation,
    teamContractVerificationWriteCount: openTasksVerificationWriteCount,
    teamContractVerificationWritten: verificationWritten,
    teamContractVerificationAfterMutation: verificationAfterMutation,
    teamContractProductiveCoordination: productiveCoordination,
    teamContractStopGatePassed: productiveCoordination,
  };
}

function isServiceMutationCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/\btac-gitlab-api\s+(POST|PUT|PATCH|DELETE)\b/i.test(command)) return true;
  if (/\bcurl\b/i.test(command) && /\b-X\s*(POST|PUT|PATCH|DELETE)\b/i.test(command)) return true;
  if (/\btac-gitlab-protect-branch\b/.test(command)) return true;
  if (/\bgit\s+push\b/.test(command)) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
