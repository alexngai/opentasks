import type { ExecutionAdapter, PublicCell, RawRun, RunContext, TraceEvent } from 'swarmkit-eval';
import { scoreFromTacResult, type TacResultJson } from './score.js';

export class TacFakeAdapter implements ExecutionAdapter {
  readonly id = 'tac-fake';
  readonly placement = 'self' as const;

  async run(cell: PublicCell, _ctx: RunContext): Promise<RawRun> {
    const start = Date.now();
    await emitFakeStdout();
    await sleep(Number(process.env.EVAL_FAKE_SLEEP_MS ?? 0));
    const deps = dependenciesOf(cell);
    const baseTotal = 10;
    const earned = fakeEarned(cell.arm.id, cell.task.id, cell.seed, deps.length, baseTotal);
    const result: TacResultJson = {
      checkpoints: [
        { total: 2, result: Math.min(2, earned) },
        { total: 3, result: Math.max(0, Math.min(3, earned - 2)) },
        { total: 5, result: Math.max(0, Math.min(5, earned - 5)) },
      ],
      final_score: { total: baseTotal, result: earned },
    };
    const trajectory = fakeTrajectory(cell);
    const readGraph = trajectory.some((e) => e.type === 'tool' && e.name.startsWith('mcp__opentasks__'));
    return {
      output: `fake TAC result for ${cell.task.id}: ${earned}/${baseTotal}`,
      usage: {
        inputTokens: 800 + cell.task.prompt.length,
        outputTokens: 200 + earned * 10,
        totalTokens: Number(process.env.EVAL_FAKE_TOTAL_TOKENS ?? 1000 + cell.task.prompt.length + earned * 10),
      },
      trajectory,
      selfScore: scoreFromTacResult(result, {
        readGraph: readGraph ? 1 : 0,
        redundantExplorationOps: cell.arm.id === 'stock' ? 3 : cell.arm.id === 'notes' ? 2 : 1,
        serviceCount: deps.length,
      }),
      durationMs: Date.now() - start + 50,
    };
  }
}

async function emitFakeStdout(): Promise<void> {
  const streamTokens = Number(process.env.EVAL_FAKE_STREAM_TOKENS ?? 0);
  if (Number.isFinite(streamTokens) && streamTokens > 0) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: streamTokens,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [],
        },
      })}\n`,
    );
  }
  const totalBytes = Number(process.env.EVAL_FAKE_STDOUT_BYTES ?? 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return;
  const chunkBytes = Math.max(1, Number(process.env.EVAL_FAKE_STDOUT_CHUNK_BYTES ?? 1024));
  const delayMs = Math.max(0, Number(process.env.EVAL_FAKE_STDOUT_DELAY_MS ?? 0));
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    process.stdout.write('x'.repeat(size));
    remaining -= size;
    if (delayMs > 0) await sleep(delayMs);
  }
  process.stdout.write('\n');
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeEarned(armId: string, taskId: string, seed: number, serviceCount: number, total: number): number {
  const rng = mulberry32(hashStr(`${armId}:${taskId}:${seed}`));
  const armBonus = armId === 'opentasks' ? 2 : armId === 'notes' ? 1 : 0;
  const difficulty = Math.min(3, serviceCount);
  const value = 5 + armBonus - Math.floor(difficulty / 2) + Math.floor(rng() * 4);
  return Math.max(0, Math.min(total, value));
}

function fakeTrajectory(cell: PublicCell): TraceEvent[] {
  const ts = Date.now();
  const common: TraceEvent[] = [
    { type: 'tool', ts, name: 'Read', input: { file_path: '/instruction/task.md' } },
    { type: 'tool', ts: ts + 1, name: 'Bash', input: { command: 'curl http://the-agent-company.com:8929/' } },
  ];
  if (cell.arm.id !== 'opentasks') return common;
  return [
    ...common,
    { type: 'tool', ts: ts + 2, name: 'mcp__opentasks__create_task', input: { title: cell.task.id } },
    { type: 'tool', ts: ts + 3, name: 'mcp__opentasks__query', input: { ready: {} } },
  ];
}

function dependenciesOf(cell: PublicCell): string[] {
  const deps = cell.task.publicMetadata?.dependencies;
  return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
