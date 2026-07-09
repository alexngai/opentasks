/**
 * Query Tool
 *
 * Unified query interface for graph traversal.
 */

import type { Node, Edge, Feedback } from '../schema/index.js';
import type { GraphStore } from '../graph/store.js';
import type { ProviderAwareStore } from '../graph/provider-store.js';
import type {
  QueryParams,
  QueryResult,
  NodeSummary,
  EdgeSummary,
  FeedbackSummary,
  OperationContext,
  ContextSummaryResult,
  ContextSummaryParams,
  Breadcrumb,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const CONTENT_PREVIEW_LENGTH = 100;
const DEFAULT_BREADCRUMB_LIMIT = 10;

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
    status: 'status' in node ? (node as { status?: string }).status : undefined,
    priority: node.priority,
    archived: node.archived ?? false,
  };
}

/**
 * Convert an Edge to EdgeSummary (reduced representation)
 */
function toEdgeSummary(edge: Edge): EdgeSummary {
  return {
    id: edge.id,
    fromId: edge.from_id,
    toId: edge.to_id,
    type: edge.type,
  };
}

/**
 * Convert a Feedback node to FeedbackSummary (reduced representation)
 */
function toFeedbackSummary(feedback: Feedback): FeedbackSummary {
  const content = feedback.content || '';
  const preview =
    content.length > CONTENT_PREVIEW_LENGTH
      ? content.substring(0, CONTENT_PREVIEW_LENGTH) + '...'
      : content;

  return {
    id: feedback.id,
    targetId: feedback.target_id,
    feedbackType: feedback.feedback_type as 'comment' | 'suggestion' | 'request',
    resolved: feedback.resolved ?? false,
    dismissed: feedback.dismissed ?? false,
    contentPreview: preview,
  };
}

// ============================================================================
// Query Type Detection
// ============================================================================

/**
 * Count how many query types are specified
 */
function countQueryTypes(params: QueryParams): number {
  let count = 0;
  if (params.nodes !== undefined) count++;
  if (params.edges !== undefined) count++;
  if (params.ready !== undefined) count++;
  if (params.blockers !== undefined) count++;
  if (params.blocking !== undefined) count++;
  if (params.feedback !== undefined) count++;
  if (params.unresolvedFeedback !== undefined) count++;
  if (params.tasks !== undefined) count++;
  if (params.context !== undefined) count++;
  if (params.contextSummary !== undefined) count++;
  return count;
}

// ============================================================================
// Pagination Helpers
// ============================================================================

/**
 * Apply pagination to results
 */
function paginate<T>(items: T[], limit: number, offset: number): { items: T[]; hasMore: boolean } {
  const start = offset;
  const end = offset + limit;
  const paginated = items.slice(start, end);
  const hasMore = items.length > end;

  return { items: paginated, hasMore };
}

// ============================================================================
// Query Tool Implementation
// ============================================================================

/**
 * Query the graph with unified interface
 *
 * @param store - Graph store for data operations
 * @param params - Query parameters
 * @param _context - Optional operation context (unused but kept for API consistency)
 * @returns Query result with items and pagination info
 */
