/**
 * Tools Method Handlers
 *
 * JSON-RPC method handlers for the 3-tool agent interface via IPC.
 */

import type { IPCServer } from '../ipc.js'
import type { DaemonFlushManager } from '../flush.js'
import type { GraphStore } from '../../graph/store.js'
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
} from '../../tools/types.js'
import { link } from '../../tools/link.js'
import { query } from '../../tools/query.js'
import { annotate } from '../../tools/annotate.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering tools methods
 */
export interface ToolsMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer

  /** Graph store for data operations */
  store: GraphStore

  /** Flush manager for dirty tracking */
  flushManager: DaemonFlushManager
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
  const { server, store, flushManager } = options

  // tools.link - Create/remove edges between nodes
  server.handle<LinkParams, LinkResult>('tools.link', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' }
    }

    const result = await link(store, params)

    // Mark nodes dirty and schedule flush on success
    if (result.success) {
      // Only mark local IDs as dirty (not provider URIs)
      if (isLocalId(params.from_id)) {
        flushManager.markDirty(params.from_id)
      }
      if (isLocalId(params.to_id)) {
        flushManager.markDirty(params.to_id)
      }
      flushManager.schedule()
    }

    return result
  })

  // tools.query - Query the graph with unified interface
  server.handle<QueryParams, QueryResult>('tools.query', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters')
    }

    // Query is read-only, no flush needed
    return query(store, params)
  })

  // tools.annotate - Manage feedback lifecycle
  server.handle<AnnotateParams, AnnotateResult>('tools.annotate', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' }
    }

    const result = await annotate(store, params)

    // Mark nodes dirty and schedule flush on success
    if (result.success) {
      // Mark target and feedback nodes dirty
      if (isLocalId(params.target_id)) {
        flushManager.markDirty(params.target_id)
      }
      if (result.feedback_id && isLocalId(result.feedback_id)) {
        flushManager.markDirty(result.feedback_id)
      }
      // Mark from_id dirty if provided (for edge creation)
      if (params.from_id && isLocalId(params.from_id)) {
        flushManager.markDirty(params.from_id)
      }
      flushManager.schedule()
    }

    return result
  })
}
