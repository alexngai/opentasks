/**
 * Adapter layer: run OpenTasks' OWN eval tasks + arms through the shared
 * `swarmkit-eval` package (a published devDependency; see ./README.md).
 *
 * OpenTasks' eval types are a near-exact ancestor of swarmkit-eval's, so this is
 * a thin field-rename, not a rewrite:
 *   EvalArm{systemPromptAppendix, extraTools, mcp}  →  Arm.scaffold{...}
 *   EvalTask{prompt, setupFiles, checkpoints}        →  EvalTask{prompt, setup.files, checkpoints}
 *   Check{fileExists|fileContains|cmd}               →  Check (identical subset)
 *   S_partial / checkpoint grading                   →  GraderSpec{kind:'checkpoint'}
 */

import type {
  BenchmarkAdapter,
  LoadOpts,
  Arm,
  EvalTask as SwkTask,
  FileSeed,
  MockSpec,
  PublicTask,
  RawRun,
  TraceEvent,
} from 'swarmkit-eval';

import { ARMS } from '../arms.js';
import type { EvalArm, EvalTask as OtTask, ArmId } from '../types.js';
import { SMOKE_TASK } from '../tasks/smoke.js';
import { BUILD_TODO_TASK } from '../tasks/build-todo.js';
import { didReadGraph, computeRedundantExplorationOps } from '../metrics.js';

const ALL_TASKS: Record<string, OtTask> = {
  [SMOKE_TASK.id]: SMOKE_TASK,
  [BUILD_TODO_TASK.id]: BUILD_TODO_TASK,
};

/** OpenTasks arm → swarmkit `Arm` (scaffold = the state-management mechanism). */
export function toSwkArm(a: EvalArm): Arm {
  return {
    id: a.id,
    label: a.label,
    scaffold: {
      ...(a.systemPromptAppendix ? { systemPromptAppendix: a.systemPromptAppendix } : {}),
      ...(a.extraTools.length ? { extraTools: a.extraTools } : {}),
      ...(a.mcp ? { mcpServers: [{ name: a.mcp.name, command: a.mcp.command, args: a.mcp.args }] } : {}),
    },
  };
}

export function opentasksArms(ids: ArmId[]): Arm[] {
  return ids.map((id) => {
    const a = ARMS[id];
    if (!a) throw new Error(`Unknown arm: ${id} (have: ${Object.keys(ARMS).join(', ')})`);
    return toSwkArm(a);
  });
}

/** OpenTasks task → swarmkit `EvalTask` (checkpoints pass through — identical shape). */
function toSwkTask(t: OtTask): SwkTask {
  return {
    id: t.id,
    benchmark: 'opentasks',
    prompt: t.prompt,
    ...(t.setupFiles?.length
      ? { setup: { files: t.setupFiles.map((f): FileSeed => ({ path: f.path, content: f.content })) } }
      : {}),
    checkpoints: t.checkpoints,
  };
}

/** A swarmkit `BenchmarkAdapter` backed by OpenTasks' task set; scored by ground-truth checkpoints. */
export function opentasksBenchmark(taskIds: string[]): BenchmarkAdapter {
  const tasks = taskIds.map((id) => {
    const t = ALL_TASKS[id];
    if (!t) throw new Error(`Unknown task: ${id} (have: ${Object.keys(ALL_TASKS).join(', ')})`);
    return toSwkTask(t);
  });
  return {
    id: 'opentasks',
    execution: 'native',
    grader: { kind: 'checkpoint' },
    async load(opts: LoadOpts): Promise<SwkTask[]> {
      let out = tasks;
      if (opts.taskIds?.length) out = out.filter((t) => opts.taskIds!.includes(t.id));
      if (opts.limit != null) out = out.slice(0, opts.limit);
      return out;
    },
    // Layer OpenTasks' graph-adoption diagnostics onto the ground-truth score
    // (never affects pass/fail) — derived from the captured tool-call trajectory.
    metricsOf(raw: RawRun): Record<string, number> {
      const toolCalls = raw.trajectory
        .filter((e): e is Extract<TraceEvent, { type: 'tool' }> => e.type === 'tool')
        .map((e) => ({ name: e.name, input: e.input }));
      return {
        readGraph: didReadGraph(toolCalls) ? 1 : 0,
        redundantExplorationOps: computeRedundantExplorationOps(toolCalls),
      };
    },
  };
}

/**
 * Zero-token plumbing mock (EVAL_MOCK=1) for the smoke task: writes the files its
 * checkpoints expect, with a planted per-arm success probability so the report shows
 * a non-trivial paired comparison without spending tokens. Smoke-task-specific.
 */
export const smokeMockSpec: MockSpec = {
  successProb(armId: string): number {
    return armId === 'opentasks' ? 0.9 : armId === 'notes' ? 0.75 : 0.55;
  },
  solve(_task: PublicTask, pass: boolean): FileSeed[] {
    if (!pass) return [{ path: 'summary.md', content: 'attempted but incomplete' }]; // partial credit
    return [
      { path: 'greeting.txt', content: 'hello\n' },
      { path: 'summary.md', content: 'Created greeting.txt containing "hello".' },
    ];
  },
};
