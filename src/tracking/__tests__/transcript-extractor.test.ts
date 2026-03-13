/**
 * Tests for Transcript Extractor Orchestrator
 */

import { describe, it, expect, vi } from 'vitest';
import { createTranscriptExtractor } from '../transcript-extractor.js';
import { createSkillTrackerRegistry } from '../skill-tracker.js';
import type { SessionlogSessionEvent, SessionlogSessionState } from '../../daemon/sessionlog-watcher.js';

// ============================================================================
// Sample Transcript Data
// ============================================================================

function makeLine(type: string, uuid: string, content: unknown): string {
  return JSON.stringify({ type, uuid, message: { id: `msg_${uuid}`, content } });
}

const SAMPLE_CLAUDE_TRANSCRIPT = [
  // TaskCreate
  makeLine('assistant', 'a1', [
    { type: 'tool_use', id: 'toolu_01', name: 'TaskCreate', input: { subject: 'Fix bug', description: 'Fix login' } },
  ]),
  makeLine('user', 'u1', [
    { type: 'tool_result', tool_use_id: 'toolu_01', content: 'Task #1 created successfully: Fix bug' },
  ]),
  // TaskUpdate to in_progress
  makeLine('assistant', 'a2', [
    { type: 'tool_use', id: 'toolu_02', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } },
  ]),
  makeLine('user', 'u2', [
    { type: 'tool_result', tool_use_id: 'toolu_02', content: 'Updated task #1 status' },
  ]),
  // EnterPlanMode
  makeLine('assistant', 'a3', [
    { type: 'tool_use', id: 'toolu_03', name: 'EnterPlanMode', input: {} },
  ]),
  makeLine('user', 'u3', [
    { type: 'tool_result', tool_use_id: 'toolu_03', content: '' },
  ]),
  // ExitPlanMode
  makeLine('assistant', 'a4', [
    { type: 'tool_use', id: 'toolu_04', name: 'ExitPlanMode', input: { plan: '## Plan\n1. Fix auth' } },
  ]),
  makeLine('user', 'u4', [
    { type: 'tool_result', tool_use_id: 'toolu_04', content: 'Plan approved' },
  ]),
  // MCP sudocode call
  makeLine('assistant', 'a5', [
    { type: 'tool_use', id: 'toolu_05', name: 'mcp__plugin_sudocode_sudocode__show_issue', input: { issue_id: 'i-1234' } },
  ]),
  makeLine('user', 'u5', [
    { type: 'tool_result', tool_use_id: 'toolu_05', content: '{"id":"i-1234","title":"Test"}' },
  ]),
  // Regular tool call
  makeLine('assistant', 'a6', [
    { type: 'tool_use', id: 'toolu_06', name: 'Bash', input: { command: 'ls' } },
  ]),
  makeLine('user', 'u6', [
    { type: 'tool_result', tool_use_id: 'toolu_06', content: 'file1.ts' },
  ]),
  // TaskUpdate to completed
  makeLine('assistant', 'a7', [
    { type: 'tool_use', id: 'toolu_07', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
  ]),
  makeLine('user', 'u7', [
    { type: 'tool_result', tool_use_id: 'toolu_07', content: 'Updated task #1 status' },
  ]),
].join('\n');

const SAMPLE_METADATA = JSON.stringify({ agent: 'Claude Code', checkpoint_id: 'ab12cd34ef56' });

// ============================================================================
// Helpers
// ============================================================================

function makeEndedEvent(
  sessionId: string,
  checkpoints: string[] = ['ab12cd34ef56'],
): SessionlogSessionEvent {
  const session: SessionlogSessionState = {
    id: sessionId,
    agent: 'Claude Code',
    phase: 'ENDED',
    checkpoints,
    endedAt: new Date().toISOString(),
  };
  return {
    type: 'ended',
    sessionId,
    session,
    previousPhase: 'ACTIVE',
    timestamp: new Date().toISOString(),
  };
}

