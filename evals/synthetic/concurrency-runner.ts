/**
 * Cell-B (concurrency) runner: spawn N headless agents CONCURRENTLY against one
 * shared work dir + shared emit collector + (for the opentasks arm) one shared
 * task-graph daemon. Measure exactly-once. This is the safety microbenchmark:
 * does an atomic claim prevent the double-emit race that stock / racy-notes can't?
 *
 * Distinct from runner.ts (single agent, own dir): here the shared substrate IS
 * the experiment, so all N agents share cwd, the daemon, and the collector;
 * only per-agent CLAUDE_CONFIG_DIR + AGENT_ID differ.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { BASE_TOOLS, parseStream, stopOpentasksDaemon, cleanupWorkDir } from '../runner.js';
import { startCollector, scoreExactlyOnce, type Collector, type ExactlyOnceScore } from './collector.js';
import { SYNTH_ARMS, makeItems, buildPrompt, seedOpentasksGraph, type SynthArm } from './emit-queue.js';
import type { ArmId } from '../types.js';

const pexecFile = promisify(execFile);

export interface ConcurrencyOpts {
  model: string;
  n: number;
  m: number;
  repeat: number;
  timeoutMs: number;
  env?: Record<string, string>;
  traceDir: string;
}

export interface AgentSummary {
  agentId: string;
  tokenCost: number;
  numToolCalls: number;
  durationMs: number;
  usedClaim: boolean;
  emits: number;
  timedOut: boolean;
  error?: string;
}

export interface ConcurrencyResult {
  armId: ArmId;
  model: string;
  n: number;
  m: number;
  repeat: number;
  score: ExactlyOnceScore;
  tokenCost: number;
  durationMs: number;
  mcpConnected: boolean;
  agents: AgentSummary[];
}

export async function runOneAgent(args: {
  workDir: string;
  arm: SynthArm;
  agentId: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  env?: Record<string, string>;
  mcpFile: string;
}): Promise<{ summary: AgentSummary; mcpConnected: boolean }> {
  const { workDir, arm, agentId, model, timeoutMs } = args;
  const tools = [...BASE_TOOLS, ...arm.extraTools].join(' ');
  const cliArgs = [
    '-p', args.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--allowedTools', tools,
    '--mcp-config', args.mcpFile,
    '--strict-mcp-config',
  ];

  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    DISABLE_OMC: '1',
    OMC_SKIP_HOOKS: '1',
    AGENT_ID: agentId, // the emit script stamps this on each emit
    ...(args.env ?? {}),
  };
  // Per-agent isolated config dir on the API-key path (else N concurrent agents
  // clobber each other's session config and the Max-plan login leaks the key).
  if (args.env?.ANTHROPIC_API_KEY) {
    const cfgDir = path.join(workDir, `.cchome-${agentId}`);
    fs.mkdirSync(cfgDir, { recursive: true });
    spawnEnv.CLAUDE_CONFIG_DIR = cfgDir;
  }

  const start = Date.now();
  let stdout = '';
  let timedOut = false;
  let error: string | undefined;
  try {
    const r = await pexecFile('claude', cliArgs, {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env: spawnEnv,
    });
    stdout = r.stdout;
  } catch (e) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; signal?: string; killed?: boolean };
    stdout = err.stdout?.toString() ?? '';
    timedOut = err.killed === true || err.signal === 'SIGTERM';
    error = `exit ${err.code} sig ${err.signal ?? 'none'}${timedOut ? ' TIMEOUT' : ''}: ${(err.stderr?.toString() ?? '').slice(0, 300)}`;
  }
  const durationMs = Date.now() - start;
  const parsed = parseStream(stdout);
  const mcpConnected = parsed.mcpServers.some((s) => s.name === 'opentasks' && s.status === 'connected');
  const usedClaim = parsed.toolCalls.some((tc) => tc.name === 'mcp__opentasks__claim_next');

  return {
    mcpConnected,
    summary: {
      agentId,
      tokenCost: parsed.tokenCost > 0 ? parsed.tokenCost : parsed.streamedTokens,
      numToolCalls: parsed.toolCalls.length,
      durationMs,
      usedClaim,
      emits: 0, // filled from collector after the run
      timedOut,
      error,
    },
  };
}

/**
 * Build the shared substrate (work dir + collector + emit script + arm state +
 * mcp config). Used by both the concurrency (cell B) and continuity (cell C/D)
 * runners so the seeding stays identical.
 */
