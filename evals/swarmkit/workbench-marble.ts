/**
 * Tier 2 — multi-agent WorkBench through swarmkit-eval's native `marble` engine.
 *
 * N agents share ONE WorkBench sandbox + ONE workspace (so their per-agent WorkBench MCP servers all
 * append to ONE union action log, `ws.root/.wb_actions.jsonl`), coordinating through OpenTasks. The task
 * is a real WorkBench multi_domain instruction; grading replays the UNION of all agents' side-effecting
 * tool calls against a fresh sandbox — so a *duplicate* side effect from two uncoordinated agents (both
 * send the email) becomes a WorkBench **harmful action**. That is exactly what OpenTasks' `claim_next`
 * coordination is meant to prevent → the coordination payoff, measured on realistic, outcome-graded work.
 *
 * Structural port of `synth-marble.ts` (the emit-queue) to WorkBench: the "items" are the task's PUBLIC
 * `domains` (a fair, non-leaking work split — the sealed ground-truth actions are never seeded), the
 * "emit" is doing that domain's workplace actions via `mcp__workbench__*`, and the grader is WorkBench's
 * own `is_correct`/`has_side_effects` (reused via the exported `WorkbenchGrader`). All WorkBench-specific
 * machinery lives in swarmkit-eval; this file only composes. No change to OpenTasks core.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  workbenchNativeBenchmark,
  WorkbenchGrader,
  type MarbleBenchmarkAdapter,
  type MultiAgentRawRun,
  type Score,
  type EvalTask,
  type ServiceSpec,
  type ServiceHandle,
  type ServiceContext,
  type PhaseSpec,
  type CoordinationAction,
  type Workspace,
  type RawRun,
  type LoadOpts,
} from 'swarmkit-eval';
import { ARMS } from '../arms.js';

const OPENTASKS_CLI = ARMS.opentasks.mcp?.args?.[0];

/**
 * Resolve a node binary whose ABI matches opentasks' native `better-sqlite3`. The eval runs under
 * `npx tsx`, whose `process.execPath` can be a DIFFERENT node than the one that `npm install`'d opentasks
 * (e.g. homebrew node 23 / MODULE_VERSION 131 vs the nvm node 22 / 127 the module was built against). A
 * mismatched node makes the spawned daemon crash on `require('better-sqlite3')` (ERR_DLOPEN_FAILED) before
 * it ever binds its socket — silently disabling ALL coordination. So probe candidates and pick the first
 * that can actually load the module; every opentasks subprocess (daemon/seed/list AND the agents' MCP)
 * must use it, not `process.execPath`. Memoized. Throws with a clear message if none work.
 */
let _otNode: string | undefined;

/** Candidate node binaries, most-likely-correct first. Under `npx tsx`, process.execPath AND PATH `node`
 *  can BOTH be the wrong (homebrew) node, while the module was built by a versioned nvm/fnm node — so we
 *  also sweep those install roots (newest first) as fallbacks. */
function nodeCandidates(): string[] {
  const out: string[] = [];
  const add = (p?: string): void => { if (p && !out.includes(p)) out.push(p); };
  add(process.env.npm_node_execpath); // the node `npm run` used to launch us
  add(process.execPath); // the tsx host node
  add('node'); // PATH
  if (process.env.NVM_BIN) add(path.join(process.env.NVM_BIN, 'node'));
  for (const root of [path.join(os.homedir(), '.nvm', 'versions', 'node'), path.join(os.homedir(), '.fnm', 'node-versions')]) {
    try { for (const v of fs.readdirSync(root).sort().reverse()) { add(path.join(root, v, 'bin', 'node')); add(path.join(root, v, 'installation', 'bin', 'node')); } } catch { /* no such manager */ }
  }
  return out;
}

