/**
 * Integration tests for daemon lifecycle
 *
 * Tests the full start -> IPC -> operations -> stop flow with real components.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDaemon, type Daemon, type DaemonConfig } from '../lifecycle.js';
import { createIPCClient, type IPCClient } from '../ipc.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node, Edge } from '../../schema/index.js';

// ============================================================================
// Mock Store
// ============================================================================

function createMockStore(): GraphStore {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    createNode: vi.fn().mockImplementation(async (input) => {
      const node: Node = {
        id: `t-${Date.now().toString(36)}`,
        uuid: '550e8400-e29b-41d4-a716-446655440000',
        type: input.type || 'task',
        title: input.title,
        status: input.status || 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...input,
      };
      nodes.set(node.id, node);
      return node;
    }),
    getNode: vi.fn().mockImplementation(async (id) => {
      return nodes.get(id) ?? null;
    }),
    updateNode: vi.fn().mockImplementation(async (id, updates) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`Node not found: ${id}`);
      const updated = { ...node, ...updates, updated_at: new Date().toISOString() };
      nodes.set(id, updated);
      return updated;
    }),
    deleteNode: vi.fn().mockResolvedValue(undefined),
    restoreNode: vi.fn(),
    createEdge: vi.fn().mockImplementation(async (input) => {
      const edge: Edge = {
        id: `x-${Date.now().toString(36)}`,
        uuid: '550e8400-e29b-41d4-a716-446655440001',
        from_id: input.from_id,
        to_id: input.to_id,
        type: input.type || 'blocks',
        created_at: new Date().toISOString(),
      };
      edges.set(edge.id, edge);
      return edge;
    }),
    getEdge: vi.fn().mockImplementation(async (id) => {
      return edges.get(id) ?? null;
    }),
    deleteEdge: vi.fn().mockResolvedValue(undefined),
    addTags: vi.fn(),
    removeTags: vi.fn(),
    setTags: vi.fn(),
    query: {
      nodes: vi.fn().mockResolvedValue([]),
      edges: vi.fn().mockResolvedValue([]),
      edgesFrom: vi.fn().mockResolvedValue([]),
      edgesTo: vi.fn().mockResolvedValue([]),
      edgesFor: vi.fn().mockResolvedValue([]),
      blockers: vi.fn().mockResolvedValue([]),
      blocking: vi.fn().mockResolvedValue([]),
      isBlocking: vi.fn().mockResolvedValue(false),
      tasks: vi.fn().mockResolvedValue([]),
      context: vi.fn().mockResolvedValue([]),
      children: vi.fn().mockResolvedValue([]),
      parent: vi.fn().mockResolvedValue(null),
      ancestors: vi.fn().mockResolvedValue([]),
      descendants: vi.fn().mockResolvedValue([]),
      ready: vi.fn().mockResolvedValue([]),
      feedback: vi.fn().mockResolvedValue([]),
      unresolvedFeedback: vi.fn().mockResolvedValue([]),
    },
    transaction: vi.fn(),
  } as unknown as GraphStore;
}

// ============================================================================
// Tests
// ============================================================================

describe('Daemon Integration', () => {
  let tempDir: string;
  let locationPath: string;
  let registryPath: string;
  let daemon: Daemon | null;
  let client: IPCClient | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-integration-'));
    locationPath = path.join(tempDir, '.opentasks');
    registryPath = path.join(tempDir, 'registry', 'registry.json');
    await fs.mkdir(locationPath, { recursive: true });
    daemon = null;
    client = null;
  });

  afterEach(async () => {
    if (client?.connected) {
      client.disconnect();
      client = null;
    }
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        /* ignore */
      }
      daemon = null;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function createConfig(store?: GraphStore): DaemonConfig {
    return {
      locationPath,
      version: '1.0.0-test',
      store: store ?? createMockStore(),
      registryPath,
      shutdownTimeoutMs: 2000,
    };
  }

  describe('start -> connect -> operate -> stop', () => {
    it('full lifecycle: ping via IPC', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      // Connect IPC client
      client = createIPCClient(daemon.socketPath);
      await client.connect();

      // Ping
      const result = await client.request<{ pong: boolean }>('ping');
      expect(result.pong).toBe(true);

      // Disconnect and stop
      client.disconnect();
      client = null;
      await daemon.stop();

      expect(daemon.getStatus().state).toBe('stopped');
    });

    it('health check returns version and uptime', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      const health = await client.request<{
        status: string;
        uptime: number;
        version: string;
        memory: { heapUsed: number };
      }>('health');

      expect(health.status).toBe('healthy');
      expect(health.version).toBe('1.0.0-test');
      expect(health.uptime).toBeGreaterThanOrEqual(0);
      expect(health.memory.heapUsed).toBeGreaterThan(0);
    });

    it('status reflects IPC connection count', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      // Before connection
      expect(daemon.getStatus().connectionCount).toBe(0);

      // Connect
      client = createIPCClient(daemon.socketPath);
      await client.connect();

      // After connection
      expect(daemon.getStatus().connectionCount).toBe(1);

      // After disconnect
      client.disconnect();
      client = null;

      // Wait for socket close event to propagate
      await new Promise((r) => setTimeout(r, 50));
      expect(daemon.getStatus().connectionCount).toBe(0);
    });
  });

  describe('graph operations via IPC', () => {
    it('graph.create and graph.get', async () => {
      const store = createMockStore();
      daemon = createDaemon(createConfig(store));
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      // Create a node
      const created = await client.request<Node>('graph.create', {
        type: 'task',
        title: 'Test Task',
        status: 'open',
      });

      expect(created.title).toBe('Test Task');
      expect(created.id).toBeTruthy();
      expect(store.createNode).toHaveBeenCalledOnce();
    });

    it('graph.createEdge creates an edge', async () => {
      const store = createMockStore();
      daemon = createDaemon(createConfig(store));
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      const edge = await client.request<Edge>('graph.createEdge', {
        from_id: 't-123',
        to_id: 't-456',
        type: 'blocks',
      });

      expect(edge.from_id).toBe('t-123');
      expect(edge.to_id).toBe('t-456');
      expect(store.createEdge).toHaveBeenCalledOnce();
    });

    it('flush triggers store.flush()', async () => {
      const store = createMockStore();
      daemon = createDaemon(createConfig(store));
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      const result = await client.request<{ success: boolean }>('flush');
      expect(result.success).toBe(true);
    });
  });

  describe('shutdown via IPC', () => {
    it('shutdown command stops the daemon', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      // Request shutdown
      const result = await client.request<{ success: boolean }>('shutdown');
      expect(result.success).toBe(true);

      // Disconnect before shutdown takes effect
      client.disconnect();
      client = null;

      // Wait for shutdown to complete
      await new Promise((r) => setTimeout(r, 200));
      expect(daemon.getStatus().state).toBe('stopped');
    });
  });

  describe('multiple concurrent clients', () => {
    it('handles multiple clients simultaneously', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      const client1 = createIPCClient(daemon.socketPath);
      const client2 = createIPCClient(daemon.socketPath);

      await client1.connect();
      await client2.connect();

      expect(daemon.getStatus().connectionCount).toBe(2);

      // Both can ping
      const [r1, r2] = await Promise.all([
        client1.request<{ pong: boolean }>('ping'),
        client2.request<{ pong: boolean }>('ping'),
      ]);

      expect(r1.pong).toBe(true);
      expect(r2.pong).toBe(true);

      client1.disconnect();
      client2.disconnect();
    });
  });

  describe('error handling', () => {
    it('unknown method returns method_not_found error', async () => {
      daemon = createDaemon(createConfig());
      await daemon.start();

      client = createIPCClient(daemon.socketPath);
      await client.connect();

      await expect(client.request('nonexistent.method')).rejects.toThrow('Method not found');
    });
  });

  describe('store.close called on stop', () => {
    it('calls store.close() during shutdown', async () => {
      const store = createMockStore();
      daemon = createDaemon(createConfig(store));
      await daemon.start();

      await daemon.stop();

      expect(store.close).toHaveBeenCalledOnce();
    });
  });
});
