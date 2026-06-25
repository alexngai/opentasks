import {
  parseClaudeStream,
  type TokenUsage,
  type TraceEvent,
} from 'swarmkit-eval';

export const TAC_BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
export const DEFAULT_SWARM_HARNESS_VERSION = '0.3.5';

export type TacAgentHarnessId = 'claude-code' | 'swarm-harness';

const SUPPORTED_TAC_AGENT_HARNESSES = 'claude-code, swarm-harness';

export interface TacParsedAgentStream {
  output: string;
  isError: boolean;
  sawResult: boolean;
  usage: TokenUsage;
  trajectory: TraceEvent[];
  mcpServers: { name: string; status: string }[];
}

export interface TacAgentCommandSpec {
  prompt: string;
  model: string;
  runDir: string;
  tools: string[];
  allowedTools: boolean;
  strictMcpConfig: boolean;
  includeSystemPrompt?: string;
}

export interface TacAgentHarness {
  id: TacAgentHarnessId | string;
  setupCommand(): string;
  buildCommand(spec: TacAgentCommandSpec): string;
  parse(stdout: string, model: string): TacParsedAgentStream;
}

export function tacAgentHarnessFromId(id: string | undefined): TacAgentHarness {
  const normalized = normalizeTacAgentHarnessId(id);
  if (normalized === 'claude-code') return claudeCodeTacHarness();
  if (normalized === 'swarm-harness') return swarmHarnessTacHarness();
  throw new Error(`Unsupported TAC agent harness "${id}". Supported harnesses: ${SUPPORTED_TAC_AGENT_HARNESSES}`);
}

export function normalizeTacAgentHarnessId(id: string | undefined): TacAgentHarnessId {
  const value = (id ?? 'claude-code').trim();
  if (!value || value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'swarm' || value === 'swarm-coder' || value === 'swarm-harness') return 'swarm-harness';
  throw new Error(`Unsupported TAC agent harness "${id}". Supported harnesses: ${SUPPORTED_TAC_AGENT_HARNESSES}`);
}

export function claudeCodeTacHarness(): TacAgentHarness {
  return {
    id: 'claude-code',
    setupCommand() {
      return 'npm install -g @anthropic-ai/claude-code';
    },
    buildCommand(spec) {
      const parts = [
        'claude',
        '-p',
        spec.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        shq(spec.model),
        '--permission-mode',
        'bypassPermissions',
        '--mcp-config',
        shq(`/eval/${spec.runDir}/mcp.json`),
      ];
      if (spec.allowedTools) parts.push('--allowed-tools', shq(spec.tools.join(' ')));
      if (spec.strictMcpConfig) parts.push('--strict-mcp-config');
      if (spec.includeSystemPrompt) parts.push('--append-system-prompt', `"$(cat ${shq(spec.includeSystemPrompt)})"`);
      return parts.join(' ');
    },
    parse(stdout, model) {
      return parseClaudeStream(stdout, model);
    },
  };
}

export function swarmHarnessTacHarness(): TacAgentHarness {
  return {
    id: 'swarm-harness',
    setupCommand() {
      return `npm install -g swarm-harness@\${TAC_SWARM_HARNESS_VERSION:-${DEFAULT_SWARM_HARNESS_VERSION}}`;
    },
    buildCommand(spec) {
      const promptPath = `/eval/${spec.runDir}/prompt.txt`;
      const mcpConfigPath = `/eval/${spec.runDir}/mcp.json`;
      const effectivePromptPath = spec.includeSystemPrompt ? `/eval/${spec.runDir}/swarm-harness-prompt.txt` : promptPath;
      let promptArg = spec.prompt;
      const prelude = [
        'mkdir -p .swarm-harness',
        `cp ${shq(mcpConfigPath)} .swarm-harness/mcp.json`,
      ];
      if (spec.includeSystemPrompt) {
        const defaultPromptArg = `"$(cat /eval/${spec.runDir}/prompt.txt)"`;
        const promptSource =
          spec.prompt === defaultPromptArg ? `cat ${shq(promptPath)}` : `printf '%s' ${spec.prompt}`;
        prelude.push(
          `{ cat ${shq(spec.includeSystemPrompt)}; printf '\\n\\n'; ${promptSource}; } > ${shq(effectivePromptPath)}`,
        );
        promptArg = `"$(cat ${shq(effectivePromptPath)})"`;
      }
      const command = [
        'swarm-harness',
        '--single',
        '--headless',
        '--output-format',
        'json',
        '--model',
        shq(spec.model),
        '--permission-mode',
        'danger-full-access',
        promptArg,
      ];
      return `${prelude.join(' && ')} && ${command.join(' ')}`;
    },
    parse(stdout) {
      return parseSwarmHarnessJsonl(stdout);
    },
  };
}

