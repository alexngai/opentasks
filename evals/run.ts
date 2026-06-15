/**
 * Eval CLI entry. Runs (task × arm × repeat), prints a one-line summary per
 * cell, and archives a JSON trace per run under evals/.runs/.
 *
 * Env:
 *   EVAL_MODEL    model id passed to `claude --model` (default: haiku).
 *                 For Bedrock/GLM-5 set this + CLAUDE_CODE_USE_BEDROCK/AWS_REGION
 *                 (or ANTHROPIC_BASE_URL for a mantle proxy) — passed through.
 *   EVAL_ARMS     comma list of arms (default: stock,notes,opentasks).
 *   EVAL_REPEATS  runs per cell (default: 1).
 *   EVAL_TIMEOUT  per-run ms (default: 600000).
 *   EVAL_TASKS    comma list of task ids (default: smoke-greeting).
 *
 * Examples:
 *   EVAL_MODEL=haiku EVAL_ARMS=stock npx tsx evals/run.ts          # smoke one arm
 *   CLAUDE_CODE_USE_BEDROCK=1 AWS_REGION=us-west-1 \
 *     EVAL_MODEL=<glm-5-id> npx tsx evals/run.ts                   # on Bedrock
 */

import * as path from 'node:path';
import { ARMS } from './arms.js';
import { runTaskWithArm } from './runner.js';
import { SMOKE_TASK } from './tasks/smoke.js';
import { BUILD_TODO_TASK } from './tasks/build-todo.js';
import type { ArmId, EvalTask } from './types.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 600_000);
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks')
  .split(',')
  .map((s) => s.trim()) as ArmId[];
const TASK_IDS = (process.env.EVAL_TASKS ?? 'smoke-greeting').split(',').map((s) => s.trim());
const TRACE_DIR = path.resolve(process.cwd(), 'evals/.runs');

// Pass Bedrock/mantle env through to the spawned agent (creds come from the
// AWS default profile / environment — nothing hard-coded here).
const PASSTHROUGH = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_PROFILE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY', // GLM-5 via LiteLLM: must equal the proxy master_key
  'ANTHROPIC_MODEL',
];
const passEnv: Record<string, string> = {};
for (const k of PASSTHROUGH) if (process.env[k]) passEnv[k] = process.env[k]!;

const ALL_TASKS: Record<string, EvalTask> = {
  [SMOKE_TASK.id]: SMOKE_TASK,
  [BUILD_TODO_TASK.id]: BUILD_TODO_TASK,
};

function main(): void {
  const tasks = TASK_IDS.map((id) => {
    const t = ALL_TASKS[id];
    if (!t) throw new Error(`Unknown task: ${id} (have: ${Object.keys(ALL_TASKS).join(', ')})`);
    return t;
  });

  console.log(`model=${MODEL} arms=${ARM_IDS.join(',')} tasks=${TASK_IDS.join(',')} repeats=${REPEATS} bedrock=${passEnv.CLAUDE_CODE_USE_BEDROCK ?? 'off'}`);
  for (const task of tasks) {
    for (const armId of ARM_IDS) {
      const arm = ARMS[armId];
      if (!arm) throw new Error(`Unknown arm: ${armId}`);
      for (let r = 0; r < REPEATS; r++) {
        const res = runTaskWithArm(task, arm, { model: MODEL, repeat: r, timeoutMs: TIMEOUT, env: passEnv, traceDir: TRACE_DIR });
        const tag = res.infraFailure ? 'INFRA-FAIL' : res.timedOut ? 'TIMEOUT' : '';
        const mcp = res.mcpServers.length
          ? ` mcp=[${res.mcpServers.map((s) => `${s.name}:${s.status}`).join(',')}]`
          : '';
        console.log(
          `  ${task.id} | ${arm.id.padEnd(9)} r${r}: ` +
            `S_partial=${res.sPartial.toFixed(2)} full=${res.sFull} ` +
            `tokens=${res.tokenCost} tools=${res.toolCalls.length} ` +
            `readGraph=${res.readGraph} redundant=${res.redundantExplorationOps}${mcp} ` +
            `${Math.round(res.durationMs / 1000)}s ${tag}` +
            (res.error ? ` ERR:${res.error.slice(0, 100)}` : ''),
        );
      }
    }
  }
}

main();
