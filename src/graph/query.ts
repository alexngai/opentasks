/**
 * Query Engine for Graph Operations
 *
 * Provides rich query capabilities for graph traversal and filtering.
 */

import type { Storage } from '../storage/interface.js';
import type { StoredNode, StoredEdge } from '../schema/storage.js';
import type { Node, Task, Context, Feedback, Edge, EdgeType } from '../schema/index.js';
import { parseNode, isTask, isContext, isFeedback } from '../schema/validation.js';
import type {
  NodeFilter,
  EdgeFilter,
  BlockerOptions,
  ReadyOptions,
  FeedbackOptions,
} from './types.js';
import type { NodeFilter as StorageNodeFilter } from '../storage/interface.js';

// ============================================================================
// Cross-Provider Resolution Support
// ============================================================================

/**
 * Pattern for local node IDs (c-, t-, f-, e-, x-)
 */
const LOCAL_ID_PATTERN = /^[ctfex]-[a-z0-9]+$/;

/**
 * Node resolver function for resolving external URIs
 *
 * When provided to the query engine, enables cross-provider query support.
 * The resolver should handle external URIs (e.g., beads://./bd-123) and
 * return the corresponding StoredNode, or null if not found.
 */
export type NodeResolver = (idOrUri: string) => Promise<StoredNode | null>;

/**
 * Options for creating a query engine
 */
export interface QueryEngineOptions {
  /** Storage for native nodes */
  storage: Storage;

  /**
   * Optional resolver for external nodes.
   * If provided, queries like blockers/blocking/ready will resolve external URIs.
   * If not provided, only local node IDs will be resolved.
   */
  nodeResolver?: NodeResolver;
}

// ============================================================================
// Query Engine Interface
// ============================================================================

/**
 * Query engine for graph traversal and filtering
 */
export interface QueryEngine {
  // === Basic Queries ===

  /** Query nodes with filters */
  nodes(filter: NodeFilter): Promise<Node[]>;

  /** Query edges with filters */
  edges(filter: EdgeFilter): Promise<Edge[]>;

  // === Relationship Queries ===

  /** Get edges from a node */
  edgesFrom(nodeId: string, type?: EdgeType): Promise<Edge[]>;

  /** Get edges to a node */
  edgesTo(nodeId: string, type?: EdgeType): Promise<Edge[]>;

  /** Get all edges for a node (both directions) */
  edgesFor(nodeId: string, type?: EdgeType): Promise<Edge[]>;

  // === Dependency Queries ===

  /** What blocks this node? */
  blockers(nodeId: string, options?: BlockerOptions): Promise<Node[]>;

  /** What does this node block? */
  blocking(nodeId: string, options?: BlockerOptions): Promise<Node[]>;

  /** Is there a path from A blocking B? */
  isBlocking(fromId: string, toId: string): Promise<boolean>;

  // === Context/Task Queries ===

  /** Tasks that implement a context */
  tasks(contextId: string): Promise<Task[]>;

  /** Context nodes that a task implements */
  context(taskId: string): Promise<Context[]>;

  // === Hierarchy Queries ===

  /** Get children of a node */
  children(nodeId: string): Promise<Node[]>;

  /** Get parent of a node */
  parent(nodeId: string): Promise<Node | null>;

  /** Get all ancestors */
  ancestors(nodeId: string): Promise<Node[]>;

  /** Get all descendants */
  descendants(nodeId: string): Promise<Node[]>;

  // === Ready Query ===

  /** Get tasks ready to work on (no active blockers) */
  ready(options?: ReadyOptions): Promise<Task[]>;

  // === Feedback Queries ===

  /** Get feedback on a node */
  feedback(targetId: string, options?: FeedbackOptions): Promise<Feedback[]>;

