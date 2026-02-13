/**
 * Graph Method Handlers
 *
 * JSON-RPC method handlers for graph operations via IPC.
 * Location-aware: extracts optional `location` from params to route
 * to the correct store via LocationResolver.
 *
 * When a ProviderAwareStore is available on the LocationState,
 * CRUD operations are dispatched through the unified provider interface.
 */

import type { IPCServer } from '../ipc.js'
import type { LocationResolver } from '../location-state.js'
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

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver
}

// ============================================================================
// Method Parameter Types
// ============================================================================

interface QueryParams {
  type?: NodeType
  filter?: NodeFilter
  limit?: number
  offset?: number
  location?: string
}

interface GetParams {
  id: string
  location?: string
}

interface CreateParams extends CreateNodeInput {
  location?: string
  /** Target provider scheme (overrides defaultProvider config) */
  scheme?: string
}

interface UpdateParams extends UpdateNodeInput {
  id: string
  location?: string
}

interface DeleteParams {
  id: string
  options?: DeleteOptions
  location?: string
}

interface DeleteEdgeParams {
  id: string
  location?: string
}

interface CreateEdgeParams {
  from_id: string
  to_id: string
  type: EdgeType
  metadata?: Record<string, unknown>
  location?: string
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register graph method handlers on an IPC server
 */
export function registerGraphMethods(options: GraphMethodsOptions): void {
  const { server, locationResolver } = options

  // graph.query - Query nodes
  server.handle<QueryParams, unknown[]>('graph.query', async (params) => {
    const { type, filter = {}, limit, offset, location } = params || {}
    const state = locationResolver.resolve(location)

    // Build filter with type, limit, offset
    const queryFilter: NodeFilter = {
      ...filter,
      limit,
      offset,
    }

    if (type) {
      queryFilter.type = type
    }

    return state.store.query.nodes(queryFilter)
  })

  // graph.get - Get node by ID or provider URI
  server.handle<GetParams, unknown>('graph.get', async (params) => {
    const { id, location } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    const state = locationResolver.resolve(location)

    // Use provider-aware get when available
    if (state.providerStore) {
      return state.providerStore.providerGet(id)
    }

    return state.store.getNode(id)
  })

  // graph.create - Create node (with optional provider routing)
  server.handle<CreateParams, unknown>('graph.create', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    const { location, scheme, ...createParams } = params
    const state = locationResolver.resolve(location)

    // Use provider-aware create when available
    if (state.providerStore) {
      const result = await state.providerStore.providerCreate(createParams, { scheme })

      // Mark dirty and schedule flush
      state.flushManager.markDirty(result.node.id)
      state.flushManager.schedule()

      return result.node
    }

    // Fallback: direct store create
    const node = await state.store.createNode(createParams)

    // Mark dirty and schedule flush
    state.flushManager.markDirty(node.id)
    state.flushManager.schedule()

    return node
  })

  // graph.update - Update node (with provider routing for external nodes)
  server.handle<UpdateParams, unknown>('graph.update', async (params) => {
    if (!params || !params.id) {
      throw new Error('Missing required parameter: id')
    }

    const { id, location, ...updates } = params
    const state = locationResolver.resolve(location)

    // Use provider-aware update when available
    if (state.providerStore) {
      const node = await state.providerStore.providerUpdate(id, updates)

      // Mark dirty and schedule flush
      state.flushManager.markDirty(node.id)
      state.flushManager.schedule()

      return node
    }

    // Fallback: direct store update
    const node = await state.store.updateNode(id, updates)

    // Mark dirty and schedule flush
    state.flushManager.markDirty(node.id)
    state.flushManager.schedule()

    return node
  })

  // graph.delete - Delete node (with provider routing for external nodes)
  server.handle<DeleteParams, void>('graph.delete', async (params) => {
    const { id, options, location } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    const state = locationResolver.resolve(location)

    // Use provider-aware delete when available
    if (state.providerStore) {
      await state.providerStore.providerDelete(id, options)

      // Mark dirty and schedule flush
      state.flushManager.markDirty(`__deleted__:${id}`)
      state.flushManager.schedule()
      return
    }

    // Fallback: direct store delete
    await state.store.deleteNode(id, options)

    // Mark dirty and schedule flush
    state.flushManager.markDirty(`__deleted__:${id}`)
    state.flushManager.schedule()
  })

  // graph.createEdge - Create edge
  server.handle<CreateEdgeParams, unknown>('graph.createEdge', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    const { location, ...edgeParams } = params
    const state = locationResolver.resolve(location)

    const input: CreateEdgeInput = {
      from_id: edgeParams.from_id,
      to_id: edgeParams.to_id,
      type: edgeParams.type,
      metadata: edgeParams.metadata,
    }

    const edge = await state.store.createEdge(input)

    // Mark both nodes as dirty
    state.flushManager.markDirty(edgeParams.from_id)
    state.flushManager.markDirty(edgeParams.to_id)
    state.flushManager.schedule()

    return edge
  })

  // graph.deleteEdge - Delete edge by ID
  server.handle<DeleteEdgeParams, void>('graph.deleteEdge', async (params) => {
    const { id, location } = params || {}
    if (!id) {
      throw new Error('Missing required parameter: id')
    }

    const state = locationResolver.resolve(location)

    // Get edge first to know which nodes to mark dirty
    const edge = await state.store.getEdge(id)

    await state.store.deleteEdge(id)

    // Mark both nodes as dirty if edge existed
    if (edge) {
      state.flushManager.markDirty(edge.from_id)
      state.flushManager.markDirty(edge.to_id)
      state.flushManager.schedule()
    }
  })

  // flush - Force immediate flush
  server.handle<{ location?: string }, { success: boolean }>('flush', async (params) => {
    const { location } = params || {}
    const state = locationResolver.resolve(location)
    await state.flushManager.flush()
    return { success: true }
  })
}
