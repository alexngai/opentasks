import type { Arm, BenchmarkAdapter, EvalTask, LoadOpts } from 'swarmkit-eval';
import { ARMS } from '../arms.js';
import type { ArmId, EvalArm } from '../types.js';
import {
  defaultTacRoot,
  loadTacTasks,
  parseTaskList,
  selectTacTasks,
  toSwarmkitTask,
  type TacSelector,
} from './tasks.js';

export interface TacBenchmarkOptions {
  root?: string;
  version?: string;
  selector?: TacSelector;
}

export function tacArms(ids: ArmId[]): Arm[] {
  return ids.map((id) => toSwkArm(ARMS[id]));
}

export function tacBenchmark(opts: TacBenchmarkOptions = {}): BenchmarkAdapter {
  const root = opts.root ?? defaultTacRoot();
  const version = opts.version ?? process.env.TAC_VERSION ?? '1.0.0';
  const selector = opts.selector ?? {};
  return {
    id: 'theagentcompany',
    execution: 'native',
    grader: { kind: 'self' },
    async load(loadOpts: LoadOpts): Promise<EvalTask[]> {
      const tasks = await loadTacTasks({ root, version });
      const selected = selectTacTasks(tasks, {
        ...selector,
        ids: loadOpts.taskIds?.length ? loadOpts.taskIds : selector.ids,
      }).map(toSwarmkitTask);
      return loadOpts.limit != null ? selected.slice(0, loadOpts.limit) : selected;
    },
  };
}

export function tacSelectorFromEnv(): TacSelector {
  const dependencies = parseTaskList(process.env.TAC_DEPS);
  const dependencyMode = (process.env.TAC_DEPS_MODE === 'contains' ? 'contains' : 'exact') as 'exact' | 'contains';
  const hasScenarios = parseBoolean(process.env.TAC_HAS_SCENARIOS);
  return {
    ids: parseTaskList(process.env.EVAL_TASKS),
    role: process.env.TAC_ROLE,
    dependencies,
    dependencyMode,
    hasScenarios,
  };
}

function toSwkArm(a: EvalArm): Arm {
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

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  throw new Error(`Invalid boolean env value: ${raw}`);
}
