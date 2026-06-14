/**
 * Core runner: execute one (task × arm × repeat) by spawning a headless
 * `claude -p` agent, capture its tool-call trace + token cost, then score
 * with ground-truth checkpoints.
 *
 * Modeled on skill-tree's eval runner. Differences: stream-json output (so we
 * capture per-tool-call events for the re-exploration / graph-read metrics),
 * and weighted checkpoint scoring (TheAgentCompany S_partial).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Checkpoint, EvalArm, EvalTask, RunResult, ToolCallEvent } from './types.js';
import { computeRedundantExplorationOps, didReadGraph } from './metrics.js';

const BASE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

export interface RunOpts {
  model: string;
  repeat: number;
  timeoutMs: number;
  /** Extra env for the spawned claude (e.g. Bedrock/mantle vars). */
  env?: Record<string, string>;
  traceDir: string;
}

export function runTaskWithArm(task: EvalTask, arm: EvalArm, opts: RunOpts): RunResult {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `otc-${task.id}-${arm.id}-`));
  try {
    for (const f of task.setupFiles ?? []) {
      const p = path.join(workDir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }

    const tools = [...BASE_TOOLS, ...arm.extraTools].join(' ');
    const args = [
      '-p', task.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', opts.model,
      '--allowedTools', tools,
    ];
    if (arm.systemPromptAppendix) args.push('--append-system-prompt', arm.systemPromptAppendix);

    // Eval hygiene: ALWAYS pass an explicit --mcp-config + --strict-mcp-config so
    // the agent sees ONLY the MCP we inject — not the user's global servers /
    // plugins (OMC, cc-swarm, claude.ai connectors), which would otherwise leak
    // an OpenTasks MCP into the "stock"/"notes" arms and break the ablation.
    const mcpFile = path.join(workDir, '.eval-mcp.json');
    const serversCfg = arm.mcp ? { [arm.mcp.name]: { command: arm.mcp.command, args: arm.mcp.args } } : {};
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: serversCfg }));
    args.push('--mcp-config', mcpFile, '--strict-mcp-config');

    // Disable OMC (hangs headless `claude -p`, confounds the eval).
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: '1',
      DISABLE_OMC: '1',
      OMC_SKIP_HOOKS: '1',
      ...(opts.env ?? {}),
    };
    // When auth is via an API key + proxy (GLM-5 through LiteLLM), give the agent
    // a UNIQUE EMPTY CLAUDE_CONFIG_DIR. Critical: otherwise the box's Max-plan
    // login leaks through and overrides the key (LiteLLM "400 No connected db").
    // It also isolates global plugins / CLAUDE.md from the eval.
    if (opts.env?.ANTHROPIC_API_KEY) {
      const cfgDir = path.join(workDir, '.cchome');
      fs.mkdirSync(cfgDir, { recursive: true });
      spawnEnv.CLAUDE_CONFIG_DIR = cfgDir;
    }

    const start = Date.now();
    let stdout = '';
    let timedOut = false;
    let error: string | undefined;
    try {
      stdout = execFileSync('claude', args, {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: opts.timeoutMs,
        maxBuffer: 128 * 1024 * 1024,
        env: spawnEnv,
      });
    } catch (e) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number; signal?: string; killed?: boolean };
      stdout = err.stdout?.toString() ?? '';
      timedOut = err.killed === true || err.signal === 'SIGTERM';
      error = `CLI failed (exit ${err.status}, signal ${err.signal ?? 'none'}${timedOut ? ', TIMEOUT' : ''}): ${(err.stderr?.toString() ?? '').slice(0, 600)}`;
    }
    const durationMs = Date.now() - start;

    const { toolCalls, tokenCost, resultText, mcpServers } = parseStream(stdout);

    // Ground-truth verification, AFTER the agent finishes (it can't see/alter the checks).
    const checkpointResults = task.checkpoints.map((cp) => ({
      id: cp.id,
      weight: cp.weight,
      passed: runCheckpoint(cp, workDir),
    }));
    const total = task.checkpoints.reduce((s, c) => s + c.weight, 0) || 1;
    const earned = checkpointResults.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
    const sFull = checkpointResults.length > 0 && checkpointResults.every((c) => c.passed);
    const sPartial = 0.5 * (earned / total) + 0.5 * (sFull ? 1 : 0);

    // Infra failure (rate-limit/auth/crash): errored with ~no model output, nothing passed.
    const infraFailure = !!error && !timedOut && tokenCost < 200 && earned === 0;

    const result: RunResult = {
      taskId: task.id,
      armId: arm.id,
      repeat: opts.repeat,
      model: opts.model,
      checkpointResults,
      sPartial,
      sFull,
      tokenCost,
      durationMs,
      mcpServers,
      toolCalls,
      redundantExplorationOps: computeRedundantExplorationOps(toolCalls),
      readGraph: didReadGraph(toolCalls),
      timedOut,
      infraFailure,
      error,
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `${task.id}__${arm.id}__r${opts.repeat}.json`),
      JSON.stringify({ ...result, resultText: resultText.slice(0, 4000) }, null, 2),
    );

    return result;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/** Parse the `--output-format stream-json` NDJSON: init mcp status + tool_use events + final usage. */
function parseStream(stdout: string): {
  toolCalls: ToolCallEvent[];
  tokenCost: number;
  resultText: string;
  mcpServers: { name: string; status: string }[];
} {
  const toolCalls: ToolCallEvent[] = [];
  let tokenCost = 0;
  let resultText = '';
  let mcpServers: { name: string; status: string }[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === 'system' && obj.subtype === 'init') {
      const raw = (obj.mcp_servers as Array<{ name?: string; status?: string }> | undefined) ?? [];
      mcpServers = raw.map((s) => ({ name: s.name ?? 'unknown', status: s.status ?? 'unknown' }));
    } else if (obj.type === 'assistant') {
      const content = (obj.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
        if (block.type === 'tool_use') toolCalls.push({ name: block.name ?? 'unknown', input: block.input });
      }
    } else if (obj.type === 'result') {
      resultText = typeof obj.result === 'string' ? obj.result : '';
      // Prefer modelUsage (real per-model token counts; for GLM-5 via LiteLLM
      // this is the only honest source — top-level `total_cost_usd` is LiteLLM
      // estimating against Anthropic pricing and is meaningless). Sum across
      // models (usually one). Fall back to top-level usage for the native path.
      const mu = obj.modelUsage as
        | Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
        | undefined;
      if (mu && Object.keys(mu).length) {
        for (const m of Object.values(mu)) {
          tokenCost +=
            (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
        }
      } else {
        const u = (obj.usage ?? {}) as Record<string, number>;
        tokenCost =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.output_tokens ?? 0);
      }
    }
  }
  return { toolCalls, tokenCost, resultText, mcpServers };
}

function runCheckpoint(cp: Checkpoint, cwd: string): boolean {
  const c = cp.check;
  try {
    if (c.type === 'fileExists') return fs.existsSync(path.join(cwd, c.path));
    if (c.type === 'fileContains') {
      const p = path.join(cwd, c.path);
      return fs.existsSync(p) && new RegExp(c.pattern, 'm').test(fs.readFileSync(p, 'utf-8'));
    }
    if (c.type === 'cmd') {
      execFileSync('bash', ['-c', c.cmd], { cwd, stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
