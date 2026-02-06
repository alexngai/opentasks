/**
 * Query Expansion for OpenTasks (Phase 3)
 *
 * Enables queries that span multiple OpenTasks locations.
 */

import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { Storage } from '../storage/interface.js'
import type { Connection } from '../core/connections.js'
import type { ProviderNode } from '../providers/types.js'
import type { LocationProvider } from '../providers/location.js'

/**
 * Query expansion modes
 */
export type ExpansionMode =
  | 'none'         // Only current location (default)
  | 'follow-refs'  // Follow outbound edge references via providers
  | 'connections'   // Query all declared connections
  | 'all'          // follow-refs + connections

/**
 * Expanded query result
 */
export interface ExpandedResult {
  /** Results from current location */
  local: StoredNode[]
  /** Results from connected locations, keyed by hash */
  connected: Record<string, ProviderNode[]>
  /** All locations queried */
  queriedLocations: string[]
  /** Locations that were unreachable */
  unreachableLocations: string[]
  /** Completeness indicator */
  completeness: 'full' | 'partial'
}

/**
 * Options for expanded queries
 */
export interface ExpansionOptions {
  /** Expansion mode */
  expand?: ExpansionMode
  /** Maximum number of locations to query (safety limit) */
  maxLocations?: number
}

/**
 * Query expander for cross-location queries
 */
export interface QueryExpander {
  /**
   * Execute an expanded ready query
   */
  expandedReady(options?: ExpansionOptions): Promise<ExpandedResult>

  /**
   * Execute an expanded node query
   */
  expandedQuery(
    filter: { type?: string; status?: string },
    options?: ExpansionOptions
  ): Promise<ExpandedResult>
}

/**
 * Create a query expander
 *
 * @param storage - Local storage
 * @param locationHash - Current location hash
 * @param locationProviders - Map of location hash → Provider
 */
export function createQueryExpander(
  storage: Storage,
  locationHash: string,
  locationProviders: Map<string, LocationProvider>
): QueryExpander {
  async function queryLocal(filter?: { type?: string; status?: string }): Promise<StoredNode[]> {
    if (filter) {
      return storage.queryNodes({
        type: filter.type,
        status: filter.status,
      })
    }
    return storage.getReady()
  }

  async function queryConnectedReady(
    providers: Map<string, LocationProvider>,
    maxLocations: number
  ): Promise<{
    connected: Record<string, ProviderNode[]>
    queriedLocations: string[]
    unreachableLocations: string[]
  }> {
    const connected: Record<string, ProviderNode[]> = {}
    const queriedLocations: string[] = []
    const unreachableLocations: string[] = []
    let count = 0

    for (const [hash, provider] of providers.entries()) {
      if (count >= maxLocations) break
      count++

      try {
        const results = await provider.ready()
        connected[hash] = results
        queriedLocations.push(hash)
      } catch {
        unreachableLocations.push(hash)
      }
    }

    return { connected, queriedLocations, unreachableLocations }
  }

  async function queryConnectedList(
    providers: Map<string, LocationProvider>,
    filter: { type?: string; status?: string },
    maxLocations: number
  ): Promise<{
    connected: Record<string, ProviderNode[]>
    queriedLocations: string[]
    unreachableLocations: string[]
  }> {
    const connected: Record<string, ProviderNode[]> = {}
    const queriedLocations: string[] = []
    const unreachableLocations: string[] = []
    let count = 0

    for (const [hash, provider] of providers.entries()) {
      if (count >= maxLocations) break
      count++

      try {
        const results = await provider.list(filter)
        connected[hash] = results
        queriedLocations.push(hash)
      } catch {
        unreachableLocations.push(hash)
      }
    }

    return { connected, queriedLocations, unreachableLocations }
  }

  return {
    async expandedReady(options?: ExpansionOptions): Promise<ExpandedResult> {
      const mode = options?.expand ?? 'none'
      const maxLocations = options?.maxLocations ?? 10

      // Always query local
      const local = await storage.getReady()

      if (mode === 'none') {
        return {
          local,
          connected: {},
          queriedLocations: [locationHash],
          unreachableLocations: [],
          completeness: 'full',
        }
      }

      // For follow-refs, connections, and all — query connected locations
      const { connected, queriedLocations, unreachableLocations } =
        await queryConnectedReady(locationProviders, maxLocations)

      return {
        local,
        connected,
        queriedLocations: [locationHash, ...queriedLocations],
        unreachableLocations,
        completeness: unreachableLocations.length === 0 ? 'full' : 'partial',
      }
    },

    async expandedQuery(
      filter: { type?: string; status?: string },
      options?: ExpansionOptions
    ): Promise<ExpandedResult> {
      const mode = options?.expand ?? 'none'
      const maxLocations = options?.maxLocations ?? 10

      const local = await queryLocal(filter)

      if (mode === 'none') {
        return {
          local,
          connected: {},
          queriedLocations: [locationHash],
          unreachableLocations: [],
          completeness: 'full',
        }
      }

      const { connected, queriedLocations, unreachableLocations } =
        await queryConnectedList(locationProviders, filter, maxLocations)

      return {
        local,
        connected,
        queriedLocations: [locationHash, ...queriedLocations],
        unreachableLocations,
        completeness: unreachableLocations.length === 0 ? 'full' : 'partial',
      }
    },
  }
}
