/**
 * Graphology Adapter for OpenTasks
 *
 * Provides an in-memory graph layer over SQLite storage using Graphology.
 * All traversal operations query this graph, while SQLite remains authoritative.
 */

import { MultiDirectedGraph } from 'graphology'
import type { Attributes } from 'graphology-types'
import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { Storage } from '../storage/interface.js'

/**
 * Node URI type - universal identifier across providers
 * Examples: 'native://s-abc', 'beads://./bd-123', 'external://x-456'
 */
export type NodeURI = string

/**
 * Node attributes stored in the graph
 */
export interface GraphNodeAttributes {
  /** Original node ID */
  id: string
  /** Node type */
  type: string
  /** Node title */
  title: string
  /** Node status (if applicable) */
  status?: string
  /** Priority (0-4) */
  priority?: number
  /** Whether node is archived */
  archived?: boolean
  /** When data was cached (for external nodes) */
  cached_at?: string
  /** Source system for external nodes */
  source?: string
  /** Full node data for resolution */
  data: StoredNode
}

/**
 * Edge attributes stored in the graph
 */
export interface GraphEdgeAttributes {
  /** Edge ID */
  id: string
  /** Relationship type */
  type: string
  /** Source system */
  source?: string
  /** When edge was cached (for external edges) */
  cached_at?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Graphology Adapter Interface
 *
 * Provides access to the in-memory graph and methods for syncing with storage.
 */
export interface GraphologyAdapter {
  /** The underlying Graphology graph instance */
  readonly graph: MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>

  /**
   * Load all nodes and edges from storage into the graph
   * Should be called once on startup
   */
  loadFromStorage(storage: Storage): Promise<void>

  // === Sync Methods (called after Storage mutations) ===

  /**
   * Add a node to the graph after it was created in storage
   */
  onNodeCreated(node: StoredNode): void

  /**
   * Update a node in the graph after it was updated in storage
   */
  onNodeUpdated(id: string, updates: Partial<StoredNode>): void

  /**
   * Remove a node from the graph after it was deleted in storage
   */
  onNodeDeleted(id: string): void

  /**
   * Add an edge to the graph after it was created in storage
   */
  onEdgeCreated(edge: StoredEdge): void

  /**
   * Remove an edge from the graph after it was deleted in storage
   */
  onEdgeDeleted(id: string): void

  // === Hydration Methods (for external data) ===

  /**
   * Add or update an external node in the graph
   */
  hydrateNode(uri: NodeURI, node: StoredNode): void

  /**
   * Add edges for a node (typically from provider query)
   */
  hydrateEdges(uri: NodeURI, edges: StoredEdge[]): void

  // === Utility Methods ===

  /**
   * Convert a stored node to its URI
   */
  nodeToUri(node: StoredNode): NodeURI

  /**
   * Check if a node exists in the graph
   */
  hasNode(uri: NodeURI): boolean

  /**
   * Get node attributes by URI
   */
  getNode(uri: NodeURI): GraphNodeAttributes | null

  /**
   * Get all edges for a node
   */
  getEdges(uri: NodeURI, direction?: 'in' | 'out' | 'both'): GraphEdgeAttributes[]

  /**
   * Clear all data from the graph
   */
  clear(): void
}

/**
 * Implementation of GraphologyAdapter
 */
export class GraphologyAdapterImpl implements GraphologyAdapter {
  readonly graph: MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>

  // Track edge IDs to graph edge keys for deletion
  private edgeIdToKey: Map<string, string> = new Map()

  constructor() {
    // Multi-edge directed graph supports multiple edges between same nodes
    this.graph = new MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>()
  }

  async loadFromStorage(storage: Storage): Promise<void> {
    // Clear any existing data
    this.clear()

    // Load all nodes
    const nodes = await storage.queryNodes({ limit: 10000 })
    for (const node of nodes) {
      this.addNodeToGraph(node)
    }

    // Load all edges - we need to query edges for all nodes
    // Since Storage doesn't have a getAllEdges method, we'll query edges for each node
    const processedEdges = new Set<string>()
    for (const node of nodes) {
      const outEdges = await storage.getEdgesFrom(node.id)
      for (const edge of outEdges) {
        if (!processedEdges.has(edge.id)) {
          processedEdges.add(edge.id)
          this.addEdgeToGraph(edge)
        }
      }
    }
  }

  onNodeCreated(node: StoredNode): void {
    this.addNodeToGraph(node)
  }

  onNodeUpdated(id: string, updates: Partial<StoredNode>): void {
    const uri = this.idToUri(id)
    if (!this.graph.hasNode(uri)) {
      return
    }

    const current = this.graph.getNodeAttributes(uri)
    const updatedData = { ...current.data, ...updates }

    this.graph.mergeNodeAttributes(uri, {
      ...current,
      title: updates.title ?? current.title,
      status: updates.status ?? current.status,
      priority: updates.priority ?? current.priority,
      archived: updates.archived ?? current.archived,
      data: updatedData,
    })
  }

