/**
 * Plan Mode Tracker
 *
 * Extracts EnterPlanMode/ExitPlanMode transitions from extracted tool calls.
 */

import type { ExtractedToolCall } from './claude-tool-categorizer.js';

// ============================================================================
// Types
// ============================================================================

export interface PlanModeTransition {
  type: 'enter' | 'exit';
  lineIndex: number;

  /** For exit: the plan content from ExitPlanMode input */
  planContent?: string;

  /** For exit: whether user approved (inferred from tool_result success) */
  approved?: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Extract plan mode transitions from a list of extracted tool calls.
 * Only processes calls with `toolName` of `EnterPlanMode` or `ExitPlanMode`.
 */
export function extractPlanModeTransitions(toolCalls: ExtractedToolCall[]): PlanModeTransition[] {
  const transitions: PlanModeTransition[] = [];

  for (const call of toolCalls) {
    if (call.category !== 'claude-native') continue;

    if (call.toolName === 'EnterPlanMode') {
      transitions.push({
        type: 'enter',
        lineIndex: call.lineIndex,
      });
    }

    if (call.toolName === 'ExitPlanMode') {
      transitions.push({
        type: 'exit',
        lineIndex: call.lineIndex,
        planContent: (call.input.plan as string) ?? undefined,
        approved: call.success,
      });
    }
  }

  return transitions;
}
