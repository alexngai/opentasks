/**
 * MAP Client Factory
 *
 * Creates a MAPTaskClient from a MAP server connection.
 * Used by the daemon to wire the MAP provider and event bridge.
 *
 * The factory dynamically imports @multi-agent-protocol/sdk so that
 * the dependency is optional — if the SDK is not installed, the factory
 * returns null and the MAP provider is gracefully skipped.
 */

import type { MAPTaskClient, MAPTaskEvent } from './map.js';
import type { MAPEventSender } from './map-event-bridge.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a MAP client
 */
export interface MAPClientOptions {
  /** MAP server WebSocket URL (e.g., 'ws://localhost:8080') */
  server: string;

  /** Agent name for the connection */
  agentName?: string;

  /** MAP scope to join */
  scope?: string;

  /** System identifier */
  systemId?: string;

  /** Connection timeout in ms */
  timeout?: number;
}

/**
 * Result of creating a MAP client.
 * Includes the client for the MAP provider and a send function for the event bridge.
 */
export interface MAPClientResult {
  /** MAPTaskClient for use with createMAPProvider */
  client: MAPTaskClient;

  /** Send function for use with createMAPEventBridge */
  send: MAPEventSender;

  /** Disconnect the MAP connection */
  disconnect: () => Promise<void>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a MAP client by connecting to a MAP server.
 *
 * Dynamically imports the MAP SDK. Returns null if:
 * - The SDK is not installed
 * - The connection fails
 *
 * The returned client satisfies the MAPTaskClient interface and can be
 * passed directly to createMAPProvider(). The send function can be passed
 * to createMAPEventBridge().
 *
 * @param options - Connection options
 * @returns MAPClientResult or null on failure
 */
export async function createMAPClient(
  options: MAPClientOptions,
): Promise<MAPClientResult | null> {
  const {
    server,
    agentName = 'opentasks-daemon',
    scope = '',
    systemId = 'default',
  } = options;

  try {
    // Dynamic import — SDK is optional
    const sdk = await import('@multi-agent-protocol/sdk');
    const { AgentConnection } = sdk;

    const connection = await AgentConnection.connect(server, {
      name: agentName,
      role: 'daemon',
      scopes: scope ? [scope] : [],
      capabilities: {
        tasks: {
          canCreate: true,
          canAssign: true,
          canUpdate: true,
          canList: true,
        },
      },
      metadata: {
        systemId,
        type: 'opentasks-daemon',
      },
      reconnection: {
        enabled: true,
        maxRetries: 10,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      },
    });

    // Task event listeners for the Watchable trait
    const eventCallbacks: Array<(event: MAPTaskEvent) => void> = [];

    // Listen for incoming messages that contain task events
    connection.onMessage((message) => {
      const payload = (message.payload ?? {}) as { type?: string; [key: string]: unknown };
      if (payload.type?.startsWith('task.')) {
        const event: MAPTaskEvent = {
          type: payload.type as MAPTaskEvent['type'],
          data: payload as Record<string, unknown>,
        };
        for (const cb of eventCallbacks) {
          try {
            cb(event);
          } catch {
            // Don't let callback errors break the loop
          }
        }
      }
    });

    const client: MAPTaskClient = {
      async createTask(params) {
        return connection.createTask(params);
      },

      async assignTask(taskId: string, agentId: string) {
        return connection.assignTask(taskId, agentId);
      },

      async updateTask(params) {
        return connection.updateTask(params);
      },

      async listTasks(params) {
        return connection.listTasks(params ?? {});
      },

      onTaskEvent(callback: (event: MAPTaskEvent) => void) {
        eventCallbacks.push(callback);
        return () => {
          const idx = eventCallbacks.indexOf(callback);
          if (idx >= 0) eventCallbacks.splice(idx, 1);
        };
      },
    };

    const send: MAPEventSender = (eventType: string, data: Record<string, unknown>) => {
      // Send as a message to the scope (observers see message_sent events)
      // The data includes the event type for receivers to dispatch on
      if (!scope) return; // Cannot send without a target scope
      connection.send({ scope }, { type: eventType, ...data }).catch(() => {
        // Best effort — don't block on send failures
      });
    };

    const disconnect = async () => {
      try {
        await connection.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    };

    return { client, send, disconnect };
  } catch {
    // SDK not installed or connection failed — graceful degradation
    return null;
  }
}