  onNodeDeleted(id: string): void {
    const uri = this.idToUri(id)
    if (this.graph.hasNode(uri)) {
      // Graphology automatically removes edges connected to deleted nodes
      this.graph.dropNode(uri)
    }
  }

  onEdgeCreated(edge: StoredEdge): void {
    this.addEdgeToGraph(edge)
  }

  onEdgeDeleted(id: string): void {
    const graphKey = this.edgeIdToKey.get(id)
    if (graphKey && this.graph.hasEdge(graphKey)) {
      this.graph.dropEdge(graphKey)
      this.edgeIdToKey.delete(id)
    }
  }

  hydrateNode(uri: NodeURI, node: StoredNode): void {
    if (this.graph.hasNode(uri)) {
      // Update existing node
      this.graph.mergeNodeAttributes(uri, this.nodeToAttributes(node))
    } else {
      // Add new node
      this.graph.addNode(uri, this.nodeToAttributes(node))
    }
  }

  hydrateEdges(uri: NodeURI, edges: StoredEdge[]): void {
    for (const edge of edges) {
      if (!this.edgeIdToKey.has(edge.id)) {
        this.addEdgeToGraph(edge)
      }
    }
  }

  nodeToUri(node: StoredNode): NodeURI {
    // External nodes have their own URI
    if (node.type === 'external' && node.uri) {
      return node.uri
    }

    // Native nodes use native:// scheme
    return `native://${node.id}`
  }

  hasNode(uri: NodeURI): boolean {
    return this.graph.hasNode(uri)
  }

  getNode(uri: NodeURI): GraphNodeAttributes | null {
    if (!this.graph.hasNode(uri)) {
      return null
    }
    return this.graph.getNodeAttributes(uri)
  }

  getEdges(uri: NodeURI, direction: 'in' | 'out' | 'both' = 'both'): GraphEdgeAttributes[] {
    if (!this.graph.hasNode(uri)) {
      return []
    }

    const edges: GraphEdgeAttributes[] = []

    if (direction === 'in' || direction === 'both') {
      for (const edgeKey of this.graph.inEdges(uri)) {
        edges.push(this.graph.getEdgeAttributes(edgeKey))
      }
    }

    if (direction === 'out' || direction === 'both') {
      for (const edgeKey of this.graph.outEdges(uri)) {
        edges.push(this.graph.getEdgeAttributes(edgeKey))
      }
    }

    return edges
  }

  clear(): void {
    this.graph.clear()
    this.edgeIdToKey.clear()
  }

  // === Private Helper Methods ===

  private addNodeToGraph(node: StoredNode): void {
    const uri = this.nodeToUri(node)
    if (!this.graph.hasNode(uri)) {
      this.graph.addNode(uri, this.nodeToAttributes(node))
    }
  }

  private addEdgeToGraph(edge: StoredEdge): void {
    const fromUri = this.idToUri(edge.from_id)
    const toUri = this.idToUri(edge.to_id)

    // Ensure both nodes exist (create placeholder if needed)
    if (!this.graph.hasNode(fromUri)) {
      this.graph.addNode(fromUri, this.placeholderAttributes(edge.from_id))
    }
    if (!this.graph.hasNode(toUri)) {
      this.graph.addNode(toUri, this.placeholderAttributes(edge.to_id))
    }

    const attributes = this.edgeToAttributes(edge)
    const graphKey = this.graph.addEdge(fromUri, toUri, attributes)
    this.edgeIdToKey.set(edge.id, graphKey)
  }

  private nodeToAttributes(node: StoredNode): GraphNodeAttributes {
    return {
      id: node.id,
      type: node.type,
      title: node.title,
      status: node.status,
      priority: node.priority,
      archived: node.archived,
      cached_at: node.cached_at,
      source: node.source,
      data: node,
    }
  }

  private edgeToAttributes(edge: StoredEdge): GraphEdgeAttributes {
    return {
      id: edge.id,
      type: edge.type,
      source: edge.source,
      cached_at: edge.cached_at,
      metadata: edge.metadata,
    }
  }

  private placeholderAttributes(id: string): GraphNodeAttributes {
    return {
      id,
      type: 'external',
      title: `Unresolved: ${id}`,
      data: {
        id,
        uuid: '',
        type: 'external',
        title: `Unresolved: ${id}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }
  }

  /**
   * Convert an ID to URI
   * If it looks like a URI (contains ://), return as-is
   * Otherwise, wrap in native:// scheme
   */
  private idToUri(id: string): NodeURI {
    if (id.includes('://')) {
      return id
    }
    return `native://${id}`
  }
}

/**
 * Create a new GraphologyAdapter instance
 */
export function createGraphologyAdapter(): GraphologyAdapter {
  return new GraphologyAdapterImpl()
}
