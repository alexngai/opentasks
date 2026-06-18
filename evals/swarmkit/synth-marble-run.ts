/**
 * Synthetic emit-queue 2×2 through swarmkit-eval's NATIVE multi-agent (`marble`) engine (§4c).
 *
 * Same experiment as synth-run.ts, but the swarm + collector + reset are now first-class in swarmkit-eval
 * (runMarbleFlow), not hidden in a placement:'self' wrapper. Per-agent driver = native-cli. The engine
 * produces per-agent attribution + coordination KPIs (R/O/c/E_c) reported with CIs alongside the race metrics.
 *
 * Env: EVAL_CELL (B/C/D) · EVAL_MODEL · EVAL_ARMS · EVAL_N · EVAL_M · EVAL_K · EVAL_REPEATS ·
 *      EVAL_TIMEOUT · EVAL_CONCURRENCY · EVAL_FAKE=1 (zero-token) · EVAL_PASS_ANTHROPIC=1 (GLM/gateway)
 *
 *   EVAL_FAKE=1 EVAL_CELL=D EVAL_M=8 EVAL_K=4 EVAL_REPEATS=8 npx tsx evals/swarmkit/synth-marble-run.ts
 *   npm run build && EVAL_CELL=B EVAL_N=2 EVAL_M=3 EVAL_REPEATS=1 npx tsx evals/swarmkit/synth-marble-run.ts
 */

import * as path from 'node:path';

if (process.env.EVAL_PASS_ANTHROPIC !== '1') {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
}

import {
  runEval,
  NativeCliAdapter,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  writeReport,
  type EvalConfig,
  type RunDeps,
  type ExecutionAdapter,
  type PublicCell,
  type RunContext,
  type RawRun,
  type TraceEvent,
} from 'swarmkit-eval';
import { syntheticMarbleBenchmark, type SynthCell } from './synth-marble.js';
import { syntheticArms } from './synth-bench.js';
import { makeItems } from '../synthetic/emit-queue.js';
import type { ArmId } from '../types.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const CELL = ((process.env.EVAL_CELL ?? 'B').toUpperCase() as SynthCell);
const N = Number(process.env.EVAL_N ?? 2);
const M = Number(process.env.EVAL_M ?? 6);
const K = Number(process.env.EVAL_K ?? Math.max(1, Math.floor(M / 2)));
const REPEATS = Number(process.env.EVAL_REPEATS ?? 3);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 240_000);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 1);
const FAKE = process.env.EVAL_FAKE === '1';
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks').split(',').map((s) => s.trim()) as ArmId[];
const OUT_DIR = path.resolve(process.cwd(), 'evals/.swarmkit-marble');

const passEnv: Record<string, string> = {};
for (const kk of ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE', 'ANTHROPIC_MODEL']) {
  if (process.env[kk]) passEnv[kk] = process.env[kk]!;
}
if (process.env.EVAL_PASS_ANTHROPIC === '1') {
  for (const kk of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) if (process.env[kk]) passEnv[kk] = process.env[kk]!;
}

/** Zero-token fake agent (EVAL_FAKE): emits a per-arm plan via the collector URL — opentasks partitions
 *  + dedups across phases via a per-cell "durable state" set (modelling the graph's claim/complete),
 *  baselines emit everything every invocation (races + re-do after reset). Validates the port wiring. */
const fakeDurableState = new Map<string, Set<string>>(); // collector URL → items this cell already did
function fakeAgentAdapter(n: number): ExecutionAdapter {
  return {
    id: 'fake-agent',
    placement: 'backend',
    async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
      const agentId = ctx.env?.AGENT_ID ?? 'agent-1';
      const url = ctx.env?.COLLECTOR_URL ?? '';
      const m = Number(cell.task.publicMetadata?.m ?? M);
      const idx = Math.max(0, parseInt(String(agentId).replace(/\D/g, ""), 10) - 1);
      const items = makeItems(m);
      let emits: string[];
      if (cell.arm.id === 'opentasks') {
        // Atomic claim + durable complete: each agent does its partition, never an already-done item.
        // Atomic claim + durable complete: synchronously claim un-done items (race-free, width-agnostic
        // — works at any N incl. the width-1 solo baseline). Models claim_next + persistent complete.
        const seen = fakeDurableState.get(url) ?? new Set<string>();
        fakeDurableState.set(url, seen);
        emits = items.filter((it) => {
          if (seen.has(it)) return false;
          seen.add(it);
          return true;
        });
      } else {
        emits = items; // stock/notes: emit everything each invocation → races + re-emits
      }
      const trajectory: TraceEvent[] = [];
      let ts = 0;
      for (const id of emits) {
        if (url) {
          await fetch(`${url}/emit`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ id, agent: agentId }).toString(),
          }).catch(() => {});
        }
        trajectory.push({ type: 'tool', ts: ts++, name: 'Bash', input: { command: `./emit ${id}` } });
      }
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      trajectory.push({ type: 'llm', ts: ts++, model: cell.model.name, usage });
      return { output: '', usage, trajectory, durationMs: 1 };
    },
  };
}

async function main(): Promise<void> {
  const benchmark = syntheticMarbleBenchmark({ cell: CELL, repeats: REPEATS, n: N, m: M, k: K });
  const arms = syntheticArms(ARM_IDS);
  const config: EvalConfig = {
    runId: `synth-marble-${CELL}-${MODEL}-N${N}-M${M}${CELL !== 'B' ? `-K${K}` : ''}`,
    configVersion: 'v1',
    benchmark: `synth-${CELL}`,
    arms,
    models: [{ name: MODEL }],
    seeds: [1],
    backend: 'in-process',
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    output: { dir: OUT_DIR, trace: false },
  };

  const agentAdapter: ExecutionAdapter = FAKE
    ? fakeAgentAdapter(N)
    : new NativeCliAdapter({ defaultModel: MODEL, timeoutMs: TIMEOUT, env: passEnv });

  const deps: RunDeps = {
    benchmark,
    backend: new InProcessBackend(),
    store: new LocalResultStore(OUT_DIR),
    marble: { agentAdapter, maxParallelCells: CONCURRENCY },
  };

  console.log(
    `marble synthetic cell ${CELL} · model=${MODEL} arms=${ARM_IDS.join(',')} N=${N} M=${M}` +
      `${CELL !== 'B' ? ` K=${K}` : ''} repeats=${REPEATS}${FAKE ? ' [FAKE]' : ''}`,
  );

  const results = await runEval(config, deps);
  for (const r of results) {
    const m = r.score?.metrics ?? {};
    console.log(
      `  ${r.armId.padEnd(9)} ${r.taskId}: correct=${r.score?.full ?? false} ` +
        `exactlyOnce=${m.exactlyOnce ?? '?'}/${r.score?.total ?? '?'} doubleEmits=${m.doubleEmits ?? '?'}` +
        `${m.p2ReEmits !== undefined ? ` p2ReEmits=${m.p2ReEmits}` : ''}` +
        `${m.R !== undefined ? ` R=${(m.R as number).toFixed(2)}` : ''} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  // A_e (error amplification) needs an N=1 solo baseline — run the same arms at width 1 (EVAL_SOLO=1).
  let solo: typeof results | undefined;
  if (process.env.EVAL_SOLO === '1') {
    console.log('  … running N=1 solo baseline for A_e');
    solo = await runEval(config, {
      ...deps,
      marble: { agentAdapter, widthOverride: 1, maxParallelCells: CONCURRENCY },
    });
  }

  const baseline = ARM_IDS.includes('stock' as ArmId) ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'successRate', solo });
  console.log('\n' + renderMarkdownReport(report));
  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
