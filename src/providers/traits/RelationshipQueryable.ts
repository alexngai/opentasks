/**
 * RelationshipQueryable Trait
 *
 * Optional trait for providers that can query relationships/edges.
 * Allows providers to expose their internal relationship data to the
 * federated graph system.
 */

import type { Provider } from '../types.js'
import type { EdgeTypeSupport } from '../../graph/EdgeTypeRegistry.js'

// Re-export for convenience
export type { EdgeTypeSupport } from '../../graph/EdgeTypeRegistry.js'

/**
 * Direction for edge queries
 */
export type EdgeDirection = 'in' | 'out' | 'both'

/**
 * Edge data returned by a provider
 *
 * Uses provider's local ID format (not URIs).
 * The federated graph will convert these to URIs using provider.buildUri().
 */
export interface ProviderEdge {
  /** Source node ID (in provider's local format) */
  from: string

  /** Target node ID (in provider's local format) */
  to: string

  /** Relationship type (e.g., 'blocks', 'parent-of') */
  type: string

  /** Additional relationship metadata */
  metadata?: Record<string, unknown>
}

/**
 * Options for querying edges
 */
export interface QueryEdgesOptions {
  /** Filter by edge type */
  edgeType?: string

  /** Filter by direction relative to the node */
  direction?: EdgeDirection

  /** Maximum number of edges to return */
  limit?: number
}

/**
 * RelationshipQueryable Trait
 *
 * Providers implement this trait to expose their internal relationships
 * to the federated graph system. This is an optional trait - providers
 * that don't track relationships can skip implementing this.
 *
 * @example
 * ```typescript
 * class BeadsProvider implements Provider, RelationshipQueryable {
 *   async queryEdges(nodeId: string, options?: QueryEdgesOptions) {
 *     // Use `bd show <id> --json` to get blockedBy, blocks, etc.
 *     const data = await this.beadsCli.show(nodeId, { json: true })
 *     return this.parseEdges(data)
 *   }
 *
 *   supportedEdgeTypes(): EdgeTypeSupport[] {
 *     return [
 *       { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
 *       { type: 'parent-child', canQuery: true, canCreate: true, canDelete: true },
 *     ]
 *   }
 * }
 * ```
 */
export interface RelationshipQueryable {
  /**
   * Query edges for a node
   *
   * Returns edges in provider's local ID format.
   * The federated graph will convert IDs to URIs using provider.buildUri().
   *
   * @param nodeId - The node ID (in provider's local format)
   * @param options - Query options (edgeType, direction, limit)
   * @returns Array of edges involving this node
   */
  queryEdges(nodeId: string, options?: QueryEdgesOptions): Promise<ProviderEdge[]>

  /**
   * Declare what edge types this provider supports
   *
   * Used by the federated graph to understand provider capabilities
   * and route queries appropriately.
   *
   * @returns Array of edge type support declarations
   */
  supportedEdgeTypes(): EdgeTypeSupport[]
}

/**
 * Type guard to check if a provider implements RelationshipQueryable
 *
 * @param provider - The provider to check
 * @returns True if the provider implements RelationshipQueryable
 *
 * @example
 * ```typescript
 * const provider = registry.resolveProvider(uri)
 * if (provider && isRelationshipQueryable(provider)) {
 *   const edges = await provider.queryEdges(nodeId, { direction: 'out' })
 * }
 * ```
 */
export function isRelationshipQueryable(
  provider: Provider
): provider is Provider & RelationshipQueryable {
  const p = provider as unknown as RelationshipQueryable
  return typeof p.queryEdges === 'function' && typeof p.supportedEdgeTypes === 'function'
}

/**
 * Filter edges by type
 *
 * @param edges - Array of edges to filter
 * @param edgeType - Edge type to filter by
 * @returns Filtered edges
 */
export function filterEdgesByType(
  edges: ProviderEdge[],
  edgeType: string
): ProviderEdge[] {
  return edges.filter((e) => e.type === edgeType)
}

/**
 * Filter edges by direction relative to a node
 *
 * @param edges - Array of edges to filter
 * @param nodeId - The reference node ID
 * @param direction - Direction to filter by
 * @returns Filtered edges
 */
export function filterEdgesByDirection(
  edges: ProviderEdge[],
  nodeId: string,
  direction: EdgeDirection
): ProviderEdge[] {
  switch (direction) {
    case 'in':
      return edges.filter((e) => e.to === nodeId)
    case 'out':
      return edges.filter((e) => e.from === nodeId)
    case 'both':
      return edges.filter((e) => e.from === nodeId || e.to === nodeId)
  }
}

/**
 * Get the neighbor node ID from an edge relative to a node
 *
 * @param edge - The edge
 * @param nodeId - The reference node ID
 * @returns The neighbor's ID or null if nodeId is not in the edge
 */
export function getNeighborFromEdge(
  edge: ProviderEdge,
  nodeId: string
): string | null {
  if (edge.from === nodeId) return edge.to
  if (edge.to === nodeId) return edge.from
  return null
}