  /** Get unresolved feedback */
  unresolvedFeedback(targetId?: string): Promise<Feedback[]>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert StoredEdge to Edge (they're the same, but for type clarity)
 */
function toEdge(stored: StoredEdge): Edge {
  return stored as Edge;
}

/**
 * Safely parse a node, returning null on error
 * (makes query engine resilient to bad data in storage)
 */
function safeParseNode(stored: StoredNode): Node | null {
  try {
    return parseNode(stored);
  } catch {
    return null;
  }
}

/**
 * Check if a node is active (not closed, not archived)
 */
function isActiveNode(node: StoredNode): boolean {
  return !node.archived && node.status !== 'closed';
}

/**
 * Apply priority filter to nodes
 */
function matchesPriority(
  node: StoredNode,
  filter: number | { min?: number; max?: number } | undefined,
): boolean {
  if (filter === undefined) return true;
  if (node.priority === undefined) return true;

  if (typeof filter === 'number') {
    return node.priority === filter;
  }

  const { min, max } = filter;
  if (min !== undefined && node.priority < min) return false;
  if (max !== undefined && node.priority > max) return false;
  return true;
}

/**
 * Convert graph NodeFilter to storage NodeFilter
 * Handles type differences (archived: null → undefined)
 */
function toStorageFilter(filter: NodeFilter): StorageNodeFilter {
  return {
    type: filter.type,
    status: filter.status,
    tags: filter.tags,
    parent_id: filter.parent_id,
    archived: filter.archived ?? undefined,
    search: filter.search,
    limit: filter.limit,
    offset: filter.offset,
  };
}

// ============================================================================
// Query Engine Implementation
// ============================================================================

/**
 * Create a query engine backed by a storage implementation
 *
 * @param options - Storage instance or QueryEngineOptions object
 * @returns QueryEngine instance
 *
 * @example
 * // Basic usage with storage only (native queries)
 * const engine = createQueryEngine(storage)
 *
 * @example
 * // With node resolver for cross-provider queries
 * const engine = createQueryEngine({
 *   storage,
 *   nodeResolver: async (idOrUri) => {
 *     return providerAwareStore.resolveNode(idOrUri)
 *   }
 * })
 */
export function createQueryEngine(options: QueryEngineOptions | Storage): QueryEngine {
  // Support both old signature (Storage) and new signature (QueryEngineOptions)
  const storage: Storage = 'storage' in options ? options.storage : options;
  const nodeResolver: NodeResolver | undefined =
    'nodeResolver' in options ? options.nodeResolver : undefined;

  /**
   * Resolve a node by ID or URI
   * Uses the nodeResolver for external URIs if available, otherwise falls back to storage
   */
  const resolveNode = async (idOrUri: string): Promise<StoredNode | null> => {
    // For local IDs, always use storage directly
    if (LOCAL_ID_PATTERN.test(idOrUri)) {
      return storage.getNode(idOrUri);
    }

    // For URIs or unknown formats, try resolver first if available
    if (nodeResolver) {
      return nodeResolver(idOrUri);
    }

    // Fallback to storage (might work for materialized external nodes)
    return storage.getNode(idOrUri);
  };

  return {
    // =========================================================================
    // Basic Queries
    // =========================================================================

    async nodes(filter: NodeFilter): Promise<Node[]> {
      const stored = await storage.queryNodes(toStorageFilter(filter));
      return stored.map(safeParseNode).filter((n): n is Node => n !== null);
    },

    async edges(filter: EdgeFilter): Promise<Edge[]> {
      const results: StoredEdge[] = [];

      if (filter.from_id) {
        const fromEdges = await storage.getEdgesFrom(
          filter.from_id,
          filter.type as EdgeType | undefined,
        );
        results.push(...fromEdges);
      } else if (filter.to_id) {
        const toEdges = await storage.getEdgesTo(filter.to_id, filter.type as EdgeType | undefined);
        results.push(...toEdges);
      } else {
        // Full edge enumeration
        const allEdges = await storage.getAllEdges(filter.type as EdgeType | undefined);
        results.push(...allEdges);
      }

      // Apply type filter if we didn't use it in the query
      let filtered = results;
      if (filter.type && !filter.from_id && !filter.to_id) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        filtered = results.filter((e) => types.includes(e.type as EdgeType));
      }

      // Apply pagination
      const offset = filter.offset ?? 0;
      const limit = filter.limit ?? filtered.length;
      const paginated = filtered.slice(offset, offset + limit);

      return paginated.map(toEdge);
    },

    // =========================================================================
    // Relationship Queries
    // =========================================================================

    async edgesFrom(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const stored = await storage.getEdgesFrom(nodeId, type);
      return stored.map(toEdge);
    },

    async edgesTo(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const stored = await storage.getEdgesTo(nodeId, type);
      return stored.map(toEdge);
    },

    async edgesFor(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const [from, to] = await Promise.all([
        storage.getEdgesFrom(nodeId, type),
        storage.getEdgesTo(nodeId, type),
      ]);

      // Combine and deduplicate by ID
      const seen = new Set<string>();
      const all: Edge[] = [];

      for (const edge of [...from, ...to]) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id);
          all.push(toEdge(edge));
        }
      }

