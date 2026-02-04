/**
 * Tests for Graph Store
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGraphStore, type GraphStore } from '../store.js'
import type { Storage, Transaction } from '../../storage/interface.js'
import type { StoredNode, StoredEdge } from '../../schema/storage.js'
import type { EdgeType } from '../../schema/edges.js'
import type { GraphStoreConfig } from '../types.js'
import { GraphError } from '../types.js'

// ============================================================================
// Mock Storage
// ============================================================================

function createMockStorage(): Storage & { _nodes: Map<string, StoredNode>; _edges: Map<string, StoredEdge>; _tags: Map<string, Set<string>>; _dirty: Set<string> } {
  const nodes = new Map<string, StoredNode>()
  const edges = new Map<string, StoredEdge>()
  const tags = new Map<string, Set<string>>()
  const dirty = new Set<string>()

  return {
    _nodes: nodes,
    _edges: edges,
    _tags: tags,
    _dirty: dirty,

    async createNode(node: StoredNode): Promise<void> {
      if (nodes.has(node.id)) {
        throw new Error(`Node already exists: ${node.id}`)
      }
      nodes.set(node.id, { ...node })
    },

    async getNode(id: string): Promise<StoredNode | null> {
      return nodes.get(id) || null
    },

    async updateNode(id: string, updates: Partial<StoredNode>): Promise<void> {
      const existing = nodes.get(id)
      if (!existing) {
        throw new Error(`Node not found: ${id}`)
      }
      nodes.set(id, { ...existing, ...updates })
    },

    async deleteNode(id: string): Promise<void> {
      nodes.delete(id)
      tags.delete(id)
    },

    async queryNodes(filter: { type?: string | string[]; status?: string | string[]; archived?: boolean; parent_id?: string }): Promise<StoredNode[]> {
      let result = Array.from(nodes.values())

      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type]
        result = result.filter(n => types.includes(n.type))
      }
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        result = result.filter(n => n.status && statuses.includes(n.status))
      }
      if (filter.archived !== undefined) {
        result = result.filter(n => n.archived === filter.archived)
      }
      if (filter.parent_id) {
        result = result.filter(n => n.parent_id === filter.parent_id)
      }

      return result
    },

    async createEdge(edge: StoredEdge): Promise<void> {
      if (edges.has(edge.id)) {
        throw new Error(`Edge already exists: ${edge.id}`)
      }
      edges.set(edge.id, { ...edge })
    },

    async getEdge(id: string): Promise<StoredEdge | null> {
      return edges.get(id) || null
    },

    async deleteEdge(id: string): Promise<void> {
      edges.delete(id)
    },

    async getEdgesFrom(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
      let result = Array.from(edges.values()).filter(e => e.from_id === nodeId)
      if (type) {
        result = result.filter(e => e.type === type)
      }
      return result
    },

    async getEdgesTo(nodeId: string, type?: EdgeType): Promise<StoredEdge[]> {
      let result = Array.from(edges.values()).filter(e => e.to_id === nodeId)
      if (type) {
        result = result.filter(e => e.type === type)
      }
      return result
    },

    async addTag(nodeId: string, tag: string): Promise<void> {
      if (!tags.has(nodeId)) {
        tags.set(nodeId, new Set())
      }
      tags.get(nodeId)!.add(tag)
    },

    async removeTag(nodeId: string, tag: string): Promise<void> {
      tags.get(nodeId)?.delete(tag)
    },

    async getTags(nodeId: string): Promise<string[]> {
      return Array.from(tags.get(nodeId) || [])
    },

    async getTagsForNodes(nodeIds: string[]): Promise<Map<string, string[]>> {
      const result = new Map<string, string[]>()
      for (const id of nodeIds) {
        result.set(id, Array.from(tags.get(id) || []))
      }
      return result
    },

    async getNodesByTag(tag: string): Promise<StoredNode[]> {
      const result: StoredNode[] = []
      for (const [nodeId, nodeTags] of tags) {
        if (nodeTags.has(tag)) {
          const node = nodes.get(nodeId)
          if (node) result.push(node)
        }
      }
      return result
    },

    async getReady(): Promise<StoredNode[]> {
      return []
    },

    async runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      // Simple mock - no actual transaction
      const tx: Transaction = {
        createNode: this.createNode.bind(this),
        updateNode: this.updateNode.bind(this),
        createEdge: this.createEdge.bind(this),
        deleteEdge: this.deleteEdge.bind(this),
        addTag: this.addTag.bind(this),
        removeTag: this.removeTag.bind(this),
      }
      return fn(tx)
    },

    async markDirty(nodeId: string): Promise<void> {
      dirty.add(nodeId)
    },

    async getDirtyNodes(): Promise<string[]> {
      return Array.from(dirty)
    },

    async clearDirty(nodeIds: string[]): Promise<void> {
      for (const id of nodeIds) {
        dirty.delete(id)
      }
    },

    async close(): Promise<void> {
      // no-op
    },
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('GraphStore', () => {
  let storage: ReturnType<typeof createMockStorage>
  let store: GraphStore
  let jsonlData: { nodes: StoredNode[]; edges: StoredEdge[] }
  let jsonlSaveCalls: Array<{ nodes: StoredNode[]; edges: StoredEdge[] }>

  const config: GraphStoreConfig = {
    basePath: '/test/.opentasks',
    flush: {
      debounceMs: 100,
      maxDelayMs: 500,
    },
  }

  beforeEach(() => {
    storage = createMockStorage()
    jsonlData = { nodes: [], edges: [] }
    jsonlSaveCalls = []

    store = createGraphStore(
      config,
      storage,
      async () => jsonlData,
      async (nodes, edges) => {
        jsonlSaveCalls.push({ nodes, edges })
        jsonlData = { nodes, edges }
      }
    )
  })

  afterEach(async () => {
    await store.close()
  })

  describe('lifecycle', () => {
    it('should initialize from JSONL', async () => {
      // Pre-populate JSONL
      jsonlData = {
        nodes: [
          {
            id: 's-test1',
            uuid: 'uuid-1',
            type: 'spec',
            title: 'Test Spec',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            archived: false,
            tags: ['important'],
          },
        ],
        edges: [],
      }

      await store.initialize()

      // Verify synced to storage
      const node = await storage.getNode('s-test1')
      expect(node).not.toBeNull()
      expect(node?.title).toBe('Test Spec')

      // Verify tags synced
      const nodeTags = await storage.getTags('s-test1')
      expect(nodeTags).toContain('important')
    })

    it('should flush on close', async () => {
      await store.initialize()

      // Create a node
      await store.createNode({
        type: 'spec',
        title: 'New Spec',
      })

      // Close should trigger flush
      await store.close()

      // Verify JSONL was saved
      expect(jsonlSaveCalls.length).toBeGreaterThan(0)
    })
  })

  describe('createNode', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should create a spec', async () => {
      const node = await store.createNode({
        type: 'spec',
        title: 'My Spec',
        content: 'Description',
        priority: 1,
      })

      expect(node.type).toBe('spec')
      expect(node.title).toBe('My Spec')
      expect(node.content).toBe('Description')
      expect(node.priority).toBe(1)
      expect(node.id).toMatch(/^s-[a-z0-9]+$/)
    })

    it('should create an issue with status', async () => {
      const node = await store.createNode({
        type: 'issue',
        title: 'My Issue',
        status: 'open',
      })

      expect(node.type).toBe('issue')
      if (node.type === 'issue') {
        expect(node.status).toBe('open')
      }
    })

    it('should create a feedback node', async () => {
      // First create target spec
      const spec = await store.createNode({
        type: 'spec',
        title: 'Target Spec',
      })

      const feedback = await store.createNode({
        type: 'feedback',
        title: 'My Feedback',
        target_id: spec.id,
        feedback_type: 'comment',
      })

      expect(feedback.type).toBe('feedback')
      if (feedback.type === 'feedback') {
        expect(feedback.target_id).toBe(spec.id)
        expect(feedback.feedback_type).toBe('comment')
      }
    })

    it('should handle tags', async () => {
      const node = await store.createNode({
        type: 'spec',
        title: 'Tagged Spec',
        tags: ['urgent', 'feature'],
      })

      expect(node.tags).toContain('urgent')
      expect(node.tags).toContain('feature')
    })

    it('should reject invalid input', async () => {
      await expect(
        store.createNode({
          type: 'spec',
          title: '', // Empty title
        })
      ).rejects.toThrow(GraphError)
    })
  })

  describe('getNode', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should get existing node', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'Test Spec',
      })

      const fetched = await store.getNode(created.id)

      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(created.id)
      expect(fetched?.title).toBe('Test Spec')
    })

    it('should return null for non-existent node', async () => {
      const fetched = await store.getNode('s-nonexistent')
      expect(fetched).toBeNull()
    })
  })

  describe('updateNode', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should update node fields', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'Original Title',
      })

      const updated = await store.updateNode(created.id, {
        title: 'Updated Title',
        priority: 2,
      })

      expect(updated.title).toBe('Updated Title')
      expect(updated.priority).toBe(2)
    })

    it('should throw for non-existent node', async () => {
      await expect(
        store.updateNode('s-nonexistent', { title: 'New Title' })
      ).rejects.toThrow(GraphError)
    })
  })

  describe('deleteNode', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should soft delete by default', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'To Delete',
      })

      await store.deleteNode(created.id)

      // Node should still exist but be archived
      const node = await storage.getNode(created.id)
      expect(node).not.toBeNull()
      expect(node?.archived).toBe(true)
    })

    it('should hard delete when requested', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'To Delete Hard',
      })

      await store.deleteNode(created.id, { hard: true })

      // Node should be gone
      const node = await storage.getNode(created.id)
      expect(node).toBeNull()
    })

    it('should throw for non-existent node', async () => {
      await expect(
        store.deleteNode('s-nonexistent')
      ).rejects.toThrow(GraphError)
    })
  })

  describe('restoreNode', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should restore archived node', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'To Archive',
      })

      await store.deleteNode(created.id) // Soft delete (archive)
      const restored = await store.restoreNode(created.id)

      expect(restored.archived).toBe(false)
    })

    it('should throw when restoring non-archived node', async () => {
      const created = await store.createNode({
        type: 'spec',
        title: 'Not Archived',
      })

      await expect(
        store.restoreNode(created.id)
      ).rejects.toThrow(GraphError)
    })
  })

  describe('createEdge', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should create edge between nodes', async () => {
      const spec = await store.createNode({ type: 'spec', title: 'Spec' })
      const issue = await store.createNode({
        type: 'issue',
        title: 'Issue',
        status: 'open',
      })

      const edge = await store.createEdge({
        from_id: issue.id,
        to_id: spec.id,
        type: 'implements',
      })

      expect(edge.from_id).toBe(issue.id)
      expect(edge.to_id).toBe(spec.id)
      expect(edge.type).toBe('implements')
      expect(edge.id).toMatch(/^x-[a-z0-9]+$/)
    })

    it('should reject self-reference', async () => {
      const spec = await store.createNode({ type: 'spec', title: 'Spec' })

      await expect(
        store.createEdge({
          from_id: spec.id,
          to_id: spec.id,
          type: 'references',
        })
      ).rejects.toThrow(GraphError)
    })

    it('should detect cycles in blocks edges', async () => {
      const a = await store.createNode({ type: 'issue', title: 'A', status: 'open' })
      const b = await store.createNode({ type: 'issue', title: 'B', status: 'open' })
      const c = await store.createNode({ type: 'issue', title: 'C', status: 'open' })

      // A blocks B
      await store.createEdge({ from_id: a.id, to_id: b.id, type: 'blocks' })
      // B blocks C
      await store.createEdge({ from_id: b.id, to_id: c.id, type: 'blocks' })

      // C blocks A would create a cycle
      await expect(
        store.createEdge({ from_id: c.id, to_id: a.id, type: 'blocks' })
      ).rejects.toThrow('cycle')
    })
  })

  describe('tag operations', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should add tags', async () => {
      const node = await store.createNode({ type: 'spec', title: 'Spec' })

      await store.addTags(node.id, ['tag1', 'tag2'])

      const updated = await store.getNode(node.id)
      expect(updated?.tags).toContain('tag1')
      expect(updated?.tags).toContain('tag2')
    })

    it('should remove tags', async () => {
      const node = await store.createNode({
        type: 'spec',
        title: 'Spec',
        tags: ['keep', 'remove'],
      })

      await store.removeTags(node.id, ['remove'])

      const updated = await store.getNode(node.id)
      expect(updated?.tags).toContain('keep')
      expect(updated?.tags).not.toContain('remove')
    })

    it('should set tags (replace all)', async () => {
      const node = await store.createNode({
        type: 'spec',
        title: 'Spec',
        tags: ['old1', 'old2'],
      })

      await store.setTags(node.id, ['new1', 'new2'])

      const updated = await store.getNode(node.id)
      expect(updated?.tags).toContain('new1')
      expect(updated?.tags).toContain('new2')
      expect(updated?.tags).not.toContain('old1')
      expect(updated?.tags).not.toContain('old2')
    })
  })

  describe('query engine', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should expose query engine', () => {
      expect(store.query).toBeDefined()
      expect(typeof store.query.nodes).toBe('function')
      expect(typeof store.query.ready).toBe('function')
    })

    it('should query created nodes', async () => {
      await store.createNode({ type: 'spec', title: 'Spec 1' })
      await store.createNode({ type: 'spec', title: 'Spec 2' })

      const specs = await store.query.nodes({ type: 'spec' })
      expect(specs).toHaveLength(2)
    })
  })

  describe('transactions', () => {
    beforeEach(async () => {
      await store.initialize()
    })

    it('should execute operations in transaction', async () => {
      const result = await store.transaction(async (tx) => {
        const spec = await tx.createNode({ type: 'spec', title: 'Spec' })
        const issue = await tx.createNode({
          type: 'issue',
          title: 'Issue',
          status: 'open',
        })
        await tx.createEdge({
          from_id: issue.id,
          to_id: spec.id,
          type: 'implements',
        })
        return { spec, issue }
      })

      expect(result.spec.type).toBe('spec')
      expect(result.issue.type).toBe('issue')

      // Verify persisted
      const spec = await store.getNode(result.spec.id)
      expect(spec).not.toBeNull()
    })
  })
})
