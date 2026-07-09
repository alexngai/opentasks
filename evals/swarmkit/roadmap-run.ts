/**
 * RoadmapBench eval for OpenTasks — run through the shared `swarmkit-eval` package.
 *
 * RoadmapBench (arXiv:2605.15846, UniPat AI) is a long-horizon benchmark: start on a
 * source-version snapshot of a real repo and implement the functionality of a LATER
 * target version from a multi-target "roadmap", ordering 3–12 sub-goals yourself
 * (median 3,700 LoC across 51 files, 2h wall-clock cap). Grading is Harbor-owned and
 * test-based (`test.sh` → reward: Resolved Rate + weighted Completion Score) — ground
 * truth, never graph state. This is the long-horizon regime the P6 headline (E2′) wants.
 *
 * Substrate = Harbor (`execution: "harbor"`), so ALL agents run on one comparable path:
 *   - `claude-code`   — Harbor built-in agent.
 *   - `openswarm`     — via openswarm's OWN Harbor agent (a `BaseInstalledAgent` loaded by
 *                       import path: `openswarm_harbor_agent:OpenswarmAgent`), which captures
 *                       token usage + routes the model explicitly (chosen over ACP for exactly
 *                       that). Multi-agent coordinator team via `--ak swarm=true`.
 * The model per arm (Bedrock Anthropic / Bedrock-via-gateway / Azure-via-gateway) is pinned
 * per arm, and each arm is run in its own `runEval` so we get exactly the (agent,model) pairs
 * we asked for — not the arm×model cross-product. Results merge into one report.
 *
 * Env (all optional; a bare run is a zero-token `nop` plumbing smoke):
 *   ROADMAP_DATA_DIR     dir of `<task>/task.toml` (default evals/.roadmap-data)
 *   ROADMAP_ARMS         comma list from the registry below (default `nop`)
 *   ROADMAP_TASK_IDS     comma list of task ids (default: all in the data dir)
 *   ROADMAP_TASK_LIMIT   cap number of tasks (default 1)
 *   ROADMAP_ENVIRONMENT  harbor env: `docker` (proven, local image) | `e2b` (default `docker`)
 *   ROADMAP_SEEDS        seeds per cell (default 1)
 *   ROADMAP_TIMEOUT_MS   per-trial ms (default 90min — under the 2h cap)
 *   ROADMAP_OPENSWARM_HARBOR_DIR   PYTHONPATH for openswarm's Harbor agent
 *                                  (default ~/GitHub/openswarm/integrations/harbor)
 *   ROADMAP_OPENSWARM_INSTALL_SPEC npm spec the openswarm agent installs in-sandbox (default openswarm@latest)
 *   ROADMAP_OPENSWARM_BINARY_DIR   host dir of a prebuilt openswarm build (packages/cli-linux-<arch>/, must
 *                                  match the container arch) uploaded instead of npm-installing. Use it when
 *                                  the image lacks node (avoids the 360s agent-setup timeout).
 *   ROADMAP_OPENSWARM_MAX_TURNS    openswarm --max-turns (model round-trips; default 600). The engine
 *                                  default is 100 — too low for a long-horizon run (exits error_max_turns
 *                                  mid-task). Set 0 to omit the flag and use openswarm's default.
 *   ROADMAP_AGENT_TIMEOUT_MULT / ROADMAP_VERIFIER_TIMEOUT_MULT / ROADMAP_BUILD_TIMEOUT_MULT /
 *   ROADMAP_AGENT_SETUP_TIMEOUT_MULT  per-phase harbor timeout multipliers (default 1.0). NOTE: an agent
 *                                  that hits its (multiplied) timeout is scored as an ENV crash, not a
 *                                  partial reward — the agent must FINISH within budget to be graded.
 *   HARBOR_E2B_SANDBOX_TIMEOUT     e2b sandbox lifetime cap in seconds (default 3600). harbor hardcodes 24h,
 *                                  which lower e2b tiers reject; fed to swarmkit-eval's built-in
 *                                  cloudHardening.e2b timeout shim (SwarmKitE2BEnvironment) — no fork/patch.
 *   ROADMAP_HARBOR_CMD_JSON        JSON array override for the harbor command prefix (e.g. ["uv","tool","run","harbor"]).
 *
 *   Model ids (per arm; only read by the arms that use them):
 *     ROADMAP_CLAUDE_BEDROCK_MODEL     default `us.anthropic.claude-sonnet-4-6-20260514-v1:0`
 *     ROADMAP_OPENSWARM_BEDROCK_MODEL  default `bedrock/us.anthropic.claude-sonnet-4-6-20260514-v1:0`
 *     ROADMAP_OPENSWARM_AZURE_MODEL    default `azure/gpt-5.5`
 *
 *   Creds are read from the ambient environment and forwarded into the Harbor process/sandbox
 *   (never baked into arm content hashes): AWS_* / CLAUDE_CODE_USE_BEDROCK for Bedrock claude-code;
 *   ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY (LiteLLM gateway) for openswarm;
 *   E2B_API_KEY for the e2b environment.
 *
 * Run:
 *   npx tsx evals/swarmkit/roadmap-run.ts                                  # zero-token nop smoke (docker)
 *   ROADMAP_ARMS=claude-code-bedrock npx tsx evals/swarmkit/roadmap-run.ts # single real arm
 *   ROADMAP_ARMS=claude-code-bedrock,openswarm-bedrock,openswarm-azure \
 *     ROADMAP_ENVIRONMENT=e2b npx tsx evals/swarmkit/roadmap-run.ts        # the full comparison
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  runEval,
  roadmapBench,
  roadmapBenchArms,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  writeReport,
  type CellResult,
  type EvalConfig,
} from 'swarmkit-eval';

type HarborArgValue = string | number | boolean;

/** A fully-specified (agent, model) comparison arm on the Harbor substrate. */
interface RoadmapArm {
  id: string;
  /** Harbor `-a` value: a built-in agent id, or `module:Class` import path. */
  agent: string;
  /** Harbor `-m` model id (per arm). Empty for the nop smoke. */
  model: string;
  /** Harbor `--ak key=value` agent kwargs. */
  agentKwargs?: Record<string, HarborArgValue>;
  /** Extra Harbor args appended verbatim (e.g. `--mcp-config`). */
  extraArgs?: string[];
  /** Human-readable note surfaced in the log. */
  note?: string;
}

