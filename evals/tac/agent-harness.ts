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
      const tasksPath = `/eval/${spec.runDir}/swarm-harness-tasks.jsonl`;
      const resultsPath = `/eval/${spec.runDir}/swarm-harness-results.jsonl`;
      const tracePath = `/eval/${spec.runDir}/swarm-harness-trace.jsonl`;
      const deadLetterPath = `/eval/${spec.runDir}/swarm-harness-dead-letter.jsonl`;
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
      const singleCommand = [
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
      const swarmTaskPrelude = [
        `rm -f ${shq(resultsPath)} ${shq(tracePath)} ${shq(deadLetterPath)} ${shq(tasksPath)}`,
        `node -e ${shq([
          'const fs = require("fs");',
          'const [promptPath, tasksPath, model] = process.argv.slice(1);',
          'let prompt = fs.readFileSync(promptPath, "utf8");',
          'const prefix = process.env.TAC_SWARM_HARNESS_MULTIAGENT_PROMPT || "";',
          'if (prefix) prompt = `${prefix.trimEnd()}\\n\\n${prompt}`;',
          'const task = {',
          '  id: "tac-root",',
          '  model,',
          '  prompt,',
          '  branchPolicy: { kind: "none" },',
          '  commitPolicy: { kind: "none" },',
          '  escalationPolicy: { kind: "none" },',
          '};',
          'fs.writeFileSync(tasksPath, `${JSON.stringify(task)}\\n`);',
        ].join(' '))} ${shq(effectivePromptPath)} ${shq(tasksPath)} ${shq(spec.model)}`,
      ];
      const swarmCommand = [
        'swarm-harness',
        'swarm',
        'run',
        shq(tasksPath),
        '--concurrency',
        '"${TAC_SWARM_HARNESS_CONCURRENCY:-3}"',
        '--output',
        shq(resultsPath),
        '--trace-output',
        shq(tracePath),
        '--dead-letter',
        shq(deadLetterPath),
        '--allow-dead-letter',
        '--agent-inbox',
        '--model',
        shq(spec.model),
        '--permission-mode',
        'danger-full-access',
      ];
      const swarmCommandWithOptionalOpenTasks = [
        `swarm_cmd=${shq(swarmCommand.join(' '))}`,
        'if [ "${TAC_SWARM_HARNESS_OPENTASKS:-0}" = "1" ]; then',
        '  swarm_cmd="$swarm_cmd --opentasks --opentasks-socket ${OPENTASKS_PROJECT_DIR:-/workspace/.opentasks}/daemon.sock"',
        'fi',
        'eval "$swarm_cmd"',
      ].join('\n');
      const swarmModeCommand = [
        'set +e',
        `export SWARM_HARNESS_MODEL=${shq(spec.model)}`,
        swarmCommandWithOptionalOpenTasks,
        'swarm_status=$?',
        `cat ${shq(tracePath)} 2>/dev/null || true`,
        `cat ${shq(resultsPath)} 2>/dev/null || true`,
        'exit "$swarm_status"',
      ].join('; ');
      const modeSwitch = [
        'case "${TAC_SWARM_HARNESS_MODE:-single}" in',
        `  swarm|swarm-run|multi|multi-agent) ${swarmTaskPrelude.join(' && ')} && ${swarmModeCommand} ;;`,
        `  team|team-contract|opentasks-team-contract) ${swarmTaskPrelude.join(' && ')} && ${swarmModeCommand} ;;`,
        `  single|"") ${singleCommand.join(' ')} ;;`,
        '  *) echo "Unsupported TAC_SWARM_HARNESS_MODE=${TAC_SWARM_HARNESS_MODE}" >&2; exit 2 ;;',
        'esac',
      ].join('\n');
      return `${prelude.join(' && ')} && ${modeSwitch}`;
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
  const openTools = new Map<string, { event: TraceEvent; json: string; meta: Record<string, unknown> }>();
  const toolEventsById = new Map<string, TraceEvent>();
  let sawMessageStopUsage = false;

  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }

    const event = swarmTraceEventPayload(obj);

    if (event.type === 'text_delta' && typeof event.text === 'string') {
      output += event.text;
      continue;
    }
    if (event.type === 'tool_use_start') {
      const id = typeof event.id === 'string' ? event.id : `tool-${trajectory.length}`;
      const rawName =
        typeof event.name === 'string'
          ? event.name
          : typeof event.toolName === 'string'
            ? event.toolName
            : 'tool';
      const meta = swarmTraceMeta(obj);
      const traceEvent: TraceEvent = { type: 'tool', ts: trajectory.length, name: canonicalSwarmToolName(rawName) };
      if (Object.keys(meta).length) traceEvent.input = meta;
      trajectory.push(traceEvent);
      openTools.set(id, { event: traceEvent, json: '', meta });
      toolEventsById.set(id, traceEvent);
      continue;
    }
    if (event.type === 'tool_use_input') {
      const id = typeof event.id === 'string' ? event.id : typeof event.toolUseId === 'string' ? event.toolUseId : '';
      const open = openTools.get(id);
      if (open && typeof event.jsonDelta === 'string') open.json += event.jsonDelta;
      continue;
    }
    if (event.type === 'tool_use_end') {
      const id = typeof event.id === 'string' ? event.id : typeof event.toolUseId === 'string' ? event.toolUseId : '';
      const open = openTools.get(id);
      if (open) {
        const input = isRecord(event.input) ? event.input : parseJsonObject(open.json);
        open.event.input = input ? { ...open.meta, ...input } : open.meta;
        openTools.delete(id);
      }
      continue;
    }
    if (event.type === 'tool_result') {
      const id = typeof event.toolUseId === 'string' ? event.toolUseId : typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
      const toolEvent = toolEventsById.get(id) as (TraceEvent & { output?: string; isError?: boolean; success?: boolean }) | undefined;
      if (toolEvent) {
        if (typeof event.content === 'string') toolEvent.output = event.content;
        const isError = event.isError === true || event.is_error === true;
        toolEvent.isError = isError;
        toolEvent.success = !isError;
      }
      continue;
    }
    if (event.type === 'error' || obj.status === 'failed' || obj.status === 'timeout' || obj.status === 'cancelled') {
      isError = true;
      continue;
    }
    if (event.type === 'message_stop') {
      sawResult = true;
      sawMessageStopUsage = true;
      const u = isRecord(event.usage) ? event.usage : {};
      usage.inputTokens = (usage.inputTokens ?? 0) + numberValue(u.inputTokens);
      usage.outputTokens = (usage.outputTokens ?? 0) + numberValue(u.outputTokens);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + numberValue(u.cacheReadInputTokens);
      usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + numberValue(u.cacheWriteInputTokens);
      continue;
    }
    if (obj.status === 'succeeded') {
      sawResult = true;
      if (typeof obj.output === 'string') output += obj.output;
      if (sawMessageStopUsage) continue;
      const u = isRecord(obj.usage) ? obj.usage : {};
      usage.inputTokens = (usage.inputTokens ?? 0) + numberValue(u.inputTokens);
      usage.outputTokens = (usage.outputTokens ?? 0) + numberValue(u.outputTokens);
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + numberValue(u.cacheReadTokens);
      usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + numberValue(u.cacheCreationTokens);
    }
  }

  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  return { output: output.slice(0, 4000), usage, trajectory, isError, mcpServers: [], sawResult };
}

function swarmTraceEventPayload(obj: Record<string, unknown>): Record<string, unknown> {
  return isRecord(obj.payload) && typeof obj.payload.type === 'string' ? obj.payload : obj;
}

function swarmTraceMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of ['agentId', 'taskId', 'lane', 'role']) {
    if (typeof obj[key] === 'string') meta[key] = obj[key];
  }
  return meta;
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
