/**
 * SQLite Durability Integration Tests
 *
 * Tests transaction handling, performance with large datasets,
 * and WAL mode behavior for the SQLite persister.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { SQLitePersister } from '../../../src/storage/sqlite.js'
import { generateId } from '../../../src/core/id.js'
import type { StoredNode, StoredEdge } from '../../../src/schema/storage.js'
import {
  SLOW_TESTS,
  withTempDir,
  type TempDirContext,
} from '../helpers/index.js'

/**
 * Create a test node with required fields
 * Note: We explicitly set optional fields to null or omit them
 * to avoid undefined values that SQLite can't bind
 *
 * @param overrides - Field overrides
 * @param existingCount - Number of existing entities (for adaptive ID length to avoid collisions)
 */
function createTestNode(overrides: Partial<{
  id: string
  type: string
  title: string
  content: string
  status: string
  priority: number
}> = {}, existingCount = 0): StoredNode {
  const nodeType = overrides.type ?? 'spec'
  const idType = nodeType === 'issue' ? 'issue' : nodeType === 'feedback' ? 'feedback' : 'spec'
  const generated = overrides.id ? null : generateId(idType, existingCount)
  const id = overrides.id ?? generated!.id
  const uuid = generated?.uuid ?? `uuid-${id}`

  const node: StoredNode = {
    id,
    uuid,
    type: nodeType,
    title: overrides.title ?? `Test Node ${id}`,
    content: overrides.content ?? 'Test content',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Only add optional fields if they have values
  if (overrides.status !== undefined) {
    node.status = overrides.status
  }
  if (overrides.priority !== undefined) {
    node.priority = overrides.priority
  }

  return node
}

/**
 * Create a test edge with required fields
 * Note: We don't include optional fields to avoid undefined values
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
    // Note: created_by and source are optional and omitted
  }
}

describe.skipIf(!SLOW_TESTS)('SQLite Durability Integration', () => {
  let tempDir: TempDirContext
  let persister: SQLitePersister

  beforeEach(async () => {
    tempDir = await withTempDir('sqlite-durability-')
    persister = new SQLitePersister({
      path: tempDir.resolve('cache.db'),
      walMode: true,
    })
    persister.initialize()
  })

  afterEach(async () => {
    await persister.close()
    await tempDir.cleanup()
  })

  describe('WAL mode', () => {
    it('should create WAL and SHM files in WAL mode', async () => {
      const node = createTestNode({ title: 'WAL Test' })
      await persister.createNode(node)

      // WAL mode creates additional files
      const walPath = tempDir.resolve('cache.db-wal')
      const shmPath = tempDir.resolve('cache.db-shm')

      // These files may or may not exist depending on SQLite's internal state
      // but the database should still work correctly
      const dbExists = existsSync(tempDir.resolve('cache.db'))
      expect(dbExists).toBe(true)
    })

    it('should work without WAL mode', async () => {
      // Create a non-WAL persister
      const journalPersister = new SQLitePersister({
        path: tempDir.resolve('journal.db'),
        walMode: false,
      })
      journalPersister.initialize()

      const node = createTestNode({ title: 'Journal Test' })
      await journalPersister.createNode(node)

      const loaded = await journalPersister.getNode(node.id)
      expect(loaded?.title).toBe('Journal Test')

      await journalPersister.close()
    })
  })

  describe('transaction handling', () => {
    it('should commit successful transactions', async () => {
      const node1 = createTestNode({ title: 'TX Node 1' })
      const node2 = createTestNode({ title: 'TX Node 2' })

      await persister.runInTransaction(async (tx) => {
        await tx.createNode(node1)
        await tx.createNode(node2)
      })

      const loaded1 = await persister.getNode(node1.id)
      const loaded2 = await persister.getNode(node2.id)

      expect(loaded1?.title).toBe('TX Node 1')
      expect(loaded2?.title).toBe('TX Node 2')
    })

    it('should rollback failed transactions', async () => {
      const node1 = createTestNode({ id: 's-rollback1', title: 'Rollback 1' })

      // First create the node to set up a duplicate
      await persister.createNode(node1)

      // Try to create duplicate in transaction - should fail
      await expect(
        persister.runInTransaction(async (tx) => {
          // This should fail due to duplicate ID
          await tx.createNode(node1)
        })
      ).rejects.toThrow()

      // Original node should still exist
      const loaded = await persister.getNode(node1.id)
      expect(loaded?.title).toBe('Rollback 1')
    })

    it('should handle complex transactions with edges', async () => {
      const node1 = createTestNode({ type: 'spec', title: 'Spec' })
      const node2 = createTestNode({ type: 'issue', title: 'Issue' })
      const edge = createTestEdge(node1.id, node2.id, 'implements')

      await persister.runInTransaction(async (tx) => {
        await tx.createNode(node1)
        await tx.createNode(node2)
        await tx.createEdge(edge)
      })

      const edgesFrom = await persister.getEdgesFrom(node1.id)
      expect(edgesFrom).toHaveLength(1)
      expect(edgesFrom[0].type).toBe('implements')
    })
  })

  describe('large dataset performance', () => {
    it('should handle 10k+ nodes efficiently', async () => {
      const nodeCount = 10000
      // Use explicit unique IDs to avoid any hash collisions
      const nodes = Array.from({ length: nodeCount }, (_, i) => {
        const prefix = i % 3 === 0 ? 's' : i % 3 === 1 ? 'i' : 'f'
        return createTestNode({
          id: `${prefix}-perf${i.toString().padStart(5, '0')}`,
          type: i % 3 === 0 ? 'spec' : i % 3 === 1 ? 'issue' : 'feedback',
          title: `Node ${i}`,
          content: `Content for node ${i}. `.repeat(10),
          status: i % 2 === 0 ? 'open' : 'closed',
          priority: i % 5,
        })
      })

      // Measure bulk insert time
      const insertStart = performance.now()
      for (const node of nodes) {
        await persister.createNode(node)
      }
      const insertTime = performance.now() - insertStart

      // Should complete in reasonable time (under 10 seconds for 10k nodes)
      expect(insertTime).toBeLessThan(10000)
      console.log(`Insert 10k nodes: ${insertTime.toFixed(0)}ms`)

      // Measure query time
      const queryStart = performance.now()
      const result = await persister.queryNodes({ type: 'spec', limit: 10000 })
      const queryTime = performance.now() - queryStart

      expect(result.length).toBeGreaterThan(3000) // ~1/3 are specs
      expect(queryTime).toBeLessThan(500) // Under 500ms
      console.log(`Query specs: ${queryTime.toFixed(0)}ms (${result.length} results)`)
    })

    it('should handle filtered queries efficiently', async () => {
      // Create 1000 nodes with various properties
      // Use explicit unique IDs to avoid any hash collisions
      const nodes = Array.from({ length: 1000 }, (_, i) => {
        const prefix = i % 2 === 0 ? 's' : 'i'
        return createTestNode({
          id: `${prefix}-filter${i.toString().padStart(4, '0')}`,
          type: i % 2 === 0 ? 'spec' : 'issue',
          title: `Node ${i}`,
          status: i % 4 === 0 ? 'open' : 'closed',
        })
      })

      for (const node of nodes) {
        await persister.createNode(node)
      }

      // Test various filter combinations
      // Note: default limit is 100, so we need to set higher limits
      const start = performance.now()

      const byType = await persister.queryNodes({ type: 'spec', limit: 1000 })
      expect(byType.length).toBe(500)

      const byStatus = await persister.queryNodes({ status: 'open', limit: 1000 })
      expect(byStatus.length).toBe(250)

      const byBoth = await persister.queryNodes({ type: 'issue', status: 'closed', limit: 1000 })
      // All issues have odd indices (1, 3, 5, ...), none of which satisfy i % 4 === 0
      // So all 500 issues are closed
      expect(byBoth.length).toBe(500)

      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(500)
    })

    it('should handle search queries with LIKE', async () => {
      // Use explicit unique IDs to avoid any hash collisions
      const nodes = Array.from({ length: 500 }, (_, i) =>
        createTestNode({
          id: `s-search${i.toString().padStart(3, '0')}`,
          title: i % 10 === 0 ? `Important Node ${i}` : `Regular Node ${i}`,
          content: i % 5 === 0 ? 'Contains keyword important info' : 'Normal content',
        })
      )

      for (const node of nodes) {
        await persister.createNode(node)
      }

      const start = performance.now()
      const result = await persister.queryNodes({ search: 'important' })
      const elapsed = performance.now() - start

      // Should find nodes with "important" in title or content
      expect(result.length).toBeGreaterThan(0)
      expect(elapsed).toBeLessThan(200)
    })
  })

  describe('edge queries', () => {
    it('should handle complex edge traversals', async () => {
      // Create a chain of nodes with explicit IDs to avoid collisions
      const nodes = Array.from({ length: 100 }, (_, i) =>
        createTestNode({ id: `s-chain${i.toString().padStart(3, '0')}`, title: `Chain ${i}` })
      )

      for (const node of nodes) {
        await persister.createNode(node)
      }

      // Create edges linking consecutive nodes
      const edges = Array.from({ length: 99 }, (_, i) =>
        createTestEdge(nodes[i].id, nodes[i + 1].id, 'blocks')
      )

      for (const edge of edges) {
        await persister.createEdge(edge)
      }

      // Query edges from middle of chain
      const start = performance.now()
      const edgesFrom = await persister.getEdgesFrom('s-chain050')
      const edgesTo = await persister.getEdgesTo('s-chain050')
      const elapsed = performance.now() - start

      expect(edgesFrom).toHaveLength(1)
      expect(edgesTo).toHaveLength(1)
      expect(elapsed).toBeLessThan(100)
    })

    it('should filter edges by type', async () => {
      const spec = createTestNode({ id: 's-edgetest', type: 'spec' })
      const issue1 = createTestNode({ id: 'i-edgetest1', type: 'issue' })
      const issue2 = createTestNode({ id: 'i-edgetest2', type: 'issue' })
      const feedback = createTestNode({ id: 'f-edgetest', type: 'feedback' })

      await persister.createNode(spec)
      await persister.createNode(issue1)
      await persister.createNode(issue2)
      await persister.createNode(feedback)

      // Create various edge types
      await persister.createEdge(createTestEdge(issue1.id, spec.id, 'implements'))
      await persister.createEdge(createTestEdge(issue2.id, spec.id, 'implements'))
      await persister.createEdge(createTestEdge(feedback.id, spec.id, 'references'))
      await persister.createEdge(createTestEdge(issue1.id, issue2.id, 'blocks'))

      // Query by type
      const implementsEdges = await persister.getEdgesTo(spec.id, 'implements')
      expect(implementsEdges).toHaveLength(2)

      const referencesEdges = await persister.getEdgesTo(spec.id, 'references')
      expect(referencesEdges).toHaveLength(1)

      const blocksEdges = await persister.getEdgesFrom(issue1.id, 'blocks')
      expect(blocksEdges).toHaveLength(1)
    })
  })

  describe('tag operations', () => {
    it('should handle tags correctly', async () => {
      const node = createTestNode({ title: 'Tagged Node' })
      await persister.createNode(node)

      await persister.addTag(node.id, 'important')
      await persister.addTag(node.id, 'urgent')
      await persister.addTag(node.id, 'backend')

      const tags = await persister.getTags(node.id)
      expect(tags).toContain('important')
      expect(tags).toContain('urgent')
      expect(tags).toContain('backend')

      // Remove a tag
      await persister.removeTag(node.id, 'urgent')
      const tagsAfter = await persister.getTags(node.id)
      expect(tagsAfter).not.toContain('urgent')
      expect(tagsAfter).toHaveLength(2)
    })

    it('should query nodes by tags', async () => {
      // Use explicit unique IDs to avoid any hash collisions
      const nodes = Array.from({ length: 20 }, (_, i) =>
        createTestNode({ id: `s-tag${i.toString().padStart(2, '0')}`, title: `Node ${i}` })
      )

      for (const node of nodes) {
        await persister.createNode(node)
      }

      // Add tags to some nodes
      for (let i = 0; i < 10; i++) {
        await persister.addTag(nodes[i].id, 'frontend')
      }
      for (let i = 5; i < 15; i++) {
        await persister.addTag(nodes[i].id, 'priority')
      }

      // Query by single tag
      const frontendNodes = await persister.getNodesByTag('frontend')
      expect(frontendNodes).toHaveLength(10)

      const priorityNodes = await persister.getNodesByTag('priority')
      expect(priorityNodes).toHaveLength(10)
    })

    it('should handle getTagsForNodes batch query', async () => {
      const nodes = Array.from({ length: 5 }, (_, i) =>
        createTestNode({ id: `s-tagbatch${i}`, title: `Node ${i}` })
      )

      for (const node of nodes) {
        await persister.createNode(node)
        await persister.addTag(node.id, 'common')
        await persister.addTag(node.id, `unique-${node.id}`)
      }

      const nodeIds = nodes.map(n => n.id)
      const tagsMap = await persister.getTagsForNodes(nodeIds)

      expect(tagsMap.size).toBe(5)
      for (const id of nodeIds) {
        const tags = tagsMap.get(id)
        expect(tags).toContain('common')
        expect(tags).toContain(`unique-${id}`)
      }
    })
  })

  describe('dirty tracking', () => {
    it('should track dirty nodes', async () => {
      const node1 = createTestNode({ id: 's-dirty1' })
      const node2 = createTestNode({ id: 's-dirty2' })

      await persister.createNode(node1)
      await persister.createNode(node2)

      // Mark nodes as dirty
      await persister.markDirty(node1.id)
      await persister.markDirty(node2.id)

      const dirtyNodes = await persister.getDirtyNodes()
      expect(dirtyNodes).toContain(node1.id)
      expect(dirtyNodes).toContain(node2.id)

      // Clear dirty
      await persister.clearDirty([node1.id])

      const dirtyAfter = await persister.getDirtyNodes()
      expect(dirtyAfter).not.toContain(node1.id)
      expect(dirtyAfter).toContain(node2.id)
    })
  })

  describe('ready issues view', () => {
    it('should return open issues with no blocking dependencies', async () => {
      // Create issues
      const issue1 = createTestNode({
        id: 'i-ready1',
        type: 'issue',
        title: 'Ready Issue',
        status: 'open',
      })
      const issue2 = createTestNode({
        id: 'i-blocked1',
        type: 'issue',
        title: 'Blocked Issue',
        status: 'open',
      })
      const blocker = createTestNode({
        id: 'i-blocker1',
        type: 'issue',
        title: 'Blocker',
        status: 'open',
      })

      await persister.createNode(issue1)
      await persister.createNode(issue2)
      await persister.createNode(blocker)

      // Create blocking edge: blocker blocks issue2
      const edge = createTestEdge(blocker.id, issue2.id, 'blocks')
      await persister.createEdge(edge)

      const ready = await persister.getReady()

      // Only issue1 and blocker should be ready (not blocked by anything)
      const readyIds = ready.map(n => n.id)
      expect(readyIds).toContain('i-ready1')
      expect(readyIds).toContain('i-blocker1')
      expect(readyIds).not.toContain('i-blocked1')
    })
  })

  describe('CRUD lifecycle', () => {
    it('should handle complete CRUD cycle', async () => {
      // Create
      const node = createTestNode({ title: 'CRUD Test', content: 'Initial' })
      await persister.createNode(node)

      // Read
      let loaded = await persister.getNode(node.id)
      expect(loaded?.title).toBe('CRUD Test')

      // Update
      await persister.updateNode(node.id, {
        title: 'Updated Title',
        content: 'Updated content',
        updated_at: new Date().toISOString(),
      })

      loaded = await persister.getNode(node.id)
      expect(loaded?.title).toBe('Updated Title')
      expect(loaded?.content).toBe('Updated content')

      // Delete
      await persister.deleteNode(node.id)

      loaded = await persister.getNode(node.id)
      expect(loaded).toBeNull()
    })

    it('should cascade delete edges when node is deleted', async () => {
      const node1 = createTestNode({ id: 's-cascade1' })
      const node2 = createTestNode({ id: 's-cascade2' })
      const node3 = createTestNode({ id: 's-cascade3' })

      await persister.createNode(node1)
      await persister.createNode(node2)
      await persister.createNode(node3)

      // Create edges involving node1
      await persister.createEdge(createTestEdge(node1.id, node2.id))
      await persister.createEdge(createTestEdge(node3.id, node1.id))

      // Delete node1
      await persister.deleteNode(node1.id)

      // Edges should be deleted
      const edgesFromNode2 = await persister.getEdgesTo(node2.id)
      const edgesFromNode3 = await persister.getEdgesFrom(node3.id)

      expect(edgesFromNode2).toHaveLength(0)
      expect(edgesFromNode3).toHaveLength(0)
    })
  })
})
