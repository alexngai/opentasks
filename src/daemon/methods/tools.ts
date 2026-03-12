/**
 * Tools Method Handlers
 *
 * JSON-RPC method handlers for the 3-tool agent interface via IPC.
 * Location-aware: extracts optional `location` from params to route
 * to the correct store via LocationResolver.
 *
 * Skill tracking query methods are provided to read from the
 * SkillTrackerRegistry (populated by TranscriptExtractor on session end).
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
 * Options for registering tools methods
 */
export interface ToolsMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver;

  /** Skill tracker registry for querying usage (populated by TranscriptExtractor) */
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

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register tools method handlers on an IPC server.
 *
 * Tool handlers route to the correct store via LocationResolver.
 * Skill usage is tracked via TranscriptExtractor (post-hoc from sessionlog
 * session transcripts), not inline in these handlers.
 */
export function registerToolsMethods(options: ToolsMethodsOptions): void {
  const { server, locationResolver } = options;
  const registry = options.skillTrackerRegistry;

  // tools.link - Create/remove edges between nodes
  server.handle<LinkParams & { location?: string }, LinkResult>('tools.link', async (params) => {
    if (!params) {
      return { success: false, error: 'Missing required parameters' };
    }

    const { location, ...linkParams } = params;
    const state = locationResolver.resolve(location);

    const result = await link(state.store, linkParams);

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
  // When providerStore is available, task queries are federated across providers
  server.handle<QueryParams & { location?: string }, QueryResult>(
    'tools.query',
    async (params) => {
      if (!params) {
        throw new Error('Missing required parameters');
      }

      const { location, ...queryParams } = params;
      const state = locationResolver.resolve(location);

      return await query(state.store, queryParams, undefined, state.providerStore ?? undefined);
    },
  );

  // tools.annotate - Manage feedback lifecycle
  server.handle<AnnotateParams & { location?: string }, AnnotateResult>(
    'tools.annotate',
    async (params) => {
      if (!params) {
        return { success: false, error: 'Missing required parameters' };
      }

      const { location, ...annotateParams } = params;
      const state = locationResolver.resolve(location);

      const result = await annotate(state.store, annotateParams);

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
  server.handle<TaskParams & { location?: string }, TaskResult>(
    'tools.task',
    async (params) => {
      if (!params) {
        return { success: false, error: 'Missing required parameters' };
      }

      const { location, ...taskParams } = params;
      const state = locationResolver.resolve(location);

      if (!state.providerStore) {
        return { success: false, error: 'Provider store not available' };
      }

      const result = await task(state.providerStore, taskParams);

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
    },
  );

  // ============================================================================
  // Skill Tracking Query Methods
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
