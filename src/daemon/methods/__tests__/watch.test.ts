/**
 * Tests for Watch Method Handlers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerWatchMethods } from '../watch.js';
import type { IPCServer } from '../../ipc.js';
import type { LocationResolver, LocationState } from '../../location-state.js';
import type { FileChangeEvent, ChangeHandler } from '../../watcher.js';
import type { GraphStore } from '../../../graph/store.js';

// ============================================================================
// Mocks
// ============================================================================

function createMockServer() {
  const handlers = new Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>();

  // Model subscription state as a stack of active filters. ctx.subscribe pushes,
  // ctx.unsubscribe pops — mirroring the real per-socket subscription map across
  // multiple subscribers. broadcastToSubscribers delivers once if any remaining
  // subscriber's filter matches, routed through the broadcastNotification spy so
  // existing assertions keep working.
  const filters: unknown[] = [];
  const ctx = {
    subscribe: (filter: unknown) => {
      filters.push(filter);
    },
    unsubscribe: () => {
      filters.pop();
    },
  };

  const broadcastNotification = vi.fn();

  return {
    handle: vi.fn(
      (method: string, handler: (params: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    ),
    broadcastNotification,
    broadcastToSubscribers: vi.fn(
      (method: string, params: unknown, matches: (filter: unknown) => boolean) => {
        if (filters.some((f) => matches(f))) {
          broadcastNotification(method, params);
        }
      },
    ),
    call: async (method: string, params?: unknown) => {
      const handler = handlers.get(method);
      if (!handler) {
        throw new Error(`Method not found: ${method}`);
      }
      return handler(params, ctx);
    },
    handlers,
  } as unknown as IPCServer & {
    call: (method: string, params?: unknown) => Promise<unknown>;
    handlers: Map<string, (params: unknown, ctx: unknown) => Promise<unknown>>;
    broadcastNotification: ReturnType<typeof vi.fn>;
    broadcastToSubscribers: ReturnType<typeof vi.fn>;
  };
}

function createMockStore(initialNodes: Array<Record<string, unknown>> = []) {
  return {
    query: {
      nodes: vi.fn().mockResolvedValue(initialNodes),
    },
  } as unknown as GraphStore;
}

function createMockWatcher() {
  const changeHandlers: ChangeHandler[] = [];

  return {
    onchange: vi.fn((handler: ChangeHandler) => {
      changeHandlers.push(handler);
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
    paused: false,
    // Test helper: simulate a file change event
    _emit(event: FileChangeEvent) {
      for (const handler of changeHandlers) {
        handler(event);
      }
    },
  };
}

function createMockLocationResolver(
  store: GraphStore,
  watcher: ReturnType<typeof createMockWatcher>,
): LocationResolver {
  const state = {
    hash: 'primary',
    opentasksPath: '/tmp/.opentasks',
    store,
    flushManager: {} as any,
    watcher: watcher as any,
    primary: true,
    healthy: true,
  } as LocationState;

  return {
    resolve: () => state,
    getDefault: () => state,
    list: () => [
      { hash: 'primary', opentasksPath: '/tmp/.opentasks', primary: true, healthy: true },
    ],
    has: () => true,
    add: () => {},
    remove: async () => {},
  };
}

// ============================================================================
// Helpers
// ============================================================================

function makeNode(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'i-1',
    uuid: 'uuid-1',
    type: 'task',
    title: 'Test node',
    content: 'Some content',
    status: 'open',
    priority: 2,
    tags: ['tag1'],
    archived: false,
    assignee: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('registerWatchMethods', () => {
  let server: ReturnType<typeof createMockServer>;
  let store: GraphStore;
  let watcher: ReturnType<typeof createMockWatcher>;
  let onWatcherError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    server = createMockServer();
    store = createMockStore();
    watcher = createMockWatcher();
    onWatcherError = vi.fn();

    const locationResolver = createMockLocationResolver(store, watcher);
    registerWatchMethods({ server, locationResolver, onWatcherError });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  describe('registration', () => {
    it('should register watch.subscribe handler', () => {
      expect(server.handlers.has('watch.subscribe')).toBe(true);
    });

    it('should register watch.unsubscribe handler', () => {
      expect(server.handlers.has('watch.unsubscribe')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Subscribe
  // --------------------------------------------------------------------------

  describe('watch.subscribe', () => {
    it('should return { subscribed: true }', async () => {
      const result = await server.call('watch.subscribe', {});
      expect(result).toEqual({ subscribed: true });
    });

    it('should seed cache from store on first subscribe', async () => {
      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      await server.call('watch.subscribe', {});

      expect(store.query.nodes).toHaveBeenCalledWith({});
    });

    it('should register a watcher onchange handler', async () => {
      await server.call('watch.subscribe', {});
      expect(watcher.onchange).toHaveBeenCalledOnce();
    });

    it('should only seed cache and register watcher once for multiple subscribes', async () => {
      await server.call('watch.subscribe', {});
      await server.call('watch.subscribe', {});

      // seedCache queries nodes once, watcher.onchange registered once
      expect(store.query.nodes).toHaveBeenCalledTimes(1);
      expect(watcher.onchange).toHaveBeenCalledTimes(1);
    });

    it('should handle undefined params gracefully', async () => {
      const result = await server.call('watch.subscribe', undefined);
      expect(result).toEqual({ subscribed: true });
    });
  });

  // --------------------------------------------------------------------------
  // Unsubscribe
  // --------------------------------------------------------------------------

  describe('watch.unsubscribe', () => {
    it('should return { subscribed: false }', async () => {
      const result = await server.call('watch.unsubscribe', {});
      expect(result).toEqual({ subscribed: false });
    });

    it('should not let subscriber count go below zero', async () => {
      // Unsubscribe multiple times without subscribing
      await server.call('watch.unsubscribe', {});
      await server.call('watch.unsubscribe', {});
      await server.call('watch.unsubscribe', {});

      // Now subscribe — seed cache with empty store
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      // A new node appears in the store
      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      // Trigger a diff via watcher
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      // Should broadcast because subscriber count is 1 (not negative from over-unsubscribing)
      expect(server.broadcastNotification).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Created events
  // --------------------------------------------------------------------------

  describe('created events', () => {
    it('should broadcast created event for new nodes', async () => {
      // Subscribe with empty initial store
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      // Now a new node appears
      const node = makeNode({ id: 'i-new', type: 'task', title: 'New task' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      // Trigger diff via watcher
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'created',
          nodeId: 'i-new',
          uri: 'global://i-new',
          node: expect.objectContaining({
            id: 'i-new',
            title: 'New task',
            type: 'issue', // 'task' maps to 'issue'
          }),
        }),
      );
    });

    it('should map task type to issue in created events', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-1', type: 'task' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      const call = (server.broadcastNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].node.type).toBe('issue');
    });

    it('should normalize context graph type to spec in created events', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 's-1', type: 'context' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      const call = (server.broadcastNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      // `context` graph nodes normalize to provider type `spec`, matching
      // the native provider's `nodeToProviderNode` mapping so watch-event
      // consumers share one shape with ProviderNode-emitting paths.
      expect(call[1].node.type).toBe('spec');
    });

    it('should include metadata + archived in rawData for downstream classification', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({
        id: 's-2',
        type: 'context',
        metadata: { kind: 'spec', tags: ['auth'] },
        archived: false,
      });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      const call = (server.broadcastNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].node.rawData).toMatchObject({
        metadata: { kind: 'spec', tags: ['auth'] },
        archived: false,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Updated events
  // --------------------------------------------------------------------------

  describe('updated events', () => {
    it('should broadcast updated event when node fields change', async () => {
      const node = makeNode({ id: 'i-1', title: 'Original title' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      // Now the title changes
      const updatedNode = makeNode({ id: 'i-1', title: 'Updated title' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([updatedNode]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'updated',
          nodeId: 'i-1',
          uri: 'global://i-1',
          node: expect.objectContaining({
            id: 'i-1',
            title: 'Updated title',
          }),
        }),
      );
    });

    it('should detect status changes', async () => {
      const node = makeNode({ id: 'i-1', status: 'open' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      const updatedNode = makeNode({ id: 'i-1', status: 'closed' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([updatedNode]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'updated',
          nodeId: 'i-1',
        }),
      );
    });

    it('should detect priority changes', async () => {
      const node = makeNode({ id: 'i-1', priority: 2 });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      const updatedNode = makeNode({ id: 'i-1', priority: 0 });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([updatedNode]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'updated',
          nodeId: 'i-1',
        }),
      );
    });

    it('should not broadcast when node has not changed', async () => {
      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      // Same node, no changes
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('should not detect changes for non-hashed fields like updated_at', async () => {
      const node = makeNode({ id: 'i-1', updated_at: '2025-01-01T00:00:00Z' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      // Only updated_at changed, which is not in the hash
      const sameNode = makeNode({ id: 'i-1', updated_at: '2025-06-01T00:00:00Z' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([sameNode]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Deleted events
  // --------------------------------------------------------------------------

  describe('deleted events', () => {
    it('should broadcast deleted event when node disappears from store', async () => {
      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      // Node disappears
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'deleted',
          nodeId: 'i-1',
          uri: 'global://i-1',
        }),
      );
    });

    it('should not include node field in deleted events', async () => {
      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});

      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      const call = (server.broadcastNotification as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].node).toBeUndefined();
    });

    it('should handle simultaneous create, update, and delete', async () => {
      const nodeA = makeNode({ id: 'i-a', title: 'Node A' });
      const nodeB = makeNode({ id: 'i-b', title: 'Node B' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([nodeA, nodeB]);
      await server.call('watch.subscribe', {});

      // nodeA deleted, nodeB updated, nodeC created
      const updatedB = makeNode({ id: 'i-b', title: 'Updated B' });
      const nodeC = makeNode({ id: 'i-c', title: 'Node C' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([updatedB, nodeC]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      const calls = (server.broadcastNotification as ReturnType<typeof vi.fn>).mock.calls;
      const events = calls.map((c) => ({ type: c[1].type, nodeId: c[1].nodeId }));

      expect(events).toContainEqual({ type: 'updated', nodeId: 'i-b' });
      expect(events).toContainEqual({ type: 'created', nodeId: 'i-c' });
      expect(events).toContainEqual({ type: 'deleted', nodeId: 'i-a' });
      expect(calls).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // Debouncing
  // --------------------------------------------------------------------------

  describe('debouncing', () => {
    it('should debounce multiple rapid changes into one diff', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      // Fire multiple change events rapidly
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });

      await vi.advanceTimersByTimeAsync(150);

      // Should only broadcast once despite 3 rapid events
      expect(server.broadcastNotification).toHaveBeenCalledTimes(1);
    });

    it('should not fire diff before debounce interval elapses', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });

      // Advance only 100ms (less than 150ms debounce)
      await vi.advanceTimersByTimeAsync(100);
      expect(server.broadcastNotification).not.toHaveBeenCalled();

      // Advance the remaining 50ms
      await vi.advanceTimersByTimeAsync(50);
      expect(server.broadcastNotification).toHaveBeenCalledTimes(1);
    });

    it('should reset debounce timer on each new event', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      // First event
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(100);
      expect(server.broadcastNotification).not.toHaveBeenCalled();

      // Second event resets the timer
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(100);
      expect(server.broadcastNotification).not.toHaveBeenCalled();

      // Now 150ms after the LAST event
      await vi.advanceTimersByTimeAsync(50);
      expect(server.broadcastNotification).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // No broadcast when no subscribers
  // --------------------------------------------------------------------------

  describe('no broadcast when no subscribers', () => {
    it('should not broadcast events after all subscribers unsubscribe', async () => {
      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', {});
      await server.call('watch.unsubscribe', {});

      // Now a new node appears but nobody is subscribed
      const newNode = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node, newNode]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('should resume broadcasting when a new subscriber arrives', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});
      await server.call('watch.unsubscribe', {});

      // Re-subscribe
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({
          type: 'created',
          nodeId: 'i-new',
        }),
      );
    });

    it('should still broadcast when some subscribers remain', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});
      await server.call('watch.subscribe', {});
      await server.call('watch.unsubscribe', {}); // 1 subscriber remains

      const node = makeNode({ id: 'i-new' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Watcher integration
  // --------------------------------------------------------------------------

  describe('watcher integration', () => {
    it('should trigger diff on graph category change events', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'created', nodeId: 'i-1' }),
      );
    });

    it('should not trigger diff on non-graph category change events', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      // Emit a config change event — should NOT trigger diff
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/config.json', category: 'config' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('should not trigger diff on task category change events', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-1' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/tasks/t.md', category: 'task' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Error resilience
  // --------------------------------------------------------------------------

  describe('error resilience', () => {
    it('should not crash if store.query.nodes throws during seedCache', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Store error'),
      );

      // Should not throw
      const result = await server.call('watch.subscribe', {});
      expect(result).toEqual({ subscribed: true });
    });

    it('should not crash if store.query.nodes throws during diffAndBroadcast', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      (store.query.nodes as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Store error'),
      );

      // Should not throw
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      // No broadcast since diff failed silently
      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('reports a swallowed diff error via onWatcherError (F10 health counter)', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      (store.query.nodes as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Store error'),
      );

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      // The error is swallowed for resilience but surfaced to the health counter.
      expect(onWatcherError).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Subscription filtering (M1: coarse type/status filters)
  // --------------------------------------------------------------------------

  describe('subscription filtering', () => {
    it('delivers events whose status matches a statuses filter', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', { filter: { statuses: ['open'] } });

      const node = makeNode({ id: 'i-open', status: 'open' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'created', nodeId: 'i-open' }),
      );
    });

    it('drops events whose status does not match a statuses filter', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', { filter: { statuses: ['closed'] } });

      const node = makeNode({ id: 'i-open', status: 'open' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('matches a types filter against the provider-normalized type', async () => {
      // task nodes are emitted as provider type 'issue'.
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', { filter: { types: ['issue'] } });

      const node = makeNode({ id: 'i-task', type: 'task' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'created', nodeId: 'i-task' }),
      );
    });

    it('drops events whose provider type does not match a types filter', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', { filter: { types: ['spec'] } });

      const node = makeNode({ id: 'i-task', type: 'task' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).not.toHaveBeenCalled();
    });

    it('always delivers delete events regardless of filter', async () => {
      // Seed with a node, then remove it under a filter that would exclude it.
      const node = makeNode({ id: 'i-gone', type: 'task', status: 'open' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);
      await server.call('watch.subscribe', { filter: { types: ['spec'] } });

      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'deleted', nodeId: 'i-gone' }),
      );
    });

    it('delivers all events when the filter is empty', async () => {
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await server.call('watch.subscribe', {});

      const node = makeNode({ id: 'i-any', type: 'task', status: 'blocked' });
      (store.query.nodes as ReturnType<typeof vi.fn>).mockResolvedValue([node]);

      watcher._emit({ type: 'change', path: '/tmp/.opentasks/graph.jsonl', category: 'graph' });
      await vi.advanceTimersByTimeAsync(150);

      expect(server.broadcastNotification).toHaveBeenCalledWith(
        'watch.event',
        expect.objectContaining({ type: 'created', nodeId: 'i-any' }),
      );
    });
  });
});
