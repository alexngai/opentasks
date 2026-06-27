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

const OPENTASKS_TOOLS = [
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
];

const OPENTASKS_MCP = { name: 'opentasks', command: 'node', args: [OPENTASKS_CLI, 'mcp', '--scope', 'all'] };

const OPENTASKS: EvalArm = {
  id: 'opentasks',
  label: 'OpenTasks MCP',
  systemPromptAppendix:
    'You have an OpenTasks MCP server (native tools prefixed mcp__opentasks__) and a project skill named opentasks. ' +
    'Use the opentasks skill for the minimal TAC graph protocol. If a seeded TAC task id is given, call native ' +
    'mcp__opentasks__get_task on that id before task-specific Bash/curl/git/service API work. Use native MCP tools ' +
    'only; do not invoke mcp__opentasks__ tool names as shell commands, Python subprocesses, or curl requests. If tools ' +
    'are hidden or pending, use ToolSearch with exactly one query, select:mcp__opentasks__get_task, then call the returned native tool. ' +
    'Do not combine multiple select queries with commas or search for update/record tools before the initial get_task call. ' +
    'Do not insert Bash status commands such as echo, printf, or logging between ToolSearch and the native OpenTasks call. ' +
    'Use Bash/curl/git/service APIs for the TAC work itself, and record one final ' +
    'outcome/evidence update after verification. Create no duplicate top-level task when a seeded TAC task already exists.',
  extraTools: OPENTASKS_TOOLS,
  mcp: OPENTASKS_MCP,
};

const OPENTASKS_TEAM_CONTRACT: EvalArm = {
  id: 'opentasks-team-contract',
  label: 'OpenTasks Team Contract',
  systemPromptAppendix:
    'You are running the OpenTasks team-contract TAC arm. Treat the task graph as the durable evidence, decision, and verification record. ' +
    'In swarm-harness team mode, use native swarm task tools: task_list/task_get to inspect task state and task_update(id:"tac-root", output:"...") to record evidence; these updates are mirrored into OpenTasks. ' +
    'Do not search for mcp__opentasks__ tools in swarm-harness. If direct mcp__opentasks__ tools are visible in another harness, use them instead of the swarm task aliases. ' +
    'Use the team contract packet if provided: spawn or delegate to a service_inspector when useful, require structured evidence before mutation, and record final verification evidence in the task graph. ' +
    'When spawning a service inspector that needs shell/API reads, pass permissionMode:"danger-full-access" and instruct it not to mutate service state; do not use read-only permission mode for API inspection.',
  extraTools: OPENTASKS_TOOLS,
  mcp: OPENTASKS_MCP,
};

export const ARMS: Record<ArmId, EvalArm> = {
  stock: STOCK,
  notes: NOTES,
  opentasks: OPENTASKS,
  'opentasks-team-contract': OPENTASKS_TEAM_CONTRACT,
};
