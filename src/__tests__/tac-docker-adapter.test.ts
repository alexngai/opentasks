import { describe, expect, it } from 'vitest';
import type { TraceEvent } from 'swarmkit-eval';

import { tacArms } from '../../evals/tac/bench.js';
import {
  buildTacAgentPrompt,
  DEFAULT_TAC_OPERATING_PROMPT,
  failureTaxonomy,
  OPENTASKS_TAC_SKILL,
  redactSensitiveText,
  TacDockerAdapter,
  tacDockerAdapterFromEnv,
  TAC_TASK_PROMPT,
  taxonomyMetricsForTacResult,
  traceDiagnosticsFromClaudeStream,
  traceEfficiencyMetrics,
} from '../../evals/tac/docker-adapter.js';
import { tacAgentHarnessFromId, type TacAgentHarness } from '../../evals/tac/agent-harness.js';
import { buildTacTeamContractPacket, TAC_SERVICE_SYNC_TEAM, tacTeamContractMetrics } from '../../evals/tac/team-contract.js';

describe('TAC Docker adapter prompt', () => {
  it('adds shared TAC operating guidance to the task prompt', () => {
    const prompt = buildTacAgentPrompt();

    expect(prompt).toContain(TAC_TASK_PROMPT);
    expect(prompt).toContain(DEFAULT_TAC_OPERATING_PROMPT);
    expect(prompt).toContain('Do not ask for clarification');
    expect(prompt).toContain('Bash, curl, python, git, or service APIs');
  });

  it('can disable shared guidance for scaffold ablations', () => {
    expect(buildTacAgentPrompt({ operatingPrompt: false })).toBe(`${TAC_TASK_PROMPT}\n`);
  });

  it('keeps the TAC operating prompt independent of the selected arm', () => {
    const prompts = tacArms(['stock', 'notes', 'opentasks']).map(() => buildTacAgentPrompt());
    expect(new Set(prompts).size).toBe(1);
  });

  it('uses generic loop guidance without task-specific TAC answers', () => {
    const prompt = buildTacAgentPrompt();

    expect(prompt).toContain('Avoid unbounded retry loops');
    expect(prompt).toContain('Do not brute-force credentials');
    expect(prompt).toContain('PRIVATE-TOKEN: root-token');
    expect(prompt).toContain('tac-plane-api METHOD PATH [JSON_BODY]');
    expect(prompt).toContain('prefer the installed helper `tac-plane-api METHOD PATH [JSON_BODY]` instead of raw curl');
    expect(prompt).toContain('tac-plane-api GET workspaces/tac/projects/PROJECT_ID/issues/?expand=state');
    expect(prompt).toContain('tac-gitlab-api METHOD PATH [JSON_BODY]');
    expect(prompt).toContain('prefer the installed helper `tac-gitlab-api METHOD PATH [JSON_BODY]` instead of raw curl');
    expect(prompt).toContain('tac-gitlab-api DELETE projects/root/repo/repository/branches/feature/old');
    expect(prompt).toContain('tac-gitlab-protect-branch root/repo main PUSH_LEVEL MERGE_LEVEL');
    expect(prompt).toContain('head -c 4000');
    expect(prompt).toContain('Do not run recursive filesystem searches from `/`');
    expect(prompt).toContain('keep generated content tightly grounded in the requested source material');
    expect(prompt).toContain('stop. Do not continue with extra inspection');
    expect(prompt).not.toContain('sotopia');
    expect(prompt).not.toContain('api-server');
  });

  it('redacts auth material from captured streams', () => {
    const text = [
      'AWS_BEARER_TOKEN_BEDROCK=ABSKsecret...',
      '{"content":"AWS_BEARER_TOKEN_BEDROCK=ABSKbase64+/=\\nAWS_REGION=us-west-2"}',
      'standalone ABSKbase64+/=',
      'ANTHROPIC_API_KEY: sk-ant-secret',
      'AWS_SECRET_ACCESS_KEY="secret"',
      'http://root:root-token@the-agent-company.com:8929/root/project.wiki.git',
    ].join('\n');

    const redacted = redactSensitiveText(text);

    expect(redacted).not.toContain('ABSKsecret');
    expect(redacted).not.toContain('ABSKbase64');
    expect(redacted).not.toContain('sk-ant-secret');
    expect(redacted).not.toContain('"secret"');
    expect(redacted).not.toContain('root-token');
    expect(redacted).toContain('AWS_BEARER_TOKEN_BEDROCK=[REDACTED]');
    expect(redacted).toContain('ANTHROPIC_API_KEY=[REDACTED]');
    expect(redacted).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(redacted).toContain('[REDACTED_TAC_GITLAB_TOKEN]');
  });
});

