/**
 * Claude Tool Call Categorizer
 *
 * Extracts and categorizes tool_use blocks from parsed Claude Code transcripts.
 * Groups tools by system: claude-native, mcp-sudocode, mcp-other, or unknown.
 */

import type { claude } from 'agent-session-parser';

// ============================================================================
// Types
// ============================================================================

export type ToolCategory = 'claude-native' | 'mcp-sudocode' | 'mcp-other' | 'unknown';

export interface ExtractedToolCall {
  /** Tool name as it appears in the transcript */
  toolName: string;

  /** tool_use block ID */
  toolUseId: string;

  /** Normalized category */
  category: ToolCategory;

  /** Input parameters */
  input: Record<string, unknown>;

  /** Output/result content (from matching tool_result) */
  output?: string;

  /** Whether the call succeeded (from tool_result.is_error) */
  success: boolean;

  /** Position in transcript (line index) */
  lineIndex: number;
}

// ============================================================================
// Categorization
// ============================================================================

const CLAUDE_NATIVE_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'EnterPlanMode',
  'ExitPlanMode',
]);

export function categorizeToolName(name: string): ToolCategory {
  if (CLAUDE_NATIVE_TOOLS.has(name)) return 'claude-native';
  if (name.startsWith('mcp__plugin_sudocode_sudocode__')) return 'mcp-sudocode';
  if (name.startsWith('mcp__')) return 'mcp-other';
  return 'unknown';
}

// ============================================================================
// Extraction
// ============================================================================

interface ToolResultInfo {
  content: string;
  isError: boolean;
}

/**
 * Raw content block from transcript — has extra fields beyond the typed ContentBlock.
 */
interface RawContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Build a map of tool_use_id → tool_result from all user messages.
 */
function buildToolResultMap(lines: claude.TranscriptLine[]): Map<string, ToolResultInfo> {
  const resultMap = new Map<string, ToolResultInfo>();

  for (const line of lines) {
    if (line.type !== 'user') continue;
    const message = line.message as { content?: unknown } | undefined;
    if (!message?.content) continue;

    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as RawContentBlock[]) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;

      let contentStr: string;
      if (typeof block.content === 'string') {
        contentStr = block.content;
      } else if (Array.isArray(block.content)) {
        contentStr = JSON.stringify(block.content);
      } else if (block.content !== undefined && block.content !== null) {
        contentStr = String(block.content);
      } else {
        contentStr = '';
      }

      resultMap.set(block.tool_use_id, {
        content: contentStr,
        isError: !!block.is_error,
      });
    }
  }

  return resultMap;
}

/**
 * Extract and categorize all tool calls from a parsed Claude Code transcript.
 */
export function extractToolCalls(lines: claude.TranscriptLine[]): ExtractedToolCall[] {
  const resultMap = buildToolResultMap(lines);
  const toolCalls: ExtractedToolCall[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type !== 'assistant') continue;

    const message = line.message as { content?: unknown } | undefined;
    if (!message?.content || !Array.isArray(message.content)) continue;

    for (const block of message.content as RawContentBlock[]) {
      if (block.type !== 'tool_use' || !block.name) continue;

      const toolUseId = block.id;
      if (!toolUseId) continue;

      const result = resultMap.get(toolUseId);

      toolCalls.push({
        toolName: block.name,
        toolUseId,
        category: categorizeToolName(block.name),
        input: (block.input as Record<string, unknown>) ?? {},
        output: result?.content,
        success: result ? !result.isError : true,
        lineIndex: i,
      });
    }
  }

  return toolCalls;
}
