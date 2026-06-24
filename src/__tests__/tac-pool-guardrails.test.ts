import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('TAC pool guardrails', () => {
  it('marks a cell as budget_exceeded when the pool cell timeout fires', async () => {
    const fixture = await createTacPoolFixture(['task-timeout']);
    await runPool(fixture, {
      EVAL_TASKS: 'task-timeout',
      EVAL_FAKE_SLEEP_MS: '2000',
      TAC_CELL_TIMEOUT_SEC: '0.2',
    });

    const record = await readCellRecord(fixture.outDir, 'task-timeout__stock__haiku__seed1');
    expect(record.result.status).toBe('budget_exceeded');
    expect(record.result.budgetExceeded).toBe('timeout');
    expect(record.result.envError).toBeNull();
  }, 20_000);

  it('marks a completed cell as budget_exceeded when it exceeds the token ceiling', async () => {
    const fixture = await createTacPoolFixture(['task-token']);
    await runPool(fixture, {
      EVAL_TASKS: 'task-token',
      EVAL_FAKE_TOTAL_TOKENS: '1234',
      TAC_CELL_MAX_TOKENS: '100',
    });

    const record = await readCellRecord(fixture.outDir, 'task-token__stock__haiku__seed1');
    expect(record.result.status).toBe('budget_exceeded');
    expect(record.result.budgetExceeded).toBe('tokens');
    expect(record.result.envError).toBeNull();
    expect(record.result.tokens).toBe(1234);
    expect(record.result.metrics.budgetMaxTokens).toBe(100);
  }, 20_000);

  it('kills a stream-json cell when live token usage exceeds the ceiling', async () => {
    const fixture = await createTacPoolFixture(['task-live-token']);
    await runPool(fixture, {
      EVAL_TASKS: 'task-live-token',
      EVAL_FAKE_STREAM_TOKENS: '500',
      EVAL_FAKE_SLEEP_MS: '2000',
      TAC_CELL_MAX_TOKENS: '100',
    });

    const record = await readCellRecord(fixture.outDir, 'task-live-token__stock__haiku__seed1');
    expect(record.result.status).toBe('budget_exceeded');
    expect(record.result.budgetExceeded).toBe('tokens_live');
    expect(record.result.envError).toBeNull();
    expect(record.result.tokens).toBe(500);
    expect(record.result.metrics.budgetLiveTokens).toBe(1);
    expect(record.result.metrics.budgetMaxTokens).toBe(100);
  }, 20_000);

  it('kills a noisy cell when the output byte ceiling is exceeded', async () => {
    const fixture = await createTacPoolFixture(['task-output']);
    await runPool(fixture, {
      EVAL_TASKS: 'task-output',
      EVAL_FAKE_STDOUT_BYTES: '20000',
      EVAL_FAKE_STDOUT_CHUNK_BYTES: '1024',
      EVAL_FAKE_STDOUT_DELAY_MS: '10',
      TAC_CELL_MAX_OUTPUT_BYTES: '4096',
    });

    const record = await readCellRecord(fixture.outDir, 'task-output__stock__haiku__seed1');
    expect(record.result.status).toBe('budget_exceeded');
    expect(record.result.budgetExceeded).toBe('output_bytes');
    expect(record.result.envError).toBeNull();
    expect(record.result.metrics.budgetOutputBytes).toBeGreaterThan(4096);
  }, 20_000);

  it('stops scheduling new cells after the run-level token budget is reached', async () => {
    const fixture = await createTacPoolFixture(['task-a', 'task-b']);
    await runPool(fixture, {
      EVAL_TASKS: 'task-a,task-b',
      EVAL_FAKE_TOTAL_TOKENS: '200',
      TAC_POOL_MAX_TOTAL_TOKENS: '100',
    });

    const summary = JSON.parse(await fs.readFile(path.join(fixture.outDir, 'summary.json'), 'utf8'));
    expect(summary.cells).toHaveLength(1);
    expect(summary.unstartedCells).toBe(1);
    expect(summary.stopReason).toContain('TAC_POOL_MAX_TOTAL_TOKENS=100');
  }, 20_000);
});

interface Fixture {
  tacRoot: string;
  outDir: string;
}

async function createTacPoolFixture(taskIds: string[]): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-tac-pool-'));
  const tacRoot = path.join(root, 'tac');
  const outDir = path.join(root, 'out');
  for (const taskId of taskIds) {
    const taskDir = path.join(tacRoot, 'workspaces', 'tasks', taskId);
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'task.md'), `Do ${taskId}.\n`);
    await fs.writeFile(path.join(taskDir, 'dependencies.yml'), '- gitlab\n');
  }
  return { tacRoot, outDir };
}

async function runPool(fixture: Fixture, env: Record<string, string>): Promise<void> {
  await execFileAsync('npx', ['tsx', 'evals/tac/run-pool.ts'], {
    cwd: repoRoot,
    maxBuffer: 2_000_000,
    env: {
      ...process.env,
      TAC_ROOT: fixture.tacRoot,
      TAC_POOL_OUT_DIR: fixture.outDir,
      TAC_POOL_RUN_ID: 'guardrail-test',
      TAC_POOL_WORKERS_JSON: JSON.stringify([{ name: 'fake-worker' }]),
      TAC_POOL_RESUME: '0',
      TAC_POOL_RESULTS_S3_URI: '',
      EVAL_FAKE: '1',
      EVAL_BACKEND: 'in-process',
      EVAL_MODEL: 'haiku',
      EVAL_ARMS: 'stock',
      EVAL_REPEATS: '1',
      EVAL_SEEDS: '1',
      ...env,
    },
  });
}

async function readCellRecord(outDir: string, cellId: string): Promise<any> {
  const file = path.join(outDir, 'cells', cellId, 'cell-result.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
