/**
 * Federated Graph for OpenTasks
 *
 * Provides unified traversal API over the in-memory Graphology graph.
 * Supports queries across providers with lazy hydration (hydration handled separately).
 */

import { bidirectional } from 'graphology-shortest-path';
import type { GraphologyAdapter, NodeURI, GraphNodeAttributes } from './GraphologyAdapter.js';
import type { EdgeTypeDefinition, EdgeTypeRegistry } from './EdgeTypeRegistry.js';
import { getEdgeTypeRegistry } from './EdgeTypeRegistry.js';

/**
 * Direction for edge traversal
 */
export type TraversalDirection = 'in' | 'out' | 'both';

/**
 * Options for related() query
 */
export interface RelatedOptions {
  /** Edge type to filter by */
  edgeType?: string | string[];

  /** Direction of edges to follow */
  direction?: TraversalDirection;
}

/**
 * Options for reachable() query
 */
export interface ReachableOptions {
  /** Edge type(s) to follow */
  edgeType?: string | string[];

  /** Direction of edges to follow */
  direction?: TraversalDirection;

  /** Maximum traversal depth (default: Infinity) */
  maxDepth?: number;
}

/**
 * Options for shortestPath() query
 */
export interface ShortestPathOptions {
  /** Edge types to consider (default: all) */
  edgeTypes?: string[];
}

/**
 * Predicate function for filtering nodes during traversal
 */
export type NodePredicate = (uri: NodeURI, attrs: GraphNodeAttributes | null) => boolean;

/**
 * A single step in a traversal pattern
 */
export interface EdgeStep {
  /** Edge type to follow */
  type: string;

  /** Direction to traverse */
  direction: TraversalDirection;

  /** Minimum number of hops (default: 1) */
  minHops?: number;

  /** Maximum number of hops (default: 1, use Infinity for transitive) */
  maxHops?: number;
}

/**
 * Pattern for multi-step graph traversal
 */
export interface TraversalPattern {
  /** Sequence of edge steps to follow */
  steps: EdgeStep[];

  /** Maximum total results to return */
  limit?: number;

  /** Filter predicate applied to each node before yielding */
  filter?: NodePredicate;
}

/**
 * Result from a traversal step
 */
export interface TraversalResult {
  /** The node URI reached */
  uri: NodeURI;

  /** Total depth from start (sum of all steps) */
  depth: number;

  /** Full path from start to this node */
  path: NodeURI[];

  /** The step index that led to this result */
  stepIndex: number;

  /** The edge type that led here */
  edgeType: string;
}

/**
 * Selector type for convenience syntax
 *
 * - `+uri` - Children (direct outgoing edges)
 * - `uri+` - Descendants (transitive outgoing edges)
 * - `@uri` - Neighbors (all directly connected nodes)
 */
export type SelectorType = 'children' | 'descendants' | 'neighbors' | 'literal';

/**
 * Parsed selector result
 */
export interface ParsedSelector {
  /** The type of selector */
  type: SelectorType;

  /** The base URI (without selector prefix/suffix) */
  uri: NodeURI;

  /** Original selector string */
  original: string;
}

/**
 * Graph capabilities summary
 */
export interface GraphCapabilities {
  /** All supported edge types */
  edgeTypes: EdgeTypeDefinition[];

  /** Edge types that affect ready status */
  readyAffectingTypes: string[];

  /** Provider-specific capabilities */
  providers: Map<string, EdgeTypeDefinition[]>;
}

/**
 * Federated Graph Interface
 *
 * Provides unified traversal API over multiple providers.
 */
export interface FederatedGraph {
  /** The underlying Graphology adapter */
  readonly adapter: GraphologyAdapter;

  /**
   * Get directly related nodes (single hop)
   *
   * @param uri - Starting node URI
   * @param options - Query options (edgeType, direction)
   * @returns Array of neighboring node URIs
   */
  related(uri: NodeURI, options?: RelatedOptions): NodeURI[];

  /**
   * Get transitively reachable nodes (multi-hop)
   *
   * @param uri - Starting node URI
   * @param options - Query options (edgeType, direction, maxDepth)
   * @returns Array of reachable node URIs (not including start)
   */
  reachable(uri: NodeURI, options?: ReachableOptions): NodeURI[];

