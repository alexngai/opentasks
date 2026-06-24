import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tacSelectorFromEnv } from './bench.js';
import { loadTacTasks, parseTaskList, selectTacTasks } from './tasks.js';
import { defaultTacRoot } from './tasks.js';
import { tacAgentHarnessInstallCommand } from './agent-harness.js';

interface PoolWorker {
  id?: string;
  name?: string;
  host?: string;
  public_ip?: string;
  publicIp?: string;
  public_dns?: string;
  publicDns?: string;
  ssh_user?: string;
  sshUser?: string;
  ssh_key_path?: string;
  sshKeyPath?: string;
  worker_index?: number;
}

interface PoolCell {
  id: string;
  taskId: string;
  arm: string;
  model: string;
  seed: number;
}

interface CellSummary {
  taskId: string;
  arm: string;
  model: string;
  seed: number;
  status: string;
  partial: number;
  full: boolean;
  envError: string | null;
  envErrorRetriable: boolean;
  budgetExceeded: string | null;
  tokens: number;
  durationMs: number;
  metrics: Record<string, number>;
}

interface CellRecord {
  cell: PoolCell;
  worker: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  status: string;
  result: CellSummary;
  reportPath?: string;
}

interface WorkerState {
  worker: PoolWorker;
  index: number;
  label: string;
  quarantined: boolean;
  envErrorStreak: number;
}