function createMockExecGit(
  metadata: string = SAMPLE_METADATA,
  transcript: string = SAMPLE_CLAUDE_TRANSCRIPT,
): (args: string) => string {
  return (args: string) => {
    if (args.includes('metadata.json')) return metadata;
    if (args.includes('full.jsonl')) return transcript;
    throw new Error(`Unexpected git command: ${args}`);
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createTranscriptExtractor', () => {
  describe('extract', () => {
    it('extracts tool calls from a Claude Code transcript', async () => {
      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
      });

      const result = await extractor.extract(makeEndedEvent('sess-1'));
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-1');
      expect(result!.agentType).toBe('Claude Code');
      expect(result!.toolCalls).toHaveLength(7);
    });

    it('categorizes tool calls correctly', async () => {
      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
      });

      const result = await extractor.extract(makeEndedEvent('sess-1'));
      expect(result!.toolCategories).toEqual({
        'claude-native': 5, // TaskCreate, TaskUpdate x2, EnterPlanMode, ExitPlanMode
        'mcp-sudocode': 1,
        'mcp-other': 0,
        'unknown': 1, // Bash
      });
    });

    it('backfills SkillTrackerRegistry', async () => {
      const registry = createSkillTrackerRegistry();

      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
        skillTrackerRegistry: registry,
      });

      await extractor.extract(makeEndedEvent('sess-1'));

      const tracker = registry.get('sess-1');
      expect(tracker).not.toBeNull();

      const stats = tracker!.getStats();
      expect(stats.length).toBeGreaterThan(0);

      const taskCreateStats = stats.find((s) => s.skill === 'TaskCreate');
      expect(taskCreateStats).toBeDefined();
      expect(taskCreateStats!.count).toBe(1);

      const bashStats = stats.find((s) => s.skill === 'Bash');
      expect(bashStats).toBeDefined();
      expect(bashStats!.count).toBe(1);

      const sudocodeStats = stats.find(
        (s) => s.skill === 'mcp__plugin_sudocode_sudocode__show_issue',
      );
      expect(sudocodeStats).toBeDefined();
    });

    it('returns null for non-ended events', async () => {
      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
      });

      const event: SessionlogSessionEvent = {
        type: 'started',
        sessionId: 'sess-1',
        session: { id: 'sess-1', agent: 'Claude Code', phase: 'ACTIVE', checkpoints: [] },
        timestamp: new Date().toISOString(),
      };

      const result = await extractor.extract(event);
      expect(result).toBeNull();
    });

    it('returns null when no checkpoints', async () => {
      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
      });

      const result = await extractor.extract(makeEndedEvent('sess-1', []));
      expect(result).toBeNull();
    });

    it('returns null when git fetch fails', async () => {
      const extractor = createTranscriptExtractor({
        execGit: () => {
          throw new Error('git not available');
        },
      });

      const result = await extractor.extract(makeEndedEvent('sess-1'));
      expect(result).toBeNull();
    });

    it('handles Gemini agent type (returns empty tool calls for v1)', async () => {
      const geminiMetadata = JSON.stringify({ agent: 'Gemini CLI' });
      const geminiTranscript = JSON.stringify({ messages: [] });

      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(geminiMetadata, geminiTranscript),
      });

      const result = await extractor.extract(makeEndedEvent('sess-1'));
      expect(result).not.toBeNull();
      expect(result!.agentType).toBe('Gemini CLI');
      expect(result!.toolCalls).toEqual([]);
    });

    it('uses the last checkpoint when multiple exist', async () => {
      const execGit = vi.fn(createMockExecGit());

      const extractor = createTranscriptExtractor({ execGit });

      await extractor.extract(makeEndedEvent('sess-1', ['aaaa11111111', 'bbbb22222222']));

      // Should use checkpoint 'bbbb22222222'
      // shard = 'bb', rest = 'bb22222222'
      expect(execGit).toHaveBeenCalledWith(
        expect.stringContaining('bb/bb22222222'),
      );
    });

    it('extracts targets for sudocode tool calls', async () => {
      const registry = createSkillTrackerRegistry();

      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(),
        skillTrackerRegistry: registry,
      });

      await extractor.extract(makeEndedEvent('sess-1'));

      const tracker = registry.get('sess-1');
      const invocations = tracker!.getInvocations();
      const sudocodeInv = invocations.find(
        (i) => i.skill === 'mcp__plugin_sudocode_sudocode__show_issue',
      );
      expect(sudocodeInv).toBeDefined();
      expect(sudocodeInv!.targets).toEqual(['i-1234']);
    });

    it('handles empty transcript gracefully', async () => {
      const extractor = createTranscriptExtractor({
        execGit: createMockExecGit(SAMPLE_METADATA, ''),
      });

      const result = await extractor.extract(makeEndedEvent('sess-1'));
      expect(result).not.toBeNull();
      expect(result!.toolCalls).toEqual([]);
    });
  });
});
