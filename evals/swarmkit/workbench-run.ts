/**
 * OpenTasks × WorkBench eval — benchmark OpenTasks (as a planning/coordination scaffold)
 * on WorkBench (olly-styles/WorkBench "Revisited": outcome-graded workplace-agent tasks).
 *
 * All WorkBench-specific machinery lives in `swarmkit-eval` (the tool bridge `wb_mcp.py`,
 * the faithful `{kind:"workbench"}` grader, the benchmark). This entrypoint only COMPOSES:
 *   swarmkit-eval's WorkBench benchmark  +  OpenTasks arms  →  runEval → paired report.
 *
 * Arms (the independent variable — same model, same tasks, only the scaffold varies):
 *   stock      WorkBench tools only (mcp__workbench__*)
 *   notes      + a NOTES.md durable-log nudge
 *   opentasks  + the OpenTasks MCP graph (mcp__opentasks__*) as a planning/decomposition scaffold
 *
 * Base OpenTasks functionality only — NO daemon changes required:
 *   • per-cell isolation: a RELATIVE OPENTASKS_PROJECT_DIR=.opentasks resolves against each
 *     cell's workspace cwd, so every cell gets its own .opentasks/ + daemon socket.
 *   • teardown: the auto-started (detached) daemon outlives the cell, so after the run we reap
 *     ONLY the opentasks daemons that appeared during this run (targeted; never touches
 *     pre-existing daemons). Optionally set OPENTASKS_DAEMON_IDLE_TIMEOUT to let them self-reap
 *     (a no-op on base builds that don't support it).
 *
 * Env:
 *   WORKBENCH_REPO       WorkBench checkout (default ~/GitHub/WorkBench; needs `uv sync` + `uv pip install mcp`)
 *   EVAL_MODEL           model under test (default claude-haiku for gateway, else haiku)
 *   EVAL_ARMS            comma list (default stock,opentasks)
 *   EVAL_DOMAIN          email | calendar | analytics | project_management | crm | multi_domain (default email)
 *   EVAL_TASK_LIMIT      cap tasks (default 5)
 *   EVAL_REPEATS         seeds per cell (default 1)
 *   EVAL_CONCURRENCY     concurrent cells (default 2)
 *   EVAL_TIMEOUT         per-cell ms (default 300000)
 *   WB_GATEWAY_BASE_URL  route the model through a LiteLLM gateway (else ambient Max-plan auth)
 *   WORKBENCH_LLM_API_KEY  gateway master key (with WB_GATEWAY_BASE_URL)
 *
 * Run:
 *   npm run build                                                    # build opentasks (dist/cli.js for the MCP arm)
 *   WB_GATEWAY_BASE_URL=http://127.0.0.1:4000 WORKBENCH_LLM_API_KEY=sk-… AWS_REGION=us-east-1 \
 *     EVAL_ARMS=stock,opentasks EVAL_TASK_LIMIT=5 npx tsx evals/swarmkit/workbench-run.ts
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
  workbenchNativeBenchmark,
  workbenchMcpServer,
  workbenchNativeArms,
  type EvalConfig,
  type RunDeps,
  type GatewayConfig,
  type McpServerSpec,
  type WorkbenchNativeArmSpec,
} from 'swarmkit-eval';
import { ARMS } from '../arms.js';

const WB_REPO = process.env.WORKBENCH_REPO ?? path.join(process.env.HOME ?? '', 'GitHub', 'WorkBench');
const WB_PYTHON = path.join(WB_REPO, '.venv', 'bin', 'python');
const GATEWAY_BASE = process.env.WB_GATEWAY_BASE_URL;
const MODEL = process.env.EVAL_MODEL ?? (GATEWAY_BASE ? 'claude-haiku' : 'haiku');
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,opentasks').split(',').map((s) => s.trim());
const DOMAIN = (process.env.EVAL_DOMAIN ?? 'email') as Parameters<typeof workbenchNativeBenchmark>[0]['domain'];
const TASK_LIMIT = Number(process.env.EVAL_TASK_LIMIT ?? 5);
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 2);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 300_000);
const OUT_DIR = path.resolve(process.cwd(), 'evals/.swarmkit-workbench');

// WorkBench-appropriate planning nudge for the opentasks arm — deliberately generic (task
// decomposition + progress tracking), NOT the TAC/openswarm-specific appendix in ../arms.ts.
const PLANNING_APPENDIX =
  'You have an OpenTasks MCP graph (native tools prefixed mcp__opentasks__) for planning. For a ' +
  'multi-step workplace task, first break it into subtasks with mcp__opentasks__create_task, then ' +
  'work through them, marking each done with mcp__opentasks__update_task and re-checking what remains ' +
  'before you finish. Perform the actual workplace actions with the WorkBench tools (mcp__workbench__*). ' +
  'Use native MCP tools directly — do not invoke mcp__ names as shell commands.';

const NOTES_APPENDIX =
  'Maintain a NOTES.md file in the working directory as your durable plan/progress log: record the ' +
  'subgoals, what you have done, and what remains; re-read it before finishing.';

/** The OpenTasks MCP graph as a swarmkit MCP server — RELATIVE OPENTASKS_PROJECT_DIR = per-cell isolation. */
function opentasksMcpServer(): McpServerSpec {
  const src = ARMS.opentasks.mcp;
  if (!src) throw new Error('ARMS.opentasks.mcp is undefined (expected the opentasks MCP command)');
  const env: Record<string, string> = { OPENTASKS_PROJECT_DIR: '.opentasks' };
  // Optional: if the local opentasks build supports it, let per-cell daemons self-reap. Harmless otherwise.
  if (process.env.OPENTASKS_DAEMON_IDLE_TIMEOUT) env.OPENTASKS_DAEMON_IDLE_TIMEOUT = process.env.OPENTASKS_DAEMON_IDLE_TIMEOUT;
  return { name: src.name, command: src.command, args: src.args, env };
}

