/**
 * Tier 2 — multi-agent WorkBench × OpenTasks through swarmkit-eval's native `marble` engine.
 *
 * N agents coordinate on ONE real WorkBench multi_domain task; grading replays the UNION of their
 * side-effecting tool calls, so duplicate side effects (two agents both send the email) = WorkBench
 * harmful actions. OpenTasks' claim_next is meant to prevent exactly that. stock vs opentasks (+ notes)
 * with per-arm completion + harmful + coordination KPIs (R/O/c/E_c, and A_e with EVAL_SOLO).
 *
 * Base OpenTasks functionality only: the service starts ONE per-cell daemon on a SHORT /tmp socket (dodging
 * the macOS 103-byte sun_path limit that a deep-workspace socket hits), publishes it to ws.root/.ot_sock,
 * and every agent connects as a thin `mcp --socket` client (CooperBench pattern). The daemon is reaped by
 * the service's stop() (belt-and-suspenders path-scoped reap after the run). No OpenTasks core change; all
 * WorkBench machinery is in swarmkit-eval.
 *
 * Env: WORKBENCH_REPO · EVAL_MODEL · EVAL_ARMS(stock,opentasks) · EVAL_N(2) · EVAL_DOMAIN(multi_domain) ·
 *      EVAL_TASK_LIMIT(5) · EVAL_CONCURRENCY(1) · EVAL_TIMEOUT(300000) · EVAL_SOLO=1 (A_e) ·
 *      WB_GATEWAY_BASE_URL + WORKBENCH_LLM_API_KEY (Bedrock gateway) else ambient Max-plan auth.
 *
 *   WB_GATEWAY_BASE_URL=http://127.0.0.1:4000 WORKBENCH_LLM_API_KEY=sk-… AWS_REGION=us-east-1 \
 *     EVAL_N=2 EVAL_ARMS=stock,opentasks EVAL_TASK_LIMIT=5 npm run eval:workbench:marble
 */

import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  runEval,
  NativeCliAdapter,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  writeReport,
  workbenchMcpServer,
  workbenchNativeArms,
  type EvalConfig,
  type RunDeps,
  type GatewayConfig,
  type McpServerSpec,
  type ExecutionAdapter,
} from 'swarmkit-eval';
import { workbenchMarbleBenchmark, resolveOpentasksNode } from './workbench-marble.js';
import { ARMS } from '../arms.js';

const WB_REPO = process.env.WORKBENCH_REPO ?? path.join(process.env.HOME ?? '', 'GitHub', 'WorkBench');
const WB_PYTHON = path.join(WB_REPO, '.venv', 'bin', 'python');
const GATEWAY_BASE = process.env.WB_GATEWAY_BASE_URL;
const MODEL = process.env.EVAL_MODEL ?? (GATEWAY_BASE ? 'claude-haiku' : 'haiku');
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,opentasks').split(',').map((s) => s.trim());
const N = Number(process.env.EVAL_N ?? 2);
const DOMAIN = (process.env.EVAL_DOMAIN ?? 'multi_domain') as Parameters<typeof workbenchMarbleBenchmark>[0]['domain'];
// EVAL_TASK_IDS: oversample an exact set of `wb-*` ids (else first-N-in-file-order via EVAL_TASK_LIMIT).
const TASK_IDS = (process.env.EVAL_TASK_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// When ids are pinned, run all of them (cap defaults to their count) unless a smaller limit is set.
const TASK_LIMIT = Number(process.env.EVAL_TASK_LIMIT ?? (TASK_IDS.length || 5));
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 1);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 300_000);
const OUT_DIR = path.resolve(process.cwd(), 'evals/.swarmkit-workbench-marble');

const OPENTASKS_CLI = ARMS.opentasks.mcp?.args?.[0];

/** The OpenTasks coordination primitives the multi-agent arm needs (claim/complete). */
const OT_COORD_TOOLS = [
  'mcp__opentasks__claim_next',
  'mcp__opentasks__get_task',
  'mcp__opentasks__update_task',
  'mcp__opentasks__list_tasks',
  'mcp__opentasks__release_task',
];

function opentasksMcpServer(): McpServerSpec {
  const cli = OPENTASKS_CLI!;
  // Each agent connects to the ONE per-cell daemon over the SHORT socket the service published to
  // ws.root/.ot_sock (CooperBench pattern) — NOT a deep-path autostart, which silently fails the macOS
  // 103-byte sun_path limit. cwd is the agent's cell (ws.root — confirmed by the WorkBench MCP action log
  // landing there), so `cat .ot_sock` resolves the socket. NO_AUTOSTART keeps every agent a thin client.
  // ABI-matched node (NOT the tsx process.execPath, which can't load opentasks' native better-sqlite3).
  const node = resolveOpentasksNode();
  return {
    name: 'opentasks',
    command: 'sh',
    args: ['-c', `exec "${node}" "${cli}" mcp --socket "$(cat .ot_sock)" --scope all`],
    env: { OPENTASKS_NO_AUTOSTART: '1' },
  };
}

