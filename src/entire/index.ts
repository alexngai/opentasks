/**
 * Entire - Native TypeScript Implementation
 *
 * A self-contained module that implements the Entire CLI's functionality
 * in TypeScript. Designed with clean boundaries for eventual extraction
 * into a standalone package.
 *
 * @packageDocumentation
 */

// =============================================================================
// Core Types
// =============================================================================

export type {
  AgentName,
  AgentType,
  HookType,
  HookInput,
  Event,
  SessionPhase,
  SessionState,
  PromptAttribution,
  TokenUsage,
  CheckpointID,
  Checkpoint,
  CheckpointSummary,
  CommittedMetadata,
  SessionFilePaths,
  Summary,
  LearningsSummary,
  CodeLearning,
  InitialAttribution,
  RewindPoint,
  WriteTemporaryOptions,
  WriteTemporaryResult,
  WriteCommittedOptions,
  UpdateCommittedOptions,
  SessionChange,
  EntireSettings,
} from './types.js';

export {
  AGENT_NAMES,
  AGENT_TYPES,
  DEFAULT_AGENT_NAME,
  EventType,
  CheckpointType,
  CHECKPOINT_ID_LENGTH,
  CHECKPOINT_ID_PATTERN,
  CHECKPOINTS_BRANCH,
  SHADOW_BRANCH_PREFIX,
  ENTIRE_DIR,
  ENTIRE_METADATA_DIR,
  ENTIRE_TMP_DIR,
  ENTIRE_SETTINGS_FILE,
  ENTIRE_SETTINGS_LOCAL_FILE,
  SESSION_DIR_NAME,
  MAX_CHUNK_SIZE,
  DEFAULT_SETTINGS,
  validateCheckpointID,
  checkpointIDPath,
  emptyTokenUsage,
  addTokenUsage,
} from './types.js';

// =============================================================================
// Git Operations
// =============================================================================

export {
  git,
  gitSafe,
  getGitDir,
  getGitCommonDir,
  getWorktreeRoot,
  isGitRepository,
  getSessionsDir,
  getHead,
  getShortHash,
  getCurrentBranch,
  refExists,
  getTreeHash,
  listBranches,
  hashObject,
  mktree,
  commitTree,
  lsTree,
  catFile,
  showFile,
  log,
  diffNameOnly,
  diffStat,
  hasUncommittedChanges,
  getUntrackedFiles,
  isOnDefaultBranch,
  pushBranch,
  getGitAuthor,
  resolveGitDirSync,
  atomicWriteFile,
  GitError,
  type GitAuthor,
  type GitExecOptions,
} from './git-operations.js';

// =============================================================================
// Session Store
// =============================================================================

export {
  createSessionStore,
  normalizeSessionState,
  type SessionStore,
} from './store/session-store.js';

// =============================================================================
// Checkpoint Store
// =============================================================================

export {
  createCheckpointStore,
  type CheckpointStore,
} from './store/checkpoint-store.js';

// =============================================================================
// Native Store (replaces CLI store)
// =============================================================================

export { createNativeEntireStore } from './store/native-store.js';

// =============================================================================
// Agent System
// =============================================================================

export type {
  Agent,
  HookSupport,
  FileWatcher,
  TranscriptAnalyzer,
  TokenCalculator,
  TranscriptChunker,
  SessionChangeEvent,
} from './agent/types.js';

export {
  hasHookSupport,
  hasFileWatcher,
  hasTranscriptAnalyzer,
  hasTokenCalculator,
  hasTranscriptChunker,
} from './agent/types.js';

export {
  registerAgent,
  getAgent,
  listAgentNames,
  listAgents,
  detectAgents,
  detectAgent,
  getAgentByType,
  getDefaultAgent,
  allProtectedDirs,
  resolveAgent,
  resetRegistry,
  type AgentFactory,
} from './agent/registry.js';

// Agent Implementations
export {
  createClaudeCodeAgent,
  parseTranscript,
  extractModifiedFiles,
  extractLastUserPrompt,
  type TranscriptLine,
  type AssistantContent,
} from './agent/agents/claude-code.js';

// =============================================================================
// Hooks
// =============================================================================

export {
  installGitHooks,
  uninstallGitHooks,
  areGitHooksInstalled,
  type GitHookName,
} from './hooks/git-hooks.js';

export {
  createLifecycleHandler,
  type LifecycleConfig,
  type LifecycleHandler,
} from './hooks/lifecycle.js';

// =============================================================================
// Security
// =============================================================================

export {
  shannonEntropy,
  detectSecrets,
  redactString,
  redactBuffer,
  redactJSONL,
} from './security/redaction.js';

// =============================================================================
// Configuration
// =============================================================================

export {
  loadSettings,
  loadProjectSettings,
  loadLocalSettings,
  saveProjectSettings,
  saveLocalSettings,
  isEnabled,
  getStrategy,
  ensureGitignore,
} from './config.js';

// =============================================================================
// Commands
// =============================================================================

export {
  enable,
  type EnableOptions,
  type EnableResult,
} from './commands/enable.js';

export {
  disable,
  type DisableOptions,
  type DisableResult,
} from './commands/disable.js';

export {
  status,
  formatStatusJSON,
  formatTokens,
  type StatusResult,
  type SessionStatus,
} from './commands/status.js';

export {
  listRewindPoints,
  rewindTo,
  listRewindPointsJSON,
  type RewindOptions,
  type RewindResult,
} from './commands/rewind.js';

export {
  diagnose,
  discardSession,
  doctor,
  type StuckSession,
  type DoctorResult,
  type DoctorOptions,
} from './commands/doctor.js';

export {
  findOrphaned,
  clean,
  type CleanupItem,
  type CleanResult,
  type CleanOptions,
} from './commands/clean.js';

export {
  reset,
  type ResetOptions,
  type ResetResult,
} from './commands/reset.js';
