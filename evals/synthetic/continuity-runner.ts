/**
 * Cell-C (continuity) runner: ONE agent over a 2-phase reset of the emit-queue.
 *
 * phase 1: a single agent starts the queue, wall-clock CAPPED → interrupted with
 *          some items emitted. Durable state survives in the shared dir
 *          (opentasks daemon / done.txt / nothing).
 * reset:   the boundary — phase 2 is a fresh `claude -p` (empty context).
 * phase 2: a fresh agent must FINISH the queue WITHOUT re-emitting done items —
 *          but emit is not observable on disk, so it must recover done-ness from
 *          its arm's durable state. stock has none → re-emits (the failure).
 *
 * This is the continuity analog of cell B; the headline is whether phase 2
 * re-emits already-done items (double-emits) — the hazard build-todo couldn't
 * show because there the work dir WAS the state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupSharedDir, teardownSharedDir, runOneAgent, type AgentSummary } from './concurrency-runner.js';
import { scoreExactlyOnce, type ExactlyOnceScore, type EmitRecord } from './collector.js';
import { SYNTH_ARMS, makeItems, buildContinuityP1Prompt, buildContinuityResumePrompt } from './emit-queue.js';
import type { ArmId } from '../types.js';

export interface ContinuityOpts {
  model: string;
  m: number;
  repeat: number;
  /** Wall-clock cap for phase 1 (ms) — it SHOULD interrupt mid-queue. */
  phase1Ms: number;
  /** Budget for phase 2 (ms). */
  timeoutMs: number;
  env?: Record<string, string>;
  traceDir: string;
}

export interface ContinuityResult {
  armId: ArmId;
  model: string;
  m: number;
  repeat: number;
  score: ExactlyOnceScore;
  phase1Emits: number;
  phase2Emits: number;
  /** phase-2 emits of items phase 1 had already emitted — the re-do hazard. */
  phase2ReEmits: number;
  phase1: AgentSummary;
  phase2: AgentSummary;
  tokenCost: number;
  durationMs: number;
  mcpConnected: boolean;
}

export async function runContinuityCell(armId: ArmId, opts: ContinuityOpts): Promise<ContinuityResult> {
  const arm = SYNTH_ARMS[armId];
  if (!arm) throw new Error(`Unknown synthetic arm: ${armId}`);
  const items = makeItems(opts.m);
  const { workDir, collector, mcpFile } = await setupSharedDir(arm, items, opts.env);

  try {
    const start = Date.now();

    // ── Phase 1: start the queue, capped (expected to interrupt mid-work). ────
    const p1 = await runOneAgent({
      workDir,
      arm,
      agentId: 'agent-1',
      prompt: buildContinuityP1Prompt(arm, { m: opts.m, agentId: 'agent-1' }),
      model: opts.model,
      timeoutMs: opts.phase1Ms,
      env: opts.env,
      mcpFile,
    });
    const phase1Records: EmitRecord[] = [...collector.records];
    const phase1Done = new Set(phase1Records.map((r) => r.id));

    // ── Reset: next spawn is a fresh, contextless session. ───────────────────

    // ── Phase 2: resume from durable state; must not re-emit done items. ─────
    const p2 = await runOneAgent({
      workDir,
      arm,
      agentId: 'agent-1',
      prompt: buildContinuityResumePrompt(arm, { m: opts.m, agentId: 'agent-1' }),
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
      mcpFile,
    });
    const durationMs = Date.now() - start;

    const phase2Records = collector.records.slice(phase1Records.length);
    const phase2ReEmits = phase2Records.filter((r) => phase1Done.has(r.id)).length;
    const score = scoreExactlyOnce(collector.records, items);

    const result: ContinuityResult = {
      armId,
      model: opts.model,
      m: opts.m,
      repeat: opts.repeat,
      score,
      phase1Emits: phase1Records.length,
      phase2Emits: phase2Records.length,
      phase2ReEmits,
      phase1: p1.summary,
      phase2: p2.summary,
      tokenCost: p1.summary.tokenCost + p2.summary.tokenCost,
      durationMs,
      mcpConnected: p1.mcpConnected || p2.mcpConnected,
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `cellC__${armId}__m${opts.m}__r${opts.repeat}.json`),
      JSON.stringify({ ...result, emitTimeline: collector.records, phase1Count: phase1Records.length }, null, 2),
    );

    return result;
  } finally {
    await teardownSharedDir(workDir, collector, opts.env);
  }
}
