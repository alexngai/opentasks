/**
 * OpenTasks eval — run through the shared `swarmkit-eval` package.
 *
 * Same RCT as ../run.ts (stock / notes / opentasks arms, ground-truth checkpoints,
 * S_partial), but the harness (matrix → sealed boundary → claude -p → grade →
 * content-addressed store/resume → stats → report) is swarmkit-eval, not the local
 * runner. Proves the ecosystem can share one eval substrate.
 *
 * Env:
 *   EVAL_MODEL        claude --model id (default haiku)
 *   EVAL_ARMS         comma list (default stock,notes,opentasks)
 *   EVAL_TASKS        comma list (default smoke-greeting)  [also: build-todo]
 *   EVAL_REPEATS      seeds per cell (default 1)
 *   EVAL_TIMEOUT      per-cell ms (default 600000)
 *   EVAL_CONCURRENCY  concurrent cells (default 2)
 *   EVAL_MOCK=1       use the zero-token MockAdapter (smoke task) to validate plumbing
 *   (Bedrock/GLM-5 vars CLAUDE_CODE_USE_BEDROCK/AWS_REGION/ANTHROPIC_BASE_URL/… are passed through)
 *
 * Run:
 *   EVAL_MOCK=1 npx tsx evals/swarmkit/run.ts                       # zero-token plumbing check
 *   EVAL_ARMS=stock,notes npx tsx evals/swarmkit/run.ts            # real, no MCP/build needed
 *   npm run build && npx tsx evals/swarmkit/run.ts                 # all 3 arms (opentasks MCP)
 */

import * as path from 'node:path';
import {
  runEval,
  NativeCliAdapter,
  MockAdapter,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  writeReport,
  type EvalConfig,
  type RunDeps,
} from 'swarmkit-eval';

import { opentasksBenchmark, opentasksArms, smokeMockSpec } from './bench.js';
import type { ArmId } from '../types.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks').split(',').map((s) => s.trim()) as ArmId[];
const TASK_IDS = (process.env.EVAL_TASKS ?? 'smoke-greeting').split(',').map((s) => s.trim());
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 600_000);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 2);
const MOCK = process.env.EVAL_MOCK === '1';
const OUT_DIR = path.resolve(process.cwd(), 'evals/.swarmkit-runs');

// Pass Bedrock env through to the spawned agent (creds from the AWS profile/env).
// NOTE: ANTHROPIC_BASE_URL/API_KEY are only forwarded under EVAL_PASS_ANTHROPIC=1 (an explicit
// GLM-5/gateway run). By default they are NOT forwarded so the box's Max-plan keychain auth is used —
// ambient ANTHROPIC_BASE_URL (Claude Code sets one) would otherwise point claude at the wrong endpoint
// and run it as "Not logged in".
const PASSTHROUGH = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE', 'ANTHROPIC_MODEL'];
if (process.env.EVAL_PASS_ANTHROPIC === '1') PASSTHROUGH.push('ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY');
const passEnv: Record<string, string> = {};
for (const k of PASSTHROUGH) if (process.env[k]) passEnv[k] = process.env[k]!;

async function main(): Promise<void> {
  const benchmark = opentasksBenchmark(TASK_IDS);
  const arms = opentasksArms(ARM_IDS);

  const config: EvalConfig = {
    runId: `opentasks-${MODEL}-${TASK_IDS.join('+')}`,
    configVersion: 'v1',
    benchmark: 'opentasks',
    arms,
    models: [{ name: MODEL }],
    seeds: Array.from({ length: REPEATS }, (_, i) => i + 1),
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    retry: { maxAttempts: 2, baseDelayMs: 1000 },
    output: { dir: OUT_DIR, trace: true },
  };

  const store = new LocalResultStore(OUT_DIR);
  const deps: RunDeps = {
    benchmark,
    backend: new InProcessBackend(),
    store,
    adapter: MOCK
      ? new MockAdapter(smokeMockSpec)
      : new NativeCliAdapter({ defaultModel: MODEL, timeoutMs: TIMEOUT, env: passEnv }),
  };

  console.log(
    `swarmkit-eval · model=${MODEL} arms=${ARM_IDS.join(',')} tasks=${TASK_IDS.join(',')} ` +
      `repeats=${REPEATS} concurrency=${CONCURRENCY}${MOCK ? ' [MOCK]' : ''}`,
  );

  const results = await runEval(config, deps);

  for (const r of results) {
    console.log(
      `  ${r.taskId} | ${r.armId.padEnd(9)} seed${r.seed}: status=${r.status} ` +
        `S_partial=${(r.score?.partial ?? 0).toFixed(2)} full=${r.score?.full ?? false} ` +
        `tokens=${r.usage.totalTokens}${r.cost ? ` $${r.cost.usd.toFixed(4)}` : ''} ` +
        `${Math.round(r.durationMs / 1000)}s${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  const baseline = ARM_IDS.includes('stock' as ArmId) ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'sPartial' });
  console.log('\n' + renderMarkdownReport(report));

  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
