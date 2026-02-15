/**
 * Tests for Provider-Aware Graph Store
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createProviderAwareStore, type ProviderAwareStore } from '../provider-store.js';
import type { GraphStore } from '../store.js';
import type { Node, ExternalNode, Context, Task } from '../../schema/index.js';
import type { Provider, ProviderNode, ProviderRegistry } from '../../providers/types.js';
import { ProviderError } from '../../providers/types.js';
import { createProviderRegistry } from '../../providers/registry.js';
import type {
  TaskManageable,
  TaskAction,
  TaskCapabilities,
} from '../../providers/traits/TaskManageable.js';

describe('ProviderAwareStore', () => {
  let baseStore: GraphStore;
  let providerStore: ProviderAwareStore;
  let mockBeadsProvider: Provider;

  // Mock nodes
  const mockContext: Context = {
    id: 'c-abc1',
    uuid: 'uuid-1',
    type: 'context',
    title: 'Test Context',
    content: 'Context content',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };

  const mockExternalNode: ExternalNode = {
    id: 'x-ext1',
    uuid: 'uuid-ext-1',
    type: 'external',
    title: 'External Issue',
    uri: 'beads://./bd-123',
    source: 'beads',
    materialized: true,
    cached_at: new Date().toISOString(),
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  };

  const mockProviderNode: ProviderNode = {
    id: 'bd-123',
    uri: 'beads://./bd-123',
    type: 'issue',
    title: 'Beads Issue',
    content: 'Issue content',
    status: 'open',
    priority: 2,
    rawData: { custom: 'data' },
    fetchedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.useFakeTimers();

    // Create mock base store
    baseStore = {
      getNode: vi.fn(),
      createNode: vi.fn(),
      updateNode: vi.fn(),
      deleteNode: vi.fn(),
      query: {
        nodes: vi.fn().mockResolvedValue([]),
        edges: vi.fn(),
        blockers: vi.fn(),
        blocking: vi.fn(),
        ready: vi.fn().mockResolvedValue([]),
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

    // Create mock beads provider
    mockBeadsProvider = {
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
      parseUri: vi.fn((uri: string) => {
        if (uri.startsWith('beads://') || uri.startsWith('bd://')) {
          const id = uri.split('/').pop() || '';
          return { scheme: 'beads', id, isRelative: uri.includes('/.') };
        }
        return null;
      }),
      buildUri: vi.fn((id: string) => `beads://./${id}`),
      isValidUri: vi.fn((uri: string) => uri.startsWith('beads://') || uri.startsWith('bd://')),
      get: vi.fn().mockResolvedValue(mockProviderNode),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    // Create provider store
    providerStore = createProviderAwareStore(baseStore);
  });

  afterEach(() => {
    providerStore.stopBackgroundSync();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should have providers registry', () => {
      expect(providerStore.providers).toBeDefined();
      expect(providerStore.providers.list).toBeDefined();
    });

    it('should have materialization manager', () => {
      expect(providerStore.materialization).toBeDefined();
      expect(providerStore.materialization.config).toBeDefined();
    });

    it('should auto-register native provider', () => {
      const nativeProvider = providerStore.providers.get('native');
      expect(nativeProvider).toBeDefined();
      expect(nativeProvider?.name).toBe('native');
    });

    it('should not auto-register native provider when disabled', () => {
      const storeWithoutNative = createProviderAwareStore(baseStore, {
        autoRegisterNative: false,
      });

      expect(storeWithoutNative.providers.get('native')).toBeUndefined();
    });

    it('should use provided registry', () => {
      const customRegistry = createProviderRegistry();
      customRegistry.register(mockBeadsProvider);

      const storeWithCustomRegistry = createProviderAwareStore(baseStore, {
        registry: customRegistry,
        autoRegisterNative: false,
      });

      expect(storeWithCustomRegistry.providers.get('beads')).toBe(mockBeadsProvider);
    });
  });

  describe('resolveNode', () => {
    describe('local IDs', () => {
      it('should resolve local IDs via getNode', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(mockContext);

        const result = await providerStore.resolveNode('c-abc1');

        expect(baseStore.getNode).toHaveBeenCalledWith('c-abc1');
        expect(result).toBe(mockContext);
      });

      it('should return null for non-existent local node', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(null);

        const result = await providerStore.resolveNode('c-notfound');

        expect(result).toBeNull();
      });

      it('should handle all local ID prefixes', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(mockContext);

        for (const prefix of ['c-', 't-', 'f-', 'e-', 'x-']) {
          await providerStore.resolveNode(`${prefix}abc1`);
          expect(baseStore.getNode).toHaveBeenCalledWith(`${prefix}abc1`);
        }
      });
    });

    describe('external URIs', () => {
      beforeEach(() => {
        providerStore.providers.register(mockBeadsProvider);
      });

      it('should resolve URIs via provider', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);

        const result = await providerStore.resolveNode('beads://./bd-123');

        expect(mockBeadsProvider.get).toHaveBeenCalledWith('bd-123', undefined);
        expect(result).toBeDefined();
      });

      it('should return null for unknown schemes', async () => {
        const result = await providerStore.resolveNode('unknown://./something');

        expect(result).toBeNull();
      });

      it('should use cached node when not stale', async () => {
        const freshNode = {
          ...mockExternalNode,
          cached_at: new Date().toISOString(),
        };
        vi.mocked(baseStore.query.nodes).mockResolvedValue([freshNode as unknown as Node]);

        const result = await providerStore.resolveNode('beads://./bd-123');

        expect(mockBeadsProvider.get).not.toHaveBeenCalled();
        expect(result).toEqual(freshNode);
      });

      it('should bypass cache when refresh=true', async () => {
        const freshNode = {
          ...mockExternalNode,
          cached_at: new Date().toISOString(),
        };
        vi.mocked(baseStore.query.nodes).mockResolvedValue([freshNode as unknown as Node]);

        await providerStore.resolveNode('beads://./bd-123', { refresh: true });

        expect(mockBeadsProvider.get).toHaveBeenCalled();
      });

      it('should materialize when explicitly requested', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

        const result = await providerStore.resolveNode('beads://./bd-123', {
          materialize: true,
        });

        expect(baseStore.createNode).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'external',
            uri: 'beads://./bd-123',
          }),
        );
      });

      it('should return provider node directly when not materializing', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);

        const result = await providerStore.resolveNode('beads://./bd-123');

        // With on-demand strategy (default), should not materialize without explicit flag
        expect(baseStore.createNode).not.toHaveBeenCalled();
      });
    });
  });

  describe('materializeNode', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider);
    });

    it('should create external node from provider data', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

      const result = await providerStore.materializeNode('beads://./bd-123');

      expect(mockBeadsProvider.get).toHaveBeenCalledWith('bd-123');
      expect(baseStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'beads://./bd-123',
          source: 'beads',
          title: 'Beads Issue',
        }),
      );
    });

    it('should throw for unknown URI scheme', async () => {
      await expect(providerStore.materializeNode('unknown://./something')).rejects.toThrow(
        'No provider found',
      );
    });

    it('should throw if node not found in provider', async () => {
      vi.mocked(mockBeadsProvider.get).mockResolvedValue(null);

      await expect(providerStore.materializeNode('beads://./bd-notfound')).rejects.toThrow(
        'Node not found',
      );
    });

    it('should update existing node if already materialized', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node]);
      vi.mocked(baseStore.updateNode).mockResolvedValue(mockExternalNode as unknown as Node);

      await providerStore.materializeNode('beads://./bd-123');

      expect(baseStore.updateNode).toHaveBeenCalled();
      expect(baseStore.createNode).not.toHaveBeenCalled();
    });
  });

  describe('refreshNode', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider);
    });

    it('should refresh an external node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node);
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node]);
      vi.mocked(baseStore.updateNode).mockResolvedValue(mockExternalNode as unknown as Node);

      const result = await providerStore.refreshNode('x-ext1');

      expect(mockBeadsProvider.get).toHaveBeenCalledWith('beads://./bd-123', undefined);
      expect(baseStore.updateNode).toHaveBeenCalled();
    });

    it('should throw for non-external node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockContext);

      await expect(providerStore.refreshNode('c-abc1')).rejects.toThrow('not external');
    });

    it('should throw for non-existent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null);

      await expect(providerStore.refreshNode('x-notfound')).rejects.toThrow('Node not found');
    });
  });

  describe('background sync', () => {
    it('should start and stop background sync', () => {
      providerStore = createProviderAwareStore(baseStore, {
        materialization: {
          backgroundSyncInterval: 1000,
        },
      });

      expect(providerStore.isBackgroundSyncRunning()).toBe(false);

      providerStore.startBackgroundSync();
      expect(providerStore.isBackgroundSyncRunning()).toBe(true);

      providerStore.stopBackgroundSync();
      expect(providerStore.isBackgroundSyncRunning()).toBe(false);
    });

    it('should not start if interval is 0', () => {
      providerStore = createProviderAwareStore(baseStore, {
        materialization: {
          backgroundSyncInterval: 0,
        },
      });

      providerStore.startBackgroundSync();
      expect(providerStore.isBackgroundSyncRunning()).toBe(false);
    });
  });

  describe('provider registration', () => {
    it('should allow registering additional providers', () => {
      providerStore.providers.register(mockBeadsProvider);

      expect(providerStore.providers.get('beads')).toBe(mockBeadsProvider);
      expect(providerStore.providers.canResolve('beads://./bd-123')).toBe(true);
    });

    it('should allow unregistering providers', () => {
      providerStore.providers.register(mockBeadsProvider);
      providerStore.providers.unregister('beads');

      expect(providerStore.providers.get('beads')).toBeUndefined();
    });
  });

  describe('base store methods', () => {
    it('should pass through getNode to base store', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockContext);

      const result = await providerStore.getNode('c-abc1');

      expect(baseStore.getNode).toHaveBeenCalledWith('c-abc1');
      expect(result).toBe(mockContext);
    });

    it('should pass through createNode to base store', async () => {
      vi.mocked(baseStore.createNode).mockResolvedValue(mockContext);

      const result = await providerStore.createNode({
        type: 'context',
        title: 'New Context',
      });

      expect(baseStore.createNode).toHaveBeenCalled();
      expect(result).toBe(mockContext);
    });

    it('should pass through query to base store', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockContext]);

      const result = await providerStore.query.nodes({ type: 'context' });

      expect(baseStore.query.nodes).toHaveBeenCalledWith({ type: 'context' });
      expect(result).toEqual([mockContext]);
    });
  });

  describe('materialization strategies', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider);
    });

    it('should materialize with lazy strategy on resolve', async () => {
      const lazyStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'lazy' },
      });
      lazyStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

      await lazyStore.resolveNode('beads://./bd-123');

      expect(baseStore.createNode).toHaveBeenCalled();
    });

    it('should materialize with eager strategy always', async () => {
      const eagerStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'eager' },
      });
      eagerStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

      await eagerStore.resolveNode('beads://./bd-123');

      expect(baseStore.createNode).toHaveBeenCalled();
    });

    it('should not materialize with none strategy', async () => {
      const noneStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'none' },
      });
      noneStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);

      await noneStore.resolveNode('beads://./bd-123', { materialize: true });

      // Even with explicit flag, 'none' should not materialize
      expect(baseStore.createNode).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Provider-Routed CRUD (Unified Interface)
  // ===========================================================================

  describe('providerCreate', () => {
    it('should create locally when defaultProvider is native', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'native',
      });

      const mockNode: Node = { ...mockContext };
      vi.mocked(baseStore.createNode).mockResolvedValue(mockNode);

      const result = await store.providerCreate({
        type: 'context',
        title: 'Test Context',
      });

      expect(result.provider).toBe('native');
      expect(result.uri).toBeUndefined();
      expect(baseStore.createNode).toHaveBeenCalledWith({
        type: 'context',
        title: 'Test Context',
      });
    });

    it('should route to external provider via scheme param', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'native',
      });
      store.providers.register(mockBeadsProvider);

      const createdProviderNode: ProviderNode = {
        id: 'bd-new1',
        uri: 'beads://./bd-new1',
        type: 'issue',
        title: 'New Issue',
        fetchedAt: new Date().toISOString(),
      };
      vi.mocked(mockBeadsProvider.create).mockResolvedValue(createdProviderNode);
      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue({
        ...mockExternalNode,
        id: 'x-new1',
        title: 'New Issue',
        uri: 'beads://./bd-new1',
      } as unknown as Node);

      const result = await store.providerCreate(
        { type: 'issue', title: 'New Issue' },
        { scheme: 'beads' },
      );

      expect(result.provider).toBe('beads');
      expect(result.uri).toBe('beads://./bd-new1');
      expect(mockBeadsProvider.create).toHaveBeenCalledWith(
        {
          type: 'issue',
          title: 'New Issue',
          content: undefined,
          status: undefined,
          priority: undefined,
          metadata: undefined,
        },
        undefined,
      );
      // Should materialize the node locally
      expect(baseStore.createNode).toHaveBeenCalled();
    });

    it('should use defaultProvider when no scheme specified', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'beads',
      });
      store.providers.register(mockBeadsProvider);

      const createdProviderNode: ProviderNode = {
        id: 'bd-new2',
        uri: 'beads://./bd-new2',
        type: 'issue',
        title: 'Default Provider Issue',
        fetchedAt: new Date().toISOString(),
      };
      vi.mocked(mockBeadsProvider.create).mockResolvedValue(createdProviderNode);
      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue({
        ...mockExternalNode,
        id: 'x-new2',
      } as unknown as Node);

      const result = await store.providerCreate({
        type: 'issue',
        title: 'Default Provider Issue',
      });

      // Should route to beads since it's the defaultProvider
      expect(result.provider).toBe('beads');
      expect(mockBeadsProvider.create).toHaveBeenCalled();
    });

    it('should throw for unknown provider', async () => {
      const store = createProviderAwareStore(baseStore);

      await expect(
        store.providerCreate({ type: 'issue', title: 'Test' }, { scheme: 'nonexistent' }),
      ).rejects.toThrow('Unknown provider: nonexistent');
    });

    it('should throw for read-only provider', async () => {
      const readOnlyProvider: Provider = {
        ...mockBeadsProvider,
        name: 'readonly',
        schemes: ['readonly'],
        capabilities: {
          read: true,
          write: false,
          search: false,
          watch: false,
          mount: false,
          feedback: false,
        },
      };
      const store = createProviderAwareStore(baseStore);
      store.providers.register(readOnlyProvider);

      await expect(
        store.providerCreate({ type: 'issue', title: 'Test' }, { scheme: 'readonly' }),
      ).rejects.toThrow('read-only');
    });

    it('should throw for non-mountable provider', async () => {
      const nonMountable: Provider = {
        ...mockBeadsProvider,
        name: 'nomount',
        schemes: ['nomount'],
        capabilities: {
          read: true,
          write: true,
          search: false,
          watch: false,
          mount: false,
          feedback: false,
        },
      };
      const store = createProviderAwareStore(baseStore);
      store.providers.register(nonMountable);

      await expect(
        store.providerCreate({ type: 'issue', title: 'Test' }, { scheme: 'nomount' }),
      ).rejects.toThrow('does not support mounting');
    });
  });

  describe('providerGet', () => {
    it('should get local node directly', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockContext as unknown as Node);

      const result = await providerStore.providerGet('c-abc1');

      expect(baseStore.getNode).toHaveBeenCalledWith('c-abc1');
      expect(result).toEqual(mockContext);
    });

    it('should refresh stale external node', async () => {
      const staleNode: ExternalNode = {
        ...mockExternalNode,
        cached_at: '2020-01-01T00:00:00.000Z', // very old
      };
      vi.mocked(baseStore.getNode).mockResolvedValue(staleNode as unknown as Node);

      providerStore.providers.register(mockBeadsProvider);

      // Mock the refresh path: query for existing, then update
      vi.mocked(baseStore.query.nodes).mockResolvedValue([staleNode as unknown as Node]);
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...staleNode,
        title: 'Beads Issue',
        cached_at: new Date().toISOString(),
      } as unknown as Node);

      const result = await providerStore.providerGet('x-ext1');

      expect(mockBeadsProvider.get).toHaveBeenCalled();
    });

    it('should resolve provider URI and materialize', async () => {
      providerStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

      const result = await providerStore.providerGet('beads://./bd-123');

      expect(mockBeadsProvider.get).toHaveBeenCalled();
    });

    it('should return null for nonexistent local node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null);

      const result = await providerStore.providerGet('c-nonexist');

      expect(result).toBeNull();
    });
  });

  describe('providerUpdate', () => {
    it('should update local node directly', async () => {
      const updatedNode = { ...mockContext, title: 'Updated' } as unknown as Node;
      vi.mocked(baseStore.getNode).mockResolvedValue(mockContext as unknown as Node);
      vi.mocked(baseStore.updateNode).mockResolvedValue(updatedNode);

      const result = await providerStore.providerUpdate('c-abc1', { title: 'Updated' });

      expect(baseStore.updateNode).toHaveBeenCalledWith('c-abc1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('should route update to external provider for materialized node', async () => {
      providerStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node);

      const updatedProviderNode: ProviderNode = {
        ...mockProviderNode,
        title: 'Updated in Beads',
      };
      vi.mocked(mockBeadsProvider.update).mockResolvedValue(updatedProviderNode);

      // Mock materialization (find existing, then update)
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node]);
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...mockExternalNode,
        title: 'Updated in Beads',
      } as unknown as Node);

      const result = await providerStore.providerUpdate('x-ext1', { title: 'Updated in Beads' });

      expect(mockBeadsProvider.update).toHaveBeenCalledWith(
        'bd-123',
        {
          title: 'Updated in Beads',
          content: undefined,
          status: undefined,
          priority: undefined,
          metadata: undefined,
        },
        undefined,
      );
    });

    it('should route update via provider URI', async () => {
      providerStore.providers.register(mockBeadsProvider);

      // No existing materialized copy
      vi.mocked(baseStore.query.nodes).mockResolvedValue([]);

      // Mock fetching the node for materialization
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node);

      const updatedProviderNode: ProviderNode = {
        ...mockProviderNode,
        title: 'Updated via URI',
      };
      vi.mocked(mockBeadsProvider.update).mockResolvedValue(updatedProviderNode);

      // After materialization, the update path will re-materialize
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...mockExternalNode,
        title: 'Updated via URI',
      } as unknown as Node);

      const result = await providerStore.providerUpdate('beads://./bd-123', {
        title: 'Updated via URI',
      });

      expect(mockBeadsProvider.update).toHaveBeenCalled();
    });

    it('should throw for nonexistent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null);

      await expect(providerStore.providerUpdate('c-nonexist', { title: 'Test' })).rejects.toThrow(
        'not found',
      );
    });

    it('should throw when external node provider is not registered', async () => {
      // External node exists but its provider (beads) is NOT registered
      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node);

      await expect(providerStore.providerUpdate('x-ext1', { title: 'Update' })).rejects.toThrow(
        'Provider not registered',
      );
    });
  });

  describe('providerDelete', () => {
    it('should delete local node directly', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockContext as unknown as Node);
      vi.mocked(baseStore.deleteNode).mockResolvedValue(undefined);

      await providerStore.providerDelete('c-abc1');

      expect(baseStore.deleteNode).toHaveBeenCalledWith('c-abc1', undefined);
    });

    it('should route delete to external provider and remove local copy', async () => {
      providerStore.providers.register(mockBeadsProvider);

      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node);
      vi.mocked(mockBeadsProvider.delete).mockResolvedValue(undefined);
      vi.mocked(baseStore.deleteNode).mockResolvedValue(undefined);

      await providerStore.providerDelete('x-ext1');

      // Should delete in provider
      expect(mockBeadsProvider.delete).toHaveBeenCalledWith('bd-123', undefined);

      // Should hard-delete local materialized copy
      expect(baseStore.deleteNode).toHaveBeenCalledWith('x-ext1', { hard: true });
    });

    it('should throw for nonexistent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null);

      await expect(providerStore.providerDelete('c-nonexist')).rejects.toThrow('not found');
    });

    it('should throw when external node provider is not registered', async () => {
      // External node exists but its provider (beads) is NOT registered
      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node);

      await expect(providerStore.providerDelete('x-ext1')).rejects.toThrow(
        'Provider not registered',
      );
    });
  });

  describe('defaultProvider', () => {
    it('should default to native', () => {
      const store = createProviderAwareStore(baseStore);
      expect(store.defaultProvider).toBe('native');
    });

    it('should respect config', () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'sudocode',
      });
      expect(store.defaultProvider).toBe('sudocode');
    });
  });

  // =========================================================================
  // Task Lifecycle (TaskManageable)
  // =========================================================================

  describe('task lifecycle', () => {
    let mockTaskProvider: Provider & TaskManageable;

    const mockTaskProviderNode: ProviderNode = {
      id: 'task-1',
      uri: 'taskprov://task-1',
      type: 'issue',
      title: 'Task One',
      status: 'in_progress',
      fetchedAt: new Date().toISOString(),
    };

    const mockTaskExternalNode: ExternalNode = {
      id: 'x-task1',
      uuid: 'uuid-task-1',
      type: 'external',
      title: 'Task One',
      uri: 'taskprov://task-1',
      source: 'taskprov',
      materialized: true,
      cached_at: new Date().toISOString(),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
      mockTaskProvider = {
        name: 'taskprov',
        schemes: ['taskprov'],
        capabilities: {
          read: true,
          write: true,
          search: false,
          watch: false,
          mount: true,
          feedback: false,
        },
        parseUri: vi.fn((uri: string) => {
          if (uri.startsWith('taskprov://')) {
            const id = uri.slice('taskprov://'.length);
            return { scheme: 'taskprov', id, isRelative: false };
          }
          return null;
        }),
        buildUri: vi.fn((id: string) => `taskprov://${id}`),
        isValidUri: vi.fn((uri: string) => uri.startsWith('taskprov://')),
        get: vi.fn().mockResolvedValue(mockTaskProviderNode),
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),

        taskCapabilities: {
          actions: ['start', 'complete', 'block', 'reopen'] as TaskAction[],
          supportsAssignment: true,
          supportsReadyQuery: true,
          statusModel: ['open', 'in_progress', 'blocked', 'done'],
        },
        transitionTask: vi.fn().mockResolvedValue(mockTaskProviderNode),
        readyTasks: vi.fn().mockResolvedValue([mockTaskProviderNode]),
        assignTask: vi.fn().mockResolvedValue(mockTaskProviderNode),
        validActions: vi.fn().mockResolvedValue(['start', 'close'] as TaskAction[]),
      };
    });

    describe('taskTransition', () => {
      it('should transition a task via provider URI', async () => {
        providerStore.providers.register(mockTaskProvider);

        // Mock materialization: no existing node, so create one
        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        const result = await providerStore.taskTransition('taskprov://task-1', 'start');

        expect(mockTaskProvider.transitionTask).toHaveBeenCalledWith('task-1', 'start', undefined);
        expect(result.action).toBe('start');
        expect(result.provider).toBe('taskprov');
        expect(result.node).toBeDefined();
      });

      it('should transition a task via local external node ID', async () => {
        providerStore.providers.register(mockTaskProvider);

        vi.mocked(baseStore.getNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);
        vi.mocked(baseStore.query.nodes).mockResolvedValue([
          mockTaskExternalNode as unknown as Node,
        ]);
        vi.mocked(baseStore.updateNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        const result = await providerStore.taskTransition('x-task1', 'complete');

        expect(mockTaskProvider.transitionTask).toHaveBeenCalledWith(
          'task-1',
          'complete',
          undefined,
        );
        expect(result.action).toBe('complete');
      });

      it('should throw for provider that does not support tasks', async () => {
        providerStore.providers.register(mockBeadsProvider);

        await expect(providerStore.taskTransition('beads://./bd-123', 'start')).rejects.toThrow(
          'does not support task operations',
        );
      });

      it('should throw for nonexistent node', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(null);

        await expect(providerStore.taskTransition('c-nonexist', 'start')).rejects.toThrow(
          'not found',
        );
      });

      it('should forward context to provider', async () => {
        providerStore.providers.register(mockTaskProvider);

        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        const ctx = { cwd: '/other/dir', timeout: 5000 };
        await providerStore.taskTransition('taskprov://task-1', 'start', { context: ctx });

        expect(mockTaskProvider.transitionTask).toHaveBeenCalledWith('task-1', 'start', ctx);
      });
    });

    describe('taskReady', () => {
      it('should aggregate ready tasks across task-capable providers', async () => {
        providerStore.providers.register(mockTaskProvider);

        // Mock materialization for each ready task
        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        const ready = await providerStore.taskReady();

        expect(mockTaskProvider.readyTasks).toHaveBeenCalled();
        expect(ready.length).toBeGreaterThanOrEqual(1);
      });

      it('should skip non-task-capable providers', async () => {
        providerStore.providers.register(mockBeadsProvider);
        providerStore.providers.register(mockTaskProvider);

        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        await providerStore.taskReady();

        // Only taskprov should be queried
        expect(mockTaskProvider.readyTasks).toHaveBeenCalled();
      });

      it('should filter by provider name', async () => {
        providerStore.providers.register(mockTaskProvider);

        await providerStore.taskReady({ providers: ['other-provider'] });

        // taskprov should NOT be queried because it wasn't in the filter
        expect(mockTaskProvider.readyTasks).not.toHaveBeenCalled();
      });

      it('should return existing materialized nodes when available', async () => {
        providerStore.providers.register(mockTaskProvider);

        // Mock: existing materialized node found
        vi.mocked(baseStore.query.nodes).mockResolvedValue([
          mockTaskExternalNode as unknown as Node,
        ]);

        const ready = await providerStore.taskReady();

        expect(ready[0]).toEqual(mockTaskExternalNode);
      });

      it('should forward options to provider', async () => {
        providerStore.providers.register(mockTaskProvider);

        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        await providerStore.taskReady({ limit: 5, tags: ['urgent'], assignee: 'alice' });

        expect(mockTaskProvider.readyTasks).toHaveBeenCalledWith(
          { limit: 5, tags: ['urgent'], priority: undefined, assignee: 'alice' },
          undefined,
        );
      });
    });

    describe('taskAssign', () => {
      it('should assign a task via provider', async () => {
        providerStore.providers.register(mockTaskProvider);

        vi.mocked(baseStore.query.nodes).mockResolvedValue([]);
        vi.mocked(baseStore.createNode).mockResolvedValue(mockTaskExternalNode as unknown as Node);

        const result = await providerStore.taskAssign('taskprov://task-1', 'alice');

        expect(mockTaskProvider.assignTask).toHaveBeenCalledWith('task-1', 'alice', undefined);
        expect(result).toBeDefined();
      });

      it('should throw for provider that does not support assignment', async () => {
        const noAssignProvider: Provider & TaskManageable = {
          ...mockTaskProvider,
          name: 'noassign',
          schemes: ['noassign'],
          parseUri: vi.fn((uri: string) => {
            if (uri.startsWith('noassign://')) {
              return { scheme: 'noassign', id: uri.slice('noassign://'.length), isRelative: false };
            }
            return null;
          }),
          buildUri: vi.fn((id: string) => `noassign://${id}`),
          isValidUri: vi.fn((uri: string) => uri.startsWith('noassign://')),
          taskCapabilities: {
            ...mockTaskProvider.taskCapabilities,
            supportsAssignment: false,
          },
          assignTask: undefined,
        };
        providerStore.providers.register(noAssignProvider);

        await expect(providerStore.taskAssign('noassign://task-1', 'alice')).rejects.toThrow(
          'does not support task assignment',
        );
      });
    });

    describe('taskValidActions', () => {
      it('should return valid actions from provider', async () => {
        providerStore.providers.register(mockTaskProvider);

        const actions = await providerStore.taskValidActions('taskprov://task-1');

        expect(mockTaskProvider.validActions).toHaveBeenCalledWith('task-1');
        expect(actions).toEqual(['start', 'close']);
      });

      it('should fall back to taskCapabilities.actions when validActions not implemented', async () => {
        const noValidActionsProvider: Provider & TaskManageable = {
          ...mockTaskProvider,
          name: 'novalid',
          schemes: ['novalid'],
          parseUri: vi.fn((uri: string) => {
            if (uri.startsWith('novalid://')) {
              return { scheme: 'novalid', id: uri.slice('novalid://'.length), isRelative: false };
            }
            return null;
          }),
          buildUri: vi.fn((id: string) => `novalid://${id}`),
          isValidUri: vi.fn((uri: string) => uri.startsWith('novalid://')),
          validActions: undefined,
        };
        providerStore.providers.register(noValidActionsProvider);

        const actions = await providerStore.taskValidActions('novalid://task-1');

        expect(actions).toEqual(['start', 'complete', 'block', 'reopen']);
      });
    });
  });
});