export async function query(
  store: GraphStore,
  params: QueryParams,
  _context?: OperationContext,
  providerStore?: ProviderAwareStore,
): Promise<QueryResult> {
  // Validate exactly one query type
  const queryTypeCount = countQueryTypes(params);

  if (queryTypeCount === 0) {
    throw new Error(
      'No query type specified. Provide one of: nodes, edges, ready, blockers, blocking, feedback, unresolvedFeedback, tasks, context, contextSummary',
    );
  }

  if (queryTypeCount > 1) {
    throw new Error(
      'Multiple query types specified. Provide exactly one of: nodes, edges, ready, blockers, blocking, feedback, unresolvedFeedback, tasks, context, contextSummary',
    );
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const offset = params.offset ?? DEFAULT_OFFSET;
  const verbose = params.verbose ?? false;

  // Dispatch to appropriate query handler
  if (params.nodes !== undefined) {
    return queryNodes(store, params.nodes, limit, offset, verbose, providerStore);
  }

  if (params.edges !== undefined) {
    return queryEdges(store, params.edges, limit, offset, verbose);
  }

  if (params.ready !== undefined) {
    return queryReady(store, params.ready, limit, offset, verbose);
  }

  if (params.blockers !== undefined) {
    return queryBlockers(store, params.blockers, limit, offset, verbose);
  }

  if (params.blocking !== undefined) {
    return queryBlocking(store, params.blocking, limit, offset, verbose);
  }

  if (params.feedback !== undefined) {
    return queryFeedback(store, params.feedback, limit, offset, verbose);
  }

  if (params.unresolvedFeedback !== undefined) {
    return queryUnresolvedFeedback(store, params.unresolvedFeedback, limit, offset, verbose);
  }

  if (params.tasks !== undefined) {
    return queryTasks(store, params.tasks, limit, offset, verbose);
  }

  if (params.context !== undefined) {
    return queryContext(store, params.context, limit, offset, verbose);
  }

  if (params.contextSummary !== undefined) {
    return queryContextSummary(store, params.contextSummary);
  }

  // Should never reach here
  throw new Error('Unknown query type');
}

// ============================================================================
// Query Handlers
// ============================================================================

async function queryNodes(
  store: GraphStore,
  filter: QueryParams['nodes'],
  limit: number,
  offset: number,
  verbose: boolean,
  providerStore?: ProviderAwareStore,
): Promise<QueryResult> {
  // For task queries with a providerStore, federate across providers
  const isTaskQuery = filter?.type === 'task' || (Array.isArray(filter?.type) && filter.type.includes('task'));
  let allNodes: Node[];

  if (isTaskQuery && providerStore) {
    allNodes = await providerStore.providerListTasks({
      status: filter?.status,
      tags: filter?.tags,
      assignee: filter?.assignee,
      search: filter?.search,
    });
  } else {
    allNodes = await store.query.nodes({ ...filter, limit: undefined, offset: undefined });
  }

  const { items: paginatedNodes, hasMore } = paginate(allNodes, limit, offset);

  if (verbose) {
    return {
      items: paginatedNodes,
      total: allNodes.length,
      hasMore,
    };
  }

  return {
    items: paginatedNodes.map(toNodeSummary),
    total: allNodes.length,
    hasMore,
  };
}

async function queryEdges(
  store: GraphStore,
  filter: QueryParams['edges'],
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  // Query without limit/offset first to get total
  const allEdges = await store.query.edges({ ...filter, limit: undefined, offset: undefined });

  const { items: paginatedEdges, hasMore } = paginate(allEdges, limit, offset);

  if (verbose) {
    return {
      items: paginatedEdges,
      total: allEdges.length,
      hasMore,
    };
  }

  return {
    items: paginatedEdges.map(toEdgeSummary),
    total: allEdges.length,
    hasMore,
  };
}

async function queryReady(
  store: GraphStore,
  options: QueryParams['ready'],
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  // Query without limit first to get total
  const allReady = await store.query.ready({ ...options, limit: undefined });

  const { items: paginatedReady, hasMore } = paginate(allReady, limit, offset);

  if (verbose) {
    return {
      items: paginatedReady,
      total: allReady.length,
      hasMore,
    };
  }

  return {
    items: paginatedReady.map(toNodeSummary),
    total: allReady.length,
    hasMore,
  };
}

async function queryBlockers(
  store: GraphStore,
  params: NonNullable<QueryParams['blockers']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { nodeId, transitive, activeOnly } = params;

  const allBlockers = await store.query.blockers(nodeId, {
    transitive,
    activeOnly,
  });

  const { items: paginatedBlockers, hasMore } = paginate(allBlockers, limit, offset);

  if (verbose) {
    return {
      items: paginatedBlockers,
      total: allBlockers.length,
      hasMore,
    };
  }

  return {
    items: paginatedBlockers.map(toNodeSummary),
    total: allBlockers.length,
    hasMore,
  };
}

async function queryBlocking(
  store: GraphStore,
  params: NonNullable<QueryParams['blocking']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { nodeId, transitive, activeOnly } = params;

  const allBlocking = await store.query.blocking(nodeId, {
    transitive,
    activeOnly,
  });

  const { items: paginatedBlocking, hasMore } = paginate(allBlocking, limit, offset);

  if (verbose) {
    return {
      items: paginatedBlocking,
      total: allBlocking.length,
      hasMore,
    };
  }

  return {
    items: paginatedBlocking.map(toNodeSummary),
    total: allBlocking.length,
    hasMore,
  };
}

async function queryFeedback(
  store: GraphStore,
  params: NonNullable<QueryParams['feedback']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { nodeId, type, resolved, includeDismissed } = params;

  const allFeedback = await store.query.feedback(nodeId, {
    type,
    resolved,
    includeDismissed,
  });

  const { items: paginatedFeedback, hasMore } = paginate(allFeedback, limit, offset);

  if (verbose) {
    return {
      items: paginatedFeedback,
      total: allFeedback.length,
      hasMore,
    };
  }

  return {
    items: paginatedFeedback.map(toFeedbackSummary),
    total: allFeedback.length,
    hasMore,
  };
}

async function queryUnresolvedFeedback(
  store: GraphStore,
  params: NonNullable<QueryParams['unresolvedFeedback']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { targetId } = params;

  // Get all unresolved feedback (optionally filtered by target)
  const allUnresolved = await store.query.unresolvedFeedback(targetId);

  const { items: paginatedFeedback, hasMore } = paginate(allUnresolved, limit, offset);

  if (verbose) {
    return {
      items: paginatedFeedback,
      total: allUnresolved.length,
      hasMore,
    };
  }

  return {
    items: paginatedFeedback.map(toFeedbackSummary),
    total: allUnresolved.length,
    hasMore,
  };
}

async function queryTasks(
  store: GraphStore,
  params: NonNullable<QueryParams['tasks']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { contextId } = params;

  const allTasks = await store.query.tasks(contextId);

  const { items: paginatedTasks, hasMore } = paginate(allTasks, limit, offset);

  if (verbose) {
    return {
      items: paginatedTasks,
      total: allTasks.length,
      hasMore,
    };
  }

  return {
    items: paginatedTasks.map(toNodeSummary),
    total: allTasks.length,
    hasMore,
  };
}

async function queryContext(
  store: GraphStore,
  params: NonNullable<QueryParams['context']>,
  limit: number,
  offset: number,
  verbose: boolean,
): Promise<QueryResult> {
  const { taskId } = params;

  const allContext = await store.query.context(taskId);

  const { items: paginatedContext, hasMore } = paginate(allContext, limit, offset);

  if (verbose) {
    return {
      items: paginatedContext,
      total: allContext.length,
      hasMore,
    };
  }

  return {
    items: paginatedContext.map(toNodeSummary),
    total: allContext.length,
    hasMore,
  };
}

// ============================================================================
// Context Summary (Breadcrumbs)
// ============================================================================

/**
 * Convert a Node to a Breadcrumb
 */
function toBreadcrumb(node: Node, relevance: string): Breadcrumb {
  const content = node.content || '';
  const preview =
    content.length > CONTENT_PREVIEW_LENGTH
      ? content.substring(0, CONTENT_PREVIEW_LENGTH) + '...'
      : content || undefined;

  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status: 'status' in node ? (node as { status?: string }).status : undefined,
    priority: node.priority,
    relevance,
    contentPreview: preview,
    tags: node.tags?.length ? node.tags : undefined,
    branch: node.branch,
    updatedAt: node.updated_at,
  };
}

