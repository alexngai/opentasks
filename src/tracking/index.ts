/**
 * Tracking Module
 *
 * Skill usage tracking for agent sessions/trajectories,
 * plus transcript-based tool extraction and Claude task reconstruction.
 *
 * @packageDocumentation
 */

export type {
  SkillName,
  SkillInvocation,
  SkillUsageStats,
  SkillUsageSummary,
  SkillTrackerOptions,
  SkillTracker,
  SkillTrackerRegistry,
} from './skill-tracker.js';

export { createSkillTracker, createSkillTrackerRegistry } from './skill-tracker.js';

export type { ToolCategory, ExtractedToolCall } from './claude-tool-categorizer.js';

export { categorizeToolName, extractToolCalls } from './claude-tool-categorizer.js';

export type {
  TranscriptExtractorConfig,
  TranscriptExtractionResult,
  TranscriptExtractor,
} from './transcript-extractor.js';

export { createTranscriptExtractor } from './transcript-extractor.js';
