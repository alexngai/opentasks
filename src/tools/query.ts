/**
 * Query Tool
 *
 * Unified query interface for graph traversal.
 */

import type { Node, Edge, Feedback } from '../schema/index.js'
import type { GraphStore } from '../graph/store.js'
import type {
  QueryParams,
  QueryResult,
  NodeSummary,
  EdgeSummary,
  FeedbackSummary,
} from './types.js'

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50
const DEFAULT_OFFSET = 0
const CONTENT_PREVIEW_LENGTH = 100

// ============================================================================
// Summary Converters
// ============================================================================

/**
 * Convert a Node to NodeSummary (reduced representation)
 */
function toNodeSummary(node: Node): NodeSummary {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status: 'status' in node ? (node as any).status : undefined,
    priority: node.priority,
    archived: node.archived ?? false,
  }
}

/**
 * Convert an Edge to EdgeSummary (reduced representation)
 */
function toEdgeSummary(edge: Edge): EdgeSummary {
  return {
    id: edge.id,
    from_id: edge.from_id,
    to_id: edge.to_id,
    type: edge.type,
  }
}

/**
 * Convert a Feedback node to FeedbackSummary (reduced representation)
 */
function toFeedbackSummary(feedback: Feedback): FeedbackSummary {
  const content = feedback.content || ''
  const preview =
    content.length > CONTENT_PREVIEW_LENGTH
      ? content.substring(0, CONTENT_PREVIEW_LENGTH) + '...'
      : content

  return {
    id: feedback.id,
    target_id: feedback.target_id,
    feedback_type: feedback.feedback_type as 'comment' | 'suggestion' | 'request',
    resolved: feedback.resolved ?? false,
    dismissed: feedback.dismissed ?? false,
    content_preview: preview,
  }
}

// ============================================================================
// Query Type Detection
// ============================================================================

/**
 * Count how many query types are specified
 */
function countQueryTypes(params: QueryParams): number {
  let count = 0
  if (params.nodes !== undefined) count++
  if (params.edges !== undefined) count++
  if (params.ready !== undefined) count++
  if (params.blockers !== undefined) count++
  if (params.blocking !== undefined) count++
  if (params.feedback !== undefined) count++
  return count
}

/**
 * Get the active query type name
 */
function getQueryTypeName(params: QueryParams): string {
  if (params.nodes !== undefined) return 'nodes'
  if (params.edges !== undefined) return 'edges'
  if (params.ready !== undefined) return 'ready'
  if (params.blockers !== undefined) return 'blockers'
  if (params.blocking !== undefined) return 'blocking'
  if (params.feedback !== undefined) return 'feedback'
  return 'unknown'
}

// ============================================================================
// Pagination Helpers
// ============================================================================

/**
 * Apply pagination to results
 */
function paginate<T>(items: T[], limit: number, offset: number): { items: T[]; has_more: boolean } {
  const start = offset
  const end = offset + limit
  const paginated = items.slice(start, end)
  const has_more = items.length > end

  return { items: paginated, has_more }
}

// ============================================================================
// Query Tool Implementation
// ============================================================================

/**
 * Query the graph with unified interface
 *
 * @param store - Graph store for data operations
 * @param params - Query parameters
 * @returns Query result with items and pagination info
 */
export async function query(store: GraphStore, params: QueryParams): Promise<QueryResult> {
  // Validate exactly one query type
  const queryTypeCount = countQueryTypes(params)

  if (queryTypeCount === 0) {
    throw new Error('No query type specified. Provide one of: nodes, edges, ready, blockers, blocking, feedback')
  }

  if (queryTypeCount > 1) {
    throw new Error('Multiple query types specified. Provide exactly one of: nodes, edges, ready, blockers, blocking, feedback')
  }

  const limit = params.limit ?? DEFAULT_LIMIT
  const offset = params.offset ?? DEFAULT_OFFSET
  const verbose = params.verbose ?? false

  // Dispatch to appropriate query handler
  if (params.nodes !== undefined) {
    return queryNodes(store, params.nodes, limit, offset, verbose)
  }

  if (params.edges !== undefined) {
    return queryEdges(store, params.edges, limit, offset, verbose)
  }

  if (params.ready !== undefined) {
    return queryReady(store, params.ready, limit, offset, verbose)
  }

  if (params.blockers !== undefined) {
    return queryBlockers(store, params.blockers, limit, offset, verbose)
  }

  if (params.blocking !== undefined) {
    return queryBlocking(store, params.blocking, limit, offset, verbose)
  }

  if (params.feedback !== undefined) {
    return queryFeedback(store, params.feedback, limit, offset, verbose)
  }

  // Should never reach here
  throw new Error('Unknown query type')
}

