import type { TraceEvent } from 'swarmkit-eval';

export const TAC_TEAM_CONTRACT_ARM_ID = 'opentasks-team-contract';
export const TAC_TEAM_PROTOCOL_ID = 'agent-inbox-v1';

export const TAC_TEAM_PROTOCOL_MARKERS = {
  assignment: 'TEAM_ASSIGNMENT',
  evidence: 'TEAM_EVIDENCE',
  decision: 'TEAM_DECISION',
  verificationRequest: 'TEAM_VERIFICATION_REQUEST',
  verification: 'TEAM_VERIFICATION',
} as const;

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
  protocol: TAC_TEAM_PROTOCOL_ID,
  correlation_id: 'tac-service-sync:<cell>:<step>',
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
  commands_or_endpoints: ['tac-gitlab-api GET projects/root/example/issues?state=all', 'tac-plane-api GET workspaces/tac/projects/example/issues/?expand=state'],
  confidence: 'high',
  blockers: [],
  opentasks_record_id: 'optional durable graph record id',
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
    '- Read the seeded OpenTasks root task before task-specific service work when direct mcp__opentasks__ tools are available.',
    '- In swarm-harness team mode, first call task_list({}) and use the returned running task id for task_get/task_update as the local swarm coordination log.',
    '- Durable OpenTasks evidence requires a successful direct mcp__opentasks__record_attempt/update_task call, or a verified OpenTasks helper/graph artifact with a durable record id. Local swarm task_update(output:"...") alone is not durable OpenTasks evidence.',
    '- If native OpenTasks MCP writes are unavailable but Bash is available, persist the same evidence with tac-opentasks-record-evidence ROLE CORRELATION_ID JSON_PAYLOAD [SEEDED_ROOT_TASK_ID] and keep its JSON output containing opentasks_record_id.',
    '- Do not assume tac-root or the seeded OpenTasks id is the swarm task registry id unless task_list returns that exact id. If task_list returns no usable task, call task_create to create a coordination log and update that returned id.',
    '- Delegate service-state discovery to a service_inspector when the task requires external service inspection.',
    '- If the service_inspector needs shell/API reads, spawn it with permissionMode:"danger-full-access" and instruct it not to mutate service state.',
    '- Do not perform service mutation until useful child evidence exists or the evidence task is explicitly blocked.',
    `- Before first service mutation, send/record ${TAC_TEAM_PROTOCOL_MARKERS.evidence} or BLOCKED with the protocol correlation_id, then persist durable evidence through direct OpenTasks MCP or a verified helper/graph artifact.`,
    `- After final verification, send/record ${TAC_TEAM_PROTOCOL_MARKERS.verification} with the protocol correlation_id, then persist durable verification through direct OpenTasks MCP or a verified helper/graph artifact.`,
    '',
    'service_inspector contract:',
    '- Read this full TAC task text from the packet or mirrored file.',
    '- Use bounded shell/API reads such as tac-gitlab-api, tac-plane-api, curl GET, or Python requests.',
    '- Prefer tac-plane-api for Plane reads/writes; it loads /utils/config.py credentials and avoids unauthenticated Plane endpoint probes.',
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
    '- child evidence is written through direct OpenTasks MCP or a verified OpenTasks helper/graph artifact;',
    '- coordinator records/consumes child evidence before first service mutation;',
    '- final verification evidence is written through direct OpenTasks MCP or a verified OpenTasks helper/graph artifact.',
    '',
    'Full TAC task text mirrored for every worker:',
    '```text',
    opts.taskText.trim(),
    '```',
  ].join('\n');
}

