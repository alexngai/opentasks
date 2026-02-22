/**
 * Claude Task State Reconstructor
 *
 * Replays TaskCreate/TaskUpdate sequences from extracted tool calls
 * to reconstruct the ephemeral task list state from a session.
 */

import type { ExtractedToolCall } from './claude-tool-categorizer.js';

// ============================================================================
// Types
// ============================================================================

export interface ReconstructedTask {
  /** Task ID (from TaskCreate response or TaskUpdate params) */
  taskId: string;

  /** Subject (from TaskCreate input) */
  subject: string;

  /** Description (from TaskCreate input) */
  description?: string;

  /** Status transitions in order */
  statusHistory: Array<{ status: string; lineIndex: number }>;

  /** Final status */
  finalStatus: 'pending' | 'in_progress' | 'completed';

  /** Owner if assigned via TaskUpdate */
  owner?: string;

  /** Dependencies from TaskUpdate addBlocks */
  blocks?: string[];

  /** Dependencies from TaskUpdate addBlockedBy */
  blockedBy?: string[];
}

export interface ReconstructedClaudeTaskState {
  /** Tasks that existed during the session */
  tasks: ReconstructedTask[];

  /** Final task list snapshot at session end */
  finalSnapshot: ReconstructedTask[];
}

// ============================================================================
// Implementation
// ============================================================================

const TASK_CREATED_REGEX = /Task #(\d+)/;

function parseTaskIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = output.match(TASK_CREATED_REGEX);
  return match?.[1];
}

/**
 * Reconstruct Claude's ephemeral task state from a list of extracted tool calls.
 * Only processes calls with `category === 'claude-native'` and
 * `toolName` of `TaskCreate` or `TaskUpdate`.
 */
export function reconstructClaudeTaskState(
  toolCalls: ExtractedToolCall[],
): ReconstructedClaudeTaskState {
  const tasksById = new Map<string, ReconstructedTask>();
  const taskOrder: string[] = [];

  for (const call of toolCalls) {
    if (call.category !== 'claude-native') continue;

    if (call.toolName === 'TaskCreate') {
      const taskId = parseTaskIdFromOutput(call.output);
      if (!taskId) continue;

      const task: ReconstructedTask = {
        taskId,
        subject: (call.input.subject as string) ?? '',
        description: call.input.description as string | undefined,
        statusHistory: [{ status: 'pending', lineIndex: call.lineIndex }],
        finalStatus: 'pending',
        owner: undefined,
        blocks: undefined,
        blockedBy: undefined,
      };

      tasksById.set(taskId, task);
      taskOrder.push(taskId);
    }

    if (call.toolName === 'TaskUpdate') {
      const taskId = call.input.taskId as string | undefined;
      if (!taskId) continue;

      let task = tasksById.get(taskId);
      if (!task) {
        // Task was created before this transcript scope
        task = {
          taskId,
          subject: `(unknown task #${taskId})`,
          statusHistory: [],
          finalStatus: 'pending',
        };
        tasksById.set(taskId, task);
        taskOrder.push(taskId);
      }

      if (call.input.status) {
        const status = call.input.status as string;
        task.statusHistory.push({ status, lineIndex: call.lineIndex });
        task.finalStatus = status as ReconstructedTask['finalStatus'];
      }

      if (call.input.owner !== undefined) {
        task.owner = call.input.owner as string;
      }

      if (call.input.subject !== undefined) {
        task.subject = call.input.subject as string;
      }

      if (call.input.description !== undefined) {
        task.description = call.input.description as string;
      }

      if (call.input.addBlocks) {
        const newBlocks = call.input.addBlocks as string[];
        task.blocks = [...(task.blocks ?? []), ...newBlocks];
      }

      if (call.input.addBlockedBy) {
        const newBlockedBy = call.input.addBlockedBy as string[];
        task.blockedBy = [...(task.blockedBy ?? []), ...newBlockedBy];
      }
    }
  }

  const tasks = taskOrder.map((id) => tasksById.get(id)!);

  return {
    tasks,
    finalSnapshot: tasks.map((t) => ({ ...t })),
  };
}
