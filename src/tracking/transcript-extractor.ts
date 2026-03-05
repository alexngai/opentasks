/**
 * Transcript Extractor Orchestrator
 *
 * Fetches Entire session transcripts, dispatches to the correct parser,
 * runs categorization/reconstruction/plan-mode tracking, and backfills
 * the SkillTrackerRegistry before session finalization.
 *
 * Best-effort: errors are caught and logged, never blocking the linker.
 */

import { execSync } from 'node:child_process';
import { claude, detectAgentTypeFromContent } from 'agent-session-parser';
import type { AgentType, TokenUsage } from 'agent-session-parser';
import { extractToolCalls, type ExtractedToolCall, type ToolCategory } from './claude-tool-categorizer.js';
import type { SkillTrackerRegistry } from './skill-tracker.js';
import type { EntireSessionEvent } from '../daemon/entire-watcher.js';

// ============================================================================
// Types
// ============================================================================

export interface TranscriptExtractorConfig {
  /** Skill tracker registry for backfilling tool usage */
  skillTrackerRegistry?: SkillTrackerRegistry;

  /** Git repo path to resolve transcript from (defaults to cwd) */
  repoPath?: string;

  /** Override git command execution (for testing) */
  execGit?: (args: string) => string;
}

export interface TranscriptExtractionResult {
  sessionId: string;
  agentType: AgentType | 'unknown';

  /** All extracted tool calls, chronological */
  toolCalls: ExtractedToolCall[];

  /** Tool call counts by category */
  toolCategories: Record<ToolCategory, number>;

  /** Token usage (from agent-session-parser) */
  tokenUsage?: TokenUsage;

  /** Spawned subagent IDs (agentId → toolUseId) */
  subagentIds?: Record<string, string>;
}

export interface TranscriptExtractor {
  /** Extract tool usage from a session's transcript on session end */
  extract(event: EntireSessionEvent): Promise<TranscriptExtractionResult | null>;
}

// ============================================================================
// Helpers
// ============================================================================

function defaultExecGit(args: string, repoPath?: string): string {
  const opts = repoPath ? { cwd: repoPath } : {};
  return execSync(`git ${args}`, { ...opts, encoding: 'utf-8', timeout: 10000 });
}

function countByCategory(toolCalls: ExtractedToolCall[]): Record<ToolCategory, number> {
  const counts: Record<ToolCategory, number> = {
    'claude-native': 0,
    'mcp-sudocode': 0,
    'mcp-other': 0,
    'unknown': 0,
  };
  for (const call of toolCalls) {
    counts[call.category]++;
  }
  return counts;
}

/**
 * Fetch transcript and metadata from git for a checkpoint.
 *
 * Path format: sessionlog/checkpoints/v1:<shard>/<rest>/1/full.jsonl
 * where shard = id.slice(0, 2), rest = id.slice(2)
 */
function fetchTranscriptFromGit(
  checkpointId: string,
  execGit: (args: string) => string,
): { transcript: string; metadata: Record<string, unknown> } | null {
  const shard = checkpointId.slice(0, 2);
  const rest = checkpointId.slice(2);
  const basePath = `${shard}/${rest}/1`;

  try {
    const metadataRaw = execGit(`show sessionlog/checkpoints/v1:${basePath}/metadata.json`);
    const transcript = execGit(`show sessionlog/checkpoints/v1:${basePath}/full.jsonl`);
    const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    return { transcript, metadata };
  } catch {
    return null;
  }
}

function resolveAgentType(
  metadata: Record<string, unknown>,
  transcript: string,
): AgentType | 'unknown' {
  const metaAgent = metadata.agent as string | undefined;
  if (metaAgent === 'Claude Code') return 'Claude Code';
  if (metaAgent === 'Gemini CLI') return 'Gemini CLI';

  // Fallback: auto-detect from content
  const detected = detectAgentTypeFromContent(transcript);
  return detected ?? 'unknown';
}

// ============================================================================
// Implementation
// ============================================================================

export function createTranscriptExtractor(config: TranscriptExtractorConfig): TranscriptExtractor {
  const { skillTrackerRegistry, repoPath } = config;
  const execGit = config.execGit ?? ((args: string) => defaultExecGit(args, repoPath));

  return {
    async extract(event: EntireSessionEvent): Promise<TranscriptExtractionResult | null> {
      if (event.type !== 'ended') return null;

      const { sessionId, session } = event;
      const checkpoints = session.checkpoints;

      if (!checkpoints || checkpoints.length === 0) return null;

      // Use the last checkpoint (most complete transcript)
      const lastCheckpointId = checkpoints[checkpoints.length - 1];
      const fetched = fetchTranscriptFromGit(lastCheckpointId, execGit);

      if (!fetched) return null;

      const { transcript, metadata } = fetched;
      const agentType = resolveAgentType(metadata, transcript);

      // Only Claude Code extraction is supported in v1
      if (agentType !== 'Claude Code') {
        return {
          sessionId,
          agentType,
          toolCalls: [],
          toolCategories: countByCategory([]),
        };
      }

      // Parse transcript
      const lines = claude.parseFromString(transcript);

      // Extract tool calls
      const toolCalls = extractToolCalls(lines);
      const toolCategories = countByCategory(toolCalls);

      // Token usage
      let tokenUsage: TokenUsage | undefined;
      try {
        tokenUsage = claude.calculateTokenUsage(lines);
      } catch {
        // Token calculation is best-effort
      }

      // Spawned subagent IDs
      let subagentIds: Record<string, string> | undefined;
      try {
        const subagentMap = claude.extractSpawnedAgentIds(lines);
        if (subagentMap.size > 0) {
          subagentIds = Object.fromEntries(subagentMap);
        }
      } catch {
        // Best-effort
      }

      const result: TranscriptExtractionResult = {
        sessionId,
        agentType,
        toolCalls,
        toolCategories,
        tokenUsage,
        subagentIds,
      };

      // Backfill SkillTracker
      if (skillTrackerRegistry) {
        const tracker = skillTrackerRegistry.getOrCreate(sessionId);
        for (const call of toolCalls) {
          tracker.record({
            skill: call.toolName,
            success: call.success,
            operation: call.category,
            targets: extractTargets(call),
          });
        }
      }

      return result;
    },
  };
}

/**
 * Extract meaningful target IDs from a tool call for SkillTracker recording.
 */
function extractTargets(call: ExtractedToolCall): string[] | undefined {
  const targets: string[] = [];

  // MCP sudocode: extract spec/issue IDs
  if (call.category === 'mcp-sudocode') {
    const input = call.input;
    if (typeof input.spec_id === 'string') targets.push(input.spec_id);
    if (typeof input.issue_id === 'string') targets.push(input.issue_id);
    if (typeof input.from_id === 'string') targets.push(input.from_id);
    if (typeof input.to_id === 'string') targets.push(input.to_id);
  }

  // Claude native: extract task IDs
  if (call.category === 'claude-native') {
    const input = call.input;
    if (typeof input.taskId === 'string') targets.push(input.taskId);
  }

  return targets.length > 0 ? targets : undefined;
}