export async function setupSharedDir(
  arm: SynthArm,
  items: string[],
  env?: Record<string, string>,
): Promise<{ workDir: string; collector: Collector; mcpFile: string }> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `otc-synth-${arm.id}-`));
  const collector = await startCollector();
  // Emit script — the non-idempotent, not-on-disk side-effect (no read path).
  const emitPath = path.join(workDir, 'emit');
  fs.writeFileSync(
    emitPath,
    [
      '#!/bin/sh',
      `curl -s -X POST "http://127.0.0.1:${collector.port}/emit" --data-urlencode "id=$1" --data-urlencode "agent=\${AGENT_ID:-unknown}" >/dev/null 2>&1`,
      'echo "emitted $1"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(emitPath, 0o755);
  // Work-list delivery: queue.txt for stock/notes; graph nodes for opentasks.
  if (!arm.itemsViaGraph) fs.writeFileSync(path.join(workDir, 'queue.txt'), items.join('\n') + '\n');
  // Shared MCP config (one file, all agents read it; same bytes).
  const mcpFile = path.join(workDir, '.eval-mcp.json');
  const serversCfg = arm.mcp ? { [arm.mcp.name]: { command: arm.mcp.command, args: arm.mcp.args } } : {};
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: serversCfg }));
  if (arm.itemsViaGraph) {
    seedOpentasksGraph(workDir, items, { ...process.env, ...(env ?? {}) } as NodeJS.ProcessEnv);
  }
  return { workDir, collector, mcpFile };
}

export async function teardownSharedDir(
  workDir: string,
  collector: Collector,
  env?: Record<string, string>,
): Promise<void> {
  await collector.close();
  stopOpentasksDaemon(workDir, env);
  cleanupWorkDir(workDir);
}

export async function runConcurrencyCell(armId: ArmId, opts: ConcurrencyOpts): Promise<ConcurrencyResult> {
  const arm = SYNTH_ARMS[armId];
  if (!arm) throw new Error(`Unknown synthetic arm: ${armId}`);
  const items = makeItems(opts.m);
  const { workDir, collector, mcpFile } = await setupSharedDir(arm, items, opts.env);

  try {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: opts.n }, (_, i) =>
        runOneAgent({
          workDir,
          arm,
          agentId: `agent-${i + 1}`,
          prompt: buildPrompt(arm, { items, agentId: `agent-${i + 1}`, m: opts.m }),
          model: opts.model,
          timeoutMs: opts.timeoutMs,
          env: opts.env,
          mcpFile,
        }),
      ),
    );
    const durationMs = Date.now() - start;

    const score = scoreExactlyOnce(collector.records, items);
    // Attribute emits per agent from the collector.
    const perAgent = new Map<string, number>();
    for (const r of collector.records) perAgent.set(r.agent, (perAgent.get(r.agent) ?? 0) + 1);
    const agents = results.map((r) => ({ ...r.summary, emits: perAgent.get(r.summary.agentId) ?? 0 }));

    const result: ConcurrencyResult = {
      armId,
      model: opts.model,
      n: opts.n,
      m: opts.m,
      repeat: opts.repeat,
      score,
      tokenCost: agents.reduce((s, a) => s + a.tokenCost, 0),
      durationMs,
      mcpConnected: results.some((r) => r.mcpConnected),
      agents,
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `concB__${armId}__n${opts.n}__m${opts.m}__r${opts.repeat}.json`),
      JSON.stringify({ ...result, emitTimeline: collector.records }, null, 2),
    );

    return result;
  } finally {
    await teardownSharedDir(workDir, collector, opts.env);
  }
}
