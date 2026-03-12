/**
 * Tests for OpenTasks MCP Server
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMCPServer, ALL_SCOPES, type MCPScope } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ============================================================================
// Mock the OpenTasksClient
// ============================================================================

const mockClient = {
  link: vi.fn(),
  query: vi.fn(),
  annotate: vi.fn(),
  task: vi.fn(),
  createNode: vi.fn(),
  getNode: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  listProviders: vi.fn(),
};

vi.mock('../../client/client.js', () => {
  return {
    OpenTasksClient: function () {
      return mockClient;
    },
  };
});

// ============================================================================
// Helpers
// ============================================================================

async function createTestClient(scopes?: MCPScope[]) {
  const server = createMCPServer({ scopes });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return client;
}

async function listToolNames(client: Client): Promise<string[]> {
  const result = await client.listTools();
  return result.tools.map((t) => t.name).sort();
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
// Scope Registration Tests
// ============================================================================

describe('MCP Server - Scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register only task tools by default', async () => {
    const client = await createTestClient();
    const tools = await listToolNames(client);

    expect(tools).toEqual(['create_task', 'delete_task', 'get_task', 'list_tasks', 'update_task']);
  });

  it('should register graph tools when graph scope enabled', async () => {
    const client = await createTestClient(['tasks', 'graph']);
    const tools = await listToolNames(client);

    expect(tools).toContain('link');
    expect(tools).toContain('query');
    expect(tools).toContain('list_providers');
    // Should still have task tools
    expect(tools).toContain('create_task');
  });

  it('should register annotate tool when annotate scope enabled', async () => {
    const client = await createTestClient(['tasks', 'annotate']);
    const tools = await listToolNames(client);

    expect(tools).toContain('annotate');
    expect(tools).toContain('create_task');
  });

  it('should register context tools when context scope enabled', async () => {
    const client = await createTestClient(['tasks', 'context']);
    const tools = await listToolNames(client);

    expect(tools).toContain('create_context');
    expect(tools).toContain('get_context');
    expect(tools).toContain('update_context');
    expect(tools).toContain('list_contexts');
  });

  it('should register all 13 tools with all scopes', async () => {
    const client = await createTestClient([...ALL_SCOPES]);
    const tools = await listToolNames(client);

    expect(tools).toHaveLength(13);
    expect(tools).toEqual([
      'annotate',
      'create_context',
      'create_task',
      'delete_task',
      'get_context',
      'get_task',
      'link',
      'list_contexts',
      'list_providers',
      'list_tasks',
      'query',
      'update_context',
      'update_task',
    ]);
  });

  it('should support enabling a single non-tasks scope', async () => {
    const client = await createTestClient(['graph']);
    const tools = await listToolNames(client);

    expect(tools).toEqual(['link', 'list_providers', 'query']);
    expect(tools).not.toContain('create_task');
  });
});

// ============================================================================
// Task Tools Tests
// ============================================================================

describe('MCP Server - Task Tools', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  describe('create_task', () => {
    it('should create a task node', async () => {
      const createdNode = { id: 't-abc1', type: 'task', title: 'My Task', status: 'open' };
      mockClient.createNode.mockResolvedValue(createdNode);

      const { parsed } = await callTool(client, 'create_task', {
        title: 'My Task',
        status: 'open',
        priority: 1,
        tags: ['backend'],
      });

      expect(parsed).toEqual(createdNode);
      expect(mockClient.createNode).toHaveBeenCalledWith(
        { type: 'task', title: 'My Task', status: 'open', priority: 1, tags: ['backend'] },
        undefined,
      );
    });

    it('should route to provider when scheme specified', async () => {
      mockClient.createNode.mockResolvedValue({ id: 'x-ext1' });

      await callTool(client, 'create_task', {
        title: 'External Task',
        scheme: 'beads',
      });

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task', title: 'External Task' }),
        { scheme: 'beads' },
      );
    });

    it('should return error on failure', async () => {
      mockClient.createNode.mockRejectedValue(new Error('Connection refused'));

      const { parsed, isError } = await callTool(client, 'create_task', { title: 'Fail' });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Connection refused');
    });
  });

  describe('get_task', () => {
    it('should get a task by ID', async () => {
      const node = { id: 't-abc1', type: 'task', title: 'My Task' };
      mockClient.getNode.mockResolvedValue(node);

      const { parsed } = await callTool(client, 'get_task', { id: 't-abc1' });

      expect(parsed).toEqual(node);
      expect(mockClient.getNode).toHaveBeenCalledWith('t-abc1');
    });

    it('should get a task by provider URI', async () => {
      const node = { id: 'x-ext1', type: 'external', title: 'Beads Task' };
      mockClient.getNode.mockResolvedValue(node);

      const { parsed } = await callTool(client, 'get_task', { id: 'beads://project/i-123' });

      expect(parsed).toEqual(node);
      expect(mockClient.getNode).toHaveBeenCalledWith('beads://project/i-123');
    });

    it('should return error when not found', async () => {
      mockClient.getNode.mockResolvedValue(null);

      const { parsed, isError } = await callTool(client, 'get_task', { id: 't-missing' });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Task not found');
    });
  });

  describe('update_task', () => {
    it('should update task fields', async () => {
      const updated = { id: 't-abc1', title: 'Updated', status: 'open' };
      mockClient.updateNode.mockResolvedValue(updated);

      const { parsed } = await callTool(client, 'update_task', {
        id: 't-abc1',
        title: 'Updated',
        priority: 0,
      });

      expect(parsed.op).toBe('update');
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual(updated);
      expect(mockClient.updateNode).toHaveBeenCalledWith('t-abc1', {
        title: 'Updated',
        priority: 0,
      });
    });

    it('should apply semantic transition', async () => {
      const transitionResult = {
        success: true,
        data: { type: 'transition', node: { id: 't-abc1' }, provider: 'native', action: 'start' },
      };
      mockClient.task.mockResolvedValue(transitionResult);

      const { parsed } = await callTool(client, 'update_task', {
        id: 't-abc1',
        transition: 'start',
      });

      expect(mockClient.task).toHaveBeenCalledWith({
        transition: { id: 't-abc1', action: 'start' },
      });
      expect(parsed.op).toBe('transition');
      expect(parsed.success).toBe(true);
      expect(parsed.result).toEqual(transitionResult);
    });

    it('should add blockers via link', async () => {
      mockClient.link.mockResolvedValue({ success: true, edgeId: 'x-edge1' });

      const { parsed } = await callTool(client, 'update_task', {
        id: 't-abc1',
        addBlockedBy: ['t-blocker1', 't-blocker2'],
      });

      expect(mockClient.link).toHaveBeenCalledTimes(2);
      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 't-blocker1',
        toId: 't-abc1',
        type: 'blocks',
      });
      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 't-blocker2',
        toId: 't-abc1',
        type: 'blocks',
      });
    });

    it('should remove blockers via link with remove flag', async () => {
      mockClient.link.mockResolvedValue({ success: true });

      await callTool(client, 'update_task', {
        id: 't-abc1',
        removeBlockedBy: ['t-blocker1'],
      });

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 't-blocker1',
        toId: 't-abc1',
        type: 'blocks',
        remove: true,
      });
    });

    it('should add blocks (this task blocks others)', async () => {
      mockClient.link.mockResolvedValue({ success: true, edgeId: 'x-edge1' });

      await callTool(client, 'update_task', {
        id: 't-abc1',
        addBlocks: ['t-downstream1'],
      });

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 't-abc1',
        toId: 't-downstream1',
        type: 'blocks',
      });
    });

    it('should handle combined field update + transition + blockers', async () => {
      const updated = { id: 't-abc1', title: 'Updated' };
      mockClient.updateNode.mockResolvedValue(updated);
      mockClient.task.mockResolvedValue({ success: true, data: { type: 'transition' } });
      mockClient.link.mockResolvedValue({ success: true });

      const { parsed } = await callTool(client, 'update_task', {
        id: 't-abc1',
        title: 'Updated',
        transition: 'start',
        addBlockedBy: ['t-dep1'],
      });

      expect(mockClient.updateNode).toHaveBeenCalled();
      expect(mockClient.task).toHaveBeenCalled();
      expect(mockClient.link).toHaveBeenCalled();
      expect(parsed.operations).toHaveLength(3);
      expect(parsed.operations.every((op: any) => op.success)).toBe(true);
    });

    it('should report partial failure without crashing', async () => {
      mockClient.updateNode.mockResolvedValue({ id: 't-abc1', title: 'Updated' });
      mockClient.task.mockRejectedValue(new Error('Provider not available'));

      const { parsed, isError } = await callTool(client, 'update_task', {
        id: 't-abc1',
        title: 'Updated',
        transition: 'start',
      });

      expect(isError).toBe(true);
      expect(parsed.operations).toHaveLength(2);
      expect(parsed.operations[0].op).toBe('update');
      expect(parsed.operations[0].success).toBe(true);
      expect(parsed.operations[1].op).toBe('transition');
      expect(parsed.operations[1].success).toBe(false);
      expect(parsed.operations[1].error).toBe('Provider not available');
    });
  });

  describe('delete_task', () => {
    it('should delete a task by local ID', async () => {
      mockClient.deleteNode.mockResolvedValue(undefined);

      const { parsed, isError } = await callTool(client, 'delete_task', { id: 't-abc1' });

      expect(isError).toBeFalsy();
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('t-abc1');
      expect(mockClient.deleteNode).toHaveBeenCalledWith('t-abc1');
    });

    it('should delete a task by provider URI', async () => {
      mockClient.deleteNode.mockResolvedValue(undefined);

      const { parsed, isError } = await callTool(client, 'delete_task', { id: 'beads://project/i-123' });

      expect(isError).toBeFalsy();
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('beads://project/i-123');
      expect(mockClient.deleteNode).toHaveBeenCalledWith('beads://project/i-123');
    });

    it('should return error when delete fails', async () => {
      mockClient.deleteNode.mockRejectedValue(new Error('Node not found: t-missing'));

      const { parsed, isError } = await callTool(client, 'delete_task', { id: 't-missing' });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Node not found: t-missing');
    });
  });

  describe('list_tasks', () => {
    it('should list tasks with filters', async () => {
      const queryResult = {
        items: [{ id: 't-1', type: 'task', title: 'Task 1', status: 'open', archived: false }],
        hasMore: false,
      };
      mockClient.query.mockResolvedValue(queryResult);

      const { parsed } = await callTool(client, 'list_tasks', {
        status: 'open',
        tags: ['backend'],
      });

      expect(parsed).toEqual(queryResult);
      expect(mockClient.query).toHaveBeenCalledWith({
        nodes: expect.objectContaining({ type: 'task', status: 'open', tags: ['backend'] }),
      });
    });

    it('should query ready tasks via task tool', async () => {
      const readyResult = {
        success: true,
        data: { type: 'ready', items: [{ id: 't-1' }], total: 1 },
      };
      mockClient.task.mockResolvedValue(readyResult);

      const { parsed } = await callTool(client, 'list_tasks', {
        ready: true,
        tags: ['urgent'],
      });

      expect(parsed).toEqual(readyResult);
      expect(mockClient.task).toHaveBeenCalledWith({
        ready: expect.objectContaining({ tags: ['urgent'] }),
      });
    });

    it('should query blockers of a task', async () => {
      const blockerResult = {
        items: [{ id: 't-blocker', type: 'task', title: 'Blocker' }],
        hasMore: false,
      };
      mockClient.query.mockResolvedValue(blockerResult);

      const { parsed } = await callTool(client, 'list_tasks', {
        blockersOf: 't-abc1',
      });

      expect(parsed).toEqual(blockerResult);
      expect(mockClient.query).toHaveBeenCalledWith({
        blockers: { nodeId: 't-abc1' },
      });
    });

    it('should query tasks blocked by a task', async () => {
      mockClient.query.mockResolvedValue({ items: [], hasMore: false });

      await callTool(client, 'list_tasks', { blockedBy: 't-abc1' });

      expect(mockClient.query).toHaveBeenCalledWith({
        blocking: { nodeId: 't-abc1' },
      });
    });

    it('should support provider filtering for ready queries', async () => {
      mockClient.task.mockResolvedValue({ success: true, data: { type: 'ready', items: [], total: 0 } });

      await callTool(client, 'list_tasks', {
        ready: true,
        providers: ['beads', 'native'],
      });

      expect(mockClient.task).toHaveBeenCalledWith({
        ready: expect.objectContaining({ providers: ['beads', 'native'] }),
      });
    });
  });
});

// ============================================================================
// Graph Tools Tests
// ============================================================================

describe('MCP Server - Graph Tools', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient(['graph']);
  });

  describe('link', () => {
    it('should create an edge', async () => {
      mockClient.link.mockResolvedValue({ success: true, edgeId: 'x-edge1' });

      const { parsed, isError } = await callTool(client, 'link', {
        fromId: 't-abc1',
        toId: 'c-def2',
        type: 'implements',
      });

      expect(isError).toBeFalsy();
      expect(parsed.success).toBe(true);
      expect(parsed.edgeId).toBe('x-edge1');
      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 't-abc1',
        toId: 'c-def2',
        type: 'implements',
      });
    });

    it('should remove an edge', async () => {
      mockClient.link.mockResolvedValue({ success: true });

      const { parsed } = await callTool(client, 'link', {
        fromId: 't-abc1',
        toId: 'c-def2',
        type: 'implements',
        remove: true,
      });

      expect(parsed.success).toBe(true);
      expect(mockClient.link).toHaveBeenCalledWith(
        expect.objectContaining({ remove: true }),
      );
    });

    it('should support provider URIs', async () => {
      mockClient.link.mockResolvedValue({ success: true, edgeId: 'x-edge1' });

      await callTool(client, 'link', {
        fromId: 'beads://project/i-123',
        toId: 'sudocode://proj/s-456',
        type: 'references',
      });

      expect(mockClient.link).toHaveBeenCalledWith({
        fromId: 'beads://project/i-123',
        toId: 'sudocode://proj/s-456',
        type: 'references',
      });
    });

    it('should return error on failure', async () => {
      mockClient.link.mockResolvedValue({ success: false, error: 'Cycle detected' });

      const { parsed, isError } = await callTool(client, 'link', {
        fromId: 't-1',
        toId: 't-2',
        type: 'blocks',
      });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Cycle detected');
    });
  });

  describe('query', () => {
    it('should query nodes', async () => {
      const queryResult = { items: [{ id: 't-1', type: 'task', title: 'T1' }], hasMore: false };
      mockClient.query.mockResolvedValue(queryResult);

      const { parsed } = await callTool(client, 'query', {
        nodes: { type: 'task', status: 'open' },
      });

      expect(parsed).toEqual(queryResult);
    });

    it('should query edges', async () => {
      mockClient.query.mockResolvedValue({ items: [], hasMore: false });

      await callTool(client, 'query', {
        edges: { type: 'blocks', from_id: 't-1' },
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.objectContaining({ edges: { type: 'blocks', from_id: 't-1' } }),
      );
    });
  });

  describe('list_providers', () => {
    it('should list providers', async () => {
      const providers = [
        { name: 'native', schemes: ['native', 'opentasks'], capabilities: { read: true, write: true } },
        { name: 'beads', schemes: ['beads'], capabilities: { read: true, write: true } },
      ];
      mockClient.listProviders.mockResolvedValue(providers);

      const { parsed } = await callTool(client, 'list_providers');

      expect(parsed).toEqual(providers);
    });
  });
});

// ============================================================================
// Annotate Tool Tests
// ============================================================================

describe('MCP Server - Annotate Tool', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient(['annotate']);
  });

  it('should create feedback', async () => {
    mockClient.annotate.mockResolvedValue({ success: true, feedbackId: 'f-abc1' });

    const { parsed } = await callTool(client, 'annotate', {
      targetId: 'c-def2',
      create: { content: 'Looks good!', type: 'comment' },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.feedbackId).toBe('f-abc1');
  });

  it('should resolve feedback', async () => {
    mockClient.annotate.mockResolvedValue({ success: true, feedbackId: 'f-abc1' });

    await callTool(client, 'annotate', {
      targetId: 'c-def2',
      resolve: 'f-abc1',
    });

    expect(mockClient.annotate).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'c-def2', resolve: 'f-abc1' }),
    );
  });

  it('should return error on failure', async () => {
    mockClient.annotate.mockResolvedValue({ success: false, error: 'Target not found' });

    const { parsed, isError } = await callTool(client, 'annotate', {
      targetId: 'c-missing',
      create: { content: 'test' },
    });

    expect(isError).toBe(true);
    expect(parsed.error).toBe('Target not found');
  });
});

// ============================================================================
// Context Tools Tests
// ============================================================================

describe('MCP Server - Context Tools', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient(['context']);
  });

  describe('create_context', () => {
    it('should create a context node', async () => {
      const created = { id: 'c-abc1', type: 'context', title: 'Auth Spec' };
      mockClient.createNode.mockResolvedValue(created);

      const { parsed } = await callTool(client, 'create_context', {
        title: 'Auth Spec',
        content: '# Auth Requirements\n...',
        tags: ['security'],
      });

      expect(parsed).toEqual(created);
      expect(mockClient.createNode).toHaveBeenCalledWith(
        { type: 'context', title: 'Auth Spec', content: '# Auth Requirements\n...', tags: ['security'] },
        undefined,
      );
    });

    it('should route to provider when scheme specified', async () => {
      mockClient.createNode.mockResolvedValue({ id: 'x-ext1' });

      await callTool(client, 'create_context', {
        title: 'External Spec',
        scheme: 'sudocode',
      });

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'context' }),
        { scheme: 'sudocode' },
      );
    });
  });

  describe('get_context', () => {
    it('should get a context by ID', async () => {
      const node = { id: 'c-abc1', type: 'context', title: 'Spec' };
      mockClient.getNode.mockResolvedValue(node);

      const { parsed } = await callTool(client, 'get_context', { id: 'c-abc1' });

      expect(parsed).toEqual(node);
    });

    it('should return error when not found', async () => {
      mockClient.getNode.mockResolvedValue(null);

      const { parsed, isError } = await callTool(client, 'get_context', { id: 'c-missing' });

      expect(isError).toBe(true);
      expect(parsed.error).toBe('Context not found');
    });
  });

  describe('update_context', () => {
    it('should update context fields', async () => {
      const updated = { id: 'c-abc1', title: 'Updated Spec' };
      mockClient.updateNode.mockResolvedValue(updated);

      const { parsed } = await callTool(client, 'update_context', {
        id: 'c-abc1',
        title: 'Updated Spec',
        content: 'New content',
      });

      expect(parsed).toEqual(updated);
      expect(mockClient.updateNode).toHaveBeenCalledWith('c-abc1', {
        title: 'Updated Spec',
        content: 'New content',
      });
    });
  });

  describe('list_contexts', () => {
    it('should list contexts with filters', async () => {
      const result = { items: [{ id: 'c-1', type: 'context', title: 'Spec 1' }], hasMore: false };
      mockClient.query.mockResolvedValue(result);

      const { parsed } = await callTool(client, 'list_contexts', {
        tags: ['security'],
        search: 'auth',
      });

      expect(parsed).toEqual(result);
      expect(mockClient.query).toHaveBeenCalledWith({
        nodes: { type: 'context', tags: ['security'], search: 'auth' },
      });
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('MCP Server - Error Handling', () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient([...ALL_SCOPES]);
  });

  it('should handle connection errors gracefully', async () => {
    mockClient.query.mockRejectedValue(new Error('Connection refused'));

    const { parsed, isError } = await callTool(client, 'list_tasks', {});

    expect(isError).toBe(true);
    expect(parsed.error).toBe('Connection refused');
  });

  it('should handle unexpected errors', async () => {
    mockClient.getNode.mockRejectedValue('raw string error');

    const { parsed, isError } = await callTool(client, 'get_task', { id: 't-1' });

    expect(isError).toBe(true);
    expect(parsed.error).toBe('raw string error');
  });
});
