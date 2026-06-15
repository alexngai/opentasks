/**
 * Synthetic emit-queue eval — CLI entry (cell B = concurrency, for now).
 *
 * Env:
 *   EVAL_MODEL    model id (default haiku). GLM-5: set this + ANTHROPIC_BASE_URL +
 *                 ANTHROPIC_API_KEY (proxy master key), stack up.
 *   EVAL_ARMS     comma list (default stock,notes,opentasks).
 *   EVAL_N        concurrent agents (default 2).
 *   EVAL_M        queue length / items (default 8).
 *   EVAL_REPEATS  runs per (arm) cell (default 1).
 *   EVAL_TIMEOUT  per-agent ms (default 240000).
 *
 * Example (haiku smoke):
 *   EVAL_MODEL=haiku EVAL_N=2 EVAL_M=6 npx tsx evals/synthetic/run.ts
 *   EVAL_MODEL=glm-5 ANTHROPIC_BASE_URL=http://127.0.0.1:4000 \
 *     ANTHROPIC_API_KEY=sk-glm5-spike-master EVAL_N=4 EVAL_M=12 npx tsx evals/synthetic/run.ts
 */

import * as path from 'node:path';
import { runConcurrencyCell } from './concurrency-runner.js';
import { runContinuityCell } from './continuity-runner.js';
import type { ArmId } from '../types.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const N = Number(process.env.EVAL_N ?? 2);
const M = Number(process.env.EVAL_M ?? 8);
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const TIMEOUT = Number(process.env.EVAL_TIMEOUT ?? 240_000);
// Cell: B = concurrency (N agents, 1 session); C = continuity (1 agent, reset).
const CELL = (process.env.EVAL_CELL ?? 'B').toUpperCase();
const PHASE1_MS = Number(process.env.EVAL_PHASE1_MS ?? 60_000);
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks').split(',').map((s) => s.trim()) as ArmId[];
const TRACE_DIR = path.resolve(process.cwd(), 'evals/.runs');

const PASSTHROUGH = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION'];
const passEnv: Record<string, string> = {};
for (const k of PASSTHROUGH) if (process.env[k]) passEnv[k] = process.env[k]!;

async function runCellB(): Promise<void> {
  console.log(`[cell B · concurrency] model=${MODEL} arms=${ARM_IDS.join(',')} N=${N} M=${M} repeats=${REPEATS}`);
  for (const armId of ARM_IDS) {
    for (let r = 0; r < REPEATS; r++) {
      const res = await runConcurrencyCell(armId, {
        model: MODEL, n: N, m: M, repeat: r, timeoutMs: TIMEOUT, env: passEnv, traceDir: TRACE_DIR,
      });
      const s = res.score;
      const claimers = res.agents.filter((a) => a.usedClaim).length;
      const errs = res.agents.filter((a) => a.error).length;
      console.log(
        `  ${armId.padEnd(9)} r${r}: exactlyOnce=${s.exactlyOnce}/${s.m} ` +
          `doubleEmits=${s.doubleEmits} missed=${s.missed} correct=${s.correct} ` +
          `| tokens=${res.tokenCost} ${Math.round(res.durationMs / 1000)}s ` +
          `agents=${res.n}${res.armId === 'opentasks' ? ` claimers=${claimers}/${res.n} mcp=${res.mcpConnected}` : ''}` +
          `${errs ? ` ERRS=${errs}` : ''}`,
      );
      console.log(`      emits/agent: ${res.agents.map((a) => `${a.agentId}=${a.emits}`).join(' ')}`);
    }
  }
}

async function runCellC(): Promise<void> {
  console.log(
    `[cell C · continuity] model=${MODEL} arms=${ARM_IDS.join(',')} M=${M} ` +
      `phase1=${Math.round(PHASE1_MS / 1000)}s repeats=${REPEATS}`,
  );
  for (const armId of ARM_IDS) {
    for (let r = 0; r < REPEATS; r++) {
      const res = await runContinuityCell(armId, {
        model: MODEL, m: M, repeat: r, phase1Ms: PHASE1_MS, timeoutMs: TIMEOUT, env: passEnv, traceDir: TRACE_DIR,
      });
      const s = res.score;
      const errs = [res.phase1, res.phase2].filter((p) => p.error).length;
      console.log(
        `  ${armId.padEnd(9)} r${r}: exactlyOnce=${s.exactlyOnce}/${s.m} ` +
          `doubleEmits=${s.doubleEmits} missed=${s.missed} correct=${s.correct} ` +
          `| p1Emits=${res.phase1Emits} p2Emits=${res.phase2Emits} p2ReEmits=${res.phase2ReEmits} ` +
          `tokens=${res.tokenCost} ${Math.round(res.durationMs / 1000)}s` +
          `${res.armId === 'opentasks' ? ` mcp=${res.mcpConnected}` : ''}${errs ? ` ERRS=${errs}` : ''}`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (CELL === 'C') await runCellC();
  else await runCellB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
