/**
 * Global Provider
 *
 * IPC-based provider that communicates with the global daemon at ~/.opentasks/
 * to enable federation between project-level and global task stores.
 *
 * Uses the `global://` URI scheme. All CRUD operations are forwarded to the
 * global daemon via JSON-RPC over Unix socket.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createIPCClient, type IPCClient } from '../daemon/ipc.js';
import {
  ProviderError,
  type Provider,
  type ProviderCapabilities,
  type ProviderNode,
  type ProviderFilter,
  type ProviderCreateInput,
  type ProviderUpdateInput,
  type ProviderOperationContext,
  type ParsedUri,
  type UriOptions,
} from './types.js';
import type {
  TaskManageable,
  TaskCapabilities,
  TaskAction,
  ReadyTaskOptions,
} from './traits/TaskManageable.js';
import type {
  Watchable,
  WatchGranularity,
  WatchChangeCallback,
  ProviderNodeChangeEvent,
} from './traits/Watchable.js';

// ============================================================================
// Types
// ============================================================================

export interface GlobalProviderConfig {
  /** Path to global .opentasks/ directory (default: ~/.opentasks) */
  globalPath?: string;

  /** IPC timeout in ms (default: 10000) */
  timeout?: number;

  /** Cache TTL in ms (default: 300000) */
  cacheTTL?: number;
}

// ============================================================================
// URI Parsing
// ============================================================================

const GLOBAL_URI_PATTERN = /^global:\/\/(.+)$/i;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create a global provider that communicates with the global daemon via IPC.
 *
 * The provider lazily connects to the global daemon on first use and
 * reconnects on connection drops.
 */
