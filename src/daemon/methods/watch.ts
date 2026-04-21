/**
 * Watch Method Handlers
 *
 * JSON-RPC method handlers for graph change subscriptions.
 * Allows clients (e.g., project-level global providers) to subscribe
 * to real-time change notifications when the graph is modified.
 *
 * Uses hash-based diffing (same pattern as native provider) to detect
 * node changes in graph.jsonl and broadcasts events to subscribers.
 */

import type { IPCServer } from '../ipc.js';
import type { LocationResolver } from '../location-state.js';
import type { ProviderNodeChangeEvent } from '../../providers/traits/Watchable.js';
import type { StoredNode } from '../../schema/storage.js';

// ============================================================================
// Types
// ============================================================================

export interface WatchMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a hash string for a node's substantive fields.
 * Changes to these fields trigger watch events. `metadata` is included
 * so consumers bridging context nodes off `metadata.kind` (e.g. OpenHive's
 * spec classifier) see updates when the marker appears or changes.
 */
function nodeHash(node: StoredNode): string {
  return JSON.stringify([
    node.title,
    node.content,
    node.status,
    node.priority,
    node.tags,
    node.archived,
    node.assignee,
    node.metadata,
  ]);
}

/**
 * Normalize a StoredNode's graph type to the provider-normalized type
 * used in `ProviderNode.type`. Mirrors `mapNodeType` in the native
 * provider so watch-event consumers see the same shape they would from
 * `ProviderNode` — notably `'context'` → `'spec'`.
 */
function providerType(
  raw: StoredNode['type'],
): 'spec' | 'issue' | 'task' | 'feedback' | 'external' {
  switch (raw) {
    case 'context':
      return 'spec';
    case 'task':
      return 'issue';
    case 'feedback':
      return 'feedback';
    case 'external':
      return 'external';
    default:
      return 'external';
  }
}

/**
 * Build the `rawData` envelope that the native provider's
 * `nodeToProviderNode` produces, carrying metadata + assignee + archived
 * through to watch-event consumers (e.g. the MAP event bridge forwarding
 * `metadata.kind` for downstream spec classification).
 */
function providerRawData(node: StoredNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    archived: node.archived,
    metadata: node.metadata,
    tags: node.tags,
    parent_id: node.parent_id,
  };
  if ('assignee' in node && node.assignee !== undefined) {
    out.assignee = node.assignee;
  }
  return out;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register watch subscription method handlers on an IPC server
 */
export function registerWatchMethods(options: WatchMethodsOptions): void {
  const { server, locationResolver } = options;

  let subscriberCount = 0;
  let watchActive = false;
  const cachedHashes = new Map<string, string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const WATCH_DEBOUNCE_MS = 150;

  /**
   * Seed the hash cache with current graph state
   */
  async function seedCache(location?: string): Promise<void> {
    try {
      const state = locationResolver.resolve(location);
      const nodes = await state.store.query.nodes({});
      cachedHashes.clear();
      for (const node of nodes) {
        cachedHashes.set(node.id, nodeHash(node as StoredNode));
      }
    } catch {
      // If we can't seed, first diff will emit everything as 'created'
    }
  }

  /**
   * Diff current graph state against cached hashes and broadcast events
   */
  async function diffAndBroadcast(location?: string): Promise<void> {
    if (subscriberCount <= 0) return;

    try {
      const state = locationResolver.resolve(location);
      const nodes = await state.store.query.nodes({});
      const currentIds = new Set<string>();

      for (const node of nodes) {
        const storedNode = node as StoredNode;
        currentIds.add(storedNode.id);
        const hash = nodeHash(storedNode);
        const prevHash = cachedHashes.get(storedNode.id);

        if (!prevHash) {
          // New node
          const event: ProviderNodeChangeEvent = {
            type: 'created',
            nodeId: storedNode.id,
            uri: `global://${storedNode.id}`,
            node: {
              id: storedNode.id,
              uri: `global://${storedNode.id}`,
              type: providerType(storedNode.type),
              title: storedNode.title,
              content: storedNode.content,
              status: storedNode.status,
              priority: storedNode.priority,
              rawData: providerRawData(storedNode),
              fetchedAt: new Date().toISOString(),
            },
            timestamp: new Date().toISOString(),
          };
          server.broadcastNotification('watch.event', event);
        } else if (hash !== prevHash) {
          // Updated node
          const event: ProviderNodeChangeEvent = {
            type: 'updated',
            nodeId: storedNode.id,
            uri: `global://${storedNode.id}`,
            node: {
              id: storedNode.id,
              uri: `global://${storedNode.id}`,
              type: providerType(storedNode.type),
              title: storedNode.title,
              content: storedNode.content,
              status: storedNode.status,
              priority: storedNode.priority,
              rawData: providerRawData(storedNode),
              fetchedAt: new Date().toISOString(),
            },
            timestamp: new Date().toISOString(),
          };
          server.broadcastNotification('watch.event', event);
        }

        cachedHashes.set(storedNode.id, hash);
      }

      // Detect deletes
      for (const [id] of cachedHashes) {
        if (!currentIds.has(id)) {
          const event: ProviderNodeChangeEvent = {
            type: 'deleted',
            nodeId: id,
            uri: `global://${id}`,
            timestamp: new Date().toISOString(),
          };
          server.broadcastNotification('watch.event', event);
          cachedHashes.delete(id);
        }
      }
    } catch {
      // Resilient: don't crash on diff errors
    }
  }

  /**
   * Schedule a debounced diff-and-broadcast
   */
  function scheduleDiff(location?: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void diffAndBroadcast(location);
    }, WATCH_DEBOUNCE_MS);
  }

  // watch.subscribe - Subscribe to graph change notifications
  server.handle<{ location?: string }, { subscribed: boolean }>(
    'watch.subscribe',
    async (params) => {
      const { location } = params || {};
      subscriberCount++;

      if (!watchActive) {
        watchActive = true;
        await seedCache(location);

        // Hook into the file watcher for this location
        try {
          const state = locationResolver.resolve(location);
          state.watcher.onchange((event) => {
            if (event.category === 'graph') {
              scheduleDiff(location);
            }
          });
        } catch {
          // Watcher may not be available
        }
      }

      return { subscribed: true };
    },
  );

  // watch.unsubscribe - Unsubscribe from graph change notifications
  server.handle<{ location?: string }, { subscribed: boolean }>(
    'watch.unsubscribe',
    async () => {
      subscriberCount = Math.max(0, subscriberCount - 1);
      return { subscribed: false };
    },
  );
}