  /**
   * Find shortest path between two nodes
   *
   * @param from - Starting node URI
   * @param to - Target node URI
   * @param options - Query options (edgeTypes)
   * @returns Array of node URIs forming the path, or null if no path exists
   */
  shortestPath(from: NodeURI, to: NodeURI, options?: ShortestPathOptions): NodeURI[] | null;

  /**
   * Check if a path exists between two nodes
   *
   * @param from - Starting node URI
   * @param to - Target node URI
   * @param options - Query options (edgeTypes)
   * @returns True if a path exists
   */
  hasPath(from: NodeURI, to: NodeURI, options?: ShortestPathOptions): boolean;

  /**
   * Get node data by URI
   *
   * @param uri - Node URI
   * @returns Node attributes or null if not found
   */
  getNode(uri: NodeURI): GraphNodeAttributes | null;

  /**
   * Check if a node exists in the graph
   *
   * @param uri - Node URI
   * @returns True if the node exists
   */
  hasNode(uri: NodeURI): boolean;

  /**
   * Get all nodes in the graph
   *
   * @returns Array of all node URIs
   */
  nodes(): NodeURI[];

  /**
   * Get graph statistics
   */
  stats(): { nodes: number; edges: number };

  /**
   * Advanced traversal with multi-step patterns
   *
   * Enables complex queries like "find all specs → implementing issues → their blockers"
   * Uses async iteration for lazy evaluation.
   *
   * @param startUris - Starting node URI(s)
   * @param pattern - Traversal pattern with steps
   * @returns Async iterable of traversal results
   *
   * @example
   * ```typescript
   * // Find all issues that implement specs, then their transitive blockers
   * const pattern = {
   *   steps: [
   *     { type: 'implements', direction: 'in' },
   *     { type: 'blocks', direction: 'in', maxHops: Infinity }
   *   ]
   * }
   * for await (const result of graph.traverse(['native://s-abc'], pattern)) {
   *   console.log(result.uri, result.depth, result.path)
   * }
   * ```
   */
  traverse(
    startUris: NodeURI | NodeURI[],
    pattern: TraversalPattern,
  ): AsyncIterable<TraversalResult>;

  // === Selector Syntax ===

  /**
   * Parse a selector string into its components
   *
   * Supports:
   * - `+uri` - Children (direct outgoing neighbors)
   * - `uri+` - Descendants (transitive outgoing, infinite depth)
   * - `@uri` - Neighbors (all directly connected nodes, both directions)
   * - `uri` - Literal URI (no expansion)
   *
   * @param selector - The selector string to parse
   * @returns Parsed selector with type and base URI
   *
   * @example
   * ```typescript
   * graph.parseSelector('+native://s-abc')  // { type: 'children', uri: 'native://s-abc' }
   * graph.parseSelector('native://s-abc+')  // { type: 'descendants', uri: 'native://s-abc' }
   * graph.parseSelector('@native://i-123')  // { type: 'neighbors', uri: 'native://i-123' }
   * graph.parseSelector('native://i-123')   // { type: 'literal', uri: 'native://i-123' }
   * ```
   */
  parseSelector(selector: string): ParsedSelector;

  /**
   * Expand a selector into node URIs
   *
   * @param selector - Selector string (with +, @, etc.) or plain URI
   * @param options - Optional edge type filter for expansion
   * @returns Array of matching node URIs
   *
   * @example
   * ```typescript
   * // Get all children of a spec
   * graph.expandSelector('+native://s-abc')
   *
   * // Get all descendants following 'implements' edges
   * graph.expandSelector('native://s-abc+', { edgeType: 'implements' })
   *
   * // Get all neighbors
   * graph.expandSelector('@native://i-123')
   * ```
   */
  expandSelector(selector: string, options?: RelatedOptions): NodeURI[];

  // === Introspection ===

  /**
   * Get all registered edge types
   *
   * @returns Array of edge type definitions
   */
  edgeTypes(): EdgeTypeDefinition[];