const execFileAsync = promisify(execFile);
const TAC_ROOT = process.env.TAC_ROOT ?? defaultTacRoot();
const RUN_ID = process.env.TAC_POOL_RUN_ID ?? `tac-pool-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const OUT_BASE = path.resolve(process.cwd(), process.env.TAC_POOL_OUT_DIR ?? `evals/.tac-pool-runs/${RUN_ID}`);
const DRY_RUN = process.env.TAC_POOL_DRY_RUN === '1';
const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const ARM_IDS = parseList(process.env.EVAL_ARMS ?? 'stock,notes,opentasks');
const SEEDS = parseSeeds(process.env.EVAL_SEEDS, Number(process.env.EVAL_REPEATS ?? 1));
const RESUME = process.env.TAC_POOL_RESUME !== '0';
const MAX_CELL_ATTEMPTS = numberEnv(process.env.TAC_POOL_CELL_MAX_ATTEMPTS, 2);
const WORKER_ENV_ERROR_THRESHOLD = numberEnv(process.env.TAC_POOL_WORKER_ENV_ERROR_THRESHOLD, 2);
const FAIL_ON_ENV_ERROR = process.env.TAC_POOL_FAIL_ON_ENV_ERROR !== '0';
const CONFIG_VERSION = process.env.EVAL_CONFIG_VERSION ?? process.env.TAC_POOL_CONFIG_VERSION ?? 'tac-pool-v3';
const S3_SYNC_EVERY = numberEnv(process.env.TAC_POOL_S3_SYNC_EVERY_CELLS, 1);
const MAX_RUNTIME_MS = numberEnv(process.env.TAC_POOL_MAX_RUNTIME_SEC, 0) * 1000;
const CELL_TIMEOUT_MS = numberEnv(process.env.TAC_CELL_TIMEOUT_SEC, 0) * 1000;
const CELL_MAX_TOKENS = numberEnv(process.env.TAC_CELL_MAX_TOKENS, 0);
const CELL_LIVE_TOKEN_KILL = process.env.TAC_CELL_LIVE_TOKEN_KILL !== '0';
const CELL_MAX_OUTPUT_BYTES = numberEnv(process.env.TAC_CELL_MAX_OUTPUT_BYTES ?? process.env.TAC_CELL_MAX_STDOUT_BYTES, 0);
const RUN_MAX_FINISHED_CELLS = numberEnv(process.env.TAC_POOL_MAX_FINISHED_CELLS ?? process.env.TAC_POOL_MAX_COMPLETED_CELLS, 0);
const RUN_MAX_TOTAL_TOKENS = numberEnv(process.env.TAC_POOL_MAX_TOTAL_TOKENS, 0);
const RUN_MAX_ENV_ERRORS = numberEnv(process.env.TAC_POOL_MAX_ENV_ERRORS, 0);
const GRADER_PROXY = process.env.TAC_GRADER_PROXY;
const STARTED_AT_MS = Date.now();
let completedSinceLastS3Sync = 0;
const runCounters = {
  finishedCells: 0,
  totalTokens: 0,
  envErrors: 0,
};
let poolStopReason: string | null = null;

async function main(): Promise<void> {
  const workers = await loadWorkers();
  if (!workers.length) throw new Error('TAC EC2 pool has no workers');

  const tasks = await selectedTaskIds();
  if (!tasks.length) throw new Error('TAC selector matched no tasks');
  const cells = buildCells(tasks);
  if (!cells.length) throw new Error('TAC pool planned no cells');

  await fs.mkdir(OUT_BASE, { recursive: true });
  if (RESUME) await syncResultsFromS3();

  const provenance = await loadProvenance(workers, tasks, cells);
  await fs.writeFile(path.join(OUT_BASE, 'manifest.json'), JSON.stringify(provenance, null, 2));

  console.log(
    `tac ec2 pool · run=${RUN_ID} workers=${workers.length} tasks=${tasks.length} cells=${cells.length} ` +
      `resume=${RESUME ? 'on' : 'off'} out=${OUT_BASE}`,
  );
  console.log(`  model=${MODEL} arms=${ARM_IDS.join(',')} seeds=${SEEDS.join(',')} config=${CONFIG_VERSION}`);
  plannedShards(cells, workers).forEach((ids, i) =>
    console.log(`  worker ${workerLabel(workers[i]!, i)}: ${ids.length} planned cell(s)`),
  );

  if (DRY_RUN) {
    await fs.writeFile(path.join(OUT_BASE, 'cells.json'), JSON.stringify({ runId: RUN_ID, cells }, null, 2));
    await fs.writeFile(path.join(OUT_BASE, 'planned-shards.json'), JSON.stringify({ runId: RUN_ID, shards: plannedShards(cells, workers) }, null, 2));
    console.log(`dry run -> ${path.relative(process.cwd(), path.join(OUT_BASE, 'cells.json'))}`);
    return;
  }

  const queue: PoolCell[] = [];
  const skipped: PoolCell[] = [];
  for (const cell of cells) {
    const existing = RESUME ? await readCellRecord(cell) : null;
    if (existing && isCompleted(existing)) skipped.push(cell);
    else queue.push(cell);
  }

  if (skipped.length) console.log(`resume skipped ${skipped.length} completed cell(s)`);
  console.log(
    `queue ${queue.length} cell(s), maxAttempts=${MAX_CELL_ATTEMPTS}, quarantineAfter=${WORKER_ENV_ERROR_THRESHOLD} env_error(s), ` +
      `cellTimeout=${CELL_TIMEOUT_MS ? `${Math.round(CELL_TIMEOUT_MS / 1000)}s` : 'off'}, ` +
      `maxTokens=${CELL_MAX_TOKENS || 'off'}, maxOutputBytes=${CELL_MAX_OUTPUT_BYTES || 'off'}`,
  );

  const states = workers.map((worker, index) => ({
    worker,
    index,
    label: workerLabel(worker, index),
    quarantined: false,
    envErrorStreak: 0,
  }));
  const attempts = new Map<string, number>();

  await Promise.all(states.map((state) => workerLoop(state, queue, attempts)));
  if (queue.length && !poolStopReason) {
    console.error(`pool stopped with ${queue.length} unstarted cell(s); all available workers were exhausted or quarantined`);
  } else if (queue.length && poolStopReason) {
    console.error(`pool stopped with ${queue.length} unstarted cell(s) because ${poolStopReason}`);
  }

  const summary = await writeSummary(states, queue.length);
  await syncResultsToS3(true);

  const finalEnvErrors = summary.cells.filter((cell) => cell.envError).length;
  const quarantinedWorkers = states.filter((state) => state.quarantined).length;
  if ((queue.length && !poolStopReason) || quarantinedWorkers || (FAIL_ON_ENV_ERROR && finalEnvErrors)) process.exit(1);
}

async function loadWorkers(): Promise<PoolWorker[]> {
  const raw = process.env.TAC_POOL_WORKERS_JSON ?? (process.env.TAC_POOL_MANIFEST ? await fs.readFile(process.env.TAC_POOL_MANIFEST, 'utf8') : undefined);
  if (!raw) throw new Error('Set TAC_POOL_MANIFEST or TAC_POOL_WORKERS_JSON');
  const parsed = JSON.parse(raw);
  const value = parsed?.value ?? parsed;
  const workers = Array.isArray(value) ? value : value.workers;
  if (!Array.isArray(workers)) throw new Error('Pool manifest must be a worker array or an object with a workers array');
  return workers as PoolWorker[];
}

async function selectedTaskIds(): Promise<string[]> {
  const tasks = await loadTacTasks({ root: TAC_ROOT, version: process.env.TAC_VERSION ?? '1.0.0' });
  const selector = tacSelectorFromEnv();
  const explicitIds = parseTaskList(process.env.EVAL_TASKS);
  const selected = selectTacTasks(tasks, { ...selector, ids: explicitIds ?? selector.ids });
  const limit = process.env.EVAL_TASK_LIMIT ? Number(process.env.EVAL_TASK_LIMIT) : undefined;
  return selected.slice(0, limit ?? selected.length).map((t) => t.id);
}

function buildCells(taskIds: string[]): PoolCell[] {
  const cells: PoolCell[] = [];
  for (const taskId of taskIds) {
    for (const arm of ARM_IDS) {
      for (const seed of SEEDS) {
        cells.push({ id: cellId(taskId, arm, MODEL, seed), taskId, arm, model: MODEL, seed });
      }
    }
  }
  return cells;
}

async function workerLoop(state: WorkerState, queue: PoolCell[], attempts: Map<string, number>): Promise<void> {
  while (!state.quarantined) {
    const stopReason = schedulingStopReason();
    if (stopReason) {
      poolStopReason ??= stopReason;
      console.error(`[${state.label}] stopping scheduler because ${stopReason}`);
      return;
    }
    const cell = queue.shift();
    if (!cell) return;

    const attempt = (attempts.get(cell.id) ?? 0) + 1;
    attempts.set(cell.id, attempt);
    const record = await runCell(state, cell, attempt);
    recordRunResult(record);

    if (record.result.envError) {
      state.envErrorStreak += 1;
      const canRetry = record.result.envErrorRetriable && attempt < MAX_CELL_ATTEMPTS && !schedulingStopReason();
      if (canRetry) queue.push(cell);
      if (state.envErrorStreak >= WORKER_ENV_ERROR_THRESHOLD) {
        state.quarantined = true;
        console.error(`[${state.label}] quarantined after ${state.envErrorStreak} consecutive env_error cell(s)`);
      }
      continue;
    }

    state.envErrorStreak = 0;
  }
}

async function runCell(state: WorkerState, cell: PoolCell, attempt: number): Promise<CellRecord> {
  const backend = process.env.EVAL_FAKE === '1' ? process.env.EVAL_BACKEND ?? 'in-process' : 'ec2';
  const host = state.worker.host ?? state.worker.public_ip ?? state.worker.publicIp ?? state.worker.public_dns ?? state.worker.publicDns;
  if (backend === 'ec2' && !host) throw new Error(`Worker ${state.index} has no host/public_ip/public_dns`);
  const sshKeyPath = state.worker.ssh_key_path ?? state.worker.sshKeyPath ?? process.env.EC2_SSH_KEY_PATH;
  if (backend === 'ec2' && !sshKeyPath) throw new Error(`Worker ${state.label} needs ssh_key_path or EC2_SSH_KEY_PATH`);

  const outDir = path.join(OUT_BASE, 'cells', cell.id);
  await fs.mkdir(outDir, { recursive: true });
  const stdoutPath = path.join(outDir, `attempt-${attempt}.stdout.log`);
  const stderrPath = path.join(outDir, `attempt-${attempt}.stderr.log`);
  const startedAt = new Date().toISOString();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...graderProxyEnv(),
    EVAL_BACKEND: backend,
    EC2_HOST: host,
    EC2_SSH_USER: state.worker.ssh_user ?? state.worker.sshUser ?? process.env.EC2_SSH_USER ?? 'ubuntu',
    EC2_SSH_KEY_PATH: sshKeyPath,
    EC2_SSH_OPTIONS: process.env.EC2_SSH_OPTIONS ?? '-o,LogLevel=ERROR',
    EC2_TERMINATE_ON_DISPOSE: 'false',
    EC2_SETUP_COMMANDS: ec2SetupCommands(),
    EC2_COMMAND_TIMEOUT: process.env.EC2_COMMAND_TIMEOUT ?? '1200000',
    TAC_SERVER_HOSTNAME: process.env.TAC_SERVER_HOSTNAME ?? '127.0.0.1',
    TAC_DOCKER_NETWORK: process.env.TAC_DOCKER_NETWORK ?? 'host',
    TAC_AGENT_USER: process.env.TAC_AGENT_USER ?? 'agent',
    TAC_AGENT_SETUP_CMD: process.env.TAC_AGENT_SETUP_CMD ?? defaultAgentSetupCommand(),
    TAC_OPENTASKS_MOUNT: process.env.TAC_OPENTASKS_MOUNT ?? process.env.TAC_POOL_REMOTE_OPENTASKS_DIR ?? '/home/ubuntu/opentasks',
    ...(CELL_LIVE_TOKEN_KILL && CELL_MAX_TOKENS > 0
      ? { TAC_AGENT_LIVE_MAX_TOKENS: process.env.TAC_AGENT_LIVE_MAX_TOKENS ?? String(CELL_MAX_TOKENS) }
      : {}),
    EVAL_MODEL: cell.model,
    EVAL_ARMS: cell.arm,
    EVAL_TASKS: cell.taskId,
    EVAL_TASK_LIMIT: '',
    EVAL_SEEDS: String(cell.seed),
    EVAL_OUT_DIR: outDir,
    EVAL_STORE_DIR: process.env.EVAL_STORE_DIR ?? path.join(OUT_BASE, 'store'),
    EVAL_CONCURRENCY: '1',
    EVAL_CONFIG_VERSION: CONFIG_VERSION,
  };
  delete env.TAC_POOL_MANIFEST;
  delete env.TAC_POOL_WORKERS_JSON;

  console.log(`[${state.label}] ${cell.id} attempt ${attempt}/${MAX_CELL_ATTEMPTS}`);
  const child = spawn('npx', ['tsx', 'evals/tac/run.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const stdout = fsSync.createWriteStream(stdoutPath, { flags: 'a' });
  const stderr = fsSync.createWriteStream(stderrPath, { flags: 'a' });
  let timedOut = false;
  let outputExceeded = false;
  let liveTokenExceeded = false;
  let liveTokens = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const killForBudget = (reason: 'timeout' | 'output' | 'tokens_live') => {
    if (reason === 'timeout') timedOut = true;
    if (reason === 'output') outputExceeded = true;
    if (reason === 'tokens_live') liveTokenExceeded = true;
    terminateChild(child);
  };
  const timeout = CELL_TIMEOUT_MS > 0 ? setTimeout(() => killForBudget('timeout'), CELL_TIMEOUT_MS) : undefined;
  const usageMonitor = createClaudeUsageMonitor((tokens) => {
    liveTokens = Math.max(liveTokens, tokens);
    if (CELL_LIVE_TOKEN_KILL && CELL_MAX_TOKENS > 0 && tokens > CELL_MAX_TOKENS) killForBudget('tokens_live');
  });
  prefixWithBudget(child.stdout, `[${state.label}]`, stdout, (bytes, chunk) => {
    stdoutBytes = bytes;
    if (CELL_MAX_OUTPUT_BYTES > 0 && stdoutBytes + stderrBytes > CELL_MAX_OUTPUT_BYTES) killForBudget('output');
    usageMonitor(chunk);
  });
  prefixWithBudget(child.stderr, `[${state.label} ERR]`, stderr, (bytes) => {
    stderrBytes = bytes;
    if (CELL_MAX_OUTPUT_BYTES > 0 && stdoutBytes + stderrBytes > CELL_MAX_OUTPUT_BYTES) killForBudget('output');
  });

  const exitCode = await new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  if (timeout) clearTimeout(timeout);
  stdout.end();
  stderr.end();

  const reportPath = path.join(outDir, 'report.json');
  let result = (await readCellSummary(reportPath)) ?? syntheticEnvError(cell, exitCode);
  if (timedOut) {
    result = syntheticBudgetExceeded(cell, 'timeout', `TAC_CELL_TIMEOUT_SEC=${CELL_TIMEOUT_MS / 1000} exceeded`, Date.now() - Date.parse(startedAt), result.tokens);
  } else if (outputExceeded) {
    result = syntheticBudgetExceeded(
      cell,
      'output_bytes',
      `TAC_CELL_MAX_OUTPUT_BYTES=${CELL_MAX_OUTPUT_BYTES} exceeded`,
      Date.now() - Date.parse(startedAt),
      result.tokens,
      stdoutBytes + stderrBytes,
    );
  } else if (liveTokenExceeded) {
    result = syntheticBudgetExceeded(
      cell,
      'tokens_live',
      `TAC_CELL_MAX_TOKENS=${CELL_MAX_TOKENS} exceeded during live stream monitoring`,
      Date.now() - Date.parse(startedAt),
      Math.max(result.tokens, liveTokens),
    );
  } else {
    result = applyPosthocBudgetCaps(result);
  }
  const record: CellRecord = {
    cell,
    worker: state.label,
    attempt,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    status: result.status,
    result,
    reportPath: path.relative(process.cwd(), reportPath),
  };
  await fs.writeFile(path.join(outDir, 'cell-result.json'), JSON.stringify(record, null, 2));
  completedSinceLastS3Sync += 1;
  await syncResultsToS3(false);
  return record;
}

function graderProxyEnv(): NodeJS.ProcessEnv {
  if (GRADER_PROXY !== 'bedrock') return {};
  const port = process.env.TAC_GRADER_PROXY_PORT ?? '4000';
  const host = process.env.TAC_GRADER_PROXY_HOST ?? '127.0.0.1';
  const model = process.env.TAC_GRADER_PROXY_MODEL ?? 'tac-grader';
  const key = process.env.TAC_GRADER_PROXY_KEY ?? process.env.LITELLM_API_KEY ?? 'sk-tac-grader-local';
  return {
    TAC_GRADER_PROXY: 'bedrock',
    TAC_GRADER_PROXY_HOST: host,
    TAC_GRADER_PROXY_PORT: port,
    TAC_GRADER_PROXY_MODEL: model,
    TAC_GRADER_PROXY_KEY: key,
    TAC_GRADER_BEDROCK_MODEL: process.env.TAC_GRADER_BEDROCK_MODEL ?? 'bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    TAC_GRADER_BEDROCK_REGION: process.env.TAC_GRADER_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-west-2',
    LITELLM_API_KEY: key,
    LITELLM_BASE_URL: process.env.LITELLM_BASE_URL ?? `http://${host}:${port}/v1`,
    LITELLM_MODEL: process.env.LITELLM_MODEL ?? openAiCompatibleLitellmModel(model),
  };
}

