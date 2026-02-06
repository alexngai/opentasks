/**
 * OpenTasks URI scheme parser and resolver (Phase 2)
 *
 * Handles opentasks:// URIs for cross-location node references.
 *
 * URI formats:
 *   opentasks://k7m2x9p4/i-x7k9           - By location hash (preferred)
 *   opentasks://./i-x7k9                    - Current location
 *   opentasks:///abs/path/.opentasks/s-g8h9 - Absolute path (fallback)
 */

import * as path from 'node:path'
import type { Connection } from './connections.js'
import type { LocationIdentity } from './location.js'
import { isValidLocationHash } from './location.js'

/**
 * Parsed opentasks:// URI
 */
export interface ParsedOpentasksUri {
  scheme: 'opentasks'
  /** Location hash (e.g., "k7m2x9p4") */
  locationHash?: string
  /** Relative path (e.g., "./") */
  relativePath?: string
  /** Absolute path (e.g., "/abs/path/.opentasks/") */
  absolutePath?: string
  /** Node ID (e.g., "i-x7k9") */
  nodeId: string
}

/**
 * Resolved location target (without node ID)
 *
 * Used by the redirect system and daemon routing where
 * only the location needs to be resolved, not a specific node.
 */
export interface ResolvedLocationTarget {
  /** Path to the .opentasks directory */
  opentasksPath: string
  /** Location hash */
  hash: string
  /** Whether this is the current location */
  isLocal: boolean
}

/**
 * Resolved location result (with node ID)
 */
export interface ResolvedLocation extends ResolvedLocationTarget {
  /** Node ID to access */
  nodeId: string
}

/**
 * Parse an opentasks:// URI
 *
 * @param uri - The URI to parse
 * @returns Parsed URI or null if invalid
 */
export function parseOpentasksUri(uri: string): ParsedOpentasksUri | null {
  if (!uri.startsWith('opentasks://')) {
    return null
  }

  const rest = uri.slice('opentasks://'.length)

  // Absolute path: opentasks:///abs/path/.opentasks/s-g8h9
  if (rest.startsWith('/')) {
    // Find the last path segment as node ID
    const lastSlash = rest.lastIndexOf('/')
    if (lastSlash <= 0) return null

    const pathPart = rest.slice(0, lastSlash)
    const nodeId = rest.slice(lastSlash + 1)
    if (!nodeId) return null

    return {
      scheme: 'opentasks',
      absolutePath: pathPart,
      nodeId,
    }
  }

  // Current location: opentasks://./i-x7k9
  if (rest.startsWith('./')) {
    const nodeId = rest.slice(2)
    if (!nodeId) return null

    return {
      scheme: 'opentasks',
      relativePath: './',
      nodeId,
    }
  }

  // Hash-based: opentasks://k7m2x9p4/i-x7k9
  const slashIndex = rest.indexOf('/')
  if (slashIndex === -1) return null

  const hashPart = rest.slice(0, slashIndex)
  const nodeId = rest.slice(slashIndex + 1)

  if (!hashPart || !nodeId) return null

  return {
    scheme: 'opentasks',
    locationHash: hashPart,
    nodeId,
  }
}

/**
 * Check if a string is an opentasks:// URI
 */
export function isOpentasksUri(uri: string): boolean {
  return uri.startsWith('opentasks://')
}

/**
 * Resolve a location target to a location (without node ID)
 *
 * Accepts a location specifier in any of these forms:
 *   - Bare hash: "k7m2x9p4"
 *   - Current-location shorthand: "."
 *   - Hash-based URI: "opentasks://k7m2x9p4/" or "opentasks://k7m2x9p4/node-id"
 *   - Absolute path URI: "opentasks:///abs/path/.opentasks/"
 *
 * Used by the redirect system, daemon routing, and worktree lookup.
 *
 * @param target - Location specifier (hash, ".", or opentasks:// URI)
 * @param connections - Available connections
 * @param currentLocation - Current location identity
 * @param currentOpentasksPath - Path to current .opentasks directory
 * @returns Resolved location target or throws on error
 */