export function resolveOpentasksNode(): string {
  if (_otNode) return _otNode;
  // Must INSTANTIATE a Database — `require` only loads the JS wrapper; the native .node is dlopen'd lazily
  // on `new Database()`, which is where the ABI (NODE_MODULE_VERSION) mismatch actually throws.
  const probe = "new (require('better-sqlite3'))(':memory:').close()";
  // Resolve better-sqlite3 from the opentasks repo's node_modules (OPENTASKS_CLI = <root>/dist/cli.js).
  const repoRoot = OPENTASKS_CLI ? path.dirname(path.dirname(OPENTASKS_CLI)) : process.cwd();
  for (const cand of nodeCandidates()) {
    try {
      execFileSync(cand, ['-e', probe], { cwd: repoRoot, stdio: 'ignore', timeout: 15_000 });
      _otNode = cand;
      return cand;
    } catch { /* ABI mismatch or not found → try next */ }
  }
  throw new Error(
    'No node binary can load opentasks\' better-sqlite3 (ABI/NODE_MODULE_VERSION mismatch on every candidate). ' +
      'Run the eval under the node that built opentasks, or `npm rebuild better-sqlite3`.',
  );
}

/** The 14 side-effecting WorkBench tools (sanitized MCP names) — the graded, redundancy-tracked actions. */
const WB_SIDE_EFFECT = new Set([
  'email_send_email', 'email_delete_email', 'email_forward_email', 'email_reply_email',
  'calendar_create_event', 'calendar_delete_event', 'calendar_update_event',
  'analytics_create_plot',
  'project_management_create_task', 'project_management_delete_task', 'project_management_update_task',
  'customer_relationship_manager_add_customer', 'customer_relationship_manager_update_customer',
  'customer_relationship_manager_delete_customer',
]);

/**
 * Seeding mode for the opentasks arm (Option 1a — capability-independent coordination).
 *
 * - `per-domain` (default): seed one claimable subtask per public domain; each agent claims a domain and
 *   does that domain's actions. This is CAPABILITY-GATED — a weak model that claims a read-only domain
 *   (e.g. `analytics`) can still fire a side effect anyway, so the duplication guarantee leans on agent
 *   self-restraint. Reproduces the documented Tier-2 sonnet/haiku findings.
 * - `single` (`WB_SEED_MODE=single`): seed exactly ONE claimable "do the whole task" unit. Atomic
 *   `claim_next` hands it to exactly one agent; every other agent gets `claimed:false` and STOPS. A
 *   duplicate side effect becomes impossible regardless of model capability — no reliance on self-restraint,
 *   and it fixes the domain-split≠action-split miss. Trade-off: 1 effective worker per task (fine for
 *   single-action tasks, and multi_domain tasks are mostly one unit of dependent work anyway).
 */
const SEED_MODE: 'single' | 'per-domain' = process.env.WB_SEED_MODE === 'single' ? 'single' : 'per-domain';

/** The file the `manager` arm's orchestrator writes and its workers read. Plain workspace file — the
 *  manager baseline deliberately gets NO atomic substrate; a delegation channel is all it needs. */
const ASSIGNMENTS_FILE = 'assignments.md';

/**
 * Tier-3 (throughput) diagnostics, derived from the per-agent trajectories. Tier 2 measured whether
 * coordination prevents duplicate side effects; these measure whether it buys any PARALLELISM — the open
 * question single-writer seeding cannot answer by construction. See `../TIER3-THROUGHPUT.md`.
 *
 * Wall clock on a shared box behind a rate-limited gateway is too noisy to headline, so the primary
 * measure is `criticalPathCalls` (the longest per-agent tool-call chain) — hardware-independent, and the
 * denominator for speedup against an N=1 solo cell. The timing fields come from `TraceEvent.ts`, which
 * every event carries, and exist to CHECK the substrate rather than to score it: the marble engine runs a
 * phase's agents under `Promise.all`, but a `modelConnections` pool smaller than N silently serializes
 * them, which would turn a real throughput effect into a null. `agentOverlap` makes that visible.
 */
