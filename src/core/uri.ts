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
 * Resolved location result
 */
export interface ResolvedLocation {
  /** Path to the .opentasks directory */
  opentasksPath: string
  /** Location hash */
  hash: string
  /** Node ID to access */
  nodeId: string
  /** Whether this is the current location */
  isLocal: boolean
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
 * Resolve an opentasks:// URI to a location and node ID
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

  // Current location shorthand
  if (parsed.relativePath === './') {
    return {
      opentasksPath: currentOpentasksPath,
      hash: currentLocation.hash,
      nodeId: parsed.nodeId,
      isLocal: true,
    }
  }

  // Hash-based resolution
  if (parsed.locationHash) {
    // Check if it's the current location
    if (parsed.locationHash === currentLocation.hash) {
      return {
        opentasksPath: currentOpentasksPath,
        hash: currentLocation.hash,
        nodeId: parsed.nodeId,
        isLocal: true,
      }
    }

    const connection = connections.find((c) => c.hash === parsed.locationHash)
    if (connection) {
      return {
        opentasksPath: connection.path,
        hash: connection.hash,
        nodeId: parsed.nodeId,
        isLocal: false,
      }
    }
    throw new Error(`Unknown location hash: ${parsed.locationHash}`)
  }

  // Absolute path resolution
  if (parsed.absolutePath) {
    const resolvedPath = path.resolve(parsed.absolutePath)

    // Check if it's the current location
    if (path.resolve(currentOpentasksPath) === resolvedPath) {
      return {
        opentasksPath: currentOpentasksPath,
        hash: currentLocation.hash,
        nodeId: parsed.nodeId,
        isLocal: true,
      }
    }

    const connection = connections.find(
      (c) => path.resolve(c.path) === resolvedPath
    )
    if (connection) {
      return {
        opentasksPath: connection.path,
        hash: connection.hash,
        nodeId: parsed.nodeId,
        isLocal: false,
      }
    }

    // Not in connections — direct path access
    return {
      opentasksPath: resolvedPath,
      hash: '',
      nodeId: parsed.nodeId,
      isLocal: false,
    }
  }

  throw new Error(`Cannot resolve URI: ${uri}`)
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