function openAiCompatibleLitellmModel(model: string): string {
  return model.includes('/') ? model : `openai/${model}`;
}

function ec2SetupCommands(): string {
  const commands = parseSetupCommands(process.env.EC2_SETUP_COMMANDS ?? 'docker --version');
  if (GRADER_PROXY === 'bedrock' && !commands.some((cmd) => cmd.includes('start-litellm-bedrock-proxy.sh'))) {
    commands.push('/home/ubuntu/opentasks/evals/tac/scripts/start-litellm-bedrock-proxy.sh');
  }
  return commands.join(';;');
}

function parseSetupCommands(value: string): string[] {
  return value
    .split(';;')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readCellSummary(reportPath: string): Promise<CellSummary | null> {
  try {
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const cell = report.cells?.[0];
    if (!cell) return null;
    return {
      taskId: cell.taskId,
      arm: cell.armId,
      model: cell.model,
      seed: cell.seed,
      status: cell.status,
      partial: cell.score?.partial ?? 0,
      full: cell.score?.full === true,
      envError: cell.envError?.kind ?? null,
      envErrorRetriable: cell.envError?.retriable ?? false,
      budgetExceeded: null,
      tokens: cell.usage?.totalTokens ?? 0,
      durationMs: cell.durationMs ?? 0,
      metrics: cell.score?.metrics ?? {},
    };
  } catch {
    return null;
  }
}

function syntheticEnvError(cell: PoolCell, exitCode: number): CellSummary {
  return {
    taskId: cell.taskId,
    arm: cell.arm,
    model: cell.model,
    seed: cell.seed,
    status: 'env_error',
    partial: 0,
    full: false,
    envError: 'bridge',
    envErrorRetriable: true,
    budgetExceeded: null,
    tokens: 0,
    durationMs: 0,
    metrics: {},
  };
}

function syntheticBudgetExceeded(
  cell: PoolCell,
  reason: string,
  message: string,
  durationMs: number,
  tokens = 0,
  outputBytes = 0,
): CellSummary {
  return {
    taskId: cell.taskId,
    arm: cell.arm,
    model: cell.model,
    seed: cell.seed,
    status: 'budget_exceeded',
    partial: 0,
    full: false,
    envError: null,
    envErrorRetriable: false,
    budgetExceeded: reason,
    tokens,
    durationMs,
    metrics: {
      budgetExceeded: 1,
      budgetTimeout: reason === 'timeout' ? 1 : 0,
      budgetLiveTokens: reason === 'tokens_live' ? 1 : 0,
      budgetMaxTokens: reason === 'tokens_live' ? CELL_MAX_TOKENS : 0,
      budgetOutputBytes: outputBytes,
    },
  };
}

function applyPosthocBudgetCaps(result: CellSummary): CellSummary {
  if (result.envError || result.budgetExceeded) return result;
  if (result.metrics.budgetLiveTokens === 1 || result.metrics.liveTokenBudgetExceeded === 1) {
    return {
      ...result,
      status: 'budget_exceeded',
      partial: 0,
      full: false,
      envError: null,
      envErrorRetriable: false,
      budgetExceeded: 'tokens_live',
      metrics: {
        ...result.metrics,
        budgetExceeded: 1,
        budgetMaxTokens: CELL_MAX_TOKENS,
        budgetOriginalPartial: result.partial,
      },
    };
  }
  if (CELL_MAX_TOKENS > 0 && result.tokens > CELL_MAX_TOKENS) {
    return {
      ...result,
      status: 'budget_exceeded',
      partial: 0,
      full: false,
      envError: null,
      envErrorRetriable: false,
      budgetExceeded: 'tokens',
      metrics: {
        ...result.metrics,
        budgetExceeded: 1,
        budgetMaxTokens: CELL_MAX_TOKENS,
        budgetOriginalPartial: result.partial,
      },
    };
  }
  return result;
}

async function readCellRecord(cell: PoolCell): Promise<CellRecord | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(OUT_BASE, 'cells', cell.id, 'cell-result.json'), 'utf8')) as CellRecord;
  } catch {
    return null;
  }
}

