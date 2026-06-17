/**
 * The three E2′ arms — same runner, same model, same tasks; only the
 * state-management mechanism varies. This is the "typed graph vs notes vs
 * stock long-context" RCT the field is missing.
 */

import * as path from 'node:path';
import type { EvalArm, ArmId } from './types.js';

// The OpenTasks CLI (its own MCP server lives behind `opentasks mcp`).
const OPENTASKS_CLI = path.resolve(process.cwd(), 'dist/cli.js');

const STOCK: EvalArm = {
  id: 'stock',
  label: 'Stock (native context only)',
  systemPromptAppendix: '',
  extraTools: [],
};

const NOTES: EvalArm = {
  id: 'notes',
  label: 'NOTES.md scaffold',
  systemPromptAppendix:
    'Maintain a NOTES.md file in the working directory as your durable task/progress log. ' +
    'Record the plan, what you have completed, what remains, and key findings. Re-read NOTES.md ' +
    'before continuing so you do not re-derive or re-explore what is already recorded.',
  extraTools: [],
};

const OPENTASKS: EvalArm = {
  id: 'opentasks',
  label: 'OpenTasks MCP',
  systemPromptAppendix:
    'You have an OpenTasks MCP server (tools prefixed mcp__opentasks__). Use it as your durable ' +
    'task graph: create_task for each subtask, link dependencies, update_task as you progress, and ' +
    'query / get_context / context_summary to recover what is already known BEFORE doing new work. ' +
    'Consult the graph before re-exploring files you have already analyzed. ' +
    'When working alongside other agents: call list_attempts({inProgress:true}) before you start, to ' +
    'see what others are doing and avoid duplicating their work; record_attempt to log your effort ' +
    '(name the files/areas you touch); and when finished, record_attempt with the outcome ' +
    '(success/failure) and attach evidence (e.g. the test result) so your completion is checkable.',
  extraTools: [
    'mcp__opentasks__create_task',
    'mcp__opentasks__get_task',
    'mcp__opentasks__update_task',
    'mcp__opentasks__list_tasks',
    'mcp__opentasks__query',
    'mcp__opentasks__link',
    'mcp__opentasks__create_context',
    'mcp__opentasks__get_context',
    'mcp__opentasks__list_contexts',
    'mcp__opentasks__context_summary',
    'mcp__opentasks__record_attempt',
    'mcp__opentasks__list_attempts',
  ],
  mcp: { name: 'opentasks', command: 'node', args: [OPENTASKS_CLI, 'mcp', '--scope', 'all'] },
};

export const ARMS: Record<ArmId, EvalArm> = {
  stock: STOCK,
  notes: NOTES,
  opentasks: OPENTASKS,
};
