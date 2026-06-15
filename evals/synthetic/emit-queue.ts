/**
 * The synthetic emit-queue task + its three coordination arms.
 *
 * A queue of M items; processing one means running `./emit <id>` (a
 * non-idempotent side-effect recorded out-of-band by the collector — NOT visible
 * on disk). N agents share the queue. Ground truth = each id emitted EXACTLY
 * once. This single property makes both hazards scoreable with one check:
 *   - concurrency: two agents claim the same item → emitted twice (race)
 *   - continuity:  a reset agent can't see what's done → re-emits (re-do)
 *
 * Arms differ ONLY in how they avoid double-processing:
 *   - stock   : nothing (collision baseline)
 *   - notes   : claim-by-convention in a shared file (racy TOCTOU — the honest
 *               naive baseline that kills the "rigged baseline" critique)
 *   - opentasks: atomic claim_next + persistent complete (the P0 primitive)
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type { ArmId, McpConfig } from '../types.js';

const OPENTASKS_CLI = path.resolve(process.cwd(), 'dist/cli.js');

export interface SynthArm {
  id: ArmId;
  label: string;
  extraTools: string[];
  mcp?: McpConfig;
  /** Work items are delivered via the graph (claim_next), not queue.txt. */
  itemsViaGraph: boolean;
}

export function makeItems(m: number): string[] {
  return Array.from({ length: m }, (_, i) => `item-${String(i + 1).padStart(3, '0')}`);
}

const STOCK: SynthArm = {
  id: 'stock',
  label: 'Stock (no coordination)',
  extraTools: [],
  itemsViaGraph: false,
};

const NOTES: SynthArm = {
  id: 'notes',
  label: 'Notes claim-by-convention (racy)',
  extraTools: [],
  itemsViaGraph: false,
};

const OPENTASKS: SynthArm = {
  id: 'opentasks',
  label: 'OpenTasks atomic claim_next',
  extraTools: [
    'mcp__opentasks__claim_next',
    'mcp__opentasks__update_task',
    'mcp__opentasks__get_task',
    'mcp__opentasks__list_tasks',
    'mcp__opentasks__release_task',
  ],
  mcp: { name: 'opentasks', command: 'node', args: [OPENTASKS_CLI, 'mcp', '--scope', 'all'] },
  itemsViaGraph: true,
};

export const SYNTH_ARMS: Record<ArmId, SynthArm> = {
  stock: STOCK,
  notes: NOTES,
  opentasks: OPENTASKS,
};

/**
 * Seed M task nodes into the work-dir daemon so the opentasks arm can claim_next.
 * Idempotent-ish: run once per work dir before spawning agents. Uses the CLI
 * (auto-starts the daemon); env carries any auth/proxy vars (irrelevant to the
 * daemon, harmless).
 */
export function seedOpentasksGraph(workDir: string, items: string[], env: NodeJS.ProcessEnv): void {
  for (const item of items) {
    execFileSync(
      process.execPath,
      [OPENTASKS_CLI, 'create', '--type', 'task', '--title', item, '--status', 'open'],
      { cwd: workDir, env, stdio: 'ignore', timeout: 20_000 },
    );
  }
}

/** The instruction handed to each concurrent agent (model-facing). */
export function buildPrompt(arm: SynthArm, opts: { items: string[]; agentId: string; m: number }): string {
  const common = [
    `You are one of several agents ("${opts.agentId}") working the SAME queue of ${opts.m} work items CONCURRENTLY.`,
    'Processing an item means running `./emit <item-id>` in this directory.',
    'Emitting is an IRREVERSIBLE EXTERNAL action (like sending a message): you CANNOT query or list',
    'what has already been emitted — there is no way to check after the fact. So you must avoid',
    'emitting any item that another agent has already taken.',
    '',
    'The goal across all agents: every item is emitted EXACTLY ONCE — no item emitted twice, none skipped.',
    '',
  ];

  if (arm.id === 'stock') {
    return [
      ...common,
      `The ${opts.m} items are listed in queue.txt. Process every item by running \`./emit <item-id>\`.`,
      'Work efficiently and stop once the queue is done.',
    ].join('\n');
  }

  if (arm.id === 'notes') {
    return [
      ...common,
      `The ${opts.m} items are listed in queue.txt.`,
      'Coordinate with the other agents through the shared file claims.txt:',
      `  1. Before emitting an item, append a line "${opts.agentId}: <item-id>" to claims.txt.`,
      '  2. Re-read claims.txt; if another agent already has that item, skip it and pick another.',
      '  3. Only then run `./emit <item-id>`.',
      'Process the whole queue this way, then stop.',
    ].join('\n');
  }

  // opentasks — items delivered via the graph; claim is atomic.
  return [
    ...common,
    'Do NOT use any queue.txt. Get work ONLY from the OpenTasks graph via the MCP:',
    `  1. Call claim_next with agentId "${opts.agentId}" to ATOMICALLY claim the next available item.`,
    '     It returns {claimed, nodeId, fence} — or claimed:false when nothing is left.',
    '     The claim is race-free: if claimed:true, no other agent has that nodeId — safe to process.',
    '  2. Call get_task with that nodeId to read its title — the title IS the item-id to emit.',
    '  3. Run `./emit <item-id>` using that title.',
    '  4. Call update_task on that nodeId with status "closed" to mark it done.',
    '  5. Repeat from step 1 until claim_next returns claimed:false, then stop.',
    'Only emit items you successfully claimed.',
  ].join('\n');
}