function isCompleted(record: CellRecord): boolean {
  return record.result.status === 'success' || record.result.status === 'failure' || record.result.status === 'budget_exceeded';
}

async function writeSummary(states: WorkerState[], unstartedCells: number): Promise<{ runId: string; cells: CellSummary[]; aggregate: any[] }> {
  const cellDirs = await listCellDirs();
  const cells: CellSummary[] = [];
  const records: CellRecord[] = [];
  for (const dir of cellDirs) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, 'cell-result.json'), 'utf8')) as CellRecord;
      records.push(record);
      cells.push(record.result);
    } catch {
      // Incomplete cell directories are expected after interrupted runs.
    }
  }

  const groups = new Map<string, CellSummary[]>();
  for (const cell of cells) {
    const key = `${cell.arm}\t${cell.model}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }

  const aggregate = [...groups.entries()].map(([key, values]) => {
    const [arm, model] = key.split('\t');
    return {
      arm,
      model,
      n: values.length,
      envErrors: values.filter((v) => v.envError).length,
      budgetExceeded: values.filter((v) => v.budgetExceeded).length,
      successRate: mean(values.map((v) => (v.status === 'success' ? 1 : 0))),
      sPartial: mean(values.map((v) => v.partial)),
      fullRate: mean(values.map((v) => (v.full ? 1 : 0))),
      tokens: sum(values.map((v) => v.tokens)),
      latencyP50Ms: percentile(values.map((v) => v.durationMs), 0.5),
      metrics: aggregateMetrics(values),
    };
  });

  const summary = {
    runId: RUN_ID,
    outDir: OUT_BASE,
    unstartedCells,
    workers: states.map((state) => ({
      label: state.label,
      quarantined: state.quarantined,
      envErrorStreak: state.envErrorStreak,
    })),
    stopReason: poolStopReason,
    cells,
    records,
    aggregate,
  };
  await fs.writeFile(path.join(OUT_BASE, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(OUT_BASE, 'summary.md'), renderSummary(summary));
  console.log(`\npool summary -> ${path.relative(process.cwd(), path.join(OUT_BASE, 'summary.md'))}`);
  return summary;
}

async function listCellDirs(): Promise<string[]> {
  const root = path.join(OUT_BASE, 'cells');
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

function renderSummary(summary: { runId: string; cells: CellSummary[]; aggregate: any[]; unstartedCells: number; workers: any[]; stopReason?: string | null }): string {
  const rows = summary.aggregate
    .map(
      (a) =>
        `| ${a.arm} | ${a.model} | ${a.n} | ${(a.successRate * 100).toFixed(1)}% | ${a.sPartial.toFixed(3)} | ` +
        `${a.envErrors} | ${a.budgetExceeded} | ${a.tokens} | ${Math.round(a.latencyP50Ms / 1000)}s | ${metricText(a.metrics)} |`,
    )
    .join('\n');
  const quarantined = summary.workers.filter((worker) => worker.quarantined).length;
  return `# TAC EC2 pool summary\n\nRun: \`${summary.runId}\`\n\nCells: ${summary.cells.length}\n\n` +
    `Unstarted cells: ${summary.unstartedCells}\n\nQuarantined workers: ${quarantined}\n\n` +
    `Stop reason: ${summary.stopReason ?? 'none'}\n\n` +
    '| Arm | Model | n | Success | S_partial | EnvErr | Budget | Tokens | p50 latency | Metrics |\n' +
    '|---|---|--:|--:|--:|--:|--:|--:|--:|---|\n' +
    `${rows}\n`;
}

