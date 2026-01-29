/**
 * Hydrating Federated Graph for OpenTasks
 *
 * Extends FederatedGraph with provider federation, hydration, and caching.
 * Fetches missing data on-demand from providers and caches it to SQLite.
 */

import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { Storage } from '../storage/interface.js'
import type { ProviderRegistry, Provider, ProviderNode } from '../providers/types.js'
import type { GraphologyAdapter, NodeURI, GraphNodeAttributes } from './GraphologyAdapter.js'
import type { FederatedGraph, RelatedOptions, ReachableOptions, ShortestPathOptions } from './FederatedGraph.js'
import { FederatedGraphImpl } from './FederatedGraph.js'
import { isRelationshipQueryable, type ProviderEdge } from '../providers/traits/RelationshipQueryable.js'
import { generateIdFromUuid } from '../core/id.js'

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Default TTL in milliseconds (default: 5 minutes) */
  defaultTTL: number

  /** Return stale data while refreshing in background */
  staleWhileRevalidate: boolean

  /** Per-provider TTL overrides in milliseconds */
  providerTTL: Record<string, number>
}

/**
 * Default cache configuration
 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  defaultTTL: 5 * 60 * 1000, // 5 minutes
  staleWhileRevalidate: true,
  providerTTL: {},
}

/**
 * Options for federated ready() query
 */
export interface FederatedReadyOptions {
  /** Filter by node type */
  type?: string

  /** Filter by status (default: 'open') */
  status?: string

  /** Filter by tags (must have all) */
  tags?: string[]

  /** Filter by provider (e.g., 'native', 'beads') */
  providers?: string[]

  /** Maximum number of results */
  limit?: number
}

/**
 * Statuses considered "closed" for blocker checking
 */
const CLOSED_STATUSES = ['closed', 'done', 'resolved', 'completed', 'cancelled']

/**
 * Resolved node with full data and edges
 */
export interface ResolvedNode {
  /** Node URI */
  uri: NodeURI

  /** Provider that owns this node */
  provider: string

  /** Full node data */
  data: StoredNode

  /** Known edges */
  edges: {
    incoming: StoredEdge[]
    outgoing: StoredEdge[]
  }

  /** Was this data from cache? */
  cached: boolean

  /** When the data was cached (ISO 8601) */
  cachedAt?: string
}

/**
 * Hydrating Federated Graph Interface
 *
 * Extends FederatedGraph with hydration and resolution methods.
 */
export interface HydratingFederatedGraph extends FederatedGraph {
  /**
   * Ensure a node and its edges are in the graph
   * Fetches from provider if not present or stale
   *
   * @param uri - Node URI to hydrate
   */
  hydrate(uri: NodeURI): Promise<void>

  /**
   * Resolve a URI to full node data
   * Fetches from provider if not cached
   *
   * @param uri - Node URI
   * @returns Resolved node or null if not found
   */
  resolve(uri: NodeURI): Promise<ResolvedNode | null>

  /**
   * Batch resolve multiple URIs
   *
   * @param uris - Array of node URIs
   * @returns Map of URI to resolved node
   */
  resolveAll(uris: NodeURI[]): Promise<Map<NodeURI, ResolvedNode>>

  /**
   * Invalidate cached data for a provider
   *
   * @param providerName - Name of the provider
   */
  invalidateCache(providerName: string): Promise<void>

  /**
   * Check if cached data for a node is stale
   *
   * @param uri - Node URI
   * @returns True if the node needs refresh
   */
  isStale(uri: NodeURI): boolean

  /**
   * Get nodes that are ready to work on (no active blockers)
   *
   * This is a federated query that considers blockers from all providers,
   * including external systems like Beads or Jira.
   *
   * @param options - Query options (type, status, tags, providers, limit)
   * @returns Array of ready node URIs
   */
  ready(options?: FederatedReadyOptions): Promise<NodeURI[]>
}

/**
 * Configuration for HydratingFederatedGraph
 */
export interface HydratingFederatedGraphConfig {
  /** Storage for caching nodes and edges */
  storage: Storage

  /** Provider registry for resolving URIs */
  providerRegistry: ProviderRegistry

  /** Cache configuration */
  cacheConfig?: Partial<CacheConfig>
}

/**
 * Implementation of HydratingFederatedGraph
 */
export class HydratingFederatedGraphImpl extends FederatedGraphImpl implements HydratingFederatedGraph {
  private readonly storage: Storage
  private readonly providerRegistry: ProviderRegistry
  private readonly cacheConfig: CacheConfig

  constructor(
    adapter: GraphologyAdapter,
    config: HydratingFederatedGraphConfig
  ) {
    super(adapter)
    this.storage = config.storage
    this.providerRegistry = config.providerRegistry
    this.cacheConfig = {
      ...DEFAULT_CACHE_CONFIG,
      ...config.cacheConfig,
    }
  }

