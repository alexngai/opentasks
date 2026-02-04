/**
 * Execution History and Audit Trail for OpenTasks
 *
 * Tracks all operations for auditing and debugging.
 */

import type { OperationContext } from './coordination.js'

// ============================================================================
// Operation Log Types
// ============================================================================

/**
 * Types of operations that can be logged
 */
export type OperationType =
  | 'node.create'
  | 'node.update'
  | 'node.delete'
  | 'node.restore'
  | 'edge.create'
  | 'edge.delete'
  | 'claim.acquire'
  | 'claim.release'
  | 'claim.renew'
  | 'claim.expire'
  | 'feedback.create'
  | 'feedback.resolve'
  | 'feedback.dismiss'
  | 'feedback.reopen'
  | 'sync.materialize'
  | 'sync.refresh'
  | 'sync.conflict'

/**
 * A single change to a field
 */
export interface FieldChange {
  /** Field that was changed */
  field: string

  /** Value before the change */
  before: unknown

  /** Value after the change */
  after: unknown
}

/**
 * An entry in the operation log
 */
export interface OperationLogEntry {
  /** Unique ID for this log entry */
  id: string

  /** ISO timestamp when operation occurred */
  timestamp: string

  /** Type of operation */
  operation: OperationType

  /** Primary node affected */
  nodeId: string

  /** Secondary node (for edges: target node) */
  targetNodeId?: string

  /** Agent that performed the operation */
  agentId?: string

  /** Session context */
  sessionId?: string

  /** Field-level changes (for updates) */
  changes?: FieldChange[]

  /** Additional operation-specific data */
  data?: Record<string, unknown>

  /** Whether operation succeeded */
  success: boolean

  /** Error message if failed */
  error?: string
}

/**
 * Options for querying the operation log
 */
export interface OperationLogQueryOptions {
  /** Filter by node ID */
  nodeId?: string

  /** Filter by agent ID */
  agentId?: string

  /** Filter by session ID */
  sessionId?: string

  /** Filter by operation type(s) */
  operations?: OperationType[]

  /** Only successful operations */
  successOnly?: boolean

  /** Start time (inclusive) */
  since?: string

  /** End time (exclusive) */
  until?: string

  /** Maximum entries to return */
  limit?: number

  /** Offset for pagination */
  offset?: number

  /** Sort order */
  order?: 'asc' | 'desc'
}

/**
 * Summary of agent activity
 */
export interface AgentActivitySummary {
  /** Agent ID */
  agentId: string

  /** Time period start */
  since: string

  /** Time period end */
  until: string

  /** Total operations */
  totalOperations: number

  /** Operations by type */
  byType: Record<OperationType, number>

  /** Nodes created */
  nodesCreated: number

  /** Nodes updated */
  nodesUpdated: number

  /** Edges created */
  edgesCreated: number

  /** Claims acquired */
  claimsAcquired: number

  /** Feedback given */
  feedbackGiven: number

  /** Success rate (0-1) */
  successRate: number
}

// ============================================================================
// OperationLogger Interface
// ============================================================================

/**
 * Logs and queries operations for audit trail
 */
export interface OperationLogger {
  /**
   * Log an operation
   *
   * @param entry - Operation log entry (id and timestamp auto-generated if not provided)
   */
  log(entry: Omit<OperationLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): Promise<void>

  /**
   * Query the operation log
   *
   * @param options - Query options
   * @returns Matching log entries
   */
  query(options: OperationLogQueryOptions): Promise<OperationLogEntry[]>

  /**
   * Get history for a specific node
   *
   * @param nodeId - Node to get history for
   * @param options - Query options
   * @returns Log entries for this node
   */
  getNodeHistory(nodeId: string, options?: Omit<OperationLogQueryOptions, 'nodeId'>): Promise<OperationLogEntry[]>

  /**
   * Get activity for a specific agent
   *
   * @param agentId - Agent to get activity for
   * @param options - Query options
   * @returns Log entries for this agent
   */
  getAgentActivity(agentId: string, options?: Omit<OperationLogQueryOptions, 'agentId'>): Promise<OperationLogEntry[]>

  /**
   * Get activity summary for an agent
   *
   * @param agentId - Agent to summarize
   * @param since - Start of period
   * @param until - End of period (defaults to now)
   * @returns Activity summary
   */
  getAgentSummary(agentId: string, since: string, until?: string): Promise<AgentActivitySummary>

  /**
   * Get the most recent operations
   *
   * @param limit - Number of entries to return
   * @returns Recent log entries
   */
  getRecent(limit?: number): Promise<OperationLogEntry[]>

  /**
   * Clean up old log entries
   *
   * @param olderThan - ISO timestamp, entries before this will be deleted
   * @returns Number of entries deleted
   */
  cleanup(olderThan: string): Promise<number>

  /**
   * Get total count of log entries
   *
   * @param options - Filter options
   * @returns Count of matching entries
   */
  count(options?: OperationLogQueryOptions): Promise<number>
}

// ============================================================================
// In-Memory OperationLogger Implementation
// ============================================================================

