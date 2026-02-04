/**
 * Graph Store
 *
 * Unified API coordinating JSONL and SQLite persisters.
 * Provides CRUD operations with validation and debounced persistence.
 */

import type { Storage } from '../storage/interface.js'
import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { Node, Edge } from '../schema/index.js'
import { parseNode } from '../schema/validation.js'
import { generateId } from '../core/id.js'
import type {
  CreateNodeInput,
  UpdateNodeInput,
  DeleteOptions,
  CreateEdgeInput,
  GraphStoreConfig,
  GraphErrorCode,
} from './types.js'
import { GraphError } from './types.js'
import type { ValidationService } from './validation.js'
import { createValidationService } from './validation.js'
import type { QueryEngine } from './query.js'
import { createQueryEngine } from './query.js'
import type { SyncManager, SyncConfig } from './sync.js'
import { createSyncManager, DEFAULT_SYNC_CONFIG } from './sync.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Transaction interface for atomic operations
 */
export interface GraphTransaction {
  createNode(input: CreateNodeInput): Promise<Node>
  updateNode(id: string, updates: UpdateNodeInput): Promise<Node>
  deleteNode(id: string): Promise<void>
  createEdge(input: CreateEdgeInput): Promise<Edge>
  deleteEdge(id: string): Promise<void>
}

/**
 * Graph store interface
 */
export interface GraphStore {
  // === Lifecycle ===

  /** Initialize the store (load from JSONL, sync to SQLite) */
  initialize(): Promise<void>

  /** Close the store (flush pending changes) */
  close(): Promise<void>

  /** Force immediate flush to JSONL */
  flush(): Promise<void>

  // === Node Operations ===

  /** Create a new node */
  createNode(input: CreateNodeInput): Promise<Node>

  /** Get a node by ID */
  getNode(id: string): Promise<Node | null>

  /** Update an existing node */
  updateNode(id: string, updates: UpdateNodeInput): Promise<Node>

  /** Delete a node (soft delete by default) */
  deleteNode(id: string, options?: DeleteOptions): Promise<void>

  /** Restore an archived node */
  restoreNode(id: string): Promise<Node>

  // === Edge Operations ===

  /** Create a new edge */
  createEdge(input: CreateEdgeInput): Promise<Edge>

  /** Get an edge by ID */
  getEdge(id: string): Promise<Edge | null>

  /** Delete an edge */
  deleteEdge(id: string): Promise<void>

  // === Tag Operations ===

  /** Add tags to a node */
  addTags(nodeId: string, tags: string[]): Promise<void>

  /** Remove tags from a node */
  removeTags(nodeId: string, tags: string[]): Promise<void>

  /** Set tags for a node (replaces existing) */
  setTags(nodeId: string, tags: string[]): Promise<void>

  // === Query ===

  /** Query engine for graph traversal */
  readonly query: QueryEngine

  // === Transactions ===

