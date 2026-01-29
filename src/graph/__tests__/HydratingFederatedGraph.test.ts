import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import {
  HydratingFederatedGraphImpl,
  createHydratingFederatedGraph,
  type HydratingFederatedGraph,
  DEFAULT_CACHE_CONFIG,
} from '../HydratingFederatedGraph.js'
import { createGraphologyAdapter, type GraphologyAdapter } from '../GraphologyAdapter.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'
import type { Storage } from '../../storage/interface.js'
import type { Provider, ProviderRegistry, ProviderNode } from '../../providers/types.js'
import type { RelationshipQueryable, ProviderEdge, EdgeTypeSupport } from '../../providers/traits/RelationshipQueryable.js'

describe('HydratingFederatedGraph', () => {
  let adapter: GraphologyAdapter
  let graph: HydratingFederatedGraph
  let mockStorage: Partial<Storage>
  let mockProviderRegistry: ProviderRegistry
  let mockProvider: Provider & RelationshipQueryable

  beforeEach(() => {
    adapter = createGraphologyAdapter()

    // Mock storage
    mockStorage = {
      getNode: vi.fn().mockResolvedValue(null),
      createNode: vi.fn().mockResolvedValue(undefined),
      updateNode: vi.fn().mockResolvedValue(undefined),
      getEdge: vi.fn().mockResolvedValue(null),
      createEdge: vi.fn().mockResolvedValue(undefined),
      queryNodes: vi.fn().mockResolvedValue([]),
    }

    // Mock provider with relationship support
    mockProvider = {
      name: 'beads',
      schemes: ['beads', 'bd'],
      capabilities: { read: true, write: true, search: true, watch: false },
      parseUri: vi.fn((uri: string) => {
        if (uri.startsWith('beads://')) {
          const id = uri.replace('beads://./', '')
          return { scheme: 'beads', id, isRelative: true }
        }
        return null
      }),
      buildUri: vi.fn((id: string) => `beads://./${id}`),
      isValidUri: vi.fn((uri: string) => uri.startsWith('beads://')),
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({} as ProviderNode),
      update: vi.fn().mockResolvedValue({} as ProviderNode),
      delete: vi.fn().mockResolvedValue(undefined),
      queryEdges: vi.fn().mockResolvedValue([]),
      supportedEdgeTypes: vi.fn().mockReturnValue([
        { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
      ]),
    }

    // Mock provider registry
    mockProviderRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(mockProvider),
      resolveProvider: vi.fn((uri: string) => {
        if (uri.startsWith('beads://') || uri.startsWith('native://')) {
          return uri.startsWith('beads://') ? mockProvider : null
        }
        return null
      }),
      list: vi.fn().mockReturnValue([mockProvider]),
      canResolve: vi.fn().mockReturnValue(true),
    }

    graph = createHydratingFederatedGraph(adapter, {
      storage: mockStorage as Storage,
      providerRegistry: mockProviderRegistry,
    })
  })

  // Test fixtures
  const mockProviderNode: ProviderNode = {
    id: 'bd-123',
    uri: 'beads://./bd-123',
    type: 'issue',
    title: 'Test Beads Issue',
    content: 'Some content',
    status: 'open',
    priority: 1,
    fetchedAt: '2025-01-01T00:00:00Z',
  }

  const mockProviderEdges: ProviderEdge[] = [
    { from: 'bd-123', to: 'bd-456', type: 'blocks' },
    { from: 'bd-789', to: 'bd-123', type: 'blocks' },
  ]

  describe('hydrate()', () => {
    it('fetches node from provider and adds to graph', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)

      await graph.hydrate('beads://./bd-123')

      expect(mockProvider.get).toHaveBeenCalledWith('bd-123')
      expect(adapter.hasNode('beads://./bd-123')).toBe(true)
    })

    it('caches node to storage', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)

      await graph.hydrate('beads://./bd-123')

      expect(mockStorage.createNode).toHaveBeenCalled()
      const createdNode = (mockStorage.createNode as Mock).mock.calls[0][0]
      expect(createdNode.type).toBe('external')
      expect(createdNode.title).toBe('Test Beads Issue')
      expect(createdNode.source).toBe('beads')
    })

    it('fetches and caches edges for RelationshipQueryable providers', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      ;(mockProvider.queryEdges as Mock).mockResolvedValue(mockProviderEdges)

      await graph.hydrate('beads://./bd-123')

      expect(mockProvider.queryEdges).toHaveBeenCalledWith('bd-123')
      expect(mockStorage.createEdge).toHaveBeenCalledTimes(2)
    })

    it('skips hydration if node exists and is fresh', async () => {
      // Pre-populate the graph with a fresh node
      const freshNode: StoredNode = {
        id: 'x-fresh',
        uuid: 'fresh-uuid',
        type: 'external',
        title: 'Fresh Node',
        uri: 'beads://./bd-fresh',
        source: 'beads',
        cached_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      adapter.hydrateNode('beads://./bd-fresh', freshNode)

      await graph.hydrate('beads://./bd-fresh')

      expect(mockProvider.get).not.toHaveBeenCalled()
    })

    it('re-hydrates stale nodes', async () => {
      // Pre-populate with stale node (old cached_at)
      const staleNode: StoredNode = {
        id: 'x-stale',
        uuid: 'stale-uuid',
        type: 'external',
        title: 'Stale Node',
        uri: 'beads://./bd-stale',
        source: 'beads',
        cached_at: '2020-01-01T00:00:00Z', // Very old
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      }
      adapter.hydrateNode('beads://./bd-stale', staleNode)
      ;(mockProvider.parseUri as Mock).mockReturnValue({ scheme: 'beads', id: 'bd-stale', isRelative: true })
      ;(mockProvider.get as Mock).mockResolvedValue({
        ...mockProviderNode,
        id: 'bd-stale',
        uri: 'beads://./bd-stale',
      })

      await graph.hydrate('beads://./bd-stale')

      expect(mockProvider.get).toHaveBeenCalledWith('bd-stale')
    })

    it('does nothing for unknown providers', async () => {
      ;(mockProviderRegistry.resolveProvider as Mock).mockReturnValue(null)

      await graph.hydrate('unknown://some-id')

      expect(mockProvider.get).not.toHaveBeenCalled()
    })

    it('does nothing if provider returns null', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(null)

      await graph.hydrate('beads://./bd-missing')

      expect(adapter.hasNode('beads://./bd-missing')).toBe(false)
    })

    it('updates existing cached node in storage', async () => {
      ;(mockStorage.getNode as Mock).mockResolvedValue({ id: 'x-existing' })
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)

      await graph.hydrate('beads://./bd-123')

      expect(mockStorage.updateNode).toHaveBeenCalled()
      expect(mockStorage.createNode).not.toHaveBeenCalled()
    })
  })

  describe('resolve()', () => {
    it('returns resolved node with full data', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      ;(mockProvider.queryEdges as Mock).mockResolvedValue(mockProviderEdges)

      const resolved = await graph.resolve('beads://./bd-123')

      expect(resolved).not.toBeNull()
      expect(resolved!.uri).toBe('beads://./bd-123')
      expect(resolved!.provider).toBe('beads')
      expect(resolved!.data.title).toBe('Test Beads Issue')
    })

    it('returns null for non-existent node', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(null)

      const resolved = await graph.resolve('beads://./bd-missing')

      expect(resolved).toBeNull()
    })

    it('includes edges in resolved node', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      ;(mockProvider.queryEdges as Mock).mockResolvedValue(mockProviderEdges)

      const resolved = await graph.resolve('beads://./bd-123')

      expect(resolved!.edges.incoming.length + resolved!.edges.outgoing.length).toBeGreaterThan(0)
    })
  })

  describe('resolveAll()', () => {
    it('resolves multiple URIs', async () => {
      const node1 = { ...mockProviderNode, id: 'bd-1', uri: 'beads://./bd-1' }
      const node2 = { ...mockProviderNode, id: 'bd-2', uri: 'beads://./bd-2' }

      ;(mockProvider.get as Mock)
        .mockResolvedValueOnce(node1)
        .mockResolvedValueOnce(node2)

      ;(mockProvider.parseUri as Mock)
        .mockImplementation((uri: string) => {
          if (uri === 'beads://./bd-1') return { scheme: 'beads', id: 'bd-1', isRelative: true }
          if (uri === 'beads://./bd-2') return { scheme: 'beads', id: 'bd-2', isRelative: true }
          return null
        })

      const results = await graph.resolveAll(['beads://./bd-1', 'beads://./bd-2'])

      expect(results.size).toBe(2)
      expect(results.has('beads://./bd-1')).toBe(true)
      expect(results.has('beads://./bd-2')).toBe(true)
    })

    it('skips nodes that cannot be resolved', async () => {
      ;(mockProvider.get as Mock)
        .mockResolvedValueOnce(mockProviderNode)
        .mockResolvedValueOnce(null)

      const results = await graph.resolveAll(['beads://./bd-123', 'beads://./bd-missing'])

      expect(results.size).toBe(1)
    })
  })

  describe('invalidateCache()', () => {
    it('marks nodes from provider as stale', async () => {
      // Add some nodes
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      await graph.hydrate('beads://./bd-123')

      // Verify node is fresh
      expect(graph.isStale('beads://./bd-123')).toBe(false)

      // Invalidate cache
      await graph.invalidateCache('beads')

      // Node should now be stale
      expect(graph.isStale('beads://./bd-123')).toBe(true)
    })

    it('persists cache invalidation to storage', async () => {
      // Hydrate a node
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      await graph.hydrate('beads://./bd-123')

      // Reset the mock to track invalidation calls
      ;(mockStorage.updateNode as Mock).mockClear()

      // Invalidate cache
      await graph.invalidateCache('beads')

      // Storage.updateNode should be called with cached_at: undefined
      expect(mockStorage.updateNode).toHaveBeenCalled()
      const updateCall = (mockStorage.updateNode as Mock).mock.calls[0]
      expect(updateCall[1]).toMatchObject({
        cached_at: undefined,
      })
    })

    it('does not throw when storage update fails', async () => {
      // Hydrate a node
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      await graph.hydrate('beads://./bd-123')

      // Make storage.updateNode fail
      ;(mockStorage.updateNode as Mock).mockRejectedValue(new Error('Storage error'))

      // Should not throw
      await expect(graph.invalidateCache('beads')).resolves.not.toThrow()

      // Node should still be stale in memory
      expect(graph.isStale('beads://./bd-123')).toBe(true)
    })

    it('only invalidates nodes from specified provider', async () => {
      // Add a beads node
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      await graph.hydrate('beads://./bd-123')

      // Add a native node (no source)
      const nativeNode: StoredNode = {
        id: 'i-native',
        uuid: 'native-uuid',
        type: 'issue',
        title: 'Native Issue',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      adapter.onNodeCreated(nativeNode)

      ;(mockStorage.updateNode as Mock).mockClear()

      // Invalidate only beads
      await graph.invalidateCache('beads')

      // Only the beads node should have been invalidated
      expect(graph.isStale('beads://./bd-123')).toBe(true)
      // Native node should not be stale (it has no source)
      expect(graph.isStale('native://i-native')).toBe(false)
    })
  })

  describe('isStale()', () => {
    it('returns true for non-existent nodes', () => {
      expect(graph.isStale('beads://./non-existent')).toBe(true)
    })

    it('returns false for fresh cached nodes', async () => {
      ;(mockProvider.get as Mock).mockResolvedValue(mockProviderNode)
      await graph.hydrate('beads://./bd-123')

      expect(graph.isStale('beads://./bd-123')).toBe(false)
    })

    it('returns true for old cached nodes', () => {
      const oldNode: StoredNode = {
        id: 'x-old',
        uuid: 'old-uuid',
        type: 'external',
        title: 'Old Node',
        source: 'beads',
        cached_at: '2020-01-01T00:00:00Z',
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
      }
      adapter.hydrateNode('beads://./bd-old', oldNode)

      expect(graph.isStale('beads://./bd-old')).toBe(true)
    })

    it('respects provider-specific TTL', () => {
      // Create graph with custom TTL
      const customGraph = createHydratingFederatedGraph(adapter, {
        storage: mockStorage as Storage,
        providerRegistry: mockProviderRegistry,
        cacheConfig: {
          defaultTTL: 1000, // 1 second
          providerTTL: {
            beads: 100, // 100ms for beads
          },
        },
      })

      // Add a node cached 500ms ago
      const recentNode: StoredNode = {
        id: 'x-recent',
        uuid: 'recent-uuid',
        type: 'external',
        title: 'Recent Node',
        source: 'beads',
        cached_at: new Date(Date.now() - 500).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      adapter.hydrateNode('beads://./bd-recent', recentNode)

      // Should be stale because beads TTL is 100ms
      expect(customGraph.isStale('beads://./bd-recent')).toBe(true)
    })
  })

  describe('DEFAULT_CACHE_CONFIG', () => {
    it('has 5 minute default TTL', () => {
      expect(DEFAULT_CACHE_CONFIG.defaultTTL).toBe(5 * 60 * 1000)
    })

    it('has staleWhileRevalidate enabled', () => {
      expect(DEFAULT_CACHE_CONFIG.staleWhileRevalidate).toBe(true)
    })
  })

  describe('inherits FederatedGraph methods', () => {
    beforeEach(async () => {
      // Setup some nodes
      const node1: StoredNode = {
        id: 'i-1',
        uuid: 'uuid-1',
        type: 'issue',
        title: 'Issue 1',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const node2: StoredNode = {
        id: 'i-2',
        uuid: 'uuid-2',
        type: 'issue',
        title: 'Issue 2',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      adapter.onNodeCreated(node1)
      adapter.onNodeCreated(node2)
      adapter.onEdgeCreated({
        id: 'e-1',
        uuid: 'edge-uuid-1',
        from_id: 'i-1',
        to_id: 'i-2',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })
    })

    it('related() works', () => {
      const related = graph.related('native://i-1', { direction: 'out' })
      expect(related).toContain('native://i-2')
    })

    it('reachable() works', () => {
      const reachable = graph.reachable('native://i-1')
      expect(reachable).toContain('native://i-2')
    })

    it('hasNode() works', () => {
      expect(graph.hasNode('native://i-1')).toBe(true)
      expect(graph.hasNode('native://non-existent')).toBe(false)
    })

    it('stats() works', () => {
      const stats = graph.stats()
      expect(stats.nodes).toBe(2)
      expect(stats.edges).toBe(1)
    })
  })

  describe('ready()', () => {
    beforeEach(() => {
      // Reset storage mock for ready tests
      ;(mockStorage.queryNodes as Mock).mockReset()
    })

    it('returns nodes with no blockers', async () => {
      const openIssue: StoredNode = {
        id: 'i-ready1',
        uuid: 'ready-uuid-1',
        type: 'issue',
        title: 'Ready Issue',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([openIssue])

      // Add to graph
      adapter.onNodeCreated(openIssue)

      const ready = await graph.ready()

      expect(ready).toContain('native://i-ready1')
    })

    it('excludes nodes with active blockers', async () => {
      const blockedIssue: StoredNode = {
        id: 'i-blocked',
        uuid: 'blocked-uuid',
        type: 'issue',
        title: 'Blocked Issue',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const blockerIssue: StoredNode = {
        id: 'i-blocker',
        uuid: 'blocker-uuid',
        type: 'issue',
        title: 'Blocker Issue',
        status: 'open', // Active blocker
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([blockedIssue])

      // Add nodes and blocking edge to graph
      adapter.onNodeCreated(blockedIssue)
      adapter.onNodeCreated(blockerIssue)
      adapter.onEdgeCreated({
        id: 'e-block',
        uuid: 'block-edge-uuid',
        from_id: 'i-blocker',
        to_id: 'i-blocked',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })

      const ready = await graph.ready()

      expect(ready).not.toContain('native://i-blocked')
    })

    it('includes nodes with closed blockers', async () => {
      const blockedIssue: StoredNode = {
        id: 'i-unblocked',
        uuid: 'unblocked-uuid',
        type: 'issue',
        title: 'Unblocked Issue',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const closedBlocker: StoredNode = {
        id: 'i-closed-blocker',
        uuid: 'closed-blocker-uuid',
        type: 'issue',
        title: 'Closed Blocker',
        status: 'closed', // Closed - no longer blocking
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([blockedIssue])

      // Add nodes and blocking edge to graph
      adapter.onNodeCreated(blockedIssue)
      adapter.onNodeCreated(closedBlocker)
      adapter.onEdgeCreated({
        id: 'e-closed-block',
        uuid: 'closed-block-edge-uuid',
        from_id: 'i-closed-blocker',
        to_id: 'i-unblocked',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })

      const ready = await graph.ready()

      expect(ready).toContain('native://i-unblocked')
    })

    it('respects limit option', async () => {
      const issues = [
        { id: 'i-r1', uuid: 'r1-uuid', type: 'issue' as const, title: 'Issue 1', status: 'open', created_at: '', updated_at: '' },
        { id: 'i-r2', uuid: 'r2-uuid', type: 'issue' as const, title: 'Issue 2', status: 'open', created_at: '', updated_at: '' },
        { id: 'i-r3', uuid: 'r3-uuid', type: 'issue' as const, title: 'Issue 3', status: 'open', created_at: '', updated_at: '' },
      ]

      ;(mockStorage.queryNodes as Mock).mockResolvedValue(issues)

      // Add to graph
      for (const issue of issues) {
        adapter.onNodeCreated(issue)
      }

      const ready = await graph.ready({ limit: 2 })

      expect(ready).toHaveLength(2)
    })

    it('filters by tags', async () => {
      const taggedIssue: StoredNode = {
        id: 'i-tagged',
        uuid: 'tagged-uuid',
        type: 'issue',
        title: 'Tagged Issue',
        status: 'open',
        tags: ['important'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([taggedIssue])
      adapter.onNodeCreated(taggedIssue)

      await graph.ready({ tags: ['important'] })

      expect(mockStorage.queryNodes).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['important'] })
      )
    })

    it('handles external blockers with external_status', async () => {
      const blockedIssue: StoredNode = {
        id: 'i-ext-blocked',
        uuid: 'ext-blocked-uuid',
        type: 'issue',
        title: 'Externally Blocked',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const externalBlocker: StoredNode = {
        id: 'x-external',
        uuid: 'external-uuid',
        type: 'external',
        title: 'External Blocker',
        uri: 'beads://./bd-123',
        source: 'beads',
        external_status: 'done', // External is done - not blocking
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([blockedIssue])

      adapter.onNodeCreated(blockedIssue)
      adapter.hydrateNode('beads://./bd-123', externalBlocker)
      adapter.onEdgeCreated({
        id: 'e-ext-block',
        uuid: 'ext-block-uuid',
        from_id: 'beads://./bd-123',
        to_id: 'i-ext-blocked',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })

      const ready = await graph.ready()

      // Should be ready because external blocker is done
      expect(ready).toContain('native://i-ext-blocked')
    })

    it('considers various closed statuses', async () => {
      const issue: StoredNode = {
        id: 'i-various',
        uuid: 'various-uuid',
        type: 'issue',
        title: 'Various Blocker Test',
        status: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Blocker with 'resolved' status
      const resolvedBlocker: StoredNode = {
        id: 'i-resolved',
        uuid: 'resolved-uuid',
        type: 'issue',
        title: 'Resolved Blocker',
        status: 'resolved',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      ;(mockStorage.queryNodes as Mock).mockResolvedValue([issue])

      adapter.onNodeCreated(issue)
      adapter.onNodeCreated(resolvedBlocker)
      adapter.onEdgeCreated({
        id: 'e-resolved-block',
        uuid: 'resolved-block-uuid',
        from_id: 'i-resolved',
        to_id: 'i-various',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })

      const ready = await graph.ready()

      // 'resolved' is a closed status, so issue should be ready
      expect(ready).toContain('native://i-various')
    })
  })
})