      return all;
    },

    // =========================================================================
    // Dependency Queries
    // =========================================================================

    async blockers(nodeId: string, options?: BlockerOptions): Promise<Node[]> {
      const result: Node[] = [];
      const visited = new Set<string>();
      const maxDepth = options?.maxDepth ?? 10;
      const activeOnly = options?.activeOnly ?? true;

      async function collect(id: string, depth: number): Promise<void> {
        if (depth > maxDepth || visited.has(id)) return;
        visited.add(id);

        // Get incoming 'blocks' edges (things that block this node)
        const edges = await storage.getEdgesTo(id, 'blocks');

        for (const edge of edges) {
          // Use resolveNode to support cross-provider resolution
          const blocker = await resolveNode(edge.from_id);
          if (!blocker) continue;

          // Filter by activeOnly
          if (activeOnly && !isActiveNode(blocker)) continue;

          const parsed = safeParseNode(blocker);
          if (parsed) {
            result.push(parsed);
          }

          // Recurse for transitive blockers
          if (options?.transitive) {
            await collect(edge.from_id, depth + 1);
          }
        }
      }

      await collect(nodeId, 0);
      return result;
    },

    async blocking(nodeId: string, options?: BlockerOptions): Promise<Node[]> {
      const result: Node[] = [];
      const visited = new Set<string>();
      const maxDepth = options?.maxDepth ?? 10;
      const activeOnly = options?.activeOnly ?? true;

      async function collect(id: string, depth: number): Promise<void> {
        if (depth > maxDepth || visited.has(id)) return;
        visited.add(id);

        // Get outgoing 'blocks' edges (things this node blocks)
        const edges = await storage.getEdgesFrom(id, 'blocks');

        for (const edge of edges) {
          // Use resolveNode to support cross-provider resolution
          const blocked = await resolveNode(edge.to_id);
          if (!blocked) continue;

          // Filter by activeOnly
          if (activeOnly && !isActiveNode(blocked)) continue;

          const parsed = safeParseNode(blocked);
          if (parsed) {
            result.push(parsed);
          }

          // Recurse for transitive blocking
          if (options?.transitive) {
            await collect(edge.to_id, depth + 1);
          }
        }
      }

      await collect(nodeId, 0);
      return result;
    },

    async isBlocking(fromId: string, toId: string): Promise<boolean> {
      // Check if fromId blocks toId (directly or transitively)
      const visited = new Set<string>();

      async function search(current: string): Promise<boolean> {
        if (current === toId) return true;
        if (visited.has(current)) return false;

        visited.add(current);

        const edges = await storage.getEdgesFrom(current, 'blocks');
        for (const edge of edges) {
          if (await search(edge.to_id)) {
            return true;
          }
        }

        return false;
      }

      return search(fromId);
    },

    // =========================================================================
    // Context/Task Queries
    // =========================================================================

    async tasks(contextId: string): Promise<Task[]> {
      // Get incoming 'implements' edges to the context
      const edges = await storage.getEdgesTo(contextId, 'implements');

      const tasks: Task[] = [];
      for (const edge of edges) {
        // Use resolveNode to support cross-provider resolution
        const node = await resolveNode(edge.from_id);
        if (node) {
          const parsed = safeParseNode(node);
          if (parsed && isTask(parsed)) {
            tasks.push(parsed);
          }
        }
      }

      return tasks;
    },

    async context(taskId: string): Promise<Context[]> {
      // Get outgoing 'implements' edges from the task
      const edges = await storage.getEdgesFrom(taskId, 'implements');

      const contextNodes: Context[] = [];
      for (const edge of edges) {
        // Use resolveNode to support cross-provider resolution
        const node = await resolveNode(edge.to_id);
        if (node) {
          const parsed = safeParseNode(node);
          if (parsed && isContext(parsed)) {
            contextNodes.push(parsed);
          }
        }
      }

      return contextNodes;
    },

    // =========================================================================
    // Hierarchy Queries
    // =========================================================================

    async children(nodeId: string): Promise<Node[]> {
      // Query nodes with parent_id = nodeId
      const stored = await storage.queryNodes({ parent_id: nodeId });
      return stored.map(parseNode).filter((n): n is Node => n !== null);
    },

    async parent(nodeId: string): Promise<Node | null> {
      const node = await storage.getNode(nodeId);
      if (!node || !node.parent_id) return null;

      const parentNode = await storage.getNode(node.parent_id);
      if (!parentNode) return null;

      return safeParseNode(parentNode);
    },

    async ancestors(nodeId: string): Promise<Node[]> {
      const result: Node[] = [];
      let currentId: string | undefined = nodeId;

      while (currentId) {
        const node = await storage.getNode(currentId);
        if (!node || !node.parent_id) break;

        const parentNode = await storage.getNode(node.parent_id);
        if (!parentNode) break;

        const parsed = safeParseNode(parentNode);
        if (parsed) {
          result.push(parsed);
        }

        currentId = parentNode.parent_id;
      }

      return result;
    },

    async descendants(nodeId: string): Promise<Node[]> {
      const result: Node[] = [];
      const visited = new Set<string>();

      async function collect(id: string): Promise<void> {
        if (visited.has(id)) return;
        visited.add(id);

        const children = await storage.queryNodes({ parent_id: id });

        for (const child of children) {
          const parsed = safeParseNode(child);
          if (parsed) {
            result.push(parsed);
            await collect(child.id);
          }
        }
      }

      await collect(nodeId);
      return result;
    },

    // =========================================================================
    // Ready Query
    // =========================================================================

    async ready(options?: ReadyOptions): Promise<Task[]> {
      // Get all open, non-archived tasks
      const taskNodes = await storage.queryNodes({
        type: 'task',
        status: 'open',
        archived: false,
      });

      const readyTasks: Task[] = [];

      for (const task of taskNodes) {
        // Apply additional filters
        if (options?.tags) {
          const nodeTags = task.tags || [];
          const hasAllTags = options.tags.every((t) => nodeTags.includes(t));
          if (!hasAllTags) continue;
        }

        if (!matchesPriority(task, options?.priority)) continue;

        if (options?.assignee && task.assignee !== options.assignee) continue;

        // Check for active blockers
        const blockerEdges = await storage.getEdgesTo(task.id, 'blocks');

        let hasActiveBlocker = false;
        for (const edge of blockerEdges) {
          // Use resolveNode to support cross-provider resolution
          const blocker = await resolveNode(edge.from_id);
          if (blocker && isActiveNode(blocker)) {
            hasActiveBlocker = true;
            break;
          }
        }

        if (!hasActiveBlocker) {
          const parsed = safeParseNode(task);
          if (parsed && isTask(parsed)) {
            readyTasks.push(parsed);
          }
        }
      }

      // Sort by priority (lower priority number = higher priority)
      // Items without priority come after items with priority
      readyTasks.sort((a, b) => {
        const aPriority = a.priority ?? Infinity;
        const bPriority = b.priority ?? Infinity;
        return aPriority - bPriority;
      });

      // Apply limit
      if (options?.limit !== undefined) {
        return readyTasks.slice(0, options.limit);
      }

      return readyTasks;
    },

    // =========================================================================
    // Feedback Queries
    // =========================================================================

    async feedback(targetId: string, options?: FeedbackOptions): Promise<Feedback[]> {
      // Query feedback nodes that target this node
      const allFeedback = await storage.queryNodes({
        type: 'feedback',
      });

      const result: Feedback[] = [];

      for (const node of allFeedback) {
        // Check if this feedback targets the specified node
        if (node.target_id !== targetId) continue;

        // Apply type filter
        if (options?.type && node.feedback_type !== options.type) continue;

        // Apply resolved filter
        if (options?.resolved !== undefined) {
          if (options.resolved && !node.resolved) continue;
          if (!options.resolved && node.resolved) continue;
        }

        // Apply dismissed filter
        if (!options?.includeDismissed && node.dismissed) continue;

        const parsed = safeParseNode(node);
        if (parsed && isFeedback(parsed)) {
          result.push(parsed);
        }
      }

      return result;
    },

    async unresolvedFeedback(targetId?: string): Promise<Feedback[]> {
      // Query all feedback nodes
      const allFeedback = await storage.queryNodes({
        type: 'feedback',
      });

      const result: Feedback[] = [];

      for (const node of allFeedback) {
        // Filter by target if specified
        if (targetId && node.target_id !== targetId) continue;

        // Only unresolved and not dismissed
        if (node.resolved || node.dismissed) continue;

        const parsed = safeParseNode(node);
        if (parsed && isFeedback(parsed)) {
          result.push(parsed);
        }
      }

      return result;
    },
  };
}
