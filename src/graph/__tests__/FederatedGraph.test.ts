import { describe, it, expect, beforeEach } from 'vitest'
import {
  FederatedGraphImpl,
  createFederatedGraph,
  type FederatedGraph,
} from '../FederatedGraph.js'
import { createGraphologyAdapter, type GraphologyAdapter } from '../GraphologyAdapter.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'

describe('FederatedGraph', () => {
  let adapter: GraphologyAdapter
  let graph: FederatedGraph

  beforeEach(() => {
    adapter = createGraphologyAdapter()
    graph = createFederatedGraph(adapter)
  })

  // Test fixtures - a simple graph:
  //
  //   s-spec1 ──implements──> i-issue1 ──blocks──> i-issue2 ──blocks──> i-issue3
  //                              │
  //                              └──blocks──> i-issue4
  //
  const spec1: StoredNode = {
    id: 's-spec1',
    uuid: 'uuid-spec1',
    type: 'spec',
    title: 'Spec 1',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const issue1: StoredNode = {
    id: 'i-issue1',
    uuid: 'uuid-issue1',
    type: 'issue',
    title: 'Issue 1',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const issue2: StoredNode = {
    id: 'i-issue2',
    uuid: 'uuid-issue2',
    type: 'issue',
    title: 'Issue 2',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const issue3: StoredNode = {
    id: 'i-issue3',
    uuid: 'uuid-issue3',
    type: 'issue',
    title: 'Issue 3',
    status: 'closed',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const issue4: StoredNode = {
    id: 'i-issue4',
    uuid: 'uuid-issue4',
    type: 'issue',
    title: 'Issue 4',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const edgeImplements: StoredEdge = {
    id: 'e-impl',
    uuid: 'uuid-impl',
    from_id: 'i-issue1',
    to_id: 's-spec1',
    type: 'implements',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks1: StoredEdge = {
    id: 'e-blocks1',
    uuid: 'uuid-blocks1',
    from_id: 'i-issue1',
    to_id: 'i-issue2',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks2: StoredEdge = {
    id: 'e-blocks2',
    uuid: 'uuid-blocks2',
    from_id: 'i-issue2',
    to_id: 'i-issue3',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks3: StoredEdge = {
    id: 'e-blocks3',
    uuid: 'uuid-blocks3',
    from_id: 'i-issue1',
    to_id: 'i-issue4',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  function setupGraph() {
    adapter.onNodeCreated(spec1)
    adapter.onNodeCreated(issue1)
    adapter.onNodeCreated(issue2)
    adapter.onNodeCreated(issue3)
    adapter.onNodeCreated(issue4)
    adapter.onEdgeCreated(edgeImplements)
    adapter.onEdgeCreated(edgeBlocks1)
    adapter.onEdgeCreated(edgeBlocks2)
    adapter.onEdgeCreated(edgeBlocks3)
  }

  describe('related()', () => {
    beforeEach(setupGraph)

    it('returns outgoing neighbors', () => {
      const result = graph.related('native://i-issue1', { direction: 'out' })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://s-spec1')
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue4')
    })

    it('returns incoming neighbors', () => {
      const result = graph.related('native://i-issue2', { direction: 'in' })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://i-issue1')
    })

    it('returns both directions by default', () => {
      const result = graph.related('native://i-issue2')

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue1') // incoming
      expect(result).toContain('native://i-issue3') // outgoing
    })

    it('filters by edge type (string)', () => {
      const result = graph.related('native://i-issue1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue4')
      expect(result).not.toContain('native://s-spec1')
    })

    it('filters by edge type (array)', () => {
      const result = graph.related('native://i-issue1', {
        direction: 'out',
        edgeType: ['implements'],
      })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://s-spec1')
    })

    it('returns empty for non-existent node', () => {
      const result = graph.related('native://non-existent')

      expect(result).toHaveLength(0)
    })

    it('removes duplicates with both direction', () => {
      // Create a bidirectional relationship
      adapter.onEdgeCreated({
        id: 'e-related1',
        uuid: 'uuid-related1',
        from_id: 'i-issue2',
        to_id: 'i-issue1',
        type: 'related',
        created_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.related('native://i-issue1', {
        direction: 'both',
        edgeType: ['blocks', 'related'],
      })

      // issue2 should only appear once even though there are edges in both directions
      const issue2Count = result.filter((r) => r === 'native://i-issue2').length
      expect(issue2Count).toBe(1)
    })
  })

  describe('reachable()', () => {
    beforeEach(setupGraph)

    it('returns transitively reachable nodes (out)', () => {
      const result = graph.reachable('native://i-issue1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue3')
      expect(result).toContain('native://i-issue4')
    })

    it('returns transitively reachable nodes (in)', () => {
      const result = graph.reachable('native://i-issue3', {
        direction: 'in',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue1')
    })

    it('respects maxDepth', () => {
      const result = graph.reachable('native://i-issue1', {
        direction: 'out',
        edgeType: 'blocks',
        maxDepth: 1,
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue4')
      expect(result).not.toContain('native://i-issue3') // 2 hops away
    })

    it('does not include start node', () => {
      const result = graph.reachable('native://i-issue1', { direction: 'out' })

      expect(result).not.toContain('native://i-issue1')
    })

    it('handles cycles without infinite loop', () => {
      // Create a cycle: issue3 -> issue1
      adapter.onEdgeCreated({
        id: 'e-cycle',
        uuid: 'uuid-cycle',
        from_id: 'i-issue3',
        to_id: 'i-issue1',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.reachable('native://i-issue1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      // Should terminate and include all reachable nodes exactly once
      expect(result).toHaveLength(3)
    })

    it('returns empty for non-existent node', () => {
      const result = graph.reachable('native://non-existent')

      expect(result).toHaveLength(0)
    })

    it('filters by multiple edge types', () => {
      const result = graph.reachable('native://i-issue1', {
        direction: 'out',
        edgeType: ['blocks', 'implements'],
      })

      expect(result).toHaveLength(4)
      expect(result).toContain('native://s-spec1')
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue3')
      expect(result).toContain('native://i-issue4')
    })
  })

  describe('shortestPath()', () => {
    beforeEach(setupGraph)

    it('finds shortest path', () => {
      const result = graph.shortestPath('native://i-issue1', 'native://i-issue3')

      expect(result).not.toBeNull()
      expect(result).toHaveLength(3)
      expect(result![0]).toBe('native://i-issue1')
      expect(result![1]).toBe('native://i-issue2')
      expect(result![2]).toBe('native://i-issue3')
    })

    it('returns path of length 1 for adjacent nodes', () => {
      const result = graph.shortestPath('native://i-issue1', 'native://i-issue2')

      expect(result).toHaveLength(2)
    })

    it('returns path of length 0 for same node', () => {
      const result = graph.shortestPath('native://i-issue1', 'native://i-issue1')

      expect(result).toHaveLength(1)
      expect(result![0]).toBe('native://i-issue1')
    })

    it('returns null for non-existent start node', () => {
      const result = graph.shortestPath('native://non-existent', 'native://i-issue1')

      expect(result).toBeNull()
    })

    it('returns null for non-existent end node', () => {
      const result = graph.shortestPath('native://i-issue1', 'native://non-existent')

      expect(result).toBeNull()
    })

    it('returns null when no path exists', () => {
      // Create an isolated node
      adapter.onNodeCreated({
        id: 'i-isolated',
        uuid: 'uuid-isolated',
        type: 'issue',
        title: 'Isolated',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.shortestPath('native://i-issue1', 'native://i-isolated')

      expect(result).toBeNull()
    })

    it('filters by edge types', () => {
      // issue1 -> issue2 is via 'blocks'
      // There's no 'implements' path from issue1 to issue2
      const result = graph.shortestPath('native://i-issue1', 'native://i-issue2', {
        edgeTypes: ['implements'],
      })

      expect(result).toBeNull()
    })
  })

  describe('hasPath()', () => {
    beforeEach(setupGraph)

    it('returns true when path exists', () => {
      expect(graph.hasPath('native://i-issue1', 'native://i-issue3')).toBe(true)
    })

    it('returns false when no path exists', () => {
      adapter.onNodeCreated({
        id: 'i-isolated',
        uuid: 'uuid-isolated',
        type: 'issue',
        title: 'Isolated',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })

      expect(graph.hasPath('native://i-issue1', 'native://i-isolated')).toBe(false)
    })
  })

  describe('getNode()', () => {
    beforeEach(setupGraph)

    it('returns node attributes', () => {
      const node = graph.getNode('native://i-issue1')

      expect(node).not.toBeNull()
      expect(node!.title).toBe('Issue 1')
      expect(node!.type).toBe('issue')
    })

    it('returns null for non-existent node', () => {
      expect(graph.getNode('native://non-existent')).toBeNull()
    })
  })

  describe('hasNode()', () => {
    beforeEach(setupGraph)

    it('returns true for existing node', () => {
      expect(graph.hasNode('native://i-issue1')).toBe(true)
    })

    it('returns false for non-existent node', () => {
      expect(graph.hasNode('native://non-existent')).toBe(false)
    })
  })

  describe('nodes()', () => {
    beforeEach(setupGraph)

    it('returns all node URIs', () => {
      const nodes = graph.nodes()

      expect(nodes).toHaveLength(5)
      expect(nodes).toContain('native://s-spec1')
      expect(nodes).toContain('native://i-issue1')
      expect(nodes).toContain('native://i-issue2')
      expect(nodes).toContain('native://i-issue3')
      expect(nodes).toContain('native://i-issue4')
    })
  })

  describe('stats()', () => {
    beforeEach(setupGraph)

    it('returns correct node and edge counts', () => {
      const stats = graph.stats()

      expect(stats.nodes).toBe(5)
      expect(stats.edges).toBe(4)
    })
  })

  describe('traverse()', () => {
    beforeEach(setupGraph)

    it('traverses single step pattern', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out' }],
      })) {
        results.push(result.uri)
      }

      expect(results).toContain('native://i-issue2')
      expect(results).toContain('native://i-issue4')
      expect(results).not.toContain('native://s-spec1') // implements, not blocks
    })

    it('traverses multi-step pattern', async () => {
      // First find specs, then issues that implement them
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [
          { type: 'implements', direction: 'out' }, // i-issue1 -> s-spec1
          { type: 'implements', direction: 'in' },  // s-spec1 <- other issues
        ],
      })) {
        results.push(result.uri)
      }

      // Should find s-spec1 first, then back to i-issue1
      expect(results).toContain('native://s-spec1')
      expect(results).toContain('native://i-issue1')
    })

    it('traverses with maxHops=Infinity for transitive closure', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        results.push(result.uri)
      }

      // Should find all transitively blocked issues
      expect(results).toContain('native://i-issue2')
      expect(results).toContain('native://i-issue3')
      expect(results).toContain('native://i-issue4')
    })

    it('respects limit option', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        limit: 2,
      })) {
        results.push(result.uri)
      }

      expect(results).toHaveLength(2)
    })

    it('tracks depth correctly', async () => {
      const depths: number[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        depths.push(result.depth)
      }

      // issue2 and issue4 are depth 1, issue3 is depth 2
      expect(depths).toContain(1)
      expect(depths).toContain(2)
    })

    it('tracks path correctly', async () => {
      let issue3Path: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        if (result.uri === 'native://i-issue3') {
          issue3Path = result.path
          break
        }
      }

      // Path should be: issue1 -> issue2 -> issue3
      expect(issue3Path).toEqual([
        'native://i-issue1',
        'native://i-issue2',
        'native://i-issue3',
      ])
    })

    it('handles multiple start URIs', async () => {
      const results: string[] = []

      for await (const result of graph.traverse(
        ['native://i-issue1', 'native://i-issue2'],
        { steps: [{ type: 'blocks', direction: 'out' }] }
      )) {
        results.push(result.uri)
      }

      // issue1 blocks issue2 and issue4
      // issue2 blocks issue3
      expect(results).toContain('native://i-issue2')
      expect(results).toContain('native://i-issue3')
      expect(results).toContain('native://i-issue4')
    })

    it('handles non-existent start URI', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://non-existent', {
        steps: [{ type: 'blocks', direction: 'out' }],
      })) {
        results.push(result.uri)
      }

      expect(results).toHaveLength(0)
    })

    it('handles empty steps', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [],
      })) {
        results.push(result.uri)
      }

      expect(results).toHaveLength(0)
    })

    it('respects minHops option', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', minHops: 2, maxHops: 2 }],
      })) {
        results.push(result.uri)
      }

      // Only issue3 is exactly 2 hops away via blocks
      expect(results).toContain('native://i-issue3')
      expect(results).not.toContain('native://i-issue2') // 1 hop
      expect(results).not.toContain('native://i-issue4') // 1 hop
    })

    it('handles cycles without infinite loop', async () => {
      // Add a cycle: issue3 -> issue1
      adapter.onEdgeCreated({
        id: 'e-cycle',
        uuid: 'uuid-cycle',
        from_id: 'i-issue3',
        to_id: 'i-issue1',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: 10 }],
      })) {
        results.push(result.uri)
      }

      // Should not hang, and should not include duplicates
      expect(results.length).toBeLessThanOrEqual(4)
    })

    it('includes stepIndex and edgeType in results', async () => {
      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out' }],
      })) {
        expect(result.stepIndex).toBe(0)
        expect(result.edgeType).toBe('blocks')
        break
      }
    })

    it('applies filter predicate to exclude nodes', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        filter: (uri, attrs) => {
          // Only include open issues
          return attrs?.data?.status === 'open'
        },
      })) {
        results.push(result.uri)
      }

      // Should include issue2 and issue4 (open) but not issue3 (closed)
      expect(results).toContain('native://i-issue2')
      expect(results).toContain('native://i-issue4')
      expect(results).not.toContain('native://i-issue3')
    })

    it('filter continues traversal through filtered nodes', async () => {
      // Add another edge: issue3 -> issue5
      adapter.onNodeCreated({
        id: 'i-issue5',
        uuid: 'uuid-issue5',
        type: 'issue',
        title: 'Issue 5',
        status: 'open',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })
      adapter.onEdgeCreated({
        id: 'e-blocks4',
        uuid: 'uuid-blocks4',
        from_id: 'i-issue3',
        to_id: 'i-issue5',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const results: string[] = []

      for await (const result of graph.traverse('native://i-issue1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        filter: (uri, attrs) => attrs?.data?.status === 'open',
      })) {
        results.push(result.uri)
      }

      // Should find issue5 even though it goes through filtered issue3
      expect(results).toContain('native://i-issue5')
      expect(results).not.toContain('native://i-issue3')
    })
  })

  describe('parseSelector()', () => {
    it('parses children selector (+uri)', () => {
      const result = graph.parseSelector('+native://s-spec1')

      expect(result.type).toBe('children')
      expect(result.uri).toBe('native://s-spec1')
      expect(result.original).toBe('+native://s-spec1')
    })

    it('parses descendants selector (uri+)', () => {
      const result = graph.parseSelector('native://i-issue1+')

      expect(result.type).toBe('descendants')
      expect(result.uri).toBe('native://i-issue1')
      expect(result.original).toBe('native://i-issue1+')
    })

    it('parses neighbors selector (@uri)', () => {
      const result = graph.parseSelector('@native://i-issue2')

      expect(result.type).toBe('neighbors')
      expect(result.uri).toBe('native://i-issue2')
      expect(result.original).toBe('@native://i-issue2')
    })

    it('parses literal URI', () => {
      const result = graph.parseSelector('native://i-issue1')

      expect(result.type).toBe('literal')
      expect(result.uri).toBe('native://i-issue1')
      expect(result.original).toBe('native://i-issue1')
    })
  })

  describe('expandSelector()', () => {
    beforeEach(setupGraph)

    it('expands literal to the node if exists', () => {
      const result = graph.expandSelector('native://i-issue1')

      expect(result).toEqual(['native://i-issue1'])
    })

    it('expands literal to empty if not exists', () => {
      const result = graph.expandSelector('native://non-existent')

      expect(result).toEqual([])
    })

    it('expands children selector to direct outgoing neighbors', () => {
      const result = graph.expandSelector('+native://i-issue1')

      expect(result).toHaveLength(3)
      expect(result).toContain('native://s-spec1')
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue4')
    })

    it('expands children selector with edge type filter', () => {
      const result = graph.expandSelector('+native://i-issue1', { edgeType: 'blocks' })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue4')
      expect(result).not.toContain('native://s-spec1')
    })

    it('expands descendants selector transitively', () => {
      const result = graph.expandSelector('native://i-issue1+')

      // Should include all transitively reachable nodes
      expect(result).toContain('native://s-spec1')
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue3')
      expect(result).toContain('native://i-issue4')
    })

    it('expands descendants with edge type filter', () => {
      const result = graph.expandSelector('native://i-issue1+', { edgeType: 'blocks' })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://i-issue2')
      expect(result).toContain('native://i-issue3')
      expect(result).toContain('native://i-issue4')
      expect(result).not.toContain('native://s-spec1')
    })

    it('expands neighbors selector to all connected nodes', () => {
      const result = graph.expandSelector('@native://i-issue2')

      expect(result).toHaveLength(2)
      expect(result).toContain('native://i-issue1') // incoming
      expect(result).toContain('native://i-issue3') // outgoing
    })

    it('expands neighbors with edge type filter', () => {
      const result = graph.expandSelector('@native://i-issue1', { edgeType: 'implements' })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://s-spec1')
    })

    it('returns empty for non-existent node selectors', () => {
      expect(graph.expandSelector('+native://non-existent')).toEqual([])
      expect(graph.expandSelector('native://non-existent+')).toEqual([])
      expect(graph.expandSelector('@native://non-existent')).toEqual([])
    })
  })

  describe('edgeTypes()', () => {
    it('returns all registered edge types', () => {
      const types = graph.edgeTypes()

      expect(types.length).toBeGreaterThan(0)

      // Should include built-in types
      const typeNames = types.map((t) => t.name)
      expect(typeNames).toContain('blocks')
      expect(typeNames).toContain('implements')
      expect(typeNames).toContain('parent-of')
      expect(typeNames).toContain('related')
    })

    it('includes edge type metadata', () => {
      const types = graph.edgeTypes()
      const blocksType = types.find((t) => t.name === 'blocks')

      expect(blocksType).toBeDefined()
      expect(blocksType!.description).toBeDefined()
      expect(blocksType!.inverseOf).toBe('blocked-by')
      expect(blocksType!.affectsReady).toBe(true)
      expect(blocksType!.direction).toBe('directed')
    })
  })

  describe('capabilities()', () => {
    it('returns graph capabilities', () => {
      const caps = graph.capabilities()

      expect(caps.edgeTypes).toBeDefined()
      expect(caps.edgeTypes.length).toBeGreaterThan(0)
    })

    it('includes ready-affecting types', () => {
      const caps = graph.capabilities()

      expect(caps.readyAffectingTypes).toContain('blocks')
      expect(caps.readyAffectingTypes).toContain('blocked-by')
    })

    it('includes provider-specific capabilities', () => {
      const caps = graph.capabilities()

      expect(caps.providers).toBeDefined()
      expect(caps.providers.get('native')).toBeDefined()

      const nativeTypes = caps.providers.get('native')!
      const nativeTypeNames = nativeTypes.map((t) => t.name)
      expect(nativeTypeNames).toContain('blocks')
      expect(nativeTypeNames).toContain('implements')
    })
  })
})