/**
 * Create an in-memory operation logger (for testing or small-scale use)
 *
 * For production, use a SQLite-backed implementation.
 */
export function createInMemoryOperationLogger(): OperationLogger {
  const entries: OperationLogEntry[] = []
  let nextId = 1

  return {
    async log(entry): Promise<void> {
      const fullEntry: OperationLogEntry = {
        ...entry,
        id: entry.id ?? `log-${nextId++}`,
        timestamp: entry.timestamp ?? new Date().toISOString(),
      }
      entries.push(fullEntry)
    },

    async query(options: OperationLogQueryOptions): Promise<OperationLogEntry[]> {
      let result = [...entries]

      // Apply filters
      if (options.nodeId) {
        result = result.filter(e => e.nodeId === options.nodeId || e.targetNodeId === options.nodeId)
      }
      if (options.agentId) {
        result = result.filter(e => e.agentId === options.agentId)
      }
      if (options.sessionId) {
        result = result.filter(e => e.sessionId === options.sessionId)
      }
      if (options.operations) {
        result = result.filter(e => options.operations!.includes(e.operation))
      }
      if (options.successOnly) {
        result = result.filter(e => e.success)
      }
      if (options.since) {
        result = result.filter(e => e.timestamp >= options.since!)
      }
      if (options.until) {
        result = result.filter(e => e.timestamp < options.until!)
      }

      // Sort
      result.sort((a, b) => {
        const cmp = a.timestamp.localeCompare(b.timestamp)
        return options.order === 'asc' ? cmp : -cmp
      })

      // Pagination
      const offset = options.offset ?? 0
      const limit = options.limit ?? 100
      return result.slice(offset, offset + limit)
    },

    async getNodeHistory(nodeId: string, options?): Promise<OperationLogEntry[]> {
      return this.query({ ...options, nodeId })
    },

    async getAgentActivity(agentId: string, options?): Promise<OperationLogEntry[]> {
      return this.query({ ...options, agentId })
    },

    async getAgentSummary(agentId: string, since: string, until?: string): Promise<AgentActivitySummary> {
      const untilTime = until ?? new Date().toISOString()
      const activity = await this.query({ agentId, since, until: untilTime })

      const byType: Record<string, number> = {}
      let successful = 0

      for (const entry of activity) {
        byType[entry.operation] = (byType[entry.operation] ?? 0) + 1
        if (entry.success) successful++
      }

      return {
        agentId,
        since,
        until: untilTime,
        totalOperations: activity.length,
        byType: byType as Record<OperationType, number>,
        nodesCreated: byType['node.create'] ?? 0,
        nodesUpdated: byType['node.update'] ?? 0,
        edgesCreated: byType['edge.create'] ?? 0,
        claimsAcquired: byType['claim.acquire'] ?? 0,
        feedbackGiven: byType['feedback.create'] ?? 0,
        successRate: activity.length > 0 ? successful / activity.length : 1,
      }
    },

    async getRecent(limit = 50): Promise<OperationLogEntry[]> {
      return this.query({ limit, order: 'desc' })
    },

    async cleanup(olderThan: string): Promise<number> {
      const before = entries.length
      const cutoff = olderThan
      const remaining = entries.filter(e => e.timestamp >= cutoff)
      entries.length = 0
      entries.push(...remaining)
      return before - entries.length
    },

    async count(options?): Promise<number> {
      if (!options) return entries.length
      const result = await this.query({ ...options, limit: undefined, offset: undefined })
      return result.length
    },
  }
}

// ============================================================================
// Logging Helpers
// ============================================================================

/**
 * Create a log entry for a node operation
 */
export function createNodeLogEntry(
  operation: 'node.create' | 'node.update' | 'node.delete' | 'node.restore',
  nodeId: string,
  context?: OperationContext,
  changes?: FieldChange[],
  success = true,
  error?: string
): Omit<OperationLogEntry, 'id' | 'timestamp'> {
  return {
    operation,
    nodeId,
    agentId: context?.agentId,
    sessionId: context?.sessionId,
    changes,
    success,
    error,
  }
}

/**
 * Create a log entry for an edge operation
 */
export function createEdgeLogEntry(
  operation: 'edge.create' | 'edge.delete',
  fromId: string,
  toId: string,
  edgeType: string,
  context?: OperationContext,
  success = true,
  error?: string
): Omit<OperationLogEntry, 'id' | 'timestamp'> {
  return {
    operation,
    nodeId: fromId,
    targetNodeId: toId,
    agentId: context?.agentId,
    sessionId: context?.sessionId,
    data: { edgeType },
    success,
    error,
  }
}

/**
 * Create a log entry for a claim operation
 */
export function createClaimLogEntry(
  operation: 'claim.acquire' | 'claim.release' | 'claim.renew' | 'claim.expire',
  nodeId: string,
  agentId: string,
  context?: OperationContext,
  data?: Record<string, unknown>,
  success = true,
  error?: string
): Omit<OperationLogEntry, 'id' | 'timestamp'> {
  return {
    operation,
    nodeId,
    agentId,
    sessionId: context?.sessionId,
    data,
    success,
    error,
  }
}
