/**
 * Tools Method Handlers
 *
 * JSON-RPC method handlers for the 3-tool agent interface via IPC.
 * Location-aware: extracts optional `location` from params to route
 * to the correct store via LocationResolver.
 *
 * Integrates with SkillTracker to record tool invocations per session,
 * enabling trajectory-level skill usage tracking.
 */

import type { IPCServer } from '../ipc.js';
import type { LocationResolver } from '../location-state.js';
import type {
  LinkParams,
  LinkResult,
  QueryParams,
  QueryResult,
  AnnotateParams,
  AnnotateResult,
  TaskParams,
  TaskResult,
} from '../../tools/types.js';
import { link } from '../../tools/link.js';
import { query } from '../../tools/query.js';
import { annotate } from '../../tools/annotate.js';
import { task } from '../../tools/task.js';
import type { SkillTrackerRegistry, SkillUsageSummary } from '../../tracking/skill-tracker.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Common params extension for skill tracking context
 */
interface TrackingContext {
  /** Location hash for routing */
  location?: string;
  /** Session ID for skill tracking (from OperationContext.sessionId) */
  _sessionId?: string;
  /** Agent ID for skill tracking (from OperationContext.agentId) */
  _agentId?: string;
}

/**
 * Options for registering tools methods
 */
export interface ToolsMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver;

  /** Skill tracker registry (created internally if not provided) */
  skillTrackerRegistry?: SkillTrackerRegistry;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an ID is a local node ID (not a provider URI)
 */
const LOCAL_ID_PATTERN = /^[ctfex]-[a-z0-9]+$/;

function isLocalId(id: string): boolean {
  return LOCAL_ID_PATTERN.test(id);
}

/**
 * Determine the sub-operation for a query call
 */
function getQueryOperation(params: QueryParams): string | undefined {
  if (params.nodes !== undefined) return 'nodes';
  if (params.edges !== undefined) return 'edges';
  if (params.ready !== undefined) return 'ready';
  if (params.blockers !== undefined) return 'blockers';
  if (params.blocking !== undefined) return 'blocking';
  if (params.feedback !== undefined) return 'feedback';
  if (params.unresolvedFeedback !== undefined) return 'unresolvedFeedback';
  if (params.tasks !== undefined) return 'tasks';
  if (params.context !== undefined) return 'context';
  return undefined;
}

/**
 * Determine the sub-operation for a task call
 */
function getTaskOperation(params: TaskParams): string | undefined {
  if (params.transition !== undefined) return 'transition';
  if (params.ready !== undefined) return 'ready';
  if (params.assign !== undefined) return 'assign';
  if (params.validActions !== undefined) return 'validActions';
  return undefined;
}

/**
 * Determine the sub-operation for an annotate call
 */