  async hydrate(uri: NodeURI): Promise<void> {
    // Check if node exists and is fresh
    if (this.adapter.hasNode(uri) && !this.isStale(uri)) {
      return // Already hydrated and fresh
    }

    // Find provider for this URI
    const provider = this.providerRegistry.resolveProvider(uri)
    if (!provider) {
      return // Unknown provider, can't hydrate
    }

    // Parse URI to get local ID
    const parsed = provider.parseUri(uri)
    if (!parsed) {
      return // Invalid URI
    }

    // Fetch node from provider
    const providerNode = await provider.get(parsed.id)
    if (!providerNode) {
      return // Node not found
    }

    // Convert to stored node format
    const now = new Date().toISOString()
    const storedNode = this.providerNodeToStoredNode(providerNode, provider.name, now)

    // Cache to SQLite (as external node)
    try {
      const existing = await this.storage.getNode(storedNode.id)
      if (existing) {
        await this.storage.updateNode(storedNode.id, {
          ...storedNode,
          updated_at: now,
          cached_at: now,
        })
      } else {
        await this.storage.createNode(storedNode)
      }
    } catch {
      // Ignore cache errors, still hydrate graph
    }

    // Update in-memory graph
    this.adapter.hydrateNode(uri, storedNode)

    // If provider supports edges, fetch and cache those too
    if (isRelationshipQueryable(provider)) {
      const edges = await provider.queryEdges(parsed.id)
      const storedEdges = edges.map((e) =>
        this.providerEdgeToStoredEdge(e, provider, now)
      )

      // Cache edges to SQLite
      for (const edge of storedEdges) {
        try {
          const existing = await this.storage.getEdge(edge.id)
          if (!existing) {
            await this.storage.createEdge(edge)
          }
        } catch {
          // Ignore cache errors
        }
      }

      // Update in-memory graph
      this.adapter.hydrateEdges(uri, storedEdges)
    }
  }

  async resolve(uri: NodeURI): Promise<ResolvedNode | null> {
    // Try to hydrate first
    await this.hydrate(uri)

    // Get from graph
    const nodeAttrs = this.adapter.getNode(uri)
    if (!nodeAttrs) {
      return null
    }

    // Determine provider
    const provider = this.providerRegistry.resolveProvider(uri)
    const providerName = provider?.name ?? 'unknown'

    // Get edges
    const edges = this.adapter.getEdges(uri, 'both')
    const incoming: StoredEdge[] = []
    const outgoing: StoredEdge[] = []

    const graph = this.adapter.graph
    for (const edgeKey of graph.inEdges(uri)) {
      const attrs = graph.getEdgeAttributes(edgeKey)
      incoming.push({
        id: attrs.id,
        uuid: '', // Not stored in graph attributes
        from_id: graph.source(edgeKey),
        to_id: uri,
        type: attrs.type,
        created_at: '', // Not stored in graph attributes
        source: attrs.source,
        cached_at: attrs.cached_at,
        metadata: attrs.metadata,
      })
    }

    for (const edgeKey of graph.outEdges(uri)) {
      const attrs = graph.getEdgeAttributes(edgeKey)
      outgoing.push({
        id: attrs.id,
        uuid: '', // Not stored in graph attributes
        from_id: uri,
        to_id: graph.target(edgeKey),
        type: attrs.type,
        created_at: '', // Not stored in graph attributes
        source: attrs.source,
        cached_at: attrs.cached_at,
        metadata: attrs.metadata,
      })
    }

    return {
      uri,
      provider: providerName,
      data: nodeAttrs.data,
      edges: { incoming, outgoing },
      cached: !!nodeAttrs.cached_at,
      cachedAt: nodeAttrs.cached_at,
    }
  }

  async resolveAll(uris: NodeURI[]): Promise<Map<NodeURI, ResolvedNode>> {
    const results = new Map<NodeURI, ResolvedNode>()

    // Hydrate all in parallel
    await Promise.all(uris.map((uri) => this.hydrate(uri)))

    // Resolve each
    for (const uri of uris) {
      const resolved = await this.resolve(uri)
      if (resolved) {
        results.set(uri, resolved)
      }
    }

    return results
  }

  async invalidateCache(providerName: string): Promise<void> {
    // Find all nodes from this provider in the graph
    const nodesToInvalidate: NodeURI[] = []

    for (const uri of this.adapter.graph.nodes()) {
      const attrs = this.adapter.graph.getNodeAttributes(uri)
      if (attrs.source === providerName) {
        nodesToInvalidate.push(uri)
      }
    }

    // Mark as stale by clearing cached_at
    for (const uri of nodesToInvalidate) {
      this.adapter.graph.setNodeAttribute(uri, 'cached_at', undefined)
    }
  }

