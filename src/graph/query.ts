/**
 * Query Engine for Graph Operations
 *
 * Provides rich query capabilities for graph traversal and filtering.
 */

import type { Storage } from '../storage/interface.js'
import type { StoredNode, StoredEdge } from '../schema/storage.js'
import type { Node, Issue, Spec, Feedback, Edge, EdgeType } from '../schema/index.js'
import { parseNode, isIssue, isSpec, isFeedback } from '../schema/validation.js'
import type {
  NodeFilter,
  EdgeFilter,
  BlockerOptions,
  ReadyOptions,
  FeedbackOptions,
} from './types.js'
import type { NodeFilter as StorageNodeFilter } from '../storage/interface.js'

// ============================================================================
// Query Engine Interface
// ============================================================================

/**
 * Query engine for graph traversal and filtering
 */
export interface QueryEngine {
  // === Basic Queries ===

  /** Query nodes with filters */
  nodes(filter: NodeFilter): Promise<Node[]>

  /** Query edges with filters */
  edges(filter: EdgeFilter): Promise<Edge[]>

  // === Relationship Queries ===

  /** Get edges from a node */
  edgesFrom(nodeId: string, type?: EdgeType): Promise<Edge[]>

  /** Get edges to a node */
  edgesTo(nodeId: string, type?: EdgeType): Promise<Edge[]>

  /** Get all edges for a node (both directions) */
  edgesFor(nodeId: string, type?: EdgeType): Promise<Edge[]>

  // === Dependency Queries ===

  /** What blocks this node? */
  blockers(nodeId: string, options?: BlockerOptions): Promise<Node[]>

  /** What does this node block? */
  blocking(nodeId: string, options?: BlockerOptions): Promise<Node[]>

  /** Is there a path from A blocking B? */
  isBlocking(fromId: string, toId: string): Promise<boolean>

  // === Spec/Issue Queries ===

  /** Issues that implement a spec */
  implementers(specId: string): Promise<Issue[]>

  /** Specs that an issue implements */
  specs(issueId: string): Promise<Spec[]>

  // === Hierarchy Queries ===

  /** Get children of a node */
  children(nodeId: string): Promise<Node[]>

  /** Get parent of a node */
  parent(nodeId: string): Promise<Node | null>

  /** Get all ancestors */
  ancestors(nodeId: string): Promise<Node[]>

  /** Get all descendants */
  descendants(nodeId: string): Promise<Node[]>

  // === Ready Query ===

  /** Get issues ready to work on (no active blockers) */
  ready(options?: ReadyOptions): Promise<Issue[]>

  // === Feedback Queries ===

  /** Get feedback on a node */
  feedback(targetId: string, options?: FeedbackOptions): Promise<Feedback[]>

  /** Get unresolved feedback */
  unresolvedFeedback(targetId?: string): Promise<Feedback[]>
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert StoredEdge to Edge (they're the same, but for type clarity)
 */
function toEdge(stored: StoredEdge): Edge {
  return stored as Edge
}

/**
 * Safely parse a node, returning null on error
 * (makes query engine resilient to bad data in storage)
 */
function safeParseNode(stored: StoredNode): Node | null {
  try {
    return parseNode(stored)
  } catch {
    return null
  }
}

/**
 * Check if a node is active (not closed, not archived)
 */
function isActiveNode(node: StoredNode): boolean {
  return !node.archived && node.status !== 'closed'
}

/**
 * Apply priority filter to nodes
 */
function matchesPriority(
  node: StoredNode,
  filter: number | { min?: number; max?: number } | undefined
): boolean {
  if (filter === undefined) return true
  if (node.priority === undefined) return true

  if (typeof filter === 'number') {
    return node.priority === filter
  }

  const { min, max } = filter
  if (min !== undefined && node.priority < min) return false
  if (max !== undefined && node.priority > max) return false
  return true
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
  }
}

// ============================================================================
// Query Engine Implementation
// ============================================================================

/**
 * Create a query engine backed by a storage implementation
 */
export function createQueryEngine(storage: Storage): QueryEngine {
  return {
    // =========================================================================
    // Basic Queries
    // =========================================================================

    async nodes(filter: NodeFilter): Promise<Node[]> {
      const stored = await storage.queryNodes(toStorageFilter(filter))
      return stored.map(safeParseNode).filter((n): n is Node => n !== null)
    },

    async edges(filter: EdgeFilter): Promise<Edge[]> {
      const results: StoredEdge[] = []

      if (filter.from_id) {
        const fromEdges = await storage.getEdgesFrom(filter.from_id, filter.type as EdgeType | undefined)
        results.push(...fromEdges)
      } else if (filter.to_id) {
        const toEdges = await storage.getEdgesTo(filter.to_id, filter.type as EdgeType | undefined)
        results.push(...toEdges)
      } else {
        // No specific node filter - this would need a full edge query
        // For now, return empty (full edge enumeration not typically needed)
        return []
      }

      // Apply type filter if we didn't use it in the query
      let filtered = results
      if (filter.type && !filter.from_id && !filter.to_id) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type]
        filtered = results.filter((e) => types.includes(e.type as EdgeType))
      }

      // Apply pagination
      const offset = filter.offset ?? 0
      const limit = filter.limit ?? filtered.length
      const paginated = filtered.slice(offset, offset + limit)

      return paginated.map(toEdge)
    },

