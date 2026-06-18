/**
 * swarmkit-eval ExecutionAdapter that drives OpenTasks' synthetic emit-queue cells
 * (B = concurrency, C = continuity, D = both). The multi-agent + collector + reset
 * execution already lives in `../synthetic/*` (robust); this is a thin wrapper that
 * runs one trial per swarmkit cell and maps the ExactlyOnceScore → a swarmkit Score
 * (full = correct; race/re-emit counts ride in `score.metrics`, which swarmkit-eval
 * now aggregates into per-arm CIs).
 *
 * placement = 'self': the synthetic runner manages its own work dir + collector +
 * daemon, so the swarmkit backend workspace is unused.
 */

import type { ExecutionAdapter, PublicCell, RunContext, RawRun, Score, TokenUsage } from 'swarmkit-eval';
import { runConcurrencyCell } from '../synthetic/concurrency-runner.js';
import { runContinuityCell } from '../synthetic/continuity-runner.js';
import { runCellD } from '../synthetic/celld-runner.js';
import type { ExactlyOnceScore } from '../synthetic/collector.js';
import type { ArmId } from '../types.js';

export type SynthCell = 'B' | 'C' | 'D';

/** The superset of opts the three cell runners accept (each ignores the fields it doesn't need). */
export interface SynthRunnerOpts {
  model: string;
  n: number;
  m: number;
  k: number;
  repeat: number;
  phase1Ms: number;
  timeoutMs: number;
  env?: Record<string, string>;
  traceDir: string;
}

/** The slice of a runner's result this adapter consumes. Concurrency/Continuity/CellD all satisfy it. */
export interface SynthRunnerResult {
  score: ExactlyOnceScore;
  tokenCost: number;
  durationMs: number;
  mcpConnected?: boolean;
  /** continuity (C/D) only — phase-2 re-emits of already-done items. */
  phase2ReEmits?: number;
}

export type SynthRunner = (armId: ArmId, opts: SynthRunnerOpts) => Promise<SynthRunnerResult>;
export type SynthRunners = Record<SynthCell, SynthRunner>;

const DEFAULT_RUNNERS: SynthRunners = {
  B: (a, o) => runConcurrencyCell(a, o),
  C: (a, o) => runContinuityCell(a, o),
  D: (a, o) => runCellD(a, o),
};

export interface SynthAdapterOpts {
  cell: SynthCell;
  n: number;
  m: number;
  k: number;
  phase1Ms: number;
  timeoutMs: number;
  env?: Record<string, string>;
  traceDir: string;
  /** Injectable runners (tests / EVAL_FAKE zero-token validation). */
  runners?: Partial<SynthRunners>;
}

export class SyntheticSwarmAdapter implements ExecutionAdapter {
  readonly id: string;
  readonly placement = 'self' as const;
  private readonly runners: SynthRunners;

  constructor(private readonly opts: SynthAdapterOpts) {
    this.id = `synth-${opts.cell}`;
    this.runners = { ...DEFAULT_RUNNERS, ...(opts.runners ?? {}) };
  }

  async run(cell: PublicCell, _ctx: RunContext): Promise<RawRun> {
    const armId = cell.arm.id as ArmId;
    // Each swarmkit "task" is one trial (repeat); the runner does the N-agent fan-out internally.
    const repeat = Number((cell.task.publicMetadata?.repeat as number | undefined) ?? cell.seed);
    const runnerOpts: SynthRunnerOpts = {
      model: cell.model.name,
      n: this.opts.n,
      m: this.opts.m,
      k: this.opts.k,
      repeat,
      phase1Ms: this.opts.phase1Ms,
      timeoutMs: this.opts.timeoutMs,
      env: this.opts.env,
      traceDir: this.opts.traceDir,
    };

    const start = Date.now();
    try {
      const r = await this.runners[this.opts.cell](armId, runnerOpts);
      const s = r.score;
      const metrics: Record<string, number> = {
        doubleEmits: s.doubleEmits,
        missed: s.missed,
        exactlyOnce: s.exactlyOnce,
        distinctEmitted: s.distinctEmitted,
      };
      if (typeof r.phase2ReEmits === 'number') metrics.p2ReEmits = r.phase2ReEmits;

      const selfScore: Score = {
        full: s.correct,
        partial: s.m > 0 ? s.exactlyOnce / s.m : 0,
        earned: s.exactlyOnce,
        total: s.m,
        checkpoints: [],
        metrics,
      };
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: r.tokenCost };
      return { output: '', usage, trajectory: [], selfScore, durationMs: r.durationMs };
    } catch (e) {
      return {
        output: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        trajectory: [],
        durationMs: Date.now() - start,
        envError: {
          kind: 'crash',
          message: `synthetic cell ${this.opts.cell} runner failed: ${(e as Error).message}`.slice(0, 200),
          retriable: false,
        },
      };
    }
  }
}