function getAnnotateOperation(params: AnnotateParams): string | undefined {
  if (params.create !== undefined) return 'create';
  if (params.resolve !== undefined) return 'resolve';
  if (params.dismiss !== undefined) return 'dismiss';
  if (params.reopen !== undefined) return 'reopen';
  return undefined;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register tools method handlers on an IPC server.
 *
 * Each tool invocation is recorded in the SkillTrackerRegistry when a
 * _sessionId is provided in the request params. This enables querying
 * which skills were used during a particular agent trajectory.
 */
export function registerToolsMethods(options: ToolsMethodsOptions): void {
  const { server, locationResolver } = options;
  const registry = options.skillTrackerRegistry;

  // tools.link - Create/remove edges between nodes
  server.handle<LinkParams & TrackingContext, LinkResult>('tools.link', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' };
    }

    const { location, _sessionId, _agentId, ...linkParams } = params;
    const state = locationResolver.resolve(location);
    const startTime = Date.now();

    const result = await link(state.store, linkParams);

    // Record skill invocation
    if (_sessionId && registry) {
      const tracker = registry.getOrCreate(_sessionId, _agentId);
      tracker.record({
        skill: 'link',
        success: result.success,
        durationMs: Date.now() - startTime,
        operation: linkParams.remove ? 'remove' : 'create',
        targets: [linkParams.fromId, linkParams.toId].filter(Boolean),
        error: result.error,
      });
    }

    // Mark nodes dirty and schedule flush on success
    if (result.success) {
      if (isLocalId(linkParams.fromId)) {
        state.flushManager.markDirty(linkParams.fromId);
      }
      if (isLocalId(linkParams.toId)) {
        state.flushManager.markDirty(linkParams.toId);
      }
      state.flushManager.schedule();
    }

    return result;
  });

  // tools.query - Query the graph with unified interface
  server.handle<QueryParams & TrackingContext, QueryResult>('tools.query', async (params) => {
    if (!params) {
      throw new Error('Missing required parameters');
    }

    const { location, _sessionId, _agentId, ...queryParams } = params;
    const state = locationResolver.resolve(location);
    const startTime = Date.now();

    let result: QueryResult;
    let error: string | undefined;

    try {
      result = await query(state.store, queryParams);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // Record failure before re-throwing
      if (_sessionId && registry) {
        const tracker = registry.getOrCreate(_sessionId, _agentId);
        tracker.record({
          skill: 'query',
          success: false,
          durationMs: Date.now() - startTime,
          operation: getQueryOperation(queryParams),
          error,
        });
      }
      throw e;
    }

    // Record skill invocation
    if (_sessionId && registry) {
      const tracker = registry.getOrCreate(_sessionId, _agentId);
      tracker.record({
        skill: 'query',
        success: true,
        durationMs: Date.now() - startTime,
        operation: getQueryOperation(queryParams),
      });
    }

    return result;
  });

  // tools.annotate - Manage feedback lifecycle
  server.handle<AnnotateParams & TrackingContext, AnnotateResult>(
    'tools.annotate',
    async (params) => {
      if (!params) {
        return { success: false, error: 'Missing required parameters' };
      }

      const { location, _sessionId, _agentId, ...annotateParams } = params;
      const state = locationResolver.resolve(location);
      const startTime = Date.now();

      const result = await annotate(state.store, annotateParams);

      // Record skill invocation
      if (_sessionId && registry) {
        const tracker = registry.getOrCreate(_sessionId, _agentId);
        tracker.record({
          skill: 'annotate',
          success: result.success,
          durationMs: Date.now() - startTime,
          operation: getAnnotateOperation(annotateParams),
          targets: [annotateParams.targetId].filter(Boolean),
          error: result.error,
        });
      }

      // Mark nodes dirty and schedule flush on success
      if (result.success) {
        if (isLocalId(annotateParams.targetId)) {
          state.flushManager.markDirty(annotateParams.targetId);
        }
        if (result.feedbackId && isLocalId(result.feedbackId)) {
          state.flushManager.markDirty(result.feedbackId);
        }
        if (annotateParams.fromId && isLocalId(annotateParams.fromId)) {
          state.flushManager.markDirty(annotateParams.fromId);
        }
        state.flushManager.schedule();
      }

      return result;
    },
  );

  // tools.task - Task lifecycle operations
  server.handle<TaskParams & TrackingContext, TaskResult>('tools.task', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' };
    }

    const { location, _sessionId, _agentId, ...taskParams } = params;
    const state = locationResolver.resolve(location);
    const startTime = Date.now();

    if (!state.providerStore) {
      const error = 'Provider store not available';
      if (_sessionId && registry) {
        const tracker = registry.getOrCreate(_sessionId, _agentId);
        tracker.record({
          skill: 'task',
          success: false,
          durationMs: Date.now() - startTime,
          operation: getTaskOperation(taskParams),
          error,
        });
      }
      return { success: false, error };
    }

    const result = await task(state.providerStore, taskParams);

    // Record skill invocation
    if (_sessionId && registry) {
      const tracker = registry.getOrCreate(_sessionId, _agentId);
      const targets: string[] = [];
      if (taskParams.transition?.id) targets.push(taskParams.transition.id);
      if (taskParams.assign?.id) targets.push(taskParams.assign.id);
      if (taskParams.validActions?.id) targets.push(taskParams.validActions.id);

      tracker.record({
        skill: 'task',
        success: result.success,
        durationMs: Date.now() - startTime,
        operation: getTaskOperation(taskParams),
        targets: targets.length > 0 ? targets : undefined,
        error: result.error,
      });
    }

    // Mark nodes dirty and schedule flush for mutations
    if (result.success && result.data) {
      if (result.data.type === 'transition' && isLocalId(result.data.node.id)) {
        state.flushManager.markDirty(result.data.node.id);
        state.flushManager.schedule();
      }
      if (result.data.type === 'assign' && isLocalId(result.data.node.id)) {
        state.flushManager.markDirty(result.data.node.id);
        state.flushManager.schedule();
      }
    }

    return result;
  });

  // ============================================================================
  // Skill Tracking Methods
  // ============================================================================

  // tracking.skills - Get skill usage summary for a session
  server.handle<{ sessionId: string }, SkillUsageSummary | null>(
    'tracking.skills',
    async (params) => {
      if (!params?.sessionId) {
        throw new Error('Missing required parameter: sessionId');
      }
      if (!registry) return null;

      const tracker = registry.get(params.sessionId);
      if (!tracker) return null;

      return tracker.getSummary();
    },
  );

  // tracking.skills.all - Get all active session skill summaries
  server.handle<Record<string, never>, SkillUsageSummary[]>(
    'tracking.skills.all',
    async () => {
      if (!registry) return [];
      return registry.getAllSummaries();
    },
  );

  // tracking.skills.end - End tracking for a session and return final summary
  server.handle<{ sessionId: string }, SkillUsageSummary | null>(
    'tracking.skills.end',
    async (params) => {
      if (!params?.sessionId) {
        throw new Error('Missing required parameter: sessionId');
      }
      if (!registry) return null;

      return registry.remove(params.sessionId);
    },
  );
}
