import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { SQLitePersister } from '../sqlite.js'
import { JSONLPersister } from '../jsonl.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'

describe('SQLitePersister', () => {
  let tempDir: string
  let persister: SQLitePersister

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opentasks-sqlite-test-'))
    persister = new SQLitePersister({
      path: path.join(tempDir, 'cache.db'),
      walMode: true,
    })
    persister.initialize()
  })

  afterEach(async () => {
    await persister.close()
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  // Test fixtures
  const testContext: StoredNode = {
    id: 'c-a2b3',
    uuid: '550e8400-e29b-41d4-a716-446655440000',
    type: 'context',
    title: 'Test Context',
    content: 'Some specification content',
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  }

  const testTask: StoredNode = {
    id: 't-x7k9',
    uuid: '550e8400-e29b-41d4-a716-446655440001',
    type: 'task',
    title: 'Test Task',
    status: 'open',
    priority: 1,
    created_at: '2025-01-26T10:00:00Z',
    updated_at: '2025-01-26T10:00:00Z',
  }

  const testTask2: StoredNode = {
    id: 't-y8m2',
    uuid: '550e8400-e29b-41d4-a716-446655440002',
    type: 'task',
    title: 'Test Task 2',
    status: 'in_progress',
    priority: 2,
    created_at: '2025-01-26T11:00:00Z',
    updated_at: '2025-01-26T11:00:00Z',
  }

  const testBlockingTask: StoredNode = {
    id: 't-z9n3',
    uuid: '550e8400-e29b-41d4-a716-446655440003',
    type: 'task',
    title: 'Blocking Task',
    status: 'open',
    created_at: '2025-01-26T09:00:00Z',
    updated_at: '2025-01-26T09:00:00Z',
  }

  const testEdge: StoredEdge = {
    id: 'x-r8s9',
    uuid: '550e8400-e29b-41d4-a716-446655440010',
    from_id: 't-x7k9',
    to_id: 'c-a2b3',
    type: 'implements',
    created_at: '2025-01-26T10:00:00Z',
  }

  const testBlocksEdge: StoredEdge = {
    id: 'x-b1c2',
    uuid: '550e8400-e29b-41d4-a716-446655440011',
    from_id: 't-z9n3',
    to_id: 't-x7k9',
    type: 'blocks',
    created_at: '2025-01-26T09:30:00Z',
  }

  describe('node operations', () => {
    it('creates and retrieves a node', async () => {
      await persister.createNode(testContext)
      const result = await persister.getNode('c-a2b3')

      expect(result).toBeDefined()
      expect(result?.id).toBe('c-a2b3')
      expect(result?.title).toBe('Test Context')
      expect(result?.type).toBe('context')
      expect(result?.content).toBe('Some specification content')
    })

    it('returns null for non-existent node', async () => {
      const result = await persister.getNode('non-existent')
      expect(result).toBeNull()
    })

    it('creates node with optional fields', async () => {
      await persister.createNode(testTask)
      const result = await persister.getNode('t-x7k9')

      expect(result?.status).toBe('open')
      expect(result?.priority).toBe(1)
    })

    it('creates node with boolean fields', async () => {
      const archivedNode: StoredNode = {
        ...testContext,
        id: 'c-arch',
        archived: true,
      }
      await persister.createNode(archivedNode)
      const result = await persister.getNode('c-arch')

      expect(result?.archived).toBe(true)
    })

    it('updates node fields', async () => {
      await persister.createNode(testTask)
      await persister.updateNode('t-x7k9', {
        status: 'closed',
        title: 'Updated Title',
      })

      const result = await persister.getNode('t-x7k9')
      expect(result?.status).toBe('closed')
      expect(result?.title).toBe('Updated Title')
    })

    it('throws when updating non-existent node', async () => {
      await expect(
        persister.updateNode('non-existent', { title: 'New' })
      ).rejects.toThrow('Node not found')
    })

    it('deletes a node', async () => {
      await persister.createNode(testContext)
      await persister.deleteNode('c-a2b3')

      const result = await persister.getNode('c-a2b3')
      expect(result).toBeNull()
    })

    it('deletes node and related edges', async () => {
      await persister.createNode(testContext)
      await persister.createNode(testTask)
      await persister.createEdge(testEdge)

      await persister.deleteNode('c-a2b3')

      const edge = await persister.getEdge('x-r8s9')
      expect(edge).toBeNull()
    })
  })

  describe('queryNodes', () => {
    beforeEach(async () => {
      await persister.createNode(testContext)
      await persister.createNode(testTask)
      await persister.createNode(testTask2)
    })

    it('queries all nodes without filter', async () => {
      const results = await persister.queryNodes({})
      expect(results).toHaveLength(3)
    })

    it('filters by type', async () => {
      const results = await persister.queryNodes({ type: 'task' })
      expect(results).toHaveLength(2)
      expect(results.every((n) => n.type === 'task')).toBe(true)
    })

    it('filters by status', async () => {
      const results = await persister.queryNodes({ status: 'open' })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('t-x7k9')
    })

    it('filters by multiple statuses', async () => {
      const results = await persister.queryNodes({ status: ['open', 'in_progress'] })
      expect(results).toHaveLength(2)
    })

    it('filters by search text in title', async () => {
      const results = await persister.queryNodes({ search: 'Context' })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('c-a2b3')
    })

    it('filters by search text in content', async () => {
      const results = await persister.queryNodes({ search: 'specification' })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('c-a2b3')
    })

    it('respects limit', async () => {
      const results = await persister.queryNodes({ limit: 2 })
      expect(results).toHaveLength(2)
    })

    it('respects offset', async () => {
      const results = await persister.queryNodes({ limit: 10, offset: 2 })
      expect(results).toHaveLength(1)
    })

    it('filters by archived status', async () => {
      const archivedNode: StoredNode = {
        ...testContext,
        id: 'c-arch',
        uuid: 'arch-uuid',
        archived: true,
      }
      await persister.createNode(archivedNode)

      const activeResults = await persister.queryNodes({ archived: false })
      expect(activeResults.every((n) => !n.archived)).toBe(true)

      const archivedResults = await persister.queryNodes({ archived: true })
      expect(archivedResults).toHaveLength(1)
      expect(archivedResults[0].id).toBe('c-arch')
    })
  })

  describe('edge operations', () => {
    beforeEach(async () => {
      await persister.createNode(testContext)
      await persister.createNode(testTask)
    })

    it('creates and retrieves an edge', async () => {
      await persister.createEdge(testEdge)
      const result = await persister.getEdge('x-r8s9')

      expect(result).toBeDefined()
      expect(result?.id).toBe('x-r8s9')
      expect(result?.from_id).toBe('t-x7k9')
      expect(result?.to_id).toBe('c-a2b3')
      expect(result?.type).toBe('implements')
    })

    it('returns null for non-existent edge', async () => {
      const result = await persister.getEdge('non-existent')
      expect(result).toBeNull()
    })

    it('gets edges from a node', async () => {
      await persister.createEdge(testEdge)
      const results = await persister.getEdgesFrom('t-x7k9')

      expect(results).toHaveLength(1)
      expect(results[0].to_id).toBe('c-a2b3')
    })

    it('gets edges from a node filtered by type', async () => {
      const refEdge: StoredEdge = {
        ...testEdge,
        id: 'x-ref1',
        uuid: 'ref-uuid',
        type: 'references',
      }
      await persister.createEdge(testEdge)
      await persister.createEdge(refEdge)

      const results = await persister.getEdgesFrom('t-x7k9', 'implements')
      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('implements')
    })

    it('gets edges to a node', async () => {
      await persister.createEdge(testEdge)
      const results = await persister.getEdgesTo('c-a2b3')

      expect(results).toHaveLength(1)
      expect(results[0].from_id).toBe('t-x7k9')
    })

    it('deletes an edge', async () => {
      await persister.createEdge(testEdge)
      await persister.deleteEdge('x-r8s9')

      const result = await persister.getEdge('x-r8s9')
      expect(result).toBeNull()
    })

    it('creates and retrieves edge with metadata and cached_at', async () => {
      const edgeWithMetadata: StoredEdge = {
        ...testEdge,
        id: 'x-meta1',
        uuid: 'meta-uuid',
        metadata: {
          source_system: 'beads',
          confidence: 0.95,
          nested: { key: 'value' },
        },
        cached_at: '2025-01-26T12:00:00Z',
      }
      await persister.createEdge(edgeWithMetadata)
      const result = await persister.getEdge('x-meta1')

      expect(result).toBeDefined()
      expect(result?.metadata).toEqual({
        source_system: 'beads',
        confidence: 0.95,
        nested: { key: 'value' },
      })
      expect(result?.cached_at).toBe('2025-01-26T12:00:00Z')
    })

    it('handles edge without optional metadata and cached_at', async () => {
      await persister.createEdge(testEdge)
      const result = await persister.getEdge('x-r8s9')

      expect(result?.metadata).toBeUndefined()
      expect(result?.cached_at).toBeUndefined()
    })
  })

  describe('tag operations', () => {
    beforeEach(async () => {
      await persister.createNode(testTask)
    })

    it('adds tags to a node', async () => {
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-x7k9', 'urgent')

      const tags = await persister.getTags('t-x7k9')
      expect(tags).toContain('frontend')
      expect(tags).toContain('urgent')
    })

    it('removes a tag', async () => {
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-x7k9', 'urgent')
      await persister.removeTag('t-x7k9', 'urgent')

      const tags = await persister.getTags('t-x7k9')
      expect(tags).toContain('frontend')
      expect(tags).not.toContain('urgent')
    })

    it('returns empty array for node without tags', async () => {
      const tags = await persister.getTags('t-x7k9')
      expect(tags).toHaveLength(0)
    })

    it('gets tags for multiple nodes', async () => {
      await persister.createNode(testTask2)
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-y8m2', 'backend')

      const tagsMap = await persister.getTagsForNodes(['t-x7k9', 't-y8m2'])
      expect(tagsMap.get('t-x7k9')).toContain('frontend')
      expect(tagsMap.get('t-y8m2')).toContain('backend')
    })

    it('gets nodes by tag', async () => {
      await persister.createNode(testTask2)
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-y8m2', 'frontend')

      const nodes = await persister.getNodesByTag('frontend')
      expect(nodes).toHaveLength(2)
    })

    it('includes tags when getting a node', async () => {
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-x7k9', 'urgent')

      const node = await persister.getNode('t-x7k9')
      expect(node?.tags).toContain('frontend')
      expect(node?.tags).toContain('urgent')
    })

    it('filters nodes by tags in query', async () => {
      await persister.createNode(testTask2)
      await persister.addTag('t-x7k9', 'frontend')
      await persister.addTag('t-x7k9', 'urgent')
      await persister.addTag('t-y8m2', 'frontend')

      // AND semantics: both tags required
      const results = await persister.queryNodes({ tags: ['frontend', 'urgent'] })
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('t-x7k9')
    })
  })

  describe('getReady', () => {
    it('returns open tasks without blockers', async () => {
      await persister.createNode(testTask)

      const ready = await persister.getReady()
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe('t-x7k9')
    })

    it('excludes tasks blocked by open tasks', async () => {
      await persister.createNode(testTask)
      await persister.createNode(testBlockingTask)
      await persister.createEdge(testBlocksEdge)

      const ready = await persister.getReady()
      // Only z9n3 (the blocker) is ready, x7k9 is blocked
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe('t-z9n3')
    })

    it('includes tasks once blocker is closed', async () => {
      await persister.createNode(testTask)
      await persister.createNode(testBlockingTask)
      await persister.createEdge(testBlocksEdge)

      // Close the blocking task
      await persister.updateNode('t-z9n3', { status: 'closed' })

      const ready = await persister.getReady()
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe('t-x7k9')
    })

    it('excludes archived tasks', async () => {
      const archivedTask: StoredNode = {
        ...testTask,
        id: 't-arch',
        uuid: 'arch-uuid',
        archived: true,
      }
      await persister.createNode(archivedTask)
      await persister.createNode(testTask)

      const ready = await persister.getReady()
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe('t-x7k9')
    })

    it('excludes non-open tasks', async () => {
      await persister.createNode(testTask)
      await persister.createNode(testTask2) // status: in_progress

      const ready = await persister.getReady()
      expect(ready).toHaveLength(1)
      expect(ready[0].id).toBe('t-x7k9')
    })
  })

  describe('dirty tracking', () => {
    it('marks nodes as dirty', async () => {
      await persister.createNode(testTask)
      await persister.markDirty('t-x7k9')

      const dirty = await persister.getDirtyNodes()
      expect(dirty).toContain('t-x7k9')
    })

    it('clears dirty nodes', async () => {
      await persister.createNode(testTask)
      await persister.markDirty('t-x7k9')
      await persister.clearDirty(['t-x7k9'])

      const dirty = await persister.getDirtyNodes()
      expect(dirty).not.toContain('t-x7k9')
    })

    it('marks dirty when tags change', async () => {
      await persister.createNode(testTask)
      await persister.addTag('t-x7k9', 'test')

      const dirty = await persister.getDirtyNodes()
      expect(dirty).toContain('t-x7k9')
    })
  })

  describe('transactions', () => {
    it('commits successful transactions', async () => {
      await persister.runInTransaction(async (tx) => {
        await tx.createNode(testContext)
        await tx.createNode(testTask)
        await tx.createEdge(testEdge)
      })

      const context = await persister.getNode('c-a2b3')
      const task = await persister.getNode('t-x7k9')
      const edge = await persister.getEdge('x-r8s9')

      expect(context).toBeDefined()
      expect(task).toBeDefined()
      expect(edge).toBeDefined()
    })
  })

  describe('rebuildFromJsonl', () => {
    it('rebuilds database from JSONL file', async () => {
      // Create JSONL file
      const jsonlPath = path.join(tempDir, 'graph.jsonl')
      const jsonlPersister = new JSONLPersister({ path: jsonlPath })

      const contextWithTags: StoredNode = {
        ...testContext,
        tags: ['important', 'phase1'],
      }
      await jsonlPersister.save([contextWithTags, testTask], [testEdge])

      // Rebuild SQLite from JSONL
      await persister.rebuildFromJsonl(jsonlPath)

      // Verify data
      const context = await persister.getNode('c-a2b3')
      const task = await persister.getNode('t-x7k9')
      const edge = await persister.getEdge('x-r8s9')

      expect(context).toBeDefined()
      expect(context?.title).toBe('Test Context')
      expect(task).toBeDefined()
      expect(edge).toBeDefined()

      // Verify tags were imported
      const tags = await persister.getTags('c-a2b3')
      expect(tags).toContain('important')
      expect(tags).toContain('phase1')
    })

    it('clears existing data before rebuild', async () => {
      // Add initial data
      await persister.createNode(testContext)

      // Create JSONL with different data
      const jsonlPath = path.join(tempDir, 'graph.jsonl')
      const jsonlPersister = new JSONLPersister({ path: jsonlPath })
      await jsonlPersister.save([testTask], [])

      // Rebuild
      await persister.rebuildFromJsonl(jsonlPath)

      // Old data should be gone
      const context = await persister.getNode('c-a2b3')
      expect(context).toBeNull()

      // New data should be present
      const task = await persister.getNode('t-x7k9')
      expect(task).toBeDefined()
    })
  })

  describe('lifecycle', () => {
    it('can be closed and reopened', async () => {
      await persister.createNode(testContext)
      await persister.close()

      // Reopen
      const newPersister = new SQLitePersister({
        path: path.join(tempDir, 'cache.db'),
      })

      const result = await newPersister.getNode('c-a2b3')
      expect(result).toBeDefined()

      await newPersister.close()
    })
  })
})