  /**
   * Get graph capabilities including supported edge types per provider
   *
   * @returns Capabilities summary
   */
  capabilities(): GraphCapabilities;
}

/**
 * Implementation of FederatedGraph
 */
export class FederatedGraphImpl implements FederatedGraph {
  constructor(readonly adapter: GraphologyAdapter) {}

  related(uri: NodeURI, options: RelatedOptions = {}): NodeURI[] {
    const { edgeType, direction = 'both' } = options;

    if (!this.adapter.hasNode(uri)) {
      return [];
    }

    const edgeTypes = normalizeEdgeTypes(edgeType);
    const results: NodeURI[] = [];
    const graph = this.adapter.graph;

    if (direction === 'in' || direction === 'both') {
      for (const edgeKey of graph.inEdges(uri)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (matchesEdgeType(type, edgeTypes)) {
          results.push(graph.source(edgeKey));
        }
      }
    }

    if (direction === 'out' || direction === 'both') {
      for (const edgeKey of graph.outEdges(uri)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (matchesEdgeType(type, edgeTypes)) {
          results.push(graph.target(edgeKey));
        }
      }
    }

    // Remove duplicates (can occur with 'both' direction)
    return [...new Set(results)];
  }

  reachable(uri: NodeURI, options: ReachableOptions = {}): NodeURI[] {
    const { edgeType, direction = 'out', maxDepth = Infinity } = options;

    if (!this.adapter.hasNode(uri)) {
      return [];
    }

    const edgeTypes = normalizeEdgeTypes(edgeType);
    const results: NodeURI[] = [];
    const visited = new Set<NodeURI>();
    visited.add(uri); // Don't include start in results

    const traverse = (current: NodeURI, depth: number): void => {
      if (depth >= maxDepth) {
        return;
      }

      const neighbors = this.getNeighbors(current, edgeTypes, direction);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          results.push(neighbor);
          traverse(neighbor, depth + 1);
        }
      }
    };

    traverse(uri, 0);
    return results;
  }

  shortestPath(from: NodeURI, to: NodeURI, options: ShortestPathOptions = {}): NodeURI[] | null {
    const { edgeTypes } = options;

    if (!this.adapter.hasNode(from) || !this.adapter.hasNode(to)) {
      return null;
    }

    // If no edge type filter, use unweighted bidirectional search
    if (!edgeTypes || edgeTypes.length === 0) {
      const path = bidirectional(this.adapter.graph, from, to);
      return path;
    }

    // With edge type filter, use custom BFS that only follows specified edge types
    return this.bfsShortestPath(from, to, edgeTypes);
  }

  /**
   * BFS-based shortest path with edge type filtering
   */
  private bfsShortestPath(from: NodeURI, to: NodeURI, edgeTypes: string[]): NodeURI[] | null {
    if (from === to) {
      return [from];
    }

    const graph = this.adapter.graph;
    const visited = new Set<NodeURI>();
    const parent = new Map<NodeURI, NodeURI>();
    const queue: NodeURI[] = [from];
    visited.add(from);

    while (queue.length > 0) {
      const current = queue.shift()!;

      // Get neighbors through edges of specified types
      for (const edgeKey of graph.outEdges(current)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (edgeTypes.includes(type)) {
          const neighbor = graph.target(edgeKey);
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            parent.set(neighbor, current);

            if (neighbor === to) {
              // Reconstruct path
              const path: NodeURI[] = [to];
              let node = to;
              while (parent.has(node)) {
                node = parent.get(node)!;
                path.unshift(node);
              }
              return path;
            }

            queue.push(neighbor);
          }
        }
      }

      // Also check incoming edges (for undirected traversal)
      for (const edgeKey of graph.inEdges(current)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (edgeTypes.includes(type)) {
          const neighbor = graph.source(edgeKey);
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            parent.set(neighbor, current);

            if (neighbor === to) {
              // Reconstruct path
              const path: NodeURI[] = [to];
              let node = to;
              while (parent.has(node)) {
                node = parent.get(node)!;
                path.unshift(node);
              }
              return path;
            }

            queue.push(neighbor);
          }
        }
      }
    }

    return null; // No path found
  }

  hasPath(from: NodeURI, to: NodeURI, options: ShortestPathOptions = {}): boolean {
    return this.shortestPath(from, to, options) !== null;
  }

  getNode(uri: NodeURI): GraphNodeAttributes | null {
    return this.adapter.getNode(uri);
  }

  hasNode(uri: NodeURI): boolean {
    return this.adapter.hasNode(uri);
  }

  nodes(): NodeURI[] {
    return Array.from(this.adapter.graph.nodes());
  }

  stats(): { nodes: number; edges: number } {
    return {
      nodes: this.adapter.graph.order,
      edges: this.adapter.graph.size,
    };
  }

  async *traverse(
    startUris: NodeURI | NodeURI[],
    pattern: TraversalPattern,
  ): AsyncIterable<TraversalResult> {
    const starts = Array.isArray(startUris) ? startUris : [startUris];
    const { steps, limit, filter } = pattern;

    if (steps.length === 0) {
      return;
    }

    let yieldCount = 0;

    // Process each starting node
    for (const startUri of starts) {
      if (!this.adapter.hasNode(startUri)) {
        continue;
      }

      // Use a queue for BFS traversal through steps
      // Each queue item: [currentUris, stepIndex, currentDepth, pathSoFar]
      type QueueItem = {
        uris: NodeURI[];
        stepIndex: number;
        depth: number;
        basePath: NodeURI[];
      };

      const queue: QueueItem[] = [
        {
          uris: [startUri],
          stepIndex: 0,
          depth: 0,
          basePath: [startUri],
        },
      ];

      while (queue.length > 0) {
        const item = queue.shift()!;
        const { uris, stepIndex, depth, basePath } = item;

        if (stepIndex >= steps.length) {
          continue;
        }

        const step = steps[stepIndex];
        const minHops = step.minHops ?? 1;
        const maxHops = step.maxHops ?? 1;
        const edgeTypes = [step.type];

        // For each URI at this step, traverse according to step parameters
        for (const uri of uris) {
          // Track visited within this step to avoid cycles
          const visitedInStep = new Set<NodeURI>();
          visitedInStep.add(uri);

          // BFS for this step's traversal
          const stepQueue: Array<{ uri: NodeURI; hopDepth: number; path: NodeURI[] }> = [
            { uri, hopDepth: 0, path: basePath },
          ];

          while (stepQueue.length > 0) {
            const current = stepQueue.shift()!;

            if (current.hopDepth >= maxHops) {
              continue;
            }

            // Get neighbors for this hop
            const neighbors = this.getNeighbors(current.uri, edgeTypes, step.direction);

            for (const neighbor of neighbors) {
              if (visitedInStep.has(neighbor)) {
                continue;
              }
              visitedInStep.add(neighbor);

              const newHopDepth = current.hopDepth + 1;
              const newPath = [...current.path, neighbor];
              const totalDepth = depth + newHopDepth;

              // Yield result if we're at or past minHops
              if (newHopDepth >= minHops) {
                // Apply filter if provided
                if (filter) {
                  const attrs = this.adapter.getNode(neighbor);
                  if (!filter(neighbor, attrs)) {
                    // Skip this node but continue traversing through it
                    if (newHopDepth < maxHops) {
                      stepQueue.push({
                        uri: neighbor,
                        hopDepth: newHopDepth,
                        path: newPath,
                      });
                    }
                    continue;
                  }
                }

                yield {
                  uri: neighbor,
                  depth: totalDepth,
                  path: newPath,
                  stepIndex,
                  edgeType: step.type,
                };

                yieldCount++;
                if (limit && yieldCount >= limit) {
                  return;
                }

                // If there are more steps, queue the next step starting from this node
                if (stepIndex + 1 < steps.length) {
                  queue.push({
                    uris: [neighbor],
                    stepIndex: stepIndex + 1,
                    depth: totalDepth,
                    basePath: newPath,
                  });
                }
              }

              // Continue traversing if we haven't reached maxHops
              if (newHopDepth < maxHops) {
                stepQueue.push({
                  uri: neighbor,
                  hopDepth: newHopDepth,
                  path: newPath,
                });
              }
            }
          }
        }
      }
    }
  }

  // === Selector Syntax ===

  parseSelector(selector: string): ParsedSelector {
    // Check for prefix selector: +uri (children)
    if (selector.startsWith('+')) {
      return {
        type: 'children',
        uri: selector.slice(1),
        original: selector,
      };
    }

    // Check for suffix selector: uri+ (descendants)
    if (selector.endsWith('+')) {
      return {
        type: 'descendants',
        uri: selector.slice(0, -1),
        original: selector,
      };
    }

    // Check for neighbor selector: @uri
    if (selector.startsWith('@')) {
      return {
        type: 'neighbors',
        uri: selector.slice(1),
        original: selector,
      };
    }

    // Literal URI
    return {
      type: 'literal',
      uri: selector,
      original: selector,
    };
  }

  expandSelector(selector: string, options: RelatedOptions = {}): NodeURI[] {
    const parsed = this.parseSelector(selector);

    switch (parsed.type) {
      case 'literal':
        // Return the URI itself if it exists
        return this.adapter.hasNode(parsed.uri) ? [parsed.uri] : [];

      case 'children':
        // Direct outgoing neighbors (single hop)
        return this.related(parsed.uri, {
          ...options,
          direction: 'out',
        });

      case 'descendants':
        // Transitive outgoing (infinite depth)
        return this.reachable(parsed.uri, {
          edgeType: options.edgeType,
          direction: 'out',
          maxDepth: Infinity,
        });

      case 'neighbors':
        // All directly connected nodes (both directions)
        return this.related(parsed.uri, {
          ...options,
          direction: 'both',
        });
    }
  }

  // === Introspection ===

  edgeTypes(): EdgeTypeDefinition[] {
    return getEdgeTypeRegistry().getAll();
  }

  capabilities(): GraphCapabilities {
    const registry = getEdgeTypeRegistry();
    const allTypes = registry.getAll();
    const readyTypes = registry.getReadyAffectingTypes();

    // Build provider map
    const providers = new Map<string, EdgeTypeDefinition[]>();
    const providerNames = new Set<string>();

    for (const type of allTypes) {
      for (const provider of type.providers) {
        providerNames.add(provider);
      }
    }

    for (const provider of providerNames) {
      providers.set(provider, registry.getTypesForProvider(provider));
    }

    return {
      edgeTypes: allTypes,
      readyAffectingTypes: readyTypes,
      providers,
    };
  }

  // === Private Helper Methods ===

  private getNeighbors(
    uri: NodeURI,
    edgeTypes: string[] | null,
    direction: TraversalDirection,
  ): NodeURI[] {
    const graph = this.adapter.graph;
    const neighbors: NodeURI[] = [];

    if (direction === 'in' || direction === 'both') {
      for (const edgeKey of graph.inEdges(uri)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (matchesEdgeType(type, edgeTypes)) {
          neighbors.push(graph.source(edgeKey));
        }
      }
    }

    if (direction === 'out' || direction === 'both') {
      for (const edgeKey of graph.outEdges(uri)) {
        const type = graph.getEdgeAttribute(edgeKey, 'type');
        if (matchesEdgeType(type, edgeTypes)) {
          neighbors.push(graph.target(edgeKey));
        }
      }
    }

    return neighbors;
  }
}

// === Helper Functions ===

/**
 * Normalize edge type filter to array or null
 */
function normalizeEdgeTypes(edgeType?: string | string[]): string[] | null {
  if (!edgeType) {
    return null;
  }
  if (Array.isArray(edgeType)) {
    return edgeType.length > 0 ? edgeType : null;
  }
  return [edgeType];
}

/**
 * Check if an edge type matches the filter
 */
function matchesEdgeType(type: string, edgeTypes: string[] | null): boolean {
  if (!edgeTypes) {
    return true; // No filter, match all
  }
  return edgeTypes.includes(type);
}

/**
 * Create a FederatedGraph instance
 *
 * @param adapter - The GraphologyAdapter to use
 * @returns A FederatedGraph instance
 */
export function createFederatedGraph(adapter: GraphologyAdapter): FederatedGraph {
  return new FederatedGraphImpl(adapter);
}
