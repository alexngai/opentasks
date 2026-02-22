/**
 * Tests for Claude Task State Reconstructor
 */

import { describe, it, expect } from 'vitest';
import { reconstructClaudeTaskState } from '../claude-task-reconstructor.js';
import type { ExtractedToolCall } from '../claude-tool-categorizer.js';

// ============================================================================
// Helpers
// ============================================================================

function makeToolCall(
  overrides: Partial<ExtractedToolCall> & { toolName: string },
): ExtractedToolCall {
  return {
    toolUseId: `toolu_${Math.random().toString(36).slice(2, 6)}`,
    category: 'claude-native',
    input: {},
    success: true,
    lineIndex: 0,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('reconstructClaudeTaskState', () => {
  it('reconstructs a single task lifecycle: create → in_progress → completed', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Fix auth bug', description: 'Fix the login flow' },
        output: 'Task #1 created successfully: Fix auth bug',
        lineIndex: 0,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '1', status: 'in_progress' },
        output: 'Updated task #1 status',
        lineIndex: 2,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '1', status: 'completed' },
        output: 'Updated task #1 status',
        lineIndex: 10,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks).toHaveLength(1);

    const task = result.tasks[0];
    expect(task.taskId).toBe('1');
    expect(task.subject).toBe('Fix auth bug');
    expect(task.description).toBe('Fix the login flow');
    expect(task.finalStatus).toBe('completed');
    expect(task.statusHistory).toEqual([
      { status: 'pending', lineIndex: 0 },
      { status: 'in_progress', lineIndex: 2 },
      { status: 'completed', lineIndex: 10 },
    ]);
  });

  it('handles multiple tasks with dependencies', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Research' },
        output: 'Task #1 created successfully: Research',
        lineIndex: 0,
      }),
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Implement' },
        output: 'Task #2 created successfully: Implement',
        lineIndex: 1,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '2', addBlockedBy: ['1'] },
        lineIndex: 2,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '1', status: 'in_progress', owner: 'researcher' },
        lineIndex: 3,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks).toHaveLength(2);

    expect(result.tasks[0].taskId).toBe('1');
    expect(result.tasks[0].finalStatus).toBe('in_progress');
    expect(result.tasks[0].owner).toBe('researcher');

    expect(result.tasks[1].taskId).toBe('2');
    expect(result.tasks[1].blockedBy).toEqual(['1']);
    expect(result.tasks[1].finalStatus).toBe('pending');
  });

  it('handles TaskUpdate for unknown task ID (task created before transcript scope)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '5', status: 'completed' },
        lineIndex: 0,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('5');
    expect(result.tasks[0].subject).toContain('unknown');
    expect(result.tasks[0].finalStatus).toBe('completed');
  });

  it('handles empty input (no TaskCreate/TaskUpdate calls)', () => {
    const result = reconstructClaudeTaskState([]);
    expect(result.tasks).toEqual([]);
    expect(result.finalSnapshot).toEqual([]);
  });

  it('handles empty input with non-task tool calls', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'EnterPlanMode',
        input: {},
        lineIndex: 0,
      }),
      makeToolCall({
        toolName: 'Bash',
        category: 'unknown',
        input: { command: 'ls' },
        lineIndex: 1,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks).toEqual([]);
  });

  it('handles TaskUpdate with only owner change (no status)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Task A' },
        output: 'Task #1 created successfully',
        lineIndex: 0,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '1', owner: 'agent-1' },
        lineIndex: 1,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks[0].finalStatus).toBe('pending');
    expect(result.tasks[0].owner).toBe('agent-1');
    // No status change recorded beyond the initial pending
    expect(result.tasks[0].statusHistory).toEqual([{ status: 'pending', lineIndex: 0 }]);
  });

  it('handles TaskCreate with no output (failed creation)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Will fail' },
        output: undefined,
        lineIndex: 0,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks).toEqual([]); // No task ID could be parsed
  });

  it('produces independent finalSnapshot copies', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Test' },
        output: 'Task #1 created successfully',
        lineIndex: 0,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    result.tasks[0].subject = 'Modified';
    expect(result.finalSnapshot[0].subject).toBe('Test');
  });

  it('handles addBlocks dependency', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'TaskCreate',
        input: { subject: 'Task A' },
        output: 'Task #1 created',
        lineIndex: 0,
      }),
      makeToolCall({
        toolName: 'TaskUpdate',
        input: { taskId: '1', addBlocks: ['2', '3'] },
        lineIndex: 1,
      }),
    ];

    const result = reconstructClaudeTaskState(calls);
    expect(result.tasks[0].blocks).toEqual(['2', '3']);
  });
});
