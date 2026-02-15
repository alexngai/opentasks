/**
 * Archive Method Handlers
 *
 * JSON-RPC method handlers for materialization archive operations via IPC.
 * Provides archive listing, rematerialization, and push control.
 */

import type { IPCServer } from '../ipc.js'
import type { LocationResolver } from '../location-state.js'
import type {
  ArchiveFilter,
  ArchiveListEntry,
  ArchiveEventResult,
  RematerializeAllResult,
} from '../../materialization/types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering archive methods
 */
export interface ArchiveMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver
}

// ============================================================================
// Method Parameter Types
// ============================================================================

interface ArchiveListParams {
  filter?: ArchiveFilter
  location?: string
}

interface ArchiveRematerializeParams {
  uri: string
  location?: string
}

interface ArchiveRematerializeAllParams {
  location?: string
}

interface ArchivePushParams {
  location?: string
}

interface ArchiveNodeParams {
  uri: string
  location?: string
}

interface ArchiveStatusParams {
  location?: string
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register archive method handlers on an IPC server
 */
export function registerArchiveMethods(options: ArchiveMethodsOptions): void {
  const { server, locationResolver } = options

  // archive.list — List archived sessions/snapshots
  server.handle<ArchiveListParams, ArchiveListEntry[]>('archive.list', async (params) => {
    const { filter, location } = params || {}
    const state = locationResolver.resolve(location)

    if (!state.archiver) {
      return []
    }

    return state.archiver.listArchived(filter)
  })

  // archive.rematerialize — Restore a single node from archive
  server.handle<ArchiveRematerializeParams, { success: boolean; error?: string }>(
    'archive.rematerialize',
    async (params) => {
      const { uri, location } = params || {}
      if (!uri) {
        throw new Error('Missing required parameter: uri')
      }

      const state = locationResolver.resolve(location)

      if (!state.archiver) {
        return { success: false, error: 'Archive functionality not enabled' }
      }

      try {
        const success = await state.archiver.rematerialize(uri, state.store)
        if (success) {
          state.flushManager.schedule()
        }
        return { success }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  // archive.rematerializeAll — Restore all missing nodes from archive
  server.handle<ArchiveRematerializeAllParams, RematerializeAllResult>(
    'archive.rematerializeAll',
    async (params) => {
      const { location } = params || {}
      const state = locationResolver.resolve(location)

      if (!state.archiver) {
        return { restored: 0, failed: 0, skipped: 0, errors: [] }
      }

      const result = await state.archiver.rematerializeAll(state.store)
      if (result.restored > 0) {
        state.flushManager.schedule()
      }
      return result
    }
  )

  // archive.push — Manually trigger push of archive to remote
  server.handle<ArchivePushParams, { pushed: boolean; error?: string }>(
    'archive.push',
    async (params) => {
      const { location } = params || {}
      const state = locationResolver.resolve(location)

      if (!state.archiver) {
        return { pushed: false, error: 'Archive functionality not enabled' }
      }

      try {
        // Close triggers a push for on-session-end and immediate policies
        // For manual push, we call close + re-initialize
        await state.archiver.close()
        await state.archiver.initialize()
        return { pushed: true }
      } catch (error) {
        return {
          pushed: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  // archive.node — Manually archive a specific node
  server.handle<ArchiveNodeParams, ArchiveEventResult>(
    'archive.node',
    async (params) => {
      const { uri, location } = params || {}
      if (!uri) {
        throw new Error('Missing required parameter: uri')
      }

      const state = locationResolver.resolve(location)

      if (!state.archiver) {
        return { uri, stores: [{ storeName: 'none', stored: false, error: 'Archive functionality not enabled' }] }
      }

      return state.archiver.archiveNode(uri, state.store)
    }
  )

  // archive.status — Get archive store status
  server.handle<ArchiveStatusParams, { enabled: boolean; stores: Array<{ name: string; healthy: boolean; message?: string }> }>(
    'archive.status',
    async (params) => {
      const { location } = params || {}
      const state = locationResolver.resolve(location)

      if (!state.archiver) {
        return { enabled: false, stores: [] }
      }

      return { enabled: true, stores: [] }
    }
  )
}