function aggregateMetrics(values: CellSummary[]): Record<string, number> {
  const keys = new Set(values.flatMap((v) => Object.keys(v.metrics)));
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = mean(values.map((v) => v.metrics[key] ?? 0));
  return out;
}

function metricText(metrics: Record<string, number>): string {
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(', ');
}

async function loadProvenance(workers: PoolWorker[], tasks: string[], cells: PoolCell[]): Promise<Record<string, unknown>> {
  return {
    runId: RUN_ID,
    createdAt: new Date().toISOString(),
    outDir: OUT_BASE,
    config: {
      model: MODEL,
      arms: ARM_IDS,
      seeds: SEEDS,
      configVersion: CONFIG_VERSION,
      maxCellAttempts: MAX_CELL_ATTEMPTS,
      workerEnvErrorThreshold: WORKER_ENV_ERROR_THRESHOLD,
      budgets: {
        cellTimeoutMs: CELL_TIMEOUT_MS,
        cellMaxTokens: CELL_MAX_TOKENS,
        cellLiveTokenKill: CELL_LIVE_TOKEN_KILL,
        cellMaxOutputBytes: CELL_MAX_OUTPUT_BYTES,
        runMaxFinishedCells: RUN_MAX_FINISHED_CELLS,
        runMaxTotalTokens: RUN_MAX_TOTAL_TOKENS,
        runMaxEnvErrors: RUN_MAX_ENV_ERRORS,
      },
      selector: tacSelectorFromEnv(),
    },
    git: {
      opentasks: await gitInfo(process.cwd()),
      tac: await gitInfo(TAC_ROOT),
      swarmkitEval: await gitInfo(path.resolve(process.cwd(), '../swarmkit/src/eval')),
    },
    env: {
      evalBackend: 'ec2',
      tacRoot: TAC_ROOT,
      tacVersion: process.env.TAC_VERSION ?? '1.0.0',
      tacDockerNetwork: process.env.TAC_DOCKER_NETWORK ?? 'host',
      tacServerHostname: process.env.TAC_SERVER_HOSTNAME ?? '127.0.0.1',
      resultsS3Uri: process.env.TAC_POOL_RESULTS_S3_URI,
    },
    workers,
    tasks,
    cells,
  };
}

