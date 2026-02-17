/**
 * Skill Tracker
 *
 * Tracks which agent skills (tools) are used during a session/trajectory.
 * Provides types and a tracker implementation for recording skill invocations,
 * aggregating usage statistics, and surfacing them in session metadata.
 *
 * This enables answering: "What skills did the agent use during this trajectory?"
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Names of trackable skills (the OpenTasks tool interface)
 */
export type SkillName = 'link' | 'query' | 'annotate' | 'task' | 'create' | 'get' | 'update' | 'delete' | string;

/**
 * A single skill invocation record
 */
export interface SkillInvocation {
  /** Which skill was invoked */
  skill: SkillName;

  /** ISO timestamp of invocation */
  timestamp: string;

  /** Whether the invocation succeeded */
  success: boolean;

  /** Duration in milliseconds (if available) */
  durationMs?: number;

  /** Sub-operation within the skill (e.g., query type: 'ready', 'blockers') */
  operation?: string;

  /** Node IDs or URIs involved */
  targets?: string[];

  /** Error message if failed */
  error?: string;

  /** Agent context at time of invocation */
  agentId?: string;

  /** Session context at time of invocation */
  sessionId?: string;
}

/**
 * Aggregated usage statistics for a single skill
 */
export interface SkillUsageStats {
  /** Skill name */
  skill: SkillName;

  /** Total invocation count */
  count: number;

  /** Number of successful invocations */
  successCount: number;

  /** Number of failed invocations */
  failureCount: number;

  /** First invocation timestamp */
  firstUsedAt: string;

  /** Last invocation timestamp */
  lastUsedAt: string;

  /** Average duration in milliseconds */
  avgDurationMs?: number;

  /** Distinct operations used (e.g., query types) */
  operations: string[];
}

/**
 * Complete skill usage summary for a session/trajectory
 */
export interface SkillUsageSummary {
  /** Session ID this summary belongs to */
  sessionId: string;

  /** Total invocations across all skills */
  totalInvocations: number;

  /** Distinct skills used */
  skillsUsed: SkillName[];

  /** Per-skill statistics */
  stats: SkillUsageStats[];

  /** Full invocation log (chronological) */
  invocations: SkillInvocation[];

  /** When tracking started */
  startedAt: string;

  /** When this summary was last updated */
  updatedAt: string;
}

/**
 * Options for creating a SkillTracker
 */
export interface SkillTrackerOptions {
  /** Session ID to associate with tracked invocations */
  sessionId: string;

  /** Agent ID performing the invocations */
  agentId?: string;

  /** Maximum invocations to retain in the log (default: 1000) */
  maxInvocations?: number;
}

/**
 * SkillTracker interface
 */
export interface SkillTracker {
  /** Record a skill invocation */
  record(invocation: Omit<SkillInvocation, 'timestamp' | 'agentId' | 'sessionId'>): void;

  /** Get the full invocation log */
  getInvocations(): SkillInvocation[];

  /** Get aggregated usage statistics */
  getStats(): SkillUsageStats[];

  /** Get a complete usage summary */
  getSummary(): SkillUsageSummary;

  /** Get invocations for a specific skill */
  getSkillInvocations(skill: SkillName): SkillInvocation[];

  /** Get the list of distinct skills used */
  getSkillsUsed(): SkillName[];

  /** Reset the tracker (clear all recorded invocations) */
  reset(): void;

  /** Session ID this tracker is associated with */
  readonly sessionId: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a SkillTracker for recording skill usage during a session
 */
export function createSkillTracker(options: SkillTrackerOptions): SkillTracker {
  const { sessionId, agentId, maxInvocations = 1000 } = options;
  let invocations: SkillInvocation[] = [];
  const startedAt = new Date().toISOString();

  return {
    get sessionId() {
      return sessionId;
    },

    record(partial) {
      const invocation: SkillInvocation = {
        ...partial,
        timestamp: new Date().toISOString(),
        agentId,
        sessionId,
      };

      invocations.push(invocation);

      // Trim if over limit (keep most recent)
      if (invocations.length > maxInvocations) {
        invocations = invocations.slice(-maxInvocations);
      }
    },

    getInvocations() {
      return [...invocations];
    },

    getSkillInvocations(skill: SkillName) {
      return invocations.filter((i) => i.skill === skill);
    },

    getSkillsUsed() {
      return [...new Set(invocations.map((i) => i.skill))];
    },

    getStats() {
      const bySkill = new Map<SkillName, SkillInvocation[]>();

      for (const inv of invocations) {
        const existing = bySkill.get(inv.skill) ?? [];
        existing.push(inv);
        bySkill.set(inv.skill, existing);
      }

      const stats: SkillUsageStats[] = [];

      for (const [skill, skillInvocations] of bySkill) {
        const successCount = skillInvocations.filter((i) => i.success).length;
        const failureCount = skillInvocations.length - successCount;

        const durations = skillInvocations
          .map((i) => i.durationMs)
          .filter((d): d is number => d !== undefined);

        const avgDurationMs =
          durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : undefined;

        const operations = [
          ...new Set(
            skillInvocations
              .map((i) => i.operation)
              .filter((op): op is string => op !== undefined),
          ),
        ];

        stats.push({
          skill,
          count: skillInvocations.length,
          successCount,
          failureCount,
          firstUsedAt: skillInvocations[0].timestamp,
          lastUsedAt: skillInvocations[skillInvocations.length - 1].timestamp,
          avgDurationMs,
          operations,
        });
      }

      return stats;
    },

    getSummary() {
      return {
        sessionId,
        totalInvocations: invocations.length,
        skillsUsed: this.getSkillsUsed(),
        stats: this.getStats(),
        invocations: this.getInvocations(),
        startedAt,
        updatedAt: new Date().toISOString(),
      };
    },

    reset() {
      invocations = [];
    },
  };
}

// ============================================================================
// Session Tracker Registry
// ============================================================================

/**
 * Registry for managing SkillTrackers across concurrent sessions.
 * The daemon maintains one registry, with one tracker per active session.
 */
export interface SkillTrackerRegistry {
  /** Get or create a tracker for a session */
  getOrCreate(sessionId: string, agentId?: string): SkillTracker;

  /** Get an existing tracker (returns null if not found) */
  get(sessionId: string): SkillTracker | null;

  /** Remove a tracker when session ends */
  remove(sessionId: string): SkillUsageSummary | null;

  /** Get summaries for all active sessions */
  getAllSummaries(): SkillUsageSummary[];

  /** Get the number of active trackers */
  readonly size: number;
}

/**
 * Create a SkillTrackerRegistry for managing per-session trackers
 */
export function createSkillTrackerRegistry(): SkillTrackerRegistry {
  const trackers = new Map<string, SkillTracker>();

  return {
    get size() {
      return trackers.size;
    },

    getOrCreate(sessionId: string, agentId?: string) {
      let tracker = trackers.get(sessionId);
      if (!tracker) {
        tracker = createSkillTracker({ sessionId, agentId });
        trackers.set(sessionId, tracker);
      }
      return tracker;
    },

    get(sessionId: string) {
      return trackers.get(sessionId) ?? null;
    },

    remove(sessionId: string) {
      const tracker = trackers.get(sessionId);
      if (!tracker) return null;

      const summary = tracker.getSummary();
      trackers.delete(sessionId);
      return summary;
    },

    getAllSummaries() {
      return Array.from(trackers.values()).map((t) => t.getSummary());
    },
  };
}
