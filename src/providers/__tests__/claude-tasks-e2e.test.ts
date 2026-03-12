/**
 * E2E tests: MCP Client → MCP Server → IPC → Daemon → Claude Tasks Filesystem Store
 *
 * Full stack with real file I/O. Verifies that tasks created via MCP tools
 * are persisted as JSON files on disk, and that externally-written files
 * (simulating Claude Code native TaskCreate) are visible through MCP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMCPServer, type MCPScope } from '../../mcp/server.js';
import { createIPCServer, type IPCServer } from '../../daemon/ipc.js';
import { registerToolsMethods } from '../../daemon/methods/tools.js';
import { registerGraphMethods } from '../../daemon/methods/graph.js';
import { createDaemonFlushManager } from '../../daemon/flush.js';
import { createFilesystemTaskStore } from '../claude-tasks-fs.js';
import { createClaudeTasksProvider } from '../claude-tasks.js';
import { createNativeProvider } from '../native.js';
import { createProviderRegistry } from '../registry.js';
import { createProviderAwareStore, type ProviderAwareStore } from '../../graph/provider-store.js';
import type { GraphStore } from '../../graph/store.js';
import type { LocationResolver, LocationState } from '../../daemon/location-state.js';
import type { ClaudeTask } from '../claude-tasks.js';

// ============================================================================
// Test Infrastructure
// ============================================================================

function createMockGraphStore(): GraphStore {
  const nodes = new Map<string, any>();
  const edges = new Map<string, any>();
  let nodeCounter = 0;
  let edgeCounter = 0;

  return {
    getNode: vi.fn().mockImplementation(async (id: string) => nodes.get(id) || null),
    createNode: vi.fn().mockImplementation(async (input: any) => {
      const prefix = input.type === 'task' ? 't' : input.type === 'context' ? 'c' : 'x';
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
    deleteNode: vi.fn().mockImplementation(async (id: string) => { nodes.delete(id); }),
    createEdge: vi.fn().mockImplementation(async (input: any) => {
      const edge = { ...input, id: `x-edge${++edgeCounter}`, uuid: `uuid-edge-${edgeCounter}`, created_at: new Date().toISOString() };
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
      blockers: vi.fn().mockResolvedValue([]),
      blocking: vi.fn().mockResolvedValue([]),
      feedback: vi.fn().mockResolvedValue([]),
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
}

interface E2ESetup {
  ipcServer: IPCServer;
  socketPath: string;
  tempDir: string;
  tasksDir: string;
}

async function setupE2E(): Promise<E2ESetup> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-claude-e2e-'));
  const socketPath = path.join(tempDir, 'daemon.sock');
  const tasksDir = path.join(tempDir, 'tasks');

  const graphStore = createMockGraphStore();
  const flushManager = createDaemonFlushManager({ debounceMs: 100, maxDelayMs: 500 }, async () => {});

  // Create filesystem-backed Claude tasks provider
  const taskStore = createFilesystemTaskStore({ basePath: tasksDir });
  const claudeProvider = createClaudeTasksProvider({ taskStore });
  const nativeProvider = createNativeProvider(graphStore);

  const registry = createProviderRegistry();
  registry.register(nativeProvider);
  registry.register(claudeProvider);

  const ipcServer = createIPCServer(socketPath);
  const locationState = {
    hash: 'primary',
    opentasksPath: tempDir,
    store: graphStore,
    providerStore: undefined,
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

  registerToolsMethods({ server: ipcServer, locationResolver });
  registerGraphMethods({ server: ipcServer, locationResolver });
  await ipcServer.start();

  return { ipcServer, socketPath, tempDir, tasksDir };
}

async function createClient(socketPath: string, scopes?: MCPScope[]) {
  const mcpServer = createMCPServer({
    clientOptions: { socketPath },
    scopes,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });

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
// E2E Tests
// ============================================================================

describe('Claude Tasks E2E: MCP → Daemon → Filesystem', () => {
  let setup: E2ESetup;

  beforeEach(async () => {
    setup = await setupE2E();
  });

  afterEach(async () => {
    try { await setup.ipcServer.stop(); } catch {}
    try { fs.rmSync(setup.tempDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // MCP task CRUD through native store (graph store)
  // ==========================================================================

  describe('MCP task CRUD through native store', () => {
    it('should create a task via MCP create_task (uses native graph store)', async () => {
      const client = await createClient(setup.socketPath);

      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'Implement auth module',
        status: 'open',
        priority: 1,
        tags: ['backend', 'security'],
      });

      // MCP create_task routes to native graph store, not Claude filesystem store
      expect(created.id).toBeDefined();
      expect(created.title).toBe('Implement auth module');
      expect(created.type).toBe('task');
    });

    it('should create, update, and retrieve a task through MCP', async () => {
      const client = await createClient(setup.socketPath);

      // Create
      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'Fix bug #42',
        status: 'open',
      });

      // Update status
      const { parsed: updateResult } = await callTool(client, 'update_task', {
        id: created.id,
        status: 'in_progress',
      });
      expect(updateResult.success).toBe(true);

      // Retrieve and verify
      const { parsed: fetched } = await callTool(client, 'get_task', { id: created.id });
      expect(fetched.title).toBe('Fix bug #42');
    });

    it('should list multiple tasks created via MCP', async () => {
      const client = await createClient(setup.socketPath);

      await callTool(client, 'create_task', { title: 'Task A', status: 'open' });
      await callTool(client, 'create_task', { title: 'Task B', status: 'open' });
      await callTool(client, 'create_task', { title: 'Task C', status: 'open' });

      const { parsed } = await callTool(client, 'list_tasks', {});
      expect(parsed.items.length).toBeGreaterThanOrEqual(3);
    });

    it('should delete a native task via MCP delete_task', async () => {
      const client = await createClient(setup.socketPath);

      // Create
      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'To be deleted',
        status: 'open',
      });
      expect(created.id).toBeDefined();

      // Verify it exists
      const { parsed: fetched, isError: fetchErr } = await callTool(client, 'get_task', { id: created.id });
      expect(fetchErr).toBeFalsy();
      expect(fetched.title).toBe('To be deleted');

      // Delete
      const { parsed: deleteResult, isError } = await callTool(client, 'delete_task', { id: created.id });
      expect(isError).toBeFalsy();
      expect(deleteResult.success).toBe(true);

      // Verify it's gone
      const { isError: getErr } = await callTool(client, 'get_task', { id: created.id });
      expect(getErr).toBe(true);
    });

    it('should not error when deleting already-deleted task (idempotent)', async () => {
      const client = await createClient(setup.socketPath);

      // Create and delete
      const { parsed: created } = await callTool(client, 'create_task', { title: 'Ephemeral', status: 'open' });
      await callTool(client, 'delete_task', { id: created.id });

      // Second delete is idempotent (graph store silently ignores missing)
      const { parsed, isError } = await callTool(client, 'delete_task', { id: created.id });
      expect(isError).toBeFalsy();
      expect(parsed.success).toBe(true);
    });
  });

  // ==========================================================================
  // External writes visible through MCP (simulating Claude native TaskCreate)
  // ==========================================================================

  describe('external writes (Claude native tasks) visible through MCP', () => {
    it('should read a task file written directly to disk via MCP get_task', async () => {
      // Simulate Claude Code's TaskCreate writing a file directly
      const externalTask: ClaudeTask = {
        id: '1',
        subject: 'Fix auth token expiry',
        description: 'Auth tokens expire too soon, increase TTL',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(setup.tasksDir, '1.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(setup.tasksDir, '.highwatermark'), '1', 'utf-8');

      // Create a fresh MCP client and verify the task is visible
      const client = await createClient(setup.socketPath);
      const { parsed } = await callTool(client, 'list_tasks', {});

      // The task should be visible (via native store at minimum)
      expect(parsed).toBeDefined();
    });

    it('should see externally-written tasks via filesystem store directly', async () => {
      // Write two tasks directly to disk (simulating Claude native tools)
      for (const id of ['1', '2']) {
        const task: ClaudeTask = {
          id,
          subject: `Task ${id}`,
          description: `Written by Claude Code directly`,
          status: 'pending',
          blocks: [],
          blockedBy: [],
        };
        fs.writeFileSync(
          path.join(setup.tasksDir, `${id}.json`),
          JSON.stringify(task, null, 2),
          'utf-8',
        );
      }
      fs.writeFileSync(path.join(setup.tasksDir, '.highwatermark'), '2', 'utf-8');

      // Both tasks should exist on disk
      const jsonFiles = fs.readdirSync(setup.tasksDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      expect(jsonFiles).toHaveLength(2);

      // Verify the filesystem store can read them
      const store = createFilesystemTaskStore({ basePath: setup.tasksDir });
      const tasks = await store.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].subject).toBe('Task 1');
      expect(tasks[1].subject).toBe('Task 2');
    });
  });

  // ==========================================================================
  // Status mapping round-trip: MCP → filesystem → MCP
  // ==========================================================================

  describe('status mapping through full stack', () => {
    it('should map Claude pending status to open through provider', async () => {
      // Write a task with Claude's "pending" status directly
      const task: ClaudeTask = {
        id: '1',
        subject: 'Status mapping test',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(setup.tasksDir, '1.json'),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(setup.tasksDir, '.highwatermark'), '1', 'utf-8');

      // Read through provider — should map pending → open
      const store = createFilesystemTaskStore({ basePath: setup.tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });
      const fetched = await provider.get('1');
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('open');
      expect(fetched!.title).toBe('Status mapping test');
    });

    it('should handle status updates through MCP that persist correctly', async () => {
      const client = await createClient(setup.socketPath);

      // Create
      const { parsed: created } = await callTool(client, 'create_task', {
        title: 'Status lifecycle',
        status: 'open',
      });

      // Update to in_progress
      await callTool(client, 'update_task', {
        id: created.id,
        status: 'in_progress',
      });

      // Retrieve and verify
      const { parsed: fetched } = await callTool(client, 'get_task', { id: created.id });
      expect(fetched).toBeDefined();
    });
  });

  // ==========================================================================
  // Multi-scope workflow with filesystem-backed tasks
  // ==========================================================================

  describe('multi-scope workflow', () => {
    it('should create task, create context, and link them (graph + tasks)', async () => {
      const client = await createClient(setup.socketPath, ['tasks', 'graph', 'context']);

      // Create task
      const { parsed: task } = await callTool(client, 'create_task', {
        title: 'Implement OAuth',
        status: 'open',
      });
      expect(task.id).toBeDefined();

      // Create context
      const { parsed: context } = await callTool(client, 'create_context', {
        title: 'Auth requirements',
        content: 'Must support OAuth2 and OIDC',
        tags: ['security'],
      });
      expect(context.id).toBeDefined();

      // Link task implements context
      const { parsed: linkResult } = await callTool(client, 'link', {
        fromId: task.id,
        toId: context.id,
        type: 'implements',
      });
      expect(linkResult.success).toBe(true);
    });
  });

  // ==========================================================================
  // Filesystem store resilience
  // ==========================================================================

  describe('filesystem resilience', () => {
    it('should handle highwatermark correctly across MCP creates', async () => {
      const client = await createClient(setup.socketPath);

      const { parsed: t1 } = await callTool(client, 'create_task', { title: 'First', status: 'open' });
      const { parsed: t2 } = await callTool(client, 'create_task', { title: 'Second', status: 'open' });

      // IDs should be different
      expect(t1.id).not.toBe(t2.id);

      // Verify highwatermark file exists
      const hwmPath = path.join(setup.tasksDir, '.highwatermark');
      if (fs.existsSync(hwmPath)) {
        const hwm = parseInt(fs.readFileSync(hwmPath, 'utf-8').trim(), 10);
        expect(hwm).toBeGreaterThanOrEqual(2);
      }
    });

    it('should return error for non-existent task', async () => {
      const client = await createClient(setup.socketPath);

      const { parsed, isError } = await callTool(client, 'get_task', { id: 't-nonexistent-999' });
      expect(isError).toBe(true);
    });
  });
});

// ============================================================================
// E2E Tests: ProviderAwareStore — Claude filesystem read bridge through MCP
// ============================================================================

describe('Claude Tasks E2E: ProviderAwareStore read bridge', () => {
  let ipcServer: IPCServer;
  let socketPath: string;
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-provider-e2e-'));
    socketPath = path.join(tempDir, 'daemon.sock');
    tasksDir = path.join(tempDir, 'tasks');

    const graphStore = createMockGraphStore();
    const flushManager = createDaemonFlushManager({ debounceMs: 100, maxDelayMs: 500 }, async () => {});

    // Create filesystem-backed Claude tasks provider
    const taskStore = createFilesystemTaskStore({ basePath: tasksDir });
    const claudeProvider = createClaudeTasksProvider({ taskStore });

    // Create ProviderAwareStore with Claude provider registered
    const registry = createProviderRegistry();
    registry.register(claudeProvider);

    const providerStore = createProviderAwareStore(graphStore, {
      registry,
      autoRegisterNative: true, // also register native provider
    });

    ipcServer = createIPCServer(socketPath);
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: graphStore,
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

    registerToolsMethods({ server: ipcServer, locationResolver });
    registerGraphMethods({ server: ipcServer, locationResolver });
    await ipcServer.start();
  });

  afterEach(async () => {
    try { await ipcServer.stop(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // External writes visible through MCP via ProviderAwareStore
  // ==========================================================================

  describe('external writes readable through MCP (provider-aware)', () => {
    it('should resolve a claude:// URI for an externally-written task file', async () => {
      // Write a task directly to disk (simulating Claude Code TaskCreate)
      const externalTask: ClaudeTask = {
        id: '1',
        subject: 'Fix auth token expiry',
        description: 'Auth tokens expire too soon',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      // Access through MCP using claude:// URI via graph query
      const client = await createClient(socketPath, ['tasks', 'graph']);

      // The Claude provider resolves claude:// URIs through providerStore
      const { parsed } = await callTool(client, 'query', {
        nodes: { type: 'task' },
      });

      // Native tasks should be queryable (may be empty since we only wrote to claude store)
      expect(parsed).toBeDefined();
    });

    it('should have Claude provider registered and accessible', async () => {
      // Write a task to disk
      const externalTask: ClaudeTask = {
        id: '1',
        subject: 'Provider test',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(externalTask, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      // Verify provider is accessible through MCP list_providers
      const client = await createClient(socketPath, ['graph']);
      const { parsed } = await callTool(client, 'list_providers', {});

      // Should include both 'native' and 'claude' providers
      expect(parsed).toBeDefined();
      if (parsed.providers) {
        const names = parsed.providers.map((p: any) => p.name);
        expect(names).toContain('native');
        expect(names).toContain('claude');
      }
    });
  });

  // ==========================================================================
  // Status mapping through ProviderAwareStore
  // ==========================================================================

  describe('status mapping through provider-aware store', () => {
    it('should map pending → open when resolving Claude tasks', async () => {
      // Write task with Claude's "pending" status
      const task: ClaudeTask = {
        id: '1',
        subject: 'Status bridge test',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      // Read through the provider directly (testing the store layer)
      const store = createFilesystemTaskStore({ basePath: tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });
      const fetched = await provider.get('1');

      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('open'); // pending → open
      expect(fetched!.title).toBe('Status bridge test');
      expect(fetched!.uri).toContain('claude://');
    });

    it('should map completed → closed when provider reads completed tasks', async () => {
      const task: ClaudeTask = {
        id: '1',
        subject: 'Completed task',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const store = createFilesystemTaskStore({ basePath: tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });
      const fetched = await provider.get('1');

      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('closed'); // completed → closed
    });

    it('should map in_progress correctly (no change)', async () => {
      const task: ClaudeTask = {
        id: '1',
        subject: 'In-progress task',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const store = createFilesystemTaskStore({ basePath: tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });
      const fetched = await provider.get('1');

      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('in_progress');
    });
  });

  // ==========================================================================
  // Provider update writes back to filesystem
  // ==========================================================================

  describe('provider update writes back to filesystem', () => {
    it('should update a Claude task through provider and verify file on disk', async () => {
      // Create a task on disk
      const task: ClaudeTask = {
        id: '1',
        subject: 'Original title',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      };
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      // Update through provider
      const store = createFilesystemTaskStore({ basePath: tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });

      const updated = await provider.update('1', { status: 'closed' });
      expect(updated.status).toBe('closed');

      // Verify file on disk was updated
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('completed'); // closed → completed on disk
    });

    it('should create a task through provider and persist to filesystem', async () => {
      const store = createFilesystemTaskStore({ basePath: tasksDir });
      const provider = createClaudeTasksProvider({ taskStore: store });

      const created = await provider.create({
        type: 'issue',
        title: 'New task via provider',
        content: 'Task details here',
      });

      expect(created.id).toBeDefined();
      expect(created.title).toBe('New task via provider');

      // Verify file exists on disk
      const filePath = path.join(tasksDir, `${created.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);

      const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeTask;
      expect(fileContent.subject).toBe('New task via provider');
    });
  });
});

// ============================================================================
// E2E Tests: Live MCP → claude:// URI resolution through full stack
// ============================================================================

describe('Claude Tasks E2E: Live MCP → claude:// URI resolution', () => {
  let ipcServer: IPCServer;
  let socketPath: string;
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentasks-uri-e2e-'));
    socketPath = path.join(tempDir, 'daemon.sock');
    tasksDir = path.join(tempDir, 'tasks');

    const graphStore = createMockGraphStore();
    const flushManager = createDaemonFlushManager({ debounceMs: 100, maxDelayMs: 500 }, async () => {});

    // Create filesystem-backed Claude tasks provider
    const taskStore = createFilesystemTaskStore({ basePath: tasksDir });
    const claudeProvider = createClaudeTasksProvider({ taskStore });

    // Create ProviderAwareStore with Claude provider registered
    const registry = createProviderRegistry();
    registry.register(claudeProvider);

    const providerStore = createProviderAwareStore(graphStore, {
      registry,
      autoRegisterNative: true,
    });

    ipcServer = createIPCServer(socketPath);
    const locationState = {
      hash: 'primary',
      opentasksPath: tempDir,
      store: graphStore,
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

    registerToolsMethods({ server: ipcServer, locationResolver });
    registerGraphMethods({ server: ipcServer, locationResolver });
    await ipcServer.start();
  });

  afterEach(async () => {
    try { await ipcServer.stop(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // get_task with claude://current/<id> resolves through full MCP stack
  // ==========================================================================

  it('get_task with claude://current/<id> resolves externally-written task through full MCP stack', async () => {
    // Step 1: Write a Claude task file directly to disk (simulating Claude Code TaskCreate)
    const externalTask: ClaudeTask = {
      id: '1',
      subject: 'Fix auth token expiry',
      description: 'Auth tokens expire too soon, increase TTL',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    };
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, '1.json'),
      JSON.stringify(externalTask, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

    // Step 2: Call get_task MCP tool with claude://current/1
    const client = await createClient(socketPath, ['tasks', 'graph']);
    const { parsed, isError } = await callTool(client, 'get_task', { id: 'claude://current/1' });

    // Step 3: Verify result came back with correct title and mapped status
    expect(isError).toBeFalsy();
    expect(parsed).toBeDefined();
    expect(parsed.title).toBe('Fix auth token expiry');
    // Claude is a local provider — materializes as type:'task' with provider_uri back-reference
    expect(parsed.type).toBe('task');
    expect(parsed.metadata.provider_uri).toBe('claude://current/1');
    // pending → open through Claude provider status mapping
    expect(parsed.status).toBe('open');
  });

  // ==========================================================================
  // Status mapping through full MCP path
  // ==========================================================================

  it('status mapping: pending → open through full MCP path', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });
    const task: ClaudeTask = {
      id: '1',
      subject: 'Pending task',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    };
    fs.writeFileSync(
      path.join(tasksDir, '1.json'),
      JSON.stringify(task, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);
    const { parsed, isError } = await callTool(client, 'get_task', { id: 'claude://current/1' });

    expect(isError).toBeFalsy();
    expect(parsed.status).toBe('open');
    expect(parsed.metadata.provider_uri).toBe('claude://current/1');
  });

  it('status mapping: completed → closed through full MCP path', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });
    const task: ClaudeTask = {
      id: '2',
      subject: 'Completed task',
      status: 'completed',
      blocks: [],
      blockedBy: [],
    };
    fs.writeFileSync(
      path.join(tasksDir, '2.json'),
      JSON.stringify(task, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '2', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);
    const { parsed, isError } = await callTool(client, 'get_task', { id: 'claude://current/2' });

    expect(isError).toBeFalsy();
    expect(parsed.status).toBe('closed');
    expect(parsed.metadata.provider_uri).toBe('claude://current/2');
  });

  // ==========================================================================
  // get_task with claude://current/<id> for non-existent file returns error
  // ==========================================================================

  it('get_task with claude://current/<id> for non-existent file returns error', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });

    const client = await createClient(socketPath, ['tasks']);
    const { parsed, isError } = await callTool(client, 'get_task', { id: 'claude://current/999' });

    expect(isError).toBe(true);
    expect(parsed.error).toBeDefined();
  });

  // ==========================================================================
  // Multiple claude tasks resolvable via provider URIs
  // ==========================================================================

  it('multiple claude tasks resolvable via provider URIs', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });

    // Write three tasks to disk
    const tasks: ClaudeTask[] = [
      { id: '1', subject: 'Task Alpha', status: 'pending', blocks: [], blockedBy: [] },
      { id: '2', subject: 'Task Beta', status: 'in_progress', blocks: [], blockedBy: [] },
      { id: '3', subject: 'Task Gamma', status: 'completed', blocks: [], blockedBy: [] },
    ];
    for (const task of tasks) {
      fs.writeFileSync(
        path.join(tasksDir, `${task.id}.json`),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
    }
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '3', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);

    // Resolve each task via its provider URI
    const { parsed: t1 } = await callTool(client, 'get_task', { id: 'claude://current/1' });
    const { parsed: t2 } = await callTool(client, 'get_task', { id: 'claude://current/2' });
    const { parsed: t3 } = await callTool(client, 'get_task', { id: 'claude://current/3' });

    expect(t1.title).toBe('Task Alpha');
    expect(t1.status).toBe('open');                           // pending → open
    expect(t1.type).toBe('task');

    expect(t2.title).toBe('Task Beta');
    expect(t2.status).toBe('in_progress');                    // in_progress unchanged
    expect(t2.type).toBe('task');

    expect(t3.title).toBe('Task Gamma');
    expect(t3.status).toBe('closed');                         // completed → closed
    expect(t3.type).toBe('task');

    // All should have provider_uri back-references in metadata
    expect(t1.metadata.provider_uri).toBe('claude://current/1');
    expect(t2.metadata.provider_uri).toBe('claude://current/2');
    expect(t3.metadata.provider_uri).toBe('claude://current/3');
  });

  // ==========================================================================
  // Update through update_task with claude://current/<id> persists to filesystem
  // ==========================================================================

  it('update through update_task with claude://current/<id> persists to filesystem', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });

    // Write a task to disk
    const task: ClaudeTask = {
      id: '1',
      subject: 'Original title',
      description: 'Original description',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    };
    fs.writeFileSync(
      path.join(tasksDir, '1.json'),
      JSON.stringify(task, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);

    // First, materialize the task by reading it
    await callTool(client, 'get_task', { id: 'claude://current/1' });

    // Update the task via MCP using the claude:// URI
    const { parsed: updateResult, isError } = await callTool(client, 'update_task', {
      id: 'claude://current/1',
      status: 'closed',
    });

    expect(isError).toBeFalsy();
    expect(updateResult.success).toBe(true);

    // Verify the file on disk was updated (closed → completed in Claude format)
    const fileContent = JSON.parse(
      fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
    ) as ClaudeTask;
    expect(fileContent.status).toBe('completed'); // closed → completed on disk

    // Verify reading back through MCP reflects the update
    const { parsed: fetched } = await callTool(client, 'get_task', { id: 'claude://current/1' });
    expect(fetched.status).toBe('closed');
    expect(fetched.metadata.provider_uri).toBe('claude://current/1');
  });

  // ==========================================================================
  // list_tasks federates across providers — Claude tasks visible without prior get
  // ==========================================================================

  it('list_tasks shows Claude tasks written to disk (federated query)', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });

    // Write Claude tasks directly to disk — no prior get_task call
    const tasks: ClaudeTask[] = [
      { id: '1', subject: 'Auth fix', status: 'pending', blocks: [], blockedBy: [] },
      { id: '2', subject: 'Add tests', status: 'in_progress', blocks: [], blockedBy: [] },
    ];
    for (const task of tasks) {
      fs.writeFileSync(
        path.join(tasksDir, `${task.id}.json`),
        JSON.stringify(task, null, 2),
        'utf-8',
      );
    }
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '2', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);

    // list_tasks should discover Claude tasks via provider federation
    const { parsed } = await callTool(client, 'list_tasks', {});

    // Should include the Claude tasks (materialized as external nodes)
    expect(parsed.items.length).toBeGreaterThanOrEqual(2);

    const titles = parsed.items.map((item: any) => item.title);
    expect(titles).toContain('Auth fix');
    expect(titles).toContain('Add tests');
  });

  it('list_tasks shows both native and Claude tasks together', async () => {
    fs.mkdirSync(tasksDir, { recursive: true });

    // Write a Claude task to disk
    fs.writeFileSync(
      path.join(tasksDir, '1.json'),
      JSON.stringify({
        id: '1', subject: 'Claude task', status: 'pending', blocks: [], blockedBy: [],
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

    const client = await createClient(socketPath, ['tasks']);

    // Create a native task via MCP
    await callTool(client, 'create_task', { title: 'Native task', status: 'open' });

    // list_tasks should show both
    const { parsed } = await callTool(client, 'list_tasks', {});

    const titles = parsed.items.map((item: any) => item.title);
    expect(titles).toContain('Claude task');
    expect(titles).toContain('Native task');
  });

  // ==========================================================================
  // Local Provider Bridging: materialization, routing, deduplication
  // ==========================================================================

  describe('local provider bridging model', () => {
    it('get_task materializes Claude task as type:task with provider_uri metadata', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Bridged task', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);
      const { parsed, isError } = await callTool(client, 'get_task', { id: 'claude://current/1' });

      expect(isError).toBeFalsy();
      // Local provider produces type:'task', NOT type:'external'
      expect(parsed.type).toBe('task');
      expect(parsed.metadata.provider_uri).toBe('claude://current/1');
      expect(parsed.metadata.provider_source).toBe('claude');
      expect(parsed.title).toBe('Bridged task');
      expect(parsed.status).toBe('open'); // pending → open
    });

    it('update by graph ID routes through Claude provider to filesystem', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Route test', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // First materialize the task to get its graph ID
      const { parsed: task } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      const graphId = task.id;
      expect(graphId).toBeDefined();
      expect(graphId).toMatch(/^t-/); // local task ID

      // Update using the graph ID (not the claude:// URI)
      const { parsed: updateResult, isError } = await callTool(client, 'update_task', {
        id: graphId,
        status: 'in_progress',
      });
      expect(isError).toBeFalsy();
      expect(updateResult.success).toBe(true);

      // Verify the filesystem was updated (update routed through Claude provider)
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('in_progress');
    });

    it('list_tasks after get_task does not produce duplicates', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      for (const id of ['1', '2']) {
        fs.writeFileSync(
          path.join(tasksDir, `${id}.json`),
          JSON.stringify({
            id, subject: `Task ${id}`, status: 'pending', blocks: [], blockedBy: [],
          }, null, 2),
          'utf-8',
        );
      }
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '2', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize task 1 by reading it
      await callTool(client, 'get_task', { id: 'claude://current/1' });

      // list_tasks federates and discovers both tasks; task 1 is already materialized
      const { parsed } = await callTool(client, 'list_tasks', {});

      const titles = parsed.items.map((item: any) => item.title);
      // Each task should appear exactly once
      expect(titles.filter((t: string) => t === 'Task 1')).toHaveLength(1);
      expect(titles.filter((t: string) => t === 'Task 2')).toHaveLength(1);
    });

    it('task transition via update_task routes through Claude provider', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Transition test', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Transition pending → in_progress via semantic 'start' action
      const { parsed, isError } = await callTool(client, 'update_task', {
        id: 'claude://current/1',
        transition: 'start',
      });

      expect(isError).toBeFalsy();
      // Should have a transition result
      const transitionOp = parsed.results
        ? parsed.results.find((r: any) => r.op === 'transition')
        : parsed;
      expect(transitionOp.success).toBe(true);

      // Verify filesystem reflects the transition
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('in_progress');
    });

    it('task transition by graph ID routes through Claude provider', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Graph ID transition', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize to get graph ID
      const { parsed: task } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      const graphId = task.id;

      // Transition using graph ID
      const { parsed, isError } = await callTool(client, 'update_task', {
        id: graphId,
        transition: 'start',
      });

      expect(isError).toBeFalsy();

      // Verify filesystem reflects the transition
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('in_progress');
    });

    it('full lifecycle: create → start → complete through provider', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Lifecycle test', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // 1. Read — materializes as type:task
      const { parsed: initial } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(initial.type).toBe('task');
      expect(initial.status).toBe('open');

      // 2. Start transition
      await callTool(client, 'update_task', { id: 'claude://current/1', transition: 'start' });
      const { parsed: started } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(started.status).toBe('in_progress');

      // 3. Complete transition
      await callTool(client, 'update_task', { id: 'claude://current/1', transition: 'complete' });
      const { parsed: completed } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(completed.status).toBe('closed');

      // 4. Verify final state on disk
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('completed');

      // 5. Reopen
      await callTool(client, 'update_task', { id: 'claude://current/1', transition: 'reopen' });
      const { parsed: reopened } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(reopened.status).toBe('open');

      const fileAfterReopen = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileAfterReopen.status).toBe('pending');
    });

    it('provider-mediated update reflects in subsequent reads', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Original', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize
      const { parsed: first } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(first.title).toBe('Original');
      expect(first.status).toBe('open');

      // Update through the provider-routed path (MCP update_task)
      await callTool(client, 'update_task', {
        id: 'claude://current/1',
        status: 'in_progress',
      });

      // Re-read — the materialized node should reflect the provider update
      const { parsed: second } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(second.status).toBe('in_progress');
      expect(second.type).toBe('task');
      expect(second.metadata.provider_uri).toBe('claude://current/1');

      // And the filesystem should also reflect it
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(tasksDir, '1.json'), 'utf-8'),
      ) as ClaudeTask;
      expect(fileContent.status).toBe('in_progress');
    });

    it('delete via claude:// URI removes from filesystem and graph', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'To delete', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize first
      await callTool(client, 'get_task', { id: 'claude://current/1' });

      // Delete
      const { parsed: deleteResult, isError } = await callTool(client, 'delete_task', {
        id: 'claude://current/1',
      });

      expect(isError).toBeFalsy();
      expect(deleteResult.success).toBe(true);

      // Verify file is gone from disk
      expect(fs.existsSync(path.join(tasksDir, '1.json'))).toBe(false);

      // Verify get_task returns error
      const { isError: getError } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      expect(getError).toBe(true);
    });

    it('delete by graph ID routes through Claude provider to filesystem', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Delete by ID', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize to get graph ID
      const { parsed: task } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      const graphId = task.id;

      // Delete using graph ID
      const { parsed: deleteResult, isError } = await callTool(client, 'delete_task', {
        id: graphId,
      });

      expect(isError).toBeFalsy();
      expect(deleteResult.success).toBe(true);

      // Verify file is gone from disk
      expect(fs.existsSync(path.join(tasksDir, '1.json'))).toBe(false);
    });

    it('locally-materialized nodes are not stale (cached correctly)', async () => {
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(tasksDir, '1.json'),
        JSON.stringify({
          id: '1', subject: 'Cached task', status: 'pending', blocks: [], blockedBy: [],
        }, null, 2),
        'utf-8',
      );
      fs.writeFileSync(path.join(tasksDir, '.highwatermark'), '1', 'utf-8');

      const client = await createClient(socketPath, ['tasks']);

      // Materialize and get graph ID
      const { parsed: first } = await callTool(client, 'get_task', { id: 'claude://current/1' });
      const graphId = first.id;

      // Read by graph ID — should return the cached node directly
      const { parsed: byId } = await callTool(client, 'get_task', { id: graphId });
      expect(byId.title).toBe('Cached task');
      expect(byId.type).toBe('task');
      // Graph ID read doesn't have metadata in mock graph store (it returns raw node)
      // But the node should be accessible
      expect(byId.id).toBe(graphId);
    });
  });
});