async function gitInfo(dir: string): Promise<{ sha: string | null; dirty: boolean | null }> {
  try {
    const [{ stdout: sha }, dirty] = await Promise.all([
      execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', dir, 'status', '--porcelain']),
    ]);
    return { sha: sha.trim(), dirty: dirty.stdout.trim().length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

async function syncResultsFromS3(): Promise<void> {
  if (process.env.TAC_POOL_RESUME_FROM_S3 !== '1') return;
  const destination = s3Destination();
  if (!destination) return;
  console.log(`syncing previous results from ${destination}`);
  await runCommand('aws', ['s3', 'sync', destination, OUT_BASE], { required: process.env.TAC_POOL_S3_REQUIRED === '1' });
}

async function syncResultsToS3(force: boolean): Promise<void> {
  const destination = s3Destination();
  if (!destination) return;
  if (!force && completedSinceLastS3Sync < S3_SYNC_EVERY) return;
  completedSinceLastS3Sync = 0;
  console.log(`syncing results to ${destination}`);
  await runCommand('aws', ['s3', 'sync', OUT_BASE, destination], { required: process.env.TAC_POOL_S3_REQUIRED === '1' });
}

function s3Destination(): string | null {
  const uri = process.env.TAC_POOL_RESULTS_S3_URI;
  if (!uri) return null;
  const base = uri.replace(/\/+$/, '');
  if (process.env.TAC_POOL_RESULTS_S3_INCLUDE_RUN_ID === '0') return base;
  return `${base}/${RUN_ID}`;
}

async function runCommand(command: string, args: string[], opts: { required: boolean }): Promise<void> {
  const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  if (code !== 0) {
    const message = `${command} ${args.join(' ')} exited ${code}`;
    if (opts.required) throw new Error(message);
    console.warn(`WARNING: ${message}`);
  }
}

function defaultAgentSetupCommand(): string {
  const harness = process.env.TAC_AGENT_HARNESS ?? process.env.TAC_AGENT_RUNTIME;
  return [
    'set -e',
    'apt-get update',
    'apt-get install -y curl ca-certificates gnupg git',
    'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
    'apt-get install -y nodejs',
    tacAgentHarnessInstallCommand(harness),
    'id -u agent >/dev/null 2>&1 || useradd -m -s /bin/sh agent',
    'chown -R agent:agent /workspace /eval',
  ].join('; ');
}

function plannedShards(cells: PoolCell[], workers: PoolWorker[]): string[][] {
  return workers.map((_, i) => cells.filter((_, idx) => idx % workers.length === i).map((cell) => cell.id));
}

function prefixWithBudget(
  stream: NodeJS.ReadableStream | null,
  label: string,
  file: fsSync.WriteStream,
  onBytes: (totalBytes: number, chunk: string) => void,
): void {
  if (!stream) return;
  let pending = '';
  let totalBytes = 0;
  stream.on('data', (chunk: Buffer | string) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    totalBytes += Buffer.byteLength(text);
    onBytes(totalBytes, text);
    file.write(text);

    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) console.log(`${label} ${line}`);
    if (pending.length > 16384) pending = pending.slice(-16384);
  });
  stream.on('end', () => {
    if (pending) console.log(`${label} ${pending}`);
  });
}

function createClaudeUsageMonitor(onUsage: (totalTokens: number) => void): (chunk: string) => void {
  let pending = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  return (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const usage = usageFromClaudeStreamLine(line);
      if (!usage) continue;
      if (usage.kind === 'final') {
        onUsage(usage.totalTokens);
        continue;
      }
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cacheReadTokens += usage.cacheReadTokens;
      cacheCreationTokens += usage.cacheCreationTokens;
      onUsage(inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens);
    }
    if (pending.length > 1_000_000) pending = pending.slice(-1_000_000);
  };
}

