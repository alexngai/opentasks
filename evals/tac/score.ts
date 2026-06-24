import type { CheckpointResult, Score } from 'swarmkit-eval';

export interface TacResultJson {
  checkpoints?: Array<{ total?: number; result?: number }>;
  final_score?: { total?: number; result?: number };
}

export function scoreFromTacResult(result: TacResultJson, metrics: Record<string, number> = {}): Score {
  const final = result.final_score ?? {};
  const total = finiteNonnegative(final.total) ? Number(final.total) : checkpointTotal(result);
  const earned = finiteNonnegative(final.result) ? Number(final.result) : checkpointEarned(result);
  const safeTotal = total > 0 ? total : 1;
  const safeEarned = Math.max(0, Math.min(earned, safeTotal));
  const full = total > 0 && safeEarned === safeTotal;
  return {
    full,
    partial: 0.5 * (safeEarned / safeTotal) + 0.5 * (full ? 1 : 0),
    earned: safeEarned,
    total: safeTotal,
    checkpoints: checkpointResults(result),
    metrics: {
      tacEarned: safeEarned,
      tacTotal: safeTotal,
      ...metrics,
    },
  };
}

function checkpointResults(result: TacResultJson): CheckpointResult[] {
  return (result.checkpoints ?? []).map((cp, i) => {
    const total = finiteNonnegative(cp.total) ? Number(cp.total) : 1;
    const earned = finiteNonnegative(cp.result) ? Number(cp.result) : 0;
    return {
      id: `checkpoint-${i + 1}`,
      weight: total,
      passed: total > 0 && earned >= total,
      detail: `${earned}/${total}`,
    };
  });
}

function checkpointTotal(result: TacResultJson): number {
  return (result.checkpoints ?? []).reduce((sum, cp) => sum + (finiteNonnegative(cp.total) ? Number(cp.total) : 0), 0);
}

function checkpointEarned(result: TacResultJson): number {
  return (result.checkpoints ?? []).reduce((sum, cp) => sum + (finiteNonnegative(cp.result) ? Number(cp.result) : 0), 0);
}

function finiteNonnegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
