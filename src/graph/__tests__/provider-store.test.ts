/**
 * Tests for Provider-Aware Graph Store
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  createProviderAwareStore,
  type ProviderAwareStore,
} from '../provider-store.js'
import type { GraphStore } from '../store.js'
import type { Node, ExternalNode, Spec, Issue } from '../../schema/index.js'
import type { Provider, ProviderNode, ProviderRegistry } from '../../providers/types.js'
import { createProviderRegistry } from '../../providers/registry.js'

describe('ProviderAwareStore', () => {
  let baseStore: GraphStore
  let providerStore: ProviderAwareStore
  let mockBeadsProvider: Provider

  // Mock nodes
  const mockSpec: Spec = {
    id: 's-abc1',
    uuid: 'uuid-1',
    type: 'spec',
    title: 'Test Spec',
    content: 'Spec content',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }

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
  }

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
  }

  beforeEach(() => {
    vi.useFakeTimers()

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
    } as unknown as GraphStore

    // Create mock beads provider
    mockBeadsProvider = {
      name: 'beads',
      schemes: ['beads', 'bd'],
      capabilities: { read: true, write: true, search: true, watch: false, mount: true, feedback: false },
      parseUri: vi.fn((uri: string) => {
        if (uri.startsWith('beads://') || uri.startsWith('bd://')) {
          const id = uri.split('/').pop() || ''
          return { scheme: 'beads', id, isRelative: uri.includes('/.') }
        }
        return null
      }),
      buildUri: vi.fn((id: string) => `beads://./${id}`),
      isValidUri: vi.fn((uri: string) => uri.startsWith('beads://') || uri.startsWith('bd://')),
      get: vi.fn().mockResolvedValue(mockProviderNode),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    }

    // Create provider store
    providerStore = createProviderAwareStore(baseStore)
  })

  afterEach(() => {
    providerStore.stopBackgroundSync()
    vi.useRealTimers()
  })

  describe('initialization', () => {
    it('should have providers registry', () => {
      expect(providerStore.providers).toBeDefined()
      expect(providerStore.providers.list).toBeDefined()
    })

    it('should have materialization manager', () => {
      expect(providerStore.materialization).toBeDefined()
      expect(providerStore.materialization.config).toBeDefined()
    })

    it('should auto-register native provider', () => {
      const nativeProvider = providerStore.providers.get('native')
      expect(nativeProvider).toBeDefined()
      expect(nativeProvider?.name).toBe('native')
    })

    it('should not auto-register native provider when disabled', () => {
      const storeWithoutNative = createProviderAwareStore(baseStore, {
        autoRegisterNative: false,
      })

      expect(storeWithoutNative.providers.get('native')).toBeUndefined()
    })

    it('should use provided registry', () => {
      const customRegistry = createProviderRegistry()
      customRegistry.register(mockBeadsProvider)

      const storeWithCustomRegistry = createProviderAwareStore(baseStore, {
        registry: customRegistry,
        autoRegisterNative: false,
      })

      expect(storeWithCustomRegistry.providers.get('beads')).toBe(mockBeadsProvider)
    })
  })

  describe('resolveNode', () => {
    describe('local IDs', () => {
      it('should resolve local IDs via getNode', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec)

        const result = await providerStore.resolveNode('s-abc1')

        expect(baseStore.getNode).toHaveBeenCalledWith('s-abc1')
        expect(result).toBe(mockSpec)
      })

      it('should return null for non-existent local node', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(null)

        const result = await providerStore.resolveNode('s-notfound')

        expect(result).toBeNull()
      })

      it('should handle all local ID prefixes', async () => {
        vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec)

        for (const prefix of ['s-', 'i-', 'f-', 'e-', 'x-']) {
          await providerStore.resolveNode(`${prefix}abc1`)
          expect(baseStore.getNode).toHaveBeenCalledWith(`${prefix}abc1`)
        }
      })
    })

    describe('external URIs', () => {
      beforeEach(() => {
        providerStore.providers.register(mockBeadsProvider)
      })

      it('should resolve URIs via provider', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([])

        const result = await providerStore.resolveNode('beads://./bd-123')

        expect(mockBeadsProvider.get).toHaveBeenCalledWith('bd-123')
        expect(result).toBeDefined()
      })

      it('should return null for unknown schemes', async () => {
        const result = await providerStore.resolveNode('unknown://./something')

        expect(result).toBeNull()
      })

      it('should use cached node when not stale', async () => {
        const freshNode = {
          ...mockExternalNode,
          cached_at: new Date().toISOString(),
        }
        vi.mocked(baseStore.query.nodes).mockResolvedValue([freshNode as unknown as Node])

        const result = await providerStore.resolveNode('beads://./bd-123')

        expect(mockBeadsProvider.get).not.toHaveBeenCalled()
        expect(result).toEqual(freshNode)
      })

      it('should bypass cache when refresh=true', async () => {
        const freshNode = {
          ...mockExternalNode,
          cached_at: new Date().toISOString(),
        }
        vi.mocked(baseStore.query.nodes).mockResolvedValue([freshNode as unknown as Node])

        await providerStore.resolveNode('beads://./bd-123', { refresh: true })

        expect(mockBeadsProvider.get).toHaveBeenCalled()
      })

      it('should materialize when explicitly requested', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([])
        vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

        const result = await providerStore.resolveNode('beads://./bd-123', {
          materialize: true,
        })

        expect(baseStore.createNode).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'external',
            uri: 'beads://./bd-123',
          })
        )
      })

      it('should return provider node directly when not materializing', async () => {
        vi.mocked(baseStore.query.nodes).mockResolvedValue([])

        const result = await providerStore.resolveNode('beads://./bd-123')

        // With on-demand strategy (default), should not materialize without explicit flag
        expect(baseStore.createNode).not.toHaveBeenCalled()
      })
    })
  })

  describe('materializeNode', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider)
    })

    it('should create external node from provider data', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

      const result = await providerStore.materializeNode('beads://./bd-123')

      expect(mockBeadsProvider.get).toHaveBeenCalledWith('bd-123')
      expect(baseStore.createNode).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'external',
          uri: 'beads://./bd-123',
          source: 'beads',
          title: 'Beads Issue',
        })
      )
    })

    it('should throw for unknown URI scheme', async () => {
      await expect(
        providerStore.materializeNode('unknown://./something')
      ).rejects.toThrow('No provider found')
    })

    it('should throw if node not found in provider', async () => {
      vi.mocked(mockBeadsProvider.get).mockResolvedValue(null)

      await expect(
        providerStore.materializeNode('beads://./bd-notfound')
      ).rejects.toThrow('Node not found')
    })

    it('should update existing node if already materialized', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node])
      vi.mocked(baseStore.updateNode).mockResolvedValue(mockExternalNode as unknown as Node)

      await providerStore.materializeNode('beads://./bd-123')

      expect(baseStore.updateNode).toHaveBeenCalled()
      expect(baseStore.createNode).not.toHaveBeenCalled()
    })
  })

  describe('refreshNode', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider)
    })

    it('should refresh an external node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node)
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node])
      vi.mocked(baseStore.updateNode).mockResolvedValue(mockExternalNode as unknown as Node)

      const result = await providerStore.refreshNode('x-ext1')

      expect(mockBeadsProvider.get).toHaveBeenCalledWith('beads://./bd-123')
      expect(baseStore.updateNode).toHaveBeenCalled()
    })

    it('should throw for non-external node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec)

      await expect(providerStore.refreshNode('s-abc1')).rejects.toThrow(
        'not external'
      )
    })

    it('should throw for non-existent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null)

      await expect(providerStore.refreshNode('x-notfound')).rejects.toThrow(
        'Node not found'
      )
    })
  })

  describe('background sync', () => {
    it('should start and stop background sync', () => {
      providerStore = createProviderAwareStore(baseStore, {
        materialization: {
          backgroundSyncInterval: 1000,
        },
      })

      expect(providerStore.isBackgroundSyncRunning()).toBe(false)

      providerStore.startBackgroundSync()
      expect(providerStore.isBackgroundSyncRunning()).toBe(true)

      providerStore.stopBackgroundSync()
      expect(providerStore.isBackgroundSyncRunning()).toBe(false)
    })

    it('should not start if interval is 0', () => {
      providerStore = createProviderAwareStore(baseStore, {
        materialization: {
          backgroundSyncInterval: 0,
        },
      })

      providerStore.startBackgroundSync()
      expect(providerStore.isBackgroundSyncRunning()).toBe(false)
    })
  })

  describe('provider registration', () => {
    it('should allow registering additional providers', () => {
      providerStore.providers.register(mockBeadsProvider)

      expect(providerStore.providers.get('beads')).toBe(mockBeadsProvider)
      expect(providerStore.providers.canResolve('beads://./bd-123')).toBe(true)
    })

    it('should allow unregistering providers', () => {
      providerStore.providers.register(mockBeadsProvider)
      providerStore.providers.unregister('beads')

      expect(providerStore.providers.get('beads')).toBeUndefined()
    })
  })

  describe('base store methods', () => {
    it('should pass through getNode to base store', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec)

      const result = await providerStore.getNode('s-abc1')

      expect(baseStore.getNode).toHaveBeenCalledWith('s-abc1')
      expect(result).toBe(mockSpec)
    })

    it('should pass through createNode to base store', async () => {
      vi.mocked(baseStore.createNode).mockResolvedValue(mockSpec)

      const result = await providerStore.createNode({
        type: 'spec',
        title: 'New Spec',
      })

      expect(baseStore.createNode).toHaveBeenCalled()
      expect(result).toBe(mockSpec)
    })

    it('should pass through query to base store', async () => {
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockSpec])

      const result = await providerStore.query.nodes({ type: 'spec' })

      expect(baseStore.query.nodes).toHaveBeenCalledWith({ type: 'spec' })
      expect(result).toEqual([mockSpec])
    })
  })

  describe('materialization strategies', () => {
    beforeEach(() => {
      providerStore.providers.register(mockBeadsProvider)
    })

    it('should materialize with lazy strategy on resolve', async () => {
      const lazyStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'lazy' },
      })
      lazyStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

      await lazyStore.resolveNode('beads://./bd-123')

      expect(baseStore.createNode).toHaveBeenCalled()
    })

    it('should materialize with eager strategy always', async () => {
      const eagerStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'eager' },
      })
      eagerStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

      await eagerStore.resolveNode('beads://./bd-123')

      expect(baseStore.createNode).toHaveBeenCalled()
    })

    it('should not materialize with none strategy', async () => {
      const noneStore = createProviderAwareStore(baseStore, {
        materialization: { default: 'none' },
      })
      noneStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.query.nodes).mockResolvedValue([])

      await noneStore.resolveNode('beads://./bd-123', { materialize: true })

      // Even with explicit flag, 'none' should not materialize
      expect(baseStore.createNode).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // Provider-Routed CRUD (Unified Interface)
  // ===========================================================================

  describe('providerCreate', () => {
    it('should create locally when defaultProvider is native', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'native',
      })

      const mockNode: Node = { ...mockSpec }
      vi.mocked(baseStore.createNode).mockResolvedValue(mockNode)

      const result = await store.providerCreate({
        type: 'spec',
        title: 'Test Spec',
      })

      expect(result.provider).toBe('native')
      expect(result.uri).toBeUndefined()
      expect(baseStore.createNode).toHaveBeenCalledWith({
        type: 'spec',
        title: 'Test Spec',
      })
    })

    it('should route to external provider via scheme param', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'native',
      })
      store.providers.register(mockBeadsProvider)

      const createdProviderNode: ProviderNode = {
        id: 'bd-new1',
        uri: 'beads://./bd-new1',
        type: 'issue',
        title: 'New Issue',
        fetchedAt: new Date().toISOString(),
      }
      vi.mocked(mockBeadsProvider.create).mockResolvedValue(createdProviderNode)
      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue({
        ...mockExternalNode,
        id: 'x-new1',
        title: 'New Issue',
        uri: 'beads://./bd-new1',
      } as unknown as Node)

      const result = await store.providerCreate(
        { type: 'issue', title: 'New Issue' },
        { scheme: 'beads' }
      )

      expect(result.provider).toBe('beads')
      expect(result.uri).toBe('beads://./bd-new1')
      expect(mockBeadsProvider.create).toHaveBeenCalledWith({
        type: 'issue',
        title: 'New Issue',
        content: undefined,
        status: undefined,
        priority: undefined,
        metadata: undefined,
      })
      // Should materialize the node locally
      expect(baseStore.createNode).toHaveBeenCalled()
    })

    it('should use defaultProvider when no scheme specified', async () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'beads',
      })
      store.providers.register(mockBeadsProvider)

      const createdProviderNode: ProviderNode = {
        id: 'bd-new2',
        uri: 'beads://./bd-new2',
        type: 'issue',
        title: 'Default Provider Issue',
        fetchedAt: new Date().toISOString(),
      }
      vi.mocked(mockBeadsProvider.create).mockResolvedValue(createdProviderNode)
      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue({
        ...mockExternalNode,
        id: 'x-new2',
      } as unknown as Node)

      const result = await store.providerCreate({
        type: 'issue',
        title: 'Default Provider Issue',
      })

      // Should route to beads since it's the defaultProvider
      expect(result.provider).toBe('beads')
      expect(mockBeadsProvider.create).toHaveBeenCalled()
    })

    it('should throw for unknown provider', async () => {
      const store = createProviderAwareStore(baseStore)

      await expect(
        store.providerCreate(
          { type: 'issue', title: 'Test' },
          { scheme: 'nonexistent' }
        )
      ).rejects.toThrow('Unknown provider: nonexistent')
    })

    it('should throw for read-only provider', async () => {
      const readOnlyProvider: Provider = {
        ...mockBeadsProvider,
        name: 'readonly',
        schemes: ['readonly'],
        capabilities: { read: true, write: false, search: false, watch: false, mount: false, feedback: false },
      }
      const store = createProviderAwareStore(baseStore)
      store.providers.register(readOnlyProvider)

      await expect(
        store.providerCreate(
          { type: 'issue', title: 'Test' },
          { scheme: 'readonly' }
        )
      ).rejects.toThrow('read-only')
    })

    it('should throw for non-mountable provider', async () => {
      const nonMountable: Provider = {
        ...mockBeadsProvider,
        name: 'nomount',
        schemes: ['nomount'],
        capabilities: { read: true, write: true, search: false, watch: false, mount: false, feedback: false },
      }
      const store = createProviderAwareStore(baseStore)
      store.providers.register(nonMountable)

      await expect(
        store.providerCreate(
          { type: 'issue', title: 'Test' },
          { scheme: 'nomount' }
        )
      ).rejects.toThrow('does not support mounting')
    })
  })

  describe('providerGet', () => {
    it('should get local node directly', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec as unknown as Node)

      const result = await providerStore.providerGet('s-abc1')

      expect(baseStore.getNode).toHaveBeenCalledWith('s-abc1')
      expect(result).toEqual(mockSpec)
    })

    it('should refresh stale external node', async () => {
      const staleNode: ExternalNode = {
        ...mockExternalNode,
        cached_at: '2020-01-01T00:00:00.000Z', // very old
      }
      vi.mocked(baseStore.getNode).mockResolvedValue(staleNode as unknown as Node)

      providerStore.providers.register(mockBeadsProvider)

      // Mock the refresh path: query for existing, then update
      vi.mocked(baseStore.query.nodes).mockResolvedValue([staleNode as unknown as Node])
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...staleNode,
        title: 'Beads Issue',
        cached_at: new Date().toISOString(),
      } as unknown as Node)

      const result = await providerStore.providerGet('x-ext1')

      expect(mockBeadsProvider.get).toHaveBeenCalled()
    })

    it('should resolve provider URI and materialize', async () => {
      providerStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.query.nodes).mockResolvedValue([])
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

      const result = await providerStore.providerGet('beads://./bd-123')

      expect(mockBeadsProvider.get).toHaveBeenCalled()
    })

    it('should return null for nonexistent local node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null)

      const result = await providerStore.providerGet('s-nonexist')

      expect(result).toBeNull()
    })
  })

  describe('providerUpdate', () => {
    it('should update local node directly', async () => {
      const updatedNode = { ...mockSpec, title: 'Updated' } as unknown as Node
      vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec as unknown as Node)
      vi.mocked(baseStore.updateNode).mockResolvedValue(updatedNode)

      const result = await providerStore.providerUpdate('s-abc1', { title: 'Updated' })

      expect(baseStore.updateNode).toHaveBeenCalledWith('s-abc1', { title: 'Updated' })
      expect(result.title).toBe('Updated')
    })

    it('should route update to external provider for materialized node', async () => {
      providerStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node)

      const updatedProviderNode: ProviderNode = {
        ...mockProviderNode,
        title: 'Updated in Beads',
      }
      vi.mocked(mockBeadsProvider.update).mockResolvedValue(updatedProviderNode)

      // Mock materialization (find existing, then update)
      vi.mocked(baseStore.query.nodes).mockResolvedValue([mockExternalNode as unknown as Node])
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...mockExternalNode,
        title: 'Updated in Beads',
      } as unknown as Node)

      const result = await providerStore.providerUpdate('x-ext1', { title: 'Updated in Beads' })

      expect(mockBeadsProvider.update).toHaveBeenCalledWith('bd-123', {
        title: 'Updated in Beads',
        content: undefined,
        status: undefined,
        priority: undefined,
        metadata: undefined,
      })
    })

    it('should route update via provider URI', async () => {
      providerStore.providers.register(mockBeadsProvider)

      // No existing materialized copy
      vi.mocked(baseStore.query.nodes).mockResolvedValue([])

      // Mock fetching the node for materialization
      vi.mocked(baseStore.createNode).mockResolvedValue(mockExternalNode as unknown as Node)

      const updatedProviderNode: ProviderNode = {
        ...mockProviderNode,
        title: 'Updated via URI',
      }
      vi.mocked(mockBeadsProvider.update).mockResolvedValue(updatedProviderNode)

      // After materialization, the update path will re-materialize
      vi.mocked(baseStore.updateNode).mockResolvedValue({
        ...mockExternalNode,
        title: 'Updated via URI',
      } as unknown as Node)

      const result = await providerStore.providerUpdate('beads://./bd-123', { title: 'Updated via URI' })

      expect(mockBeadsProvider.update).toHaveBeenCalled()
    })

    it('should throw for nonexistent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null)

      await expect(
        providerStore.providerUpdate('s-nonexist', { title: 'Test' })
      ).rejects.toThrow('not found')
    })
  })

  describe('providerDelete', () => {
    it('should delete local node directly', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(mockSpec as unknown as Node)
      vi.mocked(baseStore.deleteNode).mockResolvedValue(undefined)

      await providerStore.providerDelete('s-abc1')

      expect(baseStore.deleteNode).toHaveBeenCalledWith('s-abc1', undefined)
    })

    it('should route delete to external provider and remove local copy', async () => {
      providerStore.providers.register(mockBeadsProvider)

      vi.mocked(baseStore.getNode).mockResolvedValue(mockExternalNode as unknown as Node)
      vi.mocked(mockBeadsProvider.delete).mockResolvedValue(undefined)
      vi.mocked(baseStore.deleteNode).mockResolvedValue(undefined)

      await providerStore.providerDelete('x-ext1')

      // Should delete in provider
      expect(mockBeadsProvider.delete).toHaveBeenCalledWith('bd-123')

      // Should hard-delete local materialized copy
      expect(baseStore.deleteNode).toHaveBeenCalledWith('x-ext1', { hard: true })
    })

    it('should throw for nonexistent node', async () => {
      vi.mocked(baseStore.getNode).mockResolvedValue(null)

      await expect(
        providerStore.providerDelete('s-nonexist')
      ).rejects.toThrow('not found')
    })
  })

  describe('defaultProvider', () => {
    it('should default to native', () => {
      const store = createProviderAwareStore(baseStore)
      expect(store.defaultProvider).toBe('native')
    })

    it('should respect config', () => {
      const store = createProviderAwareStore(baseStore, {
        defaultProvider: 'sudocode',
      })
      expect(store.defaultProvider).toBe('sudocode')
    })
  })
})