const HOME = os.homedir();
const env = (n: string, f: string): string => {
  const v = process.env[n];
  return v == null || v === '' ? f : v;
};
const intEnv = (n: string, f: number): number => {
  const v = process.env[n];
  if (v == null || v === '') return f;
  const parsed = Number(v);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${n} must be a non-negative integer`);
  return parsed;
};
const listEnv = (n: string): string[] =>
  (process.env[n] ?? '').split(',').map((v) => v.trim()).filter(Boolean);

const DATA_DIR = path.resolve(env('ROADMAP_DATA_DIR', 'evals/.roadmap-data'));
const ARM_IDS = listEnv('ROADMAP_ARMS').length ? listEnv('ROADMAP_ARMS') : ['nop'];
const TASK_IDS = listEnv('ROADMAP_TASK_IDS');
const TASK_LIMIT = intEnv('ROADMAP_TASK_LIMIT', 1);
const ENVIRONMENT = env('ROADMAP_ENVIRONMENT', 'docker');
const SEEDS = intEnv('ROADMAP_SEEDS', 1);
const TIMEOUT_MS = intEnv('ROADMAP_TIMEOUT_MS', 90 * 60_000);
const OPENSWARM_HARBOR_DIR = path.resolve(
  env('ROADMAP_OPENSWARM_HARBOR_DIR', path.join(HOME, 'GitHub/openswarm/integrations/harbor')),
);
const OPENSWARM_INSTALL_SPEC = env('ROADMAP_OPENSWARM_INSTALL_SPEC', 'openswarm@latest');
// Optional: upload a prebuilt openswarm build (arch must match the container) instead of npm-installing
// in-sandbox. Skips node/npm entirely — the only fast setup on images without node (or under emulation).
const OPENSWARM_BINARY_DIR = process.env.ROADMAP_OPENSWARM_BINARY_DIR;
// openswarm's engine default is maxTurns=100 (model round-trips), which a long-horizon
// RoadmapBench run exhausts mid-task (exits error_max_turns). Give it plenty of headroom.
const OPENSWARM_MAX_TURNS = intEnv('ROADMAP_OPENSWARM_MAX_TURNS', 600);
function openswarmKwargs(extra: Record<string, HarborArgValue> = {}): Record<string, HarborArgValue> {
  return {
    install_spec: OPENSWARM_INSTALL_SPEC,
    ...(OPENSWARM_BINARY_DIR ? { binary_dir: OPENSWARM_BINARY_DIR } : {}),
    ...(OPENSWARM_MAX_TURNS > 0 ? { max_turns: OPENSWARM_MAX_TURNS } : {}),
    ...extra,
  };
}
const HARBOR_CMD: string[] = JSON.parse(env('ROADMAP_HARBOR_CMD_JSON', '["harbor"]'));
// E2B sandbox lifetime cap (seconds). Harbor hardcodes 24h, which lower e2b tiers reject
// (SandboxException "> 1 hour"). swarmkit-eval's cloudHardening.e2b.timeoutShim generates a
// SwarmKitE2BEnvironment subclass that overrides the timeout to this value — see runArm's cloudHardening.
const E2B_SANDBOX_TIMEOUT_SEC = intEnv('HARBOR_E2B_SANDBOX_TIMEOUT', 3600);
const OUT_DIR = path.resolve('evals/.roadmap-runs');

// Per-phase Harbor timeout multipliers (task.toml defaults: agent 7200s, verifier 1800s, build 600s,
// agent-setup 360s). Tune to (a) absorb a slow in-sandbox openswarm/node install (raise setup), and
// (b) fit e2b's 1h sandbox cap (shrink agent+verifier). Empty = Harbor default (1.0).
const TIMEOUT_MULT_FLAGS: Array<[string, string]> = [
  ['ROADMAP_AGENT_SETUP_TIMEOUT_MULT', '--agent-setup-timeout-multiplier'],
  ['ROADMAP_AGENT_TIMEOUT_MULT', '--agent-timeout-multiplier'],
  ['ROADMAP_VERIFIER_TIMEOUT_MULT', '--verifier-timeout-multiplier'],
  ['ROADMAP_BUILD_TIMEOUT_MULT', '--environment-build-timeout-multiplier'],
];
const TIMEOUT_ARGS: string[] = TIMEOUT_MULT_FLAGS.flatMap(([envVar, flag]) =>
  process.env[envVar] ? [flag, process.env[envVar]!] : [],
);

const OPENSWARM_AGENT = 'openswarm_harbor_agent:OpenswarmAgent';

/** The comparison arms. Model ids are env-overridable; creds ride in the ambient env (below). */
const ARMS: Record<string, RoadmapArm> = {
  // Zero-token plumbing smoke: Harbor runs the env + verifier; a nop agent → reward 0.
  nop: { id: 'nop', agent: 'nop', model: 'nop/mock', note: 'zero-token substrate smoke' },

  // claude-code (Harbor built-in) on Bedrock Anthropic. Needs AWS creds + CLAUDE_CODE_USE_BEDROCK=1.
  'claude-code-bedrock': {
    id: 'claude-code-bedrock',
    agent: 'claude-code',
    model: env('ROADMAP_CLAUDE_BEDROCK_MODEL', 'us.anthropic.claude-sonnet-4-6-20260514-v1:0'),
    note: 'claude-code + Bedrock Anthropic',
  },

  // openswarm (own Harbor agent) routed to Bedrock via its LiteLLM-gateway transport.
  'openswarm-bedrock': {
    id: 'openswarm-bedrock',
    agent: OPENSWARM_AGENT,
    model: env('ROADMAP_OPENSWARM_BEDROCK_MODEL', 'bedrock/us.anthropic.claude-sonnet-4-6-20260514-v1:0'),
    agentKwargs: openswarmKwargs(),
    note: 'openswarm + Bedrock (gateway)',
  },

  // openswarm (own Harbor agent) → Azure OpenAI DIRECT (azureoai/<deployment>, no gateway).
  // openswarm's AzureTransportProvider calls the deployment endpoint straight from the sandbox
  // (built for exactly the "sandbox can't reach a local gateway" case). `gpt-5.5` = the deployment name.
  'openswarm-azure': {
    id: 'openswarm-azure',
    agent: OPENSWARM_AGENT,
    model: env('ROADMAP_OPENSWARM_AZURE_MODEL', 'azureoai/gpt-5.5'),
    agentKwargs: openswarmKwargs(),
    note: 'openswarm + Azure OpenAI (direct, no gateway)',
  },

  // Multi-agent variant: openswarm's coordinator team (drops --single). This is where a shared
  // task substrate is load-bearing — the E1 coordination angle.
  'openswarm-bedrock-swarm': {
    id: 'openswarm-bedrock-swarm',
    agent: OPENSWARM_AGENT,
    model: env('ROADMAP_OPENSWARM_BEDROCK_MODEL', 'bedrock/us.anthropic.claude-sonnet-4-6-20260514-v1:0'),
    agentKwargs: openswarmKwargs({ swarm: true }),
    note: 'openswarm coordinator team + Bedrock (multi-agent)',
  },
};

/** Creds/config forwarded from the ambient env into the Harbor process (and thus the sandbox). */
const FORWARDED_ENV = [
  // Bedrock direct (claude-code / openswarm Claude Agent SDK).
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  // Anthropic direct / gateway.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // LiteLLM gateway (litellm/|gateway/|bedrock/|azure/ prefixes).
  'LITELLM_API_KEY',
  'LITELLM_BASE_URL',
  // Azure OpenAI direct (azureoai/<deployment>). We normalize the AZURE_OPENAI_* names the
  // openswarm transport reads from the AZURE_* (LiteLLM-style) names in harborEnv() below.
  'AZURE_API_BASE',
  'AZURE_API_KEY',
  'AZURE_API_VERSION',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  // E2B sandbox provisioning.
  'E2B_API_KEY',
  // Harbor's OpenAI-compat guard.
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

function harborEnv(anyOpenswarm: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FORWARDED_ENV) if (process.env[k]) out[k] = process.env[k]!;
  // openswarm's AzureTransportProvider reads AZURE_OPENAI_API_KEY / AZURE_OPENAI_API_VERSION
  // (and AZURE_API_BASE|AZURE_OPENAI_ENDPOINT). Bridge the common AZURE_* (LiteLLM-style) names.
  if (!out.AZURE_OPENAI_API_KEY && out.AZURE_API_KEY) out.AZURE_OPENAI_API_KEY = out.AZURE_API_KEY;
  if (!out.AZURE_OPENAI_API_VERSION && out.AZURE_API_VERSION) out.AZURE_OPENAI_API_VERSION = out.AZURE_API_VERSION;
  // openswarm's Harbor agent + parser must be importable by the host-side Harbor process.
  if (anyOpenswarm) {
    out.PYTHONPATH = [OPENSWARM_HARBOR_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  // The nop smoke needs no creds; give Harbor a placeholder so its OpenAI-compatible guard passes.
  if (!out.OPENAI_API_KEY) out.OPENAI_API_KEY = 'roadmap-smoke';
  if (!out.OPENAI_BASE_URL) out.OPENAI_BASE_URL = 'https://example.invalid/v1';
  return out;
}

async function runArm(arm: RoadmapArm): Promise<CellResult[]> {
  const benchmark = roadmapBench({ dataDir: DATA_DIR });
  const runId = `roadmap-${arm.id}-${ENVIRONMENT}`;
  const outDir = path.join(OUT_DIR, runId);

  const config: EvalConfig = {
    runId,
    configVersion: 'v0',
    benchmark: benchmark.id,
    ...(TASK_IDS.length ? { taskIds: TASK_IDS } : { taskLimit: TASK_LIMIT }),
    arms: roadmapBenchArms([
      {
        id: arm.id,
        agent: arm.agent,
        environment: ENVIRONMENT,
        ...(arm.agentKwargs ? { agentKwargs: arm.agentKwargs } : {}),
        ...(() => {
          const extra = [...(arm.extraArgs ?? []), ...TIMEOUT_ARGS];
          return extra.length ? { extraArgs: extra } : {};
        })(),
      },
    ]),
    models: [{ name: arm.model }],
    seeds: Array.from({ length: SEEDS }, (_, i) => i + 1),
    backend: 'in-process',
    concurrency: { cells: 1, modelConnections: 1 },
    store: { backend: 'local', dir: outDir },
    output: { dir: outDir, trace: false },
  };

  console.log(`▶ arm=${arm.id} agent=${arm.agent} model=${arm.model} env=${ENVIRONMENT}  (${arm.note ?? ''})`);

  return runEval(config, {
    benchmark,
    store: new LocalResultStore(outDir),
    sweAtlas: {
      repoDir: DATA_DIR,
      command: HARBOR_CMD,
      environment: ENVIRONMENT,
      nConcurrent: 1,
      maxParallelJobs: 1,
      outDir,
      quiet: true,
      yes: true,
      timeoutMs: TIMEOUT_MS,
      env: harborEnv(arm.agent === OPENSWARM_AGENT),
      // Use swarmkit-eval's built-in e2b timeout injection (generates SwarmKitE2BEnvironment, a
      // Harbor env subclass that overrides Harbor's hardcoded 24h sandbox timeout) instead of a
      // bespoke fork/shim. No-op for docker (applyCloudHardening only touches e2b/modal).
      cloudHardening: { e2b: { sandboxTimeoutSec: E2B_SANDBOX_TIMEOUT_SEC, timeoutShim: true } },
    },
  });
}

async function main(): Promise<void> {
  const arms = ARM_IDS.map((id) => {
    const a = ARMS[id];
    if (!a) throw new Error(`Unknown arm: ${id} (have: ${Object.keys(ARMS).join(', ')})`);
    return a;
  });

  console.log(
    `RoadmapBench · arms=[${ARM_IDS.join(', ')}] tasks=${TASK_IDS.length ? TASK_IDS.join(',') : `first ${TASK_LIMIT}`} ` +
      `env=${ENVIRONMENT} seeds=${SEEDS} data=${path.relative(process.cwd(), DATA_DIR)}`,
  );

  const all: CellResult[] = [];
  for (const arm of arms) {
    try {
      all.push(...(await runArm(arm)));
    } catch (e) {
      console.error(`  ✗ arm ${arm.id} failed:`, e instanceof Error ? e.message : e);
    }
  }

  for (const r of all) {
    console.log(
      `  ${r.taskId} | ${r.armId.padEnd(24)} seed${r.seed}: status=${r.status} ` +
        `reward=${(r.score?.metrics?.reward ?? r.score?.partial ?? 0).toFixed(3)} ` +
        `tokens=${r.usage.totalTokens} ${Math.round(r.durationMs / 1000)}s` +
        `${r.status === 'env_error' ? ` ENV:${r.envError?.kind} ${r.envError?.message ?? ''}` : ''}`,
    );
  }

  if (all.length > 1) {
    const report = buildReport(all, { runId: 'roadmap-bench', benchmark: 'roadmap-bench' } as EvalConfig, {
      baselineArmId: all[0]!.armId,
      accuracyMetric: 'sPartial',
    });
    console.log('\n' + renderMarkdownReport(report));
    const paths = await writeReport(OUT_DIR, report);
    console.log(`\nreport → ${path.relative(process.cwd(), paths.md)} (+ .html, .json)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
