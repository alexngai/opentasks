/**
 * Tool Types
 *
 * Parameter and result types for the 3-tool agent interface.
 */

import type { Node, Edge, EdgeType, NodeType } from '../schema/index.js'
import type {
  NodeFilter,
  EdgeFilter,
  ReadyOptions,
  BlockerOptions,
  FeedbackOptions,
} from '../graph/types.js'
import type { OperationContext } from '../graph/coordination.js'

// Re-export for convenience
export type { EdgeType, NodeType, Node, Edge }
export type { NodeFilter, EdgeFilter, ReadyOptions, BlockerOptions, FeedbackOptions }
export type { OperationContext }

// ============================================================================
// Link Tool Types
// ============================================================================

/**
 * Parameters for the link tool
 */
export interface LinkParams {
  /** Source node ID or provider URI */
  fromId: string

  /** Target node ID or provider URI */
  toId: string

  /** Relationship type */
  type: EdgeType

  /** Remove the edge instead of creating (default: false) */
  remove?: boolean

  /** Additional metadata for the edge */
  metadata?: Record<string, unknown>
}

/**
 * Result from the link tool
 */
export interface LinkResult {
  /** Whether the operation succeeded */
  success: boolean

  /** ID of the created edge (only when creating) */
  edgeId?: string

  /** Error message if operation failed */
  error?: string
}

// ============================================================================
// Query Tool Types
// ============================================================================

/**
 * Parameters for querying blockers/blocking nodes
 */
export interface BlockerQueryParams {
  /** Node ID to find blockers for */
  nodeId: string

  /** Include transitive blockers (default: false) */
  transitive?: boolean

  /** Only include active (non-closed, non-archived) blockers (default: true) */
  activeOnly?: boolean
}

/**
 * Parameters for querying feedback
 */
export interface FeedbackQueryParams {
  /** Node ID to get feedback for */
  nodeId: string

  /** Filter by feedback type */
  type?: 'comment' | 'suggestion' | 'request'

  /** Filter by resolution status */
  resolved?: boolean

  /** Include dismissed feedback (default: false) */
  includeDismissed?: boolean
}

/**
 * Parameters for querying unresolved feedback globally
 */
export interface UnresolvedFeedbackQueryParams {
  /** Optional target node ID to filter by */
  targetId?: string
}

/**
 * Parameters for querying tasks that implement a context
 */
export interface TasksQueryParams {
  /** Context ID to find tasks for */
  contextId: string
}

/**
 * Parameters for querying context nodes a task implements
 */
export interface ContextQueryParams {
  /** Task ID to find context for */
  taskId: string
}

/**
 * Parameters for the query tool
 *
 * Exactly one query type must be specified.
 */
export interface QueryParams {
  /** Query nodes with filter */
  nodes?: NodeFilter

  /** Query edges with filter */
  edges?: EdgeFilter

  /** Get unblocked tasks ready to work on */
  ready?: ReadyOptions

  /** Get nodes blocking a specific node */
  blockers?: BlockerQueryParams

  /** Get nodes blocked by a specific node */
  blocking?: BlockerQueryParams

  /** Get feedback on a specific node */
  feedback?: FeedbackQueryParams

  /** Get all unresolved feedback (optionally filtered by target) */
  unresolvedFeedback?: UnresolvedFeedbackQueryParams

  /** Get tasks that implement a context */
  tasks?: TasksQueryParams

  /** Get context nodes that a task implements */
  context?: ContextQueryParams

  /** Return full objects instead of summaries (default: false) */
  verbose?: boolean

  /** Maximum results to return (default: 50) */
  limit?: number

  /** Pagination offset (default: 0) */
  offset?: number
}

/**
 * Reduced node representation for context economy
 */
export interface NodeSummary {
  /** Node ID */
  id: string

  /** Node type */
  type: NodeType

  /** Node title */
  title: string

  /** Task status (only for tasks) */
  status?: string

  /** Priority (0=highest, 4=lowest) */
  priority?: number

  /** Whether the node is archived */
  archived: boolean
}

/**
 * Reduced edge representation for context economy
 */
export interface EdgeSummary {
  /** Edge ID */
  id: string

  /** Source node ID */
  fromId: string

  /** Target node ID */
  toId: string

  /** Relationship type */
  type: EdgeType
}

/**
 * Reduced feedback representation for context economy
 */
export interface FeedbackSummary {
  /** Feedback ID */
  id: string

  /** Target node ID */
  targetId: string

  /** Feedback type */
  feedbackType: 'comment' | 'suggestion' | 'request'

