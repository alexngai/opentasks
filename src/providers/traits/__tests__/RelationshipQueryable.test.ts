import { describe, it, expect } from 'vitest'
import {
  isRelationshipQueryable,
  filterEdgesByType,
  filterEdgesByDirection,
  getNeighborFromEdge,
  type ProviderEdge,
  type RelationshipQueryable,
  type EdgeTypeSupport,
} from '../RelationshipQueryable.js'
import type { Provider, ProviderCapabilities, ProviderNode, ParsedUri } from '../../types.js'

// Mock provider that doesn't implement RelationshipQueryable
const mockBasicProvider: Provider = {
  name: 'basic',
  schemes: ['basic'],
  capabilities: { read: true, write: false, search: false, watch: false, mount: false, feedback: false },
  parseUri: () => null,
  buildUri: (id) => `basic://${id}`,
  isValidUri: () => false,
  get: async () => null,
  list: async () => [],
  create: async () => ({} as ProviderNode),
  update: async () => ({} as ProviderNode),
  delete: async () => {},
}

// Mock provider that implements RelationshipQueryable
const mockRelationshipProvider: Provider & RelationshipQueryable = {
  name: 'relationship',
  schemes: ['rel'],
  capabilities: { read: true, write: true, search: false, watch: false, mount: true, feedback: false },
  parseUri: (uri) => {
    if (uri.startsWith('rel://')) {
      return { scheme: 'rel', id: uri.slice(6), isRelative: false }
    }
    return null
  },
  buildUri: (id) => `rel://${id}`,
  isValidUri: (uri) => uri.startsWith('rel://'),
  get: async () => null,
  list: async () => [],
  create: async () => ({} as ProviderNode),
  update: async () => ({} as ProviderNode),
  delete: async () => {},
  queryEdges: async (nodeId, options) => {
    const allEdges: ProviderEdge[] = [
      { from: 'node-1', to: 'node-2', type: 'blocks' },
      { from: 'node-3', to: 'node-1', type: 'blocks' },
      { from: 'node-1', to: 'node-4', type: 'related' },
    ]

    let edges = allEdges.filter(
      (e) => e.from === nodeId || e.to === nodeId
    )

    if (options?.edgeType) {
      edges = edges.filter((e) => e.type === options.edgeType)
    }

    if (options?.direction === 'in') {
      edges = edges.filter((e) => e.to === nodeId)
    } else if (options?.direction === 'out') {
      edges = edges.filter((e) => e.from === nodeId)
    }

    return edges
  },
  supportedEdgeTypes: () => [
    { type: 'blocks', canQuery: true, canCreate: true, canDelete: true },
    { type: 'related', canQuery: true, canCreate: false, canDelete: false },
  ],
}

describe('isRelationshipQueryable', () => {
  it('returns false for providers without queryEdges', () => {
    expect(isRelationshipQueryable(mockBasicProvider)).toBe(false)
  })

  it('returns true for providers with queryEdges and supportedEdgeTypes', () => {
    expect(isRelationshipQueryable(mockRelationshipProvider)).toBe(true)
  })

  it('returns false for providers with only queryEdges', () => {
    const partialProvider = {
      ...mockBasicProvider,
      queryEdges: async () => [],
    }
    expect(isRelationshipQueryable(partialProvider as Provider)).toBe(false)
  })

  it('returns false for providers with only supportedEdgeTypes', () => {
    const partialProvider = {
      ...mockBasicProvider,
      supportedEdgeTypes: () => [],
    }
    expect(isRelationshipQueryable(partialProvider as Provider)).toBe(false)
  })
})

describe('RelationshipQueryable implementation', () => {
  it('queries all edges for a node', async () => {
    const edges = await mockRelationshipProvider.queryEdges('node-1')
    expect(edges).toHaveLength(3)
  })

  it('filters by edge type', async () => {
    const edges = await mockRelationshipProvider.queryEdges('node-1', {
      edgeType: 'blocks',
    })
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.type === 'blocks')).toBe(true)
  })

  it('filters by direction in', async () => {
    const edges = await mockRelationshipProvider.queryEdges('node-1', {
      direction: 'in',
    })
    expect(edges).toHaveLength(1)
    expect(edges[0].to).toBe('node-1')
  })

  it('filters by direction out', async () => {
    const edges = await mockRelationshipProvider.queryEdges('node-1', {
      direction: 'out',
    })
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.from === 'node-1')).toBe(true)
  })

  it('returns supported edge types', () => {
    const types = mockRelationshipProvider.supportedEdgeTypes()
    expect(types).toHaveLength(2)
    expect(types[0].type).toBe('blocks')
    expect(types[0].canCreate).toBe(true)
    expect(types[1].type).toBe('related')
    expect(types[1].canCreate).toBe(false)
  })
})

describe('filterEdgesByType', () => {
  const edges: ProviderEdge[] = [
    { from: 'a', to: 'b', type: 'blocks' },
    { from: 'b', to: 'c', type: 'blocks' },
    { from: 'a', to: 'c', type: 'related' },
  ]

  it('filters edges by type', () => {
    const result = filterEdgesByType(edges, 'blocks')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.type === 'blocks')).toBe(true)
  })

  it('returns empty for non-matching type', () => {
    const result = filterEdgesByType(edges, 'implements')
    expect(result).toHaveLength(0)
  })
})

describe('filterEdgesByDirection', () => {
  const edges: ProviderEdge[] = [
    { from: 'a', to: 'b', type: 'blocks' },
    { from: 'b', to: 'a', type: 'blocks' },
    { from: 'a', to: 'c', type: 'related' },
  ]

  it('filters incoming edges', () => {
    const result = filterEdgesByDirection(edges, 'a', 'in')
    expect(result).toHaveLength(1)
    expect(result[0].from).toBe('b')
    expect(result[0].to).toBe('a')
  })

  it('filters outgoing edges', () => {
    const result = filterEdgesByDirection(edges, 'a', 'out')
    expect(result).toHaveLength(2)
    expect(result.every((e) => e.from === 'a')).toBe(true)
  })

  it('returns both directions', () => {
    const result = filterEdgesByDirection(edges, 'a', 'both')
    expect(result).toHaveLength(3)
  })

  it('returns empty for unconnected node', () => {
    const result = filterEdgesByDirection(edges, 'z', 'both')
    expect(result).toHaveLength(0)
  })
})

describe('getNeighborFromEdge', () => {
  const edge: ProviderEdge = { from: 'a', to: 'b', type: 'blocks' }

  it('returns target when nodeId is source', () => {
    expect(getNeighborFromEdge(edge, 'a')).toBe('b')
  })

  it('returns source when nodeId is target', () => {
    expect(getNeighborFromEdge(edge, 'b')).toBe('a')
  })

  it('returns null when nodeId not in edge', () => {
    expect(getNeighborFromEdge(edge, 'c')).toBeNull()
  })
})
