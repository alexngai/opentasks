/**
 * Cross-session continuity (reset) runner — the E2′-proper variant.
 *
 * Why: the naive single-session comparison is a *null with overhead* (a capable
 * model one-shots a tractable task in one context, so external state can't help;
 * see evals/results/2026-06-15-build-todo-glm5.md). OpenTasks is only
 * load-bearing when CONTEXT DOESN'T CARRY — i.e. across a session boundary. This
 * runner makes that the experiment:
 *
 *   phase 1: full task, but wall-clock CAPPED → the agent is interrupted with
 *            work unfinished. Durable state survives in the work dir:
 *              · opentasks arm → the (detached, still-running) task-graph daemon
 *              · notes arm     → NOTES.md
 *              · stock arm     → only the partial files on disk
 *   reset:   the boundary itself. Each phase is its own one-shot `claude -p`
 *            (no --resume) → phase 2 starts with EMPTY context. Nothing carries
 *            but the work dir.
 *   phase 2: a fresh agent told "a previous session started this — find what's
 *            done before doing new work, then finish it." Same work dir.
 *
 * Headline metric = phase-2 RE-ORIENTATION cost: tokens + redundant exploration
 * to recover state and complete. The hypothesis is that structured durable state
 * (graph / NOTES) re-orients cheaper than re-reading the work dir from scratch.
 * Scoring stays ground-truth (checkpoints on the final work dir), never state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanupWorkDir,
  runAgentPhase,
  scoreCheckpoints,
  seedWorkDir,
  stopOpentasksDaemon,
  type PhaseResult,
  type RunOpts,
} from './runner.js';
import { computeRedundantExplorationOps, didReadGraph } from './metrics.js';
import type { EvalArm, EvalTask, PhaseSummary, RunResult } from './types.js';

export interface ResetOpts extends RunOpts {
  /** Wall-clock cap for phase 1 (ms). It SHOULD time out (work left unfinished). */
  phase1Ms: number;
}

/** Wrap the original goal in a resume framing that forces state discovery. */
function resumePrompt(task: EvalTask): string {
  return [
    'A previous work session already STARTED this task but was interrupted before finishing.',
    'Its partial work persists in the current working directory.',
    '',
    'ORIGINAL TASK (the goal to complete):',
    task.prompt,
    '',
    'Before writing or changing anything, FIRST determine what has already been done so you do',
    'not redo or re-explore finished work — recover the prior progress from your durable state.',
    'Then complete everything that remains and verify it works before finishing.',
  ].join('\n');
}

function summarize(phase: PhaseResult, sPartial: number, sFull: boolean): PhaseSummary {
  return {
    tokenCost: phase.tokenCost,
    durationMs: phase.durationMs,
    numToolCalls: phase.toolCalls.length,
    redundantExplorationOps: computeRedundantExplorationOps(phase.toolCalls),
    readGraph: didReadGraph(phase.toolCalls),
    timedOut: phase.timedOut,
    completedCleanly: phase.completedCleanly,
    sPartial,
    sFull,
  };
}

export function runTaskWithReset(task: EvalTask, arm: EvalArm, opts: ResetOpts): RunResult {
  const workDir = seedWorkDir(task, `otc-reset-${task.id}-${arm.id}-`);
  try {
    // ── Phase 1: full task, capped. Expected to time out mid-task. ────────────
    const p1 = runAgentPhase({
      workDir,
      prompt: task.prompt,
      arm,
      model: opts.model,
      timeoutMs: opts.phase1Ms,
      env: opts.env,
    });
    const score1 = scoreCheckpoints(task, workDir);

    // ── Reset: nothing to do — the next spawn is a fresh, contextless session. ─

    // ── Phase 2: fresh agent resumes from durable state only. ─────────────────
    const p2 = runAgentPhase({
      workDir,
      prompt: resumePrompt(task),
      arm,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      env: opts.env,
    });
    const score2 = scoreCheckpoints(task, workDir);

    const phase1 = summarize(p1, score1.sPartial, score1.sFull);
    const phase2 = summarize(p2, score2.sPartial, score2.sFull);

    const combinedTools = [...p1.toolCalls, ...p2.toolCalls];
    const infraFailure =
      !!p2.error && !p2.timedOut && p2.tokenCost < 200 && score2.earned === 0 && score1.earned === 0;

    const result: RunResult = {
      taskId: task.id,
      armId: arm.id,
      repeat: opts.repeat,
      model: opts.model,
      // Final ground-truth score is the work dir AFTER phase 2.
      checkpointResults: score2.checkpointResults,
      sPartial: score2.sPartial,
      sFull: score2.sFull,
      // Top-level cost = combined; `phases` breaks out the re-orientation cost.
      tokenCost: p1.tokenCost + p2.tokenCost,
      durationMs: p1.durationMs + p2.durationMs,
      mcpServers: p2.mcpServers,
      toolCalls: combinedTools,
      redundantExplorationOps: computeRedundantExplorationOps(combinedTools),
      readGraph: didReadGraph(combinedTools),
      timedOut: p2.timedOut,
      infraFailure,
      error: p2.error,
      phases: { phase1, phase2 },
    };

    fs.mkdirSync(opts.traceDir, { recursive: true });
    fs.writeFileSync(
      path.join(opts.traceDir, `${task.id}__${arm.id}__reset__r${opts.repeat}.json`),
      JSON.stringify(
        {
          ...result,
          phase1ResultText: p1.resultText.slice(0, 2000),
          phase2ResultText: p2.resultText.slice(0, 2000),
        },
        null,
        2,
      ),
    );

    return result;
  } finally {
    stopOpentasksDaemon(workDir, opts.env);
    cleanupWorkDir(workDir);
  }
}
