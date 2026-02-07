/**
 * Location Method Handlers
 *
 * JSON-RPC method handlers for location management in multi-location mode.
 * Allows dynamic registration, unregistration, and listing of locations.
 */

import type { IPCServer } from '../ipc.js'
import type { LocationResolver, LocationState } from '../location-state.js'
import { createLocationState, destroyLocationState } from '../location-state.js'
import type { LocationInfo } from '../types.js'
import {
  registerWorktree,
  unregisterWorktree,
  type WorktreeEntry,
} from '../../core/worktree.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for registering location methods
 */
export interface LocationMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer

  /** Location resolver for managing locations */
  locationResolver: LocationResolver

  /** Git common dir for persisting to worktree registry (multi-location only) */
  gitCommonDir?: string
}

interface RegisterParams {
  hash: string
  opentasksPath: string
}

interface UnregisterParams {
  hash: string
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register location management method handlers on an IPC server
 */
export function registerLocationMethods(options: LocationMethodsOptions): void {
  const { server, locationResolver, gitCommonDir } = options

  // location.list - List all managed locations
  server.handle<Record<string, never>, LocationInfo[]>('location.list', async () => {
    return locationResolver.list()
  })

  // location.register - Register a new location dynamically
  server.handle<RegisterParams, { success: boolean }>('location.register', async (params) => {
    if (!params || !params.hash || !params.opentasksPath) {
      throw new Error('Missing required parameters: hash, opentasksPath')
    }

    // Check if already registered
    if (locationResolver.has(params.hash)) {
      return { success: true } // Idempotent
    }

    // Create location state
    const state: LocationState = await createLocationState(
      params.opentasksPath,
      params.hash,
      false // not primary
    )

    // Start the watcher
    await state.watcher.start()

    // Add to resolver
    locationResolver.add(state)

    // Persist to worktree registry if available
    if (gitCommonDir) {
      try {
        const entry: WorktreeEntry = {
          path: params.opentasksPath.replace(/[/\\]\.opentasks$/, ''),
          opentasksPath: params.opentasksPath,
          hash: params.hash,
          role: 'worker',
        }
        registerWorktree(gitCommonDir, entry)
      } catch {
        // Non-fatal: registry persistence failure doesn't affect in-memory state
      }
    }

    return { success: true }
  })

  // location.unregister - Unregister a location
  server.handle<UnregisterParams, { success: boolean }>('location.unregister', async (params) => {
    if (!params || !params.hash) {
      throw new Error('Missing required parameter: hash')
    }

    // Remove and tear down
    await locationResolver.remove(params.hash)

    // Remove from worktree registry if available
    if (gitCommonDir) {
      try {
        unregisterWorktree(gitCommonDir, params.hash)
      } catch {
        // Non-fatal: registry persistence failure doesn't affect in-memory state
      }
    }

    return { success: true }
  })
}
