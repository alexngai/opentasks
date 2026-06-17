/**
 * The synthetic emit-queue as a swarmkit-eval BenchmarkAdapter + Arm[].
 *
 * Stats trick: each REPEAT is modelled as a distinct "task" (`rep0`, `rep1`, …) so
 * swarmkit-eval's cluster-bootstrap (which averages seeds into per-task scores and
 * bootstraps over tasks) yields a CI over the *repeats* — the synthetic eval's unit
 * of statistical power. (Repeats share content → identical contentHash, but distinct
 * cellKey via taskId, so the content-addressed store keeps them as separate cells.)
 */

import type { BenchmarkAdapter, Arm, EvalTask, LoadOpts, GraderSpec } from 'swarmkit-eval';
import { SYNTH_ARMS } from '../synthetic/emit-queue.js';
import type { ArmId } from '../types.js';

/** Synthetic arm → swarmkit `Arm`. The synth adapter dispatches by `arm.id`; scaffold is provenance. */
export function syntheticArms(ids: ArmId[]): Arm[] {
  return ids.map((id) => {
    const a = SYNTH_ARMS[id];
    if (!a) throw new Error(`Unknown synthetic arm: ${id} (have: ${Object.keys(SYNTH_ARMS).join(', ')})`);
    return {
      id: a.id,
      label: a.label,
      scaffold: {
        ...(a.extraTools.length ? { extraTools: a.extraTools } : {}),
        ...(a.mcp ? { mcpServers: [{ name: a.mcp.name, command: a.mcp.command, args: a.mcp.args }] } : {}),
      },
    };
  });
}

export function syntheticBenchmark(cell: string, repeats: number): BenchmarkAdapter {
  const id = `synth-${cell}`;
  const grader: GraderSpec = { kind: 'self' }; // the synth adapter computes the Score (exactly-once)
  return {
    id,
    execution: 'native', // routed through the per-cell path; the SyntheticSwarmAdapter is the SUT driver
    grader,
    async load(opts: LoadOpts): Promise<EvalTask[]> {
      let tasks: EvalTask[] = Array.from({ length: repeats }, (_, i) => ({
        id: `rep${i}`,
        benchmark: id,
        prompt: `[synthetic emit-queue cell ${cell} · repeat ${i}]`, // real prompts are built inside the runner
        publicMetadata: { repeat: i, cell },
      }));
      if (opts.taskIds?.length) tasks = tasks.filter((t) => opts.taskIds!.includes(t.id));
      if (opts.limit != null) tasks = tasks.slice(0, opts.limit);
      return tasks;
    },
  };
}