export function tacTeamContractMetrics(trajectory: TraceEvent[]): Record<string, number> {
  const agentIds = new Set<string>();
  let openTasksGraphCallCount = 0;
  let openTasksEvidenceWriteCount = 0;
  let openTasksVerificationWriteCount = 0;
  let failedOpenTasksGraphWriteCount = 0;
  let inboxAssignmentCount = 0;
  let inboxEvidenceReplyCount = 0;
  let inboxVerifierRequestCount = 0;
  let inboxVerifierReplyCount = 0;
  let firstInboxAssignmentIndex = -1;
  let firstInboxEvidenceIndex = -1;
  let firstInboxVerifierRequestIndex = -1;
  let firstInboxVerifierReplyIndex = -1;
  let firstEvidenceIndex = -1;
  let firstVerificationIndex = -1;
  let firstMutationIndex = -1;

  trajectory.forEach((event, index) => {
    if (event.type === 'message') {
      if (event.from) agentIds.add(event.from);
      if (event.to) agentIds.add(event.to);
      recordInboxProtocolSignals(event.content ?? '', index);
      return;
    }
    if (event.type !== 'tool') return;

    const input = isRecord(event.input) ? event.input : {};
    const agentId = typeof input.agentId === 'string' ? input.agentId : typeof event.agentId === 'string' ? event.agentId : undefined;
    if (agentId) agentIds.add(agentId);
    const command = String(input.command ?? '');

    recordInboxProtocolSignals(inboxProtocolToolText(event, input), index);

    if (isOpenTasksGraphTool(event.name)) {
      openTasksGraphCallCount += 1;
      const text = JSON.stringify(input).toLowerCase();
      const isWrite = isOpenTasksGraphWriteTool(event.name);
      if (isWrite && isFailedToolEvent(event)) {
        failedOpenTasksGraphWriteCount += 1;
        return;
      }
      const isVerificationWrite = isWrite && /verification|verified|verifies/.test(text);
      if (isVerificationWrite) {
        openTasksVerificationWriteCount += 1;
        if (firstVerificationIndex < 0) firstVerificationIndex = index;
      }
      if (isWrite && !isVerificationWrite && /evidence|service_inspection|commands_or_endpoints/.test(text)) {
        openTasksEvidenceWriteCount += 1;
        if (firstEvidenceIndex < 0) firstEvidenceIndex = index;
      }
    }

    if (isOpenTasksEvidenceHelperCommand(event.name, command)) {
      openTasksGraphCallCount += 1;
      if (isFailedToolEvent(event) || !hasDurableOpenTasksHelperRecord(event)) {
        failedOpenTasksGraphWriteCount += 1;
        return;
      }
      const text = `${command}\n${toolOutputText(event)}`.toLowerCase();
      const isVerificationWrite = /team_verification|verification|verified|verifier/.test(text);
      if (isVerificationWrite) {
        openTasksVerificationWriteCount += 1;
        if (firstVerificationIndex < 0) firstVerificationIndex = index;
      }
      if (!isVerificationWrite && /team_evidence|evidence|service_inspection|commands_or_endpoints|service_inspector/.test(text)) {
        openTasksEvidenceWriteCount += 1;
        if (firstEvidenceIndex < 0) firstEvidenceIndex = index;
      }
    }

    if (firstMutationIndex < 0 && event.name.toLowerCase() === 'bash' && isServiceMutationCommand(command)) {
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
    workerSpawned && childEvidenceWritten && evidenceBeforeMutation && verificationWritten && verificationAfterMutation ? 1 : 0;
  const inboxEvidenceBeforeMutation =
    firstInboxEvidenceIndex >= 0 && firstMutationIndex >= 0 && firstInboxEvidenceIndex < firstMutationIndex ? 1 : 0;
  const openTasksEvidenceAfterInbox =
    firstInboxEvidenceIndex >= 0 && firstEvidenceIndex >= 0 && firstEvidenceIndex > firstInboxEvidenceIndex ? 1 : 0;
  const openTasksVerificationAfterVerifier =
    firstInboxVerifierReplyIndex >= 0 && firstVerificationIndex >= 0 && firstVerificationIndex > firstInboxVerifierReplyIndex ? 1 : 0;
  const protocolPassed =
    workerSpawned &&
    firstInboxAssignmentIndex >= 0 &&
    inboxEvidenceBeforeMutation &&
    openTasksEvidenceAfterInbox &&
    firstInboxVerifierRequestIndex >= 0 &&
    firstInboxVerifierReplyIndex > firstMutationIndex &&
    openTasksVerificationAfterVerifier
      ? 1
      : 0;

  return {
    teamContractDistinctAgentCount: distinctAgentCount,
    teamContractWorkerSpawned: workerSpawned,
    teamContractOpenTasksGraphCallCount: openTasksGraphCallCount,
    teamContractEvidenceWriteCount: openTasksEvidenceWriteCount,
    teamContractFailedGraphWriteCount: failedOpenTasksGraphWriteCount,
    teamContractChildEvidenceWritten: childEvidenceWritten,
    teamContractCoordinatorConsumedEvidenceBeforeMutation: evidenceBeforeMutation,
    teamContractVerificationWriteCount: openTasksVerificationWriteCount,
    teamContractVerificationWritten: verificationWritten,
    teamContractVerificationAfterMutation: verificationAfterMutation,
    teamContractProductiveCoordination: productiveCoordination,
    teamContractStopGatePassed: productiveCoordination,
    teamInboxAssignmentCount: inboxAssignmentCount,
    teamInboxEvidenceReplyCount: inboxEvidenceReplyCount,
    teamInboxVerifierRequestCount: inboxVerifierRequestCount,
    teamInboxVerifierReplyCount: inboxVerifierReplyCount,
    teamInboxEvidenceBeforeMutation: inboxEvidenceBeforeMutation,
    teamOpenTasksEvidenceAfterInbox: openTasksEvidenceAfterInbox,
    teamOpenTasksVerificationAfterVerifier: openTasksVerificationAfterVerifier,
    teamProtocolPassed: protocolPassed,
  };

  function recordInboxProtocolSignals(text: string, index: number): void {
    if (!text.trim()) return;
    if (hasProtocolMarker(text, TAC_TEAM_PROTOCOL_MARKERS.assignment)) {
      inboxAssignmentCount += 1;
      if (firstInboxAssignmentIndex < 0) firstInboxAssignmentIndex = index;
    }
    if (hasProtocolMarker(text, TAC_TEAM_PROTOCOL_MARKERS.evidence)) {
      inboxEvidenceReplyCount += 1;
      if (firstInboxEvidenceIndex < 0) firstInboxEvidenceIndex = index;
    }
    if (hasProtocolMarker(text, TAC_TEAM_PROTOCOL_MARKERS.verificationRequest)) {
      inboxVerifierRequestCount += 1;
      if (firstInboxVerifierRequestIndex < 0) firstInboxVerifierRequestIndex = index;
    }
    if (hasProtocolMarker(text, TAC_TEAM_PROTOCOL_MARKERS.verification)) {
      inboxVerifierReplyCount += 1;
      if (firstInboxVerifierReplyIndex < 0) firstInboxVerifierReplyIndex = index;
    }
  }
}

function isServiceMutationCommand(command: string): boolean {
  if (!command.trim()) return false;
  if (/\btac-gitlab-api\s+(POST|PUT|PATCH|DELETE)\b/i.test(command)) return true;
  if (/\bcurl\b/i.test(command) && /(?:^|\s)(?:-X|--request)\s*(POST|PUT|PATCH|DELETE)\b/i.test(command)) return true;
  if (/\brequests\.(post|put|patch|delete)\s*\(/i.test(command)) return true;
  if (/\brequests\.request\s*\([^,\n]+,\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(command)) return true;
  if (/\burllib\.request\.Request\s*\([^)]*\bmethod\s*=\s*['"](POST|PUT|PATCH|DELETE)['"]/is.test(command)) return true;
  if (/\b(req|request)\s*\(\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(command)) return true;
  if (/\btac-gitlab-protect-branch\b/.test(command)) return true;
  if (/\bgit\s+push\b/.test(command)) return true;
  return false;
}

function isOpenTasksGraphTool(name: string): boolean {
  return name.startsWith('mcp__opentasks__');
}

function isOpenTasksGraphWriteTool(name: string): boolean {
  return name === 'mcp__opentasks__record_attempt' || name === 'mcp__opentasks__update_task';
}

function isOpenTasksEvidenceHelperCommand(name: string, command: string): boolean {
  return name.toLowerCase() === 'bash' && /\btac-opentasks-record-evidence\b/.test(command);
}

function inboxProtocolToolText(event: TraceEvent, input: Record<string, unknown>): string {
  const name = event.type === 'tool' ? event.name.toLowerCase() : '';
  if (name !== 'send_message' && name !== 'check_inbox') return '';
  return `${JSON.stringify(input)}\n${toolOutputText(event)}`;
}

function hasProtocolMarker(text: string, marker: string): boolean {
  return new RegExp(`\\b${escapeRegExp(marker)}\\b`, 'i').test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDurableOpenTasksHelperRecord(event: TraceEvent): boolean {
  const output = toolOutputText(event);
  if (!output.trim()) return false;
  return /"ok"\s*:\s*true/.test(output) && /"opentasks_record_id"\s*:\s*"[a-z]-[a-z0-9-]+"/i.test(output);
}

function toolOutputText(event: TraceEvent): string {
  const output = (event as TraceEvent & { output?: unknown }).output;
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function isFailedToolEvent(event: TraceEvent): boolean {
  const record = event as TraceEvent & { isError?: unknown; is_error?: unknown; success?: unknown };
  if (record.isError === true || record.is_error === true) return true;
  if (record.success === false) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
