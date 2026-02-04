import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  GraphologyAdapterImpl,
  createGraphologyAdapter,
  type GraphologyAdapter,
} from '../GraphologyAdapter.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'
import type { Storage } from '../../storage/interface.js'

describe('GraphologyAdapter', () => {
  let adapter: GraphologyAdapter

  beforeEach(() => {
    adapter = createGraphologyAdapter()
  })

  // Test fixtures
  const testSpec: StoredNode = {
    id: 's-a2b3',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'spec',
    title: 'Test Spec',
    content: 'Some specification content',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  }

  const testIssue: StoredNode = {
    id: 'i-x7k9',
    uuid: '550e8400-e29b-41d4-a716-446655440001',
    type: 'issue',
    title: 'Test Issue',
    status: 'open',
    priority: 1,
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  }

  const testExternalNode: StoredNode = {
    id: 'x-ext1',
    uuid: '550e8400-e29b-41d4-a716-446655440002',
    type: 'external',
    title: 'External Node',
    uri: 'beads://./bd-123',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  }

  const testEdge: StoredEdge = {
    id: 'x-r8s9',
    uuid: '550e8400-e29b-41d4-a716-446655440010',
    from_id: 'i-x7k9',
    to_id: 's-a2b3',
    type: 'implements',
    created_at: '2025-01-26T10:00:00Z',
  }

  const testBlocksEdge: StoredEdge = {
    id: 'x-b1c2',
    uuid: '550e8400-e29b-41d4-a716-446655440011',
    from_id: 's-a2b3',
    to_id: 'i-x7k9',
    type: 'blocks',
    created_at: '2025-01-26T09:30:00Z',
    metadata: { reason: 'spec incomplete' },
  }

  describe('nodeToUri', () => {
    it('converts native nodes to native:// URI', () => {
      expect(adapter.nodeToUri(testSpec)).toBe('native://s-a2b3')
      expect(adapter.nodeToUri(testIssue)).toBe('native://i-x7k9')
    })

    it('uses existing URI for external nodes', () => {
      expect(adapter.nodeToUri(testExternalNode)).toBe('beads://./bd-123')
    })

    it('falls back to native:// for external nodes without URI', () => {
      const externalWithoutUri: StoredNode = {
        ...testExternalNode,
        uri: undefined,
      }
      expect(adapter.nodeToUri(externalWithoutUri)).toBe('native://x-ext1')
    })
  })

  describe('onNodeCreated', () => {
    it('adds node to graph', () => {
      adapter.onNodeCreated(testSpec)

      expect(adapter.hasNode('native://s-a2b3')).toBe(true)
      const attrs = adapter.getNode('native://s-a2b3')
      expect(attrs?.title).toBe('Test Spec')
      expect(attrs?.type).toBe('spec')
    })

    it('stores full node data', () => {
      adapter.onNodeCreated(testIssue)

      const attrs = adapter.getNode('native://i-x7k9')
      expect(attrs?.data.status).toBe('open')
      expect(attrs?.data.priority).toBe(1)
    })

    it('does not duplicate nodes', () => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testSpec)

      expect(adapter.graph.order).toBe(1)
    })
  })

  describe('onNodeUpdated', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testIssue)
    })

    it('updates node attributes', () => {
      adapter.onNodeUpdated('i-x7k9', { status: 'closed', title: 'Updated' })

      const attrs = adapter.getNode('native://i-x7k9')
      expect(attrs?.status).toBe('closed')
      expect(attrs?.title).toBe('Updated')
    })

    it('preserves unchanged attributes', () => {
      adapter.onNodeUpdated('i-x7k9', { status: 'closed' })

      const attrs = adapter.getNode('native://i-x7k9')
      expect(attrs?.title).toBe('Test Issue')
      expect(attrs?.priority).toBe(1)
    })

    it('ignores updates for non-existent nodes', () => {
      adapter.onNodeUpdated('non-existent', { title: 'New' })
      expect(adapter.hasNode('native://non-existent')).toBe(false)
    })
  })

  describe('onNodeDeleted', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
      adapter.onEdgeCreated(testEdge)
    })

    it('removes node from graph', () => {
      adapter.onNodeDeleted('s-a2b3')

      expect(adapter.hasNode('native://s-a2b3')).toBe(false)
    })

    it('removes connected edges', () => {
      adapter.onNodeDeleted('s-a2b3')

      expect(adapter.graph.size).toBe(0)
    })

    it('ignores deletion of non-existent nodes', () => {
      adapter.onNodeDeleted('non-existent')
      expect(adapter.graph.order).toBe(2)
    })
  })

  describe('onEdgeCreated', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
    })

    it('adds edge to graph', () => {
      adapter.onEdgeCreated(testEdge)

      expect(adapter.graph.size).toBe(1)
    })

    it('stores edge attributes', () => {
      adapter.onEdgeCreated(testBlocksEdge)

      const edges = adapter.getEdges('native://s-a2b3', 'out')
      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe('blocks')
      expect(edges[0].metadata?.reason).toBe('spec incomplete')
    })

    it('creates placeholder nodes for missing endpoints', () => {
      const edgeWithMissing: StoredEdge = {
        ...testEdge,
        id: 'x-miss',
        from_id: 'i-missing',
        to_id: 's-a2b3',
      }
      adapter.onEdgeCreated(edgeWithMissing)

      expect(adapter.hasNode('native://i-missing')).toBe(true)
      const attrs = adapter.getNode('native://i-missing')
      expect(attrs?.type).toBe('external')
      expect(attrs?.title).toContain('Unresolved')
    })

    it('handles URI-style IDs in edges', () => {
      const externalEdge: StoredEdge = {
        id: 'x-ext-edge',
        uuid: 'ext-uuid',
        from_id: 'beads://./bd-123',
        to_id: 's-a2b3',
        type: 'blocks',
        created_at: new Date().toISOString(),
      }
      adapter.onEdgeCreated(externalEdge)

      expect(adapter.hasNode('beads://./bd-123')).toBe(true)
      expect(adapter.graph.size).toBe(1)
    })
  })

  describe('onEdgeDeleted', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
      adapter.onEdgeCreated(testEdge)
    })

    it('removes edge from graph', () => {
      adapter.onEdgeDeleted('x-r8s9')

      expect(adapter.graph.size).toBe(0)
    })

    it('preserves nodes after edge deletion', () => {
      adapter.onEdgeDeleted('x-r8s9')

      expect(adapter.hasNode('native://s-a2b3')).toBe(true)
      expect(adapter.hasNode('native://i-x7k9')).toBe(true)
    })

    it('ignores deletion of non-existent edges', () => {
      adapter.onEdgeDeleted('non-existent')
      expect(adapter.graph.size).toBe(1)
    })
  })

  describe('hydrateNode', () => {
    it('adds new node with given URI', () => {
      adapter.hydrateNode('beads://./bd-123', testExternalNode)

      expect(adapter.hasNode('beads://./bd-123')).toBe(true)
      const attrs = adapter.getNode('beads://./bd-123')
      expect(attrs?.title).toBe('External Node')
    })

    it('updates existing node', () => {
      adapter.hydrateNode('beads://./bd-123', testExternalNode)
      adapter.hydrateNode('beads://./bd-123', {
        ...testExternalNode,
        title: 'Updated Title',
      })

      const attrs = adapter.getNode('beads://./bd-123')
      expect(attrs?.title).toBe('Updated Title')
      expect(adapter.graph.order).toBe(1)
    })
  })

  describe('hydrateEdges', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
    })

    it('adds multiple edges', () => {
      adapter.hydrateEdges('native://i-x7k9', [testEdge, testBlocksEdge])

      expect(adapter.graph.size).toBe(2)
    })

    it('skips existing edges', () => {
      adapter.onEdgeCreated(testEdge)
      adapter.hydrateEdges('native://i-x7k9', [testEdge, testBlocksEdge])

      expect(adapter.graph.size).toBe(2)
    })
  })

  describe('getEdges', () => {
    beforeEach(() => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
      adapter.onEdgeCreated(testEdge)
      adapter.onEdgeCreated(testBlocksEdge)
    })

    it('returns incoming edges', () => {
      const edges = adapter.getEdges('native://s-a2b3', 'in')

      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe('implements')
    })

    it('returns outgoing edges', () => {
      const edges = adapter.getEdges('native://s-a2b3', 'out')

      expect(edges).toHaveLength(1)
      expect(edges[0].type).toBe('blocks')
    })

    it('returns all edges with direction both', () => {
      const edges = adapter.getEdges('native://s-a2b3', 'both')

      expect(edges).toHaveLength(2)
    })

    it('defaults to both direction', () => {
      const edges = adapter.getEdges('native://s-a2b3')

      expect(edges).toHaveLength(2)
    })

    it('returns empty for non-existent node', () => {
      const edges = adapter.getEdges('native://non-existent')

      expect(edges).toHaveLength(0)
    })
  })

  describe('loadFromStorage', () => {
    it('loads nodes and edges from storage', async () => {
      const mockStorage: Partial<Storage> = {
        queryNodes: vi.fn().mockResolvedValue([testSpec, testIssue]),
        getEdgesFrom: vi.fn().mockImplementation((id: string) => {
          if (id === 's-a2b3') return Promise.resolve([testBlocksEdge])
          if (id === 'i-x7k9') return Promise.resolve([testEdge])
          return Promise.resolve([])
        }),
      }

      await adapter.loadFromStorage(mockStorage as Storage)

      expect(adapter.hasNode('native://s-a2b3')).toBe(true)
      expect(adapter.hasNode('native://i-x7k9')).toBe(true)
      expect(adapter.graph.size).toBe(2)
    })

    it('clears existing data before loading', async () => {
      adapter.onNodeCreated(testSpec)

      const mockStorage: Partial<Storage> = {
        queryNodes: vi.fn().mockResolvedValue([testIssue]),
        getEdgesFrom: vi.fn().mockResolvedValue([]),
      }

      await adapter.loadFromStorage(mockStorage as Storage)

      expect(adapter.hasNode('native://s-a2b3')).toBe(false)
      expect(adapter.hasNode('native://i-x7k9')).toBe(true)
      expect(adapter.graph.order).toBe(1)
    })

    it('deduplicates edges', async () => {
      const mockStorage: Partial<Storage> = {
        queryNodes: vi.fn().mockResolvedValue([testSpec, testIssue]),
        getEdgesFrom: vi.fn().mockImplementation((id: string) => {
          // Both nodes return the same edge (from different perspectives)
          return Promise.resolve([testEdge])
        }),
      }

      await adapter.loadFromStorage(mockStorage as Storage)

      // Edge should only be added once
      expect(adapter.graph.size).toBe(1)
    })
  })

  describe('clear', () => {
    it('removes all nodes and edges', () => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
      adapter.onEdgeCreated(testEdge)

      adapter.clear()

      expect(adapter.graph.order).toBe(0)
      expect(adapter.graph.size).toBe(0)
    })
  })

  describe('graph properties', () => {
    it('is a multi-edge directed graph', () => {
      expect(adapter.graph.type).toBe('directed')
      expect(adapter.graph.multi).toBe(true)
    })

    it('allows multiple edges between same nodes', () => {
      adapter.onNodeCreated(testSpec)
      adapter.onNodeCreated(testIssue)
      adapter.onEdgeCreated(testEdge)
      adapter.onEdgeCreated({
        ...testEdge,
        id: 'x-another',
        uuid: 'another-uuid',
        type: 'references',
      })

      expect(adapter.graph.size).toBe(2)
    })
  })
})
