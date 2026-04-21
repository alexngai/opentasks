/**
 * MAP Event Bridge
 *
 * Translates OpenTasks graph changes into MAP task events for observability.
 * Standalone utility — can be used by the daemon (attached to graph store changes)
 * or by individual agent processes (emit-your-own-actions pattern).
 *
 * The bridge is independent of the MAP provider. The provider handles inbound
 * (MAP → OpenTasks); the bridge handles outbound (OpenTasks → MAP).
 *
 * Accepts either a send function or a MAP connection object (compatible with
 * agent-inbox's MapConnection interface), so multiple systems can share one
 * connection — e.g., agent-inbox handles messaging while this bridge handles
 * task events, both over the same MAP connection.
 *
 * Usage patterns:
 *
 * 1. With a send function:
 *    ```
 *    const bridge = createMAPEventBridge({ send, agentId: 'agent-alice' });
 *    bridge.emitTaskCreated({ id: 'task-1', title: 'Do thing', status: 'open' });
 *    ```
 *
 * 2. With a shared MAP connection (e.g., from agent-inbox or MAP SDK):
 *    ```
 *    const bridge = createMAPEventBridge({
 *      connection: mapConnection,
 *      scope: 'swarm:my-team',
 *      agentId: 'agent-alice',
 *    });
 *    bridge.emitTaskStatus('task-1', 'open', 'in_progress');
 *    ```
 *
 * 3. Attached to daemon watch events via IPC:
 *    ```
 *    const bridge = createMAPEventBridge({ send, agentId: 'agent-bob' });
 *    daemonClient.on('watch.event', (event) => bridge.handleProviderChange('native', event));
 *    ```
 */

import type { MAPTaskStatus } from './map.js';
import type { ProviderChangeEvent, ProviderNodeChangeEvent } from './traits/Watchable.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Function that sends a MAP event over a connection.
 *
 * This is the only dependency on the MAP transport layer.
 * A ClientConnection's sendEvent, a BaseConnection's sendNotification,
 * or any custom function that puts events on the wire.
 */
export type MAPEventSender = (eventType: string, data: Record<string, unknown>) => void;

/**
 * Minimal MAP connection interface for sharing a connection with other systems.
 *
 * Compatible with:
 * - agent-inbox's MapConnection
 * - MAP SDK's AgentConnection / ClientConnection
 * - Any object with a send(to, payload, meta?) method
 *
 * The bridge borrows the connection — it does NOT own its lifecycle
 * and will not disconnect it on stop().
 */