describe('TAC OpenTasks MCP setup', () => {
  it('disables the LLM OpenTasks task prelude by default for benchmark runs', () => {
    const previous = process.env.TAC_OPENTASKS_TASK_PRELUDE;
    delete process.env.TAC_OPENTASKS_TASK_PRELUDE;
    try {
      const adapter = tacDockerAdapterFromEnv() as unknown as { opts: { opentasksTaskPrelude?: boolean } };

      expect(adapter.opts.opentasksTaskPrelude).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.TAC_OPENTASKS_TASK_PRELUDE;
      else process.env.TAC_OPENTASKS_TASK_PRELUDE = previous;
    }
  });

  it('allows explicitly opting into the LLM OpenTasks task prelude', () => {
    const previous = process.env.TAC_OPENTASKS_TASK_PRELUDE;
    process.env.TAC_OPENTASKS_TASK_PRELUDE = '1';
    try {
      const adapter = tacDockerAdapterFromEnv() as unknown as { opts: { opentasksTaskPrelude?: boolean } };

      expect(adapter.opts.opentasksTaskPrelude).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TAC_OPENTASKS_TASK_PRELUDE;
      else process.env.TAC_OPENTASKS_TASK_PRELUDE = previous;
    }
  });

  it('enables deterministic OpenTasks graph seeding by default unless explicitly disabled', () => {
    const previous = process.env.TAC_OPENTASKS_GRAPH_SEED;
    delete process.env.TAC_OPENTASKS_GRAPH_SEED;
    try {
      const adapter = tacDockerAdapterFromEnv() as unknown as { opts: { opentasksGraphSeed?: boolean } };

      expect(adapter.opts.opentasksGraphSeed).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.TAC_OPENTASKS_GRAPH_SEED;
      else process.env.TAC_OPENTASKS_GRAPH_SEED = previous;
    }
  });

  it('allows disabling deterministic OpenTasks graph seeding', () => {
    const previous = process.env.TAC_OPENTASKS_GRAPH_SEED;
    process.env.TAC_OPENTASKS_GRAPH_SEED = '0';
    try {
      const adapter = tacDockerAdapterFromEnv() as unknown as { opts: { opentasksGraphSeed?: boolean } };

      expect(adapter.opts.opentasksGraphSeed).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TAC_OPENTASKS_GRAPH_SEED;
      else process.env.TAC_OPENTASKS_GRAPH_SEED = previous;
    }
  });

  it('builds the default agent command through the swappable TAC harness seam', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      agentCommand: (cell: { arm: ReturnType<typeof tacArms>[number]; model: { name: string } }, runDir: string) => string;
    };

    const command = adapter.agentCommand({ arm: tacArms(['stock'])[0], model: { name: 'haiku' } }, '.tac/cell');

    expect(command).toContain('claude -p "$(cat /eval/.tac/cell/prompt.txt)"');
    expect(command).toContain('--output-format stream-json');
    expect(command).toContain("--model 'haiku'");
    expect(command).toContain("--mcp-config '/eval/.tac/cell/mcp.json'");
  });

  it('builds TAC agent commands for swarm-harness with a staged MCP config', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
    }) as unknown as {
      agentCommand: (cell: { arm: ReturnType<typeof tacArms>[number]; model: { name: string } }, runDir: string) => string;
      agentSetup: () => string;
    };

    const command = adapter.agentCommand({ arm: tacArms(['stock'])[0], model: { name: 'haiku' } }, '.tac/cell');
    const setup = adapter.agentSetup();

    expect(setup).toContain('https://deb.nodesource.com/setup_22.x');
    expect(setup).toContain('then\napt-get update');
    expect(setup).not.toContain('then apt-get update');
    expect(setup).toContain('npm install -g swarm-harness@${TAC_SWARM_HARNESS_VERSION:-0.3.5}');
    expect(command).toContain('mkdir -p .swarm-harness');
    expect(command).toContain("cp '/eval/.tac/cell/mcp.json' .swarm-harness/mcp.json");
    expect(command).toContain('swarm-harness --single --headless --output-format json');
    expect(command).toContain('TAC_SWARM_HARNESS_MODE:-single');
    expect(command).toContain('swarm-harness swarm run');
    expect(command).toContain('team|team-contract|opentasks-team-contract)');
    expect(command).toContain('swarm-harness-tasks.jsonl');
    expect(command).toContain('swarm-harness-results.jsonl');
    expect(command).toContain('swarm-harness-trace.jsonl');
    expect(command).toContain('const [promptPath, tasksPath, model] = process.argv.slice(1);');
    expect(command).toContain('  model,');
    expect(command).toContain("--opentasks --opentasks-socket ${OPENTASKS_PROJECT_DIR:-/workspace/.opentasks}/daemon.sock");
    expect(command).toContain("export SWARM_HARNESS_MODEL='haiku'");
    expect(command).not.toContain('then;');
    expect(command).toContain("--model 'haiku'");
    expect(command).toContain('--permission-mode danger-full-access');
    expect(command).toContain('"$(cat /eval/.tac/cell/prompt.txt)"');
    expect(command).not.toContain('--mcp-config');
  });

  it('passes custom prompts through to swarm-harness smoke/prelude commands', () => {
    const command = tacAgentHarnessFromId('swarm-harness').buildCommand({
      prompt: "'custom smoke prompt'",
      model: 'haiku',
      runDir: '.tac/cell',
      tools: [],
      allowedTools: true,
      strictMcpConfig: true,
    });

    expect(command).toContain("swarm-harness --single --headless --output-format json --model 'haiku'");
    expect(command).toContain("'custom smoke prompt'");
    expect(command).not.toContain('"$(cat \'/eval/.tac/cell/prompt.txt\')"');
  });

  it('creates the configured agent user in the default setup command', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
      agentUser: 'agent',
    }) as unknown as {
      agentSetup: () => string;
    };

    expect(adapter.agentSetup()).toContain("id -u 'agent'");
    expect(adapter.agentSetup()).toContain("chown -R 'agent':'agent' /workspace /eval");
  });

  it('prepends TAC system prompt appendices for swarm-harness commands', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
    }) as unknown as {
      agentCommand: (cell: { arm: ReturnType<typeof tacArms>[number]; model: { name: string } }, runDir: string) => string;
    };

    const [arm] = tacArms(['stock']);
    arm.scaffold.systemPromptAppendix = 'system guidance';
    const command = adapter.agentCommand({ arm, model: { name: 'haiku' } }, '.tac/cell');

    expect(command).toContain(
      "{ cat '/eval/.tac/cell/system.txt'; printf '\\n\\n'; cat '/eval/.tac/cell/prompt.txt'; } > '/eval/.tac/cell/swarm-harness-prompt.txt'",
    );
    expect(command).toContain('"$(cat \'/eval/.tac/cell/swarm-harness-prompt.txt\')"');
  });

  it('parses swarm-harness JSONL streams through the TAC harness seam', () => {
    const parsed = tacAgentHarnessFromId('swarm').parse(
      [
        JSON.stringify({ type: 'text_delta', text: 'done' }),
        JSON.stringify({ type: 'tool_use_start', id: 't1', name: 'bash' }),
        JSON.stringify({ type: 'tool_use_input', id: 't1', jsonDelta: '{"command":' }),
        JSON.stringify({ type: 'tool_use_input', id: 't1', jsonDelta: '"tac-gitlab-api GET /projects"}' }),
        JSON.stringify({ type: 'tool_use_end', id: 't1' }),
        JSON.stringify({ type: 'tool_result', toolUseId: 't1', content: 'command failed once', isError: true }),
        JSON.stringify({ type: 'tool_use_start', id: 't2', name: 'read_file' }),
        JSON.stringify({ type: 'tool_use_end', id: 't2', input: { path: '/instruction/task.md' } }),
        JSON.stringify({
          type: 'message_stop',
          usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 },
        }),
      ].join('\n'),
      'haiku',
    );

    expect(parsed.output).toBe('done');
    expect(parsed.sawResult).toBe(true);
    expect(parsed.isError).toBe(false);
    expect(parsed.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, totalTokens: 10 });
    expect(parsed.trajectory).toEqual([
      expect.objectContaining({ type: 'tool', name: 'Bash', input: { command: 'tac-gitlab-api GET /projects' } }),
      expect.objectContaining({ type: 'tool', name: 'Read', input: { path: '/instruction/task.md' } }),
    ]);
  });

  it('parses swarm-harness swarm-run lane traces and result records', () => {
    const parsed = tacAgentHarnessFromId('swarm').parse(
      [
        JSON.stringify({
          ts: 1,
          agentId: 'agent-1',
          type: 'tool_use_start',
          payload: { type: 'tool_use_start', id: 't1', name: 'bash' },
        }),
        JSON.stringify({
          ts: 2,
          agentId: 'agent-1',
          type: 'tool_use_input',
          payload: { type: 'tool_use_input', id: 't1', jsonDelta: '{"command":"echo ok"}' },
        }),
        JSON.stringify({
          ts: 3,
          agentId: 'agent-1',
          type: 'tool_use_end',
          payload: { type: 'tool_use_end', id: 't1' },
        }),
        JSON.stringify({
          id: 'tac-root',
          status: 'succeeded',
          output: 'done',
          usage: { inputTokens: 11, outputTokens: 7 },
          wallClockMs: 123,
        }),
      ].join('\n'),
      'haiku',
    );

    expect(parsed.output).toContain('done');
    expect(parsed.sawResult).toBe(true);
    expect(parsed.usage.totalTokens).toBe(18);
    expect(parsed.trajectory).toEqual([
      { type: 'tool', ts: 0, name: 'Bash', input: { agentId: 'agent-1', command: 'echo ok' } },
    ]);
  });

  it('does not double-count swarm-harness final usage when message_stop already reported it', () => {
    const parsed = tacAgentHarnessFromId('swarm').parse(
      [
        JSON.stringify({ type: 'message_stop', usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2 } }),
        JSON.stringify({
          id: 'tac-root',
          status: 'succeeded',
          output: 'done',
          usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 },
        }),
      ].join('\n'),
      'haiku',
    );

    expect(parsed.output).toBe('done');
    expect(parsed.sawResult).toBe(true);
    expect(parsed.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, totalTokens: 10 });
  });

  it('allows TAC tests and future adapters to inject a different agent harness', () => {
    const fakeHarness: TacAgentHarness = {
      id: 'fake-agent',
      setupCommand: () => 'install-fake-agent',
      buildCommand: (spec) => `fake-agent --model ${spec.model} --prompt ${spec.prompt} --dir ${spec.runDir}`,
      parse: () => ({
        output: 'ok',
        isError: false,
        sawResult: true,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        trajectory: [],
        mcpServers: [],
      }),
    };
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarness: fakeHarness,
    }) as unknown as {
      agentCommand: (cell: { arm: ReturnType<typeof tacArms>[number]; model: { name: string } }, runDir: string) => string;
      agentSetup: () => string;
    };

    expect(adapter.agentSetup()).toContain('https://deb.nodesource.com/setup_22.x');
    expect(adapter.agentSetup()).toContain('install-fake-agent');
    expect(adapter.agentCommand({ arm: tacArms(['stock'])[0], model: { name: 'gpt-test' } }, '.tac/cell')).toBe(
      'fake-agent --model gpt-test --prompt "$(cat /eval/.tac/cell/prompt.txt)" --dir .tac/cell',
    );
  });

  it('exposes generic TAC service facts to every agent arm', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      agentEnv: (cell: { task: { id: string }; arm: ReturnType<typeof tacArms>[number] }) => Record<string, string>;
    };

    const env = adapter.agentEnv({ task: { id: 'sde-test' }, arm: tacArms(['stock'])[0] });

    expect(env).toMatchObject({
      GITLAB_BASE_URL: 'http://the-agent-company.com:8929',
      GITLAB_TOKEN: 'root-token',
      GITLAB_USER: 'root',
      GITLAB_PASSWORD: 'theagentcompany',
      TAC_HELPER_MAX_OUTPUT_BYTES: '6000',
    });
  });

  it('defaults the team-contract arm to swarm-harness team mode with OpenTasks enabled', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
    }) as unknown as {
      agentEnv: (cell: { task: { id: string }; arm: ReturnType<typeof tacArms>[number] }) => Record<string, string>;
      usesSwarmHarnessSwarmMode: (cell: { arm: ReturnType<typeof tacArms>[number] }) => boolean;
    };

    const cell = { task: { id: 'pm-test' }, arm: tacArms(['opentasks-team-contract'])[0] };
    const env = adapter.agentEnv(cell);

    expect(adapter.usesSwarmHarnessSwarmMode(cell)).toBe(true);
    expect(env.TAC_SWARM_HARNESS_MODE).toBe('team-contract');
    expect(env.TAC_SWARM_HARNESS_OPENTASKS).toBe('1');
    expect(env.OPENTASKS_PROJECT_DIR).toBe('/workspace/.opentasks');
  });

  it('defaults env-driven team-contract runs to the swarm-harness runtime', () => {
    const previousArms = process.env.EVAL_ARMS;
    const previousHarness = process.env.TAC_AGENT_HARNESS;
    const previousRuntime = process.env.TAC_AGENT_RUNTIME;
    process.env.EVAL_ARMS = 'opentasks-team-contract';
    delete process.env.TAC_AGENT_HARNESS;
    delete process.env.TAC_AGENT_RUNTIME;
    try {
      const adapter = tacDockerAdapterFromEnv() as unknown as { agentSetup: () => string };

      expect(adapter.agentSetup()).toContain('swarm-harness');
    } finally {
      if (previousArms === undefined) delete process.env.EVAL_ARMS;
      else process.env.EVAL_ARMS = previousArms;
      if (previousHarness === undefined) delete process.env.TAC_AGENT_HARNESS;
      else process.env.TAC_AGENT_HARNESS = previousHarness;
      if (previousRuntime === undefined) delete process.env.TAC_AGENT_RUNTIME;
      else process.env.TAC_AGENT_RUNTIME = previousRuntime;
    }
  });

  it('installs bounded TAC service API helpers into the task container', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacAgentHelperInstallCommand: () => string;
    };

    const command = adapter.tacAgentHelperInstallCommand();

    expect(command).toContain('/usr/local/bin/tac-gitlab-api');
    expect(command).toContain('/usr/local/bin/tac-plane-api');
    expect(command).toContain('/usr/local/bin/tac-opentasks-record-evidence');
    expect(command).toContain('/usr/local/bin/tac-gitlab-protect-branch');
    expect(command).toContain('PRIVATE-TOKEN');
    expect(command).toContain('x-api-key');
    expect(command).toContain('PLANE_API_KEY');
    expect(command).toContain('TAC_HELPER_MAX_OUTPUT_BYTES');
    expect(command).toContain('[truncated by tac-gitlab-api');
    expect(command).toContain('[truncated by tac-plane-api');
    expect(command).toContain('[REDACTED_TAC_GITLAB_TOKEN]');
    expect(command).toContain('[REDACTED_TAC_PLANE_API_KEY]');
    expect(command).toContain('def normalize_api_path');
    expect(command).toContain('def normalize_url');
    expect(command).toContain('def normalize_projects_path');
    expect(command).toContain('def normalize_project_suffix');
    expect(command).toContain('def quote_path_tail');
    expect(command).toContain('path, sep, query = path.partition("?")');
    expect(command).toContain('suffix[-1] == "raw"');
    expect(command).toContain('urllib.parse.quote("/".join(project_parts), safe="")');
    expect(command).toContain('urllib.parse.quote(urllib.parse.unquote("/".join(parts)), safe="")');
    expect(command).toContain('tac-gitlab-api DELETE projects/root/repo/repository/branches/feature/old');
    expect(command).toContain('tac-plane-api GET workspaces/tac/projects/PROJECT_ID/issues/?expand=state');
    expect(command).toContain('usage: tac-opentasks-record-evidence ROLE CORRELATION_ID JSON_PAYLOAD [OPENTASKS_TASK_ID]');
    expect(command).toContain('agent-inbox-v1');
    expect(command).toContain('opentasks_record_id');
    expect(command).toContain('TEAM_EVIDENCE');
    expect(command).toContain('TEAM_VERIFICATION');
    expect(command).toContain('return base_url + "/api/v1" + path');
    expect(command).toContain('usage: tac-gitlab-protect-branch PROJECT BRANCH PUSH_LEVEL MERGE_LEVEL');
    expect(command).toContain('tac-gitlab-api DELETE "projects/${project}/protected_branches/${branch}"');
    expect(command).toContain('tac-gitlab-api POST "projects/${project}/protected_branches" "$body"');
    expect(command).toContain('"/api/v4" + path');
    expect(command).toContain('"projects"');
    expect(command).toContain('command -v tac-plane-api >/dev/null');
  });

  it('rejects unknown TAC agent harness ids explicitly', () => {
    expect(() => tacAgentHarnessFromId('unknown-harness')).toThrow(/Unsupported TAC agent harness/);
  });

  it('pins the MCP server to the task workspace graph through the debug wrapper by default', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      mcpConfig: (cell: { arm: ReturnType<typeof tacArms>[number] }) => {
        mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
      };
    };

    const config = adapter.mcpConfig({ arm: tacArms(['opentasks'])[0] });

    expect(config.mcpServers.opentasks.command).toBe('/bin/bash');
    expect(config.mcpServers.opentasks.args.join(' ')).toContain('opentasks-mcp-wrapper.sh');
    expect(config.mcpServers.opentasks.env?.OPENTASKS_PROJECT_DIR).toBe('/workspace/.opentasks');
    expect(config.mcpServers.opentasks.env?.PATH).toContain('/usr/bin');
  });

  it('can use the prior sh-lc MCP command variant for isolation runs', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      opentasksMcpCommandVariant: 'sh-lc',
    }) as unknown as {
      mcpConfig: (cell: { arm: ReturnType<typeof tacArms>[number] }) => {
        mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
      };
    };

    const config = adapter.mcpConfig({ arm: tacArms(['opentasks'])[0] });

    expect(config.mcpServers.opentasks.command).toBe('sh');
    expect(config.mcpServers.opentasks.args.join(' ')).toContain('OPENTASKS_PROJECT_DIR');
    expect(config.mcpServers.opentasks.args.join(' ')).toContain('/workspace/.opentasks');
  });

  it('reports a failed OpenTasks MCP smoke when Claude leaves opentasks pending', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksMcpSmokeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
      ) => { ok: boolean; failureReason?: string; opentasksToolCount: number; skillNames: string[] };
    };
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'opentasks', status: 'pending' }],
        tools: ['Read', 'Bash'],
        skills: ['opentasks'],
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

    const report = adapter.opentasksMcpSmokeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
    );

    expect(report.ok).toBe(false);
    expect(report.failureReason).toContain('status=pending');
    expect(report.opentasksToolCount).toBe(0);
    expect(report.skillNames).toContain('opentasks');
  });

  it('reports a passed OpenTasks MCP smoke when Claude exposes opentasks tools', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksMcpSmokeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
      ) => { ok: boolean; opentasksToolCount: number; usedNativeOpentasksTool: boolean };
    };
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'opentasks', status: 'connected' }],
        tools: ['Read', 'mcp__opentasks__list_tasks'],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'mcp__opentasks__list_tasks', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

    const report = adapter.opentasksMcpSmokeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
    );

    expect(report.ok).toBe(true);
    expect(report.opentasksToolCount).toBe(1);
    expect(report.usedNativeOpentasksTool).toBe(true);
  });

  it('treats native OpenTasks MCP execution as success even when init status is pending', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksMcpSmokeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
      ) => { ok: boolean; failureReason?: string; opentasksToolCount: number; usedNativeOpentasksTool: boolean };
    };
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'opentasks', status: 'pending' }],
        tools: ['Read', 'ToolSearch'],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'mcp__opentasks__list_tasks', input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

    const report = adapter.opentasksMcpSmokeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
    );

    expect(report.ok).toBe(true);
    expect(report.failureReason).toBeUndefined();
    expect(report.opentasksToolCount).toBe(0);
    expect(report.usedNativeOpentasksTool).toBe(true);
  });

  it('treats swarm-harness OpenTasks tool execution as a successful MCP smoke without Claude init metadata', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
    }) as unknown as {
      opentasksMcpSmokeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
      ) => { ok: boolean; harnessId: string; nativeCalls: string[]; opentasksToolCount: number; usedNativeOpentasksTool: boolean };
    };
    const stdout = [
      JSON.stringify({ type: 'text_delta', text: 'Calling OpenTasks.' }),
      JSON.stringify({ type: 'tool_use_start', id: 'toolu_1', name: 'mcp__opentasks__list_tasks' }),
      JSON.stringify({ type: 'tool_use_input', id: 'toolu_1', jsonDelta: '{}' }),
      JSON.stringify({ type: 'tool_use_end', id: 'toolu_1' }),
      JSON.stringify({ type: 'tool_result', toolUseId: 'toolu_1', content: '{"items":[]}', isError: false }),
      JSON.stringify({ type: 'message_stop', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } }),
    ].join('\n');

    const report = adapter.opentasksMcpSmokeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
    );

    expect(report.ok).toBe(true);
    expect(report.harnessId).toBe('swarm-harness');
    expect(report.opentasksToolCount).toBe(0);
    expect(report.nativeCalls).toEqual(['mcp__opentasks__list_tasks']);
    expect(report.usedNativeOpentasksTool).toBe(true);
  });

  it('treats swarm-harness swarm-run task tool execution as a successful coordination smoke', () => {
    const previousMode = process.env.TAC_SWARM_HARNESS_MODE;
    process.env.TAC_SWARM_HARNESS_MODE = 'swarm-run';
    try {
      const adapter = new TacDockerAdapter({
        timeoutMs: 1,
        initTimeoutMs: 1,
        evalTimeoutMs: 1,
        serverHostname: 'the-agent-company.com',
        network: 'host',
        decryptionKey: 'test',
        agentHarnessId: 'swarm-harness',
      }) as unknown as {
        opentasksMcpSmokeReport: (
          cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
          agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
        ) => {
          ok: boolean;
          usedSwarmTaskTool: boolean;
          swarmTaskToolCount: number;
          swarmTaskCalls: string[];
          usedNativeOpentasksTool: boolean;
        };
      };
      const stdout = [
        JSON.stringify({ type: 'tool_use_start', id: 'toolu_1', name: 'task_list' }),
        JSON.stringify({ type: 'tool_use_input', id: 'toolu_1', jsonDelta: '{}' }),
        JSON.stringify({ type: 'tool_use_end', id: 'toolu_1' }),
        JSON.stringify({ type: 'tool_result', toolUseId: 'toolu_1', content: '{"tasks":[]}', isError: false }),
        JSON.stringify({ type: 'message_stop', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } }),
      ].join('\n');

      const report = adapter.opentasksMcpSmokeReport(
        { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
        { exitCode: 0, stdout, stderr: '' },
      );

      expect(report.ok).toBe(true);
      expect(report.usedSwarmTaskTool).toBe(true);
      expect(report.swarmTaskToolCount).toBe(1);
      expect(report.swarmTaskCalls).toEqual(['task_list']);
      expect(report.usedNativeOpentasksTool).toBe(false);
    } finally {
      if (previousMode === undefined) delete process.env.TAC_SWARM_HARNESS_MODE;
      else process.env.TAC_SWARM_HARNESS_MODE = previousMode;
    }
  });

  it('treats team-contract arm swarm task execution as a successful coordination smoke', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      agentHarnessId: 'swarm-harness',
    }) as unknown as {
      opentasksMcpSmokeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
      ) => { ok: boolean; usedSwarmTaskTool: boolean; swarmTaskCalls: string[] };
    };
    const stdout = [
      JSON.stringify({ type: 'tool_use_start', id: 'toolu_1', name: 'task_list' }),
      JSON.stringify({ type: 'tool_use_input', id: 'toolu_1', jsonDelta: '{}' }),
      JSON.stringify({ type: 'tool_use_end', id: 'toolu_1' }),
      JSON.stringify({ type: 'tool_result', toolUseId: 'toolu_1', content: '{"tasks":[]}', isError: false }),
      JSON.stringify({ type: 'message_stop', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } }),
    ].join('\n');

    const report = adapter.opentasksMcpSmokeReport(
      { arm: tacArms(['opentasks-team-contract'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
    );

    expect(report.ok).toBe(true);
    expect(report.usedSwarmTaskTool).toBe(true);
    expect(report.swarmTaskCalls).toEqual(['task_list']);
  });

  it('ships a Claude-discoverable OpenTasks skill that says to use native tools', () => {
    expect(OPENTASKS_TAC_SKILL).toContain('name: opentasks');
    expect(OPENTASKS_TAC_SKILL).toContain('mcp__opentasks__create_task');
    expect(OPENTASKS_TAC_SKILL).toContain('mcp__opentasks__get_task');
    expect(OPENTASKS_TAC_SKILL).toContain('ToolSearch');
    expect(OPENTASKS_TAC_SKILL).toContain('Never run those tool names in Bash');
    expect(OPENTASKS_TAC_SKILL).toContain('the next tool call should be the native');
    expect(OPENTASKS_TAC_SKILL).toContain('Do not insert Bash status commands such as echo');
    expect(OPENTASKS_TAC_SKILL).toContain('Do not delegate OpenTasks reads to a subagent');
    expect(OPENTASKS_TAC_SKILL).toContain('Minimal TAC graph protocol');
    expect(OPENTASKS_TAC_SKILL).toContain('read the full `content` before task-specific Bash');
    expect(OPENTASKS_TAC_SKILL).toContain('Do not read `/instruction/task.md` before the seeded `get_task` call');
    expect(OPENTASKS_TAC_SKILL).toContain('Do not create a duplicate top-level task');
    expect(OPENTASKS_TAC_SKILL).toContain('Do not create subtasks for simple single-action TAC tasks');
  });

  it('keeps the OpenTasks arm appendix aligned with the seeded get_task-first protocol', () => {
    const [arm] = tacArms(['opentasks']);
    const appendix = arm.scaffold.systemPromptAppendix ?? '';

    expect(appendix).toContain('mcp__opentasks__get_task');
    expect(appendix).toContain('before task-specific Bash/curl/git/service API work');
    expect(appendix).toContain('exactly one query, select:mcp__opentasks__get_task');
    expect(appendix).toContain('Do not combine multiple select queries with commas');
    expect(appendix).toContain('do not invoke mcp__opentasks__ tool names as shell commands');
    expect(appendix).toContain('Do not insert Bash status commands such as echo');
    expect(appendix).not.toContain('select:mcp__opentasks__list_tasks or select:mcp__opentasks__record_attempt');
  });

  it('exposes the dormant OpenTasks team-contract TAC arm', () => {
    const [arm] = tacArms(['opentasks-team-contract']);
    const appendix = arm.scaffold.systemPromptAppendix ?? '';

    expect(arm.id).toBe('opentasks-team-contract');
    expect(arm.scaffold.mcpServers?.[0]?.name).toBe('opentasks');
    expect(arm.scaffold.extraTools).toContain('mcp__opentasks__get_task');
    expect(arm.scaffold.extraTools).toContain('mcp__opentasks__record_attempt');
    expect(appendix).toContain('team-contract TAC arm');
    expect(appendix).toContain('structured evidence before mutation');
    expect(appendix).toContain('task_list({})');
    expect(appendix).toContain('local swarm coordination log');
    expect(appendix).toContain('not durable OpenTasks evidence by itself');
    expect(appendix).toContain('Do not assume tac-root');
    expect(appendix).toContain('Do not search for mcp__opentasks__ tools in swarm-harness');
    expect(appendix).toContain('permissionMode:"danger-full-access"');
  });

  it('builds a static TAC team-contract packet with full task text and evidence schema', () => {
    const packet = buildTacTeamContractPacket({
      sourceTaskId: 'pm-update-plane-issue-from-gitlab-status',
      seededRootTaskId: 't-root',
      taskText: 'Update the Plane issue based on GitLab issue status.',
    });

    expect(TAC_SERVICE_SYNC_TEAM.name).toBe('tac-service-sync');
    expect(packet).toContain('Template: tac-service-sync@1');
    expect(packet).toContain('Seeded OpenTasks root task id: t-root');
    expect(packet).toContain('service_inspector contract');
    expect(packet).toContain('task_list({})');
    expect(packet).toContain('Local swarm task_update(output:"...") alone is not durable OpenTasks evidence');
    expect(packet).toContain('TEAM_EVIDENCE');
    expect(packet).toContain('"protocol": "agent-inbox-v1"');
    expect(packet).toContain('"correlation_id"');
    expect(packet).toContain('"opentasks_record_id"');
    expect(packet).toContain('"commands_or_endpoints"');
    expect(packet).toContain('tac-plane-api');
    expect(packet).toContain('Update the Plane issue based on GitLab issue status.');
  });

  it('adds static team-contract files and prompt text only for the team-contract arm', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      teamContractFiles: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; task: { id: string; prompt: string } } : never,
        runDir: string,
      ) => Array<{ path: string; content: string }>;
      mainPrompt: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; task: { id: string; prompt: string } } : never,
      ) => string;
      mainPromptWithGraphSeed: (
        report: unknown,
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; task: { id: string; prompt: string } } : never,
      ) => string;
    };
    const [teamArm] = tacArms(['opentasks-team-contract']);
    const [plainArm] = tacArms(['opentasks']);
    const cell = {
      arm: teamArm,
      task: { id: 'pm-update-plane-issue-from-gitlab-status', prompt: 'Full TAC task text.' },
    };

    const files = adapter.teamContractFiles(cell, '.tac/cell');
    const prompt = adapter.mainPrompt(cell);
    const seededPrompt = adapter.mainPromptWithGraphSeed(
      {
        ok: true,
        taskId: 't-seed1',
        taskTitle: 'Seeded TAC task',
        sourceTaskId: 'pm-update-plane-issue-from-gitlab-status',
        cellKey: 'cell/example',
        contentBytes: 123,
        tags: ['tac', 'seeded'],
        exitCode: 0,
        stdoutHead: '',
        stderrHead: '',
      },
      cell,
    );

    expect(files.map((file) => file.path)).toEqual([
      '.tac/cell/team-contract-packet.md',
      '.tac/cell/team-contract-template.json',
    ]);
    expect(files[0]?.content).toContain('Full TAC task text.');
    expect(prompt).toContain('TAC Team Contract Packet');
    expect(seededPrompt).toContain('Seeded OpenTasks root task id: t-seed1');
    expect(adapter.teamContractFiles({ arm: plainArm, task: cell.task }, '.tac/cell')).toEqual([]);
  });

  it('builds a deterministic OpenTasks graph seed command from the TAC task file', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksGraphSeedCommand: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string }; task: { id: string }; cellKey: string; seed: number } : never,
        runDir: string,
      ) => string;
    };

    const command = adapter.opentasksGraphSeedCommand(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' }, task: { id: 'sde-example' }, cellKey: 'cell/example', seed: 7 },
      '.tac/cell-example',
    );

    expect(command).toContain('OPENTASKS_PROJECT_DIR');
    expect(command).toContain('/instruction/task.md');
    expect(command).toContain('def compact_title');
    expect(command).toContain('tail = first[-50:]');
    expect(command).toContain('opentasks-graph-seed-report.json');
    expect(command).toContain('"--status", "open"');
    expect(command).toContain('"--tags", "tac,seeded,team-contract" if team_contract else "tac,seeded"');
    expect(command).toContain('"deterministicGraphSeed"');
  });

  it('adds richer OpenTasks graph seeding for the team-contract arm', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksGraphSeedCommand: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string }; task: { id: string }; cellKey: string; seed: number } : never,
        runDir: string,
      ) => string;
      opentasksGraphSeedSummary: (report: unknown) => string;
    };
    const command = adapter.opentasksGraphSeedCommand(
      { arm: tacArms(['opentasks-team-contract'])[0], model: { name: 'haiku' }, task: { id: 'pm-test' }, cellKey: 'cell/team', seed: 3 },
      '.tac/cell-team',
    );

    expect(command).toContain('team_contract = arm_id == "opentasks-team-contract"');
    expect(command).toContain('"service_inspection"');
    expect(command).toContain('"mutation_plan"');
    expect(command).toContain('"verification"');
    expect(command).toContain('"role": role');
    expect(command).toContain('"capabilities": capabilities');
    expect(command).toContain('"--type", edge_type');
    expect(command).toContain('"relation": relation');

    const summary = adapter.opentasksGraphSeedSummary({
      ok: true,
      taskId: 't-root',
      taskTitle: 'Seeded TAC task',
      sourceTaskId: 'pm-test',
      cellKey: 'cell/team',
      contentBytes: 123,
      tags: ['tac', 'seeded'],
      teamContract: { enabled: true, nodes: [{ slug: 'service_inspection' }, { slug: 'verification' }] },
      exitCode: 0,
      stdoutHead: '',
      stderrHead: '',
    });

    expect(summary).toContain('teamContract: on');
    expect(summary).toContain('teamNodes: service_inspection,verification');
  });

  it('classifies TAC team-contract productive coordination from parsed trace order', () => {
    const metrics = tacTeamContractMetrics([
      { type: 'tool', ts: 0, name: 'mcp__opentasks__get_task', input: { agentId: 'root', id: 't-root' } },
      {
        type: 'tool',
        ts: 1,
        name: 'mcp__opentasks__update_task',
        input: {
          agentId: 'child-1',
          id: 'service_inspection',
          metadata: { evidence: [{ kind: 'api', summary: 'Issue is closed' }], commands_or_endpoints: ['tac-gitlab-api GET projects/root/repo/issues'] },
        },
      },
      {
        type: 'tool',
        ts: 2,
        name: 'Bash',
        input: { agentId: 'root', command: 'tac-gitlab-api PATCH projects/root/repo/issues/1 {"state_event":"close"}' },
      },
      {
        type: 'tool',
        ts: 3,
        name: 'mcp__opentasks__record_attempt',
        input: { agentId: 'root', taskId: 'verification', evidence: 'verified final service state' },
      },
    ]);

    expect(metrics).toMatchObject({
      teamContractDistinctAgentCount: 2,
      teamContractWorkerSpawned: 1,
      teamContractChildEvidenceWritten: 1,
      teamContractCoordinatorConsumedEvidenceBeforeMutation: 1,
      teamContractVerificationWritten: 1,
      teamContractVerificationAfterMutation: 1,
      teamContractProductiveCoordination: 1,
      teamContractStopGatePassed: 1,
    });
  });

  it('does not classify local swarm task updates as durable TAC team-contract evidence writes', () => {
    const trajectory = [
      { type: 'tool', ts: 0, name: 'task_get', input: { agentId: 'root', id: 'tac-root' } },
      { type: 'tool', ts: 1, name: 'agent', input: { agentId: 'root', prompt: 'inspect service state' } },
      {
        type: 'tool',
        ts: 2,
        name: 'task_update',
        input: {
          agentId: 'root',
          id: 'tac-root',
          output: 'EVIDENCE_FOUND service_inspection commands_or_endpoints=["GET /api"] evidence=[{"kind":"api"}]',
        },
      },
      { type: 'tool', ts: 3, name: 'Bash', input: { agentId: 'root', command: 'curl -X PATCH http://plane/api/issues/1' } },
      {
        type: 'tool',
        ts: 4,
        name: 'task_update',
        input: { agentId: 'root', id: 'tac-root', output: 'VERIFIED final verification evidence' },
      },
      { type: 'tool', ts: 5, name: 'Read', input: { agentId: 'child' } },
    ];

    const metrics = tacTeamContractMetrics(trajectory);

    expect(metrics).toMatchObject({
      teamContractOpenTasksGraphCallCount: 0,
      teamContractEvidenceWriteCount: 0,
      teamContractFailedGraphWriteCount: 0,
      teamContractVerificationWriteCount: 0,
      teamContractCoordinatorConsumedEvidenceBeforeMutation: 0,
      teamContractVerificationAfterMutation: 0,
      teamContractStopGatePassed: 0,
    });
  });

  it('classifies TAC OpenTasks helper output with durable record ids as team-contract evidence', () => {
    const metrics = tacTeamContractMetrics([
      { type: 'tool', ts: 0, name: 'task_list', input: { agentId: 'root' } },
      { type: 'tool', ts: 1, name: 'agent', input: { agentId: 'root', prompt: 'inspect service state' } },
      {
        type: 'tool',
        ts: 2,
        name: 'Bash',
        input: {
          agentId: 'child-1',
          command:
            'tac-opentasks-record-evidence service_inspector tac-service-sync:cell:inspection \'{"marker":"TEAM_EVIDENCE","commands_or_endpoints":["tac-gitlab-api GET projects/root/repo/issues"]}\' t-root',
        },
        output:
          '{"ok":true,"protocol":"agent-inbox-v1","marker":"TEAM_EVIDENCE","opentasks_record_id":"f-abcd","correlation_id":"tac-service-sync:cell:inspection"}',
      },
      {
        type: 'tool',
        ts: 3,
        name: 'Bash',
        input: { agentId: 'root', command: 'tac-gitlab-api PATCH projects/root/repo/issues/1 {"state_event":"close"}' },
      },
      {
        type: 'tool',
        ts: 4,
        name: 'Bash',
        input: {
          agentId: 'root',
          command:
            'tac-opentasks-record-evidence verifier tac-service-sync:cell:verification \'{"marker":"TEAM_VERIFICATION","summary":"verified"}\' t-root',
        },
        output:
          '{"ok":true,"protocol":"agent-inbox-v1","marker":"TEAM_VERIFICATION","opentasks_record_id":"f-efgh","correlation_id":"tac-service-sync:cell:verification"}',
      },
    ]);

    expect(metrics).toMatchObject({
      teamContractDistinctAgentCount: 2,
      teamContractWorkerSpawned: 1,
      teamContractOpenTasksGraphCallCount: 2,
      teamContractEvidenceWriteCount: 1,
      teamContractChildEvidenceWritten: 1,
      teamContractCoordinatorConsumedEvidenceBeforeMutation: 1,
      teamContractVerificationWriteCount: 1,
      teamContractVerificationAfterMutation: 1,
      teamContractStopGatePassed: 1,
    });
  });

  it('does not count TAC OpenTasks helper output without a durable record id', () => {
    const metrics = tacTeamContractMetrics([
      {
        type: 'tool',
        ts: 0,
        name: 'Bash',
        input: {
          agentId: 'child-1',
          command:
            'tac-opentasks-record-evidence service_inspector tac-service-sync:cell:inspection \'{"marker":"TEAM_EVIDENCE","evidence":[{"kind":"api"}]}\' t-root',
        },
        output: '{"ok":true,"protocol":"agent-inbox-v1","marker":"TEAM_EVIDENCE"}',
      },
    ]);

    expect(metrics).toMatchObject({
      teamContractOpenTasksGraphCallCount: 1,
      teamContractEvidenceWriteCount: 0,
      teamContractFailedGraphWriteCount: 1,
      teamContractChildEvidenceWritten: 0,
      teamContractStopGatePassed: 0,
    });
  });

  it('does not count failed swarm task updates as durable TAC team-contract evidence', () => {
    const metrics = tacTeamContractMetrics([
      { type: 'tool', ts: 0, name: 'task_list', input: { agentId: 'root' } },
      {
        type: 'tool',
        ts: 1,
        name: 'task_update',
        input: { agentId: 'root', id: 't-missing', output: 'EVIDENCE_FOUND service_inspection evidence' },
        isError: true,
      } as TraceEvent & { isError: true },
      { type: 'tool', ts: 2, name: 'Bash', input: { agentId: 'root', command: 'curl -X PATCH http://plane/api/issues/1' } },
    ]);

    expect(metrics).toMatchObject({
      teamContractOpenTasksGraphCallCount: 0,
      teamContractEvidenceWriteCount: 0,
      teamContractFailedGraphWriteCount: 0,
      teamContractChildEvidenceWritten: 0,
      teamContractCoordinatorConsumedEvidenceBeforeMutation: 0,
      teamContractStopGatePassed: 0,
    });
  });

  it('classifies Python service writes before final TAC team-contract verification', () => {
    const metrics = tacTeamContractMetrics([
      { type: 'tool', ts: 0, name: 'task_list', input: { agentId: 'root' } },
      { type: 'tool', ts: 1, name: 'agent', input: { agentId: 'root', prompt: 'inspect service state' } },
      { type: 'tool', ts: 2, name: 'Read', input: { agentId: 'child' } },
      {
        type: 'tool',
        ts: 3,
        name: 'mcp__opentasks__update_task',
        input: {
          agentId: 'root',
          id: 'service_inspection',
          metadata: {
            evidence: [{ kind: 'api' }],
            commands_or_endpoints: ['tac-plane-api GET workspaces/tac/projects/p/issues/?expand=state'],
          },
        },
      },
      {
        type: 'tool',
        ts: 4,
        name: 'Bash',
        input: {
          agentId: 'root',
          command: [
            'python - <<\'PY\'',
            'import requests',
            'requests.request("PATCH", "http://plane/api/issues/1", json={"state":"done"})',
            'PY',
          ].join('\n'),
        },
      },
      {
        type: 'tool',
        ts: 5,
        name: 'mcp__opentasks__record_attempt',
        input: { agentId: 'root', taskId: 'verification', summary: 'VERIFIED final verification evidence' },
      },
    ]);

    expect(metrics).toMatchObject({
      teamContractVerificationAfterMutation: 1,
      teamContractProductiveCoordination: 1,
      teamContractStopGatePassed: 1,
    });
  });

  it('uses seeded graph prompt language for the main OpenTasks agent', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      mainPromptWithGraphSeed: (report: unknown) => string;
    };

    const prompt = adapter.mainPromptWithGraphSeed({
      ok: true,
      taskId: 't-seed1',
      taskTitle: 'Seeded TAC task',
      sourceTaskId: 'sde-example',
      cellKey: 'cell/example',
      contentBytes: 123,
      tags: ['tac', 'seeded'],
      exitCode: 0,
      stdoutHead: '',
      stderrHead: '',
    });

    expect(prompt).toContain('deterministically seeded');
    expect(prompt).toContain('Use the opentasks skill');
    expect(prompt).toContain('select:mcp__opentasks__get_task');
    expect(prompt).toContain('Call native mcp__opentasks__get_task with seeded task id t-seed1');
    expect(prompt).toContain('read the full content before any task-specific Bash');
    expect(prompt).toContain('the next tool call should be mcp__opentasks__get_task');
    expect(prompt).toContain('Do not insert Bash status commands such as echo');
    expect(prompt).toContain('Do not read /instruction/task.md before this get_task call');
    expect(prompt).toContain('Do not run mcp__opentasks__get_task in Bash');
    expect(prompt).toContain('do not fetch OpenTasks over curl');
    expect(prompt).toContain('do not ask a subagent');
    expect(prompt).toContain('Use mcp__opentasks__list_tasks only as a fallback');
    expect(prompt).toContain('Use seeded task id t-seed1');
    expect(prompt).toContain('Do not create a duplicate top-level task');
    expect(prompt).toContain('record one final outcome');
    expect(prompt).not.toContain('update OpenTasks after each major discovery');
  });

  it('refreshes TAC GitLab root-token on the host after GitLab resets', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacGitlabRootTokenRefreshCommand: () => string;
    };

    const command = adapter.tacGitlabRootTokenRefreshCommand();

    expect(command).toContain('docker exec gitlab gitlab-rails runner');
    expect(command).toContain('personal_access_tokens.where');
    expect(command).toContain('delete_all');
    expect(command).toContain('token.set_token');
    expect(command).toContain('root-token');
    expect(command).toContain('364.days.from_now');
  });

  it('accepts a GitLab token refresh success marker when SSH adds a host warning', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacGitlabRootTokenRefreshOk: (result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }) => boolean;
    };

    expect(
      adapter.tacGitlabRootTokenRefreshOk({
        exitCode: 1,
        stdout: 'root-token refreshed\n',
        stderr: "Warning: Permanently added '203.0.113.10' (ED25519) to the list of known hosts.\n",
      }),
    ).toBe(true);
  });

  it('rejects GitLab token refresh output that has known Rails failures', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacGitlabRootTokenRefreshOk: (result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }) => boolean;
    };

    expect(
      adapter.tacGitlabRootTokenRefreshOk({
        exitCode: 1,
        stdout: '',
        stderr: 'Validation failed: Expiration date must be before 2027-06-23 (ActiveRecord::RecordInvalid)',
      }),
    ).toBe(false);
  });

  it('checks TAC GitLab health and root-token validity before agent spend', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacEnvPreflightCommand: (runDir: string) => string;
    };

    const command = adapter.tacEnvPreflightCommand('.tac/test-cell');

    expect(command).toContain('/eval/.tac/test-cell/tac-env-preflight.json');
    expect(command).toContain('http://the-agent-company.com:2999/api/healthcheck/gitlab');
    expect(command).toContain('http://the-agent-company.com:8929/api/v4/user');
    expect(command).toContain('"PRIVATE-TOKEN": "root-token"');
    expect(command).toContain('parsed.get("username") == "root"');
  });

  it('checks TAC LLM grader routing before agent spend for LLM-graded tasks', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacEvalLlmPreflightCommand: (runDir: string) => string;
    };

    const command = adapter.tacEvalLlmPreflightCommand('.tac/test-cell');

    expect(command).toContain('/eval/.tac/test-cell/tac-eval-llm-preflight.json');
    expect(command).toContain('from common import llm_complete');
    expect(command).toContain('PYTHONPATH=/utils python_default /tmp/tac-eval-llm-preflight.py');
    expect(command).toContain('LITELLM_MODEL');
  });

  it('routes TAC LLM graders through an OpenAI-compatible local proxy model', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      env: {
        TAC_GRADER_PROXY: 'bedrock',
        TAC_GRADER_PROXY_MODEL: 'tac-grader',
        TAC_GRADER_PROXY_KEY: 'sk-test',
        TAC_GRADER_PROXY_PORT: '4017',
      },
    }) as unknown as {
      envLlmEnv: () => Record<string, string>;
    };

    expect(adapter.envLlmEnv()).toMatchObject({
      LITELLM_API_KEY: 'sk-test',
      LITELLM_BASE_URL: 'http://127.0.0.1:4017/v1',
      LITELLM_MODEL: 'openai/tac-grader',
    });
  });

  it('smoke-tests GitLab wiki writes against a scratch project without task-specific targets', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacGitlabWikiSmokeCommand: (runDir: string) => string;
    };

    const command = adapter.tacGitlabWikiSmokeCommand('.tac/test-cell');

    expect(command).toContain('/eval/.tac/test-cell/tac-gitlab-wiki-smoke.json');
    expect(command).toContain('opentasks-wiki-smoke-');
    expect(command).toContain('create-scratch-project');
    expect(command).toContain('create-wiki-page-api');
    expect(command).toContain('read-wiki-page-api');
    expect(command).toContain('delete-scratch-project');
    expect(command).toContain('git-wiki-clone-commit-push');
    expect(command).toContain('import shlex');
    expect(command).toContain('git config user.name {shlex.quote("TAC Wiki Smoke")}');
    expect(command).toContain('TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT');
    expect(command).not.toContain('sotopia');
  });

  it('can smoke-test a target GitLab wiki only in preflight-only diagnostics', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      preflightOnly: true,
      tacGitlabWikiTargetSmokeProject: 'root/sotopia',
    }) as unknown as {
      opts: { preflightOnly?: boolean; tacGitlabWikiTargetSmokeProject?: string };
      tacGitlabWikiTargetSmokeCommand: (runDir: string, projectPath: string) => string;
    };

    const command = adapter.tacGitlabWikiTargetSmokeCommand('.tac/test-cell', 'root/sotopia');

    expect(adapter.opts.preflightOnly).toBe(true);
    expect(adapter.opts.tacGitlabWikiTargetSmokeProject).toBe('root/sotopia');
    expect(command).toContain('/eval/.tac/test-cell/tac-gitlab-wiki-target-smoke.json');
    expect(command).toContain('PROJECT_PATH = "root/sotopia"');
    expect(command).toContain('target-project-read');
    expect(command).toContain('target-create-wiki-page-api');
    expect(command).toContain('target-read-wiki-page-api');
    expect(command).toContain('target-git-wiki-clone-commit-push');
    expect(command).toContain('target-read-git-wiki-page-api');
    expect(command).toContain('target-delete-api-wiki-page');
    expect(command).toContain('target-delete-git-wiki-page');
    expect(command).toContain('TAC Target Wiki Smoke');
  });

  it('supports a preflight-only self-scored mode for cheap live environment validation', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      preflightOnly: true,
    }) as unknown as { opts: { preflightOnly?: boolean } };

    expect(adapter.opts.preflightOnly).toBe(true);
  });

  it('detects YAML GitLab dependencies written as list items', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      gitlabDependencyProbeCommand: () => string;
    };

    const command = adapter.gitlabDependencyProbeCommand();

    expect(command).toContain('dependencies.yml');
    expect(command).toContain('grep -Eq');
    expect(command).not.toContain('A-Za-z0-9_-');
  });

  it('runs GitLab API readiness checks against task projects before TAC populate scripts', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      tacGitlabApiReadinessCommand: (runDir: string) => string;
      tacInitWithoutResetCommand: () => string;
      tacResetWithHostAliasCommand: () => string;
    };

    const readiness = adapter.tacGitlabApiReadinessCommand('.tac/test-cell');
    const init = adapter.tacInitWithoutResetCommand();
    const reset = adapter.tacResetWithHostAliasCommand();

    expect(readiness).toContain('/eval/.tac/test-cell/tac-gitlab-api-readiness.json');
    expect(readiness).toContain('/api/v4');
    expect(readiness).toContain('/user');
    expect(readiness).toContain('/projects?per_page=1');
    expect(readiness).toContain('GITLAB_PROJECT_PATH|PROJECT_PATH');
    expect(readiness).toContain('/projects/{encoded}/issues?per_page=1');
    expect(readiness).toContain('isinstance(issues, list)');
    expect(init).toContain('could not remove reset step from /utils/init.sh');
    expect(init).toContain('bash /tmp/tac-init-without-reset.sh');
    expect(reset).toContain('the-agent-company.com');
    expect(reset).toContain('bash /utils/reset.sh');
  });

  it('diagnoses an init-only prelude timeout as retryable', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      opentasksTaskPreludeRetries: 1,
    }) as unknown as {
      opentasksTaskPreludeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
        opts: { attempt: number; maxAttempts: number },
      ) => {
        ok: boolean;
        failureReason?: string;
        initOnly: boolean;
        initOnlyTimeout: boolean;
        streamStats: { initEvents: number; assistantEvents: number; toolUseEvents: number; resultEvents: number };
      };
      shouldRetryOpenTasksTaskPrelude: (report: { attempt: number; maxAttempts: number; ok: boolean; initOnlyTimeout: boolean }) => boolean;
    };
    const stdout = JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'opentasks', status: 'pending' }],
      tools: ['Read', 'ToolSearch'],
      skills: ['opentasks'],
    });

    const report = adapter.opentasksTaskPreludeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 124, stdout, stderr: '', timedOut: true },
      { attempt: 1, maxAttempts: 2 },
    );

    expect(report.ok).toBe(false);
    expect(report.failureReason).toContain('timed out after Claude init only');
    expect(report.initOnly).toBe(true);
    expect(report.initOnlyTimeout).toBe(true);
    expect(report.streamStats).toMatchObject({ initEvents: 1, assistantEvents: 0, toolUseEvents: 0, resultEvents: 0 });
    expect(adapter.shouldRetryOpenTasksTaskPrelude(report)).toBe(true);
  });

  it('uses degraded prelude prompt language when the prelude fails', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksTaskPreludeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
        opts: { attempt: number; maxAttempts: number },
      ) => unknown;
      mainPromptWithPrelude: (report: unknown) => string;
    };
    const report = adapter.opentasksTaskPreludeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 124, stdout: '', stderr: '', timedOut: true },
      { attempt: 2, maxAttempts: 2 },
    );

    const prompt = adapter.mainPromptWithPrelude(report);

    expect(prompt).toContain('OpenTasks task prelude did not successfully initialize');
    expect(prompt).toContain('try to initialize OpenTasks yourself');
    expect(prompt).not.toContain('has already initialized the task graph');
  });

  it('uses strict main-agent graph handoff language after a successful prelude', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
    }) as unknown as {
      opentasksTaskPreludeReport: (
        cell: ReturnType<typeof tacArms>[number] extends infer Arm ? { arm: Arm; model: { name: string } } : never,
        agent: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean },
        opts: { attempt: number; maxAttempts: number },
      ) => unknown;
      mainPromptWithPrelude: (report: unknown) => string;
    };
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        mcp_servers: [{ name: 'opentasks', status: 'pending' }],
        tools: ['Read', 'ToolSearch'],
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__opentasks__create_task', input: {} },
            { type: 'tool_use', name: 'mcp__opentasks__record_attempt', input: {} },
            { type: 'tool_use', name: 'mcp__opentasks__list_tasks', input: {} },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      JSON.stringify({ type: 'result', is_error: false, result: 'opentasks task prelude complete', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const report = adapter.opentasksTaskPreludeReport(
      { arm: tacArms(['opentasks'])[0], model: { name: 'haiku' } },
      { exitCode: 0, stdout, stderr: '' },
      { attempt: 1, maxAttempts: 2 },
    );

    const prompt = adapter.mainPromptWithPrelude(report);

    expect(prompt).toContain('Required OpenTasks protocol before task-specific Bash exploration');
    expect(prompt).toContain('select:mcp__opentasks__list_tasks');
    expect(prompt).toContain('Call native mcp__opentasks__list_tasks');
    expect(prompt).toContain('do not create a duplicate top-level task');
    expect(prompt).toContain('record one final outcome');
    expect(prompt).not.toContain('update OpenTasks after each major discovery');
  });
});

