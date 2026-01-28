/**
 * Graph Method Handlers
 *
 * JSON-RPC method handlers for graph operations via IPC.
 */

import type { IPCServer } from '../ipc.js'
import type { DaemonFlushManager } from '../flush.js'
import type { GraphStore } from '../../graph/store.js'
import type {
  NodeType,
  CreateNodeInput,
  UpdateNodeInput,
  DeleteOptions,
  CreateEdgeInput,
  NodeFilter,
  EdgeType,
} from '../../graph/types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering graph methods
 */
export interface GraphMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer

  /** Graph store for data operations */
  store: GraphStore

  /** Flush manager for dirty tracking */
  flushManager: DaemonFlushManager
}

// ============================================================================
// Method Parameter Types
// ============================================================================

interface QueryParams {
  type?: NodeType
  filter?: NodeFilter
  limit?: number
  offset?: number
}

interface GetParams {
  id: string
}

interface UpdateParams extends UpdateNodeInput {
  id: string
}

interface DeleteParams {
  id: string
  options?: DeleteOptions
}

interface DeleteEdgeParams {
  id: string
}

interface CreateEdgeParams {
  from_id: string
  to_id: string
  type: EdgeType
  metadata?: Record<string, unknown>
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register graph method handlers on an IPC server
 */
export function registerGraphMethods(options: GraphMethodsOptions): void {
  const { server, store, flushManager } = options

  // graph.query - Query nodes
  server.handle<QueryParams, unknown[]>('graph.query', async (params) => {
    const { type, filter = {}, limit, offset } = params || {}

    // Build filter with type, limit, offset
    const queryFilter: NodeFilter = {
      ...filter,
      limit,
      offset,
    }

    if (type) {
      queryFilter.type = type
    }

    return store.query.nodes(queryFilter)
  })

  // graph.get - Get node by ID
  server.handle<GetParams, unknown>('graph.get', async (params) => {
    const { id } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    return store.getNode(id)
  })

  // graph.create - Create node
  server.handle<CreateNodeInput, unknown>('graph.create', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    const node = await store.createNode(params)

    // Mark dirty and schedule flush
    flushManager.markDirty(node.id)
    flushManager.schedule()

    return node
  })

  // graph.update - Update node
  server.handle<UpdateParams, unknown>('graph.update', async (params) => {
    if (!params || !params.id) {
      throw new Error('Missing required parameter: id')
    }

    const { id, ...updates } = params
    const node = await store.updateNode(id, updates)

    // Mark dirty and schedule flush
    flushManager.markDirty(node.id)
    flushManager.schedule()

    return node
  })

  // graph.delete - Delete node
  server.handle<DeleteParams, void>('graph.delete', async (params) => {
    const { id, options } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    await store.deleteNode(id, options)

    // Mark dirty and schedule flush
    // Note: For deletions, we mark the graph as dirty (using a special marker)
    flushManager.markDirty(`__deleted__:${id}`)
    flushManager.schedule()
  })

  // graph.createEdge - Create edge
  server.handle<CreateEdgeParams, unknown>('graph.createEdge', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    const input: CreateEdgeInput = {
      from_id: params.from_id,
      to_id: params.to_id,
      type: params.type,
      metadata: params.metadata,
    }

    const edge = await store.createEdge(input)

    // Mark both nodes as dirty
    flushManager.markDirty(params.from_id)
    flushManager.markDirty(params.to_id)
    flushManager.schedule()

    return edge
  })

  // graph.deleteEdge - Delete edge by ID
  server.handle<DeleteEdgeParams, void>('graph.deleteEdge', async (params) => {
    const { id } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    // Get edge first to know which nodes to mark dirty
    const edge = await store.getEdge(id)

    await store.deleteEdge(id)

    // Mark both nodes as dirty if edge existed
    if (edge) {
      flushManager.markDirty(edge.from_id)
      flushManager.markDirty(edge.to_id)
      flushManager.schedule()
    }
  })

  // flush - Force immediate flush
  server.handle('flush', async () => {
    await flushManager.flush()
    return { success: true }
  })
}
