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
  //   c-context1 ──implements──> t-task1 ──blocks──> t-task2 ──blocks──> t-task3
  //                              │
  //                              └──blocks──> t-task4
  //
  const context1: StoredNode = {
    id: 'c-context1',
    uuid: 'uuid-context1',
    type: 'context',
    title: 'Context 1',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const task1: StoredNode = {
    id: 't-task1',
    uuid: 'uuid-task1',
    type: 'task',
    title: 'Task 1',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const task2: StoredNode = {
    id: 't-task2',
    uuid: 'uuid-task2',
    type: 'task',
    title: 'Task 2',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const task3: StoredNode = {
    id: 't-task3',
    uuid: 'uuid-task3',
    type: 'task',
    title: 'Task 3',
    status: 'closed',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const task4: StoredNode = {
    id: 't-task4',
    uuid: 'uuid-task4',
    type: 'task',
    title: 'Task 4',
    status: 'open',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  }

  const edgeImplements: StoredEdge = {
    id: 'e-impl',
    uuid: 'uuid-impl',
    from_id: 't-task1',
    to_id: 'c-context1',
    type: 'implements',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks1: StoredEdge = {
    id: 'e-blocks1',
    uuid: 'uuid-blocks1',
    from_id: 't-task1',
    to_id: 't-task2',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks2: StoredEdge = {
    id: 'e-blocks2',
    uuid: 'uuid-blocks2',
    from_id: 't-task2',
    to_id: 't-task3',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  const edgeBlocks3: StoredEdge = {
    id: 'e-blocks3',
    uuid: 'uuid-blocks3',
    from_id: 't-task1',
    to_id: 't-task4',
    type: 'blocks',
    created_at: '2025-01-01T00:00:00Z',
  }

  function setupGraph() {
    adapter.onNodeCreated(context1)
    adapter.onNodeCreated(task1)
    adapter.onNodeCreated(task2)
    adapter.onNodeCreated(task3)
    adapter.onNodeCreated(task4)
    adapter.onEdgeCreated(edgeImplements)
    adapter.onEdgeCreated(edgeBlocks1)
    adapter.onEdgeCreated(edgeBlocks2)
    adapter.onEdgeCreated(edgeBlocks3)
  }

  describe('related()', () => {
    beforeEach(setupGraph)

    it('returns outgoing neighbors', () => {
      const result = graph.related('native://t-task1', { direction: 'out' })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://c-context1')
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task4')
    })

    it('returns incoming neighbors', () => {
      const result = graph.related('native://t-task2', { direction: 'in' })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://t-task1')
    })

    it('returns both directions by default', () => {
      const result = graph.related('native://t-task2')

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task1') // incoming
      expect(result).toContain('native://t-task3') // outgoing
    })

    it('filters by edge type (string)', () => {
      const result = graph.related('native://t-task1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task4')
      expect(result).not.toContain('native://c-context1')
    })

    it('filters by edge type (array)', () => {
      const result = graph.related('native://t-task1', {
        direction: 'out',
        edgeType: ['implements'],
      })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://c-context1')
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
        from_id: 't-task2',
        to_id: 't-task1',
        type: 'related',
        created_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.related('native://t-task1', {
        direction: 'both',
        edgeType: ['blocks', 'related'],
      })

      // task2 should only appear once even though there are edges in both directions
      const task2Count = result.filter((r) => r === 'native://t-task2').length
      expect(task2Count).toBe(1)
    })
  })

  describe('reachable()', () => {
    beforeEach(setupGraph)

    it('returns transitively reachable nodes (out)', () => {
      const result = graph.reachable('native://t-task1', {
        direction: 'out',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task3')
      expect(result).toContain('native://t-task4')
    })

    it('returns transitively reachable nodes (in)', () => {
      const result = graph.reachable('native://t-task3', {
        direction: 'in',
        edgeType: 'blocks',
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task1')
    })

    it('respects maxDepth', () => {
      const result = graph.reachable('native://t-task1', {
        direction: 'out',
        edgeType: 'blocks',
        maxDepth: 1,
      })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task4')
      expect(result).not.toContain('native://t-task3') // 2 hops away
    })

    it('does not include start node', () => {
      const result = graph.reachable('native://t-task1', { direction: 'out' })

      expect(result).not.toContain('native://t-task1')
    })

    it('handles cycles without infinite loop', () => {
      // Create a cycle: task3 -> task1
      adapter.onEdgeCreated({
        id: 'e-cycle',
        uuid: 'uuid-cycle',
        from_id: 't-task3',
        to_id: 't-task1',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.reachable('native://t-task1', {
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
      const result = graph.reachable('native://t-task1', {
        direction: 'out',
        edgeType: ['blocks', 'implements'],
      })

      expect(result).toHaveLength(4)
      expect(result).toContain('native://c-context1')
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task3')
      expect(result).toContain('native://t-task4')
    })
  })

  describe('shortestPath()', () => {
    beforeEach(setupGraph)

    it('finds shortest path', () => {
      const result = graph.shortestPath('native://t-task1', 'native://t-task3')

      expect(result).not.toBeNull()
      expect(result).toHaveLength(3)
      expect(result![0]).toBe('native://t-task1')
      expect(result![1]).toBe('native://t-task2')
      expect(result![2]).toBe('native://t-task3')
    })

    it('returns path of length 1 for adjacent nodes', () => {
      const result = graph.shortestPath('native://t-task1', 'native://t-task2')

      expect(result).toHaveLength(2)
    })

    it('returns path of length 0 for same node', () => {
      const result = graph.shortestPath('native://t-task1', 'native://t-task1')

      expect(result).toHaveLength(1)
      expect(result![0]).toBe('native://t-task1')
    })

    it('returns null for non-existent start node', () => {
      const result = graph.shortestPath('native://non-existent', 'native://t-task1')

      expect(result).toBeNull()
    })

    it('returns null for non-existent end node', () => {
      const result = graph.shortestPath('native://t-task1', 'native://non-existent')

      expect(result).toBeNull()
    })

    it('returns null when no path exists', () => {
      // Create an isolated node
      adapter.onNodeCreated({
        id: 't-isolated',
        uuid: 'uuid-isolated',
        type: 'task',
        title: 'Isolated',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })

      const result = graph.shortestPath('native://t-task1', 'native://t-isolated')

      expect(result).toBeNull()
    })

    it('filters by edge types', () => {
      // task1 -> task2 is via 'blocks'
      // There's no 'implements' path from task1 to task2
      const result = graph.shortestPath('native://t-task1', 'native://t-task2', {
        edgeTypes: ['implements'],
      })

      expect(result).toBeNull()
    })
  })

  describe('hasPath()', () => {
    beforeEach(setupGraph)

    it('returns true when path exists', () => {
      expect(graph.hasPath('native://t-task1', 'native://t-task3')).toBe(true)
    })

    it('returns false when no path exists', () => {
      adapter.onNodeCreated({
        id: 't-isolated',
        uuid: 'uuid-isolated',
        type: 'task',
        title: 'Isolated',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })

      expect(graph.hasPath('native://t-task1', 'native://t-isolated')).toBe(false)
    })
  })

  describe('getNode()', () => {
    beforeEach(setupGraph)

    it('returns node attributes', () => {
      const node = graph.getNode('native://t-task1')

      expect(node).not.toBeNull()
      expect(node!.title).toBe('Task 1')
      expect(node!.type).toBe('task')
    })

    it('returns null for non-existent node', () => {
      expect(graph.getNode('native://non-existent')).toBeNull()
    })
  })

  describe('hasNode()', () => {
    beforeEach(setupGraph)

    it('returns true for existing node', () => {
      expect(graph.hasNode('native://t-task1')).toBe(true)
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
      expect(nodes).toContain('native://c-context1')
      expect(nodes).toContain('native://t-task1')
      expect(nodes).toContain('native://t-task2')
      expect(nodes).toContain('native://t-task3')
      expect(nodes).toContain('native://t-task4')
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

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out' }],
      })) {
        results.push(result.uri)
      }

      expect(results).toContain('native://t-task2')
      expect(results).toContain('native://t-task4')
      expect(results).not.toContain('native://c-context1') // implements, not blocks
    })

    it('traverses multi-step pattern', async () => {
      // First find contexts, then tasks that implement them
      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [
          { type: 'implements', direction: 'out' }, // t-task1 -> c-context1
          { type: 'implements', direction: 'in' },  // c-context1 <- other tasks
        ],
      })) {
        results.push(result.uri)
      }

      // Should find c-context1 first, then back to t-task1
      expect(results).toContain('native://c-context1')
      expect(results).toContain('native://t-task1')
    })

    it('traverses with maxHops=Infinity for transitive closure', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        results.push(result.uri)
      }

      // Should find all transitively blocked tasks
      expect(results).toContain('native://t-task2')
      expect(results).toContain('native://t-task3')
      expect(results).toContain('native://t-task4')
    })

    it('respects limit option', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        limit: 2,
      })) {
        results.push(result.uri)
      }

      expect(results).toHaveLength(2)
    })

    it('tracks depth correctly', async () => {
      const depths: number[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        depths.push(result.depth)
      }

      // task2 and task4 are depth 1, task3 is depth 2
      expect(depths).toContain(1)
      expect(depths).toContain(2)
    })

    it('tracks path correctly', async () => {
      let task3Path: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
      })) {
        if (result.uri === 'native://t-task3') {
          task3Path = result.path
          break
        }
      }

      // Path should be: task1 -> task2 -> task3
      expect(task3Path).toEqual([
        'native://t-task1',
        'native://t-task2',
        'native://t-task3',
      ])
    })

    it('handles multiple start URIs', async () => {
      const results: string[] = []

      for await (const result of graph.traverse(
        ['native://t-task1', 'native://t-task2'],
        { steps: [{ type: 'blocks', direction: 'out' }] }
      )) {
        results.push(result.uri)
      }

      // task1 blocks task2 and task4
      // task2 blocks task3
      expect(results).toContain('native://t-task2')
      expect(results).toContain('native://t-task3')
      expect(results).toContain('native://t-task4')
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

      for await (const result of graph.traverse('native://t-task1', {
        steps: [],
      })) {
        results.push(result.uri)
      }

      expect(results).toHaveLength(0)
    })

    it('respects minHops option', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', minHops: 2, maxHops: 2 }],
      })) {
        results.push(result.uri)
      }

      // Only task3 is exactly 2 hops away via blocks
      expect(results).toContain('native://t-task3')
      expect(results).not.toContain('native://t-task2') // 1 hop
      expect(results).not.toContain('native://t-task4') // 1 hop
    })

    it('handles cycles without infinite loop', async () => {
      // Add a cycle: task3 -> task1
      adapter.onEdgeCreated({
        id: 'e-cycle',
        uuid: 'uuid-cycle',
        from_id: 't-task3',
        to_id: 't-task1',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: 10 }],
      })) {
        results.push(result.uri)
      }

      // Should not hang, and should not include duplicates
      expect(results.length).toBeLessThanOrEqual(4)
    })

    it('includes stepIndex and edgeType in results', async () => {
      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out' }],
      })) {
        expect(result.stepIndex).toBe(0)
        expect(result.edgeType).toBe('blocks')
        break
      }
    })

    it('applies filter predicate to exclude nodes', async () => {
      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        filter: (uri, attrs) => {
          // Only include open tasks
          return attrs?.data?.status === 'open'
        },
      })) {
        results.push(result.uri)
      }

      // Should include task2 and task4 (open) but not task3 (closed)
      expect(results).toContain('native://t-task2')
      expect(results).toContain('native://t-task4')
      expect(results).not.toContain('native://t-task3')
    })

    it('filter continues traversal through filtered nodes', async () => {
      // Add another edge: task3 -> task5
      adapter.onNodeCreated({
        id: 't-task5',
        uuid: 'uuid-task5',
        type: 'task',
        title: 'Task 5',
        status: 'open',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      })
      adapter.onEdgeCreated({
        id: 'e-blocks4',
        uuid: 'uuid-blocks4',
        from_id: 't-task3',
        to_id: 't-task5',
        type: 'blocks',
        created_at: '2025-01-01T00:00:00Z',
      })

      const results: string[] = []

      for await (const result of graph.traverse('native://t-task1', {
        steps: [{ type: 'blocks', direction: 'out', maxHops: Infinity }],
        filter: (uri, attrs) => attrs?.data?.status === 'open',
      })) {
        results.push(result.uri)
      }

      // Should find task5 even though it goes through filtered task3
      expect(results).toContain('native://t-task5')
      expect(results).not.toContain('native://t-task3')
    })
  })

  describe('parseSelector()', () => {
    it('parses children selector (+uri)', () => {
      const result = graph.parseSelector('+native://c-context1')

      expect(result.type).toBe('children')
      expect(result.uri).toBe('native://c-context1')
      expect(result.original).toBe('+native://c-context1')
    })

    it('parses descendants selector (uri+)', () => {
      const result = graph.parseSelector('native://t-task1+')

      expect(result.type).toBe('descendants')
      expect(result.uri).toBe('native://t-task1')
      expect(result.original).toBe('native://t-task1+')
    })

    it('parses neighbors selector (@uri)', () => {
      const result = graph.parseSelector('@native://t-task2')

      expect(result.type).toBe('neighbors')
      expect(result.uri).toBe('native://t-task2')
      expect(result.original).toBe('@native://t-task2')
    })

    it('parses literal URI', () => {
      const result = graph.parseSelector('native://t-task1')

      expect(result.type).toBe('literal')
      expect(result.uri).toBe('native://t-task1')
      expect(result.original).toBe('native://t-task1')
    })
  })

  describe('expandSelector()', () => {
    beforeEach(setupGraph)

    it('expands literal to the node if exists', () => {
      const result = graph.expandSelector('native://t-task1')

      expect(result).toEqual(['native://t-task1'])
    })

    it('expands literal to empty if not exists', () => {
      const result = graph.expandSelector('native://non-existent')

      expect(result).toEqual([])
    })

    it('expands children selector to direct outgoing neighbors', () => {
      const result = graph.expandSelector('+native://t-task1')

      expect(result).toHaveLength(3)
      expect(result).toContain('native://c-context1')
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task4')
    })

    it('expands children selector with edge type filter', () => {
      const result = graph.expandSelector('+native://t-task1', { edgeType: 'blocks' })

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task4')
      expect(result).not.toContain('native://c-context1')
    })

    it('expands descendants selector transitively', () => {
      const result = graph.expandSelector('native://t-task1+')

      // Should include all transitively reachable nodes
      expect(result).toContain('native://c-context1')
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task3')
      expect(result).toContain('native://t-task4')
    })

    it('expands descendants with edge type filter', () => {
      const result = graph.expandSelector('native://t-task1+', { edgeType: 'blocks' })

      expect(result).toHaveLength(3)
      expect(result).toContain('native://t-task2')
      expect(result).toContain('native://t-task3')
      expect(result).toContain('native://t-task4')
      expect(result).not.toContain('native://c-context1')
    })

    it('expands neighbors selector to all connected nodes', () => {
      const result = graph.expandSelector('@native://t-task2')

      expect(result).toHaveLength(2)
      expect(result).toContain('native://t-task1') // incoming
      expect(result).toContain('native://t-task3') // outgoing
    })

    it('expands neighbors with edge type filter', () => {
      const result = graph.expandSelector('@native://t-task1', { edgeType: 'implements' })

      expect(result).toHaveLength(1)
      expect(result).toContain('native://c-context1')
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
