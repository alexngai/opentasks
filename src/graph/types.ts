/**
 * Graph Layer Types
 *
 * Input/output types for graph operations, filters, and configuration.
 */

import type { Anchor, EdgeType } from '../schema/index.js';

// Re-export for convenience
export type { EdgeType, Anchor } from '../schema/index.js';

// ============================================================================
// Node Types
// ============================================================================

/** Valid node types */
export type NodeType = 'context' | 'task' | 'feedback' | 'external';

// ============================================================================
// Node Input Types
// ============================================================================

/**
 * Input for creating a new node
 */
export interface CreateNodeInput {
  /** Node type */
  type: NodeType;

  /** Human-readable title */
  title: string;

  /** Markdown content */
  content?: string;

  /** Priority (0=highest, 4=lowest) */
  priority?: number;

  /** Tags for categorization */
  tags?: string[];

  /** Parent node ID for hierarchy */
  parent_id?: string;

  // === Task-specific ===

  /** Workflow status (required for tasks) */
  status?: string;

  /** Assigned user/agent */
  assignee?: string;

  // === Feedback-specific ===

  /** Target node ID (required for feedback) */
  target_id?: string;

  /** Anchor location in target content */
  target_anchor?: Anchor;

  /** Feedback type (required for feedback) */
  feedback_type?: 'comment' | 'suggestion' | 'request';

  /** Thread ID for grouping related feedback */
  thread_id?: string;

  /** Parent feedback ID for replies */
  reply_to_id?: string;

  // === External-specific ===

  /** External URI (required for external nodes) */
  uri?: string;

  /** Source system identifier (required for external nodes) */
  source?: string;

  /** Whether this external node has been materialized from a provider */
  materialized?: boolean;

  /** Status from external system (their semantics, not ours) */
  external_status?: string;

  /** Raw data from external system */
  external_data?: Record<string, unknown>;

  /** When data was last fetched (ISO 8601) */
  cached_at?: string;

  // === Extensibility ===

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating an existing node
 */
export interface UpdateNodeInput {
  /** Update title */
  title?: string;

  /** Update content */
  content?: string;

  /** Update priority */
  priority?: number;

  /** Update status (tasks) */
  status?: string;

  /** Update assignee (tasks) */
  assignee?: string;

  /** Update parent */
  parent_id?: string | null;

  /** Archive/unarchive */
  archived?: boolean;

  /** Mark feedback as resolved */
  resolved?: boolean;

  /** Mark feedback as dismissed */
  dismissed?: boolean;

  /** Whether cached data is known to be stale */
  stale?: boolean;

  /** Whether this external node has been materialized */
  materialized?: boolean;

  /** Status from external system */
  external_status?: string;

  /** Raw data from external system */
  external_data?: Record<string, unknown>;

  /** When data was last fetched (ISO 8601) */
  cached_at?: string;

  /** Update metadata (merged with existing) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for deleting a node
 */
export interface DeleteOptions {
  /**
   * Hard delete (permanent removal)
   * Default: false (soft delete/archive)
   */
  hard?: boolean;
}

// ============================================================================
// Edge Input Types
// ============================================================================

/**
 * Input for creating a new edge
 */
export interface CreateEdgeInput {
  /** Source node ID */
  from_id: string;

  /** Target node ID */
  to_id: string;

  /** Relationship type */
  type: EdgeType;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Priority filter - single value or range
 */
export type PriorityFilter = number | { min?: number; max?: number };

/**
 * Filter for querying nodes
 */
export interface NodeFilter {
  /** Filter by type(s) */
  type?: NodeType | NodeType[];

  /** Filter by status(es) */
  status?: string | string[];

  /** Filter by tags (AND semantics - all tags must match) */
  tags?: string[];

  /** Filter by parent node */
  parent_id?: string;

  /**
   * Filter by archived status
   * - true: only archived
   * - false: only non-archived
   * - null/undefined: include all
   */
  archived?: boolean | null;

