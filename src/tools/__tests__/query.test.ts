/**
 * Tests for Query Tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { query } from '../query.js'
import type { GraphStore } from '../../graph/store.js'
import type { Node, Edge, Feedback, Issue } from '../../schema/index.js'

describe('query tool', () => {
  let mockStore: GraphStore

  // Sample data
  const sampleSpec: Node = {
    id: 's-test1',
    uuid: 'uuid-1',
    type: 'spec',
    title: 'Test Spec',
    priority: 1,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const sampleIssue: Issue = {
    id: 'i-test1',
    uuid: 'uuid-2',
    type: 'issue',
    title: 'Test Issue',
    status: 'open',
    priority: 2,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const sampleFeedback: Feedback = {
    id: 'f-test1',
    uuid: 'uuid-3',
    type: 'feedback',
    title: 'Test Feedback',
    target_id: 's-test1',
    feedback_type: 'comment',
    resolved: false,
    dismissed: false,
    content: 'This is a test feedback comment that might be quite long in practice',
    priority: 0,
    archived: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const sampleEdge: Edge = {
    id: 'x-test1',
    uuid: 'uuid-4',
    from_id: 'i-test1',
    to_id: 's-test1',
    type: 'implements',
    created_at: '2024-01-01T00:00:00Z',
  }

  beforeEach(() => {
    mockStore = {
      query: {
        nodes: vi.fn().mockResolvedValue([sampleSpec, sampleIssue]),
        edges: vi.fn().mockResolvedValue([sampleEdge]),
        ready: vi.fn().mockResolvedValue([sampleIssue]),
        blockers: vi.fn().mockResolvedValue([sampleSpec]),
        blocking: vi.fn().mockResolvedValue([sampleIssue]),
        feedback: vi.fn().mockResolvedValue([sampleFeedback]),
      },
    } as unknown as GraphStore
  })

  describe('query type validation', () => {
    it('should error when no query type specified', async () => {
      await expect(query(mockStore, {})).rejects.toThrow('No query type specified')
    })

    it('should error when multiple query types specified', async () => {
      await expect(
        query(mockStore, {
          nodes: {},
          edges: {},
        })
      ).rejects.toThrow('Multiple query types specified')
    })

    it('should accept single query type', async () => {
      const result = await query(mockStore, { nodes: {} })
      expect(result.items).toBeDefined()
    })
  })

  describe('nodes query', () => {
    it('should query nodes with filter', async () => {
      const result = await query(mockStore, {
        nodes: { type: 'spec' },
      })

      expect(mockStore.query.nodes).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'spec' })
      )
      expect(result.items).toHaveLength(2)
    })

    it('should return reduced output by default', async () => {
      const result = await query(mockStore, { nodes: {} })

      const item = result.items[0] as any
      expect(item.id).toBe('s-test1')
      expect(item.type).toBe('spec')
      expect(item.title).toBe('Test Spec')
      // Should NOT have full node properties
      expect(item.uuid).toBeUndefined()
      expect(item.created_at).toBeUndefined()
    })

    it('should return full objects when verbose=true', async () => {
      const result = await query(mockStore, { nodes: {}, verbose: true })

      const item = result.items[0] as any
      expect(item.id).toBe('s-test1')
      expect(item.uuid).toBe('uuid-1')
      expect(item.created_at).toBeDefined()
    })
  })

  describe('edges query', () => {
    it('should query edges with filter', async () => {
      const result = await query(mockStore, {
        edges: { from_id: 'i-test1' },
      })

      expect(mockStore.query.edges).toHaveBeenCalled()
      expect(result.items).toHaveLength(1)
    })

    it('should return reduced edge output by default', async () => {
      const result = await query(mockStore, { edges: {} })

      const item = result.items[0] as any
      expect(item.id).toBe('x-test1')
      expect(item.from_id).toBe('i-test1')
      expect(item.to_id).toBe('s-test1')
      expect(item.type).toBe('implements')
      // Should NOT have full edge properties
      expect(item.uuid).toBeUndefined()
      expect(item.created_at).toBeUndefined()
    })
  })

  describe('ready query', () => {
    it('should return ready issues', async () => {
      const result = await query(mockStore, { ready: {} })

      expect(mockStore.query.ready).toHaveBeenCalled()
      expect(result.items).toHaveLength(1)
    })

    it('should pass ready options', async () => {
      await query(mockStore, {
        ready: { priority: 1, assignee: 'user1' },
      })

      expect(mockStore.query.ready).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 1,
          assignee: 'user1',
        })
      )
    })
  })

  describe('blockers query', () => {
    it('should return blockers for node', async () => {
      const result = await query(mockStore, {
        blockers: { node_id: 'i-test1' },
      })

      expect(mockStore.query.blockers).toHaveBeenCalledWith('i-test1', expect.any(Object))
      expect(result.items).toHaveLength(1)
    })

    it('should pass blocker options', async () => {
      await query(mockStore, {
        blockers: { node_id: 'i-test1', transitive: true, active_only: false },
      })

      expect(mockStore.query.blockers).toHaveBeenCalledWith('i-test1', {
        transitive: true,
        activeOnly: false,
      })
    })
  })

  describe('blocking query', () => {
    it('should return nodes blocked by node', async () => {
      const result = await query(mockStore, {
        blocking: { node_id: 's-test1' },
      })

      expect(mockStore.query.blocking).toHaveBeenCalledWith('s-test1', expect.any(Object))
      expect(result.items).toHaveLength(1)
    })
  })

  describe('feedback query', () => {
    it('should return feedback for node', async () => {
      const result = await query(mockStore, {
        feedback: { node_id: 's-test1' },
      })

      expect(mockStore.query.feedback).toHaveBeenCalledWith('s-test1', expect.any(Object))
      expect(result.items).toHaveLength(1)
    })

    it('should pass feedback options', async () => {
      await query(mockStore, {
        feedback: {
          node_id: 's-test1',
          type: 'suggestion',
          resolved: true,
          include_dismissed: true,
        },
      })

      expect(mockStore.query.feedback).toHaveBeenCalledWith('s-test1', {
        type: 'suggestion',
        resolved: true,
        includeDismissed: true,
      })
    })

    it('should return reduced feedback output by default', async () => {
      const result = await query(mockStore, {
        feedback: { node_id: 's-test1' },
      })

      const item = result.items[0] as any
      expect(item.id).toBe('f-test1')
      expect(item.target_id).toBe('s-test1')
      expect(item.feedback_type).toBe('comment')
      expect(item.resolved).toBe(false)
      expect(item.dismissed).toBe(false)
      expect(item.content_preview).toBeDefined()
      // Should NOT have full feedback properties
      expect(item.uuid).toBeUndefined()
    })
  })

  describe('pagination', () => {
    beforeEach(() => {
      // Return many items for pagination tests
      const manyNodes = Array.from({ length: 100 }, (_, i) => ({
        ...sampleSpec,
        id: `s-test${i}`,
        title: `Test Spec ${i}`,
      }))
      mockStore.query.nodes = vi.fn().mockResolvedValue(manyNodes)
    })

    it('should respect limit', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      })

      expect(result.items).toHaveLength(10)
    })

    it('should respect offset', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
        offset: 5,
      })

      expect(result.items).toHaveLength(10)
      expect((result.items[0] as any).id).toBe('s-test5')
    })

    it('should calculate has_more correctly when more items exist', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      })

      expect(result.has_more).toBe(true)
    })

    it('should calculate has_more correctly when no more items', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 100,
      })

      expect(result.has_more).toBe(false)
    })

    it('should include total count', async () => {
      const result = await query(mockStore, {
        nodes: {},
        limit: 10,
      })

      expect(result.total).toBe(100)
    })

    it('should use default limit of 50', async () => {
      const result = await query(mockStore, { nodes: {} })

      expect(result.items).toHaveLength(50)
    })
  })
})