export function throughputMetrics(agents: MultiAgentRawRun['agents']): Record<string, number> {
  type ToolEvent = { type: 'tool'; ts: number; name: string; input?: unknown };
  const isTool = (e: { type: string }): e is ToolEvent => e.type === 'tool';

  let totalCalls = 0;
  let activeAgents = 0;
  let maxAgentActions = 0;
  let totalActions = 0;
  let plannerSideEffects = 0;
  let firstTs = Infinity;
  let lastTs = -Infinity;
  const distinct = new Set<string>();
  // PHASES ARE SEQUENTIAL (the engine awaits each phase before starting the next), agents WITHIN a phase
  // are concurrent. So the critical path is Σ over phases of that phase's longest chain — NOT the max over
  // all agents, which would credit the manager arm's planning stage as free. Same for overlap: comparing a
  // cell-wide makespan against a sum of spans that straddles a phase barrier understates serialization.
  const perPhase = new Map<string, { maxCalls: number; spanSumMs: number; first: number; last: number }>();

  for (const agent of agents ?? []) {
    const tools = (agent.trajectory ?? []).filter(isTool);
    totalCalls += tools.length;

    // Productive = a SIDE-EFFECTING workbench call. Reads (search/get) are not work; counting them would
    // let a swarm that only searches in parallel look like it split the work.
    const actions = tools.filter((t) => t.name.startsWith('mcp__workbench__') && WB_SIDE_EFFECT.has(t.name.slice('mcp__workbench__'.length)));
    for (const a of actions) distinct.add(`${a.name.slice('mcp__workbench__'.length)}:${JSON.stringify(a.input ?? {})}`);
    if (actions.length > 0) activeAgents++;
    maxAgentActions = Math.max(maxAgentActions, actions.length);
    totalActions += actions.length;
    // A planner instructed to delegate and NOT act, that acts anyway, is an instructed-mechanism failure —
    // the manager-arm analogue of a `claimed:false` agent firing the side effect. Worth its own counter.
    if (agent.role === 'orchestrator') plannerSideEffects += actions.length;

    const phaseId = agent.phase ?? 'work';
    if (!perPhase.has(phaseId)) perPhase.set(phaseId, { maxCalls: 0, spanSumMs: 0, first: Infinity, last: -Infinity });
    const p = perPhase.get(phaseId)!;
    p.maxCalls = Math.max(p.maxCalls, tools.length);

    // Per-agent span from the trajectory timestamps; agents with <2 events contribute no measurable span.
    if (tools.length > 0) {
      const ts = tools.map((t) => t.ts);
      const start = Math.min(...ts);
      const end = Math.max(...ts);
      p.spanSumMs += end - start;
      p.first = Math.min(p.first, start);
      p.last = Math.max(p.last, end);
      firstTs = Math.min(firstTs, start);
      lastTs = Math.max(lastTs, end);
    }
  }

  let criticalPathCalls = 0;
  let phaseMakespanSum = 0;
  let phaseSpanSum = 0;
  for (const p of perPhase.values()) {
    criticalPathCalls += p.maxCalls;
    if (Number.isFinite(p.first)) {
      phaseMakespanSum += p.last - p.first;
      phaseSpanSum += p.spanSumMs;
    }
  }

  const makespanMs = Number.isFinite(firstTs) ? lastTs - firstTs : 0;
  return {
    criticalPathCalls,
    totalCalls,
    activeAgents,
    plannerSideEffects,
    distinctSideEffects: distinct.size,
    // "One agent silently did everything" — a per-domain cell that degenerates into single-writer scores
    // the same completion as real coordination, and is only distinguishable here.
    maxAgentShare: totalActions > 0 ? maxAgentActions / totalActions : 0,
    makespanMs,
    // Realized concurrency: 0 = perfectly serialized (makespan == sum of spans), →1 = fully overlapped.
    // A per-domain cell reading ~0 means the agents (or the connection pool) serialized, NOT that
    // coordination failed — the two look identical in completion alone.
    agentOverlap: phaseMakespanSum > 0 ? Math.max(0, 1 - phaseMakespanSum / Math.max(phaseSpanSum, 1)) : 0,
  };
}