describe('TAC adapter guardrail diagnostics', () => {
  it('wraps the main Claude command with a live token monitor when configured', () => {
    const adapter = new TacDockerAdapter({
      timeoutMs: 1,
      initTimeoutMs: 1,
      evalTimeoutMs: 1,
      serverHostname: 'the-agent-company.com',
      network: 'host',
      decryptionKey: 'test',
      liveTokenLimit: 100,
    }) as unknown as {
      agentCommand: (
        cell: {
          task: { id: string; benchmark: string; prompt: string; publicMetadata: Record<string, unknown> };
          arm: ReturnType<typeof tacArms>[number];
          model: { name: string };
        },
        runDir: string,
        priorUsage?: { totalTokens: number },
      ) => string;
    };

    const command = adapter.agentCommand(
      {
        task: { id: 'sde-test', benchmark: 'tac', prompt: 'do thing', publicMetadata: {} },
        arm: tacArms(['stock'])[0],
        model: { name: 'haiku' },
      },
      '.tac/test-cell',
      { totalTokens: 25 },
    );

    expect(command).toContain('/eval/.tac/test-cell/agent-stream-live.jsonl');
    expect(command).toContain('/eval/.tac/test-cell/agent-live-token-budget.json');
    expect(command).toContain('TAC live token budget exceeded');
    expect(command).toContain("'75'");
  });

  it('extracts trace efficiency metrics for graph and service-call overhead', () => {
    const metrics = traceEfficiencyMetrics([
      { type: 'tool', ts: 0, name: 'Read', input: {} },
      {
        type: 'tool',
        ts: 1,
        name: 'ToolSearch',
        input: { query: 'select:mcp__opentasks__get_task,select:mcp__opentasks__record_attempt' },
      },
      { type: 'tool', ts: 2, name: 'mcp__opentasks__list_tasks', input: {} },
      { type: 'tool', ts: 2.5, name: 'mcp__opentasks__get_task', input: { id: 't-1' } },
      {
        type: 'tool',
        ts: 3,
        name: 'Bash',
        input: { command: 'tac-gitlab-api DELETE "/projects/root%2FOpenSearch/repository/branches/feature%2Fssl"' },
      },
      {
        type: 'tool',
        ts: 4,
        name: 'Bash',
        input: { command: 'tac-gitlab-protect-branch root/sotopia main 0 30' },
      },
      {
        type: 'tool',
        ts: 5,
        name: 'Bash',
        input: { command: 'curl -s http://the-agent-company.com:8929/api/v4/projects/root%2FOpenSearch' },
      },
      { type: 'tool', ts: 6, name: 'mcp__opentasks__record_attempt', input: {} },
    ], { seededTaskId: 't-1' });

    expect(metrics).toMatchObject({
      mainToolCallCount: 8,
      mainBashCallCount: 3,
      mainReadCallCount: 1,
      mainToolSearchCallCount: 1,
      mainToolSearchMultiSelectCallCount: 1,
      mainOpenTasksCallCount: 3,
      mainOpenTasksListCallCount: 1,
      mainOpenTasksGetTaskCallCount: 1,
      mainOpenTasksUpdateCallCount: 1,
      openTasksCallsBeforeFirstBash: 2,
      openTasksCallsAfterLastBash: 1,
      openTasksGetTaskCallsBeforeFirstBash: 1,
      mainFullTaskContentReadBeforeFirstBash: 1,
      openTasksGetTaskCallsBeforeFirstTaskWork: 0,
      mainFullTaskContentReadBeforeFirstTaskWork: 0,
      seededTaskGetTaskCallCount: 1,
      seededTaskGetTaskBeforeFirstBashCallCount: 1,
      seededTaskFullContentReadBeforeFirstBash: 1,
      seededTaskGetTaskBeforeFirstTaskWorkCallCount: 0,
      seededTaskFullContentReadBeforeFirstTaskWork: 0,
      mainOpenTasksDistinctToolCount: 3,
      mainOpenTasksListTasksCallCount: 1,
      mainOpenTasksRecordAttemptCallCount: 1,
      gitlabHelperCallCount: 2,
      gitlabHelperApiShorthandCallCount: 1,
      gitlabProtectedBranchHelperCallCount: 1,
      rawGitlabApiCurlCallCount: 1,
    });
  });

  it('does not count full task content as pre-action when get_task happens after Bash', () => {
    const metrics = traceEfficiencyMetrics(
      [
        { type: 'tool', ts: 0, name: 'mcp__opentasks__list_tasks', input: {} },
        { type: 'tool', ts: 1, name: 'Bash', input: { command: 'echo acting' } },
        { type: 'tool', ts: 2, name: 'mcp__opentasks__get_task', input: { id: 't-1' } },
      ],
      { seededTaskId: 't-1' },
    );

    expect(metrics).toMatchObject({
      mainOpenTasksGetTaskCallCount: 1,
      openTasksGetTaskCallsBeforeFirstBash: 0,
      mainFullTaskContentReadBeforeFirstBash: 0,
      openTasksGetTaskCallsBeforeFirstTaskWork: 0,
      mainFullTaskContentReadBeforeFirstTaskWork: 0,
      seededTaskGetTaskCallCount: 1,
      seededTaskGetTaskBeforeFirstBashCallCount: 0,
      seededTaskFullContentReadBeforeFirstBash: 0,
      seededTaskGetTaskBeforeFirstTaskWorkCallCount: 0,
      seededTaskFullContentReadBeforeFirstTaskWork: 0,
    });
  });

  it('counts full task content before task work only when get_task precedes Read Bash and delegation', () => {
    const compliant = traceEfficiencyMetrics(
      [
        { type: 'tool', ts: 0, name: 'ToolSearch', input: {} },
        { type: 'tool', ts: 1, name: 'mcp__opentasks__get_task', input: { id: 't-1' } },
        { type: 'tool', ts: 2, name: 'Read', input: { file_path: '/instruction/task.md' } },
        { type: 'tool', ts: 3, name: 'Bash', input: { command: 'echo acting' } },
      ],
      { seededTaskId: 't-1' },
    );
    const delegatedFirst = traceEfficiencyMetrics(
      [
        { type: 'tool', ts: 0, name: 'ToolSearch', input: {} },
        { type: 'tool', ts: 1, name: 'Agent', input: { prompt: 'inspect task' } },
        { type: 'tool', ts: 2, name: 'mcp__opentasks__get_task', input: { id: 't-1' } },
        { type: 'tool', ts: 3, name: 'Bash', input: { command: 'echo acting' } },
      ],
      { seededTaskId: 't-1' },
    );

    expect(compliant).toMatchObject({
      seededTaskFullContentReadBeforeFirstBash: 1,
      seededTaskFullContentReadBeforeFirstTaskWork: 1,
    });
    expect(delegatedFirst).toMatchObject({
      seededTaskFullContentReadBeforeFirstBash: 1,
      seededTaskFullContentReadBeforeFirstTaskWork: 0,
    });
  });

  it('extracts repeated tool/API failure signals from Claude stream-json', () => {
    const bashToolUse = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -i http://example.test/private' } }],
      },
    };
    const stdout = [
      JSON.stringify(bashToolUse),
      JSON.stringify(bashToolUse),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              is_error: true,
              content: 'HTTP/1.1 401 Unauthorized\n{"message":"invalid_token"}',
            },
          ],
        },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, 'TAC live token budget exceeded: 120 > 100');
    const taxonomy = failureTaxonomy(diagnostics);

    expect(diagnostics.repeatedToolCallCount).toBe(1);
    expect(diagnostics.repeatedBashCommandCount).toBe(1);
    expect(diagnostics.toolErrorCount).toBe(1);
    expect(diagnostics.http401Count).toBeGreaterThan(0);
    expect(diagnostics.authFailureSignalCount).toBeGreaterThan(0);
    expect(diagnostics.liveTokenBudgetExceeded).toBe(1);
    expect(taxonomy.labels).toContain('budget_live_tokens');
    expect(taxonomy.labels).toContain('auth_or_permission');
  });

  it('extracts repeated tool/API failure signals from swarm-harness lane events', () => {
    const stdout = [
      JSON.stringify({
        ts: 1,
        agentId: 'agent-1',
        type: 'tool_use_start',
        payload: { type: 'tool_use_start', id: 't1', name: 'bash' },
      }),
      JSON.stringify({
        ts: 2,
        agentId: 'agent-1',
        type: 'tool_use_input',
        payload: { type: 'tool_use_input', id: 't1', jsonDelta: '{"command":"curl -i http://example.test/missing"}' },
      }),
      JSON.stringify({
        ts: 3,
        agentId: 'agent-1',
        type: 'tool_use_end',
        payload: { type: 'tool_use_end', id: 't1' },
      }),
      JSON.stringify({
        ts: 4,
        agentId: 'agent-1',
        type: 'tool_result',
        payload: { type: 'tool_result', toolUseId: 't1', content: 'HTTP/1.1 404 Not Found', isError: true },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, '');

    expect(diagnostics.toolErrorCount).toBe(1);
    expect(diagnostics.http404Count).toBeGreaterThan(0);
  });

  it('counts broad root filesystem searches from Bash commands only', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: [
                  'find / -name "*plane*"',
                  'grep -R "needle" /',
                  "python3 - <<'PY'",
                  'import glob',
                  "glob.glob('/**/*plane*', recursive=True)",
                  'PY',
                  'find /workspace -name package.json',
                ].join('\n'),
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: 'Prompt reminder: do not run find / or glob("/**/*", recursive=True).',
            },
          ],
        },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, '');
    const taxonomy = failureTaxonomy(diagnostics);

    expect(diagnostics.broadFilesystemSearchCount).toBe(3);
    expect(taxonomy.labels).toContain('broad_filesystem_search');
  });

  it('suppresses failure taxonomy metrics on full TAC success', () => {
    const diagnostics = traceDiagnosticsFromClaudeStream(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'HTTP/1.1 404 Not Found' }] },
      }),
      '',
    );

    const metrics = taxonomyMetricsForTacResult({ final_score: { total: 1, result: 1 } }, diagnostics);

    expect(metrics.taxonomyNotFoundOrWrongTarget).toBe(0);
    expect(metrics.taxonomyUndifferentiatedTaskFailure).toBe(0);
  });

  it('extracts GitLab wiki write signals from commands and tool results', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: [
                  'curl -i --request POST http://the-agent-company.com:8929/api/v4/projects/13/wikis',
                  'git clone http://root:root-token@the-agent-company.com:8929/root/sotopia.wiki.git /tmp/wiki',
                  'git push origin HEAD:master',
                ].join(' && '),
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                'HTTP/1.1 201 Created',
                '{"slug":"Home","format":"markdown"}',
                'To http://the-agent-company.com:8929/root/sotopia.wiki.git',
                ' * [new branch] HEAD -> master',
              ].join('\n'),
            },
          ],
        },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, '');

    expect(diagnostics.gitlabApiWriteAttempts).toBe(1);
    expect(diagnostics.gitlabApiWriteSucceeded).toBe(1);
    expect(diagnostics.wikiGitCloneAttempts).toBe(1);
    expect(diagnostics.wikiGitPushAttempts).toBe(1);
    expect(diagnostics.wikiGitPushSucceeded).toBe(1);
    expect(diagnostics.remoteWikiCreated).toBe(1);
  });

  it('counts GitLab wiki API success from JSON-only curl output', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: 'curl -s -X POST http://the-agent-company.com:8929/api/v4/projects/13/wikis -d @page.json',
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: JSON.stringify({
                format: 'markdown',
                slug: 'Introduction-to-Sotopia',
                title: 'Introduction to Sotopia',
                content: '# Introduction to Sotopia\n\nSotopia is...',
              }),
            },
          ],
        },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, '');

    expect(diagnostics.gitlabApiWriteAttempts).toBe(1);
    expect(diagnostics.gitlabApiWriteSucceeded).toBe(1);
    expect(diagnostics.remoteWikiCreated).toBe(1);
  });

  it('counts GitLab wiki API success from Python requests output', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: {
                command: [
                  'python3 <<EOF',
                  'import requests',
                  'url = "http://the-agent-company.com:8929/api/v4/projects/13/wikis"',
                  'response = requests.post(url, headers={"PRIVATE-TOKEN": "root-token"}, json={"title": "Sotopia Introduction"})',
                  'print(f"Status code: {response.status_code}")',
                  'EOF',
                ].join('\n'),
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: [
                'Status code: 201',
                'Wiki page created successfully!',
                'Title: Sotopia Introduction',
                'Slug: Sotopia-Introduction',
                'URL: http://the-agent-company.com:8929/root/sotopia/-/wikis/Sotopia-Introduction',
              ].join('\n'),
            },
          ],
        },
      }),
    ].join('\n');

    const diagnostics = traceDiagnosticsFromClaudeStream(stdout, '');

    expect(diagnostics.gitlabApiWriteAttempts).toBe(1);
    expect(diagnostics.gitlabApiWriteSucceeded).toBe(1);
    expect(diagnostics.remoteWikiCreated).toBe(1);
  });
});
