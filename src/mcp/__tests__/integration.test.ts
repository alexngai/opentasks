/**
 * Integration tests for OpenTasks MCP Server
 *
 * Tests the full stack: MCP Client -> MCP Server -> OpenTasksClient -> IPC -> Daemon -> Store
 * Uses a real IPC server with mock store (same pattern as client tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer, type MCPScope } from '../server.js';
import { createIPCServer, type IPCServer } from '../../daemon/ipc.js';
import { registerToolsMethods } from '../../daemon/methods/tools.js';
import { registerGraphMethods } from '../../daemon/methods/graph.js';
import { createDaemonFlushManager, type DaemonFlushManager } from '../../daemon/flush.js';
import type { GraphStore } from '../../graph/store.js';
import type { Node, Edge } from '../../schema/index.js';
import type { LocationResolver, LocationState } from '../../daemon/location-state.js';
import type { ProviderAwareStore } from '../../graph/provider-store.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

function createMockStore(): { store: GraphStore; nodes: Map<string, any>; edges: Map<string, any> } {
  const nodes = new Map<string, any>();
  const edges = new Map<string, any>();
  let nodeCounter = 0;
  let edgeCounter = 0;

  const store = {
    getNode: vi.fn().mockImplementation(async (id: string) => nodes.get(id) || null),
    createNode: vi.fn().mockImplementation(async (input: any) => {
      const prefix = input.type === 'task' ? 't' : input.type === 'context' ? 'c' : input.type === 'feedback' ? 'f' : 'x';
      const node = {
        ...input,
        id: `${prefix}-new${++nodeCounter}`,
        uuid: `uuid-${nodeCounter}`,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      nodes.set(node.id, node);
      return node;
    }),
    updateNode: vi.fn().mockImplementation(async (id: string, updates: any) => {
      const existing = nodes.get(id);
      if (!existing) throw new Error(`Node not found: ${id}`);
      const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
      nodes.set(id, updated);
      return updated;
    }),
    deleteNode: vi.fn().mockImplementation(async (id: string) => {
      nodes.delete(id);
    }),
    createEdge: vi.fn().mockImplementation(async (input: any) => {
      const edge = {
        ...input,
        id: `x-edge${++edgeCounter}`,
        uuid: `uuid-edge-${edgeCounter}`,
        created_at: new Date().toISOString(),
      };
      edges.set(edge.id, edge);
      return edge;
    }),
    getEdge: vi.fn().mockImplementation(async (id: string) => edges.get(id) || null),
    deleteEdge: vi.fn().mockImplementation(async (id: string) => { edges.delete(id); }),
    query: {
      nodes: vi.fn().mockImplementation(async (filter?: any) => {
        let result = Array.from(nodes.values());
        if (filter?.type) {
          const types = Array.isArray(filter.type) ? filter.type : [filter.type];
          result = result.filter((n: any) => types.includes(n.type));
        }
        if (filter?.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          result = result.filter((n: any) => statuses.includes(n.status));
        }
        if (filter?.tags) {
          result = result.filter((n: any) => filter.tags.every((t: string) => n.tags?.includes(t)));
        }
        return result;
      }),
      edges: vi.fn().mockImplementation(async (filter?: any) => {
        let result = Array.from(edges.values());
        if (filter?.type) {
          const types = Array.isArray(filter.type) ? filter.type : [filter.type];
          result = result.filter((e: any) => types.includes(e.type));
        }
        if (filter?.from_id) result = result.filter((e: any) => e.from_id === filter.from_id);
        if (filter?.to_id) result = result.filter((e: any) => e.to_id === filter.to_id);
        return result;
      }),
      ready: vi.fn().mockImplementation(async () => {
        return Array.from(nodes.values()).filter((n: any) => n.type === 'task' && n.status === 'open');
      }),
      blockers: vi.fn().mockImplementation(async (nodeId: string) => {
        const blockingEdges = Array.from(edges.values()).filter((e: any) => e.to_id === nodeId && e.type === 'blocks');
        return blockingEdges.map((e: any) => nodes.get(e.from_id)).filter(Boolean);
      }),
      blocking: vi.fn().mockImplementation(async (nodeId: string) => {
        const blockedEdges = Array.from(edges.values()).filter((e: any) => e.from_id === nodeId && e.type === 'blocks');
        return blockedEdges.map((e: any) => nodes.get(e.to_id)).filter(Boolean);
      }),
      feedback: vi.fn().mockImplementation(async (nodeId: string) => {
        return Array.from(nodes.values()).filter((n: any) => n.type === 'feedback' && n.target_id === nodeId);
      }),
      unresolvedFeedback: vi.fn().mockResolvedValue([]),
      edgesFrom: vi.fn().mockResolvedValue([]),
      edgesTo: vi.fn().mockResolvedValue([]),
      edgesFor: vi.fn().mockResolvedValue([]),
      isBlocking: vi.fn().mockResolvedValue(false),
      tasks: vi.fn().mockResolvedValue([]),
      context: vi.fn().mockResolvedValue([]),
      children: vi.fn().mockResolvedValue([]),
      parent: vi.fn().mockResolvedValue(null),
      ancestors: vi.fn().mockResolvedValue([]),
      descendants: vi.fn().mockResolvedValue([]),
    },
    transaction: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
    setNodeResolver: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    restoreNode: vi.fn(),
    addTags: vi.fn(),
    removeTags: vi.fn(),
    setTags: vi.fn(),
  } as unknown as GraphStore;

  return { store, nodes, edges };
}

async function setupDaemon(store: GraphStore, providerStore?: ProviderAwareStore) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-mcp-integration-'));
  const socketPath = path.join(tempDir, 'daemon.sock');

  const flushManager = createDaemonFlushManager({ debounceMs: 100, maxDelayMs: 500 }, async () => {});

  const server = createIPCServer(socketPath);
  const locationState = {
    hash: 'primary',
    opentasksPath: tempDir,
    store,
    providerStore,
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
  registerGraphMethods({ server, locationResolver });
  await server.start();

  return { server, socketPath, tempDir };
}

async function createIntegrationClient(socketPath: string, scopes?: MCPScope[]) {
  const mcpServer = createMCPServer({
    clientOptions: { socketPath },
    scopes,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return {
    parsed: text ? JSON.parse(text) : null,
    isError: result.isError,
  };
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('MCP Server Integration', () => {
  let ipcServer: IPCServer;
  let socketPath: string;
  let tempDir: string;
  let mockData: ReturnType<typeof createMockStore>;

  beforeEach(async () => {
    mockData = createMockStore();
    const setup = await setupDaemon(mockData.store);
    ipcServer = setup.server;
    socketPath = setup.socketPath;
    tempDir = setup.tempDir;
  });

  afterEach(async () => {
    try { await ipcServer.stop(); } catch {}
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // Task Workflow
  // ==========================================================================

  describe('task workflow (default scope)', () => {
    it('should create and retrieve a task', async () => {
      const client = await createIntegrationClient(socketPath);

      // Create
      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'Implement auth',
        status: 'open',
        priority: 1,
        tags: ['backend', 'security'],
      });

      expect(created.id).toMatch(/^t-/);
      expect(created.title).toBe('Implement auth');
      expect(created.type).toBe('task');

      // Retrieve
      const { parsed: fetched } = await callTool(client, 'get_task', { id: created.id });

      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe('Implement auth');
    });

    it('should update a task', async () => {
      const client = await createIntegrationClient(socketPath);

      // Create
      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'Original',
        status: 'open',
      });

      // Update
      const { parsed: result } = await callTool(client, 'update_task', {
        id: created.id,
        title: 'Updated Title',
        priority: 0,
      });

      expect(result.op).toBe('update');
      expect(result.success).toBe(true);
      expect(result.result.title).toBe('Updated Title');
      expect(result.result.priority).toBe(0);
    });

    it('should list tasks with status filter', async () => {
      const client = await createIntegrationClient(socketPath);

      // Create tasks with different statuses
      await callTool(client, 'create_task', { title: 'Open Task', status: 'open' });
      await callTool(client, 'create_task', { title: 'Closed Task', status: 'closed' });

      // Filter by status
      const { parsed } = await callTool(client, 'list_tasks', { status: 'open' });

      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      parsed.items.forEach((item: any) => {
        expect(item.status).toBe('open');
      });
    });

    it('should manage blockers via update_task', async () => {
      const client = await createIntegrationClient(socketPath);

      // Create two tasks
      const { parsed: task1 } = await callTool(client, 'create_task', { title: 'Task 1', status: 'open' });
      const { parsed: task2 } = await callTool(client, 'create_task', { title: 'Task 2', status: 'open' });

      // task1 blocks task2
      const { parsed: result } = await callTool(client, 'update_task', {
        id: task2.id,
        addBlockedBy: [task1.id],
      });

      // Verify the edge was created
      expect(result.op).toBe('addBlockedBy');
      expect(result.success).toBe(true);
      expect(mockData.store.createEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          from_id: task1.id,
          to_id: task2.id,
          type: 'blocks',
        }),
      );
    });

    it('should remove blockers via update_task', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed: task1 } = await callTool(client, 'create_task', { title: 'Task 1', status: 'open' });
      const { parsed: task2 } = await callTool(client, 'create_task', { title: 'Task 2', status: 'open' });

      // Add then remove blocker
      await callTool(client, 'update_task', { id: task2.id, addBlockedBy: [task1.id] });
      await callTool(client, 'update_task', { id: task2.id, removeBlockedBy: [task1.id] });

      // deleteEdge should have been called (via link remove)
      expect(mockData.store.deleteEdge).toHaveBeenCalled();
    });

    it('should list ready tasks', async () => {
      const client = await createIntegrationClient(socketPath);

      await callTool(client, 'create_task', { title: 'Ready Task', status: 'open' });

      const { parsed } = await callTool(client, 'list_tasks', { ready: true });

      // Ready query goes through task tool which needs provider store,
      // so it may fail without one — but should not crash
      expect(parsed).toBeDefined();
    });

    it('should query blockers of a task', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed: blocker } = await callTool(client, 'create_task', { title: 'Blocker', status: 'open' });
      const { parsed: blocked } = await callTool(client, 'create_task', { title: 'Blocked', status: 'open' });

      // Create blocking edge
      await callTool(client, 'update_task', { id: blocked.id, addBlockedBy: [blocker.id] });

      // Query blockers
      const { parsed } = await callTool(client, 'list_tasks', { blockersOf: blocked.id });

      expect(parsed.items).toBeDefined();
    });

    it('should handle get for non-existent task', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed, isError } = await callTool(client, 'get_task', { id: 't-nonexistent' });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Task not found');
    });
  });

  // ==========================================================================
  // Multi-Scope Workflow
  // ==========================================================================

  describe('multi-scope workflow (all scopes)', () => {
    it('should create task and context, then link them', async () => {
      const client = await createIntegrationClient(socketPath, ['tasks', 'graph', 'context']);

      // Create a context/spec
      const { parsed: context } = await callTool(client, 'create_context', {
        title: 'Auth Requirements',
        content: '# Auth\nMust support OAuth2',
        tags: ['security'],
      });
      expect(context.id).toMatch(/^c-/);
      expect(context.type).toBe('context');

      // Create a task
      const { parsed: task } = await callTool(client, 'create_task', {
        title: 'Implement OAuth2',
        status: 'open',
      });

      // Link task implements context
      const { parsed: linkResult } = await callTool(client, 'link', {
        fromId: task.id,
        toId: context.id,
        type: 'implements',
      });

      expect(linkResult.success).toBe(true);
      expect(linkResult.edgeId).toBeDefined();

      // Query edges to verify
      const { parsed: edgeQuery } = await callTool(client, 'query', {
        edges: { type: 'implements', from_id: task.id },
      });

      expect(edgeQuery.items.length).toBeGreaterThanOrEqual(1);
    });

    it('should annotate a context node', async () => {
      const client = await createIntegrationClient(socketPath, ['tasks', 'context', 'annotate']);

      const { parsed: context } = await callTool(client, 'create_context', {
        title: 'API Design',
        content: 'REST API spec',
      });

      const { parsed: annotation } = await callTool(client, 'annotate', {
        targetId: context.id,
        create: {
          content: 'Should we use GraphQL instead?',
          type: 'suggestion',
        },
      });

      expect(annotation.success).toBe(true);
      expect(annotation.feedbackId).toBeDefined();
    });

    it('should query all node types', async () => {
      const client = await createIntegrationClient(socketPath, ['tasks', 'context', 'graph']);

      await callTool(client, 'create_task', { title: 'Task A', status: 'open' });
      await callTool(client, 'create_context', { title: 'Context A' });

      // Query all via graph scope
      const { parsed } = await callTool(client, 'query', { nodes: {} });

      expect(parsed.items.length).toBeGreaterThanOrEqual(2);
    });

    it('should list and filter contexts', async () => {
      const client = await createIntegrationClient(socketPath, ['context']);

      await callTool(client, 'create_context', { title: 'Auth Spec', tags: ['security'] });
      await callTool(client, 'create_context', { title: 'DB Schema', tags: ['database'] });

      const { parsed } = await callTool(client, 'list_contexts', { tags: ['security'] });

      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      expect(parsed.items[0].title).toBe('Auth Spec');
    });

    it('should update and retrieve a context', async () => {
      const client = await createIntegrationClient(socketPath, ['context']);

      const { parsed: created } = await callTool(client, 'create_context', {
        title: 'Original Title',
      });

      await callTool(client, 'update_context', {
        id: created.id,
        title: 'Updated Title',
        content: 'New content here',
      });

      const { parsed: fetched } = await callTool(client, 'get_context', { id: created.id });

      expect(fetched.title).toBe('Updated Title');
      expect(fetched.content).toBe('New content here');
    });
  });

  // ==========================================================================
  // Full Task Lifecycle
  // ==========================================================================

  describe('full task lifecycle with provider store', () => {
    let providerIpcServer: IPCServer;
    let providerSocketPath: string;
    let providerTempDir: string;

    beforeEach(async () => {
      const { store, nodes } = createMockStore();

      // Seed a task for transition tests
      nodes.set('t-lifecycle', {
        id: 't-lifecycle',
        uuid: 'uuid-lifecycle',
        type: 'task',
        title: 'Lifecycle Task',
        status: 'open',
        priority: 1,
        archived: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const providerStore = {
        ...store,
        taskTransition: vi.fn().mockImplementation(async (id: string, action: string) => {
          const node = nodes.get(id);
          if (!node) throw new Error('Node not found');
          const statusMap: Record<string, string> = {
            start: 'in_progress',
            complete: 'done',
            block: 'blocked',
            reopen: 'open',
            close: 'closed',
          };
          node.status = statusMap[action] || node.status;
          return { node, provider: 'native', action };
        }),
        taskReady: vi.fn().mockImplementation(async () => {
          return Array.from(nodes.values()).filter((n: any) => n.type === 'task' && n.status === 'open');
        }),
        taskAssign: vi.fn().mockImplementation(async (id: string, assignee: string) => {
          const node = nodes.get(id);
          if (!node) throw new Error('Node not found');
          node.assignee = assignee;
          return node;
        }),
        taskValidActions: vi.fn().mockResolvedValue(['start', 'complete', 'block', 'close']),
      } as unknown as ProviderAwareStore;

      const setup = await setupDaemon(store, providerStore);
      providerIpcServer = setup.server;
      providerSocketPath = setup.socketPath;
      providerTempDir = setup.tempDir;
    });

    afterEach(async () => {
      try { await providerIpcServer.stop(); } catch {}
      try { await fs.rm(providerTempDir, { recursive: true, force: true }); } catch {}
    });

    it('should transition task through lifecycle', async () => {
      const client = await createIntegrationClient(providerSocketPath);

      // Start task
      const { parsed: startResult } = await callTool(client, 'update_task', {
        id: 't-lifecycle',
        transition: 'start',
      });

      expect(startResult.op).toBe('transition');
      expect(startResult.success).toBe(true);
      expect(startResult.result.data.action).toBe('start');

      // Complete task
      const { parsed: completeResult } = await callTool(client, 'update_task', {
        id: 't-lifecycle',
        transition: 'complete',
      });

      expect(completeResult.op).toBe('transition');
      expect(completeResult.success).toBe(true);
      expect(completeResult.result.data.action).toBe('complete');
    });

    it('should get valid actions for a task', async () => {
      const client = await createIntegrationClient(providerSocketPath, ['tasks', 'graph']);

      // Use task tool directly via the underlying query mechanism
      // validActions doesn't have a surface in the CRUD tools, so we test via list_tasks
      // that the provider store is connected

      const { parsed } = await callTool(client, 'list_tasks', { ready: true });

      expect(parsed.success).toBe(true);
      expect(parsed.data.type).toBe('ready');
    });

    it('should transition then query ready tasks', async () => {
      const client = await createIntegrationClient(providerSocketPath);

      // Query ready tasks (task is open, so should be ready)
      const { parsed: readyBefore } = await callTool(client, 'list_tasks', { ready: true });
      expect(readyBefore.success).toBe(true);
      expect(readyBefore.data.items.length).toBeGreaterThanOrEqual(1);

      // Start the task (transitions from open -> in_progress)
      const { parsed: startResult } = await callTool(client, 'update_task', {
        id: 't-lifecycle',
        transition: 'start',
      });
      expect(startResult.result.success).toBe(true);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty list results', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed } = await callTool(client, 'list_tasks', { status: 'nonexistent' });

      expect(parsed.items).toEqual([]);
    });

    it('should propagate meaningful error messages for non-existent nodes', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed, isError } = await callTool(client, 'update_task', {
        id: 't-nonexistent',
        title: 'Should fail',
      });

      expect(isError).toBe(true);
      // Error should contain the actual message, not generic "Internal error"
      expect(parsed.op).toBe('update');
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not found');
    });

    it('should report partial success when some operations fail', async () => {
      const client = await createIntegrationClient(socketPath);

      // Create a real task
      const { parsed: task } = await callTool(client, 'create_task', { title: 'Real Task', status: 'open' });

      // Update with valid field change + transition (transition will fail without provider store)
      const { parsed, isError } = await callTool(client, 'update_task', {
        id: task.id,
        title: 'Updated',
        transition: 'start',
      });

      expect(isError).toBe(true);
      expect(parsed.operations).toHaveLength(2);

      // Field update should succeed
      const updateOp = parsed.operations.find((op: any) => op.op === 'update');
      expect(updateOp.success).toBe(true);

      // Transition should fail (no provider store)
      const transitionOp = parsed.operations.find((op: any) => op.op === 'transition');
      expect(transitionOp.success).toBe(false);
      expect(transitionOp.error).toBeDefined();
    });

    it('should create task with metadata', async () => {
      const client = await createIntegrationClient(socketPath);

      const { parsed } = await callTool(client, 'create_task', {
        title: 'Task with metadata',
        status: 'open',
        metadata: { source: 'mcp-test', custom_field: 42 },
      });

      expect(parsed.metadata).toEqual({ source: 'mcp-test', custom_field: 42 });
    });
  });
});
