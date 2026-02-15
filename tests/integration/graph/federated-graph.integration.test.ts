/**
 * Federated Graph Integration Tests
 *
 * Tests the complete federated graph system including:
 * - Schema migration (edge metadata and cached_at columns)
 * - Edge type registry with inverse relationships
 * - Graphology adapter synchronization
 * - Traversal API (related, reachable, shortestPath)
 * - Provider hydration and caching
 * - Federated ready query with external blockers
 * - Cross-provider edges
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SQLitePersister } from '../../../src/storage/sqlite.js'
import {
  createGraphologyAdapter,
  createHydratingFederatedGraph,
  createEdgeTypeRegistry,
  BUILTIN_EDGE_TYPES,
  type HydratingFederatedGraph,
  type GraphologyAdapter,
} from '../../../src/graph/index.js'
import type { Storage } from '../../../src/storage/interface.js'
import type { StoredNode, StoredEdge } from '../../../src/schema/storage.js'
import type { Provider, ProviderRegistry, ProviderNode } from '../../../src/providers/types.js'
import type { RelationshipQueryable } from '../../../src/providers/traits/RelationshipQueryable.js'
import { generateId } from '../../../src/core/id.js'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'

/**
 * Create a test node
 */
function createTestNode(overrides: Partial<StoredNode> = {}): StoredNode {
  const nodeType = overrides.type ?? 'task'
  const idType = nodeType === 'task' ? 'task' : nodeType === 'context' ? 'context' : 'external'
  const generated = overrides.id ? null : generateId(idType)
  const id = overrides.id ?? generated!.id
  const uuid = generated?.uuid ?? `uuid-${id}`

  return {
    id,
    uuid,
    type: nodeType,
    title: overrides.title ?? `Test Node ${id}`,
    content: overrides.content,
    status: overrides.status,
    priority: overrides.priority,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Create a test edge
 */
function createTestEdge(fromId: string, toId: string, type = 'blocks'): StoredEdge {
  const { id, uuid } = generateId('edge')
  return {
    id,
    uuid,
    from_id: fromId,
    to_id: toId,
    type,
    created_at: new Date().toISOString(),
  }
}

/**
 * Create a mock BeadsProvider that returns controlled responses
 */
function createMockBeadsProvider(): Provider & RelationshipQueryable {
  const nodes = new Map<string, ProviderNode>()
  const edges = new Map<string, Array<{ from: string; to: string; type: string }>>()

  return {
    name: 'beads',
    schemes: ['beads', 'bd'],
    capabilities: { read: true, write: true, search: true, watch: false },

    parseUri(uri: string) {
      if (uri.startsWith('beads://')) {
        const id = uri.replace('beads://./', '')
        return { scheme: 'beads', id, isRelative: true }
      }
      return null
    },

    buildUri(id: string) {
      return `beads://./${id}`
    },

    isValidUri(uri: string) {
      return uri.startsWith('beads://')
    },

    async get(id: string) {
      return nodes.get(id) ?? null
    },

    async list() {
      return Array.from(nodes.values())
    },

    async create(input) {
      const id = `bd-${Math.random().toString(36).slice(2, 8)}`
      const node: ProviderNode = {
        id,
        uri: `beads://./${id}`,
        type: 'issue',
        title: input.title,
        content: input.content,
        status: input.status,
        priority: input.priority,
        fetchedAt: new Date().toISOString(),
      }
      nodes.set(id, node)
      return node
    },

    async update(id, updates) {
      const existing = nodes.get(id)
      if (!existing) throw new Error('Not found')
      const updated = { ...existing, ...updates }
      nodes.set(id, updated)
      return updated
    },

    async delete(id) {
      nodes.delete(id)
    },

    async queryEdges(nodeId) {
      return edges.get(nodeId) ?? []
    },

    supportedEdgeTypes() {
      return [
        { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
      ]
    },

    // Test helpers
    _addNode(id: string, node: ProviderNode) {
      nodes.set(id, node)
    },

    _addEdges(nodeId: string, nodeEdges: Array<{ from: string; to: string; type: string }>) {
      edges.set(nodeId, nodeEdges)
    },
  } as Provider & RelationshipQueryable & {
    _addNode: (id: string, node: ProviderNode) => void
    _addEdges: (nodeId: string, edges: Array<{ from: string; to: string; type: string }>) => void
  }
}

/**
 * Create a mock provider registry
 */
function createMockProviderRegistry(beadsProvider: Provider): ProviderRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn((name) => name === 'beads' ? beadsProvider : null),
    resolveProvider: vi.fn((uri: string) => {
      if (uri.startsWith('beads://')) return beadsProvider
      if (uri.startsWith('native://')) return null // Native handled separately
      return null
    }),
    list: vi.fn(() => [beadsProvider]),
    canResolve: vi.fn((uri) => uri.startsWith('beads://') || uri.startsWith('native://')),
  }
}

describe.skipIf(!SLOW_TESTS)('Federated Graph Integration', () => {
  let tempDir: TempDirContext
  let storage: SQLitePersister
  let adapter: GraphologyAdapter
  let graph: HydratingFederatedGraph
  let beadsProvider: ReturnType<typeof createMockBeadsProvider>
  let providerRegistry: ProviderRegistry

  beforeEach(async () => {
    tempDir = await withTempDir('federated-graph-')
    storage = new SQLitePersister({
      path: tempDir.resolve('cache.db'),
      walMode: true,
    })
    storage.initialize()

    adapter = createGraphologyAdapter()
    beadsProvider = createMockBeadsProvider()
    providerRegistry = createMockProviderRegistry(beadsProvider)

    graph = createHydratingFederatedGraph(adapter, {
      storage: storage as unknown as Storage,
      providerRegistry,
      cacheConfig: {
        defaultTTL: 60000, // 1 minute for tests
      },
    })
  })

  afterEach(async () => {
    await storage.close()
    await tempDir.cleanup()
  })

  describe('Schema Migration', () => {
    it('should have metadata column on edges table', async () => {
      const edge = createTestEdge('t-1', 't-2', 'blocks')
      edge.metadata = { reason: 'dependency' }

      const node1 = createTestNode({ id: 't-1', type: 'task', status: 'open' })
      const node2 = createTestNode({ id: 't-2', type: 'task', status: 'open' })

      await storage.createNode(node1)
      await storage.createNode(node2)
      await storage.createEdge(edge)

      const loaded = await storage.getEdge(edge.id)
      expect(loaded?.metadata).toEqual({ reason: 'dependency' })
    })

    it('should have cached_at column on edges table', async () => {
      const node1 = createTestNode({ id: 't-cached1', type: 'task', status: 'open' })
      const node2 = createTestNode({ id: 't-cached2', type: 'task', status: 'open' })

      await storage.createNode(node1)
      await storage.createNode(node2)

      const edge = createTestEdge('t-cached1', 't-cached2', 'blocks')
      edge.cached_at = new Date().toISOString()

      await storage.createEdge(edge)

      const loaded = await storage.getEdge(edge.id)
      expect(loaded?.cached_at).toBe(edge.cached_at)
    })
  })

  describe('Edge Type Registry', () => {
    it('should register all built-in edge types', () => {
      const registry = createEdgeTypeRegistry()

      for (const type of BUILTIN_EDGE_TYPES) {
        const result = registry.lookup(type.name)
        expect(result).not.toBeNull()
        expect(result?.definition.name).toBe(type.name)
      }
    })

    it('should handle inverse relationships correctly', () => {
      const registry = createEdgeTypeRegistry()

      const blocksResult = registry.lookup('blocks')
      expect(blocksResult?.definition.inverseOf).toBe('blocked-by')

      const blockedByResult = registry.lookup('blocked-by')
      expect(blockedByResult?.definition.inverseOf).toBe('blocks')

      // blocks should be canonical (registered first)
      expect(blocksResult?.isCanonical).toBe(true)
      expect(blockedByResult?.isCanonical).toBe(false)
    })

    it('should identify affectsReady types', () => {
      const registry = createEdgeTypeRegistry()

      expect(registry.affectsReady('blocks')).toBe(true)
      expect(registry.affectsReady('blocked-by')).toBe(true)
      expect(registry.affectsReady('implements')).toBe(false)
      expect(registry.affectsReady('related')).toBe(false)
    })
  })

  describe('Graphology Adapter', () => {
    it('should sync nodes from storage to in-memory graph', async () => {
      const node1 = createTestNode({ id: 't-sync1', type: 'task', status: 'open' })
      const node2 = createTestNode({ id: 't-sync2', type: 'task', status: 'open' })

      await storage.createNode(node1)
      await storage.createNode(node2)

      await adapter.loadFromStorage(storage as unknown as Storage)

      expect(adapter.hasNode('native://t-sync1')).toBe(true)
      expect(adapter.hasNode('native://t-sync2')).toBe(true)
    })

    it('should sync edges from storage to in-memory graph', async () => {
      const node1 = createTestNode({ id: 't-edge1', type: 'task', status: 'open' })
      const node2 = createTestNode({ id: 't-edge2', type: 'task', status: 'open' })
      const edge = createTestEdge('t-edge1', 't-edge2', 'blocks')

      await storage.createNode(node1)
      await storage.createNode(node2)
      await storage.createEdge(edge)

      await adapter.loadFromStorage(storage as unknown as Storage)

      const edges = adapter.getEdges('native://t-edge1', 'out')
      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe('blocks')
    })

    it('should track node mutations', () => {
      const node = createTestNode({ id: 't-mut1', type: 'task', status: 'open' })

      adapter.onNodeCreated(node)
      expect(adapter.hasNode('native://t-mut1')).toBe(true)

      adapter.onNodeDeleted(node.id)
      expect(adapter.hasNode('native://t-mut1')).toBe(false)
    })
  })

  describe('Traversal API', () => {
    beforeEach(async () => {
      // Create a test graph:
      //   t-1 --blocks--> t-2 --blocks--> t-3
      //        \--implements--> c-1
      const task1 = createTestNode({ id: 't-1', type: 'task', status: 'open' })
      const task2 = createTestNode({ id: 't-2', type: 'task', status: 'open' })
      const task3 = createTestNode({ id: 't-3', type: 'task', status: 'open' })
      const context1 = createTestNode({ id: 'c-1', type: 'context' })

      await storage.createNode(task1)
      await storage.createNode(task2)
      await storage.createNode(task3)
      await storage.createNode(context1)

      await storage.createEdge(createTestEdge('t-1', 't-2', 'blocks'))
      await storage.createEdge(createTestEdge('t-2', 't-3', 'blocks'))
      await storage.createEdge(createTestEdge('t-1', 'c-1', 'implements'))

      await adapter.loadFromStorage(storage as unknown as Storage)
    })

    it('related() returns direct neighbors', () => {
      const related = graph.related('native://t-1', { direction: 'out' })

      expect(related).toContain('native://t-2')
      expect(related).toContain('native://c-1')
      expect(related).not.toContain('native://t-3')
    })

    it('related() filters by edge type', () => {
      const blocksOnly = graph.related('native://t-1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(blocksOnly).toContain('native://t-2')
      expect(blocksOnly).not.toContain('native://c-1')
    })

    it('reachable() returns transitive closure', () => {
      const reachable = graph.reachable('native://t-1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(reachable).toContain('native://t-2')
      expect(reachable).toContain('native://t-3')
    })

    it('reachable() respects maxDepth', () => {
      const reachable = graph.reachable('native://t-1', {
        direction: 'out',
        edgeType: 'blocks',
        maxDepth: 1,
      })

      expect(reachable).toContain('native://t-2')
      expect(reachable).not.toContain('native://t-3')
    })

    it('shortestPath() finds correct path', () => {
      const path = graph.shortestPath('native://t-1', 'native://t-3')

      expect(path).toEqual([
        'native://t-1',
        'native://t-2',
        'native://t-3',
      ])
    })

    it('shortestPath() returns null for unreachable nodes', () => {
      const isolatedNode = createTestNode({ id: 't-isolated', type: 'task', status: 'open' })
      adapter.onNodeCreated(isolatedNode)

      const path = graph.shortestPath('native://t-1', 'native://t-isolated')
      expect(path).toBeNull()
    })
  })

  describe('Provider Hydration', () => {
    it('should hydrate external nodes from provider', async () => {
      // Add a node to the mock provider
      beadsProvider._addNode('bd-test1', {
        id: 'bd-test1',
        uri: 'beads://./bd-test1',
        type: 'issue',
        title: 'External Issue',
        status: 'open',
        priority: 1,
        fetchedAt: new Date().toISOString(),
      })

      await graph.hydrate('beads://./bd-test1')

      expect(adapter.hasNode('beads://./bd-test1')).toBe(true)

      const nodeAttrs = adapter.getNode('beads://./bd-test1')
      expect(nodeAttrs?.title).toBe('External Issue')
    })

    it('should cache hydrated nodes to storage', async () => {
      beadsProvider._addNode('bd-cache1', {
        id: 'bd-cache1',
        uri: 'beads://./bd-cache1',
        type: 'issue',
        title: 'Cached Issue',
        status: 'open',
        fetchedAt: new Date().toISOString(),
      })

      await graph.hydrate('beads://./bd-cache1')

      // Should have been cached to storage
      // Note: The exact node ID in storage will be generated
      const nodes = await storage.queryNodes({ type: 'external' })
      const cached = nodes.find(n => n.title === 'Cached Issue')
      expect(cached).toBeDefined()
      expect(cached?.source).toBe('beads')
    })

    it('should resolve nodes with full data', async () => {
      beadsProvider._addNode('bd-resolve1', {
        id: 'bd-resolve1',
        uri: 'beads://./bd-resolve1',
        type: 'issue',
        title: 'Resolved Issue',
        content: 'Full content here',
        status: 'in_progress',
        priority: 2,
        fetchedAt: new Date().toISOString(),
      })

      const resolved = await graph.resolve('beads://./bd-resolve1')

      expect(resolved).not.toBeNull()
      expect(resolved?.uri).toBe('beads://./bd-resolve1')
      expect(resolved?.provider).toBe('beads')
      expect(resolved?.data.title).toBe('Resolved Issue')
    })
  })

  describe('Federated Ready Query', () => {
    it('should return tasks with no blockers', async () => {
      const task = createTestNode({ id: 't-ready1', type: 'task', status: 'open' })
      await storage.createNode(task)
      adapter.onNodeCreated(task)

      const ready = await graph.ready()

      expect(ready).toContain('native://t-ready1')
    })

    it('should exclude tasks blocked by active native blockers', async () => {
      const blocked = createTestNode({ id: 't-blocked1', type: 'task', status: 'open' })
      const blocker = createTestNode({ id: 't-blocker1', type: 'task', status: 'open' })

      await storage.createNode(blocked)
      await storage.createNode(blocker)
      await storage.createEdge(createTestEdge('t-blocker1', 't-blocked1', 'blocks'))

      adapter.onNodeCreated(blocked)
      adapter.onNodeCreated(blocker)
      adapter.onEdgeCreated(createTestEdge('t-blocker1', 't-blocked1', 'blocks'))

      const ready = await graph.ready()

      expect(ready).not.toContain('native://t-blocked1')
      expect(ready).toContain('native://t-blocker1')
    })

    it('should include tasks when blockers are closed', async () => {
      const blocked = createTestNode({ id: 't-unblocked1', type: 'task', status: 'open' })
      const closedBlocker = createTestNode({ id: 't-closed1', type: 'task', status: 'closed' })

      await storage.createNode(blocked)
      await storage.createNode(closedBlocker)
      await storage.createEdge(createTestEdge('t-closed1', 't-unblocked1', 'blocks'))

      adapter.onNodeCreated(blocked)
      adapter.onNodeCreated(closedBlocker)
      adapter.onEdgeCreated(createTestEdge('t-closed1', 't-unblocked1', 'blocks'))

      const ready = await graph.ready()

      expect(ready).toContain('native://t-unblocked1')
    })

    it('should consider external blockers', async () => {
      // Create native task blocked by external bead
      const blocked = createTestNode({ id: 't-extblocked', type: 'task', status: 'open' })
      await storage.createNode(blocked)
      adapter.onNodeCreated(blocked)

      // Add external blocker to provider
      beadsProvider._addNode('bd-blocker', {
        id: 'bd-blocker',
        uri: 'beads://./bd-blocker',
        type: 'issue',
        title: 'External Blocker',
        status: 'open', // Active blocker
        fetchedAt: new Date().toISOString(),
      })

      // Create cross-provider blocking edge
      adapter.onEdgeCreated({
        id: 'e-cross1',
        uuid: 'cross-uuid-1',
        from_id: 'beads://./bd-blocker',
        to_id: 't-extblocked',
        type: 'blocks',
        created_at: new Date().toISOString(),
      })

      // Hydrate the external node so it's in the graph
      await graph.hydrate('beads://./bd-blocker')

      const ready = await graph.ready()

      // Should be blocked by external blocker
      expect(ready).not.toContain('native://t-extblocked')
    })
  })

  describe('Cache Staleness', () => {
    it('should mark fresh nodes as not stale', async () => {
      beadsProvider._addNode('bd-fresh', {
        id: 'bd-fresh',
        uri: 'beads://./bd-fresh',
        type: 'issue',
        title: 'Fresh',
        status: 'open',
        fetchedAt: new Date().toISOString(),
      })

      await graph.hydrate('beads://./bd-fresh')

      expect(graph.isStale('beads://./bd-fresh')).toBe(false)
    })

    it('should invalidate cache by provider', async () => {
      beadsProvider._addNode('bd-invalidate', {
        id: 'bd-invalidate',
        uri: 'beads://./bd-invalidate',
        type: 'issue',
        title: 'To Invalidate',
        status: 'open',
        fetchedAt: new Date().toISOString(),
      })

      await graph.hydrate('beads://./bd-invalidate')
      expect(graph.isStale('beads://./bd-invalidate')).toBe(false)

      await graph.invalidateCache('beads')

      expect(graph.isStale('beads://./bd-invalidate')).toBe(true)
    })
  })

  describe('Cross-Provider Edges', () => {
    it('should handle edges between native and external nodes', async () => {
      // Create native context
      const context = createTestNode({ id: 'c-cross1', type: 'context' })
      await storage.createNode(context)
      adapter.onNodeCreated(context)

      // Add external issue
      beadsProvider._addNode('bd-impl1', {
        id: 'bd-impl1',
        uri: 'beads://./bd-impl1',
        type: 'issue',
        title: 'External Implementer',
        status: 'in_progress',
        fetchedAt: new Date().toISOString(),
      })

      await graph.hydrate('beads://./bd-impl1')

      // Create implements edge
      adapter.onEdgeCreated({
        id: 'e-impl-cross',
        uuid: 'impl-cross-uuid',
        from_id: 'beads://./bd-impl1',
        to_id: 'c-cross1',
        type: 'implements',
        created_at: new Date().toISOString(),
      })

      // Query tasks of context
      const tasks = graph.related('native://c-cross1', {
        direction: 'in',
        edgeType: 'implements',
      })

      expect(tasks).toContain('beads://./bd-impl1')
    })
  })

  describe('Edge Cases', () => {
    it('should handle cycles without infinite loop', async () => {
      const node1 = createTestNode({ id: 't-cycle1', type: 'task', status: 'open' })
      const node2 = createTestNode({ id: 't-cycle2', type: 'task', status: 'open' })
      const node3 = createTestNode({ id: 't-cycle3', type: 'task', status: 'open' })

      await storage.createNode(node1)
      await storage.createNode(node2)
      await storage.createNode(node3)

      // Create cycle: 1 -> 2 -> 3 -> 1
      await storage.createEdge(createTestEdge('t-cycle1', 't-cycle2', 'blocks'))
      await storage.createEdge(createTestEdge('t-cycle2', 't-cycle3', 'blocks'))
      await storage.createEdge(createTestEdge('t-cycle3', 't-cycle1', 'blocks'))

      await adapter.loadFromStorage(storage as unknown as Storage)

      // Should not hang - reachable handles cycles
      const reachable = graph.reachable('native://t-cycle1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(reachable).toHaveLength(2)
      expect(reachable).toContain('native://t-cycle2')
      expect(reachable).toContain('native://t-cycle3')
    })

    it('should handle missing nodes gracefully', () => {
      const related = graph.related('native://non-existent')
      expect(related).toEqual([])

      const reachable = graph.reachable('native://non-existent')
      expect(reachable).toEqual([])

      const path = graph.shortestPath('native://non-existent', 'native://also-missing')
      expect(path).toBeNull()
    })
  })
})
