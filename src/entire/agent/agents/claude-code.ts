/**
 * Claude Code Agent
 *
 * Implementation of the Entire agent interface for Anthropic's Claude Code.
 * Handles JSONL transcript format, Claude-specific hook installation,
 * and session lifecycle management.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  AGENT_NAMES,
  AGENT_TYPES,
  type HookInput,
  type Event,
  type TokenUsage,
  EventType,
  emptyTokenUsage,
} from '../../types.js';
import type {
  Agent,
  HookSupport,
  TranscriptAnalyzer,
  TokenCalculator,
  TranscriptChunker,
} from '../types.js';
import { registerAgent } from '../registry.js';

// ============================================================================
// Constants
// ============================================================================

const CLAUDE_DIR = '.claude';
const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

const HOOK_NAMES = [
  'session-start',
  'session-end',
  'stop',
  'user-prompt-submit',
  'pre-task',
  'post-task',
  'post-todo',
] as const;

/** Tools that modify files (detected in transcript) */
const FILE_MODIFICATION_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'mcp__acp__Write',
  'mcp__acp__Edit',
]);

/** Deny rule to prevent agents from reading metadata */
const METADATA_DENY_RULE = 'Read(./.entire/metadata/**)';

// ============================================================================
// Transcript Types (JSONL)
// ============================================================================

export interface TranscriptLine {
  type: 'user' | 'assistant';
  uuid?: string;
  message: unknown;
}

export interface AssistantContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

// ============================================================================
// Claude Code Settings Types
// ============================================================================

interface ClaudeHookEntry {
  type: string;
  command: string;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: ClaudeHookMatcher[];
    SessionEnd?: ClaudeHookMatcher[];
    UserPromptSubmit?: ClaudeHookMatcher[];
    Stop?: ClaudeHookMatcher[];
    PreToolUse?: ClaudeHookMatcher[];
    PostToolUse?: ClaudeHookMatcher[];
  };
  permissions?: {
    deny?: string[];
  };
  [key: string]: unknown;
}

// ============================================================================
// Claude Code Agent Implementation
// ============================================================================