// ============================================================================
// Query Handlers
// ============================================================================

async function queryNodes(
  store: GraphStore,
  filter: QueryParams['nodes'],
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  // Query without limit/offset first to get total
  const allNodes = await store.query.nodes({ ...filter, limit: undefined, offset: undefined })

  const { items: paginatedNodes, has_more } = paginate(allNodes, limit, offset)

  if (verbose) {
    return {
      items: paginatedNodes,
      total: allNodes.length,
      has_more,
    }
  }

  return {
    items: paginatedNodes.map(toNodeSummary),
    total: allNodes.length,
    has_more,
  }
}

async function queryEdges(
  store: GraphStore,
  filter: QueryParams['edges'],
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  // Query without limit/offset first to get total
  const allEdges = await store.query.edges({ ...filter, limit: undefined, offset: undefined })

  const { items: paginatedEdges, has_more } = paginate(allEdges, limit, offset)

  if (verbose) {
    return {
      items: paginatedEdges,
      total: allEdges.length,
      has_more,
    }
  }

  return {
    items: paginatedEdges.map(toEdgeSummary),
    total: allEdges.length,
    has_more,
  }
}

async function queryReady(
  store: GraphStore,
  options: QueryParams['ready'],
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  // Query without limit first to get total
  const allReady = await store.query.ready({ ...options, limit: undefined })

  const { items: paginatedReady, has_more } = paginate(allReady, limit, offset)

  if (verbose) {
    return {
      items: paginatedReady,
      total: allReady.length,
      has_more,
    }
  }

  return {
    items: paginatedReady.map(toNodeSummary),
    total: allReady.length,
    has_more,
  }
}

async function queryBlockers(
  store: GraphStore,
  params: NonNullable<QueryParams['blockers']>,
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  const { node_id, transitive, active_only } = params

  const allBlockers = await store.query.blockers(node_id, {
    transitive,
    activeOnly: active_only,
  })

  const { items: paginatedBlockers, has_more } = paginate(allBlockers, limit, offset)

  if (verbose) {
    return {
      items: paginatedBlockers,
      total: allBlockers.length,
      has_more,
    }
  }

  return {
    items: paginatedBlockers.map(toNodeSummary),
    total: allBlockers.length,
    has_more,
  }
}

async function queryBlocking(
  store: GraphStore,
  params: NonNullable<QueryParams['blocking']>,
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  const { node_id, transitive, active_only } = params

  const allBlocking = await store.query.blocking(node_id, {
    transitive,
    activeOnly: active_only,
  })

  const { items: paginatedBlocking, has_more } = paginate(allBlocking, limit, offset)

  if (verbose) {
    return {
      items: paginatedBlocking,
      total: allBlocking.length,
      has_more,
    }
  }

  return {
    items: paginatedBlocking.map(toNodeSummary),
    total: allBlocking.length,
    has_more,
  }
}

async function queryFeedback(
  store: GraphStore,
  params: NonNullable<QueryParams['feedback']>,
  limit: number,
  offset: number,
  verbose: boolean
): Promise<QueryResult> {
  const { node_id, type, resolved, include_dismissed } = params

  const allFeedback = await store.query.feedback(node_id, {
    type,
    resolved,
    includeDismissed: include_dismissed,
  })

  const { items: paginatedFeedback, has_more } = paginate(allFeedback, limit, offset)

  if (verbose) {
    return {
      items: paginatedFeedback,
      total: allFeedback.length,
      has_more,
    }
  }

  return {
    items: paginatedFeedback.map(toFeedbackSummary),
    total: allFeedback.length,
    has_more,
  }
}
