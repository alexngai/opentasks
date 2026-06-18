/**
 * Synthetic emit-queue eval (concurrency × continuity, cells B/C/D) run through swarmkit-eval.
 *
 * The N-agent + collector + reset execution is OpenTasks' own (`../synthetic/*`); swarmkit-eval
 * provides the matrix, the content-addressed store/resume, and — the value-add — the cluster-bootstrap
 * CIs + report over the race metrics (doubleEmits, p2ReEmits), which the local runner reports as raw counts.
 *
 * Env:
 *   EVAL_CELL      B (concurrency) | C (continuity) | D (both)   (default B)
 *   EVAL_MODEL     claude model id (default haiku)
 *   EVAL_ARMS      stock,notes,opentasks
 *   EVAL_N         agents per cell (default 2)
 *   EVAL_M         queue length (default 6)
 *   EVAL_K         items phase 1 does before reset (default ~M/2; cells C/D)
 *   EVAL_REPEATS   trials per arm = bootstrap units (default 3)
 *   EVAL_PHASE1_MS phase-1 budget ms (default 200000)
 *   EVAL_TIMEOUT   per-phase ms (default 240000)
 *   EVAL_CONCURRENCY  concurrent trials (default 1 — each trial is itself an N-agent swarm)
 *   EVAL_FAKE=1    zero-token deterministic runners (validate the pipeline; no agents)
 *   EVAL_PASS_ANTHROPIC=1  forward ANTHROPIC_BASE_URL/API_KEY (GLM-5/gateway); else keychain Max auth
 *
 * Run:
 *   EVAL_FAKE=1 EVAL_CELL=D EVAL_REPEATS=8 npx tsx evals/swarmkit/synth-run.ts   # zero-token validation
 *   npm run build && EVAL_CELL=B EVAL_N=2 EVAL_M=4 EVAL_REPEATS=3 npx tsx evals/swarmkit/synth-run.ts
 */

import * as path from 'node:path';

// Keep the box's ambient (often malformed) ANTHROPIC_BASE_URL out of the spawned agents — the synthetic
// runners spread process.env, and a stray base-url runs the agent as "Not logged in". Default = Max keychain.
if (process.env.EVAL_PASS_ANTHROPIC !== '1') {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
}

import {
  runEval,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  writeReport,
  type EvalConfig,
  type RunDeps,
} from 'swarmkit-eval';
import { SyntheticSwarmAdapter, type SynthCell } from './synth-adapter.js';
import { syntheticArms, syntheticBenchmark } from './synth-bench.js';
import { makeFakeRunners } from './synth-fake.js';
import type { ArmId } from '../types.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const CELL = ((process.env.EVAL_CELL ?? 'B').toUpperCase() as SynthCell);
const N = Number(process.env.EVAL_N ?? 2);
const M = Number(process.env.EVAL_M ?? 6);
const K = Number(process.env.EVAL_K ?? Math.max(1, Math.floor(M / 2)));
const REPEATS = Number(process.env.EVAL_REPEATS ?? 3);
const PHASE1_MS = Number(process.env.EVAL_PHASE1_MS ?? 200_000);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 240_000);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 1);
const FAKE = process.env.EVAL_FAKE === '1';
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks').split(',').map((s) => s.trim()) as ArmId[];
const OUT_DIR = path.resolve(process.cwd(), 'evals/.swarmkit-synth');
const TRACE_DIR = path.resolve(process.cwd(), 'evals/.runs');

const PASSTHROUGH = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE', 'ANTHROPIC_MODEL'];
if (process.env.EVAL_PASS_ANTHROPIC === '1') PASSTHROUGH.push('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY');
const passEnv: Record<string, string> = {};
for (const k of PASSTHROUGH) if (process.env[k]) passEnv[k] = process.env[k]!;

async function main(): Promise<void> {
  const benchmark = syntheticBenchmark(CELL, REPEATS);
  const arms = syntheticArms(ARM_IDS);

  const config: EvalConfig = {
    runId: `synth-${CELL}-${MODEL}-N${N}-M${M}${CELL !== 'B' ? `-K${K}` : ''}`,
    configVersion: 'v1',
    benchmark: `synth-${CELL}`,
    arms,
    models: [{ name: MODEL }],
    seeds: [1],
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    output: { dir: OUT_DIR, trace: false },
  };

  const adapter = new SyntheticSwarmAdapter({
    cell: CELL,
    n: N,
    m: M,
    k: K,
    phase1Ms: PHASE1_MS,
    timeoutMs: TIMEOUT,
    env: passEnv,
    traceDir: TRACE_DIR,
    runners: FAKE ? makeFakeRunners() : undefined,
  });

  const deps: RunDeps = {
    benchmark,
    adapter,
    backend: new InProcessBackend(),
    store: new LocalResultStore(OUT_DIR),
  };

  console.log(
    `synthetic cell ${CELL} · model=${MODEL} arms=${ARM_IDS.join(',')} N=${N} M=${M}` +
      `${CELL !== 'B' ? ` K=${K}` : ''} repeats=${REPEATS} concurrency=${CONCURRENCY}${FAKE ? ' [FAKE]' : ''}`,
  );

  const results = await runEval(config, deps);
  for (const r of results) {
    const m = r.score?.metrics ?? {};
    console.log(
      `  ${r.armId.padEnd(9)} ${r.taskId}: correct=${r.score?.full ?? false} ` +
        `exactlyOnce=${m.exactlyOnce ?? '?'}/${r.score?.total ?? '?'} doubleEmits=${m.doubleEmits ?? '?'}` +
        `${m.p2ReEmits !== undefined ? ` p2ReEmits=${m.p2ReEmits}` : ''} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s` +
        `${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  const baseline = ARM_IDS.includes('stock' as ArmId) ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'successRate' });
  console.log('\n' + renderMarkdownReport(report));

  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