// The absolute opentasks CLI this eval launches (dist/cli.js). Matching daemons by THIS exact path keeps
// the reap from ever touching a daemon from another project (e.g. a different repo's opentasks install).
const OPENTASKS_CLI = ARMS.opentasks.mcp?.args?.[0];

/** PIDs of opentasks daemons started from THIS build's CLI (for a targeted, path-scoped post-run reap). */
function opentasksDaemonPids(): Set<number> {
  if (!OPENTASKS_CLI) return new Set();
  try {
    // ps → keep only lines that are BOTH this exact cli.js path AND a `daemon start`.
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
  const benchmark = workbenchNativeBenchmark({ repoDir: WB_REPO, python: WB_PYTHON, domain: DOMAIN });
  const wbMcp = workbenchMcpServer({ python: WB_PYTHON, repoDir: WB_REPO });
  const specs: WorkbenchNativeArmSpec[] = [
    { id: 'notes', label: 'notes (NOTES.md)', systemPromptAppendix: NOTES_APPENDIX },
    {
      id: 'opentasks',
      label: 'opentasks (MCP graph)',
      systemPromptAppendix: PLANNING_APPENDIX,
      mcpServers: [opentasksMcpServer()],
      extraTools: ARMS.opentasks.extraTools,
    },
  ];
  const arms = workbenchNativeArms(wbMcp, specs).filter((a) => ARM_IDS.includes(a.id));
  if (arms.length === 0) throw new Error(`No arms matched EVAL_ARMS=${ARM_IDS.join(',')} (have stock,notes,opentasks)`);

  const gateway: GatewayConfig | undefined = GATEWAY_BASE ? { baseUrl: GATEWAY_BASE, fallbacksDisabled: true } : undefined;
  const passEnv: Record<string, string> = {};
  for (const k of ['AWS_REGION', 'AWS_PROFILE']) if (process.env[k]) passEnv[k] = process.env[k]!;

  const config: EvalConfig = {
    runId: `workbench-${DOMAIN}-${MODEL}`,
    configVersion: 'v1',
    benchmark: benchmark.id,
    arms,
    models: [{ name: MODEL, ...(gateway ? { dialect: 'anthropic' as const } : {}) }],
    seeds: Array.from({ length: REPEATS }, (_, i) => i + 1),
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    taskLimit: TASK_LIMIT,
    retry: { maxAttempts: 2, baseDelayMs: 1000 },
    output: { dir: OUT_DIR, trace: false },
  };

  const deps: RunDeps = {
    benchmark,
    backend: new InProcessBackend(),
    store: new LocalResultStore(OUT_DIR),
    adapter: new NativeCliAdapter({
      defaultModel: MODEL,
      timeoutMs: TIMEOUT,
      env: passEnv,
      ...(gateway ? { gateway, virtualKey: process.env.WORKBENCH_LLM_API_KEY ?? 'sk-eval' } : {}),
    }),
  };

  console.log(
    `workbench × opentasks · model=${MODEL} arms=${arms.map((a) => a.id).join(',')} domain=${DOMAIN} ` +
      `tasks≤${TASK_LIMIT} repeats=${REPEATS} concurrency=${CONCURRENCY}${gateway ? ' [gateway]' : ' [ambient]'}`,
  );

  const daemonsBefore = opentasksDaemonPids();
  let results;
  try {
    results = await runEval(config, deps);
  } finally {
    // Base-functionality teardown: reap ONLY the opentasks daemons that appeared during this run.
    const now = opentasksDaemonPids();
    let reaped = 0;
    for (const pid of now) if (!daemonsBefore.has(pid)) { try { process.kill(pid, 'SIGTERM'); reaped++; } catch { /* gone */ } }
    if (reaped) console.log(`reaped ${reaped} per-cell opentasks daemon(s)`);
  }

  for (const r of results) {
    const m = r.score?.metrics ?? {};
    console.log(
      `  ${r.taskId} | ${r.armId.padEnd(9)} seed${r.seed}: status=${r.status} ` +
        `completion=${m.completion ?? '-'} harmful=${m.harmful ?? '-'} tools=${m.numToolCalls ?? '-'} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s` +
        `${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  const baseline = ARM_IDS.includes('stock') ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'sPartial' });
  console.log('\n' + renderMarkdownReport(report));
  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
