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
  createContextFile: vi.fn(),
  resolveContextFile: vi.fn(),
  checkContextFileDrift: vi.fn(),
  checkContextFileDriftBatch: vi.fn(),
  syncContextFile: vi.fn(),
  eventsSince: vi.fn(),
  eventsCurrent: vi.fn(),
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

    expect(tools).toEqual(['claim_next', 'claim_task', 'create_task', 'delete_task', 'get_task', 'list_providers', 'list_tasks', 'reconcile', 'release_task', 'renew_claim', 'update_task']);
  });

  it('should register graph tools when graph scope enabled', async () => {
    const client = await createTestClient(['tasks', 'graph']);
    const tools = await listToolNames(client);

    expect(tools).toContain('link');
    expect(tools).toContain('query');
    // list_providers is in tasks scope (always available)
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

  it('should register all tools with all scopes', async () => {
    const client = await createTestClient([...ALL_SCOPES]);
    const tools = await listToolNames(client);

    expect(tools).toHaveLength(22);
    expect(tools).toEqual([
      'annotate',
      'claim_next',
      'claim_task',
      'context_summary',
      'create_context',
      'create_task',
      'delete_task',
      'events_since',
      'get_context',
      'get_task',
      'link',
      'list_attempts',
      'list_contexts',
      'list_providers',
      'list_tasks',
      'query',
      'reconcile',
      'record_attempt',
      'release_task',
      'renew_claim',
      'update_context',
      'update_task',
    ]);
  });

  it('should support enabling a single non-tasks scope', async () => {
    const client = await createTestClient(['graph']);
    const tools = await listToolNames(client);

    expect(tools).toEqual(['context_summary', 'events_since', 'link', 'query']);
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

    it('should include description and metadataSchema when present', async () => {
      const providers = [
        {
          name: 'native',
          schemes: ['native'],
          capabilities: { read: true, write: true },
          description: 'Built-in graph store.',
          metadataSchema: {
            fields: {},
            description: 'Accepts arbitrary metadata.',
          },
        },
        {
          name: 'claude',
          schemes: ['claude'],
          capabilities: { read: true, write: true },
          description: 'Claude Code native task system.',
          metadataSchema: {
            fields: {
              tags: { type: 'string[]', description: 'Tags for filtering' },
            },
            description: 'Tags stored in metadata.tags.',
          },
        },
      ];
      mockClient.listProviders.mockResolvedValue(providers);

      const { parsed } = await callTool(client, 'list_providers');

      expect(parsed[0].description).toBe('Built-in graph store.');
      expect(parsed[0].metadataSchema.fields).toEqual({});
      expect(parsed[0].metadataSchema.description).toBe('Accepts arbitrary metadata.');
      expect(parsed[1].metadataSchema.fields.tags.type).toBe('string[]');
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

  describe('events_since', () => {
    it('returns a baseline cursor when no cursor is given', async () => {
      mockClient.eventsCurrent.mockResolvedValue({ epoch: 'e1', seq: 7 });

      const { parsed, isError } = await callTool(client, 'events_since', {});

      expect(isError).toBeFalsy();
      expect(parsed.events).toEqual([]);
      expect(parsed.nextCursor).toEqual({ epoch: 'e1', seq: 7 });
      expect(mockClient.eventsCurrent).toHaveBeenCalled();
    });

    it('returns the delta and a nextCursor for a served cursor', async () => {
      mockClient.eventsSince.mockResolvedValue({
        epoch: 'e1',
        events: [
          { seq: 5, epoch: 'e1', event: { type: 'created', nodeId: 'n5' } },
          { seq: 6, epoch: 'e1', event: { type: 'updated', nodeId: 'n6' } },
        ],
      });

      const { parsed } = await callTool(client, 'events_since', { epoch: 'e1', seq: 4 });

      expect(mockClient.eventsSince).toHaveBeenCalledWith({ epoch: 'e1', seq: 4 });
      expect(parsed.events).toHaveLength(2);
      expect(parsed.nextCursor).toEqual({ epoch: 'e1', seq: 6 });
    });

    it('keeps the input cursor when the delta is empty', async () => {
      mockClient.eventsSince.mockResolvedValue({ epoch: 'e1', events: [] });

      const { parsed } = await callTool(client, 'events_since', { epoch: 'e1', seq: 9 });

      expect(parsed.events).toEqual([]);
      expect(parsed.nextCursor).toEqual({ epoch: 'e1', seq: 9 });
    });

    it('signals resync with a fresh baseline cursor', async () => {
      mockClient.eventsSince.mockResolvedValue({ epoch: 'e2', resync: true });
      mockClient.eventsCurrent.mockResolvedValue({ epoch: 'e2', seq: 3 });

      const { parsed } = await callTool(client, 'events_since', { epoch: 'e1', seq: 100 });

      expect(parsed.resync).toBe(true);
      expect(parsed.nextCursor).toEqual({ epoch: 'e2', seq: 3 });
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
    it('should create an inline context node', async () => {
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

    it('should create a file-backed context with source.type=file', async () => {
      const created = {
        id: 'c-file1',
        type: 'context',
        title: 'src/auth/middleware.ts',
        metadata: { context_file: true, context_file_path: 'src/auth/middleware.ts' },
      };
      mockClient.createContextFile.mockResolvedValue(created);

      const { parsed } = await callTool(client, 'create_context', {
        source: { type: 'file', path: 'src/auth/middleware.ts' },
        tags: ['auth'],
      });

      expect(parsed).toEqual(created);
      expect(mockClient.createContextFile).toHaveBeenCalledWith({
        filePath: 'src/auth/middleware.ts',
        title: undefined,
        tags: ['auth'],
        priority: undefined,
        commit: undefined,
      });
    });

    it('should create a file-backed context pinned to a specific commit', async () => {
      const created = {
        id: 'c-file2',
        type: 'context',
        metadata: { context_file: true, context_file_commit: 'abc123' },
      };
      mockClient.createContextFile.mockResolvedValue(created);

      await callTool(client, 'create_context', {
        title: 'Auth at v1',
        source: { type: 'file', path: 'src/auth.ts', commit: 'abc123' },
      });

      expect(mockClient.createContextFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'src/auth.ts', commit: 'abc123', title: 'Auth at v1' }),
      );
    });

    it('should create a snippet context with source.type=snippet', async () => {
      const created = {
        id: 'c-snip1',
        type: 'context',
        metadata: { context_file: true, context_file_path: 'src/auth.ts' },
      };
      mockClient.createContextFile.mockResolvedValue(created);
      mockClient.updateNode.mockResolvedValue({
        ...created,
        metadata: {
          ...created.metadata,
          context_source: 'snippet',
          context_line_start: 42,
          context_line_end: 58,
        },
      });

      const { parsed } = await callTool(client, 'create_context', {
        source: { type: 'snippet', path: 'src/auth.ts', startLine: 42, endLine: 58 },
      });

      expect(mockClient.createContextFile).toHaveBeenCalled();
      expect(mockClient.updateNode).toHaveBeenCalledWith('c-snip1', {
        metadata: expect.objectContaining({
          context_source: 'snippet',
          context_line_start: 42,
          context_line_end: 58,
        }),
      });
      expect(parsed.metadata.context_source).toBe('snippet');
    });

    it('should return error for inline context without title', async () => {
      const { parsed, isError } = await callTool(client, 'create_context', {
        content: 'Some content without title',
      });

      expect(isError).toBe(true);
      expect(parsed.error).toContain('title is required');
    });

    it('should write top-level kind into metadata.kind for spec-kind contexts', async () => {
      mockClient.createNode.mockResolvedValue({ id: 'c-spec1', type: 'context' });

      await callTool(client, 'create_context', {
        title: 'Auth refactor',
        content: 'OAuth2 with PKCE',
        kind: 'spec',
      });

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'context',
          title: 'Auth refactor',
          content: 'OAuth2 with PKCE',
          metadata: { kind: 'spec' },
        }),
        undefined,
      );
    });

    it('should merge top-level kind with existing metadata (explicit metadata.kind wins)', async () => {
      mockClient.createNode.mockResolvedValue({ id: 'c-merge1', type: 'context' });

      await callTool(client, 'create_context', {
        title: 'Explicit wins',
        kind: 'spec',
        metadata: { kind: 'policy', tags: ['auth'] },
      });

      expect(mockClient.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { kind: 'policy', tags: ['auth'] },
        }),
        undefined,
      );
    });

    it('should patch kind onto file-backed contexts', async () => {
      const created = {
        id: 'c-file-spec',
        type: 'context',
        metadata: { context_file: true, context_file_path: 'specs/auth.md' },
      };
      mockClient.createContextFile.mockResolvedValue(created);
      mockClient.updateNode.mockResolvedValue({
        ...created,
        metadata: { ...created.metadata, kind: 'spec' },
      });

      await callTool(client, 'create_context', {
        source: { type: 'file', path: 'specs/auth.md' },
        kind: 'spec',
      });

      expect(mockClient.updateNode).toHaveBeenCalledWith(
        'c-file-spec',
        expect.objectContaining({
          metadata: expect.objectContaining({ kind: 'spec' }),
        }),
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

    it('should resolve file content when resolve=true for file-backed context', async () => {
      const node = {
        id: 'c-file1',
        type: 'context',
        title: 'middleware.ts',
        metadata: { context_file: true, context_file_path: 'src/auth/middleware.ts' },
      };
      mockClient.getNode.mockResolvedValue(node);
      mockClient.resolveContextFile.mockResolvedValue({
        content: 'export function auth() {}',
        commit: 'abc123',
        contentHash: 'hash1',
        drifted: false,
        filePath: 'src/auth/middleware.ts',
      });

      const { parsed } = await callTool(client, 'get_context', { id: 'c-file1', resolve: true });

      expect(parsed._resolved.content).toBe('export function auth() {}');
      expect(parsed._resolved.drifted).toBe(false);
      expect(mockClient.resolveContextFile).toHaveBeenCalledWith('c-file1', undefined);
    });

    it('should resolve at captured commit when atCapturedCommit=true', async () => {
      const node = {
        id: 'c-file1',
        type: 'context',
        metadata: { context_file: true, context_file_path: 'src/auth.ts' },
      };
      mockClient.getNode.mockResolvedValue(node);
      mockClient.resolveContextFile.mockResolvedValue({
        content: 'old content',
        commit: 'old-sha',
        contentHash: 'oldhash',
        drifted: false,
        filePath: 'src/auth.ts',
      });

      await callTool(client, 'get_context', { id: 'c-file1', resolve: true, atCapturedCommit: true });

      expect(mockClient.resolveContextFile).toHaveBeenCalledWith('c-file1', true);
    });

    it('should return node without resolution when resolve=true for inline context', async () => {
      const node = { id: 'c-abc1', type: 'context', title: 'Spec', content: 'inline content' };
      mockClient.getNode.mockResolvedValue(node);

      const { parsed } = await callTool(client, 'get_context', { id: 'c-abc1', resolve: true });

      expect(parsed).toEqual(node);
      expect(parsed._resolved).toBeUndefined();
      expect(mockClient.resolveContextFile).not.toHaveBeenCalled();
    });

    it('should handle resolve failure gracefully', async () => {
      const node = {
        id: 'c-file1',
        type: 'context',
        metadata: { context_file: true, context_file_path: 'deleted-file.ts' },
      };
      mockClient.getNode.mockResolvedValue(node);
      mockClient.resolveContextFile.mockRejectedValue(new Error('File not found'));

      const { parsed, isError } = await callTool(client, 'get_context', { id: 'c-file1', resolve: true });

      expect(isError).toBeFalsy();
      expect(parsed._resolved.error).toBe('File not found');
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

    it('should sync file-backed context when sync=true', async () => {
      const synced = {
        id: 'c-file1',
        type: 'context',
        metadata: { context_file: true, context_file_commit: 'new-sha' },
      };
      mockClient.syncContextFile.mockResolvedValue(synced);

      const { parsed } = await callTool(client, 'update_context', {
        id: 'c-file1',
        sync: true,
      });

      expect(parsed).toEqual(synced);
      expect(mockClient.syncContextFile).toHaveBeenCalledWith('c-file1', { force: undefined });
    });

    it('should force sync when force=true', async () => {
      mockClient.syncContextFile.mockResolvedValue({ id: 'c-file1' });

      await callTool(client, 'update_context', {
        id: 'c-file1',
        sync: true,
        force: true,
      });

      expect(mockClient.syncContextFile).toHaveBeenCalledWith('c-file1', { force: true });
    });

    it('should handle combined field update + sync', async () => {
      mockClient.updateNode.mockResolvedValue({ id: 'c-file1', title: 'New Title' });
      mockClient.syncContextFile.mockResolvedValue({ id: 'c-file1' });

      const { parsed } = await callTool(client, 'update_context', {
        id: 'c-file1',
        title: 'New Title',
        sync: true,
      });

      expect(parsed.operations).toHaveLength(2);
      expect(parsed.operations[0].op).toBe('update');
      expect(parsed.operations[1].op).toBe('sync');
    });

    it('should return error when no operations specified', async () => {
      const { parsed, isError } = await callTool(client, 'update_context', { id: 'c-abc1' });

      expect(isError).toBe(true);
      expect(parsed.error).toContain('No operations');
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

      expect(parsed.items).toEqual(result.items);
      expect(mockClient.query).toHaveBeenCalledWith({
        nodes: { type: 'context', tags: ['security'], search: 'auth' },
      });
    });

    it('should filter to file-backed contexts with filesOnly=true', async () => {
      const result = {
        items: [
          { id: 'c-1', type: 'context', title: 'Inline', metadata: {} },
          { id: 'c-2', type: 'context', title: 'File', metadata: { context_file: true } },
        ],
        hasMore: false,
      };
      mockClient.query.mockResolvedValue(result);

      const { parsed } = await callTool(client, 'list_contexts', { filesOnly: true });

      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].id).toBe('c-2');
    });

    it('should include drift status when checkDrift=true', async () => {
      const result = {
        items: [
          { id: 'c-1', type: 'context', title: 'File', metadata: { context_file: true } },
          { id: 'c-2', type: 'context', title: 'Inline', metadata: {} },
        ],
        hasMore: false,
      };
      mockClient.query.mockResolvedValue(result);
      mockClient.checkContextFileDriftBatch.mockResolvedValue([
        { drifted: true, currentCommit: 'new', capturedCommit: 'old', currentHash: 'h1', capturedHash: 'h2' },
      ]);

      const { parsed } = await callTool(client, 'list_contexts', { checkDrift: true });

      // File-backed item should have _drift
      const fileItem = parsed.items.find((i: Record<string, unknown>) => i.id === 'c-1');
      expect(fileItem._drift.drifted).toBe(true);

      // Inline item should NOT have _drift
      const inlineItem = parsed.items.find((i: Record<string, unknown>) => i.id === 'c-2');
      expect(inlineItem._drift).toBeUndefined();

      expect(mockClient.checkContextFileDriftBatch).toHaveBeenCalledWith(['c-1']);
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