export function createGlobalProvider(
  config: GlobalProviderConfig = {},
): Provider & TaskManageable & Watchable {
  const globalPath = config.globalPath || path.join(os.homedir(), '.opentasks');
  const socketPath = path.join(globalPath, 'daemon.sock');
  const timeout = config.timeout ?? 10000;

  let client: IPCClient | null = null;
  let watchCallback: WatchChangeCallback | null = null;
  let notificationUnsubscribe: (() => void) | null = null;

  /**
   * Get or create a connected IPC client.
   * Lazily connects on first use, reconnects if disconnected.
   */
  async function getClient(): Promise<IPCClient> {
    if (client && client.connected) {
      return client;
    }

    // Check socket exists before attempting connection
    if (!fs.existsSync(socketPath)) {
      throw new ProviderError(
        'PROVIDER_ERROR',
        `Global daemon not running (no socket at ${socketPath})`,
        'global',
      );
    }

    client = createIPCClient(socketPath);
    try {
      await client.connect();
    } catch (error) {
      client = null;
      throw new ProviderError(
        'PROVIDER_ERROR',
        `Failed to connect to global daemon at ${socketPath}`,
        'global',
        error instanceof Error ? error : undefined,
      );
    }
    return client;
  }

  /**
   * Execute an IPC request with error handling.
   * For read operations, returns null/[] on connection failure.
   * For write operations, throws on failure.
   */
  async function ipcRequest<T>(
    method: string,
    params?: unknown,
    opts?: { gracefulOnError?: boolean },
  ): Promise<T> {
    try {
      const ipc = await getClient();
      return await ipc.request<T>(method, params);
    } catch (error) {
      if (opts?.gracefulOnError) {
        return null as T;
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'PROVIDER_ERROR',
        `Global daemon request failed: ${(error as Error).message}`,
        'global',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Convert a daemon node response to a ProviderNode.
   */
  function toProviderNode(node: Record<string, unknown>): ProviderNode {
    return {
      id: node.id as string,
      uri: `global://${node.id as string}`,
      type: (node.type as ProviderNode['type']) ?? 'task',
      title: (node.title as string) ?? '',
      content: node.content as string | undefined,
      status: node.status as string | undefined,
      priority: node.priority as number | undefined,
      rawData: node,
      fetchedAt: new Date().toISOString(),
    };
  }

  // ============================================================================
  // Provider Interface
  // ============================================================================

  const capabilities: ProviderCapabilities = {
    read: true,
    write: true,
    search: true,
    watch: true,
    mount: true,
    feedback: false,
  };

  const taskCapabilities: TaskCapabilities = {
    actions: ['start', 'complete', 'block', 'reopen', 'close'],
    supportsAssignment: true,
    supportsReadyQuery: true,
    statusModel: ['open', 'in_progress', 'blocked', 'closed'],
  };

  return {
    name: 'global',
    schemes: ['global'],
    capabilities,
    taskCapabilities,

    // =========================================================================
    // URI Operations
    // =========================================================================

    parseUri(uri: string): ParsedUri | null {
      const match = uri.match(GLOBAL_URI_PATTERN);
      if (!match) return null;
      return {
        scheme: 'global',
        id: match[1],
        workspace: '.',
        isRelative: true,
      };
    },

    buildUri(id: string, _options?: UriOptions): string {
      return `global://${id}`;
    },

    isValidUri(uri: string): boolean {
      return GLOBAL_URI_PATTERN.test(uri);
    },

    // =========================================================================
    // CRUD Operations
    // =========================================================================

    async get(
      id: string,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode | null> {
      const result = await ipcRequest<Record<string, unknown> | null>(
        'graph.get',
        { id },
        { gracefulOnError: true },
      );
      if (!result) return null;
      return toProviderNode(result);
    },

    async list(
      filter?: ProviderFilter,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const result = await ipcRequest<Record<string, unknown>[]>(
        'graph.query',
        {
          type: filter?.type,
          filter: {
            status: filter?.status,
            search: filter?.search,
          },
          limit: filter?.limit,
          offset: filter?.offset,
        },
        { gracefulOnError: true },
      );
      if (!result) return [];
      return result.map(toProviderNode);
    },

    async create(
      input: ProviderCreateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const result = await ipcRequest<Record<string, unknown>>('graph.create', {
        type: input.type,
        title: input.title,
        content: input.content,
        status: input.status ?? 'open',
        priority: input.priority,
        metadata: input.metadata,
      });
      return toProviderNode(result);
    },

    async update(
      id: string,
      updates: ProviderUpdateInput,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const result = await ipcRequest<Record<string, unknown>>('graph.update', {
        id,
        title: updates.title,
        content: updates.content,
        status: updates.status,
        priority: updates.priority,
        metadata: updates.metadata,
      });
      return toProviderNode(result);
    },

    async delete(
      id: string,
      _context?: ProviderOperationContext,
    ): Promise<void> {
      await ipcRequest<void>('graph.delete', { id });
    },

    // =========================================================================
    // Search
    // =========================================================================

    async search(
      query: string,
      options?: { limit?: number; type?: string },
    ): Promise<ProviderNode[]> {
      const result = await ipcRequest<Record<string, unknown>[]>(
        'graph.query',
        {
          type: options?.type,
          filter: { search: query },
          limit: options?.limit,
        },
        { gracefulOnError: true },
      );
      if (!result) return [];
      return result.map(toProviderNode);
    },

    // =========================================================================
    // TaskManageable Trait
    // =========================================================================

    async transitionTask(
      id: string,
      action: TaskAction,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const result = await ipcRequest<{
        success: boolean;
        data?: { node: Record<string, unknown> };
        error?: string;
      }>('tools.task', {
        operation: 'transition',
        taskId: id,
        action,
      });
      if (!result?.success || !result.data?.node) {
        throw new ProviderError(
          'OPERATION_FAILED',
          result?.error ?? `Failed to transition task ${id}`,
          'global',
        );
      }
      return toProviderNode(result.data.node);
    },

    async readyTasks(
      options?: ReadyTaskOptions,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode[]> {
      const result = await ipcRequest<{
        success: boolean;
        data?: { nodes: Record<string, unknown>[] };
        error?: string;
      }>(
        'tools.task',
        {
          operation: 'ready',
          limit: options?.limit,
          tags: options?.tags,
          priority: options?.priority,
          assignee: options?.assignee,
        },
        { gracefulOnError: true },
      );
      if (!result?.success || !result.data?.nodes) return [];
      return result.data.nodes.map(toProviderNode);
    },

    async assignTask(
      id: string,
      assignee: string,
      _context?: ProviderOperationContext,
    ): Promise<ProviderNode> {
      const result = await ipcRequest<{
        success: boolean;
        data?: { node: Record<string, unknown> };
        error?: string;
      }>('tools.task', {
        operation: 'assign',
        taskId: id,
        assignee,
      });
      if (!result?.success || !result.data?.node) {
        throw new ProviderError(
          'OPERATION_FAILED',
          result?.error ?? `Failed to assign task ${id}`,
          'global',
        );
      }
      return toProviderNode(result.data.node);
    },

    async validActions(
      id: string,
      _context?: ProviderOperationContext,
    ): Promise<TaskAction[]> {
      const result = await ipcRequest<{
        success: boolean;
        data?: { actions: TaskAction[] };
        error?: string;
      }>(
        'tools.task',
        {
          operation: 'validActions',
          taskId: id,
        },
        { gracefulOnError: true },
      );
      if (!result?.success || !result.data?.actions) {
        return taskCapabilities.actions;
      }
      return result.data.actions;
    },

    // =========================================================================
    // Watchable Trait
    // =========================================================================

    watchGranularity: {
      reportsChangedFields: false,
      reportsPreviousValues: false,
      reportsEdgeChanges: false,
      mechanism: 'stream' as const,
    } satisfies WatchGranularity,

    startWatching(callback: WatchChangeCallback): void {
      watchCallback = callback;

      // Subscribe via IPC — fire and forget, watch starts when subscribe completes
      void (async () => {
        try {
          const ipc = await getClient();

          // Register notification handler for watch events
          if (notificationUnsubscribe) {
            notificationUnsubscribe();
          }
          notificationUnsubscribe = ipc.onNotification((method, params) => {
            if (method === 'watch.event' && watchCallback) {
              const event = params as ProviderNodeChangeEvent;
              watchCallback({ kind: 'node', event });
            }
          });

          // Send subscribe request
          await ipc.request('watch.subscribe', {});
        } catch {
          // Graceful degradation: watch may fail if global daemon is down
        }
      })();
    },

    stopWatching(): void {
      const cb = watchCallback;
      watchCallback = null;

      if (notificationUnsubscribe) {
        notificationUnsubscribe();
        notificationUnsubscribe = null;
      }

      if (cb && client?.connected) {
        void client.request('watch.unsubscribe', {}).catch(() => {
          // Ignore errors during teardown
        });
      }
    },

    get isWatching(): boolean {
      return watchCallback !== null;
    },
  };
}
