/**
 * Cell-D (both axes) runner: a SWARM across a RESET — the decisive interaction
 * test. N agents do the first K items concurrently (phase 1), context is reset,
 * then N FRESH agents must finish the rest (phase 2) WITHOUT re-emitting done
 * items (continuity) AND without racing each other (concurrency).
 *
 * Only opentasks can satisfy both with one primitive (claim_next returns items
 * that are neither done nor in-flight). notes must race two flat files
 * (done.txt + claims.txt); stock has neither. Hypothesis: super-additive failure
 * for the baselines vs cells B and C alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  setupSharedDir,
  teardownSharedDir,
  runOneAgent,
  type AgentSummary,
} from './concurrency-runner.js';
import { scoreExactlyOnce, type ExactlyOnceScore, type EmitRecord } from './collector.js';
import {
  SYNTH_ARMS,
  makeItems,
  seedOpentasksGraph,
  buildCellDPhase1Prompt,
  buildCellDPhase2Prompt,
} from './emit-queue.js';
import type { ArmId } from '../types.js';

export interface CellDOpts {
  model: string;
  n: number;
  m: number;
  /** Items phase 1 does before the reset. */
  k: number;
  repeat: number;
  phase1Ms: number;
  timeoutMs: number;
  env?: Record<string, string>;
  traceDir: string;
}

export interface CellDResult {
  armId: ArmId;
  model: string;
  n: number;
  m: number;
  k: number;
  repeat: number;
  score: ExactlyOnceScore;
  phase1Emits: number;
  phase2Emits: number;
  phase2ReEmits: number;
  tokenCost: number;
  durationMs: number;
  mcpConnected: boolean;
  phase1: AgentSummary[];
  phase2: AgentSummary[];
}

function attribute(records: EmitRecord[], agents: AgentSummary[]): AgentSummary[] {
  const per = new Map<string, number>();
  for (const r of records) per.set(r.agent, (per.get(r.agent) ?? 0) + 1);
  return agents.map((a) => ({ ...a, emits: per.get(a.agentId) ?? 0 }));
}

export async function runCellD(armId: ArmId, opts: CellDOpts): Promise<CellDResult> {
  const arm = SYNTH_ARMS[armId];
  if (!arm) throw new Error(`Unknown synthetic arm: ${armId}`);
  const items = makeItems(opts.m);
  // Graph seeded with only the first K tasks for phase 1 (opentasks arm).
  const { workDir, collector, mcpFile } = await setupSharedDir(arm, items, opts.env, items.slice(0, opts.k));

  try {
    const start = Date.now();
    const agentIds = Array.from({ length: opts.n }, (_, i) => `agent-${i + 1}`);

    // ── Phase 1: a swarm does the first K items, concurrently. ───────────────
    const p1 = await Promise.all(
      agentIds.map((agentId) =>
        runOneAgent({
          workDir,
          arm,
          agentId,
          prompt: buildCellDPhase1Prompt(arm, { m: opts.m, k: opts.k, agentId }),
          model: opts.model,
          timeoutMs: opts.phase1Ms,
          env: opts.env,
          mcpFile,
        }),
      ),
    );
    const phase1Records: EmitRecord[] = [...collector.records];
    const phase1Done = new Set(phase1Records.map((r) => r.id));

    // ── Reset boundary. Stage the remaining work for phase 2. ────────────────
    if (arm.itemsViaGraph) {
      seedOpentasksGraph(workDir, items.slice(opts.k), { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv);
    }

    // ── Phase 2: a FRESH swarm finishes the queue (recover + coordinate). ────
    const p2 = await Promise.all(
      agentIds.map((agentId) =>
        runOneAgent({
          workDir,
          arm,
          agentId,
          prompt: buildCellDPhase2Prompt(arm, { m: opts.m, k: opts.k, agentId }),
          model: opts.model,
          timeoutMs: opts.timeoutMs,
          env: opts.env,
          mcpFile,
        }),
      ),
    );
    const durationMs = Date.now() - start;

    const phase2Records = collector.records.slice(phase1Records.length);
    const phase2ReEmits = phase2Records.filter((r) => phase1Done.has(r.id)).length;
    const score = scoreExactlyOnce(collector.records, items);

    const result: CellDResult = {
      armId,
      model: opts.model,
      n: opts.n,
      m: opts.m,
      k: opts.k,
      repeat: opts.repeat,
      score,
      phase1Emits: phase1Records.length,
      phase2Emits: phase2Records.length,
      phase2ReEmits,
      tokenCost: [...p1, ...p2].reduce((s, r) => s + r.summary.tokenCost, 0),
      durationMs,
      mcpConnected: [...p1, ...p2].some((r) => r.mcpConnected),
      phase1: attribute(phase1Records, p1.map((r) => r.summary)),
      phase2: attribute(phase2Records, p2.map((r) => r.summary)),
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `cellD__${armId}__n${opts.n}__m${opts.m}__r${opts.repeat}.json`),
      JSON.stringify({ ...result, emitTimeline: collector.records, phase1Count: phase1Records.length }, null, 2),
    );

    return result;
  } finally {
    await teardownSharedDir(workDir, collector, opts.env);
  }
}