export function parseSwarmHarnessJsonl(stdout: string): TacParsedAgentStream {
  let output = '';
  let isError = false;
  let sawResult = false;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 };
  const trajectory: TraceEvent[] = [];
  const openTools = new Map<string, { event: TraceEvent; json: string }>();

  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === 'text_delta' && typeof obj.text === 'string') {
      output += obj.text;
      continue;
    }
    if (obj.type === 'tool_use_start') {
      const id = typeof obj.id === 'string' ? obj.id : `tool-${trajectory.length}`;
      const name = canonicalSwarmToolName(typeof obj.name === 'string' ? obj.name : 'tool');
      const event: TraceEvent = { type: 'tool', ts: trajectory.length, name };
      trajectory.push(event);
      openTools.set(id, { event, json: '' });
      continue;
    }
    if (obj.type === 'tool_use_input') {
      const id = typeof obj.id === 'string' ? obj.id : '';
      const open = openTools.get(id);
      if (open && typeof obj.jsonDelta === 'string') open.json += obj.jsonDelta;
      continue;
    }
    if (obj.type === 'tool_use_end') {
      const id = typeof obj.id === 'string' ? obj.id : '';
      const open = openTools.get(id);
      if (open) {
        const input = isRecord(obj.input) ? obj.input : parseJsonObject(open.json);
        if (input) open.event.input = input;
        openTools.delete(id);
      }
      continue;
    }
    if (obj.type === 'tool_result') continue;
    if (obj.type === 'error') {
      isError = true;
      continue;
    }
    if (obj.type === 'message_stop') {
      sawResult = true;
      const u = isRecord(obj.usage) ? obj.usage : {};
      usage.inputTokens = (usage.inputTokens ?? 0) + numberValue(u.inputTokens);
      usage.outputTokens = (usage.outputTokens ?? 0) + numberValue(u.outputTokens);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + numberValue(u.cacheReadInputTokens);
      usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + numberValue(u.cacheWriteInputTokens);
    }
  }

  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  return { output: output.slice(0, 4000), usage, trajectory, isError, mcpServers: [], sawResult };
}

function canonicalSwarmToolName(name: string): string {
  const map: Record<string, string> = {
    bash: 'Bash',
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    multi_edit: 'Edit',
    glob: 'Glob',
    grep: 'Grep',
    tool_search: 'ToolSearch',
    skill: 'Skill',
  };
  return map[name] ?? name;
}

function parseJsonObject(json: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function tacAgentHarnessInstallCommand(id: string | undefined): string {
  return tacAgentHarnessFromId(id).setupCommand();
}

export function tacDefaultAgentSetupCommand(idOrHarness: string | undefined | TacAgentHarness, agentUser: string | undefined): string {
  const harness = typeof idOrHarness === 'object' ? idOrHarness : tacAgentHarnessFromId(idOrHarness);
  return [
    'set -e',
    node22SetupCommand(),
    harness.setupCommand(),
    agentUserSetupCommand(agentUser),
  ].filter((part) => part.trim()).join('; ');
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function node22SetupCommand(): string {
  const nodeMajorCheck = 'node -e "process.exit(Number(process.versions.node.split(\'.\')[0]) >= 22 ? 0 : 1)"';
  return [
    `if ! command -v node >/dev/null 2>&1 || ! ${nodeMajorCheck}; then`,
    'apt-get update',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg git',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs',
    'else',
    'command -v git >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git)',
    'fi',
  ].join('\n');
}

function agentUserSetupCommand(agentUser: string | undefined): string {
  if (!agentUser) return '';
  const user = shq(agentUser);
  return [
    `id -u ${user} >/dev/null 2>&1 || useradd -m -s /bin/sh ${user}`,
    `chown -R ${user}:${user} /workspace /eval`,
  ].join('; ');
}
