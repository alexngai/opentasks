/**
 * Tests for Tools Method Handlers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createIPCServer, createIPCClient, type IPCServer, type IPCClient } from '../../ipc.js';
import { registerToolsMethods } from '../../methods/tools.js';
import { createDaemonFlushManager, type DaemonFlushManager } from '../../flush.js';
import type { GraphStore } from '../../../graph/store.js';
import type { LinkResult, QueryResult, AnnotateResult, TaskResult } from '../../../tools/types.js';
import type { LocationResolver, LocationState } from '../../location-state.js';
import type { ProviderAwareStore } from '../../../graph/provider-store.js';

describe('Tools Methods', () => {
  let tempDir: string;
  let socketPath: string;
  let server: IPCServer;
  let client: IPCClient;
  let mockStore: GraphStore;
  let flushManager: DaemonFlushManager;
  let nodeCounter: number;
  let edgeCounter: number;

  // Sample nodes for testing
  const sampleContext = {
    id: 'c-test1',
    uuid: 'uuid-1',
    type: 'context' as const,
    title: 'Test Context',
    content: 'Test content',
    priority: 2,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleTask = {
    id: 't-test1',
    uuid: 'uuid-2',
    type: 'task' as const,
    title: 'Test Task',
    status: 'open' as const,
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleFeedback = {
    id: 'f-test1',
    uuid: 'uuid-3',
    type: 'feedback' as const,
    title: 'Test Feedback',
    targetId: 'c-test1',
    feedback_type: 'comment' as const,
    resolved: false,
    dismissed: false,
    content: 'This is test feedback content',
    priority: 0,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const sampleEdge = {
    id: 'x-test1',
    uuid: 'uuid-4',
    fromId: 't-test1',
    toId: 'c-test1',
    type: 'implements' as const,
    created_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-tools-methods-test-'));
    socketPath = path.join(tempDir, 'test.sock');

    nodeCounter = 0;
    edgeCounter = 0;

    // Create mock store
    const nodes = new Map<string, any>();
    nodes.set(sampleContext.id, { ...sampleContext });
    nodes.set(sampleTask.id, { ...sampleTask });
    nodes.set(sampleFeedback.id, { ...sampleFeedback });

    const edges = new Map<string, any>();
    edges.set(sampleEdge.id, { ...sampleEdge });

    mockStore = {
      getNode: vi.fn().mockImplementation(async (id: string) => {
        return nodes.get(id) || null;
      }),
      createNode: vi.fn().mockImplementation(async (input: any) => {
        const node = {
          ...input,
          id: `f-new${++nodeCounter}`,
          uuid: `uuid-new${nodeCounter}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        nodes.set(node.id, node);
        return node;
      }),
      updateNode: vi.fn().mockImplementation(async (id: string, updates: any) => {
        const existing = nodes.get(id);
        if (!existing) throw new Error('Node not found');
        const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
        nodes.set(id, updated);
        return updated;
      }),
      createEdge: vi.fn().mockImplementation(async (input: any) => {
        const edge = {
          ...input,
          id: `x-new${++edgeCounter}`,
          uuid: `uuid-edge${edgeCounter}`,
          created_at: new Date().toISOString(),
        };
        edges.set(edge.id, edge);
        return edge;
      }),
      deleteEdge: vi.fn().mockImplementation(async (id: string) => {
        edges.delete(id);
      }),
      getEdge: vi.fn().mockImplementation(async (id: string) => {
        return edges.get(id) || null;
      }),
      query: {
        nodes: vi.fn().mockResolvedValue([sampleContext, sampleTask]),
        edges: vi.fn().mockResolvedValue([sampleEdge]),
        ready: vi.fn().mockResolvedValue([sampleTask]),
        blockers: vi.fn().mockResolvedValue([sampleContext]),
        blocking: vi.fn().mockResolvedValue([sampleTask]),
        feedback: vi.fn().mockResolvedValue([sampleFeedback]),
      },
    } as unknown as GraphStore;

    // Create flush manager
    flushManager = createDaemonFlushManager({ debounceMs: 100, maxDelayMs: 500 }, async () => {
      // No-op for tests
    });

    // Create server and register methods
    server = createIPCServer(socketPath);
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: mockStore,
      flushManager,
      watcher: {} as any,
      primary: true,
      healthy: true,
    } as LocationState;
    const locationResolver: LocationResolver = {
      resolve: () => locationState,
      getDefault: () => locationState,
      list: () => [{ hash: 'primary', opentasksPath: tempDir, primary: true, healthy: true }],
      has: () => true,
      add: () => {},
      remove: async () => {},
    };
    registerToolsMethods({ server, locationResolver });

    await server.start();

    // Create client
    client = createIPCClient(socketPath);
    await client.connect();
  });

  afterEach(async () => {
    try {
      client.disconnect();
    } catch {
      // Ignore
    }

    try {
      await server.stop();
    } catch {
      // Ignore
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('tools.link', () => {
    it('should create an edge between nodes', async () => {
      const result = await client.request<LinkResult>('tools.link', {
        fromId: 't-test1',
        toId: 'c-test1',
        type: 'implements',
      });

      expect(result.success).toBe(true);
      expect(result.edgeId).toBeDefined();
      expect(mockStore.createEdge).toHaveBeenCalled();
    });

    it('should mark both nodes dirty on success', async () => {
      await client.request<LinkResult>('tools.link', {
        fromId: 't-test1',
        toId: 'c-test1',
        type: 'implements',
      });

      const dirty = flushManager.getDirtyNodes();
      expect(dirty).toContain('t-test1');
      expect(dirty).toContain('c-test1');
    });

    it('should remove an edge when remove=true', async () => {
      const result = await client.request<LinkResult>('tools.link', {
        fromId: 't-test1',
        toId: 'c-test1',
        type: 'implements',
        remove: true,
      });

      expect(result.success).toBe(true);
    });

    it('should return error when from_id is missing', async () => {
      const result = await client.request<LinkResult>('tools.link', {
        fromId: '',
        toId: 'c-test1',
        type: 'implements',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('fromId');
    });

    it('should not mark provider URIs dirty', async () => {
      // Use a provider URI format
      await client.request<LinkResult>('tools.link', {
        fromId: 'github://owner/repo/issues/123',
        toId: 'c-test1',
        type: 'references',
      });

      const dirty = flushManager.getDirtyNodes();
      expect(dirty).not.toContain('github://owner/repo/issues/123');
      expect(dirty).toContain('c-test1');
    });
  });

  describe('tools.query', () => {
    it('should query nodes', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        nodes: { type: 'context' },
      });

      expect(result.items).toBeDefined();
      expect(mockStore.query.nodes).toHaveBeenCalled();
    });

    it('should query edges', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        edges: { fromId: 't-test1' },
      });

      expect(result.items).toBeDefined();
      expect(mockStore.query.edges).toHaveBeenCalled();
    });

    it('should query ready tasks', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        ready: {},
      });

      expect(result.items).toBeDefined();
      expect(mockStore.query.ready).toHaveBeenCalled();
    });

    it('should query blockers', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        blockers: { nodeId: 't-test1' },
      });

      expect(result.items).toBeDefined();
      expect(mockStore.query.blockers).toHaveBeenCalled();
    });

    it('should query feedback', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        feedback: { nodeId: 'c-test1' },
      });

      expect(result.items).toBeDefined();
      expect(mockStore.query.feedback).toHaveBeenCalled();
    });

    it('should return reduced output by default', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        nodes: {},
      });

      const item = result.items[0] as any;
      expect(item.id).toBeDefined();
      expect(item.type).toBeDefined();
      expect(item.title).toBeDefined();
      // Should NOT have full properties
      expect(item.uuid).toBeUndefined();
    });

    it('should return full output when verbose=true', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        nodes: {},
        verbose: true,
      });

      const item = result.items[0] as any;
      expect(item.uuid).toBeDefined();
    });

    it('should respect pagination', async () => {
      const result = await client.request<QueryResult>('tools.query', {
        nodes: {},
        limit: 1,
      });

      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(true);
    });

    it('should throw when no query type specified', async () => {
      await expect(client.request('tools.query', {})).rejects.toThrow();
    });

    it('should not mark anything dirty (read-only)', async () => {
      await client.request<QueryResult>('tools.query', {
        nodes: {},
      });

      expect(flushManager.getDirtyNodes().length).toBe(0);
    });
  });

  describe('tools.annotate', () => {
    it('should create feedback', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        create: { content: 'New feedback content' },
      });

      expect(result.success).toBe(true);
      expect(result.feedbackId).toBeDefined();
      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'feedback',
          content: 'New feedback content',
          target_id: 'c-test1',
        }),
      );
    });

    it('should mark target and feedback nodes dirty', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        create: { content: 'New feedback' },
      });

      const dirty = flushManager.getDirtyNodes();
      expect(dirty).toContain('c-test1');
      expect(dirty).toContain(result.feedbackId);
    });

    it('should resolve feedback', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        resolve: 'f-test1',
      });

      expect(result.success).toBe(true);
      expect(result.feedbackId).toBe('f-test1');
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-test1', { resolved: true });
    });

    it('should dismiss feedback', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        dismiss: 'f-test1',
      });

      expect(result.success).toBe(true);
      expect(mockStore.updateNode).toHaveBeenCalledWith('f-test1', { dismissed: true });
    });

    it('should return error when target not found', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-nonexistent',
        create: { content: 'Test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when no operation specified', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No operation specified');
    });

    it('should create edge when fromId provided', async () => {
      await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        fromId: 't-test1',
        create: { content: 'Feedback from task' },
      });

      expect(mockStore.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: 't-test1',
          type: 'discovered-from',
        }),
      );
    });

    it('should mark fromId dirty when provided', async () => {
      await client.request<AnnotateResult>('tools.annotate', {
        targetId: 'c-test1',
        fromId: 't-test1',
        create: { content: 'Feedback from task' },
      });

      const dirty = flushManager.getDirtyNodes();
      expect(dirty).toContain('t-test1');
    });
  });

  describe('error handling', () => {
    it('should return error for tools.link with missing params', async () => {
      const result = await client.request<LinkResult>('tools.link', null as any);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for tools.annotate with missing params', async () => {
      const result = await client.request<AnnotateResult>('tools.annotate', null as any);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should throw for tools.query with missing params', async () => {
      await expect(client.request('tools.query', null as any)).rejects.toThrow();
    });
  });
});

// =============================================================================
// tools.task tests — separate describe with providerStore on location state
// =============================================================================

describe('Tools Methods - tools.task', () => {
  let tempDir: string;
  let socketPath: string;
  let server: IPCServer;
  let client: IPCClient;
  let mockStore: GraphStore;
  let mockProviderStore: ProviderAwareStore;
  let flushManager: DaemonFlushManager;
  let flushedBatches: string[][];

  const sampleNode = {
    id: 'x-task1',
    uuid: 'uuid-task-1',
    type: 'external' as const,
    title: 'Task One',
    status: 'in_progress',
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-tools-task-test-'));
    socketPath = path.join(tempDir, 'test.sock');

    mockStore = {
      getNode: vi.fn(),
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      createEdge: vi.fn(),
      deleteEdge: vi.fn(),
      getEdge: vi.fn(),
      query: {
        nodes: vi.fn().mockResolvedValue([]),
        edges: vi.fn().mockResolvedValue([]),
        ready: vi.fn().mockResolvedValue([]),
        blockers: vi.fn().mockResolvedValue([]),
        blocking: vi.fn().mockResolvedValue([]),
        feedback: vi.fn().mockResolvedValue([]),
      },
    } as unknown as GraphStore;

    mockProviderStore = {
      ...mockStore,
      taskTransition: vi.fn().mockResolvedValue({
        node: sampleNode,
        provider: 'beads',
        action: 'start',
      }),
      taskReady: vi.fn().mockResolvedValue([sampleNode]),
      taskAssign: vi.fn().mockResolvedValue(sampleNode),
      taskValidActions: vi.fn().mockResolvedValue(['start', 'complete', 'close']),
      taskClaim: vi.fn().mockResolvedValue({
        success: true,
        claim: {
          nodeId: 'c-claim1',
          agentId: 'a',
          fence: 1,
          claimedAt: '2024-01-01T00:00:00Z',
          lockUntil: '2024-01-01T00:30:00Z',
          isValid: true,
          isExpired: false,
          remainingMs: 1_800_000,
        },
      }),
    } as unknown as ProviderAwareStore;

    flushedBatches = [];
    flushManager = createDaemonFlushManager(
      { debounceMs: 100, maxDelayMs: 500 },
      async (ids) => {
        flushedBatches.push(ids);
      },
    );

    server = createIPCServer(socketPath);
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: mockStore,
      providerStore: mockProviderStore,
      flushManager,
      watcher: {} as any,
      primary: true,
      healthy: true,
    } as LocationState;
    const locationResolver: LocationResolver = {
      resolve: () => locationState,
      getDefault: () => locationState,
      list: () => [{ hash: 'primary', opentasksPath: tempDir, primary: true, healthy: true }],
      has: () => true,
      add: () => {},
      remove: async () => {},
    };
    registerToolsMethods({ server, locationResolver });

    await server.start();
    client = createIPCClient(socketPath);
    await client.connect();
  });

  afterEach(async () => {
    try {
      client.disconnect();
    } catch {}
    try {
      await server.stop();
    } catch {}
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should transition a task', async () => {
    const result = await client.request<TaskResult>('tools.task', {
      transition: { id: 'x-task1', action: 'start' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.type).toBe('transition');
    expect(mockProviderStore.taskTransition).toHaveBeenCalledWith('x-task1', 'start');
  });

  it('should return ready tasks', async () => {
    const result = await client.request<TaskResult>('tools.task', {
      ready: { providers: ['beads'], limit: 10 },
    });

    expect(result.success).toBe(true);
    expect(result.data!.type).toBe('ready');
    expect(mockProviderStore.taskReady).toHaveBeenCalled();
  });

  it('should assign a task', async () => {
    const result = await client.request<TaskResult>('tools.task', {
      assign: { id: 'x-task1', assignee: 'alice' },
    });

    expect(result.success).toBe(true);
    expect(result.data!.type).toBe('assign');
    expect(mockProviderStore.taskAssign).toHaveBeenCalledWith('x-task1', 'alice');
  });

  it('should return valid actions', async () => {
    const result = await client.request<TaskResult>('tools.task', {
      validActions: { id: 'x-task1' },
    });

    expect(result.success).toBe(true);
    expect(result.data!.type).toBe('validActions');
    if (result.data!.type === 'validActions') {
      expect(result.data!.actions).toEqual(['start', 'complete', 'close']);
    }
  });

  it('should return error when no operation specified', async () => {
    const result = await client.request<TaskResult>('tools.task', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('No operation specified');
  });

  it('should return error for missing params', async () => {
    const result = await client.request<TaskResult>('tools.task', null as any);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should mark local node dirty on transition', async () => {
    await client.request<TaskResult>('tools.task', {
      transition: { id: 'x-task1', action: 'start' },
    });

    const dirty = flushManager.getDirtyNodes();
    expect(dirty).toContain('x-task1');
  });

  it('should mark local node dirty on assign', async () => {
    await client.request<TaskResult>('tools.task', {
      assign: { id: 'x-task1', assignee: 'alice' },
    });

    const dirty = flushManager.getDirtyNodes();
    expect(dirty).toContain('x-task1');
  });

  // --- Durability tiers (P2.2): coordination-critical writes flush before the
  // RPC returns; ordinary edits keep the debounce. ---

  it('flushes a claim immediately (durable tier)', async () => {
    await client.request<TaskResult>('tools.task', {
      claim: { id: 'c-claim1', agentId: 'a' },
    });

    expect(flushedBatches.flat()).toContain('c-claim1');
    expect(flushManager.getDirtyNodes()).not.toContain('c-claim1');
  });

  it('flushes a terminal transition immediately (durable tier)', async () => {
    vi.mocked(mockProviderStore.taskTransition).mockResolvedValue({
      node: { ...sampleNode, id: 'c-done1', status: 'closed' },
      provider: 'native',
      action: 'complete',
    });

    await client.request<TaskResult>('tools.task', {
      transition: { id: 'c-done1', action: 'complete' },
    });

    expect(flushedBatches.flat()).toContain('c-done1');
  });

  it('keeps a non-terminal transition on the debounce (not flushed immediately)', async () => {
    await client.request<TaskResult>('tools.task', {
      transition: { id: 'x-task1', action: 'start' },
    });

    expect(flushManager.getDirtyNodes()).toContain('x-task1');
    expect(flushedBatches.flat()).not.toContain('x-task1');
  });

  it('should handle provider errors gracefully', async () => {
    vi.mocked(mockProviderStore.taskTransition).mockRejectedValue(
      new Error('Provider does not support task operations'),
    );

    const result = await client.request<TaskResult>('tools.task', {
      transition: { id: 'x-task1', action: 'start' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not support task operations');
  });

  it('should return error when providerStore not available', async () => {
    // Create a new server without providerStore
    const tempDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-no-ps-test-'));
    const socketPath2 = path.join(tempDir2, 'test.sock');
    const server2 = createIPCServer(socketPath2);
    const stateWithoutPS = {
      hash: 'primary',
      opentasksPath: tempDir2,
      store: mockStore,
      // no providerStore
      flushManager,
      watcher: {} as any,
      primary: true,
      healthy: true,
    } as LocationState;
    const resolver2: LocationResolver = {
      resolve: () => stateWithoutPS,
      getDefault: () => stateWithoutPS,
      list: () => [],
      has: () => true,
      add: () => {},
      remove: async () => {},
    };
    registerToolsMethods({ server: server2, locationResolver: resolver2 });
    await server2.start();
    const client2 = createIPCClient(socketPath2);
    await client2.connect();

    const result = await client2.request<TaskResult>('tools.task', {
      transition: { id: 'x-task1', action: 'start' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Provider store not available');

    client2.disconnect();
    await server2.stop();
    await fs.rm(tempDir2, { recursive: true, force: true });
  });
});
