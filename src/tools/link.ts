/**
 * Link Tool
 *
 * Create and remove edges between nodes in the graph.
 */

import type { GraphStore } from '../graph/store.js';
import type { LinkParams, LinkResult, OperationContext } from './types.js';
import { ToolError } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Pattern for local node IDs (c-xxx, t-xxx, f-xxx, e-xxx)
 */
const LOCAL_ID_PATTERN = /^[ctfexa]-[a-z0-9]+$/;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an ID is a local node ID (vs a provider URI)
 */
function isLocalId(id: string): boolean {
  return LOCAL_ID_PATTERN.test(id);
}

/**
 * Check if an ID is a provider URI
 */
function isProviderUri(id: string): boolean {
  return id.includes('://');
}

// ============================================================================
// Link Tool Implementation
// ============================================================================

/**
 * Create or remove an edge between nodes
 *
 * @param store - Graph store for data operations
 * @param params - Link parameters
 * @param context - Optional operation context for tracking agent activity
 * @returns Link result with success status
 */
export async function link(
  store: GraphStore,
  params: LinkParams,
  context?: OperationContext,
): Promise<LinkResult> {
  const { fromId, toId, type, remove = false, metadata } = params;

  // Validate parameters
  if (!fromId) {
    return { success: false, error: 'Missing required parameter: fromId' };
  }
  if (!toId) {
    return { success: false, error: 'Missing required parameter: toId' };
  }
  if (!type) {
    return { success: false, error: 'Missing required parameter: type' };
  }

  try {
    if (remove) {
      return await removeEdge(store, fromId, toId, type, context);
    } else {
      return await createEdge(store, fromId, toId, type, metadata, context);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      return { success: false, error: error.message };
    }
    if (error instanceof Error) {
      // Check for cycle detection
      if (error.message.includes('cycle')) {
        return { success: false, error: 'Would create cycle in dependency graph' };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error occurred' };
  }
}

/**
 * Create a new edge between nodes
 */
async function createEdge(
  store: GraphStore,
  fromId: string,
  toId: string,
  type: LinkParams['type'],
  metadata?: Record<string, unknown>,
  context?: OperationContext,
): Promise<LinkResult> {
  // Validate local nodes exist (skip for provider URIs)
  if (isLocalId(fromId) && !isProviderUri(fromId)) {
    const fromNode = await store.getNode(fromId);
    if (!fromNode) {
      return { success: false, error: `Node not found: ${fromId}` };
    }
  }

  if (isLocalId(toId) && !isProviderUri(toId)) {
    const toNode = await store.getNode(toId);
    if (!toNode) {
      return { success: false, error: `Node not found: ${toId}` };
    }
  }

  // Merge context into metadata for tracking
  const edgeMetadata = context
    ? {
        ...metadata,
        _context: {
          agentId: context.agentId,
          agentName: context.agentName,
          sessionId: context.sessionId,
          timestamp: context.timestamp ?? new Date().toISOString(),
        },
      }
    : metadata;

  // Create the edge (underlying storage uses snake_case)
  const edge = await store.createEdge({
    from_id: fromId,
    to_id: toId,
    type,
    metadata: edgeMetadata,
  });

  return { success: true, edgeId: edge.id };
}

/**
 * Remove an existing edge between nodes
 */
async function removeEdge(
  store: GraphStore,
  fromId: string,
  toId: string,
  type: LinkParams['type'],
  _context?: OperationContext, // Unused but kept for API consistency
): Promise<LinkResult> {
  // Find the edge (underlying storage uses snake_case)
  const edges = await store.query.edges({ from_id: fromId, type });

  const targetEdge = edges.find((e) => e.to_id === toId);

  if (!targetEdge) {
    // Idempotent: removing non-existent edge succeeds
    return { success: true };
  }

  // Delete the edge
  await store.deleteEdge(targetEdge.id);

  return { success: true };
}
