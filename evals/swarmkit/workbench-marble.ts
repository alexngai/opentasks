/**
 * Tier 2 — multi-agent WorkBench through swarmkit-eval's native `marble` engine.
 *
 * N agents share ONE WorkBench sandbox + ONE workspace (so their per-agent WorkBench MCP servers all
 * append to ONE union action log, `ws.root/.wb_actions.jsonl`), coordinating through OpenTasks. The task
 * is a real WorkBench multi_domain instruction; grading replays the UNION of all agents' side-effecting
 * tool calls against a fresh sandbox — so a *duplicate* side effect from two uncoordinated agents (both
 * send the email) becomes a WorkBench **harmful action**. That is exactly what OpenTasks' `claim_next`
 * coordination is meant to prevent → the coordination payoff, measured on realistic, outcome-graded work.
 *
 * Structural port of `synth-marble.ts` (the emit-queue) to WorkBench: the "items" are the task's PUBLIC
 * `domains` (a fair, non-leaking work split — the sealed ground-truth actions are never seeded), the
 * "emit" is doing that domain's workplace actions via `mcp__workbench__*`, and the grader is WorkBench's
 * own `is_correct`/`has_side_effects` (reused via the exported `WorkbenchGrader`). All WorkBench-specific
 * machinery lives in swarmkit-eval; this file only composes. No change to OpenTasks core.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  workbenchNativeBenchmark,
  WorkbenchGrader,
  type MarbleBenchmarkAdapter,
  type MultiAgentRawRun,
  type Score,
  type EvalTask,
  type ServiceSpec,
  type ServiceHandle,
  type ServiceContext,
  type PhaseSpec,
  type CoordinationAction,
  type Workspace,
  type RawRun,
  type LoadOpts,
} from 'swarmkit-eval';
import { ARMS } from '../arms.js';
import { stopOpentasksDaemon } from '../runner.js';

const OPENTASKS_CLI = ARMS.opentasks.mcp?.args?.[0];

/** The 14 side-effecting WorkBench tools (sanitized MCP names) — the graded, redundancy-tracked actions. */
const WB_SIDE_EFFECT = new Set([
  'email_send_email', 'email_delete_email', 'email_forward_email', 'email_reply_email',
  'calendar_create_event', 'calendar_delete_event', 'calendar_update_event',
  'analytics_create_plot',
  'project_management_create_task', 'project_management_delete_task', 'project_management_update_task',
  'customer_relationship_manager_add_customer', 'customer_relationship_manager_update_customer',
  'customer_relationship_manager_delete_customer',
]);

export interface WorkbenchMarbleOpts {
  n: number;
  repoDir: string;
  python: string;
  domain?: Parameters<typeof workbenchNativeBenchmark>[0]['domain'];
  taskLimit?: number;
}