  /** Execute operations in a transaction */
  transaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T>
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get current ISO timestamp
 */
function now(): string {
  return new Date().toISOString()
}

/**
 * Build a StoredNode from CreateNodeInput
 */
function buildStoredNode(input: CreateNodeInput, id: string, uuid: string): StoredNode {
  const timestamp = now()

  const base: StoredNode = {
    id,
    uuid,
    type: input.type,
    title: input.title,
    content: input.content,
    priority: input.priority,
    parent_id: input.parent_id,
    created_at: timestamp,
    updated_at: timestamp,
    archived: false,
  }

  // Type-specific fields
  switch (input.type) {
    case 'issue':
      return {
        ...base,
        status: input.status || 'open',
        assignee: input.assignee,
      }
    case 'feedback':
      return {
        ...base,
        target_id: input.target_id,
        target_anchor: input.target_anchor,
        feedback_type: input.feedback_type,
        thread_id: input.thread_id,
        reply_to_id: input.reply_to_id,
        resolved: false,
        dismissed: false,
      }
    case 'external':
      return {
        ...base,
        uri: input.uri,
        source: input.source,
      }
    default:
      return base
  }
}

/**
 * Apply updates to a StoredNode
 */
function applyUpdates(node: StoredNode, updates: UpdateNodeInput): Partial<StoredNode> {
  const changes: Partial<StoredNode> = {
    updated_at: now(),
  }

  if (updates.title !== undefined) changes.title = updates.title
  if (updates.content !== undefined) changes.content = updates.content
  if (updates.priority !== undefined) changes.priority = updates.priority
  if (updates.status !== undefined) changes.status = updates.status
  if (updates.assignee !== undefined) changes.assignee = updates.assignee
  if (updates.parent_id !== undefined) changes.parent_id = updates.parent_id ?? undefined
  if (updates.archived !== undefined) {
    changes.archived = updates.archived
    if (updates.archived) {
      changes.archived_at = now()
    } else {
      changes.archived_at = undefined
    }
  }
  if (updates.resolved !== undefined) changes.resolved = updates.resolved
  if (updates.dismissed !== undefined) changes.dismissed = updates.dismissed

  return changes
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a graph store
 *
 * @param config - Store configuration
 * @param storage - Storage implementation (SQLite persister)
 * @param jsonlLoad - Function to load from JSONL
 * @param jsonlSave - Function to save to JSONL
 */
export function createGraphStore(
  config: GraphStoreConfig,
  storage: Storage,
  jsonlLoad: () => Promise<{ nodes: StoredNode[]; edges: StoredEdge[] }>,
  jsonlSave: (nodes: StoredNode[], edges: StoredEdge[]) => Promise<void>
): GraphStore {
  const validation: ValidationService = createValidationService()
  const queryEngine: QueryEngine = createQueryEngine(storage)

  // Sync configuration
  const syncConfig: SyncConfig = {
    debounceMs: config.flush?.debounceMs ?? DEFAULT_SYNC_CONFIG.debounceMs,
    maxDelayMs: config.flush?.maxDelayMs ?? DEFAULT_SYNC_CONFIG.maxDelayMs,
  }

  // Flush callback
  async function doFlush(): Promise<void> {
    // Get dirty node IDs
    const dirtyIds = await storage.getDirtyNodes()
    if (dirtyIds.length === 0) return

    // Load current JSONL
    const { nodes, edges } = await jsonlLoad()

    // Build maps for efficient lookup
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))
    const edgeMap = new Map(edges.map((e) => [e.id, e]))

    // For each dirty node, get current state from SQLite
    for (const id of dirtyIds) {
      const current = await storage.getNode(id)
      if (current) {
        // Get tags and add to node
        const tags = await storage.getTags(id)
        nodeMap.set(id, { ...current, tags })
      } else {
        nodeMap.delete(id) // Was deleted
      }
    }

    // Also sync edges (get all edges for dirty nodes)
    for (const id of dirtyIds) {
      const fromEdges = await storage.getEdgesFrom(id)
      const toEdges = await storage.getEdgesTo(id)
      for (const edge of [...fromEdges, ...toEdges]) {
        edgeMap.set(edge.id, edge)
      }
    }

    // Atomic write to JSONL
    await jsonlSave(Array.from(nodeMap.values()), Array.from(edgeMap.values()))

    // Clear dirty flags
    await storage.clearDirty(dirtyIds)
  }

  const syncManager: SyncManager = createSyncManager(syncConfig, storage, doFlush)

  // Track existing node count for adaptive ID generation
  let nodeCount = 0

