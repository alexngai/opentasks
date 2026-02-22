/**
 * Tests for Plan Mode Tracker
 */

import { describe, it, expect } from 'vitest';
import { extractPlanModeTransitions } from '../plan-mode-tracker.js';
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

describe('extractPlanModeTransitions', () => {
  it('extracts normal enter → exit (approved)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({ toolName: 'EnterPlanMode', input: {}, lineIndex: 0 }),
      makeToolCall({
        toolName: 'ExitPlanMode',
        input: { plan: '## Plan\n1. Do A\n2. Do B' },
        success: true,
        lineIndex: 5,
      }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({
      type: 'enter',
      lineIndex: 0,
    });

    expect(result[1]).toEqual({
      type: 'exit',
      lineIndex: 5,
      planContent: '## Plan\n1. Do A\n2. Do B',
      approved: true,
    });
  });

  it('extracts enter → exit (rejected) → re-enter → exit (approved)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({ toolName: 'EnterPlanMode', lineIndex: 0 }),
      makeToolCall({
        toolName: 'ExitPlanMode',
        input: { plan: 'Plan v1' },
        success: false,
        lineIndex: 3,
      }),
      makeToolCall({ toolName: 'EnterPlanMode', lineIndex: 5 }),
      makeToolCall({
        toolName: 'ExitPlanMode',
        input: { plan: 'Plan v2' },
        success: true,
        lineIndex: 8,
      }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toHaveLength(4);

    expect(result[0].type).toBe('enter');
    expect(result[1].type).toBe('exit');
    expect(result[1].approved).toBe(false);
    expect(result[1].planContent).toBe('Plan v1');

    expect(result[2].type).toBe('enter');
    expect(result[3].type).toBe('exit');
    expect(result[3].approved).toBe(true);
    expect(result[3].planContent).toBe('Plan v2');
  });

  it('handles enter with no exit (session ended in plan mode)', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({ toolName: 'EnterPlanMode', lineIndex: 0 }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('enter');
    expect(result[0].lineIndex).toBe(0);
  });

  it('returns empty array when no plan mode transitions', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({ toolName: 'TaskCreate', input: { subject: 'test' }, lineIndex: 0 }),
      makeToolCall({ toolName: 'Bash', category: 'unknown', input: {}, lineIndex: 1 }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toEqual([]);
  });

  it('handles ExitPlanMode with no plan content', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({ toolName: 'EnterPlanMode', lineIndex: 0 }),
      makeToolCall({
        toolName: 'ExitPlanMode',
        input: {},
        success: true,
        lineIndex: 2,
      }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toHaveLength(2);
    expect(result[1].planContent).toBeUndefined();
    expect(result[1].approved).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(extractPlanModeTransitions([])).toEqual([]);
  });

  it('ignores non-claude-native tool calls', () => {
    const calls: ExtractedToolCall[] = [
      makeToolCall({
        toolName: 'EnterPlanMode',
        category: 'unknown', // shouldn't happen but be safe
        lineIndex: 0,
      }),
    ];

    const result = extractPlanModeTransitions(calls);
    expect(result).toEqual([]);
  });
});
