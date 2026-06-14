/**
 * Diagnostic metrics derived from the agent's tool-call trace.
 *
 * These are layered ON TOP of the benchmark's own scoring — they never affect
 * the pass/fail (which is ground-truth checkpoints), only the analysis.
 */

import type { ToolCallEvent } from './types.js';

/** OpenTasks MCP tools that count as "the agent consulted the graph". */
const GRAPH_READ_TOOLS = new Set([
  'mcp__opentasks__query',
  'mcp__opentasks__get_context',
  'mcp__opentasks__get_task',
  'mcp__opentasks__list_tasks',
  'mcp__opentasks__list_contexts',
  'mcp__opentasks__context_summary',
]);

/** Did the agent actually read the graph (the null-result branch hinges on this)? */
export function didReadGraph(toolCalls: ToolCallEvent[]): boolean {
  return toolCalls.some((tc) => GRAPH_READ_TOOLS.has(tc.name));
}

/**
 * Re-exploration proxy: count repeat Reads of the same path and repeat Greps of
 * the same pattern. A coarse stand-in for "redundant-exploration tokens" (the
 * headline E2′ metric); refined to a token estimate once we capture file sizes.
 */
export function computeRedundantExplorationOps(toolCalls: ToolCallEvent[]): number {
  const seenReads = new Set<string>();
  const seenGreps = new Set<string>();
  let repeats = 0;
  for (const tc of toolCalls) {
    const inp = (tc.input ?? {}) as Record<string, unknown>;
    if (tc.name === 'Read' && typeof inp.file_path === 'string') {
      if (seenReads.has(inp.file_path)) repeats++;
      else seenReads.add(inp.file_path);
    } else if (tc.name === 'Grep' && typeof inp.pattern === 'string') {
      const key = `${inp.pattern}|${String(inp.path ?? '')}`;
      if (seenGreps.has(key)) repeats++;
      else seenGreps.add(key);
    }
  }
  return repeats;
}