  return {
    // =========================================================================
    // Lifecycle
    // =========================================================================

    async initialize(): Promise<void> {
      // Load from JSONL (source of truth)
      const { nodes, edges } = await jsonlLoad()

      // Sync to SQLite
      for (const node of nodes) {
        try {
          await storage.createNode(node)
          // Sync tags
          if (node.tags) {
            for (const tag of node.tags) {
              await storage.addTag(node.id, tag)
            }
          }
        } catch {
          // Node might already exist, update instead
          await storage.updateNode(node.id, node)
        }
      }

      for (const edge of edges) {
        try {
          await storage.createEdge(edge)
        } catch {
          // Edge might already exist, skip
        }
      }

      // Update node count for ID generation
      nodeCount = nodes.length
    },

    async close(): Promise<void> {
      // Flush pending changes
      await syncManager.flush()
      // Close storage
      await storage.close()
    },

    async flush(): Promise<void> {
      await syncManager.flush()
    },

    // =========================================================================
    // Node Operations
    // =========================================================================

    async createNode(input: CreateNodeInput): Promise<Node> {
      // Validate
      const result = validation.validateCreateNode(input)
      if (!result.valid) {
        const error = result.errors[0]
        throw new GraphError(
          'VALIDATION_ERROR',
          `${error.message}${error.field ? ` (${error.field})` : ''}`,
          { errors: result.errors, warnings: result.warnings }
        )
      }

      // Generate IDs
      const { id, uuid } = generateId(input.type, nodeCount)
      nodeCount++

      // Build stored node
      const storedNode = buildStoredNode(input, id, uuid)

      // Write to SQLite
      await storage.createNode(storedNode)

      // Sync tags if provided
      if (input.tags) {
        for (const tag of input.tags) {
          await storage.addTag(id, tag)
        }
      }

      // Schedule flush
      syncManager.markDirty(id)
      syncManager.scheduleFlush()

      // Return parsed node
      return parseNode({ ...storedNode, tags: input.tags })
    },

    async getNode(id: string): Promise<Node | null> {
      const stored = await storage.getNode(id)
      if (!stored) return null

      // Get tags
      const tags = await storage.getTags(id)

      try {
        return parseNode({ ...stored, tags })
      } catch {
        return null
      }
    },

    async updateNode(id: string, updates: UpdateNodeInput): Promise<Node> {
      // Get existing node
      const existing = await storage.getNode(id)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${id}`)
      }

      // Validate updates
      const result = validation.validateUpdateNode(existing, updates)
      if (!result.valid) {
        const error = result.errors[0]
        throw new GraphError(
          'VALIDATION_ERROR',
          `${error.message}${error.field ? ` (${error.field})` : ''}`,
          { errors: result.errors, warnings: result.warnings }
        )
      }

      // Apply updates
      const changes = applyUpdates(existing, updates)

      // Write to SQLite
      await storage.updateNode(id, changes)

      // Schedule flush
      syncManager.markDirty(id)
      syncManager.scheduleFlush()

      // Get updated node
      const updated = await storage.getNode(id)
      if (!updated) {
        throw new GraphError('NOT_FOUND', `Node not found after update: ${id}`)
      }

      const tags = await storage.getTags(id)
      return parseNode({ ...updated, tags })
    },

    async deleteNode(id: string, options?: DeleteOptions): Promise<void> {
      const existing = await storage.getNode(id)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${id}`)
      }

      if (options?.hard) {
        // Hard delete - remove from storage
        await storage.deleteNode(id)
      } else {
        // Soft delete - archive
        await storage.updateNode(id, {
          archived: true,
          archived_at: now(),
          updated_at: now(),
        })
      }