export interface MAPConnection {
  send(
    to: { scope?: string; agentId?: string } | string,
    payload: unknown,
    meta?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Minimal task info needed to emit MAP events.
 * Matches the shape agents already have when they perform task operations.
 */
export interface TaskInfo {
  id: string;
  title?: string;
  status?: string;
  description?: string;
  assignee?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Minimal context info needed to emit MAP events.
 *
 * Context nodes are one of OpenTasks' primary node types. The bridge surfaces
 * their lifecycle over the same `map/send` transport tasks use, so a single
 * connected MAP hub picks up context authoring/editing from its connected
 * swarms without needing a second channel.
 *
 * `metadata` travels with the event so receivers (e.g. OpenHive's hub) can
 * route opinionatedly — for example, treating contexts with
 * `metadata.kind === 'spec'` as Spec entities with their own UI surface,
 * while ignoring plain contexts.
 */
export interface ContextInfo {
  id: string;
  title?: string;
  content?: string;
  priority?: number;
  archived?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for creating a MAP event bridge.
 *
 * Provide either `send` (a raw function) or `connection` + `scope`
 * (a shared MAP connection object). If both are provided, `send` takes precedence.
 */
export interface MAPEventBridgeConfig {
  /**
   * Function to send MAP events over the wire.
   * If provided, this is used directly. Mutually exclusive with `connection`.
   */
  send?: MAPEventSender;

  /**
   * A shared MAP connection object (e.g., from agent-inbox or MAP SDK).
   * The bridge adapts connection.send() into the event sender.
   * The bridge does NOT own the connection lifecycle.
   */
  connection?: MAPConnection;

  /**
   * MAP scope to send events to. Required when using `connection`.
   * Ignored when using `send` directly.
   */
  scope?: string;

  /**
   * Origin identifier stamped on all emitted events.
   * Used to prevent echo loops — receivers can filter events
   * that originated from their own system.
   */
  agentId?: string;

  /**
   * Optional filter — return false to suppress an event.
   * Called before sending. Useful for filtering by provider,
   * node type, or any other criteria.
   */
  filter?: (eventType: string, data: Record<string, unknown>) => boolean;
}

/**
 * MAP Event Bridge instance
 */
export interface MAPEventBridge {
  // ---- Direct emit methods (agent-side pattern) ----

  /** Emit a task.created event */
  emitTaskCreated(task: TaskInfo): void;

  /** Emit a task.status event */
  emitTaskStatus(taskId: string, previous: string, current: string): void;

  /** Emit a task.assigned event */
  emitTaskAssigned(taskId: string, assignee: string): void;

  /** Emit a task.completed event */
  emitTaskCompleted(taskId: string, result?: unknown): void;

  /**
   * Emit a context.created event.
   *
   * Context counterpart of `emitTaskCreated`. Carries `metadata` so
   * receivers can apply their own classification (e.g., OpenHive treats
   * `metadata.kind === 'spec'` contexts as Specs for UI routing).
   */
  emitContextCreated(context: ContextInfo): void;

  /**
   * Emit a context.updated event.
   *
   * Accepts a partial set of fields; only the id is required. Fields set
   * to `undefined` are dropped from the wire payload so receivers can
   * distinguish "unchanged" from "explicitly cleared".
   */
  emitContextUpdated(context: ContextInfo): void;

  // ---- Change handler (daemon-side pattern) ----

  /**
   * Handle a ProviderChangeEvent from the graph store.
   * Translates it to the appropriate MAP event(s) and sends.
   *
   * @param providerName - Name of the provider that produced the change
   * @param event - The provider change event
   */
  handleProviderChange(providerName: string, event: ProviderChangeEvent): void;

  /** Stop the bridge and prevent further events from being sent */
  stop(): void;

  /** Whether the bridge is active */
  readonly active: boolean;
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map OpenTasks status to MAP task status for outbound events
 */
function toMAPStatus(status?: string): MAPTaskStatus {
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

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a MAP event bridge
 *
 * @param config - Bridge configuration (provide `send` or `connection` + `scope`)
 * @returns A MAPEventBridge instance
 */
export function createMAPEventBridge(config: MAPEventBridgeConfig): MAPEventBridge {
  const { agentId, filter } = config;

  // Resolve the send function from either direct `send` or `connection` + `scope`
  let send: MAPEventSender;
  if (config.send) {
    send = config.send;
  } else if (config.connection) {
    const connection = config.connection;
    const scope = config.scope || '';
    const target = scope ? { scope } : {};
    send = (eventType: string, data: Record<string, unknown>) => {
      connection.send(target, { type: eventType, ...data }).catch(() => {
        // Best effort — don't block on send failures
      });
    };
  } else {
    throw new Error('MAPEventBridgeConfig requires either `send` or `connection`');
  }

  let active = true;

  function emit(eventType: string, data: Record<string, unknown>): void {
    if (!active) return;

    // Stamp origin metadata
    if (agentId) {
      data._origin = agentId;
    }

    // Apply filter
    if (filter && !filter(eventType, data)) return;

    send(eventType, data);
  }

  const bridge: MAPEventBridge = {
    // ==================================================================
    // Direct Emit Methods
    // ==================================================================

    emitTaskCreated(task: TaskInfo): void {
      emit('task.created', {
        task: {
          id: task.id,
          ...(task.title !== undefined && { title: task.title }),
          ...(task.status !== undefined && { status: toMAPStatus(task.status) }),
          ...(task.description !== undefined && { description: task.description }),
          ...(task.assignee !== undefined && { assignee: task.assignee }),
          ...(task.meta !== undefined && { meta: task.meta }),
        },
      });
    },

    emitTaskStatus(taskId: string, previous: string, current: string): void {
      emit('task.status', {
        taskId,
        previous: toMAPStatus(previous),
        current: toMAPStatus(current),
      });

      // Also emit task.completed if the new status is a terminal state
      if (current === 'completed' || current === 'closed') {
        emit('task.completed', { taskId });
      }
    },

    emitTaskAssigned(taskId: string, assignee: string): void {
      emit('task.assigned', {
        taskId,
        agentId: assignee,
      });
    },

    emitTaskCompleted(taskId: string, result?: unknown): void {
      emit('task.completed', {
        taskId,
        ...(result !== undefined && { result }),
      });
    },

    emitContextCreated(context: ContextInfo): void {
      emit('context.created', {
        context: {
          id: context.id,
          ...(context.title !== undefined && { title: context.title }),
          ...(context.content !== undefined && { content: context.content }),
          ...(context.priority !== undefined && { priority: context.priority }),
          ...(context.archived !== undefined && { archived: context.archived }),
          ...(context.status !== undefined && { status: context.status }),
          ...(context.metadata !== undefined && { metadata: context.metadata }),
        },
      });
    },

    emitContextUpdated(context: ContextInfo): void {
      emit('context.updated', {
        context: {
          id: context.id,
          ...(context.title !== undefined && { title: context.title }),
          ...(context.content !== undefined && { content: context.content }),
          ...(context.priority !== undefined && { priority: context.priority }),
          ...(context.archived !== undefined && { archived: context.archived }),
          ...(context.status !== undefined && { status: context.status }),
          ...(context.metadata !== undefined && { metadata: context.metadata }),
        },
      });
    },

    // ==================================================================
    // Provider Change Handler
    // ==================================================================

    handleProviderChange(providerName: string, event: ProviderChangeEvent): void {
      if (!active) return;

      // Only handle node events (not edge events)
      if (event.kind !== 'node') return;

      // Skip changes from the MAP provider to prevent echo loops
      if (providerName === 'map') return;

      const nodeEvent: ProviderNodeChangeEvent = event.event;

      // `ProviderNode.type` is already normalized — the native provider's
      // `nodeToProviderNode` maps the raw graph type `'context'` → `'spec'`
      // (the provider-side normalization name; all context graph nodes surface
      // as `'spec'` in `ProviderNode.type`). We bridge every such node as a
      // `context.*` event; downstream receivers route on `metadata.kind`.
      const nodeType = nodeEvent.node?.type;

      if (nodeType === 'spec') {
        const archived = nodeEvent.node?.rawData?.archived as boolean | undefined;
        const metadata = nodeEvent.node?.rawData?.metadata as
          | Record<string, unknown>
          | undefined;
        if (nodeEvent.type === 'created' && nodeEvent.node) {
          bridge.emitContextCreated({
            id: nodeEvent.nodeId,
            title: nodeEvent.node.title,
            content: nodeEvent.node.content,
            priority: nodeEvent.node.priority,
            archived,
            status: nodeEvent.node.status,
            metadata,
          });
        } else if (nodeEvent.type === 'updated' && nodeEvent.node) {
          bridge.emitContextUpdated({
            id: nodeEvent.nodeId,
            title: nodeEvent.node.title,
            content: nodeEvent.node.content,
            priority: nodeEvent.node.priority,
            archived,
            status: nodeEvent.node.status,
            metadata,
          });
        }
        // Deletes are intentionally not bridged (no UI consumer); archive is
        // communicated via context.updated with archived=true.
        return;
      }

      // Only bridge task-type nodes beyond this point
      if (nodeType && nodeType !== 'task') return;

      switch (nodeEvent.type) {
        case 'created': {
          if (nodeEvent.node) {
            bridge.emitTaskCreated({
              id: nodeEvent.nodeId,
              title: nodeEvent.node.title,
              status: nodeEvent.node.status,
              description: nodeEvent.node.content,
              assignee: nodeEvent.node.rawData?.assignee as string | undefined,
              meta: nodeEvent.node.rawData as Record<string, unknown> | undefined,
            });
          }
          break;
        }

        case 'updated': {
          const changedFields = nodeEvent.changedFields;
          const previousValues = nodeEvent.previousValues;

          // Status change
          if (changedFields?.includes('status') && previousValues?.status) {
            const previous = String(previousValues.status);
            const current = nodeEvent.node?.status ?? 'open';
            bridge.emitTaskStatus(nodeEvent.nodeId, previous, current);
          }

          // Assignment change
          if (changedFields?.includes('assignee') && nodeEvent.node?.rawData?.assignee) {
            bridge.emitTaskAssigned(
              nodeEvent.nodeId,
              String(nodeEvent.node.rawData.assignee),
            );
          }

          // If no specific fields reported, emit a generic status event
          // based on current node state (best effort)
          if (!changedFields && nodeEvent.node?.status) {
            const previous = previousValues?.status
              ? String(previousValues.status)
              : 'open';
            bridge.emitTaskStatus(nodeEvent.nodeId, previous, nodeEvent.node.status);
          }

          break;
        }

        case 'deleted': {
          // MAP has no delete — emit as status change to 'failed'
          bridge.emitTaskStatus(nodeEvent.nodeId, 'open', 'failed');
          break;
        }
      }
    },

    stop(): void {
      active = false;
    },

    get active(): boolean {
      return active;
    },
  };

  return bridge;
}
