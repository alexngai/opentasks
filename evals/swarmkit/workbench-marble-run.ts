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
// A cell runs N agents concurrently (the marble engine drives a phase's agents under Promise.all), so the
// model connection pool needs CONCURRENCY × N slots — not CONCURRENCY. Under-provisioning it silently
// serializes the agents, which is invisible in completion/harmful and invalidates any throughput reading
// (see the agentOverlap check below and ../TIER3-THROUGHPUT.md).
const MODEL_CONNECTIONS = Number(process.env.EVAL_MODEL_CONNECTIONS ?? CONCURRENCY * N);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 300_000);
// WB_SEED_MODE changes ONLY the opentasks arm (single-writer vs per-domain seeding+prompt), so single and
// per-domain are DISTINCT experiments. Fold it into runId: the marble store resumes cached cells by
// runId+arm+task, so without this a mode switch on the same ids silently reuses the other mode's stale
// results. Mirrors SEED_MODE in workbench-marble.ts.
const SEED_MODE = process.env.WB_SEED_MODE === 'single' ? 'single' : 'per-domain';
// The `manager` arm (orchestrator-worker baseline) prepends a width-1 `plan` phase to the swarm. Phases
// are a property of the BENCHMARK, not the arm, so enabling it would also spend a wasted planning agent in
// every stock/notes/opentasks cell and invalidate their cached Tier-2 cells. Manager therefore runs as its
// own experiment — own runId, own store dir — and is compared against the others by pairing on task id,
// the same way WB_SEED_MODE=single is compared against per-domain.
const MANAGER = ARM_IDS.includes('manager');
if (MANAGER && ARM_IDS.length > 1) {
  throw new Error(
    `EVAL_ARMS=manager must run ALONE (got: ${ARM_IDS.join(',')}).\n` +
      'The manager arm changes the swarm shape (adds a width-1 plan phase) for every arm in the run, which\n' +
      'would charge the other arms a wasted planning agent and invalidate their cached cells.\n' +
      'Run it separately and pair on task id: EVAL_ARMS=manager EVAL_TASK_IDS=<same ids>',
  );
}
// The gated arm is per-domain BY DESIGN (its point is keeping the parallelism single-writer gives up), so
// WB_SEED_MODE=single would be silently ignored for it while still choosing the store dir — two identical
// experiments filed under different directories. Refuse the combination instead.
if (ARM_IDS.includes('opentasks-gated') && SEED_MODE === 'single') {
  throw new Error(
    'EVAL_ARMS=opentasks-gated is per-domain by design and ignores WB_SEED_MODE=single.\n' +
      'Drop WB_SEED_MODE (or set it to per-domain) — the gate supplies the safety that single-writer\n' +
      'buys by giving up parallelism, so combining them just discards the parallelism again.',
  );
}
// Per-seed-mode store: the marble cache keys cells by benchmark/task/arm/model/seed (NOT runId or seed
// mode), so single and per-domain opentasks cells would otherwise collide and silently reuse each other's
// cached results. A separate store dir per mode keeps each experiment isolated and independently resumable.
// Manager gets its own store dir too: its cells have a different swarm shape (extra plan phase), so they
// must never resume from, or be resumed by, a single-phase cell with the same benchmark/task/arm key.
const OUT_DIR = path.resolve(process.cwd(), `evals/.swarmkit-workbench-marble-${MANAGER ? 'manager' : SEED_MODE}`);

const OPENTASKS_CLI = ARMS.opentasks.mcp?.args?.[0];

/** The OpenTasks coordination primitives the multi-agent arm needs (claim/complete). */
const OT_COORD_TOOLS = [
  'mcp__opentasks__claim_next',
  'mcp__opentasks__get_task',
  'mcp__opentasks__update_task',
  'mcp__opentasks__list_tasks',
  'mcp__opentasks__release_task',
];

/**
 * The WorkBench tool server wrapped in the claim gate (`wb-claim-gate.ts`), which forwards read-only calls
 * and refuses side-effecting ones from an agent holding no live claim — enforcement at the resource rather
 * than in the prompt. The real server spec rides in `WB_GATE_CHILD` and is spawned by the gate as a child.
 *
 * `AGENT_ID` is NOT set here: it is per-agent, and an arm's MCP spec is shared by every agent in the cell.
 * The gate reads it from the environment the marble engine sets per agent and NativeCliAdapter merges into
 * the spawned CLI, which the MCP child inherits. **Confirm that inheritance with the preflight before
 * spending tokens** — the gate fails closed, so if `AGENT_ID` does not arrive, every cell scores 0.00 with
 * zero duplicates and looks superficially like flawless coordination. `gateBroken` in the metrics is what
 * distinguishes the two; a non-zero value invalidates the cell.
 */
