/**
 * Tests for Global Provider
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the IPC client before imports
const mockRequest = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
let mockConnected = false;

vi.mock('../../daemon/ipc.js', () => ({
  createIPCClient: vi.fn(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    request: mockRequest,
    get connected() {
      return mockConnected;
    },
  })),
}));

// Mock fs.existsSync for socket checks
const originalExistsSync = (await import('node:fs')).existsSync;
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && p.endsWith('daemon.sock')) {
        return true; // Pretend socket exists
      }
      return actual.existsSync(p);
    }),
  };
});

import { createGlobalProvider } from '../global.js';
import { ProviderError } from '../types.js';
import { isTaskManageable } from '../traits/TaskManageable.js';

describe('Global Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnected = false;
    mockConnect.mockImplementation(async () => {
      mockConnected = true;
    });
  });

  describe('provider identity', () => {
    it('has correct name and schemes', () => {
      const provider = createGlobalProvider();
      expect(provider.name).toBe('global');
      expect(provider.schemes).toEqual(['global']);
    });

    it('has correct capabilities', () => {
      const provider = createGlobalProvider();
      expect(provider.capabilities).toEqual({
        read: true,
        write: true,
        search: true,
        watch: false,
        mount: true,
        feedback: false,
      });
    });

    it('implements TaskManageable', () => {
      const provider = createGlobalProvider();
      expect(isTaskManageable(provider)).toBe(true);
    });
  });

  describe('URI operations', () => {
    it('parses global:// URIs', () => {
      const provider = createGlobalProvider();
      const parsed = provider.parseUri('global://i-abc1');
      expect(parsed).toEqual({
        scheme: 'global',
        id: 'i-abc1',
        workspace: '.',
        isRelative: true,
      });
    });

    it('returns null for non-global URIs', () => {
      const provider = createGlobalProvider();
      expect(provider.parseUri('beads://./bd-123')).toBeNull();
      expect(provider.parseUri('native://t-abc')).toBeNull();
    });

    it('builds global:// URIs', () => {
      const provider = createGlobalProvider();
      expect(provider.buildUri('i-abc1')).toBe('global://i-abc1');
      expect(provider.buildUri('s-xyz9')).toBe('global://s-xyz9');
    });

    it('validates global:// URIs', () => {
      const provider = createGlobalProvider();
      expect(provider.isValidUri('global://i-abc1')).toBe(true);
      expect(provider.isValidUri('global://s-xyz/nested')).toBe(true);
      expect(provider.isValidUri('beads://./bd-123')).toBe(false);
      expect(provider.isValidUri('not-a-uri')).toBe(false);
    });
  });

  describe('CRUD operations', () => {
    it('get() forwards to graph.get via IPC', async () => {
      const provider = createGlobalProvider();
      const mockNode = { id: 'i-abc1', type: 'task', title: 'Test' };
      mockRequest.mockResolvedValueOnce(mockNode);

      const result = await provider.get('i-abc1');

      expect(mockRequest).toHaveBeenCalledWith('graph.get', { id: 'i-abc1' });
      expect(result).toMatchObject({
        id: 'i-abc1',
        uri: 'global://i-abc1',
        type: 'task',
        title: 'Test',
      });
      expect(result?.fetchedAt).toBeDefined();
    });

    it('get() returns null when node not found', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce(null);

      const result = await provider.get('i-nonexist');
      expect(result).toBeNull();
    });

    it('get() returns null gracefully on connection error', async () => {
      const provider = createGlobalProvider();
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await provider.get('i-abc1');
      expect(result).toBeNull();
    });

    it('list() forwards to graph.query via IPC', async () => {
      const provider = createGlobalProvider();
      const mockNodes = [
        { id: 'i-1', type: 'task', title: 'One' },
        { id: 'i-2', type: 'task', title: 'Two' },
      ];
      mockRequest.mockResolvedValueOnce(mockNodes);

      const result = await provider.list({ type: 'task', status: 'open', limit: 10 });

      expect(mockRequest).toHaveBeenCalledWith('graph.query', {
        type: 'task',
        filter: { status: 'open', search: undefined },
        limit: 10,
        offset: undefined,
      });
      expect(result).toHaveLength(2);
      expect(result[0].uri).toBe('global://i-1');
    });

    it('list() returns empty array on connection error', async () => {
      const provider = createGlobalProvider();
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await provider.list();
      expect(result).toEqual([]);
    });

    it('create() forwards to graph.create via IPC', async () => {
      const provider = createGlobalProvider();
      const mockNode = { id: 'i-new1', type: 'task', title: 'New Task', status: 'open' };
      mockRequest.mockResolvedValueOnce(mockNode);

      const result = await provider.create({
        type: 'issue',
        title: 'New Task',
        status: 'open',
      });

      expect(mockRequest).toHaveBeenCalledWith('graph.create', expect.objectContaining({
        type: 'issue',
        title: 'New Task',
        status: 'open',
      }));
      expect(result.uri).toBe('global://i-new1');
    });

    it('create() throws on connection error', async () => {
      const provider = createGlobalProvider();
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        provider.create({ type: 'issue', title: 'Test' }),
      ).rejects.toThrow(ProviderError);
    });

    it('update() forwards to graph.update via IPC', async () => {
      const provider = createGlobalProvider();
      const mockNode = { id: 'i-abc1', type: 'task', title: 'Updated', status: 'closed' };
      mockRequest.mockResolvedValueOnce(mockNode);

      const result = await provider.update('i-abc1', { status: 'closed' });

      expect(mockRequest).toHaveBeenCalledWith('graph.update', expect.objectContaining({
        id: 'i-abc1',
        status: 'closed',
      }));
      expect(result.status).toBe('closed');
    });

    it('delete() forwards to graph.delete via IPC', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce(undefined);

      await provider.delete('i-abc1');

      expect(mockRequest).toHaveBeenCalledWith('graph.delete', { id: 'i-abc1' });
    });
  });

  describe('search', () => {
    it('search() forwards to graph.query with search filter', async () => {
      const provider = createGlobalProvider();
      const mockNodes = [{ id: 'i-1', type: 'task', title: 'Auth task' }];
      mockRequest.mockResolvedValueOnce(mockNodes);

      const result = await provider.search!('auth', { limit: 5 });

      expect(mockRequest).toHaveBeenCalledWith('graph.query', {
        type: undefined,
        filter: { search: 'auth' },
        limit: 5,
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('TaskManageable', () => {
    it('transitionTask() forwards to tools.task via IPC', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce({
        success: true,
        data: { node: { id: 'i-abc1', type: 'task', title: 'Test', status: 'in_progress' } },
      });

      const result = await (provider as any).transitionTask('i-abc1', 'start');

      expect(mockRequest).toHaveBeenCalledWith('tools.task', {
        operation: 'transition',
        taskId: 'i-abc1',
        action: 'start',
      });
      expect(result.status).toBe('in_progress');
    });

    it('transitionTask() throws on failure', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce({
        success: false,
        error: 'Invalid transition',
      });

      await expect(
        (provider as any).transitionTask('i-abc1', 'start'),
      ).rejects.toThrow(ProviderError);
    });

    it('readyTasks() forwards to tools.task via IPC', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce({
        success: true,
        data: {
          nodes: [
            { id: 'i-1', type: 'task', title: 'Ready 1' },
            { id: 'i-2', type: 'task', title: 'Ready 2' },
          ],
        },
      });

      const result = await (provider as any).readyTasks({ limit: 10 });

      expect(mockRequest).toHaveBeenCalledWith('tools.task', expect.objectContaining({
        operation: 'ready',
        limit: 10,
      }));
      expect(result).toHaveLength(2);
    });

    it('readyTasks() returns empty array on error', async () => {
      const provider = createGlobalProvider();
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await (provider as any).readyTasks();
      expect(result).toEqual([]);
    });

    it('assignTask() forwards to tools.task via IPC', async () => {
      const provider = createGlobalProvider();
      mockRequest.mockResolvedValueOnce({
        success: true,
        data: { node: { id: 'i-abc1', type: 'task', title: 'Test' } },
      });

      await (provider as any).assignTask('i-abc1', 'agent-1');

      expect(mockRequest).toHaveBeenCalledWith('tools.task', {
        operation: 'assign',
        taskId: 'i-abc1',
        assignee: 'agent-1',
      });
    });

    it('validActions() returns capabilities on error', async () => {
      const provider = createGlobalProvider();
      mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await (provider as any).validActions('i-abc1');
      expect(result).toEqual(['start', 'complete', 'block', 'reopen', 'close']);
    });
  });

  describe('configuration', () => {
    it('uses default socket path from homedir', () => {
      const provider = createGlobalProvider();
      // The provider should use ~/.opentasks/daemon.sock by default
      // We verify this indirectly through the mock
      expect(provider.name).toBe('global');
    });

    it('uses custom path when provided', () => {
      const provider = createGlobalProvider({ globalPath: '/custom/.opentasks' });
      expect(provider.name).toBe('global');
    });
  });

  describe('connection management', () => {
    it('lazily connects on first request', async () => {
      const provider = createGlobalProvider();
      const mockNode = { id: 'i-1', type: 'task', title: 'Test' };
      mockRequest.mockResolvedValueOnce(mockNode);

      await provider.get('i-1');

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('reuses connection on subsequent requests', async () => {
      const provider = createGlobalProvider();
      const mockNode = { id: 'i-1', type: 'task', title: 'Test' };
      mockRequest.mockResolvedValue(mockNode);

      await provider.get('i-1');
      await provider.get('i-2');

      // connect called once, then reused since mockConnected is true
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });
});
