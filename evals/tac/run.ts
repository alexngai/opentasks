import * as path from 'node:path';
import {
  E2BBackend,
  Ec2Backend,
  buildReport,
  type BackendId,
  type ExecutionBackend,
  InProcessBackend,
  LocalResultStore,
  renderMarkdownReport,
  runEval,
  writeReport,
  type EvalConfig,
  type RunDeps,
} from 'swarmkit-eval';
import type { ArmId } from '../types.js';
import { tacArms, tacBenchmark, tacSelectorFromEnv } from './bench.js';
import { tacDockerAdapterFromEnv } from './docker-adapter.js';
import { TacFakeAdapter } from './fake-adapter.js';
import { defaultTacRoot } from './tasks.js';

const MODEL = process.env.EVAL_MODEL ?? 'haiku';
const ARM_IDS = (process.env.EVAL_ARMS ?? 'stock,notes,opentasks').split(',').map((s) => s.trim()) as ArmId[];
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const SEEDS = parseSeeds(process.env.EVAL_SEEDS, REPEATS);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 1);
const LIMIT = process.env.EVAL_TASK_LIMIT ? Number(process.env.EVAL_TASK_LIMIT) : undefined;
const FAKE = process.env.EVAL_FAKE === '1';
const TAC_ROOT = process.env.TAC_ROOT ?? defaultTacRoot();
const BACKEND = backendFromEnv();
const OUT_DIR = path.resolve(process.cwd(), process.env.EVAL_OUT_DIR ?? 'evals/.tac-runs');
const STORE_DIR = path.resolve(process.cwd(), process.env.EVAL_STORE_DIR ?? OUT_DIR);

