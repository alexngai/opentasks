/**
 * Storage interface for OpenTasks
 *
 * Domain-driven storage interface following beads pattern.
 * Defines operations for nodes, edges, tags, and queries.
 */

import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { EdgeType } from '../schema/edges.js'

/**
 * Filter criteria for querying nodes
 */
export interface NodeFilter {
  /** Filter by node type (single or multiple) */
  type?: string | string[]

  /** Filter by status (single or multiple) */
  status?: string | string[]

  /** Filter by tags (AND semantics - must have all) */
  tags?: string[]

  /** Filter by parent node */
  parent_id?: string

  /** Filter by archived status */
  archived?: boolean

  /** Full-text search in title and content */
  search?: string

  /** Maximum number of results */
  limit?: number

  /** Offset for pagination */
  offset?: number
}

/**
 * Transaction interface for atomic operations
 *
 * Includes both read and write methods that work within a transaction context.
 * Reads within a transaction see uncommitted writes from the same transaction.
 */
export interface Transaction {
  // === Read Operations (transaction-isolated) ===

  /** Get a node by ID within transaction */
  getNode(id: string): Promise<StoredNode | null>

  /** Get an edge by ID within transaction */
  getEdge(id: string): Promise<StoredEdge | null>

  /** Get all tags for a node within transaction */
  getTags(nodeId: string): Promise<string[]>

  /** Get all edges from a node within transaction */
  getEdgesFrom(nodeId: string, type?: EdgeType): Promise<StoredEdge[]>

  // === Write Operations ===

  /** Create a new node within transaction */
  createNode(node: StoredNode, actor?: string): Promise<void>

  /** Update an existing node within transaction */
  updateNode(
    id: string,
    updates: Partial<StoredNode>,
    actor?: string
  ): Promise<void>

  /** Create a new edge within transaction */
  createEdge(edge: StoredEdge, actor?: string): Promise<void>

  /** Delete an edge within transaction */
  deleteEdge(id: string, actor?: string): Promise<void>

  /** Add a tag to a node within transaction */
  addTag(nodeId: string, tag: string, actor?: string): Promise<void>

  /** Remove a tag from a node within transaction */
  removeTag(nodeId: string, tag: string, actor?: string): Promise<void>
}

/**
 * Core storage interface for OpenTasks
 *
 * Provides domain-driven operations for nodes, edges, tags, and queries.
 * Implementations: SQLitePersister (primary), JSONLPersister (for import/export)
 */
export interface Storage {
  // === Node Operations ===

  /**
   * Create a new node
   * @param node - The node to create (must include id, uuid, type, title)
   * @param actor - Optional actor identifier for audit trail
   */
  createNode(node: StoredNode, actor?: string): Promise<void>

  /**
   * Get a node by ID
   * @param id - The node ID (e.g., "s-a2b3")
   * @returns The node or null if not found
   */
  getNode(id: string): Promise<StoredNode | null>

  /**
   * Update an existing node
   * @param id - The node ID to update
   * @param updates - Partial node with fields to update
   * @param actor - Optional actor identifier for audit trail
   */
  updateNode(
    id: string,
    updates: Partial<StoredNode>,
    actor?: string
  ): Promise<void>

  /**
   * Delete a node
   * @param id - The node ID to delete
   * @param actor - Optional actor identifier for audit trail
   */
  deleteNode(id: string, actor?: string): Promise<void>

  /**
   * Query nodes with filtering
   * @param filter - Filter criteria
   * @returns Matching nodes
   */
  queryNodes(filter: NodeFilter): Promise<StoredNode[]>

  // === Edge Operations ===

  /**
   * Create a new edge
   * @param edge - The edge to create
   * @param actor - Optional actor identifier for audit trail
   */
  createEdge(edge: StoredEdge, actor?: string): Promise<void>

  /**
   * Get an edge by ID
   * @param id - The edge ID (e.g., "x-r8s9")
   * @returns The edge or null if not found
   */
  getEdge(id: string): Promise<StoredEdge | null>

