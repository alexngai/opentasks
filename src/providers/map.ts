/**
 * MAP (Multi-Agent Protocol) Provider
 *
 * Provider that bridges MAP task operations with OpenTasks.
 * Handles map:// URI scheme for tasks managed via MAP.
 *
 * Supports three scenarios:
 * 1. Same OpenTasks repo — MAP used for real-time coordination, native provider resolves tasks
 * 2. Cross-system — tasks on a remote system accessed via MAP task methods
 * 3. Mixed — local tasks with MAP-based assignment to external agents
 *
 * The provider depends on a MAPTaskClient interface, which can be satisfied by:
 * - A MAP SDK ClientConnection (hub topology)
 * - A MAP SDK BaseConnection wrapper (peer topology)
 * - A local adapter (same-repo coordination, no network)
 */

import type {
  Provider,
  ProviderCapabilities,
  ProviderNode,
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderFilter,
  ProviderOperationContext,
  ParsedUri,
  UriOptions,
} from './types.js';
import { ProviderError } from './types.js';
import type { TaskManageable, TaskAction, TaskCapabilities, ReadyTaskOptions } from './traits/TaskManageable.js';
import type { Watchable, WatchGranularity, WatchChangeCallback } from './traits/Watchable.js';

// ============================================================================
// MAPTaskClient Interface
// ============================================================================

/**
 * MAP task status values (matches MAP SDK MAPTaskStatus)
 */
export type MAPTaskStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'failed';

/**
 * MAP task structure (matches MAP SDK MAPTask)
 */
export interface MAPTask {
  id: string;
  assignee?: string | null;
  title?: string;
  status?: MAPTaskStatus;
  description?: string;
  meta?: Record<string, unknown>;
}

/**
 * MAP task event (for Watchable support)
 */
export interface MAPTaskEvent {
  type: 'task.created' | 'task.assigned' | 'task.status' | 'task.completed';
  data: Record<string, unknown>;
}

/**
 * Interface for anything that can perform MAP task operations.
 *
 * This is the abstraction boundary between OpenTasks and MAP.
 * Implementations include:
 * - MAP SDK ClientConnection (satisfies this naturally)
 * - A future PeerConnection
 * - A local GraphStore adapter (for same-repo scenario)
 *
 * The interface uses the same parameter/response shapes as the MAP SDK
 * so that ClientConnection can be passed directly without an adapter.
 */
export interface MAPTaskClient {
  createTask(params: {
    task: Omit<MAPTask, 'id'> & { id?: string };
  }): Promise<{ task: MAPTask }>;

  assignTask(
    taskId: string,
    agentId: string,
  ): Promise<{ task: MAPTask }>;