  isStale(uri: NodeURI): boolean {
    if (!this.adapter.hasNode(uri)) {
      return true // Not present means stale
    }

    const attrs = this.adapter.getNode(uri)
    if (!attrs?.cached_at) {
      // Native nodes (no cached_at) are never stale
      // External nodes without cached_at are stale
      return attrs?.source !== undefined
    }

    const provider = this.providerRegistry.resolveProvider(uri)
    const providerName = provider?.name ?? 'default'
    const ttl = this.cacheConfig.providerTTL[providerName] ?? this.cacheConfig.defaultTTL

    const cachedTime = new Date(attrs.cached_at).getTime()
    const age = Date.now() - cachedTime

    return age > ttl
  }

  async ready(options: FederatedReadyOptions = {}): Promise<NodeURI[]> {
    const readyNodes: NodeURI[] = []

    // Query candidate nodes from storage
    // Default to open issues if no filters specified
    const candidateNodes = await this.storage.queryNodes({
      type: (options.type as 'spec' | 'issue' | 'feedback' | 'external') ?? 'issue',
      status: options.status ?? 'open',
      archived: false,
      tags: options.tags,
    })

    // Process each candidate
    for (const node of candidateNodes) {
      const uri = this.adapter.nodeToUri(node)

      // Filter by provider if specified
      if (options.providers && options.providers.length > 0) {
        const provider = this.providerRegistry.resolveProvider(uri)
        const providerName = provider?.name ?? 'native'
        if (!options.providers.includes(providerName)) {
          continue
        }
      }

      // Get all blockers (incoming 'blocks' edges)
      const blockerUris = this.related(uri, { edgeType: 'blocks', direction: 'in' })

      // Check if any blocker is still active
      let hasActiveBlocker = false

      for (const blockerUri of blockerUris) {
        // Resolve the blocker to get its status
        const resolved = await this.resolve(blockerUri)

        if (resolved) {
          // Check status - use external_status for external nodes
          const status = resolved.data.external_status ?? resolved.data.status

          // If status is not in closed statuses, it's an active blocker
          if (status && !CLOSED_STATUSES.includes(status.toLowerCase())) {
            hasActiveBlocker = true
            break
          }

          // If no status at all, consider it active (conservative approach)
          if (!status) {
            hasActiveBlocker = true
            break
          }
        } else {
          // Can't resolve blocker - try checking the in-memory graph
          const blockerAttrs = this.adapter.getNode(blockerUri)
          if (blockerAttrs) {
            const status = blockerAttrs.data.external_status ?? blockerAttrs.data.status
            if (!status || !CLOSED_STATUSES.includes(status.toLowerCase())) {
              hasActiveBlocker = true
              break
            }
          }
          // If we can't resolve and can't find in graph, skip (don't block)
        }
      }

      if (!hasActiveBlocker) {
        readyNodes.push(uri)
      }

      // Check limit
      if (options.limit && readyNodes.length >= options.limit) {
        break
      }
    }

    return readyNodes
  }

  // === Private Helper Methods ===

  private providerNodeToStoredNode(
    node: ProviderNode,
    providerName: string,
    cachedAt: string
  ): StoredNode {
    const uuid = crypto.randomUUID()
    return {
      id: generateIdFromUuid('external', uuid).id,
      uuid,
      type: 'external',
      title: node.title,
      content: node.content,
      status: node.status,
      priority: node.priority,
      uri: node.uri,
      source: providerName,
      materialized: true,
      cached_at: cachedAt,
      external_status: node.status,
      created_at: cachedAt,
      updated_at: cachedAt,
    }
  }

  private providerEdgeToStoredEdge(
    edge: ProviderEdge,
    provider: Provider,
    cachedAt: string
  ): StoredEdge {
    // Convert local IDs to URIs
    const fromUri = provider.buildUri(edge.from)
    const toUri = provider.buildUri(edge.to)
    const uuid = crypto.randomUUID()

    return {
      id: generateIdFromUuid('edge', uuid).id,
      uuid,
      from_id: fromUri,
      to_id: toUri,
      type: edge.type,
      created_at: cachedAt,
      source: provider.name,
      cached_at: cachedAt,
      metadata: edge.metadata,
    }
  }
}

/**
 * Create a HydratingFederatedGraph instance
 *
 * @param adapter - The GraphologyAdapter to use
 * @param config - Configuration including storage and provider registry
 * @returns A HydratingFederatedGraph instance
 */
export function createHydratingFederatedGraph(
  adapter: GraphologyAdapter,
  config: HydratingFederatedGraphConfig
): HydratingFederatedGraph {
  return new HydratingFederatedGraphImpl(adapter, config)
}