  /** Whether resolved */
  resolved: boolean

  /** Whether dismissed */
  dismissed: boolean

  /** Content preview (truncated) */
  contentPreview: string
}

/**
 * Result from the query tool
 */
export interface QueryResult {
  /** Query results (type depends on query and verbose flag) */
  items: NodeSummary[] | EdgeSummary[] | FeedbackSummary[] | Node[] | Edge[]

  /** Total count if available */
  total?: number

  /** Whether more results exist beyond limit */
  hasMore: boolean
}

// ============================================================================
// Annotate Tool Types
// ============================================================================

/**
 * Feedback type
 */
export type FeedbackType = 'comment' | 'suggestion' | 'request'

/**
 * Anchor for feedback positioning
 */
export interface FeedbackAnchor {
  /** Line number in target content */
  line?: number

  /** Text snippet to anchor to */
  text?: string
}

/**
 * Parameters for creating new feedback
 */
export interface CreateFeedbackParams {
  /** Feedback content (markdown) */
  content: string

  /** Feedback type (default: comment) */
  type?: FeedbackType

  /** Anchor in target content */
  anchor?: FeedbackAnchor
}

/**
 * Parameters for the annotate tool
 *
 * Exactly one operation must be specified.
 */
export interface AnnotateParams {
  /** Target node ID receiving annotation */
  targetId: string

  /** Create new feedback */
  create?: CreateFeedbackParams

  /** Resolve feedback by ID */
  resolve?: string

  /** Dismiss feedback by ID */
  dismiss?: string

  /** Reopen resolved/dismissed feedback by ID */
  reopen?: string

  /** Task ID providing feedback (creates link) */
  fromId?: string
}

/**
 * Result from the annotate tool
 */
export interface AnnotateResult {
  /** Whether the operation succeeded */
  success: boolean

  /** ID of created/modified feedback */
  feedbackId?: string

  /** Error message if operation failed */
  error?: string
}

// ============================================================================
// Task Tool Types
// ============================================================================

/**
 * Semantic task actions
 */
export type { TaskAction } from '../providers/traits/TaskManageable.js'

/**
 * Parameters for the task tool
 *
 * Exactly one operation must be specified.
 */
export interface TaskParams {
  /** Transition a task's status using a semantic action */
  transition?: {
    /** Task ID or provider URI */
    id: string
    /** Semantic action: 'start' | 'complete' | 'block' | 'reopen' | 'close' */
    action: 'start' | 'complete' | 'block' | 'reopen' | 'close'
  }

  /** Get tasks that are ready to work on (no active blockers) */
  ready?: {
    /** Only query these providers (by name). If omitted, queries all task-capable providers. */
    providers?: string[]
    /** Maximum results to return */
    limit?: number
    /** Filter by tags */
    tags?: string[]
    /** Filter by minimum priority */
    priority?: number
    /** Filter by assignee */
    assignee?: string
  }

  /** Assign a task to an owner */
  assign?: {
    /** Task ID or provider URI */
    id: string
    /** Assignee identifier */
    assignee: string
  }

  /** Get valid next actions for a task in its current state */
  validActions?: {
    /** Task ID or provider URI */
    id: string
  }

  /** Return full objects instead of summaries (default: false) */
  verbose?: boolean
}

/**
 * Result from the task tool
 */
export interface TaskResult {
  /** Whether the operation succeeded */
  success: boolean

  /** Result data (shape depends on operation) */
  data?: TaskTransitionData | TaskReadyData | TaskAssignData | TaskValidActionsData

  /** Error message if operation failed */
  error?: string
}

/**
 * Result data for a transition operation
 */
export interface TaskTransitionData {
  type: 'transition'
  /** The updated node summary */
  node: NodeSummary
  /** Which provider handled the transition */
  provider: string
  /** The action that was applied */
  action: string
}

/**
 * Result data for a ready query
 */
export interface TaskReadyData {
  type: 'ready'
  /** Ready task summaries */
  items: NodeSummary[]
  /** Total count */
  total: number
}

/**
 * Result data for an assign operation
 */
export interface TaskAssignData {
  type: 'assign'
  /** The updated node summary */
  node: NodeSummary
  /** Which provider handled the assignment */
  provider: string
}

/**
 * Result data for a validActions query
 */
export interface TaskValidActionsData {
  type: 'validActions'
  /** Valid actions for the task's current state */
  actions: string[]
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Error codes for tool operations
 */
export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_PARAMS'
  | 'CYCLE_DETECTED'
  | 'OPERATION_FAILED'

/**
 * Tool operation error
 */
export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ToolError'
  }
}
