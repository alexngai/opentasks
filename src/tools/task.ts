/**
 * Task Tool
 *
 * Specialized task lifecycle interface for providers that support
 * semantic task operations (start, complete, block, etc.).
 *
 * Operates on the ProviderAwareStore's task methods, which delegate
 * to TaskManageable providers.
 */

import type { Node } from '../schema/index.js';
import type { ProviderAwareStore } from '../graph/provider-store.js';
import type {
  TaskParams,
  TaskResult,
  TaskTransitionData,
  TaskReadyData,
  TaskAssignData,
  TaskValidActionsData,
  NodeSummary,
} from './types.js';

// ============================================================================
// Summary Converter
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
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Count how many operations are specified
 */
function countOperations(params: TaskParams): number {
  let count = 0;
  if (params.transition !== undefined) count++;
  if (params.ready !== undefined) count++;
  if (params.assign !== undefined) count++;
  if (params.validActions !== undefined) count++;
  return count;
}

// ============================================================================
// Task Tool Implementation
// ============================================================================

/**
 * Execute a task lifecycle operation
 *
 * @param store - Provider-aware store with task methods
 * @param params - Task operation parameters
 * @returns Task result
 */
export async function task(store: ProviderAwareStore, params: TaskParams): Promise<TaskResult> {
  // Validate exactly one operation
  const opCount = countOperations(params);

  if (opCount === 0) {
    return {
      success: false,
      error: 'No operation specified. Provide one of: transition, ready, assign, validActions',
    };
  }

  if (opCount > 1) {
    return {
      success: false,
      error:
        'Multiple operations specified. Provide exactly one of: transition, ready, assign, validActions',
    };
  }

  try {
    if (params.transition) {
      return await handleTransition(store, params.transition);
    }

    if (params.ready) {
      return await handleReady(store, params.ready);
    }

    if (params.assign) {
      return await handleAssign(store, params.assign);
    }

    if (params.validActions) {
      return await handleValidActions(store, params.validActions);
    }

    return { success: false, error: 'Unknown operation' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Operation Handlers
// ============================================================================

async function handleTransition(
  store: ProviderAwareStore,
  params: NonNullable<TaskParams['transition']>,
): Promise<TaskResult> {
  const { id, action } = params;

  if (!id) {
    return { success: false, error: 'Missing required parameter: id' };
  }
  if (!action) {
    return { success: false, error: 'Missing required parameter: action' };
  }

  const validActions = ['start', 'complete', 'block', 'reopen', 'close'];
  if (!validActions.includes(action)) {
    return {
      success: false,
      error: `Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`,
    };
  }

  const result = await store.taskTransition(id, action);

  const data: TaskTransitionData = {
    type: 'transition',
    node: toNodeSummary(result.node),
    provider: result.provider,
    action: result.action,
  };

  return { success: true, data };
}

async function handleReady(
  store: ProviderAwareStore,
  params: NonNullable<TaskParams['ready']>,
): Promise<TaskResult> {
  const nodes = await store.taskReady({
    providers: params.providers,
    limit: params.limit,
    tags: params.tags,
    priority: params.priority,
    assignee: params.assignee,
  });

  const data: TaskReadyData = {
    type: 'ready',
    items: nodes.map(toNodeSummary),
    total: nodes.length,
  };

  return { success: true, data };
}

async function handleAssign(
  store: ProviderAwareStore,
  params: NonNullable<TaskParams['assign']>,
): Promise<TaskResult> {
  const { id, assignee } = params;

  if (!id) {
    return { success: false, error: 'Missing required parameter: id' };
  }
  if (!assignee) {
    return { success: false, error: 'Missing required parameter: assignee' };
  }

  const node = await store.taskAssign(id, assignee);

  const data: TaskAssignData = {
    type: 'assign',
    node: toNodeSummary(node),
    provider: 'unknown', // TODO: store could return this
  };

  return { success: true, data };
}

async function handleValidActions(
  store: ProviderAwareStore,
  params: NonNullable<TaskParams['validActions']>,
): Promise<TaskResult> {
  const { id } = params;

  if (!id) {
    return { success: false, error: 'Missing required parameter: id' };
  }

  const actions = await store.taskValidActions(id);

  const data: TaskValidActionsData = {
    type: 'validActions',
    actions,
  };

  return { success: true, data };
}