/** Parse the public `domains` cell ("['email', 'calendar']") into a string[]. */
function parseDomains(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? '').replace(/'/g, '"'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The WorkBench substrate as a first-class service: for the opentasks arm it seeds one CLAIMABLE task per
 * public domain (a non-leaking partition; this also starts the shared per-cell daemon before the agents),
 * exposes the task instruction to the per-agent prompt via `env`, snapshots the UNION action log for the
 * grader in `readState()`, and reaps the daemon in `stop()` (base OpenTasks functionality).
 */
function workbenchService(): ServiceSpec {
  return {
    id: 'workbench',
    async start(ctx: ServiceContext): Promise<ServiceHandle> {
      const armId = ctx.armId;
      const instruction = String(ctx.publicMetadata?.instruction ?? '');
      const domains = parseDomains(ctx.publicMetadata?.domains);
      const otEnv = { ...process.env, OPENTASKS_PROJECT_DIR: '.opentasks' } as NodeJS.ProcessEnv;

      if (armId === 'opentasks' && OPENTASKS_CLI && domains.length) {
        // Seed one claimable subtask per domain (auto-starts the shared daemon in ws.root/.opentasks).
        for (const d of domains) {
          try {
            execFileSync(
              process.execPath,
              [OPENTASKS_CLI, 'create', '--type', 'task', '--title', `handle the "${d}" part of the task`, '--status', 'open'],
              { cwd: ctx.workspaceRoot, env: otEnv, stdio: 'ignore', timeout: 20_000 },
            );
          } catch { /* seed best-effort; a missing subtask just means less to claim */ }
        }
      }

      const actionLogPath = path.join(ctx.workspaceRoot, '.wb_actions.jsonl');
      const handle: ServiceHandle = {
        // Exposed to phase.prompt(args.services) so each agent gets the actual task text.
        env: { WB_INSTRUCTION: instruction, WB_DOMAINS: domains.join(', ') },
        async readState(): Promise<{ actions: string[] }> {
          let actions: string[] = [];
          try {
            actions = fs.readFileSync(actionLogPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
          } catch { /* no side effects taken → empty union */ }
          return { actions };
        },
        async stop(): Promise<void> {
          if (armId === 'opentasks') stopOpentasksDaemon(ctx.workspaceRoot, { OPENTASKS_PROJECT_DIR: '.opentasks' });
        },
      };
      return handle;
    },
  };
}

/** Per-agent, per-arm coordination prompt. The task text arrives via `services.WB_INSTRUCTION`. */
function buildMarblePrompt(armId: string, agentId: string, width: number, instruction: string): string {
  const common = [
    `You are ${agentId}, one of ${width} agents working TOGETHER on ONE workplace task, at the SAME time.`,
    'Do the workplace actions with the WorkBench tools (native tools prefixed mcp__workbench__): search/read',
    'as needed to find ids and details, then perform the required create / update / delete / send actions.',
    '',
    'CRITICAL: coordinate so no action is performed twice. A DUPLICATE side effect — e.g. two agents both',
    'sending the same email, or both deleting the same event — is an irreversible, HARMFUL error. Divide the',
    "work so each part is done exactly once. Do not ask for confirmation; act. Stop when your part is done.",
    '',
  ];

  if (armId === 'opentasks') {
    return [
      ...common,
      'The task has been split into per-domain subtasks in the OpenTasks graph. Get your work ONLY by claiming:',
      `  1. Call mcp__opentasks__claim_next with agentId "${agentId}" to ATOMICALLY claim the next unclaimed`,
      '     domain subtask. It returns {claimed, nodeId, ...}, or claimed:false when nothing is left.',
      '  2. Call mcp__opentasks__get_task on that nodeId to read which domain you claimed (its title).',
      '  3. Do ALL of THAT domain\'s workplace actions for the task, via mcp__workbench__* tools.',
      '  4. Mark it done: mcp__opentasks__update_task(id: nodeId, status: "closed").',
      '  5. Repeat from step 1 until claim_next returns claimed:false, then stop.',
      'The claim is race-free: if claimed:true, no other agent has that domain — never work a domain you did',
      'not claim. This guarantees each domain (and its side effects) is handled exactly once.',
      '',
      'The task:',
      instruction,
    ].join('\n');
  }

  if (armId === 'notes') {
    return [
      ...common,
      'Coordinate through the shared file claims.txt in this directory:',
      `  1. Before doing a domain's actions, append a line "${agentId}: <domain>" to claims.txt.`,
      '  2. Re-read claims.txt; if another agent already claimed that domain, skip it and pick another.',
      '  3. Only then perform that domain\'s mcp__workbench__* actions.',
      '',
      'The task:',
      instruction,
    ].join('\n');
  }

  // stock — no shared coordination channel; the agents must divide the work with no way to check.
  return [
    ...common,
    'You have no shared coordination channel with the other agents. Try to divide the task so nothing is',
    'done twice, but you cannot see what the others have done.',
    '',
    'The task:',
    instruction,
  ].join('\n');
}

function phasesFor(): PhaseSpec[] {
  return [
    {
      id: 'work',
      prompt: ({ arm, agentId, width, services }) =>
        buildMarblePrompt(arm.id, agentId, width, services.WB_INSTRUCTION ?? ''),
    },
  ];
}

/**
 * A swarmkit-eval `marble` benchmark: WorkBench multi_domain tasks run by N coordinating agents, graded by
 * WorkBench's own outcome+harmful grader on the UNION of their side-effecting actions.
 */
export function workbenchMarbleBenchmark(opts: WorkbenchMarbleOpts): MarbleBenchmarkAdapter {
  const domain = opts.domain ?? 'multi_domain';
  const id = `workbench-marble-${domain}`;
  const native = workbenchNativeBenchmark({ repoDir: opts.repoDir, python: opts.python, domain });
  const grader = new WorkbenchGrader({ python: opts.python, repoDir: opts.repoDir });

  return {
    id,
    execution: 'marble',
    grader: { kind: 'self' },
    swarm: { width: opts.n, phases: phasesFor(), services: [workbenchService()] },

    async load(o: LoadOpts): Promise<EvalTask[]> {
      // Reuse the Tier-1 loader (sealed outcome + public domain), then surface the raw instruction to the
      // per-agent prompt via publicMetadata (the agent sees the task anyway; the OUTCOME stays sealed).
      // NB: o.limit (from config.taskLimit) wins if set; else the benchmark's opts.taskLimit. Spread o
      // FIRST so an unset config.taskLimit (undefined) can't clobber opts.taskLimit.
      const tasks = await native.load({ ...o, limit: o.limit ?? opts.taskLimit });
      return tasks.map((t) => ({ ...t, publicMetadata: { ...t.publicMetadata, instruction: t.prompt } }));
    },

    async score(raw: MultiAgentRawRun, task: EvalTask): Promise<Score> {
      const st = (raw.services.workbench ?? { actions: [] }) as { actions: string[] };
      const unionText = st.actions.join('\n') + (st.actions.length ? '\n' : '');
      // Reuse WorkbenchGrader by feeding the UNION log through a minimal Workspace.
      const ws = {
        readFile: async (p: string) => (p.includes('.wb_actions.jsonl') ? unionText : null),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        writeFiles: async () => {},
        dispose: async () => {},
        root: raw.workdir,
      } as unknown as Workspace;
      const syntheticRaw = { output: '', workdir: raw.workdir, usage: raw.usage, trajectory: raw.trajectory, durationMs: raw.durationMs } as RawRun;
      const score = await grader.grade(task, syntheticRaw, ws);
      // Multi-agent diagnostics on top of completion/harmful (coordination KPIs R/O/c/E_c are folded in by
      // the engine from the coordination classifier below).
      const workActions = st.actions.length;
      score.metrics = { ...score.metrics, numAgents: opts.n, unionSideEffects: workActions };
      return score;
    },

    coordination(call): CoordinationAction | null {
      const name = call.name ?? '';
      if (name.startsWith('mcp__workbench__')) {
        const bare = name.slice('mcp__workbench__'.length);
        // A side-effecting workbench call = productive work; the redundancy key is the action itself, so two
        // agents doing the SAME action register as redundant (R>0). Reads (search/get) are ignored.
        if (WB_SIDE_EFFECT.has(bare)) return { kind: 'work', ref: `${bare}:${JSON.stringify(call.input ?? {})}` };
        return null;
      }
      if (name.startsWith('mcp__opentasks__')) return { kind: 'coordination' };
      const fp = String((call.input as { file_path?: string } | undefined)?.file_path ?? '');
      if ((name === 'Write' || name === 'Edit') && /claims\.txt/.test(fp)) return { kind: 'coordination' };
      return null;
    },
  };
}
