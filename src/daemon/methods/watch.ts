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
import type { LocationResolver, LocationState } from '../location-state.js';
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
 * Subscription filter (coarse). Omitted → the subscriber receives all events.
 * `types` matches the provider node type carried on the event (tasks are emitted
 * as `'issue'`, contexts as `'spec'`); `statuses` matches `node.status`;
 * `locations` matches the originating worktree's location hash (multi-location).
 */
export interface WatchFilter {
  types?: string[];
  statuses?: string[];
  locations?: string[];
}

/**
 * Does an event satisfy a subscriber's filter? `locations` applies to every
 * event type (deletes carry a location). `types`/`statuses` need the node, which
 * deletes lack — so deletes bypass those two checks (a delete only prompts a
 * re-poll, so over-delivery on type/status is harmless), but are still scoped to
 * the requested locations.
 */
function eventMatchesFilter(event: ProviderNodeChangeEvent, filter: unknown): boolean {
  const f = (filter ?? {}) as WatchFilter;
  if (f.locations && f.locations.length > 0) {
    if (!event.location || !f.locations.includes(event.location)) {
      return false;
    }
  }
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

/**
 * Build a created/updated change event for a node, tagged with its location.
 */
function nodeEvent(
  type: 'created' | 'updated',
  node: StoredNode,
  location: string,
): ProviderNodeChangeEvent {
  return {
    type,
    nodeId: node.id,
    uri: `global://${node.id}`,
    location,
    node: {
      id: node.id,
      uri: `global://${node.id}`,
      type: providerType(node.type),
      title: node.title,
      content: node.content,
      status: node.status,
      priority: node.priority,
      rawData: providerRawData(node),
      fetchedAt: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Register watch subscription method handlers on an IPC server
 */
export function registerWatchMethods(options: WatchMethodsOptions): void {
  const { server, locationResolver, eventManager, onWatcherError } = options;

  // Per-location diff state. Multi-location daemons watch every worktree, so each
  // location gets its own hash cache and debounce timer; `watched` tracks which
  // locations have their file watcher hooked (each is hooked at most once).
  const caches = new Map<string, Map<string, string>>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const watched = new Set<string>();
  const WATCH_DEBOUNCE_MS = 150;

  function cacheFor(hash: string): Map<string, string> {
    let cache = caches.get(hash);
    if (!cache) {
      cache = new Map();
      caches.set(hash, cache);
    }
    return cache;
  }

  /**
   * Seed a location's hash cache with its current graph state.
   */
  async function seedCache(state: LocationState): Promise<void> {
    try {
      const nodes = await state.store.query.nodes({});
      const cache = cacheFor(state.hash);
      cache.clear();
      for (const node of nodes) {
        cache.set(node.id, nodeHash(node as StoredNode));
      }
    } catch {
      // If we can't seed, the first diff emits everything as 'created'.
    }
  }

  /**
   * Deliver a watch event only to connections whose subscription filter matches
   * it. When an event manager is wired (P3 M2), the event is first stamped with
   * `seq` + `epoch` and buffered for replay, and the stamped fields ride along on
   * the broadcast payload so subscribers can track a resume cursor.
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
   * Diff one location's current graph state against its cached hashes and
   * broadcast events, tagging each with the originating location.
   *
   * Runs on every graph change once a location is watched — even with zero
   * subscribers — so the event manager keeps a replayable history for subscribers
   * that reconnect and backfill via `events.since` (P3 M2). Delivery itself no-ops
   * when nobody matches (`broadcastToSubscribers` iterates an empty set).
   */
  async function diffAndBroadcast(hash: string): Promise<void> {
    if (!watched.has(hash)) return;

    try {
      const state = locationResolver.resolve(hash);
      const nodes = await state.store.query.nodes({});
      const cache = cacheFor(hash);
      const currentIds = new Set<string>();

      for (const node of nodes) {
        const storedNode = node as StoredNode;
        currentIds.add(storedNode.id);
        const hashValue = nodeHash(storedNode);
        const prevHash = cache.get(storedNode.id);

        if (!prevHash) {
          emit(nodeEvent('created', storedNode, hash));
        } else if (hashValue !== prevHash) {
          emit(nodeEvent('updated', storedNode, hash));
        }

        cache.set(storedNode.id, hashValue);
      }

      // Detect deletes.
      for (const [id] of cache) {
        if (!currentIds.has(id)) {
          emit({
            type: 'deleted',
            nodeId: id,
            uri: `global://${id}`,
            location: hash,
            timestamp: new Date().toISOString(),
          });
          cache.delete(id);
        }
      }
    } catch {
      // Resilient: don't crash on diff errors. Surface the otherwise-silent
      // failure to the daemon's health counters (F10).
      onWatcherError?.();
    }
  }

  /**
   * Schedule a debounced diff for one location. Each location debounces
   * independently so a change in one worktree doesn't reset another's timer.
   */
  function scheduleDiff(hash: string): void {
    const existing = debounceTimers.get(hash);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      hash,
      setTimeout(() => {
        debounceTimers.delete(hash);
        void diffAndBroadcast(hash);
      }, WATCH_DEBOUNCE_MS),
    );
  }

  /**
   * Begin watching a location: seed its cache and hook its file watcher.
   * Idempotent — a location is hooked at most once.
   */
  async function watchLocation(state: LocationState): Promise<void> {
    if (watched.has(state.hash)) return;
    watched.add(state.hash);
    await seedCache(state);
    try {
      state.watcher.onchange((event) => {
        if (event.category === 'graph') {
          scheduleDiff(state.hash);
        }
      });
    } catch {
      // Watcher unavailable for this location — leave it marked watched (no
      // retry) so we don't repeatedly re-seed; its changes just won't surface.
    }
  }

  /** Drop a removed location's per-location state. */
  function unwatchLocation(hash: string): void {
    watched.delete(hash);
    caches.delete(hash);
    const timer = debounceTimers.get(hash);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(hash);
    }
  }

  // Watch worktrees added at runtime, and clean up removed ones (multi-location).
  locationResolver.onLocationAdded?.((state) => {
    void watchLocation(state);
  });
  locationResolver.onLocationRemoved?.((hash) => {
    unwatchLocation(hash);
  });

  // watch.subscribe - Subscribe to graph change notifications
  server.handle<{ location?: string; filter?: WatchFilter }, { subscribed: boolean }>(
    'watch.subscribe',
    async (params, ctx) => {
      const { filter } = params || {};
      // Bind this connection's filter so broadcasts are delivered selectively.
      ctx.subscribe(filter ?? {});

      // Watch every currently-managed location (covers single-location, all
      // startup worktrees, and any added before this subscribe). Idempotent.
      for (const info of locationResolver.list()) {
        try {
          await watchLocation(locationResolver.resolve(info.hash));
        } catch {
          // Location vanished between list() and resolve() — skip it.
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