  updateTask(params: {
    taskId: string;
    status?: MAPTaskStatus;
    title?: string;
    description?: string;
    assignee?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<{ task: MAPTask }>;

  listTasks(params?: {
    filter?: {
      assignee?: string;
      status?: MAPTaskStatus | MAPTaskStatus[];
    };
    limit?: number;
    cursor?: string;
  }): Promise<{
    tasks: MAPTask[];
    hasMore: boolean;
    nextCursor?: string;
  }>;

  /**
   * Subscribe to task events. Optional — enables the Watchable trait.
   * Returns an unsubscribe function.
   */
  onTaskEvent?(callback: (event: MAPTaskEvent) => void): () => void;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for MAP provider
 */
export interface MAPProviderConfig {
  /** The MAP task client to use for operations */
  client: MAPTaskClient;

  /**
   * System identifier for this MAP connection.
   * Used in URIs: map://{systemId}/{taskId}
   * Defaults to 'default'.
   */
  systemId?: string;

  /** Request timeout in ms */
  timeout?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Pattern for map:// URIs: map://[systemId/]taskId */
const MAP_URI_PATTERN = /^map:\/\/(?:([^/]+)\/)?(.+)$/i;

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map MAP task status to OpenTasks normalized status
 */
function mapStatusToOpenTasks(status?: MAPTaskStatus): string {
  switch (status) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'blocked': return 'blocked';
    case 'completed': return 'closed';
    case 'failed': return 'closed';
    default: return 'open';
  }
}

/**
 * Map OpenTasks status to MAP task status
 */
function mapStatusToMAP(status?: string): MAPTaskStatus {
  switch (status?.toLowerCase()) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'blocked': return 'blocked';
    case 'closed': return 'completed';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'open';
  }
}

/**
 * Map semantic task action to MAP status
 */
function actionToMAPStatus(action: TaskAction): MAPTaskStatus {
  switch (action) {
    case 'start': return 'in_progress';
    case 'complete': return 'completed';
    case 'block': return 'blocked';
    case 'reopen': return 'open';
    case 'close': return 'completed';
  }
}

// ============================================================================
// Type Conversion
// ============================================================================

/**
 * Convert MAP task to ProviderNode
 */
function taskToProviderNode(task: MAPTask, systemId: string): ProviderNode {
  return {
    id: task.id,
    uri: `map://${systemId}/${task.id}`,
    type: 'task',
    title: task.title ?? '',
    content: task.description,
    status: mapStatusToOpenTasks(task.status),
    priority: (task.meta?.priority as number) ?? 2,
    rawData: {
      assignee: task.assignee,
      status: task.status,
      meta: task.meta,
    },
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// MAP Provider Implementation
// ============================================================================

/**
 * Create a MAP provider
 *
 * @param config - Provider configuration including the MAPTaskClient
 * @returns A Provider that implements TaskManageable and optionally Watchable
 */
export function createMAPProvider(
  config: MAPProviderConfig,
): Provider & TaskManageable & Partial<Watchable> {
  const { client, systemId = 'default', timeout = 30000 } = config;
  const hasEvents = typeof client.onTaskEvent === 'function';

  let watchCallback: WatchChangeCallback | null = null;
  let unsubscribeEvents: (() => void) | null = null;

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: false,
    watch: hasEvents,
    mount: true,
    feedback: false,
  };

  const taskCapabilities: TaskCapabilities = {
    actions: ['start', 'complete', 'block', 'reopen', 'close'],
    supportsAssignment: true,
    supportsReadyQuery: true,
    statusModel: ['open', 'in_progress', 'blocked', 'completed', 'failed'],
  };

  const watchGranularity: WatchGranularity = {
    reportsChangedFields: false,
    reportsPreviousValues: true,
    reportsEdgeChanges: false,
    mechanism: 'stream',
  };

  const provider: Provider & TaskManageable & Partial<Watchable> = {
    name: 'map',
    schemes: ['map'],
    capabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      const match = uri.match(MAP_URI_PATTERN);
      if (match) {
        return {
          scheme: 'map',
          workspace: match[1] || systemId,
          id: match[2],
          isRelative: !match[1] || match[1] === systemId,
        };
      }
      return null;
    },

    buildUri(id: string, options?: UriOptions): string {
      const ws = options?.workspace ?? systemId;
      return `map://${ws}/${id}`;
    },

    isValidUri(uri: string): boolean {
      return this.parseUri(uri) !== null;
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(id: string, _context?: ProviderOperationContext): Promise<ProviderNode | null> {
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id;

      try {
        const { tasks } = await client.listTasks({
          limit: 100,
        });
        const task = tasks.find((t) => t.id === taskId);
        return task ? taskToProviderNode(task, systemId) : null;
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to get MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async list(
      filter?: ProviderFilter,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      try {
        const mapFilter: { assignee?: string; status?: MAPTaskStatus } = {};
        if (filter?.status) {
          mapFilter.status = mapStatusToMAP(filter.status);
        }

        const { tasks } = await client.listTasks({
          filter: Object.keys(mapFilter).length > 0 ? mapFilter : undefined,
          limit: filter?.limit,
        });

        return tasks.map((task) => taskToProviderNode(task, systemId));
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to list MAP tasks: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async create(
      input: ProviderCreateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      try {
        const { task } = await client.createTask({
          task: {
            title: input.title,
            description: input.content,
            status: input.status ? mapStatusToMAP(input.status) : 'open',
            meta: {
              ...input.metadata,
              ...input.extensions,
              provider: 'opentasks',
              priority: input.priority,
            },
          },
        });

        return taskToProviderNode(task, systemId);
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to create MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async update(
      id: string,
      updates: ProviderUpdateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id;

      try {
        const { task } = await client.updateTask({
          taskId,
          ...(updates.title !== undefined && { title: updates.title }),
          ...(updates.content !== undefined && { description: updates.content }),
          ...(updates.status !== undefined && { status: mapStatusToMAP(updates.status) }),
          ...(updates.metadata !== undefined && { meta: updates.metadata }),
        });

        return taskToProviderNode(task, systemId);
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to update MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async delete(id: string, _context?: ProviderOperationContext): Promise<void> {
      // MAP doesn't have a delete method — mark as failed/completed instead
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id;

      try {
        await client.updateTask({
          taskId,
          status: 'failed',
          meta: { deleted: true, deletedAt: new Date().toISOString() },
        });
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to delete MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    // =========================================================================
    // TaskManageable Trait
    // =========================================================================

    taskCapabilities,

    async transitionTask(
      id: string,
      action: TaskAction,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id;

      try {
        const { task } = await client.updateTask({
          taskId,
          status: actionToMAPStatus(action),
        });

        return taskToProviderNode(task, systemId);
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to transition MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      try {
        const { tasks } = await client.listTasks({
          filter: {
            status: 'open',
            ...(options?.assignee && { assignee: options.assignee }),
          },
          limit: options?.limit,
        });

        let result = tasks.map((task) => taskToProviderNode(task, systemId));

        // Filter by priority if specified (MAP doesn't have native priority filtering)
        if (options?.priority !== undefined) {
          result = result.filter((node) => (node.priority ?? 0) >= options.priority!);
        }

        return result;
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to query ready MAP tasks: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async assignTask(
      id: string,
      assignee: string,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const parsed = this.parseUri(id);
      const taskId = parsed?.id ?? id;

      try {
        const { task } = await client.assignTask(taskId, assignee);
        return taskToProviderNode(task, systemId);
      } catch (error) {
        throw new ProviderError(
          'OPERATION_FAILED',
          `Failed to assign MAP task: ${error instanceof Error ? error.message : String(error)}`,
          'map',
          error instanceof Error ? error : undefined,
        );
      }
    },

    async validActions(id: string, _context?: ProviderOperationContext): Promise<TaskAction[]> {
      const node = await this.get(id);
      if (!node) return [];

      const status = node.rawData?.status as MAPTaskStatus | undefined;
      switch (status) {
        case 'open': return ['start', 'block', 'close'];
        case 'in_progress': return ['complete', 'block'];
        case 'blocked': return ['reopen', 'close'];
        case 'completed': return ['reopen'];
        case 'failed': return ['reopen'];
        default: return ['start', 'complete', 'block', 'reopen', 'close'];
      }
    },
  };

  // =========================================================================
  // Watchable Trait (conditional — only if client supports events)
  // =========================================================================

  if (hasEvents) {
    Object.assign(provider, {
      watchGranularity,

      startWatching(callback: WatchChangeCallback): void {
        watchCallback = callback;
        unsubscribeEvents = client.onTaskEvent!((event) => {
          const { type, data } = event;

          switch (type) {
            case 'task.created': {
              const task = data.task as MAPTask;
              if (task) {
                callback({
                  kind: 'node',
                  event: {
                    type: 'created',
                    nodeId: task.id,
                    uri: `map://${systemId}/${task.id}`,
                    node: taskToProviderNode(task, systemId),
                    timestamp: new Date().toISOString(),
                  },
                });
              }
              break;
            }

            case 'task.assigned':
            case 'task.status': {
              const taskId = data.taskId as string;
              if (taskId) {
                callback({
                  kind: 'node',
                  event: {
                    type: 'updated',
                    nodeId: taskId,
                    uri: `map://${systemId}/${taskId}`,
                    previousValues: type === 'task.status' ? { status: data.previous } : undefined,
                    timestamp: new Date().toISOString(),
                  },
                });
              }
              break;
            }

            case 'task.completed': {
              const taskId = data.taskId as string;
              if (taskId) {
                callback({
                  kind: 'node',
                  event: {
                    type: 'updated',
                    nodeId: taskId,
                    uri: `map://${systemId}/${taskId}`,
                    changedFields: ['status'],
                    previousValues: { status: 'in_progress' },
                    timestamp: new Date().toISOString(),
                  },
                });
              }
              break;
            }
          }
        });
      },

      stopWatching(): void {
        if (unsubscribeEvents) {
          unsubscribeEvents();
          unsubscribeEvents = null;
        }
        watchCallback = null;
      },

      get isWatching(): boolean {
        return watchCallback !== null;
      },
    });
  }

  return provider;
}
