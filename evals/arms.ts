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
    'You have an OpenTasks MCP server (native tools prefixed mcp__opentasks__) and a project skill named opentasks. ' +
    'Use the opentasks skill for the minimal TAC graph protocol. Use native MCP tools only; do not invoke ' +
    'mcp__opentasks__ tool names as shell commands. If tools are hidden or pending, use ToolSearch with ' +
    'select:mcp__opentasks__list_tasks or select:mcp__opentasks__record_attempt, then call the returned native tool. ' +
    'Inspect the seeded task once near the start, use Bash/curl/git/service APIs for the TAC work, and record one final ' +
    'outcome/evidence update after verification. Create no duplicate top-level task when a seeded TAC task already exists.',
  extraTools: [
    'Skill',
    'ToolSearch',
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
