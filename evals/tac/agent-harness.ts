import {
  parseClaudeStream,
  swarmHarnessParse,
  type TokenUsage,
  type TraceEvent,
} from 'swarmkit-eval';

export const TAC_BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

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
      return 'npm install -g swarm-harness';
    },
    buildCommand(spec) {
      const promptPath = `/eval/${spec.runDir}/prompt.txt`;
      const mcpConfigPath = `/eval/${spec.runDir}/mcp.json`;
      const effectivePromptPath = spec.includeSystemPrompt ? `/eval/${spec.runDir}/swarm-harness-prompt.txt` : promptPath;
      const prelude = [
        'mkdir -p .swarm-harness',
        `cp ${shq(mcpConfigPath)} .swarm-harness/mcp.json`,
      ];
      if (spec.includeSystemPrompt) {
        prelude.push(
          `{ cat ${shq(spec.includeSystemPrompt)}; printf '\\n\\n'; cat ${shq(promptPath)}; } > ${shq(effectivePromptPath)}`,
        );
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
        `"$(cat ${shq(effectivePromptPath)})"`,
      ];
      return `${prelude.join(' && ')} && ${command.join(' ')}`;
    },
    parse(stdout) {
      return swarmHarnessParse(stdout);
    },
  };
}

export function tacAgentHarnessInstallCommand(id: string | undefined): string {
  return tacAgentHarnessFromId(id).setupCommand();
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