function usageFromClaudeStreamLine(line: string):
  | { kind: 'delta'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  | { kind: 'final'; totalTokens: number }
  | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type === 'assistant') {
    const message = obj.message as { usage?: Record<string, unknown> } | undefined;
    const usage = message?.usage;
    if (!usage) return null;
    return {
      kind: 'delta',
      inputTokens: numericUsage(usage.input_tokens),
      outputTokens: numericUsage(usage.output_tokens),
      cacheReadTokens: numericUsage(usage.cache_read_input_tokens),
      cacheCreationTokens: numericUsage(usage.cache_creation_input_tokens),
    };
  }
  if (obj.type !== 'result') return null;
  const modelUsage = obj.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (modelUsage && Object.keys(modelUsage).length) {
    let total = 0;
    for (const usage of Object.values(modelUsage)) {
      total +=
        numericUsage(usage.inputTokens ?? usage.input_tokens) +
        numericUsage(usage.outputTokens ?? usage.output_tokens) +
        numericUsage(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens) +
        numericUsage(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens);
    }
    return { kind: 'final', totalTokens: total };
  }
  const usage = (obj.usage ?? {}) as Record<string, unknown>;
  return {
    kind: 'final',
    totalTokens:
      numericUsage(usage.input_tokens) +
      numericUsage(usage.output_tokens) +
      numericUsage(usage.cache_read_input_tokens) +
      numericUsage(usage.cache_creation_input_tokens),
  };
}

