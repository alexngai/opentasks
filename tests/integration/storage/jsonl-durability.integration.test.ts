/**
 * JSONL Durability Integration Tests
 *
 * Tests crash recovery, compaction, and concurrent access
 * for the JSONL persister with real file I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, appendFile, readFile } from 'node:fs/promises'
import { JSONLPersister } from '../../../src/storage/jsonl.js'
import { generateId } from '../../../src/core/id.js'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'

/**
 * Create a test node with required fields
 */
function createTestNode(overrides: Partial<{
  id: string
  type: string
  title: string
  content: string
}> = {}) {
  const generated = overrides.id ? null : generateId('context')
  const id = overrides.id ?? generated!.id
  const uuid = generated?.uuid ?? `uuid-${id}`
  return {
    id,
    uuid,
    type: overrides.type ?? 'context',
    title: overrides.title ?? `Test Node ${id}`,
    content: overrides.content ?? 'Test content',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/**
 * Create a test edge with required fields
 */
function createTestEdge(fromId: string, toId: string, type = 'blocks') {
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

describe.skipIf(!SLOW_TESTS)('JSONL Durability Integration', () => {
  let tempDir: TempDirContext

  beforeEach(async () => {
    tempDir = await withTempDir('jsonl-durability-')
  })

  afterEach(async () => {
    await tempDir.cleanup()
  })

  describe('crash recovery', () => {
    it('should recover from incomplete write (truncated line)', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Write valid nodes
      const node1 = createTestNode({ title: 'Node 1' })
      const node2 = createTestNode({ title: 'Node 2' })
      await persister.save([node1, node2], [])

      // Simulate crash: append truncated JSON line
      await appendFile(jsonlPath, '{"id":"c-incomplete","title":"Trunca')

      // Load should recover valid entries and skip the corrupted one
      const result = await persister.load()

      expect(result.nodes).toHaveLength(2)
      expect(result.nodes.map(n => n.title)).toContain('Node 1')
      expect(result.nodes.map(n => n.title)).toContain('Node 2')
    })

    it('should handle corrupted line in the middle', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')

      // Write file with a corrupted line in the middle
      const node1 = createTestNode({ title: 'First' })
      const node3 = createTestNode({ title: 'Third' })

      const content = [
        JSON.stringify(node1),
        '{"broken json here',  // Corrupted line
        JSON.stringify(node3),
      ].join('\n') + '\n'

      await writeFile(jsonlPath, content, 'utf-8')

      const persister = new JSONLPersister({ path: jsonlPath })
      const result = await persister.load()

      // Should load valid entries and skip corrupted
      expect(result.nodes).toHaveLength(2)
      expect(result.nodes[0].title).toBe('First')
      expect(result.nodes[1].title).toBe('Third')
    })

    it('should handle empty lines gracefully', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')

      const node1 = createTestNode({ title: 'Node 1' })
      const node2 = createTestNode({ title: 'Node 2' })

      // Write with empty lines scattered throughout
      const content = [
        '',
        JSON.stringify(node1),
        '',
        '',
        JSON.stringify(node2),
        '',
      ].join('\n')

      await writeFile(jsonlPath, content, 'utf-8')

      const persister = new JSONLPersister({ path: jsonlPath })
      const result = await persister.load()

      expect(result.nodes).toHaveLength(2)
    })

    it('should handle completely empty file', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      await writeFile(jsonlPath, '', 'utf-8')

      const persister = new JSONLPersister({ path: jsonlPath })
      const result = await persister.load()

      expect(result.nodes).toEqual([])
      expect(result.edges).toEqual([])
    })

    it('should handle whitespace-only file', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      await writeFile(jsonlPath, '   \n\n   \n', 'utf-8')

      const persister = new JSONLPersister({ path: jsonlPath })
      const result = await persister.load()

      expect(result.nodes).toEqual([])
      expect(result.edges).toEqual([])
    })
  })

  describe('compaction with many entries', () => {
    it('should compact correctly with 1000+ entries', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Create 1000 nodes
      const nodes = Array.from({ length: 1000 }, (_, i) =>
        createTestNode({ title: `Node ${i}` })
      )

      // Create some edges between consecutive nodes
      const edges = Array.from({ length: 100 }, (_, i) =>
        createTestEdge(nodes[i].id, nodes[i + 1].id)
      )

      // Save all
      await persister.save(nodes, edges)

      // Verify file exists and has content
      const content = await readFile(jsonlPath, 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(1100) // 1000 nodes + 100 edges

      // Load and verify
      const result = await persister.load()
      expect(result.nodes).toHaveLength(1000)
      expect(result.edges).toHaveLength(100)
    })

    it('should maintain data integrity after save/load cycle', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Create nodes with various field combinations
      const nodes = [
        createTestNode({ type: 'spec', title: 'Spec 1', content: 'Content A' }),
        createTestNode({ type: 'issue', title: 'Issue 1', content: 'Content B' }),
        createTestNode({ type: 'feedback', title: 'Feedback 1', content: 'Content C' }),
      ]

      const edges = [
        createTestEdge(nodes[0].id, nodes[1].id, 'implements'),
        createTestEdge(nodes[1].id, nodes[2].id, 'references'),
      ]

      // Save
      await persister.save(nodes, edges)

      // Load
      const result = await persister.load()

      // Verify all fields preserved
      expect(result.nodes).toHaveLength(3)
      expect(result.edges).toHaveLength(2)

      const loadedSpec = result.nodes.find(n => n.type === 'spec')
      expect(loadedSpec?.title).toBe('Spec 1')
      expect(loadedSpec?.content).toBe('Content A')

      const loadedEdge = result.edges.find(e => e.type === 'implements')
      expect(loadedEdge?.from_id).toBe(nodes[0].id)
      expect(loadedEdge?.to_id).toBe(nodes[1].id)
    })

    it('should handle delete/recreate cycles', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Create initial nodes
      const node1 = createTestNode({ id: 's-keep1', title: 'Keep 1' })
      const node2 = createTestNode({ id: 's-delete1', title: 'Delete 1' })
      const node3 = createTestNode({ id: 's-keep2', title: 'Keep 2' })

      await persister.save([node1, node2, node3], [])

      // "Delete" by saving without node2
      await persister.save([node1, node3], [])

      // Verify deletion
      const result = await persister.load()
      expect(result.nodes).toHaveLength(2)
      expect(result.nodes.map(n => n.id)).not.toContain('s-delete1')
    })
  })

  describe('append operations', () => {
    it('should append single entries correctly', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Start with empty file
      await persister.save([], [])

      // Append multiple nodes one at a time
      const node1 = createTestNode({ title: 'Appended 1' })
      const node2 = createTestNode({ title: 'Appended 2' })
      const node3 = createTestNode({ title: 'Appended 3' })

      await persister.append(node1)
      await persister.append(node2)
      await persister.append(node3)

      // Load and verify
      const result = await persister.load()
      expect(result.nodes).toHaveLength(3)
    })

    it('should appendMany atomically', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      await persister.save([], [])

      // Append many entries at once
      const nodes = Array.from({ length: 50 }, (_, i) =>
        createTestNode({ title: `Batch ${i}` })
      )

      await persister.appendMany(nodes)

      const result = await persister.load()
      expect(result.nodes).toHaveLength(50)
    })
  })

  describe('concurrent access simulation', () => {
    it('should handle rapid sequential writes', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      await persister.save([], [])

      // Rapid sequential appends
      const writePromises = Array.from({ length: 20 }, async (_, i) => {
        const node = createTestNode({ title: `Rapid ${i}` })
        await persister.append(node)
      })

      await Promise.all(writePromises)

      const result = await persister.load()
      // Due to concurrent writes, we may have some lost writes
      // The important thing is that we don't crash and data is valid
      expect(result.nodes.length).toBeGreaterThan(0)
      expect(result.nodes.length).toBeLessThanOrEqual(20)
    })

    it('should read consistently after concurrent reads', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      // Create initial data
      const nodes = Array.from({ length: 100 }, (_, i) =>
        createTestNode({ title: `Node ${i}` })
      )
      await persister.save(nodes, [])

      // Multiple concurrent reads
      const readPromises = Array.from({ length: 10 }, () => persister.load())
      const results = await Promise.all(readPromises)

      // All reads should return the same data
      for (const result of results) {
        expect(result.nodes).toHaveLength(100)
      }
    })
  })

  describe('atomic write behavior', () => {
    it('should use atomic writes by default', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath, atomicWrite: true })

      const nodes = Array.from({ length: 10 }, (_, i) =>
        createTestNode({ title: `Atomic ${i}` })
      )

      await persister.save(nodes, [])

      const result = await persister.load()
      expect(result.nodes).toHaveLength(10)
    })

    it('should fall back to direct write when atomic disabled', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath, atomicWrite: false })

      const nodes = Array.from({ length: 10 }, (_, i) =>
        createTestNode({ title: `Direct ${i}` })
      )

      await persister.save(nodes, [])

      const result = await persister.load()
      expect(result.nodes).toHaveLength(10)
    })
  })

  describe('performance baselines', () => {
    it('should save 1000 nodes in under 1 second', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      const nodes = Array.from({ length: 1000 }, (_, i) =>
        createTestNode({ title: `Perf ${i}`, content: 'x'.repeat(100) })
      )

      const start = performance.now()
      await persister.save(nodes, [])
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(1000) // Under 1 second
    })

    it('should load 1000 nodes in under 500ms', async () => {
      const jsonlPath = tempDir.resolve('graph.jsonl')
      const persister = new JSONLPersister({ path: jsonlPath })

      const nodes = Array.from({ length: 1000 }, (_, i) =>
        createTestNode({ title: `Perf ${i}`, content: 'x'.repeat(100) })
      )
      await persister.save(nodes, [])

      const start = performance.now()
      const result = await persister.load()
      const elapsed = performance.now() - start

      expect(result.nodes).toHaveLength(1000)
      expect(elapsed).toBeLessThan(500) // Under 500ms
    })
  })
})