  /**
   * Delete an edge
   * @param id - The edge ID to delete
   * @param actor - Optional actor identifier for audit trail
   */
  deleteEdge(id: string, actor?: string): Promise<void>

  /**
   * Get all edges from a node
   * @param nodeId - The source node ID
   * @param type - Optional edge type filter
   * @returns Edges where from_id matches
   */
  getEdgesFrom(nodeId: string, type?: EdgeType): Promise<StoredEdge[]>

  /**
   * Get all edges to a node
   * @param nodeId - The target node ID
   * @param type - Optional edge type filter
   * @returns Edges where to_id matches
   */
  getEdgesTo(nodeId: string, type?: EdgeType): Promise<StoredEdge[]>

  // === Tag Operations (join table) ===

  /**
   * Add a tag to a node
   * @param nodeId - The node ID
   * @param tag - The tag to add
   * @param actor - Optional actor identifier for audit trail
   */
  addTag(nodeId: string, tag: string, actor?: string): Promise<void>

  /**
   * Remove a tag from a node
   * @param nodeId - The node ID
   * @param tag - The tag to remove
   * @param actor - Optional actor identifier for audit trail
   */
  removeTag(nodeId: string, tag: string, actor?: string): Promise<void>

  /**
   * Get all tags for a node
   * @param nodeId - The node ID
   * @returns Array of tag strings
   */
  getTags(nodeId: string): Promise<string[]>

  /**
   * Get tags for multiple nodes (batch operation)
   * @param nodeIds - Array of node IDs
   * @returns Map of node ID to tags array
   */
  getTagsForNodes(nodeIds: string[]): Promise<Map<string, string[]>>

  /**
   * Get all nodes with a specific tag
   * @param tag - The tag to search for
   * @returns Nodes that have this tag
   */
  getNodesByTag(tag: string): Promise<StoredNode[]>

  // === Queries ===

  /**
   * Get tasks that are ready to work on (no active blockers)
   *
   * A task is ready if:
   * - type = 'task'
   * - status = 'open'
   * - not archived
   * - no blocking tasks that are not closed
   *
   * @returns Ready tasks
   */
  getReady(): Promise<StoredNode[]>

  // === Transactions ===

  /**
   * Execute a function within a transaction
   *
   * If the function throws, the transaction is rolled back.
   * If the function completes, the transaction is committed.
   *
   * @param fn - Function to execute within transaction
   * @returns The result of the function
   */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>

  // === Dirty Tracking ===

  /**
   * Mark a node as dirty (changed, needs export)
   * @param nodeId - The node ID to mark
   */
  markDirty(nodeId: string): Promise<void>

  /**
   * Get all dirty node IDs
   * @returns Array of node IDs that have been modified
   */
  getDirtyNodes(): Promise<string[]>

  /**
   * Clear dirty status for nodes (after export)
   * @param nodeIds - Node IDs to clear
   */
  clearDirty(nodeIds: string[]): Promise<void>

  // === Lifecycle ===

  /**
   * Close the storage connection and release resources
   */
  close(): Promise<void>
}

/**
 * Configuration for node filter with defaults applied
 */
export interface ResolvedNodeFilter {
  type: string[] | null
  status: string[] | null
  tags: string[] | null
  parent_id: string | null
  archived: boolean | null
  search: string | null
  limit: number
  offset: number
}

/**
 * Resolve a NodeFilter to have consistent types and defaults
 */
export function resolveNodeFilter(filter: NodeFilter): ResolvedNodeFilter {
  return {
    type: filter.type
      ? Array.isArray(filter.type)
        ? filter.type
        : [filter.type]
      : null,
    status: filter.status
      ? Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      : null,
    tags: filter.tags || null,
    parent_id: filter.parent_id || null,
    archived: filter.archived ?? null,
    search: filter.search || null,
    limit: filter.limit || 100,
    offset: filter.offset || 0,
  }
}