  /** Text search in title and content */
  search?: string;

  /** Filter by priority (single value or range) */
  priority?: PriorityFilter;

  /** Filter by assignee */
  assignee?: string;

  /** Maximum results to return (default: 100) */
  limit?: number;

  /** Offset for pagination (default: 0) */
  offset?: number;

  /** Sort field */
  orderBy?: 'created_at' | 'updated_at' | 'priority' | 'title';

  /** Sort direction (default: 'desc' for dates, 'asc' for others) */
  orderDirection?: 'asc' | 'desc';
}

/**
 * Filter for querying edges
 */
export interface EdgeFilter {
  /** Filter by relationship type(s) */
  type?: EdgeType | EdgeType[];

  /** Filter by source node */
  from_id?: string;

  /** Filter by target node */
  to_id?: string;

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

// ============================================================================
// Query Option Types
// ============================================================================

/**
 * Options for blocker/blocking queries
 */
export interface BlockerOptions {
  /**
   * Include transitive blockers (blockers of blockers)
   * Default: false
   */
  transitive?: boolean;

  /**
   * Only include active (non-closed, non-archived) blockers
   * Default: true
   */
  activeOnly?: boolean;

  /**
   * Maximum depth for transitive queries
   * Default: 10
   */
  maxDepth?: number;
}

/**
 * Options for ready query
 */
export interface ReadyOptions {
  /** Filter by tags */
  tags?: string[];

  /** Filter by priority */
  priority?: PriorityFilter;

  /** Filter by assignee */
  assignee?: string;

  /** Maximum results to return */
  limit?: number;
}

/**
 * Options for feedback queries
 */
export interface FeedbackOptions {
  /** Filter by feedback type */
  type?: 'comment' | 'suggestion' | 'request';

  /**
   * Filter by resolution status
   * - true: only resolved
   * - false: only unresolved
   * - undefined: include all
   */
  resolved?: boolean;

  /**
   * Include dismissed feedback
   * Default: false
   */
  includeDismissed?: boolean;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result of validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;

  /** Validation errors (blocking) */
  errors: ValidationError[];

  /** Validation warnings (non-blocking) */
  warnings: ValidationWarning[];
}

/**
 * Validation error (blocks operation)
 */
export interface ValidationError {
  /** Error code for programmatic handling */
  code: string;

  /** Field that failed validation (if applicable) */
  field?: string;

  /** Human-readable error message */
  message: string;
}

/**
 * Validation warning (non-blocking)
 */
export interface ValidationWarning {
  /** Warning code for programmatic handling */
  code: string;

  /** Field with warning (if applicable) */
  field?: string;

  /** Human-readable warning message */
  message: string;
}

/**
 * Result of cycle detection
 */
export interface CycleResult {
  /** Whether a cycle would be created */
  hasCycle: boolean;

  /** The cycle path if detected (node IDs) */
  cycle?: string[];
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for flush behavior
 */
export interface FlushConfig {
  /**
   * Debounce delay in milliseconds
   * Default: 5000 (5 seconds)
   */
  debounceMs?: number;

  /**
   * Maximum delay before forced flush
   * Default: 30000 (30 seconds)
   */
  maxDelayMs?: number;
}

/**
 * Configuration for GraphStore
 */
export interface GraphStoreConfig {
  /**
   * Base path for .opentasks directory
   * e.g., "/path/to/project/.opentasks"
   */
  basePath: string;

  /**
   * Auto-initialize if directory doesn't exist
   * Default: true
   */
  autoInit?: boolean;

  /**
   * Flush configuration
   */
  flush?: FlushConfig;
}

// ============================================================================
// Error Types
// ============================================================================

/** Error codes for graph operations */
export type GraphErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'VALIDATION_ERROR'
  | 'CYCLE_DETECTED'
  | 'INVALID_OPERATION'
  | 'STORAGE_ERROR';

/**
 * Graph operation error
 */
export class GraphError extends Error {
  constructor(
    public readonly code: GraphErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}