/** PIDs of opentasks daemons started from THIS build's CLI (path-scoped reap — never another project's). */
function opentasksDaemonPids(): Set<number> {
  if (!OPENTASKS_CLI) return new Set();
  try {
    const out = execSync('ps -Ao pid=,command=', { encoding: 'utf8' });
    const pids = new Set<number>();
    for (const line of out.split('\n')) {
      if (!line.includes(OPENTASKS_CLI) || !line.includes('daemon start')) continue;
      const pid = parseInt(line.trim().split(/\s+/)[0]!, 10);
      if (Number.isFinite(pid)) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

async function main(): Promise<void> {
  const benchmark = workbenchMarbleBenchmark({ n: N, repoDir: WB_REPO, python: WB_PYTHON, domain: DOMAIN, taskLimit: TASK_LIMIT, ...(TASK_IDS.length ? { taskIds: TASK_IDS } : {}) });
  const wbMcp = workbenchMcpServer({ python: WB_PYTHON, repoDir: WB_REPO });
  // Marble arms: coordination lives in the phase prompt, so arms just carry the MCP servers + allow-list.
  const arms = workbenchNativeArms(wbMcp, [
    { id: 'notes', label: 'notes (claims.txt)' },
    { id: 'opentasks', label: 'opentasks (claim_next)', mcpServers: [opentasksMcpServer()], extraTools: OT_COORD_TOOLS },
  ]).filter((a) => ARM_IDS.includes(a.id));
  if (!arms.length) throw new Error(`No arms matched EVAL_ARMS=${ARM_IDS.join(',')} (have stock,notes,opentasks)`);

  const gateway: GatewayConfig | undefined = GATEWAY_BASE ? { baseUrl: GATEWAY_BASE, fallbacksDisabled: true } : undefined;
  const passEnv: Record<string, string> = {};
  for (const k of ['AWS_REGION', 'AWS_PROFILE']) if (process.env[k]) passEnv[k] = process.env[k]!;

  const config: EvalConfig = {
    runId: `workbench-marble-${DOMAIN}-${MODEL}-N${N}`,
    configVersion: 'v1',
    benchmark: benchmark.id,
    arms,
    models: [{ name: MODEL, ...(gateway ? { dialect: 'anthropic' as const } : {}) }],
    seeds: [1],
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    taskLimit: TASK_LIMIT,
    output: { dir: OUT_DIR, trace: false },
  };

  const agentAdapter: ExecutionAdapter = new NativeCliAdapter({
    defaultModel: MODEL,
    timeoutMs: TIMEOUT,
    env: passEnv,
    ...(gateway ? { gateway, virtualKey: process.env.WORKBENCH_LLM_API_KEY ?? 'sk-eval' } : {}),
  });

  const deps: RunDeps = {
    benchmark,
    backend: new InProcessBackend(),
    store: new LocalResultStore(OUT_DIR),
    marble: { agentAdapter, maxParallelCells: CONCURRENCY },
  };

  console.log(
    `workbench MARBLE · model=${MODEL} arms=${arms.map((a) => a.id).join(',')} N=${N} domain=${DOMAIN} ` +
      `tasks≤${TASK_LIMIT} concurrency=${CONCURRENCY}${gateway ? ' [gateway]' : ' [ambient]'}`,
  );

  const before = opentasksDaemonPids();
  let results;
  try {
    results = await runEval(config, deps);
  } finally {
    const now = opentasksDaemonPids();
    let reaped = 0;
    for (const pid of now) if (!before.has(pid)) { try { process.kill(pid, 'SIGTERM'); reaped++; } catch { /* gone */ } }
    if (reaped) console.log(`reaped ${reaped} stray per-cell opentasks daemon(s)`);
  }

  for (const r of results) {
    const m = r.score?.metrics ?? {};
    console.log(
      `  ${r.armId.padEnd(9)} ${r.taskId}: status=${r.status} completion=${m.completion ?? '-'} harmful=${m.harmful ?? '-'} ` +
        `unionSideEffects=${m.unionSideEffects ?? '-'} R=${m.R !== undefined ? (m.R as number).toFixed(2) : '-'} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  // A_e (error amplification) needs an N=1 solo baseline of the same arms (EVAL_SOLO=1).
  let solo: typeof results | undefined;
  if (process.env.EVAL_SOLO === '1') {
    console.log('  … running N=1 solo baseline for A_e');
    solo = await runEval(config, { ...deps, marble: { agentAdapter, widthOverride: 1, maxParallelCells: CONCURRENCY } });
  }

  const baseline = ARM_IDS.includes('stock') ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'successRate', solo });
  console.log('\n' + renderMarkdownReport(report));
  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
