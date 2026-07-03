/**
 * Tests for Materialization Manager
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMaterializationManager, type MaterializationManager } from '../materialization.js';
import type { GraphStore } from '../../graph/index.js';
import type { ExternalNode, Node } from '../../schema/index.js';
import type { Provider, ProviderNode, ProviderRegistry } from '../types.js';

describe('MaterializationManager', () => {
  let manager: MaterializationManager;
  let mockStore: GraphStore;
  let mockProvider: Provider;
  let mockRegistry: ProviderRegistry;

  // Mock external node
  const createMockExternalNode = (overrides: Partial<ExternalNode> = {}): ExternalNode => ({
    id: 'x-abc1',
    uuid: 'uuid-1',
    type: 'external',
    title: 'External Node',
    uri: 'beads://./bd-123',
    source: 'beads',
    materialized: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  });

  // Mock provider node
  const mockProviderNode: ProviderNode = {
    id: 'bd-123',
    uri: 'beads://./bd-123',
    type: 'issue',
    title: 'Provider Issue',
    content: 'Issue content',
    status: 'open',
    priority: 2,
    rawData: { custom: 'data' },
    fetchedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockStore = {
      getNode: vi.fn(),
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      query: {
        nodes: vi.fn().mockResolvedValue([]),
        edges: vi.fn(),
        blockers: vi.fn(),
        blocking: vi.fn(),
        ready: vi.fn(),
        children: vi.fn(),
        descendants: vi.fn(),
        ancestors: vi.fn(),
        feedback: vi.fn(),
      },
      initialize: vi.fn(),
      close: vi.fn(),
      flush: vi.fn(),
      createEdge: vi.fn(),
      getEdge: vi.fn(),
      deleteEdge: vi.fn(),
      restoreNode: vi.fn(),
      addTags: vi.fn(),
      removeTags: vi.fn(),
      setTags: vi.fn(),
      transaction: vi.fn(),
    } as unknown as GraphStore;

    mockProvider = {
      name: 'beads',
      schemes: ['beads', 'bd'],
      capabilities: {
        read: true,
        write: true,
        search: true,
        watch: false,
        mount: true,
        feedback: false,
      },
      parseUri: vi.fn(),
      buildUri: vi.fn(),
      isValidUri: vi.fn(),
      get: vi.fn().mockResolvedValue(mockProviderNode),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    mockRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn(),
      resolveProvider: vi.fn().mockReturnValue(mockProvider),
      list: vi.fn(),
      canResolve: vi.fn(),
    };

    manager = createMaterializationManager();
  });

  afterEach(() => {
    manager.stopBackgroundSync();
    vi.useRealTimers();
  });

  describe('config', () => {
    it('should use default config', () => {
      expect(manager.config.default).toBe('on-demand');
      expect(manager.config.staleAfter).toBe(5 * 60 * 1000);
    });

    it('should merge custom config', () => {
      const customManager = createMaterializationManager({
        default: 'lazy',
        staleAfter: 60000,
      });

      expect(customManager.config.default).toBe('lazy');
      expect(customManager.config.staleAfter).toBe(60000);
    });
  });

  describe('getStrategyFor', () => {
    it('should return default strategy for unknown URIs', () => {
      expect(manager.getStrategyFor('beads://./bd-123')).toBe('on-demand');
    });

    it('should return provider-specific strategy when configured', () => {
      const customManager = createMaterializationManager({
        default: 'on-demand',
        providers: {
          beads: 'lazy',
          claude: 'eager',
        },
      });

      expect(customManager.getStrategyFor('beads://./bd-123')).toBe('lazy');
      expect(customManager.getStrategyFor('claude://current/42')).toBe('eager');
      expect(customManager.getStrategyFor('native://s-abc1')).toBe('on-demand');
    });
  });

  describe('shouldMaterialize', () => {
    describe('on-demand strategy', () => {
      beforeEach(() => {
        manager = createMaterializationManager({ default: 'on-demand' });
      });

      it('should only materialize when explicit=true', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
            explicit: true,
          }),
        ).toBe(true);

        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
            explicit: false,
          }),
        ).toBe(false);

        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
          }),
        ).toBe(false);
      });
    });

    describe('lazy strategy', () => {
      beforeEach(() => {
        manager = createMaterializationManager({ default: 'lazy' });
      });

      it('should materialize on resolve access', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
          }),
        ).toBe(true);
      });

      it('should materialize when explicit', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'edge-create',
            explicit: true,
          }),
        ).toBe(true);
      });

      it('should not materialize on edge-create without explicit', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'edge-create',
          }),
        ).toBe(false);
      });

      it('should not materialize on query without explicit', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'query',
          }),
        ).toBe(false);
      });
    });

    describe('eager strategy', () => {
      beforeEach(() => {
        manager = createMaterializationManager({ default: 'eager' });
      });

      it('should always materialize', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
          }),
        ).toBe(true);

        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'edge-create',
          }),
        ).toBe(true);

        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'query',
          }),
        ).toBe(true);
      });
    });

    describe('none strategy', () => {
      beforeEach(() => {
        manager = createMaterializationManager({ default: 'none' });
      });

      it('should never materialize', () => {
        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
            explicit: true,
          }),
        ).toBe(false);

        expect(
          manager.shouldMaterialize('beads://./bd-123', {
            accessType: 'resolve',
          }),
        ).toBe(false);
      });
    });
  });

  describe('materialize', () => {
    it('should create new ExternalNode when not exists', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue(
        createMockExternalNode() as unknown as Node,
      );

      await manager.materialize('beads://./bd-123', mockProviderNode, mockStore);

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'beads://./bd-123',
          source: 'beads',
          title: 'Provider Issue',
          content: 'Issue content',
        }),
      );
    });

    it('should update existing ExternalNode when exists', async () => {
      const existingNode = createMockExternalNode();
      vi.mocked(mockStore.query.nodes).mockResolvedValue([existingNode as unknown as Node]);
      vi.mocked(mockStore.updateNode).mockResolvedValue(existingNode as unknown as Node);

      await manager.materialize('beads://./bd-123', mockProviderNode, mockStore);

      expect(mockStore.updateNode).toHaveBeenCalledWith(
        'x-abc1',
        expect.objectContaining({
          title: 'Provider Issue',
          content: 'Issue content',
        }),
      );
    });

    it('should store external_status and external_data in metadata', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue(
        createMockExternalNode() as unknown as Node,
      );

      await manager.materialize('beads://./bd-123', mockProviderNode, mockStore);

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          materialized: true,
          metadata: expect.objectContaining({
            external_status: 'open',
            external_data: { custom: 'data' },
          }),
        }),
      );
    });

    it('should set cached_at timestamp', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue(
        createMockExternalNode() as unknown as Node,
      );

      const _beforeCall = new Date().toISOString();
      await manager.materialize('beads://./bd-123', mockProviderNode, mockStore);

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            cached_at: expect.any(String),
          }),
        }),
      );
    });
  });

  describe('isStale', () => {
    it('should return true if stale flag is set', () => {
      const node = createMockExternalNode({ stale: true });
      expect(manager.isStale(node)).toBe(true);
    });

    it('should return true if cached_at is older than staleAfter', () => {
      const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
      const node = createMockExternalNode({ cached_at: oldTime });

      expect(manager.isStale(node)).toBe(true);
    });

    it('should return false if cached_at is recent', () => {
      const recentTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
      const node = createMockExternalNode({ cached_at: recentTime });

      expect(manager.isStale(node)).toBe(false);
    });

    it('should return true if no cached_at', () => {
      const node = createMockExternalNode({ cached_at: undefined });
      expect(manager.isStale(node)).toBe(true);
    });

    it('should respect custom staleAfter config', () => {
      const customManager = createMaterializationManager({
        staleAfter: 30000, // 30 seconds
      });

      const recentTime = new Date(Date.now() - 20 * 1000).toISOString(); // 20 seconds ago
      const node = createMockExternalNode({ cached_at: recentTime });

      expect(customManager.isStale(node)).toBe(false);

      const olderTime = new Date(Date.now() - 40 * 1000).toISOString(); // 40 seconds ago
      const olderNode = createMockExternalNode({ cached_at: olderTime });

      expect(customManager.isStale(olderNode)).toBe(true);
    });
  });

  describe('refresh', () => {
    it('should fetch from provider and update node', async () => {
      const node = createMockExternalNode();
      vi.mocked(mockProvider.get).mockResolvedValue(mockProviderNode);
      vi.mocked(mockStore.query.nodes).mockResolvedValue([node as unknown as Node]);
      vi.mocked(mockStore.updateNode).mockResolvedValue(node as unknown as Node);

      await manager.refresh(node, mockProvider, mockStore);

      expect(mockProvider.get).toHaveBeenCalledWith('beads://./bd-123', undefined);
      expect(mockStore.updateNode).toHaveBeenCalled();
    });

    it('should return null if node not found in provider', async () => {
      const node = createMockExternalNode();
      vi.mocked(mockProvider.get).mockResolvedValue(null);
      vi.mocked(mockStore.updateNode).mockResolvedValue(node as unknown as Node);

      const result = await manager.refresh(node, mockProvider, mockStore);

      expect(result).toBeNull();
      expect(mockStore.updateNode).toHaveBeenCalledWith(
        'x-abc1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            stale: true,
            last_refresh_error: 'Node not found in provider',
          }),
        }),
      );
    });

    it('should mark as stale on error', async () => {
      const node = createMockExternalNode();
      vi.mocked(mockProvider.get).mockRejectedValue(new Error('Network error'));
      vi.mocked(mockStore.updateNode).mockResolvedValue(node as unknown as Node);

      const result = await manager.refresh(node, mockProvider, mockStore);

      expect(result).toBeNull();
      expect(mockStore.updateNode).toHaveBeenCalledWith(
        'x-abc1',
        expect.objectContaining({
          metadata: expect.objectContaining({
            stale: true,
            last_refresh_error: 'Network error',
          }),
        }),
      );
    });
  });

  describe('background sync', () => {
    it('should not start if backgroundSyncInterval is 0', () => {
      const noSyncManager = createMaterializationManager({
        backgroundSyncInterval: 0,
      });

      noSyncManager.startBackgroundSync(mockStore, mockRegistry);

      expect(noSyncManager.isBackgroundSyncRunning()).toBe(false);
    });

    it('should start and stop background sync', () => {
      const syncManager = createMaterializationManager({
        backgroundSyncInterval: 1000,
      });

      syncManager.startBackgroundSync(mockStore, mockRegistry);
      expect(syncManager.isBackgroundSyncRunning()).toBe(true);

      syncManager.stopBackgroundSync();
      expect(syncManager.isBackgroundSyncRunning()).toBe(false);
    });

    it('should not start twice', () => {
      const syncManager = createMaterializationManager({
        backgroundSyncInterval: 1000,
      });

      syncManager.startBackgroundSync(mockStore, mockRegistry);
      syncManager.startBackgroundSync(mockStore, mockRegistry);

      expect(syncManager.isBackgroundSyncRunning()).toBe(true);

      syncManager.stopBackgroundSync();
    });

    it('should find and refresh stale nodes on interval', async () => {
      const staleNode = createMockExternalNode({
        cached_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      vi.mocked(mockStore.query.nodes).mockResolvedValue([staleNode as unknown as Node]);
      vi.mocked(mockProvider.get).mockResolvedValue(mockProviderNode);
      vi.mocked(mockStore.updateNode).mockResolvedValue(staleNode as unknown as Node);

      const syncManager = createMaterializationManager({
        backgroundSyncInterval: 1000,
        staleAfter: 5 * 60 * 1000,
      });

      syncManager.startBackgroundSync(mockStore, mockRegistry);

      // Advance timer to trigger sync
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockStore.query.nodes).toHaveBeenCalledWith({ type: 'external' });
      expect(mockRegistry.resolveProvider).toHaveBeenCalledWith('beads://./bd-123');

      syncManager.stopBackgroundSync();
    });

    it('should skip non-materialized nodes', async () => {
      const nonMaterializedNode = createMockExternalNode({
        materialized: false,
        cached_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      vi.mocked(mockStore.query.nodes).mockResolvedValue([nonMaterializedNode as unknown as Node]);

      const syncManager = createMaterializationManager({
        backgroundSyncInterval: 1000,
      });

      syncManager.startBackgroundSync(mockStore, mockRegistry);

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockProvider.get).not.toHaveBeenCalled();

      syncManager.stopBackgroundSync();
    });
  });

  describe('local materialization', () => {
    const claudeProviderNode: ProviderNode = {
      id: '1',
      uri: 'claude://current/1',
      type: 'task',
      title: 'Fix auth',
      content: 'Fix auth token expiry',
      status: 'open',
      priority: 2,
      rawData: { subject: 'Fix auth' },
      fetchedAt: '2024-01-01T00:00:00.000Z',
    };

    const specProviderNode: ProviderNode = {
      id: 's-1',
      uri: 'sudocode://proj/s-1',
      type: 'spec',
      title: 'Auth Spec',
      content: 'Spec content',
      status: 'active',
      rawData: {},
      fetchedAt: '2024-01-01T00:00:00.000Z',
    };

    it('should create type:task node with provider_uri for local provider', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      const createdNode = {
        id: 't-abc1',
        uuid: 'uuid-2',
        type: 'task' as const,
        title: 'Fix auth',
        status: 'open',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        metadata: { provider_uri: 'claude://current/1', provider_source: 'claude' },
      };
      vi.mocked(mockStore.createNode).mockResolvedValue(createdNode as unknown as Node);

      await manager.materialize('claude://current/1', claudeProviderNode, mockStore, {
        local: true,
      });

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task',
          title: 'Fix auth',
          status: 'open',
          metadata: expect.objectContaining({
            provider_uri: 'claude://current/1',
            provider_source: 'claude',
            provider_authoritative: true,
            provider_cached_at: expect.any(String),
          }),
        }),
      );
    });

    it('should create type:context node for spec provider nodes', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue({
        id: 's-abc1',
        type: 'context',
        title: 'Auth Spec',
      } as unknown as Node);

      await manager.materialize('sudocode://proj/s-1', specProviderNode, mockStore, {
        local: true,
      });

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'context',
          title: 'Auth Spec',
          metadata: expect.objectContaining({
            provider_uri: 'sudocode://proj/s-1',
            provider_source: 'sudocode',
            provider_authoritative: true,
            provider_cached_at: expect.any(String),
          }),
        }),
      );
    });

    it('should update existing local-provider node in place', async () => {
      const existingNode = {
        id: 't-abc1',
        type: 'task' as const,
        title: 'Fix auth (old)',
        metadata: { provider_uri: 'claude://current/1', provider_source: 'claude' },
      };
      vi.mocked(mockStore.query.nodes).mockResolvedValue([existingNode as unknown as Node]);
      vi.mocked(mockStore.updateNode).mockResolvedValue(existingNode as unknown as Node);

      await manager.materialize('claude://current/1', claudeProviderNode, mockStore, {
        local: true,
      });

      expect(mockStore.updateNode).toHaveBeenCalledWith(
        't-abc1',
        expect.objectContaining({
          title: 'Fix auth',
          status: 'open',
          metadata: expect.objectContaining({
            provider_uri: 'claude://current/1',
            provider_source: 'claude',
          }),
        }),
      );
      // Should NOT create a new node
      expect(mockStore.createNode).not.toHaveBeenCalled();
    });

    it('should create type:external for remote provider (local=false)', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue(
        createMockExternalNode() as unknown as Node,
      );

      await manager.materialize('jira://PROJ-123', mockProviderNode, mockStore, {
        local: false,
      });

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'jira://PROJ-123',
        }),
      );
    });

    it('should create type:external when local option not provided', async () => {
      vi.mocked(mockStore.query.nodes).mockResolvedValue([]);
      vi.mocked(mockStore.createNode).mockResolvedValue(
        createMockExternalNode() as unknown as Node,
      );

      await manager.materialize('beads://./bd-123', mockProviderNode, mockStore);

      expect(mockStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
        }),
      );
    });
  });

  describe('provider strategy overrides', () => {
    it('should use provider-specific strategies', () => {
      const multiStrategyManager = createMaterializationManager({
        default: 'on-demand',
        providers: {
          beads: 'eager',
          claude: 'lazy',
        },
      });

      // Beads should always materialize (eager)
      expect(
        multiStrategyManager.shouldMaterialize('beads://./bd-123', {
          accessType: 'query',
        }),
      ).toBe(true);

      // Claude should materialize on resolve (lazy)
      expect(
        multiStrategyManager.shouldMaterialize('claude://current/42', {
          accessType: 'resolve',
        }),
      ).toBe(true);

      expect(
        multiStrategyManager.shouldMaterialize('claude://current/42', {
          accessType: 'query',
        }),
      ).toBe(false);

      // Native should only materialize on explicit (on-demand)
      expect(
        multiStrategyManager.shouldMaterialize('native://s-abc1', {
          accessType: 'resolve',
        }),
      ).toBe(false);

      expect(
        multiStrategyManager.shouldMaterialize('native://s-abc1', {
          accessType: 'resolve',
          explicit: true,
        }),
      ).toBe(true);
    });
  });
});
