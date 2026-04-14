/**
 * MAP Connector
 *
 * Handles incoming MAP notifications and routes them to the local
 * OpenTasks daemon. This makes the daemon's capabilities accessible
 * to remote agents over the MAP protocol.
 *
 * The connector listens for `opentasks/*.request` notifications,
 * calls the local OpenTasksClient, and sends `opentasks/*.response`
 * notifications back. This follows the same request/response pattern
 * as the MAP trajectory protocol.
 *
 * Usage:
 *
 * ```typescript
 * import { createMAPConnector } from 'opentasks';
 * import { OpenTasksClient } from 'opentasks';
 *
 * const client = new OpenTasksClient();
 * await client.connect();
 *
 * const connector = createMAPConnector({
 *   client,
 *   send: (method, params) => {
 *     connection.sendNotification(method, params);
 *   },
 * });
 *
 * // Route incoming MAP notifications to the connector:
 * connection.onNotification('opentasks/query.request', (params) => {
 *   connector.handleNotification('opentasks/query.request', params);
 * });
 * // ... same for link.request, annotate.request, task.request
 *
 * // Cleanup:
 * connector.stop();
 * ```
 */

import type { OpenTasksClient } from '../client/client.js';
import type { QueryParams, QueryResult, LinkParams, LinkResult, AnnotateParams, AnnotateResult, TaskParams, TaskResult } from '../tools/types.js';
import type { CreateNodeInput, UpdateNodeInput } from '../graph/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Function to send a MAP notification.
 * The connector calls this to send responses back to the requester.
 */
export type MAPNotificationSender = (method: string, params: Record<string, unknown>) => void;

/**
 * Configuration for the MAP connector.
 */
export interface MAPConnectorConfig {
  /** OpenTasks client connected to the local daemon */
  client: OpenTasksClient;

  /** Function to send MAP notifications (response notifications) */
  send: MAPNotificationSender;

  /** Optional agent ID for logging/tracing */
  agentId?: string;
}

/**
 * The MAP connector instance.
 */
export interface MAPConnector {
  /**
   * Handle an incoming MAP notification.
   * Routes `opentasks/*.request` methods to the local daemon
   * and sends `opentasks/*.response` back.
   */
  handleNotification(method: string, params: Record<string, unknown>): void;

  /** Stop the connector (cleanup) */
  stop(): void;

  /** Whether the connector is active */
  readonly active: boolean;
}

// ============================================================================
// Request/Response Methods
// ============================================================================

const METHODS = {
  QUERY_REQUEST: 'opentasks/query.request',
  QUERY_RESPONSE: 'opentasks/query.response',
  LINK_REQUEST: 'opentasks/link.request',
  LINK_RESPONSE: 'opentasks/link.response',
  ANNOTATE_REQUEST: 'opentasks/annotate.request',
  ANNOTATE_RESPONSE: 'opentasks/annotate.response',
  TASK_REQUEST: 'opentasks/task.request',
  TASK_RESPONSE: 'opentasks/task.response',
  GRAPH_CREATE_REQUEST: 'opentasks/graph.create.request',
  GRAPH_CREATE_RESPONSE: 'opentasks/graph.create.response',
  GRAPH_UPDATE_REQUEST: 'opentasks/graph.update.request',
  GRAPH_UPDATE_RESPONSE: 'opentasks/graph.update.response',
} as const;

export { METHODS as MAP_CONNECTOR_METHODS };

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a MAP connector that handles incoming opentasks requests
 * by routing them to the local daemon.
 */
export function createMAPConnector(config: MAPConnectorConfig): MAPConnector {
  const { client, send, agentId } = config;
  let active = true;

  async function handleQuery(requestId: string, query: QueryParams): Promise<void> {
    try {
      const result: QueryResult = await client.query(query);
      send(METHODS.QUERY_RESPONSE, {
        request_id: requestId,
        items: result.items,
        total: result.total,
        hasMore: result.hasMore,
        contextSummary: result.contextSummary,
      });
    } catch (err) {
      send(METHODS.QUERY_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  async function handleLink(requestId: string, params: LinkParams): Promise<void> {
    try {
      const result: LinkResult = await client.link(params);
      send(METHODS.LINK_RESPONSE, {
        request_id: requestId,
        ...result,
      });
    } catch (err) {
      send(METHODS.LINK_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  async function handleAnnotate(requestId: string, params: AnnotateParams): Promise<void> {
    try {
      const result: AnnotateResult = await client.annotate(params);
      send(METHODS.ANNOTATE_RESPONSE, {
        request_id: requestId,
        ...result,
      });
    } catch (err) {
      send(METHODS.ANNOTATE_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  async function handleTask(requestId: string, params: TaskParams): Promise<void> {
    try {
      const result: TaskResult = await client.task(params);
      send(METHODS.TASK_RESPONSE, {
        request_id: requestId,
        ...result,
      });
    } catch (err) {
      send(METHODS.TASK_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  async function handleGraphCreate(requestId: string, params: CreateNodeInput): Promise<void> {
    try {
      const node = await client.createNode(params);
      send(METHODS.GRAPH_CREATE_RESPONSE, {
        request_id: requestId,
        node,
      });
    } catch (err) {
      send(METHODS.GRAPH_CREATE_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  async function handleGraphUpdate(
    requestId: string,
    params: { id: string } & UpdateNodeInput,
  ): Promise<void> {
    try {
      const { id, ...updates } = params;
      if (!id) {
        send(METHODS.GRAPH_UPDATE_RESPONSE, {
          request_id: requestId,
          error: 'Missing id',
        });
        return;
      }
      const node = await client.updateNode(id, updates);
      send(METHODS.GRAPH_UPDATE_RESPONSE, {
        request_id: requestId,
        node,
      });
    } catch (err) {
      send(METHODS.GRAPH_UPDATE_RESPONSE, {
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  return {
    handleNotification(method: string, params: Record<string, unknown>): void {
      if (!active) return;

      const requestId = params.request_id as string;
      if (!requestId) {
        // No request_id — can't send a response, skip
        return;
      }

      switch (method) {
        case METHODS.QUERY_REQUEST:
          handleQuery(requestId, (params.query ?? params) as QueryParams).catch(() => {});
          break;
        case METHODS.LINK_REQUEST:
          handleLink(requestId, (params.link ?? params) as LinkParams).catch(() => {});
          break;
        case METHODS.ANNOTATE_REQUEST:
          handleAnnotate(requestId, (params.annotate ?? params) as AnnotateParams).catch(() => {});
          break;
        case METHODS.TASK_REQUEST:
          handleTask(requestId, (params.task ?? params) as TaskParams).catch(() => {});
          break;
        case METHODS.GRAPH_CREATE_REQUEST:
          handleGraphCreate(requestId, (params.create ?? params) as CreateNodeInput).catch(() => {});
          break;
        case METHODS.GRAPH_UPDATE_REQUEST:
          handleGraphUpdate(
            requestId,
            (params.update ?? params) as { id: string } & UpdateNodeInput,
          ).catch(() => {});
          break;
        // Ignore unknown methods
      }
    },

    stop(): void {
      active = false;
    },

    get active(): boolean {
      return active;
    },
  };
}
