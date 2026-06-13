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
import type { EventManager } from '../events.js';

// ============================================================================
// Types
// ============================================================================

export interface WatchMethodsOptions {
  /** IPC server to register handlers on */
  server: IPCServer;

  /** Location resolver for routing to correct store */
  locationResolver: LocationResolver;

  /**
   * Optional event manager. When present, each broadcast `watch.event` is
   * stamped with a monotonic `seq` + per-process `epoch` and buffered for
   * replay (P3 M2), so a reconnecting subscriber can backfill via `events.since`.
   * Without it, events broadcast unstamped (the M1 fire-and-forget behavior).
   */
  eventManager?: EventManager;

  /**
   * Optional callback invoked when a diff cycle throws and is swallowed, so the
   * daemon can surface otherwise-silent watcher failures via `health` (F10).
   */
  onWatcherError?: () => void;
}

/**
 * Subscription filter (M1: coarse). Omitted → the subscriber receives all
 * events. `types` matches the provider node type carried on the event (tasks
 * are emitted as `'issue'`, contexts as `'spec'`); `statuses` matches
 * `node.status`.
 */
export interface WatchFilter {
  types?: string[];
  statuses?: string[];
}

/**
 * Does an event satisfy a subscriber's filter? Delete events carry no node, so
 * they can't be filtered by type/status — they are always delivered (a delete
 * only prompts a re-poll, so over-delivery is harmless).
 */
function eventMatchesFilter(event: ProviderNodeChangeEvent, filter: unknown): boolean {
  const f = (filter ?? {}) as WatchFilter;
  if (event.type === 'deleted') return true;
  const node = event.node;
  if (f.types && f.types.length > 0 && (!node || !f.types.includes(node.type))) {
    return false;
  }
  if (
    f.statuses &&
    f.statuses.length > 0 &&
    (!node || !node.status || !f.statuses.includes(node.status))
  ) {
    return false;
  }
  return true;
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
  const { server, locationResolver, eventManager, onWatcherError } = options;

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
   * Deliver a watch event only to connections whose subscription filter
   * matches it. When an event manager is wired (P3 M2), the event is first
   * stamped with `seq` + `epoch` and buffered for replay, and the stamped
   * fields ride along on the broadcast payload so subscribers can track a
   * resume cursor. Filtering reads the same `type`/`node` fields either way.
   */
  function emit(event: ProviderNodeChangeEvent): void {
    const payload = eventManager
      ? (() => {
          const stamped = eventManager.emit(event);
          return { ...event, seq: stamped.seq, epoch: stamped.epoch };
        })()
      : event;
    server.broadcastToSubscribers('watch.event', payload, (filter) =>
      eventMatchesFilter(event, filter),
    );
  }

  /**
   * Diff current graph state against cached hashes and broadcast events.
   *
   * Runs on every graph change once watching is active — even with zero current
   * subscribers — so the event manager keeps a replayable history for subscribers
   * that reconnect and backfill via `events.since` (P3 M2). Delivery itself no-ops
   * when nobody is subscribed (`broadcastToSubscribers` iterates an empty set), so
   * a 0-subscriber daemon still buffers but sends nothing. The watcher is only
   * installed after the first `watch.subscribe`, so this never runs pre-activation.
   */
  async function diffAndBroadcast(location?: string): Promise<void> {
    if (!watchActive) return;

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
          emit(event);
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
          emit(event);
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
          emit(event);
          cachedHashes.delete(id);
        }
      }
    } catch {
      // Resilient: don't crash on diff errors. Surface the otherwise-silent
      // failure to the daemon's health counters (F10).
      onWatcherError?.();
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
  server.handle<{ location?: string; filter?: WatchFilter }, { subscribed: boolean }>(
    'watch.subscribe',
    async (params, ctx) => {
      const { location, filter } = params || {};
      // Bind this connection's filter so broadcasts are delivered selectively.
      ctx.subscribe(filter ?? {});

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
    async (_params, ctx) => {
      ctx.unsubscribe();
      return { subscribed: false };
    },
  );
}
