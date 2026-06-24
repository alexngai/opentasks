import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EvalTask } from 'swarmkit-eval';

export interface TacTaskMeta {
  id: string;
  role: string;
  taskDir: string;
  image: string;
  dependencies: string[];
  hasScenarios: boolean;
  usesLlmGrader: boolean;
  prompt: string;
}

export interface TacLoadOptions {
  root: string;
  version: string;
}

export interface TacSelector {
  ids?: string[];
  role?: string;
  dependencies?: string[];
  dependencyMode?: 'exact' | 'contains';
  hasScenarios?: boolean;
}

export function defaultTacRoot(): string {
  return process.env.TAC_ROOT ?? path.resolve(process.env.HOME ?? '.', 'GitHub/TheAgentCompany');
}

export async function loadTacTasks(opts: TacLoadOptions): Promise<TacTaskMeta[]> {
  const tasksDir = path.join(opts.root, 'workspaces/tasks');
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const tasks: TacTaskMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const taskDir = path.join(tasksDir, id);
    const promptPath = path.join(taskDir, 'task.md');
    const dependenciesPath = path.join(taskDir, 'dependencies.yml');
    let prompt: string;
    try {
      prompt = await fs.readFile(promptPath, 'utf8');
    } catch {
      continue;
    }
    const dependencies = await readDependencies(dependenciesPath);
    tasks.push({
      id,
      role: id.split('-')[0] ?? 'unknown',
      taskDir,
      image: `ghcr.io/theagentcompany/${id}-image:${opts.version}`,
      dependencies,
      hasScenarios: await exists(path.join(taskDir, 'scenarios.json')),
      usesLlmGrader: await usesLlmGrader(path.join(taskDir, 'evaluator.py')),
      prompt: prompt.trim(),
    });
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function selectTacTasks(tasks: TacTaskMeta[], selector: TacSelector): TacTaskMeta[] {
  let out = tasks;
  if (selector.ids?.length) {
    const wanted = new Set(selector.ids);
    out = out.filter((t) => wanted.has(t.id));
  }
  if (selector.role) out = out.filter((t) => t.role === selector.role);
  if (selector.dependencies) {
    const want = [...selector.dependencies].sort();
    out = out.filter((t) => {
      const got = [...t.dependencies].sort();
      if (selector.dependencyMode === 'exact') return sameList(got, want);
      return want.every((d) => got.includes(d));
    });
  }
  if (selector.hasScenarios !== undefined) out = out.filter((t) => t.hasScenarios === selector.hasScenarios);
  return out;
}

export function toSwarmkitTask(task: TacTaskMeta): EvalTask {
  return {
    id: task.id,
    benchmark: 'theagentcompany',
    prompt: task.prompt,
    setup: { image: task.image },
    publicMetadata: {
      role: task.role,
      dependencies: task.dependencies,
      hasScenarios: task.hasScenarios,
      usesLlmGrader: task.usesLlmGrader,
      image: task.image,
      taskDir: task.taskDir,
    },
  };
}

export function parseTaskList(raw: string | undefined): string[] | undefined {
  const ids = raw
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids?.length ? ids : undefined;
}

async function readDependencies(file: string): Promise<string[]> {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const deps = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const dep = trimmed.slice(2).trim();
    if (dep) deps.add(dep);
  }
  return [...deps].sort();
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function usesLlmGrader(file: string): Promise<boolean> {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return false;
  }
  return /\b(?:llm_complete|evaluate_with_llm)\b/.test(text);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