      // Schedule flush
      syncManager.markDirty(id)
      syncManager.scheduleFlush()
    },

    async restoreNode(id: string): Promise<Node> {
      const existing = await storage.getNode(id)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${id}`)
      }

      if (!existing.archived) {
        throw new GraphError('INVALID_OPERATION', `Node is not archived: ${id}`)
      }

      // Restore
      await storage.updateNode(id, {
        archived: false,
        archived_at: undefined,
        updated_at: now(),
      })

      // Schedule flush
      syncManager.markDirty(id)
      syncManager.scheduleFlush()

      const updated = await storage.getNode(id)
      if (!updated) {
        throw new GraphError('NOT_FOUND', `Node not found after restore: ${id}`)
      }

      const tags = await storage.getTags(id)
      return parseNode({ ...updated, tags })
    },

    // =========================================================================
    // Edge Operations
    // =========================================================================

    async createEdge(input: CreateEdgeInput): Promise<Edge> {
      // Validate
      const result = await validation.validateCreateEdge(input, (id) => storage.getNode(id))
      if (!result.valid) {
        const error = result.errors[0]
        throw new GraphError(
          'VALIDATION_ERROR',
          `${error.message}${error.field ? ` (${error.field})` : ''}`,
          { errors: result.errors, warnings: result.warnings }
        )
      }

      // Check for cycles on blocks edges
      if (input.type === 'blocks') {
        const cycleResult = await validation.detectCycle(input.from_id, input.to_id, (nodeId) =>
          storage.getEdgesFrom(nodeId, 'blocks')
        )
        if (cycleResult.hasCycle) {
          throw new GraphError('CYCLE_DETECTED', 'Creating this edge would create a cycle', {
            cycle: cycleResult.cycle,
          })
        }
      }

      // Generate IDs
      const { id, uuid } = generateId('edge')

      // Build edge
      const edge: StoredEdge = {
        id,
        uuid,
        from_id: input.from_id,
        to_id: input.to_id,
        type: input.type,
        created_at: now(),
        metadata: input.metadata,
      }

      // Write to SQLite
      await storage.createEdge(edge)

      // Schedule flush for both connected nodes
      syncManager.markDirty(input.from_id)
      syncManager.markDirty(input.to_id)
      syncManager.scheduleFlush()

      return edge as Edge
    },

    async getEdge(id: string): Promise<Edge | null> {
      const stored = await storage.getEdge(id)
      return stored as Edge | null
    },

    async deleteEdge(id: string): Promise<void> {
      const existing = await storage.getEdge(id)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Edge not found: ${id}`)
      }

      await storage.deleteEdge(id)

      // Schedule flush for both connected nodes
      syncManager.markDirty(existing.from_id)
      syncManager.markDirty(existing.to_id)
      syncManager.scheduleFlush()
    },

    // =========================================================================
    // Tag Operations
    // =========================================================================

    async addTags(nodeId: string, tags: string[]): Promise<void> {
      const existing = await storage.getNode(nodeId)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${nodeId}`)
      }

      for (const tag of tags) {
        await storage.addTag(nodeId, tag)
      }

      // Update timestamp
      await storage.updateNode(nodeId, { updated_at: now() })

      // Schedule flush
      syncManager.markDirty(nodeId)
      syncManager.scheduleFlush()
    },

    async removeTags(nodeId: string, tags: string[]): Promise<void> {
      const existing = await storage.getNode(nodeId)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${nodeId}`)
      }

      for (const tag of tags) {
        await storage.removeTag(nodeId, tag)
      }

      // Update timestamp
      await storage.updateNode(nodeId, { updated_at: now() })

      // Schedule flush
      syncManager.markDirty(nodeId)
      syncManager.scheduleFlush()
    },

    async setTags(nodeId: string, tags: string[]): Promise<void> {
      const existing = await storage.getNode(nodeId)
      if (!existing) {
        throw new GraphError('NOT_FOUND', `Node not found: ${nodeId}`)
      }

      // Get existing tags
      const existingTags = await storage.getTags(nodeId)

      // Remove all existing tags
      for (const tag of existingTags) {
        await storage.removeTag(nodeId, tag)
      }

      // Add new tags
      for (const tag of tags) {
        await storage.addTag(nodeId, tag)
      }

      // Update timestamp
      await storage.updateNode(nodeId, { updated_at: now() })

      // Schedule flush
      syncManager.markDirty(nodeId)
      syncManager.scheduleFlush()
    },

    // =========================================================================
    // Query
    // =========================================================================

    query: queryEngine,

    // =========================================================================
    // Transactions
    // =========================================================================

    async transaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T> {
      // Use storage-level transaction
      return storage.runInTransaction(async (storageTx) => {
        // Create a transaction wrapper that uses the storage transaction
        const graphTx: GraphTransaction = {
          async createNode(input: CreateNodeInput): Promise<Node> {
            const result = validation.validateCreateNode(input)
            if (!result.valid) {
              const error = result.errors[0]
              throw new GraphError(
                'VALIDATION_ERROR',
                `${error.message}${error.field ? ` (${error.field})` : ''}`
              )
            }

            const { id, uuid } = generateId(input.type, nodeCount)
            nodeCount++

            const storedNode = buildStoredNode(input, id, uuid)
            await storageTx.createNode(storedNode)

            if (input.tags) {
              for (const tag of input.tags) {
                await storageTx.addTag(id, tag)
              }
            }

            syncManager.markDirty(id)
            return parseNode({ ...storedNode, tags: input.tags })
          },

          async updateNode(id: string, updates: UpdateNodeInput): Promise<Node> {
            const existing = await storage.getNode(id)
            if (!existing) {
              throw new GraphError('NOT_FOUND', `Node not found: ${id}`)
            }

            const result = validation.validateUpdateNode(existing, updates)
            if (!result.valid) {
              const error = result.errors[0]
              throw new GraphError(
                'VALIDATION_ERROR',
                `${error.message}${error.field ? ` (${error.field})` : ''}`
              )
            }

            const changes = applyUpdates(existing, updates)
            await storageTx.updateNode(id, changes)

            syncManager.markDirty(id)

            const updated = { ...existing, ...changes }
            const tags = await storage.getTags(id)
            return parseNode({ ...updated, tags })
          },

          async deleteNode(id: string): Promise<void> {
            const existing = await storage.getNode(id)
            if (!existing) {
              throw new GraphError('NOT_FOUND', `Node not found: ${id}`)
            }

            // Soft delete in transaction
            await storageTx.updateNode(id, {
              archived: true,
              archived_at: now(),
              updated_at: now(),
            })

            syncManager.markDirty(id)
          },

          async createEdge(input: CreateEdgeInput): Promise<Edge> {
            const result = await validation.validateCreateEdge(input, (id) => storage.getNode(id))
            if (!result.valid) {
              const error = result.errors[0]
              throw new GraphError(
                'VALIDATION_ERROR',
                `${error.message}${error.field ? ` (${error.field})` : ''}`
              )
            }

            if (input.type === 'blocks') {
              const cycleResult = await validation.detectCycle(
                input.from_id,
                input.to_id,
                (nodeId) => storage.getEdgesFrom(nodeId, 'blocks')
              )
              if (cycleResult.hasCycle) {
                throw new GraphError('CYCLE_DETECTED', 'Creating this edge would create a cycle', {
                  cycle: cycleResult.cycle,
                })
              }
            }

            const { id, uuid } = generateId('edge')

            const edge: StoredEdge = {
              id,
              uuid,
              from_id: input.from_id,
              to_id: input.to_id,
              type: input.type,
              created_at: now(),
              metadata: input.metadata,
            }

            await storageTx.createEdge(edge)

            syncManager.markDirty(input.from_id)
            syncManager.markDirty(input.to_id)

            return edge as Edge
          },

          async deleteEdge(id: string): Promise<void> {
            const existing = await storage.getEdge(id)
            if (!existing) {
              throw new GraphError('NOT_FOUND', `Edge not found: ${id}`)
            }

            await storageTx.deleteEdge(id)

            syncManager.markDirty(existing.from_id)
            syncManager.markDirty(existing.to_id)
          },
        }

        const result = await fn(graphTx)

        // Schedule flush after transaction completes
        syncManager.scheduleFlush()

        return result
      })
    },
  }
}