export function resolveLocationTarget(
  target: string,
  connections: Connection[],
  currentLocation: LocationIdentity,
  currentOpentasksPath: string
): ResolvedLocationTarget {
  // Current-location shorthand: "."
  if (target === '.') {
    return {
      opentasksPath: currentOpentasksPath,
      hash: currentLocation.hash,
      isLocal: true,
    }
  }

  // If it's an opentasks:// URI, parse out the location part
  if (target.startsWith('opentasks://')) {
    const rest = target.slice('opentasks://'.length)

    // Current location URI: "opentasks://./" or "opentasks://./node-id"
    if (rest.startsWith('./')) {
      return {
        opentasksPath: currentOpentasksPath,
        hash: currentLocation.hash,
        isLocal: true,
      }
    }

    // Absolute path URI: "opentasks:///abs/path/"
    if (rest.startsWith('/')) {
      // Strip trailing node-id segment if present (take the directory part)
      const cleanPath = rest.endsWith('/') ? rest.slice(0, -1) : rest.slice(0, rest.lastIndexOf('/')) || rest
      const resolvedPath = path.resolve(cleanPath)

      if (path.resolve(currentOpentasksPath) === resolvedPath) {
        return { opentasksPath: currentOpentasksPath, hash: currentLocation.hash, isLocal: true }
      }

      const connection = connections.find((c) => path.resolve(c.path) === resolvedPath)
      if (connection) {
        return { opentasksPath: connection.path, hash: connection.hash, isLocal: false }
      }

      return { opentasksPath: resolvedPath, hash: '', isLocal: false }
    }

    // Hash-based URI: "opentasks://hash/" or "opentasks://hash/node-id"
    const slashIndex = rest.indexOf('/')
    const hashPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex)

    return resolveHashTarget(hashPart, connections, currentLocation, currentOpentasksPath)
  }

  // Bare hash: "k7m2x9p4"
  return resolveHashTarget(target, connections, currentLocation, currentOpentasksPath)
}

/**
 * Resolve a hash to a location target
 */
function resolveHashTarget(
  hash: string,
  connections: Connection[],
  currentLocation: LocationIdentity,
  currentOpentasksPath: string
): ResolvedLocationTarget {
  if (hash === currentLocation.hash) {
    return { opentasksPath: currentOpentasksPath, hash: currentLocation.hash, isLocal: true }
  }

  const connection = connections.find((c) => c.hash === hash)
  if (connection) {
    return { opentasksPath: connection.path, hash: connection.hash, isLocal: false }
  }

  throw new Error(`Unknown location hash: ${hash}`)
}

/**
 * Resolve an opentasks:// URI to a location and node ID
 *
 * Delegates to resolveLocationTarget for the location part,
 * then attaches the node ID from the URI.
 *
 * @param uri - The URI to resolve
 * @param connections - Available connections
 * @param currentLocation - Current location identity
 * @param currentOpentasksPath - Path to current .opentasks directory
 * @returns Resolved location or throws on error
 */
export function resolveOpentasksUri(
  uri: string,
  connections: Connection[],
  currentLocation: LocationIdentity,
  currentOpentasksPath: string
): ResolvedLocation {
  const parsed = parseOpentasksUri(uri)
  if (!parsed) {
    throw new Error(`Invalid opentasks URI: ${uri}`)
  }

  const location = resolveLocationTarget(
    uri,
    connections,
    currentLocation,
    currentOpentasksPath
  )

  return {
    ...location,
    nodeId: parsed.nodeId,
  }
}

/**
 * Build an opentasks:// URI from components
 *
 * @param locationHash - Location hash
 * @param nodeId - Node ID
 * @returns Formatted URI string
 */
export function buildOpentasksUri(locationHash: string, nodeId: string): string {
  return `opentasks://${locationHash}/${nodeId}`
}

/**
 * Build a current-location opentasks:// URI
 *
 * @param nodeId - Node ID
 * @returns Formatted URI string
 */
export function buildLocalUri(nodeId: string): string {
  return `opentasks://./${nodeId}`
}
