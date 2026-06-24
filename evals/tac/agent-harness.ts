import {
  parseClaudeStream,
  type TokenUsage,
  type TraceEvent,
} from 'swarmkit-eval';

export const TAC_BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

export type TacAgentHarnessId = 'claude-code';

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
  throw new Error(`Unsupported TAC agent harness "${id}". Supported harnesses: claude-code`);
}

export function normalizeTacAgentHarnessId(id: string | undefined): TacAgentHarnessId {
  const value = (id ?? 'claude-code').trim();
  if (!value || value === 'claude' || value === 'claude-code') return 'claude-code';
  throw new Error(`Unsupported TAC agent harness "${id}". Supported harnesses: claude-code`);
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

export function tacAgentHarnessInstallCommand(id: string | undefined): string {
  return tacAgentHarnessFromId(id).setupCommand();
}

export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
