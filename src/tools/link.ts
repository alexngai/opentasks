/**
 * Link Tool
 *
 * Create and remove edges between nodes in the graph.
 */

import type { GraphStore } from '../graph/store.js'
import type { LinkParams, LinkResult } from './types.js'
import { ToolError } from './types.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (s-xxx, i-xxx, f-xxx, e-xxx)
 */
const LOCAL_ID_PATTERN = /^[sifex]-[a-z0-9]+$/

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an ID is a local node ID (vs a provider URI)
 */
function isLocalId(id: string): boolean {
  return LOCAL_ID_PATTERN.test(id)
}

/**
 * Check if an ID is a provider URI
 */
function isProviderUri(id: string): boolean {
  return id.includes('://')
}

// ============================================================================
// Link Tool Implementation
// ============================================================================

/**
 * Create or remove an edge between nodes
 *
 * @param store - Graph store for data operations
 * @param params - Link parameters
 * @returns Link result with success status
 */
export async function link(store: GraphStore, params: LinkParams): Promise<LinkResult> {
  const { from_id, to_id, type, remove = false, metadata } = params

  // Validate parameters
  if (!from_id) {
    return { success: false, error: 'Missing required parameter: from_id' }
  }
  if (!to_id) {
    return { success: false, error: 'Missing required parameter: to_id' }
  }
  if (!type) {
    return { success: false, error: 'Missing required parameter: type' }
  }

  try {
    if (remove) {
      return await removeEdge(store, from_id, to_id, type)
    } else {
      return await createEdge(store, from_id, to_id, type, metadata)
    }
  } catch (error) {
    if (error instanceof ToolError) {
      return { success: false, error: error.message }
    }
    if (error instanceof Error) {
      // Check for cycle detection
      if (error.message.includes('cycle')) {
        return { success: false, error: 'Would create cycle in dependency graph' }
      }
      return { success: false, error: error.message }
    }
    return { success: false, error: 'Unknown error occurred' }
  }
}

/**
 * Create a new edge between nodes
 */
async function createEdge(
  store: GraphStore,
  from_id: string,
  to_id: string,
  type: LinkParams['type'],
  metadata?: Record<string, unknown>
): Promise<LinkResult> {
  // Validate local nodes exist (skip for provider URIs)
  if (isLocalId(from_id) && !isProviderUri(from_id)) {
    const fromNode = await store.getNode(from_id)
    if (!fromNode) {
      return { success: false, error: `Node not found: ${from_id}` }
    }
  }

  if (isLocalId(to_id) && !isProviderUri(to_id)) {
    const toNode = await store.getNode(to_id)
    if (!toNode) {
      return { success: false, error: `Node not found: ${to_id}` }
    }
  }

  // Create the edge
  const edge = await store.createEdge({
    from_id,
    to_id,
    type,
    metadata,
  })

  return { success: true, edge_id: edge.id }
}

/**
 * Remove an existing edge between nodes
 */
async function removeEdge(
  store: GraphStore,
  from_id: string,
  to_id: string,
  type: LinkParams['type']
): Promise<LinkResult> {
  // Find the edge by from_id, to_id, and type
  const edges = await store.query.edges({ from_id, type })

  const targetEdge = edges.find((e) => e.to_id === to_id)

  if (!targetEdge) {
    // Idempotent: removing non-existent edge succeeds
    return { success: true }
  }

  // Delete the edge
  await store.deleteEdge(targetEdge.id)

  return { success: true }
}
