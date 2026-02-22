/**
 * Tests for Claude Tool Call Categorizer
 */

import { describe, it, expect } from 'vitest';
import {
  extractToolCalls,
  categorizeToolName,
  type ExtractedToolCall,
} from '../claude-tool-categorizer.js';
import type { claude } from 'agent-session-parser';

// ============================================================================
// Helpers
// ============================================================================

function assistantLine(
  index: number,
  blocks: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }>,
): claude.TranscriptLine {
  return {
    type: 'assistant',
    uuid: `asst-${index}`,
    message: { content: blocks },
  };
}

function userLine(
  index: number,
  blocks: Array<{
    type: string;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
  }>,
): claude.TranscriptLine {
  return {
    type: 'user',
    uuid: `user-${index}`,
    message: { content: blocks },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('categorizeToolName', () => {
  it('categorizes claude-native tools', () => {
    expect(categorizeToolName('TaskCreate')).toBe('claude-native');
    expect(categorizeToolName('TaskUpdate')).toBe('claude-native');
    expect(categorizeToolName('TaskList')).toBe('claude-native');
    expect(categorizeToolName('TaskGet')).toBe('claude-native');
    expect(categorizeToolName('EnterPlanMode')).toBe('claude-native');
    expect(categorizeToolName('ExitPlanMode')).toBe('claude-native');
  });

  it('categorizes mcp-sudocode tools', () => {
    expect(categorizeToolName('mcp__plugin_sudocode_sudocode__upsert_issue')).toBe('mcp-sudocode');
    expect(categorizeToolName('mcp__plugin_sudocode_sudocode__show_spec')).toBe('mcp-sudocode');
    expect(categorizeToolName('mcp__plugin_sudocode_sudocode__list_issues')).toBe('mcp-sudocode');
    expect(categorizeToolName('mcp__plugin_sudocode_sudocode__ready')).toBe('mcp-sudocode');
  });

  it('categorizes mcp-other tools', () => {
    expect(categorizeToolName('mcp__other_server__some_tool')).toBe('mcp-other');
    expect(categorizeToolName('mcp__github__create_pr')).toBe('mcp-other');
  });

  it('categorizes unknown tools', () => {
    expect(categorizeToolName('Bash')).toBe('unknown');
    expect(categorizeToolName('Read')).toBe('unknown');
    expect(categorizeToolName('Write')).toBe('unknown');
    expect(categorizeToolName('Edit')).toBe('unknown');
    expect(categorizeToolName('Grep')).toBe('unknown');
    expect(categorizeToolName('Glob')).toBe('unknown');
    expect(categorizeToolName('Task')).toBe('unknown');
    expect(categorizeToolName('WebFetch')).toBe('unknown');
  });
});

describe('extractToolCalls', () => {
  it('extracts a single tool call with result', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/foo.ts' } },
      ]),
      userLine(1, [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'file contents...' },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      toolName: 'Read',
      toolUseId: 'toolu_01',
      category: 'unknown',
      input: { file_path: '/foo.ts' },
      output: 'file contents...',
      success: true,
      lineIndex: 0,
    });
  });

  it('handles error tool results', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'exit 1' } },
      ]),
      userLine(1, [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'command failed', is_error: true },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(false);
    expect(result[0].output).toBe('command failed');
  });

  it('handles parallel tool calls (multiple tool_use in one message)', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { file_path: '/b.ts' } },
      ]),
      userLine(1, [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'content a' },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: 'content b' },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(2);
    expect(result[0].toolUseId).toBe('toolu_01');
    expect(result[1].toolUseId).toBe('toolu_02');
    expect(result[0].output).toBe('content a');
    expect(result[1].output).toBe('content b');
  });

  it('handles missing tool_result (tool call at end of transcript)', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'TaskCreate', input: { subject: 'test' } },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(true); // default when no result
    expect(result[0].output).toBeUndefined();
    expect(result[0].category).toBe('claude-native');
  });

  it('categorizes mixed tool calls correctly', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'TaskCreate', input: { subject: 'test' } },
      ]),
      userLine(1, [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'Task #1 created successfully' },
      ]),
      assistantLine(2, [
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'mcp__plugin_sudocode_sudocode__upsert_issue',
          input: { title: 'test' },
        },
      ]),
      userLine(3, [
        { type: 'tool_result', tool_use_id: 'toolu_02', content: '{"id":"i-xxxx"}' },
      ]),
      assistantLine(4, [
        { type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'ls' } },
      ]),
      userLine(5, [
        { type: 'tool_result', tool_use_id: 'toolu_03', content: 'file1.ts\nfile2.ts' },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(3);
    expect(result[0].category).toBe('claude-native');
    expect(result[1].category).toBe('mcp-sudocode');
    expect(result[2].category).toBe('unknown');
  });

  it('skips non-assistant/non-tool_use lines', () => {
    const lines: claude.TranscriptLine[] = [
      { type: 'system', uuid: 'sys-1', message: {} },
      assistantLine(0, [{ type: 'text', text: 'Hello world' }]),
      userLine(1, []),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(0);
  });

  it('handles tool_result with array content', () => {
    const lines: claude.TranscriptLine[] = [
      assistantLine(0, [
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/test.png' } },
      ]),
      userLine(1, [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: [{ type: 'image', source: { data: 'base64...' } }],
        },
      ]),
    ];

    const result = extractToolCalls(lines);
    expect(result).toHaveLength(1);
    expect(result[0].output).toContain('image');
  });

  it('returns empty array for empty transcript', () => {
    expect(extractToolCalls([])).toEqual([]);
  });
});