function numericUsage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function terminateChild(child: ChildProcess): void {
  if (child.killed) return;
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    const pid = child.pid;
    setTimeout(() => {
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, 5000).unref();
    return;
  }
  child.kill('SIGTERM');
}

function recordRunResult(record: CellRecord): void {
  runCounters.finishedCells += 1;
  runCounters.totalTokens += record.result.tokens;
  if (record.result.envError) runCounters.envErrors += 1;
}

function schedulingStopReason(): string | null {
  if (MAX_RUNTIME_MS > 0 && Date.now() - STARTED_AT_MS > MAX_RUNTIME_MS) return 'TAC_POOL_MAX_RUNTIME_SEC was reached';
  if (RUN_MAX_FINISHED_CELLS > 0 && runCounters.finishedCells >= RUN_MAX_FINISHED_CELLS) {
    return `TAC_POOL_MAX_FINISHED_CELLS=${RUN_MAX_FINISHED_CELLS} was reached`;
  }
  if (RUN_MAX_TOTAL_TOKENS > 0 && runCounters.totalTokens >= RUN_MAX_TOTAL_TOKENS) {
    return `TAC_POOL_MAX_TOTAL_TOKENS=${RUN_MAX_TOTAL_TOKENS} was reached`;
  }
  if (RUN_MAX_ENV_ERRORS > 0 && runCounters.envErrors >= RUN_MAX_ENV_ERRORS) {
    return `TAC_POOL_MAX_ENV_ERRORS=${RUN_MAX_ENV_ERRORS} was reached`;
  }
  return null;
}

function workerLabel(worker: PoolWorker, index: number): string {
  return worker.name ?? worker.id ?? `worker-${index}`;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSeeds(value: string | undefined, repeats: number): number[] {
  if (!value) return Array.from({ length: repeats }, (_, i) => i + 1);
  const seeds = parseList(value).map((s) => Number(s));
  if (!seeds.length || seeds.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(`Invalid EVAL_SEEDS=${value}; expected comma-separated positive integers`);
  }
  return seeds;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric env value, got ${value}`);
  return n;
}

function cellId(taskId: string, arm: string, model: string, seed: number): string {
  return slug(`${taskId}__${arm}__${model}__seed${seed}`);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