class ClaudeCodeAgent
  implements Agent, HookSupport, TranscriptAnalyzer, TokenCalculator, TranscriptChunker
{
  readonly name = AGENT_NAMES.CLAUDE_CODE;
  readonly type = AGENT_TYPES.CLAUDE_CODE;
  readonly description = 'Anthropic Claude Code CLI';
  readonly isPreview = false;
  readonly protectedDirs = [CLAUDE_DIR];

  async detectPresence(cwd?: string): Promise<boolean> {
    const repoRoot = cwd ?? process.cwd();
    const claudeDir = path.join(repoRoot, CLAUDE_DIR);
    try {
      const stat = await fs.promises.stat(claudeDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async getSessionDir(repoPath: string): Promise<string> {
    // Claude Code stores sessions in ~/.claude/projects/<sanitized-path>/
    const sanitized = sanitizePathForClaude(repoPath);
    return path.join(os.homedir(), '.claude', 'projects', sanitized);
  }

  getSessionID(input: HookInput): string {
    return input.sessionID;
  }

  resolveSessionFile(sessionDir: string, agentSessionID: string): string {
    return path.join(sessionDir, `${agentSessionID}.jsonl`);
  }

  async readTranscript(sessionRef: string): Promise<Buffer> {
    return fs.promises.readFile(sessionRef);
  }

  formatResumeCommand(sessionID: string): string {
    return `claude --resume ${sessionID}`;
  }

  // ===========================================================================
  // HookSupport
  // ===========================================================================

  hookNames(): string[] {
    return [...HOOK_NAMES];
  }

  parseHookEvent(hookName: string, stdin: string): Event | null {
    try {
      const data = JSON.parse(stdin) as Record<string, unknown>;

      switch (hookName) {
        case 'session-start':
          return {
            type: EventType.SessionStart,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            timestamp: new Date(),
          };

        case 'user-prompt-submit':
          return {
            type: EventType.TurnStart,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            prompt: String(data.prompt ?? ''),
            timestamp: new Date(),
          };

        case 'stop':
          return {
            type: EventType.TurnEnd,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            timestamp: new Date(),
          };

        case 'session-end':
          return {
            type: EventType.SessionEnd,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            timestamp: new Date(),
          };

        case 'pre-task':
          return {
            type: EventType.SubagentStart,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            toolUseID: String(data.tool_use_id ?? data.toolUseID ?? ''),
            toolInput: data.tool_input ?? data.toolInput,
            timestamp: new Date(),
          };

        case 'post-task':
          return {
            type: EventType.SubagentEnd,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            toolUseID: String(data.tool_use_id ?? data.toolUseID ?? ''),
            subagentID: (data.tool_response as Record<string, unknown>)?.agentId as string,
            timestamp: new Date(),
          };

        case 'post-todo':
          return {
            type: EventType.Compaction,
            sessionID: String(data.session_id ?? data.sessionID ?? ''),
            sessionRef: String(data.transcript_path ?? data.transcriptPath ?? ''),
            timestamp: new Date(),
          };

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  async installHooks(repoPath: string, force = false): Promise<number> {
    const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_FILE);
    let settings: ClaudeSettings = {};

    // Read existing settings
    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content) as ClaudeSettings;
    } catch {
      // No existing settings
    }

    if (!settings.hooks) settings.hooks = {};

    let installed = 0;

    // Install lifecycle hooks
    const hookMappings: Array<{
      settingsKey: keyof NonNullable<ClaudeSettings['hooks']>;
      hookName: string;
    }> = [
      { settingsKey: 'SessionStart', hookName: 'session-start' },
      { settingsKey: 'SessionEnd', hookName: 'session-end' },
      { settingsKey: 'UserPromptSubmit', hookName: 'user-prompt-submit' },
      { settingsKey: 'Stop', hookName: 'stop' },
    ];

    // Task hooks (pre/post tool use for Task tool)
    const taskHookMappings: Array<{
      settingsKey: keyof NonNullable<ClaudeSettings['hooks']>;
      hookName: string;
      matcher: string;
    }> = [
      { settingsKey: 'PreToolUse', hookName: 'pre-task', matcher: 'Task' },
      { settingsKey: 'PostToolUse', hookName: 'post-task', matcher: 'Task' },
      { settingsKey: 'PostToolUse', hookName: 'post-todo', matcher: 'TodoWrite' },
    ];

    for (const { settingsKey, hookName } of hookMappings) {
      const existing = settings.hooks[settingsKey] ?? [];

      if (force) {
        // Remove existing entire hooks
        const filtered = existing.filter(
          (m) => !m.hooks.some((h) => h.command.includes('entire ')),
        );
        settings.hooks[settingsKey] = filtered;
      }

      // Check if already installed
      const hasEntireHook = (settings.hooks[settingsKey] ?? []).some((m) =>
        m.hooks.some((h) => h.command.includes('entire ')),
      );

      if (!hasEntireHook) {
        const matchers = settings.hooks[settingsKey] ?? [];
        matchers.push({
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `entire hooks claude-code ${hookName}`,
            },
          ],
        });
        settings.hooks[settingsKey] = matchers;
        installed++;
      }
    }

    for (const { settingsKey, hookName, matcher } of taskHookMappings) {
      const existing = settings.hooks[settingsKey] ?? [];

      if (force) {
        const filtered = existing.filter(
          (m) =>
            !(m.matcher === matcher && m.hooks.some((h) => h.command.includes('entire '))),
        );
        settings.hooks[settingsKey] = filtered;
      }

      const hasEntireHook = (settings.hooks[settingsKey] ?? []).some(
        (m) =>
          m.matcher === matcher && m.hooks.some((h) => h.command.includes('entire ')),
      );

      if (!hasEntireHook) {
        const matchers = settings.hooks[settingsKey] ?? [];
        matchers.push({
          matcher,
          hooks: [
            {
              type: 'command',
              command: `entire hooks claude-code ${hookName}`,
            },
          ],
        });
        settings.hooks[settingsKey] = matchers;
        installed++;
      }
    }

    // Add metadata deny rule
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.deny) settings.permissions.deny = [];
    if (!settings.permissions.deny.includes(METADATA_DENY_RULE)) {
      settings.permissions.deny.push(METADATA_DENY_RULE);
    }

    // Write settings
    const dir = path.dirname(settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return installed;
  }

  async uninstallHooks(repoPath: string): Promise<void> {
    const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_FILE);

    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content) as ClaudeSettings;

      if (settings.hooks) {
        for (const key of Object.keys(settings.hooks) as Array<
          keyof NonNullable<ClaudeSettings['hooks']>
        >) {
          const matchers = settings.hooks[key];
          if (!matchers) continue;

          settings.hooks[key] = matchers.filter(
            (m) => !m.hooks.some((h) => h.command.includes('entire ')),
          );

          if (settings.hooks[key]!.length === 0) {
            delete settings.hooks[key];
          }
        }

        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }

      // Remove deny rule
      if (settings.permissions?.deny) {
        settings.permissions.deny = settings.permissions.deny.filter(
          (d) => d !== METADATA_DENY_RULE,
        );
        if (settings.permissions.deny.length === 0) {
          delete settings.permissions.deny;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
      }

      await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    } catch {
      // No settings to modify
    }
  }

  async areHooksInstalled(repoPath: string): Promise<boolean> {
    const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_FILE);

    try {
      const content = await fs.promises.readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content) as ClaudeSettings;

      if (!settings.hooks) return false;

      // Check for at least the session-start hook
      const sessionStart = settings.hooks.SessionStart ?? [];
      return sessionStart.some((m) =>
        m.hooks.some((h) => h.command.includes('entire ')),
      );
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // TranscriptAnalyzer
  // ===========================================================================

  async getTranscriptPosition(transcriptPath: string): Promise<number> {
    try {
      const content = await fs.promises.readFile(transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      return lines.length;
    } catch {
      return 0;
    }
  }

  async extractModifiedFilesFromOffset(
    transcriptPath: string,
    startOffset: number,
  ): Promise<{ files: string[]; currentPosition: number }> {
    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const files = new Set<string>();

    for (let i = startOffset; i < lines.length; i++) {
      try {
        const line = JSON.parse(lines[i]) as TranscriptLine;
        if (line.type === 'assistant') {
          const contentBlocks = extractContentBlocks(line.message);
          for (const block of contentBlocks) {
            if (block.type === 'tool_use' && block.name && FILE_MODIFICATION_TOOLS.has(block.name)) {
              const filePath = (block.input as Record<string, unknown>)?.file_path as string;
              if (filePath) files.add(filePath);
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return { files: Array.from(files), currentPosition: lines.length };
  }

  async extractPrompts(sessionRef: string, fromOffset: number): Promise<string[]> {
    const content = await fs.promises.readFile(sessionRef, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const prompts: string[] = [];

    for (let i = fromOffset; i < lines.length; i++) {
      try {
        const line = JSON.parse(lines[i]) as TranscriptLine;
        if (line.type === 'user') {
          const text = extractUserText(line.message);
          if (text) prompts.push(text);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return prompts;
  }

  async extractSummary(sessionRef: string): Promise<string> {
    const prompts = await this.extractPrompts(sessionRef, 0);
    if (prompts.length === 0) return '';
    // Return the first prompt as a summary, truncated
    return prompts[0].slice(0, 200);
  }

  // ===========================================================================
  // TokenCalculator
  // ===========================================================================

  async calculateTokenUsage(transcriptData: Buffer, fromOffset: number): Promise<TokenUsage> {
    const content = transcriptData.toString('utf-8');
    const lines = content.split('\n').filter(Boolean);
    const usage = emptyTokenUsage();

    for (let i = fromOffset; i < lines.length; i++) {
      try {
        const raw = JSON.parse(lines[i]) as Record<string, unknown>;
        if (raw.type === 'assistant') {
          const msg = raw.message as Record<string, unknown> | undefined;
          const msgUsage = msg?.usage as MessageUsage | undefined;
          if (msgUsage) {
            usage.inputTokens += msgUsage.input_tokens ?? 0;
            usage.cacheCreationTokens += msgUsage.cache_creation_input_tokens ?? 0;
            usage.cacheReadTokens += msgUsage.cache_read_input_tokens ?? 0;
            usage.outputTokens += msgUsage.output_tokens ?? 0;
            usage.apiCallCount++;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return usage;
  }

  // ===========================================================================
  // TranscriptChunker
  // ===========================================================================

  async chunkTranscript(content: Buffer, maxSize: number): Promise<Buffer[]> {
    return chunkJSONL(content, maxSize);
  }

  async reassembleTranscript(chunks: Buffer[]): Promise<Buffer> {
    return Buffer.concat(chunks);
  }
}

// ============================================================================
// Transcript Parsing Helpers
// ============================================================================

function extractContentBlocks(message: unknown): AssistantContent[] {
  if (!message || typeof message !== 'object') return [];

  const msg = message as Record<string, unknown>;
  const content = msg.content;

  if (Array.isArray(content)) {
    return content as AssistantContent[];
  }

  return [];
}

function extractUserText(message: unknown): string {
  if (typeof message === 'string') return message;

  if (!message || typeof message !== 'object') return '';

  const msg = message as Record<string, unknown>;

  // Content can be string or array of blocks
  if (typeof msg.content === 'string') return msg.content;

  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');
  }

  return '';
}

/**
 * Parse a JSONL transcript into structured lines
 */
export function parseTranscript(content: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];

  for (const rawLine of content.split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(rawLine) as TranscriptLine;
      if (parsed.type === 'user' || parsed.type === 'assistant') {
        lines.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return lines;
}

/**
 * Extract all modified files from transcript lines
 */
export function extractModifiedFiles(lines: TranscriptLine[]): string[] {
  const files = new Set<string>();

  for (const line of lines) {
    if (line.type !== 'assistant') continue;
    const blocks = extractContentBlocks(line.message);
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name && FILE_MODIFICATION_TOOLS.has(block.name)) {
        const filePath = (block.input as Record<string, unknown>)?.file_path as string;
        if (filePath) files.add(filePath);
      }
    }
  }

  return Array.from(files);
}

/**
 * Extract the last user prompt from transcript lines
 */
export function extractLastUserPrompt(lines: TranscriptLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === 'user') {
      return extractUserText(lines[i].message);
    }
  }
  return '';
}

// ============================================================================
// JSONL Chunking
// ============================================================================

function chunkJSONL(content: Buffer, maxSize: number): Buffer[] {
  if (content.length <= maxSize) return [content];

  const str = content.toString('utf-8');
  const lines = str.split('\n');
  const chunks: Buffer[] = [];
  let current: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    const lineSize = Buffer.byteLength(line + '\n');

    if (currentSize + lineSize > maxSize && current.length > 0) {
      chunks.push(Buffer.from(current.join('\n') + '\n'));
      current = [];
      currentSize = 0;
    }

    current.push(line);
    currentSize += lineSize;
  }

  if (current.length > 0) {
    const remaining = current.join('\n');
    if (remaining.trim()) {
      chunks.push(Buffer.from(remaining + '\n'));
    }
  }

  return chunks;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Sanitize a filesystem path for use as a Claude project directory name
 */
function sanitizePathForClaude(repoPath: string): string {
  // Claude uses a hash-based directory naming scheme
  return crypto.createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Create and return a new Claude Code agent instance
 */
export function createClaudeCodeAgent(): ClaudeCodeAgent {
  return new ClaudeCodeAgent();
}

// Auto-register when imported
registerAgent(AGENT_NAMES.CLAUDE_CODE, () => new ClaudeCodeAgent());
