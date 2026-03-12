/**
 * Entire Provider Types
 *
 * These types define the public interface for accessing Entire session
 * and checkpoint data. They are the contract between the Entire module
 * and external consumers (providers, daemon, etc.).
 *
 * This file is the canonical source of truth — external code should
 * import these types from the entire package rather than redefining them.
 */

// ============================================================================
// Session
// ============================================================================

/**
 * Entire session state (from .git/entire-sessions/<id>.json)
 */
export interface EntireSession {
  id: string;
  agent: string;
  phase: 'ACTIVE' | 'IDLE' | 'ENDED';
  baseCommit?: string;
  branch?: string;
  startedAt?: string;
  endedAt?: string;
  checkpoints?: string[];
  tokenUsage?: SessionlogTokenUsage;
  filesTouched?: string[];
  summary?: string;

  /** Skills used during this session (populated by SkillTracker) */
  skillsUsed?: SessionlogSkillUsage;
}

/**
 * Skill usage data embedded in session metadata
 */
export interface SessionlogSkillUsage {
  /** Distinct skill names used */
  skills: string[];

  /** Total invocation count across all skills */
  totalInvocations: number;

  /** Per-skill invocation counts */
  counts: Record<string, number>;

  /** Per-skill success/failure counts */
  outcomes: Record<string, { success: number; failure: number }>;
}

// ============================================================================
// Checkpoint
// ============================================================================

/**
 * Entire checkpoint metadata
 */
export interface SessionlogCheckpoint {
  id: string;
  sessionId?: string;
  commitHash?: string;
  commitMessage?: string;
  promptCount?: number;
  filesModified?: string[];
  filesNew?: string[];
  filesDeleted?: string[];
  tokenUsage?: SessionlogTokenUsage;
  context?: string;
}

// ============================================================================
// Token Usage
// ============================================================================

/**
 * Token usage statistics (provider-facing, simplified)
 */
export interface SessionlogTokenUsage {
  input?: number;
  output?: number;
  cache?: number;
}

// ============================================================================
// Store Interface
// ============================================================================

/**
 * Interface for accessing Entire data (CLI or direct reads)
 */
export interface SessionlogStore {
  getSession(id: string): Promise<EntireSession | null>;
  listSessions(): Promise<EntireSession[]>;
  getCheckpoint(id: string): Promise<SessionlogCheckpoint | null>;
  listCheckpoints(): Promise<SessionlogCheckpoint[]>;
  search(query: string): Promise<Array<EntireSession | SessionlogCheckpoint>>;
}
