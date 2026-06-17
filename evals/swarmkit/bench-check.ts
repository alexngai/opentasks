/**
 * Deterministic spot-check for the diagnostics wiring (#3): bench.ts `metricsOf`
 * derives readGraph + redundantExplorationOps from a swarmkit-eval RawRun.trajectory
 * (the per-tool-call events native-cli captures). Reuses ../metrics.ts.
 *
 * Run: npx tsx evals/swarmkit/bench-check.ts   (evals/ is outside the vitest src/** glob)
 */
import type { RawRun, TraceEvent } from 'swarmkit-eval';
import { opentasksBenchmark } from './bench.js';

const bench = opentasksBenchmark(['smoke-greeting']);
const raw = (trajectory: TraceEvent[]): RawRun => ({
  output: '',
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  trajectory,
  durationMs: 0,
});

const cases: Array<[string, TraceEvent[], { readGraph: number; redundantExplorationOps: number }]> = [
  [
    'graph call + repeat Read',
    [
      { type: 'tool', ts: 0, name: 'mcp__opentasks__query', input: {} },
      { type: 'tool', ts: 1, name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool', ts: 2, name: 'Read', input: { file_path: 'a.ts' } }, // repeat → +1
      { type: 'llm', ts: 3, model: 'm', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ],
    { readGraph: 1, redundantExplorationOps: 1 },
  ],
  [
    'no graph tool, no repeat read',
    [
      { type: 'tool', ts: 0, name: 'Write', input: { file_path: 'x' } },
      { type: 'tool', ts: 1, name: 'Read', input: { file_path: 'a.ts' } },
    ],
    { readGraph: 0, redundantExplorationOps: 0 },
  ],
];

let ok = true;
for (const [label, traj, want] of cases) {
  const got = bench.metricsOf!(raw(traj));
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  → ${JSON.stringify(got)}`);
}
console.log(ok ? '\nbench metricsOf: OK' : '\nbench metricsOf: FAILED');
process.exit(ok ? 0 : 1);