async function main(): Promise<void> {
  if (FAKE && BACKEND !== 'in-process') throw new Error('EVAL_FAKE=1 only supports EVAL_BACKEND=in-process');

  const selector = tacSelectorFromEnv();
  const benchmark = tacBenchmark({ root: TAC_ROOT, selector });
  const arms = tacArms(ARM_IDS);
  const backend = buildBackend(BACKEND);
  const config: EvalConfig = {
    runId: `tac-${MODEL}-${FAKE ? 'fake' : BACKEND}`,
    configVersion: process.env.EVAL_CONFIG_VERSION ?? 'tac-v2',
    benchmark: 'theagentcompany',
    arms,
    models: [{ name: MODEL }],
    seeds: SEEDS,
    backend: BACKEND,
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    output: { dir: OUT_DIR, trace: true },
    ...(LIMIT !== undefined ? { taskLimit: LIMIT } : {}),
  };

  const deps: RunDeps = {
    benchmark,
    adapter: FAKE ? new TacFakeAdapter() : tacDockerAdapterFromEnv(),
    backend,
    store: new LocalResultStore(STORE_DIR),
  };

  console.log(
    `tac swarmkit-eval · model=${MODEL} arms=${ARM_IDS.join(',')} seeds=${SEEDS.join(',')} ` +
      `limit=${LIMIT ?? 'all'} root=${TAC_ROOT} store=${STORE_DIR} [${FAKE ? 'FAKE' : `DOCKER:${BACKEND}`}]`,
  );
  if (selector.role || selector.dependencies?.length || selector.ids?.length) {
    console.log(
      `selector · role=${selector.role ?? '*'} deps=${selector.dependencies?.join('+') ?? '*'} ` +
        `mode=${selector.dependencyMode ?? 'exact'} ids=${selector.ids?.join(',') ?? '*'}`,
    );
  }

  const results = await runEval(config, deps);
  for (const r of results) {
    console.log(
      `  ${r.taskId} | ${r.armId.padEnd(9)} seed${r.seed}: status=${r.status} ` +
        `S_partial=${(r.score?.partial ?? 0).toFixed(2)} full=${r.score?.full ?? false} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s` +
        `${r.status === 'env_error' ? ` ENV:${r.envError?.kind}` : ''}`,
    );
  }

  const baseline = ARM_IDS.includes('stock' as ArmId) ? 'stock' : ARM_IDS[0];
  const report = buildReport(results, config, { baselineArmId: baseline, accuracyMetric: 'sPartial' });
  console.log('\n' + renderMarkdownReport(report));
  const paths = await writeReport(OUT_DIR, report);
  console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function backendFromEnv(): BackendId {
  const backend = (process.env.EVAL_BACKEND ?? 'in-process') as BackendId;
  if (backend === 'in-process' || backend === 'e2b' || backend === 'ec2') return backend;
  throw new Error(
    `Unsupported TAC EVAL_BACKEND=${backend}. Use "in-process", "e2b", or "ec2" for a Docker-capable backend.`,
  );
}

function buildBackend(backend: BackendId): ExecutionBackend {
  if (backend === 'in-process') return new InProcessBackend();
  if (backend === 'e2b') {
    return new E2BBackend({
      template: process.env.E2B_TEMPLATE ?? '',
      timeoutMs: Number(process.env.E2B_TIMEOUT ?? 1_800_000),
      root: process.env.E2B_ROOT,
      setupCommands: splitCommands(process.env.E2B_SETUP_COMMANDS),
      setupTimeoutMs: Number(process.env.E2B_SETUP_TIMEOUT ?? 420_000),
    });
  }
  return new Ec2Backend({
    region: process.env.EC2_REGION ?? process.env.AWS_REGION,
    profile: process.env.EC2_PROFILE ?? process.env.AWS_PROFILE,
    host: process.env.EC2_HOST,
    instanceId: process.env.EC2_INSTANCE_ID,
    usePrivateIp: boolEnv(process.env.EC2_USE_PRIVATE_IP),
    amiId: process.env.EC2_AMI_ID,
    instanceType: process.env.EC2_INSTANCE_TYPE,
    keyName: process.env.EC2_KEY_NAME,
    subnetId: process.env.EC2_SUBNET_ID,
    securityGroupIds: splitList(process.env.EC2_SECURITY_GROUP_IDS),
    iamInstanceProfileName: process.env.EC2_IAM_INSTANCE_PROFILE,
    userData: process.env.EC2_USER_DATA,
    userDataFile: process.env.EC2_USER_DATA_FILE,
    rootVolumeGb: numberEnv(process.env.EC2_ROOT_VOLUME_GB),
    rootVolumeDeviceName: process.env.EC2_ROOT_VOLUME_DEVICE_NAME,
    tags: jsonEnv<Record<string, string>>(process.env.EC2_TAGS_JSON),
    terminateOnDispose: boolEnv(process.env.EC2_TERMINATE_ON_DISPOSE, true),
    sshUser: process.env.EC2_SSH_USER,
    sshKeyPath: process.env.EC2_SSH_KEY_PATH,
    sshOptions: splitList(process.env.EC2_SSH_OPTIONS),
    sshConnectTimeoutSec: numberEnv(process.env.EC2_SSH_CONNECT_TIMEOUT_SEC),
    readyTimeoutMs: numberEnv(process.env.EC2_READY_TIMEOUT),
    root: process.env.EC2_ROOT,
    cleanupRootOnDispose: boolEnv(process.env.EC2_CLEANUP_ROOT_ON_DISPOSE, true),
    setupCommands: splitCommands(process.env.EC2_SETUP_COMMANDS),
    setupTimeoutMs: numberEnv(process.env.EC2_SETUP_TIMEOUT),
    commandTimeoutMs: numberEnv(process.env.EC2_COMMAND_TIMEOUT),
    env: passEc2Env(),
  });
}

function splitCommands(value: string | undefined): string[] | undefined {
  const commands = value
    ?.split(';;')
    .map((s) => s.trim())
    .filter(Boolean);
  return commands?.length ? commands : undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function boolEnv(value: string | undefined, fallback?: boolean): boolean | undefined {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected numeric env value, got ${value}`);
  return n;
}

function parseSeeds(value: string | undefined, repeats: number): number[] {
  if (!value) return Array.from({ length: repeats }, (_, i) => i + 1);
  const seeds = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (!seeds.length || seeds.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new Error(`Invalid EVAL_SEEDS=${value}; expected comma-separated positive integers`);
  }
  return seeds;
}

function jsonEnv<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}

function passEc2Env(): Record<string, string> {
  const keys = [
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_REGION',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'TAC_GRADER_PROXY',
    'TAC_GRADER_PROXY_HOST',
    'TAC_GRADER_PROXY_PORT',
    'TAC_GRADER_PROXY_MODEL',
    'TAC_GRADER_PROXY_KEY',
    'TAC_GRADER_BEDROCK_MODEL',
    'TAC_GRADER_BEDROCK_REGION',
    'TAC_GRADER_PROXY_STATE_DIR',
    'TAC_GRADER_PROXY_START_TIMEOUT_SEC',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'LITELLM_API_KEY',
    'LITELLM_BASE_URL',
    'LITELLM_MODEL',
  ];
  const out: Record<string, string> = {};
  for (const key of keys) if (process.env[key]) out[key] = process.env[key]!;
  return out;
}