function gatedWorkbenchMcpServer(wbMcp: McpServerSpec): McpServerSpec {
  return {
    name: 'workbench',
    command: 'npx',
    args: ['tsx', path.resolve(process.cwd(), 'evals/swarmkit/wb-claim-gate.ts')],
    env: {
      WB_GATE_CHILD: JSON.stringify({ command: wbMcp.command, args: wbMcp.args ?? [], env: wbMcp.env ?? {} }),
      WB_GATE_OT_CLI: OPENTASKS_CLI ?? '',
      WB_GATE_OT_NODE: resolveOpentasksNode(),
      // Relative → resolves against the agent's cell cwd, so the audit log is per-cell for free (the same
      // convention the WorkBench action log uses).
      WB_GATE_LOG: '.wb_gate.jsonl',
    },
  };
}

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
  const benchmark = workbenchMarbleBenchmark({ n: N, repoDir: WB_REPO, python: WB_PYTHON, domain: DOMAIN, taskLimit: TASK_LIMIT, ...(TASK_IDS.length ? { taskIds: TASK_IDS } : {}), ...(MANAGER ? { manager: true } : {}) });
  const wbMcp = workbenchMcpServer({ python: WB_PYTHON, repoDir: WB_REPO });
  // Marble arms: coordination lives in the phase prompt, so arms just carry the MCP servers + allow-list.
  const arms = workbenchNativeArms(wbMcp, [
    { id: 'notes', label: 'notes (claims.txt)' },
    { id: 'manager', label: 'manager (orchestrator assigns)' },
    { id: 'opentasks-gated', label: 'opentasks (claim_next + resource-side gate)', mcpServers: [opentasksMcpServer()], extraTools: OT_COORD_TOOLS },
    { id: 'opentasks', label: 'opentasks (claim_next)', mcpServers: [opentasksMcpServer()], extraTools: OT_COORD_TOOLS },
  ]).filter((a) => ARM_IDS.includes(a.id))
    // The gated arm replaces its WorkBench server with the claim-gate proxy, which spawns the real one as a
    // child. Same MCP name, so the agent still sees exactly `mcp__workbench__*` — the arms differ in what
    // may be COMMITTED, never in what the agent can see or attempt.
    .map((a) => (a.id === 'opentasks-gated'
      ? { ...a, scaffold: { ...a.scaffold, mcpServers: [gatedWorkbenchMcpServer(wbMcp), ...(a.scaffold.mcpServers ?? []).slice(1)] } }
      : a));
  if (!arms.length) throw new Error(`No arms matched EVAL_ARMS=${ARM_IDS.join(',')} (have stock,notes,opentasks)`);

  const gateway: GatewayConfig | undefined = GATEWAY_BASE ? { baseUrl: GATEWAY_BASE, fallbacksDisabled: true } : undefined;
  const passEnv: Record<string, string> = {};
  for (const k of ['AWS_REGION', 'AWS_PROFILE']) if (process.env[k]) passEnv[k] = process.env[k]!;

  const config: EvalConfig = {
    runId: `workbench-marble-${DOMAIN}-${MODEL}-N${N}-${MANAGER ? 'manager' : SEED_MODE}`,
    configVersion: 'v1',
    benchmark: benchmark.id,
    arms,
    models: [{ name: MODEL, ...(gateway ? { dialect: 'anthropic' as const } : {}) }],
    seeds: [1],
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: MODEL_CONNECTIONS },
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
        `cpCalls=${m.criticalPathCalls ?? '-'} active=${m.activeAgents ?? '-'}/${N} ` +
        `overlap=${m.agentOverlap !== undefined ? (m.agentOverlap as number).toFixed(2) : '-'} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  // Gate validity check. The claim gate FAILS CLOSED, so an infra fault (AGENT_ID not reaching the MCP
  // child, or an unreachable daemon) refuses every side effect and yields completion 0.00 with zero
  // duplicates — which reads as flawless coordination. Only the denial REASONS separate the two.
  const brokenCells = results.filter((r) => ((r.score?.metrics?.gateBroken as number | undefined) ?? 0) > 0);
  if (brokenCells.length) {
    console.warn(
      `\n⚠️  ${brokenCells.length}/${results.length} gated cells had gateBroken > 0 — the gate refused calls for` +
        ' infrastructure reasons (no-agent-id / claim-lookup-failed), NOT because coordination worked.\n' +
        '    These cells are INVALID; do not report them. Inspect .wb_gate.jsonl in the cell workspace.\n' +
        "    If the reason is no-agent-id, AGENT_ID is not reaching the MCP child: swarmkit-eval's native-cli\n" +
        '    adapter must add it to each mcpServers[...] env when it writes the MCP config.',
    );
  }

  // Tier-3 substrate check. The marble engine runs a phase's agents under `Promise.all`, but a model
  // connection pool smaller than N serializes them anyway — which makes a real throughput effect read as
  // a null (H3 in ../TIER3-THROUGHPUT.md) with nothing in completion/harmful to reveal it. Warn loudly
  // rather than fail: at N=1, or on cells where only one agent ever acts (single-writer by design), low
  // overlap is CORRECT, so this can't be a hard assertion.
  if (N > 1) {
    const multiAgentCells = results.filter((r) => ((r.score?.metrics?.activeAgents as number | undefined) ?? 0) > 1);
    const serialized = multiAgentCells.filter((r) => ((r.score?.metrics?.agentOverlap as number | undefined) ?? 0) < 0.2);
    if (multiAgentCells.length > 0 && serialized.length === multiAgentCells.length) {
      console.warn(
        `\n⚠️  agentOverlap < 0.2 in ALL ${multiAgentCells.length} cells where >1 agent acted — the agents ran ` +
          `effectively SERIALLY.\n    Any throughput (speedup) reading from this run is invalid. Raise the ` +
          `connection pool: EVAL_CONCURRENCY controls concurrency.modelConnections, which must be ≥ N (${N}).`,
      );
    }
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
