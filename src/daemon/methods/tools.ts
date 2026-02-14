/**
 * Tools Method Handlers
 *
 * JSON-RPC method handlers for the 3-tool agent interface via IPC.
 * Location-aware: extracts optional `location` from params to route
 * to the correct store via LocationResolver.
 */

import type { IPCServer } from '../ipc.js'
import type { LocationResolver } from '../location-state.js'
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  TaskParams,
  TaskResult,
} from '../../tools/types.js'
import { link } from '../../tools/link.js'
import { query } from '../../tools/query.js'
import { annotate } from '../../tools/annotate.js'
import { task } from '../../tools/task.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering tools methods
 */
export interface ToolsMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an ID is a local node ID (not a provider URI)
 */
const LOCAL_ID_PATTERN = /^[sifex]-[a-z0-9]+$/

function isLocalId(id: string): boolean {
  return LOCAL_ID_PATTERN.test(id)
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register tools method handlers on an IPC server
 */
export function registerToolsMethods(options: ToolsMethodsOptions): void {
  const { server, locationResolver } = options

  // tools.link - Create/remove edges between nodes
  server.handle<LinkParams & { location?: string }, LinkResult>('tools.link', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' }
    }

    const { location, ...linkParams } = params
    const state = locationResolver.resolve(location)

    const result = await link(state.store, linkParams)

    // Mark nodes dirty and schedule flush on success
    if (result.success) {
      // Only mark local IDs as dirty (not provider URIs)
      if (isLocalId(linkParams.fromId)) {
        state.flushManager.markDirty(linkParams.fromId)
      }
      if (isLocalId(linkParams.toId)) {
        state.flushManager.markDirty(linkParams.toId)
      }
      state.flushManager.schedule()
    }

    return result
  })

  // tools.query - Query the graph with unified interface
  server.handle<QueryParams & { location?: string }, QueryResult>('tools.query', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    const { location, ...queryParams } = params
    const state = locationResolver.resolve(location)

    // Query is read-only, no flush needed
    return query(state.store, queryParams)
  })

  // tools.annotate - Manage feedback lifecycle
  server.handle<AnnotateParams & { location?: string }, AnnotateResult>('tools.annotate', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' }
    }

    const { location, ...annotateParams } = params
    const state = locationResolver.resolve(location)

    const result = await annotate(state.store, annotateParams)

    // Mark nodes dirty and schedule flush on success
    if (result.success) {
      // Mark target and feedback nodes dirty
      if (isLocalId(annotateParams.targetId)) {
        state.flushManager.markDirty(annotateParams.targetId)
      }
      if (result.feedbackId && isLocalId(result.feedbackId)) {
        state.flushManager.markDirty(result.feedbackId)
      }
      // Mark fromId dirty if provided (for edge creation)
      if (annotateParams.fromId && isLocalId(annotateParams.fromId)) {
        state.flushManager.markDirty(annotateParams.fromId)
      }
      state.flushManager.schedule()
    }

    return result
  })

  // tools.task - Task lifecycle operations
  server.handle<TaskParams & { location?: string }, TaskResult>('tools.task', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' }
    }

    const { location, ...taskParams } = params
    const state = locationResolver.resolve(location)

    if (!state.providerStore) {
      return { success: false, error: 'Provider store not available' }
    }

    const result = await task(state.providerStore, taskParams)

    // Mark nodes dirty and schedule flush for mutations
    if (result.success && result.data) {
      if (result.data.type === 'transition' && isLocalId(result.data.node.id)) {
        state.flushManager.markDirty(result.data.node.id)
        state.flushManager.schedule()
      }
      if (result.data.type === 'assign' && isLocalId(result.data.node.id)) {
        state.flushManager.markDirty(result.data.node.id)
        state.flushManager.schedule()
      }
    }

    return result
  })
}
