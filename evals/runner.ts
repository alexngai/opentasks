/**
 * Core runner: execute one (task × arm × repeat) by spawning a headless
 * `claude -p` agent, capture its tool-call trace + token cost, then score
 * with ground-truth checkpoints.
 *
 * Modeled on skill-tree's eval runner. Differences: stream-json output (so we
 * capture per-tool-call events for the re-exploration / graph-read metrics),
 * and weighted checkpoint scoring (TheAgentCompany S_partial).
 *
 * The spawn/parse/score internals are factored into reusable pieces
 * (`runAgentPhase`, `scoreCheckpoints`, `stopOpentasksDaemon`) so the
 * cross-session continuity runner (`reset-runner.ts`) can drive TWO phases in
 * one persistent work dir without duplicating any of this.
 */

import { execFileSync, spawnSync } from 'node:child_process';
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

/** One headless `claude -p` invocation in a (persistent) work dir. */
export interface PhaseOpts {
  workDir: string;
  prompt: string;
  arm: EvalArm;
  model: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface PhaseResult {
  toolCalls: ToolCallEvent[];
  tokenCost: number;
  resultText: string;
  mcpServers: { name: string; status: string }[];
  durationMs: number;
  timedOut: boolean;
  /**
   * The agent reached a final `result` event (ran its turn to completion). False
   * means it was cut off — by a wall-clock SIGTERM (note: `claude -p` exits 0 on
   * SIGTERM, so `timedOut`/`error` can be unset even when interrupted) or a crash.
   * This is the robust "was phase 1 interrupted?" signal.
   */
  completedCleanly: boolean;
  error?: string;
}

export interface ScoreResult {
  checkpointResults: { id: string; passed: boolean; weight: number }[];
  sPartial: number;
  sFull: boolean;
  earned: number;
  total: number;
}

/**
 * Spawn ONE headless agent against an existing work dir and return its trace.
 * Does NOT create or delete the work dir — the caller owns its lifecycle (so a
 * reset run can invoke this twice against the same dir for cross-session
 * continuity). Idempotent setup (mcp config, isolated config dir) is safe to
 * re-run across phases.
 */
export function runAgentPhase(opts: PhaseOpts): PhaseResult {
  const { workDir, arm } = opts;

  const tools = [...BASE_TOOLS, ...arm.extraTools].join(' ');
  const args = [
    '-p', opts.prompt,
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
  // It also isolates global plugins / CLAUDE.md from the eval. Reusing the same
  // dir across phases is safe: each `claude -p` is its own one-shot session (no
  // --resume), so there is NO conversation carryover — only the work dir is.
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

  const parsed = parseStream(stdout);
  return {
    toolCalls: parsed.toolCalls,
    // A wall-clock-killed phase never emits the final `result` usage; fall back
    // to the summed per-assistant-message usage so phase-1 cost isn't counted 0.
    // (Note: GLM-5 via LiteLLM emits neither for a killed phase → phase-1 cost
    // can read 0. Acceptable: phase 2, the re-orientation headline, completes
    // cleanly and reports real usage.)
    tokenCost: parsed.tokenCost > 0 ? parsed.tokenCost : parsed.streamedTokens,
    resultText: parsed.resultText,
    mcpServers: parsed.mcpServers,
    durationMs,
    timedOut,
    completedCleanly: parsed.sawResult,
    error,
  };
}

/** Ground-truth verification against the work dir (the agent can't see/alter it). */
export function scoreCheckpoints(task: EvalTask, workDir: string): ScoreResult {
  const checkpointResults = task.checkpoints.map((cp) => ({
    id: cp.id,
    weight: cp.weight,
    passed: runCheckpoint(cp, workDir),
  }));
  const total = task.checkpoints.reduce((s, c) => s + c.weight, 0) || 1;
  const earned = checkpointResults.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  const sFull = checkpointResults.length > 0 && checkpointResults.every((c) => c.passed);
  const sPartial = 0.5 * (earned / total) + 0.5 * (sFull ? 1 : 0);
  return { checkpointResults, sPartial, sFull, earned, total };
}

/** Seed the task's setup files into a fresh work dir. */
export function seedWorkDir(task: EvalTask, prefix: string): string {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of task.setupFiles ?? []) {
    const p = path.join(workDir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
  return workDir;
}

/**
 * Stop the per-work-dir OpenTasks daemon (it detaches and survives the agent
 * exit). Must run BEFORE deleting the work dir, or the daemon is orphaned. No-op
 * for non-opentasks arms / if no daemon was started.
 */
export function stopOpentasksDaemon(workDir: string, env?: Record<string, string>): void {
  if (!fs.existsSync(path.join(workDir, '.opentasks'))) return;
  const cli = path.resolve(process.cwd(), 'dist/cli.js');
  if (!fs.existsSync(cli)) return;
  spawnSync(process.execPath, [cli, 'daemon', 'stop'], {
    cwd: workDir,
    env: { ...process.env, ...(env ?? {}) },
    stdio: 'ignore',
    timeout: 15_000,
  });
}

export function cleanupWorkDir(workDir: string): void {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

export function runTaskWithArm(task: EvalTask, arm: EvalArm, opts: RunOpts): RunResult {
  const workDir = seedWorkDir(task, `otc-${task.id}-${arm.id}-`);
  try {
    const phase = runAgentPhase({
      workDir,
      prompt: task.prompt,
      arm,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });

    const score = scoreCheckpoints(task, workDir);
    // Infra failure (rate-limit/auth/crash): errored with ~no model output, nothing passed.
    const infraFailure = !!phase.error && !phase.timedOut && phase.tokenCost < 200 && score.earned === 0;

    const result: RunResult = {
      taskId: task.id,
      armId: arm.id,
      repeat: opts.repeat,
      model: opts.model,
      checkpointResults: score.checkpointResults,
      sPartial: score.sPartial,
      sFull: score.sFull,
      tokenCost: phase.tokenCost,
      durationMs: phase.durationMs,
      mcpServers: phase.mcpServers,
      toolCalls: phase.toolCalls,
      redundantExplorationOps: computeRedundantExplorationOps(phase.toolCalls),
      readGraph: didReadGraph(phase.toolCalls),
      timedOut: phase.timedOut,
      infraFailure,
      error: phase.error,
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `${task.id}__${arm.id}__r${opts.repeat}.json`),
      JSON.stringify({ ...result, resultText: phase.resultText.slice(0, 4000) }, null, 2),
    );

    return result;
  } finally {
    stopOpentasksDaemon(workDir, opts.env);
    cleanupWorkDir(workDir);
  }
}

/** Parse the `--output-format stream-json` NDJSON: init mcp status + tool_use events + final usage. */
function parseStream(stdout: string): {
  toolCalls: ToolCallEvent[];
  tokenCost: number;
  streamedTokens: number;
  resultText: string;
  mcpServers: { name: string; status: string }[];
  sawResult: boolean;
} {
  const toolCalls: ToolCallEvent[] = [];
  let tokenCost = 0;
  let streamedTokens = 0;
  let resultText = '';
  let sawResult = false;
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
      const msg = obj.message as { content?: unknown[]; usage?: Record<string, number> } | undefined;
      const content = msg?.content ?? [];
      for (const block of content as Array<{ type?: string; name?: string; input?: unknown }>) {
        if (block.type === 'tool_use') toolCalls.push({ name: block.name ?? 'unknown', input: block.input });
      }
      // Per-message usage — summed as a fallback for phases killed before the
      // final `result` event (wall-clock-capped phase 1).
      const u = msg?.usage;
      if (u) {
        streamedTokens +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.output_tokens ?? 0);
      }
    } else if (obj.type === 'result') {
      sawResult = true;
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
  return { toolCalls, tokenCost, streamedTokens, resultText, mcpServers, sawResult };
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