export interface WorkbenchMarbleOpts {
  n: number;
  repoDir: string;
  python: string;
  domain?: Parameters<typeof workbenchNativeBenchmark>[0]['domain'];
  taskLimit?: number;
  /** Restrict the run to these exact task ids (`wb-<domain>-<sha1(task)[:12]>`). Used to oversample a
   *  curated slice — e.g. single-action side-effect tasks where duplication is the binding constraint —
   *  instead of the first-N-in-file-order the plain limit gives. When set, the full CSV is loaded and
   *  filtered to these ids (taskLimit still caps the count after filtering). */
  taskIds?: string[];
  /** Add the width-1 `plan` phase before the work phase (the `manager` orchestrator-worker baseline).
   *  Changes the swarm shape for EVERY arm in the run, so the runner requires manager to run alone. */
  manager?: boolean;
}

/** Parse the public `domains` cell ("['email', 'calendar']") into a string[]. */
function parseDomains(s: unknown): string[] {
  try {
    const v = JSON.parse(String(s ?? '').replace(/'/g, '"'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The WorkBench substrate as a first-class service: for the opentasks arm it seeds one CLAIMABLE task per
 * public domain (a non-leaking partition; this also starts the shared per-cell daemon before the agents),
 * exposes the task instruction to the per-agent prompt via `env`, snapshots the UNION action log for the
 * grader in `readState()`, and reaps the daemon in `stop()` (base OpenTasks functionality).
 */
function workbenchService(): ServiceSpec {
  return {
    id: 'workbench',
    async start(ctx: ServiceContext): Promise<ServiceHandle> {
      const armId = ctx.armId;
      const instruction = String(ctx.publicMetadata?.instruction ?? '');
      const domains = parseDomains(ctx.publicMetadata?.domains);

      // opentasks arm: run ONE daemon on a SHORT socket path (under /tmp, NOT the deep in-process
      // workspace — a socket nested under ws.root exceeds macOS's 103-byte sun_path limit and silently
      // fails to bind, which was disabling coordination entirely). Publish the socket to ws.root/.ot_sock
      // so each agent's MCP wrapper connects via `--socket` (the CooperBench pattern) instead of a fragile
      // relative-path autostart. Seed the claimable work into that daemon per SEED_MODE (below).
      let otHome: string | undefined;
      const otEnvFor = (home: string): NodeJS.ProcessEnv => ({ ...process.env, OPENTASKS_PROJECT_DIR: home });
      if (armId === 'opentasks' && OPENTASKS_CLI) {
        otHome = fs.mkdtempSync('/tmp/ote-'); // short → socket ≈35 bytes, well under the 103-byte limit
        try {
          execFileSync(resolveOpentasksNode(), [OPENTASKS_CLI, 'daemon', 'start'], { env: otEnvFor(otHome), stdio: 'ignore', timeout: 20_000 });
        } catch { /* the seed below also auto-starts it */ }
        try { fs.writeFileSync(path.join(ctx.workspaceRoot, '.ot_sock'), path.join(otHome, 'daemon.sock')); } catch { /* agents can't find it → fall back */ }
        // Seed the claimable work. `single` (Option 1a) seeds ONE "do the whole task" unit so exactly one
        // agent works and the rest stand down; `per-domain` seeds one unit per public domain (the original
        // split). See SEED_MODE above; the opentasks prompt in buildMarblePrompt mirrors this choice.
        const seedTitles =
          SEED_MODE === 'single'
            ? ['execute the entire task (every domain) yourself']
            : domains.map((d) => `handle the "${d}" part of the task`);
        for (const title of seedTitles) {
          try {
            execFileSync(resolveOpentasksNode(), [OPENTASKS_CLI, 'create', '--type', 'task', '--title', title, '--status', 'open'],
              { env: otEnvFor(otHome), stdio: 'ignore', timeout: 20_000 });
          } catch { /* seed best-effort; a missing subtask just means less to claim */ }
        }
      }

      const actionLogPath = path.join(ctx.workspaceRoot, '.wb_actions.jsonl');
      const handle: ServiceHandle = {
        // Exposed to phase.prompt(args.services) so each agent gets the actual task text.
        env: { WB_INSTRUCTION: instruction, WB_DOMAINS: domains.join(', ') },
        async readState(): Promise<{ actions: string[]; graph: string[]; seededDomains: string[]; daemonList: string }> {
          let actions: string[] = [];
          try {
            actions = fs.readFileSync(actionLogPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
          } catch { /* no side effects taken → empty union */ }
          let graph: string[] = [];
          let daemonList = '';
          if (otHome) {
            try { graph = fs.readFileSync(path.join(otHome, 'graph.jsonl'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { /* unflushed */ }
            // Query the LIVE daemon (ground truth) — what tasks exist + who claimed them.
            try {
              daemonList = execFileSync(resolveOpentasksNode(), [OPENTASKS_CLI!, 'list', '--all', '--json'], { env: otEnvFor(otHome), timeout: 15_000 }).toString().slice(0, 4000);
            } catch (e) { daemonList = `list-error: ${(e as Error).message.slice(0, 150)}`; }
          }
          return { actions, graph, seededDomains: domains, daemonList };
        },
        async stop(): Promise<void> {
          if (otHome) {
            try { execFileSync(resolveOpentasksNode(), [OPENTASKS_CLI!, 'daemon', 'stop'], { env: otEnvFor(otHome), stdio: 'ignore', timeout: 10_000 }); } catch { /* already gone */ }
            try { fs.rmSync(otHome, { recursive: true, force: true }); } catch { /* leaves a tiny /tmp dir */ }
          }
        },
      };
      return handle;
    },
  };
}

/** Per-agent, per-arm coordination prompt. The task text arrives via `services.WB_INSTRUCTION`. */
function buildMarblePrompt(armId: string, agentId: string, width: number, instruction: string): string {
  const common = [
    `You are ${agentId}, one of ${width} agents working TOGETHER on ONE workplace task, at the SAME time.`,
    'Do the workplace actions with the WorkBench tools (native tools prefixed mcp__workbench__): search/read',
    'as needed to find ids and details, then perform the required create / update / delete / send actions.',
    '',
    'CRITICAL: coordinate so no action is performed twice. A DUPLICATE side effect — e.g. two agents both',
    'sending the same email, or both deleting the same event — is an irreversible, HARMFUL error. Divide the',
    "work so each part is done exactly once. Do not ask for confirmation; act. Stop when your part is done.",
    '',
  ];

  if (armId === 'opentasks') {
    if (SEED_MODE === 'single') {
      // Option 1a — single writer. Exactly ONE claimable unit exists; one agent wins it and does the whole
      // task, everyone else stands down. Duplication is impossible without relying on the agent to restrain
      // itself on a domain it "shouldn't" act on — the guarantee is structural.
      return [
        ...common,
        'There is exactly ONE claimable work unit for this task in the OpenTasks graph, and only one agent',
        'can win it. Get your assignment by claiming — do NOT touch any mcp__workbench__ tool before you do:',
        `  1. Call mcp__opentasks__claim_next with agentId "${agentId}" to ATOMICALLY try to claim the work.`,
        '     It returns {claimed, nodeId, ...}.',
        '  2. If claimed is FALSE: another agent already owns the work. Perform ZERO workplace actions — do',
        '     NOT call any mcp__workbench__ tool at all — and STOP immediately. You are done.',
        '  3. If claimed is TRUE: YOU are the single writer. Do the ENTIRE task yourself — every domain, every',
        '     required create / update / delete / send — via mcp__workbench__* tools. Ignore any instinct to',
        '     split by domain; the other agents are standing down, so nothing happens unless you do it.',
        '  4. When the whole task is complete, mark it done: mcp__opentasks__update_task(id: nodeId,',
        '     status: "closed").',
        'The claim is race-free: at most one agent ever sees claimed:true, so no side effect can be performed',
        'twice — no matter how the work splits across domains.',
        '',
        'The task:',
        instruction,
      ].join('\n');
    }
    return [
      ...common,
      'The task has been split into per-domain subtasks in the OpenTasks graph. Get your work ONLY by claiming:',
      `  1. Call mcp__opentasks__claim_next with agentId "${agentId}" to ATOMICALLY claim the next unclaimed`,
      '     domain subtask. It returns {claimed, nodeId, ...}, or claimed:false when nothing is left.',
      '  2. Call mcp__opentasks__get_task on that nodeId to read which domain you claimed (its title).',
      '  3. Do ALL of THAT domain\'s workplace actions for the task, via mcp__workbench__* tools.',
      '  4. Mark it done: mcp__opentasks__update_task(id: nodeId, status: "closed").',
      '  5. Repeat from step 1 until claim_next returns claimed:false, then stop.',
      'The claim is race-free: if claimed:true, no other agent has that domain — never work a domain you did',
      'not claim. This guarantees each domain (and its side effects) is handled exactly once.',
      '',
      'The task:',
      instruction,
    ].join('\n');
  }

  if (armId === 'manager') {
    // Phase 2 of the orchestrator-worker baseline. The worker's guarantee is entirely INSTRUCTED: it holds
    // only if the manager partitioned correctly AND this worker obeys its line. Two compliance points, vs
    // zero for an atomic claim — which is exactly the axis the paper tests, so the prompt is written to be
    // as strong as a prompt can be. Any residual duplication is then a property of the mechanism class,
    // not of a weak prompt.
    return [
      ...common,
      `A manager has already divided the work and written it to ${ASSIGNMENTS_FILE} in this directory.`,
      `  1. Read ${ASSIGNMENTS_FILE}.`,
      `  2. Find the line addressed to YOU (${agentId}). Do EXACTLY what it says — no more.`,
      '  3. If your line says to do nothing, or there is no line for you, perform ZERO workplace actions —',
      '     do NOT call any mcp__workbench__ tool at all — and STOP immediately. You are done.',
      '  4. Never perform an action assigned to a different agent, even if you believe it was missed or done',
      '     wrong. Another agent is handling it; doing it yourself creates a DUPLICATE, which is harmful.',
      '',
      'The task (for context — your assignment is authoritative):',
      instruction,
    ].join('\n');
  }

  if (armId === 'notes') {
    return [
      ...common,
      'Coordinate through the shared file claims.txt in this directory:',
      `  1. Before doing a domain's actions, append a line "${agentId}: <domain>" to claims.txt.`,
      '  2. Re-read claims.txt; if another agent already claimed that domain, skip it and pick another.',
      '  3. Only then perform that domain\'s mcp__workbench__* actions.',
      '',
      'The task:',
      instruction,
    ].join('\n');
  }

  // stock — no shared coordination channel; the agents must divide the work with no way to check.
  return [
    ...common,
    'You have no shared coordination channel with the other agents. Try to divide the task so nothing is',
    'done twice, but you cannot see what the others have done.',
    '',
    'The task:',
    instruction,
  ].join('\n');
}

/**
 * Phase 1 of the `manager` arm — the orchestrator-worker baseline the paper needs.
 *
 * WHY THIS BASELINE. `stock` (no channel) and `notes` (a racy shared file) are both strawmen: nobody
 * deploys uncoordinated agents. The realistic alternative to an atomic claim is a PLANNER that assigns
 * work — what AutoGen/CrewAI/LangGraph hierarchical modes actually do. If `claim_next` cannot beat this,
 * the coordination framing is wrong, and we want to know that before a reviewer says it.
 *
 * It is also a genuine test of the paper's axis rather than only a baseline: delegation is an INSTRUCTED
 * mechanism with TWO compliance points (the manager must partition correctly; each worker must obey its
 * line) plus a single point of failure. The structural/instructed hypothesis therefore predicts it
 * degrades with model capability and with N, exactly as per-domain claiming does — while single-writer
 * `claim_next`, which has zero compliance points, does not.
 *
 * The manager is told to delegate and NOT act. Whether it complies is itself measured
 * (`plannerSideEffects`): a planner that performs the action AND assigns it duplicates by itself.
 */
function buildManagerPlanPrompt(n: number, instruction: string): string {
  const workerIds = Array.from({ length: n }, (_, i) => `agent-${i + 1}`).join(', ');
  return [
    `You are the MANAGER of a team of ${n} worker agents (${workerIds}) who will work SIMULTANEOUSLY on ONE`,
    'workplace task. You do NOT do the task yourself. Your only job is to divide it and assign the parts.',
    '',
    'CRITICAL: the workers act at the same time and cannot see each other. If two of them perform the same',
    'action — both send the same email, both delete the same event — that DUPLICATE is an irreversible,',
    'HARMFUL error. Your assignment is the only thing preventing it.',
    '',
    'You may use the read-only mcp__workbench__ tools (search / get / list) to inspect the data and plan',
    'accurately. Do NOT perform any create, update, delete, or send action yourself — the workers do those.',
    '',
    `Write your plan to a file named ${ASSIGNMENTS_FILE} in the current directory, with EXACTLY one line per`,
    'worker, in this format:',
    '  agent-1: <the specific actions this worker should perform, or the word NOTHING>',
    `  agent-2: <…>   (one line for every worker up to agent-${n})`,
    '',
    'Rules for the plan:',
    '  - Every action the task requires must be assigned to EXACTLY ONE worker. Never to two.',
    `  - If the task needs fewer actions than you have workers, assign the work to as few as needed and give`,
    '    every remaining worker the line "NOTHING". A worker with nothing to do is correct and safe; a',
    '    second worker doing the same action is a harmful duplicate.',
    '  - Be specific: name the recipient, event, record, or task id so the worker does not have to guess.',
    '',
    'The task:',
    instruction,
  ].join('\n');
}

/**
 * Phases. The default is a single `work` phase (concurrency only). The `manager` arm needs an
 * orchestrator-worker topology, which the engine expresses as a width-1 `plan` phase sequenced before the
 * width-N `work` phase — phases run in order, agents within a phase run concurrently.
 *
 * The plan phase is added ONLY for a manager run. Adding it unconditionally would spend a wasted planning
 * agent in every stock/notes/opentasks cell and invalidate the cached Tier-2 results, so the runner keeps
 * `manager` as its own experiment (own runId + store dir), exactly as `WB_SEED_MODE=single` is.
 *
 * `reset` defaults to true for phase index > 0, so the workers carry NO context from the planning phase:
 * they must recover the assignment from the durable file. That is the honest version of the baseline —
 * a real orchestrator-worker system passes the assignment through the substrate, not a shared context.
 */
function phasesFor(n: number, manager: boolean): PhaseSpec[] {
  const work: PhaseSpec = {
    id: 'work',
    role: manager ? 'worker' : undefined,
    prompt: ({ arm, agentId, width, services }) =>
      buildMarblePrompt(arm.id, agentId, width, services.WB_INSTRUCTION ?? ''),
  };
  if (!manager) return [work];
  return [
    {
      id: 'plan',
      width: 1,
      role: 'orchestrator',
      prompt: ({ services }) => buildManagerPlanPrompt(n, services.WB_INSTRUCTION ?? ''),
    },
    work,
  ];
}

/**
 * A swarmkit-eval `marble` benchmark: WorkBench multi_domain tasks run by N coordinating agents, graded by
 * WorkBench's own outcome+harmful grader on the UNION of their side-effecting actions.
 */
export function workbenchMarbleBenchmark(opts: WorkbenchMarbleOpts): MarbleBenchmarkAdapter {
  const domain = opts.domain ?? 'multi_domain';
  const id = `workbench-marble-${domain}`;
  const native = workbenchNativeBenchmark({ repoDir: opts.repoDir, python: opts.python, domain });
  const grader = new WorkbenchGrader({ python: opts.python, repoDir: opts.repoDir });

  return {
    id,
    execution: 'marble',
    grader: { kind: 'self' },
    swarm: {
      width: opts.n,
      phases: phasesFor(opts.n, opts.manager === true),
      services: [workbenchService()],
      ...(opts.manager ? { topology: 'orchestrator-worker' as const } : {}),
    },

    async load(o: LoadOpts): Promise<EvalTask[]> {
      // Reuse the Tier-1 loader (sealed outcome + public domain), then surface the raw instruction to the
      // per-agent prompt via publicMetadata (the agent sees the task anyway; the OUTCOME stays sealed).
      const wantIds = opts.taskIds?.length ? new Set(opts.taskIds) : null;
      // When oversampling specific ids, load the FULL CSV (no limit) then filter; otherwise honor limit
      // (o.limit from config.taskLimit wins if set, else opts.taskLimit — spread o first so an unset
      // config.taskLimit can't clobber opts.taskLimit).
      const tasks = await native.load({ ...o, limit: wantIds ? undefined : (o.limit ?? opts.taskLimit) });
      const mapped = tasks
        .filter((t) => !wantIds || wantIds.has(t.id))
        .map((t) => ({ ...t, publicMetadata: { ...t.publicMetadata, instruction: t.prompt } }));
      // With an id filter, the plain limit didn't slice — cap the filtered set by taskLimit here.
      return wantIds && opts.taskLimit != null ? mapped.slice(0, opts.taskLimit) : mapped;
    },

    async score(raw: MultiAgentRawRun, task: EvalTask): Promise<Score> {
      const st = (raw.services.workbench ?? { actions: [], graph: [], seededDomains: [], daemonList: '' }) as {
        actions: string[]; graph: string[]; seededDomains: string[]; daemonList: string;
      };
      const unionText = st.actions.join('\n') + (st.actions.length ? '\n' : '');
      // Reuse WorkbenchGrader by feeding the UNION log through a minimal Workspace.
      const ws = {
        readFile: async (p: string) => (p.includes('.wb_actions.jsonl') ? unionText : null),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        writeFiles: async () => {},
        dispose: async () => {},
        root: raw.workdir,
      } as unknown as Workspace;
      const syntheticRaw = { output: '', workdir: raw.workdir, usage: raw.usage, trajectory: raw.trajectory, durationMs: raw.durationMs } as RawRun;
      const score = await grader.grade(task, syntheticRaw, ws);
      // Multi-agent diagnostics on top of completion/harmful (coordination KPIs R/O/c/E_c are folded in by
      // the engine from the coordination classifier below).
      const workActions = st.actions.length;
      score.metrics = {
        ...score.metrics,
        numAgents: opts.n,
        unionSideEffects: workActions,
        ...throughputMetrics(raw.agents),
      };

      // EVAL_DEBUG_DIR: dump per-agent tool sequences + the opentasks graph (who claimed what) + union
      // actions, so the coordination surface can be inspected. Off unless the env is set.
      if (process.env.EVAL_DEBUG_DIR) {
        try {
          const agents = (raw.agents ?? []).map((a) => ({
            agentId: a.agentId,
            role: a.role,
            tools: (a.trajectory ?? [])
              .filter((e): e is Extract<typeof e, { type: 'tool' }> => e.type === 'tool')
              .map((e) => ({ name: e.name, input: e.input })),
          }));
          const dbg = {
            taskId: task.id, seedMode: SEED_MODE, seededDomains: st.seededDomains, completion: score.metrics?.completion,
            harmful: score.metrics?.harmful, metrics: score.metrics, daemonList: st.daemonList, unionActions: st.actions, graph: st.graph,
            agents, messages: raw.messages,
          };
          fs.mkdirSync(process.env.EVAL_DEBUG_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.EVAL_DEBUG_DIR, `${task.id}.json`), JSON.stringify(dbg, null, 2));
        } catch { /* debug best-effort */ }
      }
      return score;
    },

    coordination(call): CoordinationAction | null {
      const name = call.name ?? '';
      if (name.startsWith('mcp__workbench__')) {
        const bare = name.slice('mcp__workbench__'.length);
        // A side-effecting workbench call = productive work; the redundancy key is the action itself, so two
        // agents doing the SAME action register as redundant (R>0). Reads (search/get) are ignored.
        if (WB_SIDE_EFFECT.has(bare)) return { kind: 'work', ref: `${bare}:${JSON.stringify(call.input ?? {})}` };
        return null;
      }
      if (name.startsWith('mcp__opentasks__')) return { kind: 'coordination' };
      const fp = String((call.input as { file_path?: string } | undefined)?.file_path ?? '');
      if ((name === 'Write' || name === 'Edit') && /claims\.txt/.test(fp)) return { kind: 'coordination' };
      return null;
    },
  };
}
