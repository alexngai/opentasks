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
  const { server, locationResolver } = options

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

    return { success: true }
  })

  // location.unregister - Unregister a location
  server.handle<UnregisterParams, { success: boolean }>('location.unregister', async (params) => {
    if (!params || !params.hash) {
      throw new Error('Missing required parameter: hash')
    }

    // Remove and tear down
    await locationResolver.remove(params.hash)

    return { success: true }
  })
}