/**
 * Check if a node matches the context summary filters
 */
function matchesContextFilters(
  node: Node,
  params: ContextSummaryParams,
): boolean {
  if (params.tags?.length) {
    const nodeTags = node.tags || [];
    if (!params.tags.some((t) => nodeTags.includes(t))) return false;
  }

  if (params.branch && node.branch !== params.branch) return false;

  return true;
}

async function queryContextSummary(
  store: GraphStore,
  params: ContextSummaryParams,
): Promise<QueryResult> {
  const limit = params.limit ?? DEFAULT_BREADCRUMB_LIMIT;

  const result: ContextSummaryResult = {
    recentlyCompleted: [],
    activeTasks: [],
    blockedTasks: [],
    relatedContexts: [],
    unresolvedFeedback: [],
  };

  // If a taskId is provided, gather context around that task
  if (params.taskId) {
    // Get the task's context nodes (specs/requirements it implements)
    const contexts = await store.query.context(params.taskId);
    for (const ctx of contexts.slice(0, limit)) {
      result.relatedContexts.push(toBreadcrumb(ctx, 'implements'));
    }

    // Get blockers for this task
    const blockers = await store.query.blockers(params.taskId, { activeOnly: true });
    for (const blocker of blockers.slice(0, limit)) {
      result.blockedTasks.push(toBreadcrumb(blocker, 'blocks-target'));
    }

    // Get siblings: other tasks implementing the same contexts
    const siblingIds = new Set<string>();
    for (const ctx of contexts) {
      const siblings = await store.query.tasks(ctx.id);
      for (const sibling of siblings) {
        if (sibling.id === params.taskId) continue;
        if (siblingIds.has(sibling.id)) continue;
        siblingIds.add(sibling.id);

        const relevance = `sibling-via:${ctx.id}`;
        // Terminal states (closed/failed/abandoned) are concluded work — group
        // them as "recently completed" (the breadcrumb carries the real status),
        // never as active. Only open/in_progress are active.
        if (
          sibling.status === 'closed' ||
          sibling.status === 'failed' ||
          sibling.status === 'abandoned'
        ) {
          if (result.recentlyCompleted.length < limit) {
            result.recentlyCompleted.push(toBreadcrumb(sibling, relevance));
          }
        } else if (sibling.status === 'blocked') {
          if (result.blockedTasks.length < limit) {
            result.blockedTasks.push(toBreadcrumb(sibling, relevance));
          }
        } else {
          if (result.activeTasks.length < limit) {
            result.activeTasks.push(toBreadcrumb(sibling, relevance));
          }
        }
      }
    }

    // Get unresolved feedback on this task
    const feedback = await store.query.unresolvedFeedback(params.taskId);
    for (const fb of feedback.slice(0, limit)) {
      result.unresolvedFeedback.push(toBreadcrumb(fb, 'unresolved-on-target'));
    }
  }

  // Broader queries: recent tasks by branch/tags
  // Recently concluded tasks (terminal: completed, failed, or abandoned)
  const closedTasks = await store.query.nodes({
    type: 'task',
    status: ['closed', 'failed', 'abandoned'],
    archived: false,
    orderBy: 'updated_at',
    orderDirection: 'desc',
    limit: limit * 3, // fetch more to filter
  });
  for (const task of closedTasks) {
    if (result.recentlyCompleted.length >= limit) break;
    if (!matchesContextFilters(task, params)) continue;
    // Skip if already added via task-specific queries
    if (result.recentlyCompleted.some((b) => b.id === task.id)) continue;
    result.recentlyCompleted.push(toBreadcrumb(task, 'recent-closed'));
  }

  // Active tasks (in_progress + open)
  const activeTasks = await store.query.nodes({
    type: 'task',
    status: ['open', 'in_progress'],
    archived: false,
    orderBy: 'updated_at',
    orderDirection: 'desc',
    limit: limit * 3,
  });
  for (const task of activeTasks) {
    if (result.activeTasks.length >= limit) break;
    if (!matchesContextFilters(task, params)) continue;
    if (result.activeTasks.some((b) => b.id === task.id)) continue;
    result.activeTasks.push(toBreadcrumb(task, 'active'));
  }

  // Blocked tasks
  const blockedTasks = await store.query.nodes({
    type: 'task',
    status: 'blocked',
    archived: false,
    orderBy: 'updated_at',
    orderDirection: 'desc',
    limit: limit * 3,
  });
  for (const task of blockedTasks) {
    if (result.blockedTasks.length >= limit) break;
    if (!matchesContextFilters(task, params)) continue;
    if (result.blockedTasks.some((b) => b.id === task.id)) continue;
    result.blockedTasks.push(toBreadcrumb(task, 'blocked'));
  }

  // Related context nodes
  const contexts = await store.query.nodes({
    type: 'context',
    status: 'active',
    archived: false,
    orderBy: 'updated_at',
    orderDirection: 'desc',
    limit: limit * 3,
  });
  for (const ctx of contexts) {
    if (result.relatedContexts.length >= limit) break;
    if (!matchesContextFilters(ctx, params)) continue;
    if (result.relatedContexts.some((b) => b.id === ctx.id)) continue;
    result.relatedContexts.push(toBreadcrumb(ctx, 'active-context'));
  }

  // Unresolved feedback (global, not already captured)
  if (!params.taskId) {
    const allUnresolved = await store.query.unresolvedFeedback();
    for (const fb of allUnresolved) {
      if (result.unresolvedFeedback.length >= limit) break;
      if (!matchesContextFilters(fb, params)) continue;
      result.unresolvedFeedback.push(toBreadcrumb(fb, 'unresolved'));
    }
  }

  // Count total breadcrumbs across all sections
  const totalBreadcrumbs =
    result.recentlyCompleted.length +
    result.activeTasks.length +
    result.blockedTasks.length +
    result.relatedContexts.length +
    result.unresolvedFeedback.length;

  return {
    items: [],
    total: totalBreadcrumbs,
    hasMore: false,
    contextSummary: result,
  };
}