    // =========================================================================
    // Relationship Queries
    // =========================================================================

    async edgesFrom(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const stored = await storage.getEdgesFrom(nodeId, type)
      return stored.map(toEdge)
    },

    async edgesTo(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const stored = await storage.getEdgesTo(nodeId, type)
      return stored.map(toEdge)
    },

    async edgesFor(nodeId: string, type?: EdgeType): Promise<Edge[]> {
      const [from, to] = await Promise.all([
        storage.getEdgesFrom(nodeId, type),
        storage.getEdgesTo(nodeId, type),
      ])

      // Combine and deduplicate by ID
      const seen = new Set<string>()
      const all: Edge[] = []

      for (const edge of [...from, ...to]) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id)
          all.push(toEdge(edge))
        }
      }

      return all
    },

    // =========================================================================
    // Dependency Queries
    // =========================================================================

    async blockers(nodeId: string, options?: BlockerOptions): Promise<Node[]> {
      const result: Node[] = []
      const visited = new Set<string>()
      const maxDepth = options?.maxDepth ?? 10
      const activeOnly = options?.activeOnly ?? true

      async function collect(id: string, depth: number): Promise<void> {
        if (depth > maxDepth || visited.has(id)) return
        visited.add(id)

        // Get incoming 'blocks' edges (things that block this node)
        const edges = await storage.getEdgesTo(id, 'blocks')

        for (const edge of edges) {
          const blocker = await storage.getNode(edge.from_id)
          if (!blocker) continue

          // Filter by activeOnly
          if (activeOnly && !isActiveNode(blocker)) continue

          const parsed = safeParseNode(blocker)
          if (parsed) {
            result.push(parsed)
          }

          // Recurse for transitive blockers
          if (options?.transitive) {
            await collect(edge.from_id, depth + 1)
          }
        }
      }

      await collect(nodeId, 0)
      return result
    },

    async blocking(nodeId: string, options?: BlockerOptions): Promise<Node[]> {
      const result: Node[] = []
      const visited = new Set<string>()
      const maxDepth = options?.maxDepth ?? 10
      const activeOnly = options?.activeOnly ?? true

      async function collect(id: string, depth: number): Promise<void> {
        if (depth > maxDepth || visited.has(id)) return
        visited.add(id)

        // Get outgoing 'blocks' edges (things this node blocks)
        const edges = await storage.getEdgesFrom(id, 'blocks')

        for (const edge of edges) {
          const blocked = await storage.getNode(edge.to_id)
          if (!blocked) continue

          // Filter by activeOnly
          if (activeOnly && !isActiveNode(blocked)) continue

          const parsed = safeParseNode(blocked)
          if (parsed) {
            result.push(parsed)
          }

          // Recurse for transitive blocking
          if (options?.transitive) {
            await collect(edge.to_id, depth + 1)
          }
        }
      }

      await collect(nodeId, 0)
      return result
    },

    async isBlocking(fromId: string, toId: string): Promise<boolean> {
      // Check if fromId blocks toId (directly or transitively)
      const visited = new Set<string>()

      async function search(current: string): Promise<boolean> {
        if (current === toId) return true
        if (visited.has(current)) return false

        visited.add(current)

        const edges = await storage.getEdgesFrom(current, 'blocks')
        for (const edge of edges) {
          if (await search(edge.to_id)) {
            return true
          }
        }

        return false
      }

      return search(fromId)
    },

    // =========================================================================
    // Spec/Issue Queries
    // =========================================================================

    async implementers(specId: string): Promise<Issue[]> {
      // Get incoming 'implements' edges to the spec
      const edges = await storage.getEdgesTo(specId, 'implements')

      const issues: Issue[] = []
      for (const edge of edges) {
        const node = await storage.getNode(edge.from_id)
        if (node) {
          const parsed = safeParseNode(node)
          if (parsed && isIssue(parsed)) {
            issues.push(parsed)
          }
        }
      }

      return issues
    },

    async specs(issueId: string): Promise<Spec[]> {
      // Get outgoing 'implements' edges from the issue
      const edges = await storage.getEdgesFrom(issueId, 'implements')

      const specs: Spec[] = []
      for (const edge of edges) {
        const node = await storage.getNode(edge.to_id)
        if (node) {
          const parsed = safeParseNode(node)
          if (parsed && isSpec(parsed)) {
            specs.push(parsed)
          }
        }
      }

      return specs
    },

    // =========================================================================
    // Hierarchy Queries
    // =========================================================================

    async children(nodeId: string): Promise<Node[]> {
      // Query nodes with parent_id = nodeId
      const stored = await storage.queryNodes({ parent_id: nodeId })
      return stored.map(parseNode).filter((n): n is Node => n !== null)
    },

    async parent(nodeId: string): Promise<Node | null> {
      const node = await storage.getNode(nodeId)
      if (!node || !node.parent_id) return null

      const parentNode = await storage.getNode(node.parent_id)
      if (!parentNode) return null

      return safeParseNode(parentNode)
    },

    async ancestors(nodeId: string): Promise<Node[]> {
      const result: Node[] = []
      let currentId: string | undefined = nodeId

      while (currentId) {
        const node = await storage.getNode(currentId)
        if (!node || !node.parent_id) break

        const parentNode = await storage.getNode(node.parent_id)
        if (!parentNode) break

        const parsed = safeParseNode(parentNode)
        if (parsed) {
          result.push(parsed)
        }

        currentId = parentNode.parent_id
      }

      return result
    },

    async descendants(nodeId: string): Promise<Node[]> {
      const result: Node[] = []
      const visited = new Set<string>()

      async function collect(id: string): Promise<void> {
        if (visited.has(id)) return
        visited.add(id)

        const children = await storage.queryNodes({ parent_id: id })

        for (const child of children) {
          const parsed = safeParseNode(child)
          if (parsed) {
            result.push(parsed)
            await collect(child.id)
          }
        }
      }

      await collect(nodeId)
      return result
    },

    // =========================================================================
    // Ready Query
    // =========================================================================

    async ready(options?: ReadyOptions): Promise<Issue[]> {
      // Get all open, non-archived issues
      const issues = await storage.queryNodes({
        type: 'issue',
        status: 'open',
        archived: false,
      })

      const readyIssues: Issue[] = []

      for (const issue of issues) {
        // Apply additional filters
        if (options?.tags) {
          const nodeTags = issue.tags || []
          const hasAllTags = options.tags.every((t) => nodeTags.includes(t))
          if (!hasAllTags) continue
        }

        if (!matchesPriority(issue, options?.priority)) continue

        if (options?.assignee && issue.assignee !== options.assignee) continue

        // Check for active blockers
        const blockerEdges = await storage.getEdgesTo(issue.id, 'blocks')

        let hasActiveBlocker = false
        for (const edge of blockerEdges) {
          const blocker = await storage.getNode(edge.from_id)
          if (blocker && isActiveNode(blocker)) {
            hasActiveBlocker = true
            break
          }
        }

        if (!hasActiveBlocker) {
          const parsed = safeParseNode(issue)
          if (parsed && isIssue(parsed)) {
            readyIssues.push(parsed)
          }
        }
      }

      // Apply limit
      if (options?.limit !== undefined) {
        return readyIssues.slice(0, options.limit)
      }

      return readyIssues
    },

    // =========================================================================
    // Feedback Queries
    // =========================================================================

    async feedback(targetId: string, options?: FeedbackOptions): Promise<Feedback[]> {
      // Query feedback nodes that target this node
      const allFeedback = await storage.queryNodes({
        type: 'feedback',
      })

      const result: Feedback[] = []

      for (const node of allFeedback) {
        // Check if this feedback targets the specified node
        if (node.target_id !== targetId) continue

        // Apply type filter
        if (options?.type && node.feedback_type !== options.type) continue

        // Apply resolved filter
        if (options?.resolved !== undefined) {
          if (options.resolved && !node.resolved) continue
          if (!options.resolved && node.resolved) continue
        }

        // Apply dismissed filter
        if (!options?.includeDismissed && node.dismissed) continue

        const parsed = safeParseNode(node)
        if (parsed && isFeedback(parsed)) {
          result.push(parsed)
        }
      }

      return result
    },

    async unresolvedFeedback(targetId?: string): Promise<Feedback[]> {
      // Query all feedback nodes
      const allFeedback = await storage.queryNodes({
        type: 'feedback',
      })

      const result: Feedback[] = []

      for (const node of allFeedback) {
        // Filter by target if specified
        if (targetId && node.target_id !== targetId) continue

        // Only unresolved and not dismissed
        if (node.resolved || node.dismissed) continue

        const parsed = safeParseNode(node)
        if (parsed && isFeedback(parsed)) {
          result.push(parsed)
        }
      }

      return result
    },
  }
}
